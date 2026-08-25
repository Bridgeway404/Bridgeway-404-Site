-- add_business_days converts a timestamptz into Atlanta local time to decide
-- whether a day is a weekend. That depends on the timezone database, which makes
-- the function STABLE, not IMMUTABLE. Marking it immutable would let the planner
-- cache results across a timezone-data change.

create or replace function public.add_business_days(from_ts timestamptz, n int)
returns timestamptz
language plpgsql stable
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
