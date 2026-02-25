// View switching and view creation
// Extracted from main.js

import { state } from './store.js';

// TODO: Phase 4 - Replace with import from shared/utils/toast.js (showToast)
export function showMessage(message, isError = false) {
  const messageDiv = document.createElement('div');
  messageDiv.style.cssText = `
        position: fixed;
        top: 80px;
        left: 50%;
        transform: translateX(-50%);
        padding: 15px 30px;
        background: ${isError ? '#ef4444' : '#10b981'};
        color: white;
        border-radius: 8px;
        font-weight: 600;
        box-shadow: 0 4px 15px rgba(0, 0, 0, 0.2);
        z-index: 9999;
        animation: slideDown 0.3s ease;
    `;
  messageDiv.textContent = message;

  const style = document.createElement('style');
  style.textContent = `
        @keyframes slideDown {
            from { transform: translate(-50%, -100%); opacity: 0; }
            to { transform: translate(-50%, 0); opacity: 1; }
        }
    `;
  document.head.appendChild(style);

  document.body.appendChild(messageDiv);

  setTimeout(() => {
    messageDiv.remove();
    style.remove();
  }, 3000);
}

export function toggleView(view) {
  const inputSection = document.querySelector('.input-section');

  if (state.currentView === 'achievements' && view !== 'achievements') {
    const inputGroup = document.querySelector('.input-group');
    if (inputGroup && inputSection && inputGroup.parentElement !== inputSection) {
      inputSection.appendChild(inputGroup);
    }
  }

  state.currentView = view;

  if (window.GlobalPaginationManager) {
    window.GlobalPaginationManager.reset('mario-kart-races');
  }

  document.querySelectorAll('.toggle-btn').forEach((btn) => {
    const isActive = btn.textContent.toLowerCase().includes(view);
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', isActive);
  });

  const barContainers = document.querySelectorAll('.bar-container');
  barContainers.forEach((container) => (container.style.display = 'none'));

  if (inputSection) {
    inputSection.style.display = 'none';
  }

  const raceHistorySection = document.querySelector('.race-history');
  if (raceHistorySection) {
    if (view === 'help' || view === 'guide') {
      raceHistorySection.style.display = 'none';
    } else {
      raceHistorySection.style.display = 'block';
    }
  }

  const todayButton = document.querySelector('.filter-btn[onclick*="today"]');
  if (todayButton) {
    if (view === 'activity') {
      todayButton.style.background = '#6b7280';
      todayButton.style.cursor = 'not-allowed';
      todayButton.disabled = true;

      if (window.currentDateFilter === 'today') {
        window.setDateFilter('all');
        return;
      }
    } else {
      todayButton.style.background = '';
      todayButton.style.cursor = '';
      todayButton.disabled = false;
    }
  }

  window.updateDisplay();
}

export function createH2HView(raceData = null) {
  if (raceData === null) {
    raceData = window.getFilteredRaces();
  }

  const statsDisplay = document.getElementById('stats-display');

  if (raceData.length === 0 || state.playerCount <= 1) {
    statsDisplay.innerHTML = `
            <div class="no-data-message">
                <div style="text-align: center; padding: 60px 20px; color: #718096;">
                    <h3 style="font-size: 1.5em; margin-bottom: 10px;">
                        ${state.playerCount <= 1 ? 'Head-to-Head requires at least 2 players' : 'No race data available'}
                    </h3>
                    <p>${state.playerCount <= 1 ? 'Add more players to see head-to-head statistics!' : 'Add some races to see head-to-head comparisons!'}</p>
                </div>
            </div>
        `;
    return;
  }

  const stats = window.calculateStats(raceData);

  statsDisplay.innerHTML = `
        <div class="h2h-container">
            <div class="stat-card h2h-card">
                <div class="h2h-daily-breakdown">
                    <div class="stat-title">Global Head to Head</div>
                    ${window.generateH2HTable(stats)}
                </div>

                <div class="h2h-daily-breakdown">
                    <div class="stat-title">Daily Head to Head</div>
                    ${window.generateDailyH2HTable(stats)}
                </div>
            </div>
        </div>
    `;

  if (window.updateAllPlayerIcons) {
    setTimeout(() => {
      window.updateAllPlayerIcons();
    }, 100);
  }
}

