#!/usr/bin/env node
// Can this Netlify build be skipped, because the site it would deploy is the
// site production already serves?
//
//   [build]
//     ignore = "node ./scripts/netlify-ignore.mjs"
//
// Wired in netlify.toml in October 2026, after the monthly reset. The audit,
// the proofs and how to verify a skip are in FINDINGS.md, "Netlify build
// minutes".
//
// WHY THIS EXISTS
// ---------------
// The team is on Netlify's legacy Free plan: 300 build minutes a calendar month
// (Pacific), and September 2026 passed 300 on the 13th. Deploy Previews were
// switched off that day. Production builds alone still cost about 1.1 minutes
// each, and 12-13% of them (measured over every retained deploy, 15 August to
// 14 September) changed nothing but Markdown, tests, GitHub workflows or the
// lint config - files that cannot reach the deployed site.
//
// THE RULE: SKIP ONLY WHAT CANNOT CHANGE THE DEPLOY
// -------------------------------------------------
// A build is skipped only when every file that differs between the commit
// production is serving RIGHT NOW and the commit being built is provably
// outside the deploy: not published (scripts/build-publish-dir.mjs decides
// that, and this file asks it), not under netlify/, and in one of four inert
// classes (INERT below). tests/static/netlify-ignore.test.mjs proves the
// classes are never read by the build command, the functions bundle or
// netlify.toml. Every other path, including anything nobody has classified,
// builds. A skipped build leaves production exactly as it is on a day nobody
// pushes anything.
//
// WHY NOT NETLIFY'S CACHED_COMMIT_REF
// -----------------------------------
// Netlify's documented pattern diffs CACHED_COMMIT_REF ("the last commit that
// we built") against COMMIT_REF. That is a fact about the build cache, not
// about production, and two undocumented details make it unsafe here: whether
// Deploy Previews and production share that cache (if they do, a squash merge
// whose tree a preview already built diffs as EMPTY and production never gets
// the change), and what it names after a failed or superseded build. The
// commit production actually serves is published by the site itself:
// scripts/stamp-release.mjs stamps the first 12 characters of COMMIT_REF into
// assets/js/analytics.js. Reading it back asks the only question that matters.
// Every race in that read (a deploy still going live, a stale edge copy) can
// only make the live commit OLDER, which makes the diff larger, which builds.
//
// FAIL-SAFE: BUILD
// ----------------
// Netlify's contract is exit 0 = skip, anything else = build. Every missing
// variable, failed request, unknown commit, non-ancestor, git error and thrown
// exception ends in exit 1. The worst case of a wrong BUILD is a minute; the
// worst case of a wrong SKIP is a change that never reaches the site.
//
// FORCING A BUILD: "Clear cache and deploy project" in the Netlify UI. Without
// a cache, CACHED_COMMIT_REF equals COMMIT_REF, and that always builds - which
// is what an environment-variable change needs. A build hook bypasses ignore
// altogether.
//
// RUNTIME: Netlify runs ignore commands on Node 18 with the repository's npm
// dependencies unavailable, so this file imports only node: builtins and
// ./build-publish-dir.mjs (which imports only node: builtins).
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isPublished, ROOT_FILES, ROOT_DIRS } from './build-publish-dir.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHA = /^[0-9a-f]{40}$/;

/** Where production says which commit it was built from (scripts/stamp-release.mjs). */
export const RELEASE_PATH = '/assets/js/analytics.js';

/**
 * The only paths a build may be skipped for. Each class is outside the publish
 * directory by build-publish-dir.mjs's DENY list, and the test proves the build
 * never reads one. Anything that is not here builds.
 */
