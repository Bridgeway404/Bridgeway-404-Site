// DeKalb County legal organ (The Champion) — weekly legal section PDF listed
// through dekalblegalnotices.com's WordPress media API.
//
// DISABLED BY DEFAULT. The publisher sells access to the legal notices
// ($250/yr web, $39/yr print + PDF by mail) and the notices page sits behind
// that subscription even though the PDF files themselves are served without
// a login. Bridgeway should subscribe (or confirm permission) before enabling
// this adapter; until then the weekly PDF can be uploaded in the Admin tab by
// a subscriber and processed by the same extractor.
import { parseWpMedia } from '../parsers/feeds.js';
import { contentHash } from '../normalize.js';

const MEDIA = 'https://www.dekalblegalnotices.com/wp-json/wp/v2/media?per_page=6&orderby=date&mime_type=application/pdf&_fields=id,date,slug,source_url,title';

export const dekalbChampionLegals = {
  id: 'dekalb_champion_legals',
  county: 'DeKalb',
  label: 'The Champion (DeKalb legal organ) — weekly legal section PDF',
  kind: 'foreclosure',
  enabledByDefault: false,
  notes: 'Weekly legal-section PDF. Off by default pending a DeKalb Legal Notices subscription ($250/yr web or $39/yr mail) or written permission; subscribers can upload the PDF in the Admin tab.',
  async discover(ctx) {
    const res = await ctx.http.get(MEDIA, { accept: 'application/json' });
    if (!res.ok) throw new Error(`media API HTTP ${res.status}`);
    const items = parseWpMedia(res.text);
    const records = [];
    const seenBefore = ctx.seen || (() => false);
    let fetched = 0, more = false;
    for (const m of items) {
      const externalId = 'media:' + m.id;
      if (seenBefore(externalId)) continue;
      if (fetched >= (ctx.maxNewItems || 2)) { more = true; break; }
      fetched++;
      const pdf = await ctx.http.get(m.url, { binary: true, accept: 'application/pdf,*/*' });
      if (!pdf.ok || !pdf.bytes) { ctx.log(`legal pdf ${pdf.status} ${m.url}`); continue; }
      // Large multi-page document: the AI extractor (PDF input) does the parsing.
      records.push({
        source_id: this.id, external_id: externalId, url: m.url, kind: 'notice_document', county: 'DeKalb',
        publication_date: m.date ? m.date.slice(0, 10) : null, pdf_bytes: pdf.bytes, content_hash: contentHash(m.url + (pdf.bytes.length)),
        title: m.title,
      });
    }
    return { records, more, cursor: { last_check: new Date().toISOString() }, diagnostics: { media_listed: items.length, fetched } };
  },
};
