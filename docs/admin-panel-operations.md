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

## 3d. Distressed Property Leads (`/admin/distressed`) — paused

> **Status: paused (September 2026).** This lead source was not producing enough
> useful opportunities, so its Tuesday/Thursday research schedule and the
> five-minute watchdog are switched off, and the page refuses to start runs or
> process uploads while paused. Nothing was deleted: every property, company,
> contact and note collected so far is still in the database and can be browsed
> on the page (which now sits behind a "Paused" card on the admin home page and
> is no longer in the top navigation). The team works the **Eviction Attorney
> Leads** list (section 3e) instead.
>
> To reactivate, run this once in the Supabase SQL editor — it restores the
> schedule and re-enables runs in one step:
>
> ```sql
> select public.dpl_set_paused(false);
> ```
>
> `select public.dpl_set_paused(true);` pauses it again. The description below
> is how the page works when it is active.

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

**Leads list.** One card per property, kept short so a lead can be understood
and called without scrolling: address (or community name), score, county,
workflow status, a "Turnover underway" badge when the case is at writ stage or
later (or a sale is imminent or done), "N active properties" when the target
company has two or more, a plain-English one- or two-sentence reason there may
be work, the target company and its type, the best contact with title and how
confident research is that they are the right person, then how to reach them,
a recommended next action, and **Call**, **Add to Prospects** and **Mark
Contacted** buttons. Who the right person is and whose phone line a number is
are two different questions, so each number is labelled by what the evidence
supports: **Direct** (a business mobile recorded for that person), **Office
line** (reaches the office, not verified as their own line), **Company main
line** (the company's general number, or a contact number identical to it,
shown with "No verified direct number found"), or **Listed number, line type
unverified**. The Call button says which it dials. Filters: search, county, foreclosure vs eviction,
stage group ("Turnover likely" = writ issued or later, or a sale that is
imminent or completed), workflow status, quick flags (high priority, new from
latest run, not reviewed, contact available/missing, needs research, company
with 2+ properties), sort, and an event-date range.

Tap **View evidence & details** on a card to see the rest: the technical stage
with key dates and case number, why the lead scored the way it did (every factor is listed) and the full research explanation, the
workflow status selector, why that company was chosen as the target with its
website and main line, every contact at the company with their source pages,
property facts and owner of record, every event with its case number, dates,
parties and stage history, related companies, the source documents and
evidence, and the team's notes.

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

## 3e. Eviction Attorney Leads (`/admin/attorneys`)

Leslie's call list of plaintiff-side attorneys and law firms that represent
landlords, apartment communities, property-management companies and rental
owners in dispossessory (eviction) cases in metro Atlanta. Bridgeway is not
selling legal services: when those clients regain possession of a unit it
usually needs a cleanout before it can be turned, so an attorney with
property-management clients is a recurring referral source. The pitch is
printed at the top of the page under **The pitch**.

**Nothing runs on a schedule.** The list grows only when someone presses
**Find More Attorneys**.

### The call list

One row per attorney (a stacked card on a phone, a table on a desktop):

| Column | What it shows |
|---|---|
| Attorney | Name, city/county, a gold **Court records** chip when the attorney was named as plaintiff's counsel on court calendars, **High referral potential** when the evidence points to a firm-wide landlord practice |
| Firm | Law firm and website |
| Phone | Tap-to-call button (opens the dialer on a phone), email; **Needs lookup** when no number is on file yet |
| Why they are relevant | Court filing count and the landlord / property-management clients identified, or the web evidence |
| Status | Selectable: New, Call Today, Called – No Answer, Left Voicemail, Spoke With Staff, Spoke With Attorney, Interested, Follow Up, Referral Partner, Not Interested, Bad Lead. **Mark contacted** under it stamps the last-contact time |
| Last contact | When the lead was last marked contacted |
| Follow up | A date; rows whose date has arrived get a gold edge and a **Due** chip, and the header shows how many are due |
| Assigned | Leslie, Mike, Jonathan, any admin account, or **Someone else…** to type a name |

Under each row: a **quick note** box (Enter or **Save note**; the latest note is
shown on the row) and **Details, evidence & notes**, which opens the full
evidence with source links, the clients identified, research notes, an
**Edit details** form for every field (attorney, firm, phone, email, website,
city, county, practice area, clients, evidence, source URL, standing notes),
and the dated, attributed history of every status change, contact, follow-up,
assignment and note.

