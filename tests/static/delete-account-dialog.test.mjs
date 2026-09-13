// The delete-account confirmation must describe what deleteAccount() does
// (2026-09-12 audit S-6).
//
// Since the 2026-09-05 audit (F18), deleting an account deletes the Arena
// leaderboard row and every Globe Drop daily-challenge score, and replaces the
// player's name on shared head-to-head records with "Former player". The
// sync-system test pins the code and privacy.html says so, but the dialog kept
// its old copy: "This does not remove: your Arena leaderboard row, head-to-head
// records and Globe Drop daily scores. Only leaderboard admins can remove
// those." That is the one sentence a person reads at the moment they decide
// whether to delete, and it told them a public record of them would survive.
//
// Everything below is derived from the orchestrator, the Arena eraser and the
// policy page, so the dialog cannot drift from them again without this failing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(join(REPO_ROOT, p), 'utf8');

const main = read('assets/js/main.js');
const orchestrator = read('sync-system/app-sync-init.js');
const engine = read('sync-system/storage-sync-robust.js');
const privacy = read('privacy.html');

const text = (html) => html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

// The modal template, from its builder to the first input field.
const start = main.indexOf('createDeleteAccountModal(user) {');
const template = main.slice(start, main.indexOf('delete-account-modal__field', start));

/** Items of the <ul> that follows the label whose text matches `label`. */
function listAfter(label) {
  const at = template.search(new RegExp(`delete-account-modal__label">${label}<`));
  if (at === -1) return null;
  const ul = template.slice(template.indexOf('<ul', at), template.indexOf('</ul>', at));
  return [...ul.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => text(m[1]));
}

const removes = listAfter('This removes');
const kept = listAfter('This does not remove');
const anonymousName = (/export const ARENA_ANONYMOUS_NAME = '([^']+)'/.exec(engine) || [])[1];
const erasesArena = /run: eraseArenaIdentity\b/.test(orchestrator);

test('the dialog template and its two lists are found', () => {
  assert.ok(start !== -1, 'createDeleteAccountModal moved; update this test');
  assert.ok(removes && removes.length, 'the "This removes" list must exist');
  assert.ok(kept && kept.length, 'the "This does not remove" list must exist');
  assert.ok(anonymousName, 'ARENA_ANONYMOUS_NAME must be readable from storage-sync-robust.js');
  assert.ok(erasesArena, 'deleteAccount no longer runs eraseArenaIdentity; the assertions below assume it does');
});

test('the dialog says the Arena leaderboard row and daily scores are deleted, not kept', () => {
  const removesText = removes.join(' ');
  assert.match(removesText, /leaderboard/i, 'deleteAccount deletes the leaderboard row, so "This removes" must say so');
  assert.match(removesText, /daily/i, 'deleteAccount deletes every daily-challenge score, so "This removes" must say so');
  const wrong = kept.filter((item) => /leaderboard|daily/i.test(item));
  assert.deepEqual(wrong, [], 'the "does not remove" list must not claim deleted Arena rows survive');
});

test('the dialog says head-to-head records stay, under the anonymous name deletion writes', () => {
  // The record is SHARED with the opponent, so it is kept and the name is
  // replaced. Both halves must be stated: kept, and no longer carrying you.
  const h2h = [...removes, ...kept].filter((item) => /head-to-head/i.test(item));
  assert.equal(h2h.length, 1, 'exactly one item must describe head-to-head records');
  assert.ok(kept.includes(h2h[0]), 'the record itself is not removed, so it belongs under "This does not remove"');
  assert.ok(h2h[0].includes(anonymousName), `it must name what your name becomes ("${anonymousName}")`);
  assert.doesNotMatch(template, /only leaderboard admins can remove/i,
    'the owner-cannot-delete limitation was removed by the deletion path');
});

test('the dialog does not call room chat permanent when the policy says it is deleted with the room', () => {
  const policyDeletesChat = /deleted along with the room when the last player leaves/.test(privacy);
  const chat = kept.filter((item) => /chat/i.test(item));
  assert.equal(chat.length, 1, 'room chat is the one Arena record that outlives an open room; it must be listed');
  if (policyDeletesChat) {
    assert.doesNotMatch(chat[0], /permanent/i, 'privacy.html says chat is deleted with the room');
    assert.match(chat[0], /last player leaves/i, 'and the dialog must say when it goes');
  }
});
