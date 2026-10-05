#!/usr/bin/env node
/**
 * Import a recipe from a web page or a text file, normalize it to the
 * collection's rules, and wire it into the dataset.
 *
 *   node import-recipe.mjs https://example.com/some-recipe/          # report only
 *   node import-recipe.mjs https://example.com/some-recipe/ --add    # add it
 *   node import-recipe.mjs recipe.txt --add                          # pasted text
 *   node import-recipe.mjs recipe.json --add                         # schema.org JSON or our template
 *
 * Flags
 *   --add                 write to data/recipes.json (default is a dry run)
 *   --keep-quantities     don't rescale a "serves N" recipe to 5 servings
 *   --accept-suggestions  take every loose catalog match the report proposes
 *   --map "a=b"           map item "a" to catalog ingredient "b" (repeatable)
 *   --course main         set the course when it can't be inferred
 *   --title "..."         override the title
 *
 * Zero API calls. A URL is fetched once and read for its schema.org Recipe;
 * a page without one is refused with instructions to paste the text instead.
 * Everything else is rules in lib/import.mjs. What the rules can't settle —
 * an unknown ingredient, a meat decision, the description — is reported, and
 * the normalized JSON is left in work/imports/ for a Claude Code session to
 * finish by hand, then `node add-recipe.mjs work/imports/<slug>.json`.
 */
import fs from "node:fs";
import path from "node:path";
import { DATA, WORK, readJson, writeJson } from "./lib/config.mjs";
import { prepareRecipes, summarize, reportRefusal, slugOf } from "./lib/add-recipe.mjs";
import { recipeFromHtml, sourceFromJsonLd, sourceFromText, normalizeSource } from "./lib/import.mjs";

const RECIPES = path.join(DATA, "recipes.json");
const CATALOG = path.join(DATA, "ingredients.json");
const ALIASES = path.join(DATA, "ingredient-aliases.json");
const IMPORTS = path.join(WORK, "imports");

const argv = process.argv.slice(2);
const VALUED = new Set(["--map", "--course", "--title"]);
const target = argv.find((a, i) => !a.startsWith("--") && !VALUED.has(argv[i - 1]));
const flag = (f) => argv.includes(f);
const values = (f) => argv.flatMap((a, i) => (a === f && argv[i + 1] ? [argv[i + 1]] : []));

// Runs inside a function so every exit is a `return`: process.exit() right
// after a fetch trips a libuv assertion on Windows and masks the real message.
process.exitCode = await main();

