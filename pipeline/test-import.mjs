/**
 * Tests for the recipe importer.
 *
 * No network: a schema.org Recipe fixture stands in for a fetched page. The
 * catalog and aliases are the real ones, because the point of most of these
 * is "does this line land on the right ingredient in OUR catalog".
 *
 *   node test-import.mjs
 */
import path from "node:path";
import { DATA, readJson } from "./lib/config.mjs";
import {
  parseIngredientLine, resolveItem, parseYield, parseMinutes, inferCourse,
  recipeFromHtml, sourceFromJsonLd, sourceFromText, normalizeSource, flattenInstructions, animalProduct,
} from "./lib/import.mjs";
import { prepareRecipes } from "./lib/add-recipe.mjs";

const catalog = readJson(path.join(DATA, "ingredients.json"), {});
const aliases = readJson(path.join(DATA, "ingredient-aliases.json"), {});
const recipes = readJson(path.join(DATA, "recipes.json"), []);

let pass = 0, fail = 0;
const t = (name, ok, detail = "") => {
  if (ok) pass++;
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};
const eq = (name, actual, expected) => t(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);

console.log("\nimporter\n");
const r0 = (s) => resolveItem(s, catalog, aliases);

// --- ingredient lines
let i = parseIngredientLine("&frac14; cup extra virgin olive oil");
eq("entity fraction", [i.qty_min, i.unit, i.item], [0.25, "cup", "extra virgin olive oil"]);
t("no note invented", i.prep_note === null, i.prep_note);

i = parseIngredientLine("1 medium yellow or white onion, chopped");
eq("size word stripped, colour kept", [i.qty_min, i.unit, i.item], [1, null, "yellow or white onion"]);
eq("comma prep -> note", i.prep_note, "medium; chopped");

i = parseIngredientLine("2 bay leaves", (x) => x === "bay leaves");
eq("count noun stays when the remainder is nothing", [i.qty_min, i.unit, i.item], [2, null, "bay leaves"]);

i = parseIngredientLine("4 garlic cloves, pressed or minced");
eq("trailing count noun becomes the unit", [i.qty_min, i.unit, i.item], [4, "clove", "garlic"]);

i = parseIngredientLine("1 (15-ounce) can chickpeas, rinsed and drained");
eq("pack size before the noun", [i.qty_min, i.unit, i.item], [1, "can", "chickpeas"]);
t("pack size kept in the note", /15-ounce/.test(i.prep_note) && /rinsed/.test(i.prep_note));

i = parseIngredientLine("2 cans (15 oz each) diced tomatoes");
eq("pack size after the noun, prep word kept", [i.qty_min, i.unit, i.item], [2, "can", "diced tomatoes"]);

i = parseIngredientLine("1½ cups red lentils, rinsed");
eq("unicode mixed number", [i.qty_min, i.unit, i.item], [1.5, "cup", "red lentils"]);

i = parseIngredientLine("1 to 2 tablespoons lemon juice");
eq("range", [i.qty_min, i.qty_max, i.unit], [1, 2, "tablespoon"]);

i = parseIngredientLine("Salt and freshly ground black pepper, to taste");
eq("to taste", [i.qty_min, i.to_taste], [null, true]);

i = parseIngredientLine("Pinch of red pepper flakes (optional)");
eq("optional + pinch", [i.optional, i.qty_min, i.unit, i.item], [true, 1, "pinch", "red pepper flakes"]);

i = parseIngredientLine("Juice of 1 lime");
eq("juice of a lime buys a lime", [i.qty_min, i.unit, i.item, i.prep_note], [1, null, "lime", "juice of"]);
i = parseIngredientLine("Zest of 2 lemons");
eq("zest of two lemons", [i.qty_min, i.item], [2, "lemon"]);

i = parseIngredientLine("1 large can (28 ounces) diced tomatoes, lightly drained");
eq("size word between number and unit", [i.qty_min, i.unit, i.item], [1, "can", "diced tomatoes"]);

i = parseIngredientLine("Fresh cilantro, for serving");
eq("a garnish is optional", [i.optional, i.item], [true, "fresh cilantro"]);

eq("brown or green lentils buys the one we know", r0("brown or green lentils")?.confident, true);
eq("bowls are a main", inferCourse(["Tressa's Black Bean Bowls"]), "main");

i = parseIngredientLine("2 tbsp. olive oil, plus more for drizzling");
eq("abbreviated unit with a dot", [i.qty_min, i.unit, i.item], [2, "tablespoon", "olive oil"]);
t("plus-more goes to the note", /plus more/.test(i.prep_note));

