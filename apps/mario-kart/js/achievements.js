// Helper function to get "good finish" threshold (top half)
function getGoodFinishThreshold() {
    return Math.floor(window.MAX_POSITIONS / 2);
}

// Helper function to get position ranges for current game mode
function getPositionRanges() {
    // Get current game version from the getter function or window property
    const currentGameVersion = (window.getCurrentGameVersion && window.getCurrentGameVersion()) || window.currentGameVersion || 'mk8d';
    
    if (currentGameVersion === 'mkworld') {
        // MK World ranges (24 positions)
        return [
            { label: '1-6', range: [1, 6], color: '#10b981' },
            { label: '7-12', range: [7, 12], color: '#3b82f6' },
            { label: '13-18', range: [13, 18], color: '#f59e0b' },
            { label: '19-24', range: [19, 24], color: '#ef4444' }
        ];
    } else {
        // MK8 Deluxe ranges (12 positions) - default
        return [
            { label: '1-3', range: [1, 3], color: '#10b981' },
            { label: '4-6', range: [4, 6], color: '#3b82f6' },
            { label: '7-9', range: [7, 9], color: '#f59e0b' },
            { label: '10-12', range: [10, 12], color: '#ef4444' }
        ];
    }
}

const ACHIEVEMENTS = {
    winStreak: {
        name: 'Win Streak',
        icon: '🏆',
        targets: [3, 5, 10],
        colors: ['#fbbf24', '#f59e0b', '#d97706'],
        description: 'Consecutive 1st place finishes'
    },
    hotStreak: {
        name: 'Hot Streak',
        icon: '🔥',
        targets: [3, 5, 8],
        colors: ['#f87171', '#ef4444', '#dc2626'],
        description: 'Consecutive podium finishes'
    },
    clutchMaster: {
        name: 'Clutch Master',
        icon: '💪',
        targets: [3, 5, 8],
        colors: ['#60a5fa', '#3b82f6', '#2563eb'],
        description: 'Consecutive races finishing better than average'
    },
    momentumBuilder: {
        name: 'Momentum',
        icon: '🚀',
        targets: [3, 4, 5],
        colors: ['#a78bfa', '#8b5cf6', '#7c3aed'],
        description: 'Consecutive races with improving positions'
    },
    perfectDay: {
        name: 'Perfect Day',
        icon: '📅',
        targets: [1, 3, 5],
        colors: ['#34d399', '#10b981', '#059669'],
        description: 'All races in a day were good finishes (top half)'
    }
};

function createAllBars() {
    createAchievements();
    createPositionHeatBars();
    createRecentStreakBars();
    createSweetSpotBars();
}

function createAchievements() {
    players.forEach(player => {
        const container = document.getElementById(player + '-achievements');
        // Skip if container doesn't exist (e.g., player field is hidden)
        if (!container) return;
        container.innerHTML = '';

        // Create a compact grid of achievement bars
        const barsContainer = document.createElement('div');
        barsContainer.className = 'achievement-bars-grid';

        Object.keys(ACHIEVEMENTS).forEach(achievementKey => {
            const achievement = ACHIEVEMENTS[achievementKey];
            
            // Create the achievement bar
            const barElement = document.createElement('div');
            barElement.className = 'achievement-bar';
            barElement.style.cursor = 'pointer';
            barElement.setAttribute('tabindex', '0');
            barElement.setAttribute('role', 'button');
            barElement.setAttribute('aria-label', `${achievement.name}: ${achievement.description}`);
            barElement.setAttribute('title', achievement.description);
            barElement.onclick = () => toggleAchievementDetails(player, achievementKey);
            barElement.onkeydown = (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    toggleAchievementDetails(player, achievementKey);
                }
            };
            barElement.innerHTML = `
                <div class="achievement-icon">${achievement.icon}</div>
                <div class="achievement-number" data-player="${player}" data-achievement="${achievementKey}">0</div>
            `;
            
            // Add bar to grid
            barsContainer.appendChild(barElement);
        });

        container.appendChild(barsContainer);
        
        // Check if there are any achievements with data
        const hasExpandableData = Object.keys(ACHIEVEMENTS).some(achievementKey => {
            const achievement = ACHIEVEMENTS[achievementKey];
            const allAchievements = calculateAchievements(player, getFilteredRaces());
            const achievementData = allAchievements[achievementKey];
            return achievementData && achievementData.current > 0;
        });
        
        if (hasExpandableData) {
            // Create button container for active button
            const buttonContainer = document.createElement('div');
            buttonContainer.className = 'achievement-buttons-container';
            
            // Check if there are any active streaks before showing active button
            const hasActiveStreaks = Object.keys(ACHIEVEMENTS).some(achievementKey => {
                const allAchievements = calculateAchievements(player, getFilteredRaces());
                const achievementData = allAchievements[achievementKey];
                return checkForActiveStreak(achievementKey, achievementData, player, getFilteredRaces());
            });
            
            if (hasActiveStreaks) {
                // Create expand/collapse active active button
                const toggleActiveButton = document.createElement('div');
                toggleActiveButton.className = 'achievement-toggle-active-btn';
                toggleActiveButton.id = `${player}-toggle-active-achievements`;
                toggleActiveButton.innerHTML = `
                    <span class="toggle-active-text">Expand Active</span>
                    <span class="toggle-active-icon">▼</span>
                `;
                toggleActiveButton.onclick = () => toggleActiveStreaks(player);
                buttonContainer.appendChild(toggleActiveButton);
            }
            
            // Insert button container after the achievement bars grid
            container.appendChild(buttonContainer);
        }
        
        // Create expanded achievements section
        const expandedSection = document.createElement('div');
        expandedSection.className = 'expanded-achievements';
        expandedSection.id = `${player}-expanded-achievements`;
        expandedSection.innerHTML = `
            <div class="expanded-achievements-list"></div>
        `;
        
        container.appendChild(expandedSection);
    });
}

function createPositionHeatBars() {
    players.forEach(player => {
        const container = document.getElementById(player + '-position-heat');
        // Skip if container doesn't exist
        if (!container) return;
        container.innerHTML = '';

        const heatContainer = document.createElement('div');
        heatContainer.className = 'position-heat-grid';

        // Create bars for position ranges (dynamic ranges based on game mode)
        const ranges = getPositionRanges();

        ranges.forEach((rangeData, index) => {
            const barElement = document.createElement('div');
            barElement.className = 'position-heat-bar';
            barElement.setAttribute('tabindex', '0');
            barElement.setAttribute('role', 'button');
            barElement.setAttribute('aria-label', `Position range ${rangeData.label}: 0% of races`);
            barElement.onclick = () => togglePositionHeatDetails(player, index);
            barElement.onkeydown = (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    togglePositionHeatDetails(player, index);
                }
            };

            barElement.innerHTML = `
                <div class="heat-label">${rangeData.label}</div>
                <div class="heat-percentage" data-player="${player}" data-range="${index}">0%</div>
            `;

            heatContainer.appendChild(barElement);
        });

        container.appendChild(heatContainer);
        
        // Create expanded position heat section
        const expandedHeatSection = document.createElement('div');
        expandedHeatSection.className = 'expanded-position-heat';
        expandedHeatSection.id = `${player}-expanded-position-heat`;
        expandedHeatSection.innerHTML = `
            <div class="expanded-position-heat-title" style="display: none;">Position Details:</div>
            <div class="expanded-position-heat-list"></div>
        `;
        
        container.appendChild(expandedHeatSection);
    });
}

function createRecentStreakBars() {
    players.forEach(player => {
        const container = document.getElementById(player + '-recent-streak');
        // Skip if container doesn't exist
        if (!container) return;
        container.innerHTML = '';

        const streakContainer = document.createElement('div');
        streakContainer.className = 'recent-streak-grid';

        // Create 10 segments for last 10 races
        for (let i = 0; i < 10; i++) {
            const segmentElement = document.createElement('div');
            segmentElement.className = 'streak-segment';
            // Only add aria-label for the latest race (i === 0) for accessibility
            if (i === 0) {
                segmentElement.setAttribute('aria-label', 'Latest race position: Unknown');
            }

            segmentElement.innerHTML = `
                <div class="streak-position" data-player="${player}" data-race="${i}">-</div>
            `;

            streakContainer.appendChild(segmentElement);
        }

        container.appendChild(streakContainer);
    });
}

function createSweetSpotBars() {
    players.forEach(player => {
        const container = document.getElementById(player + '-sweet-spot');
        // Skip if container doesn't exist
        if (!container) return;
        container.innerHTML = '';

        const spotContainer = document.createElement('div');
        spotContainer.className = 'sweet-spot-grid';

        // Create highlights for positions based on current game mode
        for (let i = window.MIN_POSITIONS; i <= window.MAX_POSITIONS; i++) {
            const spotElement = document.createElement('div');
            spotElement.className = 'sweet-spot-bar';
            spotElement.setAttribute('aria-label', `Position ${i}: Never finished here`);

            spotElement.innerHTML = `
                <div class="spot-number">${i}</div>
                <div class="spot-glow" data-player="${player}" data-position="${i}"></div>
            `;

            spotContainer.appendChild(spotElement);
        }

        container.appendChild(spotContainer);
    });
}

