-- 0009: Auction Buyer Leads — call routing for the sales queue.
--
-- Adds to every auction buyer lead:
--   contact_route  direct | indirect | research   (how good the phone/email is)
--   contact_via    who the number actually reaches (e.g. "GPS Property Management")
--   relationship   one line: how that contact relates to the buyer
--   call_goal      one sentence: what the call is trying to accomplish
--   call_label     Call First | Call | Indirect Introduction | Research More
--   cluster_id     link to a relationship cluster (one conversation, several leads)
-- and a small ab_clusters table so leads that route through the same law firm,
-- property manager or registered agent are linked operationally without
-- merging legally distinct buyers. The default call queue becomes
-- call_label in (Call First, Call, Indirect Introduction).

-- ---------- Relationship clusters ----------
create table if not exists public.ab_clusters (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  contact_org text,
  contact_name text,
  phone text,
  email text,
  website text,
  relationship text,
  call_goal text,
  notes text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.ab_clusters enable row level security;
drop policy if exists ab_clusters_select on public.ab_clusters;
create policy ab_clusters_select on public.ab_clusters for select to authenticated using (public.is_admin());
drop policy if exists ab_clusters_insert on public.ab_clusters;
create policy ab_clusters_insert on public.ab_clusters for insert to authenticated with check (public.is_admin());
drop policy if exists ab_clusters_update on public.ab_clusters;
create policy ab_clusters_update on public.ab_clusters for update to authenticated using (public.is_admin()) with check (public.is_admin());
grant select, insert, update on public.ab_clusters to authenticated;
grant all on public.ab_clusters to service_role;

-- ---------- Buyer columns ----------
alter table public.ab_buyers
  add column if not exists contact_route text not null default 'research',
  add column if not exists contact_via text,
  add column if not exists relationship text,
  add column if not exists call_goal text,
  add column if not exists call_label text,
  add column if not exists cluster_id uuid references public.ab_clusters(id) on delete set null;
alter table public.ab_buyers drop constraint if exists ab_buyers_contact_route_check;
alter table public.ab_buyers add constraint ab_buyers_contact_route_check check (contact_route in ('direct', 'indirect', 'research'));
alter table public.ab_buyers drop constraint if exists ab_buyers_call_label_check;
alter table public.ab_buyers add constraint ab_buyers_call_label_check check (call_label is null or call_label in ('Call First', 'Call', 'Indirect Introduction', 'Research More'));
create index if not exists ab_buyers_cluster_idx on public.ab_buyers (cluster_id);

-- The effective label: an explicit label wins; otherwise it follows the route.
create or replace function public.ab_call_label(p_label text, p_route text, p_qualified boolean)
returns text
language sql immutable
set search_path = ''
as $$
  select coalesce(p_label,
    case when not coalesce(p_qualified, false) then 'Research More'
         when p_route = 'direct' then 'Call'
         when p_route = 'indirect' then 'Indirect Introduction'
         else 'Research More' end);
$$;
create or replace function public.ab_call_rank(p_label text)
returns int
language sql immutable
set search_path = ''
as $$
  select case p_label when 'Call First' then 1 when 'Call' then 2 when 'Indirect Introduction' then 3 else 4 end;
$$;

-- ---------- Cluster management ----------
create or replace function public.ab_save_cluster(p jsonb)
returns uuid
language plpgsql
set search_path = ''
as $$
declare v_id uuid := nullif(p->>'id', '')::uuid; v_name text := nullif(btrim(coalesce(p->>'name', '')), '');
begin
  if not public.is_admin() then raise exception 'not authorized'; end if;
  if v_id is null then
    if v_name is null then raise exception 'cluster name is required'; end if;
    insert into public.ab_clusters (name, contact_org, contact_name, phone, email, website, relationship, call_goal, notes, created_by)
    values (v_name, nullif(btrim(coalesce(p->>'contact_org', '')), ''), nullif(btrim(coalesce(p->>'contact_name', '')), ''), nullif(btrim(coalesce(p->>'phone', '')), ''),
            nullif(btrim(coalesce(p->>'email', '')), ''), nullif(btrim(coalesce(p->>'website', '')), ''), nullif(btrim(coalesce(p->>'relationship', '')), ''),
            nullif(btrim(coalesce(p->>'call_goal', '')), ''), nullif(btrim(coalesce(p->>'notes', '')), ''), auth.uid())
    returning id into v_id;
  else
    update public.ab_clusters set
      name = coalesce(v_name, name),
      contact_org = case when p ? 'contact_org' then nullif(btrim(p->>'contact_org'), '') else contact_org end,
      contact_name = case when p ? 'contact_name' then nullif(btrim(p->>'contact_name'), '') else contact_name end,
      phone = case when p ? 'phone' then nullif(btrim(p->>'phone'), '') else phone end,
      email = case when p ? 'email' then nullif(btrim(p->>'email'), '') else email end,
      website = case when p ? 'website' then nullif(btrim(p->>'website'), '') else website end,
      relationship = case when p ? 'relationship' then nullif(btrim(p->>'relationship'), '') else relationship end,
      call_goal = case when p ? 'call_goal' then nullif(btrim(p->>'call_goal'), '') else call_goal end,
      notes = case when p ? 'notes' then nullif(btrim(p->>'notes'), '') else notes end,
      updated_at = now()
    where id = v_id;
  end if;
  return v_id;
end;
$$;
revoke all on function public.ab_save_cluster(jsonb) from public, anon;
grant execute on function public.ab_save_cluster(jsonb) to authenticated;

-- Leads that one conversation covers: same cluster, or the same phone number.
create or replace function public.ab_linked_lead_ids(p_id uuid)
returns setof uuid
language sql stable
set search_path = ''
as $$
  select o.id from public.ab_buyers b join public.ab_buyers o on o.id <> b.id
   and ((b.cluster_id is not null and o.cluster_id = b.cluster_id) or (b.phone_key <> '' and o.phone_key = b.phone_key))
  where b.id = p_id;
$$;

-- ---------- Lead update: routing fields + "apply to linked leads" ----------
create or replace function public.ab_update_lead(p_id uuid, p_patch jsonb)
returns void
language plpgsql
set search_path = ''
as $$
declare
  a public.ab_buyers;
  v_status text; v_follow date; v_assign text; v_linked uuid; v_sub jsonb;
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
    notes = case when p_patch ? 'notes' then nullif(btrim(p_patch->>'notes'), '') else notes end,
    research_notes = case when p_patch ? 'research_notes' then nullif(btrim(p_patch->>'research_notes'), '') else research_notes end,
    contact_route = case when p_patch ? 'contact_route' and nullif(p_patch->>'contact_route', '') in ('direct', 'indirect', 'research') then p_patch->>'contact_route' else contact_route end,
    contact_via = case when p_patch ? 'contact_via' then nullif(btrim(p_patch->>'contact_via'), '') else contact_via end,
    relationship = case when p_patch ? 'relationship' then nullif(btrim(p_patch->>'relationship'), '') else relationship end,
    call_goal = case when p_patch ? 'call_goal' then nullif(btrim(p_patch->>'call_goal'), '') else call_goal end,
    call_label = case when p_patch ? 'call_label' then (case when nullif(p_patch->>'call_label', '') in ('Call First', 'Call', 'Indirect Introduction', 'Research More') then p_patch->>'call_label' else null end) else call_label end,
    cluster_id = case when p_patch ? 'cluster_id' then nullif(p_patch->>'cluster_id', '')::uuid else cluster_id end
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

  -- One call covered several leads: log the same outcome on every linked lead.
  if coalesce((p_patch->>'apply_to_linked')::boolean, false) then
    v_sub := (p_patch - 'apply_to_linked') - 'buyer_name' - 'contact_name' - 'phone' - 'email' - 'website' - 'mailing_address' - 'city' - 'county' - 'buyer_type' - 'priority' - 'qualified' - 'evidence' - 'notes' - 'research_notes' - 'contact_route' - 'contact_via' - 'relationship' - 'call_goal' - 'call_label' - 'cluster_id' - 'assigned_to';
    if v_sub ? 'note' then
      v_sub := v_sub || jsonb_build_object('note', '(via ' || a.buyer_name || ') ' || (v_sub->>'note'));
    end if;
    for v_linked in select * from public.ab_linked_lead_ids(p_id) loop
      perform public.ab_update_lead(v_linked, v_sub);
    end loop;
  end if;
end;
$$;
revoke all on function public.ab_update_lead(uuid, jsonb) from public, anon;
grant execute on function public.ab_update_lead(uuid, jsonb) to authenticated;

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
  b.contact_route, b.contact_via, b.relationship, b.call_goal,
  public.ab_call_label(b.call_label, b.contact_route, b.qualified) as call_label,
  public.ab_call_rank(public.ab_call_label(b.call_label, b.contact_route, b.qualified)) as call_rank,
  b.cluster_id, c.name as cluster_name, c.contact_org as cluster_contact_org, c.phone as cluster_phone, c.call_goal as cluster_call_goal, c.relationship as cluster_relationship,
  (select coalesce(array_agg(o.buyer_name order by o.recent_acquisitions desc, o.buyer_name), '{}'::text[])
     from public.ab_buyers o where o.id <> b.id and ((b.cluster_id is not null and o.cluster_id = b.cluster_id) or (b.phone_key <> '' and o.phone_key = b.phone_key))) as linked_names,
  cb.display_name as created_by_name,
  lp.address as latest_property, lp.county as latest_property_county, lp.acquired_on as latest_acquired_on,
  lp.property_type as latest_property_type, lp.sale_type as latest_sale_type,
  (select count(*) from public.ab_activity x where x.buyer_id = b.id and x.kind = 'note')::int as note_count,
  (select max(x.created_at) from public.ab_activity x where x.buyer_id = b.id) as last_activity_at,
  ln.note as last_note, ln.created_at as last_note_at, ln.display_name as last_note_by
from public.ab_buyers b
left join public.ab_clusters c on c.id = b.cluster_id
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

drop view if exists public.ab_cluster_list;
create view public.ab_cluster_list
with (security_invoker = true) as
select c.*, (select count(*) from public.ab_buyers b where b.cluster_id = c.id)::int as member_count,
       (select coalesce(array_agg(b.buyer_name order by b.recent_acquisitions desc, b.buyer_name), '{}'::text[]) from public.ab_buyers b where b.cluster_id = c.id) as member_names
from public.ab_clusters c;
grant select on public.ab_cluster_list to authenticated;

-- ---------- Summary ----------
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
    'visible', (select count(*) from public.ab_buyers where public.ab_call_label(call_label, contact_route, qualified) in ('Call First', 'Call', 'Indirect Introduction') and contact_status not in ('Not Interested', 'Bad Lead')),
    'call_first', (select count(*) from public.ab_buyers where public.ab_call_label(call_label, contact_route, qualified) = 'Call First' and contact_status not in ('Not Interested', 'Bad Lead')),
    'direct', (select count(*) from public.ab_buyers where contact_route = 'direct' and contact_status not in ('Not Interested', 'Bad Lead')),
    'indirect', (select count(*) from public.ab_buyers where contact_route = 'indirect' and contact_status not in ('Not Interested', 'Bad Lead')),
    'research_only', (select count(*) from public.ab_buyers where public.ab_call_label(call_label, contact_route, qualified) = 'Research More' and contact_status not in ('Not Interested', 'Bad Lead')),
    'call_today', (select count(*) from public.ab_buyers where contact_status = 'Call Today'),
    'follow_ups_due', (select count(*) from public.ab_buyers where follow_up_date <= v_today and contact_status not in ('Not Interested', 'Bad Lead')),
    'repeat_buyers', (select count(*) from public.ab_buyers where qualified and recent_acquisitions >= 2),
    'clusters', (select count(*) from public.ab_clusters),
    'queue', (select coalesce(jsonb_object_agg(s.research_status, s.n), '{}'::jsonb) from (select research_status, count(*) as n from public.ab_properties group by research_status) s),
    'queue_total', (select count(*) from public.ab_properties),
    'by_county', (select coalesce(jsonb_object_agg(s.county, s.n), '{}'::jsonb) from (select county, count(*) as n from public.ab_buyers where public.ab_call_label(call_label, contact_route, qualified) in ('Call First', 'Call', 'Indirect Introduction') group by county) s),
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
