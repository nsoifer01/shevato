# Browser regression suite

End-to-end checks that drive the real site and all seven apps in headless
Chrome. Complements `npm test`, which covers pure logic in Node and never opens
a browser.

```bash
npm run test:browser
```

The runner starts its own static server and headless Chrome, runs every suite,
tears both down, and exits non-zero on any failure. Nothing needs to be running
beforehand.

## Requirements

- Chromium or Chrome on `PATH`, or `CHROME_BIN` pointing at one.
- Python 3, used for the static server.
- Node 20+. The driver needs `--experimental-websocket` on Node 20; the npm
  script passes it. Node 22+ has `WebSocket` globally and ignores the flag.

## Why it is not part of `npm test`

`npm test` runs in CI on every push and finishes in seconds. This suite needs a
browser binary and takes minutes. Keeping them separate means CI stays fast and
does not depend on a Chromium install, while this stays available locally and
before a release.

## Skipped checks

A check reports `skip` when a precondition the repo cannot supply is missing.
Skips are not failures and do not affect the exit code, but they are always
listed so a partial run is never mistaken for a full one.

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

Ports 8080 and 8083 are reserved on the maintainer's machine and must never
become defaults here.

## Layout

```
tests/browser/
  run.mjs            # lifecycle: start server + Chrome, run suites, tear down
  cdp.mjs            # DevTools Protocol driver (evaluate, clicks, keys,
                     #   network interception, offline emulation, targets)
  suites/site.mjs    # 8 marketing pages, nav, forms, responsive
  suites/apps.mjs    # all 7 apps: real feature flows, plus a mobile sweep

apps/trip-planner/e2e/   # the trip-planner E2E regression suites (registered
                         #   in run.mjs; see that app's README + FINDINGS)
```

A suite exports `run({ base, cdpPort })` and returns
`[{ name, pass, detail }]`. Suite paths in `SUITES` (run.mjs) are
repo-relative, so app-local suites can live beside their app.

## Running a subset

```bash
node --experimental-websocket tests/browser/run.mjs --only=<path-substring>
node --experimental-websocket tests/browser/run.mjs --only=trip-planner --headed
```

`npm run test:trip-planner:e2e` is the shorthand for the trip-planner subset;
`--headed` opens a visible browser for local debugging. Trip-planner failures
drop a screenshot of the failing page into `.screenshots/e2e-trip-planner/`
(gitignored); successful runs write no artifacts.

## Writing assertions that are actually true

Clicks go through `Input.dispatchMouseEvent` at real coordinates, so they
respect hit-testing, z-order and overlays. `element.click()` bypasses all three
and will happily "succeed" against a button covered by a modal.

Four traps produced convincing false failures when this suite was first written.
All four are handled in `suites/apps.mjs`, and each is documented at the point
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

Two further notes on state. Apps re-save debounced state, so a bare
`localStorage.clear()` can be undone by an autosave firing just after it; clear
per key and reload, as `fresh()` does. And app state is closure-scoped and read
at boot, so seed storage *then* reload rather than expecting a live update.

Analytics hosts are blackholed via `--host-resolver-rules`, and `cleanErrors()`
filters the resulting network noise so a blocked beacon never reads as an app
error.
