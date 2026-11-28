-- One row per key a client is asked to hand over (Housecall Pro, Jobber and so on). Run once in the Supabase SQL editor.
-- The page at buildboosters.com/key/<token> reads and writes this through /api/client-secret only.
-- The key itself is encrypted by the server function before it gets here (AES-256-GCM with BB_SECRETS_KEY from
-- Vercel), so nobody can read it from this table without that env var.
create table if not exists public.client_secret_requests (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.client_onboarding(id) on delete cascade,
  label text not null,              -- whose key it is, in plain words: 'Housecall Pro', 'Jobber'. The page says "your Housecall Pro key"
  note text,                        -- optional line from Maddie shown on the page, for example where to find the key
  token text not null unique check (token ~ '^[A-Za-z0-9_-]{32,64}$'),  -- the private part of the link
  expires_at timestamptz not null default (now() + interval '7 days'),
  used_at timestamptz,              -- set once, when the client sends the key. The link is closed after that
  value_iv text,                    -- the three parts of the encrypted key, each base64. Never plain text
  value_tag text,
  value_ciphertext text,
  created_at timestamptz not null default now()
);
create index if not exists client_secret_requests_client on public.client_secret_requests (client_id, label);

-- Locked down: no public access at all. Only the server function (service role key) can read or write.
alter table public.client_secret_requests enable row level security;
