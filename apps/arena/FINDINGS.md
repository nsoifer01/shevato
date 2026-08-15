# Arena - engineering findings

Living document: rewrite sections as understanding improves. Started
2026-08-15 during the security + emulator-testing round (TESTING-AUDIT.md
defects 22-25).

## Room password security architecture (defect 22)

The room password is never persisted anywhere. Full design in the README
("Room password security"); the reasoning a future session needs:

- **Why a hash in a subdocument and not field-level rules**: Firestore
  rules cannot hide a single field of a readable doc, so the secret had
  to move to its own doc (`triviaRooms/{code}/private/gate`) with
  `allow read: if false`. Rules `get()` inside the member-create
  condition reads it server-side regardless of client read permissions.
- **Why the hash is salted with the room code**: identical passwords in
  two rooms must not produce identical gate hashes.
- **Accepted replay boundary**: the joiner's proof (`gateHash` on their
  player doc) is readable by any signed-in user with the code and can be
  replayed for room ENTRY. Closing that would mean either restricting
  player-doc reads to members (breaks the pre-join capacity check and
  the post-match spectator view) or a per-join challenge (needs a
  server). The defect being fixed was cleartext PASSWORD disclosure -
  users reuse passwords - and that is fully closed. Do not "fix" the
  replay boundary casually; it is pinned by a rules test that documents
  it.
- **Solo/daily rooms** are `isPrivate` with no password. Pre-migration
  they were unjoinable because `'' !== data.password` always failed;
  post-migration they store `randomGateHash()` (256 random bits), which
  no password can derive. Removing that would silently make solo rooms
  joinable by anyone with the code.
- **Rules forbid a `password` key on room CREATE only.** Updates must
  stay permissive: legacy rooms still carry the field, and every host
  update evaluates `request.resource.data` as the full post-state
  (which includes the legacy field). A stale cached client that still
  writes cleartext passwords will fail room creation until it reloads -
  accepted, transient.
- The host's own member-doc create must also pass the gate (the gate doc
  is written before `joinPlayer`), so `createRoom` passes the same hash
  it just wrote.

## Firestore emulator harness (defect 23 + the multiplayer e2e)

`apps/arena/tests-rules/emulator-harness.mjs` is plain REST, zero deps.
Gotchas that cost time, so they are recorded:

- **`emulators:start` DID auto-load repo rules at startup in v15.27.0**,
  but per the 2026-08-04 maptap round, `emulators:exec` does not compile
  updated rules reliably. The reliable, verified path is
  `PUT /emulator/v1/projects/{id}:securityRules` - it compiles (HTTP 400
  with rules line numbers) and swaps live. Every suite still runs a
  deny-all negative control first so a silent no-op load can never fake
  a green run.
- **Impersonation tokens**: unsigned JWTs (`alg:"none"`, empty signature,
  `b64url(header).b64url(payload).`) in the Authorization header; the
  payload becomes `request.auth`. `firebase.sign_in_provider:
  'anonymous'` models guest sign-in and fails `isRegistered()`.
  `Bearer owner` bypasses rules entirely (fixture seeding, raw doc
  inspection).
- **The emulator is multi-project**: data AND rules are namespaced per
  project id. The rules suite uses `demo-shevato-arena` (the `demo-`
  prefix keeps firebase-tools fully offline); the e2e must load rules
  and clear data for `shevato-site`, because that is the projectId baked
  into `firebase-config.js` and therefore the namespace the app's
  traffic lands in.
- **Emulator data persists across runs** - always clear
  (`DELETE .../databases/(default)/documents`) or creates silently
  become updates and create-only rules stop being exercised.
- **Teardown**: firebase-tools spawns a java child; spawn with
  `detached: true` and kill the process group, then wait for BOTH 8085
  and the hub port 4400 to free (the hub lingers a second after
  SIGTERM).
- **Deletes in tests carry `currentDocument.exists=true`** so deleting a
  missing doc reads 404 instead of 200 - otherwise a rules deny and a
  missing fixture would be indistinguishable from success.
