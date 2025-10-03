// Football H2H Tracker JavaScript

// Data structure for games
let games = [];
let currentEditId = null;

// Make games available globally for sidebar
window.games = games;

// Sorting state
let currentSortColumn = 'date';
let currentSortDirection = 'desc'; // 'asc' or 'desc'

// LocalStorage key
const STORAGE_KEY = 'footballH2HGames';
const PLAYERS_KEY = 'footballH2HPlayers';

// Player names (global variables)
let player1Name = 'Player 1';
let player2Name = 'Player 2';

// Player icons (global variables)
let playerIcons = {
    player1: '⚽',
    player2: '⚽'
};

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

// Initialize app on page load
document.addEventListener('DOMContentLoaded', function() {
    // Initialize global pagination instance for Football H2H
    if (window.GlobalPaginationManager) {
        window.GlobalPaginationManager.createInstance('football-h2h-games', {
            localStorageKey: 'gameHistoryPageSize',
            updateCallback: updateUI
        });
    }
    
    // Initialize app data - always load, sync system will handle updates
    function initializeAppData() {
        loadPlayers();
        loadPlayerIcons();
        loadGames();
        updateUI();
    }
    
    // Always initialize data immediately
    // The sync system will handle keeping data up to date
    initializeAppData();
    
    // Also refresh data when sync system becomes ready (for first-time setup)
    if (!window.syncSystemInitialized) {
        window.addEventListener('syncSystemReady', () => {
            console.log('🔄 Sync system ready, refreshing Football data');
            // Give sync a moment to pull latest data, then refresh UI
            setTimeout(() => {
                initializeAppData();
            }, 1000);
        }, { once: true });
    }
    
    // Initialize sidebar after everything else is loaded
    setTimeout(() => {
        if (window.initializeSidebar) {
            window.initializeSidebar();
        }
    }, 100);
    
    // Set up event listeners for modal forms (if they exist)
    const player1Goals = document.getElementById('player1Goals');
    const player2Goals = document.getElementById('player2Goals');
    if (player1Goals) player1Goals.addEventListener('input', checkForDraw);
    if (player2Goals) player2Goals.addEventListener('input', checkForDraw);
    
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
        player1Name = players.player1 || 'Player 1';
        player2Name = players.player2 || 'Player 2';
    } else {
        player1Name = 'Player 1';
        player2Name = 'Player 2';
    }
    
    // Update any existing input fields
    const player1Input = document.getElementById('player1Name');
    const player2Input = document.getElementById('player2Name');
    if (player1Input) player1Input.value = player1Name;
    if (player2Input) player2Input.value = player2Name;
}

// Save player names to localStorage
function savePlayers() {
    const players = {
        player1: player1Name,
        player2: player2Name
    };
    localStorage.setItem(PLAYERS_KEY, JSON.stringify(players));
}

// Handle manual player name changes from input fields
function handlePlayerNameChange() {
    const player1Input = document.getElementById('player1Name');
    const player2Input = document.getElementById('player2Name');
    
    if (player1Input) player1Name = player1Input.value || 'Player 1';
    if (player2Input) player2Name = player2Input.value || 'Player 2';
    
    applyPlayerNameChanges(player1Name, player2Name);
    showToast('Player names updated', 'success');
}

// Update player names throughout the UI (used internally, no toast)
function updatePlayerNames() {
    const player1Input = document.getElementById('player1Name');
    const player2Input = document.getElementById('player2Name');
    
    if (player1Input) player1Name = player1Input.value || 'Player 1';
    if (player2Input) player2Name = player2Input.value || 'Player 2';
    
    applyPlayerNameChanges(player1Name, player2Name);
}

// Function to update player name from sidebar (called from sidebar.js)
function updatePlayerName(playerNumber, newName) {
    if (playerNumber === 1) {
        player1Name = newName || 'Player 1';
    } else if (playerNumber === 2) {
        player2Name = newName || 'Player 2';
    }
    
    applyPlayerNameChanges(player1Name, player2Name);
    showToast(`Player ${playerNumber} name updated`, 'success');
}

// Export to global scope
window.handlePlayerNameChange = handlePlayerNameChange;
window.updatePlayerName = updatePlayerName;

function applyPlayerNameChanges(newPlayer1Name, newPlayer2Name) {
    // Update global variables
    player1Name = newPlayer1Name;
    player2Name = newPlayer2Name;
    
    // Update window globals for sidebar access
    window.player1Name = player1Name;
    window.player2Name = player2Name;
    
    savePlayers();
    
    // Refresh sidebar content if the function exists
    if (window.refreshSidebarPlayerContent) {
        window.refreshSidebarPlayerContent();
    }
    
    // Update stats section
    const player1Stats = document.getElementById('player1StatsName');
    const player2Stats = document.getElementById('player2StatsName');
    if (player1Stats) player1Stats.textContent = player1Name;
    if (player2Stats) player2Stats.textContent = player2Name;
    
    // Update table headers with icons
    const player1Header = document.getElementById('player1Header');
    const player2Header = document.getElementById('player2Header');
    
    if (player1Header) {
        const player1IconDisplay = playerIcons.player1 || '⚽';
        player1Header.innerHTML = `<span class="player-header-icon">${player1IconDisplay}</span> ${player1Name}`;
    }
    
    if (player2Header) {
        const player2IconDisplay = playerIcons.player2 || '⚽';
        player2Header.innerHTML = `<span class="player-header-icon">${player2IconDisplay}</span> ${player2Name}`;
    }
    
    // Update modal labels (if they exist)
    const modalPlayer1Name = document.getElementById('modalPlayer1Name');
    const modalPlayer2Name = document.getElementById('modalPlayer2Name');
    const modalPlayer1TeamLabel = document.getElementById('modalPlayer1TeamLabel');
    const modalPlayer2TeamLabel = document.getElementById('modalPlayer2TeamLabel');
    
    if (modalPlayer1Name) modalPlayer1Name.textContent = player1Name;
    if (modalPlayer2Name) modalPlayer2Name.textContent = player2Name;
    if (modalPlayer1TeamLabel) modalPlayer1TeamLabel.textContent = player1Name;
    if (modalPlayer2TeamLabel) modalPlayer2TeamLabel.textContent = player2Name;
    
    // Update penalty options (if they exist)
    const penaltyPlayer1Option = document.getElementById('penaltyPlayer1Option');
    const penaltyPlayer2Option = document.getElementById('penaltyPlayer2Option');
    if (penaltyPlayer1Option) penaltyPlayer1Option.textContent = player1Name;
    if (penaltyPlayer2Option) penaltyPlayer2Option.textContent = player2Name;
    
    // Update table headers
    const player1TeamHeader = document.getElementById('player1TeamHeader');
    const player2TeamHeader = document.getElementById('player2TeamHeader');
    if (player1TeamHeader) player1TeamHeader.textContent = `${player1Name}'s Team`;
    if (player2TeamHeader) player2TeamHeader.textContent = `${player2Name}'s Team`;
    
    // Refresh the games table to show updated names
    renderGamesTable();
}

