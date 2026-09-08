'use strict';

// Tests for the shared analytics helper (assets/js/analytics.js).
//
// The module is a classic IIFE that installs window.shevatoAnalytics and
// configures GA4. It is loaded into a fresh vm context per test with a
// stubbed window/document, matching the pattern the app test suites use.
//
// Everything asserted here is a guarantee the rest of the site relies on:
// one page_view per load, no personal data on the wire, dedupe on repeated
// view/filter events, and total immunity to gtag failures.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'analytics.js'), 'utf8');

/**
 * Loads analytics.js into a fresh context.
 * @param {object} opts
 * @param {string} opts.pathname   window.location.pathname to simulate
 * @param {string} [opts.href]      full window.location.href (query + hash)
 * @param {string} [opts.hash]      window.location.hash
 * @param {string} [opts.referrer]  document.referrer
 * @param {object} [opts.pageConfig] value for window.SHEVATO_ANALYTICS_CONFIG
 * @param {boolean} [opts.breakGtag] make gtag throw, to prove callers survive
 * @returns {{api: object, calls: Array, listeners: object}}
 */
function load(opts) {
  const calls = [];
  const listeners = {};

  const el = () => ({
    closest: () => null,
    getAttribute: () => null,
  });

  const sandbox = {
    console,
    Date,
    JSON,
    Math,
    Object,
    Array,
    String,
    Number,
    Boolean,
    isFinite,
    URL,
    RegExp,
    encodeURIComponent,
    document: {
      addEventListener(type, fn) { listeners[type] = fn; },
      querySelector: el,
      referrer: opts.referrer || '',
    },
  };

  sandbox.window = {
    location: {
      pathname: opts.pathname,
      hash: opts.hash || '',
      href: opts.href || ('https://shevato.com' + opts.pathname),
      hostname: 'shevato.com',
    },
    addEventListener(type, fn) { listeners[type] = fn; },
    SHEVATO_ANALYTICS_CONFIG: opts.pageConfig,
    gtag(...args) {
      if (opts.breakGtag) throw new Error('gtag exploded');
      calls.push(args);
    },
  };
  sandbox.window.window = sandbox.window;

  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);

  return { api: sandbox.window.shevatoAnalytics, calls, listeners, win: sandbox.window };
}

/** Convenience: only the gtag('event', …) calls. */
const events = (calls) => calls.filter((c) => c[0] === 'event');
/** Convenience: only the gtag('config', …) calls. */
const configs = (calls) => calls.filter((c) => c[0] === 'config');

test('fires exactly one config (page_view) per page load', () => {
  const { calls } = load({ pathname: '/home.html' });
  assert.equal(configs(calls).length, 1);
});

test('reported page_path drops the .html extension', () => {
  const { calls } = load({ pathname: '/apps.html' });
  assert.equal(configs(calls)[0][2].page_path, '/apps');
});

test('extensionless paths are reported unchanged', () => {
  const { calls } = load({ pathname: '/apps' });
  assert.equal(configs(calls)[0][2].page_path, '/apps');
});

test('directory URLs keep their trailing slash', () => {
  const { calls } = load({ pathname: '/apps/rising-shows/shows/24-tt0285331/' });
  assert.equal(configs(calls)[0][2].page_path, '/apps/rising-shows/shows/24-tt0285331/');
});

test('a page may override page_path (404 collapsing)', () => {
  const { calls } = load({ pathname: '/some/bogus/url', pageConfig: { pagePath: '/404' } });
  assert.equal(configs(calls)[0][2].page_path, '/404');
});

test('loading twice does not double-configure', () => {
  const { calls, win } = load({ pathname: '/home.html' });
  assert.equal(configs(calls).length, 1);
  // Re-running the IIFE against the same window must be a no-op, because
  // a second gtag('config') would fire a second page_view for one load.
  const sandbox = { console, Date, JSON, Math, Object, Array, String, Number, Boolean, isFinite, URL, RegExp, window: win, document: { addEventListener() {}, referrer: '' } };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  assert.equal(configs(calls).length, 1);
});

