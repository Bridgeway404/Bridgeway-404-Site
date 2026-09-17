import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDb } from './fakedb.js';
import { processJobs, scoreBuyer, ingestRecord } from '../lib/pipeline.js';

const NOW = new Date('2026-09-17T12:00:00Z');
const base = (over = {}) => ({ log: () => {}, now: () => NOW, throttleMs: 0, ...over });

/** Fake assessor: answers ArcGIS owner queries per parcel id. */
function fakeHttp(owners) {
  return {
    async get(url) {
      const m = /ParcelID%3D%27([^%]+)%27|PARCELID%3D%27([^%]+)%27|PIN%3D%27([^%]+)%27|PARID%3D%27([^%]+)%27/.exec(url);
      const raw = decodeURIComponent((m && (m[1] || m[2] || m[3] || m[4])) || '').replace(/\+/g, ' ');
      const key = Object.keys(owners).find(k => k === raw || k.replace(/[^A-Z0-9]/gi, '') === raw.replace(/[^A-Z0-9]/gi, ''));
      if (key === undefined) return { ok: true, status: 200, text: JSON.stringify({ features: [] }) };
      if (owners[key] === 'ERROR') return { ok: false, status: 500, text: '' };
      const o = owners[key];
      return { ok: true, status: 200, text: JSON.stringify({ features: [{ attributes: { PARCELID: key, ParcelID: key, PIN: key, PARID: key, OWNERNME1: o.owner, Owner: o.owner, OWNER: o.owner, PSTLADDRESS: o.mail, PSTLCITY: o.city, PSTLSTATE: 'GA', PSTLZIP5: o.zip, OwnerAddr1: o.mail, OwnerAddr2: [o.city, 'GA', o.zip].join(' '), CLASSDSCRP: o.cls || 'R3', ClassCode: o.cls || 'R3', DIGCLASS: o.cls || 'R3', SITEADDRESS: o.site || null } }] }) };
    },
  };
}

function src(id, county, kind, records, opts = {}) {
  return { id, county, kind, label: id, notes: null, async discover() { if (opts.throw) throw new Error('site down'); return { records: records.map(r => ({ county, sale_type: 'tax_sale', list_url: 'https://example.org/' + id, list_label: id, evidence: `${id}: parcel ${r.parcel_id}`, ...r })), documents: [{ source_id: id, county, url: 'https://example.org/' + id + '.pdf', status_code: opts.status || 200, parsed_count: records.length }], diagnostics: opts.diag || [] }; } };
}

async function runAll(db, env) {
  const run = await db.createRun({}, env.trigger || 'manual');
  let guard = 0;
  while ((await db.queuedJobCount()) > 0 && guard++ < 50) await processJobs({ db, ...env }, { timeBudgetMs: 60000 });
  return db.getRun(run.id);
}

