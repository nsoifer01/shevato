# Cross-season player identity

**Status: FIXED. `code` is the canonical identifier, verified against the archive
rather than assumed. Every replay number measured before 2026-08-11 was produced
with a lossy cross-season join and is superseded.**

This is a data-integrity audit, not a modelling round. Nothing here was changed
to make a model better. One join was wrong, it was fixed, and everything the
wrong join had produced was re-run.

## How it was found

Joining two seasons of the historical archive on `element` and regressing a
player's start rate in season N+1 on his start rate in season N gave a slope of
**0.017**. Start rate is close to the most persistent quantity in the sport, so
the right answer is around 0.7. Re-joining on `name` gave **0.691**, and players
starting 90%+ in season N started about 76% in season N+1.

Reproduced here on all three season pairs, and the id join is not merely weak, it
is empty:

| pair | slope on `element` | slope on `name` | slope on `code` |
| --- | ---: | ---: | ---: |
| 2022-23 -> 2023-24 | 0.057 | 0.867 | 0.878 |
| 2023-24 -> 2024-25 | 0.071 | 0.687 | 0.683 |
| 2024-25 -> 2025-26 | -0.009 | 0.648 | 0.634 |

The same reading as a fact rather than a coefficient. Of the players who started
90%+ of their appearances in season N, the share of appearances they started in
season N+1:

| pair | joined on `element` | joined on `code` |
| --- | ---: | ---: |
| 2023-24 -> 2024-25 | 32.1% | 77.8% |
| 2024-25 -> 2025-26 | 24.0% | 72.6% |

## Why: element ids are recycled wholesale

`element` is a row number in one season's bootstrap. Counting element ids present
in two consecutive seasons and asking how many are the same footballer:

| pair | shared element ids | same player | rate |
| --- | ---: | ---: | ---: |
| 2022-23 -> 2023-24 | 777 | 1 | 0.13% |
| 2023-24 -> 2024-25 | 803 | 0 | 0.00% |
| 2024-25 -> 2025-26 | 804 | 1 | 0.12% |

So a season-to-season join on `element` is not a lossy join, it is a shuffle:

```
el 403: "Nathan Redmond"    -> "Elliot Anderson"
el  58: "Junior Stanislas"  -> "Youri Tielemans"
el 397: "Jadon Sancho"      -> "Ryan Fraser"
el  22: "Tomiyasu Takehiro" -> "Mikel Merino Zazón"
```

It fails silently because a wrong join still returns a full table of plausible
numbers.

## The canonical identifier, measured rather than assumed

`code` is widely believed to be a permanent per-player FPL id. That was checked
before anything was built on it.

**It is not in the archive we read.** `merged_gw.csv` carries `element`, `name`,
`team` and `position` and no permanent id, in all four seasons, read off the real
headers:

```
2022-23  41 columns   element present, code absent
2023-24  41 columns   element present, code absent
2024-25  49 columns   element present, code absent   (+7 mng_* assistant-manager columns)
2025-26  46 columns   element present, code absent   (+ defensive_contribution, tackles, ...)
```

