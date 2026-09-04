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
- **Gate deletion is a lifecycle-gated operation (fixed 2026-08-23).** It
  used to be `allow delete: if request.auth != null`, which was a full
  password bypass, not a cleanup convenience: a stranger with the code could
  `deleteDoc` the gate from the console and the member-create rule's
  `!exists(gate)` branch then admitted them, and every later joiner, with any
  password (the UI still asked for one and ignored it). The gate may now be
  deleted only by the room HOST while the room doc exists, or by anyone once
  the room doc is GONE (the orphan sweep). That is why the teardown order in
  `leaveRoom` matters and must not be "tidied": the last leaver takes over
  `hostUid` if the host is stale, deletes the ROOM DOC FIRST, and only then
  sweeps the gate, chat and leftover player docs. Both branches are things
  the rules can actually verify; "the last leaver" is not. Pinned by
  `tests-rules/rules.test.mjs` "P0 exploit sequence (audit D1)" and "gate
  lifecycle", and by the e2e's two D1-exploit checks driven from a third
  client's own SDK.
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

- **The rAF loops are RENDER-only since 2026-08-23.** Game progression
  (early reveal, advance, finish) lives in `progressRoomClock`, which is
  driven by a 500 ms `setInterval` and by `visibilitychange` as well as by
  the rAF ticks, and any member may perform the timed advance once the
  question window has elapsed plus `ADVANCE_FALLBACK_SLACK_MS` (the rules
  re-check the deadline against the SERVER clock). A hidden or closed host
  therefore no longer freezes the room - it used to sit on a live question
  with no `revealStartedAt` for the full 27 s observed and only moved 2.5 s
  after the host tab was fronted. Headless Chrome still pauses rAF in
  background tabs, so anything that is purely a RENDER (the Globe Drop Ready
  bar, the timer ring) still needs its tab fronted before it can be clicked -
  the e2e fronts B just to vote Ready, then hands the foreground back.
  `Page.captureScreenshot` also HANGS (45 s) on a tab that is not the active
  target, so bring a tab to front before every screenshot.
- **Two players in one browser profile share origin storage** (and thus
  one Firebase auth user - firebase-config even broadcasts auth changes
  cross-tab). Serve one page from `127.0.0.1:<port>` and the other from
  `localhost:<port>`: same static server, different origins, isolated
  auth. Both hostnames satisfy the emulator seam.
- **The shared sync-modal integration skips anonymous users (fixed
  2026-08-23).** It opens a full-screen modal and then RELOADS the page
  whenever a user signs in after initial page load, which is exactly what the
  guest bootstrap on create/join does: a first-time guest clicking "Create
  room" got the white "Sync Complete! Refreshing page..." modal about 10 ms
  after the click and a reload about 1 s later, while `createRoom` was still
  between `setDoc(room)` and `joinPlayer` - back to the lobby, no `?room=`,
  and a room doc with zero player docs left in Firestore forever. Guests have
  no `users/{uid}` namespace, so there was never anything to sync: the
  integration now returns early for `user.isAnonymous`. A REGISTERED sign-in
  still gets the modal and the reload, which is correct and is pinned in both
  layers (`sync-system/tests/sync-modal-integration.test.mjs` and the e2e's
  "D2 boundary" check) so nobody can "fix" the guest case by disabling the
  feature outright. The e2e no longer seeds `sessionStorage.lastSyncModalTime`
  at all; it waits the registered reload out instead.
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
- **Non-host room-doc writes are now an enumerated allow-list, not "client
  of truth" (changed 2026-08-23).** A non-host could set `hostUid`, delete the
  room ("Room closed." for everyone) or write `currentQuestionIndex: -3` /
  `status: 'bogus'` and wedge the room, bypassing the per-player mid-game
  allowances that exist precisely to stop griefing. The rules now let a
  MEMBER (someone who owns a player doc in the room) write only the forms the
  app actually needs, each with `affectedKeys().hasOnly`: pause/resume, end
  the game early, the four rematch fields, the current decider's category
  pick, the timed advance once the server clock says the window elapsed, and
  a `hostUid` takeover naming themselves when the current host's player doc
  is gone or stale. Everything else on the room doc is host-only, and only
  the host may delete it. When adding a room-doc write to app.js, add its
  shape to the matching rules function or it will 403 in production while
  passing locally against stale rules.

