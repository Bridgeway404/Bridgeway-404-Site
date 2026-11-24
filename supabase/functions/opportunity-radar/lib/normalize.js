// Normalisation helpers shared by every Radar source.

const SUFFIX = /\b(street|st|avenue|ave|road|rd|drive|dr|boulevard|blvd|lane|ln|court|ct|place|pl|parkway|pkwy|highway|hwy|circle|cir|terrace|ter|way|trail|trl)\b\.?/g;
const SUFFIX_MAP = { street: 'st', avenue: 'ave', road: 'rd', drive: 'dr', boulevard: 'blvd', lane: 'ln', court: 'ct', place: 'pl', parkway: 'pkwy', highway: 'hwy', circle: 'cir', terrace: 'ter', trail: 'trl' };
const DIR = { north: 'n', south: 's', east: 'e', west: 'w', northeast: 'ne', northwest: 'nw', southeast: 'se', southwest: 'sw' };

export function addressKey(addr) {
  if (!addr) return null;
  let s = String(addr).toLowerCase().replace(/\b([ns])\.\s?([ew])\.?/g, '$1$2').replace(/[.,#]/g, ' ').replace(/\b(apt|unit|ste|suite|bldg|building)\b\s*[\w-]*/g, ' ');
  s = s.replace(/\b(north|south|east|west|northeast|northwest|southeast|southwest)\b/g, (m) => DIR[m]);
  s = s.replace(SUFFIX, (m) => SUFFIX_MAP[m.replace('.', '')] ?? m.replace('.', ''));
  s = s.replace(/\b(atlanta|decatur|ga|georgia)\b.*$/, ' ').replace(/\b\d{5}(-\d{4})?\b/g, ' ');
  s = s.replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  return /^\d+ \w+/.test(s) ? s : null;
}

export function nameKey(name) {
  if (!name) return null;
  const s = String(name).toLowerCase().replace(/&/g, ' and ')
    .replace(/\b(llc|l\.l\.c|inc|incorporated|co|corp|corporation|company|ltd|lp|llp|the)\b\.?/g, ' ')
    .replace(/[^a-z0-9]/g, '');
  return s || null;
}

/** ArcGIS returns dates as epoch milliseconds; other sources as strings. */
export function toIso(v) {
  if (v == null || v === '') return null;
  const d = typeof v === 'number' ? new Date(v) : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function toCents(v) {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

/** First attribute present from a list of candidate field names (case-insensitive). */
export function pick(attrs, candidates) {
  if (!attrs) return null;
  const lower = new Map(Object.keys(attrs).map((k) => [k.toLowerCase(), k]));
  for (const c of candidates) {
    const k = lower.get(c.toLowerCase());
    if (k != null && attrs[k] != null && String(attrs[k]).trim() !== '') return attrs[k];
  }
  return null;
}

export const TERRITORY = { core: ['fulton', 'dekalb'], inner: ['cobb', 'gwinnett', 'clayton'] };
export function territoryTier(county) {
  const c = String(county ?? '').toLowerCase().replace(/ county$/, '').trim();
  if (TERRITORY.core.includes(c)) return 'core';
  if (TERRITORY.inner.includes(c)) return 'inner';
  return 'outside';
}
