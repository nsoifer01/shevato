/**
 * Calendar View Controller
 */
import { app } from '../app.js';

class CalendarView {
    constructor() {
        this.app = app;
        this.currentMonth = new Date().getMonth();
        this.currentYear = new Date().getFullYear();
        this.init();
    }

    init() {
        this.app.viewControllers.calendar = this;
        this.setupEventListeners();
    }

    setupEventListeners() {
        const prevBtn = document.getElementById('prev-month-btn');
        const nextBtn = document.getElementById('next-month-btn');

        if (prevBtn) {
            prevBtn.addEventListener('click', () => {
                this.currentMonth--;
                if (this.currentMonth < 0) {
                    this.currentMonth = 11;
                    this.currentYear--;
                }
                this.render();
            });
        }

        if (nextBtn) {
            nextBtn.addEventListener('click', () => {
                this.currentMonth++;
                if (this.currentMonth > 11) {
                    this.currentMonth = 0;
                    this.currentYear++;
                }
                this.render();
            });
        }
    }

    render() {
        this.renderCalendar();
    }

    renderCalendar() {
        const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
            'July', 'August', 'September', 'October', 'November', 'December'];

        document.getElementById('calendar-month-year').textContent =
            `${monthNames[this.currentMonth]} ${this.currentYear}`;

        const container = document.getElementById('calendar-grid');
        const firstDayOfMonth = new Date(this.currentYear, this.currentMonth, 1).getDay();
        // Convert to Monday-first week (Sunday=0 becomes 6, Monday=1 becomes 0, etc.)
        const firstDay = firstDayOfMonth === 0 ? 6 : firstDayOfMonth - 1;
        const daysInMonth = new Date(this.currentYear, this.currentMonth + 1, 0).getDate();

        let html = '';

        // Day headers (Monday first)
        ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].forEach(day => {
            html += `<div class="calendar-day-header">${day}</div>`;
        });

        // Empty cells for days before month starts
        for (let i = 0; i < firstDay; i++) {
            html += '<div class="calendar-day empty"></div>';
        }

        // Days of month
        for (let day = 1; day <= daysInMonth; day++) {
            const dateStr = `${this.currentYear}-${String(this.currentMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
            const hasWorkout = this.app.workoutSessions.some(s => s.date === dateStr);
            const isToday = dateStr === new Date().toISOString().split('T')[0];

            let classes = 'calendar-day';
            if (isToday) classes += ' today';
            if (hasWorkout) classes += ' workout';

            html += `<div class="${classes}">${day}</div>`;
        }

        container.innerHTML = html;
    }
}

// Initialize
new CalendarView();
