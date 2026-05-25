// Football H2H — supplemental features
// Loaded after football-h2h.js, playerStats.js, and match-logic.js.

// ── Feature 2: Rivalry headline ───────────────────────────────────────────

function computeRivalryHeadline(allGames) {
    if (!allGames || allGames.length === 0) return null;

    const api = window.FootballPlayerStats;
    if (!api) return null;

    const sorted = allGames.slice().sort((a, b) => {
        const ta = new Date(a.dateTime || 0).getTime();
        const tb = new Date(b.dateTime || 0).getTime();
        return ta - tb;
    });

    const p1 = window.player1Name || 'Player 1';
    const p2 = window.player2Name || 'Player 2';

    // Count wins for lead-change detection
    let p1Wins = 0, p2Wins = 0;
    let leadChanges = [];
    let prevLeader = null;

    for (let i = 0; i < sorted.length; i++) {
        const g = sorted[i];
        if (g.player1Goals > g.player2Goals) p1Wins++;
        else if (g.player2Goals > g.player1Goals) p2Wins++;
        else if (g.penaltyWinner === 1) p1Wins++;
        else if (g.penaltyWinner === 2) p2Wins++;

        const leader = p1Wins > p2Wins ? 'p1' : p2Wins > p1Wins ? 'p2' : null;
        if (leader && leader !== prevLeader) {
            leadChanges.push({ gameIndex: i, leader });
            prevLeader = leader;
        }
    }

    // Trigger 1: lead change on the very last game
    if (leadChanges.length > 0) {
        const last = leadChanges[leadChanges.length - 1];
        if (last.gameIndex === sorted.length - 1) {
            const name = last.leader === 'p1' ? p1 : p2;
            if (leadChanges.length === 1) {
                return `${name} leads the series for the first time`;
            }
            return `${name} takes the lead — momentum has shifted`;
        }
    }

    // Trigger 2: record-breaking win streak after most recent game
    const isWin = r => r === 'W';
    const p1Run = api.longestMatchRun(sorted, 'player1Goals', 'player2Goals', 1, isWin);
    const p2Run = api.longestMatchRun(sorted, 'player2Goals', 'player1Goals', 2, isWin);

    // Check if the current streak equals the all-time record and is at least 3
    const p1Results = api.matchResultsInOrder(sorted, 'player1Goals', 'player2Goals', 1);
    const p2Results = api.matchResultsInOrder(sorted, 'player2Goals', 'player1Goals', 2);
    const p1Streaks = api.computeMatchStreaks(p1Results);
    const p2Streaks = api.computeMatchStreaks(p2Results);

    if (p1Streaks.currentWinningStreak >= 3 && p1Streaks.currentWinningStreak >= p1Run.length) {
        return `${p1}'s longest win streak of your rivalry — ${p1Streaks.currentWinningStreak} in a row`;
    }
    if (p2Streaks.currentWinningStreak >= 3 && p2Streaks.currentWinningStreak >= p2Run.length) {
        return `${p2}'s longest win streak of your rivalry — ${p2Streaks.currentWinningStreak} in a row`;
    }

    // Trigger 3: milestone game count
    const milestones = [10, 25, 50, 75, 100, 150, 200];
    if (milestones.includes(allGames.length)) {
        return `Game ${allGames.length} — milestone reached`;
    }

    // Trigger 4: first clean sheet in last N games
    const CLEAN_SHEET_WINDOW = 10;
    if (sorted.length > CLEAN_SHEET_WINDOW) {
        const recent = sorted.slice(-1)[0];
        const prior = sorted.slice(-CLEAN_SHEET_WINDOW - 1, -1);
        const lastHadClean = prior.some(g => g.player1Goals === 0 || g.player2Goals === 0);
        if (!lastHadClean && (recent.player1Goals === 0 || recent.player2Goals === 0)) {
            return `First clean sheet in ${CLEAN_SHEET_WINDOW} games`;
        }
    }

    // Trigger 5: current losing streak worth noting
    if (p1Streaks.currentLosingStreak >= 3) {
        return `${p1} on a ${p1Streaks.currentLosingStreak}-game losing streak — time for a comeback`;
    }
    if (p2Streaks.currentLosingStreak >= 3) {
        return `${p2} on a ${p2Streaks.currentLosingStreak}-game losing streak — time for a comeback`;
    }

    // Trigger 6: series record headline
    if (p1Wins > 0 || p2Wins > 0) {
        if (p1Wins > p2Wins) return `${p1} leads the series ${p1Wins}–${p2Wins}`;
        if (p2Wins > p1Wins) return `${p2} leads the series ${p2Wins}–${p1Wins}`;
        return `All square — ${p1Wins} wins each`;
    }

    return null;
}

