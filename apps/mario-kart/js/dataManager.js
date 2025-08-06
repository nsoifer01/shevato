let races = [];

// Detect active players from race data
function detectActivePlayersFromRaces(raceData) {
    if (!raceData || !Array.isArray(raceData) || raceData.length === 0) {
        return 3; // Default to 3 players
    }
    
    // Track which players have non-null values
    const playerActivity = {
        player1: false,
        player2: false,
        player3: false,
        player4: false
    };
    
    // Check each race for non-null player values
    raceData.forEach(race => {
        if (race.player1 !== null && race.player1 !== undefined) playerActivity.player1 = true;
        if (race.player2 !== null && race.player2 !== undefined) playerActivity.player2 = true;
        if (race.player3 !== null && race.player3 !== undefined) playerActivity.player3 = true;
        if (race.player4 !== null && race.player4 !== undefined) playerActivity.player4 = true;
    });
    
    // Count active players - find the highest player number with activity
    let activeCount = 0;
    for (let i = 4; i >= 1; i--) {
        if (playerActivity[`player${i}`]) {
            activeCount = i;
            break;
        }
    }
    
    // Return at least 1 player, max 4
    return Math.max(1, Math.min(4, activeCount));
}

function addRace() {
    const date = document.getElementById('date').value;
    // Dynamic player data collection
    const raceData = {};
    const allPlayers = ['player1', 'player2', 'player3', 'player4'];

    allPlayers.forEach(player => {
        const input = document.getElementById(player);
        const value = input ? input.value : '';
        raceData[player] = value ? parseInt(value) : null;
    });

    // Generate local time timestamp with timezone
    const now = new Date();
    const localTime = new Intl.DateTimeFormat('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    }).format(now);

    // Get user's timezone abbreviation
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const tzAbbr = new Intl.DateTimeFormat('en-US', {
        timeZoneName: 'short'
    }).formatToParts(now).find(part => part.type === 'timeZoneName')?.value || timeZone;

    const timestamp = `${localTime} ${tzAbbr}`;

    if (!date) {
        showMessage('Please select a date', true);
        return;
    }

    // Check that at least 2 players have positions (or 1 for single player mode)
    const activePlayers = players.map(p => raceData[p]).filter(pos => pos !== null);
    const minPlayers = playerCount === 1 ? 1 : 2;

    if (activePlayers.length < minPlayers) {
        showMessage(`At least ${minPlayers} player${minPlayers > 1 ? 's' : ''} must have positions`, true);
        return;
    }

    // Validate positions are in range
    if (activePlayers.some(pos => pos < MIN_POSITIONS || pos > MAX_POSITIONS)) {
        showMessage(`Positions must be between ${MIN_POSITIONS} and ${MAX_POSITIONS}`, true);
        return;
    }

    // Check for duplicate positions
    const positions = activePlayers;
    const uniquePositions = [...new Set(positions)];
    if (positions.length !== uniquePositions.length) {
        showMessage('Players cannot have the same position in a race', true);
        return;
    }

    // Create race object with all player data
    const raceObject = { date, timestamp };
    allPlayers.forEach(player => {
        raceObject[player] = raceData[player];
    });

    races.push(raceObject);
    
    // Save action for undo/redo
    saveAction('ADD_RACE', { race: raceObject });
    
    try {
        localStorage.setItem('marioKartRaces', JSON.stringify(races));
    } catch (e) {
        console.error('Error saving to localStorage:', e);
    }

    // Clear inputs for all players
    allPlayers.forEach(player => {
        const input = document.getElementById(player);
        if (input) input.value = '';
    });

    updateDisplay();
    updateAchievements();
    updateClearButtonState();
    showMessage('Race added successfully!');
}

function editRace(index) {
    const race = races[index];
    if (!race) return;

    // Create a beautiful edit modal
    const modal = document.createElement('div');
    modal.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0, 0, 0, 0.5);
        display: flex;
        justify-content: center;
        align-items: center;
        z-index: 1000;
        backdrop-filter: blur(5px);
    `;

    const dialog = document.createElement('div');
    dialog.style.cssText = `
        background: ${isDarkTheme ? '#2d3748' : 'white'};
        border-radius: 1rem;
        padding: 2rem;
        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
        max-width: 500px;
        width: 90%;
        max-height: 80vh;
        overflow-y: auto;
        animation: modalSlideIn 0.3s ease;
    `;

    const playerInputs = players.map(player => {
        const currentValue = race[player] || '';
        return `
            <div style="margin-bottom: 1rem;">
                <label style="display: block; margin-bottom: 0.5rem; color: ${isDarkTheme ? '#e2e8f0' : '#4a5568'}; font-weight: 600; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;">
                    ${window.PlayerNameManager ? window.PlayerNameManager.get(player) : getPlayerName(player)}'s Position:
                </label>
                <input type="number" id="edit-${player}" min="${MIN_POSITIONS}" max="${MAX_POSITIONS}" value="${currentValue}" 
                    style="width: 100%; padding: 0.75rem; border: 1px solid ${isDarkTheme ? '#4a5568' : '#e2e8f0'}; 
                    border-radius: 0.5rem; background: ${isDarkTheme ? '#4a5568' : 'white'}; 
                    color: ${isDarkTheme ? '#e2e8f0' : '#2d3748'}; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;" placeholder="${MIN_POSITIONS}-${MAX_POSITIONS} or leave empty">
            </div>
        `;
    }).join('');

    dialog.innerHTML = `
        <div style="text-align: center; margin-bottom: 1.5rem;">
            <div style="font-size: 2.5rem; margin-bottom: 0.5rem;">✏️</div>
            <h3 style="color: ${isDarkTheme ? '#e2e8f0' : '#2d3748'}; margin-bottom: 0.5rem; font-size: 1.5rem; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;">Edit Race</h3>
            <p style="color: ${isDarkTheme ? '#a0aec0' : '#6b7280'}; font-size: 0.9rem; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;">${race.date}${race.timestamp ? ' ' + race.timestamp : ''}</p>
        </div>
        
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-bottom: 1.5rem;">
            <div>
                <label style="display: block; margin-bottom: 0.5rem; color: ${isDarkTheme ? '#e2e8f0' : '#4a5568'}; font-weight: 600; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;">
                    Race Date:
                </label>
                <input type="date" id="edit-date" value="${race.date}" 
                    style="width: 100%; padding: 0.75rem; border: 1px solid ${isDarkTheme ? '#4a5568' : '#e2e8f0'}; 
                    border-radius: 0.5rem; background: ${isDarkTheme ? '#4a5568' : 'white'}; 
                    color: ${isDarkTheme ? '#e2e8f0' : '#2d3748'}; color-scheme: ${isDarkTheme ? 'dark' : 'light'}; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;">
            </div>
            <div>
                <label style="display: block; margin-bottom: 0.5rem; color: ${isDarkTheme ? '#e2e8f0' : '#4a5568'}; font-weight: 600; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;">
                    Race Time:
                </label>
                <input type="time" id="edit-time" value="${race.timestamp ? race.timestamp.split(' ')[0] : ''}" step="1"
                    style="width: 100%; padding: 0.75rem; border: 1px solid ${isDarkTheme ? '#4a5568' : '#e2e8f0'}; 
                    border-radius: 0.5rem; background: ${isDarkTheme ? '#4a5568' : 'white'}; 
                    color: ${isDarkTheme ? '#e2e8f0' : '#2d3748'}; color-scheme: ${isDarkTheme ? 'dark' : 'light'}; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;" placeholder="Optional">
            </div>
        </div>

        ${playerInputs}

        <div style="display: flex; gap: 1rem; justify-content: center; margin-top: 2rem;">
            <button id="save-edit" style="
                background: #10b981;
                color: white;
                border: none;
                padding: 0.75rem 1.5rem;
                border-radius: 0.5rem;
                font-weight: 600;
                cursor: pointer;
                transition: all 0.2s;
                font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            ">Save Changes</button>
            <button id="cancel-edit" style="
                background: ${isDarkTheme ? '#4a5568' : '#e2e8f0'};
                color: ${isDarkTheme ? '#e2e8f0' : '#4a5568'};
                border: none;
                padding: 0.75rem 1.5rem;
                border-radius: 0.5rem;
                font-weight: 600;
                cursor: pointer;
                transition: all 0.2s;
                font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            ">Cancel</button>
        </div>
    `;

    // Add CSS animation if not already added
    if (!document.querySelector('#modal-animation-style')) {
        const style = document.createElement('style');
        style.id = 'modal-animation-style';
        style.textContent = `
            @keyframes modalSlideIn {
                from { opacity: 0; transform: scale(0.9) translateY(-20px); }
                to { opacity: 1; transform: scale(1) translateY(0); }
            }
        `;
        document.head.appendChild(style);
    }

    modal.appendChild(dialog);
    document.body.appendChild(modal);

    // Add event listeners
    document.getElementById('cancel-edit').onclick = () => {
        document.body.removeChild(modal);
    };

    document.getElementById('save-edit').onclick = () => {
        const newDate = document.getElementById('edit-date').value;
        const newTime = document.getElementById('edit-time').value;
        
        if (!newDate) {
            showMessage('Please select a date', true);
            return;
        }

        // Save the original race for undo/redo
        const originalRace = { ...race };
        
        // Collect new position data
        const newPositions = {};
        let hasValidData = false;
        let validPositions = [];
        let validationError = false;

        players.forEach(player => {
            const input = document.getElementById(`edit-${player}`);
            const value = input.value.trim();
            if (value === '') {
                newPositions[player] = null;
            } else {
                const position = parseInt(value);
                if (position < MIN_POSITIONS || position > MAX_POSITIONS) {
                    validationError = true;
                    return;
                }
                newPositions[player] = position;
                hasValidData = true;
                validPositions.push(position);
            }
        });

        // Check if validation failed
        if (validationError) {
            showMessage(`Positions must be between ${MIN_POSITIONS} and ${MAX_POSITIONS}`, true);
            return;
        }

        // Check for duplicate positions
        const uniquePositions = [...new Set(validPositions)];
        if (validPositions.length !== uniquePositions.length) {
            showMessage('Players cannot have the same position in a race', true);
            return;
        }

        // Check minimum players
        const minPlayers = playerCount === 1 ? 1 : 2;
        if (validPositions.length < minPlayers) {
            showMessage(`At least ${minPlayers} player${minPlayers > 1 ? 's' : ''} must have positions`, true);
            return;
        }

        // Create timestamp if time is provided
        let newTimestamp = null;
        if (newTime) {
            // Get timezone info from the original timestamp or generate new one
            const originalTz = race.timestamp ? race.timestamp.split(' ').slice(1).join(' ') : null;
            if (originalTz) {
                newTimestamp = `${newTime} ${originalTz}`;
            } else {
                // Generate new timezone info
                const now = new Date();
                const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
                const tzAbbr = new Intl.DateTimeFormat('en-US', {
                    timeZoneName: 'short'
                }).formatToParts(now).find(part => part.type === 'timeZoneName')?.value || timeZone;
                newTimestamp = `${newTime} ${tzAbbr}`;
            }
        }

        // Update the race
        const updatedRace = {
            ...race,
            date: newDate,
            ...newPositions
        };

        // Add or remove timestamp
        if (newTimestamp) {
            updatedRace.timestamp = newTimestamp;
        } else {
            delete updatedRace.timestamp;
        }

        races[index] = updatedRace;

        // Save action for undo/redo
        saveAction('EDIT_RACE', { originalRace, newRace: races[index], index });

        try {
            localStorage.setItem('marioKartRaces', JSON.stringify(races));
        } catch (e) {
            console.error('Error saving to localStorage:', e);
        }

        updateDisplay();
        // Explicitly pass fresh filtered data to ensure achievements use updated race data
        const freshFilteredRaces = getFilteredRaces();
        updateAchievements(freshFilteredRaces);
        updateClearButtonState();
        showMessage('Race updated successfully!');
        document.body.removeChild(modal);
    };

    // Close on background click
    modal.onclick = (e) => {
        if (e.target === modal) {
            document.body.removeChild(modal);
        }
    };

    // Close on Escape key
    const escapeHandler = (e) => {
        if (e.key === 'Escape') {
            document.body.removeChild(modal);
            document.removeEventListener('keydown', escapeHandler);
        }
    };
    document.addEventListener('keydown', escapeHandler);
}

function deleteRace(index) {
    // Save action for undo/redo before deleting
    const raceToDelete = races[index];
    saveAction('DELETE_RACE', { race: raceToDelete, index });
    
    races.splice(index, 1);
    try {
        localStorage.setItem('marioKartRaces', JSON.stringify(races));
    } catch (e) {
        console.error('Error saving to localStorage:', e);
    }
    updateDisplay();
    updateClearButtonState();
    showMessage('Race removed successfully!');
}

function migrateRaceData(races) {
    let migrationNeeded = false;

    const migratedRaces = races.map(race => {
        // Check if this race has old format (slav, mike, nikita)
        if (race.hasOwnProperty('slav') || race.hasOwnProperty('mike') || race.hasOwnProperty('nikita')) {
            migrationNeeded = true;
            const migratedRace = {
                date: race.date,
                timestamp: race.timestamp,
                player1: race.slav || null,
                player2: race.mike || null,
                player3: race.nikita || null,
                player4: race.player4 || null
            };
            return migratedRace;
        }
        return race; // Already in new format
    });

    if (migrationNeeded) {
        console.log('Migrating race data from old format to new format');
        localStorage.setItem('marioKartRaces', JSON.stringify(migratedRaces));
    }

    return migratedRaces;
}

function loadSavedData() {
    try {
        const savedRaces = localStorage.getItem('marioKartRaces');
        // console.log('Loading saved races:', savedRaces); // Debug log
        if (savedRaces && savedRaces !== '[]') {
            races = JSON.parse(savedRaces);
            races = migrateRaceData(races);
        } else {
            races = [];
        }
    } catch (e) {
        console.error('Error loading saved races:', e);
        races = [];
    }

    // Load player names using centralized manager
    if (window.PlayerNameManager) {
        playerNames = window.PlayerNameManager.getAll();
    } else {
        // Fallback to direct localStorage
        try {
            const savedNames = localStorage.getItem('marioKartPlayerNames');
            if (savedNames) {
                playerNames = JSON.parse(savedNames);
            }
        } catch (e) {
            console.error('Error loading player names:', e);
        }
    }

    // Load player count from localStorage
    try {
        const savedPlayerCount = localStorage.getItem('marioKartPlayerCount');
        if (savedPlayerCount) {
            playerCount = parseInt(savedPlayerCount);
            const allPlayers = ['player1', 'player2', 'player3', 'player4'];
            players = allPlayers.slice(0, playerCount);

            // Update the select dropdown
            const playerCountSelect = document.getElementById('player-count');
            if (playerCountSelect) {
                playerCountSelect.value = playerCount.toString();
            }
        }
    } catch (e) {
        console.error('Error loading player count:', e);
    }
}

function exportData() {
    const data = {
        races: races,
        playerNames: window.PlayerNameManager ? window.PlayerNameManager.getAll() : playerNames,  // Include player names in export
        playerSymbols: window.PlayerSymbolManager ? window.PlayerSymbolManager.getAllSymbols() : {},  // Include player symbols
        exportDate: new Date().toISOString(),
        version: '1.4'  // Updated version
    };

    const dataStr = JSON.stringify(data, null, 2);
    const dataBlob = new Blob([dataStr], {type: 'application/json'});

    const link = document.createElement('a');
    link.href = URL.createObjectURL(dataBlob);
    link.download = `mario-kart-data-${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    showMessage('Data exported successfully!');
}

function importData(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const importedData = JSON.parse(e.target.result);

            // Validate the data structure
            if (!importedData.races || !Array.isArray(importedData.races)) {
                throw new Error('Invalid file format');
            }

            // Migration for old format data before validation
            const migratedRaces = migrateRaceData(importedData.races);

            // Validate each race entry after migration
            for (const race of migratedRaces) {
                if (!race.date || typeof race.date !== 'string') {
                    throw new Error('Invalid race data: missing or invalid date');
                }
                // timestamp is optional for backward compatibility
                if (race.timestamp && typeof race.timestamp !== 'string') {
                    throw new Error('Invalid race data: invalid timestamp');
                }
                // Validate player positions
                ['player1', 'player2', 'player3', 'player4'].forEach(player => {
                    if (race[player] !== null && race[player] !== undefined &&
                        (typeof race[player] !== 'number' || race[player] < 1 || race[player] > 24)) {
                        throw new Error(`Invalid race data: invalid ${player} position`);
                    }
                });
            }

            races = migratedRaces;
            localStorage.setItem('marioKartRaces', JSON.stringify(races));
            
            // Detect active players from race data
            const activePlayerCount = detectActivePlayersFromRaces(races);
            if (activePlayerCount > 0 && typeof updatePlayerCount === 'function') {
                updatePlayerCount(activePlayerCount);
            }
            
            // Import player names if present (backward compatible)
            if (importedData.playerNames && typeof importedData.playerNames === 'object') {
                // Use centralized PlayerNameManager
                if (window.PlayerNameManager) {
                    window.PlayerNameManager.setAll(importedData.playerNames);
                } else {
                    // Fallback
                    playerNames = {
                        player1: importedData.playerNames.player1 || 'Player 1',
                        player2: importedData.playerNames.player2 || 'Player 2',
                        player3: importedData.playerNames.player3 || 'Player 3',
                        player4: importedData.playerNames.player4 || 'Player 4'
                    };
                    
                    // Save to localStorage
                    localStorage.setItem('marioKartPlayerNames', JSON.stringify(playerNames));
                    
                    // Update all labels and inputs
                    updatePlayerLabels();
                    
                    // Update the name inputs in the widget
                    const nameInputs = ['player1-name', 'player2-name', 'player3-name', 'player4-name'];
                    nameInputs.forEach((inputId, index) => {
                        const input = document.getElementById(inputId);
                        if (input) {
                            input.value = playerNames[`player${index + 1}`];
                        }
                    });
                }
            }
            
            // Import player icons if present (version 1.2+)
            if (importedData.playerIcons && typeof importedData.playerIcons === 'object') {
                if (window.PlayerIconManager) {
                    // Clear existing icons and set new ones
                    window.PlayerIconManager.clearAllIcons();
                    Object.entries(importedData.playerIcons).forEach(([playerKey, iconData]) => {
                        if (iconData) {
                            window.PlayerIconManager.setIcon(playerKey, iconData);
                        }
                    });
                }
            }
            
            // Import player symbols if present (version 1.3+)
            if (importedData.playerSymbols && typeof importedData.playerSymbols === 'object') {
                if (window.PlayerSymbolManager) {
                    window.PlayerSymbolManager.setAllSymbols(importedData.playerSymbols);
                }
            }
            
            // If we're on Help or Guide view and just imported data, switch to Achievements
            if (typeof currentView !== 'undefined' && (currentView === 'help' || currentView === 'guide')) {
                // Switch to achievements view
                if (typeof toggleView === 'function') {
                    toggleView('achievements');
                }
            } else {
                // Otherwise just update the current view
                updateDisplay();
            }
            
            updateAchievements();
            updateClearButtonState();
            
            // Always update player icons after import, regardless of what was imported
            if (window.updateAllPlayerIcons) {
                setTimeout(() => {
                    window.updateAllPlayerIcons();
                }, 100); // Small delay to ensure DOM is ready
            }
            
            showMessage(`Successfully imported ${races.length} races!`);

        } catch (error) {
            showMessage(`Import failed: ${error.message}`, true);
        }
    };
    reader.readAsText(file);

    // Reset the file input
    event.target.value = '';
}