test('app_open fires automatically on an app entry page', () => {
  const { calls } = load({ pathname: '/apps/gym-tracker/' });
  const opens = events(calls).filter((c) => c[1] === 'app_open');
  assert.equal(opens.length, 1);
  assert.equal(opens[0][2].app_name, 'gym-tracker');
});

test('app_open does NOT fire on generated content pages', () => {
  const { calls } = load({ pathname: '/apps/rising-shows/shows/24-tt0285331/' });
  assert.equal(events(calls).filter((c) => c[1] === 'app_open').length, 0);
});

test('app_open does NOT fire on marketing pages', () => {
  const { calls } = load({ pathname: '/home.html' });
  assert.equal(events(calls).filter((c) => c[1] === 'app_open').length, 0);
});

test('app_name and app_section are derived from the URL', () => {
  const { api, calls } = load({ pathname: '/apps/rising-shows/shows/foo/' });
  api.trackContentView({ contentType: 'show', contentId: 'tt1' });
  const e = events(calls).pop();
  assert.equal(e[2].app_name, 'rising-shows');
  assert.equal(e[2].app_section, 'shows');
});

test('structural parameters survive the scrubber', () => {
  // Regression: the BANNED_PARAM `_name$` rule was stripping view_name,
  // action_name and filter_name, which is the entire payload of app_view,
  // app_action and filter_change. Every one of those events reached GA4
  // carrying nothing but app_name/app_section, making them useless.
  const { api, calls } = load({ pathname: '/apps/gym-tracker/' });

  api.trackView('workout');
  assert.equal(events(calls).pop()[2].view_name, 'workout');

  api.trackAction('workout_completed', { set_count: 12 });
  const action = events(calls).pop()[2];
  assert.equal(action.action_name, 'workout_completed');
  assert.equal(action.set_count, 12);

  api.trackFilter('sort', 'votes:desc');
  const filter = events(calls).pop()[2];
  assert.equal(filter.filter_name, 'sort');
  assert.equal(filter.filter_value, 'votes:desc');
});

test('the exemption does not weaken the ban on user-entered names', () => {
  const { api, calls } = load({ pathname: '/apps/trip-planner/' });
  api.track('probe', { trip_name: 'Split', player_name: 'Ann', rival_name: 'Bo', name: 'X' });
  const p = events(calls).pop()[2];
  assert.equal(p.trip_name, undefined);
  assert.equal(p.player_name, undefined);
  assert.equal(p.rival_name, undefined);
  assert.equal(p.name, undefined);
});

test('trackView dedupes repeated views but allows a return visit', () => {
  const { api, calls } = load({ pathname: '/apps/gym-tracker/' });
  api.trackView('workout');
  api.trackView('workout');
  api.trackView('history');
  assert.equal(events(calls).filter((c) => c[1] === 'app_view').length, 2);
});

test('trackFilter dedupes an unchanged value but reports a real change', () => {
  const { api, calls } = load({ pathname: '/apps/rising-shows/' });
  api.trackFilter('sort', 'votes:desc');
  api.trackFilter('sort', 'votes:desc');
  api.trackFilter('sort', 'rating:asc');
  assert.equal(events(calls).filter((c) => c[1] === 'filter_change').length, 2);
});

test('trackSearch reports shape and outcome, never the query', () => {
  const { api, calls } = load({ pathname: '/apps/rising-shows/' });
  api.trackSearch({ scope: 'shows', queryLength: 7, resultsCount: 12 });
  const p = events(calls).pop()[2];
  assert.equal(p.query_length, 7);
  assert.equal(p.results_count, 12);
  assert.equal(p.has_results, true);
  // No parameter may carry text that could be the query itself.
  assert.equal(p.search_term, undefined);
  assert.equal(p.query, undefined);
});

