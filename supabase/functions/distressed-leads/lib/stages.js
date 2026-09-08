// Event stage taxonomy, classification and progression rules. Pure functions.

export const FORECLOSURE_STAGES = ['notice_published', 'sale_scheduled', 'sale_imminent', 'sale_completed', 'sale_cancelled'];
export const EVICTION_STAGES = ['dispossessory_filed', 'service_completed', 'hearing_scheduled', 'judgment_entered',
  'writ_issued', 'writ_pending_execution', 'eviction_scheduled', 'eviction_executed', 'possession_returned', 'dismissed', 'status_unknown'];

// Higher rank = further along toward a turnover. Used for ordering and for
// the "never regress automatically" rule.
export const STAGE_RANK = {
  status_unknown: 0,
  dispossessory_filed: 1,
  service_completed: 2,
  hearing_scheduled: 3,
  judgment_entered: 4,
  writ_issued: 5,
  writ_pending_execution: 6,
  eviction_scheduled: 7,
  eviction_executed: 8,
  possession_returned: 8,
  dismissed: -1,
  notice_published: 1,
  sale_scheduled: 2,
  sale_imminent: 3,
  sale_completed: 4,
  sale_cancelled: -1,
};

export const STAGE_LABELS = {
  notice_published: 'Foreclosure notice published',
  sale_scheduled: 'Foreclosure sale scheduled',
  sale_imminent: 'Foreclosure sale imminent',
  sale_completed: 'Foreclosure sale completed',
  sale_cancelled: 'Foreclosure cancelled',
  dispossessory_filed: 'Dispossessory filed',
  service_completed: 'Service completed',
  hearing_scheduled: 'Hearing scheduled',
  judgment_entered: 'Judgment entered',
  writ_issued: 'Writ of possession issued',
  writ_pending_execution: 'Writ pending execution',
  eviction_scheduled: 'Eviction scheduled',
  eviction_executed: 'Eviction executed',
  possession_returned: 'Possession returned to landlord',
  dismissed: 'Dismissed',
  status_unknown: 'Status unknown',
};

// Stages at which turnover is likely now or soon — the Bridgeway threshold.
export const TURNOVER_STAGES = new Set(['writ_issued', 'writ_pending_execution', 'eviction_scheduled', 'eviction_executed', 'possession_returned', 'sale_imminent', 'sale_completed']);

export function isTurnoverStage(stage) { return TURNOVER_STAGES.has(stage); }

/**
 * Classify free text describing an eviction case's status (a docket entry,
 * an uploaded list row, a note) into a stage. Conservative: a mere filing
 * never becomes "evicted". Returns { stage, evidence } or null.
 */
export function classifyEvictionText(text) {
  const s = String(text || '').toLowerCase().replace(/\s+/g, ' ');
  if (!s) return null;
  const tests = [
    ['possession_returned', /(possession (returned|restored|delivered) to (the )?(landlord|plaintiff)|landlord (regained|obtained) possession|premises (were |was )?(vacated|surrendered))/],
    ['eviction_executed', /(writ (was |has been )?(executed|completed|served and executed|returned executed)|eviction (was |has been )?(executed|completed|carried out|performed)|set[- ]out (completed|performed)|tenant (was |has been )?(removed|evicted|set out))/],
    ['eviction_scheduled', /(eviction (is )?scheduled|scheduled (for )?eviction|writ (execution )?scheduled|set[- ]out scheduled|execution (date|scheduled)|marshal (has )?scheduled|sheriff (has )?scheduled)/],
    ['writ_pending_execution', /(writ (delivered|forwarded|transmitted|sent) to (the )?(marshal|sheriff)|application (for|to execute) (the )?writ|writ pending|awaiting execution|writ (received|assigned) (by|to) (the )?(marshal|sheriff))/],
    ['writ_issued', /(writ of possession (was |has been )?(issued|granted|signed|entered)|issued (a )?writ of possession|writ issued|order granting writ)/],
    ['judgment_entered', /(default judgment|judgment (for|in favor of) (the )?(plaintiff|landlord)|judgment (was |has been )?(entered|granted)|possession (awarded|granted) to (the )?(plaintiff|landlord)|order (of|for) possession)/],
    ['dismissed', /(dismissed|dismissal|voluntary dismissal|case closed - dismissed|settled and dismissed)/],
    ['hearing_scheduled', /(hearing (is )?(set|scheduled)|court date|calendar call|trial (is )?(set|scheduled)|set for hearing|placed on (the )?calendar|answer filed)/],
    ['service_completed', /(served|service (completed|perfected|returned)|tack and mail|posted and mailed)/],
    ['dispossessory_filed', /(dispossessory (affidavit|warrant|proceeding|action)|filed|complaint|summons issued|new case)/],
  ];
  for (const [stage, re] of tests) {
    const m = s.match(re);
    if (m) return { stage, evidence: m[0] };
  }
  return null;
}

/** Classify a foreclosure notice into a stage given its sale date and today's date. */
export function classifyForeclosureStage(saleDateIso, todayIso) {
  if (!saleDateIso) return 'notice_published';
  const sale = new Date(saleDateIso + 'T00:00:00Z');
  const today = new Date(todayIso + 'T00:00:00Z');
  const days = Math.round((sale - today) / 86400000);
  if (days < 0) return 'sale_completed';
  if (days <= 10) return 'sale_imminent';
  return 'sale_scheduled';
}

/**
 * Decide whether an incoming stage observation should update an event.
 * Automated sources never move a case backwards; a lower-ranked observation
 * only refreshes "last seen". Manual changes (source 'manual') always apply.
 */
export function shouldAdvance(currentStage, incomingStage, source = 'auto') {
  if (!incomingStage) return false;
  if (source === 'manual') return incomingStage !== currentStage;
  if (!currentStage) return true;
  const cur = STAGE_RANK[currentStage] ?? 0;
  const inc = STAGE_RANK[incomingStage] ?? 0;
  if (incomingStage === 'dismissed' || incomingStage === 'sale_cancelled') return currentStage !== incomingStage;
  return inc > cur;
}

export function stageEventDate(ev) {
  if (!ev) return null;
  switch (ev.stage) {
    case 'sale_scheduled': case 'sale_imminent': case 'sale_completed': case 'sale_cancelled': return ev.sale_date || ev.publication_date || null;
    case 'notice_published': return ev.sale_date || ev.publication_date || null;
    case 'eviction_scheduled': case 'eviction_executed': case 'possession_returned': return ev.execution_date || ev.writ_date || null;
    case 'writ_issued': case 'writ_pending_execution': return ev.writ_date || ev.judgment_date || null;
    case 'judgment_entered': return ev.judgment_date || ev.hearing_date || null;
    case 'hearing_scheduled': return ev.hearing_date || ev.filed_date || null;
    default: return ev.filed_date || ev.publication_date || null;
  }
}
