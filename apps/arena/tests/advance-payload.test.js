'use strict';

// nextRoomStateAfterQuestion: the ONE definition of "move the room on".
//
// WHY THIS FILE EXISTS (2026-09-12)
// ---------------------------------
// The Globe Drop Ready-skip used to run through the same runTransaction the
// timed advance uses, and that is two DEPENDENT RPCs on the Firestore SDK's
// single serialised async queue: BatchGetDocuments, then Commit issued from
// the read's continuation. Timed in the page on a starved two-core runner,
// the read answered in 0.1-0.2 s and the commit left 4.2 s later, with the
// main thread never blocked and no retry. The advance landed PAST the
// deadline it exists to beat, so the room sat out the full ten-second reveal
// that every player had just voted to skip.
//
// The fix splits the write, not the meaning: the Ready-skip (which fires
// strictly before questionOverMs(), where firestore.rules forbid any member
// from advancing, so only the host can write) does one updateDoc, and the
// timed advance keeps its transaction. Both build their payload HERE, so the
// two can never drift apart on what "the next question" is - which is the
// regression this file exists to prevent.
//
// The precondition is the other half. Inside the transaction it is checked
// against the freshly-read document; on the single-write path against the
// host's own listener copy. Same function, same answer, so a stale room can
// never be advanced by either path.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { nextRoomStateAfterQuestion, pickDecider } = require('../js/room-state.js');

const STAMP = { __serverTimestamp: true };
const globeRoom = (over = {}) => Object.assign({
    status: 'playing',
    gameType: 'globe-drop',
    currentQuestionIndex: 0,
    currentQuestionId: 'loc0',
    totalQuestions: 3,
    playedQuestionIds: [],
    questions: [{ id: 'loc0' }, { id: 'loc1' }, { id: 'loc2' }]
}, over);
const triviaRoom = (over = {}) => Object.assign({
    status: 'playing',
    gameType: 'trivia',
    currentQuestionIndex: 0,
    currentQuestionId: 'q0',
    totalQuestions: 3,
    playedQuestionIds: []
}, over);
const opts = (over = {}) => Object.assign({
    stamp: STAMP, finalRanking: [{ uid: 'a', score: 7 }], players: ['a', 'b']
}, over);

test('globe-drop: moves to the next location and stamps a fresh clock', () => {
    const out = nextRoomStateAfterQuestion(globeRoom(), opts());
    assert.deepEqual(out, {
        status: 'playing',
        currentQuestionIndex: 1,
        currentQuestionId: 'loc1',
        questionStartedAt: STAMP,
        revealStartedAt: null,
        playedQuestionIds: ['loc0']
    });
});

test('the played list accumulates and never duplicates', () => {
    const out = nextRoomStateAfterQuestion(
        globeRoom({ currentQuestionIndex: 1, currentQuestionId: 'loc1', playedQuestionIds: ['loc0'] }),
        opts({ expectedIndex: 1, expectedQuestionId: 'loc1' }));
    assert.deepEqual(out.playedQuestionIds, ['loc0', 'loc1']);
    const again = nextRoomStateAfterQuestion(
        globeRoom({ currentQuestionIndex: 1, currentQuestionId: 'loc1', playedQuestionIds: ['loc0', 'loc1'] }),
        opts({ expectedIndex: 1, expectedQuestionId: 'loc1' }));
    assert.deepEqual(again.playedQuestionIds, ['loc0', 'loc1']);
});

test('the LAST question finishes and leaves the index alone', () => {
    // firestore.rules read "status finished + index unchanged" as the finish
    // shape; advancing the index here would be denied as a bad advance.
    const room = globeRoom({ currentQuestionIndex: 2, currentQuestionId: 'loc2' });
    const out = nextRoomStateAfterQuestion(room, opts({ expectedIndex: 2, expectedQuestionId: 'loc2' }));
    assert.equal(out.status, 'finished');
    assert.equal(out.currentQuestionIndex, undefined, 'the index must not move on a finish');
    assert.equal(out.finishedAt, STAMP);
    assert.deepEqual(out.finalRanking, [{ uid: 'a', score: 7 }]);
});

test('trivia: re-enters picking and rotates the decider over the live players', () => {
    const out = nextRoomStateAfterQuestion(triviaRoom(), opts());
    assert.equal(out.status, 'picking');
    assert.equal(out.currentQuestionIndex, 1);
    assert.equal(out.currentQuestionId, null);
    assert.equal(out.questionStartedAt, null);
    assert.equal(out.pickingStartedAt, STAMP);
    assert.deepEqual(out.playerOrder, ['a', 'b']);
    assert.equal(out.deciderUid, pickDecider(['a', 'b'], 1));
});

// --- the precondition: the half that replaces the transaction's re-read ----

test('a room that is no longer playing does not advance', () => {
    for (const status of ['lobby', 'picking', 'finished']) {
        assert.equal(nextRoomStateAfterQuestion(globeRoom({ status }), opts()), null, status);
    }
});

