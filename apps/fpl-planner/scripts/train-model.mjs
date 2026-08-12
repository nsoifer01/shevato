#!/usr/bin/env node
// Train and select the FPL Planner's statistical models.
//
// WHAT THIS DOES
//   1. Reads the per-gameweek historical seasons downloaded by
//      fetch-history.mjs (never committed, see .gitignore).
//   2. Builds one training row per player per gameweek, using ONLY information
//      that existed before that gameweek's deadline. The rules for that are in
//      SAME_GW_ALLOWED_COLUMNS below and are enforced by tests/leakage.test.mjs,
//      which watches every property access the feature builder makes.
//   3. Fits candidate models for two targets (points, and whether the player
//      starts), compares them out of sample against a documented baseline, and
//      picks the winner BY VALIDATION METRIC.
//   4. Writes a versioned artifact into models/ and updates models/index.json.
//      A new artifact never overwrites an old one.
//
// Deterministic: the same data and the same seed produce the same artifact
// apart from the trainedAt timestamp.
//
// Usage:
//   node apps/fpl-planner/scripts/train-model.mjs
//   node apps/fpl-planner/scripts/train-model.mjs --seasons 2023-24,2024-25
//   node apps/fpl-planner/scripts/train-model.mjs --seed 7

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ridge, poissonRegression, logisticRegression, linearPredict, calibrate, metrics } from '../js/engine/ml.js';
import { DATA_DIR, ensureSeasons, seasonPath } from './fetch-history.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MODELS_DIR = path.join(HERE, '..', 'models');

export const DATASET_VERSION = 'vaastav-merged-gw-1';

// fv2 differs from fv1 in three ways, all of them fixes rather than additions:
// the position column is normalized (the CSV writes GK, the feature builder was
// testing for GKP, so `isGkp` was dead and weighted exactly 0 in every v1
// candidate), non-footballers are dropped, and the season schema is checked
// before a row is built. The feature NAMES are unchanged. An artifact records
// which builder produced it so evaluate-model.mjs can refuse to re-score an
// artifact with a builder that has since moved.
export const FEATURE_VERSION = 'fv2';
export const MODEL_VERSION_PREFIX = 'fpl-planner';

// See fetch-history.mjs for why the history starts at 2022-23 and not earlier.
const DEFAULT_SEASONS = ['2022-23', '2023-24', '2024-25', '2025-26'];
const DEFAULT_SEED = 20260810;

// A player needs this many played gameweeks behind them before a row is usable.
// Below it the season-to-date features are pure noise.
const MIN_PRIOR_GWS = 3;

// Window for the "recent form" features, in gameweeks.
const RECENT_WINDOW = 5;

// Where the last season is split. Everything before the validation start is
// training, and the test block is never looked at until the winner is chosen.
const VALIDATION_START_GW = 20;
const TEST_START_GW = 30;

const RIDGE_LAMBDAS = [1, 10, 100, 1000];
const POISSON_LAMBDAS = [1, 10, 100];
const LOGISTIC_LAMBDAS = [1, 10, 100];

// ---------------------------------------------------------------------------
// RECENCY WEIGHTING
//
// Every training row used to count the same regardless of age, which assumes
// four seasons of the same game. They are not the same game. 2024-25 raised the
// free transfer cap from 2 to 5 and split the chips into two half-season sets;
// 2025-26 added defensive-contribution scoring, worth 2 points to any outfield
// player over a threshold. A 2022-23 row is still evidence about how footballers
// accumulate returns, it is just weaker evidence about how they score points
// now, so each row carries
//
//   weight = 0.5 ** (seasonsOld / SEASON_HALF_LIFE_SEASONS)
//
// with seasonsOld counted back from the newest season in the training set. A
// half life of null means OFF, every row weighted 1, which is what v1 did.
//
// The value that ships is chosen by validation metric, per target, not by taste.
// The whole grid and what each value scored is written into the artifact, so if
// weighting turns out not to help it is visible that it was measured and turned
// off rather than never tried.
// ---------------------------------------------------------------------------

// 0.25 is here to check that the selected value is not sitting on the edge of
// its own search. A parameter pinned at the boundary of the grid it was chosen
// from has not been measured, it has been truncated.
export const SEASON_HALF_LIFE_GRID = [null, 2, 1, 0.5, 0.25, 0.125];

export function seasonWeights(seasons, halfLifeSeasons) {
  const newest = seasons.length - 1;
  const out = new Map();
  for (let i = 0; i < seasons.length; i++) {
    const age = newest - i;
    out.set(seasons[i], halfLifeSeasons === null ? 1 : 0.5 ** (age / halfLifeSeasons));
  }
  return out;
}

export function rowWeights(rows, seasons, halfLifeSeasons) {
  if (halfLifeSeasons === null) return null;
  const bySeason = seasonWeights(seasons, halfLifeSeasons);
  return rows.map(r => bySeason.get(r.season) ?? 1);
}

// ---------------------------------------------------------------------------
// SCHEMA AND REGIME SAFETY
//
// The CSV schema is not stable across seasons. 2024-25 added seven mng_* columns
// for assistant managers and dropped them again in 2025-26; 2025-26 added
// defensive_contribution, tackles, recoveries and
// clearances_blocks_interceptions. An absent column parses to the empty string,
// and num('') is 0, so a feature that read one of those would report "this
// player made zero tackles" for three seasons in which nobody counted tackles.
// Those are different statements and conflating them poisons the fit.
//
// Two rules, both enforced rather than documented:
//
//   1. REQUIRED_COLUMNS must physically exist in every season loaded, checked
//      against the real header before a single row is built. A season missing
//      one fails the run instead of training on zeros.
//   2. No feature may read anything outside REQUIRED_COLUMNS. The two lists are
//      disjoint by assertion in tests/schema.test.mjs, which also proves the
//      built features do not move when the season-specific columns are removed.
// ---------------------------------------------------------------------------

export const REQUIRED_COLUMNS = Object.freeze([
  // Identity and fixture, all fixed before the deadline.
  'element', 'name', 'position', 'team', 'GW', 'fixture', 'opponent_team', 'was_home', 'value',
  // Prior-gameweek inputs to the features.
  'minutes', 'starts', 'expected_goals', 'expected_assists', 'expected_goals_conceded',
  'bps', 'saves', 'total_points',
  // The scoreline, read only through buildTeamHistory's strictly-earlier accessor.
  'team_h_score', 'team_a_score',
]);

