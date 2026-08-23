/**
 * Measurements view — log + history + per-metric trend tiles.
 *
 * Stores entries via app.measurements (synced through the standard
 * gymTrackerMeasurements localStorage key). Renders three sections:
 *   - Trends grid: a tile per tracked metric with the latest value,
 *     30-day delta, and a tiny inline-SVG sparkline.
 *   - History: chronological list with edit / delete actions.
 *   - Empty state when there's nothing to show yet.
 */

import { app } from '../app.js';
import { Measurement } from '../models/Measurement.js';
import {
    showToast,
    showConfirmModal,
    parseLocalDate,
    formatDate,
    escapeHtml,
    getTodayDateString,
    computeGoalProgress,
    pluralize,
} from '../utils/helpers.js';
import {
    displayLength, displayWeight, lengthUnitFor, normalizeWeightUnit,
    toCanonicalLength, toCanonicalWeight,
} from '../utils/units.js';
import { trapModalFocus } from '../utils/modal-focus.js';
import { on, EVENTS } from '../utils/event-bus.js';
import { DarkCalendar } from '../utils/dark-calendar.js';
import { DarkSelect } from '../utils/dark-select.js';
import { storageService } from '../services/StorageService.js';

/**
 * Item 7: per-metric goal targets, keyed by metric id.
 * Shape: { [metricKey]: { target: number, direction: 'increase' | 'decrease' } }
 * Kept out of the measurement entries so clearing a goal never touches history.
 */
const GOALS_KEY = 'gymTrackerMeasurementGoals';

/**
 * Every tracked metric, with the KIND of quantity it is.
 *
 * `kind` drives both storage and display: 'weight' values are stored in
 * canonical kilograms, 'length' values in canonical centimetres, and
 * 'percent' values are unitless. The view converts on the way in and on the
 * way out (utils/units.js), so switching kg to lb converts an 81.5 kg body
 * weight to 179.7 lb rather than relabelling it "81.5 lb" (GT-03).
 */
const METRICS = [
    { key: 'weight',     label: 'Body weight', kind: 'weight', unitFromSettings: true },
    { key: 'bodyFat',    label: 'Body fat %',  kind: 'percent', unit: '%' },
    { key: 'chest',      label: 'Chest', kind: 'length' },
    { key: 'waist',      label: 'Waist', kind: 'length' },
    { key: 'hips',       label: 'Hips', kind: 'length' },
    { key: 'armLeft',    label: 'Arm (L)', kind: 'length' },
    { key: 'armRight',   label: 'Arm (R)', kind: 'length' },
    { key: 'thighLeft',  label: 'Thigh (L)', kind: 'length' },
    { key: 'thighRight', label: 'Thigh (R)', kind: 'length' },
];

/** The input id for each metric, so the form and the model stay in step. */
const METRIC_INPUT_IDS = {
    weight: 'm-weight',
    bodyFat: 'm-bodyfat',
    chest: 'm-chest',
    waist: 'm-waist',
    hips: 'm-hips',
    armLeft: 'm-armleft',
    armRight: 'm-armright',
    thighLeft: 'm-thighleft',
    thighRight: 'm-thighright',
};

/**
 * Range and date validation for a measurement entry, in CANONICAL units
 * (kg / cm / %). The form is `novalidate` (its inputs hide behind the dark
 * calendar and unit-aware labels), so nothing ever enforced the `min` /
 * `max` the inputs declare: -5 kg, 150 % body fat, 10,000,000 kg and dates
 * in 2030 were stored and drove every trend tile (2026-08-22 audit D3).
 * Returns null when fine, else `{ key, message }` naming the first bad field
 * (`key` is a METRICS key or 'date').
 */
const MEASUREMENT_LIMITS = {
    weight: { max: 700, label: 'Body weight', unit: 'kg' },
    bodyFat: { max: 100, label: 'Body fat', unit: '%' },
    length: { max: 500, label: null, unit: 'cm' },
};

