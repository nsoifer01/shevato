// Player Symbol Manager - Centralized management of player symbols
(function() {
    // Per game version, like names; the base key is the read-only fallback.
    const BASE_KEY = 'marioKartPlayerSymbols';
    const storageKey = () => (window.getStorageKey ? window.getStorageKey('PlayerSymbols') : BASE_KEY);
    let playerSymbols = {};
    let listeners = new Set();
    
    // Load symbols from localStorage on initialization
    function loadSymbols() {
        try {
            const saved = localStorage.getItem(storageKey()) || localStorage.getItem(BASE_KEY);
            playerSymbols = saved ? (JSON.parse(saved) || {}) : {};
        } catch (e) {
            console.error('Error loading player symbols:', e);
            playerSymbols = {};
        }
    }
    
    // Save symbols to localStorage
    function saveSymbols() {
        try {
            localStorage.setItem(storageKey(), JSON.stringify(playerSymbols));
        } catch (e) {
            console.error('Error saving player symbols:', e);
        }
    }
    
    // Get symbol for a player
    function getSymbol(playerKey) {
        return playerSymbols[playerKey] || null;
    }
    
    // Set symbol for a player
    function setSymbol(playerKey, symbol) {
        playerSymbols[playerKey] = symbol;
        saveSymbols();
        notifyListeners(playerKey);
    }
    
    // Get all symbols
    function getAllSymbols() {
        return { ...playerSymbols };
    }
    
    // Set all symbols at once (for imports)
    function setAllSymbols(symbols) {
        playerSymbols = { ...symbols };
        saveSymbols();
        // Notify for all players
        ['player1', 'player2', 'player3', 'player4'].forEach(playerKey => {
            notifyListeners(playerKey);
        });
    }
    
    // Clear all symbols
    function clearAllSymbols() {
        playerSymbols = {};
        saveSymbols();
        ['player1', 'player2', 'player3', 'player4'].forEach(playerKey => {
            notifyListeners(playerKey);
        });
    }
    
    // Subscribe to symbol changes
    function subscribe(callback) {
        listeners.add(callback);
        return () => listeners.delete(callback);
    }
    
    // Notify listeners of changes
    function notifyListeners(playerKey) {
        listeners.forEach(callback => {
            try {
                callback(playerKey);
            } catch (e) {
                console.error('Error in symbol listener:', e);
            }
        });
    }
    
    // Initialize on load
    loadSymbols();
    
    // Re-read storage (game version switch, foreign tab write) and notify.
    function reload() {
        loadSymbols();
        ['player1', 'player2', 'player3', 'player4'].forEach(playerKey => {
            notifyListeners(playerKey);
        });
    }

    // Export API
    window.PlayerSymbolManager = {
        reload,
        getSymbol,
        setSymbol,
        getAllSymbols,
        setAllSymbols,
        clearAllSymbols,
        subscribe
    };
    
    // Also expose the old API for backward compatibility
    window.getPlayerSymbol = getSymbol;
})();