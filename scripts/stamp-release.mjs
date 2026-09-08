#!/usr/bin/env node
// Stamp the deploy's build identifier into the shipped analytics helper.
//
// WHY: an app_error event that says "something failed in sync" is not
// actionable without knowing WHICH build it failed in - a spike after a
// deploy and a long-standing trickle look identical in GA4 otherwise. The
// helper carries a `__SHEVATO_RELEASE__` token and reports `release_id` on
// every event; this script replaces the token at deploy time, so the value is
// DERIVED from the build rather than hand-maintained (the repo has a long
// history of hand-maintained numbers drifting).
//
// Netlify sets COMMIT_REF on every build. Locally the token is left alone and
// analytics.js reports "dev", which is the honest answer for an unbuilt tree.
//
// Idempotent: a tree that has already been stamped (no token left) is a no-op,
// so running `npm run build:site` twice is safe.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = resolve(ROOT, 'assets/js/analytics.js');
export const TOKEN = '__SHEVATO_RELEASE__';

/** Short, filesystem-safe build id, or null when nothing can identify it. */
export function releaseId(env = process.env, gitRef = tryGitRef) {
  const ref = env.COMMIT_REF || env.GITHUB_SHA || gitRef();
  if (!ref) return null;
  const short = String(ref).trim().slice(0, 12);
  return /^[A-Za-z0-9._-]+$/.test(short) ? short : null;
}

function tryGitRef() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  } catch { return null; }
}

function main() {
  const src = readFileSync(TARGET, 'utf8');
  if (!src.includes(TOKEN)) {
    console.log('[stamp-release] already stamped, nothing to do');
    return;
  }
  const id = releaseId();
  if (!id) {
    console.log('[stamp-release] no build identifier available, leaving "dev"');
    return;
  }
  writeFileSync(TARGET, src.split(TOKEN).join(id));
  console.log(`[stamp-release] analytics release_id = ${id}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
