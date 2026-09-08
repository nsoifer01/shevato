// The ENFORCED Content-Security-Policy, and the tree properties that make it
// safe to enforce (2026-09-05 audit F14).
//
// The site shipped only Content-Security-Policy-Report-Only, justified by
// inline styles. Inline styles have nothing to do with object-src or
// base-uri, so a whole class of injection defence sat switched off waiting on
// an unrelated blocker, and the policy documented restrictions it did not
// apply.
//
// The enforced header carries exactly the directives that are compatible with
// this tree TODAY. This file asserts both halves: that the header is there
// and says what it should, AND that the tree still has the properties that
// make each directive a no-op for legitimate content. If somebody adds an
// <object> or a cross-origin form, this fails BEFORE production blocks it.
//
// The report-only header keeps the full intended policy, so the strict
// script-src/style-src work is still described, still measured, and now has
// somewhere to report to.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const toml = readFileSync(join(REPO_ROOT, 'netlify.toml'), 'utf8');

function headerValue(name) {
  for (const line of toml.split('\n')) {
    const m = /^\s*([A-Za-z-]+)\s*=\s*"(.*)"\s*$/.exec(line);
    if (m && m[1] === name) return m[2];
  }
  return null;
}

function directives(policy) {
  const out = new Map();
  for (const part of String(policy).split(';')) {
    const [name, ...rest] = part.trim().split(/\s+/);
    if (name) out.set(name, rest.join(' '));
  }
  return out;
}

/** Every committed .html file, excluding build output and worktrees. */
function htmlFiles() {
  // .quotescout-build-cache holds CMS source pages downloaded by
  // scripts/build-quotescout-data.mjs. It is gitignored input to a build, not
  // anything this site serves.
  const skip = /(^|\/)(node_modules|\.git|\.claude|shows|exercises|coverage|\.screenshots|\.quotescout-build-cache)(\/|$)/;
  const found = [];
  (function walk(dir) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const rel = relative(REPO_ROOT, full);
      if (skip.test(rel)) continue;
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.html')) found.push(rel);
    }
  })(REPO_ROOT);
  return found;
}

const HTML = htmlFiles();

test('an enforcing CSP header ships, not only a report-only one', () => {
  const enforced = headerValue('Content-Security-Policy');
  assert.ok(enforced, 'netlify.toml must set Content-Security-Policy');
  assert.ok(headerValue('Content-Security-Policy-Report-Only'),
    'and keep the report-only policy that describes the intended end state');
});

test('the enforced policy carries the directives that need no inline exemption', () => {
  const d = directives(headerValue('Content-Security-Policy'));
  assert.equal(d.get('object-src'), "'none'", 'no plugin content, anywhere');
  assert.equal(d.get('base-uri'), "'self'", 'an injected <base> cannot re-root every relative URL');
  assert.equal(d.get('form-action'), "'self'", 'a form cannot be pointed at another origin');
  assert.equal(d.get('frame-ancestors'), "'none'", 'the modern spelling of X-Frame-Options: DENY');
});

test('the enforced policy does NOT carry the directives still waiting on inline work', () => {
  // Enforcing script-src/style-src today would break apps.html and the Trip
  // Planner, both of which ship inline <script>. Shipping them enforced with
  // 'unsafe-inline' would be worse: a directive that permits what it claims
  // to restrict, which is how the report-only header ended up meaning nothing.
  const d = directives(headerValue('Content-Security-Policy'));
  for (const risky of ['script-src', 'style-src', 'default-src']) {
    assert.equal(d.has(risky), false,
      `${risky} belongs in the report-only policy until inline content is nonced or hashed`);
  }
});

test('the report-only policy has somewhere to report TO', () => {
  // Without this it is console output in one visitor's browser: three Trip
  // Planner origins were missing from connect-src for weeks and nothing said so.
  const d = directives(headerValue('Content-Security-Policy-Report-Only'));
  assert.match(d.get('report-uri') || '', /^\/\.netlify\/functions\/csp-report$/);
});

test('no committed page contains an element object-src or base-uri would block', () => {
  const offenders = [];
  for (const rel of HTML) {
    const html = readFileSync(join(REPO_ROOT, rel), 'utf8');
    if (/<(object|embed|applet)[\s>]/i.test(html)) offenders.push(`${rel}: plugin element`);
    if (/<base[\s>]/i.test(html)) offenders.push(`${rel}: <base>`);
  }
  assert.deepEqual(offenders, [],
    'enforcing object-src/base-uri would break these pages: ' + offenders.join(', '));
});

