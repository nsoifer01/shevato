// Football H2H - Application entry point

import { state, loadGames, loadPlayers, loadPlayerIcons, saveGames } from './store.js';
import { TEAMS_DATA } from './teams-data.js';
import {
  updatePlayerNames,
  updatePlayerName,
  handlePlayerNameChange,
  updatePlayerIconDisplays,
} from './player-manager.js';
import { updateUIWithFilteredData, sortGames } from './game-display.js';
import { updateStatisticsWithData, switchStatsTab } from './statistics.js';
import {
  showAddGameModal,
  closeGameModal,
  saveGame,
  editGame,
  deleteGame,
  confirmClearData,
  exportData,
  importData,
  updateTeamOptions,
  checkForDraw,
  toggleBackupMenu,
  checkEditModalForDraw,
  updateEditModalTeamOptions,
  updateEditModalTeamOptionsHandler,
} from './game-crud.js';
import {
  openIconSelector,
  closeIconSelector,
  showIconCategory,
  selectIcon,
  initializeIconGrids,
} from './icon-selector.js';
import {
  initializeSidebar,
  toggleSidebar,
  openSidebar,
  closeSidebar,
  setDateFilter,
  applyCustomDateFilter,
  updateSidebarDate,
  setSidebarDateToday,
  clearDateFilter,
  getFilteredGames,
  toggleSidebarPlayerSettings,
  toggleSidebarGameForm,
  closeSidebarGameForm,
  submitSidebarGame,
  updateSidebarTeamOptions,
  refreshSidebarPlayerContent,
  checkSidebarForDraw,
  generateSidebarPlayerSettings,
} from './sidebar.js';
import {
  undoLastAction,
  redoLastAction,
  addToHistory,
  updateUndoRedoButtons,
} from './undo-redo.js';
import {
  initializeAutoBackup,
  restoreFromBackup,
  backupToFile,
  restoreFromFile,
  autoBackupToLocalStorage,
} from './backup.js';
import { showToast, showFormError, hideFormError } from './modalUtils.js';

// Central UI update function (imported by no module to avoid circular deps)
function updateUI() {
  updatePlayerNames();

  const filteredGames = getFilteredGames();
  updateUIWithFilteredData(filteredGames);

  updateUndoRedoButtons();
}

// Expose functions to window for HTML onclick handlers and cross-module callbacks
window.updateUI = updateUI;
window.saveGames = saveGames;
window.getFilteredGames = getFilteredGames;
window.updateUIWithFilteredData = updateUIWithFilteredData;
window.updateStatisticsWithData = updateStatisticsWithData;
window.refreshSidebarPlayerContent = refreshSidebarPlayerContent;
window.addToHistory = addToHistory;

// Functions called from HTML onclick handlers
window.toggleSidebar = toggleSidebar;
window.openSidebar = openSidebar;
window.closeSidebar = closeSidebar;
window.showAddGameModal = showAddGameModal;
window.closeGameModal = closeGameModal;
window.saveGame = saveGame;
window.editGame = editGame;
window.deleteGame = deleteGame;
window.sortGames = sortGames;
window.checkForDraw = checkForDraw;
window.updateTeamOptions = updateTeamOptions;
window.confirmClearData = confirmClearData;
window.exportData = exportData;
window.importData = importData;
window.switchStatsTab = switchStatsTab;
window.toggleBackupMenu = toggleBackupMenu;
window.openIconSelector = openIconSelector;
window.closeIconSelector = closeIconSelector;
window.showIconCategory = showIconCategory;
window.selectIcon = selectIcon;
window.updatePlayerName = updatePlayerName;
window.handlePlayerNameChange = handlePlayerNameChange;
window.setDateFilter = setDateFilter;
window.applyCustomDateFilter = applyCustomDateFilter;
window.updateSidebarDate = updateSidebarDate;
window.setSidebarDateToday = setSidebarDateToday;
window.clearDateFilter = clearDateFilter;
window.undoLastAction = undoLastAction;
window.redoLastAction = redoLastAction;
window.toggleSidebarPlayerSettings = toggleSidebarPlayerSettings;
window.toggleSidebarGameForm = toggleSidebarGameForm;
window.closeSidebarGameForm = closeSidebarGameForm;
window.submitSidebarGame = submitSidebarGame;
window.updateSidebarTeamOptions = updateSidebarTeamOptions;
window.checkSidebarForDraw = checkSidebarForDraw;
window.generateSidebarPlayerSettings = generateSidebarPlayerSettings;
window.checkEditModalForDraw = checkEditModalForDraw;
window.updateEditModalTeamOptions = updateEditModalTeamOptions;
window.updateEditModalTeamOptionsHandler = updateEditModalTeamOptionsHandler;
window.restoreFromBackup = restoreFromBackup;
window.backupToFile = backupToFile;
window.restoreFromFile = restoreFromFile;
window.autoBackupToLocalStorage = autoBackupToLocalStorage;
window.showToast = showToast;
window.showFormError = showFormError;
window.hideFormError = hideFormError;

// Expose state for sync system compatibility
window.TEAMS_DATA = TEAMS_DATA;
Object.defineProperty(window, 'games', {
  get: () => state.games,
  set: (val) => {
    state.games = val;
  },
  configurable: true,
});
Object.defineProperty(window, 'player1Name', {
  get: () => state.player1Name,
  set: (val) => {
    state.player1Name = val;
  },
  configurable: true,
});
Object.defineProperty(window, 'player2Name', {
  get: () => state.player2Name,
  set: (val) => {
    state.player2Name = val;
  },
  configurable: true,
});
Object.defineProperty(window, 'playerIcons', {
  get: () => state.playerIcons,
  set: (val) => {
    state.playerIcons = val;
  },
  configurable: true,
});

// Close modals when clicking outside
window.onclick = function (event) {
  const modal = document.getElementById('gameModal');
  const iconModal = document.getElementById('iconSelectorModal');

  if (event.target === modal) {
    closeGameModal();
  } else if (event.target === iconModal) {
    closeIconSelector();
  }
};

// --- Initialization ---

function initializeAppData() {
  loadPlayers();
  loadPlayerIcons();
  updatePlayerIconDisplays();
  loadGames();
  updateUI();
}

// Initialize pagination
if (window.GlobalPaginationManager) {
  window.GlobalPaginationManager.createInstance('football-h2h-games', {
    localStorageKey: 'gameHistoryPageSize',
    updateCallback: updateUI,
  });
}

// Load data immediately
initializeAppData();

// Refresh when sync system becomes ready
if (!window.syncSystemInitialized) {
  window.addEventListener(
    'syncSystemReady',
    () => {
      setTimeout(() => {
        initializeAppData();
      }, 1000);
    },
    { once: true },
  );
}

// Initialize sidebar
setTimeout(() => {
  initializeSidebar();
}, 100);

// Set up goal input listeners for draw detection
const player1Goals = document.getElementById('player1Goals');
const player2Goals = document.getElementById('player2Goals');
if (player1Goals) player1Goals.addEventListener('input', checkForDraw);
if (player2Goals) player2Goals.addEventListener('input', checkForDraw);

// Initialize icon grids
initializeIconGrids();

// Initialize auto-backup
initializeAutoBackup();
