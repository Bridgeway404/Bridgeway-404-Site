// Pure parsers for the public sale lists we can read as text. Each returns
// { saleDate, items: [{ parcel_id, list_owner_name, address, amount_due,
//   legal, tax_years, deed_book }], diagnostics }.
// A parser never throws on a bad document: it returns zero items and says why.
import { cleanWhitespace, parseDateLoose, parseFirstTuesday, parseMoney, addressFromLegal } from './normalize.js';

/**
 * Douglas County Tax Commissioner tax-sale legal (text PDF). Blocks look like:
 *   MAP AND PARCEL: 00300250045
 *   CURRENT RECORD HOLDER: ABDUL-HAQQ NAJIB & AISHAH
 *   DEFENDANT IN FI-FA: SAME AS CRH(S)
 *   AMOUNT DUE: $3,488.66
 *   TAX YEARS DUE: 2025
 *   DEED BOOK: 1729/705
 *   LEGAL DESCRIPTION: ALL THAT TRACT ... PLAT BOOK 7, PAGE 144. 5240 KINGS HWY
 * Page breaks ("=====PAGE=====") can fall anywhere inside a block.
 */
export function parseDouglasTaxSale(text) {
  const raw = String(text || '').replace(/\r/g, '').replace(/\n*=====PAGE=====\n*/g, '\n');
  const diagnostics = [];
  const saleDate = parseFirstTuesday(raw) || parseDateLoose((raw.match(/the same\s+being\s+([A-Za-z]+ \d{1,2}, \d{4})/i) || [])[1] || '');
  if (!saleDate) diagnostics.push('sale date not found in notice header');
  const items = [];
  const re = /MAP AND PARCEL:\s*([A-Z0-9-]+)\s*\n([\s\S]*?)(?=\nMAP AND PARCEL:|\s*$)/g;
  let m;
  while ((m = re.exec(raw))) {
    const parcel = m[1].trim();
    const body = m[2];
    const field = (label) => {
      const r = new RegExp(label + ':\\s*([\\s\\S]*?)(?=\\n[A-Z][A-Z /-]{3,}:|$)', 'i').exec(body);
      return r ? cleanWhitespace(r[1]) : null;
    };
    const holder = field('CURRENT RECORD HOLDER');
    const legal = field('LEGAL DESCRIPTION');
    if (!holder && !legal) continue;
    items.push({
      parcel_id: parcel,
      list_owner_name: holder,
      defendant: field('DEFENDANT IN FI-FA'),
      amount_due: parseMoney(field('AMOUNT DUE')),
      tax_years: field('TAX YEARS DUE'),
      deed_book: field('DEED BOOK'),
      legal,
      address: addressFromLegal(legal),
    });
  }
  if (!items.length) diagnostics.push(/MAP AND PARCEL/i.test(raw) ? 'blocks found but none parsed' : 'no "MAP AND PARCEL" blocks in document (scanned image or different layout?)');
  return { saleDate, items, diagnostics };
}

/**
 * Henry County Tax Commissioner "Properties for Judicial Tax Sale" list (text PDF).
 *   Parcel Number Name Location Sale Date Amount Owed
 *   M01502012000 FRESH MACHINE LLC 1110 WHISPER WIND DR MCD 10/06/2026 Click Here
 */
