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
} from '../utils/helpers.js';
import { trapModalFocus } from '../utils/modal-focus.js';

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
    }

    /** One-time DOM wiring. The view is rendered every show via render(). */
    bindOnce() {
        const addBtn = document.getElementById('add-measurement-btn');
        if (addBtn) addBtn.addEventListener('click', () => this.openModal());

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
        const m = id ? (this.app.measurements || []).find(x => x.id === id) : null;
        titleEl.textContent = m ? 'Edit measurements' : 'Log measurements';

        const setVal = (selector, value) => {
            const el = document.querySelector(selector);
            if (el) el.value = value === null || value === undefined ? '' : value;
        };
        setVal('#m-date', m?.date || getTodayDateString());
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

        // Block submit when nothing was entered — the empty-state record
        // would clutter History and screw up sparklines.
        const hasAnyValue = METRICS.some(({ key }) => data[key] !== '' && data[key] != null);
        if (!hasAnyValue) {
            showToast('Enter at least one measurement', 'error');
            return;
        }

        if (this.editingId) {
            const idx = (this.app.measurements || []).findIndex(m => m.id === this.editingId);
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
        const m = (this.app.measurements || []).find(x => x.id === id);
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
