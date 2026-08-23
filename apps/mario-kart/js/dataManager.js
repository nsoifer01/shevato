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

// Highest player slot that actually appears in the race log, or 0 when the
// log is empty. Deliberately NOT detectActivePlayersFromRaces: that one
// answers "how many players should an import switch to" and defaults to 3
// for an empty log, which would drag a 1- or 2-player setup back up to 3.
// This one answers "who has recorded results" and says 0 when nobody does.
function highestPlayerWithRaces(raceData) {
    if (!Array.isArray(raceData)) return 0;
    let highest = 0;
    for (const race of raceData) {
        if (!race) continue;
        for (let i = 4; i > highest; i--) {
            const pos = race[`player${i}`];
            if (pos !== null && pos !== undefined) {
                highest = i;
                break;
            }
        }
        if (highest === 4) break;
    }
    return highest;
}

function addRace() {
    const date = document.getElementById('date').value;
    // Dynamic player data collection
    const raceData = {};
    const allPlayers = ['player1', 'player2', 'player3', 'player4'];

    let nonInteger = false;
    allPlayers.forEach(player => {
        const input = document.getElementById(player);
        const value = input ? String(input.value).trim() : '';
        if (!value) {
            raceData[player] = null;
        } else if (/^\d+$/.test(value)) {
            raceData[player] = parseInt(value, 10);
        } else {
            // "1.5" and "1e1" used to be silently truncated by parseInt.
            nonInteger = true;
            raceData[player] = null;
        }
    });

    // Generate local time timestamp with timezone. Formatted by hand on the
    // h23 clock: Intl with hour12:false renders midnight as "24:MM:SS" in
    // V8, an unparseable stamp that used to break the chronological sorts.
    const now = new Date();
    const pad2 = (n) => String(n).padStart(2, '0');
    const localTime = `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;

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

    if (nonInteger) {
        showMessage('Positions must be whole numbers', true);
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

    // Optional course/map (from the course picker). Stored as id + name so
    // history stays readable even if the course later leaves the dataset.
    const selectedCourse = window.CoursePicker ? window.CoursePicker.getSelected() : null;
    if (selectedCourse) {
        raceObject.courseId = selectedCourse.id;
        raceObject.course = selectedCourse.name;
    }

    races.push(raceObject);

    // The app's core action, reported only after every validation above has
    // passed. Player count and whether a course was picked, never player
    // names or finishing positions.
    if (typeof window !== 'undefined' && window.shevatoAnalytics) {
        try {
            window.shevatoAnalytics.trackAction('race_logged', {
                player_count: activePlayers.length,
                has_course: Boolean(selectedCourse),
            });
        } catch (e) { /* analytics must never break the app */ }
    }

    // Save action for undo/redo
    saveAction('ADD_RACE', { race: raceObject });
    
    try {
        const storageKey = window.getStorageKey ? window.getStorageKey('Races') : 'marioKartRaces';
        localStorage.setItem(storageKey, JSON.stringify(races));
    } catch (e) {
        console.error('Error saving to localStorage:', e);
    }

    // Clear inputs for all players
    allPlayers.forEach(player => {
        const input = document.getElementById(player);
        if (input) input.value = '';
    });

    // Remember the picked course as "recent" and reset the picker for next time.
    if (window.CoursePicker) {
        window.CoursePicker.commit();
        window.CoursePicker.clear();
    }

    updateDisplay();
    updateAchievements();
    updateClearButtonState();
    showMessage('Race added successfully!');
}

function editRace(index) {
    const race = races[index];
    if (!race) return;

    const esc = (v) => (typeof escapeHtml === 'function' ? escapeHtml(v) : String(v == null ? '' : v));

    const playerInputs = players.map(player => {
        const currentValue = isFinitePosition(race[player]) ? race[player] : '';
        const name = window.PlayerNameManager ? window.PlayerNameManager.get(player) : getPlayerName(player);
        return `
            <div class="edit-race-field">
                <label class="edit-race-label" for="edit-${player}">
                    ${esc(name)}'s Position:
                </label>
                <input type="number" id="edit-${player}" class="edit-race-input" inputmode="numeric" step="1" min="${MIN_POSITIONS}" max="${MAX_POSITIONS}" value="${currentValue}" placeholder="${MIN_POSITIONS}-${MAX_POSITIONS} or leave empty">
            </div>
        `;
    }).join('');

    const timeValue = typeof race.timestamp === 'string' && race.timestamp.includes(':') ? race.timestamp.split(' ')[0] : '';

    const { close } = presentModal({
        dialogClass: 'edit-race-dialog',
        initialFocus: '#edit-date',
        html: `
        <div class="modal-icon">✏️</div>
        <h3 class="modal-title">Edit Race</h3>
        <p class="modal-text edit-race-meta">${esc(formatDateForDisplay(race.date))}${race.timestamp ? ', ' + esc(race.timestamp) : ''}</p>

        <div class="edit-race-datetime">
            <div class="edit-race-field">
                <label class="edit-race-label" for="edit-date">
                    Race Date:
                </label>
                <input type="date" id="edit-date" class="edit-race-input" value="${esc(race.date)}">
            </div>
            <div class="edit-race-field">
                <label class="edit-race-label" for="edit-time">
                    Race Time:
                </label>
                <input type="time" id="edit-time" class="edit-race-input" value="${esc(timeValue)}" step="1" placeholder="Optional">
            </div>
        </div>

        ${playerInputs}

        <div class="modal-buttons">
            <button id="save-edit" class="modal-btn-primary">Save Changes</button>
            <button id="cancel-edit" class="modal-btn-secondary ">Cancel</button>
        </div>
    `,
    });

    document.getElementById('cancel-edit').onclick = close;

    document.getElementById('save-edit').onclick = () => {
        const newDate = document.getElementById('edit-date').value;
        const newTime = document.getElementById('edit-time').value;
        
        if (!newDate) {
            showMessage('Please select a date', true);
            return;
        }

        // Save the original race for undo/redo
        const originalRace = { ...race };
        
        // Check if date/time actually changed
        const originalTime = race.timestamp ? race.timestamp.split(' ')[0] : '';
        const dateChanged = newDate !== race.date;
        const timeChanged = newTime !== originalTime;
        
        // Collect new position data
        const newPositions = {};
        let validPositions = [];
        let validationError = null;

        players.forEach(player => {
            const input = document.getElementById(`edit-${player}`);
            const value = input.value.trim();
            if (value === '') {
                newPositions[player] = null;
            } else if (!/^\d+$/.test(value)) {
                validationError = 'Positions must be whole numbers';
            } else {
                const position = parseInt(value, 10);
                if (position < MIN_POSITIONS || position > MAX_POSITIONS) {
                    validationError = `Positions must be between ${MIN_POSITIONS} and ${MAX_POSITIONS}`;
                    return;
                }
                newPositions[player] = position;
                validPositions.push(position);
            }
        });

        // Check if validation failed
        if (validationError) {
            showMessage(validationError, true);
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

        // Handle timestamp updates
        let newTimestamp = race.timestamp; // Keep original by default
        
        if (timeChanged) {
            if (newTime) {
                // Time was changed to a new value
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
            } else {
                // Time was cleared
                newTimestamp = null;
            }
        }

        // Update the race
        const updatedRace = {
            ...race,
            date: dateChanged ? newDate : race.date,
            ...newPositions
        };

        // Handle timestamp
        if (newTimestamp) {
            updatedRace.timestamp = newTimestamp;
        } else if (newTimestamp === null) {
            delete updatedRace.timestamp;
        }

        races[index] = updatedRace;

        // Save action for undo/redo
        saveAction('EDIT_RACE', { originalRace, newRace: races[index], index });

        try {
            const storageKey = window.getStorageKey ? window.getStorageKey('Races') : 'marioKartRaces';
            localStorage.setItem(storageKey, JSON.stringify(races));
        } catch (e) {
            console.error('Error saving to localStorage:', e);
        }

        updateDisplay();
        // Explicitly pass fresh filtered data to ensure achievements use updated race data
        const freshFilteredRaces = getFilteredRaces();
        updateAchievements(freshFilteredRaces);
        updateClearButtonState();
        showMessage('Race updated successfully!');
        close();
    };
}

function deleteRace(index) {
    const race = races[index];
    if (!race) return;

    const esc = (v) => (typeof escapeHtml === 'function' ? escapeHtml(v) : String(v == null ? '' : v));
    const raceNumber = index + 1;
    const raceMeta = `Race #${raceNumber}, ${esc(formatDateForDisplay(race.date))}`;

    const { close } = presentModal({
        initialFocus: '#cancel-delete-race',
        html: `
        <div class="modal-icon">🗑️</div>
        <h3 class="modal-title ">Delete this race?</h3>
        <p class="modal-text ">${raceMeta}</p>
        <div class="modal-buttons">
            <button id="confirm-delete-race" class="modal-btn-danger">Delete Race</button>
            <button id="cancel-delete-race" class="modal-btn-secondary ">Cancel</button>
        </div>
    `,
    });

    document.getElementById('cancel-delete-race').onclick = close;
    document.getElementById('confirm-delete-race').onclick = () => {
        close();
        performDeleteRace(index);
    };
}

