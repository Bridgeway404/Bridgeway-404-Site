# Bridgeway404.com — Launch Checklist

**Preview:** https://deploy-preview-8--storied-trifle-152147.netlify.app
**PR:** Bridgeway404/Bridgeway-404-Site#8 (draft — do not merge until every **Blocker** box is ticked)

> **Lead-handling audit (Nov 5):** see `LEAD-HANDLING.md`. Production project confirmed as `storied-trifle-152147` (team `michael-glzfwwe`); form capture verified live; notifications and past submissions still need the owner's Netlify access. 404-565-4216 is Google Voice and does receive texts and photos.

Legend: 🔴 **Blocker**: must be done before merging. 🟡 Strongly recommended before or at launch. ⚪ Can follow launch.

---

## A. Lead capture — make sure no inquiry is lost

### What was verified (read-only, Nov 5 2026)

- **info@bridgeway404.com is a real, working Google mailbox.** It received about 200 external threads in the last 14 days, mail is opened most days (the newest message today was already read), and replies are sent from it. "Email photos" links and Netlify notifications are addressed to this inbox.
- **The inbox has a monitoring gap.** Most recent inbound mail is **unread**, including messages that look like business opportunities (for example a general contractor's estimating department and PlanHub bid notices).
- **Netlify notification emails have reached this inbox only 4 times, all on May 31, 2026, and all owner tests.** None have arrived since. New Netlify teams were created on June 4, and today's site builds come from the Netlify site `storied-trifle-152147`. The most likely cause is that **email notifications were never set up on the current Netlify site**. It is also possible that no one has submitted the quote form since May. This can't be told apart without the Netlify dashboard.
- **The old notification subject was broken.** Netlify subject lines cannot include form fields such as a customer name, so `%{customer-name}` was shown literally. Every form now sets its own subject in the HTML; see the table in A3.

### Owner actions

- [ ] 🔴 **A1. Check for unseen leads now.** Netlify → project `storied-trifle-152147` → **Forms**.
  - Open `quote-request` and `furniture-assembly-request`.
  - Look for any submissions since June that nobody followed up on, and check **Spam submissions** as well.
- [ ] 🔴 **A2. Confirm this is the production site.** In the same project, **Domain management** should list `bridgeway404.com`. If it doesn't, find the project that does, because notifications must be set there.
- [ ] 🔴 **A3. Add email notifications for every form.**
  - Where: **Forms → Submission notifications → Add notification → Email notification**.
  - Choose a single form per notification (not "Any form") so each goes to the right people.
  - If Netlify shows a subject from the old setup, delete it; the HTML subject wins anyway.

  | Form | Email subject you'll see | Notify | Do **not** |
  |---|---|---|---|
  | `quote-request` | NEW QUOTE REQUEST — junk removal / cleanout (#id) | info@ + whoever schedules jobs | — |
  | `furniture-assembly-request` | NEW ASSEMBLY REQUEST (#id) | info@ + scheduler | — |
  | `commercial-partner-inquiry` | NEW COMMERCIAL PARTNER INQUIRY (#id) | info@ + Jonathan (commercial outreach) | — |
  | `service-saturdays-nomination` | Service Saturdays nomination (#id) | info@ only | send to a Zapier/Google Sheet, or to Sistamatic until agreed |
  | `service-saturdays-community` | Service Saturdays community inquiry (#id) | info@ | — |

  Replying to a notification goes straight to the person who filled in the form (Netlify uses the `email` field as Reply-To).
- [ ] 🟡 **A4. Zapier → Google Sheet.** If the lead sheet is still in use, check that the outgoing webhook exists on the *current* Netlify site (Forms → Submission notifications). If it was set up on the old site, it is gone too. Field names are unchanged, so the existing zap mapping still works. New fields (`subject`, and blanks in now-optional fields) are harmless.
- [ ] 🔴 **A5. Make sure email is watched.** With texting off, **email is the only photo channel**. In Gmail for info@bridgeway404.com:
  - Create a filter matching subject `NEW QUOTE REQUEST`, `NEW ASSEMBLY REQUEST`, `NEW COMMERCIAL PARTNER INQUIRY`, `Photos for my quote request` or `Photos for my assembly request`.
  - Have it apply a "Website leads" label, star the message, mark it important and never send it to spam.
  - Turn on phone notifications for that label.
  - Name one person who checks it at least twice each business day.
- [ ] ⚪ **A6. Texting.** Once 404-565-4216 is confirmed to receive texts and photos, flip the SMS switch at the top of `css/site.css` (instructions in the README).

---

## B. Test all five forms on the preview

Do this **after A3**, so the test also proves the notifications work. Use these labeled values in every test:
- **Name:** `TEST — QA (delete me)`
- **Phone:** `404-555-0100`
- **Email:** your own address

If the Zapier webhook is active, pause the zap first or delete the test rows afterwards.

| # | Where | Test | Expected |
|---|---|---|---|
| [ ] B1 | `/quote/` (Junk Removal tab) | Submit a quote request | Thank-you page loads; email **NEW QUOTE REQUEST** arrives; entry appears in Netlify Forms |
| [ ] B2 | `/quote/#assembly` | Submit an assembly request | Email **NEW ASSEMBLY REQUEST** |
| [ ] B3 | `/commercial/` → "Start an attorney referral inquiry" | Business type should already be "Eviction attorney"; tick 2 service needs; pick "How did you hear about us?" | Commercial thank-you page; email lists both service needs and the referral source |
| [ ] B4 | `/service-saturdays/#nominate` | Try submitting without the "not an appointment" box (should be blocked), then tick it and submit | Service Saturdays thank-you page; email arrives at info@ only |
| [ ] B5 | `/service-saturdays/#get-involved` | Submit the community form | Email **Service Saturdays community inquiry** |
| [ ] B6 | Thank-you page → **Email Photos Now** | Send a photo to yourself via the button | Mail app opens addressed to info@ with the subject pre-filled; the email lands under the "Website leads" label |
| [ ] B7 | Netlify → Forms | Delete the five test entries (and any test Sheet rows) | — |

---

## C. Phone test (iPhone and Android, 10 minutes)

Open the preview on a phone, or scan the QR code in the Netlify bot comment on PR #8.

- [ ] C1. The logo in the header is crisp and readable; the menu button opens a full-screen menu that closes cleanly.
- [ ] C2. The sticky bottom bar shows **Call · Photos · Get a Quote**. **Call** dials 404-565-4216; **Photos** opens an email to info@.
- [ ] C3. On `/commercial/` the bar's gold button reads **Partner Inquiry** and jumps to the form.
- [ ] C4. Quote form: the keyboard shows numbers for phone, fields don't zoom in, both tabs fit, and the submit button is reachable.
- [ ] C5. No sideways scrolling on Home, Services, Commercial, Service Saturdays, About and Quote.
- [ ] C6. Pages load reasonably on cellular data.

---

## D. Representations — approve what the site says

Tick each item to approve it, or note the change you want. Anything not approved should be removed before launch.

**Company**
- [ ] 🔴 "Locally owned"; "Free quotes"; "price confirmed before any work begins"
- [ ] 🔴 About page: "The 404 in our name is Atlanta's area code, and it's there on purpose"; values ("We show up in the window we promise…")
- [ ] 🟡 Service-area cities: Atlanta, Decatur, Sandy Springs, Marietta, Smyrna, Roswell, Alpharetta, East Point, College Park, Stockbridge, Lithonia (carried over from the old site)
- [ ] 🟡 Instagram @bridgeway404 is live (linked in the footer and the contact strip)

**Services**
- [ ] 🔴 Garage / basement / attic cleanouts, whole-property and estate cleanouts
- [ ] 🔴 **Labor-only help** (moving heavy items, loading/unloading a truck the customer has arranged) — labeled as labor only, with no transport of household goods

**Commercial page**
- [ ] 🔴 Services offered: rental turnovers, vacant properties, bulk items, storage units, **light post-renovation debris**, estate cleanouts, recurring support
- [ ] 🔴 Property managers: "scheduled around your make-ready calendar", "one point of contact across all of your properties"
- [ ] 🔴 Eviction attorneys: post-possession cleanouts at the property owner's direction; "does not provide legal services or carry out evictions"
- [ ] 🔴 Storage operators: cleanouts after the lien process and written authorization; "several units in a single visit when your schedule allows"
- [ ] 🔴 Investors/realtors: walk-through to confirm what stays; quotes from photos
- [ ] 🔴 FAQ: "No long-term contract — start with a single job"; per-job pricing; "tell us your vendor requirements and we'll respond with what we can provide" (no insurance, licence or W-9 is claimed)

**Service Saturdays**
- [ ] 🔴 **Sistamatic Organizing has approved** use of its name, logo and role description ("brings professional organizing expertise"). If not approved by launch day, remove the partner logo and name first.
- [ ] 🔴 **Nomination-data sharing with Sistamatic is agreed.** The privacy policy (section 5) says nominations *may* be shared with them. If they won't be, the paragraph must change.
- [ ] 🔴 "Free for seniors selected"; self-nominations allowed; "if the senior doesn't know yet, we'll talk with you before contacting them"; "never used for marketing"
- [ ] ✅ No dates are published (confirmed)

**Already handled:** no prices, no texting, no moving/transport claims, no licensing, insurance or background-check claims.

---

## E. Admin / Supabase security (separate from the website merge; the admin panel is unchanged by PR #8)

Verified read-only on project `bridgeway-404`:
- Every table has row-level security, and every policy requires an allowlisted admin.
- Views can't bypass it.
- No anonymous access is possible.

- [ ] 🟡 **E1. Review the account that isn't on the admin allowlist:** `michael@bridgeway404.com`.
  - Created 2026-08-25 02:56 UTC; signed in once, on the same day; email/password sign-in.
  - It can read **no data**. It was not changed or deleted.
  - Find it in Supabase → **Authentication → Users**. If it's yours and not needed, you may delete it there. If it should be an admin, add it to the allowlist.
- [ ] 🟡 **E2. Turn off public sign-ups.** Supabase → **Authentication** → sign-in / providers settings → turn off **"Allow new users to sign up"**. This is safe: team members are created by the admin panel's `create_team_member` function, and login uses email and password, so nothing depends on public sign-up.
- [ ] ⚪ **E3. Leaked-password protection** (Supabase → Authentication → password security → "Prevent use of leaked passwords").
  - It is only available on the **Pro plan and above**.
  - Even on Pro, it doesn't check passwords set by the admin panel's own `create_team_member` / `reset_team_password`, which already require 10+ characters.
  - On the current plan, the practical protection is using unique, password-manager-generated passwords for every admin. Optionally set the minimum password length and required characters in the same settings page, which is available on all plans.

---

## F. Netlify account

- [ ] 🟡 **F1. Credits.** The team is on the credit-based **Free** plan: 300 credits a month, hard limit. Form submissions are free and unlimited, but each **production deploy costs 15 credits** and traffic uses credits too. **If credits run out, Netlify pauses the whole site, forms included.** Check Team → Billing / Usage before merging. Merging PR #8 is one production deploy.
- [ ] ⚪ F2. Netlify → Forms → enable "Form detection" if it isn't already on (it must be, since previews detect the forms).

---

## G. Go / no-go

- [ ] 🔴 All 🔴 items in sections A–D are done
- [ ] 🔴 Owner approves the preview visually (desktop and phone)
- [ ] Mark PR #8 "Ready for review", merge, and watch the production deploy. Then repeat **one** form test (B1) on bridgeway404.com and delete it.
- [ ] ⚪ Submit `https://bridgeway404.com/sitemap.xml` in Google Search Console, and update the website link on the Google Business Profile and Thumbtack if needed.
