let trendChart = null;

function createTrendCharts(raceData = null) {
    if (raceData === null) {
        raceData = getFilteredRaces();
    }

    const statsDisplay = document.getElementById('stats-display');

    if (raceData.length === 0) {
        statsDisplay.innerHTML = `
            <div class="no-data-message">
                <div style="text-align: center; padding: 60px 20px; color: #718096;">
                    <h3 style="font-size: 1.5em; margin-bottom: 10px;">No race data available</h3>
                    <p>Add some races to see trend analysis!</p>
                </div>
            </div>
        `;
        return;
    }

    // Add summary stats
    const totalRaces = raceData.length;
    const dateRange = raceData.length > 0 
        ? `${raceData[0].date} - ${raceData[raceData.length - 1].date}` 
        : 'No data';
    
    statsDisplay.innerHTML = `
        <section id="trends">
            <h2>📈 Performance Trends</h2>
            <p style="text-align: center; color: #718096; margin-top: -0.5rem; margin-bottom: 1rem; font-size: 0.875rem;">
                ${totalRaces} races • ${dateRange}
            </p>
            <div id="trends-chart-container">
                <canvas id="trendsChart"></canvas>
            </div>
        </section>
    `;

    // Create performance trend chart
    const canvas = document.getElementById('trendsChart');
    const ctx = canvas.getContext('2d');

    // Sort races chronologically
    const sortedRaces = [...raceData].sort((a, b) => {
        const dateA = new Date(a.date + (a.timestamp ? ' ' + a.timestamp : ''));
        const dateB = new Date(b.date + (b.timestamp ? ' ' + b.timestamp : ''));
        return dateA - dateB;
    });

    const labels = sortedRaces.map((race, index) => `Race ${index + 1}`);
    // Use global dynamic players array
    const colors = ['#ef4444', '#3b82f6', '#10b981', '#f59e0b'];

    const datasets = players.map((player, index) => ({
        label: window.PlayerNameManager ? window.PlayerNameManager.get(player) : getPlayerName(player),
        data: sortedRaces.map(race => race[player]),
        borderColor: colors[index],
        backgroundColor: colors[index] + '20',
        fill: false,
        tension: 0.4,
        pointRadius: 4,
        pointHoverRadius: 6,
        pointBackgroundColor: colors[index],
        pointBorderColor: '#ffffff',
        pointBorderWidth: 2,
        pointHoverBackgroundColor: colors[index],
        pointHoverBorderColor: '#ffffff',
        pointHoverBorderWidth: 3,
        borderWidth: 3
    }));

    if (trendChart) trendChart.destroy();

    trendChart = new Chart(ctx, {
        type: 'line',
        data: { labels, datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            layout: {
                padding: {
                    top: 10,
                    bottom: 10,
                    left: 0,      // No padding on left to keep y-axis visible
                    right: 10
                }
            },
            interaction: {
                mode: 'index',
                intersect: false
            },
            plugins: {
                legend: {
                    labels: {
                        color: '#e2e8f0',
                        padding: 20,
                        font: {
                            size: 14,
                            weight: '600'
                        },
                        usePointStyle: true,
                        pointStyle: 'circle'
                    },
                    position: 'bottom'
                },
                tooltip: {
                    backgroundColor: 'rgba(45, 55, 72, 0.95)',
                    titleColor: '#f7fafc',
                    bodyColor: '#e2e8f0',
                    borderColor: '#4a5568',
                    borderWidth: 1,
                    padding: 12,
                    cornerRadius: 8,
                    displayColors: true,
                    boxPadding: 6
                }
            },
            scales: {
                y: {
                    type: 'linear',
                    reverse: true,
                    suggestedMin: MIN_POSITIONS - 0.5,
                    suggestedMax: MAX_POSITIONS + 0.5,
                    ticks: {
                        color: '#e2e8f0',
                        padding: 8,
                        font: {
                            size: 12,
                            weight: '500'
                        },
                        stepSize: 2,            // Show every position
                        autoSkip: false,        // Show all ticks
                        includeBounds: true,
                    },
                    grid: {
                        color: 'rgba(74, 85, 104, 0.3)',
                        drawBorder: true,
                        lineWidth: 1
                    },
                    border: {
                        display: true,
                        color: '#4a5568',
                    },
                    title: {
                        display: true,
                        text: 'Position',
                        color: '#e2e8f0',
                        font: {
                            size: 14,
                            weight: '600'
                        }
                    }
                },
                x: {
                    ticks: {
                        color: '#e2e8f0',
                        padding: 8,
                        font: {
                            size: 12,
                            weight: '500'
                        }
                    },
                    grid: {
                        color: 'rgba(74, 85, 104, 0.3)',
                        drawBorder: false
                    }
                }
            }
        }
    });

}

