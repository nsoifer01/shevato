// Manager state as PROPERTIES over generated seasons, judged by an oracle that
// does not share a line of code with the engine.
//
// WHY THIS FILE EXISTS (2026-10-16). 29 user-facing defects escaped CI before
// GW7, and the category that produced the most of them was manager state: a
// history one and then two weeks behind the picks over-counted free transfers
// and offered back a chip already played, a transfer list behind the history
// priced recent buys at their season-start price, and a Wildcard week once
// handed out a free transfer FPL never gave. Every one of those had tests, and
// every test replayed the engine against its own author's walk of the rules or
// pinned the ONE state the bug was reported in (a lag of one week, the owner's
// team, the GW7 squads). A rule read wrongly in the engine was read the same
// way in its tests, and the neighbouring states (two weeks behind, the other
// free-transfer counts, the week after a chip) were never visited.
//
// So this file does three things the rest of the estate does not:
//
//   1. THE ORACLE is written here, from the published rules, and imports no
//      engine logic. Free transfers, hits, chips and selling prices are
//      recomputed from `game_settings` and the raw `chips` catalogue of the
//      GW7 bootstrap, never through `buildRules`, `chipAvailableAt` or
//      transfer-state.js. If the engine and the oracle agree it is because two
//      independent readings of the rules agree, not because one copied the
//      other.
//   2. THE GENERATOR draws legal manager seasons from a fixed seed: a joining
//      week of 1 to 5, 0 to 6 transfers a week (biased to zero so banks reach
//      the cap), hits charged by the oracle, chips only inside their window and
//      at most one a week. It emits FPL-shaped `history`, `transfers` and
//      per-week `picks` payloads, consistent with each other the way real FPL
//      payloads are (Wildcard and Free Hit weeks report `event_transfers: 0`
//      while the transfer list carries the moves; measured on the GW7 fixture).
//   3. PERTURBATIONS are the payload disagreements the app actually receives,
//      because the history, the transfer list and the picks are three cache
//      keys and api.js serves a stored copy of any age when a refresh fails: a
//      history 1, 2 or 3 weeks behind the picks, a transfer list missing its
//      last 1 or 2 weeks, and a chip row missing. The property is NOT "the
//      engine is right"; nothing can be right about a week it was never told.
//      It is "the engine is right OR it says it does not know"
//      (`historyMissing` / `transfersLagging`, on which readiness withholds
//      transfers and chips), and NEVER a different number shown silently.
//
// WHAT IS DRIVEN. The whole public path, `buildSquadState`, with the raw
// payloads (picks built from the generated squad, `revertPicks` after a Free
// Hit), against a GameState built from the GW7 bootstrap. The only other
// engine import is `freeTransferWitnessFailures` (scripts/lib/plan-audit.mjs),
// which is the production check under test, not part of the oracle.
//
// ONE MODELLING SIMPLIFICATION, stated so nobody mistakes it for a rule: a
// player in the manager's ORIGINAL fifteen is taken to have been paid his
// season-start price (now_cost - cost_change_start) whatever week the manager
// joined. That is FPL's truth for a GW1 squad. For a late joiner what was paid
// is the price on the joining day, which nothing public states; squad.js
// bounds it with `priceFloors` from element-summary rows, which this file does
// not generate (no floors are passed, so the engine also uses the start price).
// The late joiner's FREE TRANSFERS and CHIPS are modelled exactly.
//
// Budget: under three seconds locally. The seed is fixed, so a failure is a
// reproducible season; every assertion message names the seed's season index,
// the prefix and the perturbation, and `describeSeason` prints it in full.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildGameState } from '../js/engine/normalize.js';
import { buildSquadState } from '../js/engine/squad.js';
import { freeTransferWitnessFailures } from '../scripts/lib/plan-audit.mjs';

// ---------------------------------------------------------------------------
// The GW7 2026/27 bootstrap, as tests/helpers/gw7-fixture.mjs reads it, but
// without importing that helper: it pulls in the planner and the opening
// baseline, which this file does not need and should not pay for.
const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, 'fixtures', 'gw7-2026');
const J = (f) => JSON.parse(readFileSync(join(DIR, f), 'utf8'));
const expand = ({ fields, rows }) => rows.map((r) => Object.fromEntries(fields.map((f, i) => [f, r[i]])));
const RAW = J('bootstrap.json');
const BOOTSTRAP = { ...RAW, elements: expand(RAW.elements) };
const GAME_STATE = buildGameState(BOOTSTRAP, expand(J('fixtures.json')), { fetchedAt: '2026-10-16T19:00:00.000Z', ageSeconds: 0 });
const LAST_GW = BOOTSTRAP.events.length;

