# Bridgeway Admin — Operations Guide

Internal guide for running the admin panel at `bridgeway404.com/admin`.
The public website is unaffected by everything described here.

---

## 1. Signing in

Go to **bridgeway404.com/admin** and sign in with your Bridgeway email and password.
There is no link to this page from the public site — type the URL directly.

Sessions persist on each device, so signing in on Jonathan's phone once is enough;
he stays signed in until he signs out.

**First sign-in for Michael:** use the temporary password provided separately, then
immediately change it under **Your account → Change password** on the admin home page.

---

## 2. Jonathan's daily workflow (`/admin/blitz`)

1. Open the admin panel and tap **Property Management Blitz**.
2. The screen shows one company at a time: who they are, why Bridgeway wants the
   account, and the best contact.
3. Tap the purple phone button to dial (opens the phone dialer), or the email button
   to open the mail app.
4. Record what happened with one of four buttons:

   | Button | What it means | When the company comes back |
   |---|---|---|
   | **No Answer** | Nobody picked up | 2 business days |
   | **Left Voicemail** | Left a message | 3 business days |
   | **Spoke / Connected** | Actually talked to someone | 7 calendar days |
   | **Done** | Finished with this company | Never — leaves the rotation |

5. A note is optional — type one if it's useful, otherwise just tap the outcome.
6. The next prospect appears immediately. Repeat.

The counter at the top shows how many companies are due right now. If nothing is due,
the tool serves the next upcoming one and says so, so Jonathan can keep working ahead.

Every outcome is recorded with who logged it and when.

---

## 3. The prospect database (`/admin/prospects`)

Search by company or contact name, and filter by prospect type, status,
worked/unworked, contact info, and geography.

Tap any company to open it. You can correct any field, see its full activity history,
mark it **Done**, or **Reactivate** a company that was marked Done earlier.

