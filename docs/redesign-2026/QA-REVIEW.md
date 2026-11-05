# Redesign QA Review — November 2026

PR: Bridgeway404/Bridgeway-404-Site#8 (draft — not merged)
Deploy Preview: https://deploy-preview-8--storied-trifle-152147.netlify.app
(Netlify builds a fresh preview for every push to the PR branch; production is untouched.)

---

## 1. Preview

Netlify's GitHub integration is active for this repo (site `storied-trifle-152147`). It created
Deploy Preview #8 automatically, and its checks passed: 13 redirect rules processed without
errors, header rules passed, and all new pages were uploaded. A Deploy Preview is a separate URL;
it does not change bridgeway404.com or the production deploy.

## 2. Visual review against the brand graphics

Reviewed against the five supplied graphics, which are the brand's Instagram-style posts.
Instagram itself could not be opened from the build environment.

| Area | Before QA | Change |
|---|---|---|
| Header logo | 89×58 px desktop / 74×48 px mobile; the "BRIDGEWAY" letters were thin and hard to read | 120×78 px desktop / 89×58 px mobile; header height raised to match |
| Flyer echo | Brand colors were right, but none of the flyers' signature layout elements were used | Added the purple contact strip with gold icon circles and the letter-spaced "SERVING A STRONGER ATLANTA" (bottom of the Service Saturdays flyer) to every page |
| Service Saturdays | Generic cards | Icon row taken from the flyer: purple line icons, uppercase labels, gold dividers. The hero keeps the flyer's white "SERVICE", purple "SATURDAYS" and gold rule |
| Commercial page | Mobile sticky button sent property managers to the residential form | On the commercial page it now reads "Partner Inquiry" and jumps to the partner form |

Logo placement: the full logo (with tagline) appears in a white, gold-framed card in the homepage
hero (and on About and Service Saturdays), the compact mark is in every header, and the
dark-background version is in every footer.

## 3. Operational assumptions applied

- **Pricing:** none published anywhere.
- **Texting is unconfirmed:**
  - Every "Text" control sits behind one CSS switch (`.sms-on`, top of `css/site.css`) and is hidden.
  - **Email photos** (a pre-filled email to info@bridgeway404.com) shows in its place.
  - Copy no longer tells people to text photos.
  - The contact-method dropdown now defaults to **Call**. "Text" stays as a customer preference only.
  - `tools/check-site.py` fails if an untagged `sms:` link is ever added.
- **Labor-only help:** the card is now "Labor-Only Help" with a "Labor only" tag and the line
  "Moving services that transport household goods are not offered through this website." The
  quote-form option reads "Labor-only help (no transport)". No licensing, insurance or
  qualification claims appear anywhere.
- **Service Saturdays:** no dates published. An HTML comment marks the page as a draft pending
  Sistamatic approval and agreement on nomination-data sharing.

## 4. Lead-generation workflow

| Check | Result |
|---|---|
| All 5 forms: `data-netlify`, matching hidden `form-name`, honeypot, POST, existing success page | Pass (`tools/check-site.py`) |
| `quote-request` / `furniture-assembly-request` keep every field name used by Zapier/Sheets | Pass; field names unchanged. `item_location` and `volume_estimate` are now optional, so they can arrive blank. |
| Browser submission of every form (posts intercepted locally, nothing sent) | Pass: correct `form-name`, fields, multi-select checkboxes, `privacy_consent_granted = Yes` |
| Netlify form detection on the Deploy Preview | **Not directly verifiable from the build sandbox** (`*.netlify.app` is blocked). The static markup meets every Netlify detection requirement. Confirm in Netlify → Forms (see test plan) |

**Why no live test submissions were made:** Netlify fires form notifications for every verified
submission to a form, and its documentation does not exclude Deploy Previews. A test on the preview
would very likely email the team **and** fire the existing Zapier webhook into the Google Sheet. That
counts as modifying production lead records, so it was deliberately not done.

**Controlled test plan (owner, about 10 minutes):**
1. In Netlify → Forms, confirm all five forms are listed: `quote-request`,
   `furniture-assembly-request`, `commercial-partner-inquiry`, `service-saturdays-nomination`,
   `service-saturdays-community`.
2. Optionally pause the Zapier zap first.
3. On the Deploy Preview, submit one entry per form with the name **"TEST — QA (delete me)"** and
   the email `test@example.com`.
4. Confirm each appears in Netlify → Forms and that the notification email arrives.
5. Delete the five test entries in Netlify and any test row in the Google Sheet, then re-enable the zap.

## 5. Privacy — senior nominations

The nomination form collects:
- the senior's **first name only**
- a **general area** (no street address)
- whether the senior knows about the nomination
- the kinds of help needed
- a short description, with an explicit request to leave out medical or financial details

It never asks for an age, birth date or address (the browser test checks this). Next to the form,
a notice explains:
- nominations are used only to run the program and never for marketing
- they are shared, if at all, only with the program partner
- if the senior hasn't been told, the team speaks with the nominator first
- either person can ask for deletion

The privacy policy says the same.

Owner actions:
- **Do not route nominations into the shared leads Google Sheet.** Add an email notification only.
- Periodically delete nominations that won't be served from Netlify → Forms; Netlify keeps
  submissions until they are deleted.
- Confirm the data-sharing arrangement with Sistamatic before launch.

## 6. Admin access control (verified on the live Supabase project, read-only)

- **Every table** in `public` has row-level security enabled, and **every policy** requires
  `public.is_admin()` (a signed-in user on the `admin_users` allowlist). No policy grants anything
  to anonymous visitors.
- **Every view** is `security_invoker`, so views cannot bypass RLS.
- **`SECURITY DEFINER` functions** callable by signed-in users all check `is_admin()` internally.
  The worker functions that don't are not executable by anonymous or signed-in users at all.
- **The `/admin` pages** are static shells: anyone can load the HTML, but it holds no data and
  redirects to sign-in. The Supabase key in `admin/assets/config.js` is the publishable key, which
  is public by design. `robots.txt` and the `X-Robots-Tag` header only keep `/admin` out of search
  results; they are not the protection.
- **Supabase security advisor:**
  - "Leaked password protection" is **disabled**. Recommend enabling it (Supabase → Authentication → Policies).
  - There is **1 sign-in account that is not on the admin allowlist** (4 accounts, 3 admins). It can
    read nothing, but review it in Supabase → Authentication → Users and turn off public sign-ups
    if the team adds members through the admin panel.
- **Optional extra layer:** Netlify password protection for `/admin/*` on plans that support it.

## 7. Commercial conversion changes

- **Self-identification chips in the hero:** "I'm a: Property manager · Eviction attorney ·
  Storage operator · Investor or realtor".
- **Four audience panels** in place of one-line cards. Each covers the problem that audience
  faces, "How we help" bullets, and its own CTA that **pre-selects the business type** in the form.
  - Attorney panel: states that Bridgeway 404 does not provide legal services and removes items
    only at the owner's direction.
  - Storage panel: cleanouts happen only after the lien process is complete and removal is authorized.
- **"Questions vendors usually get" FAQ:** contracts, pricing, unattended access, onboarding
  paperwork and coverage — all answered without promising anything unverified.
- **"What we can't remove" notice** for property managers, plus a direct call/inquiry line for
  urgent units.
- **New optional form field `referral_source`** ("How did you hear about us?"), including
  "A Bridgeway 404 team member reached out", so outreach from the admin panel gets credit.
- Hero commitments reworded to remove the implied promise to match a partner's invoicing process.
