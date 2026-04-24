/**
 * AchievementService
 * Manages achievement tracking and unlocking
 */
import { Achievement } from '../models/Achievement.js';
import { AnalyticsService } from './AnalyticsService.js';

export class AchievementService {
    /**
     * Get default achievements
     */
    static getDefaultAchievements() {
        return [
            // Daily
            new Achievement({
                id: 'daily-workout',
                name: 'Daily Grind',
                description: 'Complete a workout today',
                type: 'daily',
                icon: '💪',
                requirement: { type: 'workout-today' },
                target: 1
            }),
            new Achievement({
                id: 'daily-volume-500',
                name: 'Volume Master',
                description: 'Reach 500kg total volume in one workout',
                type: 'daily',
                icon: '🏋️',
                requirement: { type: 'daily-volume', value: 500 },
                target: 500
            }),

            // Weekly
            new Achievement({
                id: 'weekly-3-workouts',
                name: '3x Week Warrior',
                description: 'Complete 3 workouts this week',
                type: 'weekly',
                icon: '🔥',
                requirement: { type: 'weekly-workouts' },
                target: 3
            }),
            new Achievement({
                id: 'weekly-4-workouts',
                name: 'Consistent Crusher',
                description: 'Complete 4 workouts this week',
                type: 'weekly',
                icon: '⚡',
                requirement: { type: 'weekly-workouts' },
                target: 4
            }),
            new Achievement({
                id: 'weekly-5-workouts',
                name: 'Beast Mode',
                description: 'Complete 5+ workouts this week',
                type: 'weekly',
                icon: '🦍',
                requirement: { type: 'weekly-workouts' },
                target: 5
            }),

            // Monthly
            new Achievement({
                id: 'monthly-12-workouts',
                name: 'Monthly Milestone',
                description: 'Complete 12 workouts this month',
                type: 'monthly',
                icon: '📅',
                requirement: { type: 'monthly-workouts' },
                target: 12
            }),
            new Achievement({
                id: 'monthly-20-workouts',
                name: 'Dedicated Lifter',
                description: 'Complete 20 workouts this month',
                type: 'monthly',
                icon: '🎯',
                requirement: { type: 'monthly-workouts' },
                target: 20
            }),

            // Global/Lifetime
            new Achievement({
                id: 'first-workout',
                name: 'Getting Started',
                description: 'Complete your first workout',
                type: 'global',
                icon: '🌟',
                requirement: { type: 'total-workouts' },
                target: 1
            }),
            new Achievement({
                id: '10-workouts',
                name: 'Beginner Gains',
                description: 'Complete 10 workouts',
                type: 'global',
                icon: '📈',
                requirement: { type: 'total-workouts' },
                target: 10
            }),
            new Achievement({
                id: '50-workouts',
                name: 'Intermediate Lifter',
                description: 'Complete 50 workouts',
                type: 'global',
                icon: '💯',
                requirement: { type: 'total-workouts' },
                target: 50
            }),
            new Achievement({
                id: '100-workouts',
                name: 'Century Club',
                description: 'Complete 100 workouts',
                type: 'global',
                icon: '🏆',
                requirement: { type: 'total-workouts' },
                target: 100
            }),
            new Achievement({
                id: '250-workouts',
                name: 'Advanced Athlete',
                description: 'Complete 250 workouts',
                type: 'global',
                icon: '👑',
                requirement: { type: 'total-workouts' },
                target: 250
            }),
            new Achievement({
                id: '500-workouts',
                name: 'Elite Status',
                description: 'Complete 500 workouts',
                type: 'global',
                icon: '🥇',
                requirement: { type: 'total-workouts' },
                target: 500
            }),
            new Achievement({
                id: 'total-volume-10k',
                name: 'Volume Rookie',
                description: 'Lift 10,000kg total volume',
                type: 'global',
                icon: '🔨',
                requirement: { type: 'total-volume' },
                target: 10000
            }),
            new Achievement({
                id: 'total-volume-50k',
                name: 'Volume Veteran',
                description: 'Lift 50,000kg total volume',
                type: 'global',
                icon: '⚒️',
                requirement: { type: 'total-volume' },
                target: 50000
            }),
            new Achievement({
                id: 'total-volume-100k',
                name: 'Volume Legend',
                description: 'Lift 100,000kg total volume',
                type: 'global',
                icon: '🔱',
                requirement: { type: 'total-volume' },
                target: 100000
            }),
            new Achievement({
                id: '7-day-streak',
                name: 'Week Streak',
                description: 'Workout 7 days in a row',
                type: 'global',
                icon: '🔥',
                requirement: { type: 'workout-streak' },
                target: 7
            }),
            new Achievement({
                id: '30-day-streak',
                name: 'Month Streak',
                description: 'Workout 30 days in a row',
                type: 'global',
                icon: '🌋',
                requirement: { type: 'workout-streak' },
                target: 30
            }),
            new Achievement({
                id: '25-exercises',
                name: 'Exercise Explorer',
                description: 'Complete 25 different exercises',
                type: 'global',
                icon: '🗺️',
                requirement: { type: 'exercises-completed' },
                target: 25
            }),
            new Achievement({
                id: '50-exercises',
                name: 'Exercise Master',
                description: 'Complete 50 different exercises',
                type: 'global',
                icon: '🎓',
                requirement: { type: 'exercises-completed' },
                target: 50
            }),
            new Achievement({
                id: '100-exercises',
                name: 'Exercise Encyclopedia',
                description: 'Complete 100 different exercises',
                type: 'global',
                icon: '📚',
                requirement: { type: 'exercises-completed' },
                target: 100
            }),

            // ----- Additional Daily -----
            new Achievement({ id: 'daily-volume-250', name: 'Volume Builder', description: 'Reach 250kg total volume in one workout', type: 'daily', icon: '🌡️', requirement: { type: 'daily-volume' }, target: 250 }),
            new Achievement({ id: 'daily-volume-1000', name: 'Iron Hour', description: 'Reach 1,000kg total volume in one workout', type: 'daily', icon: '🕒', requirement: { type: 'daily-volume' }, target: 1000 }),
            new Achievement({ id: 'daily-volume-2000', name: 'Daily Beast', description: 'Reach 2,000kg total volume in one workout', type: 'daily', icon: '🐺', requirement: { type: 'daily-volume' }, target: 2000 }),
            new Achievement({ id: 'daily-volume-5000', name: 'Daily Titan', description: 'Reach 5,000kg total volume in one workout', type: 'daily', icon: '🗿', requirement: { type: 'daily-volume' }, target: 5000 }),
            new Achievement({ id: 'daily-volume-10000', name: 'Perfect Day', description: 'Reach 10,000kg total volume in one workout', type: 'daily', icon: '✨', requirement: { type: 'daily-volume' }, target: 10000 }),

            // ----- Additional Weekly -----
            new Achievement({ id: 'weekly-6-workouts', name: '6-Day Warrior', description: 'Complete 6 workouts this week', type: 'weekly', icon: '🗡️', requirement: { type: 'weekly-workouts' }, target: 6 }),
            new Achievement({ id: 'weekly-7-workouts', name: 'Perfect Week', description: 'Complete a workout every day this week', type: 'weekly', icon: '🌈', requirement: { type: 'weekly-workouts' }, target: 7 }),

            // ----- Additional Monthly -----
            new Achievement({ id: 'monthly-15-workouts', name: 'Half Month', description: 'Complete 15 workouts this month', type: 'monthly', icon: '🌓', requirement: { type: 'monthly-workouts' }, target: 15 }),
            new Achievement({ id: 'monthly-25-workouts', name: 'Monthly Crusher', description: 'Complete 25 workouts this month', type: 'monthly', icon: '💥', requirement: { type: 'monthly-workouts' }, target: 25 }),
            new Achievement({ id: 'monthly-30-workouts', name: 'Month Machine', description: 'Complete 30 workouts this month', type: 'monthly', icon: '🤖', requirement: { type: 'monthly-workouts' }, target: 30 }),

            // ----- Additional Workout Milestones -----
            new Achievement({ id: '5-workouts', name: 'Five Finish', description: 'Complete 5 workouts', type: 'global', icon: '🖐️', requirement: { type: 'total-workouts' }, target: 5 }),
            new Achievement({ id: '25-workouts', name: 'Quarter Century', description: 'Complete 25 workouts', type: 'global', icon: '🕰️', requirement: { type: 'total-workouts' }, target: 25 }),
            new Achievement({ id: '75-workouts', name: 'Seventy-Five Strong', description: 'Complete 75 workouts', type: 'global', icon: '🦾', requirement: { type: 'total-workouts' }, target: 75 }),
            new Achievement({ id: '150-workouts', name: 'One Fifty Up', description: 'Complete 150 workouts', type: 'global', icon: '🎖️', requirement: { type: 'total-workouts' }, target: 150 }),
            new Achievement({ id: '200-workouts', name: 'Bicentennial Beast', description: 'Complete 200 workouts', type: 'global', icon: '🦏', requirement: { type: 'total-workouts' }, target: 200 }),
            new Achievement({ id: '300-workouts', name: 'Triple Century', description: 'Complete 300 workouts', type: 'global', icon: '⚔️', requirement: { type: 'total-workouts' }, target: 300 }),
            new Achievement({ id: '750-workouts', name: 'Three-Quarter Grand', description: 'Complete 750 workouts', type: 'global', icon: '🥈', requirement: { type: 'total-workouts' }, target: 750 }),
            new Achievement({ id: '1000-workouts', name: 'Grand Master', description: 'Complete 1,000 workouts', type: 'global', icon: '🏛️', requirement: { type: 'total-workouts' }, target: 1000 }),

            // ----- Additional Total Volume -----
            new Achievement({ id: 'total-volume-1k', name: 'First Ton', description: 'Lift 1,000kg total volume', type: 'global', icon: '🧱', requirement: { type: 'total-volume' }, target: 1000 }),
            new Achievement({ id: 'total-volume-5k', name: 'Five-Ton Club', description: 'Lift 5,000kg total volume', type: 'global', icon: '🛠️', requirement: { type: 'total-volume' }, target: 5000 }),
            new Achievement({ id: 'total-volume-25k', name: 'Quarter-Ton Lifter', description: 'Lift 25,000kg total volume', type: 'global', icon: '🏗️', requirement: { type: 'total-volume' }, target: 25000 }),
            new Achievement({ id: 'total-volume-250k', name: 'Ironclad', description: 'Lift 250,000kg total volume', type: 'global', icon: '🛡️', requirement: { type: 'total-volume' }, target: 250000 }),
            new Achievement({ id: 'total-volume-500k', name: 'Half-Million Hero', description: 'Lift 500,000kg total volume', type: 'global', icon: '🪨', requirement: { type: 'total-volume' }, target: 500000 }),
            new Achievement({ id: 'total-volume-1m', name: 'Million Kg Legend', description: 'Lift 1,000,000kg total volume', type: 'global', icon: '💎', requirement: { type: 'total-volume' }, target: 1000000 }),

            // ----- Additional Streaks -----
            new Achievement({ id: '3-day-streak', name: 'Triple Threat', description: 'Workout 3 days in a row', type: 'global', icon: '💨', requirement: { type: 'workout-streak' }, target: 3 }),
            new Achievement({ id: '5-day-streak', name: 'Five-Day Flame', description: 'Workout 5 days in a row', type: 'global', icon: '🕯️', requirement: { type: 'workout-streak' }, target: 5 }),
            new Achievement({ id: '14-day-streak', name: 'Fortnight Fighter', description: 'Workout 14 days in a row', type: 'global', icon: '🗡️', requirement: { type: 'workout-streak' }, target: 14 }),
            new Achievement({ id: '21-day-streak', name: 'Habit Formed', description: 'Workout 21 days in a row', type: 'global', icon: '🧲', requirement: { type: 'workout-streak' }, target: 21 }),
            new Achievement({ id: '60-day-streak', name: '60-Day Machine', description: 'Workout 60 days in a row', type: 'global', icon: '⚙️', requirement: { type: 'workout-streak' }, target: 60 }),
            new Achievement({ id: '90-day-streak', name: '90-Day Demon', description: 'Workout 90 days in a row', type: 'global', icon: '😈', requirement: { type: 'workout-streak' }, target: 90 }),
            new Achievement({ id: '100-day-streak', name: 'Centurion Streak', description: 'Workout 100 days in a row', type: 'global', icon: '🛕', requirement: { type: 'workout-streak' }, target: 100 }),
            new Achievement({ id: '180-day-streak', name: 'Half-Year Hero', description: 'Workout 180 days in a row', type: 'global', icon: '🌠', requirement: { type: 'workout-streak' }, target: 180 }),
            new Achievement({ id: '365-day-streak', name: 'Year of Iron', description: 'Workout 365 days in a row', type: 'global', icon: '📆', requirement: { type: 'workout-streak' }, target: 365 }),

            // ----- Additional Exercises Completed -----
            new Achievement({ id: '5-exercises', name: 'Variety Starter', description: 'Complete 5 different exercises', type: 'global', icon: '🌱', requirement: { type: 'exercises-completed' }, target: 5 }),
            new Achievement({ id: '10-exercises', name: 'Ten Moves Down', description: 'Complete 10 different exercises', type: 'global', icon: '🔟', requirement: { type: 'exercises-completed' }, target: 10 }),
            new Achievement({ id: '15-exercises', name: 'Fifteen Tried', description: 'Complete 15 different exercises', type: 'global', icon: '🎲', requirement: { type: 'exercises-completed' }, target: 15 }),
            new Achievement({ id: '75-exercises', name: 'Move Maestro', description: 'Complete 75 different exercises', type: 'global', icon: '🎼', requirement: { type: 'exercises-completed' }, target: 75 }),
            new Achievement({ id: '150-exercises', name: 'Exercise Legend', description: 'Complete 150 different exercises', type: 'global', icon: '🌟', requirement: { type: 'exercises-completed' }, target: 150 }),
            new Achievement({ id: '200-exercises', name: 'Movement Maven', description: 'Complete 200 different exercises', type: 'global', icon: '🎪', requirement: { type: 'exercises-completed' }, target: 200 }),
            new Achievement({ id: '300-exercises', name: 'Full Spectrum', description: 'Complete 300 different exercises', type: 'global', icon: '🌈', requirement: { type: 'exercises-completed' }, target: 300 }),
            new Achievement({ id: '500-exercises', name: 'Encyclopedia Elite', description: 'Complete 500 different exercises', type: 'global', icon: '📖', requirement: { type: 'exercises-completed' }, target: 500 }),

            // ----- Total Sets -----
            new Achievement({ id: '100-sets', name: 'Set Starter', description: 'Complete 100 total sets', type: 'global', icon: '📝', requirement: { type: 'total-sets' }, target: 100 }),
            new Achievement({ id: '500-sets', name: '500 Set Club', description: 'Complete 500 total sets', type: 'global', icon: '📒', requirement: { type: 'total-sets' }, target: 500 }),
            new Achievement({ id: '1000-sets', name: 'Thousand Sets Tall', description: 'Complete 1,000 total sets', type: 'global', icon: '📚', requirement: { type: 'total-sets' }, target: 1000 }),
            new Achievement({ id: '5000-sets', name: '5K Set Machine', description: 'Complete 5,000 total sets', type: 'global', icon: '🗂️', requirement: { type: 'total-sets' }, target: 5000 }),

            // ----- Total Reps -----
            new Achievement({ id: '1000-reps', name: 'Thousand Reps', description: 'Complete 1,000 total reps', type: 'global', icon: '🔂', requirement: { type: 'total-reps' }, target: 1000 }),
            new Achievement({ id: '5000-reps', name: 'Five-Grand Grinder', description: 'Complete 5,000 total reps', type: 'global', icon: '🌀', requirement: { type: 'total-reps' }, target: 5000 }),
            new Achievement({ id: '10000-reps', name: 'Ten-Grand Tough', description: 'Complete 10,000 total reps', type: 'global', icon: '🌪️', requirement: { type: 'total-reps' }, target: 10000 }),
            new Achievement({ id: '50000-reps', name: '50K Rep Hammer', description: 'Complete 50,000 total reps', type: 'global', icon: '🪓', requirement: { type: 'total-reps' }, target: 50000 }),
            new Achievement({ id: '100000-reps', name: 'Rep Immortal', description: 'Complete 100,000 total reps', type: 'global', icon: '👻', requirement: { type: 'total-reps' }, target: 100000 }),

            // ----- Extra Workout Milestones -----
            new Achievement({ id: '400-workouts', name: 'Four-Hundred Force', description: 'Complete 400 workouts', type: 'global', icon: '🚀', requirement: { type: 'total-workouts' }, target: 400 }),
            new Achievement({ id: '600-workouts', name: 'Six-Hundred Summit', description: 'Complete 600 workouts', type: 'global', icon: '🏔️', requirement: { type: 'total-workouts' }, target: 600 }),
            new Achievement({ id: '2000-workouts', name: 'Two-Thousand Titan', description: 'Complete 2,000 workouts', type: 'global', icon: '🪐', requirement: { type: 'total-workouts' }, target: 2000 }),

            // ----- Extra Streaks -----
            new Achievement({ id: '45-day-streak', name: '45-Day Force', description: 'Workout 45 days in a row', type: 'global', icon: '💠', requirement: { type: 'workout-streak' }, target: 45 }),
            new Achievement({ id: '200-day-streak', name: '200-Day Legend', description: 'Workout 200 days in a row', type: 'global', icon: '🌌', requirement: { type: 'workout-streak' }, target: 200 }),
            new Achievement({ id: '500-day-streak', name: '500-Day Immortal', description: 'Workout 500 days in a row', type: 'global', icon: '☄️', requirement: { type: 'workout-streak' }, target: 500 }),

            // ----- Extra Exercises Completed -----
            new Achievement({ id: '35-exercises', name: 'Versatile', description: 'Complete 35 different exercises', type: 'global', icon: '🎭', requirement: { type: 'exercises-completed' }, target: 35 }),
            new Achievement({ id: '400-exercises', name: 'Master of Moves', description: 'Complete 400 different exercises', type: 'global', icon: '🕹️', requirement: { type: 'exercises-completed' }, target: 400 }),
            new Achievement({ id: '600-exercises', name: 'Exercise Omniscience', description: 'Complete 600 different exercises', type: 'global', icon: '🧠', requirement: { type: 'exercises-completed' }, target: 600 }),

            // ----- Extra Total Sets -----
            new Achievement({ id: '250-sets', name: 'Quarter-K Sets', description: 'Complete 250 total sets', type: 'global', icon: '🎯', requirement: { type: 'total-sets' }, target: 250 }),
            new Achievement({ id: '750-sets', name: 'Set Grinder', description: 'Complete 750 total sets', type: 'global', icon: '⏳', requirement: { type: 'total-sets' }, target: 750 }),
            new Achievement({ id: '2000-sets', name: 'Double-K Sets', description: 'Complete 2,000 total sets', type: 'global', icon: '🎲', requirement: { type: 'total-sets' }, target: 2000 }),
            new Achievement({ id: '10000-sets', name: 'Ten-K Set Titan', description: 'Complete 10,000 total sets', type: 'global', icon: '🏰', requirement: { type: 'total-sets' }, target: 10000 }),
            new Achievement({ id: '20000-sets', name: 'Set Sage', description: 'Complete 20,000 total sets', type: 'global', icon: '🧙', requirement: { type: 'total-sets' }, target: 20000 }),
            new Achievement({ id: '50000-sets', name: '50K Set Sovereign', description: 'Complete 50,000 total sets', type: 'global', icon: '👑', requirement: { type: 'total-sets' }, target: 50000 }),

            // ----- Extra Total Reps -----
            new Achievement({ id: '2500-reps', name: 'Rep Rally', description: 'Complete 2,500 total reps', type: 'global', icon: '📣', requirement: { type: 'total-reps' }, target: 2500 }),
            new Achievement({ id: '25000-reps', name: '25K Rep Rampage', description: 'Complete 25,000 total reps', type: 'global', icon: '🔥', requirement: { type: 'total-reps' }, target: 25000 }),
            new Achievement({ id: '75000-reps', name: '75K Rep Roaster', description: 'Complete 75,000 total reps', type: 'global', icon: '🍖', requirement: { type: 'total-reps' }, target: 75000 }),
            new Achievement({ id: '250000-reps', name: 'Quarter-Million Reps', description: 'Complete 250,000 total reps', type: 'global', icon: '🎇', requirement: { type: 'total-reps' }, target: 250000 }),
            new Achievement({ id: '500000-reps', name: 'Half-Million Reps', description: 'Complete 500,000 total reps', type: 'global', icon: '🎆', requirement: { type: 'total-reps' }, target: 500000 }),
            new Achievement({ id: '1000000-reps', name: 'Million Rep Myth', description: 'Complete 1,000,000 total reps', type: 'global', icon: '🧬', requirement: { type: 'total-reps' }, target: 1000000 }),

            // ----- Extra Total Volume -----
            new Achievement({ id: 'total-volume-2500', name: '2.5-Ton Club', description: 'Lift 2,500kg total volume', type: 'global', icon: '🛢️', requirement: { type: 'total-volume' }, target: 2500 }),
            new Achievement({ id: 'total-volume-750k', name: 'Three-Quarter Million', description: 'Lift 750,000kg total volume', type: 'global', icon: '🌋', requirement: { type: 'total-volume' }, target: 750000 }),
            new Achievement({ id: 'total-volume-2m', name: 'Two-Million Lifter', description: 'Lift 2,000,000kg total volume', type: 'global', icon: '🚡', requirement: { type: 'total-volume' }, target: 2000000 }),
            new Achievement({ id: 'total-volume-5m', name: 'Five-Million Legend', description: 'Lift 5,000,000kg total volume', type: 'global', icon: '🔆', requirement: { type: 'total-volume' }, target: 5000000 }),

            // ----- Extra Daily Volume -----
            new Achievement({ id: 'daily-volume-15000', name: 'Daily Colossus', description: 'Reach 15,000kg total volume in one workout', type: 'daily', icon: '🦣', requirement: { type: 'daily-volume' }, target: 15000 }),
            new Achievement({ id: 'daily-volume-25000', name: 'Daily Megalith', description: 'Reach 25,000kg total volume in one workout', type: 'daily', icon: '🗼', requirement: { type: 'daily-volume' }, target: 25000 }),

            // ----- Extra Monthly -----
            new Achievement({ id: 'monthly-8-workouts', name: 'Monthly Starter Plus', description: 'Complete 8 workouts this month', type: 'monthly', icon: '📌', requirement: { type: 'monthly-workouts' }, target: 8 }),
            new Achievement({ id: 'monthly-40-workouts', name: 'Monthly Maniac', description: 'Complete 40 workouts this month', type: 'monthly', icon: '🎢', requirement: { type: 'monthly-workouts' }, target: 40 })
        ];
    }

