-- ============================================================
-- Bridgeway Admin — Property Management Blitz
-- 0001_init.sql — schema, functions, row-level security
-- ============================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------- Types ----------

create type public.prospect_type as enum (
  'property_management',
  'multifamily_operator',
  'sfr_operator',
  'vendor_network',
  'reo_field_services'
);

create type public.prospect_status as enum ('active', 'done');

create type public.outreach_outcome as enum (
  'no_answer', 'left_voicemail', 'spoke_connected', 'done'
);

-- ---------- Tables ----------

-- Allowlist of admin accounts. Membership here — not mere authentication —
-- is what grants data access. Rows are created only by security-definer
-- team functions, never by clients directly.
create table public.admin_users (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  email        text unique not null,
  display_name text not null,
  created_at   timestamptz not null default now()
);

create table public.prospects (
  id                      uuid primary key default gen_random_uuid(),
  company_name            text not null,
  -- normalized dedupe key: lowercase, alphanumerics only
  company_key             text generated always as
                            (regexp_replace(lower(company_name), '[^a-z0-9]', '', 'g')) stored,
  prospect_type           public.prospect_type not null,
  website                 text,
  primary_geography       text,
  metro_atlanta_relevance text,
  portfolio_summary       text,
  why_bridgeway           text,
  contact_name            text,
  contact_title           text,
  contact_phone           text,
  contact_email           text,
  vendor_registration_url text,
  general_contact_url     text,
  vendor_notes            text,
  source_urls             text[] not null default '{}',
  priority                int not null default 3 check (priority between 1 and 5),
  last_verified_date      date,
  status                  public.prospect_status not null default 'active',
  next_due_at             timestamptz not null default now(),
  done_at                 timestamptz,
  done_by                 uuid references public.admin_users (user_id),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create unique index prospects_company_key_uidx on public.prospects (company_key);
create index prospects_queue_idx on public.prospects (status, next_due_at);

create table public.outreach_log (
  id          uuid primary key default gen_random_uuid(),
  prospect_id uuid not null references public.prospects (id) on delete cascade,
  outcome     public.outreach_outcome not null,
  note        text,
  user_id     uuid not null references public.admin_users (user_id),
  created_at  timestamptz not null default now()
);

create index outreach_log_prospect_idx on public.outreach_log (prospect_id, created_at desc);

-- Centralized recycling timing. Change these rows to change queue behavior;
-- no code changes needed.
create table public.recycle_rules (
  outcome       public.outreach_outcome primary key,
  days          int not null check (days >= 0),
  business_days boolean not null default false
);

insert into public.recycle_rules (outcome, days, business_days) values
  ('no_answer',       2, true),
  ('left_voicemail',  3, true),
  ('spoke_connected', 7, false);

-- ---------- Helper functions ----------

-- Is the caller an allowlisted admin? SECURITY DEFINER so RLS policies can
-- use it without recursing into admin_users' own policies.
create or replace function public.is_admin()
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.admin_users where user_id = auth.uid()
  );
$$;

revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

-- Business-day arithmetic in Atlanta's timezone (skips Sat/Sun).
create or replace function public.add_business_days(from_ts timestamptz, n int)
returns timestamptz
language plpgsql immutable
set search_path = ''
as $$
declare
  d timestamptz := from_ts;
  i int := 0;
begin
  while i < n loop
    d := d + interval '1 day';
    if extract(isodow from (d at time zone 'America/New_York')) < 6 then
      i := i + 1;
    end if;
  end loop;
  return d;
end;
$$;

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger prospects_touch
  before update on public.prospects
  for each row execute function public.touch_updated_at();

-- ---------- Blitz queue ----------

-- One call returns everything the Next Prospect screen needs:
-- the best available prospect, the due-now count, and whether the served
-- prospect is being worked ahead of its due time (queue exhausted).
create or replace function public.get_blitz_state()
returns jsonb
language plpgsql stable
set search_path = ''
as $$
declare
  p public.prospects;
  due_count int;
  is_ahead boolean := false;
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;

  select count(*) into due_count
    from public.prospects pr
   where pr.status = 'active' and pr.next_due_at <= now();

  select pr.* into p
    from public.prospects pr
   where pr.status = 'active' and pr.next_due_at <= now()
   order by
     ((pr.contact_phone is not null and pr.contact_phone <> '')
       or (pr.contact_email is not null and pr.contact_email <> '')) desc,
     pr.priority asc,
     pr.next_due_at asc,
     pr.id
   limit 1;

  if p.id is null then
    is_ahead := true;
    select pr.* into p
      from public.prospects pr
     where pr.status = 'active'
     order by
       pr.next_due_at asc,
       ((pr.contact_phone is not null and pr.contact_phone <> '')
         or (pr.contact_email is not null and pr.contact_email <> '')) desc,
       pr.priority asc,
       pr.id
     limit 1;
  end if;

  return jsonb_build_object(
    'due_count', due_count,
    'ahead', (is_ahead and p.id is not null),
    'prospect', case when p.id is null then null else to_jsonb(p) end
  );
