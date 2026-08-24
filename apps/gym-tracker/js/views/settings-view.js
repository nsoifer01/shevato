/**
 * Settings View Controller
 */
import { app } from '../app.js';
import {
    showToast,
    downloadJSON,
    downloadText,
    buildSetsCsv,
    showConfirmModal,
} from '../utils/helpers.js';
import { DarkSelect } from '../utils/dark-select.js';
import { WARMUP_DEFAULTS } from '../utils/warmup.js';
import { Settings } from '../models/Settings.js';
import { IMPORT_MODES } from '../utils/import-merge.js';
import { normalizeWeightUnit } from '../utils/units.js';
import { storageService } from '../services/StorageService.js';
import { closeModalSafely, trapModalFocus } from '../utils/modal-focus.js';

/**
 * Item 6: warm-up ramp configuration. Stored under its own localStorage key
 * (not in the Settings model) because the workout view reads it directly.
 * Shape: { enabled, thresholdKg, thresholdLb, ramp: [{ pct, reps }, ...] }
 * where pct is a percentage of the working weight and pct 0 = empty bar.
 */
const WARMUP_KEY = 'gymTrackerWarmupSettings';
/** Clamp `value` into [min, max], falling back to `fallback` for junk input. */
function clampNumber(value, fallback, min, max, round = false) {
    if (value === undefined || value === null || value === '') return fallback;
    let n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    if (round) n = Math.round(n);
    return Math.min(max, Math.max(min, n));
}

/** Clamp stored/entered warm-up config into writable bounds (the lenient
 * read-side normalize lives in utils/warmup.js; this is the write-side gate). */
function clampWarmupSettings(raw) {
    const data = raw && typeof raw === 'object' ? raw : {};
    const ramp = Array.isArray(data.ramp) ? data.ramp : [];
    return {
        enabled: data.enabled !== false,
        // Thresholds stay positive: the workout-side reader treats a
        // non-positive threshold as "missing" and falls back to its default.
        thresholdKg: clampNumber(data.thresholdKg, WARMUP_DEFAULTS.thresholdKg, 1, 500),
        thresholdLb: clampNumber(data.thresholdLb, WARMUP_DEFAULTS.thresholdLb, 1, 1100),
        ramp: WARMUP_DEFAULTS.ramp.map((fallback, i) => ({
            pct: clampNumber(ramp[i]?.pct, fallback.pct, 0, 100, true),
            reps: clampNumber(ramp[i]?.reps, fallback.reps, 1, 30, true),
        })),
    };
}

function validateImportData(data) {
    if (!data) {
        return 'No data provided';
    }

    if (typeof data !== 'object') {
        return 'Invalid data format';
    }

    const hasValidStructure =
        data.hasOwnProperty('programs') ||
        data.hasOwnProperty('sessions') ||
        data.hasOwnProperty('settings');

    if (!hasValidStructure) {
        return 'Invalid data structure';
    }

    // Presence is not enough: importAllData writes each present store
    // verbatim, so a mistyped store (e.g. programs: "pwned") would replace
    // the real data with junk. Every present store must carry its expected
    // shape - list stores are arrays, settings is a plain object.
    const arrayStores = ['programs', 'sessions', 'customExercises', 'measurements', 'achievements'];
    for (const key of arrayStores) {
        if (data.hasOwnProperty(key) && !Array.isArray(data[key])) {
            return `Invalid "${key}" data: expected a list`;
        }
    }
    if (data.hasOwnProperty('settings')
        && (typeof data.settings !== 'object' || data.settings === null || Array.isArray(data.settings))) {
        return 'Invalid "settings" data: expected an object';
    }

    return null;
}

/**
 * A short, honest description of what a file actually contains, so the user
 * chooses merge vs replace against the real payload rather than a guess.
 */
