// In-memory stand-in for lib/db.js. The buyer upsert mirrors the dedupe rules
// of ab_upsert_buyer / ab_find_buyer_duplicate in migration 0008 (name key,
// email, website, phone + mailing address).
import { nameKey, parcelKey, phoneKey, hostKey, mailingKey } from '../lib/normalize.js';

let seq = 0;
const uid = () => `id-${++seq}`;
const now = () => new Date().toISOString();

export function createFakeDb(settings = {}) {
  const T = { runs: [], jobs: [], sources: {}, documents: [], properties: [], buyers: [], links: [], activity: [] };
  const db = {
    T,
    async settings() { return { counties: 'Fulton,DeKalb,Cobb,Henry,Douglas', lookback_days: '400', recheck_days: '7', give_up_days: '240', max_assessor_checks_per_run: '400', max_ai_enrich_per_run: '10', ...settings }; },
    async secret() { return null; },
    async claimInvocation() { return true; },
    async createRun(options = {}, trigger = 'manual') {
      const r = { id: uid(), trigger, status: 'queued', options, counts: {}, log: [], errors: [], created_at: now() };
      T.runs.push(r);
      T.jobs.push({ id: uid(), run_id: r.id, kind: 'run.start', payload: { run_id: r.id }, priority: 0, status: 'queued', attempts: 0, created_at: now() + seq });
      return r;
    },
    async getRun(id) { return T.runs.find(r => r.id === id) || null; },
    async updateRun(id, patch) { const r = T.runs.find(x => x.id === id); Object.assign(r, patch); return r; },
    async enqueue(runId, kind, payload, priority = 100) { const j = { id: uid(), run_id: runId, kind, payload, priority, status: 'queued', attempts: 0, created_at: now() + String(seq).padStart(6, '0') }; T.jobs.push(j); return j; },
    async claimJob() {
      const c = T.jobs.filter(j => j.status === 'queued').sort((a, b) => a.priority - b.priority || (a.created_at < b.created_at ? -1 : 1))[0];
      if (!c) return null;
      c.status = 'running'; c.attempts++; c.started_at = now();
      return c;
    },
    async completeJob(id) { const j = T.jobs.find(x => x.id === id); j.status = 'done'; return j; },
    async failJob(id, err, requeue) { const j = T.jobs.find(x => x.id === id); j.status = requeue ? 'queued' : 'failed'; j.last_error = String(err); return j; },
    async queuedJobCount(runId) { return T.jobs.filter(j => ['queued', 'running'].includes(j.status) && (!runId || j.run_id === runId)).length; },
    async resetStaleRunningJobs() { return []; },

    async sourceState(id) { return T.sources[id] || null; },
    async upsertSourceState(row) { T.sources[row.source_id] = { ...(T.sources[row.source_id] || {}), ...row }; return row; },
    async upsertDocument(doc) { const i = T.documents.findIndex(d => d.url === doc.url); if (i >= 0) T.documents[i] = { ...T.documents[i], ...doc }; else T.documents.push({ id: uid(), ...doc }); return doc; },

    async findProperty(county, key) { return T.properties.find(p => p.county === county && p.parcel_key === key) || null; },
    async insertProperty(row) { const p = { id: uid(), property_type: 'unknown', sold_confirmed: false, buyer_id: null, created_at: now(), ...row, parcel_key: parcelKey(row.parcel_id) }; T.properties.push(p); return p; },
    async updateProperty(id, patch) { const p = T.properties.find(x => x.id === id); Object.assign(p, patch, { updated_at: now() }); return p; },
    async promoteUpcoming(today) { T.properties.filter(p => p.research_status === 'upcoming' && p.sale_date && p.sale_date < today).forEach(p => { p.research_status = 'awaiting_sale_result'; }); return []; },
    async propertiesToVerify({ counties, limit, recheckBefore, lookbackDate }) {
      return T.properties.filter(p => ['awaiting_sale_result', 'buyer_research_needed'].includes(p.research_status) && (!counties || counties.includes(p.county)) && (!p.assessor_checked_at || p.assessor_checked_at < recheckBefore) && p.sale_date && p.sale_date >= lookbackDate).slice(0, limit);
    },
    async propertiesToConsolidate(limit) { return T.properties.filter(p => p.research_status === 'buyer_identified' && !p.buyer_id && p.purchaser_name).slice(0, limit); },

    async upsertBuyer(p) {
      const kn = nameKey(p.buyer_name), ke = (p.email || '').toLowerCase().trim(), kh = hostKey(p.website), kp = phoneKey(p.phone), km = mailingKey(p.mailing_address);
      if (!kn) throw new Error('buyer name is required');
      let ex = T.buyers.find(b => nameKey(b.buyer_name) === kn), on = ex ? 'buyer name' : null;
      if (!ex && ke) { ex = T.buyers.find(b => (b.email || '').toLowerCase() === ke && (!/^(info|office|contact|admin|hello)@/.test(ke) || nameKey(b.buyer_name) === kn)); if (ex) on = 'email'; }
      if (!ex && kh) { ex = T.buyers.find(b => hostKey(b.website) === kh); if (ex) on = 'website'; }
      if (!ex && kp && km) { ex = T.buyers.find(b => phoneKey(b.phone) === kp && mailingKey(b.mailing_address) === km); if (ex) on = 'phone and mailing address'; }
      if (!ex) {
        const b = { id: uid(), contact_status: 'New', counties: p.county ? [p.county] : [], source_urls: p.source_urls || [], buyer_type: p.buyer_type || 'unknown', is_institutional: !!p.is_institutional, recent_acquisitions: 0, priority: p.priority || 'Low', qualified: !!p.qualified, created_at: now(), ...p };
        b.source_urls = (p.source_urls || []).slice();
        T.buyers.push(b);
        return { action: 'inserted', id: b.id, matched_on: null };
      }
      for (const k of ['contact_name', 'phone', 'email', 'website', 'mailing_address', 'city', 'county', 'research_notes']) if (ex[k] == null && p[k] != null) ex[k] = p[k];
      if (ex.buyer_type === 'unknown' && p.buyer_type) ex.buyer_type = p.buyer_type;
      ex.is_institutional = ex.is_institutional || !!p.is_institutional;
      ex.portfolio_count = Math.max(ex.portfolio_count || 0, p.portfolio_count || 0) || null;
      if (p.evidence && !(ex.evidence || '').toLowerCase().includes(p.evidence.toLowerCase())) ex.evidence = ex.evidence ? ex.evidence + '\n\n' + p.evidence : p.evidence;
      ex.source_urls = Array.from(new Set([...(ex.source_urls || []), ...(p.source_urls || [])]));
      ex.counties = Array.from(new Set([...(ex.counties || []), ...(p.county ? [p.county] : [])]));
      return { action: 'merged', id: ex.id, matched_on: on };
    },
    async linkProperty(buyerId, propertyId, acquiredOn, evidence) {
      if (!T.links.some(l => l.buyer_id === buyerId && l.property_id === propertyId)) T.links.push({ buyer_id: buyerId, property_id: propertyId, acquired_on: acquiredOn, evidence });
      const p = T.properties.find(x => x.id === propertyId); p.buyer_id = buyerId;
      const b = T.buyers.find(x => x.id === buyerId);
      b.recent_acquisitions = T.links.filter(l => l.buyer_id === buyerId).length;
      b.counties = Array.from(new Set(T.links.filter(l => l.buyer_id === buyerId).map(l => T.properties.find(x => x.id === l.property_id).county)));
      b.county = b.county || p.county;
    },
    async getBuyer(id) { return T.buyers.find(b => b.id === id) || null; },
    async updateBuyer(id, patch) { const b = T.buyers.find(x => x.id === id); Object.assign(b, patch); return b; },
    async buyerProperties(id) { return T.links.filter(l => l.buyer_id === id).map(l => T.properties.find(p => p.id === l.property_id)); },
    async buyersToRescore(limit) { return T.buyers.filter(b => !b.qualified).slice(0, limit); },
    async addSystemActivity(buyerId, note) { T.activity.push({ buyer_id: buyerId, kind: 'system', note }); },
  };
  return db;
}
