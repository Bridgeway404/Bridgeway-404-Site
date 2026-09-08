import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDb } from './fakedb.js';
import { processJobs, ingestRecord, enrichCompany } from '../lib/pipeline.js';

const fakeHttp = (handlers = {}) => ({ stats: { requests: 0 }, async get(url) { this.stats.requests++; for (const [k, v] of Object.entries(handlers)) if (url.includes(k)) return typeof v === 'function' ? v(url) : v; return { ok: false, status: 404, text: null, bytes: null }; } });

function source(id, county, kind, discover) { return { id, county, kind, label: id, enabledByDefault: true, discover }; }

async function runAll(env) {
  const run = await env.db.createRun('manual');
  let r; let guard = 0;
  do { r = await processJobs(env, { timeBudgetMs: 5000 }); } while (r.remaining > 0 && ++guard < 20);
  return env.db.getRun(run.id);
}

test('one source failing does not fail the run or remove data from other counties', async () => {
  const db = createFakeDb();
  const good = source('henry_ok', 'Henry', 'eviction', async () => ({ records: [
    { source_id: 'henry_ok', external_id: 'case:MGCD1', url: 'https://h/1', kind: 'eviction_case', county: 'Henry', case_number: 'MGCD1', plaintiff_name: 'Pegasus Residential, LLC', community_name: 'Somerset Luxury Apartments', stage: 'hearing_scheduled', hearing_date: '2026-09-01', plaintiff_is_entity: true, evidence: [{ claim: 'on calendar', url: 'https://h/1' }] },
  ], cursor: {} }));
  const bad = source('fulton_bad', 'Fulton', 'foreclosure', async () => { throw new Error('HTTP 429 rate limited'); });
  const env = { db, http: fakeHttp(), sources: [good, bad], ai: null, log: () => {} };
  const run = await runAll(env);
  assert.equal(run.status, 'completed_with_errors');
  assert.deepEqual(run.sources_succeeded, ['henry_ok']);
  assert.deepEqual(run.sources_failed, ['fulton_bad']);
  assert.equal(db.T.properties.length, 1);
  assert.equal(db.T.source_state.find(s => s.source_id === 'fulton_bad').consecutive_failures, 1);
  assert.match(db.T.source_state.find(s => s.source_id === 'fulton_bad').last_error, /429/);
  // second run: the failed source still fails, existing data is untouched
  await runAll(env);
  assert.equal(db.T.properties.length, 1);
  assert.equal(db.T.source_state.find(s => s.source_id === 'fulton_bad').consecutive_failures, 2);
});

test('incremental ingestion: already-seen items are not refetched, new ones are', async () => {
  const db = createFakeDb();
  let fetched = [];
  const src = source('dekalb_cal', 'DeKalb', 'eviction', async (ctx) => {
    const ids = ['media:1', 'media:2'];
    const records = [];
    for (const id of ids) {
      if (ctx.seen(id)) continue;
      fetched.push(id);
      records.push({ source_id: 'dekalb_cal', external_id: id, url: 'https://d/' + id, kind: 'calendar_document', county: 'DeKalb', rows: 1 });
      records.push({ source_id: 'dekalb_cal', external_id: 'case:26D' + id.slice(-1), url: 'https://d/' + id, kind: 'eviction_case', county: 'DeKalb', case_number: '26D' + id.slice(-1), plaintiff_name: 'S2 Pleasantdale LLC', community_name: 'The Wynne', stage: 'hearing_scheduled', hearing_date: '2026-09-08', plaintiff_is_entity: true });
    }
    return { records, cursor: { last: ids.length } };
  });
  const env = { db, http: fakeHttp(), sources: [src], ai: null, log: () => {} };
  await runAll(env);
  assert.deepEqual(fetched, ['media:1', 'media:2']);
  fetched = [];
  await runAll(env);
  assert.deepEqual(fetched, [], 'nothing refetched on the second run');
  // two cases at the same community collapse onto one community property with two events
  assert.equal(db.T.properties.length, 1);
  assert.equal(db.T.events.length, 2);
  assert.equal(db.T.properties[0].property_type, 'multifamily');
});

