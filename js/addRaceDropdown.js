// Add Race Dropdown Functionality
// All functions and variables are isolated to prevent conflicts with main page

let dropdownOpen = false;
let selectedPositions = {};
let dropdownElement = null;
let playerCountObserver = null;
let resizeObserver = null;
let nameChangeUnsubscribe = null;

// Toggle dropdown
function toggleAddRaceDropdown(event) {
    if (event) {
        event.stopPropagation();
    }
    
    if (dropdownOpen) {
        closeAddRaceDropdown();
    } else {
        openAddRaceDropdown();
    }
}

// Open dropdown
function openAddRaceDropdown() {
    dropdownElement = document.getElementById('add-race-dropdown');
    if (!dropdownElement) return;
    
    // Close players dropdown if open
    if (typeof closePlayersDropdown === 'function') {
        closePlayersDropdown();
    }
    
    const overlay = document.createElement('div');
    overlay.className = 'dropdown-overlay';
    overlay.onclick = closeAddRaceDropdown;
    document.body.appendChild(overlay);
    
    // Set dropdown width to match widget panel
    updateDropdownWidth();
    
    // Start observing widget panel size changes
    startResizeObserver();
    
    // Initialize form
    initializeDropdownForm();
    
    // Start observing player count changes
    observePlayerCountChanges();
    
    // Subscribe to player name changes
    if (window.PlayerNameManager) {
        nameChangeUnsubscribe = window.PlayerNameManager.subscribe(() => {
            if (dropdownOpen && dropdownElement) {
                // Preserve selections before reinitializing
                const preservedSelections = { ...selectedPositions };
                initializeDropdownForm();
                // Restore selections
                Object.keys(preservedSelections).forEach(playerId => {
                    if (preservedSelections[playerId]) {
                        selectedPositions[playerId] = preservedSelections[playerId];
                        const input = dropdownElement.querySelector(`#dropdown-${playerId}`);
                        if (input) {
                            input.value = preservedSelections[playerId];
                            updatePositionButtons(playerId, preservedSelections[playerId]);
                        }
                    }
                });
            }
        });
    }
    
    // Show dropdown with animation
    setTimeout(() => {
        dropdownElement.classList.add('open');
        overlay.classList.add('active');
    }, 10);
    
    dropdownOpen = true;
    
    // Focus first input
    setTimeout(() => {
        const firstInput = dropdownElement.querySelector('input');
        if (firstInput) firstInput.focus();
    }, 300);
}

// Close dropdown
function closeAddRaceDropdown() {
    if (!dropdownElement) {
        dropdownElement = document.getElementById('add-race-dropdown');
    }
    if (!dropdownElement) return;
    
    const overlay = document.querySelector('.dropdown-overlay');
    
    dropdownElement.classList.remove('open');
    if (overlay) {
        overlay.classList.remove('active');
        setTimeout(() => overlay.remove(), 300);
    }
    
    // Stop observing player count changes
    if (playerCountObserver) {
        playerCountObserver.disconnect();
        playerCountObserver = null;
    }
    
    // Stop observing resize
    if (resizeObserver) {
        resizeObserver.disconnect();
        resizeObserver = null;
    }
    
    // Unsubscribe from name changes
    if (nameChangeUnsubscribe) {
        nameChangeUnsubscribe();
        nameChangeUnsubscribe = null;
    }
    
    dropdownOpen = false;
    selectedPositions = {};
    dropdownElement = null;
    
    // Clear error message
    const errorDiv = document.getElementById('dropdown-error');
    if (errorDiv) {
        errorDiv.style.display = 'none';
        errorDiv.textContent = '';
    }
}

