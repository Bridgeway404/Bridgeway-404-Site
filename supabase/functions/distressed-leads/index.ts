// Distressed Property Leads — research worker (Supabase Edge Function).
//
// Invoked by the database (pg_cron → dpl_invoke_worker → pg_net) with a
// one-time token. The gateway already requires a valid project JWT; the
// worker additionally claims the token, so nobody can start work with the
// public anon key alone. It processes queued jobs for ~90 seconds, then
// re-invokes itself while work remains (the dpl_tick cron is the watchdog).
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';
import Anthropic from 'npm:@anthropic-ai/sdk';
import { extractText, getDocumentProxy } from 'npm:unpdf';
import { createDb } from './lib/db.js';
import { createHttp } from './lib/http.js';
import { SOURCES } from './lib/sources/index.js';
import { processJobs } from './lib/pipeline.js';
import { NOTICE_SCHEMA, NOTICE_SYSTEM, noticeUserPrompt, CALENDAR_SCHEMA, CALENDAR_SYSTEM, COMPANY_SCHEMA, COMPANY_SYSTEM, companyUserPrompt, parseJsonResponse, usageCost } from './lib/ai.js';
import { roleFromTitle } from './lib/target.js';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const TIME_BUDGET_MS = 90_000;

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
const db = createDb(supabase);
const log = (m: string) => console.log(`[dpl] ${m}`);

async function pdfExtract(bytes: Uint8Array): Promise<string> {
  const doc = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(doc, { mergePages: false });
  // Keep page breaks; unpdf returns one string per page.
  return (Array.isArray(text) ? text : [text]).join('\n\n');
}

function b64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)) as any);
  return btoa(s);
}

/** Claude-backed research helpers, or null when no key is configured. */
async function makeAi(settings: Record<string, string>) {
  const key = Deno.env.get('ANTHROPIC_API_KEY') || (await db.secret('anthropic_api_key'));
  if (!key) return null;
  const client = new Anthropic({ apiKey: key });
  const modelResearch = settings.ai_model_research || 'claude-opus-5';
  const modelExtract = settings.ai_model_extract || 'claude-sonnet-5';
  let spent = 0;

  async function structured(model: string, system: string, content: any[], schema: any, opts: { tools?: any[]; maxTokens?: number } = {}) {
    const res = await client.messages.create({
      model,
      max_tokens: opts.maxTokens || 16000,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content }],
      output_config: { format: { type: 'json_schema', schema } },
      ...(opts.tools ? { tools: opts.tools } : {}),
    } as any);
    spent += usageCost((res as any).usage, model);
    if ((res as any).stop_reason === 'refusal') throw new Error('model refused: ' + JSON.stringify((res as any).stop_details || {}));
    const parsed = parseJsonResponse(res as any);
    if (!parsed) throw new Error('model returned no JSON');
    return parsed;
  }

  return {
    get spent() { return spent; },
    async extractNotices(input: { pdfBytes?: Uint8Array | null; text?: string | null }, ctx: { sourceLabel: string; publicationDate?: string | null }) {
      const content: any[] = [];
      if (input.pdfBytes) content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64(input.pdfBytes) } });
      else if (input.text) content.push({ type: 'text', text: input.text.slice(0, 400_000) });
      else return { notices: [] };
      content.push({ type: 'text', text: noticeUserPrompt(ctx.sourceLabel, ctx.publicationDate || null) });
      return structured(modelExtract, NOTICE_SYSTEM, content, NOTICE_SCHEMA, { maxTokens: 32000 });
    },
    async extractCalendar(text: string, ctx: { county: string; hearingDate?: string | null }) {
      const out = await structured(modelExtract, CALENDAR_SYSTEM, [{ type: 'text', text: `County: ${ctx.county}. Hearing date if known: ${ctx.hearingDate || 'unknown'}.\n\n${text.slice(0, 200_000)}` }], CALENDAR_SCHEMA);
      return { header: { date: out.hearing_date || ctx.hearingDate || null }, rows: (out.rows || []).map((r: any) => ({ case_number: r.case_number, plaintiff_name: r.plaintiff_name, plaintiff_raw: r.plaintiff_name, community_name: r.community_name, plaintiff_attorney: r.plaintiff_attorney, hearing_time: r.hearing_time, filed_date: r.filed_date, hearing_date: out.hearing_date || ctx.hearingDate || null, plaintiff_is_entity: r.plaintiff_is_business })) };
    },
    async extractEvictionList(input: { pdfBytes?: Uint8Array | null; text?: string | null }, ctx: { county?: string | null; sourceLabel?: string | null }) {
      const content: any[] = [];
      if (input.pdfBytes) content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64(input.pdfBytes) } });
      else if (input.text) content.push({ type: 'text', text: input.text.slice(0, 200_000) });
      else return { rows: [] };
      content.push({ type: 'text', text: `This is an eviction / writ list for ${ctx.county || 'a metro Atlanta'} County (${ctx.sourceLabel || 'uploaded list'}). Extract each case: case number, plaintiff (landlord/agent), property address if printed, and the status text (e.g. "writ issued", "scheduled 9/12"). Never output tenant names.` });
      const schema = { type: 'object', additionalProperties: false, properties: { rows: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { case_number: { type: ['string', 'null'] }, plaintiff_name: { type: ['string', 'null'] }, address: { type: ['string', 'null'] }, city: { type: ['string', 'null'] }, zip: { type: ['string', 'null'] }, status_text: { type: ['string', 'null'] }, execution_date: { type: ['string', 'null'] }, writ_date: { type: ['string', 'null'] } }, required: ['case_number', 'plaintiff_name', 'address', 'city', 'zip', 'status_text', 'execution_date', 'writ_date'] } } }, required: ['rows'] };
      return structured(modelExtract, CALENDAR_SYSTEM, content, schema, { maxTokens: 32000 });
    },
    async researchCompany(name: string, context: any) {
      const out = await structured(modelResearch, COMPANY_SYSTEM, [{ type: 'text', text: companyUserPrompt({ name, context }) }], COMPANY_SCHEMA, {
        tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 8, user_location: { type: 'approximate', city: 'Atlanta', region: 'Georgia', country: 'US' } }],
        maxTokens: 16000,
      });
      if (out && Array.isArray(out.contacts)) out.contacts = out.contacts.map((c: any) => ({ ...c, role_category: roleFromTitle(c.title) }));
      return out;
    },
  };
}

