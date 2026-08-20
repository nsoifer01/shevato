/**
 * One-time migrations of STORED data.
 *
 * This is the only module allowed to rewrite numbers a user already logged,
 * so everything here is written to be conservative, idempotent and
 * version-guarded: it runs once per install, records the schema version it
 * reached, and is a no-op on every later boot.
 *
 * ## v1 - canonical units (GT-03)
 *
 * Before this, a weight was stored as a bare number whose meaning was
 * "whatever `settings.weightUnit` happens to say right now". Switching the
 * setting to Pounds therefore relabelled a 60 kg bench as "60 lb", turned a
 * 13,345 kg session into "13,345 lb", and printed an 86.5 cm waist as
 * "86.5 in" - every historical number silently wrong by 2.2x, and the CSV
 * export shipped those numbers to spreadsheets.
 *
 * The fix is to make storage canonical (kg / cm) and convert only at the
 * display and entry boundaries. Getting there safely means reading the
 * numbers exactly the way the user has been reading them: whatever unit the
 * account is set to AT MIGRATION TIME is the unit those numbers were in. A
 * kg account (the default) is a pure no-op - not one number changes. An lb
 * account has its stored numbers converted once, and every screen keeps
 * showing the same pounds it showed before.
 *
 * Conversion is EXACT (utils/units.js does no rounding), so an lb user's
 * 135 lb becomes 61.23497 kg and renders back as exactly 135 lb.
 *
 * Deliberately NOT converted:
 *   - `prWeightKg` on strength-PR achievements, which was already canonical
 *     kg. Converting it would double-convert.
 *   - Plate stacks and bar weights, which describe physical equipment rather
 *     than a lifted load. They move into the per-unit profile they already
 *     belonged to (see Settings.normalizePlateProfiles).
 *   - Warm-up thresholds, which already carry separate kg and lb fields.
 *
 * ## v2 - empty-session cleanup (GT-14)
 *
 * "Remove logged history" for an exercise could strip the last completed set
 * out of a session and leave a `0 kg / 0 sets` husk that still counted as a
 * workout in the weekly tile, the streak, the calendar and the monthly
 * total. A session with no completed sets records nothing (finishing a
 * workout requires at least one), so these are dropped.
 */
import { toCanonicalWeight, toCanonicalLength, normalizeWeightUnit, lengthUnitFor } from './units.js';
import { isLoggedSession } from './session-metrics.js';

/** Bump when a new migration step is added below. */
export const DATA_SCHEMA_VERSION = 2;

/** Measurement fields that hold a circumference (canonical cm). */
export const LENGTH_FIELDS = ['chest', 'waist', 'hips', 'armLeft', 'armRight', 'thighLeft', 'thighRight'];

/**
 * Migrate a full data snapshot. Pure: takes and returns plain data, touches
 * no storage, so it is directly testable and can also be applied to an
 * imported payload.
 *
 * @param {object} snapshot { sessions, measurements, activeWorkout, goals, settings }
 * @param {number} fromVersion the stored DATA_SCHEMA_VERSION (0 = never run)
 * @returns {{ sessions, measurements, activeWorkout, goals, settings, version, changed }}
 */
export function migrateStoredData(snapshot = {}, fromVersion = 0) {
    const sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
    const measurements = Array.isArray(snapshot.measurements) ? snapshot.measurements : [];
    const settings = snapshot.settings && typeof snapshot.settings === 'object'
        ? snapshot.settings : {};

    let version = Number.isFinite(Number(fromVersion)) ? Number(fromVersion) : 0;
    const startVersion = version;
    let outSessions = sessions;
    let outMeasurements = measurements;
    let outActive = snapshot.activeWorkout || null;
    let outGoals = snapshot.goals || null;

    if (version < 1) {
        const accountUnit = normalizeWeightUnit(settings.weightUnit);
        const accountLength = lengthUnitFor(accountUnit);
        outSessions = sessions.map(session => convertSessionToCanonical(session, accountUnit));
        outMeasurements = measurements.map(m => convertMeasurementToCanonical(m, accountUnit, accountLength));
        // An interrupted workout is live data too: its sets and its sticky
        // planned-row values must move with everything else, or resuming
        // after the upgrade would show pounds labelled as kilos.
        outActive = outActive ? convertSessionToCanonical(outActive, accountUnit) : outActive;
        outGoals = migrateMeasurementGoals(outGoals, accountUnit);
        version = 1;
    }

    if (version < 2) {
        outSessions = outSessions.filter(isLoggedSession);
        version = 2;
    }

    return {
        sessions: outSessions,
        measurements: outMeasurements,
        activeWorkout: outActive,
        goals: outGoals,
        settings,
        version,
        changed: version !== startVersion,
    };
}

