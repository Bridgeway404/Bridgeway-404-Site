// Normalization helpers for the Auction Buyer worker. Pure functions, no I/O.
// The dedupe keys mirror the SQL helpers in migration 0008 (ab_name_key,
// ab_parcel_key, ab_mailing_key, eal_phone_key, eal_host_key) so the worker
// and the database agree on what "the same buyer" and "the same parcel" mean.

export function cleanWhitespace(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

const ENTITY_SUFFIX = /\b(llc|l\.l\.c|l l c|inc|incorporated|corp|corporation|co|company|ltd|lp|l\.p|llp|lllp|pllc|pc|p\.c|the|et al|etal|trustee|tr|as trustee)\b\.?/g;

/** Same as SQL ab_name_key(): entity suffixes and punctuation dropped. */
export function nameKey(name) {
  return String(name == null ? '' : name).toLowerCase().replace(ENTITY_SUFFIX, ' ').replace(/[^a-z0-9]/g, '');
}

/** Same as SQL ab_parcel_key(): upper-case alphanumerics only. */
export function parcelKey(parcel) {
  return String(parcel == null ? '' : parcel).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function mailingKey(addr) {
  return String(addr == null ? '' : addr).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Same as SQL eal_phone_key(): last ten digits, or '' when there are fewer. */
export function phoneKey(phone) {
  const d = String(phone == null ? '' : phone).replace(/[^0-9]/g, '');
  return d.length >= 10 ? d.slice(-10) : '';
}

export function hostKey(url) {
  return String(url == null ? '' : url).trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').replace(/[/?#].*$/, '');
}

export function formatPhone(phone) {
  const k = phoneKey(phone);
  if (!k) return cleanWhitespace(phone) || null;
  return `(${k.slice(0, 3)}) ${k.slice(3, 6)}-${k.slice(6)}`;
}

const SMALL = new Set(['of', 'and', 'the', 'at', 'for', 'de', 'la', 'von', 'van']);
const KEEP_UPPER = /^(llc|inc|lp|llp|lllp|pc|pllc|ii|iii|iv|na|fsb|reo|hud|va|usa|dba|jv|tx|ga|fl|nc|sc|al|tn)$/i;

/** "ABZ PROPERTIES LLC" -> "ABZ Properties LLC"; leaves mixed-case input alone. */
export function titleCase(s) {
  const t = cleanWhitespace(s);
  if (!t || t !== t.toUpperCase()) return t;
  return t.toLowerCase().split(' ').map((w, i) => {
    if (KEEP_UPPER.test(w)) return w.toUpperCase();
    if (i > 0 && SMALL.has(w)) return w;
    if (/^[a-z]{1,3}$/.test(w) && i === 0 && t.split(' ').length > 1 && w.length <= 3 && !SMALL.has(w)) return w.toUpperCase(); // "ABZ Properties"
    return w.replace(/(^|[-'&/])([a-z])/g, (m, p, c) => p + c.toUpperCase()).replace(/^mc([a-z])/, (m, c) => 'Mc' + c.toUpperCase());
  }).join(' ');
}

export function cleanName(name) {
  return cleanWhitespace(name).replace(/\s*[,;]\s*$/, '').replace(/\s{2,}/g, ' ');
}

const ENTITY_WORDS = /\b(LLC|L\.L\.C|INC|INCORPORATED|CORP|CORPORATION|COMPANY|CO\b|LP|L\.P|LLP|LLLP|LTD|TRUST|TRUSTEE|TR\b|BANK|N\.A|NA\b|ASSOCIATION|ASSOC|PARTNERS|PARTNERSHIP|HOLDINGS|PROPERTIES|PROPERTY|REALTY|INVESTMENTS|INVESTMENT|CAPITAL|GROUP|FUND|VENTURES|ENTERPRISES|MANAGEMENT|MGMT|HOMES|HOME\b|RENTALS|APARTMENTS|APTS|ASSET|MORTGAGE|LENDING|FINANCIAL|SERVICING|SERVICES|SOLUTIONS|ACQUISITIONS|DEVELOPMENT|DEVELOPERS|BUILDERS|CONSTRUCTION|AUTHORITY|HOUSING|CHURCH|MINISTRIES|FOUNDATION|UNIVERSITY|COUNTY|CITY OF|STATE OF|UNITED STATES|HUD|FANNIE MAE|FREDDIE MAC|FEDERAL|CREDIT UNION|SERIES|RESIDENTIAL|EQUITY|PORTFOLIO|OPPORTUNITY|REIT|PLC|CLUB|ESTATES|COMMUNITIES|LIVING|DESIGN|RENOVATIONS|REMODELING|CONTRACTORS|SYSTEMS|INDUSTRIES|GLOBAL|INTERNATIONAL|NATIONAL|AMERICAN|SOUTHERN|ATLANTA|GEORGIA|METRO|PEACHTREE|PROPCO|OPCO|HOLDCO|SPV|OF)\b/i;

/** True when an owner name looks like an organization rather than a person. */
export function looksLikeEntity(name) {
  const s = cleanWhitespace(name);
  if (!s) return false;
  if (ENTITY_WORDS.test(s)) return true;
  if (/\d/.test(s)) return true;
  // "WILLIAMS DEAN & WILLIAMS SUSAN M", "LARITA JONES & OMARI BENJAMIN": two people, not a company.
  const parts = s.split(/\s*(?:&|\bAND\b)\s*/i).map(cleanWhitespace).filter(Boolean);
  if (parts.length >= 2 && parts.every(p => { const w = p.split(' ').filter(Boolean); return w.length >= 1 && w.length <= 4 && !/\d/.test(p); })) return false;
  const words = s.split(' ').filter(Boolean);
  if (words.length === 1) return true;
  if (words.length >= 6) return true;
  return false;
}

const INSTITUTIONAL = /\b(BANK|N\.?A\.?\b|FSB|SAVINGS|CREDIT UNION|MORTGAGE|LENDING|LOAN|FINANCIAL|FINANCE|SERVICING|SERVICER|TRUSTEE FOR|AS TRUSTEE|FANNIE MAE|FEDERAL NATIONAL MORTGAGE|FREDDIE MAC|FEDERAL HOME LOAN|HUD|HOUSING AND URBAN|SECRETARY OF|VETERANS AFFAIRS|GINNIE|WELLS FARGO|CHASE|CITIBANK|CITIMORTGAGE|BANK OF AMERICA|U\.?S\.? BANK|PNC|TRUIST|SUNTRUST|REGIONS|SYNOVUS|AMERIS|NATIONSTAR|MR\.? COOPER|CARRINGTON|SELENE|SHELLPOINT|NEWREZ|PENNYMAC|ROCKET|QUICKEN|LAKEVIEW|FREEDOM MORTGAGE|SPECIALIZED LOAN|SLS\b|OCWEN|PHH\b|RUSHMORE|FAY SERVICING|DEUTSCHE BANK|HSBC|BANK OF NEW YORK|BNY|WILMINGTON|CITIZENS|FLAGSTAR|MIDFIRST|NAVY FEDERAL|LOANCARE|DOVENMUEHLE|REO\b|ASSET TRUST|ACQUISITION TRUST|LOAN TRUST|MORTGAGE TRUST|SECURITIES|PASS.THROUGH|CERTIFICATES)\b/i;
const GOVERNMENT = /\b(COUNTY|CITY OF|STATE OF|UNITED STATES|USA\b|DEPARTMENT|AUTHORITY|HOUSING AUTHORITY|LAND BANK|BOARD OF|COMMISSION|COMMISSIONER|TAX COMMISSIONER|SHERIFF|SCHOOL|DISTRICT|GEORGIA POWER|MARTA|DOT\b|TRANSPORTATION)\b/i;
const NONPROFIT = /\b(CHURCH|MINISTRIES|MINISTRY|TEMPLE|MOSQUE|SYNAGOGUE|FOUNDATION|HABITAT FOR HUMANITY|NON.?PROFIT|COMMUNITY DEVELOPMENT CORP|CDC\b|CHARIT)\b/i;
const BUILDER = /\b(BUILDERS?|CONSTRUCTION|HOMES\b|DEVELOPMENT|DEVELOPERS?|CUSTOM HOMES|HOMEBUILDERS?)\b/i;
const FLIPPER = /\b(RENOVATIONS?|REMODEL(?:ING)?|FLIPS?|FLIPPERS?|REHABS?|RESTORATIONS?|REDEVELOPMENT|DESIGN.?BUILD)\b/i;
const LANDLORD = /\b(RENTALS?|APARTMENTS|APTS|LEASING|HOUSING|RESIDENTIAL|SFR\b|PROPERTY MANAGEMENT)\b/i;

/**
 * Classify a purchaser name into the buyer_type enum used by ab_buyers.
 * Returns { buyerType, isInstitutional, isEntity }.
 */
export function classifyBuyer(name) {
  const s = cleanWhitespace(name);
  if (!s) return { buyerType: 'unknown', isInstitutional: false, isEntity: false };
  if (INSTITUTIONAL.test(s)) {
    const servicer = /SERVIC|NATIONSTAR|MR\.? COOPER|CARRINGTON|SELENE|SHELLPOINT|NEWREZ|PENNYMAC|LOANCARE|DOVENMUEHLE|OCWEN|PHH|RUSHMORE|SLS\b|FAY\b/i.test(s);
    return { buyerType: servicer ? 'servicer' : 'institutional_lender', isInstitutional: true, isEntity: true };
  }
  if (NONPROFIT.test(s)) return { buyerType: 'nonprofit', isInstitutional: true, isEntity: true };
  if (GOVERNMENT.test(s)) return { buyerType: 'government', isInstitutional: true, isEntity: true };
  const entity = looksLikeEntity(s);
  if (!entity) return { buyerType: 'individual', isInstitutional: false, isEntity: false };
  if (FLIPPER.test(s)) return { buyerType: 'flipper', isInstitutional: false, isEntity: true };
  if (BUILDER.test(s)) return { buyerType: 'builder', isInstitutional: false, isEntity: true };
  if (LANDLORD.test(s)) return { buyerType: 'landlord', isInstitutional: false, isEntity: true };
  return { buyerType: 'investor_company', isInstitutional: false, isEntity: true };
}

/** Parse "$3,488.66" -> 3488.66 (null when not a number). */
export function parseMoney(s) {
  const m = String(s == null ? '' : s).replace(/[,$\s]/g, '').match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

const MONTHS = { JANUARY: 1, FEBRUARY: 2, MARCH: 3, APRIL: 4, MAY: 5, JUNE: 6, JULY: 7, AUGUST: 8, SEPTEMBER: 9, OCTOBER: 10, NOVEMBER: 11, DECEMBER: 12, JAN: 1, FEB: 2, MAR: 3, APR: 4, JUN: 6, JUL: 7, AUG: 8, SEP: 9, SEPT: 9, OCT: 10, NOV: 11, DEC: 12 };

export function isoDate(d) {
  if (!(d instanceof Date) || isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/** Parse dates as they appear in sale notices. Returns ISO yyyy-mm-dd or null. */
export function parseDateLoose(text) {
  const s = cleanWhitespace(text);
  if (!s) return null;
  let m = s.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/\b(\d{1,2})[\/.](\d{1,2})[\/.](\d{2,4})\b/);
  if (m) {
    let y = parseInt(m[3], 10); if (y < 100) y += 2000;
    return isoDate(new Date(Date.UTC(y, parseInt(m[1], 10) - 1, parseInt(m[2], 10))));
  }
  m = s.match(/\b([A-Z]{3,9})\.?\s+(\d{1,2})(?:ST|ND|RD|TH)?,?\s+(\d{4})\b/i);
  if (m && MONTHS[m[1].toUpperCase()]) return isoDate(new Date(Date.UTC(parseInt(m[3], 10), MONTHS[m[1].toUpperCase()] - 1, parseInt(m[2], 10))));
  m = s.match(/\b(\d{1,2})(?:ST|ND|RD|TH)?\s+(?:DAY\s+OF\s+)?([A-Z]{3,9}),?\s+(\d{4})\b/i);
  if (m && MONTHS[m[2].toUpperCase()]) return isoDate(new Date(Date.UTC(parseInt(m[3], 10), MONTHS[m[2].toUpperCase()] - 1, parseInt(m[1], 10))));
  return null;
}

/** Georgia forced sales happen on the first Tuesday of the month. */
export function firstTuesday(year, month /* 1-12 */) {
  const d = new Date(Date.UTC(year, month - 1, 1));
  const offset = (2 - d.getUTCDay() + 7) % 7;
  return new Date(Date.UTC(year, month - 1, 1 + offset));
}

/** "first Tuesday in June, 2026" -> "2026-06-02". */
export function parseFirstTuesday(text) {
  const m = cleanWhitespace(text).match(/FIRST\s+TUESDAY\s+(?:IN|OF)\s+([A-Z]{3,9}),?\s+(\d{4})/i);
  if (!m || !MONTHS[m[1].toUpperCase()]) return null;
  return isoDate(firstTuesday(parseInt(m[2], 10), MONTHS[m[1].toUpperCase()]));
}

/** Days between two ISO dates (b - a). */
export function daysBetween(a, b) {
  const da = new Date(a + 'T00:00:00Z'), db = new Date(b + 'T00:00:00Z');
  if (isNaN(da) || isNaN(db)) return null;
  return Math.round((db - da) / 86400000);
}

/**
 * Property type from an assessor use / class description or a legal
 * description. Conservative: unknown when nothing matches.
 */
export function propertyTypeFrom(text, fallback = 'unknown') {
  const t = String(text || '').toLowerCase();
  if (!t.trim()) return fallback;
  if (/mobile home|manufactured/.test(t)) return 'mobile_home';
  if (/apartment|multi-?family|multi family|\bmf\b|\br[m]\b|triplex|quadplex|fourplex|4-plex/.test(t)) return 'multifamily';
  if (/duplex|2-plex|two.family/.test(t)) return 'duplex';
  if (/condo/.test(t)) return 'condo';
  if (/townho|town home|row ?house/.test(t)) return 'townhome';
  if (/commercial|office|retail|industrial|warehouse|store|shop|mall|professional|restaurant|hotel|motel|\bc[1-5]\b|\bc-\d\b|\bm-?\d\b|\bi-?\d\b/.test(t)) return 'commercial';
  if (/vacant|land only|acreage|unimproved|lot only|easement|right.of.way|utility|\bv\d?\b|agricultural|farm|timber|conservation/.test(t)) return 'land';
  if (/residential|single|dwelling|\bsfr\b|\br[1-9]\b|\br-\d\b|house|subdivision|\blot \d+/.test(t)) return 'single_family';
  return fallback;
}

/** Strip a site address that a sale notice tucks at the end of a legal description. */
export function addressFromLegal(legal) {
  const s = cleanWhitespace(legal);
  if (!s) return null;
  // Address is the trailing "NNNN STREET NAME TYPE" after the last period / plat reference.
  const m = s.match(/(?:\.|PAGE\s+\d+[.,]?|\d{4}[.,])\s*(\d{1,6}[A-Z]?\s+[A-Z0-9][A-Z0-9 .'&-]{2,60})$/i);
  let cand = m ? m[1] : null;
  if (!cand) {
    const m2 = s.match(/(\d{1,6}[A-Z]?\s+(?:[A-Z]{1,2}\s+)?[A-Z][A-Z0-9'&-]+(?:\s+[A-Z0-9'&.-]+){0,5})$/i);
    cand = m2 ? m2[1] : null;
  }
  if (!cand) return null;
  cand = cleanWhitespace(cand.replace(/^\s*,?\s*/, ''));
  if (!/\d/.test(cand) || cand.length < 6 || cand.length > 70) return null;
  return cand.toUpperCase();
}

export function sha256Hex(bytes) {
  // FNV-1a fallback for tests (no crypto); the worker overrides with real SHA-256.
  let h = 0x811c9dc5;
  const s = typeof bytes === 'string' ? bytes : String(bytes.length);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return ('00000000' + h.toString(16)).slice(-8);
}

export function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

/** Absolute hrefs in an HTML document (deduped, in order). */
export function extractLinks(html, baseUrl) {
  const out = [];
  const seen = new Set();
  const re = /<a\b[^>]*href\s*=\s*["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(String(html || '')))) {
    let href = m[1].trim();
    try { href = new URL(href, baseUrl).toString(); } catch { continue; }
    if (seen.has(href)) continue;
    seen.add(href);
    out.push({ href, text: cleanWhitespace(stripHtml(m[2])) });
  }
  return out;
}
