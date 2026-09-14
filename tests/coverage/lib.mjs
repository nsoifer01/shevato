// The pure half of the coverage runner: reading Node's LCOV coverage report
// (every module instance of a file merged into one row), reading the TAP
// pass/fail summary, and judging each area against its floor. Split out of
// run.mjs so node:test can feed it canned output
// (tests/static/coverage-floors.test.mjs) without running the whole unit
// estate under coverage.
import path from 'node:path';

// Area -> path prefix used to bucket per-file rows.
export const AREAS = [
  ['arena', 'apps/arena/'],
  ['football-h2h', 'apps/football-h2h/'],
  ['fpl-planner', 'apps/fpl-planner/'],
  ['gym-tracker', 'apps/gym-tracker/'],
  ['maptap-rivals', 'apps/maptap-rivals/'],
  ['mario-kart', 'apps/mario-kart/'],
  ['rising-shows', 'apps/rising-shows/'],
  ['trip-planner', 'apps/trip-planner/'],
  ['netlify-functions', 'netlify/'],
  ['sync-system', 'sync-system/'],
  ['site-shared', 'assets/'],
];

/**
 * The top-level test counts from the TAP stream. The last value printed wins:
 * the run's own summary comes after every subtest.
 */
export function parseTapSummary(out) {
  const summary = {};
  for (const line of out.split('\n')) {
    const m = /^# (tests|pass|fail|skipped|todo) (\d+)/.exec(line);
    if (m) summary[m[1]] = Number(m[2]);
  }
  return summary;
}

const addHits = (map, key, hits) => map.set(key, (map.get(key) ?? 0) + (hits > 0 ? hits : 0));

// Percentage of keys hit at least once. An empty set is 100%, the way Node's
// own coverage summary reports a file with no functions or no branches.
function percentHit(map) {
  let hit = 0;
  for (const v of map.values()) if (v > 0) hit++;
  return map.size === 0 ? 100 : (hit / map.size) * 100;
}

/**
 * Per-file coverage rows `{ file, line, branch, funcs }` (percentages) from an
 * LCOV report, with every record for the same file MERGED.
 *
 * WHY LCOV AND NOT THE TAP TABLE (2026-09-14). Node's per-file coverage table
 * credits ONE module instance per file path. A test that loads a fresh copy of
 * a module through a query string, the way
 * sync-system/tests/sync-account-boundary.test.mjs gives every test its own
 * engine with `import(`${ENGINE}?page=${n}`)`, creates a second instance of
 * the same file, and every line that ran only through that instance was
 * reported as uncovered: storage-sync-robust.js read 59.61% and failed the
 * sync-system floor for lines its tests do run. The LCOV reporter writes one
 * SF record PER INSTANCE (same path each time, the query is dropped), each
 * with its own hits, so the truth is their union:
 *
 * - lines: covered if ANY instance hit it; the total is the union of DA line
 *   numbers (not the sum of LF, which would count a line once per instance).
 * - functions: merged by (name, line), hit if any instance called it. V8
 *   lists a different set of functions per instance (an inner function
 *   appears only once its parent was compiled), and Node names an unnamed
 *   function `anonymous_<index into that instance's list>`, so one anonymous
 *   function carries a different name in each instance. Measured on
 *   storage-sync-robust.js (2026-09-14): 49 instances, 163 to 182 FN records
 *   each, 307 distinct name@line keys over 186 distinct lines. Unnamed
 *   functions are therefore keyed by (line, ordinal among the unnamed
 *   functions on that line), which is approximate when two share a line.
 * - branches: APPROXIMATE across instances. Node's reporter numbers a BRDA
 *   block with a running index over that instance's own branch list (the
 *   branch field is always 0), so the literal key names different branches in
 *   different instances. They are merged by (line, ordinal within that line)
 *   instead, which lines up whenever instances report the same ranges on a
 *   line; but V8 lists only the ranges an instance produced (BRF ran from 216
 *   to 775 across storage-sync-robust.js's instances), so two instances can
 *   disagree about what a line holds.
 *
 * Floors are enforced on LINE % only (evaluateAreas), never on branch or
 * function %, so neither approximation can move a floor verdict.
 *
 * SF paths are relative to the runner's cwd and can climb with `../`; they are
 * resolved against `repoRoot` and keyed repo-relative with forward slashes
 * (`sync-system/storage-sync-robust.js`), which is what AREAS, isTestFile and
 * the unmeasured-file inventory compare against.
 */
