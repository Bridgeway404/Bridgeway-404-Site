-- ============================================================
-- Bridgeway 404 — Field Quoting App
-- 0007_quoting.sql — customers, quotes, quote_factors, invoices,
--                    pricing_configuration, row-level security
--
-- Used by the Bridgeway 404 Quotes app (repo: Blue-Collar-Quotes),
-- which signs in with the same admin accounts as /admin. Purely
-- additive: nothing in 0001–0006 is altered. Safe to re-run.
-- ============================================================

-- ---------- Customers ----------
-- One row per customer, matched on normalized name + phone digits so a
-- repeat customer quoted from two phones lands on the same row.
create table if not exists public.customers (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  name_key   text generated always as (regexp_replace(lower(name), '[^a-z0-9]', '', 'g')) stored,
  phone      text,
  phone_key  text generated always as (regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g')) stored,
  email      text,
  address    text,
  notes      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists customers_name_phone_uidx on public.customers (name_key, phone_key);

-- ---------- Pricing configuration ----------
-- The app ships defaults in assets/pricing-config.js. The row named
-- 'default' overrides them for every phone that is signed in. Edit it from
-- the app's Pricing Settings screen (or here); no code change needed.
create table if not exists public.pricing_configuration (
  id         uuid primary key default gen_random_uuid(),
  name       text unique not null default 'default',
  version    int not null default 1,
  config     jsonb not null,
  is_active  boolean not null default true,
  updated_by uuid references public.admin_users (user_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.pricing_configuration (name, version, config) values ('default', 1, '{
  "version": 1,
  "minimum_job_price": 215,
  "round_to": 5,
  "load_size": { "minimum": 215, "quarter": 295, "half": 395, "three_quarter": 495, "full": 595, "multi_per_load": 595, "multi_default_loads": 2 },
  "stairs": { "ground": 0, "one": 30, "two": 60, "three_plus": 100 },
  "elevator_stair_multiplier": 0,
  "heavy_items": { "none": 0, "one": 25, "two": 50, "three_four": 90, "five_plus": 150 },
  "readiness": { "curbside": -25, "inside": 0, "gathering": 60 },
  "access": { "easy": 0, "normal": 0, "long_carry": 40, "difficult": 90 },
  "handling": { "none": 0, "minor": 35, "significant": 85, "special": 125 },
  "disposal_surcharge": 0,
  "tax_rate": 0,
  "estimate_valid_days": 14
}'::jsonb)
on conflict (name) do nothing;

-- ---------- Quotes ----------
-- The phone generates the id and the human-readable number, prices the job
-- locally, and syncs the finished record here. `criteria` is the six
-- answers exactly as selected; `pricing` is the engine's full breakdown and
-- `pricing_config` the configuration in force, so every saved quote
-- preserves how its price was reached even after prices change.
create table if not exists public.quotes (
  id                 uuid primary key,
  number             text not null,
  invoice_number     text,
  doc_type           text not null default 'estimate' check (doc_type in ('estimate', 'invoice')),
  status             text not null default 'draft'
                       check (status in ('draft', 'sent', 'accepted', 'scheduled', 'completed', 'declined')),
  customer_id        uuid references public.customers (id) on delete set null,
  customer_name      text,
  customer_phone     text,
  customer_email     text,
  service_address    text,
  service_date       date,
  notes              text,
  criteria           jsonb not null default '{}'::jsonb,
  pricing            jsonb not null default '{}'::jsonb,
  pricing_config     jsonb,
  recommended_price  numeric(10,2) not null default 0,
  final_price        numeric(10,2) not null default 0,
  adjustment_amount  numeric(10,2) not null default 0,
  adjustment_reason  text,
  needs_review       boolean not null default false,
  issued_at          timestamptz,
  sent_at            timestamptz,
  created_by         uuid references public.admin_users (user_id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists quotes_updated_idx  on public.quotes (updated_at desc);
create index if not exists quotes_status_idx   on public.quotes (status, updated_at desc);
create index if not exists quotes_customer_idx on public.quotes (customer_id);

-- One row per pricing factor (base price, each surcharge/discount, minimum
-- top-up, rounding). Rebuilt by the app whenever a quote is re-priced.
create table if not exists public.quote_factors (
  id         uuid primary key default gen_random_uuid(),
  quote_id   uuid not null references public.quotes (id) on delete cascade,
  position   int not null default 0,
  criterion  text not null,
  option     text not null,
  label      text not null,
  amount     numeric(10,2) not null default 0,
  group_key  text
);
create index if not exists quote_factors_quote_idx on public.quote_factors (quote_id, position);

-- Invoices: one per quote once it is converted. Payment collection is a
-- later addition (paid_at / payment fields go here).
create table if not exists public.invoices (
  id         uuid primary key default gen_random_uuid(),
  quote_id   uuid not null unique references public.quotes (id) on delete cascade,
  number     text not null,
  total      numeric(10,2) not null default 0,
  status     text not null default 'sent',
  issued_at  timestamptz not null default now(),
  paid_at    timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists invoices_number_uidx on public.invoices (number);

-- ---------- Functions ----------

-- Find-or-create a customer by normalized name + phone. Newer contact
-- details fill in blanks but never erase existing ones. Returns the id.
create or replace function public.bwq_upsert_customer(
  p_name text,
  p_phone text default null,
  p_email text default null,
  p_address text default null
)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  cid uuid;
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;
  if coalesce(btrim(p_name), '') = '' then
    return null;
  end if;
  insert into public.customers (name, phone, email, address)
  values (btrim(p_name), nullif(btrim(p_phone), ''), nullif(btrim(p_email), ''), nullif(btrim(p_address), ''))
  on conflict (name_key, phone_key) do update
     set email      = coalesce(nullif(btrim(excluded.email), ''), public.customers.email),
         address    = coalesce(nullif(btrim(excluded.address), ''), public.customers.address),
         updated_at = now()
  returning id into cid;
  return cid;
end;
$$;

revoke all on function public.bwq_upsert_customer(text, text, text, text) from public, anon;
grant execute on function public.bwq_upsert_customer(text, text, text, text) to authenticated;

-- ---------- Row-level security ----------
-- Same rule as the rest of the admin panel: any allowlisted admin can read
-- and write everything; nobody else can see anything.

alter table public.customers             enable row level security;
alter table public.pricing_configuration enable row level security;
alter table public.quotes                enable row level security;
alter table public.quote_factors         enable row level security;
alter table public.invoices              enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['customers', 'pricing_configuration', 'quotes', 'quote_factors', 'invoices'] loop
    execute format('drop policy if exists %I_select on public.%I', t, t);
    execute format('drop policy if exists %I_insert on public.%I', t, t);
    execute format('drop policy if exists %I_update on public.%I', t, t);
    execute format('drop policy if exists %I_delete on public.%I', t, t);
    execute format('create policy %I_select on public.%I for select to authenticated using (public.is_admin())', t, t);
    execute format('create policy %I_insert on public.%I for insert to authenticated with check (public.is_admin())', t, t);
    execute format('create policy %I_update on public.%I for update to authenticated using (public.is_admin()) with check (public.is_admin())', t, t);
    execute format('create policy %I_delete on public.%I for delete to authenticated using (public.is_admin())', t, t);
  end loop;
end
$$;
