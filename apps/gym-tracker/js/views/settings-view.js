/**
 * Settings View Controller
 */
import { app } from '../app.js';
import { showToast, downloadJSON } from '../utils/helpers.js';
import { validateImportData } from '../utils/validators.js';

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
            clearBtn.addEventListener('click', () => {
                this.app.clearAllData();
            });
        }
    }

    render() {
        const settings = this.app.settings;

        // Populate form with current settings
        document.getElementById('weight-unit').value = settings.weightUnit;
    }

    saveSettings() {
        const settings = this.app.settings;

        settings.weightUnit = document.getElementById('weight-unit').value;

        this.app.saveSettings();
        showToast('Settings saved successfully', 'success');
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
        reader.onload = (e) => {
            try {
                const data = JSON.parse(e.target.result);
                const validationError = validateImportData(data);

                if (validationError) {
                    showToast(validationError, 'error');
                    return;
                }

                if (confirm('Import this data? This will merge with your existing data.')) {
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
