let currentView = 'achievements';
let sortColumn = null;
let sortDirection = 'asc';

function toggleDateWidget(event) {
    // Prevent default if called from keyboard event
    if (event && event.type === 'keydown') {
        event.preventDefault();
    }

    const dropdown = document.getElementById('calendar-dropdown');
    const dateInput = document.getElementById('date');

    // Get the button that was clicked (could be original or sidebar)
    let dateButton = event && event.currentTarget ? event.currentTarget : null;
    if (!dateButton) {
        // Try to find the date button (original or sidebar)
        dateButton = document.getElementById('date-button') || document.getElementById('date-button-sidebar');
    }

    if (!dropdown || !dateButton || !dateInput) {
        console.error('Calendar dropdown elements not found');
        return;
    }

    const isOpen = dropdown.classList.contains('open');

    if (isOpen) {
        dropdown.classList.remove('open');
        dateButton.setAttribute('aria-expanded', 'false');
        // Also update the other button if it exists
        const otherButton = dateButton.id === 'date-button' ?
            document.getElementById('date-button-sidebar') :
            document.getElementById('date-button');
        if (otherButton) {
            otherButton.setAttribute('aria-expanded', 'false');
        }
    } else {
        // Close other dropdowns first
        closeAllDropdowns();

        // Position the dropdown relative to the button that was clicked
        const rect = dateButton.getBoundingClientRect();
        dropdown.style.position = 'fixed';
        dropdown.style.top = (rect.bottom + 5) + 'px';
        dropdown.style.left = rect.left + 'px';

        // Add the open class
        dropdown.classList.add('open');
        dateButton.setAttribute('aria-expanded', 'true');
        // Also update the other button if it exists
        const otherButton = dateButton.id === 'date-button' ?
            document.getElementById('date-button-sidebar') :
            document.getElementById('date-button');
        if (otherButton) {
            otherButton.setAttribute('aria-expanded', 'true');
        }

        // Add a flag to prevent immediate closing
        dropdown.setAttribute('data-just-opened', 'true');

        // Remove the flag after a short delay
        setTimeout(() => {
            dropdown.removeAttribute('data-just-opened');
        }, 100);
    }
}

function closeAllDropdowns() {
    const dropdowns = document.querySelectorAll('.widget-dropdown, .calendar-dropdown');
    dropdowns.forEach(dropdown => {
        dropdown.classList.remove('open');
    });

    // Also update aria-expanded for date buttons if calendar is closing
    const dateButton = document.getElementById('date-button');
    const dateButtonSidebar = document.getElementById('date-button-sidebar');
    if (dateButton) {
        dateButton.setAttribute('aria-expanded', 'false');
    }
    if (dateButtonSidebar) {
        dateButtonSidebar.setAttribute('aria-expanded', 'false');
    }
}

// Make functions available globally
window.closeAllDropdowns = closeAllDropdowns;
window.toggleDateWidget = toggleDateWidget;

// Sidebar date functionality
let selectedRaceDate = null;

function initializeSidebarDate() {
    // Get today's date in user's timezone
    const today = new Date();
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const day = String(today.getDate()).padStart(2, '0');
    const todayStr = `${year}-${month}-${day}`;
    
    // Set the date input value to today
    const dateInput = document.getElementById('date');
    const sidebarDateInput = document.getElementById('sidebar-date-input');
    
    if (dateInput) {
        dateInput.value = todayStr;
    }
    if (sidebarDateInput) {
        sidebarDateInput.value = todayStr;
    }
    
    // Update the button text
    updateSidebarDateDisplay(todayStr);
    
    // Set the selected race date
    selectedRaceDate = todayStr;
}

// No longer needed - calendar opens directly on icon click

function updateSidebarDate() {
    const dateInput = document.getElementById('sidebar-date-input');
    const mainDateInput = document.getElementById('date');
    
    if (!dateInput) return;
    
    const selectedDate = dateInput.value;
    if (!selectedDate) return;
    
    // Update the main date input
    if (mainDateInput) {
        mainDateInput.value = selectedDate;
    }
    
    // Update the button display
    updateSidebarDateDisplay(selectedDate);
    
    // Store the selected date
    selectedRaceDate = selectedDate;
    
    // Show feedback
    showMessage(`Race date set to ${formatDateForDisplay(selectedDate)}`);
}

function setSidebarDateToday() {
    const today = new Date();
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const day = String(today.getDate()).padStart(2, '0');
    const todayStr = `${year}-${month}-${day}`;
    
    const sidebarDateInput = document.getElementById('sidebar-date-input');
    const mainDateInput = document.getElementById('date');
    
    if (sidebarDateInput) {
        sidebarDateInput.value = todayStr;
    }
    if (mainDateInput) {
        mainDateInput.value = todayStr;
    }
    
    updateSidebarDate();
}

function updateSidebarDateDisplay(dateStr) {
    const dateText = document.getElementById('sidebar-date-text');
    const todayBtn = document.querySelector('.sidebar-date-today-btn');
    if (!dateText) return;
    
    // Check if it's today
    const today = new Date();
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const day = String(today.getDate()).padStart(2, '0');
    const todayStr = `${year}-${month}-${day}`;
    
    if (dateStr === todayStr) {
        dateText.textContent = 'Today';
        // Hide the "Set to Today" button when it's already today
        if (todayBtn) {
            todayBtn.classList.add('hidden');
        }
    } else {
        dateText.textContent = formatDateForDisplay(dateStr);
        // Show the "Set to Today" button when it's not today
        if (todayBtn) {
            todayBtn.classList.remove('hidden');
        }
    }
}

function formatDateForDisplay(dateStr) {
    if (!dateStr) return 'No date';
    
    try {
        const [year, month, day] = dateStr.split('-');
        const date = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
        
        // Format as "Jan 1, 2024" or similar
        const options = { year: 'numeric', month: 'short', day: 'numeric' };
        return date.toLocaleDateString('en-US', options);
    } catch (e) {
        return dateStr;
    }
}

// Export the new functions
window.updateSidebarDate = updateSidebarDate;
window.setSidebarDateToday = setSidebarDateToday;

// Sidebar Add Race functionality
let sidebarRaceFormOpen = false;

function toggleSidebarRaceForm() {
    const form = document.getElementById('sidebar-race-form');
    const button = document.getElementById('sidebar-add-race-btn');
    
    if (!form) return;
    
    if (sidebarRaceFormOpen) {
        closeSidebarRaceForm();
    } else {
        // Clear any previous errors
        hideSidebarError();
        
        // Generate player inputs
        generateSidebarRaceInputs();
        
        // Force a reflow to ensure the initial state is applied
        form.offsetHeight;
        
        // Show the form
        form.classList.add('open');
        button.classList.add('active');
        sidebarRaceFormOpen = true;
        
        // Focus first input after animation completes
        setTimeout(() => {
            const firstInput = form.querySelector('input[type="number"]');
            if (firstInput) firstInput.focus();
        }, 350);
    }
}