async function main() {
  if (!target) {
    console.log(fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 24).map((l) => l.replace(/^ \*\s?/, "")).join("\n"));
    return 1;
  }

  const options = {
    keepQuantities: flag("--keep-quantities"),
    acceptSuggestions: flag("--accept-suggestions"),
    course: values("--course")[0] ?? null,
    title: values("--title")[0] ?? null,
    map: Object.fromEntries(values("--map").map((m) => m.split("=").map((s) => s.trim().toLowerCase()))),
  };
  const add = flag("--add");

  const recipes = readJson(RECIPES, []);
  const catalog = readJson(CATALOG, {});
  const aliases = readJson(ALIASES, {});

  // ----------------------------------------------------------- acquire

  let source;
  let passthrough = null; // a file already in our template shape goes straight to the wiring

  if (/^https?:\/\//i.test(target)) {
    console.log(`fetching ${target}`);
    let res;
    try {
      res = await fetch(target, {
        headers: { "user-agent": "Mozilla/5.0 (compatible; VegBatch-import/1.0; +https://vegbatch.com)", accept: "text/html" },
        signal: AbortSignal.timeout(20000),
      });
    } catch (e) { console.log(`could not fetch: ${e.message}`); return 1; }
    if (!res.ok) { console.log(`${res.status} ${res.statusText} — the page would not load.`); return 1; }
    const node = recipeFromHtml(await res.text());
    if (!node) {
      console.log("No structured recipe (schema.org Recipe JSON-LD) on that page.");
      console.log("Copy the recipe text into a .txt file — title first, then ingredients, then the method — and import that.");
      return 1;
    }
    source = sourceFromJsonLd(node, { url: target });
  } else {
    if (!fs.existsSync(target)) { console.log(`no such file: ${target}`); return 1; }
    const text = fs.readFileSync(target, "utf8").replace(/^﻿/, "");
    if (target.toLowerCase().endsWith(".json")) {
      const json = JSON.parse(text);
      const node = recipeFromHtml(`<script type="application/ld+json">${text}</script>`);
      if (node) source = sourceFromJsonLd(node, { url: json.url ?? null });
      else passthrough = [].concat(json); // our own template
    } else if (/<html|<script/i.test(text)) {
      const node = recipeFromHtml(text);
      if (!node) { console.log("That HTML has no schema.org Recipe in it."); return 1; }
      source = sourceFromJsonLd(node);
    } else {
      source = sourceFromText(text, { title: options.title });
    }
  }

  // --------------------------------------------------------- normalize

  let incoming, report = null, learned = {};
  if (passthrough) {
    incoming = passthrough;
  } else {
    if (!source.title) { console.log("Could not find a title. Pass --title \"...\"."); return 1; }
    if (!source.ingredient_lines.length) { console.log("Found no ingredient lines."); return 1; }
    ({ recipe: incoming, report, learned } = normalizeSource(source, { catalog, aliases, options }));
    incoming = [incoming];
  }

  const out = path.join(IMPORTS, `${slugOf(incoming[0].title)}.json`);
  writeJson(out, incoming.length === 1 ? incoming[0] : incoming);

  // ------------------------------------------------------------- report

  const r = incoming[0];
  console.log(`\n${r.title}`);
  console.log(`  ${r.components.reduce((s, c) => s + c.ingredients.length, 0)} ingredient lines in ${r.components.length} component${r.components.length > 1 ? "s" : ""}, ${r.instructions.length} steps`);
  console.log(`  course ${r.course ?? "?"} · yield ${r.yield_text ?? "?"} · ${r.total_min ? `${r.total_min} min` : "no time"}` +
    (r.source_attribution ? ` · from ${r.source_attribution}` : ""));

  if (report) {
    if (report.scaled) console.log(`  scaled ×${Math.round(report.scaled.factor * 100) / 100} from ${report.scaled.from} servings to ${report.scaled.to} (--keep-quantities to skip)`);
    if (report.swaps.length) console.log(`  swapped: ${report.swaps.join(", ")}`);
    if (report.meat.length) console.log(`  ⚠ meat/fish: ${report.meat.join(", ")} — decide in review, or fix the JSON`);
    if (report.suggestions.length) {
      console.log(`\n  ${report.suggestions.length} loose match${report.suggestions.length > 1 ? "es" : ""} — accept all with --accept-suggestions, or one at a time:`);
      for (const s of report.suggestions) console.log(`    --map "${s.item}=${s.suggested}"      ← ${s.raw}`);
    }
    if (report.unknown.length) {
      console.log(`\n  ${report.unknown.length} ingredient${report.unknown.length > 1 ? "s" : ""} the catalog does not know:`);
      for (const u of report.unknown) console.log(`    ${u.item}      ← ${u.raw}`);
      console.log(`  Either --map "<item>=<catalog name>" or add the ingredient to data/ingredients.json.`);
    }
    console.log(`\n  description (drafted, rewrite in review): ${r.description}`);
  }
  console.log(`\n  normalized JSON: ${path.relative(process.cwd(), out)}`);

  // ---------------------------------------------------------------- wire

  const result = prepareRecipes({ incoming, recipes, catalog, aliases: { ...aliases, ...learned } });
  console.log("");
  if (result.problems.length) { reportRefusal(result); return 1; }
  if (result.unknown.size) {
    const onlySuggested = report && [...result.unknown.keys()].every((k) => report.suggestions.some((s) => s.item === k));
    if (onlySuggested) console.log("Not added yet — accept or map the loose matches above, then re-run.");
    else reportRefusal(result);
    return 1;
  }
  for (const a of result.added) for (const line of summarize(a, add ? "added" : "would add")) console.log(line);

  if (!add) {
    console.log("\nDry run — nothing written to the dataset. Re-run with --add to wire it in.");
    return 0;
  }

  writeJson(RECIPES, [...recipes, ...result.added].sort((a, b) => a.id.localeCompare(b.id)));
  const newAliases = Object.keys(learned);
  if (newAliases.length) {
    writeJson(ALIASES, Object.fromEntries(Object.entries({ ...aliases, ...learned }).sort(([a], [b]) => a.localeCompare(b))));
    console.log(`\nlearned ${newAliases.length} ingredient alias${newAliases.length > 1 ? "es" : ""}: ${newAliases.join(", ")}`);
  }
  console.log(`\n${recipes.length} -> ${recipes.length + result.added.length} recipes.`);
  console.log(`Next: node review/server.mjs  (http://localhost:4173) to check it, then npm run deploy.`);
  return 0;
}
