/**
 * Stage 7 — the canonical ingredient layer.
 *
 * "2 tablespoons EVOO", "1/4 cup olive oil" and "olive oil, to taste" have to
 * become one ingredient in comparable units before anything can be summed,
 * filtered, matched against a pantry, or mapped to a shop. This is the part
 * the whole product rests on.
 *
 * Two passes, deliberately:
 *   A. every distinct item string -> a base name (736 -> ~450)
 *   B. attributes assigned ONCE per base name
 *
 * Doing it in one pass would let "olive oil" get a density of 216 g/cup in one
 * batch and 205 in another. Assigning attributes once per canonical name makes
 * that impossible.
 *
 *   node 7-normalize.mjs [--force] [--concurrency 5]
 */
import path from "node:path";
import { DATA, ensureDirs, readJson, writeJson, args, askJson, costOf, mapPool, requireSpendApproval } from "./lib/config.mjs";
import { toCanonical, normalizeUnit, unitClass } from "./lib/units.mjs";

const RECIPES = path.join(DATA, "recipes.json");
const ALIASES = path.join(DATA, "ingredient-aliases.json");
const CATALOG = path.join(DATA, "ingredients.json");

const { force, concurrency } = args();
ensureDirs();

const recipes = readJson(RECIPES, []);
if (!recipes.length) throw new Error("no recipes — run 4-extract.mjs first");

const allLines = recipes.flatMap((r) => r.components.flatMap((c) => c.ingredients));
const distinct = [...new Set(allLines.map((i) => (i.item || "").trim().toLowerCase()).filter(Boolean))].sort();

// ---------------------------------------------------------------- pass A

const ALIAS_SYSTEM = `You are collapsing the ingredient names from a household's
recipe collection onto a shared vocabulary, so the same food written different
ways can be added up into one line on a shopping list.

For each name, give the base ingredient you would actually buy.

- Drop preparation and form: "finely chopped red onion" -> "red onion",
  "cooked quinoa" -> "quinoa", "toasted pecans" -> "pecans".
- Drop brand and marketing words: "Near East pearled couscous mix" ->
  "pearled couscous".
- Collapse grades of the same product where you would buy one thing:
  "extra virgin olive oil" and "olive oil" are both "olive oil";
  "sea salt", "kosher salt" and "fine sea salt" are all "salt".
- KEEP distinctions that change what you put in the trolley: red onion vs
  yellow onion vs green onion; fresh basil vs dried basil; whole milk vs
  heavy cream; canned vs dried chickpeas are the same base "chickpeas" but
  note the form.
- A line naming two foods ("salt and pepper", "oil and vinegar") is a
  compound: set is_compound and list the base names in parts.
- Use the singular, plain supermarket name. Lower case.

Be consistent: the same food must always get the same base_name string,
character for character.`;

const ALIAS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["original", "base_name", "form", "is_compound", "parts"],
        properties: {
          original: { type: "string", description: "the input string, copied exactly" },
          base_name: { type: "string", description: "what you would buy; singular, lower case" },
          form: {
            type: ["string", "null"],
            description: "fresh / dried / canned / frozen / ground / whole — only when it changes what you buy",
          },
          is_compound: { type: "boolean" },
          parts: { type: "array", items: { type: "string" }, description: "base names, when is_compound" },
        },
      },
    },
  },
};

let aliases = force ? null : readJson(ALIASES, null);
const usages = [];

if (!aliases) {
  requireSpendApproval("7-normalize pass A"); // cached aliases cost nothing
  const BATCH = 60;
  const batches = [];
  for (let i = 0; i < distinct.length; i += BATCH) batches.push(distinct.slice(i, i + BATCH));
  console.log(`pass A: ${distinct.length} distinct names in ${batches.length} batches`);

  let n = 0;
  const settled = await mapPool(batches, concurrency, async (batch) => {
    const { data, usage } = await askJson({
      system: ALIAS_SYSTEM,
      content: [{ type: "text", text: batch.join("\n") }],
      schema: ALIAS_SCHEMA,
      effort: "medium",
    });
    usages.push(usage);
    console.log(`  [${++n}/${batches.length}] ${batch.length} names`);
    return data.items;
  });

  aliases = {};
  for (const s of settled) {
    if (!s.ok) { console.log(`  batch FAILED: ${s.error.message}`); continue; }
    for (const it of s.value) aliases[it.original.trim().toLowerCase()] = it;
  }
  const missing = distinct.filter((d) => !aliases[d]);
  for (const m of missing) aliases[m] = { original: m, base_name: m, form: null, is_compound: false, parts: [] };
  if (missing.length) console.log(`  ${missing.length} names fell back to themselves`);
  writeJson(ALIASES, aliases);
}

const baseNames = [...new Set(Object.values(aliases).flatMap((a) => (a.is_compound ? a.parts : [a.base_name])))]
  .map((s) => s.trim().toLowerCase()).filter(Boolean).sort();
console.log(`pass A: ${distinct.length} names -> ${baseNames.length} canonical ingredients`);

