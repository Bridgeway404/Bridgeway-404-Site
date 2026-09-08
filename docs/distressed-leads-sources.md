# Distressed Property Leads — source matrix and recommendations

Findings from the source investigation for the Distressed Property Leads
system (Fulton, DeKalb, Douglas, Henry). Everything below was checked from a
server, the way the automation runs, on 2026-09-08. "Automatable" means the
site is publicly reachable without a login, does not forbid automated access
in its terms, and does not block server requests.

## 1. Feasibility matrix

| County | Signal | Source | Automatable | Data quality | Notes |
|---|---|---|---|---|---|
| Fulton | Foreclosure notices | **fultonneighbor.com** (South Fulton Neighbor, legal organ since 2024) — public "Legals" RSS of individually posted notice PDFs | Partial | High (full notice text, sale date, address, parties, law firm file no.) | Only notices posted as individual PDFs appear in the feed; the weekly legal section is in the subscriber e‑Edition. Aggressive rate limiting (HTTP 429) on `/search/` and `/classifieds/` from datacenter IPs; robots.txt blocks named AI crawlers. See section 4. |
| Fulton | Foreclosure notices | GeorgiaPublicNotice.com (statewide index run by the Georgia Press Association) | **No** | High | Free search, but its Terms of Use prohibit scraping, automated collection and incorporation into a database. Manual use only. See section 5. |
| Fulton | Eviction filings/hearings | **magistratefulton.org** — daily dispossessory calendars (CivicPlus DocumentCenter, Word files) | Yes | Medium (case number, plaintiff caption, filed date; hearing date from title) | Hearing stage only. No writ/execution status online. |
| Fulton | Eviction writs / executions | Fulton County Magistrate Court Odyssey portal (portal-gafulton.tylertech.cloud) | No | High | Requires registration + login; not automated. |
| Fulton | Eviction executions | Fulton County Marshal's Department writ list | Upload | High (writs received / scheduled) | Provided on request from the Marshal's civil division (FCMD.Evictions@fultoncountyga.gov, 404‑612‑4451). Upload the list in the Admin tab. |
| Fulton | Owner of record | Fulton County GIS parcel layer (ArcGIS REST, layer 11) | Yes | High (owner + mailing address) | Free, JSON, no login. |
| DeKalb | Foreclosure notices | **The Champion / dekalblegalnotices.com** — weekly legal section PDF (WordPress) | Yes technically; **off by default** | High (whole legal section, ~40 pages) | The publisher sells access to the notices ($250/yr web, $350/2 yr, $39/yr mail+PDF, $10/24 h); the PDFs are reachable without a login but the notices page sits behind that paywall. Adapter ships disabled until Bridgeway subscribes or gets written permission; a subscriber can upload the PDF. |
| DeKalb | Eviction filings/hearings | **dekalbcountymagistratecourt.com** — dispossessory calendar PDFs (WordPress media API) | Yes | Medium‑high (case no., plaintiff, attorney, d/b/a community, case type, hearing date) | Hearing stage only. |
| DeKalb | Eviction writs / executions | DeKalb Odyssey portal (portal-gadekalb.tylertech.cloud) | No | High | Anonymous search exists but sits behind a JavaScript robot check; check by hand and record the stage with "Update stage". |
| DeKalb | Owner of record | DeKalb County GIS hosted Parcels layer 0 | Yes | High (owner, mailing, use/class, year built) | Free JSON. |
| Douglas | Foreclosure notices | **douglascountysentinel.com** classifieds (Paxton Media / TownNews) | Listing check only | High | Public HTML, but the site terms prohibit automated collection and it returns 429 to server IPs. The adapter records new notice URLs from one listing request per run so staff can pull them; bodies are ingested by upload. |
| Douglas | Eviction cases | courts.dcga.us/WebSearchMagistrate | **No** | — | Resets connections from cloud servers; no calendars are published. Adapter reports "unavailable"; Douglas cases enter through manual entry / upload. |
| Douglas | Owner of record | Douglas County GIS LandRecords layer 0 | Yes | High (owner, mailing, legal, homestead flag, deed date) | Free JSON. |
| Henry | Foreclosure notices | **henryherald.com** "Legals" RSS (Paxton / TownNews) | One request per run | High | Same terms and 429 behaviour as Douglas (the live runs got HTTP 429 on every attempt); foreclosure classifieds path is 404. Weekly legal section by e‑Edition upload. |
| Henry | Eviction hearings | **iframe.henrycountyga.gov** — per‑judge dispossessory calendar PDFs | Yes | Medium‑high (case no., plaintiff, a/a/f community, time) | Hearing stage only. The ASP.NET page renders its link tree only for Mozilla‑style user agents, so the worker identifies itself as `Mozilla/5.0 (compatible; BridgewayResearch/1.0; …)`. Person‑vs‑person rows are dropped (no reliable plaintiff/tenant boundary). |
| Henry | Eviction writs | Henry County civil e‑filing (micropact) | No | — | Behind Incapsula bot protection. |
| Henry | Owner of record | Henry County GIS Parcels layer 12 | Parcel only | Medium | Layer has no owner field; it links to qPublic, which sits behind a Cloudflare challenge. Owner name must be read by a person or come from the notice/plaintiff. |
| All | Corporate registrations | Georgia Secretary of State (ecorp), qPublic, OpenCorporates | No (403 / JS challenge from servers) | High | Used through the AI researcher's web search (citing the page) rather than scraped. |
| All | Eviction statistics | ARC / Atlanta Regional Commission eviction tracker | Aggregate only | — | County‑level counts, no cases. |

