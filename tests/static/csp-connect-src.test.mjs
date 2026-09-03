// Every origin the browser actually connects to is allowed by connect-src.
//
// netlify.toml is the ONE source of truth for the site's CSP: there is no
// _headers file, no <meta http-equiv>, no per-app override and no generated
// copy. The policy ships as Content-Security-Policy-Report-Only, which means
// a missing origin never breaks anything - it just logs a violation nobody
// reads. That is how photon.komoot.io, api.open-meteo.com and
// geocoding-api.open-meteo.com sat missing from connect-src while the Trip
// Planner used all three (found 2026-08-18, second occurrence of the same
// drift after the 2026-07-20 audit).
//
// So this file closes the loop in both directions:
//
//   1. BROWSER_FETCH_ORIGINS is the declared inventory of cross-origin hosts
//      first-party client JS connects to in production. Every entry must be
//      covered by the connect-src in netlify.toml. This is what breaks if
//      somebody trims the header.
//   2. The repo is then scanned for endpoint literals in client JS, and any
//      origin found that is neither in the inventory nor in
//      NOT_BROWSER_FETCHED fails. This is what breaks when somebody adds a
//      fetch to a new origin without touching the CSP.
//
// It parses the real header rather than string-matching a copy of it, so
// reordering entries, adding unrelated ones or rewording the comment above
// it are all free.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// ---------------------------------------------------------------------------
// The declared inventory: host -> why the browser talks to it.
// ---------------------------------------------------------------------------
const BROWSER_FETCH_ORIGINS = {
  'https://nominatim.openstreetmap.org': 'Trip Planner one-shot place geocoding',
  'https://photon.komoot.io': 'Trip Planner hotel + venue typeahead, venue coordinates',
  'https://archive-api.open-meteo.com': 'Trip Planner typical-weather (historical) chips',
  'https://api.open-meteo.com': 'Trip Planner near-term forecast chips',
  'https://geocoding-api.open-meteo.com': 'Trip Planner city typeahead in the place fields',
  'https://api.frankfurter.dev': 'Trip Planner exchange rates',
  'https://api.openai.com': 'Trip Planner assistant, owner-supplied OpenAI key',
  'https://generativelanguage.googleapis.com': 'Trip Planner assistant, Gemini',
  'https://raw.githubusercontent.com': 'Trip Planner visa matrix dataset',
  'https://maptap.gg': 'MapTap Rivals daily puzzle data files',
  'https://the-trivia-api.com': 'Arena live trivia questions',
  'https://query.wikidata.org': 'Arena Globe Drop city lists (SPARQL)',
  'https://en.wikipedia.org': 'Arena Globe Drop location summaries',
  'https://us-central1-jjexperiment-12af6.cloudfunctions.net': 'MapTap Rivals score lookup function',
};

// Origins that appear as endpoint literals in client JS but are NOT connected
// to from a production page, with the reason. Anything listed here is exempt
// from needing a connect-src entry; adding to this list should be rare and
// always argued.
const NOT_BROWSER_FETCHED = {
  // FPL sends no CORS headers, so the browser can only read it through
  // /.netlify/functions/fpl. requestDirect() exists for environments where a
  // browser allows it (never shevato.com) and is only reached once the proxy
  // has answered 404/405, which on production it never does.
  'https://fantasy.premierleague.com': 'FPL Planner reads it via the Netlify proxy only; direct fallback is dev-only',
};

// ---------------------------------------------------------------------------
// Parse the real header out of netlify.toml.
// ---------------------------------------------------------------------------
const NETLIFY_TOML = readFileSync(join(REPO_ROOT, 'netlify.toml'), 'utf8');

function cspHeaderLines() {
  // Both spellings, so graduating Report-Only to an enforcing policy does not
  // silently drop this test's subject.
  return NETLIFY_TOML.split('\n').filter(
    (line) => /^\s*Content-Security-Policy(-Report-Only)?\s*=/.test(line)
  );
}

function directive(policy, name) {
  const found = policy
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .find((part) => part.split(/\s+/)[0] === name);
  return found ? found.split(/\s+/).slice(1) : null;
}

