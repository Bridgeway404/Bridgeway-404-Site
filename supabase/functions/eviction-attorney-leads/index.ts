// Eviction Attorney Leads — research worker (Supabase Edge Function).
//
// Invoked by the database (eal_request_run → eal_invoke_worker → pg_net) with
// a one-time token when someone presses "Find More Attorneys" in the Admin
// panel. There is deliberately no schedule: nothing calls this on its own.
// The gateway already requires a valid project JWT; the worker additionally
// claims the token, so nobody can start work with the public anon key alone.
// It processes queued jobs for ~90 seconds, then re-invokes itself while work
// remains (each model call ends the invocation so a run is a chain of short
// isolates).
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';
import Anthropic from 'npm:@anthropic-ai/sdk';
import { createDb } from './lib/db.js';
import { processJobs } from './lib/pipeline.js';
import { DISCOVER_SCHEMA, DISCOVER_SYSTEM, discoverUserPrompt, ENRICH_SCHEMA, ENRICH_SYSTEM, enrichUserPrompt, parseJsonResponse, usageCost } from './lib/ai.js';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const TIME_BUDGET_MS = 90_000;

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
const db = createDb(supabase);
const log = (m: string) => console.log(`[eal] ${m}`);

/** Claude-backed research helpers, or null when no key is configured. */
async function makeAi(settings: Record<string, string>) {
  const key = Deno.env.get('ANTHROPIC_API_KEY') || (await db.secret('anthropic_api_key'));
  if (!key) return null;
  const client = new Anthropic({ apiKey: key });
  const modelResearch = settings.ai_model_research || 'claude-opus-5';
  const modelEnrich = settings.ai_model_enrich || 'claude-sonnet-5';
  let spent = 0;
  const webSearch = (maxUses: number) => ({ type: 'web_search_20260209', name: 'web_search', max_uses: maxUses, user_location: { type: 'approximate', city: 'Atlanta', region: 'Georgia', country: 'US' } });

  async function structured(model: string, system: string, prompt: string, schema: any, maxUses: number, maxTokens: number) {
    const res = await client.messages.create({
      model,
      max_tokens: maxTokens,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      output_config: { format: { type: 'json_schema', schema } },
      tools: [webSearch(maxUses)],
    } as any);
    spent += usageCost((res as any).usage, model);
    if ((res as any).stop_reason === 'refusal') throw new Error('model refused: ' + JSON.stringify((res as any).stop_details || {}));
    const parsed = parseJsonResponse(res as any);
    if (!parsed) throw new Error('model returned no JSON');
    return parsed;
  }

  return {
    get spent() { return spent; },
    discover(pass: { counties: string[]; focus: string; known: string[]; maxResults: number }) {
      return structured(modelResearch, DISCOVER_SYSTEM, discoverUserPrompt(pass), DISCOVER_SCHEMA, 15, 16000);
    },
    enrich(lead: any) {
      return structured(modelEnrich, ENRICH_SYSTEM, enrichUserPrompt(lead), ENRICH_SCHEMA, 6, 8000);
    },
  };
}

async function runWorker(purpose: string) {
  const settings = await db.settings();
  const ai = await makeAi(settings);
  const result = await processJobs({ db, ai, log }, { timeBudgetMs: TIME_BUDGET_MS });
  log(`${purpose}: handled ${result.handled} jobs in ${result.elapsedMs}ms, ${result.remaining} remaining, ai $${ai ? ai.spent.toFixed(3) : '0 (no key)'}`);
  if (result.remaining > 0) {
    const { error } = await supabase.rpc('eal_invoke_worker', { p_purpose: 'continue' });
    if (error) log('self-invoke failed: ' + error.message + ' (use "Resume" on the Admin page)');
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response(JSON.stringify({ ok: true, worker: 'eviction-attorney-leads' }), { headers: { 'content-type': 'application/json' } });
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
