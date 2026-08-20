/**
 * Exercise taxonomy - the single definition of the category and equipment
 * vocabularies.
 *
 * These lists used to be duplicated as hand-written `<option>` blocks in
 * index.html: the browse filter offered 17 categories while the
 * create-custom-exercise form offered 10, so a user could not file a custom
 * glute, ab, oblique, trap, neck, forearm or cardio exercise under the
 * category they would then filter by (GT-26). Both selects are now populated
 * from here, so the two can no longer drift.
 *
 * CATEGORIES is derived-by-hand from `data/exercises-db.json` and pinned by
 * `tests/exercise-taxonomy.test.mjs`, which fails if the catalog ever grows a
 * category this file does not know about.
 */

/** Every browsable category, in the order the filters present them. */
export const EXERCISE_CATEGORIES = [
    { value: 'chest', label: 'Chest' },
    { value: 'back', label: 'Back' },
    { value: 'shoulders', label: 'Shoulders' },
    { value: 'biceps', label: 'Biceps' },
    { value: 'triceps', label: 'Triceps' },
    { value: 'forearms', label: 'Forearms' },
    { value: 'quads', label: 'Quads' },
    { value: 'hamstrings', label: 'Hamstrings' },
    { value: 'glutes', label: 'Glutes' },
    { value: 'calves', label: 'Calves' },
    { value: 'core', label: 'Core' },
    { value: 'abs', label: 'Abs' },
    { value: 'obliques', label: 'Obliques' },
    { value: 'traps', label: 'Traps' },
    { value: 'neck', label: 'Neck' },
    { value: 'full-body', label: 'Full Body' },
    { value: 'cardio', label: 'Cardio' },
];

/** Every equipment value, in the order the filters present them. */
export const EXERCISE_EQUIPMENT = [
    { value: 'barbell', label: 'Barbell' },
    { value: 'dumbbell', label: 'Dumbbell' },
    { value: 'cable', label: 'Cable' },
    { value: 'machine', label: 'Machine' },
    { value: 'bodyweight', label: 'Bodyweight' },
    { value: 'kettlebell', label: 'Kettlebell' },
    { value: 'resistance-band', label: 'Resistance Band' },
    { value: 'plate', label: 'Plate' },
    { value: 'trap-bar', label: 'Trap Bar' },
    { value: 'medicine-ball', label: 'Medicine Ball' },
    { value: 'battle-ropes', label: 'Battle Ropes' },
    { value: 'ab-wheel', label: 'Ab Wheel' },
    { value: 'sled', label: 'Sled' },
    { value: 'tire', label: 'Tire' },
    { value: 'gripper', label: 'Gripper' },
    { value: 'towel', label: 'Towel' },
    { value: 'various', label: 'Various' },
];

/** Longest name a user may give a custom exercise (GT-39). */
export const CUSTOM_EXERCISE_NAME_MAX = 60;

export const CATEGORY_VALUES = EXERCISE_CATEGORIES.map(c => c.value);
export const EQUIPMENT_VALUES = EXERCISE_EQUIPMENT.map(e => e.value);

/** Human label for a raw category value; falls back to a title-cased form. */
export function categoryLabel(value) {
    const hit = EXERCISE_CATEGORIES.find(c => c.value === value);
    if (hit) return hit.label;
    return String(value || '')
        .replace(/[-_]+/g, ' ')
        .trim()
        .replace(/\b\w/g, c => c.toUpperCase());
}

/** Human label for a raw equipment value. */
export function equipmentLabel(value) {
    const hit = EXERCISE_EQUIPMENT.find(e => e.value === value);
    if (hit) return hit.label;
    return String(value || '')
        .replace(/[-_]+/g, ' ')
        .trim()
        .replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Replace a `<select>`'s options with `items`, keeping the current value when
 * it still exists. `placeholder` becomes the first (empty-value) option.
 *
 * Written to be idempotent: the selects are populated on every view init and
 * re-running must not duplicate options or lose the user's selection.
 */
export function populateSelect(select, items, placeholder) {
    if (!select) return;
    const previous = select.value;
    const options = [];
    if (placeholder != null) {
        options.push(`<option value="">${placeholder}</option>`);
    }
    items.forEach(({ value, label }) => {
        options.push(`<option value="${value}">${label}</option>`);
    });
    select.innerHTML = options.join('');
    if (previous && select.querySelector(`option[value="${CSS_escape(previous)}"]`)) {
        select.value = previous;
    }
}

/** Minimal attribute-selector escape - category/equipment values are slugs. */
function CSS_escape(value) {
    return String(value).replace(/["\\]/g, '\\$&');
}
