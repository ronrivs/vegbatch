# VegBatch Phase 0 pipeline

Recipe photos → structured, reviewed recipe data.

```bash
cd pipeline
npm install

node 1-prep.mjs        # photos -> 1600px, EXIF-rotated, hashed
node 2-triage.mjs      # what is each photo, does it continue the last one
node 3-group.mjs       # photos -> recipes   (check work/REVIEW-groups.md)
node 4-extract.mjs     # recipes -> data/recipes.json
node 5-substitute.mjs  # meat recipes -> vegetarian, or excluded
node 6-sweep.mjs --fix # verify substitutions reached the method text
node 7-normalize.mjs   # ingredient names -> canonical catalog + real units

node review/server.mjs # http://localhost:4173 — the human review pass
node list.mjs 002 043  # the grocery list
node test-units.mjs    # conversion arithmetic
```

## The grocery list

```bash
node list.mjs --find chickpea     # search for recipes
node list.mjs 002 043 115 174     # a week's list
node list.mjs 002x2 043           # 002 at double quantity
node list.mjs --random 4          # pick for me
node list.mjs 002 043 --staples   # add the household's weekly staples
node list.mjs 002 043 --pantry    # also list things assumed already on hand
node list.mjs 002 043 --md        # markdown, for printing or email
node list.mjs 002 043 --why       # show which recipe each amount came from
```

## The web app

```bash
node build-site.mjs     # data + card photos -> ../site/
node serve-site.mjs     # preview at http://localhost:4174
node test-site.mjs      # 36 assertions against the built site
```

**No database, no framework, no build step for the app itself.** The dataset
is 1.7 MB; standing up Postgres to serve read-only data that fits in a file
would be pure ceremony. Supabase earns its place at Phase 3, when accounts
arrive and there is genuinely per-user state to keep. Deploy target is
Cloudflare Pages — same as trib.xyz and gfe.trib.xyz — and there are no Pages
Functions here, so the FSN "cd public first" trap doesn't apply.

Data is split so first paint is cheap: `data/index.json` (264 KB) carries
everything needed to search, filter and sort; a recipe's full detail is one
fetch when you open it.

**No photographs are published.** The card photos are Ron and Tressa's own
handwriting and private notes; they stay in `work/prepped/` as the provenance
record behind the review tool and are never copied into `site/`. The build
also strips `pages`, `review_notes` and approval metadata from every published
recipe. This took the site from 30.9 MB to 2.8 MB.

In their place each recipe gets a **generated tile**: a colour field whose hue
comes from the course (so the grid groups by eye) with the angle and second
stop derived from the recipe id (so no two match), carrying the ingredients
that actually identify the dish. That's more use than a photo when scanning —
you want to know it's chickpeas and cucumber.

Picking those three ingredients needed real ranking, not source order. Source
order puts dressings first, so Autumn Pearl Couscous Salad led with "spicy
brown mustard · lemon juice · orange juice". Now: score by how much a category
identifies a dish (grain and legume high, oil and vinegar zero), demote what
you serve it *on* (the sweet potato burgers led with "burger bun"), and boost
anything the recipe is named after — matching on any substantial word, since
"pumpkin pie mix" is the pumpkin in Pumpkin Dump Cake and its last word is
"mix". 164 of 206 headlines now name something in the title; none lead with an
accompaniment.

Three views, hash-routed:

- **Browse** — search across titles and ingredients, filter by vegan, course,
  time and ingredient.
- **Recipe** — ingredients by component, method, and a *Where this came from*
  panel showing the original index card or printout, plus every household edit
  (annotations applied, broth and meat substitutions) with what was on the
  page and what was done about it.
- **This week** — chosen recipes with per-recipe scaling, and the grocery
  list: aisle-grouped, tickable, printable.

Plan and ticked items persist in `localStorage`, so it works with no account.

### Plan my week

