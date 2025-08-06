// Players Dropdown - Modern Player Settings UI
(function() {
    let dropdownElement = null;
    let buttonElement = null;
    let resizeObserver = null;
    let isOpen = false;
    let nameChangeUnsubscribe = null;
    let activeIconPicker = null;
    let activePickerPlayer = null;
    
    // Available icons for selection
    const AVAILABLE_ICONS = [
        '🐱', '🚀', '🎮', '🧠', '🐸',
        '🦊', '🧊', '🌈', '👾', '🪐',
        '🐢', '🔮', '🍕', '💎', '⚡',
        '🎲', '🧃', '🐉', '☕', '🛸'
    ];

    // Initialize on DOM load
    document.addEventListener('DOMContentLoaded', initPlayersDropdown);

    function initPlayersDropdown() {
        buttonElement = document.querySelector('.widget-btn.players-btn');
        if (!buttonElement) return;

        // Remove any existing onclick attribute
        buttonElement.removeAttribute('onclick');
        
        // Add click listener
        buttonElement.addEventListener('click', toggleDropdown);
        
        // Create dropdown element
        createDropdown();
        
        // Add click outside listener
        document.addEventListener('click', handleClickOutside);
        
        // Subscribe to player name changes
        if (window.PlayerNameManager) {
            nameChangeUnsubscribe = window.PlayerNameManager.subscribe(updatePlayerFields);
        }
        
        // Subscribe to player icon changes
        if (window.PlayerIconManager) {
            window.PlayerIconManager.subscribe(updatePlayerAvatar);
        }
    }

    function createDropdown() {
        // Find the widget container
        const widgetContainer = buttonElement.closest('.widget-container');
        if (!widgetContainer) return;

        // Create dropdown element
        dropdownElement = document.createElement('div');
        dropdownElement.className = 'players-dropdown';
        
        // Build initial content
        updateDropdownContent();
        
        // Append to widget container
        widgetContainer.appendChild(dropdownElement);
    }

    function updateDropdownContent() {
        const playerCount = localStorage.getItem('marioKartPlayerCount') || '3';
        const playerNames = window.PlayerNameManager ? window.PlayerNameManager.getAll() : 
            { player1: 'Player 1', player2: 'Player 2', player3: 'Player 3', player4: 'Player 4' };
        
        dropdownElement.innerHTML = `
            <div class="dropdown-header">
                <h4>Player Settings</h4>
                <button class="dropdown-close" onclick="closePlayersDropdown()" aria-label="Close">×</button>
            </div>
            <div class="dropdown-content">
                <div class="dropdown-form">
                    <div class="player-count-section">
                        <label class="dropdown-label">Number of Players</label>
                        <div class="player-count-selector">
                            ${[1, 2, 3, 4].map(num => `
                                <button class="player-count-btn ${parseInt(playerCount) === num ? 'selected' : ''}" 
                                        data-count="${num}" 
                                        onclick="selectPlayerCount(${num})">
                                    ${num}
                                </button>
                            `).join('')}
                        </div>
                    </div>
                    
                    <div class="players-list">
                        ${generatePlayerFields(parseInt(playerCount), playerNames)}
                    </div>
                </div>
            </div>
        `;
    }

    function generatePlayerFields(count, playerNames) {
        return Array.from({ length: 4 }, (_, i) => {
            const playerNum = i + 1;
            const playerKey = `player${playerNum}`;
            const isActive = playerNum <= count;
            const playerName = playerNames[playerKey] || `Player ${playerNum}`;
            
            // Get icon or first letter
            let symbol;
            if (window.PlayerSymbolManager) {
                symbol = window.PlayerSymbolManager.getSymbol(playerKey);
            }
            
            // If no symbol, get first letter from name
            if (!symbol) {
                // Ensure we have a valid name
                const nameToUse = playerName || `Player ${playerNum}`;
                symbol = nameToUse.charAt(0).toUpperCase() || 'P';
            }
            
            return `
                <div class="player-item ${!isActive ? 'inactive' : ''}" data-player="${playerKey}">
                    <div class="player-header">
                        <div class="player-initial ${isActive ? 'clickable' : ''}" 
                             onclick="${isActive ? `openIconPicker('${playerKey}', this)` : ''}"
                             ${isActive ? `title="Click to change icon" aria-label="Change icon for ${playerName}"` : ''}>
                            <span class="initial-letter">${symbol}</span>
                        </div>
                        <div class="player-details">
                            <label class="player-label">Player ${playerNum}</label>
                            <input type="text" 
                                   class="player-name-input" 
                                   value="${playerName}"
                                   placeholder="Enter name..."
                                   ${!isActive ? 'disabled' : ''}
                                   data-player="${playerKey}"
                                   onblur="updatePlayerNameFromInput(this)"
                                   onkeypress="handleNameInputKeypress(event, this)">
                        </div>
                        ${isActive ? '<div class="player-status">Active</div>' : '<div class="player-status inactive">Inactive</div>'}
                    </div>
                </div>
            `;
        }).join('');
    }

    function toggleDropdown(e) {
        e.stopPropagation();
        
        if (isOpen) {
            closeDropdown();
        } else {
            openDropdown();
        }
    }

    function openDropdown() {
        if (!dropdownElement) return;
        
        // Close other dropdowns
        closeOtherDropdowns();
        
        // Update content with latest data
        updateDropdownContent();
        
        // Update width and position
        updateDropdownWidth();
        
        // Show dropdown
        dropdownElement.classList.add('open');
        isOpen = true;
        
        // Start observing for resize
        startResizeObserver();
    }

    function closeDropdown() {
        if (!dropdownElement) return;
        
        dropdownElement.classList.remove('open');
        isOpen = false;
        
        // Stop observing
        stopResizeObserver();
    }

    function closeOtherDropdowns() {
        // Close add-race-dropdown if open
        const addRaceDropdown = document.getElementById('add-race-dropdown');
        if (addRaceDropdown && addRaceDropdown.classList.contains('open')) {
            if (typeof closeAddRaceDropdown === 'function') {
                closeAddRaceDropdown();
            }
        }
    }

    function updateDropdownWidth() {
        const widgetContainer = dropdownElement.parentElement;
        
        if (widgetContainer) {
            // Use responsive width based on viewport and container
            const maxWidth = Math.min(window.innerWidth * 0.9, 350);
            dropdownElement.style.width = maxWidth + 'px';
            dropdownElement.style.maxWidth = maxWidth + 'px';
            dropdownElement.style.minWidth = '250px';
        }
    }

    function startResizeObserver() {
        const resizeHandler = () => {
            if (isOpen) {
                updateDropdownWidth();
            }
        };
        window.addEventListener('resize', resizeHandler);
        
        // Store handler for cleanup if needed
        window._playersDropdownResizeHandler = resizeHandler;
    }

    function stopResizeObserver() {
        if (window._playersDropdownResizeHandler) {
            window.removeEventListener('resize', window._playersDropdownResizeHandler);
            window._playersDropdownResizeHandler = null;
        }
    }

    function handleClickOutside(e) {
        if (!isOpen) return;
        
        // Don't close if clicking on icon picker elements
        if (e.target.closest('.icon-picker') || e.target.closest('.icon-option')) {
            return;
        }
        
        // Check if click is outside button and dropdown
        if (!buttonElement.contains(e.target) && !dropdownElement.contains(e.target)) {
            closeDropdown();
        }
    }

    function updatePlayerFields() {
        if (!isOpen) return;
        
        // Update the name inputs with latest values
        const playerNames = window.PlayerNameManager ? window.PlayerNameManager.getAll() : {};
        
        Object.keys(playerNames).forEach(playerKey => {
            const input = dropdownElement.querySelector(`input[data-player="${playerKey}"]`);
            if (input && input !== document.activeElement) {
                input.value = playerNames[playerKey];
            }
        });
    }

    // Export functions for external use
    window.openPlayersDropdown = openDropdown;
    window.closePlayersDropdown = closeDropdown;
    
    // Player count selection
    window.selectPlayerCount = function(count) {
        // Update UI
        document.querySelectorAll('.player-count-btn').forEach(btn => {
            btn.classList.toggle('selected', parseInt(btn.dataset.count) === count);
        });
        
        // Update player items
        const playerItems = document.querySelectorAll('.player-item');
        playerItems.forEach((item, index) => {
            const isActive = index < count;
            item.classList.toggle('inactive', !isActive);
            
            const input = item.querySelector('.player-name-input');
            if (input) input.disabled = !isActive;
            
            const status = item.querySelector('.player-status');
            if (status) {
                status.textContent = isActive ? 'Active' : 'Inactive';
                status.classList.toggle('inactive', !isActive);
            }
        });
        
        // Call the existing updatePlayerCount function
        if (typeof updatePlayerCount === 'function') {
            updatePlayerCount(count);
        }
    };
    
    // Player name update
    window.updatePlayerNameFromInput = function(input) {
        const playerKey = input.dataset.player;
        const newName = input.value.trim() || `Player ${playerKey.slice(-1)}`;
        
        // Update the initial letter in the dropdown (only if no custom icon)
        const playerItem = input.closest('.player-item');
        if (playerItem) {
            const initialLetter = playerItem.querySelector('.initial-letter');
            const hasSymbol = window.PlayerSymbolManager ? 
                window.PlayerSymbolManager.getSymbol(playerKey) : null;
            if (initialLetter && !hasSymbol) {
                // Ensure we always have a valid character
                const nameToUse = newName || playerKey;
                const firstChar = nameToUse.charAt(0).toUpperCase() || 'P';
                initialLetter.textContent = firstChar;
            }
        }
        
        if (typeof updatePlayerName === 'function') {
            updatePlayerName(playerKey, newName);
        }
    };
    
    window.handleNameInputKeypress = function(event, input) {
        if (event.key === 'Enter') {
            input.blur();
        }
    };
    
    // Avatar upload handler
    window.handleAvatarUpload = async function(event, playerKey) {
        const file = event.target.files[0];
        if (!file) return;
        
        try {
            if (!window.PlayerIconManager) {
                throw new Error('Icon manager not available');
            }
            
            await window.PlayerIconManager.processIconUpload(playerKey, file);
            
            // Show success feedback
            const avatarEl = document.querySelector(`.player-avatar[data-player="${playerKey}"]`);
            if (avatarEl) {
                avatarEl.style.transform = 'scale(1.1)';
                setTimeout(() => {
                    avatarEl.style.transform = 'scale(1)';
                }, 200);
            }
        } catch (error) {
            alert('Failed to upload avatar: ' + error.message);
            event.target.value = ''; // Reset file input
        }
    };
    
    // Update specific player avatar
    function updatePlayerAvatar(playerKey) {
        if (!isOpen || !window.PlayerIconManager) return;
        
        const avatarImg = document.querySelector(`.player-avatar[data-player="${playerKey}"] img`);
        if (avatarImg) {
            const playerName = window.PlayerNameManager ? 
                window.PlayerNameManager.get(playerKey) : playerKey;
            const icon = window.PlayerIconManager.getIcon(playerKey);
            avatarImg.src = icon || window.PlayerIconManager.getDefaultAvatar(playerKey, playerName);
        }
    }
    
    // Icon picker functions
    window.openIconPicker = function(playerKey, element) {
        // Toggle behavior - if clicking same player, close picker
        if (activePickerPlayer === playerKey && activeIconPicker) {
            closeIconPicker();
            return;
        }
        
        // Close any existing picker
        if (activeIconPicker) {
            activeIconPicker.remove();
        }
        
        // Create icon picker
        const picker = document.createElement('div');
        picker.className = 'icon-picker';
        picker.innerHTML = `
            <div class="icon-picker-grid">
                ${AVAILABLE_ICONS.map(icon => `
                    <button class="icon-option" 
                            onclick="selectPlayerIcon('${playerKey}', '${icon}', event)"
                            aria-label="Select ${icon}"
                            title="Select ${icon}">
                        ${icon}
                    </button>
                `).join('')}
            </div>
        `;
        
        // Prevent clicks on the picker from bubbling up
        picker.addEventListener('click', (e) => {
            e.stopPropagation();
        });
        
        // Position at bottom-left of the clicked element
        const rect = element.getBoundingClientRect();
        const dropdownRect = dropdownElement.getBoundingClientRect();
        
        picker.style.position = 'absolute';
        
        // Position at bottom-left, aligned with the clicked element
        const leftPos = rect.left - dropdownRect.left;
        const topPos = rect.bottom - dropdownRect.top + 10; // 10px gap below the element
        
        picker.style.left = leftPos + 'px';
        picker.style.top = topPos + 'px';
        
        dropdownElement.appendChild(picker);
        activeIconPicker = picker;
        activePickerPlayer = playerKey;
        
        // Close on click outside (with capture to intercept before bubble)
        setTimeout(() => {
            document.addEventListener('click', closeIconPicker, true);
        }, 0);
    };
    
    window.selectPlayerIcon = function(playerKey, icon, event) {
        // Prevent event propagation to avoid closing the dropdown
        if (event) {
            event.stopPropagation();
            event.preventDefault();
        }
        
        // Save selection
        if (window.PlayerSymbolManager) {
            window.PlayerSymbolManager.setSymbol(playerKey, icon);
        }
        
        // Update UI
        const playerItem = document.querySelector(`.player-item[data-player="${playerKey}"]`);
        if (playerItem) {
            const initialLetter = playerItem.querySelector('.initial-letter');
            if (initialLetter) {
                // Ensure we never set null or empty string
                initialLetter.textContent = icon || 'P';
            }
        }
        
        // Notify icon display system
        if (window.updateAllPlayerIcons) {
            window.updateAllPlayerIcons();
        }
        
        // Close only the icon picker, not the dropdown
        if (activeIconPicker) {
            activeIconPicker.remove();
            activeIconPicker = null;
            activePickerPlayer = null;
        }
    };
    
    function closeIconPicker(e) {
        // Don't close if clicking inside the picker
        if (e && activeIconPicker && activeIconPicker.contains(e.target)) {
            return;
        }
        
        // Don't close if clicking on a player-initial element
        if (e && e.target && e.target.closest('.player-initial')) {
            return;
        }
        
        if (activeIconPicker) {
            activeIconPicker.remove();
            activeIconPicker = null;
            activePickerPlayer = null;
        }
        
        document.removeEventListener('click', closeIconPicker);
    }
    
    // Subscribe to symbol changes
    if (window.PlayerSymbolManager) {
        window.PlayerSymbolManager.subscribe((playerKey) => {
            if (isOpen) {
                updateDropdownContent();
            }
        });
    }
})();