const CSP_LINES = cspHeaderLines();

test('netlify.toml is the only place a CSP is defined', () => {
  assert.equal(
    CSP_LINES.length, 1,
    `expected exactly one CSP header in netlify.toml, found ${CSP_LINES.length}`
  );

  // A second definition elsewhere would make this whole test lie about what
  // production sends, and a Netlify _headers file WINS over netlify.toml. The
  // publish root is the repo root ([dev] publish = "."), so scan the tree the
  // deploy actually uploads: everything but node_modules and the dot-dirs
  // (.git, .netlify build cache, .screenshots), none of which deploy.
  const strays = [];
  const walkAll = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walkAll(full);
      else if (name === '_headers') strays.push(relative(REPO_ROOT, full));
    }
  };
  walkAll(REPO_ROOT);
  assert.deepEqual(strays, [], `Netlify _headers files override netlify.toml: ${strays.join(', ')}`);
});

const POLICY = CSP_LINES[0].slice(CSP_LINES[0].indexOf('=') + 1).trim().replace(/^"|"$/g, '');
const CONNECT_SRC = directive(POLICY, 'connect-src');

test('connect-src exists and is not a blanket allow', () => {
  assert.ok(CONNECT_SRC, 'connect-src missing from the CSP');
  assert.ok(CONNECT_SRC.includes("'self'"), "connect-src must keep 'self'");
  for (const banned of ['*', 'https:', 'http:', "'unsafe-eval'"]) {
    assert.ok(
      !CONNECT_SRC.includes(banned),
      `connect-src must not contain the blanket source ${banned}: ${CONNECT_SRC.join(' ')}`
    );
  }
  // default-src stays a real fallback, so an origin missing from connect-src
  // is genuinely a violation rather than quietly inherited.
  assert.deepEqual(directive(POLICY, 'default-src'), ["'self'"], "default-src must stay 'self'");
});

// A source matches an origin the way a browser matches it: exact host, or a
// leading-*. wildcard covering one or more leading labels.
function allows(sources, origin) {
  const host = new URL(origin).host;
  return sources.some((source) => {
    if (!source.startsWith('https://')) return false;
    const pattern = source.slice('https://'.length).replace(/\/.*$/, '');
    if (pattern === host) return true;
    if (!pattern.startsWith('*.')) return false;
    const suffix = pattern.slice(1); // ".googleapis.com"
    return host.endsWith(suffix) && host.length > suffix.length;
  });
}

test('every declared browser fetch origin is allowed by connect-src', () => {
  const missing = Object.entries(BROWSER_FETCH_ORIGINS)
    .filter(([origin]) => !allows(CONNECT_SRC, origin))
    .map(([origin, why]) => `${origin} (${why})`);
  assert.deepEqual(
    missing, [],
    `connect-src does not allow origins the browser connects to:\n  ${missing.join('\n  ')}`
  );
});

test('both Open-Meteo endpoints the Trip Planner uses are allowed', () => {
  // Named explicitly because they are three separate hosts behind one brand
  // and the geocoding one was the origin that went missing. A wildcard is
  // deliberately not accepted here: each host is listed on its own.
  for (const origin of [
    'https://archive-api.open-meteo.com',
    'https://api.open-meteo.com',
    'https://geocoding-api.open-meteo.com',
  ]) {
    assert.ok(CONNECT_SRC.includes(origin), `${origin} must be listed verbatim in connect-src`);
  }
  assert.ok(
    !CONNECT_SRC.some((s) => s.includes('*.open-meteo.com')),
    'do not widen to *.open-meteo.com; list the hosts actually used'
  );
});

