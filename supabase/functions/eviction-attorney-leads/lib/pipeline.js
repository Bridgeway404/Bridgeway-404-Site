// Orchestration for one "Find More Attorneys" run. Runtime-neutral: the
// database, the model and the clock are injected through `env`.
//
//   env = { db, ai, log, now }
//     ai (optional) = { discover(pass), enrich(lead), spent }
//
// Job kinds (priority): run.start(0) → seed.court_records(10) →
// research.web(20) → enrich.attorney(30) → run.finish(900).
// Each web-research / enrichment job makes one model call and then ends the
// invocation (`heavy`), so a long run is a chain of short isolates exactly like
// the distressed worker.
import { buildCourtCandidates } from './court.js';
import { cleanWhitespace, formatPhone, nameKey } from './normalize.js';

export const PRIORITY = { 'run.start': 0, 'seed.court_records': 10, 'research.web': 20, 'enrich.attorney': 30, 'run.finish': 900 };
export const DEFAULT_COUNTIES = ['Fulton', 'DeKalb', 'Gwinnett', 'Cobb', 'Clayton', 'Douglas', 'Henry'];

const ANGLES = [
  'Law firms and attorneys whose websites market eviction / dispossessory / landlord-tenant representation to property owners, landlords, apartment communities and property management companies.',
  'Attorneys and firms listed as legal resources, allied members, vendors or speakers by the Atlanta Apartment Association, Georgia Apartment Association, NARPM Atlanta chapter, IREM Georgia and other property-management industry organizations.',
  'Attorneys named as plaintiff\'s counsel for apartment communities, management companies or single-family rental operators in dispossessory filings, court calendars, dockets or local news coverage of evictions.',
  'Attorney biographies and professional profiles describing representation of multifamily owners, property management companies or apartment communities in eviction and possession actions.',
];

/** Split the run's counties into rotating subsets and pair each pass with a research angle. */
export function buildPasses(options = {}, settings = {}) {
  const counties = (Array.isArray(options.counties) && options.counties.length ? options.counties
    : String(settings.counties || DEFAULT_COUNTIES.join(',')).split(',')).map(cleanWhitespace).filter(Boolean);
  const n = Math.max(0, Math.min(6, parseInt(options.web_passes != null ? options.web_passes : settings.web_passes_per_run || '2', 10) || 0));
  const passes = [];
  for (let i = 0; i < n; i++) {
    // Pass 1 covers everything; later passes narrow to a rotating slice so the
    // model digs deeper instead of repeating the same top results.
    const slice = i === 0 || counties.length <= 3 ? counties : counties.slice(((i - 1) * 3) % counties.length).concat(counties).slice(0, 3);
    const angle = ANGLES[i % ANGLES.length] + (options.focus ? ` Also: ${cleanWhitespace(options.focus)}` : '');
    passes.push({ index: i + 1, counties: slice, focus: angle });
  }
  return passes;
}

export async function processJobs(env, { timeBudgetMs = 90000 } = {}) {
  const started = Date.now();
  const log = env.log || (() => {});
  let handled = 0;
  await env.db.resetStaleRunningJobs(15);
  while (Date.now() - started < timeBudgetMs) {
    const job = await env.db.claimJob();
    if (!job) break;
    handled++;
    const run = job.run_id ? await env.db.getRun(job.run_id) : null;
    if (run && run.status === 'running') await env.db.updateRun(run.id, { heartbeat_at: new Date().toISOString() });
    try {
      const res = await handleJob(env, job, run);
      await env.db.completeJob(job.id);
      if (res && res.heavy) break;
    } catch (e) {
      log(`job ${job.kind} failed: ${e.message}`);
      const retry = job.attempts < 2 && !/permanent/i.test(e.message);
      await env.db.failJob(job.id, e.stack || e.message, retry);
      if (run) await appendRunError(env, run.id, { job: job.kind, payload: job.payload, error: String(e.message).slice(0, 500) });
      if (/model|anthropic|rate|overloaded|529|429/i.test(e.message)) break; // let the next isolate retry after a pause
    }
  }
  const remaining = await env.db.queuedJobCount();
  return { handled, remaining, elapsedMs: Date.now() - started };
}

async function appendRunError(env, runId, err) {
  const run = await env.db.getRun(runId);
  if (!run) return;
  const errors = Array.isArray(run.errors) ? run.errors.slice(-49) : [];
  errors.push({ at: new Date().toISOString(), ...err });
  await env.db.updateRun(runId, { errors });
}

async function appendRunLog(env, runId, line) {
  const run = await env.db.getRun(runId);
  if (!run) return;
  const log = Array.isArray(run.log) ? run.log.slice(-99) : [];
  log.push({ at: new Date().toISOString(), line });
  await env.db.updateRun(runId, { log });
}

