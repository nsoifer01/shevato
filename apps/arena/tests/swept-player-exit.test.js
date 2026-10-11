'use strict';

// A player the host swept was never told.
//
// WHY: the host's sweepStalePlayers deletes the player doc of anyone
// backgrounded past PRESENCE_STALE_MS. In a scoped room that ends the
// player's membership, so the rules start refusing their reads and both room
// listeners die. Neither onSnapshot had an error callback, so the screen just
// froze. Worse, both answer transactions returned (resolved as success) when
// their own doc was missing, so the UI said "Locked in" for an answer that
// was never recorded anywhere.
//
// The exit has to be narrow: a normal room close is the room doc's own
// "Room closed." path, an own leave unsubscribes before deleting the doc, and
// the first (possibly empty) roster fill must never read as a removal.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { selfRemovedFromRoom } = require('../js/room-state.js');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'js', 'app.js'), 'utf8');

const me = { uid: 'me' };
const other = { uid: 'b' };

test('selfRemovedFromRoom: own doc vanishing mid-game is a removal', () => {
    assert.equal(selfRemovedFromRoom([me, other], [other], 'me', 'playing'), true);
    // The sweep runs while playing; the snapshot may land after the room moved on.
    assert.equal(selfRemovedFromRoom([me, other], [other], 'me', 'picking'), true);
});

test('selfRemovedFromRoom: the first fill never counts', () => {
    assert.equal(selfRemovedFromRoom([], [other], 'me', 'playing'), false);
    assert.equal(selfRemovedFromRoom(undefined, [], 'me', 'playing'), false);
});

test('selfRemovedFromRoom: outside the game stages it is not a removal', () => {
    for (const status of ['lobby', 'finished', undefined]) {
        assert.equal(selfRemovedFromRoom([me, other], [other], 'me', status), false, String(status));
    }
});

test('selfRemovedFromRoom: someone else leaving is not my removal', () => {
    assert.equal(selfRemovedFromRoom([me, other], [me], 'me', 'playing'), false);
    assert.equal(selfRemovedFromRoom([me], [me], 'me', 'playing'), false);
    assert.equal(selfRemovedFromRoom([me], [], null, 'playing'), false);
});

function enterRoomBody() {
    const start = SRC.indexOf('function enterRoom(code) {');
    assert.notEqual(start, -1, 'enterRoom must still be a top-level function in app.js');
    const end = SRC.indexOf('\n}\n', start);
    return SRC.slice(start, end);
}

test('enterRoom: both room listeners leave the room when they error', () => {
    const body = enterRoomBody();
    const errorCallbacks = body.match(/\}, removedFromRoom\)\);/g) || [];
    assert.equal(errorCallbacks.length, 2, 'room doc and players listeners both need the error exit');
    assert.match(body, /RoomState\.selfRemovedFromRoom\(/);
    assert.match(body, /leaveRoom\(\{ silent: true, reason \}\)/);
});

test('answer transactions throw, not resolve, when the player doc is gone', () => {
    assert.doesNotMatch(SRC, /tx\.get\(pref\);\s*if \(!snap\.exists\(\)\) return;/,
        'a transaction that returns on a missing doc resolves as success');
    const throws = SRC.match(/tx\.get\(pref\);[\s\S]{0,200}?if \(!snap\.exists\(\)\) throw /g) || [];
    assert.equal(throws.length, 2, 'submitGuess and submitAnswer both throw');
});
