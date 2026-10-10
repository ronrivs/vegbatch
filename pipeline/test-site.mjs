/**
 * Smoke test for the web app.
 *
 * Drives the real built site in jsdom against the preview server: browse,
 * filter, open a recipe, plan a week, generate the list. Also checks the
 * thing that matters most — that the browser's grocery list is identical to
 * the CLI's, because they share lib/grocery.mjs and any divergence means the
 * sharing has quietly broken.
 *
 *   node serve-site.mjs &   node test-site.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { JSDOM, VirtualConsole } from "jsdom";
import { PROJECT, DATA, readJson } from "./lib/config.mjs";
import { buildList } from "./lib/grocery.mjs";
import { BASE_SERVINGS, SCALES, isBatch, yieldLabel, keepsForAWeek } from "./lib/servings.mjs";

const SITE = path.join(PROJECT, "site");
const BASE = "http://localhost:4174";

let pass = 0, fail = 0;
const t = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

console.log("\nweb app smoke test\n");

// --- 1. the build produced what the app asks for
for (const f of ["index.html", "app.js", "styles.css", "lib/grocery.mjs", "lib/units.mjs",
                 "data/index.json", "data/filters.json", "data/ingredients.json", "data/staples.json"]) {
  t(`built ${f}`, fs.existsSync(path.join(SITE, f)));
}
const idx = readJson(path.join(SITE, "data", "index.json"), []);
t("index has recipes", idx.length > 200, `${idx.length}`);
t("every indexed recipe has a detail file",
  idx.every((r) => fs.existsSync(path.join(SITE, "data", "recipes", `${r.id}.json`))));
t("no excluded recipe published", idx.every((r) => !r.excluded));

// --- 1b. SEO surface. This is the whole point of pre-rendering: a crawler
//     with no JavaScript must get the entire recipe from the response.
const sample = idx[0];
const recipeFile = path.join(SITE, "r", `${sample.id}-${sample.slug}.html`);
t("recipes pre-rendered at real paths", fs.existsSync(recipeFile), recipeFile);
t("every recipe has a pre-rendered page",
  idx.every((r) => fs.existsSync(path.join(SITE, "r", `${r.id}-${r.slug}.html`))),
  `${idx.filter((r) => !fs.existsSync(path.join(SITE, "r", `${r.id}-${r.slug}.html`))).length} missing`);

const rHtml = fs.readFileSync(recipeFile, "utf8");
const visible = rHtml.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<template[\s\S]*?<\/template>/g, "")
  .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
t("recipe content readable without JS", visible.length > 1500, `${visible.length} chars`);
t("ingredients appear in the raw HTML",
  visible.includes(readJson(path.join(SITE, "data", "recipes", `${sample.id}.json`)).components[0].ingredients[0].item));
t("canonical URL present", /rel="canonical" href="https:\/\/vegbatch\.com\/r\//.test(rHtml));
t("open graph image present", /og:image" content="https:\/\/vegbatch\.com\/og\.png/.test(rHtml));

const ld = JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(rHtml)[1]);
t("schema.org Recipe JSON-LD", ld["@type"] === "Recipe");
t("JSON-LD carries every ingredient",
  ld.recipeIngredient.length === readJson(path.join(SITE, "data", "recipes", `${sample.id}.json`))
    .components.flatMap((c) => c.ingredients).length);
t("JSON-LD carries every step", ld.recipeInstructions.length === sample.n_steps);
t("JSON-LD declares a vegetarian diet",
  ld.suitableForDiet.includes("https://schema.org/VegetarianDiet"));

// Recipes came from somewhere. The credit was recorded from the first
// extraction and rendered nowhere, which made it worth nothing.
const attributed = idx.filter((r) =>
  readJson(path.join(SITE, "data", "recipes", `${r.id}.json`)).source_attribution);
t("most recipes name a source", attributed.length > 100, `${attributed.length} of ${idx.length}`);
t("and the page actually shows it", (() => {
  const r = attributed[0];
  const html = fs.readFileSync(path.join(SITE, "r", `${r.id}-${r.slug}.html`), "utf8");
  const src = readJson(path.join(SITE, "data", "recipes", `${r.id}.json`)).source_attribution;
  return html.includes(`Adapted from ${src}`);
})());
t("r2 credits the cookbook", (() => {
  const r2 = idx.filter((x) => Number(x.id) >= 208);
  if (!r2.length) return true;
  return r2.every((x) => readJson(path.join(SITE, "data", "recipes", `${x.id}.json`))
    .source_attribution === "The Eat Raw Kitchen (Love Food)");
})());

// Photos. The canvas work is browser-only so it cannot run here; these guard
// the shape of what ships. The live path is covered by test-photos.mjs.
const acctSrc = fs.readFileSync(path.join(SITE, "lib", "account.mjs"), "utf8");
t("uploads are shrunk before they leave the device",
  /const \{ blob, ext: reEncoded \} = await shrink\(file\)/.test(acctSrc));
t("shrinking honours EXIF rotation", (() => {
  // Drawing to a canvas discards EXIF, so without this a portrait photo
  // uploads on its side — silent, and only visible after the fact.
  return /imageOrientation: "from-image"/.test(acctSrc);
})());
t("and every failure path keeps the original file",
  /catch \{\s*return \{ blob: file, ext: null \};/.test(acctSrc));
t("a re-encode that grew is discarded",
  /blob\.size >= file\.size/.test(acctSrc));
t("the card can show your own photo", (() => {
  const app = fs.readFileSync(path.join(SITE, "app.js"), "utf8");
  return /state\.photos\.get\(r\.id\)/.test(app) && /has-photo/.test(app)
    && /photoThumbs/.test(acctSrc);
})());
t("but the generated tile is still the fallback", (() => {
  const app = fs.readFileSync(path.join(SITE, "app.js"), "utf8");
  return /if \(!shot\)/.test(app);
})());

// A failing sync must never stop the page rendering as signed in. It used to:
// `await adoptLocalData(); route();` meant any one of staples/plan/saved
// lists/cook history failing skipped route() entirely, leaving the signed-out
// rendering on screen — no photos, nav still offering "Sign in" — with an
// outer .catch() swallowing it. The app looked untouched rather than degraded.
const shippedApp = fs.readFileSync(path.join(SITE, "app.js"), "utf8");
t("the sign-in sync is wrapped so it cannot skip the re-render",
  /try \{ await adoptLocalData\(\); \} catch/.test(shippedApp));
t("and the render runs even if init itself rejects",
  /acct\.init\(\)\.then\(refresh\)\.catch\(\(\) => route\(\)\)/.test(shippedApp));
t("a photo that cannot be signed is reported, not hidden",
  /saved but couldn't be loaded/.test(shippedApp));
t("listPhotos hands back unsigned rows instead of dropping them", (() => {
  const acctSrc = fs.readFileSync(path.join(SITE, "lib", "account.mjs"), "utf8");
  return /url: urlFor\.get\(p\.storage_path\) \?\? null/.test(acctSrc) &&
    !/\.filter\(\(p\) => p\.url\)/.test(acctSrc);
})());

// "Delete my data" cleared the tables and left the person a registered user,
// because the anon key cannot touch the auth schema. It now calls a
// SECURITY DEFINER RPC that takes no arguments and acts only on auth.uid().
// End-to-end proof lives in test-delete-account.mjs, which needs the network;
// this is the offline guard that the shipped client still calls it.
const shippedAccount = fs.readFileSync(path.join(SITE, "lib", "account.mjs"), "utf8");
t("the client asks the server to delete the account",
  /rpc\("delete_own_account"\)/.test(shippedAccount));
t("and never passes a user id to it — that would delete anyone",
  !/delete_own_account",\s*\{/.test(shippedAccount));
t("a failed delete does not clear local data or sign out", (() => {
  const app = fs.readFileSync(path.join(SITE, "app.js"), "utf8");
  return /const gone = await acct\.deleteEverything\(\)/.test(app) && /if \(!gone\)/.test(app);
})());

// --- theming. Light is the standard and the OS preference is NOT consulted:
//     this is the scheme the product is designed in. Dark is a stored choice.
const css = fs.readFileSync(path.join(SITE, "styles.css"), "utf8");
t("the OS preference is not consulted", !/prefers-color-scheme/.test(css));
t("dark is opt-in via data-theme", /:root\[data-theme="dark"\]/.test(css));
// A token defined ONLY under [data-theme] does not exist in the default
// state — that is the classic unreadable-artifact bug, one theme's text on
// the other theme's ground.
const orphanTokens = (() => {
  const block = (re) => (re.exec(css) || [])[1] ?? "";
  const names = (s) => [...s.matchAll(/(--[a-z-]+):/g)].map((m) => m[1]);
  const base = new Set(names(block(/:root\s*\{([\s\S]*?)\}/)));
  return names(block(/:root\[data-theme="dark"\]\s*\{([\s\S]*?)\}/))
    .filter((n) => n !== "color-scheme" && !base.has(n));
})();
t("every dark token also exists in the base palette",
  orphanTokens.length === 0, orphanTokens.join(", "));
t("the theme is applied before first paint, not by the deferred module", (() => {
  const r = idx[0];
  const html = fs.readFileSync(path.join(SITE, "r", `${r.id}-${r.slug}.html`), "utf8");
  const head = html.slice(0, html.indexOf("</head>"));
  return /localStorage\.getItem\("vb-theme"\)/.test(head) && /data-theme/.test(head);
})());
t("the toggle exists and reports its state", (() => {
  const shell = fs.readFileSync(path.join(SITE, "index.html"), "utf8");
  return /id="themeToggle"/.test(shell) && /aria-pressed/.test(shell);
})());

const sm = fs.readFileSync(path.join(SITE, "sitemap.xml"), "utf8");
t("sitemap lists every recipe", (sm.match(/<loc>/g) || []).length === idx.length + 1,
  `${(sm.match(/<loc>/g) || []).length} vs ${idx.length + 1}`);
t("sitemap namespace correct", sm.includes("http://www.sitemaps.org/schemas/sitemap/0.9"));
t("robots allows crawling and names the sitemap", (() => {
  const rb = fs.readFileSync(path.join(SITE, "robots.txt"), "utf8");
  return /Allow: \//.test(rb) && rb.includes("Sitemap: https://vegbatch.com/sitemap.xml");
})());
t("llms.txt present and describes the site", (() => {
  const l = fs.readFileSync(path.join(SITE, "llms.txt"), "utf8");
  return l.startsWith("# VegBatch") && l.includes("vegetarian") && l.includes(String(idx.length));
})());
for (const f of ["icon-32.png", "icon-192.png", "icon-512.png", "apple-touch-icon.png", "og.png", "logo.png", "site.webmanifest"]) {
  t(`asset ${f}`, fs.existsSync(path.join(SITE, f)));
}

// --- 1c. PWA. The point is a list that works in a shop with no signal.
const sw = fs.readFileSync(path.join(SITE, "sw.js"), "utf8");
t("service worker built", sw.length > 500);
t("no unreplaced placeholders in sw", !/__BUILD__|__PRECACHE__/.test(sw));
t("cache name carries the build id — else a deploy never invalidates", (() => {
  const build = (/const BUILD = "([^"]+)"/.exec(sw) || [])[1];
  return !!build && /^\d{14}$/.test(build) && sw.includes("`vegbatch-${BUILD}`");
})(), (/const BUILD = "([^"]+)"/.exec(sw) || [])[1]);
t("old caches deleted on activate", /caches\.delete/.test(sw));

// The boot payload decides what the app believes exists — the recipe count,
// the browse grid, the filters. Served stale-while-revalidate, every first
// load after a deploy showed the PREVIOUS deploy's data, and an open page
// never re-checked. That is how an installed app sits on an old recipe count
// and looks like nothing was ever shipped.
t("boot data is network-first, not stale-while-revalidate",
  /const isBoot =/.test(sw) && /if \(isBoot\(url\)\) \{\s*event\.respondWith\(\s*fetch\(request\)/.test(sw));
t("boot data still falls back to cache when offline",
  /isBoot\(url\)[\s\S]{0,600}?caches\.match\(request\)/.test(sw));
t("individual recipes stay cache-first for the shop",
  /isData\(url\)[\s\S]{0,300}?caches\.match\(request\)\.then/.test(sw));
t("app reloads once when a new worker takes control", (() => {
  const app = fs.readFileSync(path.join(SITE, "app.js"), "utf8");
  return /controllerchange/.test(app) && /location\.reload\(\)/.test(app) && /reloading/.test(app);
})());
const precache = JSON.parse(/const PRECACHE = (\[[\s\S]*?\]);/.exec(sw)[1]);
t("precache covers the offline path",
  ["/", "/app.js", "/styles.css", "/data/index.json", "/data/ingredients.json"]
    .every((u) => precache.includes(u)));
// The offline shell is the entire point of the PWA, and it was looked up
// under a key that could never be cached: Cloudflare canonicalises
// /index.html to / and 308s, so the entry always failed and offline
// navigation fell through to a bare 503. The fallback and the precache have
// to name the same thing.
t("the offline fallback names a key that is actually precached", (() => {
  const key = (/caches\.match\("([^"]+)"\)\s*\|\|\s*$/m.exec(sw) || [])[1]
    ?? (/\(await caches\.match\("([^"]+)"\)\) \|\|/.exec(sw.slice(sw.indexOf("catch"))) || [])[1];
  return key && precache.includes(key);
})(), "fallback key not in PRECACHE");
t("and /index.html is not precached — it always 308s",
  !precache.includes("/index.html"));
t("every precached file exists",
  precache.filter((u) => u !== "/").every((u) => fs.existsSync(path.join(SITE, u))),
  precache.filter((u) => u !== "/" && !fs.existsSync(path.join(SITE, u))).join(", "));
t("sw.js is set no-cache — a cached SW can never update itself", (() => {
  const hd = fs.readFileSync(path.join(SITE, "_headers"), "utf8");
  return /\/sw\.js\s*\n\s*Cache-Control: no-cache/.test(hd);
})());
// The icons and social card had no _headers rule at all, so telling the zone
// to "respect existing headers" would have had nothing to respect. They are
// not content-hashed, so they revalidate weekly rather than caching forever.
const headers = fs.readFileSync(path.join(SITE, "_headers"), "utf8");
const cacheRuleFor = (file) => {
  const m = new RegExp(`^${file.replace(/[.*]/g, "\\$&")}\\s*\\n\\s*Cache-Control: ([^\\n]+)`, "m").exec(headers);
  return m ? m[1] : null;
};
t("the unhashed brand assets have a cache rule", (() => {
  const missing = ["/og.png", "/logo.png", "/icon-192.png", "/apple-touch-icon.png"]
    .filter((f) => !/public, max-age=\d+/.test(cacheRuleFor(f) ?? ""));
  return missing.length === 0 ? true : missing.join(", ");
})() === true);
t("but they are not cached forever — the logo can change", (() => {
  const secs = Number((/max-age=(\d+)/.exec(cacheRuleFor("/og.png") ?? "") || [])[1] ?? 0);
  return secs > 0 && secs <= 2592000;
})());
t("the service worker is still never cached", /no-cache/.test(cacheRuleFor("/sw.js") ?? ""));

t("manifest is installable", (() => {
  const m = readJson(path.join(SITE, "site.webmanifest"));
  return m.name && m.start_url && m.display === "standalone"
    && m.icons?.some((i) => i.sizes === "512x512");
})());
t("app registers the service worker",
  fs.readFileSync(path.join(SITE, "app.js"), "utf8").includes('navigator.serviceWorker.register("/sw.js")'));

// --- 2. grocery parity: the browser and the CLI must agree exactly
const allRecipes = readJson(path.join(DATA, "recipes.json"), []);
const catalog = readJson(path.join(DATA, "ingredients.json"), {});
const staples = readJson(path.join(DATA, "staples.json"), { items: [] }).items;
const picks = ["002", "043", "115", "174"];

const fromSource = buildList({
  recipes: picks.map((id) => ({ ...allRecipes.find((r) => r.id === id), scale: 1 })),
  catalog, staples, options: { includeStaples: true, includePantry: false },
});
const fromSite = buildList({
  recipes: picks.map((id) => ({ ...readJson(path.join(SITE, "data", "recipes", `${id}.json`)), scale: 1 })),
  catalog: readJson(path.join(SITE, "data", "ingredients.json"), {}),
  // Same staples on both sides on purpose: this test is about recipe and
  // catalog parity. Staples are per-account and the site ships none, so
  // taking them from the site here would compare two different questions.
  staples,
  options: { includeStaples: true, includePantry: false },
});
// --- substitution drift, fourth instance. `raw_text` holds what the original
//     card said, and on the substituted recipes that is still "1 lb ground
//     beef" or "ham bone". It was rendered by the "show which recipe each came
//     from" option and shipped in the public JSON that llms.txt invites
//     machines to read. A substitution has to land in ingredients, method,
//     description AND anywhere the original wording survives.
// Same two patterns build-site.mjs uses on descriptions: "plant-based ground
// beef" and "tempeh bacon" are the actual product names and Ron kept them, so
// a meat word only counts when nothing qualifies it.
const MEAT = /\b(ham bone|ham|bacon|chicken|beef|pork|turkey|sausage|anchov|lard)\b/i;
const QUALIFIED = /(plant-based|vegetarian|vegan|meatless|tempeh|smoked tofu|instead of|stands? in for|-free)/i;
const namesMeat = (s) => MEAT.test(s ?? "") && !QUALIFIED.test(s ?? "");
t("no published recipe ships the pre-substitution wording",
  idx.every((r) => !/"raw_text"/.test(
    fs.readFileSync(path.join(SITE, "data", "recipes", `${r.id}.json`), "utf8"))));
t("and no meat survives in the published data", (() => {
  const bad = idx.filter((r) => {
    const d = readJson(path.join(SITE, "data", "recipes", `${r.id}.json`));
    return d.components.flatMap((c) => c.ingredients).some((i) => namesMeat(i.item));
  });
  return bad.length === 0 ? true : bad.map((r) => r.id).join(", ");
})() === true);
t("the why-line shows what you cook, not what the card said", (() => {
  const meaty = allRecipes.find((r) => r.id === "083");
  const l = buildList({ recipes: [{ ...meaty, scale: 1 }], catalog, staples: [], options: {} });
  return l.items.flatMap((e) => e.sources).every((s) => !namesMeat(s.raw));
})());

// A line resolving to several canonicals only ever weighed the first. Right
// for "cotija or feta" (one purchase), wrong for a real compound — 090's
// substituted broth base is stock AND paprika AND soy sauce AND bay leaves,
// and three of the four vanished off the list entirely.
t("compound extras reach the list instead of vanishing", (() => {
  const soup = allRecipes.find((r) => r.id === "090");
  const l = buildList({ recipes: [{ ...soup, scale: 1 }], catalog, staples: [], options: {} });
  const names = l.toCheck.map((t) => t.name);
  return ["soy sauce", "bay leaf"].every((n) => names.includes(n));
})());
t("but an either/or alternative is still one purchase", (() => {
  const either = allRecipes.find((r) =>
    r.components.some((c) => c.ingredients.some((i) => /\bor\b/i.test(i.item ?? "") && (i.canonical ?? []).length > 1)));
  if (!either) return true;
  const l = buildList({ recipes: [{ ...either, scale: 1 }], catalog, staples: [], options: {} });
  const line = either.components.flatMap((c) => c.ingredients)
    .find((i) => /\bor\b/i.test(i.item ?? "") && (i.canonical ?? []).length > 1);
  const alt = line.canonical[1];
  return !l.toCheck.some((t) => t.name === (catalog[alt]?.name ?? alt));
})());

// Staples belong to an account, not to the build. Shipping a real household's
// list handed every first-time visitor somebody else's groceries — and put a
// private note on a public endpoint. Suggestions are fine; saved items are not.
const shippedStaples = readJson(path.join(SITE, "data", "staples.json"), {});
t("site ships no household's staples", (shippedStaples.items ?? []).length === 0,
  JSON.stringify(shippedStaples.items));
t("site ships generic starter suggestions", (shippedStaples.suggestions ?? []).length > 0);
t("no private staple notes escape the build",
  !JSON.stringify(shippedStaples).includes("big plain"));

const sig = (l) => l.items.map((e) => `${e.label}|${e.purchase.main}`).join("\n");
t("site data yields the identical grocery list to source data",
  sig(fromSource) === sig(fromSite),
  `${fromSource.items.length} vs ${fromSite.items.length} items`);
t("list is non-trivial", fromSite.items.length > 15, `${fromSite.items.length}`);
t("scaling changes quantities", (() => {
  const x2 = buildList({
    recipes: [{ ...allRecipes.find((r) => r.id === "002"), scale: 2 }],
    catalog, staples, options: {},
  });
  const x1 = buildList({
    recipes: [{ ...allRecipes.find((r) => r.id === "002"), scale: 1 }],
    catalog, staples, options: {},
  });
  const g = (l) => l.items.find((e) => e.ingredient.id === "chickpeas")?.g;
  return g(x2) === g(x1) * 2;
})());

// --- 3. the app itself, in a DOM
const errors = [];
const vc = new VirtualConsole();
vc.on("jsdomError", (e) => errors.push(e.message));
vc.on("error", (...a) => errors.push(a.join(" ")));

const dom = new JSDOM(fs.readFileSync(path.join(SITE, "index.html"), "utf8"), {
  url: `${BASE}/`, runScripts: "dangerously", virtualConsole: vc, pretendToBeVisual: true,
});
const { window } = dom;
const { document } = window;

window.fetch = async (url) => {
  const res = await fetch(new URL(url, BASE));
  return { ok: res.ok, status: res.status, json: () => res.json() };
};
window.scrollTo = () => {};
window.print = () => {};
window.confirm = () => true;

// jsdom has no ESM; hand the app its one import and run the rest as-is
const src = fs.readFileSync(path.join(SITE, "app.js"), "utf8").replace(/^import .*$/gm, "");
window.buildList = buildList;
// jsdom has no ESM, so the app's imports are stripped and the same bindings
// are handed in directly — the very modules the browser would have fetched.
const { recipeHtml, recipePath } = await import("./lib/recipe-html.mjs");
const { PITCH, TAGLINE, FREE_LINE } = await import("./lib/seo.mjs");
const { RETAILERS, searchTerm, DISCLOSURE } = await import("./lib/shop.mjs");

// Accounts are stubbed as unavailable. That is not a gap in coverage — it is
// the case that matters most: the public site must work perfectly for someone
// signed out, and must survive Supabase being unreachable entirely. Signed-in
// behaviour needs a real session and belongs in a manual pass.
const acct = {
  enabled: () => true,   // as in production; the visitor is simply signed out
  user: () => null,
  household: () => null,
  init: async () => null,
  onChange: () => () => {},
  signIn: async () => {},
  signOut: async () => {},
  pullStaples: async () => null,
  pushStaples: async () => {},
  pullPlan: async () => null,
  pushPlan: async () => {},
  pullCookHistory: async () => new Map(),
  markCooked: async () => false,
  sinceLabel: () => null,
  listPhotos: async () => [],
  photoThumbs: async () => new Map(),
  sendFeedback: async () => ({ ok: true }),
  logClick: () => {},
  deleteEverything: async () => {},
};

await new window.Function(
  "buildList", "recipeHtml", "recipePath", "PITCH", "TAGLINE", "FREE_LINE",
  "RETAILERS", "searchTerm", "DISCLOSURE", "acct",
  "BASE_SERVINGS", "SCALES", "isBatch", "yieldLabel", "keepsForAWeek",
  `return (async () => {\n${src}\n})()`,
).call(window, buildList, recipeHtml, recipePath, PITCH, TAGLINE, FREE_LINE,
  RETAILERS, searchTerm, DISCLOSURE, acct,
  BASE_SERVINGS, SCALES, isBatch, yieldLabel, keepsForAWeek);
await new Promise((r) => setTimeout(r, 400));

const nav = async (p) => { window.history.pushState({}, "", p); window.dispatchEvent(new window.PopStateEvent("popstate")); await new Promise(r=>setTimeout(r,300)); };

t("app loads with no errors", errors.length === 0, errors.join(" | "));
t("browse renders cards", document.querySelectorAll(".card").length > 100,
  `${document.querySelectorAll(".card").length} cards`);
t("ingredient filter populated", document.querySelectorAll("#fIng option").length > 20);

// Tiles stand in for the photographs that are deliberately not published.
t("generated tiles rendered", document.querySelectorAll(".tile").length > 100,
  `${document.querySelectorAll(".tile").length} tiles`);
t("tiles name the dish's headline ingredients",
  [...document.querySelectorAll(".tile-ing")].filter((n) => n.textContent.trim().length > 3).length > 100);
t("every recipe has headline ingredients", idx.every((r) => (r.headline ?? []).length > 0),
  `${idx.filter((r) => !(r.headline ?? []).length).length} without`);
t("no recipe is empty", idx.every((r) => r.n_ingredients > 0),
  `${idx.filter((r) => !r.n_ingredients).length} empty`);

// search
const q = document.querySelector("#q");
q.value = "chickpea";
q.dispatchEvent(new window.Event("input"));
await new Promise((r) => setTimeout(r, 60));
const searched = document.querySelectorAll(".card").length;
t("search narrows results", searched > 0 && searched < idx.length, `${searched} hits`);

// vegan filter
q.value = "";
q.dispatchEvent(new window.Event("input"));
const vegan = document.querySelector("#fVegan");
vegan.checked = true;
vegan.dispatchEvent(new window.Event("change"));
await new Promise((r) => setTimeout(r, 60));
const veganCount = document.querySelectorAll(".card").length;
t("vegan filter works", veganCount > 0 && veganCount < idx.length, `${veganCount} vegan`);
vegan.checked = false;
vegan.dispatchEvent(new window.Event("change"));

// recipe page
await nav("/r/002-greek-couscous-salad");

await new Promise((r) => setTimeout(r, 250));
t("recipe page renders", document.querySelector(".recipe-head h1")?.textContent?.length > 3,
  document.querySelector(".recipe-head h1")?.textContent);
t("ingredients listed", document.querySelectorAll("ul.ing li").length > 5);
t("steps listed", document.querySelectorAll("ol.steps li").length > 1);
// Ron's call: no photographs of their handwriting are published anywhere.
t("no card photos published",
  !document.querySelector('img[src^="cards/"]') && !fs.existsSync(path.join(SITE, "cards")));
t("recipe detail ships no page filenames",
  !JSON.stringify(readJson(path.join(SITE, "data", "recipes", "002.json"))).includes("PXL_"));

// add to plan
document.querySelector("#addBtn").click();
await new Promise((r) => setTimeout(r, 80));
t("add to week updates the button", /remove/i.test(document.querySelector("#addBtn").textContent));
t("plan count pill shows", document.querySelector("#planCount").textContent === "1");

// plan + grocery list
await nav("/plan");

await new Promise((r) => setTimeout(r, 300));
t("plan lists the recipe", document.querySelectorAll(".plan-row").length === 1);

// The serving model: as written = 5 servings, whole multipliers only. Half a
// batch was never a thing this kitchen cooked, and the old card yields (63 of
// them missing outright) were the least reliable field in the collection.
const scaleOpts = [...document.querySelectorAll(".plan-row select option")].map((o) => o.value);
t("plan offers whole multiples only", scaleOpts.join(",") === "1,2,3,4", scaleOpts.join(","));
t("no half-batch anywhere in the plan", !scaleOpts.includes("0.5"));
t("plan row states the servings",
  /\d+ servings/.test(document.querySelector(".plan-row .detail")?.textContent ?? ""),
  document.querySelector(".plan-row .detail")?.textContent);
t("week total is a multiple of five",
  Number(/(\d+) servings/.exec(document.querySelector(".week-sum")?.textContent ?? "")?.[1] ?? 0) % 5 === 0,
  document.querySelector(".week-sum")?.textContent);
t("grocery list renders", document.querySelectorAll(".buy li").length > 5,
  `${document.querySelectorAll(".buy li").length} items`);
t("aisles are grouped", document.querySelectorAll(".aisle h3").length > 2);

// Shop links: search URLs, no SKU catalogue, disclosure alongside.
const shop = document.querySelector("details.shop");
t("shop section rendered", !!shop);
t("one shop row per grocery item",
  shop.querySelectorAll(".shop-row").length === document.querySelectorAll(".buy li").length,
  `${shop?.querySelectorAll(".shop-row").length} vs ${document.querySelectorAll(".buy li").length}`);
t("affiliate disclosure shown with the links",
  /affiliate/i.test(shop.querySelector(".shop-note")?.textContent ?? ""));
const firstLink = shop.querySelector(".shop-link");
t("links are search URLs, not product pages",
  /\/s\?|\/search\?/.test(firstLink?.getAttribute("href") ?? ""), firstLink?.getAttribute("href"));
t("outbound links are rel=nofollow sponsored",
  /nofollow/.test(firstLink?.getAttribute("rel") ?? "") && /sponsored/.test(firstLink?.getAttribute("rel") ?? ""));
t("links open in a new tab", firstLink?.getAttribute("target") === "_blank");
t("every retailer offered per item",
  shop.querySelector(".shop-row").querySelectorAll(".shop-link").length === RETAILERS.length);

// ticking an item persists
const firstCheck = document.querySelector(".buy input");
firstCheck.checked = true;
firstCheck.dispatchEvent(new window.Event("change"));
t("ticking strikes the item through", document.querySelector(".buy li").classList.contains("got"));

// A fresh visitor owns no staples, so the toggle has nothing to add yet —
// that is the point of the change, not a regression.
const optStaples = document.querySelector("#optStaples");
const recipeOnly = document.querySelectorAll(".buy li").length;
optStaples.checked = true;
optStaples.dispatchEvent(new window.Event("change"));
await new Promise((r) => setTimeout(r, 250));
t("staples toggle adds nothing before you own any staples",
  document.querySelectorAll(".buy li").length === recipeOnly,
  `${recipeOnly} -> ${document.querySelectorAll(".buy li").length}`);
optStaples.checked = false;
optStaples.dispatchEvent(new window.Event("change"));
await new Promise((r) => setTimeout(r, 150));

// --- shopping history: save a shop, then read it back
await nav("/plan");
await new Promise((r) => setTimeout(r, 300));
const itemsOnScreen = document.querySelectorAll(".buy li").length;
document.querySelector("#saveList").click();
await new Promise((r) => setTimeout(r, 300));
const saved = load2("vb-history") ?? [];
t("saving a list records it", saved.length === 1, `${saved.length} saved`);
t("the record is timestamped", !Number.isNaN(Date.parse(saved[0]?.saved_at ?? "")), saved[0]?.saved_at);
t("it freezes the lines, not a recipe reference",
  saved[0]?.items?.length === itemsOnScreen, `${saved[0]?.items?.length} vs ${itemsOnScreen} on screen`);
t("a frozen line carries its quantity", !!saved[0]?.items?.[0]?.qty, saved[0]?.items?.[0]?.qty);
t("it keeps the plan so the week can be reloaded", saved[0]?.recipes?.length > 0);

await nav("/history");
await new Promise((r) => setTimeout(r, 300));
t("history page renders the saved shop", document.querySelectorAll(".hist-card").length === 1);
t("and dates it", /\d{4}/.test(document.querySelector(".hist-head")?.textContent ?? ""),
  document.querySelector(".hist-head")?.textContent);
t("history says where it is kept",
  (document.querySelector("#historyWhere")?.textContent ?? "").includes("this browser"));
t("a saved shop lists its items",
  document.querySelectorAll(".hist-items li").length === itemsOnScreen);

document.querySelectorAll(".hist-actions button")[1].click();
await new Promise((r) => setTimeout(r, 300));
t("a saved shop can be deleted", (load2("vb-history") ?? []).length === 0);
t("and the page empties with it", document.querySelectorAll(".hist-card").length === 0);

// staples editor — how a person adds non-recipe items
await nav("/staples");

await new Promise((r) => setTimeout(r, 200));
t("empty staples page offers a starter", !!document.querySelector(".staples button.ghost"));
// Someone is about to type out their weekly shop — tell them where it lands.
const whereNote = document.querySelector("#stapleWhere");
t("staples page says where the list is kept",
  (whereNote?.textContent ?? "").includes("this browser"), whereNote?.textContent?.slice(0, 60));
t("and links to signing in", whereNote?.querySelector('a[href="/account"]') !== null);
t("staples page renders", !!document.querySelector("#stapleAdd"));
const stapleRowsBefore = document.querySelectorAll(".staple-rows li").length;
document.querySelector("#sItem").value = "sparkling water";
document.querySelector("#sQty").value = "6";
document.querySelector("#stapleAdd").dispatchEvent(new window.Event("submit", { cancelable: true, bubbles: true }));
await new Promise((r) => setTimeout(r, 150));
t("can add a staple in the browser",
  document.querySelectorAll(".staple-rows li").length === stapleRowsBefore + 1,
  `${stapleRowsBefore} -> ${document.querySelectorAll(".staple-rows li").length}`);
t("added staple persists", (load2("vb-staples") ?? []).some((s) => s.item === "sparkling water"));

// ...and now that this person owns a staple, the toggle must pick it up.
await nav("/plan");
await new Promise((r) => setTimeout(r, 250));
const own = document.querySelectorAll(".buy li").length;
const optStaples2 = document.querySelector("#optStaples");
optStaples2.checked = true;
optStaples2.dispatchEvent(new window.Event("change"));
await new Promise((r) => setTimeout(r, 250));
t("staples toggle adds your own staples",
  document.querySelectorAll(".buy li").length > own,
  `${own} -> ${document.querySelectorAll(".buy li").length}`);

// A staples-only shop. Ron, 2026-10-04: "you can't add weekly staples if
// there is no recipe loaded" — the week page bailed out before the toggle
// ever rendered, so the only way to shop your staples was to plan a recipe
// you didn't want. Empty the week and the staples must still make a list.
document.querySelector(".plan-row button.ghost").click();
await new Promise((r) => setTimeout(r, 250));
t("removing the last recipe empties the week", document.querySelectorAll(".plan-row").length === 0);
t("staples still make a list with no recipe planned",
  document.querySelectorAll(".buy li").length > 0,
  `${document.querySelectorAll(".buy li").length} items`);
t("and the list says what it is",
  /weekly staples/i.test(document.querySelector("#groceries h2")?.textContent ?? ""),
  document.querySelector("#groceries h2")?.textContent);
t("the staples toggle is still offered", !document.querySelector("#listOpts").hidden);
t("nothing to clear, so no Clear week", document.querySelector("#clearPlan").hidden);
t("a staples-only list can be saved", !document.querySelector("#saveList").hidden);

// Toggle off: the list goes, but the way back stays on the page.
const optStaples3 = document.querySelector("#optStaples");
optStaples3.checked = false;
optStaples3.dispatchEvent(new window.Event("change"));
await new Promise((r) => setTimeout(r, 250));
t("toggled off, the staples-only list clears", document.querySelectorAll(".buy li").length === 0);
t("and the page says how to get it back",
  /Add weekly staples/.test(document.querySelector("#planRecipes")?.textContent ?? ""));
optStaples3.checked = true;
optStaples3.dispatchEvent(new window.Event("change"));
await new Promise((r) => setTimeout(r, 250));
await nav("/staples");
await new Promise((r) => setTimeout(r, 200));

function load2(k) { try { return JSON.parse(window.localStorage.getItem(k)); } catch { return null; } }

// 76 of the card recipes never wrote down a time, so the time filter can only
// ever match the 178 that did. Silently, it answers "the quick recipes we
// happen to have timed" while looking like it answered "the quick recipes".
await nav("/");
await new Promise((r) => setTimeout(r, 250));
const untimed = idx.filter((r) => !r.total_min).length;
t("there really are untimed recipes to warn about", untimed > 0, `${untimed}`);
t("no warning when no time filter is set",
  !/no time written down/.test(document.querySelector("#count")?.textContent ?? ""));
const timeSel = document.querySelector("#fTime");
timeSel.value = "30";
timeSel.dispatchEvent(new window.Event("change"));
await new Promise((r) => setTimeout(r, 200));
t("filtering by time says how many it cannot see",
  new RegExp(`${untimed} more have no time`).test(document.querySelector("#count")?.textContent ?? ""),
  document.querySelector("#count")?.textContent);
timeSel.value = "";
timeSel.dispatchEvent(new window.Event("change"));
await new Promise((r) => setTimeout(r, 200));

// Feedback form. Driven rather than inspected, because the failure modes are
// behavioural: a honeypot that blocks real people, or a submit that asks for
// the row back and 401s because anonymous callers may write but not read.
await nav("/feedback");
await new Promise((r) => setTimeout(r, 250));
t("the feedback form renders", !!document.querySelector("#fbForm"));
t("it works signed out — no account gate",
  !!document.querySelector("#fbSend") && !document.querySelector(".feedback a[href='/account']"));
t("the kinds match what the database accepts", (() => {
  const opts = [...document.querySelectorAll("#fbKind option")].map((o) => o.value).sort();
  return opts.join(",") === "bug,other,recipe,suggestion";
})(), [...document.querySelectorAll("#fbKind option")].map((o) => o.value).join(","));
t("there is a honeypot for bots", !!document.querySelector("#fbTrap"));

// empty submit must not send
let sent = null;
acct.sendFeedback = async (payload) => { sent = payload; return { ok: true }; };
document.querySelector("#fbForm").dispatchEvent(new window.Event("submit", { cancelable: true, bubbles: true }));
await new Promise((r) => setTimeout(r, 120));
t("an empty form is refused, not sent", sent === null);
t("and says why", /name, email and a message/i.test(document.querySelector("#fbStatus")?.textContent ?? ""));

// a filled honeypot is dropped silently
document.querySelector("#fbName").value = "Bot";
document.querySelector("#fbEmail").value = "bot@example.com";
document.querySelector("#fbMessage").value = "buy things";
document.querySelector("#fbTrap").value = "gotcha";
document.querySelector("#fbForm").dispatchEvent(new window.Event("submit", { cancelable: true, bubbles: true }));
await new Promise((r) => setTimeout(r, 120));
t("a filled honeypot is dropped", sent === null);

// a real submission goes through with everything the trigger needs
document.querySelector("#fbTrap").value = "";
document.querySelector("#fbName").value = "  Ron  ";
document.querySelector("#fbEmail").value = "ron@example.com";
document.querySelector("#fbKind").value = "recipe";
document.querySelector("#fbMessage").value = "  the chili needs more cumin  ";
document.querySelector("#fbForm").dispatchEvent(new window.Event("submit", { cancelable: true, bubbles: true }));
await new Promise((r) => setTimeout(r, 200));
t("a real submission is sent", !!sent);
t("with the fields trimmed", sent?.name === "Ron" && sent?.message === "the chili needs more cumin");
t("and the chosen kind", sent?.kind === "recipe");
t("and the page they came from", typeof sent?.page === "string" && sent.page.length > 0, sent?.page);
t("the form is replaced by a thank-you, not left to resubmit",
  !document.querySelector("#fbForm") && !!document.querySelector(".fb-done"));
t("the thank-you credits Tributary and links it", (() => {
  const done = document.querySelector(".fb-done");
  const link = done?.querySelector("a");
  return /Tributary has it/.test(done?.textContent ?? "") && link?.getAttribute("href") === "https://trib.xyz";
})(), document.querySelector(".fb-done")?.textContent);
t("and tells them where a reply would go",
  (document.querySelector(".fb-done")?.textContent ?? "").includes("ron@example.com"));

// Theme toggle, driven for real. Light is the standard, so a first-time
// visitor must get no stamp at all — absence of the attribute IS light, which
// is what leaves room for a "follow the system" option later.
const themeBtn = document.querySelector("#themeToggle");
t("a first visit is light, with no stamp", document.documentElement.getAttribute("data-theme") === null);
themeBtn.click();
t("toggling stamps dark", document.documentElement.getAttribute("data-theme") === "dark");
t("and remembers it", load2("vb-theme") === "dark");
t("and the button now offers the way back",
  /light/i.test(themeBtn.getAttribute("aria-label") ?? ""), themeBtn.getAttribute("aria-label"));
t("and says it is pressed", themeBtn.getAttribute("aria-pressed") === "true");
t("the browser chrome follows the page",
  document.querySelector('meta[name="theme-color"]')?.getAttribute("content") === "#201e1b");
themeBtn.click();
t("toggling back removes the stamp rather than writing light",
  document.documentElement.getAttribute("data-theme") === null);
t("and remembers that too", load2("vb-theme") === "light");
t("and restores the brand chrome",
  document.querySelector('meta[name="theme-color"]')?.getAttribute("content") === "#186048");

// Mobile menu. jsdom has no layout, so this tests the behaviour (open/close
// and the aria contract) rather than the media query.
const burger = document.querySelector("#burger");
const navEl = document.querySelector("#nav");
t("burger button exists", !!burger);
t("burger is labelled and wired to the nav",
  burger?.getAttribute("aria-label") === "Menu" && burger?.getAttribute("aria-controls") === "nav");
t("menu starts closed", burger?.getAttribute("aria-expanded") === "false" && !navEl?.classList.contains("open"));
burger.click();
t("burger opens the menu", navEl.classList.contains("open") && burger.getAttribute("aria-expanded") === "true");
navEl.querySelector("a").click();
t("choosing a link closes it", !navEl.classList.contains("open"));
burger.click();
document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
t("Escape closes it", !navEl.classList.contains("open"));
burger.click();
window.dispatchEvent(new window.Event("resize"));
t("returning to desktop width closes it and resets aria",
  !navEl.classList.contains("open") && burger.getAttribute("aria-expanded") === "false");
t("nav collapses below 700px in CSS",
  fs.readFileSync(path.join(SITE, "styles.css"), "utf8").includes("@media (max-width: 700px)"));

// Accounts: the signed-out path and the auth-unavailable path are the same
// code, and both must be flawless. The site is a public good first.
await nav("/account");
t("account page renders signed out", !!document.querySelector(".account"));
t("it pitches the benefits rather than gating anything",
  document.querySelectorAll(".perks li").length >= 3);
t("signed-in panel is hidden", document.querySelector('[data-when="in"]')?.hidden === true);

// Install had to be made recoverable: the first version stored a permanent
// "dismissed" flag, so deleting the app left no way to get the prompt back.
t("account page always offers a way to install",
  !!document.querySelector("#installHere"));
t("dismissal is a timestamp, not a permanent flag", (() => {
  const a = fs.readFileSync(path.join(SITE, "app.js"), "utf8");
  return a.includes("DISMISS_DAYS") && !a.includes('"vb-install-dismissed", true');
})());
t("installing clears the dismissal so reinstall works",
  fs.readFileSync(path.join(SITE, "app.js"), "utf8")
    .includes('addEventListener("appinstalled"'));
t("nav offers sign-in", document.querySelector("#navAccount")?.textContent === "Sign in");

await nav("/");
t("browse works while signed out",
  document.querySelectorAll(".card").length > 100);
t("no cook-history labels without an account",
  document.querySelectorAll(".tag.cooked").length === 0);

// plan-my-week
await nav("/");

await new Promise((r) => setTimeout(r, 150));
// Meal prep is the default: one recipe, scaled to cover the week.
document.querySelector("#togglePlanner").click();
t("planner opens", !document.querySelector("#planner").hidden);
t("defaults to one recipe", document.querySelector("#pRecipes").value === "1");
t("defaults to 5 days for 2", document.querySelector("#pDays").value === "5" &&
  document.querySelector("#pPeople").value === "2");

document.querySelector("#buildWeek").click();
await new Promise((r) => setTimeout(r, 350));
let planned = JSON.parse(window.localStorage.getItem("vb-plan") ?? "[]");
t("meal-prep mode picks a single recipe", planned.length === 1, JSON.stringify(planned));
t("and scales it up for the week", planned[0]?.scale > 1, `scale ${planned[0]?.scale}`);
const picked = idx.find((r) => r.id === planned[0]?.id);
// Exactly, not approximately: 5 days for 2 is 10 servings, every recipe is 5,
// so the only right answer is ×2. The old ±2.5 tolerance existed to absorb the
// card yields, which no longer enter into it.
t("scale covers 10 servings exactly", BASE_SERVINGS * planned[0].scale === 10,
  `5 × ${planned[0].scale}`);
t("doesn't pick a dessert to eat for five days",
  !/dessert|snack|sauce/.test(picked.course ?? ""), picked.course ?? "none");

// Variety mode brings back the overlap-aware pick.
await nav("/");

await new Promise((r) => setTimeout(r, 150));
document.querySelector("#togglePlanner").click();
document.querySelector("#pRecipes").value = "4";
document.querySelector("#pRecipes").dispatchEvent(new window.Event("change"));
document.querySelector("#buildWeek").click();
await new Promise((r) => setTimeout(r, 350));
planned = JSON.parse(window.localStorage.getItem("vb-plan") ?? "[]");
t("variety mode picks four", planned.length === 4, JSON.stringify(planned.map((p) => p.id)));
const chosenIdx = planned.map((p) => idx.find((r) => r.id === p.id));
const overlap = new Set(chosenIdx.flatMap((r) => r.ing));
const total = chosenIdx.reduce((s, r) => s + r.ing.length, 0);
t("chosen recipes actually share ingredients", overlap.size < total,
  `${total} ingredient slots -> ${overlap.size} distinct`);
t("plan page offers another recipe",
  [...document.querySelectorAll("#planRecipes a")].some((a) => /Add another recipe/.test(a.textContent)));

// The recipe count survives the trip back — it used to reset to 1.
await nav("/");
await new Promise((r) => setTimeout(r, 150));
t("planner remembers the recipe count", document.querySelector("#pRecipes").value === "4");
document.querySelector("#togglePlanner").click();
document.querySelector("#pRecipes").value = "7";
document.querySelector("#pRecipes").dispatchEvent(new window.Event("change"));
document.querySelector("#buildWeek").click();
await new Promise((r) => setTimeout(r, 350));
planned = JSON.parse(window.localStorage.getItem("vb-plan") ?? "[]");
t("a week can hold seven recipes", planned.length === 7, String(planned.length));

t("still no errors", errors.length === 0, errors.join(" | "));

console.log(`\n${pass} passed, ${fail} failed`);
window.close();
process.exit(fail ? 1 : 0);
