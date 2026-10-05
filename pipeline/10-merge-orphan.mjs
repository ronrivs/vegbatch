/**
 * Stage 10 — reunite an orphaned continuation page.
 *
 * Photo 208 was the back half of a printed recipe: steps 5-7, notes and
 * nutrition, no title and no ingredients. Its first page is photo 163, forty-
 * five frames earlier, so stage 3 had nothing adjacent to attach it to and
 * made it a recipe of its own — 207 recipes, one of which had no ingredients
 * at all and three steps that start mid-sentence.
 *
 * This is the silent grouping failure flagged in SCOPE.md. It survived
 * because every flag in stage 3 looks for a recipe missing its *end*; nothing
 * looked for a fragment missing its *beginning*. A zero-ingredient guard is
 * added to the build so it can't happen quietly again.
 *
 * The join is clean — 117 ends "The thinner the", 158 begins "patty, the
 * firmer it will be." — so no text is invented here.
 *
 * No API calls.
 *
 *   node 10-merge-orphan.mjs [--dry-run]
 */
import path from "node:path";
import { DATA, readJson, writeJson } from "./lib/config.mjs";

const RECIPES = path.join(DATA, "recipes.json");
const dryRun = process.argv.includes("--dry-run");
const recipes = readJson(RECIPES, []);

const parent = recipes.find((r) => r.id === "117");
const orphan = recipes.find((r) => r.id === "158");

if (!parent || !orphan) {
  console.log("nothing to merge — already done");
  process.exit(0);
}

// sanity: only proceed if this still looks like the case we diagnosed
const tail = parent.instructions.at(-1);
if (!/thinner the$/.test(tail.text.trim()) || orphan.components.flatMap((c) => c.ingredients).length) {
  console.log("data no longer matches the diagnosis — stopping rather than guessing");
  process.exit(1);
}

// step 5 was split across the page break; join the two halves
const head = tail.text.trim();
const tailFragment = orphan.instructions
  .find((s) => s.step === 5).text
  .replace(/^\[text cut off\]\s*\.{0,3}\s*/i, "");
tail.text = `${head} ${tailFragment}`;

// steps 6 and 7 carry over as they are
for (const s of orphan.instructions.filter((s) => s.step > 5)) {
  parent.instructions.push({ step: s.step, text: s.text });
}
parent.instructions.sort((a, b) => a.step - b.step);

parent.notes = [parent.notes, orphan.notes].filter(Boolean).join("\n\n");
parent.pages = [...(parent.pages ?? []), ...(orphan.pages ?? [])];
parent.source_attribution = parent.source_attribution ?? orphan.source_attribution;
(parent.household_edits ??= []).push({
  kind: "correction",
  written: "Second page photographed out of sequence (frame 208, forty-five after the first page)",
  applied: "Reunited with this recipe. It had been read as a separate recipe with no ingredients; steps 5-7, the notes and the nutrition line all belong here.",
});
parent.needs_review = true;
parent.reviewed = false;
parent.review_reason = "pages rejoined — worth one look";

const out = recipes.filter((r) => r.id !== "158");
if (!dryRun) writeJson(RECIPES, out);

console.log(`${dryRun ? "[dry run] " : ""}merged 158 into 117\n`);
console.log(`  ${parent.title}`);
console.log(`  ${parent.components.flatMap((c) => c.ingredients).length} ingredients, ${parent.instructions.length} steps, ${parent.pages.length} pages`);
console.log(`  joined step 5: "…${head.slice(-30)} ${tailFragment.slice(0, 34)}…"`);
console.log(`\n  recipes: ${recipes.length} -> ${out.length}`);
const empty = out.filter((r) => r.components.flatMap((c) => c.ingredients).length === 0);
console.log(`  zero-ingredient recipes remaining: ${empty.length}`);
