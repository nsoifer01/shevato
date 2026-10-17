// The follow-up to the 2026-10-16 pre-GW7 audit, on the surfaces a manager
// reads: the hero's confidence line against the alternatives card, the data
// status after a team change, a chip in the last week of its window, and the
// count templates. Real plans from the five GW7 managers (tests/fixtures/
// gw7-2026) wherever the defect showed on one; a real plan with one field
// changed only where no real manager reaches the branch (no real GW7 plan has
// a runner-up that loses on the risk setting alone).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { installDom, textOf } from './helpers/mini-dom.mjs';
import { ENTRIES, GAME_STATE, PLAN_GW, APP_OPTIONS, FETCHED_AT, squadFor, planFor } from './helpers/gw7-fixture.mjs';

installDom();

const { buildPlan } = await import('../js/engine/planner.js');
const { buildSquadState } = await import('../js/engine/squad.js');
const { assessConfidence, shownDelta } = await import('../js/engine/confidence.js');
const { heroCard, chipCard, alternativesCard, squadWarningsBanner } = await import('../js/ui/dashboard.js');
const { planSources, assessData } = await import('../js/ui/plan-model.js');
const { createFplApi } = await import('../js/data/api.js');

const NOW = Date.parse(FETCHED_AT);
const ALL_CHIPS = ['wildcard', 'freehit', 'bboost', '3xc'];

// The manager with exactly `keep` first-half chips unused, the others spent in
// GW2 onwards: the same chip variants the audit swept.
async function variant(label, { keep = null, ...options } = {}) {
  const e = JSON.parse(JSON.stringify(ENTRIES[label]));
  if (keep) e.history.chips = ALL_CHIPS.filter(c => !keep.includes(c)).map((name, i) => ({ name, event: i + 2 }));
  const squadState = buildSquadState({ ...e, gameState: GAME_STATE, gw: PLAN_GW });
  const bundle = await buildPlan({ gameState: GAME_STATE, squadState, options: { ...APP_OPTIONS, ...options } });
  return { bundle, squadState };
}

const band = (bundle, plan = bundle.current, sources = null) => assessConfidence({
  plan, projections: bundle.projections, gameState: GAME_STATE, dataStatus: bundle.dataStatus, sources, now: NOW,
});
const marginOf = (b) => b.factors.find(f => f.key === 'margin');
const round1 = (x) => Math.round(x * 10) / 10;
// Every gap figure the alternatives card prints, as numbers.
const cardFigures = (node) => [...textOf(node).matchAll(/([+-]?\d+\.\d) pts over/g)].map(m => Number(m[1]));

/* ------------------------------------------------- 1. hero against the card */

test('bench-boost manager: the hero no longer claims a runner-up the card prints as behind', async () => {
  const { bundle } = await planFor('bench-boost');
  const plan = bundle.current;
  const figures = cardFigures(alternativesCard({ bundle, open: true }));
  assert.ok(figures.length && figures.every(v => v < 0), `the card prints every alternative behind (${figures})`);
  const m = marginOf(band(bundle));
  assert.notEqual(m.code, 'confidence_runner_up_projects_more', `hero said: ${m.text}`);
  assert.doesNotMatch(m.text || '', /transfer it spends/);
  // The margin it does state is the card's own nearest figure.
  assert.equal(round1(m.value), round1(-Math.max(...figures)));
  assert.equal(round1(Math.max(...plan.alternatives.map(shownDelta))), Math.max(...figures));
  const hero = textOf(heroCard({ bundle, gameState: GAME_STATE, event: null, now: NOW }));
  assert.doesNotMatch(hero, /projects 0\.5 more points/);
});

for (const [label, opts] of [
  ['owner', { keep: ALL_CHIPS }],
  ['triple-captain-tie', { keep: ALL_CHIPS }],
  ['triple-captain-tie', { keep: ['bboost'], horizon: 8 }],
]) {
  test(`${label} ${JSON.stringify(opts)}: the hero's margin is the figure the card prints`, async () => {
    const { bundle } = await variant(label, opts);
    const card = alternativesCard({ bundle, open: true });
    const top = Math.max(...cardFigures(card));
    const m = marginOf(band(bundle));
    if (m.code === 'confidence_runner_up_projects_more') {
      assert.equal(round1(m.value), top, m.text);
      assert.doesNotMatch(textOf(card), /none of them scored higher/);
    } else {
      assert.ok(top < 0.05, `card prints +${top} while the hero says ${m.code}`);
      assert.equal(round1(m.value), round1(Math.max(0, -top)), m.text);
    }
    assert.doesNotMatch(m.text || '', /transfer it spends/);
  });
}

