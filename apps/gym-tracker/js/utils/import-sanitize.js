/**
 * Field-level sanitiser for imported / restored payloads.
 *
 * `validateImportData` (settings-view) checks store TYPES: programs is a
 * list, settings is an object. Nothing checked the fields inside, so a
 * tampered or hand-edited file put `weightUnit: "stone"` into storage (the
 * Settings select showed kg while the model said stone), a session dated
 * `not-a-date` rendered "INVALID DATE" in History, a set with `reps: 1e308`
 * unlocked the "Million Reps" lifetime achievement, and records with no id
 * or with `"__proto__"` as their id were stored (2026-08-22 audit D8).
 *
 * One sanitiser, applied by `StorageService.importAllData` so BOTH the file
 * import and the restore-a-backup path go through it. It normalises rather
 * than rejects wherever a repair is unambiguous, and returns the list of
 * repairs so the UI can disclose what changed. Legitimate legacy exports
 * (1.0 payloads without slots, settings without the newer keys) pass through
 * untouched: every rule below only fires on a value that is actually wrong.
 */
import { generateNumericId } from './helpers.js';

const WEIGHT_UNITS = ['kg', 'lb'];
const TIME_FORMATS = ['12', '24'];
/** Generous physical ceilings: anything above is a typo or an attack, not a lift. */
const MAX_WEIGHT_KG = 2000;
const MAX_REPS = 1000;
const MAX_SECONDS = 24 * 3600;
const BAD_ID_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** `YYYY-MM-DD` from a date key or an ISO timestamp; null when unparseable. */
export function normalizeDateKey(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
    if (m) {
        const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
        return d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]) ? value.trim() : null;
    }
    const t = new Date(value);
    if (isNaN(t.getTime())) return null;
    const y = t.getFullYear();
    const mo = String(t.getMonth() + 1).padStart(2, '0');
    const da = String(t.getDate()).padStart(2, '0');
    return `${y}-${mo}-${da}`;
}

/** A usable record id: a finite number or a non-empty string that is not a prototype key. */
export function validId(id) {
    if (typeof id === 'number') return Number.isFinite(id);
    if (typeof id === 'string') return id.trim() !== '' && !BAD_ID_KEYS.has(id.trim());
    return false;
}

function clampNumber(value, { min = 0, max = Infinity, integer = false } = {}) {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) return null;
    let out = Math.min(max, Math.max(min, n));
    if (integer) out = Math.round(out);
    return out;
}

/**
 * Sanitise one payload. Returns `{ data, repairs }` where `data` is a deep
 * copy with the repairs applied and `repairs` is a list of short human
 * sentences (empty when nothing needed touching).
 */
