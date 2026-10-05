/**
 * Recipe import — a web page or pasted text, normalized into the shape the
 * dataset uses, ready for `prepareRecipes` to wire in.
 *
 * Pure: no filesystem, no network. The CLI fetches and reads; this file only
 * parses and decides. Every decision is a rule the tests can pin:
 *
 *  - ingredients and steps are transcribed verbatim (functional content)
 *  - the source's prose is never copied; a plain description is drafted from
 *    the ingredients and marked for rewriting in review
 *  - meat broth becomes vegetable broth, recorded; other meat is flagged,
 *    never silently substituted
 *  - a recipe in servings is rescaled to the collection's base of 5 — the
 *    same move the r2 cookbook got — unless told to keep the quantities
 *  - an ingredient the catalog does not know is reported, not invented. A
 *    confident match (alias, exact name, plural, a stripped prep word) is
 *    applied; a looser match is a suggestion the operator accepts by hand
 *
 * Zero API calls. This is the "rule-based first, model for the tail" line in
 * SCOPE.md: the tail is a Claude Code session editing the JSON this writes.
 */
import { CONVERSIONS } from "./units.mjs";
import { BASE_SERVINGS, BATCH_COURSES } from "./servings.mjs";
import { resolveBases } from "./add-recipe.mjs";

// ------------------------------------------------------------------ text

const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  frac14: "¼", frac12: "½", frac34: "¾", frac13: "⅓", frac23: "⅔", frac18: "⅛",
  frac38: "⅜", frac58: "⅝", frac78: "⅞", frac16: "⅙", frac56: "⅚",
  deg: "°", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“",
  eacute: "é", egrave: "è", agrave: "à", ccedil: "ç", ntilde: "ñ", uuml: "ü", ouml: "ö", auml: "ä",
};

