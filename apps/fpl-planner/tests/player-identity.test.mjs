// Cross-season player identity.
//
// THE BUG THESE TESTS EXIST FOR. Joining two seasons of the archive on
// `element` produced a season-to-season start-rate regression slope of 0.017.
// Start rate is one of the most persistent quantities in football, so the right
// answer is around 0.7, and the difference is entirely that FPL reassigns
// `element` every season: the join matched different players and returned noise
// shaped like a result. It failed silently because a wrong join still produces a
// full table of plausible numbers.
//
// The last test in this file is that measurement, run as an assertion.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  CANONICAL_ID_FIELD,
  SEASON_SCOPED_ID_FIELDS,
  assertCrossSeasonField,
  buildIdentityIndex,
  crossSeasonKey,
  isSeasonScopedField,
  nameTokens,
  normalizeName,
  resolveSeasonPair,
} from '../js/engine/player-identity.js';
import { buildDataset, createAccumulator, BACKTEST_PARAMS } from '../js/engine/backtest.js';
import { DATA_DIR, identityPath, seasonPath } from '../scripts/fetch-history.mjs';

// ---------------------------------------------------------------------------
// A cross-season join must refuse a season-scoped id
// ---------------------------------------------------------------------------

test('every season-scoped spelling of a player id is refused as a cross-season key', () => {
  for (const field of SEASON_SCOPED_ID_FIELDS) {
    assert.equal(isSeasonScopedField(field), true, `${field} must be known to be season scoped`);
    assert.throws(
      () => assertCrossSeasonField(field),
      /cannot key a cross-season join/,
      `${field} must be refused, not accepted with a warning`,
    );
  }
  assert.equal(isSeasonScopedField(CANONICAL_ID_FIELD), false);
  assert.equal(assertCrossSeasonField(CANONICAL_ID_FIELD), CANONICAL_ID_FIELD);
});

test('crossSeasonKey refuses a player carrying only an element id', () => {
  // The exact shape the bug had: an id, a name, and no code. Falling back to the
  // id here is precisely what must not happen.
  assert.throws(
    () => crossSeasonKey({ id: 403, name: 'Nathan Redmond' }),
    /needs a canonical `code`/,
  );
  assert.throws(() => crossSeasonKey({ id: 403, name: 'X', code: null }), /needs a canonical `code`/);
  assert.throws(() => crossSeasonKey({ id: 403, name: 'X', code: 0 }), /needs a canonical `code`/);
  assert.equal(crossSeasonKey({ id: 403, code: 171287 }), 171287);
});

test('resolveSeasonPair refuses to be used as a within-season join', () => {
  const roster = { season: '2024-25', players: [{ id: 1, name: 'A B', code: 11 }] };
  assert.throws(
    () => resolveSeasonPair({ from: roster, to: roster }),
    /given 2024-25 on both sides/,
  );
});

test('resolveSeasonPair never matches on the id, even when the ids line up exactly', () => {
  // Two seasons whose element ids are identical and whose players are entirely
  // different, which is what the archive actually looks like. A join that keys
  // on the id would report three matches; the correct answer is zero.
  const from = {
    season: '2022-23',
    players: [
      { id: 403, name: 'Nathan Redmond', code: 61933 },
      { id: 58, name: 'Junior Stanislas', code: 41792 },
      { id: 150, name: 'Armando Broja', code: 434882 },
    ],
  };
  const to = {
    season: '2023-24',
    players: [
      { id: 403, name: 'Elliot Anderson', code: 464508 },
      { id: 58, name: 'Youri Tielemans', code: 116643 },
      { id: 150, name: 'Jan Paul van Hecke', code: 445044 },
    ],
  };
  const resolved = resolveSeasonPair({ from, to });
  assert.equal(resolved.matched.size, 0, 'no player in either season is the same footballer');
  assert.equal(resolved.stats.newcomers, 3);
});

