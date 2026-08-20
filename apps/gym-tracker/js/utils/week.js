/**
 * Week boundaries - ONE definition of "this week" for the whole app.
 *
 * The user picks the first day of the week in Settings (0 = Sunday,
 * 1 = Monday, Monday by default). Before this module the Calendar, the
 * program-editor day chips and the workout week strip honoured that choice
 * while the Home dashboard, the weekly volume/time tiles and the weekly
 * achievements were hard-coded to ISO Monday, so a Sunday-first user saw a
 * Sunday session vanish from "this week" (GT-10).
 *
 * Everything that needs a week window now calls `startOfWeek(date, firstDay)`
 * from here. Passing firstDay = 1 reproduces the old ISO behaviour exactly,
 * which is what keeps the audit-verified Monday arithmetic intact.
 */

/** Coerce a stored first-day preference to 0 (Sunday) or 1 (Monday). */
export function normalizeFirstDayOfWeek(value) {
    return value === 0 || value === '0' ? 0 : 1;
}

/**
 * Local midnight on the first day of the week containing `date`.
 *
 * `firstDay` is the weekday index the week starts on (0 = Sunday,
 * 1 = Monday). Works for any 0-6 value, not just the two the UI offers,
 * so a future preference needs no change here.
 */
export function startOfWeek(date, firstDay = 1) {
    const start = Number.isInteger(Number(firstDay)) ? ((Number(firstDay) % 7) + 7) % 7 : 1;
    const d = date instanceof Date ? new Date(date.getTime()) : new Date(date);
    const diff = (d.getDay() - start + 7) % 7;
    d.setDate(d.getDate() - diff);
    d.setHours(0, 0, 0, 0);
    return d;
}

/** Local midnight one week after `startOfWeek(date, firstDay)`. */
export function endOfWeek(date, firstDay = 1) {
    const start = startOfWeek(date, firstDay);
    const end = new Date(start);
    end.setDate(start.getDate() + 7);
    return end;
}

/**
 * A stable key for the week containing `date` - the local YYYY-MM-DD of its
 * first day. Two dates in the same week always produce the same key, which
 * is what the "how many weeks did I hit this target" counters group on.
 */
export function weekKey(date, firstDay = 1) {
    const d = startOfWeek(date, firstDay);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

/** True when `date` falls inside the week containing `reference`. */
export function isSameWeek(date, reference, firstDay = 1) {
    return weekKey(date, firstDay) === weekKey(reference, firstDay);
}
