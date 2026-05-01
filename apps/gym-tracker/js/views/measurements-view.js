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
import { on, EVENTS } from '../utils/event-bus.js';
import { uploadMeasurementPhoto, deleteMeasurementPhoto } from '../utils/photo-store.js';

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
        // Buffer of photo URLs while the modal is open. Persisted into the
        // Measurement record on save; trashed on cancel-without-save.
        this.modalPhotos = [];

        const addBtn = document.getElementById('add-measurement-btn');
        if (addBtn) addBtn.addEventListener('click', () => this.openModal());

        const photoBtn = document.getElementById('m-photos-add-btn');
        const photoInput = document.getElementById('m-photos-input');
        if (photoBtn && photoInput) {
            photoBtn.addEventListener('click', () => photoInput.click());
            photoInput.addEventListener('change', (e) => this.uploadPickedPhotos(e.target.files));
        }
        const photoGrid = document.getElementById('m-photos-grid');
        if (photoGrid) {
            photoGrid.addEventListener('click', (e) => {
                const btn = e.target.closest('[data-action="remove-photo"]');
                if (!btn) return;
                const idx = Number(btn.dataset.index);
                this.removeModalPhoto(idx);
            });
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
                    ${Array.isArray(m.photos) && m.photos.length > 0 ? `
                        <div class="measurement-row-photos">
                            ${m.photos.map((url, i) => `<a href="${escapeHtml(url)}" target="_blank" rel="noopener" aria-label="Photo ${i + 1}"><img src="${escapeHtml(url)}" alt="Progress photo ${i + 1}" loading="lazy"></a>`).join('')}
                        </div>` : ''}
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

        // Photo buffer: clone existing URLs (so cancel reverts) and render.
        this.modalPhotos = Array.isArray(m?.photos) ? m.photos.slice() : [];
        this.renderModalPhotos();
        const status = document.getElementById('m-photos-status');
        if (status) status.textContent = '';

        modal.classList.add('active');
        trapModalFocus(modal);
    }

    /** Re-render the thumbnail strip inside the open modal. */
    renderModalPhotos() {
        const grid = document.getElementById('m-photos-grid');
        if (!grid) return;
        if (this.modalPhotos.length === 0) {
            grid.innerHTML = '<p class="settings-help-text">No photos yet — tap below to add.</p>';
            return;
        }
        grid.innerHTML = this.modalPhotos.map((url, i) => `
            <div class="m-photo-tile">
                <img src="${escapeHtml(url)}" alt="Progress photo ${i + 1}" loading="lazy">
                <button type="button" class="m-photo-remove" data-action="remove-photo" data-index="${i}" aria-label="Remove photo ${i + 1}" title="Remove">
                    <i class="fas fa-xmark"></i>
                </button>
            </div>
        `).join('');
    }

    /**
     * Upload selected files (compressing client-side) and append the
     * resulting download URLs to modalPhotos. Bails out with a toast if
     * the user is signed out — Storage rules require auth.
     */
    async uploadPickedPhotos(fileList) {
        if (!fileList || fileList.length === 0) return;
        const user = window.firebaseAuth?.getCurrentUser?.()
            || (typeof firebase !== 'undefined' && firebase.auth?.().currentUser)
            || null;
        if (!user) {
            showToast('Sign in to upload photos', 'error');
            return;
        }
        // Use the editing measurement's id as the storage folder so
        // photos for unrelated entries don't collide. For brand-new
        // entries pre-save, mint a temporary id and stick it on the
        // Measurement we'll write at save time.
        if (!this.editingId) {
            this.editingId = `tmp-${Date.now()}`;
        }
        const status = document.getElementById('m-photos-status');
        if (status) status.textContent = `Uploading ${fileList.length} photo${fileList.length === 1 ? '' : 's'}…`;
        try {
            for (const file of fileList) {
                const url = await uploadMeasurementPhoto(this.editingId, file, user.uid);
                this.modalPhotos.push(url);
                this.renderModalPhotos();
            }
            if (status) status.textContent = `Added ${fileList.length} photo${fileList.length === 1 ? '' : 's'}.`;
        } catch (err) {
            console.error('Photo upload failed', err);
            if (status) status.textContent = 'Upload failed — try again.';
            showToast('Photo upload failed', 'error');
        } finally {
            // Reset the input so picking the same file twice still fires change.
            const input = document.getElementById('m-photos-input');
            if (input) input.value = '';
        }
    }

    /** Drop a photo from the modal buffer + best-effort delete from Storage. */
    removeModalPhoto(index) {
        if (index < 0 || index >= this.modalPhotos.length) return;
        const [removed] = this.modalPhotos.splice(index, 1);
        this.renderModalPhotos();
        // Fire-and-forget — we don't surface failures because the URL is
        // already detached from the measurement.
        deleteMeasurementPhoto(removed);
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
            photos: this.modalPhotos.slice(),
        };

        // Allow saves with no metrics if photos were attached — a "today
        // I felt like recording a photo" entry is legitimate.
        const hasAnyValue = METRICS.some(({ key }) => data[key] !== '' && data[key] != null)
            || data.photos.length > 0;
        if (!hasAnyValue) {
            showToast('Enter at least one measurement or photo', 'error');
            return;
        }

        // If editingId is a temp string ("tmp-..."), this is a brand-new
        // entry that minted an id during photo upload. Drop the temp,
        // let the constructor mint a real numeric id.
        const isTemp = typeof this.editingId === 'string' && this.editingId.startsWith('tmp-');

        if (this.editingId != null && !isTemp) {
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
        this.modalPhotos = [];
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