test('no committed form posts to another origin', () => {
  const offenders = [];
  for (const rel of HTML) {
    const html = readFileSync(join(REPO_ROOT, rel), 'utf8');
    for (const m of html.matchAll(/<form[^>]*\saction="([^"]*)"/gi)) {
      const action = m[1];
      if (/^https?:\/\//i.test(action) && !action.startsWith('https://shevato.com')) {
        offenders.push(`${rel}: ${action}`);
      }
    }
  }
  assert.deepEqual(offenders, [], 'form-action \'self\' would block these: ' + offenders.join(', '));
});

test('the site is never framed, so frame-ancestors and X-Frame-Options agree', () => {
  assert.match(toml, /X-Frame-Options\s*=\s*"DENY"/,
    'both spellings must say the same thing, or a browser that honours one and not the other diverges');
});

test('the enforced policy is a SUBSET of the report-only one', () => {
  // Otherwise the report-only header stops describing the end state: a
  // directive enforced but absent from it would never have been measured.
  const enforced = directives(headerValue('Content-Security-Policy'));
  const reported = directives(headerValue('Content-Security-Policy-Report-Only'));
  for (const [name, value] of enforced) {
    if (name === 'frame-ancestors') continue;   // X-Frame-Options covers this pair
    assert.equal(reported.get(name), value,
      `${name} is enforced as "${value}" but the report-only policy says "${reported.get(name)}"`);
  }
});

// ---------------------------------------------------------------------------
// netlify.toml has to PARSE, which is not a given.
//
// `[functions] node_version = "22"` looks obviously right and is not: the
// config schema reads any unrecognised key under [functions] as a
// per-function SCOPE OBJECT, so the whole file was rejected with
// "functions.node_version must be an object" and every deploy check on
// PR #506 failed at once. A config that does not parse is a total outage, and
// nothing in the estate could see it - these are the keys this repo sets, and
// the shapes they have to have.
// ---------------------------------------------------------------------------

test('the deploy config sets the keys it means to, in the shapes Netlify accepts', () => {
  const value = (key, section) => {
    const lines = toml.split('\n');
    let inSection = !section;
    for (const line of lines) {
      const header = /^\s*\[([^\]]+)\]/.exec(line);
      if (header) { inSection = header[1] === section; continue; }
      if (!inSection) continue;
      const m = new RegExp(`^\\s*${key}\\s*=\\s*"(.*)"`).exec(line);
      if (m) return m[1];
    }
    return null;
  };

  assert.equal(value('publish', 'build'), 'dist',
    'the deploy publishes the allow-listed directory, not the repo tree');
  assert.equal(value('functions', 'build'), 'netlify/functions',
    'functions bundle from the repo, which is why their source can leave the publish dir');
  assert.equal(value('node_bundler', 'functions'), 'esbuild');

  // The runtime pins. Both live in [build.environment]; neither belongs under
  // [functions], where the schema wants an object.
  assert.equal(value('NODE_VERSION', 'build.environment'), '22');
  assert.match(value('AWS_LAMBDA_JS_RUNTIME', 'build.environment') || '', /^nodejs\d+\.x$/);

  // The pin that actually failed. Any scalar key under [functions] other than
  // the documented ones is read as a scope name and rejects the file.
  const functionsBlock = /\n\[functions\]\n([\s\S]*?)(?=\n\[|$)/.exec(toml);
  assert.ok(functionsBlock, '[functions] block found');
  const keys = [...functionsBlock[1].matchAll(/^\s*([A-Za-z_]+)\s*=/gm)].map((m) => m[1]);
  const allowed = new Set(['node_bundler', 'directory', 'included_files', 'external_node_modules', 'deno_import_map']);
  for (const k of keys) {
    assert.ok(allowed.has(k), `[functions] ${k} is not a documented scalar key; the schema will read it as a scope object and reject the whole config`);
  }
});

test('the runtime pins agree with .nvmrc', () => {
  const nvmrc = readFileSync(join(REPO_ROOT, '.nvmrc'), 'utf8').trim();
  assert.match(toml, new RegExp(`NODE_VERSION = "${nvmrc}"`),
    'the build runs on the version .nvmrc names');
  assert.match(toml, new RegExp(`AWS_LAMBDA_JS_RUNTIME = "nodejs${nvmrc}\\.x"`),
    'and so do the functions');
});
