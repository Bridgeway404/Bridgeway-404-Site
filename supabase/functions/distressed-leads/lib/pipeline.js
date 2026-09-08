// Orchestration: turns queued jobs into discovery, ingestion, enrichment and
// scoring work. Runtime-neutral: everything that touches the network, the
// database or the model is injected through `env`.
//
//   env = { db, http, sources, ai, pdfExtract, log, now }
//     ai (optional) = { extractNotices(input, ctx), extractCalendar(text, ctx), researchCompany(name, ctx) }
//
// Job kinds (priority): run.start(0) → ingest.upload(5) → discover(10) →
// enrich.ownership(20) → enrich.company(30) → score(40) → run.finish(900).

import { parseAddress, normalizeParcel, nameKey, looksLikeEntity, cleanName, contentHash, detectCounty } from './normalize.js';
import { classifyForeclosureStage, classifyEvictionText, shouldAdvance, stageEventDate, isTurnoverStage } from './stages.js';
import { findPropertyMatch, matchForeclosureEvent, matchEvictionEvent, mergeFields } from './dedupe.js';
import { scoreOpportunity, enrichmentPriority } from './scoring.js';
import { chooseTarget, roleFromTitle, companyTypeFrom } from './target.js';
import { buildQueryUrl, pickFeature, interpretOwner, propertyTypeFrom, PARCEL_SERVICES } from './enrich/ownership.js';
import { extractNoticeFields, splitNotices } from './parsers/notice.js';

const PRIORITY = { 'run.start': 0, 'ingest.upload': 5, discover: 10, 'enrich.ownership': 20, 'enrich.company': 30, score: 40, 'run.finish': 900 };