export function createGuideView() {
  const statsDisplay = document.getElementById('stats-display');

  statsDisplay.innerHTML = `
        <div class="guide-container">
            <div class="bars-legend visualization-guide-main">
                <h3>\u{1f4ca} Visualization Guide</h3>
                <div class="viz-guide-grid">
                    <div class="viz-guide-card">
                        <h4>\u{1f31f} Achievements</h4>
                        <p>Compare racing milestones with friends</p>
                        <p class="viz-tip tips-text">\u{1f4a1} <span class="viz-color-green">Best (green)</span> \u2022 <span class="viz-color-yellow">2nd (yellow, 3+ players)</span> \u2022 <span class="viz-color-red">Worst (red)</span> \u2022 <span class="viz-color-gray">Ties (gray)</span></p>
                    </div>
                    <div class="viz-guide-card">
                        <h4>\u{1f321}\ufe0f Position Heat Map</h4>
                        <p>Percentage breakdown by finishing ranges</p>
                        <p class="viz-tip tips-text" id="position-heat-tip">\u{1f4a1} <span class="viz-color-green tier-range-numbers">Loading...</span></p>
                    </div>
                    <div class="viz-guide-card">
                        <h4>\u{1f3c1} Recent Streak</h4>
                        <p>Your last 10 races at a glance (left to right)</p>
                        <p class="viz-tip tips-text" id="recent-streak-tip">\u{1f4a1} Shows finishing positions with gradient colors: <span class="viz-color-green">1st (green)</span> to <span class="viz-color-red" id="max-position-text">Loading...</span></p>
                    </div>
                    <div class="viz-guide-card">
                        <h4>\u{1f3af} Sweet Spots</h4>
                        <p>Color transparency shows finishing frequency</p>
                        <div class="viz-tip viz-tip-content tips-text">
                            <span>\u{1f4a1} Frequency:</span>
                            <span class="frequency-gradient alternate-theme hidden">
                                <span class="viz-color-indicator frequency-low">Low</span>
                                <span class="viz-color-indicator frequency-medium">Medium</span>
                                <span class="viz-color-indicator frequency-high">High</span>
                            </span>
                            <span class="frequency-gradient theme-variant">
                                <span class="viz-color-indicator frequency-low">Low</span>
                                <span class="viz-color-indicator frequency-medium">Medium</span>
                                <span class="viz-color-indicator frequency-high">High</span>
                            </span>
                        </div>
                    </div>
                </div>

                <section class="achievement-details" aria-labelledby="achievement-targets-heading">
                    <h4 id="achievement-targets-heading">\u{1f4ca} Achievement Targets</h4>
                    <div class="achievement-expanded-grid" role="list">
                        <article class="achievement-expanded-item" role="listitem" tabindex="0" aria-label="Win Streak achievement">
                            <span class="achievement-icon-big" aria-hidden="true">\u{1f3c6}</span>
                            <div class="achievement-info">
                                <strong class="legend-title">Win Streak</strong>
                                <small>Consecutive 1st place finishes</small>
                            </div>
                        </article>
                        <article class="achievement-expanded-item" role="listitem" tabindex="0" aria-label="Hot Streak achievement">
                            <span class="achievement-icon-big" aria-hidden="true">\u{1f525}</span>
                            <div class="achievement-info">
                                <strong class="legend-title">Hot Streak</strong>
                                <small>Consecutive podium finishes</small>
                            </div>
                        </article>
                        <article class="achievement-expanded-item" role="listitem" tabindex="0" aria-label="Clutch Master achievement">
                            <span class="achievement-icon-big" aria-hidden="true">\u{1f4aa}</span>
                            <div class="achievement-info">
                                <strong class="legend-title">Clutch Master</strong>
                                <small>Consecutive races finishing better than average</small>
                            </div>
                        </article>
                        <article class="achievement-expanded-item" role="listitem" tabindex="0" aria-label="Momentum Builder achievement">
                            <span class="achievement-icon-big" aria-hidden="true">\u{1f680}</span>
                            <div class="achievement-info">
                                <strong class="legend-title">Momentum Builder</strong>
                                <small>Consecutive races with improving positions</small>
                            </div>
                        </article>
                        <article class="achievement-expanded-item" role="listitem" tabindex="0" aria-label="Perfect Day achievement">
                            <span class="achievement-icon-big" aria-hidden="true">\u{1f4c5}</span>
                            <div class="achievement-info">
                                <strong class="legend-title">Perfect Day</strong>
                                <small id="perfect-day-description">All races in a day were good finishes</small>
                            </div>
                        </article>
                    </div>
                </section>
            </div>
        </div>
    `;

  const lightGradients = document.querySelectorAll('.frequency-gradient.alternate-theme');
  const darkGradients = document.querySelectorAll('.frequency-gradient.theme-variant');

  lightGradients.forEach((el) => (el.style.display = 'none'));
  darkGradients.forEach((el) => (el.style.display = 'inline-flex'));
}

