import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAddress, normalizeAddress, normalizeParcel, looksLikeEntity, parseDateLoose, parseFirstTuesday, firstTuesday, detectCounty, nameKey } from '../lib/normalize.js';

test('address normalization collapses punctuation, case, street types and units', () => {
  const a = parseAddress('1234 N. Peachtree Street NE, Unit 5B, Atlanta, GA 30309');
  assert.equal(a.norm, '1234 N PEACHTREE ST NE #5B');
  assert.equal(a.city, 'ATLANTA');
  assert.equal(a.zip, '30309');
  assert.equal(normalizeAddress('1234 North Peachtree St. Northeast Apt 5B Atlanta Georgia 30309'), '1234 N PEACHTREE ST NE #5B');
  assert.equal(normalizeAddress('  8700 hospital drive, douglasville, ga 30134 '), '8700 HOSPITAL DR');
  assert.equal(normalizeAddress('556 South Candler Street Decatur, GA 30030'), '556 S CANDLER ST');
  assert.equal(normalizeAddress(''), null);
});

test('parcel ids normalize to alphanumerics', () => {
  assert.equal(normalizeParcel('14 0077 0008 039-9'), '14007700080399');
  assert.equal(normalizeParcel('15 214 01 091'), '15214 01 091'.replace(/\s/g, ''));
  assert.equal(normalizeParcel('12'), null);
});

test('entity detection separates companies from individuals', () => {
  assert.equal(looksLikeEntity('Colony Holdings, LLC'), true);
  assert.equal(looksLikeEntity('PROGRESS RESIDENTIAL BORROWER 11, LLC'), true);
  assert.equal(looksLikeEntity('Wells Fargo Bank, N.A.'), true);
  assert.equal(looksLikeEntity('PHILLIPS EDNA M'), false);
  assert.equal(looksLikeEntity('588 PAINES'), true);
  assert.equal(looksLikeEntity('EMBARCADERO CLUB'), true);
  assert.equal(looksLikeEntity('WESTWOOD GLEN'), true);
  assert.equal(looksLikeEntity('marzieh zamani'), false);
});

test('dates: loose parsing and Georgia first-Tuesday sale dates', () => {
  assert.equal(parseDateLoose('09/08/2026'), '2026-09-08');
  assert.equal(parseDateLoose('September 8, 2026'), '2026-09-08');
  assert.equal(parseDateLoose('the 6th day of October, 2026'), '2026-10-06');
  assert.equal(parseFirstTuesday('sold at public outcry on the first Tuesday in October, 2026'), '2026-10-06');
  assert.equal(parseFirstTuesday('first Tuesday of November 2026'), '2026-11-03');
  assert.equal(firstTuesday(2026, 9).toISOString().slice(0, 10), '2026-09-01');
});

test('county detection and name keys', () => {
  assert.equal(detectCounty('STATE OF GEORGIA COUNTY OF DEKALB NOTICE OF SALE'), 'DeKalb');
  assert.equal(detectCounty('recorded in Fulton County, Georgia records'), 'Fulton');
  assert.equal(nameKey('S2 Pleasantdale, LLC'), 's2pleasantdalellc');
});
