// Synthetic data only. No real customer, payment or job appears in this file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcile, channelProfit, targetCac } from '../lib/reconcile.js';

const job = (id, x = {}) => ({ id, customer_id: `cust-${id}`, quoted_cents: 40000, deposit_cents: 10000,
  booked_at: '2026-10-01T15:00:00Z', scheduled_for: '2026-10-04T14:00:00Z', completed_at: '2026-10-04T18:00:00Z', ...x });
const pay = (id, x = {}) => ({ id, provider: 'square', provider_id: `sq-${id}`, kind: 'payment', ...x });
const fin = (r, id) => r.jobs.find((j) => j.job_id === id);

test('deposit and balance are one job, not two sales', () => {
  const r = reconcile([job('A')], [
    pay('p1', { customer_id: 'cust-A', amount_cents: 10000, paid_at: '2026-10-01T15:05:00Z' }),
    pay('p2', { customer_id: 'cust-A', amount_cents: 30000, paid_at: '2026-10-04T18:10:00Z' }),
  ]);
  const a = fin(r, 'A');
  assert.equal(a.net_cents, 40000);
  assert.equal(a.status, 'paid');
  assert.equal(a.completed_paid, true);
  assert.deepEqual(a.payments.map((p) => p.role), ['deposit', 'balance']);
  assert.equal(r.unmatched.length, 0);
});

test('deposit only leaves an outstanding balance and is not a completed paid job', () => {
  const r = reconcile([job('A')], [pay('p1', { customer_id: 'cust-A', amount_cents: 10000, paid_at: '2026-10-01T15:05:00Z' })]);
  const a = fin(r, 'A');
  assert.equal(a.status, 'deposit_paid');
  assert.equal(a.outstanding_cents, 30000);
  assert.equal(a.completed_paid, false);
});

test('partial payments are identified', () => {
  const r = reconcile([job('A')], [
    pay('p1', { customer_id: 'cust-A', amount_cents: 10000, paid_at: '2026-10-01T16:00:00Z' }),
    pay('p2', { customer_id: 'cust-A', amount_cents: 15000, paid_at: '2026-10-04T18:10:00Z' }),
  ]);
  assert.equal(fin(r, 'A').status, 'partially_paid');
  assert.equal(fin(r, 'A').outstanding_cents, 15000);
});

test('balance paid outside Square counts once and verifies the job', () => {
  const r = reconcile([job('A')], [
    pay('p1', { customer_id: 'cust-A', amount_cents: 10000, paid_at: '2026-10-01T15:05:00Z' }),
    { id: 'm1', provider: 'zelle', kind: 'payment', customer_id: 'cust-A', amount_cents: 30000, paid_at: '2026-10-04T19:00:00Z', entered_by: 'jonathan' },
  ]);
  const a = fin(r, 'A');
  assert.equal(a.status, 'paid');
  assert.deepEqual(a.verified_by.sort(), ['square', 'zelle']);
});

test('a manual entry that mirrors a Square payment is held, not double counted', () => {
  const r = reconcile([job('A')], [
    pay('p1', { customer_id: 'cust-A', amount_cents: 40000, paid_at: '2026-10-04T18:10:00Z' }),
    { id: 'm1', provider: 'cash', kind: 'payment', customer_id: 'cust-A', amount_cents: 40000, paid_at: '2026-10-04T20:00:00Z' },
  ]);
  assert.equal(fin(r, 'A').net_cents, 40000);
  assert.equal(r.duplicates[0].reason, 'possible_double_entry');
});

test('the same provider id is never counted twice', () => {
  const p = pay('p1', { customer_id: 'cust-A', amount_cents: 40000, paid_at: '2026-10-04T18:10:00Z' });
  const r = reconcile([job('A')], [p, { ...p, id: 'p1-again' }]);
  assert.equal(fin(r, 'A').net_cents, 40000);
  assert.equal(r.duplicates[0].reason, 'same_provider_id');
});