function createHeatmapView(raceData = null) {
    if (raceData === null) {
        raceData = getFilteredRaces();
    }

    const statsDisplay = document.getElementById('stats-display');

    if (raceData.length === 0) {
        statsDisplay.innerHTML = `
            <div class="no-data-message">
                <div style="text-align: center; padding: 60px 20px; color: #718096;">
                    <h3 style="font-size: 1.5em; margin-bottom: 10px;">No race data available</h3>
                    <p>Add some races to see weekly activity!</p>
                </div>
            </div>
        `;
        return;
    }

    const weeklyData = calculateWeeklyActivityData(raceData);

    statsDisplay.innerHTML = `
        <div class="activity-container">
            <h3 class="activity-title">📅 Weekly Activity Distribution</h3>
            <div class="activity-content">
                <div class="weekly-table-container">
                    <table id="weekly-breakdown-table" class="weekly-breakdown-table">
                        <thead>
                            <tr>
                                <th>Day</th>
                                <th>Activity</th>
                                ${players.map(player => `<th>${window.PlayerNameManager ? window.PlayerNameManager.get(player) : getPlayerName(player)}<span class="subtitle">Avg Pos</span></th>`).join('')}
                            </tr>
                        </thead>
                        <tbody id="weekly-breakdown-body">
                        </tbody>
                    </table>
                </div>
                <div class="activity-chart-wrapper">
                    <canvas id="activity-chart"></canvas>
                </div>
            </div>
        </div>
    `;

    // Create donut chart with timeout to ensure DOM is ready
    setTimeout(() => {
        try {
            const canvas = document.getElementById('activity-chart');
            if (!canvas) {
                console.error('Canvas element not found');
                return;
            }

        const ctx = canvas.getContext('2d');

        // Filter out days with 0 races for cleaner chart
        const activeDays = weeklyData.filter(day => day.races > 0);

        if (activeDays.length === 0) {
            statsDisplay.innerHTML = `
                <div style="text-align: center; padding: 60px 20px; color: #718096;">
                    <h3 style="font-size: 1.5em; margin-bottom: 10px;">No racing activity recorded</h3>
                    <p>Add some races to see weekly activity patterns!</p>
                </div>
            `;
            return;
        }

        // Calculate detailed data for each day and player
        const total = activeDays.reduce((sum, day) => sum + day.races, 0);
        const dayNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
        const dayData = {};
        
        dayNames.forEach((dayName, dayIndex) => {
            const dayRaces = raceData.filter(race => {
                // Parse date in local timezone to avoid UTC offset issues
                const dateParts = race.date.split('-');
                const raceDate = new Date(dateParts[0], dateParts[1] - 1, dateParts[2]);
                const dayOfWeek = raceDate.getDay();
                const mondayBasedIndex = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
                return mondayBasedIndex === dayIndex;
            });
            
            const percentage = dayRaces.length > 0 ? formatDecimal((dayRaces.length / raceData.length) * 100) : '0';
            const playerAverages = {};
            
            players.forEach(player => {
                const playerPositions = dayRaces
                    .filter(race => race[player] !== null)
                    .map(race => race[player]);
                
                if (playerPositions.length > 0) {
                    const avg = playerPositions.reduce((sum, pos) => sum + pos, 0) / playerPositions.length;
                    playerAverages[player] = formatDecimal(avg);
                } else {
                    playerAverages[player] = '-';
                }
            });
            
            dayData[dayName] = {
                races: dayRaces.length,
                percentage,
                playerAverages
            };
        });
        
        // Color array matching the chart
        const chartColors = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#84cc16'];
        
        // Create color mapping based on activeDays order (same as chart)
        const dayColorMap = {};
        activeDays.forEach((day, index) => {
            dayColorMap[day.name] = chartColors[index];
        });
        
        // Populate the table
        const tableBody = document.getElementById('weekly-breakdown-body');
        if (tableBody) {
            tableBody.innerHTML = dayNames.map(dayName => {
                const data = dayData[dayName];
                if (data.races === 0) return ''; // Skip days with no races
                
                const dayColor = dayColorMap[dayName];
                
                return `
                    <tr>
                        <td>
                            ${dayName}
                        </td>
                        <td>
                            <div style="display: flex; align-items: center; justify-content: center; gap: 8px;">
                                <div style="width: 12px; height: 12px; background-color: ${dayColor}; border-radius: 50%; flex-shrink: 0;"></div>
                                ${data.percentage}%
                            </div>
                        </td>
                        ${players.map(player => `<td>${data.playerAverages[player]}</td>`).join('')}
                    </tr>
                `;
            }).filter(row => row !== '').join('');
        }

        new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: activeDays.map(day => day.name),
            datasets: [{
                data: activeDays.map(day => day.races),
                backgroundColor: [
                    '#3b82f6', // Blue
                    '#10b981', // Green
                    '#f59e0b', // Yellow
                    '#ef4444', // Red
                    '#8b5cf6', // Purple
                    '#06b6d4', // Cyan
                    '#84cc16'  // Lime
                ],
                borderWidth: 4,
                borderColor: '#374151',
                hoverBorderWidth: 6,
                hoverBorderColor: '#374151'
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: false
                },
                tooltip: {
                    backgroundColor: 'rgba(45, 55, 72, 0.95)',
                    titleColor: '#f7fafc',
                    bodyColor: '#e2e8f0',
                    borderColor: '#4a5568',
                    borderWidth: 1,
                    padding: 12,
                    cornerRadius: 8,
                    displayColors: true,
                    boxPadding: 6,
                    callbacks: {
                        title: function(tooltipItems) {
                            return tooltipItems[0].label;
                        },
                        label: function(context) {
                            const races = context.parsed;
                            return `${races} ${races === 1 ? 'race' : 'races'}`;
                        }
                    }
                }
            },
            cutout: '70%',
            animation: {
                animateRotate: true,
                animateScale: true,
                duration: 1000,
                easing: 'easeInOutQuart'
            }
        },
        plugins: [{
            id: 'segmentLabels',
            afterDatasetsDraw: function(chart) {
                const ctx = chart.ctx;
                const meta = chart.getDatasetMeta(0);
                const data = meta.data;
                
                ctx.save();
                
                data.forEach((segment, index) => {
                    // Get the center point of each segment
                    const model = segment;
                    const midAngle = (model.startAngle + model.endAngle) / 2;
                    const radius = (model.innerRadius + model.outerRadius) / 2;
                    
                    // Calculate position for the label
                    const x = model.x + Math.cos(midAngle) * radius;
                    const y = model.y + Math.sin(midAngle) * radius;
                    
                    // Get day abbreviation (first two letters)
                    const dayName = activeDays[index].name;
                    const abbreviation = dayName.substring(0, 2).toUpperCase();
                    
                    // Draw the abbreviation with shadow for better visibility
                    ctx.shadowColor = 'rgba(0, 0, 0, 0.3)';
                    ctx.shadowBlur = 3;
                    ctx.shadowOffsetX = 0;
                    ctx.shadowOffsetY = 1;
                    ctx.fillStyle = '#ffffff';
                    ctx.font = 'bold 12px system-ui';
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    ctx.fillText(abbreviation, x, y);
                    
                    // Reset shadow
                    ctx.shadowColor = 'transparent';
                    ctx.shadowBlur = 0;
                });
                
                ctx.restore();
            }
        }]
    });
    } catch (error) {
        console.error('Error creating activity chart:', error);
        statsDisplay.innerHTML = `
            <div style="text-align: center; padding: 60px 20px; color: #718096;">
                <h3 style="font-size: 1.5em; margin-bottom: 10px;">Chart Loading Error</h3>
                <p>Unable to display weekly activity chart. Please try refreshing the page.</p>
            </div>
        `;
        }
    }, 100);
    
    // Update player icons in table headers after table is rendered
    if (window.updateAllPlayerIcons) {
        setTimeout(() => {
            window.updateAllPlayerIcons();
        }, 150);
    }
}

