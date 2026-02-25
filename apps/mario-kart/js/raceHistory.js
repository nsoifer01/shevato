// Race history table rendering
// Extracted from main.js

import { state } from './store.js';
import { getRelativePositionClass } from './views.js';

export function sortTable(column) {
  if (state.sortColumn === column) {
    state.sortDirection = state.sortDirection === 'asc' ? 'desc' : 'asc';
  } else {
    state.sortColumn = column;
    state.sortDirection = 'asc';
  }

  if (window.GlobalPaginationManager) {
    window.GlobalPaginationManager.reset('mario-kart-races');
  }

  if (
    state.currentView === 'trends' ||
    state.currentView === 'activity' ||
    state.currentView === 'analysis'
  ) {
    let filteredRaces = window.getFilteredRaces();
    if (state.sortColumn) {
      filteredRaces = sortRaceData(filteredRaces);
    }
    updateRaceHistoryTable(filteredRaces);
  } else {
    window.updateDisplay();
  }
}

function sortRaceData(filteredRaces) {
  return [...filteredRaces].sort((a, b) => {
    let aVal = a[state.sortColumn];
    let bVal = b[state.sortColumn];

    if (aVal === null && bVal === null) return 0;
    if (aVal === null) return state.sortDirection === 'asc' ? 1 : -1;
    if (bVal === null) return state.sortDirection === 'asc' ? -1 : 1;

    if (state.sortColumn === 'date') {
      const aDateTime = new Date(a.date + (a.timestamp ? ' ' + a.timestamp : ''));
      const bDateTime = new Date(b.date + (b.timestamp ? ' ' + b.timestamp : ''));
      aVal = aDateTime;
      bVal = bDateTime;
    }

    if (aVal < bVal) return state.sortDirection === 'asc' ? -1 : 1;
    if (aVal > bVal) return state.sortDirection === 'asc' ? 1 : -1;
    return 0;
  });
}

export function updateHistoryTableHeaders() {
  const headerRow = document.querySelector('#history-table thead tr');
  if (!headerRow) return;

  const playerHeaders = state.players
    .map(
      (player) =>
        `<th style="cursor: pointer;" onclick="sortTable('${player}')" tabindex="0" onkeydown="if(event.key==='Enter'||event.key===' ')sortTable('${player}')" aria-label="Sort by ${window.PlayerNameManager ? window.PlayerNameManager.get(player) : window.getPlayerName(player)}'s position">${window.PlayerNameManager ? window.PlayerNameManager.get(player) : window.getPlayerName(player)} \u2195</th>`,
    )
    .join('');

  headerRow.innerHTML = `
        <th>Race #</th>
        <th style="cursor: pointer;" onclick="sortTable('date')" tabindex="0" onkeydown="if(event.key==='Enter'||event.key===' ')sortTable('date')" aria-label="Sort by date">Date \u2195</th>
        ${playerHeaders}
        <th>Action</th>
    `;
}

export function updateRaceHistoryTable(filteredRaces) {
  const raceHistorySection = document.querySelector('.race-history');

  if (filteredRaces.length === 0 || state.currentView === 'help' || state.currentView === 'guide') {
    if (raceHistorySection) {
      raceHistorySection.style.display = 'none';
    }
    return;
  }

  if (raceHistorySection) {
    raceHistorySection.style.display = 'block';
  }

  const reversedRaces = filteredRaces.slice().reverse();

  const racesToDisplay = window.GlobalPaginationManager
    ? window.GlobalPaginationManager.getPaginatedItems('mario-kart-races', reversedRaces)
    : reversedRaces;

  const historyHtml = racesToDisplay
    .map((race) => {
      const positions = state.players.map((player) => race[player]).filter((pos) => pos !== null);
      const originalIndex = filteredRaces.indexOf(race);
      const raceNumber = originalIndex + 1;
      const playerCells = state.players
        .map((player) => {
          const position = race[player];
          return position !== null
            ? `<td><span class="position-cell ${getRelativePositionClass(position, positions)}">${position}</span></td>`
            : '<td><span style="color: #718096;">\u2014</span></td>';
        })
        .join('');

      return `
        <tr>
            <td>${raceNumber}</td>
            <td>${race.date}${race.timestamp ? '<br><small>' + race.timestamp + '</small>' : ''}</td>
            ${playerCells}
            <td>
                <button class="edit-btn" onclick="editRace(${state.races.indexOf(race)})" title="Edit race">\u270f\ufe0f</button>
                <button class="delete-btn" onclick="deleteRace(${state.races.indexOf(race)})" title="Delete race">\u{1f5d1}\ufe0f</button>
            </td>
        </tr>
    `;
    })
    .join('');

  document.getElementById('history-body').innerHTML = historyHtml;

  if (window.GlobalPaginationManager && filteredRaces.length > 0) {
    const paginationHtml =
      window.GlobalPaginationManager.createPaginationControls('mario-kart-races');
    const tableContainer = document.querySelector('.table-container');

    const existingPagination = document.querySelector('.pagination-container');
    if (existingPagination) {
      existingPagination.remove();
    }

    tableContainer.insertAdjacentHTML('afterend', paginationHtml);
  }

  updateMobileRaceCards(filteredRaces);

  if (window.updateAllPlayerIcons) {
    setTimeout(() => {
      window.updateAllPlayerIcons();
    }, 100);
  }
}

export function updateMobileRaceCards(filteredRaces) {
  const raceHistorySection = document.querySelector('.race-history');

  if (filteredRaces.length === 0 || state.currentView === 'help' || state.currentView === 'guide') {
    if (raceHistorySection) {
      raceHistorySection.style.display = 'none';
    }
    return;
  }

  if (raceHistorySection) {
    raceHistorySection.style.display = 'block';
  }

  const mobileHtml = filteredRaces
    .slice()
    .reverse()
    .map((race, index) => {
      const positions = state.players.map((player) => race[player]).filter((pos) => pos !== null);
      const raceNumber = filteredRaces.length - index;

      const playerPositions = state.players
        .map((player) => {
          const position = race[player];
          const playerName = window.PlayerNameManager
            ? window.PlayerNameManager.get(player)
            : window.getPlayerName(player);
          return position !== null
            ? `
                    <div class="position-item">
                        <span class="player-label">${playerName}:</span>
                        <span class="position-cell ${getRelativePositionClass(position, positions)}">${position}</span>
                    </div>
                `
            : '';
        })
        .filter((html) => html !== '')
        .join('');

      return `
        <div class="race-card">
            <div class="race-card-header">
                <span class="race-number">Race #${raceNumber}</span>
                <span class="race-date">${race.date}${race.timestamp ? ' ' + race.timestamp : ''}</span>
            </div>
            <div class="race-positions">
                ${playerPositions}
            </div>
            <div class="race-card-actions">
                <button class="edit-btn" onclick="editRace(${state.races.indexOf(race)})" title="Edit race">\u270f\ufe0f</button>
                <button class="delete-btn" onclick="deleteRace(${state.races.indexOf(race)})" title="Delete race">\u{1f5d1}\ufe0f</button>
            </div>
        </div>
    `;
    })
    .join('');

  const mobileHistory = document.getElementById('mobile-history');
  if (mobileHistory) {
    mobileHistory.innerHTML = mobileHtml;
  }
}