function describeImport(data) {
    const count = (key) => (Array.isArray(data?.[key]) ? data[key].length : 0);
    const parts = [];
    const add = (n, singular, plural = `${singular}s`) => {
        if (n > 0) parts.push(`<strong>${n}</strong> ${n === 1 ? singular : plural}`);
    };
    add(count('programs'), 'program');
    add(count('sessions'), 'workout');
    add(count('customExercises'), 'custom exercise');
    add(count('measurements'), 'measurement');
    add(count('achievements'), 'achievement');
    if (data?.settings) parts.push('your settings');
    if (parts.length === 0) return 'This file contains no recognisable data.';
    const last = parts.pop();
    return `This file contains ${parts.length ? `${parts.join(', ')} and ${last}` : last}.`;
}

class SettingsView {
    constructor() {
        this.app = app;
        this.init();
    }

    init() {
        this.app.viewControllers.settings = this;
        this.setupEventListeners();
    }

    setupEventListeners() {
        // Mount the custom dark dropdown for the weight unit
        const weightUnitSelect = document.getElementById('weight-unit');
        if (weightUnitSelect && !weightUnitSelect.dataset.darkSelectInit) {
            this.weightUnitDropdown = new DarkSelect(weightUnitSelect);
            weightUnitSelect.dataset.darkSelectInit = '1';
        }
        // React to weight-unit changes so we can enable/disable Save
        if (weightUnitSelect) {
            weightUnitSelect.addEventListener('change', () => {
                // GT-21: the plate panel describes PHYSICAL equipment, and a
                // kg rack and an lb rack are different objects. Picking a unit
                // therefore swaps to that unit's saved profile instead of
                // leaving a kg stack sitting under an "lb" label. Nothing is
                // converted and nothing is lost: switching back brings the
                // other profile back exactly as it was.
                this.renderPlateSettings(weightUnitSelect.value);
                this.checkDirty();
            });
        }

        // Time format dropdown — same DarkSelect treatment.
        const timeFormatSelect = document.getElementById('time-format');
        if (timeFormatSelect && !timeFormatSelect.dataset.darkSelectInit) {
            this.timeFormatDropdown = new DarkSelect(timeFormatSelect);
            timeFormatSelect.dataset.darkSelectInit = '1';
        }
        if (timeFormatSelect) {
            timeFormatSelect.addEventListener('change', () => this.checkDirty());
        }

        // Alert toggles (sound + vibration, independent)
        const soundAlertsInput = document.getElementById('sound-alerts');
        if (soundAlertsInput) {
            soundAlertsInput.addEventListener('change', () => this.checkDirty());
        }
        const vibrationAlertsInput = document.getElementById('vibration-alerts');
        if (vibrationAlertsInput) {
            vibrationAlertsInput.addEventListener('change', () => this.checkDirty());
        }

        // Timer sound markers — free numeric inputs (Item R2-1).
        const firstWarnInput = document.getElementById('timer-first-warning');
        if (firstWarnInput) {
            firstWarnInput.addEventListener('input', () => this.checkDirty());
        }
        const countdownInput = document.getElementById('timer-countdown-start');
        if (countdownInput) {
            countdownInput.addEventListener('input', () => this.checkDirty());
        }

        // Calendar: first-day-of-week select (Item R2-5).
        const firstDaySelect = document.getElementById('first-day-of-week');
        if (firstDaySelect && !firstDaySelect.dataset.darkSelectInit) {
            this.firstDayDropdown = new DarkSelect(firstDaySelect);
            firstDaySelect.dataset.darkSelectInit = '1';
        }
        if (firstDaySelect) {
            firstDaySelect.addEventListener('change', () => this.checkDirty());
        }

        // Calendar: show-program-schedule toggle.
        const scheduleToggle = document.getElementById('show-program-schedule');
        if (scheduleToggle) {
            scheduleToggle.addEventListener('change', () => this.checkDirty());
        }

        // Plate calculator inputs — react on input, refresh preview, mark dirty.
        const barInput = document.getElementById('bar-weight');
        if (barInput) {
            barInput.addEventListener('input', () => {
                this.refreshPlatesPreview();
                this.checkDirty();
            });
        }
        const platesInput = document.getElementById('plates-input');
        if (platesInput) {
            platesInput.addEventListener('input', () => {
                this.refreshPlatesPreview();
                this.checkDirty();
            });
        }

        // Warm-up ramp (Item 6). These live in their own storage key and
        // persist immediately on change, so they're outside the form's
        // dirty-tracking / Save flow.
        const warmupEnabled = document.getElementById('warmup-enabled');
        if (warmupEnabled) {
            warmupEnabled.addEventListener('change', () => this.saveWarmupSettings());
        }
        ['warmup-threshold-kg', 'warmup-threshold-lb'].forEach((id) => {
            const input = document.getElementById(id);
            if (input) input.addEventListener('change', () => this.saveWarmupSettings());
        });
        const rampWrap = document.getElementById('warmup-ramp');
        if (rampWrap) {
            rampWrap.addEventListener('change', (e) => {
                if (e.target.matches('.warmup-ramp-pct, .warmup-ramp-reps')) {
                    this.saveWarmupSettings();
                }
            });
        }

        // Settings form submission
        const settingsForm = document.getElementById('settings-form');
        if (settingsForm) {
            settingsForm.addEventListener('submit', (e) => {
                e.preventDefault();
                this.saveSettings();
            });
        }

        // Export data
        const exportBtn = document.getElementById('export-data-btn');
        if (exportBtn) {
            exportBtn.addEventListener('click', () => this.exportData());
        }

        // Export every completed set as CSV (Item 8)
        const exportCsvBtn = document.getElementById('export-csv-btn');
        if (exportCsvBtn) {
            exportCsvBtn.addEventListener('click', () => this.exportSetsCsv());
        }

        // Import data
        const importBtn = document.getElementById('import-data-btn');
        const importFileInput = document.getElementById('import-file-input');
        if (importBtn && importFileInput) {
            importBtn.addEventListener('click', () => {
                importFileInput.click();
            });

            importFileInput.addEventListener('change', (e) => {
                this.importData(e.target.files[0]);
            });
        }

        // Clear data
        const clearBtn = document.getElementById('clear-data-btn');
        if (clearBtn) {
            clearBtn.addEventListener('click', async () => {
                const confirmed = await showConfirmModal({
                    title: 'Clear All Data',
                    message: 'This will permanently delete every program, workout, achievement, custom exercise, and setting.',
                    warning: 'This cannot be undone.',
                    confirmText: 'Delete Everything',
                    cancelText: 'Cancel',
                    isDangerous: true,
                });
                if (confirmed) this.app.clearAllData();
            });
        }

        // Replay onboarding — open the welcome modal directly without
        // requiring a reload, so users with existing data can see it too.
        const replayBtn = document.getElementById('replay-onboarding-btn');
        if (replayBtn) {
            replayBtn.addEventListener('click', () => {
                this.app.openOnboardingModal();
            });
        }

        // Re-check stored units. A DIAGNOSTIC, not "run every migration
        // again": it classifies each record's unit provenance, repairs only
        // the cases that can be PROVEN legacy, asks about ambiguous
        // measurements rather than guessing, and never touches a record
        // already stamped canonical. Running it on a healthy profile - or
        // twice, or after switching display units - changes nothing.
        const recheckBtn = document.getElementById('recheck-units-btn');
        if (recheckBtn && !recheckBtn.dataset.wired) {
            recheckBtn.dataset.wired = '1';
            recheckBtn.addEventListener('click', () => this.runUnitsRecheck());
        }

        // Item R2-9: unsaved-changes guard modal actions.
        const unsavedModal = document.getElementById('unsaved-settings-modal');
        if (unsavedModal && !unsavedModal.dataset.wired) {
            const close = () => { closeModalSafely(unsavedModal); this.pendingLeaveView = null; };
            document.getElementById('unsaved-settings-close')?.addEventListener('click', close);
            document.getElementById('unsaved-settings-save')?.addEventListener('click', () => {
                const target = this.pendingLeaveView;
                this.pendingLeaveView = null;
                closeModalSafely(unsavedModal);
                this.saveSettings();
                if (target) this.app.showView(target);
            });
            document.getElementById('unsaved-settings-discard')?.addEventListener('click', () => {
                const target = this.pendingLeaveView;
                this.pendingLeaveView = null;
                closeModalSafely(unsavedModal);
                // Restore the saved values so re-entering Settings shows them.
                this.render();
                if (target) this.app.showView(target);
            });
            unsavedModal.dataset.wired = '1';
        }

        // Delete cloud data — wipes the user's Firestore document so
        // signing in on a fresh device is a clean slate. Local data
        // remains untouched (the user can wipe that with Clear All Data
        // separately, or keep it as a personal backup).
        const cloudBtn = document.getElementById('delete-cloud-data-btn');
        if (cloudBtn) {
            cloudBtn.addEventListener('click', () => this.deleteCloudData());
        }
    }

