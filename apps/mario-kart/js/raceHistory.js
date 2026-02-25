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

  headerRow.textContent = '';

  const thRace = document.createElement('th');
  thRace.textContent = 'Race #';

  const thDate = document.createElement('th');
  thDate.style.cursor = 'pointer';
  thDate.setAttribute('tabindex', '0');
  thDate.setAttribute('aria-label', 'Sort by date');
  thDate.textContent = 'Date \u2195';
  thDate.addEventListener('click', () => window.sortTable('date'));
  thDate.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') window.sortTable('date');
  });

  headerRow.append(thRace, thDate);

  state.players.forEach((player) => {
    const playerName = window.PlayerNameManager
      ? window.PlayerNameManager.get(player)
      : window.getPlayerName(player);
    const th = document.createElement('th');
    th.style.cursor = 'pointer';
    th.setAttribute('tabindex', '0');
    th.setAttribute('aria-label', `Sort by ${playerName}'s position`);
    th.textContent = playerName + ' \u2195';
    th.addEventListener('click', () => window.sortTable(player));
    th.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') window.sortTable(player);
    });
    headerRow.appendChild(th);
  });

  const thAction = document.createElement('th');
  thAction.textContent = 'Action';
  headerRow.appendChild(thAction);
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

  const historyBody = document.getElementById('history-body');
  historyBody.textContent = '';

  racesToDisplay.forEach((race) => {
    const positions = state.players.map((player) => race[player]).filter((pos) => pos !== null);
    const originalIndex = filteredRaces.indexOf(race);
    const raceNumber = originalIndex + 1;
    const raceIndex = state.races.indexOf(race);

    const tr = document.createElement('tr');

    const tdNum = document.createElement('td');
    tdNum.textContent = raceNumber;

    const tdDate = document.createElement('td');
    tdDate.textContent = race.date;
    if (race.timestamp) {
      tdDate.appendChild(document.createElement('br'));
      const small = document.createElement('small');
      small.textContent = race.timestamp;
      tdDate.appendChild(small);
    }

    tr.append(tdNum, tdDate);

    state.players.forEach((player) => {
      const td = document.createElement('td');
      const position = race[player];
      const span = document.createElement('span');
      if (position !== null) {
        span.className = `position-cell ${getRelativePositionClass(position, positions)}`;
        span.textContent = position;
      } else {
        span.style.color = '#718096';
        span.textContent = '\u2014';
      }
      td.appendChild(span);
      tr.appendChild(td);
    });

    const tdActions = document.createElement('td');
    const editBtn = document.createElement('button');
    editBtn.className = 'edit-btn';
    editBtn.title = 'Edit race';
    editBtn.textContent = '\u270f\ufe0f';
    editBtn.addEventListener('click', () => window.editRace(raceIndex));
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'delete-btn';
    deleteBtn.title = 'Delete race';
    deleteBtn.textContent = '\u{1f5d1}\ufe0f';
    deleteBtn.addEventListener('click', () => window.deleteRace(raceIndex));
    tdActions.append(editBtn, deleteBtn);
    tr.appendChild(tdActions);

    historyBody.appendChild(tr);
  });

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

  const mobileHistory = document.getElementById('mobile-history');
  if (mobileHistory) {
    mobileHistory.textContent = '';

    filteredRaces
      .slice()
      .reverse()
      .forEach((race, index) => {
        const positions = state.players
          .map((player) => race[player])
          .filter((pos) => pos !== null);
        const raceNumber = filteredRaces.length - index;
        const raceIndex = state.races.indexOf(race);

        const card = document.createElement('div');
        card.className = 'race-card';

        const header = document.createElement('div');
        header.className = 'race-card-header';
        const numSpan = document.createElement('span');
        numSpan.className = 'race-number';
        numSpan.textContent = `Race #${raceNumber}`;
        const dateSpan = document.createElement('span');
        dateSpan.className = 'race-date';
        dateSpan.textContent = race.date + (race.timestamp ? ' ' + race.timestamp : '');
        header.append(numSpan, dateSpan);

        const positionsDiv = document.createElement('div');
        positionsDiv.className = 'race-positions';
        state.players.forEach((player) => {
          const position = race[player];
          if (position === null) return;
          const playerName = window.PlayerNameManager
            ? window.PlayerNameManager.get(player)
            : window.getPlayerName(player);
          const item = document.createElement('div');
          item.className = 'position-item';
          const label = document.createElement('span');
          label.className = 'player-label';
          label.textContent = playerName + ':';
          const posSpan = document.createElement('span');
          posSpan.className = `position-cell ${getRelativePositionClass(position, positions)}`;
          posSpan.textContent = position;
          item.append(label, posSpan);
          positionsDiv.appendChild(item);
        });

        const actions = document.createElement('div');
        actions.className = 'race-card-actions';
        const editBtn = document.createElement('button');
        editBtn.className = 'edit-btn';
        editBtn.title = 'Edit race';
        editBtn.textContent = '\u270f\ufe0f';
        editBtn.addEventListener('click', () => window.editRace(raceIndex));
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'delete-btn';
        deleteBtn.title = 'Delete race';
        deleteBtn.textContent = '\u{1f5d1}\ufe0f';
        deleteBtn.addEventListener('click', () => window.deleteRace(raceIndex));
        actions.append(editBtn, deleteBtn);

        card.append(header, positionsDiv, actions);
        mobileHistory.appendChild(card);
      });
  }
}