export function decodeEntities(s) {
  return String(s ?? "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z0-9]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

export const stripTags = (s) => decodeEntities(String(s ?? "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

const UNICODE_FRAC = {
  "¼": "1/4", "½": "1/2", "¾": "3/4", "⅓": "1/3", "⅔": "2/3", "⅛": "1/8",
  "⅜": "3/8", "⅝": "5/8", "⅞": "7/8", "⅙": "1/6", "⅚": "5/6",
};

/** "1½" -> "1 1/2", "&frac14;" -> "1/4", curly quotes straightened. */
export function cleanLine(line) {
  let s = decodeEntities(line).replace(/\s+/g, " ").trim();
  s = s.replace(/(\d)([¼½¾⅓⅔⅛⅜⅝⅞⅙⅚])/g, "$1 $2");
  s = s.replace(/[¼½¾⅓⅔⅛⅜⅝⅞⅙⅚]/g, (f) => UNICODE_FRAC[f]);
  s = s.replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/ /g, " ");
  return s;
}

// ----------------------------------------------------------- quantities

const NUM = String.raw`(?:\d+\s+\d+\/\d+|\d+\/\d+|\d*\.\d+|\d+)`;
const RANGE = new RegExp(String.raw`^(${NUM})(?:\s*(?:-|–|—|to|or)\s*(${NUM}))?(?![\w\/])\s*`, "i");

export function parseNumber(s) {
  if (s == null) return null;
  const t = String(s).trim();
  const mixed = /^(\d+)\s+(\d+)\/(\d+)$/.exec(t);
  if (mixed) return Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3]);
  const frac = /^(\d+)\/(\d+)$/.exec(t);
  if (frac) return Number(frac[1]) / Number(frac[2]);
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

// Every unit the conversion layer knows, plus the spellings recipes use.
const UNIT_WORDS = new Map();
for (const u of [...Object.keys(CONVERSIONS.ML), ...Object.keys(CONVERSIONS.G), ...CONVERSIONS.COUNT]) {
  if (u.length > 1) { UNIT_WORDS.set(u, u); UNIT_WORDS.set(`${u}s`, u); UNIT_WORDS.set(`${u}es`, u); }
}
for (const [w, u] of Object.entries({
  tbsp: "tablespoon", tbs: "tablespoon", tbl: "tablespoon", tablespoons: "tablespoon", tablespoonful: "tablespoon",
  tsp: "teaspoon", teaspoons: "teaspoon", teaspoonful: "teaspoon",
  c: "cup", cups: "cup", oz: "ounce", ounces: "ounce", "fl oz": "fl oz", "fluid ounces": "fl oz", "fluid ounce": "fl oz",
  lb: "pound", lbs: "pound", pounds: "pound", g: "gram", grams: "gram", kg: "kilogram", ml: "ml", l: "liter", liters: "liter", litres: "litre",
  qt: "quart", quarts: "quart", pt: "pint", pints: "pint", gal: "gallon",
  cans: "can", cloves: "clove", bunches: "bunch", heads: "head", stalks: "stalk", sprigs: "sprig", leaves: "leaf",
  ears: "ear", ribs: "rib", slices: "slice", packages: "package", pkg: "package", pkgs: "package", packets: "packet",
  jars: "jar", bags: "bag", boxes: "box", handfuls: "handful", pinches: "pinch", dashes: "dash", bulbs: "bulb", wedges: "wedge",
})) UNIT_WORDS.set(w, u);
UNIT_WORDS.delete("c"); // "1 c flour" is real but "2 c" is also how a card says "2 cans"; too risky to claim

const PACK_NOUN = /^(cans?|packages?|packets?|jars?|bags?|boxes?|containers?|bottles?|cartons?|bunch(?:es)?|heads?)\b/i;

/** Size and hedge words — never part of what you buy, so they leave the item itself. */
const SIZE_WORDS = new Set([
  "large", "medium", "small", "big", "extra-large", "jumbo",
  "about", "approximately", "roughly", "heaping", "scant", "level", "packed",
]);

/** Words that describe preparation or size, not identity. Safe to strip when matching. */
const PREP_WORDS = new Set([
  "chopped", "diced", "minced", "sliced", "grated", "shredded", "crushed", "cubed", "halved", "quartered",
  "crumbled", "mashed", "pressed", "torn", "zested", "juiced", "squeezed", "beaten", "whisked", "thawed",
  "cored", "stemmed", "deveined", "julienned", "spiralized", "steamed", "blanched", "softened",
  "peeled", "seeded", "pitted", "trimmed", "rinsed", "drained", "cooked", "uncooked", "raw", "ripe",
  "finely", "roughly", "thinly", "thickly", "freshly", "lightly", "coarsely",
  "large", "medium", "small", "big", "extra-large", "jumbo",
  "organic", "unsalted", "low-sodium", "reduced-sodium", "low-fat", "nonfat", "non-fat", "full-fat", "plain",
  "extra", "virgin", "extra-virgin", "pure", "good", "quality", "baby", "fine", "sea", "kosher", "flaky",
  "boneless", "skinless", "firm", "soft", "hot", "cold", "warm", "room", "temperature", "cooled", "melted", "softened", "toasted",
  "packed", "heaping", "scant", "level", "about", "approximately", "roughly",
]);

/** Form words carry over to the ingredient line rather than being dropped. */
const FORM_WORDS = new Set(["fresh", "dried", "frozen", "canned", "ground"]);

const COUNT_NOUNS = new Set(["clove", "leaf", "sprig", "stalk", "head", "bunch", "ear", "rib", "bulb", "slice", "wedge", "stick"]);

// ------------------------------------------------------ one ingredient

/**
 * "1 (15-ounce) can chickpeas, rinsed and drained" ->
 *   { qty_min: 1, qty_max: null, unit: "can", item: "chickpeas",
 *     prep_note: "15-ounce; rinsed and drained", optional: false, to_taste: false }
 *
 * `raw_text` always keeps the original line. The `item` is cleaned (size words
 * removed, prep after the comma moved to the note) but is NOT the catalog
 * name — resolveItem does that. "diced tomatoes" stays "diced tomatoes": the
 * prep word may be part of what you buy.
 *
 * `resolves(item)` is optional: when given, a trailing count noun ("4 garlic
 * cloves") is only split off if what remains is a known ingredient, so "2 bay
 * leaves" stays whole.
 */
export function parseIngredientLine(line, resolves = () => true) {
  const raw = String(line ?? "").trim();
  let s = cleanLine(raw).replace(/^[-*•▢☐]\s*/, "");
  const notes = [];

  const optional = /\boptional\b/i.test(s);
  s = s.replace(/[\s,(]*\boptional\b[\s)]*/gi, " ").trim();
  const to_taste = /\bto taste\b/i.test(s) || /\bas needed\b/i.test(s);
  s = s.replace(/[\s,]*\b(to taste|as needed)\b/gi, "").trim();

  let qty_min = null, qty_max = null;
  let unit = null;

  // "Juice of 1 lime", "zest of 2 lemons": what you buy is the fruit
  const juice = /^(juice|zest)\s+(?:of|from)\s+(?:(\d+(?:\s+\d+\/\d+)?|\d+\/\d+|a|an|one|half a|½)\s+)?(?:(large|medium|small)\s+)?([a-z]+?)s?$/i.exec(s);
  if (juice) {
    const n = juice[2] == null || /^(a|an|one)$/i.test(juice[2]) ? 1 : /^(half a|½)$/i.test(juice[2]) ? 0.5 : parseNumber(juice[2]);
    notes.push(`${juice[1].toLowerCase()} of`);
    s = juice[4];
    qty_min = n;
  }

  // "a pinch of", "pinch of", "a handful of", "dash of": a count of a small unit
  const small = /^(?:a |an )?(pinch|dash|splash|handful|drizzle|sprinkle|squeeze)(?:es)?\s+of\s+/i.exec(s);
  if (small) {
    qty_min = 1;
    unit = UNIT_WORDS.has(small[1].toLowerCase()) ? UNIT_WORDS.get(small[1].toLowerCase()) : small[1].toLowerCase();
    s = s.slice(small[0].length);
  }

  const m = qty_min == null ? RANGE.exec(s) : null;
  if (m) {
    qty_min = parseNumber(m[1]);
    qty_max = m[2] ? parseNumber(m[2]) : null;
    s = s.slice(m[0].length);
  }

  // "1 large can (28 ounces) ..." — a size word between the number and the unit
  s = s.replace(/^(large|medium|small|big|heaping|scant|level|generous)\s+(?=[a-z])/i, (w) => { notes.push(w.trim().toLowerCase()); return ""; });

  // parenthetical pack size right after the number: "1 (15 oz) can ..."
  const packFirst = /^\(([^)]*)\)\s*(.*)$/.exec(s);
  if (packFirst && PACK_NOUN.test(packFirst[2])) { notes.push(packFirst[1]); s = packFirst[2]; }

  // the unit itself: two words first ("fl oz"), then one
  const words = s.split(" ");
  const two = `${words[0] ?? ""} ${words[1] ?? ""}`.toLowerCase().replace(/\.$/, "");
  const one = (words[0] ?? "").toLowerCase().replace(/\.$/, "");
  if (!unit && qty_min != null && UNIT_WORDS.has(two)) { unit = UNIT_WORDS.get(two); s = words.slice(2).join(" "); }
  else if (!unit && qty_min != null && UNIT_WORDS.has(one)) { unit = UNIT_WORDS.get(one); s = words.slice(1).join(" "); }

  // "2 cans (15 oz each) chickpeas"
  const packAfter = /^\(([^)]*)\)\s*(.*)$/.exec(s);
  if (unit && packAfter) { notes.push(packAfter[1]); s = packAfter[2]; }

  s = s.replace(/^of\s+/i, "").trim();

  // prep after the first comma; any other parenthetical is also a note
  const comma = s.indexOf(",");
  if (comma !== -1) { notes.push(s.slice(comma + 1).trim()); s = s.slice(0, comma).trim(); }
  s = s.replace(/\(([^)]*)\)/g, (_, inner) => { notes.push(inner.trim()); return " "; }).replace(/\s+/g, " ").trim();
  // "for serving", "for garnish", "plus more for ..." are notes too, and a
  // garnish is optional by nature
  let garnish = false;
  s = s.replace(/[\s,]*\b(for (serving|garnish|the pan|greasing|drizzling|topping)|plus more[^,]*|divided)\b.*$/i, (x) => { notes.push(x.trim()); garnish ||= /serving|garnish|topping/i.test(x); return ""; }).trim();
  for (const n of notes) if (/^(for (serving|garnish|topping)|to garnish|garnish)/i.test(n)) garnish = true;

  // "4 garlic cloves" — the count noun trails the thing being counted
  const w = s.toLowerCase().split(" ");
  const last = w[w.length - 1];
  const lastSingular = UNIT_WORDS.get(last);
  if (!unit && qty_min != null && w.length > 1 && lastSingular && COUNT_NOUNS.has(lastSingular)
      && resolves(w.slice(0, -1).filter((t) => !SIZE_WORDS.has(t)).join(" "))) {
    unit = lastSingular;
    s = w.slice(0, -1).join(" ");
  }

  // size words out of the item; prep and form words stay
  const kept = s.split(" ").filter((t) => {
    const k = t.toLowerCase();
    if (SIZE_WORDS.has(k)) { notes.push(k); return false; }
    return true;
  });
  const item = kept.join(" ").replace(/^(and|or)\s+/i, "").replace(/\s+(and|or)$/i, "").trim().toLowerCase() || s.toLowerCase();

  const prep_note = [...new Set(notes.filter(Boolean))].join("; ") || null;
  return {
    raw_text: raw, item, qty_min, qty_max, unit, prep_note,
    optional: optional || garnish, to_taste: to_taste || (qty_min == null && /^(sea |kosher |flaky )?salt( and (freshly ground |ground )?(black )?pepper)?$/.test(item)),
    qty_estimated: false, estimate_basis: null, substituted_from: null,
  };
}