function calculateWeeklyActivityData(raceData) {
    // Start week on Monday: Mon, Tue, Wed, Thu, Fri, Sat, Sun
    const dayNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const weeklyRaces = Array(7).fill(0);

    raceData.forEach(race => {
        // Parse date in local timezone to avoid UTC offset issues
        const dateParts = race.date.split('-');
        const raceDate = new Date(dateParts[0], dateParts[1] - 1, dateParts[2]);
        const dayOfWeek = raceDate.getDay();
        // Convert Sunday (0) to index 6, Monday (1) to index 0, etc.
        const mondayBasedIndex = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
        weeklyRaces[mondayBasedIndex]++;
    });

    const totalRaces = raceData.length;
    const maxRaces = Math.max(...weeklyRaces, 1); // For bar height scaling

    const result = dayNames.map((name, index) => ({
        name,
        races: weeklyRaces[index],
        percentage: totalRaces > 0 ? formatDecimal((weeklyRaces[index] / totalRaces) * 100) : '0',
        barHeight: (weeklyRaces[index] / maxRaces) * 100
    }));

    return result;
}

function createAnalysisView(raceData = null) {
    if (raceData === null) {
        raceData = getFilteredRaces();
    }

    const statsDisplay = document.getElementById('stats-display');

    if (raceData.length === 0) {
        statsDisplay.innerHTML = `
            <div class="no-data-message">
                <div style="text-align: center; padding: 60px 20px; color: #718096;">
                    <h3 style="font-size: 1.5em; margin-bottom: 10px;">No race data available</h3>
                    <p>Add some races to see detailed analysis!</p>
                </div>
            </div>
        `;
        return;
    }

    const worstRacingDays = calculateWorstRacingDay(raceData);
    const bestRacingDays = calculateBestRacingDay(raceData);

    statsDisplay.innerHTML = `
        <div class="analysis-container">
            <div class="analysis-card worst-racing-card">
                <div class="analysis-title">⚠️ Worst Racing Day</div>
                <div class="analysis-description">
                    Each player's worst single day performance (minimum 2 races)
                </div>
                <div class="worst-day-list">
                    ${Object.entries(worstRacingDays).map(([player, data]) => {
                        if (!data.date || data.averagePosition === null) {
                            return `
                                <div class="worst-day-item">
                                    <span>${window.PlayerNameManager ? window.PlayerNameManager.get(player) : getPlayerName(player)}</span>
                                    <div>
                                        <div class="worst-day-score">—</div>
                                    </div>
                                </div>
                            `;
                        }
                        
                        // Parse date string directly to avoid timezone issues
                        const [year, month, day] = data.date.split('-');
                        const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 
                                          'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
                        const formattedDate = `${monthNames[parseInt(month) - 1]} ${parseInt(day)}, ${year}`;
                        
                        return `
                            <div class="worst-day-item">
                                <span>${window.PlayerNameManager ? window.PlayerNameManager.get(player) : getPlayerName(player)}</span>
                                <div>
                                    <div class="worst-day-score">Avg ${formatDecimal(data.averagePosition)}</div>
                                    <small>${formattedDate} (${data.raceCount} races)</small>
                                </div>
                            </div>
                        `;
                    }).join('')}
                </div>
            </div>

            <div class="analysis-card best-racing-card">
                <div class="analysis-title">🏆 Best Racing Day</div>
                <div class="analysis-description">
                    Each player's best single day performance (minimum 2 races)
                </div>
                <div class="best-day-list">
                    ${Object.entries(bestRacingDays).map(([player, data]) => {
                        if (!data.date || data.averagePosition === null) {
                            return `
                                <div class="best-day-item">
                                    <span>${window.PlayerNameManager ? window.PlayerNameManager.get(player) : getPlayerName(player)}</span>
                                    <div>
                                        <div class="best-day-score">—</div>
                                    </div>
                                </div>
                            `;
                        }
                        
                        // Parse date string directly to avoid timezone issues
                        const [year, month, day] = data.date.split('-');
                        const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 
                                          'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
                        const formattedDate = `${monthNames[parseInt(month) - 1]} ${parseInt(day)}, ${year}`;
                        
                        return `
                            <div class="best-day-item">
                                <span>${window.PlayerNameManager ? window.PlayerNameManager.get(player) : getPlayerName(player)}</span>
                                <div>
                                    <div class="best-day-score">Avg ${formatDecimal(data.averagePosition)}</div>
                                    <small>${formattedDate} (${data.raceCount} races)</small>
                                </div>
                            </div>
                        `;
                    }).join('')}
                </div>
            </div>

            <div class="analysis-card">
                <div class="analysis-title">📊 Global Performance Patterns</div>
                <div id="pattern-analysis">${generatePatternAnalysis(raceData)}</div>
            </div>
        </div>
    `;
    
    // Update player icons in Analysis section after rendering
    if (window.updateAllPlayerIcons) {
        setTimeout(() => {
            window.updateAllPlayerIcons();
        }, 100);
    }
}