function performDeleteRace(index) {
    // Save action for undo/redo before deleting
    const raceToDelete = races[index];
    saveAction('DELETE_RACE', { race: raceToDelete, index });

    races.splice(index, 1);
    try {
        const storageKey = window.getStorageKey ? window.getStorageKey('Races') : 'marioKartRaces';
        localStorage.setItem(storageKey, JSON.stringify(races));
    } catch (e) {
        console.error('Error saving to localStorage:', e);
    }
    updateDisplay();
    updateClearButtonState();
    showMessage('Race removed successfully!');
}

// --- Race data validation -----------------------------------------------
// ONE sanitizer for every path that replaces the race log wholesale (import,
// restore from backup) plus the cheap healing the load path already did.
// Structure is repaired where the fix is unambiguous (legacy slav/mike/nikita
// keys, "24:MM:SS" midnight stamps, empty entries, unreadable times and
// course tags) and every repair is listed; anything that would change a
// result (bad date, non-integer / out-of-range / duplicate positions) is an
// error that rejects the whole payload with a plain-language message. Nothing
// is persisted until the sanitizer says ok.

const RACE_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
// "HH:MM[:SS][ zone]"; hour 24 is accepted here and healed to 00 below.
const RACE_TIMESTAMP_RE = /^(\d{1,2}):(\d{2})(?::(\d{2}))?(?: [A-Za-z0-9+\-:/_.]{1,40})?$/;
const MAX_COURSE_LENGTH = 80;
const MAX_PLAYER_NAME_LENGTH = 40;

