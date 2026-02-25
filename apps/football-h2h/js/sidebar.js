// Sidebar functionality for Football H2H

import { state, saveGames } from './store.js';
import { TEAMS_DATA } from './teams-data.js';
import { showToast } from './modalUtils.js';
import { addToHistory } from './undo-redo.js';
import { updateUndoRedoButtons } from './undo-redo.js';
import { escapeHtml } from '../../../shared/utils/dom.js';

// Sidebar state
let sidebarOpen = false;
let currentDateFilter = 'all';
let customStartDate = null;
let customEndDate = null;
let sidebarPlayerSettingsOpen = false;
let sidebarGameFormOpen = false;

// --- Sidebar Navigation ---

export function toggleSidebar() {
  if (sidebarOpen) {
    closeSidebar();
  } else {
    openSidebar();
  }
}

export function openSidebar() {
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  const toggleBtn = document.getElementById('sidebar-toggle');

  sidebar.classList.add('open');
  overlay.classList.add('active');
  document.body.classList.add('sidebar-open');
  toggleBtn.setAttribute('aria-expanded', 'true');
  sidebarOpen = true;
}

export function closeSidebar() {
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  const toggleBtn = document.getElementById('sidebar-toggle');

  sidebar.classList.remove('open');
  overlay.classList.remove('active');
  document.body.classList.remove('sidebar-open');
  toggleBtn.setAttribute('aria-expanded', 'false');
  sidebarOpen = false;
}

// --- Date Filtering ---

export function setDateFilter(filter) {
  currentDateFilter = filter;

  document.querySelectorAll('.date-filter-btn').forEach((btn) => {
    btn.classList.remove('active');
  });

  document.querySelector(`[data-filter="${filter}"]`).classList.add('active');

  const customRange = document.getElementById('custom-date-range');
  if (filter === 'custom') {
    customRange.style.display = 'flex';
  } else {
    customRange.style.display = 'none';
    clearCustomDateError();
    applyDateFilter(filter);
  }
}

function applyDateFilter() {
  const filteredGames = getFilteredGames();
  displayFilteredGames(filteredGames);
}

export function applyCustomDateFilter() {
  const fromDate = document.getElementById('date-from').value;
  const toDate = document.getElementById('date-to').value;

  if (!fromDate || !toDate) {
    showCustomDateError('Please select both start and end dates');
    return;
  }

  const from = new Date(fromDate);
  const to = new Date(toDate);

  if (from > to) {
    showCustomDateError('Start date cannot be after end date');
    return;
  }

  customStartDate = fromDate;
  customEndDate = toDate;

  clearCustomDateError();

  const filteredGames = getFilteredGames();
  displayFilteredGames(filteredGames);
}

function showCustomDateError(message) {
  clearCustomDateError();

  const customRange = document.getElementById('custom-date-range');
  if (!customRange) return;

  const errorDiv = document.createElement('div');
  errorDiv.id = 'custom-date-error';
  errorDiv.style.cssText = `
    color: #ef4444;
    font-size: 0.875rem;
    margin-top: 8px;
    padding: 8px 12px;
    background: rgba(254, 178, 178, 0.1);
    border: 1px solid rgba(252, 129, 129, 0.3);
    border-radius: 6px;
    animation: errorShake 0.3s ease;
  `;
  errorDiv.textContent = message;

  customRange.appendChild(errorDiv);
}

function clearCustomDateError() {
  const existingError = document.getElementById('custom-date-error');
  if (existingError) {
    existingError.remove();
  }
}

export function getFilteredGames() {
  const allGames = state.games;
  let filteredGames = [];
  const now = new Date();

  switch (currentDateFilter) {
    case 'all':
      filteredGames = [...allGames];
      break;

    case 'today': {
      const today = now.toDateString();
      filteredGames = allGames.filter((game) => {
        if (!game.dateTime) return false;
        return new Date(game.dateTime).toDateString() === today;
      });
      break;
    }

    case 'week': {
      const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      filteredGames = allGames.filter((game) => {
        if (!game.dateTime) return false;
        return new Date(game.dateTime) >= weekAgo;
      });
      break;
    }

    case 'month': {
      const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      filteredGames = allGames.filter((game) => {
        if (!game.dateTime) return false;
        return new Date(game.dateTime) >= monthAgo;
      });
      break;
    }

    case 'custom':
      if (customStartDate && customEndDate) {
        const fromDate = new Date(customStartDate);
        const toDate = new Date(customEndDate);
        toDate.setHours(23, 59, 59, 999);

        filteredGames = allGames.filter((game) => {
          if (!game.dateTime) return false;
          const gameDate = new Date(game.dateTime);
          return gameDate >= fromDate && gameDate <= toDate;
        });
      } else {
        filteredGames = [...allGames];
      }
      break;

    default:
      filteredGames = [...allGames];
  }

  return filteredGames;
}

