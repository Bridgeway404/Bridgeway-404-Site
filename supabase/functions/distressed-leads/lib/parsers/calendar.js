// Dispossessory calendar text parsers (DeKalb Magistrate WordPress PDFs,
// Fulton Magistrate DocumentCenter PDFs). Input is the text extracted from
// the PDF (page texts joined). Tenant names are deliberately discarded:
// everything between "--- versus ---" and the next "Comment:" / row start
// is dropped, and only case number, plaintiff, plaintiff attorney, case
// type, hearing date/time and judge are kept.
import { cleanWhitespace, looksLikeEntity, parseDateLoose } from '../normalize.js';

const CASE_RE = /\b(\d{2}[A-Z]{1,2}\d{4,7})\b/;
const ENTITY_SUFFIX = /\b(L\.?L\.?C\.?|L\.?P\.?|L\.?L\.?P\.?|LLLP|INC\.?|CORP\.?|CORPORATION|COMPANY|CO\.|TRUST|PLLC|P\.?C\.?|LTD\.?|N\.?A\.?|ASSOCIATION|PARTNERSHIP|PARTNERS)\b\.?,?/i;

/**
 * "S2 PLEASANTDALE LLC The Wynne (fka The Landing)" -> entity + community.
 * Handles d/b/a, a/a/f (as agent for), c/o, and a trailing community name
 * after the legal entity suffix.
 */
export function splitPlaintiff(name) {
  const s = cleanWhitespace(name);
  if (!s) return { entity: null, community: null, agentFor: null, careOf: null };
  let entity = s, community = null, agentFor = null, careOf = null;
  let m = /^(.*?)\s+c\/o\s+(.+)$/i.exec(entity);
  if (m) { entity = m[1]; careOf = cleanWhitespace(m[2]); }
  m = /^(.*?)\s+(?:d\/b\/a|dba)\s+(.+)$/i.exec(entity);
  if (m) { entity = m[1]; community = cleanWhitespace(m[2]); }
  m = /^(.*?)\s+(?:a\/a\/f|aaf|as agent for)\s+(.+)$/i.exec(entity);
  if (m) { entity = m[1]; agentFor = cleanWhitespace(m[2]); community = community || agentFor; }
  // Fulton captions: "Community Name, Management Company" (e.g. "Briar Park
  // Senior Living, Dominium Management Inc"). The operator after the comma is
  // the plaintiff entity; the part before is the community.
  if (!community) {
    m = /^([^,]{3,80}),\s+([^,]*?\b(?:Management|Mgmt|Residential|Properties|Property|Realty|Partners|Group|Communities|Living|Homes|Housing|Investments|Apartments|Associates)\b[^,]*)$/i.exec(entity);
    if (m && cleanWhitespace(m[1]).toLowerCase() !== cleanWhitespace(m[2]).toLowerCase()) {
      community = cleanWhitespace(m[1]).replace(/\s+-\s+\d{5}$/, '');
      entity = cleanWhitespace(m[2]);
    } else if (m) {
      // "Aviva Property Management, Aviva Property Management" — a repeated name is no community.
      entity = cleanWhitespace(m[2]);
    }
  }
  if (!community) {
    const sm = ENTITY_SUFFIX.exec(entity);
    if (sm) {
      const tail = cleanWhitespace(entity.slice(sm.index + sm[0].length));
      if (tail.length >= 4 && !ENTITY_SUFFIX.test(tail)) { community = tail.replace(/^\(|\)$/g, ''); entity = cleanWhitespace(entity.slice(0, sm.index + sm[0].length)); }
    }
  }
  entity = entity.replace(/[,\s]+$/, '');
  return { entity: entity || null, community: community || null, agentFor, careOf };
}

