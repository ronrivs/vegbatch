/**
 * Tests for the conversion layer.
 *
 * Every grocery quantity in the product is derived from this arithmetic, and a
 * wrong constant here is invisible — the list still looks plausible, it's just
 * wrong. So the numbers get pinned.
 *
 *   node test-units.mjs
 */
import { toCanonical, normalizeUnit, unitClass, humanWeight, humanVolume, humanCount } from "./lib/units.mjs";
import { purchase } from "./lib/grocery.mjs";
import { fmtQty } from "./lib/recipe-html.mjs";
import { BASE_SERVINGS, SCALES, yieldLabel } from "./lib/servings.mjs";

let pass = 0, fail = 0;
const near = (a, b, tol = 0.5) => a != null && Math.abs(a - b) <= tol;

function t(name, actual, expected) {
  const ok = typeof expected === "number" ? near(actual, expected) : actual === expected;
  if (ok) pass++;
  else { fail++; console.log(`  FAIL ${name}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`); }
}

// --- unit parsing
t("plural cups", normalizeUnit("cups"), "cup");
t("abbreviation", normalizeUnit("Tbsp"), "tbsp");
t("trailing dot", normalizeUnit("oz."), "oz");
t("food-as-unit", normalizeUnit("lemons"), "piece");
t("empty", normalizeUnit(""), null);
t("class volume", unitClass("tablespoon"), "volume");
t("class weight", unitClass("pound"), "weight");
t("class count", unitClass("cloves"), "count");
t("class unitless", unitClass(null), "unitless");

// --- weight is exact
t("1 lb -> g", toCanonical({ qty: 1, unit: "pound" }).g, 453.59);
t("16 oz -> g", toCanonical({ qty: 16, unit: "ounces" }).g, 453.59);
t("500 g -> g", toCanonical({ qty: 500, unit: "g" }).g, 500);

// --- volume, with and without a density bridge
const oil = { density_g_per_cup: 216 };
t("1 cup -> ml", toCanonical({ qty: 1, unit: "cup" }).ml, 236.59);
t("1 cup oil -> g", toCanonical({ qty: 1, unit: "cup", ingredient: oil }).g, 216);
t("2 tbsp oil -> g", toCanonical({ qty: 2, unit: "tablespoon", ingredient: oil }).g, 27);
t("3 tsp = 1 tbsp", toCanonical({ qty: 3, unit: "tsp" }).ml, toCanonical({ qty: 1, unit: "tbsp" }).ml);
t("no density -> no grams", toCanonical({ qty: 1, unit: "cup" }).g, null);
t("volume basis", toCanonical({ qty: 1, unit: "cup", ingredient: oil }).basis, "density");

// --- counts bridge to weight only when the ingredient says how
const garlic = { grams_per_piece: 3 };
const beans = { typical_pack_grams: 425 };
t("4 cloves -> g", toCanonical({ qty: 4, unit: "clove", ingredient: garlic }).g, 12);
t("4 cloves keeps count", toCanonical({ qty: 4, unit: "clove", ingredient: garlic }).count, 4);
t("2 cans -> g", toCanonical({ qty: 2, unit: "cans", ingredient: beans }).g, 850);
t("can uses pack not piece", toCanonical({ qty: 1, unit: "can", ingredient: { grams_per_piece: 5, typical_pack_grams: 425 } }).g, 425);
t("bare count, no bridge", toCanonical({ qty: 3, unit: null }).count, 3);
t("bare count, no grams", toCanonical({ qty: 3, unit: null }).g, null);
t("count basis", toCanonical({ qty: 3, unit: null }).basis, "count");

// --- nothing usable
t("null qty", toCanonical({ qty: null, unit: "cup" }).basis, null);
t("unknown unit", toCanonical({ qty: 1, unit: "smidgen" }).basis, null);

// --- the bug this layer exists to prevent: mixed units must add up
const carrot = { density_g_per_cup: 128, grams_per_piece: 60 };
const a = toCanonical({ qty: 2, unit: "piece", ingredient: carrot }).g;   // 2 carrots
const b = toCanonical({ qty: 1, unit: "cup", ingredient: carrot }).g;     // 1 cup chopped
t("mixed units share a scale", Math.round(a + b), 248);