The button picks four recipes that **share ingredients**. Greedy and
deliberately not clever: start somewhere random, then repeatedly add whichever
recipe overlaps most with what's already chosen, with a small penalty for
long ingredient lists so it doesn't just pick four near-identical salads.

Measured over 40 runs: **27.4 fewer distinct items to buy** versus 12.8 for
four random recipes. That's the feature that stops half a bunch of coriander
rotting in the drawer, and it's a solver, not a model — same shape of answer
every time, and it can explain itself.

### One grocery list, two front ends

`lib/grocery.mjs` is pure — no filesystem, no node builtins — so the browser
imports the exact file the CLI uses. This is not tidiness: an aggregation
living in two places is precisely the drift that left "chicken broth" in a
method whose ingredient list already said vegetable broth. `test-site.mjs`
asserts the two produce identical lists.

## Staples vs pantry — two different things

These sound alike and must not be merged again:

| | **Staples list** (`staples.mjs`) | **`is_pantry`** (ingredient catalog) |
|---|---|---|
| What | Recurring weekly buys — 2 peanut butters, 12 bananas | Things you always have — salt, oil, dried oregano |
| Owner | The household. Nothing to do with recipes. | Derived from the ingredient, by rule |
| Effect | **Adds** to the list, with `--staples` | **Omits** from the list, unless `--pantry` |

A staple always wins over the pantry assumption: putting "olive oil" on the
staples list is precisely the case where the default guess is wrong.

```bash
node staples.mjs                              # show the list
node staples.mjs add "peanut butter" 2 jar
node staples.mjs add bananas 12
node staples.mjs add "oat milk" 2 carton --aisle refrigerated
node staples.mjs off bananas                  # keep it, skip it this week
node staples.mjs remove "peanut butter"
```

Staples file into the right aisle by matching the ingredient catalog, but
**only an exact match may claim a staple's identity** — a loose match made
"oat milk" into "milk", and buying the wrong thing is worse than filing it in
the wrong aisle. A staple no recipe has ever used is perfectly valid.

Lives in `data/staples.json` as `{household, items[]}`. When the web app gets
accounts this becomes a per-account table — the shape already matches.

Quantities are summed in grams through the canonical layer, then converted
back into things you can put in a trolley — **"3 cans chickpeas"**, not
"1,275 g chickpeas". `--why` shows the working:

```
☐ 3 cans   chickpeas ◆   (1.28 kg · ~425 g each)
    ← 002  2 cans (15 ounces EACH) chickpeas
    ← 043  -CHIC PEAS (15oz)
```

A printed blog recipe and a handwritten index card, added together correctly.
That is the whole point of stage 7.

Marks: `◆` shared across more than one of the chosen recipes, `~` includes a
quantity that was estimated rather than read.

Every stage is **idempotent**: re-running only does the work that's missing, so
an interrupted run costs nothing to resume. Flags on every stage:

| Flag | Effect |
|---|---|
| `--limit N` | first N items only — use this to try changes cheaply |
| `--only 042` | one recipe by group id (stage 4) |
| `--force` | redo work already done — needed after changing a prompt |
| `--concurrency N` | parallel API calls, default 5 (stages 2 and 4) |

The API key is read from `../../hub/.env`; a local `pipeline/.env` overrides it.
No secret is duplicated into this project.

## Where things land

```
source/           the original photos, never modified
work/
  manifest.json   prepped image index
  prepped/        1600px JPEGs — what actually gets sent to the model
  triage.json     per-photo classification
  groups.json     photo -> recipe grouping  (edit by hand if wrong)
  REVIEW-groups.md  human-readable grouping check
data/
  recipes.json    the dataset. Review edits write straight back here.
  recipes.raw.json  automatic backup of the extraction, made on first edit
```

## Editorial rules in the extraction

These are deliberate and live in the prompt at the top of `4-extract.mjs`:

- **Ingredients and steps are transcribed verbatim.** They're functional
  content. The source's *prose* is not copied — a fresh description is written
  instead, and any author credit goes in `source_attribution` so it can be
  shown or dropped per surface.