function renderRivalryHeadline(allGames) {
    const el = document.getElementById('rivalry-headline');
    if (!el) return;

    const headline = computeRivalryHeadline(allGames);
    if (!headline) {
        el.style.display = 'none';
        return;
    }

    el.textContent = headline;
    el.style.display = '';
}

// ── Feature 4: All-time records wall ─────────────────────────────────────

function renderRecordsWall(allGames) {
    const container = document.getElementById('records-wall');
    if (!container) return;

    const api = window.FootballPlayerStats;
    if (!api) return;

    if (allGames.length === 0) {
        container.innerHTML = '<span class="records-empty">No games yet</span>';
        return;
    }

    const p1 = window.player1Name || 'Player 1';
    const p2 = window.player2Name || 'Player 2';

    // Biggest win (largest goal margin)
    let biggestWin = null;
    let biggestMargin = 0;
    for (const g of allGames) {
        const margin = Math.abs(g.player1Goals - g.player2Goals);
        if (margin > biggestMargin) {
            biggestMargin = margin;
            biggestWin = g;
        }
    }

    // Highest-scoring game
    let highestScoring = allGames[0];
    let highestTotal = highestScoring.player1Goals + highestScoring.player2Goals;
    for (const g of allGames) {
        const total = g.player1Goals + g.player2Goals;
        if (total > highestTotal) {
            highestTotal = total;
            highestScoring = g;
        }
    }

    // Longest win run per player
    const isWin = r => r === 'W';
    const p1Run = api.longestMatchRun(allGames, 'player1Goals', 'player2Goals', 1, isWin);
    const p2Run = api.longestMatchRun(allGames, 'player2Goals', 'player1Goals', 2, isWin);
    const longestRun = p1Run.length >= p2Run.length ? { run: p1Run, player: p1 } : { run: p2Run, player: p2 };

    function dateStr(iso) {
        if (!iso) return '';
        return new Date(iso).toLocaleDateString();
    }

    const biggestWinScore = biggestWin
        ? (biggestWin.player1Goals > biggestWin.player2Goals
            ? `${p1} ${biggestWin.player1Goals}–${biggestWin.player2Goals} ${p2}`
            : `${p2} ${biggestWin.player2Goals}–${biggestWin.player1Goals} ${p1}`)
        : '—';

    container.innerHTML = `
        <div class="record-item">
            <span class="record-icon">🏆</span>
            <div class="record-body">
                <span class="record-label">Biggest Win</span>
                <span class="record-value">${escapeHtml(biggestWinScore)}</span>
                ${biggestWin ? `<span class="record-date">${dateStr(biggestWin.dateTime)}</span>` : ''}
            </div>
        </div>
        <div class="record-item">
            <span class="record-icon">🔥</span>
            <div class="record-body">
                <span class="record-label">Highest-Scoring Game</span>
                <span class="record-value">${escapeHtml(p1)} ${highestScoring.player1Goals}–${highestScoring.player2Goals} ${escapeHtml(p2)} (${highestTotal} goals)</span>
                <span class="record-date">${dateStr(highestScoring.dateTime)}</span>
            </div>
        </div>
        <div class="record-item">
            <span class="record-icon">⚡</span>
            <div class="record-body">
                <span class="record-label">Longest Win Run</span>
                <span class="record-value">${escapeHtml(longestRun.player)} — ${longestRun.run.length} game${longestRun.run.length !== 1 ? 's' : ''}</span>
                ${longestRun.run.length > 0 ? `<span class="record-date">${dateStr(longestRun.run.startDate)} – ${dateStr(longestRun.run.endDate)}</span>` : ''}
            </div>
        </div>
    `;
}

