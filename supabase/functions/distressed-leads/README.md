# distressed-leads — research worker

Supabase Edge Function that discovers foreclosure notices and eviction cases in
Fulton, DeKalb, Douglas and Henry counties, deduplicates them into property
leads, enriches ownership and management, scores each lead and writes
everything to the `dpl_*` tables (migration `0006_distressed_leads.sql`).
The Admin tab at `/admin/distressed/` reads those tables.

## How it runs

```
pg_cron (UTC)  ──▶ dpl_scheduled_kick()  ──▶ dpl_request_run('scheduled')
 0 12 * * 2,4       only the firing that is       │
 0 13 * * 2,4       08:00 America/New_York        ▼
                                          dpl_invoke_worker()  ── pg_net POST + one-time token ──▶  this function
                                                                                                   │ processJobs() for ~90 s
 dpl_tick() every 5 min (watchdog) ───────────────────────────────────────────────────────────────▶│ then re-invokes itself
                                                                                                   ▼
                                                        dpl_jobs queue: run.start → discover → enrich.ownership → enrich.company → score → run.finish
```

* **Scheduling is DST-safe** because the two UTC cron entries both call
  `dpl_scheduled_kick()`, which starts a run only when the local time in
  `America/New_York` is 08:xx on a Tuesday or Thursday and no scheduled run
  has started that day. `lib/schedule.js` mirrors the rule so it is unit-tested
  (`test/schedule.test.js` simulates a whole year, including both DST changes).
* **Nothing depends on a local machine.** The database schedules, the
  database invokes the worker, and the worker chains itself until the queue is
  empty. A crashed invocation is picked up by `dpl_tick()`.
* **Authentication.** The gateway requires the project's anon JWT, and the
  worker additionally requires a one-time token minted by
  `dpl_invoke_worker()` (table `dpl_invocations`). Nobody can start work with
  the public key alone. The service-role key and the Anthropic key never leave
  the server (the Anthropic key lives in Supabase Vault; see
  `dpl_set_secret`).

## Layout

| Path | What |
|---|---|
| `index.ts` | Deno entrypoint: token check, Claude API wrapper, PDF text, HTTP throttles, self-invocation |
| `lib/pipeline.js` | Job handlers: discovery, ingestion, dedupe, uploads, ownership + company enrichment, scoring |
| `lib/sources/*.js` | One adapter per source (retrieval only; parsing lives in `lib/parsers`) |
| `lib/parsers/*.js` | RSS / WordPress / CivicPlus listings, court calendars (PDF, .doc, .docx), foreclosure notice fields |
| `lib/enrich/ownership.js` | County GIS (ArcGIS REST) owner-of-record lookups |
| `lib/dedupe.js`, `lib/stages.js`, `lib/scoring.js`, `lib/target.js` | Pure logic: matching rules, stage taxonomy/progression, opportunity score, target + contact choice |
| `lib/ai.js` | Prompts and JSON schemas for the Claude-assisted steps (notice extraction, calendar fallback, company research) |
| `lib/db.js` | All database access (service role, server-side only) |
| `test/` | Node 22 tests (`node --test`), fixture-based, no network |

The `lib/*.js` files are plain ES modules shared unchanged between Deno (edge
function) and Node (tests).

## Tests

```
cd supabase/functions/distressed-leads
node --test
```

Covers address/parcel normalization, county detection, calendar and notice
parsing (real DeKalb/Fulton/Henry layouts with tenant names removed from the
fixtures), foreclosure republication/postponement dedupe, eviction case-number
dedupe, stage progression (automated sources never move a case backwards),
scoring, target selection, source-failure isolation, incremental ingestion,
company research caching, individuals never being researched or targeted, and
the Tuesday/Thursday 8 AM Eastern schedule across DST.

## Deploying

Normal path, from a machine with the Supabase CLI linked to project
`bridgeway-404`:

```
supabase functions deploy distressed-leads
```

Pinned bootstrap (used when only a single small file can be uploaded, e.g.
through the Supabase MCP tool): deploy an `index.ts` containing just

```ts
import 'https://raw.githubusercontent.com/Bridgeway404/Bridgeway-404-Site/<commit-sha>/supabase/functions/distressed-leads/index.ts';
```

The edge runtime fetches this directory from that exact commit at bundle time,
so what runs is byte-for-byte the committed code. Redeploy with a new SHA to
update. Either way `verify_jwt` stays **on**.

## Settings (`dpl_settings`)

| key | default | meaning |
|---|---|---|
| `run_enabled` | `true` | set `false` to pause scheduled runs (manual runs still work) |
| `ai_model_research` | `claude-opus-5` | company research (with web search) |
| `ai_model_extract` | `claude-sonnet-5` | notice / calendar / list extraction |
| `max_company_research_per_run` | `20` | budget for new company research per run |
| `max_notice_extractions_per_run` | `150` | budget for AI notice extraction per run |
| `company_refresh_days` | `90` | how long cached company research is reused |
| `lookback_days` | `14` | how far back calendars/feeds are read |
| `max_documents_per_job` | `3` | PDF/Word documents fetched per discovery job; the job re-queues itself for the rest so no single isolate exceeds the edge runtime's CPU budget |

## Privacy rules built into the code

* Only the plaintiff side of eviction calendars is parsed; tenant names are
  discarded before anything is stored, and the AI extractor is instructed the
  same way. Nothing about occupants is collected.
* Individual people (homeowners, small landlords) are recorded as
  `is_individual` companies, never researched, never chosen as targets, and
  their leads are penalized in the score.
* Contacts are business-side only, always with a source URL; emails are never
  inferred from naming patterns (the schema requires a cited page).
* Every stored claim carries a source URL in `dpl_evidence`; nothing the model
  says is saved as a fact without one.
