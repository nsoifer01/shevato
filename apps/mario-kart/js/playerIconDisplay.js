// Player Icon Display - Shows player icons throughout the UI
(function() {
    // Initialize on DOM load
    document.addEventListener('DOMContentLoaded', initPlayerIconDisplay);
    
    function initPlayerIconDisplay() {
        // Update icons on initial load
        updateAllPlayerIcons();
        
        // Subscribe to icon changes
        if (window.PlayerIconManager) {
            window.PlayerIconManager.subscribe(handleIconChange);
        }
        
        // Subscribe to symbol changes
        if (window.PlayerSymbolManager) {
            window.PlayerSymbolManager.subscribe(handleIconChange);
        }
        
        // Subscribe to name changes
        if (window.PlayerNameManager) {
            window.PlayerNameManager.subscribe(handleNameChange);
        }
        
        // Watch for DOM changes to update new elements
        observeDOMChanges();
    }
    
    // Create icon element (shows selected icon or first letter)
    function createIconElement(playerKey, playerName) {
        const symbol = window.PlayerSymbolManager ? window.PlayerSymbolManager.getSymbol(playerKey) : null;
        
        // Ensure we always have a valid name to get the first letter from
        let nameToUse = playerName;
        if (!nameToUse || nameToUse === 'undefined' || nameToUse === 'null') {
            // If no name or invalid name, use the playerKey (e.g., "player4")
            nameToUse = playerKey;
        }
        
        // Extract first character - if playerKey like "player4", get "P"
        const firstChar = nameToUse.charAt(0).toUpperCase() || 'P';
        const content = symbol || firstChar;
        
        const span = document.createElement('span');
        span.className = 'player-icon player-initial';
        span.textContent = content;
        span.setAttribute('data-player', playerKey);
        
        return span;
    }
    
    // Update all player icons in the UI
    function updateAllPlayerIcons() {
        // Update player labels (form inputs)
        updateFormLabels();
        
        // Update table headers
        updateTableHeaders();
        
        // Update any other player name displays
        updateOtherPlayerDisplays();
    }
    
    // Update form labels with icons
    function updateFormLabels() {
        const playerLabels = document.querySelectorAll('label[id$="-label"]');
        
        playerLabels.forEach(label => {
            const match = label.id.match(/player(\d)-label/);
            if (match) {
                const playerKey = `player${match[1]}`;
                const playerName = window.PlayerNameManager ? 
                    window.PlayerNameManager.get(playerKey) : playerKey;
                
                // Remove existing icon if any
                const existingIcon = label.querySelector('.player-icon');
                if (existingIcon) {
                    existingIcon.remove();
                }
                
                // Add new icon
                const icon = createIconElement(playerKey, playerName);
                icon.style.width = '24px';
                icon.style.height = '24px';
                icon.style.marginRight = '6px';
                icon.style.display = 'inline-flex';
                icon.style.alignItems = 'center';
                icon.style.justifyContent = 'center';
                icon.style.background = '#e2e8f0';
                icon.style.borderRadius = '50%';
                icon.style.fontSize = '0.875rem';
                icon.style.fontWeight = '600';
                icon.style.color = '#2d3748';
                
                label.insertBefore(icon, label.firstChild);
            }
        });
    }
    
    // Update table headers with icons
    function updateTableHeaders() {
        const tables = document.querySelectorAll('table');
        
        tables.forEach(table => {
            const headers = table.querySelectorAll('th');
            
            // Special handling for history table
            if (table.id === 'history-table') {
                let playerColumnIndex = 0;
                headers.forEach((th, index) => {
                    // Skip first two columns (Race # and Date) and last column (Action)
                    if (index < 2 || index === headers.length - 1) {
                        return;
                    }
                    
                    // This is a player column
                    playerColumnIndex++;
                    const playerKey = `player${playerColumnIndex}`;
                    const playerName = window.PlayerNameManager ? 
                        window.PlayerNameManager.get(playerKey) : getPlayerName(playerKey);
                    
                    // Only update if icon not already present
                    if (!th.querySelector('.player-icon')) {
                        const icon = createIconElement(playerKey, playerName);
                        icon.style.width = '24px';
                        icon.style.height = '24px';
                        icon.style.marginRight = '6px';
                        icon.style.display = 'inline-flex';
                        icon.style.alignItems = 'center';
                        icon.style.justifyContent = 'center';
                        icon.style.background = '#e2e8f0';
                        icon.style.borderRadius = '50%';
                        icon.style.fontSize = '0.875rem';
                        icon.style.fontWeight = '600';
                        icon.style.color = '#2d3748';
                        
                        th.insertBefore(icon, th.firstChild);
                    }
                });
            } else {
                // Original logic for other tables
                let playerIndex = 1;
                headers.forEach((th, index) => {
                    // Skip non-player columns
                    const headerText = th.textContent.toLowerCase().trim();
                    // Check for various non-player column headers
                    if (index === 0 || 
                        headerText === '%' || 
                        headerText === 'activity' ||
                        headerText.includes('date') || 
                        headerText === 'action' || 
                        headerText === 'race #' ||
                        headerText.includes('day') ||
                        headerText.includes('%')) {
                        return;
                    }
                    
                    const playerKey = `player${playerIndex}`;
                    const playerName = window.PlayerNameManager ? 
                        window.PlayerNameManager.get(playerKey) : th.textContent;
                    playerIndex++;
                    
                    // Only update if this looks like a player header
                    if (playerName && !th.querySelector('.player-icon')) {
                        const icon = createIconElement(playerKey, playerName);
                        icon.style.width = '24px';
                        icon.style.height = '24px';
                        icon.style.marginRight = '6px';
                        icon.style.display = 'inline-flex';
                        icon.style.alignItems = 'center';
                        icon.style.justifyContent = 'center';
                        icon.style.background = '#e2e8f0';
                        icon.style.borderRadius = '50%';
                        icon.style.fontSize = '0.875rem';
                        icon.style.fontWeight = '600';
                        icon.style.color = '#2d3748';
                        
                        th.insertBefore(icon, th.firstChild);
                    }
                });
            }
        });
    }
    
    // Update other player name displays
    function updateOtherPlayerDisplays() {
        // Update achievement bars
        const achievementNames = document.querySelectorAll('.achievement-name');
        achievementNames.forEach(nameEl => {
            const text = nameEl.textContent;
            const playerKey = findPlayerKeyByName(text);
            
            if (playerKey && !nameEl.querySelector('.player-icon')) {
                const icon = createIconElement(playerKey, text);
                icon.style.width = '20px';
                icon.style.height = '20px';
                icon.style.marginRight = '4px';
                icon.style.display = 'inline-flex';
                icon.style.alignItems = 'center';
                icon.style.justifyContent = 'center';
                icon.style.background = '#e2e8f0';
                icon.style.borderRadius = '50%';
                icon.style.fontSize = '0.75rem';
                icon.style.fontWeight = '600';
                icon.style.color = '#2d3748';
                
                nameEl.insertBefore(icon, nameEl.firstChild);
            }
        });
        
        // Update Analysis section player names
        const analysisPlayerNames = document.querySelectorAll('.worst-day-item > span:first-child, .best-day-item > span:first-child, .comeback-item > span:first-child');
        analysisPlayerNames.forEach(nameEl => {
            const text = nameEl.textContent;
            const playerKey = findPlayerKeyByName(text);
            
            if (playerKey && !nameEl.querySelector('.player-icon')) {
                const icon = createIconElement(playerKey, text);
                icon.style.width = '24px';
                icon.style.height = '24px';
                icon.style.marginRight = '8px';
                icon.style.display = 'inline-flex';
                icon.style.alignItems = 'center';
                icon.style.justifyContent = 'center';
                icon.style.background = '#e2e8f0';
                icon.style.borderRadius = '50%';
                icon.style.fontSize = '0.875rem';
                icon.style.fontWeight = '600';
                icon.style.color = '#2d3748';
                
                nameEl.insertBefore(icon, nameEl.firstChild);
            }
        });
        
        // Update mobile race card player labels
        const playerLabels = document.querySelectorAll('.player-label');
        playerLabels.forEach(labelEl => {
            const text = labelEl.textContent.replace(':', '').trim();
            const playerKey = findPlayerKeyByName(text);
            
            if (playerKey && !labelEl.querySelector('.player-icon')) {
                const icon = createIconElement(playerKey, text);
                icon.style.width = '20px';
                icon.style.height = '20px';
                icon.style.marginRight = '4px';
                icon.style.display = 'inline-flex';
                icon.style.alignItems = 'center';
                icon.style.justifyContent = 'center';
                icon.style.background = '#e2e8f0';
                icon.style.borderRadius = '50%';
                icon.style.fontSize = '0.75rem';
                icon.style.fontWeight = '600';
                icon.style.color = '#2d3748';
                
                labelEl.insertBefore(icon, labelEl.firstChild);
            }
        });
        
        // Update chart legends
        updateChartLegends();
    }
    
    // Find player key by name
    function findPlayerKeyByName(name) {
        if (!window.PlayerNameManager) return null;
        
        const allNames = window.PlayerNameManager.getAll();
        for (const [key, value] of Object.entries(allNames)) {
            if (value === name) return key;
        }
        return null;
    }
    
    // Update chart legends with icons
    function updateChartLegends() {
        // This would need to hook into Chart.js if used
        // For now, we'll look for common legend elements
        const legendItems = document.querySelectorAll('.chart-legend-item, [class*="legend"]');
        legendItems.forEach(item => {
            const text = item.textContent;
            const playerKey = findPlayerKeyByName(text);
            
            if (playerKey && !item.querySelector('.player-icon')) {
                const icon = createIconElement(playerKey, text);
                icon.style.width = '20px';
                icon.style.height = '20px';
                icon.style.marginRight = '4px';
                icon.style.display = 'inline-flex';
                icon.style.alignItems = 'center';
                icon.style.justifyContent = 'center';
                icon.style.background = '#e2e8f0';
                icon.style.borderRadius = '50%';
                icon.style.fontSize = '0.75rem';
                icon.style.fontWeight = '600';
                icon.style.color = '#2d3748';
                
                item.insertBefore(icon, item.firstChild);
            }
        });
    }
    
    // Handle icon changes (updates symbol or first letter)
    function handleIconChange(playerKey) {
        // Update all icons for this player
        const icons = document.querySelectorAll(`.player-icon[data-player="${playerKey}"]`);
        const playerName = window.PlayerNameManager ? 
            window.PlayerNameManager.get(playerKey) : playerKey;
        const symbol = window.PlayerSymbolManager ? window.PlayerSymbolManager.getSymbol(playerKey) : null;
        
        // Ensure we always have a valid name to get the first letter from
        let nameToUse = playerName;
        if (!nameToUse || nameToUse === 'undefined' || nameToUse === 'null') {
            // If no name or invalid name, use the playerKey (e.g., "player4")
            nameToUse = playerKey;
        }
        
        // Extract first character - if playerKey like "player4", get "P"
        const firstChar = nameToUse.charAt(0).toUpperCase() || 'P';
        const content = symbol || firstChar;
        
        icons.forEach(icon => {
            icon.textContent = content;
        });
    }
    
    // Handle name changes
    function handleNameChange() {
        // Rebuild all icons when names change
        updateAllPlayerIcons();
    }
    
    // Observe DOM changes to update new elements
    function observeDOMChanges() {
        const observer = new MutationObserver((mutations) => {
            // Check if mutations actually contain relevant changes
            const relevantChange = mutations.some(mutation => {
                // Skip if mutation is on icon picker or player icons themselves
                if (mutation.target.closest('.icon-picker') || 
                    mutation.target.classList.contains('player-icon')) {
                    return false;
                }
                
                // Check for actual structural changes that need icon updates
                return Array.from(mutation.addedNodes).some(node => {
                    if (node.nodeType === Node.ELEMENT_NODE) {
                        return node.querySelector && (
                            node.querySelector('label[id$="-label"]') ||
                            node.querySelector('table') ||
                            node.querySelector('.achievement-name') ||
                            node.querySelector('.worst-day-item span') ||
                            node.querySelector('.best-day-item span') ||
                            node.querySelector('.player-label')
                        );
                    }
                    return false;
                });
            });
            
            if (relevantChange) {
                // Debounce updates
                clearTimeout(window.iconUpdateTimeout);
                window.iconUpdateTimeout = setTimeout(() => {
                    updateAllPlayerIcons();
                }, 100);
            }
        });
        
        // Observe the main content area
        const mainContent = document.querySelector('body');
        if (mainContent) {
            observer.observe(mainContent, {
                childList: true,
                subtree: true
            });
        }
    }
    
    // Export for external use
    window.updateAllPlayerIcons = updateAllPlayerIcons;
})();