// ── Feature 5: Goal-difference trend chart ────────────────────────────────

function renderGoalDiffChart(allGames) {
    const container = document.getElementById('goal-diff-chart');
    if (!container) return;

    if (allGames.length === 0) {
        container.innerHTML = '';
        return;
    }

    const sorted = allGames.slice().sort((a, b) => {
        const ta = new Date(a.dateTime || 0).getTime();
        const tb = new Date(b.dateTime || 0).getTime();
        return ta - tb;
    });

    // Cumulative goal diff from P1's perspective
    const points = [];
    let cumulative = 0;
    for (const g of sorted) {
        cumulative += (g.player1Goals - g.player2Goals);
        points.push(cumulative);
    }

    const p1 = window.player1Name || 'Player 1';
    const p2 = window.player2Name || 'Player 2';

    const W = 600;
    const H = 100;
    const PAD = { top: 10, bottom: 10, left: 4, right: 4 };
    const chartW = W - PAD.left - PAD.right;
    const chartH = H - PAD.top - PAD.bottom;

    const minVal = Math.min(0, ...points);
    const maxVal = Math.max(0, ...points);
    const range = maxVal - minVal || 1;

    function px(i) {
        return PAD.left + (i / Math.max(points.length - 1, 1)) * chartW;
    }
    function py(v) {
        return PAD.top + ((maxVal - v) / range) * chartH;
    }

    const zeroY = py(0);

    // Build path
    const pathParts = points.map((v, i) => `${i === 0 ? 'M' : 'L'}${px(i).toFixed(1)},${py(v).toFixed(1)}`);
    const linePath = pathParts.join(' ');

    // Fill area above/below zero
    const fillPath = [
        `M${px(0).toFixed(1)},${zeroY.toFixed(1)}`,
        ...points.map((v, i) => `L${px(i).toFixed(1)},${py(v).toFixed(1)}`),
        `L${px(points.length - 1).toFixed(1)},${zeroY.toFixed(1)}`,
        'Z'
    ].join(' ');

    const lastVal = points[points.length - 1];
    const lastX = px(points.length - 1).toFixed(1);
    const lastY = py(lastVal).toFixed(1);

    const fillColor = lastVal > 0 ? 'rgba(52, 211, 153, 0.18)' : lastVal < 0 ? 'rgba(248, 113, 113, 0.18)' : 'rgba(251, 191, 36, 0.12)';
    const strokeColor = lastVal > 0 ? '#34d399' : lastVal < 0 ? '#f87171' : '#fbbf24';

    container.innerHTML = `
        <div class="gd-chart-header">
            <span class="gd-label-p1">${escapeHtml(p1)} +</span>
            <span class="gd-chart-title">Goal Difference</span>
            <span class="gd-label-p2">${escapeHtml(p2)} +</span>
        </div>
        <svg viewBox="0 0 ${W} ${H}" class="gd-svg" aria-label="Cumulative goal difference chart">
            <defs>
                <clipPath id="gdClip">
                    <rect x="${PAD.left}" y="${PAD.top}" width="${chartW}" height="${chartH}" />
                </clipPath>
            </defs>
            <!-- zero line -->
            <line x1="${PAD.left}" y1="${zeroY.toFixed(1)}" x2="${W - PAD.right}" y2="${zeroY.toFixed(1)}"
                  stroke="rgba(255,255,255,0.15)" stroke-width="1" stroke-dasharray="4 3" />
            <!-- fill -->
            <path d="${fillPath}" fill="${fillColor}" clip-path="url(#gdClip)" />
            <!-- line -->
            <path d="${linePath}" fill="none" stroke="${strokeColor}" stroke-width="2"
                  stroke-linecap="round" stroke-linejoin="round" clip-path="url(#gdClip)" />
            <!-- endpoint dot -->
            <circle cx="${lastX}" cy="${lastY}" r="3.5" fill="${strokeColor}" />
        </svg>
        <div class="gd-current">${lastVal > 0 ? '+' : ''}${lastVal} (${lastVal > 0 ? escapeHtml(p1) + ' ahead' : lastVal < 0 ? escapeHtml(p2) + ' ahead' : 'level'})</div>
    `;
}

