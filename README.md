# VegBatch

**Cook once. Eat all week.** Free vegetarian and vegan meal planning with an
automatic grocery list — live at [vegbatch.com](https://vegbatch.com).

Pick a week of recipes (or let it pick four that share ingredients), scale
them, and get one aisle-sorted list in quantities you can actually buy: "3 cans
chickpeas", not "1,275 g". Works offline in the shop. No account needed; an
account adds sync across devices, a shared household list, saved shops and
cook history.

## What's here

```
data/            the dataset — 254 recipes, 508 canonical ingredients, alias table
pipeline/        everything that builds, tests and deploys the site (Node, no framework)
pipeline/site/   the web app source: one HTML shell, one app.js, shared lib/
site/            build output (gitignored) — `npm run build` in pipeline/
```

Start with [`pipeline/README.md`](pipeline/README.md). It covers the grocery
list, the staples-vs-pantry distinction, the canonical ingredient layer,
importing recipes, and the deploy chain. [`SCOPE.md`](SCOPE.md) is the
original plan and data model.

```bash
cd pipeline
npm install
npm run build          # data -> ../site
node serve-site.mjs    # http://localhost:4174
npm test               # unit + import + site checks (serve-site must be running)
```

Adding a recipe costs nothing and calls no API:

```bash
node import-recipe.mjs https://some-blog.com/lentil-soup/ --add
node import-recipe.mjs recipe.txt --add
```

## How the recipes were made

The collection began as 268 phone photos of one household's recipe cards and
printouts, read into structured data by a model once, then reviewed by hand.
Every recipe is vegetarian; meat broth was swapped for vegetable broth and the
swap recorded. Ingredients and method steps are transcribed as written;
descriptions are our own, never a source's prose. Where a card named its
source, that credit is kept in `source_attribution` and shown on the page.
The photographs themselves are not part of this repository.

## Licence

- **Code** (everything under `pipeline/`, including the web app) is licensed
  under the [GNU Affero General Public License v3.0](LICENSE). You may run,
  study, change and redistribute it, including commercially, provided your
  version — including one offered over a network — is released under the
  same terms with its source.
- **Data** (everything under `data/`) is licensed under
  [Creative Commons Attribution-NonCommercial-ShareAlike 4.0](LICENSE-DATA).
  Use it, build on it, share it under the same terms, with credit, and not
  for commercial purposes.

Made with love by [Tributary](https://trib.xyz).