export async function processJobs(env, { timeBudgetMs = 90000 } = {}) {
  const started = Date.now();
  const log = env.log || (() => {});
  let handled = 0;
  await env.db.resetStaleRunningJobs(20);
  while (Date.now() - started < timeBudgetMs) {
    const job = await env.db.claimJob();
    if (!job) break;
    handled++;
    const run = job.run_id ? await env.db.getRun(job.run_id) : null;
    if (run && run.status === 'running') await env.db.updateRun(run.id, { heartbeat_at: new Date().toISOString() });
    try {
      const res = await handleJob(env, job, run);
      await env.db.completeJob(job.id);
      // A job that fetched and parsed documents used most of an isolate's CPU
      // budget: stop here and let the worker re-invoke itself in a fresh isolate.
      if (res && res.heavy) break;
    } catch (e) {
      log(`job ${job.kind} failed: ${e.message}`);
      const retry = job.attempts < 2 && !/permanent/i.test(e.message);
      await env.db.failJob(job.id, e.stack || e.message, retry);
      if (run) await appendRunError(env, run.id, { job: job.kind, payload: job.payload, error: String(e.message).slice(0, 500) });
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

export async function handleJob(env, job, run) {
  switch (job.kind) {
    case 'run.start': return startRun(env, job.payload.run_id);
    case 'discover': return discoverSource(env, job.payload.run_id, job.payload.source_id);
    case 'ingest.upload': return ingestUpload(env, job.payload.upload_id, job.run_id);
    case 'enrich.ownership': return enrichOwnership(env, job.payload.property_id, job.run_id);
    case 'enrich.company': return enrichCompany(env, job.payload.company_id, job.payload.context || {}, job.run_id);
    case 'score': return scoreProperty(env, job.payload.property_id, job.run_id);
    case 'run.finish': return finishRun(env, job.payload.run_id);
    default: throw new Error(`permanent: unknown job kind ${job.kind}`);
  }
}

// ---------------------------------------------------------------- run lifecycle

export async function startRun(env, runId) {
  const db = env.db;
  const now = new Date().toISOString();
  await db.updateRun(runId, { status: 'running', started_at: now, heartbeat_at: now, counties_attempted: ['Fulton', 'DeKalb', 'Douglas', 'Henry'] });
  const states = await db.sourceStates();
  const byId = Object.fromEntries(states.map(s => [s.source_id, s]));
  const attempted = [];
  for (const src of env.sources) {
    if (!byId[src.id]) {
      byId[src.id] = await db.upsertSourceState({ source_id: src.id, county: src.county, label: src.label, enabled: src.enabledByDefault !== false, notes: src.notes || null });
    }
    if (!byId[src.id].enabled) { await db.upsertRunSource(runId, src.id, { county: src.county, status: 'skipped', detail: { reason: 'disabled' } }); continue; }
    attempted.push(src.id);
    await db.upsertRunSource(runId, src.id, { county: src.county, status: 'pending' });
    await db.enqueue(runId, 'discover', { run_id: runId, source_id: src.id }, PRIORITY.discover);
  }
  await db.updateRun(runId, { sources_attempted: attempted });
  await db.enqueue(runId, 'run.finish', { run_id: runId }, PRIORITY['run.finish']);
}

export async function finishRun(env, runId) {
  const db = env.db;
  const run = await db.getRun(runId);
  if (!run) return;
  const rs = await db.runSources(runId);
  const jobs = await db.jobsForRun(runId);
  const ok = rs.filter(s => s.status === 'ok').map(s => s.source_id);
  const failed = rs.filter(s => s.status === 'failed').map(s => s.source_id);
  const counts = Object.assign({}, run.counts || {});
  counts.raw_records = rs.reduce((n, s) => n + (s.items_seen || 0), 0);
  counts.sources_unavailable = rs.filter(s => s.status === 'unavailable').length;
  counts.jobs_failed = jobs.filter(j => j.status === 'failed').length;
  counts.companies_enriched = jobs.filter(j => j.kind === 'enrich.company' && j.status === 'done').length;
  counts.enrichment_failures = jobs.filter(j => (j.kind === 'enrich.company' || j.kind === 'enrich.ownership') && j.status === 'failed').length;
  const status = failed.length === 0 && counts.jobs_failed === 0 ? 'completed' : (ok.length || counts.new_properties ? 'completed_with_errors' : (failed.length && !ok.length ? 'failed' : 'completed_with_errors'));
  await db.updateRun(runId, { status, finished_at: new Date().toISOString(), heartbeat_at: new Date().toISOString(), sources_succeeded: ok, sources_failed: failed, counts });
}

async function bumpRunCount(env, runId, key, by = 1) {
  if (!runId) return;
  const run = await env.db.getRun(runId);
  if (!run) return;
  const counts = Object.assign({}, run.counts || {});
  counts[key] = (counts[key] || 0) + by;
  await env.db.updateRun(runId, { counts, heartbeat_at: new Date().toISOString() });
}

// ---------------------------------------------------------------- discovery

export async function discoverSource(env, runId, sourceId) {
  const db = env.db;
  const src = env.sources.find(s => s.id === sourceId);
  if (!src) throw new Error(`permanent: unknown source ${sourceId}`);
  const settings = await db.settings();
  await db.upsertRunSource(runId, sourceId, { county: src.county, status: 'running', started_at: new Date().toISOString() });
  const seen = await db.seenExternalIds(sourceId);
  const prev = (await db.runSources(runId)).find(s => s.source_id === sourceId) || {};
  // Long discoveries (a dozen throttled document fetches) must keep the run's
  // heartbeat fresh, or the dpl_tick watchdog starts a second worker.
  let lastBeat = Date.now();
  const beat = async () => {
    if (Date.now() - lastBeat < 30000) return;
    lastBeat = Date.now();
    await db.updateRun(runId, { heartbeat_at: new Date().toISOString() });
  };
  const http = { ...env.http, get: async (...args) => { const r = await env.http.get(...args); await beat(); return r; } };
  const ctx = {
    http, log: env.log || (() => {}), pdfExtract: env.pdfExtract,
    seen: (id) => seen.has(id),
    // Documents per job: each PDF/Word calendar costs ~0.1-0.5 s of CPU and the
    // edge runtime kills an isolate that exceeds its CPU budget, so a job takes
    // a few documents, reports `more`, and is re-queued (see below).
    maxNewItems: Math.max(1, parseInt(settings.max_documents_per_job || '3', 10)),
    sinceDate: new Date(Date.now() - (parseInt(settings.lookback_days || '14', 10) + 7) * 86400000).toISOString().slice(0, 10),
    aiExtractCalendar: env.ai ? (text, c) => env.ai.extractCalendar(text, c) : null,
  };
  let result;
  try {
    result = await src.discover(ctx);
  } catch (e) {
    await db.upsertRunSource(runId, sourceId, { status: 'failed', finished_at: new Date().toISOString(), error: String(e.message).slice(0, 800) });
    const st = (await db.sourceStates()).find(s => s.source_id === sourceId) || {};
    await db.upsertSourceState({ source_id: sourceId, county: src.county, label: src.label, last_attempt_at: new Date().toISOString(), last_error: String(e.message).slice(0, 800), last_error_at: new Date().toISOString(), consecutive_failures: (st.consecutive_failures || 0) + 1 });
    return; // a failed source must not fail the run
  }
  if (result.unavailable) {
    await db.upsertRunSource(runId, sourceId, { status: 'unavailable', finished_at: new Date().toISOString(), error: result.reason || 'unavailable', detail: result.diagnostics || {} });
    await db.upsertSourceState({ source_id: sourceId, county: src.county, label: src.label, last_attempt_at: new Date().toISOString(), last_error: result.reason || 'unavailable', last_error_at: new Date().toISOString(), notes: src.notes || null });
    return;
  }
  let seenCount = 0, newCount = 0, updatedCount = 0;
  const stats = { new_properties: 0, updated_properties: 0, new_events: 0, advanced: 0, high_priority: 0, unmatched: 0 };
  for (const rec of result.records || []) {
    seenCount++;
    await beat();
    try {
      const r = await ingestRecord(env, rec, runId, stats);
      if (r && r.isNew) newCount++; else if (r && r.updated) updatedCount++;
    } catch (e) {
      (env.log || (() => {}))(`ingest failed (${sourceId} ${rec.external_id}): ${e.message}`);
      await appendRunError(env, runId, { job: 'ingest', source: sourceId, external_id: rec.external_id, error: String(e.message).slice(0, 300) });
    }
  }
  // Totals accumulate across the chunks of one source within a run.
  const prevDetail = prev.detail || {};
  const detail = { ...prevDetail, ...(result.diagnostics || {}) };
  for (const k of Object.keys(stats)) detail[k] = (prevDetail[k] || 0) + stats[k];
  for (const k of Object.keys(result.diagnostics || {})) if (typeof result.diagnostics[k] === 'number' && typeof prevDetail[k] === 'number') detail[k] = prevDetail[k] + result.diagnostics[k];
  const totals = { items_seen: (prev.items_seen || 0) + seenCount, items_new: (prev.items_new || 0) + newCount, items_updated: (prev.items_updated || 0) + updatedCount };
  const run = await db.getRun(runId);
  const counts = Object.assign({}, run?.counts || {});
  for (const k of ['new_properties', 'updated_properties', 'new_events', 'advanced', 'high_priority', 'unmatched']) counts[k] = (counts[k] || 0) + stats[k];
  counts[src.kind === 'foreclosure' ? 'foreclosure_records' : 'eviction_records'] = (counts[src.kind === 'foreclosure' ? 'foreclosure_records' : 'eviction_records'] || 0) + seenCount;
  await db.updateRun(runId, { counts, heartbeat_at: new Date().toISOString() });
  const heavy = (result.records || []).some(r => r.pdf_bytes || r.kind === 'calendar_document' || r.kind === 'notice_document');
  if (result.more) {
    // More unseen documents remain: record progress and queue the next chunk.
    await db.upsertRunSource(runId, sourceId, { status: 'running', ...totals, detail: { ...detail, chunks: (prevDetail.chunks || 0) + 1 } });
    await db.enqueue(runId, 'discover', { run_id: runId, source_id: sourceId }, PRIORITY.discover);
    return { heavy: true, more: true };
  }
  await db.upsertRunSource(runId, sourceId, { status: 'ok', finished_at: new Date().toISOString(), ...totals, detail: { ...detail, chunks: (prevDetail.chunks || 0) + 1 } });
  await db.upsertSourceState({ source_id: sourceId, county: src.county, label: src.label, last_attempt_at: new Date().toISOString(), last_success_at: new Date().toISOString(), last_error: null, last_error_at: null, consecutive_failures: 0, cursor: result.cursor || {}, notes: src.notes || null });
  return { heavy };
}

// ---------------------------------------------------------------- ingestion

/**
 * One raw record → source item + property + event (+ companies, evidence,
 * follow-up jobs). Returns { isNew, updated, propertyId, eventId }.
 */
export async function ingestRecord(env, rec, runId, stats = {}) {
  const db = env.db;
  const now = new Date().toISOString();
  const existingItem = await db.getSourceItem(rec.source_id, rec.external_id);
  const baseItem = {
    source_id: rec.source_id, external_id: rec.external_id, url: rec.url || null,
    last_seen_at: now, last_run_id: runId || null,
    seen_count: (existingItem?.seen_count || 0) + 1,
    first_seen_at: existingItem?.first_seen_at || now, first_run_id: existingItem?.first_run_id || runId || null,
    content_hash: rec.content_hash || existingItem?.content_hash || null,
  };
  if (rec.seen_only || rec.kind === 'calendar_document' || rec.kind === 'notice_link') {
    const parsed = rec.kind === 'notice_link' ? { title: rec.title, kind: rec.kind } : rec.kind === 'calendar_document' ? { rows: rec.rows, kind: rec.kind } : (existingItem?.parsed || {});
    await db.upsertSourceItem({ ...baseItem, parsed, property_id: existingItem?.property_id || null, event_id: existingItem?.event_id || null });
    return { isNew: !existingItem, updated: !!existingItem };
  }
  if (rec.kind === 'notice_document') return ingestNoticeDocument(env, rec, runId, stats, baseItem);
  if (rec.kind === 'foreclosure_notice') return ingestForeclosure(env, rec, runId, stats, baseItem, existingItem);
  if (rec.kind === 'eviction_case') return ingestEviction(env, rec, runId, stats, baseItem, existingItem);
  throw new Error(`permanent: unknown record kind ${rec.kind}`);
}

async function ingestNoticeDocument(env, rec, runId, stats, baseItem) {
  const db = env.db;
  let notices = [];
  if (env.ai) {
    const out = await env.ai.extractNotices({ pdfBytes: rec.pdf_bytes, text: rec.text }, { sourceLabel: rec.title || rec.source_id, publicationDate: rec.publication_date });
    notices = out?.notices || [];
  } else if (rec.text) {
    notices = splitNotices(rec.text).map(t => ({ ...extractNoticeFields(t), excerpt: t.slice(0, 300), raw_text: t }));
  }
  await db.upsertSourceItem({ ...baseItem, parsed: { kind: 'notice_document', notices: notices.length, ai: !!env.ai } });
  let n = 0;
  for (const nt of notices) {
    n++;
    const sub = {
      ...nt, source_id: rec.source_id, external_id: `${rec.external_id}#${n}`, url: rec.url, kind: 'foreclosure_notice',
      county: nt.county || rec.county, publication_date: rec.publication_date, text: nt.raw_text || null,
      content_hash: contentHash(JSON.stringify([nt.property_address, nt.sale_date, nt.borrower_names])),
      evidence: [{ claim: 'Foreclosure notice published in the county legal organ', url: rec.url, excerpt: nt.excerpt || '' }],
    };
    try { await ingestForeclosure(env, sub, runId, stats, { ...baseItem, external_id: sub.external_id, content_hash: sub.content_hash, seen_count: 1, first_seen_at: baseItem.last_seen_at }, null); }
    catch (e) { (env.log || (() => {}))(`notice ${n} failed: ${e.message}`); }
  }
  return { isNew: true, updated: false, notices: notices.length };
}

async function findOrCreateProperty(env, rec, runId, stats) {
  const db = env.db;
  const county = rec.county;
  const addr = rec.property_address || rec.address_raw || null;
  const parsed = addr ? parseAddress([addr, rec.city, rec.zip].filter(Boolean).join(', ')) : null;
  const parcelNorm = normalizeParcel(rec.parcel_id);
  const communityKey = rec.community_name ? nameKey(rec.community_name) : null;
  const candidates = await db.propertyCandidates(county, { parcelNorm, addressNorm: parsed?.norm, communityKey });
  const { match, how } = findPropertyMatch(candidates, { county, parcel_id: rec.parcel_id, address_norm: parsed?.norm, address_raw: addr, community_name: rec.community_name });
  const now = new Date().toISOString();
  if (match) {
    const patch = mergeFields(match, {
      address_raw: addr, address_norm: parsed?.norm, street_number: parsed?.number, street_name: parsed?.street, unit: parsed?.unit,
      city: parsed?.city || rec.city, zip: parsed?.zip || rec.zip, parcel_id: rec.parcel_id, parcel_id_norm: parcelNorm,
    }, ['address_raw', 'address_norm', 'street_number', 'street_name', 'unit', 'city', 'zip', 'parcel_id', 'parcel_id_norm']);
    patch.last_seen_at = now; patch.last_run_id = runId || match.last_run_id;
    const updated = await db.updateProperty(match.id, patch);
    stats.updated_properties = (stats.updated_properties || 0) + 1;
    return { property: updated, isNew: false, how };
  }
  const row = {
    county, address_raw: addr, address_norm: parsed?.norm || null, street_number: parsed?.number || null, street_name: parsed?.street || null,
    unit: parsed?.unit || null, city: parsed?.city || rec.city || null, zip: parsed?.zip || rec.zip || null,
    parcel_id: rec.parcel_id || null, parcel_id_norm: parcelNorm, legal_description: communityKey && !parsed ? 'community:' + communityKey : (rec.legal_description || null),
    property_type: communityKey ? 'multifamily' : (rec.property_type || 'unknown'),
    lead_type: rec.kind === 'eviction_case' ? 'eviction' : 'foreclosure',
    first_seen_at: now, last_seen_at: now, first_run_id: runId || null, last_run_id: runId || null,
    enrichment_status: 'pending',
  };
  const property = await db.insertProperty(row);
  stats.new_properties = (stats.new_properties || 0) + 1;
  return { property, isNew: true, how: 'created' };
}

async function ensureCompany(env, name, defaults = {}) {
  if (!name || cleanName(name).length < 2) return null;
  const clean = cleanName(name);
  const existing = await env.db.companyByName(clean);
  if (existing) return existing;
  const isIndividual = defaults.is_individual ?? !looksLikeEntity(clean);
  return env.db.insertCompany({ name: clean, company_type: defaults.company_type || (isIndividual ? 'individual' : guessCompanyType(clean)), is_individual: isIndividual, research_status: isIndividual ? 'skipped' : 'unresearched', ...(defaults.extra || {}) });
}

export function guessCompanyType(name) {
  const n = String(name || '').toUpperCase();
  if (/PROPERTY MANAG|MGMT|MANAGEMENT|REALTY SERVICES|PROPERTY MANAGERS/.test(n)) return 'property_management';
  if (/APARTMENT|APTS|COMMUNITIES|MULTIFAMILY/.test(n)) return 'multifamily_operator';
  if (/PROGRESS RESIDENTIAL|INVITATION HOMES|AMERICAN HOMES 4 RENT|AMH |TRICON|FIRSTKEY|MAIN STREET RENEWAL|PATHWAY HOMES|SFR |RENTAL HOMES|HOMES 4 RENT|HOME PARTNERS|VINEBROOK|AMHERST/.test(n)) return 'sfr_operator';
  if (/BANK|N\.A\.|MORTGAGE|LENDING|CREDIT UNION|FINANCIAL|SAVINGS|FUNDING/.test(n)) return 'lender';
  if (/SERVICING|LOAN SERVICES/.test(n)) return 'servicer';
  if (/LLP|LAW|ATTORNEY|P\.C\.|PLLC|LEGAL/.test(n)) return 'law_firm';
  if (/HOUSING AUTHORITY|COUNTY|CITY OF|STATE OF|HUD|UNITED STATES/.test(n)) return 'government';
  if (/CHURCH|MINISTR|FOUNDATION|NONPROFIT/.test(n)) return 'nonprofit';
  if (/TRUST|FUND|CAPITAL|INVESTMENT|EQUITY|PARTNERS|HOLDINGS|VENTURES|ACQUISITION/.test(n)) return 'institutional_investor';
  if (/REIT/.test(n)) return 'reit';
  if (/LLC|INC|CORP|LP|L\.P\.|LTD|COMPANY|PROPERTIES/.test(n)) return 'owner_entity';
  return 'unknown';
}

async function link(env, propertyId, company, relationship, evidence, url, confidence = 'medium') {
  if (!company) return;
  await env.db.upsertRelationship({ property_id: propertyId, company_id: company.id, relationship, evidence: evidence || null, source_url: url || null, confidence });
}

async function ingestForeclosure(env, rec, runId, stats, baseItem, existingItem) {
  const db = env.db;
  const today = (env.now ? env.now() : new Date()).toISOString().slice(0, 10);
  const hasLocator = !!(rec.property_address || rec.address_raw || rec.parcel_id);
  if (!hasLocator && !rec.county) {
    await db.upsertSourceItem({ ...baseItem, parsed: { ...stripHeavy(rec), unmatched: 'no address/parcel/county' } });
    stats.unmatched = (stats.unmatched || 0) + 1;
    return { isNew: !existingItem, updated: false };
  }
  if (!hasLocator) {
    // Try the AI extractor for address when the deterministic parser found none.
    if (env.ai && (rec.text || rec.pdf_bytes)) {
      try {
        const out = await env.ai.extractNotices({ pdfBytes: rec.pdf_bytes, text: rec.text }, { sourceLabel: rec.source_id, publicationDate: rec.publication_date });
        const n = out?.notices?.[0];
        if (n) Object.assign(rec, Object.fromEntries(Object.entries(n).filter(([k, v]) => v != null && (rec[k] == null || rec[k] === ''))));
      } catch (e) { (env.log || (() => {}))('ai notice extraction failed: ' + e.message); }
    }
    if (!(rec.property_address || rec.parcel_id)) {
      await db.upsertSourceItem({ ...baseItem, parsed: { ...stripHeavy(rec), unmatched: 'no property address or parcel in notice' } });
      stats.unmatched = (stats.unmatched || 0) + 1;
      return { isNew: !existingItem, updated: false };
    }
  }
  rec.county = rec.county || detectCounty(rec.text || '') || null;
  if (!rec.county) { stats.unmatched = (stats.unmatched || 0) + 1; await db.upsertSourceItem({ ...baseItem, parsed: { ...stripHeavy(rec), unmatched: 'county unknown' } }); return { isNew: !existingItem, updated: false }; }
  if (rec.notice_type === 'cancellation') rec.stage = 'sale_cancelled';

  const { property, isNew } = await findOrCreateProperty(env, rec, runId, stats);
  const events = await db.eventsForProperty(property.id);
  const incoming = {
    event_type: 'foreclosure', foreclosure_identifier: rec.foreclosure_identifier || null, sale_date: rec.sale_date || null, publication_date: rec.publication_date || null,
  };
  const { match } = matchForeclosureEvent(events, incoming);
  const stage = rec.stage || classifyForeclosureStage(rec.sale_date, today);
  const now = new Date().toISOString();
  let event, eventNew = false;
  if (match) {
    const patch = mergeFields(match, { lender: rec.lender, secured_party: rec.secured_party, foreclosing_entity: rec.foreclosing_entity, servicer: rec.servicer, law_firm: rec.law_firm, borrower_names: rec.borrower_names, foreclosure_identifier: rec.foreclosure_identifier, raw_excerpt: (rec.text || rec.excerpt || '').slice(0, 1500), source_url: rec.url }, ['lender', 'secured_party', 'foreclosing_entity', 'servicer', 'law_firm', 'borrower_names', 'foreclosure_identifier', 'raw_excerpt', 'source_url']);
    patch.last_detected_at = now;
    const sameItem = existingItem && existingItem.event_id === match.id;
    if (!sameItem) patch.publication_count = (match.publication_count || 1) + 1;
    if (rec.sale_date && rec.sale_date !== match.sale_date) { patch.sale_date = rec.sale_date; patch.details = { ...(match.details || {}), previous_sale_date: match.sale_date }; }
    if (shouldAdvance(match.stage, stage, rec.source === 'manual' ? 'manual' : 'auto') || (stage === 'sale_cancelled')) {
      patch.stage = stage; patch.status = stage === 'sale_cancelled' || stage === 'sale_completed' ? 'closed' : 'active';
      await db.insertHistory({ event_id: match.id, from_stage: match.stage, to_stage: stage, source_id: rec.source_id, source_url: rec.url, run_id: runId || null, note: 'republication / date change' });
      stats.advanced = (stats.advanced || 0) + 1;
    }
    event = await db.updateEvent(match.id, patch);
  } else {
    event = await db.insertEvent({
      property_id: property.id, county: rec.county, event_type: 'foreclosure', stage,
      foreclosure_identifier: rec.foreclosure_identifier || null, publication_date: rec.publication_date || null, sale_date: rec.sale_date || null,
      lender: rec.lender || null, secured_party: rec.secured_party || null, foreclosing_entity: rec.foreclosing_entity || null, servicer: rec.servicer || null,
      law_firm: rec.law_firm || null, borrower_names: rec.borrower_names || null, source_id: rec.source_id, source_url: rec.url || null,
      raw_excerpt: (rec.text || rec.excerpt || '').slice(0, 1500), details: { notice_type: rec.notice_type || null, legal_description: rec.legal_description || null },
      status: stage === 'sale_cancelled' || stage === 'sale_completed' ? 'closed' : 'active', first_detected_at: now, last_detected_at: now,
    });
    eventNew = true;
    stats.new_events = (stats.new_events || 0) + 1;
    await db.insertHistory({ event_id: event.id, from_stage: null, to_stage: stage, source_id: rec.source_id, source_url: rec.url, run_id: runId || null, note: 'first detected' });
  }
  await db.upsertSourceItem({ ...baseItem, parsed: stripHeavy(rec), property_id: property.id, event_id: event.id });
  // Parties → companies (never targets for law firms / lenders unless post-sale)
  const borrowerIsEntity = rec.borrower_names ? looksLikeEntity(rec.borrower_names) : false;
  if (borrowerIsEntity) {
    const c = await ensureCompany(env, rec.borrower_names, { company_type: guessCompanyType(rec.borrower_names) });
    await link(env, property.id, c, 'owner', 'Named as grantor/borrower in the foreclosure notice', rec.url, 'medium');
  }
  for (const [field, rel, type] of [['servicer', 'servicer', 'servicer'], ['foreclosing_entity', 'foreclosing_entity', 'lender'], ['secured_party', 'lender', 'lender'], ['lender', 'lender', 'lender'], ['law_firm', 'law_firm', 'law_firm']]) {
    if (rec[field]) {
      const c = await ensureCompany(env, rec[field], { company_type: field === 'law_firm' ? 'law_firm' : guessCompanyType(rec[field]) === 'servicer' ? 'servicer' : type, is_individual: false });
      await link(env, property.id, c, rel, `Named as ${field.replace('_', ' ')} in the foreclosure notice`, rec.url, 'high');
    }
  }
  await db.insertEvidence((rec.evidence || []).map(ev => ({ subject_type: 'event', subject_id: event.id, claim: ev.claim, source_id: rec.source_id, source_url: ev.url || rec.url, excerpt: (ev.excerpt || '').slice(0, 600), confidence: 'high', run_id: runId || null })));
  await queueEnrichment(env, property, runId, { plaintiffIsEntity: borrowerIsEntity, hasAddress: !!property.address_norm, stage });
  return { isNew, updated: !isNew, propertyId: property.id, eventId: event.id, eventNew };
}

async function ingestEviction(env, rec, runId, stats, baseItem, existingItem) {
  const db = env.db;
  const now = new Date().toISOString();
  const existingEvent = rec.case_number ? await db.eventByCase(rec.county, rec.case_number) : null;
  let property;
  let isNew = false;
  if (existingEvent) {
    property = await db.getProperty(existingEvent.property_id);
    if (rec.property_address && !property.address_norm) {
      const p = parseAddress([rec.property_address, rec.city, rec.zip].filter(Boolean).join(', '));
      if (p) property = await db.updateProperty(property.id, { address_raw: rec.property_address, address_norm: p.norm, street_number: p.number, street_name: p.street, unit: p.unit, city: p.city || rec.city || null, zip: p.zip || rec.zip || null, last_seen_at: now, last_run_id: runId || null });
    } else property = await db.updateProperty(property.id, { last_seen_at: now, last_run_id: runId || null });
    stats.updated_properties = (stats.updated_properties || 0) + 1;
  } else {
    const r = await findOrCreateProperty(env, { ...rec, property_address: rec.property_address || null, kind: 'eviction_case' }, runId, stats);
    property = r.property; isNew = r.isNew;
    if (!isNew && property.lead_type === 'foreclosure') await db.updateProperty(property.id, { lead_type: 'both' });
  }
  const incomingStage = rec.stage || (rec.status_text ? classifyEvictionText(rec.status_text)?.stage : null) || 'dispossessory_filed';
  const dates = {
    filed_date: rec.filed_date || null, hearing_date: rec.hearing_date || null, judgment_date: rec.judgment_date || null,
    writ_date: rec.writ_date || null, execution_date: rec.execution_date || null,
  };
  const source = rec.source === 'manual' ? 'manual' : 'auto';
  let event;
  if (existingEvent) {
    const patch = mergeFields(existingEvent, { ...dates, plaintiff_name: rec.plaintiff_name, law_firm: rec.plaintiff_attorney, source_url: rec.url }, ['filed_date', 'hearing_date', 'judgment_date', 'writ_date', 'execution_date', 'plaintiff_name', 'law_firm', 'source_url']);
    if (rec.hearing_date && rec.hearing_date !== existingEvent.hearing_date && rec.hearing_date > (existingEvent.hearing_date || '')) patch.hearing_date = rec.hearing_date;
    patch.last_detected_at = now;
    patch.details = { ...(existingEvent.details || {}), ...(rec.details || {}) };
    if (shouldAdvance(existingEvent.stage, incomingStage, source)) {
      patch.stage = incomingStage;
      patch.status = ['dismissed', 'possession_returned'].includes(incomingStage) ? 'closed' : 'active';
      await db.insertHistory({ event_id: existingEvent.id, from_stage: existingEvent.stage, to_stage: incomingStage, source_id: rec.source_id, source_url: rec.url, run_id: runId || null, note: rec.status_text || null });
      stats.advanced = (stats.advanced || 0) + 1;
      if (isTurnoverStage(incomingStage) && !isTurnoverStage(existingEvent.stage)) stats.high_priority = (stats.high_priority || 0) + 1;
    }
    event = await db.updateEvent(existingEvent.id, patch);
  } else {
    event = await db.insertEvent({
      property_id: property.id, county: rec.county, event_type: 'eviction', stage: incomingStage, case_number: rec.case_number || null,
      plaintiff_name: rec.plaintiff_name || null, law_firm: rec.plaintiff_attorney || null, ...dates,
      source_id: rec.source_id, source_url: rec.url || null, details: rec.details || {}, raw_excerpt: rec.status_text || null,
      status: ['dismissed', 'possession_returned'].includes(incomingStage) ? 'closed' : 'active', first_detected_at: now, last_detected_at: now,
    });
    stats.new_events = (stats.new_events || 0) + 1;
    if (isTurnoverStage(incomingStage)) stats.high_priority = (stats.high_priority || 0) + 1;
    await db.insertHistory({ event_id: event.id, from_stage: null, to_stage: incomingStage, source_id: rec.source_id, source_url: rec.url, run_id: runId || null, note: rec.status_text || 'first detected' });
  }
  await db.upsertSourceItem({ ...baseItem, parsed: stripHeavy(rec), property_id: property.id, event_id: event.id });
  const plaintiffIsEntity = rec.plaintiff_is_entity ?? looksLikeEntity(rec.plaintiff_name);
  if (rec.plaintiff_name) {
    const c = await ensureCompany(env, rec.plaintiff_name, { is_individual: !plaintiffIsEntity });
    await link(env, property.id, c, 'plaintiff', `Plaintiff in dispossessory case ${rec.case_number || ''}`.trim(), rec.url, 'high');
    if (c && !c.is_individual && ['property_management'].includes(c.company_type)) await link(env, property.id, c, 'manager', 'Management company filed the dispossessory action', rec.url, 'medium');
  }
  if (rec.plaintiff_attorney) {
    const lf = await ensureCompany(env, rec.plaintiff_attorney, { company_type: 'law_firm', is_individual: false });
    await link(env, property.id, lf, 'law_firm', 'Plaintiff attorney of record', rec.url, 'high');
  }
  await db.insertEvidence((rec.evidence || []).map(ev => ({ subject_type: 'event', subject_id: event.id, claim: ev.claim, source_id: rec.source_id, source_url: ev.url || rec.url, excerpt: (ev.excerpt || '').slice(0, 600), confidence: 'high', run_id: runId || null })));
  await queueEnrichment(env, property, runId, { plaintiffIsEntity, hasAddress: !!property.address_norm, stage: event.stage });
  return { isNew, updated: !isNew, propertyId: property.id, eventId: event.id };
}

function stripHeavy(rec) {
  const { pdf_bytes, text, raw_text, evidence, ...rest } = rec;
  return { ...rest, text_excerpt: text ? String(text).slice(0, 600) : null };
}

async function queueEnrichment(env, property, runId, flags) {
  const db = env.db;
  const prio = enrichmentPriority({ stage: flags.stage, propertyType: property.property_type, ownerIsEntity: !!property.owner_company_id, plaintiffIsEntity: flags.plaintiffIsEntity, hasAddress: flags.hasAddress });
  await db.updateProperty(property.id, { enrichment_priority: prio, enrichment_status: property.enrichment_status === 'done' ? 'done' : 'queued' });
  if (property.address_norm && !property.owner_verified_at) {
    // Ownership lookup first; it queues company research itself once the owner is known.
    await db.enqueue(runId, 'enrich.ownership', { property_id: property.id }, PRIORITY['enrich.ownership'] + Math.max(0, 40 - prio));
  } else {
    // No parcel to look up (community-level eviction, or owner already verified):
    // research the known parties (cached per company), then score.
    await queueCompanyResearch(env, property.id, runId);
    await db.enqueue(runId, 'score', { property_id: property.id }, PRIORITY.score);
  }
}

// ---------------------------------------------------------------- uploads (human-assisted ingestion)

export async function ingestUpload(env, uploadId, runId) {
  const db = env.db;
  const up = await db.getUpload(uploadId);
  if (!up) throw new Error('permanent: upload not found');
  await db.updateUpload(uploadId, { status: 'processing' });
  const stats = {};
  const sourceId = 'upload:' + (up.source_label ? nameKey(up.source_label).slice(0, 40) : up.kind);
  const bytes = up.content_b64 ? base64ToBytes(up.content_b64) : null;
  const isPdf = bytes && bytes[0] === 0x25 && bytes[1] === 0x50;
  const text = bytes && !isPdf ? new TextDecoder().decode(bytes) : null;
  let n = 0, errors = [];
  try {
    if (up.kind === 'manual_case') {
      const p = up.payload || {};
      const stage = p.stage || classifyEvictionText(p.status_text || '')?.stage || 'status_unknown';
      const rec = {
        source_id: sourceId, external_id: p.case_number ? 'case:' + p.case_number : 'manual:' + uploadId, url: p.source_url || null, kind: p.lead_type === 'foreclosure' ? 'foreclosure_notice' : 'eviction_case',
        county: up.county || p.county, case_number: p.case_number || null, plaintiff_name: p.plaintiff_name || null, property_address: p.address || null, city: p.city || null, zip: p.zip || null,
        parcel_id: p.parcel_id || null, stage: p.lead_type === 'foreclosure' ? (p.stage || null) : stage, source: 'manual', status_text: p.status_text || null,
        sale_date: p.sale_date || null, hearing_date: p.hearing_date || null, writ_date: p.writ_date || null, execution_date: p.execution_date || null, judgment_date: p.judgment_date || null, filed_date: p.filed_date || null,
        lender: p.lender || null, servicer: p.servicer || null, law_firm: p.law_firm || null, community_name: p.community_name || null,
        evidence: [{ claim: p.note || 'Entered manually by a Bridgeway team member', url: p.source_url || null, excerpt: p.status_text || '' }],
      };
      await ingestRecord(env, rec, runId, stats); n = 1;
    } else if (up.kind === 'eviction_list') {
      const rows = text && /,/.test(text.split('\n')[0] || '') ? parseCsv(text) : (env.ai ? (await env.ai.extractEvictionList({ pdfBytes: isPdf ? bytes : null, text }, { county: up.county, sourceLabel: up.source_label })).rows : []);
      if (!rows.length && !env.ai) throw new Error('permanent: PDF eviction lists need the AI extractor (Anthropic API key not configured); upload a CSV instead');
      for (const r of rows) {
        const stage = r.stage || classifyEvictionText(r.status_text || r.status || '')?.stage || (up.payload?.default_stage || 'writ_issued');
        const rec = {
          source_id: sourceId, external_id: r.case_number ? 'case:' + r.case_number : 'row:' + contentHash(JSON.stringify(r)), url: up.payload?.source_url || null, kind: 'eviction_case',
          county: r.county || up.county, case_number: r.case_number || null, plaintiff_name: r.plaintiff_name || r.plaintiff || r.landlord || null, property_address: r.address || r.property_address || null, city: r.city || null, zip: r.zip || null,
          stage, source: 'manual', status_text: r.status_text || r.status || null, execution_date: r.execution_date || r.date || null, writ_date: r.writ_date || null, community_name: r.community_name || null,
          plaintiff_is_entity: r.plaintiff_name || r.plaintiff ? looksLikeEntity(r.plaintiff_name || r.plaintiff) : undefined,
          evidence: [{ claim: `Listed in "${up.source_label || up.filename || 'uploaded list'}" (${up.kind}) uploaded by a Bridgeway team member`, url: up.payload?.source_url || null, excerpt: (r.status_text || r.status || '').slice(0, 200) }],
        };
        try { await ingestRecord(env, rec, runId, stats); n++; } catch (e) { errors.push(`${rec.external_id}: ${e.message}`); }
      }
    } else if (up.kind === 'notice_pdf' || up.kind === 'csv') {
      let notices = [];
      if (up.kind === 'csv') notices = parseCsv(text || '');
      else if (env.ai) notices = (await env.ai.extractNotices({ pdfBytes: isPdf ? bytes : null, text }, { sourceLabel: up.source_label || up.filename, publicationDate: up.payload?.publication_date })).notices || [];
      else if (text) notices = splitNotices(text).map(t => ({ ...extractNoticeFields(t), excerpt: t.slice(0, 300), raw_text: t }));
      else throw new Error('permanent: PDF notices need the AI extractor (Anthropic API key not configured); upload text or CSV instead');
      let i = 0;
      for (const nt of notices) {
        i++;
        const rec = {
          ...nt, source_id: sourceId, external_id: `${uploadId}#${i}`, url: up.payload?.source_url || null, kind: 'foreclosure_notice', source: 'manual',
          county: nt.county || up.county, publication_date: nt.publication_date || up.payload?.publication_date || null, text: nt.raw_text || null,
          content_hash: contentHash(JSON.stringify([nt.property_address, nt.sale_date])),
          evidence: [{ claim: `Foreclosure notice from "${up.source_label || up.filename || 'uploaded document'}" uploaded by a Bridgeway team member`, url: up.payload?.source_url || null, excerpt: nt.excerpt || '' }],
        };
        try { await ingestRecord(env, rec, runId, stats); n++; } catch (e) { errors.push(`notice ${i}: ${e.message}`); }
      }
    } else throw new Error('permanent: unknown upload kind');
    await db.updateUpload(uploadId, { status: 'done', processed_at: new Date().toISOString(), result: { ingested: n, errors, ...stats } });
  } catch (e) {
    await db.updateUpload(uploadId, { status: 'failed', processed_at: new Date().toISOString(), result: { ingested: n, errors: [...errors, e.message] } });
    throw e;
  }
  if (runId) { for (const k of Object.keys(stats)) await bumpRunCount(env, runId, k, stats[k]); }
}

function base64ToBytes(b64) {
  const bin = atob(b64.replace(/^data:[^,]+,/, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Tiny CSV → array of objects keyed by normalized header. */
export function parseCsv(text) {
  const rows = []; let row = [], field = '', q = false;
  const s = String(text || '').replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; continue; }
    if (c === '"') q = true; else if (c === ',') { row.push(field); field = ''; } else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; } else if (c !== '\r') field += c;
  }
  row.push(field); rows.push(row);
  const clean = rows.filter(r => r.some(f => f.trim() !== ''));
  if (clean.length < 2) return [];
  const headers = clean[0].map(h => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''));
  return clean.slice(1).map(r => Object.fromEntries(headers.map((h, i) => [h, (r[i] || '').trim() || null])));
}

// ---------------------------------------------------------------- ownership enrichment

export async function enrichOwnership(env, propertyId, runId) {
  const db = env.db;
  const p = await db.getProperty(propertyId);
  if (!p) return;
  const url = buildQueryUrl(p.county, p.parcel_id ? { parcelId: p.parcel_id } : { address: [p.address_raw, p.city].filter(Boolean).join(', ') });
  let record = null, confidence = null, error = null;
  if (url) {
    const res = await env.http.get(url, { accept: 'application/json' });
    if (res.ok && res.text) {
      let json = null;
      try { json = JSON.parse(res.text); } catch { error = 'invalid JSON from GIS'; }
      if (json && json.error) error = json.error.message || 'GIS error';
      else if (json) ({ record, confidence } = pickFeature(p.county, json.features || [], p.address_raw || ''));
    } else error = `GIS HTTP ${res.status}`;
  } else error = 'no address number to query';
  const svc = PARCEL_SERVICES[p.county];
  const patch = { last_researched_at: new Date().toISOString() };
  if (record) {
    const owner = interpretOwner(record);
    if (record.parcel_id && !p.parcel_id) { patch.parcel_id = record.parcel_id; patch.parcel_id_norm = normalizeParcel(record.parcel_id); }
    if (record.city && !p.city) patch.city = String(record.city).replace(/,?\s*GA.*$/i, '').trim();
    if (record.zip && !p.zip) patch.zip = String(record.zip).slice(0, 5);
    const ptype = propertyTypeFrom(record, p.property_type);
    if (ptype !== 'unknown' && p.property_type === 'unknown') patch.property_type = ptype;
    if (owner) {
      patch.owner_name = owner.name; patch.owner_mailing_address = owner.mailing; patch.owner_source = svc.sourceLabel; patch.owner_source_url = url; patch.owner_verified_at = new Date().toISOString();
      if (owner.isEntity) {
        const c = await ensureCompany(env, owner.name, { company_type: guessCompanyType(owner.name), is_individual: false, extra: { hq_address: owner.mailing || null } });
        if (c) { patch.owner_company_id = c.id; await link(env, p.id, c, 'owner', `Owner of record per ${svc.sourceLabel}`, url, confidence || 'medium'); }
      } else {
        const c = await ensureCompany(env, owner.name, { is_individual: true, company_type: 'individual' });
        if (c) { patch.owner_company_id = c.id; await link(env, p.id, c, 'owner', `Owner of record (individual) per ${svc.sourceLabel}`, url, confidence || 'medium'); }
      }
      await db.insertEvidence([{ subject_type: 'property', subject_id: p.id, claim: `Owner of record is ${owner.name}${owner.mailing ? ' (mailing: ' + owner.mailing + ')' : ''}`, source_id: 'gis:' + p.county.toLowerCase(), source_url: url, excerpt: JSON.stringify(record).slice(0, 600), confidence: confidence || 'medium', run_id: runId || null }]);
    } else if (record.qpublic_url) {
      patch.owner_source = svc.sourceLabel; patch.owner_source_url = String(record.qpublic_url).replace(/.*href="([^"]+)".*/, '$1');
      await db.insertEvidence([{ subject_type: 'property', subject_id: p.id, claim: `Parcel ${record.parcel_id} matched in Henry County GIS; owner name must be read on qPublic`, source_id: 'gis:henry', source_url: patch.owner_source_url, excerpt: JSON.stringify(record).slice(0, 400), confidence: confidence || 'medium', run_id: runId || null }]);
    }
    patch.enrichment_status = 'partial';
  } else {
    patch.enrichment_status = 'partial';
    await db.insertEvidence([{ subject_type: 'property', subject_id: p.id, claim: `Owner lookup did not find a parcel match (${error || 'no match'})`, source_id: 'gis:' + p.county.toLowerCase(), source_url: url, excerpt: null, confidence: 'low', run_id: runId || null }]);
  }
  await db.updateProperty(p.id, patch);
  await queueCompanyResearch(env, p.id, runId);
  await db.enqueue(runId, 'score', { property_id: p.id }, PRIORITY.score);
}

/** Queue company research for the entities tied to a property, within the per-run budget. */
async function queueCompanyResearch(env, propertyId, runId) {
  const db = env.db;
  if (!env.ai) return;
  const settings = await db.settings();
  const budget = parseInt(settings.max_company_research_per_run || '20', 10);
  const run = runId ? await db.getRun(runId) : null;
  const used = run?.counts?.company_research_queued || 0;
  const refreshDays = parseInt(settings.company_refresh_days || '90', 10);
  const rels = await db.relationshipsForProperty(propertyId);
  const p = await db.getProperty(propertyId);
  let queued = 0;
  for (const r of rels) {
    const c = r.company;
    if (!c || c.is_individual || ['law_firm', 'government', 'individual'].includes(c.company_type)) continue;
    if (!['owner', 'manager', 'plaintiff', 'investor', 'parent', 'servicer', 'purchaser'].includes(r.relationship)) continue;
    if (['servicer'].includes(r.relationship) && !['sale_completed', 'sale_imminent'].includes(p.current_stage)) continue;
    const fresh = c.research_status === 'researched' && c.researched_at && (Date.now() - new Date(c.researched_at).getTime()) < refreshDays * 86400000;
    if (fresh || c.research_status === 'queued') continue;
    if (used + queued >= budget) break;
    await db.updateCompany(c.id, { research_status: 'queued' });
    await db.enqueue(runId, 'enrich.company', { company_id: c.id, context: { county: p.county, role: r.relationship, communityName: p.legal_description?.startsWith('community:') ? p.address_raw : null, propertyAddress: p.address_norm ? p.address_raw : null } }, PRIORITY['enrich.company']);
    queued++;
  }
  if (queued) await bumpRunCount(env, runId, 'company_research_queued', queued);
}

// ---------------------------------------------------------------- company research (cached)

export async function enrichCompany(env, companyId, context, runId) {
  const db = env.db;
  const c = await db.getCompany(companyId);
  if (!c) return;
  if (!env.ai) { await db.updateCompany(c.id, { research_status: 'unresearched' }); return; }
  const settings = await db.settings();
  const refreshDays = parseInt(settings.company_refresh_days || '90', 10);
  if (c.research_status === 'researched' && c.researched_at && (Date.now() - new Date(c.researched_at).getTime()) < refreshDays * 86400000) return;
  const related = await db.relationshipsForCompany(c.id);
  let out;
  try {
    out = await env.ai.researchCompany(c.name, { ...context, otherProperties: Math.max(0, related.length - 1) });
  } catch (e) {
    await db.updateCompany(c.id, { research_status: 'failed', confidence_reason: 'Research failed: ' + String(e.message).slice(0, 300) });
    throw e;
  }
  if (!out) { await db.updateCompany(c.id, { research_status: 'failed', confidence_reason: 'Research returned no data' }); return; }
  const now = new Date().toISOString();
  const patch = {
    research_status: 'researched', researched_at: now, last_verified_at: now,
    refresh_after: new Date(Date.now() + refreshDays * 86400000).toISOString(),
    confidence: out.confidence || 'low', confidence_reason: out.confidence_reason || null,
    research_summary: out.summary || null, sources: Array.isArray(out.sources) ? out.sources.slice(0, 25) : [],
    is_individual: !!out.is_individual,
  };
  if (out.is_individual) { patch.company_type = 'individual'; patch.research_status = 'skipped'; }
  else if (out.company_type && out.company_type !== 'unknown' && (c.company_type === 'unknown' || c.company_type === 'owner_entity' || c.company_type === 'other')) patch.company_type = out.company_type;
  for (const [k, v] of Object.entries({ website: out.website, main_phone: out.main_phone, main_email: out.main_email, contact_page_url: out.contact_page_url, hq_address: out.hq_address, portfolio_notes: out.portfolio_notes, sos_control_number: out.sos_control_number, registered_agent: out.registered_agent })) {
    if (v && (!c[k] || c[k] === '')) patch[k] = String(v).slice(0, 500);
  }
  await db.updateCompany(c.id, patch);
  // Contacts: business-side only; emails only when the model cites a page.
  const contacts = (out.contacts || []).filter(ct => ct && (ct.name || ct.phone || ct.email) && ct.source_url).map((ct, i) => ({
    name: ct.name || null, title: ct.title || null, role_category: roleFromTitle(ct.title), email: ct.email || null, phone: ct.phone || null,
    phone_type: ct.phone_type || null, profile_url: ct.profile_url || null, source_url: ct.source_url || null, evidence: (ct.evidence || '').slice(0, 800),
    confidence: ['high', 'medium', 'low'].includes(ct.confidence) ? ct.confidence : 'low', confidence_reason: ct.evidence ? ct.evidence.slice(0, 300) : null, is_primary: i === 0,
  })).slice(0, 8);
  if (!out.is_individual) await db.replaceAutoContacts(c.id, contacts);
  await db.insertEvidence([{ subject_type: 'company', subject_id: c.id, claim: out.summary ? out.summary.slice(0, 400) : `Researched ${c.name}`, source_id: 'ai_research', source_url: (out.sources && out.sources[0] && out.sources[0].url) || null, excerpt: JSON.stringify((out.sources || []).slice(0, 5)).slice(0, 600), confidence: out.confidence || 'low', run_id: runId || null }]);
  // Related organizations discovered: manager / parent → new companies + relationships on every property tied to this one.
  const props = related.map(r => r.property_id);
  if (!out.is_individual && out.property_manager && nameKey(out.property_manager) !== c.name_key) {
    const pm = await ensureCompany(env, out.property_manager, { company_type: 'property_management', is_individual: false });
    for (const pid of props) { await link(env, pid, pm, 'manager', `Identified as the management company for ${c.name} (AI research)`, out.sources?.[0]?.url || null, out.confidence === 'high' ? 'medium' : 'low'); await db.updateProperty(pid, { manager_company_id: pm.id }); }
    await queueCompanyResearchForCompany(env, pm, runId, context);
  }
  if (!out.is_individual && out.parent_company && nameKey(out.parent_company) !== c.name_key) {
    const parent = await ensureCompany(env, out.parent_company, { company_type: 'institutional_investor', is_individual: false });
    await db.updateCompany(c.id, { parent_company_id: parent.id });
    for (const pid of props) { await link(env, pid, parent, 'parent', `Parent company of ${c.name} (AI research)`, out.sources?.[0]?.url || null, 'low'); await db.updateProperty(pid, { parent_company_id: parent.id }); }
  }
  if (out.property_address && context.communityName) {
    for (const pid of props) {
      const p = await db.getProperty(pid);
      if (p && !p.address_norm && p.legal_description === 'community:' + nameKey(context.communityName)) {
        const a = parseAddress(out.property_address);
        if (a) { await db.updateProperty(pid, { address_raw: out.property_address, address_norm: a.norm, street_number: a.number, street_name: a.street, city: a.city || null, zip: a.zip || null }); await db.enqueue(runId, 'enrich.ownership', { property_id: pid }, PRIORITY['enrich.ownership']); }
      }
    }
  }
  for (const pid of props) await db.enqueue(runId, 'score', { property_id: pid }, PRIORITY.score);
  await bumpRunCount(env, runId, 'contacts_enriched', contacts.length);
}

async function queueCompanyResearchForCompany(env, company, runId, context) {
  if (!company || company.is_individual || company.research_status === 'researched' || company.research_status === 'queued') return;
  const settings = await env.db.settings();
  const budget = parseInt(settings.max_company_research_per_run || '20', 10);
  const run = runId ? await env.db.getRun(runId) : null;
  if ((run?.counts?.company_research_queued || 0) >= budget) return;
  await env.db.updateCompany(company.id, { research_status: 'queued' });
  await env.db.enqueue(runId, 'enrich.company', { company_id: company.id, context: { county: context.county, role: 'manager' } }, PRIORITY['enrich.company']);
  await bumpRunCount(env, runId, 'company_research_queued', 1);
}

// ---------------------------------------------------------------- scoring

export async function scoreProperty(env, propertyId, runId) {
  const db = env.db;
  const p = await db.getProperty(propertyId);
  if (!p) return;
  const events = await db.eventsForProperty(p.id);
  const ev = events.find(e => e.status === 'active') || events[0] || null;
  const rels = await db.relationshipsForProperty(p.id);
  const today = (env.now ? env.now() : new Date()).toISOString().slice(0, 10);
  const companiesWithContacts = [];
  for (const r of rels) {
    if (!r.company) continue;
    const contacts = await db.contacts(r.company.id);
    const activeProperties = await db.activePropertyCountForCompany(r.company.id);
    companiesWithContacts.push({ relationship: r.relationship, confidence: r.confidence, company: { ...r.company, contacts, activeProperties } });
  }
  const target = chooseTarget({ eventType: ev?.event_type || p.lead_type, stage: ev?.stage, companies: companiesWithContacts });
  const owner = companiesWithContacts.find(x => x.relationship === 'owner');
  const manager = companiesWithContacts.find(x => x.relationship === 'manager');
  const investor = companiesWithContacts.find(x => x.relationship === 'investor' || x.relationship === 'parent');
  const ownerEvidence = rels.find(r => r.relationship === 'owner')?.confidence || null;
  const eventDate = stageEventDate(ev);
  const { score, breakdown } = scoreOpportunity({
    stage: ev?.stage, eventType: ev?.event_type || p.lead_type, eventDate, today, propertyType: p.property_type,
    owner: owner ? { name: owner.company.name, isEntity: !owner.company.is_individual, companyType: owner.company.company_type } : (p.owner_name ? { name: p.owner_name, isEntity: looksLikeEntity(p.owner_name), companyType: 'unknown' } : null),
    manager: manager ? { companyType: manager.company.company_type } : null,
    investor: investor ? { companyType: investor.company.company_type } : null,
    target: target.company ? { companyType: target.company.company_type, activeProperties: target.company.activeProperties, mainPhone: target.company.main_phone, mainEmail: target.company.main_email, website: target.company.website, hqAddress: target.company.hq_address } : null,
    contact: target.contact ? { confidence: target.contact.confidence, phone: target.contact.phone, email: target.contact.email, roleCategory: target.contact.role_category } : null,
    ownerEvidenceConfidence: ownerEvidence,
  });
  const explanation = buildExplanation({ p, ev, target, owner, manager, investor, breakdown });
  const evictionActive = events.some(e => e.event_type === 'eviction' && e.status === 'active');
  const foreclosureActive = events.some(e => e.event_type === 'foreclosure' && e.status === 'active');
  const leadType = evictionActive && foreclosureActive ? 'both' : evictionActive ? 'eviction' : foreclosureActive ? 'foreclosure' : (ev?.event_type || p.lead_type);
  const anyUnresearched = companiesWithContacts.some(x => !x.company.is_individual && ['owner', 'manager', 'plaintiff'].includes(x.relationship) && x.company.research_status !== 'researched' && x.company.research_status !== 'skipped');
  const enrichment = !p.owner_verified_at && p.address_norm ? 'partial' : anyUnresearched ? (env.ai ? 'partial' : 'partial') : 'done';
  const wasHigh = p.opportunity_score >= 70;
  await db.updateProperty(p.id, {
    opportunity_score: score, score_breakdown: breakdown, research_explanation: explanation,
    target_company_id: target.company ? target.company.id : null, target_contact_id: target.contact ? target.contact.id : null, target_reason: target.reason,
    owner_company_id: owner ? owner.company.id : p.owner_company_id, manager_company_id: manager ? manager.company.id : p.manager_company_id,
    investor_company_id: investor && investor.relationship === 'investor' ? investor.company.id : p.investor_company_id,
    parent_company_id: investor && investor.relationship === 'parent' ? investor.company.id : p.parent_company_id,
    current_stage: ev?.stage || p.current_stage, event_date: eventDate || p.event_date, lead_type: leadType, enrichment_status: enrichment,
  });
  if (!wasHigh && score >= 70) await bumpRunCount(env, runId, 'new_high_priority', 1);
}

function buildExplanation({ p, ev, target, owner, manager, investor, breakdown }) {
  const lines = [];
  if (ev) {
    if (ev.event_type === 'foreclosure') lines.push(`Turnover signal: foreclosure notice (${ev.stage.replace(/_/g, ' ')})${ev.sale_date ? ', sale ' + ev.sale_date : ''}${ev.publication_count > 1 ? ', published ' + ev.publication_count + ' times' : ''}.`);
    else lines.push(`Turnover signal: dispossessory case ${ev.case_number || ''} at stage "${ev.stage.replace(/_/g, ' ')}"${ev.hearing_date ? ', hearing ' + ev.hearing_date : ''}${ev.writ_date ? ', writ ' + ev.writ_date : ''}${ev.execution_date ? ', execution ' + ev.execution_date : ''}.`);
  }
  if (owner) lines.push(`Owner: ${owner.company.name} (${owner.company.is_individual ? 'individual' : owner.company.company_type.replace(/_/g, ' ')}; ${owner.confidence} confidence).`);
  else if (p.owner_name) lines.push(`Owner of record: ${p.owner_name}.`);
  if (manager) lines.push(`Manager: ${manager.company.name} (${manager.confidence} confidence).`);
  if (investor) lines.push(`${investor.relationship === 'parent' ? 'Parent' : 'Investor'}: ${investor.company.name}.`);
  if (target.company) lines.push(`Best target: ${target.company.name} — ${target.reason}.${target.contact ? ' Contact: ' + [target.contact.name, target.contact.title].filter(Boolean).join(', ') + ' (' + target.contact.confidence + ' confidence).' : ' No named contact yet.'}`);
  else lines.push(`Best target: not yet identified — ${target.reason}.`);
  lines.push('Score factors: ' + breakdown.map(b => `${b.factor} ${b.points > 0 ? '+' : ''}${b.points}${b.note ? ' (' + b.note + ')' : ''}`).join('; ') + '.');
  return lines.join('\n');
}