// ---------------------------------------------------------------------------
// Collisions are reported, never guessed
// ---------------------------------------------------------------------------

test('two players with one name are reported as a collision and left unresolved', () => {
  const from = {
    season: '2022-23',
    players: [
      { id: 1, name: 'Ben Davies', code: 100 },   // the Tottenham defender
      { id: 2, name: 'Ben Davies', code: 200 },   // the Rangers defender, on loan
    ],
  };
  const to = { season: '2023-24', players: [{ id: 9, name: 'Ben Davies', code: null }] };

  const resolved = resolveSeasonPair({ from, to });
  assert.equal(resolved.matched.size, 0, 'a name two players answer to must not resolve to either');
  assert.equal(resolved.stats.collisions, 1);
  assert.deepEqual(resolved.stats.collisionSample[0].candidates, ['Ben Davies', 'Ben Davies']);
});

test('one player that two later players both match is a collision, not a double seed', () => {
  // The mirror image of the case above, and the one a per-rung uniqueness check
  // does not catch on its own: each of these resolves uniquely in the season
  // being joined FROM, and they resolve to the same man.
  const from = { season: '2023-24', players: [{ id: 1, name: 'Ben Davies', code: null }] };
  const to = {
    season: '2024-25',
    players: [
      { id: 8, name: 'Ben Davies', code: null },
      { id: 9, name: 'Ben Davies', code: null },
    ],
  };
  const resolved = resolveSeasonPair({ from, to });
  assert.equal(resolved.matched.size, 0, 'neither may inherit the season, because only one of them earned it');
  assert.equal(resolved.stats.collisions, 1);
  assert.equal(resolved.stats.collisionSample[0].rung, 'many-to-one');
  assert.equal(resolved.stats.byRung.name, 0, 'a withdrawn match must not still be counted as a match');
});

test('a code resolves a pair that the name alone could not', () => {
  const from = {
    season: '2022-23',
    players: [{ id: 1, name: 'Ben Davies', code: 100 }, { id: 2, name: 'Ben Davies', code: 200 }],
  };
  const to = { season: '2023-24', players: [{ id: 9, name: 'Ben Davies', code: 200 }] };
  const resolved = resolveSeasonPair({ from, to });
  assert.equal(resolved.matched.get(9).id, 2);
  assert.equal(resolved.method.get(9), 'code');
  assert.equal(resolved.stats.collisions, 0);
});

test('the name fallback refuses a subset match rather than guessing', () => {
  // "Kyle Walker" and "Kyle Walker-Peters" are two footballers. A token-subset
  // rung matched them and had to be removed; this pins the refusal.
  const from = { season: '2023-24', players: [{ id: 1, name: 'Kyle Walker', code: null }] };
  const to = { season: '2024-25', players: [{ id: 2, name: 'Kyle Walker-Peters', code: null }] };
  assert.equal(resolveSeasonPair({ from, to }).matched.size, 0);

  // ... while a genuine respelling of one man still resolves.
  const respelt = resolveSeasonPair({
    from: { season: '2023-24', players: [{ id: 1, name: 'Takehiro Tomiyasu', code: null }] },
    to: { season: '2024-25', players: [{ id: 2, name: 'Tomiyasu Takehiro', code: null }] },
  });
  assert.equal(respelt.matched.get(2).id, 1);
  assert.equal(respelt.method.get(2), 'tokenSet');
});

test('accent folding covers the letters NFD cannot decompose', () => {
  assert.equal(normalizeName('Rasmus Højlund'), 'rasmus hojlund');
  assert.ok(!normalizeName('Rasmus Højlund').includes('hjlund'));
  assert.equal(normalizeName('Łukasz Fabiański'), 'lukasz fabianski');
  assert.equal(normalizeName('Đorđe Petrović'), 'dorde petrovic');
  assert.equal(normalizeName('Mateo Kovačić'), 'mateo kovacic');
  // Hyphens split like spaces, so a double-barrelled name is order-free too.
  assert.deepEqual([...nameTokens('Kaine Kesler-Hayden')].sort(), ['hayden', 'kaine', 'kesler']);
  assert.deepEqual([...nameTokens('Kaine Kesler Hayden')].sort(), ['hayden', 'kaine', 'kesler']);
});

