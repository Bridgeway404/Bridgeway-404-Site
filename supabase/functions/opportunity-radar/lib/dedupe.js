// Two layers of duplicate prevention:
//   1. Same source, same reference -> the same opportunity (update, never insert twice).
//   2. Different sources (or an applied- and issued-permit layer) describing the same
//      work at the same address within a window -> merged into the earlier record.

import { addressKey, nameKey } from './normalize.js';

const DAY = 86400000;

export function clusterKey(o) {
  const a = addressKey(o.location);
  return a ? `${o.type}|${a}` : null;
}

export function dedupe(items, { windowDays = 60 } = {}) {
  const byRef = new Map();
  for (const o of items) {
    const prev = byRef.get(o.source_ref);
    if (!prev || (o.event_at ?? '') > (prev.event_at ?? '')) byRef.set(o.source_ref, o);
  }
  const kept = [];
  const merged = [];
  const clusters = new Map();
  const sorted = [...byRef.values()].sort((a, b) => (a.event_at ?? '').localeCompare(b.event_at ?? ''));
  for (const o of sorted) {
    const key = clusterKey(o);
    const prior = key ? clusters.get(key) : null;
    const close = prior && o.event_at && prior.event_at
      && Math.abs(new Date(o.event_at) - new Date(prior.event_at)) <= windowDays * DAY;
    const sameParty = prior && (!o.party_name || !prior.party_name || nameKey(o.party_name) === nameKey(prior.party_name));
    if (prior && close && sameParty) {
      // Keep the earlier record's identity; fill gaps and take the fresher date and larger value.
      prior.also_seen_as = [...(prior.also_seen_as ?? []), o.source_ref];
      prior.party_name ??= o.party_name;
      prior.value_cents = Math.max(prior.value_cents ?? 0, o.value_cents ?? 0) || prior.value_cents;
      if ((o.event_at ?? '') > (prior.event_at ?? '')) prior.event_at = o.event_at;
      merged.push({ dropped: o.source_ref, into: prior.source_ref });
      continue;
    }
    const copy = { ...o };
    kept.push(copy);
    if (key) clusters.set(key, copy);
  }
  return { kept, merged, duplicateRefs: items.length - byRef.size };
}
