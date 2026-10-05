#!/usr/bin/env node
/**
 * The grocery list, on the command line.
 *
 *   node list.mjs 002 045 130 199        pick recipes by id
 *   node list.mjs 002x2 045              002 at double quantity
 *   node list.mjs --find couscous        search, don't build a list
 *   node list.mjs --random 4             pick 4 at random
 *   node list.mjs 002 045 --staples      add the weekly staples list
 *   node list.mjs 002 045 --pantry       also list things assumed on hand
 *   node list.mjs 002 045 --md           markdown, for printing or email
 *   node list.mjs 002 045 --why          show which recipe each amount came from
 *
 * All the arithmetic lives in lib/grocery.mjs, shared with the web app. This
 * file only chooses recipes and prints the result.
 */
import path from "node:path";
import { DATA, readJson } from "./lib/config.mjs";
import { buildList } from "./lib/grocery.mjs";

const recipes = readJson(path.join(DATA, "recipes.json"), []);
const catalog = readJson(path.join(DATA, "ingredients.json"), {});
const staplesFile = readJson(path.join(DATA, "staples.json"), { items: [] });

const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const val = (f) => (argv.indexOf(f) === -1 ? undefined : argv[argv.indexOf(f) + 1]);

// ------------------------------------------------------------------ search

if (flag("--find")) {
  const q = (val("--find") ?? "").toLowerCase();
  const hits = recipes.filter(
    (r) => r.title.toLowerCase().includes(q) ||
      r.components.some((c) => c.ingredients.some((i) => (i.item ?? "").toLowerCase().includes(q))),
  );
  console.log(`${hits.length} recipes matching "${q}"\n`);
  for (const r of hits.slice(0, 60)) {
    const n = r.components.reduce((s, c) => s + c.ingredients.length, 0);
    console.log(
      `  ${r.id}  ${r.title.slice(0, 58).padEnd(58)} ${String(r.total_min ?? "–").padStart(4)}m  ` +
      `${String(n).padStart(2)} ing  ${r.is_vegan ? "vegan" : "     "}  ${r.needs_review ? "· unreviewed" : ""}`,
    );
  }
  process.exit(0);
}

// -------------------------------------------------------------- selection

let picks = argv.filter((a) => /^\d{3}(x[\d.]+)?$/.test(a)).map((a) => {
  const [id, scale] = a.split("x");
  return { id, scale: scale ? Number(scale) : 1 };
});

if (flag("--random")) {
  const n = Number(val("--random") ?? 4);
  const pool = recipes.filter((r) => !r.excluded);
  picks = [...pool].sort(() => Math.random() - 0.5).slice(0, n).map((r) => ({ id: r.id, scale: 1 }));
}

if (!picks.length) {
  console.log("Pick some recipes:  node list.mjs 002 045 130");
  console.log("Find them with:     node list.mjs --find chickpea");
  process.exit(1);
}

const chosen = [];
for (const p of picks) {
  const r = recipes.find((x) => x.id === p.id);
  if (!r) { console.log(`no recipe ${p.id}`); process.exit(1); }
  chosen.push({ ...r, scale: p.scale });
}

const wantStaples = flag("--staples");
const list = buildList({
  recipes: chosen,
  catalog,
  staples: staplesFile.items,
  options: { includeStaples: wantStaples, includePantry: flag("--pantry") },
});

// ---------------------------------------------------------------- output

const md = flag("--md");
const why = flag("--why");
const out = [];
const H = (s) => out.push(md ? `\n## ${s}\n` : `\n${s.toUpperCase()}\n${"─".repeat(s.length)}`);

out.push(md ? "# Grocery list" : "GROCERY LIST", "");
for (const r of chosen) {
  const label = `${r.id}  ${r.title}${r.scale !== 1 ? `  (×${r.scale})` : ""}`;
  out.push(md ? `- ${label}` : `  ${label}`);
}

H(`${list.items.length} items to buy`);
for (const group of list.byAisle) {
  out.push(md ? `\n**${group.aisle}**\n` : `\n  ${group.aisle}`);
  for (const e of group.items) {
    const marks = [e.estimated ? "~" : "", e.sharedAcross > 1 ? "◆" : "", e.staple ? "★" : ""].join("");
    const { main, detail } = e.purchase;
    out.push(
      md
        ? `- [ ] **${main}** ${e.label}${detail ? ` — *${detail}*` : ""}${marks ? ` ${marks}` : ""}`
        : `    ☐ ${main.padEnd(18)} ${e.label}${marks ? ` ${marks}` : ""}${detail ? `   (${detail})` : ""}`,
    );
    if (why) for (const s of e.sources) {
      out.push(md ? `    - ${s.id} ${s.recipe}: ${s.raw}` : `        ← ${s.id} ${s.raw}`);
    }
  }
}

if (list.shared.length) {
  H(`Shared across recipes (${list.shared.length})`);
  out.push("");
  for (const e of list.shared.slice(0, 12)) {
    const line = `${e.ingredient.name} — used in ${e.sharedAcross} of these recipes`;
    out.push(md ? `- ${line}` : `    ◆ ${line}`);
  }
  out.push(md ? "\n*Buying these once covers several meals — the reason to plan a week together.*"
              : "\n    Buying these once covers several meals.");
}

if (list.pantry.length) {
  H(`Assumed in the pantry (${list.pantry.length})`);
  out.push("");
  const names = list.pantry.map((e) => e.ingredient.name).sort();
  out.push(md ? names.map((n) => `- ${n}`).join("\n") : `    ${names.join(", ")}`);
  out.push(md ? "\n*Run with `--pantry` to put these on the list too.*" : "\n    (--pantry to include them)");
}

if (!wantStaples && staplesFile.items.some((s) => s.active)) {
  const n = staplesFile.items.filter((s) => s.active).length;
  out.push(md ? `\n> ${n} weekly staples not included — add \`--staples\`.`
              : `\n  ${n} weekly staples not included (--staples)`);
}

if (list.toCheck.length) {
  H(`To taste / no quantity given (${list.toCheck.length})`);
  out.push("");
  const names = list.toCheck.map((t) => t.name);
  out.push(md ? names.map((n) => `- ${n}`).join("\n") : `    ${names.join(", ")}`);
}

const parts = [
  `${list.items.length} to buy`,
  `${list.pantry.length} assumed in the pantry`,
  list.addedStaples.length ? `${list.addedStaples.length} weekly staples ★` : null,
  list.estimatedCount ? `${list.estimatedCount} with an estimated quantity ~` : null,
].filter(Boolean);
out.push("", md ? `---\n\n${parts.join(" · ")}` : `  ${parts.join(" · ")}`);

console.log(out.join("\n"));