// ---------------------------------------------------------------------------
// THE ORACLE. Everything below reads the RAW bootstrap and the published rules
// (fantasy.premierleague.com/en/help/rules), never the engine.

// "You can bank up to a maximum of 5 free transfers": 1 for the week plus
// `max_extra_free_transfers` banked, read off the payload so a settings change
// moves the oracle and the engine together, and a wrong engine constant does not.
const CAP = 1 + BOOTSTRAP.game_settings.max_extra_free_transfers;
// The one number FPL does not publish in bootstrap-static: "each additional
// transfer you make in the same Gameweek will deduct 4 points".
const HIT_POINTS = 4;
const REBUILD = new Set(['wildcard', 'freehit']);
// The raw catalogue: each chip once per half, `start_event..stop_event` inclusive.
const WINDOWS = BOOTSTRAP.chips.map((c) => ({ name: c.name, start: c.start_event, stop: c.stop_event }));
const CHIP_NAMES = [...new Set(WINDOWS.map((w) => w.name))];

// Free transfers going into gameweek `gw` for a season whose week `w` is
// `{ n, chip }`. Up to and including the joining week the answer is unlimited
// (the squad is built before that deadline, so nothing is counted). The week
// after joining starts at exactly one. After each later week: a Wildcard or
// Free Hit week leaves the bank exactly as it was (transfers free, nothing
// spent, no +1, because the chip IS that week's transfer); any other week
// spends what it can and gains one, to the cap.
function oracleFreeTransfers(season, gw) {
  if (gw <= season.join) return Infinity;
  let bank = 1;
  for (let w = season.join + 1; w < gw; w++) {
    const { n, chip } = season.weeks[w];
    if (REBUILD.has(chip)) continue;
    bank = Math.min(CAP, Math.max(0, bank - n) + 1);
  }
  return bank;
}

// Points FPL deducts for `n` transfers on `bank` free ones.
function oracleHits(bank, n, chip) {
  if (REBUILD.has(chip) || !Number.isFinite(bank)) return 0;
  return HIT_POINTS * Math.max(0, n - bank);
}

// Chips playable in `gw` given those played (`{name, event}`): a window that
// contains gw and in which that chip has not been played.
function oracleChips(played, gw) {
  const out = new Set();
  for (const w of WINDOWS) {
    if (gw < w.start || gw > w.stop) continue;
    if (!played.some((c) => c.name === w.name && c.event >= w.start && c.event <= w.stop)) out.add(w.name);
  }
  return [...out].sort();
}

// "Your selling price ... receive 50% of the profit, rounded down to the
// nearest 0.1m"; a fall is passed on in full. Integer tenths.
function oracleSelling(purchase, now) {
  return now > purchase ? purchase + Math.floor((now - purchase) / 2) : now;
}

// ---------------------------------------------------------------------------
// THE GENERATOR.

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PLAYERS = [...GAME_STATE.players.values()].filter((p) => p.nowCost > 0);
const startPrice = (id) => { const p = GAME_STATE.players.get(id); return p.nowCost - p.costChangeStart; };
const nowPrice = (id) => GAME_STATE.players.get(id).nowCost;
const BASE_MS = Date.parse('2026-08-08T10:00:00.000Z');
const WEEK_MS = 7 * 86400000;

function pickAt(rng, n) { return Math.floor(rng() * n); }

// Transfers in a normal week: zero most often (so banks reach 4 and 5), a hit
// sometimes. In a Wildcard or Free Hit week, a rebuild of 3 to 12 moves.
function drawTransfers(rng, chip) {
  if (REBUILD.has(chip)) return 3 + pickAt(rng, 10);
  const r = rng();
  if (r < 0.45) return 0;
  if (r < 0.72) return 1;
  if (r < 0.86) return 2;
  if (r < 0.93) return 3;
  return 4 + pickAt(rng, 3);
}

