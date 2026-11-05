# Bridgeway404.com — Owner Launch Checklist

**Preview:** https://deploy-preview-8--storied-trifle-152147.netlify.app
**PR:** Bridgeway404/Bridgeway-404-Site#8 (draft, unmerged; Claude will not merge it)

This lists **only what needs you**. Everything else is done and verified (see `LEAD-HANDLING.md`, `QA-REVIEW.md`).
Do the steps in order: notifications must exist before the form test can prove them.

---

## 1. Netlify access and history (about 15 min)
- [ ] Sign in to Netlify as the user that owns **`michael-glzfwwe's team`** and open project **`storied-trifle-152147`** (it serves bridgeway404.com).
- [ ] **Forms → each form → Verified and Spam submissions since June.** These are your possibly missed website leads. Don't delete anything.
- [ ] **Forms → Submission notifications:** note anything already there (old email addresses, a Zapier webhook).
- [ ] *(Optional, lets Claude audit the history read-only)*
  - Create a personal access token from **this** account with a 7-day expiry (User settings → Applications).
  - Replace the `api.netlify.com` secret on the **Bridgeway-404-Site** cloud environment.
  - Revoke the token afterwards.
- [ ] Revoke the token from `support@logicalreasoninglab.com` if you don't need it. It cannot see your site.

## 2. Notification recipient (Netlify's Nov 3 rule)
- [ ] **Team → Members → Invite `info@bridgeway404.com`**, then accept the invite while signed in as info@. Check whether your plan limits or charges for members first.
- [ ] Add **five email notifications**, one per form, all to **info@bridgeway404.com**:
  - `quote-request`
  - `furniture-assembly-request`
  - `commercial-partner-inquiry`
  - `service-saturdays-nomination`
  - `service-saturdays-community`

  Subjects are already built into the forms.

## 3. Gmail in info@bridgeway404.com (about 10 min)
- [ ] Create these filters (details in `LEAD-HANDLING.md` §5):
  - **Leads/Residential** (quote, assembly, "Photos for my…"): star, never spam, forward to the scheduler
  - **Leads/Commercial**: star, never spam, forward to michael@ and jmays@
  - **Leads/Texts** (`from:txt.voice.google.com`)
  - **Service Saturdays**: never spam, **no forwarding**
- [ ] Confirm the forwarding addresses when Gmail asks, and turn on phone notifications for the Leads labels.

## 4. Test all five forms on the preview
Use the name **`TEST — QA (delete me)`**, phone `404-555-0100`, and **a real email address you control**. Spam filtering can hold back "example.com" addresses, and spam submissions don't send notifications.

| # | Page | Expected email in info@ (with Reply-To = your test address) |
|---|---|---|
| [ ] 1 | `/quote/` (Junk Removal tab) | NEW QUOTE REQUEST — junk removal / cleanout (#…) |
| [ ] 2 | `/quote/#assembly` | NEW ASSEMBLY REQUEST (#…) |
| [ ] 3 | `/commercial/` → an audience button (business type pre-filled) | NEW COMMERCIAL PARTNER INQUIRY (#…) |
| [ ] 4 | `/service-saturdays/#nominate` | Service Saturdays nomination (#…) |
| [ ] 5 | `/service-saturdays/#get-involved` | Service Saturdays community inquiry (#…) |

- [ ] Each email lands under the right Gmail label, and the commercial and residential copies reach the forwarded people.
- [ ] If an email is missing, look in Netlify → Forms → **Spam** before anything else.
- [ ] Afterwards, delete the five test entries in Netlify. That's your call; Claude won't delete submissions.

## 5. Phone check (5 min, on your phone)
- [ ] The bottom bar shows **Call · Text · Get a Quote**. Call dials 404-565-4216; Text opens Messages to it.
- [ ] On the thank-you page (after test 1): **Text Photos Now** opens Messages; **Email Photos Now** opens an email to info@.
- [ ] Send one test text with a photo and confirm it arrives in Google Voice and under **Leads/Texts**.

## 6. Approve what the site says
Tick each item to approve, or tell Claude what to change or remove.
- [ ] "Locally owned"; "Free quotes"; "price confirmed before any work begins"
- [ ] Services: garage, basement and attic cleanouts; property and estate cleanouts; **labor-only help** (no transport of household goods)
- [ ] Commercial page:
  - turnovers, vacant properties, storage units, **light post-renovation debris**, estate cleanouts, recurring support
  - each audience panel's "How we help" bullets
  - FAQ ("no long-term contract — start with one job")
- [ ] **Sistamatic Organizing** approves its name, logo and role description. If it hasn't by launch day, tell Claude to remove them.
- [ ] Nomination data **may be shared with Sistamatic** (privacy policy §5). Keep or remove that sentence.
- [ ] Instagram @bridgeway404 is the right handle; the city list is correct.

## 7. Go
- [ ] Check Netlify **Usage / credits** for the team (a production deploy costs 15 credits; running out pauses the site).
- [ ] Approve the merge. Claude (or you) marks PR #8 ready and merges it.
- [ ] After the live deploy, repeat **one** test (form 1) on bridgeway404.com, then delete it.

---

### Not launch blockers (when convenient)
- Check Google Voice for the few unanswered single texts reported separately. Contacting them is your decision.
- Supabase:
  - review the `michael@bridgeway404.com` sign-in account
  - turn off public sign-ups (safe for the admin panel)
  - leaked-password protection needs the Pro plan
- Delete the three empty extra Netlify teams.
