// Global Icon Database for Shevato Apps
// This file contains icon categories that can be used across all applications

window.GlobalIcons = {
    // Sports category - 20 icons
    SPORTS: [
        '⚽', '🏀', '🏈', '⚾', '🎾', '🏐', '🏉', '🥎', '🏓', '🏸',
        '🥊', '🥋', '🏆', '🥇', '🥈', '🥉', '🏅', '🎯', '🏁', '🚀'
    ],
    
    // Animals category - 20 icons
    ANIMALS: [
        '🦁', '🐅', '🦅', '🐺', '🦈', '🐉', '🦄', '🐆', '🐻', '🐊',
        '🦎', '🐍', '🦇', '🦌', '🐗', '🦏', '🐘', '🦍', '🐒', '🦜'
    ],
    
    // General category - 20 icons
    GENERAL: [
        '👑', '💎', '🔥', '⚡', '🌟', '🎮', '🎲', '🎨', '🎵', '🎸',
        '🔮', '⚗️', '🧪', '🔬', '💰', '💻', '📱', '⌚', '🎭', '🎪'
    ],
    
    // Utility function to get all icons
    getAllIcons: function() {
        return [...this.SPORTS, ...this.ANIMALS, ...this.GENERAL];
    },
    
    // Utility function to get icons by category
    getIconsByCategory: function(category) {
        switch(category.toUpperCase()) {
            case 'SPORTS':
                return this.SPORTS;
            case 'ANIMALS':
                return this.ANIMALS;
            case 'GENERAL':
                return this.GENERAL;
            default:
                return [];
        }
    },
    
    // Utility function to get random icon from a category
    getRandomIcon: function(category = null) {
        let iconArray;
        if (category) {
            iconArray = this.getIconsByCategory(category);
        } else {
            iconArray = this.getAllIcons();
        }
        return iconArray[Math.floor(Math.random() * iconArray.length)];
    }
};

// Export for CommonJS environments if needed
if (typeof module !== 'undefined' && module.exports) {
    module.exports = window.GlobalIcons;
}