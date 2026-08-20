/**
 * One-time migrations of STORED data, plus a re-entrant unit-provenance
 * reconciler.
 *
 * This is the only module allowed to rewrite numbers a user already logged.
 *
 * ## Why the version marker alone was not enough (the 143.3 lb bug)
 *
 * v1 (below) converts an lb account's stored numbers into canonical kg once,
 * and records `gymTrackerDataVersion` so it never runs twice. That is correct
 * for data that is already in localStorage when the app boots - and only for
 * that data.
 *
 * It is NOT correct in the presence of sync. `app.init()` runs on
 * DOMContentLoaded; the Firestore snapshot lands hundreds of milliseconds
 * later, and `storage-sync-robust.js` rebuilds its `localRevisions` map empty
 * on every page load, so `decideRemoteChange()` takes the `if (!localRev)
 * return 'apply'` branch and writes the remote document over localStorage
 * unconditionally. If that document still holds PRE-migration values (because
 * it was last written by an older build), the freshly converted numbers are
 * replaced by legacy ones while the version marker stays at its migrated
 * value. Nothing ever re-checks them:
 *
 *     boot      -> 65 lb becomes 29.4835 kg, version := 2
 *     snapshot  -> localStorage.gymTrackerSessions := the legacy doc (65)
 *     reload    -> version is 2, so v1 is skipped; 65 is now read as 65 KG
 *     display   -> 65 kg rendered in pounds = 143.3 lb
 *
 * A per-install marker cannot describe "these particular records are
 * canonical", because records arrive from a channel the marker knows nothing
 * about. So canonical-ness is now a property OF THE RECORD:
 *
 *   - Every session and measurement the app writes carries `unitsCanonical:
 *     true` (see CANONICAL_FLAG).
 *   - No conversion step will ever touch a record carrying that flag, so
 *     ordering, repeated boots, sync arrival and repeated Settings scans are
 *     all no-ops by construction rather than by guard.
 *   - `reconcileUnits()` is therefore safe to run on every boot, after every
 *     remote sync, and on demand from Settings.
 *
 * ## What can and cannot be proven
 *
 * SESSIONS carry a discriminator by luck: v1 stamps `sessionUnit` on every
 * session it converts (legacy sessions stored `null` unless the lifter used
 * the in-workout toggle), and every session created since the remediation
 * sets it at creation. So in an install that claims v>=1, a session with NO
 * `sessionUnit` provably never went through v1 - it is legacy, and repairing
 * it is deterministic.
 *
 * MEASUREMENTS carry nothing. v1 rewrote `weight` / `waist` / ... in place and
 * left no trace, so a stored `34` is either legacy inches or migrated
 * centimetres and the record cannot tell you which. We therefore DO NOT guess
 * (a plausibility test on body dimensions would be another silent
 * heuristic): the ambiguous case is surfaced to the user, who confirms the
 * original units once. See `measurementProvenance()` and
 * `MEASUREMENT_UNITS_*`.
 *
 * ## Version history
 *
 * v1 - canonical units. A weight used to be a bare number meaning "whatever
 *      `settings.weightUnit` says right now", so switching to Pounds
 *      relabelled a 60 kg bench as "60 lb". Storage became canonical kg/cm,
 *      converted only at the display and entry boundaries. A kg account is a
 *      pure no-op; an lb account converts exactly once.
 *
 * v2 - empty-session cleanup. "Remove logged history" could leave a
 *      `0 kg / 0 sets` husk that still counted as a workout.
 *
 * v3 - unit provenance. Stamps every record whose state can be proven,
 *      repairs sessions damaged by the sync race described above, and flags
 *      measurements whose original units only the user can confirm.
 *
 * Deliberately NOT converted, in any version:
 *   - `prWeightKg` on strength-PR achievements, already canonical kg.
 *   - Plate stacks and bar weights, which describe physical equipment and
 *     keep independent per-unit profiles (Settings.normalizePlateProfiles).
 *   - Warm-up thresholds, which already carry separate kg and lb fields.
 */
