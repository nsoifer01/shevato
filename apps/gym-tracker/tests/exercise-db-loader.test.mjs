// Validate that the static exercise database JSON is well-formed and
// covers every category the UI references, plus the fetch-based loader's
// memoization under a stubbed fetch.
process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'data', 'exercises-db.json');

const rawJson = fs.readFileSync(DB_PATH, 'utf8');
const data = JSON.parse(rawJson);

test('exercises-db.json: parses and is an array', () => {
    assert.ok(Array.isArray(data), 'expected top-level array');
    assert.ok(data.length > 100, `expected > 100 entries, got ${data.length}`);
});

test('exercises-db.json: every entry has id, name, category, equipment', () => {
    for (const e of data) {
        assert.ok(Number.isFinite(e.id), `bad id: ${JSON.stringify(e)}`);
        assert.equal(typeof e.name, 'string', `bad name: ${JSON.stringify(e)}`);
        assert.ok(e.name.length > 0, `empty name: ${JSON.stringify(e)}`);
        assert.equal(typeof e.category, 'string');
        assert.equal(typeof e.equipment, 'string');
    }
});

test('exercises-db.json: ids are unique', () => {
    const ids = new Set();
    for (const e of data) {
        assert.ok(!ids.has(e.id), `duplicate id: ${e.id}`);
        ids.add(e.id);
    }
});

test('exercises-db.json: categories are normalized lowercase-hyphenated', () => {
    for (const e of data) {
        assert.equal(e.category, e.category.toLowerCase(),
            `category not lowercase: ${e.category} on ${e.name}`);
    }
});

test('exercises-db.json: muscleGroup values are normalized lowercase-hyphenated', () => {
    for (const e of data) {
        if (!e.muscleGroup) continue;
        assert.equal(e.muscleGroup, e.muscleGroup.toLowerCase(),
            `muscleGroup not lowercase: ${e.muscleGroup} on ${e.name}`);
    }
});

// One failed fetch used to memoize `[]` for the rest of the session, so a
// flaky first load left the catalog empty until a reload (2026-10-11 audit).
test('loadExerciseDatabase: a failed fetch is retried on the next call, not memoized', async () => {
    const realFetch = globalThis.fetch;
    const realError = console.error;
    console.error = () => {};
    let calls = 0;
    globalThis.fetch = async () => {
        calls += 1;
        if (calls === 1) return { ok: false, status: 503 };
        return { ok: true, json: async () => data };
    };
    try {
        const mod = await import(`../data/exercises-db.js?retry=${Date.now()}`);
        assert.deepEqual(await mod.loadExerciseDatabase(), [], 'the failed load resolves empty');
        const second = await mod.loadExerciseDatabase();
        assert.equal(calls, 2, 'the second call fetched again');
        assert.equal(second.length, data.length);
        assert.equal(mod.EXERCISE_DATABASE.length, data.length);
        await mod.loadExerciseDatabase();
        assert.equal(calls, 2, 'a successful load is memoized');
    } finally {
        globalThis.fetch = realFetch;
        console.error = realError;
    }
});
