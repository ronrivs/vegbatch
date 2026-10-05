/**
 * Grocery list construction — shared by the CLI and the web app.
 *
 * Pure: no filesystem, no node builtins, no I/O. Everything comes in as
 * arguments and a plain object comes out, so the browser can import this file
 * unchanged. That is the point — the aggregation existing in two places is
 * exactly the drift that let "vegetable broth" sit in an ingredient list while
 * the method still said "chicken broth".
 *
 * Renderers decide how to display the result; they must not re-derive it.
 */
import { humanWeight, humanVolume, humanCount } from "./units.mjs";
import { fmtQty } from "./recipe-html.mjs";

/** Fresh, dried and frozen are different purchases even from the same plant. */
export const SPLIT_FORMS = new Set(["fresh", "dried", "frozen"]);
const keyOf = (id, form) => (SPLIT_FORMS.has(form) ? `${id}|${form}` : id);

export const AISLE_ORDER = [
  "produce", "bakery", "dairy", "eggs", "refrigerated", "frozen", "canned",
  "grains and pasta", "dry goods", "nuts and seeds", "baking", "spices",
  "condiments", "oils and vinegars", "international", "beverages", "other",
];

/** English plurals, for the handful of nouns that actually appear here. */
const IRREGULAR = { leaf: "leaves", loaf: "loaves", half: "halves", knife: "knives" };
export function plural(word, n) {
  if (!word || n <= 1) return word; // "½ red onion", not "½ red onions"
  const last = word.split(" ").pop();
  if (/s$/i.test(last) && !/(ss|us)$/i.test(last)) return word; // already plural
  if (IRREGULAR[last]) return word.replace(new RegExp(`${last}$`), IRREGULAR[last]);
  if (/(s|x|z|ch|sh)$/i.test(word)) return `${word}es`;
  if (/[^aeiou]y$/i.test(word)) return `${word.slice(0, -1)}ies`;
  return `${word}s`;
}

/** A pack noun like "can (15 oz)" or "8 oz bag" still means a discrete thing. */
const DISCRETE = /\b(can|jar|bag|box|bunch|head|package|pack|container|bottle|carton|pint|tub|loaf|dozen)\b/i;
const MEASURE_PACK = /^(ml|l|liter|litre|g|kg|gram|oz|lb|pound|fl oz)$/i;

function packNoun(unit) {
  const m = DISCRETE.exec(unit ?? "");
  return m ? m[1].toLowerCase() : null;
}

/** A dried herb is a jar on the spice shelf, not the bunch its fresh form is. */
function packFor(entry) {
  const c = entry.ingredient;
  if (entry.form === "dried" && (c.category === "herb" || c.category === "spice")) {
    return { noun: "jar", grams: 25 };
  }
  return { noun: packNoun(c.typical_pack_unit), grams: c.typical_pack_grams };
}

/**
 * Grams -> something you can actually put in a trolley.
 * Returns `{ main, detail, countsName }`; `countsName` is set when `main` is a
 * bare number and the caller should pluralise the ingredient name itself.
 */
