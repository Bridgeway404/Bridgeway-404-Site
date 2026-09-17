// Auction Buyer Leads — research worker (Supabase Edge Function).
//
// Invoked by the database (ab_request_run → ab_invoke_worker → pg_net) with a
// one-time token, either from the Wednesday pg_cron schedule (ab_scheduled_kick)
// or from "Find Auction Buyers Now" in the Admin panel. Both paths run the same
// pipeline (lib/pipeline.js): read the counties' public sale-result and sale
// lists, verify sales against assessor rolls, consolidate purchasers into one
// buyer each, score and promote them to the call list.
//
// The baseline needs no paid services: county PDFs/HTML are parsed
// deterministically and owner-of-record checks use free ArcGIS endpoints. A
// saved Anthropic key only adds OCR for scanned Fulton lists and business
// contact lookups (both skipped cleanly when absent).
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';
import Anthropic from 'npm:@anthropic-ai/sdk';
import { extractText, getDocumentProxy } from 'npm:unpdf';
import { createDb } from './lib/db.js';
import { createHttp } from './lib/http.js';
import { processJobs } from './lib/pipeline.js';
import { ENRICH_SCHEMA, ENRICH_SYSTEM, enrichUserPrompt, OCR_SCHEMA, OCR_SYSTEM, parseJsonResponse, usageCost } from './lib/ai.js';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const TIME_BUDGET_MS = 90_000;
const UA = 'Mozilla/5.0 (compatible; BridgewayResearch/1.0; +https://bridgeway404.com; info@bridgeway404.com)';

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
const db = createDb(supabase);
const log = (m: string) => console.log(`[ab] ${m}`);
const http = createHttp({ log, defaultIntervalMs: 350, minIntervalMs: { 'services1.arcgis.com': 250, 'dcgis.dekalbcountyga.gov': 300, 'gis.cobbcounty.org': 300, 'maps.douglascountyga.gov': 300 } });

async function sha256Hex(bytes: Uint8Array) {
  const h = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Fetch a public document. PDFs become text (one "=====PAGE=====" separator per page). Never throws. */
async function fetchDoc(url: string) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 45000);
    const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/pdf,text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8', 'accept-language': 'en-US,en;q=0.9' }, redirect: 'follow', signal: ctrl.signal });
    clearTimeout(t);
    const ct = res.headers.get('content-type') || '';
    const isPdf = /pdf/i.test(ct) || (/\.pdf(\?|$)/i.test(url) && !/html/i.test(ct));
    if (!res.ok) return { ok: false, status: res.status, url: res.url || url, contentType: ct, text: null, isPdf, pages: 0 };
    if (isPdf) {
      const bytes = new Uint8Array(await res.arrayBuffer());
      let pages = 0, text = '';
      try {
        const doc = await getDocumentProxy(bytes);
        pages = doc.numPages;
        const out = await extractText(doc, { mergePages: false });
        text = (Array.isArray(out.text) ? out.text : [out.text]).join('\n\n=====PAGE=====\n\n');
      } catch (e) {
        return { ok: false, status: res.status, url: res.url || url, contentType: ct, text: null, isPdf: true, pages: 0, error: 'unreadable PDF: ' + String((e as any)?.message || e).slice(0, 120) };
      }
      return { ok: true, status: res.status, url: res.url || url, contentType: ct, text, isPdf: true, pages, bytes, sha256: await sha256Hex(bytes) };
    }
    const text = await res.text();
    return { ok: true, status: res.status, url: res.url || url, contentType: ct, text, isPdf: false, pages: 0, sha256: await sha256Hex(new TextEncoder().encode(text)) };
  } catch (e) {
    return { ok: false, status: 0, url, contentType: '', text: null, isPdf: false, pages: 0, error: String((e as any)?.message || e).slice(0, 160) };
  }
}

/** Claude-backed helpers, or null when no key is configured. */
async function makeAi(settings: Record<string, string>) {
  const key = Deno.env.get('ANTHROPIC_API_KEY') || (await db.secret('anthropic_api_key'));
  if (!key) return null;
  const client = new Anthropic({ apiKey: key });
  const model = settings.ai_model_enrich || 'claude-sonnet-5';
  let spent = 0;
  const webSearch = (maxUses: number) => ({ type: 'web_search_20260209', name: 'web_search', max_uses: maxUses, user_location: { type: 'approximate', city: 'Atlanta', region: 'Georgia', country: 'US' } });

  async function structured(system: string, content: any[], schema: any, tools: any[], maxTokens: number) {
    const res = await client.messages.create({
      model, max_tokens: maxTokens,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content }],
      output_config: { format: { type: 'json_schema', schema } },
      tools,
    } as any);
    spent += usageCost((res as any).usage, model);
    if ((res as any).stop_reason === 'refusal') throw new Error('model refused');
    const parsed = parseJsonResponse(res as any);
    if (!parsed) throw new Error('model returned no JSON');
    return parsed;
  }

  return {
    get spent() { return spent; },
    enrichBuyer(buyer: any, props: any[]) {
      return structured(ENRICH_SYSTEM, [{ type: 'text', text: enrichUserPrompt(buyer, props) }], ENRICH_SCHEMA, [webSearch(6)], 6000);
    },
    async ocr(bytes: Uint8Array, url: string) {
      const b64 = btoa(String.fromCharCode(...bytes.subarray(0, 8_000_000)));
      const out = await structured(OCR_SYSTEM, [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } },
        { type: 'text', text: `Extract every parcel row from this Fulton County Sheriff levy sale list (${url}). Include the sale date printed on the list for each row.` },
      ], OCR_SCHEMA, [], 16000);
      return (out.rows || []).map((r: any) => ({ ...r, sale_date: r.sale_date || out.sale_date || null }));
    },
  };
}

async function runWorker(purpose: string) {
  const settings = await db.settings();
  const ai = await makeAi(settings);
  const result = await processJobs({ db, http, fetchDoc, ai, log }, { timeBudgetMs: TIME_BUDGET_MS });
  log(`${purpose}: handled ${result.handled} jobs in ${result.elapsedMs}ms, ${result.remaining} remaining, ai $${ai ? ai.spent.toFixed(3) : '0 (no key)'}`);
  if (result.remaining > 0) {
    const { error } = await supabase.rpc('ab_invoke_worker', { p_purpose: 'continue' });
    if (error) log('self-invoke failed: ' + error.message + ' (the ab-tick watchdog will retry within 15 minutes)');
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response(JSON.stringify({ ok: true, worker: 'auction-buyer-leads' }), { headers: { 'content-type': 'application/json' } });
  let body: any = {};
  try { body = await req.json(); } catch { /* empty */ }
  const token = body?.token;
  if (!token || !(await db.claimInvocation(token))) {
    return new Response(JSON.stringify({ error: 'invalid or expired invocation token' }), { status: 401, headers: { 'content-type': 'application/json' } });
  }
  const purpose = String(body.purpose || 'run');
  EdgeRuntime.waitUntil(runWorker(purpose).catch((e) => log('worker crashed: ' + (e?.stack || e))));
  return new Response(JSON.stringify({ accepted: true, purpose }), { status: 202, headers: { 'content-type': 'application/json' } });
});
