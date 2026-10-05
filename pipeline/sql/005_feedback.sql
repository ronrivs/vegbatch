-- Suggestions and bug reports from the public.
--
-- Two properties matter more than the form itself.
--
-- 1. **Insert-only for the public.** Anyone may write; nobody may read. A
--    feedback table with a SELECT policy would publish every submitter's
--    name, email and message to anyone holding the anon key, which is
--    shipped in the page. Reading is service-role only.
-- 2. **The row is the record; the email is a notification.** The email is
--    sent by a trigger and is allowed to fail. Losing someone's bug report
--    because a mail provider had a bad minute would be the actual failure.
--
-- Validation lives here, not only in the form, because the form is not what
-- guards the endpoint — anyone can POST to PostgREST directly.

create table if not exists feedback (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  name        text not null check (length(btrim(name)) between 1 and 80),
  email       text not null check (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
                                   and length(email) <= 160),
  kind        text not null check (kind in ('bug', 'suggestion', 'recipe', 'other')),
  message     text not null check (length(btrim(message)) between 1 and 4000),
  page        text check (length(page) <= 300),
  -- who was signed in, when anyone was. Never required: the whole point is
  -- that a stranger who hit a bug can say so.
  user_id     uuid references auth.users on delete set null
);

create index if not exists feedback_created_idx on feedback (created_at desc);

alter table feedback enable row level security;

drop policy if exists feedback_insert_anyone on feedback;
create policy feedback_insert_anyone on feedback for insert
  with check (
    -- a signed-in submitter may only attribute the row to themselves;
    -- anonymous submissions must leave it null rather than guessing at an id
    user_id is null or user_id = auth.uid()
  );

-- Deliberately NO select/update/delete policy. RLS denies by default, so the
-- anon and authenticated roles can write and nothing else. Service role
-- bypasses RLS and is how these actually get read.
revoke select, update, delete on feedback from anon, authenticated;
grant insert on feedback to anon, authenticated;
