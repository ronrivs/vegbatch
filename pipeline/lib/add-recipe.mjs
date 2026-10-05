/**
 * Wiring a new recipe into the dataset — shared by add-recipe.mjs (hand-made
 * JSON) and import-recipe.mjs (a URL or pasted text).
 *
 * Pure: takes the incoming recipes and the current dataset as arguments,
 * returns what would be added and why anything was refused. Nothing here
 * reads or writes a file, so the tests can run it against fixtures and the
 * two CLIs cannot drift apart in how they validate.
 *
 * Zero API calls. Validation and deterministic arithmetic only.
 */
import { toCanonical, normalizeUnit, unitClass } from "./units.mjs";

export const MEAT = new Set(["meat", "fish", "meat_broth", "gelatin"]);

export const TEMPLATE = {
  title: "",
  description: "One or two plain sentences of our own — never the source's prose.",
  source_attribution: null,
  yield_text: null, yield_qty: null, yield_unit: null,
  prep_min: null, cook_min: null, total_min: null,
  course: null, cuisine: null,
  components: [{
    name: "Main",
    ingredients: [{
      raw_text: "the line exactly as written on the page",
      item: "canonical-ish ingredient name",
      qty_min: null, qty_max: null, unit: null, prep_note: null,
      optional: false, to_taste: false,
      qty_estimated: false, estimate_basis: null, substituted_from: null,
    }],
  }],
  instructions: [{ step: 1, text: "" }],
  method_source: "transcribed",
  notes: null,
  animal_products: [],
  household_edits: [],
  confidence: "high",
  review_notes: "",
  pages: [],
};

export const CATALOG_SHAPE_HELP = `
Add each to data/ingredients.json, keyed by name, then re-run. Shape:

  "sumac": {
    "id": "sumac", "name": "sumac",
    "category": "spice", "aisle": "spices", "is_pantry": true, "is_vegan": true,
    "density_g_per_cup": 96, "grams_per_piece": null,
    "typical_pack_size": 2, "typical_pack_unit": "oz jar", "typical_pack_grams": 57
  }

Nothing is guessed for you — a wrong density silently corrupts every grocery
list that ingredient ever appears on.`;

/** The catalog keys an item name resolves to: through an alias, or itself. */
export function resolveBases(item, aliases) {
  const key = (item ?? "").trim().toLowerCase();
  const alias = aliases[key];
  if (!alias) return { key, bases: [key], alias: null };
  return { key, bases: alias.is_compound ? alias.parts : [alias.base_name], alias };
}

export const slugOf = (title) =>
  title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/**
 * Validate and attach. Returns `{ problems, unknown, added }`:
 *  - problems: structural faults, nothing is added while any exist
 *  - unknown:  Map of ingredient name -> count, for names the catalog lacks
 *  - added:    the finished recipe records, ids assigned, ready to append
 */