test('Douglas overage file: purchaser named → one buyer per purchaser, repeat purchaser counted, contact needed until a phone exists', async () => {
  const db = createFakeDb();
  const sources = [src('douglas_excess_funds', 'Douglas', 'sold', [
    { parcel_id: '00480150117', sale_date: '2026-04-07', list_owner_name: 'DEAN C & JOYCE NELSEN', purchaser_name: 'CHAD MANION', purchase_price: 5600, sold: true },
    { parcel_id: '02180250001', sale_date: '2026-04-07', list_owner_name: 'MATEOS BRIGIDO AGUILAR', purchaser_name: 'CHAD MANION', purchase_price: 10500, sold: true },
    { parcel_id: '07320130011', sale_date: '2025-08-05', list_owner_name: 'VARNER DEBBIE M ESTATE', purchaser_name: 'MKIM RD LLC / MAXMILLIAN SUN KIM', purchase_price: 89000, sold: true },
    { parcel_id: '06451820009', sale_date: '2023-06-06', list_owner_name: 'IRVIN CADESIA', purchaser_name: 'GREGORY BAKER, TAX COMMISSIONER', purchase_price: 11500, sold: true },
  ])];
  const run = await runAll(db, base({ sources, http: fakeHttp({}) }));
  assert.equal(run.status, 'completed');
  assert.equal(db.T.buyers.length, 2, 'county bid-in is not a buyer');
  const chad = db.T.buyers.find(b => b.buyer_name === 'Chad Manion');
  assert.equal(chad.recent_acquisitions, 2);
  assert.equal(chad.qualified, false, 'individual with no phone is not yet on the call list');
  assert.equal(chad.priority, 'Low');
  assert.equal(db.T.properties.find(p => p.parcel_id === '00480150117').research_status, 'contact_research_needed');
  const mkim = db.T.buyers.find(b => b.buyer_name === 'Mkim Rd LLC');
  assert.equal(mkim.contact_name, 'Maxmillian Sun Kim');
  assert.equal(mkim.buyer_type, 'investor_company');
  assert.equal(db.T.properties.find(p => p.parcel_id === '06451820009').research_status, 'not_useful');
  assert.equal(run.counts.sales_reviewed, 4);
  assert.equal(run.counts.buyers_identified, 0, 'purchasers came from the county, not the assessor');
  // A phone added by hand (or by enrichment) qualifies the repeat buyer as High on the next run.
  chad.phone = '(770) 555-0100';
  const run2 = await runAll(db, base({ sources, http: fakeHttp({}) }));
  assert.equal(run2.status, 'completed');
  assert.equal(db.T.buyers.find(b => b.id === chad.id).qualified, true);
  assert.equal(db.T.buyers.find(b => b.id === chad.id).priority, 'High');
  assert.equal(db.T.properties.find(p => p.parcel_id === '00480150117').research_status, 'qualified');
  assert.equal(db.T.buyers.length, 2, 'second run merges instead of duplicating');
});

