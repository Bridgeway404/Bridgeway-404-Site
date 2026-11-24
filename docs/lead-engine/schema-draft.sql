-- ============================================================
-- Bridgeway Lead Generation Engine — DRAFT schema (NOT APPLIED)
--
-- This file lives in docs/ on purpose. It is a proposal for review, not a
-- migration. When approved, copy it to supabase/migrations/ under the next
-- free number and apply it through the normal migration process.
--
-- Conventions follow the existing migrations:
--   * every table has RLS on, with one policy: authenticated + is_admin();
--   * workers write with the service role (bypasses RLS);
--   * history tables are append-only (no update/delete policy);
--   * duplicate prevention is done with unique indexes, not application code.
--
-- Before applying, check against the live database:
--   * the live `customers` / `quotes` tables (created outside this repo's
--     migrations) — the uuid references to them below are left WITHOUT
--     foreign keys until their primary keys are confirmed;
--   * that no `le_` object already exists.
-- ============================================================

create extension if not exists pgcrypto;

-- ---------- helpers ----------

create or replace function public.le_phone_key(p text)
returns text language sql immutable set search_path = '' as $$
  select nullif(right(regexp_replace(coalesce(p, ''), '\D', '', 'g'), 10), '')
$$;

create or replace function public.le_name_key(p text)
returns text language sql immutable set search_path = '' as $$
  select nullif(regexp_replace(
    regexp_replace(lower(coalesce(p, '')), '\m(llc|inc|co|corp|company|ltd|lp|llp|the)\M', '', 'g'),
    '[^a-z0-9]', '', 'g'), '')
$$;

-- ---------- control: suppression, consent, budgets ----------

create table public.le_suppressions (
  id          uuid primary key default gen_random_uuid(),
  scope       text not null check (scope in ('email','phone','domain','organization')),
  value       text not null,
  reason      text not null check (reason in (
                'opt_out','complaint','bounce','existing_customer','competitor',
                'owner_decision','legal','wrong_contact','do_not_call_request')),
  permanent   boolean not null default true,
  note        text,
  created_at  timestamptz not null default now(),
  created_by  uuid
);
create unique index le_suppressions_key on public.le_suppressions (scope, lower(value));

create table public.le_consents (
  id          uuid primary key default gen_random_uuid(),
  phone_key   text,
  email       text,
  channel     text not null check (channel in ('sms','email','call')),
  scope       text not null check (scope in ('service','marketing')),
  method      text not null check (method in (
                'web_form_checkbox','inbound_text','inbound_call','verbal_recorded','written')),
  evidence    text not null,            -- form submission id, message id, call id
  granted_at  timestamptz not null default now(),
  revoked_at  timestamptz,
  check (phone_key is not null or email is not null)
);
create index le_consents_phone on public.le_consents (phone_key) where revoked_at is null;
create index le_consents_email on public.le_consents (lower(email)) where revoked_at is null;

create table public.le_budgets (
  service      text primary key,        -- 'claude_api','twilio','hunter','places','lsa','search_ads',...
  monthly_cap  numeric(10,2) not null check (monthly_cap >= 0),
  spent        numeric(10,2) not null default 0,
  period_start date not null default date_trunc('month', now())::date,
  paused       boolean not null default false,
  updated_at   timestamptz not null default now()
);

create table public.le_workflows (
  code        text primary key,         -- 'W1'..'W18'
  name        text not null,
  paused      boolean not null default true,   -- everything starts paused
  interval_s  integer,
  last_ok_at  timestamptz,
  last_error  text
);

create table public.le_runs (
  id           uuid primary key default gen_random_uuid(),
  workflow     text not null references public.le_workflows(code),
  status       text not null default 'running' check (status in ('running','ok','error','partial')),
  started_at   timestamptz not null default now(),
  heartbeat_at timestamptz not null default now(),
  finished_at  timestamptz,
  counts       jsonb not null default '{}',
  errors       jsonb not null default '[]'
);
create index le_runs_workflow on public.le_runs (workflow, started_at desc);

-- ---------- residential: leads, messages, jobs, payments ----------

