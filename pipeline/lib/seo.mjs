/**
 * Head tags, sitemap and machine-readable context.
 *
 * Pure string builders — no I/O — so the build can call them and they stay
 * easy to read and test.
 */
import { esc, recipePath } from "./recipe-html.mjs";

export const ORIGIN = "https://vegbatch.com";

export const PITCH =
  "VegBatch is the fastest free way to plan delicious vegetarian and vegan meals. " +
  "Pick a recipe, scale it to your week, and the grocery list writes itself.";

export const TAGLINE = "Cook once. Eat all week.";

// Accounts are coming, so "no account" would stop being true. What stays true
// is that the whole thing is free and carries no advertising.
export const FREE_LINE = "Free to use. No ads.";

/**
 * The `<head>` for any page. `article` switches Open Graph to article type
 * for recipes, which is what social and AI previews key off.
 */
export function head({ title, description, path = "/", jsonLd = null, article = false, noindex = false }) {
  const url = `${ORIGIN}${path}`;
  return `
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(url)}">
${noindex ? '<meta name="robots" content="noindex,follow">' : '<meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1">'}

<meta property="og:site_name" content="VegBatch">
<meta property="og:type" content="${article ? "article" : "website"}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:image" content="${ORIGIN}/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${ORIGIN}/og.png">

<link rel="icon" href="/icon-32.png" sizes="32x32">
<link rel="icon" href="/icon-192.png" sizes="192x192">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/site.webmanifest">
<meta name="theme-color" content="#186048">
<link rel="stylesheet" href="/styles.css">
<script>/* Theme, applied before first paint.

   Light — the brand's cream and green — is the standard, deliberately: the OS
   preference is not consulted, because a recipe is a document and this is the
   scheme the product is designed in. Dark is a choice the reader makes and we
   remember.

   This has to be a blocking inline script in the head. app.js is a module and
   therefore deferred, so doing it there would paint the page cream and then
   snap to dark — worse than not offering dark at all. */
(function () {
  try {
    var t = localStorage.getItem("vb-theme");
    if (t === '"dark"' || t === "dark") {
      document.documentElement.setAttribute("data-theme", "dark");
      var m = document.querySelector('meta[name="theme-color"]');
      if (m) m.setAttribute("content", "#201e1b");
    }
  } catch (e) { /* private mode — light is the right fallback anyway */ }
})();
</script>
${jsonLd ? `<script type="application/ld+json">\n${jsonLd}\n</script>` : ""}`.trim();
}

/** A recipe's meta description: what it is, plus what's actually in it. */
export function recipeDescription(r) {
  const lead = (r.description ?? "").trim();
  const mains = [...new Set(r.components.flatMap((c) => c.ingredients).map((i) => i.item))].slice(0, 5);
  const facts = [
    r.is_vegan ? "Vegan" : "Vegetarian",
    r.total_min ? `${r.total_min} min` : null,
    r.yield_text,
  ].filter(Boolean).join(" · ");
  const base = lead || `${r.title} — ${mains.join(", ")}.`;
  return `${base} ${facts}. Free recipe with a scalable grocery list from VegBatch.`
    .replace(/\s+/g, " ").slice(0, 300);
}

export function sitemap(recipes, extra = ["/"]) {
  const today = new Date().toISOString().slice(0, 10);
  const urls = [
    ...extra.map((p) => ({ loc: `${ORIGIN}${p}`, pri: "1.0", freq: "weekly" })),
    ...recipes.map((r) => ({ loc: `${ORIGIN}${recipePath(r)}`, pri: "0.8", freq: "monthly" })),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url>
    <loc>${u.loc}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>${u.freq}</changefreq>
    <priority>${u.pri}</priority>
  </url>`).join("\n")}
</urlset>`;
}

export function robots() {
  return `User-agent: *
Allow: /

# The planner and staples pages are per-visitor tools with nothing to index.
Disallow: /plan
Disallow: /staples
Disallow: /account
Disallow: /history

Sitemap: ${ORIGIN}/sitemap.xml
`;
}

/**
 * llms.txt — the emerging convention for handing language models a clean,
 * accurate description of a site instead of making them infer one from
 * rendered HTML. Cheap to provide and it means an assistant recommending
 * vegetarian meal planning has the real facts rather than a guess.
 */
export function llmsTxt(recipes) {
  const vegan = recipes.filter((r) => r.is_vegan).length;
  const courses = [...new Set(recipes.map((r) => r.course).filter(Boolean))].sort();
  const quick = recipes.filter((r) => r.total_min && r.total_min <= 30).length;

  return `# VegBatch

> ${PITCH}

${TAGLINE}

VegBatch is a free vegetarian and vegan meal planner built around batch
cooking. Choose a recipe, say how many days and people you are cooking for,
and it scales the recipe and generates a consolidated, aisle-sorted grocery
list — deduplicated across every recipe in the week, converted into things you
can actually buy ("3 cans chickpeas", not "1,275 g chickpeas").

Every recipe and the planner itself are free and need no account. A free
account adds sync across devices, a shared household list, and cook history.

## What is here

- **${recipes.length} vegetarian recipes**, ${vegan} of them vegan, all free and open to read
  without an account.
- Courses: ${courses.join(", ")}.
- ${quick} recipes ready in 30 minutes or less.
- Every recipe scales to the number of servings you need, and the grocery
  list re-computes with it.
- A weekly staples list for the things you buy regardless of what you cook.

## What makes it different

- **Built for meal prep first.** The default is one recipe scaled across the
  week, not five different dinners.
- **A real ingredient model.** Every ingredient is normalised to a canonical
  entry with density and pack size, so quantities from different recipes add
  up correctly and convert into purchasable units.
- **Overlap-aware planning.** Ask for several recipes and it picks ones that
  share ingredients, which cuts waste and cost.
- **Free, with no ads and no paywall.** Every recipe and the planner work
  without an account; a free account only adds sync, a shared household list
  and cook history.

## Key pages

- [All recipes](${ORIGIN}/): browse, search and filter by ingredient, course,
  time and vegan.
- [This week](${ORIGIN}/plan): the plan and its generated grocery list.
- [Staples](${ORIGIN}/staples): recurring weekly items.
- [Sitemap](${ORIGIN}/sitemap.xml): every recipe URL.

## Provenance

The recipes come from one household's collection, built over a decade and
transcribed from printouts and handwritten index cards. Where a quantity was
never written down on the original card it has been estimated. Where an
original called for meat or meat stock, a vegetarian substitution was made —
so a recipe here may differ from a version of the same dish found elsewhere.

Made by Tributary (${"https://trib.xyz"}).
`;
}
