# VegBatch

**vegbatch.com** · *Cook once. Eat all week.*

**What it is:** A vegetarian meal-planning tool built around the weekly loop Ron & Tressa
have run by hand for a decade: pick meals → check stock → write a list → shop.

**Seed asset:** ~268 phone photos of their personal recipe collection
(`source/`, shot 2026-09-19, chronological order). Mix of printed web/blog pages and
handwritten index cards. Some recipes span 2+ photos.

**Positioning:** Public good. Core product free. Software you own.

## Key reframe
The unit of the product is **the week**, not the recipe. A recipe browser doesn't
solve their problem; a *consolidated, deduplicated, aisle-sorted grocery list for a
week of chosen meals* does. Everything else is in service of that.

The hardest part is not OCR — it's **ingredient normalization**. "2 tablespoons EVOO",
"1/4 cup olive oil", and "olive oil, to taste" have to collapse to one canonical
ingredient with comparable units before you can sum a grocery list, filter by
ingredient, match a pantry, or map to a retailer SKU. That layer is the product.

## Docs
- SCOPE.md — build plan, data model, risks
- MONETIZATION.md — accounts + affiliate scope (2026-09-19)
- PHASE3.md — accounts, database choice, Instacart, PWA (2026-09-19)
- PROGRESS.md — what has shipped

## Status
Scoping. See `SCOPE.md` for the build plan, `PROGRESS.md` for what's done.

## Open decisions (blocking Phase 2+)
1. **Copyright posture for the public site** — the collection is largely printouts of
   other people's blog recipes. See SCOPE.md § Risks.
2. **Meat / vegan handling** — auto-strip vs. flag-and-substitute.
3. **Public scope** — full public site vs. private planner first.

## Stack (proposed)
Supabase Postgres + Cloudflare Pages/Functions — same shape as FSN Pulse and
gfe.trib.xyz, so no new ops surface. Extraction in Node, Claude vision, key already
present at `projects\hub\.env`.
