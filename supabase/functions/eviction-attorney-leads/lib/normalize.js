// Normalization helpers shared by the worker and its tests. Pure functions.
// The dedupe keys mirror the SQL helpers in migration 0007 (eal_name_key,
// eal_firm_key, eal_phone_key, eal_host_key) so the JS pre-filter and the
// database agree on what "the same attorney" means.

export function cleanWhitespace(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

const HONORIFICS = /\b(esq|esquire|attorney at law|attorney|jr|sr|ii|iii|iv|mr|mrs|ms|dr)\b\.?/gi;

/** Same as SQL eal_name_key(): honorifics/suffixes dropped, alphanumerics only. */
export function nameKey(name) {
  return String(name == null ? '' : name).toLowerCase().replace(HONORIFICS, '').replace(/[^a-z0-9]/g, '');
}

const FIRM_WORDS = /\b(the|llc|l\.l\.c|pc|p\.c|llp|l\.l\.p|pllc|pa|p\.a|inc|ltd|co|and associates|& associates|associates|attorneys at law|attorney at law|law offices? of|law offices?|law group|law firm|law)\b\.?/gi;

/** Same as SQL eal_firm_key(). */
export function firmKey(name) {
  return String(name == null ? '' : name).toLowerCase().replace(FIRM_WORDS, ' ').replace(/[^a-z0-9]/g, '');
}

/** Same as SQL eal_phone_key(): last ten digits, or '' when there are fewer. */
export function phoneKey(phone) {
  const d = String(phone == null ? '' : phone).replace(/[^0-9]/g, '');
  return d.length >= 10 ? d.slice(-10) : '';
}

/** Same as SQL eal_host_key(): bare hostname without www. */
export function hostKey(url) {
  return String(url == null ? '' : url).trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').replace(/[/?#].*$/, '');
}

export function formatPhone(phone) {
  const k = phoneKey(phone);
  if (!k) return cleanWhitespace(phone) || null;
  return `(${k.slice(0, 3)}) ${k.slice(3, 6)}-${k.slice(6)}`;
}

const SMALL = new Set(['of', 'and', 'the', 'at', 'for', 'de', 'la', 'von', 'van']);

/** "J MIKE WILLIAMS" -> "J Mike Williams"; leaves mixed-case input alone. */
export function titleCase(s) {
  const t = cleanWhitespace(s);
  if (!t || t !== t.toUpperCase()) return t;
  return t.toLowerCase().split(' ').map((w, i) => {
    if (i > 0 && SMALL.has(w)) return w;
    // McNeal / O'Brien / hyphenated names
    return w.replace(/(^|[-'])([a-z])/g, (m, p, c) => p + c.toUpperCase()).replace(/^mc([a-z])/, (m, c) => 'Mc' + c.toUpperCase());
  }).join(' ');
}

/**
 * Clean an attorney name as printed on a court calendar: drop "Esq.",
 * "Esquire", "Attorney at Law", trailing commas; normalize ALL CAPS.
 * "SAVANNAH SMARCH" -> "Savannah Smarch"; "Simren Patel, Esquire" -> "Simren Patel".
 */
export function cleanAttorneyName(name) {
  let s = cleanWhitespace(name);
  s = s.replace(/,?\s*\b(esq|esquire|attorney at law|attorney)\b\.?/gi, '');
  s = s.replace(/^d\s+/i, '');            // "D " prefix leaked from DeKalb calendar column
  s = s.replace(/[\s,]+$/, '').replace(/\s{2,}/g, ' ');
  return titleCase(s);
}

const ENTITY_WORDS = /\b(llc|l\.l\.c|inc|corp|corporation|company|co|lp|l\.p|llp|lllp|ltd|trust|trustee|bank|association|assoc|partners|partnership|holdings|properties|realty|investments|capital|group|fund|ventures|management|mgmt|homes|rentals|apartments|apts|housing|authority|foundation|coalition|church|ministries|county|city of|state of|united states|department|program|services|solutions|payment|rent|dispossessory|non-?payment|plaintiff|defendant|landlord|tenant|magistrate|court|pro se)\b/i;

/** True when a calendar "attorney" cell is really a person's name (2–4 words, no entity words, no digits). */
export function looksLikePersonName(name) {
  const s = cleanWhitespace(name);
  if (!s) return false;
  if (/\d/.test(s)) return false;
  if (ENTITY_WORDS.test(s)) return false;
  const words = s.split(' ').filter(Boolean);
  if (words.length < 2 || words.length > 4) return false;
  if (!/^[A-Za-z.'\-\s]+$/.test(s)) return false;
  return true;
}

/** Strip a trailing "(n)" count that eal_court_record_stats appends to plaintiff names. */
export function plaintiffLabel(s) {
  return cleanWhitespace(s).replace(/\s*\(\d+\)\s*$/, '');
}