create table public.le_leads (
  id                uuid primary key default gen_random_uuid(),
  source_system     text not null,      -- 'netlify','gmail','twilio','quote_app','manual'
  external_id       text not null,      -- submission id, message id, call sid
  channel           text not null check (channel in (
                      'thumbtack','lsa','search_ads','gbp','website','phone','text','yelp',
                      'referral_customer','referral_partner','past_customer','commercial','radar','bid','other')),
  campaign          text,
  landing_page      text,
  click_id          text,
  referral_code     text,
  lead_type         text not null default 'residential' check (lead_type in ('residential','commercial')),
  name              text,
  phone_key         text,
  email             text,
  service           text,
  area              text,
  details           text,
  status            text not null default 'new' check (status in (
                      'new','acknowledged','quoted','booked','completed','lost','spam','duplicate')),
  lost_reason       text,
  owner             text,
  customer_id       uuid,               -- -> customers (FK added after live check)
  organization_id   uuid,
  received_at       timestamptz not null default now(),
  first_response_at timestamptz,
  created_at        timestamptz not null default now()
);
create unique index le_leads_dedupe on public.le_leads (source_system, external_id);
create index le_leads_open on public.le_leads (status, received_at) where status in ('new','acknowledged','quoted');
create index le_leads_phone on public.le_leads (phone_key);

create table public.le_lead_events (       -- append-only
  id         bigint generated always as identity primary key,
  lead_id    uuid not null references public.le_leads(id),
  event_type text not null,
  actor      text not null,                -- 'system:W3', 'user:<uuid>'
  detail     jsonb not null default '{}',
  at         timestamptz not null default now()
);
create index le_lead_events_lead on public.le_lead_events (lead_id, at);

create table public.le_messages (
  id           uuid primary key default gen_random_uuid(),
  lead_id      uuid references public.le_leads(id),
  contact_id   uuid,
  channel      text not null check (channel in ('sms','email','call','thumbtack','voicemail')),
  direction    text not null check (direction in ('in','out')),
  purpose      text not null default 'service' check (purpose in ('service','marketing','outreach')),
  to_value     text,
  from_value   text,
  body         text,
  provider_id  text,
  automated    boolean not null default false,
  status       text not null default 'recorded' check (status in ('queued','draft','sent','recorded','failed','blocked')),
  at           timestamptz not null default now()
);
create unique index le_messages_provider on public.le_messages (provider_id) where provider_id is not null;

-- Gate: no outbound message to a suppressed address; no marketing text without consent.
create or replace function public.le_messages_gate()
returns trigger language plpgsql set search_path = '' as $$
declare
  v_phone text := public.le_phone_key(new.to_value);
begin
  if new.direction <> 'out' or new.status = 'blocked' then
    return new;
  end if;
  if exists (
    select 1 from public.le_suppressions s
    where (s.scope = 'email'  and lower(s.value) = lower(new.to_value))
       or (s.scope = 'phone'  and public.le_phone_key(s.value) = v_phone)
       or (s.scope = 'domain' and lower(new.to_value) like '%@' || lower(s.value))
  ) then
    raise exception 'recipient is suppressed';
  end if;
  if new.channel = 'sms' and new.purpose = 'marketing' and not exists (
    select 1 from public.le_consents c
    where c.phone_key = v_phone and c.channel = 'sms'
      and c.scope = 'marketing' and c.revoked_at is null
  ) then
    raise exception 'no marketing text consent on file for this number';
  end if;
  return new;
end;
$$;
create trigger le_messages_gate before insert or update on public.le_messages
  for each row execute function public.le_messages_gate();

create table public.le_jobs (
  id               uuid primary key default gen_random_uuid(),
  lead_id          uuid references public.le_leads(id),
  customer_id      uuid,
  organization_id  uuid,
  scheduled_for    timestamptz,
  status           text not null default 'booked' check (status in ('booked','completed','cancelled','no_show')),
  price            numeric(10,2),
  direct_cost      numeric(10,2),
  crew             text,
  eviction_related boolean not null default false,
  writ_executed_on date,
  client_authorization_ref text,
  created_at       timestamptz not null default now(),
  constraint le_jobs_eviction_gate check (
    not eviction_related or (writ_executed_on is not null and client_authorization_ref is not null))
);

