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
        modal.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.5);
            display: flex;
            justify-content: center;
            align-items: center;
            z-index: 1000;
            backdrop-filter: blur(5px);
        `;

        const dialog = document.createElement('div');
        dialog.style.cssText = `
            background: ${'#2d3748'};
            border-radius: 1rem;
            padding: 2rem;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
            max-width: 400px;
            width: 90%;
            text-align: center;
            animation: modalSlideIn 0.3s ease;
        `;

        dialog.innerHTML = `
            <div style="font-size: 3rem; margin-bottom: 1rem;">🔄</div>
            <h3 style="color: ${'#e2e8f0'}; margin-bottom: 1rem; font-size: 1.5rem;">Restore from Backup?</h3>
            <p style="color: ${'#a0aec0'}; margin-bottom: 2rem; line-height: 1.5;">
                Found backup with <strong>${raceCount} races</strong><br>
                Created on: <strong style="color: ${'#e2e8f0'};">${backupDate}</strong><br><br>
                <span style="color: ${'#fc8181'};">⚠️ Warning: This will replace all current data!</span>
            </p>
            <div style="display: flex; gap: 1rem; justify-content: center;">
                <button id="confirm-restore" style="
                    background: #8b5cf6;
                    color: white;
                    border: none;
                    padding: 0.75rem 1.5rem;
                    border-radius: 0.5rem;
                    font-weight: 600;
                    cursor: pointer;
                    transition: all 0.2s;
                ">Restore Data</button>
                <button id="cancel-restore" style="
                    background: ${'#4a5568'};
                    color: ${'#e2e8f0'};
                    border: none;
                    padding: 0.75rem 1.5rem;
                    border-radius: 0.5rem;
                    font-weight: 600;
                    cursor: pointer;
                    transition: all 0.2s;
                ">Cancel</button>
            </div>
        `;

        // Add CSS animation if not already added
        if (!document.querySelector('#modal-animation-style')) {
            const style = document.createElement('style');
            style.id = 'modal-animation-style';
            style.textContent = `
                @keyframes modalSlideIn {
                    from { opacity: 0; transform: scale(0.9) translateY(-20px); }
                    to { opacity: 1; transform: scale(1) translateY(0); }
                }
            `;
            document.head.appendChild(style);
        }

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
