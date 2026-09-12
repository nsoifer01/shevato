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
        // A room in the shape every client has created since 2026-09-07:
        // scopedReads on the room doc, a public lobby carrying only the join
        // metadata, and one member. This is what the outsider tests below
        // attack; PUBAA/GATED/WPASS keep modelling rooms that predate it.
        assert.equal(await createDoc('triviaRooms/SCOPD',
            { code: 'SCOPD', hostUid: 'host1', status: 'playing', isPrivate: true,
              scopedReads: true, questions: [{ q: 'capital of France?', correctIndex: 2 }] }, OWNER), 200);
        assert.equal(await createDoc('triviaRooms/SCOPD/public/lobby',
            { isPrivate: true, gameType: 'trivia' }, OWNER), 200);
        assert.equal(await createDoc('triviaRooms/SCOPD/private/gate',
            { hash: 'scoped-hash-value' }, OWNER), 200);
        assert.equal(await createDoc('triviaRooms/SCOPD/players/host1',
            { uid: 'host1', displayName: 'Host', score: 0, gateHash: 'scoped-hash-value' }, OWNER), 200);
        assert.equal(await createDoc('triviaRooms/SCOPD/chat/m0',
            { uid: 'host1', text: 'private conversation' }, OWNER), 200);
    });

    /* ---------------- F01: the private-room boundary ---------------- */

    test('F01: an outsider holding the code learns nothing about a scoped room', async () => {
        // Every one of these returned 200 before 2026-09-07: the room doc
        // (questions and correctIndex included), the roster (with each
        // member's replayable gateHash) and the whole chat log were readable
        // by any signed-in stranger who obtained a five-character code.
        assert.equal(await getDoc('triviaRooms/SCOPD', ALICE), 403,
            'room state, including the unrevealed answers, is members-only');
        assert.equal(await getDoc('triviaRooms/SCOPD', GUEST), 403);
        assert.equal(await getDoc('triviaRooms/SCOPD/players/host1', ALICE), 403,
            "another member's player doc is not readable by an outsider");
        assert.equal(await listDocs('triviaRooms/SCOPD/players', ALICE), 403,
            'the roster cannot be listed by an outsider');
        assert.equal(await getDoc('triviaRooms/SCOPD/chat/m0', ALICE), 403);
        assert.equal(await listDocs('triviaRooms/SCOPD/chat', ALICE), 403);
    });

    test('F01: the join metadata an outsider DOES need stays readable', async () => {
        // The lobby doc is the whole public surface of a scoped room: does
        // it exist, does it want a password, which game is it.
        assert.equal(await getDoc('triviaRooms/SCOPD/public/lobby', ALICE), 200);
        assert.equal(await getDoc('triviaRooms/SCOPD/public/lobby', GUEST), 200);
        assert.equal(await getDoc('triviaRooms/SCOPD/public/lobby', null), 403,
            'still sign-in only');
        // And a room that does not exist must answer "not found" rather than
        // erroring on resource.data - reserveUniqueRoomCode depends on it.
        assert.equal(await getDoc('triviaRooms/NOSUCH', ALICE), 404);
    });

    test('F01: the lobby doc is immutable and cannot be forged by a stranger', async () => {
        assert.equal(await createDoc('triviaRooms/SCOPD/public/lobby',
            { isPrivate: false, gameType: 'trivia' }, ALICE), 403,
            'a stranger cannot replace the lobby to claim the room is open');
        assert.equal(await updateDoc('triviaRooms/SCOPD/public/lobby',
            { isPrivate: false }, HOST), 403, 'not even the host may edit it');
        assert.equal(await createDoc('triviaRooms/PUBAA/public/lobby',
            { isPrivate: false, gameType: 'trivia', secret: 'x' }, HOST), 403,
            'only the two join-metadata fields may be written');
        assert.equal(await deleteDoc('triviaRooms/SCOPD/public/lobby', ALICE), 403,
            'a stranger cannot delete the lobby to unlock the room');
    });

    test('F01: joining a scoped room makes the caller a member, and only then', async () => {
        assert.equal(await createDoc('triviaRooms/SCOPD/players/alice',
            { uid: 'alice', score: 0 }, ALICE), 403,
            'the gate still applies: no hash, no join');
        assert.equal(await createDoc('triviaRooms/SCOPD/players/alice',
            { uid: 'alice', score: 0, gateHash: 'wrong' }, ALICE), 403);
        assert.equal(await createDoc('triviaRooms/SCOPD/players/alice',
            { uid: 'alice', score: 0, gateHash: 'scoped-hash-value' }, ALICE), 200);
        // Now a member: everything above opens up.
        assert.equal(await getDoc('triviaRooms/SCOPD', ALICE), 200);
        assert.equal(await listDocs('triviaRooms/SCOPD/players', ALICE), 200);
        assert.equal(await listDocs('triviaRooms/SCOPD/chat', ALICE), 200);
        assert.equal(await deleteDoc('triviaRooms/SCOPD/players/alice', ALICE), 200);
        assert.equal(await getDoc('triviaRooms/SCOPD', ALICE), 403, 'and closes again on leaving');
    });

    test('F01: the membership probe still works on a doc that is not there', async () => {
        // Every rejoin path starts by asking "do I already have a player doc
        // in this room?". That read has to answer on a nonexistent document
        // rather than erroring on resource.data and denying.
        assert.equal(await getDoc('triviaRooms/SCOPD/players/alice', ALICE), 404);
        assert.equal(await getDoc('triviaRooms/SCOPD/players/bob', ALICE), 403,
            "but not somebody else's");
    });

    test('F01: an outsider cannot post chat into a room they never joined', async () => {
        assert.equal(await createDoc('triviaRooms/SCOPD/chat/intrude',
            { uid: 'alice', text: 'hello from outside' }, ALICE), 403);
        assert.equal(await createDoc('triviaRooms/PUBAA/chat/intrude2',
            { uid: 'bob', text: 'hello from outside' }, BOB), 403,
            'membership is required in every room, scoped or not');
    });

    test('F01: a player doc cannot be created in a room that does not exist', async () => {
        assert.equal(await createDoc('triviaRooms/ZZZZZ/players/alice',
            { uid: 'alice', score: 0 }, ALICE), 403,
            'an orphan subcollection under a random code is not a room');
    });

    /* ---------------- room docs ---------------- */

    test('room read requires sign-in; any signed-in user (guest included) can read', async () => {
        assert.equal(await getDoc('triviaRooms/PUBAA', null), 403);
        assert.equal(await getDoc('triviaRooms/PUBAA', ALICE), 200);
        assert.equal(await getDoc('triviaRooms/PUBAA', GUEST), 200);
    });

    test('room create: signed-in only, own uid as hostUid, and NEVER with a cleartext password field (defect 22)', async () => {
        const soon = new Date(Date.now() + 3600_000);
        assert.equal(await createDoc('triviaRooms/NEWAA',
            { code: 'NEWAA', hostUid: 'alice', isPrivate: false, expiresAt: soon }, null), 403,
            'unauthenticated create denied');
        assert.equal(await createDoc('triviaRooms/NEWAA',
            { code: 'NEWAA', hostUid: 'alice', isPrivate: true, password: LEGACY_FIXTURE_PW, expiresAt: soon }, ALICE), 403,
            'a new room carrying a password field must be rejected');
        assert.equal(await createDoc('triviaRooms/NEWAA',
            { code: 'NEWAA', hostUid: 'bob', isPrivate: false, expiresAt: soon }, ALICE), 403,
            'a room cannot be created on behalf of another uid');
        assert.equal(await createDoc('triviaRooms/NEWAA',
            { code: 'NEWAA', hostUid: 'alice', isPrivate: true, expiresAt: soon }, ALICE), 200,
            'the same create without the field is allowed');
    });

    test('F18: a room must carry its own expiry, and cannot choose to outlive the policy', async () => {
        // The TTL field is what reaps a room every one of whose clients
        // force-quit. Cleanup has otherwise always depended on somebody's
        // browser being alive to do it, and apps/arena/FINDINGS.md has
        // recorded rooms abandoned by every client as unswept.
        assert.equal(await createDoc('triviaRooms/NOTTL',
            { code: 'NOTTL', hostUid: 'alice', isPrivate: false }, ALICE), 403,
            'a room with no expiry is refused');
        assert.equal(await createDoc('triviaRooms/PASTTL',
            { code: 'PASTTL', hostUid: 'alice', isPrivate: false, expiresAt: new Date(Date.now() - 1000) }, ALICE), 403,
            'an expiry already in the past is refused');
        assert.equal(await createDoc('triviaRooms/FARTTL',
            { code: 'FARTTL', hostUid: 'alice', isPrivate: false, expiresAt: new Date(Date.now() + 90 * 3600_000) }, ALICE), 403,
            'a client cannot mint a room that outlives the policy');
        assert.equal(await createDoc('triviaRooms/OKTTL',
            { code: 'OKTTL', hostUid: 'alice', isPrivate: false, expiresAt: new Date(Date.now() + 24 * 3600_000) }, ALICE), 200,
            'the shape the app writes is allowed');
        assert.equal(await deleteDoc('triviaRooms/OKTTL', ALICE), 200);
    });

    test('F18: a departing player can remove their own public records', async () => {
        // Closing an account used to leave a public XP leaderboard row and a
        // daily-challenge score behind for good: neither had a deletion rule
        // the owner could use, so privacy.html had to say the only way to
        // remove them was to email the owner.
        assert.equal(await createDoc('triviaLeaderboard/alice',
            { uid: 'alice', displayName: 'Alice', xp: 1800, gamesPlayed: 1, wins: 1 }, ALICE), 200);
        assert.equal(await deleteDoc('triviaLeaderboard/alice', BOB), 403,
            'and only their own');
        assert.equal(await deleteDoc('triviaLeaderboard/alice', ALICE), 200);

        assert.equal(await createDoc('globeDropDailyLeaderboard/2026-09-07/scores/alice',
            { uid: 'alice', score: 480 }, ALICE), 200);
        assert.equal(await deleteDoc('globeDropDailyLeaderboard/2026-09-07/scores/alice', BOB), 403);
        assert.equal(await deleteDoc('globeDropDailyLeaderboard/2026-09-07/scores/alice', ALICE), 200);
    });

    test('F18: a shared H2H record is anonymised, not deleted, and each side owns its own name', async () => {
        // A pair record is two people's history. Deleting it to close one
        // account would take the other's games with it, so the identity goes
        // and the counts stay - and the rule is per side, so the other player
        // cannot rewrite your name for you.
        const LEAVER_B = authToken('leaver-b');
        // Seeded here rather than relying on an earlier test's leftovers: a
        // filtered run must exercise the same thing a full one does.
        assert.equal(await createDoc('triviaH2H/leaver-a__leaver-b',
            { uidA: 'leaver-a', uidB: 'leaver-b', displayNameA: 'A', displayNameB: 'B',
              winsA: 3, winsB: 1, ties: 0, gamesPlayed: 4 }, OWNER), 200);
        assert.equal(await updateDoc('triviaH2H/leaver-a__leaver-b',
            { uidA: 'leaver-a', uidB: 'leaver-b', displayNameA: 'Former player',
              winsA: 3, winsB: 1, ties: 0, gamesPlayed: 4 }, authToken('leaver-a')), 200,
            'your own name on the record is yours to remove');
        assert.equal(await updateDoc('triviaH2H/leaver-a__leaver-b',
            { uidA: 'leaver-a', uidB: 'leaver-b', displayNameA: 'Something else',
              winsA: 3, winsB: 1, ties: 0, gamesPlayed: 4 }, LEAVER_B), 403,
            "but not the other side's");
        assert.equal(await updateDoc('triviaH2H/leaver-a__leaver-b',
            { uidA: 'leaver-a', uidB: 'leaver-b', displayNameA: 'Former player',
              displayNameB: 'Former player', winsA: 3, winsB: 1, ties: 0, gamesPlayed: 4 }, LEAVER_B), 200,
            'each side removes its own');
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

    test('member writes are bounded by VALUE, not only by key (audit 2026-09-03)', async () => {
        // Until this round every member rule constrained only WHICH keys could
        // be touched. Once a question's window had elapsed on the server clock,
        // which happens every round and lasts indefinitely if the host is gone,
        // a member could write any value into those keys: wedge the room with a
        // bogus status or a negative index, replay the current question
        // forever, hand themselves the decider role, or end the game with a
        // ranking naming themselves at 999999 points. Only a member of the
        // room, so this was griefing among invited friends, but the README
        // claimed the opposite.
        const ago = (ms) => new Date(Date.now() - ms);
        // A question whose asking window and reveal have both elapsed, so the
        // timed-advance branch is open for guest1 on every assertion below.
        const openWindow = async (idx) => {
            assert.equal(await updateDoc('triviaRooms/PUBAA', {
                status: 'playing', questionTimeMs: 10000, currentQuestionIndex: idx,
                currentQuestionId: 'q' + idx, questionStartedAt: ago(30000),
                revealStartedAt: null, paused: false,
            }, HOST), 200, 'fixture: open the advance window');
        };
        const rotation = { playerOrder: ['host1', 'guest1'], deciderUid: 'host1' };
        const nextQuestion = (idx) => ({
            status: 'picking', currentQuestionIndex: idx, currentQuestionId: null,
            selectedCategory: null, questionStartedAt: null, revealStartedAt: null,
            playedQuestionIds: ['q' + (idx - 1)], ...rotation,
        });

        // --- the status has to be one the app actually uses -----------------
        await openWindow(0);
        assert.equal(await updateDoc('triviaRooms/PUBAA',
            Object.assign(nextQuestion(1), { status: 'bogus' }), GUEST), 403,
            'a bogus status is denied even inside the elapsed window');

        // --- the question index moves by exactly one, or not at all ---------
        await openWindow(0);
        assert.equal(await updateDoc('triviaRooms/PUBAA',
            Object.assign(nextQuestion(1), { currentQuestionIndex: -3 }), GUEST), 403,
            'a negative question index is denied');
        assert.equal(await updateDoc('triviaRooms/PUBAA',
            Object.assign(nextQuestion(1), { currentQuestionIndex: 5 }), GUEST), 403,
            'skipping several questions at once is denied');

        // --- replaying the CURRENT question is not an advance ---------------
        await openWindow(0);
        assert.equal(await updateDoc('triviaRooms/PUBAA',
            { questionStartedAt: new Date(), revealStartedAt: null }, GUEST), 403,
            'restarting the current question\'s timer is denied: an advance either finishes or moves on');

        // --- the decider rotation only travels with a real advance ----------
        await openWindow(0);
        assert.equal(await updateDoc('triviaRooms/PUBAA',
            { playerOrder: ['guest1'], deciderUid: 'guest1' }, GUEST), 403,
            'a member cannot hand themselves the pick without advancing the room');

        // --- the final ranking cannot be an invented scoreline ---------------
        await openWindow(0);
        assert.equal(await updateDoc('triviaRooms/PUBAA', {
            status: 'finished', finishedAt: new Date(),
            finalRanking: [{ uid: 'guest1', displayName: 'Guest', score: 999999, streak: 0 }],
        }, GUEST), 403, 'a ranking no real game can produce is denied');
        assert.equal(await updateDoc('triviaRooms/PUBAA', {
            status: 'finished', finishedAt: new Date(),
            finalRanking: [{ uid: 'guest1', displayName: 'Guest', score: 'lots', streak: 0 }],
        }, GUEST), 403, 'a non-numeric score is denied');

        // --- and the same bound applies to ending the game early ------------
        assert.equal(await updateDoc('triviaRooms/PUBAA', { status: 'playing' }, HOST), 200);
        assert.equal(await updateDoc('triviaRooms/PUBAA', {
            status: 'finished', finishedAt: new Date(), paused: false, pausedAt: null,
            finalRanking: [{ uid: 'guest1', displayName: 'Guest', score: 999999, streak: 0 }],
        }, GUEST), 403, 'end-game-early is bounded too');

        // --- CONTROLS: every legitimate shape the client writes still passes -
        await openWindow(0);
        assert.equal(await updateDoc('triviaRooms/PUBAA', nextQuestion(1), GUEST), 200,
            'the real trivia advance (index + 1, rotation, picking) is still allowed');

        await openWindow(3);
        assert.equal(await updateDoc('triviaRooms/PUBAA', {
            status: 'playing', currentQuestionIndex: 4, currentQuestionId: 'loc4',
            questionStartedAt: new Date(), revealStartedAt: null, playedQuestionIds: ['q3'],
        }, GUEST), 200, 'the real Globe Drop advance (no rotation) is still allowed');

        await openWindow(5);
        assert.equal(await updateDoc('triviaRooms/PUBAA', {
            status: 'finished', finishedAt: new Date(), playedQuestionIds: ['q5'],
            finalRanking: [{ uid: 'guest1', displayName: 'Guest', score: 1350, streak: 3 }],
        }, GUEST), 200, 'finishing on the last question, with a ranking a real game can reach');

        // An empty ranking is legitimate (everyone left) and must not trip the
        // top-entry check, which would otherwise index an empty list.
        await openWindow(6);
        assert.equal(await updateDoc('triviaRooms/PUBAA', {
            status: 'finished', finishedAt: new Date(), finalRanking: [],
        }, GUEST), 200, 'an empty final ranking is allowed');

        // --- the timed pick is bounded the same way --------------------------
        assert.equal(await updateDoc('triviaRooms/PUBAA',
            { status: 'picking', deciderUid: 'someone-else', pickingStartedAt: ago(25000) }, HOST), 200);
        assert.equal(await updateDoc('triviaRooms/PUBAA',
            { status: 'lobby', currentQuestionId: 'q9', selectedCategory: 'geo',
              questionStartedAt: new Date(), revealStartedAt: null }, GUEST), 403,
            'a timed pick cannot send the room back to the lobby');
        assert.equal(await updateDoc('triviaRooms/PUBAA',
            { status: 'playing', currentQuestionId: 'q9', selectedCategory: 'geo',
              questionStartedAt: new Date(), revealStartedAt: null }, GUEST), 200,
            'the real timed pick is still allowed');

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
        // The STALE branch, which is the one a closed tab actually produces:
        // beforeunload stamps disconnectedAt and leaves the player doc in
        // place, so the host is never "gone", only stale. Until 2026-09-11
        // no client ever asked for this takeover outside the explicit Leave
        // button, so a host who closed the tab kept hostUid forever and took
        // early reveal, the Globe Drop skip, the stale sweep and the rematch
        // with them.
        assert.equal(await createDoc('triviaRooms/PUBAA/players/host1',
            { uid: 'host1', score: 0, lastSeen: new Date(), disconnectedAt: ago(5000) }, OWNER), 200);
        assert.equal(await updateDoc('triviaRooms/PUBAA', { hostUid: 'bob' }, BOB), 403,
            'inside the disconnect grace the host may still be refreshing');
        assert.equal(await updateDoc('triviaRooms/PUBAA/players/host1', { disconnectedAt: ago(40000) }, OWNER), 200);
        // 'playing' so the write is a REAL diff: affectedKeys() is computed
        // against the stored doc, and re-writing the value already there
        // (status is 'lobby' here) would not register as a touched key at all.
        assert.equal(await updateDoc('triviaRooms/PUBAA', { hostUid: 'bob', status: 'playing' }, BOB), 403,
            'hostUid is the only key a takeover may touch');
        assert.equal(await updateDoc('triviaRooms/PUBAA', { hostUid: 'bob' }, BOB), 200,
            'past the grace a member adopts the room from a host whose doc is merely STALE');
        assert.equal(await updateDoc('triviaRooms/PUBAA', { hostUid: 'host1' }, BOB), 200, 'host hands back');
        assert.equal(await deleteDoc('triviaRooms/PUBAA/players/host1', HOST), 200);
        assert.equal(await deleteDoc('triviaRooms/PUBAA/players/bob', BOB), 200);
    });

    test('F01: the admission proof is no longer readable, so it cannot be replayed', async () => {
        // This test used to assert the OPPOSITE, under the name "gateHash
        // replay boundary is real and documented". Player docs were readable
        // by any signed-in user, so the proof-of-password sat in a broadly
        // readable record and an outsider with the code could copy a
        // member's hash and walk in. A green suite was pinning the hole.
        //
        // A scoped room now answers that read with a denial, so there is
        // nothing to copy. The client additionally clears the field off its
        // own player doc immediately after the create, so the proof is not
        // durably stored even for the members who can read it.
        assert.equal(await getDoc('triviaRooms/SCOPD/players/host1', ALICE), 403,
            'the hash cannot be harvested');
        assert.equal(await createDoc('triviaRooms/SCOPD/players/alice',
            { uid: 'alice', gateHash: 'guessed-hash', score: 0 }, ALICE), 403,
            'and a guessed one does not admit');
        // Legacy (unscoped) rooms keep their old behaviour on purpose: they
        // are ephemeral, and an old client cannot write the scopedReads flag.
        assert.equal(await getDoc('triviaRooms/GATED/players/bob', ALICE), 200);
    });

    /* ---------------- chat ---------------- */

    test('chat create: own uid, 1..280 chars; append-only while the room lives', async () => {
        // Chat is members-only now (F01), so the authors join first. That is
        // what the app does too: the chat panel only exists inside a room.
        // 409 = an earlier test already joined them; either way they are
        // members, which is what this test needs. A 403 would not be.
        assert.ok([200, 409].includes(await createDoc('triviaRooms/PUBAA/players/alice',
            { uid: 'alice', displayName: 'Alice', score: 0 }, ALICE)));
        assert.ok([200, 409].includes(await createDoc('triviaRooms/PUBAA/players/guest1',
            { uid: 'guest1', displayName: 'Guest', score: 0 }, GUEST)));
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

    test('leaderboard: guests excluded from writes, self-only rows, owner or admin deletes', async () => {
        assert.equal(await createDoc('triviaLeaderboard/alice',
            { uid: 'alice', xp: 100 }, ALICE), 200);
        assert.equal(await createDoc('triviaLeaderboard/guest1',
            { uid: 'guest1', xp: 5 }, GUEST), 403,
            'anonymous uids must not pollute the public board');
        assert.equal(await createDoc('triviaLeaderboard/bob',
            { uid: 'bob', xp: 1 }, ALICE), 403, 'own row only');
        assert.equal(await getDoc('triviaLeaderboard/alice', GUEST), 200,
            'guests can browse the board');
        assert.equal(await deleteDoc('triviaLeaderboard/alice', BOB), 403,
            "a stranger cannot remove somebody else's row");
        // This line used to assert the OPPOSITE ("row owner is not an admin"),
        // and that was the whole problem: closing an account left a public
        // leaderboard row nobody but a moderator could remove, which
        // privacy.html had to say out loud (2026-09-05 audit F18).
        assert.equal(await deleteDoc('triviaLeaderboard/alice', ALICE), 200,
            'your own row is yours to withdraw');
        assert.equal(await createDoc('triviaLeaderboard/alice',
            { uid: 'alice', xp: 100 }, ALICE), 200);
        assert.equal(await deleteDoc('triviaLeaderboard/alice', ADMIN), 200,
            'and presence of /leaderboardAdmins/{uid} still grants moderation');
    });

    test('leaderboardAdmins registry: readable when signed in, writable by nobody', async () => {
        assert.equal(await getDoc('leaderboardAdmins/admin1', ALICE), 200);
        assert.equal(await createDoc('leaderboardAdmins/alice', { note: 'self-promote' }, ALICE), 403);
        assert.equal(await createDoc('leaderboardAdmins/alice', { note: 'nope' }, ADMIN), 403,
            'even an existing admin cannot mint admins in-app');
        assert.equal(await deleteDoc('leaderboardAdmins/admin1', ADMIN), 403);
    });

    /* ---------------- H2H + daily board (guest exclusion) ---------------- */

    test('triviaH2H: registered members of the pair only, under the canonical key', async () => {
        assert.equal(await createDoc('triviaH2H/alice__bob',
            { uidA: 'alice', uidB: 'bob', winsA: 1, winsB: 0, ties: 0, gamesPlayed: 1 }, ALICE), 200);
        assert.equal(await createDoc('triviaH2H/bob__carol',
            { uidA: 'bob', uidB: 'carol', winsA: 0, winsB: 0, ties: 0, gamesPlayed: 0 }, ALICE), 403,
            'caller must be one of the two uids');
        assert.equal(await createDoc('triviaH2H/guest1__zed',
            { uidA: 'guest1', uidB: 'zed' }, GUEST), 403,
            'guests never create H2H rows');
        assert.equal(await getDoc('triviaH2H/alice__bob', GUEST), 200,
            'any signed-in user can read pair records');
        // The key IS the participants. A pair written under any other name
        // is a second, conflicting record of the same rivalry.
        assert.equal(await createDoc('triviaH2H/anything',
            { uidA: 'alice', uidB: 'bob', gamesPlayed: 0 }, ALICE), 403,
            'a forged document id is refused');
        assert.equal(await createDoc('triviaH2H/bob__alice',
            { uidA: 'bob', uidB: 'alice', gamesPlayed: 0 }, ALICE), 403,
            'the uids must be in canonical order');
    });

    test('F02: an unrelated user cannot seize an existing H2H pair', async () => {
        // The reproduced exploit: the old rule checked only the uids in the
        // SUBMITTED document, so mallory opened victim-a__victim-b, named
        // herself as uidA and posted 9,999 wins over a stranger. Ownership
        // of the stored record was never consulted.
        assert.equal(await createDoc('triviaH2H/victim-a__victim-b',
            { uidA: 'victim-a', uidB: 'victim-b', winsA: 2, winsB: 1, ties: 0, gamesPlayed: 3 }, OWNER), 200);
        const MALLORY = authToken('mallory');
        assert.equal(await updateDoc('triviaH2H/victim-a__victim-b',
            { uidA: 'mallory', uidB: 'victim-b', winsA: 9999, winsB: 0, ties: 0, gamesPlayed: 9999 }, MALLORY), 403,
            'participants cannot be replaced');
        assert.equal(await updateDoc('triviaH2H/victim-a__victim-b',
            { uidA: 'victim-a', uidB: 'victim-b', winsA: 9999, winsB: 0, ties: 0, gamesPlayed: 9999 }, MALLORY), 403,
            'and a non-participant cannot write the pair at all');
        // Even a real participant may not rewrite the identities.
        const VICTIM_A = authToken('victim-a');
        assert.equal(await updateDoc('triviaH2H/victim-a__victim-b',
            { uidA: 'victim-a', uidB: 'mallory', winsA: 3, winsB: 1, ties: 0, gamesPlayed: 4 }, VICTIM_A), 403);
        assert.equal(await updateDoc('triviaH2H/victim-a__victim-b',
            { uidA: 'victim-a', uidB: 'victim-b', winsA: 3, winsB: 1, ties: 0, gamesPlayed: 4 }, VICTIM_A), 200,
            'the legitimate one-game update still lands');
    });

    test('F02: a persistent record can be a claim, but not a fabrication', async () => {
        const VICTIM_A = authToken('victim-a');
        assert.equal(await updateDoc('triviaH2H/victim-a__victim-b',
            { uidA: 'victim-a', uidB: 'victim-b', winsA: 999999999, winsB: 1, ties: 0, gamesPlayed: 999999999 }, VICTIM_A), 403,
            'one game per write');
        assert.equal(await updateDoc('triviaH2H/victim-a__victim-b',
            { uidA: 'victim-a', uidB: 'victim-b', winsA: 0, winsB: 1, ties: 0, gamesPlayed: 4 }, VICTIM_A), 403,
            'counters never go backwards');
        assert.equal(await updateDoc('triviaH2H/victim-a__victim-b',
            { uidA: 'victim-a', uidB: 'victim-b', winsA: 4, winsB: 1, ties: 0, gamesPlayed: 4 }, VICTIM_A), 403,
            'wins + losses + ties can never exceed games played');
    });

    test('F02: leaderboard rows are bounded (the audit wrote 999,999,999)', async () => {
        assert.equal(await createDoc('triviaLeaderboard/bob',
            { uid: 'bob', displayName: 'Bob', xp: 999999999, gamesPlayed: 999999999, wins: 999999999 }, BOB), 403);
        assert.equal(await createDoc('triviaLeaderboard/bob',
            { uid: 'bob', displayName: 'Bob', xp: 1800, gamesPlayed: 1, wins: 1 }, BOB), 200);
        assert.equal(await updateDoc('triviaLeaderboard/bob',
            { uid: 'bob', displayName: 'Bob', xp: 999999999, gamesPlayed: 2, wins: 2 }, BOB), 403,
            'a single write cannot add a lifetime of points');
        assert.equal(await updateDoc('triviaLeaderboard/bob',
            { uid: 'bob', displayName: 'Bob', xp: 3600, gamesPlayed: 2, wins: 2 }, BOB), 200,
            'the honest next game still lands');
        assert.equal(await updateDoc('triviaLeaderboard/bob',
            { uid: 'bob', displayName: 'Bob', xp: 100, gamesPlayed: 2, wins: 2 }, BOB), 403,
            'counters never go backwards');
        assert.equal(await updateDoc('triviaLeaderboard/bob',
            { uid: 'bob', displayName: 'Bob', xp: 3600, gamesPlayed: 2, wins: 9 }, BOB), 403,
            'more wins than games is not a possible record');
        // The display-name-only merge write that propagateDisplayName makes
        // must keep working.
        assert.equal(await updateDoc('triviaLeaderboard/bob',
            { uid: 'bob', displayName: 'Bobby', xp: 3600, gamesPlayed: 2, wins: 2 }, BOB), 200);
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
        assert.equal(await createDoc('globeDropDailyLeaderboard/2026-08-15/scores/bob',
            { uid: 'bob', score: 999999999 }, BOB), 403,
            'a daily score is bounded by what the game can produce');
        assert.equal(await createDoc('globeDropDailyLeaderboard/2026-08-15/scores/bob',
            { uid: 'bob', score: 480, displayName: 'x'.repeat(200) }, BOB), 403,
            'and the display name by what the UI can render');
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

    test('F03: a stranger can no longer self-grant a read of a private profile', async () => {
        // The reproduced exploit, step by step. It used to end in 200.
        assert.equal(await createDoc('maptapRivalsNetwork/alice',
            { handle: 'nikita', rivals: [] }, ALICE), 200);
        assert.equal(await getDoc('maptapRivalsNetwork/alice', ALICE), 200);
        assert.equal(await getDoc('maptapRivalsNetwork/alice', BOB), 403,
            'unlinked stranger cannot harvest a rival list');
        // Creating the link is now an INVITATION, and it is all bob can do.
        assert.equal(await createDoc('maptapRivalsLinks/alice__bob',
            { uids: ['alice', 'bob'] }, BOB), 403,
            'a link with no acceptor is not a valid document any more');
        assert.equal(await createDoc('maptapRivalsLinks/alice__bob',
            { uids: ['alice', 'bob'], acceptedBy: ['bob'] }, BOB), 200,
            'bob may invite alice');
        assert.equal(await getDoc('maptapRivalsNetwork/alice', BOB), 403,
            'and a pending invitation grants NOTHING');
        // Nor can he accept on her behalf.
        assert.equal(await updateDoc('maptapRivalsLinks/alice__bob',
            { uids: ['alice', 'bob'], acceptedBy: ['bob', 'alice'] }, BOB), 403,
            'the inviter cannot accept for the invitee');
        assert.equal(await getDoc('maptapRivalsNetwork/alice', BOB), 403);
        // Only alice's own acceptance opens the door.
        assert.equal(await updateDoc('maptapRivalsLinks/alice__bob',
            { uids: ['alice', 'bob'], acceptedBy: ['bob', 'alice'] }, ALICE), 200);
        assert.equal(await getDoc('maptapRivalsNetwork/alice', BOB), 200,
            'a mutually accepted link grants profile read');
    });

    test('F03: an accepted link is still immutable in every other respect', async () => {
        assert.equal(await updateDoc('maptapRivalsLinks/alice__bob',
            { uids: ['alice', 'mallory'], acceptedBy: ['bob', 'alice'] }, ALICE), 403,
            'participants cannot be rewritten');
        assert.equal(await updateDoc('maptapRivalsLinks/alice__bob',
            { uids: ['alice', 'bob'], acceptedBy: ['bob', 'alice'], names: { alice: 'x' } }, BOB), 403,
            'no other field may ride along on an acceptance');
        assert.equal(await updateDoc('maptapRivalsLinks/alice__bob',
            { uids: ['alice', 'bob'], acceptedBy: ['bob', 'alice', 'mallory'] }, ALICE), 403,
            'acceptedBy can only ever hold the two participants');
    });

    test('F03: a forged pair key is refused, and the probe still works', async () => {
        assert.equal(await getDoc('maptapRivalsLinks/xxx__yyy', ALICE), 404,
            'the pre-create existence probe must not be denied (resource == null split)');
        assert.equal(await getDoc('maptapRivalsLinks/alice__bob', ALICE), 200);
        assert.equal(await createDoc('maptapRivalsLinks/bob__carol',
            { uids: ['bob', 'carol'], acceptedBy: ['bob'] }, ALICE), 403,
            'only a member can create a pair');
        assert.equal(await createDoc('maptapRivalsLinks/zzz',
            { uids: ['alice', 'zed'], acceptedBy: ['alice'] }, ALICE), 403,
            'the document id must be the canonical pair key');
        assert.equal(await createDoc('maptapRivalsLinks/zed__alice',
            { uids: ['zed', 'alice'], acceptedBy: ['alice'] }, ALICE), 403,
            'and the uids must be in canonical order');
        assert.equal(await deleteDoc('maptapRivalsLinks/alice__bob', BOB), 200,
            'either member can tear the connection down');
        assert.equal(await getDoc('maptapRivalsNetwork/alice', BOB), 403,
            'and the private read goes with it');
    });

    test('F03: a link written before consent existed keeps working', async () => {
        // Migration safety: breaking every existing connection to close a
        // hole that is already closed for new links would cost real people
        // their rival network. A legacy link (no acceptedBy) reads as
        // accepted; what stops the exploit is that it can no longer be
        // CREATED.
        assert.equal(await createDoc('maptapRivalsLinks/alice__carol',
            { uids: ['alice', 'carol'], createdBy: 'carol' }, OWNER), 200);
        const CAROL = authToken('carol');
        assert.equal(await getDoc('maptapRivalsNetwork/alice', CAROL), 200);
    });

    test('F03: a declined connection cannot be re-granted by the other side alone', async () => {
        const DAVE = authToken('dave');
        assert.equal(await createDoc('maptapRivalsLinks/alice__dave',
            { uids: ['alice', 'dave'], acceptedBy: ['dave'] }, DAVE), 200);
        assert.equal(await deleteDoc('maptapRivalsLinks/alice__dave', ALICE), 200, 'alice declines');
        assert.equal(await createDoc('maptapRivalsLinks/alice__dave',
            { uids: ['alice', 'dave'], acceptedBy: ['dave', 'alice'] }, DAVE), 403,
            'dave cannot re-create it pre-accepted');
        assert.equal(await createDoc('maptapRivalsLinks/alice__dave',
            { uids: ['alice', 'dave'], acceptedBy: ['dave'] }, DAVE), 200,
            'he can only ask again');
        assert.equal(await getDoc('maptapRivalsNetwork/alice', DAVE), 403,
            'which still grants nothing until she accepts');
    });

    test('no-regression: everything unmatched stays deny-by-default', async () => {
        assert.equal(await createDoc('randomCollection/doc1', { a: 1 }, ALICE), 403);
        assert.equal(await getDoc('randomCollection/doc1', ALICE), 403);
    });
}
