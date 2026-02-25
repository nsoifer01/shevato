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

export function initializeIconGrids() {
  if (!window.GlobalIcons) {
    return;
  }

  const sportsGrid = document.getElementById('sportsIconGrid');
  if (sportsGrid) {
    sportsGrid.innerHTML = '';
    window.GlobalIcons.SPORTS.forEach((icon) => {
      const iconDiv = document.createElement('div');
      iconDiv.className = 'icon-item';
      iconDiv.innerHTML = `<span class="team-logo">${icon}</span>`;
      iconDiv.onclick = () => selectIcon(icon);
      sportsGrid.appendChild(iconDiv);
    });
  }

  const animalsGrid = document.getElementById('animalsIconGrid');
  if (animalsGrid) {
    animalsGrid.innerHTML = '';
    window.GlobalIcons.ANIMALS.forEach((icon) => {
      const iconDiv = document.createElement('div');
      iconDiv.className = 'icon-item';
      iconDiv.innerHTML = `<span class="team-logo">${icon}</span>`;
      iconDiv.onclick = () => selectIcon(icon);
      animalsGrid.appendChild(iconDiv);
    });
  }

  const generalGrid = document.getElementById('generalIconGrid');
  if (generalGrid) {
    generalGrid.innerHTML = '';
    window.GlobalIcons.GENERAL.forEach((icon) => {
      const iconDiv = document.createElement('div');
      iconDiv.className = 'icon-item';
      iconDiv.innerHTML = `<span class="team-logo">${icon}</span>`;
      iconDiv.onclick = () => selectIcon(icon);
      generalGrid.appendChild(iconDiv);
    });
  }
}
