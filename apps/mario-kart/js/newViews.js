// New views: Tracks, Championship, Rivalry Callouts, First-Time Milestones, Session Recap, Activity Calendar performance

// ── Feature 1: Tracks View ──────────────────────────────────────────────────

function createTracksView(raceData) {
    if (raceData === null) raceData = getFilteredRaces();
    const statsDisplay = document.getElementById('stats-display');

    if (raceData.length === 0) {
        statsDisplay.innerHTML = `<div class="no-data-message"><div style="text-align:center;padding:60px 20px;color:#718096;"><h3 style="font-size:1.5em;margin-bottom:10px;">No race data available</h3><p>Add some races to see track stats!</p></div></div>`;
        return;
    }

    const MIN_RACES_FOR_STATS = 3;
    const gameVer = window.getCurrentGameVersion ? window.getCurrentGameVersion() : 'mk8d';
    const trackMap = window.getTracksForVersion ? window.getTracksForVersion(gameVer) : {};

    // Build per-track stats
    const trackStats = {};
    raceData.forEach(race => {
        if (!race.track) return;
        const t = race.track;
        if (!trackStats[t]) {
            trackStats[t] = { races: 0, playerData: {} };
            players.forEach(p => { trackStats[t].playerData[p] = { totalPos: 0, wins: 0, count: 0 }; });
        }
        trackStats[t].races++;
        players.forEach(p => {
            if (race[p] !== null && race[p] !== undefined) {
                trackStats[t].playerData[p].totalPos += race[p];
                trackStats[t].playerData[p].count++;
                if (race[p] === 1) trackStats[t].playerData[p].wins++;
            }
        });
    });

    const qualifiedTracks = Object.entries(trackStats).filter(([, v]) => v.races >= MIN_RACES_FOR_STATS);
    qualifiedTracks.sort((a, b) => b[1].races - a[1].races);

    // Per-player best/worst 3 tracks (by avg finish, min MIN_RACES_FOR_STATS)
    function playerTopTracks(playerKey, best) {
        const eligible = qualifiedTracks
            .map(([name, s]) => {
                const pd = s.playerData[playerKey];
                if (pd.count < MIN_RACES_FOR_STATS) return null;
                return { name, avg: pd.totalPos / pd.count, races: pd.count };
            })
            .filter(Boolean);
        eligible.sort((a, b) => best ? a.avg - b.avg : b.avg - a.avg);
        return eligible.slice(0, 3);
    }

    const noData = qualifiedTracks.length === 0;

    let html = `<div class="tracks-view">`;

    if (noData) {
        html += `<div style="text-align:center;padding:40px;color:#718096;">
            <p>No tracks with ${MIN_RACES_FOR_STATS}+ races yet. Add track info when logging races.</p>
        </div>`;
    } else {
        // Win-rate table
        html += `<div class="stat-card" style="margin-bottom:1.5rem;">
            <div class="stat-title">Track Stats (${MIN_RACES_FOR_STATS}+ races)</div>
            <div style="overflow-x:auto;">
            <table class="tracks-table" style="width:100%;border-collapse:collapse;font-size:0.85em;">
                <thead>
                    <tr>
                        <th style="text-align:left;padding:8px 12px;">Track</th>
                        <th style="padding:8px;">Races</th>
                        ${players.map(p => {
                            const name = window.PlayerNameManager ? window.PlayerNameManager.get(p) : p;
                            return `<th style="padding:8px;">${escapeHtml(name)} Avg</th><th style="padding:8px;">Win%</th>`;
                        }).join('')}
                    </tr>
                </thead>
                <tbody>
                    ${qualifiedTracks.map(([name, s]) => {
                        const cells = players.map(p => {
                            const pd = s.playerData[p];
                            if (pd.count === 0) return `<td style="padding:8px;text-align:center;color:#718096">—</td><td style="padding:8px;text-align:center;color:#718096">—</td>`;
                            const avg = (pd.totalPos / pd.count).toFixed(1);
                            const winPct = ((pd.wins / pd.count) * 100).toFixed(0);
                            return `<td style="padding:8px;text-align:center;">${avg}</td><td style="padding:8px;text-align:center;">${winPct}%</td>`;
                        }).join('');
                        return `<tr style="border-top:1px solid var(--border-color)">
                            <td style="padding:8px 12px;font-weight:500;">${escapeHtml(name)}</td>
                            <td style="padding:8px;text-align:center;">${s.races}</td>
                            ${cells}
                        </tr>`;
                    }).join('')}
                </tbody>
            </table>
            </div>
        </div>`;

        // Best/worst per player
        html += `<div class="tracks-highlights" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:1rem;">`;
        players.forEach(p => {
            const name = window.PlayerNameManager ? window.PlayerNameManager.get(p) : p;
            const best = playerTopTracks(p, true);
            const worst = playerTopTracks(p, false);
            html += `<div class="stat-card">
                <div class="stat-title">${escapeHtml(name)}</div>
                <div style="font-size:0.85em;">
                    <div style="color:#10b981;font-weight:600;margin-bottom:4px;">Best Tracks</div>
                    ${best.length ? best.map(t => `<div style="padding:3px 0;">${escapeHtml(t.name)} — avg ${t.avg.toFixed(1)} (${t.races} races)</div>`).join('') : '<div style="color:#718096">Not enough data</div>'}
                    <div style="color:#ef4444;font-weight:600;margin:8px 0 4px;">Worst Tracks</div>
                    ${worst.length ? worst.map(t => `<div style="padding:3px 0;">${escapeHtml(t.name)} — avg ${t.avg.toFixed(1)} (${t.races} races)</div>`).join('') : '<div style="color:#718096">Not enough data</div>'}
                </div>
            </div>`;
        });
        html += `</div>`;
    }

    html += `</div>`;
    statsDisplay.innerHTML = html;
}