export function getPositionClass(position) {
  const ranges = window.getPositionRanges ? window.getPositionRanges() : getDefaultPositionRanges();

  if (position === 1) return 'pos-1';
  if (position === 2) return 'pos-2';
  if (position === 3) return 'pos-3';

  for (const range of ranges) {
    const [min, max] = range.range;
    if (position >= min && position <= max) {
      return `pos-${range.label.replace('-', '-')}`.replace(/\s/g, '-');
    }
  }

  return `pos-${ranges[ranges.length - 1].label.replace('-', '-')}`.replace(/\s/g, '-');
}

function getDefaultPositionRanges() {
  return [
    { label: '1-6', range: [1, 6] },
    { label: '7-12', range: [7, 12] },
    { label: '13-18', range: [13, 18] },
    { label: '19-24', range: [19, 24] },
  ];
}

export function updateDynamicUIText() {
  const heatTip = document.getElementById('position-heat-tip');
  if (heatTip && window.getPositionRanges) {
    const ranges = window.getPositionRanges();
    heatTip.textContent = '';
    heatTip.appendChild(document.createTextNode('\u{1f4a1} '));
    ranges.forEach((range, index) => {
      const colorClass =
        index === 0 ? 'viz-color-green' : index === 1 ? 'viz-color-yellow' : 'viz-color-red';
      const span = document.createElement('span');
      span.className = `${colorClass} tier-range-numbers`;
      span.textContent = range.label;
      heatTip.appendChild(span);
      if (index < ranges.length - 1) heatTip.appendChild(document.createTextNode(' \u2022 '));
    });
  }

  const maxPosText = document.getElementById('max-position-text');
  if (maxPosText && window.MAX_POSITIONS) {
    maxPosText.textContent = `${window.MAX_POSITIONS}th (red)`;
  }

  const perfectDayDesc = document.getElementById('perfect-day-description');
  if (perfectDayDesc && window.getGoodFinishThreshold) {
    const threshold = window.getGoodFinishThreshold();
    perfectDayDesc.textContent = `All races in a day were top-${threshold} finishes`;
  }

  const positionRangesHelp = document.getElementById('position-ranges-help');
  if (positionRangesHelp && window.getPositionRanges) {
    const ranges = window.getPositionRanges();
    const ul = document.createElement('ul');
    ul.setAttribute('role', 'list');
    ranges.forEach((range, index) => {
      const tierName =
        index === 0
          ? 'Top tier'
          : index === 1
            ? 'Mid-tier'
            : index === ranges.length - 1
              ? 'Bottom tier'
              : 'Lower tier';
      const li = document.createElement('li');
      const strong = document.createElement('strong');
      strong.textContent = range.label + ':';
      li.appendChild(strong);
      li.appendChild(document.createTextNode(' ' + tierName + ' finishes'));
      ul.appendChild(li);
    });
    positionRangesHelp.textContent = '';
    positionRangesHelp.appendChild(ul);
  }
}

