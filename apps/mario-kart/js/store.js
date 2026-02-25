// Central state for Mario Kart Race Tracker

export const state = {
  races: [],
  playerCount: 3,
  players: ['player1', 'player2', 'player3'],
  currentView: 'achievements',
  sortColumn: null,
  sortDirection: 'asc',
  selectedRaceDate: null,
  sidebarRaceFormOpen: false,
};
