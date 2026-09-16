import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDb } from './fakedb.js';
import { processJobs, buildPasses } from '../lib/pipeline.js';

const courtRows = [
  { attorney: 'J Mike Williams', county: 'DeKalb', filings: 345, plaintiffs: 113, business_plaintiffs: 110, top_plaintiffs: ['LP Belle Vista Apartments (12)'], first_hearing: '2026-08-24', last_hearing: '2026-09-17', source_urls: ['https://dekalb/a.pdf'] },
  { attorney: 'Mario Breedlove', county: 'DeKalb', filings: 69, plaintiffs: 16, business_plaintiffs: 15, top_plaintiffs: ['Asset Living (5)', 'Columbia Residential (4)'], first_hearing: '2026-08-24', last_hearing: '2026-09-17', source_urls: ['https://dekalb/b.pdf'] },
  { attorney: 'A DREW POWERS', county: 'DeKalb', filings: 4, plaintiffs: 4, business_plaintiffs: 0, top_plaintiffs: [], first_hearing: '2026-08-25', last_hearing: '2026-09-16', source_urls: [] },
];

async function runAll(env, options) {
  const run = await env.db.createRun(options);
  let r; let guard = 0;
  do { r = await processJobs(env, { timeBudgetMs: 5000 }); } while (r.remaining > 0 && ++guard < 30);
  return env.db.getRun(run.id);
}

function fakeAi({ discover, enrich } = {}) {
  let spent = 0;
  return {
    get spent() { return spent; },
    calls: { discover: [], enrich: [] },
    async discover(pass) { this.calls.discover.push(pass); spent += 0.5; return discover ? discover(pass) : { attorneys: [], notes: 'nothing' }; },
    async enrich(lead) { this.calls.enrich.push(lead); spent += 0.1; return enrich ? enrich(lead) : { found: false, notes: null }; },
  };
}

test('without an API key the court-record seed still adds evidence-backed leads and the run completes', async () => {
  const db = createFakeDb({}, { courtRows });
  const run = await runAll({ db, ai: null, log: () => {} }, {});
  assert.equal(run.status, 'completed');
  assert.equal(run.counts.inserted, 2);
  assert.equal(run.counts.candidates, 2);
  assert.ok(db.T.leads.every(l => l.source_kind === 'court_records' && l.enrichment_status === 'skipped'));
  assert.ok(run.log.some(e => /skipped: no Anthropic API key/.test(e.line)));
  assert.equal(db.T.jobs.filter(j => j.kind === 'research.web').length, 2, 'web passes are queued but skipped');
  assert.equal(db.T.jobs.filter(j => j.kind === 'enrich.attorney').length, 0);
});

test('a second run merges the same court attorneys instead of duplicating them', async () => {
  const db = createFakeDb({}, { courtRows });
  const env = { db, ai: null, log: () => {} };
  await runAll(env, {});
  const run2 = await runAll(env, {});
  assert.equal(db.T.leads.length, 2);
  assert.equal(run2.counts.inserted, 0);
  assert.equal(run2.counts.merged, 2);
});

