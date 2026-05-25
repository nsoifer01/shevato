// Global constants for Mario Kart Race Tracker

// Game-specific maximum positions
const GAME_MAX_POSITIONS = {
    mk8d: 12,    // Mario Kart 8 Deluxe
    mkworld: 24  // Mario Kart World
};

// Minimum positions required (same for all games)
const MIN_POSITIONS = 1;

// Maximum number of players
const MAX_PLAYERS = 4;

// Get maximum positions for current game version
function getMaxPositions() {
    // Use the getter function if available, otherwise fall back to window property
    const currentGameVersion = (window.getCurrentGameVersion && window.getCurrentGameVersion()) || window.currentGameVersion || 'mk8d';
    return GAME_MAX_POSITIONS[currentGameVersion] || GAME_MAX_POSITIONS.mk8d;
}

// Dynamic MAX_POSITIONS that updates based on game version
function updateMaxPositions() {
    window.MAX_POSITIONS = getMaxPositions();
}

// Initial setup
updateMaxPositions();

// MK8 Deluxe championship points (positions 1-12)
const MK8DX_POINTS = [15, 12, 10, 8, 7, 6, 5, 4, 3, 2, 1, 0];

// Mario Kart World championship points (positions 1-24)
const MKWORLD_POINTS = [
    30, 27, 24, 21, 18, 16, 14, 12, 10, 9, 8, 7,
    6, 5, 4, 3, 2, 1, 0, 0, 0, 0, 0, 0
];

function getPointsForPosition(position, gameVersion) {
    const ver = gameVersion || (window.getCurrentGameVersion && window.getCurrentGameVersion()) || 'mk8d';
    const table = ver === 'mkworld' ? MKWORLD_POINTS : MK8DX_POINTS;
    const idx = position - 1;
    if (idx < 0 || idx >= table.length) return 0;
    return table[idx];
}

// Valid game modes
const RACE_MODES = ['Items', 'No Items', '200cc'];
const DEFAULT_RACE_MODE = 'Items';

// Export for use in other files
window.MIN_POSITIONS = MIN_POSITIONS;
window.MAX_PLAYERS = MAX_PLAYERS;
window.GAME_MAX_POSITIONS = GAME_MAX_POSITIONS;
window.getMaxPositions = getMaxPositions;
window.updateMaxPositions = updateMaxPositions;
window.MK8DX_POINTS = MK8DX_POINTS;
window.MKWORLD_POINTS = MKWORLD_POINTS;
window.getPointsForPosition = getPointsForPosition;
window.RACE_MODES = RACE_MODES;
window.DEFAULT_RACE_MODE = DEFAULT_RACE_MODE;