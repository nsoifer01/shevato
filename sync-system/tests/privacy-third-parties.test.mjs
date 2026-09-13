// privacy.html is binding: it lists exactly the outside services first-party
// code contacts. Both directions drift silently, so both are pinned here:
//
//   1. NAMED -> CONTACTED. Every service named under "Other services that
//      receive data" must map to a host that actually appears as a URL literal
//      in first-party code (client JS/HTML/CSS under apps/, assets/,
//      sync-system/, plus the Netlify functions, which contact upstreams on the
//      browser's behalf). An unmapped name fails loudly so a new paragraph
//      cannot describe a flow that does not exist.
//   2. CONTACTED -> NAMED. Every host the site actually contacts must be
//      covered by a service named on the page (or, for Google Analytics, by the
//      page's own analytics section). This is the direction that let the
//      Trip Planner's bring-your-own-key path post trips to api.openai.com for
//      months while the services list never named OpenAI (2026-09-12 audit
//      T-5): direction 1 cannot see a service the page forgot.
//
//      "Contacted" is NOT every https literal in the tree - that set is full of
//      plain links (IMDb, TVDB, Google Maps URLs handed to the page). It is the
//      union of three sources that each describe a real connection:
//        a. every host the Report-Only Content-Security-Policy in netlify.toml
//           lets the browser connect to, load a script, style or font from, or
//           frame. tests/static/csp-connect-src.test.mjs pins connect-src
//           against the fetch call sites in both directions, so this is a
//           derived inventory, not a hand list;
//        b. the upstream hosts the Netlify functions reference in code (not
//           comments), minus the literals that are provably not requests;
//        c. the two image hosts pages load directly (img-src is a blanket
//           `https:` in the policy, so the header cannot name them), each
//           asserted to still exist in code so the list cannot go stale.
//
//   3. PurgoMalum must never reappear: privacy.html described sending Arena
//      chat text to it for months while apps/arena/js/chat.js was a local
//      word list making zero external requests (found 2026-08-22).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PRIVACY = readFileSync(join(REPO_ROOT, 'privacy.html'), 'utf8');

const SCAN_ROOTS = ['apps', 'assets', 'sync-system', 'netlify', 'partials'];
const SKIP_DIR = /(^|\/)(node_modules|dist|vendor|tests|tests-rules|e2e|scripts|coverage|\.screenshots|data|generated)(\/|$)/;

function sourceFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (SKIP_DIR.test('/' + relative(REPO_ROOT, full))) continue;
    const st = statSync(full);
    if (st.isDirectory()) sourceFiles(full, out);
    else if (/\.(m?js|html|css)$/.test(name) && st.size < 2_000_000) out.push(full);
  }
  return out;
}

const HOSTS = new Set();
for (const root of SCAN_ROOTS) {
  for (const file of sourceFiles(join(REPO_ROOT, root))) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/https:\/\/([a-zA-Z0-9.-]+)/g)) HOSTS.add(m[1].toLowerCase());
  }
}
// Root pages are first-party too (Google Fonts, the GTM loader, Firebase SDK).
for (const f of readdirSync(REPO_ROOT).filter((n) => n.endsWith('.html'))) {
  for (const m of readFileSync(join(REPO_ROOT, f), 'utf8').matchAll(/https:\/\/([a-zA-Z0-9.-]+)/g)) HOSTS.add(m[1].toLowerCase());
}

// Service heading in privacy.html -> host pattern(s) the code must contain.
// Keep this in step with the "Other services that receive data" section.
// Checked in BOTH directions: each pattern must match a code host (1), and
// each contacted host must match some pattern here or in RELATED_HOSTS (2).
const SERVICE_HOSTS = {
  'Google Firebase': [/firebase|googleapis\.com$/],
  'Google Gemini': [/^generativelanguage\.googleapis\.com$/],
  'OpenAI': [/^api\.openai\.com$/],
  'Google Places': [/^(maps|places)\.googleapis\.com$/],
  'Nominatim (OpenStreetMap)': [/^nominatim\.openstreetmap\.org$/],
  'OpenStreetMap tiles': [/tile\.openstreetmap\.org$/],
  'Open-Meteo': [/open-meteo\.com$/],
  'Photon (OpenStreetMap)': [/^photon\.komoot\.io$/],
  'Frankfurter': [/frankfurter/],
  'GitHub': [/^raw\.githubusercontent\.com$/],
  'The Trivia API, Wikidata and Wikipedia': [/the-trivia-api\.com$/, /wikidata\.org$/, /wikipedia\.org$/],
  'Fantasy Premier League': [/premierleague\.com$/],
  'MapTap.gg': [/maptap\.gg$/],
  'TMDB': [/tmdb\.org$/],
  'cdnjs and Google Fonts': [/^cdnjs\.cloudflare\.com$/, /^fonts\.googleapis\.com$/],
};

