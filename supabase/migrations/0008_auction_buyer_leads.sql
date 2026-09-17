-- ============================================================
-- Auction Buyer Leads (ab_*)
--
-- A second lead channel, independent of Eviction Attorney Leads (eal_*)
-- and of the paused Distressed Property Leads (dpl_*): a short call list
-- of people and companies that recently ACQUIRED property at a tax sale,
-- levy / sheriff's sale, foreclosure or similar public forced sale in
-- metro Atlanta, and are likely to need a cleanout before renovating,
-- renting or reselling.
--
--   ab_properties        background research queue: one row per property
--                        seen on a public sale list, tracked until the
--                        assessor shows a new owner (the purchaser)
--   ab_buyers            the visible call list: one row per purchaser,
--                        however many properties they bought
--   ab_buyer_properties  which properties each buyer acquired
--   ab_activity          dated, attributed notes / status changes / contacts
--   ab_documents         every public document fetched (audit trail)
--   ab_source_state      per-source health / cursor
--   ab_runs / ab_jobs    research runs (weekly on Wednesday, or manual) and
--                        the worker's job queue
--   ab_settings          non-secret configuration
--
-- Scheduling: its own pg_cron entries (ab-weekly-1200utc, ab-weekly-1300utc,
-- ab-tick). It never touches the dpl_* jobs, which stay unscheduled.
-- ab_set_paused(true/false) pauses / resumes ONLY this channel.
-- ============================================================

-- ---------- Settings ----------

create table if not exists public.ab_settings (
  key        text primary key,
  value      text,
  updated_at timestamptz not null default now()
);

insert into public.ab_settings (key, value) values
  ('functions_url', 'https://ctqdnphsvkbgegdtsmwb.supabase.co/functions/v1/auction-buyer-leads'),
  ('anon_key', (select value from public.dpl_settings where key = 'anon_key')),
  ('run_enabled', 'true'),
  ('paused', 'false'),
  ('counties', 'Fulton,DeKalb,Cobb,Henry,Douglas'),
  ('lookback_days', '450'),
  ('recheck_days', '7'),
  ('give_up_days', '240'),
  ('max_assessor_checks_per_run', '400'),
  ('ai_model_enrich', 'claude-sonnet-5'),
  ('max_ai_enrich_per_run', '10')
on conflict (key) do nothing;

-- ---------- Runs & jobs ----------

create table if not exists public.ab_runs (
  id           uuid primary key default gen_random_uuid(),
  trigger      text not null default 'manual' check (trigger in ('manual', 'scheduled', 'tick')),
  status       text not null default 'queued'
               check (status in ('queued', 'running', 'completed', 'completed_with_errors', 'failed')),
  requested_by uuid references public.admin_users (user_id),
  options      jsonb not null default '{}'::jsonb,
  started_at   timestamptz,
  finished_at  timestamptz,
  heartbeat_at timestamptz,
  counts       jsonb not null default '{}'::jsonb,
  log          jsonb not null default '[]'::jsonb,
  errors       jsonb not null default '[]'::jsonb,
  created_at   timestamptz not null default now()
);
create index if not exists ab_runs_created_idx on public.ab_runs (created_at desc);

create table if not exists public.ab_jobs (
  id          uuid primary key default gen_random_uuid(),
  run_id      uuid references public.ab_runs (id) on delete cascade,
  kind        text not null,
  payload     jsonb not null default '{}'::jsonb,
  priority    int not null default 100,
  status      text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  attempts    int not null default 0,
  last_error  text,
  created_at  timestamptz not null default now(),
  started_at  timestamptz,
  finished_at timestamptz
);
create index if not exists ab_jobs_queue_idx on public.ab_jobs (status, priority, created_at);

create table if not exists public.ab_source_state (
  source_id            text primary key,
  county               text,
  label                text,
  enabled              boolean not null default true,
  last_success_at      timestamptz,
  last_attempt_at      timestamptz,
  last_error           text,
  last_error_at        timestamptz,
  consecutive_failures int not null default 0,
  cursor               jsonb not null default '{}'::jsonb,
  notes                text
);

create table if not exists public.ab_documents (
  id           uuid primary key default gen_random_uuid(),
  source_id    text not null,
  county       text,
  url          text not null,
  kind         text not null default 'sale_list',
  label        text,
  sha256       text,
  fetched_at   timestamptz not null default now(),
  status_code  int,
  text         text,
  parsed_count int not null default 0,
  notes        text,
  unique (url)
);

-- ---------- Normalization helpers ----------

create or replace function public.ab_name_key(p text)
returns text
language sql immutable
set search_path = ''
as $$
  -- "ABC Homes, L.L.C." -> "abchomes"; entity suffixes and punctuation dropped
  select regexp_replace(
           regexp_replace(lower(coalesce(p, '')),
             '\m(llc|l\.l\.c|l l c|inc|incorporated|corp|corporation|co|company|ltd|lp|l\.p|llp|lllp|pllc|pc|p\.c|the|et al|etal|trustee|tr|as trustee)\M\.?', ' ', 'g'),
           '[^a-z0-9]', '', 'g');
$$;

create or replace function public.ab_parcel_key(p text)
returns text
language sql immutable
set search_path = ''
as $$
  select regexp_replace(upper(coalesce(p, '')), '[^A-Z0-9]', '', 'g');
