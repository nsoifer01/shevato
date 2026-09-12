'use strict';

// A room permanently lost its host whenever the host's tab simply went away.
//
// WHY: `hostUid` was reassigned in exactly two places, both inside
// `leaveRoom` - the explicit "Leave room" button. `beforeUnloadCleanup`
// writes `disconnectedAt` and `lastSeen` and performs NO handoff, and a
// force-quit, a discarded background tab or a dead phone never fires
// `beforeunload` at all. So closing the tab left `hostUid` naming a player
// who was never coming back, and four host-gated behaviours stopped for the
// rest of the session:
//   - early reveal (`isHost &&`), so every round burned the full timer;
//   - the Globe Drop Ready-to-skip advance (`isGlobe && isHost &&`);
//   - `sweepStalePlayers`, which returns unless you are the host, so the
//     ghost that caused it could never be cleaned up either;
//   - `playAgain`, so rematch was impossible and the end screen sat at
//     "Rematch - 2/2 players ready" forever.
// The e2e only ever exercised the Leave button (scenario S2), which is why
// the gap survived.
//
// firestore.rules ALREADY permits the repair: `memberHostTakeover` lets a
// member name themselves host when the current host's player doc is gone or
// stale. What was missing was a client that asked. `shouldTakeOverHost` is
// that decision, kept pure and here: it must name exactly ONE writer, and it
// must never ask when the rules would refuse (a request while the host is
// live is a guaranteed 403 and a retry loop).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const Config = require('../js/config.js');
const { shouldTakeOverHost, pickNextHost } = require('../js/room-state.js');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'js', 'app.js'), 'utf8');

const NOW = 1_700_000_000_000;
const ts = (ms) => ({ toMillis: () => ms });

// Player docs as Firestore hands them over: joinedAt is a Timestamp, not a
// number. pickNextHost reads `Number(joinedAt) || 0`, so a predicate that
// forgets to convert silently degrades to a uid-alphabetical tie-break.
const live = (uid, joinedAtMs) => ({ uid, joinedAt: ts(joinedAtMs), lastSeen: ts(NOW) });
const ghost = (uid, joinedAtMs) => ({
    uid, joinedAt: ts(joinedAtMs),
    lastSeen: ts(NOW - Config.PRESENCE_STALE_MS - 1000)
});
const departed = (uid, joinedAtMs) => ({
    uid, joinedAt: ts(joinedAtMs), lastSeen: ts(NOW),
    disconnectedAt: NOW - Config.DISCONNECT_GRACE_MS - 1000
});

// --- the predicate ----------------------------------------------------

test('shouldTakeOverHost: nobody takes over from a live host', () => {
    const players = [live('host', 1), live('b', 2)];
    assert.equal(shouldTakeOverHost({ hostUid: 'host' }, players, 'b', NOW), false);
});

test('shouldTakeOverHost: a host inside the disconnect grace is still the host', () => {
    // They refreshed the page. Taking over here would also be refused by
    // the rules, which use the same 30 s grace.
    const recent = { uid: 'host', joinedAt: ts(1), lastSeen: ts(NOW), disconnectedAt: NOW - 5000 };
    assert.equal(shouldTakeOverHost({ hostUid: 'host' }, [recent, live('b', 2)], 'b', NOW), false);
});

test('shouldTakeOverHost: the earliest live joiner takes over from a ghost host (crashed tab)', () => {
    // The heartbeat is what catches a force-quit: beforeunload never fired.
    const players = [ghost('host', 1), live('b', 2), live('c', 3)];
    assert.equal(shouldTakeOverHost({ hostUid: 'host' }, players, 'b', NOW), true);
});

test('shouldTakeOverHost: exactly ONE client writes - everyone else stands down', () => {
    // Two clients both see the same dead host. If both wrote, the second
    // would 403 against a now-live host and retry; the deterministic pick is
    // what keeps a single writer per room.
    const players = [ghost('host', 1), live('b', 2), live('c', 3)];
    const claimers = ['b', 'c'].filter((uid) => shouldTakeOverHost({ hostUid: 'host' }, players, uid, NOW));
    assert.deepEqual(claimers, ['b'], 'only the pickNextHost winner claims it');
});

test('shouldTakeOverHost: a host whose player doc is GONE hands off too', () => {
    // The doc can vanish outright - a swept ghost, or a leaver whose room-doc
    // write failed after their player delete landed.
    const players = [live('b', 2), live('c', 3)];
    assert.equal(shouldTakeOverHost({ hostUid: 'host' }, players, 'b', NOW), true);
    assert.equal(shouldTakeOverHost({ hostUid: 'host' }, players, 'c', NOW), false);
});