function confirmClearData() {
    // This function should only be called when there is data to clear
    // The button should be disabled when there's no data
    if (!races || races.length === 0) {
        return;
    }
    
    // Create a beautiful confirmation modal
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';

    const dialog = document.createElement('div');
    dialog.className = `modal-dialog ${isDarkTheme ? '' : 'light-theme'}`;

    dialog.innerHTML = `
        <div class="modal-icon">⚠️</div>
        <h3 class="modal-title ${isDarkTheme ? '' : 'light-theme'}">Clear All Data?</h3>
        <p class="modal-text ${isDarkTheme ? '' : 'light-theme'}">
            This will permanently delete all race data, statistics, automated backups, and history. This action cannot be undone.
        </p>
        <div class="modal-buttons">
            <button id="confirm-clear" class="modal-btn-danger">Delete Everything</button>
            <button id="cancel-clear" class="modal-btn-secondary ${isDarkTheme ? '' : 'light-theme'}">Cancel</button>
        </div>
    `;

    modal.appendChild(dialog);
    document.body.appendChild(modal);

    // Add event listeners
    document.getElementById('cancel-clear').onclick = () => {
        document.body.removeChild(modal);
    };

    document.getElementById('confirm-clear').onclick = () => {
        document.body.removeChild(modal);
        clearData();
    };

    // Close on background click
    modal.onclick = (e) => {
        if (e.target === modal) {
            document.body.removeChild(modal);
            document.head.removeChild(style);
        }
    };

    // Close on Escape key
    const escapeHandler = (e) => {
        if (e.key === 'Escape') {
            document.body.removeChild(modal);
            document.head.removeChild(style);
            document.removeEventListener('keydown', escapeHandler);
        }
    };
    document.addEventListener('keydown', escapeHandler);
}