function calculateComebackAnalysis(raceData) {
    const analysis = {};

    players.forEach(player => {
        const playerRaces = raceData.filter(race => race[player] !== null)
            .sort((a, b) => {
                const dateA = new Date(a.date + (a.timestamp ? ' ' + a.timestamp : ''));
                const dateB = new Date(b.date + (b.timestamp ? ' ' + b.timestamp : ''));
                return dateA - dateB;
            });

        let comebacks = 0;
        let badPositions = 0;

        for (let i = 1; i < playerRaces.length; i++) {
            const prevPosition = playerRaces[i-1][player];
            const currentPosition = playerRaces[i][player];

            if (prevPosition >= (window.getGoodFinishThreshold ? window.getGoodFinishThreshold() + 1 : 13)) {
                badPositions++;
                if (currentPosition <= 5) {
                    comebacks++;
                }
            }
        }

        analysis[player] = {
            comebacks,
            recoveryRate: badPositions > 0 ? (comebacks / badPositions) * 100 : 0
        };
    });

    return analysis;
}

function calculateBestRacingDay(raceData) {
    const bestDays = {};

    players.forEach(player => {
        // Group races by date for this player
        const racesByDate = {};
        raceData
            .filter(race => race[player] !== null)
            .forEach(race => {
                if (!racesByDate[race.date]) {
                    racesByDate[race.date] = [];
                }
                racesByDate[race.date].push(race[player]);
            });

        let bestDate = null;
        let bestScore = Infinity;
        let bestRaceCount = 0;

        // Find the day with the best average position (only days with 2+ races)
        Object.entries(racesByDate).forEach(([date, positions]) => {
            if (positions.length >= 2) {
                const averagePosition = positions.reduce((sum, pos) => sum + pos, 0) / positions.length;
                if (averagePosition < bestScore) {
                    bestScore = averagePosition;
                    bestDate = date;
                    bestRaceCount = positions.length;
                }
            }
        });

        bestDays[player] = {
            date: bestDate,
            averagePosition: bestScore === Infinity ? null : bestScore,
            raceCount: bestRaceCount
        };
    });

    return bestDays;
}

