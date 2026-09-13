// The CSP violation sink (netlify/functions/csp-report.mjs).
//
// An unauthenticated endpoint the BROWSER posts to on its own, carrying the
// URL of the page the visitor was on. What makes it acceptable is what it
// throws away, and those promises are the whole of this file: only the page
// PATH (a Trip Planner share fragment carries an itinerary, a query carries
// what somebody typed), only the ORIGIN of a blocked resource, never a script
// sample (a slice of source that can be handling user data), bounded input,
// and nothing but POST. Each is asserted on the line that reaches the log,
// because the log is the only place the data goes.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import handler, { summarise, safeOrigin, safePath } from '../csp-report.mjs';

let logged, realLog;
beforeEach(() => {
  logged = [];
  realLog = console.log;
  console.log = (...args) => { logged.push(args.map(String).join(' ')); };
});
afterEach(() => { console.log = realLog; });

const post = (body, headers = { 'Content-Type': 'application/csp-report' }) => handler(new Request(
  'https://shevato.com/.netlify/functions/csp-report',
  { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) },
));

/** A legacy report-uri body, the shape netlify.toml's `report-uri` produces. */
const report = (over = {}) => ({
  'csp-report': {
    'document-uri': 'https://shevato.com/apps/trip-planner/?trip=Kyoto%20with%20Mum#share=eyJpdGVtcyI6W119',
    'referrer': 'https://www.google.com/search?q=private+words',
    'violated-directive': 'script-src-elem',
    'effective-directive': 'script-src-elem',
    'blocked-uri': 'https://evil.example/steal.js?token=abc123#frag',
    'script-sample': 'const secretToken = "do-not-log-me"',
    'disposition': 'report',
    ...over,
  },
});

test('anything but POST is refused with 405 and logs nothing', async () => {
  for (const method of ['GET', 'PUT', 'DELETE']) {
    const res = await handler(new Request('https://shevato.com/.netlify/functions/csp-report', { method }));
    assert.equal(res.status, 405, method);
    assert.deepEqual(await res.json(), { error: 'method_not_allowed' });
  }
  assert.equal(logged.length, 0);
});

test('a real report is logged as ONE line: directive, blocked origin, page path, disposition', async () => {
  const res = await post(report());
  assert.equal(res.status, 204);
  assert.equal(logged.length, 1);
  const [tag, payload] = [logged[0].split(' ')[0], JSON.parse(logged[0].slice(logged[0].indexOf(' ') + 1))];
  assert.equal(tag, 'csp-violation');
  assert.deepEqual(payload, {
    directive: 'script-src-elem',
    blockedOrigin: 'https://evil.example',
    documentPath: '/apps/trip-planner/',
    disposition: 'report',
  });
});

test('the page keeps its pathname only: no query, no fragment, whatever the URL carries', async () => {
  await post(report());
  const line = logged.join('\n');
  assert.ok(!line.includes('Kyoto'), 'the query is gone');
  assert.ok(!line.includes('share='), 'the share fragment (an itinerary) is gone');
  assert.ok(!line.includes('eyJpdGVtcyI6W119'));
  assert.equal(safePath('https://shevato.com/a/b?c=d#e'), '/a/b');
  assert.equal(safePath('not a url'), '', 'an unparseable page URL records nothing, not the raw string');
  assert.equal(safePath('https://shevato.com/' + 'x'.repeat(500)).length, 200, 'and the path is capped');
});

test('a blocked resource is reduced to its origin', async () => {
  await post(report());
  const line = logged.join('\n');
  assert.ok(!line.includes('steal.js'), 'no path');
  assert.ok(!line.includes('abc123'), 'no query');
  assert.equal(safeOrigin('https://cdn.example:8443/x/y.js?z=1'), 'https://cdn.example:8443');
  assert.equal(safeOrigin('inline'), 'inline', 'the opaque keywords are already non-identifying');
  assert.equal(safeOrigin('data'), 'data');
  assert.equal(safeOrigin('x'.repeat(100)).length, 32, 'and a keyword-shaped value is capped');
});

test('the script sample and the referrer are never logged', async () => {
  await post(report());
  const line = logged.join('\n');
  assert.ok(!line.includes('secretToken') && !line.includes('do-not-log-me'), 'no script sample');
  assert.ok(!line.includes('google.com') && !line.includes('private+words'), 'no referrer');
  assert.deepEqual(Object.keys(summarise(report())).sort(),
    ['blockedOrigin', 'directive', 'disposition', 'documentPath'], 'summarise emits exactly four fields');
});

test('an oversize body is dropped without a log line', async () => {
  // A browser report is a few hundred bytes. Past 8 KB the body is cut, the
  // cut JSON cannot parse, and the sink answers 204 and records nothing.
  const big = report({ 'script-sample': 'x'.repeat(9000) });
  const res = await post(big);
  assert.equal(res.status, 204);
  assert.equal(logged.length, 0);
});

test('a malformed body is a quiet 204, not a 400 a browser would retry', async () => {
  const res = await post('{not json');
  assert.equal(res.status, 204);
  assert.equal(logged.length, 0);
});

test('a body with no directive is not a CSP report and logs nothing', async () => {
  const res = await post({ hello: 'world' });
  assert.equal(res.status, 204);
  assert.equal(logged.length, 0);
});

test('a batch is capped at twenty reports', async () => {
  // Reporting-API shape (an array of { body }), each entry small enough that
  // thirty of them stay under the 8 KB body cap.
  const one = { 'effective-directive': 'img-src', 'blocked-uri': 'https://x.example/a', 'document-uri': 'https://shevato.com/' };
  const batch = Array.from({ length: 30 }, () => ({ body: one }));
  const res = await post(batch);
  assert.equal(res.status, 204);
  assert.equal(logged.length, 20);
});

test('the directive is one bounded token, so a hostile value cannot write a long line', () => {
  const s = summarise({ 'violated-directive': 'script-src ' + 'a'.repeat(200) });
  assert.equal(s.directive, 'script-src');
  assert.equal(summarise({ 'effective-directive': 'y'.repeat(100) }).directive.length, 40);
  assert.equal(summarise(report({ disposition: 'enforce' })).disposition, 'enforce');
  assert.equal(summarise(report({ disposition: 'anything else' })).disposition, 'report');
});
