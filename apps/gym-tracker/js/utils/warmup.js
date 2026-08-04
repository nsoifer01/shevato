/**
 * Warm-up ramp helpers (Item 6, runtime half) - pure.
 *
 * Heavy barbell work wants a ramp, not a cold first working set. The strip is
 * driven by `gymTrackerWarmupSettings` in localStorage (written by Settings):
 *
 *   { enabled: true, thresholdKg: 40, thresholdLb: 90,
 *     ramp: [{ pct: 0, reps: 8 }, { pct: 50, reps: 5 }, { pct: 75, reps: 3 }] }
 *
 * `pct: 0` means the empty bar. Absent or partial JSON falls back to exactly
 * those defaults, field by field.
 *
 * Warm-up rows are NEVER Sets: they are not pushed into
 * WorkoutExercise.sets, so they cannot reach totalVolume, targetSets
 * completion, or the PR check by construction.
 */

export const WARMUP_DEFAULTS = Object.freeze({
    enabled: true,
    thresholdKg: 40,
    thresholdLb: 90,
    ramp: Object.freeze([
        Object.freeze({ pct: 0, reps: 8 }),
        Object.freeze({ pct: 50, reps: 5 }),
        Object.freeze({ pct: 75, reps: 3 }),
    ]),
});

const WARMUP_EQUIPMENT = new Set(['barbell', 'trap-bar']);

function positiveNumber(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

function defaultRamp() {
    return WARMUP_DEFAULTS.ramp.map(step => ({ pct: step.pct, reps: step.reps }));
}

/**
 * Normalize whatever is in localStorage into a complete settings object.
 * Accepts the raw string, a parsed object, or null/garbage.
 */
export function normalizeWarmupSettings(raw) {
    let data = raw;
    if (typeof data === 'string') {
        try {
            data = JSON.parse(data);
        } catch {
            data = null;
        }
    }
    if (!data || typeof data !== 'object') {
        return { ...WARMUP_DEFAULTS, ramp: defaultRamp() };
    }

    const ramp = Array.isArray(data.ramp)
        ? data.ramp
            .map(step => ({
                pct: Number(step?.pct),
                reps: Number(step?.reps),
            }))
            .filter(step => Number.isFinite(step.pct) && step.pct >= 0
                && Number.isFinite(step.reps) && step.reps > 0)
        : [];

    return {
        enabled: typeof data.enabled === 'boolean' ? data.enabled : WARMUP_DEFAULTS.enabled,
        thresholdKg: positiveNumber(data.thresholdKg, WARMUP_DEFAULTS.thresholdKg),
        thresholdLb: positiveNumber(data.thresholdLb, WARMUP_DEFAULTS.thresholdLb),
        ramp: ramp.length > 0 ? ramp : defaultRamp(),
    };
}

/** Threshold for the unit the session is displayed in. */
export function warmupThreshold(settings, unit) {
    return unit === 'lb' ? settings.thresholdLb : settings.thresholdKg;
}

/**
 * Whether the warm-up strip applies. Barbell / trap-bar only, never for
 * duration work, and only once the working weight reaches the threshold.
 */
export function shouldShowWarmup({ settings, unit, equipment, isDuration, workingWeight }) {
    if (!settings || !settings.enabled) return false;
    if (isDuration) return false;
    if (!WARMUP_EQUIPMENT.has(equipment)) return false;
    const weight = Number(workingWeight);
    if (!Number.isFinite(weight) || weight <= 0) return false;
    return weight >= warmupThreshold(settings, unit);
}

/**
 * Build the ramp rows for a working weight. `roundWeight` snaps a target to a
 * loadable weight (plate-calculator config); percentage rows that round to at
 * or below the bar, or to the working weight itself, add nothing and are
 * dropped.
 *
 * @returns {Array<{pct:number, reps:number, weight:number, isBar:boolean}>}
 */
export function buildWarmupRamp({ settings, workingWeight, barWeight = 0, roundWeight = (w) => w }) {
    if (!settings) return [];
    const working = Number(workingWeight);
    const bar = Number(barWeight) || 0;
    const rows = [];
    for (const step of settings.ramp) {
        if (step.pct === 0) {
            if (bar > 0) rows.push({ pct: 0, reps: step.reps, weight: bar, isBar: true });
            continue;
        }
        const weight = roundWeight((working * step.pct) / 100);
        if (!Number.isFinite(weight) || weight <= bar || weight >= working) continue;
        rows.push({ pct: step.pct, reps: step.reps, weight, isBar: false });
    }
    return rows;
}
