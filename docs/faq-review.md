# FAQ page: owner review (draft, Nov 7 2026)

**Page:** `faq/index.html` → https://bridgeway404.com/faq/ once merged
**Status:** draft on branch `claude/relaxed-hawking-fyhi3j`. **Not live** until the branch is merged.

## How the questions were chosen

The questions follow the most common searches people make before hiring junk removal in Atlanta.
They come from the cost guides and "people also ask" topics on Angi, HomeAdvisor, Thumbtack and LawnStarter,
plus Atlanta-specific searches such as ATL311 bulk pickup. Each one is worded the way people type or ask it
("How much does junk removal cost in Atlanta?"), and each answer starts with a direct reply.
Google and AI assistants (ChatGPT, Gemini, Perplexity, Google AI Overviews) favor that format.

| Topic | Search intent it targets |
|---|---|
| Pricing & quotes | "junk removal cost Atlanta", "how is junk removal priced", "free junk removal quote" |
| Scheduling & area | "same day junk removal Atlanta", "junk removal near me" + city names, "do I need to be home" |
| What we take | "couch removal", "mattress removal", "single item pickup", "refrigerator removal", "construction debris removal" |
| ATL311 | "City of Atlanta bulk trash pickup", "how to get rid of a couch in Atlanta" |
| Cleanouts | "estate cleanout", "inherited house cleanout", "garage cleanout", "move out cleanout", "storage unit cleanout" |
| Furniture assembly | "IKEA assembly Atlanta", "furniture assembly cost" |
| Commercial | "rental turnover cleanout", "eviction cleanout", vendor/COI questions |

## What's built in for search and AI

- **FAQPage structured data** (JSON-LD), generated from the visible questions by `tools/build-faq-schema.py`.
  It is linked to the business record on the homepage. Google currently shows FAQ *rich results* only for
  government and health sites, so expect no expandable answers under the search result. The markup still helps
  Google and AI assistants read and quote the answers.
- Questions are real headings (`<h3>`), grouped under topic headings with jump links.
- The page is linked from the footer on every page and from the homepage FAQ ("See all frequently asked questions").
  It is also in `sitemap.xml`, and `/faqs` redirects to `/faq/`.

## Please confirm (marked `<!-- REVIEW: -->` in the page)

1. **Starting price.** Can we publish a "starting at $__" for single items or small loads? The top Atlanta
   searches are about cost, and pages with a concrete number tend to win those answers. Right now the page explains
   how pricing works but gives no number.
2. **Price changes on the day.** The draft says that if there's noticeably more or less on the day, we tell the
   customer and confirm the new price before loading. Is that how you handle it?
3. **Customer not home.** The draft says curbside/driveway pickups may not need anyone present. Inside jobs need
   the customer, or someone they trust, to give access. Correct?
4. **Job length.** Want to add typical times (for example, "most single-item pickups take under 30 minutes")?
5. **Appliances & electronics.** Do you take washers, dryers, stoves, dishwashers, TVs or computers? These are
   common searches. The draft only says no refrigerators or Freon appliances and "ask about others".
6. **ATL311 details.** Check the city's current bulk-pickup rules at atlantaga.gov before publishing.
   I couldn't open the city site from here, so the answer stays general on purpose.
7. **Naming IKEA, Wayfair and Amazon** in the assembly answer. OK to name them?

## Questions people search that we can't answer yet (add if you can)

Each needs a fact only you can provide, so I left them out rather than guess:

- **Are you licensed and insured?** This is one of the most-searched trust questions.
- **What payment methods do you accept?** (card, cash, Zelle, etc.) Do you take payment after the job?
- **What happens to my stuff? Do you donate or recycle?** This is very common, and AI assistants surface "eco-friendly" companies.
- **Do you work weekends / what are your hours?**
- **Do you remove hot tubs, pianos, sheds or playsets?**
- **Do you take the boxes and packaging after assembly?**
- **Do you sweep or broom-clean after a cleanout?**
- **Should I tip the crew?**

## Making edits later

Edit the questions and answers in `faq/index.html`, then run:

```
python3 tools/build-faq-schema.py   # regenerate the structured data
python3 tools/check-site.py         # fails if the structured data is out of date
```
