# GW1 live-validation runbook

Five short passes around the 2026/27 opening gameweek. **Deadline: Friday
2026-08-21, 17:30 UTC.**

**RESULT, 2026-08-21: three of the four are now answered.** See FINDINGS, "The
first live gameweek". Facts 1, 2 and 4 were observed live and are recorded
below; Fact 3 was answered later, on 2026-08-28 (see below). The answers cost a
production incident, and the repair is on `fix/fpl-live-gameweek-state`.

- **Fact 1: FPL clears the element totals the moment GW1 goes current**, before
  any fixture finishes. Observed at 18:04 UTC. This is the branch that collapses
  projections, and it is now caught by `engine/baseline.js` rather than believed.
- **Fact 2: `picks` IS served after the deadline and DOES carry
  `entry_history.bank` and `.value`** (0 and 1000 on the night). The planner
  will not think a manager is broke.
- **Fact 4: upstream 503s `picks` for about half an hour after the deadline**
  (17:30 to 17:57 UTC), and `finished` stays false for MANY hours after full
  time while bonus is confirmed - the opening match was still unsigned at 04:58
  UTC the following morning, over eleven hours later. The proxy relayed the 503 correctly; the app was
  blind to the second, and now is not.

**RESULT, 2026-08-25: pass 4 is done and every check passed.** GW1 was
finalised between 04:20 UTC and 18:17 UTC on 2026-08-25, which is 7 to 21 hours
after the last GW1 full time (FUL 2-3 CHE, kicked off 2026-08-24 19:00 UTC).
An attempt on the Monday night stopped at step 1 as instructed: all ten fixtures
read `finished_provisional` with bonus posted, and `finished` and `data_checked`
were both still false. That is the sharpest measurement of Fact 4 we have -
**`finished` can stay false past the whole night, not merely for hours**, and
`finished_provisional` is the only signal that says the football is over.

On the finalised payload: the probe reports lifecycle `complete`, 20/20 clubs
played and all five invariants ok; a cold visitor is still refused
(`partial-season`, one match is not a season) and now gets the level-clubs
wording rather than the uneven-clubs one; with a kept baseline the start-rate
median is 0.485 with 0 of 260 pinned, the GW2 plan is 53.4 xP with a midfield
captain, and readiness reaches `chips` for the first time because `clubs_uneven`
and `gameweek_unsettled` have both cleared. History dropped the live marker,
folded GW1's 44 points (bonus included) into the average and the tiles, and the
tile rank matches the row. Report:
`.reports/fpl-planner-session-report-2026-08-25-1333.md`.

**RESULT, 2026-08-25 (later the same day): pass 4 also found a
production-blocking defect that the pass itself had been blind to.** Every
"returning visitor with a kept baseline" check in passes 3 and 4 SEEDED that
baseline - built in node from a pre-wipe payload on the maintainer's disk, or
written into localStorage before the page loaded. No production browser could
be in that state: the baseline guard reached production 22 hours AFTER FPL
cleared the totals, and `snapshotFrom` only snapshots a complete payload, so
none was ever written. Every real visitor, first-time or returning, was refused
a plan and would have stayed refused until three matches per club (2026-09-06).

The repair ships the baseline with the app (`data/opening-baseline.json`, built
from the last complete capture by `scripts/build-opening-baseline.mjs`) and is
recorded in FINDINGS under "The shipped opening-season baseline". The lesson
for every future pass: **if a check needs a fixture injected by hand, ask what
writes that fixture in production, and when.**

**RESULT, 2026-08-28: Fact 3 is answered. `entry_history.value` does NOT track
daily price moves - it is frozen at the gameweek deadline.** The first overnight
price move of the season landed on this squad: Anderson (MCI) fell 6.5 to 6.4.
`entry/3855835/event/1/picks` still reports `value: 1000` and `bank: 0`, while
the fifteen at today's prices sum to 999. So the frozen number is the DEADLINE
snapshot, not a live valuation, and it drifts by exactly the sum of price moves
since. Reconstructing selling prices per player, rather than trusting `value`,
is therefore required and not merely defensive.

