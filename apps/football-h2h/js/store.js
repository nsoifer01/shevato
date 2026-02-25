// Central state and persistence for Football H2H

export const STORAGE_KEY = 'footballH2HGames';
export const PLAYERS_KEY = 'footballH2HPlayers';
const ICONS_KEY = 'footballH2HPlayerIcons';

export const state = {
  games: [],
  player1Name: 'Player 1',
  player2Name: 'Player 2',
  playerIcons: { player1: '⚽', player2: '⚽' },
  currentEditId: null,
  currentSortColumn: 'date',
  currentSortDirection: 'desc',
  currentPlayerForIcon: null,
};

export function loadGames() {
  const savedGames = localStorage.getItem(STORAGE_KEY);
  if (savedGames) {
    state.games = JSON.parse(savedGames);

    // Migrate old games without dateTime
    let needsUpdate = false;
    state.games.forEach((game, index) => {
      if (!game.dateTime) {
        const daysBack = state.games.length - index;
        const fakeDate = new Date();
        fakeDate.setDate(fakeDate.getDate() - daysBack);
        game.dateTime = fakeDate.toISOString();
        game.lastModified = new Date().toISOString();
        needsUpdate = true;
      }
    });

    if (needsUpdate) {
      saveGames();
    }
  } else {
    state.games = [];
  }
}

export function saveGames() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.games));
}

export function loadPlayers() {
  const savedPlayers = localStorage.getItem(PLAYERS_KEY);
  if (savedPlayers) {
    const players = JSON.parse(savedPlayers);
    state.player1Name = players.player1 || 'Player 1';
    state.player2Name = players.player2 || 'Player 2';
  } else {
    state.player1Name = 'Player 1';
    state.player2Name = 'Player 2';
  }

  const player1Input = document.getElementById('player1Name');
  const player2Input = document.getElementById('player2Name');
  if (player1Input) player1Input.value = state.player1Name;
  if (player2Input) player2Input.value = state.player2Name;
}

export function savePlayers() {
  const players = {
    player1: state.player1Name,
    player2: state.player2Name,
  };
  localStorage.setItem(PLAYERS_KEY, JSON.stringify(players));
}

export function loadPlayerIcons() {
  const savedIcons = localStorage.getItem(ICONS_KEY);
  if (savedIcons) {
    state.playerIcons = JSON.parse(savedIcons);
  }
}

export function savePlayerIcons() {
  localStorage.setItem(ICONS_KEY, JSON.stringify(state.playerIcons));
}
