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
} from '../utils/helpers.js';
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

const METRICS = [
    { key: 'weight',     label: 'Body weight', unitFromSettings: true },
    { key: 'bodyFat',    label: 'Body fat %',  unit: '%' },
    { key: 'chest',      label: 'Chest' },
    { key: 'waist',      label: 'Waist' },
    { key: 'hips',       label: 'Hips' },
    { key: 'armLeft',    label: 'Arm (L)' },
    { key: 'armRight',   label: 'Arm (R)' },
    { key: 'thighLeft',  label: 'Thigh (L)' },
    { key: 'thighRight', label: 'Thigh (R)' },
];

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
        const weightUnit = this.app.settings?.weightUnit || 'kg';
        const lengthUnit = weightUnit === 'lb' ? 'in' : 'cm';
        return metric.unit || (metric.unitFromSettings ? weightUnit : lengthUnit);
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

        const settings = this.app.settings || {};
        const weightUnit = settings.weightUnit || 'kg';
        const lengthUnit = weightUnit === 'lb' ? 'in' : 'cm';
        const goals = this.loadGoals();

        const tiles = METRICS.map(({ key, label, unitFromSettings, unit }) => {
            // chronological for sparkline + delta math
            const series = items
                .filter(m => m[key] !== null && m[key] !== undefined)
                .map(m => ({ date: m.date, value: Number(m[key]) }))
                .sort((a, b) => parseLocalDate(a.date) - parseLocalDate(b.date));
            if (series.length === 0) return '';

            const latest = series[series.length - 1];
            const cutoff = new Date();
            cutoff.setDate(cutoff.getDate() - 30);
            cutoff.setHours(0, 0, 0, 0);
            const baseline = series.find(p => parseLocalDate(p.date) >= cutoff) || series[0];
            const delta = round1(latest.value - baseline.value);

            const tileUnit = unit || (unitFromSettings ? weightUnit : lengthUnit);
            const deltaSign = delta > 0 ? '+' : '';
            const deltaClass = delta === 0 ? '' : (delta > 0 ? 'is-up' : 'is-down');

            // Goal progress runs from the earliest logged value (baseline)
            // toward the target, so it reflects the whole tracked span.
            const goal = goals[key];
            const percent = goal ? computeGoalProgress(series[0].value, latest.value, goal) : null;
            const goalLabel = goal && Number.isFinite(Number(goal.target))
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

        if (caption) caption.textContent = `${items.length} ${items.length === 1 ? 'entry' : 'entries'}`;
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
        const settings = this.app.settings || {};
        const weightUnit = settings.weightUnit || 'kg';
        const lengthUnit = weightUnit === 'lb' ? 'in' : 'cm';

        list.innerHTML = items.map(m => {
            const stats = METRICS
                .map(({ key, label, unit, unitFromSettings }) => {
                    const v = m[key];
                    if (v === null || v === undefined) return null;
                    const u = unit || (unitFromSettings ? weightUnit : lengthUnit);
                    return `<span class="m-stat"><b>${escapeHtml(label)}:</b> ${round1(v)} ${escapeHtml(u)}</span>`;
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
        // Push the value through the wrapped DarkCalendar so its trigger
        // label shows the same date as the underlying input.
        if (this.dateCalendar) this.dateCalendar.selectDate(parseLocalDate(dateValue));
        setVal('#m-weight', m?.weight);
        setVal('#m-bodyfat', m?.bodyFat);
        setVal('#m-chest', m?.chest);
        setVal('#m-waist', m?.waist);
        setVal('#m-hips', m?.hips);
        setVal('#m-armleft', m?.armLeft);
        setVal('#m-armright', m?.armRight);
        setVal('#m-thighleft', m?.thighLeft);
        setVal('#m-thighright', m?.thighRight);
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
        if (targetInput) targetInput.value = goal ? goal.target : '';
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

        const goals = this.loadGoals();
        goals[this.goalMetricKey] = { target, direction };
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

    saveFromForm() {
        const get = (id) => document.getElementById(id)?.value ?? '';
        const data = {
            date: get('m-date') || getTodayDateString(),
            weight: get('m-weight'),
            bodyFat: get('m-bodyfat'),
            chest: get('m-chest'),
            waist: get('m-waist'),
            hips: get('m-hips'),
            armLeft: get('m-armleft'),
            armRight: get('m-armright'),
            thighLeft: get('m-thighleft'),
            thighRight: get('m-thighright'),
            notes: get('m-notes').trim(),
        };

        const hasAnyValue = METRICS.some(({ key }) => data[key] !== '' && data[key] != null);
        if (!hasAnyValue) {
            showToast('Enter at least one measurement', 'error');
            return;
        }

        if (this.editingId != null) {
            const target = Number(this.editingId);
            const idx = (this.app.measurements || []).findIndex(m => Number(m.id) === target);
            if (idx === -1) return;
            const updated = new Measurement({
                ...this.app.measurements[idx].toJSON(),
                ...data,
            });
            this.app.measurements[idx] = updated;
            this.app.saveMeasurements();
            showToast('Measurement updated', 'success');
        } else {
            this.app.addMeasurement(new Measurement(data));
            showToast('Measurement saved', 'success');
        }

        document.getElementById('measurement-modal').classList.remove('active');
        this.editingId = null;
        this.render();
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
