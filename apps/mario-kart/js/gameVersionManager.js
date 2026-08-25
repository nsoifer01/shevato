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

    // Rebuild the course picker for the newly selected game's course list.
    if (window.CoursePicker) {
        window.CoursePicker.refresh();
    }

    // Recreate visualization bars with new position limits
    if (window.createAllBars) {
        window.createAllBars();
    }
    
    // Reload data for the new version: races, player count, names and
    // symbols all live under the version's own keys.
    if (window.PlayerNameManager) window.PlayerNameManager.initialize();
    if (window.PlayerSymbolManager && window.PlayerSymbolManager.reload) window.PlayerSymbolManager.reload();
    if (typeof resetActionHistory === 'function') resetActionHistory();
    loadData();
    if (window.refreshSidebarRaceForm) window.refreshSidebarRaceForm();
    if (window.updateAllPlayerIcons) window.updateAllPlayerIcons();
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

// Export functions for global use
window.switchGameVersion = switchGameVersion;
window.initializeGameVersion = initializeGameVersion;
window.getStorageKey = getStorageKey;
window.currentGameVersion = currentGameVersion;

// Function to get current game version
window.getCurrentGameVersion = function() {
    return currentGameVersion;
};