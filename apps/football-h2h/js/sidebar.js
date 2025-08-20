// Football H2H Sidebar Functionality

// Sidebar state management
let sidebarOpen = false;

// Toggle sidebar
function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebar-overlay');
    const toggleBtn = document.getElementById('sidebar-toggle');
    
    if (sidebarOpen) {
        closeSidebar();
    } else {
        openSidebar();
    }
}

// Open sidebar
function openSidebar() {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebar-overlay');
    const toggleBtn = document.getElementById('sidebar-toggle');
    
    sidebar.classList.add('open');
    overlay.classList.add('active');
    document.body.classList.add('sidebar-open');
    toggleBtn.setAttribute('aria-expanded', 'true');
    sidebarOpen = true;
}

// Close sidebar
function closeSidebar() {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebar-overlay');
    const toggleBtn = document.getElementById('sidebar-toggle');
    
    sidebar.classList.remove('open');
    overlay.classList.remove('active');
    document.body.classList.remove('sidebar-open');
    toggleBtn.setAttribute('aria-expanded', 'false');
    sidebarOpen = false;
}


// Date filter functionality
let currentDateFilter = 'all';

function setDateFilter(filter) {
    currentDateFilter = filter;
    window.currentDateFilter = currentDateFilter;
    
    // Update button states
    document.querySelectorAll('.date-filter-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    
    document.querySelector(`[data-filter="${filter}"]`).classList.add('active');
    
    // Show/hide custom date range
    const customRange = document.getElementById('custom-date-range');
    if (filter === 'custom') {
        customRange.style.display = 'flex';
    } else {
        customRange.style.display = 'none';
        clearCustomDateError(); // Clear any error when switching away from custom
        applyDateFilter(filter);
    }
}

function applyDateFilter(filter) {
    // Get filtered games using the centralized function
    const filteredGames = getFilteredGames();
    
    // Update the displayed games
    displayFilteredGames(filteredGames);
}

function applyCustomDateFilter() {
    const fromDate = document.getElementById('date-from').value;
    const toDate = document.getElementById('date-to').value;
    
    if (!fromDate || !toDate) {
        showCustomDateError('Please select both start and end dates');
        return;
    }
    
    const from = new Date(fromDate);
    const to = new Date(toDate);
    
    if (from > to) {
        showCustomDateError('Start date cannot be after end date');
        return;
    }
    
    // Store custom dates for getFilteredGames function
    customStartDate = fromDate;
    customEndDate = toDate;
    
    clearCustomDateError();
    
    // Get filtered games and display them
    const filteredGames = getFilteredGames();
    displayFilteredGames(filteredGames);
}

// Show custom date error
function showCustomDateError(message) {
    clearCustomDateError();
    
    const customRange = document.getElementById('custom-date-range');
    if (!customRange) return;
    
    const errorDiv = document.createElement('div');
    errorDiv.id = 'custom-date-error';
    errorDiv.style.cssText = `
        color: #ef4444;
        font-size: 0.875rem;
        margin-top: 8px;
        padding: 8px 12px;
        background: rgba(254, 178, 178, 0.1);
        border: 1px solid rgba(252, 129, 129, 0.3);
        border-radius: 6px;
        animation: errorShake 0.3s ease;
    `;
    errorDiv.textContent = message;
    
    customRange.appendChild(errorDiv);
}

// Clear custom date error
function clearCustomDateError() {
    const existingError = document.getElementById('custom-date-error');
    if (existingError) {
        existingError.remove();
    }
}

// Store original games for filtering
let originalGames = [];

// Function to get filtered games (similar to Mario Kart's getFilteredRaces)
function getFilteredGames() {
    const allGames = window.games || [];
    let filteredGames = [];
    const now = new Date();
    
    switch(currentDateFilter) {
        case 'all':
            filteredGames = [...allGames];
            break;
            
        case 'today':
            const today = now.toDateString();
            filteredGames = allGames.filter(game => {
                if (!game.dateTime) return false;
                return new Date(game.dateTime).toDateString() === today;
            });
            break;
            
        case 'week':
            const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
            filteredGames = allGames.filter(game => {
                if (!game.dateTime) return false;
                return new Date(game.dateTime) >= weekAgo;
            });
            break;
            
        case 'month':
            const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
            filteredGames = allGames.filter(game => {
                if (!game.dateTime) return false;
                return new Date(game.dateTime) >= monthAgo;
            });
            break;
            
        case 'custom':
            if (customStartDate && customEndDate) {
                const fromDate = new Date(customStartDate);
                const toDate = new Date(customEndDate);
                toDate.setHours(23, 59, 59, 999); // Include the entire end date
                
                filteredGames = allGames.filter(game => {
                    if (!game.dateTime) return false;
                    const gameDate = new Date(game.dateTime);
                    return gameDate >= fromDate && gameDate <= toDate;
                });
            } else {
                filteredGames = [...allGames];
            }
            break;
            
        default:
            filteredGames = [...allGames];
    }
    
    return filteredGames;
}

// Function to display filtered games
function displayFilteredGames(filteredGames) {
    // Use the new updateUI function that accepts filtered data
    if (window.updateUIWithFilteredData) {
        window.updateUIWithFilteredData(filteredGames);
    }
    
    // Show filter info
    const totalCount = window.games ? window.games.length : 0;
    const filteredCount = filteredGames.length;
    
    if (filteredCount < totalCount && window.showToast) {
        window.showToast(`Showing ${filteredCount} of ${totalCount} games`, 'info');
    }
}

// Custom date range variables (similar to Mario Kart)
let customStartDate = null;
let customEndDate = null;

// Function to restore all games (simplified)
function clearDateFilter() {
    setDateFilter('all');
}

// Game date functionality
function updateSidebarDate() {
    const dateInput = document.getElementById('sidebar-date-input');
    const dateText = document.getElementById('sidebar-date-text');
    const todayBtn = document.querySelector('.sidebar-date-today-btn');
    
    if (dateInput && dateInput.value) {
        // Parse date manually to avoid timezone issues
        const [year, month, day] = dateInput.value.split('-');
        const selectedDate = new Date(
            parseInt(year),
            parseInt(month) - 1,
            parseInt(day)
        );
        const today = new Date();
        
        // Format the date
        const options = { 
            weekday: 'short', 
            month: 'short', 
            day: 'numeric' 
        };
        
        if (selectedDate.toDateString() === today.toDateString()) {
            if (dateText) dateText.textContent = 'Today';
            // Hide the "Set to Today" button when it's already today
            if (todayBtn) {
                todayBtn.classList.add('hidden');
            }
        } else {
            if (dateText) dateText.textContent = selectedDate.toLocaleDateString('en-US', options);
            // Show the "Set to Today" button when it's not today
            if (todayBtn) {
                todayBtn.classList.remove('hidden');
            }
        }
    }
}

function setSidebarDateToday() {
    const dateInput = document.getElementById('sidebar-date-input');
    const dateText = document.getElementById('sidebar-date-text');
    const todayBtn = document.querySelector('.sidebar-date-today-btn');
    
    const today = new Date();
    // Use local date format to avoid timezone issues
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const day = String(today.getDate()).padStart(2, '0');
    const todayString = `${year}-${month}-${day}`;
    
    if (dateInput) dateInput.value = todayString;
    if (dateText) dateText.textContent = 'Today';
    
    // Hide the "Set to Today" button since we just set it to today
    if (todayBtn) {
        todayBtn.classList.add('hidden');
    }
}

// Undo/Redo functionality
let actionHistory = [];
let currentHistoryIndex = -1;
const MAX_HISTORY_SIZE = 50;

// Add action to history
function addToHistory(action) {
    // Remove any redo history if we're in the middle
    if (currentHistoryIndex < actionHistory.length - 1) {
        actionHistory = actionHistory.slice(0, currentHistoryIndex + 1);
    }
    
    actionHistory.push(action);
    currentHistoryIndex++;
    
    // Limit history size
    if (actionHistory.length > MAX_HISTORY_SIZE) {
        actionHistory.shift();
        currentHistoryIndex--;
    }
    
    updateUndoRedoButtons();
}

// Undo last action
function undoLastAction() {
    if (currentHistoryIndex >= 0) {
        const action = actionHistory[currentHistoryIndex];
        
        switch(action.type) {
            case 'add_game':
                // Remove the game that was added
                games = games.filter(m => m.id !== action.data.id);
                saveGames();
                updateUI();
                showToast(`Undid: Game added`, 'info');
                break;
                
            case 'delete_game':
                // Restore the deleted game
                games.push(action.data);
                saveGames();
                updateUI();
                showToast(`Undid: Game deleted`, 'info');
                break;
                
            case 'edit_game':
                // Restore original game data
                const gameIndex = games.findIndex(m => m.id === action.data.newData.id);
                if (gameIndex !== -1) {
                    games[gameIndex] = action.data.originalData;
                    saveGames();
                    updateUI();
                    showToast(`Undid: Game edited`, 'info');
                }
                break;
        }
        
        currentHistoryIndex--;
        updateUndoRedoButtons();
    } else {
        showToast('Nothing to undo', 'info');
    }
}

// Redo last undone action
function redoLastAction() {
    if (currentHistoryIndex < actionHistory.length - 1) {
        currentHistoryIndex++;
        const action = actionHistory[currentHistoryIndex];
        
        switch(action.type) {
            case 'add_game':
                // Re-add the game
                games.push(action.data);
                saveGames();
                updateUI();
                showToast(`Redid: Game added`, 'info');
                break;
                
            case 'delete_game':
                // Re-delete the game
                games = games.filter(m => m.id !== action.data.id);
                saveGames();
                updateUI();
                showToast(`Redid: Game deleted`, 'info');
                break;
                
            case 'edit_game':
                // Re-apply the edit
                const gameIndex = games.findIndex(m => m.id === action.data.originalData.id);
                if (gameIndex !== -1) {
                    games[gameIndex] = action.data.newData;
                    saveGames();
                    updateUI();
                    showToast(`Redid: Game edited`, 'info');
                }
                break;
        }
        
        updateUndoRedoButtons();
    } else {
        showToast('Nothing to redo', 'info');
    }
}

// Update undo/redo button states
function updateUndoRedoButtons() {
    const undoBtn = document.getElementById('sidebar-undo-btn');
    const redoBtn = document.getElementById('sidebar-redo-btn');
    
    if (undoBtn) {
        undoBtn.disabled = currentHistoryIndex < 0;
        undoBtn.title = currentHistoryIndex >= 0 ? 
            `Undo: ${actionHistory[currentHistoryIndex].type.replace('_', ' ')}` : 
            'Nothing to undo';
    }
    
    if (redoBtn) {
        redoBtn.disabled = currentHistoryIndex >= actionHistory.length - 1;
        redoBtn.title = currentHistoryIndex < actionHistory.length - 1 ? 
            `Redo: ${actionHistory[currentHistoryIndex + 1].type.replace('_', ' ')}` : 
            'Nothing to redo';
    }
}

// Initialize sidebar function (called from football-h2h.js)
function initializeSidebar() {
    // Set initial date to today
    setSidebarDateToday();
    
    // Check if the button should be hidden on load
    updateSidebarDate();
    
    // Initialize date filter
    setDateFilter('all');
    
    // Initialize undo/redo buttons
    updateUndoRedoButtons();
}

// Initialize sidebar on page load (fallback)
document.addEventListener('DOMContentLoaded', function() {
    // This will be called by football-h2h.js when ready
    
    
    // Handle escape key to close sidebar
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape' && sidebarOpen) {
            closeSidebar();
        }
    });
});