test('repeated foreclosure publication updates one lead; postponement keeps the event; a new sale a year later is a new event', async () => {
  const db = createFakeDb();
  const env = { db, http: fakeHttp(), sources: [], ai: null, log: () => {}, now: () => new Date('2026-09-08T12:00:00Z') };
  const base = { source_id: 'fn', kind: 'foreclosure_notice', county: 'Fulton', property_address: '191 Peachtree St SW', city: 'Atlanta', zip: '30303', sale_date: '2026-10-06', lender: 'Example Bank, N.A.', law_firm: 'Aldridge Pite, LLP', borrower_names: 'John Q Sample', evidence: [{ claim: 'notice', url: 'https://fn/1' }] };
  const a = await ingestRecord(env, { ...base, external_id: 'n1', url: 'https://fn/1', publication_date: '2026-09-03' }, 'run1', {});
  const b = await ingestRecord(env, { ...base, external_id: 'n2', url: 'https://fn/2', publication_date: '2026-09-10' }, 'run1', {});
  assert.equal(a.propertyId, b.propertyId);
  assert.equal(a.eventId, b.eventId);
  assert.equal(db.T.events[0].publication_count, 2);
  assert.equal(db.T.events[0].stage, 'sale_scheduled');
  const c = await ingestRecord(env, { ...base, external_id: 'n3', url: 'https://fn/3', publication_date: '2026-10-08', sale_date: '2026-11-03' }, 'run2', {});
  assert.equal(c.eventId, a.eventId, 'postponed sale stays on the same event');
  assert.equal(db.T.events[0].sale_date, '2026-11-03');
  db.T.events[0].status = 'closed'; db.T.events[0].stage = 'sale_completed';
  const d = await ingestRecord(env, { ...base, external_id: 'n4', url: 'https://fn/4', publication_date: '2027-09-09', sale_date: '2027-10-05' }, 'run3', {});
  assert.notEqual(d.eventId, a.eventId);
  assert.equal(db.T.properties.length, 1);
  // Lender and law firm are recorded as parties, never as the target
  assert.ok(db.T.companies.some(x => x.company_type === 'law_firm'));
  await processJobs(env, { timeBudgetMs: 2000 });
  const p = db.T.properties[0];
  assert.ok(p.target_company_id == null || db.T.companies.find(x => x.id === p.target_company_id).company_type !== 'law_firm');
});

test('eviction stage progression updates the same lead and preserves history; automated sources never regress', async () => {
  const db = createFakeDb();
  const env = { db, http: fakeHttp(), sources: [], ai: null, log: () => {} };
  const base = { source_id: 'cal', kind: 'eviction_case', county: 'DeKalb', case_number: '26D15710', plaintiff_name: 'Colony Holdings, LLC', plaintiff_is_entity: true, url: 'https://c/1', evidence: [] };
  const s = {};
  const r1 = await ingestRecord(env, { ...base, external_id: 'case:26D15710', stage: 'hearing_scheduled', hearing_date: '2026-09-08' }, 'r1', s);
  const r2 = await ingestRecord(env, { ...base, external_id: 'case:26D15710', source: 'manual', stage: 'writ_issued', writ_date: '2026-09-20' }, 'r2', s);
  assert.equal(r1.propertyId, r2.propertyId);
  assert.equal(db.T.events.length, 1);
  assert.equal(db.T.events[0].stage, 'writ_issued');
  assert.equal(db.T.events[0].writ_date, '2026-09-20');
  assert.deepEqual(db.T.history.map(h => h.to_stage), ['hearing_scheduled', 'writ_issued']);
  assert.equal(s.high_priority, 1);
  // a later calendar re-listing at hearing stage must not regress the writ
  await ingestRecord(env, { ...base, external_id: 'case:26D15710', stage: 'hearing_scheduled', hearing_date: '2026-09-22' }, 'r3', s);
  assert.equal(db.T.events[0].stage, 'writ_issued');
  assert.equal(db.T.history.length, 2);
  await processJobs(env, { timeBudgetMs: 2000 });
  const p = db.T.properties[0];
  assert.equal(p.current_stage, 'writ_issued');
  assert.ok(p.opportunity_score >= 35);
  assert.ok(p.research_explanation.includes('writ issued'));
});