function validateMeasurementEntry(data, todayKey) {
    const m = typeof data.date === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(data.date);
    // Round-trip the parts: `new Date('2026-02-29')` silently becomes March 1.
    const parsed = m && new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (!parsed || parsed.getMonth() !== Number(m[2]) - 1 || parsed.getDate() !== Number(m[3])) {
        return { key: 'date', message: 'Enter a valid date' };
    }
    if (todayKey && data.date > todayKey) {
        return { key: 'date', message: 'Measurements cannot be dated in the future' };
    }
    for (const metric of METRICS) {
        const v = data[metric.key];
        if (v === '' || v === null || v === undefined) continue;
        const limit = metric.kind === 'length' ? MEASUREMENT_LIMITS.length
            : (metric.key === 'bodyFat' ? MEASUREMENT_LIMITS.bodyFat : MEASUREMENT_LIMITS.weight);
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
            return { key: metric.key, message: `${metric.label} must be a number of 0 or more` };
        }
        if (v > limit.max) {
            return { key: metric.key, message: `${metric.label} cannot be more than ${limit.max} ${limit.unit}` };
        }
    }
    return null;
}

class MeasurementsView {
    constructor() {
        this.app = app;
        this.app.viewControllers.measurements = this;
        this.editingId = null;
        this.bindOnce();
        on(EVENTS.MEASUREMENTS_CHANGED, () => {
            if (this.app.currentView === 'measurements') this.render();
        });
    }

    /** One-time DOM wiring. The view is rendered every show via render(). */
    bindOnce() {
        const addBtn = document.getElementById('add-measurement-btn');
        if (addBtn) addBtn.addEventListener('click', () => this.openModal());

        // Wrap the modal date input with DarkCalendar so it visually
        // matches the History view's date filters (and any other calendar
        // surface). Idempotent — guarded by the same dataset flag the
        // History view uses.
        const dateInput = document.getElementById('m-date');
        if (dateInput && !dateInput.dataset.darkCalendarInit) {
            this.dateCalendar = new DarkCalendar(dateInput);
            dateInput.dataset.darkCalendarInit = '1';
        }

        const modal = document.getElementById('measurement-modal');
        if (modal) {
            modal.querySelectorAll('.modal-close').forEach(btn => {
                btn.addEventListener('click', () => modal.classList.remove('active'));
            });
        }

        const form = document.getElementById('measurement-form');
        if (form) {
            form.addEventListener('submit', (e) => {
                e.preventDefault();
                this.saveFromForm();
            });
        }

        // Delegated history actions: edit / delete.
        const list = document.getElementById('measurements-history');
        if (list) {
            list.addEventListener('click', (e) => {
                const btn = e.target.closest('[data-action]');
                if (!btn) return;
                const id = Number(btn.dataset.id);
                if (btn.dataset.action === 'edit-measurement') this.openModal(id);
                if (btn.dataset.action === 'delete-measurement') this.confirmDelete(id);
            });
        }

        // Delegated trend-tile actions: set/edit a goal.
        const grid = document.getElementById('measurements-trends-grid');
        if (grid) {
            grid.addEventListener('click', (e) => {
                const btn = e.target.closest('[data-action="set-goal"]');
                if (btn) this.openGoalModal(btn.dataset.metric);
            });
        }

        const goalModal = document.getElementById('measurement-goal-modal');
        if (goalModal) {
            goalModal.querySelectorAll('.modal-close').forEach(btn => {
                btn.addEventListener('click', () => goalModal.classList.remove('active'));
            });
        }

        const directionSelect = document.getElementById('goal-direction');
        if (directionSelect && !directionSelect.dataset.darkSelectInit) {
            this.directionDropdown = new DarkSelect(directionSelect);
            directionSelect.dataset.darkSelectInit = '1';
        }

        const goalForm = document.getElementById('measurement-goal-form');
        if (goalForm) {
            goalForm.addEventListener('submit', (e) => {
                e.preventDefault();
                this.saveGoalFromForm();
            });
        }

        const clearGoalBtn = document.getElementById('goal-clear-btn');
        if (clearGoalBtn) clearGoalBtn.addEventListener('click', () => this.clearGoal());
    }

    /** All stored goals, keyed by metric id. Junk in storage reads as none. */
    loadGoals() {
        const raw = storageService.get(GOALS_KEY, {});
        return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    }