// Columns that exist in some seasons and not others. Nothing here may appear in
// REQUIRED_COLUMNS, and no feature may read any of them.
export const SEASON_SPECIFIC_COLUMNS = Object.freeze({
  defensive_contribution: '2025-26 onward, when defensive-contribution scoring was introduced',
  tackles: '2025-26 onward',
  recoveries: '2025-26 onward',
  clearances_blocks_interceptions: '2025-26 onward',
  mng_win: '2024-25 only, assistant managers',
  mng_draw: '2024-25 only, assistant managers',
  mng_loss: '2024-25 only, assistant managers',
  mng_clean_sheets: '2024-25 only, assistant managers',
  mng_goals_scored: '2024-25 only, assistant managers',
  mng_underdog_win: '2024-25 only, assistant managers',
  mng_underdog_draw: '2024-25 only, assistant managers',
  modified: '2024-25 only',
});

export function missingColumns(header) {
  const present = new Set(header || []);
  return REQUIRED_COLUMNS.filter(c => !present.has(c));
}

// The CSV writes goalkeepers as GK. v1's feature builder tested for GKP, so
// `isGkp` was 0 on every row of every season and carried a weight of exactly 0
// in every stored candidate: a feature in name only. Positions are normalized
// here so that is impossible to reintroduce silently.
//
// Anything NOT in this map is not a footballer. 2024-25 is the only season that
// ever had assistant managers (position "AM", 322 rows from gameweek 23 on).
// They never record minutes or starts, so every feature describing them is
// zero, and every point they scored came from the mng_* columns no other season
// has. They are dropped: keeping them would put a scoring system that has since
// been abolished into both the training set and the held-out block, where the
// carried-forward baseline can predict them and no feature-based model can.
const POSITION_ALIASES = Object.freeze({
  GK: 'GKP', GKP: 'GKP', DEF: 'DEF', MID: 'MID', FWD: 'FWD',
});

export function normalizePosition(raw) {
  return POSITION_ALIASES[String(raw || '').trim().toUpperCase()] || null;
}

// ---------------------------------------------------------------------------
// LEAKAGE CONTROL
//
// These are the only columns of the gameweek being PREDICTED that a feature may
// read. Every one of them is fixed before the deadline: who the fixture is
// against, whether it is at home, the player's price and their position. Every
// other column in the row (minutes, points, goals, bonus, bps, the scoreline,
// expected goals, transfers, selection) is an OUTCOME of that gameweek and may
// only be read from strictly earlier gameweeks.
// ---------------------------------------------------------------------------

export const SAME_GW_ALLOWED_COLUMNS = Object.freeze([
  'element', 'name', 'position', 'team', 'GW', 'round',
  'fixture', 'opponent_team', 'was_home', 'kickoff_time', 'value',
]);

export const FEATURE_NAMES = Object.freeze([
  'nineties', 'minutesPerGw', 'startRate', 'xg90', 'xa90', 'bps90', 'saves90', 'xgc90',
  'pointsPerGame',
  'recentMinutes', 'recentStartRate', 'recentXg90', 'recentXa90', 'recentPointsPerGame',
  'wasHome', 'priceMillions',
  'isGkp', 'isDef', 'isMid', 'isFwd',
  'oppConcededPerMatch', 'oppScoredPerMatch', 'teamScoredPerMatch', 'teamConcededPerMatch',
]);

export const BASELINE_DESCRIPTION =
  'Season points per game carried forward: predict this gameweek with the mean points '
  + 'the player has scored per played gameweek so far this season.';

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

export function parseCsv(text) {
  const rows = [];
  let header = null;
  let field = '';
  let record = [];
  let inQuotes = false;

  const pushField = () => {
    record.push(field);
    field = '';
  };
  const pushRecord = () => {
    if (record.length === 1 && record[0] === '') {
      record = [];
      return;
    }
    if (!header) header = record;
    else {
      const obj = {};
      for (let i = 0; i < header.length; i++) obj[header[i]] = record[i] === undefined ? '' : record[i];
      rows.push(obj);
    }
    record = [];
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') pushField();
    else if (c === '\n') {
      pushField();
      pushRecord();
    } else if (c !== '\r') field += c;
  }
  if (field.length || record.length) {
    pushField();
    pushRecord();
  }
  return { header, rows };
}

// ---------------------------------------------------------------------------
// DUPLICATE ROWS
//
// The upstream per-gameweek files are concatenations of weekly snapshots, and a
// handful of rows are emitted twice: 10 in 2025-26 (gameweeks 1-8) are
// character-for-character identical to another row in the same file. A repeated
// row is not extra evidence. It would be counted twice in the player's prior
// history (inflating minutes, points and starts for every later gameweek) and
// would produce a second identical training example, giving that observation
// twice the weight of every other one for no reason.
//
// The distinction that matters: same player, same gameweek is NORMAL. A double
// gameweek is two real matches, with different `fixture` ids and different
// opponents, and there are several hundred of them per season. Those rows are
// evidence and must survive. So the signature covers EVERY column, and only a
// row that is identical in all of them is dropped.
export function rowSignature(row, columns) {
  // A separator that never appears in the source CSV, so a row whose columns
  // concatenate to the same string as another row's cannot collide with it.
  return columns.map(c => (row[c] === undefined ? '' : row[c])).join('\u0001');
}

export function dedupeRows(rows) {
  if (!rows.length) return { rows, duplicates: 0 };
  const columns = Object.keys(rows[0]).sort();
  const seen = new Set();
  const kept = [];
  let duplicates = 0;
  for (const row of rows) {
    const signature = rowSignature(row, columns);
    if (seen.has(signature)) {
      duplicates++;
      continue;
    }
    seen.add(signature);
    kept.push(row);
  }
  return { rows: kept, duplicates };
}

