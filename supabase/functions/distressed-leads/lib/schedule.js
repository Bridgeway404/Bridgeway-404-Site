// Scheduling rules, mirrored from dpl_scheduled_kick() in SQL so they can
// be unit-tested. The production scheduler is pg_cron (UTC) firing at
// 12:00 and 13:00 UTC on Tuesday/Thursday; only the firing that lands at
// 08:00 America/New_York starts a run.

const TZ = 'America/New_York';

/** Return { hour, minute, isoDow (1=Mon..7=Sun), dateKey } for a UTC instant in Eastern time. */
export function easternParts(date) {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour12: false, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const parts = Object.fromEntries(fmt.formatToParts(date).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  const dowMap = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return {
    hour: parseInt(parts.hour, 10) % 24,
    minute: parseInt(parts.minute, 10),
    isoDow: dowMap[parts.weekday],
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

/** The cron expressions registered in pg_cron. */
export const CRON_SCHEDULES = ['0 12 * * 2,4', '0 13 * * 2,4'];

/** Does this UTC instant match one of the registered cron firings? */
export function matchesCron(date) {
  const h = date.getUTCHours(), m = date.getUTCMinutes(), d = date.getUTCDay();
  return m === 0 && (h === 12 || h === 13) && (d === 2 || d === 4);
}

/** The guard inside dpl_scheduled_kick(): start only at 08:xx Eastern on Tue/Thu. */
export function shouldStartScheduledRun(date, alreadyRanDateKeys = []) {
  const e = easternParts(date);
  if (e.hour !== 8) return { start: false, reason: `not 8am Eastern (${String(e.hour).padStart(2, '0')}:${String(e.minute).padStart(2, '0')})` };
  if (e.isoDow !== 2 && e.isoDow !== 4) return { start: false, reason: 'not Tue/Thu' };
  if (alreadyRanDateKeys.includes(e.dateKey)) return { start: false, reason: 'already ran today' };
  return { start: true, reason: 'ok', dateKey: e.dateKey };
}

/** Simulate the cron + guard for every firing in [from, to]; returns the Eastern date keys that would start runs. */
export function simulateFirings(fromUtc, toUtc) {
  const runs = [];
  const skipped = [];
  const ran = [];
  for (let t = new Date(fromUtc); t <= toUtc; t = new Date(t.getTime() + 60 * 60 * 1000)) {
    if (!matchesCron(t)) continue;
    const r = shouldStartScheduledRun(t, ran);
    if (r.start) { ran.push(r.dateKey); runs.push({ utc: t.toISOString(), eastern: r.dateKey }); }
    else skipped.push({ utc: t.toISOString(), reason: r.reason });
  }
  return { runs, skipped };
}

/** Next scheduled run instant (UTC Date) after `now`. */
export function nextScheduledRun(now = new Date()) {
  for (let t = new Date(Math.ceil(now.getTime() / 3600000) * 3600000); ; t = new Date(t.getTime() + 3600000)) {
    if (matchesCron(t) && shouldStartScheduledRun(t).start) return t;
  }
}