function clearData() {
    // Direct clear without confirmation dialog (called from confirmClearData)
    races = [];

    // Clear only race-related data from localStorage, preserving player names and symbols
    try {
        // Save player names and symbols before clearing
        const playerNames = localStorage.getItem('marioKartPlayerNames');
        const playerSymbols = localStorage.getItem('marioKartPlayerSymbols');
        const playerCount = localStorage.getItem('marioKartPlayerCount');
        
        // Clear race data
        localStorage.removeItem('marioKartRaces');
        localStorage.removeItem('marioKartAutoBackup');
        localStorage.removeItem('marioKartActionHistory');
        
        // Set empty races array
        localStorage.setItem('marioKartRaces', '[]');
        
        // Restore player-related data
        if (playerNames) localStorage.setItem('marioKartPlayerNames', playerNames);
        if (playerSymbols) localStorage.setItem('marioKartPlayerSymbols', playerSymbols);
        if (playerCount) localStorage.setItem('marioKartPlayerCount', playerCount);
    } catch (e) {
        console.error('Error clearing localStorage:', e);
    }

    // Don't directly update innerHTML here - let updateDisplay handle it based on current view
    // This prevents destroying the achievements view structure
    
    // Update display to ensure everything is cleared properly for the current view
    updateDisplay();
    updateAchievements();

    showMessage('All data has been cleared successfully!');
    
    // Update clear button state after clearing
    updateClearButtonState();
}

function updateClearButtonState() {
    const hasData = races && races.length > 0;
    
    // Update widget clear button
    const clearBtn = document.getElementById('clear-btn');
    if (clearBtn) {
        const isFirstUpdate = !clearBtn.classList.contains('initialized');
        
        if (hasData) {
            // Enable the button
            clearBtn.disabled = false;
            clearBtn.onclick = confirmClearData;
            clearBtn.classList.remove('disabled');
        } else {
            // Disable the button (matches undo/redo behavior)
            clearBtn.disabled = true;
            clearBtn.onclick = null;
            clearBtn.classList.add('disabled');
        }
        
        // Mark as initialized to make button visible and enable transitions
        if (isFirstUpdate) {
            // Force layout to ensure styles are applied before making visible
            clearBtn.offsetHeight; // Force reflow
            clearBtn.classList.add('initialized');
        }
    }
    
    // Update sidebar clear button
    const sidebarClearBtn = document.getElementById('sidebar-clear-btn');
    if (sidebarClearBtn) {
        sidebarClearBtn.disabled = !hasData;
    }
}
