// Game CRUD operations for Football H2H

import { state, saveGames, savePlayers } from './store.js';
import { TEAMS_DATA } from './teams-data.js';
import {
  createFormModal,
  createConfirmationModal,
  createSuccessModal,
  createErrorModal,
  createWarningModal,
  showFormError,
  hideFormError,
  showToast,
} from './modalUtils.js';
import { applyPlayerNameChanges, updatePlayerNames } from './player-manager.js';
import { addToHistory } from './undo-redo.js';

export function showAddGameModal() {
  state.currentEditId = null;
  document.getElementById('modalTitle').textContent = 'Add New Game';
  document.getElementById('gameForm').reset();

  document.getElementById('player1TeamType').value = 'Ultimate Team';
  document.getElementById('player2TeamType').value = 'Ultimate Team';

  updateTeamOptions(1);
  updateTeamOptions(2);

  checkForDraw();
  updatePlayerNames();
  document.getElementById('gameModal').classList.add('active');
}

export function closeGameModal() {
  document.getElementById('gameModal').classList.remove('active');
  state.currentEditId = null;
}

export function checkForDraw() {
  const player1Goals = parseInt(document.getElementById('player1Goals').value) || 0;
  const player2Goals = parseInt(document.getElementById('player2Goals').value) || 0;
  const penaltyGroup = document.getElementById('penaltyGroup');

  const hasGoalValues =
    document.getElementById('player1Goals').value && document.getElementById('player2Goals').value;

  if (hasGoalValues && player1Goals === player2Goals) {
    penaltyGroup.style.display = 'block';
  } else {
    penaltyGroup.style.display = 'none';
    document.getElementById('penaltyWinner').value = '';
  }
}

export function saveGame(event) {
  event.preventDefault();

  const player1Goals = parseInt(document.getElementById('player1Goals').value) || 0;
  const player2Goals = parseInt(document.getElementById('player2Goals').value) || 0;
  const player1Team = getFinalTeamValue(1);
  const player2Team = getFinalTeamValue(2);
  const penaltyWinner = document.getElementById('penaltyWinner').value;

  if (document.getElementById('player1TeamType').value === 'Other' && !player1Team.trim()) {
    createErrorModal({
      icon: '\u274C',
      title: 'Missing Team Information',
      message: 'Please enter a custom team name for Player 1.',
    });
    return;
  }

  if (document.getElementById('player2TeamType').value === 'Other' && !player2Team.trim()) {
    createErrorModal({
      icon: '\u274C',
      title: 'Missing Team Information',
      message: 'Please enter a custom team name for Player 2.',
    });
    return;
  }

  const gameData = {
    player1Goals,
    player2Goals,
    player1Team,
    player2Team,
    penaltyWinner: penaltyWinner || null,
  };

  if (state.currentEditId) {
    const gameIndex = state.games.findIndex((m) => m.id === state.currentEditId);
    if (gameIndex !== -1) {
      const originalData = { ...state.games[gameIndex] };

      const newData = {
        ...state.games[gameIndex],
        ...gameData,
        lastModified: new Date().toISOString(),
      };
      state.games[gameIndex] = newData;

      addToHistory({
        type: 'edit_game',
        data: { originalData, newData },
      });

      showToast(
        `Game updated: ${state.player1Name} ${player1Goals} - ${player2Goals} ${state.player2Name}`,
        'success',
      );
    }
  } else {
    const newGame = {
      ...gameData,
      id: state.games.length > 0 ? Math.max(...state.games.map((m) => m.id)) + 1 : 1,
      dateTime: new Date().toISOString(),
      lastModified: new Date().toISOString(),
    };
    state.games.push(newGame);

    addToHistory({
      type: 'add_game',
      data: newGame,
    });

    showToast(
      `Game added: ${state.player1Name} ${player1Goals} - ${player2Goals} ${state.player2Name}`,
      'success',
    );
  }

  saveGames();
  window.updateUI();
  closeGameModal();
}

