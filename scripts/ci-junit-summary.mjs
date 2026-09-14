#!/usr/bin/env node
// Turns node:test's JUnit report into a short Markdown result for the GitHub
// run summary and the job log.
//
//   node scripts/ci-junit-summary.mjs unit-tests.junit.xml | tee -a "$GITHUB_STEP_SUMMARY"
//
// The `test` job in .github/workflows/ci.yml prints `dot` output, which shows
// failures in full at the end of the log but no totals at all. This runs on
// every outcome, so a green run still states how many tests executed, and a red
// one names what failed without anyone opening the log.
//
// Two details of node's JUnit shape (measured 2026-09-14) decide the counts:
//   - a `{ todo }` test (this repo's KNOWN DEFECT quarantine) that fails still
//     carries a `failure=` attribute, next to `<skipped type="todo">`, although
//     it does not fail the run. It is counted as todo, never as a failure;
//   - the root ends with `<!-- tests N -->`, `<!-- pass N -->`, `<!-- fail N -->`,
//     `<!-- skipped N -->` and `<!-- todo N -->`, the runner's own totals, which
//     are used whenever present.
// No XML dependency: the reporter's output is regular enough to read directly.
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

/** Every testcase as { name, failure, kind: 'pass' | 'fail' | 'skipped' | 'todo' }. */
export function testcases(xml) {
  const out = [];
  const re = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  for (const m of String(xml).matchAll(re)) {
    const open = `<testcase${m[1]}>`;
    const body = m[3] || '';
    const skippedType = (/<skipped\b[^>]*\btype="([^"]*)"/.exec(body) || [])[1] || null;
    const failure = attr(open, 'failure');
    let kind = 'pass';
    if (skippedType === 'todo') kind = 'todo';
    else if (skippedType) kind = 'skipped';
    else if (failure !== null || /<failure\b/.test(body)) kind = 'fail';
    out.push({ name: attr(open, 'name') || '(unnamed)', failure, kind });
  }
  return out;
}

function totals(xml, cases) {
  const read = (k) => {
    const m = new RegExp(`<!--\\s*${k}\\s+(\\d+)\\s*-->`).exec(xml);
    return m ? Number(m[1]) : null;
  };
  const count = (kind) => cases.filter((c) => c.kind === kind).length;
  return {
    tests: read('tests') ?? cases.length,
    fail: read('fail') ?? count('fail'),
    skipped: read('skipped') ?? count('skipped'),
    todo: read('todo') ?? count('todo'),
  };
}

export function summarize(xml, { limit = 50 } = {}) {
  if (xml == null) {
    return '### Unit tests: no JUnit report was written\n\nThe run ended before the reporter could write it '
      + '(a crash, a timeout, or a failure before any test started). Read the end of the job log.\n';
  }
  const cases = testcases(xml);
  const t = totals(String(xml), cases);
  const extras = [t.skipped ? `${t.skipped} skipped` : '', t.todo ? `${t.todo} todo` : ''].filter(Boolean).join(', ');
  const failed = cases.filter((c) => c.kind === 'fail');
  if (!t.fail && !failed.length) {
    return `### Unit tests: all ${t.tests} passed${extras ? ` (${extras})` : ''}\n`;
  }
  const md = (s) => s.replace(/[`|]/g, "'").replace(/\s+/g, ' ').trim();
  const lines = [`### Unit tests: ${t.fail || failed.length} of ${t.tests} failed${extras ? ` (${extras})` : ''}`, ''];
  for (const c of failed.slice(0, limit)) {
    const message = md(c.failure || '').slice(0, 300);
    lines.push(`- ${md(c.name)}${message ? ` - \`${message}\`` : ''}`);
  }
  if (failed.length > limit) lines.push(`- ... and ${failed.length - limit} more; the full list is at the end of the job log`);
  return `${lines.join('\n')}\n`;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  let xml = null;
  try { xml = readFileSync(process.argv[2], 'utf8'); } catch { xml = null; }
  process.stdout.write(summarize(xml));
}