    async deleteCloudData() {
        const user = window.firebaseAuth?.getCurrentUser?.() || null;
        if (!user) {
            showToast('Sign in first to delete cloud data', 'error');
            return;
        }
        const confirmed = await showConfirmModal({
            title: 'Delete cloud data',
            message: 'Wipe the gym tracker data stored in the cloud for this account. Your local data stays on this device.',
            warning: 'This cannot be undone. Other devices that sync will also lose this data on their next sync.',
            confirmText: 'Delete from cloud',
            cancelText: 'Cancel',
            isDangerous: true,
        });
        if (!confirmed) return;

        try {
            const { eraseCloudData } = await import('../../../../sync-system/storage-sync-robust.js');
            await eraseCloudData('gymTrackerApp');
            showToast('Cloud data deleted. Sign out + back in to re-sync.', 'success', 5000);
        } catch (error) {
            console.error('Failed to delete cloud data:', error);
            showToast('Could not delete cloud data. Check your connection.', 'error', 5000);
        }
    }

    /**
     * Run the unit-provenance scan and report what it found in plain terms.
     *
     * The summary distinguishes the four states the scan can reach, because
     * "nothing to do" and "I could not prove this either way" are very
     * different answers and collapsing them is what hid the original bug.
     */
    runUnitsRecheck() {
        const out = document.getElementById('recheck-units-result');
        const report = this.app.reconcileStoredUnits();

        if (!report) {
            if (out) {
                out.hidden = false;
                out.textContent = 'Could not read stored data. Nothing was changed.';
            }
            showToast('Unit check failed', 'error');
            return;
        }

        const n = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
        const parts = [`Scanned ${n(report.sessionsScanned, 'workout')} and ${n(report.measurementsScanned, 'measurement')}.`];

        if (report.sessionsRepaired > 0) {
            parts.push(`Repaired ${n(report.sessionsRepaired, 'legacy workout record')}.`);
        }
        if (report.activeWorkoutRepaired) parts.push('Repaired the in-progress workout.');
        if (report.sessionsAmbiguous > 0) {
            parts.push(`${n(report.sessionsAmbiguous, 'workout')} could not be proven either way and ${report.sessionsAmbiguous === 1 ? 'was' : 'were'} left untouched.`);
        }
        if (report.measurementsNeedingConfirmation > 0) {
            parts.push(`${n(report.measurementsNeedingConfirmation, 'measurement')} need their original units confirmed.`);
        }
        if (report.sessionsRepaired === 0 && !report.activeWorkoutRepaired
            && report.sessionsAmbiguous === 0 && report.measurementsNeedingConfirmation === 0) {
            parts.push('No repairs needed.');
        }

        const summary = parts.join(' ');
        if (out) { out.hidden = false; out.textContent = summary; }

        if (report.measurementsNeedingConfirmation > 0) {
            this.app.openMeasurementUnitsModal();
        } else {
            showToast(report.changed ? 'Stored units repaired' : 'Stored units are correct',
                report.changed ? 'success' : 'info');
        }

        if (report.changed) this.app.refreshFromStorage();
    }