import { toCanonicalWeight, toCanonicalLength, normalizeWeightUnit, lengthUnitFor } from './units.js';
import { isLoggedSession } from './session-metrics.js';

/** Bump when a new migration step is added below. */
export const DATA_SCHEMA_VERSION = 3;

/**
 * Per-record provenance stamp. A record carrying `true` holds canonical
 * kg/cm and is NEVER converted again, by any code path, ever.
 */
export const CANONICAL_FLAG = 'unitsCanonical';

/** Measurement fields that hold a circumference (canonical cm). */
export const LENGTH_FIELDS = ['chest', 'waist', 'hips', 'armLeft', 'armRight', 'thighLeft', 'thighRight'];

/** Resolution states for the measurement-units question. */
export const MEASUREMENT_UNITS_UNRESOLVED = 'unresolved';
export const MEASUREMENT_UNITS_RESOLVED = 'resolved';

/** What the user can answer when asked which units their measurements were in. */
export const MEASUREMENT_CHOICE_IMPERIAL = 'imperial';
export const MEASUREMENT_CHOICE_METRIC = 'metric';
export const MEASUREMENT_CHOICE_LATER = 'later';

/** Provenance verdicts. */
export const CANONICAL = 'canonical';
export const LEGACY = 'legacy';
export const AMBIGUOUS = 'ambiguous';

/** True when a record has been proven canonical and must never be converted. */
export function isCanonicalRecord(record) {
    return !!(record && typeof record === 'object' && record[CANONICAL_FLAG] === true);
}

/** Return a copy of `record` marked canonical. Never mutates the input. */
export function stampCanonical(record) {
    if (!record || typeof record !== 'object') return record;
    if (record[CANONICAL_FLAG] === true) return record;
    return { ...record, [CANONICAL_FLAG]: true };
}

/** A session that has been through v1 always has a valid `sessionUnit`. */
function hasSessionUnit(session) {
    return session?.sessionUnit === 'kg' || session?.sessionUnit === 'lb';
}

/**
 * Classify one session's unit provenance.
 *
 * @param {object} session
 * @param {object} ctx
 * @param {number} ctx.dataVersion  stored schema version (0 = v1 never ran)
 * @param {boolean} ctx.clobbered   true when this install has been proven to
 *   hold un-migrated records despite claiming v>=1 (the sync race)
 * @returns {'canonical'|'legacy'|'ambiguous'}
 */
export function classifySession(session, { dataVersion = 0, clobbered = false } = {}) {
    if (isCanonicalRecord(session)) return CANONICAL;

    // v1 has never run here, so nothing in storage can be canonical yet:
    // every unstamped record is legacy, including one carrying a
    // `sessionUnit` from the pre-remediation in-workout toggle.
    if (dataVersion < 1) return LEGACY;

    // v1 stamps `sessionUnit` on everything it converts. An install that
    // claims to have run v1 cannot contain a session without one unless that
    // session arrived afterwards, un-migrated, from sync.
    if (!hasSessionUnit(session)) return LEGACY;

    // v1's output is intact, so a session it stamped is canonical.
    if (!clobbered) return CANONICAL;

    // The array was replaced by an un-migrated remote document, so a
    // `sessionUnit` here could be a pre-remediation in-workout toggle
    // (legacy) or a session logged after the clobber (canonical). Nothing in
    // the record separates them, so we refuse to touch it and report it.
    return AMBIGUOUS;
}

/**
 * Measurement provenance for the install as a whole. Measurements carry no
 * per-record evidence, so the verdict is derived from facts that ARE
 * provable, and falls back to "ask the user" rather than to a guess.
 */