// Chips legal in week `w`: in a window, unplayed in it, no Wildcard or Free Hit
// in the joining week (the transfers are unlimited anyway) and no Free Hit in
// two consecutive weeks (FPL hands the pre-chip squad back, so the next week's
// `revertPicks` must be a squad the manager owned).
function legalChips(played, w, join) {
  return oracleChips(played, w).filter((name) => {
    if (w === join && REBUILD.has(name)) return false;
    if (name === 'freehit' && played.some((c) => c.name === 'freehit' && c.event === w - 1)) return false;
    return true;
  });
}

const picksPayload = (squad, row, chip) => ({
  active_chip: chip,
  automatic_subs: [],
  entry_history: { ...row },
  picks: squad.map((element, i) => ({ element, position: i + 1, multiplier: i < 11 ? 1 : 0, is_captain: i === 0, is_vice_captain: i === 1 })),
});

// One legal season. `weeks[w] = { n, chip }`, `owned[w]` the persistent squad
// and what was paid for each player at the END of week w (what the next week
// plans from), and the three FPL payloads.
function generateSeason(rng, index, { join: joinIn = null, script = null } = {}) {
  const join = joinIn ?? 1 + pickAt(rng, 5);
  const squad = [];
  while (squad.length < 15) {
    const id = PLAYERS[pickAt(rng, PLAYERS.length)].id;
    if (!squad.includes(id)) squad.push(id);
  }
  let paid = new Map(squad.map((id) => [id, startPrice(id)]));
  let held = squad.slice();
  const weeks = {};
  const owned = {};
  const picks = {};
  const current = [];
  const chips = [];
  const transfers = [];
  let bank = Infinity;

  for (let w = join; w <= LAST_GW; w++) {
    let chip = null;
    let n;
    if (script) {
      ({ chip = null, n = 0 } = script(w) || {});
    } else {
      const legal = legalChips(chips, w, join);
      if (legal.length && rng() < 0.12) chip = legal[pickAt(rng, legal.length)];
      n = w === join ? 0 : drawTransfers(rng, chip);
    }
    weeks[w] = { n, chip };
    const cost = oracleHits(bank, n, chip);
    let fielded = held.slice();
    let fieldedPaid = new Map(paid);
    const boughtNow = new Set();
    for (let i = 0; i < n; i++) {
      const sellable = fielded.filter((id) => !boughtNow.has(id));
      const out = sellable[pickAt(rng, sellable.length)];
      let inId;
      do { inId = PLAYERS[pickAt(rng, PLAYERS.length)].id; } while (fielded.includes(inId));
      const inCost = Math.max(38, nowPrice(inId) + pickAt(rng, 17) - 8);
      transfers.push({
        element_in: inId, element_in_cost: inCost,
        element_out: out, element_out_cost: oracleSelling(fieldedPaid.get(out), nowPrice(out)),
        entry: 9000000 + index, event: w,
        time: new Date(BASE_MS + (w - 1) * WEEK_MS + i * 1000).toISOString(),
      });
      fielded = fielded.map((id) => (id === out ? inId : id));
      fieldedPaid.delete(out);
      fieldedPaid.set(inId, inCost);
      boughtNow.add(inId);
    }
    // A Free Hit team is rented for the week; the persistent squad is untouched.
    if (chip !== 'freehit') { held = fielded; paid = fieldedPaid; }
    owned[w] = { squad: held.slice(), paid: new Map(paid) };
    const row = {
      event: w, points: 50, total_points: 50 * (w - join + 1), rank: null, overall_rank: 100000,
      bank: 5, value: 1000, event_transfers: REBUILD.has(chip) ? 0 : n, event_transfers_cost: cost, points_on_bench: 0,
    };
    current.push(row);
    if (chip) chips.push({ name: chip, time: new Date(BASE_MS + (w - 1) * WEEK_MS).toISOString(), event: w });
    picks[w] = picksPayload(fielded, row, chip);
    bank = w === join ? 1 : (REBUILD.has(chip) ? bank : Math.min(CAP, Math.max(0, bank - n) + 1));
  }
  return { index, join, weeks, owned, picks, history: { current, past: [], chips }, transfers };
}

