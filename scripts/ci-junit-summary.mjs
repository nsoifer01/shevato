#!/usr/bin/env node
// Turns node:test's JUnit report into a short Markdown failure list for the
// GitHub run summary.
//
//   node scripts/ci-junit-summary.mjs unit-tests.junit.xml >> "$GITHUB_STEP_SUMMARY"
//
// The `test` job in .github/workflows/ci.yml prints `dot` output, whose
// failures are already at the end of the log; this puts the same names on the
// run's summary page, so "which test failed?" is answered without opening a
// log at all. No XML dependency: node's JUnit reporter writes flat, attribute-
// escaped <testcase> elements, which is all this reads.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const unescape = (s) => String(s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
  .replace(/&amp;/g, '&');

function attr(tag, name) {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? unescape(m[1]) : null;
}

export function summarize(xml, { limit = 50 } = {}) {
  if (xml == null) {
    return '### Unit tests: no JUnit report was written\n\nThe run ended before the reporter could write it '
      + '(a crash, a timeout, or a failure before any test started). Read the end of the job log.\n';
  }
  const cases = [...String(xml).matchAll(/<testcase\b[^>]*>/g)].map((m) => m[0]);
  const failed = cases.filter((tag) => attr(tag, 'failure') !== null);
  if (!failed.length) return `### Unit tests: all ${cases.length} passed\n`;
  const md = (s) => s.replace(/[`|]/g, "'").replace(/\s+/g, ' ').trim();
  const lines = [`### Unit tests: ${failed.length} of ${cases.length} failed`, ''];
  for (const tag of failed.slice(0, limit)) {
    const message = md(attr(tag, 'failure') || '').slice(0, 300);
    lines.push(`- ${md(attr(tag, 'name') || '(unnamed)')}${message ? ` - \`${message}\`` : ''}`);
  }
  if (failed.length > limit) lines.push(`- ... and ${failed.length - limit} more; the full list is at the end of the job log`);
  return `${lines.join('\n')}\n`;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  let xml = null;
  try { xml = readFileSync(process.argv[2], 'utf8'); } catch { xml = null; }
  process.stdout.write(summarize(xml));
}
