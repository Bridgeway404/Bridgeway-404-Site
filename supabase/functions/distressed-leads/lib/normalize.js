// Normalization helpers shared by every adapter. Pure functions, no I/O.

export const COUNTIES = ['Fulton', 'DeKalb', 'Douglas', 'Henry'];

const STREET_TYPES = {
  AVENUE: 'AVE', AV: 'AVE', AVE: 'AVE',
  BOULEVARD: 'BLVD', BLVD: 'BLVD',
  CIRCLE: 'CIR', CIR: 'CIR',
  COURT: 'CT', CT: 'CT',
  DRIVE: 'DR', DR: 'DR',
  HIGHWAY: 'HWY', HWY: 'HWY',
  LANE: 'LN', LN: 'LN',
  PARKWAY: 'PKWY', PKWY: 'PKWY', PKY: 'PKWY',
  PLACE: 'PL', PL: 'PL',
  ROAD: 'RD', RD: 'RD',
  STREET: 'ST', ST: 'ST', STR: 'ST',
  TERRACE: 'TER', TER: 'TER', TERR: 'TER',
  TRAIL: 'TRL', TRL: 'TRL', TR: 'TRL',
  WAY: 'WAY',
  LOOP: 'LOOP', RUN: 'RUN', PATH: 'PATH', PASS: 'PASS', POINT: 'PT', PT: 'PT',
  SQUARE: 'SQ', SQ: 'SQ', CROSSING: 'XING', XING: 'XING', COVE: 'CV', CV: 'CV',
  BEND: 'BND', BND: 'BND', RIDGE: 'RDG', RDG: 'RDG', HOLLOW: 'HOLW', HOLW: 'HOLW',
  CREEK: 'CRK', CRK: 'CRK', HILL: 'HL', HL: 'HL', HILLS: 'HLS', HLS: 'HLS',
  MANOR: 'MNR', MNR: 'MNR', GLEN: 'GLN', GLN: 'GLN', WALK: 'WALK', VIEW: 'VW', VW: 'VW',
  ROW: 'ROW', ALLEY: 'ALY', ALY: 'ALY', EXTENSION: 'EXT', EXT: 'EXT', CONNECTOR: 'CONN', CONN: 'CONN',
};
const DIRECTIONS = { NORTH: 'N', SOUTH: 'S', EAST: 'E', WEST: 'W', NORTHEAST: 'NE', NORTHWEST: 'NW', SOUTHEAST: 'SE', SOUTHWEST: 'SW', N: 'N', S: 'S', E: 'E', W: 'W', NE: 'NE', NW: 'NW', SE: 'SE', SW: 'SW' };
const UNIT_WORDS = ['UNIT', 'APT', 'APARTMENT', 'STE', 'SUITE', 'BLDG', 'BUILDING', '#', 'LOT', 'NO', 'NUMBER'];

