# Bridgeway404.com — Launch Go / No-Go (Nov 5 2026)

**Preview:** https://deploy-preview-8--storied-trifle-152147.netlify.app
**PR:** Bridgeway404/Bridgeway-404-Site#8 — draft, unmerged. **Merging requires the owner's explicit authorization.**

## Verified (Netlify API with the owner's token, live HTML, Gmail, Drive)

| Check | Result |
|---|---|
| Production project | `storied-trifle-152147` (team `michael-glzfwwe`, owner michael@bridgeway404.com), custom domain bridgeway404.com, since May 31 |
| All five forms registered in Netlify | ✅ `quote-request`, `furniture-assembly-request`, `commercial-partner-inquiry`, `service-saturdays-nomination`, `service-saturdays-community` |
| Five labeled test submissions on the preview (Nov 5, 23:35 UTC) | ✅ All five stored as **verified**, none flagged as spam; correct fields, including multi-select values, consent = Yes, labeled subjects, Reply-To set |
| Email delivery to info@ | ✅ "NEW QUOTE REQUEST — junk removal / cleanout (#37)" and "NEW ASSEMBLY REQUEST (#1)" arrived within seconds |
| Email delivery to michael@ (all forms) | ⏳ **Owner to confirm**: 5 emails (see list below) |
| Zapier → "Bridgeway Quote Requests from Website" sheet | ✅ Working. With owner approval, the webhook was limited to the two quote forms. Only the quote and assembly tests reached the sheet; nominations and commercial inquiries did not. |
| Historical website inquiries (May 31 → Nov 5) | ✅ Only 6 verified submissions, all owner tests on May 31. 30 spam-flagged submissions (Aug–Nov) were reviewed, and **all are bot spam** (foreign-language "price?" templates, link spam, scams). **No real website inquiry was missed.** |
| Commercial page claims | ✅ Approved by the owner as written (Nov 5) |
| Sistamatic Organizing name, logo, role and nomination-data sharing | ✅ Approved by the owner (Nov 5); draft notes removed |
| Texting | ✅ On. 404-565-4216 is Google Voice and receives texts and MMS; email photos remains as the alternative |
| Netlify credits | ✅ 0 of 300 used this cycle; a production deploy costs 15 |
| Site checks | ✅ check-site, 146/146 metadata, 83/83 browser checks, CSP, 76/76 worker tests |

Final notification setup (production):
- **email to info@**: `quote-request` and `furniture-assembly-request`
- **email to michael@**: all forms
- **Zapier webhook**: `quote-request` and `furniture-assembly-request` only

## Owner actions — what is left

### Before merging (go/no-go)
- [ ] **Confirm michael@bridgeway404.com received five emails** (check Spam/Promotions too):
  1. NEW QUOTE REQUEST — junk removal / cleanout (#37)
  2. NEW ASSEMBLY REQUEST (#1)
  3. NEW COMMERCIAL PARTNER INQUIRY (#1)
  4. Service Saturdays nomination (#1)
  5. Service Saturdays community inquiry (#1)

  If any is missing, don't merge; tell Claude which one.
- [ ] **Authorize the merge** in writing.

### After merging (same day)
- [ ] Submit **one** real-browser quote on bridgeway404.com from your phone (name "TEST — QA (delete me)"). Confirm it reaches michael@, info@ and the sheet, and try **Text Photos** once.
- [ ] Delete test data when you're ready. Claude did not delete anything.
  - **Netlify** → `storied-trifle-152147` → Forms: the five Nov 5 tests plus the six May 31 tests (and the post-launch test).
  - **Google Sheet** "Bridgeway Quote Requests from Website": the test rows.

### Soon after launch (not blockers)
- [ ] **Update the Zap's field mapping** in Zapier. It was built for an older form, so "What needs to go?" (`items_detail`), volume, and the assembly fields (`assembly_item_type`, `service_area`) are not mapped to sheet columns. Emails contain every field in the meantime.
- [ ] **Gmail filters** in info@ and/or michael@ to label, star and alert on the five subjects, plus `from:txt.voice.google.com` (see `LEAD-HANDLING.md` §5).
- [ ] **Google Voice**: check the few unanswered single texts reported separately. Contacting them is your decision.
- [ ] **Supabase**:
  - review the `michael@bridgeway404.com` sign-in account
  - turn off public sign-ups
  - leaked-password protection needs the Pro plan
- [ ] **Netlify housekeeping**:
  - delete the three empty test projects in your team (`astonishing-sunburst`, `sage-marigold`, `frabjous-vacherin`) and the two empty June "info-…" teams
  - revoke the `logicalreasoninglab` token
  - after launch, revoke the 7-day token you gave Claude

## Merge steps (once authorized)
1. On GitHub, open PR #8, click **"Ready for review"** (it is a draft), then **"Merge pull request"** → **"Confirm merge"**. Keep the branch until the live check passes.
2. Netlify builds `main` automatically (about 1 minute). Watch Netlify → `storied-trifle-152147` → Deploys until the new deploy shows **Published**.
3. Open https://bridgeway404.com on a phone and a computer. Do a hard refresh: the CSS and JS aren't cached long, and images use new filenames.
4. Run the one post-launch test above.
5. **Rollback, if anything is wrong:** Netlify → Deploys → select the Sep 19 deploy (commit `97c3a98`) → **"Publish deploy"**. This restores the old site instantly without touching GitHub.
