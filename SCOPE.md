# VegBatch — Build Scope

Drafted 2026-09-19. Living document.

---

## 0. What the source actually is

268 JPEGs, 528 MB, 4032×2268 (both orientations), shot in one sitting.
Sampled across the range:

| Type | Example | Notes |
|---|---|---|
| Printed blog recipe, full page | Greek Couscous Salad | Clean, complete, has yield/times/author |
| Printed recipe, landscape/rotated | Couscous Salad | Needs auto-rotation |
| Handwritten index card | "QUINOA MORROCAN SALAD" | Ingredients only, no method, heavy abbreviation ("teaspn", "tblspn", "chic peas"), strikethroughs, margin notes |
| Continuation page | pumpkin dump cake steps 4–12 | No title on the page at all |
| Stacked pages | Sweet Potato Quinoa Cakes | Fragments of the sheet underneath visible in frame |

Legibility is good — the handwriting and the print both read fine at 1000 px wide
(tested). No need to ship 4032 px images to the model; ~1600 px longest edge is
plenty and cuts cost ~6×.

**Implication:** expect roughly 150–200 distinct recipes from 268 photos. The
count is unknown until page-grouping runs, and grouping is the step most likely
to produce silent errors, so it gets a human review gate.

---

## 1. Phase 0 — Extraction (do this first, standalone value)

Goal: `recipes.json` — a clean, complete, reviewed dataset. Useful on day one even
if no app is ever built.

### Pipeline
```
source/*.jpg
  → 1. prep       normalize orientation, downscale to 1600px, hash for dupes
  → 2. triage     per image: type, title guess, is-continuation, has-meat, quality
  → 3. group      photos → recipe units  [HUMAN REVIEW GATE]
  → 4. extract    per group: structured JSON against a fixed schema
  → 5. normalize  ingredient lines → canonical ingredient ids + units
  → 6. QA         confidence scores, low-confidence queue  [HUMAN REVIEW GATE]
  → recipes.json + ingredients.json
```

Every stage writes to disk and is independently re-runnable. Nothing is
regenerated that already succeeded. This matters — you will re-run stage 4 and 5
several times as the schema firms up, and you don't want to re-pay for stage 1–3.

### Why Claude vision, not OCR
Tesseract will not read that index card. Neither will it know that "chic peas
(15oz)" means one standard can of chickpeas. The extraction and the
interpretation are the same act here, so do them in one model call with a
structured output schema.

### The review UI (worth building — ~half a day)
A single static local page: source photo on the left, parsed JSON in editable
fields on the right, keyboard shortcuts for approve / fix / flag / merge-with-previous.
At ~180 recipes and ~30 s each that's under two hours of your and Tressa's time,
and it takes the dataset from "mostly right" to gold. Every downstream feature
inherits that quality. Skipping this gate is the single biggest risk to the project.

### Cost
Two to three vision passes over 268 downscaled images plus text passes: on the
order of **$10–25 total**, one time. Not a constraint. Use the best model for
this; the extraction is done once and everything is built on it.

Alternative: run extraction through Claude Code subagents on the existing
subscription instead of the API. Slower and harder to make idempotent. The API
path is worth the ~$20.

---

## 2. The data model

This is the part to get right. Sketch:

```
recipe
  id, slug, title, description, yield_qty, yield_unit,
  prep_min, cook_min, total_min, source_note, is_vegan, is_vegetarian,
  confidence, needs_review

recipe_page          -- provenance back to the photos
  recipe_id, image_filename, page_order

recipe_ingredient    -- the join table; the heart of the thing
  recipe_id, ingredient_id, component (e.g. "Salad" / "Dressing"),
  qty_min, qty_max, unit, unit_canonical, qty_canonical,
  prep_note ("finely chopped"), optional (bool), to_taste (bool),
  raw_text        -- ALWAYS keep the original line verbatim
  sort_order

ingredient           -- canonical
  id, name, plural, category_id, aisle_id,
  is_animal_product, animal_type (dairy|egg|honey|meat|fish|gelatin),
  density_g_per_cup, count_to_g, typical_pack_size, typical_pack_unit,
  is_staple           -- olive oil, salt: assume on hand

ingredient_alias     -- "EVOO", "chic peas", "extra virgin olive oil"
ingredient_category  -- produce / grain / legume / dairy / spice / condiment ...
aisle                -- store-layout ordering for the printed list
substitution         -- ingredient_id → replacement_id, context, note

-- user-side (Phase 3+)
user, plan, plan_recipe (recipe_id, servings_scale), pantry_item,
staple_list_item, grocery_list, grocery_list_item, cook_history
```