function closeSidebarRaceForm() {
    const form = document.getElementById('sidebar-race-form');
    const button = document.getElementById('sidebar-add-race-btn');
    const errorDiv = document.getElementById('sidebar-race-error');
    
    if (form) {
        form.classList.remove('open');
        if (button) button.classList.remove('active');
        sidebarRaceFormOpen = false;
        
        // Clear error message
        if (errorDiv) {
            errorDiv.classList.remove('show');
            errorDiv.textContent = '';
        }
        
        // Clear all inputs after animation
        setTimeout(() => {
            const inputs = form.querySelectorAll('input[type="number"]');
            inputs.forEach(input => input.value = '');
        }, 300);
    }
}

function showSidebarError(message) {
    const errorDiv = document.getElementById('sidebar-race-error');
    if (errorDiv) {
        errorDiv.textContent = message;
        errorDiv.classList.add('show');
        
        // Auto-hide after 5 seconds
        setTimeout(() => {
            errorDiv.classList.remove('show');
        }, 5000);
    }
}

function hideSidebarError() {
    const errorDiv = document.getElementById('sidebar-race-error');
    if (errorDiv) {
        errorDiv.classList.remove('show');
        errorDiv.textContent = '';
    }
}

function generateSidebarRaceInputs() {
    const container = document.getElementById('sidebar-race-inputs');
    if (!container) return;
    
    // Use the global playerCount variable which is dynamically updated
    const currentPlayerCount = playerCount;
    
    // Only show inputs for active players
    let html = '';
    for (let i = 0; i < currentPlayerCount; i++) {
        const player = players[i]; // Use the global players array
        const playerName = window.PlayerNameManager ? 
            window.PlayerNameManager.get(player) : 
            getPlayerName(player);
        
        html += `
            <div class="sidebar-player-input" data-player="${player}">
                <label for="sidebar-${player}">${playerName}</label>
                <div class="position-input-group">
                    <input 
                        type="number" 
                        id="sidebar-${player}" 
                        min="${window.MIN_POSITIONS}" 
                        max="${window.MAX_POSITIONS}" 
                        placeholder="${window.MIN_POSITIONS}-${window.MAX_POSITIONS}"
                        class="sidebar-position-input"
                        onchange="updatePositionPicker('${player}', this.value)"
                        oninput="updatePositionPicker('${player}', this.value)"
                    >
                    <button 
                        type="button" 
                        class="position-picker-toggle" 
                        onclick="togglePositionPicker('${player}')"
                        title="Choose position"
                    >
                        <span class="picker-icon">⊞</span>
                    </button>
                </div>
                <div class="position-picker" id="picker-${player}" style="display: none;">
                    <div class="picker-header">Select Position</div>
                    <div class="position-grid">
                        ${generatePositionButtons(player)}
                    </div>
                </div>
            </div>
        `;
    }
    
    container.innerHTML = html;
    
    // Add Enter key support for quick submission
    setTimeout(() => {
        const inputs = container.querySelectorAll('input[type="number"]');
        inputs.forEach((input, index) => {
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    if (index < inputs.length - 1) {
                        // Move to next input
                        inputs[index + 1].focus();
                    } else {
                        // Submit on last input
                        submitSidebarRace();
                    }
                } else if (e.key === 'Escape') {
                    closeSidebarRaceForm();
                }
            });
        });
        
        // Isolate position picker scrolling from sidebar
        const positionPickers = container.querySelectorAll('.position-picker');
        positionPickers.forEach(picker => {
            // Prevent wheel events from propagating to sidebar (passive listener)
            picker.addEventListener('wheel', (e) => {
                e.stopPropagation();
            }, { passive: true });
            
            // Prevent touch events from propagating on mobile
            picker.addEventListener('touchmove', (e) => {
                e.stopPropagation();
            }, { passive: true });
        });
    }, 100);
}

// Export for use in other modules
window.generateSidebarRaceInputs = generateSidebarRaceInputs;

function submitSidebarRace() {
    // Clear any previous errors
    hideSidebarError();
    
    // Get the date from the sidebar
    const sidebarDateInput = document.getElementById('sidebar-date-input');
    const mainDateInput = document.getElementById('date');
    
    // Ensure we have a date value
    const dateValue = sidebarDateInput?.value || new Date().toLocaleDateString('en-CA');
    
    if (!mainDateInput) {
        showSidebarError('Error: Date input not found');
        return;
    }
    
    mainDateInput.value = dateValue;
    
    // Collect and validate positions
    const positions = {};
    let hasAnyInput = false;
    
    // Collect positions for active players
    for (let i = 0; i < playerCount; i++) {
        const player = players[i];
        const sidebarInput = document.getElementById(`sidebar-${player}`);
        
        if (sidebarInput && sidebarInput.value) {
            const position = parseInt(sidebarInput.value);
            positions[player] = position;
            hasAnyInput = true;
        }
    }
    
    // Validation checks
    if (!hasAnyInput) {
        showSidebarError('Please enter at least one player position');
        return;
    }
    
    // Check minimum players
    const activePositions = Object.values(positions);
    const minPlayers = playerCount === 1 ? 1 : 2;
    
    if (activePositions.length < minPlayers) {
        showSidebarError(`At least ${minPlayers} player${minPlayers > 1 ? 's' : ''} must have positions`);
        return;
    }
    
    // Validate position range
    const invalidPositions = activePositions.filter(pos => pos < MIN_POSITIONS || pos > MAX_POSITIONS);
    if (invalidPositions.length > 0) {
        showSidebarError(`Positions must be between ${MIN_POSITIONS} and ${MAX_POSITIONS}`);
        return;
    }
    
    // Check for duplicates
    const uniquePositions = [...new Set(activePositions)];
    if (activePositions.length !== uniquePositions.length) {
        showSidebarError('Players cannot have the same position in a race');
        return;
    }
    
    // Set main form inputs
    for (let i = 0; i < playerCount; i++) {
        const player = players[i];
        const mainInput = document.getElementById(player);
        if (mainInput) {
            mainInput.value = positions[player] || '';
        }
    }
    
    // Clear inputs for inactive players
    const allPlayers = ['player1', 'player2', 'player3', 'player4'];
    for (let i = playerCount; i < 4; i++) {
        const mainInput = document.getElementById(allPlayers[i]);
        if (mainInput) mainInput.value = '';
    }
    
    // Store the original showMessage function
    const originalShowMessage = window.showMessage;
    let raceAdded = false;
    
    // Temporarily override showMessage to intercept messages
    window.showMessage = function(message, isError) {
        if (isError) {
            // Show error in sidebar form
            showSidebarError(message);
        } else if (message.includes('successfully')) {
            // Race was added successfully
            raceAdded = true;
            // Still show success message at top
            originalShowMessage(message, isError);
        }
    };
    
    // Call the existing addRace function
    try {
        if (typeof addRace === 'function') {
            addRace();
            
            // Only close if race was successfully added
            if (raceAdded) {
                closeSidebarRaceForm();
            }
        } else {
            showSidebarError('Error: addRace function not found');
        }
    } finally {
        // Restore original showMessage function
        window.showMessage = originalShowMessage;
    }
}