// --------------------------------------------------- catalog matching

const singulars = (k) => {
  const out = [k];
  if (k.endsWith("ies")) out.push(`${k.slice(0, -3)}y`);
  if (k.endsWith("ves")) out.push(`${k.slice(0, -3)}f`); // leaves, halves
  if (k.endsWith("oes")) out.push(k.slice(0, -2));
  if (k.endsWith("es")) out.push(k.slice(0, -2));
  if (k.endsWith("s")) out.push(k.slice(0, -1));
  out.push(`${k}s`, `${k}es`);
  return out;
};

const COLOURS = new Set(["red", "yellow", "green", "white", "orange", "purple", "black", "brown", "golden", "sweet"]);

/**
 * Map a cleaned item to catalog keys.
 *
 * Returns { bases, form, confident, via } or null when nothing matched.
 * `confident` is true for the matches this file will apply on its own; false
 * means the operator must accept it (printed as a suggestion by the CLI).
 */
export function resolveItem(item, catalog, aliases) {
  const key = (item ?? "").trim().toLowerCase();
  if (!key) return null;
  const has = (k) => catalog[k] != null;

  // 0. "A or B" is one purchase with an alternative. The first option is what
  //    goes on the list (buildList weighs only the first canonical); the rest
  //    ride along as the compound's other parts. "yellow or white onion"
  //    lends the shorter side the noun it is missing.
  if (/\bor\b/.test(key) && !aliases[key] && !has(key)) {
    const parts = key.split(/\s+or\s+/).map((p) => p.trim().split(/\s+/)).filter((p) => p.length);
    const longest = Math.max(...parts.map((p) => p.length));
    const whole = parts.map((p) => {
      const direct = resolveItem(p.join(" "), catalog, aliases);
      if (direct?.confident || p.length === longest) return direct;
      const donor = parts.find((q) => q.length === longest);
      return resolveItem([...p, ...donor.slice(p.length)].join(" "), catalog, aliases);
    });
    // the first option that resolves leads; "brown or green lentils" buys green
    const lead = whole.findIndex((f) => f?.confident);
    if (lead !== -1) {
      const others = whole.filter((f, n) => n !== lead && f?.confident).flatMap((f) => f.bases);
      return { bases: [...new Set([...whole[lead].bases, ...others])], form: whole[lead].form, confident: true, via: "alternative", compound: others.length > 0 };
    }
  }

  // 1. the alias table and the catalog itself
  const { bases, alias } = resolveBases(key, aliases);
  if (alias && has(bases[0])) return { bases, form: alias.form ?? null, confident: true, via: "alias", compound: !!alias.is_compound };
  if (has(key)) return { bases: [key], form: null, confident: true, via: "exact", compound: false };

  // 2. plural / singular
  for (const k of singulars(key)) if (has(k)) return { bases: [k], form: null, confident: true, via: "plural", compound: false };

  // 3. strip form and prep words, remembering the form
  const tokens = key.split(/\s+/);
  let form = null;
  const core = tokens.filter((t) => {
    if (FORM_WORDS.has(t)) { form ??= t; return false; }
    return !PREP_WORDS.has(t);
  });
  const coreKey = core.join(" ");
  if (coreKey && coreKey !== key) {
    for (const k of singulars(coreKey)) {
      if (has(k)) return { bases: [k], form, confident: true, via: "stripped", compound: false };
      if (aliases[k] && has(resolveBases(k, aliases).bases[0])) {
        const a = aliases[k];
        return { bases: a.is_compound ? a.parts : [a.base_name], form: form ?? a.form ?? null, confident: true, via: "stripped-alias", compound: !!a.is_compound };
      }
    }
  }

  // 4. suggestions: drop colours, then the longest catalog name whose every
  //    word appears in the item ("canned diced tomatoes" -> "tomatoes")
  const loose = core.filter((t) => !COLOURS.has(t));
  for (const k of singulars(loose.join(" "))) if (has(k)) return { bases: [k], form, confident: false, via: "colour", compound: false };

  const itemWords = new Set(core.flatMap(singulars));
  let best = null;
  for (const name of Object.keys(catalog)) {
    const ws = name.split(/\s+/);
    if (ws.length > core.length) continue;
    if (!ws.every((w) => itemWords.has(w))) continue;
    if (!best || ws.join(" ").length > best.length) best = name;
  }
  if (best) return { bases: [best], form, confident: false, via: "contains", compound: false };
  return null;
}

