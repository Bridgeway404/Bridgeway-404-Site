import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDeKalbCalendar, parseHenryCalendar, parseFultonCalendar, splitPlaintiff, cutDefendant } from '../lib/parsers/calendar.js';
import { parseRss, bloxAssetPdfUrl, parseWpMedia, parseCivicPlusCalendarLinks, parseHenryCalendarLinks, parseBloxClassifiedLinks } from '../lib/parsers/feeds.js';
import { extractNoticeFields, splitNotices } from '../lib/parsers/notice.js';
import { sniffType, docTextRuns } from '../lib/parsers/doc.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (n) => fs.readFileSync(path.join(here, 'fixtures', n), 'utf8');

test('DeKalb dispossessory calendar: plaintiff side only, tenant names discarded', () => {
  const r = parseDeKalbCalendar(fixture('dekalb_dispo_calendar.txt'));
  assert.equal(r.header.date, '2026-09-08');
  assert.equal(r.header.judge, 'Berryl A. Anderson');
  assert.ok(r.rows.length >= 12);
  const first = r.rows[0];
  assert.equal(first.case_number, '26D15710');
  assert.equal(first.plaintiff_name, 'Colony Holdings, LLC');
  assert.equal(first.plaintiff_attorney, 'BRADLEY FOLSOM');
  assert.equal(first.hearing_date, '2026-09-08');
  const dba = r.rows.find(x => x.case_number === '26D20420');
  assert.equal(dba.plaintiff_name, 'Gray Property 3401 LLC');
  assert.equal(dba.community_name, 'Jackson Square Apartments');
  const trailing = r.rows.find(x => x.case_number === '26D20748');
  assert.equal(trailing.community_name, 'Keswick Apartments');
  const json = JSON.stringify(r.rows);
  assert.ok(!/Placeholder/.test(json), 'no defendant-side text leaks into rows');
});

test('Henry dispossessory calendar: wrapped rows, a/a/f and d/b/a communities, defendants cut', () => {
  const r = parseHenryCalendar(fixture('henry_dispo_calendar.txt'));
  assert.equal(r.header.judge, 'Amanda R. Flora');
  assert.equal(r.header.date, '2026-09-01');
  // 9 rows on the calendar; the one person-vs-person row (no entity, no
  // occupants phrase) is dropped because the plaintiff/tenant boundary cannot
  // be found reliably.
  assert.equal(r.rows.length, 8);
  const byCase = Object.fromEntries(r.rows.map(x => [x.case_number, x]));
  assert.equal(byCase.MGCD2026006167.plaintiff_name, 'PROGRESS RESIDENTIAL BORROWER 11, LLC');
  assert.equal(byCase.MGCD2026006243.plaintiff_name, 'PEGASUS RESIDENTIAL, LLC');
  assert.equal(byCase.MGCD2026006243.community_name, 'SOMERSET LUXURY APARTMENTS');
  assert.equal(byCase.MGCD2026006306.community_name, 'ARGENTO AT THE BRIDGES');
  assert.equal(byCase.MGCD2026006214, undefined, 'person-vs-person row is not kept');
  assert.ok(!/OCCUPANT|PLACEHOLDER/.test(JSON.stringify(r.rows)));
});

test('calendar parsers tolerate single-space column gaps (unpdf output in the edge runtime)', () => {
  // pdf.js keeps 2+ spaces between columns; unpdf collapses them to one.
  const collapse = (s) => s.replace(/[ \t]{2,}/g, ' ');
  const d = parseDeKalbCalendar(collapse(fixture('dekalb_dispo_calendar.txt')));
  assert.equal(d.rows.length, parseDeKalbCalendar(fixture('dekalb_dispo_calendar.txt')).rows.length);
  assert.equal(d.rows[0].plaintiff_name, 'Colony Holdings, LLC');
  const h = parseHenryCalendar(collapse(fixture('henry_dispo_calendar.txt')));
  assert.equal(h.rows.length, 8);
  assert.equal(h.rows.find(x => x.case_number === 'MGCD2026006167').plaintiff_name, 'PROGRESS RESIDENTIAL BORROWER 11, LLC');
  assert.ok(!/OCCUPANT|PLACEHOLDER/.test(JSON.stringify(h.rows)));
});

test('Fulton "Community, Management Company" captions attribute to the operator', () => {
  assert.deepEqual(splitPlaintiff('Briar Park Senior Living, Dominium Management Inc'), { entity: 'Dominium Management Inc', community: 'Briar Park Senior Living', agentFor: null, careOf: null });
  assert.equal(splitPlaintiff('Mechanicsville Cityside - 30312, Columbia Residential').entity, 'Columbia Residential');
  assert.equal(splitPlaintiff('Mechanicsville Cityside - 30312, Columbia Residential').community, 'Mechanicsville Cityside');
  assert.equal(splitPlaintiff('Aviva Property Management, Aviva Property Management').community, null);
  assert.equal(splitPlaintiff('Pitts and Pitts Properties, LLC').entity, 'Pitts and Pitts Properties, LLC');
});

