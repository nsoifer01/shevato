# Shevato - Interactive Web Platform

## Overview

Shevato is a static, multi-page web platform built with vanilla HTML5, CSS3, and JavaScript. The marketing site (home, work, apps, about, contact) coexists with a small set of free browser apps. The repo has no asset build step (CSS is plain, JS is loaded with `<script defer>`, and partials are stitched together client-side via jQuery); `npm run build:site` generates the data-driven Rising Shows and Gym Tracker pages and stamps the sitemaps at deploy.

## Directory Structure

```
shevato/
├── assets/
│   ├── apps-manifest.json            # THE canonical app list (slug, name, blurb); every other surface is pinned to it
│   ├── css/                          # Stylesheets (main.css, brand-colors.css, firebase-auth.css, site.css, moadon-alef-theme.css, etc.)
│   ├── fonts/                        # FontAwesome web fonts
│   ├── js/                           # Site-wide JavaScript modules
│   │   ├── main.js                   # Auth UI + partials loader + mobile menu (jQuery)
│   │   ├── jquery.min.js             # jQuery (vendored)
│   │   ├── analytics.js              # GA4 config + the shared tracking API (window.shevatoAnalytics)
│   │   ├── analytics-404.js          # Reports the failed path on 404.html
│   │   ├── apex-redirect.js          # index.html apex shell -> /home
│   │   ├── back-to-top.js, sync-status.js  # Shared chrome widgets (back-to-top button, sync banner)
│   │   ├── escape-html.js            # Shared HTML escaper (football-h2h, mario-kart)
│   │   ├── language-switcher.js      # Tri-lingual switcher for the separately-branded landing
│   │   ├── passive-events-fix.js     # Passive listeners polyfill
│   │   ├── breakpoints.min.js, browser.min.js, util.js  # Responsive helpers
│   │   └── pagination.js, global-icons.js
│   ├── js/tests/                     # Unit tests for the analytics helper (npm run test:analytics)
│   ├── og/                           # Social-card template, manifest and builder (see assets/og/README.md)
│   └── seo/                          # Reference JSON-LD fragments + metadata checklist
│
├── apps/                             # Browser apps (each is self-contained)
│   ├── arena/                        # Real-time multiplayer hub (Firestore)
│   ├── football-h2h/                 # Head-to-head football league manager
│   ├── fpl-planner/                  # Fantasy Premier League transfer, captain and chip planner
│   ├── gym-tracker/                  # Gym workout tracker (PWA, manifest + service worker)
│   ├── maptap-rivals/                # Daily MapTap.gg head-to-head tracker
│   ├── mario-kart/                   # Mario Kart race tracker (8 Deluxe + World)
│   ├── rising-shows/                 # TV shows ranked by rating-trend shape + Plex/Kometa integration
│   └── trip-planner/                 # Day-by-day trip itinerary builder with route map
│
├── partials/                         # Header/footer fragments loaded by main.js
│   ├── header.html
│   ├── footer.html
│   └── footer-moadon-alef.html       # Tri-lingual footer for the separately-branded landing
│
├── images/                           # Logos, bg.webp background, OG cards (images/og/), and app artwork
├── netlify/functions/                # Netlify functions (*.mjs), their lib/ helpers, tests/ and own package.json
├── scripts/                          # Site-level build helpers (sitemap lastmod stamping from git)
├── sync-system/                      # localStorage <-> Firestore sync used by the apps (+ cross-cutting invariant tests)
├── tests/                            # Site-level test estate: static/, browser/, coverage/, cross-browser/
├── .github/workflows/                # CI: tests, browser tests, cross-browser smoke, arena rules, rising-shows refresh
│
├── index.html                        # Apex shell, redirects to /home (noindex)
├── home.html                         # Main landing page
├── work.html                         # Selected work + services overview
├── apps.html                         # Apps hub
├── about.html                        # About the firm
├── contact.html                      # Contact details
├── moadon-alef.html                  # Separately-branded multilingual landing (Hebrew/Russian/English)
├── 404.html                          # Friendly not-found page (noindex, follow)
├── privacy.html                      # Binding per-app privacy promises (check before adding storage/tracking)
├── sitemap.xml, sitemap-pages.xml    # Sitemap index + the hand-listed pages (lastmod stamped at deploy, never hand-edited)
├── robots.txt                        # Crawler policy
├── site.webmanifest                  # PWA manifest for the marketing site
├── netlify.toml                      # Netlify build, headers, and CSP-Report-Only config
├── firebase-config.js                # Firebase v10 modular SDK bootstrap
├── firestore.rules, database.rules.json
├── CLAUDE.md                         # Repo-wide rules for Claude Code sessions (read first)
├── TESTING-AUDIT.md                  # Testing-system audit: rationale, coverage matrices, counts as of its date
└── package.json                      # Test + build scripts (build:site runs on every deploy)
```