## Liveness and cleanup (rebuilt 2026-08-23)

- **Liveness is `RoomState.isPlayerLive`**, mirrored by `isStalePlayerData`
  in `firestore.rules` (change both together, and the constants in
  `js/config.js` with them). A player is live unless they announced a
  disconnect more than `DISCONNECT_GRACE_MS` (30 s) ago, or their `lastSeen`
  heartbeat is older than `PRESENCE_STALE_MS` (120 s). Every client stamps
  `lastSeen` every `PRESENCE_HEARTBEAT_MS` (30 s) from
  `startPresenceAndClock`, so a tab that dies WITHOUT `beforeunload` (crash,
  force-quit, lost network) still goes stale - `disconnectedAt` alone never
  covered that case.
- **Ghosts no longer count anywhere**: early reveal, the Ready-to-skip vote,
  `rematchPlayerCount`, the Start-button minimum and the last-leaver check all
  run over live players only. Before this, a single ghost meant every round
  ran the full timer, a unanimous rematch could never complete, and the room
  was never deleted because "last player" never happened.
- **Liveness expires on a CLOCK, not on a write.** Nothing re-renders when a
  player simply goes stale, so the lobby kept showing a ghost as live
  indefinitely. The 500 ms clock tick recomputes the live-uid signature and
  re-renders when it changes; stale players render as "Disconnected" (dimmed
  tile plus badge, "(away)" in the live boards).
- **The host sweeps stale player docs** (`sweepStalePlayers`, once per uid
  per room). The rules allow a host to delete a player doc ONLY when it is
  stale by the same definition, so a host cannot kick a live player. The old
  comments promised a "host TTL sweep" that did not exist anywhere.
- **Teardown order is load-bearing**: room doc first, then chat, gate and
  leftover player docs (see the gate bullet above). Chat is append-only while
  the room lives - the rules only permit chat deletes once the room doc is
  gone, which is what makes the sweep possible at all without handing anyone
  a mid-game message-recall power.
- **Still not covered: rooms abandoned with no live client left** (everyone
  force-quits, or the last leaver's sweep write fails). Nothing on the client
  can delete them, because the sweep needs a signed-in caller. That is the
  one remaining orphan path and it needs a scheduled server-side job; see the
  note in README "Cleanup".
- **Chat moderation is local.** `chat.js` is a word-boundary wordlist; six
  chat sends produced zero external requests. The user-facing copy now says
  "blocked by the profanity filter" instead of naming a moderation service.
- **H2H writes skip guests on BOTH sides now.** A player doc carries
  `isGuest`, and a registered player skips the lifetime `triviaH2H` pair
  write against a guest opponent - those rows could only ever orphan, since a
  guest uid dies with browser storage.

## Behaviours fixed in the 2026-08-23 remediation round

Each of these was a confirmed audit defect; each is pinned by the test named
beside it, so a regression fails a suite rather than reappearing silently.

- **The Trivia picking stage can no longer stall the room.** `startGame`
  put the room into `status: 'picking'` with a `deciderUid` and there was no
  deadline, no host override and no auto-pick anywhere: a decider who locked
  their phone, backgrounded the tab or just never chose left every player
  staring at "Waiting for X to pick a category" forever, with leaving the
  room the only escape. This is exactly the failure D3 fixed for the asking
  phase, left open one stage earlier, and it is the likeliest real cause of
  the `stage-picking` cascades seen while stabilising the e2e. Entering the
  stage now stamps `pickingStartedAt`; after `PICK_DEADLINE_MS` any MEMBER
  may pick, deterministically (`RoomState.autoPickQuestion`, seeded from room
  code + round + index) so every client agrees without coordination, through
  a transaction whose precondition (still picking, same index, no question
  yet) makes the race idempotent. The decider's own pick still wins whenever
  it lands first. The `renderPickingStage` host fallback now keys off
  LIVENESS rather than mere presence, so a ghost decider hands the pick over
  immediately instead of after a sweep. Pinned by the rules test
  "picking-stage deadline" and the e2e's S7 (the decider goes offline
  mid-picking; the other client still reaches a question, and the decider
  reconnecting does not double-advance).
