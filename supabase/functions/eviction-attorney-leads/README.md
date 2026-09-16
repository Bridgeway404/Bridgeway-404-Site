# eviction-attorney-leads — research worker

Supabase Edge Function behind the **Eviction Attorney Leads** tab
(`/admin/attorneys/`). It builds Leslie's call list of plaintiff-side
attorneys and law firms that represent landlords, apartment communities,
property-management companies and rental owners in Georgia dispossessory
(eviction) proceedings, and writes to the `eal_*` tables (migration
`0007_eviction_attorney_leads.sql`).

**It is manual only.** There is no pg_cron entry and nothing schedules it;
it runs when someone presses **Find More Attorneys** on the Admin page.

## How a run works

```
Admin page ──▶ eal_request_run(options)  ──▶ eal_invoke_worker()  ── pg_net POST + one-time token ──▶ this function
                                                                                                       │ processJobs() ≤ 90 s
                                                                                                       │ then re-invokes itself
                                                                                                       ▼
                 eal_jobs: run.start → seed.court_records → research.web ×N → enrich.attorney ×M → run.finish
```

1. **seed.court_records** — reads `eal_court_record_stats()`: every attorney
   named as plaintiff's counsel on the magistrate-court dispossessory
   calendars the (now paused) distressed pipeline already harvested, with
   filing counts and the landlord entities they filed for. Attorneys whose
   plaintiffs are only lenders, servicers, government agencies or
   individuals are dropped; the rest are added with the court evidence
   ("appeared as plaintiff's attorney on 345 dispossessory cases … for 110
   landlord / property-management entities, including …"). No API key is
   needed for this step.
2. **research.web** — one Claude call per pass with web search, asking for
   attorneys with *affirmative* evidence of landlord-side eviction work in
   the chosen counties (firm pages marketing eviction services to property
   owners, apartment-association legal resources, bios naming
   property-management clients…). Names already on the list are passed in
   as exclusions; tenant-defense attorneys and anything without a source
   URL are discarded.
3. **enrich.attorney** — for court-record attorneys, one Claude (Sonnet)
   call with web search to find the firm, phone, email, website, city and
   how the firm markets its eviction practice. Only pages the model cites
   are used; phone numbers and emails are never inferred.
4. Every candidate goes through `eal_upsert_lead()`, which checks for
   duplicates by attorney name, email, phone number, website and firm and
   merges non-destructively (fills blanks, appends evidence, never touches
   Leslie's status, notes, follow-up or assignment).

Steps 2 and 3 need an Anthropic API key, saved from **Research settings**
on the Admin page into Supabase Vault (the same `anthropic_api_key` secret
the distressed pipeline used). Without a key the court-record seed still
runs and the leads show "needs lookup" where the phone is missing.

## Layout

| Path | What |
|---|---|
| `index.ts` | Deno entrypoint: token check, Claude API wrapper (web search + JSON schema output), self-invocation |
| `lib/pipeline.js` | Job handlers and pass planning |
| `lib/court.js` | Court-calendar attorneys → qualified candidates with evidence text |
| `lib/ai.js` | Prompts and JSON schemas for discovery and contact enrichment |
| `lib/normalize.js` | Name / firm / phone / host keys (mirror the SQL dedupe helpers), name cleaning |
| `lib/db.js` | All database access (service role, server-side only) |
| `test/` | Node 22 tests (`node --test`), fake DB + fake model, no network |

## Tests

```
cd supabase/functions/eviction-attorney-leads
node --test
```

## Deploying

```
supabase functions deploy eviction-attorney-leads
```

or upload `index.ts` + `lib/*.js` through the Supabase MCP / dashboard.
`verify_jwt` stays **on**.

## Settings (`eal_settings`)

| key | default | meaning |
|---|---|---|
| `ai_model_research` | `claude-opus-5` | web discovery passes |
| `ai_model_enrich` | `claude-sonnet-5` | per-attorney contact lookup |
| `counties` | Fulton,DeKalb,Gwinnett,Cobb,Clayton,Douglas,Henry | default counties (the Admin page can narrow a run) |
| `web_passes_per_run` | `2` | default number of web research passes (the Admin page can override, max 6) |
| `max_new_leads_per_run` | `30` | cap on candidates asked for per pass |
| `max_enrich_per_run` | `15` | court-record attorneys researched for contact details per run |
| `min_court_filings` | `2` | filings needed for a calendar attorney to qualify (or 2+ business plaintiffs) |