// Sidebar form state management
let sidebarPlayerSettingsOpen = false;
let sidebarGameFormOpen = false;

// Toggle sidebar player settings
function toggleSidebarPlayerSettings() {
    const settingsDiv = document.getElementById('sidebar-player-settings');
    const button = document.getElementById('sidebar-player-settings-btn');
    
    if (!settingsDiv || !button) return;
    
    if (sidebarPlayerSettingsOpen) {
        closeSidebarPlayerSettings();
    } else {
        openSidebarPlayerSettings();
    }
}

function openSidebarPlayerSettings() {
    const settingsDiv = document.getElementById('sidebar-player-settings');
    const button = document.getElementById('sidebar-player-settings-btn');
    
    if (!settingsDiv || !button) return;
    
    // Generate player settings content
    generateSidebarPlayerSettings();
    
    // Show the settings
    settingsDiv.classList.remove('hidden');
    settingsDiv.classList.add('open');
    button.classList.add('active');
    sidebarPlayerSettingsOpen = true;
}

function closeSidebarPlayerSettings() {
    const settingsDiv = document.getElementById('sidebar-player-settings');
    const button = document.getElementById('sidebar-player-settings-btn');
    
    if (!settingsDiv || !button) return;
    
    settingsDiv.classList.remove('open');
    settingsDiv.classList.add('hidden');
    button.classList.remove('active');
    sidebarPlayerSettingsOpen = false;
}