i = parseIngredientLine("3 cups vegetable broth");
eq("plain", [i.qty_min, i.unit, i.item], [3, "cup", "vegetable broth"]);

i = parseIngredientLine("1 bunch fresh cilantro, chopped");
eq("form word stays in the item", [i.unit, i.item], ["bunch", "fresh cilantro"]);

i = parseIngredientLine("2 large eggs");
eq("eggs", [i.qty_min, i.item], [2, "eggs"]);
t("raw text is untouched", i.raw_text === "2 large eggs");

// --- catalog matching
const r = (s) => resolveItem(s, catalog, aliases);
eq("exact", r("tofu")?.bases, ["tofu"]);
t("the alias table wins over the bare name", r("onion")?.bases[0] === "yellow onion" && r("onion").via === "alias", JSON.stringify(r("onion")));
eq("plural -> singular", r("eggs")?.bases, ["egg"]);
t("plural is confident", r("eggs")?.confident === true);
eq("prep words stripped", r("extra virgin olive oil")?.bases, ["olive oil"]);
eq("form word remembered", [r("dried thyme")?.bases, r("dried thyme")?.form], [["thyme"], "dried"]);
eq("fresh thyme", [r("fresh thyme")?.bases, r("fresh thyme")?.form], [["thyme"], "fresh"]);
eq("ground cumin", r("ground cumin")?.bases, ["cumin"]);
eq("bay leaves", r("bay leaves")?.bases, ["bay leaf"]);
eq("minced garlic", r("minced garlic")?.bases, ["garlic"]);
const diced = r("canned diced tomatoes");
eq("canned diced tomatoes -> tomatoes, form canned", [diced?.bases, diced?.form, diced?.confident], [["tomatoes"], "canned", true]);
const alt = r("yellow or white onion");
t("A or B lends the noun and resolves", alt?.confident && alt.bases[0] === "yellow onion" && alt.bases.includes("white onion"), JSON.stringify(alt));
t("gibberish is unknown", r("flibbertigibbet") === null);
t("the real alias table is honoured", r("almonds")?.bases[0] === "almond");

// the two loose tiers, against a tiny catalog so the real alias table can't rescue them
const mini = { lentils: { id: "lentils", name: "lentils" }, carrot: { id: "carrot", name: "carrot" } };
const colour = resolveItem("red lentils", mini, {});
eq("a colour-only difference is a suggestion", [colour?.bases, colour?.confident, colour?.via], [["lentils"], false, "colour"]);
const contains = resolveItem("heirloom carrots", mini, {});
eq("a containment match is a suggestion", [contains?.bases, contains?.confident, contains?.via], [["carrot"], false, "contains"]);

// --- metadata
eq("yield list", parseYield(["4", "4 servings"]), { yield_text: "4 servings", yield_qty: 4, yield_unit: "serving" });
eq("serves range", parseYield("Serves 4-6").yield_qty, 5);
eq("makes cookies", [parseYield("Makes 24 cookies").yield_qty, parseYield("Makes 24 cookies").yield_unit], [24, "cookie"]);
eq("iso duration", parseMinutes("PT1H30M"), 90);
eq("english duration", parseMinutes("1 hour 10 minutes"), 70);
eq("minutes only", parseMinutes("45 min"), 45);
eq("course from category", inferCourse(["Soup"], "hearty"), "soup");
eq("course from keywords", inferCourse(["Main Course", "Dinner"]), "main");
eq("dessert", inferCourse(["Cookies"]), "dessert");
eq("no course", inferCourse(["Whatever"]), null);

// --- animal products
eq("chicken broth is a broth", animalProduct("chicken broth", null)?.type, "meat_broth");
eq("bacon is meat", animalProduct("bacon", null)?.type, "meat");
eq("anchovies are fish", animalProduct("anchovies", null)?.type, "fish");
eq("parmesan is rennet cheese", animalProduct("parmesan cheese", catalog["parmesan cheese"])?.type, "cheese_rennet");
eq("feta is dairy", animalProduct("feta", catalog["feta"])?.type, "dairy");
eq("coconut milk is not dairy", animalProduct("coconut milk", catalog["coconut milk"]), null);
eq("egg", animalProduct("eggs", null)?.type, "egg");
eq("honey", animalProduct("honey", catalog["honey"])?.type, "honey");
eq("tofu is fine", animalProduct("tofu", catalog["tofu"]), null);

