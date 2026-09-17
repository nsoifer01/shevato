// Historical replay: run whole seasons through the real planner and score the
// result against what actually happened.
//
// This is the only honest answer to "does any of this work", and it is the
// strongest leakage detector available. A model that reads a single post
// deadline number looks brilliant here and nowhere else, so the state handed to
// the planner at gameweek G is rebuilt from rows strictly before G: season
// totals, form, minutes, team results and fixture outcomes all stop at G-1.
// The two exceptions are deliberate and documented, because both are genuinely
// known before the deadline: the fixture CALENDAR for the whole season, and
// each player's PRICE and OWNERSHIP in gameweek G, which lock when the deadline
// passes.
//
// The dataset is the public per gameweek archive downloaded by
// scripts/fetch-history.mjs (one merged_gw.csv per season). It is gitignored on
// purpose. The unit tests never touch it: they generate a small synthetic
// season in the same CSV shape and run the identical code path.
//
// WHAT IS MEASURED
//
//   season points, mean gameweek points
//   points above three baselines (hold, single gameweek expected points, naive
//     fixture difficulty), all replayed through the same optimizer so the only
//     difference is the decision rule
//   captaincy value, against the average starter in the same eleven
//   hit efficiency, against what the sold and bought players actually did
//   chip value, against holding the pre chip squad
//
// WHAT IS APPROXIMATE, STATED PLAINLY
//
//   Price changes are replayed from the archive's own `value` column, so a
//   squad's value tracks reality, but the exact tenth a player was bought at in
//   a historical manager's team is not recoverable and is not claimed.
//   Chip value for the wildcard and free hit is measured against holding the
//   pre chip squad with no further transfers over the chip's window, which is a
//   counterfactual, not an observation.

import { sellingPrice, chipAvailableAt } from './rules.js';
import { initialTransferState, advance, freeTransfersFor } from './transfer-state.js';
import { buildStrength } from './strength.js';
import { buildProjections, defConComposite } from './projections.js';
import { optimizeLineup } from './lineup.js';
import { chooseCaptain } from './captain.js';
import { buildPlan, PLANNER_PARAMS } from './planner.js';
import { fixturesForTeam } from './fixtures.js';
import { normalizeName, resolveSeasonPair } from './player-identity.js';
import { buildGameState } from './normalize.js';
import { OPENING_BASELINE_KIND, SNAPSHOT_VERSION } from './baseline.js';
import { openingBaselineApplies, resolveGameState } from './world.js';

// Re-exported because the availability join below is built on it and
// tests/availability.test.mjs pins its behaviour. There is one implementation,
// in player-identity.js, so the folding used by the within-season availability
// join and the cross-season identity join cannot drift apart.
export { normalizeName };

export const BACKTEST_VERSION = 'backtest-1';

// A replay with no explicit horizon runs the horizon the app ships with, so
// "what does the planner score" and "what does a user get" are the same
// question. planner.js owns the number and the evidence for it.
const DEFAULT_HORIZON = PLANNER_PARAMS.defaultHorizon;

// Players projected each gameweek. The full pool is around 700 rows, most of
// them unownable, and projecting all of them multiplies the replay cost by
// three for no decision change. The pool is the most owned players at the
// deadline (public, pre deadline information) plus everyone already in the
// squad, and it is identical for every strategy so no baseline is handicapped.
const DEFAULT_POOL_SIZE = 260;

// How many gameweeks forward a hit is credited with when measuring whether it
// paid for itself.
const HIT_MEASURE_GWS = 5;

// Weight on the previous season's totals when seeding a player's rates at the
// start of a replayed season. FPL itself carries last season's numbers into the
// new one, which is exactly the state this app faces every August.
const PRIOR_SEASON_WEIGHT = 0.5;

export const BACKTEST_PARAMS = Object.freeze({
  defaultPoolSize: DEFAULT_POOL_SIZE,
  hitMeasureGws: HIT_MEASURE_GWS,
  priorSeasonWeight: PRIOR_SEASON_WEIGHT,
});

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

// Player names in this archive contain commas and quotes often enough that a
// split on "," silently drops rows, which would quietly shrink the dataset.
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    if (row.length > 1 || row[0] !== '') rows.push(row);
  }
  const header = rows.shift() || [];
  return { header, rows };
}

const POSITION_IDS = { GK: 1, GKP: 1, DEF: 2, MID: 3, FWD: 4 };

const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