function calculateAchievements(player, raceData) {
    const achievements = {};
    const playerRaces = raceData.filter(race => race[player] !== null);

    if (playerRaces.length === 0) {
        // Return null for all achievements when player has no race data
        Object.keys(ACHIEVEMENTS).forEach(key => {
            achievements[key] = { current: null, target: ACHIEVEMENTS[key].targets[0], level: 0 };
        });
        return achievements;
    }

    // Sort races chronologically
    const chronologicalRaces = [...playerRaces].sort((a, b) => {
        const dateA = new Date(a.date + (a.timestamp ? ' ' + a.timestamp : ''));
        const dateB = new Date(b.date + (b.timestamp ? ' ' + b.timestamp : ''));
        return dateA - dateB;
    });

    // Win Streak
    let currentWinStreak = 0;
    let maxWinStreak = 0;
    let winStreakDetails = { races: [], endDate: null };
    let currentStreakRaces = [];
    
    chronologicalRaces.forEach(race => {
        if (race[player] === 1) {
            currentWinStreak++;
            currentStreakRaces.push(race);
            if (currentWinStreak > maxWinStreak) {
                maxWinStreak = currentWinStreak;
                winStreakDetails = {
                    races: [...currentStreakRaces],
                    endDate: race.date
                };
            }
        } else {
            currentWinStreak = 0;
            currentStreakRaces = [];
        }
    });
    achievements.winStreak = calculateAchievementLevel(maxWinStreak, ACHIEVEMENTS.winStreak.targets);
    achievements.winStreak.details = winStreakDetails;

    // Clutch Master (consecutive races finishing better than running average)
    let currentClutchStreak = 0;
    let maxClutchStreak = 0;
    let maxClutchStreakDetails = { races: [], endDate: null, overallAverage: 0 };
    let currentClutchStreakDetails = { races: [], endDate: null, overallAverage: 0 };
    let currentClutchRaces = [];
    let totalPositions = 0;
    let raceCount = 0;
    
    // Calculate final overall average for display purposes
    const finalOverallAverage = chronologicalRaces.reduce((sum, race) => sum + race[player], 0) / chronologicalRaces.length;
    
    chronologicalRaces.forEach(race => {
        raceCount++;
        
        // Compare against the average BEFORE adding this race (if we have previous races)
        let shouldContinueStreak = false;
        if (raceCount === 1) {
            // First race: no previous average, so no streak yet
            shouldContinueStreak = false;
        } else {
            // Calculate average of all previous races (excluding current)
            const previousAverage = totalPositions / (raceCount - 1);
            const roundedPreviousAverage = Math.round(previousAverage);
            shouldContinueStreak = race[player] < roundedPreviousAverage;
        }
        
        // Add current race to running total
        totalPositions += race[player];
        
        if (shouldContinueStreak) {
            currentClutchStreak++;
            currentClutchRaces.push(race);
            
            // Calculate current overall average (including this race)
            const currentOverallAverage = totalPositions / raceCount;
            
            // Update current active streak details
            currentClutchStreakDetails = {
                races: [...currentClutchRaces],
                endDate: race.date,
                overallAverage: currentOverallAverage,
                roundedAverage: Math.round(currentOverallAverage)
            };
            
            // Update max streak if current is better or equal (to keep most recent)
            if (currentClutchStreak >= maxClutchStreak) {
                maxClutchStreak = currentClutchStreak;
                maxClutchStreakDetails = {
                    races: [...currentClutchRaces],
                    endDate: race.date,
                    overallAverage: currentOverallAverage,
                    roundedAverage: Math.round(currentOverallAverage)
                };
            }
        } else {
            currentClutchStreak = 0;
            currentClutchRaces = [];
        }
    });
    achievements.clutchMaster = calculateAchievementLevel(maxClutchStreak, ACHIEVEMENTS.clutchMaster.targets);
    // Always use max streak for display, but also track current active streak
    achievements.clutchMaster.details = maxClutchStreakDetails;
    achievements.clutchMaster.details.currentActiveStreak = currentClutchStreak > 0 ? {
        count: currentClutchStreak,
        races: [...currentClutchRaces],
        overallAverage: totalPositions / chronologicalRaces.length
    } : null;

    // Hot Streak (consecutive podiums)
    let currentPodiumStreak = 0;
    let maxPodiumStreak = 0;
    let hotStreakDetails = { races: [], endDate: null };
    let currentPodiumRaces = [];
    
    chronologicalRaces.forEach(race => {
        if (race[player] <= 3) {
            currentPodiumStreak++;
            currentPodiumRaces.push(race);
            if (currentPodiumStreak > maxPodiumStreak) {
                maxPodiumStreak = currentPodiumStreak;
                hotStreakDetails = {
                    races: [...currentPodiumRaces],
                    endDate: race.date
                };
            }
        } else {
            currentPodiumStreak = 0;
            currentPodiumRaces = [];
        }
    });
    achievements.hotStreak = calculateAchievementLevel(maxPodiumStreak, ACHIEVEMENTS.hotStreak.targets);
    achievements.hotStreak.details = hotStreakDetails;

    // Momentum Builder (consecutive races with improving positions, or consecutive 1st places)
    let currentMomentumStreak = 0;
    let maxMomentumStreak = 0;
    let maxMomentumStreakDetails = { races: [], endDate: null };
    let currentMomentumStreakDetails = { races: [], endDate: null };
    let currentMomentumRaces = [];
    
    for (let i = 1; i < chronologicalRaces.length; i++) {
        const currentPos = chronologicalRaces[i][player];
        const previousPos = chronologicalRaces[i-1][player];
        
        // Streak continues if: improving position OR both positions are 1st place
        const isImproving = currentPos < previousPos;
        const bothFirstPlace = currentPos === 1 && previousPos === 1;
        
        if (isImproving || bothFirstPlace) {
            currentMomentumStreak++;
            currentMomentumRaces.push(chronologicalRaces[i]);
            
            // Update current active streak details
            currentMomentumStreakDetails = {
                races: [...currentMomentumRaces],
                endDate: chronologicalRaces[i].date
            };
            
            // Update max streak if current is better or equal (to keep most recent)
            if (currentMomentumStreak >= maxMomentumStreak) {
                maxMomentumStreak = currentMomentumStreak;
                maxMomentumStreakDetails = {
                    races: [...currentMomentumRaces],
                    endDate: chronologicalRaces[i].date
                };
            }
        } else {
            currentMomentumStreak = 0;
            currentMomentumRaces = [];
        }
    }
    
    achievements.momentumBuilder = calculateAchievementLevel(maxMomentumStreak, ACHIEVEMENTS.momentumBuilder.targets);
    // Always use max streak for display, but also track current active streak
    achievements.momentumBuilder.details = maxMomentumStreakDetails;
    achievements.momentumBuilder.details.currentActiveStreak = currentMomentumStreak > 0 ? {
        count: currentMomentumStreak,
        races: [...currentMomentumRaces],
        endDate: currentMomentumStreakDetails.endDate
    } : null;


    // Perfect Day (all races in a day were good finishes)
    let perfectDays = 0;
    const dayGroups = {};
    let perfectDayDetails = { days: [] };

    // Group races by date
    chronologicalRaces.forEach(race => {
        if (race[player] !== null) {
            if (!dayGroups[race.date]) {
                dayGroups[race.date] = [];
            }
            dayGroups[race.date].push(race[player]);
        }
    });

    // Check each day for perfect days (2+ races, all good finishes)
    Object.entries(dayGroups).forEach(([date, dayRaces]) => {
        const threshold = getGoodFinishThreshold();
        if (dayRaces.length >= 2 && dayRaces.every(position => position <= threshold)) {
            perfectDays++;
            perfectDayDetails.days.push({
                date: date,
                raceCount: dayRaces.length,
                positions: dayRaces
            });
        }
    });
    achievements.perfectDay = calculateAchievementLevel(perfectDays, ACHIEVEMENTS.perfectDay.targets);
    achievements.perfectDay.details = perfectDayDetails;

    return achievements;
}

function toggleAchievementDetails(player, achievementKey) {
    const expandedSection = document.getElementById(`${player}-expanded-achievements`);
    if (!expandedSection) return;
    
    const expandedList = expandedSection.querySelector('.expanded-achievements-list');
    const expandedItemId = `${player}-${achievementKey}-expanded`;
    const existingExpandedItem = document.getElementById(expandedItemId);
    
    if (existingExpandedItem) {
        // Remove from expanded section
        existingExpandedItem.remove();
        
        // Update main achievement bar styling
        const mainAchievementBar = document.querySelector(`[data-player="${player}"][data-achievement="${achievementKey}"]`).closest('.achievement-bar');
        mainAchievementBar.classList.remove('achievement-expanded');
        
        // Update button state
        updateToggleActiveButtonState(player);
    } else {
        // Add to expanded section in correct order
        const achievement = ACHIEVEMENTS[achievementKey];
        const allAchievements = calculateAchievements(player, getFilteredRaces());
        const achievementData = allAchievements[achievementKey];
        
        // Create expanded achievement item
        const expandedItem = document.createElement('div');
        expandedItem.className = 'expanded-achievement-item';
        expandedItem.id = expandedItemId;
        expandedItem.setAttribute('data-order', getAchievementOrder(achievementKey));
        
        // Check if this achievement has an active streak and add glow class
        const hasActiveStreak = checkForActiveStreak(achievementKey, achievementData, player, getFilteredRaces());
        if (hasActiveStreak) {
            expandedItem.classList.add('active-streak-glow');
        }
        expandedItem.innerHTML = `
            <div class="expanded-achievement-bar">
                <div class="achievement-name">${achievement.name}</div>
                <div class="achievement-close-icon" onclick="toggleAchievementDetails('${player}', '${achievementKey}')">✕</div>
            </div>
            <div class="expanded-achievement-details">
                ${generateAchievementDetail(achievementKey, achievementData, player)}
            </div>
        `;
        
        // Insert in correct order
        insertExpandedItemInOrder(expandedList, expandedItem);
        
        // Update main achievement bar styling
        const mainAchievementBar = document.querySelector(`[data-player="${player}"][data-achievement="${achievementKey}"]`).closest('.achievement-bar');
        mainAchievementBar.classList.add('achievement-expanded');
        
        // Update button state
        updateToggleActiveButtonState(player);
    }
}

function getAchievementOrder(achievementKey) {
    const orderMap = {
        'winStreak': 1,
        'hotStreak': 2,
        'clutchMaster': 3,
        'momentumBuilder': 4,
        'perfectDay': 5
    };
    return orderMap[achievementKey] || 999;
}

