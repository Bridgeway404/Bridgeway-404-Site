# Bridgeway Admin — Property Management Blitz
## Product Definition (for approval — no implementation yet)

**Date:** 2026-08-23
**Status:** Awaiting Michael's approval

---

## 1. What this is

A password-protected internal admin panel added to the existing Bridgeway 404 website at
**`bridgeway404.com/admin`**, containing one module: the **Property Management Blitz** tool
for Jonathan's outreach to property-management companies and vendor networks.

The core loop it must make effortless:

> Jonathan opens `/admin` → sees who to contact next → taps to call → records the result
> in seconds → immediately gets the next prospect.

---

## 2. Existing website — inspection findings

These findings drove the architecture below.

| Aspect | Finding |
|---|---|
| Framework / stack | Hand-written static HTML/CSS/JS. The entire public site is essentially one file (`index.html`); no framework, no build step (`netlify.toml`: `command = ""`, `publish = "."`). |
| Hosting | Netlify, auto-deploying from the GitHub repo `Bridgeway404/Bridgeway-404-Site` (`main` branch). A push is live in ~30 seconds. |
| Routing | File-based (`index.html`, `privacy-policy.html`, `thank-you.html`) plus redirects in `netlify.toml`. |
| Authentication | None anywhere on the site. |
| Admin / private functionality | None. |
| Database / storage | None in the site itself. Netlify Forms captures leads → email notifications and Zapier/Make → Google Sheets. Separately, the business has an **active Supabase account** (`info@bridgeway404.com`) with healthy projects. |
| Deployment process | `git push` to `main` → Netlify auto-deploy. |
| Adding `/admin` | Straightforward. An `/admin/` directory of pages serves at `bridgeway404.com/admin` with zero changes to the public site. Because static hosting cannot gate page files by itself, **security lives at the data layer**: the admin HTML is an empty shell with no data in it, and every piece of prospect data requires an authenticated session enforced server-side by Supabase (Auth + Postgres row-level security). |

**Conclusion:** no separate repository or application is needed. The admin panel extends this
repo and this Netlify site, using Supabase (already owned) as the secure backend.

---

## 3. Decisions from the requirements interview

All ten architecture questions were answered:

1. **Day-1 access:** Michael + Jonathan.
2. **Logins:** Separate credentials for each person.
3. **Leslie:** Will need access eventually — adding her later is a ~2-minute task (create account, done).
4. **Attribution:** Yes — every logged outcome is stamped with which user did it and when.
5. **Mobile:** Yes, mobile-first. The Next Prospect workflow is designed for a phone: big tap targets, tap-to-call numbers, one-thumb outcome buttons. Desktop gets the fuller list views.
6. **Panel scope:** A simple "Bridgeway Admin" shell that can host future internal modules, with **only the Blitz module built now**.
7. **Public site:** Remains completely visually unchanged. No public link to `/admin`; the URL is typed directly.
8. **Route:** `/admin` (with the blitz at `/admin/blitz`).
9. **Sessions & passwords:** Stay signed in ~30 days per device; password reset by email; passwords never stored in plaintext (Supabase Auth handles hashing and reset flows — nothing custom is built).
10. **Data storage:** **Supabase database = source of truth.** Google Sheets remains a research/import source: prospect lists are exported as CSV and uploaded through an Import page in the admin panel. No live Google API integration to maintain.

### Scope trimming (from the workflow interrogation)

- **Views kept:** the focused **Next Prospect** workflow (core) and a searchable/filterable **Prospects master list**.
- **Views cut:** a separate Follow-Ups view and a Vendor Applications view — not built now.
- **Outcome buttons kept:** **Called / No Answer / Left Voicemail**, plus one **Done** button to close a prospect out, and an **optional** quick note on any outcome (never required).
- **Outcome buttons cut:** Emailed, Interested, Follow Up, Vendor Application, Not a Fit, Job Opportunity.
- **Queue movement:** auto-recycle. No Answer / Left Voicemail automatically re-queue the prospect a few days out; Called re-queues on a longer interval; **Done** (with an optional one-line note) removes it from the rotation. Nothing requires scheduling by hand.
- **Prospect detail fields kept:** company name, prospect type, why Bridgeway wants them, and the best-contact block (name, title, tap-to-call phone, email).
- **Prospect detail fields cut:** service footprint, vendor-registration link/status, scripted call openers / voicemail / email templates, and a manual "next action" field (the queue *is* the next action).