$$;

create or replace function public.ab_mailing_key(p text)
returns text
language sql immutable
set search_path = ''
as $$
  select regexp_replace(upper(coalesce(p, '')), '[^A-Z0-9]', '', 'g');
$$;

-- ---------- Buyers (the call list) ----------

create table if not exists public.ab_buyers (
  id                  uuid primary key default gen_random_uuid(),
  buyer_name          text not null,
  name_key            text generated always as (public.ab_name_key(buyer_name)) stored,
  contact_name        text,
  phone               text,
  phone_key           text generated always as (public.eal_phone_key(phone)) stored,
  email               text,
  email_key           text generated always as (lower(btrim(coalesce(email, '')))) stored,
  website             text,
  website_key         text generated always as (public.eal_host_key(website)) stored,
  mailing_address     text,
  mailing_key         text generated always as (public.ab_mailing_key(mailing_address)) stored,
  city                text,
  county              text,
  counties            text[] not null default '{}',
  buyer_type          text not null default 'unknown' check (buyer_type in (
                        'investor_company', 'investor_individual', 'landlord', 'flipper', 'builder',
                        'institutional_lender', 'servicer', 'government', 'nonprofit', 'individual', 'unknown')),
  is_institutional    boolean not null default false,
  recent_acquisitions int not null default 0,
  portfolio_count     int,
  priority            text not null default 'Low' check (priority in ('High', 'Medium', 'Low')),
  qualified           boolean not null default false,
  evidence            text,
  source_urls         text[] not null default '{}',
  research_notes      text,
  contact_status      text not null default 'New' check (contact_status in (
                        'New', 'Call Today', 'Called – No Answer', 'Left Voicemail', 'Spoke With Contact',
                        'Interested', 'Follow Up', 'Referral Partner', 'Not Interested', 'Bad Lead')),
  status_changed_at   timestamptz,
  status_changed_by   uuid references public.admin_users (user_id),
  last_contacted_at   timestamptz,
  follow_up_date      date,
  notes               text,
  assigned_to         text,
  created_by          uuid references public.admin_users (user_id),
  run_id              uuid references public.ab_runs (id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  check (btrim(buyer_name) <> '')
);
create unique index if not exists ab_buyers_name_uidx on public.ab_buyers (name_key) where name_key <> '';
create index if not exists ab_buyers_status_idx on public.ab_buyers (qualified, priority, contact_status, created_at desc);
create index if not exists ab_buyers_follow_idx on public.ab_buyers (follow_up_date);

-- ---------- Properties (background research queue) ----------

create table if not exists public.ab_properties (
  id                     uuid primary key default gen_random_uuid(),
  county                 text not null,
  parcel_id              text,
  parcel_key             text generated always as (public.ab_parcel_key(parcel_id)) stored,
  address                text,
  city                   text,
  zip                    text,
  property_type          text not null default 'unknown' check (property_type in (
                           'single_family', 'townhome', 'condo', 'duplex', 'multifamily', 'commercial',
                           'land', 'mobile_home', 'other', 'unknown')),
  sale_type              text not null default 'tax_sale' check (sale_type in (
                           'tax_sale', 'levy_sale', 'sheriff_sale', 'foreclosure', 'judicial_sale', 'other')),
  sale_date              date,
  list_source_id         text,
  list_url               text,
  list_label             text,
  list_owner_name        text,
  amount_due             numeric,
  research_status        text not null default 'awaiting_sale_result' check (research_status in (
                           'upcoming', 'awaiting_sale_result', 'buyer_research_needed', 'buyer_identified',
                           'contact_research_needed', 'qualified', 'not_useful')),
  status_reason          text,
  assessor_owner_name    text,
  assessor_owner_mailing text,
  assessor_use           text,
  assessor_checked_at    timestamptz,
  assessor_source_url    text,
  owner_changed          boolean,
  -- Purchaser as printed by the county (Douglas' overage file names buyers directly)
  purchaser_name         text,
  purchase_price         numeric,
  -- Proof the sale completed (excess-funds row, purchaser named, or assessor owner change), not just an advertisement
  sold_confirmed         boolean not null default false,
  sold_evidence          text,
  buyer_id               uuid references public.ab_buyers (id) on delete set null,
  evidence               text,
  first_seen_at          timestamptz not null default now(),
  last_seen_at           timestamptz not null default now(),
  first_run_id           uuid references public.ab_runs (id) on delete set null,
  last_run_id            uuid references public.ab_runs (id) on delete set null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
create unique index if not exists ab_properties_parcel_uidx on public.ab_properties (county, parcel_key) where parcel_key <> '';
create index if not exists ab_properties_status_idx on public.ab_properties (research_status, county, sale_date);
create index if not exists ab_properties_buyer_idx on public.ab_properties (buyer_id);

create table if not exists public.ab_buyer_properties (
  buyer_id    uuid not null references public.ab_buyers (id) on delete cascade,
  property_id uuid not null references public.ab_properties (id) on delete cascade,
  acquired_on date,
  evidence    text,
  created_at  timestamptz not null default now(),
  primary key (buyer_id, property_id)
);

create table if not exists public.ab_activity (
  id         uuid primary key default gen_random_uuid(),
  buyer_id   uuid not null references public.ab_buyers (id) on delete cascade,
  kind       text not null check (kind in ('note', 'status_change', 'contact', 'assignment', 'follow_up', 'system')),
  from_status text,
  to_status  text,
  note       text,
  user_id    uuid references public.admin_users (user_id),
  created_at timestamptz not null default now()
);
create index if not exists ab_activity_buyer_idx on public.ab_activity (buyer_id, created_at desc);

do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'ab_buyers_touch') then
    create trigger ab_buyers_touch before update on public.ab_buyers for each row execute function public.touch_updated_at();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'ab_properties_touch') then
    create trigger ab_properties_touch before update on public.ab_properties for each row execute function public.touch_updated_at();
  end if;
end $$;

-- ---------- Row-level security (admin allowlist only) ----------

alter table public.ab_settings         enable row level security;
alter table public.ab_runs             enable row level security;
alter table public.ab_jobs             enable row level security;
alter table public.ab_source_state     enable row level security;
alter table public.ab_documents        enable row level security;
alter table public.ab_buyers           enable row level security;
alter table public.ab_properties       enable row level security;
alter table public.ab_buyer_properties enable row level security;
alter table public.ab_activity         enable row level security;

do $$
declare t text;
begin
  foreach t in array array['ab_settings', 'ab_runs', 'ab_jobs', 'ab_source_state', 'ab_documents', 'ab_buyers', 'ab_properties', 'ab_buyer_properties', 'ab_activity'] loop
    execute format('drop policy if exists %I_select on public.%I', t, t);
    execute format('create policy %I_select on public.%I for select to authenticated using (public.is_admin())', t, t);
  end loop;
end $$;

drop policy if exists ab_settings_update on public.ab_settings;
create policy ab_settings_update on public.ab_settings for update to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists ab_source_state_update on public.ab_source_state;
create policy ab_source_state_update on public.ab_source_state for update to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists ab_buyers_insert on public.ab_buyers;
create policy ab_buyers_insert on public.ab_buyers for insert to authenticated with check (public.is_admin());
drop policy if exists ab_buyers_update on public.ab_buyers;
create policy ab_buyers_update on public.ab_buyers for update to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists ab_properties_update on public.ab_properties;
create policy ab_properties_update on public.ab_properties for update to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists ab_activity_insert on public.ab_activity;
create policy ab_activity_insert on public.ab_activity for insert to authenticated with check (public.is_admin() and user_id = auth.uid());

-- ---------- Buyer dedupe + upsert ----------

-- Rules, in order:
--   1. same normalized buyer name (suffixes like LLC / Inc and punctuation ignored)
--   2. same email, unless it is a shared mailbox (info@, office@ …) and the names differ
--   3. same website (a company's own site is a strong identifier)
--   4. same phone AND same mailing address (a shared office line alone is not
--      enough — unrelated LLCs share registered agents and PO boxes)
create or replace function public.ab_find_buyer_duplicate(p_name text, p_email text, p_phone text, p_website text, p_mailing text,
                                                          out o_id uuid, out o_matched_on text)
language plpgsql stable
set search_path = ''
as $$
declare
  k_name text := public.ab_name_key(p_name);
  k_email text := lower(btrim(coalesce(p_email, '')));
  k_phone text := public.eal_phone_key(p_phone);
  k_host text := public.eal_host_key(p_website);
  k_mail text := public.ab_mailing_key(p_mailing);
  generic boolean := k_email ~ '^(info|office|contact|admin|hello|mail|frontdesk|reception|billing|support|sales|acquisitions)@';
begin
  o_id := null; o_matched_on := null;
  if k_name <> '' then
    select id into o_id from public.ab_buyers where name_key = k_name limit 1;
    if o_id is not null then o_matched_on := 'buyer name'; return; end if;
  end if;
  if k_email <> '' then
    select id into o_id from public.ab_buyers b where b.email_key = k_email and (not generic or b.name_key = k_name) limit 1;
    if o_id is not null then o_matched_on := 'email'; return; end if;
  end if;
  if k_host <> '' then
    select id into o_id from public.ab_buyers b where b.website_key = k_host limit 1;
    if o_id is not null then o_matched_on := 'website'; return; end if;
  end if;
  if k_phone <> '' and k_mail <> '' then
    select id into o_id from public.ab_buyers b where b.phone_key = k_phone and b.mailing_key = k_mail limit 1;
    if o_id is not null then o_matched_on := 'phone and mailing address'; return; end if;
  end if;
end;
$$;
revoke all on function public.ab_find_buyer_duplicate(text, text, text, text, text) from public, anon;
grant execute on function public.ab_find_buyer_duplicate(text, text, text, text, text) to authenticated, service_role;

-- Insert a buyer or merge into its duplicate. Never erases data, never
-- touches the workflow fields. Returns { action, id, matched_on }.
create or replace function public.ab_upsert_buyer(p jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_name text := nullif(btrim(coalesce(p->>'buyer_name', '')), '');
  v_dup uuid; v_on text; v_id uuid;
  v_counties text[]; v_sources text[];
  v_type text := nullif(p->>'buyer_type', '');
  v_prio text := nullif(p->>'priority', '');
  v_uid uuid := auth.uid();
  ex public.ab_buyers;
begin
  if current_user not in ('postgres', 'supabase_admin', 'service_role') and not public.is_admin() then
    raise exception 'not authorized';
  end if;
  if v_name is null or public.ab_name_key(v_name) = '' then
    raise exception 'buyer name is required';
  end if;
  if v_type not in ('investor_company', 'investor_individual', 'landlord', 'flipper', 'builder', 'institutional_lender', 'servicer', 'government', 'nonprofit', 'individual', 'unknown') then v_type := null; end if;
  if v_prio not in ('High', 'Medium', 'Low') then v_prio := null; end if;
  select coalesce(array_agg(x), '{}') into v_counties
    from (select distinct btrim(value #>> '{}') as x from jsonb_array_elements(case when jsonb_typeof(p->'counties') = 'array' then p->'counties' else '[]'::jsonb end)) s where x <> '';
  if nullif(btrim(coalesce(p->>'county', '')), '') is not null and not (btrim(p->>'county') = any (v_counties)) then v_counties := v_counties || btrim(p->>'county'); end if;
  select coalesce(array_agg(x), '{}') into v_sources
    from (select distinct btrim(value #>> '{}') as x from jsonb_array_elements(case when jsonb_typeof(p->'source_urls') = 'array' then p->'source_urls' else '[]'::jsonb end)) s where x <> '';

  select o_id, o_matched_on into v_dup, v_on
    from public.ab_find_buyer_duplicate(v_name, p->>'email', p->>'phone', p->>'website', p->>'mailing_address');

  if v_dup is null then
    insert into public.ab_buyers (buyer_name, contact_name, phone, email, website, mailing_address, city, county, counties, buyer_type,
      is_institutional, portfolio_count, priority, qualified, evidence, source_urls, research_notes, created_by, run_id)
    values (v_name, nullif(btrim(coalesce(p->>'contact_name', '')), ''), nullif(btrim(coalesce(p->>'phone', '')), ''),
      nullif(lower(btrim(coalesce(p->>'email', ''))), ''), nullif(btrim(coalesce(p->>'website', '')), ''),
      nullif(btrim(coalesce(p->>'mailing_address', '')), ''), nullif(btrim(coalesce(p->>'city', '')), ''),
      nullif(btrim(coalesce(p->>'county', '')), ''), v_counties, coalesce(v_type, 'unknown'),
      coalesce((p->>'is_institutional')::boolean, false), nullif(p->>'portfolio_count', '')::int,
      coalesce(v_prio, 'Low'), coalesce((p->>'qualified')::boolean, false),
      nullif(btrim(coalesce(p->>'evidence', '')), ''), v_sources, nullif(btrim(coalesce(p->>'research_notes', '')), ''),
      case when v_uid is not null and public.is_admin() then v_uid else null end, nullif(p->>'run_id', '')::uuid)
    returning id into v_id;
    return jsonb_build_object('action', 'inserted', 'id', v_id, 'matched_on', null);
  end if;

  select * into ex from public.ab_buyers where id = v_dup;
  update public.ab_buyers set
    contact_name = coalesce(ex.contact_name, nullif(btrim(coalesce(p->>'contact_name', '')), '')),
    phone = coalesce(ex.phone, nullif(btrim(coalesce(p->>'phone', '')), '')),
    email = coalesce(ex.email, nullif(lower(btrim(coalesce(p->>'email', ''))), '')),
    website = coalesce(ex.website, nullif(btrim(coalesce(p->>'website', '')), '')),
    mailing_address = coalesce(ex.mailing_address, nullif(btrim(coalesce(p->>'mailing_address', '')), '')),
    city = coalesce(ex.city, nullif(btrim(coalesce(p->>'city', '')), '')),
    county = coalesce(ex.county, nullif(btrim(coalesce(p->>'county', '')), '')),
    counties = (select coalesce(array_agg(distinct c), '{}') from unnest(ex.counties || v_counties) c),
    buyer_type = case when ex.buyer_type = 'unknown' and v_type is not null then v_type else ex.buyer_type end,
    is_institutional = ex.is_institutional or coalesce((p->>'is_institutional')::boolean, false),
    portfolio_count = greatest(coalesce(ex.portfolio_count, 0), coalesce(nullif(p->>'portfolio_count', '')::int, 0)),
    evidence = case
      when ex.evidence is null then nullif(btrim(coalesce(p->>'evidence', '')), '')
      when nullif(btrim(coalesce(p->>'evidence', '')), '') is null then ex.evidence
      when position(lower(btrim(p->>'evidence')) in lower(ex.evidence)) > 0 then ex.evidence
      else ex.evidence || E'\n\n' || btrim(p->>'evidence') end,
    source_urls = (select coalesce(array_agg(distinct u), '{}') from unnest(ex.source_urls || v_sources) u),
    research_notes = coalesce(ex.research_notes, nullif(btrim(coalesce(p->>'research_notes', '')), ''))
  where id = v_dup;
  return jsonb_build_object('action', 'merged', 'id', v_dup, 'matched_on', v_on);
end;
$$;
revoke all on function public.ab_upsert_buyer(jsonb) from public, anon;
grant execute on function public.ab_upsert_buyer(jsonb) to authenticated, service_role;

-- Attach a property to its purchaser and recompute the buyer's counts.
create or replace function public.ab_link_property(p_buyer uuid, p_property uuid, p_acquired date, p_evidence text)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if current_user not in ('postgres', 'supabase_admin', 'service_role') and not public.is_admin() then
    raise exception 'not authorized';
  end if;
  insert into public.ab_buyer_properties (buyer_id, property_id, acquired_on, evidence)
  values (p_buyer, p_property, p_acquired, p_evidence)
  on conflict (buyer_id, property_id) do update set acquired_on = coalesce(excluded.acquired_on, public.ab_buyer_properties.acquired_on),
    evidence = coalesce(excluded.evidence, public.ab_buyer_properties.evidence);
  update public.ab_properties set buyer_id = p_buyer where id = p_property;
  update public.ab_buyers b set
    recent_acquisitions = (select count(*) from public.ab_buyer_properties x where x.buyer_id = b.id),
    counties = (select coalesce(array_agg(distinct pr.county), '{}') from public.ab_buyer_properties x join public.ab_properties pr on pr.id = x.property_id where x.buyer_id = b.id),
    county = coalesce(b.county, (select pr.county from public.ab_buyer_properties x join public.ab_properties pr on pr.id = x.property_id where x.buyer_id = b.id order by x.acquired_on desc nulls last limit 1))
  where b.id = p_buyer;
end;
$$;
revoke all on function public.ab_link_property(uuid, uuid, date, text) from public, anon;
grant execute on function public.ab_link_property(uuid, uuid, date, text) to authenticated, service_role;

-- ---------- Leslie's workflow ----------

create or replace function public.ab_update_lead(p_id uuid, p_patch jsonb)
returns void
language plpgsql
set search_path = ''
as $$
declare
  a public.ab_buyers;
  v_status text; v_follow date; v_assign text;
  v_note text := nullif(btrim(coalesce(p_patch->>'note', '')), '');
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;
  select * into a from public.ab_buyers where id = p_id;
  if a.id is null then
    raise exception 'lead not found';
  end if;
  begin
  update public.ab_buyers set
    buyer_name = case when p_patch ? 'buyer_name' and nullif(btrim(p_patch->>'buyer_name'), '') is not null then btrim(p_patch->>'buyer_name') else buyer_name end,
    contact_name = case when p_patch ? 'contact_name' then nullif(btrim(p_patch->>'contact_name'), '') else contact_name end,
    phone = case when p_patch ? 'phone' then nullif(btrim(p_patch->>'phone'), '') else phone end,
    email = case when p_patch ? 'email' then nullif(lower(btrim(p_patch->>'email')), '') else email end,
    website = case when p_patch ? 'website' then nullif(btrim(p_patch->>'website'), '') else website end,
    mailing_address = case when p_patch ? 'mailing_address' then nullif(btrim(p_patch->>'mailing_address'), '') else mailing_address end,
    city = case when p_patch ? 'city' then nullif(btrim(p_patch->>'city'), '') else city end,
    county = case when p_patch ? 'county' then nullif(btrim(p_patch->>'county'), '') else county end,
    buyer_type = case when p_patch ? 'buyer_type' and nullif(p_patch->>'buyer_type', '') in ('investor_company', 'investor_individual', 'landlord', 'flipper', 'builder', 'institutional_lender', 'servicer', 'government', 'nonprofit', 'individual', 'unknown') then p_patch->>'buyer_type' else buyer_type end,
    priority = case when p_patch ? 'priority' and nullif(p_patch->>'priority', '') in ('High', 'Medium', 'Low') then p_patch->>'priority' else priority end,
    qualified = case when p_patch ? 'qualified' then coalesce((p_patch->>'qualified')::boolean, qualified) else qualified end,
    evidence = case when p_patch ? 'evidence' then nullif(btrim(p_patch->>'evidence'), '') else evidence end,
    notes = case when p_patch ? 'notes' then nullif(btrim(p_patch->>'notes'), '') else notes end
  where id = p_id;
  exception when unique_violation then
    raise exception 'Another lead already has that buyer name.';
  end;

  if p_patch ? 'contact_status' then
    v_status := p_patch->>'contact_status';
    if v_status is distinct from a.contact_status then
      update public.ab_buyers set contact_status = v_status, status_changed_at = now(), status_changed_by = auth.uid() where id = p_id;
      insert into public.ab_activity (buyer_id, kind, from_status, to_status, note, user_id)
      values (p_id, 'status_change', a.contact_status, v_status, v_note, auth.uid());
      v_note := null;
    end if;
  end if;
  if coalesce((p_patch->>'mark_contacted')::boolean, false) then
    update public.ab_buyers set last_contacted_at = now() where id = p_id;
    insert into public.ab_activity (buyer_id, kind, note, user_id) values (p_id, 'contact', v_note, auth.uid());
    v_note := null;
  end if;
  if p_patch ? 'follow_up_date' then
    v_follow := nullif(btrim(coalesce(p_patch->>'follow_up_date', '')), '')::date;
    if v_follow is distinct from a.follow_up_date then
      update public.ab_buyers set follow_up_date = v_follow where id = p_id;
      insert into public.ab_activity (buyer_id, kind, note, user_id)
      values (p_id, 'follow_up', case when v_follow is null then 'Follow-up date cleared' else 'Follow up on ' || to_char(v_follow, 'Mon DD, YYYY') end, auth.uid());
    end if;
  end if;
  if p_patch ? 'assigned_to' then
    v_assign := nullif(btrim(coalesce(p_patch->>'assigned_to', '')), '');
    if v_assign is distinct from a.assigned_to then
      update public.ab_buyers set assigned_to = v_assign where id = p_id;
      insert into public.ab_activity (buyer_id, kind, note, user_id)
      values (p_id, 'assignment', case when v_assign is null then 'Unassigned' else 'Assigned to ' || v_assign end, auth.uid());
    end if;
  end if;
  if v_note is not null then
    insert into public.ab_activity (buyer_id, kind, note, user_id) values (p_id, 'note', v_note, auth.uid());
  end if;
end;
$$;
revoke all on function public.ab_update_lead(uuid, jsonb) from public, anon;
grant execute on function public.ab_update_lead(uuid, jsonb) to authenticated;

create or replace function public.ab_add_note(p_id uuid, p_note text)
returns void
language plpgsql
set search_path = ''
as $$
declare v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if not public.is_admin() then raise exception 'not authorized'; end if;
  if v_note is null then raise exception 'note text is required'; end if;
  if not exists (select 1 from public.ab_buyers where id = p_id) then raise exception 'lead not found'; end if;
  insert into public.ab_activity (buyer_id, kind, note, user_id) values (p_id, 'note', v_note, auth.uid());
end;
$$;
revoke all on function public.ab_add_note(uuid, text) from public, anon;
grant execute on function public.ab_add_note(uuid, text) to authenticated;

-- ---------- Worker invocation, manual + scheduled runs ----------

create or replace function public.ab_is_paused()
returns boolean
language sql stable
set search_path = ''
as $$
  select coalesce((select value from public.ab_settings where key = 'paused'), 'false') = 'true';
$$;
revoke all on function public.ab_is_paused() from public, anon;
grant execute on function public.ab_is_paused() to authenticated, service_role;

create or replace function public.ab_invoke_worker(p_purpose text)
returns bigint
language plpgsql security definer
set search_path = ''
as $$
declare v_token uuid; v_url text; v_key text; v_req bigint;
begin
  select value into v_url from public.ab_settings where key = 'functions_url';
  select value into v_key from public.ab_settings where key = 'anon_key';
  if v_url is null or v_key is null then raise exception 'ab_settings functions_url / anon_key missing'; end if;
  insert into public.dpl_invocations (purpose) values ('ab:' || p_purpose) returning token into v_token;
  select net.http_post(url := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'apikey', v_key, 'Authorization', 'Bearer ' || v_key),
    body := jsonb_build_object('token', v_token, 'purpose', p_purpose), timeout_milliseconds := 20000) into v_req;
  return v_req;
end;
$$;
revoke all on function public.ab_invoke_worker(text) from public, anon, authenticated;
grant execute on function public.ab_invoke_worker(text) to service_role;

-- "Find Auction Buyers Now" (admin) and the Wednesday schedule (cron) both
-- create a run here, so the two paths cannot diverge.
create or replace function public.ab_request_run(p_options jsonb default '{}'::jsonb, p_trigger text default 'manual')
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare v_run uuid;
begin
  if current_user not in ('postgres', 'supabase_admin') and not public.is_admin() then
    raise exception 'not authorized';
  end if;
  if public.ab_is_paused() then
    raise exception 'Auction Buyer research is paused. Run select public.ab_set_paused(false) to resume it.';
  end if;
  update public.ab_runs set status = 'failed', finished_at = now(),
         errors = errors || jsonb_build_array(jsonb_build_object('at', now(), 'error', 'abandoned: no heartbeat for 15 minutes'))
   where status in ('queued', 'running') and coalesce(heartbeat_at, created_at) < now() - interval '15 minutes';
  update public.ab_jobs set status = 'failed', last_error = 'run abandoned', finished_at = now()
   where status in ('queued', 'running') and run_id in (select id from public.ab_runs where status = 'failed');
  if exists (select 1 from public.ab_runs where status in ('queued', 'running')) then
    raise exception 'a research run is already in progress';
  end if;
  insert into public.ab_runs (trigger, requested_by, options)
  values (case when p_trigger in ('manual', 'scheduled', 'tick') then p_trigger else 'manual' end,
          case when auth.uid() is not null and public.is_admin() then auth.uid() else null end, coalesce(p_options, '{}'::jsonb))
  returning id into v_run;
  insert into public.ab_jobs (run_id, kind, priority, payload) values (v_run, 'run.start', 0, jsonb_build_object('run_id', v_run));
  perform public.ab_invoke_worker('run:' || p_trigger);
  return v_run;
end;
$$;
revoke all on function public.ab_request_run(jsonb, text) from public, anon;
grant execute on function public.ab_request_run(jsonb, text) to authenticated;

create or replace function public.ab_resume_run()
returns text
language plpgsql security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then raise exception 'not authorized'; end if;
  if not exists (select 1 from public.ab_jobs where status = 'queued') then return 'nothing queued'; end if;
  if exists (select 1 from public.ab_runs where status = 'running' and heartbeat_at > now() - interval '2 minutes') then return 'busy'; end if;
  update public.ab_jobs set status = 'queued' where status = 'running' and started_at < now() - interval '10 minutes';
  perform public.ab_invoke_worker('resume');
  return 'invoked';
end;
$$;
revoke all on function public.ab_resume_run() from public, anon;
grant execute on function public.ab_resume_run() to authenticated;

-- Weekly scheduler entry point: registered twice in UTC (12:00 and 13:00 on
-- Wednesday); only the firing that lands at 08:00 America/New_York runs.
create or replace function public.ab_scheduled_kick()
returns text
language plpgsql security definer
set search_path = ''
as $$
declare v_local timestamp := (now() at time zone 'America/New_York'); v_enabled text;
begin
  if public.ab_is_paused() then return 'paused'; end if;
  select value into v_enabled from public.ab_settings where key = 'run_enabled';
  if coalesce(v_enabled, 'true') <> 'true' then return 'disabled'; end if;
  if extract(hour from v_local) <> 8 then return 'skip: not 8am Eastern (' || to_char(v_local, 'HH24:MI') || ')'; end if;
  if extract(isodow from v_local) <> 3 then return 'skip: not Wednesday'; end if;
  if exists (select 1 from public.ab_runs where trigger = 'scheduled' and (created_at at time zone 'America/New_York')::date = v_local::date) then
    return 'skip: already ran today';
  end if;
  perform public.ab_request_run('{}'::jsonb, 'scheduled');
  return 'started';
end;
$$;
revoke all on function public.ab_scheduled_kick() from public, anon, authenticated;

-- Watchdog: re-wake the worker if queued work is waiting and nothing has
-- checked in. Does nothing when the queue is empty or the channel is paused.
create or replace function public.ab_tick()
returns text
language plpgsql security definer
set search_path = ''
as $$
begin
  if public.ab_is_paused() then return 'paused'; end if;
  if not exists (select 1 from public.ab_jobs where status = 'queued') then return 'idle'; end if;
  if exists (select 1 from public.ab_runs where status = 'running' and heartbeat_at > now() - interval '3 minutes') then return 'busy'; end if;
  if exists (select 1 from public.dpl_invocations where purpose like 'ab:%' and created_at > now() - interval '3 minutes') then return 'recently invoked'; end if;
  update public.ab_jobs set status = 'queued' where status = 'running' and started_at < now() - interval '10 minutes';
  perform public.ab_invoke_worker('tick');
  return 'invoked';
end;
$$;
revoke all on function public.ab_tick() from public, anon, authenticated;

-- Pause / resume ONLY the Auction Buyer schedule (settings + cron together).
create or replace function public.ab_set_paused(p_paused boolean)
returns text
language plpgsql security definer
set search_path = ''
as $$
declare j record;
begin
  if current_user not in ('postgres', 'supabase_admin') and not public.is_admin() then raise exception 'not authorized'; end if;
  insert into public.ab_settings (key, value, updated_at) values ('paused', case when p_paused then 'true' else 'false' end, now())
  on conflict (key) do update set value = excluded.value, updated_at = now();
  insert into public.ab_settings (key, value, updated_at) values ('run_enabled', case when p_paused then 'false' else 'true' end, now())
  on conflict (key) do update set value = excluded.value, updated_at = now();
  for j in select jobid from cron.job where jobname in ('ab-weekly-1200utc', 'ab-weekly-1300utc', 'ab-tick') loop
    perform cron.unschedule(j.jobid);
  end loop;
  if not p_paused then
    -- 08:00 America/New_York on Wednesday is 12:00 UTC (EDT) or 13:00 UTC (EST); the kick checks the local hour.
    perform cron.schedule('ab-weekly-1200utc', '0 12 * * 3', 'select public.ab_scheduled_kick()');
    perform cron.schedule('ab-weekly-1300utc', '0 13 * * 3', 'select public.ab_scheduled_kick()');
    perform cron.schedule('ab-tick', '*/15 * * * *', 'select public.ab_tick()');
    return 'resumed';
  end if;
  return 'paused';
end;
$$;
revoke all on function public.ab_set_paused(boolean) from public, anon;
grant execute on function public.ab_set_paused(boolean) to authenticated;

-- Register the Wednesday schedule now (this touches only ab-* jobs).
select public.ab_set_paused(false);

-- ---------- Views ----------

drop view if exists public.ab_lead_list;
create view public.ab_lead_list
with (security_invoker = true) as
select
  b.id, b.buyer_name, b.contact_name, b.phone, b.email, b.website, b.mailing_address, b.city, b.county, b.counties,
  b.buyer_type, b.is_institutional, b.recent_acquisitions, b.portfolio_count, b.priority, b.qualified,
  b.evidence, b.source_urls, b.research_notes,
  b.contact_status, b.status_changed_at, b.last_contacted_at, b.follow_up_date, b.notes, b.assigned_to,
  b.run_id, b.created_at, b.updated_at,
  cb.display_name as created_by_name,
  lp.address as latest_property, lp.county as latest_property_county, lp.acquired_on as latest_acquired_on,
  lp.property_type as latest_property_type, lp.sale_type as latest_sale_type,
  (select count(*) from public.ab_activity x where x.buyer_id = b.id and x.kind = 'note')::int as note_count,
  (select max(x.created_at) from public.ab_activity x where x.buyer_id = b.id) as last_activity_at,
  ln.note as last_note, ln.created_at as last_note_at, ln.display_name as last_note_by
from public.ab_buyers b
left join public.admin_users cb on cb.user_id = b.created_by
left join lateral (
  select pr.address, pr.county, pr.property_type, pr.sale_type, coalesce(x.acquired_on, pr.sale_date) as acquired_on
    from public.ab_buyer_properties x join public.ab_properties pr on pr.id = x.property_id
   where x.buyer_id = b.id order by coalesce(x.acquired_on, pr.sale_date) desc nulls last, pr.created_at desc limit 1
) lp on true
left join lateral (
  select x.note, x.created_at, au.display_name
    from public.ab_activity x left join public.admin_users au on au.user_id = x.user_id
   where x.buyer_id = b.id and x.note is not null and x.kind in ('note', 'contact', 'status_change')
   order by x.created_at desc limit 1
) ln on true;
grant select on public.ab_lead_list to authenticated;

drop view if exists public.ab_activity_view;
create view public.ab_activity_view
with (security_invoker = true) as
select x.id, x.buyer_id, x.kind, x.from_status, x.to_status, x.note, x.created_at, au.display_name
from public.ab_activity x left join public.admin_users au on au.user_id = x.user_id;
grant select on public.ab_activity_view to authenticated;

drop view if exists public.ab_buyer_property_list;
create view public.ab_buyer_property_list
with (security_invoker = true) as
select x.buyer_id, pr.id as property_id, pr.county, pr.parcel_id, pr.address, pr.city, pr.zip, pr.property_type, pr.sale_type,
       pr.sale_date, coalesce(x.acquired_on, pr.sale_date) as acquired_on, pr.list_owner_name, pr.assessor_owner_name,
       pr.purchaser_name, pr.purchase_price, pr.sold_confirmed, pr.sold_evidence, pr.research_status, pr.status_reason,
       pr.assessor_source_url, pr.list_url, pr.list_label, pr.evidence, x.evidence as link_evidence
from public.ab_buyer_properties x join public.ab_properties pr on pr.id = x.property_id;
grant select on public.ab_buyer_property_list to authenticated;

create or replace function public.ab_summary()
returns jsonb
language plpgsql stable
set search_path = ''
as $$
declare last_any public.ab_runs; v_today date := (now() at time zone 'America/New_York')::date; v_next timestamptz; d date;
begin
  if not public.is_admin() then raise exception 'not authorized'; end if;
  select * into last_any from public.ab_runs order by created_at desc limit 1;
  d := v_today;
  loop
    if extract(isodow from d) = 3 and (d + time '08:00') > (now() at time zone 'America/New_York') then exit; end if;
    d := d + 1;
  end loop;
  v_next := (d + time '08:00') at time zone 'America/New_York';
  return jsonb_build_object(
    'visible', (select count(*) from public.ab_buyers where qualified and priority <> 'Low' and contact_status not in ('Not Interested', 'Bad Lead')),
    'call_today', (select count(*) from public.ab_buyers where contact_status = 'Call Today'),
    'follow_ups_due', (select count(*) from public.ab_buyers where follow_up_date <= v_today and contact_status not in ('Not Interested', 'Bad Lead')),
    'repeat_buyers', (select count(*) from public.ab_buyers where qualified and recent_acquisitions >= 2),
    'queue', (select coalesce(jsonb_object_agg(s.research_status, s.n), '{}'::jsonb) from (select research_status, count(*) as n from public.ab_properties group by research_status) s),
    'queue_total', (select count(*) from public.ab_properties),
    'by_county', (select coalesce(jsonb_object_agg(s.county, s.n), '{}'::jsonb) from (select county, count(*) as n from public.ab_buyers where qualified and priority <> 'Low' group by county) s),
    'last_run', case when last_any.id is null then null else jsonb_build_object('id', last_any.id, 'status', last_any.status, 'trigger', last_any.trigger,
        'started_at', last_any.started_at, 'finished_at', last_any.finished_at, 'heartbeat_at', last_any.heartbeat_at,
        'counts', last_any.counts, 'log', last_any.log, 'errors', last_any.errors, 'options', last_any.options) end,
    'queued_jobs', (select count(*) from public.ab_jobs where status = 'queued'),
    'paused', public.ab_is_paused(),
    'next_scheduled_run', v_next,
    'sources', (select coalesce(jsonb_agg(jsonb_build_object('source_id', s.source_id, 'label', s.label, 'county', s.county, 'enabled', s.enabled,
        'last_success_at', s.last_success_at, 'last_error', s.last_error, 'notes', s.notes) order by s.county, s.source_id), '[]'::jsonb) from public.ab_source_state s),
    'has_ai_key', coalesce((public.dpl_secret_status()->>'anthropic_api_key')::boolean, false)
  );
end;
$$;
revoke all on function public.ab_summary() from public, anon;
grant execute on function public.ab_summary() to authenticated;
