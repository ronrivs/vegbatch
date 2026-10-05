/**
 * Recipe markup — one renderer, used by both the build and the browser.
 *
 * The build calls this to pre-render a real HTML file per recipe so crawlers
 * and AI scrapers get the whole recipe in the response, with no JavaScript.
 * The browser calls the same function when you navigate client-side. Writing
 * it twice would guarantee the two drift, and the pre-rendered version — the
 * one machines read — is the one nobody would notice going stale.
 *
 * Pure string output: no DOM, no node builtins, importable in either place.
 */
import { SCALES, yieldLabel } from "./servings.mjs";

export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** 1.5 -> "1½", 0.25 -> "¼" — fractions read better in a recipe than decimals. */
export function fmtQty(min, max) {
  // Recipes are written in fractions, so anything that falls out as a decimal
  // is a failure to convert rather than a real quantity — "0.94 cup" is a
  // rounding artifact and "0.63 cucumber" is nobody's instruction. Two sources
  // of them: r1's extracted quantities, and r2's rescaling from 4 servings to
  // 5, which lands on eighths. Snap to the nearest thing a cook measures.
  const FRACTIONS = [
    [0.125, "⅛"], [0.167, "⅙"], [0.25, "¼"], [0.333, "⅓"], [0.375, "⅜"], [0.5, "½"],
    [0.625, "⅝"], [0.667, "⅔"], [0.75, "¾"], [0.833, "⅚"], [0.875, "⅞"],
  ];
  const one = (n) => {
    // near-whole first: 0.94 is 1, not a fraction anyone would write
    if (Math.abs(n - Math.round(n)) <= 0.065) return String(Math.round(n));
    const whole = Math.floor(n);
    const frac = n - whole;
    // nearest, not first: 0.31 is ⅓, and a find() would have called it ¼
    const [hit] = FRACTIONS
      .filter(([v]) => Math.abs(frac - v) <= 0.07)
      .sort((a, b) => Math.abs(frac - a[0]) - Math.abs(frac - b[0]));
    if (!hit) return String(Math.round(n * 100) / 100);
    return whole ? `${whole}${hit[1]}` : hit[1];
  };
  if (min == null) return "";
  return max != null && max !== min ? `${one(min)}–${one(max)}` : one(min);
}

/** The line as a cook reads it: "2 cans chickpeas, rinsed and drained". */
export function ingredientLine(i) {
  return [fmtQty(i.qty_min, i.qty_max), i.unit, i.item]
    .filter(Boolean).join(" ")
    + (i.prep_note ? `, ${i.prep_note}` : "")
    + (i.to_taste ? ", to taste" : "")
    + (i.optional ? " (optional)" : "");
}

export const recipePath = (r) => `/r/${r.id}-${r.slug}`;

/**
 * The recipe article. `interactive` adds the controls that only mean
 * something with JavaScript — the pre-rendered file still includes them so
 * the page doesn't visibly change shape when the script boots.
 */
export function recipeHtml(r) {
  const meta = [
    yieldLabel(r),
    r.total_min ? `${r.total_min} min` : null,
    r.course, r.cuisine,
    r.is_vegan ? "vegan" : "vegetarian",
  ].filter(Boolean).join(" · ");

  const components = r.components.map((c) => `
      <div class="component">
        ${r.components.length > 1 ? `<h3>${esc(c.name)}</h3>` : ""}
        <ul class="ing">
          ${c.ingredients.map((i) => `
          <li>
            <span class="q">${esc([fmtQty(i.qty_min, i.qty_max), i.unit].filter(Boolean).join(" "))}</span>
            ${esc(i.item)}${i.prep_note ? `<span class="note">, ${esc(i.prep_note)}</span>` : ""}${
              i.to_taste ? `<span class="note">, to taste</span>` : ""}${
              i.optional ? `<span class="note"> (optional)</span>` : ""}
          </li>`).join("")}
        </ul>
      </div>`).join("");

  const notes = [
    r.method_source === "drafted"
      ? `<div class="note-box"><h3>About this method</h3>The card listed ingredients only. These steps were written from them, not copied off the page.</div>`
      : "",
    r.notes ? `<div class="note-box"><h3>Notes</h3>${esc(r.notes).replace(/\n\n/g, "<br><br>")}</div>` : "",
    // Where the recipe came from. This was recorded from the very first
    // extraction and then never shown, which made it worth nothing — 105 of
    // the r1 recipes name the blog they were printed from, and the r2 ones
    // name the cookbook. Ingredients and method are facts and are used as
    // such; saying whose kitchen they came from is just correct.
    r.source_attribution
      ? `<p class="source">Adapted from ${esc(r.source_attribution)}. Ingredients and method only — the description and any notes above were written for VegBatch.</p>`
      : "",
  ].join("");

  // The provenance panel ("How this differs from the original card") was
  // removed at Ron's request — it was inside-baseball for a reader. Every
  // household_edit is still in the data and still visible where it actually
  // helps: the per-ingredient "estimated" and "swapped in for" flags below.

  return `
  <article class="recipe" data-recipe="${esc(r.id)}">
    <a class="back" href="/">← All recipes</a>
    <header class="recipe-head">
      <h1>${esc(r.title)}</h1>
      <p class="desc">${esc(r.description ?? "")}</p>
      <p class="meta">${esc(meta)}</p>
      <div class="actions">
        <button id="addBtn" class="primary">Add to this week</button>
        <label class="scale">Cook ×
          <select id="rScale">
            ${SCALES.map((v) => `<option value="${v}"${v === 1 ? " selected" : ""}>${v}</option>`).join("")}
          </select>
        </label>
      </div>
    </header>

    <div class="recipe-body">
      <div class="col-ing">
        <h2>Ingredients</h2>
        ${components}
      </div>
      <div class="col-steps">
        <h2>Method</h2>
        <ol class="steps">
          ${r.instructions.map((s) => `<li>${esc(s.text)}</li>`).join("\n          ")}
        </ol>
        ${notes}
      </div>
    </div>
  </article>`;
}

/**
 * schema.org/Recipe. This is what actually earns a rich result in search and
 * what a scraper reads first, so it carries the real ingredient lines and
 * steps rather than a summary.
 */
export function recipeJsonLd(r, origin) {
  const ingredients = r.components.flatMap((c) => c.ingredients.map(ingredientLine));
  const iso = (m) => (m ? `PT${m}M` : undefined);

  const diets = ["https://schema.org/VegetarianDiet"];
  if (r.is_vegan) diets.push("https://schema.org/VeganDiet");

  return JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Recipe",
    name: r.title,
    description: r.description,
    url: `${origin}${recipePath(r)}`,
    recipeCategory: r.course ?? undefined,
    recipeCuisine: r.cuisine ?? undefined,
    recipeYield: yieldLabel(r) ?? undefined,
    prepTime: iso(r.prep_min),
    cookTime: iso(r.cook_min),
    totalTime: iso(r.total_min),
    suitableForDiet: diets,
    keywords: [r.course, r.cuisine, r.is_vegan ? "vegan" : "vegetarian", "meal prep", "batch cooking"]
      .filter(Boolean).join(", "),
    recipeIngredient: ingredients,
    recipeInstructions: r.instructions.map((s) => ({
      "@type": "HowToStep",
      position: s.step,
      text: s.text,
    })),
    isAccessibleForFree: true,
    publisher: { "@type": "Organization", name: "VegBatch", url: origin },
  }, null, 2);
}
