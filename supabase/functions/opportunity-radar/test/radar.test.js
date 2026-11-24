// Synthetic data only (see fixtures/README.md). The network is never touched:
// the HTTP client is a fake that serves canned responses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { addressKey, nameKey, pick, toCents, territoryTier } from '../lib/normalize.js';
import { buildQueryUrl, mapPermit } from '../lib/sources/arcgis.js';
import { buildSamUrl, mapSam } from '../lib/sources/sam.js';
import { SOURCES, enabledSources } from '../lib/sources/index.js';
import { scoreOpportunity } from '../lib/scoring.js';
import { dedupe } from '../lib/dedupe.js';
import { runRadar, createMemoryStore } from '../lib/pipeline.js';

const NOW = '2026-11-24T10:00:00Z';
const ms = (iso) => new Date(iso).getTime();
const GENERIC = { permitNumber: ['PermitNumber', 'PERMIT_NUMBER'], date: ['IssuedDate', 'APPLIED_DATE'], address: ['Address', 'ADDRESS'], permitType: ['PermitType', 'PERMIT_TYPE'], workClass: ['WorkClass', 'WORK_CLASS'], description: ['Description', 'DESCRIPTION'], valuation: ['Valuation', 'JOB_VALUE'], contractor: ['ContractorCompanyName', 'CONTRACTOR'], occupancy: ['Occupancy'], status: ['Status'] };
const permitSource = (id, county) => ({ kind: 'arcgis_permits', dateField: 'IssuedDate', fields: GENERIC, terms: 'synthetic', id, county, enabled: true, verified: true, layerUrl: `https://example.test/${id}/FeatureServer/0` });

const ATL = { features: [
  { attributes: { PermitNumber: 'BB-2026-0001', IssuedDate: ms('2026-11-20T00:00:00Z'), Address: '100 Sample Street NW', PermitType: 'Commercial', WorkClass: 'Interior Demolition', Description: 'Interior demo of second floor office', Valuation: 180000, ContractorCompanyName: 'Example Builders, LLC', Occupancy: 'Office' } },
  { attributes: { PermitNumber: 'BB-2026-0002', IssuedDate: ms('2026-11-21T00:00:00Z'), Address: '22 Placeholder Ave SE', PermitType: 'Residential', WorkClass: 'Alteration', Description: 'Kitchen and bath remodel', Valuation: '$65,000', ContractorCompanyName: null } },
  { attributes: { PermitNumber: 'BE-2026-0003', IssuedDate: ms('2026-11-22T00:00:00Z'), Address: '5 Demo Lane', PermitType: 'Electrical', WorkClass: 'Electrical', Description: 'Panel upgrade', Valuation: 4000, ContractorCompanyName: 'Sparks Example Inc' } },
  { attributes: { PermitNumber: 'BB-2026-0001', IssuedDate: ms('2026-11-20T00:00:00Z'), Address: '100 Sample Street NW', PermitType: 'Commercial', WorkClass: 'Interior Demolition', Description: 'Interior demo of second floor office', Valuation: 180000, ContractorCompanyName: 'Example Builders, LLC' } },
  { attributes: { IssuedDate: ms('2026-11-22T00:00:00Z'), Address: 'no permit number' } },
] };
const DEK = { features: [
  // Same job as BB-2026-0001 seen in a second layer under another number: must merge.
  { attributes: { PERMIT_NUMBER: 'AP-77', APPLIED_DATE: ms('2026-11-12T00:00:00Z'), ADDRESS: '100 Sample St. N.W., Atlanta, GA 30303', PERMIT_TYPE: 'Building', WORK_CLASS: 'Interior Demolition', DESCRIPTION: 'Interior demo', JOB_VALUE: 150000, CONTRACTOR: 'Example Builders' } },
  { attributes: { PERMIT_NUMBER: 'AP-78', APPLIED_DATE: ms('2026-11-18T00:00:00Z'), ADDRESS: '9 Fictional Rd', PERMIT_TYPE: 'Building', WORK_CLASS: 'Demolition', DESCRIPTION: 'Full demolition of single family dwelling', JOB_VALUE: 30000, CONTRACTOR: 'Madeup Demolition Co' } },
] };
const SAM = { totalRecords: 3, opportunitiesData: [
  { noticeId: 'n-1', title: 'Bulk debris hauling and vacant lot cleanout services', type: 'Solicitation', naicsCode: '562111', postedDate: '2026-11-19', responseDeadLine: '2026-12-10T17:00:00-05:00', typeOfSetAsideDescription: 'Total Small Business Set-Aside', fullParentPathName: 'EXAMPLE AGENCY', placeOfPerformance: { city: { name: 'Atlanta' }, state: { code: 'GA' }, zip: '30303' }, uiLink: 'https://sam.gov/opp/n-1/view' },
  { noticeId: 'n-2', title: 'Debris hauling', type: 'Solicitation', naicsCode: '562111', postedDate: '2026-11-19', responseDeadLine: '2026-12-10T17:00:00-05:00', placeOfPerformance: { city: { name: 'Savannah' }, state: { code: 'GA' } } },
  { noticeId: 'n-3', title: 'Aircraft engine parts', type: 'Solicitation', naicsCode: '562111', postedDate: '2026-11-19', responseDeadLine: '2026-12-10T17:00:00-05:00', placeOfPerformance: { city: { name: 'Atlanta' }, state: { code: 'GA' } } },
] };