// ---------------------------------------------------------------- pass B

const ATTR_SYSTEM = `You are building the ingredient reference table behind a
vegetarian meal planner's shopping list. For each ingredient give the facts
needed to add quantities together and turn them into something buyable.

- density_g_per_cup: the weight of one US cup. Needed for anything ever
  measured by volume — flour ~120, granulated sugar ~200, olive oil ~216,
  water 236, rolled oats ~90, chopped onion ~160. null for things never
  measured by volume.
- grams_per_piece: the usable weight of one typical item — one garlic clove
  ~3, one medium onion ~150, one lemon ~100, one medium carrot ~60. null for
  things not counted.
- typical_pack_size / typical_pack_unit / typical_pack_grams: what one unit
  looks like in a shop — chickpeas come in a 15 oz can (~425 g), olive oil in
  a 500 ml bottle, parsley in a bunch (~60 g). This is what turns "380 g of
  chickpeas" into "1 can".
- (pantry status is computed in code, not asked of you)
- aisle: where it sits in a supermarket, so the list can be walked in order.
  Use exactly one of: produce, bakery, dairy, eggs, refrigerated, frozen,
  canned, dry goods, grains and pasta, baking, spices, condiments, oils and
  vinegars, nuts and seeds, international, beverages, other.
- is_vegan: false for anything animal-derived (dairy, eggs, honey, cheese).

Give real numbers. Approximate is fine and expected; null means genuinely not
applicable, and is better than a made-up figure.`;

const ATTR_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["ingredients"],
  properties: {
    ingredients: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "name", "category", "aisle", "is_vegan",
          "density_g_per_cup", "grams_per_piece",
          "typical_pack_size", "typical_pack_unit", "typical_pack_grams",
        ],
        properties: {
          name: { type: "string", description: "the input name, copied exactly" },
          category: {
            type: "string",
            enum: ["vegetable", "fruit", "grain", "legume", "nut_seed", "dairy", "egg", "herb",
                   "spice", "oil", "vinegar", "condiment", "sweetener", "baking", "beverage",
                   "protein_alt", "prepared", "other"],
          },
          aisle: {
            type: "string",
            enum: ["produce", "bakery", "dairy", "eggs", "refrigerated", "frozen", "canned",
                   "dry goods", "grains and pasta", "baking", "spices", "condiments",
                   "oils and vinegars", "nuts and seeds", "international", "beverages", "other"],
          },
          
          is_vegan: { type: "boolean" },
          density_g_per_cup: { type: ["number", "null"] },
          grams_per_piece: { type: ["number", "null"] },
          typical_pack_size: { type: ["number", "null"] },
          typical_pack_unit: { type: ["string", "null"] },
          typical_pack_grams: { type: ["number", "null"] },
        },
      },
    },
  },
};

let catalog = force ? null : readJson(CATALOG, null);

if (!catalog) {
  requireSpendApproval("7-normalize pass B"); // cached catalog costs nothing
  const BATCH = 45;
  const batches = [];
  for (let i = 0; i < baseNames.length; i += BATCH) batches.push(baseNames.slice(i, i + BATCH));
  console.log(`pass B: attributes for ${baseNames.length} ingredients in ${batches.length} batches`);

  let n = 0;
  const settled = await mapPool(batches, concurrency, async (batch) => {
    const { data, usage } = await askJson({
      system: ATTR_SYSTEM,
      content: [{ type: "text", text: batch.join("\n") }],
      schema: ATTR_SCHEMA,
      effort: "medium",
    });
    usages.push(usage);
    console.log(`  [${++n}/${batches.length}] ${batch.length} ingredients`);
    return data.ingredients;
  });

  catalog = {};
  for (const s of settled) {
    if (!s.ok) { console.log(`  batch FAILED: ${s.error.message}`); continue; }
    for (const ing of s.value) {
      const key = ing.name.trim().toLowerCase();
      catalog[key] = { id: key.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""), ...ing, name: key };
    }
  }
  for (const b of baseNames) {
    if (!catalog[b]) {
      catalog[b] = {
        id: b.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""), name: b,
        category: "other", aisle: "other", is_staple: false, is_vegan: true,
        density_g_per_cup: null, grams_per_piece: null,
        typical_pack_size: null, typical_pack_unit: null, typical_pack_grams: null,
      };
    }
  }
  writeJson(CATALOG, catalog);
}

// ------------------------------------------------------------- reconcile
// Two corrections that are rules, not judgements, so they live in code where
// they can be read and argued with — not in a prompt where they'd drift.

// 1. Pass A leaks singular/plural pairs ("chickpea" AND "chickpeas"). Left
//    alone these split one ingredient's quantity across two catalog entries,
//    which silently halves it on the shopping list.
const merged = [];
for (const name of Object.keys(catalog)) {
  const plural = name.endsWith("s") ? name : `${name}s`;
  const singular = name.endsWith("s") ? name.slice(0, -1) : name;
  if (plural === singular || !catalog[plural] || !catalog[singular]) continue;
  if (name === plural) continue; // handle each pair once, from the singular
  // keep the plural — it's how food is written on a list — and fill any gaps
  for (const [k, v] of Object.entries(catalog[singular])) {
    if (catalog[plural][k] == null && v != null && k !== "id" && k !== "name") catalog[plural][k] = v;
  }
  catalog[singular].merged_into = catalog[plural].id;
  merged.push(`${singular} -> ${plural}`);
}

