#!/usr/bin/env node
/* Tests for admin/assets/meta-import.js (Meta connections.zip parser).
 * Run: node tools/test-meta-import.mjs
 * All fixtures are synthetic — no real export data is used or committed.
 */
import { createRequire } from 'node:module';
import { deflateRawSync } from 'node:zlib';
const require = createRequire(import.meta.url);
const BWMeta = require('../admin/assets/meta-import.js');

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log('  ok - ' + name); }
  else { failed++; console.error('  FAIL - ' + name); }
}
function eq(a, b, name) {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  ok(A === B, name + (A === B ? '' : ` (got ${A}, want ${B})`));
}

// ---------- synthetic fixture HTML (mirrors real export structure) ----------

const followerBlock = (u, ts) =>
  `<div class="pam _3-95 _2ph- _a6-g uiBoxWhite noborder"><div class="_a6-p"><div><div>` +
  `<a target="_blank" href="https://www.instagram.com/${u}">${u}</a></div><div>${ts}</div></div></div>`;

const followingBlock = (u, ts) =>
  `<div class="pam _3-95 _2ph- _a6-g uiBoxWhite noborder"><h2 class="_3-95 _2pim _a6-h _a6-i">${u}</h2>` +
  `<div class="_a6-p"><div><div><a target="_blank" href="https://www.instagram.com/_u/${u}">` +
  `https://www.instagram.com/_u/${u}</a></div><div>${ts}</div></div></div>`;

const requestBlock = (name, u) =>
  `<div class="pam _3-95 _2ph- _a6-g uiBoxWhite noborder"><div class="_3-95 _a6-p">` +
  `<div class="pam _3-95 _2ph- _a6-g uiBoxWhite noborder"><div class="_a6-p"><table style="table-layout: fixed;">` +
  `<tr><td class="_a6_q">Name</td><td class="_2piu _a6_r">${name}</td></tr>` +
  `<tr><td class="_a6_q">Username</td><td class="_2piu _a6_r">${u}</td></tr></table></div></div></div>`;

const contactBlock = (first, last, info) => {
  let rows = `<tr><td colspan="2" class="_2pin _a6_q">First Name<div><div>${first}</div></div></td></tr>`;
  if (last) rows += `<tr><td colspan="2" class="_2pin _a6_q">Last Name<div><div>${last}</div></div></td></tr>`;
  rows += `<tr><td colspan="2" class="_2pin _a6_q">Contact Information<div><div>${info}</div></div></td></tr>`;
  return `<div class="pam _3-95 _2ph- _a6-g uiBoxWhite noborder"><div class="_a6-p">` +
         `<table style="table-layout: fixed;">${rows}</table></div></div>`;
};

const wrap = (body) => `<html><head></head><body><main class="_a706" role="main">${body}</main></body></html>`;

const followersHtml = wrap(
  followerBlock('kyle_m', 'Aug 27, 2026 1:35 pm') +
  followerBlock('jane.doe', 'Aug 20, 2026 9:00 am'));

const followingHtml = wrap(
  followingBlock('kyle_m', 'Aug 29, 2026 6:25 pm') +      // mutual
  followingBlock('coolbrand', 'Jul 4, 2026 1:00 pm') +    // following only
  followingBlock('johnsmith', 'Jun 1, 2026 2:00 pm'));    // matches contact John Smith

const contactsHtml = wrap(
  contactBlock('John', 'Smith', '4045551234') +
  contactBlock('John', 'Smith', 'john@example.com') +     // dup name, extra channel
  contactBlock('María', 'Gómez', '6785559999') + // accents normalize
  contactBlock('Solo', '', '7705550000'));

const pendingHtml = wrap(requestBlock('Ann Lee', 'annlee_official'));

// ---------- HTML parser tests ----------

console.log('parseLinkList');
{
  const rows = BWMeta.parseLinkList(followersHtml);
  eq(rows.length, 2, 'parses two follower rows');
  eq(rows[0].username, 'kyle_m', 'username extracted');
  eq(rows[0].timestamp, 'Aug 27, 2026 1:35 pm', 'timestamp extracted');
  const f = BWMeta.parseLinkList(followingHtml);
  eq(f.length, 3, 'parses following rows');
  eq(f[0].url, 'https://www.instagram.com/kyle_m', 'normalizes /_u/ urls');
}

