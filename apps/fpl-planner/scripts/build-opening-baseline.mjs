#!/usr/bin/env node
// BUILD THE CANONICAL OPENING-SEASON BASELINE.
//
// WHY THIS EXISTS
//
// `engine/baseline.js` keeps the last complete payload it saw so that FPL
// clearing the element totals at a season rollover cannot collapse the
// projections. That works for a browser that was ALREADY running the guard
// when the last complete payload arrived. It cannot work for anybody else:
// the guard shipped at 16:04 UTC on 2026-08-22, FPL wiped the totals at 18:04
// UTC on 2026-08-21, and `snapshotFrom` only returns a snapshot from a
// COMPLETE payload. Between those two moments there was no complete payload
// left to keep, so no production browser ever wrote one, and every visitor was
// refused a plan until three matches per club - most of the opening month.
//
// The fix is to ship the baseline with the app. This script derives it from a
// real captured pre-wipe payload; it never invents totals. The output is the
// same shape `snapshotFrom` produces, so the engine reads a shipped baseline
// and a browser-kept one through one code path.
//
// USAGE
//
//   node apps/fpl-planner/scripts/build-opening-baseline.mjs \
//     --bootstrap ~/fpl-gw1-evidence/raw/bootstrap-after.json \
//     --fixtures  ~/fpl-gw1-evidence/raw/fixtures-after.json \
//     --out       apps/fpl-planner/data/opening-baseline.json
//
// The defaults point at the captured 2026-08-21 evidence. The script REFUSES
// to write anything unless the payload it is given is a complete season by
// `assessBaseline`'s own judgement and no fixture in it has been played, which
// is what "before the wipe" means in data terms.

import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { buildGameState } from '../js/engine/normalize.js';
import { assessBaseline, snapshotFrom, OPENING_BASELINE_KIND } from '../js/engine/baseline.js';

const HOME = process.env.HOME || '';
const DEFAULTS = {
  bootstrap: path.join(HOME, 'fpl-gw1-evidence/raw/bootstrap-after.json'),
  fixtures: path.join(HOME, 'fpl-gw1-evidence/raw/fixtures-after.json'),
  out: new URL('../data/opening-baseline.json', import.meta.url).pathname,
};

function parseArgs(argv) {
  const out = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i += 2) {
    const key = String(argv[i]).replace(/^--/, '');
    if (!(key in out)) throw new Error(`unknown argument: ${argv[i]}`);
    if (argv[i + 1] == null) throw new Error(`${argv[i]} needs a value`);
    out[key] = argv[i + 1];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));
const sha256 = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');

const bootstrap = readJson(args.bootstrap);
const fixtures = readJson(args.fixtures);
const gameState = buildGameState(bootstrap, fixtures);

// --- the refusals -----------------------------------------------------------
//
// Every one of these is a way the captured payload could be the WRONG payload,
// and every one of them would produce a baseline that quietly lies rather than
// one that fails loudly.
const fail = (msg) => { console.error(`REFUSED: ${msg}`); process.exit(1); };

const assessment = assessBaseline(gameState);
if (!assessment.complete) {
  fail(`${args.bootstrap} is not a complete season (${assessment.reasons.join(', ')}). `
    + 'A post-wipe payload cannot be the baseline that stands in for a wipe.');
}

const played = gameState.fixtures.filter(f => f.finished || f.finishedProvisional || f.started).length;
if (played > 0) {
  fail(`${played} fixtures in ${args.fixtures} have been played. The baseline must describe the `
    + 'season BEFORE this one, captured before a ball was kicked in the new one.');
}

const season = gameState.rules.season;
if (!season) fail(`${args.bootstrap} carries no season label (game_config.settings.static_content_url).`);

const firstEvent = gameState.events[0];
if (!firstEvent || !firstEvent.deadline) fail('the payload has no gameweek 1 deadline to pin the season calendar to.');
if (firstEvent.isCurrent || firstEvent.finished) {
  fail('gameweek 1 is already current or finished in this payload, so the totals may already have been rolled over.');
}

const snapshot = snapshotFrom(gameState, { capturedAt: null, seasonLabel: season });
if (!snapshot) fail('snapshotFrom refused this payload.');

// --- provenance -------------------------------------------------------------
//
// A committed data file with no stated origin is indistinguishable from an
// invented one six months later. Everything needed to re-derive this file
// byte-for-byte is recorded in it.
// The capture time is the source file's mtime: these payloads were written by
// `curl` the moment they were fetched, so the file IS the clock.
const capturedAt = statSync(args.bootstrap).mtime.toISOString();

const asset = {
  kind: OPENING_BASELINE_KIND,
  version: snapshot.version,
  // The season whose PAYLOAD this was captured from, and therefore the only
  // season it may ever be applied to. `engine/baseline.js` refuses it anywhere
  // else, so the 2025/26 totals cannot silently become 2027/28's prior.
  appliesToSeason: season,
  // The season the totals themselves describe, for humans reading this file.
  coversSeason: previousSeasonLabel(season),
  // The gameweek 1 deadline of `appliesToSeason`. A second, independent pin on
  // the calendar: a payload claiming the same season label but a different
  // opening deadline is not the season this baseline was built for.
  firstDeadline: firstEvent.deadline,
  capturedAt,
  totalEvents: snapshot.totalEvents,
  seasonLabel: season,
  provenance: {
    source: path.basename(args.bootstrap),
    sourceSha256: sha256(args.bootstrap),
    fixtures: path.basename(args.fixtures),
    fixturesSha256: sha256(args.fixtures),
    capturedFrom: 'the live shevato FPL proxy, https://shevato.com/.netlify/functions/fpl?path=bootstrap-static',
    note: 'Last complete bootstrap-static captured before FPL cleared the element totals at '
      + '2026-08-21T18:04Z. An independent capture 16 minutes earlier agrees on every total '
      + 'for all 600 players, so these are settled end-of-season figures, not a mid-update read.',
    builtBy: 'apps/fpl-planner/scripts/build-opening-baseline.mjs',
  },
  aggregate: snapshot.aggregate,
  totals: snapshot.totals,
};

function previousSeasonLabel(label) {
  const m = /^(\d{4})\/(\d{2})$/.exec(String(label || ''));
  if (!m) return null;
  const start = Number(m[1]) - 1;
  return `${start}/${String((start + 1) % 100).padStart(2, '0')}`;
}

writeFileSync(args.out, `${JSON.stringify(asset)}\n`);

const bytes = Buffer.byteLength(JSON.stringify(asset));
console.log(`wrote ${args.out}`);
console.log(`  season        ${asset.appliesToSeason} (totals describe ${asset.coversSeason})`);
console.log(`  captured      ${asset.capturedAt} from ${asset.provenance.source}`);
console.log(`  sha256        ${asset.provenance.sourceSha256.slice(0, 16)}...`);
console.log(`  players       ${Object.keys(asset.totals).length} of ${assessment.pool}`);
console.log(`  aggregate     ${assessment.starts} starts over ${assessment.active} active `
  + `(${assessment.startsPerActive.toFixed(1)} each, ${(assessment.seasonShare * 100).toFixed(1)}% of a season)`);
console.log(`  size          ${(bytes / 1024).toFixed(1)} KB`);
