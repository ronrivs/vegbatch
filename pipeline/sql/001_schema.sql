-- VegBatch schema.
--
-- Everything is owned by a household, not a user, because Ron and Tressa
-- shop from one list. A user belongs to exactly one household and gets one
-- created on first sign-in, so the shared case costs nothing to the single
-- user and the single-user case costs nothing to the shared one.
--
-- Every table is row-level-secured against the caller's household. This is a
-- public app: a missing policy is a data leak, so nothing is left to the
-- application layer to enforce.

-- ---------------------------------------------------------------- tables

create table if not exists households (
  id          uuid primary key default gen_random_uuid(),
  name        text,
  created_at  timestamptz not null default now()
);

create table if not exists profiles (
  id            uuid primary key references auth.users on delete cascade,
  household_id  uuid not null references households on delete cascade,
  email         text,
  display_name  text,
  -- using the address for anything beyond sign-in needs consent, recorded here
  marketing_opt_in boolean not null default false,
  created_at    timestamptz not null default now()
);
create index if not exists profiles_household_idx on profiles (household_id);

create table if not exists staples (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references households on delete cascade,
  item          text not null,
  qty           numeric not null default 1,
  unit          text,
  aisle         text,
  note          text,
  canonical     text,
  active        boolean not null default true,
  updated_at    timestamptz not null default now(),
  unique (household_id, item)
);
create index if not exists staples_household_idx on staples (household_id);

-- One current plan per household. History of past weeks is cook_history's
-- job; keeping every abandoned plan forever would be noise.
create table if not exists plans (
  household_id  uuid primary key references households on delete cascade,
  days          int  not null default 5,
  people        int  not null default 2,
  recipes       jsonb not null default '[]'::jsonb,   -- [{id, scale}]
  ticked        jsonb not null default '[]'::jsonb,   -- line keys
  options       jsonb not null default '{}'::jsonb,
  updated_at    timestamptz not null default now()
);

create table if not exists cook_history (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references households on delete cascade,
  recipe_id     text not null,
  cooked_on     date not null default current_date,
  created_at    timestamptz not null default now()
);
create index if not exists cook_history_lookup on cook_history (household_id, recipe_id, cooked_on desc);

create table if not exists recipe_photos (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references households on delete cascade,
  user_id       uuid not null references auth.users on delete cascade,
  recipe_id     text not null,
  storage_path  text not null,
  caption       text,
  -- default off deliberately. A public gallery may never exist, but consent
  -- is the part that is painful to retrofit, so it is collected from day one.
  is_public     boolean not null default false,
  created_at    timestamptz not null default now()
);
create index if not exists recipe_photos_recipe_idx on recipe_photos (recipe_id) where is_public;
create index if not exists recipe_photos_household_idx on recipe_photos (household_id, recipe_id);

-- Answers the only question that justifies building a real cart integration:
-- does anyone actually click through to a retailer? Deliberately anonymous —
-- no user id, no household. It is a counter, not behavioural tracking.
create table if not exists outbound_clicks (
  id          bigserial primary key,
  retailer    text not null,
  term        text,
  clicked_at  timestamptz not null default now()
);
create index if not exists outbound_clicks_time_idx on outbound_clicks (clicked_at desc);

-- ------------------------------------------------------------------ RLS

alter table households      enable row level security;
alter table profiles        enable row level security;
alter table staples         enable row level security;
alter table plans           enable row level security;
alter table cook_history    enable row level security;
alter table recipe_photos   enable row level security;
alter table outbound_clicks enable row level security;

-- The caller's household, as a stable function so every policy agrees.
-- SECURITY DEFINER so it can read profiles without recursing through
-- profiles' own policy, which would deadlock the policy evaluation.
create or replace function auth_household()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select household_id from profiles where id = auth.uid()
$$;

drop policy if exists households_rw on households;
create policy households_rw on households for all
  using (id = auth_household()) with check (id = auth_household());

drop policy if exists profiles_self on profiles;
create policy profiles_self on profiles for all
  using (id = auth.uid()) with check (id = auth.uid());

-- Everyone in the household can see the other members, so the account page
-- can show who shares the list.
drop policy if exists profiles_household_read on profiles;
create policy profiles_household_read on profiles for select
  using (household_id = auth_household());

drop policy if exists staples_rw on staples;
create policy staples_rw on staples for all
  using (household_id = auth_household()) with check (household_id = auth_household());

drop policy if exists plans_rw on plans;
create policy plans_rw on plans for all
  using (household_id = auth_household()) with check (household_id = auth_household());

drop policy if exists cook_history_rw on cook_history;
create policy cook_history_rw on cook_history for all
  using (household_id = auth_household()) with check (household_id = auth_household());

drop policy if exists recipe_photos_own on recipe_photos;
create policy recipe_photos_own on recipe_photos for all
  using (household_id = auth_household()) with check (household_id = auth_household());

-- Public photos are readable by anyone, including signed-out visitors.
drop policy if exists recipe_photos_public_read on recipe_photos;
create policy recipe_photos_public_read on recipe_photos for select
  using (is_public);

-- Anyone may record a click; nobody may read them back from the client.
-- Reading is for us, through the service role.
drop policy if exists outbound_clicks_insert on outbound_clicks;
create policy outbound_clicks_insert on outbound_clicks for insert
  to anon, authenticated with check (true);

-- ------------------------------------------------- new user bootstrapping

-- Give every new user a household and a profile. Doing this in a trigger
-- rather than the client means a row can never be missing, and the client
-- never needs permission to create households.
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  hh uuid;
begin
  insert into households (name) values (null) returning id into hh;
  insert into profiles (id, household_id, email, display_name)
  values (
    new.id,
    hh,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name')
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- keep updated_at honest without the client having to remember
create or replace function touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

drop trigger if exists staples_touch on staples;
create trigger staples_touch before update on staples
  for each row execute function touch_updated_at();

drop trigger if exists plans_touch on plans;
create trigger plans_touch before update on plans
  for each row execute function touch_updated_at();