function isValidRaceDate(value) {
    if (typeof value !== 'string') return false;
    const m = value.match(RACE_DATE_RE);
    if (!m) return false;
    const y = parseInt(m[1], 10), mo = parseInt(m[2], 10), d = parseInt(m[3], 10);
    if (mo < 1 || mo > 12 || d < 1) return false;
    const probe = new Date(y, mo - 1, d);
    return probe.getFullYear() === y && probe.getMonth() === mo - 1 && probe.getDate() === d;
}

// Repairs one race in place-of (returns a copy when anything changed).
// Shared by migrateRaceData (load path) and sanitizeRaceData.
function healRace(race, repairs, label) {
    let healed = race;
    const touch = () => { if (healed === race) healed = { ...race }; };

    if (race.hasOwnProperty('slav') || race.hasOwnProperty('mike') || race.hasOwnProperty('nikita')) {
        touch();
        healed.player1 = race.slav || null;
        healed.player2 = race.mike || null;
        healed.player3 = race.nikita || null;
        healed.player4 = race.player4 || null;
        delete healed.slav;
        delete healed.mike;
        delete healed.nikita;
        repairs.push(`${label}: migrated legacy player keys`);
    }

    if (healed.timestamp === null || healed.timestamp === '') {
        touch();
        delete healed.timestamp;
    } else if (healed.timestamp !== undefined) {
        if (typeof healed.timestamp !== 'string' || !RACE_TIMESTAMP_RE.test(healed.timestamp)) {
            touch();
            delete healed.timestamp;
            repairs.push(`${label}: dropped an unreadable time`);
        } else if (/^24:/.test(healed.timestamp)) {
            // Legacy midnight stamp from the old h24 formatter.
            touch();
            healed.timestamp = healed.timestamp.replace(/^24:/, '00:');
            repairs.push(`${label}: healed a 24:MM midnight time`);
        }
    }

    for (const key of ['course', 'courseId']) {
        if (healed[key] === undefined) continue;
        if (typeof healed[key] !== 'string' || !healed[key].trim()) {
            touch();
            delete healed[key];
            repairs.push(`${label}: dropped an unreadable course tag`);
        } else if (healed[key].length > MAX_COURSE_LENGTH) {
            touch();
            healed[key] = healed[key].slice(0, MAX_COURSE_LENGTH);
            repairs.push(`${label}: shortened the course name`);
        }
    }

    return healed;
}