export function parseMergedGw(text) {
  const { header, rows } = parseCsv(text);
  const idx = {};
  header.forEach((h, i) => { idx[h.trim()] = i; });

  const out = [];
  for (const r of rows) {
    // Assistant managers are an element type this planner does not select, so
    // they are dropped rather than projected as outfield players.
    const position = POSITION_IDS[(r[idx.position] || '').trim()];
    if (!position) continue;
    const gw = num(r[idx.GW]);
    if (!gw) continue;

    out.push({
      gw,
      playerId: num(r[idx.element]),
      name: r[idx.name],
      position,
      teamName: r[idx.team],
      opponentTeam: num(r[idx.opponent_team]),
      fixtureId: num(r[idx.fixture]),
      wasHome: String(r[idx.was_home]).toLowerCase() === 'true',
      kickoff: r[idx.kickoff_time] || null,
      minutes: num(r[idx.minutes]),
      starts: num(r[idx.starts]),
      totalPoints: num(r[idx.total_points]),
      valueTenths: num(r[idx.value]),
      selected: num(r[idx.selected]),
      bonus: num(r[idx.bonus]),
      bps: num(r[idx.bps]),
      saves: num(r[idx.saves]),
      goalsScored: num(r[idx.goals_scored]),
      assists: num(r[idx.assists]),
      cleanSheets: num(r[idx.clean_sheets]),
      goalsConceded: num(r[idx.goals_conceded]),
      yellowCards: num(r[idx.yellow_cards]),
      redCards: num(r[idx.red_cards]),
      ownGoals: num(r[idx.own_goals]),
      penaltiesSaved: num(r[idx.penalties_saved]),
      penaltiesMissed: num(r[idx.penalties_missed]),
      // Present only from 2025-26, the season the stat was introduced. Absent
      // columns parse to zero, which is what every earlier season needs.
      cbit: num(r[idx.clearances_blocks_interceptions]),
      recoveries: num(r[idx.recoveries]),
      tackles: num(r[idx.tackles]),
      xG: num(r[idx.expected_goals]),
      xA: num(r[idx.expected_assists]),
      xGC: num(r[idx.expected_goals_conceded]),
      teamHScore: num(r[idx.team_h_score]),
      teamAScore: num(r[idx.team_a_score]),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The missing starts column
//
// FPL added `starts` to its per-gameweek payload PART WAY THROUGH 2022-23. The
// archive faithfully reproduces that: the column is exactly zero for gameweeks
// 1 to 15 of that season and correct from 16 on. Measured across the whole
// archive, sum(starts) is 8360 in 2023-24, 2024-25 and 2025-26, which is
// exactly 11 starters x 2 clubs x 380 fixtures, and 5368 in 2022-23.
//
// Left alone this is not a small data gap, it is a MODEL INVERSION. With
// starts pinned at zero, minutes.js reads every player's observed start rate as
// zero, infers that all his minutes were substitute minutes, and hands back
// pStart 0 with pAppear near 1: a whole league of substitutes who play about 68
// minutes each. Clean sheets and the 60-minute appearance point fall out with
// it, and the replay of 2022-23 under-projects by 16 points a gameweek. Two of
// the nine chip-free windows and six of the 45 paired trajectories are inside
// that stretch, so a third of the evidence behind every verdict in
// experiments/registry.md was measured on it.
//
// THE RECONSTRUCTION. Exactly eleven players start a fixture for a club, and a
// starter almost always outlasts a substitute, so the eleven with the most
// minutes in a club's fixture are its starting eleven. That is a claim about
// football, so it was checked against the two seasons that carry the truth:
//
//   2023-24   98.66% of rows correct, 199 false starts, 199 missed starts
//   2024-25   98.64% of rows correct, 188 false starts, 188 missed starts
//
// The errors are one player in about a fifth of team-fixtures, always a pair:
// a starter withdrawn early swapped with a substitute brought on early. The
// COUNT is exact by construction, so aggregate start rates carry no error at
// all, and a per-player rate is wrong by at most a match or two a season.
//
// A rule that forced every player over 60 minutes to be a starter and then
// filled up to eleven scored identically, so the simpler rule ships.
//
// This runs ONLY where the column is absent, detected per gameweek: a gameweek
// with minutes on the board and no starts anywhere cannot have happened. Real
// data is never overwritten.
// ---------------------------------------------------------------------------

const STARTERS_PER_FIXTURE = 11;

export function reconstructStarts(rows) {
  const byGw = new Map();
  for (const r of rows) {
    if (!byGw.has(r.gw)) byGw.set(r.gw, { starts: 0, played: 0, rows: [] });
    const entry = byGw.get(r.gw);
    entry.starts += r.starts;
    if (r.minutes > 0) entry.played++;
    entry.rows.push(r);
  }

  const gameweeks = [];
  let filled = 0;
  for (const [gw, entry] of [...byGw.entries()].sort((a, b) => a[0] - b[0])) {
    if (entry.starts > 0 || entry.played === 0) continue;
    gameweeks.push(gw);

    const sides = new Map();
    for (const r of entry.rows) {
      const key = `${r.fixtureId}|${r.teamName}`;
      if (!sides.has(key)) sides.set(key, []);
      sides.get(key).push(r);
    }
    for (const side of sides.values()) {
      // Descending minutes, then player id, so the reconstruction is
      // deterministic and a rerun cannot produce a different season.
      side.sort((a, b) => b.minutes - a.minutes || a.playerId - b.playerId);
      for (let i = 0; i < side.length && i < STARTERS_PER_FIXTURE; i++) {
        if (side[i].minutes <= 0) break;
        side[i].starts = 1;
        filled++;
      }
    }
  }
  return { gameweeks, rows: filled };
}

// ---------------------------------------------------------------------------
// Expected-data coverage
//
// The same 2022-23 payload change that introduced `starts` mid-season also
// introduced expected_goals, expected_assists and expected_goals_conceded: all
// three are exactly zero for gameweeks 1 to 15 of that season and populated
// from 16 on. Unlike starts, xG cannot be reconstructed from anything else in
// the archive, so the honest treatment is the numerator-denominator rule again:
// a per-90 xG rate may only be divided by the minutes its numerator actually
// covers. Every row is therefore flagged with whether its gameweek carried the
// columns, the accumulator keeps a separate `xMinutes` total from flagged rows,
// and the rate layer reads xG and xA over THAT denominator with its own
// evidence weight. A player whose whole record predates the columns has real
// minutes and zero xG evidence, and comes out as the shrinkage prior rather
// than as a player who never threatens a goal.
//
// Detection is per gameweek: a round of real football cannot produce a
// league-wide expected-goals sum of exactly zero, so a gameweek with minutes on
// the board and no expected data at all did not have the columns.
// ---------------------------------------------------------------------------

// Same rule, third component family: defensive-contribution columns exist only
// from 2025-26, so rows seeded from an earlier prior season carry minutes with
// no defcon data, and a rate divided by ALL minutes understates a returning
// player's within-season rate by the seeded share (measured: a defender's true
// 14-per-90 composite read 8.3 with the prior seeded, the difference between
// clearing the 10-action threshold and projecting nothing). A played gameweek
// whose league-wide composite sums to zero did not carry the columns.
export function flagDefConData(rows) {
  const byGw = new Map();
  for (const r of rows) {
    const entry = byGw.get(r.gw) || { defcon: 0, minutes: 0 };
    entry.defcon += (r.cbit || 0) + (r.recoveries || 0) + (r.tackles || 0);
    entry.minutes += r.minutes;
    byGw.set(r.gw, entry);
  }
  const uncovered = [];
  for (const [gw, entry] of [...byGw.entries()].sort((a, b) => a[0] - b[0])) {
    if (entry.minutes > 0 && entry.defcon === 0) uncovered.push(gw);
  }
  const uncoveredSet = new Set(uncovered);
  for (const r of rows) r.hasDefConData = !uncoveredSet.has(r.gw);
  return { uncovered };
}

export function flagExpectedData(rows) {
  const byGw = new Map();
  for (const r of rows) {
    const entry = byGw.get(r.gw) || { expected: 0, minutes: 0 };
    entry.expected += r.xG + r.xA + r.xGC;
    entry.minutes += r.minutes;
    byGw.set(r.gw, entry);
  }
  const uncovered = [];
  for (const [gw, entry] of [...byGw.entries()].sort((a, b) => a[0] - b[0])) {
    if (entry.minutes > 0 && entry.expected === 0) uncovered.push(gw);
  }
  const uncoveredSet = new Set(uncovered);
  for (const r of rows) r.hasExpectedData = !uncoveredSet.has(r.gw);
  return { uncovered };
}

// ---------------------------------------------------------------------------
// Dataset
// ---------------------------------------------------------------------------

// `identity` is a season identity index from player-identity.js, or null. It is
// the ONLY thing that gives a player a canonical `code`, and without it every
// player carries code null, which is what makes a cross-season join degrade to
// name matching rather than silently key on the season-scoped element id.
export function buildDataset({ csv, rows, season, identity = null }) {
  // A player plays a given fixture at most once, in any season, so a second
  // row with the same (gameweek, player, fixture) key is a duplicated record
  // and never football. The 2025-26 archive carries ten byte-identical ones
  // (0.011%; one player's rows doubled across gameweeks 1-9), and an undropped
  // duplicate double-counts the player's ACTUAL points when scoring a replayed
  // squad as well as his accumulated evidence. Distinct fixture ids in one
  // gameweek are DOUBLE GAMEWEEKS and pass through untouched; the key includes
  // the fixture id precisely so they cannot be confused.
  const raw = rows || parseMergedGw(csv);
  const seen = new Set();
  const parsed = [];
  let duplicateRows = 0;
  for (const r of raw) {
    const key = `${r.gw}|${r.playerId}|${r.fixtureId}`;
    if (seen.has(key)) { duplicateRows++; continue; }
    seen.add(key);
    parsed.push(r);
  }
  const startsFilled = reconstructStarts(parsed);
  const expectedCoverage = flagExpectedData(parsed);
  const defConCoverage = flagDefConData(parsed);

  const byGw = new Map();
  const byFixture = new Map();
  const playerRows = new Map();
  let maxGw = 0;

  for (const r of parsed) {
    if (r.gw > maxGw) maxGw = r.gw;
    if (!byGw.has(r.gw)) byGw.set(r.gw, new Map());
    const gwMap = byGw.get(r.gw);
    if (!gwMap.has(r.playerId)) gwMap.set(r.playerId, []);
    gwMap.get(r.playerId).push(r);

    if (!byFixture.has(r.fixtureId)) byFixture.set(r.fixtureId, []);
    byFixture.get(r.fixtureId).push(r);

    if (!playerRows.has(r.playerId)) playerRows.set(r.playerId, []);
    playerRows.get(r.playerId).push(r);
  }

  // Team ids. The archive gives each row its own club by NAME and the opponent
  // by ID, so a club's id is recovered from the other side of a fixture it
  // played in.
  const nameToId = new Map();
  const fixtures = [];
  for (const [fixtureId, rowsForFixture] of byFixture) {
    const home = rowsForFixture.find(r => r.wasHome);
    const away = rowsForFixture.find(r => !r.wasHome);
    if (!home || !away) continue;
    const homeId = away.opponentTeam;
    const awayId = home.opponentTeam;
    if (homeId) nameToId.set(home.teamName, homeId);
    if (awayId) nameToId.set(away.teamName, awayId);
    fixtures.push({
      id: fixtureId,
      code: fixtureId,
      event: home.gw,
      kickoff: home.kickoff,
      teamH: homeId,
      teamA: awayId,
      teamHDifficulty: null,
      teamADifficulty: null,
      finished: true,
      started: true,
      teamHScore: home.teamHScore,
      teamAScore: home.teamAScore,
    });
  }
  fixtures.sort((a, b) => a.event - b.event || a.id - b.id);

  const teams = new Map();
  for (const [name, id] of nameToId) {
    teams.set(id, {
      id,
      code: id,
      name,
      shortName: name.slice(0, 3).toUpperCase(),
      // The archive carries no strength table, so every club starts neutral and
      // the strength model earns its ratings from results, which is what it is
      // built to do once matches exist.
      strengthOverallHome: 3,
      strengthOverallAway: 3,
    });
  }

  const players = new Map();
  let coded = 0;
  for (const [id, list] of playerRows) {
    list.sort((a, b) => a.gw - b.gw);
    const last = list[list.length - 1];
    // NEVER `code: id`. The element id is this season's row number and calling
    // it a code is how a season-scoped value ends up in a field whose whole
    // meaning is that it is permanent. Absent an identity table it is null, and
    // anything that needs a canonical id says so and fails.
    const code = identity ? identity.codeByElement.get(id) ?? null : null;
    if (code !== null) coded++;
    players.set(id, {
      id,
      code,
      name: last.name,
      position: last.position,
      teamName: last.teamName,
      teamId: nameToId.get(last.teamName) || null,
      rows: list,
    });
  }

  return {
    season,
    maxGw,
    byGw,
    players,
    teams,
    fixtures,
    nameToId,
    rows: parsed,
    identity: identity ? { season: identity.season, coded, of: players.size } : null,
    // Which gameweeks had no starts column and were reconstructed, so a report
    // can say so rather than leave a reader to assume the archive was complete.
    startsReconstructed: startsFilled.gameweeks.length ? startsFilled : null,
    // Gameweeks with no expected_* columns (2022-23 gw1-15). Their minutes are
    // excluded from the xG/xA denominator rather than reconstructed.
    expectedDataMissing: expectedCoverage.uncovered.length ? expectedCoverage.uncovered : null,
    // Byte-duplicate rows dropped at load (same gameweek, player AND fixture).
    duplicateRowsDropped: duplicateRows,
    defConDataMissing: defConCoverage.uncovered.length ? defConCoverage.uncovered : null,
  };
}

// ---------------------------------------------------------------------------
// Availability
//
// THE PROBLEM THIS SOLVES. The archive records what a player DID and never what
// was KNOWN about him beforehand: there is no status column and no chance of
// playing. Until this existed the replay handed every player `status: 'a'` and
// `chanceNext: null`, so the planner believed a squad of fifteen was fit every
// week of the season, kept captaining players who had been in a boot for a
// month, and no availability work could be measured at all.
//
// The signal comes from API-Football's injury list for the season, downloaded
// by scripts/fetch-availability.mjs. Each record is a player NAME, a club NAME,
// a type ("Missing Fixture" or "Questionable"), a reason and the KICKOFF of the
// fixture it was attached to.
//
// THE LEAKAGE RULE, and it is the whole game here.
//
//   A record may inform gameweek N only if its fixture kicked off strictly
//   before the gameweek N deadline. Nothing else is admissible.
//
// A record whose fixture is IN gameweek N is a team-sheet leak wearing a
// timestamp: it was published after the deadline this planner has to decide at,
// and in the naive form it would tell the replay exactly who was about to miss
// the match it is picking a team for. Because the replay's deadline for
// gameweek N is the earliest kickoff in gameweek N, "kickoff strictly before
// the deadline" means "belongs to an earlier gameweek", which is the rule in
// one sentence. leakageBoundaryMs() and the tests around it exist to keep it
// there.
//
// WHAT THE REPLAY THEREFORE KNOWS. Only the retrospective fact a human also
// had: this player was listed as unavailable for his club's last match, and did
// not play in it. It does NOT know this week's team news, this week's press
// conference, or that the player is back in training. A player who returns is
// invisible to the signal until his return has actually happened.
//
// TURNING THAT INTO A NUMBER. "He missed the last L matches" becomes a
// probability by asking the data how often such a spell continues, estimated
// ONLINE: the continuation rate used at gameweek N is measured only from spells
// whose outcome was already observable before the gameweek N deadline. Early in
// a season that is almost no evidence, so the estimate is a Beta-style blend
// with a documented prior that the data washes out as the season runs. The
// result is written into `chanceNext`, which minutes.js already treats as a
// hard ceiling on the chance of appearing.
// ---------------------------------------------------------------------------

// API-Football names a season by the calendar year it starts in, so an FPL
// label of the form YYYY-YY answers the question itself and no season table is
// needed. Anything else, including the synthetic labels the tests replay, has
// no availability file and never goes looking for one.
export function availabilitySeasonYear(label) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(label || ''));
  return m ? Number(m[1]) : null;
}

// The two sources spell four clubs differently and agree on the other sixteen,
// in all three seasons.
const TEAM_ALIASES = new Map([
  ['manchester city', 'man city'],
  ['manchester united', 'man utd'],
  ['nottingham forest', 'nottm forest'],
  ['tottenham', 'spurs'],
]);

// A record is tied to its fixture by kickoff, and the two sources can disagree
// by a few minutes on a rearranged match. Six hours is far wider than any such
// disagreement and far narrower than the gap between two matches of the same
// club, so it cannot pull in the wrong fixture.
const KICKOFF_TOLERANCE_MS = 6 * 60 * 60 * 1000;

// The online continuation estimate is a blend of what the season has shown so
// far and a prior. The weight is in units of observed spells: after 25 of them
// the data carries half the answer, which is somewhere around gameweek 4.
const CONTINUATION_PRIOR_WEIGHT = 25;
const CONTINUATION_PRIOR = Object.freeze({ missing: 0.72, questionable: 0.45 });

// Availability is never allowed all the way to 0 or 1. A player carrying a
// listed injury is never a certainty either way, and a hard 0 would let the
// planner treat a guess as a fact.
const MIN_AVAILABILITY = 0.03;
const MAX_AVAILABILITY = 0.97;

// The start rate above which a player counts as first choice, which is the
// dimension the continuation estimate is conditioned on. See roleBucket below.
const NAILED_START_RATE = 0.5;

export const AVAILABILITY_PARAMS = Object.freeze({
  kickoffToleranceMs: KICKOFF_TOLERANCE_MS,
  continuationPriorWeight: CONTINUATION_PRIOR_WEIGHT,
  continuationPrior: CONTINUATION_PRIOR,
  minAvailability: MIN_AVAILABILITY,
  maxAvailability: MAX_AVAILABILITY,
  nailedStartRate: NAILED_START_RATE,
});

export function normalizeTeamName(name) {
  const n = normalizeName(name).replace(/\./g, '');
  return TEAM_ALIASES.get(n) || n;
}

// "A. S. Lokonga" is an initial-form name; "Gabriel Fernando de Jesus" is not.
// Splitting them apart is what lets the two spellings of one player meet.
function parseName(name) {
  const tokens = normalizeName(name).split(' ').filter(Boolean);
  const initials = [];
  const words = [];
  for (const token of tokens) {
    const bare = token.replace(/\./g, '');
    if (!bare) continue;
    if (bare.length === 1 && token.includes('.')) initials.push(bare);
    else words.push(bare);
  }
  // A double barrelled name is one token to one source and two to the other:
  // "Dominic Solanke-Mitchell" has to be reachable from "D. Solanke". Both
  // halves are kept alongside the joined form rather than instead of it.
  const parts = [];
  for (const word of words) {
    if (!word.includes('-')) continue;
    for (const half of word.split('-')) if (half) parts.push(half);
  }
  return { initials, words, tokens: [...words, ...parts], full: words.join(' ') };
}

// Name particles carry no identifying information, so the loosest rung is not
// allowed to match on one. Without this, every Brazilian "da Silva" in a club
// answers to every other.
const PARTICLES = new Set(['de', 'da', 'do', 'dos', 'das', 'du', 'del', 'della', 'di',
  'van', 'von', 'der', 'den', 'ter', 'la', 'le', 'el', 'al', 'bin', 'ben', 'junior', 'jr', 'santos']);

// Does "A. S. Lokonga" fit "Albert Sambi Lokonga"? The surname has to be one of
// the tokens, and every initial has to open one of the OTHER tokens, in order.
// Requiring order is what stops "S. A. Lokonga" matching the same man.
function surnameInitialsMatch(parsed, surname, tokens) {
  const at = tokens.indexOf(surname);
  if (at === -1) return false;
  const others = tokens.filter((_, i) => i !== at);
  let i = 0;
  for (const token of others) {
    if (i < parsed.initials.length && token[0] === parsed.initials[i]) i++;
  }
  return i === parsed.initials.length;
}

const UNMATCHED_SAMPLE_SIZE = 12;

// Join API-Football names to FPL element ids.
//
// Every rung is constrained to the club, every rung requires a UNIQUE
// candidate, and a name that two players could answer to is left unmatched
// rather than guessed at. That asymmetry is deliberate: an unmatched player
// falls back to the old behaviour of being assumed fit, which is the error the
// replay already had, while a wrong match invents an injury for a fit player
// and makes the planner sell him.
export function joinAvailability(dataset, records) {
  const byClub = new Map();
  for (const player of dataset.players.values()) {
    const parsed = parseName(player.name);
    const entry = { id: player.id, tokens: parsed.tokens, last: parsed.words[parsed.words.length - 1], full: parsed.full };
    for (const club of new Set(player.rows.map(r => normalizeTeamName(r.teamName)))) {
      if (!byClub.has(club)) byClub.set(club, []);
      byClub.get(club).push(entry);
    }
  }
  for (const list of byClub.values()) list.sort((a, b) => a.id - b.id);

  const groups = new Map();
  for (const record of records) {
    const club = normalizeTeamName(record.teamName);
    const key = `${club}|${normalizeName(record.playerName)}`;
    if (!groups.has(key)) {
      groups.set(key, { club, name: record.playerName, team: record.teamName, records: [] });
    }
    groups.get(key).records.push(record);
  }

  const byPlayer = new Map();
  const byMethod = { exact: 0, initials: 0, tokens: 0, surname: 0, token: 0 };
  const unmatched = [];
  let matchedRecords = 0;
  let matchedNames = 0;
  let ambiguous = 0;

  for (const key of [...groups.keys()].sort()) {
    const group = groups.get(key);
    const candidates = byClub.get(group.club) || [];
    const parsed = parseName(group.name);
    const surname = parsed.words[parsed.words.length - 1];
    const hit = matchOne(parsed, surname, candidates);

    if (hit.playerId === null) {
      if (hit.ambiguous) ambiguous++;
      unmatched.push({ name: group.name, team: group.team, records: group.records.length, reason: hit.reason });
      continue;
    }
    matchedNames++;
    matchedRecords += group.records.length;
    byMethod[hit.method]++;
    if (!byPlayer.has(hit.playerId)) byPlayer.set(hit.playerId, []);
    byPlayer.get(hit.playerId).push(...group.records);
  }

  for (const list of byPlayer.values()) {
    list.sort((a, b) => (a.fixtureDate < b.fixtureDate ? -1 : a.fixtureDate > b.fixtureDate ? 1 : 0));
  }

  unmatched.sort((a, b) => b.records - a.records || (a.name < b.name ? -1 : 1));

  return {
    byPlayer,
    stats: {
      records: records.length,
      names: groups.size,
      matchedNames,
      matchedRecords,
      byMethod,
      ambiguous,
      unmatched: unmatched.length,
      unmatchedSample: unmatched.slice(0, UNMATCHED_SAMPLE_SIZE),
    },
  };
}

function matchOne(parsed, surname, candidates) {
  if (!surname || !candidates.length) return { playerId: null, ambiguous: false, reason: 'no-club-candidates' };

  // The archive carries full legal names, the API carries the name on the
  // shirt, and the two disagree in three repeatable ways: a maternal surname
  // trails the one everybody uses ("Marc Cucurella Saseta" for "M.
  // Cucurella"), the family name comes first ("Tomiyasu Takehiro" for "T.
  // Tomiyasu"), or the shirt name is a nickname the legal name never contains
  // ("Diogo Jota" for "Diogo Teixeira da Silva"). So the surname is looked for
  // ANYWHERE in the name rather than at the end, and the last rung will accept
  // a single distinctive given name. Every rung still demands a unique
  // candidate inside the club, which is what keeps that from guessing.
  const rungs = [
    ['exact', c => c.full === parsed.full],
    ['initials', c => parsed.initials.length > 0 && surnameInitialsMatch(parsed, surname, c.tokens)],
    ['tokens', c => parsed.initials.length === 0 && parsed.words.every(w => c.tokens.includes(w))],
    ['surname', c => c.last === surname],
    ['token', c => parsed.words.some(w => !PARTICLES.has(w) && c.tokens.includes(w))],
  ];

  for (const [method, test] of rungs) {
    const hits = candidates.filter(test);
    if (hits.length === 1) return { playerId: hits[0].id, method, ambiguous: false, reason: null };
    // Two players in one club could answer to this name. Guessing between them
    // would invent an injury for whichever one is fit.
    if (hits.length > 1) return { playerId: null, ambiguous: true, reason: `ambiguous-${method}` };
  }
  return { playerId: null, ambiguous: false, reason: 'no-match' };
}

// The moment after which nothing may be read for gameweek `gw`: the earliest
// kickoff of that gameweek. The real deadline is ninety minutes earlier still,
// so this is the LATEST defensible boundary, and it is the one the rest of the
// replay already uses for its own event deadlines.
export function leakageBoundaryMs(dataset, gw) {
  let earliest = null;
  for (const f of dataset.fixtures) {
    if (f.event !== gw || !f.kickoff) continue;
    const t = Date.parse(f.kickoff);
    if (!Number.isFinite(t)) continue;
    if (earliest === null || t < earliest) earliest = t;
  }
  return earliest;
}

const continuationBucket = (run) => (run >= 5 ? '5+' : run >= 3 ? '3-4' : String(run));
const recordType = (type) => (String(type).toLowerCase().startsWith('question') ? 'questionable' : 'missing');

// A spell means something different to a first choice player than to a squad
// filler, and pooling them punishes exactly the players a manager most wants to
// keep. Measured across all three seasons, a first choice player listed for one
// match plays the next one about 37 to 40 per cent of the time; a fringe player
// in the same position plays about 11 to 15 per cent of the time. Without this
// split every flagged player gets the pooled number, which is dragged down by a
// long tail of squad players who were never going to feature anyway.
const roleBucket = (startRate) => (startRate >= NAILED_START_RATE ? 'first-choice' : 'squad');
const bucketKey = (type, run, role) => `${type}|${continuationBucket(run)}|${role}`;

// An immutable index: every gameweek's answer is computed once, from records
// and outcomes that were already visible at that gameweek's boundary, so the
// four strategies of a replay all read the same numbers and no strategy can
// advance the clock for another.
export function buildAvailabilityIndex(dataset, records) {
  const join = joinAvailability(dataset, records);

  const boundaries = new Map();
  for (let gw = 1; gw <= dataset.maxGw; gw++) {
    const b = leakageBoundaryMs(dataset, gw);
    if (b !== null) boundaries.set(gw, b);
  }

  // Per player: his club's fixtures in kickoff order, each carrying whether he
  // was LISTED for it and whether he actually played in it. "Absent" needs
  // both: a player listed as questionable who then played ninety minutes was
  // available, and the archive says so.
  const timelines = new Map();
  const transitions = [];
  for (const [playerId, recs] of join.byPlayer) {
    const player = dataset.players.get(playerId);
    if (!player) continue;
    const stamped = recs
      .map(r => ({ at: Date.parse(r.fixtureDate), type: recordType(r.type), reason: r.reason }))
      .filter(r => Number.isFinite(r.at));

    const entries = player.rows
      .map(row => ({ gw: row.gw, at: Date.parse(row.kickoff), minutes: row.minutes, starts: row.starts }))
      .filter(e => Number.isFinite(e.at))
      .sort((a, b) => a.at - b.at);

    let run = 0;
    let startsSoFar = 0;
    let playedSoFar = 0;
    for (const entry of entries) {
      const listed = stamped.find(r => Math.abs(r.at - entry.at) <= KICKOFF_TOLERANCE_MS) || null;
      entry.listed = listed;
      entry.absent = !!listed && entry.minutes === 0;
      run = entry.absent ? run + 1 : 0;
      entry.run = run;
      // The player's role BEFORE this fixture, from his own rows only, so it is
      // as pre-deadline as everything else here.
      entry.role = roleBucket(playedSoFar > 0 ? startsSoFar / playedSoFar : 0);
      startsSoFar += entry.starts;
      playedSoFar++;
    }

    for (let i = 0; i < entries.length - 1; i++) {
      if (!entries[i].absent) continue;
      transitions.push({
        knownAt: entries[i + 1].at,
        key: bucketKey(entries[i].listed.type, entries[i].run, entries[i].role),
        continued: entries[i + 1].absent ? 1 : 0,
      });
    }
    timelines.set(playerId, entries);
  }
  transitions.sort((a, b) => a.knownAt - b.knownAt);

  // Counter snapshots, one per gameweek, holding only transitions whose second
  // fixture had already been played by that gameweek's boundary.
  const snapshots = new Map();
  const running = new Map();
  const orderedGws = [...boundaries.keys()].sort((a, b) => a - b);
  let cursor = 0;
  for (const gw of orderedGws) {
    const boundary = boundaries.get(gw);
    while (cursor < transitions.length && transitions[cursor].knownAt < boundary) {
      const t = transitions[cursor++];
      const row = running.get(t.key) || { attempts: 0, continued: 0 };
      row.attempts++;
      row.continued += t.continued;
      running.set(t.key, row);
    }
    snapshots.set(gw, new Map([...running].map(([k, v]) => [k, { ...v }])));
  }

  const availabilityFor = (gw, type, run, role = 'squad') => {
    const snapshot = snapshots.get(gw) || new Map();
    const row = snapshot.get(bucketKey(type, run, role)) || { attempts: 0, continued: 0 };
    const prior = CONTINUATION_PRIOR[type] ?? CONTINUATION_PRIOR.missing;
    const q = (row.continued + CONTINUATION_PRIOR_WEIGHT * prior)
      / (row.attempts + CONTINUATION_PRIOR_WEIGHT);
    const availability = 1 - q;
    return {
      availability: Math.min(MAX_AVAILABILITY, Math.max(MIN_AVAILABILITY, availability)),
      attempts: row.attempts,
    };
  };

  return {
    season: dataset.season,
    stats: { ...join.stats, players: timelines.size, transitions: transitions.length },
    byPlayer: join.byPlayer,
    availabilityFor,

    // What was knowable about this player at this gameweek's boundary, in the
    // shape bootstrap-static publishes live, so minutes.js needs no replay
    // specific branch to read it.
    stateFor(playerId, gw) {
      const boundary = boundaries.get(gw);
      if (boundary === undefined) return null;
      const entries = timelines.get(playerId);
      if (!entries) return null;

      let last = null;
      for (const entry of entries) {
        if (entry.at >= boundary) break;
        last = entry;
      }
      // No signal is the default, and the default is the old behaviour: fit.
      if (!last || !last.absent) return null;

      const { availability, attempts } = availabilityFor(gw, last.listed.type, last.run, last.role);
      return {
        status: 'd',
        chanceNext: availability,
        role: last.role,
        news: `${last.listed.reason || 'Unavailable'} - missed the last ${last.run} match${last.run === 1 ? '' : 'es'}`,
        newsAdded: new Date(last.at).toISOString(),
        run: last.run,
        type: last.listed.type,
        sampleSize: attempts,
      };
    },
  };
}

// The replay reads the downloaded injury file only when asked to, because on
// the evidence it does not pay in points. scripts/backtest.mjs has no flag for
// it and is owned elsewhere, so the switch is an environment variable.
export function availabilityEnvEnabled() {
  if (typeof process === 'undefined' || !process.env) return false;
  const value = process.env.FPL_AVAILABILITY;
  return value === '1' || value === 'true';
}

// Node only, and only for a season that has a downloaded file. A browser never
// reaches this: nothing outside scripts/ and tests/ imports this module, and
// the dynamic import is inside the guard.
const availabilityRecordCache = new Map();
const availabilityIndexCache = new WeakMap();

export async function loadAvailabilityIndex(dataset, season) {
  const label = season || dataset.season;
  const year = availabilitySeasonYear(label);
  if (!year) return null;
  if (typeof process === 'undefined' || !process.versions || !process.versions.node) return null;

  const cachedIndex = availabilityIndexCache.get(dataset);
  if (cachedIndex && cachedIndex.season === label) return cachedIndex.index;

  let records = availabilityRecordCache.get(label);
  if (records === undefined) {
    const fs = await import('node:fs/promises');
    const url = new URL(`../../.data/availability/${year}.json`, import.meta.url);
    try {
      records = JSON.parse(await fs.readFile(url, 'utf8')).records || [];
    } catch {
      // Not downloaded on this machine. The replay runs exactly as it did
      // before, which is what makes this optional rather than required.
      records = null;
    }
    availabilityRecordCache.set(label, records);
  }
  if (!records) return null;

  const index = buildAvailabilityIndex(dataset, records);
  availabilityIndexCache.set(dataset, { season: label, index });
  return index;
}

export function actualRows(dataset, gw, playerId) {
  const gwMap = dataset.byGw.get(gw);
  if (!gwMap) return [];
  return gwMap.get(playerId) || [];
}

export function actualPoints(dataset, gw, playerId) {
  return actualRows(dataset, gw, playerId).reduce((s, r) => s + r.totalPoints, 0);
}

export function actualMinutes(dataset, gw, playerId) {
  return actualRows(dataset, gw, playerId).reduce((s, r) => s + r.minutes, 0);
}

// ---------------------------------------------------------------------------
// Feature accumulation, strictly pre deadline
// ---------------------------------------------------------------------------

const EMPTY_TOTALS = () => ({
  minutes: 0, starts: 0, totalPoints: 0, bonus: 0, bps: 0, saves: 0,
  goalsScored: 0, assists: 0, cleanSheets: 0, goalsConceded: 0,
  yellowCards: 0, redCards: 0, ownGoals: 0, penaltiesSaved: 0, penaltiesMissed: 0,
  xG: 0, xA: 0, xGC: 0, appearances: 0,
  cbit: 0, recoveries: 0, tackles: 0,
  // Minutes from rows whose gameweek carried the expected_* columns: the ONLY
  // legal denominator for an xG or xA rate. Equal to `minutes` everywhere
  // except 2022-23, where the columns arrive at gameweek 16.
  xMinutes: 0,
  // And the defensive-contribution denominator: minutes from rows whose
  // gameweek carried the defcon columns (2025-26 on).
  dcMinutes: 0,
});

function addRow(totals, row, weight = 1) {
  totals.minutes += weight * row.minutes;
  totals.starts += weight * row.starts;
  totals.totalPoints += weight * row.totalPoints;
  totals.bonus += weight * row.bonus;
  totals.bps += weight * row.bps;
  totals.saves += weight * row.saves;
  totals.goalsScored += weight * row.goalsScored;
  totals.assists += weight * row.assists;
  totals.cleanSheets += weight * row.cleanSheets;
  totals.goalsConceded += weight * row.goalsConceded;
  totals.yellowCards += weight * row.yellowCards;
  totals.redCards += weight * row.redCards;
  totals.ownGoals += weight * row.ownGoals;
  totals.penaltiesSaved += weight * row.penaltiesSaved;
  totals.penaltiesMissed += weight * row.penaltiesMissed;
  totals.xG += weight * row.xG;
  totals.xA += weight * row.xA;
  totals.xGC += weight * row.xGC;
  // Absent flag means a caller (tests, synthetic rows) that predates it; those
  // rows all carry real expected data, so they count.
  if (row.hasExpectedData !== false) totals.xMinutes += weight * row.minutes;
  if (row.hasDefConData !== false) totals.dcMinutes += weight * row.minutes;
  totals.cbit += weight * (row.cbit || 0);
  totals.recoveries += weight * (row.recoveries || 0);
  totals.tackles += weight * (row.tackles || 0);
  totals.appearances += weight;
}

// The season before the one being replayed. FPL carries last season's totals
// into the new one and so does this: at gameweek 1 it is the only evidence that
// exists, and it is exactly the state the live app is in every August.
//
// THIS IS THE ONE CROSS-SEASON JOIN IN THE REPLAY, and it used to be an exact
// match on the archive's raw `name` string. That is not catastrophic the way an
// `element` join would be (it never matched the WRONG player), but it is
// silently lossy, because the archive respells a returning player freely:
// accents get restored, a maternal surname appears, a nickname expands, a
// Japanese name flips order. Measured against the canonical `code`:
//
//   2022-23 -> 2023-24   14 of 526 returning players seeded nothing,
//                        11,366 prior minutes and 436 prior points discarded
//   2023-24 -> 2024-25   23 of 513 returning players seeded nothing,
//                        19,061 prior minutes and 884 prior points discarded
//
// Among the players thrown away that way: Rodri (2,931 minutes), Tomiyasu
// (1,140), Mitoma (1,485), Coufal (2,135). They entered their second season
// looking to the planner like men who had never played, which at gameweek 1 is
// the entire input.
//
// resolveSeasonPair uses `code` when the identity tables are downloaded (100%
// of returning players on all three pairs) and refuses to guess otherwise.
//
// THE DENOMINATOR THIS SEEDING NEEDS, which it did not have until 2026-08-12.
// The totals below are a NUMERATOR: starts, minutes, expected goals. A start
// rate is starts over MATCHES, and minutes.js divided by the matches THIS
// season has played, because on a live payload that is the only kind of match
// there is (FPL resets element totals every August). Seeding half a previous
// season into the numerator and none of it into the denominator inflated every
// returning player's start rate by roughly 19 matches:
//
//   2024-25, top 260 owned   gw3   89% of players read starts/matches >= 1
//                            gw5   82%
//                            gw10  71%
//
// Clamped at one, that is pStart = 1.000 at the median AND the 90th percentile,
// and every position prior pinned at 1.000 as well. For the first half of every
// seeded season the replay could not tell a nailed starter from a rotation
// risk, which is the single most decision-relevant quantity the engine has.
//
// The fix is to carry the matches with the totals. `appearances` already counts
// one per row, and the archive writes a row per registered player per fixture,
// so it is exactly "matches this evidence covers": 0.5 x 38 for a full prior
// season, less for a player who joined in January, two for a double gameweek.
// gameStateAt publishes it as `evidenceMatches` and minutes.js divides by it.
// A live payload has no such field and the model falls back to team matches, so
// production behaviour is unchanged by construction.
function priorTotalsByPlayer(dataset, priorDataset, priorWeight = PRIOR_SEASON_WEIGHT) {
  const out = new Map();
  if (!priorDataset || priorWeight <= 0) return { totals: out, stats: null };

  const roster = (d) => ({
    season: d.season,
    players: [...d.players.values()].map(p => ({ id: p.id, name: p.name, code: p.code })),
  });
  const resolved = resolveSeasonPair({ from: roster(priorDataset), to: roster(dataset) });

  for (const [playerId, priorEntry] of resolved.matched) {
    const prior = priorDataset.players.get(priorEntry.id);
    if (!prior) continue;
    const totals = EMPTY_TOTALS();
    for (const row of prior.rows) addRow(totals, row, priorWeight);
    out.set(playerId, totals);
  }
  return { totals: out, stats: resolved.stats };
}

// Sequential accumulator. The replay walks gameweeks in order, so totals are
// carried forward rather than rescanned, and `absorb(gw)` is the only way a
// gameweek's outcomes can ever enter the feature set.
export function createAccumulator(dataset, { priorDataset = null, priorWeight = PRIOR_SEASON_WEIGHT } = {}) {
  const { totals: priors, stats: priorStats } = priorTotalsByPlayer(dataset, priorDataset, priorWeight);
  const totals = new Map();
  let absorbedUpTo = 0;

  for (const p of dataset.players.values()) {
    const t = EMPTY_TOTALS();
    const prior = priors.get(p.id);
    if (prior) for (const key of Object.keys(t)) t[key] = prior[key];
    totals.set(p.id, t);
  }

  return {
    get absorbedUpTo() { return absorbedUpTo; },
    // How the prior season was joined, so a report can state it rather than
    // leave the reader to assume the seeding worked.
    get priorJoin() { return priorStats; },
    totalsFor(playerId) { return totals.get(playerId); },
    absorb(gw) {
      const gwMap = dataset.byGw.get(gw);
      if (gwMap) {
        for (const [playerId, list] of gwMap) {
          if (!totals.has(playerId)) totals.set(playerId, EMPTY_TOTALS());
          for (const row of list) addRow(totals.get(playerId), row);
        }
      }
      absorbedUpTo = Math.max(absorbedUpTo, gw);
    },
  };
}

// Price at the deadline of `gw`. Prices lock when the deadline passes, so the
// value column of gameweek gw is pre deadline information. Everything else in
// that row is not, and nothing else is read from it here.
function priceAt(player, gw) {
  let price = null;
  for (const row of player.rows) {
    if (row.gw > gw) break;
    price = row.valueTenths;
  }
  if (price === null && player.rows.length) price = player.rows[0].valueTenths;
  return price || 0;
}

function ownershipAt(player, gw) {
  let selected = 0;
  for (const row of player.rows) {
    if (row.gw > gw) break;
    selected = row.selected;
  }
  return selected;
}

const per90 = (value, minutes) => (minutes > 0 ? (value * 90) / minutes : 0);

// A GameState as it looked at the deadline of `gw`.
//
// `availability` is an index from buildAvailabilityIndex, or null. With none,
// every player is reported fit and unflagged, which is what this harness did
// before the injury data existed and is still the behaviour on a machine that
// has not downloaded it.
export function gameStateAt(dataset, gw, { rules, accumulator, featureHook = null, availability = null }) {
  if (accumulator.absorbedUpTo >= gw) {
    throw new Error(
      `backtest: accumulator has absorbed gameweek ${accumulator.absorbedUpTo} but a state for gameweek ${gw} was requested. `
      + 'That would feed post deadline outcomes into the plan.',
    );
  }

  const players = new Map();
  for (const p of dataset.players.values()) {
    const t = accumulator.totalsFor(p.id) || EMPTY_TOTALS();
    const nowCost = priceAt(p, gw);
    if (!nowCost) continue;

    const flag = availability ? availability.stateFor(p.id, gw) : null;

    const player = {
      id: p.id,
      // The canonical code when the identity table is present, null otherwise.
      // This used to be `p.id`, which put a season-scoped row number into the
      // one field whose entire contract is that it survives a season.
      code: p.code,
      webName: p.name,
      firstName: '',
      secondName: p.name,
      teamId: p.teamId,
      position: p.position,
      nowCost,
      costChangeStart: 0,
      status: flag ? flag.status : 'a',
      chanceNext: flag ? flag.chanceNext : null,
      news: flag ? flag.news : '',
      newsAdded: flag ? flag.newsAdded : null,
      selectedByPercent: ownershipAt(p, gw) / 100000,
      minutes: t.minutes,
      starts: t.starts,
      // How many matches the totals above cover, INCLUDING whatever weight the
      // previous season was seeded at. A live payload has no equivalent (FPL
      // resets in August), so the field is absent there and minutes.js falls
      // back to counting this season's matches. See priorTotalsByPlayer.
      evidenceMatches: t.appearances,
      // Like evidenceMatches, but for the xG/xA numerators: the minutes their
      // evidence actually covers. A live payload never sets it (FPL's totals
      // and minutes always cover the same rows) and the rate layer falls back
      // to `minutes`.
      xMinutes: t.xMinutes,
      dcMinutes: t.dcMinutes,
      totalPoints: t.totalPoints,
      bonus: t.bonus,
      bps: t.bps,
      saves: t.saves,
      goalsScored: t.goalsScored,
      assists: t.assists,
      cleanSheets: t.cleanSheets,
      goalsConceded: t.goalsConceded,
      yellowCards: t.yellowCards,
      redCards: t.redCards,
      ownGoals: t.ownGoals,
      penaltiesSaved: t.penaltiesSaved,
      penaltiesMissed: t.penaltiesMissed,
      // Defensive contribution arrived in 2025-26 and the archive carries the
      // three component columns from that season on. Earlier seasons parse them
      // as zero, which is correct rather than missing: the stat did not exist
      // and those seasons' actual points contain none of it. Reading them where
      // they DO exist is not optional either, because a replay that projects
      // zero against actuals that include it under-projects a defender by two
      // points in about one appearance in eight.
      cbit: t.cbit,
      recoveries: t.recoveries,
      tackles: t.tackles,
      defCon: 0,
      xG: t.xG,
      xA: t.xA,
      xGI: t.xG + t.xA,
      xGC: t.xGC,
      per90: {
        xG: per90(t.xG, t.xMinutes),
        xA: per90(t.xA, t.xMinutes),
        xGI: per90(t.xG + t.xA, t.xMinutes),
        xGC: per90(t.xGC, t.xMinutes),
        saves: per90(t.saves, t.minutes),
        goalsConceded: per90(t.goalsConceded, t.minutes),
        starts: per90(t.starts, t.minutes),
        cleanSheets: per90(t.cleanSheets, t.minutes),
        defCon: per90(defConComposite({ ...t, position: p.position }), t.dcMinutes),
      },
      setPieces: { penaltiesOrder: null, directFreekicksOrder: null, cornersOrder: null },
    };

    players.set(p.id, featureHook ? featureHook(player, { gw, dataset }) || player : player);
  }

  // The calendar is published in advance; the scores are not.
  const fixtures = dataset.fixtures.map(f => ({
    ...f,
    finished: f.event < gw,
    started: f.event < gw,
    teamHScore: f.event < gw ? f.teamHScore : null,
    teamAScore: f.event < gw ? f.teamAScore : null,
  }));

  const events = [];
  for (let id = 1; id <= dataset.maxGw; id++) {
    const first = dataset.fixtures.find(f => f.event === id);
    events.push({
      id,
      name: `Gameweek ${id}`,
      deadline: first ? first.kickoff : null,
      deadlineEpoch: first && first.kickoff ? Math.floor(Date.parse(first.kickoff) / 1000) : null,
      finished: id < gw,
      dataChecked: id < gw,
      isCurrent: id === gw - 1,
      isNext: id === gw,
      isPrevious: id === gw - 2,
      averageEntryScore: null,
      highestScore: null,
    });
  }

  return {
    rules,
    teams: dataset.teams,
    players,
    fixtures,
    events,
    fetchedAt: new Date(0).toISOString(),
    currentEvent: gw > 1 ? gw - 1 : null,
    nextEvent: gw,
    seasonStarted: gw > 1,
  };
}

// ---------------------------------------------------------------------------
// THE PRODUCTION EVIDENCE REGIME
//
// `gameStateAt` above assembles a GameState directly, under the replay's own
// evidence rule: half of the previous season seeded into every total, for the
// whole season. Production has never run that rule. At each deadline the app
// reads `bootstrap-static` and `fixtures`, builds a GameState, and lets
// `engine/world.js` decide which previous-season record (the shipped opening
// baseline, or a snapshot the browser kept) stands in. Every experiment in
// experiments/registry.md before 2026-09-16 was measured in the replay's
// regime, and the xP audit of that day found production in a state no replay
// had produced: previous-season evidence gone after three club matches, a
// nailed starter projected to play 64% to 76% of the time.
//
// So this regime rebuilds the two PAYLOADS production would have fetched at
// the deadline, in FPL's own field names, and hands them to the same
// `buildGameState` and `resolveGameState` the page calls. The previous season
// reaches it exactly as it reaches production: as an opening-baseline asset,
// captured before this season's first deadline, keyed by `code`.
//
//   gameweek 1   the pre-season payload: every registered player carrying LAST
//                season's totals, nothing played. FPL clears the totals only
//                after the GW1 deadline, so a GW1 plan is always built on it.
//   gameweek 2+  this season's totals over the matches before the deadline,
//                with the previous-season asset offered to the resolver.
//
// What the archive cannot supply, stated rather than faked: injury status and
// chance of playing (every player is `a` unless an availability index is
// passed), set-piece orders (null), FPL's team strength tiers (a neutral 3),
// and price-change predictions. Everything the projections read from a
// player's season totals is reproduced field for field.
// ---------------------------------------------------------------------------

export const EVIDENCE_REGIMES = Object.freeze({
  // What the app does. The default for every instrument that decides.
  PRODUCTION: 'production',
  // The replay's historical rule, kept because older registry entries were
  // measured under it and a re-measurement has to be able to name it.
  SEEDED: 'seeded',
});

// '2024-25' -> '2024_25', the directory FPL's static content path ends in and
// the only place a live payload names its season (rules.parseSeasonLabel).
function staticSeasonPath(season) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(season || ''));
  return m ? `${m[1]}_${m[2]}` : null;
}