## Per-app documentation

This root README stays a general overview. Detailed knowledge lives WITH each
app: `apps/<app>/README.md` is that app's current description (architecture,
data flow, how to run and test it) and `apps/<app>/FINDINGS.md` is its
accumulated engineering knowledge (discoveries, root causes, regression risks,
open questions), maintained as a living document. `CLAUDE.md` requires every
session working on an app to read both first and keep both current as part of
finishing the work. All eight apps carry both today. Site-level knowledge
(marketing pages, partials, shared assets, `sync-system/`, Netlify config,
`firestore.rules`, `privacy.html` drift) lives in the root `FINDINGS.md`.
FPL modelling and planner experiments are recorded
in `apps/fpl-planner/experiments/registry.md` with explicit verdicts.

## Apps

| App | Path | Category | Notes |
|-----|------|----------|-------|
| Arena | `apps/arena/` | Real-time multiplayer | Private rooms for friends (Globe Drop, Trivia, more). Requires Firestore |
| Football H2H League | `apps/football-h2h/` | Sports stats | Match log, penalty shootouts, player comparison table |
| FPL Planner | `apps/fpl-planner/` | Sports stats | Fantasy Premier League planner: imports a squad by FPL Team ID, projects players, and recommends transfers, hits, XI, bench order, captain and chips across a rolling horizon. Reads the public FPL API through a Netlify function proxy. Not affiliated with the Premier League |
| Gym Tracker | `apps/gym-tracker/` | Health | Installable PWA, offline support, programs + measurements |
| MapTap Rivals | `apps/maptap-rivals/` | Game tracker | Daily MapTap.gg H2H against named friends; rivalry seasons + calendar heatmap |
| Mario Kart Tracker | `apps/mario-kart/` | Game stats | Race log, charts, achievements. Supports MK8 Deluxe + Mario Kart World |
| Rising Shows | `apps/rising-shows/` | TV / multimedia | Whole TV shows ranked by the shape of their rating trend across thousands of shows; Plex + Kometa integration under `apps/rising-shows/kometa/` |
| Trip Planner | `apps/trip-planner/` | Travel | Day-by-day itineraries: flights, stays, costs, night coverage, collision and gap warnings, route map, A-to-B travel options. Optional Firestore sync via site sign-in |

### Adding a new app (required surfaces checklist)

Every place an existing app is referenced must reference the new one in the
SAME round. Wire the app into ALL of these:

**Apps are always listed A-Z**, on every surface below, with no featured app
hoisted to the front. Insert alphabetically rather than appending. Five tests
in `sync-system/tests/app-naming-consistency.test.mjs` enforce this; if one
fails, fix the ordering rather than the test.

