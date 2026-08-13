import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  KEYS, SYNC_NAMESPACE, DEFAULT_SETTINGS, HORIZON_CHOICES, MAX_TEAM_ID, MAX_VERSIONS_PER_GW, MAX_GWS_KEPT,
  validateTeamId, compactPlan, recordPlanVersion, latestVersion, allKeys, disconnectTeamKeys,
} from '../js/ui/store.js';
import { PLANNER_PARAMS } from '../js/engine/planner.js';

// The four keys are a published promise: privacy.html lists exactly these as
// the app's synced data, so a fifth key appearing here is a documentation bug.
test('the app owns exactly four synced keys, in the fplPlannerApp namespace', () => {
  assert.equal(SYNC_NAMESPACE, 'fplPlannerApp');
  assert.deepEqual(allKeys(), ['fplPlannerTeamId', 'fplPlannerSettings', 'fplPlannerPlanHistory', 'fplPlannerSquadSnapshot']);
  assert.deepEqual(Object.values(KEYS).sort(), allKeys().slice().sort());
});

test('disconnecting clears the team link only, so plans and settings survive', () => {
  const removed = disconnectTeamKeys();
  assert.deepEqual(removed, ['fplPlannerTeamId', 'fplPlannerSquadSnapshot']);
  assert.ok(!removed.includes(KEYS.planHistory));
  assert.ok(!removed.includes(KEYS.settings));
});

test('team ids are validated before any network call', () => {
  assert.equal(validateTeamId('').ok, false);
  assert.match(validateTeamId('').message, /Enter your FPL Team ID/);
  assert.equal(validateTeamId('   ').ok, false);
  assert.equal(validateTeamId('12ab').ok, false);
  assert.match(validateTeamId('12ab').message, /digits only/);
  assert.equal(validateTeamId('1 234').ok, false);
  assert.equal(validateTeamId('-4').ok, false);
  assert.equal(validateTeamId('0').ok, false);
  assert.match(validateTeamId('0').message, /start at 1/);
  assert.equal(validateTeamId(String(MAX_TEAM_ID + 1)).ok, false);
  assert.match(validateTeamId(String(MAX_TEAM_ID + 1)).message, /larger than any/);
});

test('a valid team id is normalized to a plain string', () => {
  assert.deepEqual(validateTeamId(' 4231987 '), { ok: true, teamId: '4231987' });
  assert.deepEqual(validateTeamId(4231987), { ok: true, teamId: '4231987' });
  assert.equal(validateTeamId('007').teamId, '7');
});

test('default settings are the three the planner reads', () => {
  assert.deepEqual(Object.keys(DEFAULT_SETTINGS).sort(), ['horizon', 'lastView', 'risk']);
  // Asserted against the ENGINE's number rather than a literal. A user who has
  // never opened Settings must get the horizon the measurement chose, and these
  // two constants have to move together or the app silently plans over a
  // different number of gameweeks than the evidence was gathered on.
  assert.equal(DEFAULT_SETTINGS.horizon, PLANNER_PARAMS.defaultHorizon);
  assert.ok(HORIZON_CHOICES.includes(DEFAULT_SETTINGS.horizon), 'the default must be offered in Settings');
  assert.equal(DEFAULT_SETTINGS.risk, 'balanced');
});

const plan = {
  gw: 13,
  chip: null,
  transfersOut: [1], transfersIn: [2],
  transferCount: 1, hits: 0, hitCostPoints: 0,
  captain: 3, viceCaptain: 4, formation: '3-4-3',
  xPointsGw: 55.4, xPointsNet: 55.4, xPointsHorizon: 218.1,
  bankAfterTenths: 0,
  squad: new Array(15).fill(0),
  startingXI: new Array(11).fill(0),
  alternatives: [{ headline: 'something' }],
  explanation: { headline: 'Make 1 transfer', bullets: new Array(20).fill({ text: 'x' }) },
  modelVersion: 'planner-1+analytic-1',
  durationMs: 321,
};

test('a stored plan keeps the recommendation and drops the reasoning tree', () => {
  const compact = compactPlan(plan);
  assert.equal(compact.headline, 'Make 1 transfer');
  assert.equal(compact.xPointsGw, 55.4);
  assert.deepEqual(compact.transfersIn, [2]);
  assert.equal(compact.explanation, undefined);
  assert.equal(compact.alternatives, undefined);
  assert.equal(compact.squad, undefined);
  assert.equal(compactPlan(null), null);
});

test('versions number from 1 upwards and carry the reason they were recalculated', () => {
  let history = recordPlanVersion({}, 13, { plan, reason: 'first-calculation', computedAt: '2026-11-30T10:00:00Z', fingerprint: 'a' });
  history = recordPlanVersion(history, 13, { plan, reason: 'squad-changed', computedAt: '2026-11-30T12:00:00Z', fingerprint: 'b' });
  assert.equal(history['13'].length, 2);
  assert.deepEqual(history['13'].map(v => v.version), [1, 2]);
  assert.equal(history['13'][1].reason, 'squad-changed');
  assert.equal(history['13'][1].fingerprint, 'b');
  assert.equal(latestVersion(history, 13).version, 2);
  assert.equal(latestVersion(history, 99), null);
});

test('version numbers keep counting after the oldest versions are dropped', () => {
  let history = {};
  for (let i = 0; i < MAX_VERSIONS_PER_GW + 3; i++) {
    history = recordPlanVersion(history, 13, { plan, reason: 'manual', fingerprint: `f${i}` });
  }
  assert.equal(history['13'].length, MAX_VERSIONS_PER_GW);
  assert.equal(latestVersion(history, 13).version, MAX_VERSIONS_PER_GW + 3);
  assert.equal(history['13'][0].version, 4);
});

test('only the most recent gameweeks are kept, so the synced document stays small', () => {
  let history = {};
  for (let gw = 1; gw <= MAX_GWS_KEPT + 4; gw++) {
    history = recordPlanVersion(history, gw, { plan: { ...plan, gw }, reason: 'first-calculation' });
  }
  const gws = Object.keys(history).map(Number).sort((a, b) => a - b);
  assert.equal(gws.length, MAX_GWS_KEPT);
  assert.equal(gws[0], 5);
  assert.equal(gws[gws.length - 1], MAX_GWS_KEPT + 4);
});

test('recording a version never mutates the history it was given', () => {
  const before = { 13: [] };
  const after = recordPlanVersion(before, 13, { plan, reason: 'manual' });
  assert.equal(before['13'].length, 0);
  assert.equal(after['13'].length, 1);
});
