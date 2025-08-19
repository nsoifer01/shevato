// Football H2H Tracker JavaScript

// Data structure for matches
let matches = [];
let currentEditId = null;

// Sorting state
let currentSortColumn = 'date';
let currentSortDirection = 'desc'; // 'asc' or 'desc'

// LocalStorage key
const STORAGE_KEY = 'footballH2HMatches';
const PLAYERS_KEY = 'footballH2HPlayers';

// Team data for different leagues
const TEAMS_DATA = {
    'Premier League': [
        'Arsenal', 'Aston Villa', 'Brighton & Hove Albion', 'Burnley', 'Chelsea', 
        'Crystal Palace', 'Everton', 'Fulham', 'Liverpool', 'Luton Town',
        'Manchester City', 'Manchester United', 'Newcastle United', 'Nottingham Forest',
        'Sheffield United', 'Tottenham Hotspur', 'West Ham United', 'Wolverhampton Wanderers',
        'Brentford', 'Bournemouth'
    ],
    'La Liga': [
        'Athletic Bilbao', 'Atlético Madrid', 'Barcelona', 'Cádiz', 'Celta Vigo',
        'Getafe', 'Girona', 'Granada', 'Las Palmas', 'Mallorca',
        'Osasuna', 'Rayo Vallecano', 'Real Betis', 'Real Madrid', 'Real Sociedad',
        'Sevilla', 'Valencia', 'Villarreal', 'Alavés', 'Almería'
    ],
    'Bundesliga': [
        'FC Augsburg', 'Bayer Leverkusen', 'Bayern Munich', 'VfL Bochum', 'Borussia Dortmund',
        'Borussia Mönchengladbach', 'SV Darmstadt 98', 'Eintracht Frankfurt', 'SC Freiburg',
        'FC Heidenheim', 'TSG Hoffenheim', 'FC Köln', 'RB Leipzig', 'Mainz 05',
        'Union Berlin', 'VfB Stuttgart', 'Werder Bremen', 'VfL Wolfsburg'
    ],
    'Serie A': [
        'Atalanta', 'Bologna', 'Cagliari', 'Empoli', 'Fiorentina',
        'Frosinone', 'Genoa', 'Hellas Verona', 'Inter Milan', 'Juventus',
        'Lazio', 'Lecce', 'AC Milan', 'Monza', 'Napoli',
        'Roma', 'Salernitana', 'Sassuolo', 'Torino', 'Udinese'
    ],
    'Ligue 1': [
        'AC Ajaccio', 'Angers', 'Brest', 'Clermont', 'Le Havre',
        'Lens', 'Lille', 'Lorient', 'Lyon', 'Marseille',
        'Metz', 'Monaco', 'Montpellier', 'Nantes', 'Nice',
        'Paris Saint-Germain', 'Reims', 'Rennes', 'Strasbourg', 'Toulouse'
    ],
    'National Teams': [
        'Argentina', 'Australia', 'Belgium', 'Brazil', 'Canada',
        'Colombia', 'Croatia', 'Denmark', 'England', 'France',
        'Germany', 'Italy', 'Japan', 'Mexico', 'Morocco',
        'Netherlands', 'Poland', 'Portugal', 'Senegal', 'Serbia',
        'South Korea', 'Spain', 'Switzerland', 'Ukraine', 'United States',
        'Uruguay', 'Wales'
    ]
};

// Use global icon database
// Icons are now managed globally in assets/js/global-icons.js

// Player icons storage
let currentPlayerForIcon = null;
let playerIcons = {
    player1: '⚽',
    player2: '⚽'
};

// Initialize app on page load
document.addEventListener('DOMContentLoaded', function() {
    loadPlayers();
    loadPlayerIcons();
    loadMatches();
    updateUI();
    
    // Set up event listeners
    document.getElementById('player1Goals').addEventListener('input', checkForDraw);
    document.getElementById('player2Goals').addEventListener('input', checkForDraw);
    
    // Initialize icon grids
    initializeIconGrids();
    
    // Initialize auto-backup (runs every 10 minutes)
    if (typeof initializeAutoBackup === 'function') {
        initializeAutoBackup();
    }
});