Three non-obvious calls baked in above:

- **`raw_text` is never discarded.** Normalization will be wrong sometimes;
  keeping the original line means you can always re-normalize without re-reading
  photos, and the recipe page can display exactly what the card said.
- **`qty_canonical` + `unit_canonical`** (grams and millilitres) is what makes
  summing possible. Needs a density table for the volume↔weight hop — a few dozen
  entries covers 95% of a vegetarian pantry.
- **`typical_pack_size`.** A grocery list should say "1 can chickpeas", not
  "425 g chickpeas". Converting canonical amounts back into *purchasable units* is
  a separate step from summing, and it's the difference between a list you can
  shop and a list you have to translate.

---

## 3. Phased build

### Phase 1 — Normalization + list generation (no UI)
Canonical ingredient table, alias matching, unit conversion, aisle mapping.
Deliverable: a CLI where you name 4 recipes and get a merged, deduped,
aisle-sorted, pack-size-rounded grocery list. **This alone ends the weekly chore.**
Ship it to yourselves before building any web app — it's the fastest path to the
tool actually being used, and using it is how you'll find what the app needs.

### Phase 2 — Public web app (read-only, no auth)
Browse, search, filter by ingredient / category / time / vegan. Recipe pages.
Pick a set of recipes → grocery list → print / email / in-app checklist.
Plan state in localStorage so it works with no account.

### Phase 3 — Accounts
Google sign-in. Saved plans, cook history, favourites, staples list.
"Haven't made this in 8 weeks" rotation signal.

### Phase 4 — Submissions
Paste a URL or upload a photo → the same extraction pipeline → structured recipe
→ moderation queue. This is the one place where AI is a *user-facing* feature and
it's a genuinely good one: it removes the only real barrier to a recipe site
growing.

### Phase 5 — Retail integration / monetization
See § Risks.

---

## 4. Where AI belongs — and where it doesn't

| Use | Verdict |
|---|---|
| Photo → structured recipe | **Yes, essential.** No other way to read those cards. |
| Ingredient normalization of new/submitted recipes | **Yes.** Rule-based first, model for the tail. |
| "Paste a URL, get a recipe" on submission | **Yes.** Best feature/effort ratio in the whole plan. |
| Natural-language search ("something with chickpeas, under 30 min") | Maybe, Phase 3+. Filters cover most of it. |
| **Recipe recommendation** | **No — don't use an LLM.** See below. |

**The recommender should be a solver, not a model.** The valuable recommendation
is deterministic and explainable:

- rotation-aware — you haven't had this in N weeks
- pantry-aware — it uses what you already have
- **overlap-aware — pick 4 recipes for the week that *share* ingredients**

That third one is the differentiator and nobody does it well. If two recipes both
use half a bunch of cilantro, planning them together saves money and stops the
other half rotting in the drawer. Framed properly it's a small optimization
problem: minimize distinct ingredients purchased and minimize leftover fractions,
subject to variety constraints. It runs in milliseconds, gives the same answer
twice, and can explain itself ("these 4 share cilantro, feta, and red onion").
An LLM would do this worse, slower, and differently every time.

**On Jev / the open model:** for 268 one-time extractions the cost difference
between a frontier model and a cheap open one is a rounding error — use the best
model and be done. A small local model becomes interesting later, for
high-volume normalization of user submissions, and only once you have the
reviewed gold dataset to evaluate it against. I don't know the specifics of
Simple Jev's hosted offering; worth a look, but it's a Phase 4 question, not a
Phase 0 one.

---

## 5. Risks and weaknesses

### 5.1 Copyright — the one that matters
Most of this collection is printouts of other people's food blogs (Chelsea's
Messy Apron, etc.) and cookbooks. In the US, **ingredient lists and purely
functional instructions are generally not copyrightable** — they're facts and
procedures. But the headnotes, the descriptive prose, the personality in the
steps ("I am usually a warm-dessert kind of girl"), and the photos **are**
protected. Republishing ~180 blog recipes verbatim on a public site is a real
legal and reputational risk.

The brief says to *strip* branding and backlinks. That makes it worse, not better
— removing attribution turns "we reference their recipe" into "we took their
recipe." It also cuts against the public-good framing; those bloggers are
small operators too.

Three defensible options:

1. **Private-first.** The planner works at full fidelity for the two of you with
   zero risk. Public site launches later on cleared content only.
2. **Attribute and link.** Keep ingredients + functional steps, credit the source,
   link out. This is what every recipe aggregator does, it's the norm in the
   space, and it costs you nothing.