// --- instructions in every shape sites use
eq("HowToStep list", flattenInstructions([{ "@type": "HowToStep", text: "Chop." }, { "@type": "HowToStep", text: "Cook." }]).map((s) => s.text), ["Chop.", "Cook."]);
eq("HowToSection", flattenInstructions([{ "@type": "HowToSection", name: "Soup", itemListElement: [{ "@type": "HowToStep", text: "Simmer." }] }]).map((s) => s.text), ["Simmer."]);
eq("single blob", flattenInstructions("1. Chop the onion. 2. Cook it.").map((s) => s.text), ["Chop the onion.", "Cook it."]);
eq("html stripped", flattenInstructions([{ text: "Add <strong>salt</strong> &amp; pepper." }])[0].text, "Add salt & pepper.");

// --- a page fixture, end to end
const LD = {
  "@context": "https://schema.org", "@type": "Recipe",
  name: "Test Lentil Soup", description: "The best soup you'll ever make!!! My grandmother...",
  author: { "@type": "Person", name: "Some Blogger" },
  recipeYield: ["4", "4 servings"], recipeCategory: "Soup", recipeCuisine: "Mediterranean",
  prepTime: "PT10M", cookTime: "PT45M", totalTime: "PT55M", keywords: "lentil soup, vegan",
  recipeIngredient: [
    "&frac14; cup extra virgin olive oil",
    "1 medium yellow onion, chopped",
    "2 carrots, peeled and chopped",
    "4 garlic cloves, minced",
    "2 teaspoons ground cumin",
    "1 cup lentils, rinsed",
    "4 cups chicken broth",
    "1 (15-ounce) can diced tomatoes",
    "2 heirloom carrots, sliced",
    "Salt and pepper, to taste",
  ],
  recipeInstructions: [
    { "@type": "HowToStep", text: "Warm the olive oil in a large pot." },
    { "@type": "HowToStep", text: "Add the chicken broth and lentils; simmer 30 minutes." },
  ],
};
const html = `<html><head><script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@graph": [{ "@type": "WebPage" }, LD] })}</script></head><body>hi</body></html>`;
const node = recipeFromHtml(html);
t("finds the Recipe inside @graph", node?.name === "Test Lentil Soup");
const src = sourceFromJsonLd(node, { url: "https://www.example-blog.com/lentil-soup/" });
eq("author + host", [src.author, src.host], ["Some Blogger", "example-blog.com"]);
eq("times", [src.prep_min, src.cook_min, src.total_min], [10, 45, 55]);

const { recipe, report, learned } = normalizeSource(src, { catalog, aliases, options: {} });
eq("course inferred", recipe.course, "soup");
eq("cuisine", recipe.cuisine, "mediterranean");
eq("attribution", recipe.source_attribution, "Some Blogger (example-blog.com)");
t("source prose is never copied", !recipe.description.includes("grandmother") && !recipe.description.includes("!"), recipe.description);
t("description names the headline ingredients", /lentils/.test(recipe.description), recipe.description);
eq("rescaled 4 -> 5", report.scaled && [report.scaled.from, report.scaled.to], [4, 5]);
const oil = recipe.components[0].ingredients[0];
eq("quantities scaled and snapped to eighths", oil.qty_min, 0.375);
eq("yield relabelled", [recipe.yield_qty, recipe.yield_text], [5, "5 servings"]);
t("scale recorded as a household edit", recipe.household_edits.some((e) => e.kind === "scale"));
const broth = recipe.components[0].ingredients.find((x) => x.substituted_from);
eq("chicken broth swapped", [broth?.item, broth?.substituted_from], ["vegetable broth", "chicken broth"]);
t("and the step text follows", recipe.instructions[1].text.includes("vegetable broth") && !recipe.instructions[1].text.includes("chicken"), recipe.instructions[1].text);
t("no meat flagged after the swap", report.meat.length === 0 && recipe.animal_products.length === 0, JSON.stringify(recipe.animal_products));
t("heirloom carrots is a suggestion, not a guess", report.suggestions.some((s) => s.item === "heirloom carrots" && s.suggested === "carrot"), JSON.stringify(report.suggestions));
t("a confident match the alias table lacks is learned", learned["yellow onion"] === undefined && Object.values(learned).every((a) => catalog[a.base_name]), JSON.stringify(learned));
t("review notes say what to do", /description/.test(recipe.review_notes) && /Rescaled/.test(recipe.review_notes));
t("raw text survives the whole way, entities decoded", recipe.components[0].ingredients[0].raw_text === "¼ cup extra virgin olive oil", recipe.components[0].ingredients[0].raw_text);