export function cleanWhitespace(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

/**
 * Split a US street address into parts and build a stable dedupe key.
 * "1234 N. Peachtree Street NE, Unit 5B, Atlanta, GA 30309" ->
 *   { number: '1234', street: 'N PEACHTREE ST NE', unit: '5B', city: 'ATLANTA', zip: '30309',
 *     norm: '1234 N PEACHTREE ST NE #5B' }
 */
export function parseAddress(input) {
  const raw = cleanWhitespace(input).replace(/\.(?=\s|,|$)/g, '');
  if (!raw) return null;
  // Dotted compass abbreviations ("S.W.", "N. E.") collapse before punctuation is stripped.
  let s = raw.toUpperCase()
    .replace(/\b([NS])\.?\s?([EW])\.?(?=[\s,]|$)/g, '$1$2')
    .replace(/[.,]+/g, ' ').replace(/\s+/g, ' ').trim();
  // Zip
  let zip = null;
  const zm = s.match(/\b(\d{5})(?:-\d{4})?\b\s*$/);
  if (zm) { zip = zm[1]; s = s.slice(0, zm.index).trim(); }
  // State
  s = s.replace(/\b(GEORGIA|GA)\s*$/, '').trim();
  // City: try known city list first, else last comma-less token run after street type
  let city = null;
  const cityMatch = s.match(/\b(ATLANTA|ALPHARETTA|ROSWELL|SANDY SPRINGS|JOHNS CREEK|MILTON|EAST POINT|COLLEGE PARK|UNION CITY|FAIRBURN|PALMETTO|HAPEVILLE|CHATTAHOOCHEE HILLS|SOUTH FULTON|MOUNTAIN PARK|DECATUR|STONE MOUNTAIN|LITHONIA|TUCKER|DUNWOODY|BROOKHAVEN|CHAMBLEE|DORAVILLE|CLARKSTON|AVONDALE ESTATES|PINE LAKE|STONECREST|ELLENWOOD|SCOTTDALE|DOUGLASVILLE|LITHIA SPRINGS|VILLA RICA|WINSTON|MCDONOUGH|STOCKBRIDGE|HAMPTON|LOCUST GROVE|REX|JONESBORO|CONYERS|MABLETON|AUSTELL|SMYRNA|MARIETTA|NORCROSS|PEACHTREE CORNERS|FOREST PARK|RIVERDALE|MORROW|LOVEJOY|FAYETTEVILLE|PEACHTREE CITY|TYRONE|ACWORTH|KENNESAW|WOODSTOCK|CUMMING|LAWRENCEVILLE|DULUTH|SNELLVILLE|LILBURN|GRAYSON|SUWANEE|BUFORD|DALLAS|POWDER SPRINGS|NEWNAN|SHARPSBURG|GRIFFIN|JACKSON|COVINGTON|LOGANVILLE)\s*$/);
  if (cityMatch) { city = cityMatch[1]; s = s.slice(0, cityMatch.index).trim(); }
  // Unit
  let unit = null;
  const um = s.match(/\b(?:UNIT|APT|APARTMENT|STE|SUITE|BLDG|BUILDING|LOT|NO|NUMBER)\s*#?\s*([A-Z0-9-]+)\s*$/) || s.match(/#\s*([A-Z0-9-]+)\s*$/);
  if (um) { unit = um[1]; s = s.slice(0, um.index).trim(); }
  const tokens = s.split(' ').filter(Boolean);
  if (!tokens.length) return null;
  let number = null;
  if (/^\d+[A-Z]?$/.test(tokens[0])) number = tokens.shift();
  const out = tokens.map((t, i) => {
    if (DIRECTIONS[t] && (i === 0 || i === tokens.length - 1)) return DIRECTIONS[t];
    if (STREET_TYPES[t] && i > 0) return STREET_TYPES[t];
    return t;
  });
  const street = out.join(' ').trim();
  if (!street) return null;
  const norm = [number, street].filter(Boolean).join(' ') + (unit ? ' #' + unit : '');
  return { number, street, unit, city, zip, norm, raw };
}

export function normalizeAddress(input) {
  const p = parseAddress(input);
  return p ? p.norm : null;
}

/** Parcel ids: strip everything but alphanumerics, upper-case. "14 0077 0008 039-9" -> "14007700080399" */
export function normalizeParcel(input) {
  const s = String(input == null ? '' : input).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return s.length >= 6 ? s : null;
}

/** Company-name dedupe key (same rule as the existing prospects table). */
export function nameKey(name) {
  return String(name == null ? '' : name).toLowerCase().replace(/[^a-z0-9]/g, '');
}

const ENTITY_WORDS = /\b(LLC|L\.L\.C|INC|CORP|CORPORATION|COMPANY|CO\b|LP|L\.P|LLP|LTD|TRUST|TRUSTEE|BANK|N\.A|NA\b|ASSOCIATION|ASSOC|PARTNERS|PARTNERSHIP|HOLDINGS|PROPERTIES|REALTY|INVESTMENTS|INVESTMENT|CAPITAL|GROUP|FUND|VENTURES|ENTERPRISES|MANAGEMENT|MGMT|HOMES|RENTALS|APARTMENTS|APTS|ASSET|MORTGAGE|LENDING|FINANCIAL|SERVICING|SERVICES|SOLUTIONS|ACQUISITIONS|DEVELOPMENT|AUTHORITY|HOUSING|CHURCH|MINISTRIES|FOUNDATION|UNIVERSITY|COUNTY|CITY OF|STATE OF|UNITED STATES|HUD|FANNIE MAE|FREDDIE MAC|FEDERAL|CREDIT UNION|SERIES|RESIDENTIAL|EQUITY|PORTFOLIO|OPPORTUNITY|REIT|PLC|CLUB|VILLAGE|VILLAS|PLAZA|TOWERS?|LOFTS|FLATS|COMMONS|POINTE?|GARDENS|MANOR|ESTATES|HEIGHTS|CROSSINGS?|LANDING|SQUARE|STATION|RESERVE|COMMUNITIES|COMMUNITY|LIVING|SENIOR|PARK|PLACE|RIDGE|CREEK|TERRACE|TOWNHOMES|CONDOMINIUMS?|COURT|GLEN|COVE|TRACE|GROVE|WOODS|OAKS|PINES|LAKES?|HILLS?|VISTA|VIEW|RUN|MILL|GATE|GATES|WALK)\b/i;

/** True when a name looks like an organization rather than a person. */
export function looksLikeEntity(name) {
  const s = cleanWhitespace(name);
  if (!s) return false;
  if (ENTITY_WORDS.test(s)) return true;
  if (/\d/.test(s)) return true; // "588 PAINES", "2018-2 IH BORROWER" — people's names have no digits
  const words = s.split(' ').filter(Boolean);
  if (words.length === 1) return true; // a single word is a brand / community, never a full personal name
  if (words.length >= 4) return true;
  return false;
}

export function cleanName(name) {
  return cleanWhitespace(name).replace(/\s*,\s*$/, '').replace(/\s{2,}/g, ' ');
}

/** Georgia foreclosure sales occur on the first Tuesday of the month. */
export function firstTuesday(year, month /* 1-12 */) {
  const d = new Date(Date.UTC(year, month - 1, 1));
  const dow = d.getUTCDay(); // 0 Sun .. 2 Tue
  const offset = (2 - dow + 7) % 7;
  return new Date(Date.UTC(year, month - 1, 1 + offset));
}

const MONTHS = { JANUARY: 1, FEBRUARY: 2, MARCH: 3, APRIL: 4, MAY: 5, JUNE: 6, JULY: 7, AUGUST: 8, SEPTEMBER: 9, OCTOBER: 10, NOVEMBER: 11, DECEMBER: 12, JAN: 1, FEB: 2, MAR: 3, APR: 4, JUN: 6, JUL: 7, AUG: 8, SEP: 9, SEPT: 9, OCT: 10, NOV: 11, DEC: 12 };

export function isoDate(d) {
  if (!(d instanceof Date) || isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/** Parse dates as they appear in notices and calendars. Returns ISO yyyy-mm-dd or null. */
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
  if (m && MONTHS[m[1].toUpperCase()]) {
    return isoDate(new Date(Date.UTC(parseInt(m[3], 10), MONTHS[m[1].toUpperCase()] - 1, parseInt(m[2], 10))));
  }
  m = s.match(/\b(\d{1,2})(?:ST|ND|RD|TH)?\s+(?:DAY\s+OF\s+)?([A-Z]{3,9}),?\s+(\d{4})\b/i);
  if (m && MONTHS[m[2].toUpperCase()]) {
    return isoDate(new Date(Date.UTC(parseInt(m[3], 10), MONTHS[m[2].toUpperCase()] - 1, parseInt(m[1], 10))));
  }
  return null;
}

/** "first Tuesday in October, 2026" / "first Tuesday of November 2026" -> ISO date. */
export function parseFirstTuesday(text) {
  const m = cleanWhitespace(text).match(/FIRST\s+TUESDAY\s+(?:IN|OF)\s+([A-Z]{3,9}),?\s+(\d{4})/i);
  if (!m || !MONTHS[m[1].toUpperCase()]) return null;
  return isoDate(firstTuesday(parseInt(m[2], 10), MONTHS[m[1].toUpperCase()]));
}

export function detectCounty(text) {
  const s = String(text || '');
  const m = s.match(/\b(FULTON|DEKALB|DE KALB|DOUGLAS|HENRY)\s+COUNTY/i)
    || s.match(/\bCOUNTY\s+OF\s+(FULTON|DEKALB|DE KALB|DOUGLAS|HENRY)\b/i);
  if (!m) return null;
  const w = m[1].toUpperCase().replace(' ', '');
  return w === 'FULTON' ? 'Fulton' : w === 'DEKALB' ? 'DeKalb' : w === 'DOUGLAS' ? 'Douglas' : 'Henry';
}

/** Cheap content hash (FNV-1a) for change detection of raw records. */
export function contentHash(text) {
  let h = 0x811c9dc5;
  const s = String(text == null ? '' : text);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return ('00000000' + h.toString(16)).slice(-8) + ':' + s.length;
}

export function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}
