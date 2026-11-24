/* Bridgeway 404 — first-party lead source attribution.
   Records how a visitor arrived (campaign tags, ad click id, referring site and
   first page) in this browser's own storage and copies it into hidden fields on
   our forms, so each quote request can be traced to the channel that produced
   it. Nothing is sent to any third party and no cookie is set. If storage is
   unavailable the forms still work; the fields are simply left blank. */
(function () {
  'use strict';
  var KEY = 'bw404_attr_v1';
  var PARAMS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'gbraid', 'wbraid', 'ref'];
  var MAX = 200;

  function clean(v) { return String(v == null ? '' : v).replace(/[^\w\-.~:/ %+@=,]/g, '').slice(0, MAX); }
  function read() { try { return JSON.parse(window.localStorage.getItem(KEY)) || null; } catch (e) { return null; } }
  function write(v) { try { window.localStorage.setItem(KEY, JSON.stringify(v)); } catch (e) { /* storage blocked: attribution is optional */ } }

  function current() {
    var q; try { q = new URLSearchParams(window.location.search); } catch (e) { q = null; }
    var t = { landing_page: clean(window.location.pathname), at: new Date().toISOString() };
    var tagged = false;
    PARAMS.forEach(function (p) { var v = q && q.get(p); if (v) { t[p] = clean(v); tagged = true; } });
    var ref = '';
    try { if (document.referrer && new URL(document.referrer).hostname !== window.location.hostname) ref = new URL(document.referrer).hostname; } catch (e) { ref = ''; }
    if (ref) { t.referrer = clean(ref); tagged = true; }
    t.tagged = tagged;
    return t;
  }

  function channel(t) {
    if (!t) return 'direct';
    if (t.gclid || t.gbraid || t.wbraid) return 'google_ads';
    if (t.utm_medium && /cpc|ppc|paid/i.test(t.utm_medium)) return clean(t.utm_source || 'paid') + '_paid';
    if (t.utm_source) return clean(t.utm_source);
    if (t.ref) return 'referral_code';
    if (t.referrer) {
      if (/google\./i.test(t.referrer)) return 'google_organic';
      if (/bing\.|duckduckgo\.|yahoo\./i.test(t.referrer)) return 'search_organic';
      if (/facebook\.|instagram\.|nextdoor\.|tiktok\./i.test(t.referrer)) return 'social';
      if (/thumbtack\.|yelp\./i.test(t.referrer)) return 'directory';
      return 'referral_site';
    }
    return 'direct';
  }

  var now = current();
  var saved = read() || {};
  if (!saved.first) saved.first = now;                 // first touch is never overwritten
  if (now.tagged || !saved.last) saved.last = now;     // last touch moves only on a tagged arrival
  write(saved);

  function fill() {
    var first = saved.first || now, last = saved.last || now;
    var values = {
      lead_source: channel(last),
      lead_source_first: channel(first),
      utm_source: last.utm_source || '', utm_medium: last.utm_medium || '', utm_campaign: last.utm_campaign || '',
      utm_term: last.utm_term || '', utm_content: last.utm_content || '',
      click_id: last.gclid || last.gbraid || last.wbraid || '',
      referral_code: last.ref || first.ref || '',
      landing_page: first.landing_page || '',
      referrer_site: last.referrer || first.referrer || '',
      first_visit_at: first.at || ''
    };
    var forms = document.querySelectorAll('form[data-netlify], form[name]');
    for (var i = 0; i < forms.length; i++) {
      for (var name in values) {
        var el = forms[i].querySelector('input[type="hidden"][name="' + name + '"]');
        if (el) el.value = values[name];
      }
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fill); else fill();
  window.bw404Attribution = { channel: channel };      // exposed for the browser test only
})();
