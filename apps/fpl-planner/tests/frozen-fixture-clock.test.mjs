// A test over a frozen FPL payload must not depend on today's date. Ledger row
// 45: real-deadline-gw10 compared a payload from 2026-11-05 with the machine's
// clock, passed until GW10's deadline and failed from then on. The failure
// surfaced on the Rising Shows data refresh's pull request, because every pull
// request runs this estate, and stopped that refresh for days.
//
// So the real-deadline suites are run here at the dates that matter, on clocks
// moved by a preload rather than by anything inside the code under test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SUITES = readdirSync(HERE).filter((f) => /^real-deadline-.*\.test\.mjs$/.test(f));

const CLOCKS = {
  'the day after the payload\'s deadline, when the defect surfaced': '2026-11-07T13:09:49Z',
  'the middle of a later season half': '2027-03-15T12:00:00Z',
  'the summer between seasons': '2027-06-15T12:00:00Z',
  'the opening weeks of the next season': '2027-08-25T12:00:00Z',
};

test('the real-deadline suites exist to be run here', () => {
  assert.ok(SUITES.includes('real-deadline-gw7.test.mjs') && SUITES.includes('real-deadline-gw10.test.mjs'), SUITES.join(', '));
});

// One process per clock, side by side: each is about ten seconds of planning.
const runAt = (now) => new Promise((resolve) => {
  execFile(process.execPath, [
    '--import', join(HERE, 'helpers', 'shift-clock.mjs'),
    '--test', '--test-reporter=tap', ...SUITES.map((f) => join(HERE, f)),
  ], {
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, FAKE_NOW: now, NODE_OPTIONS: '', NODE_TEST_CONTEXT: undefined },
  }, (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr }));
});

test('the real-deadline suites give the same verdict whatever the date is', async () => {
  const entries = Object.entries(CLOCKS);
  const results = await Promise.all(entries.map(([, now]) => runAt(now)));
  results.forEach((out, i) => {
    const [name, now] = entries[i];
    const notOk = out.stdout.split('\n').filter((l) => /^\s*not ok /.test(l)).join('\n');
    assert.equal(out.code, 0, `on ${name} (${now}):\n${notOk || out.stderr}`);
  });
});

// The suites above catch this in the fixtures they load. This catches it in
// every other test file, for the one engine call that turns a clock into a
// gameweek.
test('no FPL test asks the lifecycle for a gameweek without saying when', () => {
  const offenders = [];
  for (const file of readdirSync(HERE).filter((f) => f.endsWith('.test.mjs') && f !== 'frozen-fixture-clock.test.mjs')) {
    const source = readFileSync(join(HERE, file), 'utf8');
    for (const m of source.matchAll(/gameweekLifecycle\(([^;\n]*)/g)) {
      if (!/\bnow\b/.test(m[1])) offenders.push(`${file}: ${m[0].trim()}`);
    }
  }
  assert.deepEqual(offenders, []);
});