// Load player names from localStorage
function loadPlayers() {
    const savedPlayers = localStorage.getItem(PLAYERS_KEY);
    if (savedPlayers) {
        const players = JSON.parse(savedPlayers);
        document.getElementById('player1Name').value = players.player1 || '';
        document.getElementById('player2Name').value = players.player2 || '';
    } else {
        document.getElementById('player1Name').value = '';
        document.getElementById('player2Name').value = '';
    }
}

// Save player names to localStorage
function savePlayers() {
    const players = {
        player1: document.getElementById('player1Name').value || '',
        player2: document.getElementById('player2Name').value || ''
    };
    localStorage.setItem(PLAYERS_KEY, JSON.stringify(players));
}

// Handle manual player name changes from input fields
function handlePlayerNameChange() {
    const player1Name = document.getElementById('player1Name').value || 'Player 1';
    const player2Name = document.getElementById('player2Name').value || 'Player 2';
    
    applyPlayerNameChanges(player1Name, player2Name);
    showToast('Player names updated', 'success');
}

// Update player names throughout the UI (used internally, no toast)
function updatePlayerNames() {
    const player1Name = document.getElementById('player1Name').value || 'Player 1';
    const player2Name = document.getElementById('player2Name').value || 'Player 2';
    
    applyPlayerNameChanges(player1Name, player2Name);
}

// Export to global scope
window.handlePlayerNameChange = handlePlayerNameChange;

function applyPlayerNameChanges(player1Name, player2Name) {
    savePlayers();
    
    // Update stats section
    document.getElementById('player1StatsName').textContent = player1Name;
    document.getElementById('player2StatsName').textContent = player2Name;
    
    // Update table headers with icons
    const player1Header = document.getElementById('player1Header');
    const player2Header = document.getElementById('player2Header');
    
    // Create player 1 header with icon
    const player1Icon = playerIcons.player1 || '⚽';
    player1Header.innerHTML = `<span class="player-header-icon">${player1Icon}</span> ${player1Name}`;
    
    // Create player 2 header with icon
    const player2Icon = playerIcons.player2 || '⚽';
    player2Header.innerHTML = `<span class="player-header-icon">${player2Icon}</span> ${player2Name}`;
    
    // Update modal labels
    document.getElementById('modalPlayer1Name').textContent = player1Name;
    document.getElementById('modalPlayer2Name').textContent = player2Name;
    document.getElementById('modalPlayer1TeamLabel').textContent = player1Name;
    document.getElementById('modalPlayer2TeamLabel').textContent = player2Name;
    
    // Update penalty options
    document.getElementById('penaltyPlayer1Option').textContent = player1Name;
    document.getElementById('penaltyPlayer2Option').textContent = player2Name;
    
    // Update table headers
    document.getElementById('player1TeamHeader').textContent = `${player1Name}'s Team`;
    document.getElementById('player2TeamHeader').textContent = `${player2Name}'s Team`;
    
    // Refresh the matches table to show updated names
    renderMatchesTable();
}

// Load matches from localStorage
function loadMatches() {
    const savedMatches = localStorage.getItem(STORAGE_KEY);
    if (savedMatches) {
        matches = JSON.parse(savedMatches);
        
        // Migrate old matches without dateTime
        let needsUpdate = false;
        matches.forEach((match, index) => {
            if (!match.dateTime) {
                // Assign a fake date for old matches (spread them out over past days)
                const daysBack = matches.length - index;
                const fakeDate = new Date();
                fakeDate.setDate(fakeDate.getDate() - daysBack);
                match.dateTime = fakeDate.toISOString();
                match.lastModified = new Date().toISOString();
                needsUpdate = true;
            }
        });
        
        if (needsUpdate) {
            saveMatches();
        }
    } else {
        // Start with empty matches array - no example data
        matches = [];
    }
}

// Save matches to localStorage
function saveMatches() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(matches));
}

// Update the entire UI
function updateUI() {
    updatePlayerNames();
    renderMatchesTable();
    updateStatistics();
}

