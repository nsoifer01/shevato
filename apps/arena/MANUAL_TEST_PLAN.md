# Arena — Manual Test Plan (10-improvement bundle)

Step-by-step browser instructions for exercising the new features in
`feature/all-site` end-to-end.

**Setup**

1. From the repo root, start a local server:
   ```bash
   python3 -m http.server 8080
   ```
2. Open **two browsers** (or one normal window + one incognito) — most
   multiplayer tests need two distinct signed-in accounts. Use Chrome
   for "Player A" and a different browser / profile for "Player B". A
   third browser helps with Emoji Chain (3+ players).
3. In each browser, navigate to `http://127.0.0.1:8080/apps/arena/`.
4. Sign in or play as guest in both browsers. For the full feature set
   (profile stats, daily leaderboards) sign in with a real account in
   at least one browser.

---

## #1 — Premium activation prep

**No runtime test.** This PR documents the activation path; the flag
stays `false`. Verify the doc reads sensibly:

1. Open `apps/arena/PREMIUM_SETUP.md`.
2. Confirm the new sections: **Grandfathering active users** and
   **Pre-launch sanity checklist**.

✅ Pass = doc renders, no broken links.

---

## #2 — Daily Trivia challenge

1. In Player A's browser, on the Arena lobby, click the **Trivia**
   game-type tab.
2. Confirm a **"Today's Trivia challenge"** button appears.
3. Click it. Wait for "Loading today's Trivia…" → game starts with
   10 questions, no category-picker step.
4. Play through to the end. Note your final score.
5. Click **Leaderboard** in the top nav.
6. Scroll past the Globe Drop daily section — confirm a new
   **"Today's Trivia challenge"** section renders with your score
   in the table.
7. In Player B's browser, repeat steps 1–4. Confirm the **same 10
   questions** appear (deterministic per UTC date).
8. Refresh Player A's leaderboard — both players' scores should appear,
   ranked by score.

✅ Pass = same questions in both browsers + both rows visible on the
daily Trivia board.

---

## #3 — In-session game switch

1. Player A creates a Globe Drop room. Share the room code with
   Player B who joins.
2. Play the round to completion (or skip rounds until the **End**
   stage renders).
3. Verify three buttons appear under the "You won!" / final-score
   summary: **Copy link**, **Share card**, **Switch to Trivia**.
4. Player A clicks **Switch to Trivia**.
5. Confirm: room flips back to the lobby for **both players**, the
   game-type toggle shows Trivia as the active mode, and Trivia
   settings are visible.
6. Player A clicks **Start game**.
7. Confirm Trivia begins for both players with fresh questions and
   reset scores (everyone back to 0).
8. Repeat in reverse: end Trivia → **Switch to Globe Drop** →
   confirm globe + locations reload.

✅ Pass = clean round-trip in both directions, scores reset, no errors
in the console.

---

## #4 — Shareable result card (`?postMatch` link)

1. Finish any game with at least 2 players.
2. On the End stage, click **Copy link**.
3. Verify a toast confirms "Recap link copied". On mobile the
   native share sheet may open instead — pick **Copy**.
4. Open a **brand-new browser tab** (incognito works too) and paste
   the URL. It should look like:
   `http://127.0.0.1:8080/apps/arena/?postMatch=ABCDE`
5. Sign in / let guest auth kick in.
6. Confirm the tab lands on the read-only end-stage recap: podium,
   final scoreboard, and per-round breakdown, **without** joining
   the room as a player (your name does not appear in the player
   list).
7. Click **Play** in the nav — the URL clears, you're back on the
   lobby.

✅ Pass = recap renders for the third-party viewer; original room
state is untouched.

---

## #5 — Spectator banner polish

Needs a third browser to join mid-game.

1. Players A + B create + join a Globe Drop room with **3+ locations**.
2. Start the game. As soon as the first location appears, in a
   **third** browser, join the same room (paste the code).
3. The third player should see a **purple/cyan banner** with text like:
   `👁 Spectating · you join after this location (2 locations left)`
   (the count depends on how many locations are configured).
4. Wait for Player A / B to submit; the round resolves.
5. As the room advances to the next location, the spectator banner
   disappears and a **toast** appears reading
   **"You're in — next round counts!"**.
6. Confirm the third player can now place a guess.

✅ Pass = banner shows count, transition toast fires once, third
player is active from the next round.

---

## #6 — Word Blitz game

1. Player A opens the lobby, clicks the **Word Blitz** game-type tab.
2. Confirm two new fields: **Rounds per game** (8/10/12) and
   **Time per word** (8/10/15).
3. Choose 8 rounds, 10 seconds. Create the room.
4. Player B joins via room code.
5. Player A clicks **Start game**.
6. Both browsers should land on the Word Blitz stage:
   - Centered word display in mono font.
   - Text input + Submit button.
   - Timer ring counting down from 10.
   - Live standings on the mini-board.
7. **Both players type the word as fast as possible.** First correct
   submission claims the round.
8. Verify the winner's score increments by **100** and a winner
   banner reads `You got it! +100 — next word in a moment…`
   (for the loser: `<Name> got it first.`).
9. After ~2 seconds, the next word appears. Repeat.
10. Test the **wrong-word path**: type "potato" (or anything that's
    not the target). Verify the status reads
    `Not quite — keep typing!` and you can re-submit.
11. Test the **timeout path**: don't type anything until time runs
    out. Verify the banner reads `Time! No winner this round.` and
    the next word starts.
12. Finish all 8 rounds — confirm the end stage shows correct totals.

✅ Pass = winner-claim is atomic (no double-credit if both submit
near-simultaneously), the timer ring animates, no console errors.

---

