'use strict';
// Unit tests for the room password gate hash (defect 22). The derivation
// must be identical on every client forever - a change would lock every
// live gated room - so the primary test pins a known vector computed
// independently (sha256sum over the literal bytes), not by mirroring the
// implementation. Node 20 ships WebCrypto on globalThis.crypto, the same
// API the browser uses.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeRoomGateHash, randomGateHash } = require('../js/room-gate.js');

test('computeRoomGateHash matches the pinned independent SHA-256 vector', async () => {
    // printf 'hunter2:ABCDE' | sha256sum
    assert.equal(
        await computeRoomGateHash('hunter2', 'ABCDE'),
        'e91174fa165d410e19785c123f0081bfd141a9a1c633f3331b789b10e71cf2e4'
    );
});

test('computeRoomGateHash salts with the room code (same password, different room)', async () => {
    // printf 'hunter2:FGHJK' | sha256sum
    assert.equal(
        await computeRoomGateHash('hunter2', 'FGHJK'),
        'b438839539b738b79d92c62deacebe3193503e8a9233a7cd73d1448bee5754ac'
    );
    assert.notEqual(
        await computeRoomGateHash('hunter2', 'FGHJK'),
        await computeRoomGateHash('hunter2', 'ABCDE')
    );
});

test('computeRoomGateHash is deterministic and shaped like 64-char lowercase hex', async () => {
    const a = await computeRoomGateHash('pässwörd 🔒', 'MNPQR');
    const b = await computeRoomGateHash('pässwörd 🔒', 'MNPQR');
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{64}$/);
});

test('randomGateHash yields unique 64-char lowercase hex values', () => {
    const a = randomGateHash();
    const b = randomGateHash();
    assert.match(a, /^[0-9a-f]{64}$/);
    assert.match(b, /^[0-9a-f]{64}$/);
    // 256 bits of entropy: a collision here means the RNG is broken.
    assert.notEqual(a, b);
});

test('a random gate hash can never equal any password-derived hash shape by construction', async () => {
    // Not a cryptographic proof, but pins the intent: solo/daily rooms
    // store randomGateHash(), and the join flow only ever submits
    // computeRoomGateHash(typedPassword, code), so equality requires
    // guessing 256 random bits.
    const derived = await computeRoomGateHash('anything', 'STUVW');
    assert.notEqual(randomGateHash(), derived);
});
