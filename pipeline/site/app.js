/**
 * VegBatch — browse, plan a week, get the grocery list.
 *
 * No framework and no build step: the dataset is static, the app is three
 * views, and hash routing is enough. The grocery arithmetic is imported from
 * lib/grocery.mjs — the very same file the CLI uses, so the list in the
 * browser and the list in the terminal can never disagree.
 */
import { buildList } from "/lib/grocery.mjs";
import { recipeHtml, recipePath } from "/lib/recipe-html.mjs";
import { PITCH, TAGLINE, FREE_LINE } from "/lib/seo.mjs";
import { RETAILERS, searchTerm, DISCLOSURE } from "/lib/shop.mjs";
import { BASE_SERVINGS, SCALES, isBatch, yieldLabel, keepsForAWeek } from "/lib/servings.mjs";
import * as acct from "/lib/account.mjs";

const $ = (s, root = document) => root.querySelector(s);
const el = (tag, props = {}, kids = []) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of [].concat(kids)) if (k != null) n.append(k);
  return n;
};
const view = $("#view");

const state = {
  index: [],
  filters: null,
  catalog: {},
  suggestedStaples: [],   // generic starter offer, never anybody's real list
  full: new Map(),          // id -> full recipe, fetched on demand
  plan: load("vb-plan", []), // [{id, scale}]
  ticked: new Set(load("vb-ticked", [])),
  opts: load("vb-opts", { staples: false, pantry: false, why: false }),
  week: load("vb-week", { recipes: 1, days: 5, people: 2 }),
  // Staples are the user's own — never seeded from anyone else's shop. Empty
  // until this person adds something, per-browser while signed out, and
  // per-household once signed in (Supabase `staples`, RLS by household_id).
  myStaples: load("vb-staples", null),
  cooked: new Map(),   // recipe id -> ISO date last cooked (signed in only)
  photos: new Map(),   // recipe id -> signed URL of your newest photo
};

const staples = () => state.myStaples ?? [];
function saveStaples(items) {
  state.myStaples = items;
  save("vb-staples", items);
  if (acct.user()) acct.pushStaples(items).catch(() => {});
}

/**
 * Storage keys moved from the "vm-" prefix to "vb-" with the rename. Anyone
 * mid-week when this ships still has their plan, staples and ticked items
 * under the old prefix — carry them across once rather than quietly losing
 * someone's shopping list to a rebrand.
 */
function migrateKeys() {
  try {
    for (const name of ["plan", "ticked", "opts", "week", "staples", "rot"]) {
      const from = `vm-${name}`, to = `vb-${name}`;
      if (localStorage.getItem(to) === null && localStorage.getItem(from) !== null) {
        localStorage.setItem(to, localStorage.getItem(from));
      }
      localStorage.removeItem(from);
    }
  } catch { /* private mode — nothing to migrate */ }
}
migrateKeys();

function load(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
}
const savePlan = () => { save("vb-plan", state.plan); paintPlanCount(); syncUp(); };

async function full(id) {
  if (!state.full.has(id)) {
    state.full.set(id, await (await fetch(`/data/recipes/${id}.json`)).json());
  }
  return state.full.get(id);
}

function paintPlanCount() {
  const pill = $("#planCount");
  pill.textContent = state.plan.length;
  pill.hidden = state.plan.length === 0;
}

const tpl = (id) => document.getElementById(id).content.cloneNode(true);

// ============================================================== browse

const browseState = { q: "", vegan: false, course: "", time: "", ing: "" };

/**
 * The homepage hero. The build pre-renders this same copy into index.html so
 * a crawler reads it without running anything; PITCH and TAGLINE come from
 * lib/seo.mjs, which both sides import, so the words exist once.
 */
function hero() {
  const vegan = state.index.filter((r) => r.is_vegan).length;
  const p = el("p", {}, [
    `${PITCH} `,
    el("b", { textContent: `${state.index.length} recipes` }),
    `, ${vegan} of them vegan. ${FREE_LINE}`,
  ]);
  return el("div", { className: "hero" }, [el("h1", { textContent: TAGLINE }), p]);
}

function renderBrowse() {
  view.replaceChildren(tpl("tpl-browse"));
  // same hero the build pre-renders into the homepage — one copy of the words
  view.prepend(hero());

  const course = $("#fCourse");
  for (const c of state.filters.courses) course.append(el("option", { value: c, textContent: c }));
  const ing = $("#fIng");
  for (const i of state.filters.ingredients) {
    ing.append(el("option", { value: i.id, textContent: `${i.name} (${i.count})` }));
  }

  $("#q").value = browseState.q;
  $("#fVegan").checked = browseState.vegan;
  course.value = browseState.course;
  $("#fTime").value = browseState.time;
  ing.value = browseState.ing;

  const onChange = () => {
    browseState.q = $("#q").value.trim().toLowerCase();
    browseState.vegan = $("#fVegan").checked;
    browseState.course = course.value;
    browseState.time = $("#fTime").value;
    browseState.ing = ing.value;
    paintResults();
  };
  for (const node of [$("#q"), $("#fVegan"), course, $("#fTime"), ing]) {
    node.addEventListener(node.tagName === "INPUT" && node.type === "search" ? "input" : "change", onChange);
  }
  $("#clearFilters").onclick = () => {
    Object.assign(browseState, { q: "", vegan: false, course: "", time: "", ing: "" });
    renderBrowse();
  };

  // --- the planner
  const planner = $("#planner");
  const recipesSel = $("#pRecipes"), daysSel = $("#pDays"), peopleSel = $("#pPeople");
  recipesSel.value = state.week.recipes ?? 1;
  daysSel.value = state.week.days ?? 5;
  peopleSel.value = state.week.people ?? 2;

  const describe = () => {
    const n = Number(recipesSel.value), d = Number(daysSel.value), p = Number(peopleSel.value);
    const servings = d * p;
    // Say the multiplier out loud — it is the whole point of a 5-serving base
    // that the reader can check the arithmetic themselves.
    const x = Math.min(4, Math.max(1, Math.ceil(servings / n / BASE_SERVINGS)));
    $("#plannerNote").textContent = n === 1
      ? `${servings} servings — every recipe here serves 5, so that's one recipe at ×${x}. Cook it once on Sunday.`
      : `${n} recipes at ×${x} each — 5 servings apiece as written, chosen to share ingredients.`;
  };
  for (const s of [recipesSel, daysSel, peopleSel]) s.addEventListener("change", describe);
  describe();

  $("#togglePlanner").onclick = () => {
    planner.hidden = !planner.hidden;
    if (!planner.hidden) planner.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
  };
  $("#buildWeek").onclick = () => {
    state.week = { ...state.week, recipes: Number(recipesSel.value) };
    buildWeek({
      recipes: Number(recipesSel.value),
      days: Number(daysSel.value),
      people: Number(peopleSel.value),
    });
  };

  paintResults();
}

function matches(r) {
  if (browseState.vegan && !r.is_vegan) return false;
  if (browseState.course && r.course !== browseState.course) return false;
  if (browseState.time && !(r.total_min && r.total_min <= Number(browseState.time))) return false;
  if (browseState.ing && !r.ing.includes(browseState.ing)) return false;
  if (browseState.q && !r.q.includes(browseState.q)) return false;
  return true;
}

