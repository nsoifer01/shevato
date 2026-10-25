// The notice for a squad over the club limit because a player moved club
// (2026-10-25; FINDINGS ledger row 38, the engine side in
// inherited-club-limit.test.mjs). Rendered under the repo's mini DOM and read
// off the text, the ui-dashboard.test.mjs pattern. What it must say: which
// clubs, how many, who; that FPL lets the squad stand; that the next transfer
// must restore the limit; and which of this plan's sales the rule requires.
// What it must not be: a data-quality warning, or present for an ordinary squad.
// Club counts are FPL's own `element.team`.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, queryAll, textOf, walk } from './helpers/mini-dom.mjs';

const teardownDom = installDom();
after(() => teardownDom());

const { inheritedClubNotice, clubLimitSaleNote, noticeKinds } = await import('../js/ui/plan-model.js');
const { inheritedClubLimitBanner, transfersCard, statusCard } = await import('../js/ui/dashboard.js');
const { buildPlan } = await import('../js/engine/planner.js');
const { DEFAULT_SETTINGS } = await import('../js/ui/store.js');
const { APP_PLAN_SEED } = await import('../scripts/lib/probe.mjs');
const GW8 = await import('./helpers/gw8-fixture.mjs');
const GW7 = await import('./helpers/gw7-fixture.mjs');

const OPTIONS = { horizon: DEFAULT_SETTINGS.horizon, risk: DEFAULT_SETTINGS.risk, seed: APP_PLAN_SEED };
const squad8 = GW8.squadFor('four-arsenal');
const held8 = squad8.picks.map((p) => p.playerId);
const fplTeam8 = new Map(GW8.BOOTSTRAP.elements.map((e) => [e.id, e.team]));
const ARSENAL = GW8.BOOTSTRAP.teams.find((t) => t.short_name === 'ARS');
const name8 = (id) => GW8.GAME_STATE.players.get(id).webName;
let bundle8 = null;
const plan8 = async () => (bundle8 = bundle8 || await buildPlan({ gameState: GW8.GAME_STATE, squadState: squad8, options: OPTIONS }));
const roll8 = { gw: GW8.PLAN_GW, chip: null, transferCount: 0, transfersOut: [], transfersIn: [], squad: held8 };

test('the four-Arsenal squad: one club, its count and players, from FPL\'s own clubs', () => {
  const n = inheritedClubNotice({ squadState: squad8, plan: roll8, gameState: GW8.GAME_STATE });
  assert.ok(n);
  assert.equal(n.clubs.length, 1);
  const arsenalHeld = held8.filter((id) => fplTeam8.get(id) === ARSENAL.id);
  assert.equal(n.clubs[0].count, arsenalHeld.length);
  assert.equal(n.clubs[0].count, 4);
  assert.equal(n.clubs[0].over, 1);
  assert.equal(n.clubs[0].name, ARSENAL.name);
  assert.deepEqual([...n.clubs[0].players].sort(), arsenalHeld.map(name8).sort());
  assert.equal(n.transferring, false);
});

test('rolling: the notice is information, says FPL keeps the squad and the next transfer must restore the limit', () => {
  const node = inheritedClubLimitBanner(inheritedClubNotice({ squadState: squad8, plan: roll8, gameState: GW8.GAME_STATE }));
  const text = textOf(node);
  assert.ok(node.className.includes('is-info'), `tone: ${node.className}`);
  assert.ok(!node.className.includes('is-warn') && !node.className.includes('is-bad'));
  assert.match(text, /Your squad holds 4 players from Arsenal/);
  assert.match(text, /FPL lets you keep it exactly as it is/);
  assert.match(text, /next transfer has to bring Arsenal back to 3/);
  assert.match(text, /Arsenal: 4 players \((?=.*Raya)(?=.*Konsa)(?=.*Zubimendi)(?=.*Eze)[^)]*\), 1 over the limit of 3/);
  assert.match(text, /This plan makes no transfer, so your squad stays as it is/);
  assert.doesNotMatch(text, /data quality|could not be read|does not match/i);
});

