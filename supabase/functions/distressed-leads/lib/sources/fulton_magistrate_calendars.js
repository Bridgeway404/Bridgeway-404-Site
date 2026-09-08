// Fulton County Magistrate Court dispossessory calendars (public CivicPlus
// DocumentCenter files, usually Word .doc). Stage = hearing_scheduled.
// Plaintiff side only; tenant names are never kept.
import { parseCivicPlusCalendarLinks } from '../parsers/feeds.js';
import { parseFultonCalendar } from '../parsers/calendar.js';
import { extractDocumentText } from '../parsers/doc.js';
import { contentHash, looksLikeEntity } from '../normalize.js';

const PAGE = 'https://www.magistratefulton.org/230/Court-Calendars';

export const fultonMagistrateCalendars = {
  id: 'fulton_magistrate_calendars',
  county: 'Fulton',
  label: 'Fulton Magistrate Court — dispossessory calendars',
  kind: 'eviction',
  enabledByDefault: true,
  notes: 'Public daily calendars (Word/PDF). Gives case number + plaintiff at the hearing stage; writ/execution status is not published online.',
  async discover(ctx) {
    const res = await ctx.http.get(PAGE);
    if (!res.ok) throw new Error(`calendar page HTTP ${res.status}`);
    const links = parseCivicPlusCalendarLinks(res.text);
    const records = [];
    const seenBefore = ctx.seen || (() => false);
    let fetched = 0, empty = 0;
    for (const l of links) {
      const externalId = 'doc:' + l.id;
      if (seenBefore(externalId)) continue;
      if (fetched >= (ctx.maxNewItems || 12)) break;
      fetched++;
      const doc = await ctx.http.get(l.url, { binary: true, accept: '*/*' });
      if (!doc.ok || !doc.bytes) { ctx.log(`calendar doc ${doc.status} ${l.url}`); continue; }
      let text = '';
      try { ({ text } = await extractDocumentText(doc.bytes, { contentType: doc.contentType, url: l.url, pdfExtract: ctx.pdfExtract })); }
      catch (e) { ctx.log(`calendar text failed ${l.url}: ${e.message}`); continue; }
      let parsed = parseFultonCalendar(text, { hearingDate: l.date, courtroom: l.courtroom });
      if (!parsed.rows.length && ctx.aiExtractCalendar) {
        try { parsed = await ctx.aiExtractCalendar(text, { county: 'Fulton', hearingDate: l.date }); } catch (e) { ctx.log('ai calendar failed: ' + e.message); }
      }
      // The calendar document itself is one source item; each case becomes a record.
      if (!parsed.rows.length) { ctx.log(`no rows parsed from ${l.url}; will retry next run`); empty++; continue; }
      records.push({ source_id: this.id, external_id: externalId, url: l.url, kind: 'calendar_document', county: 'Fulton', content_hash: contentHash(text), rows: parsed.rows.length });
      for (const r of parsed.rows) {
        records.push({
          source_id: this.id, external_id: 'case:' + r.case_number, url: l.url, kind: 'eviction_case', county: 'Fulton',
          case_number: r.case_number, plaintiff_name: r.plaintiff_name, plaintiff_raw: r.plaintiff_raw, community_name: r.community_name,
          plaintiff_is_entity: r.plaintiff_is_entity ?? looksLikeEntity(r.plaintiff_name),
          stage: 'hearing_scheduled', hearing_date: r.hearing_date || l.date, filed_date: r.filed_date || null,
          details: { courtroom: l.courtroom, time: l.time, judge: r.judge || null, calendar_title: l.title },
          evidence: [{ claim: `Dispossessory case ${r.case_number} on the Fulton Magistrate calendar for ${l.date || 'an upcoming date'} (${l.time || ''} ${l.courtroom ? 'courtroom ' + l.courtroom : ''})`, url: l.url, excerpt: r.plaintiff_raw }],
        });
      }
    }
    return { records, cursor: { last_check: new Date().toISOString(), calendars_listed: links.length }, diagnostics: { calendars_listed: links.length, calendars_fetched: fetched, empty_documents: empty } };
  },
};
