// Firestore-emulator harness for the Arena security-rules suite.
//
// Philosophy: plain REST against the emulator, zero npm dependencies. The
// emulator accepts two kinds of Authorization header:
//   - `Bearer owner`  - admin bypass (rules skipped), used for seeding.
//   - `Bearer <unsigned JWT>` - impersonation: an alg:"none" token whose
//     payload becomes request.auth in rules (this is exactly what
//     @firebase/rules-unit-testing builds under the hood). The
//     firebase.sign_in_provider claim drives isRegistered() - 'anonymous'
//     simulates Arena's guest sign-in, 'password' a registered account.
//
// Rules loading: `firebase emulators:start` reads firestore.rules from
// firebase.json, but a prior session proved that path unreliable for
// UPDATED rules (and `emulators:exec` starts happily with garbage rules).
// The reliable path, used here, is the emulator's own
// PUT /emulator/v1/projects/{id}:securityRules endpoint: it COMPILES the
// ruleset (HTTP 400 with line numbers on a syntax error) and swaps it
// live. The suite additionally runs a NEGATIVE CONTROL - load a deny-all
// ruleset, prove an otherwise-allowed read is denied, then load the real
// rules - so a silent no-op load can never fake a green run.
//
// Safety: every URL in this file is hardcoded to 127.0.0.1; the project
// id carries the `demo-` prefix, which firebase-tools treats as
// emulator-only (no credentials, no outbound calls). Production Firebase
// is unreachable by construction.
//
// Availability: needs Java (the Firestore emulator is a jar) and, on
// first run, network to download firebase-tools via npx plus the
// emulator jar (both cached afterwards: ~/.npm/_npx and
// ~/.cache/firebase/emulators). When either is missing the caller skips
// the suite; the CI workflow sets ARENA_RULES_REQUIRE=1 to turn that
// skip into a loud failure instead.
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Pinned so a firebase-tools release can never silently change emulator
// behavior under the suite. Bump deliberately.
export const FIREBASE_TOOLS_VERSION = '15.27.0';
export const PROJECT_ID = 'demo-shevato-arena';
export const EMULATOR_HOST = '127.0.0.1:8085'; // firebase.json emulators.firestore.port

const DOCS_BASE = `http://${EMULATOR_HOST}/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
const ADMIN_BASE = `http://${EMULATOR_HOST}/emulator/v1/projects/${PROJECT_ID}`;

export function javaAvailable() {
    try {
        execFileSync('java', ['-version'], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function emulatorUp() {
    try {
        const res = await fetch(`http://${EMULATOR_HOST}/`, { signal: AbortSignal.timeout(1500) });
        return res.ok;
    } catch {
        return false;
    }
}

/**
 * Start the Firestore emulator via pinned firebase-tools. Returns
 * { ok:true, stop } or { ok:false, reason }. `stop` kills the whole
 * process group (npx -> firebase-tools -> java) and waits for the port
 * to free, so a suite can never leave an emulator behind.
 */
export async function startEmulator({ repoRoot, timeoutMs = 180000 } = {}) {
    if (!javaAvailable()) {
        return { ok: false, reason: 'Java not installed (the Firestore emulator is a jar)' };
    }
    if (await emulatorUp()) {
        return { ok: false, reason: `something already listens on ${EMULATOR_HOST}; refusing to share it` };
    }
    const child = spawn('npx', [
        '-y', `firebase-tools@${FIREBASE_TOOLS_VERSION}`,
        'emulators:start', '--only', 'firestore', '--project', PROJECT_ID,
    ], {
        cwd: repoRoot,            // picks up firebase.json (port 8085, UI disabled)
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,           // own process group, killable as a tree
    });
    let output = '';
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });
    let exited = false;
    child.on('exit', () => { exited = true; });

    const stop = async () => {
        try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
        for (let i = 0; i < 40 && await emulatorUp(); i++) await sleep(250);
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
    };

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (await emulatorUp()) return { ok: true, stop };
        if (exited) {
            return {
                ok: false,
                reason: `firebase-tools exited before the emulator came up (no network for the npx/jar download?): ${output.slice(-300)}`,
            };
        }
        await sleep(500);
    }
    await stop();
    return { ok: false, reason: `emulator did not come up on ${EMULATOR_HOST} within ${timeoutMs}ms` };
}

