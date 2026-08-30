# Relationship Mapper — operations guide

**Purpose.** Before Bridgeway cold-contacts a company, check whether Michael
already has a way in. The Relationship Mapper turns Michael's real-world
network (Instagram/Meta data export + synced phone contacts today; other
sources later) into a warm-path discovery queue: who does Michael already
know, directly or indirectly, who can open doors for Bridgeway 404?

It is deliberately **not** a CRM. It exists to answer "who should Michael
contact and why," and to hand successful relationships off to the existing
Prospects/Blitz pipeline.

## Where it lives

- UI: `/admin/relationships/` (admin allowlist required, same auth as the
  rest of Bridgeway Admin).
- Parser: `admin/assets/meta-import.js` — parses `connections.zip` entirely
  in the browser; tested by `tools/test-meta-import.mjs`
  (`node tools/test-meta-import.mjs`).
- Schema: `supabase/migrations/0004_relationship_mapper.sql` — tables
  `rm_people`, `rm_signals`, `rm_orgs`, `rm_affiliations`, `rm_paths`,
  `rm_imports`; RPCs `rm_import_people`, `rm_delete_import`; views
  `rm_person_list`, `rm_path_list`. All RLS: allowlisted admins only.

## Core concepts

- **Person** — one human (or account) with a stable `person_key`
  (`ig:<username>` or `ct:<first>:<last>`). Research fields (company, title,
  tier, opportunity score, statuses, notes) are manual and never overwritten
  by imports.
- **Signal** — one piece of relationship evidence with provenance
  (mutual follow, phone contact, follow request, …). Signals are rebuilt on
  each import; `relationship_strength` is their sum.
- **Relationship strength ≠ Bridgeway opportunity score.** Strength measures
  how well Michael knows someone (mutual follow +3, follower +2,
  following-only +1, phone contact +2, weak name-match +1). The opportunity
  score (0–100) is a manual judgment of business value. A best friend with
  no industry ties: high strength, low score. A regional PM Michael met
  once: low strength, high score.
- **Identity confidence** — how sure we are that merged sources are one
  person: `confirmed` (single source, no inference), `high` (username is
  exactly the contact's full name), `medium` (both name parts appear in the
  username), `low`/`unknown`. The importer never silently merges below
  `medium`; everything else stays as two people until a human merges the
  research manually.
- **Path** — Michael → person (→ via hops) → organization, with degree
  (1–3), confidence, and evidence. Degree 2–3 paths require real evidence
  (same employer, documented relationship), not "follows the same account."

## Workflows

**Import an export.** Instagram/Meta → Download your information → HTML
format → `connections.zip` → Relationships → Import & Data. The ZIP is
parsed in the browser; only normalized people + signals reach the database.
Re-importing a newer export refreshes signals, adds new people, and never
touches research. Each import batch is listed and individually deletable.

**Research loop.** People tab → filter "Needs research" + strength — work
the strongest first. Fill company/title/tier/score from public sources.
Scored people appear in Top Opportunities automatically. The research CSV
import (Import & Data) bulk-applies research keyed by `ig_username` or
`person_key`.

**Company paths.** Company Paths tab records warm routes into target
companies. Creating a path auto-links the company to an existing prospect
by name when one matches, otherwise queues it under "Suggested new
Bridgeway leads" for review — one click adds it to the Prospects pipeline
(via the existing `import_prospects` RPC, so dedupe and non-destructive
updates apply).

**Action queue.** Every person carries an action status
(New → Research → Reach Out / Ask for Intro → Contacted → Follow Up →
Opportunity Created, or Not Relevant / Do Not Contact), a priority, a
next-action date, and notes. "Contact this week" and "Overdue" filters in
the People tab drive the weekly cadence.

## Privacy rules (non-negotiable)

- Never commit a raw export (ZIP or extracted HTML) to the repository —
  `.gitignore` blocks `*.zip`, `connections/`, `data/`, `imports/`.
- Raw export bytes never leave the browser; parsing is fully client-side.
- Phone numbers are matching/contact signals: they appear only inside a
  person's detail view, never in lists or dashboards.
- All tables are admin-allowlist RLS; anonymous and non-allowlisted
  authenticated users see nothing (verified against production).
- Deletion is first-class: per-person (Delete person in the editor) and
  per-dataset (Delete this import). Deleting an import keeps people who
  have manual research; deleting a person removes them and all signals.

## Extending to new sources

Instagram is one source among several. To add a source (LinkedIn export,
customer list, email): give each person a stable `person_key`, emit
signals with `source` set to the new origin, and call `rm_import_people`
with a new `p_source`. Nothing in the schema or UI is Instagram-specific;
`meta-import.js` is just the first adapter.