// Function to refresh sidebar race form when player count changes
function refreshSidebarRaceForm() {
    if (sidebarRaceFormOpen) {
        generateSidebarRaceInputs();
    }
}

// Position picker functions
function generatePositionButtons(player) {
    let buttons = '';
    for (let i = 1; i <= window.MAX_POSITIONS; i++) {
        buttons += `
            <button 
                type="button" 
                class="position-btn" 
                data-position="${i}"
                onclick="selectPosition('${player}', ${i})"
                title="Position ${i}"
            >
                ${i}
            </button>
        `;
    }
    return buttons;
}

function togglePositionPicker(player) {
    const picker = document.getElementById(`picker-${player}`);
    const allPickers = document.querySelectorAll('.position-picker');
    
    // Close all other pickers
    allPickers.forEach(p => {
        if (p.id !== `picker-${player}`) {
            p.style.display = 'none';
        }
    });
    
    // Toggle this picker
    if (picker) {
        const isOpen = picker.style.display === 'block';
        picker.style.display = isOpen ? 'none' : 'block';
        
        // Update selected button state
        if (!isOpen) {
            const input = document.getElementById(`sidebar-${player}`);
            if (input && input.value) {
                updatePickerSelection(player, input.value);
            }
        }
    }
}

function selectPosition(player, position) {
    // Set the input value
    const input = document.getElementById(`sidebar-${player}`);
    if (input) {
        input.value = position;
        // Trigger change event for any listeners
        input.dispatchEvent(new Event('change'));
    }
    
    // Update picker selection
    updatePickerSelection(player, position);
    
    // Close the picker
    const picker = document.getElementById(`picker-${player}`);
    if (picker) {
        setTimeout(() => {
            picker.style.display = 'none';
        }, 150);
    }
    
    // Clear error if any
    hideSidebarError();
}

function updatePositionPicker(player, value) {
    updatePickerSelection(player, value);
}

function updatePickerSelection(player, position) {
    const picker = document.getElementById(`picker-${player}`);
    if (!picker) return;
    
    // Remove all selected states
    const buttons = picker.querySelectorAll('.position-btn');
    buttons.forEach(btn => btn.classList.remove('selected'));
    
    // Add selected state to current position
    if (position && position >= 1 && position <= window.MAX_POSITIONS) {
        const selectedBtn = picker.querySelector(`[data-position="${position}"]`);
        if (selectedBtn) {
            selectedBtn.classList.add('selected');
        }
    }
}

// Export functions
window.toggleSidebarRaceForm = toggleSidebarRaceForm;
window.closeSidebarRaceForm = closeSidebarRaceForm;
window.submitSidebarRace = submitSidebarRace;
window.refreshSidebarRaceForm = refreshSidebarRaceForm;
window.togglePositionPicker = togglePositionPicker;
window.selectPosition = selectPosition;
window.updatePositionPicker = updatePositionPicker;

// Close dropdowns when clicking outside
document.addEventListener('click', function(event) {
    const mainContainer = document.querySelector('.container');
    const actionButtons = document.querySelector('.action-buttons');
    
    // No longer needed - calendar opens directly
    
    // Close position pickers if clicking outside
    const positionPickers = document.querySelectorAll('.position-picker');
    positionPickers.forEach(picker => {
        const playerDiv = picker.closest('.sidebar-player-input');
        if (playerDiv && !playerDiv.contains(event.target)) {
            picker.style.display = 'none';
        }
    });

    // If click is outside both the main container and action buttons, close all dropdowns
    const isOutsideMainContainer = mainContainer && !mainContainer.contains(event.target);
    const isOutsideActionButtons = actionButtons && !actionButtons.contains(event.target);

    if (isOutsideMainContainer && isOutsideActionButtons) {
        closeAllDropdowns();
    }
});

// Old position button functions removed - now using modern position picker in sidebar

function showMessage(message, isError = false) {
    // Create a message div
    const messageDiv = document.createElement('div');
    messageDiv.style.cssText = `
        position: fixed;
        top: 80px;
        left: 50%;
        transform: translateX(-50%);
        padding: 15px 30px;
        background: ${isError ? '#ef4444' : '#10b981'};
        color: white;
        border-radius: 8px;
        font-weight: 600;
        box-shadow: 0 4px 15px rgba(0, 0, 0, 0.2);
        z-index: 9999;
        animation: slideDown 0.3s ease;
    `;
    messageDiv.textContent = message;

    // Add animation
    const style = document.createElement('style');
    style.textContent = `
        @keyframes slideDown {
            from { transform: translate(-50%, -100%); opacity: 0; }
            to { transform: translate(-50%, 0); opacity: 1; }
        }
    `;
    document.head.appendChild(style);

    document.body.appendChild(messageDiv);

    // Remove after 3 seconds
    setTimeout(() => {
        messageDiv.remove();
        style.remove();
    }, 3000);
}


