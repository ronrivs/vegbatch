/**
 * Stage 4 — extract one structured recipe per group.
 *
 * Editorial rules baked into the prompt, all deliberate:
 *
 *  - Ingredients and method steps are transcribed VERBATIM. They're functional
 *    content and copying them is fine. The blog's *prose* — headnotes, chatty
 *    asides, "I'm a warm-dessert kind of girl" — is not copied; a fresh
 *    description is written instead.
 *  - Illegible or missing quantities ARE estimated, because a grocery list
 *    needs a number. Every estimate sets qty_estimated and says what it was
 *    based on, so it can be spotted and corrected in review.
 *  - Handwritten annotations are the household's own edits and win over the
 *    printed text. What changed is recorded in household_edits.
 *  - Meat broth is swapped for vegetable broth. raw_text still holds the
 *    original line and substituted_from names what was replaced, so the swap
 *    is always visible and reversible.
 *
 *   node 4-extract.mjs [--limit 5] [--only 003] [--force] [--concurrency 5]
 */
import fs from "node:fs";
import path from "node:path";
import {
  PREPPED, WORK, DATA, ensureDirs, readJson, writeJson, args, askJson, imageBlock, costOf, mapPool, requireSpendApproval } from "./lib/config.mjs";

const OUT = path.join(DATA, "recipes.json");

const SYSTEM = `You transcribe photographs of a household's personal recipe
collection into structured data. The household is vegetarian and meal-preps
weekly; the data will drive a meal planner and an automatic grocery list, so
quantities and ingredient names matter more than anything else.

TRANSCRIPTION
- Transcribe ingredients and method steps verbatim from the page. Do not
  paraphrase, reorder, improve or modernise them.
- Keep every ingredient line's original wording in raw_text, exactly as
  written, including abbreviations ("EVOO", "tblspn", "chic peas"). Then
  interpret it into the structured fields alongside.
- Handwriting uses heavy abbreviation. Expand it in the structured fields
  (teaspn -> teaspoon, tblspn -> tablespoon, EVOO -> extra virgin olive oil)
  but never in raw_text.
- Crossed-out text is a correction: honour the correction, and mention what was
  struck out in review_notes.
- If a page is cut off, overlapped by another sheet, or otherwise incomplete,
  transcribe what is there and say what is missing in review_notes.

ESTIMATING QUANTITIES
This collection feeds an automatic grocery list, so a missing number is worse
than an approximate one. When a quantity is illegible, smudged, cut off, or
simply never written down:
- Give your best estimate in qty_min/unit anyway.
- Set qty_estimated to true and put your reasoning in estimate_basis
  (e.g. "illegible, '1/4' fits the space and the ratio to the 1/2 cup oil",
  "not written; typical for a salad serving 6").
- Base the estimate on what is visible: the other quantities, the yield, the
  ratios a dish like this normally uses, the space on the page.
- Leave raw_text exactly as written — never write your estimate into it.
- An ingredient genuinely meant to be untyped ("salt and pepper to taste") is
  not an estimate: set to_taste and leave qty_estimated false.

HANDWRITTEN ANNOTATIONS ON PRINTED PAGES
Handwriting added to a printed recipe is the household's own modification and
takes precedence over the printed text. Apply it:
- Quantities written over or beside a printed one replace it.
- An ingredient crossed out is removed; one written in the margin is added.
- A note like "double this", "we use 2", "skip", "add extra" changes the
  recipe — apply it to the ingredients and steps.
- Record each annotation in household_edits: what was written, and what you
  did with it. If an annotation is ambiguous, apply your best reading and say
  so there.
This applies to handwriting on index cards too, where a later note in
different ink is a revision to the original.

BROTH SUBSTITUTION
This is a vegetarian collection. Wherever a recipe calls for chicken, beef,
turkey or other meat broth or stock:
- Write the ingredient as vegetable broth (or vegetable stock, matching the
  original's wording) with the same quantity and unit.
- Set substituted_from to the original ingredient, e.g. "chicken broth".
- Leave raw_text as the line actually written on the page.
- **Update the instruction steps too.** A step that says "bring the chicken
  broth to a boil" must say vegetable broth. An ingredient swap that leaves the
  method still calling for chicken stock is not a swap.
- Note the swap in household_edits.
Substitute broth and stock only. Do not substitute anything else — other meat,
fish, anchovies, gelatin or Worcestershire sauce are recorded as written and
flagged for a human.

PROSE
- Do NOT copy the source's description, headnote, or commentary.
- Write your own description: one or two plain sentences saying what the dish
  is and how it eats. Warm, unfussy, no marketing language, no exclamation
  marks, no "you'll love this".
- Record the original author or site in source_attribution if it is printed on
  the page. Do not carry any other branding, URLs, or promotional text into
  any other field.

METHOD
- If the page has instructions, set method_source to "transcribed" and copy
  them.
- If the page has NO instructions (common on ingredient-only index cards),
  write a short, sensible method from the ingredients and set method_source to
  "drafted". Keep drafted methods minimal and obvious — for an assembly salad,
  that may be two steps. Do not invent techniques, temperatures, or times that
  the ingredients don't imply.

ANIMAL PRODUCTS — be strict and literal
- List every ingredient that is or contains an animal product, with its type.
- Fish sauce, anchovies, Worcestershire sauce, gelatin and lard all count.
- A meat broth you have replaced with vegetable broth is no longer an animal
  product — do not list it here. The swap is recorded in household_edits.
- A product merely *flavoured* to taste like meat (e.g. a box of
  "chicken flavored couscous") is usually vegetarian: use type "ambiguous" and
  explain in the note rather than guessing.
- Parmesan, Pecorino and Gruyère are traditionally made with animal rennet:
  type "cheese_rennet".
- Do not remove or substitute anything. Record, classify, flag.

Report only what the page supports. Use null rather than a guess.`;

