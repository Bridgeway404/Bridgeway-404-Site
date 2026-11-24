# Bridgeway Lead Generation Engine — repository notes

This repository is public. It holds code and synthetic test data only. Business records,
customer or prospect data, financial figures and project memory live in the private
Google Drive folder "Bridgeway Lead Generation Engine" and in Supabase, never here.

| Path | What it is | Status |
|---|---|---|
| `docs/lead-engine/schema-draft.sql` | Proposed `le_` tables, guards and views for the existing Supabase project | Draft. Not applied. Loads cleanly into a scratch Postgres 16. |
| `supabase/functions/lead-engine/lib/reconcile.js` | Job-level payment reconciliation: deposits + balances, partials, refunds, off-Square payments, duplicate prevention, manual confirmation, channel profit, target acquisition cost | Library + tests. Not deployed. |
| `supabase/functions/lead-engine/lib/stalled.js` | Stalled-lead identification across the lead lifecycle | Library + tests. Not deployed. |
| `supabase/functions/lead-engine/lib/gates.js` | Ad-spend tier recommendations and the weekly capacity gate | Library + tests. Recommends only; never changes a budget. |
| `supabase/functions/lead-engine/lib/approvals.js` | Approval queue rules for outbound marketing messages | Library + tests. Not deployed. |
| `supabase/functions/opportunity-radar/` | Opportunity Radar: permit and bid source adapters, dedupe, explainable scoring, daily digest | Library + tests on synthetic records. **Every real source is disabled and unverified** until one live query confirms its fields and terms. |
| `supabase/functions/_shared/http.js` | Polite HTTP client (throttle, retries) shared by new workers | Copy of the existing workers' client. |
| `js/attribution.js` + hidden form fields | First-party lead-source capture on all five forms | On the development branch only. Browser-tested locally. |

Run the tests: `node --test` inside `supabase/functions/lead-engine` and `supabase/functions/opportunity-radar`.

Rules that apply to everything here:

- No marketing message is sent without a named person approving it. Suppression and text consent are rechecked at send time.
- A payment is linked to a job automatically only on strong evidence; anything ambiguous waits for a person.
- The success metric is a completed, paid job with a known source.
- Spending tiers are recommendations. Moving up always needs the owner.
- No migration is applied, nothing is deployed and nothing merges to `main` without approval.