test('transferring: the banner names the required sale, and only that sale carries the note on the card', async () => {
  const bundle = await plan8();
  const notice = inheritedClubNotice({ squadState: squad8, plan: bundle.current, gameState: GW8.GAME_STATE });
  assert.equal(notice.transferring, true);
  const soldArsenal = bundle.current.transfersOut.filter((id) => fplTeam8.get(id) === ARSENAL.id);
  assert.deepEqual(notice.clubs[0].sold, soldArsenal);
  assert.ok(soldArsenal.length >= 1, 'the plan sells an Arsenal player');

  const text = textOf(inheritedClubLimitBanner(notice));
  assert.match(text, /This plan makes transfers, so the rule requires selling 1 Arsenal player; the plan sells /);
  for (const id of soldArsenal) assert.ok(text.includes(name8(id)), `names ${name8(id)}`);

  const card = transfersCard({ bundle, gameState: GW8.GAME_STATE, now: Date.parse(GW8.FETCHED_AT), clubNotice: notice });
  const notes = queryAll(card, 'fpl-tr-club-note');
  assert.equal(notes.length, soldArsenal.length, 'one note per Arsenal sale, none on the other transfers');
  for (const note of notes) {
    assert.equal(textOf(note), 'Partly required by the club limit: with any transfer, Arsenal has to come back to 3 from 4, so one Arsenal player has to go.');
  }
  for (const id of bundle.current.transfersOut) {
    assert.equal(clubLimitSaleNote(notice, id) !== null, soldArsenal.includes(id), name8(id));
  }
  // Without a notice the card is as it was.
  assert.equal(queryAll(transfersCard({ bundle, gameState: GW8.GAME_STATE, now: Date.parse(GW8.FETCHED_AT) }),
    'fpl-tr-club-note').length, 0);
});

test('a Wildcard or Free Hit plan: the rebuild is within the limit, and no sale is singled out', () => {
  for (const chip of ['wildcard', 'freehit']) {
    const plan = { gw: GW8.PLAN_GW, chip, transferCount: held8.length, transfersOut: held8, transfersIn: [], squad: [] };
    const notice = inheritedClubNotice({ squadState: squad8, plan, gameState: GW8.GAME_STATE });
    assert.match(textOf(inheritedClubLimitBanner(notice)), /This plan plays your (Wildcard|Free Hit), which builds a squad within the limit/);
    assert.equal(clubLimitSaleNote(notice, held8.find((id) => fplTeam8.get(id) === ARSENAL.id)), null);
  }
});

test('an ordinary squad, exactly three from a club: no notice, no note, no notice kind', async () => {
  const { bundle } = await GW7.planFor('owner');
  const held = bundle.squadState.picks.map((p) => p.playerId);
  const fplTeam = new Map(GW7.BOOTSTRAP.elements.map((e) => [e.id, e.team]));
  const counts = {};
  for (const id of held) counts[fplTeam.get(id)] = (counts[fplTeam.get(id)] || 0) + 1;
  assert.ok(Object.values(counts).includes(3), 'the owner holds exactly three from one club');
  assert.ok(Object.values(counts).every((n) => n <= 3));
  const notice = inheritedClubNotice({ squadState: bundle.squadState, plan: bundle.current, gameState: GW7.GAME_STATE });
  assert.equal(notice, null);
  assert.equal(inheritedClubLimitBanner(notice), null);
  assert.equal(queryAll(transfersCard({ bundle, gameState: GW7.GAME_STATE, now: Date.parse(GW7.FETCHED_AT), clubNotice: notice }),
    'fpl-tr-club-note').length, 0);
  assert.ok(!noticeKinds({ planShown: true, clubLimit: !!notice }).includes('club-limit'));
  // Nothing held (pre-season): no notice either.
  assert.equal(inheritedClubNotice({ squadState: { picks: [] }, plan: null, gameState: GW7.GAME_STATE }), null);
});