// ── Feature 6: Championship View ────────────────────────────────────────────

function createChampionshipView(raceData) {
    if (raceData === null) raceData = getFilteredRaces();
    const statsDisplay = document.getElementById('stats-display');

    if (raceData.length === 0) {
        statsDisplay.innerHTML = `<div class="no-data-message"><div style="text-align:center;padding:60px 20px;color:#718096;"><h3 style="font-size:1.5em;margin-bottom:10px;">No race data available</h3><p>Add some races to see championship standings!</p></div></div>`;
        return;
    }

    const gameVer = window.getCurrentGameVersion ? window.getCurrentGameVersion() : 'mk8d';

    const standings = players.map(p => {
        let totalPoints = 0;
        let polePoints = 0;
        let wins = 0;
        let racesPlayed = 0;

        raceData.forEach(race => {
            if (race[p] === null || race[p] === undefined) return;
            racesPlayed++;
            const pts = window.getPointsForPosition ? window.getPointsForPosition(race[p], gameVer) : 0;
            totalPoints += pts;
            if (race[p] === 1) { wins++; polePoints += pts; }
        });

        const ppr = racesPlayed > 0 ? totalPoints / racesPlayed : 0;
        const winRate = racesPlayed > 0 ? ((wins / racesPlayed) * 100).toFixed(1) : '0.0';

        return {
            player: p,
            name: window.PlayerNameManager ? window.PlayerNameManager.get(p) : p,
            totalPoints,
            polePoints,
            wins,
            racesPlayed,
            ppr,
            winRate
        };
    });

    // Sort: total points desc, tiebreaker ppr desc
    standings.sort((a, b) => b.totalPoints !== a.totalPoints ? b.totalPoints - a.totalPoints : b.ppr - a.ppr);

    const rows = standings.map((s, i) => {
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
        const rowClass = i === 0 ? 'champ-row-first' : i === standings.length - 1 ? 'champ-row-last' : '';
        return `<tr class="${rowClass}">
            <td style="padding:10px 12px;font-size:1.2em;">${medal}</td>
            <td style="padding:10px 12px;font-weight:600;">${escapeHtml(s.name)}</td>
            <td style="padding:10px 12px;text-align:center;font-weight:700;font-size:1.1em;">${s.totalPoints}</td>
            <td style="padding:10px 12px;text-align:center;">${s.polePoints}</td>
            <td style="padding:10px 12px;text-align:center;">${s.winRate}%</td>
            <td style="padding:10px 12px;text-align:center;">${s.racesPlayed > 0 ? s.ppr.toFixed(1) : '—'}</td>
        </tr>`;
    }).join('');

    const pointsNote = gameVer === 'mkworld'
        ? 'Points: 30-27-24-21-18-16-14-12-10-9-8-7-6-5-4-3-2-1 (MK World)'
        : 'Points: 15-12-10-8-7-6-5-4-3-2-1-0 (MK8DX)';

    statsDisplay.innerHTML = `
        <div class="championship-view">
            <div class="stat-card">
                <div class="stat-title">Championship Standings</div>
                <div style="overflow-x:auto;">
                <table style="width:100%;border-collapse:collapse;">
                    <thead>
                        <tr style="border-bottom:2px solid var(--border-color);color:var(--text-secondary);font-size:0.85em;">
                            <th style="padding:8px 12px;text-align:left;">Pos</th>
                            <th style="padding:8px 12px;text-align:left;">Player</th>
                            <th style="padding:8px 12px;text-align:center;">Points</th>
                            <th style="padding:8px 12px;text-align:center;">From 1sts</th>
                            <th style="padding:8px 12px;text-align:center;">Win Rate</th>
                            <th style="padding:8px 12px;text-align:center;">Pts/Race</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rows}
                    </tbody>
                </table>
                </div>
                <div style="margin-top:0.75rem;font-size:0.78em;color:var(--text-tertiary);">${pointsNote}</div>
            </div>
        </div>`;
}


