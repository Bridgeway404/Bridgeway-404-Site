// Source adapters. Each adapter is { id, county, label, kind, enabledByDefault,
// notes, discover(ctx) }. discover() returns { records, cursor, diagnostics }.
// Records are normalized "raw findings" that the pipeline turns into
// properties + events (see pipeline.js#ingestRecord). Network access goes
// through ctx.http (rate-limited); parsing is done by the pure parsers so a
// site change only touches one file.
//
// A record looks like:
//   { source_id, external_id, url, kind: 'foreclosure_notice'|'eviction_case',
//     county, publication_date, ...fields, evidence: [{claim, url, excerpt}] }

import { fultonNeighborLegals } from './fulton_neighbor_legals.js';
import { fultonMagistrateCalendars } from './fulton_magistrate_calendars.js';
import { dekalbChampionLegals } from './dekalb_champion_legals.js';
import { dekalbMagistrateCalendars } from './dekalb_magistrate_calendars.js';
import { douglasSentinelLegals } from './douglas_sentinel_legals.js';
import { douglasMagistrate } from './douglas_magistrate.js';
import { henryHeraldLegals } from './henry_herald_legals.js';
import { henryMagistrateCalendars } from './henry_magistrate_calendars.js';

export const SOURCES = [
  fultonNeighborLegals,
  fultonMagistrateCalendars,
  dekalbChampionLegals,
  dekalbMagistrateCalendars,
  douglasSentinelLegals,
  douglasMagistrate,
  henryHeraldLegals,
  henryMagistrateCalendars,
];

export function getSource(id) { return SOURCES.find(s => s.id === id) || null; }