    saveGoals(goals) {
        storageService.set(GOALS_KEY, goals);
    }

    /** Display unit for a metric, matching the tile / history rendering. */
    unitForMetric(metric) {
        if (metric.kind === 'percent') return metric.unit || '%';
        const weightUnit = normalizeWeightUnit(this.app.settings?.weightUnit);
        return metric.kind === 'weight' ? weightUnit : lengthUnitFor(weightUnit);
    }

    /** A canonical stored value -> the number to show for that metric. */
    displayValue(metric, canonical) {
        if (canonical === null || canonical === undefined || canonical === '') return null;
        if (metric.kind === 'weight') {
            return Number(displayWeight(canonical, normalizeWeightUnit(this.app.settings?.weightUnit)));
        }
        if (metric.kind === 'length') {
            return Number(displayLength(canonical, lengthUnitFor(this.app.settings?.weightUnit)));
        }
        return Number(canonical);
    }

    /** A user-entered value -> the canonical value to store. */
    canonicalValue(metric, entered) {
        if (entered === '' || entered === null || entered === undefined) return '';
        if (metric.kind === 'weight') {
            return toCanonicalWeight(entered, normalizeWeightUnit(this.app.settings?.weightUnit));
        }
        if (metric.kind === 'length') {
            return toCanonicalLength(entered, lengthUnitFor(this.app.settings?.weightUnit));
        }
        return Number(entered);
    }

    /**
     * GT-31: the entry form used to ask for "Body weight", "Chest", "Waist"
     * with a bare dash placeholder and no unit anywhere, so the user only
     * discovered what was expected after saving. Every label now carries the
     * active unit, and the placeholder shows it too.
     */
    syncFormUnitLabels() {
        METRICS.forEach((metric) => {
            const id = METRIC_INPUT_IDS[metric.key];
            const input = document.getElementById(id);
            if (!input) return;
            const unit = this.unitForMetric(metric);
            const label = document.querySelector(`label[for="${id}"]`);
            if (label) label.textContent = `${metric.label} (${unit})`;
            input.placeholder = unit;
            input.setAttribute('aria-label', `${metric.label} in ${unit}`);
        });
    }

    render() {
        const items = (this.app.measurements || []).slice()
            .sort((a, b) => parseLocalDate(b.date) - parseLocalDate(a.date));
        const empty = document.getElementById('measurements-empty');
        const trends = document.getElementById('measurements-trends-section');
        const history = document.getElementById('measurements-history-section');

        if (items.length === 0) {
            if (empty) empty.hidden = false;
            if (trends) trends.hidden = true;
            if (history) history.hidden = true;
            return;
        }
        if (empty) empty.hidden = true;
        if (trends) trends.hidden = false;
        if (history) history.hidden = false;

        this.renderTrends(items);
        this.renderHistory(items);
    }