test('a room that has already moved on does not advance again', () => {
    // The double-advance guard. The host fired for loc0; by the time the
    // write is built the room is on loc1, so the payload is null and the
    // location is not skipped.
    assert.equal(
        nextRoomStateAfterQuestion(
            globeRoom({ currentQuestionIndex: 1, currentQuestionId: 'loc1' }),
            opts({ expectedIndex: 0, expectedQuestionId: 'loc0' })),
        null);
});

test('a mismatched question id does not advance, even at the expected index', () => {
    assert.equal(
        nextRoomStateAfterQuestion(globeRoom({ currentQuestionId: 'somethingelse' }),
            opts({ expectedIndex: 0, expectedQuestionId: 'loc0' })),
        null);
});

test('an exhausted globe pool does not advance into nothing', () => {
    assert.equal(
        nextRoomStateAfterQuestion(globeRoom({ totalQuestions: 9, questions: [{ id: 'loc0' }] }), opts()),
        null);
});

test('missing room, missing options and an empty room are all no-ops, not throws', () => {
    assert.equal(nextRoomStateAfterQuestion(null, opts()), null);
    assert.equal(nextRoomStateAfterQuestion({}, opts()), null);
    // No stamp means no clock for the next round: refuse rather than write
    // `undefined` into questionStartedAt, which every deadline is read from.
    assert.equal(nextRoomStateAfterQuestion(globeRoom(), undefined), null);
    assert.equal(nextRoomStateAfterQuestion(globeRoom(), opts({ stamp: null })), null);
});

test('BOTH advance paths build byte-identical payloads from the same room', () => {
    // The transaction path feeds the freshly-read document; the Ready-skip
    // path feeds the host's listener copy. Same room, same options, so the
    // only difference between the two paths must be HOW the write is sent.
    const fromListener = nextRoomStateAfterQuestion(globeRoom(), opts());
    const fromTransactionRead = nextRoomStateAfterQuestion(globeRoom(), opts());
    assert.deepEqual(fromListener, fromTransactionRead);
});

// --- the race, deterministically ------------------------------------------
//
// What the transaction used to buy, and what the precondition has to buy
// instead: two clients acting on the room they last SAW can never skip a
// location or replay one. This models that directly, at every interleaving,
// which is better evidence of race stability than repeat runs of a
// ten-minute end-to-end scenario (and it runs in milliseconds).
test('interleaved advances from stale views can never skip or replay a location', () => {
    const TOTAL = 6;
    const pool = Array.from({ length: TOTAL }, (_, i) => ({ id: `loc${i}` }));

    // Every ordering of "client X decided at index i, its write lands k steps
    // later", exhaustively over a small space.
    for (let lag = 0; lag <= 3; lag += 1) {
        for (let clients = 1; clients <= 3; clients += 1) {
            let room = {
                status: 'playing', gameType: 'globe-drop', totalQuestions: TOTAL,
                currentQuestionIndex: 0, currentQuestionId: 'loc0',
                playedQuestionIds: [], questions: pool
            };
            const applied = [];
            // Each client holds a view that may be `lag` writes behind.
            const views = Array.from({ length: clients }, () => room);
            for (let step = 0; step < TOTAL * 4 && room.status === 'playing'; step += 1) {
                const who = step % clients;
                const view = views[who];
                const payload = nextRoomStateAfterQuestion(view, opts({
                    expectedQuestionId: view.currentQuestionId,
                    expectedIndex: view.currentQuestionIndex || 0
                }));
                if (payload) {
                    // A write only lands if the room still matches what the
                    // payload was built from; that is the precondition both
                    // paths share, and it is what the server sees.
                    const fresh = nextRoomStateAfterQuestion(room, opts({
                        expectedQuestionId: view.currentQuestionId,
                        expectedIndex: view.currentQuestionIndex || 0
                    }));
                    if (fresh) {
                        room = Object.assign({}, room, payload);
                        applied.push(payload.currentQuestionIndex);
                    }
                }
                // Refresh views, some of them staler than others.
                for (let c = 0; c < clients; c += 1) {
                    if ((step + c) % (lag + 1) === 0) views[c] = room;
                }
            }
            const moves = applied.filter((i) => typeof i === 'number');
            const label = `clients=${clients} lag=${lag}`;
            assert.deepEqual(moves, [...new Set(moves)], `${label}: an index was written twice`);
            assert.deepEqual(moves, [...moves].sort((a, b) => a - b), `${label}: indexes went backwards`);
            for (let i = 1; i < moves.length; i += 1) {
                assert.equal(moves[i], moves[i - 1] + 1, `${label}: skipped from ${moves[i - 1]} to ${moves[i]}`);
            }
            assert.deepEqual(
                room.playedQuestionIds, [...new Set(room.playedQuestionIds)],
                `${label}: a location was recorded as played twice`);
        }
    }
});