export function measurementProvenance({ dataVersion = 0, accountUnit = 'kg', clobbered = false, hasSessionEvidence = true } = {}) {
    // Never ran v1: these are ordinary legacy records and the account unit is
    // exactly what they were entered in. Deterministic, no question needed.
    if (dataVersion < 1) return LEGACY;

    // For a kg account v1 was a no-op on measurements - legacy kg/cm and
    // canonical kg/cm are the same numbers - so the values are correct
    // whether or not the clobber happened.
    if (normalizeWeightUnit(accountUnit) === 'kg') return CANONICAL;

    // lb account, v1's output intact: it converted them correctly.
    if (!clobbered && hasSessionEvidence) return CANONICAL;

    // lb account with proven damage, or no sessions to prove anything with.
    return AMBIGUOUS;
}

/**
 * Rewrite one session's set weights into kg and stamp it canonical.
 * Returns a NEW object; the input is never mutated.
 */
export function convertSessionToCanonical(session, fromUnit) {
    if (!session || typeof session !== 'object') return session;
    const unit = normalizeWeightUnit(fromUnit);
    const out = { ...session };
    // Record the unit the numbers were entered in, so the session keeps the
    // metadata every post-remediation session carries.
    out.sessionUnit = hasSessionUnit(session) ? session.sessionUnit : unit;
    out.exercises = (session.exercises || []).map(ex => ({
        ...ex,
        sets: (ex?.sets || []).map(set => ({
            ...set,
            weight: unit === 'kg'
                ? (set?.weight || 0)
                : (toCanonicalWeight(set?.weight || 0, unit) ?? 0),
        })),
        stickyValues: convertStickyValues(ex?.stickyValues, unit),
    }));
    out[CANONICAL_FLAG] = true;
    return out;
}

/** Sticky planned-row values carry weights too (paused workouts hold these). */
function convertStickyValues(sticky, unit) {
    if (!sticky || typeof sticky !== 'object') return sticky;
    if (unit === 'kg') return sticky;
    const out = {};
    Object.keys(sticky).forEach((slot) => {
        const entry = sticky[slot];
        if (!entry || typeof entry !== 'object') { out[slot] = entry; return; }
        out[slot] = {
            ...entry,
            weight: entry.weight === '' || entry.weight === null || entry.weight === undefined
                ? entry.weight
                : (toCanonicalWeight(entry.weight, unit) ?? entry.weight),
        };
    });
    return out;
}

/** Body weight -> kg, circumferences -> cm, then stamp canonical. */
export function convertMeasurementToCanonical(measurement, fromWeightUnit) {
    if (!measurement || typeof measurement !== 'object') return measurement;
    const unit = normalizeWeightUnit(fromWeightUnit);
    const lengthUnit = lengthUnitFor(unit);
    const out = { ...measurement };
    if (unit !== 'kg' && out.weight !== null && out.weight !== undefined && out.weight !== '') {
        out.weight = toCanonicalWeight(out.weight, unit);
    }
    if (lengthUnit !== 'cm') {
        LENGTH_FIELDS.forEach((field) => {
            const v = out[field];
            if (v === null || v === undefined || v === '') return;
            out[field] = toCanonicalLength(v, lengthUnit);
        });
    }
    out[CANONICAL_FLAG] = true;
    return out;
}

/**
 * Measurement goal targets are entered in the display unit, so they migrate
 * with the measurements they are compared against.
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

/**
 * Has this install been damaged by the sync race? True when it claims to
 * have run v1 yet still holds a session v1 would certainly have stamped.
 *
 * Deliberately narrow: it is evidence of damage, never of health.
 */
export function detectClobber(sessions, dataVersion) {
    if (!Array.isArray(sessions) || dataVersion < 1) return false;
    return sessions.some(s => s && typeof s === 'object'
        && !isCanonicalRecord(s) && !hasSessionUnit(s));
}