- **The end screen is a snapshot, not a live render.** It used to rank
  `state.roomPlayers` live, so the first leaver's doc deletion rewrote
  podium, board and recap for everyone still looking at them (the winner
  vanished and the runner-up "took it home"). The finishing write now stamps
  an ordered `finalRanking` on the room doc
  (`RoomState.finalRankingSnapshot`), the end stage renders from it, and
  `endStagePlayers()` keeps the players present at the finish for the recap
  tables. Pinned by the D5 unit tests and the e2e "after the winner leaves"
  check.
- **Profile and leaderboard cannot drift.** `writeEndOfGameStats` used to
  `increment()` the profile but write the leaderboard row from a locally
  mutated `state.profile` copy, and only excluded `playMode === 'solo'` from
  wins, so a one-player daily counted as a win. One pure
  `RoomState.endOfGameStatsDelta` now feeds both, inside a single
  transaction, and a win requires a multiplayer game with 2+ players. Pinned
  by the D8 unit tests and the e2e leaderboard-equals-profile check.
- **A lost answer is disclosed.** `submitAnswer` trusted its optimistic
  render; an answer clicked while offline showed "Locked in" and vanished.
  The catch now clears the optimistic state and either re-arms the buttons
  (window still open) or says the answer was not saved.
- **Chat rate limit stamps `lastSentAt` BEFORE the await**, so a second send
  inside the window is refused (it used to stamp after `await addDoc`, which
  let a 200 ms double-send through). The input also discloses the 280-char
  truncation instead of silently clipping.
- **Double-clicking Start no longer auto-picks a category**: `startGame`
  disables its own button immediately (and re-enables it if the write fails),
  and `pickCategoryAndStart` ignores picks inside a 400 ms settle window
  after the grid renders, because the grid paints under the old button's
  coordinates.
- **A rematch prompt closes on every client** as soon as the proposal dies
  (declined, cancelled, timed out) instead of hanging until its own 10 s
  auto-decline, and closing it that way records no response.
- **Daily runs use the solo end-screen treatment** (a "Final score" hero, no
  podium, no "You won!"), because a daily is a single-player run.
- **Mobile/a11y**: the finished room header wraps at 360 (it overflowed by
  9 px and clipped "Back to lobby"), header controls and the room-code
  buttons meet 44 px, both leaderboard tables are focusable scroll regions
  with a swipe hint, the recap table is a labelled scroll region,
  `aria-label` is gone from the role-less backdrops and check spans,
  "Playing as a guest." meets contrast, Escape restores focus to the
  triggering control, and both password inputs are `type="password"` with a
  Show/Hide toggle. Seeded axe scans inside the e2e (lobby, asking, end at
  1280 and 360, three modals) assert zero serious/critical violations.

## Probe notes (2026-08-22, extended 2026-08-23)

- Emulator probes from a page need `window.firebaseAuth.signInAsGuest()`
  first; an unauthenticated SDK call returns `permission-denied` or a
  null-uid TypeError that looks exactly like a rules deny.
- Arena makes zero RTDB requests; RTDB rules are irrelevant to it.
- **`evaluate()` wraps its argument in `JSON.stringify((...))`**, so a probe
  that passes a STATEMENT (`window.__x = 1; 1`) is a syntax error and returns
  null - silently, looking exactly like the app failing to do something. Pass
  an expression (`(window.__x = 1, 1)`) and assert the marker took before
  relying on it. This faked a "the page reloaded" failure for a whole run.
- **A blocking JS dialog freezes the renderer**, and the next
  `Input.dispatchMouseEvent` then fails with a 45 s `timeout:` error
  somewhere unrelated. The e2e handles `Page.javascriptDialogOpening`,
  dismisses it and records the text, so an `alert()` shows up as evidence
  instead of a mystery hang.
- **A registered sign-up mid-suite reloads the page** (correctly - see the
  sync-modal bullet). Wait the reload out and re-establish any in-page marker
  before driving the UI, or the scenario runs against a wiped page.
- **A coordinate click is only real once the target is the element AT that
  point.** Three separate "the app ignored my click" hunts all ended here:
  an answer button below the fold at 360x740, and a room-header control
  under the site's own fixed header on a long end screen. `clickText` and
  `clickSel` happily report success in both cases and the app never sees the
  click, which then reads as a stalled room several checks later. The suite's
  `safeClick` / `clickAnswerText` scroll the target into view, then wait
  until `elementFromPoint` at its centre resolves to it, and only then click.