    render() {
        const settings = this.app.settings;

        // Populate form with current settings
        document.getElementById('weight-unit').value = settings.weightUnit;
        if (this.weightUnitDropdown) this.weightUnitDropdown.sync();
        const timeFormatEl = document.getElementById('time-format');
        if (timeFormatEl) {
            timeFormatEl.value = settings.timeFormat || '24';
            if (this.timeFormatDropdown) this.timeFormatDropdown.sync();
        }

        const soundAlertsInput = document.getElementById('sound-alerts');
        if (soundAlertsInput) soundAlertsInput.checked = settings.soundAlerts !== false;
        const vibrationAlertsInput = document.getElementById('vibration-alerts');
        if (vibrationAlertsInput) vibrationAlertsInput.checked = settings.vibrationAlerts !== false;

        const firstWarnInput = document.getElementById('timer-first-warning');
        if (firstWarnInput) {
            firstWarnInput.value = String(settings.timerFirstWarningSeconds ?? 10);
        }
        const countdownInput = document.getElementById('timer-countdown-start');
        if (countdownInput) {
            countdownInput.value = String(settings.timerCountdownSeconds ?? 5);
        }

        const firstDaySelect = document.getElementById('first-day-of-week');
        if (firstDaySelect) {
            firstDaySelect.value = String(settings.firstDayOfWeek === 1 ? 1 : 0);
            if (this.firstDayDropdown) this.firstDayDropdown.sync();
        }

        const scheduleToggle = document.getElementById('show-program-schedule');
        if (scheduleToggle) scheduleToggle.checked = settings.showProgramSchedule !== false;

        // Plate calculator (per-unit equipment profile)
        this.renderPlateSettings(settings.weightUnit);

        this.renderWarmupSettings();

        // Snapshot current values for dirty-state comparison
        this.savedSnapshot = this.snapshotForm();
        this.checkDirty();
    }