The app handled it as designed: with no transfer made, `buildSquadState`'s
arithmetic check fired and production showed **"One number does not match Fantasy
Premier League"** with "Reconstructed squad value 99.9 does not match FPL's 100.
Selling prices may be off by the difference." It does NOT call the data old, and
no "Fantasy Premier League is not answering" banner appears. Verified on
shevato.com at 1280 and 390. At the time the header still printed SQUAD VALUE
£100.0m (the frozen total) while the banner named 99.9. That fallback was
removed on 2026-08-31: the header now states the reconstructed total in every
case bar an in-season payload that carried no picks, so the two agree.

**The banner itself was retired from this case on 2026-09-01.** Firing on a
price move was comparing a live total against a deadline snapshot; the check now
rolls prices back with `cost_change_event` first and reports only what movement
cannot explain. So the Fact 3 divergence above is still real and still what the
header reflects, but it is no longer announced. A future pass wanting to SEE the
banner has to break the reconstruction, not wait for a price change.

**Pass 5 attempted 2026-09-01: two more boxes closed, four still open, and the
reason is a trap worth naming.** On 2026-08-28 `entry/3855835/transfers` was
`[]`; it is not any more. One transfer exists (Lacroix out, Tarkowski in,
`element_out` 200, `element_in` 229) and `last_deadline_total_transfers` is 1.

**A transfer existing is not the state pass 5 tests.** That move was made at
2026-08-28T05:33Z, twelve hours BEFORE the GW2 deadline it belongs to, so GW2's
frozen picks already contain Tarkowski and no longer contain Lacroix. The
endpoints agree, and pass 5 exists precisely to test them DISAGREEING: a move
that is on `entry/{id}/transfers` and not yet in `picks`. What creates that is a
transfer made for the gameweek the app is currently planning, in the window
AFTER the previous deadline, which for GW3 means one made before 2026-09-04
17:30 UTC.

What did close, live against shevato.com with the real team: the **bank match**
and the **-4 hit** pricing. Three more were checked and deliberately left open
because what was observed is the end state rather than the behaviour the box
names; each one says so beneath it. "Check for changes" answered "up to date",
which is correct with nothing changed and is not the positive case.

The reconciliation path those boxes cover is not untested, it is just not tested
against live FPL: `e2e/lifecycle.mjs` section 6 drives it in the `gw2-window`
state, where the transfer is on the transfers endpoint alone. Green on
2026-09-01 (`npm run test:fpl-planner:e2e`, 203/203).

Four things about Fantasy Premier League cannot be observed until the season
actually turns over, and each one is handled without a code change whichever way
it goes. This checklist is how we find out which way, and confirm the app agreed:

1. **when FPL clears `bootstrap-static.elements`** relative to the first
   finished fixture;
2. **whether `picks` is served right after the deadline**, and whether it carries
   `entry_history.bank` / `.value`;
3. **whether `entry_history.value` tracks daily price changes**;
4. **what upstream actually returns** while the game is being updated.

Two commands are used throughout. Run them from the repo root.

```sh
# Any endpoint through the live proxy.
fpl () { curl -s "https://shevato.com/.netlify/functions/fpl?path=$1" -H "Origin: https://shevato.com"; }

# The one number that says how the app read the payload.
node apps/fpl-planner/scripts/evidence-probe.mjs
```

Where a step says **capture**, keep the file: the before/after pair is what makes
a surprise diagnosable afterwards.

---

## 1. Five to ten minutes before the deadline (17:20-17:25 UTC)

```sh
mkdir -p /tmp/gw1 && fpl bootstrap-static > /tmp/gw1/bootstrap-before.json
fpl fixtures > /tmp/gw1/fixtures-before.json
fpl "entry/<YOUR_ID>" > /tmp/gw1/entry-before.json
fpl "entry/<YOUR_ID>/event/1/picks" > /tmp/gw1/picks-before.json   # expected: 404
node apps/fpl-planner/scripts/evidence-probe.mjs > /tmp/gw1/evidence-before.txt
```

