/**
 * Build the static site.
 *
 * No database and no server. The whole dataset is 1.7 MB; standing up
 * Postgres to serve read-only data that fits in a file would be pure ceremony.
 * Supabase earns its place at Phase 3, when accounts arrive and there is
 * actually per-user state to keep.
 *
 * Every recipe is written out as a real HTML file at its own path, with the
 * full recipe already in the markup and schema.org JSON-LD alongside it. A
 * crawler — or a language model — gets the whole thing from the response
 * without running any JavaScript. The app then takes over for navigation.
 *
 *   node build-site.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { DATA, PROJECT, readJson, writeJson } from "./lib/config.mjs";

import { recipeHtml, recipeJsonLd, recipePath, esc } from "./lib/recipe-html.mjs";
import { head, sitemap, robots, llmsTxt, recipeDescription, ORIGIN, PITCH, TAGLINE, FREE_LINE } from "./lib/seo.mjs";

/** Project .env — supplies the public Supabase config for the client build. */
const env = Object.fromEntries(
  (fs.existsSync(path.resolve(PROJECT, ".env"))
    ? fs.readFileSync(path.resolve(PROJECT, ".env"), "utf8").split(/\r?\n/)
    : [])
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, "site");
const OUT = path.join(PROJECT, "site");
const LOGO = PROJECT;

const recipes = readJson(path.join(DATA, "recipes.json"), []);
const catalog = readJson(path.join(DATA, "ingredients.json"), {});
// data/staples.json is one household's real weekly shop, and the CLI reads it
// from there. It must never ship: staples are per-account, so a stranger's
// first visit would otherwise hand them somebody else's peanut butter — and
// put a private note ("the big plain ones") on a public endpoint. The site
// gets suggestions anyone would recognise; the real list lives in Supabase.
const STAPLE_SUGGESTIONS = [
  { item: "Bananas", qty: 6, unit: "", aisle: "produce" },
  { item: "Oat milk", qty: 1, unit: "carton", aisle: "dairy" },
  { item: "Peanut butter", qty: 1, unit: "jar", aisle: "pantry" },
  { item: "Olive oil", qty: 1, unit: "bottle", aisle: "pantry" },
  { item: "Coffee", qty: 1, unit: "bag", aisle: "pantry" },
  { item: "Bread", qty: 1, unit: "loaf", aisle: "bakery" },
];
if (!recipes.length) throw new Error("no recipes — run the pipeline first");

// Clear the contents rather than the directory itself. On Windows, removing
// a directory any shell has as its cwd fails with EPERM — and a build that
// dies here while the deploy still succeeds ships stale content, which is
// exactly what happened once. Deleting the children avoids the lock.
for (const entry of fs.existsSync(OUT) ? fs.readdirSync(OUT) : []) {
  fs.rmSync(path.join(OUT, entry), { recursive: true, force: true });
}
fs.mkdirSync(path.join(OUT, "data", "recipes"), { recursive: true });
fs.mkdirSync(path.join(OUT, "lib"), { recursive: true });

for (const f of fs.readdirSync(SRC)) fs.copyFileSync(path.join(SRC, f), path.join(OUT, f));
// the browser imports the same modules the build does — never a second copy
for (const f of ["units.mjs", "grocery.mjs", "recipe-html.mjs", "servings.mjs", "seo.mjs", "shop.mjs", "supabase.mjs", "node-shim.mjs"]) {
  fs.copyFileSync(path.join(here, "lib", f), path.join(OUT, "lib", f));
}


// account.mjs carries the project URL and the ANON key. Both are public by
// design — the anon key is meant to ship to browsers and every table is
// row-level secured. The service-role key must never come near this build.
const supaUrl = (env.SUPABASE_URL ?? "").trim();
const supaAnon = (env.SUPABASE_ANON_KEY ?? "").trim();
if (supaAnon.includes("service_role")) throw new Error("refusing to publish a service-role key");
fs.writeFileSync(
  path.join(OUT, "lib", "account.mjs"),
  fs.readFileSync(path.join(here, "lib", "account.mjs"), "utf8")
    .replace("__SUPABASE_URL__", supaUrl)
    .replace("__SUPABASE_ANON_KEY__", supaAnon),
  "utf8",
);
console.log(supaUrl ? "  accounts: configured" : "  accounts: NOT configured (no SUPABASE_URL) — app still works signed out");