const round2 = (v) => Math.round(v * 100) / 100;

// Totals in FPL's element field names. Numbers where FPL sends numbers, and the
// expected_* totals as the strings FPL sends, so normalize.js parses them on
// the same path it parses the live payload on.
function elementTotals(t) {
  return {
    minutes: t.minutes,
    starts: t.starts,
    total_points: t.totalPoints,
    bonus: t.bonus,
    bps: t.bps,
    saves: t.saves,
    goals_scored: t.goalsScored,
    assists: t.assists,
    clean_sheets: t.cleanSheets,
    goals_conceded: t.goalsConceded,
    yellow_cards: t.yellowCards,
    red_cards: t.redCards,
    own_goals: t.ownGoals,
    penalties_saved: t.penaltiesSaved,
    penalties_missed: t.penaltiesMissed,
    clearances_blocks_interceptions: t.cbit,
    recoveries: t.recoveries,
    tackles: t.tackles,
    expected_goals: round2(t.xG).toFixed(2),
    expected_assists: round2(t.xA).toFixed(2),
    expected_goal_involvements: round2(t.xG + t.xA).toFixed(2),
    expected_goals_conceded: round2(t.xGC).toFixed(2),
  };
}

/**
 * The previous season's end totals keyed by the CURRENT season's element id,
 * which is what the gameweek 1 (pre-season) payload carries. Joined on `code`
 * through the same resolver the seeded regime uses.
 */