// Format date and time for display
function formatDateTime(dateString) {
    const date = new Date(dateString);
    const options = {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
    };
    return date.toLocaleString(undefined, options);
}

// Format date for display (short version)
function formatDate(dateString) {
    const date = new Date(dateString);
    const options = {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    };
    return date.toLocaleDateString('en-US', options);
}

// Sort matches by column
function sortMatches(column) {
    // Toggle direction if same column, otherwise default to ascending
    if (currentSortColumn === column) {
        currentSortDirection = currentSortDirection === 'asc' ? 'desc' : 'asc';
    } else {
        currentSortColumn = column;
        currentSortDirection = 'asc';
    }
    
    // Re-render table with new sorting
    renderMatchesTable();
}

// Get sorted matches
function getSortedMatches() {
    const player1Name = document.getElementById('player1Name').value || 'Player 1';
    const player2Name = document.getElementById('player2Name').value || 'Player 2';
    
    return [...matches].sort((a, b) => {
        let valueA, valueB;
        
        switch(currentSortColumn) {
            case 'game':
                // Sort by match ID (chronological order)
                valueA = a.id;
                valueB = b.id;
                break;
                
            case 'date':
                valueA = a.dateTime ? new Date(a.dateTime) : new Date(0);
                valueB = b.dateTime ? new Date(b.dateTime) : new Date(0);
                break;
                
            case 'player1':
                valueA = a.player1Goals;
                valueB = b.player1Goals;
                break;
                
            case 'player2':
                valueA = a.player2Goals;
                valueB = b.player2Goals;
                break;
                
                
            default:
                return 0;
        }
        
        if (valueA < valueB) return currentSortDirection === 'asc' ? -1 : 1;
        if (valueA > valueB) return currentSortDirection === 'asc' ? 1 : -1;
        return 0;
    });
}

// Update sort indicators
function updateSortIndicators() {
    // Clear all indicators
    document.querySelectorAll('.sort-indicator').forEach(indicator => {
        indicator.textContent = '';
    });
    
    // Set current sort indicator
    const currentIndicator = document.getElementById(`sort-${currentSortColumn}`);
    if (currentIndicator) {
        currentIndicator.textContent = currentSortDirection === 'asc' ? ' ▲' : ' ▼';
    }
}

// Render the matches table
function renderMatchesTable() {
    const tbody = document.getElementById('matchesTableBody');
    const noMatches = document.getElementById('noMatches');
    
    if (matches.length === 0) {
        tbody.innerHTML = '';
        noMatches.style.display = 'block';
        updateSortIndicators();
        return;
    }
    
    noMatches.style.display = 'none';
    
    // Update sort indicators
    updateSortIndicators();
    
    const player1Name = document.getElementById('player1Name').value || 'Player 1';
    const player2Name = document.getElementById('player2Name').value || 'Player 2';
    
    // Get sorted matches based on current sort settings
    const sortedMatches = getSortedMatches();
    
    tbody.innerHTML = sortedMatches.map((match, index) => {
        // Find the original position of this match for game number
        const gameNumber = matches.findIndex(m => m.id === match.id) + 1;
        const isDraw = match.player1Goals === match.player2Goals;
        
        // Determine winner for circle styling
        let player1Class = '';
        let player2Class = '';
        
        if (isDraw) {
            // If it's a draw, check penalty winner
            if (match.penaltyWinner === 'player1') {
                player1Class = 'goal-winner';
                player2Class = 'goal-loser';
            } else if (match.penaltyWinner === 'player2') {
                player1Class = 'goal-loser';
                player2Class = 'goal-winner';
            } else {
                // True draw (no penalty winner)
                player1Class = 'goal-draw';
                player2Class = 'goal-draw';
            }
        } else if (match.player1Goals > match.player2Goals) {
            // Player 1 wins
            player1Class = 'goal-winner';
            player2Class = 'goal-loser';
        } else {
            // Player 2 wins
            player1Class = 'goal-loser';
            player2Class = 'goal-winner';
        }
        
        // Format date and time
        const dateTimeDisplay = match.dateTime ? formatDateTime(match.dateTime) : '-';
        
        return `
            <tr>
                <td>${gameNumber}</td>
                <td>${dateTimeDisplay}</td>
                <td><span class="goal-circle ${player1Class}">${match.player1Goals}</span></td>
                <td><span class="goal-circle ${player2Class}">${match.player2Goals}</span></td>
                <td>${match.player1Team || match.team || 'Ultimate Team'}</td>
                <td>${match.player2Team || match.team || 'Ultimate Team'}</td>
                <td>
                    <div class="action-buttons">
                        <button class="btn-icon edit" onclick="editMatch(${match.id})" title="Edit">
                            <i class="fas fa-edit"></i>
                        </button>
                        <button class="btn-icon delete" onclick="deleteMatch(${match.id})" title="Delete">
                            <i class="fas fa-trash"></i>
                        </button>
                    </div>
                </td>
            </tr>
        `;
    }).join('');
}

