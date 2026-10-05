/**
 * Stage 11 — descriptions that still name the meat.
 *
 * Stage 5 replaced ingredients and rewrote the method steps, but never the
 * description. Seven of the twelve substituted recipes still described meat
 * they no longer contain — and with pre-rendering, the description became the
 * page's meta description. "Chili — vegan recipe" was going to be indexed as
 * "browned ground beef with onion". Misleading to a reader and actively
 * harmful in search.
 *
 * The same drift as the broth-in-the-method bug: a substitution applied in one
 * place and not the others. Now there are three places, so `12-sweep-meat.mjs`
 * checks all of them.
 *
 * Rewritten by hand against each recipe's actual current ingredients — no API
 * spend, and a human decision anyway.
 *
 *   node 11-fix-descriptions.mjs [--dry-run]
 */
import path from "node:path";
import { DATA, readJson, writeJson } from "./lib/config.mjs";

const RECIPES = path.join(DATA, "recipes.json");
const dryRun = process.argv.includes("--dry-run");

const FIXES = {
  "083": {
    description:
      "A straightforward stovetop chili of browned plant-based grounds with onion, green pepper, kidney beans and diced tomato, heavy on chili powder. It simmers for half an hour and reheats well through the week.",
  },
  "084": {
    description:
      "A basic quiche built in a store-bought pie shell, with a simple egg-and-milk custard and your choice of two fillings: broccoli, mushroom and onion with cheddar, or spinach with Swiss. It bakes in under an hour and eats well warm or cold.",
  },
  "089": {
    description:
      "A brothy lentil soup with plant-based Italian sausage, celery, onion and a bunch of baby kale, finished with a splash of red wine vinegar. It simmers in about half an hour and reheats well through the week.",
  },
  "090": {
    description:
      "A slow-simmered split pea soup built on a smoky vegetable broth, with browned smoked tofu standing in for the ham and the peas cooked down soft. Carrot, celery and onion go in near the end. Thick, plain and spoon-coating.",
  },
  "092": {
    description:
      "A one-pan pasta where blanched broccoli rabe, garlic and red pepper flakes are tossed with browned plant-based Italian sausage and orecchiette, finished with grated parmesan. Hearty and a little bitter-edged, the kind of dinner that comes together while the pasta water boils.",
  },
  "153": {
    description:
      "Tortillas spread with a taco-seasoned cream cheese and cheddar mixture, filled with black beans, peppers and cilantro, then rolled, chilled and sliced into spirals. They are served cold with guacamole or salsa for dipping.",
  },
  "200": {
    // the chicken became mushrooms, so the title was simply wrong
    title: "Mushroom Penne with Artichoke, Tomato & Pesto",
    slug: "mushroom-penne-with-artichoke-tomato-pesto",
    description:
      "A skillet pasta where cremini mushrooms, canned artichokes and diced tomatoes simmer in cream and basil pesto, then get folded through penne with grated parmesan. Rich and quick, thinned with a splash of water or extra cream if the sauce tightens.",
  },
};

const recipes = readJson(RECIPES, []);
const changed = [];

for (const [id, fix] of Object.entries(FIXES)) {
  const r = recipes.find((x) => x.id === id);
  if (!r) { console.log(`  !! no recipe ${id}`); continue; }
  const before = { title: r.title, description: r.description };
  Object.assign(r, fix);
  if (fix.title && fix.title !== before.title) {
    (r.household_edits ??= []).push({
      kind: "correction",
      written: `Card title: “${before.title}”`,
      applied: "Renamed. The chicken was replaced with cremini mushrooms, so the old title no longer described the dish.",
    });
  }
  changed.push({ id, ...before, now: r.title });
}

// verify: no description should name a meat the recipe no longer has
const MEAT = /\b(ground beef|beef|bacon|ham|sausage|chicken|pork|turkey|anchovy|anchovies)\b/i;
const OK = /(plant-based|vegetarian|vegan|meatless|tempeh|smoked tofu|instead of|stands? in for)/i;
const residue = recipes.filter((r) => MEAT.test(r.description ?? "") && !OK.test(r.description ?? ""));
const titleResidue = recipes.filter((r) => /\b(chicken|beef|pork|bacon|ham)\b/i.test(r.title));

if (!dryRun) writeJson(RECIPES, recipes);

console.log(`${dryRun ? "[dry run] " : ""}description fixes\n`);
for (const c of changed) {
  console.log(`  ${c.id} ${c.now}${c.title !== c.now ? `   (was "${c.title}")` : ""}`);
}
console.log(`\n  descriptions still naming meat: ${residue.length}${residue.length ? " -> " + residue.map((r) => r.id).join(", ") : ""}`);
console.log(`  titles still naming meat: ${titleResidue.length}${titleResidue.length ? " -> " + titleResidue.map((r) => r.id + " " + r.title).join("; ") : ""}`);
