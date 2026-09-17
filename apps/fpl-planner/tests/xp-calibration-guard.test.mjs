// THE xP CALIBRATION GUARD, on the 2026/27 deadlines the audit caught.
//
// WHY THIS FILE EXISTS
//
// On 2026-09-16 the planner projected every nailed starter in the league to
// start 64% to 76% of the time, read players who had started every match as
// less likely to play than substitutes, and put its best possible eleven at 40
// points, while every suite was green. Nothing compared a league of projections
// with the gameweek that then happened.
//
// These tests do, hermetically. The fixture holds FPL's public payloads from
// that day (tests/fixtures/xp-calibration-2026, derived by
// scripts/derive-calibration-fixtures.mjs); the gameweek 3 and 4 deadlines are
// rebuilt from them, resolved exactly as app.js resolves a payload
// (engine/world.js, the shipped opening baseline), projected, and scored
// against what those gameweeks produced.
//
// Nothing here is a value the current model happens to produce. The bands live
// in scripts/lib/calibration-guard.mjs and are ratios between projection and
// outcome with a gameweek's worth of tolerance; the model that shipped breaks
// three of them over these two deadlines and ten at gameweek 4 alone, and the
// same bands hold on every replayed season (calibration-report.mjs --check).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildGameState } from '../js/engine/normalize.js';
import { openingBaselineApplies, resolveGameState } from '../js/engine/world.js';
import { buildStrength } from '../js/engine/strength.js';
import { buildProjections } from '../js/engine/projections.js';
import { matchesKickedOffByClub } from '../js/engine/lifecycle.js';
import { seasonEvidence } from '../js/engine/minutes.js';
import { projectionRowsFor } from '../js/engine/planner.js';
import {
  projectionVitals, assessReadiness, MIN_GROUP_FOR_MINUTES_CHECKS,
} from '../js/engine/readiness.js';
import { calibrationFacts, calibrationViolations } from '../scripts/lib/calibration-guard.mjs';
import { deadlinePayload, scoreDeadline, DEADLINES } from './helpers/xp-calibration-fixture.mjs';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHIPPED = JSON.parse(readFileSync(join(APP, 'data', 'opening-baseline.json'), 'utf8'));

const worlds = new Map();
/** The gameweek `gw` deadline as a first-time visitor's app would have projected it. */
function deadline(gw) {
  if (worlds.has(gw)) return worlds.get(gw);
  const { bootstrap, fixtures, fetchedAt } = deadlinePayload(gw);
  const first = buildGameState(bootstrap, fixtures, { fetchedAt });
  const shipped = openingBaselineApplies(first) ? SHIPPED : null;
  const { gameState, resolution } = resolveGameState(first, { bootstrap, fixtures, fetchedAt, kept: null, shipped });
  const strength = buildStrength(gameState, { asOfGw: gw });
  const projections = buildProjections({ gameState, strength, gwFrom: gw, gwTo: gw });
  const rows = scoreDeadline({ gameState, projections, gw, clubMatches: matchesKickedOffByClub(first) });
  const out = { gameState, resolution, projections, rows };
  worlds.set(gw, out);
  return out;
}

const described = (violations) => violations.map((v) => `${v.code}: ${v.message}`).join('\n  ');

test('the rebuilt deadlines are the ones production read: this season, with last season as the prior', () => {
  for (const gw of DEADLINES) {
    const { gameState, resolution } = deadline(gw);
    const evidence = seasonEvidence(gameState);
    assert.equal(evidence.kind, 'current-season', `GW${gw}`);
    assert.equal(evidence.prior, true, `GW${gw}: the shipped previous season rides along as the prior`);
    assert.equal(resolution.origin, 'shipped', `GW${gw}: a first-time visitor's prior is the shipped asset`);
    assert.equal(evidence.teamMatches, gw - 1, `GW${gw}: every club has played the gameweeks before it`);
  }
  // Two matches in, the season's assessment is still incomplete and the prior
  // is reported as standing in; by three it is not. Either way it is attached.
  assert.equal(deadline(3).resolution.source, 'baseline');
  assert.equal(deadline(4).resolution.source, 'current');
});