// ── Feature 6: Win % over last 10 ────────────────────────────────────────

function renderLast10Stats(allGames) {
    const p1El = document.getElementById('last10-p1');
    const p2El = document.getElementById('last10-p2');
    if (!p1El || !p2El) return;

    if (allGames.length === 0) {
        p1El.textContent = '';
        p2El.textContent = '';
        return;
    }

    const api = window.FootballPlayerStats;
    if (!api) return;

    const sorted = allGames.slice().sort((a, b) => {
        const ta = new Date(a.dateTime || 0).getTime();
        const tb = new Date(b.dateTime || 0).getTime();
        return ta - tb;
    });

    const last10 = sorted.slice(-10);

    let p1Wins10 = 0, p2Wins10 = 0;
    for (const g of last10) {
        if (g.player1Goals > g.player2Goals) p1Wins10++;
        else if (g.player2Goals > g.player1Goals) p2Wins10++;
        else if (g.penaltyWinner === 1) p1Wins10++;
        else if (g.penaltyWinner === 2) p2Wins10++;
    }

    const n = last10.length;
    const p1Pct = n > 0 ? Math.round((p1Wins10 / n) * 100) : 0;
    const p2Pct = n > 0 ? Math.round((p2Wins10 / n) * 100) : 0;

    p1El.textContent = `${p1Wins10}–${p2Wins10} last ${n} (${p1Pct}%)`;
    p2El.textContent = `${p2Wins10}–${p1Wins10} last ${n} (${p2Pct}%)`;
}

// ── Feature 7: Comeback / Thrashing badges ───────────────────────────────

function getGameBadges(game) {
    const badges = [];
    const margin = Math.abs(game.player1Goals - game.player2Goals);
    if (margin >= 4) {
        badges.push({ cls: 'badge-thrashing', text: 'Thrashing' });
    }
    // Comeback: penalty winner was behind in regulation
    if (game.penaltyWinner === 1 && game.player2Goals > game.player1Goals) {
        badges.push({ cls: 'badge-comeback', text: 'Comeback' });
    }
    if (game.penaltyWinner === 2 && game.player1Goals > game.player2Goals) {
        badges.push({ cls: 'badge-comeback', text: 'Comeback' });
    }
    return badges;
}

function buildBadgesHtml(game) {
    const badges = getGameBadges(game);
    if (badges.length === 0) return '';
    return badges.map(b => `<span class="game-badge ${b.cls}">${b.text}</span>`).join('');
}

// Expose so renderGamesTableWithData in football-h2h.js can use it
window.buildBadgesHtml = buildBadgesHtml;

// ── Feature 8: Session mode ───────────────────────────────────────────────

const SESSION_KEY = 'footballH2HSession';

function loadSession() {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (_) { return null; }
}

function saveSession(session) {
    if (session === null) {
        localStorage.removeItem(SESSION_KEY);
    } else {
        localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    }
}

function getActiveSession() {
    return loadSession();
}
window.getActiveSession = getActiveSession;

function startSession() {
    const existing = loadSession();
    if (existing && existing.active) {
        showToast('Session already active', 'info');
        return;
    }
    const session = {
        id: Date.now().toString(36),
        startedAt: new Date().toISOString(),
        active: true
    };
    saveSession(session);
    renderSessionControls();
    showToast('Session started', 'success');
}

