/**
 * DarkCalendar — custom dark-themed date picker.
 * Wraps an existing <input type="date">: hides the native input, mounts a styled
 * trigger + popup beside it, and dispatches `change` on the input when a date is
 * picked so existing listeners keep working.
 *
 * Range support: two DarkCalendar instances can be linked by setting
 * `calendar.rangePartner = otherCalendar`. When both have a value, the grids
 * highlight every day between the two as "in-range". Selecting in the "from"
 * calendar auto-opens the "to" calendar.
 */

const MONTH_NAMES = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
];
const WEEKDAY_LABELS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

// A single shared backdrop element — inserted into <body> on first open, reused.
let sharedBackdrop = null;
function getBackdrop() {
    if (!sharedBackdrop) {
        sharedBackdrop = document.createElement('div');
        sharedBackdrop.className = 'dark-calendar-backdrop';
        sharedBackdrop.hidden = true;
        document.body.appendChild(sharedBackdrop);
        sharedBackdrop.addEventListener('click', () => {
            if (DarkCalendar._activeInstance) DarkCalendar._activeInstance.close();
        });
    }
    return sharedBackdrop;
}

export class DarkCalendar {
    constructor(input, options = {}) {
        this.input = input;
        this.placeholder = input.placeholder || input.dataset.placeholder || 'Select date';
        this.role = options.role || null; // 'from' | 'to' | null
        /** The linked partner picker for range highlighting — set later by caller. */
        this.rangePartner = options.rangePartner || null;
        this.viewDate = new Date();
        this.selectedDate = input.value ? this.parseISO(input.value) : null;
        if (this.selectedDate) this.viewDate = new Date(this.selectedDate);
        this.isOpen = false;
        this.outsideClickHandler = (e) => {
            if (!this.wrapper.contains(e.target) && e.target !== sharedBackdrop) this.close();
        };
        this.keyHandler = (e) => {
            if (!this.isOpen) return;
            if (e.key === 'Escape') { this.close(); this.trigger.focus(); }
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

    /** Inclusive check: is `date` strictly between from and to (exclusive of endpoints)? */
    isBetween(date, from, to) {
        if (!from || !to || !date) return false;
        const t = date.setHours ? date.getTime() : new Date(date).getTime();
        const f = from.getTime();
        const e = to.getTime();
        const lo = Math.min(f, e);
        const hi = Math.max(f, e);
        return t > lo && t < hi;
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
        // If this is the "from" picker and partner has no value yet, open partner
        const wasFromPicker = this.role === 'from';
        const partnerNeedsValue = this.rangePartner && !this.rangePartner.selectedDate;
        this.close();
        if (wasFromPicker && partnerNeedsValue) {
            // Small delay so the current close completes first
            setTimeout(() => this.rangePartner.open(), 80);
        }
        // Also re-render the partner if open, in case range highlighting changed
        if (this.rangePartner && this.rangePartner.isOpen) this.rangePartner.render();
    }

    clearDate() {
        this.selectedDate = null;
        this.input.value = '';
        this.input.dispatchEvent(new Event('change', { bubbles: true }));
        this.updateTrigger();
        this.close();
        if (this.rangePartner && this.rangePartner.isOpen) this.rangePartner.render();
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
        if (DarkCalendar._activeInstance && DarkCalendar._activeInstance !== this) {
            DarkCalendar._activeInstance.close();
        }
        DarkCalendar._activeInstance = this;

        if (this.input.value) {
            this.selectedDate = this.parseISO(this.input.value);
            this.viewDate = new Date(this.selectedDate);
        }
        this.isOpen = true;
        this.popup.hidden = false;
        this.wrapper.classList.add('is-open');

        // Show backdrop
        const backdrop = getBackdrop();
        backdrop.hidden = false;
        backdrop.classList.add('is-visible');

        this.render();
        this.positionPopup();

        setTimeout(() => {
            document.addEventListener('click', this.outsideClickHandler);
            document.addEventListener('keydown', this.keyHandler);
        }, 0);
    }

    positionPopup() {
        this.popup.style.left = '';
        this.popup.style.right = '';
        // On narrow viewports we let CSS handle centering via @media rule, no JS needed.
        if (window.innerWidth <= 520) return;
        const rect = this.popup.getBoundingClientRect();
        const viewportWidth = window.innerWidth;
        if (rect.right > viewportWidth - 8) {
            this.popup.style.left = 'auto';
            this.popup.style.right = '0';
        }
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
        this.popup.style.left = '';
        this.popup.style.right = '';
        document.removeEventListener('click', this.outsideClickHandler);
        document.removeEventListener('keydown', this.keyHandler);

        // Hide backdrop if nothing is open
        if (!DarkCalendar._activeInstance && sharedBackdrop) {
            sharedBackdrop.classList.remove('is-visible');
            sharedBackdrop.hidden = true;
        }
    }

    /** Derive the effective range bounds (from, to) considering this + partner. */
    getRangeBounds() {
        if (!this.rangePartner) return { from: null, to: null };
        const selfIsFrom = this.role === 'from';
        const a = selfIsFrom ? this.selectedDate : this.rangePartner.selectedDate;
        const b = selfIsFrom ? this.rangePartner.selectedDate : this.selectedDate;
        return { from: a, to: b };
    }

    // --- Render ---
    render() {
        const year = this.viewDate.getFullYear();
        const month = this.viewDate.getMonth();
        const today = new Date();

        const firstDay = new Date(year, month, 1);
        let firstWeekday = firstDay.getDay() - 1;
        if (firstWeekday < 0) firstWeekday = 6;
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        const prevMonthDays = new Date(year, month, 0).getDate();

        const { from, to } = this.getRangeBounds();
        const hasFullRange = !!(from && to);
        const rangeStart = hasFullRange ? (from <= to ? from : to) : null;
        const rangeEnd   = hasFullRange ? (from <= to ? to : from) : null;

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

        const renderDay = (date, extra) => {
            const cls = ['dark-calendar-day', ...(extra || [])];
            if (this.isSameDay(date, today)) cls.push('today');
            if (this.isSameDay(date, this.selectedDate)) cls.push('selected');
            // Range highlighting — only when both endpoints are set
            if (hasFullRange) {
                if (this.isSameDay(date, rangeStart)) cls.push('range-start');
                if (this.isSameDay(date, rangeEnd)) cls.push('range-end');
                if (this.isBetween(new Date(date), rangeStart, rangeEnd)) cls.push('in-range');
            }
            return `<button type="button" class="${cls.join(' ')}" data-y="${date.getFullYear()}" data-m="${date.getMonth()}" data-d="${date.getDate()}">${date.getDate()}</button>`;
        };

        for (let i = firstWeekday - 1; i >= 0; i--) {
            const d = new Date(year, month - 1, prevMonthDays - i);
            html += renderDay(d, ['other']);
        }
        for (let d = 1; d <= daysInMonth; d++) {
            html += renderDay(new Date(year, month, d));
        }
        const totalCells = firstWeekday + daysInMonth;
        const trailingNeeded = (7 - (totalCells % 7)) % 7;
        for (let i = 1; i <= trailingNeeded; i++) {
            const d = new Date(year, month + 1, i);
            html += renderDay(d, ['other']);
        }

        html += `
            </div>
            <div class="dark-calendar-footer">
                <button type="button" class="dark-calendar-action" data-action="clear">
                    <i class="fas fa-xmark"></i> Clear
                </button>
                <button type="button" class="dark-calendar-action primary" data-action="today">
                    <i class="fas fa-location-crosshairs"></i> Today
                </button>
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