console.log('parseNameTableList');
{
  const rows = BWMeta.parseNameTableList(pendingHtml);
  eq(rows.length, 1, 'parses one request row');
  eq(rows[0].label, 'Ann Lee', 'display name extracted');
  eq(rows[0].username, 'annlee_official', 'username extracted');
}

console.log('parseContacts');
{
  const rows = BWMeta.parseContacts(contactsHtml);
  eq(rows.length, 4, 'parses all contact rows');
  eq(rows[0], { first_name: 'John', last_name: 'Smith', contact_info: '4045551234' }, 'contact fields');
  eq(rows[3].last_name, '', 'first-name-only contact');
}

// ---------- entity resolution / normalization ----------

console.log('normalizePeople');
{
  const data = BWMeta.parseExportFiles([
    { name: 'connections/followers_and_following/followers_1.html', bytes: followersHtml },
    { name: 'connections/followers_and_following/following.html', bytes: followingHtml },
    { name: 'connections/followers_and_following/pending_follow_requests.html', bytes: pendingHtml },
    { name: 'connections/contacts/synced_contacts.html', bytes: contactsHtml }
  ]);
  const people = BWMeta.normalizePeople(data);
  const byKey = Object.fromEntries(people.map(p => [p.person_key, p]));

  const kyle = byKey['ig:kyle_m'];
  ok(kyle && kyle.signals.some(s => s.signal_type === 'mutual_follow'), 'mutual follow detected');
  eq(kyle.relationship_strength, 3, 'mutual strength = 3');

  const jane = byKey['ig:jane.doe'];
  ok(jane && jane.signals.some(s => s.signal_type === 'follower_only'), 'follower-only detected');

  const brand = byKey['ig:coolbrand'];
  ok(brand && brand.signals.some(s => s.signal_type === 'following_only'), 'following-only detected');

  // john smith: username exactly matches contact name -> merged, high confidence
  const john = byKey['ig:johnsmith'];
  ok(john && john.first_name === 'John' && john.last_name === 'Smith', 'IG<->contact merge by exact name');
  eq(john.identity_confidence, 'high', 'merged identity confidence = high');
  eq(john.phone, '4045551234', 'phone carried from contact');
  eq(john.email, 'john@example.com', 'email carried from duplicate contact row');
  ok(!byKey['ct:john:smith'], 'claimed contact not duplicated as contact-only person');

  // duplicates collapse: 2 John Smith rows -> one person
  eq(people.filter(p => p.first_name === 'John' && p.last_name === 'Smith').length, 1,
    'duplicate contact rows reconciled to one person');

  // unmatched contacts remain contact-only
  ok(byKey['ct:maria:gomez'], 'accented contact normalized to ct:maria:gomez');
  ok(byKey['ct:solo:'], 'first-name-only contact kept');

  // pending request person with display name
  const ann = byKey['ig:annlee_official'];
  ok(ann && ann.display_name === 'Ann Lee', 'request display name kept');
  ok(!ann.first_name, 'no silent merge: "Ann Lee" contact does not exist, name stays unset');
}

console.log('conservative matching');
{
  // Short/ambiguous names must NOT merge.
  eq(BWMeta.usernameNameMatchScore('jd', 'J', 'D'), 0, 'too-short names never match');
  eq(BWMeta.usernameNameMatchScore('al_2024', 'Al', ''), 0, 'first-name-only short never matches');
  eq(BWMeta.usernameNameMatchScore('johnsmith', 'John', 'Smith'), 3, 'exact full-name match = 3');
  eq(BWMeta.usernameNameMatchScore('smithjohn88', 'John', 'Smith'), 3, 'reversed + trailing digits = 3');
  eq(BWMeta.usernameNameMatchScore('john.smith.atl', 'John', 'Smith'), 2, 'both parts present = 2');
  eq(BWMeta.usernameNameMatchScore('johnson', 'John', 'Smith'), 0, 'substring-only is not a match');
}

