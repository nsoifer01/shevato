# Arena

**A browser-only real-time multiplayer hub: create a private room, share an invite link, and play short party games with friends — no accounts, no app install, no matchmaking with strangers.**

Two games ship today — **Globe Drop** (pin locations on a 3D globe) and **Trivia** (head-to-head multiple choice) — with room mechanics shared between them.

## How it works

1. A player creates a room from the lobby. Room codes are 5 characters from an unambiguous alphabet (no `0/O`, `1/I/L`) so they're easy to read aloud, and a copyable invite link is generated from the code. Friends who open the link auto-join the room.
2. Room state lives in Firestore (collection `triviaRooms/{code}`, with a `chat` subcollection). Every client subscribes to the room document, so players joining, the timer, scores, and the current question/location all sync live — `js/app.js` is the only file that imports the Firestore SDK directly (via the shared `firebase-config.js`).
3. The host configures the game in the lobby — game type, round type, difficulty, locations/questions count, and timer — then starts it. The first question/location appears for all players at once.
4. Each round runs through phases (`idle` → `asking` → `reveal` → `ended`) computed by pure helpers in `js/room-state.js` off server timestamps, so every client agrees on timing. When all players have answered, the host writes an early-reveal flag that collapses the asking window in lockstep.
5. After the configured number of rounds the game ends with a final scoreboard, a per-question / per-location recap table comparing you against opponents, and detailed per-player stats. Players can rematch or return to the lobby.

The pure game logic (scoring, room state, location/question normalization) is split into small UMD modules under `js/` that export CommonJS for `node:test` **and** attach to `window.BrainArena.*` for the browser. The DOM/Firestore glue lives in `js/app.js`.

## Features

| Feature | What it does |
| --- | --- |
| Private rooms + invite link | Create a room, get a 5-char code and a copyable invite link; friends auto-join when they open the link. |
| Real-time Firestore sync | Players joining, the timer, scores, and the active question/location all update live across every client. |
| Host controls | Host can switch game type in the lobby, edit round settings inline, pause/resume the timer, propose a restart (all players must accept), and end the game. |
| Spectator / latecomer flow | A friend who joins mid-round spectates and is folded into the next round automatically. |
| Host handoff | If the host disconnects, the earliest remaining joiner deterministically becomes the new host (`pickNextHost`). |
| Solo + Daily challenge | Globe Drop can be played solo (a private room of one that auto-starts) or as a Daily challenge that gives every player worldwide the same locations for the UTC calendar day. |
| In-room chat | Per-room chat (subscribed to `triviaRooms/{code}/chat`) with input sanitization, a client-side rate limit, and local profanity moderation (a word-boundary wordlist, so nothing leaves the browser; fail-open if the filter errors). |
| Leaderboard | Global score leaderboard (filterable by time period) plus a separate Daily challenge board scoped to the current UTC day. |
| Display names | You choose a display name before your first published game; the default is a neutral `Player XXXX` derived from your uid, never from your email address. Whatever you choose is written to the shared leaderboard, head-to-head and daily records that any signed-in visitor can read. |
| Head-to-head (H2H) | Per-room cumulative head-to-head record across rematches, plus a global pairwise H2H stats view. |
| Profiles | Firebase Auth profiles tracking total score, games played, and wins. |
| Post-game recap | Final scoreboard plus a side-by-side per-question / per-location recap table and detailed per-player accuracy / response-time (Trivia) or distance / region (Globe Drop) stats. |
| Sound + haptics | WebAudio sound effects and device haptics fire on gameplay events (guess submitted, pin placed/cleared, opponent submitted, score reveal, timer low/expired, chat message, game start/end) via `js/feedback.js`. |

### Trivia

