/**
 * Calendar View Controller
 * Data-driven workout calendar with month stats, day-state hierarchy,
 * filtering, and a selected-day detail panel.
 */
import { app } from '../app.js';
import { AnalyticsService } from '../services/AnalyticsService.js';
import { formatDate } from '../utils/helpers.js';
import { DarkSelect } from '../utils/dark-select.js';

const MONTH_NAMES = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
];

const formatISO = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
};

class CalendarView {
    constructor() {
        this.app = app;
        const now = new Date();
        this.viewYear = now.getFullYear();
        this.viewMonth = now.getMonth();
        this.selectedDate = formatISO(now);
        this.filterMode = 'all';
        this.init();
    }

    init() {
        this.app.viewControllers.calendar = this;
        this.setupEventListeners();
    }

    setupEventListeners() {
        const prevBtn = document.getElementById('prev-month-btn');
        const nextBtn = document.getElementById('next-month-btn');
        const todayBtn = document.getElementById('calendar-today-btn');
        const filterSel = document.getElementById('calendar-filter');

        if (prevBtn) prevBtn.addEventListener('click', () => this.shiftMonth(-1));
        if (nextBtn) nextBtn.addEventListener('click', () => this.shiftMonth(1));
        if (todayBtn) todayBtn.addEventListener('click', () => this.jumpToToday());
        if (filterSel) {
            if (!filterSel.dataset.darkSelectInit) {
                this.filterDropdown = new DarkSelect(filterSel);
                filterSel.dataset.darkSelectInit = '1';
            }
            filterSel.addEventListener('change', (e) => {
                this.filterMode = e.target.value;
                this.render();
            });
        }
    }

    shiftMonth(delta) {
        this.viewMonth += delta;
        while (this.viewMonth < 0) { this.viewMonth += 12; this.viewYear--; }
        while (this.viewMonth > 11) { this.viewMonth -= 12; this.viewYear++; }
        this.render();
    }

    jumpToToday() {
        if (this.isOnToday()) return; // guarded in UI, but defensive
        const now = new Date();
        this.viewYear = now.getFullYear();
        this.viewMonth = now.getMonth();
        this.selectedDate = formatISO(now);
        this.render();
    }

    /** True when the calendar is showing the current month AND today is selected. */
    isOnToday() {
        const now = new Date();
        const todayKey = formatISO(now);
        return this.viewYear === now.getFullYear()
            && this.viewMonth === now.getMonth()
            && this.selectedDate === todayKey;
    }

    render() {
        this.renderStats();
        this.renderCalendar();
        this.renderLegend();
        this.renderDetail();
        this.updateTodayButton();
    }

    updateTodayButton() {
        const btn = document.getElementById('calendar-today-btn');
        if (!btn) return;
        btn.disabled = this.isOnToday();
    }

    // --- Month stats ---
    renderStats() {
        const container = document.getElementById('calendar-stats');
        if (!container) return;
        const sessions = this.app.workoutSessions || [];
        const summary = AnalyticsService.getMonthSummary(sessions, this.viewYear, this.viewMonth);
        const streak = AnalyticsService.getCurrentStreak(sessions);
        const unit = this.app.settings?.weightUnit || 'kg';
        const hours = Math.floor(summary.totalDuration / 60);
        const mins = summary.totalDuration % 60;

        container.innerHTML = `
            ${this.statCard('dumbbell', 'Workouts', summary.sessionCount, summary.workoutDays === summary.sessionCount ? null : `${summary.workoutDays} days`)}
            ${this.statCard('weight-hanging', 'Volume', `${Math.round(summary.totalVolume).toLocaleString()} ${unit}`)}
            ${this.statCard('clock', 'Time', summary.totalDuration > 0 ? (hours > 0 ? `${hours}h ${mins}m` : `${mins}m`) : '—')}
            ${this.statCard('fire', 'Streak', `${streak} day${streak === 1 ? '' : 's'}`, null, streak > 0 ? 'is-hot' : '')}
            ${this.statCard('chart-line', 'PR days', summary.prDays)}
        `;
    }

    statCard(icon, label, value, sub = null, extraClass = '') {
        return `
            <div class="cal-stat ${extraClass}">
                <div class="cal-stat-icon"><i class="fas fa-${icon}"></i></div>
                <div class="cal-stat-text">
                    <div class="cal-stat-value">${value}</div>
                    <div class="cal-stat-label">${label}${sub ? ` · ${sub}` : ''}</div>
                </div>
            </div>
        `;
    }

