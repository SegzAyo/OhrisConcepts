create table if not exists public.contact_submissions (
  id bigint generated always as identity primary key,
  email varchar(254) not null unique,
  source text not null default 'ohris-concepts',
  submission_count integer not null default 1 check (submission_count > 0),
  created_at timestamptz not null default now(),
  last_submitted_at timestamptz not null default now()
);

alter table public.contact_submissions enable row level security;
revoke all on table public.contact_submissions from anon, authenticated;
