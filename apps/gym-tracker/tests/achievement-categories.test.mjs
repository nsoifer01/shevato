// Achievement group headings and unit-aware text (GT-29, GT-03).
//
// GT-29: the Achievements screen rendered `<h2>lift-milestone</h2>` with an
// empty `<p></p>` - a raw requirement slug shown to a user, sitting among
// properly titled groups ("Total Workouts", "Workout Streaks").
//
// GT-03: volume milestones are DEFINED in kilograms ("Lift 1,000kg total
// volume"). The old localisation swapped the "kg" suffix for "lb" and left the
// number alone, which is the same relabel-without-converting mistake, three
// orders of magnitude out on the bigger tiers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMethods, loadSource } from './helpers/source-extract.mjs';
import { AchievementService } from '../js/services/AchievementService.js';
import { normalizeWeightUnit, volumeIn } from '../js/utils/units.js';

const src = loadSource('js/views/achievements-view.js');

/** The CATEGORY_META keys the view knows how to title. */
function knownCategories() {
    const block = src.slice(src.indexOf('const CATEGORY_META'), src.indexOf('const CATEGORY_ORDER'));
    return [...block.matchAll(/'([a-z-]+)':\s*\{/g)].map(m => m[1]);
}

test('every requirement type the app can PRODUCE has a human title', () => {
    const known = new Set(knownCategories());
    const produced = new Set(
        AchievementService.getDefaultAchievements().map(a => a.requirement.type),
    );
    // Lift milestones are created in app.js rather than by getDefaultAchievements.
    produced.add('lift-milestone');
    // Strength PRs render in their own section, outside the category machinery.
    produced.delete('strength-pr');

    const missing = [...produced].filter(t => !known.has(t));
    assert.deepEqual(missing, [], 'an untitled group renders its raw slug as a heading');
});

test('lift-milestone in particular has a title and a description', () => {
    const block = src.slice(src.indexOf('const CATEGORY_META'), src.indexOf('const CATEGORY_ORDER'));
    assert.match(block, /'lift-milestone':\s*\{[^}]*name: 'Lift Milestones'/);
    assert.match(block, /'lift-milestone':\s*\{[^}]*desc: '[^']+'/, 'and not an empty paragraph');
});

test('the new weekly-distinct-days group is titled too', () => {
    assert.ok(knownCategories().includes('weekly-distinct-days'));
});

test('an UNKNOWN type still gets a readable heading rather than its slug', () => {
    const { humanizeCategoryKey } = new Function(
        `"use strict"; ${src.slice(src.indexOf('function humanizeCategoryKey'), src.indexOf('class AchievementsView'))}
         return { humanizeCategoryKey };`,
    )();
    assert.equal(humanizeCategoryKey('lift-milestone'), 'Lift Milestone');
    assert.equal(humanizeCategoryKey('some_new_type'), 'Some New Type');
    assert.equal(humanizeCategoryKey(''), 'Other');
});

test('an empty description renders no paragraph at all', () => {
    assert.match(src, /\$\{meta\.desc \? `<p>\$\{meta\.desc\}<\/p>` : ''\}/);
});

// ---------------------------------------------------------------------------
// GT-03: volume milestones convert, they do not relabel
// ---------------------------------------------------------------------------

function unitView(unit) {
    const methods = buildMethods(src, ['localizeUnit'], { volumeIn, normalizeWeightUnit }, 'achievements-view.js');
    const view = Object.create(methods);
    Object.defineProperty(view, 'weightUnit', { value: normalizeWeightUnit(unit) });
    return view;
}

test('a kg account sees the milestone text untouched', () => {
    assert.equal(unitView('kg').localizeUnit('Lift 1,000kg total volume'), 'Lift 1,000kg total volume');
});

test('an lb account sees a CONVERTED number, not a relabelled one', () => {
    const out = unitView('lb').localizeUnit('Lift 1,000kg total volume');
    assert.doesNotMatch(out, /1,000\s*lb/, '1,000 kg is not 1,000 lb');
    assert.match(out, /2,205lb/);
});

test('the biggest tier converts too, where the error was largest', () => {
    const out = unitView('lb').localizeUnit('Lift 1,000,000kg total volume');
    assert.match(out, /2,204,623lb/);
});

test('a per-workout volume milestone converts the same way', () => {
    assert.match(unitView('lb').localizeUnit('Reach 500kg total volume in one workout'), /1,102lb/);
});

test('text with no kg figure is passed through unchanged', () => {
    const text = 'Workout 3 days in a row';
    assert.equal(unitView('lb').localizeUnit(text), text);
});

test('the Strength PR card follows the CURRENT unit, not the one stored with it', () => {
    // The card kept showing "65 kg" while History next to it showed lb.
    assert.match(src, /const unit = this\.weightUnit;\s*\n\s*const rows = prs\.map/);
    assert.doesNotMatch(src, /a\.prUnit === 'lb' \? 'lb' : 'kg'/, 'the stored unit is metadata, not a rule');
});