function paintResults() {
  const hits = state.index.filter(matches);
  const active = browseState.q || browseState.vegan || browseState.course || browseState.time || browseState.ing;
  $("#clearFilters").hidden = !active;
  // 76 of the recipes from the card collection never wrote down a time. The
  // time filter can only match what has one, so without saying so it quietly
  // answers a different question than the one asked — "the quick recipes" vs
  // "the quick recipes we happen to have timed". Say which.
  const untimed = browseState.time ? state.index.filter((r) => !r.total_min).length : 0;
  $("#count").replaceChildren(
    `${hits.length} of ${state.index.length} recipes${active ? " — filtered" : ""}`,
    untimed
      ? el("span", { className: "detail", textContent: `  ·  ${untimed} more have no time written down and aren't shown` })
      : null,
  );

  const grid = $("#grid");
  grid.replaceChildren();
  if (!hits.length) {
    grid.append(el("p", { className: "empty", textContent: "Nothing matches. Try fewer filters." }));
    return;
  }
  const inPlan = new Set(state.plan.map((p) => p.id));
  for (const r of hits.slice(0, 300)) {
    grid.append(card(r, inPlan.has(r.id)));
  }
}

/**
 * Recipe tiles are generated, not photographed.
 *
 * There are no pictures of the dishes — these are a household's own cards,
 * and photographs of their handwriting aren't published. Rather than fake a
 * photo, each tile shows something true and useful: the ingredients that
 * actually tell you what the dish is, on a colour field keyed to its course.
 * Hue comes from the course so the grid groups by eye; the angle and the
 * second stop come from the recipe id, so no two tiles are identical.
 */
const COURSE = {
  salad:       { h: 96,  emoji: "🥗" },
  main:        { h: 22,  emoji: "🍲" },
  soup:        { h: 36,  emoji: "🥣" },
  side:        { h: 140, emoji: "🥕" },
  dessert:     { h: 330, emoji: "🍰" },
  breakfast:   { h: 46,  emoji: "🥞" },
  snack:       { h: 270, emoji: "🥨" },
  appetizer:   { h: 200, emoji: "🫒" },
  sauce:       { h: 12,  emoji: "🫙" },
};
const FALLBACK = { h: 210, emoji: "🍽" };

const hash = (s) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
};

function tile(r) {
  const key = (r.course ?? "").toLowerCase().split(" ")[0];
  const { h, emoji } = COURSE[key] ?? FALLBACK;
  const n = hash(r.id + r.title);
  const hue = (h + (n % 21) - 10 + 360) % 360;
  const angle = 120 + (n % 7) * 15;

  const box = el("div", { className: "tile" });
  box.style.setProperty("--h", hue);
  box.style.setProperty("--a", `${angle}deg`);

  // Your own photo beats the generated tile. Until now a photo you took only
  // appeared on the recipe page, so the card looked untouched and the upload
  // looked like it had failed. The generated tile stays as the fallback —
  // it is what everyone without a photo sees, and what a crawler gets.
  const shot = state.photos.get(r.id);
  if (shot) {
    box.classList.add("has-photo");
    box.append(el("img", { src: shot, loading: "lazy", alt: "", decoding: "async" }));
  }

  box.append(el("span", { className: "tile-glyph", textContent: emoji, "aria-hidden": "true" }));
  if (!shot) {
    box.append(el("span", {
      className: "tile-ing",
      textContent: (r.headline ?? []).join(" · "),
    }));
  }
  return box;
}

function card(r, chosen) {
  const tags = [];
  if (r.is_vegan) tags.push(el("span", { className: "tag", textContent: "vegan" }));
  if (r.total_min) tags.push(el("span", { className: "tag plain", textContent: `${r.total_min} min` }));
  if (r.course) tags.push(el("span", { className: "tag plain", textContent: r.course }));
  // The rotation signal, made visible: knowing you had this three weeks ago
  // is most of what stops a week repeating itself.
  const cookedOn = state.cooked?.get(r.id);
  if (cookedOn) tags.push(el("span", { className: "tag cooked", textContent: acct.sinceLabel(cookedOn) }));

  return el("a", { className: `card${chosen ? " chosen" : ""}`, href: recipePath(r) }, [
    tile(r),
    el("div", { className: "body" }, [
      el("h3", { textContent: r.title }),
      el("p", { textContent: r.description ?? "" }),
      el("div", { className: "tags" }, tags),
    ]),
  ]);
}

// ============================================================== recipe

/**
 * Recipe pages are pre-rendered at build time, so on a direct visit the
 * markup is already in the document — do not throw it away and rebuild it.
 * Client-side navigation uses recipeHtml(), the same function the build used,
 * so both paths produce identical markup.
 */
async function renderRecipe(id, { prerendered = false } = {}) {
  const r = await full(id);
  if (!r) { go("/"); return; }
  if (!prerendered) view.innerHTML = recipeHtml(r);
  document.title = `${r.title} — ${r.is_vegan ? "vegan" : "vegetarian"} recipe | VegBatch`;
  wireRecipe(r);
}

/** Attach the behaviour that only exists with JavaScript. */
function wireRecipe(r) {
  const addBtn = $("#addBtn");
  if (!addBtn) return;
  if (acct.user()) addCookedControls(r);
  if (acct.enabled()) renderPhotos(r);
  const sync = () => {
    const inPlan = state.plan.some((p) => p.id === r.id);
    addBtn.textContent = inPlan ? "✓ In this week — remove" : "Add to this week";
    addBtn.className = inPlan ? "ghost" : "primary";
  };
  addBtn.onclick = () => {
    const i = state.plan.findIndex((p) => p.id === r.id);
    if (i === -1) state.plan.push({ id: r.id, scale: Number($("#rScale")?.value ?? 1) });
    else state.plan.splice(i, 1);
    savePlan();
    sync();
  };
  sync();
}


/** "I made this" — one tap, because anything more won't get used. */
function addCookedControls(r) {
  const actions = $(".recipe .actions");
  if (!actions || $("#cookedBtn")) return;
  const btn = el("button", { id: "cookedBtn", className: "ghost" });
  const paint = () => {
    const on = state.cooked.get(r.id);
    btn.textContent = on ? `✓ ${acct.sinceLabel(on)}` : "I cooked this";
  };
  btn.onclick = async () => {
    btn.disabled = true;
    if (await acct.markCooked(r.id)) {
      state.cooked.set(r.id, new Date().toISOString().slice(0, 10));
      paint();
    }
    btn.disabled = false;
  };
  paint();
  actions.append(btn);
}

/**
 * Photos of how yours actually turned out.
 *
 * Private to the household by default. The share toggle exists from day one
 * even though there is no public gallery yet — consent is the part that is
 * painful to retrofit, and adding it later would mean asking everyone again.
 */