1. `apps/<slug>/` - index.html (shared header/footer includes, full SEO head:
   canonical, OG + Twitter cards, SoftwareApplication JSON-LD, emoji favicon),
   scoped `css/` (pin colors against main.css's `!important` button rules),
   `js/`, `tests/`, README.md. SCOPING RULE: the app's style scope class goes
   on a ROOT WRAPPER `<div>`, never on `<body>`; shared chrome (header,
   footer, the firebase-auth sign-out modal, #sync-banner) is appended to
   `<body>` and must never inherit app typography. Never restyle shared
   selectors from app CSS (layout-positioning of bare `#header`/`#footer` is
   the only exception). Enforced by
   `sync-system/tests/shared-ui-consistency.test.mjs`.
2. `assets/apps-manifest.json` FIRST - the canonical app list (slug, name,
   footer blurb). The generated Rising Shows / Gym Tracker page footers render
   from it and `app-naming-consistency.test.mjs` pins every other surface
   against it, so nothing else passes until this entry exists.
3. `apps.html` - visible card with `data-category` (add a filter-bar button if
   the category is new), CollectionPage JSON-LD `hasPart` entry AND its
   `description`, `<title>`, meta description, meta keywords,
   `og:image:alt`, `twitter:image:alt`, and a linked preview image
   (`a.app-preview-link`, enforced by tests). Intro copy is deliberately
   count-free ("Free web apps we have built...") so it never goes stale. The
   two `image:alt` tags and the JSON-LD description are the classic misses.
4. `home.html` - the side-projects prose list only. The per-app "Open an
   app" grid was removed 2026-08-12 (the hero's "Try the free apps" button
   is the one route to /apps), and all count wording is deliberately
   count-free so it never goes stale.
5. `work.html` - personal-projects work-item.
6. `partials/header.html` - desktop dropdown AND mobile nav list.
7. The generated Rising Shows / Gym Tracker page footers need NO edit: both
   render-footer scripts read `assets/apps-manifest.json` (step 2), and a test
   fails if they ever diverge from it.
8. `sitemap-pages.xml` `<url>` entry (plus `sitemap.xml` index only if the app
   ships its own sub-sitemap).
9. `netlify.toml` - redirects only if a path moved.
10. `assets/og/cards.json` entry + `node assets/og/build-og-cards.mjs <slug>`
   (commit the generated `images/og/<slug>.png`).
11. `images/app-previews/<slug>.webp` (720x450) - rendered from SAMPLE data
    only, never a real user's content.
12. Root `README.md` - repo tree line + Apps table row above.
13. `package.json` - aggregate `test` script list + `test:<slug>`.
14. `sync-system/app-sync-init.js` - namespace + URL routing (only if the app
    syncs).
15. `privacy.html` - it makes narrow, checkable per-app promises, so it needs an
    entry in the sync list, whatever the app keeps locally, any new third party
    it contacts, any new analytics event, and a bumped `Last reviewed:` date.
16. `tests/coverage/floors.json` + `tests/coverage/run.mjs` - a coverage area
    and a line floor for the app's unit estate.
17. Browser suites - per-app blocks in `tests/browser/suites/{apps,a11y,
    visual,perf}.mjs` (plus a perf budget), bumping `EXPECTED_CHECKS` in
    `tests/browser/run.mjs` for every harness-owned suite that gained checks.
18. `tests/cross-browser/smoke.test.mjs` - the page list the Firefox/WebKit
    smoke boots.
19. `firestore.rules` - only if the app stores per-user documents (mirror an
    existing app's rules block; run `npm run test:arena:rules` style checks
    where applicable).
20. `TESTING-AUDIT.md` - a row in the "Coverage by application" table.
21. Local (gitignored) surfaces: `.claude/agents/<slug>-pm.md`, the app
    enumerations inside the developer/PM agent briefs, and the app list at the
    top of `.features/PROMPTS.md`.

Enforcement: grep an established slug (e.g. `maptap-rivals`) across the repo;
every file it appears in must also mention the new app, or be a consciously
skipped context. Then run `/doc-coverage` from clean master after shipping.

## Key Features

- Responsive design with breakpoint-driven layout.
- Consistent themed background (`images/bg.webp`, 1024 px wide, about 54 KB, referenced only from `main.css`) across the marketing pages.
- Dynamic header/footer injection via the partials system. The mobile menu traps focus and locks body scroll while open; every page, app shells included, has a skip link to a `<main id="main-content">` landmark.
- Every page links `main.css`, the Raleway stylesheet and `assets/css/firebase-auth.css` directly (no `@import` chain; pinned by `tests/static/stylesheet-chain.test.mjs`).
- Optional Firebase email/password auth for cross-device sync (apps work fine signed-out via localStorage).
- Account deletion built into the shared auth UI: reauthenticate, then delete every synced app namespace (sourced from `APP_SYNC_CONFIG`, so new apps are covered automatically), the account profile document, the MapTap network identity, local data, and finally the credential. Partial failures are reported honestly; shared Arena rows the rules do not let an owner delete are named in `privacy.html`.
- Multi-language support (English, Russian, Hebrew) on the separately-branded landing via per-element `lang` attributes and a small switcher.
- Reference SEO assets under `assets/seo/` (canonical Organization/WebSite JSON-LD plus a per-page metadata checklist).
- Rising Shows integrations: Plex + Kometa YAML builder under `apps/rising-shows/kometa/`, plus a `watch-next` CLI for personalized recommendations. See `apps/rising-shows/INTEGRATIONS.md`.

## Local Development

This is a static site. Any local HTTP server works:

```bash
python3 -m http.server 8082
# or
npx http-server -p 8082 .
# or
npx serve -l 8082 .
```

Then open `http://127.0.0.1:8082/`. Ports 8080 and 8081 are reserved on the
maintainer's machine (see `CLAUDE.md`); serve on 8082 or higher.

For CSS edits, edit the stylesheets in `assets/css/` directly. There is no
asset build step: the files served to browsers are the files in the repo
(only the generated Rising Shows / Gym Tracker pages and the sitemap lastmod
values come from `npm run build:site` at deploy).

`assets/css/main.css` used to be compiled from a SASS source tree, which was
removed on 2026-08-08. It had stopped being the source of truth long before
that: main.css was hand-edited for months while the SASS lagged behind, so
recompiling would have deleted 342 selectors of live styling, including the
`#footer h2` accessibility rules and the `.content--two-col` footer layout.
Keeping a build input that silently destroys shipped CSS is worse than having
no build step at all, so the sources were deleted rather than reconciled.

## Testing

The full audit of this testing system (architecture rationale, coverage
matrices, known product defects, limitations) lives in `TESTING-AUDIT.md`.
This section is the working contract for anyone changing the repo.

### Philosophy

Tests protect BEHAVIOR, not implementation details. Every test should be able
to fail when the user-visible rule it guards breaks, and should not fail when
an internal detail is refactored without changing that rule. Keep each test at
the lowest layer that can catch its bug: never move a pure-logic assertion
into a browser test just because the browser harness exists, and never claim a
DOM behavior is covered because a copy of its logic passes in Node.

### Layers

| Layer | Runner | Where | What belongs here |
|---|---|---|---|
| Static checks | `node --test` | `tests/static/` | Internal-link integrity, duplicate ids, manifest + JSON-LD validity, first-party JS syntax, module-import resolution, CSP connect-src inventory, canonical URL forms, netlify redirect inventory, sitemap resolution, analytics presence, stylesheet chain, image dimensions |
| Unit / integration | `node --test` | `apps/<app>/tests/`, `sync-system/tests/`, `netlify/functions/tests/`, `assets/js/tests/` | Calculations, parsers, business rules, storage/persistence logic, DOM-free view logic, function handlers with injected seams |
| Browser E2E | custom CDP harness | `tests/browser/`, `apps/{trip-planner,fpl-planner,gym-tracker}/e2e/` | Real user workflows in headless Chromium, with console-error and first-party-network-failure gating |
| Accessibility | CDP + vendored axe-core | `tests/browser/suites/a11y.mjs` | axe WCAG 2.0/2.1 A+AA scans of every page/app plus keyboard/focus behavior checks (mobile-menu focus trap, skip link + main landmark on every shell) |
| Visual | CDP (deterministic geometry) | `tests/browser/suites/visual.mjs` | Overflow, layout relations, dark-theme integrity, `main.css` collision pins at 3 viewports. Pixel baselines were deliberately rejected: font rendering differs per machine and would flake |
| Performance | CDP (budgets) | `tests/browser/suites/perf.mjs` | First-party byte / request / DOM-size budgets per page, set from measured baselines with headroom |
| PWA / offline | CDP | `tests/browser/suites/pwa-gym.mjs`, `apps/trip-planner/e2e/pwa.mjs` | Service-worker registration, cache contents, offline reload |
| Cross-browser | Playwright (dev-dep) + `node --test` | `tests/cross-browser/` | Firefox + WebKit smoke of every page/app. Chromium depth stays in the CDP harness |
| Firebase rules + multiplayer | Firestore emulator (npx firebase-tools, Java 21) | `apps/arena/tests-rules/`, `apps/arena/e2e/` | Security-rules suite (deny-all negative control) and a two-client multiplayer e2e against local emulators; never production Firebase |
| Coverage | wrapper over `node --test` | `tests/coverage/` | Runs the unit estate under V8 coverage, reports per area, enforces line floors |

### Commands

```bash
npm test                   # fast gate: all unit/integration + static checks, no browser
                           #   (about three minutes; CI on every push to master and every PR)
npm run test:browser       # full browser estate: site, apps, a11y, visual, perf, PWA, app E2E (CI on PRs + master)
                           #   (about 45 minutes locally; CI splits it across a four-job matrix,
                           #   `-- --shard=<i>/<n>`, so the gate clears in about twelve)
npm run test:all           # "is this change safe to merge": npm test + test:browser
npm run test:coverage      # coverage report to .coverage/summary.md + per-area floors
npm run test:cross-browser # Firefox/WebKit smoke (needs: npm install && npx playwright install firefox webkit;
                           #   WebKit additionally needs system libs, so it runs fully only on CI)
npm run test:arena:rules   # Firestore security-rules suite vs the local emulator
npm run test:arena:emulator# two-client multiplayer e2e vs the local emulators
                           #   (both need Java 21 + a one-time firebase-tools download;
                           #   the rules suite runs weekly on CI via arena-rules.yml)
npm run test:<app>         # one app's unit suite (gym, football, fpl-planner, rising-shows, mario-kart,
                           #   arena, maptap, trip-planner); test:static, test:sync, test:analytics,
                           #   test:tp-assist-quota likewise
npm run test:trip-planner:e2e | test:fpl-planner:e2e   # one app's browser E2E subset
                           #   (append :headed to the trip-planner one to watch it)
```

For day-to-day development: `npm test` (about three minutes). Before merging:
`npm run test:all`. The cross-browser smoke runs weekly on CI and on demand.

### Known-defect quarantine

When a correct test exposes a real product bug, the test is NOT weakened,
skipped silently, or deleted. Two mechanisms exist, with different
guarantees; be precise about which you are relying on:

- **`node --test` suites**: the test asserts the CORRECT behavior and is
  marked `{ todo: 'KNOWN DEFECT: ...' }`. It executes on every `npm test`
  and is reported in the TODO count without blocking CI. Be aware of the
  limit: when the bug is fixed the test starts passing, which TAP shows as a
  passing TODO, but Node does not fail the run for it, so nothing FORCES the
  cleanup. The PR that fixes the product bug is responsible for removing the
  todo marker in the same change.
- **Browser harness suites**: quarantined checks are expected-failure
  checks, not skips in the ordinary sense. They EXECUTE the defective
  behavior on every run; while the defect reproduces they report as a skip
  whose detail starts with `KNOWN DEFECT:`, and if the defect stops
  reproducing they FAIL loudly with an "unexpectedly passes - remove the
  quarantine" message. So a product fix that forgets to retire its browser
  quarantine turns the suite red on purpose. The a11y suite additionally
  pins the quarantine baseline per page and per axe rule id (`QUARANTINED`
  in `a11y.mjs`): a new violation class on any page fails outright and can
  never slide silently into the quarantine.

As of 2026-08-16 every defect the audit catalogued is fixed and its
quarantine retired into a normal regression test; the mechanism below is
the standing convention for FUTURE finds.

Every quarantined defect is catalogued in `TESTING-AUDIT.md`, which also
distinguishes defects pinned by executable tests from findings that are
documented only (security/architecture items that need an emulator, and
product decisions where asserting one outcome would presume the answer).
Fixing the product bug is a separate change from the test that documents it.

### Expectations for future changes

- **New feature**: tests accompany it at the lowest sensible layer.
- **Bug fix**: add a regression test that reproduces the bug first.
- **Business-rule / calculation change**: update unit tests covering normal
  cases and boundaries in the same change.
- **UI interaction change**: update or extend the browser coverage.
- **Major layout/visual change**: re-derive the affected `visual.mjs`
  geometry assertions and `perf.mjs` budgets deliberately, never blindly.
- **New page or app**: wire it into the static checks, browser suites
  (site/apps/a11y/visual/perf as applicable), the cross-browser smoke lists,
  and `package.json`; give its critical workflows real tests. See "Adding a
  new app" above.
- **External API change**: update the deterministic fixtures AND the failure
  scenarios (timeouts, malformed bodies, empty responses).

### What you must NOT do

- Remove or skip a failing test to make CI green; use the known-defect
  quarantine and document it.
- Lower a coverage floor (`tests/coverage/floors.json`) without a written
  justification in `TESTING-AUDIT.md`.
- Add hard-coded sleeps to fix a race: use `waitForExpr` on a real condition
  (the two remaining sleep classes in the E2E suites are commented negative
  claims).
- Copy production logic into a test ("mirror" tests): extract the real source
  (see `apps/gym-tracker/tests/helpers/source-extract.mjs`) or test through
  the real module. A mirror in this repo was found already drifted from the
  code it claimed to protect.
- Depend on live third-party APIs in the deterministic suites; every external
  host is blocked or intercepted in the browser harness on purpose.
- Depend on test-execution order or leave state behind (pages are closed in
  `finally`, storage is reset per block, service workers are unregistered).
- Change an expected value just to accommodate a regression.
- Write to production Firebase from any test (the Arena browser checks
  intercept and fail all Firebase hosts; keep it that way).

### Artifacts

- Coverage: `.coverage/summary.md` (gitignored), written by `test:coverage`.
- Browser failure screenshots: `.screenshots/e2e-trip-planner/` (gitignored);
  green runs write nothing.
- The browser runner prints per-suite pass/skip counts and pins expected
  check counts for all six harness-owned suites (site, apps, a11y, visual,
  perf, pwa-gym; see EXPECTED_CHECKS in run.mjs), so a crashed block cannot
  silently shrink the denominator.
- CI (`.github/workflows/`): `tests` (unit + static + syntax, every push to
  master and every PR), `browser tests` (PRs + master pushes + manual
  dispatch), `cross-browser smoke` (weekly + manual dispatch), `arena
  firestore rules` (weekly, against the emulator), and `Refresh Rising Shows
  data` (daily; publishes the dataset release and merges the derived files).

## Analytics

Every page loads GA4 through one file, `assets/js/analytics.js`, which configures
the property and installs `window.shevatoAnalytics`. **Call that API, never
`gtag()` directly.** It centralises the privacy rules, the dedupe, and the
guarantee that a tracking failure cannot throw into app code.

Apps reach it through a small local `track(method, ...args)` shim that resolves
`window.shevatoAnalytics` at call time (the helper is deferred, so app code can
run first) and swallows everything. Gym Tracker, being ES modules, imports the
same shim from `apps/gym-tracker/js/utils/analytics.js`.

Events, all carrying `app_name` and `app_section` automatically:

| Event | Fired when | Key parameters |
|---|---|---|
| `page_view` | once per document load | `page_path` (no query, no hash, no `.html`) |
| `app_open` | an app's own entry page loads | (none) |
| `app_view` | in-app section/tab change | `view_name` |
| `search` | a search runs | `search_scope`, `query_length`, `results_count`, `has_results` |
| `search_result_select` | a result is picked | `content_type`, `content_id`, `result_position` |
| `filter_change` | a filter/sort control changes | `filter_name`, `filter_value` |
| `content_view` | a detail record opens | `content_type`, `content_id` |
| `load_more` | pagination advances | `page_number`, `items_shown` |
| `app_action` | a meaningful action completes | `action_name` + per-action counts |
| `outbound_click` | a link to another origin | `link_domain` |
| `site_nav_click` | an internal link or mailto/tel | `nav_location`, `link_destination`, `link_kind` (`internal`/`mailto`/`tel`) |
| `app_error` | uncaught error or rejection | `error_scope`, `error_message` (capped at 5/page) |
| `page_not_found` | 404.html renders | `not_found_path`, `referrer_domain` |

Two rules when adding tracking:

1. **Never send anything the user typed.** Report a query's length and result
   count, not its text; report a catalogue id (a show slug), not a title someone
   entered. `scrub()` drops parameters whose names look like free text or
   identity and values that look like emails or generated ids, but it is a
   backstop, do not rely on it.
2. **One event per gesture.** `trackView`/`trackFilter` drop repeats; call
   `primeFilter` at boot to register default filter state so the first control a
   user touches reports once instead of the whole panel reporting its defaults.

In-app navigation deliberately reports `app_view`, never a synthetic
`page_view`, so client routing can never invent URLs in Pages and Screens.

## Deployment

The site is deployed to Netlify. `netlify.toml` defines security headers (HSTS, X-Frame-Options, Permissions-Policy, CSP-Report-Only), short revalidating cache headers for the gym-tracker assets (300 s for js/css, 3600 s for data, all `must-revalidate`), a `Content-Type` rule for `*.webmanifest`, and the redirect inventory (canonical extensionless URLs, renamed apps, directory-index duplicates including the generated `shows/` and `exercises/` hub indexes). Any other static host works identically, just keep the directory layout intact.

Sitemaps: `sitemap.xml` is an index of three sub-sitemaps; hand-listed pages live in `sitemap-pages.xml`, whose `lastmod` values `scripts/stamp-sitemap-index.mjs` refreshes from git history at deploy (skipped in shallow clones). The generated show and exercise sitemaps carry no `lastmod` (the only date available is the build time, which is not a content date), so their index entries carry none either. Never hand-edit a `lastmod`.

Firebase: the Auth "authorized domains" list in the Firebase console must keep the canonical apex `shevato.com` alongside the Netlify and `www` hosts (added 2026-08-22); a missing entry fails OAuth and email-link flows silently on the canonical URL.

`netlify.toml` is the ONLY place the site's CSP is defined (no `_headers` file, no `<meta http-equiv>`, no per-app copy). Because it ships as Report-Only, an origin missing from `connect-src` does not break anything, it just logs a console violation, so `tests/static/csp-connect-src.test.mjs` parses that header and fails when first-party client JS fetches an origin the policy does not allow (and when the policy lists one nothing uses). Adding a `fetch()` to a new origin means adding it to `connect-src` and to that test's inventory in the same change.

## Browser Support

Latest two versions of Chrome, Edge, Firefox, and Safari (desktop and mobile).

## Technologies

- HTML5 and CSS3, hand-written with no asset build step.
- Vanilla JavaScript with jQuery for the partials/auth UI.
- FontAwesome (4.x and 6.x).
- Chart.js (Mario Kart tracker, MapTap Rivals).
- Firebase Auth + Firestore (optional sync; Arena requires Firestore for room state). Realtime Database is only a sync-engine option in `sync-system/storage-sync-robust.js`; no app depends on it.
- Netlify Functions: `tp-assist` and `tp-places` (Trip Planner AI assistant and venue ratings) and `fpl` (the cached, allowlisted read proxy in front of the public Fantasy Premier League API, which sends no CORS headers and is otherwise unreachable from a browser).

## Contact

- Email: nikita@shevato.com
- Phone: +1 (504) 638-3370
- LinkedIn: [nikita-soifer](https://www.linkedin.com/in/nikita-soifer/)

## License

Proprietary. All rights reserved.
