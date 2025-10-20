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
            })
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
                const today = new Date().toISOString().split('T')[0];
                const todaySessions = sessions.filter(s => s.date === today);
                return AnalyticsService.getTotalVolume(todaySessions);
            }

            case 'weekly-workouts': {
                const now = new Date();
                const weekStart = new Date(now);
                const day = now.getDay();
                const diff = day === 0 ? 6 : day - 1; // Monday as start of week
                weekStart.setDate(now.getDate() - diff);
                weekStart.setHours(0, 0, 0, 0);

                const weeklySessions = sessions.filter(s =>
                    new Date(s.date) >= weekStart
                );
                return weeklySessions.length;
            }

            case 'monthly-workouts': {
                const now = new Date();
                const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

                const monthlySessions = sessions.filter(s =>
                    new Date(s.date) >= monthStart
                );
                return monthlySessions.length;
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
