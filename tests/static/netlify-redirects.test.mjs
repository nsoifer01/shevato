// The netlify.toml redirect inventory, pinned rule by rule.
//
// netlify.toml is the only place the site's URL canonicalisation lives:
// every `.html` page 301s onto its extensionless form, every app's
// index.html onto its directory, and the historical moves (product.html,
// tracker.html, brain-arena, rising-seasons, tools/trip-planner) keep
// forwarding. Netlify gives no feedback when a rule is dropped, mistyped or
// loses `force = true` (without force the physical .html file wins and the
// redirect silently never runs), so the 2026-08-22 audit verified the whole
// inventory by hand and this file freezes that verified state:
//
//   1. the exact from -> to pairs, all 301 and forced;
//   2. every static target resolves to a git-tracked file under the Pretty
//      URLs convention (a redirect onto a 404 is worse than none), with the
//      two deploy-generated hubs allowlisted;
//   3. google10670283c9d04acd.html is never caught (Search Console fetches
//      that exact path; redirecting it fails domain verification);
//   4. no two rules share a `from` (Netlify takes the first, the second is
//      dead config that looks alive).
//
// Adding or removing a redirect on purpose means editing EXPECTED here in
// the same change, which is the point.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const NETLIFY_TOML = readFileSync(join(REPO_ROOT, 'netlify.toml'), 'utf8');

// -- Parse ----------------------------------------------------------------------

function parseRedirects(toml) {
  // TOML tables start at a line beginning with "["; keep the redirect ones.
  return toml.split(/^(?=\[)/m)
    .filter((section) => section.startsWith('[[redirects]]'))
    .map((section) => {
      const field = (name) => {
        const m = section.match(new RegExp(`^\\s*${name}\\s*=\\s*("([^"]*)"|\\S+)`, 'm'));
        return m ? (m[2] !== undefined ? m[2] : m[1]) : undefined;
      };
      return {
        from: field('from'),
        to: field('to'),
        status: field('status') === undefined ? undefined : Number(field('status')),
        force: field('force') === 'true',
      };
    });
}

const RULES = parseRedirects(NETLIFY_TOML);

// -- The verified inventory ----------------------------------------------------

const EXPECTED = [
  ['/', '/home'],
  ['/index.html', '/home'],
  ['/home.html', '/home'],
  ['/apps.html', '/apps'],
  ['/work.html', '/work'],
  ['/about.html', '/about'],
  ['/contact.html', '/contact'],
  ['/privacy.html', '/privacy'],
  ['/moadon-alef.html', '/moadon-alef'],
  ['/apps/rising-shows/shows/:slug/index.html', '/apps/rising-shows/shows/:slug/'],
  ['/apps/gym-tracker/exercises/:slug/index.html', '/apps/gym-tracker/exercises/:slug/'],
  ['/apps/:app/index.html', '/apps/:app/'],
  ['/apps/rising-shows/shows/index.html', '/apps/rising-shows/shows/'],
  ['/apps/gym-tracker/exercises/index.html', '/apps/gym-tracker/exercises/'],
  ['/apps/rising-shows/kometa/index.html', '/apps/rising-shows/kometa/'],
  ['/product.html', '/work'],
  ['/product', '/work'],
  ['/apps/mario-kart/tracker.html', '/apps/mario-kart/'],
  ['/apps/brain-arena/*', '/apps/arena/:splat'],
  ['/apps/rising-seasons/*', '/apps/rising-shows/:splat'],
  ['/tools/trip-planner*', '/apps/trip-planner/'],
];

// Redirect targets that only exist after `npm run build:site` runs on deploy
// (same entries and reasons as tests/static/internal-links.test.mjs).
const GENERATED_TARGETS = new Map([
  ['apps/rising-shows/shows/index.html', 'generated at deploy time by npm run build:site (rising-shows static pages)'],
  ['apps/gym-tracker/exercises/index.html', 'generated at deploy time by npm run build:site (gym-tracker exercise pages)'],
]);

test('netlify.toml parses into the expected number of redirect rules', () => {
  assert.equal(RULES.length, EXPECTED.length,
    `expected ${EXPECTED.length} [[redirects]] blocks, found ${RULES.length}: ${RULES.map((r) => r.from).join(', ')}`);
  for (const r of RULES) {
    assert.ok(r.from && r.to, `redirect block missing from/to: ${JSON.stringify(r)}`);
  }
});

for (const [from, to] of EXPECTED) {
  test(`redirect ${from} -> ${to} is a forced 301`, () => {
    const rule = RULES.find((r) => r.from === from);
    assert.ok(rule, `no [[redirects]] block with from = "${from}"`);
    assert.equal(rule.to, to, `from = "${from}" must redirect to "${to}"`);
    assert.equal(rule.status, 301, `from = "${from}" must be a permanent 301`);
    assert.equal(rule.force, true, `from = "${from}" needs force = true or the physical file wins`);
  });
}

test('no redirect rule exists outside the pinned inventory', () => {
  const expectedFrom = new Set(EXPECTED.map(([from]) => from));
  const extra = RULES.filter((r) => !expectedFrom.has(r.from)).map((r) => `${r.from} -> ${r.to}`);
  assert.deepEqual(extra, [], 'new redirect rules must be added to EXPECTED in this test');
});

test('no two rules share a from path', () => {
  const seen = new Map();
  for (const r of RULES) seen.set(r.from, (seen.get(r.from) || 0) + 1);
  const dupes = [...seen].filter(([, n]) => n > 1).map(([from]) => from);
  assert.deepEqual(dupes, [], 'Netlify applies the first matching rule; a duplicate from is dead config');
});

// -- Static targets resolve -------------------------------------------------------

const tracked = new Set(
  execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 })
    .toString('utf8').split('\0').filter(Boolean)
);

