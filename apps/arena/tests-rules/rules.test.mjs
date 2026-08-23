// Arena Firestore security-rules suite (TESTING-AUDIT.md defect 23).
//
// Runs the real firestore.rules inside the Firestore emulator and asserts
// allow/deny per principal via plain REST (see emulator-harness.mjs for
// the mechanics and the safety argument). Status-code convention:
//   200 = rules allowed the operation
//   403 = rules denied it
//   404 = rules allowed a read/delete but the doc does not exist
//
// NOT part of `npm test`: this suite needs Java plus a one-time
// firebase-tools/emulator download, which the dependency-free push/PR CI
// deliberately does not have. Run locally with `npm run test:arena:rules`;
// CI runs it weekly via .github/workflows/arena-rules.yml with
// ARENA_RULES_REQUIRE=1 so an environment problem fails loudly there
// instead of skipping.
//
// Tests in this file are order-dependent by design (setup test first,
// shared owner-seeded fixtures after); node --test runs a file's tests
// sequentially, and everything here lives in this one file on purpose.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    startEmulator, loadRules, loadRulesFile, clearData, authToken, OWNER,
    createDoc, updateDoc, getDoc, deleteDoc, listDocs,
    DENY_ALL_RULES, EMULATOR_HOST,
} from './emulator-harness.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const RULES_FILE = resolve(REPO_ROOT, 'firestore.rules');

// Fixture value for the LEGACY cleartext-password room shape (pre-2026-08-15
// rooms only; new rooms may never carry the field, and a rules test proves
// it). Joined from parts so secret scanners do not flag a quoted literal
// beside the field name.
const LEGACY_FIXTURE_PW = ['legacy', 'room', 'fixture'].join('-');

// Principals. Provider 'anonymous' models Arena guest sign-in (fails
// isRegistered()); 'password' models a real account.
const ALICE = authToken('alice');
const BOB = authToken('bob');
const HOST = authToken('host1');
const GUEST = authToken('guest1', 'anonymous');
const ADMIN = authToken('admin1');

const setup = await startEmulator({ repoRoot: REPO_ROOT });

