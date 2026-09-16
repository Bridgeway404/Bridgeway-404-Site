import test from 'node:test';
import assert from 'node:assert/strict';
import { nameKey, firmKey, phoneKey, hostKey, formatPhone, cleanAttorneyName, looksLikePersonName, titleCase } from '../lib/normalize.js';

test('name keys ignore punctuation, case, honorifics and suffixes', () => {
  assert.equal(nameKey('J. Mike Williams'), 'jmikewilliams');
  assert.equal(nameKey('J Mike Williams'), 'jmikewilliams');
  assert.equal(nameKey('Simren Patel, Esquire'), 'simrenpatel');
  assert.equal(nameKey('Randel Self, Jr.'), 'randelself');
  assert.equal(nameKey('MARIO BREEDLOVE'), nameKey('Mario Breedlove'));
  assert.equal(nameKey(null), '');
});

test('firm keys drop legal suffixes and "law firm" filler', () => {
  assert.equal(firmKey('The Williams Law Firm, LLC'), 'williams');
  assert.equal(firmKey('Williams Law Firm'), 'williams');
  assert.equal(firmKey('Law Offices of Jane Doe, P.C.'), 'janedoe');
  assert.equal(firmKey('Lawson & Lawson LLP'), 'lawsonlawson');
});

test('phone and host keys', () => {
  assert.equal(phoneKey('(404) 555-1212'), '4045551212');
  assert.equal(phoneKey('+1 404.555.1212'), '4045551212');
  assert.equal(phoneKey('555-1212'), '');
  assert.equal(formatPhone('4045551212'), '(404) 555-1212');
  assert.equal(formatPhone(null), null);
  assert.equal(hostKey('https://www.Firm.com/attorneys/x?y=1'), 'firm.com');
  assert.equal(hostKey('firm.com'), 'firm.com');
});

test('calendar attorney cells are cleaned and classified', () => {
  assert.equal(cleanAttorneyName('SAVANNAH SMARCH'), 'Savannah Smarch');
  assert.equal(cleanAttorneyName('Simren Patel, Esquire'), 'Simren Patel');
  assert.equal(cleanAttorneyName('Brandi McNeal'), 'Brandi McNeal');
  assert.equal(titleCase('MECHELLE MONTGOMERY-BUMPERS'), 'Mechelle Montgomery-Bumpers');
  assert.ok(looksLikePersonName('J Mike Williams'));
  assert.ok(looksLikePersonName('Randel Self, Jr.'.replace(',', '')));
  assert.ok(!looksLikePersonName('Payment of Rent'));
  assert.ok(!looksLikePersonName('Assistance Coalition'));
  assert.ok(!looksLikePersonName('Dekalb Leased Housing Associates I, LLLP'));
  assert.ok(!looksLikePersonName('GLENWOOD MILLPOND NRDE LLC'));
  assert.ok(!looksLikePersonName('Williams'));
});