function describeSeason(season) {
  return `season #${season.index}, joined GW${season.join}: `
    + Object.entries(season.weeks).map(([w, { n, chip }]) => `${w}:${n}${chip ? `/${chip}` : ''}`).join(' ');
}

// ---------------------------------------------------------------------------
// The payloads the app holds when it plans gameweek `picksGw + 1`: the picks
// of the last played week (and the squad a Free Hit reverts to), and the
// history and transfer list through that week, optionally behind.

function payloadsAt(season, picksGw, { historyThrough = picksGw, transfersThrough = picksGw, dropChipAt = null } = {}) {
  const chipThere = season.weeks[picksGw].chip;
  return {
    entry: { id: 9000000 + season.index, name: `Generated ${season.index}`, player_first_name: '', player_last_name: '', started_event: season.join },
    history: {
      current: season.history.current.filter((r) => r.event <= historyThrough),
      past: [],
      chips: season.history.chips.filter((c) => c.event <= historyThrough && c.event !== dropChipAt),
    },
    transfers: season.transfers.filter((t) => t.event <= transfersThrough),
    picks: season.picks[picksGw],
    revertPicks: chipThere === 'freehit' ? season.picks[picksGw - 1] : null,
    // The squad the manager started with, read as js/app.js loadTeam reads it
    // (only when it is not the picks week itself).
    startPicks: season.join !== picksGw ? season.picks[season.join] : null,
    gameState: GAME_STATE,
    gw: picksGw + 1,
  };
}

const read = (payloads) => buildSquadState(payloads);

// The truth for planning `picksGw + 1`.
function truthAt(season, picksGw) {
  const gw = picksGw + 1;
  const played = season.history.chips.filter((c) => c.event <= picksGw);
  const { squad, paid } = season.owned[picksGw];
  return {
    freeTransfers: oracleFreeTransfers(season, gw),
    chips: oracleChips(played, gw),
    selling: new Map(squad.map((id) => [id, oracleSelling(paid.get(id), nowPrice(id))])),
  };
}

// What a state says, in the oracle's vocabulary.
function stateSays(s) {
  return {
    freeTransfers: s.freeTransfers,
    chips: [...s.chipsAvailable].sort(),
    selling: new Map(s.picks.map((p) => [p.playerId, p.sellingTenths])),
  };
}

const sameSelling = (a, b) => a.size === b.size && [...a].every(([id, v]) => b.get(id) === v);

// The property every perturbed state must hold: whatever it does not flag, it
// gets right. Chips are withheld outright on a missing history (squad.js), so
// a flagged history must offer none; a flagged list leaves the price unknown.
function assertTruthOrFlagged(s, truth, where) {
  const says = stateSays(s);
  if (s.historyMissing) {
    assert.deepEqual(says.chips, [], `${where}: a history flagged incomplete must offer no chip`);
  } else {
    assert.equal(says.freeTransfers, truth.freeTransfers, `${where}: free transfers silently wrong`);
    assert.deepEqual(says.chips, truth.chips, `${where}: chips silently wrong`);
  }
  if (!s.historyMissing && !s.transfersLagging) {
    assert.ok(sameSelling(says.selling, truth.selling),
      `${where}: selling prices silently wrong: ${JSON.stringify([...says.selling].filter(([id, v]) => truth.selling.get(id) !== v).map(([id, v]) => [id, v, truth.selling.get(id)]))}`);
  }
}

// ---------------------------------------------------------------------------
// The generated corpus. 1,000 seasons, every prefix: about 35,000 healthy
// states and about 175,000 perturbed ones (211,000 reads, under 3 s locally).

const SEED = 20261016;
const SEASONS = (() => {
  const rng = mulberry32(SEED);
  return Array.from({ length: 1000 }, (_, i) => generateSeason(rng, i));
})();

