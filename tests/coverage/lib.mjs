// The pure half of the coverage runner: parsing the TAP coverage table and
// judging each area against its floor. Split out of run.mjs so node:test can
// feed it canned output (tests/static/coverage-floors.test.mjs) without
// running the whole unit estate under coverage.

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

export function parseTable(out) {
  // TWO TABLE SHAPES, because Node changed it.
  //
  // Node 20 printed one flat repo-relative path per row:
  //     # apps/foo/js/bar.js | 99.62 | 79.34 | 100.00 | 351-352
  //
  // Node 22 prints an indented TREE, where a directory row carries no
  // percentages and a file row's full path is its own name prefixed by the
  // directories above it at smaller indents:
  //     # apps                     |        |        |        |
  //     #  gym-tracker             |        |        |        |
  //     #   js                     |        |        |        |
  //     #    app.js                |  91.20 |  84.10 |  88.00 | 12-14
  //
  // Reading the second as though it were the first yields BASENAMES, every
  // area prefix matches nothing, and the report says 0.00% across the board
  // while claiming every production file is unmeasured. Both are parsed here
  // so the runner is not silently wrong on either runtime.
  const rows = [];
  let inTable = false;
  const summary = {};
  const stack = [];   // [{ indent, name }] for the Node 22 tree
  for (const line of out.split('\n')) {
    if (line.includes('start of coverage report')) { inTable = true; stack.length = 0; continue; }
    if (line.includes('end of coverage report')) { inTable = false; continue; }
    const m = /^# tests (\d+)|^# pass (\d+)|^# fail (\d+)|^# skipped (\d+)|^# todo (\d+)/.exec(line);
    if (m) {
      if (m[1] != null) summary.tests = Number(m[1]);
      if (m[2] != null) summary.pass = Number(m[2]);
      if (m[3] != null) summary.fail = Number(m[3]);
      if (m[4] != null) summary.skipped = Number(m[4]);
      if (m[5] != null) summary.todo = Number(m[5]);
    }
    if (!inTable) continue;

    // `# ` then the (possibly indented) name, then the three percentage
    // columns. A directory row has them blank.
    const r = /^#(\s+)([^|]*?)\s*\|\s*([\d.]*)\s*\|\s*([\d.]*)\s*\|\s*([\d.]*)\s*\|/.exec(line);
    if (!r) continue;
    const indent = r[1].length;
    const name = r[2].trim();
    if (!name || name === 'file') continue;
    const isDir = r[3] === '' && r[4] === '' && r[5] === '';

    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    if (isDir) { stack.push({ indent, name }); continue; }

    if (name === 'all files') {
      summary.allFiles = { line: +r[3], branch: +r[4], funcs: +r[5] };
      continue;
    }
    const file = [...stack.map((e) => e.name), name].join('/');
    rows.push({ file, line: +r[3], branch: +r[4], funcs: +r[5] });
  }
  return { rows, summary };
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
 * reason for every floor that is not met.
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
    failures.push('the coverage table parsed to zero source rows: nothing was measured, so no floor was enforced');
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
