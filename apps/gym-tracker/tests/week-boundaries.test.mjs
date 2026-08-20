// Week boundaries (GT-10) and the Perfect Week rule (GT-11).
//
// GT-10: the Calendar, the workout week strip and the program-editor day chips
// all honoured "first day of week"; the Home dashboard, the weekly
// volume/time tiles and the weekly achievements were hard-coded to ISO Monday.
// A Sunday-first user saw "Week of Aug 17" (a Monday) and their Sunday session
// vanished from the weekly count while the Calendar still showed it.
//
// GT-11: "Perfect Week - Complete a workout every day this week" counted
// SESSIONS, so seven sessions across two days unlocked it.
//
// Timezone is pinned: week boundaries are local-midnight arithmetic and would
// otherwise drift with the runner's TZ.
process.env.TZ = 'America/New_York';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { endOfWeek, isSameWeek, normalizeFirstDayOfWeek, startOfWeek, weekKey } from '../js/utils/week.js';
import { AnalyticsService } from '../js/services/AnalyticsService.js';
import { AchievementService } from '../js/services/AchievementService.js';
import { Achievement } from '../js/models/Achievement.js';

const d = (iso) => AnalyticsService.toLocalDate(iso);

// ---------------------------------------------------------------------------
// The shared helper
// ---------------------------------------------------------------------------

test('startOfWeek: Monday-first behaves exactly as the old ISO helper did', () => {
    // 2026-08-19 is a Wednesday; its ISO week starts Monday 2026-08-17.
    assert.equal(weekKey(d('2026-08-19'), 1), '2026-08-17');
    assert.equal(weekKey(d('2026-08-17'), 1), '2026-08-17', 'Monday is its own start');
    assert.equal(weekKey(d('2026-08-23'), 1), '2026-08-17', 'Sunday belongs to the week before');
});

test('startOfWeek: Sunday-first moves the boundary, as configured', () => {
    assert.equal(weekKey(d('2026-08-19'), 0), '2026-08-16');
    assert.equal(weekKey(d('2026-08-16'), 0), '2026-08-16', 'Sunday is its own start');
    assert.equal(weekKey(d('2026-08-22'), 0), '2026-08-16', 'Saturday closes the week');
});

test('startOfWeek returns local midnight, not a time-of-day carry-over', () => {
    const start = startOfWeek(new Date(2026, 7, 19, 23, 45), 1);
    assert.equal(start.getHours(), 0);
    assert.equal(start.getMinutes(), 0);
    assert.equal(start.getSeconds(), 0);
});

test('endOfWeek is exactly seven days after the start', () => {
    const start = startOfWeek(d('2026-08-19'), 1);
    const end = endOfWeek(d('2026-08-19'), 1);
    assert.equal(Math.round((end - start) / 86400000), 7);
});

test('week boundaries survive a month and a year boundary', () => {
    // 2026-09-01 is a Tuesday, so its Monday is in August.
    assert.equal(weekKey(d('2026-09-01'), 1), '2026-08-31');
    // 2027-01-01 is a Friday, so its Monday is in the previous year.
    assert.equal(weekKey(d('2027-01-01'), 1), '2026-12-28');
    assert.equal(weekKey(d('2027-01-01'), 0), '2026-12-27');
});

test('isSameWeek follows the configured boundary, not a fixed one', () => {
    // Sunday 2026-08-16 and Wednesday 2026-08-19.
    assert.equal(isSameWeek(d('2026-08-16'), d('2026-08-19'), 0), true, 'same Sunday-first week');
    assert.equal(isSameWeek(d('2026-08-16'), d('2026-08-19'), 1), false, 'different Monday-first weeks');
});

test('normalizeFirstDayOfWeek: a stored 0 is a real choice and must survive', () => {
    assert.equal(normalizeFirstDayOfWeek(0), 0);
    assert.equal(normalizeFirstDayOfWeek('0'), 0);
    assert.equal(normalizeFirstDayOfWeek(1), 1);
    assert.equal(normalizeFirstDayOfWeek(undefined), 1, 'Monday is the default');
});

// ---------------------------------------------------------------------------
// AnalyticsService.getWeekStats honours the preference
// ---------------------------------------------------------------------------

/** Build sessions on given dates, each with one 100 kg x 5 set. */
const sessionsOn = (...dates) => dates.map((date, i) => ({
    id: i + 1,
    date,
    exercises: [{ exerciseId: 1, sets: [{ weight: 100, reps: 5, completed: true }] }],
    get totalVolume() { return 500; },
    get duration() { return 30; },
}));