export function editGame(id) {
  const game = state.games.find((m) => m.id === id);
  if (!game) return;

  const currentPlayer1Name = state.player1Name;
  const currentPlayer2Name = state.player2Name;

  const gameDate = game.dateTime ? new Date(game.dateTime) : new Date();
  const year = gameDate.getFullYear();
  const month = String(gameDate.getMonth() + 1).padStart(2, '0');
  const day = String(gameDate.getDate()).padStart(2, '0');
  const formattedDate = `${year}-${month}-${day}`;
  const hours = String(gameDate.getHours()).padStart(2, '0');
  const minutes = String(gameDate.getMinutes()).padStart(2, '0');
  const seconds = String(gameDate.getSeconds()).padStart(2, '0');
  const formattedTime = `${hours}:${minutes}:${seconds}`;

  const penaltyOptions = [
    { value: '', text: 'Select Result' },
    { value: '1', text: `${currentPlayer1Name} Won` },
    { value: '2', text: `${currentPlayer2Name} Won` },
    { value: 'draw', text: 'No Winner (Draw)' },
  ];

  function getTeamTypeAndTeam(teamName) {
    if (teamName === 'Ultimate Team') {
      return { teamType: 'Ultimate Team', team: '' };
    }

    for (const [league, teams] of Object.entries(TEAMS_DATA)) {
      if (teams.includes(teamName)) {
        return { teamType: league, team: teamName };
      }
    }

    return { teamType: 'Other', team: teamName };
  }

  const player1TeamInfo = getTeamTypeAndTeam(game.player1Team || 'Ultimate Team');
  const player2TeamInfo = getTeamTypeAndTeam(game.player2Team || 'Ultimate Team');

  const teamTypeOptions = [
    { value: 'Ultimate Team', text: 'Ultimate Team' },
    { value: 'Premier League', text: 'Premier League' },
    { value: 'La Liga', text: 'La Liga' },
    { value: 'Bundesliga', text: 'Bundesliga' },
    { value: 'Serie A', text: 'Serie A' },
    { value: 'Ligue 1', text: 'Ligue 1' },
    { value: 'National Teams', text: 'National Teams' },
    { value: 'Other', text: 'Other' },
  ];

  const fields = [
    {
      id: 'date',
      type: 'date',
      label: 'Game Date',
      value: formattedDate,
      grid: true,
    },
    {
      id: 'time',
      type: 'time',
      label: 'Game Time',
      value: formattedTime,
      placeholder: 'Optional',
      step: '1',
      grid: true,
    },
    {
      id: 'player1Goals',
      type: 'number',
      label: `${currentPlayer1Name} Goals`,
      value: game.player1Goals !== undefined && game.player1Goals !== null ? game.player1Goals : '',
      min: '0',
      max: '99',
      onChange: 'checkEditModalForDraw()',
    },
    {
      id: 'player2Goals',
      type: 'number',
      label: `${currentPlayer2Name} Goals`,
      value: game.player2Goals !== undefined && game.player2Goals !== null ? game.player2Goals : '',
      min: '0',
      max: '99',
      onChange: 'checkEditModalForDraw()',
    },
    {
      id: 'penaltyWinner',
      type: 'select',
      label: 'Penalty Result',
      value:
        game.penaltyWinner !== null && game.penaltyWinner !== undefined
          ? String(game.penaltyWinner)
          : '',
      options: penaltyOptions,
    },
    {
      id: 'player1TeamType',
      type: 'select',
      label: `${currentPlayer1Name}'s Team Type`,
      value: player1TeamInfo.teamType,
      options: teamTypeOptions,
      onChange: 'updateEditModalTeamOptionsHandler(1)',
    },
    {
      id: 'player1Team',
      type: player1TeamInfo.teamType === 'Other' ? 'text' : 'select',
      label: `${currentPlayer1Name}'s Team`,
      value: player1TeamInfo.team,
      options:
        player1TeamInfo.teamType === 'Other'
          ? undefined
          : [{ value: player1TeamInfo.team, text: player1TeamInfo.team || 'Select Team' }],
      placeholder: player1TeamInfo.teamType === 'Other' ? 'Enter team name' : undefined,
      maxlength: player1TeamInfo.teamType === 'Other' ? 15 : undefined,
      hidden: player1TeamInfo.teamType === 'Ultimate Team',
    },
    {
      id: 'player2TeamType',
      type: 'select',
      label: `${currentPlayer2Name}'s Team Type`,
      value: player2TeamInfo.teamType,
      options: teamTypeOptions,
      onChange: 'updateEditModalTeamOptionsHandler(2)',
    },
    {
      id: 'player2Team',
      type: player2TeamInfo.teamType === 'Other' ? 'text' : 'select',
      label: `${currentPlayer2Name}'s Team`,
      value: player2TeamInfo.team,
      options:
        player2TeamInfo.teamType === 'Other'
          ? undefined
          : [{ value: player2TeamInfo.team, text: player2TeamInfo.team || 'Select Team' }],
      placeholder: player2TeamInfo.teamType === 'Other' ? 'Enter team name' : undefined,
      maxlength: player2TeamInfo.teamType === 'Other' ? 15 : undefined,
      hidden: player2TeamInfo.teamType === 'Ultimate Team',
    },
  ];

  createFormModal({
    icon: '\u270F\uFE0F',
    title: 'Edit Game',
    fields: fields,
    onSave: (formData) => {
      if (!formData.date) {
        showFormError('Please select a date');
        return false;
      }

      if (!formData.player1Goals && formData.player1Goals !== '0') {
        showFormError(`Please enter goals for ${currentPlayer1Name}`);
        return false;
      }

      if (!formData.player2Goals && formData.player2Goals !== '0') {
        showFormError(`Please enter goals for ${currentPlayer2Name}`);
        return false;
      }

      const p1Goals = parseInt(formData.player1Goals);
      const p2Goals = parseInt(formData.player2Goals);

      if (p1Goals === p2Goals && !formData.penaltyWinner) {
        showFormError('Please select a penalty result for draw games');
        return false;
      }

      if (
        formData.player1TeamType === 'Other' &&
        (!formData.player1Team || !formData.player1Team.trim())
      ) {
        showFormError(`Please enter a team name for ${currentPlayer1Name}`);
        return false;
      }

      if (
        formData.player2TeamType === 'Other' &&
        (!formData.player2Team || !formData.player2Team.trim())
      ) {
        showFormError(`Please enter a team name for ${currentPlayer2Name}`);
        return false;
      }

      hideFormError();

      let p1Team = 'Ultimate Team';
      let p2Team = 'Ultimate Team';

      if (formData.player1TeamType === 'Ultimate Team') {
        p1Team = 'Ultimate Team';
      } else if (formData.player1TeamType === 'Other') {
        p1Team = formData.player1Team || 'Other';
      } else {
        p1Team = formData.player1Team || formData.player1TeamType;
      }

      if (formData.player2TeamType === 'Ultimate Team') {
        p2Team = 'Ultimate Team';
      } else if (formData.player2TeamType === 'Other') {
        p2Team = formData.player2Team || 'Other';
      } else {
        p2Team = formData.player2Team || formData.player2TeamType;
      }

      const originalGame = { ...game };

      const originalDate = game.dateTime ? new Date(game.dateTime) : new Date();
      const originalDateStr = `${originalDate.getFullYear()}-${String(originalDate.getMonth() + 1).padStart(2, '0')}-${String(originalDate.getDate()).padStart(2, '0')}`;
      const originalTimeStr = `${String(originalDate.getHours()).padStart(2, '0')}:${String(originalDate.getMinutes()).padStart(2, '0')}:${String(originalDate.getSeconds()).padStart(2, '0')}`;

      let newDateTime;

      if (
        formData.date !== originalDateStr ||
        (formData.time && formData.time !== originalTimeStr)
      ) {
        const [yr, mo, dy] = formData.date.split('-');
        newDateTime = new Date(parseInt(yr), parseInt(mo) - 1, parseInt(dy));

        if (formData.time) {
          const [h, m, s] = formData.time.split(':');
          newDateTime.setHours(parseInt(h), parseInt(m), parseInt(s || 0));
        } else {
          newDateTime.setHours(
            originalDate.getHours(),
            originalDate.getMinutes(),
            originalDate.getSeconds(),
          );
        }
      } else {
        newDateTime = originalDate;
      }

      let penaltyResult = null;
      if (p1Goals === p2Goals && formData.penaltyWinner) {
        if (formData.penaltyWinner === '1') {
          penaltyResult = 1;
        } else if (formData.penaltyWinner === '2') {
          penaltyResult = 2;
        } else if (formData.penaltyWinner === 'draw') {
          penaltyResult = 'draw';
        }
      }

      const updatedGame = {
        ...game,
        player1Goals: p1Goals,
        player2Goals: p2Goals,
        player1Team: p1Team,
        player2Team: p2Team,
        penaltyWinner: penaltyResult,
        dateTime: newDateTime.toISOString(),
      };

      const gameIndex = state.games.findIndex((m) => m.id === id);
      if (gameIndex !== -1) {
        state.games[gameIndex] = updatedGame;

        addToHistory({
          type: 'edit_game',
          data: {
            originalData: originalGame,
            newData: updatedGame,
          },
        });

        saveGames();
        window.updateUI();
        showToast('Game updated successfully!', 'success');
      }
    },
    onCancel: () => {},
  });

  setTimeout(() => {
    hideFormError();
    updateEditModalTeamOptions(1, player1TeamInfo.team);
    updateEditModalTeamOptions(2, player2TeamInfo.team);
    checkEditModalForDraw();

    const penaltyField = document.getElementById('form-penaltyWinner');
    if (penaltyField && game.player1Goals !== game.player2Goals) {
      penaltyField.closest('.form-group').style.display = 'none';
    }
  }, 100);
}