    /** Populate the warm-up controls from the stored (normalized) config. */
    renderWarmupSettings() {
        const warmup = clampWarmupSettings(storageService.get(WARMUP_KEY, null));

        const enabledInput = document.getElementById('warmup-enabled');
        if (enabledInput) enabledInput.checked = warmup.enabled;
        const kgInput = document.getElementById('warmup-threshold-kg');
        if (kgInput) kgInput.value = String(warmup.thresholdKg);
        const lbInput = document.getElementById('warmup-threshold-lb');
        if (lbInput) lbInput.value = String(warmup.thresholdLb);

        warmup.ramp.forEach((step, i) => {
            const pctInput = document.getElementById(`warmup-pct-${i}`);
            if (pctInput) pctInput.value = String(step.pct);
            const repsInput = document.getElementById(`warmup-reps-${i}`);
            if (repsInput) repsInput.value = String(step.reps);
        });
    }

    /**
     * Read the warm-up controls, normalize, persist, and reflect the
     * normalized values back into the inputs so the user always sees what
     * actually got stored.
     */
    saveWarmupSettings() {
        const ramp = WARMUP_DEFAULTS.ramp.map((_, i) => ({
            pct: document.getElementById(`warmup-pct-${i}`)?.value,
            reps: document.getElementById(`warmup-reps-${i}`)?.value,
        }));
        const warmup = clampWarmupSettings({
            enabled: document.getElementById('warmup-enabled')?.checked !== false,
            thresholdKg: document.getElementById('warmup-threshold-kg')?.value,
            thresholdLb: document.getElementById('warmup-threshold-lb')?.value,
            ramp,
        });

        storageService.set(WARMUP_KEY, warmup);
        this.renderWarmupSettings();
    }

    /** Build a snapshot of all form values used for dirty-state checking. */
    snapshotForm() {
        return {
            weightUnit: document.getElementById('weight-unit')?.value ?? '',
            timeFormat: document.getElementById('time-format')?.value ?? '',
            soundAlerts: document.getElementById('sound-alerts')?.checked ? '1' : '0',
            vibrationAlerts: document.getElementById('vibration-alerts')?.checked ? '1' : '0',
            timerFirstWarning: document.getElementById('timer-first-warning')?.value ?? '',
            timerCountdownStart: document.getElementById('timer-countdown-start')?.value ?? '',
            firstDayOfWeek: document.getElementById('first-day-of-week')?.value ?? '',
            showProgramSchedule: document.getElementById('show-program-schedule')?.checked ? '1' : '0',
            barWeight: document.getElementById('bar-weight')?.value ?? '',
            plates: document.getElementById('plates-input')?.value ?? '',
        };
    }

