/**
 * Stage 6 — consistency sweep.
 *
 * Catches the failure mode where an ingredient was substituted but the method
 * still calls for the original: the ingredient list says vegetable broth and
 * step 2 says "bring the chicken broth to a boil". Stage 4 now updates steps
 * itself, but a swap is applied in two places and they can always drift, so
 * this checks rather than assumes.
 *
 * Purely a verifier plus a narrow fix — it only rewrites instruction steps
 * that mention a term the recipe has already replaced, and never touches
 * ingredients, raw_text, or any other step.
 *
 *   node 6-sweep.mjs [--fix]        (without --fix it only reports)
 */
import path from "node:path";
import { DATA, readJson, writeJson, args, askJson, costOf, mapPool, requireSpendApproval } from "./lib/config.mjs";

const RECIPES = path.join(DATA, "recipes.json");

const SYSTEM = `A recipe had an ingredient substituted, but its method may still
name the original. Rewrite only the steps that do.

Change the ingredient name and nothing else — keep the wording, voice,
quantities, times and ordering of the step exactly as they are. If a step
needs no change, do not return it. Do not improve or tidy anything.

A mention that is not an instruction to use the ingredient — a comparison
("mash until flaked, almost like tuna salad"), or a name — is not a change.
Leave those alone and return no rewrite for that step.`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["rewrites"],
  properties: {
    rewrites: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["step", "new_text", "reason"],
        properties: {
          step: { type: "integer" },
          new_text: { type: "string" },
          reason: { type: "string" },
        },
      },
    },
  },
};

const { fix, concurrency } = { ...args(), fix: process.argv.includes("--fix") };
if (fix) requireSpendApproval("6-sweep --fix"); // the report itself is free
const recipes = readJson(RECIPES, []);
if (!recipes.length) throw new Error("no recipes — run 4-extract.mjs first");

/** Terms this recipe has replaced, and what they became. */
function swaps(r) {
  const out = [];
  for (const c of r.components) {
    for (const i of c.ingredients) {
      if (i.substituted_from) out.push({ from: i.substituted_from, to: i.item });
    }
  }
  for (const e of r.household_edits ?? []) {
    if (e.kind === "broth_substitution" || e.kind === "meat_substitution") {
      const m = /^(.*?)(?:,|\.|\s*\()/.exec(e.written.replace(/^[\d/.\s-]+(cups?|cans?|tablespoons?|teaspoons?|pounds?|ounces?|lb|oz)?\s*/i, ""));
      if (m?.[1]) out.push({ from: m[1].trim(), to: null });
    }
  }
  return out;
}

const suspect = recipes
  .map((r) => {
    const terms = swaps(r).map((s) => s.from).filter(Boolean);
    if (!terms.length) return null;
    const re = new RegExp(terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "i");
    const steps = r.instructions.filter((s) => re.test(s.text));
    return steps.length ? { r, steps, swaps: swaps(r) } : null;
  })
  .filter(Boolean);

console.log(`sweep: ${suspect.length} recipes whose method still names a replaced ingredient`);
for (const s of suspect) {
  console.log(`  ${s.r.id} ${s.r.title} — step${s.steps.length > 1 ? "s" : ""} ${s.steps.map((x) => x.step).join(", ")}`);
}

if (!suspect.length) process.exit(0);
if (!fix) {
  console.log("\n(report only — re-run with --fix to rewrite these steps)");
  process.exit(0);
}

const usages = [];
const settled = await mapPool(suspect, concurrency, async ({ r, steps, swaps: sw }) => {
  const { data, usage } = await askJson({
    system: SYSTEM,
    content: [{
      type: "text",
      text: JSON.stringify({
        title: r.title,
        substitutions_already_made: sw,
        current_ingredients: r.components.flatMap((c) => c.ingredients.map((i) => i.item)),
        steps_to_check: steps,
      }, null, 2),
    }],
    schema: SCHEMA,
    effort: "medium",
  });
  usages.push(usage);
  return { id: r.id, rewrites: data.rewrites };
});

let changed = 0;
for (const [i, res] of settled.entries()) {
  if (!res.ok) {
    console.log(`  FAILED ${suspect[i].r.id}: ${res.error.message}`);
    continue;
  }
  const r = recipes.find((x) => x.id === res.value.id);
  for (const rw of res.value.rewrites) {
    const step = r.instructions.find((s) => s.step === rw.step);
    if (!step || step.text === rw.new_text) continue;
    console.log(`  ${r.id} step ${rw.step}: ${rw.reason}`);
    step.text = rw.new_text;
    changed++;
    r.needs_review = true;
    r.reviewed = false;
  }
}

writeJson(RECIPES, recipes);
console.log(`\nsweep: ${changed} steps rewritten. est. cost: $${costOf(usages).toFixed(2)}`);