// ---------- ZIP reader tests ----------

function crc32(buf) {
  let t = [], c;
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = t[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZip(entries, { deflate = false } = {}) {
  const enc = new TextEncoder();
  const chunks = [], central = [];
  let offset = 0;
  for (const [name, text] of entries) {
    const nameB = enc.encode(name);
    const data = enc.encode(text);
    const comp = deflate ? new Uint8Array(deflateRawSync(data)) : data;
    const method = deflate ? 8 : 0;
    const crc = crc32(data);
    const lh = new Uint8Array(30 + nameB.length);
    const dv = new DataView(lh.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(8, method, true);
    dv.setUint32(14, crc, true);
    dv.setUint32(18, comp.length, true);
    dv.setUint32(22, data.length, true);
    dv.setUint16(26, nameB.length, true);
    lh.set(nameB, 30);
    chunks.push(lh, comp);
    const cd = new Uint8Array(46 + nameB.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, method, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, comp.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameB.length, true);
    cv.setUint32(42, offset, true);
    cd.set(nameB, 46);
    central.push(cd);
    offset += lh.length + comp.length;
  }
  const cdStart = offset;
  let cdLen = 0;
  for (const c of central) cdLen += c.length;
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, central.length, true);
  ev.setUint16(10, central.length, true);
  ev.setUint32(12, cdLen, true);
  ev.setUint32(16, cdStart, true);
  const total = new Uint8Array(offset + cdLen + 22);
  let p = 0;
  for (const c of [...chunks, ...central, eocd]) { total.set(c, p); p += c.length; }
  return total.buffer;
}

console.log('readZip + end-to-end');
{
  const zip = buildZip([
    ['connections/followers_and_following/followers_1.html', followersHtml],
    ['connections/followers_and_following/following.html', followingHtml],
    ['connections/contacts/synced_contacts.html', contactsHtml],
    ['__MACOSX/connections/._junk', 'resource fork noise']
  ]);
  const res = await BWMeta.parseConnectionsZip(zip);
  eq(res.stats.followers, 2, 'zip: followers parsed');
  eq(res.stats.following, 3, 'zip: following parsed');
  eq(res.stats.mutual, 1, 'zip: mutual count');
  eq(res.stats.matched_both, 1, 'zip: contact<->IG matches');
  ok(res.people.length > 0, 'zip: people produced');
}

console.log('deflated zip');
{
  const zip = buildZip([
    ['connections/followers_and_following/followers_1.html', followersHtml],
    ['connections/followers_and_following/following.html', followingHtml]
  ], { deflate: true });
  const res = await BWMeta.parseConnectionsZip(zip);
  eq(res.stats.followers, 2, 'deflate: followers parsed');
}

console.log('malformed inputs');
{
  let threw = false;
  try { await BWMeta.readZip(new TextEncoder().encode('this is not a zip file at all............').buffer); }
  catch (e) { threw = /ZIP/i.test(e.message); }
  ok(threw, 'non-zip bytes rejected with clear error');

  threw = false;
  try { await BWMeta.readZip(new Uint8Array(4).buffer); }
  catch (e) { threw = true; }
  ok(threw, 'tiny buffer rejected');

  // Valid zip, but no Meta files inside.
  threw = false;
  try {
    const zip = buildZip([['readme.txt', 'hello']]);
    await BWMeta.parseConnectionsZip(zip);
  } catch (e) { threw = /No Meta connections files/i.test(e.message); }
  ok(threw, 'zip without Meta export files rejected with clear error');

  // Truncated central directory.
  threw = false;
  try {
    const zip = new Uint8Array(buildZip([['connections/contacts/synced_contacts.html', contactsHtml]]));
    const cut = zip.slice(0, zip.length - 30); // destroys EOCD
    await BWMeta.readZip(cut.buffer);
  } catch (e) { threw = true; }
  ok(threw, 'truncated zip rejected');

  // Empty HTML parses to zero rows, not a crash.
  eq(BWMeta.parseContacts('<html><body></body></html>').length, 0, 'empty contacts html -> 0 rows');
  eq(BWMeta.parseLinkList('').length, 0, 'empty string -> 0 rows');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
