// Player name and icon display management for Football H2H

import { state, savePlayers } from './store.js';
import { renderGamesTable } from './game-display.js';
import { showToast } from './modalUtils.js';

export function handlePlayerNameChange() {
  const player1Input = document.getElementById('player1Name');
  const player2Input = document.getElementById('player2Name');

  if (player1Input) state.player1Name = player1Input.value || 'Player 1';
  if (player2Input) state.player2Name = player2Input.value || 'Player 2';

  applyPlayerNameChanges(state.player1Name, state.player2Name);
  showToast('Player names updated', 'success');
}

export function updatePlayerNames() {
  const player1Input = document.getElementById('player1Name');
  const player2Input = document.getElementById('player2Name');

  if (player1Input) state.player1Name = player1Input.value || 'Player 1';
  if (player2Input) state.player2Name = player2Input.value || 'Player 2';

  applyPlayerNameChanges(state.player1Name, state.player2Name);
  updatePlayerIconDisplays();
}

export function updatePlayerName(playerNumber, newName) {
  if (playerNumber === 1) {
    state.player1Name = newName || 'Player 1';
  } else if (playerNumber === 2) {
    state.player2Name = newName || 'Player 2';
  }

  applyPlayerNameChanges(state.player1Name, state.player2Name);
  showToast(`Player ${playerNumber} name updated`, 'success');
}

export function applyPlayerNameChanges(newPlayer1Name, newPlayer2Name) {
  state.player1Name = newPlayer1Name;
  state.player2Name = newPlayer2Name;

  savePlayers();

  if (window.refreshSidebarPlayerContent) {
    window.refreshSidebarPlayerContent();
  }

  const player1Stats = document.getElementById('player1StatsName');
  const player2Stats = document.getElementById('player2StatsName');
  if (player1Stats) player1Stats.textContent = state.player1Name;
  if (player2Stats) player2Stats.textContent = state.player2Name;

  const player1Header = document.getElementById('player1Header');
  const player2Header = document.getElementById('player2Header');

  if (player1Header) {
    const player1IconDisplay = state.playerIcons.player1 || '\u26BD';
    player1Header.innerHTML = `<span class="player-header-icon">${player1IconDisplay}</span> ${state.player1Name}`;
  }

  if (player2Header) {
    const player2IconDisplay = state.playerIcons.player2 || '\u26BD';
    player2Header.innerHTML = `<span class="player-header-icon">${player2IconDisplay}</span> ${state.player2Name}`;
  }

  const modalPlayer1Name = document.getElementById('modalPlayer1Name');
  const modalPlayer2Name = document.getElementById('modalPlayer2Name');
  const modalPlayer1TeamLabel = document.getElementById('modalPlayer1TeamLabel');
  const modalPlayer2TeamLabel = document.getElementById('modalPlayer2TeamLabel');

  if (modalPlayer1Name) modalPlayer1Name.textContent = state.player1Name;
  if (modalPlayer2Name) modalPlayer2Name.textContent = state.player2Name;
  if (modalPlayer1TeamLabel) modalPlayer1TeamLabel.textContent = state.player1Name;
  if (modalPlayer2TeamLabel) modalPlayer2TeamLabel.textContent = state.player2Name;

  const penaltyPlayer1Option = document.getElementById('penaltyPlayer1Option');
  const penaltyPlayer2Option = document.getElementById('penaltyPlayer2Option');
  if (penaltyPlayer1Option) penaltyPlayer1Option.textContent = state.player1Name;
  if (penaltyPlayer2Option) penaltyPlayer2Option.textContent = state.player2Name;

  const player1TeamHeader = document.getElementById('player1TeamHeader');
  const player2TeamHeader = document.getElementById('player2TeamHeader');
  if (player1TeamHeader) player1TeamHeader.textContent = `${state.player1Name}'s Team`;
  if (player2TeamHeader) player2TeamHeader.textContent = `${state.player2Name}'s Team`;

  renderGamesTable();
}

export function updatePlayerIconDisplays() {
  const player1IconDisplay = document.getElementById('player1IconDisplay');
  const player2IconDisplay = document.getElementById('player2IconDisplay');

  if (player1IconDisplay)
    player1IconDisplay.innerHTML = `<span class="team-logo">${state.playerIcons.player1}</span>`;
  if (player2IconDisplay)
    player2IconDisplay.innerHTML = `<span class="team-logo">${state.playerIcons.player2}</span>`;

  const player1DisplayName = document.getElementById('player1DisplayName');
  const player2DisplayName = document.getElementById('player2DisplayName');
  if (player1DisplayName) player1DisplayName.textContent = state.player1Name;
  if (player2DisplayName) player2DisplayName.textContent = state.player2Name;

  const player1Header = document.getElementById('player1Header');
  const player2Header = document.getElementById('player2Header');

  if (player1Header) {
    const p1Icon = state.playerIcons.player1 || '\u26BD';
    player1Header.innerHTML = `<span class="player-header-icon">${p1Icon}</span> ${state.player1Name}`;
  }

  if (player2Header) {
    const p2Icon = state.playerIcons.player2 || '\u26BD';
    player2Header.innerHTML = `<span class="player-header-icon">${p2Icon}</span> ${state.player2Name}`;
  }

  const playerModal = document.getElementById('playerManagementModal');
  if (playerModal && playerModal.classList.contains('active')) {
    if (window.updatePlayerModalContent) {
      window.updatePlayerModalContent();
    }
  }
}
