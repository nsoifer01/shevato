#!/usr/bin/env node
// Fail early, and say what to do about it.
//
// The repo moved off Node 20 (end-of-life) to Node 22 LTS. That is not just a
// support-window change: Node 22's test runner treats a POSITIONAL DIRECTORY
// as a file to execute rather than a tree to walk, so `npm test` had to move
// to glob patterns - and those globs are not understood by Node 20, which
// answers `Could not find '.../**/*.test.*'` and exits. That message tells a
// contributor nothing about the actual problem, so this runs first and says
// it plainly.
//
// Wired as `pretest`, which npm runs automatically before `npm test`. It costs
// one process start.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The major version .nvmrc asks for, or null when it cannot be read. */
export function requiredMajor(root = ROOT) {
  try {
    const raw = readFileSync(resolve(root, '.nvmrc'), 'utf8').trim();
    const n = Number.parseInt(raw.replace(/^v/, ''), 10);
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}

export function currentMajor(version = process.version) {
  return Number.parseInt(String(version).replace(/^v/, ''), 10);
}

export function check(required, current) {
  if (required === null) return { ok: true };
  if (current >= required) return { ok: true };
  return {
    ok: false,
    message:
      `This repo needs Node ${required} or newer; you are on ${process.version}.\n`
      + `\n`
      + `  nvm install ${required} && nvm use ${required}\n`
      + `\n`
      + `Node ${required} is what .nvmrc, package.json engines, CI and the Netlify\n`
      + `build all use. On an older runtime the test runner does not understand the\n`
      + `glob patterns in the "test" script and reports a missing file instead.`,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const result = check(requiredMajor(), currentMajor());
  if (!result.ok) {
    console.error(result.message);
    process.exit(1);
  }
}