// Initialize dropdown form
function initializeDropdownForm() {
    if (!dropdownElement) return;
    
    const form = dropdownElement.querySelector('#dropdown-race-form');
    if (!form) return;
    
    // Clear any existing event listeners by cloning
    const newForm = form.cloneNode(false);
    form.parentNode.replaceChild(newForm, form);
    
    newForm.innerHTML = '';
    
    // Update ID to maintain reference
    newForm.id = 'dropdown-race-form';
    
    // Get current player count and names
    const currentPlayerCount = playerCount || 3;
    const allPlayers = ['player1', 'player2', 'player3', 'player4'];
    
    // Create input for each active player
    for (let i = 0; i < currentPlayerCount; i++) {
        const playerId = allPlayers[i];
        const playerName = window.PlayerNameManager ? window.PlayerNameManager.get(playerId) : (document.getElementById(`${playerId}-name`)?.value || `Player ${i + 1}`);
        
        const inputGroup = document.createElement('div');
        inputGroup.className = 'dropdown-input-group';
        inputGroup.setAttribute('data-player-id', playerId);
        
        const label = document.createElement('label');
        label.textContent = `${playerName}'s Position`;
        label.htmlFor = `dropdown-${playerId}`;
        
        const inputWrapper = document.createElement('div');
        inputWrapper.style.position = 'relative';
        
        const input = document.createElement('input');
        input.type = 'number';
        input.id = `dropdown-${playerId}`;
        input.min = String(MIN_POSITIONS);
        input.max = String(MAX_POSITIONS);
        input.placeholder = `${MIN_POSITIONS}-${MAX_POSITIONS}`;
        input.value = selectedPositions[playerId] || '';
        
        // Add input listeners with validation
        input.addEventListener('input', (e) => {
            e.stopPropagation();
            const value = parseInt(e.target.value);
            
            // Clear any previous error for this input
            clearPositionError(playerId);
            
            if (e.target.value === '') {
                selectedPositions[playerId] = null;
                updatePositionButtons(playerId, null);
            } else if (value > MAX_POSITIONS) {
                showPositionError(playerId, `Position cannot be higher than ${MAX_POSITIONS}`);
                selectedPositions[playerId] = null;
                updatePositionButtons(playerId, null);
            } else if (value < MIN_POSITIONS) {
                showPositionError(playerId, `Position must be at least ${MIN_POSITIONS}`);
                selectedPositions[playerId] = null;
                updatePositionButtons(playerId, null);
            } else if (value >= MIN_POSITIONS && value <= MAX_POSITIONS) {
                selectedPositions[playerId] = value;
                updatePositionButtons(playerId, value);
            }
        });
        
        // Prevent form submission on enter
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
            }
        });
        
        // Create position buttons grid
        const buttonsGrid = document.createElement('div');
        buttonsGrid.className = 'position-buttons-grid';
        buttonsGrid.setAttribute('data-player-grid', playerId);
        
        // Create buttons for positions 1-MAX_POSITIONS
        for (let pos = MIN_POSITIONS; pos <= MAX_POSITIONS; pos++) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'position-btn';
            btn.textContent = pos;
            btn.setAttribute('data-position', pos);
            // Position button click handler
            btn.onclick = (e) => {
                e.stopPropagation();
                e.preventDefault();
                // Call our dropdown-specific function
                selectDropdownPosition(playerId, pos);
            };
            
            // Check if this position is selected
            if (selectedPositions[playerId] === pos) {
                btn.classList.add('selected');
            }
            
            buttonsGrid.appendChild(btn);
        }
        
        inputWrapper.appendChild(input);
        inputGroup.appendChild(label);
        inputGroup.appendChild(inputWrapper);
        inputGroup.appendChild(buttonsGrid);
        newForm.appendChild(inputGroup);
    }
}

// Select position from button in dropdown with toggle functionality
function selectDropdownPosition(playerId, position) {
    // Clear any previous error
    clearPositionError(playerId);
    
    // Toggle functionality - if already selected, unselect
    if (selectedPositions[playerId] === position) {
        selectedPositions[playerId] = null;
        
        // Clear input value
        if (dropdownElement) {
            const input = dropdownElement.querySelector(`#dropdown-${playerId}`);
            if (input) input.value = '';
        }
        
        // Update button states to show unselected
        updatePositionButtons(playerId, null);
    } else {
        // Select the position
        selectedPositions[playerId] = position;
        
        // Update input value
        if (dropdownElement) {
            const input = dropdownElement.querySelector(`#dropdown-${playerId}`);
            if (input) input.value = position;
        }
        
        // Update button states
        updatePositionButtons(playerId, position);
    }
}

// Update position button states
function updatePositionButtons(playerId, selectedPos) {
    if (!dropdownElement) return;
    
    // Find the specific player's button grid within the dropdown
    const buttonsGrid = dropdownElement.querySelector(`[data-player-grid="${playerId}"]`);
    if (!buttonsGrid) return;
    
    // Update only buttons within this specific grid
    const buttons = buttonsGrid.querySelectorAll('.position-btn');
    buttons.forEach(btn => {
        const pos = parseInt(btn.getAttribute('data-position'));
        btn.classList.toggle('selected', pos === selectedPos);
    });
}

