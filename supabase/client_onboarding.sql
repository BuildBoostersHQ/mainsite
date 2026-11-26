-- One row per client's onboarding page. Run once in the Supabase SQL editor.
-- The page at buildboosters.com/start/<code> reads and writes this through /api/onboarding only.
create table if not exists public.client_onboarding (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Za-z0-9_-]{12,64}$'),  -- the private part of the client's link
  owner_first_name text,
  launch_call_at text,            -- shown as written, for example 'Thursday at 2:00 PM'
  video_url text,                 -- https link to the personal walkthrough video (optional)
  photo_folder_url text,          -- https link to the client's Drive photo folder (optional)
  prefill jsonb not null default '{}'::jsonb,   -- what we pulled from Google: business_name, business_phone, address, weekday_hours...
  options jsonb not null default '{}'::jsonb,   -- {"services": [...], "areas": [...]} the chips to offer for this trade and city
  answers jsonb not null default '{}'::jsonb,   -- what the client confirmed or changed
  google_requested_at timestamptz,
  text_link_requested_at timestamptz,
  submitted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Locked down: no public access at all. Only the server function (service role key) can read or write.
alter table public.client_onboarding enable row level security;

-- Example row. gen_random_uuid() gives a link code nobody can guess.
-- insert into public.client_onboarding (code, owner_first_name, launch_call_at, prefill, options)
-- values (
--   replace(gen_random_uuid()::text, '-', ''),
--   'Dave', 'Thursday at 2:00 PM',
--   '{"business_name":"Smith Plumbing","business_phone":"(305) 555-0199","address":"1420 SW 8th St, Miami, FL 33135","weekday_hours":"8:00 AM to 6:00 PM","services":["Drain cleaning"],"areas":["Miami"]}',
--   '{"services":["Drain cleaning","Water heaters","Leak repair","Repiping"],"areas":["Miami","Coral Gables","Hialeah","Kendall"]}'
-- ) returning code;
