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
// Idempotent WITHIN one build, and re-stampable ACROSS builds: a tree that
// already carries a stamp is rewritten when the build id has changed, and left
// alone when it has not.
//
// That second half was missing until 2026-09-20 and published a wrong
// `release_id` to production. The script writes into the SOURCE file, so the
// token survives exactly one build; a "no token left, nothing to do" early
// return then froze the FIRST build's id into every later build of the same
// tree. Netlify never sees it (every build is a fresh clone), but the DEV/prod
// workflow in CLAUDE.md builds a throwaway worktree twice on purpose, once for
// the draft deploy and once for the merged commit, so production reported a
// commit that had just been squashed away and no longer existed on master.

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

/**
 * The assignment the token lives in. Matched as a whole statement rather than
 * by the bare value, so a stamp can be recognised and replaced on a later
 * build of the same tree. The value is whatever `releaseId` is allowed to
 * produce (`[A-Za-z0-9._-]`), plus the unstamped token and the "dev" default.
 */
const ASSIGNMENT = /(var RELEASE_ID = ')([A-Za-z0-9._-]{1,64})(';)/;

/**
 * The stamped source, or null when nothing needs writing. Pure, so the
 * re-stamp path is testable without touching the tree.
 */
export function stamp(src, id) {
  if (src.includes(TOKEN)) return src.split(TOKEN).join(id);
  const m = ASSIGNMENT.exec(src);
  if (!m) return null;
  if (m[2] === id) return null;
  return src.replace(ASSIGNMENT, `$1${id}$3`);
}

function main() {
  const src = readFileSync(TARGET, 'utf8');
  const id = releaseId();
  if (!id) {
    console.log('[stamp-release] no build identifier available, leaving "dev"');
    return;
  }
  const out = stamp(src, id);
  if (out === null) {
    console.log(`[stamp-release] already stamped ${id}, nothing to do`);
    return;
  }
  const restamped = !src.includes(TOKEN);
  writeFileSync(TARGET, out);
  console.log(`[stamp-release] analytics release_id = ${id}${restamped ? ' (re-stamped a reused tree)' : ''}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