    /**
     * For each metric: latest value, 30-day delta, sparkline. Only metrics
     * with at least one logged value render a tile (so a user who only
     * tracks weight + waist doesn't see seven empty tiles).
     */
    renderTrends(items) {
        const grid = document.getElementById('measurements-trends-grid');
        const caption = document.getElementById('measurements-trends-caption');
        if (!grid) return;

        const goals = this.loadGoals();

        const tiles = METRICS.map((metric) => {
            const { key, label } = metric;
            // Chronological, and already converted into the display unit, so
            // the sparkline, the delta and the goal maths all agree with the
            // number printed above them.
            const series = items
                .filter(m => m[key] !== null && m[key] !== undefined)
                .map(m => ({ date: m.date, value: this.displayValue(metric, m[key]) }))
                .filter(p => Number.isFinite(p.value))
                .sort((a, b) => parseLocalDate(a.date) - parseLocalDate(b.date));
            if (series.length === 0) return '';

            const latest = series[series.length - 1];
            const cutoff = new Date();
            cutoff.setDate(cutoff.getDate() - 30);
            cutoff.setHours(0, 0, 0, 0);
            const baseline = series.find(p => parseLocalDate(p.date) >= cutoff) || series[0];
            const delta = round1(latest.value - baseline.value);

            const tileUnit = this.unitForMetric(metric);
            const deltaSign = delta > 0 ? '+' : '';
            const deltaClass = delta === 0 ? '' : (delta > 0 ? 'is-up' : 'is-down');

            // Goal progress runs from the earliest logged value (baseline)
            // toward the target, so it reflects the whole tracked span.
            // Goal targets are stored canonically too, so they convert with
            // everything else rather than being read as the current unit.
            const rawGoal = goals[key];
            const goalTarget = rawGoal ? this.displayValue(metric, rawGoal.target) : null;
            const goal = rawGoal && Number.isFinite(goalTarget)
                ? { ...rawGoal, target: goalTarget } : null;
            const percent = goal ? computeGoalProgress(series[0].value, latest.value, goal) : null;
            const goalLabel = goal
                ? `Goal: ${round1(goal.target)} ${tileUnit}`
                : 'Set goal';

            return `
                <div class="measurement-tile">
                    <div class="measurement-tile-label">${escapeHtml(label)}</div>
                    <div class="measurement-tile-value">
                        ${round1(latest.value)} <small>${escapeHtml(tileUnit)}</small>
                    </div>
                    <div class="measurement-tile-delta ${deltaClass}">
                        ${deltaSign}${delta} ${escapeHtml(tileUnit)} <span>vs 30d</span>
                    </div>
                    ${this.renderSparkline(series)}
                    ${percent === null ? '' : `
                        <div class="measurement-goal" data-metric="${escapeHtml(key)}">
                            <div class="measurement-goal-track" role="img" aria-label="${percent}% to goal">
                                <div class="measurement-goal-fill" style="width: ${percent}%"></div>
                            </div>
                            <div class="measurement-goal-pct">${percent}% to goal</div>
                        </div>
                    `}
                    <button type="button" class="measurement-goal-btn" data-action="set-goal"
                            data-metric="${escapeHtml(key)}"
                            aria-label="Set goal for ${escapeHtml(label)}">
                        ${escapeHtml(goalLabel)}
                    </button>
                </div>
            `;
        }).filter(Boolean).join('');

        grid.innerHTML = tiles;

        if (caption) caption.textContent = pluralize(items.length, 'entry', 'entries');
    }

    /** Tiny inline-SVG sparkline. Skips when fewer than 2 points. */
    renderSparkline(series) {
        if (series.length < 2) return '';
        const W = 110;
        const H = 32;
        const pad = 2;
        const ys = series.map(p => p.value);
        const min = Math.min(...ys);
        const max = Math.max(...ys);
        const range = Math.max(1e-9, max - min);
        const stepX = (W - pad * 2) / (series.length - 1);
        const points = series.map((p, i) => {
            const x = pad + i * stepX;
            const y = pad + (1 - (p.value - min) / range) * (H - pad * 2);
            return `${x.toFixed(1)},${y.toFixed(1)}`;
        }).join(' ');
        return `
            <svg class="measurement-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
                <polyline points="${points}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
        `;
    }

    renderHistory(items) {
        const list = document.getElementById('measurements-history');
        if (!list) return;
        list.innerHTML = items.map(m => {
            const stats = METRICS
                .map((metric) => {
                    const v = m[metric.key];
                    if (v === null || v === undefined) return null;
                    const shown = this.displayValue(metric, v);
                    const u = this.unitForMetric(metric);
                    return `<span class="m-stat"><b>${escapeHtml(metric.label)}:</b> ${round1(shown)} ${escapeHtml(u)}</span>`;
                })
                .filter(Boolean)
                .join('');
            return `
                <article class="measurement-row">
                    <header class="measurement-row-header">
                        <h3>${escapeHtml(formatDate(m.date))}</h3>
                        <div class="measurement-row-actions">
                            <button type="button" class="btn-icon" data-action="edit-measurement" data-id="${m.id}" aria-label="Edit measurement" title="Edit">
                                <i class="fas fa-edit"></i>
                            </button>
                            <button type="button" class="btn-icon btn-icon-danger" data-action="delete-measurement" data-id="${m.id}" aria-label="Delete measurement" title="Delete">
                                <i class="fas fa-trash"></i>
                            </button>
                        </div>
                    </header>
                    <div class="measurement-row-stats">${stats || '<em>(no values)</em>'}</div>
                    ${m.notes ? `<p class="measurement-row-notes">${escapeHtml(m.notes)}</p>` : ''}
                </article>
            `;
        }).join('');
    }