// ----------------------------------------------------- animal products

const MEAT_RE = /\b(chicken|beef|pork|bacon|pancetta|prosciutto|ham|turkey|lamb|veal|sausage|chorizo|salami|pepperoni|anchov(?:y|ies)|fish|salmon|tuna|cod|shrimp|prawns?|crab|lobster|clams?|mussels?|oysters?|scallops?|gelatin|lard|tallow|duck|venison|bison|ground meat|mince)\b/i;
const MEAT_BROTH_RE = /\b(chicken|beef|turkey|pork|ham|bone|fish|veal|lamb)\s+(broth|stock|bouillon|base)\b/i;
const FISHY_SAUCE_RE = /\b(fish sauce|oyster sauce|worcestershire)\b/i;
const HARD_CHEESE_RE = /\b(parmesan|parmigiano|pecorino|grana padano|gruy[eè]re|manchego|asiago|romano)\b/i;
const DAIRY_RE = /\b(cheese|milk|cream|butter|yogurt|yoghurt|ghee|paneer|halloumi|feta|mozzarella|ricotta|cheddar|brie|mascarpone|whey|kefir|buttermilk)\b/i;
const NON_DAIRY_RE = /\b(coconut|almond|oat|soy|cashew|rice|vegan|plant|dairy-free|non-dairy|nut)\b/i;

/** Classify one ingredient; null when it is plant-based. */
export function animalProduct(item, catalogEntry) {
  const name = `${item} ${catalogEntry?.name ?? ""}`.toLowerCase();
  if (MEAT_BROTH_RE.test(name)) return { ingredient: item, type: "meat_broth", note: "Meat broth — swapped for vegetable broth." };
  if (FISHY_SAUCE_RE.test(name)) return { ingredient: item, type: "fish", note: "Contains fish or oyster extract — check the brand or substitute." };
  if (MEAT_RE.test(name)) return { ingredient: item, type: /\b(fish|salmon|tuna|cod|shrimp|prawns?|crab|lobster|clams?|mussels?|oysters?|scallops?|anchov)/i.test(name) ? "fish" : "meat", note: "Transcribed as written — needs a vegetarian decision." };
  if (/\bhoney\b/.test(name) || catalogEntry?.name === "honey") return { ingredient: item, type: "honey", note: "Honey." };
  if (/\beggs?\b/.test(name) || catalogEntry?.category === "egg") return { ingredient: item, type: "egg", note: "Egg." };
  if (HARD_CHEESE_RE.test(name)) return { ingredient: item, type: "cheese_rennet", note: "Hard cheese, traditionally set with animal rennet — check the brand if that matters." };
  if ((catalogEntry?.category === "dairy" || DAIRY_RE.test(name)) && !NON_DAIRY_RE.test(name)) return { ingredient: item, type: "dairy", note: "Dairy." };
  return null;
}

// ---------------------------------------------------- source shapes

