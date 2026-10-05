/**
 * Stage 5 — make the meat recipes vegetarian.
 *
 * Runs only on recipes that stage 4 flagged as containing meat, fish, gelatin
 * or (if any slipped through) meat broth. For each one it proposes a real
 * substitution — something that does the same job in the dish and that you can
 * actually buy — rewrites only the instruction steps that mention the meat,
 * and leaves everything else exactly as transcribed.
 *
 * Where there is no honest equivalent the recipe is marked `excluded` with a
 * reason rather than deleted. The photos and data stay; it just drops out of
 * the planner. Nothing here is destructive and the whole stage is re-runnable.
 *
 *   node 5-substitute.mjs [--only 083] [--force] [--concurrency 4]
 */
import path from "node:path";
import { DATA, ensureDirs, readJson, writeJson, args, askJson, costOf, mapPool, requireSpendApproval } from "./lib/config.mjs";

const RECIPES = path.join(DATA, "recipes.json");
const BLOCKING = new Set(["meat", "fish", "meat_broth", "gelatin"]);

const SYSTEM = `You are making a vegetarian household's recipe collection
actually vegetarian. Each recipe below was transcribed from their own recipe
card or printout and contains meat, fish, or another blocking animal product.

Your job is to replace it with something that does the same work in the dish.

WHAT A GOOD SUBSTITUTION LOOKS LIKE
- Match what the meat was doing: fat, chew and bulk (ground beef), smoke and
  salt (bacon, ham bone), fennel-and-chilli sausage character, shreddable
  texture (chicken), or savoury depth (anchovy, fish sauce).
- Use things a normal grocery store sells. Plant-based grounds and sausages,
  lentils, mushrooms, walnuts, tempeh, smoked tofu, jackfruit, chickpeas,
  white beans, smoked paprika, liquid smoke, miso, soy sauce and seaweed are
  all fair game. Do not invent products.
- Give a real quantity in the same units as the original wherever that makes
  sense. A pound of ground beef is not a pound of lentils — scale it to what
  the dish needs and say so.
- Where the substitute needs different handling, rewrite ONLY the instruction
  steps that mention the meat. Plant-based grounds don't need draining;
  lentils need liquid and time; tempeh bacon crisps faster than pork. Keep
  every other step exactly as it is.
- If the meat is already marked optional, the right answer is usually to drop
  the line entirely rather than substitute it.

WHEN TO EXCLUDE INSTEAD
Only when there is no honest vegetarian version of the dish — where the meat
is the entire point and substituting it would produce something misleading or
bad. This should be rare. Prefer a genuine substitution. "It would be a bit
different" is not a reason to exclude; "this is fundamentally a meat dish and
the result would not be the same recipe" is.

Be straight about what you are doing. The substitution note is shown to the
cook, so say what changed and anything they should expect to be different.`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "substitutions", "step_rewrites", "exclusion_reason", "cook_note"],
  properties: {
    verdict: {
      type: "string",
      enum: ["substituted", "excluded"],
      description: "'excluded' only when no honest vegetarian version of the dish exists",
    },
    substitutions: {
      type: "array",
      description: "one entry per blocking ingredient. Empty only when verdict is 'excluded'.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["original_raw_text", "action", "item", "qty_min", "qty_max", "unit", "prep_note", "rationale"],
        properties: {
          original_raw_text: {
            type: "string",
            description: "the raw_text of the ingredient being replaced, copied exactly so it can be matched",
          },
          action: {
            type: "string",
            enum: ["replace", "drop"],
            description: "'drop' when the ingredient was optional or adds nothing without meat",
          },
          item: { type: ["string", "null"], description: "the replacement ingredient; null when dropping" },
          qty_min: { type: ["number", "null"] },
          qty_max: { type: ["number", "null"] },
          unit: { type: ["string", "null"] },
          prep_note: { type: ["string", "null"] },
          rationale: {
            type: "string",
            description: "what this replaces and why it works — shown to the cook",
          },
        },
      },
    },
    step_rewrites: {
      type: "array",
      description: "ONLY the steps that mention the meat or need different handling. Leave every other step alone.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["step", "new_text"],
        properties: {
          step: { type: "integer", description: "the step number as given" },
          new_text: { type: "string" },
        },
      },
    },
    exclusion_reason: { type: ["string", "null"] },
    cook_note: {
      type: ["string", "null"],
      description: "one sentence for the cook about how the vegetarian version differs, or null",
    },
  },
};