async function renderPhotos(r) {
  const body = $(".recipe-body");
  if (!body || $("#photos")) return;
  const box = el("section", { id: "photos", className: "photos" });
  body.after(box);

  const paint = async () => {
    const photos = await acct.listPhotos(r.id);
    box.replaceChildren(el("h2", { textContent: photos.length ? `Photos (${photos.length})` : "Photos" }));

    const shown = photos.filter((p) => p.url);
    const unreadable = photos.length - shown.length;

    if (shown.length) {
      const strip = el("div", { className: "photo-strip" });
      for (const p of shown) {
        const fig = el("figure", {}, [
          el("img", { src: p.url, loading: "lazy", alt: p.caption ?? `${r.title}, photographed by a cook` }),
        ]);
        if (p.mine) {
          const del = el("button", { className: "photo-x", textContent: "×", title: "Remove" });
          del.onclick = async () => { await acct.deletePhoto(p); paint(); };
          fig.append(del);
        }
        strip.append(fig);
      }
      box.append(strip);
    }
    // Saying nothing here is what made an upload look like it had vanished.
    if (unreadable) {
      box.append(el("p", { className: "acct-error" },
        [`${unreadable} photo${unreadable > 1 ? "s are" : " is"} saved but couldn't be loaded just now. `
         + "They're still there — try reloading."]));
    }

    if (!acct.user()) {
      box.append(el("p", { className: "fineprint" }, [
        el("a", { href: "/account", textContent: "Sign in" }), " to add your own photo.",
      ]));
      return;
    }

    const file = el("input", { type: "file", accept: "image/*", id: "photoFile" });
    const pub = el("input", { type: "checkbox", id: "photoPublic" });
    const status = el("span", { className: "fineprint" });
    const send = el("button", { className: "primary", textContent: "Add photo" });
    send.onclick = async () => {
      if (!file.files?.[0]) return;
      send.disabled = true;
      status.textContent = "Uploading…";
      const res = await acct.uploadPhoto(r.id, file.files[0], { isPublic: pub.checked });
      status.textContent = res.error ? `Couldn't upload: ${res.error}` : "";
      send.disabled = false;
      if (!res.error) paint();
    };
    box.append(el("div", { className: "photo-add" }, [
      file,
      el("label", { className: "chk" }, [pub, "Let other people see this"]),
      send, status,
    ]));
  };
  paint();
}

// ============================================================== account

/**
 * Accounts add sync and history. They gate nothing — every recipe, the
 * planner and the list work signed out, and that is a promise the homepage
 * and llms.txt both make.
 *
 * On first sign-in whatever is in localStorage is pushed up rather than
 * replaced. Losing a staples list you spent a month building, as a reward
 * for signing in, would be unforgivable.
 */
async function adoptLocalData() {
  const localStaples = state.myStaples;
  const remote = await acct.pullStaples();
  if (localStaples?.length && !remote?.length) await acct.pushStaples(localStaples);
  else if (remote?.length) { state.myStaples = remote; save("vb-staples", remote); }

  const remotePlan = await acct.pullPlan();
  if (state.plan.length && !remotePlan?.recipes?.length) {
    await acct.pushPlan({
      recipes: state.plan, ticked: [...state.ticked], options: state.opts,
      days: state.week.days, people: state.week.people,
    });
  } else if (remotePlan?.recipes?.length) {
    state.plan = remotePlan.recipes;
    state.ticked = new Set(remotePlan.ticked ?? []);
    state.opts = { ...state.opts, ...(remotePlan.options ?? {}) };
    state.week = { ...state.week, days: remotePlan.days, people: remotePlan.people };
    save("vb-plan", state.plan);
    save("vb-ticked", [...state.ticked]);
    paintPlanCount();
  }
  // Shopping history merges rather than replaces: lists saved in this browser
  // before signing in are real shops and must not vanish. Match on saved_at —
  // two lists saved at the same millisecond are the same list.
  const remoteLists = await acct.pullLists();
  const remoteTimes = new Set(remoteLists.map((l) => l.saved_at));
  const localOnly = savedLists().filter((l) => !remoteTimes.has(l.saved_at));
  const pushed = [];
  for (const l of localOnly.slice(0, HISTORY_CAP)) {
    pushed.push((await acct.pushList(l).catch(() => null)) ?? l);
  }
  saveLists([...pushed, ...remoteLists]
    .sort((a, b) => (a.saved_at < b.saved_at ? 1 : -1)));

  state.cooked = await acct.pullCookHistory();
  state.photos = await acct.photoThumbs();
}

/** Mirror local changes up when signed in. Never blocks the UI. */
function syncUp() {
  if (!acct.user()) return;
  acct.pushPlan({
    recipes: state.plan, ticked: [...state.ticked], options: state.opts,
    days: state.week.days, people: state.week.people,
  }).catch(() => {});
}

function paintNav() {
  const a = $("#navAccount");
  if (!a) return;
  if (!acct.enabled()) { a.hidden = true; return; }
  a.textContent = acct.user() ? "Account" : "Sign in";
}

/**
 * A permanent home for installing the app.
 *
 * The floating banner is easy to miss and, once dismissed, gone for a month.
 * Uninstalling the app doesn't bring it back either. So there is always a
 * way to install from a page you can navigate to on purpose — which is how
 * anyone actually looks for this after deleting an icon by accident.
 */
function installSection() {
  const host = document.querySelector('[data-when="in"]:not([hidden])')
    ?? document.querySelector('[data-when="out"]:not([hidden])');
  if (!host || $("#installHere")) return;

  const box = el("section", { id: "installHere", className: "install-block" });
  const android = /Android/.test(navigator.userAgent);
  const ios = /iP(hone|ad|od)/.test(navigator.userAgent);

  if (installed()) {
    // "Installed" on its own is useless to the person who deleted the icon
    // by accident — removing a shortcut does not uninstall a PWA, so the
    // browser will never re-offer installation. Say where the app actually
    // lives instead.
    box.append(
      el("h2", { textContent: "Installed" }),
      el("p", { className: "fineprint", textContent: "VegBatch is installed on this device." }),
      android
        ? el("p", { className: "fineprint" }, [
            "Lost the icon? Deleting a shortcut doesn't uninstall the app. Open your ",
            el("b", { textContent: "app drawer" }),
            " (swipe up), press and hold ", el("b", { textContent: "VegBatch" }),
            ", then drag it to your home screen.",
          ])
        : ios
          ? el("p", { className: "fineprint" }, [
              "Lost the icon? In Safari, tap ", el("b", { textContent: "Share" }),
              " then ", el("b", { textContent: "Add to Home Screen" }), " again.",
            ])
          : el("p", { className: "fineprint", textContent: "Launch it from your applications list." }),
    );
  } else if (installEvent) {
    const b = el("button", { className: "ghost", textContent: "Install app" });
    b.onclick = async () => {
      installEvent.prompt();
      await installEvent.userChoice;
      installEvent = null;
      renderAccount();
    };
    box.append(el("h2", { textContent: "Use it like an app" }),
      el("p", { className: "fineprint", textContent: "Adds VegBatch to your home screen and lets your list work with no signal — useful in a shop." }),
      b);
  } else {
    // Either iOS, where no prompt event exists, or Chromium has already
    // used its one prompt. Tell people the manual route rather than nothing.
    box.append(
      el("h2", { textContent: "Use it like an app" }),
      el("p", { className: "fineprint" }, ios
        ? ["In Safari, tap ", el("b", { textContent: "Share" }), " then ", el("b", { textContent: "Add to Home Screen" }), "."]
        : ["In your browser menu, choose ", el("b", { textContent: "Install app" }), " or ", el("b", { textContent: "Add to Home screen" }), "."]),
    );
  }
  host.append(box);
}

