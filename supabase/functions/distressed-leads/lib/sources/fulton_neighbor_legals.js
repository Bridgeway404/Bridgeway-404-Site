// Fulton County legal organ (South Fulton Neighbor / fultonneighbor.com).
// What is public without a subscription: the "Legals" section's individually
// posted PDF notices, exposed through the site's own RSS feed. The weekly
// legal section (the bulk of foreclosure ads) is in the subscriber e-Edition
// and is ingested through the Admin upload path instead.
import { parseRss, bloxAssetPdfUrl } from '../parsers/feeds.js';
import { extractNoticeFields } from '../parsers/notice.js';
import { contentHash } from '../normalize.js';

const FEED = 'https://www.fultonneighbor.com/search/?f=rss&t=pdf&c=legals&l=50&s=start_time&sd=desc';

export const fultonNeighborLegals = {
  id: 'fulton_neighbor_legals',
  county: 'Fulton',
  label: 'Fulton Neighbor — Legals (public PDF notices via RSS)',
  kind: 'foreclosure',
  enabledByDefault: true,
  notes: 'Public RSS of individually posted legal PDFs. The full weekly legal section requires an e-Edition subscription; upload it in the Admin tab.',
  async discover(ctx) {
    const res = await ctx.http.get(FEED, { accept: 'application/rss+xml, application/xml' });
    if (!res.ok) throw new Error(`feed HTTP ${res.status}`);
    const items = parseRss(res.text);
    const records = [];
    const seenBefore = ctx.seen || (() => false);
    let fetched = 0;
    for (const it of items) {
      if (!it.link || !/pdf_[a-f0-9-]{36}/.test(it.link)) continue;
      if (!/sale under power|foreclos|notice of sale/i.test(it.title || '')) continue;
      const externalId = (it.guid || it.link).replace(/^.*\/([a-f0-9-]{36})$/, '$1');
      if (seenBefore(externalId)) { records.push({ source_id: this.id, external_id: externalId, url: it.link, seen_only: true }); continue; }
      if (fetched >= (ctx.maxNewItems || 25)) break;
      fetched++;
      const page = await ctx.http.get(it.link);
      if (!page.ok) { ctx.log(`asset page ${page.status} ${it.link}`); continue; }
      const pdfUrl = bloxAssetPdfUrl(page.text);
      let text = null, pdfBytes = null;
      if (pdfUrl) {
        const pdf = await ctx.http.get(pdfUrl, { binary: true });
        if (pdf.ok && pdf.bytes) { pdfBytes = pdf.bytes; if (ctx.pdfExtract) { try { text = await ctx.pdfExtract(pdf.bytes); } catch (e) { ctx.log('pdf text failed: ' + e.message); } } }
      }
      const pubDate = it.pubDate ? new Date(it.pubDate).toISOString().slice(0, 10) : null;
      const fields = text ? extractNoticeFields(text) : {};
      records.push({
        source_id: this.id, external_id: externalId, url: it.link, pdf_url: pdfUrl,
        kind: 'foreclosure_notice', county: 'Fulton', publication_date: pubDate,
        title: it.title, text, pdf_bytes: pdfBytes, content_hash: contentHash(text || it.title || ''),
        ...fields,
        evidence: [{ claim: 'Foreclosure notice published by the Fulton County legal organ', url: it.link, excerpt: (text || it.title || '').slice(0, 300) }],
      });
    }
    return { records, cursor: { last_feed_check: new Date().toISOString(), items_in_feed: items.length }, diagnostics: { feed_items: items.length } };
  },
};
