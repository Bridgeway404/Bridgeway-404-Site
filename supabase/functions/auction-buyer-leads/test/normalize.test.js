import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nameKey, parcelKey, classifyBuyer, looksLikeEntity, titleCase, propertyTypeFrom, addressFromLegal, parseDateLoose, parseFirstTuesday, extractLinks, formatPhone } from '../lib/normalize.js';

test('nameKey drops entity suffixes and punctuation like ab_name_key', () => {
  assert.equal(nameKey('ABC Homes, L.L.C.'), 'abchomes');
  assert.equal(nameKey('ABC HOMES LLC'), 'abchomes');
  assert.equal(nameKey('The Arbor Connection Inc.'), 'arborconnection');
  assert.notEqual(nameKey('Arbor Connection LLC'), nameKey('Arbor Connection Holdings LLC'));
});

test('parcelKey keeps alphanumerics only', () => {
  assert.equal(parcelKey('14 0077 0008 039-9'), '14007700080399');
  assert.equal(parcelKey('044-01016000'), '04401016000');
});

test('classifyBuyer separates investors from banks, servicers, government and people', () => {
  assert.equal(classifyBuyer('ABZ PROPERTIES LLC').buyerType, 'investor_company');
  assert.equal(classifyBuyer('WELLS FARGO BANK NA').buyerType, 'institutional_lender');
  assert.equal(classifyBuyer('WELLS FARGO BANK NA').isInstitutional, true);
  assert.equal(classifyBuyer('NATIONSTAR MORTGAGE LLC DBA MR COOPER').buyerType, 'servicer');
  assert.equal(classifyBuyer('DOUGLAS COUNTY').buyerType, 'government');
  assert.equal(classifyBuyer('HABITAT FOR HUMANITY OF DOUGLAS COUNTY INC').buyerType, 'nonprofit');
  assert.equal(classifyBuyer('SMITH JOHN A').buyerType, 'individual');
  assert.equal(classifyBuyer('PEACHTREE CUSTOM HOMES LLC').buyerType, 'builder');
  assert.equal(classifyBuyer('ATL RENOVATIONS LLC').buyerType, 'flipper');
  assert.equal(classifyBuyer('METRO RENTALS INC').buyerType, 'landlord');
  assert.equal(looksLikeEntity('ABDUL-HAQQ NAJIB & AISHAH'), false);
  assert.equal(looksLikeEntity('2018-2 IH BORROWER LP'), true);
  assert.equal(looksLikeEntity('WILLIAMS DEAN ROMERO & WILLIAMS SUSAN M'), false);
  assert.equal(looksLikeEntity('LARITA JONES & OMARI BENJAMIN'), false);
  assert.equal(looksLikeEntity('ALL REAL TALENT INCORPORATED'), true);
  assert.equal(classifyBuyer('ALL REAL TALENT INCORPORATED').buyerType, 'investor_company');
});

test('titleCase keeps entity abbreviations upper-case', () => {
  assert.equal(titleCase('ABZ PROPERTIES LLC'), 'ABZ Properties LLC');
  assert.equal(titleCase('ARBOR CONNECTION LLC'), 'Arbor Connection LLC');
  assert.equal(titleCase('Already Mixed'), 'Already Mixed');
});

test('propertyTypeFrom reads assessor classes and legal descriptions', () => {
  assert.equal(propertyTypeFrom('R3 Residential improved'), 'single_family');
  assert.equal(propertyTypeFrom('BEING LOT 64 OF THE MEADOWS SUBDIVISION'), 'single_family');
  assert.equal(propertyTypeFrom('UNIT 3 OF PARKWAY PROFESSIONAL MALL CONDOMINIUM'), 'condo');
  assert.equal(propertyTypeFrom('Vacant land R4'), 'land');
  assert.equal(propertyTypeFrom('C3 commercial'), 'commercial');
  assert.equal(propertyTypeFrom(''), 'unknown');
});

test('addressFromLegal pulls the site address off the end of a legal description', () => {
  assert.equal(addressFromLegal('... AS SHOWN IN PLAT BOOK 7, PAGE 144. 5240 KINGS HWY'), '5240 KINGS HWY');
  assert.equal(addressFromLegal('ALL THAT TRACT OF LAND ... IN DOUGLAS COUNTY, GEORGIA. 7475 DOUGLAS BLVD'), '7475 DOUGLAS BLVD');
  assert.equal(addressFromLegal('ALL THAT TRACT OF LAND IN LAND LOT 5'), null);
});

test('dates', () => {
  assert.equal(parseDateLoose('10/06/2026'), '2026-10-06');
  assert.equal(parseDateLoose('June 2, 2026'), '2026-06-02');
  assert.equal(parseFirstTuesday('on the first Tuesday in June, 2026, the same'), '2026-06-02');
  assert.equal(parseFirstTuesday('first Tuesday of November 2026'), '2026-11-03');
});

test('extractLinks resolves relative hrefs and dedupes', () => {
  const html = '<a href="/pdf/2026/05/June.pdf">June list</a> <a href="https://x.org/a">A</a> <a href="/pdf/2026/05/June.pdf">again</a>';
  const links = extractLinks(html, 'https://douglastax.org/tax-sales');
  assert.deepEqual(links.map(l => l.href), ['https://douglastax.org/pdf/2026/05/June.pdf', 'https://x.org/a']);
  assert.equal(links[0].text, 'June list');
  assert.equal(formatPhone('7705551234'), '(770) 555-1234');
});
