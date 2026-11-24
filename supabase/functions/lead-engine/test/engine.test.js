// Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { identifyStalled } from '../lib/stalled.js';
import { tierRecommendation, capacityGate } from '../lib/gates.js';
import { requiresApproval, reviewMode, transition, canSend, buildQueue } from '../lib/approvals.js';

const NOW = '2026-11-24T15:00:00Z';
const reasons = (r) => Object.fromEntries(r.map((x) => [x.lead_id, x.reason]));

test('stalled: flags each lifecycle gap with the right reason', () => {
  const leads = [
    { id: 'noreply', status: 'new', channel: 'thumbtack', received_at: '2026-11-24T13:30:00Z' },
    { id: 'fresh', status: 'new', channel: 'website', received_at: '2026-11-24T14:55:00Z' },
    { id: 'waiting', status: 'acknowledged', channel: 'thumbtack', received_at: '2026-11-23T10:00:00Z', platform_waiting_flag: true },
    { id: 'replied', status: 'quoted', channel: 'text', received_at: '2026-11-22T10:00:00Z', quoted_at: '2026-11-22T11:00:00Z' },
    { id: 'quiet', status: 'quoted', channel: 'phone', received_at: '2026-11-20T10:00:00Z', quoted_at: '2026-11-20T11:00:00Z' },
    { id: 'expired', status: 'quoted', channel: 'yelp', received_at: '2026-11-01T10:00:00Z', quoted_at: '2026-11-01T11:00:00Z' },
    { id: 'nodeposit', status: 'booked', channel: 'lsa', received_at: '2026-11-21T10:00:00Z', booked_at: '2026-11-22T10:00:00Z' },
    { id: 'unpaid', status: 'completed', channel: 'thumbtack', received_at: '2026-11-10T10:00:00Z', completed_at: '2026-11-20T18:00:00Z' },
    { id: 'done', status: 'completed', channel: 'thumbtack', received_at: '2026-11-10T10:00:00Z', completed_at: '2026-11-20T18:00:00Z', paid_at: '2026-11-20T18:05:00Z' },
    { id: 'dnc', status: 'new', channel: 'text', received_at: '2026-11-20T10:00:00Z', do_not_contact: true },
    { id: 'lost', status: 'lost', channel: 'text', received_at: '2026-11-20T10:00:00Z' },
  ];
  const messages = [
    { lead_id: 'waiting', direction: 'out', at: '2026-11-23T10:05:00Z', automated: true },
    { lead_id: 'replied', direction: 'out', at: '2026-11-22T11:00:00Z' },
    { lead_id: 'replied', direction: 'in', at: '2026-11-24T08:00:00Z' },
    { lead_id: 'quiet', direction: 'out', at: '2026-11-20T11:00:00Z' },
    { lead_id: 'expired', direction: 'out', at: '2026-11-01T11:00:00Z' },
  ];
  const r = reasons(identifyStalled(leads, messages, NOW));
  assert.deepEqual(r, {
    noreply: 'no_first_response', waiting: 'platform_customer_waiting', replied: 'customer_reply_unanswered',
    quiet: 'quote_no_reply', expired: 'quote_expired', nodeposit: 'booked_no_deposit', unpaid: 'completed_unpaid',
  });
});

test('stalled: a nudge already sent is not requested twice', () => {
  const leads = [{ id: 'q', status: 'quoted', channel: 'text', received_at: '2026-11-22T10:00:00Z', quoted_at: '2026-11-22T12:00:00Z' }];
  const msgs = [{ lead_id: 'q', direction: 'out', at: '2026-11-22T12:00:00Z' }, { lead_id: 'q', direction: 'out', at: '2026-11-23T12:30:00Z', automated: true }];
  assert.equal(identifyStalled(leads, msgs, NOW).length, 0);          // day 2: nudge 1 sent, nudge 2 not due until day 3
  const later = identifyStalled(leads, msgs, '2026-11-25T13:00:00Z');
  assert.equal(later[0].nudge_number, 2);
});

const good = { completed_paid_jobs: 6, leads: 25, cac_cents: 9000, target_cac_cents: 10000, contribution_per_job_cents: 9000, capacity_use: 0.6, attributed_share: 1 };

test('tiers: step up is only recommended, and needs owner approval', () => {
  const r = tierRecommendation('T1', good);
  assert.equal(r.action, 'recommend_step_up');
  assert.equal(r.to, 'T2');
  assert.equal(r.needs_owner_approval, true);
});