## 2. What the automation does with this

* **Discovery (Stage A)** runs every Tuesday and Thursday at 8:00 AM Eastern
  and reads: Fulton Neighbor legals RSS, Fulton magistrate calendars, DeKalb
  magistrate calendars, Henry magistrate calendars, Henry Herald legals RSS,
  one Douglas Sentinel listing check. The DeKalb Champion adapter exists but is
  disabled until the subscription question is settled.
* **Enrichment (Stage B)** looks up owner of record in the county GIS, then
  (when an Anthropic key is configured) researches each company once,
  caching the result for 90 days: website, main phone, management company,
  parent, business‑side contacts with source URLs and confidence.
* **Human‑assisted intake** covers what cannot be automated: the Fulton
  Marshal writ list, e‑Edition legal sections, court‑portal lookups, Douglas
  cases. The Admin tab accepts a single case, a CSV, or a PDF.

## 3. Recommendation

| Priority | Recommendation | Cost |
|---|---|---|
| 1 | Keep the free, automatable sources above running (already on). | $0 |
| 2 | Ask the Fulton County Marshal's civil division for the weekly writ execution list and upload it; this is the single best "eviction is really happening" signal in the largest county. | $0 |
| 3 | Decide on DeKalb Legal Notices: **$39/yr** (mail + PDF) or **$250/yr** (web). Advantages: the whole DeKalb legal section every week (all foreclosure notices, not just posted PDFs); the adapter is already written. Disadvantages: recurring cost; the terms should be read for database‑use language before automating — otherwise a subscriber uploads the PDF weekly. **Not purchased; needs your approval.** | $39–$250/yr |
| 4 | Fulton Neighbor e‑Edition subscription for the weekly legal section (price not published on the pages reachable from a server; Legals desk 470‑990‑4415, Legals@fultonneighbor.com). Advantages: complete Fulton foreclosure list. Disadvantages: subscriber terms almost certainly prohibit automated download, so it stays an upload workflow. **Not purchased.** | Unknown |
| 5 | GeorgiaPublicNotice.com "Smart Search" email alerts are free and useful for a person, but the alerts and the site cannot be fed into the database under its terms. | $0, manual |
| — | Paid data vendors (PropertyRadar, ATTOM, RealtyTrac‑style feeds, court‑record aggregators) were not evaluated in depth because the default budget is $0; they would mainly add DeKalb/Fulton foreclosure completeness that the two subscriptions above already provide more cheaply. | — |

## 4. Fulton Neighbor (fultonneighbor.com) — detailed findings

* **Role.** South Fulton Neighbor became the Fulton County legal organ in
  2024; foreclosure advertisements for Fulton run there.
* **Structure.** TownNews/BLOX site. Legal notices exist in two places:
  individually posted PDF "assets" under `/legals/` (public, each with a
  download link on `bloximages.newyork1.vip.townnews.com`), and the weekly
  legal section inside the e‑Edition (`eedition_courtcalendar`, pages
  B01–B12), which answers "your subscription does not include this content"
  without a login.
* **Public feed.** `search/?f=rss&t=pdf&c=legals&l=50&s=start_time&sd=desc`
  returns the posted notice PDFs as RSS. The adapter reads that feed once per
  run, fetches only items it has not seen, and extracts the notice fields from
  the PDF text. **Observed in the live runs (2026‑09‑08):** the feed answered
  HTTP 429 to the Supabase edge runtime on every attempt, including after the
  15 s and 30 s back‑offs, so from a cloud IP the feed is not currently
  usable. The adapter stays enabled (it costs one request per run and will
  pick up notices if the limit lifts), but Fulton foreclosure coverage today
  depends on the upload path until the publisher grants access.
* **Access controls.** `robots.txt` disallows several named AI crawlers
  (ClaudeBot, anthropic‑ai, GPTBot and others), `/classifieds/*?` and
  `/tncms/search/`. The site rate‑limits datacenter IPs with HTTP 429 on
  `/search/` and `/classifieds/`. The adapter therefore uses a 12‑second gap
  between requests to the host, honours 429 by stopping for the run, and
  never fetches the classifieds or e‑Edition sections.
* **Terms.** The terms page is JavaScript‑rendered and could not be read from
  a server; the publisher's sister TownNews/Paxton sites prohibit automated
  access in their terms. Treat the RSS as tolerated‑public, and get written
  permission (or the e‑Edition subscription plus an upload workflow) before
  relying on anything beyond the feed.
* **Contacts.** Legals@fultonneighbor.com, 470‑990‑4415.
* **Recommendation.** Keep the RSS adapter (free, polite, low volume). For
  completeness, subscribe to the e‑Edition and upload the weekly legal section
  through the Admin tab; the AI extractor turns the whole section into
  individual leads.

## 5. GeorgiaPublicNotice.com — findings

* Free statewide search of legal notices (Foreclosures = category 16; county
  checkbox indexes Fulton 59, DeKalb 43, Douglas 47, Henry 74) and free
  "Smart Search" email alerts.
* The **Terms of Use** prohibit screen scraping, automated collection,
  incorporation into a database and commercial redistribution. Its WebForms
  search also failed with a server error when driven programmatically. It is
  therefore **not automated** and is not a dependency of this system; it is a
  good manual cross‑check for a person.

## 6. Data sources that are deliberately not used

* Tenant‑side information of any kind (names, phones, emails, household
  details). Calendars are parsed plaintiff‑side only.
* People‑search / skip‑trace databases.
* Anything behind a login, paywall, CAPTCHA, bot challenge or robots rule.
