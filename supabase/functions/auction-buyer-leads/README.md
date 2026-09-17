# auction-buyer-leads — research worker

Supabase Edge Function behind the **Auction Buyer Leads** tab
(`/admin/auction-buyers/`). It builds Leslie's call list of people and
companies that recently bought property at a tax sale, levy / sheriff's sale,
foreclosure or other forced sale in Fulton, DeKalb, Cobb, Henry and Douglas,
and writes to the `ab_*` tables (migration `0008_auction_buyer_leads.sql`).

It is independent of the Eviction Attorney worker (`eal_*`) and of the paused
Distressed Property pipeline (`dpl_*`); the only shared pieces are the
one-time invocation tokens (`dpl_invocations`) and the Vault slot for the
optional Anthropic key.

## Schedule

pg_cron, registered by `ab_set_paused(false)` in the migration:

| job | schedule | what |
|---|---|---|
| `ab-weekly-1200utc` | `0 12 * * 3` | `ab_scheduled_kick()` — runs when it is 08:00 Wednesday in America/New_York (EDT) |
| `ab-weekly-1300utc` | `0 13 * * 3` | same, for EST |
| `ab-tick` | `*/15 * * * *` | watchdog: re-wakes the worker if queued work is waiting |

`select public.ab_set_paused(true)` removes exactly these three jobs;
`ab_set_paused(false)` puts them back. Nothing here touches the `dpl-*` jobs.
**Find Auction Buyers Now** in the Admin page calls the same
`ab_request_run()` the schedule uses.

## How a run works

```
ab_request_run() ──▶ ab_invoke_worker() ── pg_net POST + one-time token ──▶ this function
                                                                             │ processJobs() ≤ 90 s, then re-invokes itself
                                                                             ▼
ab_jobs: run.start → source.fetch ×8 → verify.batch ×N → buyers.consolidate → enrich.buyer ×M (optional) → run.finish
```

1. **source.fetch** — one job per adapter in `lib/sources.js`. Each adapter
   finds the county's current documents, fetches them (`fetchDoc`: HTML, or
   PDF → text with unpdf), parses them with the pure parsers in
   `lib/parsers.js`, and returns *records*. A record from a **sold** source
   (excess-funds / overage list) is proof the sale completed; a record from an
   **upcoming** source is only an advertisement. Records become rows in
   `ab_properties` (`ingestRecord`, which never downgrades research progress).
   Every fetched document is kept in `ab_documents`; per-source health goes to
   `ab_source_state`. An adapter that fails (404, blocked, changed layout)
   logs the reason and the run continues. PDF parsing is CPU-heavy, so after
   each `source.fetch` the worker hands the queue to a fresh invocation
   (`{ heavy: true }`) instead of running on; one isolate that parses every
   county list in a row gets killed by the edge runtime ("CPU Time
   exceeded"). If an invocation still dies mid-job, the job is put back in
   the queue after 10 minutes and `ab-tick` re-wakes the worker.
2. **verify.batch** — for parcels in *awaiting_sale_result* /
   *buyer_research_needed* (25 per job, throttled, `max_assessor_checks_per_run`
   in total), queries the county assessor layer in `lib/assessor.js` for the
   current owner of record and compares it with the pre-sale owner
   (`ownerChanged`). A different owner after a confirmed or past sale ⇒
   `buyer_identified` with the owner's mailing address; the same owner ⇒
   re-checked next week (`recheck_days`), given up after `give_up_days`.
   Douglas' GIS is a 2021 snapshot (flagged stale) and Henry publishes no owner
   names, so those counties rely on the county's own purchaser column
   (Douglas) or a manual look-up (Henry).
3. **buyers.consolidate** — every identified purchaser is classified
   (`classifyBuyer`: investor company, landlord, flipper, builder, bank,
   servicer, government, individual…), split into company / principal, and
   upserted through `ab_upsert_buyer` (dedupe by name key, email, website,
   phone + mailing address). The property is linked (`ab_link_property`), the
   acquisition count recomputed, and `scoreBuyer` decides `qualified` and
   `priority` (High for repeat purchasers or companies with a direct contact,
   Medium for one qualified acquisition, Low otherwise). A priority set by hand
   on a qualified lead is never lowered.
4. **enrich.buyer** — only when an Anthropic key is saved: one Claude call
   with web search per buyer lacking a phone/email (repeat purchasers first,
   `max_ai_enrich_per_run`), looking for *business* contact details only.
   With a key the Fulton adapter also OCRs the Sheriff's scanned levy lists.
5. **run.finish** — writes the short result (counties checked, completed
   sales reviewed, buyers identified, qualified leads added, existing updated,
   repeat purchasers).

## Adding a county

Add a sale-list adapter to `lib/sources.js` (and a parser to
`lib/parsers.js` if the document layout is new), an assessor entry to
`lib/assessor.js`, and the county name to the `counties` setting. Nothing
else changes.

## Files

- `index.ts` — Deno entrypoint: token check, `fetchDoc`, optional Claude, self re-invocation.
- `lib/pipeline.js` — orchestration (pure; DB / HTTP / fetcher / model injected).
- `lib/sources.js` — county adapters; `lib/parsers.js` — document parsers; `lib/assessor.js` — owner-of-record lookups; `lib/normalize.js` — keys, classification, dates; `lib/db.js` — supabase-js wrapper; `lib/http.js` — polite HTTP; `lib/ai.js` — prompts / schemas.
- `test/` — `node --test` suite (Node 22, no dependencies) with an in-memory DB, fixture documents and a fake assessor.

```
cd supabase/functions/auction-buyer-leads && node --test
```

## Settings (`ab_settings`)

`counties`, `lookback_days` (450), `recheck_days` (7), `give_up_days` (240),
`max_assessor_checks_per_run` (400), `max_ai_enrich_per_run` (10),
`ai_model_enrich`, `run_enabled` / `paused` (managed by `ab_set_paused`).
