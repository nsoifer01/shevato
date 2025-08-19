let playerCount = 3;
let players = ['player1', 'player2', 'player3'];
const maxPlayers = 4;

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

function updatePlayerLabels() {
    // Update input labels for all possible players - now just shows names
    const label1 = document.getElementById('player1-label');
    const label2 = document.getElementById('player2-label');
    const label3 = document.getElementById('player3-label');
    const label4 = document.getElementById('player4-label');
    
    if (label1) label1.textContent = playerNames.player1;
    if (label2) label2.textContent = playerNames.player2;
    if (label3) label3.textContent = playerNames.player3;
    if (label4) label4.textContent = playerNames.player4;

    // Update table headers
    const headers = document.querySelectorAll('#history-table th');
    if (headers.length >= 5) {
        headers[2].innerHTML = `<span style="cursor: pointer;" onclick="sortTable('player1')" tabindex="0" onkeydown="if(event.key==='Enter'||event.key===' ')sortTable('player1')" aria-label="Sort by ${playerNames.player1}'s position">${playerNames.player1} ↕</span>`;
        headers[3].innerHTML = `<span style="cursor: pointer;" onclick="sortTable('player2')" tabindex="0" onkeydown="if(event.key==='Enter'||event.key===' ')sortTable('player2')" aria-label="Sort by ${playerNames.player2}'s position">${playerNames.player2} ↕</span>`;
        headers[4].innerHTML = `<span style="cursor: pointer;" onclick="sortTable('player3')" tabindex="0" onkeydown="if(event.key==='Enter'||event.key===' ')sortTable('player3')" aria-label="Sort by ${playerNames.player3}'s position">${playerNames.player3} ↕</span>`;
    }

    // Update player name inputs if they exist
    if (document.getElementById('player1-name')) {
        document.getElementById('player1-name').value = playerNames.player1;
        document.getElementById('player2-name').value = playerNames.player2;
        document.getElementById('player3-name').value = playerNames.player3;
        
        // Update player4 name input
        const player4Input = document.getElementById('player4-name');
        if (player4Input) {
            player4Input.value = playerNames.player4;
        }
    }
}

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
    const allPlayers = ['player1', 'player2', 'player3', 'player4'];
    players = allPlayers.slice(0, playerCount);

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
            const playerKey = allPlayers[i];
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


function getPlayerKey(playerIndex) {
    const keyMap = { 0: 'player1', 1: 'player2', 2: 'player3', 3: 'player4' };
    return keyMap[playerIndex];
}

function getPlayerName(playerKey) {
    const nameMap = { 'player1': playerNames.player1, 'player2': playerNames.player2, 'player3': playerNames.player3, 'player4': playerNames.player4 };
    return nameMap[playerKey] || playerKey;
}