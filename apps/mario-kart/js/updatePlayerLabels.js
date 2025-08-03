// Update player labels to show actual player names
function updatePlayerLabels() {
    const allPlayers = ['player1', 'player2', 'player3', 'player4'];
    
    allPlayers.forEach(playerId => {
        const label = document.getElementById(`${playerId}-label`);
        
        if (label) {
            // Use centralized PlayerNameManager
            const playerName = window.PlayerNameManager ? 
                window.PlayerNameManager.get(playerId) : 
                (playerNames && playerNames[playerId] ? playerNames[playerId] : playerId);
            label.textContent = playerName;

            // Only add tooltip if not in achievements view
            if (!label.closest('#achievements-container')) {
                label.setAttribute('data-tooltip', `${playerName} - Click to customize icon`);
                label.setAttribute('tabindex', '0');
                label.setAttribute('role', 'button');
            } else {
                // Remove tooltip attributes if in achievements view
                label.removeAttribute('data-tooltip');
                label.removeAttribute('title');
            }
        }
    });
}

// Listen for player name changes
document.addEventListener('DOMContentLoaded', function() {
    // Subscribe to centralized name changes
    if (window.PlayerNameManager) {
        window.PlayerNameManager.subscribe(() => {
            updatePlayerLabels();
        });
    } else {
        // Fallback: Listen to DOM changes
        const allPlayers = ['player1', 'player2', 'player3', 'player4'];
        allPlayers.forEach(playerId => {
            const nameInput = document.getElementById(`${playerId}-name`);
            if (nameInput) {
                nameInput.addEventListener('input', updatePlayerLabels);
                nameInput.addEventListener('change', updatePlayerLabels);
            }
        });
        
        // Also update when dropdown opens/closes
        const originalUpdatePlayerName = window.updatePlayerName;
        if (originalUpdatePlayerName) {
            window.updatePlayerName = function(player, name) {
                originalUpdatePlayerName(player, name);
                updatePlayerLabels();
            };
        }
    }
    
    // Initial update
    updatePlayerLabels();
});

// Export for external use
window.updatePlayerLabels = updatePlayerLabels;
