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

        localStorage.setItem('marioKartAutoBackup', JSON.stringify(backupData));
        console.log('Auto-backup completed');
    } catch (e) {
        console.error('Auto-backup failed:', e);
    }
}

function restoreFromBackup() {
    try {
        const backup = localStorage.getItem('marioKartAutoBackup');
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

        const backupDate = new Date(backupData.backupDate).toLocaleString();
        const raceCount = backupData.races.length;

        // Create a beautiful confirmation modal
        const modal = document.createElement('div');
        modal.className = 'modal-overlay';

        const dialog = document.createElement('div');
        dialog.className = `modal-dialog `;

        dialog.innerHTML = `
            <div class="modal-icon">🔄</div>
            <h3 class="modal-title ">Restore from Backup?</h3>
            <p class="modal-text ">
                Found backup with <strong class="">${raceCount} races</strong><br>
                Created on: <strong class="">${backupDate}</strong><br><br>
                <span class="modal-warning ">⚠️ Warning: This will replace all current data!</span>
            </p>
            <div class="modal-buttons">
                <button id="confirm-restore" class="modal-btn-primary">Restore Data</button>
                <button id="cancel-restore" class="modal-btn-secondary ">Cancel</button>
            </div>
        `;


        modal.appendChild(dialog);
        document.body.appendChild(modal);

        // Add event listeners
        document.getElementById('cancel-restore').onclick = () => {
            document.body.removeChild(modal);
        };

        document.getElementById('confirm-restore').onclick = () => {
            document.body.removeChild(modal);
            
            // Perform the restore
            races = backupData.races || [];
            
            // Use centralized PlayerNameManager for player names
            if (window.PlayerNameManager && backupData.playerNames) {
                window.PlayerNameManager.setAll(backupData.playerNames);
            } else {
                // Fallback
                playerNames = backupData.playerNames || playerNames;
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
            
            localStorage.setItem('marioKartRaces', JSON.stringify(races));
            
            updateDisplay();
            updateAchievements();
            updateClearButtonState();
            showMessage('Data restored from backup!');
        };

        // Close on background click
        modal.onclick = (e) => {
            if (e.target === modal) {
                document.body.removeChild(modal);
            }
        };

        // Close on Escape key
        const escapeHandler = (e) => {
            if (e.key === 'Escape') {
                document.body.removeChild(modal);
                document.removeEventListener('keydown', escapeHandler);
            }
        };
        document.addEventListener('keydown', escapeHandler);

    } catch (e) {
        showMessage('Failed to restore backup', true);
        console.error('Backup restore error:', e);
    }
}

// Function no longer needed - restore button is now in the sidebar HTML

function backupToGoogleDrive() {
    const data = {
        races: races,
        playerNames: window.PlayerNameManager ? window.PlayerNameManager.getAll() : playerNames,
        playerSymbols: window.PlayerSymbolManager ? window.PlayerSymbolManager.getAllSymbols() : {},
        backupDate: new Date().toISOString(),
        version: '2.2',
        actionHistory: actionHistory
    };

    const fileContent = JSON.stringify(data, null, 2);
    const fileName = `mario-kart-backup-${new Date().toISOString().split('T')[0]}.json`;

    // Create downloadable backup
    const blob = new Blob([fileContent], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    // Also save to auto-backup
    autoBackupToLocalStorage();

    showMessage('Backup downloaded and auto-backup updated!');
}

// Export functions to global scope
window.restoreFromBackup = restoreFromBackup;
window.autoBackupToLocalStorage = autoBackupToLocalStorage;
window.backupToGoogleDrive = backupToGoogleDrive;
