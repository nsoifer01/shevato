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

    const tdNum = document.createElement('td');
    tdNum.className = 'game-number';
    tdNum.textContent = game.gameNumber;

    const tdDate = document.createElement('td');
    tdDate.className = 'game-date';
    tdDate.textContent = formattedDate;
    tdDate.appendChild(document.createElement('br'));
    const small = document.createElement('small');
    small.textContent = formattedTime;
    tdDate.appendChild(small);

    const tdP1 = document.createElement('td');
    tdP1.className = `player-score player1-score ${player1ScoreClass}`;
    const p1Score = document.createElement('span');
    p1Score.className = 'score-number';
    p1Score.textContent = game.player1Goals;
    tdP1.appendChild(p1Score);
    if (player1PenaltyText) tdP1.appendChild(document.createTextNode(player1PenaltyText));

    const tdP2 = document.createElement('td');
    tdP2.className = `player-score player2-score ${player2ScoreClass}`;
    const p2Score = document.createElement('span');
    p2Score.className = 'score-number';
    p2Score.textContent = game.player2Goals;
    tdP2.appendChild(p2Score);
    if (player2PenaltyText) tdP2.appendChild(document.createTextNode(player2PenaltyText));

    const tdTeam1 = document.createElement('td');
    tdTeam1.className = 'team-name';
    tdTeam1.textContent = game.player1Team;

    const tdTeam2 = document.createElement('td');
    tdTeam2.className = 'team-name';
    tdTeam2.textContent = game.player2Team;

    const tdActions = document.createElement('td');
    tdActions.className = 'actions';
    const editBtn = document.createElement('button');
    editBtn.className = 'edit-btn';
    editBtn.title = 'Edit game';
    editBtn.textContent = '\u270F\uFE0F';
    editBtn.addEventListener('click', () => window.editGame(game.id));
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'delete-btn';
    deleteBtn.title = 'Delete game';
    deleteBtn.textContent = '\uD83D\uDDD1\uFE0F';
    deleteBtn.addEventListener('click', () => window.deleteGame(game.id));
    tdActions.appendChild(editBtn);
    tdActions.appendChild(deleteBtn);

    row.append(tdNum, tdDate, tdP1, tdP2, tdTeam1, tdTeam2, tdActions);

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
