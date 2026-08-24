// Measurement entry validation (2026-08-22 audit D3 and D16).
//
// The form is `novalidate`, so the inputs' min/max were decorative: -5 kg,
// 150 % body fat, 1e7 kg and future dates were stored and drove the trend
// tiles ("-132 % vs 30d"). Two requestSubmit() calls before the modal closed
// also produced two records. Both `validateMeasurementEntry` and the submit
// handler are lifted from the REAL measurements-view.js source.
process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFunctions, buildMethods, loadSource } from './helpers/source-extract.mjs';

const src = loadSource('js/views/measurements-view.js');
const METRICS = [
    { key: 'weight', label: 'Body weight', kind: 'weight' },
    { key: 'bodyFat', label: 'Body fat %', kind: 'percent' },
    { key: 'chest', label: 'Chest', kind: 'length' },
];
const { validateMeasurementEntry } = buildFunctions(src, ['validateMeasurementEntry'], {
    METRICS,
    MEASUREMENT_LIMITS: { weight: { max: 700, unit: 'kg' }, bodyFat: { max: 100, unit: '%' }, length: { max: 500, unit: 'cm' } },
}, 'measurements-view.js');

const TODAY = '2026-08-22';

test('ranges: negative, over-limit and non-finite values are refused, normal ones pass', () => {
    assert.equal(validateMeasurementEntry({ date: TODAY, weight: 80 }, TODAY), null);
    assert.equal(validateMeasurementEntry({ date: TODAY, weight: 0, bodyFat: 100, chest: 500 }, TODAY), null, 'bounds inclusive');
    assert.equal(validateMeasurementEntry({ date: TODAY, weight: -5 }, TODAY)?.key, 'weight');
    assert.equal(validateMeasurementEntry({ date: TODAY, bodyFat: 150 }, TODAY)?.key, 'bodyFat');
    assert.equal(validateMeasurementEntry({ date: TODAY, weight: 1e7 }, TODAY)?.key, 'weight');
    assert.equal(validateMeasurementEntry({ date: TODAY, weight: NaN }, TODAY)?.key, 'weight');
    assert.equal(validateMeasurementEntry({ date: TODAY, chest: Infinity }, TODAY)?.key, 'chest');
    assert.equal(validateMeasurementEntry({ date: TODAY, weight: '', chest: 90 }, TODAY), null, 'empty fields are skipped');
});

test('dates: future and malformed dates are refused', () => {
    assert.equal(validateMeasurementEntry({ date: '2030-01-01', weight: 80 }, TODAY)?.key, 'date');
    assert.equal(validateMeasurementEntry({ date: '2026-02-29', weight: 80 }, TODAY)?.key, 'date', 'not a leap year');
    assert.equal(validateMeasurementEntry({ date: 'not-a-date', weight: 80 }, TODAY)?.key, 'date');
    assert.equal(validateMeasurementEntry({ date: '2024-02-29', weight: 80 }, TODAY), null, 'a real leap day in the past is fine');
});

/** Drive the real saveFromForm with a DOM stub; count records reaching the app. */
function makeHarness(values) {
    const els = {};
    const document = {
        getElementById(id) {
            if (!(id in values) && id !== 'measurement-modal' && id !== 'measurement-form') return null;
            if (!els[id]) {
                els[id] = {
                    value: values[id] ?? '', attrs: {}, classList: { add() {}, remove() {} },
                    setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; },
                    focus() { this.focused = true; }, querySelectorAll() { return []; },
                };
            }
            return els[id];
        },
    };
    const toasts = [];
    const proto = buildMethods(src, ['saveFromForm', '_saveFromFormNow', 'showEntryError', 'clearEntryError'], {
        document, METRICS, METRIC_INPUT_IDS: { weight: 'm-weight', bodyFat: 'm-bodyfat', chest: 'm-chest' },
        validateMeasurementEntry, getTodayDateString: () => TODAY,
        showToast: (m) => toasts.push(m), Measurement: class { constructor(d) { Object.assign(this, d); } },
    }, 'measurements-view.js');
    const view = Object.create(proto);
    const added = [];
    Object.assign(view, {
        editingId: null, app: { measurements: [], addMeasurement: (m) => added.push(m), saveMeasurements() {} },
        canonicalValue: (metric, v) => (v === '' ? '' : Number(v)), render() {},
    });
    return { view, added, toasts, els };
}

test('submit refuses out-of-range and future entries and flags the input', () => {
    for (const [vals, key] of [
        [{ 'm-date': TODAY, 'm-weight': '-5' }, 'm-weight'],
        [{ 'm-date': TODAY, 'm-bodyfat': '150' }, 'm-bodyfat'],
        [{ 'm-date': '2030-01-01', 'm-weight': '80' }, 'm-date'],
    ]) {
        const { view, added, els } = makeHarness({ 'm-notes': '', ...vals });
        view.saveFromForm();
        assert.equal(added.length, 0, `${JSON.stringify(vals)} stores nothing`);
        assert.equal(els[key].attrs['aria-invalid'], 'true', `${key} flagged`);
    }
});

test('submit stores a valid entry exactly once even when re-entered synchronously', () => {
    const { view, added } = makeHarness({ 'm-date': TODAY, 'm-weight': '80', 'm-notes': '' });
    // A second submit arriving while the first is still running (double tap
    // on a slow phone) must be ignored by the in-flight guard.
    const origAdd = view.app.addMeasurement;
    view.app.addMeasurement = (m) => { origAdd(m); view.saveFromForm(); };
    view.saveFromForm();
    assert.equal(added.length, 1);
    // ...and a second submit right after the first completed (two
    // requestSubmit calls back to back, the audit's repro) is ignored too.
    view.app.addMeasurement = origAdd;
    view.saveFromForm();
    assert.equal(added.length, 1);
});
