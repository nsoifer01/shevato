# Test fixtures

Committed JSON that `apps/fpl-planner/tests/*.test.mjs` files read. Engine
tests never hit the network, so these are the only inputs.

Two sets, loaded two different ways:

- **This directory** - the hand-trimmed 2026/27 pre-season corpus below,
  pulled in with static `import ... with { type: 'json' }`.
- **`gw1-2026/`** - a real GW1 capture replayed through five lifecycle states,
  read at runtime with `readFileSync` off a computed path
  (`join(..., 'fixtures', 'gw1-2026')`) in `season-lifecycle.test.mjs`. Because
  nothing imports those files by name, a plain reference search will report
  them as unused; they are not. See "The gw1-2026 lifecycle capture" below.

They were trimmed from a real capture of the public FPL API on 2026-08-10
(`bootstrap-static`, `fixtures`) and then replayed forward, because the 2026/27
season has not kicked off and several states the app must handle cannot be
observed live yet.

| File | What it is |
| --- | --- |
| `bootstrap.json` | A real `bootstrap-static` payload with all 20 teams, all 4 `element_types`, the full `game_config` (settings, rules, scoring), the full 8-entry `chips` catalogue, all 38 events, and 46 players instead of 577. |
| `events-in-season.json` | The same 38 events replayed so GW5 is current, GW1-5 are finished and GW6 is next. Splice it in with `{ ...bootstrap, events }` to test in-season behaviour. |
| `fixtures.json` | GW1-6 only (60 fixtures), GW1-5 finished with scores. |
| `entry.json` | An `entry/{id}` payload for a manager who is 5 gameweeks into the season. |
| `entry-history.json` | `entry/{id}/history`: 5 gameweeks of `current` rows, past seasons, and one chip played (wildcard, GW3). |
| `entry-transfers.json` | `entry/{id}/transfers`, newest first, exactly as FPL serves it. |
| `entry-picks.json` | `entry/{id}/event/5/picks`, a legal 15 with captain and vice armbands. |

## What each fixture deliberately contains

**Players (`bootstrap.json`).** 4 GKP, 15 DEF, 17 MID, 10 FWD across 19 clubs,
picked as two thirds high scorers and one third cheap enablers so a squad
drafted from them can fit inside the 100.0m budget. It includes:

- injured (`status: "i"`), doubtful (`status: "d"` with a
  `chance_of_playing_next_round`) and unavailable (`status: "u"`) players;
- players from the three promoted clubs (Coventry 7, Hull 11, Ipswich 12) with
  zero Premier League minutes, which is the case a naive strength or minutes
  model gets badly wrong;
- players with penalty and set-piece duty, and players with none;
- non-zero `cost_change_start` on some players. The live pre-season payload has
  `cost_change_start: 0` for everyone, so without this the purchase-price
  fallback (`nowCost - costChangeStart`) and the whole selling-price rule would
  be untestable, since every purchase price would equal `now_cost`.

**A blank and a double gameweek (`fixtures.json`).** One GW5 fixture was moved
into GW6, so clubs 4 and 6 have no fixture in GW5 (blank) and two in GW6
(double). The real 2026/27 calendar has exactly 10 fixtures in every gameweek,
so this shape has to be manufactured or it cannot be tested until one appears.

**A squad that exercises every selling-price branch (`entry-picks.json` plus
`entry-transfers.json`).** Of the 15 held players: 5 were transferred in at a
recorded `element_in_cost` (so their purchase price comes from the transfer
log), 3 were never transferred in and have moved in price (so their purchase
price can only come from the fallback), and the rest are unchanged. The set
covers a rise big enough to keep profit, a rise too small to keep any, a price
fall, and no movement at all.

**A self-consistent value.** `entry_history.value` equals the sum of the 15
reconstructed selling prices plus `entry_history.bank`, which is the invariant
`squad.js` asserts. Tests that want the failure path mutate a copy in memory
rather than adding a second fixture.

**A free-transfer replay with a real answer.** The history rows carry 0, 1, 4,
2 and 0 transfers over GW1-5 with a wildcard in GW3, which replays to 3 banked
free transfers going into GW6. The naive answer (1) is wrong, so a test asserting
3 actually proves the replay runs.

## Regenerating

They are hand-maintainable, but they were produced from live payloads. If you
regenerate them, keep the properties listed above: they are what the tests
depend on, and a fixture that quietly loses its injured player or its price
movement turns several tests into assertions that cannot fail.

## The gw1-2026 lifecycle capture

`gw1-2026/` exists because several states the app must survive can only be seen
during a live gameweek, and cannot be reconstructed from a pre-season payload:
FPL clears every player's element totals at the gameweek rollover, and leaves
`finished: false` on fixtures for hours after full time. The set was captured
from the live FPL proxy on 2026-08-21 and 2026-08-22 and replayed forward.

The files are a base plus deltas rather than five whole payloads, which is why
they stay small:

| File | What it is |
| --- | --- |
| `base.json` | The full bootstrap + fixtures pair every state is rebuilt from. `payloadFor(name)` in `season-lifecycle.test.mjs` overlays a delta onto it. |
| `manifest.json` | The register of captured states. Each entry records `withMinutes` (players with recorded minutes) and `startedFixtures`, so a regenerated capture that silently loses its distinguishing property is visible. |
| `preseason.json` | Before kickoff: 251 players carry minutes from last season, no fixture started. |
| `rollover-cleared.json` | Immediately after the GW rollover: totals wiped to 0 minutes, still no fixture started. This is the state that broke projections in the GW1 incident. |
| `match-in-play.json` | One fixture started, 13 players with minutes. |
| `ft-provisional.json` | One fixture at provisional full time - `finished_provisional` true while `finished` is still false. |
| `ft-provisional.live.json` | The matching live-scoring payload, fed to `buildLiveStats`. |
| `ft-provisional.picks.json` | The matching `entry/{id}/event/{gw}/picks` payload, fed to `buildSquadState`. |
| `live-2026-08-22.json` | A later real capture: GW1 current, 6 of 10 fixtures at provisional full time, totals cleared at the rollover. |

Each delta carries a `totals` table (`fields` + row arrays keyed by player id)
and a `fixturePhases` map (`s` started, `f` finished, `p` finished_provisional).
Regenerating one means re-capturing from the proxy during the equivalent live
moment; the `manifest.json` counts are the check that you captured the state you
meant to.

