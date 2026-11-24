// Job-level financial reconciliation.
//
// A job is the unit of revenue, not a payment. One job normally has a deposit
// and a later balance, sometimes a partial payment, a refund, or a payment
// taken outside Square (cash, Zelle, Cash App). This module links payments to
// jobs and computes each job's verified revenue.
//
// Design rules:
//   * A payment is linked automatically only when the evidence is strong.
//     Anything else goes to a manual queue with its candidate jobs listed.
//   * A payment is counted once. Provider ids are unique, an existing link is
//     never changed, and a manually entered off-Square payment that looks like
//     a Square payment already on file is held as a possible duplicate.
//   * A person's confirmation always wins over the automatic result.
//   * Square is one source of proof. A job can also be verified as paid by an
//     authorised manual confirmation.
//
// Pure functions, no I/O. Amounts are integer cents.

const DAY = 86400000;

export const DEFAULTS = {
  windowBeforeBookingDays: 3,     // a deposit can arrive shortly before the booking is recorded
  windowAfterCompletionDays: 30,  // balances are sometimes paid late
  openJobWindowDays: 45,          // for jobs with no completion date yet
  amountToleranceCents: 100,
  duplicateWindowDays: 2,
};

const t = (v) => (v == null ? null : new Date(v).getTime());
const lc = (v) => (v == null ? null : String(v).trim().toLowerCase() || null);