- firebase-tools is pinned (15.27.0) via `npx -y`, cached in
  `~/.npm/_npx`; the Firestore jar caches in `~/.cache/firebase/emulators`.
  Not a package.json devDependency on purpose: `npm ci` in the other
  workflows stays fast and the push/PR CI stays dependency-free.

## Two-client e2e gotchas (apps/arena/e2e/emulator.mjs)

- **The host's entire game clock runs in a rAF loop** (early reveal,
  question advance, finish - the timer loop in app.js), and headless
  Chrome PAUSES requestAnimationFrame in background tabs. The host page
  must be kept foreground (`Page.bringToFront`); the joiner is fine in
  the background because its UI is driven by Firestore snapshot
  callbacks and CDP input reaches background targets.
- **Two players in one browser profile share origin storage** (and thus
  one Firebase auth user - firebase-config even broadcasts auth changes
  cross-tab). Serve one page from `127.0.0.1:<port>` and the other from
  `localhost:<port>`: same static server, different origins, isolated
  auth. Both hostnames satisfy the emulator seam.
- **The shared sync-modal integration opens a full-screen modal and then
  RELOADS the page** whenever a user signs in after initial page load -
  exactly what the guest-auth bootstrap on create/join does. Coordinate
  clicks land on `.sync-modal-content` instead of the app. Its own 30s
  dedupe (`sessionStorage['lastSyncModalTime']`) suppresses it; the e2e
  pre-seeds that key. This also means in PRODUCTION a first-time guest
  probably gets the sync modal + reload right after creating/joining
  (the ?room= URL re-enters the room, masking it). Worth an owner look.
- **Auth-emulator URLs embed the production hostname in the PATH**
  (`http://127.0.0.1:9099/identitytoolkit.googleapis.com/...`), so a
  substring block on production hosts would kill emulator traffic too -
  match on the URL's host portion only.
- **Rematch UI reality**: the propose control that exists in the markup
  is the header `#room-end-again-btn`; `renderRematchUI`'s
  `#end-again-btn` (and the `#rematch-strip` accept buttons it drives)
  reference an element that is NOT in index.html - the propose button it
  toggles is always null (null-guarded, silent). The accept path users
  actually see is the shared confirm modal (`#confirm-modal-confirm`,
  10s auto-decline). Latent dead code, left as-is (out of scope this
  round).
- **Leaving always routes through the confirm modal** - a bare
  `#leave-room-btn` click does nothing until `#confirm-modal-confirm`.
- Dropped as flaky-by-design rather than shipped flaky: console-error
  assertions (the Firestore SDK logs transport noise against emulators)
  and exact score values (speed bonus depends on answer latency; the
  suite asserts positive AND identical across clients instead).

## Known modeled limitations (pinned by tests, not bugs introduced here)

- **Host-handoff `isHost` flag write is dead**: `leaveRoom` tries to set
  `isHost: true` on the NEXT host's player doc, which the ownership rule
  denies (only you write your doc). The app swallows the error and the
  UI keys off `roomData.hostUid`, which the room-doc update does change.
  Pinned in the rules suite; fixing it would need a rules carve-out or
  removing the write.
- The gateHash replay boundary (see above).

## Decisions this round

- **Defect 25 decided 2026-08-15**: trivia accuracy divides by TOTAL
  rounds (skipped = miss), matching Globe Drop. `aggregateAnswerStats`
  takes `totalRounds`; the only production caller passes
  `roomData.totalQuestions`. The legacy no-argument fallback keeps the
  answered-count denominator so nothing else changes meaning.
- **Defect 24**: `normalizeRoomCode` is the single validity notion
  (length AND alphabet); `parseUrlState` routes through it. Codes with
  0/O/1/I/L are rejected before any Firestore lookup.
- **RTDB rules are not emulator-tested** (database.rules.json): they
  cover only the sync system's per-user namespace, arena never touches
  RTDB, and the equivalent Firestore sync namespace has a no-regression
  rules test. The RTDB emulator still RUNS in the e2e because the seam
  points the page's rtdb handle at 127.0.0.1:9000 and the shared sync
  scripts hold an RTDB reference.
- privacy.html verified: it makes no claims about room passwords (only
  that rooms are readable by signed-in visitors with the code), so no
  change was needed for the hashing migration.
