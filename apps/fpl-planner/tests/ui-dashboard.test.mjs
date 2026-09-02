// The dashboard cards, rendered with the real modules under the repo's mini
// DOM (the ui-sandbox.test.mjs pattern).
//
// WHY RENDERED-CARD TESTS: the chips card shipped claiming a verdict the
// engine never computed, and none of that was visible from state - the state
// was right and the CARD was wrong (FINDINGS, "The card must not answer a
// question the engine did not ask"). These tests read the cards the way a user
// does, off the rendered text, for the dashboard surfaces that had no coverage
// at all: the hero, the transfer detail, the why/why-not layers, the future
// plan, the alternatives, the status panel, the withheld screen and the chip
// ledger arithmetic behind them.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDom, query, queryAll, textOf, walk, click, buttonWith } from './helpers/mini-dom.mjs';

const teardownDom = installDom();
after(() => teardownDom());

const { assembleSampleBundle } = await import('../js/data/sample.js');
const { buildGameState } = await import('../js/engine/normalize.js');
const { buildSquadState } = await import('../js/engine/squad.js');
const { buildPlan } = await import('../js/engine/planner.js');
const { formatMoney, xp } = await import('../js/ui/format.js');
const {
  heroCard, transfersCard, draftCard, whyCard, whyNotCard, renderWhyNot, futureCard,
  alternativesCard, statusCard, withheldView, chipInventory, evidenceLabel, staleSourcesBanner, squadWarningsBanner,
} = await import('../js/ui/dashboard.js');
const { manualSquadState } = await import('../js/ui/preseason.js');

const APP = join(dirname(fileURLToPath(import.meta.url)), '..');
const sample = (name) => JSON.parse(readFileSync(join(APP, 'data', 'sample', `${name}.json`), 'utf8'));
const names = ['meta', 'bootstrap', 'fixtures', 'entry', 'entry-history', 'entry-transfers', 'entry-picks'];
const files = assembleSampleBundle(Object.fromEntries(names.map(n => [n, sample(n)])));
const gameState = buildGameState(files.bootstrap, files.fixtures, { fetchedAt: files.fetchedAt });
const gw = files.planEvent;
const squadState = buildSquadState({
  entry: files.entry, history: files.history, transfers: files.transfers,
  picks: files.picks, gameState, gw,
});
const bundle = await buildPlan({ gameState, squadState, options: { horizon: 3, seed: 7 } });
const plan = bundle.current;
const NOW = Date.parse('2026-08-20T12:00:00Z');

/* -------------------------------------------------------------------- hero */

test('the hero leads with the gameweek, the deadline, the action and the armband', () => {
  const event = { deadline: new Date(NOW + 26 * 3600 * 1000).toISOString() };
  const hero = heroCard({ bundle, gameState, event, now: NOW });
  const text = textOf(hero);
  assert.equal(textOf(query(hero, 'fpl-hero-headline')), plan.explanation.headline,
    'the headline is the engine sentence, never a rewrite');
  assert.match(textOf(query(hero, 'fpl-gw-label')), new RegExp(`Gameweek ${plan.gw}`));
  assert.match(textOf(query(hero, 'fpl-deadline')), /^Deadline in 1d 2h/);
  // The three facts, each fed by a plan field.
  assert.match(text, /Captain/);
  assert.match(text, new RegExp(`${xp(plan.xPointsNet)} xP`), 'projected points is the plan number');
  assert.match(text, plan.chip ? /Play / : /Hold your chips/);
  // The confidence band sits under the action, never invented: pill + sentence.
  assert.ok(query(hero, 'fpl-conf-pill'), 'the band is rendered');
});