test('two clubs over the limit: both are listed, with their counts, and both sales are required', () => {
  // The four-Arsenal squad, with one more player moved to the other club it
  // holds exactly three from, the way a deadline-day transfer moves a player.
  const counts = {};
  for (const id of held8) counts[fplTeam8.get(id)] = (counts[fplTeam8.get(id)] || 0) + 1;
  const [second] = Object.entries(counts).find(([t, n]) => Number(t) !== ARSENAL.id && n === 3) || [];
  assert.ok(second, 'the squad holds exactly three from a second club');
  const mover = held8.find((id) => fplTeam8.get(id) !== ARSENAL.id && fplTeam8.get(id) !== Number(second));
  const players = new Map([...GW8.GAME_STATE.players].map(([id, p]) => [id, id === mover ? { ...p, teamId: Number(second) } : p]));
  const gameState = { ...GW8.GAME_STATE, players };
  const secondName = GW8.GAME_STATE.teams.get(Number(second)).name;

  const rolled = inheritedClubNotice({ squadState: squad8, plan: roll8, gameState });
  assert.equal(rolled.clubs.length, 2);
  assert.deepEqual(rolled.clubs.map((c) => c.count), [4, 4]);
  const node = inheritedClubLimitBanner(rolled);
  const text = textOf(node);
  assert.match(text, /Your squad holds more than 3 players from 2 clubs/);
  assert.match(text, /every one of these clubs back to 3/);
  const items = [...walk(node)].filter((n) => n.tagName === 'LI').map(textOf);
  assert.equal(items.length, 2);
  assert.ok(items.some((t) => t.startsWith('Arsenal: 4 players')));
  assert.ok(items.some((t) => t.startsWith(`${secondName}: 4 players`)));

  const arsenalOut = held8.find((id) => fplTeam8.get(id) === ARSENAL.id);
  const secondOut = held8.find((id) => id !== mover && fplTeam8.get(id) === Number(second));
  const plan = { gw: GW8.PLAN_GW, chip: null, transferCount: 2, transfersOut: [arsenalOut, secondOut], transfersIn: [], squad: [] };
  const both = inheritedClubNotice({ squadState: squad8, plan, gameState });
  const t2 = textOf(inheritedClubLimitBanner(both));
  assert.match(t2, new RegExp(`requires selling 1 Arsenal player and 1 ${secondName} player; the plan sells `));
  assert.ok(t2.includes(`${name8(arsenalOut)} (Arsenal)`) && t2.includes(`${name8(secondOut)} (${secondName})`));
  assert.match(clubLimitSaleNote(both, secondOut), new RegExp(`${secondName} has to come back to 3 from 4`));
});

test('the notice sits with the plan, before any data notice, and never in the Data quality panel', async () => {
  const kinds = noticeKinds({ planShown: true, clubLimit: true, squadWarnings: true, stale: true });
  assert.ok(kinds.includes('club-limit'));
  assert.ok(kinds.indexOf('club-limit') < kinds.indexOf('stale'));
  assert.ok(kinds.indexOf('club-limit') < kinds.indexOf('squad-warnings'));
  assert.ok(!noticeKinds({ planShown: false, clubLimit: true }).includes('club-limit'), 'not over a withheld plan');

  const bundle = await plan8();
  assert.ok(!(bundle.squadState.warnings || []).some((w) => /club|limit/i.test(w.message || w.code)), 'not a squad warning');
  const panel = textOf(statusCard({ bundle, now: Date.parse(GW8.FETCHED_AT) }));
  assert.doesNotMatch(panel, /Your squad holds|over the limit|Partly required by the club limit/);
  const banner = inheritedClubLimitBanner(inheritedClubNotice({ squadState: squad8, plan: roll8, gameState: GW8.GAME_STATE }));
  assert.ok([...walk(banner)].some((n) => n.getAttribute && n.getAttribute('aria-hidden') === 'true'), 'the icon is hidden from assistive technology');
  assert.ok(queryAll(banner, 'fpl-banner-title').length === 1 && queryAll(banner, 'fpl-banner-text').length === 1, 'title and text are plain readable text');
});