// Update statistics
function updateStatistics() {
    const player1Name = document.getElementById('player1Name').value || 'Player 1';
    const player2Name = document.getElementById('player2Name').value || 'Player 2';
    
    let player1Wins = 0;
    let player2Wins = 0;
    let draws = 0;
    let totalGoals = 0;
    let penaltyShootouts = 0;
    
    matches.forEach(match => {
        totalGoals += match.player1Goals + match.player2Goals;
        
        if (match.player1Goals === match.player2Goals) {
            if (match.penaltyWinner) {
                penaltyShootouts++;
                if (match.penaltyWinner === 'player1') {
                    player1Wins++;
                } else {
                    player2Wins++;
                }
            } else {
                draws++;
            }
        } else if (match.player1Goals > match.player2Goals) {
            player1Wins++;
        } else {
            player2Wins++;
        }
    });
    
    const totalMatches = matches.length;
    const goalsPerMatch = totalMatches > 0 ? (totalGoals / totalMatches).toFixed(1) : '0.0';
    
    document.getElementById('totalMatches').textContent = totalMatches;
    document.getElementById('player1Wins').textContent = player1Wins;
    document.getElementById('player2Wins').textContent = player2Wins;
    document.getElementById('totalDraws').textContent = draws;
    document.getElementById('goalsPerMatch').textContent = goalsPerMatch;
    document.getElementById('penaltyShootouts').textContent = penaltyShootouts;
}

// Show add match modal
function showAddMatchModal() {
    currentEditId = null;
    document.getElementById('modalTitle').textContent = 'Add New Match';
    document.getElementById('matchForm').reset();
    
    // Set default team types to Ultimate Team
    document.getElementById('player1TeamType').value = 'Ultimate Team';
    document.getElementById('player2TeamType').value = 'Ultimate Team';
    
    // Hide secondary options
    updateTeamOptions(1);
    updateTeamOptions(2);
    
    checkForDraw();
    updatePlayerNames();
    document.getElementById('matchModal').classList.add('active');
}

// Close match modal
function closeMatchModal() {
    document.getElementById('matchModal').classList.remove('active');
    currentEditId = null;
}


// Check if the match is a draw and show/hide penalty options
function checkForDraw() {
    const player1Goals = parseInt(document.getElementById('player1Goals').value) || 0;
    const player2Goals = parseInt(document.getElementById('player2Goals').value) || 0;
    const penaltyGroup = document.getElementById('penaltyGroup');
    
    // Only show penalty options if both players have entered goals AND it's a draw
    const hasGoalValues = document.getElementById('player1Goals').value && document.getElementById('player2Goals').value;
    
    if (hasGoalValues && player1Goals === player2Goals) {
        penaltyGroup.style.display = 'block';
    } else {
        penaltyGroup.style.display = 'none';
        document.getElementById('penaltyWinner').value = '';
    }
}

