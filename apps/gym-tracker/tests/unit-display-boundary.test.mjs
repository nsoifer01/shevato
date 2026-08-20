/**
 * The unit DISPLAY boundary, enforced at the source level.
 *
 * Storage is canonical kilograms. Every number a view puts on screen beside a
 * unit label must pass through `js/utils/units.js` first. History did; the
 * exercise detail did not, so a real 140 lb pulldown rendered as "63.503 lb" -
 * the stored kilograms with a pound label stapled on.
 *
 * That defect was invisible to every existing test because each screen was
 * only ever checked against itself. This suite reads the source instead and
 * fails on the SHAPE of the mistake, so a new renderer cannot reintroduce it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const VIEWS = join(HERE, '..', 'js', 'views');

/** Strip comments so prose about the bug is never mistaken for the bug. */
function codeOnly(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const viewFiles = readdirSync(VIEWS).filter(f => f.endsWith('.js'));

test('the views directory is actually being scanned', () => {
    assert.ok(viewFiles.length >= 8, `expected the view controllers, found ${viewFiles.length}`);
});

/**
 * A raw canonical weight interpolated immediately before a unit token.
 *
 * Two ways to be allowed, both of which make the unit legible AT THE CALL
 * SITE, which is the whole point:
 *   1. call a conversion - displayWeight / volumeIn / formatWeight /
 *      formatVolume / toSessionWeight / toDisplay;
 *   2. name the local with a `Shown` suffix, meaning "already through the
 *      display boundary, in `unit`" (e.g. `bestWeightShown`, `loadShown`).
 */
const CONVERTED = 'displayWeight|volumeIn|formatWeight|formatVolume|toSessionWeight|toDisplay';
const RAW_BESIDE_UNIT = new RegExp(
    String.raw`\$\{(?![^}]*(?:${CONVERTED}))`
    + String.raw`[^}]*(?:\.weight|bestWeight|maxWeight|bestE1rm|\.e1rm)(?!Shown)[^}]*\}`
    + String.raw`\s*\$?\{?\s*(?:unit|weightUnit)\b`,
    'g',
);

for (const file of viewFiles) {
    test(`${file} never prints a stored weight without converting it`, () => {
        const src = codeOnly(readFileSync(join(VIEWS, file), 'utf8'));
        const hits = [...src.matchAll(RAW_BESIDE_UNIT)].map(m => m[0].replace(/\s+/g, ' '));
        assert.deepEqual(hits, [],
            `${file} interpolates a canonical-kg weight next to a unit label. `
            + 'Wrap it in displayWeight() / volumeIn() the way history-view.js does.');
    });
}

test('exercises-view imports the display boundary at all', () => {
    // The regression existed because this file simply never imported units.js.
    const src = readFileSync(join(VIEWS, 'exercises-view.js'), 'utf8');
    assert.match(src, /from '\.\.\/utils\/units\.js'/,
        'the exercise detail renders weights and must convert them');
    assert.match(src, /displayWeight/);
    assert.match(src, /volumeIn/);
});

test('history-view and exercises-view use the SAME conversion helpers', () => {
    // The two screens disagreeing is the user-visible symptom; the structural
    // cause is one of them not calling the shared boundary.
    const hist = readFileSync(join(VIEWS, 'history-view.js'), 'utf8');
    const exd = readFileSync(join(VIEWS, 'exercises-view.js'), 'utf8');
    for (const helper of ['displayWeight', 'volumeIn']) {
        assert.ok(hist.includes(helper) && exd.includes(helper),
            `${helper} must be used by both screens, not just one`);
    }
});

test('no view reimplements the pound conversion by hand', () => {
    // A local 2.20462 / 0.45359237 is how the two screens drift apart again.
    for (const file of viewFiles) {
        const src = codeOnly(readFileSync(join(VIEWS, file), 'utf8'));
        assert.doesNotMatch(src, /2\.20462|0\.45359237/,
            `${file} hard-codes a conversion factor; use utils/units.js`);
    }
});
