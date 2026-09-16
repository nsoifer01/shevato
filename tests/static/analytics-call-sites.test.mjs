// Every analytics call site names a real helper method, every app_action name
// is on a committed list, and api.events is the complete event vocabulary.
//
// Why: the eight per-app shims (`track('<method>', ...args)`) resolve
// window.shevatoAnalytics at call time and silently no-op on a method the
// helper does not have, and an action name is just a string. So
// `track('trackVeiw', v)` or `trackAction('workout_complete')` passes the unit
// estate, the lint gate and the browser suites, and shows up only as a GA4
// dimension going quiet weeks later (audit 2026-09-12, A-1 / F4).
//
// The action list below is also the list privacy.html's analytics section
// names, so adding an action means changing both in the same PR.
//
// The helper's public methods and its `events` map are read by LOADING
// assets/js/analytics.js in a vm, never hand-copied, so this test cannot drift
// from the helper it checks.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const HELPER = 'assets/js/analytics.js';

/**
 * Every `app_action` name the site may send. Committed on purpose: a new name
 * is a change to what the privacy page promises, so it must be a deliberate
 * edit here rather than a string that appears in an app.
 */
// Each app pairs a "started the primary workflow" action with the action that
// completes it, added 2026-09-16. Only completions were recorded before, so
// "nobody finishes" and "nobody begins" were the same picture: over 180 days
// the whole portfolio produced 108 non-owner actions and 105 were MapTap's.
// Football H2H had no action at all, which is why it gains both halves here.
const ALLOWED_ACTIONS = new Set([
  'assistant_opened',          // trip-planner
  'copy_compare_link',         // rising-shows
  'export_compare_kometa',     // rising-shows
  'game_started',              // arena          (starts room_created/room_joined)
  'games_logged',              // maptap-rivals  (completes rival_added)
  'gameweek_plan_calculated',  // fpl-planner    (completes team_connected)
  'match_form_opened',         // football-h2h   (starts match_logged)
  'match_logged',              // football-h2h
  'race_form_opened',          // mario-kart     (starts race_logged)
  'race_logged',               // mario-kart
  'rival_added',               // maptap-rivals
  'room_created',              // arena
  'room_joined',               // arena
  'share_chart_image',         // rising-shows
  'team_connected',            // fpl-planner
  'trip_created',              // trip-planner   (starts trip_shared)
  'trip_shared',               // trip-planner
  'workout_completed',         // gym-tracker
  'workout_started',           // gym-tracker    (starts workout_completed)
]);

// -- The helper's real public surface ---------------------------------------------

function loadHelper() {
  const noop = () => {};
  const win = {
    location: { pathname: '/', href: 'https://shevato.com/', hostname: 'shevato.com' },
    addEventListener: noop,
    gtag: noop,
  };
  win.window = win;
  const sandbox = { window: win, document: { addEventListener: noop, referrer: '' }, URL };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(join(REPO_ROOT, HELPER), 'utf8'), sandbox, { filename: HELPER });
  return win.shevatoAnalytics;
}

const API = loadHelper();
const METHODS = new Set(Object.keys(API || {}).filter((k) => typeof API[k] === 'function'));
const EVENTS = new Set(Object.values((API && API.events) || {}));

// -- Scanner ---------------------------------------------------------------------------

