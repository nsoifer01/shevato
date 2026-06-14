# Football H2H

**A head-to-head football match tracker built for exactly two named humans — log scores (and penalty shootouts), then watch your running record, streaks, and per-player stats update.**

## How it works

Football H2H tracks repeated matches between two players (Player 1 vs Player 2). There is no per-footballer roster — each record is a single game with the two players' goal totals, an optional penalty-shootout winner (for drawn regulation scores), an optional team per player, and a timestamp. Adding a game from the sidebar form appends it to the games list; everything else (records, streaks, the comparison table, the matchup lookup) is derived from that list on the fly.

All state lives in the browser's `localStorage` — there is no backend or account required. The keys are `footballH2HGames` (the match list), `footballH2HPlayers` (the two player names), and `footballH2HPlayerIcons` (each player's chosen emoji). A silent auto-backup snapshot is also written to `footballH2HAutoBackup` every 10 minutes as a safety net (no restore UI — recover via devtools if ever needed). The page also wires into the shared Shevato sync system, which mirrors the `footballH2H*` keys to Firebase storage when signed in.

## Features

| Feature | What it does |
| ------- | ------------ |
| Add a game | Sidebar form captures each player's goals, an optional team per player, and a game date; saves to the match list. |
| Penalty shootouts | When regulation goals are equal, a penalty-result field appears; the winner (Player 1, Player 2, or a true draw) is stored and counts the drawn match as a win for that player. |
| Player names & icons | Rename either player and pick an emoji icon (Sports / Animals / General categories); names and icons flow through every stat label, table header, and dropdown. |
| Teams per match | Each player's team is recorded from per-league dropdowns (e.g. National Teams) or a custom "Other" name, defaulting to "Ultimate Team". |
| H2H Stats tab | Total wins per player plus draws, a current-streak badge, and separate 90-minute-win and penalty-win tallies. |
| General Stats tab | Total games, goals per game, total penalty shootouts, and a team-matchup lookup. |
| Team matchup lookup | Pick a team for either side ("Any" allowed) to see the win/draw/win record across only the games with that team pairing. |
| Player Stats tab | A side-by-side comparison table of per-player derived stats with the better value tinted toward its player. |
| Comparison-table stats | Total goals, goals/game, highest score (with the match detail), median score, scoring rate, multi-goal-game %, current winning/losing/scoring/scoreless streaks plus longest winning/scoring/scoreless streaks (penalty-aware, with date spans), last-3 and last-5 averages, and a consistency (std-dev) row. |
| Streak badge | Surfaces the live rivalry streak — e.g. "Alex – 3 match winning streak" — using penalty-aware match results, or "No current streak". |
| Recent form strip | A W/L/D dot strip of each player's last 5 match results. |
| Session summary | Generates a copyable text recap of the (filtered) games: per-player win record, total goals, the session winner, and a line per match. |
| Game history table | Sortable by game #, date, or either player's goals; each row supports inline edit and delete. |
| Date filtering | Filter the history and stats to All Time, Today, Last 7 Days, Last 30 Days, or a custom from/to range. |
| Undo / redo | Add, edit, and delete actions push to a history stack so the last action can be undone and redone. |
| Export / import | Export all games and player names to a JSON file; import validates the payload shape before loading it back. |
| Cloud sync | Opt-in Firebase sync mirrors the local data across devices; an offline banner shows when sync is unavailable. |

## Viewing locally

The app is fully static and persists to `localStorage`, so any static file server works:

```sh
cd apps/football-h2h
python3 -m http.server 8000
# open http://localhost:8000
```

Opening `index.html` directly over `file://` works for the core tracker, but the shared header/footer includes and the Firebase sync layer expect to be served over HTTP.

## Running tests

```sh
npm run test:football
```

This runs `node --test` over `apps/football-h2h/tests/`, which covers the pure match-logic helpers (sorting, ID assignment, import-payload validation) and the player-stats module (per-player stats, penalty-aware match results, streak and run detection, and the comparison-table formatters).