// 2. `is_pantry` means "you already have this, don't put it on the list" —
//    salt, oil, dried oregano. It is NOT the household's staples list, which
//    is the opposite idea: recurring things to ADD every week (see
//    staples.mjs). Two different concepts; don't let them merge again.
//
//    The model called canned beans, broth and tomato paste pantry items;
//    those get used up and must be bought. Restrict to the pantry shelf, and
//    never let a perishable aisle qualify.
const PANTRY_AISLES = new Set(["spices", "oils and vinegars", "baking"]);
const PANTRY_EXTRA = new Set([
  "soy sauce", "tamari", "honey", "maple syrup", "granulated sugar", "brown sugar",
  "all-purpose flour", "whole wheat flour", "cornstarch", "vanilla extract",
  "baking powder", "baking soda", "white rice", "brown rice", "water",
]);
const NEVER_PANTRY_AISLES = new Set(["produce", "dairy", "eggs", "refrigerated", "frozen", "bakery", "canned"]);

let demoted = 0;
for (const c of Object.values(catalog)) {
  const was = c.is_pantry ?? c.is_staple;
  c.is_pantry =
    !NEVER_PANTRY_AISLES.has(c.aisle) &&
    (PANTRY_AISLES.has(c.aisle) || PANTRY_EXTRA.has(c.name));
  delete c.is_staple; // the old name meant two things; retire it
  if (was && !c.is_pantry) demoted++;
}
writeJson(CATALOG, catalog);
if (merged.length) console.log(`reconcile: merged ${merged.length} singular/plural pairs (${merged.slice(0, 4).join(", ")}${merged.length > 4 ? ", …" : ""})`);
console.log(`reconcile: ${demoted} ingredients demoted from staple (they get used up and must be bought)`);

/** Resolve a catalog entry through any merge. */
const resolve = (name) => {
  const c = catalog[String(name ?? "").trim().toLowerCase()];
  if (!c) return null;
  return c.merged_into ? Object.values(catalog).find((x) => x.id === c.merged_into) ?? c : c;
};

// ------------------------------------------------- map every line, in place

let mapped = 0, weighed = 0, unresolved = 0;
const unresolvedNames = new Map();

for (const r of recipes) {
  for (const comp of r.components) {
    for (const ing of comp.ingredients) {
      const key = (ing.item || "").trim().toLowerCase();
      const alias = aliases[key];
      if (!alias) {
        unresolved++;
        unresolvedNames.set(key, (unresolvedNames.get(key) ?? 0) + 1);
        continue;
      }
      const bases = alias.is_compound ? alias.parts : [alias.base_name];
      ing.canonical = bases.map((b) => resolve(b)?.id).filter(Boolean);
      ing.form = alias.form;
      ing.is_compound = alias.is_compound;

      const primary = resolve(alias.is_compound ? alias.parts[0] : alias.base_name);
      const qty = ing.qty_max != null && ing.qty_min != null ? (ing.qty_min + ing.qty_max) / 2 : ing.qty_min;
      const c = toCanonical({ qty, unit: ing.unit, ingredient: primary });
      ing.unit_normalized = normalizeUnit(ing.unit);
      ing.unit_class = unitClass(ing.unit);
      ing.qty_g = c.g == null ? null : Math.round(c.g * 100) / 100;
      ing.qty_ml = c.ml == null ? null : Math.round(c.ml * 100) / 100;
      ing.qty_count = c.count;
      ing.measure_basis = c.basis;
      mapped++;
      if (c.g != null) weighed++;
    }
  }
}

writeJson(RECIPES, recipes);

const pantry = Object.values(catalog).filter((c) => c.is_pantry).length;
const withDensity = Object.values(catalog).filter((c) => c.density_g_per_cup != null).length;
const withPack = Object.values(catalog).filter((c) => c.typical_pack_grams != null).length;

console.log(`\nnormalize: ${mapped} lines mapped, ${unresolved} unresolved`);
console.log(`  ${weighed} (${Math.round((weighed / mapped) * 100)}%) resolved to a weight — the rest are counts or to-taste`);
console.log(`  catalog: ${Object.keys(catalog).length} ingredients, ${pantry} pantry, ${withDensity} with density, ${withPack} with a pack size`);
console.log(`  -> ${CATALOG}`);
console.log(`  -> ${ALIASES}`);
if (unresolvedNames.size) {
  console.log(`  unresolved names: ${[...unresolvedNames.keys()].slice(0, 10).join(", ")}`);
}
console.log(`  est. cost: $${costOf(usages).toFixed(2)}`);



