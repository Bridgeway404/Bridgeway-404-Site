// Orchestration for one Auction Buyer research run. Runtime-neutral: the
// database, HTTP, document fetcher, model and clock are injected via `env`.
//
//   env = { db, http, fetchDoc, ai (optional), log, now, sources (tests) }
//
// Job kinds (priority): run.start(0) → source.fetch(10, one per source) →
// verify.batch(20, repeats while parcels remain) → buyers.consolidate(30) →
// enrich.buyer(40, optional, one model call each) → run.finish(900).
//
// The same chain runs for the Wednesday schedule and for the manual
// "Find Auction Buyers Now" button; only the trigger label differs.
import { getSource, sourcesFor } from './sources.js';
import { assessorFor, buildOwnerQueryUrl, readOwnerResponse, ownerChanged, UNKNOWN_OWNER } from './assessor.js';
import { classifyBuyer, cleanWhitespace, titleCase, propertyTypeFrom, parcelKey, formatPhone, looksLikeEntity } from './normalize.js';
import { splitPurchaser } from './parsers.js';

export const PRIORITY = { 'run.start': 0, 'source.fetch': 10, 'verify.batch': 20, 'buyers.consolidate': 30, 'enrich.buyer': 40, 'run.finish': 900 };
export const DEFAULT_COUNTIES = ['Fulton', 'DeKalb', 'Cobb', 'Henry', 'Douglas'];
const STATUS_RANK = { upcoming: 0, awaiting_sale_result: 1, buyer_research_needed: 2, buyer_identified: 3, contact_research_needed: 4, qualified: 5 };

const iso = (env) => (env.now ? env.now() : new Date()).toISOString();
const today = (env) => iso(env).slice(0, 10);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const looksLikeUnknown = (name) => UNKNOWN_OWNER.test(String(name || ''));

export function runCounties(options = {}, settings = {}) {
  const list = Array.isArray(options.counties) && options.counties.length ? options.counties : String(settings.counties || DEFAULT_COUNTIES.join(',')).split(',');
  return list.map(cleanWhitespace).filter(Boolean);
}

export async function processJobs(env, { timeBudgetMs = 90000 } = {}) {
  const started = Date.now();
  const log = env.log || (() => {});
  let handled = 0;
  await env.db.resetStaleRunningJobs(10);
  while (Date.now() - started < timeBudgetMs) {
    const job = await env.db.claimJob();
    if (!job) break;
    handled++;
    const run = job.run_id ? await env.db.getRun(job.run_id) : null;
    if (run && run.status === 'running') await env.db.updateRun(run.id, { heartbeat_at: iso(env) });
    try {
      const res = await handleJob(env, job, run);
      await env.db.completeJob(job.id);
      if (res && res.heavy) break;
    } catch (e) {
      log(`job ${job.kind} failed: ${e.message}`);
      const retry = job.attempts < 2 && !/permanent/i.test(e.message);
      await env.db.failJob(job.id, e.stack || e.message, retry);
      if (run) await appendRunError(env, run.id, { job: job.kind, payload: job.payload, error: String(e.message).slice(0, 500) });
      if (/model|anthropic|rate|overloaded|529|429/i.test(e.message)) break;
    }
  }
  const remaining = await env.db.queuedJobCount();
  return { handled, remaining, elapsedMs: Date.now() - started };
}

async function appendRunError(env, runId, err) {
  const run = await env.db.getRun(runId);
  if (!run) return;
  const errors = Array.isArray(run.errors) ? run.errors.slice(-49) : [];
  errors.push({ at: iso(env), ...err });
  await env.db.updateRun(runId, { errors });
}
async function appendRunLog(env, runId, line) {
  const run = await env.db.getRun(runId);
  if (!run) return;
  const log = Array.isArray(run.log) ? run.log.slice(-149) : [];
  log.push({ at: iso(env), line });
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
    case 'source.fetch': return sourceFetch(env, job.payload.run_id, job.payload.source_id);
    case 'verify.batch': return verifyBatch(env, job.payload.run_id, job.payload);
    case 'buyers.consolidate': return consolidateBuyers(env, job.payload.run_id);
    case 'enrich.buyer': return enrichBuyer(env, job.payload.run_id, job.payload.buyer_id);
    case 'run.finish': return finishRun(env, job.payload.run_id);
    default: throw new Error(`permanent: unknown job kind ${job.kind}`);
  }
}

