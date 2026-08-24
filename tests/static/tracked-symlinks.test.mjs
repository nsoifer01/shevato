// Repository hygiene: nothing named node_modules may be tracked by git, and
// no tracked symlink may point outside the repository.
//
// Why this exists. Commit 0ce12b9 (2026-08-23) committed a SYMLINK named
// node_modules at the repo root pointing at its own absolute path
// (/home/nikita/projects/shevato/node_modules -> itself). `.gitignore` said
// `/node_modules/`, and a trailing slash matches a DIRECTORY only, so the
// symlink was never ignored and `git add -A` staged it.
//
// The damage was invisible in CI and total locally, for the same reason:
//   - Fresh checkout (CI, Netlify deploys): the absolute target does not
//     exist there, so the link is merely DANGLING. npm ignores it and every
//     script runs normally. Every workflow stayed green, which is exactly
//     why nothing caught this for a day.
//   - The owner's machine: the target IS this repo, so the link is a LOOP.
//     npm prepends <cwd>/node_modules/.bin to PATH before spawning a script,
//     resolving that path raises ELOOP, and npm exits -40 (216 to the shell)
//     having printed NOTHING past the script banner. `npm test`, the gate
//     CLAUDE.md mandates before every commit, was silently dead.
//
// Three assertions, cheapest first:
//   1. no tracked path is, or lives under, node_modules
//   2. no tracked symlink is absolute or escapes the repo root
//   3. the .gitignore rule really does ignore a node_modules SYMLINK, not
//      just a directory. Checked behaviorally in a throwaway repo, because
//      in this working tree node_modules is a real directory, where the
//      broken pattern and the fixed one are indistinguishable.
//
// Zero dependencies. Where git (or symlink support) is unavailable a check
// degrades to a console note rather than a false failure, mirroring
// tests/static/module-imports.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function git(args, cwd = REPO_ROOT) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

// `<mode> <sha> <stage>\t<path>` per entry, NUL-separated.
function trackedEntries() {
  try {
    return git(['ls-files', '-s', '-z'])
      .split('\0')
      .filter(Boolean)
      .map((line) => {
        const tab = line.indexOf('\t');
        const [mode, sha] = line.slice(0, tab).split(/\s+/);
        return { mode, sha, path: line.slice(tab + 1) };
      });
  } catch {
    return null;
  }
}

test('no path named node_modules is tracked by git', () => {
  const entries = trackedEntries();
  if (!entries) {
    console.log('tracked-symlinks: git unavailable, tracked-path check skipped');
    return;
  }

  const offenders = entries
    .map((e) => e.path)
    .filter((p) => p === 'node_modules' || p.endsWith('/node_modules') || p.includes('/node_modules/'));

  assert.deepEqual(
    offenders,
    [],
    `node_modules must never be tracked (installed content, and a symlink of that name breaks npm):\n  ${offenders.join('\n  ')}`,
  );
});

test('no tracked symlink is absolute or escapes the repository root', () => {
  const entries = trackedEntries();
  if (!entries) {
    console.log('tracked-symlinks: git unavailable, symlink-target check skipped');
    return;
  }

  const links = entries.filter((e) => e.mode === '120000');
  const offenders = [];

  for (const link of links) {
    // The blob content of a symlink entry IS its target path.
    const target = git(['cat-file', '-p', link.sha]).trim();

    if (isAbsolute(target)) {
      offenders.push(`${link.path} -> ${target} (absolute: meaningless on any other machine)`);
      continue;
    }

    const resolved = resolve(REPO_ROOT, dirname(link.path), target);
    if (resolved === resolve(REPO_ROOT, link.path)) {
      offenders.push(`${link.path} -> ${target} (points at itself)`);
      continue;
    }

    const rel = relative(REPO_ROOT, resolved);
    if (rel.startsWith(`..${sep}`) || rel === '..') {
      offenders.push(`${link.path} -> ${target} (escapes the repo root)`);
    }
  }

  assert.deepEqual(offenders, [], `Tracked symlinks must stay relative and inside the repo:\n  ${offenders.join('\n  ')}`);
});

test('.gitignore ignores a node_modules symlink, not only a directory', () => {
  let scratch;
  try {
    scratch = mkdtempSync(join(tmpdir(), 'shevato-gitignore-'));
    git(['init', '-q', '.'], scratch);
  } catch {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    console.log('tracked-symlinks: git unavailable, .gitignore behaviour check skipped');
    return;
  }

  // core.excludesFile=/dev/null so a machine-level global ignore cannot make
  // this pass for the wrong reason.
  const status = () => git(['-c', 'core.excludesFile=/dev/null', 'status', '--porcelain'], scratch);

  try {
    copyFileSync(join(REPO_ROOT, '.gitignore'), join(scratch, '.gitignore'));

    // 1. The exact shape that got committed: a symlink named node_modules
    //    whose target is its own absolute path.
    const link = join(scratch, 'node_modules');
    try {
      symlinkSync(link, link);
    } catch {
      rmSync(scratch, { recursive: true, force: true });
      console.log('tracked-symlinks: symlinks unsupported here, .gitignore behaviour check skipped');
      return;
    }

    assert.ok(
      !status().includes('node_modules'),
      'A symlink named node_modules is NOT ignored. The root rule in .gitignore has a trailing slash '
        + '(`/node_modules/`), which matches directories only - the exact defect that let 0ce12b9 commit one. '
        + 'Drop the trailing slash.',
    );

    // 2. And the ordinary case still ignored, so the rule cannot be "fixed"
    //    by deleting it.
    unlinkSync(link);
    mkdirSync(link);
    writeFileSync(join(link, 'placeholder.txt'), 'installed content\n');

    assert.ok(
      !status().includes('node_modules'),
      'A real node_modules directory is not ignored by .gitignore.',
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
