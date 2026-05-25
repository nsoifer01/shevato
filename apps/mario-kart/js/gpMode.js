// GP Bulk-Log Mode — logs 4 races in one form as a single undoable batch

let gpModeOpen = false;
const GP_RACE_COUNT = 4;

function toggleGPMode() {
    const panel = document.getElementById('gp-mode-panel');
    if (!panel) return;

    if (gpModeOpen) {
        closeGPMode();
    } else {
        openGPMode();
    }
}

function openGPMode() {
    const panel = document.getElementById('gp-mode-panel');
    const btn = document.getElementById('gp-mode-btn');
    if (!panel) return;

    generateGPRows();
    panel.style.display = 'block';
    setTimeout(() => panel.classList.add('open'), 10);
    if (btn) btn.classList.add('active');
    gpModeOpen = true;
}

function closeGPMode() {
    const panel = document.getElementById('gp-mode-panel');
    const btn = document.getElementById('gp-mode-btn');
    if (!panel) return;

    panel.classList.remove('open');
    setTimeout(() => { panel.style.display = 'none'; }, 300);
    if (btn) btn.classList.remove('active');
    gpModeOpen = false;
}

function generateGPRows() {
    const container = document.getElementById('gp-rows-container');
    if (!container) return;

    const gameVer = window.getCurrentGameVersion ? window.getCurrentGameVersion() : 'mk8d';
    const tracksList = window.getTracksFlatForVersion ? window.getTracksFlatForVersion(gameVer) : [];
    const modes = window.RACE_MODES || ['Items', 'No Items', '200cc'];
    const minPos = window.MIN_POSITIONS || 1;
    const maxPos = window.MAX_POSITIONS || 12;

    let html = `<datalist id="gp-track-datalist">${tracksList.map(t => `<option value="${window.escapeHtml ? window.escapeHtml(t) : t}">`).join('')}</datalist>`;

    for (let i = 0; i < GP_RACE_COUNT; i++) {
        const playerInputs = players.map(p => {
            const name = window.PlayerNameManager ? window.PlayerNameManager.get(p) : p;
            const truncated = name.length > 8 ? name.substring(0, 7) + '…' : name;
            return `<div class="gp-player-cell">
                <label class="gp-player-label">${window.escapeHtml ? window.escapeHtml(truncated) : truncated}</label>
                <input type="number" class="gp-position-input" id="gp-r${i}-${p}"
                    min="${minPos}" max="${maxPos}" placeholder="${minPos}-${maxPos}">
            </div>`;
        }).join('');

        html += `<div class="gp-race-row" id="gp-row-${i}">
            <div class="gp-race-header">
                <span class="gp-race-label">Race ${i + 1}</span>
                <select class="gp-mode-select" id="gp-r${i}-mode">
                    ${modes.map(m => `<option value="${m}">${m}</option>`).join('')}
                </select>
                <input type="text" class="gp-track-input" id="gp-r${i}-track"
                    list="gp-track-datalist" placeholder="Track (opt.)">
            </div>
            <div class="gp-players-row">${playerInputs}</div>
        </div>`;
    }

    container.innerHTML = html;
}

function saveGPBatch() {
    const sidebarDateInput = document.getElementById('sidebar-date-input');
    const mainDateInput = document.getElementById('date');
    const raceDate = (sidebarDateInput && sidebarDateInput.value)
        ? sidebarDateInput.value
        : new Date().toLocaleDateString('en-CA');

    if (mainDateInput) mainDateInput.value = raceDate;

    const now = new Date();
    const gpErrors = document.getElementById('gp-errors');
    if (gpErrors) { gpErrors.textContent = ''; gpErrors.style.display = 'none'; }

    const minPos = window.MIN_POSITIONS || 1;
    const maxPos = window.MAX_POSITIONS || 12;

    const newRaces = [];

    for (let i = 0; i < GP_RACE_COUNT; i++) {
        // Collect positions for this row
        const rowPositions = {};
        let rowHasAny = false;
        let rowValid = true;

        players.forEach(p => {
            const inp = document.getElementById(`gp-r${i}-${p}`);
            if (!inp || !inp.value.trim()) {
                rowPositions[p] = null;
                return;
            }
            const pos = parseInt(inp.value);
            if (isNaN(pos) || pos < minPos || pos > maxPos) {
                rowValid = false;
                return;
            }
            rowPositions[p] = pos;
            rowHasAny = true;
        });

        if (!rowHasAny) continue; // Skip empty rows

        if (!rowValid) {
            showGPError(`Race ${i + 1}: positions must be between ${minPos} and ${maxPos}`);
            return;
        }

        // Check duplicates
        const vals = Object.values(rowPositions).filter(v => v !== null);
        if (vals.length !== new Set(vals).size) {
            showGPError(`Race ${i + 1}: players cannot share a position`);
            return;
        }

        // Check min players
        const minPlayers = playerCount === 1 ? 1 : 2;
        if (vals.length < minPlayers) {
            showGPError(`Race ${i + 1}: at least ${minPlayers} player${minPlayers > 1 ? 's' : ''} required`);
            return;
        }

        // Build timestamp (sequential, 1 second apart per race)
        const raceTime = new Date(now.getTime() + i * 1000);
        const localTime = raceTime.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
        const tzAbbr = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(raceTime).find(p => p.type === 'timeZoneName')?.value || '';

        const modeEl = document.getElementById(`gp-r${i}-mode`);
        const trackEl = document.getElementById(`gp-r${i}-track`);
        const mode = modeEl ? modeEl.value : 'Items';
        const track = trackEl ? trackEl.value.trim() : '';

        const raceObj = {
            date: raceDate,
            timestamp: `${localTime} ${tzAbbr}`.trim()
        };
        if (mode && mode !== (window.DEFAULT_RACE_MODE || 'Items')) raceObj.mode = mode;
        if (track) raceObj.track = track;

        players.forEach(p => { raceObj[p] = rowPositions[p]; });
        ['player1','player2','player3','player4'].forEach(p => {
            if (!(p in raceObj)) raceObj[p] = null;
        });

        newRaces.push(raceObj);
    }

    if (newRaces.length === 0) {
        showGPError('Please fill in at least one race row');
        return;
    }

    // Save all races as a batch — single undoable action
    newRaces.forEach(r => races.push(r));

    saveAction('GP_BATCH', { races: newRaces, count: newRaces.length });

    try {
        const storageKey = window.getStorageKey ? window.getStorageKey('Races') : 'marioKartRaces';
        localStorage.setItem(storageKey, JSON.stringify(races));
    } catch (e) {
        console.error('Error saving GP batch:', e);
    }

    updateDisplay();
    updateAchievements();
    updateClearButtonState();
    showMessage(`GP saved: ${newRaces.length} race${newRaces.length > 1 ? 's' : ''} added`);
    closeGPMode();
}

function showGPError(msg) {
    const el = document.getElementById('gp-errors');
    if (el) { el.textContent = msg; el.style.display = 'block'; }
}

// GP_BATCH is handled natively in undoRedo.js

window.toggleGPMode = toggleGPMode;
window.openGPMode = openGPMode;
window.closeGPMode = closeGPMode;
window.saveGPBatch = saveGPBatch;