/** ISO 8601 duration ("PT1H30M") or English ("1 hour 30 minutes", "45 min") -> minutes. */
export function parseMinutes(s) {
  if (s == null || s === "") return null;
  if (typeof s === "number") return s;
  const iso = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i.exec(String(s).trim());
  if (iso) return (Number(iso[1] ?? 0) * 1440) + (Number(iso[2] ?? 0) * 60) + Number(iso[3] ?? 0) + (Number(iso[4] ?? 0) >= 30 ? 1 : 0);
  let min = 0, hit = false;
  for (const m of String(s).matchAll(/(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m)\b/gi)) {
    hit = true;
    min += /^h/i.test(m[2]) ? Number(m[1]) * 60 : Number(m[1]);
  }
  return hit ? Math.round(min) : null;
}

/** "4 servings" / ["4", "4 servings"] / "Makes 24 cookies" / "Serves 4-6" -> { yield_text, yield_qty, yield_unit }. */
export function parseYield(y) {
  if (y == null) return { yield_text: null, yield_qty: null, yield_unit: null };
  const texts = [].concat(y).map((t) => cleanLine(String(t))).filter(Boolean);
  if (!texts.length) return { yield_text: null, yield_qty: null, yield_unit: null };
  const text = texts.find((t) => /[a-z]/i.test(t)) ?? texts[0];
  const m = /(\d+(?:\.\d+)?)(?:\s*(?:-|–|to)\s*(\d+(?:\.\d+)?))?\s*([a-z][a-z -]*)?/i.exec(text);
  if (!m) return { yield_text: text, yield_qty: null, yield_unit: null };
  const lo = Number(m[1]), hi = m[2] ? Number(m[2]) : null;
  const qty = hi ? (lo + hi) / 2 : lo;
  let unit = (m[3] ?? "").trim().toLowerCase().replace(/^(of|large|small|medium)\s+/, "").split(/\s+/)[0] || "serving";
  if (/^(serves|servings?|people|persons?|portions?|serving)$/.test(unit) || /^serves\b/i.test(text)) unit = "serving";
  const IRREGULAR = { cookies: "cookie", brownies: "brownie", smoothies: "smoothie", pies: "pie", patties: "patty", pastries: "pastry", loaves: "loaf", halves: "half" };
  unit = IRREGULAR[unit] ?? unit.replace(/ies$/, "y").replace(/(?<!s)s$/, "");
  return { yield_text: text, yield_qty: qty, yield_unit: unit };
}

const COURSE_RULES = [
  [/\bsoups?\b|\bstews?\b|\bchil[il]\b/i, "soup"],
  [/\bsalads?\b/i, "salad"],
  [/\bbreakfast\b|\bbrunch\b/i, "breakfast"],
  [/\bdesserts?\b|\bsweets?\b|\bcookies?\b|\bcakes?\b|\bbrownies?\b|\bbaking\b|\bpies?\b/i, "dessert"],
  [/\bsnacks?\b|\bbars?\b|\bbites?\b/i, "snack"],
  [/\bappeti[sz]ers?\b|\bstarters?\b|\bhors d'oeuvres?\b/i, "appetizer"],
  [/\bsides?\b|\bside dish(?:es)?\b/i, "side"],
  [/\bsauces?\b|\bdressings?\b|\bcondiments?\b|\bdips?\b|\bspreads?\b|\bmarinades?\b/i, "sauce"],
  [/\blunch\b|\bsandwich(?:es)?\b|\bwraps?\b/i, "lunch"],
  [/\bmains?\b|\bmain (course|dish)\b|\bdinner\b|\bentr[ée]es?\b|\bentree\b|\bsupper\b/i, "main"],
  // dish words that only ever mean dinner
  [/\bbowls?\b|\btacos?\b|\bburritos?\b|\bcurr(y|ies)\b|\bpasta\b|\bcasseroles?\b|\bburgers?\b|\benchiladas?\b|\bstir[- ]fry\b|\bpizzas?\b|\brisotto\b|\blasagn[ae]\b|\bskillet\b|\bsheet[- ]pan\b/i, "main"],
];

export function inferCourse(...hints) {
  const text = hints.flat().filter(Boolean).map(String).join(" | ");
  for (const [re, course] of COURSE_RULES) if (re.test(text)) return course;
  return null;
}

/** Find the schema.org Recipe in a page's HTML, or null. */
export function recipeFromHtml(html) {
  const blocks = [...String(html).matchAll(/<script[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)];
  for (const b of blocks) {
    let json;
    try { json = JSON.parse(b[1].trim().replace(/^﻿/, "")); } catch { continue; }
    const found = findRecipeNode(json);
    if (found) return found;
  }
  return null;
}

function findRecipeNode(node, depth = 0) {
  if (!node || depth > 6) return null;
  if (Array.isArray(node)) { for (const n of node) { const r = findRecipeNode(n, depth + 1); if (r) return r; } return null; }
  if (typeof node !== "object") return null;
  const types = [].concat(node["@type"] ?? []).map(String);
  if (types.includes("Recipe") && node.recipeIngredient) return node;
  for (const key of ["@graph", "mainEntity", "mainEntityOfPage", "itemListElement", "item"]) {
    if (node[key]) { const r = findRecipeNode(node[key], depth + 1); if (r) return r; }
  }
  return null;
}

const asText = (v) => (typeof v === "string" ? v : v?.text ?? v?.name ?? "");

/** recipeInstructions in any of the shapes sites use -> [{ step, text }] and a flat component hint. */
export function flattenInstructions(value) {
  const out = [];
  const walk = (v) => {
    if (!v) return;
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (typeof v === "string") {
      // a single blob: split on numbered steps or paragraphs
      const parts = v.split(/\n+|(?<=[.!?])\s+(?=\d+[.)]\s)/).map((p) => stripTags(p).replace(/^(step\s*)?\d+[.)]\s*/i, "")).filter(Boolean);
      out.push(...parts);
      return;
    }
    if (typeof v === "object") {
      const types = [].concat(v["@type"] ?? []).map(String);
      if (types.includes("HowToSection")) { walk(v.itemListElement); return; }
      if (v.itemListElement) { walk(v.itemListElement); return; }
      const text = stripTags(asText(v));
      if (text) out.push(text.replace(/^(step\s*)?\d+[.)]\s*/i, ""));
    }
  };
  walk(value);
  return out.map((text, i) => ({ step: i + 1, text }));
}

