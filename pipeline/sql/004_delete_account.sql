-- "Delete my data" has to actually delete the account.
--
-- Until now it cleared every household table and the storage bucket, but the
-- `auth.users` row survived — the anon key cannot touch the auth schema, and
-- there was no server to do it. So someone who asked to be deleted stayed a
-- user. That is the part with an obligation behind it.
--
-- Done as a SECURITY DEFINER function rather than an Edge Function or a Pages
-- Function: no new deploy target, no service-role key to store anywhere, and
-- nothing new that can be misconfigured. The whole surface is one RPC.
--
-- Three properties make it safe, and all three matter:
--
--   1. It takes NO ARGUMENTS. It always acts on auth.uid(). A version that
--      accepted a user id would let any signed-in person delete anyone —
--      SECURITY DEFINER means it runs with the owner's rights, so the
--      function itself is the only thing standing between a caller and the
--      whole auth table.
--   2. `search_path = ''` with every name schema-qualified. Without this a
--      caller can create their own `profiles` table earlier in the path and
--      redirect the function's writes; it is the classic SECURITY DEFINER
--      escalation.
--   3. Execute is revoked from anon and public. Only a signed-in session can
--      reach it, and then only to delete itself.

create or replace function public.delete_own_account()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  hh  uuid;
  remaining int;
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  select p.household_id into hh from public.profiles p where p.id = uid;

  delete from public.profiles where id = uid;

  -- Last one out turns off the lights. A household is not owned by a user, so
  -- deleting the person leaves the household row behind with its staples,
  -- plans, cook history and saved lists — all of it now unreachable through
  -- RLS and therefore invisible AND undeletable. Drop it once nobody is left;
  -- the cascades take the rest with it.
  if hh is not null then
    select count(*) into remaining from public.profiles where household_id = hh;
    if remaining = 0 then
      delete from public.households where id = hh;
    end if;
  end if;

  -- Cascades profiles and recipe_photos rows. The stored FILES are removed by
  -- the client before this runs, because they live in object storage and no
  -- SQL statement can reach them.
  delete from auth.users where id = uid;
end;
$$;

revoke all on function public.delete_own_account() from public;
revoke all on function public.delete_own_account() from anon;
grant execute on function public.delete_own_account() to authenticated;