export function deleteGame(id) {
  const game = state.games.find((m) => m.id === id);
  if (!game) return;

  createConfirmationModal({
    icon: '\u274C',
    title: 'Delete Game',
    message: `Are you sure you want to delete this game? <br><strong>${state.player1Name} ${game.player1Goals} - ${game.player2Goals} ${state.player2Name}</strong>`,
    isDestructive: true,
    onConfirm: () => {
      addToHistory({
        type: 'delete_game',
        data: game,
      });

      state.games = state.games.filter((m) => m.id !== id);
      saveGames();
      window.updateUI();

      showToast(
        `Game deleted: ${state.player1Name} ${game.player1Goals} - ${game.player2Goals} ${state.player2Name}`,
        'success',
      );
    },
    onCancel: () => {},
  });
}

export function confirmClearData() {
  createConfirmationModal({
    icon: '\uD83D\uDDD1\uFE0F',
    title: 'Clear All Data',
    message:
      'Are you sure you want to clear all game data? <strong>This action cannot be undone.</strong>',
    isDestructive: true,
    onConfirm: () => {
      state.games = [];
      saveGames();
      window.updateUI();

      createSuccessModal({
        icon: '\u2705',
        title: 'Data Cleared',
        message: 'All game data has been successfully cleared.',
      });
    },
    onCancel: () => {},
  });
}