test('the generator covers the states the bugs lived in', () => {
  // A property suite that never visits the cap, a hit, a lagging chip week or
  // a late joiner would pass for the wrong reason. Measured, not assumed.
  const seen = { cap: 0, hits: 0, joinLate: 0, chips: {}, chipThenTransfers: 0 };
  for (const s of SEASONS) {
    if (s.join > 1) seen.joinLate++;
    for (let gw = s.join + 1; gw <= LAST_GW; gw++) if (oracleFreeTransfers(s, gw) === CAP) { seen.cap++; break; }
    for (const r of s.history.current) if (r.event_transfers_cost > 0) seen.hits++;
    for (const c of s.history.chips) {
      seen.chips[c.name] = (seen.chips[c.name] || 0) + 1;
      if (REBUILD.has(c.name) && s.weeks[c.event + 1] && s.weeks[c.event + 1].n > 0) seen.chipThenTransfers++;
    }
  }
  assert.equal(CAP, 5, 'the 2026/27 settings bank five');
  assert.ok(seen.cap > 500, `seasons reaching the cap: ${seen.cap}`);
  assert.ok(seen.hits > 3000, `weeks with a hit: ${seen.hits}`);
  assert.ok(seen.joinLate > 600, `late joiners: ${seen.joinLate}`);
  for (const name of CHIP_NAMES) assert.ok((seen.chips[name] || 0) > 800, `${name} played ${seen.chips[name] || 0} times`);
  assert.ok(seen.chipThenTransfers > 800, `rebuild weeks followed by transfers: ${seen.chipThenTransfers}`);
});

test('the oracle reproduces the five real GW7 managers (it reads the rules the way FPL charges them)', () => {
  // The oracle is only worth something if it is right about real payloads.
  // Every hit FPL charged on the five real GW7 histories must come out of it,
  // and their GW7 counts must be the hand-derived 2, 3, 1, 1, 1
  // (tests/real-deadline-gw7.test.mjs), with no engine code involved.
  const entries = J('entries.json');
  const expected = { 'bench-boost': 2, 'deep-search': 3, 'free-hit': 1, owner: 1, 'triple-captain-tie': 1 };
  for (const [label, e] of Object.entries(entries)) {
    const chipAt = new Map(e.history.chips.map((c) => [c.event, c.name]));
    const join = Math.min(...e.history.current.map((r) => r.event));
    const season = { join, weeks: {} };
    for (const r of e.history.current) season.weeks[r.event] = { n: r.event_transfers, chip: chipAt.get(r.event) || null };
    for (const r of e.history.current) {
      const bank = oracleFreeTransfers(season, r.event);
      assert.equal(oracleHits(bank, r.event_transfers, chipAt.get(r.event) || null), r.event_transfers_cost, `${label} GW${r.event}`);
    }
    assert.equal(oracleFreeTransfers(season, 7), expected[label], label);
  }
});

test('healthy payloads: every prefix of every season reads exactly the oracle', () => {
  for (const season of SEASONS) {
    // FPL's own witness: the engine's replay must reproduce every hit charged.
    assert.deepEqual(freeTransferWitnessFailures({ history: season.history, rules: GAME_STATE.rules }), [], describeSeason(season));
    for (let p = season.join; p < LAST_GW; p++) {
      const where = `season #${season.index} planning GW${p + 1}`;
      const s = read(payloadsAt(season, p));
      assert.equal(s.historyMissing, false, `${where}: a complete history is never flagged`);
      assert.equal(s.transfersLagging, false, `${where}: a complete list is never flagged`);
      assert.equal(s.freeHitUnresolved, false, where);
      const truth = truthAt(season, p);
      const says = stateSays(s);
      assert.equal(says.freeTransfers, truth.freeTransfers, `${where}: free transfers. ${describeSeason(season)}`);
      assert.deepEqual(says.chips, truth.chips, `${where}: chips`);
      assert.ok(sameSelling(says.selling, truth.selling), `${where}: selling prices`);
    }
  }
});

test('a history 1, 2 or 3 weeks behind the picks is caught up or flagged, never silently wrong', () => {
  let flagged = 0;
  let caughtUp = 0;
  for (const season of SEASONS) {
    for (let p = season.join; p < LAST_GW; p++) {
      const truth = truthAt(season, p);
      for (const lag of [1, 2, 3]) {
        const where = `season #${season.index} planning GW${p + 1}, history ${lag} behind`;
        const s = read(payloadsAt(season, p, { historyThrough: p - lag }));
        assertTruthOrFlagged(s, truth, where);
        // Not only safe but useful: one week behind is exactly what the picks'
        // own entry_history fills, so it must not be withheld (unless the
        // history then holds no row at all, which is a missing history).
        if (lag === 1 && p - 1 >= season.join) assert.equal(s.historyMissing, false, `${where}: one week is filled from the picks`);
        if (lag >= 2) assert.equal(s.historyMissing, true, `${where}: a hole the picks cannot fill must be flagged`);
        if (s.historyMissing) flagged++; else caughtUp++;
      }
    }
  }
  assert.ok(flagged > 50000 && caughtUp > 25000, `${flagged} flagged, ${caughtUp} caught up`);
});

