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

## 3. Texting — confirmed and switched ON

404-565-4216 is a **Google Voice** number. It receives texts and **MMS photos** and forwards them to info@bridgeway404.com, so the website's "Text photos" buttons are back on. "Email photos" (a pre-filled email to info@) stays visible as the alternative wherever photos are requested. One CSS rule turns texting off again if ever needed (see README).

Whoever answers must watch the Google Voice app or the "New text message" emails in info@.

## 4. Notification recipients (Netlify rule change, Nov 3 2026)

New Netlify email-notification recipients must be **active members of the Netlify team** that owns the project (`michael-glzfwwe's team`). Keep the setup to a single member recipient:

| Recipient | How |
|---|---|
| **info@bridgeway404.com** | Invite it to `michael-glzfwwe's team` and accept from info@ (it already has a Netlify login). It receives **all five** form notifications. |
| michael@ / jmays@ | **No Netlify seat needed.** Gmail filters in info@ forward residential and commercial leads to them (each forwarding address must be confirmed once in Gmail). |
| Sistamatic Organizing | Not until a data-sharing agreement exists. Nominations are never forwarded. |

Check the team's plan for member limits or seat costs before inviting anyone beyond info@.

## 5. The simplest reliable process

```
Website form ──► Netlify (stores every submission, incl. spam)
                    │  email notification → info@ (team member), labeled subject
Text / MMS ─────────┤  Google Voice → info@ ("New text message from …")
                    ▼
             info@ Gmail filters → label + star + phone alert (+ forward copies)
                    │
   ┌────────────────┼───────────────────────────┐
   ▼                ▼                           ▼
RESIDENTIAL      COMMERCIAL                  SERVICE SATURDAYS
reply same       reply within 1 business     acknowledge within 3 business
business day     day; log in Admin →         days; owner-only tracking.
(call/text)      Prospects                   Never in sales records/Zapier
```

1. **Netlify → `storied-trifle-152147` → Forms → Submission notifications:** one email notification per form, all to info@bridgeway404.com. Subjects are set in the HTML:

   | Form | Subject |
   |---|---|
   | `quote-request` | NEW QUOTE REQUEST — junk removal / cleanout (#id) |
   | `furniture-assembly-request` | NEW ASSEMBLY REQUEST (#id) |
   | `commercial-partner-inquiry` | NEW COMMERCIAL PARTNER INQUIRY (#id) |
   | `service-saturdays-nomination` | Service Saturdays nomination (#id) |
   | `service-saturdays-community` | Service Saturdays community inquiry (#id) |

2. **Gmail filters in info@:**

   | Match | Action |
   |---|---|
   | `subject:("NEW QUOTE REQUEST" OR "NEW ASSEMBLY REQUEST" OR "Photos for my")` | Label **Leads/Residential**, star, never spam, forward to the scheduler |
   | `subject:"NEW COMMERCIAL PARTNER INQUIRY"` | Label **Leads/Commercial**, star, never spam, forward to michael@ and jmays@ |
   | `from:txt.voice.google.com` | Label **Leads/Texts** |
   | `subject:"Service Saturdays"` | Label **Service Saturdays**, never spam, **no forwarding** |

   Turn on phone notifications for the Leads labels.
3. **Queue owners and reply times:**
   - Residential: the scheduler, same business day.
   - Commercial: Jonathan/Michael, within 1 business day, logged in Admin → Prospects.
   - Nominations: Michael only.
4. **Weekly (5 min):** compare Netlify → Forms counts with the labels and check the **Spam** tab.
5. **Later (optional):** a Netlify webhook into the existing Supabase admin so commercial inquiries land in Prospects automatically.

## 6. Owner actions

See `LAUNCH-CHECKLIST.md`, which lists only what the owner must do.
