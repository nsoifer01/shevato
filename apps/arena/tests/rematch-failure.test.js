'use strict';

// A rematch whose content could not be fetched wedged the room for everyone
// (site-wide audit 2026-09-12, K-1).
//
// WHY: the rematch coordination fields (rematchProposedBy, rematchAcceptedBy,
// rematchDeclinedBy) were cleared only inside playAgain's SUCCESSFUL update.
// When the fetch failed (Wikidata or The Trivia API down, or an unusable
// result), the catch raised a blocking alert() and the finally re-armed
// rematchInFlight while the room doc still said "everyone accepted". The next
// render, which any snapshot triggers and a heartbeat guarantees within 30 s,
// saw that unanimity and called playAgain again: another fetch, another alert,
// for as long as the host stayed. Everyone else sat on "Rematch - N / N
// players ready" with nothing to press, and alert() froze the host's own
// heartbeat until a survivor took the room over and inherited the loop.
//
// These run the real renderRematchUI and playAgain from app.js (see
// helpers/app-vm.js) against an in-memory room, re-rendering the way snapshots
// do.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const Config = require('../js/config.js');
const RoomState = require('../js/room-state.js');
const { loadAppFunctions, createFirestoreFake, ts } = require('./helpers/app-vm.js');

const ROOM = 'triviaRooms/ROOMA';
const LOCATIONS = [{ id: 'peru' }, { id: 'chad' }, { id: 'fiji' }];
const QUESTIONS = [{ id: 'q1' }, { id: 'q2' }, { id: 'q3' }];
const unanimous = { rematchProposedBy: 'b', rematchAcceptedBy: ['b', 'host'], rematchDeclinedBy: [] };

function setup({ gameType = 'globe-drop', fetchContent }) {
    const store = createFirestoreFake();
    const now = Date.now();
    const players = ['host', 'b'].map((uid, i) => ({ uid, displayName: uid, joinedAt: ts(i), lastSeen: ts(now) }));
    store.seed(ROOM, Object.assign({
        hostUid: 'host', status: 'finished', gameType, roundType: 'capitals', packId: 'live',
        totalQuestions: 3, round: 1,
    }, unanimous));

    const elements = {
        '#rematch-strip': { hidden: true },
        '#rematch-status': { textContent: '' },
        '#rematch-actions': { hidden: true },
    };
    const calls = { fetch: 0, alerts: [], toasts: [] };
    const state = {
        roomCode: 'ROOMA', user: { uid: 'host' }, roomData: store.read(ROOM),
        roomPlayers: players, rematchInFlight: false, currentAnswers: [],
    };
    const ctx = loadAppFunctions([
        'renderRematchUI', 'playAgain', 'rematchPlayerCount', 'rematchAcceptCount',
        'rematchDeclineCount', 'meHasAcceptedRematch', 'meHasDeclinedRematch', 'livePlayers',
    ], {
        state, Config, RoomState,
        db: store.db, doc: store.doc, collection: store.collection,
        updateDoc: store.updateDoc, serverTimestamp: store.serverTimestamp,
        getDocs: async () => ({ docs: players.map((p) => ({ data: () => p })) }),
        $: (sel) => elements[sel] || null,
        setText: (el, text) => { if (el) el.textContent = text; },
        clearRematchStateSoon: () => {},
        GlobeDropLocations: {
            fetchLocations: async () => { calls.fetch++; return fetchContent(); },
        },
        buildQuestionsForRound: async () => {
            calls.fetch++;
            return { questions: await fetchContent(), packId: 'live', packName: 'Live' };
        },
        applyRoundMultipliers: (locs) => locs,
        shuffle: (a) => a,
        sortPlayersForRotation: (ps) => ps,
        alert: (msg) => { calls.alerts.push(String(msg)); },
        showToast: (msg, opts) => { calls.toasts.push({ msg: String(msg), key: opts && opts.key }); },
        endStageWrittenForRoom: null,
    });
    // A write lands on the room doc and the listener hands the new copy back.
    store.onWrite = () => { state.roomData = store.read(ROOM); };

    // renderRematchUI fires playAgain without awaiting it; collect the
    // promise so each simulated snapshot settles before the next one. A
    // heartbeat is 30 s apart, a failed fetch is not.
    const pending = [];
    const realPlayAgain = ctx.playAgain;
    ctx.playAgain = (...args) => {
        const p = realPlayAgain(...args);
        pending.push(p);
        return p;
    };
    async function render(asUid = 'host') {
        state.user = { uid: asUid };
        ctx.renderRematchUI(state.roomData.hostUid === asUid);
        await Promise.all(pending.splice(0));
    }
    return { store, state, calls, elements, render };
}

const outage = () => { throw new Error('Wikidata SPARQL returned 503'); };