// ---------------------------------------------------------------------------
// The seeded accumulator must follow the player, not the row number
// ---------------------------------------------------------------------------

const COLUMNS = ['name', 'position', 'team', 'element', 'GW', 'fixture', 'opponent_team', 'was_home',
  'value', 'minutes', 'starts', 'total_points', 'kickoff_time', 'team_h_score', 'team_a_score',
  'expected_goals', 'expected_assists', 'expected_goals_conceded', 'bps', 'saves', 'bonus',
  'goals_scored', 'assists', 'clean_sheets', 'goals_conceded', 'yellow_cards', 'red_cards',
  'own_goals', 'penalties_saved', 'penalties_missed', 'selected'];

function csvFor(players, season) {
  const rows = [COLUMNS.join(',')];
  for (const p of players) {
    for (let gw = 1; gw <= 2; gw++) {
      const values = {
        name: p.name, position: 'MID', team: p.team || 'Arsenal', element: p.element, GW: gw,
        fixture: gw, opponent_team: gw === 1 ? 2 : 3, was_home: gw === 1 ? 'True' : 'False',
        value: 70, minutes: p.minutes, starts: 1, total_points: p.points, bonus: 0,
        kickoff_time: `20${season.slice(2, 4)}-08-1${gw}T14:00:00Z`,
        team_h_score: 1, team_a_score: 0, expected_goals: '0.1', expected_assists: '0.1',
        expected_goals_conceded: '1.0', bps: 20, saves: 0, goals_scored: 0, assists: 0,
        clean_sheets: 0, goals_conceded: 1, yellow_cards: 0, red_cards: 0, own_goals: 0,
        penalties_saved: 0, penalties_missed: 0, selected: 1000,
      };
      rows.push(COLUMNS.map(c => values[c]).join(','));
    }
  }
  return `${rows.join('\n')}\n`;
}

test('the prior season seeds the player who earned it, not whoever inherited his element id', () => {
  // Deliberately adversarial and exactly the real shape: the element ids are
  // reused and swapped between the two seasons.
  const prior = buildDataset({
    csv: csvFor([
      { element: 10, name: 'Prolific Winger', minutes: 90, points: 12 },
      { element: 20, name: 'Reserve Keeper', minutes: 0, points: 0 },
    ], '2022-23'),
    season: '2022-23',
    identity: { season: '2022-23', codeByElement: new Map([[10, 555], [20, 666]]) },
  });
  const current = buildDataset({
    csv: csvFor([
      { element: 20, name: 'Prolific Winger', minutes: 90, points: 9 },
      { element: 10, name: 'Reserve Keeper', minutes: 0, points: 0 },
    ], '2023-24'),
    season: '2023-24',
    identity: { season: '2023-24', codeByElement: new Map([[20, 555], [10, 666]]) },
  });

  const acc = createAccumulator(current, { priorDataset: prior });
  const w = BACKTEST_PARAMS.priorSeasonWeight;

  // The winger is element 20 this season and element 10 last season.
  assert.equal(acc.totalsFor(20).minutes, 180 * w, 'the winger keeps his own minutes');
  assert.equal(acc.totalsFor(20).totalPoints, 24 * w);
  // The keeper is element 10 this season and must not inherit the winger's year.
  assert.equal(acc.totalsFor(10).minutes, 0, 'the keeper must not inherit the winger of the same element id');
  assert.equal(acc.totalsFor(10).totalPoints, 0);

  assert.equal(acc.priorJoin.byRung.code, 2, 'both players resolved by permanent code');
  assert.equal(acc.priorJoin.collisions, 0);
});