function renderAccount() {
  view.replaceChildren(tpl("tpl-account"));
  document.title = "Your account | VegBatch";
  const signedIn = !!acct.user();
  $('[data-when="out"]').hidden = signedIn;
  $('[data-when="in"]').hidden = !signedIn;

  if (!acct.enabled()) {
    view.replaceChildren(el("p", { className: "empty", textContent: "Accounts aren't switched on yet." }));
    return;
  }

  if (!signedIn) {
    $("#signIn").onclick = () => acct.signIn();
    installSection();
    return;
  }

  $("#acctWho").textContent = `Signed in as ${acct.user().email}.`;
  const stats = $("#acctStats");
  stats.replaceChildren(
    el("div", { className: "stat" }, [el("b", { textContent: String(staples().length) }), " staples"]),
    el("div", { className: "stat" }, [el("b", { textContent: String(state.plan.length) }), " recipes planned"]),
    el("div", { className: "stat" }, [el("b", { textContent: String(state.cooked?.size ?? 0) }), " recipes cooked"]),
  );

  installSection();
  $("#signOut").onclick = async () => { await acct.signOut(); go("/"); };
  $("#deleteAll").onclick = async () => {
    if (!confirm(
      "Delete your account and everything in it?\n\n"
      + "Your staples, saved lists, cook history, photos and the account "
      + "itself are removed for good. This cannot be undone.")) return;

    const btn = $("#deleteAll");
    btn.disabled = true;
    btn.textContent = "Deleting…";
    const gone = await acct.deleteEverything();
    if (!gone) {
      // Say so rather than signing out, which would look like it worked and
      // leave the account standing with no way back in to try again.
      btn.disabled = false;
      btn.textContent = "Delete my data";
      $("#acctError")?.remove();
      $(".acct-actions")?.after(el("p", {
        id: "acctError", className: "acct-error",
        textContent: "Your account could not be deleted — nothing was removed. "
          + "Check your connection and try again; if it keeps failing, email us and we'll do it by hand.",
      }));
      return;
    }
    await acct.signOut();
    go("/");
  };
}

// ============================================================== staples

const AISLES = [
  "produce", "bakery", "dairy", "eggs", "refrigerated", "frozen", "canned",
  "grains and pasta", "dry goods", "nuts and seeds", "baking", "spices",
  "condiments", "oils and vinegars", "international", "beverages", "other",
];

function renderStaples() {
  view.replaceChildren(tpl("tpl-staples"));
  document.title = "Staples · VegBatch";

  const aisleSel = $("#sAisle");
  for (const a of AISLES) aisleSel.append(el("option", { value: a, textContent: a }));
  aisleSel.value = "produce";

  $("#stapleAdd").onsubmit = (e) => {
    e.preventDefault();
    const item = $("#sItem").value.trim();
    if (!item) return;
    const list = [...staples()];
    const existing = list.find((s) => s.item.toLowerCase() === item.toLowerCase());
    const entry = {
      item,
      qty: Number($("#sQty").value) || 1,
      unit: $("#sUnit").value.trim() || null,
      aisle: aisleSel.value,
      note: null,
      // only an exact catalog match may claim identity — a loose one turned
      // "oat milk" into "milk" when this ran in the CLI
      canonical: state.catalog[item.toLowerCase()]?.id ?? null,
      active: true,
    };
    if (existing) Object.assign(existing, entry);
    else list.push(entry);
    saveStaples(list);
    $("#stapleAdd").reset();
    $("#sQty").value = 1;
    renderStaples();
    $("#sItem").focus();
  };

  paintStaples();
}

/**
 * Say where this list is being kept. Someone is about to type out their whole
 * weekly shop; they should know before they start whether it survives a new
 * phone. route() re-runs on sign-in, so this repaints itself.
 */
function paintStapleWhere() {
  const where = $("#stapleWhere");
  if (!where) return;
  where.replaceChildren();
  if (!acct.enabled()) return;

  if (acct.user()) {
    where.append("Saved to your account — the same list on every device you sign in on.");
  } else {
    where.append(
      "Saved in this browser only. A new phone, another browser, or cleared history starts over. ",
      el("a", { href: "/account", textContent: "Sign in" }),
      " to keep them, and to share one list with whoever you cook with.",
    );
  }
}

function paintStaples() {
  paintStapleWhere();
  const box = $("#stapleList");
  box.replaceChildren();
  const list = staples();

  if (!list.length) {
    // An empty list is the correct starting point — these are your groceries,
    // not ours. But a blank page is a dead end, so offer a starter anyone can
    // edit down, clearly labelled as a suggestion rather than a saved list.
    box.append(el("p", { className: "empty", textContent: "No staples yet. Add the things you buy every week, whatever you're cooking." }));
    if (state.suggestedStaples.length) {
      box.append(
        el("p", { className: "fineprint", textContent: "Not sure where to start? These are common ones — add them, then edit or remove whatever doesn't fit." }),
        el("button", {
          className: "ghost",
          textContent: "Add common staples",
          onclick: () => {
            saveStaples(state.suggestedStaples.map((s) => ({ ...s, active: true })));
            paintStaples();
          },
        }),
      );
    }
    return;
  }

  const active = list.filter((s) => s.active).length;
  box.append(el("p", { className: "count", textContent: `${active} on the weekly list · ${list.length} saved` }));

  const byAisle = new Map();
  for (const s of list) {
    if (!byAisle.has(s.aisle ?? "other")) byAisle.set(s.aisle ?? "other", []);
    byAisle.get(s.aisle ?? "other").push(s);
  }

  for (const aisle of AISLES.filter((a) => byAisle.has(a))) {
    const ul = el("ul", { className: "staple-rows" });
    for (const s of byAisle.get(aisle).sort((a, b) => a.item.localeCompare(b.item))) {
      const on = el("input", { type: "checkbox", checked: s.active });
      on.onchange = () => { s.active = on.checked; saveStaples(staples()); paintStaples(); };

      const qty = el("input", { className: "sq", type: "number", min: "0", step: "0.5", value: s.qty });
      qty.onchange = () => { s.qty = Number(qty.value) || 1; saveStaples(staples()); };

      const remove = el("button", { className: "ghost", textContent: "Remove" });
      remove.onclick = () => {
        saveStaples(staples().filter((x) => x !== s));
        paintStaples();
      };

      ul.append(el("li", { className: s.active ? "" : "off" }, [
        on, qty,
        el("span", { className: "su", textContent: s.unit ?? "" }),
        el("span", { className: "sn", textContent: s.item }),
        s.note ? el("span", { className: "detail", textContent: s.note }) : null,
        remove,
      ]));
    }
    box.append(el("div", { className: "aisle" }, [el("h3", { textContent: aisle }), ul]));
  }

  if (state.myStaples) {
    const reset = el("button", { className: "ghost", textContent: "Reset to the household list" });
    reset.onclick = () => {
      if (!confirm("Discard your changes and go back to the shipped staples list?")) return;
      state.myStaples = null;
      localStorage.removeItem("vb-staples");
      renderStaples();
    };
    box.append(el("p", { className: "legend" }, [reset]));
  }
}