// Save match (add or edit)
function saveMatch(event) {
    event.preventDefault();
    
    const player1Goals = parseInt(document.getElementById('player1Goals').value) || 0;
    const player2Goals = parseInt(document.getElementById('player2Goals').value) || 0;
    const player1Team = getFinalTeamValue(1);
    const player2Team = getFinalTeamValue(2);
    const penaltyWinner = document.getElementById('penaltyWinner').value;
    
    // Validation for custom teams
    if (document.getElementById('player1TeamType').value === 'Custom' && !player1Team.trim()) {
        createErrorModal({
            icon: '❌',
            title: 'Missing Team Information',
            message: 'Please enter a custom team name for Player 1.'
        });
        return;
    }
    
    if (document.getElementById('player2TeamType').value === 'Custom' && !player2Team.trim()) {
        createErrorModal({
            icon: '❌',
            title: 'Missing Team Information',
            message: 'Please enter a custom team name for Player 2.'
        });
        return;
    }
    
    const player1Name = document.getElementById('player1Name').value || 'Player 1';
    const player2Name = document.getElementById('player2Name').value || 'Player 2';
    
    const matchData = {
        player1Goals,
        player2Goals,
        player1Team,
        player2Team,
        penaltyWinner: penaltyWinner || null
    };
    
    if (currentEditId) {
        // Edit existing match
        const matchIndex = matches.findIndex(m => m.id === currentEditId);
        if (matchIndex !== -1) {
            // Preserve the original date when editing
            matches[matchIndex] = { 
                ...matches[matchIndex], 
                ...matchData,
                lastModified: new Date().toISOString()
            };
            
            showToast(`Match updated: ${player1Name} ${player1Goals} - ${player2Goals} ${player2Name}`, 'success');
        }
    } else {
        // Add new match with current date and time
        const newMatch = {
            ...matchData,
            id: matches.length > 0 ? Math.max(...matches.map(m => m.id)) + 1 : 1,
            dateTime: new Date().toISOString(),
            lastModified: new Date().toISOString()
        };
        matches.push(newMatch);
        
        showToast(`Match added: ${player1Name} ${player1Goals} - ${player2Goals} ${player2Name}`, 'success');
    }
    
    saveMatches();
    updateUI();
    closeMatchModal();
}

// Edit match
function editMatch(id) {
    const match = matches.find(m => m.id === id);
    if (!match) return;
    
    currentEditId = id;
    document.getElementById('modalTitle').textContent = 'Edit Match';
    
    document.getElementById('player1Goals').value = match.player1Goals;
    document.getElementById('player2Goals').value = match.player2Goals;
    
    // Set team values (with fallback for old data structure)
    const player1Team = match.player1Team || match.team || 'Ultimate Team';
    const player2Team = match.player2Team || match.team || 'Ultimate Team';
    
    // Try to determine team type and set values accordingly
    setTeamFromValue(1, player1Team);
    setTeamFromValue(2, player2Team);
    
    checkForDraw();
    
    if (match.penaltyWinner) {
        document.getElementById('penaltyWinner').value = match.penaltyWinner;
    }
    
    updatePlayerNames();
    document.getElementById('matchModal').classList.add('active');
}

// Helper function to set team selection from a team name
function setTeamFromValue(playerNumber, teamName) {
    const teamTypeSelect = document.getElementById(`player${playerNumber}TeamType`);
    
    if (teamName === 'Ultimate Team') {
        teamTypeSelect.value = 'Ultimate Team';
        updateTeamOptions(playerNumber);
        return;
    }
    
    // Check if it's in any league
    for (const [league, teams] of Object.entries(TEAMS_DATA)) {
        if (teams.includes(teamName)) {
            teamTypeSelect.value = league;
            updateTeamOptions(playerNumber);
            document.getElementById(`player${playerNumber}Team`).value = teamName;
            return;
        }
    }
    
    // If not found in any league, set as custom
    teamTypeSelect.value = 'Custom';
    updateTeamOptions(playerNumber);
    document.getElementById(`player${playerNumber}CustomTeam`).value = teamName;
}