test('tiers: hold when jobs are too few, capacity is tight or attribution is incomplete', () => {
  assert.equal(tierRecommendation('T1', { ...good, completed_paid_jobs: 3 }).action, 'hold');
  assert.equal(tierRecommendation('T1', { ...good, capacity_use: 0.9 }).action, 'hold');
  assert.equal(tierRecommendation('T1', { ...good, attributed_share: 0.6 }).action, 'hold');
  assert.equal(tierRecommendation('T3', { ...good, completed_paid_jobs: 25, cac_cents: 8000, windows_meeting_criteria: 1 }).action, 'hold');
});

test('tiers: step down or pause when economics or capacity break; not judged before 20 leads', () => {
  assert.equal(tierRecommendation('T2', { ...good, cac_cents: 16000 }).action, 'step_down');
  assert.equal(tierRecommendation('T1', { ...good, completed_paid_jobs: 0, leads: 22 }).action, 'pause_and_review');
  assert.equal(tierRecommendation('T2', { ...good, capacity_use: 1.1 }).to, 'T1');
  assert.equal(tierRecommendation('T1', { ...good, cac_cents: 20000, leads: 8, completed_paid_jobs: 1 }).action, 'hold');
});

test('capacity: demand generation throttles before commitments exceed crew capacity', () => {
  assert.equal(capacityGate({ extra_jobs_per_week: 5, booked_next_7_days: 2, open_quotes: 2 }).state, 'open');
  const tight = capacityGate({ extra_jobs_per_week: 5, booked_next_7_days: 4, open_quotes: 1 });
  assert.equal(tight.state, 'tight'); assert.equal(tight.paid_ads, 'hold_budget');
  const full = capacityGate({ extra_jobs_per_week: 5, booked_next_7_days: 5, open_quotes: 3 });
  assert.equal(full.paid_ads, 'pause_until_next_week');
  assert.equal(full.booking_offer, 'offer_next_week_slots');
  assert.equal(full.follow_ups_on_existing_leads, 'run');
});

test('approvals: marketing and outreach always queue; ordinary service replies do not', () => {
  assert.equal(requiresApproval({ direction: 'out', purpose: 'outreach' }), true);
  assert.equal(requiresApproval({ direction: 'out', purpose: 'marketing' }), true);
  assert.equal(requiresApproval({ direction: 'out', purpose: 'service' }), false);
  assert.equal(requiresApproval({ direction: 'out', purpose: 'service', price_outside_range: true }), true);
});

test('approvals: first contact with a business is always reviewed individually', () => {
  assert.equal(reviewMode({ first_contact_with_organization: true, template_approved: true }), 'individual');
  assert.equal(reviewMode({ template_approved: true, personalization_confidence: 0.95 }), 'batch');
  assert.equal(reviewMode({ template_approved: true, personalization_confidence: 0.5 }), 'individual');
});

test('approvals: nothing sends unapproved; suppression and consent are rechecked at send time', () => {
  let item = { id: 'a', state: 'pending', channel: 'email', purpose: 'outreach', body: 'draft' };
  const ctx = { suppressed: false, hasMarketingConsent: false, outboundPaused: false, dailyCapRemaining: 5 };
  assert.deepEqual(canSend(item, ctx), { ok: false, reason: 'not_approved' });
  assert.throws(() => transition(item, 'approved', {}), /named approver/);
  item = transition(item, 'edited_approved', { by: 'michael', at: NOW, editedBody: 'better' });
  assert.equal(item.body, 'better'); assert.equal(item.original_body, 'draft');
  assert.equal(canSend(item, ctx).ok, true);
  assert.equal(canSend(item, { ...ctx, suppressed: true }).reason, 'suppressed');
  assert.equal(canSend(item, { ...ctx, dailyCapRemaining: 0 }).reason, 'daily_cap_reached');
  assert.equal(canSend({ ...item, channel: 'sms', purpose: 'marketing' }, ctx).reason, 'no_text_consent');
  assert.throws(() => transition({ state: 'rejected' }, 'sent', {}), /cannot move/);
});

test('approvals: queue groups repeat messages into batches for one-tap review', () => {
  const mk = (id, x) => ({ id, state: 'pending', template_code: 'review_request', audience: 'past_customers', template_approved: true, ...x });
  const q = buildQueue([mk('1'), mk('2'), mk('3'), mk('4', { first_contact_with_organization: true, value_score: 9 }), mk('5', { state: 'sent' })]);
  assert.equal(q.total, 4);
  assert.equal(q.batches[0].count, 3);
  assert.equal(q.individual[0].id, '4');
});
