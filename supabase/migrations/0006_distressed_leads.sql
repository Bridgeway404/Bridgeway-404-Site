-- ============================================================
-- Distressed Property Leads (dpl_*)
--
-- Recurring foreclosure / eviction-turnover lead research for
-- Fulton, DeKalb, Douglas and Henry counties. Purely additive:
-- new tables, views, functions and cron jobs. Nothing in the
-- existing prospect / outreach / follow-up schema is modified.
--
-- Shape
--   dpl_runs            one row per research run (scheduled or manual)
--   dpl_run_sources     per-source outcome inside a run
--   dpl_source_state    per-source cursor + last error (incremental ingestion)
--   dpl_source_items    every raw record ever seen, keyed by source + external id
--   dpl_properties      one row per distressed property (the lead)
--   dpl_events          foreclosure / eviction events on a property, with stage
--   dpl_event_history   every stage change, with the source that caused it
--   dpl_companies       company-level research cache (owner / manager / investor…)
--   dpl_contacts        business-side contacts at a company
--   dpl_property_companies  property ⇄ company relationships with evidence
--   dpl_evidence        source-traceable claims ("why do we think X?")
--   dpl_lead_activity   Bridgeway workflow notes and status changes on a lead
--   dpl_uploads         human-assisted ingestion (eviction lists, notice PDFs, manual cases)
--   dpl_jobs            work queue processed by the Edge Function worker
--   dpl_invocations     one-time tokens that authenticate worker invocations
--   dpl_settings        pipeline configuration (non-secret)
--
-- Secrets (the Anthropic API key) live in Supabase Vault and are read
-- only by the Edge Function through dpl_get_secret() (service role).
--
-- Scheduling: pg_cron evaluates schedules in UTC and cannot be given a
-- timezone on Supabase, so two UTC jobs are registered — 12:00 UTC and
-- 13:00 UTC on Tuesday and Thursday — and dpl_scheduled_kick() only
-- starts a run when the current America/New_York hour is 8. Exactly one
-- of the two firings matches, in both daylight and standard time.
-- ============================================================

-- ---------- Settings ----------

create table if not exists public.dpl_settings (
  key        text primary key,
  value      text,
  updated_at timestamptz not null default now()
);

