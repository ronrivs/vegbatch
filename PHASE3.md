# Phase 3 — accounts, database, shopping, offline

Scope drafted 2026-09-19. Four decisions, in dependency order.

---

## 1. Which database

**Recommendation: a new Supabase project for VegBatch. Keep the shared model
for the internal tools.**

The current model — one project (`rqbzlfgobmxxobtobinl`) shared by the hub,
GfE and FSN with name differentiators — is a good fit for what it holds. Those
are all Tributary-operated tools, one trust boundary, and they genuinely
cross-reference: the hub reads FSN tables. Splitting those would cost
something and buy nothing.

VegBatch is different in kind, and the line worth drawing is **public versus
internal**, not one project per app.

**Why it has to be separate:**

1. **Supabase Auth is project-wide.** Public signups would land in the same
   `auth.users` table as your internal users. That's a support problem the
   first time you need to reason about who is who, and a security smell
   permanently.

2. **Noisy neighbours — and you already have the precedent.** On 2026-09-18 a
   whole-table index build drained the project's disk-IO budget and took the
   FSN Research tab down. That was one internal tool degrading another, with
   predictable load. A public app with unpredictable traffic sitting next to a
   live client system is the same failure with worse odds.

3. **The pooler role leak.** Also 2026-09-18: `set role service_role` on port
   6543 leaked into other sessions and produced random permission errors.
   That's cross-contamination *within a shared project*. Adding a public app
   to that pool is asking for it.

4. **Quotas are per-project** — monthly active users, storage, bandwidth,
   connections. If VegBatch gets the traffic the SEO work is aiming at, it
   shouldn't be spending the allowance FSN Pulse depends on. A second project
   also means a second free tier, so this is cheaper, not dearer.

5. **Blast radius.** One wrong row-level-security policy in a public app
   exposes only that app's data.

**Cost:** one more project to manage and no cross-project joins. VegBatch
needs no cross-project joins.

---

## 2. Accounts

Per the earlier scope: Supabase Auth with Google, Postgres with RLS keyed to
`household_id` so Ron and Tressa share one list. The site stays static on
Pages — the browser talks to Supabase directly, still no server.

**Where the benefits get advertised** (agreed placement):

1. **At the point of friction, not on arrival.** A quiet line on the plan
   page: *"Sign in to pick this list up on your phone in the shop."* Highest
   converting spot and the only one that isn't nagging.
2. **An `/account` page** — signed out it is the pitch (sync, shared
   household list, cook history, your own dinner photos); signed in it is
   settings, household members, export and delete. One page, two states.
3. **A "Sign in" link in the nav.** Nothing more.

No modal on arrival, and nothing that works today gets gated. The
free-and-open posture is doing real work in search and in `llms.txt`.

**Photos:** per-account, as agreed. Supabase Storage with RLS. Ship an
explicit *"share this publicly"* toggle defaulted off, even before a public
gallery exists — consent is the part that is painful to retrofit.

**Cook history** drives a "last cooked 8 weeks ago" label on the recipe card
and feeds the rotation signal already in the planner.

**Email:** Supabase stores the address as a by-product of sign-in. Using it
for anything else needs a separate opt-in checkbox at signup and a privacy
note.

**Blocked on Ron:** a Google OAuth client (ID + secret, with the VegBatch
callback URL), and confirmation of the new-project decision above.

---

## 3. SKU matching — probably not our problem

The worry was mapping 442 canonical ingredients to retailer products and
maintaining it forever. That burden is real **for Amazon and Kroger**. It is
likely avoidable entirely.

**Instacart's developer platform has an API that takes ingredient line items
as plain text and returns a shoppable link that builds the cart.** If that
still works as described, *Instacart does the matching*, and the whole
maintenance problem stops being ours. We already produce exactly the input it
wants — "3 cans chickpeas", "1 bunch parsley" — because the canonical layer
converts to purchasable units.

**Verify this before committing.** Programme names and capabilities change and
this is from prior knowledge, not a live reading of their docs.

| Retailer | Cart API | Who matches SKUs | Verdict |
|---|---|---|---|
| **Instacart** | yes, from text line items | **them** | **best fit by far** |
| Kroger | yes, but needs UPCs | us | real work, real maintenance |
| Amazon | no usable one | us | avoid — also the weakest rates |
| Walmart | affiliate only | n/a | links only |

### Checked 2026-09-20 — Instacart is closed

Their developer page says, verbatim:

> "We are currently not accepting new applications. There is no waitlist
> available at this time."

So that route is shut. Ron asked why a company would do that; the plausible
reasons are all mundane — the support and compliance cost of each integration
is roughly fixed, so a long tail of small partners costs more than it returns;
platform teams get redirected to enterprise and retail-media revenue; and a
closed door is the cheapest way to pause while a programme is redesigned. It
is not a signal about us.

### What else exists, and the pattern in it

| Option | Open to us now? | Who matches SKUs |
|---|---|---|
| Instacart IDP | **no** — applications closed, no waitlist | them |
| Chicory (70+ retailers) | enterprise sales, contact form only | them |
| Northfork, SideChef | enterprise sales | them |
| **Kroger public API** | **yes — free, self-serve, real Cart API** | **us** (needs UPCs) |
| Amazon / Target / Walmart | affiliate links only (shipped) | n/a |

**The pattern is the point: every option that does the matching for us is
gated behind being a publisher with an audience.** Chicory and Northfork sell
to sites that already have traffic. The blocker is not engineering, it is that
VegBatch has no readers yet.

Kroger is the exception — genuinely self-serve, free, with a Cart API that
adds items to an authenticated customer's cart over OAuth2. Two catches: we
would own the UPC matching after all, and **Kroger does not operate in
Florida**, so Ron and Tressa could not use it themselves. Worth revisiting if
the audience turns out to be Kroger-region; not worth building blind.

### So: nothing to build here yet

The affiliate search links already shipped are the right tool for now, and the
PWA does more for the actual job. Revisit cart integration when there is
traffic to bring to the conversation — at which point Chicory becomes a real
option and Instacart may have reopened.

Hold off on Amazon Associates until there is traffic to convert: they close
accounts with no qualifying sale within 180 days of signup.

---

## 4. PWA — and why it may matter more than the cart

Ron's instinct is right: *"the checklist functions fine, especially if we make
it a PWA."*

**The real job to be done is standing in an aisle with a list.** A tickable,
aisle-sorted list that works with no signal — supermarket basements, thick
walls — is more valuable to more people than one-click ordering, and it is
the thing VegBatch is already good at. Online grocery ordering is a minority
behaviour; walking round a shop is not.

**What it needs:**

- `site.webmanifest` — **already shipped**, with icons and theme colour.
- A service worker caching the app shell, `data/index.json`, the ingredient
  catalogue and any recipe already opened. Cache keyed to the build so a
  deploy invalidates cleanly — a PWA that serves last month's recipes forever
  is worse than no PWA.
- Offline-first for `/plan` specifically. The plan and ticked items already
  live in `localStorage`, so the data is there; it is the assets that need
  caching.
- An install prompt, shown once, quietly.

**Effort:** about half a day. High value per hour, and unlike the cart work it
depends on nothing external.

---

## Suggested order

1. **PWA** — half a day, no external dependencies, serves the main use case.
2. **New Supabase project + accounts** — needs the Google OAuth client.
3. **Instacart** — verify the API first; half a day if it holds up.
4. Cook history label, photos, account page — fold into (2).

Click measurement on the existing shop links lands with (2): a small
`outbound_clicks` table is what finally answers whether anyone clicks.
