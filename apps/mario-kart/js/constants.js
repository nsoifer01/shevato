// Global constants for Mario Kart Race Tracker

// Game-specific maximum positions
export const GAME_MAX_POSITIONS = {
  mk8d: 12, // Mario Kart 8 Deluxe
  mkworld: 24, // Mario Kart World
};

// Minimum positions required (same for all games)
export const MIN_POSITIONS = 1;

// Maximum number of players
export const MAX_PLAYERS = 4;

// Get maximum positions for current game version
export function getMaxPositions() {
  // Use the getter function if available, otherwise fall back to window property
  const currentGameVersion =
    (window.getCurrentGameVersion && window.getCurrentGameVersion()) ||
    window.currentGameVersion ||
    'mk8d';
  return GAME_MAX_POSITIONS[currentGameVersion] || GAME_MAX_POSITIONS.mk8d;
}

// Dynamic MAX_POSITIONS that updates based on game version
export function updateMaxPositions() {
  window.MAX_POSITIONS = getMaxPositions();
}
