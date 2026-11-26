-- One row per client's onboarding page. Run once in the Supabase SQL editor.
-- The page at buildboosters.com/start/<code> reads and writes this through /api/onboarding only.
create table if not exists public.client_onboarding (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Za-z0-9_-]{12,64}$'),  -- the private part of the client's link
  owner_first_name text,
  tier text,                      -- 'website', 'all_in_one' or 'ads'. Website clients are not asked for texting registration details
  billing_cycle text,             -- 'monthly', 'quarterly', 'six_month' or 'annual'. Everyone but monthly sees the Google updates note
  launch_call_at text,            -- shown as written, for example 'Thursday at 2:00 PM'
  launch_call_start timestamptz,  -- the real date and time, used for the add-to-calendar buttons
  video_url text,                 -- https link to the personal walkthrough video (optional)
  photo_folder_url text,          -- https link to the client's Drive photo folder (optional)
  prefill jsonb not null default '{}'::jsonb,   -- what we pulled from Google: business_name, business_phone, address, weekday_hours...
  options jsonb not null default '{}'::jsonb,   -- {"services": [...], "areas": [...], "domains": [...]} what to offer this client
  answers jsonb not null default '{}'::jsonb,   -- what the client confirmed or changed
  google_requested_at timestamptz,
  google_approved_at timestamptz,  -- set this yourself once their Google access comes through
  sms_consent_at timestamptz,      -- when they agreed to service texts
  sms_consent_text text,           -- the exact words they agreed to
  sms_consent_cell text,           -- the cell number they agreed for
  text_link_requested_at timestamptz,
  submitted_at timestamptz,
  photo_count integer not null default 0,  -- how many photos they have sent from the page
  photos_last_at timestamptz,
  ein_private text,                -- the client's EIN, for texting registration only. Never sent back to the page
  ein_provided_at timestamptz,
  a2p_registered_at timestamptz,   -- set this once their texting registration is approved. Doing so deletes the EIN and switches their site to full
  site_deploy_hook text,           -- the Deploy Hook URL from the client's Vercel project, so approval can rebuild their site
  site_rebuild_requested_at timestamptz,
  ein_deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Safe to run again: adds anything missing if the table was created from an earlier version of this file.
alter table public.client_onboarding
  add column if not exists photo_count integer not null default 0,
  add column if not exists photos_last_at timestamptz,
  add column if not exists tier text,
  add column if not exists billing_cycle text,
  add column if not exists ein_private text,
  add column if not exists ein_provided_at timestamptz,
  add column if not exists a2p_registered_at timestamptz,
  add column if not exists site_deploy_hook text,
  add column if not exists site_rebuild_requested_at timestamptz,
  add column if not exists ein_deleted_at timestamptz,
  add column if not exists launch_call_start timestamptz,
  add column if not exists google_approved_at timestamptz,
  add column if not exists sms_consent_at timestamptz,
  add column if not exists sms_consent_text text,
  add column if not exists sms_consent_cell text;

-- The EIN is deleted the moment a2p_registered_at is filled in, so it never outlives the registration.
create or replace function public.client_onboarding_wipe_ein() returns trigger language plpgsql as $$
begin
  if new.a2p_registered_at is not null and new.ein_private is not null then
    new.ein_private := null;
    new.ein_deleted_at := now();
  end if;
  return new;
end $$;
drop trigger if exists client_onboarding_wipe_ein on public.client_onboarding;
create trigger client_onboarding_wipe_ein before insert or update on public.client_onboarding
  for each row execute function public.client_onboarding_wipe_ein();

-- When a2p_registered_at is filled in, rebuild the client's website. Their site is thin until approval and
-- full after ("mode": "auto" in the site template), and the rebuild is what makes the switch. It only ever
-- calls a Vercel deploy hook, and a failed call never blocks the approval from saving.
create extension if not exists pg_net;
create or replace function public.client_onboarding_rebuild_site() returns trigger language plpgsql security definer as $$
begin
  if new.a2p_registered_at is not null and old.a2p_registered_at is null
     and new.site_deploy_hook like 'https://api.vercel.com/v1/integrations/deploy/%' then
    begin
      perform net.http_post(url := new.site_deploy_hook, body := '{}'::jsonb);
      update public.client_onboarding set site_rebuild_requested_at = now() where id = new.id;
    exception when others then
      raise warning 'Could not ask Vercel to rebuild the site for %: %', new.code, sqlerrm;
    end;
  end if;
  return null;
end $$;
drop trigger if exists client_onboarding_rebuild_site on public.client_onboarding;
create trigger client_onboarding_rebuild_site after update of a2p_registered_at on public.client_onboarding
  for each row execute function public.client_onboarding_rebuild_site();

-- Safety net: once a week, check for an EIN that has sat for more than 60 days and delete it by hand:
--   update public.client_onboarding set ein_private = null, ein_deleted_at = now()
--   where ein_private is not null and ein_provided_at < now() - interval '60 days';

-- Private storage for the photos clients send from their setup page. Each client's photos sit in a folder
-- named with their row id. Only the server function can read or write it.
insert into storage.buckets (id, name, public) values ('client-photos', 'client-photos', false) on conflict (id) do nothing;

-- Locked down: no public access at all. Only the server function (service role key) can read or write.
alter table public.client_onboarding enable row level security;

-- Example row. gen_random_uuid() gives a link code nobody can guess.
-- insert into public.client_onboarding (code, owner_first_name, launch_call_at, prefill, options)
-- values (
--   replace(gen_random_uuid()::text, '-', ''),
--   'Dave', 'Thursday at 2:00 PM',   -- also set launch_call_start, for example '2026-12-03 14:00-05', to get calendar buttons
--   '{"business_name":"Smith Plumbing","business_phone":"(305) 555-0199","address":"1420 SW 8th St, Miami, FL 33135","weekday_hours":"8:00 AM to 6:00 PM","services":["Drain cleaning"],"areas":["Miami"]}',
--   '{"services":["Drain cleaning","Water heaters","Leak repair","Repiping"],"areas":["Miami","Coral Gables","Hialeah","Kendall"],"domains":["smithplumbingmiami.com","smithplumbingfl.com","callsmithplumbing.com"]}'
-- ) returning code;