function toggleView(view) {
    // Get the input section reference once
    const inputSection = document.querySelector('.input-section');

    // If leaving achievements view, save the input-group BEFORE changing currentView
    if (currentView === 'achievements' && view !== 'achievements') {
        const inputGroup = document.querySelector('.input-group');
        if (inputGroup && inputSection && inputGroup.parentElement !== inputSection) {
            // Move input-group back to input-section for safekeeping
            inputSection.appendChild(inputGroup);
        }
    }

    // Now update currentView
    currentView = view;

    // Reset pagination when view changes
    if (window.GlobalPaginationManager) {
        window.GlobalPaginationManager.reset('mario-kart-races');
    }

    document.querySelectorAll('.toggle-btn').forEach(btn => {
        const isActive = btn.textContent.toLowerCase().includes(view);
        btn.classList.toggle('active', isActive);
        btn.setAttribute('aria-selected', isActive);
    });

    // Hide all bar containers by default (they'll be shown in achievements view)
    const barContainers = document.querySelectorAll('.bar-container');
    barContainers.forEach(container => container.style.display = 'none');

    // Hide the input section for all views (it's only used for holding elements)
    if (inputSection) {
        inputSection.style.display = 'none';
    }

    // Hide/show race history section based on view
    const raceHistorySection = document.querySelector('.race-history');
    if (raceHistorySection) {
        // Hide race history for help and guide views
        if (view === 'help' || view === 'guide') {
            raceHistorySection.style.display = 'none';
        } else {
            raceHistorySection.style.display = 'block';
        }
    }

    // For stats view, we don't need the input-group at all
    // The stats cards are generated separately in updateDisplay()

    // Gray out "Today" button when on activity view
    const todayButton = document.querySelector('.filter-btn[onclick*="today"]');
    if (todayButton) {
        if (view === 'activity') {
            todayButton.style.background = '#6b7280';
            todayButton.style.cursor = 'not-allowed';
            todayButton.disabled = true;

            // If currently on today filter and switching to activity view, switch to all time filter
            if (currentDateFilter === 'today') {
                setDateFilter('all');
                return; // setDateFilter will call updateDisplay, so we return early
            }
        } else {
            todayButton.style.background = '';
            todayButton.style.cursor = '';
            todayButton.disabled = false;
        }
    }

    updateDisplay();
}


function createH2HView(raceData = null) {
    if (raceData === null) {
        raceData = getFilteredRaces();
    }

    const statsDisplay = document.getElementById('stats-display');

    if (raceData.length === 0 || playerCount <= 1) {
        statsDisplay.innerHTML = `
            <div class="no-data-message">
                <div style="text-align: center; padding: 60px 20px; color: #718096;">
                    <h3 style="font-size: 1.5em; margin-bottom: 10px;">
                        ${playerCount <= 1 ? 'Head-to-Head requires at least 2 players' : 'No race data available'}
                    </h3>
                    <p>${playerCount <= 1 ? 'Add more players to see head-to-head statistics!' : 'Add some races to see head-to-head comparisons!'}</p>
                </div>
            </div>
        `;
        return;
    }

    const stats = calculateStats(raceData);

    statsDisplay.innerHTML = `
        <div class="h2h-container">
            <div class="stat-card h2h-card">
                <div class="h2h-daily-breakdown">
                    <div class="stat-title">Global Head to Head</div>
                    ${generateH2HTable(stats)}
                </div>

                <div class="h2h-daily-breakdown">
                    <div class="stat-title">Daily Head to Head</div>
                    ${generateDailyH2HTable(stats)}
                </div>
            </div>
        </div>
    `;

    // Update player icons
    if (window.updateAllPlayerIcons) {
        setTimeout(() => {
            window.updateAllPlayerIcons();
        }, 100);
    }
}

function createGuideView() {
    const statsDisplay = document.getElementById('stats-display');

    statsDisplay.innerHTML = `
        <div class="guide-container">
            <div class="bars-legend visualization-guide-main">
                <h3>📊 Visualization Guide</h3>
                <div class="viz-guide-grid">
                    <div class="viz-guide-card">
                        <h4>🌟 Achievements</h4>
                        <p>Compare racing milestones with friends</p>
                        <p class="viz-tip tips-text">💡 <span class="viz-color-green">Best (green)</span> • <span class="viz-color-yellow">2nd (yellow, 3+ players)</span> • <span class="viz-color-red">Worst (red)</span> • <span class="viz-color-gray">Ties (gray)</span></p>
                    </div>
                    <div class="viz-guide-card">
                        <h4>🌡️ Position Heat Map</h4>
                        <p>Percentage breakdown by finishing ranges</p>
                        <p class="viz-tip tips-text" id="position-heat-tip">💡 <span class="viz-color-green tier-range-numbers">Loading...</span></p>
                    </div>
                    <div class="viz-guide-card">
                        <h4>🏁 Recent Streak</h4>
                        <p>Your last 10 races at a glance (left to right)</p>
                        <p class="viz-tip tips-text" id="recent-streak-tip">💡 Shows finishing positions with gradient colors: <span class="viz-color-green">1st (green)</span> to <span class="viz-color-red" id="max-position-text">Loading...</span></p>
                    </div>
                    <div class="viz-guide-card">
                        <h4>🎯 Sweet Spots</h4>
                        <p>Color transparency shows finishing frequency</p>
                        <div class="viz-tip viz-tip-content tips-text">
                            <span>💡 Frequency:</span>
                            <span class="frequency-gradient alternate-theme hidden">
                                <span class="viz-color-indicator frequency-low">Low</span>
                                <span class="viz-color-indicator frequency-medium">Medium</span>
                                <span class="viz-color-indicator frequency-high">High</span>
                            </span>
                            <span class="frequency-gradient theme-variant">
                                <span class="viz-color-indicator frequency-low">Low</span>
                                <span class="viz-color-indicator frequency-medium">Medium</span>
                                <span class="viz-color-indicator frequency-high">High</span>
                            </span>
                        </div>
                    </div>
                </div>

                <section class="achievement-details" aria-labelledby="achievement-targets-heading">
                    <h4 id="achievement-targets-heading">📊 Achievement Targets</h4>
                    <div class="achievement-expanded-grid" role="list">
                        <article class="achievement-expanded-item" role="listitem" tabindex="0" aria-label="Win Streak achievement">
                            <span class="achievement-icon-big" aria-hidden="true">🏆</span>
                            <div class="achievement-info">
                                <strong class="legend-title">Win Streak</strong>
                                <small>Consecutive 1st place finishes</small>
                            </div>
                        </article>
                        <article class="achievement-expanded-item" role="listitem" tabindex="0" aria-label="Hot Streak achievement">
                            <span class="achievement-icon-big" aria-hidden="true">🔥</span>
                            <div class="achievement-info">
                                <strong class="legend-title">Hot Streak</strong>
                                <small>Consecutive podium finishes</small>
                            </div>
                        </article>
                        <article class="achievement-expanded-item" role="listitem" tabindex="0" aria-label="Clutch Master achievement">
                            <span class="achievement-icon-big" aria-hidden="true">💪</span>
                            <div class="achievement-info">
                                <strong class="legend-title">Clutch Master</strong>
                                <small>Consecutive races finishing better than average</small>
                            </div>
                        </article>
                        <article class="achievement-expanded-item" role="listitem" tabindex="0" aria-label="Momentum Builder achievement">
                            <span class="achievement-icon-big" aria-hidden="true">🚀</span>
                            <div class="achievement-info">
                                <strong class="legend-title">Momentum Builder</strong>
                                <small>Consecutive races with improving positions</small>
                            </div>
                        </article>
                        <article class="achievement-expanded-item" role="listitem" tabindex="0" aria-label="Perfect Day achievement">
                            <span class="achievement-icon-big" aria-hidden="true">📅</span>
                            <div class="achievement-info">
                                <strong class="legend-title">Perfect Day</strong>
                                <small id="perfect-day-description">All races in a day were good finishes</small>
                            </div>
                        </article>
                    </div>
                </section>
            </div>
        </div>
    `;

    // Theme styling
    const lightGradients = document.querySelectorAll('.frequency-gradient.alternate-theme');
    const darkGradients = document.querySelectorAll('.frequency-gradient.theme-variant');

    lightGradients.forEach(el => el.style.display = 'none');
    darkGradients.forEach(el => el.style.display = 'inline-flex');
}

