# Browser regression suite

End-to-end checks that drive the real site and every app in headless
Chrome. Complements `npm test`, which covers pure logic in Node and never opens
a browser.

```bash
npm run test:browser
```

The runner starts its own static server and headless Chrome, runs every suite,
tears both down, and exits non-zero on any failure. Nothing needs to be running
beforehand.

Six runner-level guarantees:

- **Crash containment.** Each suite runs in its own try/catch; a suite that
  throws (import error included) records one `<suite>: suite completed`
  failure and the next suite still runs.
- **Zero-run detection.** A suite whose every check is a SKIP asserted
  nothing, and check-count pinning cannot see that (the checks are all still
  there, they just did not run). The runner now names such suites in the
  summary under "Asserted NOTHING in this run", and FAILS them unless they are
  in `ZERO_RUN_ALLOWED` with a written reason. Today the one entry is
  `apps/rising-shows/e2e/audit-2026-08.mjs`: its dataset is a gitignored
  release asset, so on a clone without it every check skips. The exemption is
  for a local clone only: CI prepares the dataset and fails the shard if it
  cannot, and in CI mode (below) the exemption does not apply. The summary
  names the suite whenever it asserted nothing. Note that suite
  emits 51 checks when the dataset IS present and 11 when it is not, which is
  why it cannot also carry an `EXPECTED_CHECKS` pin.
- **Check-count pinning.** `EXPECTED_CHECKS` in run.mjs pins the number of
  checks a suite must emit, so a silently lost check (early return, dropped
  loop) becomes an explicit failure instead of a shrunken green run. All
  seven harness-owned suites (`site`, `apps`, `a11y`, `visual`, `perf`,
  `pwa-gym`, `csp`) are pinned, plus the app-owned
  `apps/maptap-rivals/e2e/quality.mjs` by its owner's choice; the other
  app-owned suites are not, by theirs. The numbers live in run.mjs only.
  Adding or removing a check on purpose means updating the pinned number in
  the same change.
- **Ordered teardown.** kill() is followed by a bounded wait for the actual
  process exits before the Chrome profile dir is removed, so teardown never
  races Chrome's open file handles.
- **CI mode.** `BROWSER_TEST_CI=1` (set by the `browser-shard` jobs of
  `.github/workflows/ci.yml`) turns every precondition skip, and every suite
  that asserted nothing, into a FAILURE. CI prepares every precondition (the
  Rising Shows dataset, the generated Gym Tracker pages and the one built
  Rising Shows show page), so a skip there would mean the run checked less than
  the previous run of the same commit. Known-defect quarantines (a detail
  starting `KNOWN DEFECT`) stay skips, because they execute every run.
- **Infrastructure is labelled as infrastructure.** A browser that exits
  mid-run fails the suite it was running with one `INFRASTRUCTURE - Chrome
  exited` check, and the next suite gets a fresh browser, so one crash no longer
  reads as a wall of unrelated `ECONNREFUSED` failures. A browser that never
  comes up reports whether it exited and the tail of its own stderr. With
  `GITHUB_STEP_SUMMARY` set, each shard writes its failures (infrastructure
  first, then application checks) and its timing table to the job summary.

## Requirements

- Chromium or Chrome on `PATH`, or `CHROME_BIN` pointing at one.
- Python 3, used for the static server.
- Node 22+ (`engines` in package.json; `npm test`'s pretest refuses older).
  `WebSocket` is global there, so the `--experimental-websocket` flag the npm
  scripts still pass is ignored.

## Local gotchas

- On the maintainer's machine `chromium` is the snap build, which cannot use
  a profile directory under `/tmp`, so `npm run test:browser` times out
  waiting for headless Chrome unless `TMPDIR` points inside the repo:
  `TMPDIR=$PWD/.screenshots/tmp npm run test:browser` (`.screenshots/` is
  gitignored).
- Playwright's bundled Chromium (`~/.cache/ms-playwright/chromium-*`) aborts
  with SIGABRT when this runner launches it with a debugging port on the
  maintainer's machine, although it renders fine on its own (measured
  2026-09-14; the runner now prints the exit and Chrome's stderr instead of a
  bare "timed out waiting for headless Chrome"). Use the snap `chromium`.
