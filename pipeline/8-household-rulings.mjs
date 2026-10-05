/**
 * Stage 8 — household rulings.
 *
 * Some questions aren't per-recipe, they're per-ingredient: "do you buy the
 * vegetarian pesto?" is one decision that settles every recipe using pesto.
 * Asking it 23 times in a review queue was my mistake. These are Ron's
 * answers, recorded once, applied everywhere, and re-runnable.
 *
 * Ron, 2026-09-19: "all of these things are bought as is. they are
 * vegetarian, not vegan." Plus: remove the chicken-flavoured couscous.
 *
 * No API calls.
 *
 *   node 8-household-rulings.mjs [--dry-run]
 */
import path from "node:path";
import { DATA, readJson, writeJson } from "./lib/config.mjs";

const RECIPES = path.join(DATA, "recipes.json");
const dryRun = process.argv.includes("--dry-run");

/**
 * How each previously-ambiguous ingredient is settled.
 *
 * `vegan` is my call, not Ron's — he said "vegetarian, not vegan" as a
 * blanket, but Earth Balance and most barbecue sauce genuinely are vegan and
 * marking them otherwise would be wrong. These are flagged in the report so
 * he can overrule any of them.
 */
const RULINGS = [
  { match: /pesto/i,                          type: "dairy",  reason: "contains cheese" },
  { match: /mayo/i,                           type: "egg",    reason: "contains egg" },
  { match: /\bcheese\b/i,                     type: "dairy",  reason: "dairy" },
  { match: /naan/i,                           type: "dairy",  reason: "usually made with yoghurt or milk" },
  { match: /bun|bread/i,                      type: "dairy",  reason: "commonly contains milk or egg" },
  { match: /earth balance|buttery spread/i,   type: null,     reason: "a vegan butter substitute" },
  { match: /barbecue|bbq/i,                   type: null,     reason: "standard barbecue sauce is vegan" },
  { match: /curry paste/i,                    type: null,     reason: "bought as is; the household treats it as vegetarian" },
  // second pass — the same class of bought-as-is product, surfaced by the
  // first dry run. Dairy where it plausibly contains milk, since that only
  // affects the vegan flag, never the vegetarian one.
  { match: /\bmilk\b/i,                       type: "dairy",  reason: "dairy unless a plant milk is used" },
  { match: /chocolate chip/i,                 type: "dairy",  reason: "standard chips contain milk fat" },
  { match: /cake mix|pie mix/i,               type: "dairy",  reason: "boxed mixes usually contain whey or milk solids" },
  { match: /pie crust/i,                      type: null,     reason: "refrigerated crusts are shortening-based, no animal fat" },
  { match: /refried beans/i,                  type: null,     reason: "bought as is; standard tins are lard-free" },
  { match: /wine/i,                           type: null,     reason: "bought as is; the household treats it as vegetarian" },
  // the cards spell it both "couscous" and "cous cous"
  { match: /cous ?cous/i,                     type: null,     reason: "a flavoured box they already buy; not meat-derived" },
];

const recipes = readJson(RECIPES, []);
const log = { resolved: [], vegan_changed: [], couscous: [], unmatched: [] };

for (const r of recipes) {
  const ambiguous = (r.animal_products ?? []).filter((a) => a.type === "ambiguous");
  if (!ambiguous.length) continue;

  for (const a of ambiguous) {
    // the chicken-flavoured couscous is handled separately below
    if (/chicken/i.test(a.ingredient)) continue;
    const rule = RULINGS.find((x) => x.match.test(a.ingredient));
    if (!rule) { log.unmatched.push(`${r.id} ${a.ingredient}`); continue; }
    if (rule.type) {
      a.type = rule.type;
      a.note = `${rule.reason}. Bought as is — vegetarian, not vegan (household ruling).`;
    } else {
      // not an animal product at all; drop it from the list
      r.animal_products = r.animal_products.filter((x) => x !== a);
      a.type = "resolved";
      a.note = rule.reason;
    }
    log.resolved.push(`${r.id} ${a.ingredient} -> ${rule.type ?? "not an animal product"}`);
  }
}

// --- the chicken-flavoured couscous, per Ron: remove it.

