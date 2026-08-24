// Centralized Player Name Management System
// This module provides a single source of truth for player names across the app

// Storage key for localStorage. Names are per game version (marioKart...
// vs marioKartWorld..., same as races), resolved at every access because the
// version can switch at runtime. The base key doubles as a read-only fallback
// so a roster named before names went per-version still shows up the first
// time MK World is opened; the first rename there writes the World key.
const BASE_PLAYER_NAMES_KEY = 'marioKartPlayerNames';
function playerNamesKey() {
    return window.getStorageKey ? window.getStorageKey('PlayerNames') : BASE_PLAYER_NAMES_KEY;
}
const MAX_PLAYER_NAME_CHARS = 40;

// Default player names
const DEFAULT_PLAYER_NAMES = {
    player1: 'Player 1',
    player2: 'Player 2', 
    player3: 'Player 3',
    player4: 'Player 4'
};

// Only non-empty strings are names; anything else (a number in an imported
// file, a missing key) falls back to the slot default so every renderer can
// rely on a string.
function cleanNames(raw) {
    const out = { ...DEFAULT_PLAYER_NAMES };
    if (!raw || typeof raw !== 'object') return out;
    for (const key of Object.keys(DEFAULT_PLAYER_NAMES)) {
        const value = raw[key];
        if (typeof value !== 'string') continue;
        const clean = value.trim().slice(0, MAX_PLAYER_NAME_CHARS);
        if (clean) out[key] = clean;
    }
    return out;
}

// Current player names (runtime cache)
let currentPlayerNames = null;

// Listeners for name changes
const nameChangeListeners = new Set();

// Initialize player names from localStorage or defaults
function initializePlayerNames() {
    try {
        const saved = localStorage.getItem(playerNamesKey()) || localStorage.getItem(BASE_PLAYER_NAMES_KEY);
        if (saved) {
            currentPlayerNames = cleanNames(JSON.parse(saved));
        } else {
            currentPlayerNames = { ...DEFAULT_PLAYER_NAMES };
        }
    } catch (e) {
        console.error('Error loading player names:', e);
        currentPlayerNames = { ...DEFAULT_PLAYER_NAMES };
    }
    
    // Notify all listeners of initial load
    notifyListeners();
    
    return currentPlayerNames;
}

// Get a specific player's name
function getPlayerName(playerKey) {
    if (!currentPlayerNames) {
        initializePlayerNames();
    }
    return currentPlayerNames[playerKey] || DEFAULT_PLAYER_NAMES[playerKey] || playerKey;
}

// Get all player names
function getAllPlayerNames() {
    if (!currentPlayerNames) {
        initializePlayerNames();
    }
    return { ...currentPlayerNames };
}

// Update a specific player's name
function setPlayerName(playerKey, name) {
    if (!currentPlayerNames) {
        initializePlayerNames();
    }
    
    // Validate and clean the name
    const cleanName = String(name || '').trim().slice(0, MAX_PLAYER_NAME_CHARS);
    if (!cleanName || !DEFAULT_PLAYER_NAMES[playerKey]) return;
    
    // Update the name
    currentPlayerNames[playerKey] = cleanName;
    
    // Save to localStorage
    savePlayerNames();
    
    // Notify listeners
    notifyListeners();
}

// Update all player names at once (e.g., from import)
function setAllPlayerNames(names) {
    if (!names || typeof names !== 'object') return;
    
    // Merge with defaults to ensure all keys exist
    currentPlayerNames = cleanNames(names);
    
    // Save to localStorage
    savePlayerNames();
    
    // Notify listeners
    notifyListeners();
}

// Save current names to localStorage
function savePlayerNames() {
    try {
        localStorage.setItem(playerNamesKey(), JSON.stringify(currentPlayerNames));
    } catch (e) {
        console.error('Error saving player names:', e);
    }
}

// Add a listener for name changes
function addNameChangeListener(callback) {
    nameChangeListeners.add(callback);
    // Return unsubscribe function
    return () => {
        nameChangeListeners.delete(callback);
    };
}

// Notify all listeners of name changes
function notifyListeners() {
    const names = getAllPlayerNames();
    nameChangeListeners.forEach(callback => {
        try {
            callback(names);
        } catch (e) {
            console.error('Error in name change listener:', e);
        }
    });
}

// Helper function to get display name for a player
function getDisplayName(playerKey) {
    const name = getPlayerName(playerKey);
    return name || `Player ${playerKey.replace('player', '')}`;
}

// Export functions for global access
window.PlayerNameManager = {
    initialize: initializePlayerNames,
    get: getPlayerName,
    getAll: getAllPlayerNames,
    set: setPlayerName,
    setAll: setAllPlayerNames,
    getDisplay: getDisplayName,
    subscribe: addNameChangeListener
};

// Auto-initialize on load
document.addEventListener('DOMContentLoaded', initializePlayerNames);