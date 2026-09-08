// Douglas County legal organ (Douglas County Sentinel). Foreclosure ads are
// public HTML classified pages, but the site's Terms of Use (Paxton Media
// Group) prohibit automated retrieval and its edge rate-limits server IPs
// (HTTP 429). This adapter therefore only performs ONE gentle listing check
// per run to detect new notice URLs (for the Admin "needs manual pull" list)
// and never fetches notice bodies automatically. Bridgeway ingests the
// notices by uploading the e-Edition legal section (subscriber) or the
// notice text/PDF in the Admin tab.
import { parseBloxClassifiedLinks } from '../parsers/feeds.js';

const LIST = 'https://www.douglascountysentinel.com/classifieds/community/announcements/legal/';

export const douglasSentinelLegals = {
  id: 'douglas_sentinel_legals',
  county: 'Douglas',
  label: 'Douglas County Sentinel — legal announcements (listing check only)',
  kind: 'foreclosure',
  enabledByDefault: true,
  notes: 'Site terms prohibit automated collection; the adapter only records new notice URLs from one listing request so staff can pull them. Upload the weekly legal section (e-Edition subscriber) to ingest notices.',
  async discover(ctx) {
    const res = await ctx.http.get(LIST, { cache: false });
    if (res.status === 429) throw new Error('rate limited (HTTP 429) by the newspaper site; retry next run');
    if (!res.ok) throw new Error(`listing HTTP ${res.status}`);
    const links = parseBloxClassifiedLinks(res.text, 'https://www.douglascountysentinel.com');
    const seenBefore = ctx.seen || (() => false);
    const records = links.filter(l => l.isForeclosure).map(l => ({
      source_id: this.id, external_id: 'ad:' + l.id, url: l.url, kind: 'notice_link', county: 'Douglas',
      seen_only: seenBefore('ad:' + l.id), title: l.slug.replace(/-/g, ' '),
    }));
    return { records, cursor: { last_check: new Date().toISOString(), ads_listed: links.length }, diagnostics: { ads_listed: links.length, foreclosure_links: records.length } };
  },
};
