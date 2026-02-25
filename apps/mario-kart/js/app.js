// Mario Kart Race Tracker - ES Module Entry Point
// All modules are imported here and wired together

import { state } from './store.js';

// Foundation modules
import { updateMaxPositions } from './constants.js';
import { formatDecimal } from './utils.js';
import './theme.js'; // Side-effect import (applies theme on load)
import { createModal, createConfirmationModal, createFormModal } from './modalUtils.js';

// Manager modules
import { initializeGameVersion } from './gameVersionManager.js';
import './playerNameManager.js'; // Side-effect: registers PlayerNameManager on window
import './playerSymbolManager.js'; // Side-effect: registers PlayerSymbolManager on window
import './playerIconManager.js'; // Side-effect: registers PlayerIconManager on window
import { initPlayerIconDisplay } from './playerIconDisplay.js';

// Core feature modules
import { getFilteredRaces, setDateFilter } from './dateFilter.js';
import {
  saveAction,
  undoLastAction,
  redoLastAction,
  updateUndoRedoButtons,
  actionHistory,
} from './undoRedo.js';
import {
  updatePlayerCount,
  updatePlayerFieldsVisibility,
  updateInputGroupClass,
  getPlayerName,
  updatePlayerName,
} from './playerManager.js';

// Data and statistics
import {
  addRace,
  editRace,
  deleteRace,
  exportData,
  importData,
  confirmClearData,
  updateClearButtonState,
  loadSavedData,
} from './dataManager.js';
import {
  calculateStats,
  generateH2HTable,
  generateDailyH2HTable,
  getStatClass,
} from './statistics.js';
import {
  getGoodFinishThreshold,
  getPositionRanges,
  createAllBars,
  updateAchievements,
  toggleAchievementDetails,
  toggleActiveStreaks,
  togglePositionHeatDetails,
} from './achievements.js';
import { createTrendCharts, createHeatmapView, createAnalysisView } from './charts.js';
import { initializeAutoBackup, restoreFromBackup, backupToGoogleDrive } from './backup.js';

// View management
import {
  showMessage,
  toggleView,
  createH2HView,
  createGuideView,
  createHelpView,
  createAchievementsView,
  getPositionClass,
  updateDynamicUIText,
  getRelativePositionClass,
} from './views.js';
import { sortTable, updateHistoryTableHeaders, updateRaceHistoryTable } from './raceHistory.js';

// UI components
import {
  toggleDateWidget,
  closeAllDropdowns,
  initializeSidebarDate,
  updateSidebarDate,
  setSidebarDateToday,
} from './dateCalendar.js';
import {
  toggleSidebarRaceForm,
  closeSidebarRaceForm,
  submitSidebarRace,
  refreshSidebarRaceForm,
  togglePositionPicker,
  selectPosition,
  updatePositionPicker,
  initClickOutsideHandler,
} from './sidebarRaceForm.js';
import { initializeSidebar, openSidebar } from './sidebar.js';
import { initSteppers } from './steppers.js';
import { initMobileMenu } from './mobileMenu.js';
import { initInputLimits } from './updateInputLimits.js';
import { initPlayerLabels, updatePlayerLabels } from './updatePlayerLabels.js';
import { initTooltips } from './tooltip.js';
import { initAddRaceDropdown } from './addRaceDropdown.js';
import { initPlayersDropdown } from './playersDropdown.js';
import { initSidebarPlayerSettings } from './sidebarPlayerSettings.js';

// ─── Expose functions on window for HTML onclick handlers and cross-module calls ───

// Core functions used by many modules
window.updateDisplay = updateDisplay;
window.showMessage = showMessage;
window.getFilteredRaces = getFilteredRaces;
window.getPlayerName = getPlayerName;
window.formatDecimal = formatDecimal;

// View functions
window.toggleView = toggleView;
window.createH2HView = createH2HView;
window.createGuideView = createGuideView;
window.createHelpView = createHelpView;
window.createAchievementsView = createAchievementsView;
window.getPositionClass = getPositionClass;
window.updateDynamicUIText = updateDynamicUIText;
window.getRelativePositionClass = getRelativePositionClass;