async function bump(env, runId, patch) {
  const run = await env.db.getRun(runId);
  if (!run) return;
  const counts = { ...(run.counts || {}) };
  for (const [k, v] of Object.entries(patch)) counts[k] = (counts[k] || 0) + v;
  await env.db.updateRun(runId, { counts });
}

export async function handleJob(env, job, run) {
  switch (job.kind) {
    case 'run.start': return startRun(env, job.payload.run_id);
    case 'seed.court_records': return seedCourtRecords(env, job.payload.run_id);
    case 'research.web': return researchWeb(env, job.payload.run_id, job.payload.pass);
    case 'enrich.attorney': return enrichAttorney(env, job.payload.run_id, job.payload.lead_id);
    case 'run.finish': return finishRun(env, job.payload.run_id);
    default: throw new Error(`permanent: unknown job kind ${job.kind}`);
  }
}

async function startRun(env, runId) {
  const run = await env.db.getRun(runId);
  if (!run) throw new Error('permanent: run not found');
  const settings = await env.db.settings();
  const options = run.options || {};
  await env.db.updateRun(runId, { status: 'running', started_at: new Date().toISOString(), heartbeat_at: new Date().toISOString(), counts: { inserted: 0, merged: 0, skipped: 0, enriched: 0, candidates: 0, ai_cost: 0 } });
  if (options.court_records !== false) await env.db.enqueue(runId, 'seed.court_records', { run_id: runId }, PRIORITY['seed.court_records']);
  const passes = buildPasses(options, settings);
  for (const pass of passes) await env.db.enqueue(runId, 'research.web', { run_id: runId, pass }, PRIORITY['research.web']);
  await env.db.enqueue(runId, 'run.finish', { run_id: runId }, PRIORITY['run.finish']);
  await appendRunLog(env, runId, `Run started: ${options.court_records === false ? 'no court-record seed' : 'court-record seed'}, ${passes.length} web research pass${passes.length === 1 ? '' : 'es'}${env.ai ? '' : ' (no Anthropic API key: web research and enrichment will be skipped)'}.`);
  return {};
}

async function seedCourtRecords(env, runId) {
  const run = await env.db.getRun(runId);
  const settings = await env.db.settings();
  const options = (run && run.options) || {};
  const minFilings = parseInt(settings.min_court_filings || '2', 10) || 2;
  const rows = await env.db.courtStats(1);
  const counties = Array.isArray(options.counties) && options.counties.length ? options.counties : null;
  const candidates = buildCourtCandidates(rows, { minFilings, counties });
  const maxEnrich = parseInt(settings.max_enrich_per_run || '15', 10) || 15;
  let inserted = 0, merged = 0, queued = 0;
  for (const c of candidates) {
    // enrichment_status is decided here, not by the candidate: a lead that was
    // already researched keeps its status and is not researched again.
    const res = await env.db.upsertLead({ ...c, run_id: runId, enrichment_status: undefined });
    if (res.action === 'inserted') inserted++; else merged++;
    if (env.ai && queued < maxEnrich) {
      const lead = await env.db.getLead(res.id);
      if (lead && (res.action === 'inserted' || ['pending', 'failed'].includes(lead.enrichment_status))) {
        await env.db.updateLead(lead.id, { enrichment_status: 'pending' });
        await env.db.enqueue(runId, 'enrich.attorney', { run_id: runId, lead_id: lead.id }, PRIORITY['enrich.attorney']);
        queued++;
      }
    }
  }
  await bump(env, runId, { inserted, merged, candidates: candidates.length });
  await appendRunLog(env, runId, `Court records: ${rows.length} attorney/county rows on the calendars, ${candidates.length} qualified (landlord-side, ${minFilings}+ filings or 2+ business plaintiffs), ${inserted} new, ${merged} already on the list${env.ai ? `, ${queued} queued for contact research` : ''}.`);
  return {};
}

function validLead(a) {
  if (!a) return false;
  if (!cleanWhitespace(a.attorney_name) && !cleanWhitespace(a.firm_name)) return false;
  if (a.landlord_side === false) return false;
  if (!cleanWhitespace(a.evidence) || !cleanWhitespace(a.source_url)) return false;
  return true;
}