function insertExpandedItemInOrder(expandedList, newItem) {
    const newOrder = parseInt(newItem.getAttribute('data-order'));
    const existingItems = Array.from(expandedList.children);
    
    // Find the correct position to insert
    let insertPosition = existingItems.length;
    for (let i = 0; i < existingItems.length; i++) {
        const existingOrder = parseInt(existingItems[i].getAttribute('data-order'));
        if (newOrder < existingOrder) {
            insertPosition = i;
            break;
        }
    }
    
    // Insert at the correct position
    if (insertPosition >= existingItems.length) {
        expandedList.appendChild(newItem);
    } else {
        expandedList.insertBefore(newItem, existingItems[insertPosition]);
    }
}



function toggleActiveStreaks(player) {
    const expandedSection = document.getElementById(`${player}-expanded-achievements`);
    if (!expandedSection) return;
    const expandedList = expandedSection.querySelector('.expanded-achievements-list');
    const toggleButton = document.getElementById(`${player}-toggle-active-achievements`);
    const toggleText = toggleButton.querySelector('.toggle-active-text');
    const toggleIcon = toggleButton.querySelector('.toggle-active-icon');
    
    // Get achievements that have active streaks (green pulsing)
    const activeStreakAchievements = Object.keys(ACHIEVEMENTS).filter(achievementKey => {
        const achievementBar = document.querySelector(`[data-player="${player}"][data-achievement="${achievementKey}"]`).closest('.achievement-bar');
        return achievementBar && achievementBar.classList.contains('active-streak');
    });
    
    // Check how many active streak achievements are currently expanded
    const expandedActiveCount = activeStreakAchievements.filter(achievementKey => {
        return document.getElementById(`${player}-${achievementKey}-expanded`) !== null;
    }).length;
    
    if (expandedActiveCount === 0) {
        // Expand all active streak achievements
        activeStreakAchievements.forEach(achievementKey => {
            const existingExpanded = document.getElementById(`${player}-${achievementKey}-expanded`);
            if (!existingExpanded) {
                toggleAchievementDetails(player, achievementKey);
            }
        });
        toggleText.textContent = 'Collapse Active';
        toggleIcon.textContent = '▲';
    } else {
        // Collapse all active streak achievements
        activeStreakAchievements.forEach(achievementKey => {
            const existingExpanded = document.getElementById(`${player}-${achievementKey}-expanded`);
            if (existingExpanded) {
                toggleAchievementDetails(player, achievementKey);
            }
        });
        toggleText.textContent = 'Expand Active';
        toggleIcon.textContent = '▼';
    }
    
    // Update button state after a short delay to ensure DOM updates
    setTimeout(() => updateToggleActiveButtonState(player), 100);
}

function updateToggleActiveButtonState(player) {
    const toggleButton = document.getElementById(`${player}-toggle-active-achievements`);
    
    // If the active button doesn't exist (no active streaks), do nothing
    if (!toggleButton) {
        return;
    }
    
    const toggleText = toggleButton.querySelector('.toggle-active-text');
    const toggleIcon = toggleButton.querySelector('.toggle-active-icon');
    
    // If button elements don't exist, return early
    if (!toggleText || !toggleIcon) {
        return;
    }
    
    // Get achievements that have active streaks (green pulsing)
    const activeStreakAchievements = Object.keys(ACHIEVEMENTS).filter(achievementKey => {
        const achievementBar = document.querySelector(`[data-player="${player}"][data-achievement="${achievementKey}"]`).closest('.achievement-bar');
        return achievementBar && achievementBar.classList.contains('active-streak');
    });
    
    // Check how many active streak achievements are currently expanded
    const expandedActiveCount = activeStreakAchievements.filter(achievementKey => {
        return document.getElementById(`${player}-${achievementKey}-expanded`) !== null;
    }).length;
    
    if (expandedActiveCount === 0) {
        toggleText.textContent = 'Expand Active';
        toggleIcon.textContent = '▼';
    } else {
        toggleText.textContent = 'Collapse Active';
        toggleIcon.textContent = '▲';
    }
}

function smartUpdateExpandedAchievements(raceData) {
    players.forEach(player => {
        const expandedSection = document.getElementById(`${player}-expanded-achievements`);
        if (!expandedSection) return;
        
        const expandedList = expandedSection.querySelector('.expanded-achievements-list');
        if (!expandedList) return;
        
        // Calculate current achievements to determine what should remain expanded
        const allAchievements = calculateAchievements(player, raceData);
        
        // Determine current button states to know what should be auto-expanded
        const toggleActiveButton = document.getElementById(`${player}-toggle-active-achievements`);
        
        const toggleActiveText = toggleActiveButton && toggleActiveButton.querySelector('.toggle-active-text');
        
        const isExpandActiveActive = toggleActiveText && toggleActiveText.textContent === 'Collapse Active';
        
        // Check each achievement to update or auto-expand
        Object.keys(ACHIEVEMENTS).forEach(achievementKey => {
            const existingExpanded = document.getElementById(`${player}-${achievementKey}-expanded`);
            const achievementData = allAchievements[achievementKey];
            const hasData = achievementData && achievementData.current > 0;
            const hasActiveStreak = hasData && checkForActiveStreak(achievementKey, achievementData, player, raceData);
            
            if (existingExpanded && !hasData) {
                // Remove achievements that no longer have data
                existingExpanded.remove();
                const mainAchievementBar = document.querySelector(`[data-player="${player}"][data-achievement="${achievementKey}"]`).closest('.achievement-bar');
                if (mainAchievementBar) {
                    mainAchievementBar.classList.remove('achievement-expanded');
                }
            } else if (existingExpanded && hasData) {
                // Update existing expanded achievements with new data
                const detailsElement = existingExpanded.querySelector('.expanded-achievement-details');
                if (detailsElement) {
                    detailsElement.innerHTML = generateAchievementDetail(achievementKey, achievementData, player);
                }
                
                // Update active streak styling
                if (hasActiveStreak) {
                    existingExpanded.classList.add('active-streak-glow');
                } else {
                    existingExpanded.classList.remove('active-streak-glow');
                }
            } else if (!existingExpanded && hasData) {
                // Auto-expand newly available achievements based on button states
                const shouldAutoExpand = isExpandActiveActive && hasActiveStreak;
                
                if (shouldAutoExpand) {
                    toggleAchievementDetails(player, achievementKey);
                }
            }
        });
        
        // Update button states based on current data and expanded state
        updateToggleActiveButtonState(player);
    });
}

function collapseAllAchievements() {
    players.forEach(player => {
        // Collapse all expanded achievements
        const expandedSection = document.getElementById(`${player}-expanded-achievements`);
        if (!expandedSection) return;
        const expandedList = expandedSection.querySelector('.expanded-achievements-list');
        if (expandedList) {
            Object.keys(ACHIEVEMENTS).forEach(achievementKey => {
                const existingExpanded = document.getElementById(`${player}-${achievementKey}-expanded`);
                if (existingExpanded) {
                    existingExpanded.remove();
                    // Update main achievement bar styling
                    const mainAchievementBar = document.querySelector(`[data-player="${player}"][data-achievement="${achievementKey}"]`).closest('.achievement-bar');
                    if (mainAchievementBar) {
                        mainAchievementBar.classList.remove('achievement-expanded');
                    }
                }
            });
        }
        
        // Reset button state
        const toggleActiveButton = document.getElementById(`${player}-toggle-active-achievements`);
        if (toggleStreaksButton) {
            const toggleText = toggleStreaksButton.querySelector('.toggle-streaks-text');
            const toggleIcon = toggleStreaksButton.querySelector('.toggle-streaks-icon');
            if (toggleText && toggleIcon) {
                toggleText.textContent = 'Expand Active';
                toggleIcon.textContent = '▼';
            }
        }
    });
}

function clearAchievementButtons() {
    players.forEach(player => {
        const container = document.getElementById(player + '-achievements');
        // Skip if container doesn't exist
        if (!container) return;
        
        const existingButtonContainer = container.querySelector('.achievement-buttons-container');
        if (existingButtonContainer) {
            existingButtonContainer.remove();
        }
    });
}

function updateAchievementButtons(raceData) {
    players.forEach(player => {
        const container = document.getElementById(player + '-achievements');
        
        // Skip if container doesn't exist (e.g., when switching tabs)
        if (!container) return;
        
        // Check if buttons should exist based on data
        const hasExpandableData = Object.keys(ACHIEVEMENTS).some(achievementKey => {
            const achievement = ACHIEVEMENTS[achievementKey];
            const allAchievements = calculateAchievements(player, raceData);
            const achievementData = allAchievements[achievementKey];
            return achievementData && achievementData.current > 0;
        });
        
        const hasActiveStreaks = Object.keys(ACHIEVEMENTS).some(achievementKey => {
            const allAchievements = calculateAchievements(player, raceData);
            const achievementData = allAchievements[achievementKey];
            return checkForActiveStreak(achievementKey, achievementData, player, raceData);
        });
        
        const existingButtonContainer = container.querySelector('.achievement-buttons-container');
        
        if (!hasExpandableData) {
            // Remove buttons if no data
            if (existingButtonContainer) {
                existingButtonContainer.remove();
            }
            return;
        }
        
        // Create or update button container
        let buttonContainer = existingButtonContainer;
        if (!buttonContainer) {
            buttonContainer = document.createElement('div');
            buttonContainer.className = 'achievement-buttons-container';
            
            // Insert button container after the achievement bars grid but before expanded section
            const barsGrid = container.querySelector('.achievement-bars-grid');
            const expandedSection = container.querySelector('.expanded-achievements');
            if (barsGrid && expandedSection) {
                container.insertBefore(buttonContainer, expandedSection);
            } else {
                container.appendChild(buttonContainer);
            }
        }
        
        
        // Handle active button
        let toggleActiveButton = document.getElementById(`${player}-toggle-active-achievements`);
        
        if (hasActiveStreaks) {
            // Create active button if it doesn't exist
            if (!toggleActiveButton) {
                toggleActiveButton = document.createElement('div');
                toggleActiveButton.className = 'achievement-toggle-active-btn';
                toggleActiveButton.id = `${player}-toggle-active-achievements`;
                toggleActiveButton.innerHTML = `
                    <span class="toggle-active-text">Expand Active</span>
                    <span class="toggle-active-icon">▼</span>
                `;
                toggleActiveButton.onclick = () => toggleActiveStreaks(player);
                buttonContainer.appendChild(toggleActiveButton);
            }
        } else if (toggleActiveButton) {
            // Remove active button if no active streaks
            toggleActiveButton.remove();
        }
        
        // Update button states to reflect current expanded state
        updateToggleActiveButtonState(player);
    });
}