function getPositionClass(position) {
    // Use dynamic position ranges from achievements.js
    const ranges = window.getPositionRanges ? window.getPositionRanges() : getDefaultPositionRanges();
    
    // Special handling for podium positions
    if (position === 1) return 'pos-1';
    if (position === 2) return 'pos-2';
    if (position === 3) return 'pos-3';
    
    // Find the range this position belongs to
    for (const range of ranges) {
        const [min, max] = range.range;
        if (position >= min && position <= max) {
            return `pos-${range.label.replace('-', '-')}`.replace(/\s/g, '-');
        }
    }
    
    // Fallback to last range
    return `pos-${ranges[ranges.length - 1].label.replace('-', '-')}`.replace(/\s/g, '-');
}

function getDefaultPositionRanges() {
    // Fallback ranges for MK World
    return [
        { label: '1-6', range: [1, 6] },
        { label: '7-12', range: [7, 12] },
        { label: '13-18', range: [13, 18] },
        { label: '19-24', range: [19, 24] }
    ];
}

// Update dynamic UI text based on current game version
function updateDynamicUIText() {
    // Update position heat map tip
    const heatTip = document.getElementById('position-heat-tip');
    if (heatTip && window.getPositionRanges) {
        const ranges = window.getPositionRanges();
        let rangeText = '';
        ranges.forEach((range, index) => {
            const colorClass = index === 0 ? 'viz-color-green' : 
                             index === 1 ? 'viz-color-yellow' : 
                             'viz-color-red';
            rangeText += `<span class="${colorClass} tier-range-numbers">${range.label}</span>`;
            if (index < ranges.length - 1) rangeText += ' • ';
        });
        heatTip.innerHTML = `💡 ${rangeText}`;
    }
    
    // Update recent streak tip
    const maxPosText = document.getElementById('max-position-text');
    if (maxPosText && window.MAX_POSITIONS) {
        maxPosText.textContent = `${window.MAX_POSITIONS}th (red)`;
    }
    
    // Update perfect day description
    const perfectDayDesc = document.getElementById('perfect-day-description');
    if (perfectDayDesc && window.getGoodFinishThreshold) {
        const threshold = window.getGoodFinishThreshold();
        perfectDayDesc.textContent = `All races in a day were top-${threshold} finishes`;
    }
    
    // Update position ranges help text
    const positionRangesHelp = document.getElementById('position-ranges-help');
    if (positionRangesHelp && window.getPositionRanges) {
        const ranges = window.getPositionRanges();
        let helpHTML = '<ul role="list">';
        ranges.forEach((range, index) => {
            const tierName = index === 0 ? 'Top tier' : 
                           index === 1 ? 'Mid-tier' : 
                           index === ranges.length - 1 ? 'Bottom tier' : 'Lower tier';
            helpHTML += `<li><strong>${range.label}:</strong> ${tierName} finishes</li>`;
        });
        helpHTML += '</ul>';
        positionRangesHelp.innerHTML = helpHTML;
    }
}

// Make function available globally
window.updateDynamicUIText = updateDynamicUIText;

function getRelativePositionClass(playerPosition, allPositions) {
    // Filter out null positions and sort to get relative rankings
    const validPositions = allPositions.filter(pos => pos !== null).sort((a, b) => a - b);

    if (validPositions.length <= 1) return 'best'; // Only one player or less

    const playerRank = validPositions.indexOf(playerPosition);

    if (playerRank === 0) return 'best'; // Best position (green)
    if (playerRank === validPositions.length - 1) return 'worst'; // Worst position (red)
    return 'second'; // Middle position (yellow)
}

function sortTable(column) {
    if (sortColumn === column) {
        sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
    } else {
        sortColumn = column;
        sortDirection = 'asc';
    }

    // Reset pagination when sorting changes
    if (window.GlobalPaginationManager) {
        window.GlobalPaginationManager.reset('mario-kart-races');
    }

    // For trends, activity, and analysis views, only update race history table
    if (currentView === 'trends' || currentView === 'activity' || currentView === 'analysis') {
        let filteredRaces = getFilteredRaces();
        // Apply sorting
        if (sortColumn) {
            filteredRaces = [...filteredRaces].sort((a, b) => {
                let aVal = a[sortColumn];
                let bVal = b[sortColumn];

                // Handle null values
                if (aVal === null && bVal === null) return 0;
                if (aVal === null) return sortDirection === 'asc' ? 1 : -1;
                if (bVal === null) return sortDirection === 'asc' ? -1 : 1;

                // Handle date sorting (including timestamp within same day)
                if (sortColumn === 'date') {
                    // Create full datetime for accurate sorting
                    const aDateTime = new Date(a.date + (a.timestamp ? ' ' + a.timestamp : ''));
                    const bDateTime = new Date(b.date + (b.timestamp ? ' ' + b.timestamp : ''));
                    aVal = aDateTime;
                    bVal = bDateTime;
                }

                if (aVal < bVal) return sortDirection === 'asc' ? -1 : 1;
                if (aVal > bVal) return sortDirection === 'asc' ? 1 : -1;
                return 0;
            });
        }
        updateRaceHistoryTable(filteredRaces);
    } else {
        // For stats view, do full update
        updateDisplay();
    }
}

function updateHistoryTableHeaders() {
    const headerRow = document.querySelector('#history-table thead tr');
    if (!headerRow) return;

    // Generate dynamic headers
    const playerHeaders = players.map(player =>
        `<th style="cursor: pointer;" onclick="sortTable('${player}')" tabindex="0" onkeydown="if(event.key==='Enter'||event.key===' ')sortTable('${player}')" aria-label="Sort by ${window.PlayerNameManager ? window.PlayerNameManager.get(player) : getPlayerName(player)}'s position">${window.PlayerNameManager ? window.PlayerNameManager.get(player) : getPlayerName(player)} ↕</th>`
    ).join('');

    headerRow.innerHTML = `
        <th>Race #</th>
        <th style="cursor: pointer;" onclick="sortTable('date')" tabindex="0" onkeydown="if(event.key==='Enter'||event.key===' ')sortTable('date')" aria-label="Sort by date">Date ↕</th>
        ${playerHeaders}
        <th>Action</th>
    `;
}