// Toggle sidebar game form
function toggleSidebarGameForm() {
    const form = document.getElementById('sidebar-game-form');
    const button = document.getElementById('sidebar-add-game-btn');
    
    if (!form) return;
    
    if (sidebarGameFormOpen) {
        closeSidebarGameForm();
    } else {
        // Clear any previous errors
        hideSidebarGameError();
        
        // Generate game inputs
        generateSidebarGameInputs();
        
        // Force a reflow to ensure the initial state is applied
        form.offsetHeight;
        
        // Show the form
        form.classList.add('open');
        button.classList.add('active');
        sidebarGameFormOpen = true;
    }
}

function closeSidebarGameForm() {
    const form = document.getElementById('sidebar-game-form');
    const button = document.getElementById('sidebar-add-game-btn');
    
    if (!form) return;
    
    form.classList.remove('open');
    button.classList.remove('active');
    sidebarGameFormOpen = false;
    
    // Clear form
    const inputs = document.getElementById('sidebar-game-inputs');
    if (inputs) {
        inputs.innerHTML = '';
    }
    
    // Hide any errors
    hideSidebarGameError();
}

// Show sidebar game error
function showSidebarGameError(message) {
    const errorDiv = document.getElementById('sidebar-game-error');
    if (errorDiv) {
        errorDiv.textContent = message;
        errorDiv.classList.add('show');
    }
}

