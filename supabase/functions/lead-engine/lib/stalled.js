// Stalled-lead identification.
//
// Given leads and their message history, return every lead that needs a person
// or a follow-up, with a reason code and how long it has been waiting. Pure
// function; thresholds are data so they can be tuned from results.

const MIN = 60000; const HOUR = 60 * MIN; const DAY = 24 * HOUR;
const t = (v) => (v == null ? null : new Date(v).getTime());

export const DEFAULT_RULES = {
  // Values set from the Jun-Nov 2026 lead history: one customer switched to
  // another company 16 minutes after agreeing a time, most junk requests had a
  // 3-day window, and no junk lead revived after 7 days of silence.
  firstResponseMinutes: 60,        // inbound lead with no reply at all (alert); 4 hours is a hard breach
  unansweredReplyHours: 4,         // customer wrote back and nobody answered
  quoteNudgeDays: [1, 3],          // nudges after a quote with no customer reply, then stop
  quoteExpireDays: 14,             // then the lead is closed as lost: no response
  bookedNoDepositHours: 24,
  depositNoScheduleDays: 2,
  completedUnpaidDays: 2,
  staleAfterDays: 45,              // older than this: reactivation list, not recovery
};

const OPEN = new Set(['new', 'acknowledged', 'quoted', 'booked', 'deposit_paid', 'completed']);

/**
 * @param {object[]} leads     {id, status, channel, received_at, quoted_at?, booked_at?, deposit_at?,
 *                              scheduled_for?, completed_at?, paid_at?, platform_waiting_flag?, do_not_contact?}
 * @param {object[]} messages  {lead_id, direction: 'in'|'out', at, automated?}
 * @param {Date|string|number} now
 */
export function identifyStalled(leads, messages, now, rules = {}) {
  const r = { ...DEFAULT_RULES, ...rules };
  const nowMs = t(now);
  const byLead = new Map();
  for (const m of messages) {
    if (!byLead.has(m.lead_id)) byLead.set(m.lead_id, []);
    byLead.get(m.lead_id).push(m);
  }
  const out = [];
  for (const lead of leads) {
    if (!OPEN.has(lead.status) || lead.do_not_contact) continue;
    const msgs = (byLead.get(lead.id) ?? []).sort((a, b) => t(a.at) - t(b.at));
    const lastIn = [...msgs].reverse().find((m) => m.direction === 'in');
    const lastHumanOut = [...msgs].reverse().find((m) => m.direction === 'out' && !m.automated);
    const anyOut = msgs.some((m) => m.direction === 'out');
    const received = t(lead.received_at);
    const flag = (reason, sinceMs, extra = {}) => out.push({
      lead_id: lead.id, channel: lead.channel, reason, waiting_hours: Math.round((nowMs - sinceMs) / HOUR * 10) / 10,
      stale: nowMs - received > r.staleAfterDays * DAY, ...extra,
    });

    if (lead.status === 'completed') {
      if (!lead.paid_at && nowMs - t(lead.completed_at) > r.completedUnpaidDays * DAY) flag('completed_unpaid', t(lead.completed_at), { action: 'collect_balance' });
      continue;
    }
    if (lead.status === 'deposit_paid') {
      if (!lead.scheduled_for && nowMs - t(lead.deposit_at) > r.depositNoScheduleDays * DAY) flag('deposit_no_schedule', t(lead.deposit_at), { action: 'schedule_job' });
      continue;
    }
    if (lead.status === 'booked') {
      if (!lead.deposit_at && nowMs - t(lead.booked_at) > r.bookedNoDepositHours * HOUR) flag('booked_no_deposit', t(lead.booked_at), { action: 'request_deposit' });
      continue;
    }
    // new / acknowledged / quoted
    if (!anyOut && nowMs - received > r.firstResponseMinutes * MIN) { flag('no_first_response', received, { action: 'reply_now' }); continue; }
    if (lead.platform_waiting_flag) { flag('platform_customer_waiting', t(lastIn?.at) ?? received, { action: 'reply_now' }); continue; }
    if (lastIn && (!lastHumanOut || t(lastIn.at) > t(lastHumanOut.at)) && nowMs - t(lastIn.at) > r.unansweredReplyHours * HOUR) {
      flag('customer_reply_unanswered', t(lastIn.at), { action: 'reply_now' }); continue;
    }
    if (lead.status === 'quoted' && lead.quoted_at) {
      const quoted = t(lead.quoted_at);
      if (lastIn && t(lastIn.at) > quoted) continue;            // customer answered; handled above when overdue
      const days = (nowMs - quoted) / DAY;
      if (days >= r.quoteExpireDays) { flag('quote_expired', quoted, { action: 'close_lost_no_response' }); continue; }
      const outsSinceQuote = msgs.filter((m) => m.direction === 'out' && t(m.at) > quoted).length;
      const due = r.quoteNudgeDays.filter((d) => days >= d).length;
      if (due > outsSinceQuote) flag('quote_no_reply', quoted, { action: 'send_nudge', nudge_number: outsSinceQuote + 1 });
    }
  }
  return out.sort((a, b) => Number(a.stale) - Number(b.stale) || b.waiting_hours - a.waiting_hours);
}
