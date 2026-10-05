/**
 * Merge the r2 cookbook batches into the dataset.
 *
 * r2 was extracted in-session rather than through 4-extract, so there is no
 * API spend here and nothing to approve — this stage is pure bookkeeping:
 * fold work/r2/batch-*.json into data/recipes.json, fold the hand-written
 * ingredient attributes into the catalog, and make sure every ingredient name
 * those recipes use has an alias that resolves to a real catalog entry.
 *
 * That last part is the one that bites. 7-normalize looks a line up through
 * the alias table, not the catalog directly, so an ingredient can be present
 * in ingredients.json and still come out unresolved because nothing maps the
 * written name onto it. "almond milk" did exactly that.
 *
 * Idempotent: re-running replaces r2 recipes by id and leaves r1 alone.
 *
 *   node r2-merge.mjs [--dry]
 */
import fs from "node:fs";
import path from "node:path";
import { DATA, PROJECT, readJson, writeJson } from "./lib/config.mjs";

const R2 = path.join(PROJECT, "work", "r2");
const dry = process.argv.includes("--dry");

/**
 * Every r2 recipe carries the same credit, so it is stamped here rather than
 * repeated fifty times in the batch files — one place to correct if the
 * wording ever changes.
 */
const SOURCE = "The Eat Raw Kitchen (Love Food)";

const batches = fs.readdirSync(R2).filter((f) => /^batch-\d+\.json$/.test(f)).sort();
const extras = fs.readdirSync(R2).filter((f) => /^new-ingredients-\d+\.json$/.test(f)).sort();
if (!batches.length) throw new Error("no batch files in work/r2");

const recipes = readJson(path.join(DATA, "recipes.json"), []);
const catalog = readJson(path.join(DATA, "ingredients.json"), {});
const aliases = readJson(path.join(DATA, "ingredient-aliases.json"), {});

// --- 1. new ingredient attributes, written by hand rather than by the model
//
// An entry may instead say { alias_of: "<existing catalog name>" }, which is
// the right answer whenever the cookbook simply uses another word for
// something already in the catalog — "scallions" for green onion.
//
// The guard below is the important part. Adding "dried coconut flakes" when
// "coconut flakes" already exists does not fail: it creates a second entry,
// and the two then split one ingredient's quantity across two grocery lines,
// each rounded up to its own pack. That is a silently wrong shopping list,
// which is the worst kind.
//
// But "coconut flour" is not "flour", and the catalog already — correctly —
// carries almond milk beside milk. So this is not a ban on names that end in
// an existing name; it is a requirement to have thought about it once. Write
// { alias_of: "flour" } to merge, or { distinct_from: "flour", ... } to
// assert that this really is its own product.
let addedCatalog = 0, addedByAlias = 0;
const collisions = [];
for (const f of extras) {
  for (const [name, attrs] of Object.entries(readJson(path.join(R2, f), {}))) {
    if (attrs.alias_of) {
      if (!catalog[attrs.alias_of]) collisions.push(`${name}: alias_of "${attrs.alias_of}" is not in the catalog`);
      else if (!aliases[name]) {
        aliases[name] = { original: name, base_name: attrs.alias_of, form: null, is_compound: false, parts: [] };
        addedByAlias++;
      }
      continue;
    }
    if (catalog[name]) continue;

    const existing = Object.keys(catalog).find((k) =>
      k !== name && name.endsWith(` ${k}`) && !catalog[k].merged_into);
    if (existing && attrs.distinct_from !== existing) {
      collisions.push(
        `${name}: "${existing}" already exists. Either { "alias_of": "${existing}" } to merge them, ` +
        `or add "distinct_from": "${existing}" to confirm it is a separate product.`);
      continue;
    }
    const { distinct_from, ...rest } = attrs;
    catalog[name] = { id: name.replace(/\s+/g, "-"), name, is_vegan: true, is_pantry: false, ...rest };
    addedCatalog++;
  }
}
if (collisions.length) {
  console.error("\nrefusing to split ingredients across duplicate catalog entries:\n");
  for (const c of collisions) console.error(`  ${c}`);
  console.error("");
  process.exit(1);
}

// --- 2. the r2 recipes themselves
const incoming = batches.flatMap((f) => readJson(path.join(R2, f), []))
  .map((r) => ({ ...r, source_attribution: r.source_attribution ?? SOURCE }));
const seen = new Set();
for (const r of incoming) {
  if (seen.has(r.id)) throw new Error(`duplicate r2 recipe id ${r.id}`);
  seen.add(r.id);
}
const kept = recipes.filter((r) => !seen.has(r.id));
const merged = [...kept, ...incoming].sort((a, b) => a.id.localeCompare(b.id));

// --- 3. every name these recipes use must resolve through the alias table
//
// Match the catalog on the written name, then on a naive singular, then on a
// naive plural. Anything still unmatched is reported rather than guessed at —
// a silently unresolved ingredient is one that vanishes from the grocery list.
const singular = (n) => (n.endsWith("ies") ? `${n.slice(0, -3)}y` : n.endsWith("s") ? n.slice(0, -1) : n);
const plural = (n) => (n.endsWith("y") ? `${n.slice(0, -1)}ies` : n.endsWith("s") ? n : `${n}s`);

let addedAlias = 0;
const unresolved = new Set();
for (const r of incoming) {
  for (const c of r.components) {
    for (const i of c.ingredients) {
      const name = String(i.item ?? "").trim().toLowerCase();
      if (!name) continue;
      if (aliases[name] && catalog[aliases[name].base_name]) continue;

      const base = [name, singular(name), plural(name)].find((n) => catalog[n]);
      if (!base) { unresolved.add(name); continue; }
      aliases[name] = { original: name, base_name: base, form: null, is_compound: false, parts: [] };
      addedAlias++;
    }
  }
}

console.log(`r2 merge: ${batches.length} batch file(s), ${incoming.length} recipes`);
console.log(`  catalog +${addedCatalog}, aliases +${addedAlias + addedByAlias}`);
console.log(`  recipes: ${kept.length} kept + ${incoming.length} r2 = ${merged.length}`);
if (unresolved.size) {
  console.log(`\n  ${unresolved.size} name(s) with no catalog entry — add them to a new-ingredients file:`);
  for (const n of [...unresolved].sort()) console.log(`    ${n}`);
}

if (dry) { console.log("\n  --dry: nothing written"); process.exit(unresolved.size ? 1 : 0); }

writeJson(path.join(DATA, "recipes.json"), merged);
writeJson(path.join(DATA, "ingredients.json"), catalog);
writeJson(path.join(DATA, "ingredient-aliases.json"), aliases);
console.log("\n  written. run 7-normalize.mjs next (cached — no API spend)");
process.exit(unresolved.size ? 1 : 0);
