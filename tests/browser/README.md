# Browser regression suite

End-to-end checks that drive the real site and all eight apps in headless
Chrome. Complements `npm test`, which covers pure logic in Node and never opens
a browser.

```bash
npm run test:browser
```

The runner starts its own static server and headless Chrome, runs every suite,
tears both down, and exits non-zero on any failure. Nothing needs to be running
beforehand.

Three runner-level guarantees:

- **Crash containment.** Each suite runs in its own try/catch; a suite that
  throws (import error included) records one `<suite>: suite completed`
  failure and the next suite still runs.
- **Check-count pinning.** `EXPECTED_CHECKS` in run.mjs pins the number of
  checks a suite must emit, so a silently lost check (early return, dropped
  loop) becomes an explicit failure instead of a shrunken green run. All six
  harness-owned suites are pinned (site 157, apps 101, a11y 72, visual 86,
  perf 41, pwa-gym 14); the app-owned trip-planner/fpl-planner suites are
  not, by their owners' choice. Adding or removing a check on purpose means
  updating the pinned number in the same change.
- **Ordered teardown.** kill() is followed by a bounded wait for the actual
  process exits before the Chrome profile dir is removed, so teardown never
  races Chrome's open file handles.

## Requirements

- Chromium or Chrome on `PATH`, or `CHROME_BIN` pointing at one.
- Python 3, used for the static server.
- Node 20+. The driver needs `--experimental-websocket` on Node 20; the npm
  script passes it. Node 22+ has `WebSocket` globally and ignores the flag.

## Local gotchas

- On the maintainer's machine `chromium` is the snap build, which cannot use
  a profile directory under `/tmp`, so `npm run test:browser` times out
  waiting for headless Chrome unless `TMPDIR` points inside the repo:
  `TMPDIR=$PWD/.screenshots/tmp npm run test:browser` (`.screenshots/` is
  gitignored).
- Snap chromium ignores the SIGTERM from `child.kill()`, so a relaunch on the
  same CDP port silently attaches to the OLD browser with its tabs still
  open. Kill by port before relaunching (e.g. `pkill -f
  'remote-debugging-port=922[2]'`; the bracket stops the pattern matching the
  shell running it).
- Run this estate with nothing else heavy on the machine. Chromium and the
  Firebase emulators both die under load, and a dead browser reports as a wall
  of `ECONNREFUSED` or `timeout: Runtime.evaluate` failures that look like
  product bugs. On 2026-08-23 a concurrent coverage run (load average 21) took
  down a whole estate run, and two concurrent `test:arena:emulator` runs killed
  each other's emulators during their own cleanup. Never run two copies of the
  arena emulator suite at once, and check `ss -ltn` for 8085 / 9000 / 9099
  before starting one.

## What a suite must return

`run({ base, cdpPort })` must resolve with an ARRAY of
`{ name, pass, detail, skipped }` checks. The runner spreads it into its own
results, so returning a summary object instead throws
`Spread syntax requires ...iterable` OUT of the suite loop and abandons the
whole run at that point. That is not hypothetical: two of the seven per-app
audit suites added on 2026-08-22 returned a summary object, so every one of
them was skipped in `npm run test:browser` while passing when their owners ran
them standalone, and the estate looked green with 539 checks missing. The
runner now fails such a suite loudly and continues, but the contract is the
array.

## Why it is not part of `npm test`

`npm test` runs in CI on every push to master and every PR, in about three
minutes with no browser binary. This suite needs Chromium and takes about 45
minutes end to end. Keeping them separate means the fast gate stays fast and
dependency-free, while this runs on PRs, master pushes, and locally before a
release.

## How CI keeps that to about 12 minutes

The estate is 27 suites walked one at a time in one browser, so the only way to
finish sooner is to put the suites on more machines. `.github/workflows/browser-tests.yml`
runs a four-job matrix, each job taking a quarter of the list:

```bash
node --experimental-websocket tests/browser/run.mjs --shard=2/4
```

The split is round-robin over `SUITES` (`index % n`), not contiguous blocks:
the list groups related suites together (ten trip-planner ones in a row, seven
per-app audit ones) and related suites cost about the same, so blocks would
hand one runner most of the slow work. Striding interleaves them, and every
suite has exactly one index, so shards 1..n run the list once and only once.
That totality is the point: a suite belonging to no shard would report nothing
and read as green. Each run prints the suites its shard owns before starting,
so the shard logs side by side are the audit that the estate was fully run.