export function preseasonTotalsFor(dataset, priorDataset) {
  const { totals } = priorTotalsByPlayer(dataset, priorDataset, 1);
  return totals;
}

/**
 * The previous season as production receives it: an opening-baseline asset.
 *
 * Same shape `snapshotFrom` writes and `scripts/build-opening-baseline.mjs`
 * ships, pinned to the replayed season (`appliesToSeason`, `firstDeadline`) so
 * `validateOpeningBaseline` accepts it for exactly that season.
 *
 * WHO IS IN IT. Production builds the asset from the NEW season's pre-season
 * payload, which lists the players registered for the new season carrying last
 * season's totals. A player who left the league is not in that payload and so
 * not in the asset, and the aggregate the validator checks counts the same
 * pool. The replay does the same: one row per player of the replayed season
 * with previous-season minutes (joined on `code`), keyed by his current element
 * id, and the aggregate over the replayed season's players.
 *
 * `xm` and `dm` are REPLAY-ONLY coverage annotations: the minutes the xG/xA and
 * defensive-contribution numerators actually cover, emitted only where the
 * archive's columns arrived part way through a season (2022-23's expected_*
 * from gameweek 16; defensive contribution before 2025-26). A live payload's
 * totals always cover their own minutes, so a shipped asset never carries them.
 */