const num = (v) => {
  if (v === '' || v === undefined || v === null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const bool = (v) => v === 'True' || v === 'true' || v === '1' || v === true;

// ---------------------------------------------------------------------------
// Feature building
// ---------------------------------------------------------------------------

// Per-club scored/conceded by gameweek, built from the rows themselves. Read
// only through `before`, which sums strictly earlier gameweeks.
function buildTeamHistory(rows) {
  const seen = new Set();
  const byTeam = new Map();
  for (const r of rows) {
    const team = r.team;
    const fixture = r.fixture;
    const key = `${team}|${fixture}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const home = bool(r.was_home);
    const scored = home ? num(r.team_h_score) : num(r.team_a_score);
    const conceded = home ? num(r.team_a_score) : num(r.team_h_score);
    if (!byTeam.has(team)) byTeam.set(team, []);
    byTeam.get(team).push({ gw: num(r.GW), scored, conceded });
  }
  const prefix = new Map();
  for (const [team, matches] of byTeam) {
    matches.sort((a, b) => a.gw - b.gw);
    prefix.set(team, matches);
  }
  return {
    before(team, gw) {
      const matches = prefix.get(team);
      if (!matches) return { matches: 0, scored: 0, conceded: 0 };
      let n = 0;
      let s = 0;
      let c = 0;
      for (const m of matches) {
        if (m.gw >= gw) break;
        n++;
        s += m.scored;
        c += m.conceded;
      }
      return { matches: n, scored: s, conceded: c };
    },
  };
}

// Team history is derived from OUTCOME columns, so it must be built from a
// copy of the rows that the leakage watcher does not see as same-gameweek
// access. It is only ever queried with `before(team, gw)`, which is the same
// strictly-earlier rule the player features follow.
function accumulate(rows) {
  const acc = {
    count: 0, minutes: 0, starts: 0, xg: 0, xa: 0, bps: 0, saves: 0, xgc: 0, points: 0,
  };
  for (const r of rows) {
    acc.count++;
    acc.minutes += num(r.minutes);
    acc.starts += num(r.starts);
    acc.xg += num(r.expected_goals);
    acc.xa += num(r.expected_assists);
    acc.bps += num(r.bps);
    acc.saves += num(r.saves);
    acc.xgc += num(r.expected_goals_conceded);
    acc.points += num(r.total_points);
  }
  return acc;
}

const per90 = (value, minutes) => (minutes > 0 ? (value * 90) / minutes : 0);

export function featureVector(priorRows, targetRow, teamHistory) {
  const all = accumulate(priorRows);
  const recent = accumulate(priorRows.slice(-RECENT_WINDOW));
  const gw = num(targetRow.GW);
  const position = normalizePosition(targetRow.position);
  const opp = teamHistory.before(String(targetRow.opponent_team), gw);
  const own = teamHistory.before(String(targetRow.team), gw);

  return [
    all.minutes / 90,
    all.count ? all.minutes / all.count : 0,
    all.count ? all.starts / all.count : 0,
    per90(all.xg, all.minutes),
    per90(all.xa, all.minutes),
    per90(all.bps, all.minutes),
    per90(all.saves, all.minutes),
    per90(all.xgc, all.minutes),
    all.count ? all.points / all.count : 0,
    recent.count ? recent.minutes / recent.count : 0,
    recent.count ? recent.starts / recent.count : 0,
    per90(recent.xg, recent.minutes),
    per90(recent.xa, recent.minutes),
    recent.count ? recent.points / recent.count : 0,
    bool(targetRow.was_home) ? 1 : 0,
    num(targetRow.value) / 10,
    position === 'GKP' ? 1 : 0,
    position === 'DEF' ? 1 : 0,
    position === 'MID' ? 1 : 0,
    position === 'FWD' ? 1 : 0,
    opp.matches ? opp.conceded / opp.matches : 0,
    opp.matches ? opp.scored / opp.matches : 0,
    own.matches ? own.scored / own.matches : 0,
    own.matches ? own.conceded / own.matches : 0,
  ];
}

// One row per player per gameweek. `teamHistoryRows` defaults to `rows` and is
// only passed separately by the leakage test, which needs to watch the player
// rows without the club aggregate tripping the watcher on its own bookkeeping.
//
// GROUPING KEY. `element` groups a player's gameweeks correctly INSIDE a season
// and means nothing across one: FPL reassigns it every year, and an id shared by
// two consecutive seasons is the same footballer 0.0-0.13% of the time. This
// function is only ever called with a single season's rows, so the grouping is
// sound, but the rows it returns are concatenated across seasons by
// buildDataset. A bare "403" in that combined array would be four different
// players wearing one label, so the key carries its season and is useless to
// anything that tries to group across one. See js/engine/player-identity.js.
export const playerKeyFor = (season, element) => `${season}:${element}`;

export function buildFeatureRows(rows, { season, teamHistoryRows } = {}) {
  const teamHistory = buildTeamHistory(teamHistoryRows || rows);

  const byPlayer = new Map();
  for (const r of rows) {
    if (normalizePosition(r.position) === null) continue;
    const key = playerKeyFor(season, r.element);
    if (!byPlayer.has(key)) byPlayer.set(key, []);
    byPlayer.get(key).push(r);
  }

  const out = [];
  for (const [playerKey, playerRows] of byPlayer) {
    playerRows.sort((a, b) => num(a.GW) - num(b.GW));
    for (let i = MIN_PRIOR_GWS; i < playerRows.length; i++) {
      const target = playerRows[i];
      const prior = playerRows.slice(0, i);
      const priorAcc = accumulate(prior);
      out.push({
        season,
        gw: num(target.GW),
        playerKey,
        position: normalizePosition(target.position),
        features: featureVector(prior, target, teamHistory),
        // Targets. Read from the target row on purpose: this is y, not X.
        targetPoints: num(target.total_points),
        targetStart: num(target.starts) > 0 ? 1 : 0,
        targetMinutes: num(target.minutes),
        // The documented baseline, carried alongside so it is scored on exactly
        // the same rows as the models.
        baselinePoints: priorAcc.count ? priorAcc.points / priorAcc.count : 0,
        baselineStartRate: priorAcc.count ? priorAcc.starts / priorAcc.count : 0,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Dataset loading and splitting
// ---------------------------------------------------------------------------

export function loadSeasonRows(season) {
  const file = seasonPath(season);
  const text = fs.readFileSync(file, 'utf8');
  const { header, rows } = parseCsv(text);
  const missing = missingColumns(header);
  if (missing.length) {
    throw new Error(
      `Season ${season} is missing ${missing.length} column(s) the feature builder reads: ${missing.join(', ')}\n\n`
      + 'This is a refusal, not a warning. An absent column parses to 0, so training on this\n'
      + 'season would tell the model those players recorded none of that statistic instead of\n'
      + 'that nobody recorded it. Expected goals, expected assists and starts were introduced\n'
      + 'in 2022-23, which is why the season list starts there. See fetch-history.mjs.',
    );
  }
  return rows;
}

export function buildDataset(seasons) {
  const rows = [];
  const excluded = [];
  const duplicates = [];
  for (const season of seasons) {
    // Collapsed before anything else looks at the season, so a repeated row
    // cannot reach the prior-history accumulator or the training set.
    const { rows: seasonRows, duplicates: duplicateRows } = dedupeRows(loadSeasonRows(season));
    if (duplicateRows) duplicates.push({ season, rows: duplicateRows });
    const positions = new Map();
    for (const r of seasonRows) {
      if (normalizePosition(r.position) === null) {
        const p = String(r.position || '(blank)');
        positions.set(p, (positions.get(p) || 0) + 1);
      }
    }
    if (positions.size) {
      excluded.push({
        season,
        rows: [...positions.values()].reduce((a, b) => a + b, 0),
        positions: [...positions.entries()].map(([position, count]) => ({ position, count })),
      });
    }
    rows.push(...buildFeatureRows(seasonRows, { season }));
  }
  return { rows, excluded, duplicates };
}

// Chronological split, never random. A random split would put a player's
// gameweek 30 in training and their gameweek 29 in test, which leaks through
// the season-to-date features and flatters every model.
//
// `evalSeasonInTrain: false` drops the newest season's early gameweeks instead
// of training on them, leaving the validation and test blocks exactly where they
// were. That is the ablation arm that answers "what is the newest season worth",
// because it holds the evaluation set fixed and varies only the training data.
export function splitRows(rows, seasons, { evalSeasonInTrain = true, trainSeasons = null } = {}) {
  const lastSeason = seasons[seasons.length - 1];
  const allowTrain = trainSeasons ? new Set(trainSeasons) : null;
  const train = [];
  const validation = [];
  const test = [];
  for (const r of rows) {
    if (r.season !== lastSeason) {
      if (!allowTrain || allowTrain.has(r.season)) train.push(r);
    } else if (r.gw < VALIDATION_START_GW) {
      if (evalSeasonInTrain) train.push(r);
    } else if (r.gw < TEST_START_GW) validation.push(r);
    else test.push(r);
  }
  const priorSeasons = seasons.slice(0, -1).filter(s => !allowTrain || allowTrain.has(s));
  const priorText = priorSeasons.length ? `${priorSeasons.join(', ')} plus ` : '';
  return {
    train,
    validation,
    test,
    trainSeasons: [...new Set(train.map(r => r.season))],
    periods: {
      train: evalSeasonInTrain
        ? `${priorText}${lastSeason} GW ${MIN_PRIOR_GWS + 1}-${VALIDATION_START_GW - 1}`
        : `${priorSeasons.join(', ')} only, no ${lastSeason} rows`,
      validation: `${lastSeason} GW ${VALIDATION_START_GW}-${TEST_START_GW - 1}`,
      test: `${lastSeason} GW ${TEST_START_GW}-38`,
    },
  };
}

// ---------------------------------------------------------------------------
// Standardization. Fitted on TRAIN ONLY, then applied everywhere, because
// fitting it on the full dataset would leak test-set distribution into
// training.
// ---------------------------------------------------------------------------

export function fitScaler(rows) {
  const d = rows[0].features.length;
  const mean = new Array(d).fill(0);
  const sd = new Array(d).fill(0);
  for (const r of rows) for (let j = 0; j < d; j++) mean[j] += r.features[j];
  for (let j = 0; j < d; j++) mean[j] /= rows.length;
  for (const r of rows) {
    for (let j = 0; j < d; j++) {
      const v = r.features[j] - mean[j];
      sd[j] += v * v;
    }
  }
  for (let j = 0; j < d; j++) {
    sd[j] = Math.sqrt(sd[j] / rows.length);
    if (!(sd[j] > 1e-9)) sd[j] = 1;
  }
  return { mean, sd };
}

export function applyScaler(scaler, features) {
  const out = new Array(features.length);
  for (let j = 0; j < features.length; j++) out[j] = (features[j] - scaler.mean[j]) / scaler.sd[j];
  return out;
}

// ---------------------------------------------------------------------------
// Model fitting and comparison
// ---------------------------------------------------------------------------

function designMatrix(rows, scaler) {
  return rows.map(r => applyScaler(scaler, r.features));
}

function pointsMetrics(y, pred) {
  const nonNegative = pred.map(v => Math.max(0, v));
  return {
    mae: metrics.mae(y, pred),
    rmse: metrics.rmse(y, pred),
    // Poisson deviance needs non-negative rates and non-negative outcomes; a
    // handful of historical rows are negative (own goals, red cards), so they
    // are floored for this metric only and the count is reported.
    poissonDeviance: metrics.poissonDeviance(y.map(v => Math.max(0, v)), nonNegative.map(v => Math.max(v, 1e-6))),
  };
}

function probabilityMetrics(y, p) {
  const cal = metrics.calibrationBins(p, y, 10);
  return {
    logLoss: metrics.logLoss(y, p),
    brier: metrics.brier(y, p),
    ece: cal.ece,
    maxGap: cal.maxGap,
    bins: cal.bins,
  };
}

// SELECTION METRIC. RMSE, not MAE, and the reason is decision theoretic rather
// than aesthetic. The planner sums expected points across eleven players and
// compares whole plans, so what it needs from a model is an unbiased
// conditional MEAN. Squared error is minimized by the conditional mean; absolute
// error is minimized by the conditional MEDIAN, which for a zero-inflated,
// right-skewed target like FPL points sits systematically below the mean and
// would make every haul invisible to the optimizer. Both metrics are recorded
// for every candidate, and the artifact also names which model MAE would have
// picked, so the choice is auditable rather than hidden.
const POINTS_SELECTION_METRIC = 'rmse';
export const POINTS_SELECTION_RATIONALE =
  'Validation RMSE. The optimizer sums expected points over a squad, so it needs an unbiased '
  + 'conditional mean; MAE targets the conditional median, which understates a zero-inflated, '
  + 'right-skewed target. MAE is reported for every candidate alongside it.';

export function trainPointsModels({ train, validation, test, scaler, sampleWeights = null }) {
  const Xtr = designMatrix(train, scaler);
  const Xva = designMatrix(validation, scaler);
  const Xte = designMatrix(test, scaler);
  const ytr = train.map(r => r.targetPoints);
  const yva = validation.map(r => r.targetPoints);
  const yte = test.map(r => r.targetPoints);

  const candidates = [];

  candidates.push({
    name: 'baseline-points-per-game',
    kind: 'baseline',
    hyperparameters: {},
    description: BASELINE_DESCRIPTION,
    predictValidation: validation.map(r => r.baselinePoints),
    predictTest: test.map(r => r.baselinePoints),
  });

  for (const lambda of RIDGE_LAMBDAS) {
    const fit = ridge(Xtr, ytr, lambda, { sampleWeights });
    candidates.push({
      name: `ridge-lambda-${lambda}`,
      kind: 'ridge',
      hyperparameters: { lambda },
      fit,
      predictValidation: Xva.map(x => linearPredict(fit, x)),
      predictTest: Xte.map(x => linearPredict(fit, x)),
    });
  }

  // Poisson regression models the count nature of points (non-negative, right
  // skewed, variance rising with the mean). Negative outcomes are floored
  // because the Poisson likelihood has no support below zero.
  const ytrPoisson = ytr.map(v => Math.max(0, v));
  for (const lambda of POISSON_LAMBDAS) {
    const fit = poissonRegression(Xtr, ytrPoisson, { lambda, maxIter: 30, tol: 1e-7, sampleWeights });
    const exp = (x) => Math.exp(Math.min(30, Math.max(-30, linearPredict(fit, x))));
    candidates.push({
      name: `poisson-lambda-${lambda}`,
      kind: 'poisson',
      hyperparameters: { lambda, maxIter: 30, iterations: fit.iterations, converged: fit.converged },
      fit,
      predictValidation: Xva.map(exp),
      predictTest: Xte.map(exp),
    });
  }

  // Hurdle model: P(the player appears) times E[points given they appeared].
  // It mirrors the structure the engine itself uses, and it is the only
  // candidate here that can represent the fact that most zero scores are a
  // minutes problem rather than a performance one.
  const appeared = train.map(r => (r.targetMinutes > 0 ? 1 : 0));
  const playedIdx = train.map((r, i) => (r.targetMinutes > 0 ? i : -1)).filter(i => i >= 0);
  for (const lambda of RIDGE_LAMBDAS) {
    const appearFit = logisticRegression(Xtr, appeared, { lambda, maxIter: 30, tol: 1e-7, sampleWeights });
    const conditionalFit = ridge(
      playedIdx.map(i => Xtr[i]),
      playedIdx.map(i => ytr[i]),
      lambda,
      { sampleWeights: sampleWeights ? playedIdx.map(i => sampleWeights[i]) : null },
    );
    const predict = (x) => {
      const p = 1 / (1 + Math.exp(-Math.min(30, Math.max(-30, linearPredict(appearFit, x)))));
      return p * linearPredict(conditionalFit, x);
    };
    candidates.push({
      name: `hurdle-lambda-${lambda}`,
      kind: 'hurdle',
      hyperparameters: { lambda },
      description: 'Logistic P(appears) multiplied by a ridge fit of points among players who appeared.',
      fit: conditionalFit,
      appearFit,
      predictValidation: Xva.map(predict),
      predictTest: Xte.map(predict),
    });
  }

  for (const c of candidates) {
    c.validation = pointsMetrics(yva, c.predictValidation);
    c.test = pointsMetrics(yte, c.predictTest);
  }

  const winner = candidates.reduce(
    (best, c) => (c.validation[POINTS_SELECTION_METRIC] < best.validation[POINTS_SELECTION_METRIC] ? c : best),
  );
  const winnerByMae = candidates.reduce((best, c) => (c.validation.mae < best.validation.mae ? c : best));
  return { candidates, winner, winnerByMae };
}

export function trainStartModels({ train, validation, test, scaler, sampleWeights = null }) {
  const Xtr = designMatrix(train, scaler);
  const Xva = designMatrix(validation, scaler);
  const Xte = designMatrix(test, scaler);
  const ytr = train.map(r => r.targetStart);
  const yva = validation.map(r => r.targetStart);
  const yte = test.map(r => r.targetStart);

  const candidates = [{
    name: 'baseline-start-rate',
    kind: 'baseline',
    hyperparameters: {},
    description: 'Season start rate carried forward.',
    predictValidation: validation.map(r => r.baselineStartRate),
    predictTest: test.map(r => r.baselineStartRate),
  }];

  for (const lambda of LOGISTIC_LAMBDAS) {
    const fit = logisticRegression(Xtr, ytr, { lambda, maxIter: 30, tol: 1e-7, sampleWeights });
    const sig = (x) => 1 / (1 + Math.exp(-Math.min(30, Math.max(-30, linearPredict(fit, x)))));
    candidates.push({
      name: `logistic-lambda-${lambda}`,
      kind: 'logistic',
      hyperparameters: { lambda, maxIter: 30, iterations: fit.iterations, converged: fit.converged },
      fit,
      predictValidation: Xva.map(sig),
      predictTest: Xte.map(sig),
    });
  }

  for (const c of candidates) {
    c.validation = probabilityMetrics(yva, c.predictValidation);
    c.test = probabilityMetrics(yte, c.predictTest);
  }

  const winner = candidates.reduce((best, c) => (c.validation.logLoss < best.validation.logLoss ? c : best));

  // The calibrator is fitted on VALIDATION (data the model did not train on)
  // and then scored on TEST, so the improvement it reports is out of sample.
  const calibrator = calibrate(winner.predictValidation, yva, 'bins', { bins: 10 });
  const calibratedTest = winner.predictTest.map(p => calibrator.predict(p));
  const calibration = {
    method: 'bins',
    fittedOn: 'validation',
    before: probabilityMetrics(yte, winner.predictTest),
    after: probabilityMetrics(yte, calibratedTest),
    json: calibrator.toJSON(),
  };

  return { candidates, winner, calibration };
}

// ---------------------------------------------------------------------------
// Artifact
// ---------------------------------------------------------------------------

function stripPredictions(candidates) {
  return candidates.map(c => ({
    name: c.name,
    kind: c.kind,
    description: c.description,
    hyperparameters: c.hyperparameters,
    weights: c.fit ? { intercept: c.fit.intercept, byFeature: featureWeights(c.fit) } : null,
    // The hurdle model has two stages, so both are stored. An artifact that
    // cannot reproduce its own reported metrics is not an artifact.
    appearWeights: c.appearFit
      ? { intercept: c.appearFit.intercept, byFeature: featureWeights(c.appearFit) }
      : null,
    validation: omitBins(c.validation),
    test: omitBins(c.test),
  }));
}

function featureWeights(fit) {
  const out = {};
  FEATURE_NAMES.forEach((name, i) => { out[name] = fit.weights[i]; });
  return out;
}

function omitBins(m) {
  if (!m) return m;
  const { bins, ...rest } = m;
  return rest;
}

export async function nextModelVersion() {
  await fsp.mkdir(MODELS_DIR, { recursive: true });
  const indexPath = path.join(MODELS_DIR, 'index.json');
  let index = { models: [] };
  try {
    index = JSON.parse(await fsp.readFile(indexPath, 'utf8'));
  } catch {
    // No index yet: this is the first artifact.
  }
  const versions = index.models.map(m => m.version || 0);
  return { index, indexPath, version: (versions.length ? Math.max(...versions) : 0) + 1 };
}

export async function writeArtifact(artifact) {
  const { index, indexPath, version } = await nextModelVersion();
  const modelVersion = `${MODEL_VERSION_PREFIX}-v${version}`;
  const file = path.join(MODELS_DIR, `${modelVersion}.json`);

  // Versioned filenames plus this guard: an artifact is never overwritten, so
  // a past model can always be reloaded and re-scored.
  if (fs.existsSync(file)) {
    throw new Error(`Refusing to overwrite an existing artifact: ${file}`);
  }

  const full = { ...artifact, version, modelVersion };
  await fsp.writeFile(file, `${JSON.stringify(full, null, 2)}\n`);

  index.models = index.models || [];
  index.models.push({
    version,
    modelVersion,
    file: path.basename(file),
    trainedAt: full.trainedAt,
    datasetVersion: full.datasetVersion,
    featureVersion: full.featureVersion,
    pointsWinner: full.points.winner,
    pointsValidationRmse: full.points.candidates.find(c => c.name === full.points.winner).validation.rmse,
    pointsValidationMae: full.points.candidates.find(c => c.name === full.points.winner).validation.mae,
    startWinner: full.starts.winner,
    startValidationLogLoss: full.starts.candidates.find(c => c.name === full.starts.winner).validation.logLoss,
  });
  index.updatedAt = full.trainedAt;
  await fsp.writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`);

  return { file, modelVersion, version };
}

// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {
    seasons: DEFAULT_SEASONS,
    seed: DEFAULT_SEED,
    ablation: argv.includes('--ablation'),
    // --dry-run measures without writing an artifact. Comparing configurations
    // should not litter models/ with versions nobody chose.
    dryRun: argv.includes('--dry-run'),
    halfLifeGrid: SEASON_HALF_LIFE_GRID,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--seasons') out.seasons = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
    else if (argv[i] === '--seed') out.seed = Number(argv[++i]);
    // Pins the recency decay instead of searching for it, so one configuration
    // can be reproduced exactly when comparing against an earlier artifact.
    else if (argv[i] === '--half-life') {
      const raw = argv[++i];
      out.halfLifeGrid = [raw === 'off' ? null : Number(raw)];
    }
  }
  return out;
}