const INGREDIENT = {
  type: "object",
  additionalProperties: false,
  required: [
    "raw_text", "item", "qty_min", "qty_max", "unit", "prep_note", "optional", "to_taste",
    "qty_estimated", "estimate_basis", "substituted_from",
  ],
  properties: {
    raw_text: {
      type: "string",
      description: "the line exactly as written on the page — never your estimate or substitution",
    },
    item: { type: "string", description: "the food itself, singular and unadorned: 'olive oil', 'chickpeas', 'red onion'" },
    qty_min: { type: ["number", "null"], description: "1.5 for '1 1/2'; for a range '2-3' this is 2" },
    qty_max: { type: ["number", "null"], description: "the upper bound of a range, else null" },
    unit: {
      type: ["string", "null"],
      description: "cup, tablespoon, teaspoon, ounce, pound, gram, clove, can, package, bunch, piece — singular, expanded. null if unitless or untyped",
    },
    prep_note: { type: ["string", "null"], description: "'finely chopped', 'rinsed and drained', 'toasted'" },
    optional: { type: "boolean" },
    to_taste: { type: "boolean" },
    qty_estimated: {
      type: "boolean",
      description: "true if you supplied or inferred the quantity rather than reading it",
    },
    estimate_basis: {
      type: ["string", "null"],
      description: "why this estimate, when qty_estimated is true; null otherwise",
    },
    substituted_from: {
      type: ["string", "null"],
      description: "the original ingredient this replaces, e.g. 'chicken broth'; null if unchanged",
    },
  },
};

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "title", "description", "source_attribution", "yield_text", "yield_qty", "yield_unit",
    "prep_min", "cook_min", "total_min", "components", "instructions", "method_source",
    "notes", "course", "cuisine", "animal_products", "household_edits",
    "confidence", "review_notes",
  ],
  properties: {
    title: { type: "string" },
    description: { type: "string", description: "YOUR OWN one or two sentences. Never the source's." },
    source_attribution: { type: ["string", "null"], description: "author or site printed on the page, if any" },
    yield_text: { type: ["string", "null"], description: "servings as written, e.g. '6 meal prep servings; 4-6 dinner servings'" },
    yield_qty: { type: ["number", "null"] },
    yield_unit: { type: ["string", "null"], description: "serving, cake, patty, loaf" },
    prep_min: { type: ["number", "null"] },
    cook_min: { type: ["number", "null"] },
    total_min: { type: ["number", "null"] },
    components: {
      type: "array",
      description: "ingredient groups. A recipe with no sub-sections has one component named 'Main'.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "ingredients"],
        properties: {
          name: { type: "string", description: "'Main', 'Salad', 'Dressing', 'Topping'" },
          ingredients: { type: "array", items: INGREDIENT },
        },
      },
    },
    instructions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["step", "text"],
        properties: { step: { type: "integer" }, text: { type: "string" } },
      },
    },
    method_source: { type: "string", enum: ["transcribed", "drafted", "none"] },
    notes: { type: ["string", "null"], description: "storage, make-ahead or serving notes written on the page" },
    course: { type: ["string", "null"], description: "salad, main, side, soup, dessert, breakfast, snack, sauce" },
    cuisine: { type: ["string", "null"] },
    animal_products: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["ingredient", "type", "note"],
        properties: {
          ingredient: { type: "string" },
          type: {
            type: "string",
            enum: ["dairy", "cheese_rennet", "egg", "honey", "meat", "fish", "meat_broth", "gelatin", "ambiguous", "other"],
          },
          note: { type: "string" },
        },
      },
    },
    household_edits: {
      type: "array",
      description:
        "every departure from the printed/original page: handwritten annotations applied, and broth substitutions made",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "written", "applied"],
        properties: {
          kind: {
            type: "string",
            enum: ["annotation", "broth_substitution", "correction"],
          },
          written: {
            type: "string",
            description: "what is actually on the page — the annotation text, or the original ingredient",
          },
          applied: { type: "string", description: "what you did to the recipe as a result" },
        },
      },
    },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    review_notes: {
      type: "string",
      description: "what a human should check: unreadable words, cut-off text, struck-out corrections, gaps you refused to fill",
    },
  },
};

