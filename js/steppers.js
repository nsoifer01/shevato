// Mobile Stepper Controls for Position Inputs

// Function to increment player position
function incrementPlayer(playerId) {
    const input = document.getElementById(playerId);
    const display = document.getElementById(playerId + '-display');
    
    let currentValue = parseInt(input.value) || 0;
    
    if (currentValue < 24) {
        currentValue++;
        input.value = currentValue;
        display.textContent = currentValue;
        
        // Trigger input event to update any existing listeners
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }
}

// Function to decrement player position
function decrementPlayer(playerId) {
    const input = document.getElementById(playerId);
    const display = document.getElementById(playerId + '-display');
    
    let currentValue = parseInt(input.value) || 2;
    
    if (currentValue > 1) {
        currentValue--;
        input.value = currentValue;
        display.textContent = currentValue;
        
        // Trigger input event to update any existing listeners
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }
}

// Function to update stepper display when input changes
function updateStepperDisplay(playerId) {
    const input = document.getElementById(playerId);
    const display = document.getElementById(playerId + '-display');
    
    if (input && display) {
        const value = input.value;
        display.textContent = value || '-';
    }
}

// Initialize steppers when page loads
document.addEventListener('DOMContentLoaded', function() {
    // Get all player inputs
    const playerInputs = ['player1', 'player2', 'player3', 'player4'];
    
    playerInputs.forEach(playerId => {
        const input = document.getElementById(playerId);
        const display = document.getElementById(playerId + '-display');
        
        if (input && display) {
            // Initialize display
            updateStepperDisplay(playerId);
            
            // Add event listener to sync input with display
            input.addEventListener('input', function() {
                updateStepperDisplay(playerId);
            });
            
            // Add event listener for direct input changes
            input.addEventListener('change', function() {
                updateStepperDisplay(playerId);
                
                // Validate range
                let value = parseInt(this.value);
                if (value < 1) {
                    this.value = 1;
                    updateStepperDisplay(playerId);
                } else if (value > 24) {
                    this.value = 24;
                    updateStepperDisplay(playerId);
                }
            });
        }
    });
});

// Add haptic feedback for mobile (if supported)
function addHapticFeedback() {
    if (navigator.vibrate) {
        navigator.vibrate(10); // Very short vibration
    }
}

// Enhanced increment with haptic feedback
function incrementPlayerWithFeedback(playerId) {
    incrementPlayer(playerId);
    addHapticFeedback();
}

// Enhanced decrement with haptic feedback
function decrementPlayerWithFeedback(playerId) {
    decrementPlayer(playerId);
    addHapticFeedback();
}

// Update the button onclick handlers to use feedback versions
document.addEventListener('DOMContentLoaded', function() {
    // Update all stepper buttons to use haptic feedback
    const stepperButtons = document.querySelectorAll('.stepper-btn');
    stepperButtons.forEach(button => {
        const originalOnclick = button.getAttribute('onclick');
        if (originalOnclick) {
            if (originalOnclick.includes('increment')) {
                const playerId = originalOnclick.match(/'([^']+)'/)[1];
                button.setAttribute('onclick', `incrementPlayerWithFeedback('${playerId}')`);
            } else if (originalOnclick.includes('decrement')) {
                const playerId = originalOnclick.match(/'([^']+)'/)[1];
                button.setAttribute('onclick', `decrementPlayerWithFeedback('${playerId}')`);
            }
        }
    });
});