// Fit every candidate for one half life and report the best validation score
// each target reached. The scaler is deliberately NOT reweighted: standardizing
// only needs a sane scale, and holding it fixed means the only thing that moves
// across the grid is the fit itself.
function searchHalfLife({ split, scaler, seasons, grid = SEASON_HALF_LIFE_GRID }) {
  const results = [];
  for (const halfLife of grid) {
    const sampleWeights = rowWeights(split.train, seasons, halfLife);
    const points = trainPointsModels({ ...split, scaler, sampleWeights });
    const starts = trainStartModels({ ...split, scaler, sampleWeights });
    results.push({
      halfLifeSeasons: halfLife,
      weightBySeason: Object.fromEntries(seasonWeights(seasons, halfLife)),
      points: { winner: points.winner.name, validationRmse: points.winner.validation.rmse, validationMae: points.winner.validation.mae },
      starts: { winner: starts.winner.name, validationLogLoss: starts.winner.validation.logLoss, validationBrier: starts.winner.validation.brier },
      fitted: { points, starts },
    });
  }
  // Ties go to the simpler configuration, which is weighting OFF. Shipping a
  // knob that changes nothing measurable is worse than not having it.
  const best = (metric, path) => results.reduce((a, b) => (path(b) < path(a) - 1e-9 ? b : a));
  return {
    results,
    pointsBest: best('rmse', r => r.points.validationRmse),
    startsBest: best('logLoss', r => r.starts.validationLogLoss),
  };
}

