# Bridgeway 404 — Lead-Handling Audit & Launch Process (Nov 5 2026)

Read-only audit. Nothing was merged, deleted, sent or changed in Netlify, Gmail, Google Drive or Supabase.
Customer-level findings are reported to the owner separately and are not stored in this repository.

---

## 1. Netlify projects

| Item | Finding | Status |
|---|---|---|
| Production project | `storied-trifle-152147` (id `fd559e0f-8d9e-409e-9255-ae850a54526d`). Custom domain **bridgeway404.com**, linked to `Bridgeway404/Bridgeway-404-Site` (branch `main`). Last production deploy Sep 19 2026 (commit `97c3a98`). | ✅ Verified (Netlify API site lookup) |
| Owning team | `michael-glzfwwe's team` | ✅ Verified |
| Earlier project (May 2026) | Sent the May 31 "NEW QUOTE REQUEST" notifications (sender name "bridgeway404.com"), using an **older form layout** with fields such as "Can One Person Lift It?". The current site doesn't have those fields, so it was an earlier deploy or project. Its exact project name was not visible. | ⚠️ Partly verified |
| Other teams | Two empty "Credits Free" teams were created on Jun 4 2026 by sign-ups with info@bridgeway404.com (`info-vnzq5ac`, `info-eojb6bq`). A third team, "Bridgeway404's team", was created Nov 5 2026 by `support@logicalreasoninglab.com`; that is the account whose token was supplied for this audit. | ✅ Verified from email and API |
| Production form capture | On bridgeway404.com, Netlify has processed both live forms (`quote-request`, `furniture-assembly-request`): their `data-netlify` attributes are removed. **Form detection is on, so submissions are being stored.** | ✅ Verified (live HTML) |
| Redesign forms | All five forms are processed on Deploy Preview #8. The hidden subject, honeypot and form-name fields survive processing. | ✅ Verified (preview HTML) |

**Not yet verified:** the stored submissions (verified and spam) and the notification and webhook settings on `storied-trifle-152147`. The token supplied belongs to a Netlify user who is **not a member** of `michael-glzfwwe's team`. The audit stopped there and did not try to read another team's data.

## 2. Evidence about missed leads (May → Nov 5 2026)

| Source | What it shows |
|---|---|
| Netlify email notifications to info@ | Only **4**, all on **May 31**, all owner tests. None since. |
| "Bridgeway Quote Requests from Website" (Google Sheet, owner michael@) | **2 rows**, both owner tests from May 31. Last modified May 31 22:33. No website lead has reached it since. |
| Supabase `quotes` / `customers` / `invoices` | **0 rows**. No edge function receives website forms. |
| Zapier / Make | A Zapier account exists on info@ (marketing mail only, plus "Zapier MCP connected" in Aug). There are **no** Zap operation or error emails, and no Make account. No evidence any website → Zapier → Sheet pipeline exists. |
| Google Voice (404-565-4216 → info@) | **About 35 conversations with real people** since June, mostly two-way job scheduling, quotes, photos (MMS) and payments. This is the **channel actually producing jobs**. A few single inbound requests show no reply in email; replies sent from the Voice app don't appear in email, so they must be checked in Google Voice. |
| Sent mail | Personal follow-up and review requests to about 12 summer customers (Sep 9), and active commercial outreach. |

**Conclusion:**
- The website form → notification path has **not been observed working since May 31**.
- Whether real customers submitted the website form since then can only be settled by opening Netlify → Forms on `storied-trifle-152147`, including the **Spam** tab.
- Leads are clearly reaching Bridgeway by **text and phone**, and those are being worked.

## 3. Texting — new evidence

404-565-4216 is a **Google Voice** number. It receives texts and **MMS photos**, and forwards them to info@bridgeway404.com.

The website's SMS switch (`css/site.css`) can therefore be turned back on once the owner agrees. Remaining caveat: whoever answers must watch the Google Voice app or the "New text message" emails.

## 4. Notification recipients

