/**
 * Stage 9 — Ron's review of the 120 estimated quantities, 2026-09-19.
 *
 * Verdict: quantities all fine. Two changes to the substitutions I'd made:
 *   084 Quiche      — remove the smoked tofu and the tempeh bacon outright
 *   090 Split Pea   — remove the liquid smoke
 * Everything else accepted as written.
 *
 * Both are removals rather than swaps, which means the *method* has to change
 * too: those steps were rewritten around the substitutes and would read as
 * nonsense with the ingredient gone. Same class of drift `6-sweep.mjs` exists
 * to catch — handled here at the source instead.
 *
 * No API calls. Idempotent.
 *
 *   node 9-review-feedback.mjs [--dry-run]
 */
import path from "node:path";
import { DATA, readJson, writeJson } from "./lib/config.mjs";

const RECIPES = path.join(DATA, "recipes.json");
const dryRun = process.argv.includes("--dry-run");
const recipes = readJson(RECIPES, []);
const log = [];

// ---------------------------------------------------------------- 084

const quiche = recipes.find((r) => r.id === "084");
if (quiche) {
  for (const comp of quiche.components) {
    const before = comp.ingredients.length;
    comp.ingredients = comp.ingredients.filter(
      (i) => !/smoked tofu|tempeh bacon/i.test(i.item ?? ""),
    );
    if (comp.ingredients.length !== before) log.push(`084 removed from "${comp.name}"`);
  }

  // the component names still advertised the meat that is now gone
  const rename = {
    "Filling option 1 — Ham and vegetable": "Filling option 1 — Vegetable",
    "Filling option 2 — Spinach and bacon": "Filling option 2 — Spinach",
  };
  for (const comp of quiche.components) {
    if (rename[comp.name]) {
      log.push(`084 renamed component: "${comp.name}" -> "${rename[comp.name]}"`);
      comp.name = rename[comp.name];
    }
  }

  // back to something close to the card's own wording, minus the meat
  const steps = {
    1: "Layer sauteed veg, or spinach, into pie shell (saute the veg first) (thaw frozen spinach and squeeze very dry)",
    2: "Whisk together eggs & milk, pour over the veg or spinach - top w/ cheese",
  };
  for (const s of quiche.instructions) {
    if (steps[s.step] && s.text !== steps[s.step]) {
      s.text = steps[s.step];
      log.push(`084 rewrote step ${s.step}`);
    }
  }

  quiche.household_edits = (quiche.household_edits ?? []).filter((e) => e.kind !== "meat_substitution");
  quiche.household_edits.push({
    kind: "meat_substitution",
    written: "-HAM  /  - BACON",
    applied: "Removed, not substituted. Ron's call on review — the vegetable and spinach fillings stand on their own, so the quiche is made without them rather than with a stand-in.",
  });
  quiche.notes = "Place the quiche on a baking sheet while it bakes — it makes a mess.";
  log.push("084 notes and edit record rewritten");
}

// ---------------------------------------------------------------- 090

const splitPea = recipes.find((r) => r.id === "090");
if (splitPea) {
  for (const comp of splitPea.components) {
    for (const ing of comp.ingredients) {
      if (!/liquid smoke/i.test(ing.item ?? "")) continue;
      ing.item = ing.item.replace(/\s*\+\s*liquid smoke/i, "");
      ing.canonical = (ing.canonical ?? []).filter((c) => c !== "liquid-smoke");
      log.push(`090 ingredient -> "${ing.item}"`);
    }
  }
  for (const s of splitPea.instructions) {
    if (!/liquid smoke/i.test(s.text)) continue;
    s.text = s.text.replace(/,?\s*liquid smoke/i, "");
    log.push(`090 rewrote step ${s.step}`);
  }
  if (/liquid smoke/i.test(splitPea.notes ?? "")) {
    splitPea.notes = splitPea.notes.replace(/,?\s*liquid smoke/i, "");
    log.push("090 notes updated");
  }
  for (const e of splitPea.household_edits ?? []) {
    e.applied = e.applied.replace(/,?\s*liquid smoke/gi, "");
  }
}

// ---------------------------------------- everything else: accepted as is

let approved = 0;
for (const r of recipes) {
  if (!r.needs_review || r.reviewed) continue;
  r.reviewed = true;
  r.needs_review = false;
  r.approved_by = "ron";
  r.approved_note = "estimates reviewed 2026-09-19; quantities accepted as estimated";
  delete r.review_reason;
  approved++;
}

if (!dryRun) writeJson(RECIPES, recipes);

console.log(`${dryRun ? "[dry run] " : ""}review feedback applied\n`);
for (const l of log) console.log(`  ${l}`);
console.log(`\n  approved: ${approved}`);
console.log(`  queue remaining: ${recipes.filter((r) => r.needs_review).length}`);

// A removal must not leave the method naming what was removed — checked
// per recipe against what each actually lost. 090 keeps its smoked tofu, and
// its notes may still mention the ham as provenance; only liquid smoke went.
const REMOVED = { "084": ["smoked tofu", "tempeh", "bacon", "ham"], "090": ["liquid smoke"] };
const residue = [];
for (const r of [quiche, splitPea].filter(Boolean)) {
  const text = r.instructions.map((s) => s.text).join(" ") + " " + (r.notes ?? "");
  for (const term of REMOVED[r.id] ?? []) {
    if (new RegExp(`\\b${term}\\b`, "i").test(text)) residue.push(`${r.id}: method still mentions "${term}"`);
  }
}
console.log(residue.length ? `\n  ⚠ ${residue.join("; ")}` : "\n  method text clean — nothing removed is still referenced");