export function displayFilteredGames(filteredGames) {
  if (window.updateUIWithFilteredData) {
    window.updateUIWithFilteredData(filteredGames);
  }

  const totalCount = state.games.length;
  const filteredCount = filteredGames.length;

  if (filteredCount < totalCount) {
    showToast(`Showing ${filteredCount} of ${totalCount} games`, 'info');
  }
}

export function clearDateFilter() {
  setDateFilter('all');
}

// --- Date Controls ---

export function updateSidebarDate() {
  const dateInput = document.getElementById('sidebar-date-input');
  const dateText = document.getElementById('sidebar-date-text');
  const todayBtn = document.querySelector('.sidebar-date-today-btn');

  if (dateInput && dateInput.value) {
    const [year, month, day] = dateInput.value.split('-');
    const selectedDate = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
    const today = new Date();

    if (selectedDate.toDateString() === today.toDateString()) {
      if (dateText) dateText.textContent = 'Today';
      if (todayBtn) {
        todayBtn.classList.add('hidden');
      }
    } else {
      if (dateText) dateText.textContent = dateInput.value;
      if (todayBtn) {
        todayBtn.classList.remove('hidden');
      }
    }
  }
}

export function setSidebarDateToday() {
  const dateInput = document.getElementById('sidebar-date-input');
  const dateText = document.getElementById('sidebar-date-text');
  const todayBtn = document.querySelector('.sidebar-date-today-btn');

  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const day = String(today.getDate()).padStart(2, '0');
  const todayString = `${year}-${month}-${day}`;

  if (dateInput) dateInput.value = todayString;
  if (dateText) dateText.textContent = 'Today';

  if (todayBtn) {
    todayBtn.classList.add('hidden');
  }
}

// --- Player Settings ---

export function toggleSidebarPlayerSettings() {
  const settingsDiv = document.getElementById('sidebar-player-settings');
  const button = document.getElementById('sidebar-player-settings-btn');

  if (!settingsDiv || !button) return;

  if (sidebarPlayerSettingsOpen) {
    closeSidebarPlayerSettings();
  } else {
    openSidebarPlayerSettings();
  }
}

function openSidebarPlayerSettings() {
  const settingsDiv = document.getElementById('sidebar-player-settings');
  const button = document.getElementById('sidebar-player-settings-btn');

  if (!settingsDiv || !button) return;

  generateSidebarPlayerSettings();

  settingsDiv.classList.remove('hidden');
  settingsDiv.classList.add('open');
  button.classList.add('active');
  sidebarPlayerSettingsOpen = true;
}

function closeSidebarPlayerSettings() {
  const settingsDiv = document.getElementById('sidebar-player-settings');
  const button = document.getElementById('sidebar-player-settings-btn');

  if (!settingsDiv || !button) return;

  settingsDiv.classList.remove('open');
  settingsDiv.classList.add('hidden');
  button.classList.remove('active');
  sidebarPlayerSettingsOpen = false;
}

export function refreshSidebarPlayerContent() {
  if (sidebarPlayerSettingsOpen) {
    generateSidebarPlayerSettings();
  }
}