async function researchWeb(env, runId, pass) {
  if (!env.ai) {
    await appendRunLog(env, runId, `Web research pass ${pass.index} skipped: no Anthropic API key saved under Research settings.`);
    return {};
  }
  const settings = await env.db.settings();
  const maxNew = parseInt(settings.max_new_leads_per_run || '30', 10) || 30;
  const known = await env.db.knownLeads();
  const knownKeys = new Set(known.map(k => nameKey(k.attorney_name)).filter(Boolean));
  const before = env.ai.spent;
  const out = await env.ai.discover({ counties: pass.counties, focus: pass.focus, known: known.map(k => [k.attorney_name, k.firm_name].filter(Boolean).join(' — ')), maxResults: Math.min(15, maxNew) });
  const cost = env.ai.spent - before;
  let inserted = 0, merged = 0, skipped = 0;
  for (const a of (out && out.attorneys) || []) {
    if (!validLead(a)) { skipped++; continue; }
    if (a.attorney_name && knownKeys.has(nameKey(a.attorney_name))) { skipped++; continue; }
    const res = await env.db.upsertLead({
      attorney_name: a.attorney_name || null, firm_name: a.firm_name || null,
      phone: formatPhone(a.phone), email: a.email || null, website: a.website || null,
      city: a.city || null, county: a.county || null, counties: a.counties || [],
      practice_area: a.practice_area || 'Landlord-tenant / eviction (plaintiff side)',
      clients_identified: a.clients_identified || null, evidence: a.evidence,
      source_url: a.source_url, source_urls: a.source_urls || [], source_kind: 'web_research',
      confidence: a.confidence, referral_potential: a.referral_potential, enrichment_status: 'done', run_id: runId,
    });
    if (res.action === 'inserted') inserted++; else merged++;
  }
  await bump(env, runId, { inserted, merged, skipped, ai_cost: cost });
  await appendRunLog(env, runId, `Web research pass ${pass.index} (${pass.counties.join(', ')}): ${((out && out.attorneys) || []).length} candidates, ${inserted} new, ${merged} merged into existing leads, ${skipped} skipped (no evidence / tenant side / already listed).${out && out.notes ? ' ' + out.notes : ''}`);
  return { heavy: true };
}

async function enrichAttorney(env, runId, leadId) {
  const lead = await env.db.getLead(leadId);
  if (!lead) return {};
  if (!env.ai) { await env.db.updateLead(leadId, { enrichment_status: 'skipped' }); return {}; }
  const before = env.ai.spent;
  let out;
  try {
    out = await env.ai.enrich(lead);
  } catch (e) {
    await env.db.updateLead(leadId, { enrichment_status: 'failed', research_notes: `Contact research failed: ${String(e.message).slice(0, 200)}` });
    throw e;
  }
  const cost = env.ai.spent - before;
  if (!out || !out.found) {
    await env.db.updateLead(leadId, { enrichment_status: 'done', research_notes: (out && out.notes) || 'Contact research could not confidently identify this attorney online; look up by name in the State Bar of Georgia directory before calling.' });
    await bump(env, runId, { enriched: 1, ai_cost: cost });
    return { heavy: true };
  }
  const phone = formatPhone(out.phone);
  const evidence = out.evidence ? (out.landlord_side === false ? `Web: ${out.evidence} (sources describe tenant-side work — verify before calling)` : `Web: ${out.evidence}`) : null;
  await env.db.upsertLead({
    attorney_name: lead.attorney_name, firm_name: out.firm_name || null,
    phone, email: out.email || null, website: out.website || null, city: out.city || null, county: out.county || null,
    clients_identified: out.clients_identified || null, evidence,
    source_url: out.source_url || null, source_urls: out.source_urls || [],
    referral_potential: out.referral_potential || null, enrichment_status: 'done',
    research_notes: [out.practice_summary, out.phone && out.phone_is_firm_main_line ? 'Phone is the firm main line.' : null, out.notes].filter(Boolean).join(' '),
  });
  await bump(env, runId, { enriched: 1, ai_cost: cost });
  return { heavy: true };
}

async function finishRun(env, runId) {
  const run = await env.db.getRun(runId);
  if (!run) return {};
  const pending = await env.db.queuedJobCount(runId);
  if (pending > 1) {
    // Enrichment jobs are still queued behind us: put finish back at the end.
    await env.db.enqueue(runId, 'run.finish', { run_id: runId }, PRIORITY['run.finish']);
    return {};
  }
  const errors = Array.isArray(run.errors) ? run.errors.length : 0;
  const c = run.counts || {};
  await env.db.updateRun(runId, { status: errors ? 'completed_with_errors' : 'completed', finished_at: new Date().toISOString(), heartbeat_at: new Date().toISOString() });
  await appendRunLog(env, runId, `Finished: ${c.inserted || 0} new attorney${c.inserted === 1 ? '' : 's'} added, ${c.merged || 0} existing updated, ${c.enriched || 0} contact lookups${c.ai_cost ? `, AI spend $${Number(c.ai_cost).toFixed(2)}` : ''}${errors ? `, ${errors} error${errors === 1 ? '' : 's'}` : ''}.`);
  return {};
}
