// Backup functionality for Football H2H Tracker
let backupInterval = null;

function initializeAutoBackup() {
    // Auto-backup every 10 minutes
    if (backupInterval) clearInterval(backupInterval);

    backupInterval = setInterval(() => {
        if (games && games.length > 0) {
            autoBackupToLocalStorage();
        }
    }, 600000); // 10 minutes
}

function autoBackupToLocalStorage() {
    try {
        const backupData = {
            games: games,
            players: {
                player1: document.getElementById('player1Name') ? document.getElementById('player1Name').value : '',
                player2: document.getElementById('player2Name') ? document.getElementById('player2Name').value : ''
            },
            playerIcons: playerIcons,
            backupDate: new Date().toISOString(),
            version: '1.0'
        };

        localStorage.setItem('footballH2HAutoBackup', JSON.stringify(backupData));
        console.log('Auto-backup completed');
    } catch (e) {
        console.error('Auto-backup failed:', e);
    }
}

function restoreFromBackup() {
    try {
        const backup = localStorage.getItem('footballH2HAutoBackup');
        if (!backup) {
            createWarningModal({
                icon: '📦',
                title: 'No Backup Found',
                message: 'No automatic backup found. Backups are created every 10 minutes when you have game data.',
                onConfirm: () => {},
                onCancel: () => {}
            });
            return;
        }

        let backupData;
        try {
            backupData = JSON.parse(backup);
        } catch (parseError) {
            createErrorModal({
                icon: '❌',
                title: 'Backup Error',
                message: 'Backup data is corrupted and cannot be restored.'
            });
            console.error('Backup parse error:', parseError);
            return;
        }

        if (!backupData.games || !Array.isArray(backupData.games)) {
            createErrorModal({
                icon: '❌',
                title: 'Invalid Backup',
                message: 'Backup data is invalid - no games found.'
            });
            return;
        }

        const backupDate = new Date(backupData.backupDate).toLocaleString(undefined, { hour12: false });
        const gameCount = backupData.games.length;

        createConfirmationModal({
            icon: '🔄',
            title: 'Restore from Backup?',
            message: `Found backup with <strong>${gameCount} games</strong><br>
                     Created on: <strong>${backupDate}</strong><br><br>
                     <span style="color: #fc8181;">⚠️ Warning: This will replace all current data!</span>`,
            onConfirm: () => {
                // Perform the restore
                games = backupData.games || [];
                
                // Restore player names
                if (backupData.players) {
                    if (backupData.players.player1 !== undefined) {
                        const player1Input = document.getElementById('player1Name');
                        if (player1Input) player1Input.value = backupData.players.player1;
                    }
                    if (backupData.players.player2 !== undefined) {
                        const player2Input = document.getElementById('player2Name');
                        if (player2Input) player2Input.value = backupData.players.player2;
                    }
                    savePlayers();
                }
                
                // Restore player icons
                if (backupData.playerIcons && typeof backupData.playerIcons === 'object') {
                    playerIcons = backupData.playerIcons;
                    savePlayerIcons();
                    updatePlayerIconDisplays();
                }
                
                // Save games and update UI
                saveGames();
                updateUI();
                
                // Show success toast
                showToast(`Successfully restored ${gameCount} games from backup!`, 'success');
            },
            onCancel: () => {
                // Modal closes automatically
            }
        });

    } catch (e) {
        createErrorModal({
            icon: '❌',
            title: 'Restore Failed',
            message: 'Failed to restore backup. Please try again.'
        });
        console.error('Backup restore error:', e);
    }
}

function backupToFile() {
    try {
        const player1Name = document.getElementById('player1Name') ? document.getElementById('player1Name').value : 'Player 1';
        const player2Name = document.getElementById('player2Name') ? document.getElementById('player2Name').value : 'Player 2';
        
        const data = {
            games: games,
            players: {
                player1: player1Name,
                player2: player2Name
            },
            playerIcons: playerIcons,
            backupDate: new Date().toISOString(),
            version: '1.0'
        };

        const fileContent = JSON.stringify(data, null, 2);
        const fileName = `football-h2h-backup-${new Date().toISOString().split('T')[0]}.json`;

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

        // Show success toast
        showToast(`Backup saved as ${fileName}`, 'success');
    } catch (e) {
        createErrorModal({
            icon: '❌',
            title: 'Backup Failed',
            message: 'Failed to create backup. Please try again.'
        });
        console.error('Backup error:', e);
    }
}

function restoreFromFile() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    
    input.onchange = function(event) {
        const file = event.target.files[0];
        if (!file) return;
        
        const reader = new FileReader();
        reader.onload = function(e) {
            try {
                const backupData = JSON.parse(e.target.result);
                
                // Validate backup data
                if (!backupData.games || !Array.isArray(backupData.games)) {
                    createErrorModal({
                        icon: '❌',
                        title: 'Invalid Backup File',
                        message: 'The selected file is not a valid Football H2H backup.'
                    });
                    return;
                }
                
                const backupDate = backupData.backupDate ? new Date(backupData.backupDate).toLocaleString(undefined, { hour12: false }) : 'Unknown';
                const gameCount = backupData.games.length;
                
                createConfirmationModal({
                    icon: '📥',
                    title: 'Restore from File?',
                    message: `Found backup with <strong>${gameCount} games</strong><br>
                             Created on: <strong>${backupDate}</strong><br><br>
                             <span style="color: #fc8181;">⚠️ Warning: This will replace all current data!</span>`,
                    onConfirm: () => {
                        // Perform the restore
                        games = backupData.games || [];
                        
                        // Restore player names
                        if (backupData.players) {
                            if (backupData.players.player1 !== undefined) {
                                const player1Input = document.getElementById('player1Name');
                                if (player1Input) player1Input.value = backupData.players.player1;
                            }
                            if (backupData.players.player2 !== undefined) {
                                const player2Input = document.getElementById('player2Name');
                                if (player2Input) player2Input.value = backupData.players.player2;
                            }
                            savePlayers();
                        }
                        
                        // Restore player icons
                        if (backupData.playerIcons && typeof backupData.playerIcons === 'object') {
                            playerIcons = backupData.playerIcons;
                            savePlayerIcons();
                            updatePlayerIconDisplays();
                        }
                        
                        // Save games and update UI
                        saveGames();
                        updateUI();
                        
                        // Show success toast
                        showToast(`Successfully restored ${gameCount} games from file!`, 'success');
                    },
                    onCancel: () => {
                        // Modal closes automatically
                    }
                });
                
            } catch (error) {
                createErrorModal({
                    icon: '❌',
                    title: 'File Read Error',
                    message: 'Error reading the backup file. Please make sure it\'s a valid JSON file.'
                });
                console.error('File read error:', error);
            }
        };
        reader.readAsText(file);
    };
    
    input.click();
}

// Auto-backup initialization is handled in football-h2h.js

// Export functions to global scope
window.initializeAutoBackup = initializeAutoBackup;
window.restoreFromBackup = restoreFromBackup;
window.autoBackupToLocalStorage = autoBackupToLocalStorage;
window.backupToFile = backupToFile;
window.restoreFromFile = restoreFromFile;