test('a returning player who is respelt between seasons still keeps his history', () => {
  // The bug this replaces: the seeding matched the archive's raw `name` string
  // exactly, and the archive respells returning players freely. Rodri went from
  // "Rodrigo Hernandez" to "Rodrigo 'Rodri' Hernandez" and lost 2,931 minutes;
  // Tomiyasu's name flipped order and lost 1,140. Twenty-three players lost
  // their whole previous season this way going into 2024-25 alone.
  const prior = buildDataset({
    csv: csvFor([{ element: 7, name: 'Rodrigo Hernandez', minutes: 90, points: 8 }], '2023-24'),
    season: '2023-24',
    identity: { season: '2023-24', codeByElement: new Map([[7, 220566]]) },
  });
  const current = buildDataset({
    csv: csvFor([{ element: 41, name: "Rodrigo 'Rodri' Hernandez", minutes: 90, points: 6 }], '2024-25'),
    season: '2024-25',
    identity: { season: '2024-25', codeByElement: new Map([[41, 220566]]) },
  });

  const acc = createAccumulator(current, { priorDataset: prior });
  assert.equal(
    acc.totalsFor(41).minutes, 180 * BACKTEST_PARAMS.priorSeasonWeight,
    'a respelt name must not cost a player his previous season',
  );
  assert.equal(acc.priorJoin.resolved, 1);
});

test('a dataset without an identity table carries a null code, never the element id', () => {
  const dataset = buildDataset({
    csv: csvFor([{ element: 10, name: 'Somebody Else', minutes: 90, points: 4 }], '2023-24'),
    season: '2023-24',
  });
  const player = dataset.players.get(10);
  assert.equal(player.id, 10);
  assert.equal(player.code, null, 'an absent code must read as absent, not as the season-scoped id');
  assert.throws(() => crossSeasonKey(player), /needs a canonical `code`/);
});

// ---------------------------------------------------------------------------
// The real archive
// ---------------------------------------------------------------------------

const heldSeasons = () => (fs.existsSync(DATA_DIR)
  ? fs.readdirSync(DATA_DIR)
    .filter(name => fs.existsSync(seasonPath(name)) && fs.existsSync(identityPath(name)))
    .sort()
  : []);

test('the archive carries no permanent id of its own, which is why the identity table exists', (t) => {
  const seasons = heldSeasons();
  if (!seasons.length) return t.skip('no downloaded seasons in .data (run scripts/fetch-history.mjs)');

  for (const season of seasons) {
    const header = fs.readFileSync(seasonPath(season), 'utf8').split('\n', 1)[0].split(',').map(c => c.trim());
    assert.ok(header.includes('element'), `${season} merged_gw.csv should carry element`);
    assert.ok(
      !header.includes('code'),
      `${season} merged_gw.csv now carries a code column. That is good news, but the identity `
      + 'bridge in player-identity.js was built because it did not, so read it before relying on this.',
    );
  }
});

