// The quota compare-and-swap in lib/blob-cas.mjs is only atomic when the
// installed @netlify/blobs forwards `onlyIfMatch` / `onlyIfNew` from setJSON
// onto the wire. That capability arrived late and quietly:
//
//   8.x        setJSON(key, data, { metadata }) - the condition is not even a
//              parameter, and the call resolves undefined
//   10.0-10.1  setJSON accepts the option and spreads it into the wrong field,
//              so no If-Match header is sent; only set() is conditional
//   10.7.13    setJSON forwards the condition and maps 412 -> { modified:false }
//
// The package was declared `^8.1.0` for the 25 days after the CAS landed, so
// every reservation was a plain read-modify-write while the tests (which stub
// the store with conditional semantics the real client did not have) stayed
// green. Fifty concurrent writers against one remaining slot were all told
// "reserved". These tests are the guard the stubs cannot be: they read the
// DECLARED ranges and the LOCKED version, and they drive the REAL installed
// client against a fake edge to prove the header is on the wire.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

// Lowest version whose setJSON actually forwards the condition.
const MIN = { major: 10, minor: 7 };

function parseFloor(range) {
  const m = /^\^?(\d+)\.(\d+)\.(\d+)$/.exec(String(range).trim());
  assert.ok(m, `@netlify/blobs range "${range}" is not a simple caret/exact version`);
  return { major: Number(m[1]), minor: Number(m[2]) };
}

const atLeastMin = (v) => v.major > MIN.major || (v.major === MIN.major && v.minor >= MIN.minor);

for (const manifest of ['package.json', 'netlify/functions/package.json']) {
  test(`${manifest} declares an @netlify/blobs whose setJSON is conditional`, () => {
    const pkg = readJson(join(repoRoot, manifest));
    const range = pkg.dependencies?.['@netlify/blobs'];
    assert.ok(range, `${manifest} must declare @netlify/blobs`);
    const floor = parseFloor(range);
    assert.ok(
      atLeastMin(floor),
      `${manifest} declares @netlify/blobs ${range}; setJSON only forwards `
      + `onlyIfMatch from ${MIN.major}.${MIN.minor}, so the quota CAS would be inert`
    );
    // A caret range on 10.x cannot drift to 11.x (different major), so the
    // floor is also the guarantee. Reject a bare "*" or ">=" style range.
    assert.ok(/^\^?\d/.test(range.trim()), `${manifest}: pin a caret or exact version, got "${range}"`);
  });
}

test('the committed lockfile resolves @netlify/blobs to a conditional-setJSON version', () => {
  const lock = readJson(join(repoRoot, 'package-lock.json'));
  const entry = lock.packages?.['node_modules/@netlify/blobs'];
  assert.ok(entry, 'package-lock.json must carry a resolved @netlify/blobs');
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(entry.version);
  assert.ok(m, `locked version "${entry.version}" is not a plain semver`);
  const locked = { major: Number(m[1]), minor: Number(m[2]) };
  assert.ok(
    atLeastMin(locked),
    `package-lock.json resolves @netlify/blobs ${entry.version}; needs >= ${MIN.major}.${MIN.minor}`
  );
});

// CI deliberately never runs `npm install` (the fast gate is dependency-free),
// so on a runner there is no client to drive. The two version assertions above
// are the guard that always runs and they need nothing installed; this one adds
// proof that the DECLARED version really behaves, and gates itself rather than
// failing where the package is simply absent.
let clientAvailable = true;
try {
  await import('@netlify/blobs');
} catch {
  clientAvailable = false;
}

test('the REAL installed client puts the etag condition on the wire', {
  skip: clientAvailable ? false : '@netlify/blobs is not installed here (CI runs no npm install); the declared and locked version assertions above still ran',
}, async () => {
  // Not a stub: this is the client the functions bundle. A version that drops
  // the condition sends no If-Match and resolves undefined, which is exactly
  // the failure that hid for 25 days.
  const { getStore } = await import('@netlify/blobs');

  const sent = [];
  const store = getStore({
    name: 'cas-version-probe',
    siteID: 'site',
    token: 'token',
    fetch: async (url, opts = {}) => {
      // The client lowercases its verbs, hence the normalisation.
      const method = String(opts.method || 'GET').toUpperCase();
      const headers = new Headers(opts.headers || {});
      const target = String(url);
      sent.push({ method, target, ifMatch: headers.get('if-match') });
      // Two hops: the API answers with a signed URL, then the real write goes
      // to the edge. The condition must ride on the SECOND one.
      if (/api\.netlify\.com/.test(target)) {
        return new Response(JSON.stringify({ url: 'https://edge.example/blob' }), {
          status: 200, headers: { 'content-type': 'application/json' }
        });
      }
      // Refuse the conditional write the way the edge refuses a stale etag.
      if (method === 'PUT') return new Response('', { status: 412 });
      return new Response('', { status: 404 });
    }
  });

  const res = await store.setJSON('probe', { n: 1 }, { onlyIfMatch: '"stale-etag"' });

  assert.deepEqual(
    res, { modified: false },
    'a refused conditional setJSON must resolve { modified: false }; '
    + 'undefined or { modified: true } means this @netlify/blobs ignored the condition'
  );
  const edgeWrites = sent.filter((r) => r.method === 'PUT' && !/api\.netlify\.com/.test(r.target));
  assert.ok(edgeWrites.length > 0, `expected a PUT to the blob edge, got ${JSON.stringify(sent)}`);
  assert.ok(
    edgeWrites.every((r) => r.ifMatch === '"stale-etag"'),
    `expected If-Match on every edge write, got ${JSON.stringify(edgeWrites)}`
  );
});
