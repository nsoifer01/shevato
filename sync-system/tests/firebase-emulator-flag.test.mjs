// Proves the firebase-config.js emulator seam is inert in production:
// shouldUseFirebaseEmulators() is the single gate for connecting the SDK
// to local emulators, and it must be false for every deployed hostname
// and for every flag value other than the explicit '1' opt-in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    shouldUseFirebaseEmulators,
    FIREBASE_EMULATOR_FLAG_KEY,
    FIREBASE_EMULATOR_PORTS,
} from '../firebase-emulator-flag.mjs';

test('every production/deployed hostname is refused regardless of the flag', () => {
    for (const host of [
        'shevato.com', 'www.shevato.com', 'shevato.netlify.app',
        'deploy-preview-1--shevato.netlify.app', 'example.com',
        '192.168.1.10', '10.0.0.5', '', undefined, null,
        'localhost.evil.com', '127.0.0.1.evil.com',
    ]) {
        assert.equal(shouldUseFirebaseEmulators(host, '1'), false,
            `${host} must never reach the emulators, even with the flag set`);
    }
});

test('loopback without the explicit opt-in stays on production Firebase', () => {
    for (const flag of [null, undefined, '', '0', 'true', 'yes', 1, '1 ']) {
        assert.equal(shouldUseFirebaseEmulators('127.0.0.1', flag), false,
            `flag value ${JSON.stringify(flag)} is not an opt-in`);
    }
});

test('loopback + explicit "1" opt-in enables the seam', () => {
    assert.equal(shouldUseFirebaseEmulators('127.0.0.1', '1'), true);
    assert.equal(shouldUseFirebaseEmulators('localhost', '1'), true);
    assert.equal(shouldUseFirebaseEmulators('LOCALHOST', '1'), true);
    assert.equal(shouldUseFirebaseEmulators('[::1]', '1'), true);
});

test('flag key and ports are stable contracts (e2e harness + firebase.json depend on them)', () => {
    assert.equal(FIREBASE_EMULATOR_FLAG_KEY, 'shevato:firebase-emulators');
    assert.deepEqual({ ...FIREBASE_EMULATOR_PORTS }, { firestore: 8085, database: 9000, auth: 9099 });
});
