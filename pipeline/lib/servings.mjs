/**
 * How VegBatch counts servings.
 *
 * Every recipe here serves 5 as written. That is a decision, not a
 * measurement: 63 of the 206 source cards never wrote a yield down and the
 * rest claimed anywhere from 1 to 60, so the yield was always the weakest
 * field in the collection. The quantities, by contrast, come from a decade of
 * this household actually cooking these dishes at portions they're happy
 * with. So the quantities are treated as truth and relabelled to one base —
 * as written = 5 servings. No quantity was rescaled to get here.
 *
 * The payoff is arithmetic the reader can check: 5 days for 2 is 10 servings,
 * so ×2. That is how this kitchen has always worked; the app now matches it.
 *
 * Imported by both the browser and the build so the recipe page, the planner
 * and the pre-rendered HTML can never drift apart.
 */

export const BASE_SERVINGS = 5;

/** Whole multiples only: "×2" is an instruction, "×1.5" is a rounding error. */
export const SCALES = [1, 2, 3, 4];

/**
 * Courses measured in batches rather than meals. A tray of cookies is not
 * "5 servings" of anything, and nobody plans a week around one — these keep
 * whatever their card said they make.
 */
export const BATCH_COURSES = new Set(["dessert", "snack"]);

/**
 * A recipe keeps its own stated yield when it isn't measured in meals.
 *
 * Two ways that happens. `fixed_yield` is set per recipe at extraction time —
 * the r2 cookbook's breakfasts and desserts were taken at the yield printed
 * on the page, by request, rather than rescaled. BATCH_COURSES catches the
 * r1 recipes, which predate that flag and carry no yield decision of their
 * own. Both mean the same thing here: don't call it servings.
 */
export const isBatch = (r) => r.fixed_yield === true || BATCH_COURSES.has(r.course);

/** What to show next to a recipe: its own yield if a batch, else servings. */
export function yieldLabel(r, scale = 1) {
  if (isBatch(r)) {
    if (!r.yield_text) return null;
    return scale > 1 ? `${r.yield_text} × ${scale}` : r.yield_text;
  }
  const n = BASE_SERVINGS * scale;
  return `${n} servings`;
}

/**
 * Whether the planner may scale this across a week.
 *
 * The r2 recipes are raw, and a good many of them say "serve immediately" and
 * mean it — spiralized zucchini is water by Tuesday. Publishing them is right;
 * handing someone five days of them is not. Anything that hasn't been judged
 * (every r1 recipe) is assumed to keep, which is how it behaved before.
 */
export const keepsForAWeek = (r) => r.keeps_well !== false;