Check:

- [ ] `sum(elements[].starts)` is either **near 6700** (last season's totals still
      in place) or **0** (already cleared). Record which. *Fact 1.*
- [ ] no fixture has `finished: true`.
- [ ] the probe prints `previous-season` (or `none` if totals are already
      cleared) and a **median start rate between 0.3 and 0.95**, never 1.000.
- [ ] `picks` returns 404. *Fact 2, before state.*
- [ ] open the app: the plan renders, the hero counts **down** to the deadline,
      the deadline appears **once**, and Model and data status shows a "Player
      totals" line agreeing with the probe.
- [ ] a squad built or typed here survives a browser reload, and comes back
      with the SAME story: "Build this opening 15", money read against the
      £100.0m budget (never "£0.0m of the £0.0m"), "Unlimited until the GW1
      deadline", no "Roll your transfer" in the hero, and no "Your bank fell"
      notice. (The 2026-08-20 fix; the squad surviving while the story flipped
      was the exact pre-fix failure.)

**If the probe says `none`:** the app will withhold the plan and say why. That is
the designed behaviour, not a fault. Note it and continue.

## 2. Immediately after the deadline (17:31-17:40 UTC)

Leave a tab open across 17:30 and do not touch it.

```sh
fpl bootstrap-static > /tmp/gw1/bootstrap-after.json
fpl "entry/<YOUR_ID>/event/1/picks" > /tmp/gw1/picks-after.json
```

Check:

- [ ] the open tab notices by itself within about a minute: the countdown stops
      claiming time remains, the plan is marked no longer actionable, and the
      app refetches rather than only redrawing.
- [ ] a tab that was hidden across the deadline updates when you return to it.
- [ ] "Deadline passed" appears **exactly once**.
- [ ] `picks` now returns 200, and carries `entry_history.bank` and `.value`.
      *Fact 2.* If it does not, the app shows a warning about missing bank and
      squad value rather than planning on zero.
- [ ] a pre-season tab routes into the in-season experience without a manual
      reload, and no longer offers the £100.0m builder.
- [ ] the planner now targets **GW2**, and free transfers read **1**.

## 3. During the first matches (Friday evening, Saturday)

```sh
node apps/fpl-planner/scripts/evidence-probe.mjs
```

Check:

- [ ] the probe still reports a **median start rate near 0.5**, never 1.000, and
      the classification is whatever matches reality (`previous-season` while the
      totals are last season's, `current-season` once they are not). *Fact 1.*
- [ ] the projected gameweek total for a legal eleven is **between 30 and 100**,
      and the captain is **not a goalkeeper**. Either symptom means the rollover
      guard needs looking at before anything else.
- [ ] the app plans GW2 while GW1 is in play, and does not present GW1 as
      something still to be decided.
- [ ] History shows GW1 as **live/provisional**, keeps it out of the season
      average, and does not blank a rank that is already known.
- [ ] if FPL wobbles, the app degrades to a stale copy with a warning rather than
      an error, and any failure screen still offers Try again after you visit
      another tab and come back. *Fact 4.*

## 4. After GW1 is finalised (Monday/Tuesday)

```sh
fpl bootstrap-static > /tmp/gw1/bootstrap-final.json
node apps/fpl-planner/scripts/evidence-probe.mjs
```

Check:

- [ ] `events[0].finished` and `data_checked` are both true.
- [ ] the probe reports `current-season` once the totals are this season's, with
      the denominator equal to matches played.
- [ ] History moves GW1 from provisional to final: the live marker is gone, the
      points include bonus, and the rank and season average now include it.
- [ ] the squad for GW2 is reconstructed correctly and free transfers read 1.
- [ ] **from an EMPTY browser** (clear localStorage, set only the team id) the
      Plan tab renders a GW2 plan rather than a refusal. Never seed a baseline
      to make this pass: the whole point is what a real first-time visitor
      gets. `localStorage.getItem('fplPlannerSeasonBaseline.v1')` is expected
      to be null, and the plan must appear anyway, from the shipped asset.

## 5. After one real transfer for GW2

Make one transfer on the Fantasy Premier League site, then reopen the app.

**Timing is the whole test.** The transfer has to be made AFTER the previous
gameweek's deadline, so that it lands on `transfers` while `picks` still
describes the squad from before it. A transfer made before its own deadline is
absorbed into that gameweek's picks and the two endpoints simply agree, which
exercises none of this section (that is what happened on 2026-08-28; see the
result block above). Check which state you are in before spending the pass:

```sh
fpl "entry/<YOUR_ID>/transfers" | head -c 400
fpl "entry/<YOUR_ID>/event/<CURRENT_GW>/picks" | head -c 200   # the frozen squad

# The one comparison that says whether this section can run at all: the newest
# transfer's `event` must be the gameweek the app is PLANNING (the next one),
# and its `element_in` must be absent from the frozen picks above.
```

Check:

- [ ] the app shows the **new** player and not the old one, even though `picks`
      still describes the GW1 squad.
      **Not closed.** The end state was verified live on 2026-09-01 (the squad
      shows Tarkowski and not Lacroix), but the tension this box exists for was
      not: the only transfer on the account was made BEFORE its own deadline, so
      the frozen picks already contain the new player and there was nothing to
      reconcile. The reconciliation path is covered by `e2e/lifecycle.mjs`
      section 6 in the `gw2-window` state, which is the only place it has been
      exercised.
- [x] the bank matches the FPL site.
      **Done 2026-09-01.** App header BANK £0.0m against `entry_history.bank` 0
      and `entry.last_deadline_bank` 0.
- [ ] free transfers have gone **down by one**.
      **Not closed.** The replayed RESULT is right - the app shows 1 free
      transfer for the GW3 window against `history.current` GW2
      `event_transfers: 1, event_transfers_cost: 0` - but the decrement itself
      happens at the moment a transfer is made, and no transfer was made while
      the app was watching.
- [ ] the planner does **not** recommend the transfer just made.
      **Not closed.** Verified live that the plan does not propose Lacroix to
      Tarkowski, but with Lacroix already gone from the frozen picks that is
      true trivially. The real case, a move present on `transfers` and absent
      from `picks`, is the `gw2-window` assertion in `e2e/lifecycle.mjs`.
- [x] a further transfer is priced as a **-4 hit** if no free transfer remains.
      **Done 2026-09-01**, live, in the scenario sandbox with one free transfer
      banked: Raya to Kelleher then Gabriel to N.Williams, and the verdict reads
      "Your transfers project -6.9 points over the next 5 gameweeks, after the 4
      point hit", with the Points hit comparison row moving 0 to 4.
- [ ] "Check for changes" reports the squad change rather than silence.
      **Not closed.** The control answers rather than going quiet ("up to date",
      live 2026-09-01), which is the correct answer when nothing has changed.
      The box asks for the positive case and needs a real squad change between
      two loads.
- [x] compare `entry_history.value` in the picks payload against the site's
      squad value after an overnight price move. *Fact 3.* If they diverge, the
      app now says one number does not match Fantasy Premier League, and says
      which; it no longer reports it as the data being old.
      **Done 2026-08-28**, and it needed no transfer: Anderson 6.5 to 6.4 made
      the frozen `value` (1000) and the live fifteen (999) diverge, and the app
      named the mismatch. See the 2026-08-28 result above.

---

## If something is wrong

Capture the payload first (`fpl <path> > /tmp/gw1/<name>.json`), then the probe
output. Every one of these behaviours is covered by a test that can be pointed at
a captured payload:

```sh
npm run test:fpl-planner                 # engine + view unit suites
npm run test:fpl-planner:e2e             # the browser lifecycle suites
node --test apps/fpl-planner/tests/season-rollover.test.mjs
node --test apps/fpl-planner/tests/pending-transfers.test.mjs
```

Nothing in the app needs a manual switch for any of the four unknowns. If reality
differs from expectation, the app reports it and the fix belongs in the
classifier or the reconstruction, not in a flag.