function updateRaceHistoryTable(filteredRaces) {
    // Get the race history section element
    const raceHistorySection = document.querySelector('.race-history');

    // Hide the entire race history section if no races OR if on help/guide views
    if (filteredRaces.length === 0 || currentView === 'help' || currentView === 'guide') {
        if (raceHistorySection) {
            raceHistorySection.style.display = 'none';
        }
        return;
    }

    // Show the race history section if there are races (and not on help/guide views)
    if (raceHistorySection) {
        raceHistorySection.style.display = 'block';
    }

    // Reverse races to show latest first
    const reversedRaces = filteredRaces.slice().reverse();

    // Get paginated subset if pagination is available
    const racesToDisplay = window.GlobalPaginationManager
        ? window.GlobalPaginationManager.getPaginatedItems('mario-kart-races', reversedRaces)
        : reversedRaces;

    // Update history table
    const historyHtml = racesToDisplay.map((race) => {
        const positions = players.map(player => race[player]).filter(pos => pos !== null);
        // Calculate race number based on original position in filtered races
        const originalIndex = filteredRaces.indexOf(race);
        const raceNumber = originalIndex + 1;
        const playerCells = players.map(player => {
            const position = race[player];
            return position !== null
                ? `<td><span class="position-cell ${getRelativePositionClass(position, positions)}">${position}</span></td>`
                : '<td><span style="color: #718096;">—</span></td>';
        }).join('');

        return `
        <tr>
            <td>${raceNumber}</td>
            <td>${race.date}${race.timestamp ? '<br><small>' + race.timestamp + '</small>' : ''}</td>
            ${playerCells}
            <td>
                <button class="edit-btn" onclick="editRace(${races.indexOf(race)})" title="Edit race">✏️</button>
                <button class="delete-btn" onclick="deleteRace(${races.indexOf(race)})" title="Delete race">🗑️</button>
            </td>
        </tr>
    `;
    }).join('');

    document.getElementById('history-body').innerHTML = historyHtml;

    // Add pagination controls if available
    if (window.GlobalPaginationManager && filteredRaces.length > 0) {
        const paginationHtml = window.GlobalPaginationManager.createPaginationControls('mario-kart-races');
        const tableContainer = document.querySelector('.table-container');

        // Remove existing pagination if any
        const existingPagination = document.querySelector('.pagination-container');
        if (existingPagination) {
            existingPagination.remove();
        }

        // Insert pagination after the table container
        tableContainer.insertAdjacentHTML('afterend', paginationHtml);
    }

    // Also update mobile cards (showing all races for mobile)
    updateMobileRaceCards(filteredRaces);

    // Update player icons in race history after rendering
    if (window.updateAllPlayerIcons) {
        setTimeout(() => {
            window.updateAllPlayerIcons();
        }, 100);
    }
}

function updateMobileRaceCards(filteredRaces) {
    // Get the race history section element
    const raceHistorySection = document.querySelector('.race-history');

    // Hide the entire race history section if no races OR if on help/guide views (mobile view)
    if (filteredRaces.length === 0 || currentView === 'help' || currentView === 'guide') {
        if (raceHistorySection) {
            raceHistorySection.style.display = 'none';
        }
        return;
    }

    // Show the race history section if there are races (and not on help/guide views)
    if (raceHistorySection) {
        raceHistorySection.style.display = 'block';
    }

    const mobileHtml = filteredRaces.slice().reverse().map((race, index) => {
        const positions = players.map(player => race[player]).filter(pos => pos !== null);
        const raceNumber = filteredRaces.length - index;

        const playerPositions = players.map(player => {
            const position = race[player];
            const playerName = window.PlayerNameManager ? window.PlayerNameManager.get(player) : getPlayerName(player);
            return position !== null
                ? `
                    <div class="position-item">
                        <span class="player-label">${playerName}:</span>
                        <span class="position-cell ${getRelativePositionClass(position, positions)}">${position}</span>
                    </div>
                `
                : '';
        }).filter(html => html !== '').join('');

        return `
        <div class="race-card">
            <div class="race-card-header">
                <span class="race-number">Race #${raceNumber}</span>
                <span class="race-date">${race.date}${race.timestamp ? ' ' + race.timestamp : ''}</span>
            </div>
            <div class="race-positions">
                ${playerPositions}
            </div>
            <div class="race-card-actions">
                <button class="edit-btn" onclick="editRace(${races.indexOf(race)})" title="Edit race">✏️</button>
                <button class="delete-btn" onclick="deleteRace(${races.indexOf(race)})" title="Delete race">🗑️</button>
            </div>
        </div>
    `;
    }).join('');

    const mobileHistory = document.getElementById('mobile-history');
    if (mobileHistory) {
        mobileHistory.innerHTML = mobileHtml;
    }
}

