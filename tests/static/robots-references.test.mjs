// No path the site's own pages load may be blocked by robots.txt.
//
// Why this exists. Google's rendering service (WRS) obeys robots.txt for
// SUBRESOURCE fetches, not just for pages: a `Disallow` on something a page
// fetches does not merely hide a file from the index, it deletes whatever
// that file contributes from the DOM Google renders.
//
// The site shipped exactly that bug from the day the partials system was
// written until 2026-09-04. `assets/js/main.js` fetches
// `/partials/header.html` and `/partials/footer.html` on every one of the 17
// pages, and robots.txt carried `Disallow: /partials/`. Measured on
// production with those paths blocked at the network layer, every page
// rendered with `document.getElementById('header') === null`: no header nav
// (15 links), no footer nav (6 links), six of the eight app pages left with
// ZERO internal outbound links, and /privacy with zero inbound ones. The
// same rule blocked `/sync-system/` (the first <script> in the head of all
// nine app pages) and `/firebase-config.js` (a module on every page).
//
// Nothing caught it: internal-links.test.mjs asserts the targets EXIST,
// canonical-urls.test.mjs asserts they are the right FORM, and neither asks
// whether a crawler is allowed to fetch them.
//
// What is checked. Three reference sets, all resolved to absolute site
// paths and matched against the robots.txt group Googlebot actually uses
// (`User-agent: *` - there is no Googlebot-specific group):
//
//   1. href/src in every page and partial.
//   2. Relative ES-module import specifiers inside shipped first-party JS
//      (this is how apps/fpl-planner/js/ui/settings.js reaches
//      ../../../../sync-system/storage-sync-robust.js).
//   3. Absolute site-path string literals inside shipped first-party JS,
//      which is how main.js names '/partials/'. Only literals that resolve
//      to a real file or directory on disk are asserted on, so an arbitrary
//      string that happens to start with a slash cannot fail the suite.
//
// Deliberately NOT a failure: a disallowed path that nothing loads. Blocking
// /tests/, /scripts/, /assets/seo/ and the rest is intentional crawl hygiene
// and this file has no opinion on it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => readFileSync(join(REPO_ROOT, rel), 'utf8');

// -- robots.txt parsing -------------------------------------------------------

/**
 * The Allow/Disallow rules of one user-agent group.
 *
 * Grouping follows the spec: consecutive `User-agent` lines share the rules
 * that follow them, and a group ends at the next User-agent line after at
 * least one rule. Blank lines and `#` comments are ignored. Only the agents
 * asked for are returned, so a `Sitemap:` line outside any group is skipped.
 */
export function parseRobots(text, agent = '*') {
  const rules = [];
  let agents = [];
  let collecting = false;
  let seenRule = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === 'user-agent') {
      if (seenRule) { agents = []; seenRule = false; }
      agents.push(value.toLowerCase());
      collecting = agents.includes(agent.toLowerCase());
      continue;
    }
    if (field !== 'allow' && field !== 'disallow') continue;
    seenRule = true;
    if (collecting && value) rules.push({ type: field, pattern: value });
  }
  return rules;
}

/**
 * True when `path` is blocked for a group, by Google's documented matching:
 * `*` matches any run of characters, a trailing `$` anchors the end, the
 * LONGEST matching pattern wins, and Allow beats Disallow on an exact tie.
 * An empty Disallow value means "nothing is disallowed" and never matches.
 */
export function isDisallowed(path, rules) {
  let best = null;
  for (const rule of rules) {
    if (!patternMatches(rule.pattern, path)) continue;
    const weight = rule.pattern.replace(/\*/g, '').length;
    if (best === null || weight > best.weight ||
        (weight === best.weight && rule.type === 'allow')) {
      best = { weight, type: rule.type };
    }
  }
  return best !== null && best.type === 'disallow';
}