export function exportData() {
  if (state.games.length === 0) {
    createWarningModal({
      icon: '\uD83D\uDCE4',
      title: 'No Data to Export',
      message: 'There are no games to export. Add some games first.',
      onConfirm: () => {},
      onCancel: () => {},
    });
    return;
  }

  const data = {
    players: {
      player1: state.player1Name,
      player2: state.player2Name,
    },
    games: state.games,
    exportDate: new Date().toISOString(),
  };

  const dataStr = JSON.stringify(data, null, 2);
  const dataUri = 'data:application/json;charset=utf-8,' + encodeURIComponent(dataStr);

  const exportFileDefaultName = `football-h2h-${new Date().toISOString().split('T')[0]}.json`;

  const linkElement = document.createElement('a');
  linkElement.setAttribute('href', dataUri);
  linkElement.setAttribute('download', exportFileDefaultName);
  linkElement.click();

  createSuccessModal({
    icon: '\uD83D\uDCE4',
    title: 'Export Complete',
    message: `Successfully exported ${state.games.length} games to <strong>${exportFileDefaultName}</strong>`,
  });
}

export function importData() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';

  input.onchange = function (event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function (e) {
      try {
        const importedData = JSON.parse(e.target.result);

        if (importedData.players) {
          state.player1Name = importedData.players.player1 || 'Player 1';
          state.player2Name = importedData.players.player2 || 'Player 2';
          savePlayers();
          applyPlayerNameChanges(state.player1Name, state.player2Name);
        }

        if (importedData.games && Array.isArray(importedData.games)) {
          state.games = importedData.games;
          saveGames();
          window.updateUI();

          createSuccessModal({
            icon: '\uD83D\uDCE5',
            title: 'Import Successful',
            message: `Successfully imported ${state.games.length} games!`,
          });
        } else {
          createErrorModal({
            icon: '\u274C',
            title: 'Import Failed',
            message: 'Invalid file format. Please select a valid Football H2H export file.',
          });
        }
      } catch (error) {
        createErrorModal({
          icon: '\u274C',
          title: 'Import Error',
          message: "Error importing file. Please make sure it's a valid JSON file.",
        });
      }
    };
    reader.readAsText(file);
  };

  input.click();
}

