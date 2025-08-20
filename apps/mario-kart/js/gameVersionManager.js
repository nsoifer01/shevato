// Game Version Management
let currentGameVersion = 'mk8d'; // Default to MK8 Deluxe

// Storage key prefixes for each game version
const STORAGE_PREFIXES = {
    mk8d: 'marioKart',
    mkworld: 'marioKartWorld'
};

// Get the current storage prefix
function getStoragePrefix() {
    return STORAGE_PREFIXES[currentGameVersion];
}

// Get storage key for current game version
function getStorageKey(key) {
    const prefix = getStoragePrefix();
    // Handle existing keys that already have 'marioKart' prefix
    if (key.startsWith('marioKart')) {
        key = key.replace('marioKart', '');
    }
    return prefix + key;
}

// Initialize game version from localStorage
function initializeGameVersion() {
    const savedVersion = localStorage.getItem('selectedGameVersion');
    if (savedVersion && STORAGE_PREFIXES[savedVersion]) {
        currentGameVersion = savedVersion;
        window.currentGameVersion = savedVersion; // Update global reference
    } else {
        window.currentGameVersion = currentGameVersion; // Set initial global reference
    }
    updateVersionUI();
}

// Switch between game versions
function switchGameVersion(version) {
    if (!STORAGE_PREFIXES[version]) {
        console.error('Invalid game version:', version);
        return;
    }
    
    // Save current version preference
    currentGameVersion = version;
    window.currentGameVersion = version; // Update global reference
    localStorage.setItem('selectedGameVersion', version);
    
    // Update UI
    updateVersionUI();
    
    // Update max positions constant for the new game version
    if (window.updateMaxPositions) {
        window.updateMaxPositions();
    }
    
    // Update input limits for the new max positions
    if (window.updateInputLimits) {
        window.updateInputLimits();
    }
    
    // Update dynamic UI text for the new version
    if (window.updateDynamicUIText) {
        window.updateDynamicUIText();
    }
    
    // Regenerate sidebar race inputs with new max positions
    if (window.generateSidebarRaceInputs) {
        window.generateSidebarRaceInputs();
    }
    
    // Recreate visualization bars with new position limits
    if (window.createAllBars) {
        window.createAllBars();
    }
    
    // Reload data for the new version
    loadData();
    updateDisplay();
    updateAchievements();
    updateClearButtonState();
}

// Update UI to reflect current game version
function updateVersionUI() {
    // Update button states
    const mk8dBtn = document.getElementById('mk8d-btn');
    const mkworldBtn = document.getElementById('mkworld-btn');
    
    if (mk8dBtn && mkworldBtn) {
        if (currentGameVersion === 'mk8d') {
            mk8dBtn.classList.add('active');
            mkworldBtn.classList.remove('active');
        } else {
            mkworldBtn.classList.add('active');
            mk8dBtn.classList.remove('active');
        }
    }
    
    // Update page title
    const versionName = currentGameVersion === 'mk8d' ? 'MK8 Deluxe' : 'MK World';
    document.title = `${versionName} - Race Tracker`;
    
    // Update H1 title if it exists
    const h1 = document.querySelector('.header-section h1');
    if (h1) {
        if (currentGameVersion === 'mk8d') {
            h1.innerHTML = '🏎️ Mario Kart 8 Deluxe Tracker 🏎️';
        } else {
            h1.innerHTML = '🌍 Mario Kart World Tracker 🌍';
        }
    }
    
    // Update body class for CSS styling
    document.body.classList.remove('mk8d-mode', 'mkworld-mode');
    document.body.classList.add(currentGameVersion === 'mk8d' ? 'mk8d-mode' : 'mkworld-mode');
}

// Override localStorage methods for the app
const originalGetItem = localStorage.getItem.bind(localStorage);
const originalSetItem = localStorage.setItem.bind(localStorage);
const originalRemoveItem = localStorage.removeItem.bind(localStorage);

// Wrapper for localStorage.getItem
function getFromStorage(key) {
    // Special keys that should not be prefixed
    const unprefixedKeys = ['selectedGameVersion', 'theme', 'isDarkTheme'];
    if (unprefixedKeys.includes(key)) {
        return originalGetItem(key);
    }
    
    // For Mario Kart specific keys, use the appropriate prefix
    if (key.startsWith('marioKart')) {
        const baseKey = key.replace(/^marioKart(World)?/, '');
        const fullKey = getStorageKey(baseKey);
        return originalGetItem(fullKey);
    }
    
    return originalGetItem(key);
}

// Wrapper for localStorage.setItem
function saveToStorage(key, value) {
    // Special keys that should not be prefixed
    const unprefixedKeys = ['selectedGameVersion', 'theme', 'isDarkTheme'];
    if (unprefixedKeys.includes(key)) {
        return originalSetItem(key, value);
    }
    
    // For Mario Kart specific keys, use the appropriate prefix
    if (key.startsWith('marioKart')) {
        const baseKey = key.replace(/^marioKart(World)?/, '');
        const fullKey = getStorageKey(baseKey);
        return originalSetItem(fullKey, value);
    }
    
    return originalSetItem(key, value);
}

// Wrapper for localStorage.removeItem
function removeFromStorage(key) {
    // Special keys that should not be prefixed
    const unprefixedKeys = ['selectedGameVersion', 'theme', 'isDarkTheme'];
    if (unprefixedKeys.includes(key)) {
        return originalRemoveItem(key);
    }
    
    // For Mario Kart specific keys, use the appropriate prefix
    if (key.startsWith('marioKart')) {
        const baseKey = key.replace(/^marioKart(World)?/, '');
        const fullKey = getStorageKey(baseKey);
        return originalRemoveItem(fullKey);
    }
    
    return originalRemoveItem(key);
}

// Export functions for global use
window.switchGameVersion = switchGameVersion;
window.initializeGameVersion = initializeGameVersion;
window.getStorageKey = getStorageKey;
window.currentGameVersion = currentGameVersion;

// Function to get current game version
window.getCurrentGameVersion = function() {
    return currentGameVersion;
};