test('a passed deadline is worded exactly once, by countdown() alone', () => {
  // The regression: the hero prefixed "Deadline in " unconditionally while
  // countdown() already worded the passed case, rendering "Deadline passed
  // Deadline passed" from the moment the deadline went by.
  const event = { deadline: new Date(NOW - 10 * 60 * 1000).toISOString() };
  const hero = heroCard({ bundle, gameState, event, now: NOW });
  const deadline = textOf(query(hero, 'fpl-deadline'));
  const count = (deadline.match(/Deadline passed/gi) || []).length;
  assert.equal(count, 1, `"${deadline}" says it ${count} times`);
  assert.doesNotMatch(deadline, /Deadline in/);
});

/* --------------------------------------------------------------- transfers */

// The real plan decides its own transfer count, so the two card shapes are
// exercised on explicit variants of it rather than on whichever one the
// optimizer happened to pick this run.
function planWith(overrides) {
  return { ...bundle, current: { ...plan, ...overrides } };
}

test('a roll renders as an affirmation with the engine reason and the money row', () => {
  const rolled = planWith({
    transferCount: 0,
    explanation: {
      ...plan.explanation,
      headline: 'Roll your transfer',
      rollReason: { reasons: [{ text: 'No move clears the 4 point bar this week.' }] },
    },
  });
  const cardNode = transfersCard({ bundle: rolled, gameState });
  const text = textOf(cardNode);
  assert.match(text, /Roll your transfer/);
  assert.match(text, /No move clears the 4 point bar this week\./, 'the reason is the engine sentence');
  assert.match(text, /Bank before/);
  assert.match(text, /Free transfers next GW/);
  assert.equal(queryAll(cardNode, 'fpl-transfer').length, 0, 'no OUT -> IN rows for a roll');
});

test('a transfer renders both sides with prices, projections and the two gains', () => {
  const outId = plan.squad[0];
  const inId = [...gameState.players.keys()].find(id => !plan.squad.includes(id));
  const moved = planWith({
    transferCount: 1,
    transfersOut: [outId],
    transfersIn: [inId],
    hits: 0,
    explanation: {
      ...plan.explanation,
      transferReasons: [{ out: outId, in: inId, gwGain: 1.2, horizonGain: 3.4, reasons: [] }],
    },
  });
  const cardNode = transfersCard({ bundle: moved, gameState });
  const text = textOf(cardNode);
  assert.match(text, /This gameweek: 1 transfer/);
  assert.match(text, new RegExp(gameState.players.get(outId).webName));
  assert.match(text, new RegExp(gameState.players.get(inId).webName));
  assert.match(text, /\+1\.2 pts/, 'the gameweek gain, signed');
  assert.match(text, /\+3\.4 pts/, 'the horizon gain, signed');
  assert.match(text, new RegExp(formatMoney(gameState.players.get(inId).nowCost).replace('£', '£')));
  assert.match(text, /Points cost\s*none/, 'no hit, and it says so rather than omitting the row');
});

test('a hit is priced in points on the money row', () => {
  const outId = plan.squad[0];
  const inId = [...gameState.players.keys()].find(id => !plan.squad.includes(id));
  const hitPlan = planWith({
    transferCount: 1, transfersOut: [outId], transfersIn: [inId],
    hits: 1, hitCostPoints: 4,
    explanation: { ...plan.explanation, transferReasons: [{ out: outId, in: inId, gwGain: 2, horizonGain: 5, reasons: [] }] },
  });
  assert.match(textOf(transfersCard({ bundle: hitPlan, gameState })), /Points cost\s*-4/);
});

// The handoff itself is covered in ui-handoff.test.mjs; what belongs here is
// that the card offers it at all, and only for a real team.
test('a transfer card offers the handoff for a real team and withholds it for the sample', () => {
  const outId = plan.squad[0];
  const inId = [...gameState.players.keys()].find(id => !plan.squad.includes(id));
  const moved = planWith({
    transferCount: 1, transfersOut: [outId], transfersIn: [inId],
    explanation: { ...plan.explanation, transferReasons: [{ out: outId, in: inId, gwGain: 1, horizonGain: 2, reasons: [] }] },
  });

  const real = transfersCard({ bundle: moved, gameState, teamId: '4231987' });
  assert.match(textOf(real), /Make these transfers on Fantasy Premier League/);

  assert.equal(
    query(transfersCard({ bundle: moved, gameState, teamId: '4231987', sample: true }), 'fpl-handoff'), null,
    'the sample team id belongs to nobody, so there is nothing to hand over'
  );
  assert.equal(
    query(transfersCard({ bundle: moved, gameState }), 'fpl-handoff'), null,
    'no team id, no handoff'
  );
});