test('DeKalb excess-funds row + assessor owner change → buyer identified with mailing address; unchanged owner stays in the queue', async () => {
  const db = createFakeDb();
  const sources = [src('dekalb_excess_funds', 'DeKalb', 'sold', [
    { parcel_id: '16 009 02 036', address: '8 B QUAIL RUN', city: 'DECATUR', zip: '30035', sale_date: '2025-10-07', list_owner_name: 'BOYD BROOKS & LAKEMBA WARD', sold: true },
    { parcel_id: '16 009 02 037', address: '10 QUAIL RUN', city: 'DECATUR', zip: '30035', sale_date: '2025-10-07', list_owner_name: 'SOMEONE ELSE', sold: true },
    { parcel_id: '16 169 01 052', address: '7116 MCDANIEL ST', city: 'LITHONIA', zip: '30058', sale_date: '2025-11-04', list_owner_name: 'ROCK BOTTOM FORWARD INC', sold: true },
    { parcel_id: '15 093 07 006', address: '3181 WESLEY CHAPEL RD', city: 'DECATUR', zip: '30034', sale_date: '2026-04-07', list_owner_name: 'U S HOUSING & URBAN DEV', sold: true },
    { parcel_id: '15 000 00 001', address: '0 NEW ST', city: 'ATLANTA', zip: '30307', sale_date: '2025-12-02', list_owner_name: 'MONTEZ AUSTIN', sold: true },
    { parcel_id: '18 046 04 198', address: '440 BROWNELL AVENUE', city: 'SCOTTDALE', zip: '30079', sale_date: '2026-04-07', list_owner_name: 'UNKNOWN OWNER - UNRETURNED PROPERTY', sold: true },
  ])];
  const http = fakeHttp({
    '16 009 02 036': { owner: 'JRW CAPITAL LLC', mail: '7350 PEACHTREE DUNWOODY RD', city: 'SANDY SPRINGS', zip: '30328' },
    '16 009 02 037': { owner: 'JRW CAPITAL LLC', mail: '7350 PEACHTREE DUNWOODY RD', city: 'SANDY SPRINGS', zip: '30328' },
    '16 169 01 052': { owner: 'ROCK BOTTOM FORWARD INC', mail: '5005 SNAPFINGER WOODS DR', city: 'DECATUR', zip: '30035' },
    '15 093 07 006': { owner: 'WELLS FARGO BANK NA', mail: 'PO BOX 1', city: 'DES MOINES', zip: '50306' },
    '15 000 00 001': { owner: 'NEW OWNER LLC', mail: 'PO BOX 2', city: 'ATLANTA', zip: '30307', cls: 'R4 Vacant Land' },
    '18 046 04 198': { owner: 'GEORGIA TITLE SOURCE LLC', mail: '2107 N DECATUR RD STE 358', city: 'DECATUR', zip: '30033' },
  });
  const run = await runAll(db, base({ sources, http }));
  assert.equal(run.status, 'completed');
  const jrw = db.T.buyers.find(b => b.buyer_name === 'JRW Capital LLC');
  assert.ok(jrw, 'assessor new owner becomes the buyer');
  assert.equal(jrw.recent_acquisitions, 2);
  assert.equal(jrw.mailing_address, '7350 PEACHTREE DUNWOODY RD, SANDY SPRINGS GA 30328');
  assert.equal(jrw.qualified, true, 'company with a public mailing address is contactable');
  assert.equal(jrw.priority, 'High', 'repeat purchaser');
  assert.equal(jrw.counties.length, 1);
  const rb = db.T.properties.find(p => p.parcel_id === '16 169 01 052');
  assert.equal(rb.research_status, 'buyer_research_needed');
  assert.match(rb.status_reason, /still shows the pre-sale owner/);
  assert.equal(rb.owner_changed, false);
  const wf = db.T.buyers.find(b => /Wells Fargo/i.test(b.buyer_name));
  assert.ok(wf); assert.equal(wf.is_institutional, true); assert.equal(wf.qualified, false); assert.equal(wf.priority, 'Low');
  assert.equal(db.T.properties.find(p => p.parcel_id === '15 000 00 001').research_status, 'not_useful');
  assert.equal(run.counts.buyers_identified, 4, 'the vacant lot is dropped before it becomes a buyer; the unknown-prior-owner sale counts');
  assert.equal(run.counts.repeat_buyers, 1);
  assert.equal(run.counts.qualified_added, 2);
  const gts = db.T.buyers.find(b => b.buyer_name === 'Georgia Title Source LLC');
  assert.ok(gts && gts.qualified, 'sale confirmed by the county + assessor owner = purchaser even when the prior owner was unknown');
  assert.match(db.T.properties.find(p => p.parcel_id === '18 046 04 198').sold_evidence, /prior owner as unknown/);
  assert.ok(db.T.activity.some(a => a.buyer_id === jrw.id && /Qualified/.test(a.note)));
});

test('advertised lists: future sale → upcoming; passed sale with unchanged owner → awaiting; owner change after the sale date → buyer identified', async () => {
  const db = createFakeDb();
  const sources = [src('dekalb_tax_sale_listing', 'DeKalb', 'upcoming', [
    { parcel_id: '15 004 03 090', address: '3479 HICKORY WALK LN', sale_date: '2026-10-06', list_owner_name: 'DYNAMIC EQUITIES LLC', sold: false },
    { parcel_id: '15 004 03 091', address: '3481 HICKORY WALK LN', sale_date: '2026-08-04', list_owner_name: 'OLD OWNER', sold: false },
    { parcel_id: '15 004 03 092', address: '3483 HICKORY WALK LN', sale_date: '2026-08-04', list_owner_name: 'STAYS PUT', sold: false },
  ])];
  const http = fakeHttp({ '15 004 03 091': { owner: 'ATL FLIP HOMES LLC', mail: '1 MAIN ST', city: 'ATLANTA', zip: '30303' }, '15 004 03 092': { owner: 'STAYS PUT', mail: '3483 HICKORY WALK LN', city: 'DECATUR', zip: '30032' } });
  const run = await runAll(db, base({ sources, http }));
  assert.equal(run.status, 'completed');
  assert.equal(db.T.properties.find(p => p.parcel_id === '15 004 03 090').research_status, 'upcoming');
  const changed = db.T.properties.find(p => p.parcel_id === '15 004 03 091');
  assert.equal(changed.research_status, 'qualified');
  assert.equal(changed.sold_confirmed, true);
  assert.match(changed.sold_evidence, /owner of record is now ATL FLIP HOMES LLC/);
  const same = db.T.properties.find(p => p.parcel_id === '15 004 03 092');
  assert.equal(same.research_status, 'awaiting_sale_result');
  assert.equal(same.sold_confirmed, false);
  assert.equal(run.counts.advertised_seen, 3);
  const b = db.T.buyers.find(x => x.buyer_name === 'ATL Flip Homes LLC');
  assert.equal(b.buyer_type, 'flipper');
  assert.equal(b.priority, 'Medium');
});