test('shouldTakeOverHost: a departed host (beforeunload, past the grace) hands off', () => {
    const players = [departed('host', 1), live('b', 2)];
    assert.equal(shouldTakeOverHost({ hostUid: 'host' }, players, 'b', NOW), true);
});

test('shouldTakeOverHost: joinedAt is read as a Timestamp, so the EARLIEST joiner wins', () => {
    // 'z' joined first but sorts last alphabetically. A predicate that fails
    // to convert the Timestamp scores every joinedAt as 0 and falls through
    // to the uid tie-break, handing the room to the wrong player.
    const players = [ghost('host', 1), live('z', 2), live('a', 9)];
    assert.equal(pickNextHost([{ uid: 'z', joinedAt: 2 }, { uid: 'a', joinedAt: 9 }]), 'z',
        'precondition: pickNextHost orders by joinedAt first');
    assert.equal(shouldTakeOverHost({ hostUid: 'host' }, players, 'z', NOW), true);
    assert.equal(shouldTakeOverHost({ hostUid: 'host' }, players, 'a', NOW), false);
});

test('shouldTakeOverHost: the host never takes over from itself, and ghosts never claim', () => {
    const players = [live('host', 1), ghost('b', 2)];
    assert.equal(shouldTakeOverHost({ hostUid: 'host' }, players, 'host', NOW), false);
    // A ghost is not in the live set, so it can never be the pick - it also
    // could not write, having no working tab.
    assert.equal(shouldTakeOverHost({ hostUid: 'gone' }, [ghost('b', 2)], 'b', NOW), false);
});

test('shouldTakeOverHost: missing room, missing hostUid and a non-member are all no', () => {
    assert.equal(shouldTakeOverHost(null, [live('b', 1)], 'b', NOW), false);
    assert.equal(shouldTakeOverHost({}, [live('b', 1)], 'b', NOW), false);
    assert.equal(shouldTakeOverHost({ hostUid: 'host' }, [live('b', 1)], null, NOW), false);
    // A client with no player doc in the room is not eligible: the rules
    // require membership for the takeover write.
    assert.equal(shouldTakeOverHost({ hostUid: 'host' }, [live('b', 1)], 'stranger', NOW), false);
});

// --- the call site ----------------------------------------------------
//
// app.js is a browser module that touches the DOM at import time, so the
// wiring is read out of source. What is pinned is that the takeover runs off
// the room CLOCK (which ticks in every stage, including finished, and in a
// hidden tab) rather than only off the Leave button, and that it is keyed so
// one client writes it once.

test('progressRoomClock asks about the takeover, before the status guards', () => {
    const start = SRC.indexOf('function progressRoomClock(');
    assert.notEqual(start, -1, 'progressRoomClock must still exist in app.js');
    const body = SRC.slice(start, SRC.indexOf('async function maybeAutoPickCategory('));
    assert.match(body, /maybeTakeOverHost\(/,
        'the clock is the only thing that ticks when the room is idle, picking or finished');
    const takeoverAt = body.indexOf('maybeTakeOverHost(');
    const pickingGuard = body.indexOf("room.status === 'picking'");
    const playingGuard = body.indexOf("room.status !== 'playing'");
    assert.ok(pickingGuard > -1 && playingGuard > -1, 'precondition: the status guards are still there');
    assert.ok(takeoverAt < pickingGuard && takeoverAt < playingGuard,
        'a finished room needs the handoff most of all - rematch is host-gated');
});

test('maybeTakeOverHost writes hostUid once per room and re-arms if the write fails', () => {
    const start = SRC.indexOf('function maybeTakeOverHost(');
    assert.notEqual(start, -1, 'maybeTakeOverHost must exist in app.js');
    const body = SRC.slice(start, SRC.indexOf('function progressRoomClock('));
    assert.match(body, /RoomState\.shouldTakeOverHost\(/, 'the decision stays in the tested pure helper');
    assert.match(body, /state\.hostTakeoverForRoom/, 'keyed like the other clock writes: one write per room');
    assert.match(body, /hostUid:\s*state\.user\.uid/, 'the rules only allow naming YOURSELF');
    assert.match(body, /catch/, 'a refused takeover must re-arm, not wedge the guard forever');
});