export function generateSidebarPlayerSettings() {
  const container = document.getElementById('sidebar-player-settings');
  if (!container) return;

  const p1Name = escapeHtml(state.player1Name);
  const p2Name = escapeHtml(state.player2Name);
  const p1Icon = escapeHtml(state.playerIcons?.player1 || '\u26BD');
  const p2Icon = escapeHtml(state.playerIcons?.player2 || '\u26BD');

  container.innerHTML = `
    <div class="sidebar-players-form">
      <div class="player-settings-section">
        <h4 class="section-title">Player Names</h4>
        <div class="player-input-group">
          <label for="sidebar-player1-name">Player 1</label>
          <input type="text" id="sidebar-player1-name" class="sidebar-player-input"
                 placeholder="Enter player 1 name" value="${p1Name}">
        </div>
        <div class="player-input-group">
          <label for="sidebar-player2-name">Player 2</label>
          <input type="text" id="sidebar-player2-name" class="sidebar-player-input"
                 placeholder="Enter player 2 name" value="${p2Name}">
        </div>
      </div>

      <div class="player-settings-section">
        <h4 class="section-title">Player Icons</h4>
        <div class="player-icon-row">
          <div class="player-icon-item">
            <div class="player-icon-display clickable-icon" id="sidebar-icon-selector-1">
              <span class="team-logo">${p1Icon}</span>
            </div>
            <span class="player-label">${p1Name}</span>
          </div>
          <div class="player-icon-item">
            <div class="player-icon-display clickable-icon" id="sidebar-icon-selector-2">
              <span class="team-logo">${p2Icon}</span>
            </div>
            <span class="player-label">${p2Name}</span>
          </div>
        </div>
      </div>
    </div>
  `;

  // Bind events via addEventListener instead of inline onclick
  document.getElementById('sidebar-player1-name')?.addEventListener('change', function () {
    window.updatePlayerName(1, this.value);
  });
  document.getElementById('sidebar-player2-name')?.addEventListener('change', function () {
    window.updatePlayerName(2, this.value);
  });
  document.getElementById('sidebar-icon-selector-1')?.addEventListener('click', () => {
    window.openIconSelector(1);
  });
  document.getElementById('sidebar-icon-selector-2')?.addEventListener('click', () => {
    window.openIconSelector(2);
  });
}

// --- Game Form ---

export function toggleSidebarGameForm() {
  const form = document.getElementById('sidebar-game-form');
  const button = document.getElementById('sidebar-add-game-btn');

  if (!form) return;

  if (sidebarGameFormOpen) {
    closeSidebarGameForm();
  } else {
    hideSidebarGameError();
    generateSidebarGameInputs();
    form.offsetHeight;
    form.classList.add('open');
    button.classList.add('active');
    sidebarGameFormOpen = true;
  }
}

export function closeSidebarGameForm() {
  const form = document.getElementById('sidebar-game-form');
  const button = document.getElementById('sidebar-add-game-btn');

  if (!form) return;

  form.classList.remove('open');
  button.classList.remove('active');
  sidebarGameFormOpen = false;

  const inputs = document.getElementById('sidebar-game-inputs');
  if (inputs) {
    inputs.innerHTML = '';
  }

  hideSidebarGameError();
}

function showSidebarGameError(message) {
  const errorDiv = document.getElementById('sidebar-game-error');
  if (errorDiv) {
    errorDiv.textContent = message;
    errorDiv.classList.add('show');
  }
}

function hideSidebarGameError() {
  const errorDiv = document.getElementById('sidebar-game-error');
  if (errorDiv) {
    errorDiv.classList.remove('show');
  }
}