test('company caching: one research call per company across many properties, reused until refresh', async () => {
  const db = createFakeDb({ max_company_research_per_run: '5', company_refresh_days: '90' });
  let calls = 0;
  const ai = {
    async researchCompany(name) { calls++; return { found: true, canonical_name: name, company_type: 'property_management', is_individual: false, summary: 'Manages apartments in DeKalb.', website: 'https://example.com', main_phone: '404-555-0100', main_email: null, contact_page_url: 'https://example.com/contact', hq_address: 'Atlanta, GA', parent_company: null, property_manager: null, property_address: null, portfolio_notes: null, sos_control_number: null, registered_agent: null, contacts: [{ name: 'Pat Manager', title: 'Regional Property Manager', email: null, phone: '404-555-0101', phone_type: 'office', profile_url: null, source_url: 'https://example.com/team', evidence: 'Listed on the team page as regional manager for metro Atlanta', confidence: 'medium' }], sources: [{ url: 'https://example.com/team', title: 'Team', note: null }], confidence: 'medium', confidence_reason: 'Company site names the region but not this property' }; },
    async extractNotices() { return { notices: [] }; }, async extractCalendar() { return { rows: [] }; },
  };
  const env = { db, http: fakeHttp(), sources: [], ai, log: () => {} };
  const run = await db.createRun('manual');
  for (let i = 1; i <= 4; i++) {
    await ingestRecord(env, { source_id: 'cal', kind: 'eviction_case', county: 'DeKalb', external_id: 'case:C' + i, case_number: 'C' + i, plaintiff_name: 'Acme Property Management LLC', plaintiff_is_entity: true, stage: 'hearing_scheduled', url: 'https://c/' + i, evidence: [] }, run.id, {});
  }
  await processJobs(env, { timeBudgetMs: 5000 });
  assert.equal(calls, 1, 'four properties, one research call');
  const company = db.T.companies.find(c => /acme/i.test(c.name));
  assert.equal(company.research_status, 'researched');
  assert.equal(db.T.contacts.filter(c => c.company_id === company.id).length, 1);
  assert.equal(db.T.contacts[0].role_category, 'regional_manager');
  // every property now targets the company with the contact and a portfolio bonus
  for (const p of db.T.properties) {
    assert.equal(p.target_company_id, company.id);
    assert.equal(p.target_contact_id, db.T.contacts[0].id);
    assert.ok(p.score_breakdown.some(b => b.factor === 'portfolio'));
  }
  // a fresh company is not re-researched
  await enrichCompany(env, company.id, {}, run.id);
  assert.equal(calls, 1);
  // stale cache is refreshed
  company.researched_at = new Date(Date.now() - 200 * 86400000).toISOString();
  await enrichCompany(env, company.id, {}, run.id);
  assert.equal(calls, 2);
});

test('contact confidence and evidence carry through; individuals are never researched or targeted', async () => {
  const db = createFakeDb();
  let calls = 0;
  const ai = { async researchCompany() { calls++; return null; }, async extractNotices() { return { notices: [] }; } };
  const env = { db, http: fakeHttp(), sources: [], ai, log: () => {} };
  const run = await db.createRun('manual');
  await ingestRecord(env, { source_id: 'cal', kind: 'eviction_case', county: 'Fulton', external_id: 'case:X1', case_number: 'X1', plaintiff_name: 'Mary Landlord', plaintiff_is_entity: false, stage: 'hearing_scheduled', url: 'https://c/1', evidence: [] }, run.id, {});
  await processJobs(env, { timeBudgetMs: 3000 });
  assert.equal(calls, 0, 'individual plaintiffs are not researched');
  assert.equal(db.T.properties[0].target_company_id, null);
  assert.match(db.T.properties[0].research_explanation, /not yet identified/);
});

