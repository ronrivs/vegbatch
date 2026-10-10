/**
 * Service worker — the aisle is the point.
 *
 * The job this does is not "make the site fast". It is: you are standing in a
 * supermarket basement with no signal and you need your list. So the plan
 * page, the grocery list and everything they depend on have to work with the
 * network completely gone.
 *
 * BUILD is injected at build time, and the cache name includes it. A deploy
 * therefore creates a brand-new cache and deletes the old one — which is what
 * makes cache-first safe here. A PWA quietly serving last month's recipes
 * forever is worse than no PWA at all.
 */
const BUILD = "__BUILD__";
const CACHE = `vegbatch-${BUILD}`;
const PRECACHE = __PRECACHE__;

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      // addAll is atomic — one 404 and nothing is cached, which would leave
      // the app half-offline in a way that's hard to notice. Add individually
      // so a single missing asset can't sink the whole install.
      .then((c) => Promise.all(PRECACHE.map((u) => c.add(u).catch(() => {}))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const isData = (u) => u.pathname.startsWith("/data/");
/** What the app loads before it can render anything — must never be stale. */
const isBoot = (u) => ["/data/index.json", "/data/filters.json", "/data/ingredients.json"]
  .includes(u.pathname);
const isRecipePage = (u) => u.pathname.startsWith("/r/");

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // never touch outbound shop links

  // Navigations: try the network so a fresh page wins, but fall back to the
  // cached page and finally to the shell, which can render any route itself.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res.ok && isRecipePage(url)) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(request, copy));
          }
          return res;
        })
        .catch(async () =>
          (await caches.match(request)) ||
          // "/", not "/index.html". Cloudflare canonicalises /index.html to
          // / and serves a 308, so it never cached — meaning this fallback
          // always missed and offline navigation fell straight through to
          // the 503 below. The offline shell is the whole point of the PWA,
          // and it had never once been served.
          (await caches.match("/")) ||
          new Response("Offline", { status: 503, headers: { "content-type": "text/plain" } })),
    );
    return;
  }

  // The boot payload decides what the whole app believes exists — the recipe
  // count, the browse grid, the filters. Serving it stale-while-revalidate
  // meant every first load after a deploy showed the PREVIOUS deploy's data,
  // and an open page never re-checked, so new recipes could stay invisible
  // indefinitely. For these two, the network wins when there is one; the cache
  // is the fallback, which is what actually matters in a shop with no signal.
  if (isBoot(url)) {
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(request, copy));
          }
          return res;
        })
        .catch(async () => (await caches.match(request)) ||
          new Response("[]", { status: 200, headers: { "content-type": "application/json" } })),
    );
    return;
  }

  // Individual recipes: serve the cached copy immediately, refresh in the
  // background. There are hundreds of these, they rarely change, and one
  // needs to open instantly when you are standing at the counter.
  if (isData(url)) {
    event.respondWith(
      caches.match(request).then((hit) => {
        const live = fetch(request).then((res) => {
          if (res.ok) caches.open(CACHE).then((c) => c.put(request, res.clone()));
          return res;
        }).catch(() => hit);
        return hit || live;
      }),
    );
    return;
  }

  // Everything else is versioned by the cache name, so cache-first is safe.
  event.respondWith(
    caches.match(request).then((hit) =>
      hit || fetch(request).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copy));
        }
        return res;
      }).catch(() => hit)),
  );
});