function sanitizeRaceData(input, options = {}) {
    const maxPositions = options.maxPositions || window.MAX_POSITIONS
        || (typeof MAX_POSITIONS !== 'undefined' ? MAX_POSITIONS : 12);
    if (!Array.isArray(input)) {
        return { ok: false, error: 'no race list found', races: [], repairs: [] };
    }
    const repairs = [];
    const out = [];
    for (let i = 0; i < input.length; i++) {
        const label = `race #${i + 1}`;
        const raw = input[i];
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            repairs.push(`${label}: dropped an empty entry`);
            continue;
        }
        const race = { ...healRace(raw, repairs, label) };

        if (!isValidRaceDate(race.date)) {
            const shown = typeof race.date === 'string' ? race.date.slice(0, 20) : 'missing';
            return { ok: false, error: `${label} has an invalid date (${shown}); dates must be YYYY-MM-DD`, races: [], repairs };
        }

        const seen = new Set();
        for (const player of ['player1', 'player2', 'player3', 'player4']) {
            let value = race[player];
            if (value === undefined || value === null) continue;
            if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
                // Whole-number text ("2") is unambiguous: keep it as a number.
                value = parseInt(value.trim(), 10);
                repairs.push(`${label}: converted a text position to a number`);
            }
            if (!Number.isInteger(value) || value < 1 || value > maxPositions) {
                return { ok: false, error: `${label} has an invalid ${player.replace('player', 'player ')} position (${String(value).slice(0, 20)}); positions must be whole numbers from 1 to ${maxPositions}`, races: [], repairs };
            }
            if (seen.has(value)) {
                return { ok: false, error: `${label}: players cannot have the same position (${value})`, races: [], repairs };
            }
            seen.add(value);
            race[player] = value;
        }
        out.push(race);
    }
    return { ok: true, error: null, races: out, repairs };
}

// Player names from a file: only non-empty strings count, trimmed and capped;
// anything else (numbers, objects) falls back to the default for that slot so
// renderers never see a non-string. Unknown keys are ignored.
function sanitizePlayerNames(input) {
    const out = {};
    if (!input || typeof input !== 'object') return out;
    for (const key of ['player1', 'player2', 'player3', 'player4']) {
        const value = input[key];
        if (typeof value !== 'string') continue;
        const clean = value.trim().slice(0, MAX_PLAYER_NAME_LENGTH);
        if (clean) out[key] = clean;
    }
    return out;
}

function migrateRaceData(races) {
    const repairs = [];
    const migratedRaces = [];
    for (const race of races) {
        // Sparse/null rows (left behind by the pre-2026-08 clear+undo bug)
        // would crash every stat on load, so the load path drops them.
        if (!race || typeof race !== 'object') { repairs.push('dropped an empty entry'); continue; }
        migratedRaces.push(healRace(race, repairs, 'race'));
    }

    if (repairs.length > 0) {
        console.log('Migrating race data from old format to new format');
        const storageKey = window.getStorageKey ? window.getStorageKey('Races') : 'marioKartRaces';
        localStorage.setItem(storageKey, JSON.stringify(migratedRaces));
    }

    return migratedRaces;
}