function togglePositionHeatDetails(player, rangeIndex) {
    const expandedSection = document.getElementById(`${player}-expanded-position-heat`);
    if (!expandedSection) return;
    
    const expandedList = expandedSection.querySelector('.expanded-position-heat-list');
    const expandedTitle = expandedSection.querySelector('.expanded-position-heat-title');
    const expandedItemId = `${player}-heat-${rangeIndex}-expanded`;
    const existingExpandedItem = document.getElementById(expandedItemId);
    
    if (existingExpandedItem) {
        // Remove from expanded section
        existingExpandedItem.remove();
        
        // Update main position heat bar styling
        const mainHeatBar = document.querySelector(`[data-player="${player}"][data-range="${rangeIndex}"]`).closest('.position-heat-bar');
        mainHeatBar.classList.remove('position-heat-expanded');
    } else {
        // Add to expanded section in correct order
        const ranges = getPositionRanges();
        
        const rangeData = ranges[rangeIndex];
        const raceData = getFilteredRaces();
        const playerRaces = raceData.filter(race => race[player] !== null);
        const [min, max] = rangeData.range;
        const racesInRange = playerRaces.filter(race =>
            race[player] >= min && race[player] <= max
        );
        
        // Calculate average position for this range
        const avgPosition = racesInRange.length > 0 
            ? racesInRange.reduce((sum, race) => sum + race[player], 0) / racesInRange.length 
            : 0;
        
        // Create expanded position heat item
        const expandedItem = document.createElement('div');
        expandedItem.className = 'expanded-position-heat-item';
        expandedItem.id = expandedItemId;
        expandedItem.setAttribute('data-order', rangeIndex);
        expandedItem.innerHTML = `
            <div class="expanded-position-heat-bar">
                <div class="position-heat-count">${racesInRange.length} ${racesInRange.length === 1 ? 'race' : 'races'}</div>
                <div class="position-heat-avg">Avg Position: ${formatDecimal(avgPosition)}</div>
                <div class="position-heat-close-icon" onclick="togglePositionHeatDetails('${player}', ${rangeIndex})">✕</div>
            </div>
        `;
        
        // Insert in correct order (0-3 based on range index)
        insertExpandedHeatItemInOrder(expandedList, expandedItem);
        
        // Update main position heat bar styling
        const mainHeatBar = document.querySelector(`[data-player="${player}"][data-range="${rangeIndex}"]`).closest('.position-heat-bar');
        mainHeatBar.classList.add('position-heat-expanded');
    }
    
    // Show/hide title based on whether any position heats are expanded
    const hasExpandedItems = expandedList.children.length > 0;
    expandedTitle.style.display = hasExpandedItems ? 'block' : 'none';
}

function insertExpandedHeatItemInOrder(expandedList, newItem) {
    const newOrder = parseInt(newItem.getAttribute('data-order'));
    const existingItems = Array.from(expandedList.children);
    
    // Find the correct position to insert
    let insertPosition = existingItems.length;
    for (let i = 0; i < existingItems.length; i++) {
        const existingOrder = parseInt(existingItems[i].getAttribute('data-order'));
        if (newOrder < existingOrder) {
            insertPosition = i;
            break;
        }
    }
    
    // Insert at the correct position
    if (insertPosition >= existingItems.length) {
        expandedList.appendChild(newItem);
    } else {
        expandedList.insertBefore(newItem, existingItems[insertPosition]);
    }
}