test('Fulton .doc calendar text: plaintiff from the caption line, defendants ignored', () => {
  const text = ['bjbj', 'Owner Co LLC  vs.  Some Tenant,All Other Occupants', '26ED392053', 'Plaintiff:', 'Attorney:', 'Owner Co LLC', 'Defendant:', 'Attorney:', 'All Other Occupants', 'Some Tenant', 'File Date', 'Comment', '06/19/2026',
    'Jane Landlord  vs.  Other Tenant', '26ED396088', 'Plaintiff:', 'Jane Landlord', 'Defendant:', 'Other Tenant'].join('\n');
  const r = parseFultonCalendar(text, { hearingDate: '2026-09-08', courtroom: '6G' });
  assert.equal(r.rows.length, 2);
  assert.equal(r.rows[0].plaintiff_name, 'Owner Co LLC');
  assert.equal(r.rows[0].filed_date, '2026-06-19');
  assert.equal(r.rows[0].hearing_date, '2026-09-08');
  assert.equal(r.rows[1].plaintiff_is_entity, false);
  assert.ok(!/Tenant/.test(JSON.stringify(r.rows)));
});

test('plaintiff splitting and defendant cutting', () => {
  assert.deepEqual(splitPlaintiff('S2 PLEASANTDALE LLC The Wynne'), { entity: 'S2 PLEASANTDALE LLC', community: 'The Wynne', agentFor: null, careOf: null });
  assert.equal(splitPlaintiff('SFR XII ATL Owner 1 LP c/o Brock & Scott, PLLC').careOf, 'Brock & Scott, PLLC');
  assert.equal(cutDefendant('PROGRESS RESIDENTIAL BORROWER 11, LLC WORKS ADRIANNA TARNISHA, OTHER OCCUPANTS AND ALL'), 'PROGRESS RESIDENTIAL BORROWER 11, LLC');
  assert.equal(cutDefendant('ICON BRIDGES, LLC D/B/A ICON BRIDGES LOGAN SYMBALEE, AND ALL OTHER OCCUPANTS'), 'ICON BRIDGES, LLC D/B/A ICON BRIDGES');
});

test('feeds: BLOX RSS, asset pdf link, WordPress media, CivicPlus and Henry calendar links', () => {
  const rss = `<rss><channel><item><title>NOTICE OF SALE UNDER POWER</title><link>https://www.fultonneighbor.com/legals/notice-of-sale-under-power/pdf_dc2edb06-4fe8-4ab4-a889-17b0df9ef2f0.html</link><guid isPermaLink="false">http://www.fultonneighbor.com/tncms/asset/editorial/dc2edb06-4fe8-4ab4-a889-17b0df9ef2f0</guid><pubDate>Wed, 26 Aug 2026 00:00:00 -0400</pubDate><enclosure url="https://x/y.jpg?resize=300%2C388" length="1" type="image/jpeg" /></item></channel></rss>`;
  const items = parseRss(rss);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'NOTICE OF SALE UNDER POWER');
  assert.match(items[0].guid, /dc2edb06/);
  assert.equal(bloxAssetPdfUrl('<a href="https://bloximages.newyork1.vip.townnews.com/fultonneighbor.com/content/tncms/assets/v3/editorial/c/91/c910aaac/6a9af2e5cb8d5.pdf.pdf" download>Download PDF</a>'), 'https://bloximages.newyork1.vip.townnews.com/fultonneighbor.com/content/tncms/assets/v3/editorial/c/91/c910aaac/6a9af2e5cb8d5.pdf.pdf');
  const media = parseWpMedia('[{"id":9714,"date":"2026-09-05T14:40:40","slug":"dispo-civil-9-10-26-6pm-pro-se","source_url":"https://dekalbcountymagistratecourt.com/wp-content/uploads/2026/09/Dispo-Civil-9.10.26-6PM-Pro-Se.pdf","title":{"rendered":"Dispo Civil 9.10.26 6PM Pro Se"}}]');
  assert.equal(media[0].id, '9714');
  assert.equal(media[0].title, 'Dispo Civil 9.10.26 6PM Pro Se');
  const civic = parseCivicPlusCalendarLinks('<a href="/DocumentCenter/View/15688/Dispossessory---September-8-2026---9-AM---COURTROOM-6G">x</a><a href="/DocumentCenter/View/15662/Small-Claims-September-02-2026-9AM-Courtroom-2M">y</a>');
  assert.equal(civic.length, 1);
  assert.equal(civic[0].date, '2026-09-08');
  assert.equal(civic[0].courtroom, '6G');
  const henry = parseHenryCalendarLinks('<a href="../portals/0/files/Courts/Magistrate%20Court/Judge%20Amanda%20Flora/Archive/9_1_2026_Amanda%20R.%20Flora_Dispossessory.pdf">a</a><a href="../portals/0/files/Courts/Magistrate%20Court/Judge%20X/Archive/9_1_2026_X_Civil.pdf">b</a>');
  assert.equal(henry.length, 1);
  assert.equal(henry[0].date, '2026-09-01');
  assert.equal(henry[0].url, 'https://iframe.henrycountyga.gov/portals/0/files/Courts/Magistrate%20Court/Judge%20Amanda%20Flora/Archive/9_1_2026_Amanda%20R.%20Flora_Dispossessory.pdf');
  const ads = parseBloxClassifiedLinks('<a href="/classifieds/community/announcements/legal/notice-of-foreclosure-sale-under-power-douglas/ad_889b3dbc-2708-5fee-af77-abeb3f1f4b7c.html">n</a><a href="/classifieds/community/announcements/legal/abandoned-motor-vehicle-notice/ad_8723b557-923b-599b-b3d3-680b7a06e32f.html">m</a>', 'https://www.douglascountysentinel.com');
  assert.equal(ads.filter(a => a.isForeclosure).length, 1);
});