**Filters and sort:** search (attorney, firm, county, city, client, evidence,
notes); status (**Active** by default, which hides Not Interested and Bad
Lead; choose **All statuses** to see them); county; assignee; and a quick
filter for follow-ups due, never contacted, has / needs a phone number, and
source (court records, web research, added by hand). Sort by newest first
(default), follow-up date, last contacted, most court filings, or name.

**+ Add attorney** creates a lead by hand. **Export CSV** downloads the current
filtered list.

### Duplicates

Before anything is added — by research or by hand — it is checked against the
list by attorney name (ignoring punctuation, "Esq." and suffixes), email,
phone number, website and firm. A match is merged into the existing lead:
blank fields are filled in, new evidence and source links are appended, and
Leslie's status, notes, follow-up and assignment are never touched. Two
different attorneys who share a firm's main line are kept as two leads. Adding
a duplicate by hand tells you what it matched on.

### Find More Attorneys

Opens a dialog to choose counties (Fulton, DeKalb, Gwinnett, Cobb, Clayton,
Douglas and Henry by default), how many web research passes to run, whether to
include court records, and an optional extra focus. **Start research** runs
right away; the page updates by itself as leads arrive and shows the run's
progress and result. A run has three parts:

1. **Court records** — attorneys named as plaintiff's counsel on the
   magistrate-court dispossessory calendars the distressed-leads system
   already collected, with how many cases they filed and for which landlord /
   management entities. Attorneys whose plaintiffs are only banks, servicers,
   government agencies or individuals are skipped; an attorney qualifies with
   two or more filings, or two or more business plaintiffs. No API key needed.
2. **Contact lookup** — for court-record attorneys, a web search for the firm,
   phone, email, website and how the firm markets its eviction practice.
3. **Web research passes** — searches for firms marketing landlord-side
   eviction / dispossessory work to property owners, apartment-association
   legal resources, and bios naming property-management clients. Tenant-defense
   attorneys, general real-estate attorneys and anything without a source URL
   are discarded. Names already on the list are excluded up front.

Parts 2 and 3 need an Anthropic API key, saved once under **Research settings
& run history** at the bottom of the page (stored encrypted in Supabase Vault;
it is the same key slot the distressed pipeline used). Without a key the run
still adds court-record attorneys — they show **Needs lookup** for the phone —
and the dialog says so. Each pass costs a few dollars of API usage; the run
history shows the spend.

If a run stalls (the worker stops checking in), a **Resume** button appears on
the run card.

## 3f. Auction Buyer Leads (`/admin/auction-buyers`)

Leslie's call list of people and companies that recently **bought** property
at a tax sale, levy / sheriff's sale, foreclosure or other forced sale in
Fulton, DeKalb, Cobb, Henry or Douglas. Whoever wins a parcel at auction
usually has to clear out whatever the previous occupant left behind before
they can renovate, rent or resell it, so a fresh purchaser — and above all a
repeat purchaser who buys at every sale — is a natural customer. The pitch is
printed at the top of the page under **The pitch**.

This is a separate channel from Eviction Attorney Leads (section 3e): its own
tables (`ab_*`), its own worker, its own schedule and its own page. Distressed
Property Leads (section 3d) stays paused and is not touched by it.

**It runs by itself every Wednesday at 8:00 am Eastern.** **Find Auction
Buyers Now** runs exactly the same research immediately.

### What qualifies as a lead

A buyer appears on the call list only when all three are true:

1. **The sale really happened.** An advertised sale is never enough. The proof
   is either a county *result* list (an excess-funds / overage row exists only
   once a parcel sold) or the county assessor roll showing a new owner of
   record after the sale.
2. **The purchaser is identified** — named by the county (Douglas prints the
   purchaser) or taken from the assessor roll (DeKalb, Fulton, Cobb).
3. **There is a realistic way to reach them** — a phone, email, website, or a
   public business mailing address for a company. A person who bought a single
   parcel needs a phone or email first; a person who has bought two or more is
   plainly investing and a mailing address is enough.

Banks, servicers, HUD and county bid-ins are recorded but stay off the list
unless a direct phone or email exists. Vacant land, lots and redeemed sales
are marked *Not useful*.

