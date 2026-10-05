/**
 * Unit conversion. Deterministic on purpose — this is arithmetic, and a model
 * that occasionally decides a cup is 250 ml would quietly corrupt every
 * grocery list downstream.
 *
 * Three measure classes: volume (ml), weight (g), count (pieces). A canonical
 * ingredient carries the two bridges between them — `density_g_per_cup` for
 * volume -> weight, `grams_per_piece` for count -> weight — so quantities
 * written in different ways can still be added together.
 */

const ML = {
  milliliter: 1, ml: 1,
  liter: 1000, litre: 1000, l: 1000,
  teaspoon: 4.92892, tsp: 4.92892,
  tablespoon: 14.7868, tbsp: 14.7868,
  cup: 236.588, c: 236.588,
  "fluid ounce": 29.5735, "fl oz": 29.5735,
  pint: 473.176, quart: 946.353, gallon: 3785.41,
  dash: 0.616, pinch: 0.308, splash: 5, drop: 0.05,
};

const G = {
  gram: 1, g: 1, gr: 1,
  kilogram: 1000, kg: 1000,
  ounce: 28.3495, oz: 28.3495,
  pound: 453.592, lb: 453.592, lbs: 453.592,
};

/**
 * Units that mean "one of the thing". They are not interchangeable with each
 * other — a clove is not a head — so each stays its own count unit and the
 * bridge to grams is per-ingredient.
 */
const COUNT = new Set([
  "piece", "clove", "can", "package", "packet", "bunch", "head", "stalk",
  "sprig", "leaf", "ear", "bulb", "rib", "slice", "box", "bag", "jar",
  "container", "handful", "batch", "recipe", "sheet", "link", "strip", "wedge",
]);

/** Plural/abbreviation handling, plus the few unit names that are really foods. */
export function normalizeUnit(unit) {
  if (!unit) return null;
  let u = String(unit).trim().toLowerCase().replace(/\.$/, "");
  if (!u) return null;
  // "2 lemons" arrives as unit:"lemon" — that's a count of a thing, not a unit
  if (/^(lemon|lime|onion|egg|apple|potato|tomato|carrot|pepper|orange)s?$/.test(u)) return "piece";
  if (u.endsWith("es") && (ML[u.slice(0, -2)] || G[u.slice(0, -2)] || COUNT.has(u.slice(0, -2)))) u = u.slice(0, -2);
  else if (u.endsWith("s") && (ML[u.slice(0, -1)] || G[u.slice(0, -1)] || COUNT.has(u.slice(0, -1)))) u = u.slice(0, -1);
  return u;
}

export function unitClass(unit) {
  const u = normalizeUnit(unit);
  if (!u) return "unitless";
  if (ML[u]) return "volume";
  if (G[u]) return "weight";
  if (COUNT.has(u)) return "count";
  return "unknown";
}

/**
 * Convert one ingredient line to a canonical measure.
 *
 * Returns `{ g, ml, count, basis }`. `basis` says how firm the number is:
 *  - "exact"    read straight off a weight or volume
 *  - "density"  volume converted to weight using the ingredient's density
 *  - "per_piece" count converted to weight using grams_per_piece
 *  - "count"    a count with no weight bridge — still addable as a count
 *  - null       nothing usable (to taste, or an unknown unit)
 */
export function toCanonical({ qty, unit, ingredient }) {
  const u = normalizeUnit(unit);
  const cls = unitClass(u);
  const n = typeof qty === "number" && Number.isFinite(qty) ? qty : null;
  if (n === null) return { g: null, ml: null, count: null, basis: null };

  if (cls === "weight") return { g: n * G[u], ml: null, count: null, basis: "exact" };

  if (cls === "volume") {
    const ml = n * ML[u];
    const d = ingredient?.density_g_per_cup;
    return { g: d ? (ml / ML.cup) * d : null, ml, count: null, basis: d ? "density" : "exact" };
  }

  if (cls === "count") {
    const per = ingredient?.grams_per_piece;
    // a "can" or "package" has its own weight, distinct from one piece
    const packish = ["can", "package", "packet", "box", "jar", "bag", "container"].includes(u);
    const grams = packish ? ingredient?.typical_pack_grams : per;
    return { g: grams ? n * grams : null, ml: null, count: n, basis: grams ? "per_piece" : "count" };
  }

  // unitless: "3 carrots", "1 lemon"
  if (cls === "unitless") {
    const per = ingredient?.grams_per_piece;
    return { g: per ? n * per : null, ml: null, count: n, basis: per ? "per_piece" : "count" };
  }

  return { g: null, ml: null, count: null, basis: null };
}

/** Grams -> the friendliest way to say it on a shopping list. */
export function humanWeight(g) {
  if (g >= 1000) return `${round(g / 1000, 2)} kg`;
  if (g >= 454) return `${round(g / 453.592, 2)} lb`;
  if (g >= 100) return `${Math.round(g)} g`;
  return `${round(g, 1)} g`;
}

export function humanVolume(ml) {
  if (ml >= 946) return `${round(ml / 946.353, 2)} qt`;
  if (ml >= 236) {
    const cups = round(ml / 236.588, 2);
    return `${cups} ${cups === 1 ? "cup" : "cups"}`;
  }
  if (ml >= 15) return `${round(ml / 14.7868, 1)} tbsp`;
  return `${round(ml / 4.92892, 1)} tsp`;
}

/** Fractions read better than decimals on a list people carry round a shop. */
const FRACTIONS = [[1, 8, "⅛"], [1, 4, "¼"], [1, 3, "⅓"], [1, 2, "½"], [2, 3, "⅔"], [3, 4, "¾"]];
export function humanCount(n) {
  const whole = Math.floor(n);
  const frac = n - whole;
  if (frac < 0.06) return String(whole);
  const hit = FRACTIONS.find(([a, b]) => Math.abs(frac - a / b) < 0.06);
  if (!hit) return round(n, 2).toString();
  return whole ? `${whole}${hit[2]}` : hit[2];
}

export function round(n, places = 2) {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

export const CONVERSIONS = { ML, G, COUNT };