    /**
     * Update all achievement progress based on sessions
     */
    static updateAchievementProgress(achievements, sessions) {
        achievements.forEach(achievement => {
            const progress = this.calculateProgress(achievement, sessions);
            achievement.updateProgress(progress);
        });

        return achievements;
    }

    /**
     * Calculate progress for a specific achievement
     */
    static calculateProgress(achievement, sessions) {
        const reqType = achievement.requirement.type;

        switch (reqType) {
            case 'total-workouts':
                return sessions.length;

            case 'total-volume':
                return AnalyticsService.getTotalVolume(sessions);

            case 'workout-streak':
                return AnalyticsService.calculateAchievementProgress('streak', sessions, 'workout-streak');

            case 'exercises-completed':
                return AnalyticsService.calculateAchievementProgress('exercises', sessions, 'exercises-completed');

            case 'workout-today': {
                const today = new Date().toISOString().split('T')[0];
                return sessions.some(s => s.date === today) ? 1 : 0;
            }

            case 'daily-volume': {
                // Use LOCAL today — toISOString() gives UTC, which is a day
                // off for late-evening users west of UTC.
                const today = AnalyticsService.toLocalDateKey(new Date());
                const todaySessions = sessions.filter(s => s.date === today);
                return AnalyticsService.getTotalVolume(todaySessions);
            }

            case 'weekly-workouts': {
                const weekStart = AnalyticsService.startOfIsoWeek(new Date());
                const weeklySessions = sessions.filter(s =>
                    AnalyticsService.toLocalDate(s.date) >= weekStart
                );
                return weeklySessions.length;
            }

            case 'monthly-workouts': {
                const now = new Date();
                const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

                const monthlySessions = sessions.filter(s =>
                    AnalyticsService.toLocalDate(s.date) >= monthStart
                );
                return monthlySessions.length;
            }

            case 'total-sets': {
                let count = 0;
                sessions.forEach(s => {
                    s.exercises.forEach(e => {
                        count += e.sets ? e.sets.length : 0;
                    });
                });
                return count;
            }

            case 'total-reps': {
                let count = 0;
                sessions.forEach(s => {
                    s.exercises.forEach(e => {
                        if (e.sets) e.sets.forEach(set => { count += set.reps || 0; });
                    });
                });
                return count;
            }

            default:
                return 0;
        }
    }