test('with an API key: court leads are enriched, web passes add new attorneys, known names and tenant-side results are skipped', async () => {
  const db = createFakeDb({}, { courtRows });
  const ai = fakeAi({
    discover: (pass) => ({ notes: 'ok', attorneys: [
      { attorney_name: 'Jane Landlordlaw', firm_name: 'Landlord Law Group LLC', phone: '4045550100', email: null, website: 'https://landlordlaw.example', city: 'Atlanta', county: 'Fulton', counties: ['Fulton', 'Cobb'], practice_area: 'Landlord-tenant', clients_identified: 'Greystar; Cortland', evidence: 'Site says: we represent apartment communities in dispossessory actions.', source_url: 'https://landlordlaw.example/evictions', source_urls: ['https://landlordlaw.example/evictions'], confidence: 'high', referral_potential: 'high', landlord_side: true },
      { attorney_name: 'J. Mike Williams', firm_name: 'Williams Firm', phone: null, email: null, website: null, city: null, county: 'DeKalb', counties: [], practice_area: null, clients_identified: null, evidence: 'already known', source_url: 'https://x', source_urls: [], confidence: 'high', referral_potential: 'high', landlord_side: true },
      { attorney_name: 'Tenant Defender', firm_name: 'Legal Aid', phone: null, email: null, website: null, city: null, county: 'Fulton', counties: [], practice_area: null, clients_identified: null, evidence: 'defends tenants', source_url: 'https://y', source_urls: [], confidence: 'high', referral_potential: 'low', landlord_side: false },
      { attorney_name: 'No Evidence', firm_name: null, phone: null, email: null, website: null, city: null, county: null, counties: [], practice_area: null, clients_identified: null, evidence: '', source_url: '', source_urls: [], confidence: 'low', referral_potential: 'low', landlord_side: true },
    ] }),
    enrich: (lead) => lead.attorney_name === 'J Mike Williams'
      ? { found: true, firm_name: 'Williams Law', phone: '(770) 555-0199', phone_is_firm_main_line: true, email: 'mike@williamslaw.example', website: 'https://williamslaw.example', city: 'Decatur', county: 'DeKalb', practice_summary: 'Represents apartment owners in evictions.', clients_identified: 'Fogelman Management Group', evidence: 'Firm page: "we file dispossessories for management companies".', source_url: 'https://williamslaw.example', source_urls: ['https://williamslaw.example'], landlord_side: true, referral_potential: 'high', notes: 'High volume.' }
      : { found: false, notes: null },
  });
  const run = await runAll({ db, ai, log: () => {} }, { web_passes: 1 });
  assert.equal(run.status, 'completed');
  assert.equal(ai.calls.discover.length, 1);
  assert.equal(ai.calls.enrich.length, 2, 'both court leads were researched');
  const jmw = db.T.leads.find(l => l.attorney_name === 'J Mike Williams');
  assert.equal(jmw.phone, '(770) 555-0199');
  assert.equal(jmw.firm_name, 'Williams Law');
  assert.equal(jmw.enrichment_status, 'done');
  assert.match(jmw.evidence, /Court records:/);
  assert.match(jmw.evidence, /Web: Firm page/);
  assert.match(jmw.research_notes, /firm main line/);
  const mb = db.T.leads.find(l => l.attorney_name === 'Mario Breedlove');
  assert.equal(mb.enrichment_status, 'done');
  assert.match(mb.research_notes, /State Bar of Georgia/);
  assert.ok(db.T.leads.some(l => l.attorney_name === 'Jane Landlordlaw' && l.source_kind === 'web_research' && l.phone === '(404) 555-0100'));
  assert.ok(!db.T.leads.some(l => l.attorney_name === 'Tenant Defender'));
  assert.ok(!db.T.leads.some(l => l.attorney_name === 'No Evidence'));
  assert.equal(db.T.leads.length, 3);
  assert.equal(run.counts.inserted, 3);
  assert.equal(run.counts.skipped, 3);
  assert.equal(run.counts.enriched, 2);
  assert.ok(run.counts.ai_cost > 0);
  // a later run does not research the already-enriched attorneys again
  const ai2 = fakeAi();
  await runAll({ db, ai: ai2, log: () => {} }, { web_passes: 0 });
  assert.equal(ai2.calls.enrich.length, 0);
});

test('a model failure is recorded on the run and does not stop the rest of the run', async () => {
  const db = createFakeDb({}, { courtRows });
  let n = 0;
  const ai = fakeAi({ discover: () => { n++; throw new Error('anthropic 529 overloaded'); }, enrich: () => ({ found: false, notes: null }) });
  const run = await runAll({ db, ai, log: () => {} }, { web_passes: 1, court_records: true });
  assert.equal(run.status, 'completed_with_errors');
  assert.ok(n >= 2, 'the pass was retried');
  assert.ok(run.errors.length >= 1);
  assert.equal(db.T.leads.length, 2, 'court leads still added');
});

test('buildPasses rotates county slices and honours the requested count', () => {
  const p = buildPasses({ web_passes: 3 }, { counties: 'Fulton,DeKalb,Gwinnett,Cobb,Clayton,Douglas,Henry' });
  assert.equal(p.length, 3);
  assert.deepEqual(p[0].counties, ['Fulton', 'DeKalb', 'Gwinnett', 'Cobb', 'Clayton', 'Douglas', 'Henry']);
  assert.deepEqual(p[1].counties, ['Fulton', 'DeKalb', 'Gwinnett']);
  assert.deepEqual(p[2].counties, ['Cobb', 'Clayton', 'Douglas']);
  assert.notEqual(p[0].focus, p[1].focus);
  const q = buildPasses({ counties: ['Henry', 'Clayton'], web_passes: 2, focus: 'firms near Stockbridge' }, {});
  assert.deepEqual(q[1].counties, ['Henry', 'Clayton']);
  assert.match(q[0].focus, /Stockbridge/);
  assert.equal(buildPasses({ web_passes: 0 }, {}).length, 0);
  assert.equal(buildPasses({ web_passes: 99 }, {}).length, 6);
});
