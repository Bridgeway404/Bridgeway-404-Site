// Henry County legal organ (Henry Herald). Same platform and terms as the
// Douglas County Sentinel (TownNews/BLOX, automated access prohibited by
// terms, HTTP 429 for server IPs). The public "Legals" RSS is checked once
// per run for any individually posted notice PDFs; the weekly legal section
// is ingested by upload from the e-Edition.
import { parseRss, bloxAssetPdfUrl } from '../parsers/feeds.js';
import { extractNoticeFields } from '../parsers/notice.js';
import { contentHash } from '../normalize.js';

const FEED = 'https://www.henryherald.com/search/?f=rss&t=pdf%2Carticle&c=legals&l=50&s=start_time&sd=desc';

export const henryHeraldLegals = {
  id: 'henry_herald_legals',
  county: 'Henry',
  label: 'Henry Herald — Legals (public RSS)',
  kind: 'foreclosure',
  enabledByDefault: true,
  notes: 'One RSS request per run. The site rate-limits server requests and its terms restrict automated collection; the weekly legal section must be uploaded by a subscriber.',
  async discover(ctx) {
    const res = await ctx.http.get(FEED, { accept: 'application/rss+xml, application/xml', cache: false });
    if (res.status === 429) throw new Error('rate limited (HTTP 429) by the newspaper site; retry next run');
    if (!res.ok) throw new Error(`feed HTTP ${res.status}`);
    const items = parseRss(res.text);
    const seenBefore = ctx.seen || (() => false);
    const records = [];
    let fetched = 0, more = false;
    for (const it of items) {
      if (!it.link) continue;
      if (!/sale under power|foreclos|notice of sale/i.test(it.title || '')) continue;
      const externalId = (it.guid || it.link).replace(/^.*\/([a-f0-9-]{36})$/, '$1');
      if (seenBefore(externalId)) { records.push({ source_id: this.id, external_id: externalId, url: it.link, seen_only: true }); continue; }
      if (fetched >= (ctx.maxNewItems || 5)) { more = true; break; }
      fetched++;
      const page = await ctx.http.get(it.link);
      if (!page.ok) { ctx.log(`asset page ${page.status} ${it.link}`); continue; }
      const pdfUrl = bloxAssetPdfUrl(page.text);
      let text = null, pdfBytes = null;
      if (pdfUrl) {
        const pdf = await ctx.http.get(pdfUrl, { binary: true });
        if (pdf.ok && pdf.bytes) { pdfBytes = pdf.bytes; if (ctx.pdfExtract) { try { text = await ctx.pdfExtract(pdf.bytes); } catch (e) { ctx.log('pdf text failed: ' + e.message); } } }
      }
      const fields = text ? extractNoticeFields(text) : {};
      records.push({
        source_id: this.id, external_id: externalId, url: it.link, pdf_url: pdfUrl, kind: 'foreclosure_notice', county: 'Henry',
        publication_date: it.pubDate ? new Date(it.pubDate).toISOString().slice(0, 10) : null, title: it.title, text, pdf_bytes: pdfBytes,
        content_hash: contentHash(text || it.title || ''), ...fields,
        evidence: [{ claim: 'Foreclosure notice published by the Henry County legal organ', url: it.link, excerpt: (text || it.title || '').slice(0, 300) }],
      });
    }
    return { records, more, cursor: { last_check: new Date().toISOString(), items_in_feed: items.length }, diagnostics: { feed_items: items.length } };
  },
};
