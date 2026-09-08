// Bridgeway Opportunity Score: transparent, additive, capped at 100.
// Every factor is recorded in the breakdown so the Admin UI can show why.
import { isTurnoverStage } from './stages.js';

const STAGE_POINTS = {
  eviction_scheduled: 45,
  eviction_executed: 42,
  possession_returned: 40,
  writ_pending_execution: 38,
  writ_issued: 35,
  judgment_entered: 18,
  hearing_scheduled: 10,
  service_completed: 6,
  dispossessory_filed: 4,
  status_unknown: 2,
  sale_completed: 40,
  sale_imminent: 35,
  sale_scheduled: 25,
  notice_published: 15,
  sale_cancelled: 0,
  dismissed: 0,
};

const CORPORATE_TYPES = new Set(['institutional_investor', 'reit', 'sfr_operator', 'multifamily_operator', 'owner_entity', 'asset_manager', 'reo', 'lender', 'servicer']);
const LOCAL_AREA_CODES = /\b(404|470|678|770|943)\b/;

function daysBetween(aIso, bIso) {
  if (!aIso || !bIso) return null;
  return Math.round((new Date(bIso + 'T00:00:00Z') - new Date(aIso + 'T00:00:00Z')) / 86400000);
}

/**
 * @param {object} input
 *  stage, eventType, eventDate (ISO), today (ISO), propertyType,
 *  owner: { name, isEntity, companyType } | null,
 *  manager: { companyType } | null, investor: {...} | null,
 *  target: { companyType, activeProperties, phone, email, website, hqAddress, mainPhone } | null,
 *  contact: { confidence, phone, email, roleCategory } | null,
 *  ownerEvidenceConfidence: 'high'|'medium'|'low'|null
 */
export function scoreOpportunity(input) {
  const b = [];
  const add = (factor, points, note) => { if (points) b.push({ factor, points, note: note || null }); };
  const stage = input.stage || 'status_unknown';

  // 1. Turnover stage (max 45)
  const stagePts = STAGE_POINTS[stage] ?? 0;
  add('stage', stagePts, `${stage}`);

  // 2. Timing (recency / imminence)
  if (input.eventDate && input.today) {
    const d = daysBetween(input.eventDate, input.today); // days since event date (negative = future)
    if (input.eventType === 'foreclosure') {
      if (d !== null && d < 0 && -d <= 14) add('timing', 5, 'sale within 14 days');
      if (d !== null && d > 60) add('timing', -10, 'sale more than 60 days ago');
      if (d !== null && d > 120) add('timing', -10, 'sale more than 120 days ago');
    } else {
      if (isTurnoverStage(stage) && d !== null && Math.abs(d) <= 14) add('timing', 5, 'execution within 14 days');
      if (d !== null && d > 60) add('timing', -10, 'event more than 60 days old');
      if (d !== null && d > 120) add('timing', -10, 'event more than 120 days old');
    }
  }

  // 3. Ownership / control (max 25)
  let control = 0;
  const owner = input.owner;
  if (owner && owner.isEntity) {
    if (CORPORATE_TYPES.has(owner.companyType)) control += 12; else control += 8;
    add('owner', CORPORATE_TYPES.has(owner.companyType) ? 12 : 8, 'corporate / entity owner identified');
  }
  if (input.manager) { control += 10; add('manager', 10, 'professional property manager identified'); }
  if (input.propertyType === 'multifamily') { control += 8; add('property_type', 8, 'multifamily property'); }
  if (input.investor && !input.manager) { control += 5; add('investor', 5, 'investor identified'); }
  if (input.target && ['sfr_operator', 'institutional_investor', 'reit'].includes(input.target.companyType)) {
    control += 6; add('operator', 6, 'large rental operator / institutional owner');
  }
  let controlCapped = Math.min(control, 25);

  // 4. Contact availability (max 20)
  let contact = 0;
  const c = input.contact;
  if (c) {
    if (c.confidence === 'high') { contact += 10; add('contact', 10, 'decision-maker identified (high confidence)'); }
    else if (c.confidence === 'medium') { contact += 6; add('contact', 6, 'contact identified (medium confidence)'); }
    else { contact += 3; add('contact', 3, 'contact identified (low confidence)'); }
    if (c.phone) { contact += 5; add('phone', 5, 'business phone available'); }
    if (c.email) { contact += 5; add('email', 5, 'business email available'); }
  } else if (input.target) {
    if (input.target.mainPhone) { contact += 5; add('phone', 5, 'company main phone available'); }
    if (input.target.mainEmail) { contact += 3; add('email', 3, 'company main email available'); }
    if (!input.target.mainPhone && !input.target.mainEmail && input.target.website) { contact += 2; add('website', 2, 'company website only'); }
  }
  const contactCapped = Math.min(contact, 20);

  // 5. Evidence & relationships (max 10)
  let rel = 0;
  if (input.ownerEvidenceConfidence === 'high') { rel += 4; add('evidence', 4, 'strong ownership evidence (assessor match)'); }
  const n = input.target ? (input.target.activeProperties || 0) : 0;
  if (n >= 3) { rel += 6; add('portfolio', 6, `${n} active properties tied to this company`); }
  else if (n === 2) { rel += 3; add('portfolio', 3, '2 active properties tied to this company'); }
  const local = input.target && ((input.target.mainPhone && LOCAL_AREA_CODES.test(input.target.mainPhone)) || /\bGA\b|GEORGIA/i.test(input.target.hqAddress || ''));
  if (local) { rel += 2; add('local', 2, 'company operates locally'); }
  const relCapped = Math.min(rel, 10);

  // 6. Penalties
  let penalty = 0;
  const homeownerOnly = input.eventType === 'foreclosure' && owner && !owner.isEntity && !input.manager && !input.investor && (!input.target || ['individual', 'unknown', 'law_firm'].includes(input.target.companyType));
  if (homeownerOnly) { penalty -= 15; add('homeowner_only', -15, 'only an individual homeowner identified; not a B2B target'); }
  if (input.target && input.target.companyType === 'law_firm') { penalty -= 10; add('law_firm_target', -10, 'only a law firm identified'); }

  const raw = stagePts + b.filter(x => x.factor === 'timing').reduce((s, x) => s + x.points, 0) + controlCapped + contactCapped + relCapped + penalty;
  const score = Math.max(0, Math.min(100, Math.round(raw)));
  return { score, breakdown: b, caps: { control: controlCapped, contact: contactCapped, relationships: relCapped } };
}

export function priorityBand(score) {
  if (score >= 70) return 'high';
  if (score >= 45) return 'medium';
  return 'low';
}

/** Enrichment priority: which properties get research budget first. */
export function enrichmentPriority(p) {
  let n = STAGE_POINTS[p.stage] ?? 0;
  if (p.propertyType === 'multifamily') n += 10;
  if (p.ownerIsEntity) n += 8;
  if (p.plaintiffIsEntity) n += 6;
  if (p.repeatCompany) n += 6;
  if (p.hasAddress) n += 4;
  return n;
}