export function prepareRecipes({ incoming, recipes, catalog, aliases, today = new Date() }) {
  const byId = new Map(Object.values(catalog).map((c) => [c.id, c]));
  const problems = [];
  const unknown = new Map();

  for (const [n, r] of incoming.entries()) {
    const where = `recipe ${n + 1}${r.title ? ` (${r.title})` : ""}`;
    if (!r.title) problems.push(`${where}: no title`);
    if (!Array.isArray(r.components) || !r.components.length) problems.push(`${where}: no components`);
    if (!Array.isArray(r.instructions)) problems.push(`${where}: no instructions array`);
    if (r.method_source && !["transcribed", "drafted", "none"].includes(r.method_source)) {
      problems.push(`${where}: method_source must be transcribed | drafted | none`);
    }
    for (const c of r.components ?? []) {
      for (const i of c.ingredients ?? []) {
        if (!i.item) problems.push(`${where}: an ingredient has no item`);
        if (i.raw_text == null) problems.push(`${where}: "${i.item}" has no raw_text — keep the original line`);
        const { key, bases } = resolveBases(i.item, aliases);
        if (!catalog[bases[0]?.trim().toLowerCase()]) unknown.set(key, (unknown.get(key) ?? 0) + 1);
      }
    }
    if (recipes.some((x) => x.title.toLowerCase() === (r.title ?? "").toLowerCase())) {
      problems.push(`${where}: a recipe with this title already exists — rename, or edit the existing one`);
    }
  }

  if (problems.length || unknown.size) return { problems, unknown, added: [] };

  let nextId = Math.max(0, ...recipes.map((r) => Number(r.id))) + 1;
  const added = [];

  for (const r of incoming) {
    const id = String(nextId++).padStart(3, "0");
    const animal = r.animal_products ?? [];
    const blockers = animal.filter((a) => MEAT.has(a.type));

    for (const comp of r.components) {
      for (const ing of comp.ingredients) {
        const { bases, alias } = resolveBases(ing.item, aliases);
        ing.canonical = bases.map((b) => catalog[b.trim().toLowerCase()]?.id).filter(Boolean);
        ing.form = alias?.form ?? null;
        ing.is_compound = alias?.is_compound ?? false;

        const primary = byId.get(ing.canonical[0]);
        const qty = ing.qty_max != null && ing.qty_min != null ? (ing.qty_min + ing.qty_max) / 2 : ing.qty_min;
        const conv = toCanonical({ qty, unit: ing.unit, ingredient: primary });
        ing.unit_normalized = normalizeUnit(ing.unit);
        ing.unit_class = unitClass(ing.unit);
        ing.qty_g = conv.g == null ? null : Math.round(conv.g * 100) / 100;
        ing.qty_ml = conv.ml == null ? null : Math.round(conv.ml * 100) / 100;
        ing.qty_count = conv.count;
        ing.measure_basis = conv.basis;
      }
    }

    const estimated = r.components.flatMap((c) => c.ingredients).filter((i) => i.qty_estimated).length;

    added.push({
      id,
      slug: slugOf(r.title),
      ...r,
      household_edits: r.household_edits ?? [],
      animal_products: animal,
      is_vegetarian: blockers.length === 0,
      is_vegan: animal.filter((a) => a.type !== "ambiguous").length === 0,
      vegetarian_blockers: blockers,
      estimated_count: estimated,
      // a hand-added recipe always gets looked at once in the review UI
      needs_review: true,
      reviewed: false,
      added_manually: true,
      added_at: today.toISOString().slice(0, 10),
    });
  }

  return { problems, unknown, added };
}

/** The two-line summary each CLI prints per recipe. */
export function summarize(r, verb) {
  const n = r.components.reduce((s, c) => s + c.ingredients.length, 0);
  const weighed = r.components.flatMap((c) => c.ingredients).filter((i) => i.qty_g != null).length;
  const lines = [
    `${verb}  ${r.id}  ${r.title}`,
    `    ${n} ingredients (${weighed} resolved to a weight), ${r.instructions.length} steps` +
      `, ${r.is_vegan ? "vegan" : r.is_vegetarian ? "vegetarian" : "NOT VEGETARIAN"}`,
  ];
  if (r.vegetarian_blockers.length) {
    lines.push(`    ⚠ contains ${r.vegetarian_blockers.map((b) => b.ingredient).join(", ")} — run 5-substitute or fix by hand`);
  }
  return lines;
}

/** Print the refusal the same way from both CLIs. */
export function reportRefusal({ problems, unknown }) {
  if (problems.length) {
    console.log("Not added — fix these first:\n");
    for (const p of problems) console.log(`  · ${p}`);
    return;
  }
  console.log(`${unknown.size} ingredient${unknown.size > 1 ? "s" : ""} not in the catalog:\n`);
  for (const [name, count] of unknown) console.log(`  · ${name}  (${count}×)`);
  console.log(CATALOG_SHAPE_HELP);
}
