/**
 * Settings View Controller
 */
import { app } from '../app.js';
import { showToast, downloadJSON, showConfirmModal } from '../utils/helpers.js';
import { validateImportData } from '../utils/validators.js';
import { DarkSelect } from '../utils/dark-select.js';
import { storageService } from '../services/StorageService.js';

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
            weightUnitSelect.addEventListener('change', () => this.checkDirty());
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

        // Replay onboarding — clear the seen flag and reload so the
        // welcome modal fires again (the boot path in app.js gates on
        // `hasSeenOnboarding()` AND a clean data state, so this is mostly
        // useful for users who skipped the tour and want a refresher).
        const replayBtn = document.getElementById('replay-onboarding-btn');
        if (replayBtn) {
            replayBtn.addEventListener('click', async () => {
                const confirmed = await showConfirmModal({
                    title: 'Replay welcome tour',
                    message: 'Reload the app and show the first-run welcome again? Your data is unaffected.',
                    confirmText: 'Replay',
                    cancelText: 'Cancel',
                    isDangerous: false,
                });
                if (confirmed) {
                    storageService.remove(storageService.keys.ONBOARDING_SEEN);
                    location.reload();
                }
            });
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
        const user = window.firebaseAuth?.getCurrentUser?.()
            || (typeof firebase !== 'undefined' && firebase.auth?.().currentUser)
            || null;
        if (!user) {
            showToast('Sign in first to delete cloud data', 'error');
            return;
        }
        const confirmed = await showConfirmModal({
            title: 'Delete cloud data',
            message: 'Wipe the gym tracker data stored in the cloud for this account. Your local data stays on this device.',
            warning: 'This cannot be undone — other devices that sync will also lose this data on their next sync.',
            confirmText: 'Delete from cloud',
            cancelText: 'Cancel',
            isDangerous: true,
        });
        if (!confirmed) return;

        try {
            const { db } = await import('../../../../firebase-config.js');
            const { doc, deleteDoc } = await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js');
            const ref = doc(db, `users/${user.uid}/apps/gymTrackerApp`);
            await deleteDoc(ref);
            showToast('Cloud data deleted. Sign out + back in to re-sync.', 'success', 5000);
        } catch (error) {
            console.error('Failed to delete cloud data:', error);
            showToast('Could not delete cloud data — check your connection.', 'error', 5000);
        }
    }

    render() {
        const settings = this.app.settings;

        // Populate form with current settings
        document.getElementById('weight-unit').value = settings.weightUnit;
        if (this.weightUnitDropdown) this.weightUnitDropdown.sync();

        const soundAlertsInput = document.getElementById('sound-alerts');
        if (soundAlertsInput) soundAlertsInput.checked = settings.soundAlerts !== false;
        const vibrationAlertsInput = document.getElementById('vibration-alerts');
        if (vibrationAlertsInput) vibrationAlertsInput.checked = settings.vibrationAlerts !== false;

        // Plate calculator
        const barInput = document.getElementById('bar-weight');
        if (barInput) barInput.value = settings.barWeight ?? '';
        const platesInput = document.getElementById('plates-input');
        if (platesInput) platesInput.value = (settings.plates || []).join(', ');
        this.refreshPlatesPreview();

        // Snapshot current values for dirty-state comparison
        this.savedSnapshot = this.snapshotForm();
        this.checkDirty();
    }

    /** Build a snapshot of all form values used for dirty-state checking. */
    snapshotForm() {
        return {
            weightUnit: document.getElementById('weight-unit')?.value ?? '',
            soundAlerts: document.getElementById('sound-alerts')?.checked ? '1' : '0',
            vibrationAlerts: document.getElementById('vibration-alerts')?.checked ? '1' : '0',
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

    /** Render the live preview line under the plates input. */
    refreshPlatesPreview() {
        const previewEl = document.getElementById('plates-preview');
        if (!previewEl) return;
        const raw = document.getElementById('plates-input')?.value ?? '';
        const parsed = this.parsePlatesInput(raw);
        const unit = this.app.settings?.weightUnit || 'kg';
        previewEl.textContent = parsed.length === 0
            ? 'No plates configured.'
            : `Accepted: ${parsed.map(p => `${p}${unit}`).join(', ')}`;
    }

    /** Compare current form against saved snapshot and toggle Save button. */
    checkDirty() {
        const btn = document.getElementById('save-settings-btn');
        if (!btn || !this.savedSnapshot) return;
        const current = this.snapshotForm();
        const dirty = Object.keys(this.savedSnapshot)
            .some(k => this.savedSnapshot[k] !== current[k]);
        btn.disabled = !dirty;
    }

    saveSettings() {
        const settings = this.app.settings;

        settings.weightUnit = document.getElementById('weight-unit').value;
        const soundAlertsInput = document.getElementById('sound-alerts');
        if (soundAlertsInput) settings.soundAlerts = soundAlertsInput.checked;
        const vibrationAlertsInput = document.getElementById('vibration-alerts');
        if (vibrationAlertsInput) settings.vibrationAlerts = vibrationAlertsInput.checked;

        const barInput = document.getElementById('bar-weight');
        if (barInput && barInput.value !== '') {
            const bar = Number(barInput.value);
            if (Number.isFinite(bar) && bar >= 0) settings.barWeight = bar;
        }
        const platesInput = document.getElementById('plates-input');
        if (platesInput) settings.plates = this.parsePlatesInput(platesInput.value);

        this.app.saveSettings();
        showToast('Settings saved successfully', 'success');

        // Form is now clean again — snapshot the just-saved values and disable Save
        this.savedSnapshot = this.snapshotForm();
        this.checkDirty();
    }

    exportData() {
        const data = this.app.exportData();
        const filename = `gym-tracker-backup-${new Date().toISOString().split('T')[0]}.json`;
        downloadJSON(data, filename);
        showToast('Data exported successfully', 'success');
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

                const confirmed = await showConfirmModal({
                    title: 'Import Data',
                    message: 'Import this data? It will be merged with your existing programs, workouts, and settings.',
                    confirmText: 'Import',
                    cancelText: 'Cancel',
                    isDangerous: false,
                });
                if (confirmed) {
                    this.app.importData(data);
                }
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
