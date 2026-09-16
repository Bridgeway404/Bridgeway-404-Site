-- ============================================================
-- Eviction Attorney Leads (eal_*) + pause of Distressed Leads
--
-- Part A — pause the Distressed Property Leads (dpl_*) pipeline.
--   Nothing is deleted. dpl_set_paused(true) unschedules the three
--   pg_cron jobs, sets dpl_settings.run_enabled = false and
--   dpl_settings.paused = true; dpl_request_run / dpl_submit_upload /
--   dpl_scheduled_kick / dpl_tick refuse to start work while paused, so
--   the worker is never invoked and no scoring / enrichment jobs are
--   created. To reactivate later:  select public.dpl_set_paused(false);
--
-- Part B — Eviction Attorney Leads: a manually-run research system that
--   builds Leslie's call list of plaintiff-side (landlord / property
--   management) dispossessory attorneys in metro Atlanta.
--   eal_attorneys      one row per attorney (or firm) lead — the call list
--   eal_activity       dated, attributed notes / status changes / contacts
--   eal_runs           one row per "Find More Attorneys" run (manual only;
--                      there is deliberately no cron schedule)
--   eal_jobs           work queue processed by the eviction-attorney-leads
--                      Edge Function
--   eal_settings       non-secret configuration
--   The Anthropic key is the same Vault secret the distressed pipeline
--   used (dpl_set_secret / dpl_secret_status / dpl_get_secret), and the
--   one-time worker tokens reuse dpl_invocations / dpl_claim_invocation.
-- ============================================================

-- ======================================================================
-- Part A: pause Distressed Property Leads (reversible)
-- ======================================================================

insert into public.dpl_settings (key, value) values ('paused', 'false')
on conflict (key) do nothing;

create or replace function public.dpl_is_paused()
returns boolean
language sql stable
set search_path = ''
as $$
  select coalesce((select value from public.dpl_settings where key = 'paused'), 'false') = 'true';
$$;
revoke all on function public.dpl_is_paused() from public, anon;
grant execute on function public.dpl_is_paused() to authenticated, service_role;

-- Pause / resume in one call: settings + cron schedule together, so the
-- two can never drift apart.
create or replace function public.dpl_set_paused(p_paused boolean)
returns text
language plpgsql security definer
set search_path = ''
as $$
declare j record;
begin
  if current_user not in ('postgres', 'supabase_admin') and not public.is_admin() then
    raise exception 'not authorized';
  end if;
  insert into public.dpl_settings (key, value, updated_at) values ('paused', case when p_paused then 'true' else 'false' end, now())
  on conflict (key) do update set value = excluded.value, updated_at = now();
  insert into public.dpl_settings (key, value, updated_at) values ('run_enabled', case when p_paused then 'false' else 'true' end, now())
  on conflict (key) do update set value = excluded.value, updated_at = now();
  for j in select jobid from cron.job where jobname in ('dpl-scheduled-1200utc', 'dpl-scheduled-1300utc', 'dpl-tick') loop
    perform cron.unschedule(j.jobid);
  end loop;
  if not p_paused then
    perform cron.schedule('dpl-scheduled-1200utc', '0 12 * * 2,4', 'select public.dpl_scheduled_kick()');
    perform cron.schedule('dpl-scheduled-1300utc', '0 13 * * 2,4', 'select public.dpl_scheduled_kick()');
    perform cron.schedule('dpl-tick', '*/5 * * * *', 'select public.dpl_tick()');
    return 'resumed';
  end if;
  return 'paused';
end;
$$;
revoke all on function public.dpl_set_paused(boolean) from public, anon;
grant execute on function public.dpl_set_paused(boolean) to authenticated;

-- Same bodies as 0006 with a pause guard at the top.
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
  if public.dpl_is_paused() then
    raise exception 'Distressed Property Leads research is paused. Run select public.dpl_set_paused(false) to reactivate it.';
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

create or replace function public.dpl_scheduled_kick()
returns text
language plpgsql security definer
set search_path = ''
as $$
declare
  v_local timestamp := (now() at time zone 'America/New_York');
  v_enabled text;
begin
  if public.dpl_is_paused() then
    return 'paused';
  end if;
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

create or replace function public.dpl_tick()
returns text
language plpgsql security definer
set search_path = ''
as $$
begin
  if public.dpl_is_paused() then
    return 'paused';
  end if;
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
  if public.dpl_is_paused() then
    raise exception 'Distressed Property Leads research is paused; uploads are not processed until it is reactivated.';
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

-- Pause now. (Reactivate later with: select public.dpl_set_paused(false);)
select public.dpl_set_paused(true);

-- ======================================================================
-- Part B: Eviction Attorney Leads
-- ======================================================================

-- ---------- Settings ----------

create table if not exists public.eal_settings (
  key        text primary key,
  value      text,
  updated_at timestamptz not null default now()
);

