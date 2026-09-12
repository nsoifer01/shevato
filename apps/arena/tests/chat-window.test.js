'use strict';

// Room chat froze permanently once a room passed 80 messages.
//
// WHY: the subscription was built as
//     query(chatRef, orderBy('sentAt', 'asc'), limit(80))
// and ascending + `limit` is the FIRST 80 documents, not the last. Once the
// 81st message existed the window was pinned on the OLDEST 80 and no new
// message ever rendered again, for anybody in the room, for the life of the
// room. Eight one-tap emoji buttons at a 1.5 s rate limit means six players
// reach 80 in about a minute, so this was reachable in a single sitting, and
// the panel's own comment claimed it kept "the latest ~80".
//
// Two things have to hold together, and both are pinned here:
//  1. the query selects the LATEST window, still delivered oldest-first so
//     the rendered list reads chronologically;
//  2. the unread / notify bookkeeping is identity-based, not length-based.
//     A full window has a CONSTANT length, so `prevLen < messages.length`
//     (the notify guard) and `messages.length - unreadSince` (the badge)
//     are both permanently 0 the moment the window starts sliding instead
//     of growing. Fixing the query alone would have traded a frozen chat
//     for a silent one.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    CHAT_WINDOW_SIZE,
    buildChatWindowQuery,
    unreadCount
} = require('../js/chat.js');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'js', 'app.js'), 'utf8');

/**
 * A fake Firestore that actually EVALUATES the constraints it is handed, so
 * these tests fail on the behaviour (oldest 80 vs newest 80) rather than on
 * the spelling of the call. `limit` is deliberately implemented as the real
 * thing does it - the first n of the ordered set - because that is the whole
 * bug.
 */
function fakeFirestore() {
    const used = [];
    return {
        used,
        query(ref, ...constraints) {
            let docs = ref.docs.slice();
            for (const c of constraints) {
                if (c.type === 'orderBy') {
                    docs.sort((a, b) => a[c.field] - b[c.field]);
                    if (c.dir === 'desc') docs.reverse();
                } else if (c.type === 'limit') {
                    docs = docs.slice(0, c.n);   // FIRST n of the ordered set
                } else if (c.type === 'limitToLast') {
                    docs = docs.slice(-c.n);     // LAST n, order preserved
                }
            }
            return docs;
        },
        orderBy(field, dir) { used.push('orderBy'); return { type: 'orderBy', field, dir: dir || 'asc' }; },
        limit(n) { used.push('limit'); return { type: 'limit', n }; },
        limitToLast(n) { used.push('limitToLast'); return { type: 'limitToLast', n }; }
    };
}

// One more message than the window holds, so the window must slide.
function seededChat(count) {
    const docs = [];
    for (let i = 1; i <= count; i++) docs.push({ id: 'm' + i, sentAt: i });
    return { docs };
}

// --- the window itself ------------------------------------------------

test('buildChatWindowQuery observes the NEWEST window, not the oldest (the freeze)', () => {
    const fns = fakeFirestore();
    const total = CHAT_WINDOW_SIZE + 25;
    const out = buildChatWindowQuery(seededChat(total), fns);

    assert.equal(out.length, CHAT_WINDOW_SIZE, 'window is capped at CHAT_WINDOW_SIZE');
    assert.equal(out[out.length - 1].id, 'm' + total,
        'the newest message must be inside the window - with `limit` it never is again past the cap');
    assert.equal(out[0].id, 'm' + (total - CHAT_WINDOW_SIZE + 1),
        'the window starts at the newest-minus-cap message, so it slides with the room');
});

test('buildChatWindowQuery still delivers the window oldest-first (rendered order is chronological)', () => {
    const fns = fakeFirestore();
    const out = buildChatWindowQuery(seededChat(CHAT_WINDOW_SIZE + 5), fns);
    const times = out.map((d) => d.sentAt);
    assert.deepEqual(times, times.slice().sort((a, b) => a - b),
        'renderChatMessages paints the array in order and must not have to reverse it');
});

test('buildChatWindowQuery does not use a plain `limit` on an ascending order', () => {
    const fns = fakeFirestore();
    buildChatWindowQuery(seededChat(10), fns);
    assert.equal(fns.used.includes('limit'), false,
        'ascending + limit is the oldest n, which is exactly the defect');
    assert.equal(fns.used.includes('limitToLast'), true);
});

test('a short room is unaffected: everything is in the window, still in order', () => {
    const fns = fakeFirestore();
    const out = buildChatWindowQuery(seededChat(3), fns);
    assert.deepEqual(out.map((d) => d.id), ['m1', 'm2', 'm3']);
});

// --- unread bookkeeping across a sliding window -----------------------

test('unreadCount counts messages after the last-read one', () => {
    const msgs = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    assert.equal(unreadCount(msgs, 'c'), 0, 'caught up');
    assert.equal(unreadCount(msgs, 'b'), 1);
    assert.equal(unreadCount(msgs, 'a'), 2);
});

test('unreadCount treats a full, SLIDING window as unread (the badge that stopped moving)', () => {
    // The read marker has scrolled out of the window: the panel has been
    // closed long enough that every message it last showed is gone. Length
    // has not changed - it is pinned at the cap - so the old
    // `messages.length - unreadSince` arithmetic reported 0 unread forever.
    const msgs = [];
    for (let i = 0; i < CHAT_WINDOW_SIZE; i++) msgs.push({ id: 'm' + i });
    assert.equal(unreadCount(msgs, 'scrolled-off-the-window'), CHAT_WINDOW_SIZE,
        'everything still held is unread when the marker is gone');
});

test('unreadCount with no marker yet is everything; an empty room is zero', () => {
    assert.equal(unreadCount([{ id: 'a' }, { id: 'b' }], null), 2);
    assert.equal(unreadCount([], 'a'), 0);
    assert.equal(unreadCount(null, 'a'), 0);
});

// --- the call site ----------------------------------------------------
//
// app.js is a browser module that touches the DOM at import time, so the
// listener is read out of source. What is pinned is that the seam above is
// the one thing building the chat query, and that the length-based guards
// that a sliding window silently disables are gone.

test('startChatListener builds its query through the tested seam', () => {
    const start = SRC.indexOf('function startChatListener(');
    assert.notEqual(start, -1, 'startChatListener must still exist in app.js');
    const body = SRC.slice(start, SRC.indexOf('function stopChatListener('));
    assert.match(body, /Chat\.buildChatWindowQuery\(/,
        'the chat window must come from chat.js, not be hand-rolled at the call site');
    assert.doesNotMatch(body, /\blimit\(/,
        'a bare limit() here is the oldest-n bug coming back');
    assert.doesNotMatch(body, /prevLen/,
        'a length comparison cannot detect a new message once the window is full');
    assert.match(body, /prevIds\.has\(newest\.id\)/,
        'the notify guard is identity-based, which also keeps a SHRINKING window '
        + '(the orphan sweep deleting chat as the room closes) from toasting an older message');
});