/**
 * Rewrite one session's set weights into kg and stamp the unit it was
 * entered in. Returns a NEW object; the input is never mutated.
 */
function convertSessionToCanonical(session, accountUnit) {
    if (!session || typeof session !== 'object') return session;
    const out = { ...session };
    out.sessionUnit = session.sessionUnit === 'kg' || session.sessionUnit === 'lb'
        ? session.sessionUnit
        : accountUnit;
    // A session whose entry unit was already recorded was stored in the
    // ACCOUNT unit regardless (that was the old model's canonical form), so
    // the account unit is what every session converts from.
    out.exercises = (session.exercises || []).map(ex => ({
        ...ex,
        sets: (ex?.sets || []).map(set => ({
            ...set,
            weight: accountUnit === 'kg'
                ? (set?.weight || 0)
                : (toCanonicalWeight(set?.weight || 0, accountUnit) ?? 0),
        })),
        stickyValues: convertStickyValues(ex?.stickyValues, accountUnit),
    }));
    return out;
}

/** Sticky planned-row values carry weights too (paused workouts hold these). */
function convertStickyValues(sticky, accountUnit) {
    if (!sticky || typeof sticky !== 'object') return sticky;
    if (accountUnit === 'kg') return sticky;
    const out = {};
    Object.keys(sticky).forEach((slot) => {
        const entry = sticky[slot];
        if (!entry || typeof entry !== 'object') { out[slot] = entry; return; }
        out[slot] = {
            ...entry,
            weight: entry.weight === '' || entry.weight === null || entry.weight === undefined
                ? entry.weight
                : (toCanonicalWeight(entry.weight, accountUnit) ?? entry.weight),
        };
    });
    return out;
}

/** Body weight → kg, circumferences → cm. Body-fat % is unitless. */
function convertMeasurementToCanonical(measurement, accountUnit, accountLength) {
    if (!measurement || typeof measurement !== 'object') return measurement;
    const out = { ...measurement };
    if (accountUnit !== 'kg' && out.weight !== null && out.weight !== undefined && out.weight !== '') {
        out.weight = toCanonicalWeight(out.weight, accountUnit);
    }
    if (accountLength !== 'cm') {
        LENGTH_FIELDS.forEach((field) => {
            const v = out[field];
            if (v === null || v === undefined || v === '') return;
            out[field] = toCanonicalLength(v, accountLength);
        });
    }
    return out;
}

/**
 * Measurement goal targets are entered and stored in the display unit the
 * user typed them in, so they migrate the same way as the measurements they
 * are compared against.
 */
export function migrateMeasurementGoals(goals, accountUnit) {
    if (!goals || typeof goals !== 'object') return goals;
    const unit = normalizeWeightUnit(accountUnit);
    const lengthUnit = lengthUnitFor(unit);
    if (unit === 'kg') return goals; // cm goals are already canonical too
    const out = {};
    Object.keys(goals).forEach((key) => {
        const goal = goals[key];
        if (!goal || typeof goal !== 'object' || goal.target === null || goal.target === undefined) {
            out[key] = goal;
            return;
        }
        let target = goal.target;
        if (key === 'weight') target = toCanonicalWeight(target, unit);
        else if (LENGTH_FIELDS.includes(key)) target = toCanonicalLength(target, lengthUnit);
        out[key] = { ...goal, target };
    });
    return out;
}
