// A node:test reporter: the slowest test FILES of a run, each against the
// per-file bound, as Markdown.
//
//   node --test --test-timeout=180000 \
//     --test-reporter=./scripts/test-file-times.mjs --test-reporter-destination=file-times.md ...
//
// `--test-timeout` does not bound each test. With process isolation (the
// default) it bounds each file, every test in it together, and a file that
// runs past it is killed, its running test cancelled. Measured 2026-09-14: two
// 1.2 s tests under `--test-timeout=2000` fail at 2.0 s. PR #542 set 180 s
// believing it was per test; the weekly coverage run, where V8 coverage makes
// apps/fpl-planner/tests/backtest.test.mjs eight times slower (21.9 s plain,
// 173.4 s covered, one file alone on four cores), then failed two whole files
// that nobody had timed. This prints the margin on every run, so a file
// drifting toward the bound is visible long before it is killed.
//
// A file's time is the sum of its top-level tests (they run one after another
// inside the file); when the runner reports the file itself, which it does
// only when the file failed or timed out, that entry is the file's wall time.
import path from 'node:path';

/** The run's `--test-timeout` in ms, from the runner process's own flags; null if unbounded. */
export function boundFromArgv(argv = process.execArgv) {
  for (let i = 0; i < argv.length; i++) {
    const m = /^--test-timeout(?:=(\d+))?$/.exec(argv[i]);
    if (!m) continue;
    const ms = Number(m[1] ?? argv[i + 1]);
    return Number.isFinite(ms) && ms > 0 ? ms : null;
  }
  return null;
}

/** Map of absolute file -> { ms, timedOut } from test:pass / test:fail events. */
export function fileTimes(events) {
  const files = new Map();
  for (const ev of events) {
    if (ev.type !== 'test:pass' && ev.type !== 'test:fail') continue;
    const d = ev.data || {};
    if (d.nesting !== 0 || !d.file) continue;
    if (!files.has(d.file)) files.set(d.file, { sum: 0, whole: 0, timedOut: false });
    const f = files.get(d.file);
    const ms = Number(d.details && d.details.duration_ms) || 0;
    const isFileEntry = d.name === d.file || d.file.endsWith(`/${d.name}`) || d.file.endsWith(`\\${d.name}`);
    if (isFileEntry) {
      f.whole = Math.max(f.whole, ms);
      if (d.details && d.details.error && d.details.error.failureType === 'testTimeoutFailure') f.timedOut = true;
    } else {
      f.sum += ms;
    }
  }
  return new Map([...files].map(([file, f]) => [file, { ms: Math.max(f.sum, f.whole), timedOut: f.timedOut }]));
}

export function formatFileTimes(times, { boundMs = null, top = 8, root = process.cwd() } = {}) {
  const rows = [...times].sort((a, b) => b[1].ms - a[1].ms).slice(0, top);
  const bound = boundMs ? `${Math.round(boundMs / 1000)} s` : null;
  const lines = [
    `### Slowest test files${bound ? ` (--test-timeout bounds each file, all its tests together, at ${bound})` : ' (no --test-timeout: files are unbounded)'}`,
    '',
    `| File | Time |${bound ? ' Share of the bound |' : ''}`,
    `| --- | ---: |${bound ? ' ---: |' : ''}`,
  ];
  for (const [file, { ms, timedOut }] of rows) {
    const rel = path.relative(root, file).split(path.sep).join('/');
    const share = boundMs ? ` ${timedOut ? 'TIMED OUT' : `${Math.round((ms / boundMs) * 100)}%`} |` : '';
    lines.push(`| ${rel} | ${(ms / 1000).toFixed(1)} s |${share}`);
  }
  if (!rows.length) lines.push(`| (no test reported a file) | - |${bound ? ' - |' : ''}`);
  return `${lines.join('\n')}\n`;
}

export default async function* testFileTimes(source) {
  const events = [];
  for await (const ev of source) {
    if (ev.type === 'test:pass' || ev.type === 'test:fail') events.push(ev);
  }
  yield formatFileTimes(fileTimes(events), { boundMs: boundFromArgv() });
}
