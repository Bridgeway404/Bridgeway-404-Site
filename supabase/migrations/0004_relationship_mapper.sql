-- ============================================================
-- Relationship Mapper — warm-path discovery over Michael's
-- real-world network (Instagram/Meta export, synced contacts,
-- future sources).
--
-- Design notes:
--   * People/signals are SOURCE-AGNOSTIC: Instagram is one source
--     among several (contacts, future LinkedIn/Facebook/email).
--     Each person has a stable person_key computed by the importer;
--     signals carry provenance (source + import batch).
--   * Imports are idempotent and non-destructive: re-importing a
--     newer export refreshes signal-derived fields but never
--     touches manual research (company, title, notes, statuses).
--   * Privacy: phone numbers are matching/contact signals, not
--     dashboard content. All tables are RLS admin-allowlist only,
--     same model as prospects. Whole-dataset and per-person
--     deletion are first-class (rm_delete_import / cascade).
-- ============================================================

-- ---------- Tables ----------

-- One row per import batch (e.g. one connections.zip upload).
create table public.rm_imports (
  id           uuid primary key default gen_random_uuid(),
  source       text not null,               -- 'instagram_meta_export', 'research_csv', ...
  label        text not null,               -- e.g. 'connections.zip Aug 30, 2026'
  counts       jsonb not null default '{}'::jsonb,
  imported_by  uuid references public.admin_users (user_id),
  created_at   timestamptz not null default now()
);