export function purchase(entry) {
  const c = entry.ingredient;

  // counted things with no weight behind them stay counted, in their own noun
  if (!entry.anyWeight && entry.count > 0) {
    const noun = entry.countUnit ?? (c.grams_per_piece ? c.name : null);
    return { main: `${humanCount(entry.count)}${noun ? ` ${plural(noun, entry.count)}` : ""}`, detail: null };
  }

  if (entry.anyWeight && entry.g > 0) {
    // Loose produce is bought by the piece, so say how many pieces. This has
    // to come before the pack branch: nearly every vegetable also carries a
    // pack size, and checking that first turned "2 carrots" into "1 bag" —
    // true of the shelf, useless to someone holding two carrots. The 30 g
    // floor keeps it sane: you count carrots, you do not count blueberries.
    if (c.grams_per_piece >= 30 && c.aisle === "produce") {
      // Whole pieces only — nobody buys ⅛ of a carrot or half an onion. Round
      // up, with a little slack so 2.05 carrots doesn't demand a third.
      const n = Math.max(1, Math.ceil(entry.g / c.grams_per_piece - 0.15));
      return { main: humanCount(n), detail: `need ${humanWeight(entry.g)}`, countsName: n };
    }

    const pack = packFor(entry);
    if (pack.noun && pack.grams > 0) {
      const n = Math.max(1, Math.ceil(entry.g / pack.grams - 0.08));
      // Tinned and jarred goods genuinely come in packs — you cannot buy 400 g
      // of canned chickpeas — so the pack stays the headline here. The recipe's
      // actual requirement rides alongside it rather than being dropped.
      return {
        main: `${n} ${plural(pack.noun, n)}`,
        detail: `need ${humanWeight(entry.g)} · ~${humanWeight(pack.grams)} each`,
      };
    }
    // The pack is sized but unnamed — "500 ml", not "500 ml bottle". Still a
    // unit you buy, so describe it by its size rather than dumping 2.6 cups
    // of olive oil on the list.
    if (pack.grams > 0 && c.typical_pack_size && MEASURE_PACK.test(c.typical_pack_unit ?? "")) {
      const n = Math.max(1, Math.ceil(entry.g / pack.grams - 0.08));
      return { main: `${n} × ${c.typical_pack_size} ${c.typical_pack_unit}`, detail: `need ${humanWeight(entry.g)}` };
    }
    if (entry.anyVolume && c.density_g_per_cup) {
      return { main: humanVolume((entry.g / c.density_g_per_cup) * 236.588), detail: humanWeight(entry.g) };
    }
    return { main: humanWeight(entry.g), detail: null };
  }

  if (entry.ml > 0) return { main: humanVolume(entry.ml), detail: null };
  return { main: "some", detail: null };
}

/**
 * What to show in the "which recipe did this come from?" line.
 *
 * NOT `raw_text`. That field holds what the original card said, and for the
 * twenty-odd substituted recipes it still says "1 lb ground beef" or "ham
 * bone" — so turning that option on printed meat onto the list of a site
 * whose whole claim is that every recipe is vegetarian. The provenance is
 * worth keeping in the data; it is not what a shopper should be shown.
 *
 * Uses fmtQty so fractions match the recipe page exactly rather than being
 * formatted a second way here.
 */
const sourceLine = (ing) =>
  [fmtQty(ing.qty_min, ing.qty_max), ing.unit, ing.item].filter(Boolean).join(" ");

/**
 * Build a grocery list.
 *
 * @param recipes   the chosen recipes, each with a `scale` (1 = as written)
 * @param catalog   ingredients.json, keyed by name
 * @param staples   the household staples list (may be empty)
 * @param options   { includeStaples, includePantry }
 */
