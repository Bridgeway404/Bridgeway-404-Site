// SAM.gov contract opportunities (federal bids). Public API; needs a free API
// key issued to a registered SAM.gov account. The key is read from Vault by the
// caller and never logged.

import { toIso } from '../normalize.js';

export const NAICS = ['562111', '562119', '561720', '238910', '561210'];
const mmddyyyy = (d) => { const x = new Date(d); return `${String(x.getUTCMonth() + 1).padStart(2, '0')}/${String(x.getUTCDate()).padStart(2, '0')}/${x.getUTCFullYear()}`; };

export function buildSamUrl({ apiKey, since, until, naics, state = 'GA', limit = 100, offset = 0 }) {
  const p = new URLSearchParams({ api_key: apiKey, postedFrom: mmddyyyy(since), postedTo: mmddyyyy(until), ncode: naics, state, limit: String(limit), offset: String(offset) });
  return `https://api.sam.gov/opportunities/v2/search?${p}`;
}

export async function fetchSamOpportunities(source, { http, since, now, apiKey }) {
  if (!apiKey) throw new Error('sam_gov: no API key configured');
  const out = [];
  for (const naics of source.naics ?? NAICS) {
    const res = await http.get(buildSamUrl({ apiKey, since, until: now, naics }), { accept: 'application/json', cache: false });
    if (!res.ok) throw new Error(`sam_gov: HTTP ${res.status}`);
    const body = JSON.parse(res.text);
    for (const o of body.opportunitiesData ?? []) { const m = mapSam(o); if (m) out.push(m); }
  }
  return out;
}

export function mapSam(o) {
  if (!o?.noticeId) return null;
  const pop = o.placeOfPerformance ?? {};
  return {
    type: 'bid',
    source_id: 'sam_gov',
    source_ref: `sam_gov:${o.noticeId}`,
    title: String(o.title ?? 'Federal opportunity').slice(0, 200),
    work_text: [o.title, o.type, o.naicsCode, o.typeOfSetAsideDescription].filter(Boolean).join(' | '),
    location: [pop.city?.name, pop.state?.code, pop.zip].filter(Boolean).join(', ') || null,
    county: null,
    city: pop.city?.name ?? null,
    event_at: toIso(o.postedDate),
    due_at: toIso(o.responseDeadLine),
    party_name: o.fullParentPathName ?? null,
    party_role: 'agency',
    set_aside: o.typeOfSetAsideDescription ?? null,
    notice_type: o.type ?? null,
    url: o.uiLink ?? null,
  };
}
