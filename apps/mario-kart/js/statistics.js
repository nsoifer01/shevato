function calculateStats(raceData = null) {
    if (raceData === null) {
        raceData = getFilteredRaces();
    }
    // Use the global dynamic players array
    const stats = {
        averageFinish: {},
        firstPlace: {},
        podiumFinish: {},
        totalRaces: raceData.length,
        racesPlayed: {},
        bestStreak: {},
        h2h: {},
        h2hByDay: {},
        h2hLongestStreaks: {},
        h2hLongestStreakDates: {},
        h2hCurrentStreaks: {},
        h2hStreakDetails: {},
        h2hBiggestWins: {},
        h2hDaysWon: {},
        h2hBiggestDailyWins: {}
    };

    // Initialize dynamic H2H structures
    players.forEach(player => {
        stats.h2h[player] = {};
        stats.h2hLongestStreaks[player] = {};
        stats.h2hLongestStreakDates[player] = {};
        stats.h2hCurrentStreaks[player] = {};
        stats.h2hStreakDetails[player] = {};
        stats.h2hBiggestWins[player] = {};
        stats.h2hDaysWon[player] = {};
        stats.h2hBiggestDailyWins[player] = {};

        players.forEach(opponent => {
            if (player !== opponent) {
                stats.h2h[player][opponent] = 0;
                stats.h2hLongestStreaks[player][opponent] = 0;
                stats.h2hLongestStreakDates[player][opponent] = null;
                stats.h2hCurrentStreaks[player][opponent] = 0;
                stats.h2hStreakDetails[player][opponent] = [];
                stats.h2hBiggestWins[player][opponent] = { gap: 0, raceIndex: -1, date: null, winnerPosition: null, loserPosition: null };
                stats.h2hDaysWon[player][opponent] = 0;
                stats.h2hBiggestDailyWins[player][opponent] = { dayWins: 0, dayLosses: 0, margin: 0, date: null };
            }
        });
    });

    players.forEach(player => {
        stats.averageFinish[player] = 0;
        stats.firstPlace[player] = 0;
        stats.podiumFinish[player] = 0;
        stats.racesPlayed[player] = 0;
        stats.bestStreak[player] = 0;
    });

    if (raceData.length === 0) return stats;

    raceData.forEach(race => {
        players.forEach(player => {
            if (race[player] !== null) {
                stats.racesPlayed[player]++;
                stats.averageFinish[player] += race[player];
                if (race[player] === 1) stats.firstPlace[player]++;
                if (race[player] <= 3) stats.podiumFinish[player]++;
            }
        });

        // Head to head (only count when both players played)
        // Initialize day tracking if not exists
        if (!stats.h2hByDay[race.date]) {
            stats.h2hByDay[race.date] = {};
            players.forEach(player => {
                stats.h2hByDay[race.date][player] = {};
                players.forEach(opponent => {
                    if (player !== opponent) {
                        stats.h2hByDay[race.date][player][opponent] = 0;
                    }
                });
            });
        }

        // Compare all player pairs dynamically
        for (let i = 0; i < players.length; i++) {
            for (let j = i + 1; j < players.length; j++) {
                const player1 = players[i];
                const player2 = players[j];

                if (race[player1] !== null && race[player2] !== null) {
                    if (race[player1] < race[player2]) {
                        stats.h2h[player1][player2]++;
                        stats.h2hByDay[race.date][player1][player2]++;
                    } else if (race[player2] < race[player1]) {
                        stats.h2h[player2][player1]++;
                        stats.h2hByDay[race.date][player2][player1]++;
                    }
                }
            }
        }


    });

    // Calculate longest winning streaks
    calculateLongestStreaks(raceData, stats);

    // Calculate daily H2H wins dynamically
    Object.entries(stats.h2hByDay).forEach(([date, dayStats]) => {
        // Check each matchup for that day dynamically
        for (let i = 0; i < players.length; i++) {
            for (let j = i + 1; j < players.length; j++) {
                const player1 = players[i];
                const player2 = players[j];

                const player1Wins = dayStats[player1][player2] || 0;
                const player2Wins = dayStats[player2][player1] || 0;

                if (player1Wins > player2Wins) {
                    stats.h2hDaysWon[player1][player2]++;
                    
                    // Check if this is the biggest daily win margin for player1 over player2
                    const margin = player1Wins - player2Wins;
                    if (margin > stats.h2hBiggestDailyWins[player1][player2].margin) {
                        stats.h2hBiggestDailyWins[player1][player2] = {
                            dayWins: player1Wins,
                            dayLosses: player2Wins,
                            margin: margin,
                            date: date
                        };
                    }
                } else if (player2Wins > player1Wins) {
                    stats.h2hDaysWon[player2][player1]++;
                    
                    // Check if this is the biggest daily win margin for player2 over player1
                    const margin = player2Wins - player1Wins;
                    if (margin > stats.h2hBiggestDailyWins[player2][player1].margin) {
                        stats.h2hBiggestDailyWins[player2][player1] = {
                            dayWins: player2Wins,
                            dayLosses: player1Wins,
                            margin: margin,
                            date: date
                        };
                    }
                }
            }
        }
    });

    players.forEach(player => {
        if (stats.racesPlayed[player] > 0) {
            stats.averageFinish[player] = formatDecimal(stats.averageFinish[player] / stats.racesPlayed[player]);
        } else {
            stats.averageFinish[player] = '-';
        }
    });

    // Calculate best streak (consecutive podium finishes) - sort by chronological order first
    players.forEach(player => {
        let currentStreak = 0;
        let maxStreak = 0;

        // Sort races chronologically by date and timestamp for proper streak calculation
        const chronologicalRaces = [...raceData].sort((a, b) => {
            const dateA = new Date(a.date + (a.timestamp ? ' ' + a.timestamp : ''));
            const dateB = new Date(b.date + (b.timestamp ? ' ' + b.timestamp : ''));
            return dateA - dateB;
        });

        chronologicalRaces.forEach(race => {
            if (race[player] !== null) {
                if (race[player] <= 3) {
                    currentStreak++;
                    maxStreak = Math.max(maxStreak, currentStreak);
                } else {
                    currentStreak = 0;
                }
            }
        });

        stats.bestStreak[player] = maxStreak;
    });

    return stats;
}

