// Quick Add Race Widget Functionality

let quickRaceOpen = false;

function toggleQuickRaceWidget() {
    const form = document.getElementById('quick-race-form');
    const fab = document.getElementById('fab-button');
    
    if (quickRaceOpen) {
        closeQuickRaceWidget();
    } else {
        openQuickRaceWidget();
    }
}

function openQuickRaceWidget() {
    const form = document.getElementById('quick-race-form');
    const fab = document.getElementById('fab-button');
    
    // Close other dropdowns first
    if (typeof closeAllDropdowns === 'function') {
        closeAllDropdowns();
    }
    
    // Generate player inputs
    generateQuickPlayerInputs();
    
    // Update session info
    updateSessionInfo();
    
    // Show form with animation
    form.style.display = 'block';
    setTimeout(() => {
        form.classList.add('open');
    }, 10);
    
    // Update FAB appearance
    fab.innerHTML = '×';
    fab.style.background = 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)';
    
    quickRaceOpen = true;
    
    // Focus first input
    setTimeout(() => {
        const firstInput = form.querySelector('.quick-position-input');
        if (firstInput) firstInput.focus();
    }, 300);
}

function closeQuickRaceWidget() {
    const form = document.getElementById('quick-race-form');
    const fab = document.getElementById('fab-button');
    
    // Hide form with animation
    form.classList.remove('open');
    setTimeout(() => {
        form.style.display = 'none';
    }, 300);
    
    // Reset FAB appearance
    fab.innerHTML = '🏁 +';
    fab.style.background = 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)';
    
    quickRaceOpen = false;
}

function generateQuickPlayerInputs() {
    const container = document.getElementById('quick-race-inputs');
    container.innerHTML = '';
    
    // Get current player count and names
    const currentPlayers = getCurrentPlayerCount();
    
    for (let i = 1; i <= currentPlayers; i++) {
        const playerName = getPlayerName(`player${i}`) || `Player ${i}`;
        
        const inputDiv = document.createElement('div');
        inputDiv.className = 'quick-player-input';
        
        inputDiv.innerHTML = `
            <label class="quick-player-label">${playerName.length > 8 ? playerName.substring(0, 8) + '...' : playerName}:</label>
            <input type="number" 
                   class="quick-position-input" 
                   id="quick-player${i}" 
                   min="${MIN_POSITIONS}" 
                   max="${MAX_POSITIONS}" 
                   placeholder="${MIN_POSITIONS}-${MAX_POSITIONS}"
                   onkeypress="handleQuickInputEnter(event, ${i})"
                   oninput="validateQuickInput(this)">
        `;
        
        container.appendChild(inputDiv);
    }
}

function handleQuickInputEnter(event, playerIndex) {
    if (event.key === 'Enter') {
        const currentPlayers = getCurrentPlayerCount();
        if (playerIndex < currentPlayers) {
            // Focus next input
            const nextInput = document.getElementById(`quick-player${playerIndex + 1}`);
            if (nextInput) nextInput.focus();
        } else {
            // Save race if this is the last input
            saveQuickRace();
        }
    }
}

function validateQuickInput(input) {
    const value = parseInt(input.value);
    if (value < 1 || value > 24 || isNaN(value)) {
        input.style.borderColor = '#ef4444';
    } else {
        input.style.borderColor = '#10b981';
    }
}