The workflow derives `<n>` from `strategy.job-total`, the matrix size itself,
so the shard count is never written down twice. Changing the parallelism is
one edit to the `shard:` list. A `browser` job gathers the four results into a
single verdict.

Sharding is safe on separate runners and NOT safe on one machine: two runs on
the same host share CDP port 9222 and silently drive each other's browser. The
runner bind-tests both its ports and refuses to start for that reason, so
running two shards locally needs `BROWSER_TEST_PORT` and
`BROWSER_TEST_CDP_PORT` set per run.

## Skipped checks

A check reports `skip` in two distinct situations. Skips are not failures and
do not affect the exit code, but they are always listed so a partial run is
never mistaken for a full one.

1. **Missing precondition** the repo cannot supply (see the rising-shows
   dataset below).
2. **Known product defect, as an expected-failure check.** These are NOT
   ordinary skips: the check EXECUTES the defective behavior on every run.
   While the defect reproduces, it reports as a skip carrying a
   `KNOWN DEFECT: ...` detail (catalogued in TESTING-AUDIT.md). The moment
   the defect stops reproducing, the check FAILS with an "unexpectedly
   passes - remove the quarantine" message: the PR that fixes the product
   bug must retire its quarantine in the same change, so stale quarantines
   cannot rot silently. When writing a new one, follow this two-branch
   pattern (defect present -> skip; defect absent -> failing check with
   removal instructions); never write an unconditional skip for a product
   defect. The a11y suite goes one step further and pins its quarantine
   baseline per scan and per axe rule id (`QUARANTINED` in a11y.mjs), so a
   NEW violation class anywhere fails outright instead of joining the
   quarantine.

The rising-shows dataset is the current case: `data.json` and
`data-index.json` are gitignored and pulled from a GitHub release, so a clean
clone has no shows and every finder assertion would fail for a reason that is
not a bug. Those six checks skip with the fix in the message. To run them:

```bash
npm run fetch:rising-shows-data
```

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `BROWSER_TEST_PORT` | `8099` | Static server port |
| `BROWSER_TEST_CDP_PORT` | `9222` | Chrome DevTools Protocol port |
| `CHROME_BIN` | `chromium` | Browser binary |

Ports 8080 and 8081 are reserved on the maintainer's machine and must never
become defaults here (local servers go on 8082+, see `CLAUDE.md`).

## Layout

```
tests/browser/
  run.mjs            # lifecycle: start server + Chrome, run suites, tear down
  cdp.mjs            # DevTools Protocol driver (evaluate, clicks, keys,
                     #   network interception, offline emulation, targets)
  suites/site.mjs    # 8 marketing pages: meta/robots, first-party network
                     #   failures, apps-hub search + category filters, header
                     #   apps dropdown, moadon-alef language switcher, apex
                     #   shell structure, nav, forms, responsive
  suites/apps.mjs    # the apps: real feature flows with storage/table
                     #   assertions, plus a mobile sweep with one interaction
                     #   per app
  suites/a11y.mjs    # axe WCAG2A/AA scans (pinned quarantine baseline,
                     #   currently empty) + real-keyboard focus checks,
                     #   mobile-menu focus trap, Sign In touch target, and
                     #   per-page main landmark / skip link / header nav labels
  suites/visual.mjs  # deterministic geometry/theme/collision pins at three
                     #   viewports (pixel baselines deliberately rejected)
  suites/perf.mjs    # first-party byte / request / DOM budgets per page
  suites/pwa-gym.mjs # gym service worker: registration, caches, offline
  vendor/axe.min.js  # vendored axe-core (same convention as site jQuery)

apps/trip-planner/e2e/   # the trip-planner E2E regression suites (registered
                         #   in run.mjs; see that app's README + FINDINGS)
apps/gym-tracker/e2e/    # gym-tracker units-migration suite (registered in
                         #   run.mjs)
apps/fpl-planner/e2e/    # fpl-planner scenario + gameweek-lifecycle suites
                         #   (registered in run.mjs)
apps/arena/e2e/          # two-client multiplayer suite vs local Firebase
                         #   emulators: NOT in run.mjs (needs Java); run it
                         #   with npm run test:arena:emulator
```

A suite exports `run({ base, cdpPort })` and returns
`[{ name, pass, detail }]`. Suite paths in `SUITES` (run.mjs) are
repo-relative, so app-local suites can live beside their app.

## Running a subset