// ---------------------------------------------------------------- run.start

async function startRun(env, runId) {
  const run = await env.db.getRun(runId);
  if (!run) throw new Error('permanent: run not found');
  const settings = await env.db.settings();
  const options = run.options || {};
  const counties = runCounties(options, settings);
  const sources = env.sources || sourcesFor(counties);
  await env.db.updateRun(runId, { status: 'running', started_at: iso(env), heartbeat_at: iso(env),
    counts: { counties_checked: counties.length, sales_reviewed: 0, advertised_seen: 0, buyers_identified: 0, qualified_added: 0, existing_updated: 0, repeat_buyers: 0, assessor_checks: 0, enriched: 0, ai_cost: 0, source_failures: 0 } });
  for (const s of sources) await env.db.enqueue(runId, 'source.fetch', { run_id: runId, source_id: s.id }, PRIORITY['source.fetch']);
  const maxChecks = parseInt(settings.max_assessor_checks_per_run || '400', 10) || 400;
  await env.db.enqueue(runId, 'verify.batch', { run_id: runId, budget: maxChecks, counties }, PRIORITY['verify.batch']);
  await env.db.enqueue(runId, 'buyers.consolidate', { run_id: runId }, PRIORITY['buyers.consolidate']);
  await env.db.enqueue(runId, 'run.finish', { run_id: runId }, PRIORITY['run.finish']);
  await appendRunLog(env, runId, `Run started (${run.trigger || 'manual'}): ${counties.join(', ')}; ${sources.length} public sources${env.ai ? '' : '; no Anthropic API key, so OCR of scanned lists and contact lookups are skipped'}.`);
  return {};
}

// ---------------------------------------------------------------- source.fetch

async function sourceFetch(env, runId, sourceId) {
  const src = (env.sources || []).find(s => s.id === sourceId) || getSource(sourceId);
  if (!src) throw new Error(`permanent: unknown source ${sourceId}`);
  const state = await env.db.sourceState(sourceId);
  if (state && state.enabled === false) { await appendRunLog(env, runId, `${src.county}: ${src.label} is disabled in settings; skipped.`); return {}; }
  const settings = await env.db.settings();
  const lookbackDays = parseInt(settings.lookback_days || '450', 10) || 450;
  const lookbackDate = new Date(Date.parse(iso(env)) - lookbackDays * 86400000).toISOString().slice(0, 10);
  const ctx = { fetchDoc: env.fetchDoc, http: env.http, ocr: env.ai && env.ai.ocr ? env.ai.ocr : null, now: env.now, log: env.log, lookbackDate };
  let out;
  try { out = await src.discover(ctx); }
  catch (e) { out = { records: [], documents: [], diagnostics: [`adapter error: ${String(e.message || e).slice(0, 300)}`] }; }
  for (const d of out.documents || []) {
    try { await env.db.upsertDocument({ ...d, text: d.text ? String(d.text).slice(0, 400000) : null, fetched_at: iso(env) }); } catch (e) { (env.log || (() => {}))(`document save failed: ${e.message}`); }
  }
  let inserted = 0, updated = 0, sold = 0, advertised = 0, skipped = 0;
  for (const rec of out.records || []) {
    const r = await ingestRecord(env, runId, rec);
    if (!r) { skipped++; continue; }
    if (r.action === 'inserted') inserted++; else updated++;
    if (rec.sold) sold++; else advertised++;
  }
  const failed = !(out.records || []).length && (out.diagnostics || []).some(d => /HTTP|could not open|adapter error|scanned/i.test(d));
  const docsOk = (out.documents || []).filter(d => d.status_code >= 200 && d.status_code < 300).length;
  await env.db.upsertSourceState({
    source_id: src.id, county: src.county, label: src.label, notes: src.notes || null,
    last_attempt_at: iso(env),
    last_success_at: (out.records || []).length || docsOk ? iso(env) : (state ? state.last_success_at : null),
    last_error: failed ? (out.diagnostics || []).join(' | ').slice(0, 900) : ((out.diagnostics || []).length ? (out.diagnostics || []).join(' | ').slice(0, 900) : null),
    last_error_at: failed ? iso(env) : (state ? state.last_error_at : null),
    consecutive_failures: failed ? ((state ? state.consecutive_failures : 0) || 0) + 1 : 0,
  });
  await bump(env, runId, { sales_reviewed: sold, advertised_seen: advertised, source_failures: failed ? 1 : 0 });
  const diag = (out.diagnostics || []).length ? ' ' + (out.diagnostics || []).slice(0, 3).map(d => d.replace(/^https?:\/\/[^ ]+: /, '')).join('; ') : '';
  await appendRunLog(env, runId, `${src.county}: ${src.kind === 'sold' ? 'completed-sale list' : 'upcoming-sale list'} — ${sold + advertised} parcel${sold + advertised === 1 ? '' : 's'} (${inserted} new, ${updated} already tracked${skipped ? `, ${skipped} skipped` : ''}).${diag}`);
  // Parsing a county PDF is CPU-heavy. Hand the remaining queue to a fresh
  // invocation so one isolate never accumulates enough CPU time to be killed
  // ("CPU Time exceeded") part-way through the run.
  return { heavy: true };
}