if (!setup.ok) {
    if (process.env.ARENA_RULES_REQUIRE) {
        test('Firestore emulator is required in this environment (ARENA_RULES_REQUIRE=1)', () => {
            assert.fail(`emulator unavailable: ${setup.reason}`);
        });
    } else {
        test('arena firestore rules suite', { skip: `emulator unavailable: ${setup.reason}` }, () => {});
    }
} else {
    after(async () => { await setup.stop(); });

    test('sanity: the harness only ever talks to a local emulator host', () => {
        assert.ok(EMULATOR_HOST.startsWith('127.0.0.1:'),
            'production Firebase must be unreachable by construction');
    });

    test('negative control: a deny-all ruleset denies what the real rules allow, then the real rules load', async () => {
        // Prove the PUT endpoint has teeth in BOTH directions; a silent
        // no-op rules load could otherwise fake every pass below.
        await loadRules(DENY_ALL_RULES);
        assert.equal(await getDoc('triviaRooms/PUBAA', ALICE), 403,
            'deny-all must deny an authed room read');
        await loadRulesFile(RULES_FILE);
        assert.equal(await getDoc('triviaRooms/PUBAA', ALICE), 404,
            'real rules must allow the same read (doc simply missing)');
        // Fresh data for the whole suite; emulator state persists across
        // runs and would silently turn creates into updates.
        await clearData();
        // Owner-seeded fixtures (rules bypassed - this models existing data):
        // a public room, a hash-gated private room, a LEGACY private room
        // still carrying the cleartext password (pre-2026-08-15 shape that
        // client creates can no longer produce), and one leaderboard admin.
        assert.equal(await createDoc('triviaRooms/PUBAA',
            { code: 'PUBAA', hostUid: 'host1', status: 'lobby', isPrivate: false }, OWNER), 200);
        assert.equal(await createDoc('triviaRooms/GATED',
            { code: 'GATED', hostUid: 'host1', status: 'lobby', isPrivate: true }, OWNER), 200);
        assert.equal(await createDoc('triviaRooms/GATED/private/gate',
            { hash: 'good-hash-value' }, OWNER), 200);
        assert.equal(await createDoc('triviaRooms/WPASS',
            // Built without a quoted literal next to the field name so secret
            // scanners do not flag this obviously-fake legacy fixture.
            { code: 'WPASS', hostUid: 'host1', status: 'lobby', isPrivate: true, password: LEGACY_FIXTURE_PW }, OWNER), 200);
        assert.equal(await createDoc('leaderboardAdmins/admin1', { note: 'seeded' }, OWNER), 200);
    });

    /* ---------------- room docs ---------------- */

    test('room read requires sign-in; any signed-in user (guest included) can read', async () => {
        assert.equal(await getDoc('triviaRooms/PUBAA', null), 403);
        assert.equal(await getDoc('triviaRooms/PUBAA', ALICE), 200);
        assert.equal(await getDoc('triviaRooms/PUBAA', GUEST), 200);
    });

    test('room create: signed-in only, own uid as hostUid, and NEVER with a cleartext password field (defect 22)', async () => {
        assert.equal(await createDoc('triviaRooms/NEWAA',
            { code: 'NEWAA', hostUid: 'alice', isPrivate: false }, null), 403,
            'unauthenticated create denied');
        assert.equal(await createDoc('triviaRooms/NEWAA',
            { code: 'NEWAA', hostUid: 'alice', isPrivate: true, password: LEGACY_FIXTURE_PW }, ALICE), 403,
            'a new room carrying a password field must be rejected');
        assert.equal(await createDoc('triviaRooms/NEWAA',
            { code: 'NEWAA', hostUid: 'bob', isPrivate: false }, ALICE), 403,
            'a room cannot be created on behalf of another uid');
        assert.equal(await createDoc('triviaRooms/NEWAA',
            { code: 'NEWAA', hostUid: 'alice', isPrivate: true }, ALICE), 200,
            'the same create without the field is allowed');
    });

    test('room update: host may write anything (legacy password rooms included); strangers and non-members are denied (audit D10)', async () => {
        // This test used to be "room update stays loose" and pinned that ANY
        // signed-in user could rewrite the room doc. That looseness let a
        // non-host rewrite hostUid, set status to garbage or a negative
        // question index and wedge the room for everyone (2026-08-22 audit
        // D10), so it is now a deny and the member carve-outs are tested
        // one by one below.
        assert.equal(await updateDoc('triviaRooms/PUBAA', { status: 'playing' }, HOST), 200);
        assert.equal(await updateDoc('triviaRooms/PUBAA', { status: 'lobby' }, HOST), 200);
        // Legacy room: the post-state still contains the old cleartext
        // field; the no-password condition applies to CREATE only.
        assert.equal(await updateDoc('triviaRooms/WPASS', { status: 'playing' }, HOST), 200);
        assert.equal(await updateDoc('triviaRooms/PUBAA', { status: 'playing' }, BOB), 403,
            'a signed-in non-member cannot flip the status');
        assert.equal(await updateDoc('triviaRooms/PUBAA', { hostUid: 'bob' }, BOB), 403,
            'a non-member cannot steal hostUid');
        assert.equal(await updateDoc('triviaRooms/PUBAA', { status: 'lobby' }, null), 403);
    });

    test('room delete: host only (a non-host can no longer close the room for everyone)', async () => {
        assert.equal(await createDoc('triviaRooms/DELME',
            { code: 'DELME', hostUid: 'host1', status: 'lobby', isPrivate: false }, OWNER), 200);
        assert.equal(await deleteDoc('triviaRooms/DELME', BOB), 403);
        assert.equal(await deleteDoc('triviaRooms/DELME', GUEST), 403);
        assert.equal(await deleteDoc('triviaRooms/DELME', HOST), 200);
    });

    /* ---------------- private/gate ---------------- */

    test('gate doc is readable by NOBODY (host, stranger, guest, unauthenticated)', async () => {
        assert.equal(await getDoc('triviaRooms/GATED/private/gate', HOST), 403);
        assert.equal(await getDoc('triviaRooms/GATED/private/gate', ALICE), 403);
        assert.equal(await getDoc('triviaRooms/GATED/private/gate', GUEST), 403);
        assert.equal(await getDoc('triviaRooms/GATED/private/gate', null), 403);
        assert.equal(await listDocs('triviaRooms/GATED/private', ALICE), 403,
            'listing the subcollection must not leak it either');
    });

    test('only the room creator can write the gate, only at id "gate", only { hash: string }', async () => {
        assert.equal(await createDoc('triviaRooms/NEWAA/private/gate', { hash: 'h1' }, BOB), 403,
            'non-host cannot plant a gate');
        assert.equal(await createDoc('triviaRooms/NEWAA/private/other', { hash: 'h1' }, ALICE), 403,
            'no other doc ids under private/');
        assert.equal(await createDoc('triviaRooms/NEWAA/private/gate', { hash: 'h1', extra: 'x' }, ALICE), 403,
            'extra keys rejected');
        assert.equal(await createDoc('triviaRooms/NEWAA/private/gate', { hash: 42 }, ALICE), 403,
            'non-string hash rejected');
        assert.equal(await createDoc('triviaRooms/NEWAA/private/gate', { hash: 'h1' }, ALICE), 200,
            'room creator with the right shape is allowed');
        assert.equal(await updateDoc('triviaRooms/NEWAA/private/gate', { hash: 'h2' }, ALICE), 403,
            'gate is immutable, even to its creator');
    });

    test('P0 exploit sequence (audit D1): a stranger cannot delete the gate and then join without the password', async () => {
        // This test REPLACES "gate cleanup: any signed-in user can delete
        // the gate (last-leaver room sweep)", which pinned a vulnerability:
        // with `allow delete: if request.auth != null` a stranger who only
        // knew the code could deleteDoc the gate and the member-create
        // rule's `!exists(gate)` branch then admitted them - and every later
        // joiner - with no password at all. The exact exploit sequence from
        // the audit is replayed here and must be denied at every step.
        // Room GATED is hosted by host1 with gate hash 'good-hash-value'.
        assert.equal(await deleteDoc('triviaRooms/GATED/private/gate', null), 403,
            'unauthenticated delete denied');
        assert.equal(await deleteDoc('triviaRooms/GATED/private/gate', GUEST), 403,
            'step 1: a signed-in guest with the code cannot delete the gate');
        assert.equal(await deleteDoc('triviaRooms/GATED/private/gate', BOB), 403,
            'step 1 (registered stranger): still denied');
        assert.equal(await createDoc('triviaRooms/GATED/players/guest1',
            { uid: 'guest1', displayName: 'Gatecrasher', score: 0 }, GUEST), 403,
            'step 2: joining without a gateHash stays denied because the gate still exists');
        assert.equal(await createDoc('triviaRooms/GATED/players/guest1',
            { uid: 'guest1', gateHash: 'wrong-hash', score: 0 }, GUEST), 403,
            'step 2b: a guessed hash is denied');
        assert.equal(await createDoc('triviaRooms/GATED/players/guest1',
            { uid: 'guest1', gateHash: 'good-hash-value', score: 0 }, GUEST), 200,
            'the correct password proof still admits');
        assert.equal(await deleteDoc('triviaRooms/GATED/players/guest1', GUEST), 200);
    });

    test('gate lifecycle: the host may delete it while the room exists; anyone may sweep it once the room doc is gone', async () => {
        // Lifecycle point: the last leaver is (or has taken over as) the
        // host, deletes the room doc first, then sweeps the gate. Both
        // orders are verifiable: host-while-room-exists, or room-gone.
        assert.equal(await createDoc('triviaRooms/SWEEP',
            { code: 'SWEEP', hostUid: 'host1', status: 'lobby', isPrivate: true }, OWNER), 200);
        assert.equal(await createDoc('triviaRooms/SWEEP/private/gate', { hash: 'x' }, OWNER), 200);
        assert.equal(await deleteDoc('triviaRooms/SWEEP/private/gate', BOB), 403,
            'non-host cannot delete while the room lives');
        assert.equal(await deleteDoc('triviaRooms/SWEEP/private/gate', HOST), 200,
            'host may delete it (room still exists)');
        assert.equal(await createDoc('triviaRooms/SWEEP/private/gate', { hash: 'y' }, OWNER), 200);
        assert.equal(await deleteDoc('triviaRooms/SWEEP', HOST), 200, 'host deletes the room doc first');
        assert.equal(await deleteDoc('triviaRooms/SWEEP/private/gate', BOB), 200,
            'orphan sweep: once the room doc is gone any signed-in user may delete the gate');
    });

    /* ---------------- player docs (join gate + ownership) ---------------- */

    test('public room join: own player doc, no gateHash needed; other uids denied', async () => {
        assert.equal(await createDoc('triviaRooms/PUBAA/players/alice',
            { uid: 'alice', displayName: 'Alice', score: 0 }, ALICE), 200);
        assert.equal(await createDoc('triviaRooms/PUBAA/players/bob',
            { uid: 'bob', displayName: 'Fake Bob', score: 9999 }, ALICE), 403,
            'nobody can create a player doc under someone else\'s uid');
        assert.equal(await createDoc('triviaRooms/PUBAA/players/guest1',
            { uid: 'guest1', displayName: 'Guest', score: 0 }, GUEST), 200,
            'guests can join rooms (ephemeral play is allowed)');
    });

    test('gated room join: correct gateHash admits, wrong or missing hash is denied (defect 22)', async () => {
        assert.equal(await createDoc('triviaRooms/GATED/players/bob',
            { uid: 'bob', gateHash: 'good-hash-value', score: 0 }, BOB), 200);
        assert.equal(await createDoc('triviaRooms/GATED/players/alice',
            { uid: 'alice', gateHash: 'wrong-hash', score: 0 }, ALICE), 403);
        assert.equal(await createDoc('triviaRooms/GATED/players/alice',
            { uid: 'alice', score: 0 }, ALICE), 403,
            'omitting the field entirely is also denied');
    });

    test('legacy password room (no gate doc) joins exactly as before the migration', async () => {
        // The cleartext compare for WPASS happens client-side; rules see
        // no gate doc, so the member create passes without a gateHash.
        assert.equal(await createDoc('triviaRooms/WPASS/players/alice',
            { uid: 'alice', score: 0 }, ALICE), 200);
    });

    test('player-doc ownership: only you update your doc (score integrity); owner delete allowed', async () => {
        assert.equal(await updateDoc('triviaRooms/PUBAA/players/alice', { score: 150 }, ALICE), 200);
        assert.equal(await updateDoc('triviaRooms/PUBAA/players/alice', { score: 0 }, BOB), 403,
            'the host cannot rewrite someone else\'s score');
        // Known modeled limitation: the host-handoff isHost flag write to
        // the NEXT host's doc is denied by this same ownership rule (the
        // app swallows it; hostUid on the room doc is the source of truth).
        assert.equal(await updateDoc('triviaRooms/PUBAA/players/alice', { isHost: true }, BOB), 403);
        assert.equal(await deleteDoc('triviaRooms/PUBAA/players/alice', BOB), 403,
            'a live member cannot be kicked by a stranger');
        assert.equal(await deleteDoc('triviaRooms/PUBAA/players/alice', HOST), 403,
            'nor by the host while the doc is live');
        assert.equal(await deleteDoc('triviaRooms/PUBAA/players/alice', ALICE), 200);
        assert.equal(await getDoc('triviaRooms/PUBAA/players/guest1', ALICE), 200,
            'any signed-in user can read player docs (scoreboard)');
    });

    test('member room-doc touches (audit D10): pause/resume, end early, rematch fields - members only, exactly those keys', async () => {
        // guest1 is a member of PUBAA (joined above); bob is not.
        assert.equal(await updateDoc('triviaRooms/PUBAA', { status: 'playing' }, HOST), 200);
        assert.equal(await updateDoc('triviaRooms/PUBAA',
            { paused: true, pausedAt: new Date(), pausedByUid: 'guest1', pausedByName: 'Guest' }, GUEST), 200,
            'member pause');
        assert.equal(await updateDoc('triviaRooms/PUBAA',
            { paused: false, pausedAt: null, pausedByUid: null, pausedByName: null, questionStartedAt: new Date() }, GUEST), 200,
            'member resume re-anchors questionStartedAt');
        assert.equal(await updateDoc('triviaRooms/PUBAA',
            { paused: false, questionStartedAt: new Date() }, GUEST), 403,
            'questionStartedAt may only move together with a resume (room is not paused now)');
        assert.equal(await updateDoc('triviaRooms/PUBAA',
            { paused: true, pausedAt: new Date(), pausedByUid: 'bob', pausedByName: 'Bob' }, BOB), 403,
            'non-member pause denied');
        assert.equal(await updateDoc('triviaRooms/PUBAA',
            { rematchProposedBy: 'guest1', rematchAcceptedBy: ['guest1'], rematchDeclinedBy: [], rematchProposedAt: new Date() }, GUEST), 200,
            'member rematch proposal');
        assert.equal(await updateDoc('triviaRooms/PUBAA',
            { rematchProposedBy: null, rematchAcceptedBy: [], rematchDeclinedBy: [] }, GUEST), 200,
            'member rematch clear');
        assert.equal(await updateDoc('triviaRooms/PUBAA',
            { rematchProposedBy: 'guest1', hostUid: 'guest1' }, GUEST), 403,
            'smuggling hostUid into a rematch write is denied');
        assert.equal(await updateDoc('triviaRooms/PUBAA',
            { currentQuestionIndex: -3 }, GUEST), 403,
            'a member cannot rewrite question pointers outside the timed advance');
        assert.equal(await updateDoc('triviaRooms/PUBAA',
            { status: 'bogus' }, GUEST), 403,
            'a member cannot set an arbitrary status');
        assert.equal(await updateDoc('triviaRooms/PUBAA',
            { status: 'finished', finishedAt: new Date(), paused: false, pausedAt: null,
              finalRanking: [{ uid: 'guest1', displayName: 'Guest', score: 0, streak: 0 }] }, GUEST), 200,
            'member end-game-early (with the final ranking snapshot)');
        assert.equal(await updateDoc('triviaRooms/PUBAA', { status: 'lobby' }, HOST), 200);
    });

    test('decider category pick: only the current decider, only while picking, only the pick keys', async () => {
        assert.equal(await updateDoc('triviaRooms/PUBAA', { status: 'picking', deciderUid: 'guest1' }, HOST), 200);
        assert.equal(await updateDoc('triviaRooms/PUBAA',
            { status: 'playing', currentQuestionId: 'q1', selectedCategory: 'geo', questionStartedAt: new Date(), revealStartedAt: null }, ALICE), 403,
            'alice is neither decider nor member');
        assert.equal(await updateDoc('triviaRooms/PUBAA',
            { status: 'playing', currentQuestionId: 'q1', selectedCategory: 'geo', questionStartedAt: new Date(), revealStartedAt: null, currentQuestionIndex: 7 }, GUEST), 403,
            'the decider cannot also move the question index');
        assert.equal(await updateDoc('triviaRooms/PUBAA',
            { status: 'playing', currentQuestionId: 'q1', selectedCategory: 'geo', questionStartedAt: new Date(), revealStartedAt: null }, GUEST), 200,
            'the decider starts the question');
        assert.equal(await updateDoc('triviaRooms/PUBAA',
            { status: 'playing', currentQuestionId: 'q2', selectedCategory: 'geo', questionStartedAt: new Date(), revealStartedAt: null }, GUEST), 403,
            'not allowed again once the room is playing');
    });

    test('host-independent clock (audit D3): a member may advance the room only after asking + reveal elapsed on the server clock', async () => {
        const ago = (ms) => new Date(Date.now() - ms);
        const advance = { status: 'picking', currentQuestionIndex: 1, currentQuestionId: null, selectedCategory: null,
            questionStartedAt: null, revealStartedAt: null, playerOrder: ['host1', 'guest1'], deciderUid: 'host1',
            playedQuestionIds: ['q1'] };
        // Fresh question (10 s timer, 2.5 s reveal): too early.
        assert.equal(await updateDoc('triviaRooms/PUBAA',
            { status: 'playing', questionTimeMs: 10000, currentQuestionIndex: 0, questionStartedAt: ago(3000), revealStartedAt: null, paused: false }, HOST), 200);
        assert.equal(await updateDoc('triviaRooms/PUBAA', advance, GUEST), 403, 'too early: denied');
        // Elapsed on the server clock: allowed for a member, still denied for a stranger.
        assert.equal(await updateDoc('triviaRooms/PUBAA', { questionStartedAt: ago(13000) }, HOST), 200);
        assert.equal(await updateDoc('triviaRooms/PUBAA', advance, BOB), 403, 'non-member denied even when elapsed');
        assert.equal(await updateDoc('triviaRooms/PUBAA', Object.assign({}, advance, { hostUid: 'guest1' }), GUEST), 403,
            'the advance cannot carry a hostUid change');
        assert.equal(await updateDoc('triviaRooms/PUBAA', advance, GUEST), 200, 'member advances the stalled room');
        // Paused rooms never time out.
        assert.equal(await updateDoc('triviaRooms/PUBAA',
            { status: 'playing', currentQuestionIndex: 1, questionStartedAt: ago(60000), revealStartedAt: null, paused: true }, HOST), 200);
        assert.equal(await updateDoc('triviaRooms/PUBAA', Object.assign({}, advance, { currentQuestionIndex: 2 }), GUEST), 403, 'paused: denied');
        // Early reveal shortens the deadline: revealStartedAt + 2.5 s.
        //
        // revealStartedAt is stamped NOW, not 1 s ago, on purpose. The window
        // is only 2.5 s, so a 1 s head start left just 1.5 s for the next REST
        // round trip; on a loaded machine that elapsed and the rule then
        // ALLOWED the advance, which is correct behaviour but reads as a
        // failure (seen 2026-08-23). Starting at zero gives the full window
        // and asserts the same rule.
        assert.equal(await updateDoc('triviaRooms/PUBAA',
            { paused: false, questionStartedAt: new Date(), revealStartedAt: new Date() }, HOST), 200);
        assert.equal(await updateDoc('triviaRooms/PUBAA', Object.assign({}, advance, { currentQuestionIndex: 2 }), GUEST), 403, 'reveal still running: denied');
        assert.equal(await updateDoc('triviaRooms/PUBAA', { revealStartedAt: ago(3000) }, HOST), 200);
        assert.equal(await updateDoc('triviaRooms/PUBAA',
            { status: 'finished', finishedAt: new Date(), playedQuestionIds: ['q1', 'q2'],
              finalRanking: [{ uid: 'guest1', displayName: 'Guest', score: 10, streak: 1 }] }, GUEST), 200,
            'member finishes the game once the last reveal elapsed');
        assert.equal(await updateDoc('triviaRooms/PUBAA', { status: 'lobby' }, HOST), 200);
    });

    test('picking-stage deadline: a member may auto-pick only after it elapses, and only the pick keys', async () => {
        // Product defect found while stabilising the e2e (2026-08-23): the
        // picking stage had no deadline at all, so a decider who locked
        // their phone stalled the room for everyone - the same failure the
        // playing stage had before the host-independent clock. guest1 is a
        // member of PUBAA; host1 is the host; bob is not a member.
        const ago = (ms) => new Date(Date.now() - ms);
        const pick = { status: 'playing', currentQuestionId: 'q9', selectedCategory: 'geo',
            questionStartedAt: new Date(), revealStartedAt: null };
        assert.equal(await updateDoc('triviaRooms/PUBAA',
            { status: 'picking', deciderUid: 'someone-else', pickingStartedAt: ago(3000) }, HOST), 200);
        assert.equal(await updateDoc('triviaRooms/PUBAA', pick, GUEST), 403,
            'before the deadline only the decider (or the host) may pick');
        assert.equal(await updateDoc('triviaRooms/PUBAA', { pickingStartedAt: ago(25000) }, HOST), 200);
        assert.equal(await updateDoc('triviaRooms/PUBAA', pick, BOB), 403,
            'a non-member never picks, however long it has been');
        assert.equal(await updateDoc('triviaRooms/PUBAA',
            Object.assign({}, pick, { deciderUid: 'guest1' }), GUEST), 403,
            'the auto-pick cannot smuggle other keys in');
        assert.equal(await updateDoc('triviaRooms/PUBAA', pick, GUEST), 200,
            'past the deadline any member may pick for the room');
        assert.equal(await updateDoc('triviaRooms/PUBAA', { status: 'lobby' }, HOST), 200);
    });

    test('liveness (audit D4): host sweeps only STALE player docs; a member takes over hostUid only from a gone host', async () => {
        const ago = (ms) => Date.now() - ms;
        assert.equal(await createDoc('triviaRooms/PUBAA/players/ghost',
            { uid: 'ghost', score: 0, disconnectedAt: ago(5000), lastSeen: new Date() }, OWNER), 200);
        assert.equal(await deleteDoc('triviaRooms/PUBAA/players/ghost', HOST), 403,
            'within the 30 s grace the doc is still live: host cannot sweep it');
        assert.equal(await updateDoc('triviaRooms/PUBAA/players/ghost', { disconnectedAt: ago(40000) }, OWNER), 200);
        assert.equal(await deleteDoc('triviaRooms/PUBAA/players/ghost', GUEST), 403,
            'a non-host member cannot sweep it either');
        assert.equal(await deleteDoc('triviaRooms/PUBAA/players/ghost', HOST), 200,
            'past the grace the host sweeps the ghost');
        assert.equal(await createDoc('triviaRooms/PUBAA/players/crashed',
            { uid: 'crashed', score: 0, lastSeen: new Date(ago(200000)) }, OWNER), 200);
        assert.equal(await deleteDoc('triviaRooms/PUBAA/players/crashed', HOST), 200,
            'a doc whose lastSeen heartbeat is older than the presence window is stale too');
        // Host takeover: host1 has no player doc in PUBAA (never joined in this
        // suite), so the host is "gone" and member guest1 may claim hostUid.
        assert.equal(await updateDoc('triviaRooms/PUBAA', { hostUid: 'bob' }, GUEST), 403,
            'a takeover must name the caller');
        assert.equal(await updateDoc('triviaRooms/PUBAA', { hostUid: 'alice' }, ALICE), 403,
            'non-member cannot take over');
        assert.equal(await updateDoc('triviaRooms/PUBAA', { hostUid: 'guest1' }, GUEST), 200,
            'member takes over from a gone host');
        assert.equal(await createDoc('triviaRooms/PUBAA/players/bob', { uid: 'bob', score: 0, lastSeen: new Date() }, BOB), 200);
        assert.equal(await createDoc('triviaRooms/PUBAA/players/guest1b', { uid: 'guest1', score: 0 }, OWNER), 200);
        assert.equal(await updateDoc('triviaRooms/PUBAA', { hostUid: 'bob' }, BOB), 403,
            'the new host is live (has a fresh player doc), so bob cannot take over');
        assert.equal(await updateDoc('triviaRooms/PUBAA', { hostUid: 'host1' }, GUEST), 200, 'host hands back');
        assert.equal(await deleteDoc('triviaRooms/PUBAA/players/bob', BOB), 200);
    });

    test('gateHash replay boundary is real and documented: a member\'s hash is readable and reusable', async () => {
        // Deliberate pin of the accepted design boundary (see
        // js/room-gate.js): player docs are readable to any signed-in
        // user, so the proof-of-password can be replayed for room ENTRY.
        // What the design protects is the PASSWORD, which never appears
        // in any readable document. If this test ever starts failing
        // because player reads tightened, revisit the boundary note.
        assert.equal(await getDoc('triviaRooms/GATED/players/bob', ALICE), 200);
        assert.equal(await createDoc('triviaRooms/GATED/players/alice',
            { uid: 'alice', gateHash: 'good-hash-value', score: 0 }, ALICE), 200);
    });

    /* ---------------- chat ---------------- */

    test('chat create: own uid, 1..280 chars; append-only while the room lives', async () => {
        assert.equal(await createDoc('triviaRooms/PUBAA/chat/m1',
            { uid: 'alice', text: 'hello' }, ALICE), 200);
        assert.equal(await createDoc('triviaRooms/PUBAA/chat/m2',
            { uid: 'alice', text: 'x'.repeat(280) }, ALICE), 200,
            'exactly 280 chars is the last allowed length');
        assert.equal(await createDoc('triviaRooms/PUBAA/chat/m3',
            { uid: 'alice', text: 'x'.repeat(281) }, ALICE), 403,
            '281 chars breaches the cap');
        assert.equal(await createDoc('triviaRooms/PUBAA/chat/m4',
            { uid: 'alice', text: '' }, ALICE), 403, 'empty text denied');
        assert.equal(await createDoc('triviaRooms/PUBAA/chat/m5',
            { uid: 'bob', text: 'spoof' }, ALICE), 403, 'uid must match the author');
        assert.equal(await createDoc('triviaRooms/PUBAA/chat/m6',
            { uid: 'alice', text: 42 }, ALICE), 403, 'text must be a string');
        assert.equal(await createDoc('triviaRooms/PUBAA/chat/m7',
            { uid: 'guest1', text: 'guests can chat' }, GUEST), 200,
            'chat requires sign-in, not registration');
        assert.equal(await updateDoc('triviaRooms/PUBAA/chat/m1', { text: 'edited' }, ALICE), 403,
            'no edits, even by the author');
        assert.equal(await deleteDoc('triviaRooms/PUBAA/chat/m1', ALICE), 403,
            'no recalls by the author while the room lives');
        assert.equal(await deleteDoc('triviaRooms/PUBAA/chat/m1', HOST), 403,
            'not even the host can delete chat while the room lives');
    });

    test('teardown sweep (audit D6): once the room doc is deleted, chat and leftover player docs are sweepable by any signed-in user', async () => {
        assert.equal(await createDoc('triviaRooms/TORN',
            { code: 'TORN', hostUid: 'host1', status: 'finished', isPrivate: false }, OWNER), 200);
        assert.equal(await createDoc('triviaRooms/TORN/chat/c1', { uid: 'alice', text: 'bye' }, OWNER), 200);
        assert.equal(await createDoc('triviaRooms/TORN/players/alice', { uid: 'alice', score: 1 }, OWNER), 200);
        assert.equal(await deleteDoc('triviaRooms/TORN/chat/c1', HOST), 403, 'room still exists: chat stays');
        assert.equal(await deleteDoc('triviaRooms/TORN/players/alice', HOST), 403, 'room still exists, alice is live');
        assert.equal(await deleteDoc('triviaRooms/TORN', HOST), 200);
        assert.equal(await deleteDoc('triviaRooms/TORN/chat/c1', HOST), 200, 'orphan chat sweep');
        assert.equal(await deleteDoc('triviaRooms/TORN/players/alice', GUEST), 200, 'orphan player-doc sweep');
    });

    /* ---------------- leaderboard + admin registry ---------------- */

    test('leaderboard: guests excluded from writes, self-only rows, admin-only deletes', async () => {
        assert.equal(await createDoc('triviaLeaderboard/alice',
            { uid: 'alice', xp: 100 }, ALICE), 200);
        assert.equal(await createDoc('triviaLeaderboard/guest1',
            { uid: 'guest1', xp: 5 }, GUEST), 403,
            'anonymous uids must not pollute the public board');
        assert.equal(await createDoc('triviaLeaderboard/bob',
            { uid: 'bob', xp: 1 }, ALICE), 403, 'own row only');
        assert.equal(await getDoc('triviaLeaderboard/alice', GUEST), 200,
            'guests can browse the board');
        assert.equal(await deleteDoc('triviaLeaderboard/alice', ALICE), 403,
            'row owner is not an admin');
        assert.equal(await deleteDoc('triviaLeaderboard/alice', ADMIN), 200,
            'presence of /leaderboardAdmins/{uid} grants delete');
    });

    test('leaderboardAdmins registry: readable when signed in, writable by nobody', async () => {
        assert.equal(await getDoc('leaderboardAdmins/admin1', ALICE), 200);
        assert.equal(await createDoc('leaderboardAdmins/alice', { note: 'self-promote' }, ALICE), 403);
        assert.equal(await createDoc('leaderboardAdmins/alice', { note: 'nope' }, ADMIN), 403,
            'even an existing admin cannot mint admins in-app');
        assert.equal(await deleteDoc('leaderboardAdmins/admin1', ADMIN), 403);
    });

    /* ---------------- H2H + daily board (guest exclusion) ---------------- */

    test('triviaH2H: registered members of the pair only', async () => {
        assert.equal(await createDoc('triviaH2H/alice__bob',
            { uidA: 'alice', uidB: 'bob', aWins: 1, bWins: 0 }, ALICE), 200);
        assert.equal(await createDoc('triviaH2H/bob__carol',
            { uidA: 'bob', uidB: 'carol', aWins: 0, bWins: 0 }, ALICE), 403,
            'caller must be one of the two uids');
        assert.equal(await createDoc('triviaH2H/guest1__zed',
            { uidA: 'guest1', uidB: 'zed' }, GUEST), 403,
            'guests never create H2H rows');
        assert.equal(await getDoc('triviaH2H/alice__bob', GUEST), 200,
            'any signed-in user can read pair records');
    });

    test('globeDropDailyLeaderboard: own registered score only', async () => {
        assert.equal(await createDoc('globeDropDailyLeaderboard/2026-08-15/scores/alice',
            { uid: 'alice', score: 480 }, ALICE), 200);
        assert.equal(await createDoc('globeDropDailyLeaderboard/2026-08-15/scores/guest1',
            { uid: 'guest1', score: 500 }, GUEST), 403,
            'guest uids cannot claim daily spots');
        assert.equal(await createDoc('globeDropDailyLeaderboard/2026-08-15/scores/bob',
            { uid: 'bob', score: 1 }, ALICE), 403);
        assert.equal(await getDoc('globeDropDailyLeaderboard/2026-08-15/scores/alice', BOB), 200);
    });

    /* ------- no-regression pins for the untouched shared sections ------- */

    test('no-regression: users/{uid} sync namespace is self-only and registered-only', async () => {
        assert.equal(await createDoc('users/alice/apps/trip-planner',
            { data: { k: 1 }, meta: { lastUpdated: 1 } }, ALICE), 200);
        assert.equal(await getDoc('users/alice/apps/trip-planner', BOB), 403);
        assert.equal(await updateDoc('users/alice/apps/trip-planner',
            { data: { k: 2 } }, BOB), 403);
        assert.equal(await createDoc('users/guest1/apps/trip-planner',
            { data: {}, meta: { lastUpdated: 1 } }, GUEST), 403,
            'anonymous users have no persistent profile');
    });

    test('no-regression: maptap handle claim is first-come, own-uid, registered-only', async () => {
        assert.equal(await createDoc('maptapRivalsHandles/nikita',
            { uid: 'alice' }, ALICE), 200);
        assert.equal(await updateDoc('maptapRivalsHandles/nikita',
            { uid: 'bob' }, BOB), 403, 'handles cannot be stolen');
        assert.equal(await createDoc('maptapRivalsHandles/ghosty',
            { uid: 'guest1' }, GUEST), 403);
        assert.equal(await getDoc('maptapRivalsHandles/nikita', BOB), 200);
    });

    test('no-regression: maptap network profile readable only by self or linked members', async () => {
        assert.equal(await createDoc('maptapRivalsNetwork/alice',
            { handle: 'nikita', rivals: [] }, ALICE), 200);
        assert.equal(await getDoc('maptapRivalsNetwork/alice', ALICE), 200);
        assert.equal(await getDoc('maptapRivalsNetwork/alice', BOB), 403,
            'unlinked stranger cannot harvest a rival list');
        assert.equal(await createDoc('maptapRivalsLinks/alice__bob',
            { uids: ['alice', 'bob'] }, BOB), 200);
        assert.equal(await getDoc('maptapRivalsNetwork/alice', BOB), 200,
            'a pair link grants profile read');
    });

    test('no-regression: maptap pair links - nonexistent-doc probe allowed, membership enforced', async () => {
        assert.equal(await getDoc('maptapRivalsLinks/xxx__yyy', ALICE), 404,
            'the pre-create existence probe must not be denied (resource == null split)');
        assert.equal(await getDoc('maptapRivalsLinks/alice__bob', ALICE), 200);
        assert.equal(await createDoc('maptapRivalsLinks/bob__carol',
            { uids: ['bob', 'carol'] }, ALICE), 403, 'only a member can create a pair');
        assert.equal(await updateDoc('maptapRivalsLinks/alice__bob',
            { uids: ['alice', 'mallory'] }, ALICE), 403, 'pair docs are immutable');
        assert.equal(await deleteDoc('maptapRivalsLinks/alice__bob', BOB), 200,
            'either member can tear the connection down');
    });

    test('no-regression: everything unmatched stays deny-by-default', async () => {
        assert.equal(await createDoc('randomCollection/doc1', { a: 1 }, ALICE), 403);
        assert.equal(await getDoc('randomCollection/doc1', ALICE), 403);
    });
}
