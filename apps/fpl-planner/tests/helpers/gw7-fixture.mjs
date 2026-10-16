// The 2026/27 GW7 deadline, as served on 2026-10-16, with five real managers
// (tests/fixtures/gw7-2026, derived by scripts/derive-gw7-fixtures.mjs),
// resolved exactly as the app resolves it for a first-time visitor and planned
// with the app's default settings.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildGameState } from '../../js/engine/normalize.js';
import { openingBaselineApplies, resolveGameState } from '../../js/engine/world.js';
import { buildSquadState } from '../../js/engine/squad.js';
import { buildPlan } from '../../js/engine/planner.js';
import { DEFAULT_SETTINGS } from '../../js/ui/store.js';
import { APP_PLAN_SEED } from '../../scripts/lib/probe.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, '..', 'fixtures', 'gw7-2026');
const J = (f) => JSON.parse(readFileSync(join(DIR, f), 'utf8'));
const expand = ({ fields, rows }) => rows.map((r) => Object.fromEntries(fields.map((f, i) => [f, r[i]])));

const raw = J('bootstrap.json');
export const BOOTSTRAP = { ...raw, elements: expand(raw.elements) };
export const FIXTURES = expand(J('fixtures.json'));
export const ENTRIES = J('entries.json');
// Fifteen hours before the deadline, when the payload was captured.
export const FETCHED_AT = '2026-10-16T19:00:00.000Z';
export const PLAN_GW = 7;

const first = buildGameState(BOOTSTRAP, FIXTURES, { fetchedAt: FETCHED_AT, ageSeconds: 0 });
const shipped = openingBaselineApplies(first)
  ? JSON.parse(readFileSync(join(HERE, '..', '..', 'data', 'opening-baseline.json'), 'utf8'))
  : null;
export const GAME_STATE = resolveGameState(first, {
  bootstrap: BOOTSTRAP, fixtures: FIXTURES, fetchedAt: FETCHED_AT, kept: null, shipped,
}).gameState;

/** One manager's squad state for GW7, read as js/app.js loadTeam reads it. */
export function squadFor(label) {
  const e = ENTRIES[label];
  if (!e) throw new Error(`no manager "${label}" in the GW7 fixture`);
  return buildSquadState({ ...e, gameState: GAME_STATE, gw: PLAN_GW });
}

export const APP_OPTIONS = Object.freeze({ horizon: DEFAULT_SETTINGS.horizon, risk: DEFAULT_SETTINGS.risk, seed: APP_PLAN_SEED });

const plans = new Map();
/** The plan a visitor sees for that manager (cached: a plan costs seconds). */
export function planFor(label, options = {}) {
  const key = `${label}:${JSON.stringify(options)}`;
  if (!plans.has(key)) {
    const squadState = squadFor(label);
    plans.set(key, buildPlan({ gameState: GAME_STATE, squadState, options: { ...APP_OPTIONS, ...options } })
      .then((bundle) => ({ bundle, squadState })));
  }
  return plans.get(key);
}