// Hosts that belong to a named service without being the host its heading is
// matched on. Direction 2 only: each still requires its service heading to be
// present on the page, and says why the host is that service.
const RELATED_HOSTS = [
  { service: 'Google Firebase', re: /^www\.gstatic\.com$/, why: 'the Firebase SDK modules are served from gstatic' },
  { service: 'Google Firebase', re: /^apis\.google\.com$/, why: 'Firebase Authentication loads its iframe helper from here' },
  { service: 'Google Firebase', re: /firebaseio\.com$|firebasedatabase\.app$|firebaseapp\.com$/, why: 'Firebase project and auth domains' },
  { service: 'MapTap.gg', re: /^us-central1-jjexperiment-12af6\.cloudfunctions\.net$/, why: "MapTap's own public-profile endpoint, which the page calls a MapTap endpoint" },
  { service: 'cdnjs and Google Fonts', re: /^fonts\.gstatic\.com$/, why: 'Google Fonts serves the font files from gstatic' },
];

// Contacted hosts disclosed OUTSIDE the services list, each with the phrase
// the page must still contain for the disclosure to count.
const DISCLOSED_ELSEWHERE = [
  { re: /googletagmanager\.com$|google-analytics\.com$|analytics\.google\.com$/, phrase: 'loads Google Analytics 4', why: 'GA4 is covered by "Analytics and cookies"' },
];

// Literal hosts in Netlify function code that are not requests at all.
const FUNCTION_LITERALS_NOT_CONTACTED = {
  'shevato.com': 'our own origin, used for the Origin/Referer allow-list',
  'www.google.com': 'the Google Maps attribution link returned to the page (tp-places ATTRIBUTION)',
};

// Pages load these as images; img-src is a blanket https: so the CSP cannot
// name them. Each must still appear in first-party code (checked below).
const IMAGE_HOSTS = ['image.tmdb.org', 'tile.openstreetmap.org'];

function namedServices() {
  const start = PRIVACY.indexOf('<h2>Other services that receive data</h2>');
  const end = PRIVACY.indexOf('<h2>', start + 1);
  assert.ok(start > 0 && end > start, 'privacy.html must keep the "Other services that receive data" section');
  return [...PRIVACY.slice(start, end).matchAll(/<h3>([^<]+)<\/h3>/g)].map((m) => m[1].trim());
}

/** Hosts the Report-Only CSP lets the browser contact, wildcards kept as "*.x". */
function cspContactedHosts() {
  const toml = readFileSync(join(REPO_ROOT, 'netlify.toml'), 'utf8');
  const line = toml.split('\n').find((l) => /^\s*Content-Security-Policy-Report-Only\s*=/.test(l));
  assert.ok(line, 'netlify.toml has no Content-Security-Policy-Report-Only header to derive hosts from');
  const hosts = new Set();
  for (const part of line.replace(/^[^"]*"/, '').replace(/"\s*$/, '').split(';')) {
    const [name, ...tokens] = part.trim().split(/\s+/);
    if (!['connect-src', 'script-src', 'style-src', 'font-src', 'frame-src'].includes(name)) continue;
    for (const t of tokens) {
      const m = /^(?:https|wss):\/\/([^/\s]+)$/.exec(t);
      if (m) hosts.add(m[1].toLowerCase());
    }
  }
  return hosts;
}

/** Upstream hosts the functions reference in code lines (tests and comments excluded). */
function functionUpstreamHosts() {
  const hosts = new Set();
  const dir = join(REPO_ROOT, 'netlify', 'functions');
  const files = [
    ...readdirSync(dir).filter((n) => n.endsWith('.mjs')).map((n) => join(dir, n)),
    ...readdirSync(join(dir, 'lib')).filter((n) => n.endsWith('.mjs')).map((n) => join(dir, 'lib', n)),
  ];
  for (const file of files) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
      for (const m of line.matchAll(/https:\/\/([a-zA-Z0-9.-]+)/g)) {
        const host = m[1].toLowerCase();
        if (!FUNCTION_LITERALS_NOT_CONTACTED[host]) hosts.add(host);
      }
    }
  }
  return hosts;
}