export function priorSeasonAsset(dataset, priorDataset, { firstDeadline = null } = {}) {
  if (!priorDataset) return null;
  const label = staticSeasonPath(dataset.season);
  const appliesToSeason = label ? label.replace('_', '/') : null;
  const priorByCurrentId = preseasonTotalsFor(dataset, priorDataset);

  const totals = {};
  let active = 0;
  let starts = 0;
  let minutes = 0;
  for (const p of dataset.players.values()) {
    const t = priorByCurrentId.get(p.id);
    if (!t || (!t.minutes && !t.starts)) continue;
    active++;
    starts += t.starts;
    minutes += t.minutes;
    const row = { s: t.starts, m: t.minutes, c: p.code ?? null };
    const fields = {
      xg: t.xG, xa: t.xA, xgc: t.xGC, bps: t.bps, bo: t.bonus, sv: t.saves,
      gs: t.goalsScored, as: t.assists, cs: t.cleanSheets, gc: t.goalsConceded,
      yc: t.yellowCards, rc: t.redCards, ps: t.penaltiesSaved, og: t.ownGoals,
      pm: t.penaltiesMissed, cbit: t.cbit, rec: t.recoveries, tck: t.tackles,
    };
    for (const [key, v] of Object.entries(fields)) if (Number.isFinite(v) && v !== 0) row[key] = round2(v);
    if (Math.abs(t.xMinutes - t.minutes) > 1e-9) row.xm = t.xMinutes;
    if (Math.abs(t.dcMinutes - t.minutes) > 1e-9) row.dm = t.dcMinutes;
    totals[p.id] = row;
  }

  return {
    kind: OPENING_BASELINE_KIND,
    version: SNAPSHOT_VERSION,
    appliesToSeason,
    coversSeason: priorDataset.season ? priorDataset.season.replace('-', '/') : null,
    firstDeadline,
    capturedAt: firstDeadline,
    totalEvents: priorDataset.maxGw,
    seasonLabel: appliesToSeason,
    aggregate: { pool: dataset.players.size, active, starts, minutes },
    totals,
  };
}

/** The deadline of every gameweek: its earliest kickoff, as the replay uses. */
// ---------------------------------------------------------------------------
// THE CALENDAR AS IT WAS KNOWN AT EACH DEADLINE (registry entry 31)
//
// The archive holds one fixture list, the final one: a match postponed out of
// gameweek 29 and played in a gameweek 34 double sits in gameweek 34 from the
// first deadline of the season. Production never knew that. FPL leaves a
// postponed match undated (`event: null`) until the league announces its new
// date, so a double or a blank is visible only from then, typically three to
// six weeks ahead. Replaying the final list let every decision that looks past
// the week being decided (a triple captain compared with later weeks, a chip
// held for a double, a transfer made for one) see doubles and blanks months
// early.
//
// The original calendar is recoverable exactly. FPL numbers fixtures in the
// order of the original schedule, one round of (clubs / 2) at a time, so
// fixture `id` n was scheduled in round ceil(n / 10). In 2023-24, 2024-25 and
// 2025-26, 366, 375 and 375 of the 380 fixtures were played in that round, and
// every exception is a known reschedule. WHEN a move was announced is in no
// archive, so it is modelled with one lead, FIXTURE_ANNOUNCE_LEAD gameweeks
// before the week the match moved INTO:
//
//   moved later   (round r, played in w > r): in round r at deadlines before r;
//                 undated from r until w - lead; dated w from then
//   moved earlier (round r, played in w < r): in round r until w - lead; dated
//                 w from then
//
// The week being decided always reads true: a match moved into it is dated by
// its deadline and a match moved out of it is not in it, so the projections for
// that week are the ones the final list gives. Only later weeks lose the
// hindsight. `fixtureLead: null` replays the final list, for comparison.
export const FIXTURE_ANNOUNCE_LEAD = 3;

export function knownFixtureEvent(fixture, gw, { lead = FIXTURE_ANNOUNCE_LEAD, perRound = 10 } = {}) {
  if (lead === null || lead === undefined) return fixture.event;
  const round = Math.ceil(fixture.id / perRound);
  const played = fixture.event;
  if (round === played) return played;
  if (gw >= played - lead) return played;
  if (played > round && gw >= round) return null;
  return round;
}

// The original calendar's shape for a dataset: fixtures per round, and a
// representative kickoff for every round from its unmoved matches, so a match
// shown in its original round carries a date in that round. Null when the
// fixture ids do not number a whole calendar (the final list is then replayed).
const scheduleCache = new WeakMap();
export function originalSchedule(dataset) {
  if (scheduleCache.has(dataset)) return scheduleCache.get(dataset);
  const perRound = dataset.teams && dataset.teams.size ? dataset.teams.size / 2 : 0;
  const ids = dataset.fixtures.map(f => f.id).sort((a, b) => a - b);
  const whole = perRound > 0
    && Number.isInteger(perRound)
    && ids.length === dataset.maxGw * perRound
    && ids.every((id, i) => id === i + 1);
  let out = null;
  if (whole) {
    const kickoffs = new Map();
    for (const f of dataset.fixtures) {
      const round = Math.ceil(f.id / perRound);
      if (round !== f.event || !f.kickoff) continue;
      if (!kickoffs.has(round)) kickoffs.set(round, []);
      kickoffs.get(round).push(f.kickoff);
    }
    const roundKickoff = new Map();
    for (const [round, list] of kickoffs) roundKickoff.set(round, list.sort()[Math.floor((list.length - 1) / 2)]);
    out = { perRound, roundKickoff };
  }
  scheduleCache.set(dataset, out);
  return out;
}

export function eventDeadlines(dataset) {
  const out = new Map();
  for (let id = 1; id <= dataset.maxGw; id++) {
    let first = null;
    for (const f of dataset.fixtures) {
      if (f.event !== id || !f.kickoff) continue;
      if (first === null || Date.parse(f.kickoff) < Date.parse(first)) first = f.kickoff;
    }
    out.set(id, first);
  }
  return out;
}

/**
 * The `bootstrap-static` and `fixtures` payloads production would have read at
 * the deadline of `gw`, rebuilt from the archive.
 *
 * `accumulator` must carry THIS season only (no prior seeding): production's
 * totals are this season's. `preseasonTotals` is the previous season's end
 * totals keyed by current element id, used for the gameweek 1 payload.
 */
