import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldStartScheduledRun, matchesCron, simulateFirings, nextScheduledRun, easternParts } from '../lib/schedule.js';

test('the two UTC cron firings select exactly 8:00 AM Eastern on Tuesday and Thursday across DST', () => {
  // A full year of hourly ticks: every Tuesday and Thursday gets exactly one run, and it is at 08:00 Eastern.
  const { runs, skipped } = simulateFirings(new Date('2026-01-01T00:00:00Z'), new Date('2026-12-31T23:00:00Z'));
  // 2026 has 52 Tuesdays and 53 Thursdays (Jan 1 and Dec 31 are both Thursdays).
  assert.equal(runs.length, 105, 'one run per Tuesday and Thursday of the year');
  for (const r of runs) {
    const e = easternParts(new Date(r.utc));
    assert.equal(e.hour, 8);
    assert.ok(e.isoDow === 2 || e.isoDow === 4);
  }
  assert.equal(skipped.length, 105, 'the other firing of each day is skipped');
  assert.ok(skipped.every(s => /not 8am/.test(s.reason)));
});

test('daylight-saving transitions: 12:00 UTC in summer, 13:00 UTC in winter', () => {
  // Tuesday 2026-03-03 (EST): 13:00 UTC = 8am
  assert.equal(shouldStartScheduledRun(new Date('2026-03-03T13:00:00Z')).start, true);
  assert.equal(shouldStartScheduledRun(new Date('2026-03-03T12:00:00Z')).start, false);
  // DST begins 2026-03-08; Tuesday 2026-03-10 (EDT): 12:00 UTC = 8am
  assert.equal(shouldStartScheduledRun(new Date('2026-03-10T12:00:00Z')).start, true);
  assert.equal(shouldStartScheduledRun(new Date('2026-03-10T13:00:00Z')).start, false);
  // DST ends 2026-11-01; Thursday 2026-11-05 (EST)
  assert.equal(shouldStartScheduledRun(new Date('2026-11-05T13:00:00Z')).start, true);
  assert.equal(shouldStartScheduledRun(new Date('2026-11-05T12:00:00Z')).start, false);
});

test('weekday guard and once-per-day guard', () => {
  assert.equal(matchesCron(new Date('2026-09-09T12:00:00Z')), false); // Wednesday
  assert.equal(shouldStartScheduledRun(new Date('2026-09-09T12:00:00Z')).reason, 'not Tue/Thu');
  const tue = new Date('2026-09-08T12:00:00Z');
  const first = shouldStartScheduledRun(tue);
  assert.equal(first.start, true);
  assert.equal(shouldStartScheduledRun(tue, [first.dateKey]).reason, 'already ran today');
});

test('next scheduled run is the coming Tuesday or Thursday at 8am Eastern', () => {
  const next = nextScheduledRun(new Date('2026-09-08T15:00:00Z')); // Tue after 8am ET → Thu
  assert.equal(next.toISOString(), '2026-09-10T12:00:00.000Z');
  const winter = nextScheduledRun(new Date('2026-12-16T00:00:00Z')); // Wed → Thu 13:00 UTC
  assert.equal(winter.toISOString(), '2026-12-17T13:00:00.000Z');
});