```bash
node --experimental-websocket tests/browser/run.mjs --only=<path-substring>
node --experimental-websocket tests/browser/run.mjs --only=trip-planner --headed
node --experimental-websocket tests/browser/run.mjs --shard=2/4
```

`npm run test:trip-planner:e2e` is the shorthand for the trip-planner subset;
`--headed` opens a visible browser for local debugging. Trip-planner failures
drop a screenshot of the failing page into `.screenshots/e2e-trip-planner/`
(gitignored); successful runs write no artifacts.

## Writing assertions that are actually true

Clicks go through `Input.dispatchMouseEvent` at real coordinates, so they
respect hit-testing, z-order and overlays. `element.click()` bypasses all three
and will happily "succeed" against a button covered by a modal.

These traps produced convincing false failures when this suite was written.
All are handled in `suites/apps.mjs`, and each is documented at the point
it is applied:

- **Collapsed sidebars.** football-h2h and mario-kart keep Add Game / Add Race,
  undo, redo and export inside a sidebar that is closed by default on desktop.
  Open it first or every one of those controls looks broken.
- **First-run overlays.** gym-tracker shows `#onboarding-modal` at z-index 2000
  over the nav. Dismiss it via its own control rather than deleting the node, so
  the test still reflects what a user can do.
- **Pagination.** rising-shows renders 24 rows per page, so a search matching
  more than one page leaves the visible row count unchanged even though the
  filter worked. Assert on the app's own "N shows" total.
- **Correctly disabled controls.** trip-planner disables Days and Map until the
  trip has items, and undo/redo until something has happened. These are not
  bugs; assert the enable/disable transition instead of assuming clickability.
- **Closed `<details>` content.** maptap-rivals' paste panel lives inside a
  closed `<details class="paste-collapse">`. Its inner elements still report
  non-zero rects, and synthetic input events into them even update app state,
  but they are NOT hit-testable: coordinate clicks land on whatever is painted
  there instead (the footer, in practice). Open the details first.
- **Empty-state boot views.** mario-kart boots into the Help view when storage
  is empty, and the race-history section is hidden by design on Help/Guide
  views. Switch to Stats before asserting on the table. Its Stats empty state
  also renders a placeholder `<tr>`, so real rows are counted via their
  per-row edit buttons rather than a bare `tr` count.

Two hard rules on network:

- **Arena never touches production Firebase.** The arena blocks (desktop and
  mobile) intercept and fail firestore/identitytoolkit/securetoken/firebaseio
  before first navigation - "Play solo" used to sign in anonymously and write
  real docs to the production project. With the backend failed, the suite
  asserts the app's truthful degraded behavior: the guest-auth toast plus the
  sign-in modal, and a lobby that stays usable.
- **First-party failures are asserted at the network layer.** `NOISE` keeps
  swallowing console text from blocked external hosts (that noise is
  environmental), but `Network.loadingFailed` entries now carry the request
  URL, and `firstPartyFailures(s, base)` filters `s.netFails` down to
  same-origin failures. site.mjs asserts it is empty on every page, which is
  what catches a broken local image/CSS/JS reference that the console checks
  cannot see. `api.openai.com` is also in `EXTERNAL_HOSTS`, so suites that
  block "everything external" can never hit the trip-planner Tier-2 path live.

Two further notes on state. Apps re-save debounced state, so a bare
`localStorage.clear()` can be undone by an autosave firing just after it; clear
per key and reload, as `fresh()` does. And app state is closure-scoped and read
at boot, so seed storage *then* reload rather than expecting a live update.

Analytics hosts are blackholed via `--host-resolver-rules`, and `cleanErrors()`
filters the resulting network noise so a blocked beacon never reads as an app
error.

Driver notes:

- `setViewport(s, w, h, true)` also enables touch emulation, so 390px runs
  report touch support (hover:none, maxTouchPoints) the way real phones do;
  mouse-based clicks keep working. The mobile sweep runs one asserted
  interaction per app on top of the overflow/content/error checks.
- `goto()` no longer leaks a load handler per navigation, and a navigation
  that hits the 20s guard sets `s.lastNavTimedOut = true` instead of failing
  silently.
- `hoverSel()` moves the real mouse over an element without clicking, for
  hover-opened UI (the header apps dropdown uses it, with keyboard focus as
  the fallback path).
- Prefer `waitForExpr` on the app's own readiness signal over fixed sleeps;
  the suites' remaining `sleep`s are short settles, not waits.