test('one failing source does not end the run; redeemed and Henry (no assessor) rows are handled; scanned/blocked notes are recorded', async () => {
  const db = createFakeDb();
  const sources = [
    src('cobb_tax_sale_lists', 'Cobb', 'upcoming', [], { throw: true }),
    src('fulton_sheriff_levy_lists', 'Fulton', 'upcoming', [], { status: 200, diag: ['https://x/levy.pdf: scanned image, no text layer'] }),
    src('henry_excess_funds', 'Henry', 'sold', [
      { parcel_id: '043A01137000', address: '101 WAVERLY BLVD, ELLENWOOD', sale_date: '2026-02-03', list_owner_name: 'AKK INVESTMENTS LLC', purchase_price: 30000, sold: true, redeemed: false },
      { parcel_id: '006A04002000', address: '350 ROBIN HOOD LN', sale_date: '2026-02-03', list_owner_name: 'WOOZEVALT JEAN PIERRE LLC', purchase_price: 32000, sold: true, redeemed: true },
      { parcel_id: '071-01034004', address: 'HWY 42 N', sale_date: '2026-06-02', list_owner_name: 'JDH PROPERTY HOLDINGS LLC', purchase_price: 7800, sold: true, property_hint: 'land only' },
    ]),
  ];
  const run = await runAll(db, base({ sources, http: fakeHttp({}) }));
  assert.equal(run.status, 'completed');
  assert.equal(db.T.sources.cobb_tax_sale_lists.consecutive_failures, 1);
  assert.match(db.T.sources.cobb_tax_sale_lists.last_error, /site down/);
  assert.equal(db.T.sources.fulton_sheriff_levy_lists.consecutive_failures, 1);
  const akk = db.T.properties.find(p => p.parcel_id === '043A01137000');
  assert.equal(akk.research_status, 'buyer_research_needed');
  assert.match(akk.status_reason, /Henry County does not publish owner names/);
  assert.equal(db.T.properties.find(p => p.parcel_id === '006A04002000').research_status, 'not_useful');
  assert.equal(db.T.properties.find(p => p.parcel_id === '071-01034004').research_status, 'not_useful');
  assert.equal(run.counts.source_failures, 2);
  assert.equal(run.counts.counties_checked, 5);
  assert.equal(run.errors.length, 0, 'adapter failures are recorded per source, not as run errors');
});

test('optional Claude enrichment fills business contact and qualifies the buyer; without a key nothing is queued', async () => {
  const db = createFakeDb();
  const sources = [src('douglas_excess_funds', 'Douglas', 'sold', [
    { parcel_id: '07320130011', sale_date: '2025-08-05', list_owner_name: 'VARNER DEBBIE M ESTATE', purchaser_name: 'MKIM RD LLC / MAXMILLIAN SUN KIM', purchase_price: 89000, sold: true },
  ])];
  const noKey = await runAll(db, base({ sources, http: fakeHttp({}) }));
  assert.equal(db.T.jobs.filter(j => j.kind === 'enrich.buyer').length, 0);
  assert.equal(noKey.counts.enriched, 0);
  const ai = { spent: 0, async enrichBuyer(b) { this.spent += 0.02; return { found: true, phone: '7705550199', website: 'https://mkimrd.com', contact_name: 'Max Kim', evidence: 'Company site lists acquisitions line', source_urls: ['https://mkimrd.com/contact'], notes: null }; } };
  const withKey = await runAll(db, base({ sources, http: fakeHttp({}), ai }));
  assert.equal(withKey.status, 'completed');
  assert.equal(withKey.counts.enriched, 1);
  const b = db.T.buyers[0];
  assert.equal(b.phone, '(770) 555-0199');
  assert.equal(b.website, 'https://mkimrd.com');
  assert.equal(b.qualified, true);
  assert.equal(b.priority, 'High');
});

