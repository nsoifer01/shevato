/**
 * Measurement model — a single body-measurement entry.
 *
 * Schema:
 *   id           string (UUID-ish, see helpers.generateNumericId)
 *   date         YYYY-MM-DD (local)
 *   weight       number | null  — body weight in the user's weight unit
 *   bodyFat      number | null  — percentage (0–100)
 *   chest        number | null  — circumference in the user's length unit (cm or in)
 *   waist        number | null
 *   hips         number | null
 *   armLeft      number | null
 *   armRight     number | null
 *   thighLeft    number | null
 *   thighRight   number | null
 *   notes        string
 *
 * All numeric fields are nullable so the user can log only what they
 * measured today. The view filters out null fields when rendering the
 * progression chart so an empty series doesn't draw a flat line.
 */
import { generateNumericId, getTodayDateString } from '../utils/helpers.js';

export class Measurement {
    constructor(data = {}) {
        // Coerce to a finite number when present so a Firestore round-trip
        // that hands back a string id ("7212…") doesn't break strict-eq
        // filters in the views (delete / edit). Falls back to a fresh id
        // when missing or unparseable.
        const incoming = data.id != null ? Number(data.id) : NaN;
        this.id = Number.isFinite(incoming) ? incoming : generateNumericId();
        this.date = data.date || getTodayDateString();
        this.weight = num(data.weight);
        this.bodyFat = num(data.bodyFat);
        this.chest = num(data.chest);
        this.waist = num(data.waist);
        this.hips = num(data.hips);
        this.armLeft = num(data.armLeft);
        this.armRight = num(data.armRight);
        this.thighLeft = num(data.thighLeft);
        this.thighRight = num(data.thighRight);
        this.notes = data.notes || '';
        this.createdAt = data.createdAt || new Date().toISOString();
    }

    toJSON() {
        return {
            id: this.id,
            date: this.date,
            weight: this.weight,
            bodyFat: this.bodyFat,
            chest: this.chest,
            waist: this.waist,
            hips: this.hips,
            armLeft: this.armLeft,
            armRight: this.armRight,
            thighLeft: this.thighLeft,
            thighRight: this.thighRight,
            notes: this.notes,
            createdAt: this.createdAt,
        };
    }

    static fromJSON(json) {
        return new Measurement(json);
    }
}

/** Coerce to a finite number or null — empty inputs collapse to null. */
function num(v) {
    if (v === '' || v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}
