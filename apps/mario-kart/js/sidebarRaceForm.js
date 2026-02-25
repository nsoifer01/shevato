// Sidebar race form and position picker functionality
// Extracted from main.js

import { state } from './store.js';

function showSidebarError(message) {
  const errorDiv = document.getElementById('sidebar-race-error');
  if (errorDiv) {
    errorDiv.textContent = message;
    errorDiv.classList.add('show');
    setTimeout(() => {
      errorDiv.classList.remove('show');
    }, 5000);
  }
}

function hideSidebarError() {
  const errorDiv = document.getElementById('sidebar-race-error');
  if (errorDiv) {
    errorDiv.classList.remove('show');
    errorDiv.textContent = '';
  }
}

export function toggleSidebarRaceForm() {
  const form = document.getElementById('sidebar-race-form');
  const button = document.getElementById('sidebar-add-race-btn');

  if (!form) return;

  if (state.sidebarRaceFormOpen) {
    closeSidebarRaceForm();
  } else {
    hideSidebarError();
    generateSidebarRaceInputs();
    form.offsetHeight;
    form.classList.add('open');
    button.classList.add('active');
    state.sidebarRaceFormOpen = true;

    setTimeout(() => {
      const firstInput = form.querySelector('input[type="number"]');
      if (firstInput) firstInput.focus();
    }, 350);
  }
}

export function closeSidebarRaceForm() {
  const form = document.getElementById('sidebar-race-form');
  const button = document.getElementById('sidebar-add-race-btn');
  const errorDiv = document.getElementById('sidebar-race-error');

  if (form) {
    form.classList.remove('open');
    if (button) button.classList.remove('active');
    state.sidebarRaceFormOpen = false;

    if (errorDiv) {
      errorDiv.classList.remove('show');
      errorDiv.textContent = '';
    }

    setTimeout(() => {
      const inputs = form.querySelectorAll('input[type="number"]');
      inputs.forEach((input) => (input.value = ''));
    }, 300);
  }
}

function generatePositionButtons(player) {
  let buttons = '';
  for (let i = 1; i <= window.MAX_POSITIONS; i++) {
    buttons += `
            <button
                type="button"
                class="position-btn"
                data-position="${i}"
                onclick="selectPosition('${player}', ${i})"
                title="Position ${i}"
            >
                ${i}
            </button>
        `;
  }
  return buttons;
}

export function generateSidebarRaceInputs() {
  const container = document.getElementById('sidebar-race-inputs');
  if (!container) return;

  const currentPlayerCount = state.playerCount;

  let html = '';
  for (let i = 0; i < currentPlayerCount; i++) {
    const player = state.players[i];
    const playerName = window.PlayerNameManager
      ? window.PlayerNameManager.get(player)
      : window.getPlayerName(player);

    html += `
            <div class="sidebar-player-input" data-player="${player}">
                <label for="sidebar-${player}">${playerName}</label>
                <div class="position-input-group">
                    <input
                        type="number"
                        id="sidebar-${player}"
                        min="${window.MIN_POSITIONS}"
                        max="${window.MAX_POSITIONS}"
                        placeholder="${window.MIN_POSITIONS}-${window.MAX_POSITIONS}"
                        class="sidebar-position-input"
                        onchange="updatePositionPicker('${player}', this.value)"
                        oninput="updatePositionPicker('${player}', this.value)"
                    >
                    <button
                        type="button"
                        class="position-picker-toggle"
                        onclick="togglePositionPicker('${player}')"
                        title="Choose position"
                    >
                        <span class="picker-icon">⊞</span>
                    </button>
                </div>
                <div class="position-picker" id="picker-${player}" style="display: none;">
                    <div class="picker-header">Select Position</div>
                    <div class="position-grid">
                        ${generatePositionButtons(player)}
                    </div>
                </div>
            </div>
        `;
  }

  container.innerHTML = html;

  setTimeout(() => {
    const inputs = container.querySelectorAll('input[type="number"]');
    inputs.forEach((input, index) => {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          if (index < inputs.length - 1) {
            inputs[index + 1].focus();
          } else {
            submitSidebarRace();
          }
        } else if (e.key === 'Escape') {
          closeSidebarRaceForm();
        }
      });
    });

    const positionPickers = container.querySelectorAll('.position-picker');
    positionPickers.forEach((picker) => {
      picker.addEventListener(
        'wheel',
        (e) => {
          e.stopPropagation();
        },
        { passive: true },
      );
      picker.addEventListener(
        'touchmove',
        (e) => {
          e.stopPropagation();
        },
        { passive: true },
      );
    });
  }, 100);
}

