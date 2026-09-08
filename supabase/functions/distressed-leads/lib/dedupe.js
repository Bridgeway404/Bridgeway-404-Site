// Conservative, deterministic deduplication for properties and events.
// Pure functions: the caller fetches candidate rows, these decide the match.
import { normalizeAddress, normalizeParcel, nameKey } from './normalize.js';

/**
 * Pick the existing property that matches an incoming record.
 * Preference: parcel id > exact normalized address (with unit) > address
 * without unit when neither side has a unit. Community-name matches (no
 * street address, e.g. an apartment complex named on a court calendar)
 * only match other community records with the same name key.
 */
export function findPropertyMatch(candidates, incoming) {
  const county = incoming.county;
  const parcel = normalizeParcel(incoming.parcel_id);
  const addr = incoming.address_norm || normalizeAddress(incoming.address_raw);
  const community = incoming.community_name ? nameKey(incoming.community_name) : null;
  const same = candidates.filter(c => c.county === county);
  if (parcel) {
    const m = same.find(c => c.parcel_id_norm === parcel);
    if (m) return { match: m, how: 'parcel' };
  }
  if (addr) {
    const m = same.find(c => c.address_norm === addr);
    if (m) return { match: m, how: 'address' };
    if (!/#/.test(addr)) {
      const base = same.filter(c => c.address_norm && c.address_norm.replace(/\s#.*$/, '') === addr && !/#/.test(c.address_norm));
      if (base.length === 1) return { match: base[0], how: 'address_base' };
    }
  }
  if (community && !addr) {
    const m = same.find(c => c.community_key === community || (c.address_raw && !c.address_norm && nameKey(c.address_raw) === community));
    if (m) return { match: m, how: 'community' };
  }
  return { match: null, how: null };
}

function daysApart(a, b) {
  if (!a || !b) return null;
  return Math.abs(Math.round((new Date(a + 'T00:00:00Z') - new Date(b + 'T00:00:00Z')) / 86400000));
}

/**
 * Repeated foreclosure publications (4 consecutive weeks) and postponed
 * sales map onto ONE event. A genuinely new foreclosure of the same
 * property (a later sale many months after a completed/cancelled one)
 * becomes a new event.
 */
export function matchForeclosureEvent(existingEvents, incoming) {
  const evs = existingEvents.filter(e => e.event_type === 'foreclosure');
  if (incoming.foreclosure_identifier) {
    const m = evs.find(e => e.foreclosure_identifier && e.foreclosure_identifier === incoming.foreclosure_identifier);
    if (m) return { match: m, how: 'identifier' };
  }
  const active = evs.filter(e => e.status === 'active');
  for (const e of active) {
    const gap = daysApart(e.sale_date, incoming.sale_date);
    if (e.sale_date && incoming.sale_date) {
      if (gap === 0) return { match: e, how: 'same_sale_date' };
      // postponed / re-advertised within a few months
      if (gap <= 120 && new Date(incoming.sale_date) >= new Date(e.sale_date)) return { match: e, how: 'postponed' };
    } else if (!e.sale_date || !incoming.sale_date) {
      const pubGap = daysApart(e.publication_date, incoming.publication_date);
      if (pubGap !== null && pubGap <= 60) return { match: e, how: 'publication_window' };
    }
  }
  // closed events: only re-attach if sale date identical (same notice re-seen)
  const closed = evs.filter(e => e.status !== 'active' && e.sale_date && incoming.sale_date && daysApart(e.sale_date, incoming.sale_date) === 0);
  if (closed.length) return { match: closed[0], how: 'closed_same_sale_date' };
  return { match: null, how: null };
}

/** Eviction cases dedupe on court case number; otherwise plaintiff + property within 180 days. */
export function matchEvictionEvent(existingEvents, incoming) {
  const evs = existingEvents.filter(e => e.event_type === 'eviction');
  if (incoming.case_number) {
    const key = normalizeCase(incoming.case_number);
    const m = evs.find(e => e.case_number && normalizeCase(e.case_number) === key);
    if (m) return { match: m, how: 'case_number' };
  }
  if (incoming.plaintiff_name) {
    const pk = nameKey(incoming.plaintiff_name);
    const m = evs.find(e => e.status === 'active' && e.plaintiff_name && nameKey(e.plaintiff_name) === pk &&
      (daysApart(e.filed_date || e.hearing_date, incoming.filed_date || incoming.hearing_date) ?? 0) <= 180);
    if (m) return { match: m, how: 'plaintiff_window' };
  }
  return { match: null, how: null };
}

export function normalizeCase(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Merge non-destructively: never overwrite a filled field with blank. */
export function mergeFields(existing, incoming, fields) {
  const out = {};
  for (const f of fields) {
    const v = incoming[f];
    if (v !== undefined && v !== null && String(v).trim() !== '') {
      if (existing[f] == null || String(existing[f]).trim() === '') out[f] = v;
    }
  }
  return out;
}