create table public.rm_people (
  id             uuid primary key default gen_random_uuid(),
  -- Stable identity key computed by the importer:
  --   'ig:<username>' for Instagram identities,
  --   'ct:<normalized first>:<normalized last>' for contact-only people.
  person_key     text unique not null,
  first_name     text,
  last_name      text,
  display_name   text,
  ig_username    text,
  ig_url         text,
  phone          text,      -- contact/matching signal; shown only in detail view
  email          text,
  -- Identity resolution: how sure are we the merged sources are one person?
  identity_confidence text not null default 'unknown'
    check (identity_confidence in ('confirmed','high','medium','low','unknown')),
  -- Signal-derived (recomputed on import):
  relationship_strength int not null default 0,
  -- Manual research fields (never overwritten by imports):
  company        text,
  title          text,
  industry       text,
  location       text,
  relevance_tier int check (relevance_tier between 1 and 3),  -- 1 = PM/multifamily core
  opportunity_score int not null default 0 check (opportunity_score between 0 and 100),
  research_confidence text not null default 'unknown'
    check (research_confidence in ('confirmed','high','medium','low','unknown')),
  why_matters    text,
  recommended_action text,
  action_status  text not null default 'New'
    check (action_status in ('New','Research','Reach Out','Ask for Intro','Contacted',
                             'Follow Up','Opportunity Created','Not Relevant','Do Not Contact')),
  action_priority text not null default 'Medium'
    check (action_priority in ('Critical','High','Medium','Low')),
  next_action_date date,
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index rm_people_username_idx on public.rm_people (ig_username);
create index rm_people_strength_idx on public.rm_people (relationship_strength desc);
create index rm_people_queue_idx on public.rm_people (action_status, action_priority, next_action_date);

-- Relationship evidence with provenance. Rebuilt per import batch.
create table public.rm_signals (
  id          uuid primary key default gen_random_uuid(),
  person_id   uuid not null references public.rm_people (id) on delete cascade,
  import_id   uuid references public.rm_imports (id) on delete cascade,
  source      text not null,               -- 'instagram', 'contacts', 'manual', ...
  signal_type text not null,               -- 'mutual_follow', 'synced_contact', ...
  strength    int not null default 0,
  evidence    text,
  observed_at timestamptz not null default now()
);

create index rm_signals_person_idx on public.rm_signals (person_id);
create index rm_signals_import_idx on public.rm_signals (import_id);

-- Organizations a person can lead to. Optionally linked to an existing
-- Bridgeway prospect (cross-reference, not a second silo).
create table public.rm_orgs (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  org_key      text generated always as
                 (regexp_replace(lower(name), '[^a-z0-9]', '', 'g')) stored,
  website      text,
  industry     text,
  location     text,
  bridgeway_relevance text,
  prospect_id  uuid references public.prospects (id) on delete set null,
  -- Review queue for newly discovered candidate leads:
  lead_status  text not null default 'Suggested'
    check (lead_status in ('Suggested','Added to Prospects','Existing Prospect','Dismissed')),
  created_at   timestamptz not null default now()
);

create unique index rm_orgs_key_uidx on public.rm_orgs (org_key);

create table public.rm_affiliations (
  id         uuid primary key default gen_random_uuid(),
  person_id  uuid not null references public.rm_people (id) on delete cascade,
  org_id     uuid not null references public.rm_orgs (id) on delete cascade,
  role       text,
  confidence text not null default 'unknown'
    check (confidence in ('confirmed','high','medium','low','unknown')),
  evidence   text,
  created_at timestamptz not null default now(),
  unique (person_id, org_id)
);

-- Warm paths: Michael -> person (-> person) -> organization.
create table public.rm_paths (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.rm_orgs (id) on delete cascade,
  person_id   uuid not null references public.rm_people (id) on delete cascade,
  degree      int not null check (degree between 1 and 3),
  -- Ordered intermediate hops after `person_id`, as text labels.
  via         text[] not null default '{}',
  confidence  text not null default 'medium'
    check (confidence in ('high','medium','low')),
  evidence    text,
  recommended_action text,
  status      text not null default 'Open'
    check (status in ('Open','In Progress','Converted','Dead')),
  created_at  timestamptz not null default now()
);

create index rm_paths_org_idx on public.rm_paths (org_id);

create trigger rm_people_touch
  before update on public.rm_people
  for each row execute function public.touch_updated_at();

-- ---------- Import RPC ----------

-- Upsert people + rebuild their signals from one export batch.
-- p_people: [{person_key, first_name, last_name, display_name, ig_username,
--             ig_url, phone, email, identity_confidence, relationship_strength,
--             signals:[{source, signal_type, strength, evidence}]}]
-- Non-destructive: manual research fields are never touched; identity
-- fields only fill blanks (except strength/signals which are recomputed).
create or replace function public.rm_import_people(
  p_source text,
  p_label text,
  p_people jsonb
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_import_id uuid;
  r jsonb;
  s jsonb;
  v_key text;
  v_person_id uuid;
  n_inserted int := 0;
  n_updated int := 0;
  n_failed int := 0;
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;
  if p_people is null or jsonb_typeof(p_people) <> 'array' then
    raise exception 'expected a JSON array of people';
  end if;

  insert into public.rm_imports (source, label, imported_by)
  values (coalesce(nullif(btrim(p_source), ''), 'unknown'),
          coalesce(nullif(btrim(p_label), ''), 'import'), auth.uid())
  returning id into v_import_id;

  for r in select * from jsonb_array_elements(p_people) loop
    begin
      v_key := btrim(coalesce(r->>'person_key', ''));
      if v_key = '' then
        raise exception 'person_key is required';
      end if;

      select id into v_person_id from public.rm_people where person_key = v_key;

      if v_person_id is null then
        insert into public.rm_people (
          person_key, first_name, last_name, display_name, ig_username, ig_url,
          phone, email, identity_confidence, relationship_strength
        ) values (
          v_key,
          nullif(btrim(coalesce(r->>'first_name', '')), ''),
          nullif(btrim(coalesce(r->>'last_name', '')), ''),
          nullif(btrim(coalesce(r->>'display_name', '')), ''),
          nullif(btrim(coalesce(r->>'ig_username', '')), ''),
          nullif(btrim(coalesce(r->>'ig_url', '')), ''),
          nullif(btrim(coalesce(r->>'phone', '')), ''),
          nullif(btrim(coalesce(r->>'email', '')), ''),
          coalesce(nullif(btrim(coalesce(r->>'identity_confidence', '')), ''), 'unknown'),
          coalesce((r->>'relationship_strength')::int, 0)
        ) returning id into v_person_id;
        n_inserted := n_inserted + 1;
      else
        update public.rm_people set
          first_name   = coalesce(first_name,   nullif(btrim(coalesce(r->>'first_name', '')), '')),
          last_name    = coalesce(last_name,    nullif(btrim(coalesce(r->>'last_name', '')), '')),
          display_name = coalesce(display_name, nullif(btrim(coalesce(r->>'display_name', '')), '')),
          ig_username  = coalesce(ig_username,  nullif(btrim(coalesce(r->>'ig_username', '')), '')),
          ig_url       = coalesce(ig_url,       nullif(btrim(coalesce(r->>'ig_url', '')), '')),
          phone        = coalesce(phone,        nullif(btrim(coalesce(r->>'phone', '')), '')),
          email        = coalesce(email,        nullif(btrim(coalesce(r->>'email', '')), '')),
          relationship_strength = coalesce((r->>'relationship_strength')::int, relationship_strength)
        where id = v_person_id;
        n_updated := n_updated + 1;
        -- Replace this person's signals from automated sources; keep manual ones.
        delete from public.rm_signals
         where person_id = v_person_id and source <> 'manual';
      end if;

      if jsonb_typeof(r->'signals') = 'array' then
        for s in select * from jsonb_array_elements(r->'signals') loop
          insert into public.rm_signals (person_id, import_id, source, signal_type, strength, evidence)
          values (
            v_person_id, v_import_id,
            coalesce(nullif(btrim(coalesce(s->>'source', '')), ''), 'unknown'),
            coalesce(nullif(btrim(coalesce(s->>'signal_type', '')), ''), 'unknown'),
            coalesce((s->>'strength')::int, 0),
            nullif(btrim(coalesce(s->>'evidence', '')), '')
          );
        end loop;
      end if;

    exception when others then
      n_failed := n_failed + 1;
    end;
  end loop;

  update public.rm_imports
     set counts = jsonb_build_object('inserted', n_inserted, 'updated', n_updated, 'failed', n_failed)
   where id = v_import_id;

  return jsonb_build_object(
    'import_id', v_import_id,
    'inserted', n_inserted,
    'updated', n_updated,
    'failed', n_failed
  );
end;
$$;

revoke all on function public.rm_import_people(text, text, jsonb) from public, anon;
grant execute on function public.rm_import_people(text, text, jsonb) to authenticated;

-- Delete an entire imported dataset. Removes the batch's signals, then
-- prunes people who have no remaining signals AND no manual research
-- (so re-imports or hand-entered work are never lost silently).
create or replace function public.rm_delete_import(p_import_id uuid)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  n_signals int;
  n_people int;
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;

  delete from public.rm_signals where import_id = p_import_id;
  get diagnostics n_signals = row_count;

  delete from public.rm_people p
   where not exists (select 1 from public.rm_signals s where s.person_id = p.id)
     and p.company is null and p.notes is null
     and p.action_status = 'New' and p.opportunity_score = 0;
  get diagnostics n_people = row_count;

  delete from public.rm_imports where id = p_import_id;

  return jsonb_build_object('signals_removed', n_signals, 'people_removed', n_people);
end;
$$;

revoke all on function public.rm_delete_import(uuid) from public, anon;
grant execute on function public.rm_delete_import(uuid) to authenticated;

-- ---------- Views ----------

create or replace view public.rm_person_list
with (security_invoker = true) as
select
  p.*,
  coalesce((select array_agg(distinct s.signal_type)
              from public.rm_signals s where s.person_id = p.id), '{}') as signal_types,
  (select count(*) from public.rm_signals s where s.person_id = p.id)::int as signal_count
from public.rm_people p;

create or replace view public.rm_path_list
with (security_invoker = true) as
select
  pa.*,
  o.name as org_name, o.industry as org_industry, o.location as org_location,
  o.bridgeway_relevance, o.prospect_id, o.lead_status,
  pe.display_name as person_display_name, pe.first_name as person_first_name,
  pe.last_name as person_last_name, pe.ig_username as person_ig_username,
  pe.relationship_strength as person_strength
from public.rm_paths pa
join public.rm_orgs o on o.id = pa.org_id
join public.rm_people pe on pe.id = pa.person_id;

-- ---------- Row-level security ----------

alter table public.rm_imports      enable row level security;
alter table public.rm_people       enable row level security;
alter table public.rm_signals      enable row level security;
alter table public.rm_orgs         enable row level security;
alter table public.rm_affiliations enable row level security;
alter table public.rm_paths        enable row level security;

create policy rm_imports_all on public.rm_imports
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy rm_people_all on public.rm_people
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy rm_signals_all on public.rm_signals
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy rm_orgs_all on public.rm_orgs
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy rm_affiliations_all on public.rm_affiliations
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy rm_paths_all on public.rm_paths
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