requireSpendApproval("5-substitute");
const { only, force, concurrency } = args();
ensureDirs();

const recipes = readJson(RECIPES, []);
if (!recipes.length) throw new Error("no recipes — run 4-extract.mjs first");

const needs = recipes.filter((r) => {
  if (only && r.id !== only) return false;
  if (r.meat_handled && !force) return false;
  return (r.vegetarian_blockers ?? []).length > 0;
});

console.log(`substitute: ${needs.length} recipes with meat/fish, concurrency ${concurrency}`);
if (!needs.length) process.exit(0);

const usages = [];
let done = 0;

const settled = await mapPool(needs, concurrency, async (r) => {
  const payload = {
    title: r.title,
    yield_text: r.yield_text,
    blocking_ingredients: r.vegetarian_blockers,
    components: r.components.map((c) => ({
      name: c.name,
      ingredients: c.ingredients.map((i) => ({
        raw_text: i.raw_text, item: i.item, qty_min: i.qty_min, qty_max: i.qty_max,
        unit: i.unit, prep_note: i.prep_note, optional: i.optional,
      })),
    })),
    instructions: r.instructions,
  };

  const { data, usage } = await askJson({
    system: SYSTEM,
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    schema: SCHEMA,
  });
  usages.push(usage);
  console.log(`  [${String(++done).padStart(2)}/${needs.length}] ${r.id} ${r.title} — ${data.verdict}` +
    (data.verdict === "substituted" ? `: ${data.substitutions.map((s) => s.action === "drop" ? `drop ${s.original_raw_text.slice(0, 28)}` : s.item).join(", ")}` : ` (${data.exclusion_reason})`));
  return { id: r.id, data };
});

const failures = [];
const applied = [];
const excluded = [];

for (const [i, res] of settled.entries()) {
  if (!res.ok) {
    failures.push({ id: needs[i].id, title: needs[i].title, error: res.error.message });
    continue;
  }
  const { id, data } = res.value;
  const r = recipes.find((x) => x.id === id);

  r.meat_handled = true;
  r.household_edits ??= [];

  if (data.verdict === "excluded") {
    r.excluded = true;
    r.exclusion_reason = data.exclusion_reason;
    r.needs_review = true;
    excluded.push(r);
    continue;
  }

  for (const sub of data.substitutions) {
    for (const comp of r.components) {
      const idx = comp.ingredients.findIndex((ing) => ing.raw_text === sub.original_raw_text);
      if (idx === -1) continue;
      const ing = comp.ingredients[idx];

      if (sub.action === "drop") {
        comp.ingredients.splice(idx, 1);
        r.household_edits.push({
          kind: "meat_substitution",
          written: ing.raw_text,
          applied: `Removed. ${sub.rationale}`,
        });
      } else {
        // raw_text is never touched — it stays the line on the card
        Object.assign(ing, {
          item: sub.item,
          qty_min: sub.qty_min,
          qty_max: sub.qty_max,
          unit: sub.unit,
          prep_note: sub.prep_note,
          substituted_from: ing.item,
        });
        r.household_edits.push({
          kind: "meat_substitution",
          written: ing.raw_text,
          applied: `Replaced with ${sub.item}. ${sub.rationale}`,
        });
      }
    }
  }

  for (const rw of data.step_rewrites) {
    const step = r.instructions.find((s) => s.step === rw.step);
    if (step) step.text = rw.new_text;
  }

  if (data.cook_note) r.notes = r.notes ? `${r.notes}\n\n${data.cook_note}` : data.cook_note;

  // recompute from what's actually left
  r.animal_products = (r.animal_products ?? []).filter((a) => !BLOCKING.has(a.type));
  r.vegetarian_blockers = [];
  r.is_vegetarian = true;
  r.is_vegan = r.animal_products.filter((a) => a.type !== "ambiguous").length === 0;
  r.needs_review = true; // a substitution always wants a human eye
  r.reviewed = false;
  applied.push(r);
}

writeJson(RECIPES, recipes);

console.log(`\nsubstitute: ${applied.length} made vegetarian, ${excluded.length} excluded`);
for (const r of excluded) console.log(`  EXCLUDED ${r.id} ${r.title} — ${r.exclusion_reason}`);
console.log(`  est. cost: $${costOf(usages).toFixed(2)}`);
if (failures.length) {
  console.log(`\n  ${failures.length} FAILED (re-run to retry):`);
  for (const f of failures) console.log(`    ${f.id} ${f.title}: ${f.error}`);
}
