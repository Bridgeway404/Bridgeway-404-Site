// One Radar run: fetch every enabled source, normalise, dedupe, score, store,
// and build the digest. A failing source is recorded and never stops the run.

import { fetchArcgisPermits } from './sources/arcgis.js';
import { fetchSamOpportunities } from './sources/sam.js';
import { dedupe } from './dedupe.js';
import { scoreOpportunity } from './scoring.js';
import { buildDigest } from './report.js';

const DAY = 86400000;
const FETCHERS = { arcgis_permits: fetchArcgisPermits, sam_gov: fetchSamOpportunities };

/**
 * @param {object} deps {sources, http, store, now, lookbackDays?, secrets?, digestLimit?, threshold?}
 *   store: {upsertOpportunity(o) -> 'created'|'updated'|'unchanged', expireOlderThan(iso) -> number}
 */
export async function runRadar({ sources, http, store, now, lookbackDays = 14, secrets = {}, digestLimit = 5, threshold = 50 }) {
  const since = new Date(new Date(now).getTime() - lookbackDays * DAY).toISOString();
  const summary = { started_at: new Date(now).toISOString(), sources: {}, fetched: 0, duplicates: 0, merged: 0, excluded: {}, created: 0, updated: 0, unchanged: 0, errors: [] };
  const raw = [];

  for (const source of sources) {
    const fetcher = FETCHERS[source.kind];
    try {
      if (!fetcher) throw new Error(`no adapter for kind ${source.kind}`);
      const items = await fetcher(source, { http, since, now, apiKey: secrets[source.id] });
      summary.sources[source.id] = { ok: true, fetched: items.length };
      raw.push(...items);
    } catch (e) {
      summary.sources[source.id] = { ok: false, error: String(e.message ?? e) };
      summary.errors.push({ source: source.id, error: String(e.message ?? e) });
    }
  }
  summary.fetched = raw.length;

  const { kept, merged, duplicateRefs } = dedupe(raw);
  summary.duplicates = duplicateRefs; summary.merged = merged.length;

  const scored = [];
  for (const o of kept) {
    const s = scoreOpportunity(o, now);
    if (s.excluded) { summary.excluded[s.excluded] = (summary.excluded[s.excluded] ?? 0) + 1; continue; }
    const row = { ...o, score: s.score, factors: s.factors, usable_in_outreach: o.type === 'permit' && !!o.party_name };
    const result = await store.upsertOpportunity(row);
    summary[result] = (summary[result] ?? 0) + 1;
    scored.push({ ...row, is_new: result === 'created' });
  }
  summary.expired = await store.expireOlderThan(new Date(new Date(now).getTime() - 45 * DAY).toISOString());

  // Only items first seen in this run are surfaced, so nothing appears in the brief twice.
  const digest = buildDigest(scored.filter((o) => o.is_new), { limit: digestLimit, threshold, now });
  summary.status = summary.errors.length === 0 ? 'ok' : (raw.length ? 'partial' : 'error');
  return { summary, digest, scored };
}

/** In-memory store with the same contract as the database layer. Used by tests and dry runs. */
export function createMemoryStore() {
  const rows = new Map();
  return {
    rows,
    async upsertOpportunity(o) {
      const prev = rows.get(o.source_ref);
      if (!prev) { rows.set(o.source_ref, { ...o, status: 'new' }); return 'created'; }
      const same = prev.score === o.score && prev.event_at === o.event_at && prev.party_name === o.party_name;
      rows.set(o.source_ref, { ...prev, ...o, status: prev.status });
      return same ? 'unchanged' : 'updated';
    },
    async expireOlderThan(iso) {
      let n = 0;
      for (const r of rows.values()) if (r.status === 'new' && (r.event_at ?? '') < iso) { r.status = 'expired'; n++; }
      return n;
    },
  };
}
