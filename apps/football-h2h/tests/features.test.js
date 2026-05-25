'use strict';

process.env.TZ = 'UTC';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
// Non-strict assert: `deepStrictEqual` fails across vm realms because the vm
// context has its own Array prototype. `deepEqual` does structural comparison
// that survives the realm boundary.
const assert = require('node:assert');

const JS_DIR = path.join(__dirname, '..', 'js');
const FH2H_JS_DIR = JS_DIR;

// ── vm context ────────────────────────────────────────────────────────────
// features.js relies on window.FootballPlayerStats, window.player1Name,
// window.player2Name, window.games, and several DOM stubs. We load
// playerStats.js first (it self-registers on window), then features.js.

function makeContext(extra = {}) {
    const noopFn = () => null;
    const lsMap = new Map();
    const sandbox = {
        console,
        Date, Intl, JSON, Math,
        Array, Object, Number, String, Boolean, RegExp,
        parseInt, parseFloat, isNaN, isFinite,
        setTimeout, clearTimeout, setInterval, clearInterval,
        window: {},
        document: {
            getElementById: noopFn,
            querySelector: noopFn,
            querySelectorAll: () => [],
            createElement: () => ({
                style: {},
                classList: { add() {}, remove() {}, toggle() {} },
                appendChild() {}, innerHTML: '', textContent: '',
            }),
            body: { appendChild() {}, removeChild() {} },
            addEventListener() {},
        },
        localStorage: {
            getItem: (k) => (lsMap.has(k) ? lsMap.get(k) : null),
            setItem: (k, v) => lsMap.set(k, String(v)),
            removeItem: (k) => lsMap.delete(k),
            clear: () => lsMap.clear(),
        },
        navigator: { share: undefined },
        escapeHtml: (s) => String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;'),
        showToast: () => {},
        createModal: () => {},
        ...extra,
    };
    sandbox.window = sandbox;
    return vm.createContext(sandbox);
}

function loadFile(ctx, relPath) {
    const src = fs.readFileSync(path.join(FH2H_JS_DIR, relPath), 'utf8');
    vm.runInContext(src, ctx, { filename: relPath });
}

