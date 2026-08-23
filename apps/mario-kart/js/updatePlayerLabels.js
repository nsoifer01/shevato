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

            // The label is a plain <label>: it has no click handler, so it
            // must not advertise itself as a button or sit in the tab order.
            label.removeAttribute('data-tooltip');
            label.removeAttribute('title');
            label.removeAttribute('tabindex');
            label.removeAttribute('role');
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
