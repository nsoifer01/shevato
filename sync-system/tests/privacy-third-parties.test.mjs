// privacy.html is binding: it lists exactly the outside services first-party
// code contacts. Both directions drift silently, so both are pinned here:
//
//   1. Every service named under "Other services that receive data" must map
//      to a host that actually appears as a URL literal in first-party code
//      (client JS/HTML/CSS under apps/, assets/, sync-system/, plus the
//      Netlify functions, which contact upstreams on the browser's behalf).
//      An unmapped name fails loudly so a new paragraph cannot describe a
//      flow that does not exist.
//   2. PurgoMalum must never reappear: privacy.html described sending Arena
//      chat text to it for months while apps/arena/js/chat.js was a local
//      word list making zero external requests (found 2026-08-22).
//
// The host inventory is derived from the code the same way
// tests/static/csp-connect-src.test.mjs does it, not from a hand-kept list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PRIVACY = readFileSync(join(REPO_ROOT, 'privacy.html'), 'utf8');

const SCAN_ROOTS = ['apps', 'assets', 'sync-system', 'netlify', 'partials'];
const SKIP_DIR = /(^|\/)(node_modules|vendor|tests|tests-rules|e2e|scripts|coverage|\.screenshots|data|generated)(\/|$)/;

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
const SERVICE_HOSTS = {
  'Google Firebase': [/firebase|googleapis\.com$/],
  'Google Gemini': [/^generativelanguage\.googleapis\.com$/],
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

function namedServices() {
  const start = PRIVACY.indexOf('<h2>Other services that receive data</h2>');
  const end = PRIVACY.indexOf('<h2>', start + 1);
  assert.ok(start > 0 && end > start, 'privacy.html must keep the "Other services that receive data" section');
  return [...PRIVACY.slice(start, end).matchAll(/<h3>([^<]+)<\/h3>/g)].map((m) => m[1].trim());
}

test('the code inventory found the expected host literals', () => {
  assert.ok(HOSTS.size >= 15, `only ${HOSTS.size} https hosts discovered; the scan is broken`);
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

test('privacy.html does not mention PurgoMalum (Arena moderation is a local word list)', () => {
  assert.ok(!/purgomalum/i.test(PRIVACY), 'privacy.html names PurgoMalum');
  assert.ok(!/purgomalum/i.test([...HOSTS].join(' ')), 'code contacts purgomalum again; if real, re-disclose it');
});
