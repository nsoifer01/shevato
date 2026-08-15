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

    test('room create: signed-in only, and NEVER with a cleartext password field (defect 22)', async () => {
        assert.equal(await createDoc('triviaRooms/NEWAA',
            { code: 'NEWAA', hostUid: 'alice', isPrivate: false }, null), 403,
            'unauthenticated create denied');
        assert.equal(await createDoc('triviaRooms/NEWAA',
            { code: 'NEWAA', hostUid: 'alice', isPrivate: true, password: LEGACY_FIXTURE_PW }, ALICE), 403,
            'a new room carrying a password field must be rejected');
        assert.equal(await createDoc('triviaRooms/NEWAA',
            { code: 'NEWAA', hostUid: 'alice', isPrivate: true }, ALICE), 200,
            'the same create without the field is allowed');
    });

    test('room update stays loose (host advances questions), including legacy rooms still carrying password', async () => {
        assert.equal(await updateDoc('triviaRooms/PUBAA', { status: 'playing' }, BOB), 200);
        // Legacy room: the post-state still contains the old cleartext
        // field; the no-password condition applies to CREATE only, so
        // pre-migration rooms keep working until they expire.
        assert.equal(await updateDoc('triviaRooms/WPASS', { status: 'playing' }, HOST), 200);
        assert.equal(await updateDoc('triviaRooms/PUBAA', { status: 'lobby' }, null), 403);
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

    test('gate cleanup: any signed-in user can delete the gate (last-leaver room sweep)', async () => {
        assert.equal(await deleteDoc('triviaRooms/NEWAA/private/gate', null), 403);
        assert.equal(await deleteDoc('triviaRooms/NEWAA/private/gate', BOB), 200);
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

    test('player-doc ownership: only you update or delete your doc (score integrity)', async () => {
        assert.equal(await updateDoc('triviaRooms/PUBAA/players/alice', { score: 150 }, ALICE), 200);
        assert.equal(await updateDoc('triviaRooms/PUBAA/players/alice', { score: 0 }, BOB), 403,
            'the host cannot rewrite someone else\'s score');
        // Known modeled limitation: the host-handoff isHost flag write to
        // the NEXT host's doc is denied by this same ownership rule (the
        // app swallows it; hostUid on the room doc is the source of truth).
        assert.equal(await updateDoc('triviaRooms/PUBAA/players/alice', { isHost: true }, BOB), 403);
        assert.equal(await deleteDoc('triviaRooms/PUBAA/players/alice', BOB), 403);
        assert.equal(await deleteDoc('triviaRooms/PUBAA/players/alice', ALICE), 200);
        assert.equal(await getDoc('triviaRooms/PUBAA/players/guest1', ALICE), 200,
            'any signed-in user can read player docs (scoreboard)');
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

    test('chat create: own uid, 1..280 chars; append-only afterwards', async () => {
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
            'no recalls, even by the author');
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
