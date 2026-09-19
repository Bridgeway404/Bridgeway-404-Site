// Court-record candidates: plaintiff-side attorneys named on the
// dispossessory calendars the distressed pipeline already harvested
// (eal_court_record_stats). This is the strongest evidence available that an
// attorney actually files evictions for landlords / property managers, so it
// is the first source every run reads. Pure: takes rows, returns leads.
import { cleanAttorneyName, looksLikePersonName, nameKey, plaintiffLabel } from './normalize.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmt(d) {
  if (!d) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d));
  if (!m) return String(d);
  return `${MONTHS[+m[2] - 1]} ${+m[3]}, ${m[1]}`;
}

/**
 * rows: [{ attorney, county, filings, plaintiffs, business_plaintiffs, top_plaintiffs[], first_hearing, last_hearing, source_urls[] }]
 * Returns qualified leads sorted by filings, most first.
 *
 * Qualification (quality over volume):
 *   * the cell must read as a person's name (junk like "Payment of Rent" or an
 *     entity name that leaked into the attorney column is dropped);
 *   * at least one plaintiff must be a business landlord / owner entity /
 *     management company (lenders, servicers, government and individuals do
 *     not count — a bank's post-foreclosure eviction counsel is not a
 *     property-management referral source);
 *   * and either the attorney filed >= minFilings cases or represents >= 2
 *     different business plaintiffs.
 */
export function buildCourtCandidates(rows, { minFilings = 2, counties = null } = {}) {
  const byName = new Map();
  for (const r of rows || []) {
    const name = cleanAttorneyName(r.attorney);
    if (!looksLikePersonName(name)) continue;
    if (counties && counties.length && !counties.includes(r.county)) continue;
    const key = nameKey(name);
    if (!key) continue;
    let g = byName.get(key);
    if (!g) { g = { name, best: 0, perCounty: [] }; byName.set(key, g); }
    // The calendars spell one attorney several ways ("J Mike Williams",
    // "J. Mike Williams"): fold every spelling into one row per county.
    let pc = g.perCounty.find(x => x.county === r.county);
    if (!pc) { pc = { county: r.county, filings: 0, plaintiffs: 0, business_plaintiffs: 0, top_plaintiffs: [], first_hearing: null, last_hearing: null, source_urls: [] }; g.perCounty.push(pc); }
    if ((r.filings || 0) > g.best) { g.best = r.filings || 0; g.name = name; } // keep the most common spelling
    pc.filings += r.filings || 0;
    pc.plaintiffs += r.plaintiffs || 0;
    pc.business_plaintiffs += r.business_plaintiffs || 0;
    for (const t of r.top_plaintiffs || []) if (!pc.top_plaintiffs.includes(t)) pc.top_plaintiffs.push(t);
    if (r.first_hearing && (!pc.first_hearing || r.first_hearing < pc.first_hearing)) pc.first_hearing = r.first_hearing;
    if (r.last_hearing && (!pc.last_hearing || r.last_hearing > pc.last_hearing)) pc.last_hearing = r.last_hearing;
    for (const u of r.source_urls || []) if (u && !pc.source_urls.includes(u)) pc.source_urls.push(u);
  }
  const out = [];
  for (const g of byName.values()) {
    const filings = g.perCounty.reduce((n, r) => n + (r.filings || 0), 0);
    const business = g.perCounty.reduce((n, r) => n + (r.business_plaintiffs || 0), 0);
    const plaintiffs = g.perCounty.reduce((n, r) => n + (r.plaintiffs || 0), 0);
    if (business < 1) continue;
    if (filings < minFilings && business < 2) continue;
    g.perCounty.sort((a, b) => (b.filings || 0) - (a.filings || 0));
    const clients = [];
    const sentences = [];
    const urls = [];
    for (const r of g.perCounty) {
      const top = (r.top_plaintiffs || []).map(plaintiffLabel).filter(Boolean);
      for (const t of top) if (!clients.includes(t)) clients.push(t);
      const range = r.first_hearing && r.last_hearing && r.first_hearing !== r.last_hearing
        ? `${fmt(r.first_hearing)} – ${fmt(r.last_hearing)}` : fmt(r.last_hearing || r.first_hearing);
      sentences.push(`Court records: appeared as plaintiff's attorney on ${r.filings} dispossessory case${r.filings === 1 ? '' : 's'} on the ${r.county} County Magistrate Court calendars${range ? ` (${range})` : ''} for ${r.business_plaintiffs} landlord / property-management entit${r.business_plaintiffs === 1 ? 'y' : 'ies'}${top.length ? `, including ${top.slice(0, 5).join(', ')}` : ''}.`);
      for (const u of r.source_urls || []) if (u && !urls.includes(u)) urls.push(u);
    }
    const confidence = filings >= 10 || business >= 3 ? 'high' : filings >= 3 ? 'medium' : 'low';
    const referral = business >= 5 ? 'high' : business >= 2 ? 'medium' : 'low';
    out.push({
      attorney_name: g.name,
      firm_name: null,
      county: g.perCounty[0].county,
      counties: g.perCounty.map(r => r.county),
      practice_area: 'Landlord-tenant / dispossessory (plaintiff side)',
      clients_identified: clients.slice(0, 8).join('; ') || null,
      evidence: sentences.join('\n'),
      source_url: urls[0] || null,
      source_urls: urls.slice(0, 6),
      source_kind: 'court_records',
      filing_count: filings,
      plaintiff_count: plaintiffs,
      confidence,
      referral_potential: referral,
      enrichment_status: 'pending',
    });
  }
  out.sort((a, b) => b.filing_count - a.filing_count || a.attorney_name.localeCompare(b.attorney_name));
  return out;
}