// Race history
window.sortTable = sortTable;

// Date/calendar
window.closeAllDropdowns = closeAllDropdowns;
window.toggleDateWidget = toggleDateWidget;
window.updateSidebarDate = updateSidebarDate;
window.setSidebarDateToday = setSidebarDateToday;

// Sidebar race form
window.toggleSidebarRaceForm = toggleSidebarRaceForm;
window.closeSidebarRaceForm = closeSidebarRaceForm;
window.submitSidebarRace = submitSidebarRace;
window.refreshSidebarRaceForm = refreshSidebarRaceForm;
window.togglePositionPicker = togglePositionPicker;
window.selectPosition = selectPosition;
window.updatePositionPicker = updatePositionPicker;

// Data management
window.addRace = addRace;
window.editRace = editRace;
window.deleteRace = deleteRace;
window.exportData = exportData;
window.importData = importData;
window.confirmClearData = confirmClearData;
window.updateClearButtonState = updateClearButtonState;

// Statistics
window.calculateStats = calculateStats;
window.generateH2HTable = generateH2HTable;
window.generateDailyH2HTable = generateDailyH2HTable;
window.getStatClass = getStatClass;

// Achievements
window.updateAchievements = updateAchievements;
window.createAllBars = createAllBars;
window.getGoodFinishThreshold = getGoodFinishThreshold;
window.getPositionRanges = getPositionRanges;
window.toggleAchievementDetails = toggleAchievementDetails;
window.toggleActiveStreaks = toggleActiveStreaks;
window.togglePositionHeatDetails = togglePositionHeatDetails;

// Charts
window.createTrendCharts = createTrendCharts;
window.createHeatmapView = createHeatmapView;
window.createAnalysisView = createAnalysisView;

// Backup
window.restoreFromBackup = restoreFromBackup;
window.backupToGoogleDrive = backupToGoogleDrive;

// Player management
window.updatePlayerCount = updatePlayerCount;
window.updatePlayerName = updatePlayerName;
window.updatePlayerLabels = updatePlayerLabels;

// Undo/redo
window.saveAction = saveAction;
window.undoLastAction = undoLastAction;
window.redoLastAction = redoLastAction;
window.updateUndoRedoButtons = updateUndoRedoButtons;
window.actionHistory = actionHistory;

// Date filter
window.setDateFilter = setDateFilter;

// Modals
window.createModal = createModal;
window.createConfirmationModal = createConfirmationModal;
window.createFormModal = createFormModal;

// Sidebar
window.openSidebar = openSidebar;

// ─── updateDisplay: The central display orchestrator ───