function generateAchievementDetail(achievementKey, achievement, player) {
    if (!achievement.details) return 'No details available';
    
    const formatDateTime = (dateStr, timeStr) => {
        // Parse the date string manually to avoid UTC conversion issues
        // dateStr is in format "YYYY-MM-DD"
        const [year, month, day] = dateStr.split('-').map(num => parseInt(num));
        // Create date using local time (month is 0-indexed in JavaScript)
        const date = new Date(year, month - 1, day);
        const dateFormatted = date.toLocaleDateString('en-US', { 
            month: 'short', 
            day: 'numeric', 
            year: 'numeric' 
        });
        return timeStr ? `${dateFormatted} ${timeStr}` : dateFormatted;
    };

    // Helper function to check if streak is active and get breaking position
    const getStreakStatus = (streakRaces) => {
        if (streakRaces.length === 0) return { isActive: false, breakingPosition: null };
        
        const allRaces = getFilteredRaces();
        const playerRaces = allRaces.filter(race => race[player] !== null)
            .sort((a, b) => {
                const dateA = new Date(a.date + (a.timestamp ? ' ' + a.timestamp : ''));
                const dateB = new Date(b.date + (b.timestamp ? ' ' + b.timestamp : ''));
                return dateA - dateB;
            });
        
        if (playerRaces.length === 0) return { isActive: false, breakingPosition: null };
        
        const lastStreakRace = streakRaces[streakRaces.length - 1];
        const lastPlayerRace = playerRaces[playerRaces.length - 1];
        
        // Check if streak extends to the most recent race
        const isActive = lastStreakRace.date === lastPlayerRace.date && 
                         lastStreakRace.timestamp === lastPlayerRace.timestamp;
        
        // Find breaking position if streak ended
        let breakingPosition = null;
        if (!isActive) {
            const streakEndIndex = playerRaces.findIndex(race => 
                race.date === lastStreakRace.date && race.timestamp === lastStreakRace.timestamp
            );
            if (streakEndIndex !== -1 && streakEndIndex < playerRaces.length - 1) {
                breakingPosition = playerRaces[streakEndIndex + 1][player];
            }
        }
        
        return { isActive, breakingPosition };
    };

    const getRaceNumbers = (races) => {
        const allRaces = getFilteredRaces();
        return races.map(race => {
            const index = allRaces.findIndex(r => 
                r.date === race.date && 
                r.timestamp === race.timestamp
            );
            return index !== -1 ? index + 1 : '?';
        });
    };

    const formatRaceRange = (raceNumbers) => {
        if (raceNumbers.length === 0) return '';
        if (raceNumbers.length === 1) return `#${raceNumbers[0]}`;
        
        // Sort numbers to find ranges
        const sorted = [...raceNumbers].sort((a, b) => a - b);
        const ranges = [];
        let start = sorted[0];
        let end = sorted[0];
        
        for (let i = 1; i < sorted.length; i++) {
            if (sorted[i] === end + 1) {
                end = sorted[i];
            } else {
                ranges.push(start === end ? `#${start}` : `#${start}-#${end}`);
                start = end = sorted[i];
            }
        }
        ranges.push(start === end ? `#${start}` : `#${start}-#${end}`);
        
        return ranges.join(', ');
    };

    switch (achievementKey) {
        case 'winStreak':
            if (achievement.details.races.length === 0) return 'No win streak achieved';
            const winRaceNumbers = getRaceNumbers(achievement.details.races);
            const lastWinRace = achievement.details.races[achievement.details.races.length - 1];
            const raceLabel = achievement.details.races.length === 1 ? 'Race' : 'Races';
            const winStatus = getStreakStatus(achievement.details.races);
            let result = `${raceLabel}: ${formatRaceRange(winRaceNumbers)}<br>`;
            if (winStatus.isActive) {
                result += `Active streak`;
            } else {
                result += `Ended: ${formatDateTime(achievement.details.endDate, lastWinRace.timestamp)}`;
                if (winStatus.breakingPosition) {
                    result += `<br>Position that ended the streak: ${winStatus.breakingPosition}`;
                }
            }
            return result;

        case 'clutchMaster':
            if (achievement.details.races.length === 0) return 'No clutch streak achieved';
            const clutchRaceNumbers = getRaceNumbers(achievement.details.races);
            const lastClutchRace = achievement.details.races[achievement.details.races.length - 1];
            const clutchRaceLabel = achievement.details.races.length === 1 ? 'Race' : 'Races';
            const clutchStatus = getStreakStatus(achievement.details.races);
            
            let clutchResult = '';
            
            // Check if there's an active streak that matches or exceeds the best
            const hasActiveStreak = achievement.details.currentActiveStreak;
            const activeCount = hasActiveStreak ? achievement.details.currentActiveStreak.count : 0;
            const bestCount = achievement.details.races.length;
            const showActiveAsMain = hasActiveStreak && activeCount >= bestCount;
            
            if (showActiveAsMain) {
                // Show active streak as the main info (it's the latest/best)
                const active = achievement.details.currentActiveStreak;
                const activeRaceNumbers = getRaceNumbers(active.races);
                const activeRaceLabel = active.races.length === 1 ? 'Race' : 'Races';
                
                clutchResult = `${activeRaceLabel}: ${formatRaceRange(activeRaceNumbers)}<br>`;
                clutchResult += `Active streak (${active.count}). Current avg position: ${formatDecimal(active.overallAverage)}`;
            } else {
                // Show best streak info
                clutchResult = `${clutchRaceLabel}: ${formatRaceRange(clutchRaceNumbers)}<br>`;
                clutchResult += `Ended: ${formatDateTime(achievement.details.endDate, lastClutchRace.timestamp)}`;
                if (clutchStatus.breakingPosition) {
                    clutchResult += `<br>Position that ended the streak: ${clutchStatus.breakingPosition}`;
                    clutchResult += `<br>Avg position at streak end: ${formatDecimal(achievement.details.overallAverage)}`;
                }
                
                // If there's a current active streak (but not better), show that info too
                if (achievement.details.currentActiveStreak) {
                    const active = achievement.details.currentActiveStreak;
                    const allRaces = getFilteredRaces();
                    const currentRaceNumber = allRaces.length;
                    
                    //clutchResult += `<br><br>Race: #${currentRaceNumber}<br>`;
                    clutchResult += `<br><br>Active streak (${active.count}). Current avg position: ${formatDecimal(active.overallAverage)}`;
                }
            }
            
            return clutchResult;

        case 'hotStreak':
            if (achievement.details.races.length === 0) return 'No podium streak achieved';
            const podiumRaceNumbers = getRaceNumbers(achievement.details.races);
            const podiumPositions = achievement.details.races.map(race => race[player]);
            const lastPodiumRace = achievement.details.races[achievement.details.races.length - 1];
            const podiumRaceLabel = achievement.details.races.length === 1 ? 'Race' : 'Races';
            const podiumStatus = getStreakStatus(achievement.details.races);
            let podiumResult = `${podiumRaceLabel}: ${formatRaceRange(podiumRaceNumbers)}<br>` +
                             `Positions: ${podiumPositions.join(', ')}<br>`;
            if (podiumStatus.isActive) {
                podiumResult += `Active streak`;
            } else {
                podiumResult += `Ended: ${formatDateTime(achievement.details.endDate, lastPodiumRace.timestamp)}`;
                if (podiumStatus.breakingPosition) {
                    podiumResult += `<br>Position that ended the streak: ${podiumStatus.breakingPosition}`;
                }
            }
            return podiumResult;

        case 'momentumBuilder':
            if (achievement.details.races.length === 0) return 'No momentum streak achieved';
            const momentumRaceNumbers = getRaceNumbers(achievement.details.races);
            const lastMomentumRace = achievement.details.races[achievement.details.races.length - 1];
            const momentumRaceLabel = achievement.details.races.length === 1 ? 'Race' : 'Races';
            const momentumStatus = getStreakStatus(achievement.details.races);
            
            let momentumResult = '';
            
            // Check if there's an active streak that matches or exceeds the best
            const hasActiveMomentum = achievement.details.currentActiveStreak;
            const activeMomentumCount = hasActiveMomentum ? achievement.details.currentActiveStreak.count : 0;
            const bestMomentumCount = achievement.details.races.length;
            const showActiveMomentumAsMain = hasActiveMomentum && activeMomentumCount >= bestMomentumCount;
            
            if (showActiveMomentumAsMain) {
                // Show active streak as the main info (it's the latest/best)
                const active = achievement.details.currentActiveStreak;
                const activeRaceNumbers = getRaceNumbers(active.races);
                const activeRaceLabel = active.races.length === 1 ? 'Race' : 'Races';
                const activeLastRace = active.races[active.races.length - 1];
                const lastPosition = activeLastRace[player];
                const neededPosition = lastPosition === 1 ? 1 : Math.max(1, lastPosition - 1);
                
                momentumResult = `${activeRaceLabel}: ${formatRaceRange(activeRaceNumbers)}<br>`;
                momentumResult += `Active streak (${active.count}).`;
                if (lastPosition === 1) {
                    momentumResult += ` Need 1st place to continue`;
                } else {
                    momentumResult += ` Need position ${neededPosition} or better to continue`;
                }
            } else {
                // Show best streak info
                momentumResult = `${momentumRaceLabel}: ${formatRaceRange(momentumRaceNumbers)}<br>`;
                momentumResult += `Ended: ${formatDateTime(achievement.details.endDate, lastMomentumRace.timestamp)}`;
                if (momentumStatus.breakingPosition) {
                    const lastPosition = lastMomentumRace[player];
                    const neededPosition = lastPosition === 1 ? 1 : Math.max(1, lastPosition - 1);
                    momentumResult += `<br>Position that ended the streak: ${momentumStatus.breakingPosition}`;
                    if (lastPosition === 1) {
                        momentumResult += `<br>Position needed was: 1st place`;
                    } else {
                        momentumResult += `<br>Position needed was: ${neededPosition} or better`;
                    }
                }
                
                // If there's a current active streak (but not better), show that info too
                if (achievement.details.currentActiveStreak) {
                    const active = achievement.details.currentActiveStreak;
                    const allRaces = getFilteredRaces();
                    const currentRaceNumber = allRaces.length;
                    const activeLastRace = active.races[active.races.length - 1];
                    const lastPosition = activeLastRace[player];
                    const neededPosition = lastPosition === 1 ? 1 : Math.max(1, lastPosition - 1);

                    momentumResult += `<br><br>Active streak (${active.count}).`;
                    if (lastPosition === 1) {
                        momentumResult += ` Need 1st place to continue`;
                    } else {
                        momentumResult += ` Need position ${neededPosition} or better to continue`;
                    }
                }
            }
            
            return momentumResult;


        case 'perfectDay':
            if (achievement.details.days.length === 0) return 'No perfect days achieved';
            
            // All perfect days already have all positions <= threshold (that's the definition)
            const perfectDays = achievement.details.days;
            
            // Check if today is an active perfect day
            const today = new Date().toLocaleDateString('en-CA');
            const allRaces = getFilteredRaces();
            const todayRaces = allRaces.filter(race => race[player] !== null && race.date === today);
            const threshold = getGoodFinishThreshold();
            const isActiveToday = todayRaces.length > 0 && todayRaces.every(race => race[player] <= threshold);
            
            let bestDay = null;
            
            // Check if today is in the list or is currently active
            const todayPerfect = perfectDays.find(day => day.date === today);
            if (todayPerfect || (isActiveToday && todayRaces.length >= 1)) {
                // Use today's data
                if (todayPerfect) {
                    bestDay = todayPerfect;
                } else {
                    // Create today's entry if it's active but not yet in the list (only 1 race so far)
                    bestDay = {
                        date: today,
                        raceCount: todayRaces.length,
                        positions: todayRaces.map(race => race[player])
                    };
                }
            } else {
                // Find the day with the most races
                const maxRaces = Math.max(...perfectDays.map(day => day.raceCount));
                const daysWithMaxRaces = perfectDays.filter(day => day.raceCount === maxRaces);
                
                // If multiple days have the same count, pick the most recent
                bestDay = daysWithMaxRaces.sort((a, b) => {
                    // Sort by date descending (most recent first)
                    return b.date.localeCompare(a.date);
                })[0];
            }
            
            // Format the single best day
            const isToday = bestDay.date === today;
            const dayLabel = isToday && isActiveToday ? `${formatDateTime(bestDay.date)} (Active)` : formatDateTime(bestDay.date);
            return `${dayLabel}: total of ${bestDay.raceCount} race${bestDay.raceCount === 1 ? '' : 's'}<br>` +
                   `Positions: ${bestDay.positions.join(', ')}`;

        default:
            return 'Details not available for this achievement';
    }
}

function calculateAchievementLevel(current, targets) {
    let level = 0;
    let nextTarget = targets[0];

    for (let i = 0; i < targets.length; i++) {
        if (current >= targets[i]) {
            level = i + 1;
            nextTarget = i + 1 < targets.length ? targets[i + 1] : targets[i];
        } else {
            nextTarget = targets[i];
            break;
        }
    }

    return { current, target: nextTarget, level };
}

// Helper functions for relative achievement coloring (Win Streak, Clutch Master, Hot Streak, Momentum Builder, Perfect Day)
function getRelativeColor(player, achievementValues) {
    const playerData = achievementValues.find(p => p.player === player);
    if (!playerData) return '#ffffff'; // White if player not in comparison (no race data)
    
    const playerValue = playerData.value;
    
    // If only 1 player with data, use white (no comparison possible)
    if (achievementValues.length === 1) {
        return '#ffffff'; // White for single player with data
    }
    
    // If all players have 0, use white
    if (achievementValues.every(p => p.value === 0)) {
        return '#ffffff'; // White for all zeros
    }
    
    // Check for ties (including ties at 0)
    const playersWithSameValue = achievementValues.filter(p => p.value === playerValue);
    const isTied = playersWithSameValue.length > 1;
    
    if (isTied) {
        return '#ffffff'; // White for ties (any value)
    }
    
    // If this player has 0 but others have non-zero values, make them red (last place)
    if (playerValue === 0 && achievementValues.some(p => p.value > 0)) {
        return '#ef4444'; // Red for 0 when others have achievements
    }
    
    // Find unique non-zero values and sort them
    const uniqueNonZeroValues = [...new Set(achievementValues.map(p => p.value).filter(v => v > 0))].sort((a, b) => b - a);
    const playerRank = uniqueNonZeroValues.indexOf(playerValue);
    
    // For 2 players with data: green for winner, red for loser (no yellow)
    if (achievementValues.length === 2 && uniqueNonZeroValues.length > 0) {
        if (playerRank === 0) return '#10b981'; // Green for 1st
        else return '#ef4444'; // Red for 2nd (no yellow)
    }
    
    // For 3+ players with data: use full color range
    if (playerRank === 0) return '#10b981'; // Green for 1st
    else if (playerRank === 1) return '#f59e0b'; // Yellow for 2nd  
    else return '#ef4444'; // Red for 3rd or lower
}

function getRelativeFontWeight(player, achievementValues) {
    const playerData = achievementValues.find(p => p.player === player);
    if (!playerData) return '700'; // Normal weight if player not in comparison (no race data)
    
    const playerValue = playerData.value;
    
    // If only 1 player with data, use normal weight
    if (achievementValues.length === 1) {
        return '700'; // Normal weight for single player with data
    }
    
    // Check for ties (any value including 0)
    const playersWithSameValue = achievementValues.filter(p => p.value === playerValue);
    const isTied = playersWithSameValue.length > 1;
    
    return isTied ? '900' : '700'; // Extra bold for ties
}

