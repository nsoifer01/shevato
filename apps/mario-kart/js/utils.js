// Shared utility functions for the Mario Kart Race Tracker

// Utility function for consistent decimal formatting
function formatDecimal(value) {
    const num = typeof value === 'string' ? parseFloat(value) : value;
    // Round to 1 decimal place first to handle floating point precision issues
    const rounded = Math.round(num * 10) / 10;
    return rounded % 1 === 0 ? Math.round(rounded).toString() : rounded.toFixed(1);
}

// True only for a real recorded finishing position. Race rows can carry
// null ("sat this one out"), or miss the key entirely (undefined) when the
// roster was widened after the race was recorded; both must be skipped, and
// so must anything non-numeric that arrives via import/sync.
function isFinitePosition(value) {
    return typeof value === 'number' && Number.isFinite(value);
}

// Tolerant parser for a race's recorded moment, as a millisecond value on the
// local wall clock. Handles every timestamp shape the app has ever written:
//   - "HH:MM:SS TZ"  (current addRace format; the TZ abbreviation is ignored
//     because engines only parse a handful of US abbreviations and races are
//     ordered by the wall-clock stamp of the device that recorded them)
//   - "24:MM:SS TZ"  (legacy midnight stamps from the old h24 formatter;
//     hour 24 means 00 on the same date)
//   - "HH:MM" / "HH:MM:SS" without a zone (edit-dialog input values)
//   - absent/unparseable timestamp: falls back to midnight of the date
// An unparseable date returns 0 so a comparator built on this stays finite
// (never NaN) and the sort stays deterministic instead of silently no-oping.
function raceDateTimeValue(race) {
    if (!race || typeof race.date !== 'string') return 0;
    const dateMatch = race.date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!dateMatch) {
        const fallback = new Date(race.date).getTime();
        return Number.isFinite(fallback) ? fallback : 0;
    }
    let hours = 0, minutes = 0, seconds = 0;
    if (typeof race.timestamp === 'string') {
        const timeMatch = race.timestamp.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s|$)/);
        if (timeMatch) {
            let h = parseInt(timeMatch[1], 10);
            const m = parseInt(timeMatch[2], 10);
            const s = timeMatch[3] ? parseInt(timeMatch[3], 10) : 0;
            if (h === 24) h = 0; // legacy midnight stamp
            if (h <= 23 && m <= 59 && s <= 59) {
                hours = h; minutes = m; seconds = s;
            }
        }
    }
    return new Date(
        parseInt(dateMatch[1], 10),
        parseInt(dateMatch[2], 10) - 1,
        parseInt(dateMatch[3], 10),
        hours, minutes, seconds
    ).getTime();
}

// Comparator for sorting races oldest-first. Always returns a finite number,
// so Array.prototype.sort actually reorders (the old inline
// `new Date(date + ' ' + timestamp)` pattern went NaN on legacy "24:" stamps
// and non-US timezone abbreviations, silently leaving insertion order).
function compareRacesChronologically(a, b) {
    return raceDateTimeValue(a) - raceDateTimeValue(b);
}

// Add any other shared utility functions here in the future