// ── Feature 4: Rivalry Callout Stories ─────────────────────────────────────

function generateRivalryCallouts(stats) {
    if (players.length < 2) return '';

    const MIN_RACES = 5;
    const lines = [];

    for (let i = 0; i < players.length; i++) {
        for (let j = i + 1; j < players.length; j++) {
            const p1 = players[i];
            const p2 = players[j];
            const n1 = window.PlayerNameManager ? window.PlayerNameManager.get(p1) : p1;
            const n2 = window.PlayerNameManager ? window.PlayerNameManager.get(p2) : p2;

            const wins1 = stats.h2h[p1][p2] || 0;
            const wins2 = stats.h2h[p2][p1] || 0;
            const total = wins1 + wins2;

            if (total < MIN_RACES) {
                lines.push(`<div class="rivalry-callout rivalry-neutral">${escapeHtml(n1)} vs ${escapeHtml(n2)}: need ${MIN_RACES - total} more races for rivalry stories.</div>`);
                continue;
            }

            // Pick the most interesting story
            const curr1 = stats.h2hCurrentStreaks[p1][p2] || 0;
            const curr2 = stats.h2hCurrentStreaks[p2][p1] || 0;
            const long1 = stats.h2hLongestStreaks[p1][p2] || 0;
            const long2 = stats.h2hLongestStreaks[p2][p1] || 0;
            const big1 = stats.h2hBiggestWins[p1][p2];
            const big2 = stats.h2hBiggestWins[p2][p1];

            let line = '';

            // Active losing streak story
            if (curr2 >= 4) {
                const isWorst = curr2 >= long2;
                line = `<span class="rivalry-name">${escapeHtml(n1)}</span> is on a <strong>${curr2}-race losing streak</strong> to ${escapeHtml(n2)}${isWorst ? ' (personal worst)' : ''}.`;
            } else if (curr1 >= 4) {
                const isWorst = curr1 >= long1;
                line = `<span class="rivalry-name">${escapeHtml(n2)}</span> is on a <strong>${curr1}-race losing streak</strong> to ${escapeHtml(n1)}${isWorst ? ' (personal worst)' : ''}.`;
            } else if (wins1 === wins2) {
                line = `Dead even: <strong>${wins1}-${wins2}</strong> all time between ${escapeHtml(n1)} and ${escapeHtml(n2)}.`;
            } else {
                const leader = wins1 > wins2 ? n1 : n2;
                const trailer = wins1 > wins2 ? n2 : n1;
                const leadWins = Math.max(wins1, wins2);
                const trailWins = Math.min(wins1, wins2);
                line = `<span class="rivalry-name">${escapeHtml(leader)}</span> leads <strong>${leadWins}-${trailWins}</strong> over ${escapeHtml(trailer)} all time.`;
            }

            lines.push(`<div class="rivalry-callout">${line}</div>`);
        }
    }

    if (lines.length === 0) return '';

    return `<div class="rivalry-callouts">
        <div class="stat-title" style="margin-bottom:0.75rem;">Rivalry Stories</div>
        ${lines.join('')}
    </div>`;
}


// ── Feature 7: First-Time Milestones ────────────────────────────────────────

