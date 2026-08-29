-- ============================================================
-- B2B vendor-partnership targets
--
-- These are companies Bridgeway should REGISTER WITH as a service
-- vendor, not cold-call. Two additions:
--   * priority 0 ("P0 / Apply First") — a tier above the existing P1,
--     so these are always served before ordinary outbound prospects.
--   * application_status — the vendor-onboarding workflow. NULL means
--     an ordinary outbound lead, which is what distinguishes the two
--     kinds of lead without adding a competing category field.
-- ============================================================

alter table public.prospects drop constraint if exists prospects_priority_check;
alter table public.prospects add constraint prospects_priority_check
  check (priority between 0 and 5);

do $$ begin
  if not exists (select 1 from information_schema.columns
                  where table_schema='public' and table_name='prospects'
                    and column_name='application_status') then
    alter table public.prospects add column application_status text;
  end if;
end $$;

alter table public.prospects drop constraint if exists prospects_application_status_check;
alter table public.prospects add constraint prospects_application_status_check
  check (application_status is null or application_status in (
    'Apply First', 'Application Needed', 'Application Started',
    'Application Submitted', 'Vendor Contact Needed', 'Follow-Up',
    'Approved Vendor', 'Not a Fit'));

create index if not exists prospects_partnership_idx
  on public.prospects (priority, application_status);

-- Queue order: priority first, so a P0 partnership target is always served
-- ahead of ordinary prospects even before its contact path is filled in.
-- Within a priority band, contactable companies still come first.
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
     pr.priority asc,
     ((pr.contact_phone is not null and pr.contact_phone <> '')
       or (pr.contact_email is not null and pr.contact_email <> '')) desc,
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
       pr.priority asc,
       ((pr.contact_phone is not null and pr.contact_phone <> '')
         or (pr.contact_email is not null and pr.contact_email <> '')) desc,
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
