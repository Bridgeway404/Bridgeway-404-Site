# Bridgeway Lead Generation Engine — repository notes

The full plan (strategy, audit, architecture, workflows, budget, roadmap, KPIs and the
Claude Code prompts for each phase) is the document "Bridgeway 404 Lead Generation Engine"
shared with the owner. This folder holds only what belongs next to the code.

| File | What it is | Status |
|---|---|---|
| `schema-draft.sql` | Proposed `le_` tables, guards and reporting views for the existing `bridgeway-404` Supabase project | **Draft. Not applied.** Loaded cleanly into a scratch Postgres 16 on 2026-11-24 (22 tables); suppression, text-consent, duplicate-lead and eviction-job guards were exercised. |

Rules that carry over from the commercial-account design (`bridgeway404-commercial-account-machine`):

- No message reaches a new business contact without a person sending it.
- Suppression is checked when a draft is created and again when it is sent.
- No marketing text without recorded consent. No automated outbound calls.
- Only a Google Places `place_id` is stored from Places; other fields come from sources that allow storage.
- Court-record details never appear in outreach. Scores are computed by code, not by a model.
- Every workflow starts paused and has a budget line.

Before applying the schema: confirm the primary keys of the live `customers` and `quotes`
tables (they were created outside this repository's migrations), then move the file to
`supabase/migrations/` under the next free number.