function calculateFirstTimeMilestones(raceData) {
    const milestones = {};

    players.forEach(p => {
        const name = window.PlayerNameManager ? window.PlayerNameManager.get(p) : p;
        const pMilestones = [];

        const chronological = [...raceData]
            .filter(r => r[p] !== null && r[p] !== undefined)
            .sort((a, b) => {
                const da = new Date(a.date + (a.timestamp ? ' ' + a.timestamp : ''));
                const db = new Date(b.date + (b.timestamp ? ' ' + b.timestamp : ''));
                return da - db;
            });

        if (chronological.length === 0) {
            milestones[p] = pMilestones;
            return;
        }

        // First Win
        const firstWinRace = chronological.find(r => r[p] === 1);
        if (firstWinRace) {
            const idx = raceData.indexOf(firstWinRace);
            pMilestones.push({ label: 'First Win', date: firstWinRace.date, raceNum: idx + 1 });
        }

        // First Podium
        const firstPodium = chronological.find(r => r[p] <= 3);
        if (firstPodium) {
            const idx = raceData.indexOf(firstPodium);
            pMilestones.push({ label: 'First Podium', date: firstPodium.date, raceNum: idx + 1 });
        }

        // Best Ever Position
        const best = Math.min(...chronological.map(r => r[p]));
        const bestRace = chronological.find(r => r[p] === best);
        if (bestRace) {
            const idx = raceData.indexOf(bestRace);
            pMilestones.push({ label: `Best Finish (P${best})`, date: bestRace.date, raceNum: idx + 1 });
        }

        // First Perfect Day (2+ races, all top-half)
        const threshold = window.getGoodFinishThreshold ? window.getGoodFinishThreshold() : 6;
        const dayGroups = {};
        chronological.forEach(r => {
            if (!dayGroups[r.date]) dayGroups[r.date] = [];
            dayGroups[r.date].push(r);
        });
        let firstPerfectDay = null;
        const dates = Object.keys(dayGroups).sort();
        for (const d of dates) {
            const dayRaces = dayGroups[d];
            if (dayRaces.length >= 2 && dayRaces.every(r => r[p] <= threshold)) {
                firstPerfectDay = { date: d, races: dayRaces };
                break;
            }
        }
        if (firstPerfectDay) {
            pMilestones.push({ label: 'First Perfect Day', date: firstPerfectDay.date, raceNum: null });
        }

        // First Win vs each opponent
        players.forEach(opp => {
            if (opp === p) return;
            const oppName = window.PlayerNameManager ? window.PlayerNameManager.get(opp) : opp;
            const firstWinVs = chronological.find(r => r[p] !== null && r[opp] !== null && r[p] < r[opp]);
            if (firstWinVs) {
                const idx = raceData.indexOf(firstWinVs);
                pMilestones.push({ label: `First Win vs ${oppName}`, date: firstWinVs.date, raceNum: idx + 1 });
            }
        });

        milestones[p] = pMilestones;
    });

    return milestones;
}

function renderFirstTimeMilestones(raceData) {
    const milestones = calculateFirstTimeMilestones(raceData);

    const sections = players.map(p => {
        const name = window.PlayerNameManager ? window.PlayerNameManager.get(p) : p;
        const ms = milestones[p] || [];

        if (ms.length === 0) {
            return `<div class="stat-card milestone-card">
                <div class="stat-title">${escapeHtml(name)}</div>
                <div style="color:var(--text-tertiary);font-size:0.9em;">No data yet.</div>
            </div>`;
        }

        const rows = ms.map(m => {
            const raceRef = m.raceNum !== null ? ` · Race #${m.raceNum}` : '';
            return `<div class="milestone-row">
                <span class="milestone-label">${escapeHtml(m.label)}</span>
                <span class="milestone-date">${m.date}${raceRef}</span>
            </div>`;
        }).join('');

        return `<div class="stat-card milestone-card">
            <div class="stat-title">${escapeHtml(name)}</div>
            ${rows}
        </div>`;
    }).join('');

    return `<div class="milestones-section">
        <div class="stat-title" style="margin-bottom:1rem;">First-Time Milestones</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:1rem;">
            ${sections}
        </div>
    </div>`;
}


// ── Feature 8: Podium % Stat Card ──────────────────────────────────────────
// This is surfaced inside the stats view — call from updateDisplay for stats