// No real GW7 plan has a runner-up that loses on the variance term alone, so
// the owner's real plan is given one: same chip, no hit, no transfer spent,
// projecting 0.8 more. Everything else on the plan is real.
async function riskCase(risk, sign, flags = { belowRiskPreference: true }) {
  const { bundle } = await planFor('owner');
  const real = bundle.current.alternatives[0];
  const alt = {
    ...real, chip: bundle.current.chip, hits: 0, deltaHorizon: 0.8, deltaWithChipValue: null,
    belowHitMargin: false, belowRollValue: false, belowRiskPreference: false, transfersSpentVsPlan: 0,
    riskPreferenceSign: sign, ...flags,
  };
  const b = { ...bundle, dataStatus: { ...bundle.dataStatus, risk }, current: { ...bundle.current, alternatives: [alt] } };
  return { m: marginOf(band(b)), card: textOf(alternativesCard({ bundle: b, open: true })) };
}

test('a runner-up that loses on the risk setting says so on the hero, its row and the note', async () => {
  const aggressive = await riskCase('aggressive', 1);
  assert.match(aggressive.m.text, /projects 0\.8 more points over the horizon and is not chosen because it is the steadier plan and your aggressive risk setting favours the riskier one/);
  assert.match(aggressive.card, /\+0\.8 pts over \d+ gameweeks, but it is steadier and your aggressive risk setting favours the riskier plan/);
  assert.match(aggressive.card, /Your risk setting weighs how much each plan's score could swing/);
  assert.doesNotMatch(aggressive.card, /none of them scored higher/);

  const conservative = await riskCase('conservative', -1);
  assert.match(conservative.m.text, /because it is the riskier plan and your conservative risk setting favours the steadier one/);
  assert.match(conservative.card, /but it is riskier and your conservative risk setting favours the steadier plan/);

  const generic = await riskCase('balanced', 1);
  assert.match(generic.m.text, /because it ranks lower once your risk setting is applied/);
  assert.match(generic.card, /but ranks lower once your risk setting is applied/);
});

test('a runner-up shown ahead with no known cause is not given one', async () => {
  const { m, card } = await riskCase('balanced', 0, { belowRiskPreference: false });
  assert.equal(m.text, 'the next best plan projects 0.8 more points over the horizon');
  assert.doesNotMatch(card, /none of them scored higher/);
});

/* --------------------------------------- 5. "worth later" only with a keep */

test('a Wildcard or Free Hit gap is not described as counting what the chip is worth later', async () => {
  const { bundle } = await variant('owner', { keep: ALL_CHIPS });
  assert.equal(bundle.current.chip, 'wildcard');
  const real = bundle.current.alternatives[0];
  // Real: the alternatives play a Bench Boost, which carries a keep value.
  assert.equal(real.chip, 'bboost');
  assert.match(textOf(alternativesCard({ bundle, open: true })), /counting what the chip is worth later/);
  // The same plan against an alternative that plays no chip: neither side
  // holds a Bench Boost or Triple Captain decision, so there is no keep value.
  const plain = { ...real, chip: null, deltaWithChipValue: -2.5 };
  const text = textOf(alternativesCard({ bundle: { ...bundle, current: { ...bundle.current, alternatives: [plain] } }, open: true }));
  assert.doesNotMatch(text, /worth later/);
  assert.match(text, /-2\.5 pts over 5 gameweeks, as the planner ranks the two plans/);
});

/* ---------------------------------------------- 2. data status, team change */

function fakeApi(fetchImpl) {
  const map = new Map();
  const storage = {
    get length() { return map.size; }, key: i => [...map.keys()][i] ?? null,
    getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), removeItem: k => map.delete(k),
  };
  return createFplApi({ fetchImpl, storage, now: () => NOW });
}
const HEADERS = { 'Content-Type': 'application/json', 'x-fpl-cache': 'miss', 'x-fpl-fetched-at': FETCHED_AT, 'x-fpl-stale': 'false', 'x-fpl-age-seconds': '0' };

