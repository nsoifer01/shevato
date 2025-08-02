// Update all position inputs to use global constants
document.addEventListener('DOMContentLoaded', function() {
    // Update all player position inputs
    const playerInputs = ['player1', 'player2', 'player3', 'player4'];
    
    playerInputs.forEach(playerId => {
        const input = document.getElementById(playerId);
        if (input) {
            input.min = MIN_POSITIONS;
            input.max = MAX_POSITIONS;
            input.placeholder = `${MIN_POSITIONS}-${MAX_POSITIONS}`;
        }
    });
});