function updateAchievements(raceData = null) {
    if (raceData === null) {
        raceData = getFilteredRaces();
    }

    // Smart update: preserve expanded state for achievements that still have data
    smartUpdateExpandedAchievements(raceData);

    // If no race data (e.g., Daily view with no races today), clear all visualizations
    if (raceData.length === 0) {
        clearAllVisualizationBars();
        // Also clear buttons when no data
        clearAchievementButtons();
        return;
    }

    // Update button visibility for all players first
    updateAchievementButtons(raceData);

    // Calculate achievements for all players first
    const allAchievements = {};
    players.forEach(player => {
        allAchievements[player] = calculateAchievements(player, raceData);
    });

    // Get Win Streak, Clutch Master, Hot Streak, and Momentum Builder values for relative comparison
    // Only include players with race data (non-null values)
    const winStreakValues = players.map(player => ({
        player: player,
        value: allAchievements[player].winStreak.current
    })).filter(p => p.value !== null).sort((a, b) => b.value - a.value); // Sort highest to lowest

    const clutchMasterValues = players.map(player => ({
        player: player,
        value: allAchievements[player].clutchMaster.current
    })).filter(p => p.value !== null).sort((a, b) => b.value - a.value); // Sort highest to lowest

    const hotStreakValues = players.map(player => ({
        player: player,
        value: allAchievements[player].hotStreak.current
    })).filter(p => p.value !== null).sort((a, b) => b.value - a.value); // Sort highest to lowest

    const momentumBuilderValues = players.map(player => ({
        player: player,
        value: allAchievements[player].momentumBuilder.current
    })).filter(p => p.value !== null).sort((a, b) => b.value - a.value); // Sort highest to lowest

    const perfectDayValues = players.map(player => ({
        player: player,
        value: allAchievements[player].perfectDay.current
    })).filter(p => p.value !== null).sort((a, b) => b.value - a.value); // Sort highest to lowest


    players.forEach(player => {
        const achievements = allAchievements[player];
        
        // Check if player has no data and close expanded achievements if needed
        const playerHasNoData = Object.values(achievements).every(achievement => achievement.current === null);
        if (playerHasNoData) {
            closeAllExpandedAchievements(player);
            closeAllExpandedPositionHeat(player);
        }

        Object.keys(achievements).forEach(achievementKey => {
            const numberElement = document.querySelector(`[data-player="${player}"][data-achievement="${achievementKey}"]`);
            if (!numberElement) return;

            const achievement = achievements[achievementKey];
            const achievementDef = ACHIEVEMENTS[achievementKey];

            // Get the achievement bar for styling
            const achievementBar = numberElement.closest('.achievement-bar');

            // Show dash if player has no race data, otherwise show the current value
            if (achievement.current === null) {
                numberElement.textContent = '-';
                numberElement.style.color = '#ffffff';
                numberElement.style.fontWeight = '700';
                // Remove any circle indicators when no data
                if (achievementBar) {
                    achievementBar.classList.remove('active-streak', 'has-data');
                    // Disable clicking when no data
                    achievementBar.style.cursor = 'default';
                    achievementBar.onclick = null;
                    // Keep pointer-events auto to allow hover tooltips
                    achievementBar.style.pointerEvents = 'auto';
                    // Update aria-label and title
                    achievementBar.setAttribute('aria-label', `${achievementDef.name}: ${achievementDef.description}`);
                    achievementBar.setAttribute('title', achievementDef.description);
                }
                return;
            }

            // Show the actual current value
            numberElement.textContent = achievement.current;
            
            // Update aria-label and title
            if (achievementBar) {
                achievementBar.setAttribute('aria-label', `${achievementDef.name}: ${achievementDef.description}`);
                achievementBar.setAttribute('title', achievementDef.description);
            }
            
            // Handle clicking and cursor based on whether there's data
            if (achievementBar) {
                if (achievement.current === 0) {
                    // Disable clicking when value is 0
                    achievementBar.style.cursor = 'default';
                    achievementBar.onclick = null;
                    // Keep pointer-events auto to allow hover tooltips
                    achievementBar.style.pointerEvents = 'auto';
                } else {
                    // Re-enable clicking when there's data
                    achievementBar.style.cursor = 'pointer';
                    achievementBar.style.pointerEvents = 'auto';
                    achievementBar.onclick = () => toggleAchievementDetails(player, achievementKey);
                }
            }
            
            // Handle circle indicators and styling based on data
            if (achievementBar) {
                if (achievement.current > 0) {
                    // Check if this is an active streak for green circle
                    const hasActiveStreak = checkForActiveStreak(achievementKey, achievement, player, raceData);
                    
                    if (hasActiveStreak) {
                        achievementBar.classList.add('active-streak');
                        achievementBar.classList.remove('has-data');
                    } else {
                        achievementBar.classList.add('has-data');
                        achievementBar.classList.remove('active-streak');
                    }
                } else {
                    // No data - remove all circle indicators
                    achievementBar.classList.remove('active-streak', 'has-data');
                    
                    // Close expanded achievement if it's open and achievement is now 0
                    const expandedItemId = `${player}-${achievementKey}-expanded`;
                    const existingExpandedItem = document.getElementById(expandedItemId);
                    if (existingExpandedItem) {
                        existingExpandedItem.remove();
                        achievementBar.classList.remove('achievement-expanded');
                    }
                }
            }
            
            // Add/remove no-data class for dark mode styling
            // For relative-colored achievements, never add no-data class (we handle colors in getRelativeColor)
            const isRelativeColoredAchievement = ['winStreak', 'clutchMaster', 'hotStreak', 'momentumBuilder', 'perfectDay'].includes(achievementKey);
            if (isRelativeColoredAchievement) {
                numberElement.classList.remove('no-data');
            } else {
                // For non-relative achievements, use original logic
                if (achievement.current === 0) {
                    numberElement.classList.add('no-data');
                } else {
                    numberElement.classList.remove('no-data');
                }
            }

            // Determine color based on achievement type
            let color = achievementDef.colors[0]; // Default bronze
            let fontWeight = '700';
            
            if (achievementKey === 'winStreak') {
                // Special relative coloring for Win Streak
                color = getRelativeColor(player, winStreakValues);
                fontWeight = getRelativeFontWeight(player, winStreakValues);
            } else if (achievementKey === 'clutchMaster') {
                // Special relative coloring for Clutch Master
                color = getRelativeColor(player, clutchMasterValues);
                fontWeight = getRelativeFontWeight(player, clutchMasterValues);
            } else if (achievementKey === 'hotStreak') {
                // Special relative coloring for Hot Streak
                color = getRelativeColor(player, hotStreakValues);
                fontWeight = getRelativeFontWeight(player, hotStreakValues);
            } else if (achievementKey === 'momentumBuilder') {
                // Special relative coloring for Momentum Builder
                color = getRelativeColor(player, momentumBuilderValues);
                fontWeight = getRelativeFontWeight(player, momentumBuilderValues);
            } else if (achievementKey === 'perfectDay') {
                // Special relative coloring for Perfect Day
                color = getRelativeColor(player, perfectDayValues);
                fontWeight = getRelativeFontWeight(player, perfectDayValues);
            } else {
                // Regular achievement color logic
                if (achievement.level >= 3) color = achievementDef.colors[2]; // Gold
                else if (achievement.level >= 2) color = achievementDef.colors[1]; // Silver
            }

            numberElement.style.color = color;
            numberElement.style.fontWeight = fontWeight;
            
            // Check for active streaks and add visual indicator (reuse achievementBar from above)
            const hasActiveStreak = checkForActiveStreak(achievementKey, achievement, player, raceData);
            
            if (hasActiveStreak && achievement.current > 0) {
                achievementBar.classList.add('active-streak');
            } else {
                achievementBar.classList.remove('active-streak');
            }
            
            // Remove old tooltip since we have expandable details now
        });
    });

    updatePositionHeatBars(raceData);
    updateExpandedPositionHeat(raceData);
    updateRecentStreakBars(raceData);
    updateSweetSpotBars(raceData);
    updateExpandedAchievements(raceData);
}

function checkForActiveStreak(achievementKey, achievement, player, raceData) {
    if (!achievement.details || achievement.current === 0) return false;
    
    const playerRaces = raceData.filter(race => race[player] !== null);
    if (playerRaces.length === 0) return false;
    
    // Sort races chronologically
    const chronologicalRaces = [...playerRaces].sort((a, b) => {
        const dateA = new Date(a.date + (a.timestamp ? ' ' + a.timestamp : ''));
        const dateB = new Date(b.date + (b.timestamp ? ' ' + b.timestamp : ''));
        return dateA - dateB;
    });
    
    const lastRace = chronologicalRaces[chronologicalRaces.length - 1];
    
    // Check if the streak extends to the most recent race
    switch (achievementKey) {
        case 'winStreak':
            return lastRace[player] === 1;
            
        case 'hotStreak':
            return lastRace[player] <= 3;
            
        case 'clutchMaster':
            // Check if current streak exists and is active
            return achievement.details.currentActiveStreak && achievement.details.currentActiveStreak.count > 0;
            
        case 'momentumBuilder':
            // Check if current streak exists and is active
            return achievement.details.currentActiveStreak && achievement.details.currentActiveStreak.count > 0;
            
        case 'perfectDay':
            // Check if player is playing today and hasn't finished outside the top half yet
            const today = new Date().toLocaleDateString('en-CA');
            const todayRaces = playerRaces.filter(race => race.date === today);
            
            // Must have at least 1 race today and all races today must be good finishes
            const threshold = getGoodFinishThreshold();
            if (todayRaces.length > 0 && todayRaces.every(race => race[player] <= threshold)) {
                return true;
            }
            return false;
            
        default:
            return false;
    }
}

