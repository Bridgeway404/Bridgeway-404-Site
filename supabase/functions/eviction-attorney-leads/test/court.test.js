import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCourtCandidates } from '../lib/court.js';

const rows = [
  { attorney: 'J Mike Williams', county: 'DeKalb', filings: 345, plaintiffs: 113, business_plaintiffs: 110, top_plaintiffs: ['LP Belle Vista Apartments (12)', 'Fogelman Management Group (9)', '900 Title Jefferson, LLC (7)'], first_hearing: '2026-08-24', last_hearing: '2026-09-17', source_urls: ['https://dekalbcountymagistratecourt.com/a.pdf', 'https://dekalbcountymagistratecourt.com/b.pdf'] },
  { attorney: 'J. Mike Williams', county: 'Fulton', filings: 4, plaintiffs: 2, business_plaintiffs: 2, top_plaintiffs: ['Cortland Druid Hills (3)'], first_hearing: '2026-09-01', last_hearing: '2026-09-10', source_urls: ['https://www.magistratefulton.org/x'] },
  { attorney: 'A DREW POWERS', county: 'DeKalb', filings: 4, plaintiffs: 4, business_plaintiffs: 0, top_plaintiffs: [], first_hearing: '2026-08-25', last_hearing: '2026-09-16', source_urls: ['https://dekalbcountymagistratecourt.com/c.pdf'] },
  { attorney: 'Payment of Rent', county: 'DeKalb', filings: 3, plaintiffs: 3, business_plaintiffs: 3, top_plaintiffs: ['X LLC (1)'], first_hearing: '2026-08-26', last_hearing: '2026-09-15', source_urls: [] },
  { attorney: 'Caela Abrams', county: 'DeKalb', filings: 1, plaintiffs: 1, business_plaintiffs: 1, top_plaintiffs: ['Larkin Street Homes, LLC (1)'], first_hearing: '2026-09-17', last_hearing: '2026-09-17', source_urls: ['https://dekalbcountymagistratecourt.com/d.pdf'] },
  { attorney: 'Sarah Skinner', county: 'DeKalb', filings: 3, plaintiffs: 3, business_plaintiffs: 3, top_plaintiffs: ['Mitchell SFR LLC (1)', 'TBR SFR ATL Owner 2 LP (1)', 'Up&Up Fund II GA LLC (1)'], first_hearing: '2026-09-08', last_hearing: '2026-09-16', source_urls: ['https://dekalbcountymagistratecourt.com/e.pdf'] },
  { attorney: 'Andres Jimenez', county: 'DeKalb', filings: 1, plaintiffs: 1, business_plaintiffs: 0, top_plaintiffs: [], first_hearing: '2026-09-02', last_hearing: '2026-09-02', source_urls: [] },
];

test('court candidates: same attorney across counties is one lead with combined evidence', () => {
  const out = buildCourtCandidates(rows, { minFilings: 2 });
  const jmw = out.find(c => c.attorney_name === 'J Mike Williams');
  assert.ok(jmw, 'J Mike Williams qualifies');
  assert.equal(jmw.filing_count, 349);
  assert.deepEqual(jmw.counties, ['DeKalb', 'Fulton']);
  assert.equal(jmw.county, 'DeKalb');
  assert.match(jmw.evidence, /345 dispossessory cases on the DeKalb County Magistrate Court calendars \(Aug 24, 2026 – Sep 17, 2026\)/);
  assert.match(jmw.evidence, /Fulton County/);
  assert.match(jmw.clients_identified, /LP Belle Vista Apartments; Fogelman Management Group/);
  assert.ok(!/\(\d+\)/.test(jmw.clients_identified), 'counts stripped from client names');
  assert.equal(jmw.confidence, 'high');
  assert.equal(jmw.referral_potential, 'high');
  assert.equal(jmw.source_kind, 'court_records');
  assert.equal(jmw.enrichment_status, 'pending');
  assert.equal(jmw.source_urls.length, 3);
  assert.equal(out[0].attorney_name, 'J Mike Williams', 'sorted by filings');
});

test('court candidates: lender-only, junk cells and one-off individual filings are excluded', () => {
  const names = buildCourtCandidates(rows, { minFilings: 2 }).map(c => c.attorney_name);
  assert.ok(!names.includes('A Drew Powers'), 'bank / VA post-foreclosure counsel is not a landlord referral source');
  assert.ok(!names.some(n => /Payment of Rent/i.test(n)));
  assert.ok(!names.includes('Andres Jimenez'));
  assert.ok(!names.includes('Caela Abrams'), 'a single filing for one entity does not qualify at minFilings 2');
  assert.ok(names.includes('Sarah Skinner'));
});

test('court candidates: several spellings in one county fold into one sentence', () => {
  const out = buildCourtCandidates([
    { attorney: 'J Mike Williams', county: 'DeKalb', filings: 345, plaintiffs: 113, business_plaintiffs: 110, top_plaintiffs: ['LP Belle Vista Apartments (12)'], first_hearing: '2026-08-24', last_hearing: '2026-09-17', source_urls: ['https://dekalb/a.pdf'] },
    { attorney: 'J. Mike Williams', county: 'DeKalb', filings: 1, plaintiffs: 1, business_plaintiffs: 1, top_plaintiffs: ['Initiative For Affordable Housing (1)'], first_hearing: '2026-09-13', last_hearing: '2026-09-13', source_urls: ['https://dekalb/b.pdf'] },
  ], { minFilings: 2 });
  assert.equal(out.length, 1);
  assert.equal(out[0].attorney_name, 'J Mike Williams');
  assert.equal(out[0].filing_count, 346);
  assert.equal((out[0].evidence.match(/Court records:/g) || []).length, 1);
  assert.match(out[0].evidence, /346 dispossessory cases .* for 111 landlord/);
  assert.deepEqual(out[0].source_urls, ['https://dekalb/a.pdf', 'https://dekalb/b.pdf']);
});

test('court candidates: county filter and minFilings 1', () => {
  const fulton = buildCourtCandidates(rows, { minFilings: 1, counties: ['Fulton'] });
  assert.deepEqual(fulton.map(c => c.attorney_name), ['J. Mike Williams']);
  assert.equal(fulton[0].filing_count, 4);
  const all = buildCourtCandidates(rows, { minFilings: 1 });
  assert.ok(all.some(c => c.attorney_name === 'Caela Abrams'));
  assert.equal(all.find(c => c.attorney_name === 'Caela Abrams').confidence, 'low');
});