Head-to-head multiple-choice questions. Questions are pulled live from [The Trivia API](https://the-trivia-api.com) (free, no key, CC-BY), normalized into a common `{ question, choices, correctIndex }` shape (`js/live-questions.js`). Between questions the pick-the-category role rotates by question index, snapshotted at game start so latecomers don't shift the rotation.

Scoring (`js/scoring.js`): a correct answer earns `(base + speedBonus) × streakMultiplier`. The speed bonus decays linearly with time remaining (full bonus at instant answer, zero at the buzzer). Consecutive correct answers add +10% each, capped at +50%. A wrong or missed answer scores 0 and resets the streak.

### Globe Drop

Players pin a guess on a 3D Earth (globe.gl / Three.js, NASA Blue Marble texture with no labels or borders) and score on how close they land. Five round types seed the locations: world capitals (bundled `data/countries.json`), country centroids (bundled `data/countries.json`), major cities (Wikidata, pop > 2M), top cities by country (Wikidata, top 10% per country), and UNESCO world landmarks (Wikidata). `data/countries.json` is the REST Countries v3.1 dataset (250 countries, sourced from the project's public GitLab dump) slimmed to the ten fields the game reads — vendored locally because the public REST Countries API was shut down in June 2026 and its v5 replacement requires an API key, which a client-side static app cannot keep secret. The reveal phase shows pins, distances, a country-border overlay (from the bundled world-110m TopoJSON), and a blurb.

Scoring (`js/globe-drop-scoring.js`): the base (0-100) blends a sharp exponential (rewards precision near the target) with a linear ramp to the antipode (keeps a real slope through the whole tail so far guesses still differentiate): `base = floor + (100 - floor) × (W·exp(-distance/2500km) + (1 - W)·max(0, 1 - distance/20015km))`, with `floor = GLOBE_DROP_MIN_BASE_POINTS` and `W = GLOBE_DROP_DISTANCE_EXP_WEIGHT`. It runs from 100 at 0 km down to the floor at the antipode, strictly decreasing the whole way — a closer guess always scores more, even when both guesses are poor, and the tail never collapses into a constant floor. Flooring the base BEFORE the round multiplier keeps the round total exactly `basePoints × multiplier` (no hidden floor-on-total, no streak bonus) and a far guess still earns a few points instead of 0. The in-game reveal, the "Rounds so far" board, and the final recap all show the same `base × multiplier = total`. Each location carries a difficulty multiplier (1.0×–3.0×) derived from how obscure it is — continent, country population and area, obscure island subregions, and dependent-territory status — quantized onto a fixed `[1.0, 1.5, 2.0, 2.5, 3.0]` ladder. The **major cities** round is the exception: since every city in that pack is a large famous metropolis, population barely separates them, so its multiplier is keyed purely off the continent (Europe ×1.0, Americas ×1.5, Asia ×2.0, Africa ×2.5, Oceania ×3.0; see `GLOBE_DROP_MAJOR_CITIES_CONTINENT_MULT`). Three difficulty tiers (easy / medium / hard) control how much geographic context the hint shows. A legacy compound-multiplier path (continent × difficulty × population) still scores rooms created before the per-location model.

## Data model / room state

- **Room code** — 5 chars from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`; `generateRoomCode` / `normalizeRoomCode` create and validate them.
- **Phases** — `questionPhase` and `timeLeftMs` derive the lockstep timing from `questionStartedAt` (+ optional early-reveal flag) so clients don't drift.
- **Decider rotation** — `pickDecider` rotates the category picker by question index over a player order snapshotted at game start.
- **Question pool** — `availableCategoriesFromPool` / `pickQuestionFromPool` track which questions remain unplayed and pick the next one (falling back to any unplayed question when a category is exhausted).
- **Stats aggregation** — `aggregateAnswerStats` (Trivia: accuracy, average response time, by-category) and `aggregateGlobeDropStats` (Globe Drop: total points, average base score, closest/farthest guess, bullseye count, by-region) build the end-of-game cards.
- **Daily determinism** — `js/globe-drop-daily.js` keys the daily challenge on a UTC `YYYY-MM-DD` string and uses a seeded shuffle (`mulberry32` + FNV-1a hash) so every player gets the same locations on the same day.

All runtime constants (timers, scoring weights, difficulty tiers, continent multipliers, room limits) live in `js/config.js`.

## Viewing locally

The app is a static page, but it `fetch`es external data and uses module scripts, so serve the directory rather than opening `file://`:

```sh
cd apps/arena
python3 -m http.server 8000
# open http://localhost:8000
```

Live multiplayer needs the shared Firebase/Firestore config at the repo root (`firebase-config.js`) to point at a real project — without it, rooms, real-time sync, the leaderboard, and Auth profiles won't work, though the pure scoring/geography logic is fully exercised by the test suite. Globe Drop's capitals/countries rounds load from the bundled `data/countries.json` (no network needed); the city/landmark rounds and Trivia still call public, no-key third-party APIs at runtime (Wikidata SPARQL, The Trivia API), so those need network access.

## Running tests

```sh
npm run test:arena
```

The suite (`node --test apps/arena/tests/`) covers the pure modules: trivia scoring and streaks, Globe Drop distance/multiplier/difficulty scoring, room-code generation, daily-challenge determinism, Wikidata/Trivia normalization, and chat sanitization/moderation.