## #7 — Per-game profile stats tabs

Requires real signed-in account (guests have no profile).

1. After playing a few rounds in both Globe Drop and Trivia,
   click **Profile** in the nav.
2. Confirm a **headline stats row** (Avg score / Games / Win %)
   sits at the top.
3. Below it, confirm a **tab toggle** with two pills:
   **🗺️ Globe Drop** (active by default) and **🎯 Trivia**.
4. Globe Drop pane should show: Games, Wins, Bullseyes, Best round
   — all from your Globe Drop matches.
5. Click **Trivia**. The tab swaps to: Games, Wins, Avg score,
   Best round — all from Trivia matches only.
6. If you've never played one game type, the empty-state text
   `Play a {GameType} game to start tracking these.` should render
   below the stats.
7. Bullseyes should never be > 0 for the Trivia tab (only Globe
   Drop produces bullseyes ≥ 98).

✅ Pass = both panes render, tabs swap, numbers reflect actual
per-game-type play.

---

## #8 — Rejoin after disconnect

1. Player A creates any room. Note the room code.
2. **Close the tab** (or hard-refresh `Ctrl/Cmd+Shift+R` while not
   on the `?room=` URL — easiest: navigate to `apps/arena/` without
   the room param).
3. Within **2 hours**, open `http://127.0.0.1:8080/apps/arena/` in
   the same browser profile.
4. Confirm a banner appears above the Create/Join cards:
   `↩️ You were just in ABCDE. Pick up where you left off?`
   with **Rejoin** + **Dismiss** buttons.
5. Click **Rejoin** → should land back in the room.
6. Repeat steps 1–4. This time click **Dismiss**. Confirm the
   banner disappears and stays gone after refresh.
7. **Negative case**: end any game and click **Leave room** from
   the room header. Confirm the breadcrumb is cleared — refreshing
   `apps/arena/` shows no rejoin banner.

✅ Pass = banner triggers on tab-close path, dismiss is sticky,
explicit-leave clears it.

---

## #9 — Emoji Chain game

Needs **3 browsers** (1 prompter + 2 guessers minimum for the voting
phase to be meaningful).

1. Player A opens the lobby, clicks the **Emoji Chain** tab.
2. Confirm two fields: **Rounds per game** (3/5) and **Time per
   phase** (30/45/60).
3. Pick 3 rounds, 45 seconds. Create the room.
4. Players B + C join.
5. Player A clicks **Start game**.
6. One player is auto-selected as the **prompter** for round 1.
   Their browser shows the secret phrase (e.g., "The Lion King")
   and an emoji input box. Other players see "Waiting on the
   prompter…".
7. The prompter types emoji (e.g., `🦁👑🌅`) and clicks **Send**.
8. All clients flip to the **guessing** phase. Non-prompters see
   the emoji + a text input. The prompter sees a "Waiting on
   guessers…" message.
9. Each guesser types a guess and submits. As soon as the last
   guesser submits, the room flips to **voting**.
10. In voting, everyone sees the emoji + every guess (author + text),
    with **Vote** buttons next to guesses that aren't yours.
11. Each player votes. Once all votes are in, the host's client
    runs scoring and the room flips to **reveal**.
12. Reveal shows the original phrase plus a "Got it: …" / "Nobody
    got it this round." summary.
13. After ~2.5 seconds the next round starts with a different
    prompter (round-robin).
14. After 3 rounds, the End stage opens with a podium.

**Scoring spot-check**:
- A guesser who matches the phrase exactly = **+50**.
- The guess with the most funniest-votes = **+30**.
  Self-votes don't count.
- The prompter gets **+10** if ≥1 guesser was correct.

✅ Pass = full state machine runs without stalls, scoring matches
the table above, no console errors.

---

## #10 — MapTap → Arena bridge

1. Open `http://127.0.0.1:8080/apps/maptap-rivals/`.
2. Scroll past the rival grid. Confirm a banner reads:
   `🗺️ Want a live head-to-head with friends? Play Arena Globe Drop —
   real-time geography rounds in a private room.`
3. Click the **Arena Globe Drop** link. It should open
   `/apps/arena/`.
4. From Arena's lobby, look between the Create + Join cards for the
   reverse banner:
   `📍 Play MapTap.gg daily? Track your H2H stats vs friends in
   MapTap Rivals.`
5. Click the **MapTap Rivals** link — back to the tracker.

✅ Pass = both links resolve, banners render cleanly on every
viewport (try resizing the window).

---

## Regression sweep

Quick smoke checks for things the new code touches:

- **Rematch flow** still works in Globe Drop + Trivia (host proposes,
  others accept, new game starts).
- **Solo Globe Drop** still auto-starts and writes to the daily
  leaderboard (existing flow unchanged).
- **Custom packs** (premium): with `Config.PREMIUM_UI_ENABLED = false`
  (default), the upload textarea is hidden — verify the lobby and
  profile don't show any premium UI.
- **Chat panel**: open chat in any room, send a message — still works.

---

## Console + network sanity

Open DevTools on each browser:

- **Console** should have no red errors after the smoke tests above.
- **Network** tab: when Daily Trivia / leaderboard panels load,
  confirm Firestore reads succeed (HTTP 200, no 403 rule denials).
- If you see `triviaDailyLeaderboard` or `triviaDaily` 403s, the
  Firestore rules in this PR were not deployed — run
  `firebase deploy --only firestore:rules` before retesting.

---

## Reporting bugs

If anything doesn't match the ✅ Pass criteria above, capture:
- Which player (A/B/C) saw the issue.
- The game type + step number.
- A console screenshot.
- The room code (if applicable).
- Any Firestore error in the network tab.

File against the bundled PR.