end;
$$;

revoke all on function public.get_blitz_state() from public, anon;
grant execute on function public.get_blitz_state() to authenticated;

-- Record an outcome and re-queue/close the prospect. All recycling timing
-- comes from recycle_rules — the single place to change it later.
create or replace function public.log_outcome(
  p_prospect_id uuid,
  p_outcome public.outreach_outcome,
  p_note text default null
)
returns void
language plpgsql
set search_path = ''
as $$
declare
  r public.recycle_rules;
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;

  insert into public.outreach_log (prospect_id, outcome, note, user_id)
  values (p_prospect_id, p_outcome, nullif(btrim(coalesce(p_note, '')), ''), auth.uid());

  if p_outcome = 'done' then
    update public.prospects
       set status = 'done', done_at = now(), done_by = auth.uid()
     where id = p_prospect_id;
  else
    select * into r from public.recycle_rules where outcome = p_outcome;
    if r.outcome is null then
      raise exception 'no recycle rule for outcome %', p_outcome;
    end if;
    update public.prospects
       set next_due_at = case
             when r.business_days then public.add_business_days(now(), r.days)
             else now() + make_interval(days => r.days)
           end
     where id = p_prospect_id;
  end if;
end;
$$;

revoke all on function public.log_outcome(uuid, public.outreach_outcome, text) from public, anon;
grant execute on function public.log_outcome(uuid, public.outreach_outcome, text) to authenticated;

-- ---------- Team management ----------

-- Admins create teammate accounts directly (no public signup is trusted).
create or replace function public.create_team_member(
  p_email text,
  p_password text,
  p_display_name text
)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  uid uuid := gen_random_uuid();
  v_email text := lower(btrim(p_email));
  v_name text := btrim(coalesce(p_display_name, ''));
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;
  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'invalid email address';
  end if;
  if v_name = '' then
    raise exception 'display name is required';
  end if;
  if length(coalesce(p_password, '')) < 10 then
    raise exception 'password must be at least 10 characters';
  end if;
  if exists (select 1 from auth.users where lower(email) = v_email) then
    raise exception 'an account with that email already exists';
  end if;

  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change,
    email_change_token_new, email_change_token_current,
    phone_change, phone_change_token, reauthentication_token
  ) values (
    '00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated',
    v_email, extensions.crypt(p_password, extensions.gen_salt('bf')), now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('display_name', v_name),
    now(), now(),
    '', '', '', '', '', '', '', ''
  );

  insert into auth.identities (
    id, user_id, provider_id, identity_data, provider,
    last_sign_in_at, created_at, updated_at
  ) values (
    gen_random_uuid(), uid, uid::text,
    jsonb_build_object('sub', uid::text, 'email', v_email,
                       'email_verified', true, 'phone_verified', false),
    'email', now(), now(), now()
  );

  insert into public.admin_users (user_id, email, display_name)
  values (uid, v_email, v_name);
end;
$$;

revoke all on function public.create_team_member(text, text, text) from public, anon;
grant execute on function public.create_team_member(text, text, text) to authenticated;

-- Admins can reset a teammate's password (small-team recovery path).
create or replace function public.reset_team_password(
  p_email text,
  p_password text
)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  uid uuid;
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;
  if length(coalesce(p_password, '')) < 10 then
    raise exception 'password must be at least 10 characters';
  end if;
  select user_id into uid
    from public.admin_users
   where email = lower(btrim(p_email));
  if uid is null then
    raise exception 'no team member with that email';
  end if;
  update auth.users
     set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf')),
         updated_at = now()
   where id = uid;
end;
$$;

revoke all on function public.reset_team_password(text, text) from public, anon;
grant execute on function public.reset_team_password(text, text) to authenticated;