function updateDisplay() {
  updateHistoryTableHeaders();

  let filteredRaces = getFilteredRaces();

  if (state.sortColumn) {
    filteredRaces = [...filteredRaces].sort((a, b) => {
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

  updateRaceHistoryTable(filteredRaces);
  updateAchievements(filteredRaces);

  if (state.currentView === 'trends') {
    createTrendCharts(filteredRaces);
    return;
  } else if (state.currentView === 'activity') {
    createHeatmapView(filteredRaces);
    return;
  } else if (state.currentView === 'analysis') {
    createAnalysisView(filteredRaces);
    return;
  } else if (state.currentView === 'h2h') {
    createH2HView(filteredRaces);
    return;
  } else if (state.currentView === 'guide') {
    createGuideView();
    if (window.updateDynamicUIText) {
      window.updateDynamicUIText();
    }
    return;
  } else if (state.currentView === 'achievements') {
    createAchievementsView(filteredRaces);
    return;
  } else if (state.currentView === 'help') {
    createHelpView();
    if (window.updateDynamicUIText) {
      window.updateDynamicUIText();
    }
    return;
  }

  const stats = calculateStats(filteredRaces);

  if (filteredRaces.length === 0) {
    document.getElementById('stats-display').innerHTML = `
      <div class="no-data-message">
        <div style="text-align: center; padding: 60px 20px; color: #718096;">
          <h3 style="font-size: 1.5em; margin-bottom: 10px;">No race data available</h3>
          <p>Add some races to see statistics!</p>
        </div>
      </div>
    `;

    document.getElementById('history-body').innerHTML =
      `<tr><td colspan="${state.players.length + 3}" style="text-align: center; padding: 40px; color: #718096;">No races recorded yet. Add your first race above!</td></tr>`;

    return;
  }

  const statsHtml = `
    <div class="stats-container">
      <div class="stat-card">
        <div class="stat-title">Average Finish Position</div>
        <div class="stat-grid">
          ${state.players
            .map((player) => {
              const avg = parseFloat(stats.averageFinish[player]);
              const avgs = state.players.map((p) => parseFloat(stats.averageFinish[p]) || '-');
              return `
                <div class="stat-item ${getStatClass(avg || '-', avgs)}">
                  <div class="player-name">${window.PlayerNameManager ? window.PlayerNameManager.get(player) : getPlayerName(player)}</div>
                  <div class="player-value">${avg || '-'}</div>
                </div>
              `;
            })
            .join('')}
        </div>
      </div>

      <div class="stat-card">
        <div class="stat-title">First Place Finishes</div>
        <div class="stat-grid">
          ${state.players
            .map((player) => {
              const wins = stats.firstPlace[player];
              const played = stats.racesPlayed[player];
              const winRate = played > 0 ? (wins / played) * 100 : 0;
              const winRateDisplay = played > 0 ? formatDecimal(winRate) : '-';
              const allWinRates = state.players.map((p) => {
                const w = stats.firstPlace[p];
                const pl = stats.racesPlayed[p];
                return pl > 0 ? (w / pl) * 100 : '-';
              });
              return `
                <div class="stat-item ${getStatClass(played > 0 ? winRate : '-', allWinRates, true)}">
                  <div class="player-name">${window.PlayerNameManager ? window.PlayerNameManager.get(player) : getPlayerName(player)}</div>
                  <div class="player-value">${played > 0 ? winRateDisplay + '%' : '-'}</div>
                  ${played > 0 ? `<div class="stat-count">${wins}</div>` : ''}
                </div>
              `;
            })
            .join('')}
        </div>
      </div>

      <div class="stat-card">
        <div class="stat-title">Podium Finishes</div>
        <div class="stat-grid">
          ${state.players
            .map((player) => {
              const podiums = stats.podiumFinish[player];
              const played = stats.racesPlayed[player];
              const podiumRate = played > 0 ? (podiums / played) * 100 : 0;
              const podiumRateDisplay = played > 0 ? formatDecimal(podiumRate) : '-';
              const allPodiumRates = state.players.map((p) => {
                const pd = stats.podiumFinish[p];
                const pl = stats.racesPlayed[p];
                return pl > 0 ? (pd / pl) * 100 : '-';
              });
              return `
                <div class="stat-item ${getStatClass(played > 0 ? podiumRate : '-', allPodiumRates, true)}">
                  <div class="player-name">${window.PlayerNameManager ? window.PlayerNameManager.get(player) : getPlayerName(player)}</div>
                  <div class="player-value">${played > 0 ? podiumRateDisplay + '%' : '-'}</div>
                  ${played > 0 ? `<div class="stat-count">${podiums}</div>` : ''}
                </div>
              `;
            })
            .join('')}
        </div>
      </div>

      <div class="stat-card">
        <div class="stat-title">Best Podium Streak</div>
        <div class="stat-grid">
          ${state.players
            .map((player) => {
              const streak = stats.bestStreak[player];
              const played = stats.racesPlayed[player];
              const allStreaks = state.players.map((p) =>
                stats.racesPlayed[p] > 0 ? stats.bestStreak[p] : '-',
              );
              return `
                <div class="stat-item ${getStatClass(played > 0 ? streak : '-', allStreaks, true)}">
                  <div class="player-name">${window.PlayerNameManager ? window.PlayerNameManager.get(player) : getPlayerName(player)}</div>
                  <div class="player-value">${played > 0 ? streak : '-'}</div>
                </div>
              `;
            })
            .join('')}
        </div>
      </div>
    </div>
  `;

  document.getElementById('stats-display').innerHTML = statsHtml;
}

// ─── Initialization ───

document.addEventListener('DOMContentLoaded', function () {
  // Initialize game version manager first
  initializeGameVersion();

  // Ensure MAX_POSITIONS is updated for the current game version
  updateMaxPositions();

  // Initialize global pagination instance for Mario Kart
  if (window.GlobalPaginationManager) {
    window.GlobalPaginationManager.createInstance('mario-kart-races', {
      localStorageKey: 'raceHistoryPageSize',
      updateCallback: updateDisplay,
    });
  }

  // Set date to user's local timezone
  const localDate = new Date().toLocaleDateString('en-CA');
  const dateInput = document.getElementById('date');
  if (dateInput) {
    dateInput.value = localDate;
  }

  // Initialize sidebar date
  initializeSidebarDate();

  // Hide theme toggle since we only have one theme
  const themeToggle = document.getElementById('theme-toggle');
  if (themeToggle) {
    themeToggle.style.display = 'none';
  }

  // Initialize undo/redo button states
  updateUndoRedoButtons();

  // Initialize dynamic UI text based on current game version
  setTimeout(() => {
    updateDynamicUIText();
  }, 100);

  // Load saved data
  loadSavedData();

  // Update clear button state after loading data
  updateClearButtonState();

  // Set default view based on whether we have data
  const hasData = state.races && state.races.length > 0;
  if (!hasData) {
    state.currentView = 'help';
    document.querySelectorAll('.toggle-btn').forEach((btn) => {
      btn.classList.remove('active');
      btn.setAttribute('aria-selected', 'false');
    });
    const helpBtn = document.querySelector('.toggle-btn[onclick*="help"]');
    if (helpBtn) {
      helpBtn.classList.add('active');
      helpBtn.setAttribute('aria-selected', 'true');
    }
  }

  // Open sidebar by default
  openSidebar();

  // Ensure player names are loaded from localStorage
  if (window.PlayerNameManager) {
    window.playerNames = window.PlayerNameManager.getAll();
  }

  // Update player labels with loaded names
  updatePlayerLabels();

  // Create visualization bars
  createAllBars();

  updatePlayerFieldsVisibility();
  updateInputGroupClass();
  updateUndoRedoButtons();
  initializeAutoBackup();

  // Hide input-section since we don't show it in any view
  const inputSection = document.querySelector('.input-section');
  if (inputSection) {
    inputSection.style.display = 'none';
  }

  // Since default view is achievements, ensure input-group starts hidden
  const inputGroup = document.querySelector('.input-group');
  if (inputGroup) {
    const inputs = inputGroup.querySelectorAll('input[type="number"]');
    const steppers = inputGroup.querySelectorAll('.input-stepper');
    inputs.forEach((input) => (input.style.display = 'none'));
    steppers.forEach((stepper) => (stepper.style.display = 'none'));
  }

  // Initialize all UI components
  initSteppers();
  initMobileMenu();
  initInputLimits();
  initPlayerLabels();
  initTooltips();
  initAddRaceDropdown();
  initPlayersDropdown();
  initSidebarPlayerSettings();
  initPlayerIconDisplay();
  initClickOutsideHandler();
  initializeSidebar();

  // Initialize data and display
  function initializeMarioKartData() {
    updateDisplay();

    if (window.updateAllPlayerIcons) {
      window.updateAllPlayerIcons();
    }
  }

  initializeMarioKartData();

  // Refresh data when sync system becomes ready
  if (!window.syncSystemInitialized) {
    window.addEventListener(
      'syncSystemReady',
      () => {
        setTimeout(() => {
          initializeMarioKartData();
        }, 1000);
      },
      { once: true },
    );
  }

  // Subscribe to player symbol changes to update H2H tables
  if (window.PlayerSymbolManager) {
    window.PlayerSymbolManager.subscribe(() => {
      if (state.currentView === 'h2h') {
        createH2HView();
      }
    });
  }
});
