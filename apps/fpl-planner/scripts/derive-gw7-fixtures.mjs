// Derives the GW7-2026 deadline fixture used by tests/real-deadline-gw7.test.mjs
// from payloads captured off the public FPL API on 2026-10-16, the day before
// the GW7 deadline (2026-10-17T10:00Z).
//
// WHY IT EXISTS. Every manager-state and recommendation defect of 2026/27 that
// reached the owner lived on a real manager's squad, and CI had none: one
// trimmed history, and otherwise synthetic squads and a 2026-08-10 pre-season
// capture replayed forward by hand. This is a whole-league deadline payload
// with five REAL managers beside it, each chosen for a path that has broken
// or that the 2026-10-16 audit found broken:
//
//   owner               entry 3855835: a GW4 Wildcard, a GW5 Bench Boost, one
//                       free transfer for GW7 (the 2026-10-09 count incident)
//   deep-search         three free transfers; a better three-move plan was cut
//                       before the planner ranked it (registry 47)
//   bench-boost         two free transfers and a Bench Boost plan whose
//                       same-chip alternatives printed the wrong gap
//   triple-captain-tie  a Triple Captain held on a tie, which was told a worse
//                       later week "looks better"
//   free-hit            a GW6 Free Hit: the plan must use the GW5 squad
//
// WHAT IS KEPT. The whole pool (the transfer search ranges over all of it) with
// every element field the engine reads, the full fixture list, and per manager
// only what buildSquadState reads. Identities are removed: entry ids are
// replaced, and names, regions and league data are dropped. Picks, transfers
// and history rows are kept exactly, because they ARE the test.
//
//   node apps/fpl-planner/scripts/derive-gw7-fixtures.mjs <raw-dir> [out-dir] [served] [source]
//
// `served` and `source` describe a capture other than GW7's (the GW8 one of
// 2026-10-24, tests/fixtures/gw8-2026, is derived the same way); without them
// the GW7 fixture is written exactly as before.
//
// <raw-dir> holds bootstrap-static.json, fixtures.json and
// entries/<label>/{entry,history,transfers,picks}.json (+ revert-picks.json
// for a Free Hit), each exactly as the API served it.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { META, TOTALS, pick } from './lib/fixture-fields.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RAW = process.argv[2];
const OUT = process.argv[3] || join(HERE, '..', 'tests', 'fixtures', 'gw7-2026');
const SERVED = process.argv[4] || '2026-10-16 (GW6 finished, GW7 next)';
const SOURCE = process.argv[5] || 'public FPL API, 2026-10-16 (before the GW7 deadline 2026-10-17T10:00Z)';
if (!RAW) throw new Error('usage: derive-gw7-fixtures.mjs <raw-dir> [out-dir]');

// What the engine reads beyond the lifecycle fixtures' META and TOTALS:
// prices within a gameweek, joins, loan clauses and FPL's price predictions.
const EXTRA = [
  'cost_change_event', 'team_join_date', 'scout_risks', 'ep_next',
  'price_change_percent', 'price_change_projections', 'price_change_locked_until', 'price_change_calibrating',
];
const FIXTURE_FIELDS = [
  'id', 'code', 'event', 'kickoff_time', 'team_h', 'team_a', 'team_h_difficulty', 'team_a_difficulty',
  'team_h_score', 'team_a_score', 'started', 'finished', 'finished_provisional',
];

const ELEMENT_FIELDS = [...META, ...TOTALS, ...EXTRA];

const J = (...p) => JSON.parse(readFileSync(join(RAW, ...p), 'utf8'));
const sha = (...p) => createHash('sha256').update(readFileSync(join(RAW, ...p))).digest('hex');

const bootstrap = J('bootstrap-static.json');
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'bootstrap.json'), JSON.stringify({
  note: `bootstrap-static as served on ${SERVED}, trimmed to the fields the engine reads. scripts/derive-gw7-fixtures.mjs.`,
  ...pick(bootstrap, ['events', 'game_settings', 'game_config', 'phases', 'teams', 'element_types', 'chips', 'total_players']),
  // A column table (field names once, a row per player), restored to the
  // upstream shape by tests/helpers/gw7-fixture.mjs; it halves the file.
  elements: { fields: ELEMENT_FIELDS, rows: bootstrap.elements.map((e) => ELEMENT_FIELDS.map((k) => (k in e ? e[k] : null))) },
}));
writeFileSync(join(OUT, 'fixtures.json'), JSON.stringify({
  fields: FIXTURE_FIELDS,
  rows: J('fixtures.json').map((f) => FIXTURE_FIELDS.map((k) => (k in f ? f[k] : null))),
}));

const entries = {};
let n = 0;
for (const label of readdirSync(join(RAW, 'entries')).sort()) {
  const e = J('entries', label, 'entry.json');
  const h = J('entries', label, 'history.json');
  const picks = (name) => {
    if (!existsSync(join(RAW, 'entries', label, name))) return null;
    const p = J('entries', label, name);
    return {
      active_chip: p.active_chip, automatic_subs: [],
      entry_history: pick(p.entry_history, ['event', 'points', 'total_points', 'bank', 'value', 'event_transfers', 'event_transfers_cost', 'points_on_bench']),
      picks: p.picks.map((x) => pick(x, ['element', 'position', 'multiplier', 'is_captain', 'is_vice_captain'])),
    };
  };
  entries[label] = {
    entry: {
      id: 2000001 + n++, name: `Fixture ${label}`, player_first_name: '', player_last_name: '',
      ...pick(e, ['started_event', 'summary_overall_points', 'summary_overall_rank', 'current_event']),
    },
    history: {
      current: h.current.map((r) => pick(r, ['event', 'points', 'total_points', 'bank', 'value', 'event_transfers', 'event_transfers_cost', 'points_on_bench'])),
      past: [],
      chips: (h.chips || []).map((c) => pick(c, ['name', 'event'])),
    },
    transfers: J('entries', label, 'transfers.json').map((t) => pick(t, ['element_in', 'element_in_cost', 'element_out', 'element_out_cost', 'event', 'time'])),
    picks: picks('picks.json'),
    revertPicks: picks('revert-picks.json'),
  };
}
writeFileSync(join(OUT, 'entries.json'), JSON.stringify(entries, null, 1) + '\n');
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify({
  source: SOURCE,
  derivedBy: 'scripts/derive-gw7-fixtures.mjs',
  pool: bootstrap.elements.length,
  sha256: { bootstrap: sha('bootstrap-static.json'), fixtures: sha('fixtures.json') },
  entries: Object.keys(entries),
}, null, 2) + '\n');
console.log(`wrote ${OUT}: ${bootstrap.elements.length} players, ${Object.keys(entries).length} managers`);
