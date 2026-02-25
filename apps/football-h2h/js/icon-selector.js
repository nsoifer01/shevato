// Icon selector functionality for Football H2H

import { state, savePlayerIcons } from './store.js';
import { updatePlayerIconDisplays } from './player-manager.js';

export function openIconSelector(playerNumber) {
  state.currentPlayerForIcon = playerNumber;
  const playerName = playerNumber === 1 ? state.player1Name : state.player2Name;
  const iconModalTitle = document.getElementById('iconModalTitle');
  if (iconModalTitle) {
    iconModalTitle.textContent = `Select Icon for ${playerName}`;
  }

  showIconCategory('sports');

  const iconModal = document.getElementById('iconSelectorModal');
  if (iconModal) {
    iconModal.classList.add('active');
  }
}

export function closeIconSelector() {
  document.getElementById('iconSelectorModal').classList.remove('active');
  state.currentPlayerForIcon = null;
}

export function showIconCategory(category) {
  document.querySelectorAll('.category-btn').forEach((btn) => btn.classList.remove('active'));
  document.getElementById(category + 'Tab').classList.add('active');

  document.getElementById('sportsIconGrid').style.display = 'none';
  document.getElementById('animalsIconGrid').style.display = 'none';
  document.getElementById('generalIconGrid').style.display = 'none';

  document.getElementById(category + 'IconGrid').style.display = 'grid';
}

export function selectIcon(icon) {
  if (state.currentPlayerForIcon) {
    state.playerIcons[`player${state.currentPlayerForIcon}`] = icon;
    savePlayerIcons();
    updatePlayerIconDisplays();
    closeIconSelector();
  }
}

function buildIconGrid(gridEl, icons) {
  if (!gridEl) return;
  gridEl.innerHTML = '';
  icons.forEach((icon) => {
    const iconDiv = document.createElement('div');
    iconDiv.className = 'icon-item';
    const span = document.createElement('span');
    span.className = 'team-logo';
    span.textContent = icon;
    iconDiv.appendChild(span);
    iconDiv.onclick = () => selectIcon(icon);
    gridEl.appendChild(iconDiv);
  });
}

export function initializeIconGrids() {
  if (!window.GlobalIcons) {
    return;
  }

  buildIconGrid(document.getElementById('sportsIconGrid'), window.GlobalIcons.SPORTS);
  buildIconGrid(document.getElementById('animalsIconGrid'), window.GlobalIcons.ANIMALS);
  buildIconGrid(document.getElementById('generalIconGrid'), window.GlobalIcons.GENERAL);
}