test('refund follows its original payment; full refund is not revenue', () => {
  const r = reconcile([job('A', { cancelled_at: '2026-10-03T12:00:00Z', completed_at: null })], [
    pay('p1', { customer_id: 'cust-A', amount_cents: 10000, paid_at: '2026-10-01T15:05:00Z' }),
    pay('r1', { kind: 'refund', refunds_payment_id: 'p1', amount_cents: 10000, paid_at: '2026-10-03T12:30:00Z' }),
  ]);
  const a = fin(r, 'A');
  assert.equal(a.net_cents, 0);
  assert.equal(a.status, 'cancelled_refunded');
  assert.equal(a.completed_paid, false);
});

test('ambiguous evidence is not linked: same customer, two jobs, amount fits neither uniquely', () => {
  const jobs = [job('A'), job('B', { customer_id: 'cust-A', booked_at: '2026-10-02T15:00:00Z' })];
  const r = reconcile(jobs, [pay('p1', { customer_id: 'cust-A', amount_cents: 10000, paid_at: '2026-10-02T16:00:00Z' })]);
  assert.equal(r.links.length, 0);
  assert.equal(r.unmatched[0].reason, 'several_candidate_jobs');
  assert.deepEqual(r.unmatched[0].candidates.sort(), ['A', 'B']);
});

test('amount that fits exactly one of several jobs links at moderate confidence', () => {
  const jobs = [job('A', { quoted_cents: 40000, deposit_cents: 10000 }),
    job('B', { customer_id: 'cust-A', quoted_cents: 25000, deposit_cents: 5000, booked_at: '2026-10-02T15:00:00Z' })];
  const r = reconcile(jobs, [pay('p1', { customer_id: 'cust-A', amount_cents: 5000, paid_at: '2026-10-02T16:00:00Z' })]);
  assert.equal(r.links[0].job_id, 'B');
  assert.equal(r.links[0].confidence, 'moderate');
});

test('payment with no customer identity and no reference goes to the manual queue', () => {
  const r = reconcile([job('A')], [pay('p1', { amount_cents: 40000, paid_at: '2026-10-04T18:10:00Z' })]);
  assert.equal(r.unmatched[0].reason, 'no_customer_identity');
});

test('same amount on the same day by a different customer is not linked', () => {
  const r = reconcile([job('A')], [pay('p1', { customer_id: 'someone-else', amount_cents: 40000, paid_at: '2026-10-04T18:10:00Z' })]);
  assert.equal(r.links.length, 0);
  assert.equal(r.unmatched[0].reason, 'no_job_in_window');
});

test('a shared invoice or order reference links without customer identity', () => {
  const r = reconcile([job('A', { invoice_ref: 'INV-1042' })], [pay('p1', { reference: 'inv-1042', amount_cents: 40000, paid_at: '2026-11-20T10:00:00Z' })]);
  assert.equal(r.links[0].method, 'reference');
});

test('phone or email identifies the customer when Square has no customer record', () => {
  const r = reconcile([job('A', { customer_id: null, phone: '(404) 555-0100' })],
    [pay('p1', { phone: '+1 404-555-0100', amount_cents: 40000, paid_at: '2026-10-04T18:10:00Z' })]);
  assert.equal(r.links[0].method, 'identity_window');
});

test('manual confirmation resolves ambiguity and wins over automation', () => {
  const jobs = [job('A'), job('B', { customer_id: 'cust-A', booked_at: '2026-10-02T15:00:00Z' })];
  const r = reconcile(jobs, [pay('p1', { customer_id: 'cust-A', amount_cents: 10000, paid_at: '2026-10-02T16:00:00Z' })],
    { manualLinks: [{ payment_id: 'p1', job_id: 'B', confirmed_by: 'michael' }] });
  assert.equal(r.links[0].job_id, 'B');
  assert.equal(r.links[0].confidence, 'confirmed');
});