test('scrubber drops parameters whose names suggest free text or identity', () => {
  const { api, calls } = load({ pathname: '/apps/trip-planner/' });
  api.track('probe', {
    trip_name: 'Honeymoon in Split',
    search_term: 'anxiety meds',
    user_email: 'a@b.com',
    note: 'call mum',
    item_title: 'Flight LH123',
    safe_count: 4,
  });
  const p = events(calls).pop()[2];
  assert.equal(p.trip_name, undefined);
  assert.equal(p.search_term, undefined);
  assert.equal(p.user_email, undefined);
  assert.equal(p.note, undefined);
  assert.equal(p.item_title, undefined);
  assert.equal(p.safe_count, 4);
});

test('scrubber drops values that look like emails or opaque ids', () => {
  const { api, calls } = load({ pathname: '/apps/arena/' });
  api.track('probe', {
    contact: 'someone@example.com',
    ref: 'aVeryLongOpaqueIdentifier123456',
    mode: 'solo',
  });
  const p = events(calls).pop()[2];
  assert.equal(p.contact, undefined);
  assert.equal(p.ref, undefined);
  assert.equal(p.mode, 'solo');
});

test('catalogue slugs survive the opaque-id filter', () => {
  // Regression: an earlier length-only rule (24+ chars of [A-Za-z0-9_-])
  // matched real show slugs and silently dropped every content_id that
  // Rising Shows reporting is built on. "rick-and-morty-tt2861424" is
  // exactly 24 characters.
  const { api, calls } = load({ pathname: '/apps/rising-shows/' });
  const slugs = ['rick-and-morty-tt2861424', '24-tt0285331', 'the-lord-of-the-rings-the-rings-of-power-tt7631058'];
  for (const slug of slugs) {
    api.trackContentView({ contentType: 'show', contentId: slug });
    assert.equal(events(calls).pop()[2].content_id, slug, `slug dropped: ${slug}`);
  }
});

test('long strings are truncated to GA4s 100-char limit', () => {
  const { api, calls } = load({ pathname: '/apps/arena/' });
  api.track('probe', { blurb: 'x'.repeat(250) });
  assert.equal(events(calls).pop()[2].blurb.length, 100);
});

test('trackOutbound reports the domain only, and ignores same-origin links', () => {
  const { api, calls } = load({ pathname: '/home' });
  api.trackOutbound('https://www.imdb.com/title/tt1/?ref=abc');
  const p = events(calls).pop()[2];
  assert.equal(p.link_domain, 'www.imdb.com');
  assert.equal(JSON.stringify(p).includes('tt1'), false);

  const before = events(calls).length;
  api.trackOutbound('https://shevato.com/apps');
  assert.equal(events(calls).length, before, 'same-origin link must not be outbound');
});

test('trackError reports a stable code and caps volume per page', () => {
  const { api, calls } = load({ pathname: '/apps/trip-planner/' });
  for (let i = 0; i < 20; i++) api.trackError('sync', 'quota_exceeded');
  const errs = events(calls).filter((c) => c[1] === 'app_error');
  assert.equal(errs.length, 5, 'error events must be capped');
  assert.equal(errs[0][2].error_scope, 'sync');
  assert.equal(errs[0][2].error_code, 'quota_exceeded');
});

test('trackError refuses free text: an exception message never reaches GA', () => {
  // An exception message is where user content ends up - a failed parse
  // quotes the document, a storage error names the key. Anything that is not
  // already a short enumerable identifier is reported as `unclassified`.
  const { api, calls } = load({ pathname: '/apps/trip-planner/' });
  api.trackError('trip', 'Unexpected token < in JSON at position 4 while saving "Paris with Dana"');
  const p = events(calls).pop()[2];
  assert.equal(p.error_code, 'unclassified');
  assert.equal(JSON.stringify(p).includes('Paris'), false);
  assert.equal('error_message' in p, false, 'the free-text field is gone entirely');
});

test('trackError normalises casing and rejects a URL as a code', () => {
  const { api, calls } = load({ pathname: '/home' });
  api.trackError('SYNC', 'Quota_Exceeded');
  assert.equal(events(calls).pop()[2].error_code, 'quota_exceeded');
  api.trackError('sync', 'https://shevato.com/apps/trip-planner/?trip=honeymoon');
  const p = events(calls).pop()[2];
  assert.equal(p.error_code, 'unclassified');
  assert.equal(JSON.stringify(p).includes('honeymoon'), false);
});