export function sanitizeImportData(input) {
    const repairs = [];
    const note = (msg) => { if (!repairs.includes(msg)) repairs.push(msg); };
    const data = structuredClone(input);

    const fixIds = (list, label) => {
        let assigned = 0;
        let dropped = 0;
        const out = [];
        for (const record of list) {
            if (!isPlainObject(record)) { dropped++; continue; }
            if (!validId(record.id)) { record.id = generateNumericId(); assigned++; }
            out.push(record);
        }
        if (assigned) note(`${assigned} ${label} had a missing or invalid id and got a new one`);
        if (dropped) note(`${dropped} ${label} entries were not records and were skipped`);
        return out;
    };

    if (Array.isArray(data.programs)) {
        data.programs = fixIds(data.programs, 'program(s)');
        let badExerciseLists = 0;
        let droppedExercises = 0;
        for (const p of data.programs) {
            if (typeof p.name !== 'string') { p.name = String(p.name ?? 'Imported program'); note('a program name was not text and was converted'); }

            // `exercises` was validated nowhere, and Program's constructor
            // does `(data.exercises || []).map(normalizeExercise)`. A program
            // whose exercises is an object, a string, or an array holding a
            // null therefore THREW while the store was being loaded, and
            // app.js wraps the whole store in _safeLoad: one bad program made
            // every program vanish behind "Could not load programs, so that
            // section reset to empty", and the next save wrote that empty
            // list over the intact stored one. Coerce here instead, where a
            // repair can be reported.
            if (p.exercises === undefined || p.exercises === null) continue;
            if (!Array.isArray(p.exercises)) {
                p.exercises = [];
                badExerciseLists++;
                continue;
            }
            const before = p.exercises.length;
            p.exercises = p.exercises.filter(isPlainObject);
            droppedExercises += before - p.exercises.length;
        }
        if (badExerciseLists) {
            note(`${badExerciseLists} program(s) had an unreadable exercise list and were emptied`);
        }
        if (droppedExercises) {
            note(`${droppedExercises} program exercise entries were not records and were skipped`);
        }
    }

    if (Array.isArray(data.sessions)) {
        data.sessions = fixIds(data.sessions, 'workout(s)');
        const kept = [];
        let undated = 0;
        let clampedSets = 0;
        for (const s of data.sessions) {
            // A missing date is left to the model's default (today); only a
            // date that is PRESENT and unreadable is repaired or skipped.
            if (s.date !== undefined) {
                const date = normalizeDateKey(s.date) || normalizeDateKey(s.startTime) || normalizeDateKey(s.timestamp);
                if (!date) { undated++; continue; }
                if (date !== s.date) { s.date = date; note('workout dates were normalised to YYYY-MM-DD'); }
            }
            if (!Array.isArray(s.exercises)) s.exercises = [];
            s.exercises = s.exercises.filter(isPlainObject);
            for (const ex of s.exercises) {
                if (!Array.isArray(ex.sets)) ex.sets = [];
                ex.sets = ex.sets.filter(isPlainObject);
                for (const set of ex.sets) {
                    // Only fields the set carries are touched, so a legacy
                    // set without `duration` round-trips byte-identical.
                    let fixed = false;
                    for (const [key, opts] of [
                        ['weight', { max: MAX_WEIGHT_KG }],
                        ['reps', { max: MAX_REPS, integer: true }],
                        ['duration', { max: MAX_SECONDS, integer: true }],
                    ]) {
                        if (!(key in set)) continue;
                        const n = clampNumber(set[key], opts);
                        const next = n === null ? 0 : n;
                        if (next !== set[key]) { set[key] = next; fixed = true; }
                    }
                    if (fixed) clampedSets++;
                }
            }
            kept.push(s);
        }
        if (undated) note(`${undated} workout(s) had no readable date and were skipped`);
        if (clampedSets) note(`${clampedSets} set(s) had impossible weight, reps or duration values and were corrected`);
        data.sessions = kept;
    }

    if (Array.isArray(data.customExercises)) {
        data.customExercises = fixIds(data.customExercises, 'custom exercise(s)');
        data.customExercises = data.customExercises.filter((ex) => {
            if (typeof ex.name !== 'string' || !ex.name.trim()) { note('a custom exercise without a name was skipped'); return false; }
            return true;
        });
    }

    if (Array.isArray(data.measurements)) {
        data.measurements = fixIds(data.measurements, 'measurement(s)');
        const kept = [];
        let undated = 0;
        for (const m of data.measurements) {
            if (m.date !== undefined) {
                const date = normalizeDateKey(m.date) || normalizeDateKey(m.createdAt);
                if (!date) { undated++; continue; }
                if (date !== m.date) { m.date = date; note('measurement dates were normalised to YYYY-MM-DD'); }
            }
            for (const key of ['weight', 'bodyFat', 'chest', 'waist', 'hips', 'armLeft', 'armRight', 'thighLeft', 'thighRight']) {
                if (m[key] === '' || m[key] === null || m[key] === undefined) continue;
                const n = clampNumber(m[key], { max: key === 'bodyFat' ? 100 : 5000 });
                if (n !== m[key]) { m[key] = n === null ? null : n; note('out-of-range measurement values were corrected'); }
            }
            kept.push(m);
        }
        if (undated) note(`${undated} measurement(s) had no readable date and were skipped`);
        data.measurements = kept;
    }

    if (Array.isArray(data.achievements)) {
        data.achievements = data.achievements.filter((a) => {
            if (!isPlainObject(a) || typeof a.id !== 'string' || !a.id) { note('an achievement record without an id was skipped'); return false; }
            return true;
        });
    }

    if (isPlainObject(data.settings)) {
        const st = data.settings;
        const dropKey = (key, why) => { delete st[key]; note(`setting "${key}" ${why} and was ignored`); };
        if ('weightUnit' in st && !WEIGHT_UNITS.includes(st.weightUnit)) dropKey('weightUnit', 'was not kg or lb');
        if ('timeFormat' in st && !TIME_FORMATS.includes(String(st.timeFormat))) dropKey('timeFormat', 'was not 12 or 24');
        else if ('timeFormat' in st && typeof st.timeFormat !== 'string') st.timeFormat = String(st.timeFormat);
        if ('firstDayOfWeek' in st && st.firstDayOfWeek !== 0 && st.firstDayOfWeek !== 1) dropKey('firstDayOfWeek', 'was not Sunday (0) or Monday (1)');
        if ('plateProfiles' in st && !isPlainObject(st.plateProfiles)) dropKey('plateProfiles', 'was not a plate profile object');
        for (const key of ['timerFirstWarningSeconds', 'timerCountdownSeconds', 'barWeight', 'restTimerDefault']) {
            if (key in st && (typeof st[key] !== 'number' || !Number.isFinite(st[key]) || st[key] < 0)) dropKey(key, 'was not a non-negative number');
        }
        if ('plates' in st && !Array.isArray(st.plates)) dropKey('plates', 'was not a list');
        for (const key of ['soundAlerts', 'vibrationAlerts', 'plateHintsEnabled', 'showProgramSchedule']) {
            if (key in st && typeof st[key] !== 'boolean') dropKey(key, 'was not on/off');
        }
    } else if ('settings' in data && data.settings !== undefined) {
        delete data.settings;
        note('settings were not an object and were ignored');
    }

    if ('activeProgram' in data && data.activeProgram != null && !validId(data.activeProgram)) {
        delete data.activeProgram;
        note('the active program pointer was invalid and was ignored');
    }

    return { data, repairs };
}
