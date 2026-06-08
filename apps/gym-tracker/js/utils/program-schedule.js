/**
 * Pure helpers for the program day-of-week schedule shown in the calendar
 * (Item 9).
 */

/**
 * Return the programs scheduled for a given weekday index (0 = Sunday ..
 * 6 = Saturday). Each program contributes when its scheduleDays includes the
 * weekday. Programs with an empty/absent schedule never match.
 */
export function programsScheduledOnWeekday(programs, weekday) {
    if (!Array.isArray(programs)) return [];
    return programs.filter(p =>
        Array.isArray(p.scheduleDays) && p.scheduleDays.includes(weekday)
    );
}

/**
 * Order the seven weekday indices starting from `firstDay` (0 = Sunday,
 * 1 = Monday). Used to lay out the weekday chips in the program editor so
 * they honor the user's first-day-of-week preference.
 */
export function weekdayOrder(firstDay = 1) {
    const start = Number.isInteger(firstDay) && firstDay >= 0 && firstDay <= 6 ? firstDay : 1;
    return Array.from({ length: 7 }, (_, i) => (start + i) % 7);
}

/**
 * Item R2-6: build the seven day cells for the workout-screen week strip,
 * ordered per `firstDay`, anchored on the week containing `today`. Each cell
 * carries its weekday index (0 = Sun .. 6 = Sat), the matching programs, and an
 * isToday flag. `programs` is the full program list; matching reuses the same
 * scheduleDays rule as the calendar so the two views never diverge.
 *
 * `today` defaults to now; passing it explicitly keeps the helper pure/testable.
 */
export function weekStrip(programs, firstDay = 0, today = new Date()) {
    const order = weekdayOrder(firstDay);
    const todayWeekday = today.getDay();
    return order.map((weekday) => ({
        weekday,
        isToday: weekday === todayWeekday,
        programs: programsScheduledOnWeekday(programs, weekday),
    }));
}
