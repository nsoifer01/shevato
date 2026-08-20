/**
 * Unit semantics - ONE definition of what a stored number means.
 *
 * The rule the whole app follows:
 *
 *   STORED values are canonical: weights in KILOGRAMS, lengths in
 *   CENTIMETRES, durations in SECONDS. Nothing in localStorage, in an
 *   export, or in a sync payload is ever written in pounds or inches.
 *
 *   DISPLAY/ENTRY values are in the user's preferred unit
 *   (`settings.weightUnit`, plus the length unit that pairs with it), or
 *   during a workout in the session's own entry unit
 *   (`WorkoutSession.sessionUnit`, the in-workout kg|lbs toggle).
 *
 * Conversion therefore happens at exactly two boundaries: reading a value
 * out of an input (`toCanonicalWeight`) and writing one into the DOM
 * (`fromCanonicalWeight` / `formatWeight`). Everything in between (volume
 * sums, PR comparisons, progression, achievement thresholds) is
 * plain kg arithmetic and needs no unit awareness at all.
 *
 * Two precisions on purpose:
 *   - `toCanonicalWeight` / `fromCanonicalWeight` are EXACT (no rounding),
 *     so 135 lb → kg → lb comes back as exactly 135 rather than 134.9.
 *     Rounding on the way in is what makes repeated unit switching drift.
 *   - `roundForDisplay` rounds, and is applied only when a number is about
 *     to be shown.
 *
 * Legacy data (recorded before this model existed, in whatever unit the
 * account was set to at the time) is converted once by
 * `utils/data-migrations.js`, which is the only place allowed to rewrite
 * stored numbers.
 */

/** Exact international pound. Used in BOTH directions so round-trips close. */
export const KG_PER_LB = 0.45359237;
/** Exact inch in centimetres. */
export const CM_PER_IN = 2.54;

export const WEIGHT_UNITS = ['kg', 'lb'];
export const LENGTH_UNITS = ['cm', 'in'];

/** Coerce anything into a supported weight unit; unknown input means kg. */
export function normalizeWeightUnit(unit) {
    return unit === 'lb' ? 'lb' : 'kg';
}

/** Coerce anything into a supported length unit; unknown input means cm. */
export function normalizeLengthUnit(unit) {
    return unit === 'in' ? 'in' : 'cm';
}

/**
 * The length unit that pairs with a weight unit. Body measurements have no
 * separate preference: a lifter working in pounds measures in inches.
 */
export function lengthUnitFor(weightUnit) {
    return normalizeWeightUnit(weightUnit) === 'lb' ? 'in' : 'cm';
}

/** Numeric coercion that treats '' / null / undefined as "no value". */
function num(value) {
    if (value === '' || value === null || value === undefined) return NaN;
    const n = Number(value);
    return Number.isFinite(n) ? n : NaN;
}

/**
 * A display-unit weight → canonical kg, EXACT (no rounding).
 * Returns null when the input is not a number.
 */
export function toCanonicalWeight(value, fromUnit) {
    const n = num(value);
    if (!Number.isFinite(n)) return null;
    return normalizeWeightUnit(fromUnit) === 'lb' ? n * KG_PER_LB : n;
}

/**
 * Canonical kg → a display-unit weight, EXACT (no rounding). Round with
 * `roundForDisplay` (or use `formatWeight`) before showing it.
 */
export function fromCanonicalWeight(kg, toUnit) {
    const n = num(kg);
    if (!Number.isFinite(n)) return null;
    return normalizeWeightUnit(toUnit) === 'lb' ? n / KG_PER_LB : n;
}

/** A display-unit length → canonical cm, EXACT. */
export function toCanonicalLength(value, fromUnit) {
    const n = num(value);
    if (!Number.isFinite(n)) return null;
    return normalizeLengthUnit(fromUnit) === 'in' ? n * CM_PER_IN : n;
}

/** Canonical cm → a display-unit length, EXACT. */
export function fromCanonicalLength(cm, toUnit) {
    const n = num(cm);
    if (!Number.isFinite(n)) return null;
    return normalizeLengthUnit(toUnit) === 'in' ? n / CM_PER_IN : n;
}

/**
 * Round a value for display. One decimal by default, and a trailing `.0`
 * is dropped so 60 kg reads "60" rather than "60.0".
 */
export function roundForDisplay(value, decimals = 1) {
    const n = num(value);
    if (!Number.isFinite(n)) return null;
    const f = 10 ** decimals;
    return Math.round(n * f) / f;
}

/**
 * Canonical kg → a rounded number in `unit`, ready to put in an input or a
 * label. Returns '' for missing input so it can be assigned straight to
 * `input.value`.
 */
export function displayWeight(kg, unit, decimals = 1) {
    const converted = fromCanonicalWeight(kg, unit);
    if (converted === null) return '';
    return roundForDisplay(converted, decimals);
}

/** Canonical cm → a rounded number in `unit`. '' for missing input. */
export function displayLength(cm, unit, decimals = 1) {
    const converted = fromCanonicalLength(cm, unit);
    if (converted === null) return '';
    return roundForDisplay(converted, decimals);
}

/**
 * "132.3 lb" - a canonical kg rendered with its unit. `space` controls
 * whether the unit is separated from the number (history rows are tight,
 * summary cards are not).
 */
export function formatWeight(kg, unit, { decimals = 1, space = false } = {}) {
    const shown = displayWeight(kg, unit, decimals);
    if (shown === '') return '';
    return `${shown}${space ? ' ' : ''}${normalizeWeightUnit(unit)}`;
}

/**
 * A volume (Σ weight × reps, canonical kg·reps) rendered in the display
 * unit with thousands separators: "29,420 lb".
 *
 * Volume is linear in weight, so the same factor converts the total.
 */
export function formatVolume(kgVolume, unit, { space = true } = {}) {
    const converted = fromCanonicalWeight(kgVolume, unit);
    if (converted === null) return '';
    return `${Math.round(converted).toLocaleString()}${space ? ' ' : ''}${normalizeWeightUnit(unit)}`;
}

/** Canonical kg·reps volume → the display unit, unrounded. 0 for bad input. */
export function volumeIn(kgVolume, unit) {
    const converted = fromCanonicalWeight(kgVolume, unit);
    return converted === null ? 0 : converted;
}

/**
 * Seconds → "1:05" / "12:00". Used everywhere a duration is shown as a
 * duration (timed sets, time under tension, rest), so seconds are never
 * rendered next to a weight unit (GT-04).
 */
export function formatDuration(totalSeconds) {
    const s = Math.max(0, Math.round(Number(totalSeconds) || 0));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${String(r).padStart(2, '0')}`;
}

/**
 * Seconds → a compact human total for summary tiles: "45s", "3m 20s",
 * "1h 02m". Distinct from `formatDuration`, which is the clock-style form
 * used on a single set.
 */
export function formatDurationLong(totalSeconds) {
    const s = Math.max(0, Math.round(Number(totalSeconds) || 0));
    if (s < 60) return `${s}s`;
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
    return r === 0 ? `${m}m` : `${m}m ${r}s`;
}