// Vary the training data with the evaluation blocks pinned to the newest season,
// which is the only way "does more history help" is a measurable question. The
// same seasons trained against a DIFFERENT test block produce a different number
// for reasons that have nothing to do with the model, so the usual "compare the
// old artifact's test RMSE to the new one's" is not a comparison at all.
//
// Run twice, once with every row weighted equally and once with the selected
// decay, because those two answer different questions: whether an old season
// carries information, and whether the decay is what makes carrying it safe.
function runAblation({ rows, seasons, halfLifePoints, halfLifeStarts }) {
  const newest = seasons[seasons.length - 1];
  const arms = [];
  for (let i = seasons.length - 1; i >= 0; i--) {
    arms.push({ label: seasons.slice(i).join(' + '), trainSeasons: seasons.slice(i), evalSeasonInTrain: true });
  }
  arms.push({
    label: `${seasons.slice(0, -1).join(' + ')} (no ${newest} training rows)`,
    trainSeasons: seasons.slice(0, -1),
    evalSeasonInTrain: false,
  });

  const weightings = [
    { label: 'equal weights', points: null, starts: null },
    { label: 'selected decay', points: halfLifePoints, starts: halfLifeStarts },
  ];

  const out = [];
  for (const weighting of weightings) {
    for (const arm of arms) {
      const split = splitRows(rows, seasons, { trainSeasons: arm.trainSeasons, evalSeasonInTrain: arm.evalSeasonInTrain });
      if (!split.train.length) continue;
      const scaler = fitScaler(split.train);
      const points = trainPointsModels({ ...split, scaler, sampleWeights: rowWeights(split.train, seasons, weighting.points) });
      const starts = trainStartModels({ ...split, scaler, sampleWeights: rowWeights(split.train, seasons, weighting.starts) });
      const pointsBaseline = points.candidates.find(c => c.kind === 'baseline');
      const startsBaseline = starts.candidates.find(c => c.kind === 'baseline');
      out.push({
        weighting: weighting.label,
        arm: arm.label,
        trainRows: split.train.length,
        points: {
          winner: points.winner.name,
          validationRmse: points.winner.validation.rmse,
          testRmse: points.winner.test.rmse,
          testMae: points.winner.test.mae,
          baselineTestRmse: pointsBaseline.test.rmse,
          beatsBaselineOnTest: points.winner.test.rmse < pointsBaseline.test.rmse,
        },
        starts: {
          winner: starts.winner.name,
          validationLogLoss: starts.winner.validation.logLoss,
          testLogLoss: starts.winner.test.logLoss,
          testBrier: starts.winner.test.brier,
          baselineTestLogLoss: startsBaseline.test.logLoss,
          beatsBaselineOnTest: starts.winner.test.logLoss < startsBaseline.test.logLoss,
        },
      });
    }
  }
  return { evaluatedOn: `${newest} GW ${VALIDATION_START_GW}-${TEST_START_GW - 1} validation, GW ${TEST_START_GW}-38 test`, arms: out };
}

