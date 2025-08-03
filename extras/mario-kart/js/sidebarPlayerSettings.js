// Sidebar Player Settings
(function() {
    let activeIconPicker = null;
    let activePickerPlayer = null;
    let isOpen = false;
    
    // Available icons for selection
    const AVAILABLE_ICONS = [
        '🐱', '🚀', '🎮', '🧠', '🐸',
        '🦊', '🧊', '🌈', '👾', '🪐',
        '🐢', '🔮', '🍕', '💎', '⚡',
        '🎲', '🧃', '🐉', '☕', '🛸'
    ];

    // Initialize on DOM load
    document.addEventListener('DOMContentLoaded', initSidebarPlayerSettings);

    function initSidebarPlayerSettings() {
        const container = document.getElementById('sidebar-player-settings');
        if (!container) return;

        // Don't render initially - wait for user to open
        
        // Subscribe to player name changes
        if (window.PlayerNameManager) {
            window.PlayerNameManager.subscribe(updatePlayerFields);
        }
        
        // Subscribe to player icon changes
        if (window.PlayerSymbolManager) {
            window.PlayerSymbolManager.subscribe(() => {
                if (isOpen) {
                    updateSidebarPlayerSettings();
                }
            });
        }
    }

    function updateSidebarPlayerSettings() {
        const container = document.getElementById('sidebar-player-settings');
        if (!container) return;

        const playerCount = localStorage.getItem('marioKartPlayerCount') || '3';
        const playerNames = window.PlayerNameManager ? window.PlayerNameManager.getAll() : 
            { player1: 'Player 1', player2: 'Player 2', player3: 'Player 3', player4: 'Player 4' };
        
        container.innerHTML = `
            <div class="sidebar-players-form">
                <div class="player-count-section">
                    <label class="player-count-label">Number of Players</label>
                    <div class="player-count-selector">
                        ${[1, 2, 3, 4].map(num => `
                            <button class="player-count-btn ${parseInt(playerCount) === num ? 'selected' : ''}" 
                                    data-count="${num}" 
                                    onclick="selectSidebarPlayerCount(${num})">
                                ${num}
                            </button>
                        `).join('')}
                    </div>
                </div>
                
                <div class="sidebar-players-list">
                    ${generateSidebarPlayerFields(parseInt(playerCount), playerNames)}
                </div>
            </div>
        `;
        
        // Add click event listeners for icon pickers
        document.addEventListener('click', handleClickOutside);
    }

    function generateSidebarPlayerFields(count, playerNames) {
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
                const nameToUse = playerName || `Player ${playerNum}`;
                symbol = nameToUse.charAt(0).toUpperCase() || 'P';
            }
            
            return `
                <div class="sidebar-player-item ${!isActive ? 'inactive' : ''}" data-player="${playerKey}">
                    <div class="sidebar-player-header">
                        <div class="sidebar-player-initial ${isActive ? 'clickable' : ''}" 
                             onclick="${isActive ? `openSidebarIconPicker('${playerKey}', this)` : ''}"
                             ${isActive ? 'title="Click to change icon"' : ''}>
                            <span class="sidebar-initial-letter">${symbol}</span>
                        </div>
                        <div class="sidebar-player-details">
                            <label class="sidebar-player-label">Player ${playerNum}</label>
                            <input type="text" 
                                   class="sidebar-player-name-input" 
                                   value="${playerName}"
                                   placeholder="Enter name..."
                                   ${!isActive ? 'disabled' : ''}
                                   data-player="${playerKey}"
                                   onblur="updateSidebarPlayerName(this)"
                                   onkeypress="handleSidebarNameKeypress(event, this)">
                        </div>
                        ${isActive ? '<div class="sidebar-player-status active">Active</div>' : '<div class="sidebar-player-status">Inactive</div>'}
                    </div>
                </div>
            `;
        }).join('');
    }

    function updatePlayerFields() {
        if (!isOpen) return;
        
        // Update the name inputs with latest values
        const playerNames = window.PlayerNameManager ? window.PlayerNameManager.getAll() : {};
        
        Object.keys(playerNames).forEach(playerKey => {
            const input = document.querySelector(`#sidebar-player-settings input[data-player="${playerKey}"]`);
            if (input && input !== document.activeElement) {
                input.value = playerNames[playerKey];
            }
        });
    }

    function handleClickOutside(e) {
        // Don't close if clicking on icon picker elements
        if (e.target.closest('.sidebar-icon-picker') || e.target.closest('.sidebar-icon-option')) {
            return;
        }
        
        // Don't close if clicking on a player-initial element
        if (e.target.closest('.sidebar-player-initial')) {
            return;
        }
        
        closeIconPicker();
    }

    function closeIconPicker() {
        if (activeIconPicker) {
            activeIconPicker.remove();
            activeIconPicker = null;
            activePickerPlayer = null;
        }
    }

    // Export functions for global use
    window.selectSidebarPlayerCount = function(count) {
        // Update UI
        document.querySelectorAll('.player-count-btn').forEach(btn => {
            btn.classList.toggle('selected', parseInt(btn.dataset.count) === count);
        });
        
        // Update player items
        const playerItems = document.querySelectorAll('.sidebar-player-item');
        playerItems.forEach((item, index) => {
            const isActive = index < count;
            item.classList.toggle('inactive', !isActive);
            
            const input = item.querySelector('.sidebar-player-name-input');
            if (input) input.disabled = !isActive;
            
            const status = item.querySelector('.sidebar-player-status');
            if (status) {
                status.textContent = isActive ? 'Active' : 'Inactive';
                status.classList.toggle('active', isActive);
            }
            
            // Update clickability of icon selector
            const initial = item.querySelector('.sidebar-player-initial');
            if (initial) {
                initial.classList.toggle('clickable', isActive);
                initial.title = isActive ? 'Click to change icon' : '';
                initial.onclick = isActive ? () => openSidebarIconPicker(item.dataset.player, initial) : null;
            }
        });
        
        // Call the existing updatePlayerCount function
        if (typeof updatePlayerCount === 'function') {
            updatePlayerCount(count);
        }
    };
    
    window.updateSidebarPlayerName = function(input) {
        const playerKey = input.dataset.player;
        const newName = input.value.trim() || `Player ${playerKey.slice(-1)}`;
        
        // Update the initial letter in the sidebar (only if no custom icon)
        const playerItem = input.closest('.sidebar-player-item');
        if (playerItem) {
            const initialLetter = playerItem.querySelector('.sidebar-initial-letter');
            const hasSymbol = window.PlayerSymbolManager ? 
                window.PlayerSymbolManager.getSymbol(playerKey) : null;
            if (initialLetter && !hasSymbol) {
                const nameToUse = newName || playerKey;
                const firstChar = nameToUse.charAt(0).toUpperCase() || 'P';
                initialLetter.textContent = firstChar;
            }
        }
        
        if (typeof updatePlayerName === 'function') {
            updatePlayerName(playerKey, newName);
        }
    };
    
    window.handleSidebarNameKeypress = function(event, input) {
        if (event.key === 'Enter') {
            input.blur();
        }
    };
    
    window.openSidebarIconPicker = function(playerKey, element) {
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
        picker.className = 'sidebar-icon-picker';
        picker.innerHTML = `
            <div class="sidebar-icon-picker-grid">
                ${AVAILABLE_ICONS.map(icon => `
                    <button class="sidebar-icon-option" 
                            onclick="selectSidebarPlayerIcon('${playerKey}', '${icon}', event)"
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
        
        // Position below the clicked element using fixed positioning
        const rect = element.getBoundingClientRect();
        
        picker.style.position = 'fixed';
        picker.style.left = rect.left + 'px';
        picker.style.top = (rect.bottom + 8) + 'px'; // 8px margin below element
        picker.style.width = Math.max(200, rect.width) + 'px';
        picker.style.minWidth = '200px';
        
        // Append to document.body to escape sidebar stacking context
        document.body.appendChild(picker);
        
        activeIconPicker = picker;
        activePickerPlayer = playerKey;
    };
    
    window.selectSidebarPlayerIcon = function(playerKey, icon, event) {
        // Prevent event propagation
        if (event) {
            event.stopPropagation();
            event.preventDefault();
        }
        
        // Save selection
        if (window.PlayerSymbolManager) {
            window.PlayerSymbolManager.setSymbol(playerKey, icon);
        }
        
        // Update UI
        const playerItem = document.querySelector(`.sidebar-player-item[data-player="${playerKey}"]`);
        if (playerItem) {
            const initialLetter = playerItem.querySelector('.sidebar-initial-letter');
            if (initialLetter) {
                initialLetter.textContent = icon || 'P';
            }
        }
        
        // Notify icon display system
        if (window.updateAllPlayerIcons) {
            window.updateAllPlayerIcons();
        }
        
        // Close the icon picker
        closeIconPicker();
    };
    
    // Subscribe to symbol changes
    if (window.PlayerSymbolManager) {
        window.PlayerSymbolManager.subscribe((playerKey) => {
            if (isOpen) {
                updateSidebarPlayerSettings();
            }
        });
    }
    
    // Toggle functions
    window.toggleSidebarPlayerSettings = function() {
        const settingsDiv = document.getElementById('sidebar-player-settings');
        const button = document.getElementById('sidebar-player-settings-btn');
        
        if (!settingsDiv || !button) return;
        
        if (isOpen) {
            closeSidebarPlayerSettings();
        } else {
            openSidebarPlayerSettings();
        }
    };
    
    window.openSidebarPlayerSettings = function() {
        const settingsDiv = document.getElementById('sidebar-player-settings');
        const button = document.getElementById('sidebar-player-settings-btn');
        
        if (!settingsDiv || !button) return;
        
        // Update content before showing
        updateSidebarPlayerSettings();
        
        // Show with animation
        settingsDiv.style.display = 'block';
        settingsDiv.classList.add('open');
        button.classList.add('active');
        isOpen = true;
        
        // Force reflow for animation
        settingsDiv.offsetHeight;
        
        setTimeout(() => {
            settingsDiv.style.opacity = '1';
            settingsDiv.style.transform = 'translateY(0)';
        }, 10);
    };
    
    window.closeSidebarPlayerSettings = function() {
        const settingsDiv = document.getElementById('sidebar-player-settings');
        const button = document.getElementById('sidebar-player-settings-btn');
        
        if (!settingsDiv || !button) return;
        
        // Hide with animation
        settingsDiv.style.opacity = '0';
        settingsDiv.style.transform = 'translateY(-10px)';
        button.classList.remove('active');
        
        setTimeout(() => {
            settingsDiv.style.display = 'none';
            settingsDiv.classList.remove('open');
            isOpen = false;
            
            // Close any open icon pickers
            closeIconPicker();
        }, 300);
    };
})();