test('over the captured deadlines the projections sit inside every calibration band', () => {
  const facts = calibrationFacts(DEADLINES.map((gw) => deadline(gw).rows));
  const violations = calibrationViolations(facts);
  assert.deepEqual(violations, [], `bands broken:\n  ${described(violations)}`);
  // Each band is checked on groups big enough to mean something.
  assert.ok(facts.everPresent.n >= 200, `ever-present starters measured: ${facts.everPresent.n}`);
  assert.ok(facts.startBuckets.filter((b) => b.n >= 30).length >= 4, 'start calibration is read in at least four buckets');
});

test('at each deadline on its own, nailed starters are starters and are at least as likely to play as anyone', () => {
  for (const gw of DEADLINES) {
    const violations = calibrationViolations(calibrationFacts([deadline(gw).rows]))
      .filter((v) => v.code.startsWith('ever_present') || v.code === 'start_exceeds_appear');
    assert.deepEqual(violations, [], `GW${gw}:\n  ${described(violations)}`);
  }
});

test('the runtime readiness checks read these deadlines as healthy, and have enough players to say so', () => {
  for (const gw of DEADLINES) {
    const { gameState, projections } = deadline(gw);
    const vitals = projectionVitals(projectionRowsFor(projections, gw, gameState));
    assert.ok(vitals.everPresentCount >= MIN_GROUP_FOR_MINUTES_CHECKS, `GW${gw}: ${vitals.everPresentCount} ever-present starters`);
    assert.ok(vitals.benchCount >= MIN_GROUP_FOR_MINUTES_CHECKS, `GW${gw}: ${vitals.benchCount} bench players`);
    const readiness = assessReadiness({ evidence: seasonEvidence(gameState), lifecycle: null, vitals });
    const codes = readiness.blocked.map((b) => b.code);
    assert.ok(!codes.includes('minutes_compressed') && !codes.includes('appearance_inverted'),
      `GW${gw}: ${readiness.blocked.map((b) => b.message).join(' | ')}`);
  }
});

test('the bands are not vacuous: the same projections compressed the way the shipped model compressed them break them', () => {
  // The shipped model's shape, applied to today's projections: regulars' start
  // probability pulled a quarter of the way toward zero, and every projection
  // pulled halfway toward the league mean. Nothing else changes.
  const deadlines = DEADLINES.map((gw) => {
    const rows = deadline(gw).rows;
    const m = rows.reduce((s, r) => s + r.xPoints, 0) / rows.length;
    return rows.map((r) => {
      const pStart = r.pStart * 0.75;
      return { ...r, pStart, pAppear: Math.max(pStart, r.pAppear * 0.8), xPoints: m + 0.5 * (r.xPoints - m) };
    });
  });
  const codes = calibrationViolations(calibrationFacts(deadlines)).map((v) => v.code);
  for (const expected of ['ever_present_start', 'ever_present_appear', 'quintile_separation', 'spread', 'best_eleven']) {
    assert.ok(codes.includes(expected), `${expected} should break, got ${codes.join(', ')}`);
  }

  // And the runtime check catches the start compression on the planner's rows.
  const gw = DEADLINES[DEADLINES.length - 1];
  const { gameState, projections } = deadline(gw);
  const compressed = projectionRowsFor(projections, gw, gameState)
    .map((r) => ({ ...r, pStart: r.pStart * 0.75, pAppear: Math.max(r.pStart * 0.75, r.pAppear * 0.8) }));
  const readiness = assessReadiness({ evidence: seasonEvidence(gameState), lifecycle: null, vitals: projectionVitals(compressed) });
  assert.ok(readiness.blocked.some((b) => b.code === 'minutes_compressed'), readiness.blocked.map((b) => b.code).join(','));
  assert.equal(readiness.allow.transfers, false);
});