function updateDisplay() {
    // Update table headers for dynamic player count
    updateHistoryTableHeaders();

    let filteredRaces = getFilteredRaces();

    // Apply sorting if a column is selected
    if (sortColumn) {
        filteredRaces = [...filteredRaces].sort((a, b) => {
            let aVal = a[sortColumn];
            let bVal = b[sortColumn];

            // Handle null values
            if (aVal === null && bVal === null) return 0;
            if (aVal === null) return sortDirection === 'asc' ? 1 : -1;
            if (bVal === null) return sortDirection === 'asc' ? -1 : 1;

            // Handle date sorting (including timestamp within same day)
            if (sortColumn === 'date') {
                // Create full datetime for accurate sorting
                const aDateTime = new Date(a.date + (a.timestamp ? ' ' + a.timestamp : ''));
                const bDateTime = new Date(b.date + (b.timestamp ? ' ' + b.timestamp : ''));
                aVal = aDateTime;
                bVal = bDateTime;
            }

            if (aVal < bVal) return sortDirection === 'asc' ? -1 : 1;
            if (aVal > bVal) return sortDirection === 'asc' ? 1 : -1;
            return 0;
        });
    }

    // Always update race history table and achievement bars regardless of current view
    updateRaceHistoryTable(filteredRaces);
    updateAchievements(filteredRaces);

    // Handle different view types
    if (currentView === 'trends') {
        createTrendCharts(filteredRaces);
        return;
    } else if (currentView === 'activity') {
        createHeatmapView(filteredRaces);
        return;
    } else if (currentView === 'analysis') {
        createAnalysisView(filteredRaces);
        return;
    } else if (currentView === 'h2h') {
        createH2HView(filteredRaces);
        return;
    } else if (currentView === 'guide') {
        createGuideView();
        // Update dynamic text after creating the guide view
        if (window.updateDynamicUIText) {
            window.updateDynamicUIText();
        }
        return;
    } else if (currentView === 'achievements') {
        createAchievementsView(filteredRaces);
        return;
    } else if (currentView === 'help') {
        createHelpView();
        // Update dynamic text after creating the help view
        if (window.updateDynamicUIText) {
            window.updateDynamicUIText();
        }
        return;
    }

    const stats = calculateStats(filteredRaces);

    // Check if we have any races
    if (filteredRaces.length === 0) {
        document.getElementById('stats-display').innerHTML = `
            <div class="no-data-message">
                <div style="text-align: center; padding: 60px 20px; color: #718096;">
                    <h3 style="font-size: 1.5em; margin-bottom: 10px;">No race data available</h3>
                    <p>Add some races to see statistics!</p>
                </div>
            </div>
        `;

        document.getElementById('history-body').innerHTML =
            `<tr><td colspan="${players.length + 3}" style="text-align: center; padding: 40px; color: #718096;">No races recorded yet. Add your first race above!</td></tr>`;

        // Clear all visualization bars when no data
        clearAllVisualizationBars();
        return;
    }

    // Update stats display
    const statsHtml = `
        <div class="stats-container">
            <div class="stat-card">
                <div class="stat-title">Average Finish Position</div>
                <div class="stat-grid">
                    ${players.map(player => {
                        const avg = parseFloat(stats.averageFinish[player]);
                        const avgs = players.map(p => parseFloat(stats.averageFinish[p]) || '-');
                        return `
                            <div class="stat-item ${getStatClass(avg || '-', avgs)}">
                                <div class="player-name">${window.PlayerNameManager ? window.PlayerNameManager.get(player) : getPlayerName(player)}</div>
                                <div class="player-value">${avg || '-'}</div>
                            </div>
                        `;
                    }).join('')}
                </div>
            </div>

            <div class="stat-card">
                <div class="stat-title">First Place Finishes</div>
                <div class="stat-grid">
                    ${players.map(player => {
                        const wins = stats.firstPlace[player];
                        const played = stats.racesPlayed[player];
                        const winRate = played > 0 ? (wins / played) * 100 : 0;
                        const winRateDisplay = played > 0 ? formatDecimal(winRate) : '-';
                        const allWinRates = players.map(p => {
                            const w = stats.firstPlace[p];
                            const pl = stats.racesPlayed[p];
                            return pl > 0 ? (w / pl) * 100 : '-';
                        });
                        return `
                            <div class="stat-item ${getStatClass(played > 0 ? winRate : '-', allWinRates, true)}">
                                <div class="player-name">${window.PlayerNameManager ? window.PlayerNameManager.get(player) : getPlayerName(player)}</div>
                                <div class="player-value">${played > 0 ? winRateDisplay + '%' : '-'}</div>
                                ${played > 0 ? `<div class="stat-count">${wins}</div>` : ''}
                            </div>
                        `;
                    }).join('')}
                </div>
            </div>

            <div class="stat-card">
                <div class="stat-title">Podium Finishes</div>
                <div class="stat-grid">
                    ${players.map(player => {
                        const podiums = stats.podiumFinish[player];
                        const played = stats.racesPlayed[player];
                        const podiumRate = played > 0 ? (podiums / played) * 100 : 0;
                        const podiumRateDisplay = played > 0 ? formatDecimal(podiumRate) : '-';
                        const allPodiumRates = players.map(p => {
                            const pd = stats.podiumFinish[p];
                            const pl = stats.racesPlayed[p];
                            return pl > 0 ? (pd / pl) * 100 : '-';
                        });
                        return `
                            <div class="stat-item ${getStatClass(played > 0 ? podiumRate : '-', allPodiumRates, true)}">
                                <div class="player-name">${window.PlayerNameManager ? window.PlayerNameManager.get(player) : getPlayerName(player)}</div>
                                <div class="player-value">${played > 0 ? podiumRateDisplay + '%' : '-'}</div>
                                ${played > 0 ? `<div class="stat-count">${podiums}</div>` : ''}
                            </div>
                        `;
                    }).join('')}
                </div>
            </div>

            <div class="stat-card">
                <div class="stat-title">Best Podium Streak</div>
                <div class="stat-grid">
                    ${players.map(player => {
                        const streak = stats.bestStreak[player];
                        const played = stats.racesPlayed[player];
                        const allStreaks = players.map(p => stats.racesPlayed[p] > 0 ? stats.bestStreak[p] : '-');
                        return `
                            <div class="stat-item ${getStatClass(played > 0 ? streak : '-', allStreaks, true)}">
                                <div class="player-name">${window.PlayerNameManager ? window.PlayerNameManager.get(player) : getPlayerName(player)}</div>
                                <div class="player-value">${played > 0 ? streak : '-'}</div>
                            </div>
                        `;
                    }).join('')}
                </div>
            </div>
        </div>
    `;

    document.getElementById('stats-display').innerHTML = statsHtml;
}

function createHelpView() {
    const statsDisplay = document.getElementById('stats-display');

    // Get the help panel content
    const helpPanel = document.getElementById('help-panel');
    if (!helpPanel) {
        statsDisplay.innerHTML = '<p>Help content not found.</p>';
        return;
    }

    // Extract the help content (without the header with close button)
    const helpContent = helpPanel.querySelector('.help-content');
    if (!helpContent) {
        statsDisplay.innerHTML = '<p>Help content not found.</p>';
        return;
    }

    // Display the help content in the stats display area
    statsDisplay.innerHTML = `
        <div class="help-view-container" style="padding: 20px; max-width: 1200px; margin: 0 auto;">
            ${helpContent.innerHTML}
        </div>
    `;
}