3. **Rewrite.** Keep the ingredient list (fine), write the method in your own
   voice. Defensible and gives the site a consistent tone — but it's ~180 rewrites
   (cheap with a model, but needs review).

**Recommendation: 1 → 2 for launch, 3 opportunistically.** Strip branding and
backlinks only inside your private copy, where there's no audience to mislead.
This one is your call and it changes Phase 2's shape, so decide before Phase 2.

### 5.2 "Remove any meat" is the wrong operation
Deleting bacon from a carbonara doesn't yield a vegetarian carbonara, it yields a
broken recipe. Same for vegan: silently dropping the feta from a Greek salad
produces something nobody wants to eat. Model it instead as:

- `is_vegetarian` / `is_vegan` flags computed from the ingredient table
- a **substitution table** — feta → vegan feta / omit; egg → flax egg; honey → maple
- surfaced as *"make this vegan"* with the specific swaps shown, never as a
  silent rewrite

Given it's your own collection, I'd expect near-zero meat; triage will confirm.
Where meat does appear, flag it for a human decision rather than auto-editing.

### 5.3 Pantry tracking is where meal-planning apps go to die
Nobody maintains a hand-entered pantry inventory past week three. Don't build
it as stated. Two cheaper things that capture most of the value:

- **Staples-only.** A short list of things you always have (oil, salt, flour, soy
  sauce, rice). Marked `is_staple`, excluded from the list by default, with a
  periodic "running low on anything?" prompt. This is ~90% of the benefit.
- **Derived stock.** What you bought last week minus what the week's recipes
  consumed ≈ what's left. Offer it as a pre-filled guess needing a 20-second
  confirm, not a ledger to maintain.

Note this collapses P2's two items into one mechanism, and makes it cheap enough
to pull *into* the core rather than after it.

### 5.4 Servings and scaling
You meal prep; the source recipes have wildly different yields (6 meal-prep
servings, 12 cakes, "4–6 dinner servings"). If the plan doesn't carry a scale
factor per recipe, every grocery quantity is wrong. Cheap to build in at the
start, painful to retrofit — `plan_recipe.servings_scale` is in the model above
for this reason.

### 5.5 Monetization — temper the expectations
Treat the specifics below as *needing verification* before anything is built on
them; program terms change and I'd want to read the current agreements.

- Amazon Associates grocery commission rates are low (low single-digit percent),
  and grocery/Fresh categories have historically been excluded or reduced.
  Building the business case on Amazon grocery commission is optimistic.
- **Instacart** and **Kroger** are the better technical fits — both have had real
  partner/developer APIs including cart construction, which is exactly the
  "send my list to a cart" motion. Walmart runs affiliate through Impact.
- Realistic v1 is not a one-click cart. It's **export the list, plus a
  per-item deep link** to a retailer search. Unglamorous, ships in a day, and you
  learn whether anyone clicks before investing in a partner integration.
- **Contributor commission-sharing should be pushed well out.** The moment you
  pay individuals you inherit payout rails, tax reporting, and a fraud surface
  (people submitting recipes to farm affiliate clicks). Let contributors
  contribute for credit first; revenue share only once there's revenue to share.
- Affiliate disclosure is legally required and should be designed in, not
  bolted on — it also fits the "software you own" posture better than hiding it.

### 5.6 Smaller ones
- **Grouping errors are silent.** A continuation page attached to the wrong
  recipe produces a plausible-looking wrong recipe. Hence the review gate.
- **The index cards lack methods.** Several are ingredient lists only. Decide:
  publish as-is ("assembly salad, no method needed" is often true), or have
  Tressa dictate the method once per card. Flag them; don't have a model invent
  steps and present them as yours.
- **Duplicates.** A decade of collecting means near-duplicate recipes. Detect via
  ingredient-set similarity at QA time and merge or mark as variants.
- **Units in handwriting.** "1/2 teaspn" vs "1 tblspn" misread by one line is a
  10× error in salt. Flag any single-unit-class outlier at QA.

---

## 6. What I'd do next, in order

1. Confirm the three open decisions in `VegBatch.md`.
2. Build the Phase 0 pipeline on a **20-image slice** end to end. Review the
   output together. Tune the schema against reality before spending on all 268.
3. Run the full set. Build the review UI. You and Tressa review.
4. Phase 1 CLI. Use it for one real week of shopping.
5. Only then decide what the web app looks like — a week of real use will tell
   you more than any amount of further scoping.

The thing to protect against is building the website first. The dataset and the
normalization layer are the durable assets; the UI is replaceable.
