/**
 * DarkCalendar — custom dark-themed date picker.
 * Wraps an existing <input type="date">: hides the native input, mounts a styled
 * trigger + popup beside it, and dispatches `change` on the input when a date is
 * picked so existing listeners keep working.
 */

const MONTH_NAMES = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
];
const WEEKDAY_LABELS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

export class DarkCalendar {
    constructor(input) {
        this.input = input;
        this.placeholder = input.placeholder || input.dataset.placeholder || 'Select date';
        this.viewDate = new Date();
        this.selectedDate = input.value ? this.parseISO(input.value) : null;
        if (this.selectedDate) this.viewDate = new Date(this.selectedDate);
        this.isOpen = false;
        this.outsideClickHandler = (e) => {
            if (!this.wrapper.contains(e.target)) this.close();
        };
        this.build();
    }

    build() {
        this.wrapper = document.createElement('div');
        this.wrapper.className = 'dark-calendar';

        this.trigger = document.createElement('button');
        this.trigger.type = 'button';
        this.trigger.className = 'dark-calendar-trigger';
        this.trigger.innerHTML = `
            <i class="fas fa-calendar-day"></i>
            <span class="dark-calendar-trigger-label"></span>
            <i class="fas fa-chevron-down dark-calendar-chevron"></i>
        `;
        this.trigger.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggle();
        });

        this.popup = document.createElement('div');
        this.popup.className = 'dark-calendar-popup';
        this.popup.hidden = true;
        this.popup.addEventListener('click', (e) => e.stopPropagation());

        // Insert wrapper into DOM in place of input, and tuck the input inside it
        this.input.insertAdjacentElement('afterend', this.wrapper);
        this.wrapper.appendChild(this.trigger);
        this.wrapper.appendChild(this.popup);
        this.wrapper.appendChild(this.input);
        this.input.type = 'hidden';

        this.updateTrigger();
    }

    // --- Helpers ---
    parseISO(str) {
        const [y, m, d] = str.split('-').map(Number);
        return new Date(y, m - 1, d);
    }
    formatISO(date) {
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }
    formatDisplay(date) {
        return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    }
    isSameDay(a, b) {
        return !!(a && b
            && a.getFullYear() === b.getFullYear()
            && a.getMonth() === b.getMonth()
            && a.getDate() === b.getDate());
    }

    // --- State ---
    updateTrigger() {
        const label = this.trigger.querySelector('.dark-calendar-trigger-label');
        if (this.selectedDate) {
            label.textContent = this.formatDisplay(this.selectedDate);
            this.trigger.classList.add('has-value');
        } else {
            label.textContent = this.placeholder;
            this.trigger.classList.remove('has-value');
        }
    }

    selectDate(date) {
        this.selectedDate = date;
        this.viewDate = new Date(date);
        this.input.value = this.formatISO(date);
        this.input.dispatchEvent(new Event('change', { bubbles: true }));
        this.updateTrigger();
        this.close();
    }

    clearDate() {
        this.selectedDate = null;
        this.input.value = '';
        this.input.dispatchEvent(new Event('change', { bubbles: true }));
        this.updateTrigger();
        this.close();
    }

    goToToday() {
        const today = new Date();
        this.viewDate = new Date(today);
        this.selectDate(today);
    }

    prevMonth() {
        this.viewDate.setDate(1);
        this.viewDate.setMonth(this.viewDate.getMonth() - 1);
        this.render();
    }

    nextMonth() {
        this.viewDate.setDate(1);
        this.viewDate.setMonth(this.viewDate.getMonth() + 1);
        this.render();
    }

    // --- Open/close ---
    toggle() { this.isOpen ? this.close() : this.open(); }

    open() {
        // Close any other DarkCalendar instance — only one can be open at a time
        if (DarkCalendar._activeInstance && DarkCalendar._activeInstance !== this) {
            DarkCalendar._activeInstance.close();
        }
        DarkCalendar._activeInstance = this;

        // Re-sync viewDate to current input value if any
        if (this.input.value) {
            this.selectedDate = this.parseISO(this.input.value);
            this.viewDate = new Date(this.selectedDate);
        }
        this.isOpen = true;
        this.popup.hidden = false;
        this.wrapper.classList.add('is-open');
        this.render();

        // Position the popup so it never overflows the viewport horizontally
        this.positionPopup();

        // Delay to avoid the same click immediately closing
        setTimeout(() => document.addEventListener('click', this.outsideClickHandler), 0);
    }

    positionPopup() {
        // Reset to defaults so we can measure
        this.popup.style.left = '';
        this.popup.style.right = '';
        const rect = this.popup.getBoundingClientRect();
        const viewportWidth = window.innerWidth;
        // If the popup spills off the right edge, anchor to the right edge of trigger
        if (rect.right > viewportWidth - 8) {
            this.popup.style.left = 'auto';
            this.popup.style.right = '0';
        }
        // If still overflowing left, clamp to 8px
        const after = this.popup.getBoundingClientRect();
        if (after.left < 8) {
            this.popup.style.left = '0';
            this.popup.style.right = 'auto';
        }
    }

    close() {
        if (!this.isOpen) return;
        this.isOpen = false;
        this.popup.hidden = true;
        this.wrapper.classList.remove('is-open');
        if (DarkCalendar._activeInstance === this) DarkCalendar._activeInstance = null;
        // Reset positional overrides
        this.popup.style.left = '';
        this.popup.style.right = '';
        document.removeEventListener('click', this.outsideClickHandler);
    }

    // --- Render ---
    render() {
        const year = this.viewDate.getFullYear();
        const month = this.viewDate.getMonth();
        const today = new Date();

        const firstDay = new Date(year, month, 1);
        let firstWeekday = firstDay.getDay() - 1; // Mon-first
        if (firstWeekday < 0) firstWeekday = 6;
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        const prevMonthDays = new Date(year, month, 0).getDate();

        let html = `
            <div class="dark-calendar-header">
                <button type="button" class="dark-calendar-nav" data-action="prev" aria-label="Previous month">
                    <i class="fas fa-chevron-left"></i>
                </button>
                <span class="dark-calendar-title">${MONTH_NAMES[month]} ${year}</span>
                <button type="button" class="dark-calendar-nav" data-action="next" aria-label="Next month">
                    <i class="fas fa-chevron-right"></i>
                </button>
            </div>
            <div class="dark-calendar-weekdays">
                ${WEEKDAY_LABELS.map(d => `<span>${d}</span>`).join('')}
            </div>
            <div class="dark-calendar-grid">
        `;

        // Leading days from previous month
        for (let i = firstWeekday - 1; i >= 0; i--) {
            html += `<button type="button" class="dark-calendar-day other" data-y="${year}" data-m="${month - 1}" data-d="${prevMonthDays - i}">${prevMonthDays - i}</button>`;
        }
        // Current month
        for (let d = 1; d <= daysInMonth; d++) {
            const date = new Date(year, month, d);
            const cls = ['dark-calendar-day'];
            if (this.isSameDay(date, today)) cls.push('today');
            if (this.isSameDay(date, this.selectedDate)) cls.push('selected');
            html += `<button type="button" class="${cls.join(' ')}" data-y="${year}" data-m="${month}" data-d="${d}">${d}</button>`;
        }
        // Trailing days
        const totalCells = firstWeekday + daysInMonth;
        const trailingNeeded = (7 - (totalCells % 7)) % 7;
        for (let i = 1; i <= trailingNeeded; i++) {
            html += `<button type="button" class="dark-calendar-day other" data-y="${year}" data-m="${month + 1}" data-d="${i}">${i}</button>`;
        }

        html += `
            </div>
            <div class="dark-calendar-footer">
                <button type="button" class="dark-calendar-action" data-action="clear">Clear</button>
                <button type="button" class="dark-calendar-action primary" data-action="today">Today</button>
            </div>
        `;

        this.popup.innerHTML = html;

        this.popup.querySelectorAll('.dark-calendar-nav').forEach(btn => {
            btn.addEventListener('click', () => {
                btn.dataset.action === 'prev' ? this.prevMonth() : this.nextMonth();
            });
        });
        this.popup.querySelectorAll('.dark-calendar-day').forEach(btn => {
            btn.addEventListener('click', () => {
                const y = +btn.dataset.y, m = +btn.dataset.m, d = +btn.dataset.d;
                this.selectDate(new Date(y, m, d));
            });
        });
        this.popup.querySelectorAll('.dark-calendar-action').forEach(btn => {
            btn.addEventListener('click', () => {
                btn.dataset.action === 'clear' ? this.clearDate() : this.goToToday();
            });
        });
    }
}
