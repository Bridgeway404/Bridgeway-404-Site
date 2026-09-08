// Henry County Magistrate Court judges' dispossessory calendars (public PDFs
// on iframe.henrycountyga.gov). Stage = hearing_scheduled.
import { parseHenryCalendarLinks } from '../parsers/feeds.js';
import { parseHenryCalendar } from '../parsers/calendar.js';
import { extractDocumentText } from '../parsers/doc.js';
import { contentHash, looksLikeEntity } from '../normalize.js';

const PAGE = 'https://iframe.henrycountyga.gov/judgescalendar/magcourt.aspx';

export const henryMagistrateCalendars = {
  id: 'henry_magistrate_calendars',
  county: 'Henry',
  label: 'Henry Magistrate Court — dispossessory calendars',
  kind: 'eviction',
  enabledByDefault: true,
  notes: 'Public per-judge calendar PDFs (case number, plaintiff, a/a/f community). Hearing stage only.',
  async discover(ctx) {
    const res = await ctx.http.get(PAGE);
    if (!res.ok) throw new Error(`calendar page HTTP ${res.status}`);
    const links = parseHenryCalendarLinks(res.text)
      .filter(l => l.date && l.date >= (ctx.sinceDate || '0000'))
      .sort((a, b) => (a.date < b.date ? 1 : -1));
    const records = [];
    const seenBefore = ctx.seen || (() => false);
    let fetched = 0;
    for (const l of links) {
      const externalId = 'pdf:' + l.url.split('/').slice(-1)[0];
      if (seenBefore(externalId)) continue;
      if (fetched >= (ctx.maxNewItems || 20)) break;
      fetched++;
      const pdf = await ctx.http.get(l.url, { binary: true, accept: 'application/pdf,*/*' });
      if (!pdf.ok || !pdf.bytes) { ctx.log(`calendar pdf ${pdf.status} ${l.url}`); continue; }
      let text = '';
      try { ({ text } = await extractDocumentText(pdf.bytes, { contentType: pdf.contentType, url: l.url, pdfExtract: ctx.pdfExtract })); }
      catch (e) { ctx.log(`calendar text failed ${l.url}: ${e.message}`); continue; }
      let parsed = parseHenryCalendar(text);
      if (!parsed.rows.length && ctx.aiExtractCalendar && /MGCD/.test(text)) {
        try { parsed = await ctx.aiExtractCalendar(text, { county: 'Henry', hearingDate: l.date }); } catch (e) { ctx.log('ai calendar failed: ' + e.message); }
      }
      records.push({ source_id: this.id, external_id: externalId, url: l.url, kind: 'calendar_document', county: 'Henry', content_hash: contentHash(text), rows: parsed.rows.length });
      for (const r of parsed.rows) {
        records.push({
          source_id: this.id, external_id: 'case:' + r.case_number, url: l.url, kind: 'eviction_case', county: 'Henry',
          case_number: r.case_number, plaintiff_name: r.plaintiff_name, plaintiff_raw: r.plaintiff_raw, community_name: r.community_name,
          plaintiff_is_entity: r.plaintiff_is_entity ?? looksLikeEntity(r.plaintiff_name),
          stage: 'hearing_scheduled', hearing_date: r.hearing_date || l.date,
          details: { judge: l.judge || r.judge, time: r.hearing_time, case_number_alt: r.case_number_alt },
          evidence: [{ claim: `Dispossessory case ${r.case_number} on Judge ${l.judge || ''}'s Henry Magistrate calendar for ${r.hearing_date || l.date}`, url: l.url, excerpt: r.plaintiff_raw }],
        });
      }
    }
    return { records, cursor: { last_check: new Date().toISOString(), calendars_listed: links.length }, diagnostics: { calendars_listed: links.length, fetched } };
  },
};