requireSpendApproval("4-extract");
const { limit, only, force, concurrency } = args();
ensureDirs();

const groups = readJson(path.join(WORK, "groups.json"), []);
if (!groups.length) throw new Error("no groups — run 3-group.mjs first");

let selected = only ? groups.filter((g) => g.id === only) : groups;
if (limit) selected = selected.slice(0, limit);

const existing = force ? new Map() : new Map(readJson(OUT, []).map((r) => [r.id, r]));
const todo = selected.filter((g) => !existing.has(g.id));
const usages = [];
let done = 0;

console.log(`extract: ${todo.length} to do (${selected.length - todo.length} already done), concurrency ${concurrency}`);

const settled = await mapPool(todo, concurrency, async (g) => {
  const content = [
    {
      type: "text",
      text:
        g.pages.length === 1
          ? "This recipe is on a single page."
          : `This recipe runs across ${g.pages.length} photos, in order. Treat them as one recipe — a later page may be the back of a card or a continuation of the steps.`,
    },
  ];
  for (const p of g.pages) {
    content.push({ type: "text", text: `--- page ${p.page_role}: ${p.prepped} ---` });
    content.push(imageBlock(fs.readFileSync(path.join(PREPPED, p.prepped)).toString("base64")));
  }

  const { data, usage } = await askJson({ system: SYSTEM, content, schema: SCHEMA, maxTokens: 16000 });
  usages.push(usage);

  const animal = data.animal_products ?? [];
  const blocking = animal.filter((a) => ["meat", "fish", "meat_broth", "gelatin"].includes(a.type));
  const nonVegan = animal.filter((a) => a.type !== "ambiguous");
  const ingredients = data.components.flatMap((c) => c.ingredients);
  const estimated = ingredients.filter((i) => i.qty_estimated);

  done++;
  console.log(
    `  [${String(done).padStart(3)}/${todo.length}] ${g.id} ${data.title} — ` +
      `${ingredients.length} ing, ${data.confidence}` +
      (estimated.length ? `, ${estimated.length} estimated` : "") +
      (data.household_edits.length ? `, ${data.household_edits.length} edits` : ""),
  );

  return {
    id: g.id,
    slug: data.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
    ...data,
    // computed, not asked of the model — so the rule is auditable in one place
    is_vegetarian: blocking.length === 0,
    is_vegan: nonVegan.length === 0,
    vegetarian_blockers: blocking,
    estimated_count: estimated.length,
    needs_review:
      data.confidence !== "high" ||
      data.method_source === "drafted" ||
      blocking.length > 0 ||
      estimated.length > 0 ||
      data.household_edits.length > 0 ||
      animal.some((a) => a.type === "ambiguous"),
    reviewed: false,
    pages: g.pages.map((p) => p.prepped),
  };
});

const recipes = [...existing.values()];
const failures = [];
for (const [i, r] of settled.entries()) {
  if (r.ok) recipes.push(r.value);
  else failures.push({ id: todo[i].id, title: todo[i].title, error: r.error.message });
}
recipes.sort((a, b) => a.id.localeCompare(b.id));
writeJson(OUT, recipes);

const ing = recipes.reduce((s, r) => s + r.components.reduce((t, c) => t + c.ingredients.length, 0), 0);
const est = recipes.reduce((s, r) => s + (r.estimated_count ?? 0), 0);
const swaps = recipes.flatMap((r) => r.household_edits ?? []).filter((e) => e.kind === "broth_substitution");
const annotations = recipes.flatMap((r) => r.household_edits ?? []).filter((e) => e.kind === "annotation");

console.log(`\nextract: ${recipes.length} recipes, ${ing} ingredient lines -> ${OUT}`);
console.log(`  not vegetarian: ${recipes.filter((r) => !r.is_vegetarian).length}`);
console.log(`  vegan as written: ${recipes.filter((r) => r.is_vegan).length}`);
console.log(`  estimated quantities: ${est}`);
console.log(`  broth substitutions: ${swaps.length}`);
console.log(`  handwritten annotations applied: ${annotations.length}`);
console.log(`  drafted methods: ${recipes.filter((r) => r.method_source === "drafted").length}`);
console.log(`  need review: ${recipes.filter((r) => r.needs_review).length}`);
console.log(`  est. cost this run: $${costOf(usages).toFixed(2)}`);
if (failures.length) {
  console.log(`\n  ${failures.length} FAILED (re-run to retry — completed work is kept):`);
  for (const f of failures) console.log(`    ${f.id} ${f.title}: ${f.error}`);
}