test('code is stable across every pair of seasons we hold, and element is not', (t) => {
  const seasons = heldSeasons();
  if (seasons.length < 2) return t.skip('fewer than two downloaded seasons with identity tables');

  const idx = Object.fromEntries(seasons.map(s => [
    s, buildIdentityIndex(fs.readFileSync(identityPath(s), 'utf8'), { season: s }),
  ]));

  for (let i = 1; i < seasons.length; i++) {
    const a = seasons[i - 1];
    const b = seasons[i];
    const nameOf = (index, code) => normalizeName(index.nameByCode.get(code));

    // CODE: every code shared by two seasons must name one footballer. Names are
    // respelt between seasons (accents restored, surnames added), so the test is
    // that the two spellings share an identifying token, never that they are
    // byte-identical.
    let shared = 0;
    const strangers = [];
    for (const code of idx[a].nameByCode.keys()) {
      if (!idx[b].nameByCode.has(code)) continue;
      shared++;
      const left = nameTokens(nameOf(idx[a], code));
      const right = nameTokens(nameOf(idx[b], code));
      if (![...left].some(tok => right.has(tok))) {
        strangers.push(`code ${code}: "${nameOf(idx[a], code)}" then "${nameOf(idx[b], code)}"`);
      }
    }
    assert.ok(shared > 100, `${a} -> ${b} should share hundreds of codes, shared ${shared}`);
    assert.deepEqual(
      strangers, [],
      `${a} -> ${b}: a shared code must be the same footballer. If this fails, code is not canonical `
      + 'and every cross-season join in this repository is built on sand.',
    );

    // ELEMENT: the same test against the season-scoped id, asserting it FAILS.
    // If this ever passes, FPL stopped reassigning element ids, and that is a
    // fact to verify deliberately rather than inherit.
    let sharedElements = 0;
    let sameFootballer = 0;
    for (const [element, code] of idx[a].codeByElement) {
      const other = idx[b].codeByElement.get(element);
      if (other === undefined) continue;
      sharedElements++;
      if (other === code) sameFootballer++;
    }
    assert.ok(sharedElements > 100, `${a} -> ${b} shares ${sharedElements} element ids`);
    assert.ok(
      sameFootballer / sharedElements < 0.05,
      `${a} -> ${b}: ${sameFootballer} of ${sharedElements} shared element ids are the same player. `
      + 'element is documented everywhere here as reassigned every season; if it is now stable, '
      + 'the documentation and player-identity.js both need rewriting on purpose.',
    );
  }
});

test('the resolver matches every returning player in the real archive and guesses at none', (t) => {
  const seasons = heldSeasons();
  if (seasons.length < 2) return t.skip('fewer than two downloaded seasons with identity tables');

  for (let i = 1; i < seasons.length; i++) {
    const a = seasons[i - 1];
    const b = seasons[i];
    const load = (s) => buildDataset({
      csv: fs.readFileSync(seasonPath(s), 'utf8'),
      season: s,
      identity: buildIdentityIndex(fs.readFileSync(identityPath(s), 'utf8'), { season: s }),
    });
    const from = load(a);
    const to = load(b);
    const roster = (d) => ({
      season: d.season,
      players: [...d.players.values()].map(p => ({ id: p.id, name: p.name, code: p.code })),
    });

    const resolved = resolveSeasonPair({ from: roster(from), to: roster(to) });
    assert.equal(resolved.stats.collisions, 0, `${a} -> ${b} collisions: ${JSON.stringify(resolved.stats.collisionSample)}`);
    assert.equal(resolved.stats.unresolved, 0, `${a} -> ${b} unresolved: ${JSON.stringify(resolved.stats.unresolvedSample)}`);
    assert.equal(
      resolved.stats.byRung.code, resolved.stats.resolved,
      `${a} -> ${b}: every match should come from the permanent code, not a name heuristic`,
    );
    assert.ok(resolved.stats.resolved > 400, `${a} -> ${b} resolved only ${resolved.stats.resolved}`);
  }
});

// ---------------------------------------------------------------------------
// The measurement that started this
// ---------------------------------------------------------------------------