/** A schema.org Recipe node -> the neutral "source recipe" shape the normalizer takes. */
export function sourceFromJsonLd(node, { url = null } = {}) {
  const author = [].concat(node.author ?? []).map((a) => stripTags(asText(a))).filter(Boolean)[0] ?? null;
  const pageUrl = url ?? node.url ?? (typeof node.mainEntityOfPage === "string" ? node.mainEntityOfPage : node.mainEntityOfPage?.["@id"]) ?? null;
  const host = (() => { try { return new URL(pageUrl).hostname.replace(/^www\./, ""); } catch { return null; } })();
  const categories = [].concat(node.recipeCategory ?? []).map(stripTags);
  const keywords = [].concat(node.keywords ?? []).flatMap((k) => String(k).split(",")).map((s) => s.trim());
  return {
    title: stripTags(node.name ?? node.headline ?? ""),
    source_prose: stripTags(node.description ?? ""), // read for course hints only; never copied
    ingredient_lines: [].concat(node.recipeIngredient ?? []).map(stripTags).filter(Boolean),
    sections: null,
    instructions: flattenInstructions(node.recipeInstructions),
    yield: node.recipeYield ?? null,
    prep_min: parseMinutes(node.prepTime), cook_min: parseMinutes(node.cookTime), total_min: parseMinutes(node.totalTime),
    course_hints: [...categories, ...keywords, node.name],
    cuisine: [].concat(node.recipeCuisine ?? []).map(stripTags).filter(Boolean)[0]?.toLowerCase() ?? null,
    author, host, url: pageUrl,
  };
}

const ING_HEAD = /^\s*(ingredients?)\s*:?\s*$/i;
const STEP_HEAD = /^\s*(instructions?|method|directions?|steps?|preparation|how to make it|to make)\s*:?\s*$/i;
const META = {
  yield: /^(serves|servings?|yield|yields|makes)\s*[:\-]?\s*(.+)$/i,
  prep: /^prep(?:aration)?(?: time)?\s*[:\-]?\s*(.+)$/i,
  cook: /^cook(?:ing)?(?: time)?\s*[:\-]?\s*(.+)$/i,
  total: /^total(?: time)?\s*[:\-]?\s*(.+)$/i,
  source: /^(source|from|adapted from|by|author)\s*[:\-]?\s*(.+)$/i,
  course: /^(course|category|type)\s*[:\-]?\s*(.+)$/i,
  cuisine: /^cuisine\s*[:\-]?\s*(.+)$/i,
};
const LOOKS_LIKE_ING = new RegExp(String.raw`^\s*(?:[-*•▢☐]\s*)?(?:${NUM}|[¼½¾⅓⅔⅛⅜⅝⅞]|a pinch|pinch|salt|pepper|a handful|handful|juice of|zest of)`, "i");
const SUBHEAD = /^(for the|for )?[a-z][a-z' ]{1,40}:$/i;

/**
 * Pasted text -> the same neutral shape. Title first, then "Ingredients" and
 * "Instructions" blocks if labelled; otherwise lines that start with a number
 * are ingredients and what follows them is the method. A line like "For the
 * dressing:" starts a new component.
 */
export function sourceFromText(text, { title: forcedTitle = null } = {}) {
  const lines = String(text).replace(/\r/g, "").split("\n").map((l) => l.trim()).filter(Boolean);
  const src = {
    title: forcedTitle, source_prose: "", ingredient_lines: [], sections: [], instructions: [],
    yield: null, prep_min: null, cook_min: null, total_min: null, course_hints: [], cuisine: null,
    author: null, host: null, url: null,
  };

  const body = [];
  for (const l of lines) {
    let m;
    if ((m = META.yield.exec(l))) { src.yield = /^makes\b/i.test(l) ? l : m[2]; continue; }
    if ((m = META.prep.exec(l)) && parseMinutes(m[1]) != null) { src.prep_min = parseMinutes(m[1]); continue; }
    if ((m = META.cook.exec(l)) && parseMinutes(m[1]) != null) { src.cook_min = parseMinutes(m[1]); continue; }
    if ((m = META.total.exec(l)) && parseMinutes(m[1]) != null) { src.total_min = parseMinutes(m[1]); continue; }
    if ((m = META.source.exec(l)) && !LOOKS_LIKE_ING.test(l)) { src.author = m[2].trim(); continue; }
    if ((m = META.course.exec(l))) { src.course_hints.push(m[2]); continue; }
    if ((m = META.cuisine.exec(l))) { src.cuisine = m[1].trim().toLowerCase(); continue; }
    body.push(l);
  }
  if (!src.title) src.title = body.shift() ?? "";

  const ingHead = body.findIndex((l) => ING_HEAD.test(l));
  const stepHead = body.findIndex((l) => STEP_HEAD.test(l));
  let ingLines, stepLines;
  if (ingHead !== -1 && stepHead !== -1) {
    ingLines = ingHead < stepHead ? body.slice(ingHead + 1, stepHead) : body.slice(ingHead + 1);
    stepLines = stepHead > ingHead ? body.slice(stepHead + 1) : body.slice(stepHead + 1, ingHead);
  } else if (ingHead !== -1) {
    const after = body.slice(ingHead + 1);
    const firstStep = after.findIndex((l) => !LOOKS_LIKE_ING.test(l) && !SUBHEAD.test(l) && l.length > 40);
    ingLines = firstStep === -1 ? after : after.slice(0, firstStep);
    stepLines = firstStep === -1 ? [] : after.slice(firstStep);
  } else if (stepHead !== -1) {
    // only the method is labelled: everything above it is ingredients
    ingLines = body.slice(0, stepHead);
    stepLines = body.slice(stepHead + 1);
  } else {
    // no headers: the ingredient block is the run of number-led lines, plus
    // any "For the dressing:" sub-heads immediately above it
    const firstIng = body.findIndex((l) => LOOKS_LIKE_ING.test(l));
    let start = firstIng === -1 ? 0 : firstIng;
    while (start > 0 && SUBHEAD.test(body[start - 1])) start--;
    let end = start;
    while (end < body.length && (LOOKS_LIKE_ING.test(body[end]) || SUBHEAD.test(body[end]))) end++;
    ingLines = body.slice(start, end);
    stepLines = [...body.slice(0, start), ...body.slice(end)];
  }

  let section = { name: "Main", lines: [] };
  const sections = [section];
  for (const l of ingLines) {
    if (SUBHEAD.test(l)) {
      const name = l.replace(/:$/, "").replace(/^for (the )?/i, "").trim();
      section = { name: name.charAt(0).toUpperCase() + name.slice(1), lines: [] };
      sections.push(section);
      continue;
    }
    section.lines.push(l);
  }
  src.sections = sections.filter((s) => s.lines.length);
  src.ingredient_lines = src.sections.flatMap((s) => s.lines);
  src.instructions = stepLines
    .map((l) => l.replace(/^(step\s*)?\d+[.)]\s*/i, "").replace(/^[-*•]\s*/, "").trim())
    .filter((l) => l && !STEP_HEAD.test(l))
    .map((text, i) => ({ step: i + 1, text }));
  src.course_hints.push(src.title);
  return src;
}