- Netlify email notifications can go to **any address**; no Netlify team membership is needed.
- Team membership is only needed for people who must open the dashboard to view submissions and spam. **Keep that to the owner.**

| Recipient | Use |
|---|---|
| info@bridgeway404.com | Every form (the shared record) |
| michael@bridgeway404.com | Residential and commercial |
| jmays@bridgeway404.com | Residential (scheduling) and commercial outreach, if Jonathan owns it |
| Sistamatic Organizing | **Not** until a data-sharing agreement exists |

## 5. The simplest reliable process

```
Website form ──► Netlify (stores every submission, incl. spam)
                    │  email notification, one per form, labeled subject
                    ▼
             info@ (+ named owners) ──► Gmail filter → label + star + phone alert
                    │
   ┌────────────────┼───────────────────────────┐
   ▼                ▼                           ▼
RESIDENTIAL      COMMERCIAL                  SERVICE SATURDAYS
reply same       reply within 1 business     acknowledge within 3 business
business day     day; log in Admin →         days; track ONLY in a separate,
(call/text)      Prospects (existing          owner-only sheet. Never in sales
                 Supabase follow-up tool)    records, never in Zapier/Sheets
```

1. **One email notification per form** (Netlify → `storied-trifle-152147` → Forms → Submission notifications). Subjects are already set in the HTML:

   | Form | Subject | Send to |
   |---|---|---|
   | `quote-request` | NEW QUOTE REQUEST — junk removal / cleanout (#id) | info@, michael@, jmays@ |
   | `furniture-assembly-request` | NEW ASSEMBLY REQUEST (#id) | info@, michael@, jmays@ |
   | `commercial-partner-inquiry` | NEW COMMERCIAL PARTNER INQUIRY (#id) | info@, michael@, jmays@ |
   | `service-saturdays-nomination` | Service Saturdays nomination (#id) | info@ only |
   | `service-saturdays-community` | Service Saturdays community inquiry (#id) | info@ |

2. **Gmail filters in info@:**
   - `subject:(NEW QUOTE REQUEST OR NEW ASSEMBLY REQUEST OR "Photos for my")` → label **Leads/Residential**, star, never spam
   - `subject:"NEW COMMERCIAL PARTNER INQUIRY"` → label **Leads/Commercial**, star, never spam
   - `subject:"Service Saturdays"` → label **Service Saturdays**, never spam (kept apart from Leads)
   - `from:txt.voice.google.com` → label **Leads/Texts**

   Turn on phone notifications for the Leads labels in the Gmail app.
3. **Owner of each queue:** Residential: whoever schedules jobs (same business day). Commercial: Jonathan/Michael (1 business day), logged in Admin → Prospects. Nominations: Michael only.
4. **Weekly (5 min):** compare Netlify → Forms counts with the labels and check the **Spam** tab.
5. **Later (optional):** a Netlify webhook into the existing Supabase admin so commercial inquiries land in Prospects automatically. This is not needed for launch.

## 6. What the owner needs to do

- [ ] Sign in to Netlify as the user that owns `michael-glzfwwe's team` and open `storied-trifle-152147` → **Forms**.
  - Check verified **and spam** submissions since June. Those are your possibly missed leads.
  - Don't delete anything.
- [ ] To let Claude finish the audit read-only, create a short-lived personal access token **from that account** (User settings → Applications → Personal access tokens, 7-day expiry). Replace the saved `api.netlify.com` network secret on the "Bridgeway-404-Site" cloud environment, then revoke the token afterwards.
- [ ] Revoke the token from `support@logicalreasoninglab.com` if it isn't needed, and consider deleting the three empty extra Netlify teams.
- [ ] In Forms → Submission notifications, note any existing webhook (Zapier) or email notifications, then add the five email notifications above.
- [ ] Create the Gmail filters above.
- [ ] Check Google Voice for the few unanswered single texts reported separately.
- [ ] Decide whether to turn the website's "Text photos" buttons back on (section 3).
- [ ] After merging PR #8: one labeled test per form ("TEST — QA (delete me)"), confirm each email arrives, then delete the test entries.