export function parseDeKalbCalendar(text) {
  const t = String(text || '').replace(/\r/g, '');
  const header = {};
  const judge = /Judge\s+([A-Z][A-Za-z.'\- ]+)/.exec(t);
  if (judge) header.judge = cleanWhitespace(judge[1]);
  const dm = /(\d{1,2}\/\d{1,2}\/\d{4})/.exec(t);
  if (dm) header.date = parseDateLoose(dm[1]);
  const tm = /\b(\d{1,2}:\d{2}\s*[AP]M)\b/i.exec(t);
  if (tm) header.time = tm[1].toUpperCase().replace(/\s+/g, ' ');
  const virtual = /virtual/i.test(t.slice(0, 600));

  // Split into rows: a row starts with "<n> <caseNo>". Column gaps are 2+
  // spaces with pdf.js but a single space with unpdf (the edge runtime), so
  // only single whitespace is assumed.
  const rowRe = /(?:^|\n)\s*(\d{1,3})\s+(\d{2}[A-Z]{1,2}\d{4,7})\s*([\s\S]*?)(?=(?:\n\s*\d{1,3}\s+\d{2}[A-Z]{1,2}\d{4,7})|\n\s*Page\s+\d+\s+of|$)/g;
  const rows = [];
  let m;
  while ((m = rowRe.exec(t))) {
    const caseNumber = m[2];
    let body = m[3];
    // Everything before "--- versus ---" is plaintiff side; drop the defendant side.
    const vs = body.split(/-{2,}\s*versus\s*-{2,}/i);
    const plaintiffSide = vs[0];
    let comment = null;
    const cm = /Comment:\s*([^\n]*)/i.exec(body);
    if (cm) comment = cleanWhitespace(cm[1]) || null;
    const typeM = /Magistrate\s+Dispossessory\s*-\s*([^\n]+(?:\n[^\n]+)?)/i.exec(plaintiffSide);
    let caseType = typeM ? cleanWhitespace(typeM[1]).replace(/\s+Pro Se.*$/i, '') : null;
    let head = plaintiffSide.split(/Magistrate\s+Dispossessory/i)[0];
    const lines = head.split('\n').map(cleanWhitespace).filter(Boolean);
    // The plaintiff may span two lines; the last line(s) are the attorney name.
    let plaintiff = null, attorney = null;
    if (lines.length === 1) plaintiff = lines[0];
    else if (lines.length >= 2) {
      const last = lines[lines.length - 1];
      const isAttorney = !looksLikeEntity(last) || /^(pro se|d\s+)/i.test(last);
      if (isAttorney) { attorney = last.replace(/^D\s+/, ''); plaintiff = lines.slice(0, -1).join(' '); }
      else plaintiff = lines.join(' ');
    }
    if (plaintiff) {
      plaintiff = cleanWhitespace(plaintiff);
      // A long plaintiff ("... AS TRUSTEE OF LSF9 MASTER ET AL") can wrap so
      // that the attorney's name lands on its last line: split it off.
      const et = /^(.*?\bET\s+AL\.?)\s+([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]*){1,3})$/i.exec(plaintiff);
      if (et) { plaintiff = et[1]; attorney = attorney || et[2]; }
      plaintiff = plaintiff.replace(/,?\s*ET\s+AL\.?$/i, '').trim();
    }
    const split = splitPlaintiff(plaintiff);
    rows.push({
      case_number: caseNumber,
      plaintiff_name: split.entity || plaintiff,
      plaintiff_raw: plaintiff,
      plaintiff_attorney: attorney && !/pro se/i.test(attorney) ? attorney : null,
      community_name: split.community,
      case_type: caseType ? caseType.replace(/\s+/g, ' ') : null,
      comment,
      hearing_date: header.date || null,
      hearing_time: header.time || null,
      judge: header.judge || null,
      virtual,
    });
  }
  return { header, rows };
}

/**
 * Fulton Magistrate dispossessory calendars (DocumentCenter; Word .doc/.docx
 * or PDF). After text extraction each case appears as a line sequence:
 *   26ED390159 / <plaintiff> / <defendants...> / 06/11/2026 (filed date).
 * Only the line right after the case number (the plaintiff) and the date
 * are kept; defendant lines are discarded. `hearingDate` comes from the
 * document title on the calendar page.
 */
export function parseFultonCalendar(text, { hearingDate = null, courtroom = null } = {}) {
  const t = String(text || '').replace(/\r/g, '');
  const header = { date: hearingDate, courtroom };
  const jm = /Judge\s+([A-Z][A-Za-z.'\- ]+)/.exec(t);
  if (jm) header.judge = cleanWhitespace(jm[1]);
  const lines = t.split('\n').map(cleanWhitespace).filter(Boolean);
  const LABEL = /^(Plaintiff|Defendant|Attorney|File Date|Comment|Comments?)\s*:?$/i;
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    const cm = /^(\d{2}ED\d{5,7})\b/.exec(lines[i]);
    if (!cm) continue;
    const caseNumber = cm[1];
    let plaintiff = null;
    // Preferred: the "X vs. Y" caption line just before the case number.
    for (let k = i - 1; k >= Math.max(0, i - 3); k--) {
      const vs = /^(.*?)\s+v(?:s\.?|\.)\s+/i.exec(lines[k]);
      if (vs) { plaintiff = vs[1]; break; }
    }
    // Fallback: the first non-label line after "Plaintiff:" (before "Defendant:").
    if (!plaintiff) {
      let seenPl = false;
      for (let k = i + 1; k < Math.min(lines.length, i + 8); k++) {
        if (/^Defendant/i.test(lines[k]) || /^\d{2}ED\d{5,7}/.test(lines[k])) break;
        if (/^Plaintiff/i.test(lines[k])) { seenPl = true; continue; }
        if (LABEL.test(lines[k])) continue;
        if (seenPl || k === i + 1) { plaintiff = lines[k]; break; }
      }
    }
    if (!plaintiff) continue;
    plaintiff = cleanWhitespace(plaintiff).replace(/[,\s]+$/, '');
    let filed = null;
    for (let k = i + 1; k < Math.min(lines.length, i + 16); k++) {
      if (/^\d{2}ED\d{5,7}/.test(lines[k])) break;
      const d = /^(\d{1,2}\/\d{1,2}\/\d{4})$/.exec(lines[k]);
      if (d) { filed = parseDateLoose(d[1]); break; }
    }
    const split = splitPlaintiff(plaintiff);
    rows.push({
      case_number: caseNumber,
      plaintiff_name: split.entity || plaintiff,
      plaintiff_raw: plaintiff,
      community_name: split.community,
      filed_date: filed,
      hearing_date: hearingDate,
      courtroom,
      judge: header.judge || null,
      plaintiff_is_entity: looksLikeEntity(plaintiff),
    });
  }
  const seen = new Set();
  return { header, rows: rows.filter(r => !seen.has(r.case_number) && seen.add(r.case_number)) };
}

/**
 * Henry County magistrate dispossessory calendar (iframe.henrycountyga.gov PDFs).
 * Rows: "MGCD2026006124   2026-6124CD   PLAINTIFF   DEFENDANT ..." wrapped over
 * several lines, followed by a time line "9:00   AM". Only plaintiff-side data is kept.
 */
const SUFFIX_TOKEN = /^(LLC|L\.L\.C\.?|INC\.?|LP|L\.P\.?|LLP|LLLP|CORP\.?|CO\.?|COMPANY|TRUST|PLLC|P\.?C\.?|LTD\.?)$/i;
const COMMUNITY_TOKEN = /^(APARTMENTS|HOMES|PROPERTIES|RESIDENTIAL|PARTNERS|MANAGEMENT|ASSOCIATION|GROUP|COMMUNITIES|VILLAGE|PLACE|PARK|POINTE?|RIDGE|CREEK|ESTATES|COMMONS|CROSSING|LANDING|MANOR|TERRACE|GARDENS|TOWNHOMES|VILLAS|LUXURY|SQUARE|STATION|LOFTS|FLATS|RESERVE|HEIGHTS|GLEN|COVE|TRACE|WALK|MILL|GROVE|WOODS|LAKE|LAKES|HILL|HILLS|OAKS|PINES|BRIDGES|CROSSINGS|GATE|GATES|VISTA|VIEW|RUN)$/i;

/**
 * "PEGASUS RESIDENTIAL, LLC A/A/F SOMERSET LUXURY APARTMENTS THOMPSON SHAMEKA, ALL OTHER OCCUPANTS"
 * -> "PEGASUS RESIDENTIAL, LLC A/A/F SOMERSET LUXURY APARTMENTS".
 * Defendants are "LAST FIRST[ MIDDLE]," followed by an occupants phrase; walk
 * back two name tokens from that comma (three when the token before them is a
 * legal suffix, e.g. "LLC WORKS ADRIANNA TARNISHA,").
 */
export function cutDefendant(flat) {
  const m = /,\s+(?:AND\s+ALL|ALL\s+OTHER|OTHER\s+OCCUPANTS|ET\s+AL|ALL\s+OTHERS)\b/i.exec(flat);
  if (!m) {
    // No occupants phrase: keep the longest prefix ending in an entity/community word.
    const toks = flat.split(' ');
    let last = -1;
    toks.forEach((tk, i) => { if (SUFFIX_TOKEN.test(tk.replace(/,$/, '')) || COMMUNITY_TOKEN.test(tk)) last = i; });
    if (last >= 0) return toks.slice(0, last + 1).join(' ');
    // "PHILLIPS EDNA M BANKS LYNETT": a person suing a person with no
    // delimiter between them. The boundary cannot be found reliably, so the
    // row is dropped rather than risk storing the tenant's name; individual
    // landlords are never targets anyway.
    return null;
  }
  const before = flat.slice(0, m.index);
  const toks = before.split(' ');
  let cut = toks.length - 2;
  // "LLC WORKS ADRIANNA TARNISHA," — a plaintiff never ends in a bare surname after its suffix.
  if (cut - 2 >= 0 && SUFFIX_TOKEN.test(toks[cut - 2].replace(/,$/, '')) && !SUFFIX_TOKEN.test(toks[cut - 1].replace(/,$/, ''))) cut = cut - 1;
  if (cut - 1 >= 0 && toks[cut - 1].length <= 2 && /^[A-Z]\.?$/.test(toks[cut - 1])) cut = cut - 1; // middle initial belongs to the person
  return toks.slice(0, Math.max(0, cut)).join(' ');
}

export function parseHenryCalendar(text) {
  const t = String(text || '').replace(/\r/g, '');
  const header = {};
  const jm = /HONORABLE\s+([A-Z][A-Za-z.'\- ]+)/.exec(t);
  if (jm) header.judge = cleanWhitespace(jm[1]);
  const dm = /Dispossessory\s+[A-Za-z]+,?\s+([A-Z][a-z]+\s+\d{1,2},?\s+\d{4})/.exec(t.replace(/\s{2,}/g, ' '));
  if (dm) header.date = parseDateLoose(dm[1]);
  const rows = [];
  // Column gaps are 2+ spaces with pdf.js but a single space with unpdf (the
  // edge runtime), so the plaintiff/defendant boundary is always found by
  // cutDefendant() on the flattened row rather than by column spacing.
  const re = /(MGCD\d{10})\s+(\d{4}-\d{3,6}[A-Z]{1,3})\s+([\s\S]*?)\n\s*(\d{1,2}:\d{2}\s+[AP]M)/g;
  let m;
  while ((m = re.exec(t))) {
    const flat = m[3].replace(/\s+/g, ' ').trim();
    let plaintiff = cutDefendant(flat);
    if (!plaintiff) continue; // person-vs-person row with no reliable boundary: dropped (see cutDefendant)
    plaintiff = cleanWhitespace(plaintiff).replace(/[,\s]+$/, '');
    const split = splitPlaintiff(plaintiff);
    rows.push({
      case_number: m[1],
      case_number_alt: m[2],
      plaintiff_name: split.entity || plaintiff,
      plaintiff_raw: plaintiff,
      community_name: split.community,
      hearing_date: header.date || null,
      hearing_time: cleanWhitespace(m[4]),
      judge: header.judge || null,
      plaintiff_is_entity: looksLikeEntity(plaintiff),
    });
  }
  return { header, rows };
}