// Whether dropping the list after `through` hides moves made under a Wildcard
// (FPL's row says 0 for that week, so no count can show the list is short).
const hidesWildcardBuys = (season, p, through) => {
  for (let w = Math.max(through + 1, season.join); w <= p; w++) if (season.weeks[w].chip === 'wildcard' && season.weeks[w].n > 0) return true;
  return false;
};

test('a transfer list missing its last 1 or 2 weeks is priced right or flagged, never silently wrong', () => {
  let flagged = 0;
  for (const season of SEASONS) {
    for (let p = season.join; p < LAST_GW; p++) {
      const truth = truthAt(season, p);
      for (const behind of [1, 2]) {
        // Lagging past a Wildcard week has its own test below (squad.js
        // unexplainedPlayers); every other lag must hold here.
        if (hidesWildcardBuys(season, p, p - behind)) continue;
        const where = `season #${season.index} planning GW${p + 1}, list ${behind} behind`;
        const s = read(payloadsAt(season, p, { transfersThrough: p - behind }));
        assertTruthOrFlagged(s, truth, where);
        // The list never touches the free-transfer count or the chips.
        assert.equal(s.freeTransfers, truth.freeTransfers, where);
        // And a normal week with moves the list lacks is always flagged.
        const missedNormal = [...Array(behind).keys()].map((i) => p - i)
          .some((w) => w >= season.join && !REBUILD.has(season.weeks[w].chip) && season.weeks[w].n > 0);
        if (missedNormal) assert.equal(s.transfersLagging, true, `${where}: a normal week's moves are missing`);
        if (s.transfersLagging) flagged++;
      }
    }
  }
  assert.ok(flagged > 30000, `${flagged} flagged`);
});

// REAL DEFECT, found by this file on 2026-10-16 and fixed 2026-10-17 by
// squad.js unexplainedPlayers (every player held must be in the starting squad
// or bought by a listed transfer, which no chip can hide).
// `transfersBehind` (squad.js) compares the list against FPL's per-week
// `event_transfers`, and skips Wildcard and Free Hit weeks because FPL reports
// 0 there whatever was made. For a Free Hit that is harmless (its moves are
// undone and ignored for pricing). For a Wildcard it is not: the moves STICK,
// so a list that ends before the Wildcard week prices every player bought
// under it at his season-start price, and neither flag is raised. Minimal
// repro: one transfer a week to GW8, a 9-move Wildcard in GW10, picks of GW10,
// history complete through GW10, transfer list ending GW9: planning GW11
// reads `transfersLagging: false` and wrong selling prices for the Wildcard
// buys. In the generated corpus it is the only silent mispricing.
test('a transfer list ending before a Wildcard week is priced right or flagged', () => {
  const season = scripted(1, (w) => (w <= 8 ? { n: w === 1 ? 0 : 1 } : w === 10 ? { n: 9, chip: 'wildcard' } : { n: 0 }));
  assertTruthOrFlagged(read(payloadsAt(season, 10, { transfersThrough: 9 })), truthAt(season, 10), 'Wildcard GW10, list ending GW9, planning GW11');
  let silent = 0;
  for (const s of SEASONS) {
    for (let p = s.join; p < LAST_GW; p++) {
      for (const behind of [1, 2]) {
        if (!hidesWildcardBuys(s, p, p - behind)) continue;
        const st = read(payloadsAt(s, p, { transfersThrough: p - behind }));
        if (!st.transfersLagging && !sameSelling(stateSays(st).selling, truthAt(s, p).selling)) silent++;
      }
    }
  }
  assert.equal(silent, 0, `${silent} generated states price Wildcard buys wrong without a flag`);
});