// Hide sidebar game error
function hideSidebarGameError() {
    const errorDiv = document.getElementById('sidebar-game-error');
    if (errorDiv) {
        errorDiv.classList.remove('show');
    }
}

// Refresh sidebar content when player data changes
function refreshSidebarPlayerContent() {
    // If player settings are open, regenerate them
    if (sidebarPlayerSettingsOpen) {
        generateSidebarPlayerSettings();
    }
}

// Generate sidebar player settings content
function generateSidebarPlayerSettings() {
    const container = document.getElementById('sidebar-player-settings');
    if (!container) return;
    
    // Get current player data from global variables
    const currentPlayer1Name = window.player1Name || 'Player 1';
    const currentPlayer2Name = window.player2Name || 'Player 2';
    const currentPlayer1Icon = window.playerIcons?.player1 || '⚽';
    const currentPlayer2Icon = window.playerIcons?.player2 || '⚽';
    
    container.innerHTML = `
        <div class="sidebar-players-form">
            <div class="player-settings-section">
                <h4 class="section-title">Player Names</h4>
                <div class="player-input-group">
                    <label for="sidebar-player1-name">Player 1</label>
                    <input type="text" id="sidebar-player1-name" class="sidebar-player-input" 
                           placeholder="Enter player 1 name" value="${currentPlayer1Name}" 
                           onchange="updatePlayerName(1, this.value)">
                </div>
                <div class="player-input-group">
                    <label for="sidebar-player2-name">Player 2</label>
                    <input type="text" id="sidebar-player2-name" class="sidebar-player-input" 
                           placeholder="Enter player 2 name" value="${currentPlayer2Name}" 
                           onchange="updatePlayerName(2, this.value)">
                </div>
            </div>
            
            <div class="player-settings-section">
                <h4 class="section-title">Player Icons</h4>
                <div class="player-icon-row">
                    <div class="player-icon-item">
                        <div class="player-icon-display clickable-icon" onclick="openIconSelector(1)">
                            <span class="team-logo">${currentPlayer1Icon}</span>
                        </div>
                        <span class="player-label">${currentPlayer1Name}</span>
                    </div>
                    <div class="player-icon-item">
                        <div class="player-icon-display clickable-icon" onclick="openIconSelector(2)">
                            <span class="team-logo">${currentPlayer2Icon}</span>
                        </div>
                        <span class="player-label">${currentPlayer2Name}</span>
                    </div>
                </div>
            </div>
        </div>
    `;
}