    openModal(id = null) {
        const modal = document.getElementById('measurement-modal');
        const titleEl = document.getElementById('measurement-modal-title');
        if (!modal || !titleEl) return;

        this.editingId = id;
        const target = id != null ? Number(id) : null;
        const m = target != null
            ? (this.app.measurements || []).find(x => Number(x.id) === target)
            : null;
        titleEl.textContent = m ? 'Edit measurements' : 'Log measurements';

        const setVal = (selector, value) => {
            const el = document.querySelector(selector);
            if (el) el.value = value === null || value === undefined ? '' : value;
        };
        const dateValue = m?.date || getTodayDateString();
        setVal('#m-date', dateValue);
        // A measurement is a record of something that happened: never a
        // future date (the native picker honours max; saveFromForm enforces it).
        const dateEl = document.getElementById('m-date');
        if (dateEl) dateEl.max = getTodayDateString();
        this.clearEntryError();
        // Push the value through the wrapped DarkCalendar so its trigger
        // label shows the same date as the underlying input.
        if (this.dateCalendar) this.dateCalendar.selectDate(parseLocalDate(dateValue));

        // GT-31: labels say which unit is expected, and stored canonical
        // values are converted into that unit before they reach the inputs.
        this.syncFormUnitLabels();
        METRICS.forEach((metric) => {
            const id = METRIC_INPUT_IDS[metric.key];
            const shown = m ? this.displayValue(metric, m[metric.key]) : null;
            setVal(`#${id}`, Number.isFinite(shown) ? round1(shown) : '');
        });
        setVal('#m-notes', m?.notes || '');

        modal.classList.add('active');
        trapModalFocus(modal);
    }

    openGoalModal(metricKey) {
        const metric = METRICS.find(m => m.key === metricKey);
        const modal = document.getElementById('measurement-goal-modal');
        if (!metric || !modal) return;

        this.goalMetricKey = metric.key;
        const goal = this.loadGoals()[metric.key] || null;

        const titleEl = document.getElementById('measurement-goal-modal-title');
        if (titleEl) titleEl.textContent = `${metric.label} goal`;
        const unitEl = document.getElementById('goal-target-unit');
        if (unitEl) unitEl.textContent = `(${this.unitForMetric(metric)})`;

        const targetInput = document.getElementById('goal-target');
        if (targetInput) {
            const shown = goal ? this.displayValue(metric, goal.target) : null;
            targetInput.value = Number.isFinite(shown) ? round1(shown) : '';
        }
        const directionSelect = document.getElementById('goal-direction');
        if (directionSelect) {
            directionSelect.value = goal?.direction === 'increase' ? 'increase' : 'decrease';
            if (this.directionDropdown) this.directionDropdown.sync();
        }
        const clearBtn = document.getElementById('goal-clear-btn');
        if (clearBtn) clearBtn.hidden = !goal;

        modal.classList.add('active');
        trapModalFocus(modal);
    }

    saveGoalFromForm() {
        if (!this.goalMetricKey) return;
        const target = Number(document.getElementById('goal-target')?.value);
        if (!Number.isFinite(target)) {
            showToast('Enter a target value', 'error');
            return;
        }
        const direction = document.getElementById('goal-direction')?.value === 'increase'
            ? 'increase'
            : 'decrease';

        // Stored canonically (kg / cm), like the measurements it is compared
        // against, so the goal keeps its meaning across a unit switch.
        const metric = METRICS.find(m => m.key === this.goalMetricKey);
        const canonicalTarget = metric ? this.canonicalValue(metric, target) : target;

        const goals = this.loadGoals();
        goals[this.goalMetricKey] = { target: canonicalTarget, direction };
        this.saveGoals(goals);

        document.getElementById('measurement-goal-modal').classList.remove('active');
        this.goalMetricKey = null;
        showToast('Goal saved', 'success');
        this.render();
    }

