'use strict';

// Rejoining by room code after the disconnect grace kept the stale stamp
// (site-wide audit 2026-09-12, K-2).
//
// WHY: beforeUnloadCleanup stamps `disconnectedAt` when a tab closes. The
// 2026-09-03 fix cleared that stamp on the URL rejoin, on the post-match
// rejoin, inside joinPlayer's WITHIN-grace branch and on every heartbeat. It
// missed the path a player who closed the tab and came back later actually
// takes: a fresh tab, the join form, and joinPlayer's past-grace branch, which
// merged a fresh `lastSeen` over the old doc and left the stamp in place. The
// first heartbeat is a full PRESENCE_HEARTBEAT_MS (30 s) away, so for that
// long the returning player rendered as "Disconnected", was left out of the
// early reveal, the Ready vote, the rematch count and the Start minimum, and,
// with a game playing, the host's 500 ms clock deleted their doc mid-join.
// firestore.rules called the doc stale too, so that delete was allowed.
//
// These run the real joinPlayer and sweepStalePlayers from app.js (see
// helpers/app-vm.js) against an in-memory room.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const Config = require('../js/config.js');
const RoomState = require('../js/room-state.js');
const { loadAppFunctions, createFirestoreFake, ts } = require('./helpers/app-vm.js');

const HOST = 'triviaRooms/ROOMA/players/host';
const BOB = 'triviaRooms/ROOMA/players/b';

function setup(bobDoc) {
    const store = createFirestoreFake();
    store.seed('triviaRooms/ROOMA', { hostUid: 'host', status: 'playing', round: 1 });
    store.seed(HOST, { uid: 'host', joinedAt: ts(0), lastSeen: ts(Date.now()) });
    store.seed(BOB, bobDoc);
    const state = { roomCode: 'ROOMA', user: { uid: 'b' }, roomData: null, roomPlayers: [], sweptUids: {} };
    const ctx = loadAppFunctions(['joinPlayer', 'sweepStalePlayers'], {
        state, Config, RoomState,
        DISCONNECT_GRACE_MS: Config.DISCONNECT_GRACE_MS,
        isGuest: () => true,
        db: store.db, doc: store.doc, getDoc: store.getDoc, setDoc: store.setDoc,
        updateDoc: store.updateDoc, deleteDoc: store.deleteDoc,
        deleteField: store.deleteField, serverTimestamp: store.serverTimestamp,
    });

    // The host's next clock tick: sweepStalePlayers over the roster it holds.
    async function hostTick() {
        state.user = { uid: 'host' };
        state.roomData = store.read('triviaRooms/ROOMA');
        state.roomPlayers = [store.read(HOST), store.read(BOB)].filter(Boolean);
        ctx.sweepStalePlayers();
        await new Promise((resolve) => setImmediate(resolve));
    }
    return { store, ctx, hostTick };
}

test('K-2: a player who closed the tab and rejoins by code past the grace is live at once, and not swept', async () => {
    const closedAt = Date.now() - Config.DISCONNECT_GRACE_MS - 15000;
    const r = setup({ uid: 'b', displayName: 'Bob', score: 40, round: 1, joinedAt: ts(1),
        lastSeen: ts(closedAt), disconnectedAt: closedAt });
    assert.equal(RoomState.isPlayerLive(r.store.read(BOB), Date.now()), false,
        'precondition: past the grace the departed doc is stale');

    // The join form, in a fresh tab: joinPlayer with no reconnect state.
    await r.ctx.joinPlayer('ROOMA', 'Bob', false, -1, null);

    const back = r.store.read(BOB);
    assert.equal('disconnectedAt' in back, false,
        'the join write itself must clear the stamp; the first heartbeat is 30 s away');
    const liveUids = RoomState.livePlayers([r.store.read(HOST), back], Date.now()).map((p) => p.uid);
    assert.ok(liveUids.includes('b'),
        'a returning player renders as a player, and counts for reveal, Ready, rematch and Start');

    await r.hostTick();
    assert.ok(r.store.read(BOB), 'the host must not sweep a player who has just come back');
});

test('K-2 control: inside the grace the reconnect still clears the stamp and keeps the score', async () => {
    const closedAt = Date.now() - 5000;
    const r = setup({ uid: 'b', displayName: 'Bob', score: 40, round: 1, joinedAt: ts(1),
        lastSeen: ts(closedAt), disconnectedAt: closedAt });

    await r.ctx.joinPlayer('ROOMA', 'Bob', false, -1, null);

    const back = r.store.read(BOB);
    assert.equal('disconnectedAt' in back, false);
    assert.equal(back.score, 40, 'a reconnect inside the grace keeps the game it was in');
    await r.hostTick();
    assert.ok(r.store.read(BOB));
});