const LITERAL = /^\s*(['"])([^'"\\\n]*)\1/;

/**
 * Finds every analytics call in one source file.
 * Recognises the shim form `track('<method>', <arg>...)` and direct calls on
 * the helper: `shevatoAnalytics.<method>(<arg>...)`, plus a local alias bound
 * by `var x = window.shevatoAnalytics;` (assets/js/analytics-404.js).
 * @returns {Array<{where: string, method: string|null, arg: string|null}>}
 *   method is null when the shim was given a non-literal method name; arg is
 *   the first argument after the method when it is a string literal, else null.
 */
function scanSource(rel, src) {
  const calls = [];
  const where = (idx) => `${rel}:${src.slice(0, idx).split('\n').length}`;
  const literalAt = (from) => {
    const m = LITERAL.exec(src.slice(from, from + 200));
    return m ? { value: m[2], end: from + m[0].length } : null;
  };

  for (const m of src.matchAll(/(?<![\w$.])track\s*\(/g)) {
    if (/function\s*$/.test(src.slice(Math.max(0, m.index - 20), m.index))) continue; // the shim's own definition
    const lit = literalAt(m.index + m[0].length);
    if (!lit) {
      calls.push({ where: where(m.index), method: null, arg: null });
      continue;
    }
    const comma = /^\s*,/.exec(src.slice(lit.end, lit.end + 50));
    const arg = comma ? literalAt(lit.end + comma[0].length) : null;
    calls.push({ where: where(m.index), method: lit.value, arg: arg && arg.value });
  }

  const receivers = ['shevatoAnalytics'];
  for (const m of src.matchAll(/\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*window\.shevatoAnalytics\s*;/g)) {
    receivers.push(m[1]);
  }
  for (const receiver of receivers) {
    const re = new RegExp(`(?<![\\w$])${receiver.replace(/\$/g, '\\$')}\\s*\\??\\.\\s*([A-Za-z_$][\\w$]*)\\s*\\(`, 'g');
    for (const m of src.matchAll(re)) {
      const arg = literalAt(m.index + m[0].length);
      calls.push({ where: where(m.index), method: m[1], arg: arg && arg.value });
    }
  }
  return calls;
}

function methodProblems(calls) {
  return calls
    .filter((c) => c.method === null || !METHODS.has(c.method))
    .map((c) => (c.method === null
      ? `${c.where}: track() is called with a non-literal method name; use a string literal so this test can check it`
      : `${c.where}: '${c.method}' is not a public method of window.shevatoAnalytics (${HELPER}); the shim would silently drop it. Known methods: ${[...METHODS].sort().join(', ')}`));
}

function actionProblems(calls) {
  return calls
    .filter((c) => c.method === 'trackAction' && (c.arg === null || !ALLOWED_ACTIONS.has(c.arg)))
    .map((c) => (c.arg === null
      ? `${c.where}: trackAction is called with a non-literal action name; action names must be string literals`
      : `${c.where}: action '${c.arg}' is not in ALLOWED_ACTIONS (tests/static/analytics-call-sites.test.mjs). A typo? A new action must be added there AND to the privacy.html analytics list in the same change`));
}

function eventProblems(calls) {
  return calls
    .filter((c) => c.method === 'track' && (c.arg === null || !EVENTS.has(c.arg)))
    .map((c) => (c.arg === null
      ? `${c.where}: track() on the helper is called with a non-literal event name`
      : `${c.where}: event '${c.arg}' is not in api.events (${HELPER}). A typo? A new event must be added to api.events AND to privacy.html in the same change`));
}

// -- The estate --------------------------------------------------------------------------

function sourceFiles() {
  const out = [];
  const isSource = (name) => /\.m?js$/.test(name) && !/\.min\.js$/.test(name);
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'tests' && entry.name !== 'vendor' && entry.name !== 'node_modules') walk(full);
      } else if (entry.isFile() && isSource(entry.name)) {
        out.push(full);
      }
    }
  };
  for (const app of readdirSync(join(REPO_ROOT, 'apps'), { withFileTypes: true })) {
    const js = join(REPO_ROOT, 'apps', app.name, 'js');
    if (app.isDirectory() && existsSync(js)) walk(js);
  }
  for (const entry of readdirSync(join(REPO_ROOT, 'assets/js'), { withFileTypes: true })) {
    if (entry.isFile() && isSource(entry.name)) out.push(join(REPO_ROOT, 'assets/js', entry.name));
  }
  return out;
}

const CALLS = sourceFiles().flatMap((file) => {
  const rel = relative(REPO_ROOT, file).split('\\').join('/');
  return scanSource(rel, readFileSync(file, 'utf8'));
});

// -- Tests --------------------------------------------------------------------------------

test('the helper loads and exposes its public methods and event map', () => {
  assert.ok(API, `${HELPER} did not install window.shevatoAnalytics in a vm`);
  for (const m of ['track', 'trackView', 'trackAction', 'trackError']) {
    assert.ok(METHODS.has(m), `expected ${m} among the helper's methods, got ${[...METHODS].join(', ')}`);
  }
  assert.ok(EVENTS.has('app_error'), 'api.events is missing or unreadable');
});