/** Insert or refresh one property from a list record. Never downgrades research progress. */
export async function ingestRecord(env, runId, rec) {
  const key = parcelKey(rec.parcel_id);
  if (!key || key.length < 5 || !rec.county) return null;
  const d = today(env);
  const existing = await env.db.findProperty(rec.county, key);
  const ptype = propertyTypeFrom([rec.property_hint, rec.address].filter(Boolean).join(' '), 'unknown');
  let status, reason = null, soldConfirmed = false, soldEvidence = null, purchaser = null;
  if (rec.redeemed) { status = 'not_useful'; reason = 'redeemed by the former owner after the tax sale'; soldConfirmed = true; soldEvidence = rec.evidence; }
  else if (rec.sold) { soldConfirmed = true; soldEvidence = rec.evidence; if (rec.purchaser_name) { status = 'buyer_identified'; purchaser = rec.purchaser_name; reason = 'purchaser named by the county'; } else { status = 'buyer_research_needed'; reason = 'sale completed; purchaser not printed — checking the assessor roll for the new owner'; } }
  else { status = rec.sale_date && rec.sale_date > d ? 'upcoming' : 'awaiting_sale_result'; reason = status === 'upcoming' ? 'advertised for an upcoming sale' : 'advertised sale date has passed; waiting for a result'; }
  if (ptype === 'land' && status !== 'not_useful') { status = 'not_useful'; reason = 'vacant land / lot only (no cleanout need)'; }

  if (!existing) {
    const row = await env.db.insertProperty({
      county: rec.county, parcel_id: cleanWhitespace(rec.parcel_id), address: rec.address || null, city: rec.city || null, zip: rec.zip || null,
      property_type: ptype, sale_type: rec.sale_type || 'tax_sale', sale_date: rec.sale_date || null,
      list_source_id: rec.source_id || null, list_url: rec.list_url || null, list_label: rec.list_label || null, list_owner_name: rec.list_owner_name || null,
      amount_due: rec.amount_due != null ? rec.amount_due : null, research_status: status, status_reason: reason,
      purchaser_name: purchaser, purchase_price: rec.purchase_price != null ? rec.purchase_price : null, sold_confirmed: soldConfirmed, sold_evidence: soldEvidence,
      evidence: rec.evidence || null, first_seen_at: iso(env), last_seen_at: iso(env), first_run_id: runId, last_run_id: runId,
    });
    return { action: 'inserted', id: row.id, status };
  }
  const patch = { last_seen_at: iso(env), last_run_id: runId };
  for (const k of ['address', 'city', 'zip', 'sale_date', 'list_owner_name', 'list_url', 'list_label', 'amount_due', 'purchase_price']) {
    const v = rec[k === 'list_url' ? 'list_url' : k === 'list_label' ? 'list_label' : k];
    if (existing[k] == null && v != null && v !== '') patch[k] = v;
  }
  if (rec.evidence && !(existing.evidence || '').includes(rec.evidence)) patch.evidence = existing.evidence ? existing.evidence + '\n' + rec.evidence : rec.evidence;
  if (soldConfirmed && !existing.sold_confirmed) { patch.sold_confirmed = true; patch.sold_evidence = soldEvidence; }
  if (purchaser && !existing.purchaser_name) patch.purchaser_name = purchaser;
  if (existing.property_type === 'unknown' && ptype !== 'unknown') patch.property_type = ptype;
  const exRank = STATUS_RANK[existing.research_status];
  if (existing.research_status === 'not_useful') { /* stays */ }
  else if (status === 'not_useful') { patch.research_status = status; patch.status_reason = reason; }
  else if (exRank != null && STATUS_RANK[status] > exRank) { patch.research_status = status; patch.status_reason = reason; }
  else if (existing.research_status === 'upcoming' && status === 'awaiting_sale_result') { patch.research_status = status; patch.status_reason = reason; }
  await env.db.updateProperty(existing.id, patch);
  return { action: 'updated', id: existing.id, status: patch.research_status || existing.research_status };
}