export function buildList({ recipes: chosen, catalog, staples = [], options = {} }) {
  const byId = new Map(Object.values(catalog).map((c) => [c.id, c]));
  const lines = new Map();
  const toCheck = [];

  for (const r of chosen) {
    const scale = r.scale ?? 1;
    for (const comp of r.components) {
      for (const ing of comp.ingredients) {
        const id = ing.canonical?.[0];
        const c = id ? byId.get(id) : null;
        if (!c) continue;

        // A line can resolve to several canonical ingredients, and only the
        // first one is ever weighed. That is right for an alternative —
        // "cotija cheese or feta" is one purchase — but wrong for a genuine
        // compound: "yellow and red bell pepper" is two, and 090's
        // substituted broth base is stock AND paprika AND soy sauce AND bay
        // leaves. The quantity can't be split between them honestly (the
        // recipe wrote one figure), so the extras go on the check list rather
        // than being invented or, as before, silently dropped.
        if (!/\bor\b/i.test(ing.item ?? "")) {
          for (const extra of (ing.canonical ?? []).slice(1)) {
            const e = byId.get(extra);
            if (e) toCheck.push({ name: e.name, recipe: r.title, raw: sourceLine(ing) });
          }
        }

        if (ing.to_taste || (ing.qty_min == null && ing.qty_count == null)) {
          toCheck.push({ name: c.name, recipe: r.title, raw: sourceLine(ing) });
          continue;
        }

        const k = keyOf(id, ing.form);
        const entry = lines.get(k) ?? {
          key: k, ingredient: c, form: SPLIT_FORMS.has(ing.form) ? ing.form : null,
          g: 0, ml: 0, count: 0, countUnit: null, sources: [],
          anyWeight: false, anyVolume: false, estimated: false, staple: null,
        };
        if (ing.qty_g != null) { entry.g += ing.qty_g * scale; entry.anyWeight = true; }
        else if (ing.qty_ml != null) { entry.ml += ing.qty_ml * scale; entry.anyVolume = true; }
        else if (ing.qty_count != null) {
          entry.count += ing.qty_count * scale;
          // remember what is being counted — leaves, cloves, sprigs — so the
          // list doesn't end up asking for "6 bunches" of basil leaves
          entry.countUnit ??= ing.unit_normalized && ing.unit_normalized !== "piece" ? ing.unit_normalized : null;
        }
        if (ing.unit_class === "volume") entry.anyVolume = true;
        if (ing.qty_estimated) entry.estimated = true;
        entry.sources.push({ recipe: r.title, id: r.id, raw: sourceLine(ing), scale });
        lines.set(k, entry);
      }
    }
  }

  // The household staples list: recurring weekly buys, added on request.
  // Distinct from is_pantry, which means "already have it, leave it off".
  const addedStaples = [];
  if (options.includeStaples) {
    for (const s of staples.filter((x) => x.active)) {
      const c = s.canonical ? byId.get(s.canonical) : null;
      const k = c ? keyOf(c.id, null) : `staple:${s.item}`;
      const existing = lines.get(k);
      if (existing) {
        existing.staple = s; // already needed for a recipe — top it up
        if (s.unit && c?.typical_pack_grams) existing.g += s.qty * c.typical_pack_grams;
        else existing.count += s.qty;
        addedStaples.push(s.item);
        continue;
      }
      lines.set(k, {
        key: k,
        // the staple keeps the name the household typed — borrow the
        // catalog's aisle and pack facts, never its identity
        ingredient: {
          id: k, name: s.item, aisle: s.aisle ?? c?.aisle ?? "other",
          is_pantry: false, category: c?.category ?? "other",
          grams_per_piece: null, density_g_per_cup: null,
          typical_pack_unit: s.unit, typical_pack_grams: null,
        },
        form: null, g: 0, ml: 0, count: s.qty, countUnit: s.unit,
        sources: [], anyWeight: false, anyVolume: false, estimated: false, staple: s,
      });
      addedStaples.push(s.item);
    }
  }

  // An explicit staple always beats the pantry assumption — saying "I buy
  // olive oil every week" is exactly the case where the default is wrong.
  const onList = (e) => options.includePantry || !e.ingredient.is_pantry || e.staple;

  const items = [...lines.values()].filter(onList).sort((a, b) => {
    const d = AISLE_ORDER.indexOf(a.ingredient.aisle) - AISLE_ORDER.indexOf(b.ingredient.aisle);
    return d || a.ingredient.name.localeCompare(b.ingredient.name);
  });

  const recipeCount = (e) => new Set(e.sources.map((s) => s.id)).size;

  // "fresh" only earns its place when a dried or frozen twin is also here
  const formCounts = new Map();
  for (const e of lines.values()) {
    formCounts.set(e.ingredient.id, (formCounts.get(e.ingredient.id) ?? 0) + 1);
  }

  for (const e of items) {
    const p = purchase(e);
    const showForm = e.form && (e.form !== "fresh" || formCounts.get(e.ingredient.id) > 1);
    const base = p.countsName != null ? plural(e.ingredient.name, p.countsName) : e.ingredient.name;
    e.purchase = p;
    e.label = showForm ? `${e.form} ${base}` : base;
    e.sharedAcross = recipeCount(e);
  }

  return {
    items,
    byAisle: AISLE_ORDER
      .map((aisle) => ({ aisle, items: items.filter((e) => e.ingredient.aisle === aisle) }))
      .filter((g) => g.items.length),
    pantry: [...lines.values()].filter((e) => !onList(e)),
    shared: items.filter((e) => e.sharedAcross > 1).sort((a, b) => b.sharedAcross - a.sharedAcross),
    toCheck: [...new Map(toCheck.map((t) => [t.name, t])).values()],
    addedStaples,
    estimatedCount: items.filter((e) => e.estimated).length,
  };
}