// ============================================================== plan

async function renderPlan() {
  view.replaceChildren(tpl("tpl-plan"));
  document.title = "This week · VegBatch";

  const rows = $("#planRecipes");
  const ownStaples = staples().filter((s) => s.active).length;

  if (!state.plan.length) {
    rows.append(el("p", { className: "empty" }, [
      "Nothing planned yet. ",
      el("a", { href: "/", textContent: "Pick some recipes" }),
      " — or let the app choose four that share ingredients.",
    ]));

    // A staples-only shop is a real shop. The page used to stop here, which
    // meant the only way to get your weekly staples onto a list was to plan a
    // recipe you didn't want. With staples saved, the list builds from them
    // alone; the recipe-only controls stay hidden because there is no week to
    // clear and nothing to attribute lines to.
    if (!ownStaples) {
      rows.append(el("p", { className: "fineprint" }, [
        "Just want your weekly staples on a list? ",
        el("a", { href: "/staples", textContent: "Add some staples" }),
        " and they can be shopped on their own, no recipe needed.",
      ]));
      return;
    }

    $("#listOpts").hidden = false;
    $("#clearPlan").hidden = true;
    $("#optWhy").closest("label").hidden = true;
    bindListOpts();

    if (!state.opts.staples) {
      rows.append(el("p", { className: "fineprint", textContent:
        `You have ${ownStaples} weekly staple${ownStaples === 1 ? "" : "s"} — tick "Add weekly staples" to shop just those.` }));
      $("#groceries").replaceChildren();
      return;
    }
    renderGroceries([]);
    return;
  }

  $("#listOpts").hidden = false;
  const chosen = await Promise.all(state.plan.map((p) => full(p.id)));

  // Every meal recipe is 5 servings as written, so the week is just addition.
  const totalServings = state.plan.reduce((s, p, i) => (
    isBatch(chosen[i]) ? s : s + BASE_SERVINGS * p.scale
  ), 0);
  const w = state.week;
  rows.append(el("p", { className: "week-sum" }, [
    el("b", { textContent: `${totalServings} servings` }),
    w?.days ? ` — ${w.days} days for ${w.people}` : "",
  ]));

  for (const [i, p] of state.plan.entries()) {
    const r = chosen[i];
    const sel = el("select");
    for (const v of SCALES) {
      sel.append(el("option", { value: v, textContent: `×${v}`, selected: v === p.scale }));
    }
    sel.onchange = () => { p.scale = Number(sel.value); savePlan(); renderPlan(); };

    const remove = el("button", { className: "ghost", textContent: "Remove" });
    remove.onclick = () => { state.plan.splice(i, 1); savePlan(); renderPlan(); };

    // A batch recipe keeps whatever the card said it makes; a meal says what
    // this scale comes to, which is the number the planner is reasoning about.
    rows.append(el("div", { className: "plan-row" }, [
      el("a", { href: recipePath(r), textContent: r.title }),
      el("span", {
        className: "detail",
        textContent: yieldLabel(r, p.scale) ?? "",
      }),
      sel, remove,
    ]));
  }
  // A week is rarely one dish; without this the only way back to the
  // collection from a populated plan was the header nav.
  rows.append(el("p", { className: "fineprint" }, [
    el("a", { href: "/", textContent: "+ Add another recipe" }),
    " — open any recipe and tap “Add to this week”.",
  ]));

  bindListOpts();
  $("#clearPlan").onclick = () => {
    if (!confirm("Clear this week's plan?")) return;
    state.plan = []; state.ticked.clear();
    savePlan(); save("vb-ticked", []);
    renderPlan();
  };

  renderGroceries(chosen.map((r, i) => ({ ...r, scale: state.plan[i].scale })));
}

/** The list toggles and buttons, shared by the recipe week and a staples-only shop. */
function bindListOpts() {
  for (const [key, id] of [["staples", "#optStaples"], ["pantry", "#optPantry"], ["why", "#optWhy"]]) {
    const box = $(id);
    box.checked = state.opts[key];
    box.onchange = () => { state.opts[key] = box.checked; save("vb-opts", state.opts); renderPlan(); };
  }
  $("#printBtn").onclick = () => window.print();
  $("#saveList").onclick = saveCurrentList;
}

// ============================================================== history

/**
 * Saved shopping lists.
 *
 * A saved list stores its rendered lines, not a recipe reference. A record of
 * a past shop has to stay true after a recipe is edited, a pack size
 * corrected, or the scaling model changed — all of which have now happened at
 * least once. Re-deriving the list on read would quietly rewrite history; a
 * frozen copy keeps it a record rather than a guess. The plan rides along so
 * a good week can still be reloaded.
 *
 * Browser-local while signed out, per-household once signed in, same as
 * staples. Capped so a year of weekly shops can't fill localStorage.
 */
const HISTORY_CAP = 60;
const savedLists = () => load("vb-history", []);

function saveLists(list) {
  save("vb-history", list.slice(0, HISTORY_CAP));
}

function snapshotList(list, chosen) {
  const now = new Date();
  return {
    id: `local-${now.getTime()}`,
    saved_at: now.toISOString(),
    title: chosen.map((r) => r.title).join(", ") || "Weekly staples",
    recipes: chosen.map((r) => ({ id: r.id, title: r.title, scale: r.scale })),
    options: { ...state.opts },
    items: list.items.map((e) => ({
      key: e.key,
      qty: e.purchase.main,
      label: e.label,
      detail: e.purchase.detail,
      aisle: e.ingredient?.aisle ?? null,
      ticked: state.ticked.has(e.key),
    })),
    n_items: list.items.length,
    n_ticked: list.items.filter((e) => state.ticked.has(e.key)).length,
  };
}

async function saveCurrentList() {
  if (!state.lastList?.items?.length) return;
  const snap = snapshotList(state.lastList, state.lastChosen ?? []);
  let stored = snap;
  if (acct.user()) {
    // Take the server's row so the id is the real one and a later delete works
    stored = (await acct.pushList(snap).catch(() => null)) ?? snap;
  }
  saveLists([stored, ...savedLists()]);

  const btn = $("#saveList");
  if (btn) {
    btn.textContent = "Saved ✓";
    btn.disabled = true;
    setTimeout(() => { btn.textContent = "Save this list"; btn.disabled = false; }, 2500);
  }
}

const dateLabel = (iso) => new Date(iso).toLocaleDateString(undefined,
  { year: "numeric", month: "short", day: "numeric" });