// --- display
t("grams", humanWeight(85), "85 g");
t("grams -> lb", humanWeight(500), "1.1 lb");
t("grams -> kg", humanWeight(1500), "1.5 kg");
t("ml -> tsp", humanVolume(5), "1 tsp");
t("ml -> tbsp", humanVolume(30), "2 tbsp");
t("ml -> cups", humanVolume(473), "2 cups");
t("whole count", humanCount(3), "3");
t("half", humanCount(0.5), "½");
t("mixed fraction", humanCount(2.25), "2¼");
t("rounds near-whole", humanCount(2.02), "2");

// --- what the shopping list tells you to buy
//
// The bug this pins: nearly every vegetable carries a pack size as well as a
// per-piece weight, so checking the pack first turned "2 carrots" into "1 bag".
// True of the shelf, useless to someone standing in front of the carrots.
const looseCarrot = { id: "looseCarrot", name: "looseCarrot", aisle: "produce", grams_per_piece: 60,
                 typical_pack_size: 454, typical_pack_unit: "g bag", typical_pack_grams: 454 };
const chickpeas = { id: "chickpeas", name: "chickpeas", aisle: "pantry",
                    typical_pack_size: 425, typical_pack_unit: "g can", typical_pack_grams: 425 };
const blueberry = { id: "blueberry", name: "blueberry", aisle: "produce", grams_per_piece: 1.5,
                    typical_pack_size: 170, typical_pack_unit: "g punnet", typical_pack_grams: 170 };

const buy = (ingredient, g) => purchase({ ingredient, g, anyWeight: true, count: 0, ml: 0 });

t("loose produce is counted, not bagged", buy(looseCarrot, 120).main, "2");
t("and rounds up to whole pieces", buy(looseCarrot, 128).main, "2");
t("never below one", buy(looseCarrot, 20).main, "1");
t("the real requirement is still shown", buy(looseCarrot, 120).detail, "need 120 g");
t("tinned goods stay in tins", buy(chickpeas, 800).main, "2 cans");
t("with the requirement alongside", buy(chickpeas, 800).detail.startsWith("need "), true);
// The 30 g floor earning its keep: without it this would say "200 blueberries".
t("things too small to count are weighed, not counted", buy(blueberry, 300).main, "300 g");

// --- quantities read as fractions, never as decimals
//
// Two sources of stray decimals: r1's extracted quantities and r2's rescaling
// from 4 servings to 5. "0.94 cup" and "0.63 cucumber" are both artifacts, not
// instructions, and both reached the live site before this was pinned.
t("whole stays whole", fmtQty(3), "3");
t("near-whole rounds", fmtQty(0.94), "1");
t("simple fraction", fmtQty(0.5), "½");
t("mixed fraction", fmtQty(1.25), "1¼");
t("eighths from rescaling", fmtQty(0.625), "⅝");
t("sixths", fmtQty(0.833), "⅚");
t("snaps to the NEAREST fraction, not the first", fmtQty(0.31), "⅓");
t("and 0.29 goes the other way", fmtQty(0.29), "¼");
t("ranges keep both ends", fmtQty(0.5, 0.75), "½–¾");
t("no quantity renders as a decimal", (() => {
  for (let n = 0.05; n <= 4; n += 0.01) if (/\d\.\d/.test(fmtQty(Math.round(n * 100) / 100))) return String(n);
  return "clean";
})(), "clean");

// --- the serving model
t("everything serves five", BASE_SERVINGS, 5);
t("whole multiples only", SCALES.join(","), "1,2,3,4");
t("a main is relabelled, whatever its card said",
  yieldLabel({ course: "main", yield_text: "Serves 4" }), "5 servings");
t("and scales with the multiplier",
  yieldLabel({ course: "main", yield_text: "Serves 4" }, 2), "10 servings");
t("a dessert keeps its own batch size",
  yieldLabel({ course: "dessert", yield_text: "Makes 36 cookies" }), "Makes 36 cookies");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