export function updateTeamOptions(playerNumber) {
  const teamType = document.getElementById(`player${playerNumber}TeamType`).value;
  const teamGroup = document.getElementById(`player${playerNumber}TeamGroup`);
  const customGroup = document.getElementById(`player${playerNumber}CustomGroup`);
  const teamSelect = document.getElementById(`player${playerNumber}Team`);

  teamGroup.style.display = 'none';
  customGroup.style.display = 'none';

  if (teamType === 'Ultimate Team') {
    return;
  } else if (teamType === 'Other') {
    customGroup.style.display = 'block';
    return;
  } else if (TEAMS_DATA[teamType]) {
    teamGroup.style.display = 'block';

    teamSelect.innerHTML = '';
    TEAMS_DATA[teamType].forEach((team) => {
      const option = document.createElement('option');
      option.value = team;
      option.textContent = team;
      teamSelect.appendChild(option);
    });
  }
}

export function getFinalTeamValue(playerNumber) {
  const teamType = document.getElementById(`player${playerNumber}TeamType`).value;

  if (teamType === 'Ultimate Team') {
    return 'Ultimate Team';
  } else if (teamType === 'Other') {
    return document.getElementById(`player${playerNumber}CustomTeam`).value.trim() || 'Other';
  } else if (TEAMS_DATA[teamType]) {
    return document.getElementById(`player${playerNumber}Team`).value;
  }

  return teamType;
}

export function setTeamFromValue(playerNumber, teamName) {
  const teamTypeSelect = document.getElementById(`player${playerNumber}TeamType`);

  if (teamName === 'Ultimate Team') {
    teamTypeSelect.value = 'Ultimate Team';
    updateTeamOptions(playerNumber);
    return;
  }

  for (const [league, teams] of Object.entries(TEAMS_DATA)) {
    if (teams.includes(teamName)) {
      teamTypeSelect.value = league;
      updateTeamOptions(playerNumber);
      document.getElementById(`player${playerNumber}Team`).value = teamName;
      return;
    }
  }

  teamTypeSelect.value = 'Other';
  updateTeamOptions(playerNumber);
  document.getElementById(`player${playerNumber}CustomTeam`).value = teamName;
}