test('a roll offers no handoff, because there is nothing to submit', () => {
  const rolled = planWith({ transferCount: 0 });
  assert.equal(query(transfersCard({ bundle: rolled, gameState, teamId: '4231987' }), 'fpl-handoff'), null);
});

/* ---------------------------------------------------------- opening squad */

test('the opening-squad card tells one money story for both pre-season encodings', async () => {
  const escapeRe = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const budget = gameState.rules.budgetTenths;

  // The manual encoding: the fifteen held as picks, the remaining budget in
  // the bank. This is what a typed squad and a restored snapshot both produce,
  // and it is the encoding that used to render as "£0.0m of the £0.0m budget".
  const ids = squadState.picks.map(p => p.playerId);
  const manual = manualSquadState({ ids, gameState, gw, entry: files.entry });
  const mb = await buildPlan({ gameState, squadState: manual, options: { horizon: 3, seed: 7 } });
  const mText = textOf(draftCard({ bundle: mb, gameState }));
  const mSpend = budget - mb.current.bankAfterTenths;

  assert.match(mText, new RegExp(`costs ${escapeRe(formatMoney(mSpend))} of the ${escapeRe(formatMoney(budget))} budget`),
    `the fifteen is priced against the real budget, got: ${mText.slice(0, 160)}`);
  assert.doesNotMatch(mText, /£0\.0m of the £0\.0m/);
  assert.match(mText, new RegExp(`Budget ${escapeRe(formatMoney(budget))}`));
  assert.match(mText, new RegExp(`Squad cost ${escapeRe(formatMoney(mSpend))}`));
  assert.match(mText, new RegExp(`Left in the bank ${escapeRe(formatMoney(mb.current.bankAfterTenths))}`));

  // The draft encoding: no picks yet, the plan carries the fifteen. Same
  // card, same derivation, same story.
  const draftState = {
    entry: files.entry, history: files.history, transfers: files.transfers,
    picks: null, gameState, gw,
  };
  const db = await buildPlan({ gameState, squadState: buildSquadState(draftState), options: { horizon: 3, seed: 7 } });
  const dText = textOf(draftCard({ bundle: db, gameState }));
  const dSpend = budget - db.current.bankAfterTenths;
  assert.match(dText, new RegExp(`costs ${escapeRe(formatMoney(dSpend))} of the ${escapeRe(formatMoney(budget))} budget`));
  assert.doesNotMatch(dText, /£0\.0m of the £0\.0m/);
});

/* --------------------------------------------------------------------- why */

test('the why panel shows the plan bullets and answers "how sure" in its own words', () => {
  const node = whyCard({ bundle, gameState, now: NOW });
  const text = textOf(node);
  assert.match(text, /Why this plan\?/);
  assert.match(text, /The plan/);
  assert.match(text, /How sure is this\?/);
  // Every factor row answers the header's question in its words: a verdict
  // mark reading "For"/"Against" is the truncated version this replaced.
  const marks = queryAll(node, 'fpl-conf-mark').map(textOf);
  assert.ok(marks.length >= 1, 'the band shows its working');
  for (const mark of marks) assert.match(mark, /^(More sure|Less sure)$/);
  // The engine bullets arrive verbatim.
  for (const bullet of (plan.explanation.bullets || []).slice(0, 2)) {
    assert.ok(text.includes(bullet.text), `bullet rendered: "${bullet.text.slice(0, 60)}..."`);
  }
});

