// Approval queue for outbound marketing communications.
//
// Nothing marketing-related leaves without a named person approving it.
// Service replies inside a conversation the customer started (acknowledging a
// lead, confirming an appointment) are not marketing and do not queue here.
//
// The queue is built for a phone: items are grouped into batches that share a
// template and audience, so one decision can cover many near-identical
// messages, while anything novel is reviewed one at a time.

export const STATES = ['pending', 'approved', 'edited_approved', 'rejected', 'expired', 'sent', 'blocked'];

const TRANSITIONS = {
  pending: ['approved', 'edited_approved', 'rejected', 'expired', 'blocked'],
  approved: ['sent', 'blocked', 'expired'],
  edited_approved: ['sent', 'blocked', 'expired'],
  rejected: [], expired: [], sent: [], blocked: [],
};

/** Does this message need approval before sending? */
export function requiresApproval(msg) {
  if (msg.direction !== 'out') return false;
  if (msg.purpose === 'marketing' || msg.purpose === 'outreach') return true;
  // Service messages still need approval when they contain a price outside the published range.
  return msg.purpose === 'service' && msg.price_outside_range === true;
}

/** Batch-approvable = an already-approved template, to a recipient who is not a first-ever business contact. */
export function reviewMode(item) {
  if (item.first_contact_with_organization) return 'individual';
  if (!item.template_approved) return 'individual';
  if (item.personalization_confidence != null && item.personalization_confidence < 0.8) return 'individual';
  return 'batch';
}

export function transition(item, to, { by, at, editedBody } = {}) {
  if (!TRANSITIONS[item.state]?.includes(to)) throw new Error(`cannot move approval from ${item.state} to ${to}`);
  if (['approved', 'edited_approved', 'rejected'].includes(to) && !by) throw new Error('a named approver is required');
  if (to === 'edited_approved' && !editedBody) throw new Error('edited approval needs the edited body');
  const next = { ...item, state: to, history: [...(item.history ?? []), { from: item.state, to, by: by ?? 'system', at }] };
  if (to === 'edited_approved') { next.original_body = item.body; next.body = editedBody; }
  if (to === 'approved' || to === 'edited_approved') { next.approved_by = by; next.approved_at = at; }
  return next;
}

/**
 * Final gate, run at send time (suppression may have changed since approval).
 * @returns {{ok: boolean, reason?: string}}
 */
export function canSend(item, { suppressed, hasMarketingConsent, outboundPaused, dailyCapRemaining }) {
  if (!['approved', 'edited_approved'].includes(item.state)) return { ok: false, reason: 'not_approved' };
  if (outboundPaused) return { ok: false, reason: 'outbound_paused' };
  if (suppressed) return { ok: false, reason: 'suppressed' };
  if (item.channel === 'sms' && item.purpose !== 'service' && !hasMarketingConsent) return { ok: false, reason: 'no_text_consent' };
  if (dailyCapRemaining != null && dailyCapRemaining <= 0) return { ok: false, reason: 'daily_cap_reached' };
  return { ok: true };
}

/** Group pending items for the phone screen: batches first (largest first), then individual items by value. */
export function buildQueue(items) {
  const pending = items.filter((i) => i.state === 'pending');
  const batches = new Map();
  const individual = [];
  for (const i of pending) {
    if (reviewMode(i) === 'batch') {
      const key = `${i.template_code}|${i.audience}`;
      if (!batches.has(key)) batches.set(key, { template_code: i.template_code, audience: i.audience, items: [] });
      batches.get(key).items.push(i);
    } else individual.push(i);
  }
  return {
    batches: [...batches.values()].sort((a, b) => b.items.length - a.items.length)
      .map((b) => ({ ...b, count: b.items.length, sample: b.items.slice(0, 3).map((x) => x.id) })),
    individual: individual.sort((a, b) => (b.value_score ?? 0) - (a.value_score ?? 0)),
    total: pending.length,
  };
}