function endSession() {
    const session = loadSession();
    if (!session || !session.active) {
        showToast('No active session', 'info');
        return;
    }
    session.active = false;
    session.endedAt = new Date().toISOString();
    saveSession(session);

    // Show session summary for games in this session
    const sessionGames = (window.games || []).filter(g => g.sessionId === session.id);
    renderSessionControls();
    showSessionSummaryForGames(sessionGames, session);
}

function showSessionSummaryForGames(sessionGames, session) {
    const p1 = window.player1Name || 'Player 1';
    const p2 = window.player2Name || 'Player 2';

    let p1Wins = 0, p2Wins = 0, draws = 0;
    for (const g of sessionGames) {
        if (g.player1Goals > g.player2Goals) p1Wins++;
        else if (g.player2Goals > g.player1Goals) p2Wins++;
        else if (g.penaltyWinner === 1) p1Wins++;
        else if (g.penaltyWinner === 2) p2Wins++;
        else draws++;
    }

    const startStr = session.startedAt ? new Date(session.startedAt).toLocaleString() : '';
    const endStr = session.endedAt ? new Date(session.endedAt).toLocaleString() : '';
    let winner = p1Wins > p2Wins ? p1 : p2Wins > p1Wins ? p2 : 'Level';

    const content = `
        <div class="session-summary-card">
            <div class="session-summary-stat"><span class="session-stat-label">Games played</span><span class="session-stat-value">${sessionGames.length}</span></div>
            <div class="session-summary-stat"><span class="session-stat-label">${escapeHtml(p1)}</span><span class="session-stat-value">${p1Wins}W</span></div>
            <div class="session-summary-stat"><span class="session-stat-label">${escapeHtml(p2)}</span><span class="session-stat-value">${p2Wins}W</span></div>
            <div class="session-summary-stat"><span class="session-stat-label">Draws</span><span class="session-stat-value">${draws}</span></div>
            <div class="session-winner">Session winner: <strong>${escapeHtml(winner)}</strong></div>
            <div class="session-times"><small>${escapeHtml(startStr)} → ${escapeHtml(endStr)}</small></div>
        </div>
    `;

    createModal({
        icon: '📋',
        title: 'Session Summary',
        content,
        buttons: [{ id: 'close-session-btn', text: 'Close', type: 1, onClick: () => {} }]
    });
}

