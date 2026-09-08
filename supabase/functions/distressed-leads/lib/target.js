// Choose the business most likely to buy Bridgeway's turnover / cleanout
// services for a property, and the best contact inside it. Pure logic over
// the relationships the enrichment stage recorded.

const ROLE_RANK = {
  onsite_manager: 0, regional_manager: 1, property_management: 2, director_operations: 3, maintenance: 4,
  facilities: 5, asset_manager: 6, reo_manager: 7, preservation: 8, owner_rep: 9, portfolio_manager: 10,
  acquisitions: 11, executive: 12, general: 13, other: 14,
};
const CONF_RANK = { high: 0, medium: 1, low: 2 };

const NEVER_TARGET = new Set(['law_firm', 'government', 'individual']);

/**
 * @param {object} ctx
 *   eventType 'foreclosure'|'eviction', stage,
 *   companies: [{ company, relationship, confidence }] where company has id, name, company_type, is_individual, do_not_contact, main_phone, main_email, website
 * Returns { company, reason, contact } or { company: null, reason }.
 */
export function chooseTarget(ctx) {
  const rels = (ctx.companies || []).filter(r => r.company && !r.company.do_not_contact && !r.company.is_individual && !NEVER_TARGET.has(r.company.company_type));
  const byRel = (rel) => rels.filter(r => r.relationship === rel);
  const pick = (list, reason) => list.length ? { company: list.sort((a, b) => CONF_RANK[a.confidence] - CONF_RANK[b.confidence])[0].company, reason } : null;

  let choice = null;
  if (ctx.eventType === 'eviction') {
    // The operator running the building is the buyer. Plaintiffs are often
    // the management company or the ownership LLC; managers beat owners.
    choice = pick(byRel('manager'), 'Property manager of record for the property')
      || pick(byRel('plaintiff').filter(r => r.company.company_type === 'property_management'), 'Plaintiff in the dispossessory case is a property management company')
      || pick(byRel('plaintiff').filter(r => ['multifamily_operator', 'sfr_operator', 'owner_entity', 'institutional_investor', 'reit'].includes(r.company.company_type)), 'Plaintiff in the dispossessory case owns/operates the property')
      || pick(byRel('owner'), 'Owner of record (entity) for the property')
      || pick(byRel('parent'), 'Parent company of the ownership entity')
      || pick(byRel('investor'), 'Investor tied to the property')
      || pick(byRel('plaintiff'), 'Plaintiff in the dispossessory case');
  } else {
    const post = ['sale_completed'].includes(ctx.stage);
    if (post) {
      // After the sale the lender/servicer (REO) or the purchaser controls the asset.
      choice = pick(byRel('purchaser'), 'Purchased the property at the foreclosure sale')
        || pick(byRel('servicer'), 'Loan servicer handling the REO asset after the sale')
        || pick(byRel('foreclosing_entity'), 'Foreclosing entity now holding the property')
        || pick(byRel('lender'), 'Lender that foreclosed on the property')
        || pick(byRel('manager'), 'Property manager of record')
        || pick(byRel('owner'), 'Owner of record (entity)');
    } else {
      choice = pick(byRel('manager'), 'Property manager of record for the property')
        || pick(byRel('owner'), 'Corporate owner of record facing foreclosure (likely turnover / disposition)')
        || pick(byRel('investor'), 'Investor tied to the property')
        || pick(byRel('parent'), 'Parent company of the ownership entity')
        || pick(byRel('servicer'), 'Loan servicer (preservation / REO pipeline) — homeowner-occupied property')
        || pick(byRel('foreclosing_entity'), 'Foreclosing entity (preservation / REO pipeline)')
        || pick(byRel('lender'), 'Lender (preservation / REO pipeline)');
    }
  }
  if (!choice) return { company: null, reason: 'No business-side decision-maker identified yet', contact: null };
  return { ...choice, contact: chooseContact(choice.company.contacts || []) };
}

/** Best contact: operational roles first, then confidence, then contactability. */
export function chooseContact(contacts) {
  const list = (contacts || []).filter(c => c && (c.phone || c.email || c.name));
  if (!list.length) return null;
  return list.slice().sort((a, b) => {
    const ra = ROLE_RANK[a.role_category] ?? 14, rb = ROLE_RANK[b.role_category] ?? 14;
    const ca = CONF_RANK[a.confidence] ?? 2, cb = CONF_RANK[b.confidence] ?? 2;
    const sa = (a.phone ? 1 : 0) + (a.email ? 1 : 0), sb = (b.phone ? 1 : 0) + (b.email ? 1 : 0);
    // A high-confidence contact in a slightly less operational role beats a
    // low-confidence "perfect" role; weight role and confidence together.
    const wa = ra + ca * 4 - sa, wb = rb + cb * 4 - sb;
    return wa - wb;
  })[0];
}

/** Map free-form titles to role categories. */
export function roleFromTitle(title) {
  const t = String(title || '').toLowerCase();
  if (!t) return 'other';
  // "Regional Property Manager" must not fall into the on-site bucket, so regional/portfolio titles are tested first.
  if (/regional|area manager|district manager|senior property manager|portfolio manager/.test(t)) return /portfolio/.test(t) ? 'portfolio_manager' : 'regional_manager';
  if (/community manager|property manager|leasing manager|on-?site|resident manager|assistant manager|general manager/.test(t)) return 'onsite_manager';
  if (/director of operations|vp of operations|operations manager|head of operations|coo\b|chief operating/.test(t)) return 'director_operations';
  if (/maintenance|service manager|turn(over)? manager|make-?ready/.test(t)) return 'maintenance';
  if (/facilit/.test(t)) return 'facilities';
  if (/asset manag/.test(t)) return 'asset_manager';
  if (/reo/.test(t)) return 'reo_manager';
  if (/preservation|field services|vendor manag/.test(t)) return 'preservation';
  if (/acquisition|disposition/.test(t)) return 'acquisitions';
  if (/owner|principal|founder|managing member|managing partner|president|ceo|chief executive|partner/.test(t)) return 'executive';
  if (/property management|management/.test(t)) return 'property_management';
  if (/office|leasing|front desk|reception|general/.test(t)) return 'general';
  return 'other';
}

/** Map AI / heuristic company descriptions to our company_type enum. */
export function companyTypeFrom(text) {
  const t = String(text || '').toLowerCase();
  if (/property management|management company|manages|property manager/.test(t)) return 'property_management';
  if (/reit\b|real estate investment trust/.test(t)) return 'reit';
  if (/single[- ]family rental|sfr|build-to-rent|btr/.test(t)) return 'sfr_operator';
  if (/apartment|multifamily|multi-family|community operator/.test(t)) return 'multifamily_operator';
  if (/institutional|private equity|investment firm|fund\b|capital/.test(t)) return 'institutional_investor';
  if (/servicer|servicing/.test(t)) return 'servicer';
  if (/bank|lender|mortgage|credit union|lending/.test(t)) return 'lender';
  if (/law firm|attorney|llp|p\.c\./.test(t)) return 'law_firm';
  if (/preservation|field services/.test(t)) return 'preservation';
  if (/asset management|asset manager/.test(t)) return 'asset_manager';
  if (/reo\b/.test(t)) return 'reo';
  if (/county|city of|state of|housing authority|hud\b|government/.test(t)) return 'government';
  if (/nonprofit|non-profit|church|ministr/.test(t)) return 'nonprofit';
  if (/individual|person|homeowner/.test(t)) return 'individual';
  if (/llc|inc\b|corp|holdings|properties|investments|trust/.test(t)) return 'owner_entity';
  return 'unknown';
}
