import {
  addRace,
  undoLastAction,
  redoLastAction,
  clearData,
  exportData,
  importData,
  setDateFilter,
  applyCustomDateFilter,
  updatePlayerCount,
  updatePlayerName,
  backupToGoogleDrive,
} from './main.js';   // or wherever you actually export them

// expose as globals
Object.assign(window, {
  addRace,
  undoLastAction,
  redoLastAction,
  clearData,
  exportData,
  importData,
  setDateFilter,
  applyCustomDateFilter,
  updatePlayerCount,
  updatePlayerName,
  backupToGoogleDrive,
});