test('the scan found the call sites (a broken pattern must not pass by finding nothing)', () => {
  // 25 call sites and 11 distinct action names on 2026-09-13.
  assert.ok(CALLS.length >= 20, `only ${CALLS.length} analytics call sites found; the scanner patterns are probably broken`);
  assert.ok(CALLS.some((c) => c.method === 'track' && c.where.startsWith('assets/js/analytics-404.js')), 'the 404 reporter alias was not recognised');
  assert.ok(CALLS.some((c) => c.method === 'trackAction' && c.where.startsWith('apps/mario-kart/js/dataManager.js')), 'the direct window.shevatoAnalytics call was not recognised');
});

test('every analytics call site names a real helper method', () => {
  const problems = methodProblems(CALLS);
  assert.deepEqual(problems, [], `\n${problems.join('\n')}`);
});

test('every app_action name is on the committed allow-list, and every listed name is still sent', () => {
  const problems = actionProblems(CALLS);
  assert.deepEqual(problems, [], `\n${problems.join('\n')}`);
  const sent = new Set(CALLS.filter((c) => c.method === 'trackAction').map((c) => c.arg));
  const stale = [...ALLOWED_ACTIONS].filter((name) => !sent.has(name));
  assert.deepEqual(stale, [], `ALLOWED_ACTIONS lists actions nothing sends any more: ${stale.join(', ')}. Remove them here and from privacy.html`);
});

test('api.events is the complete event vocabulary: every event sent is in it, and every entry is sent', () => {
  const problems = eventProblems(CALLS);
  const helperSrc = readFileSync(join(REPO_ROOT, HELPER), 'utf8');
  const helperEvents = [...helperSrc.matchAll(/sendSafely\(\s*'([^']+)'/g)].map((m) => m[1]);
  assert.ok(helperEvents.length >= 10, `only ${helperEvents.length} sendSafely('<event>') calls found in ${HELPER}`);
  for (const name of helperEvents) {
    if (!EVENTS.has(name)) problems.push(`${HELPER}: sendSafely('${name}') is not in api.events`);
  }
  assert.deepEqual(problems, [], `\n${problems.join('\n')}`);

  const produced = new Set([...helperEvents, ...CALLS.filter((c) => c.method === 'track').map((c) => c.arg)]);
  const unused = [...EVENTS].filter((name) => !produced.has(name));
  assert.deepEqual(unused, [], `api.events names events nothing sends: ${unused.join(', ')}`);
});

test('the scanner names file:line for a typo, an unknown action and a non-literal name', () => {
  // Pins the checks above: without this, a scanner that silently parsed
  // nothing would make every assertion vacuously green.
  const fixture = [
    "track('trackVeiw', 'workout');",
    "track('trackAction', 'workout_complete', { set_count: 3 });",
    'window.shevatoAnalytics.trackAction(actionName);',
    'track(method, 1);',
    "var ga = window.shevatoAnalytics;\nga.track('page_not_fuond', {});",
    "track('trackAction', 'workout_completed');",
  ].join('\n');
  const calls = scanSource('fixture.js', fixture);
  const all = [...methodProblems(calls), ...actionProblems(calls), ...eventProblems(calls)];
  const expectLine = (fragment, where) => assert.ok(
    all.some((p) => p.startsWith(where) && p.includes(fragment)),
    `expected a problem at ${where} mentioning ${fragment}; got:\n${all.join('\n')}`,
  );
  expectLine("'trackVeiw' is not a public method", 'fixture.js:1:');
  expectLine("action 'workout_complete' is not in ALLOWED_ACTIONS", 'fixture.js:2:');
  expectLine('non-literal action name', 'fixture.js:3:');
  expectLine('non-literal method name', 'fixture.js:4:');
  expectLine("event 'page_not_fuond' is not in api.events", 'fixture.js:6:');
  assert.equal(all.some((p) => p.startsWith('fixture.js:7:')), false, 'a correct call must not be reported');
});