function renderSessionControls() {
    const banner = document.getElementById('session-banner');
    const startBtn = document.getElementById('session-start-btn');
    const endBtn = document.getElementById('session-end-btn');
    if (!banner || !startBtn || !endBtn) return;

    const session = loadSession();
    const active = session && session.active;

    startBtn.style.display = active ? 'none' : '';
    endBtn.style.display = active ? '' : 'none';
    banner.style.display = active ? '' : 'none';

    if (active && session.startedAt) {
        const t = new Date(session.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const sessionGames = (window.games || []).filter(g => g.sessionId === session.id);
        banner.textContent = `Session active since ${t} · ${sessionGames.length} game${sessionGames.length !== 1 ? 's' : ''}`;
    }
}
window.renderSessionControls = renderSessionControls;

window.startSession = startSession;
window.endSession = endSession;

// ── Feature 1: Post-match share card ─────────────────────────────────────

function buildShareText(game) {
    const p1 = window.player1Name || 'Player 1';
    const p2 = window.player2Name || 'Player 2';

    const scoreStr = `${p1} ${game.player1Goals}–${game.player2Goals} ${p2}`;

    const allGames = window.games || [];
    let p1Wins = 0, p2Wins = 0;
    for (const g of allGames) {
        if (g.player1Goals > g.player2Goals) p1Wins++;
        else if (g.player2Goals > g.player1Goals) p2Wins++;
        else if (g.penaltyWinner === 1) p1Wins++;
        else if (g.penaltyWinner === 2) p2Wins++;
    }
    const recordStr = p1Wins > p2Wins
        ? `${p1} leads ${p1Wins}–${p2Wins}`
        : p2Wins > p1Wins
            ? `${p2} leads ${p2Wins}–${p1Wins}`
            : `All square ${p1Wins}–${p2Wins}`;

    const api = window.FootballPlayerStats;
    let streakStr = '';
    if (api) {
        const p1Results = api.matchResultsInOrder(allGames, 'player1Goals', 'player2Goals', 1);
        const p2Results = api.matchResultsInOrder(allGames, 'player2Goals', 'player1Goals', 2);
        const s1 = api.computeMatchStreaks(p1Results);
        const s2 = api.computeMatchStreaks(p2Results);
        if (s1.currentWinningStreak > 1) streakStr = ` · ${p1} W${s1.currentWinningStreak}`;
        else if (s2.currentWinningStreak > 1) streakStr = ` · ${p2} W${s2.currentWinningStreak}`;
    }

    return `${scoreStr} · ${recordStr}${streakStr}`;
}

function showShareCard(game) {
    const text = buildShareText(game);

    const canShare = typeof navigator.share === 'function';

    const content = `
        <div class="share-card-text" id="shareCardText">${escapeHtml(text)}</div>
    `;

    const buttons = [];
    if (canShare) {
        buttons.push({
            id: 'share-native-btn',
            text: 'Share',
            type: 0,
            onClick: () => {
                navigator.share({ text }).catch(() => {});
                return false;
            },
            closeOnClick: false
        });
    }
    buttons.push({
        id: 'share-copy-btn',
        text: 'Copy',
        type: canShare ? 1 : 0,
        onClick: () => {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text).then(() => showToast('Copied!', 'success'));
            } else {
                const ta = document.createElement('textarea');
                ta.value = text;
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);
                showToast('Copied!', 'success');
            }
            return false;
        },
        closeOnClick: false
    });
    buttons.push({
        id: 'share-close-btn',
        text: 'Close',
        type: 1,
        onClick: () => {}
    });

    createModal({
        icon: '⚽',
        title: 'Share Result',
        content,
        buttons
    });
}

window.showShareCard = showShareCard;

// ── Feature 10: Rematch nudge banner ─────────────────────────────────────

const REMATCH_DISMISS_KEY = 'footballH2HRematchDismissed';

function checkRematchNudge() {
    const allGames = window.games || [];
    if (allGames.length === 0) return;

    // Already dismissed today?
    const dismissed = localStorage.getItem(REMATCH_DISMISS_KEY);
    if (dismissed) {
        const dismissedDate = new Date(dismissed).toDateString();
        if (dismissedDate === new Date().toDateString()) return;
    }

    const sorted = allGames.slice().sort((a, b) =>
        new Date(b.dateTime || 0).getTime() - new Date(a.dateTime || 0).getTime()
    );

    const lastGame = sorted[0];
    if (!lastGame || !lastGame.dateTime) return;

    const daysSince = Math.floor(
        (Date.now() - new Date(lastGame.dateTime).getTime()) / (1000 * 60 * 60 * 24)
    );

    if (daysSince < 7) return;

    const banner = document.getElementById('rematch-nudge');
    if (!banner) return;

    banner.querySelector('.rematch-nudge-text').textContent =
        `It's been ${daysSince} day${daysSince !== 1 ? 's' : ''} — time for a rematch?`;
    banner.style.display = '';
}

function dismissRematchNudge() {
    localStorage.setItem(REMATCH_DISMISS_KEY, new Date().toISOString());
    const banner = document.getElementById('rematch-nudge');
    if (banner) banner.style.display = 'none';
}
window.dismissRematchNudge = dismissRematchNudge;

// ── Feature 3: Quick-log shortcut ────────────────────────────────────────

let quickLogOpen = false;

