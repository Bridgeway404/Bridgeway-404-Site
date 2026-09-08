// Parsers for the listing formats the adapters read. Pure functions over text.
import { stripHtml, parseDateLoose } from '../normalize.js';

/** RSS 2.0 items (TownNews/BLOX search feeds and generic feeds). */
export function parseRss(xml) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/gi;
  let m;
  const pick = (block, tag) => {
    const r = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(block);
    if (!r) return null;
    return r[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, '$1').replace(/&amp;/g, '&').trim();
  };
  while ((m = re.exec(xml))) {
    const b = m[1];
    const enclosure = /<enclosure[^>]*url="([^"]+)"/i.exec(b);
    items.push({
      title: pick(b, 'title'),
      link: pick(b, 'link'),
      guid: pick(b, 'guid'),
      pubDate: pick(b, 'pubDate'),
      description: pick(b, 'description'),
      enclosure: enclosure ? enclosure[1].replace(/&amp;/g, '&') : null,
    });
  }
  return items;
}

/** The public PDF download link on a BLOX pdf asset page. */
export function bloxAssetPdfUrl(html) {
  const m = /href="(https:\/\/bloximages[^"]+\.pdf(?:\.pdf)?)"/i.exec(html) || /"(https:\/\/bloximages[^"]+\.pdf)"/i.exec(html);
  return m ? m[1].replace(/&amp;/g, '&') : null;
}

/** WordPress REST media listing (dekalbcountymagistratecourt.com, dekalblegalnotices.com). */
export function parseWpMedia(json) {
  const arr = typeof json === 'string' ? JSON.parse(json) : json;
  if (!Array.isArray(arr)) return [];
  return arr.map(it => ({
    id: String(it.id),
    date: it.date || null,
    slug: it.slug || null,
    title: it.title && typeof it.title === 'object' ? it.title.rendered : (it.title || null),
    url: it.source_url || (it.guid && it.guid.rendered) || null,
  })).filter(x => x.url);
}

/**
 * Fulton Magistrate Court "Court Calendars" page (CivicPlus). Links look like
 * /DocumentCenter/View/15688/Dispossessory---September-8-2026---9-AM---COURTROOM-6G
 */
export function parseCivicPlusCalendarLinks(html, baseUrl = 'https://www.magistratefulton.org') {
  const out = [];
  const re = /href="(\/DocumentCenter\/View\/(\d+)\/([^"]+))"/gi;
  let m;
  const seen = new Set();
  while ((m = re.exec(html))) {
    const id = m[2];
    if (seen.has(id)) continue;
    seen.add(id);
    const slug = decodeURIComponent(m[3]);
    if (!/dispossessory/i.test(slug)) continue;
    const parts = slug.split(/---|-{2,}/).map(s => s.replace(/-/g, ' ').trim());
    const dateStr = parts[1] || '';
    const timeStr = parts[2] || '';
    const room = parts[3] || '';
    out.push({ id, url: baseUrl + m[1], title: parts.join(' - '), date: parseDateLoose(dateStr), time: timeStr, courtroom: room.replace(/^COURTROOM\s*/i, ''), kind: 'dispossessory' });
  }
  return out;
}

/**
 * Henry County magistrate judges' calendar page (iframe.henrycountyga.gov).
 * Links look like ../portals/0/files/Courts/Magistrate%20Court/Judge%20X/Archive/9_1_2026_Name_Dispossessory.pdf
 */
export function parseHenryCalendarLinks(html, baseUrl = 'https://iframe.henrycountyga.gov') {
  const out = [];
  const re = /href="([^"]*?\/portals\/0\/files\/Courts\/Magistrate[^"]*?(\d{1,2})_(\d{1,2})_(\d{4})_([^"\/]*?)_Dispossessory\.pdf)"/gi;
  let m;
  const seen = new Set();
  while ((m = re.exec(html))) {
    let href = m[1].replace(/&amp;/g, '&');
    href = href.replace(/^\.\.\//, '/');
    if (!href.startsWith('http')) href = baseUrl + (href.startsWith('/') ? '' : '/') + href;
    if (seen.has(href)) continue;
    seen.add(href);
    const date = `${m[4]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    out.push({ url: href, date, judge: decodeURIComponent(m[5]).replace(/%20/g, ' '), kind: 'dispossessory' });
  }
  return out;
}

/** BLOX classifieds listing page: ad links whose title looks like a foreclosure notice. */
export function parseBloxClassifiedLinks(html, baseUrl) {
  const out = [];
  const re = /href="((?:https?:\/\/[^"\/]+)?\/classifieds\/[^"]*?\/ad_([a-f0-9-]{36})\.html)"/gi;
  let m;
  const seen = new Set();
  while ((m = re.exec(html))) {
    const id = m[2];
    if (seen.has(id)) continue;
    seen.add(id);
    const href = m[1].startsWith('http') ? m[1] : baseUrl + m[1];
    const slug = m[1].split('/').slice(-2, -1)[0] || '';
    out.push({ id, url: href, slug, isForeclosure: /foreclos|sale-under-power|power-of-sale|notice-of-sale|security-deed/i.test(slug) });
  }
  return out;
}

/** Text of a BLOX classified ad page (the notice body). */
export function bloxAdText(html) {
  const m = /<div[^>]*class="[^"]*(?:ad-description|asset-body|body-copy|classified-ad-body)[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i.exec(html);
  const body = m ? m[1] : html;
  return stripHtml(body);
}