export function getRelativePositionClass(playerPosition, allPositions) {
  const validPositions = allPositions.filter((pos) => pos !== null).sort((a, b) => a - b);

  if (validPositions.length <= 1) return 'best';

  const playerRank = validPositions.indexOf(playerPosition);

  if (playerRank === 0) return 'best';
  if (playerRank === validPositions.length - 1) return 'worst';
  return 'second';
}

export function createHelpView() {
  const statsDisplay = document.getElementById('stats-display');

  const helpPanel = document.getElementById('help-panel');
  if (!helpPanel) {
    statsDisplay.innerHTML = '<p>Help content not found.</p>';
    return;
  }

  const helpContent = helpPanel.querySelector('.help-content');
  if (!helpContent) {
    statsDisplay.innerHTML = '<p>Help content not found.</p>';
    return;
  }

  statsDisplay.innerHTML = `
        <div class="help-view-container" style="padding: 20px; max-width: 1200px; margin: 0 auto;">
            ${helpContent.innerHTML}
        </div>
    `;
}

export function createAchievementsView(raceData = null) {
  if (raceData === null) {
    raceData = window.getFilteredRaces();
  }

  const statsDisplay = document.getElementById('stats-display');

  let inputGroup = document.querySelector('.input-group');
  if (inputGroup && !inputGroup.dataset.originalParent) {
    inputGroup.dataset.originalParent = 'body';
    if (inputGroup.parentElement) {
      const calendarDropdown = document.getElementById('calendar-dropdown');
      if (calendarDropdown && calendarDropdown.nextElementSibling === inputGroup) {
        inputGroup.dataset.originalParent = 'after-calendar-dropdown';
      }
    }
  }

  if (raceData.length === 0) {
    if (inputGroup && statsDisplay.contains(inputGroup)) {
      if (inputGroup.dataset.originalParent === 'after-calendar-dropdown') {
        const calendarDropdown = document.getElementById('calendar-dropdown');
        if (calendarDropdown && calendarDropdown.parentElement) {
          calendarDropdown.parentElement.insertBefore(inputGroup, calendarDropdown.nextSibling);
        } else {
          document.body.appendChild(inputGroup);
        }
      } else {
        document.body.appendChild(inputGroup);
      }
      inputGroup.style.display = 'none';
    }

    statsDisplay.innerHTML = `
            <div class="no-data-message">
                <div style="text-align: center; padding: 60px 20px; color: #718096;">
                    <h3 style="font-size: 1.5em; margin-bottom: 10px;">No race data available</h3>
                    <p>Add some races to see achievements!</p>
                </div>
            </div>
        `;
    return;
  }

  let achievementsViewContainer = document.querySelector('.achievements-view-container');
  let achievementsContainer = document.getElementById('achievements-container');

  if (!achievementsViewContainer) {
    statsDisplay.innerHTML = `
            <div class="achievements-view-container">
                <div id="achievements-container"></div>
            </div>
        `;
    achievementsViewContainer = document.querySelector('.achievements-view-container');
    achievementsContainer = document.getElementById('achievements-container');
  } else {
    if (!statsDisplay.contains(achievementsViewContainer)) {
      statsDisplay.innerHTML = '';
      statsDisplay.appendChild(achievementsViewContainer);
    }
  }

  if (inputGroup && achievementsContainer) {
    if (inputGroup.parentElement !== achievementsContainer) {
      achievementsContainer.appendChild(inputGroup);
    }

    inputGroup.style.display = '';

    const barContainers = inputGroup.querySelectorAll('.bar-container');
    barContainers.forEach((container) => (container.style.display = 'block'));

    const inputs = inputGroup.querySelectorAll('input[type="number"]');
    const steppers = inputGroup.querySelectorAll('.input-stepper');
    inputs.forEach((input) => (input.style.display = 'none'));
    steppers.forEach((stepper) => (stepper.style.display = 'none'));

    window.updateAchievements(raceData);

    if (typeof window.updatePlayerLabels === 'function') {
      window.updatePlayerLabels();
    }
  }
}