insert into public.dpl_settings (key, value) values
  ('functions_url', 'https://ctqdnphsvkbgegdtsmwb.supabase.co/functions/v1/distressed-leads'),
  -- The anon key is public by design (it is also shipped in admin/assets/config.js).
  -- It only lets pg_net pass the Edge Function gateway; the worker separately
  -- validates a one-time token from dpl_invocations before doing anything.
  ('anon_key', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN0cWRucGhzdmtiZ2VnZHRzbXdiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc1Mjc1OTgsImV4cCI6MjEwMzEwMzU5OH0.f1jDMUGnpQI_U-IANy3t89R7s3d1Sy_8oC_C4fHhXpo'),
  ('run_enabled', 'true'),
  ('ai_model_research', 'claude-opus-5'),
  ('ai_model_extract', 'claude-sonnet-5'),
  ('max_company_research_per_run', '20'),
  ('max_notice_extractions_per_run', '150'),
  ('company_refresh_days', '90'),
  ('lookback_days', '14')
on conflict (key) do nothing;

-- ---------- Runs ----------

create table if not exists public.dpl_runs (
  id                 uuid primary key default gen_random_uuid(),
  trigger            text not null check (trigger in ('scheduled', 'manual', 'tick', 'upload')),
  status             text not null default 'queued'
                     check (status in ('queued', 'running', 'completed', 'completed_with_errors', 'failed')),
  requested_by       uuid references public.admin_users (user_id),
  started_at         timestamptz,
  finished_at        timestamptz,
  heartbeat_at       timestamptz,
  counties_attempted text[] not null default '{}',
  sources_attempted  text[] not null default '{}',
  sources_succeeded  text[] not null default '{}',
  sources_failed     text[] not null default '{}',
  counts             jsonb not null default '{}'::jsonb,
  errors             jsonb not null default '[]'::jsonb,
  notes              text,
  created_at         timestamptz not null default now()
);
create index if not exists dpl_runs_created_idx on public.dpl_runs (created_at desc);

create table if not exists public.dpl_run_sources (
  id            uuid primary key default gen_random_uuid(),
  run_id        uuid not null references public.dpl_runs (id) on delete cascade,
  source_id     text not null,
  county        text,
  status        text not null default 'pending'
                check (status in ('pending', 'running', 'ok', 'failed', 'skipped', 'unavailable')),
  started_at    timestamptz,
  finished_at   timestamptz,
  items_seen    int not null default 0,
  items_new     int not null default 0,
  items_updated int not null default 0,
  error         text,
  detail        jsonb not null default '{}'::jsonb,
  unique (run_id, source_id)
);

create table if not exists public.dpl_source_state (
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

-- Raw record registry: the incremental-ingestion memory of each source.
create table if not exists public.dpl_source_items (
  id            uuid primary key default gen_random_uuid(),
  source_id     text not null,
  external_id   text not null,
  url           text,
  content_hash  text,
  parsed        jsonb not null default '{}'::jsonb,
  property_id   uuid,
  event_id      uuid,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  seen_count    int not null default 1,
  first_run_id  uuid references public.dpl_runs (id) on delete set null,
  last_run_id   uuid references public.dpl_runs (id) on delete set null,
  unique (source_id, external_id)
);
create index if not exists dpl_source_items_property_idx on public.dpl_source_items (property_id);

-- ---------- Companies & contacts (research cache) ----------

create table if not exists public.dpl_companies (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null,
  name_key           text generated always as
                       (regexp_replace(lower(name), '[^a-z0-9]', '', 'g')) stored,
  company_type       text not null default 'unknown'
                     check (company_type in ('property_management', 'owner_entity', 'institutional_investor',
                       'reit', 'sfr_operator', 'multifamily_operator', 'lender', 'servicer', 'law_firm',
                       'reo', 'asset_manager', 'preservation', 'government', 'nonprofit', 'individual',
                       'other', 'unknown')),
  website            text,
  main_phone         text,
  main_email         text,
  contact_page_url   text,
  hq_address         text,
  parent_company_id  uuid references public.dpl_companies (id) on delete set null,
  sos_control_number text,
  sos_status         text,
  registered_agent   text,
  portfolio_notes    text,
  research_summary   text,
  research_status    text not null default 'unresearched'
                     check (research_status in ('unresearched', 'queued', 'researched', 'failed', 'stale', 'skipped')),
  researched_at      timestamptz,
  last_verified_at   timestamptz,
  refresh_after      timestamptz,
  confidence         text check (confidence in ('high', 'medium', 'low')),
  confidence_reason  text,
  sources            jsonb not null default '[]'::jsonb,
  is_individual      boolean not null default false,
  do_not_contact     boolean not null default false,
  prospect_id        uuid references public.prospects (id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create unique index if not exists dpl_companies_key_uidx on public.dpl_companies (name_key);
create index if not exists dpl_companies_research_idx on public.dpl_companies (research_status, refresh_after);

create table if not exists public.dpl_contacts (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.dpl_companies (id) on delete cascade,
  name              text,
  title             text,
  role_category     text not null default 'other'
                    check (role_category in ('onsite_manager', 'regional_manager', 'property_management',
                      'director_operations', 'maintenance', 'facilities', 'asset_manager', 'reo_manager',
                      'preservation', 'owner_rep', 'portfolio_manager', 'acquisitions', 'executive',
                      'general', 'other')),
  email             text,
  phone             text,
  phone_type        text check (phone_type in ('office', 'corporate', 'property_office', 'mobile_business')),
  profile_url       text,
  source_url        text,
  evidence          text,
  confidence        text not null default 'low' check (confidence in ('high', 'medium', 'low')),
  confidence_reason text,
  is_primary        boolean not null default false,
  verified_at       timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists dpl_contacts_company_idx on public.dpl_contacts (company_id, is_primary desc);

-- ---------- Properties (the lead) ----------

create table if not exists public.dpl_properties (
  id                    uuid primary key default gen_random_uuid(),
  county                text not null check (county in ('Fulton', 'DeKalb', 'Douglas', 'Henry')),
  address_raw           text,
  address_norm          text,
  street_number         text,
  street_name           text,
  unit                  text,
  city                  text,
  zip                   text,
  parcel_id             text,
  parcel_id_norm        text,
  legal_description     text,
  property_type         text not null default 'unknown'
                        check (property_type in ('single_family', 'multifamily', 'condo', 'townhome',
                          'commercial', 'land', 'mixed', 'unknown')),
  lead_type             text not null default 'foreclosure'
                        check (lead_type in ('foreclosure', 'eviction', 'both')),
  current_stage         text,
  event_date            date,
  owner_name            text,
  owner_mailing_address text,
  owner_source          text,
  owner_source_url      text,
  owner_verified_at     timestamptz,
  owner_company_id      uuid references public.dpl_companies (id) on delete set null,
  manager_company_id    uuid references public.dpl_companies (id) on delete set null,
  investor_company_id   uuid references public.dpl_companies (id) on delete set null,
  parent_company_id     uuid references public.dpl_companies (id) on delete set null,
  target_company_id     uuid references public.dpl_companies (id) on delete set null,
  target_contact_id     uuid references public.dpl_contacts (id) on delete set null,
  target_reason         text,
  opportunity_score     int not null default 0 check (opportunity_score between 0 and 100),
  score_breakdown       jsonb not null default '[]'::jsonb,
  research_explanation  text,
  enrichment_status     text not null default 'pending'
                        check (enrichment_status in ('pending', 'queued', 'partial', 'done', 'failed', 'skipped')),
  enrichment_priority   int not null default 0,
  workflow_status       text not null default 'New'
                        check (workflow_status in ('New', 'Reviewing', 'Outreach Ready', 'Contacted',
                          'Follow Up', 'Not a Fit', 'Closed')),
  reviewed_at           timestamptz,
  reviewed_by           uuid references public.admin_users (user_id),
  first_seen_at         timestamptz not null default now(),
  last_seen_at          timestamptz not null default now(),
  last_researched_at    timestamptz,
  first_run_id          uuid references public.dpl_runs (id) on delete set null,
  last_run_id           uuid references public.dpl_runs (id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create unique index if not exists dpl_properties_parcel_uidx
  on public.dpl_properties (county, parcel_id_norm) where parcel_id_norm is not null;
create index if not exists dpl_properties_address_idx on public.dpl_properties (county, address_norm);
create index if not exists dpl_properties_score_idx on public.dpl_properties (opportunity_score desc, last_seen_at desc);
create index if not exists dpl_properties_status_idx on public.dpl_properties (workflow_status, county);
create index if not exists dpl_properties_target_idx on public.dpl_properties (target_company_id);

-- ---------- Events & stage history ----------

create table if not exists public.dpl_events (
  id                     uuid primary key default gen_random_uuid(),
  property_id            uuid not null references public.dpl_properties (id) on delete cascade,
  county                 text not null,
  event_type             text not null check (event_type in ('foreclosure', 'eviction')),
  stage                  text not null check (stage in (
                           -- foreclosure
                           'notice_published', 'sale_scheduled', 'sale_imminent', 'sale_completed', 'sale_cancelled',
                           -- eviction
                           'dispossessory_filed', 'service_completed', 'hearing_scheduled', 'judgment_entered',
                           'writ_issued', 'writ_pending_execution', 'eviction_scheduled', 'eviction_executed',
                           'possession_returned', 'dismissed', 'status_unknown')),
  case_number            text,
  foreclosure_identifier text,
  filed_date             date,
  publication_date       date,
  hearing_date           date,
  judgment_date          date,
  writ_date              date,
  execution_date         date,
  sale_date              date,
  plaintiff_name         text,
  lender                 text,
  secured_party          text,
  foreclosing_entity     text,
  servicer               text,
  law_firm               text,
  borrower_names         text,
  source_id              text,
  source_url             text,
  raw_excerpt            text,
  details                jsonb not null default '{}'::jsonb,
  publication_count      int not null default 1,
  status                 text not null default 'active' check (status in ('active', 'stale', 'closed')),
  first_detected_at      timestamptz not null default now(),
  last_detected_at       timestamptz not null default now(),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
create index if not exists dpl_events_property_idx on public.dpl_events (property_id, last_detected_at desc);
create unique index if not exists dpl_events_case_uidx
  on public.dpl_events (county, event_type, case_number) where case_number is not null;
create index if not exists dpl_events_stage_idx on public.dpl_events (event_type, stage);

create table if not exists public.dpl_event_history (
  id         uuid primary key default gen_random_uuid(),
  event_id   uuid not null references public.dpl_events (id) on delete cascade,
  from_stage text,
  to_stage   text not null,
  changed_at timestamptz not null default now(),
  source_id  text,
  source_url text,
  note       text,
  run_id     uuid references public.dpl_runs (id) on delete set null,
  changed_by uuid references public.admin_users (user_id)
);
create index if not exists dpl_event_history_event_idx on public.dpl_event_history (event_id, changed_at desc);

-- ---------- Relationships & evidence ----------

create table if not exists public.dpl_property_companies (
  id           uuid primary key default gen_random_uuid(),
  property_id  uuid not null references public.dpl_properties (id) on delete cascade,
  company_id   uuid not null references public.dpl_companies (id) on delete cascade,
  relationship text not null check (relationship in ('owner', 'manager', 'investor', 'parent', 'lender',
                 'servicer', 'law_firm', 'plaintiff', 'foreclosing_entity', 'purchaser', 'other')),
  evidence     text,
  source_url   text,
  confidence   text not null default 'low' check (confidence in ('high', 'medium', 'low')),
  created_at   timestamptz not null default now(),
  unique (property_id, company_id, relationship)
);
create index if not exists dpl_property_companies_company_idx on public.dpl_property_companies (company_id);

create table if not exists public.dpl_evidence (
  id           uuid primary key default gen_random_uuid(),
  subject_type text not null check (subject_type in ('property', 'event', 'company', 'contact')),
  subject_id   uuid not null,
  claim        text not null,
  source_id    text,
  source_url   text,
  excerpt      text,
  confidence   text check (confidence in ('high', 'medium', 'low')),
  run_id       uuid references public.dpl_runs (id) on delete set null,
  captured_at  timestamptz not null default now()
);
create index if not exists dpl_evidence_subject_idx on public.dpl_evidence (subject_type, subject_id, captured_at desc);

-- ---------- Bridgeway workflow ----------

create table if not exists public.dpl_lead_activity (
  id          uuid primary key default gen_random_uuid(),
  property_id uuid not null references public.dpl_properties (id) on delete cascade,
  kind        text not null check (kind in ('note', 'status_change', 'system')),
  from_status text,
  to_status   text,
  note        text,
  user_id     uuid references public.admin_users (user_id),
  created_at  timestamptz not null default now()
);
create index if not exists dpl_lead_activity_property_idx on public.dpl_lead_activity (property_id, created_at desc);

-- ---------- Human-assisted ingestion ----------

create table if not exists public.dpl_uploads (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null check (kind in ('eviction_list', 'notice_pdf', 'csv', 'manual_case')),
  county      text check (county in ('Fulton', 'DeKalb', 'Douglas', 'Henry')),
  source_label text,
  filename    text,
  mime        text,
  content_b64 text,
  payload     jsonb not null default '{}'::jsonb,
  status      text not null default 'pending' check (status in ('pending', 'processing', 'done', 'failed')),
  result      jsonb not null default '{}'::jsonb,
  uploaded_by uuid references public.admin_users (user_id),
  created_at  timestamptz not null default now(),
  processed_at timestamptz
);

-- ---------- Worker queue & invocation tokens ----------

create table if not exists public.dpl_jobs (
  id          uuid primary key default gen_random_uuid(),
  run_id      uuid references public.dpl_runs (id) on delete cascade,
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
create index if not exists dpl_jobs_queue_idx on public.dpl_jobs (status, priority, created_at);

create table if not exists public.dpl_invocations (
  token      uuid primary key default gen_random_uuid(),
  purpose    text not null,
  created_at timestamptz not null default now(),
  claimed_at timestamptz
);

-- ---------- updated_at triggers ----------

do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'dpl_properties_touch') then
    create trigger dpl_properties_touch before update on public.dpl_properties
      for each row execute function public.touch_updated_at();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'dpl_events_touch') then
    create trigger dpl_events_touch before update on public.dpl_events
      for each row execute function public.touch_updated_at();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'dpl_companies_touch') then
    create trigger dpl_companies_touch before update on public.dpl_companies
      for each row execute function public.touch_updated_at();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'dpl_contacts_touch') then
    create trigger dpl_contacts_touch before update on public.dpl_contacts
      for each row execute function public.touch_updated_at();
  end if;
end $$;

-- ---------- Row-level security (admin allowlist only) ----------

alter table public.dpl_settings           enable row level security;
alter table public.dpl_runs               enable row level security;
alter table public.dpl_run_sources        enable row level security;
alter table public.dpl_source_state       enable row level security;
alter table public.dpl_source_items       enable row level security;
alter table public.dpl_companies          enable row level security;
alter table public.dpl_contacts           enable row level security;
alter table public.dpl_properties         enable row level security;
alter table public.dpl_events             enable row level security;
alter table public.dpl_event_history      enable row level security;
alter table public.dpl_property_companies enable row level security;
alter table public.dpl_evidence           enable row level security;
alter table public.dpl_lead_activity      enable row level security;
alter table public.dpl_uploads            enable row level security;
alter table public.dpl_jobs               enable row level security;
alter table public.dpl_invocations        enable row level security;

-- Read access for admins on everything except invocation tokens.
do $$
declare t text;
begin
  foreach t in array array['dpl_settings','dpl_runs','dpl_run_sources','dpl_source_state','dpl_source_items',
    'dpl_companies','dpl_contacts','dpl_properties','dpl_events','dpl_event_history',
    'dpl_property_companies','dpl_evidence','dpl_lead_activity','dpl_uploads','dpl_jobs'] loop
    execute format('drop policy if exists %I_select on public.%I', t, t);
    execute format('create policy %I_select on public.%I for select to authenticated using (public.is_admin())', t, t);
  end loop;
end $$;

-- Admins may correct research fields on companies / contacts / properties
-- directly (the pipeline writes with the service role, which bypasses RLS).
drop policy if exists dpl_companies_update on public.dpl_companies;
create policy dpl_companies_update on public.dpl_companies
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists dpl_contacts_update on public.dpl_contacts;
create policy dpl_contacts_update on public.dpl_contacts
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists dpl_contacts_insert on public.dpl_contacts;
create policy dpl_contacts_insert on public.dpl_contacts
  for insert to authenticated with check (public.is_admin());
drop policy if exists dpl_properties_update on public.dpl_properties;
create policy dpl_properties_update on public.dpl_properties
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists dpl_settings_update on public.dpl_settings;
create policy dpl_settings_update on public.dpl_settings
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists dpl_source_state_update on public.dpl_source_state;
create policy dpl_source_state_update on public.dpl_source_state
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists dpl_uploads_insert on public.dpl_uploads;
create policy dpl_uploads_insert on public.dpl_uploads
  for insert to authenticated with check (public.is_admin() and uploaded_by = auth.uid());

-- ---------- Secrets (Supabase Vault) ----------

-- Admins store the Anthropic API key from the Admin UI; only the worker
-- (service role) can read it back. Never returned to the browser.
create or replace function public.dpl_set_secret(p_name text, p_value text)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;
  if p_name not in ('anthropic_api_key') then
    raise exception 'unknown secret name';
  end if;
  if coalesce(btrim(p_value), '') = '' then
    raise exception 'secret value is required';
  end if;
  select id into v_id from vault.secrets where name = p_name;
  if v_id is null then
    perform vault.create_secret(btrim(p_value), p_name, 'Distressed Property Leads pipeline');
  else
    perform vault.update_secret(v_id, btrim(p_value));
  end if;
end;
$$;
revoke all on function public.dpl_set_secret(text, text) from public, anon;
grant execute on function public.dpl_set_secret(text, text) to authenticated;

create or replace function public.dpl_secret_status()
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;
  return jsonb_build_object(
    'anthropic_api_key', exists (select 1 from vault.secrets where name = 'anthropic_api_key')
  );
end;
$$;
revoke all on function public.dpl_secret_status() from public, anon;
grant execute on function public.dpl_secret_status() to authenticated;

create or replace function public.dpl_get_secret(p_name text)
returns text
language sql security definer
set search_path = ''
as $$
  select decrypted_secret from vault.decrypted_secrets where name = p_name limit 1;
$$;
revoke all on function public.dpl_get_secret(text) from public, anon, authenticated;
grant execute on function public.dpl_get_secret(text) to service_role;

-- ---------- Worker invocation ----------

-- Fire the Edge Function worker through pg_net with a one-time token.
create or replace function public.dpl_invoke_worker(p_purpose text)
returns bigint
language plpgsql security definer
set search_path = ''
as $$
declare
  v_token uuid;
  v_url text;
  v_key text;
  v_req bigint;
begin
  select value into v_url from public.dpl_settings where key = 'functions_url';
  select value into v_key from public.dpl_settings where key = 'anon_key';
  if v_url is null or v_key is null then
    raise exception 'dpl_settings functions_url / anon_key missing';
  end if;
  insert into public.dpl_invocations (purpose) values (p_purpose) returning token into v_token;
  select net.http_post(
    url := v_url,
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'apikey', v_key,
                                  'Authorization', 'Bearer ' || v_key),
    body := jsonb_build_object('token', v_token, 'purpose', p_purpose),
    timeout_milliseconds := 20000
  ) into v_req;
  return v_req;
end;
$$;
revoke all on function public.dpl_invoke_worker(text) from public, anon, authenticated;
-- The worker (service role) re-invokes itself to continue long runs.
grant execute on function public.dpl_invoke_worker(text) to service_role;

-- The worker claims its token (service role only). Tokens expire after 15 minutes.
create or replace function public.dpl_claim_invocation(p_token uuid)
returns boolean
language plpgsql security definer
set search_path = ''
as $$
declare
  ok boolean := false;
begin
  update public.dpl_invocations
     set claimed_at = now()
   where token = p_token
     and claimed_at is null
     and created_at > now() - interval '15 minutes'
  returning true into ok;
  delete from public.dpl_invocations where created_at < now() - interval '1 day';
  return coalesce(ok, false);
end;
$$;
revoke all on function public.dpl_claim_invocation(uuid) from public, anon, authenticated;
grant execute on function public.dpl_claim_invocation(uuid) to service_role;

-- Create a run (queued) and wake the worker. Used by the Admin "Run now"
-- button (admin JWT) and by the scheduler (cron, as postgres).
create or replace function public.dpl_request_run(p_trigger text default 'manual')
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_run uuid;
  v_uid uuid := auth.uid();
begin
  if current_user not in ('postgres', 'supabase_admin') and not public.is_admin() then
    raise exception 'not authorized';
  end if;
  if exists (select 1 from public.dpl_runs where status in ('queued', 'running')
               and coalesce(heartbeat_at, created_at) > now() - interval '10 minutes') then
    raise exception 'a research run is already in progress';
  end if;
  insert into public.dpl_runs (trigger, requested_by)
  values (p_trigger, case when v_uid is not null and public.is_admin() then v_uid else null end)
  returning id into v_run;
  insert into public.dpl_jobs (run_id, kind, priority, payload)
  values (v_run, 'run.start', 0, jsonb_build_object('run_id', v_run));
  perform public.dpl_invoke_worker('run:' || p_trigger);
  return v_run;
end;
$$;
revoke all on function public.dpl_request_run(text) from public, anon;
grant execute on function public.dpl_request_run(text) to authenticated;

-- Scheduler entry point. Registered twice in UTC (12:00 and 13:00, Tue/Thu);
-- only the firing that lands at 08:00 America/New_York starts a run.
create or replace function public.dpl_scheduled_kick()
returns text
language plpgsql security definer
set search_path = ''
as $$
declare
  v_local timestamp := (now() at time zone 'America/New_York');
  v_enabled text;
begin
  select value into v_enabled from public.dpl_settings where key = 'run_enabled';
  if coalesce(v_enabled, 'true') <> 'true' then
    return 'disabled';
  end if;
  if extract(hour from v_local) <> 8 then
    return 'skip: not 8am Eastern (' || to_char(v_local, 'HH24:MI') || ')';
  end if;
  if extract(isodow from v_local) not in (2, 4) then
    return 'skip: not Tue/Thu';
  end if;
  if exists (select 1 from public.dpl_runs
              where trigger = 'scheduled'
                and (created_at at time zone 'America/New_York')::date = v_local::date) then
    return 'skip: already ran today';
  end if;
  perform public.dpl_request_run('scheduled');
  return 'started';
end;
$$;
revoke all on function public.dpl_scheduled_kick() from public, anon, authenticated;

-- Watchdog: every 5 minutes, re-wake the worker if queued work is waiting and
-- no invocation has checked in recently (e.g. the worker hit its time limit).
create or replace function public.dpl_tick()
returns text
language plpgsql security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.dpl_jobs where status = 'queued') then
    return 'idle';
  end if;
  if exists (select 1 from public.dpl_runs
              where status = 'running' and heartbeat_at > now() - interval '3 minutes') then
    return 'busy';
  end if;
  if exists (select 1 from public.dpl_invocations
              where created_at > now() - interval '3 minutes') then
    return 'recently invoked';
  end if;
  perform public.dpl_invoke_worker('tick');
  return 'invoked';
end;
$$;
revoke all on function public.dpl_tick() from public, anon, authenticated;

-- ---------- Bridgeway workflow functions ----------

create or replace function public.dpl_set_lead_status(p_property_id uuid, p_status text, p_note text default null)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_old text;
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;
  select workflow_status into v_old from public.dpl_properties where id = p_property_id;
  if v_old is null then
    raise exception 'lead not found';
  end if;
  update public.dpl_properties
     set workflow_status = p_status,
         reviewed_at = now(),
         reviewed_by = auth.uid()
   where id = p_property_id;
  insert into public.dpl_lead_activity (property_id, kind, from_status, to_status, note, user_id)
  values (p_property_id, 'status_change', v_old, p_status, nullif(btrim(coalesce(p_note, '')), ''), auth.uid());
end;
$$;
revoke all on function public.dpl_set_lead_status(uuid, text, text) from public, anon;
grant execute on function public.dpl_set_lead_status(uuid, text, text) to authenticated;

create or replace function public.dpl_add_lead_note(p_property_id uuid, p_note text)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;
  if v_note is null then
    raise exception 'note text is required';
  end if;
  if not exists (select 1 from public.dpl_properties where id = p_property_id) then
    raise exception 'lead not found';
  end if;
  insert into public.dpl_lead_activity (property_id, kind, note, user_id)
  values (p_property_id, 'note', v_note, auth.uid());
end;
$$;
revoke all on function public.dpl_add_lead_note(uuid, text) from public, anon;
grant execute on function public.dpl_add_lead_note(uuid, text) to authenticated;

-- Manual stage update (e.g. after checking a court portal by hand). Preserves history.
create or replace function public.dpl_set_event_stage(p_event_id uuid, p_stage text, p_note text default null,
                                                     p_event_date date default null)
returns void
language plpgsql
set search_path = ''
as $$
declare
  e public.dpl_events;
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;
  select * into e from public.dpl_events where id = p_event_id;
  if e.id is null then
    raise exception 'event not found';
  end if;
  update public.dpl_events
     set stage = p_stage,
         last_detected_at = now(),
         writ_date = case when p_stage in ('writ_issued', 'writ_pending_execution') then coalesce(p_event_date, writ_date) else writ_date end,
         execution_date = case when p_stage in ('eviction_scheduled', 'eviction_executed', 'possession_returned') then coalesce(p_event_date, execution_date) else execution_date end,
         judgment_date = case when p_stage = 'judgment_entered' then coalesce(p_event_date, judgment_date) else judgment_date end,
         hearing_date = case when p_stage = 'hearing_scheduled' then coalesce(p_event_date, hearing_date) else hearing_date end,
         sale_date = case when p_stage in ('sale_scheduled', 'sale_imminent', 'sale_completed') then coalesce(p_event_date, sale_date) else sale_date end,
         status = case when p_stage in ('dismissed', 'sale_cancelled', 'possession_returned', 'sale_completed') then 'closed' else 'active' end
   where id = p_event_id;
  insert into public.dpl_event_history (event_id, from_stage, to_stage, note, changed_by, source_id)
  values (p_event_id, e.stage, p_stage, nullif(btrim(coalesce(p_note, '')), ''), auth.uid(), 'manual');
  update public.dpl_properties
     set current_stage = p_stage,
         event_date = coalesce(p_event_date, event_date),
         enrichment_status = case when enrichment_status = 'done' then 'done' else 'pending' end
   where id = e.property_id;
end;
$$;
revoke all on function public.dpl_set_event_stage(uuid, text, text, date) from public, anon;
grant execute on function public.dpl_set_event_stage(uuid, text, text, date) to authenticated;

-- Link a target company into the existing prospect database (reuses the
-- Blitz / Follow-Ups machinery instead of duplicating it).
create or replace function public.dpl_link_prospect(p_company_id uuid)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  c public.dpl_companies;
  v_key text;
  v_pid uuid;
  v_type public.prospect_type;
  v_contact public.dpl_contacts;
  v_geo text;
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;
  select * into c from public.dpl_companies where id = p_company_id;
  if c.id is null then
    raise exception 'company not found';
  end if;
  if c.prospect_id is not null then
    return c.prospect_id;
  end if;
  v_key := regexp_replace(lower(c.name), '[^a-z0-9]', '', 'g');
  select id into v_pid from public.prospects where company_key = v_key;
  if v_pid is null then
    v_type := case c.company_type
      when 'property_management' then 'property_management'::public.prospect_type
      when 'multifamily_operator' then 'multifamily_operator'::public.prospect_type
      when 'sfr_operator' then 'sfr_operator'::public.prospect_type
      when 'reo' then 'reo_field_services'::public.prospect_type
      when 'preservation' then 'reo_field_services'::public.prospect_type
      when 'asset_manager' then 'reo_field_services'::public.prospect_type
      when 'servicer' then 'reo_field_services'::public.prospect_type
      when 'lender' then 'reo_field_services'::public.prospect_type
      else 'property_management'::public.prospect_type end;
    select * into v_contact from public.dpl_contacts
     where company_id = c.id order by is_primary desc, confidence, created_at limit 1;
    select string_agg(distinct county, ', ') into v_geo
      from public.dpl_properties where target_company_id = c.id or owner_company_id = c.id or manager_company_id = c.id;
    insert into public.prospects (company_name, prospect_type, website, primary_geography,
      metro_atlanta_relevance, portfolio_summary, why_bridgeway, contact_name, contact_title,
      contact_phone, contact_email, general_contact_url, vendor_notes, source_urls, priority, last_verified_date)
    values (c.name, v_type, c.website, coalesce(v_geo, 'Metro Atlanta'),
      'Tied to distressed-property turnover activity in ' || coalesce(v_geo, 'Metro Atlanta'),
      c.portfolio_notes, 'Active foreclosure / eviction turnover events at properties this company controls (see Distressed Property Leads).',
      v_contact.name, v_contact.title, coalesce(v_contact.phone, c.main_phone), coalesce(v_contact.email, c.main_email),
      c.contact_page_url, c.research_summary,
      coalesce((select array_agg(s->>'url') from jsonb_array_elements(c.sources) s where s->>'url' is not null), '{}'),
      2, current_date)
    returning id into v_pid;
  end if;
  update public.dpl_companies set prospect_id = v_pid where id = c.id;
  return v_pid;
end;
$$;
revoke all on function public.dpl_link_prospect(uuid) from public, anon;
grant execute on function public.dpl_link_prospect(uuid) to authenticated;

-- Admin adds a case / property by hand or uploads a list; the worker ingests
-- it through the same dedupe + enrichment path as automated sources.
create or replace function public.dpl_submit_upload(p_kind text, p_county text, p_source_label text,
  p_filename text, p_mime text, p_content_b64 text, p_payload jsonb default '{}'::jsonb)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;
  if length(coalesce(p_content_b64, '')) > 12000000 then
    raise exception 'file too large (max ~8 MB)';
  end if;
  insert into public.dpl_uploads (kind, county, source_label, filename, mime, content_b64, payload, uploaded_by)
  values (p_kind, p_county, p_source_label, p_filename, p_mime, nullif(p_content_b64, ''), coalesce(p_payload, '{}'::jsonb), auth.uid())
  returning id into v_id;
  insert into public.dpl_jobs (kind, priority, payload)
  values ('ingest.upload', 5, jsonb_build_object('upload_id', v_id));
  if not exists (select 1 from public.dpl_runs where status in ('queued', 'running')
                   and coalesce(heartbeat_at, created_at) > now() - interval '10 minutes') then
    perform public.dpl_request_run('upload');
  end if;
  return v_id;
end;
$$;
revoke all on function public.dpl_submit_upload(text, text, text, text, text, text, jsonb) from public, anon;
grant execute on function public.dpl_submit_upload(text, text, text, text, text, text, jsonb) to authenticated;

-- ---------- Views ----------

drop view if exists public.dpl_lead_list;
create view public.dpl_lead_list
with (security_invoker = true) as
select
  p.id, p.county, p.lead_type, p.current_stage, p.event_date,
  p.address_raw, p.address_norm, p.city, p.zip, p.parcel_id, p.property_type,
  p.owner_name, p.owner_mailing_address, p.owner_source, p.owner_source_url,
  p.opportunity_score, p.score_breakdown, p.research_explanation,
  p.enrichment_status, p.workflow_status, p.reviewed_at,
  p.first_seen_at, p.last_seen_at, p.last_researched_at, p.updated_at, p.first_run_id,
  p.owner_company_id, p.manager_company_id, p.investor_company_id, p.parent_company_id,
  p.target_company_id, p.target_contact_id, p.target_reason,
  oc.name  as owner_company_name,
  mc.name  as manager_company_name,
  ic.name  as investor_company_name,
  pc.name  as parent_company_name,
  tc.name  as target_company_name,
  tc.company_type as target_company_type,
  tc.website as target_website,
  tc.main_phone as target_main_phone,
  tc.main_email as target_main_email,
  tc.confidence as target_company_confidence,
  tc.prospect_id as target_prospect_id,
  ct.name  as contact_name,
  ct.title as contact_title,
  ct.phone as contact_phone,
  ct.email as contact_email,
  ct.confidence as contact_confidence,
  ct.confidence_reason as contact_confidence_reason,
  ct.profile_url as contact_profile_url,
  e.id as event_id, e.event_type, e.stage, e.case_number, e.foreclosure_identifier,
  e.sale_date, e.writ_date, e.execution_date, e.hearing_date, e.judgment_date, e.filed_date,
  e.publication_date, e.publication_count, e.plaintiff_name, e.lender, e.secured_party,
  e.foreclosing_entity, e.servicer, e.law_firm, e.source_id, e.source_url, e.last_detected_at,
  (select count(*) from public.dpl_lead_activity a where a.property_id = p.id and a.kind = 'note')::int as note_count,
  (select max(a.created_at) from public.dpl_lead_activity a where a.property_id = p.id) as last_activity_at,
  (select count(*) from public.dpl_properties p2
     where p2.target_company_id = p.target_company_id and p.target_company_id is not null
       and p2.workflow_status not in ('Closed', 'Not a Fit'))::int as company_active_properties
from public.dpl_properties p
left join lateral (
  select * from public.dpl_events ev
   where ev.property_id = p.id
   order by (ev.status = 'active') desc, ev.last_detected_at desc
   limit 1
) e on true
left join public.dpl_companies oc on oc.id = p.owner_company_id
left join public.dpl_companies mc on mc.id = p.manager_company_id
left join public.dpl_companies ic on ic.id = p.investor_company_id
left join public.dpl_companies pc on pc.id = p.parent_company_id
left join public.dpl_companies tc on tc.id = p.target_company_id
left join public.dpl_contacts ct on ct.id = p.target_contact_id;
grant select on public.dpl_lead_list to authenticated;

drop view if exists public.dpl_company_summary;
create view public.dpl_company_summary
with (security_invoker = true) as
select
  c.id, c.name, c.company_type, c.website, c.main_phone, c.main_email, c.contact_page_url,
  c.research_status, c.researched_at, c.last_verified_at, c.confidence, c.confidence_reason,
  c.research_summary, c.portfolio_notes, c.parent_company_id, c.prospect_id, c.is_individual,
  pc.name as parent_company_name,
  ct.id as contact_id, ct.name as contact_name, ct.title as contact_title,
  ct.phone as contact_phone, ct.email as contact_email, ct.confidence as contact_confidence,
  s.active_properties, s.high_priority, s.counties, s.last_event_at, s.max_score, s.total_properties
from public.dpl_companies c
left join public.dpl_companies pc on pc.id = c.parent_company_id
left join lateral (
  select * from public.dpl_contacts x where x.company_id = c.id
   order by x.is_primary desc, case x.confidence when 'high' then 0 when 'medium' then 1 else 2 end, x.created_at
   limit 1
) ct on true
left join lateral (
  select
    count(*) filter (where p.workflow_status not in ('Closed', 'Not a Fit'))::int as active_properties,
    count(*) filter (where p.workflow_status not in ('Closed', 'Not a Fit') and p.opportunity_score >= 70)::int as high_priority,
    count(*)::int as total_properties,
    array_remove(array_agg(distinct p.county), null) as counties,
    max(p.last_seen_at) as last_event_at,
    max(p.opportunity_score) as max_score
  from public.dpl_properties p
  where p.target_company_id = c.id or p.owner_company_id = c.id
     or p.manager_company_id = c.id or p.investor_company_id = c.id
) s on true;
grant select on public.dpl_company_summary to authenticated;

drop view if exists public.dpl_lead_activity_view;
create view public.dpl_lead_activity_view
with (security_invoker = true) as
select a.id, a.property_id, a.kind, a.from_status, a.to_status, a.note, a.created_at,
       au.display_name
from public.dpl_lead_activity a
left join public.admin_users au on au.user_id = a.user_id;
grant select on public.dpl_lead_activity_view to authenticated;

-- Dashboard numbers in one call.
create or replace function public.get_dpl_summary()
returns jsonb
language plpgsql stable
set search_path = ''
as $$
declare
  last_ok public.dpl_runs;
  last_any public.dpl_runs;
  v_next timestamptz;
  v_now_local timestamp := now() at time zone 'America/New_York';
  d date;
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;
  select * into last_ok from public.dpl_runs
   where status in ('completed', 'completed_with_errors') order by finished_at desc nulls last limit 1;
  select * into last_any from public.dpl_runs order by created_at desc limit 1;

  -- Next Tuesday/Thursday 08:00 America/New_York, expressed as an instant.
  d := v_now_local::date;
  loop
    if extract(isodow from d) in (2, 4) and (d + time '08:00') > v_now_local then
      exit;
    end if;
    d := d + 1;
  end loop;
  v_next := (d + time '08:00') at time zone 'America/New_York';

  return jsonb_build_object(
    'new_from_latest_run', (select count(*) from public.dpl_properties p
                              where last_ok.id is not null and p.first_run_id = last_ok.id),
    'high_priority', (select count(*) from public.dpl_properties p
                        where p.opportunity_score >= 70 and p.workflow_status not in ('Closed', 'Not a Fit')),
    'foreclosures', (select count(*) from public.dpl_properties p
                       where p.lead_type in ('foreclosure', 'both') and p.workflow_status not in ('Closed', 'Not a Fit')),
    'evictions', (select count(*) from public.dpl_properties p
                    where p.lead_type in ('eviction', 'both') and p.workflow_status not in ('Closed', 'Not a Fit')),
    'evictions_confirmed', (select count(*) from public.dpl_properties p
                              where p.current_stage in ('writ_issued', 'writ_pending_execution', 'eviction_scheduled', 'eviction_executed', 'possession_returned')
                                and p.workflow_status not in ('Closed', 'Not a Fit')),
    'needs_enrichment', (select count(*) from public.dpl_properties p
                           where p.enrichment_status in ('pending', 'queued', 'partial', 'failed')
                             and p.workflow_status not in ('Closed', 'Not a Fit')),
    'outreach_ready', (select count(*) from public.dpl_properties p where p.workflow_status = 'Outreach Ready'),
    'multi_property_companies', (select count(*) from (
        select target_company_id from public.dpl_properties
         where target_company_id is not null and workflow_status not in ('Closed', 'Not a Fit')
         group by target_company_id having count(*) >= 2) x),
    'last_run', case when last_any.id is null then null else jsonb_build_object(
        'id', last_any.id, 'status', last_any.status, 'trigger', last_any.trigger,
        'started_at', last_any.started_at, 'finished_at', last_any.finished_at,
        'counts', last_any.counts, 'sources_failed', last_any.sources_failed,
        'sources_succeeded', last_any.sources_succeeded, 'errors', last_any.errors) end,
    'last_successful_run', case when last_ok.id is null then null else jsonb_build_object(
        'id', last_ok.id, 'finished_at', last_ok.finished_at, 'counts', last_ok.counts) end,
    'next_scheduled_run', v_next,
    'run_enabled', (select value from public.dpl_settings where key = 'run_enabled'),
    'source_errors', (select coalesce(jsonb_agg(jsonb_build_object(
        'source_id', s.source_id, 'label', s.label, 'county', s.county,
        'last_error', s.last_error, 'last_error_at', s.last_error_at,
        'last_success_at', s.last_success_at, 'consecutive_failures', s.consecutive_failures,
        'enabled', s.enabled, 'notes', s.notes)), '[]'::jsonb)
      from public.dpl_source_state s where s.last_error is not null or not s.enabled),
    'sources', (select coalesce(jsonb_agg(jsonb_build_object(
        'source_id', s.source_id, 'label', s.label, 'county', s.county, 'enabled', s.enabled,
        'last_success_at', s.last_success_at, 'last_error', s.last_error, 'notes', s.notes) order by s.county, s.source_id), '[]'::jsonb)
      from public.dpl_source_state s)
  );
end;
$$;
revoke all on function public.get_dpl_summary() from public, anon;
grant execute on function public.get_dpl_summary() to authenticated;

-- ---------- Cron schedule (UTC, DST-safe via dpl_scheduled_kick) ----------

do $$
declare j record;
begin
  for j in select jobid from cron.job where jobname in ('dpl-scheduled-1200utc', 'dpl-scheduled-1300utc', 'dpl-tick') loop
    perform cron.unschedule(j.jobid);
  end loop;
  -- 08:00 America/New_York is 12:00 UTC during daylight time (EDT, UTC-4)
  -- and 13:00 UTC during standard time (EST, UTC-5). Both fire; the
  -- function itself checks the Eastern hour so exactly one starts a run.
  perform cron.schedule('dpl-scheduled-1200utc', '0 12 * * 2,4', 'select public.dpl_scheduled_kick()');
  perform cron.schedule('dpl-scheduled-1300utc', '0 13 * * 2,4', 'select public.dpl_scheduled_kick()');
  -- Watchdog that resumes a run whose worker invocation ended early.
  perform cron.schedule('dpl-tick', '*/5 * * * *', 'select public.dpl_tick()');
end $$;