function generateSidebarGameInputs() {
  const container = document.getElementById('sidebar-game-inputs');
  if (!container) return;

  const p1 = escapeHtml(state.player1Name);
  const p2 = escapeHtml(state.player2Name);

  container.innerHTML = `
    <div class="sidebar-game-goals">
      <div class="sidebar-player-input">
        <label for="sidebar-player1-goals">${p1} Goals:</label>
        <input type="number" id="sidebar-player1-goals" class="sidebar-goals-input"
               min="0" max="99" placeholder="">
      </div>
      <div class="sidebar-player-input">
        <label for="sidebar-player2-goals">${p2} Goals:</label>
        <input type="number" id="sidebar-player2-goals" class="sidebar-goals-input"
               min="0" max="99" placeholder="">
      </div>
      <div class="sidebar-penalty-section" id="sidebar-penalty-section" style="display: none;">
        <label for="sidebar-penalty-winner">Penalty Result:</label>
        <select id="sidebar-penalty-winner" class="sidebar-team-select">
          <option value="">Select Result</option>
          <option value="1">${p1} Won</option>
          <option value="2">${p2} Won</option>
          <option value="draw">No Winner (Draw)</option>
        </select>
      </div>
    </div>
    <div class="sidebar-game-teams">
      <div class="sidebar-player-input">
        <label for="sidebar-player1-team-type">${p1} Team Type:</label>
        <select id="sidebar-player1-team-type" class="sidebar-team-select">
          <option value="Ultimate Team">Ultimate Team</option>
          <option value="Premier League">Premier League</option>
          <option value="La Liga">La Liga</option>
          <option value="Bundesliga">Bundesliga</option>
          <option value="Serie A">Serie A</option>
          <option value="Ligue 1">Ligue 1</option>
          <option value="National Teams">National Teams</option>
          <option value="Other">Other</option>
        </select>
        <div id="sidebar-player1-team-group" style="display: none;">
          <label for="sidebar-player1-team">Select Team:</label>
          <select id="sidebar-player1-team" class="sidebar-team-select">
          </select>
        </div>
        <div id="sidebar-player1-custom-group" style="display: none;">
          <label for="sidebar-player1-custom-team">Other:</label>
          <input type="text" id="sidebar-player1-custom-team" class="sidebar-player-input"
                 placeholder="Enter team name" maxlength="15">
        </div>
      </div>
      <div class="sidebar-player-input">
        <label for="sidebar-player2-team-type">${p2} Team Type:</label>
        <select id="sidebar-player2-team-type" class="sidebar-team-select">
          <option value="Ultimate Team">Ultimate Team</option>
          <option value="Premier League">Premier League</option>
          <option value="La Liga">La Liga</option>
          <option value="Bundesliga">Bundesliga</option>
          <option value="Serie A">Serie A</option>
          <option value="Ligue 1">Ligue 1</option>
          <option value="National Teams">National Teams</option>
          <option value="Other">Other</option>
        </select>
        <div id="sidebar-player2-team-group" style="display: none;">
          <label for="sidebar-player2-team">Select Team:</label>
          <select id="sidebar-player2-team" class="sidebar-team-select">
          </select>
        </div>
        <div id="sidebar-player2-custom-group" style="display: none;">
          <label for="sidebar-player2-custom-team">Other:</label>
          <input type="text" id="sidebar-player2-custom-team" class="sidebar-player-input"
                 placeholder="Enter team name" maxlength="15">
        </div>
      </div>
    </div>
  `;

  // Bind events via addEventListener instead of inline handlers
  document
    .getElementById('sidebar-player1-goals')
    ?.addEventListener('change', () => window.checkSidebarForDraw());
  document
    .getElementById('sidebar-player2-goals')
    ?.addEventListener('change', () => window.checkSidebarForDraw());
  document
    .getElementById('sidebar-player1-team-type')
    ?.addEventListener('change', () => updateSidebarTeamOptions(1));
  document
    .getElementById('sidebar-player2-team-type')
    ?.addEventListener('change', () => updateSidebarTeamOptions(2));

  setTimeout(() => {
    updateSidebarTeamOptions(1);
    updateSidebarTeamOptions(2);
  }, 100);
}

export function updateSidebarTeamOptions(playerNumber) {
  const teamTypeSelect = document.getElementById(`sidebar-player${playerNumber}-team-type`);
  const teamGroup = document.getElementById(`sidebar-player${playerNumber}-team-group`);
  const customGroup = document.getElementById(`sidebar-player${playerNumber}-custom-group`);
  const teamSelect = document.getElementById(`sidebar-player${playerNumber}-team`);

  if (!teamTypeSelect || !teamGroup || !customGroup || !teamSelect) return;

  const selectedType = teamTypeSelect.value;

  if (selectedType === 'Ultimate Team') {
    teamGroup.style.display = 'none';
    customGroup.style.display = 'none';
  } else if (selectedType === 'Other') {
    teamGroup.style.display = 'none';
    customGroup.style.display = 'block';
  } else {
    teamGroup.style.display = 'block';
    customGroup.style.display = 'none';

    const teams = TEAMS_DATA[selectedType] || [];

    teamSelect.innerHTML = '';

    const defaultOption = document.createElement('option');
    defaultOption.value = '';
    defaultOption.textContent = 'Select Team';
    defaultOption.disabled = true;
    defaultOption.selected = true;
    teamSelect.appendChild(defaultOption);

    teams.forEach((team) => {
      const option = document.createElement('option');
      option.value = team;
      option.textContent = team;
      teamSelect.appendChild(option);
    });

    if (teams.length > 0) {
      teamSelect.selectedIndex = 1;
    }
  }
}