test('a mistyped Team ID then the right one: the new team\'s status carries no 404 and no duplicate rows', async () => {
  let bootstrapReads = 0;
  const api = fakeApi(async (url) => {
    if (/bootstrap-static/.test(url)) bootstrapReads++;
    return /entry%2F111/.test(url)
      ? new Response('{"detail":"Not found."}', { status: 404, headers: HEADERS })
      : new Response('{}', { status: 200, headers: HEADERS });
  });
  await api.getBootstrap();
  await api.getFixtures();
  await assert.rejects(api.getEntry(111));
  for (const team of [333, 222]) {
    if (team === 222) api.forgetEntryStatus();   // what the landing form's submit does
    await api.getEntry(team); await api.getEntryHistory(team); await api.getEntryPicks(team, 6);
  }
  const sources = api.getDataStatus().sources;
  assert.deepEqual(sources.map(s => s.path), ['bootstrap-static', 'fixtures', 'entry/222', 'entry/222/history', 'entry/222/event/6/picks']);
  assert.equal(assessData({ sources }, { now: NOW }).ok, true);
  // The shared reads were not thrown away with the team's rows.
  await api.getBootstrap();
  assert.equal(bootstrapReads, 1);
});

test('the landing form\'s submit, the one place every team change lands, forgets the old team\'s status', () => {
  // app.js boots against the page and cannot be imported here; the behaviour is
  // pinned above on api.js, and this pins that the submit handler calls it.
  const src = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
  const submit = src.slice(src.indexOf("form.addEventListener('submit'"), src.indexOf('async function boot()'));
  assert.match(submit, /fplApi\.forgetEntryStatus\(\);\s*\n\s*state\.teamId = check\.teamId;/);
  for (const card of ['heroCard', 'whyCard', 'futureCard']) {
    const call = src.slice(src.indexOf(`${card}({`), src.indexOf(`${card}({`) + 400);
    assert.match(call, /sources: planSourcesNow\(\)/, `${card} gets the plan's own sources`);
  }
});

test('a failed live-scores read or History-tab picks read does not lower the plan\'s confidence; a failed plan input still does', async () => {
  const { bundle } = await planFor('owner');
  const ok = (name, path) => ({ name, path, ok: true, stale: false, fetchedAt: FETCHED_AT, ageSeconds: 0 });
  const bad = (name, path) => ({ name, path, ok: false, stale: false, fetchedAt: null, ageSeconds: null, error: `timed out fetching ${path}` });
  const base = [ok('Players, prices and news', 'bootstrap-static'), ok('Fixtures', 'fixtures'), ok('Your team', 'entry/3855835')];
  const all = [...base, ok('Your squad, gameweek 6', 'entry/3855835/event/6/picks'),
    bad('Live scores', 'event/6/live'), bad('Your squad, gameweek 3', 'entry/3855835/event/3/picks')];
  const hero = (sources) => textOf(heroCard({ bundle, gameState: GAME_STATE, event: null, now: NOW, sources }));
  assert.match(hero(all), /could not be loaded/, 'unfiltered, the hero counted both');
  const own = planSources(all, { picksGws: [6, null] });
  assert.deepEqual(own.map(s => s.path), [...base.map(s => s.path), 'entry/3855835/event/6/picks']);
  assert.doesNotMatch(hero(own), /could not be loaded/);
  // The picks the plan was built from failing still counts.
  const planInputFailed = planSources([...base, bad('Your squad, gameweek 6', 'entry/3855835/event/6/picks')], { picksGws: [6] });
  assert.match(hero(planInputFailed), /1 of the data sources this plan needs could not be loaded \(Your squad, gameweek 6\)/);
});

/* ---------------------------------------------- 3. a chip in its last week */

// The owner's real squad and chips, planned as if at a later deadline: the
// first-half Free Hit and Triple Captain both close after gameweek 19.
async function ownerAt(gw, squadPatch = {}) {
  const base = squadFor('owner');
  const squadState = { ...base, gw, ...squadPatch };
  const bundle = await buildPlan({ gameState: GAME_STATE, squadState, options: { ...APP_OPTIONS } });
  return bundle;
}

