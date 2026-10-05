/**
 * Post-deploy check against the real site.
 *
 * `test-site.mjs` reads files on disk. That is not the same as what the CDN
 * serves, and the difference has already bitten once: `_headers` correctly
 * said `/sw.js: no-cache`, the test passed, and production served
 * `max-age=14400` because a zone-level Browser Cache TTL was rewriting it.
 * A file being right is not evidence that a response is right.
 *
 * Run after every deploy:  node verify-live.mjs [origin]
 */
const ORIGIN = process.argv[2] ?? "https://vegbatch.com";

let pass = 0, fail = 0, warn = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ok    ${n}`)) : (fail++, console.log(`  FAIL  ${n}${d ? ` — ${d}` : ""}`)); };
const soft = (n, c, d = "") => { c ? (pass++, console.log(`  ok    ${n}`)) : (warn++, console.log(`  warn  ${n}${d ? ` — ${d}` : ""}`)); };

const get = async (p) => {
  const res = await fetch(`${ORIGIN}${p}`, { redirect: "follow" });
  return { status: res.status, headers: res.headers, text: await res.text() };
};

console.log(`\nlive check — ${ORIGIN}\n`);

// --- routes that must exist
for (const p of ["/", "/plan", "/staples", "/sitemap.xml", "/robots.txt", "/llms.txt",
                 "/sw.js", "/site.webmanifest", "/og.png", "/logo.png"]) {
  const r = await get(p);
  ok(`${p} serves`, r.status === 200, `got ${r.status}`);
}

// --- a pre-rendered recipe really carries its content
const idx = await (await fetch(`${ORIGIN}/data/index.json`)).json();
const sample = idx[Math.floor(Math.random() * idx.length)];
const rec = await get(sample.url);
ok(`random recipe ${sample.url} serves`, rec.status === 200);
const visible = rec.text.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<template[\s\S]*?<\/template>/g, "")
  .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
// Length is the wrong assertion — a six-ingredient index card renders about
// 700 characters and is perfectly complete. What matters is that the recipe's
// own words are in the response, so check for them.
// Check the page against its OWN JSON-LD rather than against the separately
// cached recipe JSON. Both used to be fetched, and seconds after a deploy the
// edge can serve one from the old build and one from the new — which reads as
// a content failure and isn't. It flaked twice that way. One document has one
// cache state, so comparing it to itself cannot skew; and it still tests the
// thing that matters, that the visible HTML and the structured data agree.
const pageLd = JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(rec.text)[1]);
const firstIngredient = pageLd.recipeIngredient[0].replace(/^[\d\s⁄½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞.–-]+/, "").split(",")[0].trim();
const lastStep = pageLd.recipeInstructions.at(-1).text.slice(0, 40);
ok("recipe readable with no JavaScript", visible.length > 400, `${visible.length} chars`);
ok("its ingredients are in the response", visible.includes(firstIngredient), firstIngredient);
ok("its method is in the response", visible.includes(lastStep), lastStep);
ok("recipe carries JSON-LD", /application\/ld\+json/.test(rec.text));
ok("canonical points at the same URL", rec.text.includes(`rel="canonical" href="${ORIGIN}${sample.url}"`));

// --- the header the CDN actually sends, which is the whole point of this file
/** Uncacheable enough that a deploy is picked up promptly. */
const fresh = (h) => {
  const v = h ?? "";
  if (/no-cache|no-store/.test(v)) return true;
  const m = /max-age=(\d+)/.exec(v);
  return !!m && Number(m[1]) <= 60;
};

const sw = await get("/sw.js");
ok("sw.js is served fresh", fresh(sw.headers.get("cache-control")),
  `served "${sw.headers.get("cache-control")}" — a cached service worker cannot replace itself`);
ok("app.js is served fresh", fresh((await get("/app.js")).headers.get("cache-control")));

// The zone is currently forcing a blanket short TTL, which keeps the app
// fresh but also stops images that never change from being cached at all.
// "Respect Existing Headers" would let _headers set both correctly.
const icon = (await get("/og.png")).headers.get("cache-control") ?? "";
soft("long-lived assets are allowed to cache",
  /max-age=(\d{4,})/.test(icon),
  `og.png served "${icon}" — the zone's blanket TTL is overriding _headers, so a ` +
  `119 KB image re-fetches constantly. Cloudflare → vegbatch.com → Caching → ` +
  `Configuration → Browser Cache TTL → "Respect Existing Headers" lets _headers ` +
  `keep JS fresh AND images cached.`);

// --- the build id changes on deploy, which is what makes cache-first safe
const build = (/const BUILD = "([^"]+)"/.exec(sw.text) || [])[1];
ok("service worker carries a build id", /^\d{14}$/.test(build ?? ""), build);

