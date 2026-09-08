// Polite HTTP: per-host minimum spacing, small concurrency, retries on 429/5xx,
// in-run response cache. The fetch implementation is injected so tests never
// touch the network.

// Self-identifying, but browser-shaped: ASP.NET sites (Henry County's calendar
// page) render their link tree only for user agents that start with "Mozilla/5.0".
const DEFAULT_UA = 'Mozilla/5.0 (compatible; BridgewayResearch/1.0; +https://bridgeway404.com; info@bridgeway404.com)';

export function createHttp({ fetchImpl, minIntervalMs = {}, defaultIntervalMs = 4000, userAgent = DEFAULT_UA, maxRetries = 2, log = () => {} } = {}) {
  const f = fetchImpl || globalThis.fetch;
  const lastAt = new Map();
  const cache = new Map();
  const stats = { requests: 0, retries: 0, failures: 0, byHost: {} };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  async function throttle(host) {
    const gap = minIntervalMs[host] ?? defaultIntervalMs;
    const last = lastAt.get(host) || 0;
    const wait = last + gap - Date.now();
    if (wait > 0) await sleep(wait);
    lastAt.set(host, Date.now());
  }

  async function get(url, opts = {}) {
    if (opts.cache !== false && cache.has(url)) return cache.get(url);
    const host = new URL(url).hostname;
    let attempt = 0;
    for (;;) {
      await throttle(host);
      stats.requests++;
      stats.byHost[host] = (stats.byHost[host] || 0) + 1;
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), opts.timeoutMs || 30000);
      try {
        const res = await f(url, {
          method: 'GET',
          headers: { 'user-agent': userAgent, accept: opts.accept || 'text/html,application/xhtml+xml,application/xml,application/json;q=0.9,*/*;q=0.8', 'accept-language': 'en-US,en;q=0.9', ...(opts.headers || {}) },
          redirect: 'follow',
          signal: ctrl.signal,
        });
        const ct = res.headers.get('content-type') || '';
        let out;
        if (opts.binary || /pdf|octet-stream/i.test(ct)) {
          const buf = new Uint8Array(await res.arrayBuffer());
          out = { ok: res.ok, status: res.status, url: res.url || url, contentType: ct, bytes: buf, text: null };
        } else {
          const text = await res.text();
          out = { ok: res.ok, status: res.status, url: res.url || url, contentType: ct, text, bytes: null };
        }
        if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
          attempt++; stats.retries++;
          const backoff = res.status === 429 ? 15000 * attempt : 3000 * attempt;
          log(`retry ${attempt} after ${res.status} for ${url} (waiting ${backoff}ms)`);
          await sleep(backoff);
          continue;
        }
        if (!res.ok) stats.failures++;
        if (opts.cache !== false && res.ok) cache.set(url, out);
        return out;
      } catch (e) {
        if (attempt < maxRetries) { attempt++; stats.retries++; await sleep(2000 * attempt); continue; }
        stats.failures++;
        return { ok: false, status: 0, url, contentType: '', text: null, bytes: null, error: String(e) };
      } finally { clearTimeout(t); }
    }
  }

  return { get, stats };
}

export class SourceError extends Error {
  constructor(message, { status, url, kind } = {}) { super(message); this.status = status; this.url = url; this.kind = kind || 'source_error'; }
}