function saveQuickRace() {
    const currentPlayers = getCurrentPlayerCount();
    const positions = {};
    let allValid = true;
    
    // Collect and validate all positions
    for (let i = 1; i <= currentPlayers; i++) {
        const input = document.getElementById(`quick-player${i}`);
        const value = parseInt(input.value);
        
        if (!value || value < MIN_POSITIONS || value > MAX_POSITIONS) {
            allValid = false;
            input.style.borderColor = '#ef4444';
            input.focus();
            break;
        }
        
        positions[`player${i}`] = value;
    }
    
    if (!allValid) {
        showMessage(`Please enter valid positions (${MIN_POSITIONS}-${MAX_POSITIONS}) for all players`, true);
        return;
    }
    
    // Use existing addRace functionality
    try {
        // Get current date or use today
        const dateInput = document.getElementById('date');
        const raceDate = dateInput && dateInput.value ? dateInput.value : new Date().toLocaleDateString('en-CA');
        
        // Create race object
        const race = {
            id: Date.now(),
            date: raceDate,
            timestamp: new Date().toLocaleTimeString('en-US', { hour12: false }),
            ...positions
        };
        
        // Add to races array (assuming it exists globally)
        if (typeof races !== 'undefined') {
            races.push(race);
            localStorage.setItem('marioKartRaces', JSON.stringify(races));
            
            // Update displays
            if (typeof updateAchievements === 'function') updateAchievements();
            if (typeof updateRaceHistory === 'function') updateRaceHistory();
            if (typeof updateStatistics === 'function') updateStatistics();
            
            // Show success message
            const raceCount = races.length;
            showMessage(`Race #${raceCount} saved successfully! 🏁`);
            
            // Clear inputs
            clearQuickInputs();
            
            // Update session info
            updateSessionInfo();
            
            // Close widget after short delay
            setTimeout(() => {
                closeQuickRaceWidget();
            }, 1500);
            
        } else {
            throw new Error('Race storage not available');
        }
        
    } catch (error) {
        console.error('Error saving quick race:', error);
        showMessage('Error saving race. Please try again.', true);
    }
}

function clearQuickInputs() {
    const inputs = document.querySelectorAll('.quick-position-input');
    inputs.forEach(input => {
        input.value = '';
        input.style.borderColor = '#e5e7eb';
    });
}

function updateSessionInfo() {
    const info = document.getElementById('session-info');
    if (!info) return;
    
    const today = new Date().toLocaleDateString('en-CA');
    const todayRaces = races ? races.filter(race => race.date === today).length : 0;
    const totalRaces = races ? races.length : 0;
    
    info.textContent = `Today: ${todayRaces} races • Total: ${totalRaces}`;
}

// Helper functions
function getCurrentPlayerCount() {
    const select = document.getElementById('player-count');
    return select ? parseInt(select.value) : 3;
}

function getPlayerName(playerId) {
    // Use centralized manager first
    if (window.PlayerNameManager) {
        return window.PlayerNameManager.get(playerId);
    }
    // Fallback to DOM
    const input = document.getElementById(`${playerId}-name`);
    return input ? input.value : '';
}

// Close quick race widget when clicking outside
document.addEventListener('click', function(event) {
    if (!quickRaceOpen) return;
    
    const widget = document.querySelector('.floating-race-widget');
    if (widget && !widget.contains(event.target)) {
        closeQuickRaceWidget();
    }
});

// Show success message (fallback if showMessage not available)
function showMessage(message, isError = false) {
    if (typeof window.showMessage === 'function') {
        window.showMessage(message, isError);
        return;
    }
    
    // Fallback: simple alert
    if (isError) {
        alert('Error: ' + message);
    } else {
        // Create temporary toast
        const toast = document.createElement('div');
        toast.style.cssText = `
            position: fixed;
            top: 2rem;
            right: 2rem;
            background: #10b981;
            color: white;
            padding: 1rem 1.5rem;
            border-radius: 0.5rem;
            box-shadow: 0 4px 12px rgba(0,0,0,0.15);
            z-index: 10000;
            font-weight: 600;
            animation: slideIn 0.3s ease;
        `;
        toast.textContent = message;
        document.body.appendChild(toast);
        
        setTimeout(() => {
            toast.style.animation = 'slideOut 0.3s ease';
            setTimeout(() => document.body.removeChild(toast), 300);
        }, 3000);
    }
}

// Make functions globally available
window.toggleQuickRaceWidget = toggleQuickRaceWidget;
window.closeQuickRaceWidget = closeQuickRaceWidget;
window.saveQuickRace = saveQuickRace;