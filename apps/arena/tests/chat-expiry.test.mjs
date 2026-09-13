// Every chat message the app writes carries its own expiry. The TTL policy on
// triviaRooms.expiresAt deletes the room DOCUMENT only, so chat needs a policy
// of its own, and that policy only deletes documents that carry the field.
// firestore.rules refuses a message without it; this pins both send paths
// (text and emoji) so a new one cannot quietly leave it out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');

test('every chat message the app writes carries expiresAt for the chat TTL policy', () => {
  const sends = [...src.matchAll(/addDoc\(collection\(db, 'triviaRooms', [^)]*'chat'\), \{([\s\S]*?)\}\);/g)];
  assert.equal(sends.length, 2, `expected the text and emoji sends, found ${sends.length}`);
  for (const [, body] of sends) {
    assert.match(body, /expiresAt: new Date\(Date\.now\(\) \+ ROOM_TTL_MS\)/);
  }
});
