#!/usr/bin/env node
// Course-data sync / validation tool.
//
// WHY: there is no official Mario Kart course API and the best community API
// (mk8_node_api) has no course data, so course lists are vendored as
// data/courses.json. This script keeps that file honest and gives a single
// place to (re)generate it from a configurable source as games update -- so
// nobody has to hand-maintain the list forever.
//
// USAGE
//   node apps/mario-kart/scripts/sync-courses.mjs --check         # validate only (CI-friendly, non-zero on error)
//   node apps/mario-kart/scripts/sync-courses.mjs --write         # normalize + restamp lastSynced, write file
//   node apps/mario-kart/scripts/sync-courses.mjs --source=remote # pull from a configured remote provider (see SOURCES)
//
// The default source is `vendored` (use the file as the source of truth and
// just re-validate/normalize). Adding a real upstream is a matter of writing
// one adapter in SOURCES below -- nothing else changes.

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = join(__dirname, '..', 'data', 'courses.json');

// ---- Source adapters. Each returns the `games` object in our schema. --------
const SOURCES = {
    // Treat the vendored file itself as the source of truth (default).
    async vendored() {
        const raw = JSON.parse(await readFile(DATA_FILE, 'utf8'));
        return raw.games;
    },

    // Example remote adapter -- wire a real upstream here when one exists.
    // It must map whatever shape the upstream returns into our { cups: [...] }
    // schema. Left as an explicit, documented stub so the seam is obvious.
    async remote() {
        const url = process.env.MK_COURSES_URL;
        if (!url) throw new Error('remote source needs MK_COURSES_URL env var');
        const res = await fetch(url);
        if (!res.ok) throw new Error(`remote fetch failed: ${res.status}`);
        const upstream = await res.json();
        // TODO: map `upstream` -> { mkworld: { cups: [...] }, mk8d: { cups: [...] } }
        // For now we assume the upstream already matches our schema's `games`.
        return upstream.games || upstream;
    }
};

// ---- Validation: the same invariants the app and tests rely on. -------------
function validate(games) {
    const errors = [];
    if (!games || typeof games !== 'object') {
        return ['dataset has no `games` object'];
    }
    for (const [gameKey, game] of Object.entries(games)) {
        if (!Array.isArray(game.cups) || game.cups.length === 0) {
            errors.push(`${gameKey}: missing or empty cups[]`);
            continue;
        }
        const seen = new Map(); // courseId -> first cup it appeared in
        for (const cup of game.cups) {
            if (!cup.id || !cup.name || !Array.isArray(cup.courses)) {
                errors.push(`${gameKey}: malformed cup ${JSON.stringify(cup.id || cup.name || '?')}`);
                continue;
            }
            for (const c of cup.courses) {
                if (!c.id || !c.name) {
                    errors.push(`${gameKey}/${cup.id}: course missing id or name`);
                    continue;
                }
                // Same id in two cups is allowed (course variants, e.g. Crown City)
                // but the NAME must match so the dedupe in the app is coherent.
                if (seen.has(c.id) && seen.get(c.id) !== c.name) {
                    errors.push(`${gameKey}: course id "${c.id}" reused with different names`);
                }
                seen.set(c.id, c.name);
            }
        }
    }
    return errors;
}

function summarize(games) {
    return Object.entries(games).map(([k, g]) => {
        const courses = new Set();
        g.cups.forEach((cup) => cup.courses.forEach((c) => courses.add(c.id)));
        const complete = g.source && g.source.complete ? 'complete' : 'partial';
        return `  ${k}: ${g.cups.length} cups, ${courses.size} unique courses (${complete})`;
    }).join('\n');
}

async function main() {
    const args = process.argv.slice(2);
    const check = args.includes('--check');
    const write = args.includes('--write');
    const sourceArg = (args.find((a) => a.startsWith('--source=')) || '--source=vendored').split('=')[1];

    const source = SOURCES[sourceArg];
    if (!source) {
        console.error(`Unknown source "${sourceArg}". Known: ${Object.keys(SOURCES).join(', ')}`);
        process.exit(2);
    }

    const games = await source();
    const errors = validate(games);

    console.log(`Source: ${sourceArg}`);
    console.log(summarize(games));

    if (errors.length) {
        console.error(`\n${errors.length} validation error(s):`);
        errors.forEach((e) => console.error('  - ' + e));
        process.exit(1);
    }
    console.log('\nValidation passed.');

    if (write) {
        const today = new Date().toISOString().slice(0, 10);
        for (const game of Object.values(games)) {
            if (game.source) game.source.lastSynced = today;
        }
        const out = { schemaVersion: 1, generatedBy: `sync:${sourceArg}`, games };
        await writeFile(DATA_FILE, JSON.stringify(out, null, 2) + '\n', 'utf8');
        console.log(`\nWrote ${DATA_FILE} (lastSynced=${today}).`);
    } else if (!check) {
        console.log('\n(dry run -- pass --write to update the file, --check for CI validation)');
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
