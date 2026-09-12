#!/usr/bin/env node
/**
 * Refresh the service-worker precache manifest fixture.
 *
 * Run this AFTER bumping `CACHE_VERSION` in sw.js, whenever a precached file
 * changed. `tests/sw-precache-content-version.test.mjs` compares the committed
 * manifest against the tree and fails if the two disagree, which is how a
 * content change that forgot its version bump is caught before it ships a
 * stale app shell to everyone.
 *
 *   node apps/gym-tracker/scripts/update-precache-manifest.mjs
 */

import { writeFileSync } from 'node:fs';
import {
    MANIFEST_PATH, computeManifest, readManifest, serializeManifest,
} from '../tests/helpers/precache-manifest.mjs';

// `--force` is for the second and later edits WITHIN one round: the version was
// already bumped for this change, so refusing again would just mean deleting
// the fixture by hand. It is never the answer to a fresh refusal.
const force = process.argv.includes('--force');

let previous = null;
try { previous = readManifest(); } catch { /* first run, or a deleted fixture */ }

const next = computeManifest();

if (!force && previous && previous.cacheVersion === next.cacheVersion) {
    const changed = Object.keys(next.files)
        .filter((url) => previous.files[url] !== next.files[url]);
    const removed = Object.keys(previous.files).filter((url) => !(url in next.files));
    if (changed.length || removed.length) {
        console.error(
            `Refusing to write: precached content changed but CACHE_VERSION is still ${next.cacheVersion}.\n`
            + 'Bump CACHE_VERSION in apps/gym-tracker/sw.js first (PATCH for content edits,\n'
            + 'MINOR if the list shape or a cache strategy changed), then run this again.\n'
            + `Changed: ${[...changed, ...removed.map((u) => `${u} (removed)`)].join(', ')}\n`
            + 'If you already bumped it for this same change, re-run with --force.'
        );
        process.exit(1);
    }
}

writeFileSync(MANIFEST_PATH, serializeManifest(next));
console.log(
    `Wrote ${MANIFEST_PATH}\n  cacheVersion ${next.cacheVersion}, `
    + `${Object.keys(next.files).length} precached entries`
);