function renderHistory() {
  view.replaceChildren(tpl("tpl-history"));
  document.title = "Shopping history | VegBatch";

  const where = $("#historyWhere");
  if (acct.enabled() && where) {
    if (acct.user()) {
      where.append("Saved to your account — the same history on every device you sign in on.");
    } else {
      where.append(
        "Saved in this browser only. ",
        el("a", { href: "/account", textContent: "Sign in" }),
        " to keep your history and share it with whoever you cook with.",
      );
    }
  }

  const box = $("#historyList");
  const lists = savedLists();
  if (!lists.length) {
    box.append(el("p", { className: "empty" }, [
      "No saved lists yet. Build a week, then use ",
      el("b", { textContent: "Save this list" }),
      " on the week page to keep a record of the shop.",
    ]));
    return;
  }

  for (const entry of lists) {
    const head = el("div", { className: "hist-head" }, [
      el("b", { textContent: dateLabel(entry.saved_at) }),
      el("span", {
        className: "detail",
        textContent: `${entry.n_items} items${entry.n_ticked ? ` · ${entry.n_ticked} ticked off` : ""}`,
      }),
    ]);

    const load_ = el("button", { className: "ghost", textContent: "Load into this week" });
    load_.onclick = () => {
      if (!entry.recipes?.length) return;
      state.plan = entry.recipes.map((r) => ({ id: r.id, scale: r.scale }));
      state.ticked = new Set();
      state.opts = { ...state.opts, ...(entry.options ?? {}) };
      savePlan();
      save("vb-ticked", []);
      go("/plan");
    };

    const del = el("button", { className: "ghost danger", textContent: "Delete" });
    del.onclick = async () => {
      saveLists(savedLists().filter((h) => h.id !== entry.id));
      if (acct.user() && !String(entry.id).startsWith("local-")) {
        await acct.deleteList(entry.id).catch(() => {});
      }
      renderHistory();
    };

    const items = el("ul", { className: "hist-items" }, entry.items.map((i) => el("li", {
      className: i.ticked ? "got" : "",
    }, [
      el("span", { className: "qty", textContent: i.qty }),
      el("span", { textContent: ` ${i.label}` }),
    ])));

    box.append(el("details", { className: "hist-card" }, [
      el("summary", {}, [head]),
      entry.title ? el("p", { className: "hist-recipes", textContent: entry.title }) : null,
      items,
      el("div", { className: "hist-actions" }, [load_, del]),
    ]));
  }
}

// ============================================================== feedback

function renderFeedback() {
  view.replaceChildren(tpl("tpl-feedback"));
  document.title = "Send feedback | VegBatch";

  const form = $("#fbForm"), status = $("#fbStatus"), send = $("#fbSend");
  // Signed in? Save them the typing — but leave both editable.
  const u = acct.user();
  if (u) {
    $("#fbEmail").value = u.email ?? "";
    $("#fbName").value = u.user_metadata?.full_name ?? u.user_metadata?.name ?? "";
  }

  form.onsubmit = async (e) => {
    e.preventDefault();
    // A filled honeypot means a bot. Say "thanks" and drop it — telling it
    // that it was caught only teaches whoever wrote it.
    if ($("#fbTrap").value) { status.textContent = "Thanks — that's on its way."; form.reset(); return; }

    const name = $("#fbName").value.trim();
    const email = $("#fbEmail").value.trim();
    const message = $("#fbMessage").value.trim();
    if (!name || !email || !message) {
      status.textContent = "Please fill in your name, email and a message.";
      return;
    }

    send.disabled = true;
    status.textContent = "Sending…";
    const res = await acct.sendFeedback({
      name, email, message,
      kind: $("#fbKind").value,
      // where they were when it went wrong is usually the first thing you
      // want to know and the last thing anyone remembers to say
      page: sessionStorage.getItem("vb-last-page") ?? location.pathname,
    });
    send.disabled = false;

    if (res.error) {
      status.textContent = "That didn't send. Try again, or email ron@trib.xyz directly.";
      return;
    }
    form.replaceWith(el("p", { className: "fb-done" }, [
      "Thanks — ",
      el("a", { href: "https://trib.xyz", rel: "noopener", textContent: "Tributary" }),
      " has it. If they need further clarification they'll reply to ",
      el("b", { textContent: email }), ".",
    ]));
  };
}

function renderGroceries(chosen) {
  const list = buildList({
    recipes: chosen,
    catalog: state.catalog,
    staples: staples(),
    options: { includeStaples: state.opts.staples, includePantry: state.opts.pantry },
  });
  // kept so "Save this list" freezes exactly what is on screen
  state.lastList = list;
  state.lastChosen = chosen;

  const box = $("#groceries");
  box.replaceChildren();
  box.append(el("h2", { textContent: `${chosen.length ? "Grocery list" : "Weekly staples"} — ${list.items.length} items` }));

  const cols = el("div", { className: "groceries-cols" });
  for (const group of list.byAisle) {
    const ul = el("ul", { className: "buy" });
    for (const e of group.items) {
      const id = `t:${e.key}`;
      const check = el("input", { type: "checkbox", checked: state.ticked.has(id) });
      const li = el("li", { className: state.ticked.has(id) ? "got" : "" }, [
        check,
        el("span", { className: "qty", textContent: e.purchase.main }),
        el("span", {}, [
          e.label,
          e.purchase.detail ? el("span", { className: "detail", textContent: `  ${e.purchase.detail}` }) : null,
          el("span", {
            className: "marks",
            textContent: ` ${e.estimated ? "~" : ""}${e.sharedAcross > 1 ? "◆" : ""}${e.staple ? "★" : ""}`,
          }),
        ]),
      ]);
      check.onchange = () => {
        state.ticked[check.checked ? "add" : "delete"](id);
        save("vb-ticked", [...state.ticked]);
        li.classList.toggle("got", check.checked);
      };
      if (state.opts.why) {
        for (const s of e.sources) li.append(el("span", { className: "why", textContent: `← ${s.recipe}: ${s.raw}` }));
      }
      ul.append(li);
    }
    cols.append(el("div", { className: "aisle" }, [el("h3", { textContent: group.aisle }), ul]));
  }
  box.append(cols);

  if (list.shared.length) {
    box.append(el("div", { className: "callout" }, [
      el("h3", { textContent: `Shared across recipes (${list.shared.length})` }),
      list.shared.slice(0, 8).map((e) => `${e.ingredient.name} (${e.sharedAcross})`).join(", "),
      el("div", { style: "margin-top:.4rem;color:var(--muted)", textContent: "Buying these once covers several meals." }),
    ]));
  }
  if (list.pantry.length && !state.opts.pantry) {
    box.append(el("div", { className: "callout" }, [
      el("h3", { textContent: `Assumed in the pantry (${list.pantry.length})` }),
      list.pantry.map((e) => e.ingredient.name).sort().join(", "),
    ]));
  }
  if (list.toCheck.length) {
    box.append(el("div", { className: "callout" }, [
      el("h3", { textContent: "To taste / no quantity given" }),
      list.toCheck.map((t) => t.name).join(", "),
    ]));
  }
  box.append(el("p", { className: "legend", textContent: "◆ used in more than one recipe   ~ quantity estimated from the card   ★ from your weekly staples" }));
  renderShop(box, list);
}

/**
 * Shop this list.
 *
 * Search links, not product links — no SKU catalogue to build or maintain.
 * Collapsed by default: most people take the list into a shop, and this
 * shouldn't push the actual list down the page. The disclosure sits with the
 * links, not buried in a footer, because that's what honesty and the FTC both
 * want.
 */
