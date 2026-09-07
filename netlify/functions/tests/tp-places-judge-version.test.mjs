import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JUDGE_VERSION, rejectionSignature } from '../lib/tp-places-lookup.mjs';

// WHY THIS FILE EXISTS.
//
// A rejection tombstone is only safe to keep for seven days because
// JUDGE_VERSION retires every stored verdict when the gates change. That made
// the whole scheme rest on one human remembering to bump a string - and a
// forgotten bump is silent: no test fails, nothing looks wrong, and travellers
// keep being shown a refusal the current code would not have reached, for up to
// a week after the fix shipped. The Ko Phi Phi round is the case that matters
// (a bad anchor made the gates refuse every correct venue in a region), and it
// is exactly the case where a stale verdict hurts most.
//
// So the discipline is replaced by a check. This hashes the SOURCE OF THE GATES
// and pins it. Change a gate and this test fails, naming what to do. It cannot
// be forgotten, because it fails in CI rather than in production.
//
// The scope is deliberate: `tp-places-match.mjs` in full (it IS the gates
// module - isGenericQuery, matchConfidence, verifyArea, typeMismatch,
// foodTypeOf and the radii they read) plus `judge` from the lookup module,
// which combines them. The rest of the lookup module is caching and budget
// work that changes for reasons a verdict does not care about, and including
// it would make this fail so often that people would learn to ignore it.
//
// Comment-only lines and blank lines are stripped, so the heavy commentary this
// repo runs on can be rewritten freely without touching the pin.

const LIB = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib');

// Line granularity on purpose. A character-level comment stripper has to
// understand strings, template literals and regex literals to avoid mangling
// code, and getting that subtly wrong would make this check lie. A whole line
// that begins with `//`, or sits inside a `/* */` block, is unambiguous.
function stripComments(src) {
  const out = [];
  let inBlock = false;
  for (const raw of src.split('\n')) {
    const line = raw.trimEnd();
    const t = line.trim();
    if (inBlock) {
      if (t.includes('*/')) inBlock = false;
      continue;
    }
    if (t.startsWith('/*')) {
      if (!t.includes('*/')) inBlock = true;
      continue;
    }
    if (t.startsWith('//') || t === '') continue;
    out.push(line);
  }
  return out.join('\n');
}

// `judge` by brace balance from its declaration. It contains no braces inside
// string literals, which is what makes counting safe here; the assertions below
// fail loudly if that ever stops being true.
function extractJudge(src) {
  const start = src.indexOf('\nfunction judge(');
  assert.ok(start !== -1, 'judge() not found - update this test with the gates it moved to');
  let depth = 0, i = src.indexOf('{', start);
  const from = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) break;
  }
  assert.ok(depth === 0 && i < src.length, 'could not balance judge() braces');
  return src.slice(from, i + 1);
}

export function gateFingerprint() {
  const match = stripComments(readFileSync(join(LIB, 'tp-places-match.mjs'), 'utf8'));
  const lookup = readFileSync(join(LIB, 'tp-places-lookup.mjs'), 'utf8');
  const judge = stripComments(extractJudge(lookup));
  assert.ok(match.includes('export function matchConfidence'), 'matchConfidence missing from the gates module');
  assert.ok(match.includes('export function verifyArea'), 'verifyArea missing from the gates module');
  assert.ok(match.includes('export function typeMismatch'), 'typeMismatch missing from the gates module');
  assert.ok(judge.includes('rejected: true'), 'judge() no longer marks rejections');
  return createHash('sha256').update(match + '\n@judge\n' + judge).digest('hex').slice(0, 16);
}

// Bump BOTH of these together whenever a gate changes what it decides.
const PINNED_GATES = 'fe28e1dbba0184e7';
const PINNED_VERSION = 'j1';

test('a gate cannot change without JUDGE_VERSION changing with it', () => {
  const actual = gateFingerprint();
  assert.equal(actual, PINNED_GATES,
    '\n\n  THE GATES CHANGED.\n'
    + '  A stored rejection is replayed for up to REJECT_TTL_MS (7 days), and it is\n'
    + '  only scoped to the logic that reached it by JUDGE_VERSION. So:\n\n'
    + '    1. If this change alters what a gate DECIDES, bump JUDGE_VERSION in\n'
    + '       netlify/functions/lib/tp-places-lookup.mjs (j1 -> j2 -> ...). That\n'
    + '       retires every stored verdict on deploy.\n'
    + '    2. If it is a pure refactor that decides exactly the same things, leave\n'
    + '       JUDGE_VERSION alone.\n\n'
    + `  Either way, update PINNED_GATES in this file to:\n    ${actual}\n`);
});

test('JUDGE_VERSION is pinned, and rides in every rejection signature', () => {
  assert.equal(JUDGE_VERSION, PINNED_VERSION,
    `JUDGE_VERSION moved to ${JUDGE_VERSION}; update PINNED_VERSION here in the same commit.`);
  // The version is only useful if it actually reaches the stored signature.
  const sig = rejectionSignature({ city: 'Tokyo', point: { lat: 35.68, lon: 139.76 }, radiusKm: 150 }, 'dinner');
  assert.ok(sig.startsWith(JUDGE_VERSION + '|'),
    `a verdict signature must begin with the judge version, got ${sig}`);
});

test('the fingerprint ignores comment churn but not code', () => {
  // If this ever stops holding, the check above is either useless (never fails)
  // or unusable (always fails), and both are worse than no check at all.
  const a = stripComments('// note\nconst x = 1;\n\n/* block\n   more */\nconst y = 2;');
  assert.equal(a, 'const x = 1;\nconst y = 2;', 'comment-only and blank lines must vanish');
  const b = stripComments('const x = 1;\nconst y = 3;');
  assert.notEqual(a, b, 'a real code change must survive stripping');
});