// ---------------------------------------------------------------- index

const published = recipes.filter((r) => !r.excluded);
const catById = new Map(Object.values(catalog).map((c) => [c.id, c]));

const empty = published.filter((r) => r.components.flatMap((c) => c.ingredients).length === 0);
if (empty.length) {
  console.error(`\n${empty.length} recipe(s) have no ingredients — almost certainly orphaned continuation pages:\n`);
  for (const r of empty) console.error(`  ${r.id}  ${r.title}`);
  console.error("\nFind the page they belong to and merge, or mark them excluded. Not building.");
  process.exit(1);
}

// A recipe whose lines carry no canonical ingredient never went through
// 7-normalize. It still renders, so nothing looks wrong — but it contributes
// nothing to a grocery list and nothing to the ingredient filter, which is
// the entire point of the normalization layer. Editing recipes.json (or
// re-running r2-merge) and forgetting to normalize afterwards is the easy way
// to cause this, so fail loudly rather than publish a recipe that can't shop.
const unnormalized = published.filter((r) => {
  const lines = r.components.flatMap((c) => c.ingredients);
  return lines.length > 0 && lines.every((i) => !(i.canonical ?? []).length);
});
if (unnormalized.length) {
  console.error(`\n${unnormalized.length} recipe(s) have no canonical ingredients — 7-normalize has not run since they were added:\n`);
  for (const r of unnormalized.slice(0, 10)) console.error(`  ${r.id}  ${r.title}`);
  console.error("\nRun: node 7-normalize.mjs   (cached alias/catalog — no API spend). Not building.");
  process.exit(1);
}

// A substitution has to land in every place the meat was named. It used to be
// two (ingredients, method); pre-rendering made the description a third, and
// seven recipes shipped as "vegan" while describing ground beef and ham.
// Refuse to build rather than publish that again.
const NAMES_MEAT = /\b(ground beef|beef|bacon|ham|sausage|chicken|pork|turkey|anchovy|anchovies|lard)\b/i;
const QUALIFIED = /(plant-based|vegetarian|vegan|meatless|tempeh|smoked tofu|instead of|stands? in for|-free)/i;
const stale = published.filter((r) => {
  const d = r.description ?? "";
  return NAMES_MEAT.test(d) && !QUALIFIED.test(d);
});
if (stale.length) {
  console.error(`\n${stale.length} description(s) name meat the recipe no longer contains:\n`);
  for (const r of stale) console.error(`  ${r.id}  ${r.title}\n      ${r.description}`);
  console.error("\nA substitution must reach the ingredients, the method AND the description.");
  console.error("The description is the page's meta description — this is what search indexes. Not building.");
  process.exit(1);
}

/**
 * The two or three ingredients that tell you what a dish actually is.
 * Source order puts dressings first, so rank by how much the ingredient
 * identifies the dish: what it's built on first, seasonings last.
 */
const TELLS = {
  grain: 10, legume: 9, protein_alt: 9, vegetable: 8, prepared: 8, fruit: 7,
  nut_seed: 5, dairy: 4, egg: 4, herb: 2,
  condiment: 1, sweetener: 1, baking: 1, oil: 0, vinegar: 0, spice: 0, beverage: 0, other: 1,
};
const ACCOMPANIMENT = /\b(bun|roll|bread|tortilla|pita|naan|chip|cracker|ice cream|whipped cream|crust|shell|wrap|garnish)\b/i;

function headline(r) {
  const seen = new Map();
  for (const ing of r.components.flatMap((c) => c.ingredients)) {
    const c = catById.get((ing.canonical ?? [])[0]);
    if (!c || c.is_pantry) continue;
    let score = (TELLS[c.category] ?? 1) + (ing.qty_g ? Math.min(ing.qty_g / 400, 2) : 0);
    if (ACCOMPANIMENT.test(c.name)) score *= 0.25;
    const title = r.title.toLowerCase();
    if (c.name.split(/[\s-]+/).some((w) => w.length > 3 && title.includes(w))) score += 5;
    if (!seen.has(c.name) || seen.get(c.name) < score) seen.set(c.name, score);
  }
  return [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n]) => n);
}

