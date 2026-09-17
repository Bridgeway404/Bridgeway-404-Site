// Source adapters: where the public sale lists and sale RESULTS come from.
// Each adapter is { id, county, label, kind, discover(ctx) } and returns
// { records, documents, diagnostics }. It never throws for a bad or missing
// document: one blocked county must not end the run. Network access goes
// through ctx.fetchDoc (HTML or PDF → text) so tests inject fixtures.
//
// A record is one property seen on a list:
//   { county, parcel_id, address, city, zip, sale_type, sale_date, list_owner_name,
//     amount_due, purchaser_name, purchase_price, sold: true|false, redeemed,
//     property_hint, list_url, list_label, evidence }
//
// kind 'sold'     — the county only publishes this row when the sale COMPLETED
//                   (excess-funds / overage lists), so it is proof of a sale
// kind 'upcoming' — an advertisement; the pipeline must verify the sale later
import { parseDouglasTaxSale, parseDouglasExcessFunds, parseDekalbExcessFunds, parseDekalbTaxSaleHtml, parseHenryTaxSale, parseHenryExcessFunds, looksScanned, splitPurchaser } from './parsers.js';
import { extractLinks, cleanWhitespace } from './normalize.js';

function todayIso(ctx) { return (ctx.now ? ctx.now() : new Date()).toISOString().slice(0, 10); }
/** Oldest sale date worth tracking (settings.lookback_days, default 450 days). */
function cutoffIso(ctx) { return ctx.lookbackDate || new Date(Date.parse(todayIso(ctx)) - 450 * 86400000).toISOString().slice(0, 10); }

/** Find document links on a page, most recent first, else fall back to known URLs. */
async function findLinks(ctx, pages, match, fallbacks = [], diagnostics = []) {
  const found = [];
  for (const page of pages) {
    const res = await ctx.fetchDoc(page);
    if (!res.ok) { diagnostics.push(`could not open ${page} (HTTP ${res.status || res.error || '?'})`); continue; }
    for (const l of extractLinks(res.text || '', res.url || page)) {
      if (match.test(l.href) || match.test(l.text || '')) found.push({ href: l.href, text: l.text });
    }
  }
  const seen = new Set();
  const out = found.filter(l => !seen.has(l.href) && seen.add(l.href));
  for (const f of fallbacks) if (!seen.has(f)) { out.push({ href: f, text: 'known location', fallback: true }); seen.add(f); }
  return out;
}

async function fetchList(ctx, link, sourceId, county, docs, diagnostics) {
  const res = await ctx.fetchDoc(link.href);
  const doc = { source_id: sourceId, county, url: link.href, label: link.text || null, status_code: res.status || 0, sha256: res.sha256 || null, pages: res.pages || 0, text: res.text || null, parsed_count: 0, notes: null };
  docs.push(doc);
  if (!res.ok) { doc.notes = `HTTP ${res.status || res.error || 'error'}`; diagnostics.push(`${link.href}: ${doc.notes}`); return null; }
  if (res.isPdf && looksScanned(res.text, res.pages)) { doc.notes = 'scanned image PDF (no text layer); needs OCR'; diagnostics.push(`${link.href}: scanned image, no text layer`); return { scanned: true, doc, res }; }
  return { scanned: false, doc, res };
}

function evidenceLine(label, url, extra) { return `${label} (${url})${extra ? ': ' + extra : ''}`; }

// ---------------------------------------------------------------- Douglas