---

## 4. Architecture

```
bridgeway404.com            ← public site, untouched
bridgeway404.com/admin      ← login + Bridgeway Admin shell
bridgeway404.com/admin/blitz← Property Management Blitz module
        │
        │  authenticated requests only (Supabase JS client)
        ▼
Supabase (existing account)
  ├─ Auth: email+password accounts (Michael, Jonathan; Leslie later)
  └─ Postgres with row-level security: prospects, outreach log
```

- **Same repo, same stack, same deploy.** Admin pages are hand-written static HTML/CSS/JS in an `/admin/` directory, styled to match Bridgeway branding, deployed by the same `git push` → Netlify flow.
- **Supabase Auth** provides login, hashed passwords, email password reset, and ~30-day persistent sessions. Michael and Jonathan get individual accounts; only accounts on an approved admin list can read or write any data (enforced in the database via row-level security, not in the browser).
- **`netlify.toml` changes only:** allow the browser to talk to the Supabase project (Content-Security-Policy `connect-src`), and add `noindex` headers on `/admin/*` so admin pages never appear in search engines. No other public-site configuration changes.
- **CSV import:** an Import page accepts a CSV exported from the research Google Sheet, previews the rows, de-duplicates against existing companies, and loads them as prospects.

### Data model (draft)

**prospects** — one row per company
`company_name`, `prospect_type`, `why_bridgeway` (why we want them), `contact_name`, `contact_title`, `contact_phone`, `contact_email`, `status` (active / done), `next_due_at`, `created_at`, `imported_from` (batch reference)

**outreach_log** — one row per logged attempt
`prospect_id`, `outcome` (called / no_answer / voicemail / done), `note` (optional), `user` (who logged it), `logged_at`

**Queue rule:** the next prospect is the active one whose `next_due_at` is earliest (never-contacted prospects first). Proposed default recycle intervals — **No Answer / Voicemail: +3 days; Called: +7 days; Done: leaves the queue.** *(Intervals are adjustable — flag any preference at approval.)*

---

## 5. Product experience

**`/admin`** — Bridgeway-branded login (email + password). After login: a minimal **Bridgeway Admin** home showing one module card, *Property Management Blitz*. Future internal tools become additional cards later; none are built now.

**`/admin/blitz` — Next Prospect (the heart of the tool, mobile-first):**
- A header line shows how many prospects are due today.
- One full-screen prospect card: company, prospect type, why Bridgeway wants them, contact name + title, **tap-to-call phone**, email.
- Four large one-thumb buttons: **Called · No Answer · Left Voicemail · Done**, with an optional note field.
- Tapping an outcome logs it (stamped with user + time), re-queues or closes the prospect, and immediately shows the next one.

**Prospects (master list):** searchable and filterable by prospect type and status; tapping a row opens the prospect for viewing/editing. Includes the **Import CSV** entry point.

---

## 6. Explicitly out of scope

- Any visual or content change to the public website.
- Follow-Ups view, Vendor Applications module, outreach scripts, email sending.
- Role-based permissions beyond "is an approved admin" (not useful at 2–3 users).
- A separate repository, frontend framework, or standalone application.
- Live Google Sheets API sync (CSV upload replaces it).
- Any other internal modules beyond the Blitz.

---

## 7. Open items to confirm at approval

1. **Recycle intervals** — accept the 3-day / 7-day defaults, or specify others.
2. **Prospect types** — the list of `prospect_type` values (e.g., Property Management Co., HOA, Vendor Network, Apartment Community) to seed filters and the CSV import.
3. **Supabase project** — reuse the existing general project or create a dedicated one for Bridgeway (recommended: dedicated, to keep the business data isolated; decided at implementation).