-- ---------- CSV import / upsert ----------

-- Bulk import researched prospect batches. Dedupes on normalized company
-- name; updates existing rows non-destructively (never overwrites a field
-- with blank, never touches status / queue timing / outreach history);
-- validates required fields; reports per-row failures.
create or replace function public.import_prospects(p_rows jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  r_row jsonb;
  idx int := 0;
  n_inserted int := 0;
  n_updated int := 0;
  failures jsonb := '[]'::jsonb;
  v_name text;
  v_type_raw text;
  v_type public.prospect_type;
  v_key text;
  v_sources text[];
  existing_id uuid;
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'expected a JSON array of rows';
  end if;

  for r_row in select * from jsonb_array_elements(p_rows) loop
    idx := idx + 1;
    begin
      v_name := btrim(coalesce(r_row->>'company_name', ''));
      if v_name = '' then
        raise exception 'company_name is required';
      end if;

      v_type_raw := lower(btrim(coalesce(r_row->>'prospect_type', '')));
      v_type := case
        when v_type_raw in ('property_management', 'property management company', 'property management')
          then 'property_management'::public.prospect_type
        when v_type_raw in ('multifamily_operator', 'multifamily / apartment operator', 'multifamily', 'apartment operator')
          then 'multifamily_operator'::public.prospect_type
        when v_type_raw in ('sfr_operator', 'single-family rental operator', 'single family rental operator', 'sfr')
          then 'sfr_operator'::public.prospect_type
        when v_type_raw in ('vendor_network', 'third-party maintenance / vendor network', 'third party maintenance / vendor network', 'vendor network', 'third-party maintenance')
          then 'vendor_network'::public.prospect_type
        when v_type_raw in ('reo_field_services', 'reo / field services', 'reo field services', 'reo')
          then 'reo_field_services'::public.prospect_type
        else null
      end;
      if v_type is null then
        raise exception 'invalid prospect_type: "%"', coalesce(r_row->>'prospect_type', '');
      end if;

      v_key := regexp_replace(lower(v_name), '[^a-z0-9]', '', 'g');
      if v_key = '' then
        raise exception 'company_name must contain letters or numbers';
      end if;

      if jsonb_typeof(r_row->'source_urls') = 'array' then
        select coalesce(array_agg(x), '{}') into v_sources
          from (select btrim(value #>> '{}') as x
                  from jsonb_array_elements(r_row->'source_urls')) s
         where x <> '';
      else
        select coalesce(array_agg(x), '{}') into v_sources
          from (select btrim(x) as x
                  from unnest(string_to_array(coalesce(r_row->>'source_urls', ''), '|')) as x) s
         where x <> '';
      end if;

      select id into existing_id
        from public.prospects
       where company_key = v_key;

      if existing_id is null then
        insert into public.prospects (
          company_name, prospect_type, website, primary_geography,
          metro_atlanta_relevance, portfolio_summary, why_bridgeway,
          contact_name, contact_title, contact_phone, contact_email,
          vendor_registration_url, general_contact_url, vendor_notes,
          source_urls, priority, last_verified_date
        ) values (
          v_name, v_type,
          nullif(btrim(coalesce(r_row->>'website', '')), ''),
          nullif(btrim(coalesce(r_row->>'primary_geography', '')), ''),
          nullif(btrim(coalesce(r_row->>'metro_atlanta_relevance', '')), ''),
          nullif(btrim(coalesce(r_row->>'portfolio_summary', '')), ''),
          nullif(btrim(coalesce(r_row->>'why_bridgeway', '')), ''),
          nullif(btrim(coalesce(r_row->>'contact_name', '')), ''),
          nullif(btrim(coalesce(r_row->>'contact_title', '')), ''),
          nullif(btrim(coalesce(r_row->>'contact_phone', '')), ''),
          nullif(btrim(coalesce(r_row->>'contact_email', '')), ''),
          nullif(btrim(coalesce(r_row->>'vendor_registration_url', '')), ''),
          nullif(btrim(coalesce(r_row->>'general_contact_url', '')), ''),
          nullif(btrim(coalesce(r_row->>'vendor_notes', '')), ''),
          v_sources,
          coalesce(nullif(btrim(coalesce(r_row->>'priority', '')), '')::int, 3),
          nullif(btrim(coalesce(r_row->>'last_verified_date', '')), '')::date
        );
        n_inserted := n_inserted + 1;
      else
        update public.prospects set
          company_name = v_name,
          prospect_type = v_type,
          website = coalesce(nullif(btrim(coalesce(r_row->>'website', '')), ''), website),
          primary_geography = coalesce(nullif(btrim(coalesce(r_row->>'primary_geography', '')), ''), primary_geography),
          metro_atlanta_relevance = coalesce(nullif(btrim(coalesce(r_row->>'metro_atlanta_relevance', '')), ''), metro_atlanta_relevance),
          portfolio_summary = coalesce(nullif(btrim(coalesce(r_row->>'portfolio_summary', '')), ''), portfolio_summary),
          why_bridgeway = coalesce(nullif(btrim(coalesce(r_row->>'why_bridgeway', '')), ''), why_bridgeway),
          contact_name = coalesce(nullif(btrim(coalesce(r_row->>'contact_name', '')), ''), contact_name),
          contact_title = coalesce(nullif(btrim(coalesce(r_row->>'contact_title', '')), ''), contact_title),
          contact_phone = coalesce(nullif(btrim(coalesce(r_row->>'contact_phone', '')), ''), contact_phone),
          contact_email = coalesce(nullif(btrim(coalesce(r_row->>'contact_email', '')), ''), contact_email),
          vendor_registration_url = coalesce(nullif(btrim(coalesce(r_row->>'vendor_registration_url', '')), ''), vendor_registration_url),
          general_contact_url = coalesce(nullif(btrim(coalesce(r_row->>'general_contact_url', '')), ''), general_contact_url),
          vendor_notes = coalesce(nullif(btrim(coalesce(r_row->>'vendor_notes', '')), ''), vendor_notes),
          source_urls = case when array_length(v_sources, 1) is null then source_urls else v_sources end,
          priority = coalesce(nullif(btrim(coalesce(r_row->>'priority', '')), '')::int, priority),
          last_verified_date = coalesce(nullif(btrim(coalesce(r_row->>'last_verified_date', '')), '')::date, last_verified_date)
        where id = existing_id;
        n_updated := n_updated + 1;
      end if;

    exception when others then
      failures := failures || jsonb_build_object(
        'row', idx,
        'company', coalesce(r_row->>'company_name', ''),
        'reason', sqlerrm
      );
    end;
  end loop;

  return jsonb_build_object(
    'inserted', n_inserted,
    'updated', n_updated,
    'failed', failures
  );
end;
$$;

revoke all on function public.import_prospects(jsonb) from public, anon;
grant execute on function public.import_prospects(jsonb) to authenticated;

-- ---------- Views (run with caller's permissions) ----------

create or replace view public.prospect_list
with (security_invoker = true) as
select
  p.*,
  (select count(*) from public.outreach_log ol where ol.prospect_id = p.id)::int as attempts,
  (select max(ol.created_at) from public.outreach_log ol where ol.prospect_id = p.id) as last_attempt_at,
  (select ol.outcome from public.outreach_log ol
    where ol.prospect_id = p.id
    order by ol.created_at desc limit 1) as last_outcome
from public.prospects p;

create or replace view public.outreach_history
with (security_invoker = true) as
select ol.id, ol.prospect_id, ol.outcome, ol.note, ol.created_at, au.display_name
from public.outreach_log ol
join public.admin_users au on au.user_id = ol.user_id;

-- ---------- Row-level security ----------

alter table public.admin_users   enable row level security;
alter table public.prospects     enable row level security;
alter table public.outreach_log  enable row level security;
alter table public.recycle_rules enable row level security;

-- admin_users: readable by admins (for team page + attribution names);
-- writable only via the security-definer team functions.
create policy admin_users_select on public.admin_users
  for select to authenticated using (public.is_admin());

create policy prospects_select on public.prospects
  for select to authenticated using (public.is_admin());
create policy prospects_insert on public.prospects
  for insert to authenticated with check (public.is_admin());
create policy prospects_update on public.prospects
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy prospects_delete on public.prospects
  for delete to authenticated using (public.is_admin());

create policy outreach_select on public.outreach_log
  for select to authenticated using (public.is_admin());
create policy outreach_insert on public.outreach_log
  for insert to authenticated with check (public.is_admin() and user_id = auth.uid());

create policy recycle_select on public.recycle_rules
  for select to authenticated using (public.is_admin());
create policy recycle_update on public.recycle_rules
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