test('owner in GW19: the first-half Free Hit says it expires, never "Hold"', async () => {
  const bundle = await ownerAt(19);
  assert.equal(bundle.current.chip, '3xc', 'the Triple Captain is forced in its last week');
  const card = textOf(chipCard({ bundle, gameState: GAME_STATE }));
  assert.match(card, /Free HitNot played, expires after GW19/);
  assert.match(card, /Your Free Hit also expires after gameweek 19, and only one chip can be played a week, so it goes unplayed\./);
  assert.match(card, /Triple CaptainPlaying it this gameweek/);
  const hero = textOf(heroCard({ bundle, gameState: GAME_STATE, event: null, now: NOW }));
  assert.match(hero, /Free Hit expires after GW19\./);
});

test('owner in GW19 holding only the Free Hit: no "Keep your chips" or "Hold your chips"', async () => {
  const base = squadFor('owner');
  const bundle = await ownerAt(19, { chipsAvailable: ['freehit'], chipsUsed: [...base.chipsUsed, { name: '3xc', event: 8 }] });
  assert.equal(bundle.current.chip, null);
  const card = textOf(chipCard({ bundle, gameState: GAME_STATE }));
  assert.doesNotMatch(card, /Keep your chips for now/);
  assert.match(card, /No chip this gameweek/);
  assert.match(card, /Your Free Hit cannot be kept: its window closes after gameweek 19, so not playing it this week means losing it\./);
  assert.match(card, /Free HitNot played, expires after GW19/);
  const hero = textOf(heroCard({ bundle, gameState: GAME_STATE, event: null, now: NOW }));
  assert.doesNotMatch(hero, /Hold your chips/);
  assert.match(hero, /No chip this week/);
});

test('every chip, in its window\'s last week and the week before', async () => {
  for (const chip of ALL_CHIPS) {
    // Only `chip` left of the first half: the other three spent early.
    const patch = { chipsAvailable: [chip], chipsUsed: ALL_CHIPS.filter(c => c !== chip).map((name, i) => ({ name, event: i + 2 })) };
    for (const gw of [18, 19]) {
      const bundle = await ownerAt(gw, patch);
      const card = textOf(chipCard({ bundle, gameState: GAME_STATE }));
      const played = bundle.current.chip === chip;
      if (gw === 19) {
        assert.ok(played || /expires after GW19/.test(card), `${chip} GW19: ${card}`);
        assert.doesNotMatch(card, /Keep your chips for now/, `${chip} GW19`);
        // The Bench Boost and Triple Captain are forced in their last week.
        if (chip === 'bboost' || chip === '3xc') assert.ok(played, `${chip} is played rather than lost`);
      } else {
        assert.doesNotMatch(card, /expires after/, `${chip} GW18 still has a week left`);
      }
    }
  }
});

/* ------------------------------------------------------ 4. count templates */

test('a bench with two players unlikely to play says "players"', async () => {
  const { bundle } = await variant('deep-search', { keep: ['bboost'] });
  const card = textOf(chipCard({ bundle, gameState: GAME_STATE }));
  assert.match(card, /Your bench has 2 players unlikely to play/);
});

test('a one-gameweek horizon (gameweek 38) never reads "1 gameweeks"', async () => {
  const bundle = await ownerAt(38);
  assert.equal(bundle.current.horizon, 1);
  const text = [
    heroCard({ bundle, gameState: GAME_STATE, event: null, now: NOW }),
    alternativesCard({ bundle, open: true }),
  ].map(textOf).join(' ');
  assert.doesNotMatch(text, /\b1 gameweeks\b/);
  assert.match(text, /over 1 gameweek\b/);
});

/* --------------------------------------------- squad warning: transfers lag */

test('a transfer list behind the squad gets its own title, not the squad-value mismatch banner', () => {
  const text = textOf(squadWarningsBanner([{ code: 'transfers_behind', message: 'x' }]));
  assert.match(text, /Your transfer list is behind your squad/);
  assert.doesNotMatch(text, /One number does not match/);
});