function renderPodiumPercentCard(stats) {
    const podiumPcts = players.map(p => {
        const played = stats.racesPlayed[p];
        return played > 0 ? (stats.podiumFinish[p] / played) * 100 : '-';
    });

    const rows = players.map((p, i) => {
        const played = stats.racesPlayed[p];
        const val = podiumPcts[i];
        const cls = getStatClass(val, podiumPcts, true);
        const display = val === '-' ? '—' : val.toFixed(1) + '%';
        const name = window.PlayerNameManager ? window.PlayerNameManager.get(p) : p;
        return `<div class="stat-item ${cls}">
            <div class="player-name">${escapeHtml(name)}</div>
            <div class="player-value">${display}</div>
            ${played > 0 ? `<div class="stat-count">${stats.podiumFinish[p]}</div>` : ''}
        </div>`;
    }).join('');

    return `<div class="stat-card">
        <div class="stat-title">Podium % (Top 3)</div>
        <div class="stat-grid">${rows}</div>
    </div>`;
}


// ── Feature 9: Activity Calendar — Performance Coloring ────────────────────

function createActivityCalendarWithPerformance(raceData, viewingPlayer) {
    if (!raceData || raceData.length === 0) return '<div style="text-align:center;padding:40px;color:#718096;">No race data available.</div>';

    const threshold = window.getGoodFinishThreshold ? window.getGoodFinishThreshold() : 6;

    // Build a date → stats map
    const dateMap = {};
    raceData.forEach(race => {
        const d = race.date;
        if (!dateMap[d]) dateMap[d] = {};
        players.forEach(p => {
            if (race[p] !== null && race[p] !== undefined) {
                if (!dateMap[d][p]) dateMap[d][p] = { total: 0, count: 0 };
                dateMap[d][p].total += race[p];
                dateMap[d][p].count++;
            }
        });
    });

    const allDates = Object.keys(dateMap).sort();
    if (allDates.length === 0) return '<div style="text-align:center;padding:40px;color:#718096;">No race data available.</div>';

    const firstDate = new Date(allDates[0] + 'T00:00:00');
    const lastDate = new Date(allDates[allDates.length - 1] + 'T00:00:00');

    // Group by year-month
    const months = {};
    allDates.forEach(d => {
        const [y, m] = d.split('-');
        const key = `${y}-${m}`;
        if (!months[key]) months[key] = [];
        months[key].push(d);
    });

    const vp = viewingPlayer || players[0];
    const vpName = window.PlayerNameManager ? window.PlayerNameManager.get(vp) : vp;

    const playerSelector = players.map(p => {
        const n = window.PlayerNameManager ? window.PlayerNameManager.get(p) : p;
        return `<option value="${p}"${p === vp ? ' selected' : ''}>${escapeHtml(n)}</option>`;
    }).join('');

    let calHtml = `<div class="activity-calendar-perf">
        <div style="display:flex;align-items:center;gap:0.75rem;margin-bottom:1rem;flex-wrap:wrap;">
            <label style="font-weight:600;">Viewing:</label>
            <select id="activity-player-select" class="activity-player-select"
                onchange="refreshActivityCalendar(this.value)">
                ${playerSelector}
            </select>
            <div class="cal-legend" style="display:flex;gap:0.5rem;align-items:center;font-size:0.82em;">
                <span class="cal-dot cal-green"></span> Top-half avg
                <span class="cal-dot cal-red"></span> Bottom-half avg
                <span class="cal-dot cal-gray"></span> Didn't play
            </div>
        </div>`;

    Object.keys(months).sort().forEach(monthKey => {
        const [y, m] = monthKey.split('-');
        const monthName = new Date(parseInt(y), parseInt(m) - 1, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });
        calHtml += `<div class="cal-month-block"><div class="cal-month-label">${monthName}</div><div class="cal-days-grid">`;

        months[monthKey].forEach(d => {
            const dayData = dateMap[d];
            const pd = dayData[vp];
            let dotClass = 'cal-gray';
            let tooltipParts = [d];
            let raceCount = 0;

            // Count all players' races that day
            players.forEach(p => {
                if (dayData[p]) {
                    const avg = (dayData[p].total / dayData[p].count).toFixed(1);
                    const pName = window.PlayerNameManager ? window.PlayerNameManager.get(p) : p;
                    tooltipParts.push(`${pName}: avg ${avg} (${dayData[p].count} race${dayData[p].count > 1 ? 's' : ''})`);
                    if (p === vp) raceCount = dayData[p].count;
                }
            });

            if (pd) {
                const avg = pd.total / pd.count;
                dotClass = avg <= threshold ? 'cal-green' : 'cal-red';
            }

            const tooltip = tooltipParts.join('\n');
            calHtml += `<div class="cal-day-dot ${dotClass}" title="${tooltip}" data-date="${d}" data-count="${raceCount}">
                <span class="cal-day-num">${parseInt(d.split('-')[2])}</span>
            </div>`;
        });

        calHtml += `</div></div>`;
    });

    calHtml += `</div>`;
    return calHtml;
}

