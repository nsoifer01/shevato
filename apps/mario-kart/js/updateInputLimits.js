// Update all position inputs to use global constants
function updateInputLimits() {
    // Update all player position inputs
    const playerInputs = ['player1', 'player2', 'player3', 'player4'];
    
    playerInputs.forEach(playerId => {
        // Update main inputs
        const input = document.getElementById(playerId);
        if (input) {
            input.min = window.MIN_POSITIONS;
            input.max = window.MAX_POSITIONS;
            input.placeholder = `${window.MIN_POSITIONS}-${window.MAX_POSITIONS}`;
        }
        
        // Update sidebar inputs
        const sidebarInput = document.getElementById(`sidebar-${playerId}`);
        if (sidebarInput) {
            sidebarInput.min = window.MIN_POSITIONS;
            sidebarInput.max = window.MAX_POSITIONS;
            sidebarInput.placeholder = `${window.MIN_POSITIONS}-${window.MAX_POSITIONS}`;
        }
    });
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', function() {
    updateInputLimits();
});

// Export for global use
window.updateInputLimits = updateInputLimits;