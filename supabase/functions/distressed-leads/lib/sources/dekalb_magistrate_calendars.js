// DeKalb County Magistrate Court dispossessory calendars (public WordPress
// media PDFs listed by the site's REST API). Stage = hearing_scheduled.
import { parseWpMedia } from '../parsers/feeds.js';
import { parseDeKalbCalendar } from '../parsers/calendar.js';
import { extractDocumentText } from '../parsers/doc.js';
import { contentHash, looksLikeEntity } from '../normalize.js';

const MEDIA = 'https://dekalbcountymagistratecourt.com/wp-json/wp/v2/media?search=Dispo&per_page=40&orderby=date&_fields=id,date,slug,source_url,title';

export const dekalbMagistrateCalendars = {
  id: 'dekalb_magistrate_calendars',
  county: 'DeKalb',
  label: 'DeKalb Magistrate Court — dispossessory calendars',
  kind: 'eviction',
  enabledByDefault: true,
  notes: 'Public calendar PDFs (case number, plaintiff, attorney, d/b/a community). Hearing stage only; writ/execution status must be checked on the DeKalb Odyssey portal by a person.',
  async discover(ctx) {
    const res = await ctx.http.get(MEDIA, { accept: 'application/json' });
    if (!res.ok) throw new Error(`media API HTTP ${res.status}`);
    const items = parseWpMedia(res.text).filter(m => /dispo/i.test(m.slug || '') || /dispo/i.test(m.title || ''));
    const records = [];
    const seenBefore = ctx.seen || (() => false);
    let fetched = 0, empty = 0;
    for (const m of items) {
      const externalId = 'media:' + m.id;
      if (seenBefore(externalId)) continue;
      if (fetched >= (ctx.maxNewItems || 15)) break;
      fetched++;
      const pdf = await ctx.http.get(m.url, { binary: true, accept: 'application/pdf,*/*' });
      if (!pdf.ok || !pdf.bytes) { ctx.log(`calendar pdf ${pdf.status} ${m.url}`); continue; }
      let text = '';
      try { ({ text } = await extractDocumentText(pdf.bytes, { contentType: pdf.contentType, url: m.url, pdfExtract: ctx.pdfExtract })); }
      catch (e) { ctx.log(`calendar text failed ${m.url}: ${e.message}`); continue; }
      let parsed = parseDeKalbCalendar(text);
      if (!parsed.rows.length && ctx.aiExtractCalendar) {
        try { parsed = await ctx.aiExtractCalendar(text, { county: 'DeKalb' }); } catch (e) { ctx.log('ai calendar failed: ' + e.message); }
      }
      if (!parsed.rows.length) { ctx.log(`no rows parsed from ${m.url}; will retry next run`); empty++; continue; }
      records.push({ source_id: this.id, external_id: externalId, url: m.url, kind: 'calendar_document', county: 'DeKalb', content_hash: contentHash(text), rows: parsed.rows.length });
      for (const r of parsed.rows) {
        records.push({
          source_id: this.id, external_id: 'case:' + r.case_number, url: m.url, kind: 'eviction_case', county: 'DeKalb',
          case_number: r.case_number, plaintiff_name: r.plaintiff_name, plaintiff_raw: r.plaintiff_raw, community_name: r.community_name,
          plaintiff_attorney: r.plaintiff_attorney || null, plaintiff_is_entity: looksLikeEntity(r.plaintiff_name),
          stage: 'hearing_scheduled', hearing_date: r.hearing_date || (m.date ? m.date.slice(0, 10) : null),
          details: { case_type: r.case_type, judge: r.judge, time: r.hearing_time, virtual: r.virtual, comment: r.comment, calendar_title: m.title },
          evidence: [{ claim: `Dispossessory case ${r.case_number} (${r.case_type || 'dispossessory'}) on the DeKalb Magistrate calendar for ${r.hearing_date || 'an upcoming date'}`, url: m.url, excerpt: r.plaintiff_raw }],
        });
      }
    }
    return { records, cursor: { last_check: new Date().toISOString(), media_listed: items.length }, diagnostics: { media_listed: items.length, fetched, empty_documents: empty } };
  },
};
