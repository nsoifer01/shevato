// Undo/Redo functionality for Football H2H

import { state, saveGames } from './store.js';
import { showToast } from './modalUtils.js';

let actionHistory = [];
let currentHistoryIndex = -1;
const MAX_HISTORY_SIZE = 50;

export function addToHistory(action) {
  if (currentHistoryIndex < actionHistory.length - 1) {
    actionHistory = actionHistory.slice(0, currentHistoryIndex + 1);
  }

  actionHistory.push(action);
  currentHistoryIndex++;

  if (actionHistory.length > MAX_HISTORY_SIZE) {
    actionHistory.shift();
    currentHistoryIndex--;
  }

  updateUndoRedoButtons();
}

export function undoLastAction() {
  if (currentHistoryIndex >= 0) {
    const action = actionHistory[currentHistoryIndex];

    switch (action.type) {
      case 'add_game':
        state.games = state.games.filter((m) => m.id !== action.data.id);
        saveGames();
        window.updateUI();
        showToast('Undid: Game added', 'info');
        break;

      case 'delete_game':
        state.games.push(action.data);
        saveGames();
        window.updateUI();
        showToast('Undid: Game deleted', 'info');
        break;

      case 'edit_game': {
        const gameIndex = state.games.findIndex((m) => m.id === action.data.newData.id);
        if (gameIndex !== -1) {
          state.games[gameIndex] = action.data.originalData;
          saveGames();
          window.updateUI();
          showToast('Undid: Game edited', 'info');
        }
        break;
      }
    }

    currentHistoryIndex--;
    updateUndoRedoButtons();
  } else {
    showToast('Nothing to undo', 'info');
  }
}

export function redoLastAction() {
  if (currentHistoryIndex < actionHistory.length - 1) {
    currentHistoryIndex++;
    const action = actionHistory[currentHistoryIndex];

    switch (action.type) {
      case 'add_game':
        state.games.push(action.data);
        saveGames();
        window.updateUI();
        showToast('Redid: Game added', 'info');
        break;

      case 'delete_game':
        state.games = state.games.filter((m) => m.id !== action.data.id);
        saveGames();
        window.updateUI();
        showToast('Redid: Game deleted', 'info');
        break;

      case 'edit_game': {
        const gameIndex = state.games.findIndex((m) => m.id === action.data.originalData.id);
        if (gameIndex !== -1) {
          state.games[gameIndex] = action.data.newData;
          saveGames();
          window.updateUI();
          showToast('Redid: Game edited', 'info');
        }
        break;
      }
    }

    updateUndoRedoButtons();
  } else {
    showToast('Nothing to redo', 'info');
  }
}

export function updateUndoRedoButtons() {
  const undoBtn = document.getElementById('sidebar-undo-btn');
  const redoBtn = document.getElementById('sidebar-redo-btn');

  if (undoBtn) {
    undoBtn.disabled = currentHistoryIndex < 0;
    undoBtn.title =
      currentHistoryIndex >= 0
        ? `Undo: ${actionHistory[currentHistoryIndex].type.replace('_', ' ')}`
        : 'Nothing to undo';
  }

  if (redoBtn) {
    redoBtn.disabled = currentHistoryIndex >= actionHistory.length - 1;
    redoBtn.title =
      currentHistoryIndex < actionHistory.length - 1
        ? `Redo: ${actionHistory[currentHistoryIndex + 1].type.replace('_', ' ')}`
        : 'Nothing to redo';
  }
}