    /**
     * Parse the comma-separated plate input into a sorted, validated array.
     * Drops zero / negative / non-numeric entries silently — the live
     * preview shows what we actually accepted.
     */
    parsePlatesInput(raw) {
        if (!raw || typeof raw !== 'string') return [];
        return raw.split(/[,\s]+/)
            .map((s) => Number(s))
            .filter((n) => Number.isFinite(n) && n > 0)
            .sort((a, b) => b - a);
    }

    /**
     * GT-21: fill the plate panel from the profile for `unit`, and say which
     * unit it is everywhere.
     *
     * Every symptom in that finding came from the panel having no idea what
     * unit it was editing: the BAR WEIGHT field carried no unit label at all,
     * the "Accepted:" echo was hard-coded to kg in lb mode, and a unit switch
     * left a 20 (kg) bar and a kg stack in place under lb labels.
     */
    renderPlateSettings(unitValue) {
        const unit = normalizeWeightUnit(unitValue ?? this.app.settings?.weightUnit);
        this.plateProfileUnit = unit;
        const profile = typeof this.app.settings?.plateConfig === 'function'
            ? this.app.settings.plateConfig(unit)
            : { barWeight: '', plates: [] };

        const barInput = document.getElementById('bar-weight');
        if (barInput) {
            barInput.value = profile.barWeight ?? '';
            barInput.placeholder = unit === 'lb' ? '45' : '20';
        }
        const barLabel = document.querySelector('label[for="bar-weight"]');
        if (barLabel) barLabel.textContent = `Bar weight (${unit})`;

        const platesInput = document.getElementById('plates-input');
        if (platesInput) {
            platesInput.value = (profile.plates || []).join(', ');
            platesInput.placeholder = unit === 'lb'
                ? 'e.g. 45, 35, 25, 10, 5, 2.5'
                : 'e.g. 25, 20, 15, 10, 5, 2.5, 1.25';
        }
        const platesLabel = document.querySelector('label[for="plates-input"] small');
        if (platesLabel) {
            platesLabel.textContent = `(comma-separated, in ${unit}, per-side selection)`;
        }
        this.refreshPlatesPreview();
    }

    /** The unit the plate panel is currently editing. */
    activePlateUnit() {
        return normalizeWeightUnit(
            this.plateProfileUnit
            || document.getElementById('weight-unit')?.value
            || this.app.settings?.weightUnit);
    }

    /** Render the live preview line under the plates input. */
    refreshPlatesPreview() {
        const previewEl = document.getElementById('plates-preview');
        if (!previewEl) return;
        const raw = document.getElementById('plates-input')?.value ?? '';
        const parsed = this.parsePlatesInput(raw);
        const unit = this.activePlateUnit();
        previewEl.textContent = parsed.length === 0
            ? 'No plates configured.'
            : `Accepted: ${parsed.map(p => `${p}${unit}`).join(', ')}`;
    }

    /** True when any form value differs from the last saved snapshot. */
    isDirty() {
        if (!this.savedSnapshot) return false;
        const current = this.snapshotForm();
        return Object.keys(this.savedSnapshot)
            .some(k => this.savedSnapshot[k] !== current[k]);
    }

    /** Compare current form against saved snapshot and toggle Save button. */
    checkDirty() {
        const btn = document.getElementById('save-settings-btn');
        if (!btn || !this.savedSnapshot) return;
        btn.disabled = !this.isDirty();
    }

    /**
     * Item R2-9: navigation guard. When leaving Settings with unsaved diffs,
     * pop the confirm modal and defer the navigation (return false). The modal
     * actions re-invoke showView for the deferred target. No diffs => proceed.
     */
    beforeLeave(targetView) {
        if (!this.isDirty()) return true;
        this.pendingLeaveView = targetView;
        const modal = document.getElementById('unsaved-settings-modal');
        if (modal) {
            // Make the dialog visible to assistive tech while open; the static
            // aria-hidden="true" in markup is restored on close.
            modal.setAttribute('aria-hidden', 'false');
            modal.classList.add('active');
        }
        return false;
    }