/** An empty report, so callers can rely on the shape. */
function emptyReport() {
    return {
        sessionsScanned: 0,
        sessionsCanonical: 0,
        sessionsRepaired: 0,
        sessionsAmbiguous: 0,
        measurementsScanned: 0,
        measurementsCanonical: 0,
        measurementsNeedingConfirmation: 0,
        goalsRepaired: false,
        activeWorkoutRepaired: false,
        clobberDetected: false,
        changed: false,
    };
}

/**
 * The re-entrant core: classify every unit-bearing record, repair only what
 * can be proven, stamp what is proven canonical, and report the rest.
 *
 * Pure. Safe to call on every boot, after every remote sync, and from the
 * Settings "Re-check stored units" action. On healthy stamped data it
 * classifies everything as canonical and returns `changed: false`.
 *
 * @param {object} snapshot { sessions, measurements, activeWorkout, goals }
 * @param {object} ctx
 * @param {string} ctx.accountUnit         settings.weightUnit
 * @param {number} ctx.dataVersion         stored schema version
 * @param {boolean} ctx.measurementsResolved  user has already answered the
 *   measurement-units question (or it never needed asking)
 * @returns {{sessions, measurements, activeWorkout, goals, report}}
 */
export function reconcileUnits(snapshot = {}, ctx = {}) {
    const accountUnit = normalizeWeightUnit(ctx.accountUnit);
    const dataVersion = Number.isFinite(Number(ctx.dataVersion)) ? Number(ctx.dataVersion) : 0;
    const measurementsResolved = !!ctx.measurementsResolved;

    const sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
    const measurements = Array.isArray(snapshot.measurements) ? snapshot.measurements : [];
    const report = emptyReport();

    const clobbered = detectClobber(sessions, dataVersion);
    report.clobberDetected = clobbered;
    report.sessionsScanned = sessions.length;
    report.measurementsScanned = measurements.length;

    // ---- sessions: deterministic repair only -----------------------------
    const outSessions = sessions.map((session) => {
        const verdict = classifySession(session, { dataVersion, clobbered });
        if (verdict === CANONICAL) {
            report.sessionsCanonical += 1;
            const stamped = stampCanonical(session);
            if (stamped !== session) report.changed = true;
            return stamped;
        }
        if (verdict === LEGACY) {
            report.sessionsRepaired += 1;
            report.changed = true;
            // The unit these numbers were entered in is the account unit:
            // that is what the pre-canonical app stored them in.
            return convertSessionToCanonical(session, accountUnit);
        }
        // AMBIGUOUS: leave the record exactly as it is and report it.
        report.sessionsAmbiguous += 1;
        return session;
    });

    // ---- active workout: same rules as a session -------------------------
    let outActive = snapshot.activeWorkout || null;
    if (outActive && typeof outActive === 'object') {
        const verdict = classifySession(outActive, { dataVersion, clobbered });
        if (verdict === LEGACY) {
            outActive = convertSessionToCanonical(outActive, accountUnit);
            report.activeWorkoutRepaired = true;
            report.changed = true;
        } else if (verdict === CANONICAL) {
            const stamped = stampCanonical(outActive);
            if (stamped !== outActive) report.changed = true;
            outActive = stamped;
        }
    }

    // ---- measurements: never guessed -------------------------------------
    const provenance = measurementProvenance({
        dataVersion, accountUnit, clobbered,
        hasSessionEvidence: sessions.length > 0,
    });

    let outMeasurements = measurements;
    let outGoals = snapshot.goals || null;

    if (measurements.length === 0) {
        report.measurementsCanonical = 0;
    } else if (provenance === LEGACY) {
        outMeasurements = measurements.map((m) => {
            if (isCanonicalRecord(m)) { report.measurementsCanonical += 1; return m; }
            report.changed = true;
            return convertMeasurementToCanonical(m, accountUnit);
        });
        outGoals = migrateMeasurementGoals(outGoals, accountUnit);
        report.goalsRepaired = accountUnit !== 'kg';
    } else if (provenance === CANONICAL) {
        outMeasurements = measurements.map((m) => {
            report.measurementsCanonical += 1;
            const stamped = stampCanonical(m);
            if (stamped !== m) report.changed = true;
            return stamped;
        });
    } else {
        // AMBIGUOUS. If the user has already answered, everything is settled
        // and merely needs its stamp; otherwise count what needs asking.
        const unstamped = measurements.filter(m => !isCanonicalRecord(m));
        if (measurementsResolved) {
            outMeasurements = measurements.map((m) => {
                report.measurementsCanonical += 1;
                const stamped = stampCanonical(m);
                if (stamped !== m) report.changed = true;
                return stamped;
            });
        } else {
            report.measurementsCanonical = measurements.length - unstamped.length;
            report.measurementsNeedingConfirmation = unstamped.length;
        }
    }

    return {
        sessions: outSessions,
        measurements: outMeasurements,
        activeWorkout: outActive,
        goals: outGoals,
        report,
    };
}