// Generate sidebar game inputs
function generateSidebarGameInputs() {
    const container = document.getElementById('sidebar-game-inputs');
    if (!container) return;
    
    // Get current player names from global variables or fallback to main function
    let currentPlayer1Name = 'Player 1';
    let currentPlayer2Name = 'Player 2';
    
    if (window.player1Name) {
        currentPlayer1Name = window.player1Name;
    } else if (window.getCurrentPlayerNames) {
        const names = window.getCurrentPlayerNames();
        currentPlayer1Name = names.player1;
        currentPlayer2Name = names.player2;
    }
    
    if (window.player2Name) {
        currentPlayer2Name = window.player2Name;
    }
    
    container.innerHTML = `
        <div class="sidebar-game-goals">
            <div class="sidebar-player-input">
                <label for="sidebar-player1-goals">${currentPlayer1Name} Goals:</label>
                <input type="number" id="sidebar-player1-goals" class="sidebar-goals-input" 
                       min="0" max="99" placeholder="" onchange="checkSidebarForDraw()">
            </div>
            <div class="sidebar-player-input">
                <label for="sidebar-player2-goals">${currentPlayer2Name} Goals:</label>
                <input type="number" id="sidebar-player2-goals" class="sidebar-goals-input" 
                       min="0" max="99" placeholder="" onchange="checkSidebarForDraw()">
            </div>
            <div class="sidebar-penalty-section" id="sidebar-penalty-section" style="display: none;">
                <label for="sidebar-penalty-winner">Penalty Result:</label>
                <select id="sidebar-penalty-winner" class="sidebar-team-select">
                    <option value="">Select Result</option>
                    <option value="1">${currentPlayer1Name} Won</option>
                    <option value="2">${currentPlayer2Name} Won</option>
                    <option value="draw">No Winner (Draw)</option>
                </select>
            </div>
        </div>
        <div class="sidebar-game-teams">
            <div class="sidebar-player-input">
                <label for="sidebar-player1-team-type">${currentPlayer1Name} Team Type:</label>
                <select id="sidebar-player1-team-type" class="sidebar-team-select" onchange="updateSidebarTeamOptions(1)">
                    <option value="Ultimate Team">Ultimate Team</option>
                    <option value="Premier League">Premier League</option>
                    <option value="La Liga">La Liga</option>
                    <option value="Bundesliga">Bundesliga</option>
                    <option value="Serie A">Serie A</option>
                    <option value="Ligue 1">Ligue 1</option>
                    <option value="National Teams">National Teams</option>
                    <option value="Other">Other</option>
                </select>
                <div id="sidebar-player1-team-group" style="display: none;">
                    <label for="sidebar-player1-team">Select Team:</label>
                    <select id="sidebar-player1-team" class="sidebar-team-select">
                        <!-- Teams will be populated by JavaScript -->
                    </select>
                </div>
                <div id="sidebar-player1-custom-group" style="display: none;">
                    <label for="sidebar-player1-custom-team">Other:</label>
                    <input type="text" id="sidebar-player1-custom-team" class="sidebar-player-input" 
                           placeholder="Enter team name" maxlength="15">
                </div>
            </div>
            <div class="sidebar-player-input">
                <label for="sidebar-player2-team-type">${currentPlayer2Name} Team Type:</label>
                <select id="sidebar-player2-team-type" class="sidebar-team-select" onchange="updateSidebarTeamOptions(2)">
                    <option value="Ultimate Team">Ultimate Team</option>
                    <option value="Premier League">Premier League</option>
                    <option value="La Liga">La Liga</option>
                    <option value="Bundesliga">Bundesliga</option>
                    <option value="Serie A">Serie A</option>
                    <option value="Ligue 1">Ligue 1</option>
                    <option value="National Teams">National Teams</option>
                    <option value="Other">Other</option>
                </select>
                <div id="sidebar-player2-team-group" style="display: none;">
                    <label for="sidebar-player2-team">Select Team:</label>
                    <select id="sidebar-player2-team" class="sidebar-team-select">
                        <!-- Teams will be populated by JavaScript -->
                    </select>
                </div>
                <div id="sidebar-player2-custom-group" style="display: none;">
                    <label for="sidebar-player2-custom-team">Other:</label>
                    <input type="text" id="sidebar-player2-custom-team" class="sidebar-player-input" 
                           placeholder="Enter team name" maxlength="15">
                </div>
            </div>
        </div>
    `;
    
    // Initialize the team dropdowns after generating the HTML
    setTimeout(() => {
        updateSidebarTeamOptions(1);
        updateSidebarTeamOptions(2);
    }, 100);
}