export const INERT = [
  { re: /\.md$/, why: 'Markdown' },
  { re: /^\.github\//, why: 'GitHub Actions configuration' },
  { re: /(^|\/)(tests?|tests-rules|e2e)\//, why: 'test estate' },
  { re: /^eslint\.config\.mjs$/, why: 'lint configuration' },
];

function published(rel) {
  if (ROOT_FILES.includes(rel)) return true;
  return ROOT_DIRS.includes(rel.split('/')[0]) && isPublished(rel);
}

/** { relevant, why } for one repo-relative path. Relevant unless provably inert. */
export function classifyPath(rel) {
  if (typeof rel !== 'string' || !rel || rel.startsWith('/') || rel.split('/').includes('..')) {
    return { relevant: true, why: 'not a plain repository path' };
  }
  if (rel === 'netlify.toml' || rel.startsWith('netlify/')) {
    return { relevant: true, why: 'Netlify configuration or functions' };
  }
  if (published(rel)) return { relevant: true, why: 'published' };
  const hit = INERT.find((c) => c.re.test(rel));
  return hit ? { relevant: false, why: hit.why } : { relevant: true, why: 'not provably outside the deploy' };
}

/** The 12-character release id production's analytics helper carries, or null. */
export function releaseIdFromAnalytics(src) {
  const ids = [...String(src || '').matchAll(/\bvar RELEASE_ID = '([0-9a-f]{12})';/g)];
  return ids.length === 1 ? ids[0][1] : null;
}

const build = (reason, paths = []) => ({ build: true, reason, paths });

export async function decide({ env, git, fetchText }) {
  const commit = String(env.COMMIT_REF || '');
  if (!SHA.test(commit)) return build(`no usable COMMIT_REF (${env.COMMIT_REF})`);

  const cached = String(env.CACHED_COMMIT_REF || '');
  if (!cached || cached === commit) {
    return build('no build cache, or the same commit again: a rebuild without cache is always deliberate '
      + '("Clear cache and deploy project" forces a build this way)');
  }

  const site = String(env.URL || '');
  if (!/^https:\/\/[^/\s?#]+$/.test(site)) return build(`no usable URL (${env.URL}) to ask what production serves`);

  let text;
  try {
    text = await fetchText(`${site}${RELEASE_PATH}?netlify-ignore=${commit}`);
  } catch (err) {
    return build(`could not read ${site}${RELEASE_PATH}: ${err.message}`);
  }
  const release = releaseIdFromAnalytics(text);
  if (!release) return build(`${site}${RELEASE_PATH} names no release id`);

  let live;
  try {
    live = String(git(['rev-parse', '--verify', '--quiet', `${release}^{commit}`])).trim();
  } catch {
    return build(`production's release ${release} is not a commit in this clone`);
  }
  if (!SHA.test(live) || !live.startsWith(release)) return build(`production's release ${release} did not resolve to one commit`);
  if (live === commit) return build(`production already serves ${commit}: rebuilding it is deliberate`);

  try {
    git(['merge-base', '--is-ancestor', live, commit]);
  } catch {
    return build(`production's commit ${live} is not an ancestor of ${commit}`);
  }

  // --no-renames is load-bearing: with rename detection a file MOVED from the
  // published tree into tests/ lists only its new, inert-looking name.
  let names;
  try {
    names = String(git(['diff', '--no-renames', '--name-only', '-z', live, commit]));
  } catch (err) {
    return build(`git diff ${live} ${commit} failed: ${err.message}`);
  }
  const files = names.split('\0').filter(Boolean);
  const relevant = files.filter((p) => classifyPath(p).relevant);
  if (relevant.length) {
    return build(`${relevant.length} of ${files.length} file(s) changed since production's ${live.slice(0, 12)} can change the deploy`, relevant);
  }
  return {
    build: false,
    reason: `all ${files.length} file(s) changed since production's ${live.slice(0, 12)} are outside the deploy`,
    paths: files,
  };
}

function runGit(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

async function fetchTextOverNetwork(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000), redirect: 'error', headers: { 'cache-control': 'no-cache' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

export async function main({ env = process.env, git = runGit, fetchText = fetchTextOverNetwork, log = console.log } = {}) {
  let result;
  try {
    result = await decide({ env, git, fetchText });
  } catch (err) {
    result = build(`the check itself failed: ${err.message}`);
  }
  log(`[netlify-ignore] ${result.build ? 'BUILD' : 'SKIP'}: ${result.reason}`);
  const SHOWN = 25;
  for (const p of result.paths.slice(0, SHOWN)) log(`[netlify-ignore]   ${p} (${classifyPath(p).why})`);
  if (result.paths.length > SHOWN) log(`[netlify-ignore]   ...and ${result.paths.length - SHOWN} more`);
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const result = await main();
  process.exitCode = result.build ? 1 : 0;
}
