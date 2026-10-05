/**
 * Stage 3 — group photos into recipes.
 *
 * Deterministic on purpose. Stage 2 already made the only hard judgement
 * (`continues_previous`) while looking at the pages; re-asking a model here
 * would just add a second chance to be wrong. A new group starts whenever a
 * photo does not continue the one before it.
 *
 * Writes both machine-readable groups and a REVIEW.md for a human to check
 * before any extraction money is spent — a continuation stapled to the wrong
 * recipe produces a plausible-looking wrong recipe, which is the worst kind.
 *
 *   node 3-group.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { WORK, readJson, writeJson } from "./lib/config.mjs";

const OUT = path.join(WORK, "groups.json");
const REVIEW = path.join(WORK, "REVIEW-groups.md");

const triage = readJson(path.join(WORK, "triage.json"), []);
if (!triage.length) throw new Error("no triage — run 2-triage.mjs first");

const groups = [];
for (const row of triage) {
  const startsNew = !row.continues_previous || groups.length === 0;
  if (startsNew) {
    groups.push({
      id: String(groups.length + 1).padStart(3, "0"),
      title: row.title,
      doc_type: row.doc_type,
      pages: [],
      flags: [],
    });
  }
  const g = groups.at(-1);
  g.pages.push({ seq: row.seq, prepped: row.prepped, page_role: row.page_role, notes: row.notes });
  if (!g.title && row.title) g.title = row.title;
  if (row.contains_meat) g.flags.push(`meat: ${row.meat_items.join(", ")}`);
  if (row.legibility === "poor") g.flags.push(`poor legibility on ${row.prepped}`);
}

// Signals worth a second pair of eyes before extraction.
for (const g of groups) {
  const roles = g.pages.map((p) => p.page_role);
  if (!g.title) g.flags.push("no title found on any page");
  if (g.pages.length > 3) g.flags.push(`${g.pages.length} pages — unusually long, check the grouping`);
  if (roles.includes("first") && g.pages.length === 1) {
    g.flags.push("marked 'first' but has no continuation — a page may be missing or mis-split");
  }
  if (roles.filter((r) => r === "single").length > 1) {
    g.flags.push("multiple pages each marked 'single' — probably over-merged");
  }
  // The failure that slipped through once: a continuation page whose first
  // page was photographed elsewhere, so there was nothing adjacent to attach
  // it to and it became a recipe of its own with no ingredients. Every other
  // flag here looks for a recipe missing its END; this looks for a fragment
  // missing its BEGINNING.
  if (roles[0] === "continuation" || roles[0] === "card_back") {
    g.flags.push("starts on a continuation page — its first page is missing or was shot out of order");
  }
}

writeJson(OUT, groups);

const flagged = groups.filter((g) => g.flags.length);
const lines = [
  "# Group review",
  "",
  `${groups.length} recipes from ${triage.length} photos. Check the groupings below, `,
  "fix `work/groups.json` by hand if any are wrong, then run `node 4-extract.mjs`.",
  "",
  `**${flagged.length} groups have flags** and are listed first.`,
  "",
];

const render = (g) => {
  lines.push(`### ${g.id}. ${g.title ?? "_(untitled)_"}`);
  lines.push(`*${g.doc_type}, ${g.pages.length} page${g.pages.length > 1 ? "s" : ""}*`);
  for (const p of g.pages) lines.push(`- \`${p.prepped}\` (${p.page_role}) — ${p.notes}`);
  for (const f of g.flags) lines.push(`- ⚠ **${f}**`);
  lines.push("");
};

if (flagged.length) {
  lines.push("## Flagged", "");
  flagged.forEach(render);
}
lines.push("## All groups", "");
groups.forEach(render);

fs.writeFileSync(REVIEW, lines.join("\n"), "utf8");

console.log(`group: ${triage.length} photos -> ${groups.length} recipes`);
console.log(`  multi-page: ${groups.filter((g) => g.pages.length > 1).length}`);
console.log(`  flagged for review: ${flagged.length}`);
console.log(`  -> ${OUT}`);
console.log(`  -> ${REVIEW}`);