const index = published.map((r) => {
  const ingredients = r.components.flatMap((c) => c.ingredients);
  return {
    headline: headline(r),
    id: r.id,
    slug: r.slug,
    url: recipePath(r),
    title: r.title,
    description: r.description,
    course: r.course,
    cuisine: r.cuisine,
    total_min: r.total_min ?? r.prep_min ?? null,
    yield_text: r.yield_text,
    yield_qty: r.yield_qty ?? null,
    // the planner reads both of these from the index, before it fetches any
    // recipe detail, so they have to travel with the listing
    fixed_yield: r.fixed_yield === true,
    keeps_well: r.keeps_well !== false,
    keeps_note: r.keeps_note ?? null,
    is_vegan: r.is_vegan,
    n_ingredients: ingredients.length,
    n_steps: r.instructions.length,
    ing: [...new Set(ingredients.flatMap((i) => i.canonical ?? []))],
    q: [r.title, r.description, r.course, r.cuisine, ...ingredients.map((i) => i.item)]
      .filter(Boolean).join(" ").toLowerCase(),
  };
});

writeJson(path.join(OUT, "data", "index.json"), index);
for (const r of published) {
  const { pages, review_notes, approved_note, approved_by, ...publishable } = r;
  // `raw_text` is what the original card said, and on the twenty-odd
  // substituted recipes it still says "1 lb ground beef" or "ham bone". It is
  // real provenance and stays in data/recipes.json — but publishing it puts
  // meat in the JSON of a site that promises every recipe is vegetarian, and
  // llms.txt actively invites machines to read exactly these files. Nothing
  // on the client needs it since the grocery list stopped using it.
  publishable.components = publishable.components.map((c) => ({
    ...c,
    ingredients: c.ingredients.map(({ raw_text, ...i }) => i),
  }));
  writeJson(path.join(OUT, "data", "recipes", `${r.id}.json`), publishable);
}
writeJson(path.join(OUT, "data", "ingredients.json"), catalog);
writeJson(path.join(OUT, "data", "staples.json"), { items: [], suggestions: STAPLE_SUGGESTIONS });

const usage = new Map();
for (const r of index) for (const id of r.ing) usage.set(id, (usage.get(id) ?? 0) + 1);
writeJson(path.join(OUT, "data", "filters.json"), {
  ingredients: [...usage.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1])
    .map(([id, n]) => ({ id, name: catById.get(id)?.name ?? id, aisle: catById.get(id)?.aisle, count: n })),
  courses: [...new Set(index.map((r) => r.course).filter(Boolean))].sort(),
  cuisines: [...new Set(index.map((r) => r.cuisine).filter(Boolean))].sort(),
});

// ------------------------------------------------------------ page shell

const shell = fs.readFileSync(path.join(SRC, "index.html"), "utf8");
const BODY_MARK = "<!--APP-->";

/** Wrap rendered markup in the shared chrome. */
function page({ title, description, path: p, jsonLd, article, noindex, body }) {
  return shell
    .replace("<!--HEAD-->", head({ title, description, path: p, jsonLd, article, noindex }))
    .replace(BODY_MARK, body ?? "");
}

// the shell itself, for browse / plan / staples
fs.writeFileSync(path.join(OUT, "index.html"), page({
  title: "VegBatch — free vegetarian & vegan meal planning",
  description: PITCH,
  path: "/",
  body: `<div class="hero">
      <h1>${esc(TAGLINE)}</h1>
      <p>${esc(PITCH)} <b>${index.length} recipes</b>, ${index.filter((r) => r.is_vegan).length} of them vegan. ${FREE_LINE}</p>
    </div>`,
}), "utf8");

