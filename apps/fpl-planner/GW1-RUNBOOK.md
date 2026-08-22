# GW1 live-validation runbook

Five short passes around the 2026/27 opening gameweek. **Deadline: Friday
2026-08-21, 17:30 UTC.**

**RESULT, 2026-08-21: three of the four are now answered.** See FINDINGS, "The
first live gameweek". Facts 1, 2 and 4 were observed live and are recorded
below; Fact 3 still needs an overnight price move. The answers cost a production
incident, and the repair is on `fix/fpl-live-gameweek-state`.

- **Fact 1: FPL clears the element totals the moment GW1 goes current**, before
  any fixture finishes. Observed at 18:04 UTC. This is the branch that collapses
  projections, and it is now caught by `engine/baseline.js` rather than believed.
- **Fact 2: `picks` IS served after the deadline and DOES carry
  `entry_history.bank` and `.value`** (0 and 1000 on the night). The planner
  will not think a manager is broke.
- **Fact 4: upstream 503s `picks` for about half an hour after the deadline**
  (17:30 to 17:57 UTC), and `finished` stays false for HOURS after full time
  while bonus is confirmed. The proxy relayed the 503 correctly; the app was
  blind to the second, and now is not.

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

## 5. After one real transfer for GW2

Make one transfer on the Fantasy Premier League site, then reopen the app.

```sh
fpl "entry/<YOUR_ID>/transfers" | head -c 400
fpl "entry/<YOUR_ID>/event/1/picks" | head -c 200   # still the GW1 squad
```

Check:

- [ ] the app shows the **new** player and not the old one, even though `picks`
      still describes the GW1 squad.
- [ ] the bank matches the FPL site.
- [ ] free transfers have gone **down by one**.
- [ ] the planner does **not** recommend the transfer just made.
- [ ] a further transfer is priced as a **-4 hit** if no free transfer remains.
- [ ] "Check for changes" reports the squad change rather than silence.
- [ ] compare `entry_history.value` in the picks payload against the site's
      squad value after an overnight price move. *Fact 3.* If they diverge, the
      app now says one number does not match Fantasy Premier League, and says
      which; it no longer reports it as the data being old.

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