function contactedHosts() {
  const all = new Map();
  for (const h of cspContactedHosts()) all.set(h, 'netlify.toml Content-Security-Policy-Report-Only');
  for (const h of functionUpstreamHosts()) all.set(h, 'a Netlify function upstream');
  for (const h of IMAGE_HOSTS) all.set(h, 'an image host pages load directly');
  return all;
}

/** "*.googleapis.com" is tested as a representative subdomain of itself. */
const probeName = (host) => host.replace(/^\*\./, 'wildcard.');

test('the code inventory found the expected host literals', () => {
  assert.ok(HOSTS.size >= 15, `only ${HOSTS.size} https hosts discovered; the scan is broken`);
});

test('the contacted-host inventory is derived from real sources, not empty', () => {
  const csp = cspContactedHosts();
  assert.ok(csp.size >= 15, `only ${csp.size} hosts parsed out of the CSP; the header parse is broken`);
  const fn = functionUpstreamHosts();
  for (const expected of ['generativelanguage.googleapis.com', 'places.googleapis.com', 'fantasy.premierleague.com']) {
    assert.ok(fn.has(expected), `function upstream scan no longer finds ${expected}; the scan is broken or the upstream moved`);
  }
  for (const h of IMAGE_HOSTS) {
    assert.ok([...HOSTS].some((c) => c === h || c.endsWith('.' + h)), `${h} is listed as an image host but no first-party code references it any more`);
  }
});

test('every third party named in privacy.html is contacted by first-party code', () => {
  const problems = [];
  for (const name of namedServices()) {
    const patterns = SERVICE_HOSTS[name];
    if (!patterns) { problems.push(`"${name}": no host mapping in this test (a service nothing contacts, or a renamed heading)`); continue; }
    for (const re of patterns) {
      if (![...HOSTS].some((h) => re.test(h))) problems.push(`"${name}": no first-party URL literal matches ${re}`);
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('every mapped service is still named in privacy.html', () => {
  const named = new Set(namedServices());
  const missing = Object.keys(SERVICE_HOSTS).filter((n) => !named.has(n));
  assert.deepEqual(missing, [], 'a service the code contacts dropped out of privacy.html (or its heading was renamed)');
});

test('every host the site contacts is disclosed in privacy.html', () => {
  const named = new Set(namedServices());
  const problems = [];
  for (const [host, source] of contactedHosts()) {
    const probe = probeName(host);
    const service = Object.entries(SERVICE_HOSTS).find(([, res]) => res.some((re) => re.test(probe)));
    if (service) {
      if (!named.has(service[0])) problems.push(`${host} (from ${source}) maps to "${service[0]}", which privacy.html no longer names`);
      continue;
    }
    const related = RELATED_HOSTS.find((r) => r.re.test(probe));
    if (related) {
      if (!named.has(related.service)) problems.push(`${host} (from ${source}) belongs to "${related.service}" (${related.why}), which privacy.html no longer names`);
      continue;
    }
    const elsewhere = DISCLOSED_ELSEWHERE.find((d) => d.re.test(probe));
    if (elsewhere) {
      if (!PRIVACY.includes(elsewhere.phrase)) problems.push(`${host} (from ${source}): ${elsewhere.why}, but privacy.html no longer says "${elsewhere.phrase}"`);
      continue;
    }
    problems.push(`${host} (from ${source}) is contacted but privacy.html names no service for it. Add a heading under "Other services that receive data" and map it in SERVICE_HOSTS.`);
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('privacy.html does not mention PurgoMalum (Arena moderation is a local word list)', () => {
  assert.ok(!/purgomalum/i.test(PRIVACY), 'privacy.html names PurgoMalum');
  assert.ok(!/purgomalum/i.test([...HOSTS].join(' ')), 'code contacts purgomalum again; if real, re-disclose it');
});