// Update team options for sidebar
function updateSidebarTeamOptions(playerNumber) {
    const teamTypeSelect = document.getElementById(`sidebar-player${playerNumber}-team-type`);
    const teamGroup = document.getElementById(`sidebar-player${playerNumber}-team-group`);
    const customGroup = document.getElementById(`sidebar-player${playerNumber}-custom-group`);
    const teamSelect = document.getElementById(`sidebar-player${playerNumber}-team`);
    
    if (!teamTypeSelect || !teamGroup || !customGroup || !teamSelect) return;
    
    const selectedType = teamTypeSelect.value;
    
    if (selectedType === 'Ultimate Team') {
        teamGroup.style.display = 'none';
        customGroup.style.display = 'none';
    } else if (selectedType === 'Other') {
        teamGroup.style.display = 'none';
        customGroup.style.display = 'block';
    } else {
        teamGroup.style.display = 'block';
        customGroup.style.display = 'none';
        
        // Populate teams for the selected league
        const teamsData = window.TEAMS_DATA || {};
        const teams = teamsData[selectedType] || [];
        
        teamSelect.innerHTML = '';
        
        // Add default option
        const defaultOption = document.createElement('option');
        defaultOption.value = '';
        defaultOption.textContent = 'Select Team';
        defaultOption.disabled = true;
        defaultOption.selected = true;
        teamSelect.appendChild(defaultOption);
        
        // Add all teams
        teams.forEach(team => {
            const option = document.createElement('option');
            option.value = team;
            option.textContent = team;
            teamSelect.appendChild(option);
        });
        
        // If teams exist, select the first actual team as default
        if (teams.length > 0) {
            teamSelect.selectedIndex = 1; // Skip the "Select Team" option
        }
    }
}

// Submit sidebar game
function submitSidebarGame() {
    const player1Goals = document.getElementById('sidebar-player1-goals')?.value;
    const player2Goals = document.getElementById('sidebar-player2-goals')?.value;
    
    // Get team information
    const player1TeamType = document.getElementById('sidebar-player1-team-type')?.value;
    const player2TeamType = document.getElementById('sidebar-player2-team-type')?.value;
    
    let player1Team = 'Unknown';
    let player2Team = 'Unknown';
    
    if (player1TeamType === 'Ultimate Team') {
        player1Team = 'Ultimate Team';
    } else if (player1TeamType === 'Other') {
        player1Team = document.getElementById('sidebar-player1-custom-team')?.value || 'Other';
    } else {
        player1Team = document.getElementById('sidebar-player1-team')?.value || player1TeamType;
    }
    
    if (player2TeamType === 'Ultimate Team') {
        player2Team = 'Ultimate Team';
    } else if (player2TeamType === 'Other') {
        player2Team = document.getElementById('sidebar-player2-custom-team')?.value || 'Other';
    } else {
        player2Team = document.getElementById('sidebar-player2-team')?.value || player2TeamType;
    }
    
    // Get current player names
    const currentPlayer1Name = window.player1Name || 'Player 1';
    const currentPlayer2Name = window.player2Name || 'Player 2';
    
    // Validation
    if (!player1Goals && player1Goals !== '0') {
        showSidebarGameError(`Please enter goals for ${currentPlayer1Name}`);
        return;
    }
    
    if (!player2Goals && player2Goals !== '0') {
        showSidebarGameError(`Please enter goals for ${currentPlayer2Name}`);
        return;
    }
    
    // Check for penalty result if it's a draw
    let penaltyWinner = null;
    if (player1Goals === player2Goals) {
        const penaltySelect = document.getElementById('sidebar-penalty-winner');
        const penaltyValue = penaltySelect ? penaltySelect.value : '';
        
        if (!penaltyValue) {
            showSidebarGameError('Please select a penalty result for draw games');
            return;
        }
        
        if (penaltyValue === 'draw') {
            penaltyWinner = 'draw';
        } else {
            penaltyWinner = parseInt(penaltyValue);
        }
    }
    
    // Validate Other team names are not blank
    if (player1TeamType === 'Other') {
        const customTeamName = document.getElementById('sidebar-player1-custom-team')?.value?.trim();
        if (!customTeamName) {
            showSidebarGameError(`Please enter a team name for ${currentPlayer1Name}`);
            return;
        }
    }
    
    if (player2TeamType === 'Other') {
        const customTeamName = document.getElementById('sidebar-player2-custom-team')?.value?.trim();
        if (!customTeamName) {
            showSidebarGameError(`Please enter a team name for ${currentPlayer2Name}`);
            return;
        }
    }

    // Get the selected date from sidebar date input
    const selectedDateInput = document.getElementById('sidebar-date-input');
    let gameDate = new Date();
    
    if (selectedDateInput && selectedDateInput.value) {
        // Parse the date string manually to avoid timezone issues
        const [year, month, day] = selectedDateInput.value.split('-');
        const now = new Date();
        // Create date using local timezone with current time
        gameDate = new Date(
            parseInt(year),
            parseInt(month) - 1, // Months are 0-based
            parseInt(day),
            now.getHours(),
            now.getMinutes(),
            now.getSeconds(),
            now.getMilliseconds()
        );
    }
    
    // Create game object
    const newGame = {
        id: Date.now(),
        player1Goals: parseInt(player1Goals),
        player2Goals: parseInt(player2Goals),
        player1Team: player1Team || 'Unknown',
        player2Team: player2Team || 'Unknown',
        penaltyWinner: penaltyWinner,
        dateTime: gameDate.toISOString(),
        gameNumber: window.games ? window.games.length + 1 : 1
    };
    
    // Add to games
    if (window.games && Array.isArray(window.games)) {
        window.games.push(newGame);
        if (window.saveGames) window.saveGames();
        if (window.updateUI) window.updateUI();
        
        // Add to history for undo/redo
        if (window.addToHistory) {
            window.addToHistory({
                type: 'add_game',
                data: newGame
            });
        }
        
        // Show success and close form
        if (window.showToast) window.showToast('Game added successfully!', 'success');
        closeSidebarGameForm();
    } else {
        console.error('Games array not found or not accessible');
        showSidebarGameError('Unable to save game. Please try again.');
    }
}