// --- indexability
const robots = (await get("/robots.txt")).text;
ok("robots allows crawling", /^\s*Allow: \//m.test(robots));
ok("robots names the sitemap", robots.includes(`Sitemap: ${ORIGIN}/sitemap.xml`));
const smap = (await get("/sitemap.xml")).text;
ok("sitemap covers every recipe", (smap.match(/<loc>/g) ?? []).length === idx.length + 1,
  `${(smap.match(/<loc>/g) ?? []).length} vs ${idx.length + 1}`);

// --- every URL we ask search engines to crawl must answer 200 and agree
//     with its own canonical tag.
//
// This exists because all 254 recipes were submitted as redirects for two
// days and nothing noticed. The build wrote `r/<slug>/index.html`; Cloudflare
// Pages serves a directory only at the trailing-slash URL and 308s the bare
// path; and everything else — canonical, sitemap, internal links — used the
// bare path. So each page declared a canonical that was itself a redirect,
// which Search Console reports as "Page with redirect" and does not index as
// submitted. The offline test passed throughout, because it read the built
// file and the file was always right.
//
// Sampled, not exhaustive: 254 round trips per deploy isn't worth it, and the
// failure is systemic — if one is wrong they all are.
{
  const locs = [...smap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  const sampled = [locs[0], ...Array.from({ length: 5 }, () =>
    locs[1 + Math.floor(Math.random() * (locs.length - 1))])];

  const checked = [];
  for (const u of sampled) {
    const res = await fetch(u, { redirect: "manual" });
    const html = res.status === 200 ? await res.text() : "";
    checked.push({
      u, status: res.status,
      canonical: (/rel="canonical" href="([^"]+)"/.exec(html) || [])[1],
      noindex: /<meta[^>]+noindex/i.test(html),
    });
  }
  const redirecting = checked.filter((c) => c.status !== 200);
  ok("no sitemap URL is a redirect", redirecting.length === 0,
    redirecting.map((c) => `${c.status} ${c.u}`).join(", "));
  const mismatched = checked.filter((c) => c.status === 200 && c.canonical !== c.u);
  ok("every sitemap URL is its own canonical", mismatched.length === 0,
    mismatched.map((c) => `${c.u} -> ${c.canonical}`).join(", "));
  ok("no sitemap URL is noindex", checked.every((c) => !c.noindex));
}

// --- everything the service worker precaches must actually be fetchable.
//
// The install adds entries one at a time with a catch, so a bad entry cannot
// break the PWA — which is exactly why a bad entry would never be noticed.
// "/index.html" sat in the list silently 308ing on every install.
{
  const swLive = (await get("/sw.js")).text;
  const list = JSON.parse(/const PRECACHE = (\[[\s\S]*?\]);/.exec(swLive)[1]);
  const broken = [];
  for (const p of list) {
    const res = await fetch(`${ORIGIN}${p}`, { redirect: "manual" });
    if (res.status !== 200) broken.push(`${res.status} ${p}`);
  }
  ok("every precached URL returns 200", broken.length === 0, broken.join(", "));
}

// --- the app's own routes must load directly, not just via client routing.
//
// Got this wrong twice. `_redirects` rewrites to /index.html made Cloudflare
// canonicalise the destination and 308 to the homepage, so refreshing on
// /plan dropped you on Browse and you lost your place — invisible in normal
// use, because in-app navigation is pushState and never touches the server.
// Repointing the rewrite at /app-shell.html just moved the 308. Real files
// (plan.html served at /plan) are what works.
//
// And with no rewrite rules, an unknown path must 404 rather than falling
// through to the shell with a 200 — a soft 404 tells a crawler the page is
// fine when it isn't.
for (const p of ["/plan", "/staples", "/account", "/history", "/feedback"]) {
  const res = await fetch(`${ORIGIN}${p}`, { redirect: "manual" });
  ok(`${p} loads directly without redirecting`, res.status === 200, `got ${res.status}`);
}
for (const p of ["/definitely-not-a-page", "/r/999-not-a-recipe"]) {
  const res = await fetch(`${ORIGIN}${p}`, { redirect: "manual" });
  ok(`${p} is a real 404, not a soft one`, res.status === 404, `got ${res.status}`);
}

// --- nothing private escaped.
// Pages serves the app shell for unknown paths, so a 200 proves nothing —
// check that a real card filename doesn't come back as an image.
const card = await fetch(`${ORIGIN}/cards/PXL_20260919_151919707.jpg`);
ok("no card photos published",
  !(card.headers.get("content-type") ?? "").startsWith("image/"),
  `content-type ${card.headers.get("content-type")}`);
ok("recipe JSON ships no page filenames",
  !(await get(`/data/recipes/${sample.id}.json`)).text.includes("PXL_"));

console.log(`\n${pass} passed, ${fail} failed, ${warn} warnings`);
process.exit(fail ? 1 : 0);
