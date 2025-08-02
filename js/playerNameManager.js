// Centralized Player Name Management System
// This module provides a single source of truth for player names across the app

// Storage key for localStorage
const PLAYER_NAMES_KEY = 'marioKartPlayerNames';

// Default player names
const DEFAULT_PLAYER_NAMES = {
    player1: 'Player 1',
    player2: 'Player 2', 
    player3: 'Player 3',
    player4: 'Player 4'
};

// Current player names (runtime cache)
let currentPlayerNames = null;

// Listeners for name changes
const nameChangeListeners = new Set();

// Initialize player names from localStorage or defaults
function initializePlayerNames() {
    try {
        const saved = localStorage.getItem(PLAYER_NAMES_KEY);
        if (saved) {
            currentPlayerNames = JSON.parse(saved);
            // Ensure all keys exist
            currentPlayerNames = {
                ...DEFAULT_PLAYER_NAMES,
                ...currentPlayerNames
            };
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
    const cleanName = (name || '').trim();
    if (!cleanName) return;
    
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
    currentPlayerNames = {
        ...DEFAULT_PLAYER_NAMES,
        ...names
    };
    
    // Save to localStorage
    savePlayerNames();
    
    // Notify listeners
    notifyListeners();
}

// Save current names to localStorage
function savePlayerNames() {
    try {
        localStorage.setItem(PLAYER_NAMES_KEY, JSON.stringify(currentPlayerNames));
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