function createAchievementsView(raceData = null) {
    if (raceData === null) {
        raceData = getFilteredRaces();
    }

    const statsDisplay = document.getElementById('stats-display');

    // Find the input-group first, before we potentially destroy it
    let inputGroup = document.querySelector('.input-group');
    // Store original parent if input-group exists and we haven't stored it yet
    if (inputGroup && !inputGroup.dataset.originalParent) {
        inputGroup.dataset.originalParent = 'body'; // Default fallback
        if (inputGroup.parentElement) {
            // Try to find a reliable reference point
            const calendarDropdown = document.getElementById('calendar-dropdown');
            if (calendarDropdown && calendarDropdown.nextElementSibling === inputGroup) {
                inputGroup.dataset.originalParent = 'after-calendar-dropdown';
            }
        }
    }

    if (raceData.length === 0) {
        // If input-group is inside stats-display, move it out temporarily
        if (inputGroup && statsDisplay.contains(inputGroup)) {
            // Move to original location or body as fallback
            if (inputGroup.dataset.originalParent === 'after-calendar-dropdown') {
                const calendarDropdown = document.getElementById('calendar-dropdown');
                if (calendarDropdown && calendarDropdown.parentElement) {
                    calendarDropdown.parentElement.insertBefore(inputGroup, calendarDropdown.nextSibling);
                } else {
                    document.body.appendChild(inputGroup);
                }
            } else {
                document.body.appendChild(inputGroup);
            }
            inputGroup.style.display = 'none';
        }

        statsDisplay.innerHTML = `
            <div class="no-data-message">
                <div style="text-align: center; padding: 60px 20px; color: #718096;">
                    <h3 style="font-size: 1.5em; margin-bottom: 10px;">No race data available</h3>
                    <p>Add some races to see achievements!</p>
                </div>
            </div>
        `;
        return;
    }

    // Check if achievements view already exists
    let achievementsViewContainer = document.querySelector('.achievements-view-container');
    let achievementsContainer = document.getElementById('achievements-container');

    if (!achievementsViewContainer) {
        // Create the structure if it doesn't exist
        statsDisplay.innerHTML = `
            <div class="achievements-view-container">
                <div id="achievements-container"></div>
            </div>
        `;
        achievementsViewContainer = document.querySelector('.achievements-view-container');
        achievementsContainer = document.getElementById('achievements-container');
    } else {
        // Make sure it's in the stats display
        if (!statsDisplay.contains(achievementsViewContainer)) {
            statsDisplay.innerHTML = '';
            statsDisplay.appendChild(achievementsViewContainer);
        }
    }

    if (inputGroup && achievementsContainer) {
        // Only move if not already in achievements container
        if (inputGroup.parentElement !== achievementsContainer) {
            achievementsContainer.appendChild(inputGroup);
        }

        // Make sure the input group is visible
        inputGroup.style.display = '';

        // Show all bar containers in achievements view
        const barContainers = inputGroup.querySelectorAll('.bar-container');
        barContainers.forEach(container => container.style.display = 'block');

        // Hide the numeric inputs and steppers in achievements view
        const inputs = inputGroup.querySelectorAll('input[type="number"]');
        const steppers = inputGroup.querySelectorAll('.input-stepper');
        inputs.forEach(input => input.style.display = 'none');
        steppers.forEach(stepper => stepper.style.display = 'none');

        // Update achievements to ensure they're displayed correctly
        updateAchievements(raceData);
        
        // Update player labels to remove tooltips in achievements view
        if (typeof updatePlayerLabels === 'function') {
            updatePlayerLabels();
        }
    }
}

// Set today's date as default and create number buttons
document.addEventListener('DOMContentLoaded', function() {
    // Initialize game version manager first
    if (window.initializeGameVersion) {
        window.initializeGameVersion();
    }
    
    // Ensure MAX_POSITIONS is updated for the current game version
    if (window.updateMaxPositions) {
        window.updateMaxPositions();
    }
    
    // Initialize global pagination instance for Mario Kart
    if (window.GlobalPaginationManager) {
        window.GlobalPaginationManager.createInstance('mario-kart-races', {
            localStorageKey: 'raceHistoryPageSize',
            updateCallback: updateDisplay
        });
    }
    
    // Set date to user's local timezone
    const localDate = new Date().toLocaleDateString('en-CA');
    const dateInput = document.getElementById('date');
    if (dateInput) {
        dateInput.value = localDate;
    }

    // Initialize sidebar date
    initializeSidebarDate();

    // Update date button text
    if (typeof updateDateButtonText === 'function') {
        updateDateButtonText();
    }

    // Hide theme toggle since we only have one theme
    const themeToggle = document.getElementById('theme-toggle');
    if (themeToggle) {
        themeToggle.style.display = 'none';
    }

    // Initialize undo/redo button states
    updateUndoRedoButtons();
    
    // Initialize dynamic UI text based on current game version
    if (window.updateDynamicUIText) {
        // Delay to ensure all dependencies are loaded
        setTimeout(() => {
            window.updateDynamicUIText();
        }, 100);
    }

    // Load saved data first
    // Make loadSavedData available globally and call it
    if (window.loadSavedData) {
        window.loadData = window.loadSavedData;
        window.loadSavedData();
    } else {
        console.error('loadSavedData function not found - dataManager.js may not be loaded');
    }

    // Update clear button state after loading data
    updateClearButtonState();
    
    // Set default view based on whether we have data
    const hasData = races && races.length > 0;
    if (!hasData) {
        currentView = 'help';
        // Update the active button
        document.querySelectorAll('.toggle-btn').forEach(btn => {
            btn.classList.remove('active');
            btn.setAttribute('aria-selected', 'false');
        });
        const helpBtn = document.querySelector('.toggle-btn[onclick*="help"]');
        if (helpBtn) {
            helpBtn.classList.add('active');
            helpBtn.setAttribute('aria-selected', 'true');
        }
    }
    
    // Open sidebar by default
    openSidebar();

    // Ensure player names are loaded from localStorage
    if (typeof loadPlayerNames === 'function') {
        playerNames = loadPlayerNames();
    }

    // Update player labels with loaded names
    updatePlayerLabels();

    // Also update the display labels with actual names
    if (window.updatePlayerLabels) {
        window.updatePlayerLabels();
    }
    // createNumberButtons(); // Position buttons removed - using dropdown only
    createAllBars();

    updatePlayerFieldsVisibility();
    updateInputGroupClass();
    updateUndoRedoButtons();
    initializeAutoBackup();

    // Hide input-section since we don't show it in any view
    const inputSection = document.querySelector('.input-section');
    if (inputSection) {
        inputSection.style.display = 'none';
    }

    // Since default view is achievements, ensure input-group starts hidden
    // It will be moved to the achievements container when updateDisplay runs
    const inputGroup = document.querySelector('.input-group');
    if (inputGroup) {
        // Hide numeric inputs and steppers for achievements view
        const inputs = inputGroup.querySelectorAll('input[type="number"]');
        const steppers = inputGroup.querySelectorAll('.input-stepper');
        inputs.forEach(input => input.style.display = 'none');
        steppers.forEach(stepper => stepper.style.display = 'none');
    }

    updateDisplay();

    // Update player icons after all initialization is complete
    if (window.updateAllPlayerIcons) {
        window.updateAllPlayerIcons();
    }

    // Subscribe to player symbol changes to update H2H tables
    if (window.PlayerSymbolManager) {
        window.PlayerSymbolManager.subscribe(() => {
            // Only refresh if we're currently viewing the H2H tab
            if (currentView === 'h2h') {
                createH2HView();
            }
        });
    }

    // The date button already has onclick="toggleDateWidget()" in HTML,
    // so we don't need to add another listener
});
