// Plan history per team and season (2026-10-25, FINDINGS "Plan history was one
// team's, whoever was planned last").
//
// Opening a second FPL team in the same browser compared it with the first
// team's plan ("Plan updated: previously Calvert-Lewin out" on a team that never
// owned that player), listed the first team's plans in its History tab, and could call
// its squad "changed". Found verifying #628 in production. These tests run the
// sequence js/app.js runs for every plan (computePlan, then persistPlan) through
// the real store and a real localStorage stand-in, so each team switch, reload
// and season change is a sequence of the same calls; the browser suite drives
// app.js itself (e2e/plan-history.mjs).

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  KEYS, planHistoryScope, getPlanHistory, recordPlanHistory, comparableVersion, readPlanHistories,
  recordScopedPlanVersion, latestVersion, compactPlan, MAX_VERSIONS_PER_GW, MAX_GWS_KEPT, MAX_HISTORY_SCOPES, PLAN_HISTORY_SHAPE,
} from '../js/ui/store.js';
import { planInputs, actionKey } from '../js/ui/plan-diff.js';
import * as GW7 from './helpers/gw7-fixture.mjs';

const map = new Map();
globalThis.localStorage = {
  get length() { return map.size; },
  key: (i) => [...map.keys()][i] ?? null,
  getItem: (k) => (map.has(k) ? map.get(k) : null),
  setItem: (k, v) => { map.set(k, String(v)); },
  removeItem: (k) => { map.delete(k); },
};
const raw = () => JSON.parse(map.get(KEYS.planHistory) || 'null');

// One browser session: the in-memory version app.js keeps (state.lastVersion).
function session() {
  let memory = null;
  return {
    // computePlan + persistPlan for `team` in `season`, planning `gw`. `sample`
    // is demo mode: its own memory key, no stored history read or written.
    plan(team, season, gw, headline, { sample = false } = {}) {
      const scope = sample ? null : planHistoryScope(team, season);
      const memoryKey = sample ? `sample|${team}` : scope && scope.key;
      // As js/app.js versionRecord builds it: the compact plan, headline included.
      const full = { gw, explanation: { headline }, transfersOut: [], transfersIn: [], captain: 1 };
      const record = { computedAt: new Date(Date.now() + map.size).toISOString(), reason: 'manual', fingerprint: `${team}:${headline}`, plan: compactPlan(full) };
      const previous = comparableVersion({ memory, memoryKey, history: getPlanHistory(scope), gw });
      memory = memoryKey ? { key: memoryKey, record } : null;
      if (scope) recordPlanHistory(scope, gw, { plan: full, reason: record.reason, computedAt: record.computedAt, fingerprint: record.fingerprint });
      return previous ? previous.plan.headline : null;
    },
    reload() { memory = null; },
  };
}
const S = '2026/27';
const headlines = (team, season = S) => Object.fromEntries(Object.entries(getPlanHistory(planHistoryScope(team, season))).map(([gw, list]) => [gw, list.map((v) => v.plan.headline)]));

beforeEach(() => map.clear());

test('1-3: team A, then team B is never compared with A; B compares with B; back to A keeps A\'s history', () => {
  const s = session();
  assert.equal(s.plan('3855835', S, 9, 'A: sell Calvert-Lewin'), null, 'a fresh install has nothing to compare with');
  assert.equal(s.plan('4601998', S, 9, 'B: make 5 transfers'), null, '1. B opens: no comparison against A');
  assert.equal(s.plan('4601998', S, 9, 'B: make 4 transfers'), 'B: make 5 transfers', '2. B recalculated: compared with B only');
  assert.equal(s.plan('3855835', S, 9, 'A: sell Calvert-Lewin, again'), 'A: sell Calvert-Lewin', '3. back to A: compared with A\'s own last plan');
  assert.deepEqual(headlines('3855835'), { 9: ['A: sell Calvert-Lewin', 'A: sell Calvert-Lewin, again'] }, 'A\'s history is A\'s alone');
  assert.deepEqual(headlines('4601998'), { 9: ['B: make 5 transfers', 'B: make 4 transfers'] });
});

test('4: a reload compares with the stored plan of the team being opened, not the last team planned', () => {
  const s = session();
  s.plan('3855835', S, 9, 'A1');
  s.plan('4601998', S, 9, 'B1');
  s.reload();
  assert.equal(s.plan('3855835', S, 9, 'A2'), 'A1');
  s.reload();
  assert.equal(s.plan('4601998', S, 9, 'B2'), 'B1');
});

test('5: the same gameweek for different teams is kept apart', () => {
  const s = session();
  s.plan('1', S, 9, 'one');
  s.plan('2', S, 9, 'two');
  assert.deepEqual(headlines('1'), { 9: ['one'] });
  assert.deepEqual(headlines('2'), { 9: ['two'] });
  assert.equal(latestVersion(getPlanHistory(planHistoryScope('1', S)), 9).plan.headline, 'one');
});

