// Deterministic extraction of the key fields from a Georgia "Notice of Sale
// Under Power" (non-judicial foreclosure advertisement). Used before / as a
// cross-check for the AI extractor. Notices are prose, so every field is
// best-effort; the AI extractor fills the gaps when configured.
import { cleanWhitespace, parseDateLoose, parseFirstTuesday, detectCounty, nameKey } from '../normalize.js';

const ADDRESS_RE = /\b(\d{1,6}[A-Z]?\s+(?:[NSEW]\.?\s+)?[A-Z0-9][A-Z0-9'.\-]*(?:\s+[A-Z0-9][A-Z0-9'.\-]*){0,4}\s+(?:STREET|ST|AVENUE|AVE|ROAD|RD|DRIVE|DR|LANE|LN|COURT|CT|CIRCLE|CIR|BOULEVARD|BLVD|PARKWAY|PKWY|PLACE|PL|TRAIL|TRL|WAY|TERRACE|TER|HIGHWAY|HWY|LOOP|RUN|PATH|PASS|POINT|PT|SQUARE|SQ|CROSSING|XING|COVE|CV|BEND|RIDGE|HOLLOW|CREEK|HILL|MANOR|GLEN|WALK|VIEW|ROW|ALLEY|EXT)\.?(?:\s+(?:N\.?E\.?|N\.?W\.?|S\.?E\.?|S\.?W\.?|NORTH|SOUTH|EAST|WEST|N|S|E|W))?(?:\s*,?\s*(?:UNIT|APT|SUITE|STE|#)\s*[A-Z0-9-]+)?)\s*,?\s*([A-Z][A-Z .]+?)?\s*,?\s*(?:GEORGIA|GA)\s*,?\s*(\d{5})?/i;

export function extractNoticeFields(text) {
  const raw = String(text || '');
  const t = cleanWhitespace(raw);
  const out = { notice_type: null, property_address: null, city: null, zip: null, parcel_id: null, sale_date: null,
    lender: null, secured_party: null, foreclosing_entity: null, servicer: null, law_firm: null, borrower_names: null,
    foreclosure_identifier: null, county: detectCounty(t), legal_description: null };

  if (/NOTICE OF SALE UNDER POWER|SALE UNDER POWER|POWER OF SALE/i.test(t)) out.notice_type = 'sale_under_power';
  else if (/NOTICE OF FORECLOSURE/i.test(t)) out.notice_type = 'foreclosure';
  else if (/TAX SALE|LEVY/i.test(t)) out.notice_type = 'tax_sale';

  // Sale date: "first Tuesday in October, 2026" or explicit date "October 6, 2026"
  out.sale_date = parseFirstTuesday(t);
  if (!out.sale_date) {
    const m = /(?:sold|sale)[^.]{0,120}?\b(?:on|of)\s+([A-Z][a-z]+\s+\d{1,2},?\s+\d{4})/i.exec(t) || /\b(?:on|of)\s+(?:the\s+)?(\d{1,2}(?:st|nd|rd|th)?\s+day\s+of\s+[A-Z][a-z]+,?\s+\d{4})/i.exec(t);
    if (m) out.sale_date = parseDateLoose(m[1]);
  }

  // Property address: "commonly known as 123 Main St, Atlanta, Georgia 30303" / "property address"
  const ka = /(?:commonly\s+known\s+as|known\s+as|property\s+(?:address|located\s+at)|street\s+address\s+(?:of|is)|located\s+at)\s*:?\s*([^.;]{8,160})/i.exec(t);
  const cand = ka ? ka[1] : t;
  const am = ADDRESS_RE.exec(cand);
  if (am) {
    out.property_address = cleanWhitespace(am[1]).replace(/\s*,\s*$/, '');
    if (am[2]) out.city = cleanWhitespace(am[2]).replace(/\b(GEORGIA|GA)\b/i, '').trim() || null;
    if (am[3]) out.zip = am[3];
  }

  // Parcel / tax id
  const pm = /(?:tax\s+(?:parcel\s+)?(?:id(?:entification)?|map)(?:\s+(?:number|no\.?|#))?|parcel\s+(?:id|number|no\.?|#)|PIN)\s*:?\s*(?:is\s+)?([0-9][0-9A-Z\- ]{5,30}[0-9A-Z])/i.exec(t);
  if (pm) out.parcel_id = cleanWhitespace(pm[1]).replace(/\s*(?:and|which|being|the).*$/i, '');

  // Parties
  const gm = /(?:security\s+deed|deed\s+to\s+secure\s+debt)\s+(?:given|executed|made)?\s*(?:by|from)\s+([A-Z][^,]{2,80}?)\s+to\s+/i.exec(t)
    || /\bfrom\s+([A-Z][^,]{2,80}?)\s+to\s+(?:Mortgage Electronic|MERS|[A-Z])/i.exec(t);
  if (gm) out.borrower_names = cleanWhitespace(gm[1]);
  const lm = /\bto\s+((?:Mortgage\s+Electronic\s+Registration\s+Systems,?\s+Inc\.?[^,]{0,80}?|[A-Z][A-Za-z0-9&.,' \-]{2,90}?(?:Bank|N\.A\.|Mortgage|Lending|Financial|Credit Union|Funding|Capital|LLC|Inc\.?|Corporation|Company|Trust|Association)))(?:\s*,?\s*(?:dated|in the original|recorded))/i.exec(t);
  if (lm) out.lender = cleanWhitespace(lm[1]).replace(/,\s*$/, '');
  const tm = /(?:transferred|assigned|conveyed)\s+to\s+([A-Z][A-Za-z0-9&.,' \-]{2,120}?)(?:\s+(?:by|pursuant|as|recorded|dated|\())/i.exec(t);
  if (tm) out.foreclosing_entity = cleanWhitespace(tm[1]).replace(/,\s*$/, '');
  const sm = /(?:servicer|servicing\s+(?:the\s+)?loan|entity\s+(?:that\s+)?has\s+full\s+authority)[^.]{0,80}?\b(?:is|:)\s+([A-Z][A-Za-z0-9&.,' \-]{2,90}?)(?:,|\s+(?:at|whose|and|who|which|located))/i.exec(t)
    || /([A-Z][A-Za-z0-9&.,' \-]{2,90}?)\s+(?:is|can be contacted as)\s+the\s+(?:entity|servicer)[^.]{0,60}?(?:full\s+authority|negotiat)/i.exec(t);
  if (sm) out.servicer = cleanWhitespace(sm[1]).replace(/,\s*$/, '');
  // Law firm: the signature block at the end of the notice. Prefer law-firm
  // suffixes (LLP, PLLC, P.C., "Law Group") and never re-use the servicer /
  // foreclosing entity / lender, which are usually LLCs in the same tail.
  const tail = t.slice(Math.max(0, t.length - 900));
  const firmRe = /\b((?:(?:[A-Z][A-Za-z.'\-]+|&),?\s+){1,6}(?:LLP|L\.L\.P\.|PLLC|P\.C\.|PC|Law\s+Group|Law\s+Firm|& Associates|Attorneys?(?:\s+at\s+Law)?|LLC|L\.L\.C\.))\b/g;
  const known = [out.servicer, out.foreclosing_entity, out.lender, out.secured_party].filter(Boolean).map(nameKey);
  const cands = [...tail.matchAll(firmRe)].map(m => cleanWhitespace(m[1]).replace(/,\s*$/, '')).filter(n => !known.includes(nameKey(n)));
  const strong = cands.find(n => !/\b(?:LLC|L\.L\.C\.)$/i.test(n));
  const weak = cands.find(n => /\b(?:LLC|L\.L\.C\.)$/i.test(n) && /attorney|law|legal/i.test(n));
  out.law_firm = strong || weak || null;
  const im = /\b(?:file\s*(?:no\.?|number|#)|our\s+file|matter\s+(?:no\.?|number)|ref(?:erence)?\.?\s*(?:no\.?|#)?)\s*:?\s*([A-Z0-9][A-Z0-9\-\/.]{3,25})/i.exec(t);
  if (im) out.foreclosure_identifier = im[1].replace(/\.$/, '');
  const ld = /(?:ALL THAT TRACT OR PARCEL OF LAND[^.]{0,400}|Land Lot\s+\d+[^.]{0,200})/i.exec(t);
  if (ld) out.legal_description = cleanWhitespace(ld[0]).slice(0, 400);

  if (/(?:notice\s+of\s+)?(?:cancell?ation|rescission|withdrawn|postponed)/i.test(t.slice(0, 300))) out.notice_type = 'cancellation';
  return out;
}

/** Split a multi-notice document (e.g. a weekly legal section) into individual notices. */
export function splitNotices(text) {
  const t = String(text || '').replace(/\r/g, '');
  const parts = t.split(/(?=\n\s*(?:NOTICE OF SALE UNDER POWER|NOTICE OF FORECLOSURE SALE|NOTICE OF FORECLOSURE|STATE OF GEORGIA\s*\n\s*COUNTY OF (?:FULTON|DEKALB|DOUGLAS|HENRY)\s*\n\s*NOTICE OF SALE)\b)/i);
  return parts.map(p => p.trim()).filter(p => p.length > 300 && /sale under power|foreclos|security deed|deed to secure debt/i.test(p));
}