test('getWeekStats: the same Sunday session is in or out depending on the setting', () => {
    // Anchor on a real "today" so the test is not date-dependent: build the
    // Sunday and Wednesday of the CURRENT week under each rule.
    const today = new Date();
    const sundayFirst = startOfWeek(today, 0);
    const mondayFirst = startOfWeek(today, 1);
    if (sundayFirst.getTime() === mondayFirst.getTime()) return; // today IS a Sunday-start edge; nothing to prove

    const sundayKey = AnalyticsService.toLocalDateKey(sundayFirst);
    const sessions = sessionsOn(sundayKey);

    assert.equal(AnalyticsService.getWeekStats(sessions, 0).workouts, 1,
        'Sunday-first: the Sunday session is this week');
    assert.equal(AnalyticsService.getWeekStats(sessions, 1).workouts, 0,
        'Monday-first: it belongs to the week before');
});

test('getWeekStats: the week label follows the setting', () => {
    const today = new Date();
    assert.equal(
        AnalyticsService.getWeekStats([], 1).weekStart,
        AnalyticsService.toLocalDateKey(startOfWeek(today, 1)),
    );
    assert.equal(
        AnalyticsService.getWeekStats([], 0).weekStart,
        AnalyticsService.toLocalDateKey(startOfWeek(today, 0)),
    );
});

test('getWeekStats defaults to Monday, preserving the audit-verified arithmetic', () => {
    const today = new Date();
    assert.equal(
        AnalyticsService.getWeekStats([]).weekStart,
        AnalyticsService.toLocalDateKey(startOfWeek(today, 1)),
    );
});

test('AnalyticsService.startOfIsoWeek is still the Monday-pinned alias', () => {
    assert.equal(
        AnalyticsService.startOfIsoWeek(d('2026-08-19')).getTime(),
        startOfWeek(d('2026-08-19'), 1).getTime(),
    );
});

// ---------------------------------------------------------------------------
// GT-11: Perfect Week counts DAYS
// ---------------------------------------------------------------------------

const perfectWeek = () => AchievementService.getDefaultAchievements()
    .find(a => a.id === 'weekly-7-workouts');

test('Perfect Week asks for distinct training days, not session count', () => {
    const a = perfectWeek();
    assert.equal(a.requirement.type, 'weekly-distinct-days');
    assert.equal(a.target, 7);
    assert.match(a.description, /7 days/i);
});

test('Perfect Week: seven sessions across two days does NOT unlock it', () => {
    // The exact reproduction from the audit.
    const today = new Date();
    const start = startOfWeek(today, 1);
    const dayA = AnalyticsService.toLocalDateKey(start);
    const dayB = AnalyticsService.toLocalDateKey(new Date(start.getTime() + 2 * 86400000));
    const sessions = [dayA, dayA, dayA, dayA, dayB, dayB, dayB].map((date, i) => ({ id: i, date }));

    const progress = AchievementService.calculateProgress(perfectWeek(), sessions, { firstDayOfWeek: 1 });
    assert.equal(progress, 2, 'two days trained, not seven workouts');
});

test('Perfect Week: seven distinct days DOES unlock it', () => {
    const start = startOfWeek(new Date(), 1);
    const sessions = Array.from({ length: 7 }, (_, i) => ({
        id: i,
        date: AnalyticsService.toLocalDateKey(new Date(start.getTime() + i * 86400000)),
    }));
    assert.equal(
        AchievementService.calculateProgress(perfectWeek(), sessions, { firstDayOfWeek: 1 }),
        7,
    );
});

test('the session-count weekly tiers are unchanged', () => {
    const sixDayWarrior = AchievementService.getDefaultAchievements()
        .find(a => a.id === 'weekly-6-workouts');
    assert.equal(sixDayWarrior.requirement.type, 'weekly-workouts',
        '"Complete 6 workouts this week" really is a session count');

    const start = startOfWeek(new Date(), 1);
    const day = AnalyticsService.toLocalDateKey(start);
    const sessions = Array.from({ length: 6 }, (_, i) => ({ id: i, date: day }));
    assert.equal(
        AchievementService.calculateProgress(sixDayWarrior, sessions, { firstDayOfWeek: 1 }),
        6,
    );
});

