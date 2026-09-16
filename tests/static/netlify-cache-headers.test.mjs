// The Cache-Control rules in netlify.toml are a contract with two halves, and
// both halves have been wrong in production at different times.
//
// One half is the files that MUST be cacheable. The Rising Shows finder boots
// on shows-index.json (16.77 MB of JSON, 3.12 MB brotli) and opens each show
// modal from data/detail/<id>.json. Neither matched a [[headers]] rule, so both
// took Netlify's platform default of `public, max-age=0, must-revalidate`.
// That default is not merely conservative here, it is inert: measured on
// 2026-09-16, a conditional GET carrying the exact ETag the edge had just
// issued, with the same Accept-Encoding, returns 200 and the whole body
// (`cache-status: fwd=miss ... stored`), never 304, and no Last-Modified is
// offered either. "Revalidate" meant "download it all again", every load.
//
// The other half is the files that MUST NOT be cacheable. Gym Tracker is a
// service-worker PWA whose worker is the performance layer; a positive max-age
// on its own assets lets Chrome serve them from the memory cache WITHOUT
// firing the worker's fetch event, which hides the request from the worker and
// strands an installed client on old code. The long comment above those rules
// in netlify.toml explains it; this test is what stops a future pass at
// "nothing should be max-age=0" from quietly undoing it.
//
// Rules are matched the way Netlify matches them: `*` is a splat that crosses
// slashes, which is why /assets/* covers /assets/js/main.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(resolve(REPO_ROOT, p), 'utf8');

/** Every [[headers]] block in netlify.toml as { for, values: { name: value } }. */
function headerRules(toml) {
  const rules = [];
  // Split on the block marker, then read the `for` and the values that follow
  // it up to the next top-level table.
  for (const chunk of toml.split(/^\[\[headers\]\]$/m).slice(1)) {
    const body = chunk.split(/^\[(?!headers\.values)/m)[0];
    const forMatch = /^\s*for\s*=\s*"([^"]+)"/m.exec(body);
    if (!forMatch) continue;
    const values = {};
    for (const [, name, value] of body.matchAll(/^\s{4}([A-Za-z-]+)\s*=\s*"([^"]*)"/gm)) {
      values[name] = value;
    }
    rules.push({ for: forMatch[1], values });
  }
  return rules;
}

/** Netlify's `*` is a splat: it matches across path separators. */
function ruleMatches(pattern, path) {
  const rx = new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return rx.test(path);
}

/** The LAST matching rule wins, the way a later [[headers]] block overrides an earlier one. */
function cacheControlFor(rules, path) {
  const hit = rules.filter((r) => ruleMatches(r.for, path) && r.values['Cache-Control']).pop();
  return hit ? hit.values['Cache-Control'] : null;
}

const RULES = headerRules(read('netlify.toml'));

const maxAge = (cc) => {
  const m = /max-age=(\d+)/.exec(cc || '');
  return m ? Number(m[1]) : null;
};

test('the header rules parse, so the assertions below are about something', () => {
  assert.ok(RULES.length >= 8, `expected netlify.toml to carry several [[headers]] rules, parsed ${RULES.length}`);
  assert.ok(RULES.every((r) => r.for.startsWith('/')), 'every rule targets an absolute path');
  // A rule this file already relies on, as a parse canary.
  assert.equal(maxAge(cacheControlFor(RULES, '/assets/js/main.js')), 3600);
});

test('the Rising Shows boot payload is cacheable, and it is the file the app really fetches', () => {
  // Derive the path from the app rather than hardcoding it, so renaming the
  // boot payload without renaming the rule fails here instead of in production.
  const app = read('apps/rising-shows/js/app.js');
  const boot = /await fetch\('([^']+)'\)/.exec(app);
  assert.ok(boot, 'app.js must fetch its boot payload with a literal URL');
  const path = `/apps/rising-shows/${boot[1]}`;

  const cc = cacheControlFor(RULES, path);
  assert.ok(cc, `${path} matches no [[headers]] rule, so it takes Netlify's max-age=0 default`);
  assert.ok(maxAge(cc) > 0, `${path} must not be served with max-age=0: revalidation returns 200, not 304`);
  assert.match(cc, /stale-while-revalidate=\d+/, `${path} should paint from cache while it refreshes`);
  // The dataset is rebuilt daily by refresh-rising-shows.yml. Caching it for
  // longer than that only serves data the pipeline has already replaced.
  assert.ok(maxAge(cc) <= 86400, `${path} must not outlive the daily rebuild`);
});

test('the Rising Shows per-show detail files are cacheable too', () => {
  const app = read('apps/rising-shows/js/app.js');
  assert.match(app, /fetch\(`data\/detail\/\$\{[^}]+\}\.json`\)/, 'the show modal fetches data/detail/<id>.json');
  const cc = cacheControlFor(RULES, '/apps/rising-shows/data/detail/tt0903747.json');
  assert.ok(cc && maxAge(cc) > 0, 'reopening a show modal should not re-fetch bytes the browser already has');
});

test('Gym Tracker assets stay uncacheable at the HTTP layer, because its worker is the cache', () => {
  // Reversing these would let Chrome answer from its memory cache without
  // firing the service worker's fetch event, stranding installed clients on
  // old code. netlify.toml carries the full reasoning above the rules.
  for (const path of [
    '/apps/gym-tracker/js/app.js',
    '/apps/gym-tracker/css/gym-tracker.css',
    '/apps/gym-tracker/data/exercises-db.json',
  ]) {
    const cc = cacheControlFor(RULES, path);
    assert.ok(cc, `${path} must keep an explicit rule`);
    assert.equal(maxAge(cc), 0, `${path} must stay max-age=0 so the service worker sees every request`);
  }
});
