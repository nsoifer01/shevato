/**
 * Import semantics - merge vs replace.
 *
 * The import dialog used to promise "It will be merged with your existing
 * programs, workouts, and settings" while `importAllData` did
 * `if (data.programs) this.savePrograms(data.programs)` - a wholesale
 * overwrite of every store present in the file. Importing a file that
 * contained only sessions destroyed the user's program and all 17 unlocked
 * achievements, with no undo and no backup (GT-02).
 *
 * The two operations are now distinct and honestly labelled:
 *
 *   MERGE   - the default. Existing records are kept; imported records are
 *             added; a record present on both sides is resolved by the
 *             deterministic rules below. An empty array in the file can
 *             never wipe a populated store.
 *   REPLACE - an explicit restore-from-backup. Says so in the dialog, asks
 *             for a stronger confirmation, and downloads a rollback file
 *             first.
 *
 * ## Collision rules (deterministic, never arbitrary)
 *
 * Identity is `sameId`, not `===`: ids survive an export/import round trip
 * as strings often enough that "123" and 123 would otherwise be merged in as
 * two copies of the same logical record.
 *
 *   programs      newer `updatedAt` wins; missing/equal timestamps → imported
 *   sessions      newer `timestamp` wins; missing/equal → imported
 *   measurements  newer `createdAt` wins; missing/equal → imported
 *   achievements  an UNLOCKED record beats a locked one either way (an unlock
 *                 is a fact that happened and must not be undone by an import
 *                 from a device that had not synced it); otherwise the higher
 *                 `progress` wins, then imported
 *   customExercises  imported wins (they carry no version metadata, and the
 *                 file the user just chose is the more deliberate statement)
 *   settings      key-by-key overlay: keys present in the file win, keys
 *                 absent from it keep their current value. Never wholesale.
 */
import { sameId } from './id-utils.js';

export const IMPORT_MODES = { MERGE: 'merge', REPLACE: 'replace' };

/** ms since epoch for a date-ish field; -Infinity when absent/unparseable. */
function timeOf(value) {
    if (!value) return -Infinity;
    const t = new Date(value).getTime();
    return Number.isFinite(t) ? t : -Infinity;
}

/**
 * Merge two id-keyed lists. `pick(existing, incoming)` returns the winner
 * for a collision. Order: existing records keep their position, new imported
 * records are appended.
 */
export function mergeById(existing, incoming, pick) {
    const base = Array.isArray(existing) ? existing : [];
    const add = Array.isArray(incoming) ? incoming : [];
    const out = base.slice();
    const indexById = new Map();
    out.forEach((record, i) => {
        if (record && record.id !== undefined && record.id !== null) {
            indexById.set(String(record.id), i);
        }
    });

    add.forEach((record) => {
        if (!record || typeof record !== 'object') return;
        const key = record.id === undefined || record.id === null ? null : String(record.id);
        // An id-less record cannot be matched, so it is always an addition.
        if (key === null) { out.push(record); return; }
        const at = indexById.get(key);
        if (at === undefined) {
            indexById.set(key, out.length);
            out.push(record);
            return;
        }
        out[at] = pick(out[at], record);
    });
    return out;
}

const newerWins = (field) => (existing, incoming) => (
    timeOf(incoming?.[field]) > timeOf(existing?.[field]) ? incoming : (
        timeOf(existing?.[field]) > timeOf(incoming?.[field]) ? existing : incoming
    )
);

/** Unlocks are facts; an import never re-locks something already earned. */
export function pickAchievement(existing, incoming) {
    if (existing?.unlocked && !incoming?.unlocked) return existing;
    if (incoming?.unlocked && !existing?.unlocked) return incoming;
    const a = Number(existing?.progress) || 0;
    const b = Number(incoming?.progress) || 0;
    return b >= a ? incoming : existing;
}

/**
 * Overlay the imported settings onto the current ones, key by key. Anything
 * the file does not mention keeps its current value, so importing a program
 * file exported from a build with fewer settings cannot silently reset the
 * user's rest-timer markers or plate stack.
 */
export function mergeSettings(existing, incoming) {
    const base = existing && typeof existing === 'object' ? existing : {};
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return base;
    return { ...base, ...incoming };
}

/**
 * Compute the post-merge value of every store.
 *
 * `current` and `incoming` are both full data snapshots. Stores absent from
 * `incoming` are returned untouched, and - critically - an EMPTY imported
 * array is treated as "this file has nothing to add", not as "delete
 * everything" (that is the exact shape that wiped the QA run's program list).
 */
export function mergeImportedData(current = {}, incoming = {}) {
    const list = (key) => (Array.isArray(incoming[key]) ? incoming[key] : null);

    const out = {};
    const programs = list('programs');
    out.programs = programs && programs.length
        ? mergeById(current.programs, programs, newerWins('updatedAt'))
        : (current.programs || []);

    const sessions = list('sessions');
    out.sessions = sessions && sessions.length
        ? mergeById(current.sessions, sessions, newerWins('timestamp'))
        : (current.sessions || []);

    const measurements = list('measurements');
    out.measurements = measurements && measurements.length
        ? mergeById(current.measurements, measurements, newerWins('createdAt'))
        : (current.measurements || []);

    const achievements = list('achievements');
    out.achievements = achievements && achievements.length
        ? mergeById(current.achievements, achievements, pickAchievement)
        : (current.achievements || []);

    const custom = list('customExercises');
    out.customExercises = custom && custom.length
        ? mergeById(current.customExercises, custom, (_existing, incomingRecord) => incomingRecord)
        : (current.customExercises || []);

    out.settings = incoming.settings
        ? mergeSettings(current.settings, incoming.settings)
        : (current.settings || null);

    // The active program is a pointer, not a store: keep the current one
    // unless it no longer exists in the merged list.
    const stillThere = (id) => (out.programs || []).some(p => sameId(p?.id, id));
    if (current.activeProgram && stillThere(current.activeProgram)) {
        out.activeProgram = current.activeProgram;
    } else if (incoming.activeProgram && stillThere(incoming.activeProgram)) {
        out.activeProgram = incoming.activeProgram;
    } else {
        out.activeProgram = null;
    }

    return out;
}

/**
 * A short human summary of what a merge did, for the success toast:
 * "3 programs and 10 workouts added".
 */
export function summarizeMerge(before, after) {
    const delta = (key, singular, plural) => {
        const n = (after[key] || []).length - (before[key] || []).length;
        return n > 0 ? `${n} ${n === 1 ? singular : plural}` : null;
    };
    const parts = [
        delta('programs', 'program', 'programs'),
        delta('sessions', 'workout', 'workouts'),
        delta('customExercises', 'custom exercise', 'custom exercises'),
        delta('measurements', 'measurement', 'measurements'),
    ].filter(Boolean);
    if (parts.length === 0) return 'Import merged - nothing new to add';
    const last = parts.pop();
    return `Imported: ${parts.length ? `${parts.join(', ')} and ${last}` : last}`;
}