// The app's own routes get REAL FILES, not _redirects rewrites.
//
// Two rounds of getting this wrong: `/plan /index.html 200` made Pages
// canonicalise the destination and 308 to the homepage, so refreshing on
// your shopping list dropped you on Browse. Pointing the rewrite at
// /app-shell.html instead just moved the 308 to /app-shell. Cloudflare
// normalises an .html destination either way, and a normalised rewrite
// becomes a redirect.
//
// Writing plan.html and letting Pages serve it at /plan is the same trick
// that fixed the recipe pages: a bare .html file is served at the
// extensionless path with a 200 and no redirect anywhere. No rewrite rules,
// so /404.html still catches everything genuinely unknown.
//
// Empty body and noindex: these pages are built entirely by the client and
// have nothing a crawler should see.
const APP_ROUTES = ["plan", "staples", "account", "history", "feedback"];
for (const route of APP_ROUTES) {
  fs.writeFileSync(path.join(OUT, `${route}.html`), page({
    title: "VegBatch",
    description: PITCH,
    path: `/${route}`,
    noindex: true,
  }), "utf8");
}

// A real 404. Until now every unmatched path returned the shell with a 200,
// so a mistyped or stale recipe URL told the crawler "this is fine" — a soft
// 404. Search engines treat that as a quality problem, and with 254 recipe
// URLs there is plenty of surface for a stale link.
fs.writeFileSync(path.join(OUT, "404.html"), page({
  title: "Not found | VegBatch",
  description: "That page doesn't exist.",
  path: "/404",
  noindex: true,
  body: `<div class="hero">
      <h1>That recipe isn't here</h1>
      <p>The link may be old, or mistyped. Every recipe is on the
      <a href="/">main list</a> — there are ${index.length} of them.</p>
    </div>`,
}), "utf8");

// --------------------------------------------------- pre-rendered recipes

// Written as `r/<id>-<slug>.html`, NOT `r/<id>-<slug>/index.html`.
//
// Cloudflare Pages serves a directory's index.html only at the trailing-slash
// URL and 308s the bare path to it. Everything else here — recipePath(), the
// canonical tag, the sitemap, every internal link — uses the bare path, so
// with the directory layout all 254 recipes 308'd, and each page declared a
// canonical URL that was itself a redirect. Search Console reports that as
// "Page with redirect" and does not index the submitted URL.
//
// A bare `.html` file is served at the extensionless path with a 200, which
// makes the served URL, the canonical and the sitemap finally agree.
//
// This did not show up in testing because the test read the built FILE and
// the file was always correct. Same lesson as verify-live: a file being right
// is not evidence a response is right.
let pages = 0;
fs.mkdirSync(path.join(OUT, "r"), { recursive: true });
for (const r of published) {
  fs.writeFileSync(path.join(OUT, "r", `${r.id}-${r.slug}.html`), page({
    title: `${r.title} — ${r.is_vegan ? "vegan" : "vegetarian"} recipe | VegBatch`,
    description: recipeDescription(r),
    path: recipePath(r),
    jsonLd: recipeJsonLd(r, ORIGIN),
    article: true,
    body: recipeHtml(r),
  }), "utf8");
  pages++;
}

// ------------------------------------------------------------------ PWA
// The cache name carries the build id, so a deploy invalidates everything
// cleanly. Without that, cache-first would serve last month's recipes.

const BUILD = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
// "/index.html" is deliberately absent: Cloudflare canonicalises it to "/"
// and serves a 308, so caching it always failed. Harmless — the install adds
// entries individually so one failure can't sink it, and "/" is the same
// document — but a precache entry that can never succeed is just a guaranteed
// miss on every install. verify-live now checks every entry returns 200.
const PRECACHE = [
  "/", "/app.js", "/styles.css",
  "/lib/grocery.mjs", "/lib/units.mjs", "/lib/recipe-html.mjs", "/lib/servings.mjs", "/lib/seo.mjs", "/lib/shop.mjs",
  "/data/index.json", "/data/filters.json", "/data/ingredients.json", "/data/staples.json",
  "/icon-192.png", "/logo.png", "/site.webmanifest",
];
fs.writeFileSync(
  path.join(OUT, "sw.js"),
  fs.readFileSync(path.join(SRC, "sw.js"), "utf8")
    .replace("__BUILD__", BUILD)
    .replace("__PRECACHE__", JSON.stringify(PRECACHE, null, 2)),
  "utf8",
);