// ------------------------------------------------------- normalizing

const snapEighth = (n) => (n == null ? null : Math.round(n * 8) / 8 || Math.round(n * 100) / 100);

const COURSE_PHRASE = {
  soup: "A soup", salad: "A salad", main: "A main dish", side: "A side", breakfast: "A breakfast",
  dessert: "A dessert", snack: "A snack", sauce: "A sauce", appetizer: "A starter", lunch: "A lunch",
};

/** Plain, true, unexciting — written for the review pass to improve, never copied from the source. */
export function draftDescription({ course, headline, total_min, title }) {
  const lead = COURSE_PHRASE[course] ?? "A dish";
  const names = headline.slice(0, 3);
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0];
  const what = list ? `${lead} built around ${list}.` : `${lead}: ${title}.`;
  const when = total_min ? ` Ready in about ${total_min} minutes.` : "";
  return `${what}${when}`;
}

const TELLS = { legume: 4, grain: 4, protein_alt: 4, vegetable: 3, fruit: 3, dairy: 2, egg: 2, nut_seed: 2, prepared: 2, herb: 1, other: 1 };

/**
 * Source recipe -> our template JSON, plus a report of every decision that
 * needs a human.
 *
 * @param source     from sourceFromJsonLd or sourceFromText
 * @param catalog    ingredients.json
 * @param aliases    ingredient-aliases.json
 * @param options    { keepQuantities, acceptSuggestions, map: { "item": "catalog key" }, course, title }
 */
