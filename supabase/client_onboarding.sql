-- One row per client's onboarding page. Run once in the Supabase SQL editor.
-- The page at buildboosters.com/start/<code> reads and writes this through /api/onboarding only.
create table if not exists public.client_onboarding (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Za-z0-9_-]{12,64}$'),  -- the private part of the client's link
  owner_first_name text,
  tier text,                      -- 'essentials', 'all_in_one' or 'dominance'. 'website' is the old website-only plan, the one plan with no texting registration
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
  ghl_location_id text,            -- the client's HighLevel sub-account id, so A2P emails match the right client
  a2p_status text,                 -- latest news from HighLevel's emails: campaign_approved, brand_rejected and so on
  a2p_status_at timestamptz,
  a2p_reason text,                 -- why it was rejected, when it was
  ein_deleted_at timestamptz,
  stripe_session_id text,          -- the Stripe checkout session that created this row
  stripe_customer_id text,         -- the Stripe customer id, for linking to billing
  site_repo text,                  -- e.g. BuildBoostersHQ/smith-plumbing-miami
  site_project_id text,            -- the Vercel project id
  site_created_at timestamptz,     -- when the site automator created the repo and project
  site_domain text,                -- the registered domain, e.g. smithplumbingmiami.com
  domain_registered_at timestamptz,
  nudges_sent jsonb not null default '{}'::jsonb,  -- tracks which follow-up texts have been sent: { day1: "...", day4: "..." }
  ghl_phone_number text,            -- the local GHL number bought for this client, e.g. +13055551234. Used as the business phone on the website
  ghl_review_widget_id text,       -- the GHL review widget ID, embedded on the client's site for live Google reviews
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
  add column if not exists ghl_location_id text,
  add column if not exists a2p_status text,
  add column if not exists a2p_status_at timestamptz,
  add column if not exists a2p_reason text,
  add column if not exists ein_deleted_at timestamptz,
  add column if not exists launch_call_start timestamptz,
  add column if not exists google_approved_at timestamptz,
  add column if not exists sms_consent_at timestamptz,
  add column if not exists sms_consent_text text,
  add column if not exists sms_consent_cell text,
  add column if not exists site_repo text,
  add column if not exists site_project_id text,
  add column if not exists site_created_at timestamptz,
  add column if not exists processed_photos jsonb,
  add column if not exists stripe_session_id text,
  add column if not exists stripe_customer_id text,
  add column if not exists site_domain text,
  add column if not exists domain_registered_at timestamptz,
  add column if not exists nudges_sent jsonb not null default '{}'::jsonb,
  add column if not exists ghl_phone_number text,
  add column if not exists ghl_review_widget_id text,
  add column if not exists credit_30_earned_at timestamptz,   -- the old $30 credit, kept for clients who earned it before the $50 and $20 credit replaced it
  add column if not exists site_final_basics_at timestamptz,  -- no form after 72 hours, so the site was built from their Google profile
  add column if not exists site_rebuilt_at timestamptz,       -- the form came in after a basics build and the site was built again
  add column if not exists launch_checklist jsonb,            -- what the launch call still has to cover
  add column if not exists dob_private text,                  -- the owner's date of birth, for texting registration only. Never sent back to the page
  add column if not exists welcome_done_at timestamptz,       -- they finished the page they land on after paying
  add column if not exists setup_done_at timestamptz,         -- the day setup was finished: form, Google step and EIN all in
  add column if not exists setup_credit_amount integer,       -- 50 for finishing on the day they paid, 20 for the next day, 0 for later
  add column if not exists setup_credit_earned_at timestamptz,
  add column if not exists setup_credit_applied_at timestamptz, -- when the credit went onto their Stripe balance
  add column if not exists setup_credit_stripe_id text;       -- the Stripe balance transaction, so it can be found again

-- The EIN and the date of birth are deleted the moment a2p_registered_at is filled in, so they never outlive the registration.
create or replace function public.client_onboarding_wipe_ein() returns trigger language plpgsql as $$
begin
  if new.a2p_registered_at is not null and (new.ein_private is not null or new.dob_private is not null) then
    new.ein_private := null;
    new.dob_private := null;
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

-- Every A2P registration email HighLevel sends, as read by /api/a2p-inbox. Kept so nothing is lost when an
-- email cannot be matched to a client or its wording is new. Locked down like the table above.
create table if not exists public.a2p_events (
  id uuid primary key default gen_random_uuid(),
  gmail_id text not null unique,
  sent_at timestamptz,
  received_at timestamptz not null default now(),
  from_address text,
  subject text,
  body text,
  client_id uuid references public.client_onboarding(id) on delete set null,
  registration_type text,          -- brand, campaign or unknown
  status text,                     -- approved, rejected, pending or unknown
  reason text,
  needs_look boolean not null default false,
  acted boolean not null default false
);
alter table public.a2p_events enable row level security;

-- Change requests from the client portal. Each request is one thing the client wants changed.
-- Photos attached to a request sit in the client-photos bucket under change-requests/{request_id}/.
create table if not exists public.change_requests (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.client_onboarding(id) on delete cascade,
  category text not null default 'other',  -- text, photos, hours, phone, address, services, areas, promo, google, domain, other
  body text not null,
  location text,                           -- where on the site (optional)
  photo_count integer not null default 0,
  status text not null default 'sent',     -- sent, working, done, closed
  status_note text,                        -- internal note on what was done or why it was closed
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.change_requests enable row level security;

-- Job events from Jobber, Housecall Pro or manual entry. Each row is one job completed, quote created
-- or invoice paid. The review and photo ask systems read this table to know who to text and when.
create table if not exists public.job_events (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references public.client_onboarding(id) on delete set null,
  source text not null,                    -- jobber, hcp, manual
  event_type text not null,                -- job_completed, quote_created, invoice_paid
  customer_name text,
  customer_phone text,
  job_title text,
  amount_cents integer,
  review_ask_at timestamptz,               -- completed_at + 3 hours
  photo_ask_at timestamptz,                -- completed_at + 6 hours
  review_sent_at timestamptz,              -- set when the review text goes out
  photo_sent_at timestamptz,               -- set when the photo ask goes out
  created_at timestamptz not null default now()
);
alter table public.job_events enable row level security;

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