function fakeHttp(routes, calls = []) {
  return { calls, async get(url) {
    calls.push(url);
    for (const [frag, body] of routes) if (url.includes(frag)) return body instanceof Error ? { ok: false, status: 503, text: '' } : { ok: true, status: 200, text: JSON.stringify(body) };
    return { ok: false, status: 404, text: '' };
  } };
}

test('normalise: address variants collapse to one key; names ignore legal suffixes', () => {
  assert.equal(addressKey('100 Sample Street NW'), addressKey('100 Sample St. N.W., Atlanta, GA 30303'));
  assert.equal(addressKey('100 Sample St NW Suite 200'), addressKey('100 Sample Street NW'));
  assert.equal(addressKey('no number here'), null);
  assert.equal(nameKey('Example Builders, LLC'), nameKey('The Example Builders Inc.'));
  assert.equal(toCents('$65,000'), 6500000);
  assert.equal(pick({ permit_number: 'X1' }, ['PermitNumber', 'PERMIT_NUMBER']), 'X1');
  assert.equal(territoryTier('DeKalb County'), 'core');
  assert.equal(territoryTier('Cherokee'), 'outside');
});

test('arcgis: query asks only for recent rows, newest first, as JSON', () => {
  const u = new URL(buildQueryUrl('https://example.test/L/FeatureServer/0/', { dateField: 'IssuedDate', since: '2026-11-10T08:00:00Z' }));
  assert.equal(u.pathname, '/L/FeatureServer/0/query');
  assert.equal(u.searchParams.get('where'), "IssuedDate >= TIMESTAMP '2026-11-10 00:00:00'");
  assert.equal(u.searchParams.get('f'), 'json');
  assert.equal(u.searchParams.get('returnGeometry'), 'false');
});

test('arcgis: maps differing field names; a row without a permit number is dropped', () => {
  const a = mapPermit(permitSource('a', 'Fulton'), ATL.features[0].attributes);
  const d = mapPermit(permitSource('d', 'DeKalb'), DEK.features[0].attributes);
  assert.equal(a.source_ref, 'a:BB-2026-0001'); assert.equal(a.value_cents, 18000000);
  assert.equal(d.party_name, 'Example Builders'); assert.equal(d.county, 'DeKalb');
  assert.equal(mapPermit(permitSource('a', 'Fulton'), ATL.features[4].attributes), null);
});

test('sam: request carries NAICS, state and date window; notice maps to a bid', () => {
  const u = new URL(buildSamUrl({ apiKey: 'k', since: '2026-11-10T00:00:00Z', until: NOW, naics: '562111' }));
  assert.equal(u.searchParams.get('postedFrom'), '11/10/2026'); assert.equal(u.searchParams.get('state'), 'GA');
  const b = mapSam(SAM.opportunitiesData[0]);
  assert.equal(b.type, 'bid'); assert.equal(b.source_ref, 'sam_gov:n-1'); assert.equal(b.city, 'Atlanta');
});

test('scoring: explainable factors; trade permits, stale permits and out-of-area work are excluded', () => {
  const src = permitSource('a', 'Fulton');
  const demo = scoreOpportunity(mapPermit(src, ATL.features[0].attributes), NOW);
  assert.ok(demo.score >= 80, `demo scored ${demo.score}`);
  assert.ok(demo.factors.some((f) => /contractor named/.test(f.label)));
  const remodelNoContractor = scoreOpportunity(mapPermit(src, ATL.features[1].attributes), NOW);
  assert.ok(remodelNoContractor.score < demo.score);
  assert.equal(scoreOpportunity(mapPermit(src, ATL.features[2].attributes), NOW).excluded, 'trade_only_permit');
  assert.equal(scoreOpportunity({ ...mapPermit(src, ATL.features[0].attributes), event_at: '2026-09-01T00:00:00Z' }, NOW).excluded, 'too_old');
  assert.equal(scoreOpportunity({ ...mapPermit(src, ATL.features[0].attributes), county: 'Cherokee' }, NOW).excluded, 'outside_territory');
  assert.equal(scoreOpportunity(mapSam(SAM.opportunitiesData[1]), NOW).excluded, 'outside_territory');
  assert.equal(scoreOpportunity(mapSam(SAM.opportunitiesData[2]), NOW).excluded, 'no_relevant_scope');
  assert.equal(scoreOpportunity({ ...mapSam(SAM.opportunitiesData[0]), due_at: '2026-11-25T10:00:00Z' }, NOW).excluded, 'due_too_soon');
});