function closeAllExpandedAchievements(player) {
    const expandedSection = document.getElementById(`${player}-expanded-achievements`);
    if (expandedSection) {
        const expandedList = expandedSection.querySelector('.expanded-achievements-list');
        
        // Clear all expanded achievements
        expandedList.innerHTML = '';
        
        // Remove expanded styling from all main achievement bars for this player
        Object.keys(ACHIEVEMENTS).forEach(achievementKey => {
            const mainBar = document.querySelector(`[data-player="${player}"][data-achievement="${achievementKey}"]`);
            if (mainBar) {
                const achievementBar = mainBar.closest('.achievement-bar');
                if (achievementBar) {
                    achievementBar.classList.remove('achievement-expanded');
                }
            }
        });
    }
}

function closeAllExpandedPositionHeat(player) {
    const expandedSection = document.getElementById(`${player}-expanded-position-heat`);
    if (expandedSection) {
        const expandedList = expandedSection.querySelector('.expanded-position-heat-list');
        const expandedTitle = expandedSection.querySelector('.expanded-position-heat-title');
        
        // Clear all expanded position heat
        expandedList.innerHTML = '';
        expandedTitle.style.display = 'none';
        
        // Remove expanded styling from all main position heat bars for this player
        for (let i = 0; i < 4; i++) {
            const mainBar = document.querySelector(`[data-player="${player}"][data-range="${i}"]`);
            if (mainBar) {
                const heatBar = mainBar.closest('.position-heat-bar');
                if (heatBar) {
                    heatBar.classList.remove('position-heat-expanded');
                }
            }
        }
    }
}

function updateExpandedAchievements(raceData) {
    players.forEach(player => {
        const expandedSection = document.getElementById(`${player}-expanded-achievements`);
        if (!expandedSection) return;
        
        const expandedList = expandedSection.querySelector('.expanded-achievements-list');
        
        // Update all currently expanded achievements
        Array.from(expandedList.children).forEach(expandedItem => {
            const itemId = expandedItem.id;
            const achievementKey = itemId.replace(`${player}-`, '').replace('-expanded', '');
            
            // Recalculate achievement data
            const allAchievements = calculateAchievements(player, raceData);
            const achievementData = allAchievements[achievementKey];
            
            // Update the details text
            const detailsElement = expandedItem.querySelector('.expanded-achievement-details');
            if (detailsElement) {
                detailsElement.innerHTML = generateAchievementDetail(achievementKey, achievementData, player);
            }
            
            // Update the glow based on active streak status
            const hasActiveStreak = checkForActiveStreak(achievementKey, achievementData, player, raceData);
            if (hasActiveStreak) {
                expandedItem.classList.add('active-streak-glow');
            } else {
                expandedItem.classList.remove('active-streak-glow');
            }
        });
    });
}

function clearAllVisualizationBars() {
    players.forEach(player => {
        // Clear expanded achievements and position heat
        const expandedSection = document.getElementById(`${player}-expanded-achievements`);
        if (expandedSection) {
            const expandedList = expandedSection.querySelector('.expanded-achievements-list');
            expandedList.innerHTML = '';
        }
        
        const expandedHeatSection = document.getElementById(`${player}-expanded-position-heat`);
        if (expandedHeatSection) {
            const expandedHeatList = expandedHeatSection.querySelector('.expanded-position-heat-list');
            const expandedHeatTitle = expandedHeatSection.querySelector('.expanded-position-heat-title');
            expandedHeatList.innerHTML = '';
            expandedHeatTitle.style.display = 'none';
        }
        
        // Remove expanded styling and active streak indicators from main achievement bars
        Object.keys(ACHIEVEMENTS).forEach(achievementKey => {
            const mainBar = document.querySelector(`[data-player="${player}"][data-achievement="${achievementKey}"]`);
            if (mainBar) {
                const achievementBar = mainBar.closest('.achievement-bar');
                if (achievementBar) {
                    achievementBar.classList.remove('achievement-expanded');
                    achievementBar.classList.remove('active-streak');
                }
            }
        });
        
        // Remove expanded styling from position heat bars
        for (let i = 0; i < 4; i++) {
            const mainHeatBar = document.querySelector(`[data-player="${player}"][data-range="${i}"]`);
            if (mainHeatBar) {
                const heatBar = mainHeatBar.closest('.position-heat-bar');
                if (heatBar) {
                    heatBar.classList.remove('position-heat-expanded');
                }
            }
        }
        
        // Clear achievement numbers and hide info icons
        Object.keys(ACHIEVEMENTS).forEach(achievementKey => {
            const numberElement = document.querySelector(`[data-player="${player}"][data-achievement="${achievementKey}"]`);
            if (numberElement) {
                numberElement.textContent = '-';
                numberElement.style.color = '#ffffff';
                numberElement.style.fontWeight = '700';
                
                // Remove circle indicators when no data
                const achievementBar = numberElement.closest('.achievement-bar');
                if (achievementBar) {
                    achievementBar.classList.remove('active-streak', 'has-data');
                    // Disable clicking when no data
                    achievementBar.style.cursor = 'default';
                    achievementBar.onclick = null;
                    // Keep pointer-events auto to allow hover tooltips
                    achievementBar.style.pointerEvents = 'auto';
                }
            }
        });

        // Clear position heat percentages and hide info icons
        const heatPercentages = document.querySelectorAll(`[data-player="${player}"][data-range]`);
        heatPercentages.forEach(percentageElement => {
            if (percentageElement.closest('.position-heat-bars')) {
                percentageElement.textContent = '-';
                percentageElement.style.color = '#ffffff';
                percentageElement.style.fontWeight = '700';
                percentageElement.classList.add('no-data');
                percentageElement.parentElement.title = '';
            }
        });
        
        // Disable position heat clickability when no data
        for (let i = 0; i < 4; i++) {
            const heatElement = document.querySelector(`[data-player="${player}"][data-range="${i}"]`);
            if (heatElement) {
                const heatBar = heatElement.closest('.position-heat-bar');
                if (heatBar) {
                    heatBar.style.cursor = 'default';
                    heatBar.style.pointerEvents = 'none';
                }
            }
        }

        // Clear recent streak bars
        for (let i = 0; i < 10; i++) {
            const positionElement = document.querySelector(`[data-player="${player}"][data-race="${i}"]`);
            if (positionElement) {
                positionElement.textContent = '-';
                positionElement.style.backgroundColor = '#e5e7eb';
                positionElement.style.color = '#9ca3af';
                positionElement.style.fontWeight = '400';
                
                // Remove LATEST badge when clearing data
                const existingBadge = positionElement.parentElement.querySelector('.latest-badge');
                if (existingBadge) {
                    existingBadge.remove();
                }
            }
        }

        // Clear sweet spot bars
        for (let i = 1; i <= window.MAX_POSITIONS; i++) {
            const glowElement = document.querySelector(`[data-player="${player}"][data-position="${i}"]`);
            if (glowElement) {
                glowElement.style.opacity = '0';
                glowElement.style.backgroundColor = 'transparent';
                glowElement.style.transition = 'none';
                glowElement.parentElement.title = '';
                glowElement.parentElement.classList.remove('has-data');
            }
        }

    });
}

function updateExpandedPositionHeat(raceData) {
    const ranges = getPositionRanges();

    players.forEach(player => {
        const expandedSection = document.getElementById(`${player}-expanded-position-heat`);
        if (!expandedSection) return;
        
        const expandedList = expandedSection.querySelector('.expanded-position-heat-list');
        if (!expandedList) return;
        
        // Update all currently expanded position heat items
        Array.from(expandedList.children).forEach(expandedItem => {
            const itemId = expandedItem.id;
            const rangeIndex = parseInt(itemId.split('-heat-')[1].split('-expanded')[0]);
            
            if (isNaN(rangeIndex) || rangeIndex < 0 || rangeIndex >= ranges.length) return;
            
            const rangeData = ranges[rangeIndex];
            const playerRaces = raceData.filter(race => race[player] !== null);
            const [min, max] = rangeData.range;
            const racesInRange = playerRaces.filter(race =>
                race[player] >= min && race[player] <= max
            );
            
            // If no races in range anymore, remove the expanded item
            if (racesInRange.length === 0) {
                expandedItem.remove();
                // Remove expanded styling from main bar
                const mainHeatBar = document.querySelector(`[data-player="${player}"][data-range="${rangeIndex}"]`);
                if (mainHeatBar) {
                    const heatBar = mainHeatBar.closest('.position-heat-bar');
                    if (heatBar) {
                        heatBar.classList.remove('position-heat-expanded');
                    }
                }
            } else {
                // Update the content with new data
                const avgPosition = racesInRange.reduce((sum, race) => sum + race[player], 0) / racesInRange.length;
                
                const countElement = expandedItem.querySelector('.position-heat-count');
                const avgElement = expandedItem.querySelector('.position-heat-avg');
                
                if (countElement) {
                    countElement.textContent = `${racesInRange.length} ${racesInRange.length === 1 ? 'race' : 'races'}`;
                }
                if (avgElement) {
                    avgElement.textContent = `Avg Position: ${formatDecimal(avgPosition)}`;
                }
            }
        });
        
        // Update title visibility
        const expandedTitle = expandedSection.querySelector('.expanded-position-heat-title');
        if (expandedTitle) {
            const hasExpandedItems = expandedList.children.length > 0;
            expandedTitle.style.display = hasExpandedItems ? 'block' : 'none';
        }
    });
}

