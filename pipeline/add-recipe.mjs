#!/usr/bin/env node
/**
 * Add a recipe without spending anything.
 *
 * The bulk extraction is finished. New recipes arrive a few at a time, and for
 * that the model work is better done in a Claude Code session (free on the
 * subscription) than by a paid API call. This script is the other half: it
 * takes the JSON produced in-session, checks it, and wires it into the
 * dataset properly — id, slug, canonical ingredients, units, vegetarian
 * flags, review status.
 *
 * For a recipe that exists as a web page or pasted text, `import-recipe.mjs`
 * produces this JSON for you and calls the same wiring.
 *
 * Zero API calls. All of it is validation and deterministic arithmetic.
 *
 *   node add-recipe.mjs new-recipe.json
 *   node add-recipe.mjs new-recipe.json --dry-run
 *   node add-recipe.mjs --template > new-recipe.json
 *
 * Unknown ingredients are reported, not invented. Add them to
 * data/ingredients.json (the shape is in the report) and re-run.
 */
import fs from "node:fs";
import path from "node:path";
import { DATA, readJson, writeJson } from "./lib/config.mjs";
import { TEMPLATE, prepareRecipes, summarize, reportRefusal } from "./lib/add-recipe.mjs";

const RECIPES = path.join(DATA, "recipes.json");
const CATALOG = path.join(DATA, "ingredients.json");
const ALIASES = path.join(DATA, "ingredient-aliases.json");

if (process.argv.includes("--template")) {
  console.log(JSON.stringify(TEMPLATE, null, 2));
  process.exit(0);
}

const file = process.argv[2];
const dryRun = process.argv.includes("--dry-run");
if (!file || file.startsWith("--")) {
  console.log("usage: node add-recipe.mjs <file.json> [--dry-run]");
  console.log("       node add-recipe.mjs --template > new-recipe.json");
  process.exit(1);
}

const recipes = readJson(RECIPES, []);
const catalog = readJson(CATALOG, {});
const aliases = readJson(ALIASES, {});

// Windows editors and PowerShell happily write a UTF-8 BOM, which JSON.parse
// rejects with an unhelpful error. Strip it rather than make that the user's
// problem.
const raw = fs.readFileSync(file, "utf8").replace(/^﻿/, "");
let incoming;
try {
  incoming = [].concat(JSON.parse(raw));
} catch (error) {
  console.log(`${file} is not valid JSON:\n  ${error.message}`);
  process.exit(1);
}

const result = prepareRecipes({ incoming, recipes, catalog, aliases });
if (result.problems.length || result.unknown.size) {
  reportRefusal(result);
  process.exit(1);
}

for (const r of result.added) for (const line of summarize(r, dryRun ? "would add" : "added")) console.log(line);

if (dryRun) {
  console.log("\n--dry-run: nothing written.");
  process.exit(0);
}

writeJson(RECIPES, [...recipes, ...result.added].sort((a, b) => a.id.localeCompare(b.id)));
console.log(`\n${recipes.length} -> ${recipes.length + result.added.length} recipes.`);
console.log(`Queued for review at http://localhost:4173  (node review/server.mjs)`);