// Save race from dropdown
function saveRaceFromDropdown() {
    const errorDiv = document.getElementById('dropdown-error');
    const saveBtn = dropdownElement ? dropdownElement.querySelector('.dropdown-save-btn') : document.querySelector('.dropdown-save-btn');
    
    // Hide previous error
    errorDiv.style.display = 'none';
    
    // Get date
    const date = document.getElementById('date').value;
    if (!date) {
        showDropdownError('Please select a date using the date widget');
        return;
    }
    
    // Collect race data
    const raceData = {};
    const allPlayers = ['player1', 'player2', 'player3', 'player4'];
    const currentPlayerCount = playerCount || 3;
    
    for (let i = 0; i < currentPlayerCount; i++) {
        const playerId = allPlayers[i];
        raceData[playerId] = selectedPositions[playerId] || null;
    }
    
    // Validation (same as original addRace function)
    const activePlayers = Object.values(raceData).filter(pos => pos !== null);
    const minPlayers = currentPlayerCount === 1 ? 1 : 2;
    
    if (activePlayers.length < minPlayers) {
        showDropdownError(`At least ${minPlayers} player${minPlayers > 1 ? 's' : ''} must have positions`);
        return;
    }
    
    // Validate positions are in range
    if (activePlayers.some(pos => pos < MIN_POSITIONS || pos > MAX_POSITIONS)) {
        showDropdownError(`Positions must be between ${MIN_POSITIONS} and ${MAX_POSITIONS}`);
        return;
    }
    
    // Check for duplicate positions
    const uniquePositions = [...new Set(activePlayers)];
    if (activePlayers.length !== uniquePositions.length) {
        showDropdownError('Players cannot have the same position in a race');
        return;
    }
    
    // Generate timestamp
    const now = new Date();
    const localTime = new Intl.DateTimeFormat('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    }).format(now);
    
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const tzAbbr = new Intl.DateTimeFormat('en-US', {
        timeZoneName: 'short'
    }).formatToParts(now).find(part => part.type === 'timeZoneName')?.value || timeZone;
    
    const timestamp = `${localTime} ${tzAbbr}`;
    
    // Create race object
    const raceObject = { date, timestamp };
    allPlayers.forEach(player => {
        raceObject[player] = raceData[player] || null;
    });
    
    // Add race to array
    races.push(raceObject);
    
    // Save action for undo/redo
    saveAction('ADD_RACE', { race: raceObject });
    
    // Save to localStorage
    try {
        localStorage.setItem('marioKartRaces', JSON.stringify(races));
    } catch (e) {
        console.error('Error saving to localStorage:', e);
    }
    
    // Show success animation
    if (saveBtn) {
        saveBtn.classList.add('success');
        saveBtn.textContent = '✓ Saved!';
    }
    
    // Update displays and close dropdown
    setTimeout(() => {
        updateDisplay();
        updateAchievements();
        updateClearButtonState();
        showMessage('Race added successfully!');
        
        // Close dropdown after successful save
        closeAddRaceDropdown();
        
        // Reset button
        if (saveBtn) {
            saveBtn.classList.remove('success');
            saveBtn.textContent = 'Save Race';
        }
    }, 500);
}

// Show error in dropdown
function showDropdownError(message) {
    const errorDiv = document.getElementById('dropdown-error');
    errorDiv.textContent = message;
    errorDiv.style.display = 'block';
    
    // Auto-hide after 5 seconds
    setTimeout(() => {
        errorDiv.style.display = 'none';
    }, 5000);
}

// Show position-specific error
function showPositionError(playerId, message) {
    if (!dropdownElement) return;
    
    const playerGroup = dropdownElement.querySelector(`[data-player-id="${playerId}"]`);
    if (!playerGroup) return;
    
    // Remove any existing error for this player
    const existingError = playerGroup.querySelector('.position-error');
    if (existingError) {
        existingError.remove();
    }
    
    // Create and add new error
    const errorDiv = document.createElement('div');
    errorDiv.className = 'position-error';
    errorDiv.textContent = message;
    errorDiv.style.cssText = 'color: #e53e3e; font-size: 0.75rem; margin-top: 0.25rem;';
    
    const inputWrapper = playerGroup.querySelector('input').parentElement;
    inputWrapper.appendChild(errorDiv);
}

// Clear position-specific error
function clearPositionError(playerId) {
    if (!dropdownElement) return;
    
    const playerGroup = dropdownElement.querySelector(`[data-player-id="${playerId}"]`);
    if (!playerGroup) return;
    
    const error = playerGroup.querySelector('.position-error');
    if (error) {
        error.remove();
    }
}

// Observe player count changes
function observePlayerCountChanges() {
    const playerCountSelect = document.getElementById('player-count');
    if (!playerCountSelect) return;
    
    // Watch for changes in player count
    const handlePlayerCountChange = () => {
        if (dropdownOpen && dropdownElement) {
            // Preserve existing selections
            const preservedSelections = { ...selectedPositions };
            
            // Reinitialize form with new player count
            initializeDropdownForm();
            
            // Restore preserved selections
            Object.keys(preservedSelections).forEach(playerId => {
                if (preservedSelections[playerId]) {
                    selectedPositions[playerId] = preservedSelections[playerId];
                    const input = dropdownElement.querySelector(`#dropdown-${playerId}`);
                    if (input) {
                        input.value = preservedSelections[playerId];
                        updatePositionButtons(playerId, preservedSelections[playerId]);
                    }
                }
            });
        }
    };
    
    // Add event listener
    playerCountSelect.addEventListener('change', handlePlayerCountChange);
    
    // Also observe DOM changes for programmatic updates
    playerCountObserver = new MutationObserver(() => {
        handlePlayerCountChange();
    });
    
    playerCountObserver.observe(playerCountSelect, {
        attributes: true,
        attributeFilter: ['value']
    });
}

// Close dropdown on escape key
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && dropdownOpen) {
        closeAddRaceDropdown();
    }
});