function updatePositionHeatBars(raceData) {
    // Use dynamic position ranges based on current game mode
    const ranges = getPositionRanges();

    players.forEach(player => {
        const playerRaces = raceData.filter(race => race[player] !== null);
        const totalRaces = playerRaces.length;

        ranges.forEach((rangeData, index) => {
            const percentageElement = document.querySelector(`[data-player="${player}"][data-range="${index}"]`);
            if (!percentageElement) return;

            const [min, max] = rangeData.range;
            const racesInRange = playerRaces.filter(race =>
                race[player] >= min && race[player] <= max
            );
            const racesInRangeCount = racesInRange.length;

            const percentage = totalRaces > 0 ? (racesInRangeCount / totalRaces) * 100 : 0;
            
            // Get the position heat bar for cursor/click control
            const heatBar = percentageElement.closest('.position-heat-bar');

            // Show dash if player has no race data, similar to Achievements
            if (totalRaces === 0) {
                percentageElement.textContent = '-';
                percentageElement.style.color = '#ffffff';
                percentageElement.style.fontWeight = '700';
                percentageElement.classList.add('no-data');
                percentageElement.removeAttribute('title');
                // Disable clicking when no data
                if (heatBar) {
                    heatBar.style.cursor = 'default';
                    heatBar.style.pointerEvents = 'none';
                    // Update aria-label and title
                    const noDataText = `Position range ${rangeData.label}: No data`;
                    heatBar.setAttribute('aria-label', noDataText);
                    heatBar.setAttribute('title', noDataText);
                }
            } else {
                // Update percentage text and color
                // Show rounded percentage for display, but keep precise value in title
                const precisePercentage = formatDecimal(percentage);
                const roundedPercentage = Math.round(percentage);
                
                percentageElement.textContent = roundedPercentage + '%';
                percentageElement.style.color = rangeData.color;
                percentageElement.style.fontWeight = racesInRangeCount > 0 ? '700' : '400';
                
                // Remove any title from percentage element to avoid conflicts
                percentageElement.removeAttribute('title');
                
                // Update aria-label and title on the heat bar with full formatted message
                if (heatBar) {
                    const tooltipText = `Position range ${rangeData.label}: ${precisePercentage}% of races`;
                    heatBar.setAttribute('aria-label', tooltipText);
                    heatBar.setAttribute('title', tooltipText);
                }
                
                // Control clickability based on whether there are races in this range
                if (heatBar) {
                    if (racesInRangeCount > 0) {
                        heatBar.style.cursor = 'pointer';
                        heatBar.style.pointerEvents = 'auto';
                    } else {
                        heatBar.style.cursor = 'default';
                        heatBar.style.pointerEvents = 'none';
                        // Close expanded position heat if it's open and now has no races
                        const expandedItemId = `${player}-heat-${index}-expanded`;
                        const existingExpandedItem = document.getElementById(expandedItemId);
                        if (existingExpandedItem) {
                            existingExpandedItem.remove();
                            
                            // Remove expanded styling from main bar
                            const mainHeatBar = percentageElement.closest('.position-heat-bar');
                            if (mainHeatBar) {
                                mainHeatBar.classList.remove('position-heat-expanded');
                            }
                            
                            // Update title visibility
                            const expandedSection = document.getElementById(`${player}-expanded-position-heat`);
                            if (expandedSection) {
                                const expandedList = expandedSection.querySelector('.expanded-position-heat-list');
                                const expandedTitle = expandedSection.querySelector('.expanded-position-heat-title');
                                const hasExpandedItems = expandedList.children.length > 0;
                                expandedTitle.style.display = hasExpandedItems ? 'block' : 'none';
                            }
                        }
                    }
                }
                
                // Add/remove no-data class for dark mode styling
                if (percentage === 0) {
                    percentageElement.classList.add('no-data');
                } else {
                    percentageElement.classList.remove('no-data');
                }
                
                // Remove any existing tooltip
                percentageElement.parentElement.title = '';
            }  
        });
    });
}

function updateRecentStreakBars(raceData) {
    players.forEach(player => {
        const playerRaces = raceData.filter(race => race[player] !== null)
            .sort((a, b) => {
                const dateA = new Date(a.date + (a.timestamp ? ' ' + a.timestamp : ''));
                const dateB = new Date(b.date + (b.timestamp ? ' ' + b.timestamp : ''));
                return dateB - dateA; // Most recent first
            });

        // Helper function to get gradient color based on position
        const getPositionColor = (position) => {
            // Normalize position to 0-1 range (1st = 0, MAX_POSITIONS = 1)
            const normalizedPos = (position - 1) / (window.MAX_POSITIONS - 1);
            
            // Interpolate between green (#10b981) and red (#ef4444)
            const startR = 16, startG = 185, startB = 129;  // #10b981 (green)
            const endR = 239, endG = 68, endB = 68;         // #ef4444 (red)
            
            const r = Math.round(startR + (endR - startR) * normalizedPos);
            const g = Math.round(startG + (endG - startG) * normalizedPos);
            const b = Math.round(startB + (endB - startB) * normalizedPos);
            
            return `rgb(${r}, ${g}, ${b})`;
        };

        for (let i = 0; i < 10; i++) {
            const positionElement = document.querySelector(`[data-player="${player}"][data-race="${i}"]`);
            if (!positionElement) continue;

            // Apply gradient opacity: 100% for first tile, decreasing by 10% each
            const opacity = 1 - (i * 0.1);
            positionElement.parentElement.style.opacity = opacity;
            
            if (i < playerRaces.length) {
                const position = playerRaces[i][player];
                const color = getPositionColor(position);

                positionElement.textContent = position;
                positionElement.style.backgroundColor = color;
                positionElement.style.color = 'white';
                positionElement.style.fontWeight = '600';
                
                // Update aria-label for latest race only
                if (i === 0) {
                    const segmentElement = positionElement.parentElement;
                    if (segmentElement) {
                        segmentElement.setAttribute('aria-label', `Latest race position`);
                    }
                }
                
                // Add LATEST badge to first tile only if there's data
                if (i === 0 && playerRaces.length > 0) {
                    // Remove any existing LATEST badge first
                    const existingBadge = positionElement.parentElement.querySelector('.latest-badge');
                    if (existingBadge) {
                        existingBadge.remove();
                    }
                    
                    // Create LATEST badge
                    const latestBadge = document.createElement('span');
                    latestBadge.className = 'latest-badge';
                    latestBadge.textContent = 'LATEST';
                    latestBadge.style.cssText = `
                        position: absolute;
                        top: -2px;
                        right: -2px;
                        background: #ef4444;
                        color: white;
                        font-size: 6px;
                        font-weight: 700;
                        padding: 1px 3px;
                        border-radius: 2px;
                        z-index: 10;
                        line-height: 1;
                    `;
                    positionElement.parentElement.appendChild(latestBadge);
                }
            } else {
                positionElement.textContent = '-';
                positionElement.style.backgroundColor = '#e5e7eb';
                positionElement.style.color = '#9ca3af';
                positionElement.style.fontWeight = '400';
                
                // Update aria-label for latest race only when empty
                if (i === 0) {
                    const segmentElement = positionElement.parentElement;
                    if (segmentElement) {
                        segmentElement.setAttribute('aria-label', 'Latest race position: No data');
                    }
                }
                
                // Remove LATEST badge if no data
                const existingBadge = positionElement.parentElement.querySelector('.latest-badge');
                if (existingBadge) {
                    existingBadge.remove();
                }
            }
        }
    });
}

function updateSweetSpotBars(raceData) {
    players.forEach(player => {
        const playerRaces = raceData.filter(race => race[player] !== null);
        const positionCounts = {};

        // Count occurrences of each position
        playerRaces.forEach(race => {
            const pos = race[player];
            positionCounts[pos] = (positionCounts[pos] || 0) + 1;
        });

        // Find the maximum count to determine thresholds
        const maxCount = Math.max(...Object.values(positionCounts), 0);
        const avgCount = Object.values(positionCounts).reduce((sum, count) => sum + count, 0) / Object.keys(positionCounts).length || 0;

        // Single color with transparency scaling based on frequency
        const getColorForCount = (count) => {
            if (count === 0) return { color: 'transparent', opacity: 0 }; // Transparent for no data

            // Use different colors for light and dark mode
            const baseColor = isDarkTheme ? '#06b6d4' : '#3b82f6'; // Cyan for dark mode, blue for light mode

            // Calculate opacity based on frequency (0.3 minimum to 1.0 maximum)
            const percentage = count / Math.max(maxCount, 1);
            const opacity = 0.3 + (percentage * 0.7); // Scale from 0.3 to 1.0

            return { color: baseColor, opacity: opacity };
        };

        for (let i = 1; i <= window.MAX_POSITIONS; i++) {
            const glowElement = document.querySelector(`[data-player="${player}"][data-position="${i}"]`);
            if (!glowElement) continue;

            const count = positionCounts[i] || 0;
            const colorData = getColorForCount(count);

            if (count > 0) {
                glowElement.style.opacity = colorData.opacity;
                glowElement.style.backgroundColor = colorData.color;
                glowElement.style.transition = 'all 0.3s ease';
                const percentage = formatDecimal((count/playerRaces.length)*100);
                const raceText = count === 1 ? 'race' : 'races';
                glowElement.parentElement.title = `${count} ${raceText} (${percentage}%)`;
                glowElement.parentElement.classList.add('has-data');
                
                // Update aria-label for sweet spot
                const spotElement = glowElement.parentElement;
                if (spotElement) {
                    spotElement.setAttribute('aria-label', `Position ${i}: Finished ${count} ${raceText} (${percentage}%)`);
                }
            } else {
                glowElement.style.opacity = '0';
                glowElement.style.transition = 'none';
                glowElement.parentElement.title = '';
                glowElement.parentElement.classList.remove('has-data');
                
                // Update aria-label for empty sweet spot
                const spotElement = glowElement.parentElement;
                if (spotElement) {
                    spotElement.setAttribute('aria-label', `Position ${i}: Never finished here`);
                }
            }
        }
    });
}

// Export functions for global use
window.getGoodFinishThreshold = getGoodFinishThreshold;
window.getPositionRanges = getPositionRanges;
window.createAllBars = createAllBars;