test('dedupe: repeated rows collapse; the same job in two layers merges; different jobs stay apart', () => {
  const a = permitSource('a', 'Fulton'); const d = permitSource('d', 'DeKalb');
  const items = [...ATL.features.map((f) => mapPermit(a, f.attributes)), ...DEK.features.map((f) => mapPermit(d, f.attributes))].filter(Boolean);
  const r = dedupe(items);
  assert.equal(r.duplicateRefs, 1);
  assert.equal(r.merged.length, 1);
  const merged = r.kept.find((k) => k.also_seen_as);
  assert.deepEqual(merged.also_seen_as, ['a:BB-2026-0001']);
  assert.equal(merged.value_cents, 18000000);
  assert.equal(r.kept.length, 4);
  // Same address, different contractor -> not the same job.
  const other = dedupe([{ ...items[0] }, { ...items[0], source_ref: 'z:1', party_name: 'A Different Example Firm' }]);
  assert.equal(other.merged.length, 0);
});

test('pipeline: one failing source does not stop the run; the digest is capped and explains itself', async () => {
  const sources = [permitSource('atl', 'Fulton'), permitSource('dek', 'DeKalb'), { id: 'broken', kind: 'arcgis_permits', county: 'Cobb', layerUrl: 'https://example.test/broken/FeatureServer/0', dateField: 'X', fields: GENERIC }, { id: 'sam_gov', kind: 'sam_gov', naics: ['562111'] }];
  const http = fakeHttp([['/atl/', ATL], ['/dek/', DEK], ['/broken/', new Error('down')], ['api.sam.gov', SAM]]);
  const store = createMemoryStore();
  const r = await runRadar({ sources, http, store, now: NOW, secrets: { sam_gov: 'test-key' }, digestLimit: 2 });
  assert.equal(r.summary.status, 'partial');
  assert.equal(r.summary.sources.broken.ok, false);
  assert.equal(r.summary.fetched, 9);
  assert.equal(r.summary.merged, 1);
  assert.equal(r.summary.excluded.trade_only_permit, 1);
  assert.equal(r.summary.created, 4);                         // 3 permits + 1 bid
  assert.equal(r.digest.items.length, 2);
  assert.ok(r.digest.items[0].score >= r.digest.items[1].score);
  assert.match(r.digest.text, /Why: /);
  assert.ok(!http.calls.some((u) => u.includes('test-key') && !u.includes('api.sam.gov')));
});

test('pipeline: a second run creates nothing new and surfaces nothing twice', async () => {
  const sources = [permitSource('atl', 'Fulton')];
  const store = createMemoryStore();
  const first = await runRadar({ sources, http: fakeHttp([['/atl/', ATL]]), store, now: NOW });
  const second = await runRadar({ sources, http: fakeHttp([['/atl/', ATL]]), store, now: '2026-11-25T10:00:00Z' });
  assert.equal(first.summary.created, 2);
  assert.equal(second.summary.created, 0);
  assert.equal(second.digest.items.length, 0);
});

test('pipeline: a permit with no contractor is never marked usable in outreach; SAM without a key fails cleanly', async () => {
  const store = createMemoryStore();
  const r = await runRadar({ sources: [permitSource('atl', 'Fulton'), { id: 'sam_gov', kind: 'sam_gov' }], http: fakeHttp([['/atl/', ATL]]), store, now: NOW });
  assert.equal(store.rows.get('atl:BB-2026-0002').usable_in_outreach, false);
  assert.equal(store.rows.get('atl:BB-2026-0001').usable_in_outreach, true);
  assert.match(r.summary.sources.sam_gov.error, /no API key/);
});

test('registry: every source ships disabled here; only a live-verified one may carry verified: true', () => {
  assert.equal(enabledSources().length, 0);
  assert.deepEqual(SOURCES.filter((x) => x.verified).map((x) => x.id), ['dekalb_permits']);
  assert.ok(SOURCES.every((s) => s.terms));
});