async function runWorker(purpose: string) {
  const settings = await db.settings();
  const ai = await makeAi(settings);
  const http = createHttp({
    defaultIntervalMs: 4000,
    minIntervalMs: {
      'gismaps.fultoncountyga.gov': 800, 'dcgis.dekalbcountyga.gov': 800, 'maps.douglascountyga.gov': 800, 'arcgis.co.henry.ga.us': 800,
      'www.fultonneighbor.com': 12000, 'www.henryherald.com': 12000, 'www.douglascountysentinel.com': 12000,
      'dekalbcountymagistratecourt.com': 2500, 'www.magistratefulton.org': 2500, 'iframe.henrycountyga.gov': 2500, 'www.dekalblegalnotices.com': 5000,
    },
    log,
  });
  const result = await processJobs({ db, http, sources: SOURCES, ai, pdfExtract, log }, { timeBudgetMs: TIME_BUDGET_MS });
  log(`${purpose}: handled ${result.handled} jobs in ${result.elapsedMs}ms, ${result.remaining} remaining, http ${http.stats.requests} requests, ai $${ai ? ai.spent.toFixed(3) : '0 (no key)'}`);
  if (result.remaining > 0) {
    // Continue in a fresh invocation (new one-time token minted by the database).
    const { error } = await supabase.rpc('dpl_invoke_worker', { p_purpose: 'continue' });
    if (error) log('self-invoke failed: ' + error.message + ' (dpl_tick will resume within 5 minutes)');
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response(JSON.stringify({ ok: true, worker: 'distressed-leads' }), { headers: { 'content-type': 'application/json' } });
  let body: any = {};
  try { body = await req.json(); } catch { /* empty */ }
  const token = body?.token;
  if (!token || !(await db.claimInvocation(token))) {
    return new Response(JSON.stringify({ error: 'invalid or expired invocation token' }), { status: 401, headers: { 'content-type': 'application/json' } });
  }
  const purpose = String(body.purpose || 'run');
  // Respond immediately; the work continues as a background task.
  EdgeRuntime.waitUntil(runWorker(purpose).catch((e) => log('worker crashed: ' + (e?.stack || e))));
  return new Response(JSON.stringify({ accepted: true, purpose }), { status: 202, headers: { 'content-type': 'application/json' } });
});
