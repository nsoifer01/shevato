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
    }
};