export function parseHenryTaxSale(text) {
  const raw = String(text || '').replace(/\r/g, '').replace(/\n*=====PAGE=====\n*/g, '\n');
  const diagnostics = [];
  const headerDate = parseDateLoose((raw.match(/TAX SALE\s+(?:ON\s+)?(?:[A-Z]+DAY\s+)?([A-Z]+ \d{1,2}(?:ST|ND|RD|TH)?,? \d{4})/i) || [])[1] || '');
  const items = [];
  const lineRe = /^([A-Z0-9-]{8,16})\s+(.+?)\s+(\d{1,6}[A-Z]?\s+[A-Z0-9][A-Z0-9 .'&-]*?)\s+(\d{1,2}\/\d{1,2}\/\d{4})(?:\s+(.*))?$/;
  for (const line of raw.split('\n')) {
    const s = cleanWhitespace(line);
    if (!s || /^Parcel Number/i.test(s)) continue;
    const m = lineRe.exec(s);
    if (!m) continue;
    const saleDate = parseDateLoose(m[4]);
    items.push({ parcel_id: m[1], list_owner_name: cleanWhitespace(m[2]), address: cleanWhitespace(m[3]).toUpperCase(), sale_date: saleDate, amount_due: parseMoney(m[5] || '') });
  }
  const saleDate = items.find(i => i.sale_date)?.sale_date || headerDate || null;
  if (!items.length) diagnostics.push(/Parcel Number/i.test(raw) ? 'header found but no parcel rows parsed' : 'no parcel rows found (empty list or layout changed)');
  return { saleDate, items, diagnostics };
}

/**
 * Generic fallback for county tax-sale lists laid out as "parcel  owner  address" rows.
 * Only used when a county-specific parser is not available; conservative.
 */
export function parseGenericParcelRows(text) {
  const raw = String(text || '').replace(/\r/g, '');
  const items = [];
  const re = /^(\d{2}[- ]\d{3,4}[- ]\d{2,4}[- ]\d{3}(?:[- ]\d)?|[0-9]{2}[0-9A-Z]{6,14})\s+(.{6,120})$/;
  for (const line of raw.split('\n')) {
    const m = re.exec(cleanWhitespace(line));
    if (!m) continue;
    items.push({ parcel_id: m[1], list_owner_name: null, address: null, note: m[2] });
  }
  return { saleDate: parseFirstTuesday(raw) || null, items, diagnostics: items.length ? [] : ['no parcel-looking rows'] };
}

/** True when a PDF's extracted text is (almost) empty: a scanned image. */
export function looksScanned(text, pages) {
  const t = String(text || '').replace(/=====PAGE=====/g, '').replace(/\s+/g, '');
  const perPage = t.length / Math.max(1, pages || 1);
  return perPage < 40;
}

/**
 * DeKalb County Tax Commissioner "Excess Funds" list (text PDF). Every row is a
 * property that actually SOLD at a DeKalb tax sale for more than the debt:
 *   PARCEL ID EXCESS AMOUNT SALEDATE FIRST NAME MIDDLE LAST NAME SITUS ADDRESS CITY ZIP CODE
 *   16 152 11 020 $16,223.28 10/7/2025 CALVIN CHAN 7163 SWIFT ST LITHONIA 30058
 * The name columns run together; we keep them as the pre-sale owner ("defendant").
 */
const DEKALB_CITY_RE = /\s+(STONE MOUNTAIN|AVONDALE ESTATES|PINE LAKE|DECATUR|LITHONIA|ATLANTA|TUCKER|SCOTTDALE|CLARKSTON|ELLENWOOD|CHAMBLEE|DORAVILLE|DUNWOODY|BROOKHAVEN|STONECREST|CONLEY|REDAN|LILBURN|NORCROSS|SMYRNA|DUNWOODY)\s*$/i;

export function parseDekalbExcessFunds(text) {
  const raw = String(text || '').replace(/\r/g, '').replace(/\n*=====PAGE=====\n*/g, '\n');
  const diagnostics = [];
  const asOf = parseDateLoose((raw.match(/As of\s+(\d{1,2}\/\d{1,2}\/\d{4})/i) || [])[1] || '');
  const items = [];
  const re = /^(\d{2} \d{3} \d{2} \d{3}[A-Z]?)\s+\$?([\d,]+\.\d{2})\s+(\d{1,2}\/\d{1,2}\/\d{4})\s+(.+?)\s+(\d{5})\s*$/;
  for (const line of raw.split('\n')) {
    const s = cleanWhitespace(line);
    const m = re.exec(s);
    if (!m) continue;
    const rest = m[4];
    // Situs address starts at the first house number that is followed by a street word.
    let owner = rest, address = null, city = null;
    const cm = rest.match(DEKALB_CITY_RE);
    const body = cm ? rest.slice(0, cm.index) : rest;
    if (cm) city = cm[1];
    const am = body.match(/^(.*?)\s+(\d{1,6}(?:\s+[A-Z]{1,2})?\s+[A-Za-z0-9][A-Za-z0-9 .'&-]*?)\s*$/);
    if (am) { owner = am[1]; address = am[2]; }
    else if (cm) { owner = body; }
    items.push({ parcel_id: m[1], excess_amount: parseMoney(m[2]), sale_date: parseDateLoose(m[3]), list_owner_name: cleanWhitespace(owner) || null, address: address ? cleanWhitespace(address).toUpperCase() : null, city: city ? cleanWhitespace(city).toUpperCase() : null, zip: m[5] });
  }
  if (!items.length) diagnostics.push(/EXCESS FUNDS/i.test(raw) ? 'header found but no rows parsed' : 'not an excess funds list');
  return { asOf, items, diagnostics };
}

/**
 * Douglas County Tax Commissioner "TAX SALES 2000-FORWARD OVERAGE" file (text PDF).
 * Columns: SALE DATE, DEL TAXPAYER NAME, PARCEL#, YEARS OPEN, PURCHASER, SALE PRICE, OVERAGE, CLAIMED
 *   8/5/2025 VARNER, DEBBIE M ESTATE ... 07320130011 2022-2024 MKIM RD LLC / MAXMILLIAN SUN KIM $89,000.00 $76,196.31 NO
 * This is the one metro source that names the PURCHASER directly.
 */
export function parseDouglasExcessFunds(text) {
  const raw = String(text || '').replace(/\r/g, '').replace(/\n*=====PAGE=====\n*/g, '\n');
  const diagnostics = [];
  const items = [];
  const re = /^(\d{1,2}\/\d{1,2}\/\d{4})\s+(.+?)\s+([A-Z]{0,2}\d[A-Z0-9]{7,12}(?:\([^)]*\))?)\s+((?:\d{4}(?:\s*[-,&]\s*|\s+)?)+)\s+(.+?)\s*\$?([\d,]+\.\d{2})\s+(\$?[\d,]+\.\d{2}|NONE)\s+(YES|NO|N\/A|GA DEPT OF REV|Ga Dept of Rev|GA Dept of Rev)?\s*$/i;
  for (const line of raw.split('\n')) {
    const s = cleanWhitespace(line);
    const m = re.exec(s);
    if (!m) continue;
    const purchaser = cleanWhitespace(m[5]).replace(/\s*\/\s*$/, '');
    if (!purchaser) continue;
    items.push({
      sale_date: parseDateLoose(m[1]),
      list_owner_name: cleanWhitespace(m[2]),
      parcel_id: m[3].replace(/\(.*\)$/, ''),
      tax_years: cleanWhitespace(m[4]),
      purchaser,
      sale_price: parseMoney(m[6]),
      excess_amount: /NONE/i.test(m[7]) ? 0 : parseMoney(m[7]),
      claimed: m[8] || null,
    });
  }
  if (!items.length) diagnostics.push(/OVERAGE/i.test(raw) ? 'header found but no rows parsed' : 'not the Douglas overage file');
  return { items, diagnostics };
}

/**
 * "MKIM RD LLC / MAXMILLIAN SUN KIM" -> { entity: 'MKIM RD LLC', person: 'MAXMILLIAN SUN KIM' }
 * "LARITA JONES & OMARI BENJAMIN"    -> { entity: null, person: 'LARITA JONES & OMARI BENJAMIN' }
 */
export function splitPurchaser(purchaser) {
  const s = cleanWhitespace(purchaser);
  if (!s) return { entity: null, person: null };
  const parts = s.split(/\s*\/\s*/).map(cleanWhitespace).filter(Boolean);
  if (parts.length >= 2) return { entity: parts[0], person: parts.slice(1).join(' / ') };
  return { entity: null, person: s };
}

/**
 * DeKalb Tax Commissioner "Tax Sale List" HTML page (upcoming sale). Table columns:
 * Tax Sale Date | Parcel ID | Map Ref | Tax Sale ID | Owner | Address | Tenant | Defendant | Levy Type | Lien Book | Page | Levy Date | Min Year | Max Year | Total Tax Due
 */
export function parseDekalbTaxSaleHtml(html) {
  const diagnostics = [];
  const items = [];
  const src = String(html || '');
  const rows = src.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  for (const row of rows) {
    const cells = (row.match(/<td[^>]*>[\s\S]*?<\/td>/gi) || []).map(c => cleanWhitespace(c.replace(/<br\s*\/?>/gi, ' | ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')));
    if (cells.length < 15) continue;
    const saleDate = parseDateLoose(cells[0].replace(/-/g, ' '));
    if (!saleDate) continue;
    items.push({ sale_date: saleDate, parcel_id: cells[1], tax_sale_id: cells[3], list_owner_name: cells[4] || null, address: cells[5] ? cells[5].toUpperCase() : null, defendant: cells[7] || null, levy_type: cells[8] || null, amount_due: parseMoney(cells[14]) });
  }
  if (!items.length) diagnostics.push(/Tax Sale Date/i.test(src) ? 'table header found but no rows' : (/unavailable due to maintenance/i.test(src) ? 'DeKalb site reports maintenance' : 'no tax sale table on page'));
  return { items, diagnostics };
}

/**
 * Henry County Tax Commissioner "Excess Funds" list (text PDF). Rows:
 *   PARCEL ID OWNER ADDRESS SALE DATE EXCESS FUNDS [PURCHASE AMT]
 *   043A01137000 AKK INVESTMENTS LLC 101 WAVERLY BLVD, ELLENWOOD 2/3/2026 $23,602.57 $30,000.00
 *   S32-02005000 HAYGOOD ROBERT E & MILDRED OAKLAND BLVD 2/6/2024 5,436.96$
 *   006A04002000 WOOZEVALT JEAN PIERRE LLC 350 ROBIN HOOD LN, HMPT 2/3/2026 REDEEMED $32,000.00
 */
export function parseHenryExcessFunds(text) {
  const raw = String(text || '').replace(/\r/g, '').replace(/\n*=====PAGE=====\n*/g, '\n');
  const diagnostics = [];
  const items = [];
  const re = /^([A-Z0-9][A-Z0-9-]{8,14})\s+(.+?)\s+(\d{1,2}\/\d{1,2}\/\d{4}|\d{1,2}\/\d{6})\s*(.*)$/;
  for (const line of raw.split('\n')) {
    const s = cleanWhitespace(line);
    if (!s || /^PARCEL ID/i.test(s)) continue;
    const m = re.exec(s);
    if (!m) continue;
    const rest = m[4] || '';
    const redeemed = /REDEEMED/i.test(rest);
    const noProceeds = /NO PROCEEDS/i.test(rest);
    const money = rest.match(/\$?[\d,]+\.\d{2}\$?/g) || [];
    const excess = money.length ? parseMoney(money[0]) : (noProceeds ? 0 : null);
    const purchase = money.length >= 2 ? parseMoney(money[1]) : null;
    let owner = m[2], address = null, landOnly = false;
    const hm = m[2].match(/^(.*?)\s+(\d{1,6}[A-Z]?(?:\/\d+)?\s+[A-Z0-9][A-Z0-9 .,'&-]*)$/i);
    if (hm) { owner = hm[1]; address = hm[2]; }
    else {
      const lm = m[2].match(/^(.*?)\s+((?:LOT ONLY|LAND ONLY|LOT|HWY \d+ [A-Z] LOT ONLY)|[A-Z]+ (?:RD|DR|LN|CT|ST|BLVD|CIR|WAY|TRL|PL|CR|PKWY|HWY)(?:,? [A-Z]{2,4})?)$/i);
      if (lm) { owner = lm[1]; address = lm[2]; landOnly = /LOT|LAND/i.test(lm[2]); }
    }
    items.push({ parcel_id: m[1], list_owner_name: cleanWhitespace(owner), address: address ? cleanWhitespace(address).toUpperCase() : null, land_only: landOnly, sale_date: parseDateLoose(m[3].length === 9 ? m[3].replace(/(\d{2})(\d{4})$/, '$1/$2') : m[3]), excess_amount: excess, purchase_price: purchase, redeemed, no_proceeds: noProceeds });
  }
  if (!items.length) diagnostics.push(/PARCEL ID/i.test(raw) ? 'header found but no rows parsed' : 'not the Henry excess funds list');
  return { items, diagnostics };
}