/**
 * Apply the user's answer to the measurement-units question.
 *
 * `imperial` converts lb/in into canonical kg/cm; `metric` means the stored
 * numbers were already kg/cm and only need their stamp. Either way every
 * record ends up stamped, so this can never run twice against the same data.
 */
export function resolveMeasurementUnits(measurements, goals, choice) {
    const list = Array.isArray(measurements) ? measurements : [];
    if (choice === MEASUREMENT_CHOICE_IMPERIAL) {
        return {
            measurements: list.map(m => (isCanonicalRecord(m) ? m : convertMeasurementToCanonical(m, 'lb'))),
            goals: migrateMeasurementGoals(goals, 'lb'),
            converted: true,
        };
    }
    // metric: the numbers are already canonical, so only the stamp is added.
    return {
        measurements: list.map(m => stampCanonical(m)),
        goals,
        converted: false,
    };
}

/**
 * Migrate a full data snapshot. Pure: takes and returns plain data, touches
 * no storage, so it is directly testable and can also be applied to an
 * imported payload.
 *
 * v1/v2 remain as they were for installs that have never run them; v3 hands
 * everything to `reconcileUnits`, which is what actually decides now.
 *
 * @param {object} snapshot { sessions, measurements, activeWorkout, goals, settings }
 * @param {number} fromVersion the stored DATA_SCHEMA_VERSION (0 = never run)
 * @param {object} [options] { measurementsResolved }
 */
export function migrateStoredData(snapshot = {}, fromVersion = 0, options = {}) {
    const sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
    const measurements = Array.isArray(snapshot.measurements) ? snapshot.measurements : [];
    const settings = snapshot.settings && typeof snapshot.settings === 'object'
        ? snapshot.settings : {};

    let version = Number.isFinite(Number(fromVersion)) ? Number(fromVersion) : 0;
    const startVersion = version;
    const accountUnit = normalizeWeightUnit(settings.weightUnit);

    // v1 + v3 are one operation: reconcileUnits already knows how to treat a
    // never-migrated install (everything unstamped is legacy) and a damaged
    // one, so it replaces the old hand-rolled v1 body without changing what
    // v1 did for the ordinary case.
    const reconciled = reconcileUnits(
        { sessions, measurements, activeWorkout: snapshot.activeWorkout || null, goals: snapshot.goals || null },
        { accountUnit, dataVersion: version, measurementsResolved: options.measurementsResolved },
    );

    let outSessions = reconciled.sessions;

    if (version < 2) {
        outSessions = outSessions.filter(isLoggedSession);
    }

    version = DATA_SCHEMA_VERSION;

    return {
        sessions: outSessions,
        measurements: reconciled.measurements,
        activeWorkout: reconciled.activeWorkout,
        goals: reconciled.goals,
        settings,
        version,
        report: reconciled.report,
        changed: reconciled.report.changed || version !== startVersion,
    };
}