test('page_location is sanitised: the query string never leaves the browser', () => {
  // The bug this pins: page_path cleaned the reported `dp` dimension while
  // gtag kept sending the raw href as `dl`, so a private query parameter went
  // out on the page_view and on every event after it.
  const { calls } = load({
    pathname: '/apps/trip-planner/',
    href: 'https://shevato.com/apps/trip-planner/?audit_private=synthetic-confirmation#trip=secret',
  });
  const cfg = configs(calls)[0][2];
  assert.equal(cfg.page_location, 'https://shevato.com/apps/trip-planner/');
  assert.equal(JSON.stringify(cfg).includes('synthetic-confirmation'), false);
  assert.equal(JSON.stringify(cfg).includes('secret'), false);
});

test('campaign parameters survive so attribution still works', () => {
  const { calls } = load({
    pathname: '/home',
    href: 'https://shevato.com/home?utm_source=news&utm_medium=email&gclid=abc123&private=zzz',
  });
  const loc = configs(calls)[0][2].page_location;
  assert.ok(loc.includes('utm_source=news'), loc);
  assert.ok(loc.includes('utm_medium=email'), loc);
  assert.ok(loc.includes('gclid=abc123'), loc);
  assert.equal(loc.includes('private'), false, 'non-campaign params are dropped');
  assert.equal(loc.includes('zzz'), false);
});

test('page_location drops .html the same way page_path does', () => {
  const { calls } = load({ pathname: '/apps.html', href: 'https://shevato.com/apps.html' });
  assert.equal(configs(calls)[0][2].page_location, 'https://shevato.com/apps');
});

test('page_referrer keeps origin and path but never the query or hash', () => {
  const { calls } = load({
    pathname: '/apps/gym-tracker/',
    referrer: 'https://shevato.com/apps/trip-planner/?trip=honeymoon#day-3',
  });
  const cfg = configs(calls)[0][2];
  assert.equal(cfg.page_referrer, 'https://shevato.com/apps/trip-planner/');
  assert.equal(JSON.stringify(cfg).includes('honeymoon'), false);
  assert.equal(JSON.stringify(cfg).includes('day-3'), false);
});

test('a missing or non-http referrer reports empty rather than guessing', () => {
  assert.equal(configs(load({ pathname: '/home' }).calls)[0][2].page_referrer, '');
  assert.equal(
    configs(load({ pathname: '/home', referrer: 'android-app://com.example' }).calls)[0][2].page_referrer,
    ''
  );
});

test('every event carries a release id so errors attribute to a build', () => {
  const { api, calls } = load({ pathname: '/apps/gym-tracker/' });
  api.trackAction('workout_completed');
  const p = events(calls).pop()[2];
  assert.equal(typeof p.release_id, 'string');
  assert.ok(p.release_id.length > 0);
  // An unstamped checkout says so rather than shipping the raw token.
  assert.equal(p.release_id.startsWith('__'), false);
});

test('a throwing gtag never propagates to the caller', () => {
  const { api } = load({ pathname: '/apps/gym-tracker/', breakGtag: true });
  // Each of these would break an app if analytics could throw.
  assert.doesNotThrow(() => api.trackView('workout'));
  assert.doesNotThrow(() => api.trackAction('workout_completed', { set_count: 3 }));
  assert.doesNotThrow(() => api.trackSearch({ scope: 'x', resultsCount: 0 }));
  assert.doesNotThrow(() => api.trackError('scope', 'msg'));
  assert.doesNotThrow(() => api.track('anything', { a: 1 }));
});

test('malformed input is ignored rather than sent', () => {
  const { api, calls } = load({ pathname: '/apps/gym-tracker/' });
  const before = events(calls).length;
  api.trackView('');
  api.trackView(null);
  api.trackFilter('', 'x');
  api.track('');
  api.trackOutbound('not a url');
  assert.equal(events(calls).length, before);
});
