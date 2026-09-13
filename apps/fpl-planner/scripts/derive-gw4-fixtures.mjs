// Derives the compact GW4-2026 match-window fixtures used by
// tests/live-match-window.test.mjs from payloads captured off the public FPL
// API on 2026-09-13, while every projection in the app had collapsed.
//
// WHAT HAPPENED. From the first kickoff of GW4 (2026-09-12 14:00 UTC), in every
// match window, the planner read the whole pool as last season's and divided
// every start rate by 38. FPL credits `starts` and `minutes` from kickoff while
// the engine only counted matches that had reached full time, so the
// ever-present starters of a live match looked as if they had started more
// matches than their club had played. See FINDINGS, "One live match read the
// whole league as last season".
//
// WHAT IS KEPT. The in-play payload exactly as FPL served it (MUN v MCI in the
// second half), the same pair at full time when it was captured, and the
// gameweek's live stats per player, so a test can rebuild EVERY kickoff window of
// the gameweek (before it, in play, and in play with a fixture list that has not
// caught up) rather than only the one that happened to be captured. The pool is
// every player with a minute plus the sixteen most expensive at each club, which
// keeps every ever-present starter the collapse turned on.
//
//   node apps/fpl-planner/scripts/derive-gw4-fixtures.mjs [raw-dir] [out-dir]
//
// Defaults to ~/fpl-gw4-evidence/raw and apps/fpl-planner/tests/fixtures/gw4-2026.
// Nothing here identifies a manager: bootstrap-static, fixtures and
// event/{gw}/live are public, identical for every visitor, and carry no entry.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { META, TOTALS, pick } from './lib/fixture-fields.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RAW = process.argv[2] || join(homedir(), 'fpl-gw4-evidence', 'raw');
const OUT = process.argv[3] || join(HERE, '..', 'tests', 'fixtures', 'gw4-2026');
const GW = 4;

// [name, bootstrap, fixtures, event live, what it is]
const STATES = [
  ['in-play',
    'bootstrap-inplay-mun-mci-20260913T1627Z.json',
    'fixtures-inplay-mun-mci-20260913T1627Z.json',
    'event4-live-20260913T1630Z.json',
    'MUN v MCI in play (kickoff 15:30 UTC), served at 16:27 UTC: the payload whose best eleven projected 6.4'],
  ['full-time',
    'bootstrap-ft-mun-mci.json',
    'fixtures-ft-mun-mci.json',
    'event4-live-ft-mun-mci.json',
    'the same three endpoints once MUN v MCI reached provisional full time'],
];

// The live-endpoint stats that are also season totals on bootstrap-static, so
// one match can be taken back out of the totals to rebuild an earlier window.
// The per-90 fields have no per-match equivalent and are left as captured.
const LIVE_TOTALS = TOTALS.filter((k) => !k.endsWith('_per_90'));

const J = (f) => JSON.parse(readFileSync(join(RAW, f), 'utf8'));
const has = (f) => existsSync(join(RAW, f));
const sha = (f) => createHash('sha256').update(readFileSync(join(RAW, f))).digest('hex');
const write = (f, v) => writeFileSync(join(OUT, f), JSON.stringify(v));

function main() {
  const available = STATES.filter(([, bs, fx, lv]) => has(bs) && has(fx) && has(lv));
  if (!available.some(([name]) => name === 'in-play')) {
    throw new Error(`the in-play capture is not in ${RAW}`);
  }
  mkdirSync(OUT, { recursive: true });

  const first = J(available[0][1]);

  // Every player with a minute in ANY captured state, plus the sixteen most
  // expensive per club so each club still fields a squad.
  const keep = new Set();
  for (const [, bs] of available) {
    for (const e of J(bs).elements) if ((e.minutes || 0) > 0) keep.add(e.id);
  }
  const byTeam = new Map();
  for (const e of first.elements) {
    const arr = byTeam.get(e.team) || []; arr.push(e); byTeam.set(e.team, arr);
  }
  for (const [, arr] of byTeam) {
    arr.sort((a, b) => b.now_cost - a.now_cost);
    for (const e of arr.slice(0, 16)) keep.add(e.id);
  }
  const kept = first.elements.filter((e) => keep.has(e.id));

  write('base.json', {
    note: 'Derived from the public FPL API on 2026-09-13 by scripts/derive-gw4-fixtures.mjs. No entry data.',
    game_settings: first.game_settings,
    game_config: first.game_config,
    phases: first.phases,
    teams: first.teams,
    element_types: first.element_types,
    total_players: first.total_players,
    elements: kept.map((e) => pick(e, META)),
    fixtures: J(available[0][2]).map((f) => pick(f, [
      'id', 'code', 'event', 'kickoff_time', 'team_h', 'team_a',
      'team_h_difficulty', 'team_a_difficulty', 'team_h_score', 'team_a_score',
    ])),
  });

  const manifest = { source: 'public FPL API, 2026-09-13', gameweek: GW, pool: kept.length, states: [] };

  for (const [name, bs, fx, lv, what] of available) {
    const b = J(bs);
    const byId = new Map(b.elements.map((e) => [e.id, e]));
    const totals = { fields: ['id', ...TOTALS], rows: [] };
    for (const e of kept) {
      const row = byId.get(e.id);
      if (!row) continue;
      totals.rows.push([e.id, ...TOTALS.map((k) => (k in row ? row[k] : 0))]);
    }

    // Fixture flags move between states, and so does the score of a match that
    // was in play when one of them was captured.
    const phases = {};
    const scores = {};
    for (const f of J(fx)) {
      if (!(f.started || f.finished || f.finished_provisional)) continue;
      phases[f.id] = { s: !!f.started, f: !!f.finished, p: !!f.finished_provisional };
      scores[f.id] = [f.team_h_score, f.team_a_score];
    }

    const live = { fields: ['id', 'fixture', ...LIVE_TOTALS], rows: [] };
    for (const le of J(lv).elements) {
      if (!keep.has(le.id) || !le.stats || !(le.stats.minutes > 0)) continue;
      const fixtures = [...new Set((le.explain || []).map((x) => x.fixture))];
      if (fixtures.length !== 1) {
        throw new Error(`element ${le.id} played ${fixtures.length} GW${GW} fixtures: `
          + 'a double gameweek cannot be taken apart from gameweek totals');
      }
      for (const k of LIVE_TOTALS) {
        if (!(k in le.stats)) throw new Error(`event/${GW}/live no longer carries ${k}`);
      }
      live.rows.push([le.id, fixtures[0], ...LIVE_TOTALS.map((k) => le.stats[k])]);
    }

    write(`${name}.json`, { events: b.events, totals, fixturePhases: phases, scores, live });
    const minutesAt = totals.fields.indexOf('minutes');
    const withMinutes = totals.rows.filter((r) => (r[minutesAt] || 0) > 0).length;
    manifest.states.push({
      name,
      what,
      withMinutes,
      startedFixtures: Object.keys(phases).length,
      livePlayers: live.rows.length,
      sha256: { [bs]: sha(bs), [fx]: sha(fx), [lv]: sha(lv) },
    });
    console.log(`${name}: ${withMinutes}/${kept.length} with minutes, `
      + `${Object.keys(phases).length} fixtures started, ${live.rows.length} live rows`);
  }

  writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`\nwrote ${OUT}`);
}

main();
