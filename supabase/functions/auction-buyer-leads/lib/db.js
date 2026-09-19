// Data access for the worker (service-role supabase-js). Tests inject an
// in-memory fake with the same method names (test/fakedb.js).
function ok(res, what) {
  if (res.error) throw new Error(`${what}: ${res.error.message || JSON.stringify(res.error)}`);
  return res.data;
}

export function createDb(client) {
  const t = (name) => client.from(name);
  return {
    async settings() {
      const rows = ok(await t('ab_settings').select('key,value'), 'settings');
      return Object.fromEntries(rows.map(r => [r.key, r.value]));
    },
    async secret(name) {
      const res = await client.rpc('dpl_get_secret', { p_name: name });
      return res.error ? null : (res.data || null);
    },
    async claimInvocation(token) {
      const res = await client.rpc('dpl_claim_invocation', { p_token: token });
      if (res.error) throw new Error('claim: ' + res.error.message);
      return res.data === true;
    },

    // ---- runs & jobs
    async getRun(id) { return ok(await t('ab_runs').select('*').eq('id', id).maybeSingle(), 'run'); },
    async updateRun(id, patch) { return ok(await t('ab_runs').update(patch).eq('id', id).select('*').single(), 'run.update'); },
    async enqueue(runId, kind, payload, priority = 100) { return ok(await t('ab_jobs').insert({ run_id: runId, kind, payload, priority }).select('id').single(), 'job.enqueue'); },
    async claimJob() {
      const cand = ok(await t('ab_jobs').select('*').eq('status', 'queued').order('priority', { ascending: true }).order('created_at', { ascending: true }).limit(1).maybeSingle(), 'job.next');
      if (!cand) return null;
      const res = await t('ab_jobs').update({ status: 'running', started_at: new Date().toISOString(), attempts: (cand.attempts || 0) + 1 }).eq('id', cand.id).eq('status', 'queued').select('*').maybeSingle();
      if (res.error) throw new Error('job.claim: ' + res.error.message);
      return res.data || null;
    },
    async completeJob(id) { return ok(await t('ab_jobs').update({ status: 'done', finished_at: new Date().toISOString() }).eq('id', id).select('id').single(), 'job.done'); },
    async failJob(id, error, requeue = false) {
      return ok(await t('ab_jobs').update({ status: requeue ? 'queued' : 'failed', last_error: String(error).slice(0, 1000), finished_at: requeue ? null : new Date().toISOString() }).eq('id', id).select('id').single(), 'job.fail');
    },
    async queuedJobCount(runId) {
      let q = t('ab_jobs').select('id', { count: 'exact', head: true }).in('status', ['queued', 'running']);
      if (runId) q = q.eq('run_id', runId);
      const res = await q;
      if (res.error) throw new Error('jobs.count: ' + res.error.message);
      return res.count || 0;
    },
    async resetStaleRunningJobs(minutes = 15) {
      const cutoff = new Date(Date.now() - minutes * 60000).toISOString();
      return ok(await t('ab_jobs').update({ status: 'queued' }).eq('status', 'running').lt('started_at', cutoff).select('id'), 'jobs.reset');
    },

    // ---- sources & documents
    async sourceState(id) { return ok(await t('ab_source_state').select('*').eq('source_id', id).maybeSingle(), 'source.state'); },
    async upsertSourceState(row) { return ok(await t('ab_source_state').upsert(row, { onConflict: 'source_id' }).select('source_id').single(), 'source.upsert'); },
    async upsertDocument(doc) {
      const row = { source_id: doc.source_id, county: doc.county || null, url: doc.url, kind: doc.kind || 'sale_list', label: doc.label || null, sha256: doc.sha256 || null,
        fetched_at: doc.fetched_at || new Date().toISOString(), status_code: doc.status_code || null, text: doc.text || null, parsed_count: doc.parsed_count || 0, notes: doc.notes || null };
      return ok(await t('ab_documents').upsert(row, { onConflict: 'url' }).select('id').single(), 'document.upsert');
    },

    // ---- properties (research queue)
    async findProperty(county, parcelKeyValue) { return ok(await t('ab_properties').select('*').eq('county', county).eq('parcel_key', parcelKeyValue).maybeSingle(), 'property.find'); },
    async insertProperty(row) { return ok(await t('ab_properties').insert(row).select('*').single(), 'property.insert'); },
    async updateProperty(id, patch) { return ok(await t('ab_properties').update(patch).eq('id', id).select('id').single(), 'property.update'); },
    async promoteUpcoming(todayIso) { return ok(await t('ab_properties').update({ research_status: 'awaiting_sale_result', status_reason: 'advertised sale date has passed; waiting for a result' }).eq('research_status', 'upcoming').lt('sale_date', todayIso).select('id'), 'property.promote'); },
    async propertiesToVerify({ counties, limit, recheckBefore, lookbackDate }) {
      let q = t('ab_properties').select('*').in('research_status', ['awaiting_sale_result', 'buyer_research_needed']).or(`assessor_checked_at.is.null,assessor_checked_at.lt.${recheckBefore}`).gte('sale_date', lookbackDate);
      if (counties && counties.length) q = q.in('county', counties);
      return ok(await q.order('sale_date', { ascending: false }).order('created_at', { ascending: true }).limit(limit), 'property.verify_list') || [];
    },
    async propertiesToConsolidate(limit) {
      return ok(await t('ab_properties').select('*').eq('research_status', 'buyer_identified').is('buyer_id', null).not('purchaser_name', 'is', null).order('sale_date', { ascending: false }).limit(limit), 'property.consolidate_list') || [];
    },

    // ---- buyers (call list)
    async upsertBuyer(p) { return ok(await client.rpc('ab_upsert_buyer', { p }), 'buyer.upsert'); },
    async linkProperty(buyerId, propertyId, acquiredOn, evidence) { return ok(await client.rpc('ab_link_property', { p_buyer: buyerId, p_property: propertyId, p_acquired: acquiredOn, p_evidence: evidence }), 'buyer.link'); },
    async getBuyer(id) { return ok(await t('ab_buyers').select('*').eq('id', id).maybeSingle(), 'buyer'); },
    async updateBuyer(id, patch) { return ok(await t('ab_buyers').update(patch).eq('id', id).select('id').single(), 'buyer.update'); },
    async buyerProperties(buyerId) {
      const links = ok(await t('ab_buyer_properties').select('property_id,acquired_on').eq('buyer_id', buyerId), 'buyer.props') || [];
      if (!links.length) return [];
      return ok(await t('ab_properties').select('*').in('id', links.map(l => l.property_id)), 'buyer.props.rows') || [];
    },
    async buyersToRescore(limit) { return ok(await t('ab_buyers').select('id').eq('qualified', false).order('updated_at', { ascending: false }).limit(limit), 'buyer.rescore_list') || []; },
    async addSystemActivity(buyerId, note) { return ok(await t('ab_activity').insert({ buyer_id: buyerId, kind: 'system', note }).select('id').single(), 'activity.insert'); },
  };
}