// Pretty URLs: "/home" -> home.html, "/apps/x/" -> apps/x/index.html.
function fileForTarget(to) {
  const rel = to.replace(/^\//, '');
  if (rel === '' || rel.endsWith('/')) return `${rel}index.html`;
  return /\.[a-z0-9]+$/i.test(rel) ? rel : `${rel}.html`;
}

test('every static redirect target resolves to a tracked file (or an allowlisted generated hub)', () => {
  const problems = [];
  for (const r of RULES) {
    if (/[:*]/.test(r.to)) continue; // placeholder target, checked by shape only
    const file = fileForTarget(r.to);
    if (tracked.has(file) || GENERATED_TARGETS.has(file)) continue;
    problems.push(`${r.from} -> ${r.to} (no tracked file at ${file})`);
  }
  assert.deepEqual(problems, [], 'a redirect must land on a page that exists in a clean clone');
});

test('placeholder redirect targets reuse a placeholder the from declares', () => {
  for (const r of RULES) {
    const targetParams = r.to.match(/:[a-z]+/g) || [];
    for (const p of targetParams) {
      const ok = p === ':splat' ? r.from.endsWith('*') : r.from.includes(p);
      assert.ok(ok, `${r.from} -> ${r.to}: target uses ${p} which the from does not provide`);
    }
  }
});

test('the generated-target allowlist only names files that are really untracked', () => {
  const stale = [...GENERATED_TARGETS.keys()].filter((f) => tracked.has(f));
  assert.deepEqual(stale, [], 'remove tracked files from GENERATED_TARGETS');
});

// -- Search Console verification file stays reachable ----------------------------

function fromMatches(from, path) {
  const re = new RegExp('^' + from
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/:[A-Za-z_]+/g, '[^/]+')
    .replace(/\*/g, '.*') + '$');
  return re.test(path);
}

test('no rule catches google10670283c9d04acd.html', () => {
  assert.ok(tracked.has('google10670283c9d04acd.html'), 'the Search Console verification file must stay tracked');
  const hits = RULES.filter((r) => fromMatches(r.from, '/google10670283c9d04acd.html')).map((r) => r.from);
  assert.deepEqual(hits, [], 'redirecting the verification file fails Search Console domain verification');
});
