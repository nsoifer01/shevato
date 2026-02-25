// Game display, table rendering, and sorting for Football H2H

import { state } from './store.js';

export function formatDateTime(dateString) {
  const date = new Date(dateString);
  const options = {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  };
  return date.toLocaleString(undefined, options);
}

export function formatDate(dateString) {
  const date = new Date(dateString);
  const options = {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  };
  return date.toLocaleDateString('en-US', options);
}

export function sortGames(column) {
  if (state.currentSortColumn === column) {
    state.currentSortDirection = state.currentSortDirection === 'asc' ? 'desc' : 'asc';
  } else {
    state.currentSortColumn = column;
    state.currentSortDirection = 'asc';
  }

  renderGamesTable();
}

export function updateSortIndicators() {
  document.querySelectorAll('.sort-indicator').forEach((indicator) => {
    indicator.textContent = '';
  });

  const currentIndicator = document.getElementById(`sort-${state.currentSortColumn}`);
  if (currentIndicator) {
    currentIndicator.textContent = state.currentSortDirection === 'asc' ? ' \u25B2' : ' \u25BC';
  }
}

function sortGameData(gamesData) {
  return [...gamesData].sort((a, b) => {
    let valueA, valueB;

    switch (state.currentSortColumn) {
      case 'game':
        valueA = a.id;
        valueB = b.id;
        break;

      case 'date':
        valueA = a.dateTime ? new Date(a.dateTime) : new Date(0);
        valueB = b.dateTime ? new Date(b.dateTime) : new Date(0);
        break;

      case 'player1':
        valueA = a.player1Goals;
        valueB = b.player1Goals;
        break;

      case 'player2':
        valueA = a.player2Goals;
        valueB = b.player2Goals;
        break;

      default:
        valueA = a.dateTime ? new Date(a.dateTime) : new Date(0);
        valueB = b.dateTime ? new Date(b.dateTime) : new Date(0);
    }

    if (state.currentSortDirection === 'asc') {
      return valueA < valueB ? -1 : valueA > valueB ? 1 : 0;
    } else {
      return valueA > valueB ? -1 : valueA < valueB ? 1 : 0;
    }
  });
}

export function renderGamesTable() {
  const gamesToRender = window.getFilteredGames ? window.getFilteredGames() : state.games;
  const sortedGames = sortGameData(gamesToRender);
  renderGamesTableWithData(sortedGames);
  updateSortIndicators();
}

export function renderGamesTableWithData(gamesData) {
  const tbody = document.getElementById('gamesTableBody');
  const noGamesDiv = document.getElementById('noGames');

  if (!tbody) return;

  if (gamesData.length === 0) {
    tbody.innerHTML = '';
    if (noGamesDiv) noGamesDiv.style.display = 'block';
    const existingPagination = document.querySelector('.pagination-container');
    if (existingPagination) {
      existingPagination.remove();
    }
    return;
  }

  if (noGamesDiv) noGamesDiv.style.display = 'none';

  const gamesToDisplay = window.GlobalPaginationManager
    ? window.GlobalPaginationManager.getPaginatedItems('football-h2h-games', gamesData)
    : gamesData;

  tbody.innerHTML = '';

  gamesToDisplay.forEach((game) => {
    const row = document.createElement('tr');

    let winner = '';
    if (game.player1Goals > game.player2Goals) {
      winner = 'player1';
    } else if (game.player2Goals > game.player1Goals) {
      winner = 'player2';
    } else if (game.penaltyWinner) {
      winner = game.penaltyWinner === 1 ? 'player1' : 'player2';
    }

    if (winner) row.classList.add(`${winner}-win`);

    const date = new Date(game.dateTime);
    const formattedDate = date.toLocaleDateString();
    const formattedTime = date.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });

    let player1ScoreClass = '';
    let player2ScoreClass = '';
    let player1PenaltyText = '';
    let player2PenaltyText = '';

    if (game.player1Goals === game.player2Goals) {
      if (game.penaltyWinner === 'draw') {
        player1ScoreClass = 'penalty-draw';
        player2ScoreClass = 'penalty-draw';
      } else if (game.penaltyWinner === 1) {
        player1ScoreClass = 'penalty-winner';
        player2ScoreClass = 'penalty-loser';
        player1PenaltyText = ' (penalties)';
      } else if (game.penaltyWinner === 2) {
        player1ScoreClass = 'penalty-loser';
        player2ScoreClass = 'penalty-winner';
        player2PenaltyText = ' (penalties)';
      } else {
        player1ScoreClass = 'penalty-draw';
        player2ScoreClass = 'penalty-draw';
      }
    } else {
      if (game.player1Goals > game.player2Goals) {
        player1ScoreClass = 'penalty-winner';
        player2ScoreClass = 'penalty-loser';
      } else {
        player1ScoreClass = 'penalty-loser';
        player2ScoreClass = 'penalty-winner';
      }
    }

    row.innerHTML = `
      <td class="game-number">${game.gameNumber}</td>
      <td class="game-date">${formattedDate}<br><small>${formattedTime}</small></td>
      <td class="player-score player1-score ${player1ScoreClass}">
        <span class="score-number">${game.player1Goals}</span>${player1PenaltyText}
      </td>
      <td class="player-score player2-score ${player2ScoreClass}">
        <span class="score-number">${game.player2Goals}</span>${player2PenaltyText}
      </td>
      <td class="team-name">${game.player1Team}</td>
      <td class="team-name">${game.player2Team}</td>
      <td class="actions">
        <button class="edit-btn" onclick="editGame(${game.id})" title="Edit game">\u270F\uFE0F</button>
        <button class="delete-btn" onclick="deleteGame(${game.id})" title="Delete game">\uD83D\uDDD1\uFE0F</button>
      </td>
    `;

    tbody.appendChild(row);
  });

  if (window.GlobalPaginationManager && gamesData.length > 0) {
    const paginationHtml =
      window.GlobalPaginationManager.createPaginationControls('football-h2h-games');
    const tableContainer = document.querySelector('.table-container');

    const existingPagination = document.querySelector('.pagination-container');
    if (existingPagination) {
      existingPagination.remove();
    }

    if (tableContainer) {
      tableContainer.insertAdjacentHTML('afterend', paginationHtml);
    }
  }
}

export function updateUIWithFilteredData(filteredGames) {
  const sortedGames = sortGameData(filteredGames);
  renderGamesTableWithData(sortedGames);
  updateSortIndicators();
  window.updateStatisticsWithData(filteredGames);
}