// Load games from localStorage
function loadGames() {
    const savedGames = localStorage.getItem(STORAGE_KEY);
    if (savedGames) {
        games = JSON.parse(savedGames);
        window.games = games; // Update global reference
        
        // Migrate old games without dateTime
        let needsUpdate = false;
        games.forEach((game, index) => {
            if (!game.dateTime) {
                // Assign a fake date for old games (spread them out over past days)
                const daysBack = games.length - index;
                const fakeDate = new Date();
                fakeDate.setDate(fakeDate.getDate() - daysBack);
                game.dateTime = fakeDate.toISOString();
                game.lastModified = new Date().toISOString();
                needsUpdate = true;
            }
        });
        
        if (needsUpdate) {
            saveGames();
        }
    } else {
        // Start with empty games array - no example data
        games = [];
    }
}

// Save games to localStorage
function saveGames() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(games));
    window.games = games; // Update global reference
}

// Update the entire UI
function updateUI() {
    updatePlayerNames();
    
    // Always use filtered data if getFilteredGames is available
    if (window.getFilteredGames) {
        const filteredGames = window.getFilteredGames();
        updateUIWithFilteredData(filteredGames);
    } else {
        renderGamesTable();
        updateStatistics();
    }
    
    // Update undo/redo buttons if available
    if (typeof updateUndoRedoButtons === 'function') {
        updateUndoRedoButtons();
    }
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

// Sort games by column
function sortGames(column) {
    // Toggle direction if same column, otherwise default to ascending
    if (currentSortColumn === column) {
        currentSortDirection = currentSortDirection === 'asc' ? 'desc' : 'asc';
    } else {
        currentSortColumn = column;
        currentSortDirection = 'asc';
    }
    
    // Re-render table with new sorting
    renderGamesTable();
}

// Get sorted games
function getSortedGames() {
    
    return [...games].sort((a, b) => {
        let valueA, valueB;
        
        switch(currentSortColumn) {
            case 'game':
                // Sort by game ID (chronological order)
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

// Render the games table
function renderGamesTable() {
    // Use filtered games if available, otherwise use all games
    const gamesToRender = window.getFilteredGames ? window.getFilteredGames() : games;
    
    // Apply sorting to the games before rendering
    const sortedGames = [...gamesToRender].sort((a, b) => {
        let valueA, valueB;
        
        switch(currentSortColumn) {
            case 'game':
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
                valueA = a.dateTime ? new Date(a.dateTime) : new Date(0);
                valueB = b.dateTime ? new Date(b.dateTime) : new Date(0);
        }
        
        if (currentSortDirection === 'asc') {
            return valueA < valueB ? -1 : valueA > valueB ? 1 : 0;
        } else {
            return valueA > valueB ? -1 : valueA < valueB ? 1 : 0;
        }
    });
    
    renderGamesTableWithData(sortedGames);
    updateSortIndicators();
}

function updateStatistics() {
    // Use filtered games if available, otherwise use all games
    const gamesToAnalyze = window.getFilteredGames ? window.getFilteredGames() : games;
    updateStatisticsWithData(gamesToAnalyze);
}

// Legacy renderGamesTable function (keeping for compatibility)
function renderGamesTableLegacy() {
    const tbody = document.getElementById('gamesTableBody');
    const noGames = document.getElementById('noGames');
    
    if (games.length === 0) {
        tbody.innerHTML = '';
        noGames.style.display = 'block';
        updateSortIndicators();
        return;
    }
    
    noGames.style.display = 'none';
    
    // Update sort indicators
    updateSortIndicators();
    
    // Get sorted games based on current sort settings
    const sortedGames = getSortedGames();
    
    tbody.innerHTML = sortedGames.map((game, index) => {
        // Find the original position of this game for game number
        const gameNumber = games.findIndex(m => m.id === game.id) + 1;
        const isDraw = game.player1Goals === game.player2Goals;
        
        // Determine winner for circle styling
        let player1Class = '';
        let player2Class = '';
        
        if (isDraw) {
            // If it's a draw, check penalty winner
            if (game.penaltyWinner === 'player1') {
                player1Class = 'goal-winner';
                player2Class = 'goal-loser';
            } else if (game.penaltyWinner === 'player2') {
                player1Class = 'goal-loser';
                player2Class = 'goal-winner';
            } else {
                // True draw (no penalty winner)
                player1Class = 'goal-draw';
                player2Class = 'goal-draw';
            }
        } else if (game.player1Goals > game.player2Goals) {
            // Player 1 wins
            player1Class = 'goal-winner';
            player2Class = 'goal-loser';
        } else {
            // Player 2 wins
            player1Class = 'goal-loser';
            player2Class = 'goal-winner';
        }
        
        // Format date and time
        const dateTimeDisplay = game.dateTime ? formatDateTime(game.dateTime) : '-';
        
        return `
            <tr>
                <td>${gameNumber}</td>
                <td>${dateTimeDisplay}</td>
                <td><span class="goal-circle ${player1Class}">${game.player1Goals}</span></td>
                <td><span class="goal-circle ${player2Class}">${game.player2Goals}</span></td>
                <td>${game.player1Team || game.team || 'Ultimate Team'}</td>
                <td>${game.player2Team || game.team || 'Ultimate Team'}</td>
                <td>
                    <div class="action-buttons">
                        <button class="btn-icon edit" onclick="editGame(${game.id})" title="Edit">
                            <i class="fas fa-edit"></i>
                        </button>
                        <button class="btn-icon delete" onclick="deleteGame(${game.id})" title="Delete">
                            <i class="fas fa-trash"></i>
                        </button>
                    </div>
                </td>
            </tr>
        `;
    }).join('');
}


// Show add game modal
function showAddGameModal() {
    currentEditId = null;
    document.getElementById('modalTitle').textContent = 'Add New Game';
    document.getElementById('gameForm').reset();
    
    // Set default team types to Ultimate Team
    document.getElementById('player1TeamType').value = 'Ultimate Team';
    document.getElementById('player2TeamType').value = 'Ultimate Team';
    
    // Hide secondary options
    updateTeamOptions(1);
    updateTeamOptions(2);
    
    checkForDraw();
    updatePlayerNames();
    document.getElementById('gameModal').classList.add('active');
}

// Close game modal
function closeGameModal() {
    document.getElementById('gameModal').classList.remove('active');
    currentEditId = null;
}


// Check if the game is a draw and show/hide penalty options
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

// Save game (add or edit)
function saveGame(event) {
    event.preventDefault();
    
    const player1Goals = parseInt(document.getElementById('player1Goals').value) || 0;
    const player2Goals = parseInt(document.getElementById('player2Goals').value) || 0;
    const player1Team = getFinalTeamValue(1);
    const player2Team = getFinalTeamValue(2);
    const penaltyWinner = document.getElementById('penaltyWinner').value;
    
    // Validation for custom teams
    if (document.getElementById('player1TeamType').value === 'Other' && !player1Team.trim()) {
        createErrorModal({
            icon: '❌',
            title: 'Missing Team Information',
            message: 'Please enter a custom team name for Player 1.'
        });
        return;
    }
    
    if (document.getElementById('player2TeamType').value === 'Other' && !player2Team.trim()) {
        createErrorModal({
            icon: '❌',
            title: 'Missing Team Information',
            message: 'Please enter a custom team name for Player 2.'
        });
        return;
    }
    
    const gameData = {
        player1Goals,
        player2Goals,
        player1Team,
        player2Team,
        penaltyWinner: penaltyWinner || null
    };
    
    if (currentEditId) {
        // Edit existing game
        const gameIndex = games.findIndex(m => m.id === currentEditId);
        if (gameIndex !== -1) {
            const originalData = { ...games[gameIndex] };
            
            // Preserve the original date when editing
            const newData = { 
                ...games[gameIndex], 
                ...gameData,
                lastModified: new Date().toISOString()
            };
            games[gameIndex] = newData;
            
            // Add to undo history
            if (typeof addToHistory === 'function') {
                addToHistory({
                    type: 'edit_game',
                    data: { originalData, newData }
                });
            }
            
            showToast(`Game updated: ${player1Name} ${player1Goals} - ${player2Goals} ${player2Name}`, 'success');
        }
    } else {
        // Add new game with current date and time
        const newGame = {
            ...gameData,
            id: games.length > 0 ? Math.max(...games.map(m => m.id)) + 1 : 1,
            dateTime: new Date().toISOString(),
            lastModified: new Date().toISOString()
        };
        games.push(newGame);
        
        // Add to undo history
        if (typeof addToHistory === 'function') {
            addToHistory({
                type: 'add_game',
                data: newGame
            });
        }
        
        showToast(`Game added: ${player1Name} ${player1Goals} - ${player2Goals} ${player2Name}`, 'success');
    }
    
    saveGames();
    updateUI();
    closeGameModal();
}

// Edit game
function editGame(id) {
    const game = games.find(m => m.id === id);
    if (!game) return;
    
    // Get current player names
    const currentPlayer1Name = window.player1Name || 'Player 1';
    const currentPlayer2Name = window.player2Name || 'Player 2';
    
    // Extract date and time from the game using local timezone
    const gameDate = game.dateTime ? new Date(game.dateTime) : new Date();
    // Use local date format (YYYY-MM-DD) to avoid timezone issues
    const year = gameDate.getFullYear();
    const month = String(gameDate.getMonth() + 1).padStart(2, '0');
    const day = String(gameDate.getDate()).padStart(2, '0');
    const formattedDate = `${year}-${month}-${day}`;
    const hours = String(gameDate.getHours()).padStart(2, '0');
    const minutes = String(gameDate.getMinutes()).padStart(2, '0');
    const seconds = String(gameDate.getSeconds()).padStart(2, '0');
    const formattedTime = `${hours}:${minutes}:${seconds}`;
    
    // Create penalty options
    const penaltyOptions = [
        { value: '', text: 'Select Result' },
        { value: '1', text: `${currentPlayer1Name} Won` },
        { value: '2', text: `${currentPlayer2Name} Won` },
        { value: 'draw', text: 'No Winner (Draw)' }
    ];
    
    // Determine current team types and teams
    function getTeamTypeAndTeam(teamName) {
        if (teamName === 'Ultimate Team') {
            return { teamType: 'Ultimate Team', team: '' };
        }
        
        // Check each league
        for (const [league, teams] of Object.entries(TEAMS_DATA)) {
            if (teams.includes(teamName)) {
                return { teamType: league, team: teamName };
            }
        }
        
        // If not found in any league, assume it's Other
        return { teamType: 'Other', team: teamName };
    }
    
    const player1TeamInfo = getTeamTypeAndTeam(game.player1Team || 'Ultimate Team');
    const player2TeamInfo = getTeamTypeAndTeam(game.player2Team || 'Ultimate Team');
    
    // Create team type options
    const teamTypeOptions = [
        { value: 'Ultimate Team', text: 'Ultimate Team' },
        { value: 'Premier League', text: 'Premier League' },
        { value: 'La Liga', text: 'La Liga' },
        { value: 'Bundesliga', text: 'Bundesliga' },
        { value: 'Serie A', text: 'Serie A' },
        { value: 'Ligue 1', text: 'Ligue 1' },
        { value: 'National Teams', text: 'National Teams' },
        { value: 'Other', text: 'Other' }
    ];

    // Create fields for the form
    const fields = [
        {
            id: 'date',
            type: 'date',
            label: 'Game Date',
            value: formattedDate,
            grid: true
        },
        {
            id: 'time',
            type: 'time',
            label: 'Game Time',
            value: formattedTime,
            placeholder: 'Optional',
            step: '1',
            grid: true
        },
        {
            id: 'player1Goals',
            type: 'number',
            label: `${currentPlayer1Name} Goals`,
            value: game.player1Goals !== undefined && game.player1Goals !== null ? game.player1Goals : '',
            min: '0',
            max: '99',
            onChange: 'checkEditModalForDraw()'
        },
        {
            id: 'player2Goals',
            type: 'number',
            label: `${currentPlayer2Name} Goals`,
            value: game.player2Goals !== undefined && game.player2Goals !== null ? game.player2Goals : '',
            min: '0',
            max: '99',
            onChange: 'checkEditModalForDraw()'
        },
        {
            id: 'penaltyWinner',
            type: 'select',
            label: 'Penalty Result',
            value: game.penaltyWinner !== null && game.penaltyWinner !== undefined ? String(game.penaltyWinner) : '',
            options: penaltyOptions
        },
        {
            id: 'player1TeamType',
            type: 'select',
            label: `${currentPlayer1Name}'s Team Type`,
            value: player1TeamInfo.teamType,
            options: teamTypeOptions,
            onChange: 'updateEditModalTeamOptionsHandler(1)'
        },
        {
            id: 'player1Team',
            type: player1TeamInfo.teamType === 'Other' ? 'text' : 'select',
            label: `${currentPlayer1Name}'s Team`,
            value: player1TeamInfo.team,
            options: player1TeamInfo.teamType === 'Other' ? undefined : [{ value: player1TeamInfo.team, text: player1TeamInfo.team || 'Select Team' }],
            placeholder: player1TeamInfo.teamType === 'Other' ? 'Enter team name' : undefined,
            maxlength: player1TeamInfo.teamType === 'Other' ? 15 : undefined,
            hidden: player1TeamInfo.teamType === 'Ultimate Team'
        },
        {
            id: 'player2TeamType',
            type: 'select',
            label: `${currentPlayer2Name}'s Team Type`,
            value: player2TeamInfo.teamType,
            options: teamTypeOptions,
            onChange: 'updateEditModalTeamOptionsHandler(2)'
        },
        {
            id: 'player2Team',
            type: player2TeamInfo.teamType === 'Other' ? 'text' : 'select',
            label: `${currentPlayer2Name}'s Team`,
            value: player2TeamInfo.team,
            options: player2TeamInfo.teamType === 'Other' ? undefined : [{ value: player2TeamInfo.team, text: player2TeamInfo.team || 'Select Team' }],
            placeholder: player2TeamInfo.teamType === 'Other' ? 'Enter team name' : undefined,
            maxlength: player2TeamInfo.teamType === 'Other' ? 15 : undefined,
            hidden: player2TeamInfo.teamType === 'Ultimate Team'
        }
    ];
    
    // Create the modal
    createFormModal({
        icon: '✏️',
        title: 'Edit Game',
        fields: fields,
        onSave: (formData) => {
            // Validation
            if (!formData.date) {
                showFormError('Please select a date');
                return false; // Prevent modal from closing
            }
            
            if (!formData.player1Goals && formData.player1Goals !== '0') {
                showFormError(`Please enter goals for ${currentPlayer1Name}`);
                return false; // Prevent modal from closing
            }
            
            if (!formData.player2Goals && formData.player2Goals !== '0') {
                showFormError(`Please enter goals for ${currentPlayer2Name}`);
                return false; // Prevent modal from closing
            }
            
            const player1Goals = parseInt(formData.player1Goals);
            const player2Goals = parseInt(formData.player2Goals);
            
            // Check for penalty result if it's a draw
            if (player1Goals === player2Goals && !formData.penaltyWinner) {
                showFormError('Please select a penalty result for draw games');
                return false; // Prevent modal from closing
            }
            
            // Validate Other team names are not blank
            if (formData.player1TeamType === 'Other' && (!formData.player1Team || !formData.player1Team.trim())) {
                showFormError(`Please enter a team name for ${currentPlayer1Name}`);
                return false; // Prevent modal from closing
            }
            
            if (formData.player2TeamType === 'Other' && (!formData.player2Team || !formData.player2Team.trim())) {
                showFormError(`Please enter a team name for ${currentPlayer2Name}`);
                return false; // Prevent modal from closing
            }
            
            // Hide any previous errors
            hideFormError();
            
            // Process team information
            let player1Team = 'Ultimate Team';
            let player2Team = 'Ultimate Team';
            
            if (formData.player1TeamType === 'Ultimate Team') {
                player1Team = 'Ultimate Team';
            } else if (formData.player1TeamType === 'Other') {
                player1Team = formData.player1Team || 'Other';
            } else {
                player1Team = formData.player1Team || formData.player1TeamType;
            }
            
            if (formData.player2TeamType === 'Ultimate Team') {
                player2Team = 'Ultimate Team';
            } else if (formData.player2TeamType === 'Other') {
                player2Team = formData.player2Team || 'Other';
            } else {
                player2Team = formData.player2Team || formData.player2TeamType;
            }
            
            // Save the original game for undo/redo
            const originalGame = { ...game };
            
            // Check if date/time was actually changed
            const originalDate = game.dateTime ? new Date(game.dateTime) : new Date();
            const originalDateStr = `${originalDate.getFullYear()}-${String(originalDate.getMonth() + 1).padStart(2, '0')}-${String(originalDate.getDate()).padStart(2, '0')}`;
            const originalTimeStr = `${String(originalDate.getHours()).padStart(2, '0')}:${String(originalDate.getMinutes()).padStart(2, '0')}:${String(originalDate.getSeconds()).padStart(2, '0')}`;
            
            let newDateTime;
            
            // Only update date/time if it was actually changed
            if (formData.date !== originalDateStr || (formData.time && formData.time !== originalTimeStr)) {
                // Date or time was changed - create new date/time
                const [year, month, day] = formData.date.split('-');
                newDateTime = new Date(
                    parseInt(year),
                    parseInt(month) - 1, // Months are 0-based
                    parseInt(day)
                );
                
                if (formData.time) {
                    const [hours, minutes, seconds] = formData.time.split(':');
                    newDateTime.setHours(parseInt(hours), parseInt(minutes), parseInt(seconds || 0));
                } else {
                    // If time field is empty but date was changed, keep the original time
                    newDateTime.setHours(originalDate.getHours(), originalDate.getMinutes(), originalDate.getSeconds());
                }
            } else {
                // Date/time wasn't changed - keep the original
                newDateTime = originalDate;
            }
            
            // Update the game
            // Convert penalty winner to number if it's '1' or '2', keep as string if 'draw'
            let penaltyWinner = null;
            if (player1Goals === player2Goals && formData.penaltyWinner) {
                if (formData.penaltyWinner === '1') {
                    penaltyWinner = 1;
                } else if (formData.penaltyWinner === '2') {
                    penaltyWinner = 2;
                } else if (formData.penaltyWinner === 'draw') {
                    penaltyWinner = 'draw';
                }
            }
            
            const updatedGame = {
                ...game,
                player1Goals: player1Goals,
                player2Goals: player2Goals,
                player1Team: player1Team,
                player2Team: player2Team,
                penaltyWinner: penaltyWinner,
                dateTime: newDateTime.toISOString()
            };
            
            // Update the game in the array
            const gameIndex = games.findIndex(m => m.id === id);
            if (gameIndex !== -1) {
                games[gameIndex] = updatedGame;
                
                // Add to history for undo/redo
                if (window.addToHistory) {
                    window.addToHistory({
                        type: 'edit_game',
                        data: {
                            originalData: originalGame,
                            newData: updatedGame
                        }
                    });
                }
                
                saveGames();
                updateUI();
                showToast('Game updated successfully!', 'success');
                
                // Close the modal - the createFormModal handles this automatically
            }
        },
        onCancel: () => {
            // Modal closes automatically
        }
    });
    
    // Initialize dropdowns after modal is created
    setTimeout(() => {
        // Hide any previous form errors
        if (window.hideFormError) {
            window.hideFormError();
        }
        
        // Initialize team dropdowns with current team values
        updateEditModalTeamOptions(1, player1TeamInfo.team);
        updateEditModalTeamOptions(2, player2TeamInfo.team);
        
        // Check if penalty field should be shown
        checkEditModalForDraw();
        
        // Initially hide penalty field if goals are not equal
        const penaltyField = document.getElementById('form-penaltyWinner');
        if (penaltyField && game.player1Goals !== game.player2Goals) {
            penaltyField.closest('.form-group').style.display = 'none';
        }
    }, 100);
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
    teamTypeSelect.value = 'Other';
    updateTeamOptions(playerNumber);
    document.getElementById(`player${playerNumber}CustomTeam`).value = teamName;
}

// Delete game
function deleteGame(id) {
    const game = games.find(m => m.id === id);
    if (!game) return;
    
    createConfirmationModal({
        icon: '❌',
        title: 'Delete Game',
        message: `Are you sure you want to delete this game? <br><strong>${player1Name} ${game.player1Goals} - ${game.player2Goals} ${player2Name}</strong>`,
        isDestructive: true,
        onConfirm: () => {
            // Add to undo history before deleting
            if (typeof addToHistory === 'function') {
                addToHistory({
                    type: 'delete_game',
                    data: game
                });
            }
            
            games = games.filter(m => m.id !== id);
            saveGames();
            updateUI();
            
            showToast(`Game deleted: ${player1Name} ${game.player1Goals} - ${game.player2Goals} ${player2Name}`, 'success');
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
        message: 'Are you sure you want to clear all game data? <strong>This action cannot be undone.</strong>',
        isDestructive: true,
        onConfirm: () => {
            games = [];
            saveGames();
            updateUI();
            
            createSuccessModal({
                icon: '✅',
                title: 'Data Cleared',
                message: 'All game data has been successfully cleared.'
            });
        },
        onCancel: () => {
            // Modal closes automatically
        }
    });
}

// Export data as JSON
function exportData() {
    if (games.length === 0) {
        createWarningModal({
            icon: '📤',
            title: 'No Data to Export',
            message: 'There are no games to export. Add some games first.',
            onConfirm: () => {},
            onCancel: () => {}
        });
        return;
    }
    
    const exportData = {
        players: {
            player1: player1Name,
            player2: player2Name
        },
        games: games,
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
        message: `Successfully exported ${games.length} games to <strong>${exportFileDefaultName}</strong>`
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
                    player1Name = importedData.players.player1 || 'Player 1';
                    player2Name = importedData.players.player2 || 'Player 2';
                    savePlayers();
                    applyPlayerNameChanges(player1Name, player2Name);
                }
                
                if (importedData.games && Array.isArray(importedData.games)) {
                    games = importedData.games;
                    saveGames();
                    updateUI();
                    
                    createSuccessModal({
                        icon: '📥',
                        title: 'Import Successful',
                        message: `Successfully imported ${games.length} games!`
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
    } else if (teamType === 'Other') {
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
    } else if (teamType === 'Other') {
        return document.getElementById(`player${playerNumber}CustomTeam`).value.trim() || 'Other';
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
    const player1IconDisplay = document.getElementById('player1IconDisplay');
    const player2IconDisplay = document.getElementById('player2IconDisplay');
    
    if (player1IconDisplay) player1IconDisplay.innerHTML = `<span class="team-logo">${playerIcons.player1}</span>`;
    if (player2IconDisplay) player2IconDisplay.innerHTML = `<span class="team-logo">${playerIcons.player2}</span>`;
    
    // Update display names (if elements exist)
    const player1DisplayName = document.getElementById('player1DisplayName');
    const player2DisplayName = document.getElementById('player2DisplayName');
    if (player1DisplayName) player1DisplayName.textContent = player1Name;
    if (player2DisplayName) player2DisplayName.textContent = player2Name;
    
    // Update table headers with icons
    const player1Header = document.getElementById('player1Header');
    const player2Header = document.getElementById('player2Header');
    
    if (player1Header) {
        const player1IconDisplay = playerIcons.player1 || '⚽';
        player1Header.innerHTML = `<span class="player-header-icon">${player1IconDisplay}</span> ${player1Name}`;
    }
    
    if (player2Header) {
        const player2IconDisplay = playerIcons.player2 || '⚽';
        player2Header.innerHTML = `<span class="player-header-icon">${player2IconDisplay}</span> ${player2Name}`;
    }
    
    // Update player management modal if it's open
    const playerModal = document.getElementById('playerManagementModal');
    if (playerModal && playerModal.classList.contains('active')) {
        updatePlayerModalContent();
    }
}


// Open icon selector for a player
function openIconSelector(playerNumber) {
    currentPlayerForIcon = playerNumber;
    const playerName = playerNumber === 1 ? player1Name : player2Name;
    const iconModalTitle = document.getElementById('iconModalTitle');
    if (iconModalTitle) {
        iconModalTitle.textContent = `Select Icon for ${playerName}`;
    }
    
    // Show sports icons by default
    showIconCategory('sports');
    
    const iconModal = document.getElementById('iconSelectorModal');
    if (iconModal) {
        iconModal.classList.add('active');
    }
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
        // Icon updated silently
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
    if (!menu) {
        // If no backup menu exists, just trigger export directly
        exportData();
        return;
    }
    
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
    const modal = document.getElementById('gameModal');
    const iconModal = document.getElementById('iconSelectorModal');
    
    if (event.target === modal) {
        closeGameModal();
    } else if (event.target === iconModal) {
        closeIconSelector();
    }
}

// Helper functions for edit modal
function checkEditModalForDraw() {
    const player1Goals = document.getElementById('form-player1Goals')?.value;
    const player2Goals = document.getElementById('form-player2Goals')?.value;
    const penaltyField = document.getElementById('form-penaltyWinner');
    
    if (penaltyField) {
        const penaltyGroup = penaltyField.closest('.form-group');
        if (player1Goals !== '' && player2Goals !== '' && player1Goals === player2Goals) {
            penaltyGroup.style.display = 'block';
        } else {
            penaltyGroup.style.display = 'none';
            penaltyField.value = '';
        }
    }
}

function updateEditModalTeamOptions(playerNumber, currentTeam = null) {
    const teamTypeSelect = document.getElementById(`form-player${playerNumber}TeamType`);
    let teamSelect = document.getElementById(`form-player${playerNumber}Team`);
    const teamSelectGroup = teamSelect ? teamSelect.closest('.form-group') : null;
    
    if (!teamTypeSelect || !teamSelect) return;
    
    const selectedType = teamTypeSelect.value;
    // If currentTeam is not provided, try to get it from the current value
    if (!currentTeam) {
        currentTeam = teamSelect.value || teamSelect.getAttribute('data-original-team');
    }
    
    // Clear existing options
    teamSelect.innerHTML = '';
    
    if (selectedType === 'Ultimate Team') {
        // Hide the team select for Ultimate Team
        if (teamSelectGroup) {
            teamSelectGroup.style.display = 'none';
        }
        // Just add Ultimate Team option (even though it's hidden)
        teamSelect.innerHTML = '<option value="Ultimate Team" selected>Ultimate Team</option>';
    } else if (selectedType === 'Other') {
        // Show the team select for other options
        if (teamSelectGroup) {
            teamSelectGroup.style.display = 'block';
        }
        // Convert to text input for Other teams
        const currentValue = teamSelect.value || '';
        teamSelect.outerHTML = `<input type="text" id="${teamSelect.id}" value="${currentValue}" class="form-input" placeholder="Enter team name" maxlength="15">`;
        // Re-get reference after replacing element
        const newTeamSelect = document.getElementById(teamSelect.id);
    } else if (TEAMS_DATA[selectedType]) {
        // Show the team select for league selections
        if (teamSelectGroup) {
            teamSelectGroup.style.display = 'block';
        }
        
        // If the current element is a text input, convert it back to select
        if (teamSelect.type === 'text') {
            const currentValue = teamSelect.value || '';
            teamSelect.outerHTML = `<select id="${teamSelect.id}" class="form-input"><option value="" disabled>Select Team</option></select>`;
            // Re-get reference after replacing element
            const newTeamSelect = document.getElementById(teamSelect.id.replace('form-', '').replace(/^/, 'form-'));
            if (newTeamSelect) {
                teamSelect = newTeamSelect;
            }
        } else {
            // Clear existing options
            teamSelect.innerHTML = '<option value="" disabled>Select Team</option>';
        }
        
        // Add all teams for this league
        TEAMS_DATA[selectedType].forEach(team => {
            const option = document.createElement('option');
            option.value = team;
            option.textContent = team;
            if (team === currentTeam) {
                option.selected = true;
            }
            teamSelect.appendChild(option);
        });
        
        // If no team was selected (currentTeam not found in the list), select the first team
        if (teamSelect.selectedIndex === 0 && TEAMS_DATA[selectedType].length > 0) {
            teamSelect.selectedIndex = 1; // Skip the "Select Team" option
        }
    }
}

// Handler for team type changes in edit modal
function updateEditModalTeamOptionsHandler(playerNumber) {
    // When team type changes, don't pass current team (let it reset)
    updateEditModalTeamOptions(playerNumber, null);
}

// Function to update UI with filtered data (similar to Mario Kart's updateDisplay)
function updateUIWithFilteredData(filteredGames) {
    // Apply sorting to the filtered games before rendering
    const sortedGames = [...filteredGames].sort((a, b) => {
        let valueA, valueB;
        
        switch(currentSortColumn) {
            case 'game':
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
                valueA = a.dateTime ? new Date(a.dateTime) : new Date(0);
                valueB = b.dateTime ? new Date(b.dateTime) : new Date(0);
        }
        
        if (currentSortDirection === 'asc') {
            return valueA < valueB ? -1 : valueA > valueB ? 1 : 0;
        } else {
            return valueA > valueB ? -1 : valueA < valueB ? 1 : 0;
        }
    });
    
    // Update the table with sorted filtered games
    renderGamesTableWithData(sortedGames);
    
    // Update sort indicators
    updateSortIndicators();
    
    // Update statistics with filtered games
    updateStatisticsWithData(filteredGames);
}

// Function to render games table with specific data
function renderGamesTableWithData(gamesData) {
    const tbody = document.getElementById('gamesTableBody');
    const noGamesDiv = document.getElementById('noGames');
    
    if (!tbody) return;
    
    if (gamesData.length === 0) {
        tbody.innerHTML = '';
        if (noGamesDiv) noGamesDiv.style.display = 'block';
        // Remove pagination if no data
        const existingPagination = document.querySelector('.pagination-container');
        if (existingPagination) {
            existingPagination.remove();
        }
        return;
    }
    
    if (noGamesDiv) noGamesDiv.style.display = 'none';
    
    // Get paginated subset if pagination is available (data is already sorted)
    const gamesToDisplay = window.GlobalPaginationManager
        ? window.GlobalPaginationManager.getPaginatedItems('football-h2h-games', gamesData)
        : gamesData;
    
    tbody.innerHTML = '';
    
    gamesToDisplay.forEach(game => {
        const row = document.createElement('tr');
        
        // Determine winner for styling
        let winner = '';
        if (game.player1Goals > game.player2Goals) {
            winner = 'player1';
        } else if (game.player2Goals > game.player1Goals) {
            winner = 'player2';
        } else if (game.penaltyWinner) {
            winner = game.penaltyWinner === 1 ? 'player1' : 'player2';
        }
        
        if (winner) row.classList.add(`${winner}-win`);
        
        const date = new Date(game.dateTime);
        const formattedDate = date.toLocaleDateString();
        const formattedTime = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
        
        // Score styling and penalty display
        let player1ScoreClass = '';
        let player2ScoreClass = '';
        let player1PenaltyText = '';
        let player2PenaltyText = '';
        
        if (game.player1Goals === game.player2Goals) {
            // Draw game - check for penalty winner
            if (game.penaltyWinner === 'draw') {
                // Both players get yellow circles for a penalty draw - no text needed
                player1ScoreClass = 'penalty-draw';
                player2ScoreClass = 'penalty-draw';
                // No penalty text for draws
            } else if (game.penaltyWinner === 1) {
                // Player 1 wins on penalties - green circle, player 2 gets red
                player1ScoreClass = 'penalty-winner';
                player2ScoreClass = 'penalty-loser';
                player1PenaltyText = ' (penalties)'; // Winner gets the text
            } else if (game.penaltyWinner === 2) {
                // Player 2 wins on penalties - green circle, player 1 gets red
                player1ScoreClass = 'penalty-loser';
                player2ScoreClass = 'penalty-winner';
                player2PenaltyText = ' (penalties)'; // Winner gets the text
            } else {
                // Regular draw (no penalties) - no penalty text
                player1ScoreClass = 'penalty-draw';
                player2ScoreClass = 'penalty-draw';
                // No penalty text for regular draws
            }
        } else {
            // Regular win/loss (not a draw)
            if (game.player1Goals > game.player2Goals) {
                // Player 1 wins
                player1ScoreClass = 'penalty-winner';
                player2ScoreClass = 'penalty-loser';
            } else {
                // Player 2 wins
                player1ScoreClass = 'penalty-loser';
                player2ScoreClass = 'penalty-winner';
            }
        }
        
        row.innerHTML = `
            <td class="game-number">${game.gameNumber}</td>
            <td class="game-date">${formattedDate}<br><small>${formattedTime}</small></td>
            <td class="player-score player1-score ${player1ScoreClass}">
                <span class="score-number">${game.player1Goals}</span>${player1PenaltyText}
            </td>
            <td class="player-score player2-score ${player2ScoreClass}">
                <span class="score-number">${game.player2Goals}</span>${player2PenaltyText}
            </td>
            <td class="team-name">${game.player1Team}</td>
            <td class="team-name">${game.player2Team}</td>
            <td class="actions">
                <button class="edit-btn" onclick="editGame(${game.id})" title="Edit game">✏️</button>
                <button class="delete-btn" onclick="deleteGame(${game.id})" title="Delete game">🗑️</button>
            </td>
        `;
        
        tbody.appendChild(row);
    });
    
    // Add pagination controls if available
    if (window.GlobalPaginationManager && gamesData.length > 0) {
        const paginationHtml = window.GlobalPaginationManager.createPaginationControls('football-h2h-games');
        const tableContainer = document.querySelector('.table-container');

        // Remove existing pagination if any
        const existingPagination = document.querySelector('.pagination-container');
        if (existingPagination) {
            existingPagination.remove();
        }

        // Insert pagination after the table container
        if (tableContainer) {
            tableContainer.insertAdjacentHTML('afterend', paginationHtml);
        }
    }
}

// Function to update statistics with specific data
function updateStatisticsWithData(gamesData) {
    let player1Wins = 0;
    let player2Wins = 0;
    let draws = 0;
    let totalGoals = 0;
    let penaltyShootouts = 0;
    
    gamesData.forEach(game => {
        totalGoals += game.player1Goals + game.player2Goals;
        
        if (game.player1Goals > game.player2Goals) {
            player1Wins++;
        } else if (game.player2Goals > game.player1Goals) {
            player2Wins++;
        } else {
            if (game.penaltyWinner && game.penaltyWinner !== 'draw') {
                penaltyShootouts++;
                // Count penalty winner as a win
                if (game.penaltyWinner === 1) {
                    player1Wins++;
                } else {
                    player2Wins++;
                }
            } else {
                draws++;
                if (game.penaltyWinner === 'draw') {
                    penaltyShootouts++;
                }
            }
        }
    });
    
    const totalGames = gamesData.length;
    const goalsPerGame = totalGames > 0 ? (totalGoals / totalGames).toFixed(1) : '0.0';
    
    // Update DOM elements
    const elements = {
        totalGames: document.getElementById('totalGames'),
        player1Wins: document.getElementById('player1Wins'),
        player2Wins: document.getElementById('player2Wins'),
        totalDraws: document.getElementById('totalDraws'),
        goalsPerGame: document.getElementById('goalsPerGame'),
        penaltyShootouts: document.getElementById('penaltyShootouts'),
        player1StatsName: document.getElementById('player1StatsName'),
        player2StatsName: document.getElementById('player2StatsName')
    };
    
    if (elements.totalGames) elements.totalGames.textContent = totalGames;
    if (elements.player1Wins) elements.player1Wins.textContent = player1Wins;
    if (elements.player2Wins) elements.player2Wins.textContent = player2Wins;
    if (elements.totalDraws) elements.totalDraws.textContent = draws;
    if (elements.goalsPerGame) elements.goalsPerGame.textContent = goalsPerGame;
    if (elements.penaltyShootouts) elements.penaltyShootouts.textContent = penaltyShootouts;
    if (elements.player1StatsName) elements.player1StatsName.textContent = player1Name;
    if (elements.player2StatsName) elements.player2StatsName.textContent = player2Name;
}

// Export player names, teams data and functions to global scope
window.player1Name = player1Name;
window.player2Name = player2Name;
window.playerIcons = playerIcons;
window.TEAMS_DATA = TEAMS_DATA;
window.getCurrentPlayerNames = function() {
    return { player1: player1Name, player2: player2Name };
};

// Export functions to global scope
window.toggleBackupMenu = toggleBackupMenu;
window.updateTeamOptions = updateTeamOptions;
window.showAddGameModal = showAddGameModal;
window.closeGameModal = closeGameModal;
window.saveGame = saveGame;
window.editGame = editGame;
window.deleteGame = deleteGame;
window.confirmClearData = confirmClearData;
window.exportData = exportData;
window.importData = importData;
window.sortGames = sortGames;
window.checkForDraw = checkForDraw;
window.openIconSelector = openIconSelector;
window.closeIconSelector = closeIconSelector;
window.showIconCategory = showIconCategory;
window.selectIcon = selectIcon;
window.updateUIWithFilteredData = updateUIWithFilteredData;
window.renderGamesTableWithData = renderGamesTableWithData;
window.updateStatisticsWithData = updateStatisticsWithData;
window.updatePlayerName = updatePlayerName;
window.loadPlayers = loadPlayers;
window.savePlayers = savePlayers;
window.loadPlayerIcons = loadPlayerIcons;
window.savePlayerIcons = savePlayerIcons;
window.checkEditModalForDraw = checkEditModalForDraw;
window.updateEditModalTeamOptions = updateEditModalTeamOptions;
window.updateEditModalTeamOptionsHandler = updateEditModalTeamOptionsHandler;

// Load players from localStorage
function loadPlayers() {
    const savedPlayers = localStorage.getItem(PLAYERS_KEY);
    if (savedPlayers) {
        const players = JSON.parse(savedPlayers);
        player1Name = players.player1 || 'Player 1';
        player2Name = players.player2 || 'Player 2';
    }
}

// Save players to localStorage
function savePlayers() {
    const players = {
        player1: player1Name,
        player2: player2Name
    };
    localStorage.setItem(PLAYERS_KEY, JSON.stringify(players));
}

// Load player icons from localStorage
function loadPlayerIcons() {
    const savedIcons = localStorage.getItem('footballH2HPlayerIcons');
    if (savedIcons) {
        playerIcons = JSON.parse(savedIcons);
    }
}

// Save player icons to localStorage
function savePlayerIcons() {
    localStorage.setItem('footballH2HPlayerIcons', JSON.stringify(playerIcons));
}

// Update player name from sidebar
function updatePlayerName(playerNumber, newName) {
    if (playerNumber === 1) {
        player1Name = newName || 'Player 1';
    } else if (playerNumber === 2) {
        player2Name = newName || 'Player 2';
    }
    
    // Save to localStorage
    savePlayers();
    
    // Update global exports
    window.player1Name = player1Name;
    window.player2Name = player2Name;
    window.playerIcons = playerIcons;
    
    // Refresh UI to show updated names
    updateUI();
    
    // Refresh sidebar player content if it's open
    if (window.refreshSidebarPlayerContent) {
        window.refreshSidebarPlayerContent();
    }
}

// Icon selection and management
// Open icon selector for a player
function openIconSelector(playerNumber) {
    currentPlayerForIcon = playerNumber;
    const playerName = playerNumber === 1 ? player1Name : player2Name;
    const iconModalTitle = document.getElementById('iconModalTitle');
    if (iconModalTitle) {
        iconModalTitle.textContent = `Select Icon for ${playerName}`;
    }
    
    // Show sports icons by default
    showIconCategory('sports');
    
    const iconModal = document.getElementById('iconSelectorModal');
    if (iconModal) {
        iconModal.classList.add('active');
    }
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

// Select an icon
function selectIcon(icon) {
    if (currentPlayerForIcon) {
        playerIcons[`player${currentPlayerForIcon}`] = icon;
        savePlayerIcons();
        
        // Update global exports
        window.playerIcons = playerIcons;
        
        // Update UI
        updateUI();
        
        // Refresh sidebar player content if it's open
        if (window.refreshSidebarPlayerContent) {
            window.refreshSidebarPlayerContent();
        }
        
        closeIconSelector();
        
        if (window.showToast) {
            // Icon updated silently
        }
    }
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
    if (sportsGrid) {
        sportsGrid.innerHTML = '';
        window.GlobalIcons.SPORTS.forEach(icon => {
            const iconDiv = document.createElement('div');
            iconDiv.className = 'icon-item';
            iconDiv.innerHTML = `<span class="team-logo">${icon}</span>`;
            iconDiv.onclick = () => selectIcon(icon);
            sportsGrid.appendChild(iconDiv);
        });
    }
    
    // Populate animal icons
    const animalsGrid = document.getElementById('animalsIconGrid');
    if (animalsGrid) {
        animalsGrid.innerHTML = '';
        window.GlobalIcons.ANIMALS.forEach(icon => {
            const iconDiv = document.createElement('div');
            iconDiv.className = 'icon-item';
            iconDiv.innerHTML = `<span class="team-logo">${icon}</span>`;
            iconDiv.onclick = () => selectIcon(icon);
            animalsGrid.appendChild(iconDiv);
        });
    }
    
    // Populate general icons
    const generalGrid = document.getElementById('generalIconGrid');
    if (generalGrid) {
        generalGrid.innerHTML = '';
        window.GlobalIcons.GENERAL.forEach(icon => {
            const iconDiv = document.createElement('div');
            iconDiv.className = 'icon-item';
            iconDiv.innerHTML = `<span class="team-logo">${icon}</span>`;
            iconDiv.onclick = () => selectIcon(icon);
            generalGrid.appendChild(iconDiv);
        });
    }
}

// Initialize the application
function initializeApp() {
    // Load players first
    loadPlayers();
    
    // Load games
    const savedGames = localStorage.getItem(STORAGE_KEY);
    if (savedGames) {
        games = JSON.parse(savedGames);
        window.games = games;
    }
    
    // Load player icons
    loadPlayerIcons();
    
    // Initialize icon grids
    setTimeout(() => {
        if (window.GlobalIcons) {
            initializeIconGrids();
        }
    }, 100);
    
    // Update UI
    updateUI();
    
    // Update global exports
    window.player1Name = player1Name;
    window.player2Name = player2Name;
}

// Run initialization when DOM is loaded
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeApp);
} else {
    initializeApp();
}
