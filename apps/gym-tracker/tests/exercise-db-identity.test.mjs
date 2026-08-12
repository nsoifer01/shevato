// Exercise catalog identity pins.
//
// Workout history, PRs, progression, and program rows all join on the
// exercise's numeric `id`; the display name is resolved from the catalog at
// render time. That makes two properties load-bearing:
//   1. An id, once shipped, must keep meaning the same movement forever -
//      renames are fine, but an id must never be reused for a different
//      exercise or renumbered, or every user's history silently reattaches
//      to the wrong lift.
//   2. A rename must actually replace the old name (no duplicate entry left
//      behind), or history/search splits between two records.
//
// These tests pin the ids touched by the 2026-08 catalog round (the
// Seated Dumbbell Press -> Dumbbell Shoulder Press rename, the Glute Ham
// Raise -> Glute-Ham Raise canonicalization, and the Hip Thrust Machine
// addition) plus a few long-standing anchors, so an accidental reorder,
// reseed, or id shift fails loudly.
process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'data', 'exercises-db.json');
const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
const byId = new Map(db.map(e => [e.id, e]));

test('anchor ids resolve to their expected exercises', () => {
    // Long-standing anchors: if these move, the whole catalog shifted.
    assert.equal(byId.get(3)?.name, 'Barbell Bench Press');
    assert.equal(byId.get(350)?.name, 'Glute-Ham Raise');
    assert.equal(byId.get(452)?.name, 'Decline Crunch');
    assert.equal(byId.get(514)?.name, 'Hip Thrust Machine');
});

test('rename kept id 173 (Seated Dumbbell Press -> Dumbbell Shoulder Press)', () => {
    const e = byId.get(173);
    assert.equal(e?.name, 'Dumbbell Shoulder Press');
    // Identity metadata untouched by the rename.
    assert.equal(e?.category, 'shoulders');
    assert.equal(e?.muscleGroup, 'front-deltoids');
    assert.equal(e?.equipment, 'dumbbell');
});

test('renamed exercises left no duplicate under the old name', () => {
    assert.ok(!db.some(e => e.name === 'Seated Dumbbell Press'),
        'old name "Seated Dumbbell Press" must not remain in the catalog');
    assert.ok(!db.some(e => e.name === 'Glute Ham Raise'),
        'old spelling "Glute Ham Raise" must not remain in the catalog');
});

test('Hip Thrust Machine is a machine glute exercise with a fresh id', () => {
    const e = byId.get(514);
    assert.equal(e?.category, 'glutes');
    assert.equal(e?.muscleGroup, 'glutes');
    assert.equal(e?.equipment, 'machine');
    assert.equal(e?.exerciseType, 'reps');
    assert.equal(db.filter(x => x.name === 'Hip Thrust Machine').length, 1);
});

test('exact-duplicate names never enter the catalog', () => {
    const seen = new Map();
    for (const e of db) {
        const key = e.name.toLowerCase();
        assert.ok(!seen.has(key),
            `duplicate exercise name "${e.name}" (ids ${seen.get(key)} and ${e.id})`);
        seen.set(key, e.id);
    }
});

test('ids are stable literals, not positions: array order is not the id', () => {
    // Guards against a refactor that regenerates ids from array indices -
    // id 514 sits inside the glutes block, not at position 514.
    const idx = db.findIndex(e => e.id === 514);
    assert.notEqual(idx, -1);
    assert.notEqual(idx, 513, 'id 514 must not be required to sit at index 513');
    assert.equal(db[idx - 1]?.id, 382, 'Hip Thrust Machine sits after Hip Thrust (id 382)');
});
