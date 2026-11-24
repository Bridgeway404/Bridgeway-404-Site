// Spending-tier and capacity gates.
//
// These functions RECOMMEND. They never change a budget. Every move up a tier
// is surfaced to the owner for approval; a move down or a pause can be applied
// immediately by the system because it only reduces spend.

export const AD_TIERS = [
  { code: 'T1', name: 'Initial testing',    monthly_min: 300,  monthly_max: 500 },
  { code: 'T2', name: 'Early validation',   monthly_min: 750,  monthly_max: 1000 },
  { code: 'T3', name: 'Growth',             monthly_min: 1500, monthly_max: 2000 },
  { code: 'T4', name: 'Aggressive scaling', monthly_min: 2000, monthly_max: 3000 },
];

// Criteria to ADVANCE out of each tier. Evidence is measured over the trailing window.
export const ADVANCE_CRITERIA = {
  T1: { window_days: 30, min_completed_paid_jobs: 5,  max_cac_to_target: 1.25, min_contribution_per_job_cents: 1,    max_capacity_use: 0.85, min_attributed_share: 0.9 },
  T2: { window_days: 30, min_completed_paid_jobs: 12, max_cac_to_target: 1.0,  min_contribution_per_job_cents: 5000, max_capacity_use: 0.80, min_attributed_share: 0.95 },
  T3: { window_days: 30, min_completed_paid_jobs: 20, max_cac_to_target: 0.9,  min_contribution_per_job_cents: 7500, max_capacity_use: 0.75, min_attributed_share: 0.95, consecutive_windows: 2 },
};

// Any one of these triggers a step DOWN (or a pause at T1).
export const RETREAT_TRIGGERS = { cac_to_target_over: 1.5, min_leads_before_judging: 20, capacity_use_over: 1.0, contribution_per_job_below_cents: 0 };

/**
 * @param {string} current  tier code
 * @param {object} m        trailing-window metrics for PAID channels only:
 *   {completed_paid_jobs, leads, cac_cents, target_cac_cents, contribution_per_job_cents,
 *    capacity_use (booked paid-channel + other jobs / weekly capacity, 0..1+),
 *    attributed_share (completed paid jobs with a known source / all), windows_meeting_criteria?}
 */
export function tierRecommendation(current, m) {
  const idx = AD_TIERS.findIndex((x) => x.code === current);
  if (idx < 0) throw new Error(`unknown tier ${current}`);
  const cacRatio = m.target_cac_cents ? m.cac_cents / m.target_cac_cents : null;
  const reasons = [];

  // Retreat first: reducing spend never needs to wait.
  if (m.capacity_use > RETREAT_TRIGGERS.capacity_use_over) reasons.push('capacity_exceeded');
  if (m.leads >= RETREAT_TRIGGERS.min_leads_before_judging) {
    if (cacRatio != null && cacRatio > RETREAT_TRIGGERS.cac_to_target_over) reasons.push('cac_over_150pct_of_target');
    if (m.completed_paid_jobs > 0 && m.contribution_per_job_cents < RETREAT_TRIGGERS.contribution_per_job_below_cents) reasons.push('negative_contribution');
    if (m.completed_paid_jobs === 0) reasons.push('no_completed_paid_jobs_after_20_leads');
  }
  if (reasons.length) {
    return { action: idx === 0 ? 'pause_and_review' : 'step_down', from: current, to: idx === 0 ? null : AD_TIERS[idx - 1].code, reasons, needs_owner_approval: false };
  }

  const c = ADVANCE_CRITERIA[current];
  if (!c) return { action: 'hold', from: current, to: current, reasons: ['top_tier'], needs_owner_approval: false };
  const unmet = [];
  if (m.completed_paid_jobs < c.min_completed_paid_jobs) unmet.push(`completed_paid_jobs ${m.completed_paid_jobs} < ${c.min_completed_paid_jobs}`);
  if (cacRatio == null || cacRatio > c.max_cac_to_target) unmet.push(`cac_to_target ${cacRatio == null ? 'unknown' : cacRatio.toFixed(2)} > ${c.max_cac_to_target}`);
  if (m.contribution_per_job_cents < c.min_contribution_per_job_cents) unmet.push(`contribution_per_job ${m.contribution_per_job_cents} < ${c.min_contribution_per_job_cents}`);
  if (m.capacity_use > c.max_capacity_use) unmet.push(`capacity_use ${m.capacity_use} > ${c.max_capacity_use}`);
  if ((m.attributed_share ?? 0) < c.min_attributed_share) unmet.push(`attributed_share ${m.attributed_share ?? 0} < ${c.min_attributed_share}`);
  if (c.consecutive_windows && (m.windows_meeting_criteria ?? 0) < c.consecutive_windows) unmet.push(`needs ${c.consecutive_windows} consecutive qualifying windows`);
  if (unmet.length) return { action: 'hold', from: current, to: current, reasons: unmet, needs_owner_approval: false };
  return { action: 'recommend_step_up', from: current, to: AD_TIERS[idx + 1].code, reasons: ['all_advance_criteria_met'], needs_owner_approval: true };
}

/**
 * Weekly capacity gate. Prevents the engine from generating commitments the
 * crew cannot serve: it throttles demand generation before bookings exceed capacity.
 *
 * @param {object} x {extra_jobs_per_week (owner planning number, initially 5), booked_next_7_days,
 *                    open_quotes, expected_close_rate (0..1)}
 */
export function capacityGate({ extra_jobs_per_week, booked_next_7_days, open_quotes = 0, expected_close_rate = 0.3 }) {
  const expected = booked_next_7_days + open_quotes * expected_close_rate;
  const use = extra_jobs_per_week > 0 ? expected / extra_jobs_per_week : Infinity;
  let state = 'open';
  if (use >= 1) state = 'full';
  else if (use >= 0.8) state = 'tight';
  return {
    state,
    capacity_use: Math.round(use * 100) / 100,
    // What the engine may do in each state.
    paid_ads: state === 'full' ? 'pause_until_next_week' : state === 'tight' ? 'hold_budget' : 'run',
    outreach_drafting: state === 'full' ? 'queue_only' : 'run',
    booking_offer: state === 'full' ? 'offer_next_week_slots' : 'offer_this_week_slots',
    follow_ups_on_existing_leads: 'run',     // never stop answering people already in conversation
  };
}