async function main(argv) {
  const { seasons, seed, ablation, dryRun, halfLifeGrid } = parseArgs(argv);
  await ensureSeasons(seasons);

  console.log(`Seasons: ${seasons.join(', ')}  (from ${DATA_DIR})`);
  const t0 = Date.now();
  const { rows, excluded, duplicates } = buildDataset(seasons);
  const split = splitRows(rows, seasons);
  console.log(`Rows: ${rows.length}  train ${split.train.length}  validation ${split.validation.length}  test ${split.test.length}`);
  for (const e of excluded) {
    console.log(`  excluded from ${e.season}: ${e.rows} non-player rows (${e.positions.map(p => `${p.position} x${p.count}`).join(', ')})`);
  }
  for (const d of duplicates) {
    console.log(`  collapsed in ${d.season}: ${d.rows} byte-identical duplicate row(s) (double gameweeks are kept: they differ by fixture)`);
  }
  if (!split.validation.length || !split.test.length) {
    throw new Error('The split produced an empty validation or test block. Check the seasons argument.');
  }

  const scaler = fitScaler(split.train);

  console.log('Searching the recency half-life grid...');
  const search = searchHalfLife({ split, scaler, seasons, grid: halfLifeGrid });
  for (const r of search.results) {
    const label = r.halfLifeSeasons === null ? 'off' : `${r.halfLifeSeasons} seasons`;
    console.log(
      `  half-life ${label.padEnd(12)} points val RMSE ${r.points.validationRmse.toFixed(4)}`
      + `   starts val logLoss ${r.starts.validationLogLoss.toFixed(4)}`,
    );
  }
  const halfLifePoints = search.pointsBest.halfLifeSeasons;
  const halfLifeStarts = search.startsBest.halfLifeSeasons;
  console.log(`  selected: points ${halfLifePoints === null ? 'off' : halfLifePoints}, starts ${halfLifeStarts === null ? 'off' : halfLifeStarts}`);

  const points = search.pointsBest.fitted.points;
  const starts = search.startsBest.fitted.starts;

  let ablationReport = null;
  if (ablation) {
    console.log('Running the training-window ablation...');
    ablationReport = runAblation({ rows, seasons, halfLifePoints, halfLifeStarts });
  }

  // Does the selected model actually beat the documented baseline on data that
  // played no part in choosing it? Computed, recorded, and allowed to be false.
  const pointsBaseline = points.candidates.find(c => c.kind === 'baseline');
  const startsBaseline = starts.candidates.find(c => c.kind === 'baseline');
  const pointsBeatsBaselineOnTest = points.winner.test.rmse < pointsBaseline.test.rmse;
  const startsBeatBaselineOnTest = starts.winner.test.logLoss < startsBaseline.test.logLoss;

  const artifact = {
    datasetVersion: DATASET_VERSION,
    featureVersion: FEATURE_VERSION,
    trainedAt: new Date().toISOString(),
    seed,
    seasons,
    periods: split.periods,
    rowCounts: {
      total: rows.length,
      train: split.train.length,
      validation: split.validation.length,
      test: split.test.length,
    },
    features: FEATURE_NAMES,
    sameGwAllowedColumns: SAME_GW_ALLOWED_COLUMNS,
    requiredColumns: REQUIRED_COLUMNS,
    seasonSpecificColumns: SEASON_SPECIFIC_COLUMNS,
    excludedRows: {
      rule: 'Rows whose position column is not GK/GKP, DEF, MID or FWD are not footballers and are dropped.',
      reason:
        'The only season that ever had them is 2024-25 (assistant managers, position "AM"). They record '
        + 'no minutes and no starts, so every feature describing them is zero, and their points came '
        + 'entirely from mng_* columns that no other season has. Keeping them would put an abolished '
        + 'scoring system into both the training set and the held-out block.',
      bySeason: excluded,
    },
    scaler,
    seasonWeighting: {
      parameter: 'SEASON_HALF_LIFE_SEASONS',
      formula: 'weight = 0.5 ** (seasonsOld / halfLifeSeasons), seasonsOld counted back from the newest season',
      grid: halfLifeGrid,
      note: 'null means off, every row weighted 1. Selected per target by validation metric; ties go to off.',
      scalerIsWeighted: false,
      selected: { points: halfLifePoints, starts: halfLifeStarts },
      searched: search.results.map(r => ({
        halfLifeSeasons: r.halfLifeSeasons,
        weightBySeason: r.weightBySeason,
        points: r.points,
        starts: r.starts,
      })),
    },
    ablation: ablationReport,
    baseline: BASELINE_DESCRIPTION,
    points: {
      target: 'total_points',
      selectionMetric: 'validation RMSE',
      selectionRationale: POINTS_SELECTION_RATIONALE,
      seasonHalfLife: halfLifePoints,
      winner: points.winner.name,
      winnerByMae: points.winnerByMae.name,
      baseline: pointsBaseline.name,
      beatsBaselineOnTest: pointsBeatsBaselineOnTest,
      candidates: stripPredictions(points.candidates),
    },
    starts: {
      target: 'started (minutes as a starter > 0)',
      selectionMetric: 'validation log loss',
      seasonHalfLife: halfLifeStarts,
      winner: starts.winner.name,
      baseline: startsBaseline.name,
      beatsBaselineOnTest: startsBeatBaselineOnTest,
      candidates: stripPredictions(starts.candidates),
      calibration: {
        method: starts.calibration.method,
        fittedOn: starts.calibration.fittedOn,
        testBefore: omitBins(starts.calibration.before),
        testAfter: omitBins(starts.calibration.after),
        testBins: starts.calibration.after.bins,
      },
    },
    // What the browser engine actually loads from this file, and why it is only
    // this. The start model beats its baseline out of sample by a wide margin
    // and calibrates well, so projections.js applies it to pStart.
    //
    // The points model is still NOT consumed, and the reason has changed since
    // v1, so it is written down rather than inherited. v1 recorded
    // beatsBaselineOnTest: false. It is true here, but the ablation shows that
    // flip was not earned by the extra season: rerunning v1's exact three
    // seasons and its exact test block under this feature builder also flips it
    // to true. What changed is that 182 assistant-manager rows are no longer in
    // the held-out block, and no feature could describe them while the
    // carried-forward baseline could.
    //
    // More to the point, "beats the baseline" is the wrong bar for wiring it in.
    // The baseline is points per game carried forward. The engine does not use
    // that; it builds a projection by convolving minutes, xG, xA, bonus and
    // clean sheets. Beating a naive carry-forward says nothing about beating the
    // component model, and until that specific comparison is run and won, the
    // engine keeps the projection it has.
    // EMPTY ON PURPOSE, and a retrain must not quietly change that.
    //
    // The start calibrator was wired in, then measured against the metric that
    // actually matters. Two leakage-free replays, each with a model trained
    // excluding the season being replayed:
    //   2024-25  planner 2371 -> 2211,  greedy 2284 -> 2215,  bias +0.33 -> +2.6/gw
    //   2023-24  planner 1943 -> 1853,  greedy 1947 -> 1892
    // Both seasons, both decision strategies, the same direction, and the
    // planner's edge over greedy collapsed from +87 to -4. It predicts who
    // starts more accurately and it costs points.
    //
    // So this ships empty and the loader consumes nothing. Re-enabling is a
    // deliberate act with a bar attached: re-run both replays via
    //   node apps/fpl-planner/scripts/backtest.mjs --season <s> --model <artifact>
    // and only put a key back if the season points IMPROVE. A better log loss
    // or a lower calibration error on its own is exactly the evidence that
    // already proved insufficient.
    engineConsumes: [],
    engineConsumesDisabledBecause:
      'The start calibrator improves start-probability log loss and calibration on held-out data, '
      + 'but leakage-free replays of 2024-25 and 2023-24 both lost points with it applied '
      + '(planner 2371 to 2211, and 1943 to 1853), and projection bias rose from +0.33 to +2.6 '
      + 'points per gameweek. It optimises a statistical metric at the cost of the product metric. '
      + 'Re-enable only if a replay shows season points improving, never on log loss alone.',
    pointsModelNotConsumedBecause:
      'beatsBaselineOnTest compares the points model against points per game carried forward. '
      + 'The engine projects points by convolving component distributions, not by carrying a mean '
      + 'forward, so clearing the naive baseline is not evidence it would improve the engine. '
      + 'That is a separate measurement against projections.js, and it has not been run.',
    startCalibratorJSON: starts.calibration.json,
    durationMs: Date.now() - t0,
  };

  const written = dryRun ? null : await writeArtifact(artifact);

  console.log('');
  console.log('POINTS (target: total_points, selected by validation RMSE)');
  for (const c of points.candidates) {
    const mark = c.name === points.winner.name ? '*' : ' ';
    console.log(`${mark} ${c.name.padEnd(28)} val RMSE ${c.validation.rmse.toFixed(4)}  val MAE ${c.validation.mae.toFixed(4)}  test RMSE ${c.test.rmse.toFixed(4)}  test MAE ${c.test.mae.toFixed(4)}`);
  }
  console.log(`  (MAE would have picked: ${points.winnerByMae.name})`);
  console.log(`  beats the baseline on TEST: ${pointsBeatsBaselineOnTest}`);
  console.log('');
  console.log('STARTS (target: started, selected by validation log loss)');
  for (const c of starts.candidates) {
    const mark = c.name === starts.winner.name ? '*' : ' ';
    console.log(`${mark} ${c.name.padEnd(28)} val logLoss ${c.validation.logLoss.toFixed(4)}  val Brier ${c.validation.brier.toFixed(4)}  test logLoss ${c.test.logLoss.toFixed(4)}`);
  }
  console.log(`  beats the baseline on TEST: ${startsBeatBaselineOnTest}`);
  console.log('');
  console.log(`Calibration on test: ECE ${starts.calibration.before.ece.toFixed(4)} -> ${starts.calibration.after.ece.toFixed(4)}`);

  if (ablationReport) {
    console.log('');
    console.log(`TRAINING-WINDOW ABLATION (evaluated on ${ablationReport.evaluatedOn})`);
    for (const a of ablationReport.arms) {
      console.log(
        `  ${a.weighting.padEnd(15)} ${a.arm.padEnd(54)} rows ${String(a.trainRows).padStart(6)}`
        + `  points test RMSE ${a.points.testRmse.toFixed(4)}`
        + `  starts test logLoss ${a.starts.testLogLoss.toFixed(4)}`,
      );
    }
    const b = ablationReport.arms[0];
    console.log(`  (baselines on the same block: points RMSE ${b.points.baselineTestRmse.toFixed(4)}, starts logLoss ${b.starts.baselineTestLogLoss.toFixed(4)})`);
  }
  console.log(written ? `Artifact: ${written.file}` : 'Dry run: no artifact written.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(err => {
    console.error(`\n${err.message}\n`);
    process.exit(1);
  });
}