function refreshActivityCalendar(playerKey) {
    const raceData = getFilteredRaces();
    const calContainer = document.getElementById('activity-cal-perf-container');
    if (calContainer) {
        calContainer.innerHTML = createActivityCalendarWithPerformance(raceData, playerKey);
    }
}
window.refreshActivityCalendar = refreshActivityCalendar;


// ── Feature 3: Session Recap Share Card ────────────────────────────────────

function createSessionRecap() {
    const today = new Date().toLocaleDateString('en-CA');
    const todayRaces = races.filter(r => r.date === today);

    if (todayRaces.length < 4) {
        showMessage('Session recap appears after 4+ races today.', false);
        return;
    }

    // Calculate session stats
    const sessionStats = {};
    players.forEach(p => {
        const pRaces = todayRaces.filter(r => r[p] !== null && r[p] !== undefined);
        if (pRaces.length === 0) return;
        const total = pRaces.reduce((s, r) => s + r[p], 0);
        sessionStats[p] = {
            name: window.PlayerNameManager ? window.PlayerNameManager.get(p) : p,
            races: pRaces.length,
            avg: total / pRaces.length,
            wins: pRaces.filter(r => r[p] === 1).length
        };
    });

    const entries = Object.entries(sessionStats).filter(([, s]) => s.races > 0);
    entries.sort((a, b) => a[1].avg - b[1].avg);

    const sessionWinner = entries[0];
    const sessionLoser = entries[entries.length - 1];

    // Achievements unlocked today
    const allAchievements = {};
    const todayAchievements = [];
    players.forEach(p => {
        allAchievements[p] = calculateAchievements(p, todayRaces);
        const level = Object.entries(allAchievements[p]).filter(([, a]) => a.level > 0);
        if (level.length > 0) {
            const name = window.PlayerNameManager ? window.PlayerNameManager.get(p) : p;
            level.forEach(([key, a]) => {
                todayAchievements.push(`${name}: ${ACHIEVEMENTS[key]?.name || key} (lvl ${a.level})`);
            });
        }
    });

    // Build card HTML
    const cardHtml = `
        <div id="session-recap-card" style="
            width:600px;max-width:100%;
            background:#1a1a2e;color:#e2e8f0;
            border-radius:16px;padding:28px 32px;
            font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;
            box-shadow:0 8px 32px rgba(0,0,0,0.4);
            position:relative;
        ">
            <div style="text-align:center;margin-bottom:20px;">
                <div style="font-size:2em;margin-bottom:4px;">🏁</div>
                <div style="font-size:1.3em;font-weight:700;color:#a78bfa;">Tonight's Session</div>
                <div style="font-size:0.9em;color:#718096;">${today} · ${todayRaces.length} races</div>
            </div>

            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:20px;">
                ${sessionWinner ? `<div style="background:#0d2d1a;border-radius:10px;padding:14px;text-align:center;">
                    <div style="font-size:0.75em;color:#10b981;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Session Winner</div>
                    <div style="font-size:1.2em;font-weight:700;">${escapeHtml(sessionWinner[1].name)}</div>
                    <div style="font-size:0.9em;color:#a0aec0;">Avg ${sessionWinner[1].avg.toFixed(1)} · ${sessionWinner[1].wins}W</div>
                </div>` : ''}
                ${sessionLoser && sessionLoser[0] !== (sessionWinner ? sessionWinner[0] : '') ? `<div style="background:#2d0d0d;border-radius:10px;padding:14px;text-align:center;">
                    <div style="font-size:0.75em;color:#ef4444;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Session Loser</div>
                    <div style="font-size:1.2em;font-weight:700;">${escapeHtml(sessionLoser[1].name)}</div>
                    <div style="font-size:0.9em;color:#a0aec0;">Avg ${sessionLoser[1].avg.toFixed(1)} · ${sessionLoser[1].wins}W</div>
                </div>` : ''}
            </div>

            <div style="background:#16213e;border-radius:10px;padding:14px;margin-bottom:16px;">
                <div style="font-size:0.75em;color:#94a3b8;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px;">Player Summary</div>
                ${entries.map(([, s]) => `
                    <div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.05);">
                        <span style="font-weight:600;">${escapeHtml(s.name)}</span>
                        <span style="color:#a0aec0;font-size:0.9em;">avg ${s.avg.toFixed(1)} · ${s.wins} win${s.wins !== 1 ? 's' : ''} / ${s.races} races</span>
                    </div>`).join('')}
            </div>

            ${todayAchievements.length > 0 ? `<div style="background:#16213e;border-radius:10px;padding:14px;margin-bottom:16px;">
                <div style="font-size:0.75em;color:#94a3b8;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">Achievements Today</div>
                ${todayAchievements.map(a => `<div style="padding:3px 0;font-size:0.9em;">🏆 ${escapeHtml(a)}</div>`).join('')}
            </div>` : ''}

            <div style="text-align:center;font-size:0.75em;color:#4a5568;margin-top:8px;">shevato.com/apps/mario-kart</div>
        </div>
    `;

    // Show in a modal
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);display:flex;justify-content:center;align-items:center;z-index:2000;padding:20px;box-sizing:border-box;';

    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'max-height:90vh;overflow-y:auto;';
    wrapper.innerHTML = cardHtml;

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:0.75rem;justify-content:center;margin-top:1rem;';
    btnRow.innerHTML = `
        <button id="copy-recap-text-btn" style="padding:10px 20px;background:#667eea;color:#fff;border:none;border-radius:8px;cursor:pointer;font-weight:600;" onclick="copySessionRecapText()">Copy as Text</button>
        <button style="padding:10px 20px;background:#4a5568;color:#fff;border:none;border-radius:8px;cursor:pointer;font-weight:600;" onclick="this.closest('[style*=fixed]').remove()">Close</button>
    `;
    wrapper.appendChild(btnRow);
    overlay.appendChild(wrapper);
    document.body.appendChild(overlay);

    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.remove();
    });
}