test('a job can be verified paid by authorised confirmation with no payment record', () => {
  const r = reconcile([job('A', { paid_confirmed_by: 'michael' })], []);
  assert.equal(fin(r, 'A').status, 'paid_confirmed_no_record');
  assert.equal(fin(r, 'A').completed_paid, true);
  assert.deepEqual(fin(r, 'A').verified_by, ['manual_confirmation']);
});

test('stored links are kept and re-running does not double count', () => {
  const jobs = [job('A')];
  const payments = [pay('p1', { customer_id: 'cust-A', amount_cents: 10000, paid_at: '2026-10-01T15:05:00Z' })];
  const first = reconcile(jobs, payments);
  const second = reconcile(jobs, payments, { existingLinks: first.links });
  assert.equal(fin(second, 'A').net_cents, 10000);
  assert.equal(second.links.length, 1);
});

test('channel profit counts completed paid jobs only and puts spend on the right channel', () => {
  const jobs = [
    job('A', { channel: 'thumbtack', direct_cost_cents: 9000 }),
    job('B', { channel: 'thumbtack', direct_cost_cents: 9000 }),
    job('C', { channel: 'lsa' }),
  ];
  const r = reconcile(jobs, [
    pay('p1', { customer_id: 'cust-A', amount_cents: 40000, paid_at: '2026-10-04T18:10:00Z' }),
    pay('p2', { customer_id: 'cust-B', amount_cents: 10000, paid_at: '2026-10-01T15:10:00Z' }), // deposit only
    pay('p3', { customer_id: 'cust-C', amount_cents: 40000, paid_at: '2026-10-04T18:10:00Z' }),
  ]);
  const rows = channelProfit(jobs, r.jobs, [{ channel: 'thumbtack', amount_cents: 15000 }, { channel: 'lsa', amount_cents: 6000 }],
    { defaultDirectCostCents: 10000 });
  const tt = rows.find((x) => x.channel === 'thumbtack');
  const lsa = rows.find((x) => x.channel === 'lsa');
  assert.equal(tt.completed_paid_jobs, 1);
  assert.equal(tt.verified_revenue_cents, 40000);
  assert.equal(tt.cac_cents, 15000);
  assert.equal(tt.contribution_cents, 40000 - 9000 - 15000);
  assert.equal(tt.outstanding_cents, 30000);
  assert.equal(lsa.direct_cost_estimated, true);
  assert.equal(lsa.cac_cents, 6000);
});

test('target acquisition cost derives from margin, not from transaction size', () => {
  const x = targetCac({ avgJobRevenueCents: 40000, avgDirectCostCents: 15000, shareOfMarginForAcquisition: 0.4 });
  assert.equal(x.break_even_cac_cents, 25000);
  assert.equal(x.target_cac_cents, 10000);
});

test('merged Square profiles: a stale customer id still resolves to the same person', () => {
  const r = reconcile([job('A')], [
    pay('p1', { customer_id: 'old-id', amount_cents: 10000, paid_at: '2026-10-01T15:05:00Z' }),
    pay('p2', { customer_id: 'cust-A', amount_cents: 30000, paid_at: '2026-10-04T18:10:00Z' }),
  ], { customerAliases: { 'old-id': 'cust-A' } });
  assert.equal(fin(r, 'A').status, 'paid');
});

test('in-person balance on a nameless profile links through the same card as the deposit', () => {
  const r = reconcile([job('A', { card_fingerprints: ['fp-1'] })], [
    pay('p1', { customer_id: 'cust-A', card_fingerprint: 'fp-1', amount_cents: 10000, paid_at: '2026-10-01T15:05:00Z' }),
    pay('p2', { customer_id: 'nameless-profile', card_fingerprint: 'fp-1', amount_cents: 30000, paid_at: '2026-10-04T18:10:00Z' }),
  ]);
  assert.equal(fin(r, 'A').status, 'paid');
  // Without the shared card the balance must NOT be guessed onto the job.
  const r2 = reconcile([job('A')], [pay('p2', { customer_id: 'nameless-profile', amount_cents: 30000, paid_at: '2026-10-04T18:10:00Z' })]);
  assert.equal(r2.links.length, 0);
});