export function deadlinePayload(dataset, gw, {
  rules, accumulator, preseasonTotals = null, availability = null, fixtureLead = FIXTURE_ANNOUNCE_LEAD,
}) {
  if (accumulator.absorbedUpTo >= gw) {
    throw new Error(
      `backtest: accumulator has absorbed gameweek ${accumulator.absorbedUpTo} but a payload for gameweek ${gw} was requested. `
      + 'That would feed post deadline outcomes into the plan.',
    );
  }
  const preseason = gw <= 1;
  const deadlines = eventDeadlines(dataset);

  const elements = [];
  for (const p of dataset.players.values()) {
    const nowCost = priceAt(p, gw);
    if (!nowCost) continue;
    const t = preseason
      ? (preseasonTotals && preseasonTotals.get(p.id)) || EMPTY_TOTALS()
      : accumulator.totalsFor(p.id) || EMPTY_TOTALS();
    const flag = availability ? availability.stateFor(p.id, gw) : null;
    elements.push({
      id: p.id,
      code: p.code,
      web_name: p.name,
      first_name: '',
      second_name: p.name,
      team: p.teamId,
      element_type: p.position,
      now_cost: nowCost,
      cost_change_start: 0,
      cost_change_event: 0,
      status: flag ? flag.status : 'a',
      chance_of_playing_next_round: flag && flag.chanceNext !== null && flag.chanceNext !== undefined
        ? Math.round(flag.chanceNext * 100)
        : null,
      news: flag ? flag.news : '',
      news_added: flag ? flag.newsAdded : null,
      selected_by_percent: String(ownershipAt(p, gw) / 100000),
      penalties_order: null,
      direct_freekicks_order: null,
      corners_and_indirect_freekicks_order: null,
      ...elementTotals(t),
    });
  }

  const events = [];
  for (let id = 1; id <= dataset.maxGw; id++) {
    const deadline = deadlines.get(id);
    events.push({
      id,
      name: `Gameweek ${id}`,
      deadline_time: deadline,
      deadline_time_epoch: deadline ? Math.floor(Date.parse(deadline) / 1000) : null,
      finished: id < gw,
      data_checked: id < gw,
      is_current: id === gw - 1,
      is_next: id === gw,
      is_previous: id === gw - 2,
      average_entry_score: null,
      highest_score: null,
    });
  }

  // The calendar as it stood at this deadline (THE CALENDAR AS IT WAS KNOWN).
  // Whether a match has been played is a fact about the final list.
  const schedule = fixtureLead === null ? null : originalSchedule(dataset);
  const fixtures = dataset.fixtures.map(f => {
    const played = f.event < gw;
    const event = schedule ? knownFixtureEvent(f, gw, { lead: fixtureLead, perRound: schedule.perRound }) : f.event;
    return {
      id: f.id,
      code: f.code,
      event,
      kickoff_time: event === f.event ? f.kickoff : event === null ? null : (schedule.roundKickoff.get(event) || null),
      team_h: f.teamH,
      team_a: f.teamA,
      team_h_difficulty: f.teamHDifficulty,
      team_a_difficulty: f.teamADifficulty,
      finished: played,
      finished_provisional: played,
      started: played,
      team_h_score: played ? f.teamHScore : null,
      team_a_score: played ? f.teamAScore : null,
    };
  });

  const seasonPath = staticSeasonPath(dataset.season);
  const positions = Object.values(rules.positions || {});
  const bootstrap = {
    events,
    teams: [...dataset.teams.values()].map(t => ({
      id: t.id,
      code: t.code,
      name: t.name,
      short_name: t.shortName,
      strength_overall_home: t.strengthOverallHome,
      strength_overall_away: t.strengthOverallAway,
    })),
    element_types: positions.map(pos => ({
      id: pos.id,
      singular_name: pos.name,
      singular_name_short: pos.short,
      squad_select: pos.squadSelect,
      squad_min_play: pos.minPlay,
      squad_max_play: pos.maxPlay,
    })),
    game_settings: {
      squad_squadsize: rules.squadSize,
      squad_squadplay: rules.starters,
      squad_total_spend: rules.budgetTenths,
      squad_team_limit: rules.clubLimit,
      transfers_sell_on_fee: rules.sellFeeRate,
      max_extra_free_transfers: rules.maxFreeTransfers - 1,
      transfers_cap: rules.transfersCap,
    },
    game_config: {
      settings: seasonPath
        ? { static_content_url: `https://fantasy.premierleague.com/gcs/plfpl-prod-static-content/plfpl-production/${seasonPath}/` }
        : {},
      scoring: rules.scoring,
    },
    chips: [],
    elements,
  };
  return { bootstrap, fixtures };
}

/**
 * A GameState exactly as production would have resolved it at this deadline.
 *
 * `asset` is the previous season's opening-baseline asset (or null when the
 * season has no downloaded predecessor). It is offered to the resolver only
 * when production would have fetched it (`openingBaselineApplies`), and the
 * resolver alone decides whether it stands in.
 */
export function productionGameStateAt(dataset, gw, {
  rules, accumulator, preseasonTotals = null, asset = null, availability = null, featureHook = null,
  fixtureLead = FIXTURE_ANNOUNCE_LEAD,
}) {
  const { bootstrap, fixtures } = deadlinePayload(dataset, gw, { rules, accumulator, preseasonTotals, availability, fixtureLead });
  const fetchedAt = new Date(0).toISOString();
  const first = buildGameState(bootstrap, fixtures, { fetchedAt });
  const shipped = asset && openingBaselineApplies(first) ? asset : null;
  const { gameState, resolution } = resolveGameState(first, { bootstrap, fixtures, fetchedAt, kept: null, shipped });
  // The historical rules object (chip catalogue, transfer bank, era flags) is
  // what the season was played under; the rebuilt payload only had to carry
  // enough of it for the resolver's season and calendar checks.
  gameState.rules = { ...rules, season: gameState.rules.season, totalEvents: gameState.rules.totalEvents };
  // Archive coverage corrections (2022-23 expected_* from gameweek 16,
  // defensive contribution from 2025-26) are properties of the archive, not of
  // the regime, so they ride along exactly as `gameStateAt` carries them.
  if (gw > 1) {
    for (const player of gameState.players.values()) {
      const t = accumulator.totalsFor(player.id);
      if (!t) continue;
      if (Math.abs(t.xMinutes - t.minutes) > 1e-9) player.xMinutes = t.xMinutes;
      if (Math.abs(t.dcMinutes - t.minutes) > 1e-9) player.dcMinutes = t.dcMinutes;
    }
  }
  if (featureHook) {
    for (const [id, player] of gameState.players) {
      gameState.players.set(id, featureHook(player, { gw, dataset }) || player);
    }
  }
  return { gameState, resolution, bootstrap, fixtures };
}

// ---------------------------------------------------------------------------
// Squad bookkeeping
// ---------------------------------------------------------------------------

// A replay starts where a real manager starts: before the first deadline, with
// unlimited transfers and nothing banked. The old seed of 1 free transfer meant
// the opening squad was built as if a transfer had already been earned, and the
// +1 applied after gameweek 1 then carried an extra free transfer through every
// gameweek of every season replayed here.
function emptySquad(rules, gwFrom) {
  return {
    holdings: new Map(),   // playerId -> purchaseTenths
    order: [],             // squad order, used for stable bench and slot numbering
    bankTenths: rules.budgetTenths,
    transferState: initialTransferState({ gw: gwFrom }),
    chipsUsed: [],
  };
}

function toSquadState(squad, { gw, gameState, rules, label }) {
  const picks = squad.order.map((playerId, i) => {
    const purchase = squad.holdings.get(playerId);
    const player = gameState.players.get(playerId);
    const nowCost = player ? player.nowCost : purchase;
    return {
      playerId,
      slot: i + 1,
      isCaptain: false,
      isViceCaptain: false,
      multiplier: i < rules.starters ? 1 : 0,
      purchaseTenths: purchase,
      sellingTenths: sellingPrice(purchase, nowCost, rules),
    };
  });

  const chipsAvailable = [...new Set(rules.chips.map(c => c.name))]
    .filter(name => chipAvailableAt(rules, name, gw, squad.chipsUsed));

  return {
    entryId: null,
    entryName: label || 'Backtest',
    managerName: label || 'Backtest',
    gw,
    picks,
    bankTenths: squad.bankTenths,
    squadValueTenths: picks.reduce((s, p) => s + p.sellingTenths, 0) + squad.bankTenths,
    transferState: squad.transferState,
    freeTransfers: freeTransfersFor(squad.transferState),
    chipsUsed: squad.chipsUsed.slice(),
    chipsAvailable,
    overallRank: null,
    totalPoints: 0,
    source: picks.length ? 'manual' : 'draft',
    asOf: new Date(0).toISOString(),
    warnings: [],
  };
}

function applyDecision(squad, plan, { gameState, rules }) {
  const price = id => {
    const p = gameState.players.get(id);
    return p ? p.nowCost : 0;
  };

  if (plan.chip === 'freehit') {
    // The rented squad plays this gameweek and is handed back afterwards, so
    // holdings, bank and banked free transfers are untouched.
    squad.chipsUsed.push({ name: 'freehit', event: plan.gw });
    squad.transferState = advance(squad.transferState, {
      gw: plan.gw, transfersMade: plan.transferCount || 0, chipPlayed: 'freehit', rules,
    });
    return;
  }

  for (const id of plan.transfersOut) {
    const purchase = squad.holdings.get(id);
    if (purchase === undefined) continue;
    squad.bankTenths += sellingPrice(purchase, price(id), rules);
    squad.holdings.delete(id);
    squad.order = squad.order.filter(x => x !== id);
  }
  for (const id of plan.transfersIn) {
    squad.bankTenths -= price(id);
    squad.holdings.set(id, price(id));
    squad.order.push(id);
  }
  // A draft or a wildcard hands back a whole squad rather than a transfer list.
  if (!plan.transfersIn.length && plan.squad.length && squad.order.length === 0) {
    for (const id of plan.squad) {
      squad.bankTenths -= price(id);
      squad.holdings.set(id, price(id));
      squad.order.push(id);
    }
  }

  if (plan.chip) squad.chipsUsed.push({ name: plan.chip, event: plan.gw });

  squad.transferState = advance(squad.transferState, {
    gw: plan.gw,
    transfersMade: plan.transferCount || 0,
    chipPlayed: plan.chip || null,
    rules,
  });
}

// ---------------------------------------------------------------------------
// Scoring a gameweek against what actually happened
// ---------------------------------------------------------------------------

export function applyAutoSubs({ startingXI, bench, positionOf, minutesOf, rules }) {
  const finalXI = startingXI.slice();
  const subs = [];
  const used = new Set();

  const counts = () => {
    const c = { 1: 0, 2: 0, 3: 0, 4: 0 };
    for (const id of finalXI) c[positionOf(id)]++;
    return c;
  };
  const legal = (c) => Object.values(rules.positions).every(p => c[p.id] >= p.minPlay && c[p.id] <= p.maxPlay);

  const benchOrder = [bench.gk, ...bench.order];
  for (let i = 0; i < finalXI.length; i++) {
    const id = finalXI[i];
    if (minutesOf(id) > 0) continue;
    for (const candidate of benchOrder) {
      if (used.has(candidate)) continue;
      if (minutesOf(candidate) <= 0) continue;
      // A goalkeeper can only be replaced by a goalkeeper, which falls out of
      // the legality check rather than needing a rule of its own.
      const before = finalXI[i];
      finalXI[i] = candidate;
      if (legal(counts())) {
        used.add(candidate);
        subs.push({ out: before, in: candidate });
        break;
      }
      finalXI[i] = before;
    }
  }
  return { finalXI, subs };
}