// Prevent dropdown clicks from propagating to main page
document.addEventListener('DOMContentLoaded', () => {
    const dropdown = document.getElementById('add-race-dropdown');
    if (dropdown) {
        // Only stop propagation to parent elements, not within dropdown
        dropdown.addEventListener('click', (e) => {
            e.stopPropagation();
        });
        
        // Add scroll isolation
        const dropdownContent = dropdown.querySelector('.dropdown-form');
        if (dropdownContent) {
            // Prevent scroll from propagating to main page
            dropdownContent.addEventListener('wheel', (e) => {
                const { scrollTop, scrollHeight, clientHeight } = dropdownContent;
                const isScrollingUp   = e.deltaY < 0;
                const isScrollingDown = e.deltaY > 0;
                const isAtTop         = scrollTop === 0;
                const isAtBottom      = scrollTop + clientHeight >= scrollHeight - 1;

                if ((isAtTop && isScrollingUp) || (isAtBottom && isScrollingDown)) {
                    // note: in a passive listener, this call will be ignored
                    e.preventDefault();
                    e.stopPropagation();
                }
            }, { passive: true });
        }
    }
});

// Update dropdown width to match widget panel exactly
function updateDropdownWidth() {
    if (!dropdownElement) return;
    
    const widgetPanel = document.querySelector('.widget-panel');
    const widgetContainer = dropdownElement.parentElement;
    
    if (widgetPanel && widgetContainer) {
        // Get the exact computed width of the widget panel
        const widgetPanelStyles = window.getComputedStyle(widgetPanel);
        const widgetPanelWidth = widgetPanel.offsetWidth;
        
        // Get the container's position for proper alignment
        const containerRect = widgetContainer.getBoundingClientRect();
        const widgetPanelRect = widgetPanel.getBoundingClientRect();
        
        // Calculate the exact width accounting for any transforms or scaling
        dropdownElement.style.width = widgetPanelWidth + 'px';
        dropdownElement.style.maxWidth = widgetPanelWidth + 'px';
        dropdownElement.style.minWidth = widgetPanelWidth + 'px';
        
        // Ensure left position aligns with widget panel
        const leftOffset = containerRect.left - widgetPanelRect.left;
        dropdownElement.style.left = -leftOffset + 'px';
    }
}

// Start observing widget panel size changes
function startResizeObserver() {
    const widgetPanel = document.querySelector('.widget-panel');
    if (!widgetPanel) return;
    
    resizeObserver = new ResizeObserver(() => {
        updateDropdownWidth();
    });
    
    resizeObserver.observe(widgetPanel);
}

// Export functions for global access
window.toggleAddRaceDropdown = toggleAddRaceDropdown;
window.closeAddRaceDropdown = closeAddRaceDropdown;
window.saveRaceFromDropdown = saveRaceFromDropdown;