test('foreclosure notice field extraction from typical Georgia notice text', () => {
  const text = `NOTICE OF SALE UNDER POWER STATE OF GEORGIA COUNTY OF DEKALB Under and by virtue of the Power of Sale contained in a Security Deed given by John Q. Sample to Mortgage Electronic Registration Systems, Inc. as nominee for Example Mortgage Company, LLC, dated March 1, 2019, recorded in Deed Book 27000, Page 100, DeKalb County, Georgia Records, as last transferred to Sample Servicing LLC by assignment recorded in Deed Book 29000, Page 5, conveying the after-described property to secure a Note in the original principal amount of $250,000.00, with interest thereon as set forth therein, there will be sold at public outcry to the highest bidder for cash before the courthouse door of DeKalb County, Georgia, within the legal hours of sale on the first Tuesday in October, 2026, the following described property: ALL THAT TRACT OR PARCEL OF LAND lying and being in Land Lot 123 of the 15th District, DeKalb County, Georgia, being Lot 4, Block B, Sample Subdivision. Said property is commonly known as 1234 Sample Drive, Decatur, Georgia 30032, together with all fixtures. The entity that has full authority to negotiate, amend and modify all terms of the mortgage with the debtor is: Sample Servicing LLC, 100 Servicer Way, Dallas, TX 75001, 800-555-0100. Tax Parcel ID: 15 214 01 091. Sample Servicing LLC as Attorney in Fact for John Q. Sample. Aldridge Pite, LLP, 15 Piedmont Center, Atlanta, GA 30305. Our File No. 1234-5678`;
  const f = extractNoticeFields(text);
  assert.equal(f.notice_type, 'sale_under_power');
  assert.equal(f.county, 'DeKalb');
  assert.equal(f.sale_date, '2026-10-06');
  assert.equal(f.property_address, '1234 Sample Drive');
  assert.equal(f.city, 'Decatur');
  assert.equal(f.zip, '30032');
  assert.equal(f.parcel_id, '15 214 01 091');
  assert.equal(f.borrower_names, 'John Q. Sample');
  assert.match(f.lender, /Mortgage Electronic Registration Systems/);
  assert.equal(f.foreclosing_entity, 'Sample Servicing LLC');
  assert.match(f.servicer, /Sample Servicing LLC/);
  assert.match(f.law_firm, /Aldridge Pite, LLP/);
  assert.equal(f.foreclosure_identifier, '1234-5678');
  const two = splitNotices('\nNOTICE OF SALE UNDER POWER ' + text.slice(27) + '\n\nNOTICE OF SALE UNDER POWER ' + text.slice(27).replace('1234 Sample Drive', '99 Other Road'));
  assert.equal(two.length, 2);
});

test('document sniffing and legacy .doc text runs', () => {
  assert.equal(sniffType(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])), 'pdf');
  assert.equal(sniffType(new Uint8Array([0x50, 0x4b, 0x03, 0x04])), 'docx');
  assert.equal(sniffType(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])), 'doc');
  assert.equal(sniffType(new Uint8Array([1, 2, 3]), 'application/msword'), 'doc');
  const utf16 = Buffer.from('26ED390159\r\nSome Landlord LLC\r\n', 'utf16le');
  const runs = docTextRuns(new Uint8Array(utf16));
  assert.ok(runs.includes('26ED390159') && runs.includes('Some Landlord LLC'));
});

test('DeKalb: an attorney name wrapped onto the plaintiff line is split off and "ET AL" is dropped', () => {
  const text = 'Magistrate Court Civil Calendar\nJudge Test Judge\nDispossessory\n1:00 PM\n09/08/2026\n' +
    '1 26D09318 U.S. BANK TRUST NATIONAL ASSOCIATION, SOLELY AS\nTRUSTEE OF LSF9 MASTER ET AL Corey P Sims\nMagistrate Dispossessory - Non\nPayment of Rent --- versus ---\nOccupant Placeholder\nComment:\n';
  const r = parseDeKalbCalendar(text);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].plaintiff_name, 'U.S. BANK TRUST NATIONAL ASSOCIATION, SOLELY AS TRUSTEE OF LSF9 MASTER');
  assert.equal(r.rows[0].plaintiff_attorney, 'Corey P Sims');
  assert.ok(!/Placeholder/.test(JSON.stringify(r.rows)));
});
