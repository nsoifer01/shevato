// The 2026/27 GW8 gameweek, as served on 2026-10-24 (GW8 in progress, GW9
// next), with one real manager (tests/fixtures/gw8-2026, derived by
// scripts/derive-gw7-fixtures.mjs): `four-arsenal` holds Raya, Konsa,
// Zubimendi and Eze, four Arsenal players, because Konsa moved to Arsenal
// after the manager picked Konsa, and has made no transfer since. Resolved
// exactly as the app resolves it for a first-time visitor, as gw7-fixture.mjs.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildGameState } from '../../js/engine/normalize.js';
import { openingBaselineApplies, resolveGameState } from '../../js/engine/world.js';
import { buildSquadState } from '../../js/engine/squad.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, '..', 'fixtures', 'gw8-2026');
const J = (f) => JSON.parse(readFileSync(join(DIR, f), 'utf8'));
const expand = ({ fields, rows }) => rows.map((r) => Object.fromEntries(fields.map((f, i) => [f, r[i]])));

const raw = J('bootstrap.json');
export const BOOTSTRAP = { ...raw, elements: expand(raw.elements) };
export const FIXTURES = expand(J('fixtures.json'));
export const ENTRIES = J('entries.json');
// When the payload was captured, the sampled run's failure replayed.
export const FETCHED_AT = '2026-10-24T21:56:08.000Z';
export const PLAN_GW = 9;

const first = buildGameState(BOOTSTRAP, FIXTURES, { fetchedAt: FETCHED_AT, ageSeconds: 0 });
const shipped = openingBaselineApplies(first)
  ? JSON.parse(readFileSync(join(HERE, '..', '..', 'data', 'opening-baseline.json'), 'utf8'))
  : null;
export const GAME_STATE = resolveGameState(first, {
  bootstrap: BOOTSTRAP, fixtures: FIXTURES, fetchedAt: FETCHED_AT, kept: null, shipped,
}).gameState;

/** The manager's squad state for GW9, as js/app.js loadTeam reads it (gw: state.planGw). */
export function squadFor(label) {
  const e = ENTRIES[label];
  if (!e) throw new Error(`no manager "${label}" in the GW8 fixture`);
  return buildSquadState({ ...e, gameState: GAME_STATE, gw: PLAN_GW });
}
