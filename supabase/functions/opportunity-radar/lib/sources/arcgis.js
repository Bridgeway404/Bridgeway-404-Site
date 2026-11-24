// Generic adapter for a public ArcGIS FeatureServer / MapServer layer that
// publishes building permits. One adapter, many jurisdictions: each source in
// sources/index.js supplies its layer URL and candidate field names.
//
// Uses only the documented public query endpoint. No login, no scraping.

import { pick, toIso, toCents } from '../normalize.js';

const PAGE = 1000;

export function buildQueryUrl(layerUrl, { dateField, since, offset = 0, pageSize = PAGE }) {
  const day = new Date(since).toISOString().slice(0, 10);
  const p = new URLSearchParams({
    where: `${dateField} >= TIMESTAMP '${day} 00:00:00'`,
    outFields: '*',
    orderByFields: `${dateField} DESC`,
    returnGeometry: 'false',
    resultOffset: String(offset),
    resultRecordCount: String(pageSize),
    f: 'json',
  });
  return `${layerUrl.replace(/\/$/, '')}/query?${p}`;
}

export async function fetchArcgisPermits(source, { http, since, maxPages = 5 }) {
  const out = [];
  for (let page = 0; page < maxPages; page++) {
    const url = buildQueryUrl(source.layerUrl, { dateField: source.dateField, since, offset: page * PAGE });
    const res = await http.get(url, { accept: 'application/json', cache: false });
    if (!res.ok) throw new Error(`${source.id}: HTTP ${res.status}`);
    let body;
    try { body = JSON.parse(res.text); } catch { throw new Error(`${source.id}: response was not JSON`); }
    if (body.error) throw new Error(`${source.id}: ${body.error.message ?? 'service error'}`);
    const features = body.features ?? [];
    for (const f of features) { const o = mapPermit(source, f.attributes); if (o) out.push(o); }
    if (!body.exceededTransferLimit || features.length === 0) break;
  }
  return out;
}

export function mapPermit(source, a) {
  const F = source.fields;
  const ref = pick(a, F.permitNumber);
  if (ref == null) return null;                       // cannot dedupe without a permit number
  const description = [pick(a, F.workClass), pick(a, F.permitType), pick(a, F.description)].filter(Boolean).join(' | ');
  return {
    type: 'permit',
    source_id: source.id,
    source_ref: `${source.id}:${String(ref).trim()}`,
    title: String(pick(a, F.description) ?? pick(a, F.permitType) ?? 'Building permit').slice(0, 200),
    work_text: description,
    location: pick(a, F.address) ? String(pick(a, F.address)).trim() : null,
    county: source.county,
    event_at: toIso(pick(a, F.date)),
    value_cents: toCents(pick(a, F.valuation)),
    party_name: pick(a, F.contractor) ? String(pick(a, F.contractor)).trim() : null,
    party_role: 'contractor',
    occupancy: pick(a, F.occupancy) ? String(pick(a, F.occupancy)) : null,
    status: pick(a, F.status) ? String(pick(a, F.status)) : null,
    url: source.publicUrl ?? null,
  };
}
