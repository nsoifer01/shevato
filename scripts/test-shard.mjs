#!/usr/bin/env node
// Runs ONE cost-balanced share of `npm test`, for the `test-shard` jobs of
// .github/workflows/ci.yml.
//
//   node scripts/test-shard.mjs 1/2
//
// WHY NOT node --test-shard (2026-10-17). Node's own shard flag splits the
// sorted file list by position, and the three heaviest files of the estate
// (optimizer-consistency, chips, transfers-depth: about 400 of its 1,327
// file-seconds) sort next to each other, so they always landed in the same
// half: on PR #617's first two runs half 1 took 327 s and 488 s while half 2
// finished in 233 s and 296 s, and the slow half was no faster than the single
// job it replaced. This packs the files longest-first by the measured costs
// below, the way tests/browser/run.mjs packs its suites.
//
// WHAT RUNS IS STILL `npm test`. The file list is the expansion of the globs in
// package.json's "test" script, and node is started with that script's own
// flags; NODE_OPTIONS (the CI reporters) passes through. The shares together
// run every file exactly once (tests/static/test-shard.test.mjs).
//
// THE COSTS ARE A SCHEDULING HINT ONLY. Seconds per file from one local run on
// 2026-10-17 (every file of 10 s or more; the rest count as one second). A
// stale or missing entry can unbalance the halves, never drop a file; the
// static test fails when an entry names a file that no longer exists.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const FILE_SECONDS = {
  'apps/fpl-planner/tests/optimizer-consistency.test.mjs': 158,
  'apps/fpl-planner/tests/chips.test.mjs': 157,
  'apps/fpl-planner/tests/transfers-depth.test.mjs': 124,
  'apps/fpl-planner/tests/gw7-audit-followup-ui.test.mjs': 76,
  'netlify/functions/tests/fpl-health.test.mjs': 71,
  'apps/fpl-planner/tests/roll-consistency.test.mjs': 58,
  'apps/fpl-planner/tests/perf-live-size.test.mjs': 56,
  'apps/fpl-planner/tests/ui-plan-runner.test.mjs': 48,
  'apps/fpl-planner/tests/invariants.test.mjs': 47,
  'apps/rising-shows/tests/shows-index-parity.test.js': 40,
  'apps/fpl-planner/tests/optimizer-reference.test.mjs': 38,
  'apps/fpl-planner/tests/counterfactual.test.mjs': 38,
  'apps/fpl-planner/tests/probe-sample.test.mjs': 32,
  'apps/fpl-planner/tests/season-rollover.test.mjs': 26,
  'apps/fpl-planner/tests/squad-builder.test.mjs': 26,
  'apps/fpl-planner/tests/backtest.test.mjs': 25,
  'apps/fpl-planner/tests/search-corrections.test.mjs': 24,
  'apps/fpl-planner/tests/perf-budget.test.mjs': 24,
  'apps/fpl-planner/tests/real-deadline-gw7.test.mjs': 24,
  'apps/fpl-planner/tests/planner.test.mjs': 21,
  'apps/fpl-planner/tests/ui-scenario.test.mjs': 20,
  'apps/fpl-planner/tests/live-match-window.test.mjs': 18,
  'apps/fpl-planner/tests/free-hit-scoring.test.mjs': 16,
  'apps/fpl-planner/tests/probe.test.mjs': 16,
  'sync-system/tests/firebase-config-shape.test.mjs': 14,
  'apps/fpl-planner/tests/counterfactual-depth.test.mjs': 12,
  'apps/fpl-planner/tests/probe-freshness.test.mjs': 10,
  'apps/fpl-planner/tests/risk-profile.test.mjs': 10,
  'apps/fpl-planner/tests/ui-dashboard.test.mjs': 10,
};
export const DEFAULT_SECONDS = 1;

/** The "test" script's node flags and globs, as package.json writes them. */
export function testScript(pkg) {
  const script = pkg.scripts && pkg.scripts.test;
  const m = /^node --test((?: --[a-z-]+(?:=\S+)?)*)((?: "[^"]+")+)$/.exec(String(script || ''));
  if (!m) throw new Error(`package.json "test" is not \`node --test [--flags] "glob" ...\`: ${script}`);
  return {
    flags: m[1].trim().split(/\s+/).filter(Boolean),
    globs: [...m[2].matchAll(/"([^"]+)"/g)].map((g) => g[1]),
  };
}

/** Every file the globs name, relative to the repo, sorted and de-duplicated. */
export function testFiles(globs, root = REPO_ROOT) {
  const files = new Set();
  for (const g of globs) for (const f of fs.globSync(g, { cwd: root })) files.add(f.split(path.sep).join('/'));
  return [...files].sort();
}

/** Longest-first into `n` shares; deterministic, and total by construction. */
export function partition(files, n, costs = FILE_SECONDS) {
  const cost = (f) => (costs[f] == null ? DEFAULT_SECONDS : costs[f]);
  const bins = Array.from({ length: n }, () => ({ files: [], load: 0 }));
  for (const f of [...files].sort((a, b) => (cost(b) - cost(a)) || (a < b ? -1 : a > b ? 1 : 0))) {
    const pick = bins.reduce((best, b) => (b.load < best.load ? b : best), bins[0]);
    pick.files.push(f);
    pick.load += cost(f);
  }
  const placed = bins.reduce((a, b) => a + b.files.length, 0);
  if (placed !== files.length) throw new Error(`partition lost files: placed ${placed} of ${files.length}`);
  for (const b of bins) b.files.sort();
  return bins;
}

async function main(argv) {
  const m = /^([1-9][0-9]*)\/([1-9][0-9]*)$/.exec(argv[0] || '');
  if (!m || Number(m[1]) > Number(m[2])) {
    console.error('usage: node scripts/test-shard.mjs <i>/<n>   (1-based, i <= n)');
    process.exit(2);
  }
  const [index, total] = [Number(m[1]), Number(m[2])];
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  const { flags, globs } = testScript(pkg);
  const files = testFiles(globs);
  const share = partition(files, total)[index - 1];
  console.log(`test shard ${index}/${total}: ${share.files.length} of ${files.length} files, ~${share.load}s of measured work`);
  if (!share.files.length) {
    console.error(`test shard ${index}/${total} selects no file`);
    process.exit(1);
  }
  const child = spawn(process.execPath, ['--test', ...flags, ...share.files], { cwd: REPO_ROOT, stdio: 'inherit' });
  child.on('exit', (code, signal) => process.exit(signal ? 1 : code));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) await main(process.argv.slice(2));
