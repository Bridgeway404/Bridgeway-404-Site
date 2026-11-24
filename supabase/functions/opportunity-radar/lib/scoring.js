// Deterministic, explainable opportunity scoring. A model never produces the
// number: every point comes from a named factor that a person can argue with.

import { territoryTier } from './normalize.js';

const DAY = 86400000;

const WORK_RULES = [
  { re: /\b(demolition|demo|raze|tear ?down|wreck)\b/i, points: 35, label: 'demolition work' },
  { re: /\b(interior (demo|alteration|renovation|build[- ]?out)|tenant (improvement|build[- ]?out|fit[- ]?out)|gut)\b/i, points: 30, label: 'interior demolition or build-out' },
  { re: /\b(renovat\w*|remodel\w*|alteration|rehab\w*|restoration|fire damage|water damage)\b/i, points: 25, label: 'renovation or restoration' },
  { re: /\b(addition|convert|conversion)\b/i, points: 15, label: 'addition or conversion' },
  { re: /\bnew (construction|building|single family|commercial)\b/i, points: 8, label: 'new construction' },
];
// Trade-only permits generate almost no hauling. Excluded outright.
const EXCLUDE = /\b(electrical|plumbing|mechanical|hvac|gas line|sign|fence|low voltage|solar|elevator|fire alarm|sprinkler|re-?roof|roofing only|tree removal|right[- ]of[- ]way)\b/i;

const BID_KEYWORDS = [
  { re: /\b(junk|debris|bulk(y)? (waste|item|trash)|haul(ing)?|clean[- ]?out|trash[- ]?out|illegal dump\w*|litter|vacant (lot|property))\b/i, points: 40, label: 'hauling or clean-out scope' },
  { re: /\b(demolition|abatement|property preservation|lot clearing|grounds maintenance)\b/i, points: 20, label: 'adjacent scope' },
  { re: /\b(janitorial|custodial)\b/i, points: 5, label: 'janitorial scope (weak fit)' },
];
const METRO_CITIES = /\b(atlanta|decatur|marietta|sandy springs|east point|college park|smyrna|roswell|alpharetta|lithonia|stockbridge|forest park|chamblee|dunwoody|tucker|hapeville|union city|riverdale|jonesboro|lawrenceville|norcross|duluth)\b/i;

export function scoreOpportunity(o, now) {
  const factors = [];
  const add = (points, label) => { if (points) factors.push({ points, label }); };
  const nowMs = new Date(now).getTime();
  const age = o.event_at ? (nowMs - new Date(o.event_at).getTime()) / DAY : null;

  if (o.type === 'permit') {
    const text = `${o.work_text ?? ''} ${o.title ?? ''}`;
    const rule = WORK_RULES.find((r) => r.re.test(text));
    if (!rule && EXCLUDE.test(text)) return { score: 0, excluded: 'trade_only_permit', factors: [] };
    if (!rule) return { score: 0, excluded: 'no_hauling_signal', factors: [] };
    add(rule.points, rule.label);
    const tier = territoryTier(o.county);
    if (tier === 'outside') return { score: 0, excluded: 'outside_territory', factors: [] };
    add(tier === 'core' ? 10 : 5, `${tier} territory`);
    if (age == null) add(0, 'no date');
    else if (age > 45) return { score: 0, excluded: 'too_old', factors: [] };
    else add(age <= 7 ? 20 : age <= 14 ? 12 : age <= 30 ? 5 : 0, `issued ${Math.max(0, Math.round(age))} days ago`);
    const v = o.value_cents;
    if (v != null) add(v >= 25000000 ? 6 : v >= 5000000 ? 15 : v >= 1500000 ? 10 : v >= 500000 ? 5 : 0, `job value $${Math.round(v / 100).toLocaleString('en-US')}`);
    if (o.party_name) add(10, 'contractor named (a business to contact)');
    if (/\b(commercial|multi[- ]?family|apartment|office|retail)\b/i.test(`${o.occupancy ?? ''} ${text}`)) add(5, 'commercial or multifamily');
  } else if (o.type === 'bid') {
    const text = `${o.title ?? ''} ${o.work_text ?? ''}`;
    const kw = BID_KEYWORDS.find((k) => k.re.test(text));
    if (!kw) return { score: 0, excluded: 'no_relevant_scope', factors: [] };
    add(kw.points, kw.label);
    const daysLeft = o.due_at ? (new Date(o.due_at).getTime() - nowMs) / DAY : null;
    if (daysLeft != null && daysLeft < 3) return { score: 0, excluded: 'due_too_soon', factors: [] };
    if (daysLeft != null) add(daysLeft >= 10 ? 15 : 8, `${Math.round(daysLeft)} days to respond`);
    if (METRO_CITIES.test(`${o.location ?? ''} ${o.city ?? ''}`) || ['core', 'inner'].includes(territoryTier(o.county))) add(20, 'in Metro Atlanta');
    else return { score: 0, excluded: 'outside_territory', factors: [] };
    if (/small business|8\(a\)|total small/i.test(o.set_aside ?? '')) add(10, 'small-business set-aside');
    if (/sources sought|presolicitation|special notice/i.test(o.notice_type ?? '')) add(-10, 'not yet a solicitation');
  } else {
    return { score: 0, excluded: 'unknown_type', factors: [] };
  }
  const score = Math.max(0, Math.min(100, factors.reduce((s, f) => s + f.points, 0)));
  return { score, excluded: null, factors };
}

export function suggestedAction(o) {
  if (o.type === 'bid') return 'Owner decides bid or pass; read scope and requirements at the link.';
  if (o.party_name) return `Queue a first-touch draft to ${o.party_name} (site clearing / debris haul-off) for approval.`;
  return 'No contractor named: hold for the neighbourhood list; do not contact the property owner.';
}
