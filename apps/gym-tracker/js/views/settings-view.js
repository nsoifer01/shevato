/**
 * Settings View Controller
 */
import { app } from '../app.js';
import { showToast, downloadJSON, showConfirmModal } from '../utils/helpers.js';
import { validateImportData } from '../utils/validators.js';
import { DarkSelect } from '../utils/dark-select.js';

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
        };
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