// ---------------------------------------------------------------------------
// Drift guard: discover endpoint origins in first-party client JS.
// ---------------------------------------------------------------------------
// netlify/ is deliberately absent: functions run on the server, where a page
// CSP does not apply, and a browser reaching one of them is a same-origin
// /.netlify/functions/ request already covered by 'self'.
const SCAN_ROOTS = ['apps', 'assets', 'sync-system'];
// Not shipped to a browser page, so not governed by this CSP: node tests,
// e2e/CDP harnesses, build scripts, and third-party vendored bundles.
const SKIP_DIR = /(^|\/)(node_modules|vendor|tests|tests-rules|e2e|scripts|coverage|\.screenshots)(\/|$)/;
// Identifier names that hold an endpoint: FOO_API, API_URL, HOTEL_API, url,
// SPARQL_ENDPOINT, DIRECT_BASE, MAPTAP_DAILY_URL_BASE...
const ENDPOINT_NAME = /(^|_)(api|url|uri|endpoint|base|host)(_|$)/i;
const ORIGIN_LITERAL = /https:\/\/[a-zA-Z0-9.-]+/;

function clientJsFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (SKIP_DIR.test('/' + relative(REPO_ROOT, full))) continue;
    const st = statSync(full);
    if (st.isDirectory()) clientJsFiles(full, out);
    else if (/\.(js|mjs)$/.test(name)) out.push(full);
  }
  return out;
}

function discoverOrigins() {
  const found = new Map(); // origin -> [site]
  const note = (origin, site) => {
    if (!found.has(origin)) found.set(origin, []);
    found.get(origin).push(site);
  };
  for (const root of SCAN_ROOTS) {
    for (const file of clientJsFiles(join(REPO_ROOT, root))) {
      const rel = relative(REPO_ROOT, file);
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        const site = `${rel}:${i + 1}`;
        const assigned = new RegExp(
          `(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*[\`'"](${ORIGIN_LITERAL.source})`
        ).exec(line);
        if (assigned && ENDPOINT_NAME.test(assigned[1])) note(assigned[2], site);
        const call = line.indexOf('fetch(');
        if (call >= 0) {
          const inline = line.slice(call).match(new RegExp(ORIGIN_LITERAL.source, 'g'));
          if (inline) inline.forEach((origin) => note(origin, site));
        }
      });
    }
  }
  return found;
}

const DISCOVERED = discoverOrigins();

test('origin discovery still works', () => {
  // A refactor that hides every endpoint from the scan above would turn the
  // next test into a no-op. Anchor on the origin this test exists for.
  assert.ok(
    DISCOVERED.has('https://geocoding-api.open-meteo.com'),
    'scan found no Open-Meteo geocoding endpoint in client JS - the scan is broken, not the app'
  );
  assert.ok(DISCOVERED.size >= 10, `scan found only ${DISCOVERED.size} endpoint origins`);
});

test('no client JS reaches an origin the CSP has not been told about', () => {
  const undeclared = [];
  for (const [origin, sites] of DISCOVERED) {
    if (origin in BROWSER_FETCH_ORIGINS || origin in NOT_BROWSER_FETCHED) continue;
    undeclared.push(`${origin} at ${sites.slice(0, 3).join(', ')}`);
  }
  assert.deepEqual(
    undeclared, [],
    'new cross-origin endpoints found in client JS. Add each to connect-src in '
      + 'netlify.toml and to BROWSER_FETCH_ORIGINS here (or to NOT_BROWSER_FETCHED '
      + `with a reason):\n  ${undeclared.join('\n  ')}`
  );
});

test('the inventory does not carry origins nothing uses any more', () => {
  // Keeps the inventory honest in the other direction: a host that no client
  // JS references should leave both this file and connect-src.
  const known = new Set([...DISCOVERED.keys()]);
  const stale = Object.keys(BROWSER_FETCH_ORIGINS).filter((origin) => !known.has(origin));
  // Origins reached through an SDK or a redirect rather than a literal in our
  // own JS: the Firebase/GA/Google entries in connect-src, plus the two below.
  const NOT_LITERAL = new Set([
    // Built from the app's own template strings via a helper, not a bare
    // literal on the fetch line.
    'https://us-central1-jjexperiment-12af6.cloudfunctions.net',
  ]);
  const unexplained = stale.filter((origin) => !NOT_LITERAL.has(origin));
  assert.deepEqual(
    unexplained, [],
    `inventory lists origins no client JS references: ${unexplained.join(', ')}`
  );
});
