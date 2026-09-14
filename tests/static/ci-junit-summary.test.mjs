// The unit-test result summary that ci.yml writes to the run page and the job
// log (scripts/ci-junit-summary.mjs). The fixtures are node:test's own JUnit
// reporter output, captured from real runs on 2026-09-14.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize, testcases } from '../../scripts/ci-junit-summary.mjs';

// A passing test, a skip, a KNOWN DEFECT todo whose body fails, and a subtest
// inside its parent's testsuite: a GREEN run.
const GREEN = `<?xml version="1.0" encoding="utf-8"?>
<testsuites>
	<testcase name="a plain pass" time="0.000579" classname="test"/>
	<testcase name="a skipped test" time="0.000078" classname="test">
		<skipped type="skipped" message="needs a thing"/>
	</testcase>
	<testcase name="a todo test" time="0.007105" classname="test" failure="The expression evaluated to a falsy value:  assert.ok(false)">
		<skipped type="todo" message="KNOWN DEFECT: x"/>
		<failure type="testCodeFailure" message="The expression evaluated to a falsy value:  assert.ok(false)">
[Error [ERR_TEST_FAILURE]: The expression evaluated to a falsy value:
]
		</failure>
	</testcase>
	<testsuite name="a parent" time="0.000346" disabled="0" errors="0" tests="1" failures="0" skipped="0" hostname="h">
		<testcase name="a subtest" time="0.000084" classname="test"/>
	</testsuite>
	<!-- tests 5 -->
	<!-- suites 0 -->
	<!-- pass 3 -->
	<!-- fail 0 -->
	<!-- cancelled 0 -->
	<!-- skipped 1 -->
	<!-- todo 1 -->
	<!-- duration_ms 49.841836 -->
</testsuites>`;

const RED = `<?xml version="1.0" encoding="utf-8"?>
<testsuites>
	<testcase name="passes" time="0.000428" classname="test"/>
	<testcase name="fails with a message" time="0.000368" classname="test" failure="arithmetic is broken4 !== 5">
		<failure type="testCodeFailure" message="arithmetic is broken4 !== 5">
[Error [ERR_TEST_FAILURE]: arithmetic is broken
]
		</failure>
	</testcase>
	<testcase name="the &quot;quoted&quot; one &amp; \`ticks\` | pipes" time="0.003" classname="test" failure="&apos;Promise resolution is still pending&apos;">
		<failure type="cancelledByParent" message="x"></failure>
	</testcase>
	<!-- tests 3 -->
	<!-- pass 1 -->
	<!-- fail 2 -->
	<!-- skipped 0 -->
	<!-- todo 0 -->
</testsuites>`;

test('THE TRAP: a failing KNOWN DEFECT todo is counted as todo, never as a failure', () => {
  const kinds = testcases(GREEN).map((c) => c.kind);
  assert.deepEqual(kinds, ['pass', 'skipped', 'todo', 'pass']);
  assert.match(summarize(GREEN), /^### Unit tests: all 5 passed \(1 skipped, 1 todo\)\n/);
});

test('a green run names every test that did not run, and why', () => {
  // A count alone cannot say whether the skipped test was the one that matters
  // (CI once skipped ten real-catalogue parity tests on every run).
  assert.equal(summarize(GREEN), '### Unit tests: all 5 passed (1 skipped, 1 todo)\n\n'
    + 'Did not run (2):\n- skipped: a skipped test - needs a thing\n- todo: a todo test - KNOWN DEFECT: x\n');
});

test('a green run states how many tests ran, from the runner\'s own totals', () => {
  assert.match(summarize(GREEN), /all 5 passed/, 'the totals comment, not the testcase tag count');
  assert.equal(summarize('<testsuites><testcase name="a"/><testcase name="b"/></testsuites>'),
    '### Unit tests: all 2 passed\n', 'counted from the testcases when the comments are absent');
});

test('failing tests are named, with their message, and counted against the total', () => {
  const out = summarize(RED);
  assert.match(out, /^### Unit tests: 2 of 3 failed/);
  assert.match(out, /- fails with a message - `arithmetic is broken4 !== 5`/);
  // Markdown-breaking characters are neutralised, entities are decoded.
  assert.match(out, /- the "quoted" one & 'ticks' ' pipes - `'Promise resolution is still pending'`/);
  assert.doesNotMatch(out, /- passes/, 'a passing test is not listed');
});

test('a missing report is reported as missing, never as a pass', () => {
  assert.match(summarize(null), /no JUnit report was written/);
});

test('a long failure list is capped and says how many it left out', () => {
  const many = `<testsuites>${Array.from({ length: 60 }, (_, i) => `<testcase name="t${i}" failure="no"/>`).join('')}</testsuites>`;
  const out = summarize(many, { limit: 50 });
  assert.equal(out.split('\n').filter((l) => /^- t\d+/.test(l)).length, 50);
  assert.match(out, /and 10 more/);
});
