import test from 'node:test';
import assert from 'node:assert/strict';
import { findPropertyMatch, matchForeclosureEvent, matchEvictionEvent, mergeFields } from '../lib/dedupe.js';

const props = [
  { id: 'a', county: 'Fulton', parcel_id_norm: '14007700080399', address_norm: '191 PEACHTREE ST SW' },
  { id: 'b', county: 'Fulton', parcel_id_norm: null, address_norm: '100 MAIN ST #2' },
  { id: 'c', county: 'DeKalb', parcel_id_norm: null, address_norm: '100 MAIN ST' },
  { id: 'd', county: 'DeKalb', parcel_id_norm: null, address_norm: null, address_raw: 'The Wynne', community_key: 'thewynne' },
];

test('property matching prefers parcel, then exact address, never crosses counties', () => {
  assert.equal(findPropertyMatch(props, { county: 'Fulton', parcel_id: '14 0077 0008 0399', address_raw: 'something else' }).match.id, 'a');
  assert.equal(findPropertyMatch(props, { county: 'Fulton', address_raw: '191 Peachtree Street S.W., Atlanta GA' }).match.id, 'a');
  assert.equal(findPropertyMatch(props, { county: 'DeKalb', address_raw: '100 Main Street' }).match.id, 'c');
  assert.equal(findPropertyMatch(props, { county: 'Henry', address_raw: '100 Main Street' }).match, null);
  // a unit-less incoming address never silently merges into a unit-specific record (conservative rule)
  assert.equal(findPropertyMatch(props, { county: 'Fulton', address_raw: '100 Main St' }).match, null);
  assert.equal(findPropertyMatch(props, { county: 'DeKalb', community_name: 'The Wynne' }).match.id, 'd');
});

test('repeated foreclosure publications and postponements map to one event', () => {
  const ev = [{ id: 'e1', event_type: 'foreclosure', status: 'active', sale_date: '2026-10-06', publication_date: '2026-09-03', foreclosure_identifier: 'F-123' }];
  assert.equal(matchForeclosureEvent(ev, { sale_date: '2026-10-06', publication_date: '2026-09-10' }).match.id, 'e1');
  assert.equal(matchForeclosureEvent(ev, { sale_date: '2026-11-03', publication_date: '2026-10-08' }).how, 'postponed');
  assert.equal(matchForeclosureEvent(ev, { foreclosure_identifier: 'F-123', sale_date: null }).how, 'identifier');
  // a sale a year later is a new foreclosure
  assert.equal(matchForeclosureEvent(ev, { sale_date: '2027-09-07', publication_date: '2027-08-10' }).match, null);
  const closed = [{ id: 'e2', event_type: 'foreclosure', status: 'closed', sale_date: '2026-06-02' }];
  assert.equal(matchForeclosureEvent(closed, { sale_date: '2026-06-02' }).how, 'closed_same_sale_date');
  assert.equal(matchForeclosureEvent(closed, { sale_date: '2026-09-01' }).match, null);
});

test('eviction cases dedupe on case number regardless of formatting', () => {
  const ev = [{ id: 'x', event_type: 'eviction', status: 'active', case_number: '26D15710', plaintiff_name: 'Colony Holdings, LLC', filed_date: '2026-08-01' }];
  assert.equal(matchEvictionEvent(ev, { case_number: '26-D-15710' }).how, 'case_number');
  assert.equal(matchEvictionEvent(ev, { case_number: '26D99999' }).match, null);
  assert.equal(matchEvictionEvent(ev, { plaintiff_name: 'COLONY HOLDINGS LLC', filed_date: '2026-09-01' }).how, 'plaintiff_window');
});

test('merge never overwrites filled fields with blanks', () => {
  assert.deepEqual(mergeFields({ a: 'x', b: null, c: '' }, { a: 'y', b: 'z', c: 'w', d: 'q' }, ['a', 'b', 'c', 'd']), { b: 'z', c: 'w', d: 'q' });
});
