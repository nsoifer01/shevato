// Silent auto-backup for Football H2H Tracker.
//
// Writes a snapshot of the app data to localStorage('footballH2HAutoBackup')
// every 10 minutes as a safety net against accidental data loss. There is
// deliberately no Backup/Restore UI (removed 2026-06-07 by owner decision:
// Export/Import covers user-facing data portability); the snapshot can be
// recovered manually from devtools if ever needed.
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
                player1: player1Name || 'Player 1',
                player2: player2Name || 'Player 2'
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

// Auto-backup initialization is handled in football-h2h.js

// Export functions to global scope
window.initializeAutoBackup = initializeAutoBackup;
window.autoBackupToLocalStorage = autoBackupToLocalStorage;
