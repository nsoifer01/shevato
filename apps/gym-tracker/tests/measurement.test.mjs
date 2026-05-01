process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Minimal localStorage stub — Measurement constructor pulls
// generateNumericId from helpers.js, which doesn't touch storage.
globalThis.window = globalThis.window || {};
globalThis.localStorage = globalThis.localStorage || {
    _s: new Map(),
    getItem(k) { return this._s.has(k) ? this._s.get(k) : null; },
    setItem(k, v) { this._s.set(k, String(v)); },
    removeItem(k) { this._s.delete(k); },
};

const { Measurement } = await import('../js/models/Measurement.js');

test('Measurement: empty fields collapse to null, not 0', () => {
    const m = new Measurement({ date: '2026-04-24', weight: '', chest: undefined });
    assert.equal(m.weight, null);
    assert.equal(m.chest, null);
});

test('Measurement: numeric strings are parsed', () => {
    const m = new Measurement({ date: '2026-04-24', weight: '82.5', waist: '90' });
    assert.equal(m.weight, 82.5);
    assert.equal(m.waist, 90);
});

test('Measurement: non-numeric junk falls back to null', () => {
    const m = new Measurement({ date: '2026-04-24', weight: 'twelve' });
    assert.equal(m.weight, null);
});

test('Measurement: id is auto-generated when omitted, finite numeric', () => {
    const m = new Measurement({ date: '2026-04-24', weight: 80 });
    assert.ok(Number.isFinite(m.id));
    assert.ok(m.id > 0);
});

test('Measurement: round-trips through toJSON / fromJSON', () => {
    const original = new Measurement({
        date: '2026-04-24',
        weight: 82.5,
        bodyFat: 17.2,
        chest: 100,
        notes: 'felt strong',
    });
    const restored = Measurement.fromJSON(original.toJSON());
    assert.deepEqual(restored.toJSON(), original.toJSON());
});

test('Measurement: defaults date to today when missing', () => {
    const m = new Measurement({ weight: 80 });
    assert.match(m.date, /^\d{4}-\d{2}-\d{2}$/);
});

test('Measurement: notes default to empty string', () => {
    const m = new Measurement({});
    assert.equal(m.notes, '');
});

test('Measurement: photos default to empty array', () => {
    const m = new Measurement({});
    assert.deepEqual(m.photos, []);
});

test('Measurement: photos round-trip via toJSON/fromJSON', () => {
    const original = new Measurement({
        date: '2026-04-24',
        weight: 80,
        photos: ['https://example.com/a.jpg', 'https://example.com/b.jpg'],
    });
    const restored = Measurement.fromJSON(original.toJSON());
    assert.deepEqual(restored.photos, original.photos);
});

test('Measurement: photos must be an array — non-array input collapses to []', () => {
    const m = new Measurement({ date: '2026-04-24', photos: 'not an array' });
    assert.deepEqual(m.photos, []);
});

test('Measurement: id stays numeric after Number() coercion (string ids are accepted)', () => {
    const m = new Measurement({ id: '12345', date: '2026-04-24', weight: 80 });
    assert.equal(typeof m.id, 'number');
    assert.equal(m.id, 12345);
});