// Delete match
function deleteMatch(id) {
    const match = matches.find(m => m.id === id);
    if (!match) return;
    
    const player1Name = document.getElementById('player1Name').value || 'Player 1';
    const player2Name = document.getElementById('player2Name').value || 'Player 2';
    
    createConfirmationModal({
        icon: '❌',
        title: 'Delete Match',
        message: `Are you sure you want to delete this match? <br><strong>${player1Name} ${match.player1Goals} - ${match.player2Goals} ${player2Name}</strong>`,
        isDestructive: true,
        onConfirm: () => {
            matches = matches.filter(m => m.id !== id);
            saveMatches();
            updateUI();
            
            showToast(`Match deleted: ${player1Name} ${match.player1Goals} - ${match.player2Goals} ${player2Name}`, 'error');
        },
        onCancel: () => {
            // Modal closes automatically
        }
    });
}

// Clear all data
function confirmClearData() {
    createConfirmationModal({
        icon: '🗑️',
        title: 'Clear All Data',
        message: 'Are you sure you want to clear all match data? <strong>This action cannot be undone.</strong>',
        isDestructive: true,
        onConfirm: () => {
            matches = [];
            saveMatches();
            updateUI();
            
            createSuccessModal({
                icon: '✅',
                title: 'Data Cleared',
                message: 'All match data has been successfully cleared.'
            });
        },
        onCancel: () => {
            // Modal closes automatically
        }
    });
}

// Export data as JSON
function exportData() {
    if (matches.length === 0) {
        createWarningModal({
            icon: '📤',
            title: 'No Data to Export',
            message: 'There are no matches to export. Add some matches first.',
            onConfirm: () => {},
            onCancel: () => {}
        });
        return;
    }
    
    const exportData = {
        players: {
            player1: document.getElementById('player1Name').value,
            player2: document.getElementById('player2Name').value
        },
        matches: matches,
        exportDate: new Date().toISOString()
    };
    
    const dataStr = JSON.stringify(exportData, null, 2);
    const dataUri = 'data:application/json;charset=utf-8,'+ encodeURIComponent(dataStr);
    
    const exportFileDefaultName = `football-h2h-${new Date().toISOString().split('T')[0]}.json`;
    
    const linkElement = document.createElement('a');
    linkElement.setAttribute('href', dataUri);
    linkElement.setAttribute('download', exportFileDefaultName);
    linkElement.click();
    
    createSuccessModal({
        icon: '📤',
        title: 'Export Complete',
        message: `Successfully exported ${matches.length} matches to <strong>${exportFileDefaultName}</strong>`
    });
}

// Import data from JSON file
function importData() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    
    input.onchange = function(event) {
        const file = event.target.files[0];
        if (!file) return;
        
        const reader = new FileReader();
        reader.onload = function(e) {
            try {
                const importedData = JSON.parse(e.target.result);
                
                if (importedData.players) {
                    document.getElementById('player1Name').value = importedData.players.player1 || '';
                    document.getElementById('player2Name').value = importedData.players.player2 || '';
                    savePlayers();
                }
                
                if (importedData.matches && Array.isArray(importedData.matches)) {
                    matches = importedData.matches;
                    saveMatches();
                    updateUI();
                    
                    createSuccessModal({
                        icon: '📥',
                        title: 'Import Successful',
                        message: `Successfully imported ${matches.length} matches!`
                    });
                } else {
                    createErrorModal({
                        icon: '❌',
                        title: 'Import Failed',
                        message: 'Invalid file format. Please select a valid Football H2H export file.'
                    });
                }
            } catch (error) {
                createErrorModal({
                    icon: '❌',
                    title: 'Import Error',
                    message: 'Error importing file. Please make sure it\'s a valid JSON file.'
                });
            }
        };
        reader.readAsText(file);
    };
    
    input.click();
}

// Update team options based on selected league/type
function updateTeamOptions(playerNumber) {
    const teamType = document.getElementById(`player${playerNumber}TeamType`).value;
    const teamGroup = document.getElementById(`player${playerNumber}TeamGroup`);
    const customGroup = document.getElementById(`player${playerNumber}CustomGroup`);
    const teamSelect = document.getElementById(`player${playerNumber}Team`);
    
    // Hide all secondary options first
    teamGroup.style.display = 'none';
    customGroup.style.display = 'none';
    
    if (teamType === 'Ultimate Team') {
        // No additional selection needed
        return;
    } else if (teamType === 'Custom') {
        // Show custom input
        customGroup.style.display = 'block';
        return;
    } else if (TEAMS_DATA[teamType]) {
        // Show team selection for the chosen league
        teamGroup.style.display = 'block';
        
        // Populate team options
        teamSelect.innerHTML = '';
        TEAMS_DATA[teamType].forEach(team => {
            const option = document.createElement('option');
            option.value = team;
            option.textContent = team;
            teamSelect.appendChild(option);
        });
    }
}

