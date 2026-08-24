let backupInterval = null;

function initializeAutoBackup() {
    // Auto-backup every 10 minutes
    if (backupInterval) clearInterval(backupInterval);

    backupInterval = setInterval(() => {
        if (races.length > 0) {
            autoBackupToLocalStorage();
        }
    }, 600000); // 10 minutes
}

function autoBackupToLocalStorage() {
    try {
        const backupData = {
            races: races,
            playerNames: window.PlayerNameManager ? window.PlayerNameManager.getAll() : playerNames,
            playerSymbols: window.PlayerSymbolManager ? window.PlayerSymbolManager.getAllSymbols() : {},
            backupDate: new Date().toISOString(),
            version: '2.2',
            actionHistory: actionHistory.slice(-10) // Keep last 10 for recovery
        };

        const autoBackupKey = window.getStorageKey ? window.getStorageKey('AutoBackup') : 'marioKartAutoBackup';
        localStorage.setItem(autoBackupKey, JSON.stringify(backupData));
        console.log('Auto-backup completed');
    } catch (e) {
        console.error('Auto-backup failed:', e);
    }
}

function restoreFromBackup() {
    try {
        const autoBackupKey = window.getStorageKey ? window.getStorageKey('AutoBackup') : 'marioKartAutoBackup';
        const backup = localStorage.getItem(autoBackupKey);
        if (!backup) {
            showMessage('No automatic backup found. Backups are created every 10 minutes when you have race data.', true);
            return;
        }

        let backupData;
        try {
            backupData = JSON.parse(backup);
        } catch (parseError) {
            showMessage('Backup data is corrupted and cannot be restored.', true);
            console.error('Backup parse error:', parseError);
            return;
        }

        if (!backupData.races || !Array.isArray(backupData.races)) {
            showMessage('Backup data is invalid - no races found.', true);
            return;
        }

        // Same validator as import: a tampered or corrupted backup must not
        // widen the roster or bring back 24:MM / duplicate / out-of-range rows.
        const result = sanitizeRaceData(backupData.races);
        if (!result.ok) {
            showMessage(`Backup cannot be restored: ${result.error}`, true);
            return;
        }

        const backupDate = new Date(backupData.backupDate).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
        const raceCount = result.races.length;

        const { close } = presentModal({
            initialFocus: '#cancel-restore',
            html: `
            <div class="modal-icon">🔄</div>
            <h3 class="modal-title ">Restore from Backup?</h3>
            <p class="modal-text ">
                Found backup with <strong class="">${raceCount} races</strong><br>
                Created on: <strong class="">${escapeHtml(backupDate)}</strong><br><br>
                <span class="modal-warning ">⚠️ Warning: This will replace all current data!</span>
            </p>
            <div class="modal-buttons">
                <button id="confirm-restore" class="modal-btn-primary">Restore Data</button>
                <button id="cancel-restore" class="modal-btn-secondary ">Cancel</button>
            </div>
        `,
        });

        document.getElementById('cancel-restore').onclick = close;

        document.getElementById('confirm-restore').onclick = () => {
            close();

            // Perform the restore
            races = result.races;
            if (typeof resetActionHistory === 'function') resetActionHistory();
            
            // Use centralized PlayerNameManager for player names
            const restoredNames = sanitizePlayerNames(backupData.playerNames);
            if (window.PlayerNameManager && Object.keys(restoredNames).length > 0) {
                window.PlayerNameManager.setAll(restoredNames);
            } else if (!window.PlayerNameManager) {
                // Fallback
                playerNames = { ...playerNames, ...restoredNames };
                localStorage.setItem('marioKartPlayerNames', JSON.stringify(playerNames));
                
                // Update all player-related UI
                updatePlayerLabels();
                if (window.updatePlayerLabels) {
                    window.updatePlayerLabels();
                }
                
                // Update the name inputs in the widget
                const nameInputs = ['player1-name', 'player2-name', 'player3-name', 'player4-name'];
                nameInputs.forEach((inputId, index) => {
                    const input = document.getElementById(inputId);
                    if (input) {
                        input.value = playerNames[`player${index + 1}`];
                    }
                });
            }
            
            // Restore player icons if present
            if (backupData.playerIcons && typeof backupData.playerIcons === 'object') {
                if (window.PlayerIconManager) {
                    // Clear existing icons and set new ones
                    window.PlayerIconManager.clearAllIcons();
                    Object.entries(backupData.playerIcons).forEach(([playerKey, iconData]) => {
                        if (iconData) {
                            window.PlayerIconManager.setIcon(playerKey, iconData);
                        }
                    });
                }
            }
            
            // Restore player symbols if present
            if (backupData.playerSymbols && typeof backupData.playerSymbols === 'object') {
                if (window.PlayerSymbolManager) {
                    window.PlayerSymbolManager.setAllSymbols(backupData.playerSymbols);
                }
                // Update all player icons in the UI
                if (window.updateAllPlayerIcons) {
                    window.updateAllPlayerIcons();
                }
            }
            
            const racesKey = window.getStorageKey ? window.getStorageKey('Races') : 'marioKartRaces';
            localStorage.setItem(racesKey, JSON.stringify(races));
            
            updateDisplay();
            updateAchievements();
            updateClearButtonState();
            showMessage(result.repairs.length > 0
                ? `Data restored from backup (repaired: ${summarizeRepairs(result.repairs)})`
                : 'Data restored from backup!');
        };

    } catch (e) {
        showMessage('Failed to restore backup', true);
        console.error('Backup restore error:', e);
    }
}

// Function no longer needed - restore button is now in the sidebar HTML


// Export functions to global scope
window.restoreFromBackup = restoreFromBackup;
window.autoBackupToLocalStorage = autoBackupToLocalStorage;
