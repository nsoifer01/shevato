// The 2026/27 GW10 deadline payload, as served on 2026-11-05 (GW9 finished,
// GW10 next; tests/fixtures/gw10-2026, derived by
// scripts/derive-gw7-fixtures.mjs). Ledger row 44.
//
// WHAT WENT WRONG. `projection_inverted` used to fire whenever the best
// defender out-projected both the best midfielder and the best forward. On this
// payload one defender does: Gabriel, Arsenal at home to Hull, at 5.98 against
// Mbeumo's 5.45 and Haaland's 4.97. Every aggregate was healthy, the readiness
// ladder fell to `display`, and the app withheld the lineup, transfers and
// chips from every manager for the gameweek. The check exists for the
// 2026-08-22 shape (attacking rates cleared, the best forward at 1.9 under a
// row of defenders at 4.8 to 5.5), and now counts defenders above the best
// attacker instead (readiness.js MIN_DEFENDERS_ABOVE_ATTACK).
//
// THE ORACLES are FPL's own: its ep_next for this gameweek also puts a
// defender (Konsa, 9.2) above its best midfielder, and the attackers' season
// numerators are in the payload, so this is a fixture week and not a cleared
// pool. The count of defenders above the best attacker is taken straight off
// the projection map here, not from projectionVitals.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildGameState } from '../js/engine/normalize.js';
import { openingBaselineApplies, resolveGameState } from '../js/engine/world.js';
import { buildSquadState } from '../js/engine/squad.js';
import { buildPlan } from '../js/engine/planner.js';
import { gameweekLifecycle } from '../js/engine/lifecycle.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, 'fixtures', 'gw10-2026');
const J = (f) => JSON.parse(readFileSync(join(DIR, f), 'utf8'));
const expand = ({ fields, rows }) => rows.map((r) => Object.fromEntries(fields.map((f, i) => [f, r[i]])));

const raw = J('bootstrap.json');
const BOOTSTRAP = { ...raw, elements: expand(raw.elements) };
const FIXTURES = expand(J('fixtures.json'));
const FETCHED_AT = '2026-11-05T13:10:22.000Z';
const DEF = 2;
const MID = 3;
const FWD = 4;

const first = buildGameState(BOOTSTRAP, FIXTURES, { fetchedAt: FETCHED_AT, ageSeconds: 0 });
const shipped = openingBaselineApplies(first)
  ? JSON.parse(readFileSync(join(HERE, '..', 'data', 'opening-baseline.json'), 'utf8'))
  : null;
const GAME_STATE = resolveGameState(first, {
  bootstrap: BOOTSTRAP, fixtures: FIXTURES, fetchedAt: FETCHED_AT, kept: null, shipped,
}).gameState;

test('the payload is a real fixture week: FPL itself ranks a defender above every midfielder, and the attacking numerators are there', () => {
  const best = (pos) => Math.max(...BOOTSTRAP.elements.filter((e) => e.element_type === pos).map((e) => Number(e.ep_next)));
  assert.ok(best(DEF) > best(MID), `FPL's ep_next: best defender ${best(DEF)}, best midfielder ${best(MID)}`);
  const attackXg = BOOTSTRAP.elements
    .filter((e) => e.element_type === MID || e.element_type === FWD)
    .reduce((s, e) => s + Number(e.expected_goals || 0), 0);
  // Nine finished gameweeks of a league: hundreds of expected goals among the
  // attackers, against zero on the cleared 2026-08-22 payload.
  assert.ok(attackXg > 150, `midfielders and forwards carry ${attackXg.toFixed(1)} expected goals`);
  assert.equal(gameweekLifecycle(GAME_STATE).planGw, 10);
});

test('GW10 2026/27: one defender above the best attacker does not withhold the plan', async () => {
  const gw = 10;
  const squadState = buildSquadState({ entry: null, history: null, transfers: null, picks: null, gameState: GAME_STATE, gw });
  const bundle = await buildPlan({ gameState: GAME_STATE, squadState, options: { horizon: 1, seed: 7 } });

  // Straight off the projection map: how many defenders beat the best attacker.
  let bestAttack = -Infinity;
  const defenders = [];
  for (const [id, rows] of bundle.projections.byPlayer) {
    const p = GAME_STATE.players.get(id);
    const row = rows.find((r) => r.gw === gw);
    if (!p || !row) continue;
    if (p.position === MID || p.position === FWD) bestAttack = Math.max(bestAttack, row.xPoints);
    if (p.position === DEF) defenders.push(row.xPoints);
  }
  const above = defenders.filter((x) => x > bestAttack).length;
  assert.equal(above, 1, `exactly one defender out-projects the best attacker on this payload (best attacker ${bestAttack.toFixed(2)})`);

  const r = bundle.dataStatus.readiness;
  const codes = r.blocked.map((b) => b.code);
  assert.ok(!codes.includes('projection_inverted'), `blocked: ${r.blocked.map((b) => b.message).join(' | ')}`);
  assert.equal(r.allow.lineup, true, 'the lineup is recommended');
  assert.equal(r.allow.transfers, true, `transfers are recommended (level ${r.level}, blocked ${codes.join(',') || 'none'})`);
  assert.equal(r.allow.chips, true, `chips are evaluated (level ${r.level}, blocked ${codes.join(',') || 'none'})`);
});