- **Missing quantities are estimated**, never left blank, because a grocery
  list needs a number. Every estimate sets `qty_estimated: true` and explains
  itself in `estimate_basis`. `raw_text` always keeps the original line.
- **Handwritten annotations win over printed text** — they're the household's
  own edits. Each one is applied and logged in `household_edits`.
- **Meat broth is swapped for vegetable broth** during extraction, recorded via
  `substituted_from` plus a `household_edits` entry.
- **Meat and fish are left alone by stage 4** — transcribed as written and
  flagged — and handled deliberately by stage 5, which is a separate pass so
  the transcription and the editorial decision never get tangled together.

Anything uncertain sets `needs_review`, which is the review UI's default filter.

## Stage 5 — the meat pass

Runs only on recipes stage 4 flagged. For each it proposes a substitution that
does the same job in the dish (fat and bulk, smoke and salt, shreddable
texture, savoury depth), gives it a real quantity, and rewrites **only** the
instruction steps that mention the meat — every other step stays verbatim.
An ingredient already marked optional is dropped rather than replaced.

Where there's no honest vegetarian version of the dish, the recipe is marked
`excluded: true` with a reason. It is **not deleted** — the data and photos
stay, it just drops out of the planner, and the review UI has a "Put it back
in" button. Exclusion is meant to be rare.

Every substituted recipe is forced back into the review queue, because a swap
always deserves a human eye.

## The review UI

Photo on the left, editable fields on the right. Colour tells you where to
look: amber = an estimated quantity (with the reasoning under it), green = a
substitution, red = meat or fish found. Every ingredient shows the original
line from the page underneath the parsed fields.

- `J` / `K` — next / previous
- `R` — rotate (many cards were photographed sideways; rotation is remembered)
- click the photo to zoom
- `Ctrl`+`Enter` — approve and advance

Edits save automatically. The first edit snapshots the untouched extraction to
`data/recipes.raw.json`, so a bad review pass is always recoverable.

`node review/smoke.mjs` (with the server running) exercises the render, all
filters, an edit round-trip and keyboard nav.

## Stage 7 — the canonical ingredient layer

736 distinct ingredient strings collapse to **442 canonical ingredients**, and
93% of the 2,775 lines resolve to a weight. Two passes on purpose: names are
mapped to a base name first, then attributes are assigned **once per base
name**. One pass would let "olive oil" get 216 g/cup in one batch and 205 in
another.

Then two corrections that are rules, not judgements, so they live in code:

- **Singular/plural merge.** Pass A emitted both `chickpea` and `chickpeas`.
  Left alone that splits one ingredient's quantity across two entries and
  silently halves it on the list. 13 pairs merged.
- **Staples tightened.** The model called canned beans, broth and tomato paste
  staples; those get used up and must be bought. Staples are now the pantry
  shelf only (spices, oils and vinegars, baking, plus a short allowlist) and
  never a perishable aisle. 50 demoted.

Fresh / dried / frozen aggregate separately — they're different purchases —
so a list can carry both "1 bunch fresh parsley" and "1 jar dried parsley".

`test-units.mjs` pins the arithmetic (38 assertions). A wrong constant there
is invisible: the list still looks plausible, it's just wrong.

## Cost policy — subscription first

**Bulk extraction is done. Don't spend API money again without meaning to.**

Every stage that calls the Anthropic API is behind a guard and refuses to run
unless you pass `--allow-api-spend` (or set `VEGBATCH_ALLOW_API_SPEND=1`).
Stages 2, 4, 5, 7 and `6-sweep --fix` are gated. Stage 7 only asks when its
model passes aren't already cached, so re-running it after adding a recipe is
free.

Everything you'll actually use day to day costs nothing: `review/server.mjs`,
`list.mjs`, `staples.mjs`, `add-recipe.mjs`, `import-recipe.mjs`, `6-sweep.mjs` (report mode),
`1-prep.mjs`, `3-group.mjs`, `test-units.mjs`.