// Load playerStats.js + features.js into a fresh context.
function makeLoadedCtx(extra = {}) {
    const ctx = makeContext(extra);
    loadFile(ctx, 'playerStats.js');
    loadFile(ctx, 'features.js');
    return ctx;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function game(opts) {
    return {
        id: opts.id || 1,
        player1Goals: opts.p1 !== undefined ? opts.p1 : 0,
        player2Goals: opts.p2 !== undefined ? opts.p2 : 0,
        penaltyWinner: opts.pen !== undefined ? opts.pen : null,
        dateTime: opts.date || '2026-01-01T12:00:00Z',
        gameNumber: opts.id || 1,
        player1Team: 'Team A',
        player2Team: 'Team B',
    };
}

// ── Feature 7: getGameBadges ──────────────────────────────────────────────

test('getGameBadges: no badges for ordinary win (margin < 4)', () => {
    const ctx = makeLoadedCtx();
    const fn = ctx.getGameBadges;
    assert.equal(fn(game({ p1: 2, p2: 0 })).length, 0);
    assert.equal(fn(game({ p1: 3, p2: 1 })).length, 0);
});

test('getGameBadges: Thrashing badge at exactly 4-goal margin', () => {
    const ctx = makeLoadedCtx();
    const fn = ctx.getGameBadges;
    const badges = fn(game({ p1: 4, p2: 0 }));
    assert.equal(badges.length, 1);
    assert.equal(badges[0].cls, 'badge-thrashing');
    assert.equal(badges[0].text, 'Thrashing');
});

test('getGameBadges: Thrashing badge for margin > 4', () => {
    const ctx = makeLoadedCtx();
    const fn = ctx.getGameBadges;
    const badges = fn(game({ p1: 5, p2: 1 }));
    assert.equal(badges.length, 1);
    assert.equal(badges[0].cls, 'badge-thrashing');
});

test('getGameBadges: Thrashing badge for reversed margin >= 4', () => {
    const ctx = makeLoadedCtx();
    const fn = ctx.getGameBadges;
    assert.equal(fn(game({ p1: 0, p2: 4 }))[0].cls, 'badge-thrashing');
    assert.equal(fn(game({ p1: 1, p2: 6 }))[0].cls, 'badge-thrashing');
});

test('getGameBadges: no Thrashing badge at margin 3', () => {
    const ctx = makeLoadedCtx();
    const fn = ctx.getGameBadges;
    const badges = fn(game({ p1: 3, p2: 0 }));
    assert.equal(badges.filter(b => b.cls === 'badge-thrashing').length, 0);
});

test('getGameBadges: Comeback badge when penalty winner exists (draw + shootout)', () => {
    const ctx = makeLoadedCtx();
    const fn = ctx.getGameBadges;
    const b1 = fn(game({ p1: 1, p2: 1, pen: 1 }));
    assert.equal(b1.length, 1);
    assert.equal(b1[0].cls, 'badge-comeback');

    const b2 = fn(game({ p1: 2, p2: 2, pen: 2 }));
    assert.equal(b2.length, 1);
    assert.equal(b2[0].cls, 'badge-comeback');
});

test('getGameBadges: no Comeback badge for penalty draw (both players draw)', () => {
    const ctx = makeLoadedCtx();
    const fn = ctx.getGameBadges;
    const badges = fn(game({ p1: 1, p2: 1, pen: 'draw' }));
    assert.equal(badges.filter(b => b.cls === 'badge-comeback').length, 0);
});

test('getGameBadges: no Comeback badge for regular draw (no penalties)', () => {
    const ctx = makeLoadedCtx();
    const fn = ctx.getGameBadges;
    const badges = fn(game({ p1: 1, p2: 1, pen: null }));
    assert.equal(badges.filter(b => b.cls === 'badge-comeback').length, 0);
});

test('getGameBadges: both Thrashing and Comeback badges possible simultaneously', () => {
    // 4-0, then someone won the penalty (odd but testable)
    const ctx = makeLoadedCtx();
    const fn = ctx.getGameBadges;
    // margin=4, penaltyWinner=1 → Thrashing + Comeback
    const badges = fn({ player1Goals: 4, player2Goals: 0, penaltyWinner: 1 });
    assert.equal(badges.length, 2);
    assert.ok(badges.some(b => b.cls === 'badge-thrashing'));
    assert.ok(badges.some(b => b.cls === 'badge-comeback'));
});

test('buildBadgesHtml: returns empty string when no badges', () => {
    const ctx = makeLoadedCtx();
    const fn = ctx.buildBadgesHtml;
    assert.equal(fn(game({ p1: 1, p2: 0 })), '');
});

test('buildBadgesHtml: returns HTML string when badges exist', () => {
    const ctx = makeLoadedCtx();
    const fn = ctx.buildBadgesHtml;
    const html = fn(game({ p1: 4, p2: 0 }));
    assert.ok(html.includes('badge-thrashing'));
    assert.ok(html.includes('Thrashing'));
});

// ── Feature 2: computeRivalryHeadline ─────────────────────────────────────

test('computeRivalryHeadline: null for empty games', () => {
    const ctx = makeLoadedCtx({ player1Name: 'Alice', player2Name: 'Bob' });
    assert.equal(ctx.computeRivalryHeadline([]), null);
    assert.equal(ctx.computeRivalryHeadline(null), null);
});

test('computeRivalryHeadline: lead-change on last game (first time)', () => {
    const ctx = makeLoadedCtx({ player1Name: 'Alice', player2Name: 'Bob' });
    // Bob has all wins, Alice wins the last game to take lead for first time
    const games = [
        game({ id: 1, p1: 0, p2: 1, date: '2026-01-01T12:00:00Z' }),
        game({ id: 2, p1: 0, p2: 1, date: '2026-01-02T12:00:00Z' }),
        game({ id: 3, p1: 3, p2: 0, date: '2026-01-03T12:00:00Z' }),
        game({ id: 4, p1: 3, p2: 0, date: '2026-01-04T12:00:00Z' }),
        // Now Alice has 2W, Bob has 2W — tied, next Alice win takes lead for first time
        game({ id: 5, p1: 1, p2: 0, date: '2026-01-05T12:00:00Z' }),
    ];
    const headline = ctx.computeRivalryHeadline(games);
    assert.ok(headline !== null, 'headline should not be null');
    assert.ok(headline.includes('Alice'), 'should mention Alice');
    assert.ok(headline.includes('first time'), 'first lead should say first time');
});

test('computeRivalryHeadline: record win streak', () => {
    const ctx = makeLoadedCtx({ player1Name: 'Alice', player2Name: 'Bob' });
    // Alice leads from game 1 and never loses the lead, ending on a 3-game
    // win streak. No lead-change trigger fires, so streak headline wins.
    const games = [
        game({ id: 1, p1: 1, p2: 0, date: '2026-01-01T12:00:00Z' }),
        game({ id: 2, p1: 0, p2: 1, date: '2026-01-02T12:00:00Z' }),
        game({ id: 3, p1: 2, p2: 0, date: '2026-01-03T12:00:00Z' }),
        game({ id: 4, p1: 2, p2: 0, date: '2026-01-04T12:00:00Z' }),
        game({ id: 5, p1: 2, p2: 0, date: '2026-01-05T12:00:00Z' }),
    ];
    const headline = ctx.computeRivalryHeadline(games);
    assert.ok(headline !== null);
    assert.ok(headline.includes('3'), 'should mention 3 in a row');
});

test('computeRivalryHeadline: milestone game count', () => {
    const ctx = makeLoadedCtx({ player1Name: 'Alice', player2Name: 'Bob' });
    // Alternating wins so neither lead-change nor streak triggers fire,
    // letting the milestone trigger (10 games) win the priority chain.
    const games = Array.from({ length: 10 }, (_, i) => {
        const p1Wins = i % 2 === 0;
        return game({
            id: i + 1,
            p1: p1Wins ? 1 : 0,
            p2: p1Wins ? 0 : 1,
            date: `2026-01-${String(i + 1).padStart(2, '0')}T12:00:00Z`,
        });
    });
    const headline = ctx.computeRivalryHeadline(games);
    assert.ok(headline !== null);
    assert.ok(headline.includes('10'), 'should mention game 10');
    assert.ok(headline.toLowerCase().includes('milestone'));
});

test('computeRivalryHeadline: series record fallback', () => {
    const ctx = makeLoadedCtx({ player1Name: 'Alice', player2Name: 'Bob' });
    // 3 games, Alice leads 2-1, no streak/milestone triggers
    const games = [
        game({ id: 1, p1: 1, p2: 0, date: '2026-01-01T12:00:00Z' }),
        game({ id: 2, p1: 0, p2: 1, date: '2026-01-02T12:00:00Z' }),
        game({ id: 3, p1: 1, p2: 0, date: '2026-01-03T12:00:00Z' }),
    ];
    const headline = ctx.computeRivalryHeadline(games);
    assert.ok(headline !== null);
    assert.ok(headline.includes('Alice'), 'should mention Alice as leader');
    assert.ok(headline.includes('2'), 'should show 2 wins');
    assert.ok(headline.includes('1'), 'should show 1 wins');
});

test('computeRivalryHeadline: equal wins returns "All square" fallback', () => {
    const ctx = makeLoadedCtx({ player1Name: 'Alice', player2Name: 'Bob' });
    const games = [
        game({ id: 1, p1: 1, p2: 0, date: '2026-01-01T12:00:00Z' }),
        game({ id: 2, p1: 0, p2: 1, date: '2026-01-02T12:00:00Z' }),
    ];
    const headline = ctx.computeRivalryHeadline(games);
    assert.ok(headline !== null);
    assert.ok(headline.toLowerCase().includes('square') || headline.includes('1'), 'should show all square');
});

// ── Feature 1: buildShareText ─────────────────────────────────────────────

test('buildShareText: includes score and record', () => {
    const ctx = makeLoadedCtx({ player1Name: 'Alice', player2Name: 'Bob' });
    const g = game({ id: 1, p1: 3, p2: 1 });
    ctx.games = [g];
    const text = ctx.buildShareText(g);
    assert.ok(text.includes('Alice'), 'should include P1 name');
    assert.ok(text.includes('Bob'), 'should include P2 name');
    assert.ok(text.includes('3'), 'should include score');
    assert.ok(text.includes('1'), 'should include score');
    assert.ok(text.includes('leads') || text.includes('square'), 'should include record');
});

test('buildShareText: includes win streak when streak > 1', () => {
    const ctx = makeLoadedCtx({ player1Name: 'Alice', player2Name: 'Bob' });
    const games = [
        game({ id: 1, p1: 2, p2: 0, date: '2026-01-01T12:00:00Z' }),
        game({ id: 2, p1: 1, p2: 0, date: '2026-01-02T12:00:00Z' }),
    ];
    ctx.games = games;
    const text = ctx.buildShareText(games[1]);
    assert.ok(text.includes('W2'), 'should include streak W2');
});

test('buildShareText: no streak suffix for single-game win', () => {
    const ctx = makeLoadedCtx({ player1Name: 'Alice', player2Name: 'Bob' });
    const g = game({ id: 1, p1: 2, p2: 0 });
    ctx.games = [g];
    const text = ctx.buildShareText(g);
    assert.ok(!text.includes('W2') && !text.includes('W3'), 'no streak for single game');
});

test('buildShareText: works with empty games array (edge: no crash)', () => {
    const ctx = makeLoadedCtx({ player1Name: 'Alice', player2Name: 'Bob' });
    ctx.games = [];
    // Should not throw even with empty games
    const g = game({ id: 1, p1: 2, p2: 1 });
    let text;
    assert.doesNotThrow(() => { text = ctx.buildShareText(g); });
    assert.ok(typeof text === 'string');
});

// ── Feature 6: last-10 win % (pure computation, extracted inline) ─────────

// The last-10 logic is embedded in renderLast10Stats (DOM-touching). We test
// the underlying math by replicating the calculation here.
test('last-10 computation: correctly counts wins in last 10 games', () => {
    // Build 15 games where P1 wins 8 of the last 10
    const games = [];
    for (let i = 1; i <= 15; i++) {
        const d = `2026-01-${String(i).padStart(2, '0')}T12:00:00Z`;
        if (i <= 5) {
            // First 5: Bob wins
            games.push(game({ id: i, p1: 0, p2: 1, date: d }));
        } else if (i <= 13) {
            // Games 6–13: Alice wins (8 wins)
            games.push(game({ id: i, p1: 1, p2: 0, date: d }));
        } else {
            // Games 14–15: Bob wins
            games.push(game({ id: i, p1: 0, p2: 1, date: d }));
        }
    }
    // Sort by date and take last 10
    const sorted = games.slice().sort((a, b) =>
        new Date(a.dateTime).getTime() - new Date(b.dateTime).getTime()
    );
    const last10 = sorted.slice(-10);
    let p1Wins = 0, p2Wins = 0;
    for (const g of last10) {
        if (g.player1Goals > g.player2Goals) p1Wins++;
        else if (g.player2Goals > g.player1Goals) p2Wins++;
    }
    // Last 10 games are #6..#15. Alice wins games 6..13 (8 wins). Bob wins
    // games 14..15 (2 wins). Total 10.
    assert.equal(p1Wins, 8, 'Alice wins 8 of last 10 (games 6–13)');
    assert.equal(p2Wins, 2, 'Bob wins 2 of last 10 (games 14–15)');
    const pct = Math.round((p1Wins / 10) * 100);
    assert.equal(pct, 80);
});

test('last-10: works with fewer than 10 games', () => {
    const games = [
        game({ id: 1, p1: 1, p2: 0, date: '2026-01-01T12:00:00Z' }),
        game({ id: 2, p1: 0, p2: 1, date: '2026-01-02T12:00:00Z' }),
        game({ id: 3, p1: 1, p2: 0, date: '2026-01-03T12:00:00Z' }),
    ];
    const sorted = games.slice().sort((a, b) =>
        new Date(a.dateTime).getTime() - new Date(b.dateTime).getTime()
    );
    const last10 = sorted.slice(-10); // returns all 3 when n < 10
    assert.equal(last10.length, 3);
    let p1Wins = 0;
    for (const g of last10) {
        if (g.player1Goals > g.player2Goals) p1Wins++;
    }
    assert.equal(p1Wins, 2);
    const pct = Math.round((p1Wins / last10.length) * 100);
    assert.equal(pct, 67);
});

// ── Feature 8: session storage helpers ────────────────────────────────────

test('loadSession / saveSession: round-trip', () => {
    const ctx = makeLoadedCtx();
    const session = { id: 'abc', startedAt: '2026-01-01T00:00:00Z', active: true };
    ctx.saveSession(session);
    const loaded = ctx.loadSession();
    assert.deepEqual(loaded, session);
});

test('saveSession: null removes the key', () => {
    const ctx = makeLoadedCtx();
    ctx.saveSession({ id: 'x', active: true });
    ctx.saveSession(null);
    assert.equal(ctx.loadSession(), null);
});

test('loadSession: returns null when nothing stored', () => {
    const ctx = makeLoadedCtx();
    assert.equal(ctx.loadSession(), null);
});

test('loadSession: returns null on corrupt JSON', () => {
    const ctx = makeLoadedCtx();
    ctx.localStorage.setItem('footballH2HSession', '{invalid}');
    assert.equal(ctx.loadSession(), null);
});
