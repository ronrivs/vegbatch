/**
 * Smoke test for the review UI.
 *
 * Loads index.html + app.js in jsdom against the live server and drives the
 * paths a reviewer actually takes: render, switch filter, edit a field, save,
 * approve, advance. Catches render-time crashes, which is the real risk —
 * this UI is the human gate on the dataset, and a blank page stalls the whole
 * review pass.
 *
 *   node review/server.mjs &   node review/smoke.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";

const here = path.dirname(fileURLToPath(import.meta.url));
const BASE = "http://localhost:4173";

const errors = [];
const vc = new VirtualConsole();
vc.on("jsdomError", (e) => errors.push(e.message));
vc.on("error", (...a) => errors.push(a.join(" ")));

const dom = new JSDOM(fs.readFileSync(path.join(here, "index.html"), "utf8"), {
  url: `${BASE}/`,
  runScripts: "dangerously",
  virtualConsole: vc,
  resources: undefined, // we inject app.js ourselves so imports resolve
});
const { window } = dom;
const { document } = window;

// jsdom has no fetch bound to the page; proxy to the real server.
window.fetch = async (url, opts) => {
  const res = await fetch(new URL(url, BASE), opts);
  return { ok: res.ok, status: res.status, json: () => res.json() };
};
window.localStorage.setItem("vm-rot", "{}");

const check = (name, cond, detail = "") => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) process.exitCode = 1;
};

// Execute app.js as a module body in the page realm.
const src = fs.readFileSync(path.join(here, "app.js"), "utf8");
const script = new window.Function(`return (async () => {\n${src.replace(/^import .*$/gm, "")}\n})()`);
await script.call(window);
await new Promise((r) => setTimeout(r, 300));

console.log("\nreview UI smoke test");
check("no uncaught errors on load", errors.length === 0, errors.join(" | "));

const rows = document.querySelectorAll(".row");
check("recipe list rendered", rows.length > 0, `${rows.length} rows`);
check("progress shown", /\d+ \/ \d+ approved/.test(document.querySelector("#progress").textContent));
check("photo src set", (document.querySelector("#img").src || "").includes("/photo/"));

const form = document.querySelector("#form");
check("form rendered", form.querySelectorAll("input,textarea").length > 3,
  `${form.querySelectorAll("input,textarea").length} fields`);
check("ingredient cards rendered", form.querySelectorAll(".ing").length > 0,
  `${form.querySelectorAll(".ing").length} ingredients`);
check("raw_text shown beside each ingredient", form.querySelectorAll(".ing .raw").length > 0);
check("approve button present", /Approve|Approved/.test(form.querySelector(".actions button").textContent));

// every filter must render without throwing
const filter = document.querySelector("#filter");
for (const opt of [...filter.options].map((o) => o.value)) {
  const before = errors.length;
  filter.value = opt;
  filter.dispatchEvent(new window.Event("change"));
  check(`filter "${opt}" renders`, errors.length === before, errors.slice(before).join(" | "));
}
filter.value = "all";
filter.dispatchEvent(new window.Event("change"));

// edit a title and confirm it persists through the server
const titleInput = document.querySelector("#form input");
const stamp = `smoke-${Date.now()}`;
const original = titleInput.value;
titleInput.value = stamp;
titleInput.dispatchEvent(new window.Event("input"));
await new Promise((r) => setTimeout(r, 900));
let saved = await (await fetch(`${BASE}/api/recipes`)).json();
check("edit persisted to recipes.json", saved.some((r) => r.title === stamp));

// put it back so the smoke test leaves no trace
const target = saved.find((r) => r.title === stamp);
target.title = original;
await fetch(`${BASE}/api/recipe`, {
  method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(target),
});
saved = await (await fetch(`${BASE}/api/recipes`)).json();
check("restored original title", saved.some((r) => r.title === original) && !saved.some((r) => r.title === stamp));

// keyboard navigation
const first = document.querySelector(".row.active .t")?.textContent;
document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "j", bubbles: true }));
await new Promise((r) => setTimeout(r, 100));
const second = document.querySelector(".row.active .t")?.textContent;
check("J advances selection", first !== second, `${first} -> ${second}`);

check("backup written", fs.existsSync(path.join(here, "..", "..", "data", "recipes.raw.json")));
check("still no uncaught errors", errors.length === 0, errors.join(" | "));

console.log(process.exitCode ? "\nFAILED" : "\nall good");
window.close();