export function scoreGameweek({ dataset, gw, plan, rules }) {
  const positionOf = id => {
    const p = dataset.players.get(id);
    return p ? p.position : 0;
  };
  const minutesOf = id => actualMinutes(dataset, gw, id);
  const pointsOf = id => actualPoints(dataset, gw, id);

  const benchIds = [plan.bench.gk, ...plan.bench.order];
  let finalXI = plan.startingXI.slice();
  let subs = [];
  let benchPoints = 0;

  if (plan.chip === 'bboost') {
    // Every one of the fifteen scores, so there are no auto subs to apply.
    benchPoints = benchIds.reduce((s, id) => s + pointsOf(id), 0);
  } else {
    const applied = applyAutoSubs({ startingXI: plan.startingXI, bench: plan.bench, positionOf, minutesOf, rules });
    finalXI = applied.finalXI;
    subs = applied.subs;
    benchPoints = benchIds
      .filter(id => !finalXI.includes(id))
      .reduce((s, id) => s + pointsOf(id), 0);
  }

  const xiPoints = finalXI.reduce((s, id) => s + pointsOf(id), 0);

  let armband = plan.captain;
  let armbandFromVice = false;
  if (minutesOf(plan.captain) <= 0 && minutesOf(plan.viceCaptain) > 0) {
    armband = plan.viceCaptain;
    armbandFromVice = true;
  }
  const multiplier = plan.chip === '3xc' ? 3 : 2;
  const captainBase = pointsOf(armband);
  const captainExtra = finalXI.includes(armband) || plan.chip === 'bboost'
    ? captainBase * (multiplier - 1)
    : 0;

  const meanStarter = finalXI.length ? xiPoints / finalXI.length : 0;

  return {
    gw,
    points: xiPoints + (plan.chip === 'bboost' ? benchPoints : 0) + captainExtra,
    netPoints: xiPoints + (plan.chip === 'bboost' ? benchPoints : 0) + captainExtra - (plan.hitCostPoints || 0),
    xiPoints,
    benchPoints,
    captain: armband,
    captainFromVice: armbandFromVice,
    captainBase,
    captainExtra,
    // How much the armband beat an arbitrary choice inside the same eleven.
    captaincyValue: captainBase - meanStarter,
    autoSubs: subs,
    autoSubPoints: subs.reduce((s, sub) => s + pointsOf(sub.in), 0),
    finalXI,
    hitCostPoints: plan.hitCostPoints || 0,
    chip: plan.chip,
  };
}

// ---------------------------------------------------------------------------
// Naive projections, used by the fixture difficulty baseline.
//
// It shares the legality machinery with the real planner on purpose: the
// baseline has to differ in its DECISION RULE, not in whether it can count to
// fifteen. Points per game so far, scaled by how easy the fixture looks from
// the opponent's own results, and nothing else.
// ---------------------------------------------------------------------------

export function naiveProjections({ gameState, strength, gwFrom, gwTo, playerIds }) {
  const byPlayer = new Map();
  const ids = playerIds || [...gameState.players.keys()];
  const teamMatches = Math.max(1, gameState.events.filter(e => e.finished).length);

  for (const id of ids) {
    const player = gameState.players.get(id);
    if (!player) continue;
    const rows = [];
    const ppg = player.minutes > 0 ? player.totalPoints / Math.max(1, player.starts || teamMatches) : 0;

    for (let gw = gwFrom; gw <= gwTo; gw++) {
      const fixtures = fixturesForTeam(gameState, player.teamId, gw);
      let points = 0;
      for (const f of fixtures) {
        const opponentId = f.teamH === player.teamId ? f.teamA : f.teamH;
        const opponent = strength.teams.get(opponentId);
        // A weak defence is an easy fixture. The opponent's fitted defence
        // rating is the only difficulty signal the archive supports.
        const ease = opponent ? opponent.defence : 1;
        points += ppg * ease;
      }
      rows.push({
        playerId: id,
        gw,
        fixtures: fixtures.map(f => ({
          fixtureId: f.id,
          opponentId: f.teamH === player.teamId ? f.teamA : f.teamH,
          isHome: f.teamH === player.teamId,
          fdr: null,
          kickoff: f.kickoff,
        })),
        pAppear: player.minutes > 0 ? 1 : 0,
        pStart: player.minutes > 0 ? 1 : 0,
        xMins: player.minutes > 0 ? 90 : 0,
        components: {},
        xPoints: points,
        sd: 0,
        ceiling: points,
        confidence: 'low',
      });
    }
    byPlayer.set(id, rows);
  }

  return {
    gwFrom,
    gwTo,
    byPlayer,
    modelVersion: 'naive-fdr-1',
    generatedAt: new Date(0).toISOString(),
    dataFetchedAt: null,
    get(playerId, gw) {
      const rows = byPlayer.get(playerId);
      if (!rows) return null;
      const i = gw - gwFrom;
      return i >= 0 && i < rows.length ? rows[i] : null;
    },
  };
}

// ---------------------------------------------------------------------------
// Strategies
// ---------------------------------------------------------------------------

function candidatePool(gameState, dataset, gw, held, size) {
  const ranked = [...gameState.players.values()]
    .sort((a, b) => b.selectedByPercent - a.selectedByPercent)
    .slice(0, size)
    .map(p => p.id);
  return [...new Set([...held, ...ranked])];
}

async function plannerDecide({ gameState, squadState, rules, gw, opts, dataset, horizon, projectionsKind, risk }) {
  const held = squadState.picks.map(p => p.playerId);
  const pool = candidatePool(gameState, dataset, gw, held, opts.poolSize || DEFAULT_POOL_SIZE);
  const strength = buildStrength(gameState, { asOfGw: gw });
  const gwTo = Math.min(dataset.maxGw, gw + horizon - 1);

  // NO `model` HERE, AND THIS IS NOT AN OVERSIGHT.
  //
  // The app no longer feeds the trained artifact to buildProjections either:
  // models/fpl-planner-v2.json now declares `engineConsumes: []` because these
  // very replays showed it costs points. The loader machinery in js/data/model.js
  // is still live and would consume a future artifact that declares a key, so
  // this guard is not redundant. The backtest must never take one implicitly,
  // because models/fpl-planner-v2.json was trained on 2022-23 through
  // 2025-26. Scoring a replay of any of those seasons with it would let the
  // model see its own training and test rows, and the season points that come
  // out would be a memory of the answer rather than a measurement of the
  // strategy. The harness is the leakage detector, so it stays on the analytic
  // projections. Measuring the trained model needs a replay of a season it was
  // never trained on, with the artifact retrained to exclude it.
  // `opts.model` is null on every normal run, which keeps the default replay on
  // the analytic projections for the reason above. It is populated ONLY by the
  // experiment path in scripts/backtest.mjs, which refuses to pass an artifact
  // whose training seasons include the season being replayed. That is the one
  // configuration in which measuring the trained model is honest.
  const projections = projectionsKind === 'naive'
    ? naiveProjections({ gameState, strength, gwFrom: gw, gwTo, playerIds: pool })
    : buildProjections({ gameState, strength, gwFrom: gw, gwTo, playerIds: pool, model: opts.model || null });

  const bundle = await buildPlan({
    gameState,
    squadState,
    options: {
      horizon: gwTo - gw + 1,
      risk: risk || 'balanced',
      projections,
      strength,
      futureTransfers: false,
      seed: opts.seed === undefined ? 1 : opts.seed,
      // Planner option overrides an experiment arm sets (for example
      // experiments/configs/hit-thresholds.mjs). Absent on every normal replay.
      ...(opts.planOptions || {}),
    },
  });
  // A read-only window onto each deadline for measurement scripts
  // (scripts/calibration/calibrate-chips.mjs): the plan, the projections it was
  // built from and the state it saw. Absent on every normal replay.
  if (typeof opts.onPlanBundle === 'function') {
    await opts.onPlanBundle({ gw, gameState, squadState, rules, projections, bundle });
  }
  return bundle.current;
}

export const STRATEGIES = {
  planner: {
    key: 'planner',
    label: 'Multi gameweek planner',
    decide: (ctx) => plannerDecide({ ...ctx, horizon: ctx.opts.horizon || DEFAULT_HORIZON, risk: ctx.opts.risk }),
  },
  hold: {
    key: 'hold',
    label: 'No transfer hold',
    // The opening squad is built the same way, then never touched again. This
    // is the baseline that says how much of the season is squad selection.
    decide: async (ctx) => {
      if (!ctx.squadState.picks.length) {
        return plannerDecide({ ...ctx, horizon: ctx.opts.horizon || DEFAULT_HORIZON, risk: ctx.opts.risk });
      }
      const held = ctx.squadState.picks.map(p => p.playerId);
      const strength = buildStrength(ctx.gameState, { asOfGw: ctx.gw });
      const pool = candidatePool(ctx.gameState, ctx.dataset, ctx.gw, held, 0);
      const projections = buildProjections({
        gameState: ctx.gameState, strength, gwFrom: ctx.gw, gwTo: ctx.gw, playerIds: pool,
      });
      return holdPlan({ ...ctx, projections, held });
    },
  },
  'greedy-xp': {
    key: 'greedy-xp',
    label: 'Highest expected points, one gameweek at a time',
    decide: (ctx) => plannerDecide({ ...ctx, horizon: 1, risk: ctx.opts.risk }),
  },
  fdr: {
    key: 'fdr',
    label: 'Naive fixture difficulty',
    decide: (ctx) => plannerDecide({ ...ctx, horizon: ctx.opts.horizon || DEFAULT_HORIZON, projectionsKind: 'naive', risk: ctx.opts.risk }),
  },
};

