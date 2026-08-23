# Bridgeway Admin — Property Management Blitz
## Product Definition (FINAL — approved, implementation in progress)

**Approved:** 2026-08-23
**Status:** Building

---

## 1. What this is

A password-protected internal admin panel added to the existing Bridgeway 404 website at
**`bridgeway404.com/admin`**, containing one module: the **Property Management Blitz** tool
at **`/admin/blitz`** for Jonathan's outreach to property-management companies and vendor
networks. The public website remains visually and functionally unchanged.

The core loop:

> Jonathan opens `/admin/blitz` → sees the best prospect to contact next → understands why
> Bridgeway wants the account → taps the phone number → records the outcome → immediately
> gets the next prospect.

The MVP ships with a researched prospect universe (target ~300–500 credible organizations,
subject to research quality — no manufactured filler) so the tool is immediately useful.

---

## 2. Final decisions

### Access
- Day 1 users: **Michael** and **Jonathan**, separate authenticated accounts.
- **Leslie** is easy to add later (in-app "Team" management) but is not in the initial build.
- Every outreach action is attributed to the authenticated user who recorded it.

### Platform
- Route: `/admin`, blitz at `/admin/blitz`. Same repo, same static-HTML idiom, same
  Netlify/GitHub deploy. No public-site redesign.
- **Dedicated Supabase project** (`bridgeway-404`) — auth, Postgres, row-level security,
  outreach attribution. No custom password storage; Supabase Auth only.
- Sessions persist (~30 days per device, rolling refresh). Password changes in-app; an
  admin can reset a teammate's password from the Team page.

### Prospect types (V1 — exactly five)
1. Property Management Company
2. Multifamily / Apartment Operator
3. Single-Family Rental Operator
4. Third-Party Maintenance / Vendor Network
5. REO / Field Services

No HOA, self-storage, senior living, student housing, or realtor categories unless a
company clearly fits one of the five above.

### Outreach outcomes
- **No Answer** → prospect returns to queue after **2 business days**
- **Left Voicemail** → returns after **3 business days**
- **Spoke / Connected** → returns after **7 calendar days** unless marked Done
- **Done** → removed from the active blitz rotation
- Optional note on any outcome, never required.
- Recycling timing lives in one database table (`recycle_rules`) read by one function —
  changeable later without redesigning anything.

### Views
- **Next Prospect** (default page): company + type, why Bridgeway wants the account,
  best contact (name, title, tap-to-call phone, clickable email), company info (website,
  Metro Atlanta relevance, approximate portfolio/footprint when known), third-party/vendor
  registration info when relevant (registration URL, contact URL, onboarding note),
  source of the data, and the four action buttons. After an action, the next prospect
  appears immediately. No separate Vendor Applications workflow.
- **Master Prospect List**: search plus filters for type, status, geography,
  worked/unworked, company, and contact availability. For visibility, searching,
  corrections, and selecting prospects — not a CRM.

### Prioritization (internal, invisible)
The queue orders by a simple internal rule combining: practical contact path first, then
research priority (1–4, assigned during research from recurring-volume / Atlanta
concentration / portfolio size / outsourcing likelihood / vendor-network opportunity /
contact quality / geographic fit / freshness), then due time. Jonathan never sees a score —
the screen just serves the best available prospect. Companies without a practical contact
path stay in the database but rank last.

### Data ingestion
- **Supabase Postgres is the operating source of truth.**
- CSV import/upsert in the admin panel: de-duplicates on normalized company name, updates
  existing companies non-destructively (never overwrites a field with blank, never touches
  outreach history or queue state), validates required fields, and reports per-row failures.
- Google Sheets/CSV remain research and staging formats only.
- **Prospect data is never committed to this repository** — everything in the repo is
  published to the public website by Netlify.

### Security
- Supabase Auth + Postgres row-level security. Every table denies access unless the
  requester is an authenticated member of the `admin_users` allowlist — so even though the
  `/admin` HTML shell is statically served, unauthenticated users cannot read prospect or
  outreach data through the client/API.
- The only frontend config is the Supabase project URL and anon (publishable) key — public
  client configuration by design. The service-role key is never in the browser or the repo.
- `/admin/*` responses carry `X-Robots-Tag: noindex`; `/docs/*` is blocked from serving.

---

## 3. Implementation plan (brief)

**Files/directories added** (public site untouched except `netlify.toml` headers):

```
admin/index.html            login + Bridgeway Admin shell (module card, Team, password)
admin/blitz/index.html      Next Prospect workflow (default blitz page)
admin/prospects/index.html  master list + CSV import
admin/assets/admin.css      shared admin styles (Bridgeway brand, mobile-first)
admin/assets/admin.js       shared auth guard + Supabase client + helpers
admin/assets/supabase.js    vendored @supabase/supabase-js (UMD, pinned)
admin/assets/config.js      Supabase URL + anon key (public client config)
supabase/migrations/*.sql   schema, functions, RLS (versioned in repo)
netlify.toml                + connect-src for Supabase, noindex on /admin/*, block /docs/*
```

**Supabase tables:** `admin_users` (allowlist + display names), `prospects` (company,
type, contact, vendor URLs, priority, status, `next_due_at`), `outreach_log` (outcome,
note, user, timestamp), `recycle_rules` (outcome → days + business-day flag).

**Auth approach:** Supabase Auth email+password. Accounts are created only by an existing
admin through a `security definer` database function (used by the Team page) — public
signup is never trusted: RLS checks membership in `admin_users`, not mere authentication.
Michael's account is seeded with a temporary password; Michael adds Jonathan (and later
Leslie) from the Team page.

**Next Prospect query/recycling:** one RPC returns the best due prospect
(`status = active`, `next_due_at <= now()`, ordered by has-contact-path → priority →
due time; if nothing is due it serves the earliest upcoming one, labeled as early). One
RPC logs an outcome: inserts the attributed `outreach_log` row and re-queues or closes the
prospect using `recycle_rules` — all timing in one place.

**Import mechanism:** client-side CSV parse → chunked `import_prospects` RPC → upsert by
normalized company name with per-row success/failure report in the UI.

**Initial prospect universe:** parallel web research across the five categories —
Atlanta residential PM companies, multifamily/apartment operators with Atlanta portfolios,
SFR/scattered-site operators, Lessen-like vendor networks (vendor-registration URLs
prioritized), and REO/property-preservation field services recruiting Georgia vendors —
every record carrying source URLs, no fabricated data, deduplicated and loaded through the
importer. The staging CSV is delivered separately, not committed.

**Build order:** schema/RLS → auth → shell → Next Prospect → master list → CSV import →
prospect research/load → mobile + security QA → push through the existing GitHub/Netlify
workflow.