function calculateLongestStreaks(raceData, stats) {
    // Sort races chronologically
    const chronologicalRaces = [...raceData].sort((a, b) => {
        const dateA = new Date(a.date + (a.timestamp ? ' ' + a.timestamp : ''));
        const dateB = new Date(b.date + (b.timestamp ? ' ' + b.timestamp : ''));
        return dateA - dateB;
    });

    // Track current streaks for each player pair dynamically
    const currentStreaks = {};
    const currentStreakDetails = {};
    players.forEach(player => {
        currentStreaks[player] = {};
        currentStreakDetails[player] = {};
        players.forEach(opponent => {
            if (player !== opponent) {
                currentStreaks[player][opponent] = 0;
                currentStreakDetails[player][opponent] = [];
            }
        });
    });

    chronologicalRaces.forEach((race, raceIndex) => {
        // Compare all player pairs dynamically
        for (let i = 0; i < players.length; i++) {
            for (let j = i + 1; j < players.length; j++) {
                const player1 = players[i];
                const player2 = players[j];

                if (race[player1] !== null && race[player2] !== null) {
                    const gap1v2 = race[player2] - race[player1];
                    const gap2v1 = race[player1] - race[player2];
                    
                    // Track biggest wins
                    if (gap1v2 > stats.h2hBiggestWins[player1][player2].gap) {
                        stats.h2hBiggestWins[player1][player2] = {
                            gap: gap1v2,
                            raceIndex: raceIndex,
                            date: race.date,
                            winnerPosition: race[player1],
                            loserPosition: race[player2]
                        };
                    }
                    if (gap2v1 > stats.h2hBiggestWins[player2][player1].gap) {
                        stats.h2hBiggestWins[player2][player1] = {
                            gap: gap2v1,
                            raceIndex: raceIndex,
                            date: race.date,
                            winnerPosition: race[player2],
                            loserPosition: race[player1]
                        };
                    }

                    if (race[player1] < race[player2]) {
                        // Player1 beats Player2
                        currentStreaks[player1][player2]++;
                        currentStreakDetails[player1][player2].push(`${race[player1]}v${race[player2]}`);
                        currentStreaks[player2][player1] = 0;
                        currentStreakDetails[player2][player1] = [];
                        
                        // Update longest streak and details if this is a new record
                        if (currentStreaks[player1][player2] > stats.h2hLongestStreaks[player1][player2]) {
                            stats.h2hLongestStreaks[player1][player2] = currentStreaks[player1][player2];
                            stats.h2hLongestStreakDates[player1][player2] = race.date;
                            stats.h2hStreakDetails[player1][player2] = [...currentStreakDetails[player1][player2]];
                        }
                    } else if (race[player2] < race[player1]) {
                        // Player2 beats Player1
                        currentStreaks[player2][player1]++;
                        currentStreakDetails[player2][player1].push(`${race[player2]}v${race[player1]}`);
                        currentStreaks[player1][player2] = 0;
                        currentStreakDetails[player1][player2] = [];
                        
                        // Update longest streak and details if this is a new record
                        if (currentStreaks[player2][player1] > stats.h2hLongestStreaks[player2][player1]) {
                            stats.h2hLongestStreaks[player2][player1] = currentStreaks[player2][player1];
                            stats.h2hLongestStreakDates[player2][player1] = race.date;
                            stats.h2hStreakDetails[player2][player1] = [...currentStreakDetails[player2][player1]];
                        }
                    }
                }
            }
        }
    });

    // Store current streaks at the end
    players.forEach(player => {
        players.forEach(opponent => {
            if (player !== opponent) {
                stats.h2hCurrentStreaks[player][opponent] = currentStreaks[player][opponent];
            }
        });
    });
}