insert into public.eal_settings (key, value) values
  ('functions_url', 'https://ctqdnphsvkbgegdtsmwb.supabase.co/functions/v1/eviction-attorney-leads'),
  -- Public anon key (also shipped in admin/assets/config.js); it only lets
  -- pg_net pass the Edge Function gateway. The worker separately validates
  -- a one-time token before doing anything.
  ('anon_key', (select value from public.dpl_settings where key = 'anon_key')),
  ('ai_model_research', 'claude-opus-5'),
  ('ai_model_enrich', 'claude-sonnet-5'),
  ('counties', 'Fulton,DeKalb,Gwinnett,Cobb,Clayton,Douglas,Henry'),
  ('web_passes_per_run', '2'),
  ('max_new_leads_per_run', '30'),
  ('max_enrich_per_run', '15'),
  ('min_court_filings', '2')
on conflict (key) do nothing;

-- ---------- Runs & jobs ----------

create table if not exists public.eal_runs (
  id           uuid primary key default gen_random_uuid(),
  trigger      text not null default 'manual' check (trigger in ('manual')),
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
create index if not exists eal_runs_created_idx on public.eal_runs (created_at desc);

create table if not exists public.eal_jobs (
  id          uuid primary key default gen_random_uuid(),
  run_id      uuid references public.eal_runs (id) on delete cascade,
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
create index if not exists eal_jobs_queue_idx on public.eal_jobs (status, priority, created_at);

-- ---------- Normalization helpers (dedupe keys) ----------

create or replace function public.eal_name_key(p text)
returns text
language sql immutable
set search_path = ''
as $$
  -- "J. Mike Williams, Esq." -> "jmikewilliams"; honorifics and suffixes dropped
  select regexp_replace(
           regexp_replace(lower(coalesce(p, '')),
             '\m(esq|esquire|attorney at law|attorney|jr|sr|ii|iii|iv|mr|mrs|ms|dr)\M\.?', '', 'g'),
           '[^a-z0-9]', '', 'g');
$$;

create or replace function public.eal_firm_key(p text)
returns text
language sql immutable
set search_path = ''
as $$
  -- "The Williams Law Firm, LLC" -> "williamslawfirm"
  select regexp_replace(
           regexp_replace(lower(coalesce(p, '')),
             '\m(the|llc|l\.l\.c|pc|p\.c|llp|l\.l\.p|pllc|pa|p\.a|inc|ltd|co|and associates|& associates|associates|attorneys at law|attorney at law|law offices? of|law offices?|law group|law firm|law)\M\.?', ' ', 'g'),
           '[^a-z0-9]', '', 'g');
$$;

create or replace function public.eal_phone_key(p text)
returns text
language sql immutable
set search_path = ''
as $$
  select case
    when length(regexp_replace(coalesce(p, ''), '[^0-9]', '', 'g')) >= 10
      then right(regexp_replace(coalesce(p, ''), '[^0-9]', '', 'g'), 10)
    else '' end;
$$;

create or replace function public.eal_host_key(p text)
returns text
language sql immutable
set search_path = ''
as $$
  -- "https://www.Firm.com/attorneys/x" -> "firm.com"
  select regexp_replace(regexp_replace(regexp_replace(lower(btrim(coalesce(p, ''))), '^[a-z]+://', ''), '^www\.', ''), '[/?#].*$', '');
$$;

-- ---------- The call list ----------

create table if not exists public.eal_attorneys (
  id                 uuid primary key default gen_random_uuid(),
  attorney_name      text,
  firm_name          text,
  name_key           text generated always as (public.eal_name_key(attorney_name)) stored,
  firm_key           text generated always as (public.eal_firm_key(firm_name)) stored,
  phone              text,
  phone_key          text generated always as (public.eal_phone_key(phone)) stored,
  email              text,
  email_key          text generated always as (lower(btrim(coalesce(email, '')))) stored,
  website            text,
  website_key        text generated always as (public.eal_host_key(website)) stored,
  city               text,
  county             text,
  counties           text[] not null default '{}',
  practice_area      text,
  clients_identified text,
  evidence           text,
  source_url         text,
  source_urls        text[] not null default '{}',
  source_kind        text not null default 'manual'
                     check (source_kind in ('court_records', 'web_research', 'manual', 'import')),
  filing_count       int not null default 0,
  plaintiff_count    int not null default 0,
  confidence         text check (confidence in ('high', 'medium', 'low')),
  referral_potential text check (referral_potential in ('high', 'medium', 'low')),
  enrichment_status  text not null default 'skipped'
                     check (enrichment_status in ('pending', 'done', 'failed', 'skipped')),
  research_notes     text,
  -- Leslie's workflow
  contact_status     text not null default 'New' check (contact_status in (
                       'New', 'Call Today', 'Called – No Answer', 'Left Voicemail', 'Spoke With Staff',
                       'Spoke With Attorney', 'Interested', 'Follow Up', 'Referral Partner',
                       'Not Interested', 'Bad Lead')),
  status_changed_at  timestamptz,
  status_changed_by  uuid references public.admin_users (user_id),
  last_contacted_at  timestamptz,
  follow_up_date     date,
  notes              text,
  assigned_to        text,
  created_by         uuid references public.admin_users (user_id),
  run_id             uuid references public.eal_runs (id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  check (coalesce(btrim(attorney_name), '') <> '' or coalesce(btrim(firm_name), '') <> '')
);
-- One row per attorney name; firms without a named attorney are unique by firm.
create unique index if not exists eal_attorneys_name_uidx on public.eal_attorneys (name_key) where name_key <> '';
create unique index if not exists eal_attorneys_firm_only_uidx on public.eal_attorneys (firm_key) where name_key = '' and firm_key <> '';
create index if not exists eal_attorneys_phone_idx on public.eal_attorneys (phone_key) where phone_key <> '';
create index if not exists eal_attorneys_email_idx on public.eal_attorneys (email_key) where email_key <> '';
create index if not exists eal_attorneys_status_idx on public.eal_attorneys (contact_status, created_at desc);
create index if not exists eal_attorneys_follow_idx on public.eal_attorneys (follow_up_date);

create table if not exists public.eal_activity (
  id          uuid primary key default gen_random_uuid(),
  attorney_id uuid not null references public.eal_attorneys (id) on delete cascade,
  kind        text not null check (kind in ('note', 'status_change', 'contact', 'assignment', 'follow_up', 'system')),
  from_status text,
  to_status   text,
  note        text,
  user_id     uuid references public.admin_users (user_id),
  created_at  timestamptz not null default now()
);
create index if not exists eal_activity_attorney_idx on public.eal_activity (attorney_id, created_at desc);

do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'eal_attorneys_touch') then
    create trigger eal_attorneys_touch before update on public.eal_attorneys
      for each row execute function public.touch_updated_at();
  end if;
end $$;

-- ---------- Row-level security (admin allowlist only) ----------

alter table public.eal_settings  enable row level security;
alter table public.eal_runs      enable row level security;
alter table public.eal_jobs      enable row level security;
alter table public.eal_attorneys enable row level security;
alter table public.eal_activity  enable row level security;

do $$
declare t text;
begin
  foreach t in array array['eal_settings', 'eal_runs', 'eal_jobs', 'eal_attorneys', 'eal_activity'] loop
    execute format('drop policy if exists %I_select on public.%I', t, t);
    execute format('create policy %I_select on public.%I for select to authenticated using (public.is_admin())', t, t);
  end loop;
end $$;

drop policy if exists eal_settings_update on public.eal_settings;
create policy eal_settings_update on public.eal_settings
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists eal_attorneys_insert on public.eal_attorneys;
create policy eal_attorneys_insert on public.eal_attorneys
  for insert to authenticated with check (public.is_admin());
drop policy if exists eal_attorneys_update on public.eal_attorneys;
create policy eal_attorneys_update on public.eal_attorneys
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists eal_attorneys_delete on public.eal_attorneys;
create policy eal_attorneys_delete on public.eal_attorneys
  for delete to authenticated using (public.is_admin());
drop policy if exists eal_activity_insert on public.eal_activity;
create policy eal_activity_insert on public.eal_activity
  for insert to authenticated with check (public.is_admin() and user_id = auth.uid());

-- ---------- Dedupe + insert / merge ----------

-- Find an existing lead that the candidate duplicates. Rules, in order:
--   1. same attorney name
--   2. same email, unless it is a shared firm mailbox (info@, office@ …) and
--      both sides have different attorney names
--   3. same phone number and one side has no attorney name (two named
--      attorneys sharing a firm's main line are colleagues, not duplicates)
--   4. same website and same firm and one side has no attorney name
--   5. same firm and neither side has an attorney name (firm-level lead)
create or replace function public.eal_find_duplicate(p_attorney text, p_firm text, p_phone text, p_email text, p_website text,
                                                     out o_id uuid, out o_matched_on text)
language plpgsql stable
set search_path = ''
as $$
declare
  k_name text := public.eal_name_key(p_attorney);
  k_firm text := public.eal_firm_key(p_firm);
  k_phone text := public.eal_phone_key(p_phone);
  k_email text := lower(btrim(coalesce(p_email, '')));
  k_host text := public.eal_host_key(p_website);
  generic boolean := k_email ~ '^(info|office|contact|admin|intake|hello|mail|frontdesk|reception|billing|support|legal|law)@';
begin
  o_id := null; o_matched_on := null;
  if k_name <> '' then
    select id into o_id from public.eal_attorneys where name_key = k_name limit 1;
    if o_id is not null then o_matched_on := 'attorney name'; return; end if;
  end if;
  if k_email <> '' then
    select id into o_id from public.eal_attorneys a
     where a.email_key = k_email
       and (not generic or k_name = '' or a.name_key = '' or a.name_key = k_name)
     limit 1;
    if o_id is not null then o_matched_on := 'email'; return; end if;
  end if;
  if k_phone <> '' then
    select id into o_id from public.eal_attorneys a
     where a.phone_key = k_phone
       and (k_name = '' or a.name_key = '')
     limit 1;
    if o_id is not null then o_matched_on := 'phone number'; return; end if;
  end if;
  if k_host <> '' and k_firm <> '' then
    select id into o_id from public.eal_attorneys a
     where a.website_key = k_host and a.firm_key = k_firm and (k_name = '' or a.name_key = '')
     limit 1;
    if o_id is not null then o_matched_on := 'website'; return; end if;
  end if;
  if k_firm <> '' and k_name = '' then
    select id into o_id from public.eal_attorneys a where a.firm_key = k_firm and a.name_key = '' limit 1;
    if o_id is not null then o_matched_on := 'law firm'; return; end if;
  end if;
end;
$$;
revoke all on function public.eal_find_duplicate(text, text, text, text, text) from public, anon;
grant execute on function public.eal_find_duplicate(text, text, text, text, text) to authenticated, service_role;

-- Insert a lead, or merge it into the duplicate it matches. Merging never
-- erases data and never touches the workflow fields (status, notes,
-- follow-up, assignment, contact history). Returns
--   { action: 'inserted' | 'merged', id, matched_on }.
create or replace function public.eal_upsert_lead(p jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_name text := nullif(btrim(coalesce(p->>'attorney_name', '')), '');
  v_firm text := nullif(btrim(coalesce(p->>'firm_name', '')), '');
  v_phone text := nullif(btrim(coalesce(p->>'phone', '')), '');
  v_email text := nullif(lower(btrim(coalesce(p->>'email', ''))), '');
  v_web text := nullif(btrim(coalesce(p->>'website', '')), '');
  v_counties text[];
  v_sources text[];
  v_dup uuid; v_on text;
  v_id uuid;
  v_kind text := coalesce(nullif(p->>'source_kind', ''), 'manual');
  v_conf text := nullif(p->>'confidence', '');
  v_ref text := nullif(p->>'referral_potential', '');
  v_uid uuid := auth.uid();
  ex public.eal_attorneys;
begin
  if current_user not in ('postgres', 'supabase_admin', 'service_role') and not public.is_admin() then
    raise exception 'not authorized';
  end if;
  if v_name is null and v_firm is null then
    raise exception 'attorney name or law firm is required';
  end if;
  if v_name is not null and public.eal_name_key(v_name) = '' then
    raise exception 'attorney name must contain letters';
  end if;
  if v_kind not in ('court_records', 'web_research', 'manual', 'import') then v_kind := 'manual'; end if;
  if v_conf not in ('high', 'medium', 'low') then v_conf := null; end if;
  if v_ref not in ('high', 'medium', 'low') then v_ref := null; end if;
  if v_web is not null and v_web !~* '^[a-z]+://' then v_web := 'https://' || v_web; end if;

  select coalesce(array_agg(x), '{}') into v_counties
    from (select distinct btrim(value #>> '{}') as x from jsonb_array_elements(case when jsonb_typeof(p->'counties') = 'array' then p->'counties' else '[]'::jsonb end)) s
   where x <> '';
  if p->>'county' is not null and btrim(p->>'county') <> '' and not (btrim(p->>'county') = any (v_counties)) then
    v_counties := v_counties || btrim(p->>'county');
  end if;
  select coalesce(array_agg(x), '{}') into v_sources
    from (select distinct btrim(value #>> '{}') as x from jsonb_array_elements(case when jsonb_typeof(p->'source_urls') = 'array' then p->'source_urls' else '[]'::jsonb end)) s
   where x <> '';
  if p->>'source_url' is not null and btrim(p->>'source_url') <> '' and not (btrim(p->>'source_url') = any (v_sources)) then
    v_sources := v_sources || btrim(p->>'source_url');
  end if;

  select o_id, o_matched_on into v_dup, v_on from public.eal_find_duplicate(v_name, v_firm, v_phone, v_email, v_web);

  if v_dup is null then
    insert into public.eal_attorneys (attorney_name, firm_name, phone, email, website, city, county, counties,
      practice_area, clients_identified, evidence, source_url, source_urls, source_kind, filing_count, plaintiff_count,
      confidence, referral_potential, enrichment_status, research_notes, created_by, run_id)
    values (v_name, v_firm, v_phone, v_email, v_web,
      nullif(btrim(coalesce(p->>'city', '')), ''), nullif(btrim(coalesce(p->>'county', '')), ''), v_counties,
      nullif(btrim(coalesce(p->>'practice_area', '')), ''), nullif(btrim(coalesce(p->>'clients_identified', '')), ''),
      nullif(btrim(coalesce(p->>'evidence', '')), ''), nullif(btrim(coalesce(p->>'source_url', '')), ''), v_sources, v_kind,
      coalesce(nullif(p->>'filing_count', '')::int, 0), coalesce(nullif(p->>'plaintiff_count', '')::int, 0),
      v_conf, v_ref, coalesce(nullif(p->>'enrichment_status', ''), 'skipped'), nullif(btrim(coalesce(p->>'research_notes', '')), ''),
      case when v_uid is not null and public.is_admin() then v_uid else null end,
      nullif(p->>'run_id', '')::uuid)
    returning id into v_id;
    return jsonb_build_object('action', 'inserted', 'id', v_id, 'matched_on', null);
  end if;

  select * into ex from public.eal_attorneys where id = v_dup;
  update public.eal_attorneys set
    attorney_name = coalesce(ex.attorney_name, v_name),
    firm_name = coalesce(ex.firm_name, v_firm),
    phone = coalesce(ex.phone, v_phone),
    email = coalesce(ex.email, v_email),
    website = coalesce(ex.website, v_web),
    city = coalesce(ex.city, nullif(btrim(coalesce(p->>'city', '')), '')),
    county = coalesce(ex.county, nullif(btrim(coalesce(p->>'county', '')), '')),
    counties = (select coalesce(array_agg(distinct c), '{}') from unnest(ex.counties || v_counties) c),
    practice_area = coalesce(ex.practice_area, nullif(btrim(coalesce(p->>'practice_area', '')), '')),
    clients_identified = case
      when ex.clients_identified is null then nullif(btrim(coalesce(p->>'clients_identified', '')), '')
      when nullif(btrim(coalesce(p->>'clients_identified', '')), '') is null then ex.clients_identified
      when position(lower(btrim(p->>'clients_identified')) in lower(ex.clients_identified)) > 0 then ex.clients_identified
      else ex.clients_identified || '; ' || btrim(p->>'clients_identified') end,
    evidence = case
      when ex.evidence is null then nullif(btrim(coalesce(p->>'evidence', '')), '')
      when nullif(btrim(coalesce(p->>'evidence', '')), '') is null then ex.evidence
      when position(lower(btrim(p->>'evidence')) in lower(ex.evidence)) > 0 then ex.evidence
      else ex.evidence || E'\n\n' || btrim(p->>'evidence') end,
    source_url = coalesce(ex.source_url, nullif(btrim(coalesce(p->>'source_url', '')), '')),
    source_urls = (select coalesce(array_agg(distinct u), '{}') from unnest(ex.source_urls || v_sources) u),
    filing_count = greatest(ex.filing_count, coalesce(nullif(p->>'filing_count', '')::int, 0)),
    plaintiff_count = greatest(ex.plaintiff_count, coalesce(nullif(p->>'plaintiff_count', '')::int, 0)),
    confidence = case
      when ex.confidence = 'high' or v_conf = 'high' then 'high'
      when ex.confidence = 'medium' or v_conf = 'medium' then 'medium'
      else coalesce(ex.confidence, v_conf) end,
    referral_potential = case
      when ex.referral_potential = 'high' or v_ref = 'high' then 'high'
      when ex.referral_potential = 'medium' or v_ref = 'medium' then 'medium'
      else coalesce(ex.referral_potential, v_ref) end,
    research_notes = coalesce(ex.research_notes, nullif(btrim(coalesce(p->>'research_notes', '')), '')),
    -- a court-records seed row that later gets web details, or vice versa
    source_kind = case when ex.source_kind = 'court_records' or v_kind = 'court_records' then 'court_records' else ex.source_kind end,
    enrichment_status = case when nullif(p->>'enrichment_status', '') is not null then p->>'enrichment_status' else ex.enrichment_status end
  where id = v_dup;
  return jsonb_build_object('action', 'merged', 'id', v_dup, 'matched_on', v_on);
end;
$$;
revoke all on function public.eal_upsert_lead(jsonb) from public, anon;
grant execute on function public.eal_upsert_lead(jsonb) to authenticated, service_role;

-- ---------- Leslie's workflow ----------

-- One call for everything the call list edits. p_patch may carry any of:
--   contact_status, mark_contacted (true), follow_up_date, assigned_to, notes,
--   attorney_name, firm_name, phone, email, website, city, county, counties,
--   practice_area, clients_identified, evidence, source_url, referral_potential
-- Status, assignment, follow-up and contact changes are written to the
-- activity history with who did it and when.
create or replace function public.eal_update_lead(p_id uuid, p_patch jsonb)
returns void
language plpgsql
set search_path = ''
as $$
declare
  a public.eal_attorneys;
  v_status text;
  v_follow date;
  v_assign text;
  v_note text := nullif(btrim(coalesce(p_patch->>'note', '')), '');
  v_counties text[];
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;
  select * into a from public.eal_attorneys where id = p_id;
  if a.id is null then
    raise exception 'lead not found';
  end if;

  -- Plain field edits (blank = clear).
  begin
  update public.eal_attorneys set
    attorney_name = case when p_patch ? 'attorney_name' then nullif(btrim(p_patch->>'attorney_name'), '') else attorney_name end,
    firm_name = case when p_patch ? 'firm_name' then nullif(btrim(p_patch->>'firm_name'), '') else firm_name end,
    phone = case when p_patch ? 'phone' then nullif(btrim(p_patch->>'phone'), '') else phone end,
    email = case when p_patch ? 'email' then nullif(lower(btrim(p_patch->>'email')), '') else email end,
    website = case when p_patch ? 'website' then nullif(btrim(p_patch->>'website'), '') else website end,
    city = case when p_patch ? 'city' then nullif(btrim(p_patch->>'city'), '') else city end,
    county = case when p_patch ? 'county' then nullif(btrim(p_patch->>'county'), '') else county end,
    practice_area = case when p_patch ? 'practice_area' then nullif(btrim(p_patch->>'practice_area'), '') else practice_area end,
    clients_identified = case when p_patch ? 'clients_identified' then nullif(btrim(p_patch->>'clients_identified'), '') else clients_identified end,
    evidence = case when p_patch ? 'evidence' then nullif(btrim(p_patch->>'evidence'), '') else evidence end,
    source_url = case when p_patch ? 'source_url' then nullif(btrim(p_patch->>'source_url'), '') else source_url end,
    notes = case when p_patch ? 'notes' then nullif(btrim(p_patch->>'notes'), '') else notes end,
    referral_potential = case when p_patch ? 'referral_potential' and nullif(p_patch->>'referral_potential', '') in ('high', 'medium', 'low') then p_patch->>'referral_potential'
                              when p_patch ? 'referral_potential' then null else referral_potential end
  where id = p_id;
  exception when unique_violation then
    raise exception 'Another lead already has that attorney name or firm.';
  end;

  if jsonb_typeof(p_patch->'counties') = 'array' then
    select coalesce(array_agg(x), '{}') into v_counties
      from (select distinct btrim(value #>> '{}') as x from jsonb_array_elements(p_patch->'counties')) s where x <> '';
    update public.eal_attorneys set counties = v_counties where id = p_id;
  end if;

  if p_patch ? 'contact_status' then
    v_status := p_patch->>'contact_status';
    if v_status is distinct from a.contact_status then
      update public.eal_attorneys
         set contact_status = v_status, status_changed_at = now(), status_changed_by = auth.uid()
       where id = p_id;
      insert into public.eal_activity (attorney_id, kind, from_status, to_status, note, user_id)
      values (p_id, 'status_change', a.contact_status, v_status, v_note, auth.uid());
      v_note := null;
    end if;
  end if;

  -- A contact without a typed note is logged with a null note, so the
  -- "latest note" shown on the call list stays the last thing a person wrote.
  if coalesce((p_patch->>'mark_contacted')::boolean, false) then
    update public.eal_attorneys set last_contacted_at = now() where id = p_id;
    insert into public.eal_activity (attorney_id, kind, note, user_id)
    values (p_id, 'contact', v_note, auth.uid());
    v_note := null;
  end if;

  if p_patch ? 'follow_up_date' then
    v_follow := nullif(btrim(coalesce(p_patch->>'follow_up_date', '')), '')::date;
    if v_follow is distinct from a.follow_up_date then
      update public.eal_attorneys set follow_up_date = v_follow where id = p_id;
      insert into public.eal_activity (attorney_id, kind, note, user_id)
      values (p_id, 'follow_up', case when v_follow is null then 'Follow-up date cleared' else 'Follow up on ' || to_char(v_follow, 'Mon DD, YYYY') end, auth.uid());
    end if;
  end if;

  if p_patch ? 'assigned_to' then
    v_assign := nullif(btrim(coalesce(p_patch->>'assigned_to', '')), '');
    if v_assign is distinct from a.assigned_to then
      update public.eal_attorneys set assigned_to = v_assign where id = p_id;
      insert into public.eal_activity (attorney_id, kind, note, user_id)
      values (p_id, 'assignment', case when v_assign is null then 'Unassigned' else 'Assigned to ' || v_assign end, auth.uid());
    end if;
  end if;

  if v_note is not null then
    insert into public.eal_activity (attorney_id, kind, note, user_id) values (p_id, 'note', v_note, auth.uid());
  end if;
end;
$$;
revoke all on function public.eal_update_lead(uuid, jsonb) from public, anon;
grant execute on function public.eal_update_lead(uuid, jsonb) to authenticated;

create or replace function public.eal_add_note(p_id uuid, p_note text)
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
  if not exists (select 1 from public.eal_attorneys where id = p_id) then
    raise exception 'lead not found';
  end if;
  insert into public.eal_activity (attorney_id, kind, note, user_id) values (p_id, 'note', v_note, auth.uid());
end;
$$;
revoke all on function public.eal_add_note(uuid, text) from public, anon;
grant execute on function public.eal_add_note(uuid, text) to authenticated;

-- ---------- Court-record evidence (from the calendars already harvested) ----------

-- Plaintiff-side attorneys named on the dispossessory calendars the
-- distressed pipeline collected, with how many cases they filed and for
-- whom. Lenders, servicers, government agencies and individuals are not
-- counted as landlord / property-management clients. Used by the worker
-- (service role) and readable by admins.
create or replace function public.eal_court_record_stats(p_min_filings int default 1)
returns table (
  attorney text, county text, filings int, plaintiffs int, business_plaintiffs int,
  top_plaintiffs text[], first_hearing date, last_hearing date, source_urls text[]
)
language sql stable security definer
set search_path = ''
as $$
  with ev as (
    select e.law_firm, e.county, e.plaintiff_name, e.hearing_date, e.source_url,
           regexp_replace(lower(coalesce(e.plaintiff_name, '')), '[^a-z0-9]', '', 'g') as pkey
      from public.dpl_events e
     where e.event_type = 'eviction' and coalesce(btrim(e.law_firm), '') <> ''
  ),
  ev2 as (
    select ev.*, c.is_individual, c.company_type,
           (c.id is not null and not c.is_individual
              and c.company_type not in ('lender', 'servicer', 'government', 'individual', 'law_firm', 'nonprofit')) as is_business
      from ev left join public.dpl_companies c on c.name_key = ev.pkey
  ),
  per_plaintiff as (
    select law_firm, county, pkey, min(plaintiff_name) as plaintiff_name, bool_or(is_business) as is_business, count(*)::int as n
      from ev2 group by law_firm, county, pkey
  )
  select g.law_firm as attorney, g.county,
         g.filings, g.plaintiffs, g.business_plaintiffs,
         (select coalesce(array_agg(pp.plaintiff_name || ' (' || pp.n || ')' order by pp.n desc, pp.plaintiff_name), '{}')
            from (select * from per_plaintiff pp2 where pp2.law_firm = g.law_firm and pp2.county = g.county and pp2.is_business
                   order by pp2.n desc, pp2.plaintiff_name limit 8) pp) as top_plaintiffs,
         g.first_hearing, g.last_hearing,
         (select coalesce(array_agg(u), '{}') from (select distinct s.source_url as u from ev2 s
             where s.law_firm = g.law_firm and s.county = g.county and s.source_url is not null
             order by s.source_url limit 3) x) as source_urls
    from (
      select law_firm, county, count(*)::int as filings,
             count(distinct pkey)::int as plaintiffs,
             count(distinct pkey) filter (where is_business)::int as business_plaintiffs,
             min(hearing_date) as first_hearing, max(hearing_date) as last_hearing
        from ev2 group by law_firm, county
    ) g
   -- security definer: current_user is the owner here, so gate on the JWT
   -- instead (service role / cron have no uid; a signed-in caller must be an admin)
   where (auth.uid() is null or public.is_admin())
     and g.filings >= p_min_filings
   order by g.filings desc, g.law_firm;
$$;
revoke all on function public.eal_court_record_stats(int) from public, anon;
grant execute on function public.eal_court_record_stats(int) to authenticated, service_role;

-- ---------- Worker invocation & manual runs ----------

-- Fire the Edge Function through pg_net with a one-time token (tokens live
-- in dpl_invocations and are claimed with dpl_claim_invocation, exactly as
-- the distressed worker does).
create or replace function public.eal_invoke_worker(p_purpose text)
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
  select value into v_url from public.eal_settings where key = 'functions_url';
  select value into v_key from public.eal_settings where key = 'anon_key';
  if v_url is null or v_key is null then
    raise exception 'eal_settings functions_url / anon_key missing';
  end if;
  insert into public.dpl_invocations (purpose) values ('eal:' || p_purpose) returning token into v_token;
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
revoke all on function public.eal_invoke_worker(text) from public, anon, authenticated;
grant execute on function public.eal_invoke_worker(text) to service_role;

-- "Find More Attorneys": create a run and wake the worker. Manual only —
-- nothing schedules this. p_options: { counties: [...], web_passes: n,
-- court_records: bool, focus: 'text' }.
create or replace function public.eal_request_run(p_options jsonb default '{}'::jsonb)
returns uuid
language plpgsql security definer
set search_path = ''
as $$
declare
  v_run uuid;
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;
  -- A run whose worker stopped checking in is abandoned, not blocking.
  update public.eal_runs set status = 'failed', finished_at = now(),
         errors = errors || jsonb_build_array(jsonb_build_object('at', now(), 'error', 'abandoned: no heartbeat for 10 minutes'))
   where status in ('queued', 'running') and coalesce(heartbeat_at, created_at) < now() - interval '10 minutes';
  update public.eal_jobs set status = 'failed', last_error = 'run abandoned', finished_at = now()
   where status in ('queued', 'running') and run_id in (select id from public.eal_runs where status = 'failed');
  if exists (select 1 from public.eal_runs where status in ('queued', 'running')) then
    raise exception 'a research run is already in progress';
  end if;
  insert into public.eal_runs (trigger, requested_by, options)
  values ('manual', auth.uid(), coalesce(p_options, '{}'::jsonb))
  returning id into v_run;
  insert into public.eal_jobs (run_id, kind, priority, payload)
  values (v_run, 'run.start', 0, jsonb_build_object('run_id', v_run));
  perform public.eal_invoke_worker('run');
  return v_run;
end;
$$;
revoke all on function public.eal_request_run(jsonb) from public, anon;
grant execute on function public.eal_request_run(jsonb) to authenticated;

-- Wake the worker again for a run that is still queued/running but whose
-- invocation chain broke (e.g. the isolate was recycled). Manual, from the
-- Admin page; no cron.
create or replace function public.eal_resume_run()
returns text
language plpgsql security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;
  if not exists (select 1 from public.eal_jobs where status = 'queued') then
    return 'nothing queued';
  end if;
  if exists (select 1 from public.eal_runs where status = 'running' and heartbeat_at > now() - interval '2 minutes') then
    return 'busy';
  end if;
  update public.eal_jobs set status = 'queued' where status = 'running' and started_at < now() - interval '10 minutes';
  perform public.eal_invoke_worker('resume');
  return 'invoked';
end;
$$;
revoke all on function public.eal_resume_run() from public, anon;
grant execute on function public.eal_resume_run() to authenticated;

-- ---------- Views ----------

drop view if exists public.eal_lead_list;
create view public.eal_lead_list
with (security_invoker = true) as
select
  a.id, a.attorney_name, a.firm_name, a.phone, a.email, a.website, a.city, a.county, a.counties,
  a.practice_area, a.clients_identified, a.evidence, a.source_url, a.source_urls, a.source_kind,
  a.filing_count, a.plaintiff_count, a.confidence, a.referral_potential, a.enrichment_status, a.research_notes,
  a.contact_status, a.status_changed_at, a.last_contacted_at, a.follow_up_date, a.notes, a.assigned_to,
  a.run_id, a.created_at, a.updated_at,
  cb.display_name as created_by_name,
  (select count(*) from public.eal_activity x where x.attorney_id = a.id and x.kind = 'note')::int as note_count,
  (select max(x.created_at) from public.eal_activity x where x.attorney_id = a.id) as last_activity_at,
  ln.note as last_note, ln.created_at as last_note_at, ln.display_name as last_note_by
from public.eal_attorneys a
left join public.admin_users cb on cb.user_id = a.created_by
left join lateral (
  select x.note, x.created_at, au.display_name
    from public.eal_activity x left join public.admin_users au on au.user_id = x.user_id
   where x.attorney_id = a.id and x.note is not null and x.kind in ('note', 'contact', 'status_change')
   order by x.created_at desc limit 1
) ln on true;
grant select on public.eal_lead_list to authenticated;

drop view if exists public.eal_activity_view;
create view public.eal_activity_view
with (security_invoker = true) as
select x.id, x.attorney_id, x.kind, x.from_status, x.to_status, x.note, x.created_at, au.display_name
from public.eal_activity x
left join public.admin_users au on au.user_id = x.user_id;
grant select on public.eal_activity_view to authenticated;

-- Dashboard numbers in one call.
create or replace function public.eal_summary()
returns jsonb
language plpgsql stable
set search_path = ''
as $$
declare
  last_any public.eal_runs;
  v_today date := (now() at time zone 'America/New_York')::date;
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;
  select * into last_any from public.eal_runs order by created_at desc limit 1;
  return jsonb_build_object(
    'total', (select count(*) from public.eal_attorneys),
    'active', (select count(*) from public.eal_attorneys where contact_status not in ('Not Interested', 'Bad Lead')),
    'call_today', (select count(*) from public.eal_attorneys where contact_status = 'Call Today'),
    'new', (select count(*) from public.eal_attorneys where contact_status = 'New'),
    'follow_ups_due', (select count(*) from public.eal_attorneys
                        where follow_up_date <= v_today and contact_status not in ('Not Interested', 'Bad Lead')),
    'needs_phone', (select count(*) from public.eal_attorneys
                     where phone is null and contact_status not in ('Not Interested', 'Bad Lead')),
    'by_status', (select coalesce(jsonb_object_agg(s.contact_status, s.n), '{}'::jsonb)
                    from (select contact_status, count(*) as n from public.eal_attorneys group by contact_status) s),
    'court_attorneys_available', (select count(*) from public.eal_court_record_stats(1)),
    'last_run', case when last_any.id is null then null else jsonb_build_object(
        'id', last_any.id, 'status', last_any.status, 'started_at', last_any.started_at,
        'finished_at', last_any.finished_at, 'heartbeat_at', last_any.heartbeat_at,
        'counts', last_any.counts, 'log', last_any.log, 'errors', last_any.errors, 'options', last_any.options) end,
    'queued_jobs', (select count(*) from public.eal_jobs where status = 'queued'),
    'has_ai_key', coalesce((public.dpl_secret_status()->>'anthropic_api_key')::boolean, false)
  );
end;
$$;
revoke all on function public.eal_summary() from public, anon;
grant execute on function public.eal_summary() to authenticated;
