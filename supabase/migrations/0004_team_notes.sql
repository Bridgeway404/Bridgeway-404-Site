-- ============================================================
-- Team notes as activity
--
-- A team member can leave a dated, attributed note on a prospect from the
-- prospect editor without pretending it was a call outcome. Notes reuse
-- outreach_log — the existing activity history — with a new 'note' outcome,
-- so a prospect has exactly one activity record. A note never re-queues or
-- closes a prospect: the Blitz recycling rules and log_outcome() are
-- untouched (log_outcome rejects 'note' because it has no recycle rule).
--
-- Everything here is additive and safe for existing rows:
--   * a new enum value 'note';
--   * a check that a note activity carries text (no existing row is a note);
--   * add_prospect_note(), the only intended writer of note rows;
--   * prospect_list gains team_notes / last_activity_at / last_activity.
--     attempts / last_attempt_at / last_outcome keep their meaning (calls
--     only), so the Prospects page and its worked/unworked filter behave
--     exactly as before.
--
-- prospect_list is dropped and recreated (not CREATE OR REPLACE) because the
-- original view captured p.* before 0003 added application_status, so the
-- live view has been missing that column. Recreating it fixes that.
-- ============================================================

alter type public.outreach_outcome add value if not exists 'note';

-- outcome is compared as text below so this file can run inside a single
-- transaction alongside the enum change (a new enum value cannot be used
-- as a literal until that transaction commits).
alter table public.outreach_log drop constraint if exists outreach_log_note_required;
alter table public.outreach_log add constraint outreach_log_note_required
  check (outcome::text <> 'note' or (note is not null and btrim(note) <> ''));

create or replace function public.add_prospect_note(
  p_prospect_id uuid,
  p_note text
)
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
  if not exists (select 1 from public.prospects where id = p_prospect_id) then
    raise exception 'prospect not found';
  end if;

  insert into public.outreach_log (prospect_id, outcome, note, user_id)
  values (p_prospect_id, 'note'::public.outreach_outcome, v_note, auth.uid());
end;
$$;

revoke all on function public.add_prospect_note(uuid, text) from public, anon;
grant execute on function public.add_prospect_note(uuid, text) to authenticated;

drop view if exists public.prospect_list;
create view public.prospect_list
with (security_invoker = true) as
select
  p.*,
  -- Call attempts: outreach outcomes only, never notes (unchanged meaning).
  (select count(*) from public.outreach_log ol
    where ol.prospect_id = p.id and ol.outcome::text <> 'note')::int as attempts,
  (select max(ol.created_at) from public.outreach_log ol
    where ol.prospect_id = p.id and ol.outcome::text <> 'note') as last_attempt_at,
  (select ol.outcome from public.outreach_log ol
    where ol.prospect_id = p.id and ol.outcome::text <> 'note'
    order by ol.created_at desc limit 1) as last_outcome,
  -- Team notes, and overall activity of any kind (calls + notes).
  (select count(*) from public.outreach_log ol
    where ol.prospect_id = p.id and ol.outcome::text = 'note')::int as team_notes,
  (select max(ol.created_at) from public.outreach_log ol
    where ol.prospect_id = p.id) as last_activity_at,
  (select ol.outcome from public.outreach_log ol
    where ol.prospect_id = p.id
    order by ol.created_at desc limit 1) as last_activity
from public.prospects p;

grant select on public.prospect_list to authenticated;