**Priority:** High = repeat purchaser (2+ recent acquisitions) or a company
with a direct phone/email; Medium = qualified with one acquisition; Low =
qualified but weak.

### Contact route and the call queue

Qualification says a buyer is real. The **contact route** says how good the
number is, and only that decides what Leslie sees by default:

| Route | Means | Queue label |
|---|---|---|
| **Direct** | The phone/email belongs to the buyer, the buyer's company, a verified principal, the buyer's property-management company, or an acquisitions/operations contact clearly tied to the buyer | **Call First** (repeat buyer or clear recurring acquirer) or **Call** |
| **Indirect** | A registered agent, law firm, broker, neighbouring/related company or other intermediary that may connect us to the buyer but is not the buyer | **Indirect Introduction** |
| **Research only** | No practical phone/email, or the relationship is too speculative to call | **Research More** (off the default view) |

The default view is the **call queue**: every lead labelled Call First, Call
or Indirect Introduction, in call order (label first, then acquisitions, then
overall recorded purchases). A lead can be *qualified* (real sale, real buyer,
mailing address) and still sit under Research More until someone finds a
usable number; the weekly run never lowers a label a person has set.

Every indirect lead spells out, in the row itself, **who the number reaches**
("Reaches: InVesta / GPS Property Management"), the **relationship** to the
buyer ("possible related property-management contact; shared registered-agent
location") and the **call goal** ("confirm whether they manage Deed Co
properties and who handles cleanouts"), so nobody has to open the research
notes to understand the call.

**Relationship clusters.** When several buyers route through the same law
firm, property manager or registered agent, they are linked in a cluster
(never merged). The first cluster member in the list is the one to call; the
others show *"One call covers this lead, handled by the call to X above."*
Any lead that shares a phone number with another shows a gold warning
*"This contact also relates to: …"*. When a status, note, contact stamp or
follow-up date is saved on such a lead, the **Also log on N linked leads**
box (ticked by default) writes the same outcome to every linked lead, with the
note prefixed "(via X)". Clusters are created from **Edit details → Relationship
cluster → New cluster…** or by SQL into `ab_clusters`.

### The call list

One row per buyer, however many properties they bought:

| Column | What it shows |
|---|---|
| Buyer / relationship | Company or person, the contact person, the one-line relationship (who the number really reaches and how they relate to the buyer), **Repeat purchaser**, **Institutional** and cluster chips |
| Phone | Tap-to-call button, "Reaches: …", email, website, and the shared-contact warning when other leads use the same number |
| Contact route | **Direct** / **Indirect** / **Research only** |
| Acquisitions | Auction acquisitions we confirmed, overall recorded purchases when known, the latest property and its date |
| Priority | The queue label (Call First / Call / Indirect Introduction / Research More) and High / Medium / Low |
| Call goal | One sentence: what the call is trying to accomplish |
| Status | New, Call Today, Called – No Answer, Left Voicemail, Spoke With Contact, Interested, Follow Up, Referral Partner, Not Interested, Bad Lead; **Mark contacted** stamps the last-contact time |
| Follow up | A date; rows whose date has arrived get a gold edge and a **Due** chip |
| Assigned | Leslie, Mike, Jonathan, any admin account, or **Someone else…** |

Under each row: a **short note** box (with the *Also log on linked leads*
box when the contact is shared) and **Properties, evidence & notes**, which
opens the evidence, the cluster (if any), a table of every property the buyer
acquired (parcel, sale date, price paid, verification status, links to the
county list and the assessor record), the mailing address, research notes,
an **Edit details** form (contact route, queue label, who the number reaches,
relationship, call goal, cluster, plus the buyer fields and priority), and the
dated, attributed activity history.

**Filters and sort:** search; status (**Active** by default hides Not
Interested / Bad Lead); county; queue (call queue, Call First only, direct
only, indirect only, Research More, everything); assignee; quick filters for
follow-ups due, never contacted, repeat purchasers, has / needs a phone,
companies / individuals. Sort by call order (default), newest first, most
acquisitions, latest acquisition date, follow-up date, last contacted or name.

**+ Add buyer** adds one by hand (it goes straight on the call list).
**Export CSV** downloads the current filtered list.

### Duplicates

One buyer per purchaser: names are compared with LLC / Inc / punctuation
ignored, then email, then website, then phone **together with** mailing
address. A shared office phone on its own never merges two different
companies. A purchaser who buys again is merged into the existing buyer and the
acquisition count goes up; Leslie's status, notes, follow-up and assignment are
never touched by research.

### Where the research comes from (and what it cannot see)

Everything is free public records; nothing is bought and no API is required.

| County | Sale results (proof of sale) | Upcoming lists | Purchaser / assessor check |
|---|---|---|---|
| DeKalb | Tax Commissioner excess-funds list (text PDF) | Tax-sale listing on the public-access site (HTML; sometimes down for maintenance) | County GIS parcel layer: current owner + mailing address |
| Douglas | Tax Commissioner overage file — the only county that **prints the purchaser** | Tax-sale legal notices (text PDF) | GIS land-records layer is a 2021 snapshot, so only the county file is used for purchasers |
| Henry | Tax Commissioner excess-funds list (text PDF, with purchase amounts) | Property tax sale list (text PDF) | **No owner names published** in GIS and the assessor site blocks automated access: sold parcels wait in *Buyer research needed* for a manual look-up |
| Fulton | Not published online (excess-funds list is by open-records request only) | Sheriff's levy sale lists are **scanned images** with no text; read only with the optional Claude OCR | Hosted assessor parcel layer works once parcels are known |
| Cobb | Excess-funds PDF linked from the Tax Commissioner site | Tax sale list posted four weeks before each May / November sale | Daily assessor parcel layer works |

When this was set up the Cobb PDFs linked from the county site returned
"not found"; the adapter re-checks every run. Each source's last success and
last problem is shown under **Research queue, sources & schedule**. One blocked
or changed site never stops the run — it is logged and the other counties
continue.

### The research queue (behind the scenes)

Every parcel seen on a list is tracked in the background with one of these
statuses, visible as counts under **Research queue**: *Upcoming / waiting*,
*Awaiting sale result*, *Buyer research needed*, *Buyer identified*, *Contact
research needed*, *Qualified*, *Not useful*. Each weekly run re-reads the
county results, re-checks unresolved parcels against the assessor roll (every
7 days per parcel, for 450 days after the sale, giving up after 240 days
without an ownership change), consolidates new purchasers into buyers, and
promotes the ones that qualify. Tax deeds are often not re-titled on the
assessor roll until the redemption period ends, which is why some confirmed
sales sit in *Buyer research needed* for months.

### Find Auction Buyers Now and the run result

Press the button, confirm, and the run starts at once; the page refreshes on
its own. When it finishes the card shows only the short result: counties
checked, completed sales reviewed, buyers identified, qualified leads added,
existing updated, repeat purchasers. Recent runs are listed under **Research
queue, sources & schedule**. If a run stalls, a **Resume** button appears.

### Pausing or resuming only the weekly schedule

Under **Research queue, sources & schedule** press **Pause weekly research**
(or **Resume weekly research**). This changes only the Auction Buyer jobs
(`ab-weekly-1200utc`, `ab-weekly-1300utc`, `ab-tick`). The same thing from
SQL:

```sql
select public.ab_set_paused(true);   -- pause the Wednesday run + watchdog
select public.ab_set_paused(false);  -- resume
```

Neither touches the attorney research (manual only) nor the distressed
pipeline (`dpl_*`, which stays paused).

### Optional Anthropic key

The weekly research is complete without an API key. Saving one under **Research
queue, sources & schedule** (the same encrypted vault slot the other tabs use)
adds two extras: OCR of Fulton's scanned levy lists, and a business-contact
web search for purchasers who have no phone or website yet (up to 10 per run,
repeat purchasers first).

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
| Distressed-leads research worker (paused) | `supabase/functions/distressed-leads/` (Supabase Edge Function; its pg_cron schedule is removed while paused) |
| Eviction-attorney research worker | `supabase/functions/eviction-attorney-leads/` (Supabase Edge Function, manual only, started from the Admin page) |
| Auction-buyer research worker | `supabase/functions/auction-buyer-leads/` (Supabase Edge Function; runs every Wednesday via pg_cron `ab-weekly-*`, or from the Admin page) |
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