create table public.le_payments (
  id            uuid primary key default gen_random_uuid(),
  provider      text not null default 'square' check (provider in ('square','cash','zelle','cashapp','check','other')),
  provider_id   text,
  amount        numeric(10,2) not null,
  paid_at       timestamptz not null,
  job_id        uuid references public.le_jobs(id),
  lead_id       uuid references public.le_leads(id),
  match_method  text check (match_method in ('invoice','phone','email','manual')),
  created_at    timestamptz not null default now()
);
create unique index le_payments_provider on public.le_payments (provider, provider_id) where provider_id is not null;

create table public.le_reviews (
  id            uuid primary key default gen_random_uuid(),
  job_id        uuid not null unique references public.le_jobs(id),
  requested_at  timestamptz,
  reminder_at   timestamptz,
  platform      text default 'google',
  rating        smallint check (rating between 1 and 5),
  received_at   timestamptz
);

create table public.le_referrals (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,
  referrer_kind text not null check (referrer_kind in ('customer','partner')),
  referrer_id uuid not null,
  lead_id     uuid references public.le_leads(id),
  job_id      uuid references public.le_jobs(id),
  amount      numeric(10,2),
  status      text not null default 'issued' check (status in ('issued','earned','approved','paid','void')),
  created_at  timestamptz not null default now()
);

-- ---------- commercial: organizations, contacts, opportunities ----------

create table public.le_organizations (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  name_key      text generated always as (public.le_name_key(name)) stored,
  domain        text,
  segment       text not null check (segment in (
                  'property_management','multifamily','sfr_investor','vendor_network','contractor',
                  'storage','restoration','estate_sale','moving','real_estate','organizer',
                  'senior_living','attorney','hoa','government','other')),
  priority      smallint not null default 3 check (priority between 1 and 3),
  county        text,
  city          text,
  postal_code   text,
  phone_key     text,
  place_id      text,                     -- Google Places id only; no other Places content is stored
  sos_number    text,
  doors_low     integer,
  doors_high    integer,
  value_score   numeric(10,2),            -- computed by code, never by a model
  access_score  smallint check (access_score between 0 and 100),
  band          text check (band in ('A','B','C','D','reserve')),
  status        text not null default 'discovered' check (status in (
                  'discovered','qualified','contact_verified','outreach_ready','in_outreach',
                  'replied','vendor_info_requested','vendor_approved','active_account','nurture','disqualified')),
  do_not_contact boolean not null default false,
  prospect_id   uuid,                     -- -> prospects.id for rows that came from the Blitz list
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index le_org_domain on public.le_organizations (lower(domain)) where domain is not null;
create unique index le_org_sos on public.le_organizations (sos_number) where sos_number is not null;
create unique index le_org_place on public.le_organizations (place_id) where place_id is not null;
create index le_org_name_zip on public.le_organizations (name_key, postal_code);
create index le_org_segment on public.le_organizations (segment, band, status);

create table public.le_contacts (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.le_organizations(id),
  full_name        text,
  role             text,
  authority_note   text,
  email            text,
  email_status     text not null default 'unverified' check (email_status in ('unverified','valid','catch_all','invalid')),
  phone_key        text,
  phone_type       text check (phone_type in ('landline','mobile','voip','unknown')),
  status           text not null default 'active' check (status in ('active','left_company','do_not_contact')),
  created_at       timestamptz not null default now()
);
create unique index le_contacts_email on public.le_contacts (lower(email)) where email is not null and status = 'active';

create table public.le_field_sources (     -- append-only provenance
  id          bigint generated always as identity primary key,
  entity      text not null check (entity in ('organization','contact','opportunity')),
  entity_id   uuid not null,
  field       text not null,
  value       text,
  source      text not null,               -- 'company_site','ga_sos','grec','places_id','hunter','manual',...
  confidence  text not null check (confidence in ('confirmed','likely','speculative','unknown')),
  observed_at timestamptz not null default now()
);
create index le_field_sources_entity on public.le_field_sources (entity, entity_id, field);

create table public.le_opportunities (
  id               uuid primary key default gen_random_uuid(),
  type             text not null check (type in (
                     'permit','bid','estate_sale','storage','tax_sale','deed','management_change','project_invite','other')),
  source_ref       text not null,          -- permit number, solicitation id, url
  organization_id  uuid references public.le_organizations(id),
  title            text not null,
  location         text,
  county           text,
  value_estimate   numeric(10,2),
  score            smallint check (score between 0 and 100),
  score_factors    jsonb not null default '[]',
  due_at           timestamptz,
  expires_at       timestamptz,
  status           text not null default 'new' check (status in ('new','surfaced','actioned','won','lost','expired','dismissed')),
  usable_in_outreach boolean not null default false,
  created_at       timestamptz not null default now()
);
create unique index le_opportunities_dedupe on public.le_opportunities (type, source_ref);

-- ---------- cadences, templates, tasks, spend ----------

create table public.le_templates (
  id           uuid primary key default gen_random_uuid(),
  code         text not null unique,
  channel      text not null check (channel in ('sms','email')),
  audience     text not null,
  hypothesis   text not null,
  body         text not null,
  approved_by  uuid,
  approved_at  timestamptz                  -- unapproved templates are never used
);

create table public.le_sequences (
  id       uuid primary key default gen_random_uuid(),
  code     text not null unique,
  audience text not null,
  active   boolean not null default false
);

create table public.le_sequence_steps (
  sequence_id uuid not null references public.le_sequences(id),
  step_no     smallint not null,
  delay       interval not null,
  channel     text not null check (channel in ('sms','email','call_task','draft_email')),
  template_id uuid references public.le_templates(id),
  primary key (sequence_id, step_no)
);

create table public.le_enrollments (
  id            uuid primary key default gen_random_uuid(),
  sequence_id   uuid not null references public.le_sequences(id),
  subject_kind  text not null check (subject_kind in ('lead','contact','customer')),
  subject_id    uuid not null,
  step_no       smallint not null default 0,
  next_at       timestamptz,
  stopped_reason text,
  created_at    timestamptz not null default now(),
  unique (sequence_id, subject_kind, subject_id)
);
create index le_enrollments_due on public.le_enrollments (next_at) where stopped_reason is null;

create table public.le_tasks (
  id          uuid primary key default gen_random_uuid(),
  owner       text not null,                -- 'michael','jonathan','leslie','scheduler'
  type        text not null,
  subject_kind text,
  subject_id  uuid,
  title       text not null,
  due_at      timestamptz not null default now(),
  done_at     timestamptz,
  created_by  text not null default 'system'
);
create index le_tasks_open on public.le_tasks (owner, due_at) where done_at is null;

create table public.le_spend (
  spend_date date not null,
  channel    text not null,
  amount     numeric(10,2) not null default 0,
  leads      integer,
  basis      text not null check (basis in ('api','email_report','manual')),
  primary key (spend_date, channel)
);

-- ---------- row-level security: admins only, same as every existing table ----------

do $$
declare t text;
begin
  for t in
    select tablename from pg_tables where schemaname = 'public' and tablename like 'le\_%'
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using (public.is_admin())',
      t || '_admin_read', t);
  end loop;
