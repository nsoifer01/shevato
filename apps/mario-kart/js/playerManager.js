let playerCount = 3;
let players = ['player1', 'player2', 'player3'];
const maxPlayers = 4;

// The slots every table, chart and statistic reads with.
//
// `playerCount` is the entry-form width: how many people are playing now.
// The race log is a separate record of who has ever played, and cross-device
// sync carries the two under independent last-write-wins keys
// (marioKartPlayerCount, marioKartRaces), so they can disagree without anyone
// touching the app. Reading with the count alone is how a player with a full
// history disappears from the history table and from every statistic while
// their results sit intact in storage.
//
// Union of the two, so narrowing the entry form never hides a recorded
// result, and a slot you have added but not yet played still gets its column.
function rosterForCount(count) {
    const allPlayers = ['player1', 'player2', 'player3', 'player4'];
    const wanted = Number.isFinite(count) ? count : 0;
    let played = 0;
    if (typeof highestPlayerWithRaces === 'function' && typeof races !== 'undefined') {
        played = highestPlayerWithRaces(races);
    }
    const slots = Math.max(1, Math.min(maxPlayers, Math.max(wanted, played)));
    return allPlayers.slice(0, slots);
}

// Recompute the roster from the current count and race log. Called after the
// race log loads or changes, since either can widen it.
function refreshPlayerRoster() {
    players = rosterForCount(playerCount);
    return players;
}

// Use centralized player name manager
let playerNames = window.PlayerNameManager ? window.PlayerNameManager.getAll() : {
    player1: 'Player 1',
    player2: 'Player 2',
    player3: 'Player 3',
    player4: 'Player 4'
};

// Subscribe to name changes
if (window.PlayerNameManager) {
    window.PlayerNameManager.subscribe((newNames) => {
        playerNames = newNames;
        updatePlayerLabels();
    });
}

// updatePlayerLabels lives in updatePlayerLabels.js, which loads after this file
// and so owned the name anyway; the copy that used to sit here was dead from the
// day the second one was added. Its table-header rewrite was superseded by
// updateHistoryTableHeaders() in main.js (4 players, aria-sort, sort indicators),
// and its name-input sync by backup.js and dataManager.js. The subscribe callback
// above calls the live one.

function updatePlayerName(playerKey, newName) {
    if (newName.trim() === '') return;

    // Use centralized manager
    if (window.PlayerNameManager) {
        window.PlayerNameManager.set(playerKey, newName);
    } else {
        // Fallback
        playerNames[playerKey] = newName.trim();
    }

    updateDisplay(); // Refresh display to show new names
    showMessage('Player name updated!');
}

function updatePlayerCount(newCount) {
    newCount = parseInt(newCount);
    if (newCount < 1 || newCount > maxPlayers) return;

    const oldCount = playerCount;
    playerCount = newCount;

    // Update players array
    players = rosterForCount(playerCount);

    // Update UI visibility
    updatePlayerFieldsVisibility();
    updateInputGroupClass();

    // Save to localStorage
    try {
        const storageKey = window.getStorageKey ? window.getStorageKey('PlayerCount') : 'marioKartPlayerCount';
        localStorage.setItem(storageKey, playerCount.toString());
    } catch (e) {
        console.error('Error saving player count:', e);
    }

    // Clear form inputs for removed players
    if (newCount < oldCount) {
        for (let i = newCount; i < oldCount; i++) {
            const playerKey = ['player1', 'player2', 'player3', 'player4'][i];
            const input = document.getElementById(playerKey);
            if (input) input.value = '';
        }
    }

    // Recreate number buttons for new player count
    // createNumberButtons(); // Position buttons removed - using dropdown only
    createAllBars();
    updateDisplay();
    updateAchievements();
    
    // Refresh sidebar race form if it's open
    if (window.refreshSidebarRaceForm) {
        window.refreshSidebarRaceForm();
    }
    
    showMessage(`Updated to ${newCount} player${newCount !== 1 ? 's' : ''}!`);
}

function updatePlayerFieldsVisibility() {
    // Update name inputs
    const nameInputs = ['player1-name', 'player2-name', 'player3-name', 'player4-name'];
    nameInputs.forEach((id, index) => {
        const input = document.getElementById(id);
        if (input) {
            input.style.display = index < playerCount ? 'block' : 'none';
        }
    });

    // Update position input fields
    const playerFields = ['player1', 'player2', 'player3', 'player4'];
    playerFields.forEach((player, index) => {
        const field = document.getElementById(`${player}-field`) ||
                     document.querySelector(`.input-field:nth-child(${index + 1})`);
        if (field) {
            field.style.display = index < playerCount ? 'block' : 'none';
        }
    });

    // Update player4 specific field
    const player4Field = document.getElementById('player4-field');
    if (player4Field) {
        player4Field.style.display = playerCount >= 4 ? 'block' : 'none';
    }
}

function updateInputGroupClass() {
    const inputGroup = document.querySelector('.input-group');
    if (inputGroup) {
        // Remove all player count classes
        inputGroup.className = inputGroup.className.replace(/players-\d+/g, '');
        // Add current player count class
        inputGroup.classList.add(`players-${playerCount}`);
    }
}


window.getPlayerCount = function () { return playerCount; };


// getPlayerName lives in playerNameManager.js, which owns the stored names.
// A second copy here used to shadow it: both are top-level declarations in the
// page's shared scope, this file loads later, so a bare getPlayerName() call got
// THIS copy while PlayerNameManager.get() kept the other one (it captured the
// function object before the overwrite). Two names, two stores, no error.