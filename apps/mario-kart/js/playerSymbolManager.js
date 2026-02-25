// Player Symbol Manager - Centralized management of player symbols
const STORAGE_KEY = 'marioKartPlayerSymbols';
let playerSymbols = {};
let listeners = new Set();

function loadSymbols() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      playerSymbols = JSON.parse(saved);
    }
  } catch (e) {
    console.error('Error loading player symbols:', e);
    playerSymbols = {};
  }
}

function saveSymbols() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(playerSymbols));
  } catch (e) {
    console.error('Error saving player symbols:', e);
  }
}

function getSymbol(playerKey) {
  return playerSymbols[playerKey] || null;
}

function setSymbol(playerKey, symbol) {
  playerSymbols[playerKey] = symbol;
  saveSymbols();
  notifyListeners(playerKey);
}

function getAllSymbols() {
  return { ...playerSymbols };
}

function setAllSymbols(symbols) {
  playerSymbols = { ...symbols };
  saveSymbols();
  ['player1', 'player2', 'player3', 'player4'].forEach((playerKey) => {
    notifyListeners(playerKey);
  });
}

function clearAllSymbols() {
  playerSymbols = {};
  saveSymbols();
  ['player1', 'player2', 'player3', 'player4'].forEach((playerKey) => {
    notifyListeners(playerKey);
  });
}

function subscribe(callback) {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

function notifyListeners(playerKey) {
  listeners.forEach((callback) => {
    try {
      callback(playerKey);
    } catch (e) {
      console.error('Error in symbol listener:', e);
    }
  });
}

// Initialize on module load
loadSymbols();

export const PlayerSymbolManager = {
  getSymbol,
  setSymbol,
  getAllSymbols,
  setAllSymbols,
  clearAllSymbols,
  subscribe,
};

// Keep on window for runtime access
window.PlayerSymbolManager = PlayerSymbolManager;
window.getPlayerSymbol = getSymbol;
