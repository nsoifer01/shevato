// Derives the xP calibration fixture used by tests/xp-calibration-guard.test.mjs
// from payloads captured off the public FPL API on 2026-09-16, the day the xP
// audit found every nailed starter projected to play 64% to 76% of the time.
//
// WHAT IS KEPT. The full player pool (calibration is a claim about a league, so
// nothing is trimmed) with the season totals FPL served after gameweek 4 was
// signed off, the fixture list, and the live stats of gameweeks 3 and 4 per
// player. A test takes gameweek 4's stats back out of the totals to rebuild the
// gameweek 4 deadline, and gameweek 3's as well to rebuild the gameweek 3
// deadline: the exact payloads production read, whose projections can then be
// scored against what those gameweeks actually produced.
//
//   node apps/fpl-planner/scripts/derive-calibration-fixtures.mjs <raw-dir> [out-dir]
//
// <raw-dir> holds bootstrap.json, fixtures.json, live3.json and live4.json
// (event/3/live and event/4/live). Defaults to apps/fpl-planner/tests/fixtures/
// xp-calibration-2026. Nothing here identifies a manager: all four endpoints are
// public, identical for every visitor, and carry no entry.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { META, TOTALS, pick } from './lib/fixture-fields.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RAW = process.argv[2];
const OUT = process.argv[3] || join(HERE, '..', 'tests', 'fixtures', 'xp-calibration-2026');
if (!RAW) throw new Error('pass the directory holding bootstrap.json, fixtures.json, live3.json and live4.json');

const J = (f) => JSON.parse(readFileSync(join(RAW, f), 'utf8'));
const sha = (f) => createHash('sha256').update(readFileSync(join(RAW, f))).digest('hex');
const write = (f, v) => writeFileSync(join(OUT, f), JSON.stringify(v));

// The live-endpoint stats that are also season totals on bootstrap-static, so a
// gameweek can be taken back out of the totals. Per-90 fields have no per-match
// equivalent and are not kept.
const LIVE_TOTALS = TOTALS.filter((k) => !k.endsWith('_per_90'));

function main() {
  const bootstrap = J('bootstrap.json');
  const fixtures = J('fixtures.json');
  mkdirSync(OUT, { recursive: true });

  const current = bootstrap.events.find((e) => e.is_current);
  if (!current || current.id !== 4 || !current.finished || !current.data_checked) {
    throw new Error('the bootstrap must be the one served after gameweek 4 was signed off');
  }

  write('base.json', {
    note: 'Derived from the public FPL API on 2026-09-16 by scripts/derive-calibration-fixtures.mjs. No entry data.',
    game_settings: bootstrap.game_settings,
    game_config: bootstrap.game_config,
    phases: bootstrap.phases,
    teams: bootstrap.teams,
    element_types: bootstrap.element_types,
    total_players: bootstrap.total_players,
    events: bootstrap.events.map((e) => pick(e, [
      'id', 'name', 'deadline_time', 'deadline_time_epoch', 'finished', 'data_checked',
      'is_current', 'is_next', 'is_previous', 'average_entry_score', 'highest_score',
    ])),
    elements: bootstrap.elements.map((e) => pick(e, META)),
    fixtures: fixtures.map((f) => pick(f, [
      'id', 'code', 'event', 'kickoff_time', 'team_h', 'team_a', 'team_h_difficulty', 'team_a_difficulty',
      'team_h_score', 'team_a_score', 'finished', 'finished_provisional', 'started',
    ])),
  });

  const totals = { fields: ['id', ...LIVE_TOTALS], rows: bootstrap.elements.map((e) => [e.id, ...LIVE_TOTALS.map((k) => (k in e ? e[k] : 0))]) };
  write('totals-after-gw4.json', totals);

  const manifest = {
    source: 'public FPL API, captured 2026-09-16 21:39 UTC',
    pool: bootstrap.elements.length,
    sha256: { 'bootstrap.json': sha('bootstrap.json'), 'fixtures.json': sha('fixtures.json') },
    gameweeks: [],
  };
  for (const gw of [3, 4]) {
    const file = `live${gw}.json`;
    const live = J(file);
    const rows = [];
    for (const le of live.elements) {
      if (!le.stats) continue;
      const fixtureCount = new Set((le.explain || []).map((x) => x.fixture)).size;
      if (fixtureCount > 1) throw new Error(`element ${le.id} played ${fixtureCount} GW${gw} fixtures`);
      for (const k of LIVE_TOTALS) if (!(k in le.stats)) throw new Error(`event/${gw}/live no longer carries ${k}`);
      if (!(le.stats.minutes > 0) && !(le.stats.total_points !== 0)) continue;
      rows.push([le.id, ...LIVE_TOTALS.map((k) => le.stats[k])]);
    }
    write(`live-gw${gw}.json`, { fields: ['id', ...LIVE_TOTALS], rows });
    manifest.sha256[file] = sha(file);
    manifest.gameweeks.push({ gameweek: gw, playersWithStats: rows.length });
    console.log(`gw${gw}: ${rows.length} players with stats`);
  }
  writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`wrote ${OUT}`);
}

main();