export function submitSidebarGame() {
  const player1Goals = document.getElementById('sidebar-player1-goals')?.value;
  const player2Goals = document.getElementById('sidebar-player2-goals')?.value;

  const player1TeamType = document.getElementById('sidebar-player1-team-type')?.value;
  const player2TeamType = document.getElementById('sidebar-player2-team-type')?.value;

  let player1Team = 'Unknown';
  let player2Team = 'Unknown';

  if (player1TeamType === 'Ultimate Team') {
    player1Team = 'Ultimate Team';
  } else if (player1TeamType === 'Other') {
    player1Team = document.getElementById('sidebar-player1-custom-team')?.value || 'Other';
  } else {
    player1Team = document.getElementById('sidebar-player1-team')?.value || player1TeamType;
  }

  if (player2TeamType === 'Ultimate Team') {
    player2Team = 'Ultimate Team';
  } else if (player2TeamType === 'Other') {
    player2Team = document.getElementById('sidebar-player2-custom-team')?.value || 'Other';
  } else {
    player2Team = document.getElementById('sidebar-player2-team')?.value || player2TeamType;
  }

  const currentPlayer1Name = state.player1Name;
  const currentPlayer2Name = state.player2Name;

  if (!player1Goals && player1Goals !== '0') {
    showSidebarGameError(`Please enter goals for ${currentPlayer1Name}`);
    return;
  }

  if (!player2Goals && player2Goals !== '0') {
    showSidebarGameError(`Please enter goals for ${currentPlayer2Name}`);
    return;
  }

  let penaltyWinner = null;
  if (player1Goals === player2Goals) {
    const penaltySelect = document.getElementById('sidebar-penalty-winner');
    const penaltyValue = penaltySelect ? penaltySelect.value : '';

    if (!penaltyValue) {
      showSidebarGameError('Please select a penalty result for draw games');
      return;
    }

    if (penaltyValue === 'draw') {
      penaltyWinner = 'draw';
    } else {
      penaltyWinner = parseInt(penaltyValue);
    }
  }

  if (player1TeamType === 'Other') {
    const customTeamName = document.getElementById('sidebar-player1-custom-team')?.value?.trim();
    if (!customTeamName) {
      showSidebarGameError(`Please enter a team name for ${currentPlayer1Name}`);
      return;
    }
  }

  if (player2TeamType === 'Other') {
    const customTeamName = document.getElementById('sidebar-player2-custom-team')?.value?.trim();
    if (!customTeamName) {
      showSidebarGameError(`Please enter a team name for ${currentPlayer2Name}`);
      return;
    }
  }

  const selectedDateInput = document.getElementById('sidebar-date-input');
  let gameDate = new Date();

  if (selectedDateInput && selectedDateInput.value) {
    const [year, month, day] = selectedDateInput.value.split('-');
    const now = new Date();
    gameDate = new Date(
      parseInt(year),
      parseInt(month) - 1,
      parseInt(day),
      now.getHours(),
      now.getMinutes(),
      now.getSeconds(),
      now.getMilliseconds(),
    );
  }

  const newGame = {
    id: Date.now(),
    player1Goals: parseInt(player1Goals),
    player2Goals: parseInt(player2Goals),
    player1Team: player1Team || 'Unknown',
    player2Team: player2Team || 'Unknown',
    penaltyWinner: penaltyWinner,
    dateTime: gameDate.toISOString(),
    gameNumber: state.games.length + 1,
  };

  state.games.push(newGame);
  saveGames();
  window.updateUI();

  addToHistory({
    type: 'add_game',
    data: newGame,
  });

  showToast('Game added successfully!', 'success');
  closeSidebarGameForm();
}

export function checkSidebarForDraw() {
  const player1Goals = document.getElementById('sidebar-player1-goals')?.value;
  const player2Goals = document.getElementById('sidebar-player2-goals')?.value;
  const penaltySection = document.getElementById('sidebar-penalty-section');

  if (
    penaltySection &&
    player1Goals !== '' &&
    player2Goals !== '' &&
    player1Goals === player2Goals
  ) {
    penaltySection.style.display = 'block';
  } else if (penaltySection) {
    penaltySection.style.display = 'none';
    const penaltySelect = document.getElementById('sidebar-penalty-winner');
    if (penaltySelect) penaltySelect.value = '';
  }
}

// --- Initialization ---

export function initializeSidebar() {
  setSidebarDateToday();
  updateSidebarDate();
  setDateFilter('all');
  updateUndoRedoButtons();
  openSidebar();

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && sidebarOpen) {
      closeSidebar();
    }
  });
}