- Snap chromium ignores the SIGTERM from `child.kill()`, so a relaunch on the
  same CDP port silently attaches to the OLD browser with its tabs still
  open. Kill by port before relaunching (e.g. `pkill -f
  'remote-debugging-port=922[2]'`; the bracket stops the pattern matching the
  shell running it).
- Headless Chrome is not silent. WSLg forwards its PulseAudio output to the
  Windows speakers, so Arena's and Gym Tracker's WebAudio cues were audible
  during local runs until the runner started passing `--mute-audio`
  (2026-09-16). Pages cannot observe the flag: the `AudioContext` still reports
  `running` and its clock advances. How it was measured is in
  `apps/arena/FINDINGS.md`, "The test browsers were audible".
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
whole run at that point. That is not hypothetical: two of the per-app audit
suites added on 2026-08-22 returned a summary object, so every one of them
was skipped in `npm run test:browser` while passing when their owners ran
them standalone, and the estate looked green with 539 checks missing. The
runner now fails such a suite loudly and continues, but the contract is the
array.

## Why it is not part of `npm test`

`npm test` runs in CI on every push to master and every PR, in about three
minutes with no browser binary. This suite needs Chromium and takes about 45
minutes end to end. Keeping them separate means the fast gate stays fast and
dependency-free, while this runs on PRs, master pushes, and locally before a
release.

## How CI runs it

The estate is 32 suites (`SUITES` in run.mjs, counted 2026-09-13) walked one at
a time in one browser per machine, so the way to finish sooner is to put the
suites on more machines. The `browser-shard` jobs of `.github/workflows/ci.yml`
are a matrix, each job taking its share of the list:

```bash
node --experimental-websocket tests/browser/run.mjs --shard=2/4
```

The split packs suites by MEASURED cost, not by count. `SUITE_SECONDS` in
run.mjs records each suite's runtime from GitHub-runner logs, and the runner
walks the suites heaviest first, handing each to whichever shard is least
loaded so far (a suite missing from the table is charged `DEFAULT_SECONDS`).
The first split was round-robin over the list, which balanced suite COUNT
while costs differ by two orders of magnitude: it put 20 minutes on one shard
while the other three finished in 8-9, and the estate's wall clock is its
slowest shard. A stale cost can make shards uneven, never wrong: every suite
is placed in exactly one shard, and the runner throws if the partition loses
one. That totality is the point: a suite belonging to no shard would report
nothing and read as green. Each run prints the suites its shard owns, and the
work it expects, before starting, so the shard logs side by side are the audit
that the estate was fully run.

The workflow derives `<n>` from `strategy.job-total`, the matrix size itself,
so the shard count is never written down twice. Changing the parallelism is
one edit to the `shard:` list. A `browser` job gathers the shard results into a
single verdict (the required status check).

Before its suites, every shard restores the Rising Shows dataset from a cache
keyed by `apps/rising-shows/data-release.json` (downloading and splitting it on
a miss, and failing the shard if that fails; measured: a hit restores in 2-4 s,
a miss costs 8-13 s; the `dataset-cache` job keeps the entry warm on master,
where every pull request can read it), builds the Gym Tracker exercise
pages, and builds the one Rising Shows show page the suite visits
(`build-show-pages.js --only=tt0903747`). Failure screenshots under
`.screenshots/` are kept as a job artifact.

## Third-party requests never reach the internet

Every page `cdp.mjs` opens answers third-party requests locally, through
`tests/browser/third-party.mjs`:

- the CDN assets the site references (the Firebase SDK from www.gstatic.com,
  Google Fonts, Font Awesome from cdnjs) come from the committed mirror in
  `vendor/third-party/`, stored as the CDN served them (text with LF line
  endings);
- the MapTap daily puzzle, which is a different file every day, gets one fixed
  stand-in;
- every other third-party request (analytics, TMDB posters, map tiles, trip
  APIs, Wikipedia) is refused immediately, as a blocked network refuses it.