export function checkEditModalForDraw() {
  const player1Goals = document.getElementById('form-player1Goals')?.value;
  const player2Goals = document.getElementById('form-player2Goals')?.value;
  const penaltyField = document.getElementById('form-penaltyWinner');

  if (penaltyField) {
    const penaltyGroup = penaltyField.closest('.form-group');
    if (player1Goals !== '' && player2Goals !== '' && player1Goals === player2Goals) {
      penaltyGroup.style.display = 'block';
    } else {
      penaltyGroup.style.display = 'none';
      penaltyField.value = '';
    }
  }
}

export function updateEditModalTeamOptions(playerNumber, currentTeam = null) {
  const teamTypeSelect = document.getElementById(`form-player${playerNumber}TeamType`);
  let teamSelect = document.getElementById(`form-player${playerNumber}Team`);
  const teamSelectGroup = teamSelect ? teamSelect.closest('.form-group') : null;

  if (!teamTypeSelect || !teamSelect) return;

  const selectedType = teamTypeSelect.value;
  if (!currentTeam) {
    currentTeam = teamSelect.value || teamSelect.getAttribute('data-original-team');
  }

  teamSelect.innerHTML = '';

  if (selectedType === 'Ultimate Team') {
    if (teamSelectGroup) {
      teamSelectGroup.style.display = 'none';
    }
    teamSelect.innerHTML = '<option value="Ultimate Team" selected>Ultimate Team</option>';
  } else if (selectedType === 'Other') {
    if (teamSelectGroup) {
      teamSelectGroup.style.display = 'block';
    }
    const currentValue = teamSelect.value || '';
    teamSelect.outerHTML = `<input type="text" id="${teamSelect.id}" value="${currentValue}" class="form-input" placeholder="Enter team name" maxlength="15">`;
  } else if (TEAMS_DATA[selectedType]) {
    if (teamSelectGroup) {
      teamSelectGroup.style.display = 'block';
    }

    if (teamSelect.type === 'text') {
      teamSelect.outerHTML = `<select id="${teamSelect.id}" class="form-input"><option value="" disabled>Select Team</option></select>`;
      const newTeamSelect = document.getElementById(
        teamSelect.id.replace('form-', '').replace(/^/, 'form-'),
      );
      if (newTeamSelect) {
        teamSelect = newTeamSelect;
      }
    } else {
      teamSelect.innerHTML = '<option value="" disabled>Select Team</option>';
    }

    TEAMS_DATA[selectedType].forEach((team) => {
      const option = document.createElement('option');
      option.value = team;
      option.textContent = team;
      if (team === currentTeam) {
        option.selected = true;
      }
      teamSelect.appendChild(option);
    });

    if (teamSelect.selectedIndex === 0 && TEAMS_DATA[selectedType].length > 0) {
      teamSelect.selectedIndex = 1;
    }
  }
}

export function updateEditModalTeamOptionsHandler(playerNumber) {
  updateEditModalTeamOptions(playerNumber, null);
}

export function toggleBackupMenu(button) {
  const menu = document.getElementById('backupMenu');
  if (!menu) {
    exportData();
    return;
  }

  const isOpen = menu.style.display !== 'none';

  if (isOpen) {
    menu.style.display = 'none';
  } else {
    menu.style.display = 'block';

    setTimeout(() => {
      document.addEventListener('click', closeBackupMenu);
    }, 0);
  }
}

function closeBackupMenu(event) {
  const menu = document.getElementById('backupMenu');
  const button = event.target.closest('.dropdown');

  if (!button || !button.contains(event.target)) {
    menu.style.display = 'none';
    document.removeEventListener('click', closeBackupMenu);
  }
}
