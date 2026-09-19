// Data access for the worker. Wraps a supabase-js client (service role) so
// the pipeline never builds queries inline; tests inject a fake with the
// same method names.

function ok(res, what) {
  if (res.error) throw new Error(`${what}: ${res.error.message || JSON.stringify(res.error)}`);
  return res.data;
}

export function createDb(client) {
  const t = (name) => client.from(name);
  return {
    async settings() {
      const rows = ok(await t('eal_settings').select('key,value'), 'settings');
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
    async getRun(id) { return ok(await t('eal_runs').select('*').eq('id', id).maybeSingle(), 'run'); },
    async updateRun(id, patch) { return ok(await t('eal_runs').update(patch).eq('id', id).select('*').single(), 'run.update'); },

    // ---- jobs
    async enqueue(runId, kind, payload, priority = 100) {
      return ok(await t('eal_jobs').insert({ run_id: runId, kind, payload, priority }).select('id').single(), 'job.enqueue');
    },
    async claimJob() {
      const cand = ok(await t('eal_jobs').select('*').eq('status', 'queued').order('priority', { ascending: true }).order('created_at', { ascending: true }).limit(1).maybeSingle(), 'job.next');
      if (!cand) return null;
      const res = await t('eal_jobs').update({ status: 'running', started_at: new Date().toISOString(), attempts: (cand.attempts || 0) + 1 }).eq('id', cand.id).eq('status', 'queued').select('*').maybeSingle();
      if (res.error) throw new Error('job.claim: ' + res.error.message);
      return res.data || null;
    },
    async completeJob(id) { return ok(await t('eal_jobs').update({ status: 'done', finished_at: new Date().toISOString() }).eq('id', id).select('id').single(), 'job.done'); },
    async failJob(id, error, requeue = false) {
      return ok(await t('eal_jobs').update({ status: requeue ? 'queued' : 'failed', last_error: String(error).slice(0, 1000), finished_at: requeue ? null : new Date().toISOString() }).eq('id', id).select('id').single(), 'job.fail');
    },
    async queuedJobCount(runId) {
      let q = t('eal_jobs').select('id', { count: 'exact', head: true }).in('status', ['queued', 'running']);
      if (runId) q = q.eq('run_id', runId);
      const res = await q;
      if (res.error) throw new Error('jobs.count: ' + res.error.message);
      return res.count || 0;
    },
    async resetStaleRunningJobs(minutes = 15) {
      const cutoff = new Date(Date.now() - minutes * 60000).toISOString();
      return ok(await t('eal_jobs').update({ status: 'queued' }).eq('status', 'running').lt('started_at', cutoff).select('id'), 'jobs.reset');
    },

    // ---- leads
    async courtStats(minFilings = 1) { return ok(await client.rpc('eal_court_record_stats', { p_min_filings: minFilings }), 'court_stats') || []; },
    async upsertLead(lead) { return ok(await client.rpc('eal_upsert_lead', { p: lead }), 'lead.upsert'); },
    async getLead(id) { return ok(await t('eal_attorneys').select('*').eq('id', id).maybeSingle(), 'lead'); },
    async updateLead(id, patch) { return ok(await t('eal_attorneys').update(patch).eq('id', id).select('id').single(), 'lead.update'); },
    async knownLeads() { return ok(await t('eal_attorneys').select('attorney_name,firm_name').order('created_at', { ascending: false }).limit(1000), 'leads.known') || []; },
  };
}
