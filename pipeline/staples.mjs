#!/usr/bin/env node
/**
 * The household staples list — things you buy every week regardless of what
 * you're cooking. Two peanut butters, two yogurts, twelve bananas.
 *
 * This is NOT the same as `is_pantry` on the ingredient catalog. Pantry means
 * "you already have it, leave it off the list" (salt, oil). Staples means
 * "put this on every list" (bananas). Opposite operations, and they are kept
 * apart deliberately.
 *
 * Staples belong to the household, not to any recipe, so they live in their
 * own file and can name things no recipe has ever used. When the web app gets
 * accounts this file becomes a per-account table — the shape already matches.
 *
 *   node staples.mjs                                 show the list
 *   node staples.mjs add "peanut butter" 2 jar
 *   node staples.mjs add bananas 12
 *   node staples.mjs add yogurt 2 container --note "the big plain ones"
 *   node staples.mjs add oat milk 2 carton --aisle refrigerated
 *   node staples.mjs off bananas                     keep it, skip it this week
 *   node staples.mjs on bananas
 *   node staples.mjs remove "peanut butter"
 */
import path from "node:path";
import { DATA, readJson, writeJson } from "./lib/config.mjs";

const FILE = path.join(DATA, "staples.json");
const catalog = readJson(path.join(DATA, "ingredients.json"), {});

const store = readJson(FILE, { household: "default", items: [] });
const argv = process.argv.slice(2);
const opt = (f) => (argv.indexOf(f) === -1 ? undefined : argv[argv.indexOf(f) + 1]);
const positional = argv.filter((a, i) =>
  !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--")));

const [cmd, ...rest] = positional;
const find = (name) => store.items.find((s) => s.item.toLowerCase() === String(name).toLowerCase());

/**
 * Only an exact match (allowing for a plural) may claim a staple's identity.
 * A loose match hijacks the name — "oat milk" is not "milk", and buying the
 * wrong thing is worse than filing it in the wrong aisle.
 */
function resolveExact(name) {
  const key = name.trim().toLowerCase();
  return catalog[key]
    ?? catalog[key.endsWith("s") ? key.slice(0, -1) : `${key}s`]
    ?? null;
}

/** A loose match is good enough to guess an aisle, and nothing else. */
function guessAisle(name) {
  const key = name.trim().toLowerCase();
  const hit = Object.values(catalog).find((c) => c.name.includes(key) || key.includes(c.name));
  return hit?.aisle ?? null;
}

function show() {
  if (!store.items.length) {
    console.log("No staples yet.\n");
    console.log('  node staples.mjs add "peanut butter" 2 jar');
    console.log("  node staples.mjs add bananas 12");
    return;
  }
  const active = store.items.filter((s) => s.active);
  console.log(`\nWEEKLY STAPLES  (${active.length} active of ${store.items.length})`);
  console.log("─".repeat(46));
  const byAisle = {};
  for (const s of store.items) (byAisle[s.aisle ?? "other"] ??= []).push(s);
  for (const [aisle, items] of Object.entries(byAisle).sort()) {
    console.log(`\n  ${aisle}`);
    for (const s of items.sort((a, b) => a.item.localeCompare(b.item))) {
      const qty = `${s.qty}${s.unit ? ` ${s.unit}` : ""}`;
      console.log(`    ${s.active ? "☑" : "☐"} ${qty.padEnd(14)} ${s.item}${s.note ? `   — ${s.note}` : ""}`);
    }
  }
  console.log(`\n  Added to a list with:  node list.mjs 002 043 --staples\n`);
}

switch (cmd) {
  case undefined:
  case "list":
    show();
    break;

  case "add": {
    // name may be several words; the trailing number and unit are optional
    const words = [...rest];
    let unit = null, qty = 1;
    if (words.length > 1 && /^[\d.]+$/.test(words.at(-1))) qty = Number(words.pop());
    else if (words.length > 2 && /^[\d.]+$/.test(words.at(-2))) {
      unit = words.pop();
      qty = Number(words.pop());
    }
    const item = words.join(" ").trim();
    if (!item) { console.log('usage: node staples.mjs add "peanut butter" 2 jar'); process.exit(1); }

    const known = resolveExact(item);
    // "12 bananas" reads better than "12 piece bananas"
    const inferred = (known?.typical_pack_unit ?? "")
      .replace(/^[\d\s]*(oz|g|ml|lb)?\s*/i, "")
      .replace(/^piece$/, "");
    const entry = {
      item,
      qty,
      unit: unit ?? (inferred || null),
      aisle: opt("--aisle") ?? known?.aisle ?? guessAisle(item) ?? "other",
      note: opt("--note") ?? null,
      canonical: known?.id ?? null,
      active: true,
    };
    const existing = find(item);
    if (existing) Object.assign(existing, entry);
    else store.items.push(entry);
    writeJson(FILE, store);
    console.log(`${existing ? "updated" : "added"}: ${entry.qty}${entry.unit ? ` ${entry.unit}` : ""} ${entry.item} (${entry.aisle})`);
    if (!known) console.log(`  not in the recipe catalog — filed under "${entry.aisle}". Use --aisle to move it.`);
    break;
  }

  case "remove": {
    const name = rest.join(" ");
    const i = store.items.findIndex((s) => s.item.toLowerCase() === name.toLowerCase());
    if (i === -1) { console.log(`no staple called "${name}"`); process.exit(1); }
    store.items.splice(i, 1);
    writeJson(FILE, store);
    console.log(`removed: ${name}`);
    break;
  }

  case "on":
  case "off": {
    const name = rest.join(" ");
    const s = find(name);
    if (!s) { console.log(`no staple called "${name}"`); process.exit(1); }
    s.active = cmd === "on";
    writeJson(FILE, store);
    console.log(`${name}: ${s.active ? "on the weekly list" : "skipped"}`);
    break;
  }

  default:
    console.log(`unknown command "${cmd}" — try: list, add, remove, on, off`);
    process.exit(1);
}
