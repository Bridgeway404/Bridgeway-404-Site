// In-memory stand-in for lib/db.js used by the pipeline tests.
import { nameKey } from '../lib/normalize.js';

let seq = 0;
const uid = () => `id-${++seq}`;

export function createFakeDb(settings = {}) {
  const T = { runs: [], run_sources: [], source_state: [], source_items: [], properties: [], events: [], history: [], companies: [], contacts: [], rels: [], evidence: [], jobs: [], uploads: [] };
  const now = () => new Date().toISOString();
  const db = {
    T,
    async settings() { return { lookback_days: '14', max_company_research_per_run: '20', company_refresh_days: '90', ...settings }; },
    async secret() { return null; },
    async claimInvocation() { return true; },
    async getRun(id) { return T.runs.find(r => r.id === id) || null; },
    async updateRun(id, patch) { const r = T.runs.find(x => x.id === id); Object.assign(r, patch); return r; },
    async createRun(trigger = 'manual') { const r = { id: uid(), trigger, status: 'queued', counts: {}, errors: [], created_at: now() }; T.runs.push(r); T.jobs.push({ id: uid(), run_id: r.id, kind: 'run.start', payload: { run_id: r.id }, priority: 0, status: 'queued', attempts: 0, created_at: now() }); return r; },
    async runningRun() { return T.runs.find(r => ['queued', 'running'].includes(r.status)) || null; },
    async upsertRunSource(runId, sourceId, patch) { let r = T.run_sources.find(x => x.run_id === runId && x.source_id === sourceId); if (!r) { r = { id: uid(), run_id: runId, source_id: sourceId, items_seen: 0, items_new: 0, items_updated: 0, detail: {} }; T.run_sources.push(r); } Object.assign(r, patch); return r; },
    async runSources(runId) { return T.run_sources.filter(x => x.run_id === runId); },
    async sourceStates() { return T.source_state; },
    async upsertSourceState(row) { let r = T.source_state.find(x => x.source_id === row.source_id); if (!r) { r = { enabled: true, consecutive_failures: 0, cursor: {} }; T.source_state.push(r); } Object.assign(r, row); return r; },
    async seenExternalIds(sourceId) { return new Set(T.source_items.filter(i => i.source_id === sourceId).map(i => i.external_id)); },
    async getSourceItem(s, e) { return T.source_items.find(i => i.source_id === s && i.external_id === e) || null; },
    async upsertSourceItem(row) { let r = T.source_items.find(i => i.source_id === row.source_id && i.external_id === row.external_id); if (!r) { r = { id: uid() }; T.source_items.push(r); } Object.assign(r, row); return r; },
    async propertyCandidates(county, { parcelNorm, addressNorm, communityKey }) {
      return T.properties.filter(p => p.county === county && ((parcelNorm && p.parcel_id_norm === parcelNorm) || (addressNorm && p.address_norm && p.address_norm.startsWith(addressNorm.replace(/\s#.*$/, ''))) || (communityKey && p.legal_description === 'community:' + communityKey)))
        .map(p => ({ ...p, community_key: p.legal_description && p.legal_description.startsWith('community:') ? p.legal_description.slice(10) : null }));
    },
    async insertProperty(row) { const p = { id: uid(), opportunity_score: 0, workflow_status: 'New', enrichment_status: 'pending', property_type: 'unknown', ...row }; T.properties.push(p); return p; },
    async updateProperty(id, patch) { const p = T.properties.find(x => x.id === id); Object.assign(p, patch); return p; },
    async getProperty(id) { return T.properties.find(x => x.id === id) || null; },
    async propertiesForCompany(cid) { return T.properties.filter(p => [p.target_company_id, p.owner_company_id, p.manager_company_id, p.investor_company_id].includes(cid)); },
    async activePropertyCountForCompany(cid) { return T.properties.filter(p => [p.target_company_id, p.owner_company_id, p.manager_company_id].includes(cid) && !['Closed', 'Not a Fit'].includes(p.workflow_status)).length; },
    async eventsForProperty(pid) { return T.events.filter(e => e.property_id === pid).sort((a, b) => (a.last_detected_at < b.last_detected_at ? 1 : -1)); },
    async eventByCase(county, c) { return T.events.find(e => e.county === county && e.event_type === 'eviction' && e.case_number === c) || null; },
    async insertEvent(row) { const e = { id: uid(), publication_count: 1, details: {}, ...row }; T.events.push(e); return e; },
    async updateEvent(id, patch) { const e = T.events.find(x => x.id === id); Object.assign(e, patch); return e; },
    async insertHistory(row) { const h = { id: uid(), changed_at: now(), ...row }; T.history.push(h); return h; },
    async companyByName(name) { return T.companies.find(c => c.name_key === nameKey(name)) || null; },
    async getCompany(id) { return T.companies.find(c => c.id === id) || null; },
    async insertCompany(row) { const ex = await db.companyByName(row.name); if (ex) return ex; const c = { id: uid(), name_key: nameKey(row.name), company_type: 'unknown', research_status: 'unresearched', is_individual: false, do_not_contact: false, sources: [], ...row }; T.companies.push(c); return c; },
    async updateCompany(id, patch) { const c = T.companies.find(x => x.id === id); Object.assign(c, patch); return c; },
    async companiesNeedingResearch(limit) { return T.companies.filter(c => ['unresearched', 'queued', 'stale'].includes(c.research_status) && !c.is_individual).slice(0, limit); },
    async contacts(cid) { return T.contacts.filter(c => c.company_id === cid); },
    async replaceAutoContacts(cid, rows) { T.contacts = T.contacts.filter(c => c.company_id !== cid || c.verified_at); const out = rows.map(r => ({ id: uid(), company_id: cid, ...r })); T.contacts.push(...out); return out; },
    async upsertRelationship(row) { let r = T.rels.find(x => x.property_id === row.property_id && x.company_id === row.company_id && x.relationship === row.relationship); if (!r) { r = { id: uid() }; T.rels.push(r); } Object.assign(r, row); return r; },
    async relationshipsForProperty(pid) { return T.rels.filter(r => r.property_id === pid).map(r => ({ ...r, company: T.companies.find(c => c.id === r.company_id) })); },
    async relationshipsForCompany(cid) { return T.rels.filter(r => r.company_id === cid); },
    async insertEvidence(rows) { const out = rows.map(r => ({ id: uid(), captured_at: now(), ...r })); T.evidence.push(...out); return out; },
    async evidenceFor(t, id) { return T.evidence.filter(e => e.subject_type === t && e.subject_id === id); },
    async enqueue(runId, kind, payload, priority = 100) { const j = { id: uid(), run_id: runId, kind, payload, priority, status: 'queued', attempts: 0, created_at: now() + seq }; T.jobs.push(j); return j; },
    async claimJob() { const j = T.jobs.filter(x => x.status === 'queued').sort((a, b) => a.priority - b.priority || (a.created_at < b.created_at ? -1 : 1))[0]; if (!j) return null; j.status = 'running'; j.attempts++; j.started_at = now(); return j; },
    async completeJob(id) { const j = T.jobs.find(x => x.id === id); j.status = 'done'; return j; },
    async failJob(id, err, requeue) { const j = T.jobs.find(x => x.id === id); j.status = requeue ? 'queued' : 'failed'; j.last_error = String(err); return j; },
    async queuedJobCount(runId) { return T.jobs.filter(j => ['queued', 'running'].includes(j.status) && (!runId || j.run_id === runId)).length; },
    async jobsForRun(runId) { return T.jobs.filter(j => j.run_id === runId); },
    async resetStaleRunningJobs() { return []; },
    async getUpload(id) { return T.uploads.find(u => u.id === id) || null; },
    async updateUpload(id, patch) { const u = T.uploads.find(x => x.id === id); Object.assign(u, patch); return u; },
  };
  return db;
}