// the same import with the suggestion accepted wires in cleanly
const accepted = normalizeSource(src, { catalog, aliases, options: { acceptSuggestions: true } });
const prepared = prepareRecipes({ incoming: [accepted.recipe], recipes, catalog, aliases: { ...aliases, ...accepted.learned } });
eq("no problems", prepared.problems, []);
eq("nothing unknown once suggestions are accepted", [...prepared.unknown.keys()], []);
t("gets the next id", prepared.added[0]?.id === String(Math.max(...recipes.map((x) => Number(x.id))) + 1).padStart(3, "0"), prepared.added[0]?.id);
t("vegan after the broth swap", prepared.added[0]?.is_vegan === true);
t("queued for review", prepared.added[0]?.needs_review === true && prepared.added[0]?.reviewed === false);
const weighed = prepared.added[0].components[0].ingredients.filter((x) => x.qty_g != null).length;
t("most lines resolve to a weight", weighed >= 6, `${weighed}`);
const pinchy = normalizeSource(sourceFromText("Pinch Test\nServes 4\n1 cup lentils\nPinch of salt\nCook."), { catalog, aliases, options: {} });
eq("a pinch is not rescaled", pinchy.recipe.components[0].ingredients.map((x) => x.qty_min), [1.25, 1]);
t("--map overrides", normalizeSource(src, { catalog, aliases, options: { map: { "heirloom carrots": "carrot" } } }).report.suggestions.length === 0);
t("--keep-quantities skips the rescale", normalizeSource(src, { catalog, aliases, options: { keepQuantities: true } }).report.scaled === null);
t("a duplicate title is refused", prepareRecipes({ incoming: [{ ...accepted.recipe, title: recipes[0].title }], recipes, catalog, aliases: { ...aliases, ...accepted.learned } }).problems.length === 1);

// --- a meat recipe is flagged, not fixed
const meaty = normalizeSource(sourceFromText(`Bacon Lentil Soup
Serves 4
Ingredients
4 slices bacon, chopped
1 cup lentils
4 cups beef stock
Instructions
1. Fry the bacon.
2. Add the beef stock and lentils.`), { catalog, aliases, options: {} });
eq("bacon reported", meaty.report.meat, ["bacon"]);
t("bacon stays as written", meaty.recipe.components[0].ingredients[0].item === "bacon");
eq("beef stock -> vegetable stock", meaty.recipe.components[0].ingredients[2].item, "vegetable stock");
t("meat makes it not vegetarian", prepareRecipes({ incoming: [{ ...meaty.recipe, title: "zz-meat-test" }], recipes, catalog, aliases: { ...aliases, ...meaty.learned, bacon: { original: "bacon", base_name: "onion", form: null, is_compound: false, parts: [] } } }).added[0]?.is_vegetarian === false);

// --- pasted text
const txt = sourceFromText(`Chickpea Salad
Serves 2
Prep time: 15 minutes
From: Grandma's card

For the dressing:
2 tablespoons olive oil
1 lemon, juiced

For the salad:
1 can chickpeas, drained
1 cucumber, diced
1/4 cup feta, crumbled

Method
Whisk the dressing.
Toss everything together.`);
eq("title from first line", txt.title, "Chickpea Salad");
eq("yield", txt.yield, "2");
eq("prep", txt.prep_min, 15);
eq("attribution", txt.author, "Grandma's card");
eq("components from sub-heads", txt.sections.map((s) => s.name), ["Dressing", "Salad"]);
eq("steps", txt.instructions.map((s) => s.text), ["Whisk the dressing.", "Toss everything together."]);
const salad = normalizeSource(txt, { catalog, aliases, options: {} });
eq("course from title", salad.recipe.course, "salad");
eq("scaled 2 -> 5", salad.report.scaled?.factor, 2.5);
eq("components carried", salad.recipe.components.map((c) => c.ingredients.length), [2, 3]);
t("feta flagged dairy", salad.recipe.animal_products.some((a) => a.type === "dairy"));

// no headers at all
const bare = sourceFromText(`Quick Beans
2 cans black beans
1 onion, diced
Cook the onion, add the beans, heat through.`);
eq("number-led lines are ingredients", bare.ingredient_lines.length, 2);
eq("the rest is the method", bare.instructions.length, 1);

// a batch recipe keeps its yield
const cookies = normalizeSource(sourceFromText(`Oat Cookies
Makes 24 cookies
Course: dessert
2 cups oats
1/2 cup honey
Bake.`), { catalog, aliases, options: {} });
t("desserts are not rescaled", cookies.report.scaled === null);
eq("and keep a fixed yield", [cookies.recipe.fixed_yield, cookies.recipe.yield_qty, cookies.recipe.yield_unit], [true, 24, "cookie"]);
t("honey flagged", cookies.recipe.animal_products.some((a) => a.type === "honey"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