end $$;

-- Admin writes only where people edit by hand; everything else is written by workers.
create policy le_tasks_admin_write on public.le_tasks
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy le_suppressions_admin_insert on public.le_suppressions
  for insert to authenticated with check (public.is_admin());
create policy le_budgets_admin_write on public.le_budgets
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy le_workflows_admin_write on public.le_workflows
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---------- reporting views ----------

create view public.le_v_channel_profit with (security_invoker = true) as
select
  l.channel,
  date_trunc('week', l.received_at)::date                      as week,
  count(*)                                                     as leads,
  count(*) filter (where l.status not in ('spam','duplicate')) as qualified_leads,
  count(distinct j.id)                                         as booked_jobs,
  count(distinct j.id) filter (where j.status = 'completed')   as completed_jobs,
  coalesce(sum(p.amount), 0)                                   as revenue,
  coalesce(sum(j.direct_cost), 0)                              as direct_cost
from public.le_leads l
left join public.le_jobs j     on j.lead_id = l.id
left join public.le_payments p on p.job_id = j.id
group by 1, 2;

create view public.le_v_unanswered with (security_invoker = true) as
select id, channel, name, service, area, received_at,
       now() - received_at as waiting
from public.le_leads
where status = 'new' and first_response_at is null
order by received_at;

create view public.le_v_workflow_health with (security_invoker = true) as
select w.code, w.name, w.paused, w.last_ok_at, w.last_error,
       (w.interval_s is not null and not w.paused
        and (w.last_ok_at is null or w.last_ok_at < now() - make_interval(secs => w.interval_s * 2))) as stale
from public.le_workflows w;
