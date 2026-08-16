/*
 * Brain Arena - room password gate hashing.
 *
 * The room password is NEVER persisted. On create, the host stores
 * SHA-256(password + ':' + roomCode) in triviaRooms/{code}/private/gate,
 * a doc no client can read (firestore.rules: allow read: if false). On
 * join, the client derives the same hash from the typed password and
 * sends it as the member-doc `gateHash` field; the rules compare it to
 * the stored hash via get(), which bypasses client read permissions, so
 * the secret never crosses the wire in a readable document. Salting with
 * the room code keeps identical passwords in different rooms from
 * producing identical hashes.
 *
 * Boundary (documented deliberately): the gateHash a member writes on
 * their own player doc is readable by any signed-in user who has the
 * room code, so a determined attacker could replay another member's
 * gateHash to enter the room. What the design guarantees is that the
 * PASSWORD ITSELF is never recoverable by anyone - the harm in the old
 * scheme, where the cleartext password (often reused elsewhere) sat on
 * the world-readable room doc.
 *
 * UMD-style export: CommonJS for node:test (Node 20 ships WebCrypto on
 * globalThis.crypto), attached to window.BrainArena.RoomGate for the
 * browser classic script.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        const ns = root.BrainArena = root.BrainArena || {};
        ns.RoomGate = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    function toHex(bytes) {
        let out = '';
        for (let i = 0; i < bytes.length; i++) {
            out += bytes[i].toString(16).padStart(2, '0');
        }
        return out;
    }

    /**
     * Derive the join-gate hash for a room password.
     * Deterministic: same password + same room code always yields the
     * same 64-char lowercase hex string, on every client.
     * @param {string} password
     * @param {string} roomCode
     * @returns {Promise<string>}
     */
    async function computeRoomGateHash(password, roomCode) {
        const text = String(password) + ':' + String(roomCode);
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
        return toHex(new Uint8Array(digest));
    }

    /**
     * A random 256-bit hash for rooms that must never be joinable by
     * anyone but their creator (solo / daily rooms have no password, but
     * remain isPrivate). No password can ever derive it, so every join
     * attempt fails the rules gate.
     * @returns {string} 64-char lowercase hex
     */
    function randomGateHash() {
        const buf = new Uint8Array(32);
        crypto.getRandomValues(buf);
        return toHex(buf);
    }

    return { computeRoomGateHash, randomGateHash };
}));
