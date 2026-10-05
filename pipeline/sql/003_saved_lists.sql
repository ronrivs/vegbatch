-- Shopping history: what this household actually bought, week by week.
--
-- The items are frozen at save time rather than re-derived from the plan.
-- A record of a past shop has to stay true even after a recipe is edited, an
-- ingredient's pack size is corrected, or the scaling model changes — all of
-- which have happened. Re-deriving would quietly rewrite history; storing the
-- rendered lines keeps it a record instead of a guess.
--
-- The plan is kept alongside so a good week can still be reloaded.

create table if not exists saved_lists (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references households on delete cascade,
  saved_at      timestamptz not null default now(),
  title         text,
  recipes       jsonb not null default '[]'::jsonb,   -- [{id, title, scale}]
  options       jsonb not null default '{}'::jsonb,
  items         jsonb not null default '[]'::jsonb,   -- frozen rendered lines
  n_items       int not null default 0,
  n_ticked      int not null default 0,
  created_by    uuid references auth.users on delete set null
);

create index if not exists saved_lists_household_idx
  on saved_lists (household_id, saved_at desc);

alter table saved_lists enable row level security;

drop policy if exists saved_lists_rw on saved_lists;
create policy saved_lists_rw on saved_lists for all
  using (household_id = auth_household()) with check (household_id = auth_household());