function renderShop(box, list) {
  if (!list.items.length) return;

  const details = el("details", { className: "shop" });
  details.open = load("vb-shop-open", false);
  details.addEventListener("toggle", () => save("vb-shop-open", details.open));

  const rows = el("div", { className: "shop-rows" });
  for (const e of list.items) {
    const q = searchTerm(e);
    rows.append(el("div", { className: "shop-row" }, [
      el("span", { className: "shop-item", textContent: `${e.purchase.main} ${e.label}` }),
      ...RETAILERS.map((r) => {
        const a = el("a", {
          className: "shop-link",
          href: r.url(q),
          target: "_blank",
          rel: "nofollow sponsored noopener",
          textContent: r.name,
        });
        // the one measurement that decides whether a real cart integration
        // is ever worth building
        a.addEventListener("click", () => acct.logClick(r.id, q));
        return a;
      }),
    ]));
  }

  details.append(
    el("summary", { textContent: `Shop this list online — ${list.items.length} items` }),
    el("p", { className: "shop-note", textContent: DISCLOSURE }),
    rows,
  );
  box.append(details);
}

/**
 * Build a week.
 *
 * This household meal preps: they cook one thing and eat it for five days.
 * So the default is one recipe scaled to cover the week, not four different
 * dinners — that was a consumer-shaped assumption and the wrong one. Asking
 * for more than one recipe brings back the overlap-aware pick, because the
 * moment there's more than one dish, sharing ingredients is what saves money.
 *
 * Recipes without a written yield (63 of them, mostly the handwritten cards)
 * are assumed to serve four. The plan page says so rather than hiding it.
 */
// serving model lives in lib/servings.mjs — see there for why everything is 5

/** How well a recipe suits cooking once and eating all week. */
function prepScore(r) {
  const course = (r.course ?? "").toLowerCase();
  if (/dessert|snack|sauce|appetizer/.test(course)) return -5;
  let s = /main|soup|lunch/.test(course) ? 3 : /salad|side|breakfast/.test(course) ? 1 : 0;
  if (r.n_ingredients >= 6) s += 1;   // substantial enough to be a meal
  return s;
}

function buildWeek({ recipes: want, days, people }) {
  const servings = days * people;
  // keepsForAWeek is the hard filter, not a score: a recipe that says "serve
  // immediately" cannot be the answer to "cook once, eat all week", however
  // well it otherwise scores.
  const pool = state.index.filter((r) =>
    r.ing.length >= 3 && prepScore(r) >= 0 && keepsForAWeek(r));
  if (!pool.length) return;

  // weight the opening pick toward things that actually reheat as a week of
  // lunches, rather than landing on a batch of biscotti
  const weighted = pool.flatMap((r) => Array(1 + Math.max(0, prepScore(r))).fill(r));
  const picked = [weighted[Math.floor(Math.random() * weighted.length)]];
  const have = new Set(picked[0].ing);

  while (picked.length < want) {
    let best = null, bestScore = -1;
    for (const r of pool) {
      if (picked.includes(r)) continue;
      const overlap = r.ing.filter((i) => have.has(i)).length;
      // favour overlap, but not so hard that it picks near-identical salads
      const score = overlap - r.ing.length * 0.12 + prepScore(r) * 0.3 + Math.random() * 0.5;
      if (score > bestScore) { bestScore = score; best = r; }
    }
    if (!best) break;
    picked.push(best);
    for (const i of best.ing) have.add(i);
  }

  // Every recipe is 5 servings as written, so the multiplier is whole and
  // obvious: 10 servings across one recipe is ×2. Round up — a short week is
  // a worse failure than a container of leftovers.
  const each = servings / picked.length;
  const scale = Math.min(Math.max(...SCALES), Math.max(1, Math.ceil(each / BASE_SERVINGS)));
  state.plan = picked.map((r) => ({ id: r.id, scale }));
  // keep `recipes` — dropping it reset the picker to 1 on every visit
  state.week = { recipes: want, days, people, servings };
  save("vb-week", state.week);
  savePlan();
  go("/plan");
}

// ============================================================== routing

/**
 * Real paths, not hash fragments.
 *
 * Every recipe is a genuine URL backed by a pre-rendered file, so a crawler
 * — or a person with JavaScript off — gets the whole recipe from the server.
 * `/plan` and `/staples` have no pre-rendered file and fall back to the shell
 * via _redirects; they're per-visitor tools with nothing to index.
 */
function go(href, { replace = false } = {}) {
  if (replace) history.replaceState({}, "", href);
  else history.pushState({}, "", href);
  return route();
}

/** First paint only: the server already sent the right markup. */
let booted = false;

async function route() {
  const p = location.pathname;
  for (const a of document.querySelectorAll("[data-nav]")) a.classList.remove("on");
  const nav = (k) => document.querySelector(`[data-nav="${k}"]`)?.classList.add("on");

  const m = /^\/r\/(\d+)(?:-|$)/.exec(p);
  if (m) {
    // on a direct hit the recipe is already in the DOM — keep it
    const prerendered = !booted && !!view.querySelector("[data-recipe]");
    await renderRecipe(m[1], { prerendered });
  } else if (p.startsWith("/account")) {
    nav("account");
    renderAccount();
  } else if (p.startsWith("/staples")) {
    nav("staples");
    document.title = "Weekly staples | VegBatch";
    renderStaples();
  } else if (p.startsWith("/feedback")) {
    renderFeedback();
  } else if (p.startsWith("/history")) {
    nav("history");
    renderHistory();
  } else if (p.startsWith("/plan")) {
    nav("plan");
    document.title = "This week | VegBatch";
    await renderPlan();
  } else {
    nav("browse");
    document.title = "VegBatch — free vegetarian & vegan meal planning";
    renderBrowse();
  }
  // so the feedback form can say which page they came from
  if (!p.startsWith("/feedback")) { try { sessionStorage.setItem("vb-last-page", p); } catch { /* private mode */ } }
  if (booted) window.scrollTo(0, 0);
  booted = true;
}

/**
 * Mobile menu.
 *
 * Closes on: choosing a link, tapping outside, Escape, and on resize back to
 * the desktop layout — that last one matters because a menu left "open" while
 * CSS switches to the horizontal bar leaves aria-expanded lying about state.
 */