    /** Remove just this metric's goal. Measurement history is untouched. */
    clearGoal() {
        if (!this.goalMetricKey) return;
        const goals = this.loadGoals();
        delete goals[this.goalMetricKey];
        this.saveGoals(goals);

        document.getElementById('measurement-goal-modal').classList.remove('active');
        this.goalMetricKey = null;
        showToast('Goal cleared', 'info');
        this.render();
    }

    /** Mark one entry input invalid with a message; the toast repeats it. */
    showEntryError(key, message) {
        const id = key === 'date' ? 'm-date' : METRIC_INPUT_IDS[key];
        const el = document.getElementById(id);
        if (el) {
            el.setAttribute('aria-invalid', 'true');
            el.classList.add('is-invalid');
            if (typeof el.focus === 'function') el.focus();
        }
        showToast(message, 'error');
    }

    clearEntryError() {
        const form = document.getElementById('measurement-form');
        if (!form || typeof form.querySelectorAll !== 'function') return;
        form.querySelectorAll('[aria-invalid]').forEach((el) => {
            el.removeAttribute('aria-invalid');
            el.classList.remove('is-invalid');
        });
    }

    saveFromForm() {
        // Two taps on Save before the modal closed produced two records
        // (2026-08-22 audit D16); the program and custom-exercise forms carry
        // the same in-flight guard.
        if (this._saving) return;
        this._saving = true;
        let saved = false;
        try {
            saved = this._saveFromFormNow() === true;
        } finally {
            // A successful save keeps the guard up briefly so a second tap
            // that lands after the modal closed cannot re-submit the same
            // values (the program form uses the same 500 ms window).
            if (saved) setTimeout(() => { this._saving = false; }, 500);
            else this._saving = false;
        }
    }

    _saveFromFormNow() {
        const get = (id) => document.getElementById(id)?.value ?? '';
        // Entered in the display unit; stored canonically (kg / cm), so the
        // record keeps its meaning when the preference changes later.
        const data = {
            date: get('m-date') || getTodayDateString(),
            notes: get('m-notes').trim(),
        };
        METRICS.forEach((metric) => {
            data[metric.key] = this.canonicalValue(metric, get(METRIC_INPUT_IDS[metric.key]));
        });

        const hasAnyValue = METRICS.some(({ key }) => data[key] !== '' && data[key] != null);
        if (!hasAnyValue) {
            showToast('Enter at least one measurement', 'error');
            return;
        }
        this.clearEntryError();
        const problem = validateMeasurementEntry(data, getTodayDateString());
        if (problem) {
            this.showEntryError(problem.key, problem.message);
            return;
        }

        if (this.editingId != null) {
            const target = Number(this.editingId);
            const idx = (this.app.measurements || []).findIndex(m => Number(m.id) === target);
            if (idx === -1) return;
            const updated = new Measurement({
                ...this.app.measurements[idx].toJSON(),
                ...data,
                // The form always submits canonical kg/cm (readCanonical
                // converts on the way out of the inputs), so an edited record
                // is canonical whatever the original was.
                unitsCanonical: true,
            });
            this.app.measurements[idx] = updated;
            this.app.saveMeasurements();
            showToast('Measurement updated', 'success');
        } else {
            this.app.addMeasurement(new Measurement({ ...data, unitsCanonical: true }));
            showToast('Measurement saved', 'success');
        }

        document.getElementById('measurement-modal').classList.remove('active');
        this.editingId = null;
        this.render();
        return true;
    }

    async confirmDelete(id) {
        const target = Number(id);
        const m = (this.app.measurements || []).find(x => Number(x.id) === target);
        if (!m) return;
        const confirmed = await showConfirmModal({
            title: 'Delete measurement',
            message: `Remove the measurement entry from <strong>${escapeHtml(formatDate(m.date))}</strong>?`,
            warning: 'This cannot be undone.',
            confirmText: 'Delete',
            cancelText: 'Cancel',
            isDangerous: true,
        });
        if (!confirmed) return;
        this.app.deleteMeasurement(id);
        showToast('Measurement deleted', 'info');
        this.render();
    }
}

function round1(v) {
    return Math.round(Number(v) * 10) / 10;
}

new MeasurementsView();