/**
 * Compile + activate a ruleset on the running emulator. Throws on a
 * compile error (HTTP 400 carries rules line numbers).
 */
export async function loadRules(rulesText) {
    const res = await fetch(`${ADMIN_BASE}:securityRules`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rules: { files: [{ name: 'security.rules', content: rulesText }] } }),
    });
    if (!res.ok) {
        throw new Error(`rules load failed (${res.status}): ${await res.text()}`);
    }
}

export function loadRulesFile(path) {
    return loadRules(readFileSync(path, 'utf8'));
}

export const DENY_ALL_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if false; }
  }
}`;

/** Wipe every document (data persists across runs otherwise, turning creates into updates). */
export async function clearData() {
    const res = await fetch(`${ADMIN_BASE}/databases/(default)/documents`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`clearFirestore failed: ${res.status}`);
}

/**
 * Unsigned impersonation token: payload becomes request.auth in rules.
 * provider 'anonymous' models Arena guest sign-in; 'password' a real
 * account (isRegistered() true).
 */
export function authToken(uid, provider = 'password') {
    const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const payload = {
        iss: `https://securetoken.google.com/${PROJECT_ID}`,
        aud: PROJECT_ID,
        iat: now,
        exp: now + 3600,
        auth_time: now,
        sub: uid,
        user_id: uid,
        firebase: { sign_in_provider: provider, identities: {} },
    };
    return `${b64u({ alg: 'none', typ: 'JWT' })}.${b64u(payload)}.`;
}

export const OWNER = 'owner'; // admin bypass token (rules skipped)

/* ---------------- Firestore REST value encoding ---------------- */

function toValue(v) {
    if (v === null) return { nullValue: null };
    if (typeof v === 'string') return { stringValue: v };
    if (typeof v === 'boolean') return { booleanValue: v };
    if (typeof v === 'number') {
        return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
    }
    if (Array.isArray(v)) return { arrayValue: { values: v.map(toValue) } };
    if (typeof v === 'object') return { mapValue: { fields: toFields(v) } };
    throw new Error(`unsupported value: ${typeof v}`);
}

function toFields(obj) {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = toValue(v);
    return out;
}

function headers(token) {
    return {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
}

/**
 * All operations return the HTTP status code; tests assert on it.
 *   200 allow, 403 rules deny, 404 allowed-but-missing (read path).
 * `path` is a document path like 'triviaRooms/ABCDE/players/bob'.
 */
export async function createDoc(path, data, token) {
    const i = path.lastIndexOf('/');
    const parent = path.slice(0, i);
    const docId = path.slice(i + 1);
    const res = await fetch(`${DOCS_BASE}/${parent}?documentId=${encodeURIComponent(docId)}`, {
        method: 'POST',
        headers: headers(token),
        body: JSON.stringify({ fields: toFields(data) }),
    });
    return res.status;
}

/** Field-masked update; precondition exists=true so it can never become a create. */
export async function updateDoc(path, data, token) {
    const mask = Object.keys(data)
        .map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`)
        .join('&');
    const res = await fetch(`${DOCS_BASE}/${path}?currentDocument.exists=true&${mask}`, {
        method: 'PATCH',
        headers: headers(token),
        body: JSON.stringify({ fields: toFields(data) }),
    });
    return res.status;
}

export async function getDoc(path, token) {
    const res = await fetch(`${DOCS_BASE}/${path}`, { headers: headers(token) });
    return res.status;
}

export async function deleteDoc(path, token) {
    // exists precondition so deleting a missing doc reads 404, not 200 -
    // otherwise a rules DENY (403) and a silently-missing doc would be
    // indistinguishable from success in a sloppy assertion.
    const res = await fetch(`${DOCS_BASE}/${path}?currentDocument.exists=true`, {
        method: 'DELETE',
        headers: headers(token),
    });
    return res.status;
}

/** List a collection (exercises `list` rules, distinct from `get`). */
export async function listDocs(collectionPath, token) {
    const res = await fetch(`${DOCS_BASE}/${collectionPath}`, { headers: headers(token) });
    return res.status;
}