const burger = $("#burger");
const navEl = $("#nav");
function setMenu(open) {
  navEl?.classList.toggle("open", open);
  burger?.setAttribute("aria-expanded", String(open));
}
burger?.addEventListener("click", (e) => {
  e.stopPropagation();
  setMenu(!navEl.classList.contains("open"));
});
navEl?.addEventListener("click", (e) => { if (e.target.closest("a")) setMenu(false); });
document.addEventListener("click", (e) => {
  if (navEl?.classList.contains("open") && !e.target.closest(".topbar")) setMenu(false);
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") setMenu(false); });
window.addEventListener("resize", () => { if (window.innerWidth > 700) setMenu(false); });

// ============================================================== theme
//
// Light is the standard and the OS preference is deliberately not consulted —
// this is the scheme the product is designed in, and a recipe reads best as a
// document. Dark is the reader's choice and we remember it.
//
// The attribute is already stamped before first paint by a blocking inline
// script in the head (see lib/seo.mjs). This only handles the toggle, so the
// two must agree on the key and the value.
const THEME_CHROME = { light: "#186048", dark: "#201e1b" };

function applyTheme(theme) {
  const dark = theme === "dark";
  // absence of the attribute IS light — never stamp data-theme="light", or a
  // future "follow the system" option would have nothing to fall through to
  if (dark) document.documentElement.setAttribute("data-theme", "dark");
  else document.documentElement.removeAttribute("data-theme");

  // the Android status bar sits directly above the page; leaving it brand
  // green over a near-black page was the visible seam that started all this
  $('meta[name="theme-color"]')?.setAttribute("content", THEME_CHROME[dark ? "dark" : "light"]);

  const btn = $("#themeToggle");
  if (btn) {
    const next = dark ? "light" : "dark";
    btn.setAttribute("aria-pressed", String(dark));
    btn.setAttribute("aria-label", `Switch to ${next} mode`);
    btn.title = `Switch to ${next} mode`;
  }
}

function initTheme() {
  applyTheme(load("vb-theme", "light"));
  $("#themeToggle")?.addEventListener("click", () => {
    const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
    save("vb-theme", next);
    applyTheme(next);
  });
}
initTheme();

// intercept in-site links so navigation stays client-side
document.addEventListener("click", (e) => {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = e.target.closest?.("a");
  if (!a) return;
  const href = a.getAttribute("href");
  if (!href || !href.startsWith("/") || a.target === "_blank" || a.hasAttribute("download")) return;
  e.preventDefault();
  go(href);
});
window.addEventListener("popstate", route);

// ============================================================== offline

/**
 * Install the service worker, and tell people when they've lost signal.
 *
 * The offline banner matters more than it looks: without it, a stale list in
 * a shop is indistinguishable from a current one. Saying "offline — showing
 * your saved list" is the difference between trusting it and not.
 */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => { /* http, or blocked */ });
  });

  // The worker calls skipWaiting + clients.claim, so a deploy takes control of
  // this page immediately — but the page has already rendered from the old
  // data and will never re-read it. That is how an installed app can sit on a
  // months-old recipe count and look like nothing was ever deployed. Reload
  // once when control changes so a deploy lands in one visit, not two.
  //
  // The guard is not optional: without it, skipWaiting and controllerchange
  // make a reload loop.
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });
}

function paintConnection() {
  const off = !navigator.onLine;
  let bar = $("#offline");
  if (!off) { bar?.remove(); return; }
  if (bar) return;
  bar = el("div", {
    id: "offline",
    className: "offline",
    textContent: "Offline — showing your saved recipes and list.",
  });
  document.body.prepend(bar);
}
window.addEventListener("online", paintConnection);
window.addEventListener("offline", paintConnection);
paintConnection();

/**
 * Offer installation — on both kinds of phone.
 *
 * `beforeinstallprompt` is Chromium-only. iOS Safari never fires it: there,
 * installing means Share → Add to Home Screen, by hand. Listening only for
 * the event would have shown nothing at all to roughly half of US phone
 * users, which is most of the point of a shopping-list app.
 *
 * The wording differs deliberately. On Chromium it is one tap, so "Install
 * app" is honest. On iOS it is a manual gesture, so the button says what to
 * actually do. "Download" is avoided on both: nothing downloads, and it would
 * send people looking for an App Store listing that does not exist.
 */
const installed = () =>
  window.matchMedia?.("(display-mode: standalone)")?.matches || window.navigator.standalone === true;

/**
 * Dismissal expires.
 *
 * The first version stored a permanent flag, so "not now" meant "never" —
 * and uninstalling the app didn't clear it, leaving no way back except
 * wiping site data. A month is long enough not to nag and short enough to
 * be recoverable. Installing clears it outright, so uninstall-then-reinstall
 * works the way anyone would expect.
 */
const DISMISS_DAYS = 30;
const dismissed = () => {
  const at = load("vb-install-dismissed", 0);
  if (!at) return false;
  if (at === true) return false;            // migrate the old permanent flag
  return Date.now() - at < DISMISS_DAYS * 86400000;
};
const dismiss = () => save("vb-install-dismissed", Date.now());

window.addEventListener("appinstalled", () => {
  try { localStorage.removeItem("vb-install-dismissed"); } catch { /* private mode */ }
  $(".install-wrap")?.remove();
});

function installBar(label, onClick) {
  if (installed() || dismissed() || $(".install-wrap")) return;
  const btn = el("button", { className: "install", textContent: label });
  const close = el("button", { className: "install-x", textContent: "×", title: "No thanks" });
  const wrap = el("div", { className: "install-wrap" }, [btn, close]);
  btn.onclick = () => onClick(wrap);
  close.onclick = () => { wrap.remove(); dismiss(); };
  document.body.append(wrap);
}

let installEvent = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installEvent = e;
  installBar("Install app", async (wrap) => {
    wrap.remove();
    installEvent.prompt();
    await installEvent.userChoice;
    installEvent = null;
    dismiss();
  });
});

// iOS Safari: no event will ever come, so offer the manual route instead.
const isIosSafari = /iP(hone|ad|od)/.test(navigator.userAgent) &&
  /Safari/.test(navigator.userAgent) && !/CriOS|FxiOS|EdgiOS/.test(navigator.userAgent);
if (isIosSafari) {
  installBar("Add to Home Screen", (wrap) => {
    wrap.replaceChildren(el("span", { className: "install-how" }, [
      "Tap ",
      el("b", { textContent: "Share" }),
      " below, then ",
      el("b", { textContent: "Add to Home Screen" }),
      ".",
    ]));
    // reading the instructions is not declining them — only the × is
    setTimeout(() => wrap.remove(), 10000);
  });
}

const [index, filters, catalog, staplesFile] = await Promise.all(
  ["/data/index.json", "/data/filters.json", "/data/ingredients.json", "/data/staples.json"]
    .map((u) => fetch(u).then((r) => r.json())),
);
state.index = index;
state.filters = filters;
state.catalog = catalog;
state.suggestedStaples = staplesFile.suggestions ?? [];

paintPlanCount();

/**
 * Boot.
 *
 * Auth is deliberately not awaited before the first paint. It needs the
 * network, and the whole point of this app is that it works in a shop with
 * none — blocking the first render on a session check would mean a spinner
 * exactly when the list is needed most. The route renders immediately, and
 * anything auth adds (cook labels, the nav state) fills in a moment later.
 */
paintNav();
await route();

if (acct.enabled()) {
  // Re-render for the signed-in state. The sync is best-effort; the render
  // is not.
  //
  // This used to be `await adoptLocalData(); route();` with a .catch() around
  // the outside, so ANY failure in the sync — staples, plan, saved lists,
  // cook history — skipped route() entirely and left the page in its
  // signed-out rendering. Photos would not appear, the nav still said "Sign
  // in", and the catch swallowed it with a comment claiming the app was fine.
  // It was not fine; it just looked like nothing had happened. Adding the
  // saved-lists pull to adoptLocalData widened that surface.
  const refresh = async (u) => {
    paintNav();
    if (u) {
      try { await adoptLocalData(); } catch { /* stale data beats no render */ }
    } else {
      state.cooked = new Map();
      state.photos = new Map();
    }
    route();
  };
  acct.onChange(refresh);
  acct.init().then(refresh).catch(() => route());
}