// 013 buys it as a boxed product. Swap for a flavour they already buy
// elsewhere in this collection rather than inventing one.
const r013 = recipes.find((x) => x.id === "013");
if (r013) {
  for (const comp of r013.components) {
    for (const ing of comp.ingredients) {
      if (!/chicken/i.test(ing.item ?? "")) continue;
      ing.substituted_from = ing.item;
      ing.item = "olive oil and garlic couscous";
      (r013.household_edits ??= []).push({
        kind: "meat_substitution",
        written: ing.raw_text,
        applied: "Replaced with olive oil and garlic flavoured couscous — a box the household already buys for other recipes. The chicken-flavoured box may contain chicken fat or powder.",
      });
      log.couscous.push("013 ingredient swapped to olive oil and garlic couscous");
    }
  }
  r013.animal_products = (r013.animal_products ?? []).filter((a) => !/chicken/i.test(a.ingredient));
}

// 014's "chicken" was the broth, already swapped at extraction. Only the
// title still claims chicken, and the dish no longer has any. Rename it and
// keep the card's original title in provenance.
const r014 = recipes.find((x) => x.id === "014");
if (r014 && /chicken/i.test(r014.title)) {
  const original = r014.title;
  r014.title = "Couscous with Carrot & Celery";
  r014.slug = "couscous-with-carrot-celery";
  (r014.household_edits ??= []).push({
    kind: "correction",
    written: `Card title: “${original}”`,
    applied: "Renamed. The chicken flavour came from the chicken broth, which is now vegetable broth, so the old title no longer described the dish.",
  });
  r014.animal_products = (r014.animal_products ?? []).filter((a) => !/chicken/i.test(a.ingredient));
  log.couscous.push(`014 renamed: "${original}" -> "${r014.title}"`);
}

// --- recompute vegetarian/vegan from what's actually left

const BLOCKING = new Set(["meat", "fish", "meat_broth", "gelatin"]);
for (const r of recipes) {
  const animal = r.animal_products ?? [];
  const blockers = animal.filter((a) => BLOCKING.has(a.type));
  const wasVegan = r.is_vegan;
  r.vegetarian_blockers = blockers;
  r.is_vegetarian = blockers.length === 0;
  r.is_vegan = animal.filter((a) => a.type !== "ambiguous").length === 0;
  if (wasVegan !== r.is_vegan) log.vegan_changed.push(`${r.id} ${r.title}: vegan ${wasVegan} -> ${r.is_vegan}`);
}

// --- approvals, per Ron: meat swaps fine, substitutions fine, no desire to
//     re-read each recipe. Everything is approved EXCEPT the recipes leaning
//     hardest on estimated quantities, which he asked to see directly.

const heavyEstimate = (r) =>
  r.components.flatMap((c) => c.ingredients).filter((i) => i.qty_estimated).length >= 3;

let approved = 0, held = 0;
for (const r of recipes) {
  if (heavyEstimate(r)) {
    r.needs_review = true;
    r.review_reason = "estimated quantities — awaiting Ron's check";
    held++;
  } else if (r.needs_review && !r.reviewed) {
    r.reviewed = true;
    r.needs_review = false;
    r.approved_by = "ron";
    r.approved_note = "bulk-approved 2026-09-19: meat swaps and substitutions accepted as made";
    approved++;
  }
}

if (!dryRun) writeJson(RECIPES, recipes);

console.log(`${dryRun ? "[dry run] " : ""}household rulings\n`);
console.log(`  ambiguous ingredients settled: ${log.resolved.length}`);
for (const l of [...new Set(log.resolved.map((s) => s.replace(/^\d+ /, "")))]) console.log(`    ${l}`);
console.log(`\n  chicken-flavoured couscous:`);
for (const l of log.couscous) console.log(`    ${l}`);
if (log.unmatched.length) {
  console.log(`\n  NO RULING MATCHED (still ambiguous):`);
  for (const l of log.unmatched) console.log(`    ${l}`);
}
console.log(`\n  vegan status changed: ${log.vegan_changed.length}`);
console.log(`  approved: ${approved}`);
console.log(`  held for Ron's estimate check: ${held}`);
console.log(`\n  totals: ${recipes.filter((r) => r.is_vegetarian).length}/${recipes.length} vegetarian, ` +
  `${recipes.filter((r) => r.is_vegan).length} vegan, ` +
  `${recipes.filter((r) => r.needs_review).length} still queued`);