export function submitSidebarRace() {
  hideSidebarError();

  const sidebarDateInput = document.getElementById('sidebar-date-input');
  const mainDateInput = document.getElementById('date');

  const dateValue = sidebarDateInput?.value || new Date().toLocaleDateString('en-CA');

  if (!mainDateInput) {
    showSidebarError('Error: Date input not found');
    return;
  }

  mainDateInput.value = dateValue;

  const positions = {};
  let hasAnyInput = false;

  for (let i = 0; i < state.playerCount; i++) {
    const player = state.players[i];
    const sidebarInput = document.getElementById(`sidebar-${player}`);

    if (sidebarInput && sidebarInput.value) {
      const position = parseInt(sidebarInput.value);
      positions[player] = position;
      hasAnyInput = true;
    }
  }

  if (!hasAnyInput) {
    showSidebarError('Please enter at least one player position');
    return;
  }

  const activePositions = Object.values(positions);
  const minPlayers = state.playerCount === 1 ? 1 : 2;

  if (activePositions.length < minPlayers) {
    showSidebarError(
      `At least ${minPlayers} player${minPlayers > 1 ? 's' : ''} must have positions`,
    );
    return;
  }

  const invalidPositions = activePositions.filter(
    (pos) => pos < window.MIN_POSITIONS || pos > window.MAX_POSITIONS,
  );
  if (invalidPositions.length > 0) {
    showSidebarError(
      `Positions must be between ${window.MIN_POSITIONS} and ${window.MAX_POSITIONS}`,
    );
    return;
  }

  const uniquePositions = [...new Set(activePositions)];
  if (activePositions.length !== uniquePositions.length) {
    showSidebarError('Players cannot have the same position in a race');
    return;
  }

  for (let i = 0; i < state.playerCount; i++) {
    const player = state.players[i];
    const mainInput = document.getElementById(player);
    if (mainInput) {
      mainInput.value = positions[player] || '';
    }
  }

  const allPlayers = ['player1', 'player2', 'player3', 'player4'];
  for (let i = state.playerCount; i < 4; i++) {
    const mainInput = document.getElementById(allPlayers[i]);
    if (mainInput) mainInput.value = '';
  }

  const originalShowMessage = window.showMessage;
  let raceAdded = false;

  window.showMessage = function (message, isError) {
    if (isError) {
      showSidebarError(message);
    } else if (message.includes('successfully')) {
      raceAdded = true;
      originalShowMessage(message, isError);
    }
  };

  try {
    if (typeof window.addRace === 'function') {
      window.addRace();
      if (raceAdded) {
        closeSidebarRaceForm();
      }
    } else {
      showSidebarError('Error: addRace function not found');
    }
  } finally {
    window.showMessage = originalShowMessage;
  }
}

export function refreshSidebarRaceForm() {
  if (state.sidebarRaceFormOpen) {
    generateSidebarRaceInputs();
  }
}

export function togglePositionPicker(player) {
  const picker = document.getElementById(`picker-${player}`);
  const allPickers = document.querySelectorAll('.position-picker');

  allPickers.forEach((p) => {
    if (p.id !== `picker-${player}`) {
      p.style.display = 'none';
    }
  });

  if (picker) {
    const isOpen = picker.style.display === 'block';
    picker.style.display = isOpen ? 'none' : 'block';

    if (!isOpen) {
      const input = document.getElementById(`sidebar-${player}`);
      if (input && input.value) {
        updatePickerSelection(player, input.value);
      }
    }
  }
}

export function selectPosition(player, position) {
  const input = document.getElementById(`sidebar-${player}`);
  if (input) {
    input.value = position;
    input.dispatchEvent(new Event('change'));
  }

  updatePickerSelection(player, position);

  const picker = document.getElementById(`picker-${player}`);
  if (picker) {
    setTimeout(() => {
      picker.style.display = 'none';
    }, 150);
  }

  hideSidebarError();
}

export function updatePositionPicker(player, value) {
  updatePickerSelection(player, value);
}

function updatePickerSelection(player, position) {
  const picker = document.getElementById(`picker-${player}`);
  if (!picker) return;

  const buttons = picker.querySelectorAll('.position-btn');
  buttons.forEach((btn) => btn.classList.remove('selected'));

  if (position && position >= 1 && position <= window.MAX_POSITIONS) {
    const selectedBtn = picker.querySelector(`[data-position="${position}"]`);
    if (selectedBtn) {
      selectedBtn.classList.add('selected');
    }
  }
}

// Close position pickers when clicking outside
export function initClickOutsideHandler() {
  document.addEventListener('click', function (event) {
    const positionPickers = document.querySelectorAll('.position-picker');
    positionPickers.forEach((picker) => {
      const playerDiv = picker.closest('.sidebar-player-input');
      if (playerDiv && !playerDiv.contains(event.target)) {
        picker.style.display = 'none';
      }
    });

    const mainContainer = document.querySelector('.container');
    const actionButtons = document.querySelector('.action-buttons');
    const isOutsideMainContainer = mainContainer && !mainContainer.contains(event.target);
    const isOutsideActionButtons = actionButtons && !actionButtons.contains(event.target);

    if (isOutsideMainContainer && isOutsideActionButtons) {
      if (window.closeAllDropdowns) {
        window.closeAllDropdowns();
      }
    }
  });
}