function copySessionRecapText() {
    const today = new Date().toLocaleDateString('en-CA');
    const todayRaces = races.filter(r => r.date === today);
    const sessionStats = {};
    players.forEach(p => {
        const pRaces = todayRaces.filter(r => r[p] !== null && r[p] !== undefined);
        if (pRaces.length === 0) return;
        const total = pRaces.reduce((s, r) => s + r[p], 0);
        sessionStats[p] = {
            name: window.PlayerNameManager ? window.PlayerNameManager.get(p) : p,
            races: pRaces.length,
            avg: total / pRaces.length,
            wins: pRaces.filter(r => r[p] === 1).length
        };
    });
    const entries = Object.entries(sessionStats).filter(([, s]) => s.races > 0);
    entries.sort((a, b) => a[1].avg - b[1].avg);

    let text = `Tonight's Session — ${today} (${todayRaces.length} races)\n\n`;
    entries.forEach(([, s]) => {
        text += `${s.name}: avg ${s.avg.toFixed(1)}, ${s.wins} win${s.wins !== 1 ? 's' : ''}, ${s.races} races\n`;
    });
    text += `\nshevato.com/apps/mario-kart`;

    if (navigator.clipboard) {
        navigator.clipboard.writeText(text).then(() => showMessage('Session recap copied!')).catch(() => {});
    } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        showMessage('Session recap copied!');
    }
}

window.createSessionRecap = createSessionRecap;
window.copySessionRecapText = copySessionRecapText;
window.createTracksView = createTracksView;
window.createChampionshipView = createChampionshipView;
window.generateRivalryCallouts = generateRivalryCallouts;
window.renderFirstTimeMilestones = renderFirstTimeMilestones;
window.renderPodiumPercentCard = renderPodiumPercentCard;
window.createActivityCalendarWithPerformance = createActivityCalendarWithPerformance;