function generateH2HTable(stats) {
    // Generate header row
    const headerCells = players.map(player => `<th class="h2h-header-cell">vs ${window.PlayerNameManager ? window.PlayerNameManager.get(player) : getPlayerName(player)}</th>`).join('');

    // Generate data rows
    const dataRows = players.map(rowPlayer => {
        const cells = players.map(colPlayer => {
            if (rowPlayer === colPlayer) {
                return '<td class="h2h-cell h2h-self h2h-fixed-width"><span class="h2h-self-text">N/A</span></td>';
            } else {
                const wins = stats.h2h[rowPlayer][colPlayer] || 0;
                const losses = stats.h2h[colPlayer][rowPlayer] || 0;
                const totalGames = wins + losses;
                
                // Show dash if no head-to-head games between these players
                if (totalGames === 0) {
                    return `
                        <td class="h2h-cell h2h-no-data h2h-fixed-width">
                            <div class="h2h-content">
                                <div class="h2h-score">-</div>
                            </div>
                        </td>
                    `;
                }
                
                const cssClass = wins > losses ? 'h2h-winner-text' : wins < losses ? 'h2h-loser-text' : 'h2h-tie';
                const longestStreak = stats.h2hLongestStreaks[rowPlayer][colPlayer] || 0;
                const currentStreak = stats.h2hCurrentStreaks[rowPlayer][colPlayer] || 0;
                const streakDate = stats.h2hLongestStreakDates[rowPlayer][colPlayer];
                const streakDetails = stats.h2hStreakDetails[rowPlayer][colPlayer] || [];
                const biggestWin = stats.h2hBiggestWins[rowPlayer][colPlayer];
                
                let streakDisplay = '';
                // Check if current streak is active (equals longest streak and currently ongoing)
                const isActiveStreak = currentStreak > 0 && currentStreak === longestStreak;
                const displayStreak = longestStreak;
                
                if (displayStreak > 0) {
                    let formattedDate = '';
                    if (streakDate && !isActiveStreak) {
                        // Parse date string directly to avoid timezone issues
                        const [year, month, day] = streakDate.split('-');
                        const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 
                                          'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
                        formattedDate = `${monthNames[parseInt(month) - 1]} ${parseInt(day)}`;
                    }
                    
                    const activeIndicator = isActiveStreak ? ' (active)' : '';
                    
                    // Format streak details (only show for historical streaks, not current active ones)
                    const detailsText = (streakDetails.length > 0 && !isActiveStreak) ? `: ${streakDetails.join(', ')}` : '';
                    
                    streakDisplay = `
                        <div class="h2h-streak">
                            <div class="h2h-streak-main">Longest Win Streak - ${displayStreak}${activeIndicator}</div>
                            ${detailsText ? `<div class="h2h-streak-details">${detailsText.substring(2)}</div>` : ''}
                        </div>
                    `;
                }
                
                // Format biggest win
                let biggestWinDisplay = '';
                if (biggestWin && biggestWin.gap > 0) {
                    let formattedDate = '';
                    if (biggestWin.date) {
                        formattedDate = biggestWin.date; // Use the original YYYY-MM-DD format
                    }
                    
                    biggestWinDisplay = `
                        <div class="h2h-biggest-win">
                            Biggest win: ${biggestWin.gap} positions (Race #${biggestWin.raceIndex + 1}${formattedDate ? ` - ${formattedDate}` : ''})
                        </div>
                    `;
                }
                
                return `
                    <td class="h2h-cell ${cssClass} h2h-fixed-width">
                        <div class="h2h-content">
                            <div class="h2h-score">${wins}<span class="h2h-separator">-</span>${losses}</div>
                            ${streakDisplay}
                            ${biggestWinDisplay}
                        </div>
                    </td>
                `;
            }
        }).join('');

        return `
            <tr>
                <td class="h2h-player-name">${window.PlayerNameManager ? window.PlayerNameManager.get(rowPlayer) : getPlayerName(rowPlayer)}</td>
                ${cells}
            </tr>
        `;
    }).join('');

    return `
        <div class="h2h-table-container">
            <table class="h2h-table">
                <thead>
                    <tr>
                        <th class="h2h-header-cell h2h-corner">Player</th>
                        ${headerCells}
                    </tr>
                </thead>
                <tbody>
                    ${dataRows}
                </tbody>
            </table>
        </div>
    `;
}