test('ownership enrichment uses the county GIS and records evidence; corporate owners become companies', async () => {
  const db = createFakeDb();
  const http = fakeHttp({ 'gismaps.fultoncountyga.gov': { ok: true, status: 200, text: JSON.stringify({ features: [{ attributes: { ParcelID: '14 005100040674', Address: '191 PEACHTREE ST NE', Owner: 'BANYAN STREET GAP 191 PEACHTREE OWNERS LLC', OwnerAddr1: '80 SW EIGHTH ST STE 2200', OwnerAddr2: 'MIAMI FL 33130' } }, { attributes: { ParcelID: '17 010100070369', Address: '191 PEACHTREE WAY NE', Owner: 'DANCKAERT MICHAEL L', OwnerAddr1: '', OwnerAddr2: '' } }] }) } });
  const env = { db, http, sources: [], ai: null, log: () => {}, now: () => new Date('2026-09-08T12:00:00Z') };
  const run = await db.createRun('manual');
  await ingestRecord(env, { source_id: 'fn', kind: 'foreclosure_notice', county: 'Fulton', external_id: 'n1', url: 'https://fn/1', property_address: '191 Peachtree St NE', city: 'Atlanta', sale_date: '2026-10-06', publication_date: '2026-09-03', evidence: [] }, run.id, {});
  await processJobs(env, { timeBudgetMs: 3000 });
  const p = db.T.properties[0];
  assert.equal(p.owner_name, 'BANYAN STREET GAP 191 PEACHTREE OWNERS LLC');
  assert.equal(p.parcel_id, '14 005100040674');
  assert.ok(p.owner_company_id);
  assert.ok(db.T.evidence.some(e => e.subject_type === 'property' && /Owner of record/.test(e.claim) && e.source_url.includes('gismaps')));
  assert.equal(db.T.rels.find(r => r.relationship === 'owner').confidence, 'high');
  assert.equal(p.target_company_id, p.owner_company_id, 'pre-sale corporate owner is the target');
});

test('chunked discovery: a source that reports `more` is re-queued until done, totals accumulate, each chunk ends the invocation', async () => {
  const db = createFakeDb({ max_documents_per_job: '2' });
  let calls = 0;
  const docs = ['d1', 'd2', 'd3', 'd4', 'd5'];
  const src = source('fulton_cal', 'Fulton', 'eviction', async (ctx) => {
    calls++;
    const records = []; let fetched = 0, more = false;
    for (const id of docs) {
      if (ctx.seen('doc:' + id)) continue;
      if (fetched >= ctx.maxNewItems) { more = true; break; }
      fetched++;
      records.push({ source_id: 'fulton_cal', external_id: 'doc:' + id, url: 'https://f/' + id, kind: 'calendar_document', county: 'Fulton', rows: 1 });
      records.push({ source_id: 'fulton_cal', external_id: 'case:' + id, url: 'https://f/' + id, kind: 'eviction_case', county: 'Fulton', case_number: '26ED' + id, plaintiff_name: 'Owner ' + id + ' LLC', plaintiff_is_entity: true, stage: 'hearing_scheduled', hearing_date: '2026-09-09' });
    }
    return { records, more, cursor: {}, diagnostics: { calendars_fetched: fetched } };
  });
  const env = { db, http: fakeHttp(), sources: [src], ai: null, log: () => {} };
  const run = await db.createRun('manual');
  // Each processJobs call stops after one heavy chunk, like a fresh edge invocation.
  const r1 = await processJobs(env, { timeBudgetMs: 5000 });
  assert.equal(calls, 1);
  assert.ok(r1.remaining > 0, 'the next chunk is queued');
  let guard = 0; let r = r1;
  while (r.remaining > 0 && ++guard < 20) r = await processJobs(env, { timeBudgetMs: 5000 });
  assert.equal(calls, 3, 'five documents in chunks of two = three discovery jobs');
  const rs = db.T.run_sources.find(x => x.source_id === 'fulton_cal');
  assert.equal(rs.status, 'ok');
  assert.equal(rs.items_seen, 10);
  assert.equal(rs.detail.calendars_fetched, 5);
  assert.equal(rs.detail.chunks, 3);
  assert.equal(db.T.properties.length, 5);
  const finished = await db.getRun(run.id);
  assert.equal(finished.status, 'completed');
});