test('the picks week\'s chip row missing from the history is filled from active_chip', () => {
  // The one way a chip row goes missing in practice: the history in hand ends
  // before the picks week, or (the `hasChip` branch of historyCaughtUp) carries
  // the week's row without its chip. The picks payload names the chip. A chip
  // row for an EARLIER week cannot go missing on its own: rows and chips are
  // one payload (entry/{id}/history), so that disagreement is the history lag
  // above, which drops both.
  let cases = 0;
  for (const season of SEASONS) {
    for (const c of season.history.chips) {
      if (c.event >= LAST_GW) continue;
      const where = `season #${season.index} planning GW${c.event + 1}, ${c.name} row dropped`;
      assertTruthOrFlagged(read(payloadsAt(season, c.event, { dropChipAt: c.event })), truthAt(season, c.event), where);
      cases++;
    }
  }
  assert.ok(cases > 3000, `${cases} cases`);
});

// ---------------------------------------------------------------------------
// BOUNDARIES, enumerated rather than left to the dice.

const scripted = (join, plan) => generateSeason(mulberry32(join * 7919), 90000 + join, { join, script: (w) => plan(w) });

test('free transfers 0 to 5 and the cap, including transfers already made for the planned week', () => {
  // Bank b (1..5) by playing b-1 quiet weeks after GW1, then hand the engine
  // p (0..6) transfers already made for the planned week (they are in the
  // list for that week and not yet in the history: squad.js pendingTransfers).
  // What is left is max(0, b - p), with max(0, p - b) hits already taken:
  // the only way the count reads 0. Then roll past the cap.
  for (let b = 1; b <= CAP; b++) {
    const season = scripted(1, () => ({ n: 0 }));
    const p = b; // picks of GW b, planning GW b+1
    assert.equal(oracleFreeTransfers(season, p + 1), b);
    for (let made = 0; made <= 6; made++) {
      const payloads = payloadsAt(season, p);
      const squad = season.owned[p].squad;
      const pending = [];
      const used = new Set(squad);
      for (let i = 0; i < made; i++) {
        const inId = PLAYERS.find((x) => !used.has(x.id)).id;
        used.add(inId);
        pending.push({ element_in: inId, element_in_cost: nowPrice(inId), element_out: squad[i], element_out_cost: nowPrice(squad[i]), event: p + 1, time: new Date(BASE_MS + p * WEEK_MS + i * 1000).toISOString() });
      }
      const s = read({ ...payloads, transfers: [...payloads.transfers, ...pending] });
      assert.equal(s.freeTransfers, Math.max(0, b - made), `banked ${b}, made ${made}`);
      assert.equal(s.hitsAlreadyTaken, Math.max(0, made - b), `banked ${b}, made ${made}`);
    }
  }
  const quiet = scripted(1, () => ({ n: 0 }));
  for (let gw = 2; gw <= 12; gw++) assert.equal(read(payloadsAt(quiet, gw - 1)).freeTransfers, Math.min(CAP, gw - 1), `quiet season into GW${gw}`);
  // At the cap, a one-transfer week stays at the cap (5 - 1 + 1), a hit week
  // spends all five: 6 transfers cost 4 and leave 0 + 1.
  const capped = scripted(1, (w) => ({ n: w === 8 ? 1 : w === 10 ? 6 : 0 }));
  const capTruth = (gw) => oracleFreeTransfers(capped, gw);
  assert.deepEqual([8, 9, 10, 11, 12].map(capTruth), [5, 5, 5, 1, 2]);
  assert.equal(capped.history.current.find((r) => r.event === 10).event_transfers_cost, 4);
  for (const gw of [8, 9, 10, 11, 12]) assert.equal(read(payloadsAt(capped, gw - 1)).freeTransfers, capTruth(gw), `capped GW${gw}`);
});