function calculateWorstRacingDay(raceData) {
    const worstDays = {};

    players.forEach(player => {
        // Group races by date for this player
        const racesByDate = {};
        raceData
            .filter(race => race[player] !== null)
            .forEach(race => {
                if (!racesByDate[race.date]) {
                    racesByDate[race.date] = [];
                }
                racesByDate[race.date].push(race[player]);
            });

        let worstDate = null;
        let worstScore = 0;
        let worstRaceCount = 0;

        // Find the day with the worst average position (only days with 2+ races)
        Object.entries(racesByDate).forEach(([date, positions]) => {
            if (positions.length >= 2) {
                const averagePosition = positions.reduce((sum, pos) => sum + pos, 0) / positions.length;
                if (averagePosition > worstScore) {
                    worstScore = averagePosition;
                    worstDate = date;
                    worstRaceCount = positions.length;
                }
            }
        });

        worstDays[player] = {
            date: worstDate,
            averagePosition: worstScore === 0 ? null : worstScore,
            raceCount: worstRaceCount
        };
    });

    return worstDays;
}

function generatePatternAnalysis(raceData) {
    let analysis = '<ul>';

    // Analyze best specific date
    const datePerformance = {};
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

    raceData.forEach(race => {
        if (!datePerformance[race.date]) {
            datePerformance[race.date] = { races: 0, totalPos: 0 };
        }

        players.forEach(player => {
            if (race[player] !== null) {
                datePerformance[race.date].races++;
                datePerformance[race.date].totalPos += race[player];
            }
        });
    });

    let bestDate = null;
    let bestAvg = 25;
    let bestDayName = null;

    Object.entries(datePerformance).forEach(([date, data]) => {
        if (data.races > 0) {
            const avg = data.totalPos / data.races;
            // If same average, prefer the latest date
            if (avg < bestAvg || (avg === bestAvg && date > bestDate)) {
                bestAvg = avg;
                bestDate = date;
                const dayOfWeek = new Date(date).getDay();
                bestDayName = dayNames[dayOfWeek];
            }
        }
    });

    if (bestDate) {
        analysis += `<li>🌟 Best racing day: <strong>${bestDate}</strong> (avg position ${formatDecimal(bestAvg)})</li>`;
    }

    // Collective Worst Day
    let worstDate = null;
    let worstAvg = 0;
    let worstDayName = null;

    Object.entries(datePerformance).forEach(([date, data]) => {
        if (data.races > 0) {
            const avg = data.totalPos / data.races;
            if (avg > worstAvg) {
                worstAvg = avg;
                worstDate = date;
                const dayOfWeek = new Date(date).getDay();
                worstDayName = dayNames[dayOfWeek];
            }
        }
    });

    if (worstDate) {
        analysis += `<li>📉 Worst racing day: <strong>${worstDate}</strong> (avg position ${formatDecimal(worstAvg)})</li>`;
    }

    // Average Finish Spread
    const spreadData = raceData.map(race => {
        const positions = players.map(player => race[player]).filter(p => p !== null);
        if (positions.length < 2) return null;
        return Math.max(...positions) - Math.min(...positions);
    }).filter(spread => spread !== null);

    if (spreadData.length > 0) {
        const avgSpread = spreadData.reduce((sum, spread) => sum + spread, 0) / spreadData.length;
        analysis += `<li>📊 Average finish spread: <strong>${formatDecimal(avgSpread)} positions</strong></li>`;
    }

    // Most competitive races (only show for multiple players)
    if (playerCount > 1) {
        const competitiveRaces = raceData.filter(race => {
            const positions = players.map(player => race[player]).filter(p => p !== null);
            if (positions.length < 2) return false;
            const range = Math.max(...positions) - Math.min(...positions);
            return range <= 5; // Close races
        });

        analysis += `<li>🤏 Close races: <strong>${formatDecimal((competitiveRaces.length / raceData.length) * 100)}%</strong> - races where position spread ≤ 5 places</li>`;
    }

    // Sweet Spot Frequency
    const allPositions = [];
    raceData.forEach(race => {
        players.forEach(player => {
            if (race[player] !== null) {
                allPositions.push(race[player]);
            }
        });
    });

    if (allPositions.length > 0) {
        allPositions.sort((a, b) => a - b);
        const minPos = Math.min(...allPositions);
        const maxPos = Math.max(...allPositions);
        
        // Find the most common range (group positions into ranges of 4)
        const ranges = [];
        for (let start = 1; start <= window.MAX_POSITIONS; start += 4) {
            const end = Math.min(start + 3, window.MAX_POSITIONS);
            const count = allPositions.filter(pos => pos >= start && pos <= end).length;
            if (count > 0) {
                ranges.push({
                    start,
                    end,
                    count,
                    percentage: (count / allPositions.length) * 100
                });
            }
        }
        
        if (ranges.length > 0) {
            const mostFrequentRange = ranges.reduce((max, current) => 
                current.count > max.count ? current : max
            );
            
            const rangeText = mostFrequentRange.start === mostFrequentRange.end ? 
                `position ${mostFrequentRange.start}` : 
                `positions ${mostFrequentRange.start}-${mostFrequentRange.end}`;
                
            analysis += `<li>🎯 Sweet spot frequency: <strong>${formatDecimal(mostFrequentRange.percentage)}%</strong> of finishes in ${rangeText}</li>`;
        }
    }

    analysis += '</ul>';
    return analysis;
}