// ---------------------------------------------------------------- verify.batch

async function verifyBatch(env, runId, payload) {
  const settings = await env.db.settings();
  const d = today(env);
  const counties = Array.isArray(payload.counties) && payload.counties.length ? payload.counties : runCounties({}, settings);
  const recheckDays = parseInt(settings.recheck_days || '7', 10) || 7;
  const giveUpDays = parseInt(settings.give_up_days || '240', 10) || 240;
  const lookbackDays = parseInt(settings.lookback_days || '450', 10) || 450;
  const budget = Math.max(0, parseInt(payload.budget != null ? payload.budget : settings.max_assessor_checks_per_run || '400', 10) || 0);
  const batch = Math.min(25, budget);
  await env.db.promoteUpcoming(d);
  if (batch <= 0) return {};
  const recheckBefore = new Date(Date.parse(iso(env)) - recheckDays * 86400000).toISOString();
  const lookbackDate = new Date(Date.parse(iso(env)) - lookbackDays * 86400000).toISOString().slice(0, 10);
  const props = await env.db.propertiesToVerify({ counties, limit: batch, recheckBefore, lookbackDate });
  let checks = 0, identified = 0, failures = 0;
  for (const p of props) {
    const a = assessorFor(p.county);
    const patch = { assessor_checked_at: iso(env) };
    if (!a || a.noOwner) {
      patch.status_reason = a && a.noOwnerNote ? a.noOwnerNote : `no assessor lookup is available for ${p.county} County`;
    } else {
      const url = buildOwnerQueryUrl(p.county, p.parcel_id);
      patch.assessor_source_url = a.url.replace(/\/query$/, '');
      let json = null, err = null;
      try {
        const res = await env.http.get(url, { accept: 'application/json', timeoutMs: 20000 });
        if (!res.ok) err = `HTTP ${res.status || res.error || '?'}`;
        else { try { json = JSON.parse(res.text); } catch { err = 'non-JSON response'; } }
      } catch (e) { err = String(e.message || e); }
      const read = err ? { error: err } : readOwnerResponse(p.county, json);
      if (read.error) { patch.status_reason = `assessor lookup failed (${read.error}); will retry`; failures++; }
      else if (read.notFound) { patch.status_reason = 'parcel not found on the assessor roll (retired, split or re-numbered)'; }
      else {
        const rec = read.record;
        patch.assessor_owner_name = rec.owner_name || null;
        patch.assessor_owner_mailing = rec.owner_mailing || null;
        patch.assessor_use = rec.use || null;
        if (p.property_type === 'unknown' || !p.property_type) patch.property_type = propertyTypeFrom(rec.use, 'unknown');
        if (!p.address && rec.site_address) patch.address = cleanWhitespace(rec.site_address).toUpperCase();
        if (!p.city && rec.city) patch.city = rec.city;
        if (!p.zip && rec.zip) patch.zip = rec.zip;
        if ((patch.property_type || p.property_type) === 'land') { patch.research_status = 'not_useful'; patch.status_reason = 'vacant land per the assessor class'; }
        else if (a.stale) { patch.owner_changed = null; patch.status_reason = a.staleNote; }
        else {
          const cmp = ownerChanged(p.list_owner_name, rec.owner_name);
          patch.owner_changed = cmp.changed;
          const salePassed = !p.sale_date || p.sale_date <= d;
          if (cmp.unknownPrior && p.sold_confirmed && rec.owner_name && !looksLikeUnknown(rec.owner_name)) {
            // The county confirmed the sale but never named the prior owner; the current owner of record is the purchaser.
            patch.research_status = 'buyer_identified';
            patch.purchaser_name = rec.owner_name;
            patch.sold_evidence = [p.sold_evidence, `${a.label}: owner of record is ${rec.owner_name}${rec.owner_mailing ? ' (mailing ' + rec.owner_mailing + ')' : ''}; the county listed the prior owner as unknown.`].filter(Boolean).join(' ');
            patch.status_reason = 'sale confirmed by the county; assessor shows the current owner (prior owner was unknown)';
            identified++;
          } else if (cmp.changed === true && (p.sold_confirmed || salePassed)) {
            patch.research_status = 'buyer_identified';
            patch.purchaser_name = rec.owner_name;
            patch.sold_confirmed = true;
            const line = `${a.label}: owner of record is now ${rec.owner_name}${rec.owner_mailing ? ' (mailing ' + rec.owner_mailing + ')' : ''}, no longer the pre-sale owner ${p.list_owner_name}.`;
            patch.sold_evidence = [p.sold_evidence, line].filter(Boolean).join(' ');
            patch.status_reason = p.sold_confirmed ? 'sale confirmed by the county; assessor shows the new owner' : 'assessor shows a new owner after the advertised sale date';
            identified++;
          } else if (cmp.changed === false) {
            patch.status_reason = p.sold_confirmed
              ? 'sale completed per the county, but the assessor roll still shows the pre-sale owner (tax deeds are often not re-titled until the redemption period ends); re-checked weekly'
              : salePassed ? 'advertised sale date has passed; assessor still shows the same owner (sale may have been cancelled, paid or bid in); re-checked weekly' : 'upcoming sale; owner unchanged so far';
          } else patch.status_reason = cmp.reason;
        }
      }
      checks++;
      if (env.throttleMs !== 0) await sleep(env.throttleMs == null ? 250 : env.throttleMs);
    }
    if (!patch.research_status && p.research_status === 'awaiting_sale_result' && p.first_seen_at && (Date.parse(iso(env)) - Date.parse(p.first_seen_at)) / 86400000 > giveUpDays) {
      patch.research_status = 'not_useful'; patch.status_reason = `no ownership change ${giveUpDays} days after the advertised sale`;
    }
    await env.db.updateProperty(p.id, patch);
  }
  await bump(env, runId, { assessor_checks: checks, buyers_identified: identified });
  if (props.length) await appendRunLog(env, runId, `Assessor check: ${props.length} parcel${props.length === 1 ? '' : 's'} looked up, ${identified} now show a new owner${failures ? `, ${failures} lookups failed` : ''}.`);
  if (props.length === batch && budget - checks > 0 && checks > 0) {
    await env.db.enqueue(runId, 'verify.batch', { run_id: runId, budget: budget - checks, counties }, PRIORITY['verify.batch']);
  }
  return {};
}