test('scoreBuyer rules', () => {
  const sold = [{ sold_confirmed: true, property_type: 'single_family', research_status: 'buyer_identified' }];
  assert.deepEqual(scoreBuyer({ buyer_name: 'ABC Homes LLC', mailing_address: '1 Main St' }, sold).priority, 'Medium');
  assert.equal(scoreBuyer({ buyer_name: 'ABC Homes LLC', phone: '7705550100' }, sold).priority, 'High');
  assert.equal(scoreBuyer({ buyer_name: 'John Smith', mailing_address: '1 Main St' }, sold).qualified, false);
  assert.equal(scoreBuyer({ buyer_name: 'John Smith', mailing_address: '1 Main St' }, sold.concat(sold)).priority, 'High', 'repeat individual with a mailing address');
  assert.equal(scoreBuyer({ buyer_name: 'John Smith', phone: '7705550100' }, sold).priority, 'Medium');
  assert.equal(scoreBuyer({ buyer_name: 'John Smith', phone: '7705550100' }, sold.concat(sold)).priority, 'High');
  assert.equal(scoreBuyer({ buyer_name: 'Wells Fargo Bank NA', mailing_address: 'PO Box', buyer_type: 'institutional_lender', is_institutional: true }, sold).qualified, false);
  assert.equal(scoreBuyer({ buyer_name: 'ABC Homes LLC', phone: '770' }, [{ sold_confirmed: false, property_type: 'single_family' }]).qualified, false);
});

test('ingestRecord never downgrades research progress and merges evidence', async () => {
  const db = createFakeDb();
  const env = base();
  await ingestRecord({ db, ...env }, 'r1', { county: 'DeKalb', parcel_id: '16 009 02 036', sale_date: '2025-10-07', list_owner_name: 'A', sold: true, evidence: 'excess funds row' });
  const p = db.T.properties[0];
  p.research_status = 'qualified';
  await ingestRecord({ db, ...env }, 'r2', { county: 'DeKalb', parcel_id: '16-009-02-036', sale_date: '2026-10-06', list_owner_name: 'A', sold: false, evidence: 'advertised again' });
  assert.equal(db.T.properties.length, 1);
  assert.equal(p.research_status, 'qualified');
  assert.match(p.evidence, /excess funds row\nadvertised again/);
  assert.equal(p.last_run_id, 'r2');
});

test('each county list parse hands the queue to a fresh invocation (CPU-heavy PDF parsing never accumulates in one isolate)', async () => {
  const db = createFakeDb();
  const sources = [
    src('a_sold', 'Douglas', 'sold', [{ parcel_id: '00480150117', sale_date: '2026-04-07', purchaser_name: 'CHAD MANION', sold: true }]),
    src('b_sold', 'Douglas', 'sold', [{ parcel_id: '02180250001', sale_date: '2026-04-07', purchaser_name: 'CHAD MANION', sold: true }]),
  ];
  await db.createRun({}, 'manual');
  const first = await processJobs({ db, sources, http: fakeHttp({}), ...base() }, { timeBudgetMs: 60000 });
  // run.start + the first source only; the second source waits for the next invocation.
  assert.equal(first.handled, 2);
  assert.ok(first.remaining >= 1);
  const second = await processJobs({ db, sources, http: fakeHttp({}), ...base() }, { timeBudgetMs: 60000 });
  assert.equal(second.handled, 1);
});