for (const gameType of ['globe-drop', 'trivia']) {
    test(`K-1 (${gameType}): a failed fetch cancels the rematch once instead of looping on every snapshot`, async () => {
        const r = setup({ gameType, fetchContent: outage });
        // The unanimous accept, then four heartbeats' worth of re-renders.
        for (let i = 0; i < 5; i++) await r.render('host');

        assert.equal(r.calls.fetch, 1, 'a failure must not be re-fetched by every later snapshot');
        assert.equal(r.calls.alerts.length, 0, 'alert() blocks the host tab, heartbeat included');
        assert.equal(r.calls.toasts.length, 1, 'the host is told exactly once');
        assert.match(r.calls.toasts[0].msg, /rematch/i, 'and told what failed');
        const room = r.store.read(ROOM);
        assert.equal(room.rematchProposedBy, null, 'the dead proposal is withdrawn for everyone');
        assert.equal(room.rematchAcceptedBy.length, 0);
        assert.equal(room.round, 1, 'nothing was restarted');
    });
}

test('K-1: the other players are released from "N / N players ready" after the failure', async () => {
    const r = setup({ fetchContent: outage });
    await r.render('host');
    // Another client renders the same room doc after the failure.
    r.elements['#rematch-strip'].hidden = false;
    await r.render('b');
    assert.equal(r.elements['#rematch-strip'].hidden, true,
        'a player must not be left watching a proposal that can never complete');
});

test('K-1: proposing again once the source is back restarts the game normally', async () => {
    let up = false;
    const r = setup({ fetchContent: () => { if (!up) outage(); return LOCATIONS; } });
    await r.render('host');
    up = true;
    await r.store.updateDoc(r.store.doc(r.store.db, 'triviaRooms', 'ROOMA'), Object.assign({}, unanimous));
    await r.render('host');

    const room = r.store.read(ROOM);
    assert.equal(r.calls.fetch, 2);
    assert.equal(room.round, 2, 'the retry is a real rematch');
    assert.equal(room.status, 'playing');
    assert.equal(room.currentQuestionId, 'peru');
    assert.equal(room.rematchProposedBy, null);
    assert.equal(r.calls.alerts.length, 0);
});

// ---------------------------------------------------------------------------
// readyAfterQId across a rematch (audit P3).
//
// The Globe Drop Ready-skip advances once every live player's readyAfterQId
// equals the current location id. The vote was never reset between games, and
// location ids are deterministic (capitals and countries are the country name,
// Wikidata rounds a QID), so when a rematch re-drew the location everyone last
// voted Ready on, its reveal was skipped the moment it opened: nobody had
// voted in THIS game.
// ---------------------------------------------------------------------------
test('a Ready vote from the previous game cannot skip the same location\'s reveal in a rematch', async () => {
    const store = createFirestoreFake();
    const now = Date.now();
    const uids = ['host', 'b'];
    const playerPath = (uid) => `triviaRooms/ROOMA/players/${uid}`;
    // Game 1 ended with both players tapping Ready on its last location.
    uids.forEach((uid, i) => store.seed(playerPath(uid), {
        uid, round: 1, score: 60, joinedAt: ts(i), lastSeen: ts(now), readyAfterQId: 'france',
    }));
    const state = {
        roomCode: 'ROOMA', user: null, roomPlayers: [],
        earlyAdvanceForQuestion: null, earlyRevealForQuestion: null,
        // The rematch re-drew france first, and its reveal is open.
        roomData: {
            hostUid: 'host', status: 'playing', gameType: 'globe-drop', round: 2,
            currentQuestionIndex: 0, currentQuestionId: 'france', totalQuestions: 3,
            questionStartedAt: ts(now - 20000), questions: [{ id: 'france' }, { id: 'chad' }, { id: 'fiji' }],
        },
    };
    const advances = [];
    const ctx = loadAppFunctions(['maybeResetForNewRound', 'progressRoomClock', 'livePlayers'], {
        state, Config, RoomState, setTimeout,
        db: store.db, doc: store.doc, updateDoc: store.updateDoc, serverTimestamp: store.serverTimestamp,
        maybeTakeOverHost: () => {},
        maybeAutoPickCategory: () => {},
        sweepStalePlayers: () => {},
        currentAskingDurationMs: () => 15000,
        globeDropPhase: () => 'reveal',
        clockKey: (room) => `${room.round}:${room.currentQuestionIndex}:${room.currentQuestionId}`,
        advanceQuestionOrFinish: async (opts) => { advances.push(opts); },
    });
    const roster = () => uids.map((uid) => store.read(playerPath(uid)));

    // Every client notices the new round and resets its OWN player doc.
    for (const uid of uids) {
        state.user = { uid };
        state.roomPlayers = roster();
        await ctx.maybeResetForNewRound();
    }
    state.user = { uid: 'host' };
    state.roomPlayers = roster();
    ctx.progressRoomClock();
    assert.equal(advances.length, 0, 'nobody has voted Ready in this game yet');

    // Control: a real unanimous vote in this game still skips.
    for (const uid of uids) {
        await store.updateDoc(store.doc(store.db, 'triviaRooms', 'ROOMA', 'players', uid), { readyAfterQId: 'france' });
    }
    state.roomPlayers = roster();
    ctx.progressRoomClock();
    assert.equal(advances.length, 1, 'the Ready-skip itself must keep working');
    assert.equal(advances[0].unanimous, true);
});