function patternMatches(pattern, path) {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const source = body.split('*').map(escapeRegExp).join('[\\s\\S]*');
  return new RegExp('^' + source + (anchored ? '$' : '')).test(path);
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// -- Files under test ---------------------------------------------------------

const manifest = JSON.parse(read('assets/apps-manifest.json'));

const PAGES = [
  'index.html', 'home.html', 'work.html', 'apps.html', 'about.html',
  'contact.html', 'privacy.html', 'moadon-alef.html', '404.html',
  'partials/header.html', 'partials/footer.html', 'partials/footer-moadon-alef.html',
  ...manifest.apps.map((a) => `apps/${a.slug}/index.html`),
  'apps/rising-shows/kometa/index.html'
].filter((p) => existsSync(join(REPO_ROOT, p)));

// Shipped browser JS: the site-level bundle plus each app's js/ tree. Test,
// e2e, script and vendor directories are excluded - none of it reaches a
// browser, and vendor bundles are full of unrelated string literals.
function shippedScripts() {
  const out = [];
  const walk = (relDir) => {
    const abs = join(REPO_ROOT, relDir);
    if (!existsSync(abs)) return;
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const rel = `${relDir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (['tests', 'e2e', 'scripts', 'vendor', 'node_modules', 'experiments'].includes(entry.name)) continue;
        walk(rel);
      } else if (entry.name.endsWith('.js') && !entry.name.endsWith('.min.js')) {
        out.push(rel);
      }
    }
  };
  walk('assets/js');
  walk('sync-system');
  for (const app of manifest.apps) walk(`apps/${app.slug}/js`);
  return out.filter((p) => !p.includes('/tests/'));
}

// -- Reference extraction -----------------------------------------------------

const isExternal = (ref) => /^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith('//');

/** Absolute site path for a ref written inside `pageRel`, or null to skip. */
function toSitePath(pageRel, ref) {
  const bare = ref.split('#')[0].split('?')[0];
  if (!bare || isExternal(ref)) return null;
  const abs = bare.startsWith('/')
    ? resolve(REPO_ROOT, '.' + bare)
    : resolve(REPO_ROOT, dirname(pageRel), bare);
  const rel = relative(REPO_ROOT, abs);
  if (rel.startsWith('..')) return null; // escapes the repo; not ours to police
  return '/' + rel.split(sep).join('/') + (bare.endsWith('/') ? '/' : '');
}

function htmlRefs(html) {
  const refs = [];
  for (const m of html.matchAll(/<script\b[^>]*\ssrc\s*=\s*["']([^"']+)["']/gi)) refs.push(m[1]);
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
  for (const m of stripped.matchAll(/\s(?:href|src)\s*=\s*["']([^"']+)["']/gi)) refs.push(m[1]);
  return refs;
}

/** Relative ES-module specifiers: static `import ... from`, and `import(...)`. */
function moduleSpecifiers(js) {
  const out = [];
  for (const m of js.matchAll(/\bfrom\s+["'](\.[^"']+)["']/g)) out.push(m[1]);
  for (const m of js.matchAll(/\bimport\s*\(\s*["'](\.[^"']+)["']\s*\)/g)) out.push(m[1]);
  return out;
}

/** Absolute site-path string literals, e.g. main.js's '/partials/'. */
function absolutePathLiterals(js) {
  const out = [];
  for (const m of js.matchAll(/["'](\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]*)["']/g)) {
    if (m[1] !== '/' && m[1].includes('/', 1)) out.push(m[1]);
  }
  return out;
}

const existsHere = (sitePath) => {
  const abs = join(REPO_ROOT, sitePath.replace(/^\//, ''));
  try { statSync(abs); return true; } catch { return false; }
};

// -- Tests --------------------------------------------------------------------

const RULES = parseRobots(read('robots.txt'), '*');

test('robots.txt: the User-agent: * group parses and still blocks repo internals', () => {
  assert.ok(RULES.length > 5, 'expected the wildcard group to carry rules');
  assert.equal(isDisallowed('/tests/static/robots-references.test.mjs', RULES), true);
  assert.equal(isDisallowed('/scripts/stamp-sitemap-index.mjs', RULES), true);
  assert.equal(isDisallowed('/README.md', RULES), true);
  assert.equal(isDisallowed('/home', RULES), false);
  assert.equal(isDisallowed('/apps/gym-tracker/', RULES), false);
});

test('robots.txt: matching follows longest-wins with Allow breaking ties', () => {
  const rules = parseRobots(
    'User-agent: *\nAllow: /\nDisallow: /a/\nAllow: /a/b/\nDisallow: /*.log$\n', '*');
  assert.equal(isDisallowed('/a/x', rules), true, 'longer Disallow beats Allow: /');
  assert.equal(isDisallowed('/a/b/x', rules), false, 'longer Allow wins');
  assert.equal(isDisallowed('/deploy.log', rules), true, '$-anchored suffix rule');
  assert.equal(isDisallowed('/deploy.log.txt', rules), false, '$ anchors the end');
  assert.equal(isDisallowed('/other', rules), false);
});

test('no href/src on any page or partial is blocked by robots.txt', () => {
  const blocked = [];
  for (const page of PAGES) {
    for (const ref of htmlRefs(read(page))) {
      const sitePath = toSitePath(page, ref);
      if (sitePath && isDisallowed(sitePath, RULES)) blocked.push(`${page} -> ${ref} (${sitePath})`);
    }
  }
  assert.deepEqual(blocked, [],
    'Google does not fetch robots-blocked subresources; these would be missing from the rendered DOM');
});

test('no ES-module import inside shipped JS resolves to a blocked path', () => {
  const blocked = [];
  for (const file of shippedScripts()) {
    for (const spec of moduleSpecifiers(read(file))) {
      const sitePath = toSitePath(file, spec);
      if (sitePath && isDisallowed(sitePath, RULES)) blocked.push(`${file} -> ${spec} (${sitePath})`);
    }
  }
  assert.deepEqual(blocked, []);
});

test('no absolute site path named in shipped JS is blocked by robots.txt', () => {
  const blocked = [];
  for (const file of shippedScripts()) {
    for (const literal of absolutePathLiterals(read(file))) {
      // Only real files and directories: an arbitrary slash-prefixed string
      // that names nothing on disk is not a fetch target.
      if (!existsHere(literal)) continue;
      if (isDisallowed(literal, RULES)) blocked.push(`${file} -> '${literal}'`);
    }
  }
  assert.deepEqual(blocked, [],
    "a runtime fetch target must be crawlable; this is how '/partials/' was lost");
});

test('the three paths that broke rendering are crawlable', () => {
  // Named explicitly so a future tidy-up of robots.txt cannot quietly
  // reintroduce the 2026-09-04 outage under a different pattern.
  for (const path of ['/partials/header.html', '/partials/footer.html',
    '/sync-system/sync-immediate.js', '/sync-system/storage-sync-robust.js',
    '/firebase-config.js']) {
    assert.equal(isDisallowed(path, RULES), false, `${path} must stay crawlable`);
  }
});