/* ----------------------------------------------------------------- why not */

test('the why-not picker lists the whole game and starts with Answer disabled', () => {
  const node = whyNotCard({ bundle, gameState, onAsk: async () => ({}) });
  assert.match(textOf(node), /Why not a different player\?/);
  const input = [...walk(node)].find(n => n.tagName === 'INPUT');
  assert.ok(input, 'the picker is a searchable input, not a giant select');
  assert.equal(input.getAttribute('placeholder'), `Search ${gameState.players.size} players`,
    'everyone in the game is searchable, including the unavailable');
  const answer = buttonWith(node, 'Answer');
  assert.equal(answer.disabled, true, 'nothing chosen yet, nothing to answer');
});

test('a why-not answer renders as a labelled comparison with its working', () => {
  const result = {
    verdict: 'worse',
    headline: 'The best squad with him projects 1.8 points less over 3 gameweeks.',
    rows: [
      { label: 'Recommended', text: 'projects 131.9 points' },
      { label: 'With him forced in', text: 'projects 130.1 points' },
    ],
    blockers: [],
    reasons: [{ text: 'He projects 4.1 points; the player he displaces projects 5.3.' }],
    result: { text: 'Keeping the recommended squad is worth 1.8 points.' },
    alternatives: [{ label: 'Take him for Player B instead', text: 'projects 0.6 less.', hitPoints: 4 }],
  };
  const nodes = renderWhyNot(result, gameState);
  const text = nodes.map(n => textOf(n)).join(' ');
  assert.match(text, /Not chosen/, 'the verdict is worded, never a raw enum');
  assert.match(text, /projects 131\.9 points/);
  assert.match(text, /projects 130\.1 points/);
  assert.match(text, /He projects 4\.1 points/);
  assert.match(text, /worth 1\.8 points/);
  assert.match(text, /Other routes considered \(1\)/);
  assert.match(text, /Costs a 4 point hit/);
});

test('an impossible why-not says it cannot fit, which is a claim about the game', () => {
  const nodes = renderWhyNot({ verdict: 'impossible', headline: 'Three of his club are already in the squad.' }, gameState);
  const text = nodes.map(n => textOf(n)).join(' ');
  assert.match(text, /Cannot fit/);
  assert.match(text, /Three of his club/);
});

/* ------------------------------------------------------------------ future */

test('the future card charts the horizon and repeats every charted number as text', () => {
  const node = futureCard({ bundle, gameState, now: NOW });
  const cols = queryAll(node, 'fpl-col');
  assert.equal(cols.length, 1 + bundle.future.length, 'this gameweek beside every planned one');
  const text = textOf(node);
  // The README claim, on the surface that uses columnChart in production:
  // every charted value also appears as text (the caps here, and again in the
  // per-gameweek columns underneath).
  for (const p of [plan, ...bundle.future]) {
    assert.ok(text.includes(`${xp(p.xPointsGw)} xP`), `GW ${p.gw} projection readable as text`);
    assert.ok(text.includes(`GW ${p.gw}`));
  }
  for (const f of bundle.future) {
    assert.ok(text.includes(f.explanation.headline), `GW ${f.gw} carries its action, not just a number`);
  }
  assert.match(text, /projections, not instructions/);
});

test('a horizon that ends now says so instead of drawing an empty chart', () => {
  const node = futureCard({ bundle: { ...bundle, future: [] }, gameState, now: NOW });
  assert.match(textOf(node), /horizon ends with this gameweek/);
  assert.equal(queryAll(node, 'fpl-col').length, 0);
});

/* ------------------------------------------------------------ alternatives */

