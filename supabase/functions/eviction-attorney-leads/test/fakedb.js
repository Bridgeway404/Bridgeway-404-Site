// In-memory stand-in for lib/db.js. The upsert mirrors the dedupe rules of
// eal_upsert_lead / eal_find_duplicate in migration 0007 closely enough for
// the pipeline tests (name, email, phone+firm, firm-only).
import { nameKey, firmKey, phoneKey, hostKey } from '../lib/normalize.js';

let seq = 0;
const uid = () => `id-${++seq}`;
const now = () => new Date().toISOString();

export function createFakeDb(settings = {}, opts = {}) {
  const T = { runs: [], jobs: [], leads: [], courtRows: opts.courtRows || [] };
  const db = {
    T,
    async settings() { return { counties: 'Fulton,DeKalb,Gwinnett,Cobb,Clayton,Douglas,Henry', web_passes_per_run: '2', max_new_leads_per_run: '30', max_enrich_per_run: '15', min_court_filings: '2', ...settings }; },
    async secret() { return null; },
    async claimInvocation() { return true; },
    async createRun(options = {}) {
      const r = { id: uid(), trigger: 'manual', status: 'queued', options, counts: {}, log: [], errors: [], created_at: now() };
      T.runs.push(r);
      T.jobs.push({ id: uid(), run_id: r.id, kind: 'run.start', payload: { run_id: r.id }, priority: 0, status: 'queued', attempts: 0, created_at: now() });
      return r;
    },
    async getRun(id) { return T.runs.find(r => r.id === id) || null; },
    async updateRun(id, patch) { const r = T.runs.find(x => x.id === id); Object.assign(r, patch); return r; },
    async enqueue(runId, kind, payload, priority = 100) { const j = { id: uid(), run_id: runId, kind, payload, priority, status: 'queued', attempts: 0, created_at: now() + seq }; T.jobs.push(j); return j; },
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
    async courtStats() { return T.courtRows; },
    async getLead(id) { return T.leads.find(l => l.id === id) || null; },
    async updateLead(id, patch) { const l = T.leads.find(x => x.id === id); Object.assign(l, patch); return l; },
    async knownLeads() { return T.leads.map(l => ({ attorney_name: l.attorney_name, firm_name: l.firm_name })); },
    async upsertLead(p) {
      if (!p.attorney_name && !p.firm_name) throw new Error('attorney name or law firm is required');
      const kn = nameKey(p.attorney_name), kf = firmKey(p.firm_name), kp = phoneKey(p.phone), ke = (p.email || '').toLowerCase(), kh = hostKey(p.website);
      let ex = null, on = null;
      if (kn) { ex = T.leads.find(l => nameKey(l.attorney_name) === kn); if (ex) on = 'attorney name'; }
      if (!ex && ke) { ex = T.leads.find(l => (l.email || '').toLowerCase() === ke && (!/^(info|office|contact|admin|intake)@/.test(ke) || !kn || !nameKey(l.attorney_name))); if (ex) on = 'email'; }
      if (!ex && kp) { ex = T.leads.find(l => phoneKey(l.phone) === kp && (!kn || !nameKey(l.attorney_name))); if (ex) on = 'phone number'; }
      if (!ex && kh && kf) { ex = T.leads.find(l => hostKey(l.website) === kh && firmKey(l.firm_name) === kf && (!kn || !nameKey(l.attorney_name))); if (ex) on = 'website'; }
      if (!ex && kf && !kn) { ex = T.leads.find(l => firmKey(l.firm_name) === kf && !nameKey(l.attorney_name)); if (ex) on = 'law firm'; }
      if (!ex) {
        const l = { id: uid(), contact_status: 'New', counties: [], source_urls: [], filing_count: 0, plaintiff_count: 0, enrichment_status: 'skipped', created_at: now(), ...p };
        if (l.enrichment_status === undefined) l.enrichment_status = 'skipped';
        T.leads.push(l);
        return { action: 'inserted', id: l.id, matched_on: null };
      }
      for (const k of ['attorney_name', 'firm_name', 'phone', 'email', 'website', 'city', 'county', 'practice_area', 'source_url', 'research_notes', 'confidence', 'referral_potential']) if (ex[k] == null && p[k] != null) ex[k] = p[k];
      ex.counties = Array.from(new Set([...(ex.counties || []), ...(p.counties || []), ...(p.county ? [p.county] : [])]));
      ex.source_urls = Array.from(new Set([...(ex.source_urls || []), ...(p.source_urls || []), ...(p.source_url ? [p.source_url] : [])]));
      if (p.evidence && !(ex.evidence || '').toLowerCase().includes(p.evidence.toLowerCase())) ex.evidence = ex.evidence ? ex.evidence + '\n\n' + p.evidence : p.evidence;
      if (p.clients_identified && !(ex.clients_identified || '').toLowerCase().includes(p.clients_identified.toLowerCase())) ex.clients_identified = ex.clients_identified ? ex.clients_identified + '; ' + p.clients_identified : p.clients_identified;
      ex.filing_count = Math.max(ex.filing_count || 0, p.filing_count || 0);
      if (p.enrichment_status) ex.enrichment_status = p.enrichment_status;
      if (p.source_kind === 'court_records') ex.source_kind = 'court_records';
      return { action: 'merged', id: ex.id, matched_on: on };
    },
  };
  return db;
}
