-- Collect richer signups from the "Join our journey" form: name, why they're
-- reaching out, and an optional message. Also move to an append-only model so a
-- returning person's new submission is kept rather than overwriting the last.

alter table public.contact_submissions
  add column if not exists name varchar(120),
  add column if not exists intent text,
  add column if not exists message varchar(1000);

-- Each submission is now its own row; drop the one-row-per-email constraint.
alter table public.contact_submissions
  drop constraint if exists contact_submissions_email_key;

create index if not exists contact_submissions_email_idx
  on public.contact_submissions (email);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'contact_submissions_intent_check'
  ) then
    alter table public.contact_submissions
      add constraint contact_submissions_intent_check
      check (intent is null or intent in ('customer', 'collaborator', 'investor', 'future-teammate'));
  end if;
end $$;