test('alternatives are ranked against the recommendation with their hit priced', () => {
  const withAlts = {
    ...bundle,
    current: {
      ...plan,
      alternatives: [
        { headline: 'Hold and bank the transfer', deltaHorizon: -1.5, hits: 0 },
        { headline: 'Take a second transfer now', deltaHorizon: -3.1, hits: 1, hitCostPoints: 4 },
      ],
    },
  };
  const node = alternativesCard({ bundle: withAlts });
  const text = textOf(node);
  assert.match(text, /Alternatives considered \(2\)/);
  assert.match(text, /-1\.5 pts/);
  assert.match(text, /costs a 4 point hit/);
  assert.match(text, /none of them scored higher/);
});

test('no alternatives is an explicit sentence, not a missing section', () => {
  const node = alternativesCard({ bundle: { ...bundle, current: { ...plan, alternatives: [] } } });
  assert.match(textOf(node), /No other legal plan came within reach/);
});

/* ---------------------------------------------------------- chip inventory */

// The ledger split "usable now" from "owned at all" because "2 in hand" was
// ambiguous between them. The arithmetic is pinned on a hand-built catalogue
// where every window is knowable.
const chipRules = {
  chips: [
    { name: 'wildcard', startEvent: 2, stopEvent: 19 },
    { name: 'wildcard', startEvent: 20, stopEvent: 38 },
    { name: 'freehit', startEvent: 2, stopEvent: 19 },
    { name: 'freehit', startEvent: 20, stopEvent: 38 },
    { name: 'bboost', startEvent: 1, stopEvent: 19 },
  ],
};
const chipState = (gw2, chipsUsed, chipsAvailable = []) => ({
  bundle: { current: { gw: gw2 }, squadState: { chipsUsed, chipsAvailable } },
  gameState: { rules: chipRules },
});

test('a spent chip leaves the ledger; its second-half twin stays, named by half', () => {
  const { bundle: b, gameState: g } = chipState(13, [{ name: 'wildcard', event: 5 }], ['freehit', 'bboost']);
  const inv = chipInventory(b, g);
  assert.equal(inv.ownedCount, 4, 'second wildcard, both free hits, bench boost');
  assert.deepEqual(inv.usableNow, ['Free Hit', 'Bench Boost']);
  assert.deepEqual(inv.later.map(c => `${c.label} (${c.half}) from GW${c.fromGw}`).sort(), [
    'Free Hit (second half) from GW20',
    'Wildcard (second half) from GW20',
  ], 'a chip that exists twice is two chips, told apart by half');
});

test('a window that closed unplayed is gone, not banked', () => {
  const { bundle: b, gameState: g } = chipState(25, [{ name: 'wildcard', event: 5 }]);
  const inv = chipInventory(b, g);
  // First-half free hit and bench boost expired at GW19 whether or not played.
  assert.equal(inv.ownedCount, 2, 'the two second-half chips only');
  assert.deepEqual(inv.later, [], 'both are already open at GW25');
});

test('a legacy string entry spends every window of that name', () => {
  // history.chips rows carry { name, event }; a bare string has no event, so
  // it cannot be assigned to a half and conservatively spends both.
  const { bundle: b, gameState: g } = chipState(13, ['wildcard']);
  const inv = chipInventory(b, g);
  assert.equal(inv.ownedCount, 3, 'both wildcards gone, both free hits and the boost remain');
});

/* ------------------------------------------------------------------ status */

test('evidenceLabel words all three evidence states and the unknown one', () => {
  assert.equal(evidenceLabel({ kind: 'previous-season', teamMatches: 38 }),
    "last season's, measured over 38 gameweeks");
  assert.equal(evidenceLabel({ kind: 'current-season', finishedMatches: 12 }),
    "this season's, over 12 played");
  assert.equal(evidenceLabel({ kind: 'none' }), 'not published yet, so no plan is shown');
  assert.equal(evidenceLabel(null), 'unknown');
});