// Get the final team value for a player
function getFinalTeamValue(playerNumber) {
    const teamType = document.getElementById(`player${playerNumber}TeamType`).value;
    
    if (teamType === 'Ultimate Team') {
        return 'Ultimate Team';
    } else if (teamType === 'Custom') {
        return document.getElementById(`player${playerNumber}CustomTeam`).value.trim() || 'Custom Team';
    } else if (TEAMS_DATA[teamType]) {
        return document.getElementById(`player${playerNumber}Team`).value;
    }
    
    return teamType;
}

// Player Management Functions

// Load player icons from localStorage
function loadPlayerIcons() {
    const savedIcons = localStorage.getItem('footballH2HPlayerIcons');
    if (savedIcons) {
        playerIcons = JSON.parse(savedIcons);
    }
    updatePlayerIconDisplays();
}

// Save player icons to localStorage
function savePlayerIcons() {
    localStorage.setItem('footballH2HPlayerIcons', JSON.stringify(playerIcons));
}

// Update player icon displays
function updatePlayerIconDisplays() {
    document.getElementById('player1IconDisplay').innerHTML = `<span class="team-logo">${playerIcons.player1}</span>`;
    document.getElementById('player2IconDisplay').innerHTML = `<span class="team-logo">${playerIcons.player2}</span>`;
    
    // Update display names
    const player1Name = document.getElementById('player1Name').value || 'Player 1';
    const player2Name = document.getElementById('player2Name').value || 'Player 2';
    document.getElementById('player1DisplayName').textContent = player1Name;
    document.getElementById('player2DisplayName').textContent = player2Name;
    
    // Update table headers with icons
    const player1Header = document.getElementById('player1Header');
    const player2Header = document.getElementById('player2Header');
    
    if (player1Header) {
        const player1Icon = playerIcons.player1 || '⚽';
        player1Header.innerHTML = `<span class="player-header-icon">${player1Icon}</span> ${player1Name}`;
    }
    
    if (player2Header) {
        const player2Icon = playerIcons.player2 || '⚽';
        player2Header.innerHTML = `<span class="player-header-icon">${player2Icon}</span> ${player2Name}`;
    }
}

// Toggle player manager panel
function togglePlayerManager() {
    const panel = document.getElementById('playerManagerPanel');
    if (panel.style.display === 'none' || panel.style.display === '') {
        panel.style.display = 'block';
        updatePlayerIconDisplays();
    } else {
        panel.style.display = 'none';
    }
}

// Open icon selector for a player
function openIconSelector(playerNumber) {
    currentPlayerForIcon = playerNumber;
    const playerName = document.getElementById(`player${playerNumber}Name`).value || `Player ${playerNumber}`;
    document.getElementById('iconModalTitle').textContent = `Select Icon for ${playerName}`;
    
    // Show sports icons by default
    showIconCategory('sports');
    
    document.getElementById('iconSelectorModal').classList.add('active');
}

// Close icon selector
function closeIconSelector() {
    document.getElementById('iconSelectorModal').classList.remove('active');
    currentPlayerForIcon = null;
}

// Show icon category
function showIconCategory(category) {
    // Update tab states
    document.querySelectorAll('.category-btn').forEach(btn => btn.classList.remove('active'));
    document.getElementById(category + 'Tab').classList.add('active');
    
    // Hide all grids first
    document.getElementById('sportsIconGrid').style.display = 'none';
    document.getElementById('animalsIconGrid').style.display = 'none';
    document.getElementById('generalIconGrid').style.display = 'none';
    
    // Show selected grid
    document.getElementById(category + 'IconGrid').style.display = 'grid';
}