// ---------------------------------------------------------------- buyers.consolidate

/** Qualification + priority for one buyer given its linked properties. Pure. */
export function scoreBuyer(buyer, props) {
  const isEntity = looksLikeEntity(buyer.buyer_name);
  const institutional = !!buyer.is_institutional || ['institutional_lender', 'servicer', 'government'].includes(buyer.buyer_type);
  const sold = (props || []).filter(p => p.sold_confirmed).length;
  const relevant = (props || []).some(p => p.property_type !== 'land' && p.research_status !== 'not_useful');
  const direct = !!(buyer.phone || buyer.email);
  // A company's public mailing address is a real way in. For a person, only a
  // repeat purchaser (someone plainly investing) is worth a letter; a one-off
  // individual needs a phone or email first.
  const contactable = direct || !!buyer.website || !!(buyer.mailing_address && (isEntity || sold >= 2));
  let qualified = sold > 0 && relevant && contactable;
  let reason;
  if (!sold) reason = 'no confirmed completed sale yet';
  else if (!relevant) reason = 'only vacant land / not useful property';
  else if (institutional && !direct) { qualified = false; reason = 'bank / servicer / government purchaser without a practical downstream contact'; }
  else if (!contactable) reason = isEntity ? 'need a phone, email, website or mailing address for the company' : 'individual purchaser: need a phone or email before calling (a mailing address is enough once they have bought twice)';
  else reason = 'qualified';
  let priority = 'Low';
  if (qualified) priority = (sold >= 2 || (isEntity && direct)) ? 'High' : 'Medium';
  return { qualified, priority, reason, isEntity, institutional, sold };
}