    saveSettings() {
        const settings = this.app.settings;

        settings.weightUnit = normalizeWeightUnit(document.getElementById('weight-unit').value);
        const timeFormatEl = document.getElementById('time-format');
        if (timeFormatEl) {
            const v = timeFormatEl.value === '24' ? '24' : '12';
            settings.timeFormat = v;
        }
        const soundAlertsInput = document.getElementById('sound-alerts');
        if (soundAlertsInput) settings.soundAlerts = soundAlertsInput.checked;
        const vibrationAlertsInput = document.getElementById('vibration-alerts');
        if (vibrationAlertsInput) settings.vibrationAlerts = vibrationAlertsInput.checked;

        const firstWarnInput = document.getElementById('timer-first-warning');
        if (firstWarnInput) {
            settings.timerFirstWarningSeconds = Settings.normalizeFirstWarningSeconds(
                firstWarnInput.value);
        }
        const countdownInput = document.getElementById('timer-countdown-start');
        if (countdownInput) {
            settings.timerCountdownSeconds = Settings.normalizeCountdownSeconds(
                countdownInput.value);
        }

        const firstDaySelect = document.getElementById('first-day-of-week');
        if (firstDaySelect) settings.firstDayOfWeek = firstDaySelect.value === '1' ? 1 : 0;

        const scheduleToggle = document.getElementById('show-program-schedule');
        if (scheduleToggle) settings.showProgramSchedule = scheduleToggle.checked;

        // Equipment writes into the profile for the unit the panel is
        // editing, which is the unit just selected above.
        const plateUnit = this.activePlateUnit();
        const profile = typeof settings.plateConfig === 'function'
            ? settings.plateConfig(plateUnit)
            : null;
        const barInput = document.getElementById('bar-weight');
        if (profile && barInput && barInput.value !== '') {
            const bar = Number(barInput.value);
            if (Number.isFinite(bar) && bar >= 0) profile.barWeight = bar;
        }
        const platesInput = document.getElementById('plates-input');
        if (profile && platesInput) {
            const parsed = this.parsePlatesInput(platesInput.value);
            if (parsed.length > 0) profile.plates = parsed;
        }

        this.app.saveSettings();
        showToast('Settings saved successfully', 'success');

        // Item R2-1: reflect the normalized (clamped / defaulted) marker values
        // back into the inputs so the user sees exactly what persisted instead
        // of stale invalid text.
        if (firstWarnInput) firstWarnInput.value = String(settings.timerFirstWarningSeconds);
        if (countdownInput) countdownInput.value = String(settings.timerCountdownSeconds);

        // Form is now clean again — snapshot the just-saved values and disable Save
        this.savedSnapshot = this.snapshotForm();
        this.checkDirty();
    }

    exportData() {
        const data = this.app.exportData();
        const filename = `gym-tracker-data-${new Date().toISOString().split('T')[0]}.json`;
        downloadJSON(data, filename);
        showToast('Data exported successfully', 'success');
    }

    /**
     * Item 8: one CSV row per completed set across every logged session.
     * Plain Blob download so it works offline like the JSON export.
     */
    exportSetsCsv() {
        const unit = this.app.settings?.weightUnit || 'kg';
        const { csv, rowCount } = buildSetsCsv(this.app.workoutSessions || [], unit,
            (id, fallback) => this.app.getExerciseDisplayName(id, fallback));

        if (rowCount === 0) {
            showToast('No completed sets to export yet. Log a workout first.', 'info', 4000);
            return;
        }

        const filename = `gym-tracker-sets-${new Date().toISOString().split('T')[0]}.csv`;
        downloadText(csv, filename, 'text/csv;charset=utf-8');
        showToast(`Exported ${rowCount} ${rowCount === 1 ? 'set' : 'sets'} to CSV`, 'success');
    }

