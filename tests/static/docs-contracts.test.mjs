// Documentation claims that a machine can check (2026-09-05 audit F23).
//
// The audit's point was not prose style. It was that several operational
// statements contradicted the code, and the dangerous ones were about caching,
// deletion and deployment - exactly the statements a future change reads
// before deciding what is safe. Three of them:
//
//   - the root README described POSITIVE cache lifetimes for the Gym Tracker
//     assets ("300 s for js/css, 3600 s for data") while netlify.toml sets
//     max-age=0. Those zeroes are a fix, not an oversight: a max-age window
//     hides a subresource request from the service worker, which is how a page
//     ran an old module against new HTML for the length of the window;
//   - CLAUDE.md said mario-kart had no FINDINGS.md, and it does;
//   - the refresh workflow said nothing deploys until its pull request merges,
//     which was false while builds resolved a rolling data release.
//
// Every assertion here is derived from the file it describes, so the docs
// cannot drift from the config again without something failing. Nothing here
// pins a sentence: they pin CONTRADICTIONS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(join(REPO_ROOT, p), 'utf8');

test('the README describes the gym cache headers netlify.toml actually sends', () => {
  const toml = read('netlify.toml');
  const readme = read('README.md');

  // What is really configured, read from the config.
  const gymHeaders = [...toml.matchAll(/for = "\/apps\/gym-tracker\/(\w+)\/\*"[\s\S]{0,200}?Cache-Control = "([^"]+)"/g)]
    .map((m) => ({ dir: m[1], value: m[2] }));
  assert.ok(gymHeaders.length >= 3, `gym-tracker cache rules found: ${gymHeaders.length}`);
  const maxAges = gymHeaders.map((h) => Number(/max-age=(\d+)/.exec(h.value)?.[1] ?? -1));
  assert.deepEqual([...new Set(maxAges)], [0],
    'every gym-tracker asset rule must be max-age=0; a positive window hides the request from the service worker');

  // And what the README claims. The old sentence named 300 s and 3600 s.
  const deployPara = readme.split('\n').find((l) => l.includes('gym-tracker assets'));
  assert.ok(deployPara, 'the README still describes the gym-tracker cache headers');
  const claimed = [...deployPara.matchAll(/(\d+)\s*s\b/g)].map((m) => Number(m[1]));
  assert.deepEqual(claimed.filter((n) => n > 0), [],
    `the README claims positive cache lifetimes (${claimed.join(', ')}s) that netlify.toml does not set`);
  assert.match(deployPara, /max-age=0|no-cache|NO-CACHE/i,
    'and it must say what is actually sent');
});

test('CLAUDE.md\'s app-documentation inventory matches the filesystem', () => {
  const apps = readdirSync(join(REPO_ROOT, 'apps'), { withFileTypes: true })
    .filter((e) => e.isDirectory()).map((e) => e.name);
  const withBoth = apps.filter((a) =>
    existsSync(join(REPO_ROOT, 'apps', a, 'README.md'))
    && existsSync(join(REPO_ROOT, 'apps', a, 'FINDINGS.md')));

  const claude = read('CLAUDE.md');
  const sentence = claude.split('\n\n').find((p) => p.includes('**Future apps:**'));
  assert.ok(sentence, 'CLAUDE.md still carries the inventory note');

  if (withBoth.length === apps.length) {
    assert.match(sentence, /all (eight|\d+) apps have both files/i,
      `all ${apps.length} apps have both files, and the note must say so`);
    assert.equal(/has a README only/.test(sentence), false,
      'no app is README-only any more');
  } else {
    const missing = apps.filter((a) => !withBoth.includes(a));
    for (const app of missing) {
      assert.ok(sentence.includes(app), `${app} has no FINDINGS.md and the note must name it`);
    }
  }
});

test('the refresh workflow\'s deploy claim matches how a build resolves data', () => {
  const wf = read('.github/workflows/refresh-rising-shows.yml');
  const fetcher = read('apps/rising-shows/scripts/fetch-data.js');

  // The claim is only true if a build resolves a COMMITTED pin rather than
  // whatever is on the rolling release at that minute.
  if (/nothing deploys until/i.test(wf)) {
    assert.match(fetcher, /data-release\.json/,
      'the workflow claims a merge gates the data, so the build must resolve a committed manifest');
    assert.match(fetcher, /sha256/,
      'and verify it, or the pin names a file it cannot prove it received');
    assert.match(wf, /immutable/i,
      'and the workflow must publish something immutable for that pin to name');
  }
});

test('robots.txt does not describe a deploy shape the site no longer has', () => {
  const robots = read('robots.txt');
  const toml = read('netlify.toml');
  const publishesTree = !/^\s*publish = "dist"/m.test(toml);
  if (!publishesTree) {
    assert.equal(/publishes the whole tracked tree/.test(robots), false,
      'the deploy publishes an allow-listed directory now; robots.txt must not say otherwise');
  }
});

test('privacy.html does not promise deletion behaviour the code does not have', () => {
  const privacy = read('privacy.html');
  const sync = read('sync-system/app-sync-init.js');
  // If the page says Arena rows are removed, the orchestrator has to remove
  // them. This is the direction that matters: a policy page over-claiming is
  // the failure, not under-claiming.
  if (/Arena global XP leaderboard row and every Globe Drop daily-challenge score/.test(privacy)) {
    assert.match(sync, /eraseArenaIdentity/,
      'privacy.html says the Arena rows are deleted, so account deletion must delete them');
  }
  assert.equal(/the security rules don't grant you deletion rights over them/.test(privacy), false,
    'that limitation was removed in the same change that added the deletion path');
});

test('the CSP the README names is the one netlify.toml sends', () => {
  const readme = read('README.md');
  const toml = read('netlify.toml');
  const enforced = /^\s*Content-Security-Policy = "/m.test(toml);
  const deployPara = readme.split('\n').find((l) => l.includes('netlify.toml` defines') || l.includes('security headers'));
  assert.ok(deployPara, 'the README still describes the security headers');
  if (enforced) {
    assert.equal(/CSP-Report-Only\)/.test(deployPara), false,
      'an enforcing CSP ships now, so the README must not describe report-only as the whole story');
  }
});