test('6: the same team in another season starts its own history and is not compared across seasons', () => {
  const s = session();
  s.plan('3855835', '2025/26', 9, 'last season');
  assert.equal(s.plan('3855835', '2026/27', 9, 'this season'), null);
  assert.deepEqual(headlines('3855835', '2025/26'), { 9: ['last season'] });
  assert.deepEqual(headlines('3855835', '2026/27'), { 9: ['this season'] });
  assert.equal(planHistoryScope('3855835', null), null, 'an unknown season gives no scope, so nothing is mixed');
  assert.equal(planHistoryScope('3855835', '  '), null);
  assert.equal(planHistoryScope('abc', S), null);
});

test('7: legacy unscoped history is never attributed to a team, and the first scoped write replaces it', () => {
  const legacy = { 9: [{ version: 1, computedAt: '2026-10-20T10:00:00Z', reason: 'first-calculation', fingerprint: 'x', plan: { gw: 9, headline: 'whose?' } }] };
  map.set(KEYS.planHistory, JSON.stringify(legacy));
  assert.deepEqual(getPlanHistory(planHistoryScope('3855835', S)), {}, 'not read as this team\'s');
  assert.deepEqual(getPlanHistory(planHistoryScope('4601998', S)), {}, 'nor as any other');
  const s = session();
  assert.equal(s.plan('3855835', S, 9, 'mine'), null, 'no comparison against the legacy plan');
  const stored = raw();
  assert.equal(stored.v, PLAN_HISTORY_SHAPE);
  assert.equal(stored['9'], undefined, 'the unattributable records are gone');
  assert.deepEqual(Object.keys(stored.scopes), [`3855835|${S}`]);
});

test('8: corrupted or partially synchronized storage is read safely and never crosses teams', () => {
  const good = { version: 1, computedAt: '2026-10-24T10:00:00Z', reason: 'manual', fingerprint: 'f', plan: { gw: 9, headline: 'A ok' } };
  const cases = [
    ['not JSON', '{nope'],
    ['a number', '42'],
    ['an array', '[1,2]'],
    ['scopes not an object', JSON.stringify({ v: 2, scopes: 'x' })],
    ['a future shape', JSON.stringify({ v: 3, scopes: { [`3855835|${S}`]: { teamId: '3855835', season: S, gws: { 9: [good] } } } })],
  ];
  for (const [label, value] of cases) {
    map.set(KEYS.planHistory, value);
    assert.deepEqual(getPlanHistory(planHistoryScope('3855835', S)), {}, label);
  }

  map.set(KEYS.planHistory, JSON.stringify({
    v: 2,
    // An old-code device wrote its legacy map on top of the scoped value.
    9: [{ ...good, plan: { gw: 9, headline: 'stray legacy' } }],
    scopes: {
      [`3855835|${S}`]: { teamId: '3855835', season: S, touchedAt: '2026-10-24T10:00:00Z', gws: {
        9: [good, { version: 'x', plan: {} }, null, { version: 2 }], // only `good` is a version
        x: [good], // not a gameweek
        10: 'not a list',
      } },
      // A bucket whose contents claim another team than its key: not trusted.
      [`4601998|${S}`]: { teamId: '3855835', season: S, gws: { 9: [good] } },
      'junk': { teamId: 'nope', season: S, gws: { 9: [good] } },
    },
  }));
  assert.deepEqual(headlines('3855835'), { 9: ['A ok'] });
  assert.deepEqual(headlines('4601998'), {}, 'a mislabelled bucket is nobody\'s');
  recordPlanHistory(planHistoryScope('3855835', S), 9, { plan: { gw: 9, explanation: { headline: 'A next' } }, reason: 'manual', computedAt: '2026-10-25T10:00:00Z' });
  const stored = raw();
  assert.deepEqual(Object.keys(stored).sort(), ['scopes', 'v'], 'the stray legacy map is dropped on write');
  assert.deepEqual(Object.keys(stored.scopes), [`3855835|${S}`]);
  assert.deepEqual(stored.scopes[`3855835|${S}`].gws['9'].map((v) => [v.version, v.plan.headline]), [[1, 'A ok'], [2, 'A next']]);
});

test('9: sample mode reads and writes no stored history and is never compared with a real team; a fresh install has none', () => {
  const s = session();
  s.plan('3855835', S, 9, 'real A');
  const before = map.get(KEYS.planHistory);
  assert.equal(s.plan('1234567', S, 13, 'sample 1', { sample: true }), null, 'demo mode is not compared with the real team');
  assert.equal(s.plan('1234567', S, 13, 'sample 2', { sample: true }), 'sample 1', 'but sample plans compare with each other in the session');
  assert.equal(map.get(KEYS.planHistory), before, 'nothing from the sample is stored');
  assert.deepEqual(getPlanHistory(null), {}, 'sample mode has no scope, so it reads nothing');
  recordPlanHistory(null, 13, { plan: { gw: 13 }, reason: 'manual' });
  assert.equal(map.get(KEYS.planHistory), before);
  map.clear();
  assert.equal(comparableVersion({ memory: null, memoryKey: `1|${S}`, history: getPlanHistory(planHistoryScope('1', S)), gw: 9 }), null);
});

