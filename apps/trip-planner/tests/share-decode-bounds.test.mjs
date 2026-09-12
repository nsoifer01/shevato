import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// A SHARE LINK IS UNTRUSTED INPUT, AND IT RUNS ON BOOT.
//
// `enterSharedMode()` decodes `location.hash` automatically when the page
// loads, so everything in a share fragment is attacker-controlled input that
// executes before the traveller does anything. The SEND side has always refused
// a URL over 30,000 characters. The receive side capped nothing: not the
// fragment, not the decompressed size, not the item count.
//
// Measured through the app's own inflate before the fix: a 64,898-character
// fragment expands to 50 MB of JSON, and 41,264 characters yields 200,000
// items, each of which then runs the sanitiser and builds a row. Both fit
// inside any ordinary URL. The failure is a hung or out-of-memory tab for
// someone who clicked a link, not a data breach, which is why this is hardening
// rather than a P0 - but it costs three constants to close.
//
// app.js is a browser IIFE with no module exports, so the bound is verified two
// ways: the real inflate loop is re-run here against a genuine compression
// bomb, and the source is checked to confirm the app is running that shape and
// applying the other two caps.

const APP_SRC = readFileSync(fileURLToPath(new URL('../js/app.js', import.meta.url)), 'utf8');

const MAX_SHARE_BYTES = 2 * 1024 * 1024;

/** The inflate loop exactly as app.js runs it. */
async function boundedInflate(bytes, limit = MAX_SHARE_BYTES) {
  const s = new DecompressionStream('deflate');
  const writer = s.writable.getWriter();
  writer.write(bytes).catch(() => {});
  writer.close().catch(() => {});
  const reader = s.readable.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      try { await reader.cancel(); } catch { /* already closed */ }
      throw new Error('share payload too large');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}

async function deflate(text) {
  const cs = new CompressionStream('deflate');
  const w = cs.writable.getWriter();
  w.write(new TextEncoder().encode(text));
  w.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

test('a compression bomb is refused instead of being inflated', async () => {
  // 13 MB of highly compressible JSON compresses to about half a megabyte,
  // which is a perfectly ordinary URL fragment.
  const payload = JSON.stringify({
    trip: { items: Array.from({ length: 200000 }, (_, i) => ({ id: 'x' + i, type: 'activity', title: 'A'.repeat(24) })) },
  });
  const compressed = await deflate(payload);
  assert.ok(payload.length > 10 * 1024 * 1024, 'the bomb really is large once inflated');
  assert.ok(compressed.length < 1024 * 1024, 'and small enough to travel in a link');

  await assert.rejects(() => boundedInflate(compressed), /too large/);
});

test('an ordinary trip still decodes', async () => {
  const real = JSON.stringify({
    trip: { name: 'Lisbon', items: Array.from({ length: 40 }, (_, i) => ({ id: 'i' + i, type: 'activity', title: 'Museum visit' })) },
  });
  const out = await boundedInflate(await deflate(real));
  assert.deepEqual(JSON.parse(new TextDecoder().decode(out)).trip.items.length, 40);
});

test('the decoder stops reading rather than measuring afterwards', () => {
  // `new Response(stream).arrayBuffer()` reads to completion, so a cap applied
  // after it has already allocated the thing it was meant to prevent. The read
  // loop and the cancel are what make the bound real.
  const fn = /async function streamThrough\([\s\S]*?\n  \}/.exec(APP_SRC);
  assert.ok(fn, 'streamThrough still exists');
  assert.doesNotMatch(fn[0], /new Response\(/, 'must not buffer the whole stream');
  assert.match(fn[0], /reader\.cancel\(\)/, 'must stop pulling once over the limit');
});

test('the fragment length and the item count are both capped on the receive side', () => {
  assert.match(APP_SRC, /MAX_SHARE_FRAGMENT\s*=\s*30000/, 'mirrors the send-side URL refusal');
  assert.match(APP_SRC, /hash\.length - SHARE_PREFIX\.length > MAX_SHARE_FRAGMENT/);
  assert.match(APP_SRC, /trip\.items\.length > MAX_SHARE_ITEMS/);
});
