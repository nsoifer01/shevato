// The unit-test failure summary that ci.yml writes to the run page
// (scripts/ci-junit-summary.mjs). The input shape is node:test's own JUnit
// reporter output, captured from a real failing run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize } from '../../scripts/ci-junit-summary.mjs';

const REAL = `<?xml version="1.0" encoding="utf-8"?>
<testsuites>
	<testcase name="passes" time="0.000428" classname="test"/>
	<testcase name="fails with a message" time="0.000368" classname="test" failure="arithmetic is broken4 !== 5">
		<failure type="testCodeFailure" message="arithmetic is broken4 !== 5">
[Error [ERR_TEST_FAILURE]: arithmetic is broken
] {
  code: 'ERR_TEST_FAILURE'
}
		</failure>
	</testcase>
	<testcase name="the &quot;quoted&quot; one &amp; \`ticks\` | pipes" time="0.003" classname="test" failure="&apos;Promise resolution is still pending&apos;">
		<failure type="cancelledByParent" message="x"></failure>
	</testcase>
</testsuites>`;

test('failing tests are named, with their message, and counted against the total', () => {
  const out = summarize(REAL);
  assert.match(out, /^### Unit tests: 2 of 3 failed/);
  assert.match(out, /- fails with a message - `arithmetic is broken4 !== 5`/);
  // Markdown-breaking characters are neutralised, entities are decoded.
  assert.match(out, /- the "quoted" one & 'ticks' ' pipes - `'Promise resolution is still pending'`/);
  assert.doesNotMatch(out, /passes -/, 'a passing test is not listed');
});

test('a clean report says so', () => {
  assert.equal(summarize('<testsuites><testcase name="a"/><testcase name="b"/></testsuites>'), '### Unit tests: all 2 passed\n');
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