async function consolidateBuyers(env, runId) {
  const settings = await env.db.settings();
  const props = await env.db.propertiesToConsolidate(300);
  let inserted = 0, merged = 0, notUseful = 0;
  const touched = new Set();
  const mergedInto = new Set();
  for (const p of props) {
    const split = splitPurchaser(p.purchaser_name);
    const rawName = split.entity || split.person;
    const cls = classifyBuyer(rawName);
    if (cls.buyerType === 'government') {
      await env.db.updateProperty(p.id, { research_status: 'not_useful', status_reason: `bid in by ${p.purchaser_name} (government); no cleanout buyer` });
      notUseful++; continue;
    }
    const purchaserIsAssessorOwner = p.assessor_owner_name && cleanWhitespace(p.assessor_owner_name).toUpperCase() === cleanWhitespace(p.purchaser_name).toUpperCase();
    const mailing = purchaserIsAssessorOwner ? p.assessor_owner_mailing : null;
    const sources = [p.list_url, purchaserIsAssessorOwner ? p.assessor_source_url : null].filter(Boolean);
    const res = await env.db.upsertBuyer({
      buyer_name: titleCase(rawName), contact_name: split.entity && split.person ? titleCase(split.person) : null,
      mailing_address: mailing || null, city: p.city || null, county: p.county,
      buyer_type: cls.buyerType, is_institutional: cls.isInstitutional,
      evidence: p.sold_evidence || p.evidence || null, source_urls: sources, run_id: runId,
      research_notes: cls.isInstitutional ? 'Institutional purchaser: only useful if a local REO / asset-management contact can be found.' : null,
    });
    if (res.action === 'inserted') inserted++; else { merged++; mergedInto.add(res.id); }
    await env.db.linkProperty(res.id, p.id, p.sale_date || null, p.sold_evidence || p.evidence || null);
    touched.add(res.id);
  }
  // Re-score every touched buyer (and any buyer still lacking qualification, so
  // contact details added by hand or by enrichment are picked up).
  const rescore = new Set(touched);
  for (const b of await env.db.buyersToRescore(200)) rescore.add(b.id);
  let qualifiedNew = 0, repeat = 0, updatedExisting = 0;
  const enrichCandidates = [];
  for (const id of rescore) {
    const r = await rescoreBuyer(env, id);
    if (!r) continue;
    if (r.becameQualified) qualifiedNew++;
    if (r.buyer.recent_acquisitions >= 2 && r.score.qualified) repeat++;
    if (mergedInto.has(id) && !r.becameQualified) updatedExisting++;
    if (env.ai && !r.buyer.phone && !r.buyer.email && !r.score.institutional && r.score.sold > 0) enrichCandidates.push(r.buyer);
  }
  const maxEnrich = parseInt(settings.max_ai_enrich_per_run || '10', 10) || 0;
  enrichCandidates.sort((a, b) => (b.recent_acquisitions || 0) - (a.recent_acquisitions || 0));
  let queued = 0;
  for (const b of enrichCandidates.slice(0, maxEnrich)) { await env.db.enqueue(runId, 'enrich.buyer', { run_id: runId, buyer_id: b.id }, PRIORITY['enrich.buyer']); queued++; }
  await bump(env, runId, { qualified_added: qualifiedNew, existing_updated: updatedExisting, repeat_buyers: repeat });
  await appendRunLog(env, runId, `Buyers: ${props.length} newly identified purchaser record${props.length === 1 ? '' : 's'} → ${inserted} new buyer${inserted === 1 ? '' : 's'}, ${merged} merged into existing buyers${notUseful ? `, ${notUseful} bid in by the county` : ''}; ${qualifiedNew} newly qualified for the call list, ${repeat} repeat purchaser${repeat === 1 ? '' : 's'}${queued ? `; ${queued} queued for contact lookup` : ''}.`);
  return {};
}