function toggleQuickLog() {
    const panel = document.getElementById('quick-log-panel');
    if (!panel) return;

    quickLogOpen = !quickLogOpen;
    panel.style.display = quickLogOpen ? '' : 'none';

    if (quickLogOpen) {
        // Update player name labels
        const p1 = window.player1Name || 'P1';
        const p2 = window.player2Name || 'P2';
        const lbl1 = document.getElementById('ql-p1-label');
        const lbl2 = document.getElementById('ql-p2-label');
        if (lbl1) lbl1.textContent = p1;
        if (lbl2) lbl2.textContent = p2;
        // Update penalty options
        const penSel = document.getElementById('ql-penalty-winner');
        if (penSel) {
            penSel.innerHTML = `
                <option value="">Select result</option>
                <option value="1">${escapeHtml(p1)} wins</option>
                <option value="2">${escapeHtml(p2)} wins</option>
                <option value="draw">Draw</option>
            `;
        }
        // Pre-fill team type from most-recent game
        const allGames = window.games || [];
        const sorted = allGames.slice().sort((a, b) =>
            new Date(b.dateTime || 0).getTime() - new Date(a.dateTime || 0).getTime()
        );
        const lastGame = sorted[0];
        const lastTeam = (lastGame && lastGame.player1Team) || 'Ultimate Team';
        const teamDisplay = document.getElementById('ql-team-display');
        if (teamDisplay) teamDisplay.textContent = lastTeam;

        const ql1 = document.getElementById('ql-p1-goals');
        const ql2 = document.getElementById('ql-p2-goals');
        if (ql1) { ql1.value = ''; ql1.focus(); }
        if (ql2) ql2.value = '';
        const qlPen = document.getElementById('ql-penalty-section');
        if (qlPen) qlPen.style.display = 'none';
    }
}
window.toggleQuickLog = toggleQuickLog;

function checkQuickLogDraw() {
    const v1 = document.getElementById('ql-p1-goals')?.value;
    const v2 = document.getElementById('ql-p2-goals')?.value;
    const penSection = document.getElementById('ql-penalty-section');
    if (!penSection) return;
    if (v1 !== '' && v2 !== '' && v1 === v2) {
        penSection.style.display = '';
    } else {
        penSection.style.display = 'none';
        const penSel = document.getElementById('ql-penalty-winner');
        if (penSel) penSel.value = '';
    }
}
window.checkQuickLogDraw = checkQuickLogDraw;

function submitQuickLog() {
    const v1 = document.getElementById('ql-p1-goals')?.value;
    const v2 = document.getElementById('ql-p2-goals')?.value;
    const p1 = window.player1Name || 'Player 1';
    const p2 = window.player2Name || 'Player 2';

    if (v1 === '' || v1 === null || v1 === undefined) {
        showToast(`Enter goals for ${p1}`, 'error');
        return;
    }
    if (v2 === '' || v2 === null || v2 === undefined) {
        showToast(`Enter goals for ${p2}`, 'error');
        return;
    }

    const g1 = parseInt(v1);
    const g2 = parseInt(v2);

    let penaltyWinner = null;
    if (g1 === g2) {
        const penSel = document.getElementById('ql-penalty-winner');
        const pv = penSel ? penSel.value : '';
        if (!pv) { showToast('Select a penalty result', 'error'); return; }
        penaltyWinner = pv === 'draw' ? 'draw' : parseInt(pv);
    }

    // Get team from most-recent game or default
    const allGames = window.games || [];
    const sorted = allGames.slice().sort((a, b) =>
        new Date(b.dateTime || 0).getTime() - new Date(a.dateTime || 0).getTime()
    );
    const lastGame = sorted[0];
    const team = (lastGame && lastGame.player1Team) || 'Ultimate Team';
    const team2 = (lastGame && lastGame.player2Team) || 'Ultimate Team';

    const session = loadSession();
    const newGame = {
        id: window.FootballMatchLogic ? window.FootballMatchLogic.nextGameId(allGames) : Date.now(),
        player1Goals: g1,
        player2Goals: g2,
        player1Team: team,
        player2Team: team2,
        penaltyWinner,
        dateTime: new Date().toISOString(),
        gameNumber: allGames.length + 1,
        lastModified: new Date().toISOString(),
        ...(session && session.active ? { sessionId: session.id } : {})
    };

    if (window.games && Array.isArray(window.games)) {
        window.games.push(newGame);
        if (window.saveGames) window.saveGames();
        if (window.addToHistory) window.addToHistory({ type: 'add_game', data: newGame });
        if (window.updateUI) window.updateUI();
        renderSessionControls();
        showToast(`Game added: ${p1} ${g1}–${g2} ${p2}`, 'success');

        // Close quick log and show share card
        quickLogOpen = false;
        const panel = document.getElementById('quick-log-panel');
        if (panel) panel.style.display = 'none';

        setTimeout(() => showShareCard(newGame), 300);
    }
}
window.submitQuickLog = submitQuickLog;