// ------------------------------------------------------ machine-readable

fs.writeFileSync(path.join(OUT, "sitemap.xml"), sitemap(published), "utf8");
fs.writeFileSync(path.join(OUT, "robots.txt"), robots(), "utf8");
fs.writeFileSync(path.join(OUT, "llms.txt"), llmsTxt(published), "utf8");
// SPA fallback for the two routes that have no pre-rendered file
// No _redirects file at all. Every route the app serves now has a real file
// behind it (index.html, <route>.html, r/<slug>.html), and 404.html catches
// the rest. Rewrite rules only reintroduced the redirect they were meant to
// avoid — see the APP_ROUTES comment above.
writeJson(path.join(OUT, "site.webmanifest"), {
  name: "VegBatch", short_name: "VegBatch", start_url: "/", display: "standalone",
  background_color: "#faf8f5", theme_color: "#186048",
  description: PITCH,
  icons: [
    { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
  ],
});

// ------------------------------------------------------------- artwork

const icon = path.join(LOGO, "logoicontrans.png");
const wordmark = path.join(LOGO, "logovegbatch.png");

if (fs.existsSync(icon)) {
  for (const size of [32, 192, 512]) {
    await sharp(icon).resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png().toFile(path.join(OUT, `icon-${size}.png`));
  }
  // iOS ignores transparency and composites on black, so this one gets a ground
  await sharp(icon).resize(160, 160, { fit: "contain", background: { r: 255, g: 255, b: 255, alpha: 0 } })
    .extend({ top: 10, bottom: 10, left: 10, right: 10, background: "#ffffff" })
    .flatten({ background: "#ffffff" }).png().toFile(path.join(OUT, "apple-touch-icon.png"));
}
if (fs.existsSync(wordmark)) {
  await sharp(wordmark).resize({ width: 560 }).png({ quality: 90 }).toFile(path.join(OUT, "logo.png"));

  // Social / AI preview card. The wordmark is dark green, so it goes on the
  // site's own cream ground — on the brand green it was nearly invisible.
  const caption = Buffer.from(`<svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg">
      <style>
        .t { fill:#186048; font-family: 'Segoe UI', Roboto, Helvetica, sans-serif; font-weight:700; font-size:52px; }
        .s { fill:#6d6660; font-family: 'Segoe UI', Roboto, Helvetica, sans-serif; font-size:30px; }
      </style>
      <rect x="0" y="0" width="1200" height="14" fill="#186048"/>
      <rect x="0" y="616" width="1200" height="14" fill="#f0a830"/>
      <text x="600" y="438" text-anchor="middle" class="t">${esc(TAGLINE)}</text>
      <text x="600" y="496" text-anchor="middle" class="s">${index.length} free vegetarian &amp; vegan recipes · no account</text>
    </svg>`);
  const mark = await sharp(wordmark).resize({ width: 720 }).toBuffer();
  await sharp({ create: { width: 1200, height: 630, channels: 4, background: "#faf8f5" } })
    .composite([{ input: mark, top: 175, left: 240 }, { input: caption, top: 0, left: 0 }])
    .png().toFile(path.join(OUT, "og.png"));
}

// ---------------------------------------------------------------- report

const size = (dir) => fs.readdirSync(dir, { withFileTypes: true }).reduce((s, e) => {
  const p = path.join(dir, e.name);
  return s + (e.isDirectory() ? size(p) : fs.statSync(p).size);
}, 0);

console.log(`\nsite built -> ${OUT}`);
console.log(`  ${index.length} recipes · ${pages} pre-rendered pages at real paths`);
console.log(`  sitemap.xml, robots.txt, llms.txt, site.webmanifest`);
console.log(`  icons + og.png from the logo`);
console.log(`  index.json ${(fs.statSync(path.join(OUT, "data", "index.json")).size / 1024).toFixed(0)} KB`);
console.log(`  total ${(size(OUT) / 1024 / 1024).toFixed(1)} MB`);
console.log(`\n  preview:  node serve-site.mjs`);