function holdPlan({ gameState, squadState, rules, gw, projections, held }) {
  const lineup = optimizeLineup(held, projections, gw, rules, { gameState });
  const captaincy = chooseCaptain(lineup.startingXI, projections, gw, gameState);
  return {
    gw,
    chip: null,
    transfersOut: [],
    transfersIn: [],
    transferCount: 0,
    freeTransfersUsed: 0,
    freeTransfersAfter: squadState.freeTransfers,
    hits: 0,
    hitCostPoints: 0,
    bankBeforeTenths: squadState.bankTenths,
    moneyInTenths: 0,
    moneyOutTenths: 0,
    bankAfterTenths: squadState.bankTenths,
    squadValueAfterTenths: squadState.squadValueTenths,
    squad: held.slice(),
    startingXI: lineup.startingXI,
    formation: lineup.formation,
    bench: lineup.bench,
    captain: captaincy.captain,
    viceCaptain: captaincy.viceCaptain,
    xPointsGw: lineup.xPoints,
    xPointsNet: lineup.xPoints,
    xPointsHorizon: lineup.xPoints,
    sd: lineup.sd,
    explanation: null,
    alternatives: [],
    computedAt: new Date(0).toISOString(),
    modelVersion: projections.modelVersion,
    horizon: 1,
    durationMs: 0,
  };
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

export async function replaySeason({ dataset, season, strategy, rules, opts = {} }) {
  const strat = typeof strategy === 'string' ? STRATEGIES[strategy] : strategy;
  if (!strat) throw new Error(`backtest: unknown strategy "${strategy}"`);

  const gwFrom = opts.gwFrom || 1;
  const gwTo = Math.min(opts.gwTo || dataset.maxGw, dataset.maxGw);
  // WHICH EVIDENCE REGIME. `production` rebuilds the payloads the app reads at
  // each deadline and resolves them through engine/world.js, so the previous
  // season reaches the projections exactly as it reaches the page. `seeded` is
  // the replay's historical rule (half of the previous season in every total,
  // never retired), kept so entries measured under it can be re-measured. The
  // scripts that decide (experiment.mjs, backtest.mjs) default to production.
  const regime = opts.evidenceRegime || EVIDENCE_REGIMES.SEEDED;
  if (!Object.values(EVIDENCE_REGIMES).includes(regime)) {
    throw new Error(`backtest: unknown evidence regime "${regime}"`);
  }
  const production = regime === EVIDENCE_REGIMES.PRODUCTION;
  // A seeding weight has no meaning when nothing is seeded. Ignoring it would
  // turn every arm of a weight sweep into the same replay and report a clean
  // null, so it is refused instead.
  if (production && opts.priorSeasonWeight !== undefined) {
    throw new Error('backtest: priorSeasonWeight only exists in the seeded evidence regime; '
      + 'set evidenceRegime: "seeded" to measure it');
  }
  const priorWeight = production
    ? 0
    : (opts.priorSeasonWeight === undefined ? PRIOR_SEASON_WEIGHT : opts.priorSeasonWeight);
  const accumulator = createAccumulator(dataset, {
    priorDataset: production ? null : (opts.priorDataset || null),
    priorWeight,
  });
  for (let gw = 1; gw < gwFrom; gw++) accumulator.absorb(gw);
  const priorDataset = opts.priorDataset || null;
  const preseasonTotals = production && priorDataset ? preseasonTotalsFor(dataset, priorDataset) : null;
  const asset = production && priorDataset
    ? priorSeasonAsset(dataset, priorDataset, { firstDeadline: eventDeadlines(dataset).get(1) })
    : null;

  // Availability, in order of preference: an index the caller built, records
  // the caller supplied, or the downloaded season file when the environment
  // asks for it.
  //
  // THE DEFAULT IS OFF, AND THAT IS A RESULT, NOT AN OVERSIGHT. Feeding the
  // signal in improves the minutes model on every metric it has (start log
  // loss, Brier, calibration, expected-minutes error, in all three seasons) and
  // does NOT improve planner points: it gained 33 and 276 points in 2022-23 and
  // 2023-24 and lost 291 in 2024-25. experiments/availability-minutes.md holds
  // the numbers and the reasoning. Reproduce either side with:
  //
  //   FPL_AVAILABILITY=1 node apps/fpl-planner/scripts/backtest.mjs --season 2024-25
  let availability = opts.availability === undefined ? null : opts.availability;
  if (opts.availability === undefined) {
    if (opts.availabilityRecords) availability = buildAvailabilityIndex(dataset, opts.availabilityRecords);
    else if (availabilityEnvEnabled()) availability = await loadAvailabilityIndex(dataset, season || dataset.season);
  }

  const squad = emptySquad(rules, gwFrom);
  const gws = [];
  const chipEvents = [];
  const transferLedger = [];
  const startedAt = Date.now();
  let modelVersion = null;

  for (let gw = gwFrom; gw <= gwTo; gw++) {
    const gameState = production
      ? productionGameStateAt(dataset, gw, {
        rules, accumulator, preseasonTotals, asset, availability, featureHook: opts.featureHook || null,
        fixtureLead: opts.fixtureLead === undefined ? FIXTURE_ANNOUNCE_LEAD : opts.fixtureLead,
      }).gameState
      : gameStateAt(dataset, gw, {
        rules, accumulator, featureHook: opts.featureHook || null, availability,
      });
    const squadState = toSquadState(squad, { gw, gameState, rules, label: strat.label });

    let plan;
    try {
      plan = await strat.decide({ gameState, squadState, rules, gw, opts, dataset });
    } catch (err) {
      throw new Error(`backtest: ${strat.key} failed at gameweek ${gw}: ${err.message}`);
    }
    modelVersion = modelVersion || plan.modelVersion;

    const scored = scoreGameweek({ dataset, gw, plan, rules });
    if (plan.chip) chipEvents.push({ chip: plan.chip, gw, squadBefore: squadState.picks.map(p => p.playerId), plan });
    if (plan.transferCount) {
      transferLedger.push({
        gw,
        out: plan.transfersOut.slice(),
        in: plan.transfersIn.slice(),
        hits: plan.hits,
        hitCostPoints: plan.hitCostPoints,
      });
    }

    gws.push({
      gw,
      points: scored.points,
      netPoints: scored.netPoints,
      xiPoints: scored.xiPoints,
      benchPoints: scored.benchPoints,
      captain: scored.captain,
      captainName: nameFor(dataset, scored.captain),
      captainBase: scored.captainBase,
      captainExtra: scored.captainExtra,
      captaincyValue: scored.captaincyValue,
      captainFromVice: scored.captainFromVice,
      autoSubs: scored.autoSubs.length,
      autoSubPoints: scored.autoSubPoints,
      chip: plan.chip,
      transfers: plan.transferCount,
      hits: plan.hits,
      hitCostPoints: plan.hitCostPoints,
      projectedPoints: plan.xPointsGw,
      bankTenths: plan.bankAfterTenths,
      squadValueTenths: plan.squadValueAfterTenths,
      // JSON has no Infinity, so the pre-season allowance is reported as null
      // rather than round-tripping into one by accident.
      freeTransfers: Number.isFinite(squadState.freeTransfers) ? squadState.freeTransfers : null,
    });

    applyDecision(squad, plan, { gameState, rules });
    accumulator.absorb(gw);
  }

  const totals = summarize({ gws, dataset, transferLedger, chipEvents, rules });

  return {
    version: BACKTEST_VERSION,
    season: season || dataset.season,
    strategy: strat.key,
    label: strat.label,
    generatedAt: new Date().toISOString(),
    modelVersion,
    durationMs: Date.now() - startedAt,
    opts: {
      gwFrom, gwTo,
      horizon: opts.horizon || DEFAULT_HORIZON,
      risk: opts.risk || 'balanced',
      poolSize: opts.poolSize || DEFAULT_POOL_SIZE,
      priorSeason: opts.priorDataset ? opts.priorDataset.season : null,
      evidenceRegime: regime,
      // Which calendar the production regime replayed: the lead in gameweeks
      // a reschedule was known ahead (THE CALENDAR AS IT WAS KNOWN), or null
      // for the final list.
      fixtureLead: regime === EVIDENCE_REGIMES.PRODUCTION
        ? (opts.fixtureLead === undefined ? FIXTURE_ANNOUNCE_LEAD : opts.fixtureLead)
        : null,
      priorSeasonWeight: production ? null : priorWeight,
      // Gameweeks whose starts column was absent from the archive and had to be
      // reconstructed. Non-null means the season is 2022-23, where FPL added
      // the column at gameweek 16.
      startsReconstructed: dataset.startsReconstructed,
      // How many of the replayed season's players were matched to the season
      // before, and by what. A replay that seeded nothing is a different
      // experiment from one that seeded everything, and it should not take a
      // rerun to find out which one produced a number.
      priorJoin: accumulator.priorJoin,
      seed: opts.seed === undefined ? 1 : opts.seed,
      availability: availability
        ? {
          records: availability.stats.records,
          matchedRecords: availability.stats.matchedRecords,
          players: availability.stats.players,
        }
        : null,
    },
    gws,
    totals,
  };
}

function nameFor(dataset, playerId) {
  const p = dataset.players.get(playerId);
  return p ? p.name : null;
}

function summarize({ gws, dataset, transferLedger, chipEvents, rules }) {
  const seasonPoints = gws.reduce((s, g) => s + g.netPoints, 0);
  const grossPoints = gws.reduce((s, g) => s + g.points, 0);
  const hitPoints = gws.reduce((s, g) => s + g.hitCostPoints, 0);
  const transfers = gws.reduce((s, g) => s + g.transfers, 0);
  const hits = gws.reduce((s, g) => s + g.hits, 0);

  // Hit efficiency: what the players bought on a hit actually did against what
  // the players sold actually did, over the window the hit was taken for,
  // divided by what the hits cost.
  let hitGain = 0;
  for (const entry of transferLedger) {
    if (!entry.hits) continue;
    for (let k = 0; k < HIT_MEASURE_GWS; k++) {
      const g = entry.gw + k;
      if (g > dataset.maxGw) break;
      for (const id of entry.in) hitGain += actualPoints(dataset, g, id);
      for (const id of entry.out) hitGain -= actualPoints(dataset, g, id);
    }
  }

  const chips = chipEvents.map(entry => ({
    chip: entry.chip,
    gw: entry.gw,
    value: chipValue(entry, dataset, gws, rules),
    ...(entry.chip === 'bboost' ? { benchDoubles: benchDoubles(entry, dataset) } : {}),
  }));

  return {
    gwCount: gws.length,
    seasonPoints,
    grossPoints,
    meanGwPoints: gws.length ? seasonPoints / gws.length : 0,
    bestGw: gws.reduce((m, g) => (g.netPoints > m.points ? { gw: g.gw, points: g.netPoints } : m), { gw: null, points: -Infinity }),
    worstGw: gws.reduce((m, g) => (g.netPoints < m.points ? { gw: g.gw, points: g.netPoints } : m), { gw: null, points: Infinity }),
    transfers,
    hits,
    hitPoints,
    hitGain,
    hitEfficiency: hitPoints ? hitGain / hitPoints : null,
    captainPoints: gws.reduce((s, g) => s + g.captainExtra, 0),
    captaincyValue: gws.reduce((s, g) => s + g.captaincyValue, 0),
    captainFromVice: gws.filter(g => g.captainFromVice).length,
    benchPoints: gws.reduce((s, g) => s + g.benchPoints, 0),
    autoSubs: gws.reduce((s, g) => s + g.autoSubs, 0),
    autoSubPoints: gws.reduce((s, g) => s + g.autoSubPoints, 0),
    chips,
    chipPoints: chips.reduce((s, c) => s + (c.value || 0), 0),
    finalBankTenths: gws.length ? gws[gws.length - 1].bankTenths : 0,
    finalSquadValueTenths: gws.length ? gws[gws.length - 1].squadValueTenths : 0,
    meanProjectedPoints: gws.length ? gws.reduce((s, g) => s + g.projectedPoints, 0) / gws.length : 0,
    projectionBias: gws.length
      ? gws.reduce((s, g) => s + (g.projectedPoints - g.points), 0) / gws.length
      : 0,
    // The same number with the auto-substitutions taken off the actual side.
    //
    // A plan's projection is the ELEVEN it picked, plus the armband, and
    // deliberately not the bench cover it might fall back on (see the header of
    // squadObjective in lineup.js). The realized score includes whatever the
    // bench recovered, so the raw bias above charges the model for points its
    // number never claimed: about 4.7 a gameweek in 2024-25. This is the
    // like-for-like comparison, and it is the one to quote as calibration.
    projectionBiasExAutosubs: gws.length
      ? gws.reduce((s, g) => s + (g.projectedPoints - (g.points - g.autoSubPoints)), 0) / gws.length
      : 0,
  };
}

// What a chip actually returned. Bench boost and triple captain are observed
// directly. Wildcard and free hit need a counterfactual, and it is stated as
// one: the squad held before the chip, fielding its own best eleven, with no
// further transfers.
// How many of a boosted bench's four players had two matches that week, which
// is what separates a bench built for a double gameweek from an ordinary one
// (registry entry 33).
function benchDoubles(entry, dataset) {
  const bench = entry.plan && entry.plan.bench ? [entry.plan.bench.gk, ...entry.plan.bench.order] : [];
  let doubles = 0;
  for (const id of bench) {
    const player = dataset.players.get(id);
    if (!player) continue;
    // The archive has one row per player per club match, so this is right for
    // a player who changed clubs mid-season, where his end-of-season club is not.
    const matches = player.rows.filter(r => r.gw === entry.gw).length;
    if (matches >= 2) doubles++;
  }
  return doubles;
}

function chipValue(entry, dataset, gws, rules) {
  const row = gws.find(g => g.gw === entry.gw);
  if (!row) return 0;
  if (entry.chip === 'bboost') return row.benchPoints;
  if (entry.chip === '3xc') return row.captainBase;

  const before = entry.squadBefore;
  if (!before.length) return 0;
  const window = entry.chip === 'freehit' ? 1 : Math.min(HIT_MEASURE_GWS, dataset.maxGw - entry.gw + 1);

  let held = 0;
  let actual = 0;
  for (let k = 0; k < window; k++) {
    const gw = entry.gw + k;
    const scored = gws.find(g => g.gw === gw);
    if (!scored) break;
    actual += scored.points;
    held += bestElevenActual(before, dataset, gw, rules);
  }
  return actual - held;
}

// The best legal eleven the counterfactual squad could have fielded, scored on
// actual results. It is an upper bound on what holding would have produced,
// which keeps the chip's measured value conservative rather than flattering.
function bestElevenActual(squadIds, dataset, gw, rules) {
  const byPosition = { 1: [], 2: [], 3: [], 4: [] };
  for (const id of squadIds) {
    const p = dataset.players.get(id);
    if (!p) continue;
    byPosition[p.position].push(actualPoints(dataset, gw, id));
  }
  for (const list of Object.values(byPosition)) list.sort((a, b) => b - a);

  let total = 0;
  let slots = rules.starters;
  const taken = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const p of Object.values(rules.positions)) {
    for (let i = 0; i < p.minPlay && i < byPosition[p.id].length; i++) {
      total += byPosition[p.id][i];
      taken[p.id]++;
      slots--;
    }
  }
  const rest = [];
  for (const p of Object.values(rules.positions)) {
    for (let i = taken[p.id]; i < Math.min(p.maxPlay, byPosition[p.id].length); i++) {
      rest.push(byPosition[p.id][i]);
    }
  }
  rest.sort((a, b) => b - a);
  for (let i = 0; i < slots && i < rest.length; i++) total += rest[i];
  return total;
}

// ---------------------------------------------------------------------------

export function compareStrategies({ primary, baselines }) {
  const above = {};
  for (const report of baselines) {
    above[report.strategy] = {
      label: report.label,
      seasonPoints: report.totals.seasonPoints,
      delta: primary.totals.seasonPoints - report.totals.seasonPoints,
      meanGwDelta: primary.totals.meanGwPoints - report.totals.meanGwPoints,
    };
  }
  return {
    version: BACKTEST_VERSION,
    season: primary.season,
    generatedAt: new Date().toISOString(),
    primary: {
      strategy: primary.strategy,
      label: primary.label,
      seasonPoints: primary.totals.seasonPoints,
      meanGwPoints: primary.totals.meanGwPoints,
    },
    aboveBaseline: above,
  };
}