// ── Hook into existing save flows to tag session + show share card ────────

// Patch submitSidebarGame to inject sessionId and trigger share card
const _origSubmitSidebarGame = window.submitSidebarGame;
if (typeof _origSubmitSidebarGame === 'function') {
    window.submitSidebarGame = function() {
        const countBefore = (window.games || []).length;
        _origSubmitSidebarGame();
        const allGames = window.games || [];
        // Only run post-save logic if a game was actually added
        if (allGames.length <= countBefore) return;

        const newest = allGames.reduce((a, b) => (a.id > b.id ? a : b));

        // Attach sessionId if session is active
        const session = loadSession();
        if (session && session.active && !newest.sessionId) {
            newest.sessionId = session.id;
            if (window.saveGames) window.saveGames();
        }

        renderSessionControls();
        setTimeout(() => showShareCard(newest), 300);
    };
}

// ── Hook into updateStatisticsWithData to render new panels ──────────────

const _origUpdateStatisticsWithData = window.updateStatisticsWithData;
if (typeof _origUpdateStatisticsWithData === 'function') {
    window.updateStatisticsWithData = function(gamesData) {
        _origUpdateStatisticsWithData(gamesData);
        const allGames = window.games || [];
        renderRivalryHeadline(allGames);
        renderRecordsWall(allGames);
        renderGoalDiffChart(allGames);
        renderLast10Stats(allGames);
        renderSessionControls();
        checkRematchNudge();
    };
}

// ── Hook into renderGamesTableWithData to inject badges ──────────────────

const _origRenderGamesTableWithData = window.renderGamesTableWithData;
if (typeof _origRenderGamesTableWithData === 'function') {
    window.renderGamesTableWithData = function(gamesData) {
        _origRenderGamesTableWithData(gamesData);
        // Inject badges into each row's date cell
        const tbody = document.getElementById('gamesTableBody');
        if (!tbody) return;
        const rows = tbody.querySelectorAll('tr');
        const displayed = gamesData.slice(); // same order as rendered
        // The table already rendered; we find each row's game by index
        // Since getPaginatedItems may have sliced, we need to match the same slice
        const allGames = window.games || [];
        let displayed2 = gamesData;
        if (window.GlobalPaginationManager) {
            displayed2 = window.GlobalPaginationManager.getPaginatedItems('football-h2h-games', gamesData);
        }
        rows.forEach((row, idx) => {
            const game = displayed2[idx];
            if (!game) return;
            const badges = buildBadgesHtml(game);
            if (!badges) return;
            const dateCell = row.querySelector('.game-date');
            if (dateCell) {
                const existing = dateCell.querySelector('.badges-row');
                if (!existing) {
                    const badgeContainer = document.createElement('div');
                    badgeContainer.className = 'badges-row';
                    badgeContainer.innerHTML = badges;
                    dateCell.appendChild(badgeContainer);
                }
            }
        });
    };
}

// ── Init on DOMContentLoaded ──────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', function() {
    renderSessionControls();
    // Rematch nudge runs after games load (updateStatisticsWithData will call it)
});
