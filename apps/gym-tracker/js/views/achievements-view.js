/**
 * Achievements View Controller
 */
import { app } from '../app.js';

class AchievementsView {
    constructor() {
        this.app = app;
        this.currentFilter = 'all';
        this.init();
    }

    init() {
        this.app.viewControllers.achievements = this;
        this.setupEventListeners();
    }

    setupEventListeners() {
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
                e.target.classList.add('active');
                this.currentFilter = e.target.dataset.tab;
                this.render();
            });
        });
    }

    render() {
        this.renderAchievements();
    }

    renderAchievements() {
        const container = document.getElementById('achievements-list');
        let achievements = this.app.achievements;

        if (this.currentFilter !== 'all') {
            achievements = achievements.filter(a => a.type === this.currentFilter);
        }

        const unlocked = achievements.filter(a => a.unlocked).length;
        const total = achievements.length;

        document.getElementById('unlocked-count').textContent = unlocked;
        document.getElementById('total-achievements').textContent = total;

        container.innerHTML = achievements.map(achievement => `
            <div class="achievement-card ${achievement.unlocked ? 'unlocked' : ''}">
                <div class="achievement-icon">${achievement.icon}</div>
                <div class="achievement-info">
                    <h3>${achievement.name}</h3>
                    <p>${achievement.description}</p>
                    ${!achievement.unlocked ? `
                        <div class="achievement-progress">
                            <div class="achievement-progress-bar" style="width: ${achievement.progressPercentage}%"></div>
                        </div>
                        <small>${achievement.progress} / ${achievement.target}</small>
                    ` : `
                        <small class="text-success">✓ Unlocked</small>
                    `}
                </div>
            </div>
        `).join('');
    }
}

// Initialize
new AchievementsView();
