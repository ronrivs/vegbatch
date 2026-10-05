-- Email Ron when feedback arrives.
--
-- The row is the record; this is only a notification. The whole trigger is
-- wrapped in an exception handler so that a mail failure can never roll back
-- the insert — losing somebody's bug report because Resend had a bad minute
-- would be the actual failure, and it would be invisible to them (they'd see
-- an error and assume the form is broken).
--
-- pg_net is asynchronous: it queues the request and returns immediately, so
-- the submitter never waits on an HTTP round trip to a third party.
--
-- The API key is NOT in this file. It lives in Supabase Vault under
-- 'resend_api_key', set separately so it is never committed or echoed.

create extension if not exists pg_net with schema extensions;

-- pg_net registers against the `extensions` schema but creates its own `net`
-- schema for the functions, so the callable name is net.http_post — calling
-- it as extensions.net.http_post raised, the handler below swallowed it, and
-- submissions saved silently with no email. Hence the column: a notification
-- that fails quietly is one nobody finds out about until someone complains
-- their bug report was ignored.
alter table public.feedback add column if not exists notify_error text;

create or replace function public.notify_feedback()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  key text;
begin
  begin
    select decrypted_secret into key
      from vault.decrypted_secrets where name = 'resend_api_key';

    if key is null or key = '' then
      new.notify_error := 'no resend_api_key in vault';
      return new;
    end if;

    perform net.http_post(
      url     := 'https://api.resend.com/emails',
      headers := jsonb_build_object(
                   'Authorization', 'Bearer ' || key,
                   'Content-Type',  'application/json'),
      body    := jsonb_build_object(
        'from',     'VegBatch <ron@trib.xyz>',
        'to',       jsonb_build_array('ron@trib.xyz'),
        -- so replying in the mail client goes straight back to the person
        'reply_to', new.email,
        'subject',  format('[VegBatch] %s from %s', new.kind, new.name),
        'text',     format(
           E'%s\n\n— %s <%s>\nType: %s\nPage: %s\nWhen: %s\n\nReply to this email to answer them directly.',
           new.message, new.name, new.email, new.kind,
           coalesce(new.page, '(not recorded)'), new.created_at)
      ),
      timeout_milliseconds := 5000
    );
    new.notify_error := null;
  exception when others then
    -- never let the notification take the submission down with it, but do
    -- leave a trace on the row so a silent outage is findable
    new.notify_error := left(sqlerrm, 300);
  end;
  return new;
end;
$$;

-- BEFORE, so the function can record its own outcome on the row it is
-- notifying about. Queuing the request is what is recorded here; whether
-- Resend accepted it lands in net._http_response.
drop trigger if exists feedback_notify on public.feedback;
create trigger feedback_notify
  before insert on public.feedback
  for each row execute function public.notify_feedback();
