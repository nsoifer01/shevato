# Shevato site - engineering findings

Site-level knowledge that belongs to no single app: the marketing pages
(`*.html` at the root and `moadon-alef/`), the injected `partials/`, shared
`assets/` (CSS, JS, the auth modal, the sync banner), `sync-system/`,
`firestore.rules`, `privacy.html`, `netlify.toml` and the repo tooling
(`.gitignore`, `package.json`, the workflows). Per-app knowledge
lives in `apps/<app>/FINDINGS.md`; this file follows the same living-document
rule (rewrite, merge, delete; never an append-only diary).

## Why pull-request CI failed, and what the pipeline is now (2026-09-14)

Evidence: the 400 most recent Actions runs (2026-09-08 to 09-14), every failed
job's log, per-step timings, and local measurement runs. Pull-request CI was
four workflows (tests, lint, browser tests, arena emulator), about 13 minutes
of wall clock, and red for one reason or another on a large share of runs.

**What actually failed, by mechanism** (not by test name):

| Mechanism | Runs | State before this change |
| --- | ---: | --- |
| Arena Globe Drop "Ready advances the round early": a two-RPC transaction whose read/commit stall under CPU starvation ate the reveal window | ~15 | fixed 2026-09-12 (single-write advance, `apps/arena/FINDINGS.md`); no recurrence in ~30 runs since |
| Arena S6 "timeout: Runtime.evaluate": a send timeout inside `waitForExpr` aborted the scenario | 5 | fixed 2026-09-08 (a slow poll is not a verdict, `cdp.mjs`) |
| Arena Scope step exiting on `grep` matching nothing under `bash -e` | 2 | fixed 2026-09-08 |
| Real-clock tests: MapTap "UTC+12 counts today's games" failed whenever the host day and Auckland's matched (00:00-12:00 UTC, every day); gym "quick session counts toward week stats" failed early on Mondays | 3 | fixed on master in #538; the failing runs were a branch that predated it |
| A stalled www.gstatic.com request kept Gym Tracker from booting (six "unrelated" 390 px failures on a data-only bot PR) | 1 | boot path fixed in #535; the suites still loaded the SDK live (fixed here) |
| Auth-modal busy state read 300 ms after a 1,200 ms stub | 2 | fixed 2026-09-09 (wait for the re-enable) |
| Trip Planner "scrolling fetches the venues that came into view" (9 -> 9): the check's scroll jumped past the lazily loaded venues instead of moving through the board | 2 | test fixed in d59eb11 before #530 merged |
| Real regressions caught correctly (#530's `API` collision, check-count pins after an app was removed, the Rising Shows perf contract) | 4 | not failures of CI |

The Arena flake was most of the pain, and the clock and CDN failures were most
of the "completely unrelated to my PR" reports: they depended on the time of
day and on a CDN, not on the change.

**Live defects in CI itself, found and fixed in this round:**

- **The browser suites depended on the internet.** One run sent 3,072
  requests to real third-party hosts (Firebase SDK, Google Fonts, Font Awesome,
  TMDB, the MapTap daily puzzle which changes daily, map tiles, trip APIs).
  Every page now answers them locally: a committed mirror for the CDN assets,
  a fixed puzzle, refusal for the rest (`tests/browser/third-party.mjs`).
- **Every squash merge re-ran the whole estate on master.** The "already
  tested?" guard compared `HEAD^{tree}` with `HEAD^2^{tree}`, which a squash
  commit does not have, and the Arena workflow had no guard at all. A flake in
  that duplicate run turned master red for a tree that had passed.
  `scripts/ci-already-tested.mjs` now compares the pushed tree with the pull
  request head through the API and requires that head's CI run to have passed.
- **The Rising Shows dataset step made CI check less, silently**: a run-id
  cache key that never hit (evicting other caches), a cached directory that
  restored a stale copy over the tracked `season-overviews.json`, and
  `continue-on-error` that turned a failed download into 64 skipped assertions.
  Details in `apps/rising-shows/FINDINGS.md`.
- **Five checks never ran on CI**: the generated Gym Tracker exercise pages and
  the built Rising Shows show page were never built, so those checks always
  skipped. They are built now, and CI mode (`BROWSER_TEST_CI=1`) fails any
  precondition skip, so a commit asserts the same things on every run.
- **The weekly coverage job was red for a measurement artifact.** Node's
  coverage table credits one module instance per file, and
  `sync-account-boundary.test.mjs` loads its engine as `?page=N` instances, so
  sync-system read 69.54% against a floor of 82. Merged from LCOV it is 93.36%;
  no floor changed.
- **Nothing bounded a hang** (the `test` job had no timeout, tests no
  per-test timeout), superseded pull-request runs were never cancelled, and
  failures were hard to read: 60,000 lines of TAP, "timed out waiting for
  headless Chrome" with no cause, and an Arena e2e that printed nothing for
  eleven minutes.

**Measured result** (first run of the new pipeline, PR #542 run 34811820850,
against the old pipeline's 38 green pull-request commits from 2026-09-08 to
09-14):

| | Old pipeline | New pipeline |
| --- | --- | --- |
| PR wall clock (first job queued to last job done) | median 13.1 min (12.3 to 18.1) | 8.55 min (-35%) |
| Longest path | browser tests, ~13 min (4 shards of ~12 min) | a browser shard, 505 s (six shards, 484-505 s each) |
| Arena, when its inputs changed | one job, 10.1-11.6 min | group 1 424 s, group 2 300 s, in parallel |
| Unit + static | ~3.7 min | 237 s (6,788 tests executed, 0 failed) |
| Lint | ~0.4 min | 27 s |
| Runner time per PR | ~64 min | 66.2 min |
| Push to master after a merge | the whole estate again: 27 pushes cost 275 + 177 + 77 + 11 workflow-minutes | skipped when the tree already passed |
| Browser checks executed on CI | 2,237 (5 always skipped) | 2,244, 0 skipped |

Every job of the new run started within 5 s of the run being created, so
nothing waited on anything it does not need. The six browser shards' suite
time was 455-479 s, within 5% of each other; the critical path is those shards,
ahead of Arena group 1. Six shards, not eight, because a public repository on
GitHub Free runs at most 20 jobs at once and a pull request now peaks at ten,
so two concurrent pull requests fit without queuing; eight shards would save
about a minute and queue the second pull request instead.

**Real-clock sweep.** The unit estate was run under eight shifted clocks and
zones (early Monday UTC, late Sunday Los Angeles, Monday in Auckland, New
Year's Eve, both DST changes, a leap day, month end at UTC+14). Apart from the
two already fixed, nothing failed except tests whose code runs in a `node:vm`
realm (its `Date` is not the shifted one, so that is an artifact) and the
privacy review-date guard, which compares against today by design. The sweep's
preload replaced `Date` in the main realm only, so code the Arena tests load
into a `node:vm` context through `apps/arena/tests/helpers/app-vm.js` kept the
real clock. That leaves nothing calendar-dependent unswept: the functions loaded
there (`maybeResetForNewRound`, `progressRoomClock`, `livePlayers`,
`joinPlayer`, `sweepStalePlayers`) only compare `Date.now()` against stored
timestamps to measure elapsed time, and the two places `app.js` formats a
calendar date (`shareResultCard`, `formatRelativeDate`) are not loaded into the
vm at all.

**The first scheduled run (34815661555) was red twice, both times CI's own
doing.**

- *Coverage: "FAIL: 2 test(s) failed under coverage", and no names.* The pull
  request had added `--test-timeout=180000` to `npm test` and the coverage
  runner as a per-test bound. It is per FILE: with process isolation it bounds
  every test in a file together (two 1.2 s tests under a 2 s bound are
  cancelled at 2 s). V8 coverage slows the heavy FPL files unevenly, measured
  one file alone on four cores: `backtest.test.mjs` 21.9 s plain and 173.4 s
  covered, `optimizer-consistency.test.mjs` 51.0 s and 125.1 s. A runner took
  2.1 times as long as those four cores for the covered estate (606 s against
  288 s), so both files ran past 180 s and were killed, all their tests
  passing. The runner now names every failing test with its location and
  error, and the unit job and the coverage runner both print their slowest
  files against the bound (`scripts/test-file-times.mjs`), so the margin is on
  every run instead of discovered by a kill. That table then showed the plain
  bound was no safer: on a runner `optimizer-consistency.test.mjs` took 156.9 s
  of `npm test`'s 180 (87%), one slow runner away from killing a passing file
  on an unrelated pull request. Both bounds are set from those runner numbers
  now: `npm test` 600 s, coverage 1200 s (the slowest covered file took 281.5 s
  on one runner and 491.2 s on another an hour later) with 45 minutes for the
  job. The coverage job also restores the Rising Shows
  dataset; without it the real-catalogue tests skipped there (16 skips to the
  unit job's 7).
- *Coverage, once nothing was killed: two FPL CPU budgets* (a live-sized plan
  at 10062 ms against 10000, a transfer search at 2315 ms against 1500), both
  passed by the same run's plain unit job. Instrumented CPU is not planner CPU,
  so the six budgets compare only on the plain run and report under coverage;
  details in `apps/fpl-planner/FINDINGS.md`.
- *The dataset cache went cold after every data refresh.* The refresh bot's
  pull request merges with GITHUB_TOKEN, and that push starts no workflow, so
  the push-only `dataset-cache` job never ran for a new pin: after #543 merged
  at 11:37 UTC, master's entry for its pin was saved only by the weekly run at
  13:49. `refresh-rising-shows.yml` now saves the new pin's entry on master
  itself, before it opens the pull request. That the bot's merge starts no
  master CI run is intended, not a hole: branch protection is strict and
  requires lint, test, browser and rules on an up-to-date head, so the merged
  tree is the tree its pull request tested, which is the same guarantee the
  plan job relies on when it skips a person's merge (#543's merge tree and its
  tested head are both `7039607c`).

  A dispatched refresh on the same day proved the warm-up end to end (run
  34896187775; IMDb had replaced `title.basics.tsv.gz` after the morning run,
  so the content hash really changed). The new pin's key,
  `rising-shows-dataset-1bcf0dba…`, missed, the split ran, and the entry was
  saved on `refs/heads/master`. Bot PR #546's test job and all six browser
  shards logged `Cache hit for` that key and skipped the save. Its merge
  `5293edc6` carried the tested head's tree (`3dfdffa5`) and started no
  workflow run at all.

  The same run exposed a race in `scripts/bot-pr-autopilot.mjs`, now fixed.
  GitHub merged #546 at 21:46:25, and the autopilot's poll a second later
  still read it as open and `behind`, because master already held the merge.
  Update-branch then answered 422 and the refresh job went red, with its data
  merged and its bot branch left on the remote. A 422 there now continues the
  bounded poll, which sees the merge on its next read.
- *The mandatory local browser gate then caught a real Gym Tracker data race*
  (three `gym-units F` checks), which CI and every earlier run had missed only
  because their test clicked before the app's sync refresh ran. It was not a
  flaky test: an asked measurement-units question could be decided for the
  user by the next scan, storing 34 in as 34 cm. The fix prevents new cases;
  profiles it already damaged were checked and cannot be told apart from
  correct ones, so they are left untouched. Details in
  `apps/gym-tracker/FINDINGS.md`.
- *Arena S5: `timeout: Runtime.evaluate`* from a polling loop that read the
  page with plain `evaluate()`, the send-timeout hole `waitForExpr` had closed
  for itself. `probe()` in `tests/browser/cdp.mjs` closes it for hand-written
  loops; details in `apps/arena/FINDINGS.md`.

## A stalled third-party CDN held every page (2026-09-13)

A request that is refused fails fast. One that is accepted and never answered
(a lossy mobile network, a captive portal, a firewall that silently drops
Google or Cloudflare traffic) holds whatever the browser was told to wait for,
for as long as the connection hangs. Until 2026-09-13 every root and app page
told the browser to wait for a third party before it could run anything:

- `firebase-config.js`, `storage-sync-robust.js` and `app-sync-init.js` were
  plain (deferred) module scripts. Deferred modules run in document order,
  DOMContentLoaded waits on them, and `firebase-config.js` imports the SDK from
  www.gstatic.com.
- Google Fonts (Raleway everywhere, Inter on Gym Tracker, Arena's three
  families) and cdnjs Font Awesome 6 (FPL Planner, Gym Tracker, Rising Shows,
  Kometa) were parser-inserted `<head>` stylesheets, which block rendering and
  every later script.
- Chart.js came from cdnjs as a parser-blocking classic script, in Mario Kart's
  `<head>` and near the end of MapTap Rivals' body.
- `apps/gym-tracker/css/exercise-page.css` `@import`ed Inter.

How it surfaced: CI run 34754204478 on the Rising Shows data PR #534 failed six
Gym Tracker checks at 390 px, every one downstream of `js/app.js` never
evaluating while a gstatic request stalled (`apps/gym-tracker/FINDINGS.md` has
the trace, including the poll-time figure that gave it away). Measured
afterwards in headless Chromium with each host blackholed: gstatic,
fonts.googleapis.com and cdnjs each independently kept DOMContentLoaded from
firing on the pages that used them for as long as the test waited (40 s), and
Mario Kart rendered nothing at all, while the same hosts refused booted in
under 3 s. The browser check below failed on all 16 pages before the change and
passes on all 16 after it.

What changed:

- The three Firebase module tags carry `async`. The late-sync order this allows
  was already supported: `sync-immediate.js` buffers writes until
  `syncSystemReady`, every `window.firebaseAuth` consumer waits for
  `firebaseAuthReady`, and `app-sync-init.js` checks `document.readyState`.
  Arena still waits for the SDK by design: its `js/app.js` imports
  `firebase-config.js`.
- Every third-party stylesheet uses the non-blocking form the site already used
  for its own Font Awesome 4 (`media="print" onload="this.media='all'"` plus a
  `<noscript>` copy). Every font request already asked for `display=swap`, so
  a fallback face first is not new behaviour, and the enforced CSP sets no
  `script-src`, so the inline `onload` runs.
- Chart.js 4.4.1 is served from `assets/js/chart-4.4.1.umd.min.js`,
  byte-identical to the cdnjs file (both pages keep the same `integrity`
  hash). It stays a synchronous script because both apps' chart code expects it
  loaded, and from this origin it adds no dependency the page does not already
  have. To upgrade it, add the new versioned file, point both pages at it with its
  SRI hash, and delete the old one.
- The generated exercise pages link Inter non-blockingly from the generator
  templates instead of the `@import`.

`privacy.html` named "a charting library" among what pages load from cdnjs
and Google Fonts until 14 September 2026. That over-stated what the pages
contact (it broke no promise). It was not corrected the same day only because
the review-date guard then demanded a date strictly LATER than the one PR #533
had just published, which refused an honest same-day follow-up; the correction
shipped on the 14th with the Arena chat and room and MapTap handle corrections.
The guard now asks for the UTC day a change ships instead, so a second policy
change on the same UTC day keeps its date and nothing waits for a date to roll
over (`tests/static/privacy-review-date-rule.mjs`).

Guards: `tests/static/third-party-boot-path.test.mjs` (async Firebase modules;
no third-party script without `async`; no blocking third-party stylesheet in
any page or generator template; no third-party `@import`) and
`tests/browser/suites/site.mjs` "boots with every third-party CDN stalled",
which pauses every gstatic, cdnjs and Google Fonts request on each page and
requires DOMContentLoaded. Since 2026-09-14 no browser suite reaches those CDNs
at all (they are served from a committed mirror, see the CI section above), so
that check produces its stall deliberately with a `'hold'` interception rule. `tests/static/stylesheet-chain.test.mjs` counts the
Raleway link outside its `<noscript>` copy.

## Marketing pages load auth only; Firestore is imported where it is used (2026-09-13, audit S-7)

**What every page paid for.** `firebase-config.js` is on every page, because the
header's Sign In needs `window.firebaseAuth`. It used to import and start the
Firestore SDK (with its IndexedDB multi-tab cache) and the Realtime Database SDK
as well. Measured on production before the change, fresh profile, cache off, GA
blocked, median of three loads: every marketing page (`/`, `/about`, `/work`,
`/contact`, `/apps`, `/privacy`) downloaded 216 KB compressed of Firebase code
(`firebase-app`, `firebase-auth`, `firebase-database`, `firebase-firestore`),
about three quarters of the 291 KB of script those pages load, and none of them
ever sent a Firestore request. On a mobile user agent `getAuth()` also installed
the popup/redirect resolver, which loaded Google's auth iframe on every page
view (3 more requests, about 40 KB).

**The split.**

- `firebase-config.js` is the app plus auth: `initializeAuth(app, { persistence:
  [browserLocalPersistence, indexedDBLocalPersistence, browserSessionPersistence] })`.
  localStorage first, as `setPersistence(browserLocalPersistence)` made it before;
  the other two are only read to find a session saved before that. No
  popup/redirect resolver, because nothing on the site signs in by popup or
  redirect (email and password, and anonymous guests for Arena). If a popup or
  redirect sign-in is ever added, pass `browserPopupRedirectResolver` there.
- `firebase-firestore.js` initialises Firestore on that app and is imported by
  the sync engine (`storage-sync-robust.js`), Arena's `app.js` and the MapTap
  rival network's dynamic import. App pages load it through the engine;
  account deletion on a marketing page gets it through `app-sync-init.js`'s
  dynamic import, only when used.
- The emulator seam spans both files through `firebaseEmulatorsEnabled`.
- The Realtime Database is gone: production always used Firestore
  (`USE_FIRESTORE` was hard-coded `true` and no caller passed `false`), so the
  engine's RTDB session and flush paths, the SDK import, `database.rules.json`
  and the database emulator were dead.

**After.** Measured the same way on the deploy preview of PR #540: every marketing page
downloads 136 KB of script instead of 291 KB (332 KB on the mobile user agent),
59 KB of it Firebase (`firebase-app`, `firebase-auth`) instead of 216 KB, and
parses 465 KB of JavaScript instead of 1,067 KB. The mobile auth iframe is gone
(31 to 32 requests instead of 33 to 34). App pages still load Firestore, 168 KB
of Firebase instead of 216 KB because the Realtime Database SDK went. The auth
adapter is ready at the same moment or earlier (the home page on a phone, 546 ms
median before, 501 ms on the preview) and DOMContentLoaded did not move. A
disposable-account probe on the preview signed up, synced, switched accounts,
deleted accounts and uploaded signed-out work exactly as on production.

Compare LOAD time on production, never on a deploy preview: previews inject
Netlify's collaboration drawer (`<script async src="/.netlify/scripts/cdp">`),
which production never serves, and it adds requests and delays `load` on every
page it lands on.

**Traps.** `firebase-firestore.js` must stay on the publish allow-list
(`scripts/build-publish-dir.mjs`), in Trip Planner's precache, in the Arena
workflow's inputs, and in both `eslint.config.mjs` blocks that name
`firebase-config.js` (the module block alone gave it 0 lint rules; the
correctness-rules block is the one that counts). Pinned by
`sync-system/tests/firebase-config-shape.test.mjs` ("firebase-config imports
only the app and auth SDKs", the `initializeAuth` persistence pin, and the
direct-Firestore-import allowlist).

## The index baseline, measured 2026-09-05

Read from the Search Console URL Inspection API the day the SEO round shipped,
so there is a real before-state to compare against rather than a guess:

| URL | Google's verdict | Last crawled |
| --- | --- | --- |
| `/home` | Submitted and indexed | 2026-08-30 |
| `/` | Page with redirect (correct, it 301s to /home) | 2026-08-16 |
| `/apps/arena/` | Crawled, currently not indexed | 2026-07-14 |
| `/apps/football-h2h/` | Crawled, currently not indexed | 2026-06-04 |
| `/apps/gym-tracker/` | Crawled, currently not indexed | 2026-05-20 |
| `/apps/maptap-rivals/` | Page with redirect | 2026-05-19 |
| `/apps`, `/work`, `/about` | URL is unknown to Google | never |
| `/apps/fpl-planner/`, `/apps/mario-kart/`, `/apps/rising-shows/`, `/apps/trip-planner/` | URL is unknown to Google | never |
| `/apps/rising-shows/shows/shape/rising/` | URL is unknown to Google | never |

**One page of the site was indexed.** Four app pages had never been crawled at
all, and every URL inspected reported `sitemap: []` - covered by no sitemap
Google knew about.

The cause was two things compounding. The header and footer were the site's
only internal link graph and robots.txt hid them (see the first section in this
file), so Google had almost no path from one page to another. And the canonical
`https://shevato.com/` property had **no sitemap submitted at all**: the only
registration was `https://www.shevato.com/sitemap.xml` on the domain property,
pointing at the `www` host that 301s to the apex, last downloaded 2026-08-05 and
reporting 34,494 URLs from before the sitemap was curated. `/home` is indexed
because it is where the apex redirect lands, which is the one path that did not
depend on either.

Two corrections to what this repo previously asserted, both of which were taken
on trust rather than checked:

- `sitemap.xml`'s own comment said submitting that one URL to Search Console
  covers all three sub-sitemaps. True in principle, but nobody had submitted it
  to the canonical property. Fixed 2026-09-05; Google downloaded it one second
  later with zero errors.
- "Re-submitting a sitemap does not speed anything up" is correct for an
  already-registered sitemap and was the wrong thing to say here, because this
  one was not registered.

Check the state, do not assume it. The API commands are in the README's
Deployment section.

## "Page with redirect in a sitemap" named a sitemap nobody was serving

Search Console mailed both properties on 2026-09-06 with a new reason for
pages *in a sitemap*: `Page with redirect`. Every URL the site actually
serves in a sitemap was fetched and none of them redirects - 2,172 of 2,172
returned 200, matching the `submitted: 2172` the API reports for
`https://shevato.com/sitemap.xml`. So the redirecting URL was not in a
sitemap this repo produces.

It was in the stale `https://www.shevato.com/sitemap.xml` registration
(submitted 2026-08-05, 34,494 pre-curation URLs, re-downloaded 2026-09-05
14:19 UTC). URL Inspection settles it without guessing, because
`indexStatusResult.referringUrls` names where Google found a URL:

```
/apps/brain-arena/  ->  Page with redirect
  referringUrls: [ "https://www.shevato.com/sitemap.xml" ]
```

`/apps/brain-arena/` is the pre-rebrand Arena path that `netlify.toml` 301s.
**When a coverage verdict does not match what the live site serves, inspect
the URL and read `referringUrls` before touching anything.** The verdict is a
statement about a fetch Google made, possibly months ago, from a source that
may no longer exist; `sitemap: []` on such a URL means "not in a sitemap I
list for this property", not "no sitemap sent me here".

Sitemap registrations are **per property**, and that stale one was on two of
the three: the `sc-domain:shevato.com` domain property and the
`https://www.shevato.com/` URL-prefix property. Deleting it from the domain
property alone would have left Google re-downloading it through the other, so
list every property before concluding a sitemap is gone. Both were deleted on
2026-09-06 (HTTP 204 each), leaving `https://shevato.com/sitemap.xml` as the
only registration anywhere and the `www` property with none, which is correct:
every URL on that host 301s to the apex.

Two more verdicts worth knowing, from the same sweep: a coverage state can be
stale in the good direction too (`/apps/maptap-rivals/` was `Page with
redirect` in the 2026-09-05 baseline and was `Crawled - currently not indexed`
a day later, with no change to that page), and four sitemap URLs still report
`NOT in sitemap` on the canonical property while the sitemap that lists them
downloads with zero errors, so the association lags the download.

## The apex is a redirect, so JSON-LD must not name it

`netlify.toml` 301s `/` onto `/home`. A JSON-LD `url` or `item` of
`https://shevato.com/` is therefore a redirect hop wearing structured-data
clothes, and it ships on every page carrying the block. The ~35k generated
pages were already correct (`render-show-page.js` and
`render-exercise-page.cjs` both emit `${SITE}/home` for the Home breadcrumb);
ten hand-written pages plus `assets/seo/organization.jsonld` and
`assets/seo/website.jsonld` named the apex until 2026-09-06.

`@id` is the deliberate exception: `https://shevato.com/#organization` and
`#website` are node identifiers for the sitewide graph, never fetched, and
they are what every other page's `isPartOf` / `about` points at. Rewriting
them would break the graph. `tests/static/canonical-urls.test.mjs` checks
`url` and `item` only, by walking the parsed JSON rather than scraping
strings, for exactly that reason.

## robots.txt Disallow deletes content from the index, it does not hide files

Google's rendering service obeys `robots.txt` for SUBRESOURCE fetches. A
`Disallow` on a path a page *loads* therefore removes whatever that path
contributes from the DOM Google indexes; it does not merely keep a file out of
search results. This is the single most damaging thing that has been wrong
with this site's SEO, and it was invisible to every check we had.

Until 2026-09-04 `robots.txt` disallowed four things the pages themselves load:

| Path | Loaded by | Cost |
| --- | --- | --- |
| `/partials/` | `assets/js/main.js` on all 17 pages | the entire header and footer navigation |
| `/sync-system/` | first `<script>` in the head of every app page | sync boot (app still rendered) |
| `/firebase-config.js` | a module on every page | auth boot |
| `/apps/*/scripts/` | Rising Shows loads 4 of them with `<script src>` | the shape matcher, finder, providers and Kometa logic |

Measured by rendering production in headless Chrome with exactly those paths
blocked at the network layer: `document.getElementById('header')` was `null`
on every page, most app pages had **zero** internal outbound links,
and `/privacy` had zero inbound ones.

Two things follow. First, `tests/static/robots-references.test.mjs` now fails
when any path referenced by a page, an ES-module import, or an absolute path
literal in shipped JS is matched by a `Disallow` rule - it is the only check
that asks whether a crawler is *allowed* to fetch a resource, as opposed to
whether the resource exists (`internal-links`) or is named canonically
(`canonical-urls`). Second, the fix is belt AND braces: the `Disallow` lines
are gone, and `scripts/inline-partials.mjs` stamps the header and footer into
the HTML at deploy so the navigation no longer depends on a crawler fetching a
second document or running JavaScript at all.

Note the asymmetry that made this survive so long: the two GENERATED page
families (`shows/`, `exercises/`) render their cross-app footer server-side, so
they had better internal linking than the hand-written app pages they exist to
support.

## The include attribute has two names, and only one of them works locally

`scripts/inline-partials.mjs` rewrites `data-include="footer"` to
`data-include-inlined="footer"` at deploy. Anything that SELECTS the attribute
must match both forms or it works in every local check and silently stops
working in production. `main.css`'s sticky-footer rules
(`body:has(> [data-include="footer"])`) shipped exactly that way for one commit
during the 2026-09-04 round. The one deliberate exception is `main.js`'s
runtime-fetch loop, which must match only the un-stamped form or it would
re-fetch a partial that is already inlined.
Pinned by `tests/static/inline-partials.test.mjs`.

## Runtime JS can overwrite the `<title>` Google indexes

Google indexes the RENDERED title. `apps/mario-kart/js/gameVersionManager.js`
ran `document.title = 'MK8 Deluxe - Race Tracker'` on every load, before any
user interaction, so the page's real `<title>` never reached the index and the
search result named neither the site nor what the page does. In-page state (a
game-version toggle, a selected tab) is not a different page and must not
rewrite the document's title, canonical, description or `h1`. A sweep on
2026-09-04 found this was the only instance; there are no runtime rewrites of
canonical, description or robots meta anywhere in the repo.

## Desktop-only CLS from the scrollbar gutter

A page that paints short and then grows past the viewport when its JS renders
gains a scrollbar mid-load, which narrows the viewport and slides every centred
container ~5 px left. Scored against a viewport-filling element that horizontal
move dominates CLS: Rising Shows measured **1.179** and Trip Planner 0.341 at
1280x900. Mobile was ~0 throughout, because phone scrollbars are overlays and
take no width, which is why this never showed in the mobile field data that
carries the ranking weight.

`html { scrollbar-gutter: stable }` in `main.css` reserves the gutter site-wide
and took Rising Shows to **0.071** (measured A/B on identical bytes, same
session, with the fix reverted at runtime). Containers that fill in after a
data load also need a `min-height` or they push everything below them down:
`.finder-moods` grew 44 px -> 112 px at ~3 s. Trip Planner's remaining shift
could not be reproduced locally and still needs measuring on production.

## App pages need prose, and it is not optional for search

Most app pages rendered almost nothing but interface labels to a
crawler - Football H2H came to 264 words, of which roughly ten were sentences.
A page cannot rank for "head to head football score tracker" when neither that
phrase nor any description of the tool exists on it. Each app page now carries
a 250-400 word `.app-about` block (shared styling in `main.css`, scoped so each
app tints it from its own palette), written from that app's README.

The block goes on the app page itself, NOT on a separate `/apps/foo/about`
page: a keyword page sitting beside the app it describes is a doorway page, and
it splits link equity across two URLs. `apps/fpl-planner/index.html` had the
right shape all along and is the model.

Two claims in the first draft over-promised against `privacy.html`, which is
binding: Arena guest play was described as keeping nothing (it signs you in
anonymously to Firebase and merely cannot write to the leaderboard), and Trip
Planner's section implied nothing ever leaves the device (the assistant and the
venue-ratings lookup send trip contents to Google). Check new marketing copy
against `privacy.html` the same way code is checked against it.

## Netlify rewrites hrefs inside served HTML, including XHR-fetched partials

Netlify's Pretty URLs post-processes every HTML response: `href="/home.html"`
in `partials/header.html` is delivered as `href='/home'` (note the quote
change) on shevato.com. That is why the `.html` hrefs in partials and page
bodies do not produce 301 hops in production, and why the filename-based
active-page highlight in `main.js` works there although it compares against
`.html` names.

Do NOT rely on this for JSON or JS string URLs, or for XML: they are not
rewritten. `site.webmanifest` `start_url` is `/home` (was `/home.html`, a
redirect hop on every installed-app launch), pinned by
`tests/static/webmanifest.test.mjs` ("site.webmanifest launches on the
canonical /home and paints a dark splash"). `sitemap-pages.xml` once carried
four moadon-alef hreflang alternates, all `.html` URLs naming the same page;
the 2026-08-22 site audit (91503c5) removed them rather than correcting them,
because one URL serves all three languages and a set of alternates that names
one page four times tells Google nothing. The sitemap declares no alternates
today, so `tests/static/sitemap-alternates.test.mjs` holds vacuously: it only
bites if alternates come back, when none may end in `.html` and every href
must be a `<loc>`.

## Partial injection timing: listen for `shevato:include-loaded`

Anything that must touch the header or footer partial (language switching,
year fill, aria state) runs after `DOMContentLoaded`, which fires before the
partials exist. `main.js` now dispatches
`document.dispatchEvent(new CustomEvent('shevato:include-loaded', { detail: { file } }))`
at the end of every `$element.load()` callback; `language-switcher.js` hooks
that event and re-applies the current language, which is what makes the
moadon-alef footer follow a persisted Hebrew/Russian choice on reload (it
used to stay English under an RTL Hebrew page until the next button click).
Pinned by `tests/browser/suites/site.mjs` "moadon-alef: injected footer is
localised after a persisted-language reload".

## main.js on pages without a header partial

`waitForHeader()` polls every 100 ms for `[data-js=auth-container]`. It is now
bounded: 100 attempts, and it stops immediately when the page has no
`[data-include="header"]` at all (moadon-alef). Before that it was a permanent
10 Hz timer on a landing page built for phones. A header that arrives late is
still covered by `onHeaderLoaded()` from the include callback.

## A lint glob that says `.js` does not cover `.mjs`, and nothing tells you

`eslint.config.mjs` matched browser code with `sync-system/**/*.js`. The three
standalone modules in that directory carry the `.mjs` extension, so they matched
nothing, and a flat-config block that matches nothing contributes nothing: they
resolved to **zero rules**, not even `no-undef`. One of them is
`sync-helpers.mjs`, which holds `decideRemoteChange`, `mergeValues`,
`pickConflictWinner` and `planFlushBatches` - the conflict-resolution core,
loaded on every app page. The same shape hid two more classes: both service
workers (the `**/sw.js` block had globals and no `rules` key, which also
contributes nothing) and `apps/gym-tracker/data/exercises-db.js`, which sits
outside `apps/*/js/**`.

Six shipped files, including the ones with the worst bug history in the repo,
were outside the gate that exists BECAUSE a `ReferenceError` shipped for 12
days. Fixed 2026-09-11; all six were clean once linted, so this was pure
coverage, not a backlog.

**The only honest way to check this is `eslint --print-config <file>` and
counting `rules`.** A passing `npx eslint .` proves nothing here: a file that
matches no block is not an error, it is silently skipped. Run that command
against a representative file from each class after any edit to the `files`
lists, and compare against a file you know is covered (28 rules today). The
same trap applies to any future `.mjs`, `.cjs`, or `data/` addition.

## A write that did not land must be said, and resent (sync failure surfacing)

Two rounds, each fixing a lie the pill told with the whole test estate green.

**2026-09-11: an event with no listener is not a feature.** The engine
already dispatched `syncWriteRejected` and `app-sync-init.js` dispatched
`appSyncFailed`, both with comments saying the banner would render them, and a
grep found zero listeners. Writes stopped reaching Firestore and the pill read
**Synced**. `assets/js/sync-status.js` now listens.

**2026-09-13 (audit S-3): the engine only reported the rarest failure.** Four
ways a write still vanished quietly, all reproduced against the real engine:

- A retryable failure (`unavailable`, a network error) that outlasted the
  three-step retry ladder was dropped from the queue with a console line. The
  key stayed dirty, so no later path resent it either.
- `permission-denied` was treated as transient: three resends of a rules
  refusal, then the same silent drop.
- An edit inside the 500 ms debounce before closing the tab or signing out was
  persisted dirty, restored dirty on the next start, and never re-enqueued.
- `flushWrites` empties the queue before the network call, so the pill read
  Synced while the only copy of an edit was on the wire (audit F9).

### What the engine does now (`storage-sync-robust.js`)

- **Permanent** = `isPermanentWriteError` in `sync-helpers.mjs`:
  `payload-too-large`, `invalid-argument`, `permission-denied`,
  `unauthenticated`, `not-found` (a `merge: true` setDoc creates a missing
  document, so not-found means the path or database is structurally missing).
  One attempt, no ladder, not requeued, keys stay dirty, event with
  `retryable: false`. The next sync start tries the dirty keys once.
- **Retryable** = everything else, including `failed-precondition`, whose
  client-side causes (persistence tab lease, index building) change without
  the batch changing. The ladder runs as before; when it runs out, the batch is
  requeued and the session is **parked**: no timer resends it, event with
  `retryable: true`.
- **Bounded resend triggers** for a parked write: the next local change in
  that namespace (the flush sends the whole queue), window `online`, the tab
  becoming visible, and the next sync start for the same user (including the
  same-user re-entry `initAppSync` makes). Each runs at most one ladder, so a
  backend that stays down costs four attempts per trigger and never loops.
  Hidden is NOT a resend trigger, or a tab flicking in and out would be a loop.
- **Dirty re-enqueue** (`requeueDirtyKeys`) runs at the first
  server-confirmed snapshot, not at start, so each dirty key has already been
  compared with the cloud and a moved cloud is merged rather than overwritten.
  It only re-sends a key whose current value is still exactly the persisted
  dirty write, at that write's revision. A value that drifted afterwards
  (written while no session ran) is uploaded at a NEW revision when a person
  produced it, and gives way to the cloud when only an app's own boot did
  (since 2026-09-13; see "The account boundary"). `enqueueLocalOnlyKeys`
  skips keys already queued, or the write would go twice at two revisions.
- **Never resend an acknowledged write.** Ack clears dirty and is persisted.
  An ack that arrives after `stopSync` (sign-out wait timed out) has no live
  revision map, so `markAckedOnDisk` patches the stored record when rev and
  hash still match.
- **Last-second edits.** `pagehide` and `visibilitychange` to hidden flush any
  write waiting on a debounce or backoff timer immediately; setDoc is reached
  within that event's microtask checkpoint, after which Firestore's persistent
  cache owns it. `firebase-config.js` awaits `window.__shevatoFlushSync`
  (`flushAllNow`, parked writes included) before `auth.signOut()`, bounded at
  1500 ms, because a write attempted after sign-out is refused and offline a
  setDoc never resolves. The hook is on `window` because firebase-config.js
  cannot import the engine (the engine imports it). Neither flushes a
  namespace whose first server snapshot has not been reconciled yet (audit
  T-3): that write has never met the cloud.
- **`stopSync` does not flush.** It runs from the auth listener after
  sign-out, when the write would be refused. It persists the dirty flags and
  drops the in-memory queue; `requeueDirtyKeys` brings the writes back. It
  also cancels the ladder's backoff timer, and `flushWrites` returns early for
  a stopped session: `writeQueues` is keyed by namespace, so a stale timer
  used to be able to flush the NEXT session's queue under the old uid.
- **Status.** `getGlobalStatus().totalQueueSize` counts queued plus in-flight
  keys (`inFlightWrites` separately); both pills read that field.
  `getSyncStatus(ns)` adds `inFlight` and `parked`.

### Event contract (add fields, never rename or remove)

- `syncWriteRejected` `{ namespace, keys, code, message, retryable }`.
- `syncWriteRecovered` `{ namespace }`, dispatched when every key announced as
  rejected in that namespace has been acknowledged. Tracked key by key
  (`rejectedWrites`), because another key landing is not evidence the rejected
  one did.
- `appSyncFailed` and `syncConflict` unchanged.

### What the widget does (`assets/js/sync-status.js`)

- **A failure outranks the poll.** `render()` runs every 2s and the tail of
  `updateBanner` hides the banner for any state it does not recognise, so the
  failure states are handled before that tail and `classify` returns them
  ahead of every healthy state.
- Write failures are latched per namespace until `syncWriteRecovered` for THAT
  namespace. Pill and banner states: `failed` "Not saved to cloud" (red, any
  refused namespace, sticky even if a later failure there is retryable; a
  missing `retryable` means false), then `unsaved` "Not saved to cloud yet"
  (amber, only retryable failures outstanding), then `failed` "Sync
  unavailable" for a failed init, which alone is retired by evidence (any
  namespace active), never by a timer.
- `offline` still outranks every failure: when the connection is down that is
  the more actionable truth, and the failure is still there when it returns.
- **The banner names apps, never namespace ids.** The copy used to interpolate
  the engine's id, so a visitor read "Some changes in tripPlannerApp have not
  been saved"; FPL Planner and the new unsaved state made that visible on more
  pages (found on the deploy preview, 2026-09-13). `APP_NAMES` maps every id to
  the site's own name (`globalPrefs`, which holds only the theme, reads "your
  site settings"). An unknown id is left out of the sentence but still counted,
  so it cannot soften a refused write into "not saved yet". The test reads the
  namespaces from `sync-system/app-sync-init.js`, so a new app without a name
  fails it.

Pinned by `sync-system/tests/storage-sync-failure-honesty.test.mjs` (real
engine: exhaustion, each trigger, one ladder per trigger, permanent, restart
re-enqueue, no duplicate of an acked or late-acked write, signed-out work
versus an app's own rewrite,
pagehide, hidden, the sign-out flush, in-flight status),
`sync-system/tests/firebase-config-signout-flush.test.mjs` (the real
firebase-config.js adapter: flush before signOut, bounded wait, a throwing
flush) and `assets/js/tests/sync-status.test.js`.

The residual this section used to end with (a failed first upload of
local-only keys was only a console line) is gone: since 2026-09-13 those keys
go through the queue like any other write, with a dirty revision, the ladder
and `syncWriteRejected`.

## Shared sync banner stacking

`#sync-banner` (`assets/css/sync-status.css`, `assets/js/sync-status.js`) sits
BELOW the fixed site header: `z-index: 10000` (the header is 10001) and
`sync-status.js` sets its `top` to the header's bottom edge on every show and
on resize. It used to be `z-index: 10100` pinned at `top: 0`, which made the
logo, Menu toggle and Sign In unclickable on every app page for the whole
offline period. It also has a close button now, and the recovery copy is
"Back online, synced" only when sync is actually active; a signed-out visitor
gets plain "Back online" (it used to tell a "Local only" user they were
synced, with an em dash the repo conventions forbid).
Pinned by four checks in `tests/browser/suites/site.mjs` under
"sync banner:" (header hit-test while offline, no em dash, signed-out copy,
dismissible).

## Lazy images inside flex cards size to ~3 px until they load

An `<img loading=lazy>` with `width:100%; aspect-ratio` inside a
shrink-to-fit flex item (the apps-hub `.highlights > *` cards) sizes to about
3 px until it loads, because the percentage resolves against a container whose
size depends on the image's intrinsic width; `width` / `height` attributes do
not help. On phones every card below the fold jumped 125-190 px as it scrolled
into view. The fix is a definite width on the wrapper: `apps.html` gives
`.highlights .app-preview-link { display:block; width:100% }` and the image
`min-width:100%`. Do the same for any lazy image inside a flex card.
Pinned by `tests/browser/suites/visual.mjs` "visual mobile apps hub: lazy
previews reserve their height before scroll" / "previews span the card width".

## Shared auth modal (assets/js/main.js + firebase-config.js)

- Users never see raw SDK strings. `firebase-config.js` `ERROR_MESSAGES` maps
  every code we have observed (including `auth/network-request-failed`,
  `auth/user-disabled`, `auth/operation-not-allowed`, `auth/too-many-requests`)
  and `formatAuthError` falls back to generic copy instead of `err.message`.
  `main.js` adds a second net: `userMessage()` refuses anything that still
  looks like an SDK string (`^firebase` or `(auth/`).
- Submit buttons are disabled (`aria-busy`) while a request is in flight, and
  the handlers refuse to start a second one, so a double click cannot fire two
  sign-in attempts.
- `hideAuthModal()` clears field errors and returns the modal to the Sign In
  tab; it used to reopen on Sign Up with a stale "valid email" error under an
  empty field. `handleForgotPassword()` clears the banner first, so a failed
  sign-in error no longer sits next to a fresh reset confirmation.
- The active tab is `#4558c8`, not the brand `#667eea`: 6.0:1 on white where
  `#667eea` was 3.66:1 and failed WCAG AA at 14 px. The modal is the one shared
  surface no page-level axe scan sees, so `a11y.mjs` now scans home with it
  open.
- The header Sign In button gets a `:focus-visible` outline. The
  `#header .auth-container .auth__button` reset in `firebase-auth.css` pinned
  `outline:none !important`, which left it the only unlit header control.
Pinned by five "auth modal:" checks in `site.mjs` (driven with
`interceptNetwork` failing identitytoolkit), "kbd home: Sign In button shows a
visible focus indicator" and the auth-modal axe scan in `a11y.mjs`.

## Mobile menu is a panel, not a dialog: the extras live in main.js

`util.js` `panel()` only toggles `is-menu-visible` on `<body>`. Everything a
dialog-like panel needs is in `initializeMenu()`'s `handleMenuVisibility`,
keyed off that class:

- scroll lock (`overflow:hidden` + `position:fixed` + `top:-<scrollY>` on
  body, restored with `window.scrollTo` on close) - the page used to scroll
  from 300 to 900 behind the open panel;
- focus into the panel, and a `keydown.menufocus` Tab/Shift+Tab cycle inside
  it - Tab used to land on the hero buttons behind the panel;
- focus back to the Menu toggle whatever closed the panel.

Gotcha: `#menu` transitions `visibility` over 0.5s and `focus()` on a
still-hidden element is silently ignored, so the first link is focused with a
short retry (12 x 60 ms), not once on the class flip. `main.css` now also
honours `prefers-reduced-motion` for the header, the panel and the `is-preload`
banner fade (only `back-to-top.css` and `firebase-auth.css` did before).
Pinned by three "kbd mobile menu" checks and "mobile menu: no slide transition
under prefers-reduced-motion" in `a11y.mjs`, plus two "mobile:" scroll-lock
checks in `site.mjs`.

A green suite is not the same as a quiet console (fixed 2026-09-05).
`handleMenuVisibility` ended with `wasOpen = isVisible;`, a leftover of the
rename to `menuOpen`; `wasOpen` was declared nowhere and `main.js` is
`'use strict'`, so **every** menu open and every close threw
`ReferenceError: wasOpen is not defined` out of the MutationObserver callback.
Nothing broke visibly - it was the last statement, so the scroll lock and focus
work above it had already run, and the throw died inside the observer - which
is exactly why it survived. It was caught only by GA4: 26 `app_error` events,
4 external mobile users, 3 continents, and 100% of `app_error` for the
2026-08-22..09-04 fortnight.

Two lessons worth keeping:

- **A load-time error check cannot catch an interaction-time error.**
  `site.mjs` already asserted `${p}: no JS errors` for all 8 root pages, so on
  paper the menu page was covered. But that check runs immediately after
  `goto()`, and `goto()` CLEARS `s.errors`; it can only ever see errors thrown
  during load. The menu toggle happens 400 lines later and its exception was
  never re-read. Assert `cleanErrors(s)` AFTER each interaction that runs app
  code, not only after navigation. `site.mjs` now ends its scroll-lock block
  with "mobile: menu open/close throws no JS error".
- **The suites split the coverage exactly wrong.** `a11y.mjs` toggles the menu
  13 times and checks errors 0 times; `apps.mjs` and `pwa-gym.mjs` check errors
  12 times between them and never touch the hamburger. Two halves of the same
  test, in different files, that never met.
- **A dead store in strict mode is not dead code, it is a crash.** Add this to
  the dead-code traps below: an assignment whose value is never read still
  throws if the binding does not exist, so "nothing reads `wasOpen`" was true
  and still not safe to ignore.
- **The class is now caught statically.** `npm run lint` (ESLint, 29
  correctness rules, seconds) fails on any undeclared identifier and would have
  failed the merge that introduced this. It found seven more defects across its
  first runs: the `$a`/`b` leak in `util.js` below, the always-true
  `typeof x != 'jQuery'` guards also in `util.js`, a call to a nonexistent
  `updatePlayerModalContent()` in football-h2h, two dead `typeof` branches in
  mario-kart, unsafe `hasOwnProperty` in two import paths, and a function
  declaration reassigned to monkey-patch itself. Cross-file globals in the
  classic multi-script apps are declared in `eslint.config.mjs`; add to that
  list when you add a real one.


**The telemetry that caught it went blind for a week afterwards.** PR #506
(2026-09-07) replaced `error_message` with `error_code` and put a normaliser in
front that refuses free text, but left both global handlers passing the
message, so every real error arrived as `unclassified` (and a one-word message,
being code-shaped, was forwarded verbatim). This bug would have read `window` /
`unclassified`, which says nothing. Since 2026-09-13 the handlers classify by
shape (`classifyWindowError`, `classifyRejection` in `assets/js/analytics.js`):
a standard error name, a Firebase code from a closed vocabulary, `script_error`,
`non_error_rejection`, else `unclassified`; `error_source` is a same-origin
pathname or `external`. `tests/static/analytics-call-sites.test.mjs` pins the
event and action vocabulary. Lesson: when a field changes from free text to a
code, change its producers in the same PR, because a normaliser that fails
closed hides the breakage behind a valid-looking value.

## `var a = 1; b = 2` silently creates a global

`assets/js/util.js` `navList()` opened with

```js
var $this = $(this);      // <- semicolon, not comma
    $a = $this.find('a'),
    b = [];
```

so the `var` statement ended at the first line and `$a` and `b` were
assignments to undeclared names. `util.js` has no `'use strict'`, so rather
than throwing they would become `window.$a` and `window.b` on every call.

It never actually fired: `navList` is defined here and called nowhere in the
repo (it is an unused plugin from the original template), so the leak was
latent, not live. Fixed 2026-09-05 by restoring the comma, and now caught by
`no-undef`.

Worth keeping for the contrast with the `wasOpen` bug above: the identical
mistake, an assignment to an undeclared name, throws loudly in a strict file
and silently pollutes `window` in a sloppy one. Sloppy mode hides this class
entirely, which is exactly why a static check earns its place over relying on
runtime error telemetry.

## `typeof x != 'jQuery'` is always true

Also `util.js`, also found by lint (2026-09-05). Both `panel()` and
`$.prioritize()` opened with

```js
if (typeof config.target != 'jQuery')   // typeof gives 'object', never 'jQuery'
    config.target = $(config.target);
```

so the guard never held and the value was re-wrapped on every call. Unlike
`navList` this IS live: `main.js` builds the mobile menu through `panel()` with
`target: $body`, an already-jQuery value, so every menu build re-wrapped it.
Harmless in effect, because `$(jqObject)` yields an equivalent object, but the
check never did what it claimed. Now `!(config.target instanceof $)`.

The general trap: `typeof` only ever returns one of eight strings. Comparing it
to a constructor or class name always succeeds, and the branch you thought was
conditional is unconditional. `valid-typeof` is enabled to catch it.

## Seed storage BEFORE the first navigation, not between two of them

Every seeding helper in this repo grew the same shape, for the same reason:
localStorage can only be written from a page already on the target origin, so
you navigate, write, and navigate again. `seedAndReload` did it, `apps.mjs`'s
`fresh()` does it, `a11y.mjs`'s app-root loop does it, and the maptap audit did
it three times over (reach the origin, clear, boot the seed).

CDP removes the constraint. **`Page.addScriptToEvaluateOnNewDocument` runs
before any page script on the next document**, so the seed is already in
storage the first and only time the app boots. `seedAndReload` now installs the
seed (and, with `clearPrefix`, the wipe) that way, navigates once, and removes
the script immediately - leaving it installed would silently re-seed every
later navigation in the suite and undo anything a test wrote and reloaded to
check.

Measured on `apps/maptap-rivals/e2e/audit-2026-08.mjs`, whose fixture is 347
games so every navigation re-renders all of them: **100.7s -> 81.4s**, 53/53
checks unchanged.

**The bigger reason is correctness, not speed.** The two-navigation shape boots
a REAL instance of the app against unseeded storage, and that instance can
still write. `trip-planner`'s `ensureTrip()` is the documented case: seeing no
trip, it creates an empty default and saves it, landing AFTER the fixture and
replacing it, so a test whose first assertion needs an item fails while one
that only counts rendered cards passes. `apps/trip-planner/e2e/helpers.mjs`
carries a verify-and-reseed retry loop purely to survive that. Seed before the
first document and no unseeded instance ever runs, so there is nothing to
clobber and nothing to retry.

`openApp` (trip-planner), `fresh()` (apps.mjs) and the a11y app-root loop still
use the old shape. Converting them is the same change and worth doing; it was
left alone here only because each one owns a retry or cleanup path that has to
be unwound with it.

## Fixed waits are 60% of the browser estate, and most have a condition available

Measured 2026-09-05 across all 28 suites (`run.mjs` prints the breakdown): the
estate spends **60% of its wall clock on fixed sleeps**, 20% on navigation, 6%
on condition polling. There are 249 explicit `sleep(N)` sites totalling 142.5
seconds, before the `settle:` values and before loop multiplication.

Re-measured 2026-09-14 over 32 suites, now split by WHERE the wait comes from
(`cdp.mjs` tags each fixed wait; `run.mjs` prints "fixed waits by source"): of
2,561 suite-seconds, **1,928 (75%) are fixed waits**: 1,015 s of `goto()`
settle, 486 s of click settle, 377 s of explicit `sleep()`, 47 s after key
presses. Condition polling is 154 s and navigation 278 s. The settle after a
navigation is the largest single lever.

Triaged by what surrounds them:

| class | sites | ms | verdict |
|---|---:|---:|---|
| quiescence / negative assertion | 69 | 48,170 | **required**, but should become an idle-wait |
| already preceded by `waitForExpr` | 26 | 15,650 | redundant |
| after a click | 44 | 24,150 | replaceable with the DOM effect |
| after an in-page call | 46 | 17,050 | replaceable with the rendered result |
| after a scroll / view switch | 13 | 6,620 | replaceable with the view's marker |
| uncertain | 51 | 30,880 | needs reading |

Two rules worth keeping:

- **You cannot wait for something NOT to happen, so a quiescence sleep is
  legitimate** - `places.mjs` proves "this render billed no new Places calls" by
  waiting and then asserting the counter did not move. The improvement there is
  not deletion, it is waiting until the counter has been IDLE for a few hundred
  ms instead of sleeping a flat 3 seconds.
- **A fixed settle before a layout-dependent read is a flake, not a wait.**
  `quality.mjs` read `.view-tabs` `dataset.scroll` after `hashTo(..., 1200)`;
  the app writes that from an observer after layout settles at the new width,
  and on a 4-way parallel run it reported `{scroll:"none", mask:false,
  scrollable:true}` - the strip was already overflowing while the app had not
  yet said so. Serial runs hid it. It now waits for the state the assertion is
  about.

## A fragment-only `goto()` used to cost 21 seconds, silently

`goto()` navigates and then waits for `Page.loadEventFired`, racing it against
a 20-second guard. A SAME-DOCUMENT navigation - `/apps/maptap-rivals/` to
`/apps/maptap-rivals/#history` - loads no document, so that event never fires.
Every such call therefore burned the full guard and then set
`s.lastNavTimedOut = true` on a navigation that had in fact succeeded
instantly. Nothing failed, so nothing said so.

Measured 2026-09-05 on the maptap-rivals app: **21,394 ms** for a fragment-only
`goto()` against **438 ms** for a real page load. `apps/maptap-rivals/e2e/
audit-2026-08.mjs` has around twenty of them, and spent **420 of its 518
seconds** inside `Page.navigate` because of it - 18% of the entire browser
estate's wall clock, and the reason that one suite was 41% of the slowest CI
shard. Two consecutive CI runs agreed to within 0.3 s, so it was never
variance.

The fix is in the harness, not the suites, because Chromium already tells us
which kind of navigation it was: **`Page.navigate` returns a `loaderId` for a
cross-document navigation and omits it for a same-document one.** `goto()` now
waits for the load event only when a `loaderId` came back. The caller's
`settle` still runs afterwards, which is what gives a `hashchange` handler its
chance to re-render, so the wait is the same one as before minus twenty dead
seconds: **21,394 ms -> 6 ms**.

Two things to keep:

- **A test that waits for an event that cannot arrive looks exactly like a slow
  test.** The only reason this was findable is that the runner now reports
  navigation time separately from fixed sleeps and condition polling. Counting
  `sleep()` literals in the source would never have found it - the source says
  `settle: 900`.
- **`--only=` hides it.** Run alone, the suite is "a bit slow"; it is only in
  the estate's own timing table, ranked against 27 others, that a suite at
  9.8 seconds per check next to a median of 1.0 stands out.

## axe: landmark-unique and heading-order are failures now, not info

`a11y.mjs` reports moderate violations as info, which is how two of them lived
site-wide: the header's two `nav` landmarks both said "Main navigation" (the
Menu toggle's is now labelled "Menu") and the moadon-alef footer used `h4`
under `h2`s (now `h2`, like the site footer). With the estate clean, both rule
ids are in `PROMOTED` in `a11y.mjs` and any recurrence fails.

## The apps hub search matches name, description and keywords only

`apps.html` used to search `section.textContent`, so "open" matched only Arena
(its button reads "Open Arena") and "premier" matched nothing although FPL is
Fantasy Premier League. Each card now carries `data-keywords` and the script
searches `data-keywords` + the `h3` + the paragraphs, which is what the
placeholder promises. Filter state is mirrored into the URL (`?q=`,
`?category=`) with `replaceState` and read back on load, so a filtered view is
shareable.

## privacy.html is binding, and its tests pin both directions

The document over-disclosed for months: it described sending Arena chat text to
PurgoMalum for profanity checking while `apps/arena/js/chat.js` was a local
word-boundary word list making zero external requests. Both the Arena bullet
and the PurgoMalum service entry are gone, and the FPL wording now says the
Delete/Disconnect actions also remove the cached copy of your team data while
the bulk public fixture and projection cache remains.

It under-disclosed too, and the old test could not see it. The section was
called a "two-way invariant test" while it only pinned NAMED -> CONTACTED
(every service named under "Other services that receive data" maps to a host
literal in first-party code, and every mapped service is still named). Nothing
checked CONTACTED -> NAMED, so the Trip Planner's bring-your-own-key assistant
posted trips to `api.openai.com` for months while the list never named OpenAI
(2026-09-12 audit T-5). `sync-system/tests/privacy-third-parties.test.mjs` now
checks that direction as well: every host the site actually contacts must be
covered by a named service, a related host of one (`RELATED_HOSTS`, with the
reason), or the analytics section. "Contacted" is derived, not a grep of every
https literal (that set is mostly plain links to IMDb, TVDB and Google Maps):
the connect/script/style/font/frame hosts of the Report-Only CSP (themselves
pinned to the fetch call sites by `tests/static/csp-connect-src.test.mjs`), the
Netlify functions' upstream literals outside comments minus the two that are
not requests, and the two image hosts `img-src https:` cannot name. When a
service is added or removed, update `SERVICE_HOSTS` or `RELATED_HOSTS` in the
same change.

The same round (2026-09-13) closed the other gaps the audit found in the page:
the MapTap rival network's three published documents and who can read each
(P-1), the traveller names, per-item cost sharing and visa-checker countries the
assistant receives, the stored passport expiry date, the CSP report function
(T-5), and an analytics list that said errors were sent "by their message",
that generated pages sent "nothing else" and promised a Football event that
does not exist (A-2). `tests/static/trip-planner-assistant-privacy.test.mjs`
now reads `slimTripForShare` and fails if the assistant receives the traveller
roster, per-item sharing or visa countries without the page naming them.

`tests/static/privacy-review-date.test.mjs` ties the prose to `Last reviewed:`
with a (date, digest) pair kept in the test file. The pair alone could be
defeated by overwriting `CURRENT.digest` in place and leaving the date (audit
C-1, reproduced 2026-09-13: all six original assertions passed). Nothing inside
a file the editor controls can be an anchor, so its last test compares the
prose and the date against git: the uncommitted tree against HEAD, a pull
request's merge commit against its first parent, a branch against its merge
base with master, a push to master against the previous commit. If the words
moved there, the date must be later. With no usable history (a depth-1
checkout, as in the Rising Shows refresh job) it records a diagnostic and the
digest pair is the only guard.

## tel: hrefs are E.164 and country-checked

`internal-links.test.mjs` skips `tel:` and `mailto:`, which is how the
moadon-alef footer shipped `tel:+1700701103` (a North American number for an
Israeli 1-700 line, while the page body dialled `+9721700701103`) and the site
footer shipped `tel:+1504-638-3370` (hyphens inside the URI, which some dialers
mis-parse) next to contact.html's clean `tel:+15046383370`. Both fixed;
`tests/static/tel-hrefs.test.mjs` requires every `tel:` href on a root page or
partial to be `tel:+<digits>` with `+972` on moadon-alef surfaces and `+1`
elsewhere.

## main.css has no @import chain

`assets/css/main.css` imports nothing. It used to `@import` the Raleway Google
Fonts stylesheet and `firebase-auth.css`, which put both a full round trip
behind the render-blocking chain, and this section used to record a
`<link rel="preload">` workaround for them. The 2026-08-22 site audit
(91503c5) removed the `@import`s instead and gave every page that links
`main.css` its own `<link>` tags for both, placed before it; no page carries
the preloads any more. `tests/static/stylesheet-chain.test.mjs` fails on a
page missing either link and on any `@import` in `main.css`.

## Site chrome facts worth keeping

- The apps hub OG/Twitter descriptions are pinned to the manifest by
  `sync-system/tests/app-naming-consistency.test.mjs` ("apps.html
  og:description and twitter:description name every manifest app"); they had
  drifted to naming fewer apps than the page listed.
- `assets/js/pagination.js` `getPaginatedItems` now clamps `currentPage` to
  the total page count (pagination.js:63-64), which is what produced empty
  pages and "Showing 201-6 of 6" in football-h2h and mario-kart.
- The shared header does NOT overhang a 390 px viewport. A 2026-08-22 report
  of a 391 px header (and therefore 1 px of document overflow everywhere) did
  not reproduce: every root page and every app root measures
  `documentElement.scrollWidth == clientWidth == innerWidth == 390` and
  `#header` exactly 390 px, with and without `--hide-scrollbars` and in both
  mobile and desktop emulation. `visual.mjs` now pins it per chrome-bearing
  page ("shared header does not overhang the viewport"). Note the shape of
  the false positive: `#header` is `position:fixed; width:100%`, so on a
  browser with CLASSIC (non-overlay) scrollbars it is as wide as the initial
  containing block while `documentElement.clientWidth` is ~15 px narrower;
  comparing the two there reports an overhang that no user ever sees.
- The gym-tracker banner is NOT the shared one: it has its own `.sync-banner`
  rules in `apps/gym-tracker/css/gym-tracker.css` (z-index 1100, `top: 0`,
  hidden at >= 768 px) and its own ES-module `sync-status.js`. It does not
  load `assets/css/sync-status.css`, so the shared banner's move below the
  header did not follow it; at `top: 0` under the site header (z-index 10001)
  it is partly covered on phones. That file belongs to the gym-tracker app.

## The sync-modal integration fires on anonymous sign-in

`sync-system/sync-modal-integration.js` treats ANY uid change after initial
load as a sign-in worth a full-screen "Sync Complete! Refreshing page..."
modal followed by `location.reload()`. Arena's guest bootstrap on Create room
hits it (see `apps/arena/FINDINGS.md`). The 30 s dedupe key
`sessionStorage['lastSyncModalTime']` suppresses it, which is how the arena
e2e masks it. That file is the arena fixer's; this entry stays until they
retire it.

## firestore.rules facts

Fixed 2026-08-23 in the audit remediation round. The detail, including the
teardown ORDER the rules depend on, lives in `apps/arena/FINDINGS.md`; this is
the site-level summary because the file is shared.

- **The arena password gate was deletable by any signed-in user (P0, fixed).**
  `/triviaRooms/{code}/private/{gateDoc}` allowed delete on `request.auth !=
  null` alone, and the member-create rule admits a joiner when
  `!exists(gate)`. A stranger with the room code deleted the gate and joined
  with no `gateHash`; every later joiner was then admitted with any password.
  Delete is now `roomGone(roomCode) || isRoomHost(roomCode)`, room delete is
  host-only, and the client tears a room down room-doc-first so "the last
  leaver" becomes a state the rules can actually verify. The old rules test
  pinned the vulnerability as intended behaviour; it now replays the exploit
  and expects a denial.
- Arena chat is append-only while a room is live, and is swept with the room
  when it is torn down; a room that is never closed cleanly keeps its chat.
  privacy.html says exactly this now.
- Room-doc writes are no longer "client of truth" for the fields that matter:
  `hostUid`, `status` and the question pointers are host-only, with an
  enumerated allow-list (`affectedKeys().hasOnly`) for the touches non-host
  members legitimately make.

## Cross-tab writes: what `sync-system/tab-sync.js` does and does not cover

Four apps lost user data to two open tabs (football-h2h, mario-kart,
trip-planner, gym-tracker): each holds state in memory and writes whole
arrays back, so the later writer dropped the other tab's work. They now share
`sync-system/tab-sync.js`. Read its header for the contract; the boundary
worth knowing here is what the write guard actually protects.

- The guard blocks `localStorage` writes made **synchronously inside** a
  foreign-change handler, and it survives `storage-sync-robust.js` installing
  its own `localStorage.setItem` override in either order (own properties
  shadow the prototype, so the helper wraps both layers and re-checks on every
  dispatch). Pinned by `sync-system/tests/tab-sync.test.mjs`.
- It does NOT extend to work a handler defers. mario-kart and gym-tracker
  debounce their refresh through `setTimeout`, which runs outside the guard by
  design (it avoids a re-render storm). That is safe because those deferred
  paths only re-read storage and re-render; what they write, if anything, is
  derived from the value they just read, never a default. A deferred handler
  that writes a FLOOR or DEFAULT would reintroduce the trip-planner bug, and
  nothing would stop it, so keep that work synchronous or keep it read-only.
- trip-planner and football-h2h handle synchronously, which is why the
  trip-planner P1 fix (an observing tab must not persist its floor trip) holds
  on the guard as well as on `ensureTrip(persist)`.

## `npm run` exiting 216 with no output means a bad root `node_modules`

Commit 0ce12b9 (2026-08-23) tracked a SYMLINK named `node_modules` at the repo
root whose target was its own absolute path. Two things conspired.

`.gitignore` said `/node_modules/`, and **a trailing slash matches a directory
only**, so a symlink of that name is not ignored and `git add -A` stages it.
The rule is now `/node_modules`, slashless, and so are the two
`netlify/*/node_modules` rules. Removing a trailing slash never loses
coverage: the slashless form matches the directory too.

The failure then looked completely different depending on where the checkout
lived, which is why it survived a full day of green CI:

- **Fresh checkout** (CI runners, Netlify deploys): the absolute target does
  not exist there, so the link is merely DANGLING. npm ignores it and every
  script runs. `npm ci` unlinks it and installs normally. Nothing to see.
- **The machine the path names**: the target IS the repo, so the link is a
  LOOP. npm prepends `<cwd>/node_modules/.bin` to `PATH` before spawning a
  script, resolving that raises `ELOOP`, and npm exits `-40` (216 to the
  shell) after printing the script banner and **nothing else**. `npm test`,
  `npm run build:site`, every script: banner, silence, exit 216.

So the signature to recognise is an npm script that prints its two banner
lines and dies with 216 and no diagnostic. `ls -ld node_modules` tells you
immediately; `~/.npm/_logs/*-debug-0.log` carries the real `spawn ELOOP`
stack that the terminal never showed. The underlying command is fine: running
the script body directly (`node --test ...`) succeeds, which is the tell that
the fault is in npm's spawn, not in the code under test.

Pinned by `tests/static/tracked-symlinks.test.mjs`: nothing named
`node_modules` may be tracked, no tracked symlink may be absolute or escape
the repo, and the `.gitignore` rule is checked behaviourally against a real
symlink in a throwaway repo (in this working tree `node_modules` is a
directory, where the broken pattern and the fixed one are indistinguishable).


## Dead-code audits: the two traps that produce false positives here

Run on 2026-08-24 across the whole repo. Both traps cost real time, so start here.

**CSS.** A static "this class appears in no HTML and no JS" sweep flags ~460
first-party selectors, and almost all of them are alive. This codebase composes
class names at runtime constantly: `'drama-callout-' + drama.kind`,
`` `matrix-${vm.tone}` ``, `'tp-t-' + type`, `` `is-${r.move}` ``,
`` `vp-${info.cls}` ``, `'lb-form-' + r`. Leaflet also mints its own
`.leaflet-popup-*` nodes at runtime. **Do not delete a selector on static
evidence.** The one genuine finding was structural rather than per-selector:
`apps/mario-kart/css/utilities.css` declares 217 utility classes of which 187
are unreferenced, and three apps load it (mario-kart, football-h2h,
gym-tracker). That one needs runtime CSS coverage across every view and state
of all three apps before anything is cut, so it was deliberately left alone.

**Generated pages.** `apps/gym-tracker/exercises/` and
`apps/rising-shows/shows/` are gitignored build output, so the copy on your disk
can be older than the generator. A full sweep of all 35,359 pages found 155
leaf pages linking to `/exercises/muscle/{back,cardio,chest}/`, which do not
exist - except that was a stale local build. `collectMuscleTaxonomy()` in
`build-exercise-pages.cjs` already fixes exactly this (it unions category keys
into the muscle map; the 2026-08-22 audit, finding D6, is named in its comment),
and regenerating produced all 37 muscle directories and zero broken links.
**Regenerate before believing anything about generated output.**

Method that worked for both, and for the symbol-level sweep: count every
identifier across the whole corpus in one pass, subtract the declaration, and
treat anything left at zero as a candidate - then verify each by hand. Counting
must keep string literals (shape assertions like
`['startStorageSync', 'setCloudItem', ...]` are real usage) and must include the
declaring file (self-recursive and internally-used helpers otherwise look dead).

## Deletes must be tombstones, not `deleteField()`

`storage-sync-robust.js` shipped a removed key as Firestore's `deleteField()`
sentinel. The reader loop only walks keys that are PRESENT in the document, so
a removed field reached no peer at all: the key survived on the other device,
and that device's next initial merge saw a key it had and the cloud did not,
so `uploadLocalOnlyKeys` uploaded it straight back. Every "delete my data"
control in the estate was affected. FPL's "Disconnect your FPL team" and Gym's
"Delete cloud data" both promised the opposite, and so did privacy.html.

A delete now writes `{ deleted: true, value: null, rev, updatedAt, hash }`,
the shape `applyRemoteChange` already honoured (that branch was dead code
reachable only from a test). Because it is a real entry it carries a revision
and a timestamp, so the ordinary last-writer-wins comparison applies, and
`enqueueLocalOnlyKeys` (the initial merge's local-only step) skips the key
because it IS present remotely.

Three pieces of user-facing copy already DESCRIBED the tombstone behaviour and
were simply wrong until this change: `apps/fpl-planner/js/ui/store.js`,
`js/ui/settings.js` ("Other devices drop it on their next sync"), the FPL
README, and the Gym "Delete cloud data" dialog ("Other devices that sync will
also lose this data on their next sync"). They are accurate now; do not "fix"
them back.

The old test asserted the deleteField sentinel, so it pinned the bug as
intended behaviour. It now asserts the tombstone, and two round-trip tests
were added: the writer's own payload is fed to a second sync state and must
remove the key without writing anything back.

## `initAppSync()` must not stop every sync before restarting

It ran on every delivery of the auth state, and `firebase-config.js` re-fans
its listeners whenever ANY other shevato tab finishes loading a page, so a
user with two tabs open re-entered it constantly. Calling `stopAllSyncs()`
first cleared the debounced write timer and DELETED the pending queue, so an
edit made in the last 500 ms never reached Firestore and the older remote copy
overwrote it in localStorage and on screen. It also defeated the same-user
shortcut in `_startSyncForUser` (that shortcut can only skip a rebuild when
the sync is still there to be kept), so every re-entry re-attached the
listener and re-ran the initial merge, which is the read amplification the
shortcut was written to stop.

`initAppSync` now computes the namespaces the page wants, stops only the ones
it no longer wants, and starts the rest; restarting is idempotent. (Since
2026-09-13 a stop no longer loses a dirty write for good, because the next
start re-enqueues it, but it still waits for the next start, so restarting
must still not stop.)
`stopAppSync` (the sign-out path) still stops everything. Pinned by
`sync-system/tests/app-sync-restart.test.mjs` (call site) and "restarting a
live sync keeps the pending write" in `storage-sync-behavior.test.mjs`
(behaviour).

## The account boundary (2026-09-13, audit S-2, S-4, S-5, T-3)

The merge core (tombstones, Lamport revisions, versioned chunks, the three-way
merge, own-write recognition) was right in all four findings. The edges were
not: whose data a local copy is, what counts as a person's work, what may
happen while an account is being deleted, and when the first upload may go.
All four invariants live in one block of `storage-sync-robust.js` ("The
account boundary") and are pinned by
`sync-system/tests/sync-account-boundary.test.mjs`. That file loads the engine
once per page (a query string on the import), so two tabs, or a page and its
reload, are two engines on one localStorage and one fake Firestore. 20 of its
24 tests fail against the pre-fix engine; the other 4 pin behaviour that had
to survive (anonymous work uploads to an empty account, a moved cloud meets
signed-out edits through the normal conflict path, placeholders are replaced
silently, placeholders still upload where the account has nothing).

### Ownership: one account's local data never uploads into another's (S-2)

- **What was wrong.** Signing out deliberately leaves the synced keys in
  localStorage. `shevato:sync-owner` was written only after an upload and read
  only by the initial merge's local-only upload, so an account whose first
  session had nothing to upload never armed it, and any ordinary write of a
  leftover key went straight into the next account (audit repros R1, R2).
- **The owner is the namespace's revision record.** `shevato:sync-revs:<ns>`
  carries `uid`, stamped at every session start (`prepareNamespaceForUser`),
  before the listener attaches. Everything that writes it is compare-and-set
  on that uid: `persistRevisions` never stamps an old account back,
  `rememberSyncBase` keeps an `__owner` on the base record, and `runFlush` and
  the snapshot callback stop a session whose namespace another tab has handed
  to a different account. The old device-wide marker is only read, as evidence
  for data synced before 2026-09-13, and only together with an agreed base.
- **Another account's local copy is set aside, never adopted.** Its unsynced
  part (dirty, drifted, no revision, or owner unknown) is parked in
  `shevato:sync-parked:<ns>`: one slot per owning account with the raw value,
  revision, synced hash, base and provenance, so switching back and forth
  replaces rather than accumulates. Its clean part is provably in its own cloud
  and is simply removed. Parked work comes back when that account signs in here
  again (into an empty key; into an occupied one it becomes a recovery copy), at
  its old revision, and meets that account's cloud through the normal merge. If
  the parked copy cannot be written (storage full) nothing is removed and the
  namespace does not sync on this device (`appSyncFailed`).
- **A page that holds another account's data reloads before syncing.** Apps
  keep their data in memory and write it back, so parking the stored copy is
  not enough. The engine records, per namespace, which account's data the page
  may hold (`bootLineage`: what it read at load, replaced whenever a session
  runs there). A session for a different account on such a page parks,
  re-stamps, calls `location.reload()`, and starts nothing. Writes the page
  makes before the reload lands are recorded with the page's account and parked
  at the next start instead of being adopted. That covers another tab that was
  already open, too. A sessionStorage marker stops a reload loop if the stamp
  could not be written. App pages already reloaded after a sign-in
  (`sync-modal-integration.js`), except within 30 s of an earlier one and for a
  page loaded with a saved session, which is exactly where the leak lived.
- **A page whose sync modules register late still knows what its apps read.**
  Since #535 (2026-09-13) `firebase-config.js`, `storage-sync-robust.js` and
  `app-sync-init.js` load `async`, so a page's apps can read storage well
  before `registerLocalNamespaces` records `bootLineage`. Another tab moving
  the data for an account in that window left the page holding the old
  account's data under the new account's stamp, and it synced without a
  reload. Every park, restore and account-deletion clear now first changes a
  per-namespace token in `shevato:sync-ownership-epoch`. `sync-immediate.js`,
  the first script on every app page, records the tokens before any app runs
  (`window.__shevatoSyncBoot`), and a namespace whose token moved in between
  registers with an unknown owner, so the page reloads before syncing anyone.
  The token changes before the data moves (and if it cannot be written, the
  data stays put), so a late registration sees either the lineage its apps read
  or a moved token, never moved data under an unchanged one. The same script
  records the gesture state with each buffered boot-window write, and the
  replay hands it to the engine's provenance, so a click that lands before the
  sync modules do does not turn an app's placeholder into work.
- **Local-only keys go through the queue.** The old `uploadLocalOnlyKeys` wrote
  straight to Firestore, past every gate. `enqueueLocalOnlyKeys` queues them,
  so they pass the barrier, the latch, the owner check and the retry ladder.
- **Residual.** A device that synced before 2026-09-05 (no revision record, no
  agreed base) and has not synced since cannot be told apart from a device that
  never synced; its data is adopted by the next account. Every session since
  2026-09-05 wrote a base, and every session now stamps an owner.

### Signed-out work does not disappear on sign-in (S-4)

- **What was wrong.** A local value with no revision was replaced by the cloud
  with no copy and no notice (repro R4). After #533, a same-account value that
  drifted while signed out stayed dirty but was never uploaded, because nothing
  could tell a person's edit from an app saving its own default.
- **Provenance decides.** While no session owns a registered key (app-sync-init
  registers every namespace at load, signed in or not), the engine records in
  `shevato:sync-local-work` whether the page had seen a user gesture
  (`navigator.userActivation.hasBeenActive`) when the value was written. Sticky:
  an app write on top of a value a person shaped is still work. Unknown
  provenance (no API, data from before this existed) counts as work.
- **Recorded after the write, never inside it.** Only the gesture state and
  the page's owner are read at the write; the value is parsed, hashed and
  recorded in one batch on the next task, once per key whatever the number of
  writes. Hashing inline cost 5 ms per write at 365 KB and 87 ms at 3.7 MB,
  on every `setItem` of a signed-out page, which used to do no sync work at
  all. Everything that reads provenance (sign-in, registration, forgetting)
  records the batch first, and so does `pagehide`, so a sign-in in the same
  task or a page closing straight after a write still sees it. A `storage`
  event is another tab's write and is not recorded here: that tab recorded it
  with its own gesture state. The inline version also doubled the storage
  events every open tab had to handle, which widened a MapTap cross-tab race
  enough for the browser suite to catch (apps/maptap-rivals/FINDINGS.md,
  "Never on another tab's storage event").
- **Work** with no revision gets a synthesized dirty revision 0; drifted work is
  dirty at its restored revision. At the first snapshot it meets the cloud
  through the normal conflict path, and it is uploaded where the cloud has
  nothing.
- **Placeholders** (an app's own untouched write) get no revision, or a clean
  revision 0 with the base dropped when they replaced a synced value, so the
  cloud replaces them with no copy and no notice. Where the account has nothing,
  a placeholder is still uploaded, as before.
- **Measured before choosing this**, on a fresh signed-out boot of every app:
  FPL Planner, MapTap Rivals and Rising Shows write no synced key; Mario Kart and
  Football write only `theme: "true"`; Gym Tracker writes six defaults (22 KB of
  achievement definitions among them); Trip Planner writes its floor trip, and
  rewrites it on the second boot. Treating those as work would raise a conflict
  and keep a recovery copy on every first sign-in on a device.
- **No agreed base means the cloud is the established state.** In a conflict
  with no base (a first reconciliation), entries both sides hold differently
  take the cloud's side (`mergeValues(..., { preferRemote })`; an unmergeable
  value goes to the higher revision, a tie to the cloud) and the local value is
  kept as a recovery copy. Entries only one side holds are unaffected, so record
  collections still union. The content-hash tie-break used to hand an arbitrary
  half of the entries to a copy that had never seen the other. A merge that adds
  nothing to the cloud value applies the cloud value as it is instead of
  re-uploading it.

### Account deletion cannot be undone by a competing session (S-5)

- **What was wrong.** `deleteAccount` stopped this tab's sync, but
  `firebase-config.js` re-fans the auth listeners whenever any tab loads,
  `initAppSync` re-attached in this tab or another, and the first snapshot of
  the emptied document re-uploaded every local key into the account being
  deleted.
- **The latch** is `shevato:sync-deletion` in localStorage:
  `{ active: { uid, id, startedAt, heartbeatAt }, deleted: [uid] }`, set by
  `beginAccountDeletion` right after reauthentication, before anything is
  stopped or deleted. Every tab reads it synchronously before starting a
  session, merging a snapshot or flushing, and a `storage` event stops live
  sessions in other tabs at once. It survives a reload of any other tab.
- **Order in `deleteAccount`:** latch, `stopAppSync`,
  `settleBeforeAccountDeletion` (this tab's flushes and Firestore's pending
  writes land before the deletes, never after), the deletes,
  `confirmCloudDataErased` (a namespace document a late write re-created is
  deleted again), local keys plus this account's parked copies, stamps and
  provenance, then `deleteUser`.
- **Release.** Success keeps the uid latched (`deleted`, last 10), because a
  stale tab can hold a still-valid ID token for up to an hour. Any failure
  clears it, so an account that still exists is not left sync-disabled; the page
  that failed stays unsynced until reloaded, as its message says. An abandoned
  deletion (its tab closed part-way) is recognised by
  `clearAbandonedAccountDeletion`, which `initAppSync` runs before refusing to
  start: exactly through the Web Locks API where it exists (the deleting tab
  holds `shevato-account-deletion:<uid>`), otherwise when the 2 s heartbeat is
  30 s stale.

### A namespace uploads nothing before reading its first snapshot (T-3)

- **What was wrong.** On a slow network, an edit made after sync started but
  before the first server snapshot was flushed at 500 ms and overwrote the unread
  cloud value; on Trip Planner the floor trip replaced every real trip.
- **The barrier is per namespace:** `initialMergeStarted`, then
  `initialMergeDone`. `runFlush`, `flushPendingNow` and `flushAllNow` send
  nothing before `initialMergeDone`; writes stay queued and dirty (persisted).
  The first server-confirmed snapshot is applied in full, chunked values
  included (the release waits for their assembly), then `completeInitialMerge`
  requeues dirty keys, queues local-only keys, drops queued writes the merge
  superseded (their hash no longer matches the revision) and flushes at once.
  Other namespaces are never held.
- **No deadlocks.** An empty cloud releases on its first snapshot. A listener
  that gives up announces the queued keys (`syncWriteRejected`, retryable), and
  nothing ever awaits the barrier, so sign-out and pagehide return at once.
  Signing out while waiting sends nothing late; the next session sends the edit
  after its own snapshot. A deletion latch stops the session instead of
  releasing it.
- **An app's own write while the cloud is unread** (no user gesture yet) gives
  way to the cloud's value where the cloud has one, instead of conflicting.

## One malformed remote entry must not abort the whole snapshot

`applyRemoteChange` dereferences `remoteInfo.updatedAt`, so a `null` or
non-object entry threw INSIDE the `onSnapshot` callback: every key after it in
iteration order was skipped and the initial merge never ran for that session.
Only reachable from a hand-edited or older-format document, but the failure is
silent and permanent for the session. Malformed entries are now skipped with a
warning, and each key is applied in its own try/catch.

## Chunked sync was not a snapshot (2026-09-05 F04)

Part documents were keyed by `(key, sequence)` alone, so version N+1 wrote over
version N's parts. Parts land BEFORE the manifest (deliberately - a manifest
pointing at documents that are not there yet would assemble a truncated value),
so a reader holding version N's manifest read version N+1's parts under it and
assembled the head of one version with the tail of another. That parses. Valid
JSON was never proof that the parts belonged together, and nothing checked.

Three changes, all of them in `storage-sync-robust.js`:

- **the part id carries a version token** (`rev` + content hash), so a new
  version writes new documents and the previous snapshot stays readable;
- **the predecessor is collected only after the new manifest is durable**, so
  at no instant is there a published manifest whose parts are absent or belong
  to a different version;
- **the reader verifies before it applies**: part count, the version stamp on
  each part, the assembled LENGTH against `manifest.chars`, and the content
  digest against `manifest.hash`. A mismatch is not applied and not recorded,
  so the next snapshot retries.

Old manifests (no `chunkVersion`) still read, and the first write after the
upgrade collects the unversioned run the old engine left behind - otherwise a
device would carry two copies forever.

## The clock had a vote it should never have had (2026-09-05 F05)

`decideRemoteChange` compared `localRev.updatedAt` - this device's `Date.now()`
- against a Firestore SERVER timestamp. A device an hour fast answered
`skip-older` to an hour of legitimate updates. Revision is now the order, and
`applyRemoteChange` advances it to `max(local, remote)`, which makes it a
Lamport counter: strictly causal, agreed by every device, no clock involved.

## Two devices, one string (2026-09-05 F05)

Every app syncs whole localStorage VALUES, so `gymTrackerSessions` is one
string holding many independent workouts. Device A adding an evening and device
B adding an evening did not edit two records - they edited one string, and
last-writer-wins threw one away.

A key with unflushed local work is now a CONFLICT rather than a comparison, and
a conflict is resolved by a three-way merge against the state the two sides
last agreed on. The base is an id -> content-hash INDEX of the records, not a
copy of them: ~18 bytes a record rather than a second copy of an 800 KB game
log on a 5 MB budget, and it is exactly what the merge needs.

Per id: in both and identical, keep; in both with one side matching the base,
take the side that changed; in both and both changed, deterministic winner and
a recoverable copy of the loser; in one side only and NOT in the base, an
addition, keep; in one side only and IN the base, a deletion, honour it. That
last line is the whole reason the merge is three-way - a two-way union
resurrects every deletion.

Values that are not collections of identified records (settings objects,
preference strings) fall back to a deterministic winner with the loser
preserved under `shevato:sync-conflict:*`, capped at 20 copies. Either way the
page is told, via a `syncConflict` event the shared sync banner renders: a
conflict nobody knows about is the same as a conflict that lost data.

## The deploy served the repository (2026-09-05 F15)

Netlify published the tracked tree, so `/FINDINGS.md`, `/TESTING-AUDIT.md` and
`/netlify/functions/lib/tp-assist-quota.mjs` all returned 200. `robots.txt`
said so in its own comments and used `Disallow` to hide them - which is a
crawling hint, not an access control, and left every future internal file one
commit away from being a public artifact by default.

`scripts/build-publish-dir.mjs` now assembles `dist/` from an explicit allow
list (hard links, so 70k files cost directory entries), and `netlify.toml` sets
it as `publish`. Functions still bundle from the repo root, so they deploy and
stop being downloadable. `tests/static/publish-graph.test.mjs` asserts BOTH
directions - the dangerous one being a careless exclusion breaking generated
pages, a service worker asset or the Search Console verification file.

## Old deploys run old function code against the live blobs (2026-09-13, audit Q-2)

Netlify keeps every deploy reachable: production permalinks, and
`deploy-preview-<PR>--shevato.netlify.app` aliases, which are guessable. All
three blob-backed functions open SITE-scoped stores (`getStore` in
`netlify/functions/lib/tp-assist-store.mjs`, `tp-places-store.mjs` and
`fpl-cache.mjs`), so an old deploy reads the live config and writes the live
counters and cache. `csp-report` stores nothing. The Origin guard
(`lib/tp-http.mjs`) turns away a browser on a preview origin with 403, but not
a request with a forged `Origin` (the 2026-09-12 audit verified that on
preview 529); it is defence in depth, never the control.

What an old build can still do, per function (re-checked 2026-09-13):

- `tp-assist`: nothing. Every build before #530 (8ac5b99, 2026-09-12) reads
  `geminiKey`, and the live config carries only `geminiKeyV2` (verified by the
  audit), so those builds answer 503. Every build that can read the key has
  `MONTHLY_BUDGET` and the per-network bucket, and #533 changed no
  `tp-assist` code.
- `tp-places`: money is bounded, availability is not. Builds before
  2026-08-18 (7d47387) read `placesKey` and answer 503; every later build
  shares the `billedMonth` ledger (5940b91, 2026-08-17), and Google's 500/day
  `GetPlaceRequest` cap applies to every path. But builds before #533
  (274f307) refund the per-client and per-network counters when a free Text
  Search finds nothing (the named path until #530, the discovery path until
  #533), and builds before #506 (071c8da, 2026-09-07) have no per-network
  bucket at all, so one source rotating `clientId` can run searches the
  counters never see, or drain the shared public daily pool: a ratings outage
  for the day, not a bill.
- `fpl`: availability and blob growth are both open. Builds from b64e649
  (2026-08-12) to #530 have no quota at all: unlimited upstream fetches from
  our egress, and a permanent `v1:<path>` key in the shared `fpl-planner`
  store for every distinct allowlisted `entry/<id>/...` path. Nothing evicts
  cache keys, in current code either; current builds bound new keys per
  network per hour and day, not globally.

**Decision: no generic `minRelease` gate.** A gate binds only builds that
contain it, and every build with a concrete gap above predates any gate, so it
would close nothing that exists. The field-rename gate works for the `tp-*`
functions because their builds need a secret from the blob; `fpl` reads no
config and needs no secret, so no blob write can switch its old builds off. A
gate would help only a FUTURE fix, and would cost a per-request config read in
`fpl`, an orderable build stamp that the function bundles do not have
(`scripts/stamp-release.mjs` stamps a commit id into `assets/js/analytics.js`
only), and a new owner procedure. Revisit if a future quota fix has to retire
old builds of a function that has no secret to rename.

The existing exposure can be closed only on the platform, by the owner: delete
old deploys and previews, or put non-production deploys behind Netlify's access
protection if the plan offers it (neither is verifiable from the repo). For the
`tp-*` functions the rule stands: a fix that must retire old builds renames the
config field (`resolveGeminiKey` in `tp-assist.mjs`, `resolvePlacesKey` in
`tp-places.mjs`, "Credential isolation" in `apps/trip-planner/FINDINGS.md`).

## Node 22, and the two things that broke on it (2026-09-05 F19)

`.nvmrc` said 20, which was end-of-life. The move is not a version bump alone:

- Node 22's test runner treats a positional DIRECTORY as a file to EXECUTE
  (`Cannot find module .../apps/arena/tests`), so `npm test` and
  `tests/coverage/run.mjs` moved to glob patterns;
- Node 22's coverage report is an INDENTED TREE, not flat paths. Parsed as
  flat, it yields basenames, every area prefix matches nothing, and the report
  claims 0.00% across the board while listing every production file as
  unmeasured. The parser handles both shapes.

`scripts/require-node.mjs` runs as `pretest` so an old runtime says what to do
instead of reporting a missing file.
