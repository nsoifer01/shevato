// Control Panel JavaScript - Relocated from Sidebar

// Toggle Player Settings Panel
function togglePlayerSettings() {
    const panel = document.getElementById('player-settings-panel');
    if (panel) {
        if (panel.style.display === 'none' || panel.style.display === '') {
            panel.style.display = 'block';
            // Load player settings if needed
            loadPlayerSettingsPanel();
        } else {
            panel.style.display = 'none';
        }
    }
}

// Load Player Settings into Panel
function loadPlayerSettingsPanel() {
    const panel = document.getElementById('player-settings-panel');
    if (!panel) return;
    
    // Get current player count
    const playerCount = getActivePlayerCount();
    
    // Generate player settings HTML
    let html = `
        <div class="player-settings-content">
            <h3>Player Configuration</h3>
            <div class="player-count-section">
                <label>Number of Players:</label>
                <div class="player-count-selector">
                    <button class="count-btn ${playerCount === 1 ? 'active' : ''}" onclick="setPlayerCount(1)">1</button>
                    <button class="count-btn ${playerCount === 2 ? 'active' : ''}" onclick="setPlayerCount(2)">2</button>
                    <button class="count-btn ${playerCount === 3 ? 'active' : ''}" onclick="setPlayerCount(3)">3</button>
                    <button class="count-btn ${playerCount === 4 ? 'active' : ''}" onclick="setPlayerCount(4)">4</button>
                </div>
            </div>
            <div class="players-list">
    `;
    
    for (let i = 1; i <= 4; i++) {
        const isActive = i <= playerCount;
        const playerName = localStorage.getItem(`player${i}Name`) || `Player ${i}`;
        const playerIcon = localStorage.getItem(`player${i}Icon`) || '🎮';
        
        html += `
            <div class="player-item ${isActive ? 'active' : 'inactive'}">
                <div class="player-icon" onclick="selectPlayerIcon(${i})">${playerIcon}</div>
                <input type="text" 
                       class="player-name-input" 
                       id="player${i}-name-input"
                       value="${playerName}"
                       onchange="updatePlayerName(${i}, this.value)"
                       ${!isActive ? 'disabled' : ''}
                       placeholder="Player ${i} Name">
            </div>
        `;
    }
    
    html += `
            </div>
            <button class="save-settings-btn" onclick="savePlayerSettings()">Save Settings</button>
        </div>
    `;
    
    panel.innerHTML = html;
}

// Get Active Player Count
function getActivePlayerCount() {
    return parseInt(localStorage.getItem('playerCount') || '3');
}

// Set Player Count
function setPlayerCount(count) {
    localStorage.setItem('playerCount', count);
    loadPlayerSettingsPanel();
    updatePlayerDisplay();
}

// Update Player Name
function updatePlayerName(playerNum, name) {
    if (name && name.trim()) {
        localStorage.setItem(`player${playerNum}Name`, name.trim());
        // Update display labels
        const label = document.getElementById(`player${playerNum}-label`);
        if (label) {
            label.textContent = name.trim();
        }
    }
}

// Select Player Icon
function selectPlayerIcon(playerNum) {
    const icons = ['🎮', '🏎️', '🏁', '⭐', '🔥', '💎', '🚀', '🎯', '⚡', '🌟', 
                   '🏆', '👑', '🥇', '🎲', '🎨', '🌈', '🦄', '🐉', '🦅', '🦁'];
    
    const currentIcon = localStorage.getItem(`player${playerNum}Icon`) || '🎮';
    const currentIndex = icons.indexOf(currentIcon);
    const nextIndex = (currentIndex + 1) % icons.length;
    const newIcon = icons[nextIndex];
    
    localStorage.setItem(`player${playerNum}Icon`, newIcon);
    loadPlayerSettingsPanel();
}

// Save Player Settings
function savePlayerSettings() {
    // Settings are already saved in real-time
    // This is just for user feedback
    const panel = document.getElementById('player-settings-panel');
    if (panel) {
        panel.style.display = 'none';
    }
    
    // Refresh the page or update displays
    if (typeof updateAllDisplays === 'function') {
        updateAllDisplays();
    }
    
    // Show success message
    showNotification('Settings saved successfully!', 'success');
}

// Update Player Display
function updatePlayerDisplay() {
    const playerCount = getActivePlayerCount();
    
    // Show/hide player input fields
    for (let i = 1; i <= 4; i++) {
        const field = document.getElementById(`player${i}-field`);
        if (field) {
            field.style.display = i <= playerCount ? 'block' : 'none';
        }
    }
}

// Set Date to Today
function setDateToday() {
    const dateInput = document.getElementById('date');
    if (dateInput) {
        const today = new Date();
        const yyyy = today.getFullYear();
        const mm = String(today.getMonth() + 1).padStart(2, '0');
        const dd = String(today.getDate()).padStart(2, '0');
        dateInput.value = `${yyyy}-${mm}-${dd}`;
    }
}

// Show Notification
function showNotification(message, type = 'info') {
    // Create notification element
    const notification = document.createElement('div');
    notification.className = `notification notification-${type}`;
    notification.textContent = message;
    
    // Add to body
    document.body.appendChild(notification);
    
    // Style the notification
    notification.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        padding: 15px 20px;
        background: ${type === 'success' ? '#10b981' : type === 'error' ? '#ef4444' : '#3b82f6'};
        color: white;
        border-radius: 8px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
        z-index: 10000;
        animation: slideIn 0.3s ease;
    `;
    
    // Remove after 3 seconds
    setTimeout(() => {
        notification.style.animation = 'slideOut 0.3s ease';
        setTimeout(() => notification.remove(), 300);
    }, 3000);
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', function() {
    // Set default date to today
    setDateToday();
    
    // Update player display based on saved count
    updatePlayerDisplay();
    
    // Remove any sidebar initialization calls
    if (typeof initializeSidebar !== 'undefined') {
        // Override sidebar initialization
        window.initializeSidebar = function() {
            console.log('Sidebar has been removed - using control panel instead');
        };
    }
});

// Export functions for global use
window.togglePlayerSettings = togglePlayerSettings;
window.setPlayerCount = setPlayerCount;
window.updatePlayerName = updatePlayerName;
window.selectPlayerIcon = selectPlayerIcon;
window.savePlayerSettings = savePlayerSettings;
window.setDateToday = setDateToday;
window.showNotification = showNotification;