    /**
     * Get newly unlocked achievements
     */
    static getNewlyUnlocked(oldAchievements, newAchievements) {
        const oldUnlockedIds = new Set(
            oldAchievements.filter(a => a.unlocked).map(a => a.id)
        );

        return newAchievements.filter(a =>
            a.unlocked && !oldUnlockedIds.has(a.id)
        );
    }

    /**
     * Get achievements by type
     */
    static getAchievementsByType(achievements, type) {
        return achievements.filter(a => a.type === type);
    }

    /**
     * Count how many times a recurring achievement has been completed historically.
     * Returns 0 for non-recurring achievements (lifetime/global goals).
     */
    static getRepetitionCount(achievement, sessions) {
        const reqType = achievement.requirement?.type;
        const target = achievement.target || 1;

        switch (reqType) {
            case 'workout-today': {
                const days = new Set(sessions.map(s => s.date));
                return days.size;
            }
            case 'daily-volume': {
                const volumeByDay = new Map();
                sessions.forEach(s => {
                    volumeByDay.set(s.date, (volumeByDay.get(s.date) || 0) + (s.totalVolume || 0));
                });
                let count = 0;
                volumeByDay.forEach(v => { if (v >= target) count++; });
                return count;
            }
            case 'weekly-workouts': {
                const weekKey = (date) => {
                    const d = new Date(date);
                    const day = d.getDay();
                    const diff = day === 0 ? 6 : day - 1;
                    d.setDate(d.getDate() - diff);
                    return d.toISOString().split('T')[0];
                };
                const sessionsByWeek = new Map();
                sessions.forEach(s => {
                    const k = weekKey(s.date);
                    sessionsByWeek.set(k, (sessionsByWeek.get(k) || 0) + 1);
                });
                let count = 0;
                sessionsByWeek.forEach(v => { if (v >= target) count++; });
                return count;
            }
            case 'monthly-workouts': {
                const monthKey = (date) => {
                    const d = new Date(date);
                    return `${d.getFullYear()}-${d.getMonth()}`;
                };
                const sessionsByMonth = new Map();
                sessions.forEach(s => {
                    const k = monthKey(s.date);
                    sessionsByMonth.set(k, (sessionsByMonth.get(k) || 0) + 1);
                });
                let count = 0;
                sessionsByMonth.forEach(v => { if (v >= target) count++; });
                return count;
            }
            default:
                return 0;
        }
    }

    /**
     * Whether an achievement is a recurring (resets each period) goal.
     */
    static isRecurring(achievement) {
        return ['workout-today', 'daily-volume', 'weekly-workouts', 'monthly-workouts']
            .includes(achievement.requirement?.type);
    }

    /**
     * Get unlocked achievements
     */
    static getUnlockedAchievements(achievements) {
        return achievements.filter(a => a.unlocked);
    }

    /**
     * Get locked achievements
     */
    static getLockedAchievements(achievements) {
        return achievements.filter(a => !a.unlocked);
    }
}