    /**
     * GT-02: ask what "import" is supposed to mean, instead of promising one
     * thing and doing the other.
     *
     * The dialog used to say the file "will be merged with your existing
     * programs, workouts, and settings" while `importAllData` overwrote every
     * store the file contained - importing a sessions-only export destroyed
     * the user's program and all 17 unlocked achievements, with no undo and
     * no backup. Merge and replace are genuinely different operations and are
     * now presented as such, with merge the default.
     *
     * Resolves to an IMPORT_MODES value, or null if the user cancels.
     */
    async askImportMode(data) {
        const modal = document.getElementById('import-mode-modal');
        const summary = document.getElementById('import-mode-summary');
        if (summary) summary.innerHTML = describeImport(data);

        // No modal in the DOM (very old cached shell): fall back to the safe
        // operation rather than guessing at the destructive one.
        if (!modal) return IMPORT_MODES.MERGE;

        return new Promise((resolve) => {
            const mergeBtn = document.getElementById('import-mode-merge');
            const replaceBtn = document.getElementById('import-mode-replace');
            const cancelBtn = document.getElementById('import-mode-cancel');
            const closeBtn = modal.querySelector('.modal-close');

            const cleanup = () => {
                closeModalSafely(modal);
                mergeBtn?.removeEventListener('click', onMerge);
                replaceBtn?.removeEventListener('click', onReplace);
                cancelBtn?.removeEventListener('click', onCancel);
                closeBtn?.removeEventListener('click', onCancel);
                modal.removeEventListener('keydown', onKey);
            };
            const onMerge = () => { cleanup(); resolve(IMPORT_MODES.MERGE); };
            const onReplace = () => { cleanup(); resolve(IMPORT_MODES.REPLACE); };
            const onCancel = () => { cleanup(); resolve(null); };
            const onKey = (e) => { if (e.key === 'Escape') onCancel(); };

            mergeBtn?.addEventListener('click', onMerge);
            replaceBtn?.addEventListener('click', onReplace);
            cancelBtn?.addEventListener('click', onCancel);
            closeBtn?.addEventListener('click', onCancel);
            modal.addEventListener('keydown', onKey);

            modal.setAttribute('aria-hidden', 'false');
            modal.classList.add('active');
            trapModalFocus(modal);
        });
    }

    /**
     * Download the current data before a destructive replace, so "I picked
     * the wrong file" is recoverable by importing the rollback back.
     */
    downloadRollbackBackup() {
        try {
            const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            downloadJSON(this.app.exportData(), `gym-tracker-rollback-${stamp}.json`);
            showToast('Rollback backup downloaded', 'info', 4000);
        } catch (error) {
            console.error('Could not write the rollback backup:', error);
            showToast('Could not write a rollback backup - import cancelled', 'error', 5000);
            throw error;
        }
    }

    importData(file) {
        if (!file) return;

        const reader = new FileReader();
        reader.onload = async (e) => {
            try {
                const data = JSON.parse(e.target.result);
                const validationError = validateImportData(data);

                if (validationError) {
                    showToast(validationError, 'error');
                    return;
                }

                const mode = await this.askImportMode(data);
                if (!mode) return;

                if (mode === IMPORT_MODES.REPLACE) {
                    const confirmed = await showConfirmModal({
                        title: 'Replace all data?',
                        message: describeImport(data)
                            + '<br><br>Each kind of data the file contains <strong>REPLACES</strong> '
                            + 'your copy of it: records of that kind missing from the file are <strong>deleted</strong>. '
                            + 'Kinds of data the file does not contain are left untouched.',
                        warning: 'A rollback backup of your current data downloads first, so you can import it back if this was a mistake.',
                        confirmText: 'Replace everything',
                        cancelText: 'Cancel',
                        isDangerous: true,
                    });
                    if (!confirmed) return;
                    // Rollback file BEFORE the destructive write, never after.
                    this.downloadRollbackBackup();
                }

                this.app.importData(data, { mode });
            } catch (error) {
                showToast('Invalid JSON file', 'error');
                console.error('Import error:', error);
            }
        };

        reader.readAsText(file);

        // Reset file input
        document.getElementById('import-file-input').value = '';
    }
}

// Initialize
new SettingsView();