Measured on 2026-09-14 before this existed, one estate run sent 3,072 requests
to the real internet, so a result depended on those services and on the date;
a stalled www.gstatic.com request had already failed a CI run on 2026-09-13.

A suite's own `interceptNetwork(s, rules)` rule is consulted first. A rule
returns `null` (no opinion: first-party goes through, third-party gets the
answer above), `'fail'`, a canned `{ status, body, contentType, headers }`, or
`'hold'`, which leaves the request paused forever: that is how `site.mjs`
simulates a stalled CDN. Offline emulation (`setOffline`) refuses the mirror
too. `s.blockedThirdParty` lists what a page had refused, for a check's detail.

When the site starts referencing a CDN asset that is not mirrored (a new font
weight, an SDK version), `tests/static/browser-third-party.test.mjs` fails in
`npm test` and names the fix:

```bash
node tests/browser/refresh-third-party.mjs
```

That script is the only networked thing in this tree, and nothing runs it
automatically.

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
`shows-index.json` are gitignored and pulled from / derived from a GitHub release, so a clean
clone has no shows and every finder assertion would fail for a reason that is
not a bug. Those checks skip with the fix in the message, locally. On CI they
never skip: the shards prepare the dataset, and CI mode fails any skip that
remains. To run them locally:

```bash
npm run fetch:rising-shows-data
```

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `BROWSER_TEST_PORT` | `8099` | Static server port |
| `BROWSER_TEST_CDP_PORT` | `9222` | Chrome DevTools Protocol port |
| `CHROME_BIN` | `chromium` | Browser binary |
| `BROWSER_TEST_CI` | unset | `1` on CI: precondition skips and zero-assertion suites fail |
| `BROWSER_TEST_TIMING_JSON` | unset | Write per-suite timings (including fixed waits by source) to this file; `run-parallel.mjs` suffixes it per shard |

Port 8080 is reserved on the maintainer's machine and must never become a
default here (local servers go on 8081+, see `CLAUDE.md`).

## Layout

```
tests/browser/
  run.mjs            # lifecycle: start server + Chrome, run suites, tear down
  cdp.mjs            # DevTools Protocol driver (evaluate, clicks, keys,
                     #   network interception, offline emulation, targets)
  third-party.mjs    # the answer to every third-party request: mirror or refusal
  refresh-third-party.mjs # re-downloads the mirror (the only networked script)
  suites/site.mjs    # 8 marketing pages: meta/robots, first-party network
                     #   failures, apps-hub search + category filters, header
                     #   apps dropdown, moadon-alef language switcher, apex
                     #   shell structure, nav, forms, responsive, and every
                     #   root and app page (arena excepted) booting with each
                     #   gstatic, cdnjs and Google Fonts request held open
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
  suites/csp.mjs     # the enforced CSP, verified by a browser refusing what it
                     #   blocks rather than by reading the header as a string
  vendor/axe.min.js  # vendored axe-core (same convention as site jQuery)
  vendor/third-party/ # committed CDN mirror + manifest (sources and licences in its README)

apps/trip-planner/e2e/   # the trip-planner E2E regression suites (registered
                         #   in run.mjs; see that app's README + FINDINGS)
apps/gym-tracker/e2e/    # gym-tracker units-migration suite (registered in
                         #   run.mjs)
apps/fpl-planner/e2e/    # fpl-planner scenario + gameweek-lifecycle suites
                         #   (registered in run.mjs)
apps/<app>/e2e/          # audit-2026-08.mjs regressions for every app except
                         #   arena, plus maptap-rivals' quality.mjs (all
                         #   registered in run.mjs)
apps/arena/e2e/          # two-client multiplayer suite vs local Firebase
                         #   emulators: NOT in run.mjs (needs Java); run it
                         #   with npm run test:arena:emulator. CI runs it in
                         #   the `rules` job of .github/workflows/ci.yml
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
- A hand-written polling loop reads its predicate with `probe()`, not
  `evaluate()`. Both return the value; a renderer too busy to answer within the
  driver's 45 s send timeout makes `evaluate()` throw (the message names the
  page and the expression) and makes `probe()` return null, so the loop keeps
  polling to its own deadline instead of losing the scenario. A closed target
  or detached session throws from either.