test('the limits hold per scope, and only the most recently used scopes are kept', () => {
  let all = null;
  const plan = (gw) => ({ gw, explanation: { headline: `gw${gw}` } });
  for (let t = 1; t <= MAX_HISTORY_SCOPES + 2; t++) {
    const scope = planHistoryScope(String(t), S);
    for (let gw = 1; gw <= MAX_GWS_KEPT + 2; gw++) {
      for (let i = 0; i < MAX_VERSIONS_PER_GW + 2; i++) {
        all = recordScopedPlanVersion(all, scope, gw, { plan: plan(gw), reason: 'manual', computedAt: `2026-10-2${t}T${String(gw).padStart(2, '0')}:0${i}:00Z` });
      }
    }
  }
  const keys = Object.keys(all.scopes);
  assert.equal(keys.length, MAX_HISTORY_SCOPES);
  assert.deepEqual(keys.sort(), [3, 4, 5].map((t) => `${t}|${S}`), 'the least recently written teams go first');
  for (const key of keys) {
    const gws = all.scopes[key].gws;
    assert.equal(Object.keys(gws).length, MAX_GWS_KEPT);
    for (const list of Object.values(gws)) assert.equal(list.length, MAX_VERSIONS_PER_GW);
  }
  // The team being written is always kept, even with an older clock.
  all = recordScopedPlanVersion(all, planHistoryScope('1', S), 9, { plan: plan(9), reason: 'manual', computedAt: '2020-01-01T00:00:00Z' });
  assert.ok(all.scopes[`1|${S}`]);
  assert.equal(Object.keys(all.scopes).length, MAX_HISTORY_SCOPES);
  assert.deepEqual(readPlanHistories(all), all, 'what is written reads back unchanged');
});

test('the whole synced value at every cap, with real plan snapshots, stays far inside the sync limit', async () => {
  // A real plan and its real input snapshot (the GW7 owner's), as js/app.js
  // versionRecord builds it, at every cap. storage-sync-robust.js refuses to
  // flush a document above 700 KB, and this key shares it with three others.
  const { bundle } = await GW7.planFor('owner');
  const inputs = planInputs({ plan: bundle.current, projections: bundle.projections, squadState: bundle.squadState, gameState: GW7.GAME_STATE, dataStatus: bundle.dataStatus });
  let all = null;
  for (let t = 1; t <= MAX_HISTORY_SCOPES; t++) {
    for (let gw = 1; gw <= MAX_GWS_KEPT; gw++) {
      for (let i = 0; i < MAX_VERSIONS_PER_GW; i++) {
        all = recordScopedPlanVersion(all, planHistoryScope(String(t), S), gw, { plan: bundle.current, reason: 'manual', fingerprint: `${t}-${gw}-${i}`, inputs });
      }
    }
  }
  const bytes = JSON.stringify(all).length;
  assert.ok(bytes < 350000, `the plan history at every cap is ${bytes} bytes`);
  assert.equal(actionKey(latestVersion(all.scopes[`1|${S}`].gws, 1).plan), actionKey(bundle.current), 'a stored version still compares like the plan');
});

test('10: a new gameweek in the same session is compared with nothing from the last; the old gameweek stays in history', () => {
  // The in-memory version outlives a deadline (the page stays open, the
  // manager presses "Recalculate" for the next gameweek). It is the previous
  // gameweek's decision, not an earlier version of this one (reviewing #630).
  const s = session();
  assert.equal(s.plan('3855835', S, 13, 'GW13 v1'), null);
  assert.equal(s.plan('3855835', S, 13, 'GW13 v2'), 'GW13 v1', 'a recalculation inside the gameweek still compares');
  assert.equal(s.plan('3855835', S, 14, 'GW14 v1'), null, 'the next gameweek is not compared with GW13 from memory');
  assert.equal(s.plan('3855835', S, 14, 'GW14 v2'), 'GW14 v1', 'and its own recalculation compares with its own plan');
  assert.deepEqual(headlines('3855835'), { 13: ['GW13 v1', 'GW13 v2'], 14: ['GW14 v1', 'GW14 v2'] }, 'GW13 is still in history, beside GW14');
  // Going back to an earlier gameweek's plan (a hand-set horizon, a replay)
  // compares with that gameweek's stored version, never the later one in memory.
  assert.equal(s.plan('3855835', S, 13, 'GW13 v3'), 'GW13 v2');
});