test('GW1 and the joining week: unlimited until the first deadline the manager plays, then exactly one', () => {
  // Before any picks exist (a draft), the allowance is a state, not the cap.
  const draft = buildSquadState({ entry: null, history: null, transfers: [], picks: null, gameState: GAME_STATE, gw: 1 });
  assert.equal(draft.freeTransfers, Infinity);
  // WC and FH open in GW2; BB and TC are legal in GW1.
  assert.deepEqual(oracleChips([], 1), ['3xc', 'bboost']);
  assert.deepEqual(oracleChips([], 2), ['3xc', 'bboost', 'freehit', 'wildcard']);
  for (const join of [1, 2, 3, 5, 10, 20, 37]) {
    const season = scripted(join, (w) => ({ n: w === join ? 0 : 1 }));
    const first = read(payloadsAt(season, join));
    assert.equal(first.freeTransfers, 1, `joined GW${join}: one free transfer for GW${join + 1}`);
    assert.equal(oracleFreeTransfers(season, join + 1), 1);
    assert.equal(oracleFreeTransfers(season, join), Infinity);
    // A one-transfer-a-week manager stays on one.
    if (join + 2 <= LAST_GW) assert.equal(read(payloadsAt(season, join + 1)).freeTransfers, 1, `joined GW${join}, a week later`);
  }
});

test('GW19 to GW20: every chip comes back for the second half, and GW38 is still in its window', () => {
  // All four first-half chips played by GW18 (BB in GW1, TC GW2, WC GW3, FH GW5).
  const order = { 1: 'bboost', 2: '3xc', 3: 'wildcard', 5: 'freehit' };
  const season = scripted(1, (w) => ({ n: w === 19 ? 1 : 0, chip: order[w] || null }));
  assert.deepEqual(read(payloadsAt(season, 18)).chipsAvailable, [], 'nothing left for GW19');
  assert.deepEqual([...read(payloadsAt(season, 19)).chipsAvailable].sort(), ['3xc', 'bboost', 'freehit', 'wildcard'], 'all four for GW20');
  // A Wildcard played IN GW19 is the first half's, so GW20 still has one.
  const late = scripted(1, (w) => ({ n: 0, chip: w === 19 ? 'wildcard' : null }));
  assert.ok(read(payloadsAt(late, 18)).chipsAvailable.includes('wildcard'), 'the first-half Wildcard is still there for GW19');
  assert.ok(read(payloadsAt(late, 19)).chipsAvailable.includes('wildcard'), 'and a fresh one for GW20');
  // A second-half chip played in GW20 is gone for GW38; the others are there.
  const end = scripted(1, (w) => ({ n: 0, chip: w === 20 ? 'bboost' : null }));
  const gw38 = read(payloadsAt(end, 37));
  assert.deepEqual([...gw38.chipsAvailable].sort(), ['3xc', 'freehit', 'wildcard']);
  assert.equal(gw38.freeTransfers, oracleFreeTransfers(end, 38));
  assert.equal(gw38.freeTransfers, CAP);
});

test('each chip in the lagging week: caught up from the picks one week behind, flagged two behind', () => {
  // The owner's real failure: a history behind the picks with a chip in the
  // missing weeks. For each chip, played in GW10 by a manager holding 3 free
  // transfers, with 2 transfers in GW10 (a normal week) or a rebuild:
  //   one week behind (picks = GW10): the picks carry the chip and the row;
  //   two weeks behind (picks = GW11): GW10 is unknowable, so flagged.
  for (const chip of CHIP_NAMES) {
    const season = scripted(1, (w) => (w <= 8 ? { n: w === 1 ? 0 : 1 } : w === 10 ? { n: REBUILD.has(chip) ? 9 : 2, chip } : { n: 0 }));
    for (const [p, lag] of [[10, 1], [11, 1], [11, 2], [12, 3]]) {
      const truth = truthAt(season, p);
      const s = read(payloadsAt(season, p, { historyThrough: p - lag }));
      const where = `${chip} in GW10, planning GW${p + 1} with the history ${lag} behind`;
      assertTruthOrFlagged(s, truth, where);
      if (lag === 1) {
        assert.equal(s.historyMissing, false, where);
        assert.equal(s.freeTransfers, truth.freeTransfers, where);
        assert.ok(!s.chipsAvailable.includes(chip), `${where}: the chip played is not offered back`);
      } else {
        assert.equal(s.historyMissing, true, where);
      }
    }
    // The rebuild's own week with the transfer list ending before it (the
    // Wildcard case is its own test above; the other three must hold).
    if (chip !== 'wildcard') {
      const t = read(payloadsAt(season, 10, { transfersThrough: 9 }));
      assertTruthOrFlagged(t, truthAt(season, 10), `${chip} in GW10, list ending GW9`);
    }
  }
});