export function phoneKey(p) {
  const d = String(p ?? '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : null;
}

// Square keeps a merged customer's old id on earlier payments. `aliases` maps
// each stale id to the surviving one so both resolve to the same person.
let aliases = new Map();

function identityKeys(x) {
  const keys = [];
  if (x.customer_id) keys.push(`c:${aliases.get(x.customer_id) ?? x.customer_id}`);
  // Same card on a deposit and a balance is good secondary evidence when the
  // payment sits on a nameless profile. Only the processor's opaque fingerprint
  // is used; card numbers are never stored.
  if (x.card_fingerprint) keys.push(`f:${x.card_fingerprint}`);
  for (const f of x.card_fingerprints ?? []) keys.push(`f:${f}`);
  const ph = phoneKey(x.phone ?? x.phone_key);
  if (ph) keys.push(`p:${ph}`);
  const em = lc(x.email);
  if (em) keys.push(`e:${em}`);
  return keys;
}

function sharesIdentity(a, b) {
  const kb = new Set(identityKeys(b));
  return identityKeys(a).some((k) => kb.has(k));
}

function referenceKeys(x) {
  return [x.invoice_ref, x.booking_ref, x.order_id, x.reference, x.quote_ref]
    .map(lc).filter(Boolean);
}

function inWindow(job, paidAt, o) {
  const start = (t(job.booked_at) ?? t(job.scheduled_for) ?? t(job.completed_at));
  if (start == null || paidAt == null) return false;
  const lo = start - o.windowBeforeBookingDays * DAY;
  const end = t(job.completed_at) ?? t(job.scheduled_for);
  const hi = end != null ? end + o.windowAfterCompletionDays * DAY : start + o.openJobWindowDays * DAY;
  return paidAt >= lo && paidAt <= hi;
}

/**
 * Link payments to jobs.
 *
 * @param {object[]} jobs      {id, customer_id?, phone?, email?, quoted_cents?, deposit_cents?,
 *                              booked_at?, scheduled_for?, completed_at?, cancelled_at?,
 *                              invoice_ref?, booking_ref?, paid_confirmed_by?}
 * @param {object[]} payments  {id, provider, provider_id?, kind?: 'payment'|'refund', amount_cents,
 *                              paid_at, customer_id?, phone?, email?, order_id?, reference?,
 *                              refunds_payment_id?, entered_by?}
 * @param {object}   [opts]
 * @param {object[]} [opts.existingLinks]  links already stored: {payment_id, job_id, method}
 * @param {object[]} [opts.manualLinks]    human decisions: {payment_id, job_id|null, confirmed_by}
 * @param {object}   [opts.customerAliases] {staleCustomerId: survivingCustomerId} from Square merges
 */
export function reconcile(jobs, payments, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  aliases = new Map(Object.entries(o.customerAliases ?? {}));
  const links = [];
  const unmatched = [];
  const duplicates = [];
  const linkedPayment = new Map();
  const jobById = new Map(jobs.map((j) => [j.id, j]));
  const collected = new Map(jobs.map((j) => [j.id, 0]));   // net of refunds, grows as we link

  const addLink = (p, jobId, method, confidence, extra = {}) => {
    const amount = p.kind === 'refund' ? -Math.abs(p.amount_cents) : p.amount_cents;
    collected.set(jobId, (collected.get(jobId) ?? 0) + amount);
    const link = { payment_id: p.id, job_id: jobId, method, confidence, amount_cents: amount, ...extra };
    links.push(link);
    linkedPayment.set(p.id, link);
  };

  // 0. Duplicate provider ids: the same Square payment must never count twice.
  const seenProvider = new Map();
  const usable = [];
  for (const p of payments) {
    const key = p.provider_id ? `${p.provider}:${p.provider_id}` : null;
    if (key && seenProvider.has(key)) {
      duplicates.push({ payment_id: p.id, duplicate_of: seenProvider.get(key), reason: 'same_provider_id' });
      continue;
    }
    if (key) seenProvider.set(key, p.id);
    usable.push(p);
  }
  const byTime = [...usable].sort((a, b) => (t(a.paid_at) ?? 0) - (t(b.paid_at) ?? 0));
  const paymentById = new Map(usable.map((p) => [p.id, p]));

  // 1. Links already stored are kept exactly as they are.
  for (const l of o.existingLinks ?? []) {
    const p = paymentById.get(l.payment_id);
    if (p && jobById.has(l.job_id) && !linkedPayment.has(p.id)) addLink(p, l.job_id, l.method ?? 'existing', 'stored');
  }

  // 2. Human decisions. job_id null means "this is not job revenue" (e.g. a tip jar test).
  const manual = new Map((o.manualLinks ?? []).map((m) => [m.payment_id, m]));
  for (const p of byTime) {
    if (linkedPayment.has(p.id) || !manual.has(p.id)) continue;
    const m = manual.get(p.id);
    if (m.job_id == null) { linkedPayment.set(p.id, { payment_id: p.id, job_id: null, method: 'manual_exclude' }); continue; }
    if (jobById.has(m.job_id)) addLink(p, m.job_id, 'manual', 'confirmed', { confirmed_by: m.confirmed_by });
  }

  // 3. Off-Square entries that mirror a Square payment already on file.
  for (const p of byTime) {
    if (linkedPayment.has(p.id) || p.provider === 'square' || p.kind === 'refund') continue;
    const twin = byTime.find((q) => q.id !== p.id && q.provider === 'square' && q.kind !== 'refund'
      && q.amount_cents === p.amount_cents && sharesIdentity(p, q)
      && Math.abs((t(q.paid_at) ?? 0) - (t(p.paid_at) ?? 0)) <= o.duplicateWindowDays * DAY);
    if (twin) {
      duplicates.push({ payment_id: p.id, duplicate_of: twin.id, reason: 'possible_double_entry' });
      linkedPayment.set(p.id, { payment_id: p.id, job_id: null, method: 'held_possible_duplicate' });
    }
  }

  // 4. Automatic linking, oldest payment first so deposits land before balances.
  for (const p of byTime) {
    if (linkedPayment.has(p.id)) continue;
    const paidAt = t(p.paid_at);

    // 4a. Refunds follow the payment they refund.
    if (p.kind === 'refund') {
      const orig = p.refunds_payment_id ? linkedPayment.get(p.refunds_payment_id) : null;
      if (orig?.job_id) { addLink(p, orig.job_id, 'refund_of_linked_payment', 'strong'); continue; }
      unmatched.push({ payment_id: p.id, reason: 'refund_without_linked_original', candidates: [] });
      continue;
    }

    // 4b. A shared reference (invoice, order, booking or quote number) is decisive.
    const refs = new Set(referenceKeys(p));
    const byRef = refs.size ? jobs.filter((j) => referenceKeys(j).some((r) => refs.has(r))) : [];
    if (byRef.length === 1) { addLink(p, byRef[0].id, 'reference', 'strong'); continue; }
    if (byRef.length > 1) {
      unmatched.push({ payment_id: p.id, reason: 'reference_matches_several_jobs', candidates: byRef.map((j) => j.id) });
      continue;
    }

    // 4c. Same person, one job in the time window.
    const candidates = jobs.filter((j) => sharesIdentity(p, j) && inWindow(j, paidAt, o));
    if (candidates.length === 0) {
      const hasIdentity = identityKeys(p).length > 0;
      unmatched.push({ payment_id: p.id, reason: hasIdentity ? 'no_job_in_window' : 'no_customer_identity', candidates: [] });
      continue;
    }
    if (candidates.length === 1) { addLink(p, candidates[0].id, 'identity_window', 'strong'); continue; }

    // 4d. Several jobs for the same person: only an exact amount fit to ONE job decides it.
    const fits = candidates.filter((j) => {
      const outstanding = j.quoted_cents != null ? j.quoted_cents - (collected.get(j.id) ?? 0) : null;
      const near = (a, b) => a != null && b != null && Math.abs(a - b) <= o.amountToleranceCents;
      return near(p.amount_cents, outstanding)
        || ((collected.get(j.id) ?? 0) === 0 && near(p.amount_cents, j.deposit_cents));
    });
    if (fits.length === 1) { addLink(p, fits[0].id, 'identity_amount', 'moderate'); continue; }
    unmatched.push({ payment_id: p.id, reason: 'several_candidate_jobs', candidates: candidates.map((j) => j.id) });
  }

  return {
    links: links.filter((l) => l.job_id != null),
    unmatched,
    duplicates,
    jobs: jobs.map((j) => jobFinancials(j, links.filter((l) => l.job_id === j.id), paymentById, o)),
  };
}

/** Financial position of one job from its linked payments. */
export function jobFinancials(job, jobLinks, paymentById, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  let gross = 0; let refunded = 0;
  const ordered = [...jobLinks].sort((a, b) =>
    (t(paymentById.get(a.payment_id)?.paid_at) ?? 0) - (t(paymentById.get(b.payment_id)?.paid_at) ?? 0));
  const roles = [];
  for (const l of ordered) {
    if (l.amount_cents < 0) { refunded += -l.amount_cents; roles.push({ payment_id: l.payment_id, role: 'refund' }); continue; }
    const before = gross;
    gross += l.amount_cents;
    let role = 'partial';
    if (job.quoted_cents != null && Math.abs(gross - job.quoted_cents) <= o.amountToleranceCents) role = before === 0 ? 'full' : 'balance';
    else if (before === 0 && (job.deposit_cents == null || Math.abs(l.amount_cents - job.deposit_cents) <= o.amountToleranceCents)
             && (job.quoted_cents == null || l.amount_cents < job.quoted_cents)) role = 'deposit';
    roles.push({ payment_id: l.payment_id, role });
  }
  const net = gross - refunded;
  const outstanding = job.quoted_cents != null ? Math.max(job.quoted_cents - net, 0) : null;
  const sources = [...new Set(ordered.map((l) => paymentById.get(l.payment_id)?.provider).filter(Boolean))];

  let status;
  if (job.cancelled_at) status = net > 0 ? 'cancelled_retained_payment' : (gross > 0 ? 'cancelled_refunded' : 'cancelled');
  else if (gross > 0 && net <= 0) status = 'refunded';
  else if (net === 0) status = job.paid_confirmed_by ? 'paid_confirmed_no_record' : 'unpaid';
  else if (job.quoted_cents == null) status = job.paid_confirmed_by ? 'paid' : 'payment_received_total_unknown';
  else if (net > job.quoted_cents + o.amountToleranceCents) status = 'overpaid';
  else if (outstanding <= o.amountToleranceCents) status = 'paid';
  else status = job.paid_confirmed_by ? 'paid' : (roles.length === 1 && roles[0].role === 'deposit' ? 'deposit_paid' : 'partially_paid');

  const paid = status === 'paid' || status === 'overpaid' || status === 'paid_confirmed_no_record';
  return {
    job_id: job.id,
    gross_cents: gross,
    refunded_cents: refunded,
    net_cents: net,
    outstanding_cents: paid ? 0 : outstanding,
    status,
    // The engine's success metric: completed AND paid.
    completed_paid: paid && !!job.completed_at && !job.cancelled_at,
    verified_by: [...sources, ...(job.paid_confirmed_by ? ['manual_confirmation'] : [])],
    payments: roles,
  };
}

/**
 * Channel profitability from reconciled jobs.
 *
 * @param {object[]} jobs        {id, channel, direct_cost_cents?}
 * @param {object[]} financials  output of reconcile().jobs
 * @param {object[]} spend       {channel, amount_cents} acquisition spend for the same period
 * @param {object}   [opts]      {defaultDirectCostCents}
 */
export function channelProfit(jobs, financials, spend, opts = {}) {
  const fin = new Map(financials.map((f) => [f.job_id, f]));
  const rows = new Map();
  const row = (ch) => {
    if (!rows.has(ch)) rows.set(ch, { channel: ch, jobs: 0, completed_paid_jobs: 0, verified_revenue_cents: 0, outstanding_cents: 0, direct_cost_cents: 0, spend_cents: 0, direct_cost_estimated: false });
    return rows.get(ch);
  };
  for (const j of jobs) {
    const f = fin.get(j.id); if (!f) continue;
    const r = row(j.channel ?? 'unknown');
    r.jobs++;
    r.outstanding_cents += f.outstanding_cents ?? 0;
    if (!f.completed_paid) continue;
    r.completed_paid_jobs++;
    r.verified_revenue_cents += f.net_cents;
    if (j.direct_cost_cents != null) r.direct_cost_cents += j.direct_cost_cents;
    else if (opts.defaultDirectCostCents != null) { r.direct_cost_cents += opts.defaultDirectCostCents; r.direct_cost_estimated = true; }
  }
  for (const s of spend ?? []) row(s.channel).spend_cents += s.amount_cents;

  return [...rows.values()].map((r) => {
    const n = r.completed_paid_jobs;
    const contribution = r.verified_revenue_cents - r.direct_cost_cents - r.spend_cents;
    return {
      ...r,
      avg_job_revenue_cents: n ? Math.round(r.verified_revenue_cents / n) : null,
      cac_cents: n ? Math.round(r.spend_cents / n) : null,           // cost per completed paid job
      contribution_cents: contribution,
      contribution_per_job_cents: n ? Math.round(contribution / n) : null,
      spend_share_of_revenue: r.verified_revenue_cents ? r.spend_cents / r.verified_revenue_cents : null,
    };
  }).sort((a, b) => b.contribution_cents - a.contribution_cents);
}

// The eight payment statuses the owner tracks. `job.payment_reported_by` records
// a team member saying "this was paid" (e.g. cash) before any account snapshot
// or Square record backs it up; that is reported, not verified.
export const OWNER_STATUSES = [
  'Deposit received', 'Balance outstanding', 'Partially paid',
  'Fully paid and verified through Square', 'Fully paid and verified through another source',
  'Payment reported but not independently verified', 'Reconciliation required', 'Refunded or canceled',
];

/**
 * Map a job's financial position to one owner status.
 * @param {object} job        the job (reads cancelled_at, payment_reported_by, paid_confirmed_by, completed_at)
 * @param {object} fin        that job's entry from reconcile().jobs
 * @param {boolean} hasOpenQuestion  true when an unmatched or held payment lists this job as a candidate
 */
export function ownerStatus(job, fin, hasOpenQuestion = false) {
  const s = fin.status;
  if (s.startsWith('cancelled') || s === 'refunded') return 'Refunded or canceled';
  if (hasOpenQuestion || s === 'overpaid' || s === 'payment_received_total_unknown') return 'Reconciliation required';
  if (s === 'paid' || s === 'paid_confirmed_no_record') {
    const sources = fin.verified_by.filter((v) => v !== 'manual_confirmation');
    if (sources.length && sources.every((v) => v === 'square')) return 'Fully paid and verified through Square';
    // A weekly account snapshot (Zelle, Cash App, bank) or an owner confirmation backed by one.
    if (sources.length || job.paid_confirmed_by) return 'Fully paid and verified through another source';
  }
  if (job.payment_reported_by && s !== 'paid') return 'Payment reported but not independently verified';
  if (s === 'deposit_paid') return job.completed_at ? 'Balance outstanding' : 'Deposit received';
  if (s === 'partially_paid') return 'Partially paid';
  if (s === 'unpaid') return 'Balance outstanding';
  return 'Reconciliation required';
}

/**
 * Turn rows read from a weekly account snapshot into payment records for reconcile().
 * Only the fields needed for reconciliation are kept: no account numbers, no memo
 * text beyond a short reference, and anything the owner did not mark as business is dropped.
 * @param {object[]} rows {channel: 'zelle'|'cashapp'|'cash'|'check'|'other', date, amount, payer_name?, reference?, is_business}
 * @param {string} snapshotId  e.g. '2026-W48'
 */
export function snapshotToPayments(rows, snapshotId) {
  return rows.filter((r) => r.is_business === true && Number(r.amount) > 0).map((r, i) => ({
    id: `${snapshotId}:${r.channel}:${i + 1}`, provider: r.channel, provider_id: `${snapshotId}:${r.channel}:${r.date}:${Math.round(Number(r.amount) * 100)}:${i + 1}`,
    kind: 'payment', amount_cents: Math.round(Number(r.amount) * 100), paid_at: new Date(r.date).toISOString(),
    payer_name: r.payer_name ? String(r.payer_name).slice(0, 60) : null, reference: r.reference ? String(r.reference).slice(0, 40) : null,
    entered_by: 'weekly_snapshot',
  }));
}

/** Maximum acquisition cost a job can carry. */
export function targetCac({ avgJobRevenueCents, avgDirectCostCents, shareOfMarginForAcquisition = 0.4 }) {
  const marginBeforeAcquisition = avgJobRevenueCents - avgDirectCostCents;
  return {
    margin_before_acquisition_cents: marginBeforeAcquisition,
    break_even_cac_cents: Math.max(marginBeforeAcquisition, 0),
    target_cac_cents: Math.max(Math.round(marginBeforeAcquisition * shareOfMarginForAcquisition), 0),
  };
}