// Initialize icon grids
function initializeIconGrids() {
    // Check if global icons are available
    if (!window.GlobalIcons) {
        console.error('Global icons not loaded');
        return;
    }
    
    // Populate sports icons
    const sportsGrid = document.getElementById('sportsIconGrid');
    sportsGrid.innerHTML = '';
    window.GlobalIcons.SPORTS.forEach(icon => {
        const iconDiv = document.createElement('div');
        iconDiv.className = 'icon-item';
        iconDiv.innerHTML = `<span class="team-logo">${icon}</span>`;
        iconDiv.onclick = () => selectIcon(icon);
        sportsGrid.appendChild(iconDiv);
    });
    
    // Populate animal icons
    const animalsGrid = document.getElementById('animalsIconGrid');
    animalsGrid.innerHTML = '';
    window.GlobalIcons.ANIMALS.forEach(icon => {
        const iconDiv = document.createElement('div');
        iconDiv.className = 'icon-item';
        iconDiv.innerHTML = `<span class="team-logo">${icon}</span>`;
        iconDiv.onclick = () => selectIcon(icon);
        animalsGrid.appendChild(iconDiv);
    });
    
    // Populate general icons
    const generalGrid = document.getElementById('generalIconGrid');
    generalGrid.innerHTML = '';
    window.GlobalIcons.GENERAL.forEach(icon => {
        const iconDiv = document.createElement('div');
        iconDiv.className = 'icon-item';
        iconDiv.innerHTML = `<span class="team-logo">${icon}</span>`;
        iconDiv.onclick = () => selectIcon(icon);
        generalGrid.appendChild(iconDiv);
    });
}

// Select an icon
function selectIcon(icon) {
    if (currentPlayerForIcon) {
        playerIcons[`player${currentPlayerForIcon}`] = icon;
        savePlayerIcons();
        updatePlayerIconDisplays();
        closeIconSelector();
        
        // Safely get player name
        const playerNameElement = document.getElementById(`player${currentPlayerForIcon}Name`);
        const playerName = playerNameElement ? playerNameElement.value : '';
        const displayName = playerName || `Player ${currentPlayerForIcon}`;
        showToast(`Icon updated`, 'success');
    }
}

// Update the updatePlayerNames function to also update the player management display
const originalUpdatePlayerNames = updatePlayerNames;
updatePlayerNames = function() {
    originalUpdatePlayerNames.call(this);
    updatePlayerIconDisplays();
};

// Toggle backup menu dropdown
function toggleBackupMenu(button) {
    const menu = document.getElementById('backupMenu');
    const isOpen = menu.style.display !== 'none';
    
    if (isOpen) {
        menu.style.display = 'none';
    } else {
        menu.style.display = 'block';
        
        // Close menu when clicking outside
        setTimeout(() => {
            document.addEventListener('click', closeBackupMenu);
        }, 0);
    }
}

function closeBackupMenu(event) {
    const menu = document.getElementById('backupMenu');
    const button = event.target.closest('.dropdown');
    
    if (!button || !button.contains(event.target)) {
        menu.style.display = 'none';
        document.removeEventListener('click', closeBackupMenu);
    }
}

// Close modal when clicking outside
window.onclick = function(event) {
    const modal = document.getElementById('matchModal');
    const iconModal = document.getElementById('iconSelectorModal');
    
    if (event.target === modal) {
        closeMatchModal();
    } else if (event.target === iconModal) {
        closeIconSelector();
    }
}

// Export functions to global scope
window.toggleBackupMenu = toggleBackupMenu;
window.updateTeamOptions = updateTeamOptions;
window.showAddMatchModal = showAddMatchModal;
window.closeMatchModal = closeMatchModal;
window.saveMatch = saveMatch;
window.editMatch = editMatch;
window.deleteMatch = deleteMatch;
window.confirmClearData = confirmClearData;
window.exportData = exportData;
window.importData = importData;
window.sortMatches = sortMatches;
window.checkForDraw = checkForDraw;
window.togglePlayerManager = togglePlayerManager;
window.openIconSelector = openIconSelector;
window.closeIconSelector = closeIconSelector;
window.showIconCategory = showIconCategory;
window.selectIcon = selectIcon;