function loadSavedData() {
    try {
        const storageKey = window.getStorageKey ? window.getStorageKey('Races') : 'marioKartRaces';
        const savedRaces = localStorage.getItem(storageKey);
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
            const storageKey = window.getStorageKey ? window.getStorageKey('PlayerNames') : 'marioKartPlayerNames';
            const savedNames = localStorage.getItem(storageKey);
            if (savedNames) {
                playerNames = JSON.parse(savedNames);
            }
        } catch (e) {
            console.error('Error loading player names:', e);
        }
    }

    // Load player count from localStorage
    try {
        const storageKey = window.getStorageKey ? window.getStorageKey('PlayerCount') : 'marioKartPlayerCount';
        // Start from the module default on every load so a version switch
        // never carries the other game's count across.
        playerCount = 3;
        const savedPlayerCount = localStorage.getItem(storageKey) || localStorage.getItem('marioKartPlayerCount');
        const parsedCount = parseInt(savedPlayerCount, 10);
        if (parsedCount >= 1 && parsedCount <= 4) {
            playerCount = parsedCount;
        } else if (typeof highestPlayerWithRaces === 'function') {
            // No stored count. A stored one is a choice we must respect even
            // when it looks small (someone really can drop from four players
            // to three), but an absent one records no choice at all, and the
            // module default of 3 would silently narrow the entry form for
            // someone whose race log plainly has four. This is the shape a
            // device lands in when sync delivers the race log without the
            // count key, since the two travel as independent keys.
            playerCount = Math.max(playerCount, highestPlayerWithRaces(races));
        }

        // Update the select dropdown
        const playerCountSelect = document.getElementById('player-count');
        if (playerCountSelect) {
            playerCountSelect.value = playerCount.toString();
        }
    } catch (e) {
        console.error('Error loading player count:', e);
    }

    // Always recompute the roster, count key or not. A device that received
    // the race log but not the count key (or received a stale one) would
    // otherwise read with the module default of 3 and drop a fourth player
    // who has a full history. Runs outside the try above so a failed count
    // read still leaves the roster matching the races we did load.
    if (typeof refreshPlayerRoster === 'function') {
        refreshPlayerRoster();
    }
}

