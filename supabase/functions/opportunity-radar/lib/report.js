// The Radar's contribution to the daily brief: at most `limit` items, each with
// its reasons. Plain text so it reads well on a phone.

import { suggestedAction } from './scoring.js';

export function buildDigest(scored, { limit = 5, threshold = 50, now } = {}) {
  const top = scored.filter((o) => o.score >= threshold).sort((a, b) => b.score - a.score).slice(0, limit);
  const lines = [`Opportunity Radar - ${new Date(now).toISOString().slice(0, 10)}`, ''];
  if (!top.length) lines.push('Nothing above the threshold today.');
  top.forEach((o, i) => {
    lines.push(`${i + 1}. [${o.score}] ${o.title}`);
    lines.push(`   ${[o.location, o.county && `${o.county} County`].filter(Boolean).join(' - ')}`);
    lines.push(`   Why: ${o.factors.filter((f) => f.points > 0).map((f) => f.label).join('; ')}`);
    if (o.due_at) lines.push(`   Due: ${o.due_at.slice(0, 10)}`);
    lines.push(`   Next: ${suggestedAction(o)}`);
    if (o.url) lines.push(`   ${o.url}`);
    lines.push('');
  });
  return { text: lines.join('\n').trimEnd(), items: top };
}