// Check for draw in sidebar form
function checkSidebarForDraw() {
    const player1Goals = document.getElementById('sidebar-player1-goals')?.value;
    const player2Goals = document.getElementById('sidebar-player2-goals')?.value;
    const penaltySection = document.getElementById('sidebar-penalty-section');
    
    if (penaltySection && player1Goals !== '' && player2Goals !== '' && player1Goals === player2Goals) {
        penaltySection.style.display = 'block';
    } else if (penaltySection) {
        penaltySection.style.display = 'none';
        const penaltySelect = document.getElementById('sidebar-penalty-winner');
        if (penaltySelect) penaltySelect.value = '';
    }
}

// Export current filter state and functions to global scope
window.currentDateFilter = currentDateFilter;

// Export functions to global scope
window.initializeSidebar = initializeSidebar;
window.toggleSidebar = toggleSidebar;
window.openSidebar = openSidebar;
window.closeSidebar = closeSidebar;
window.setDateFilter = setDateFilter;
window.applyCustomDateFilter = applyCustomDateFilter;
window.updateSidebarDate = updateSidebarDate;
window.setSidebarDateToday = setSidebarDateToday;
window.undoLastAction = undoLastAction;
window.redoLastAction = redoLastAction;
window.addToHistory = addToHistory;
window.updateUndoRedoButtons = updateUndoRedoButtons;
window.displayFilteredGames = displayFilteredGames;
window.clearDateFilter = clearDateFilter;
window.toggleSidebarPlayerSettings = toggleSidebarPlayerSettings;
window.toggleSidebarGameForm = toggleSidebarGameForm;
window.closeSidebarGameForm = closeSidebarGameForm;
window.submitSidebarGame = submitSidebarGame;
window.updateSidebarTeamOptions = updateSidebarTeamOptions;
window.refreshSidebarPlayerContent = refreshSidebarPlayerContent;
window.checkSidebarForDraw = checkSidebarForDraw;
window.getFilteredGames = getFilteredGames;
window.generateSidebarPlayerSettings = generateSidebarPlayerSettings;