function exportData() {
    const data = {
        races: races,
        playerNames: window.PlayerNameManager ? window.PlayerNameManager.getAll() : playerNames,  // Include player names in export
        playerSymbols: window.PlayerSymbolManager ? window.PlayerSymbolManager.getAllSymbols() : {},  // Include player symbols
        exportDate: new Date().toISOString(),
        version: '1.5',  // Updated version
        actionHistory: typeof actionHistory !== 'undefined' ? actionHistory : []  // Include undo/redo history (was part of the old backup download)
    };

    const dataStr = JSON.stringify(data, null, 2);
    const dataBlob = new Blob([dataStr], {type: 'application/json'});

    const link = document.createElement('a');
    link.href = URL.createObjectURL(dataBlob);
    link.download = `mario-kart-data-${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    // Refresh the auto-backup too (absorbed from the old Download Backup button)
    if (typeof autoBackupToLocalStorage === 'function') autoBackupToLocalStorage();

    showMessage('Data exported and auto-backup updated!');
}

function importData(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            let importedData;
            try {
                importedData = JSON.parse(e.target.result);
            } catch (parseError) {
                showMessage('Import failed: that file is not valid JSON', true);
                return;
            }

            if (!importedData || typeof importedData !== 'object' || !Array.isArray(importedData.races)) {
                showMessage('Import failed: this file has no race list (expected a Mario Kart export)', true);
                return;
            }

            const result = sanitizeRaceData(importedData.races);
            if (!result.ok) {
                showMessage(`Import failed: ${result.error}`, true);
                return;
            }

            races = result.races;
            const storageKey = window.getStorageKey ? window.getStorageKey('Races') : 'marioKartRaces';
            localStorage.setItem(storageKey, JSON.stringify(races));

            // The stack indexed the old log; none of it applies now.
            if (typeof resetActionHistory === 'function') resetActionHistory();
            
            // Detect active players from race data
            const activePlayerCount = detectActivePlayersFromRaces(races);
            if (activePlayerCount > 0 && typeof updatePlayerCount === 'function') {
                updatePlayerCount(activePlayerCount);
            }
            
            // Import player names if present (backward compatible)
            const importedNames = sanitizePlayerNames(importedData.playerNames);
            if (Object.keys(importedNames).length > 0) {
                // Use centralized PlayerNameManager
                if (window.PlayerNameManager) {
                    window.PlayerNameManager.setAll(importedNames);
                } else {
                    // Fallback
                    playerNames = {
                        player1: importedNames.player1 || 'Player 1',
                        player2: importedNames.player2 || 'Player 2',
                        player3: importedNames.player3 || 'Player 3',
                        player4: importedNames.player4 || 'Player 4'
                    };
                    
                    // Save to localStorage
                    const storageKey = window.getStorageKey ? window.getStorageKey('PlayerNames') : 'marioKartPlayerNames';
                    localStorage.setItem(storageKey, JSON.stringify(playerNames));
                    
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
            
            // Import player symbols if present (version 1.3+): short strings only.
            if (importedData.playerSymbols && typeof importedData.playerSymbols === 'object') {
                const symbols = {};
                for (const key of ['player1', 'player2', 'player3', 'player4']) {
                    const v = importedData.playerSymbols[key];
                    if (typeof v === 'string' && v && v.length <= 8) symbols[key] = v;
                }
                if (window.PlayerSymbolManager) {
                    window.PlayerSymbolManager.setAllSymbols(symbols);
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
            
            if (result.repairs.length > 0) {
                showMessage(`Imported ${races.length} races (repaired: ${summarizeRepairs(result.repairs)})`);
            } else {
                showMessage(`Successfully imported ${races.length} races!`);
            }

        } catch (error) {
            console.error('Import error:', error);
            showMessage('Import failed: the file could not be read', true);
        }
    };
    reader.readAsText(file);

    // Reset the file input
    event.target.value = '';
}

// "race #3: healed a 24:MM midnight time, race #4: ..." is too long for a
// toast; collapse to counts per repair kind.
function summarizeRepairs(repairs) {
    const counts = new Map();
    for (const r of repairs) {
        const kind = r.replace(/^race #\d+: /, '');
        counts.set(kind, (counts.get(kind) || 0) + 1);
    }
    return Array.from(counts, ([kind, n]) => (n > 1 ? `${kind} x${n}` : kind)).join(', ');
}

function confirmClearData() {
    // This function should only be called when there is data to clear
    // The button should be disabled when there's no data
    if (!races || races.length === 0) {
        return;
    }
    
    const { close } = presentModal({
        initialFocus: '#cancel-clear',
        html: `
        <div class="modal-icon">⚠️</div>
        <h3 class="modal-title ">Clear All Data?</h3>
        <p class="modal-text ">
            This deletes every race and statistic for this game. Player names and icons stay. You can bring the races back with Undo straight away, or later with Restore (the auto-backup is refreshed first).
        </p>
        <div class="modal-buttons">
            <button id="confirm-clear" class="modal-btn-danger">Delete Everything</button>
            <button id="cancel-clear" class="modal-btn-secondary ">Cancel</button>
        </div>
    `,
    });

    document.getElementById('cancel-clear').onclick = close;
    document.getElementById('confirm-clear').onclick = () => {
        close();
        clearData();
    };
}

function clearData() {
    // Direct clear without confirmation dialog (called from confirmClearData)
    // Lifecycle: the clear is itself an undoable action. saveAction deep-copies
    // the snapshot, undo restores it, and because the snapshot has the same
    // rows at the same indices, every older EDIT/DELETE entry still replays
    // against the data it was recorded on. The pre-2026-08 clear left the
    // stack untouched and the next undo wrote sparse null rows to storage.
    const snapshot = races;

    // Refresh the auto-backup first so a mistaken clear is recoverable via
    // Restore even after the page reloads and the undo stack is gone.
    if (snapshot.length > 0 && typeof autoBackupToLocalStorage === 'function') {
        autoBackupToLocalStorage();
    }

    races = [];
    saveAction('CLEAR_DATA', { races: snapshot });

    try {
        const racesKey = window.getStorageKey ? window.getStorageKey('Races') : 'marioKartRaces';
        localStorage.setItem(racesKey, '[]');
    } catch (e) {
        console.error('Error clearing localStorage:', e);
    }

    // Don't directly update innerHTML here - let updateDisplay handle it based on current view
    // This prevents destroying the achievements view structure
    
    // Update display to ensure everything is cleared properly for the current view
    updateDisplay();
    updateAchievements();

    showMessage('All races cleared. Undo brings them back.');
    
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

// Export loadSavedData globally for game version switching
window.loadSavedData = loadSavedData;