export function normalizeSource(source, { catalog, aliases, options = {} }) {
  const report = { suggestions: [], unknown: [], meat: [], swaps: [], scaled: null, notes: [] };
  const learned = {}; // aliases this import would add, so prepareRecipes resolves the same way
  const animal = [];
  const title = (options.title ?? source.title ?? "").trim();

  const sections = source.sections?.length
    ? source.sections
    : [{ name: "Main", lines: source.ingredient_lines }];

  let instructions = source.instructions.map((s) => ({ ...s }));
  const household_edits = [];

  const components = sections.map((sec) => ({
    name: sec.name,
    ingredients: sec.lines.map((line) => {
      const ing = parseIngredientLine(line, (x) => resolveItem(x, catalog, aliases)?.confident === true);

      // meat broth is the one substitution the collection makes on its own
      if (MEAT_BROTH_RE.test(ing.item)) {
        const original = ing.item;
        const kind = /stock/.test(original) ? "vegetable stock" : "vegetable broth";
        ing.substituted_from = original;
        ing.item = kind;
        household_edits.push({ kind: "substitution", written: ing.raw_text, applied: `${original} -> ${kind}, same quantity.` });
        report.swaps.push(`${original} -> ${kind}`);
        const re = new RegExp(original.replace(/\s+/g, "\\s+"), "gi");
        instructions = instructions.map((s) => ({ ...s, text: s.text.replace(re, kind) }));
      }

      const forced = options.map?.[ing.item];
      let res = forced ? { bases: [forced], form: null, confident: true, via: "map", compound: false } : resolveItem(ing.item, catalog, aliases);
      if (res && !res.confident && !options.acceptSuggestions) {
        report.suggestions.push({ item: ing.item, suggested: res.bases[0], via: res.via, raw: ing.raw_text });
        res = null;
      }
      if (res) {
        if (!aliases[ing.item] && !(catalog[ing.item] && res.bases[0] === ing.item)) {
          learned[ing.item] = { original: ing.item, base_name: res.bases[0], form: res.form, is_compound: !!res.compound, parts: res.compound ? res.bases : [] };
        }
      } else if (!report.suggestions.some((s) => s.item === ing.item)) {
        report.unknown.push({ item: ing.item, raw: ing.raw_text });
      }

      const entry = res ? catalog[res.bases[0]] : null;
      const ap = animalProduct(ing.item, entry);
      if (ap && ap.type !== "meat_broth") {
        if (!animal.some((a) => a.ingredient === ap.ingredient)) animal.push(ap);
        if (ap.type === "meat" || ap.type === "fish") report.meat.push(ing.item);
      }
      return ing;
    }),
  }));

  // course, yield, scale
  const course = options.course ?? inferCourse(source.course_hints, source.source_prose);
  let { yield_text, yield_qty, yield_unit } = parseYield(source.yield);
  const isBatch = BATCH_COURSES.has(course);
  let fixed_yield = false;
  if (yield_qty && yield_unit === "serving" && !isBatch && !options.keepQuantities && yield_qty !== BASE_SERVINGS) {
    const factor = BASE_SERVINGS / yield_qty;
    const UNSCALED = new Set(["pinch", "dash", "splash", "drizzle", "sprinkle", "squeeze", "handful"]);
    for (const c of components) for (const i of c.ingredients) {
      if (UNSCALED.has(i.unit)) continue; // 1¼ pinches is nobody's instruction
      if (i.qty_min != null) i.qty_min = snapEighth(i.qty_min * factor);
      if (i.qty_max != null) i.qty_max = snapEighth(i.qty_max * factor);
    }
    household_edits.push({
      kind: "scale",
      written: yield_text,
      applied: `Scaled ×${Math.round(factor * 100) / 100} to the collection's ${BASE_SERVINGS} servings. Step text may still quote the source's amounts.`,
    });
    report.scaled = { from: yield_qty, to: BASE_SERVINGS, factor };
    yield_text = `${BASE_SERVINGS} servings`; yield_qty = BASE_SERVINGS; yield_unit = "serving";
  } else if (yield_qty && (isBatch || yield_unit !== "serving")) {
    fixed_yield = true; // a tray of cookies keeps its own count
  }

  // headline ingredients for the drafted description
  const scored = [];
  for (const c of components) for (const i of c.ingredients) {
    const r = resolveItem(i.item, catalog, { ...aliases, ...learned });
    const e = r?.confident ? catalog[r.bases[0]] : null;
    if (!e || e.is_pantry) continue;
    let score = TELLS[e.category] ?? 1;
    if (e.name.split(/[\s-]+/).some((w) => w.length > 3 && title.toLowerCase().includes(w))) score += 5;
    scored.push([e.name, score]);
  }
  const headline = [...new Map(scored.sort((a, b) => b[1] - a[1])).keys()];

  const review = [];
  review.push("Imported — description drafted from the ingredient list; rewrite it in review.");
  if (!course) review.push("Course could not be inferred — set it.");
  if (report.scaled) review.push(`Rescaled from ${report.scaled.from} servings; check step text for the source's amounts.`);
  if (report.meat.length) review.push(`Contains ${report.meat.join(", ")} — decide the vegetarian version or exclude.`);
  const noQty = components.flatMap((c) => c.ingredients).filter((i) => i.qty_min == null && !i.to_taste);
  if (noQty.length) review.push(`No quantity given for: ${noQty.map((i) => i.item).join(", ")}.`);

  const attribution = source.author && source.host ? `${source.author} (${source.host})` : source.author ?? source.host ?? null;

  const recipe = {
    title,
    description: draftDescription({ course, headline, total_min: source.total_min ?? ((source.prep_min ?? 0) + (source.cook_min ?? 0) || null), title }),
    source_attribution: attribution,
    source_url: source.url ?? null,
    yield_text, yield_qty, yield_unit,
    ...(fixed_yield ? { fixed_yield: true } : {}),
    prep_min: source.prep_min ?? null, cook_min: source.cook_min ?? null,
    total_min: source.total_min ?? ((source.prep_min ?? 0) + (source.cook_min ?? 0) || null),
    course, cuisine: source.cuisine ?? null,
    components,
    instructions,
    method_source: instructions.length ? "transcribed" : "none",
    notes: null,
    animal_products: animal,
    household_edits,
    confidence: report.unknown.length || report.meat.length ? "medium" : "high",
    review_notes: review.join(" "),
    pages: [],
    imported_from: source.url ?? "text",
  };

  return { recipe, report, learned };
}