### Adding recipes from here on

Do the reading in a Claude Code session — free on the subscription — and let
this script wire the result in:

```bash
node add-recipe.mjs --template > new-recipe.json   # the shape
node add-recipe.mjs new-recipe.json --dry-run      # check it
node add-recipe.mjs new-recipe.json                # add it
```

It validates, assigns the id and slug, maps canonical ingredients, converts
units, computes the vegetarian and vegan flags, and queues the recipe for
review. No API calls — validation and arithmetic only.

An ingredient the catalog doesn't know is **reported, not invented**: you add
it to `data/ingredients.json` (the script prints the shape) and re-run. A
guessed density silently corrupts every grocery list that ingredient ever
appears on, so it's a deliberate stop.

### Importing a recipe from a page or pasted text

`import-recipe.mjs` does the reading when the recipe already exists as text,
so the in-session step above is only needed for the tail it can't settle:

```bash
node import-recipe.mjs https://some-blog.com/lentil-soup/          # report only
node import-recipe.mjs https://some-blog.com/lentil-soup/ --add    # add it
node import-recipe.mjs recipe.txt --add                            # title, ingredients, method
node import-recipe.mjs recipe.json --add                           # schema.org Recipe, or our template
```

A URL is fetched once and read for its schema.org `Recipe` JSON-LD, which
nearly every recipe site publishes for Google. A page without one is refused
with instructions to paste the text instead. Still zero API calls; the rules
live in `lib/import.mjs` and `test-import.mjs` pins them:

- **Ingredient lines are parsed deterministically** — fractions in every
  spelling, ranges, `1 (15-ounce) can`, `4 garlic cloves`, `Juice of 1 lime`
  (you buy a lime), `Pinch of`, `(optional)`, `for serving`. `raw_text` keeps
  the line as the page had it.
- **Catalog matching has two tiers.** An alias, exact name, plural, or a
  stripped prep word (`minced garlic`, `dried thyme`, `yellow or white onion`)
  is applied on its own and written back to `ingredient-aliases.json` so the
  next import knows it. A looser match — a colour dropped, or a catalog name
  merely contained in the line — is printed as a suggestion with the exact
  `--map "item=name"` to accept it, or `--accept-suggestions` for all. An
  ingredient with no match at all is reported, as `add-recipe` always has.
- **Serves N is rescaled to the collection's 5**, the same move the r2
  cookbook got, snapped to eighths and recorded as a `scale` household edit.
  Desserts, snacks and anything measured in cookies keep their yield
  (`fixed_yield`). `--keep-quantities` opts out.
- **Meat broth becomes vegetable broth**, in the ingredient and in every step
  that names it, recorded in `household_edits`. Any other meat or fish is
  flagged in `animal_products` and left as written for a human decision —
  exactly the stage 4 / stage 5 split.
- **The description is drafted, never copied.** One plain sentence from the
  headline ingredients and the time; `review_notes` says to rewrite it. The
  source's prose is read for course hints only. Author and site land in
  `source_attribution`, the page in `source_url`.

The normalized JSON is left in `work/imports/<slug>.json` either way, so a
Claude Code session can finish anything the rules reported and hand it to
`add-recipe.mjs`. Both scripts share `lib/add-recipe.mjs` for the wiring —
one place that validates, assigns ids, converts units and sets the flags.

The pipeline stays in the repo as the record of how the dataset was built —
the editorial rules live in those prompts, and it's the only sane route if the
whole set ever needs re-extracting. It just shouldn't run by reflex.

## Cost

**$30.24 for all 268 photos**, end to end, on Opus 5:

| Stage | Cost |
|---|---|
| 2 triage | $4.08 |
| 4 extract | $23.31 |
| 5 substitute | $0.39 |
| 6 sweep | $0.06 |
| 7 normalize | $2.40 |

A `--limit 20` trial run is about $1.50.