export function parseLcov(text, repoRoot) {
  const merged = new Map();   // file -> { lines, funcs, branches }: key -> summed hits
  let rec = null;             // the SF record being read
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('SF:')) {
      const file = path.relative(repoRoot, path.resolve(repoRoot, line.slice(3))).split(path.sep).join('/');
      if (!merged.has(file)) merged.set(file, { lines: new Map(), funcs: new Map(), branches: new Map() });
      rec = { m: merged.get(file), fnKeys: new Map(), anonymousOnLine: new Map(), branchesOnLine: new Map() };
      continue;
    }
    if (!rec) continue;
    if (line === 'end_of_record') { rec = null; continue; }
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const tag = line.slice(0, colon);
    const body = line.slice(colon + 1);
    if (tag === 'DA') {
      const [n, hits] = body.split(',');
      addHits(rec.m.lines, Number(n), Number(hits));
    } else if (tag === 'FN') {
      // FN:<line>,<name>. Node writes every FN before the FNDA lines, in the
      // same order, so a name that occurs twice in a record pairs by order.
      const comma = body.indexOf(',');
      const fnLine = body.slice(0, comma);
      const name = body.slice(comma + 1);
      let key = `${name}@${fnLine}`;
      if (/^anonymous_\d+$/.test(name)) {
        const ordinal = rec.anonymousOnLine.get(fnLine) ?? 0;
        rec.anonymousOnLine.set(fnLine, ordinal + 1);
        key = `(anonymous)@${fnLine}#${ordinal}`;
      }
      if (!rec.fnKeys.has(name)) rec.fnKeys.set(name, []);
      rec.fnKeys.get(name).push(key);
      addHits(rec.m.funcs, key, 0);
    } else if (tag === 'FNDA') {
      // FNDA:<hits>,<name>
      const comma = body.indexOf(',');
      const key = rec.fnKeys.get(body.slice(comma + 1))?.shift();
      if (key != null) addHits(rec.m.funcs, key, Number(body.slice(0, comma)));
    } else if (tag === 'BRDA') {
      // BRDA:<line>,<block>,<branch>,<taken>; <taken> is '-' when never evaluated.
      const [brLine, , , taken] = body.split(',');
      const ordinal = rec.branchesOnLine.get(brLine) ?? 0;
      rec.branchesOnLine.set(brLine, ordinal + 1);
      addHits(rec.m.branches, `${brLine}#${ordinal}`, taken === '-' ? 0 : Number(taken));
    }
  }
  return [...merged].map(([file, m]) => ({
    file, line: percentHit(m.lines), branch: percentHit(m.branches), funcs: percentHit(m.funcs),
  }));
}

export const isTestFile = (f) =>
  /(^|\/)tests?\//.test(f) || /\.test\.(js|cjs|mjs)$/.test(f) || /(^|\/)e2e\//.test(f)
  || /tests\/(helpers|fixtures)\//.test(f);

export function aggregate(list) {
  const w = list.reduce((a, r) => a + r.lines, 0) || 1;
  const wavg = (k) => list.reduce((a, r) => a + r[k] * r.lines, 0) / w;
  return { files: list.length, line: wavg('line'), branch: wavg('branch'), funcs: wavg('funcs') };
}

/**
 * Judge every area against its floor. `srcRows` are source-file rows that
 * already carry `lines` (on-disk line count, the weighting).
 *
 * Returns one entry per area that has a report row (`stats` is null for a
 * floored area that measured nothing), plus `failures`: a human-readable
 * reason for every floor that is not met. The floor is compared with the LINE
 * percentage only.
 *
 * An area with a floor and NO measured rows is a failure, not a skip
 * (2026-09-12 audit C-3). Skipping it is how a parser or output-format change
 * would turn the floors job green while it enforced nothing. Only an area
 * with no floor at all (mario-kart, see run.mjs) may measure nothing.
 */
export function evaluateAreas(srcRows, floors, areas = AREAS) {
  const results = [];
  const failures = [];
  if (!srcRows.length) {
    failures.push('the LCOV coverage report parsed to zero source rows: nothing was measured, so no floor was enforced');
  }
  for (const [area, prefix] of areas) {
    const list = srcRows.filter((r) => r.file.startsWith(prefix));
    const floor = floors[area];
    if (!list.length) {
      if (floor == null) continue;
      failures.push(`${area}: no measured source files, so its floor of ${floor} was not checked `
        + '(a broken parse or a changed coverage format looks exactly like this)');
      results.push({ area, stats: null, floor, ok: false });
      continue;
    }
    const stats = aggregate(list);
    const ok = floor == null || stats.line >= floor;
    if (!ok) failures.push(`${area}: line coverage ${stats.line.toFixed(2)} is below its floor of ${floor}`);
    results.push({ area, stats, floor, ok });
  }
  return { results, failures };
}