    // --- Calendar grid ---
    renderCalendar() {
        const monthYearEl = document.getElementById('calendar-month-year');
        const container = document.getElementById('calendar-grid');
        if (!monthYearEl || !container) return;

        monthYearEl.textContent = `${MONTH_NAMES[this.viewMonth]} ${this.viewYear}`;

        const sessions = this.app.workoutSessions || [];
        const sessionsByDate = AnalyticsService.getSessionsByDate(sessions);
        const progressDates = AnalyticsService.getProgressDates(sessions);

        const todayKey = formatISO(new Date());
        const firstDayOfMonth = new Date(this.viewYear, this.viewMonth, 1).getDay();
        const firstWeekday = firstDayOfMonth === 0 ? 6 : firstDayOfMonth - 1;
        const daysInMonth = new Date(this.viewYear, this.viewMonth + 1, 0).getDate();

        let html = '';
        ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].forEach(d => {
            html += `<div class="calendar-day-header">${d}</div>`;
        });

        // Leading empty placeholders
        for (let i = 0; i < firstWeekday; i++) html += '<div class="calendar-day empty"></div>';

        for (let day = 1; day <= daysInMonth; day++) {
            const dateStr = `${this.viewYear}-${String(this.viewMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
            const isToday = dateStr === todayKey;
            const isSelected = dateStr === this.selectedDate;
            const isFuture = new Date(dateStr) > new Date(todayKey);
            const dayHasWorkout = sessionsByDate.has(dateStr);
            const dayHasProgress = progressDates.has(dateStr);

            // Filter: dim days that don't match the filter
            let dimmed = false;
            if (this.filterMode === 'workouts' && !dayHasWorkout) dimmed = true;
            if (this.filterMode === 'pr' && !dayHasProgress) dimmed = true;

            const classes = ['calendar-day'];
            if (isFuture) classes.push('future');
            if (dayHasWorkout) classes.push('has-workout');
            if (dayHasProgress) classes.push('has-progress');
            if (isToday) classes.push('today');
            if (isSelected) classes.push('selected');
            if (dimmed) classes.push('dim');

            const ariaParts = [`${MONTH_NAMES[this.viewMonth]} ${day}`];
            if (dayHasWorkout) ariaParts.push('workout logged');
            if (dayHasProgress) ariaParts.push('personal record');
            if (isToday) ariaParts.push('today');

            html += `
                <button type="button" class="${classes.join(' ')}" data-date="${dateStr}" aria-label="${ariaParts.join(', ')}">
                    <span class="calendar-day-num">${day}</span>
                    ${dayHasWorkout ? '<span class="calendar-day-dot" aria-hidden="true"></span>' : ''}
                    ${dayHasProgress ? '<span class="calendar-day-pr" aria-hidden="true"><i class="fas fa-star"></i></span>' : ''}
                </button>
            `;
        }

        container.innerHTML = html;

        container.querySelectorAll('.calendar-day:not(.empty)').forEach(cell => {
            cell.addEventListener('click', () => {
                this.selectedDate = cell.dataset.date;
                this.render();
            });
        });
    }

    // --- Legend (only for cues actually present in current view) ---
    renderLegend() {
        const container = document.getElementById('calendar-legend');
        if (!container) return;
        const sessions = this.app.workoutSessions || [];
        const sessionsByDate = AnalyticsService.getSessionsByDate(sessions);
        const progressDates = AnalyticsService.getProgressDates(sessions);

        const monthHasWorkout = [...sessionsByDate.keys()].some(d => {
            const dt = new Date(d);
            return dt.getFullYear() === this.viewYear && dt.getMonth() === this.viewMonth;
        });
        const monthHasProgress = [...progressDates].some(d => {
            const dt = new Date(d);
            return dt.getFullYear() === this.viewYear && dt.getMonth() === this.viewMonth;
        });

        const items = [];
        if (monthHasWorkout) items.push('<span class="legend-item"><span class="legend-cue legend-dot-cue"></span>Workout</span>');
        if (monthHasProgress) items.push('<span class="legend-item"><span class="legend-cue legend-pr-cue"><i class="fas fa-star"></i></span>New PR</span>');
        container.innerHTML = items.join('');
    }

    // --- Selected-day detail panel ---
    renderDetail() {
        const container = document.getElementById('calendar-detail');
        if (!container) return;

        const sessions = this.app.workoutSessions || [];
        // Sort same-day sessions by time-of-day, latest first, so an evening
        // workout shows above a morning one on the same calendar day.
        const daySessions = sessions
            .filter(s => s.date === this.selectedDate)
            .sort((a, b) => new Date(b.sortTimestamp) - new Date(a.sortTimestamp));
        const dateObj = new Date(this.selectedDate);
        const headerLabel = dateObj.toLocaleDateString(undefined, {
            weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
        });

        if (daySessions.length === 0) {
            container.innerHTML = `
                <div class="calendar-detail-card empty">
                    <div class="calendar-detail-header">
                        <div>
                            <div class="calendar-detail-title">${headerLabel}</div>
                            <div class="calendar-detail-sub">No workout logged</div>
                        </div>
                    </div>
                    <p class="calendar-detail-empty">
                        <i class="fas fa-bed"></i> Rest day — nothing recorded for this date.
                    </p>
                </div>
            `;
            return;
        }

        const unit = this.app.settings?.weightUnit || 'kg';
        const progressDates = AnalyticsService.getProgressDates(sessions);
        const isPR = progressDates.has(this.selectedDate);

        container.innerHTML = `
            <div class="calendar-detail-card">
                <div class="calendar-detail-header">
                    <div>
                        <div class="calendar-detail-title">${headerLabel}</div>
                        <div class="calendar-detail-sub">${daySessions.length} workout${daySessions.length === 1 ? '' : 's'}${isPR ? ' · <span class="pr-tag"><i class=\"fas fa-star\"></i> New PR</span>' : ''}</div>
                    </div>
                </div>
                ${daySessions.map(s => this.renderSessionSummary(s, unit)).join('')}
            </div>
        `;
    }

    /**
     * Open the Workout History modal for the given session and, when closed,
     * return to the Calendar view with the same month + selected date intact.
     * The modal lives inside `#history-view` so we have to switch views first.
     */
    openWorkoutHistory(sessionId) {
        const historyCtrl = this.app.viewControllers.history;
        if (!historyCtrl) return;
        // Tell the history view to return to the calendar when the modal closes
        historyCtrl.returnToView = 'calendar';
        this.app.showView('history');
        // Delay so history view gets rendered before we trigger its modal
        setTimeout(() => {
            historyCtrl.showWorkoutDetails(sessionId);
        }, 100);
    }

    renderSessionSummary(session, unit) {
        const totalVolume = Math.round(session.totalVolume || 0).toLocaleString();
        const totalSets = session.totalSets || (session.exercises || []).reduce((n, ex) => n + (ex.sets?.length || 0), 0);
        const dur = session.duration || 0;
        const durStr = dur > 0 ? (dur >= 60 ? `${Math.floor(dur / 60)}h ${dur % 60}m` : `${dur}m`) : '—';
        const exerciseCount = (session.exercises || []).length;

        return `
            <div class="cal-session"
                 role="button"
                 tabindex="0"
                 title="View workout details"
                 onclick="window.gymApp.viewControllers.calendar.openWorkoutHistory(${session.id})"
                 onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();window.gymApp.viewControllers.calendar.openWorkoutHistory(${session.id});}">
                <div class="cal-session-header">
                    <strong>${session.workoutDayName || 'Workout'}</strong>
                    <span class="cal-session-chevron" aria-hidden="true"><i class="fas fa-chevron-right"></i></span>
                </div>
                <div class="cal-session-stats">
                    <span><i class="fas fa-dumbbell"></i> ${exerciseCount} exercise${exerciseCount === 1 ? '' : 's'}</span>
                    <span><i class="fas fa-layer-group"></i> ${totalSets} set${totalSets === 1 ? '' : 's'}</span>
                    <span><i class="fas fa-weight-hanging"></i> ${totalVolume} ${unit}</span>
                    <span><i class="fas fa-clock"></i> ${durStr}</span>
                </div>
                ${session.notes ? `<p class="cal-session-notes">${session.notes}</p>` : ''}
            </div>
        `;
    }
}

// Initialize
new CalendarView();