async function rescoreBuyer(env, buyerId) {
  const buyer = await env.db.getBuyer(buyerId);
  if (!buyer) return null;
  const props = await env.db.buyerProperties(buyerId);
  const score = scoreBuyer(buyer, props);
  const patch = {};
  const wasQualified = !!buyer.qualified;
  if (score.qualified !== wasQualified) patch.qualified = score.qualified;
  // Never lower a priority a person may have set by hand on an already-qualified lead.
  const order = { Low: 0, Medium: 1, High: 2 };
  if (!wasQualified || order[score.priority] > order[buyer.priority]) { if (score.priority !== buyer.priority) patch.priority = score.priority; }
  if (Object.keys(patch).length) await env.db.updateBuyer(buyerId, patch);
  const propStatus = score.qualified ? 'qualified' : (score.sold ? 'contact_research_needed' : 'buyer_identified');
  for (const p of props) {
    if (p.research_status === 'not_useful') continue;
    if (p.research_status !== propStatus) await env.db.updateProperty(p.id, { research_status: propStatus, status_reason: score.reason });
  }
  if (score.qualified && !wasQualified) await env.db.addSystemActivity(buyerId, `Qualified for the call list: ${score.sold} confirmed auction acquisition${score.sold === 1 ? '' : 's'}, priority ${score.priority}.`);
  return { buyer: { ...buyer, ...patch }, score, becameQualified: score.qualified && !wasQualified };
}

// ---------------------------------------------------------------- enrich.buyer (optional Claude)

async function enrichBuyer(env, runId, buyerId) {
  const buyer = await env.db.getBuyer(buyerId);
  if (!buyer || !env.ai || !env.ai.enrichBuyer) return {};
  if (buyer.phone || buyer.email) return {};
  const props = await env.db.buyerProperties(buyerId);
  const before = env.ai.spent;
  let out;
  try { out = await env.ai.enrichBuyer(buyer, props); }
  catch (e) { await env.db.updateBuyer(buyerId, { research_notes: `Contact lookup failed: ${String(e.message).slice(0, 200)}` }); throw e; }
  const cost = env.ai.spent - before;
  if (out && out.found) {
    await env.db.upsertBuyer({ buyer_name: buyer.buyer_name, contact_name: out.contact_name || null, phone: formatPhone(out.phone), email: out.email || null, website: out.website || null,
      mailing_address: out.mailing_address || null, evidence: out.evidence ? `Web: ${out.evidence}` : null, source_urls: out.source_urls || [],
      buyer_type: out.buyer_type || null, portfolio_count: out.portfolio_count || null, research_notes: out.notes || null });
  } else {
    await env.db.updateBuyer(buyerId, { research_notes: (out && out.notes) || 'Contact lookup found no business phone, email or website for this purchaser.' });
  }
  await rescoreBuyer(env, buyerId);
  await bump(env, runId, { enriched: 1, ai_cost: cost });
  return { heavy: true };
}

// ---------------------------------------------------------------- run.finish

async function finishRun(env, runId) {
  const run = await env.db.getRun(runId);
  if (!run) return {};
  const pending = await env.db.queuedJobCount(runId);
  if (pending > 1) { await env.db.enqueue(runId, 'run.finish', { run_id: runId }, PRIORITY['run.finish']); return {}; }
  const errors = Array.isArray(run.errors) ? run.errors.length : 0;
  const c = run.counts || {};
  await env.db.updateRun(runId, { status: errors ? 'completed_with_errors' : 'completed', finished_at: iso(env), heartbeat_at: iso(env) });
  await appendRunLog(env, runId, `Finished: ${c.counties_checked || 0} counties checked, ${c.sales_reviewed || 0} completed sales reviewed, ${c.advertised_seen || 0} advertised parcels tracked, ${c.buyers_identified || 0} purchasers identified, ${c.qualified_added || 0} qualified leads added, ${c.existing_updated || 0} existing updated, ${c.repeat_buyers || 0} repeat purchasers${c.enriched ? `, ${c.enriched} contact lookups` : ''}${c.ai_cost ? `, AI spend $${Number(c.ai_cost).toFixed(2)}` : ''}${errors ? `, ${errors} error${errors === 1 ? '' : 's'}` : ''}.`);
  return {};
}
