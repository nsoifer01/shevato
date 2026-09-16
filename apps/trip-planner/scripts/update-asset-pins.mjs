#!/usr/bin/env node
// Regenerate tests/fixtures/asset-pins.json after bumping a `?v=` pin.
//
// Run this in the SAME change that bumps a pin. asset-pin-drift.test.mjs
// compares the tree against this fixture and fails when a pinned file's
// content moved and its pin did not, which is what shipped in PR #550.
import { writeFileSync } from 'node:fs';
import { computePins, MANIFEST } from '../tests/helpers/asset-pins.mjs';

const pins = computePins();
writeFileSync(MANIFEST, `${JSON.stringify(pins, null, 2)}\n`);
console.log(`[update-asset-pins] wrote ${MANIFEST}`);
for (const [rel, { pin, sha256 }] of Object.entries(pins)) console.log(`  ${rel}  v=${pin}  ${sha256}`);