**It is in the same archive, one file over.** `players_raw.csv` per season carries
`id` (equal to merged_gw's `element`) alongside `code`. That file is the bridge:
`element + season -> code`. Joining it into merged_gw inside one season agrees on
the player's name for 3,283 of 3,288 elements across the four seasons; the five
disagreements are spelling (`"Michale Olakigbe"` for `Michael Olakigbe`) plus one
upstream error where 2024-25 element 748 is Ivan Juric in one file and Simon Rusk
in the other. Both are managers, whom the replay drops anyway.

**`code` is stable.** Every code shared by two consecutive seasons names the same
footballer. Raw string equality of the full name is 89.7% to 97.3%, and every
single disagreement is one human respelt, never two people:

| pair | shared codes | identical name string | same footballer |
| --- | ---: | ---: | ---: |
| 2022-23 -> 2023-24 | 526 | 512 (97.3%) | 526 (100%) |
| 2023-24 -> 2024-25 | 513 | 490 (95.5%) | 513 (100%) |
| 2024-25 -> 2025-26 | 534 | 479 (89.7%) | 534 (100%) |

```
code  91651  "Mateo Kovacic"     -> "Mateo Kovačić"        accent restored
code 223723  "Takehiro Tomiyasu" -> "Tomiyasu Takehiro"    name order flipped
code 221466  "Marcos Senesi"     -> "Marcos Senesi Barón"  surname added
code 214048  "Max Kilman"        -> "Maximilian Kilman"    given name expanded
code 510281  "Sávio 'Savinho' Moreira de Oliveira" -> "Sávio Moreira de Oliveira"
```

That table is also the reason a name join is a fallback and not the answer.

## What was actually broken in production

One join in the shipped code crosses a season boundary: `createAccumulator` in
`js/engine/backtest.js` seeds every player's rates at gameweek 1 from the season
before, which is what FPL itself does every August and, at gameweek 1, the only
evidence that exists.

It matched on the archive's raw `name` string, exactly. That never matched the
WRONG player, so nothing was corrupted, but it silently dropped returning players
whom the archive respells:

| pair | returning players | seeded by the old join | lost |
| --- | ---: | ---: | ---: |
| 2022-23 -> 2023-24 | 526 | 512 | 14 |
| 2023-24 -> 2024-25 | 513 | 490 | 23 |

That is 11,366 prior-season minutes and 436 points discarded going into 2023-24,
and 19,061 minutes and 884 points going into 2024-25. Among the players who
entered a season looking to the planner like men who had never played:

```
Rodrigo 'Rodri' Hernandez   2,931 minutes    was "Rodrigo Hernandez"
Vladimír Coufal             2,135 minutes    was "Vladimir Coufal"
Mitoma Kaoru                1,485 minutes    was "Kaoru Mitoma"
Joe Gomez                   1,461 minutes    was "Joseph Gomez"
Tomiyasu Takehiro           1,140 minutes    was "Takehiro Tomiyasu"
Ben Brereton Díaz           1,105 minutes    was "Ben Brereton"
```

Separately, `gameStateAt` set `code: p.id`, putting a season-scoped row number
into the one field whose entire meaning is that it survives a season. Nothing
consumed it, so nothing was wrong today; it was a loaded gun pointed at the next
person who trusted the field name.

## The resolution layer

`js/engine/player-identity.js`. `code` is canonical, and the module refuses to
let anything else key a cross-season structure: `assertCrossSeasonField` throws
on `element`, `id`, `playerId`, `player_id`, `playerKey` and `opponent_team`, and
`crossSeasonKey` throws rather than falling back to an id when a code is absent.

`resolveSeasonPair({ from, to })` resolves one season's players to another's.
Rung 1 is `code`. Below it, for rows that carry no code (synthetic seasons in
tests, or an archive season whose identity table has not been downloaded), two
name rungs, each requiring a UNIQUE candidate on both sides:

1. exact folded full name
2. identical identifying token SET, order-free, hyphens split like spaces,
   particles (`de`, `van`, `dos`, ...) and single letters dropped

Accent folding includes the letters NFD cannot decompose (ø, æ, œ, ß, ð, þ, ł, đ,
ı), without which `Højlund` becomes `hjlund` and matches nothing.

**No club constraint, deliberately.** The availability join in `backtest.js`
constrains every rung to the club, which is right THERE because it matches two
views of one season. This join crosses seasons and players transfer, so requiring
the club to agree would drop every summer signing, which is a large and
non-random slice of exactly the players whose previous season matters most. Club
is not used at all here.

**No exceptions list.** One was not written because none is needed: the code path
resolves 100% and an exceptions list with nothing in it is a place for future
guesses to hide.

### Measured match rate

Via `code`, which is what the pipeline actually uses:

| pair | returning players | resolved | by code | collisions | unresolved |
| --- | ---: | ---: | ---: | ---: | ---: |
| 2022-23 -> 2023-24 | 526 | 526 (100%) | 526 | 0 | 0 |
| 2023-24 -> 2024-25 | 513 | 513 (100%) | 513 | 0 | 0 |
| 2024-25 -> 2025-26 | 534 | 534 (100%) | 534 | 0 | 0 |

With codes withheld, so only the name rungs run. This is the safety net, not the
pipeline, and it is reported because a fallback nobody has measured is a guess:

| pair | correct | wrong | missed | collisions refused |
| --- | ---: | ---: | ---: | ---: |
| 2022-23 -> 2023-24 | 517 / 526 (98.3%) | 0 | 9 | 1 |
| 2023-24 -> 2024-25 | 499 / 513 (97.3%) | 0 | 14 | 0 |
| 2024-25 -> 2025-26 | 494 / 534 (92.5%) | 0 | 40 | 0 |

Zero wrong matches on all three pairs. The one collision is genuine: two men
named Ben Davies were in the 2022-23 game, and the resolver reports them and
refuses rather than picking one.

The single remaining disagreement with `code` is `"Kaine Kesler Hayden"` ->
`"Kaine Kesler-Hayden"`, which the resolver matches and the codes say is two
players (465390 and 537043). That is one footballer carrying two upstream codes,
an archive defect rather than a resolver guess, and it is noted rather than
worked around.

### The rung that was built and removed

A third rung, "one name's identifying tokens are a subset of the other's", bought
50 extra matches across the three pairs and paid for them with three wrong ones:

```
"Kyle Walker"           matched to "Kyle Walker-Peters"
"Victor da Silva"       matched to "João Victor Gomes da Silva"
```

Those are different footballers. It was deleted. The asymmetry decides it: a
missed match means a player starts a season with no history, which is the
behaviour that already existed, while a wrong match seeds one footballer's entire
previous season onto another and nothing downstream can detect it.

## What the fix changed, and what it invalidates

Both arms were replayed back to back on a frozen tree, because `lineup.js`,
`squad-builder.js` and `counterfactual.js` were being edited concurrently by
other work. The AFTER arm is the BEFORE arm plus only the files this audit owns,
so the sole difference between the columns is the identity join.

Full seasons, horizon 3, seed 1, gameweeks 1-38:

| strategy | 2022-23 | 2023-24 | 2024-25 | total |
| --- | ---: | ---: | ---: | ---: |
| planner, broken join | 2152 | 2028 | 2054 | 6234 |
| planner, fixed join | 2152 | 2048 | 2234 | **6434** |
| greedy-xp, broken join | 1968 | 1983 | 2099 | 6050 |
| greedy-xp, fixed join | 1968 | 2050 | 2283 | 6301 |
| hold, broken join | 1605 | 1592 | 1771 | 4968 |
| hold, fixed join | 1605 | 1677 | 1606 | 4888 |
| fdr, broken join | 1497 | 712 | 1205 | 3414 |
| fdr, fixed join | 1497 | 713 | 1217 | 3427 |

**2022-23 is bit-identical for all four strategies**, and that is the control
rather than a curiosity: 2021-22 is not downloaded, so 2022-23 has no prior
season to join and the change cannot touch it. Every other season moves for every
strategy. That pairing is what says the fix changed the cross-season seeding and
nothing else.

Nine chip-free windows, the deciding instrument in `registry.md`:

| arm | total |
| --- | ---: |
| broken join | 6572 |
| fixed join | **6412** |

The two instruments disagree in sign, which is itself worth stating: the fix is
+200 over full seasons and -160 over nine windows. Neither is evidence that the
planner got better or worse. The engine did not change. The measurement did.

### What it did to the availability verdict

The availability experiment was rejected on the nine windows, so it is the
clearest case of a decision resting on this join. Availability on versus off,
both join arms on the same frozen tree:

| instrument | broken join | corrected join | swing |
| --- | ---: | ---: | ---: |
| 2, nine chip-free windows | -86 (4W/5L) | +113 (6W/3L) | +199, sign flips |
| 3, 45 paired trajectories | +542 (t 1.60, 30W/15L) | +574 (t 2.02, 31W/14L) | +32 |

Instrument 2 inverts. Instrument 3 barely moves. That is a finding about the
instruments rather than about availability, and it is a sharper version of what
`registry.md` already suspected: nine windows against roughly 30 points of
per-window noise can be flipped by a data defect that the stronger instrument
scores at 32 points.

Both recorded availability numbers are void, and the experiment is documented as
void rather than re-accepted. Its rejection rested on evidence that no longer
exists; that is not the same as evidence for the opposite.

Note for anyone comparing against the numbers recorded on 2026-08-10: most of the
distance to those is NOT this fix. 2022-23 has no prior season to join, its
replay is bit-identical across both arms here, and it reads +35 in both while the
2026-08-10 run recorded -137. That difference belongs to the corrected transfer
state machine and other tree movement, not to the identity join.

## The opponent-strength features are dead, and were left that way

Found during the audit, reported here, NOT fixed, because fixing it is a
modelling round and this was not one.

`buildTeamHistory` in `scripts/train-model.mjs` keys clubs by `r.team`, which is
the club NAME (`"Sheffield Utd"`). `featureVector` then queries it with
`String(targetRow.opponent_team)`, which is a season-scoped club INDEX (`8`). A
number is looked up in a map keyed by names, so it never matches:

```
oppConcededPerMatch   nonzero on      0 / 27,138 rows of 2023-24
oppScoredPerMatch     nonzero on      0 / 27,138 rows of 2023-24
teamScoredPerMatch    nonzero on 27,108 / 27,138
teamConcededPerMatch  nonzero on 27,138 / 27,138
```

Two of the twenty-four declared features are identically zero in every training
row of every season, and carry a fitted weight of exactly zero. The model has no
opponent information at all, while the artifact advertises that it does.

It is the same class of defect as the one this audit is about, an id joined
against the wrong key space, but it is WITHIN a season, so it is not a
cross-season identity bug. It reaches no user: `engineConsumes` is empty and the
shipped engine consumes no artifact, so this affects recorded training metrics
only. Fixing it revives two features, changes every fitted candidate, and
requires a retrain plus a re-evaluation against a re-measured baseline. That is a
deliberate modelling round with its own before and after, and it should not be
smuggled into an integrity fix.

Reproduce:

```
node -e "
import('./scripts/train-model.mjs').then(async m => {
  const rows = m.loadSeasonRows('2023-24');
  const built = m.buildFeatureRows(rows, { season: '2023-24' });
  const i = m.FEATURE_NAMES.indexOf('oppConcededPerMatch');
  console.log('nonzero:', built.filter(r => r.features[i] !== 0).length, 'of', built.length);
})"
```

## Reproducing

```
node apps/fpl-planner/scripts/fetch-history.mjs          # now also fetches players_raw.csv
node --test apps/fpl-planner/tests/player-identity.test.mjs
node apps/fpl-planner/scripts/backtest.mjs --season 2024-25
```

The replay now prints the join it used, so a report can never again be read
without knowing whether its prior season was actually joined:

```
Identity:   513 of 784 players matched to 2023-24 (code 513), 271 newcomers, 0 refused as ambiguous
```