export const douglasExcessFunds = {
  id: 'douglas_excess_funds', county: 'Douglas', kind: 'sold',
  label: 'Douglas County Tax Commissioner overage file (names the purchaser of every tax-sale parcel)',
  notes: 'Text PDF updated after each sale; the only metro source that prints the purchaser name.',
  async discover(ctx) {
    const diagnostics = [], docs = [], records = [];
    const links = (await findLinks(ctx, ['https://douglastax.org/excess-funds'], /EXCESS[-_ ]?FUNDS[-_ ]?FILE[^"']*\.pdf$/i, ['https://douglastax.org/pdf/2026/09/EXCESS-FUNDS-FILE-FOR-PDF.pdf'], diagnostics)).filter(l => !/affidavit|claim|form/i.test(l.href));
    for (const link of links.slice(0, 2)) {
      const got = await fetchList(ctx, link, this.id, 'Douglas', docs, diagnostics);
      if (!got || got.scanned) continue;
      const parsed = parseDouglasExcessFunds(got.res.text);
      diagnostics.push(...parsed.diagnostics.map(d => `${link.href}: ${d}`));
      const cutoff = cutoffIso(ctx);
      for (const it of parsed.items) {
        if (!it.sale_date || it.sale_date < cutoff) continue;
        const p = splitPurchaser(it.purchaser);
        records.push({ county: 'Douglas', parcel_id: it.parcel_id, address: null, sale_type: 'tax_sale', sale_date: it.sale_date, list_owner_name: it.list_owner_name,
          purchaser_name: it.purchaser, purchaser_entity: p.entity, purchaser_person: p.person, purchase_price: it.sale_price, sold: true, redeemed: false,
          list_url: link.href, list_label: 'Douglas County overage file',
          evidence: evidenceLine('Douglas County Tax Commissioner overage file', link.href, `parcel ${it.parcel_id} sold at the ${it.sale_date} tax sale to ${it.purchaser} for $${(it.sale_price || 0).toLocaleString('en-US')}; prior owner ${it.list_owner_name}`) });
      }
      got.doc.parsed_count = parsed.items.length;
      if (parsed.items.length) break;
    }
    return { records, documents: docs, diagnostics };
  },
};

export const douglasTaxSaleLists = {
  id: 'douglas_tax_sale_lists', county: 'Douglas', kind: 'upcoming',
  label: 'Douglas County Tax Commissioner tax-sale legal notices (upcoming sales)',
  notes: 'Text PDFs published four weeks before each first-Tuesday sale.',
  async discover(ctx) {
    const diagnostics = [], docs = [], records = [];
    const links = (await findLinks(ctx, ['https://douglastax.org/property-tax-sales'], /Tax[-_ ]?Sale[^"']*\.pdf$|RE[-_]Legals[^"']*\.pdf$/i, [], diagnostics)).filter(l => !/MH[-_]|mobile|booklet|process|guide/i.test(l.href));
    if (!links.length) diagnostics.push('no tax-sale legal PDF linked right now (lists appear about four weeks before a sale)');
    for (const link of links.slice(0, 3)) {
      const got = await fetchList(ctx, link, this.id, 'Douglas', docs, diagnostics);
      if (!got || got.scanned) continue;
      const parsed = parseDouglasTaxSale(got.res.text);
      diagnostics.push(...parsed.diagnostics.map(d => `${link.href}: ${d}`));
      got.doc.parsed_count = parsed.items.length;
      for (const it of parsed.items) {
        records.push({ county: 'Douglas', parcel_id: it.parcel_id, address: it.address, sale_type: 'tax_sale', sale_date: parsed.saleDate, list_owner_name: it.list_owner_name, amount_due: it.amount_due,
          property_hint: it.legal, sold: false, list_url: link.href, list_label: `Douglas County tax sale ${parsed.saleDate || ''}`.trim(),
          evidence: evidenceLine('Douglas County tax-sale legal notice', link.href, `parcel ${it.parcel_id} (${it.address || 'no address printed'}) advertised for the ${parsed.saleDate || 'upcoming'} sale; record holder ${it.list_owner_name}`) });
      }
    }
    return { records, documents: docs, diagnostics };
  },
};

// ---------------------------------------------------------------- DeKalb

export const dekalbExcessFunds = {
  id: 'dekalb_excess_funds', county: 'DeKalb', kind: 'sold',
  label: 'DeKalb County Tax Commissioner excess-funds list (parcels that sold at tax sale)',
  notes: 'Text PDF; a row exists only when the parcel sold for more than the debt. Purchaser is not printed; the assessor roll is checked for the new owner.',
  async discover(ctx) {
    const diagnostics = [], docs = [], records = [];
    const links = await findLinks(ctx, ['https://dekalbtaxga.gov/property-tax/delinquent-taxes/'], /Excess[-_ ]?Funds[-_ ]?List[^"']*\.pdf$/i, ['https://dekalbtax.org/wp-content/uploads/Excess-Funds-List.pdf'], diagnostics);
    for (const link of links.slice(0, 2)) {
      const got = await fetchList(ctx, link, this.id, 'DeKalb', docs, diagnostics);
      if (!got || got.scanned) continue;
      const parsed = parseDekalbExcessFunds(got.res.text);
      diagnostics.push(...parsed.diagnostics.map(d => `${link.href}: ${d}`));
      got.doc.parsed_count = parsed.items.length;
      const cutoff = cutoffIso(ctx);
      for (const it of parsed.items) {
        if (!it.sale_date || it.sale_date < cutoff) continue;
        records.push({ county: 'DeKalb', parcel_id: it.parcel_id, address: it.address, city: it.city, zip: it.zip, sale_type: 'tax_sale', sale_date: it.sale_date, list_owner_name: it.list_owner_name,
          sold: true, redeemed: false, list_url: link.href, list_label: `DeKalb County excess funds list (as of ${parsed.asOf || 'latest'})`,
          evidence: evidenceLine('DeKalb County Tax Commissioner excess-funds list', link.href, `parcel ${it.parcel_id} (${it.address || ''} ${it.city || ''}) sold at the ${it.sale_date} tax sale with $${(it.excess_amount || 0).toLocaleString('en-US')} excess; owner of record before the sale ${it.list_owner_name}`) });
      }
      if (parsed.items.length) break;
    }
    return { records, documents: docs, diagnostics };
  },
};

export const dekalbTaxSaleListing = {
  id: 'dekalb_tax_sale_listing', county: 'DeKalb', kind: 'upcoming',
  label: 'DeKalb County Tax Commissioner tax-sale listing (upcoming sale, HTML)',
  notes: 'HTML table on the public-access site; the site is sometimes down for maintenance.',
  async discover(ctx) {
    const diagnostics = [], docs = [], records = [];
    const url = 'https://publicaccess.dekalbtaxga.gov/forms/htmlframe.aspx?mode=content/search/tax_sale_listing.html';
    const got = await fetchList(ctx, { href: url, text: 'DeKalb tax sale listing' }, this.id, 'DeKalb', docs, diagnostics);
    if (got && !got.scanned) {
      const parsed = parseDekalbTaxSaleHtml(got.res.text);
      diagnostics.push(...parsed.diagnostics.map(d => `${url}: ${d}`));
      got.doc.parsed_count = parsed.items.length;
      got.doc.text = null; // HTML page; nothing worth keeping
      for (const it of parsed.items) {
        records.push({ county: 'DeKalb', parcel_id: it.parcel_id, address: it.address, sale_type: 'tax_sale', sale_date: it.sale_date, list_owner_name: it.list_owner_name, amount_due: it.amount_due, sold: false,
          list_url: url, list_label: `DeKalb County tax sale ${it.sale_date}`,
          evidence: evidenceLine('DeKalb County tax-sale listing', url, `parcel ${it.parcel_id} (${it.address || ''}) advertised for the ${it.sale_date} sale; owner ${it.list_owner_name}`) });
      }
    }
    return { records, documents: docs, diagnostics };
  },
};

// ---------------------------------------------------------------- Henry

export const henryExcessFunds = {
  id: 'henry_excess_funds', county: 'Henry', kind: 'sold',
  label: 'Henry County Tax Commissioner excess-funds list (parcels that sold at tax sale)',
  notes: 'Text PDF. Henry publishes no owner names in GIS and blocks automated assessor lookups, so purchasers must be confirmed by hand.',
  async discover(ctx) {
    const diagnostics = [], docs = [], records = [];
    const links = await findLinks(ctx, ['https://henrycountytax.com/239/EXCESS-FUNDS'], /DocumentCenter\/View\/296|Excess[-_ ]?Funds[-_ ]?List/i, ['https://ga-henrycountytaxcollector.civicplus.com/DocumentCenter/View/296'], diagnostics);
    for (const link of links.filter(l => !/MOBILE/i.test(l.href + l.text)).slice(0, 2)) {
      const got = await fetchList(ctx, link, this.id, 'Henry', docs, diagnostics);
      if (!got || got.scanned) continue;
      const parsed = parseHenryExcessFunds(got.res.text);
      diagnostics.push(...parsed.diagnostics.map(d => `${link.href}: ${d}`));
      got.doc.parsed_count = parsed.items.length;
      const cutoff = cutoffIso(ctx);
      for (const it of parsed.items) {
        if (!it.sale_date || it.sale_date < cutoff) continue;
        records.push({ county: 'Henry', parcel_id: it.parcel_id, address: it.address, sale_type: 'tax_sale', sale_date: it.sale_date, list_owner_name: it.list_owner_name, purchase_price: it.purchase_price,
          sold: true, redeemed: it.redeemed, property_hint: it.land_only ? 'land only' : null, list_url: link.href, list_label: 'Henry County excess funds list',
          evidence: evidenceLine('Henry County Tax Commissioner excess-funds list', link.href, `parcel ${it.parcel_id} (${it.address || 'no address printed'}) sold at the ${it.sale_date} tax sale${it.purchase_price ? ' for $' + it.purchase_price.toLocaleString('en-US') : ''}${it.redeemed ? '; since REDEEMED by the former owner' : ''}; prior owner ${it.list_owner_name}`) });
      }
      if (parsed.items.length) break;
    }
    return { records, documents: docs, diagnostics };
  },
};

export const henryTaxSaleList = {
  id: 'henry_tax_sale_list', county: 'Henry', kind: 'upcoming',
  label: 'Henry County Tax Commissioner property tax sale list (upcoming sale)',
  notes: 'Text PDF behind the "Property Tax for Sale List" page.',
  async discover(ctx) {
    const diagnostics = [], docs = [], records = [];
    const url = 'https://www.henrycountytax.com/243/PROPERTY-TAX-FOR-SALE-LIST';
    const got = await fetchList(ctx, { href: url, text: 'Henry County property tax sale list' }, this.id, 'Henry', docs, diagnostics);
    if (got && !got.scanned) {
      const parsed = parseHenryTaxSale(got.res.text);
      diagnostics.push(...parsed.diagnostics.map(d => `${url}: ${d}`));
      got.doc.parsed_count = parsed.items.length;
      for (const it of parsed.items) {
        records.push({ county: 'Henry', parcel_id: it.parcel_id, address: it.address, sale_type: 'tax_sale', sale_date: it.sale_date || parsed.saleDate, list_owner_name: it.list_owner_name, sold: false,
          list_url: got.res.url || url, list_label: `Henry County tax sale ${it.sale_date || parsed.saleDate || ''}`.trim(),
          evidence: evidenceLine('Henry County tax sale list', got.res.url || url, `parcel ${it.parcel_id} (${it.address || ''}) advertised for the ${it.sale_date || parsed.saleDate} sale; owner ${it.list_owner_name}`) });
      }
    }
    return { records, documents: docs, diagnostics };
  },
};

// ---------------------------------------------------------------- Fulton

export const fultonSheriffLevyLists = {
  id: 'fulton_sheriff_levy_lists', county: 'Fulton', kind: 'upcoming',
  label: "Fulton County Sheriff's levy (tax) sale lists",
  notes: 'The Sheriff posts scanned-image PDFs with no text layer. They are recorded and can be read with the optional Claude OCR when an API key is saved; Fulton publishes no results or excess-funds list online (open-records request only).',
  async discover(ctx) {
    const diagnostics = [], docs = [], records = [];
    const links = await findLinks(ctx, ['https://fultoncountyga.gov/inside-fulton-county/fulton-county-departments/sheriff/tax-sales', 'https://fcsoga.org/tax-sales/'], /Tax-Sales\/20\d\d\/[^"']*\.pdf$|Levy[-_ ]?Sale[^"']*\.pdf$/i, [], diagnostics);
    if (!links.length) diagnostics.push('no levy sale list linked right now');
    let ocrBudget = ctx.ocr ? 2 : 0;
    for (const link of links.slice(0, 4)) {
      const got = await fetchList(ctx, link, this.id, 'Fulton', docs, diagnostics);
      if (!got) continue;
      if (got.scanned) {
        if (ocrBudget > 0 && got.res.bytes) {
          ocrBudget--;
          try {
            const rows = await ctx.ocr(got.res.bytes, link.href);
            got.doc.parsed_count = rows.length;
            got.doc.notes = `scanned image PDF; ${rows.length} parcels read by OCR`;
            for (const r of rows) records.push({ county: 'Fulton', parcel_id: r.parcel_id, address: r.address, sale_type: 'levy_sale', sale_date: r.sale_date || null, list_owner_name: r.owner_name || null, sold: false,
              list_url: link.href, list_label: `Fulton County Sheriff levy sale ${r.sale_date || ''}`.trim(),
              evidence: evidenceLine("Fulton County Sheriff's levy sale list (OCR)", link.href, `parcel ${r.parcel_id} (${r.address || ''}) advertised; defendant ${r.owner_name || 'n/a'}`) });
          } catch (e) { diagnostics.push(`${link.href}: OCR failed: ${String(e.message || e).slice(0, 160)}`); }
        } else {
          got.doc.notes = 'scanned image PDF (no text layer); save an Anthropic API key to OCR it';
        }
        continue;
      }
      diagnostics.push(`${link.href}: has a text layer but no Fulton parser is written for its layout yet`);
    }
    return { records, documents: docs, diagnostics };
  },
};

// ---------------------------------------------------------------- Cobb

export const cobbTaxSaleLists = {
  id: 'cobb_tax_sale_lists', county: 'Cobb', kind: 'upcoming',
  label: 'Cobb County Tax Commissioner tax-sale and excess-funds lists',
  notes: 'Cobb holds two sales a year (May and November) and posts the list four weeks ahead. Its linked PDFs were missing (HTTP 404) when this was built; the adapter re-checks every run.',
  async discover(ctx) {
    const diagnostics = [], docs = [], records = [];
    const links = await findLinks(ctx, ['https://www.cobbtax.gov/property/tax_sale/index.php', 'https://www.cobbtax.gov/property/delinquent_taxes/index.php'], /(tax[-_ ]?sale|excess[-_ ]?funds|delinquent[-_ ]?tax[-_ ]?list)[^"']*\.pdf(\?|$)/i, [], diagnostics);
    if (!links.length) diagnostics.push('no tax sale or excess funds PDF linked right now');
    for (const link of links.filter(l => !/booklet|packet|request/i.test(l.href)).slice(0, 3)) {
      const got = await fetchList(ctx, link, this.id, 'Cobb', docs, diagnostics);
      if (!got || got.scanned) continue;
      diagnostics.push(`${link.href}: document fetched (${got.res.pages || 0} pages); no Cobb row parser yet — review by hand`);
    }
    return { records, documents: docs, diagnostics };
  },
};

export const SOURCES = [douglasExcessFunds, douglasTaxSaleLists, dekalbExcessFunds, dekalbTaxSaleListing, henryExcessFunds, henryTaxSaleList, fultonSheriffLevyLists, cobbTaxSaleLists];
export function getSource(id) { return SOURCES.find(s => s.id === id) || null; }
export function sourcesFor(counties) { const set = new Set((counties || []).map(cleanWhitespace)); return SOURCES.filter(s => !set.size || set.has(s.county)); }
