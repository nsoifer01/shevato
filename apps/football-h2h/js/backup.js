// Backup functionality for Football H2H

import { state, saveGames, savePlayers, savePlayerIcons } from './store.js';
import { updatePlayerIconDisplays } from './player-manager.js';
import {
  createConfirmationModal,
  createErrorModal,
  createWarningModal,
  showToast,
} from './modalUtils.js';

let backupInterval = null;

export function initializeAutoBackup() {
  if (backupInterval) clearInterval(backupInterval);

  backupInterval = setInterval(() => {
    if (state.games && state.games.length > 0) {
      autoBackupToLocalStorage();
    }
  }, 600000);
}

export function autoBackupToLocalStorage() {
  try {
    const backupData = {
      games: state.games,
      players: {
        player1: document.getElementById('player1Name')
          ? document.getElementById('player1Name').value
          : '',
        player2: document.getElementById('player2Name')
          ? document.getElementById('player2Name').value
          : '',
      },
      playerIcons: state.playerIcons,
      backupDate: new Date().toISOString(),
      version: '1.0',
    };

    localStorage.setItem('footballH2HAutoBackup', JSON.stringify(backupData));
  } catch (e) {
    console.error('Auto-backup failed:', e);
  }
}

export function restoreFromBackup() {
  try {
    const backup = localStorage.getItem('footballH2HAutoBackup');
    if (!backup) {
      createWarningModal({
        icon: '\uD83D\uDCE6',
        title: 'No Backup Found',
        message:
          'No automatic backup found. Backups are created every 10 minutes when you have game data.',
        onConfirm: () => {},
        onCancel: () => {},
      });
      return;
    }

    let backupData;
    try {
      backupData = JSON.parse(backup);
    } catch (parseError) {
      createErrorModal({
        icon: '\u274C',
        title: 'Backup Error',
        message: 'Backup data is corrupted and cannot be restored.',
      });
      return;
    }

    if (!backupData.games || !Array.isArray(backupData.games)) {
      createErrorModal({
        icon: '\u274C',
        title: 'Invalid Backup',
        message: 'Backup data is invalid - no games found.',
      });
      return;
    }

    const backupDate = new Date(backupData.backupDate).toLocaleString(undefined, { hour12: false });
    const gameCount = backupData.games.length;

    createConfirmationModal({
      icon: '\uD83D\uDD04',
      title: 'Restore from Backup?',
      message: `Found backup with <strong>${gameCount} games</strong><br>
                   Created on: <strong>${backupDate}</strong><br><br>
                   <span style="color: #fc8181;">\u26A0\uFE0F Warning: This will replace all current data!</span>`,
      onConfirm: () => {
        state.games = backupData.games || [];

        if (backupData.players) {
          if (backupData.players.player1 !== undefined) {
            state.player1Name = backupData.players.player1;
            const player1Input = document.getElementById('player1Name');
            if (player1Input) player1Input.value = backupData.players.player1;
          }
          if (backupData.players.player2 !== undefined) {
            state.player2Name = backupData.players.player2;
            const player2Input = document.getElementById('player2Name');
            if (player2Input) player2Input.value = backupData.players.player2;
          }
          savePlayers();
        }

        if (backupData.playerIcons && typeof backupData.playerIcons === 'object') {
          state.playerIcons = backupData.playerIcons;
          savePlayerIcons();
          updatePlayerIconDisplays();
        }

        saveGames();
        window.updateUI();

        showToast(`Successfully restored ${gameCount} games from backup!`, 'success');
      },
      onCancel: () => {},
    });
  } catch (e) {
    createErrorModal({
      icon: '\u274C',
      title: 'Restore Failed',
      message: 'Failed to restore backup. Please try again.',
    });
  }
}

export function backupToFile() {
  try {
    const player1Name = document.getElementById('player1Name')
      ? document.getElementById('player1Name').value
      : 'Player 1';
    const player2Name = document.getElementById('player2Name')
      ? document.getElementById('player2Name').value
      : 'Player 2';

    const data = {
      games: state.games,
      players: {
        player1: player1Name,
        player2: player2Name,
      },
      playerIcons: state.playerIcons,
      backupDate: new Date().toISOString(),
      version: '1.0',
    };

    const fileContent = JSON.stringify(data, null, 2);
    const fileName = `football-h2h-backup-${new Date().toISOString().split('T')[0]}.json`;

    const blob = new Blob([fileContent], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    autoBackupToLocalStorage();

    showToast(`Backup saved as ${fileName}`, 'success');
  } catch (e) {
    createErrorModal({
      icon: '\u274C',
      title: 'Backup Failed',
      message: 'Failed to create backup. Please try again.',
    });
  }
}

export function restoreFromFile() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';

  input.onchange = function (event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function (e) {
      try {
        const backupData = JSON.parse(e.target.result);

        if (!backupData.games || !Array.isArray(backupData.games)) {
          createErrorModal({
            icon: '\u274C',
            title: 'Invalid Backup File',
            message: 'The selected file is not a valid Football H2H backup.',
          });
          return;
        }

        const backupDate = backupData.backupDate
          ? new Date(backupData.backupDate).toLocaleString(undefined, { hour12: false })
          : 'Unknown';
        const gameCount = backupData.games.length;

        createConfirmationModal({
          icon: '\uD83D\uDCE5',
          title: 'Restore from File?',
          message: `Found backup with <strong>${gameCount} games</strong><br>
                           Created on: <strong>${backupDate}</strong><br><br>
                           <span style="color: #fc8181;">\u26A0\uFE0F Warning: This will replace all current data!</span>`,
          onConfirm: () => {
            state.games = backupData.games || [];

            if (backupData.players) {
              if (backupData.players.player1 !== undefined) {
                state.player1Name = backupData.players.player1;
                const player1Input = document.getElementById('player1Name');
                if (player1Input) player1Input.value = backupData.players.player1;
              }
              if (backupData.players.player2 !== undefined) {
                state.player2Name = backupData.players.player2;
                const player2Input = document.getElementById('player2Name');
                if (player2Input) player2Input.value = backupData.players.player2;
              }
              savePlayers();
            }

            if (backupData.playerIcons && typeof backupData.playerIcons === 'object') {
              state.playerIcons = backupData.playerIcons;
              savePlayerIcons();
              updatePlayerIconDisplays();
            }

            saveGames();
            window.updateUI();

            showToast(`Successfully restored ${gameCount} games from file!`, 'success');
          },
          onCancel: () => {},
        });
      } catch (error) {
        createErrorModal({
          icon: '\u274C',
          title: 'File Read Error',
          message: "Error reading the backup file. Please make sure it's a valid JSON file.",
        });
      }
    };
    reader.readAsText(file);
  };

  input.click();
}