test('the status panel reports the versions, the evidence read and the legality verdict', () => {
  const sources = [
    { name: 'bootstrap-static', ok: true, stale: false, fetchedAt: new Date(NOW - 60000).toISOString() },
    { name: 'fixtures', ok: true, stale: true, fetchedAt: null },
    { name: 'entry', ok: false, error: 'HTTP 503' },
  ];
  const node = statusCard({ bundle, sources, runnerMode: 'worker', modelStatus: null, now: NOW });
  const text = textOf(node);
  assert.match(text, /Model and data status/);
  assert.ok(text.includes(bundle.dataStatus.modelVersion), 'the version that actually produced the plan');
  assert.match(text, new RegExp(`Horizon\\s*${bundle.dataStatus.horizon} gameweeks`));
  // The rollover diagnostic: what the app decided the totals describe.
  assert.ok(text.includes(evidenceLabel(bundle.dataStatus.evidence)), 'the evidence read is human-readable');
  assert.match(text, /Legality check\s*Passed/);
  assert.match(text, /a background worker/);
  // Trained model: three states are possible; unchecked is worded, not blank.
  assert.match(text, /Trained model\s*not checked/);
  // Sources: an error is shown as its own words, a missing fetch as not loaded.
  assert.match(text, /HTTP 503/);
  assert.match(text, /not loaded/);
  // The sample banner agrees with the flag the plan itself carries.
  const bannerShown = !!query(node, 'fpl-sample-banner');
  assert.equal(bannerShown, !!bundle.dataStatus.sample, 'sample labelling follows dataStatus.sample');
});

/* ---------------------------------------------------------------- withheld */

test('a withheld plan explains itself, lists the sources and offers a retry', () => {
  let retried = 0;
  const node = withheldView({
    assessment: {
      reason: 'Availability data could not be refreshed.',
      failed: ['bootstrap-static'],
      stale: ['fixtures'],
    },
    onRetry: () => { retried += 1; },
  });
  const text = textOf(node);
  assert.match(text, /We are not showing a plan right now/);
  assert.match(text, /Availability data could not be refreshed\./);
  assert.match(text, /bootstrap-static: could not be loaded/);
  assert.match(text, /fixtures: only an older copy is available/);
  click(buttonWith(node, 'Try again'));
  assert.equal(retried, 1, 'the retry button is wired, not decorative');
});

test('a source the proxy serves from its last copy is named while it is still young enough to plan on', async () => {
  // Every source `x-fpl-stale: true` at 90 minutes old rendered a plan with
  // "Last synced an hour ago" and no banner; only past six hours was the plan
  // withheld. Under that age the banner is the whole of the disclosure.
  const { assessData } = await import('../js/ui/plan-model.js');
  const assessment = assessData({
    sources: [
      { name: 'Players, prices and news', path: 'bootstrap-static', ok: true, stale: true, ageSeconds: 5400 },
      { name: 'Your squad', path: 'entry/1/event/5/picks', ok: true, stale: true, ageSeconds: 5400 },
    ],
  });
  assert.equal(assessment.withholdPlan, false, 'young enough to show');
  const node = staleSourcesBanner(assessment);
  assert.ok(node, 'but not silently');
  const text = textOf(node);
  assert.match(text, /not answering/);
  assert.match(text, /Players, prices and news: only an older copy/);
  assert.match(text, /Your squad: only an older copy/);
  assert.equal(staleSourcesBanner(assessData({ sources: [{ name: 'x', ok: true, stale: false }] })), null, 'nothing stale, no banner');
});

test('squad warnings are titled by what they are, not all as a price mismatch', () => {
  const missing = squadWarningsBanner([{ code: 'history_missing', message: 'No season history.' }]);
  assert.match(textOf(missing), /season history could not be read/);
  assert.doesNotMatch(textOf(missing), /One number does not match/);
  const empty = squadWarningsBanner([{ code: 'empty_picks', message: 'Empty squad.' }]);
  assert.match(textOf(empty), /squad could not be read/);
  const price = squadWarningsBanner([{ code: 'value_mismatch', message: 'Off by 0.1.' }]);
  assert.match(textOf(price), /One number does not match/);
});