- **Confirm writes against the DOCUMENT, not the UI.** An optimistic render
  says "Locked in" before the write lands, so a suite that trusts the click
  measures nothing. Every answer in the multi-client scenarios is confirmed
  by polling the player doc for `currentAnsweredFor`, with a window sized to
  the asking phase rather than to a guess about machine speed.
- **Anchor timing claims to the ROOM's own server clock.** Asserting "the
  Ready vote advanced the round early" from harness wall-clock measured CDP
  latency and failed on a loaded machine; comparing against
  `questionStartedAt + asking + reveal` from the room doc is what the product
  actually promises.
- **Back-to-back runs need the emulator ports to be RELEASED, not just the
  processes killed.** The firestore/database emulators hold 8085/9000/4400
  for several seconds after the runner exits, and the runner correctly
  refuses to share a port (it SKIPs with "something already listens on
  ..."). A loop that starts the next run immediately gets a skipped run, or
  worse kills the previous run mid-scenario. Wait for `ss -ltn` to show every
  port free before starting again.
- **`beforeunload` write announcements are best-effort by browser design.**
  The ghost scenario used to assert that navigating a tab away leaves
  `disconnectedAt` on the player doc; a browser is free to cancel an
  unload-time async write, and roughly one run in four it did. That is not a
  product failure - it is the reason liveness ALSO carries a `lastSeen`
  heartbeat. The check now polls for the announcement and, if the browser
  dropped it, records an explicit SKIP naming the reason, then ages the doc
  through the owner bypass so the assertions that matter (liveness, the
  Disconnected marker, the host sweep, early reveal, rematch counting) still
  run deterministically. That also removed a 31 s real-time sleep.
- **Each scenario runs inside its own guard and starts from the lobby**
  (`resetToLobby`, which leaves cleanly or reloads the page). A CDP
  `Input.dispatchMouseEvent` / `Runtime.evaluate` timeout under machine
  contention used to abort every remaining check; now it fails one scenario.
  `ARENA_E2E_VERBOSE=1` streams each check as it resolves, which is the only
  way to see WHERE a stalled run stalled (the runner prints its tally at the
  end).

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

## Three wrong answer keys in the vendored country dump

`data/countries.json` is the answer key the Globe Drop capitals round scores
against, and three records sent a correct guess thousands of kilometres wrong
while showing a reveal pin on another continent:

| record | was | why it was wrong |
|---|---|---|
| French Southern and Antarctic Lands | `[48.81, -1.4]` | Normandy, the mainland commune the territory is administered from; 12,756 km from Kerguelen |
| Western Sahara | `[-13.28, 27.14]` | latitude and longitude swapped, landing in Zambia; 5,826 km out |
| United States Minor Outlying Islands | capital "Washington DC", no coordinates | the centroid fallback pinned "Washington DC" at Wake Island |

The first two are corrected; the third has its `capital` emptied, so
`normalizeCountry` returns null and the record is never asked about.

`tests/globe-drop-locations.test.js` builds its records by hand
(`rawCountry({...})`), so it proves the normaliser is right and says nothing
about the 250 real records. The new `tests/countries-data.test.js` decodes the
`world-110m` topology the globe already renders and asserts every capital lies
inside, or within 400 km of, its own country's polygon, plus explicit anchors
for the two repaired coordinates. Tolerance is deliberately loose: a 110m
outline is coarse and small islands are missing from it, so the assertion is
"not on the wrong continent", not "pixel accurate".

## escapeHtml has to escape quotes

`escapeHtml` was `div.textContent = value; return div.innerHTML`, which escapes
`&`, `<` and `>` and leaves both quote characters alone, because a text node
does not need them escaped. Arena does not only interpolate into content: it
renders another player's display name into `title="..."` on the podium and
`data-name="..."` in the recap, and display names are trimmed and capped at 20
characters but never quote-stripped. A name like `x" onmouseover="..."` closed
the attribute and planted an event handler in every OTHER player's browser, and
the site CSP is Report-Only with inline script allowed. All five characters are
now escaped, matching the shared `assets/js/escape-html.js`. The same weak
helper in `gym-tracker/js/utils/helpers.js` and `assets/js/main.js` was fixed
at the same time (neither had a reachable attribute interpolation of user text
today, which is one refactor away from being false).

## One game must count once: the end-of-game writes are now idempotent

`writeEndOfGameStats` was guarded only by the in-memory `endStageWrittenForRoom`,
and the end screen is exactly where reloads happen: a pull-to-refresh on a
phone, or reopening the `?postMatch=` link the app itself writes into the URL.
Every reload counted the same game again. Reproduced on the emulator: after two
reloads of the recap, `gamesPlayed` went 1 to 2 to 3 on the profile, on the
PUBLIC `triviaLeaderboard` row and on the room's `sessionMatchCount`, and the
profile card read "Games 3" for one game. `tryLoadPendingPostMatch` calls
`renderEndStage` for any signed-in visitor, so merely opening the share link
was enough.

The guard is a durable key, `lastCountedGame = "{roomCode}:{round}"`, written
in the SAME transaction as the counters it protects, at all three sites:

| doc | field | note |
|---|---|---|
| `users/{uid}.triviaProfile` | `lastCountedGame` | the transaction returns false when it matches, and the leaderboard write is inside that transaction, so both skip together |
| `triviaRooms/{code}` | `sessionCountedGame` | the session tally was a read-modify-write off `state.roomData`; it is a transaction now, reading the counters off the doc |
| `triviaH2H/{pairKey}` | `lastCountedGame` | a lifetime record two people read |

Reading the marker INSIDE the transaction is what makes it safe for two tabs,
two devices, and a reload racing the original write: Firestore re-runs the
transaction on contention and the loser sees the winner's marker. The round is
part of the key, so a rematch is correctly a new game. `maybeWriteDailyLeaderboard`
needed nothing: it already keeps only the best score for the day.

No rules change and no migration. `users/{uid}` and `triviaH2H` accept
arbitrary fields, the room doc is host-writable, and a document with no marker
simply counts its next game once and gains one. Existing leaderboard and
history data is untouched.

## A refresh mid-game must not get you swept

`beforeUnloadCleanup` stamps `disconnectedAt` on the way out, and a refresh
comes straight back through `tryRejoinPendingRoom`, which for an existing
member wrote `lastSeen` alone. The stamp therefore SURVIVED the rejoin, and 30
seconds later both `RoomState.isPlayerLive` and the rules' `isStalePlayerData`
called a player who was heart-beating normally stale: the host swept the doc
and the player was silently dropped mid-game, missing from the early reveal and
the Ready vote, absent from the final ranking, score gone, while their own
answers vanished behind an optimistic "Locked in". Only `joinPlayer`'s
reconnect branch cleared the flag, and a URL rejoin never reaches it.

Two changes, because one of them can be lost: the rejoin write now clears
`disconnectedAt` alongside the heartbeat, and the periodic heartbeat clears it
too. A player whose heart is beating is by definition not disconnected, so a
dropped or racing rejoin write self-heals on the next beat instead of being
fatal half a minute later. The player-doc rules already allow a player to
update their own doc, so no rules change was needed.

## The emulator e2e is FLAKY on a loaded workstation, and what that costs

Three full runs on 2026-09-03 produced 55/76, 48/80 and (S1 only) 8/21, all
failing first at the same place: `emulator: second player joins by code`, the
second client joining a fresh lobby. Everything after it cascades, because the
scenarios share one live multi-client session.

It is NOT caused by the round's changes: the identical failure reproduces with
`apps/arena/js/app.js` reverted to the committed version. Treat a low pass
count here as "re-run on an idle machine", and read the individual scenario
before believing a regression. The documented rule still holds and is easy to
break by accident: run this estate with nothing else heavy on the box. One of
these runs was ruined by a concurrent `npm test`.

Two consequences worth keeping:

- **Filtered runs are for iteration only.** `ARENA_E2E_ONLY` (added this round)
  takes a comma-separated list, but the scenarios are sequential: S1 opens the
  three browser pages and each scenario leaves the clients where the next
  expects them. `ARENA_E2E_ONLY=S1:,S5:` puts only two players in the lobby, so
  the game never starts.
- **Assertions that compare a number against itself must state a
  precondition.** The idempotency checks ask "is this counter unchanged after a
  reload", which 0 -> 0 -> 0 satisfies perfectly. On a filtered run they went
  green having proved nothing. They now assert first that exactly one game was
  counted, and every later check is gated on that. Any new check of this shape
  needs the same guard.

