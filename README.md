# Bridgeway 404 — Website

One-page marketing and quote-request site for Bridgeway 404 (Metro Atlanta junk removal and furniture services).

---

## Files

| File | Purpose |
|---|---|
| `index.html` | The entire website — all sections, styles, and scripts in one file |
| `netlify.toml` | Netlify configuration (headers, redirects, build settings) |
| `README.md` | This file — deployment guide |

---

## Quick Start: Deploy to Netlify

### Option A — Drag and Drop (Fastest, no GitHub needed)

1. Go to [app.netlify.com](https://app.netlify.com) and log in.
2. Click **Add new site → Deploy manually**.
3. Drag the entire `bridgeway404-site` folder onto the upload area.
4. Netlify deploys instantly and gives you a temporary URL like `random-name.netlify.app`.
5. Test the site at that URL.
6. Connect your domain (see "Connect bridgeway404.com" below).

### Option B — GitHub (Recommended for ongoing updates)

#### Step 1: Create a GitHub repository

1. Go to [github.com](https://github.com) and sign in.
2. Click **New repository**.
3. Name it `bridgeway404-site` (or anything you like).
4. Set it to **Private** if you prefer.
5. Click **Create repository**.

#### Step 2: Upload your files to GitHub

If you have Git installed on your computer:

```powershell
# Open PowerShell and navigate to the site folder
cd "C:\Users\MStrickland\OneDrive - hallboothsmith.com\Desktop\bridgeway404-site"

# Initialize git, commit, and push
git init
git add .
git commit -m "Initial site launch"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/bridgeway404-site.git
git push -u origin main
```

Or upload manually via GitHub's web interface:
1. Open your new repo on GitHub.
2. Click **Add file → Upload files**.
3. Drag all three files (`index.html`, `netlify.toml`, `README.md`) into the upload area.
4. Click **Commit changes**.

#### Step 3: Connect GitHub to Netlify

1. Go to [app.netlify.com](https://app.netlify.com).
2. Click **Add new site → Import an existing project**.
3. Choose **GitHub** and authorize Netlify.
4. Select your `bridgeway404-site` repository.
5. Build settings:
   - **Build command:** (leave blank)
   - **Publish directory:** `.`
6. Click **Deploy site**.

Netlify will deploy automatically every time you push a change to GitHub.

---

## Connect bridgeway404.com to Netlify

### Step 1: Add the domain in Netlify

1. In Netlify, go to your site dashboard.
2. Click **Domain settings → Add a domain**.
3. Type `bridgeway404.com` and click **Verify**.
4. Click **Add domain**.

### Step 2: Update DNS at your domain registrar

Netlify will show you DNS records to add. The two most common setups:

**If your registrar supports ALIAS / ANAME records (recommended):**
```
Type:  ALIAS (or ANAME)
Host:  @  (or leave blank for root domain)
Value: [your-netlify-subdomain].netlify.app
```

**If your registrar only supports A records:**
```
Type:  A
Host:  @
Value: 75.2.60.5
```

And add a CNAME for www:
```
Type:  CNAME
Host:  www
Value: [your-netlify-subdomain].netlify.app
```

DNS changes can take a few minutes to 24 hours to propagate.

### Step 3: Enable HTTPS (Free SSL)

1. In Netlify, go to **Domain settings → HTTPS**.
2. Click **Verify DNS configuration**.
3. Click **Provision certificate**.

Netlify provisions a free Let's Encrypt SSL certificate automatically.

---

## Real-Time Lead Tracking — Choose Your Setup

### Option 1 — Immediate Launch (Email Notifications)

**Best for:** Getting started fast before the site even has its first lead.  
**What you get:** An email lands in both inboxes the moment a customer submits the form.  
**Time to set up:** About 3 minutes.

#### Steps

1. Deploy the site to Netlify (any method — drag-and-drop or GitHub).
2. In the Netlify dashboard, click your site name.
3. Go to **Forms** in the top navigation.
4. Click the form named **`quote-request`**.
5. Click **Form notifications → Add notification → Email notification**.
6. Enter `info@bridgeway404.com` and click **Save**.
7. Repeat step 5–6 and add Jonathan's email address.

Both of you will now receive an email with all form field answers every time a customer submits a quote request. The email comes from Netlify and includes every field the customer filled out.

> **Tip:** Check your spam folder after the first test submission and mark Netlify's email as Not Spam.

---

### Option 2 — Better Tracking (Google Sheets via Zapier)

**Best for:** Ongoing lead management once you start getting regular submissions.  
**What you get:** Every new submission automatically adds a row to a shared Google Sheet that both Michael and Jonathan can view, sort, and update in real time.  
**Time to set up:** About 20–30 minutes.  
**Cost:** Free on Zapier's free plan (up to 100 tasks/month); paid plan if volume grows.

#### Recommended Sheet: "Bridgeway 404 Lead Tracker"

Create a new Google Sheet with these column headers in row 1 (copy and paste this list):

| Column | Header |
|---|---|
| A | Submission Date |
| B | Customer Name |
| C | Phone |
| D | Email |
| E | Preferred Contact Method |
| F | Address / Area |
| G | Service Needed |
| H | Item Description |
| I | Number of Items |
| J | Item Location |
| K | Access Details |
| L | Timing Needed |
| M | Restricted Item Confirmation |
| N | Additional Notes |
| O | Quote Status |
| P | Quote Amount |
| Q | Follow-Up Date |
| R | Job Status |
| S | Notes |

Columns A–N are filled automatically by Zapier. Columns O–S are for you and Jonathan to fill in manually as you work each lead.

#### Steps to Connect Netlify → Zapier → Google Sheets

**Step 1: Set up the Netlify webhook**

1. In the Netlify dashboard, go to **Forms → `quote-request` → Form notifications**.
2. Click **Add notification → Outgoing webhook**.
3. Leave this tab open — you'll paste a URL here in a moment.

**Step 2: Create the Zap in Zapier**

1. Go to [zapier.com](https://zapier.com) and sign in (or create a free account).
2. Click **Create → New Zap**.
3. **Trigger:** Search for and select **Webhooks by Zapier**.
4. Choose event **Catch Hook** and click **Continue**.
5. Copy the webhook URL Zapier shows you.
6. Go back to Netlify and paste that URL into the webhook field, then click **Save**.

**Step 3: Test the connection**

1. Open your site and submit a test quote form with fake data.
2. Return to Zapier and click **Test trigger** — you should see the test submission appear with all the field values.
3. If data appears, click **Continue**.

**Step 4: Set up the Google Sheets action**

1. **Action:** Search for and select **Google Sheets**.
2. Choose event **Create Spreadsheet Row** and click **Continue**.
3. Sign in with the Google account that owns the Lead Tracker sheet.
4. Select your **Bridgeway 404 Lead Tracker** spreadsheet and the correct sheet tab.
5. Map each Zapier field to the correct column:
   - Submission Date → use Zapier's **Created At** field
   - Customer Name → `customer_name`
   - Phone → `phone`
   - Email → `email`
   - Preferred Contact Method → `preferred_contact`
   - Address / Area → `pickup_address`
   - Service Needed → `service_type`
   - Item Description → `item_description`
   - Number of Items → `num_items`
   - Item Location → `item_location`
   - Access Details → `access_details`
   - Timing Needed → `timing`
   - Restricted Item Confirmation → `restricted_confirm`
   - Additional Notes → `additional_notes`
6. Click **Continue → Test action**.
7. Check the Google Sheet — a new row should appear.
8. Click **Publish Zap**.

Every future form submission now lands in the sheet automatically.

#### Alternative: Use Make (formerly Integromat) instead of Zapier

Make has a more generous free plan (1,000 operations/month). The process is identical:

1. In Make, create a scenario with a **Webhooks → Custom webhook** trigger.
2. Copy the webhook URL and paste it into the Netlify outgoing webhook field.
3. Add a **Google Sheets → Add a Row** module and map the same fields.
4. Save and activate the scenario.

#### Sharing the Google Sheet with Jonathan

1. Open the sheet and click **Share** (top right).
2. Enter Jonathan's email address.
3. Set permission to **Editor** so he can update Quote Status, Notes, and Job Status.
4. Click **Send**.

---

### Which Option Should You Use?

| | Option 1 (Email only) | Option 2 (Google Sheets) |
|---|---|---|
| Setup time | ~3 minutes | ~25 minutes |
| Cost | Free | Free (within limits) |
| Best for | First week of launch | Ongoing operations |
| Both people see leads | ✓ (via email) | ✓ (shared sheet, real time) |
| Can track quote status | ✗ | ✓ |
| Can sort/filter leads | ✗ | ✓ |

**Recommendation:** Set up Option 1 today so you don't miss leads during launch. Add Option 2 within the first week once the site is live and you've confirmed the form works.

---

## Google Sheets CRM — Column Reference

Two separate sheets are recommended: one per form. Below are the complete column lists for each, including the hidden estimator fields that are now populated automatically by the Instant Quote Estimator.

---

### Sheet 1: Bridgeway 404 — Junk & Removal Leads

Columns populated by the `quote-request` Netlify form.

| Col | Header | Source |
|-----|--------|--------|
| A | Submission Date | Zapier/Make: trigger timestamp |
| B | Customer Name | `customer_name` |
| C | Phone | `phone` |
| D | Email | `email` |
| E | Preferred Contact | `preferred_contact` |
| F | Pickup Address / Area | `pickup_address` |
| G | Service Needed | `service_type` |
| H | Items Detail | `items_detail` |
| I | Volume / Truck Estimate | `volume_estimate` |
| J | Item Location | `item_location` |
| K | Access Details | `access_details` |
| L | Timing Needed | `timing` |
| M | Restricted Items Confirmed | `restricted_confirm` |
| N | Additional Notes | `additional_notes` |
| O | Privacy Consent (checkbox) | `privacy_consent` |
| P | Privacy Consent Granted | `privacy_consent_granted` |
| Q | Estimator Used For | `estimate_service_type` |
| R | Estimator Internal Total | `estimate_internal_total` |
| S | Estimator Customer Low | `estimate_customer_low` |
| T | Estimator Customer High | `estimate_customer_high` |
| U | Access Premium | `estimate_access_premium` |
| V | Distance Premium | `estimate_distance_premium` |
| W | Same-Day Premium | `estimate_same_day_premium` |
| X | Manual Quote Flag | `estimate_quote_manual_flag` |
| Y | Quote Status | Manual — fill in |
| Z | Quoted Amount | Manual — fill in |
| AA | Follow-Up Date | Manual — fill in |
| AB | Job Status | Manual — fill in |
| AC | Notes | Manual — fill in |

---

### Sheet 2: Bridgeway 404 — Assembly Leads

Columns populated by the `furniture-assembly-request` Netlify form.

| Col | Header | Source |
|-----|--------|--------|
| A | Submission Date | Zapier/Make: trigger timestamp |
| B | Customer Name | `customer_name` |
| C | Phone | `phone` |
| D | Email | `email` |
| E | Preferred Contact | `preferred_contact` |
| F | Address / Area | `service_area` |
| G | Item Type | `assembly_item_type` |
| H | Number of Items | `num_items` |
| I | Brand / Model | `item_brand_model` |
| J | Still in Box? | `still_in_box` |
| K | Has Instructions? | `has_instructions` |
| L | Special Pieces? | `special_pieces` |
| M | Assembly Location | `assembly_location` |
| N | Timing Needed | `timing` |
| O | Additional Notes | `additional_notes` |
| P | Privacy Consent (checkbox) | `privacy_consent` |
| Q | Privacy Consent Granted | `privacy_consent_granted` |
| R | Estimator Used For | `estimate_service_type` |
| S | Estimator Internal Total | `estimate_internal_total` |
| T | Estimator Customer Low | `estimate_customer_low` |
| U | Estimator Customer High | `estimate_customer_high` |
| V | Access Premium | `estimate_access_premium` |
| W | Distance Premium | `estimate_distance_premium` |
| X | Same-Day Premium | `estimate_same_day_premium` |
| Y | Manual Quote Flag | `estimate_quote_manual_flag` |
| Z | Quote Status | Manual — fill in |
| AA | Quoted Amount | Manual — fill in |
| AB | Follow-Up Date | Manual — fill in |
| AC | Job Status | Manual — fill in |
| AD | Notes | Manual — fill in |

---

## Zapier / Make: Connecting Netlify Forms to Google Sheets

### Recommended tool: Zapier (easiest) or Make (more free operations/month)

Both tools work identically for this integration. Use **Zapier** if you want the fastest setup. Use **Make** if you expect high lead volume (1,000+ submissions/month) and want to stay on the free tier.

---

### Zapier Setup (step-by-step)

#### Zap 1: Removal leads → Sheet 1

1. Log in to [zapier.com](https://zapier.com) → **Create → New Zap**
2. **Trigger:** Search `Webhooks by Zapier` → event: **Catch Hook** → Continue
3. Copy the webhook URL shown
4. In Netlify: **Forms → `quote-request` → Form notifications → Outgoing webhook** → paste URL → Save
5. Submit a test quote on your live site with real data
6. Back in Zapier: click **Test trigger** — you should see all field values including the `estimate_*` fields
7. **Action:** Search `Google Sheets` → event: **Create Spreadsheet Row** → Continue
8. Connect your Google account and select the **Bridgeway 404 — Junk & Removal Leads** sheet
9. Map each Zapier field to the column header using the table above
   - For **Submission Date**: use Zapier's built-in `Caught At` timestamp
   - Map every `estimate_*` field — they will say "Not used" if the customer bypassed the estimator
10. Click **Test action** → verify a new row appears in the sheet
11. Click **Publish Zap**

#### Zap 2: Assembly leads → Sheet 2

Repeat the exact same steps, but:
- Use form `furniture-assembly-request` for the Netlify webhook
- Map to the **Bridgeway 404 — Assembly Leads** sheet
- Use the assembly column list above

---

### Make (Integromat) Setup

1. Go to [make.com](https://make.com) → **Create a new scenario**
2. Add module: **Webhooks → Custom webhook** → copy the webhook URL
3. In Netlify: paste the URL into the outgoing webhook for `quote-request`
4. Submit a test form → run the scenario once to detect the data structure
5. Add module: **Google Sheets → Add a Row**
6. Connect your Google account, select your sheet, and map fields
7. Save and activate the scenario

Repeat for `furniture-assembly-request` with a separate scenario.

---

### Field mapping notes

| Netlify field | What it contains | CRM use |
|---|---|---|
| `estimate_internal_total` | True cost before discount (e.g. `$275`) | Internal pricing reference — do not share with customers |
| `estimate_customer_low` | Low end shown to customer (`$247`) | What customer expects |
| `estimate_customer_high` | High end shown to customer (`$261`) | What customer expects |
| `estimate_quote_manual_flag` | `No` or `Yes — manual quote required` | Flag 36+ mile jobs for manual review |
| `privacy_consent_granted` | `Yes` or `No` | Compliance confirmation |
| `estimate_service_type` | `Junk & Furniture Removal` or `Furniture Assembly` or `Not used` | Confirms which estimator tab was active |

---

## Updating the Website

All content is in `index.html`. Search for these comment markers to find the right spot:

| What to change | Search for |
|---|---|
| Phone number | `<!-- PHONE -->`, `404-565-4216`, or `tel:+14045654216` |
| Email address | `info@bridgeway404.com` |
| Call Now button / call modal | `data-call-now` or `id="call-modal"` |
| Service area cities | `CITIES —` comment |
| Hero headline/subheadline | `<h1>` in the hero section |
| Service cards | `SERVICE CARDS —` comment |
| Images | `IMAGES —` comment (Unsplash URLs to replace with your photos) |
| Footer links | `FOOTER LINKS —` comment |
| Map placeholder | `MAP —` comment |

After editing `index.html`, save the file. If using GitHub + Netlify, commit and push — the site redeploys in about 30 seconds.

---

## Replacing Placeholder Images

The site uses free Unsplash images as placeholders. To replace them with your own photos:

1. Upload your photos to a hosting service (Netlify itself, Cloudinary, Google Drive with direct link, etc.).
2. In `index.html`, find each `<img src="https://images.unsplash.com/...">` tag.
3. Replace the `src` value with your photo URL.
4. Update the `alt` text to accurately describe your photo.

Best image dimensions:
- Wide feature images: **900 × 380px** minimum
- Standard grid images: **600 × 440px** minimum

---

## Environment Variables

This site has **no environment variables**. It is a plain static HTML file with no server-side code.

If you later add a backend (contact API, booking system, etc.), add variables in:
**Netlify dashboard → Site settings → Environment variables**

---

## Local Preview

Open `index.html` directly in any browser — no server needed.

For a local server (optional, fixes some browser security restrictions on file uploads):

```powershell
# If Python is installed
python -m http.server 8080

# Then open http://localhost:8080 in your browser
```

---

## Checklist Before Going Live

- [ ] Replace placeholder phone number `404-565-4216` with confirmed business number
- [ ] Replace placeholder email `info@bridgeway404.com` with confirmed business email
- [ ] Verify the "Call Now" buttons dial `404-565-4216` (mobile) and open the call modal (desktop)
- [ ] Replace Unsplash placeholder images with your own photos
- [ ] Add real Privacy Policy and Terms pages (or remove footer links)
- [ ] Test the quote form and confirm email notification arrives
- [ ] Test on mobile (iPhone and Android)
- [ ] Connect `bridgeway404.com` domain and enable HTTPS
- [ ] Submit sitemap to Google Search Console after launch

---

## Support

For Netlify help: [docs.netlify.com](https://docs.netlify.com)  
For domain DNS help: contact your domain registrar's support team.