test('weekly achievement progress honours the first-day setting', () => {
    const today = new Date();
    const sundayFirst = startOfWeek(today, 0);
    const mondayFirst = startOfWeek(today, 1);
    if (sundayFirst.getTime() === mondayFirst.getTime()) return;

    const sessions = [{ id: 1, date: AnalyticsService.toLocalDateKey(sundayFirst) }];
    const threeAWeek = AchievementService.getDefaultAchievements()
        .find(a => a.id === 'weekly-3-workouts');
    assert.equal(AchievementService.calculateProgress(threeAWeek, sessions, { firstDayOfWeek: 0 }), 1);
    assert.equal(AchievementService.calculateProgress(threeAWeek, sessions, { firstDayOfWeek: 1 }), 0);
});

test('getRepetitionCount groups distinct-day weeks correctly', () => {
    const start = startOfWeek(new Date(), 1);
    const key = (n) => AnalyticsService.toLocalDateKey(new Date(start.getTime() + n * 86400000));
    // Three distinct days this week; the achievement wants 3.
    const a = new Achievement({
        id: 'x', requirement: { type: 'weekly-distinct-days' }, target: 3,
    });
    const sessions = [key(0), key(0), key(1), key(2)].map((date, i) => ({ id: i, date }));
    assert.equal(AchievementService.getRepetitionCount(a, sessions, { firstDayOfWeek: 1 }), 1);
});

// ---------------------------------------------------------------------------
// GT-11: an unlock earned under the OLD rule is withdrawn
// ---------------------------------------------------------------------------

test('syncDefinitions retires a Perfect Week unlocked under the session-count rule', () => {
    const stored = [Achievement.fromJSON({
        id: 'weekly-7-workouts',
        name: 'Perfect Week',
        description: 'Complete a workout every day this week',
        type: 'weekly',
        icon: '🌈',
        requirement: { type: 'weekly-workouts' },
        target: 7,
        unlocked: true,
        unlockedAt: '2026-08-19T00:00:00Z',
        progress: 7,
    })];
    // The lifter's real history: seven sessions over two days.
    const start = startOfWeek(new Date(), 1);
    const dayA = AnalyticsService.toLocalDateKey(start);
    const dayB = AnalyticsService.toLocalDateKey(new Date(start.getTime() + 86400000));
    const sessions = [dayA, dayA, dayA, dayA, dayB, dayB, dayB].map((date, i) => ({ id: i, date }));

    const changed = AchievementService.syncDefinitions(stored, sessions, { firstDayOfWeek: 1 });
    assert.equal(changed, true);
    assert.equal(stored[0].requirement.type, 'weekly-distinct-days', 'definition refreshed');
    assert.equal(stored[0].unlocked, false, 'the badge its own description contradicted is withdrawn');
    assert.equal(stored[0].unlockedAt, null);
});

test('syncDefinitions KEEPS an unlock the lifter genuinely earned', () => {
    const stored = [Achievement.fromJSON({
        id: 'weekly-7-workouts',
        requirement: { type: 'weekly-workouts' },
        target: 7,
        unlocked: true,
        unlockedAt: '2026-08-19T00:00:00Z',
        progress: 7,
    })];
    const start = startOfWeek(new Date(), 1);
    const sessions = Array.from({ length: 7 }, (_, i) => ({
        id: i,
        date: AnalyticsService.toLocalDateKey(new Date(start.getTime() + i * 86400000)),
    }));
    AchievementService.syncDefinitions(stored, sessions, { firstDayOfWeek: 1 });
    assert.equal(stored[0].unlocked, true, 'seven distinct days is a real Perfect Week');
});

test('syncDefinitions leaves unrelated achievements and their unlocks alone', () => {
    const stored = [Achievement.fromJSON({
        id: '5-workouts', requirement: { type: 'total-workouts' }, target: 5,
        unlocked: true, unlockedAt: '2026-01-01T00:00:00Z', progress: 5,
        name: 'Five Finish', description: 'Complete 5 workouts', type: 'global', icon: '🖐️',
    })];
    assert.equal(AchievementService.syncDefinitions(stored, [], { firstDayOfWeek: 1 }), false);
    assert.equal(stored[0].unlocked, true);
});

test('syncDefinitions refreshes wording when a definition is corrected', () => {
    const stored = [Achievement.fromJSON({
        id: 'weekly-7-workouts',
        name: 'Perfect Week',
        description: 'Complete a workout every day this week',
        type: 'weekly', icon: '🌈',
        requirement: { type: 'weekly-distinct-days' }, target: 7,
    })];
    AchievementService.syncDefinitions(stored, [], { firstDayOfWeek: 1 });
    assert.equal(stored[0].description, 'Train on all 7 days this week');
});
