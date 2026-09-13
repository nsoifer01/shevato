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

// Drop the whole stack. Called whenever the race log is replaced wholesale
// by something the stack never saw (import, restore, a foreign tab's write):
// its entries describe races that may no longer exist.
function resetActionHistory() {
    actionHistory = [];
    historyPosition = -1;
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

// Applies one history step to `races`, naming the race by its id and
// resolving it NOW. `races` may have been replaced (another tab, a cloud
// delivery) since the step was recorded, so a stored index could point at a
// different race: undoing a delete once wrote a null row, and undoing an edit
// overwrote whichever race had moved into its slot. Returns false, having
// changed nothing, when the race is not where the step needs it.
function applyHistoryStep(action, direction) {
    const data = action.data || {};
    const idOf = (race) => (race && typeof race.id === 'string' && race.id ? race.id : null);
    const indexOf = (id) => (id ? races.findIndex((race) => race && race.id === id) : -1);

    switch (action.type) {
        case 'ADD_RACE': {
            const id = idOf(data.race);
            const at = indexOf(id);
            if (direction === 'undo') {
                if (at === -1) return false;
                races.splice(at, 1);
            } else {
                if (!id || at !== -1) return false;
                races.push(data.race);
            }
            return true;
        }
        case 'DELETE_RACE': {
            const id = idOf(data.race);
            const at = indexOf(id);
            if (direction === 'undo') {
                if (!id || at !== -1) return false;
                // Back where it was when that slot still exists, else last.
                const hint = Number.isInteger(data.index) ? data.index : races.length;
                races.splice(Math.min(Math.max(hint, 0), races.length), 0, data.race);
            } else {
                if (at === -1) return false;
                races.splice(at, 1);
            }
            return true;
        }
        case 'EDIT_RACE': {
            const at = indexOf(idOf(data.originalRace));
            if (at === -1) return false;
            races[at] = direction === 'undo' ? data.originalRace : data.newRace;
            return true;
        }
        case 'CLEAR_DATA':
            // Restore from the snapshot the clear took (deep-copied by
            // saveAction); a redo empties the log again.
            races = direction === 'undo' ? JSON.parse(JSON.stringify(data.races)) : [];
            return true;
        default:
            return false;
    }
}

// Undo and redo share everything around the step itself. A step that no
// longer applies drops the stack (it describes a log this tab no longer
// holds). A refused write rolls the step back and leaves the history where it
// was; either way nothing throws out of the click handler, which used to
// happen after `races` and `historyPosition` had already moved.
function runHistoryStep(direction) {
    const position = direction === 'undo' ? historyPosition : historyPosition + 1;
    const action = actionHistory[position];
    if (!action) return;

    const before = races.slice();
    if (!applyHistoryStep(action, direction)) {
        resetActionHistory();
        showMessage(`Nothing ${direction === 'undo' ? 'undone' : 'redone'}: that race was changed in another tab or on another device.`, true);
        return;
    }
    if (!persistRaces()) {
        races = before;
        return;
    }

    historyPosition = direction === 'undo' ? position - 1 : position;
    updateDisplay();
    updateAchievements();
    updateUndoRedoButtons();
    if (typeof updateClearButtonState === 'function') updateClearButtonState();
    showMessage(direction === 'undo' ? 'Action undone' : 'Action redone');
}

function undoLastAction() {
    if (historyPosition < 0) return;
    runHistoryStep('undo');
}

function redoLastAction() {
    if (historyPosition >= actionHistory.length - 1) return;
    runHistoryStep('redo');
}
