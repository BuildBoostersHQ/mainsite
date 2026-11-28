-- Google reviewers that have been matched to one of a client's customers. Run once in the Supabase SQL editor.
-- /api/review-match saves a row here when a match is confirmed, and /api/review-queue leaves anyone listed
-- here out of the review asks, so nobody who already left a review is asked again.
create table if not exists public.review_matches (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.client_onboarding(id) on delete cascade,
  reviewer_name text not null,      -- the name as it shows on the Google review, for example 'Maya P.'
  contact_key text not null,        -- the customer in the client's saved list: their ten-digit phone, or their email when there is no phone
  contact_name text,
  contact_phone text,               -- ten digits, no punctuation. This is what the review queue checks
  contact_email text,
  confirmed_at timestamptz not null default now(),
  unique (client_id, reviewer_name)
);
create index if not exists review_matches_phone on public.review_matches (client_id, contact_phone);

-- Locked down: no public access at all. Only the server function (service role key) can read or write.
alter table public.review_matches enable row level security;
