let actionHistory = [];
let historyPosition = -1;
const MAX_HISTORY = 50;

function saveAction(actionType, data) {
    // Remove any actions after current position
    actionHistory = actionHistory.slice(0, historyPosition + 1);

    // Add new action
    actionHistory.push({
        type: actionType,
        data: JSON.parse(JSON.stringify(data)), // Deep copy
        timestamp: Date.now()
    });

    // Limit history size
    if (actionHistory.length > MAX_HISTORY) {
        actionHistory.shift();
    } else {
        historyPosition++;
    }

    updateUndoRedoButtons();
}

function updateUndoRedoButtons() {
    // Update widget buttons
    const undoBtn = document.getElementById('undo-btn');
    const redoBtn = document.getElementById('redo-btn');

    if (undoBtn && redoBtn) {
        undoBtn.disabled = historyPosition < 0;
        redoBtn.disabled = historyPosition >= actionHistory.length - 1;
    }
    
    // Update sidebar buttons
    const sidebarUndoBtn = document.getElementById('sidebar-undo-btn');
    const sidebarRedoBtn = document.getElementById('sidebar-redo-btn');
    
    if (sidebarUndoBtn && sidebarRedoBtn) {
        sidebarUndoBtn.disabled = historyPosition < 0;
        sidebarRedoBtn.disabled = historyPosition >= actionHistory.length - 1;
    }
}

function undoLastAction() {
    if (historyPosition < 0) return;

    const action = actionHistory[historyPosition];
    historyPosition--;

    switch (action.type) {
        case 'ADD_RACE':
            races.pop();
            break;
        case 'DELETE_RACE':
            races.splice(action.data.index, 0, action.data.race);
            break;
        case 'EDIT_RACE':
            races[action.data.index] = action.data.originalRace;
            break;
        case 'CLEAR_DATA':
            races = action.data.races;
            break;
    }

    const storageKey = window.getStorageKey ? window.getStorageKey('Races') : 'marioKartRaces';
    localStorage.setItem(storageKey, JSON.stringify(races));
    updateDisplay();
    updateAchievements();
    updateUndoRedoButtons();
    showMessage('Action undone');
}

function redoLastAction() {
    if (historyPosition >= actionHistory.length - 1) return;

    historyPosition++;
    const action = actionHistory[historyPosition];

    switch (action.type) {
        case 'ADD_RACE':
            races.push(action.data.race);
            break;
        case 'DELETE_RACE':
            races.splice(action.data.index, 1);
            break;
        case 'EDIT_RACE':
            races[action.data.index] = action.data.newRace;
            break;
        case 'CLEAR_DATA':
            races = [];
            break;
    }

    const storageKey = window.getStorageKey ? window.getStorageKey('Races') : 'marioKartRaces';
    localStorage.setItem(storageKey, JSON.stringify(races));
    updateDisplay();
    updateAchievements();
    updateUndoRedoButtons();
    showMessage('Action redone');
}