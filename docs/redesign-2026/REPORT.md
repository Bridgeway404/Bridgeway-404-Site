# Bridgeway404.com Redesign — November 2026

Branch: `claude/nice-clarke-kqkdl4` · Not merged, not deployed to the live domain.

> **QA update:** see `QA-REVIEW.md`. Texting is switched **off** until 404-565-4216 is confirmed to
> receive texts; "Email photos" replaces "Text photos" everywhere. The header logo is larger, the
> Commercial Partners page was reworked for its four priority audiences, and a draft PR with a live
> Netlify Deploy Preview is open.
Screenshots: `docs/redesign-2026/screenshots/` (desktop at 2×, iPhone 13, and full-page captures).

---

## 1. Website audit — what was wrong with the old site

| Area | Finding |
|---|---|
| **Branding** | No logo anywhere on the page — the header was plain text ("Bridgeway 404 Junk Removal"). Colors were a muted purple (`#6b3d9a`) and dull gold (`#c49a30`) that don't match the business card or flyers. The share card used an older logo variant ("Strong Service. Clean Results."). The favicon had a fake checkerboard baked into the image. |
| **Positioning** | One page aimed only at small residential pickups (couch, mattress, curbside). Nothing for property managers, investors, realtors or attorneys — even though the admin panel is built around exactly that outreach. "Property cleanouts" (on the business card) wasn't mentioned. No Service Saturdays. |
| **Imagery** | Gallery was mostly Unsplash stock photos labeled as "Our Work". |
| **Quote flow** | One long form (14 fields, 11 of them required — including email, even for people who asked to be texted). "Request a Quote" opened a modal that then scrolled to the form — an extra step. |
| **Bug** | `privacy_consent_granted` was meant to record Yes/No for the CRM sheet, but no script ever set it — every lead was recorded as **"No"**. |
| **Trust** | No reviews, no Thumbtack link, no team/about story, "Map coming soon" placeholder, a "Terms" footer link that redirected to the homepage, an unverified promise ("Most requests receive a response within a few hours"). |
| **SEO** | A single URL for every service; no structured business data, no sitemap, no robots.txt (so `/admin` wasn't excluded there). |
| **Mobile** | Workable, but no persistent call/text access while scrolling; "Call Now" hidden in sections. |

**Kept on purpose:** Netlify hosting and Forms, both existing form names and every field name (so the Zapier/Sheets mapping keeps working), the restricted-items list and confirmation, the desktop call modal, the privacy commitments, all redirects and security headers, the honeypot spam protection, and the real assembly photos.

**Untouched:** everything in `admin/`, `supabase/` and `docs/` (other than this folder), and `favicon.png` (the admin panel uses it).

---

## 2. Branding transformation

- **Real logo, not a redraw.** No clean original logo file existed in the repo (`favicon.png` has a baked-in checkerboard), so every variant was cut from your `bridgeway404-primary-logo-crop.png` by removing the white background mathematically — the skyline, arch, lettering and tagline are the original pixels.
  - Full logo and compact mark for **light** backgrounds.
  - **Dark-background** versions (black → white, purple brightened) — matching how your own Thumbtack and moving flyers show the logo on black.
  - Skyline-only cut used as a faint watermark in heroes and bands (the "tasteful Atlanta skyline motif").
  - Favicon uses the purple "404" from the logo (the skyline is unreadable at 16 px); phone home-screen icons use the full mark.
- **Colors sampled from your graphics** and stored once as CSS variables in `css/site.css`:
  - Logo purple `#5E1C78` (primary), deep flyer purples `#240842` / `#16052A` (heroes, bands), dark-background violet `#A755E7`.
  - Logo gold `#FDBC08` for buttons and accents (always with dark text for contrast).
  - Black `#050505`, white, and a warm cream `#FBF7EE` (from the Service Saturdays graphic).
- **Typography** follows the flyers: bold condensed uppercase headlines (Barlow Condensed) with clean Inter body text, plus the letter-spaced "A CLEANER TOMORROW." tagline.
- **Business-card motifs:** the purple-and-gold corner sweep from the card appears at the bottom of each hero; the header carries a purple/gold rule.
- **One tagline:** standardized on "A Cleaner Tomorrow." The older "Strong Service. Clean Results." is no longer used on the site.
- **New share card** (`assets/bridgeway404-social-preview-v3.png`) shows the primary logo, the headline and 404-565-4216.

---

## 3. Business strategy — three audiences

| Audience | What the site now does |
|---|---|
| **Residential** | Homepage leads with "Junk Removal & Property Cleanouts Across Metro Atlanta" and four actions: Request a Quote, Call, Text Photos, Explore Commercial Services. A Services page covers junk, furniture/mattress, garage/basement/attic, apartment move-out, property/estate, curbside, assembly and heavy-lifting help, each linking to the quote form with that service pre-selected. |
| **Commercial (priority)** | A dedicated `/commercial/` page built around **"Become a Bridgeway 404 Commercial Partner"**: who we serve (property managers, apartment communities, investors, realtors, eviction attorneys, storage operators, contractors/restoration, organizers, commercial owners), the services (turnovers, vacant properties, bulk items, storage units, light post-renovation debris, estate cleanouts, recurring support), a four-step partnership process, and a **separate partner inquiry form** that collects company, business type, locations, number of properties, anticipated volume, timeline and vendor requirements. It invites them to tell us their onboarding paperwork rather than claiming insurance or certifications. |
| **Community** | A `/service-saturdays/` page: what it is, why we do it, the roles of Bridgeway 404 and Sistamatic Organizing, who it's for, how nominations work, a **senior nomination form** (with a required "this is not an appointment" acknowledgement and a "does the senior know?" question), and a **community organization** form. No dates are published. |

---

## 4. What was built

**Pages:** `/` · `/services/` · `/commercial/` · `/service-saturdays/` · `/about/` (story, values, real job photos at `#our-work`, reviews link, team section ready for names/photos) · `/quote/` · three thank-you pages · restyled `privacy-policy.html` (updated to disclose the new forms and partner sharing).

**Navigation:** Services · Commercial Partners · Service Saturdays · About & Our Work · phone · **Get a Quote**. I folded "Our Work" into About (and a homepage section) instead of a separate page — with three real photos today, a standalone gallery page would look thin and hurt credibility. It can become its own page once you have more job photos.

**Forms (all Netlify Forms):**

| Form | Status |
|---|---|
| `quote-request` | Same name and field names. Now 2 short steps (what/where/when → name/phone/contact). Email is optional unless they pick "Email". Volume, location, access and notes moved under an optional "Add more details". New service options added. |
| `furniture-assembly-request` | Same name and field names, restyled, email optional. |
| `commercial-partner-inquiry` | **New.** |
| `service-saturdays-nomination` | **New.** |
| `service-saturdays-community` | **New.** |

**Photos:** Instead of an upload field (Netlify caps a whole submission at 8 MB, and one modern phone photo can exceed that and lose the lead), every quote touchpoint has a **Text Photos** button that opens the customer's messaging app addressed to 404-565-4216 with a pre-filled message: on the form, on the thank-you page ("One more step: send photos"), in the header, and in the sticky mobile bar.

**Mobile:** a sticky **Call · Text · Get a Quote** bar on every page, a full-screen menu with call/text buttons, 16 px form fields (no iOS zoom), and no horizontal scrolling at 390 px.

**SEO:** unique titles/descriptions/canonicals per page, `HomeAndConstructionBusiness` structured data (name, phone, email, slogan, logo, 11 service-area cities, Thumbtack and Instagram profiles), Service structured data, `sitemap.xml`, `robots.txt` (disallows `/admin/`), and friendly redirects (`/contact`, `/get-a-quote`, `/partners`, `/commercial-partners`, `/about-us`, `/nominate`). Old `bridgeway404.com/#quote` links forward to `/quote/`.

**Accessibility & performance:** skip link, landmark regions, one H1 per page, alt text on every image, visible focus rings, keyboard-operable tabs/menu/modal, reduced-motion support. No framework and no new dependencies: one CSS file (~39 KB uncompressed) and one JS file (~7 KB). CSS/JS sit outside `/assets` so edits go live without the one-year cache.

**Maintainability:** header, footer and `<head>` links live once in `partials/` and are stamped into each page by `tools/sync-partials.py` (no build step on Netlify). `/partials/*` and `/tools/*` return 404 publicly.

---

## 5. Conversion improvements

1. **A shorter form.** The residential form shows 9 fields up front instead of 14 (the 4 optional detail fields are tucked away). Email is no longer required, and "Text" is pre-selected as the contact method. It fits in about a minute on a phone.
2. **Contact always in reach.** Call/text/quote is visible on every phone screen at all times.
3. **Photos without friction.** One tap opens a pre-addressed text, so people send photos right after submitting.
4. **The right form for each visitor.** Homeowners, property professionals and community partners each have their own path and form, so commercial leads arrive with the details you need to qualify them (volume, number of properties, timeline).
5. **Pre-selected services.** Every service card links to the quote form with that service already chosen.
6. **Credibility without exaggeration.** Real photos only, a Thumbtack link for reviews, a clear process, and a stated policy of confirming the price before work starts.
7. **Clean CRM data.** `privacy_consent_granted` now records "Yes" correctly.

---

## 6. Technical verification

| Check | Result |
|---|---|
| `tools/check-site.py` (new): links, images, icons, forms, legacy CRM field names, honeypots, success pages, H1/title/description/canonical, alt text, no stock photos | **Pass**: 10 pages, 5 forms. I injected faults on purpose to confirm it catches them. |
| `tools/verify-social-metadata.py` (updated to v3 card and all pages) | **146/146 pass** |
| `tools/e2e-check.js` (new, Playwright): every page loads with no JS errors and no horizontal scroll; JSON-LD parses; nav and call modal work; legacy `#quote` forwards; all 5 forms block empty submission and post the correct `form-name` and fields; consent mirror; email-required toggle; quote tabs; mobile bar, menu and 16 px fields | **66/66 pass** (submissions are intercepted locally and never reach Netlify) |
| Production Content-Security-Policy from `netlify.toml` applied to every public page and `/admin/` | **No violations** |
| Existing Supabase worker tests (auction-buyer 24, distressed 38, eviction-attorney 14) | **76/76 pass**. No files in `admin/`, `supabase/` or `docs/` were changed. |
| Visual review: desktop 1440 px and iPhone 13, every page | Done; screenshots in `docs/redesign-2026/screenshots/` |

The browser checks found and fixed two real bugs during the build: the mobile menu was clipped to about 140 px, and `/quote/#assembly` didn't switch tabs when you were already on the quote page.

**Still unverified (needs a real deploy or a real device):**
- Netlify registering the three new forms, and email notifications for them. Notifications must be added in the Netlify dashboard after the first deploy.
- Text-photo links on a physical iPhone/Android. They use the standard `sms:` format, tested only in emulation.
- **Thumbtack reviews.** Thumbtack is blocked from this build environment, so I couldn't read your reviews and published **no review text**. The site links to your profile instead.

---

## 7. Preview and repository

- **Branch:** `claude/nice-clarke-kqkdl4` (production `main` is untouched).
- **Local preview:**
  ```bash
  python3 -m http.server 8080
  ```
  Run it from the repo root, then open http://localhost:8080. Use a server, not double-click: the pages use root-relative paths.
- **Netlify preview:** opening a pull request from this branch gives you a Netlify Deploy Preview URL, if Deploy Previews are enabled (the Netlify default). That is also the safest way to test real form submissions before launch. Submissions from a Deploy Preview land in the same Netlify Forms inbox, so label your test entries.

---

## 8. Decisions that need the owner

1. **Phone and texting.** The site uses **404-565-4216** for calls **and** texts everywhere. Can that line receive texts and photos? If not, which number should the Text buttons use? 404-998-1348 (the direct line on your card and on the Service Saturdays flyer) is not published anywhere.
2. **Pricing.** No prices are published, and the $325 moving package and $100 deposit were not carried over. Please confirm that "free quotes" and "price confirmed before work begins" match how you operate, and decide whether to show a "starting at" price (Thumbtack lists $50).
3. **Moving and labor.** A "Heavy-Lifting Help" card offers moving items within a home and loading/unloading, worded to avoid regulated moving or transport. Keep it (as labor-only) or remove it?
4. **Service list.** Please confirm you actively offer: garage/basement/attic cleanouts, whole-property/estate cleanouts, storage-unit cleanouts, eviction/post-possession cleanouts, and light post-renovation debris.
5. **Service Saturdays.**
   - Has Sistamatic Organizing approved use of its name and logo, and the description of its role?
   - Is the program free for selected seniors, and are self-nominations allowed?
   - Is there an age or eligibility rule you want stated?
   - Do you want the Nov 7 / 14 / 21 dates from the flyer published?
   - The privacy policy now says nomination details may be shared with Sistamatic. Is that accurate?
6. **Credentials for commercial buyers.** Nothing about insurance, licensing or background checks is claimed. If you can provide a certificate of insurance or W-9 (or want to mention Thumbtack's background check), adding that to the commercial page would strengthen it.
7. **Small facts.** Is Instagram `@bridgeway404` live? Is the service-area city list (carried over from the old site) still right? Should team names/photos appear on About?

---

## 9. Next five improvements after launch

1. **Google Business Profile + review requests.** Send a review-request text after every job, and link the profile from the site. Reviews on Google drive local search more than anything on the website.
2. **Job-photo habit and case studies.** Take before/after photos on every job. Within a month you can build a real "Our Work" gallery and 2–3 commercial case studies (for example, a turnover in a set number of hours) to send to property managers.
3. **Pipe website leads into the admin panel.** A Netlify form webhook into a small Supabase function would put `commercial-partner-inquiry` submissions straight into the Prospects/Follow-Ups pipeline you already use.
4. **Local landing pages.** Add pages by city and service (for example "Junk Removal in Decatur" or "Apartment Turnover Cleanouts in Atlanta"), plus a one-page commercial capabilities PDF for outreach.
5. **Privacy-friendly measurement.** Add cookie-free analytics, then track calls, texts and form submissions to see which audience and page actually produce jobs. This requires a privacy-policy update.