**Team notes.** Under *Team notes & activity* in the editor, type what you did or learned
(for example "Called property manager. Receptionist gave me Ashley's direct number. Try
again Monday.") and tap **Save note**. The note is stored in the activity history with
your name and the time, alongside the call outcomes logged from the Blitz, and it puts
the company on the Follow-Ups list. Saving a note does not change when the company comes
back around in the Blitz — only the four outcome buttons do that.

The *Vendor / onboarding notes (research)* field is different: it holds reference
information from research and CSV imports and is not treated as activity.

**+ Add** creates a single prospect by hand.

### Importing a research batch

**Import CSV** loads a batch of researched companies.

- Required columns: `company_name`, `prospect_type`.
- `prospect_type` must be one of: Property Management Company, Multifamily / Apartment
  Operator, Single-Family Rental Operator, Third-Party Maintenance / Vendor Network,
  REO / Field Services.
- Optional columns: `website`, `primary_geography`, `metro_atlanta_relevance`,
  `portfolio_summary`, `why_bridgeway`, `contact_name`, `contact_title`, `contact_phone`,
  `contact_email`, `vendor_registration_url`, `general_contact_url`, `vendor_notes`,
  `source_urls` (separate multiple with `|`), `priority` (1–5, 1 = best),
  `last_verified_date` (YYYY-MM-DD).

The importer matches existing companies by name and **updates** them rather than creating
duplicates. It never erases a field that already has data, never resets where a company
sits in the queue, and never touches outreach history. Rows that fail validation are
reported individually — the rest still import.

---

## 3b. Vendor partnership targets (Apply First)

Some companies are **partnership targets**: Bridgeway should register as an approved
service vendor with them rather than cold-sell them. These carry a gold status chip in
the Blitz and Prospects screens, and the highest tier is labelled **APPLY FIRST**.

Priority 0 is reserved for these Tier 1 targets, so they are always served ahead of
ordinary outbound prospects. Use the **Vendor partnership status** field on a prospect
to move it through the onboarding workflow:

| Status | Meaning |
|---|---|
| Apply First | Tier 1 target — work this before anything else |
| Application Needed | A vendor application exists; it has not been started |
| Application Started | Application in progress |
| Application Submitted | Submitted, awaiting a decision |
| Vendor Contact Needed | No public application — find the vendor/ops contact |
| Follow-Up | Waiting on them; check back |
| Approved Vendor | Accepted into their vendor network |
| Not a Fit | Ruled out |

Leave the field on "Not a partnership target" for ordinary outbound leads. The
**All leads** filter on the Prospects page narrows to partnership targets or to
Apply First only.

> **Note on CSV import:** the importer sets `priority` from the file. Re-importing an
> older research CSV would overwrite the priority 0 values on these targets. It does
> **not** touch vendor partnership status. If you re-import, re-check the Apply First
> list afterwards.

---

## 3c. Follow-Ups (`/admin/follow-ups`)

One list of every company the team has actually touched, most recent activity first,
so contacted companies are not buried in the full prospect database.

A company appears here (once, no matter how many times it was worked) when any of
these is true:

- at least one outcome has been logged for it in the Blitz (No Answer, Left Voicemail,
  Spoke / Connected, or Done) — with or without a note;
- a team note has been saved on it from the prospect editor;
- it has been marked **Done** from the Prospects editor;
- its **Vendor partnership status** is Application Started, Application Submitted,
  Follow-Up, Approved Vendor, or Not a Fit.

Each row shows the type, contact person, tap-to-call phone, email, the latest activity
and when it happened (Note, Call — No Answer, Call — Left Voicemail, Spoke / Connected,
Done), how many calls and notes have been logged, the most recent note (or the research
notes when no team note or call note exists), the queue due date, and where the research
came from. Tapping a row opens the same editor as the Prospects page, with the team-note
box and full activity history underneath.

Rows are flagged **Needs follow-up** when the queue says the company is due again (per the
recycling rules in section 5) or its partnership status is set to Follow-Up.
**Contacted — waiting** means an outcome was logged and the company is not yet due back.

Filters: search by company or contact, follow-up state (Needs follow-up / Contacted /
Note only / Done), prospect type, and partnership vs. ordinary leads.

> **What does not count as activity:** the *Vendor / onboarding notes (research)* field
> and the Apply First / Application Needed / Vendor Contact Needed statuses are filled in
> by the research CSV import, so having them does not mean anyone has reached out.
> Editing a company's details does not count either. To have a company show up here, log
> an outcome in the Blitz, save a team note, or move its partnership status forward.

---

## 3d. Distressed Property Leads (`/admin/distressed`)

Foreclosure notices and evictions in Fulton, DeKalb, Douglas and Henry, turned
into B2B leads: each property is matched to the management company, owner
entity or investor most likely to buy cleanout, turnover or REO work. The
research runs by itself every **Tuesday and Thursday at 8:00 AM Eastern**
(daylight-saving safe, nothing to run on anyone's computer); **Run research
now** starts an extra run.

**Top of the page.** Counts for new leads from the latest run, high-priority
leads (score 70+), foreclosures, evictions tracked, evictions at writ stage or
later, outreach-ready leads, leads that still need research, and companies
with two or more active properties. Tap a tile to filter the list. Below it:
when the last run happened, what it found, which sources failed, and when the
next run is.

**Leads list.** One row per property: address (or community name), county,
stage, score, workflow status, target company and best contact with confidence,
key dates and case number. Filters: search, county, foreclosure vs eviction,
stage group ("Turnover likely" = writ issued or later, or a sale that is
imminent or completed), workflow status, quick flags (high priority, new from
latest run, not reviewed, contact available/missing, needs research, company
with 2+ properties), sort, and an event-date range.

Tap a row to expand it: why the lead scored the way it did (every factor is
listed), the target company and its contacts with their source pages, property
facts and owner of record, every event with its dates, parties and stage
history, related companies, the source documents and evidence, and the team's
notes.

**Eviction stages.** A filing is never called an eviction. Stages are:
dispossessory filed → service completed → hearing scheduled → judgment entered
→ writ of possession issued → writ pending execution → eviction scheduled →
eviction executed → possession returned (plus dismissed / status unknown).
Automated sources only ever move a case forward. Court calendars give the
hearing stage; writs and executions come from the Fulton Marshal list (upload)
or from checking the court portal by hand and using **Update stage by hand**
on the event, with a note and date.

**Workflow statuses:** New → Reviewing → Outreach Ready → Contacted → Follow Up,
plus Not a Fit and Closed. Changing the status records who did it and when.
Notes work like team notes elsewhere. **Add to Prospects** creates (or opens)
the company in the regular prospect database so the Blitz and Follow-Ups
machinery take over from there.

**Companies view.** The same data grouped by company: how many active
properties each has, the best score, counties, best contact, research summary
and source pages. Companies with several properties are the strongest
targets.

**Add a case or upload a list.** For anything the automation cannot fetch on
its own: a case you checked on a court portal, the Fulton County Marshal's
writ execution list (ask the Marshal's civil division for it), a foreclosure
notice PDF, an e-Edition legal section, or a CSV. Only case number, plaintiff,
property and stage are stored — never anything about tenants.

**Research settings.** Paste an Anthropic API key to turn on AI company
research (finding the management company, contacts, confidence). It is stored
encrypted in Supabase Vault and never shown again. Without a key, discovery and
county-GIS owner lookups still run; leads just show "needs research".
Research is cached per company for 90 days, so cost tracks the number of new
companies, not the number of properties.

**Sources & run history** lists every source with its last success and last
error, lets you disable one, and shows recent runs. One source failing never
stops the others. Where the data comes from, what could not be automated and
why, and which paid options exist are written up in
`docs/distressed-leads-sources.md`.

---

## 4. Adding and removing people

On the admin home page:

- **Add a team member** — enter their name, email, and a temporary password (10+
  characters). Share it with them and have them change it after signing in.
  This is how Leslie gets access when the time comes.
- **Reset a team member's password** — set a new temporary password for someone who is
  locked out.

Passwords are never stored in readable form; only a secure hash is kept.

To remove someone's access, delete their user in the Supabase dashboard
(**Authentication → Users**).

---

## 5. Changing how often prospects come back

The recycling timing lives in one database table, so it can be changed without touching
the application. In the Supabase SQL editor:

```sql
-- e.g. bring no-answer companies back after 1 business day instead of 2
update public.recycle_rules set days = 1 where outcome = 'no_answer';

-- see the current settings
select * from public.recycle_rules;
```

`business_days = true` skips weekends; `false` counts calendar days.

---

## 6. How access is protected

The `/admin` pages are ordinary files on the website, so anyone can load the empty
shell — but they contain no data. Every piece of prospect and outreach data is fetched
from Supabase, which enforces two conditions on every single request: the requester must
be signed in, **and** their account must be on the Bridgeway admin allowlist. Someone who
signs up on their own, or who is signed in but not on the allowlist, receives zero rows —
this is enforced by the database itself, not by the browser, so it cannot be bypassed by
editing the page or calling the API directly.

The only credentials in the website code are the Supabase project URL and its
publishable key, which are designed to be public and grant nothing on their own. The
service-role key is never used in the browser and is not stored in the repository.

Admin pages are marked `noindex`, so they never appear in search results.

---

## 7. Where things live

| Thing | Where |
|---|---|
| Admin pages | `admin/` in the `Bridgeway-404-Site` repo |
| Database schema | `supabase/migrations/` in the same repo |
| Distressed-leads research worker | `supabase/functions/distressed-leads/` (Supabase Edge Function, scheduled by pg_cron) |
| Prospect + outreach data | Supabase project **bridgeway-404** |
| Deployment | Netlify, automatically on push to `main` |

**Prospect data is never stored in the repository** — the repo is published to the public
website, so research CSVs are kept outside it (Google Drive, or your computer).

---

## 8. Two manual settings to confirm in the Supabase dashboard

Neither blocks launch, but both are worth setting once:

1. **Session length** — Authentication → Sessions. By default sessions do not time out,
   which is what we want for Jonathan's phone. Only change this if you want to force
   periodic re-login.
2. **Leaked password protection** — Authentication → Policies. Turning this on makes
   Supabase reject passwords found in known breach lists. Recommended.