function generateDailyH2HTable(stats) {
    // Generate header row
    const headerCells = players.map(player => `<th class="h2h-header-cell">vs ${window.PlayerNameManager ? window.PlayerNameManager.get(player) : getPlayerName(player)}</th>`).join('');

    // Generate data rows
    const dataRows = players.map(rowPlayer => {
        const cells = players.map(colPlayer => {
            if (rowPlayer === colPlayer) {
                return '<td class="h2h-cell h2h-self h2h-fixed-width"><span class="h2h-self-text">N/A</span></td>';
            } else {
                const daysWon = stats.h2hDaysWon[rowPlayer][colPlayer] || 0;
                const daysLost = stats.h2hDaysWon[colPlayer][rowPlayer] || 0;
                
                // Check if these players have ever played together (total H2H games > 0)
                const totalH2HGames = (stats.h2h[rowPlayer][colPlayer] || 0) + (stats.h2h[colPlayer][rowPlayer] || 0);
                
                // Show dash if players have never played together
                if (totalH2HGames === 0) {
                    return `
                        <td class="h2h-cell h2h-no-data h2h-fixed-width">
                            <div class="h2h-content">
                                <div class="h2h-score">-</div>
                            </div>
                        </td>
                    `;
                }
                
                const cssClass = daysWon > daysLost ? 'h2h-winner-text' : daysWon < daysLost ? 'h2h-loser-text' : 'h2h-tie';
                
                // Get biggest daily win information
                const biggestDailyWin = stats.h2hBiggestDailyWins[rowPlayer][colPlayer];
                let biggestDailyWinDisplay = '';
                
                if (biggestDailyWin && biggestDailyWin.margin > 0) {
                    biggestDailyWinDisplay = `
                        <div class="h2h-biggest-win">
                            Biggest daily win: ${biggestDailyWin.dayWins}-${biggestDailyWin.dayLosses} (${biggestDailyWin.date})
                        </div>
                    `;
                }
                
                return `
                    <td class="h2h-cell ${cssClass} h2h-fixed-width">
                        <div class="h2h-content">
                            <div class="h2h-score">${daysWon}<span class="h2h-separator">-</span>${daysLost}</div>
                            ${biggestDailyWinDisplay}
                        </div>
                    </td>
                `;
            }
        }).join('');

        return `
            <tr>
                <td class="h2h-player-name">${window.PlayerNameManager ? window.PlayerNameManager.get(rowPlayer) : getPlayerName(rowPlayer)}</td>
                ${cells}
            </tr>
        `;
    }).join('');

    return `
        <div class="h2h-table-container">
            <table class="h2h-daily-table">
                <thead>
                    <tr>
                        <th class="h2h-header-cell h2h-corner">Player</th>
                        ${headerCells}
                    </tr>
                </thead>
                <tbody>
                    ${dataRows}
                </tbody>
            </table>
        </div>
    `;
}

function getStatClass(value, values, isHigherBetter = false) {
    // Filter out non-numeric values and convert to numbers for consistency
    const numericValues = values.filter(v => v !== '-' && !isNaN(v)).map(v => Number(v));
    const numericValue = Number(value);

    if (numericValues.length === 0 || value === '-' || isNaN(numericValue)) return 'middle';

    // Get unique values and sort them
    const uniqueValues = [...new Set(numericValues)].sort((a, b) => isHigherBetter ? b - a : a - b);

    // If all values are the same, everyone is tied (gray)
    if (uniqueValues.length === 1) return 'middle';

    // Count how many people have this exact value
    const valueCount = numericValues.filter(v => Math.abs(v - numericValue) < 0.001).length;

    // If tied with anyone, it's gray
    if (valueCount > 1) return 'middle';

    // Check if any player has no data (indicated by having fewer numeric values than total values)
    const hasPlayerWithNoData = numericValues.length < values.length;

    // Find the rank of this value among unique values
    const rank = uniqueValues.findIndex(v => Math.abs(v - numericValue) < 0.001);

    // Special handling for 2 players: always green for winner, red for loser
    if (numericValues.length === 2 && values.length === 2) {
        if (rank === 0) return 'best';      // Green for winner
        return 'worst';                     // Red for loser
    }
    
    if (hasPlayerWithNoData) {
        // When someone has no data, use green-red color scheme (skip yellow)
        if (rank === 0) return 'best';      // Green for 1st place
        return 'worst';                     // Red for everyone else
    } else {
        // Normal green-yellow-red color scheme when everyone has data
        if (rank === 0) return 'best';      // Green for 1st place
        if (rank === 1) return 'second';    // Yellow for 2nd place
        return 'worst';                     // Red for 3rd+ place
    }
}