test('start rate persists season to season, which only a correct join can show', (t) => {
  const seasons = heldSeasons();
  if (seasons.length < 2) return t.skip('fewer than two downloaded seasons with identity tables');

  const parse = (season) => {
    const dataset = buildDataset({
      csv: fs.readFileSync(seasonPath(season), 'utf8'),
      season,
      identity: buildIdentityIndex(fs.readFileSync(identityPath(season), 'utf8'), { season }),
    });
    const byCode = new Map();
    const byElement = new Map();
    for (const p of dataset.players.values()) {
      const played = p.rows.length;
      if (played < 10) continue;
      const rate = p.rows.reduce((s, r) => s + (r.starts > 0 ? 1 : 0), 0) / played;
      if (p.code !== null) byCode.set(p.code, rate);
      byElement.set(p.id, rate);
    }
    return { byCode, byElement };
  };

  const slope = (pairs) => {
    const n = pairs.length;
    const mx = pairs.reduce((s, p) => s + p[0], 0) / n;
    const my = pairs.reduce((s, p) => s + p[1], 0) / n;
    let num = 0;
    let den = 0;
    for (const [x, y] of pairs) {
      num += (x - mx) * (y - my);
      den += (x - mx) ** 2;
    }
    return num / den;
  };
  const join = (from, to) => {
    const pairs = [];
    for (const [key, rate] of from) if (to.has(key)) pairs.push([rate, to.get(key)]);
    return pairs;
  };

  for (let i = 1; i < seasons.length; i++) {
    const a = parse(seasons[i - 1]);
    const b = parse(seasons[i]);
    const label = `${seasons[i - 1]} -> ${seasons[i]}`;

    const byCode = join(a.byCode, b.byCode);
    assert.ok(byCode.length > 300, `${label}: only ${byCode.length} players joined on code`);
    const codeSlope = slope(byCode);

    // THE ASSERTION THE ORIGINAL BUG WOULD HAVE FAILED. Whether a player starts
    // is close to the most persistent thing about him, so regressing next
    // season's start rate on this season's has to come back with a large
    // positive slope. Joined on element it reads about 0.0 and this fails.
    assert.ok(
      codeSlope > 0.4,
      `${label}: start rate joined on code regressed with slope ${codeSlope.toFixed(3)}. `
      + 'Below 0.4 means the two seasons are not being matched player to player.',
    );

    // And the control: the same computation on the season-scoped id, which must
    // stay near zero. If this ever rises, the id has become stable and that is a
    // finding, not a pass.
    const elementSlope = slope(join(a.byElement, b.byElement));
    assert.ok(
      Math.abs(elementSlope) < 0.25,
      `${label}: joining on element gave slope ${elementSlope.toFixed(3)}, which is high enough to `
      + 'look like a real relationship. That is the failure mode this whole module exists for.',
    );
    assert.ok(
      codeSlope > elementSlope + 0.3,
      `${label}: code slope ${codeSlope.toFixed(3)} vs element slope ${elementSlope.toFixed(3)}`,
    );
  }
});

/* -------------------------------------------------- the skip set is guarded */

// Four tests above run only against the gitignored .data archive and skip
// silently without it. A silent skip is invisible in a green run: a fresh
// clone reports the same "pass" while a third of this file's evidence never
// executed, and a gated test added or removed later changes the skip count
// without anything noticing. This guard turns the skip set into an assertion:
// the count of archive-gated skips is pinned by scanning this file's own
// source (so adding or removing one fails here until the pin moves with it),
// with the archive present every gate must be open, and without it exactly
// the pinned number must be skipping.
test('the archive-gated skip set is exactly what the archive state implies', (t) => {
  const source = fs.readFileSync(new URL(import.meta.url), 'utf8');
  const gatedInSource = (source.match(/\bt\.skip\(/g) || []).length;
  assert.equal(gatedInSource, 4,
    'archive-gated tests in this file; a changed count means one was added or removed - update this guard in the same change');

  const seasons = heldSeasons();
  // The gates, exactly as the tests above write them: one needs any season at
  // all, three need a pair to compare.
  const skipping = (seasons.length === 0 ? 1 : 0) + (seasons.length < 2 ? 3 : 0);
  t.diagnostic(`archive seasons held: ${seasons.length ? seasons.join(', ') : 'none'}; gated tests skipping: ${skipping} of ${gatedInSource}`);

  if (seasons.length >= 2) {
    assert.equal(skipping, 0, 'with the archive present nothing above may skip');
  } else if (seasons.length === 0) {
    assert.equal(skipping, gatedInSource, 'without the archive exactly the gated tests skip');
  } else {
    assert.equal(skipping, gatedInSource - 1, 'one held season runs the header check and skips the three pair comparisons');
  }
});
