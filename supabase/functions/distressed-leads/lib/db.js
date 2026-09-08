// Data access for the worker. Wraps a supabase-js client (service role) so
// the pipeline never builds queries inline; tests inject a fake with the
// same method names.
import { nameKey } from './normalize.js';

function ok(res, what) {
  if (res.error) throw new Error(`${what}: ${res.error.message || JSON.stringify(res.error)}`);
  return res.data;
}

export function createDb(client) {
  const t = (name) => client.from(name);
  return {
    async settings() {
      const rows = ok(await t('dpl_settings').select('key,value'), 'settings');
      return Object.fromEntries(rows.map(r => [r.key, r.value]));
    },
    async secret(name) {
      const res = await client.rpc('dpl_get_secret', { p_name: name });
      if (res.error) return null;
      return res.data || null;
    },
    async claimInvocation(token) {
      const res = await client.rpc('dpl_claim_invocation', { p_token: token });
      if (res.error) throw new Error('claim: ' + res.error.message);
      return res.data === true;
    },

    // ---- runs
    async getRun(id) { return ok(await t('dpl_runs').select('*').eq('id', id).maybeSingle(), 'run'); },
    async updateRun(id, patch) { return ok(await t('dpl_runs').update(patch).eq('id', id).select('*').single(), 'run.update'); },
    async runningRun() { return ok(await t('dpl_runs').select('*').in('status', ['queued', 'running']).order('created_at', { ascending: false }).limit(1).maybeSingle(), 'run.running'); },
    async upsertRunSource(runId, sourceId, patch) {
      return ok(await t('dpl_run_sources').upsert({ run_id: runId, source_id: sourceId, ...patch }, { onConflict: 'run_id,source_id' }).select('*').single(), 'run_source');
    },
    async runSources(runId) { return ok(await t('dpl_run_sources').select('*').eq('run_id', runId), 'run_sources'); },

    // ---- source state
    async sourceStates() { return ok(await t('dpl_source_state').select('*'), 'source_state'); },
    async upsertSourceState(row) { return ok(await t('dpl_source_state').upsert(row, { onConflict: 'source_id' }).select('*').single(), 'source_state.upsert'); },
    async seenExternalIds(sourceId) {
      const rows = ok(await t('dpl_source_items').select('external_id').eq('source_id', sourceId).order('last_seen_at', { ascending: false }).limit(5000), 'seen');
      return new Set(rows.map(r => r.external_id));
    },
    async getSourceItem(sourceId, externalId) { return ok(await t('dpl_source_items').select('*').eq('source_id', sourceId).eq('external_id', externalId).maybeSingle(), 'source_item'); },
    async upsertSourceItem(row) { return ok(await t('dpl_source_items').upsert(row, { onConflict: 'source_id,external_id' }).select('*').single(), 'source_item.upsert'); },

    // ---- properties
    async propertyCandidates(county, { parcelNorm, addressNorm, communityKey } = {}) {
      const out = [];
      if (parcelNorm) out.push(...ok(await t('dpl_properties').select('*').eq('county', county).eq('parcel_id_norm', parcelNorm), 'cand.parcel'));
      if (addressNorm) {
        const base = addressNorm.replace(/\s#.*$/, '');
        out.push(...ok(await t('dpl_properties').select('*').eq('county', county).like('address_norm', base + '%'), 'cand.addr'));
      }
      if (communityKey) out.push(...ok(await t('dpl_properties').select('*').eq('county', county).eq('legal_description', 'community:' + communityKey), 'cand.community'));
      const seen = new Set();
      return out.filter(p => !seen.has(p.id) && seen.add(p.id)).map(p => ({ ...p, community_key: p.legal_description && p.legal_description.startsWith('community:') ? p.legal_description.slice(10) : null }));
    },
    async insertProperty(row) { return ok(await t('dpl_properties').insert(row).select('*').single(), 'property.insert'); },
    async updateProperty(id, patch) { return ok(await t('dpl_properties').update(patch).eq('id', id).select('*').single(), 'property.update'); },
    async getProperty(id) { return ok(await t('dpl_properties').select('*').eq('id', id).maybeSingle(), 'property'); },
    async propertiesForCompany(companyId) {
      return ok(await t('dpl_properties').select('*').or(`target_company_id.eq.${companyId},owner_company_id.eq.${companyId},manager_company_id.eq.${companyId},investor_company_id.eq.${companyId}`), 'props.company');
    },
    async activePropertyCountForCompany(companyId) {
      const res = await t('dpl_properties').select('id', { count: 'exact', head: true })
        .or(`target_company_id.eq.${companyId},owner_company_id.eq.${companyId},manager_company_id.eq.${companyId}`)
        .not('workflow_status', 'in', '("Closed","Not a Fit")');
      if (res.error) throw new Error('count: ' + res.error.message);
      return res.count || 0;
    },

    // ---- events
    async eventsForProperty(propertyId) { return ok(await t('dpl_events').select('*').eq('property_id', propertyId).order('last_detected_at', { ascending: false }), 'events'); },
    async eventByCase(county, caseNumber) { return ok(await t('dpl_events').select('*').eq('county', county).eq('event_type', 'eviction').eq('case_number', caseNumber).maybeSingle(), 'event.case'); },
    async insertEvent(row) { return ok(await t('dpl_events').insert(row).select('*').single(), 'event.insert'); },
    async updateEvent(id, patch) { return ok(await t('dpl_events').update(patch).eq('id', id).select('*').single(), 'event.update'); },
    async insertHistory(row) { return ok(await t('dpl_event_history').insert(row).select('id').single(), 'history'); },

    // ---- companies & contacts
    async companyByName(name) { return ok(await t('dpl_companies').select('*').eq('name_key', nameKey(name)).maybeSingle(), 'company.byname'); },
    async getCompany(id) { return ok(await t('dpl_companies').select('*').eq('id', id).maybeSingle(), 'company'); },
    async insertCompany(row) {
      const res = await t('dpl_companies').insert(row).select('*').single();
      if (res.error && /duplicate|unique/i.test(res.error.message)) return this.companyByName(row.name);
      return ok(res, 'company.insert');
    },
    async updateCompany(id, patch) { return ok(await t('dpl_companies').update(patch).eq('id', id).select('*').single(), 'company.update'); },
    async companiesNeedingResearch(limit) {
      return ok(await t('dpl_companies').select('*').in('research_status', ['unresearched', 'queued', 'stale']).eq('is_individual', false).order('updated_at', { ascending: true }).limit(limit), 'companies.needing');
    },
    async contacts(companyId) { return ok(await t('dpl_contacts').select('*').eq('company_id', companyId), 'contacts'); },
    async replaceAutoContacts(companyId, rows) {
      ok(await t('dpl_contacts').delete().eq('company_id', companyId).is('verified_at', null), 'contacts.delete');
      if (!rows.length) return [];
      return ok(await t('dpl_contacts').insert(rows.map(r => ({ ...r, company_id: companyId }))).select('*'), 'contacts.insert');
    },
    async upsertRelationship(row) { return ok(await t('dpl_property_companies').upsert(row, { onConflict: 'property_id,company_id,relationship' }).select('*').single(), 'rel.upsert'); },
    async relationshipsForProperty(propertyId) { return ok(await t('dpl_property_companies').select('*, company:dpl_companies(*)').eq('property_id', propertyId), 'rels'); },
    async relationshipsForCompany(companyId) { return ok(await t('dpl_property_companies').select('*').eq('company_id', companyId), 'rels.company'); },
    async insertEvidence(rows) { if (!rows.length) return []; return ok(await t('dpl_evidence').insert(rows).select('id'), 'evidence'); },
    async evidenceFor(subjectType, subjectId) { return ok(await t('dpl_evidence').select('*').eq('subject_type', subjectType).eq('subject_id', subjectId).order('captured_at', { ascending: false }).limit(50), 'evidence.for'); },

    // ---- jobs
    async enqueue(runId, kind, payload, priority = 100) {
      return ok(await t('dpl_jobs').insert({ run_id: runId, kind, payload, priority }).select('id').single(), 'job.enqueue');
    },
    async claimJob() {
      const cand = ok(await t('dpl_jobs').select('*').eq('status', 'queued').order('priority', { ascending: true }).order('created_at', { ascending: true }).limit(1).maybeSingle(), 'job.next');
      if (!cand) return null;
      const res = await t('dpl_jobs').update({ status: 'running', started_at: new Date().toISOString(), attempts: (cand.attempts || 0) + 1 }).eq('id', cand.id).eq('status', 'queued').select('*').maybeSingle();
      if (res.error) throw new Error('job.claim: ' + res.error.message);
      return res.data || null; // null = someone else claimed it
    },
    async completeJob(id, patch = {}) { return ok(await t('dpl_jobs').update({ status: 'done', finished_at: new Date().toISOString(), ...patch }).eq('id', id).select('id').single(), 'job.done'); },
    async failJob(id, error, requeue = false) {
      return ok(await t('dpl_jobs').update({ status: requeue ? 'queued' : 'failed', last_error: String(error).slice(0, 1000), finished_at: requeue ? null : new Date().toISOString() }).eq('id', id).select('id').single(), 'job.fail');
    },
    async queuedJobCount(runId) {
      let q = t('dpl_jobs').select('id', { count: 'exact', head: true }).in('status', ['queued', 'running']);
      if (runId) q = q.eq('run_id', runId);
      const res = await q;
      if (res.error) throw new Error('jobs.count: ' + res.error.message);
      return res.count || 0;
    },
    async jobsForRun(runId) { return ok(await t('dpl_jobs').select('kind,status,payload,last_error').eq('run_id', runId), 'jobs.run'); },
    async resetStaleRunningJobs(minutes = 20) {
      const cutoff = new Date(Date.now() - minutes * 60000).toISOString();
      return ok(await t('dpl_jobs').update({ status: 'queued' }).eq('status', 'running').lt('started_at', cutoff).select('id'), 'jobs.reset');
    },

    // ---- uploads
    async getUpload(id) { return ok(await t('dpl_uploads').select('*').eq('id', id).maybeSingle(), 'upload'); },
    async updateUpload(id, patch) { return ok(await t('dpl_uploads').update(patch).eq('id', id).select('id').single(), 'upload.update'); },
  };
}
