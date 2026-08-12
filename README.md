# Shevato - Interactive Web Platform

## Overview

Shevato is a static, multi-page web platform built with vanilla HTML5, CSS3, and JavaScript. The marketing site (home, work, apps, about, contact) coexists with a small set of free browser apps. The repo has no build step at the root; CSS is plain, JS is loaded with `<script defer>`, and partials are stitched together client-side via jQuery.

## Directory Structure

```
shevato/
├── assets/
│   ├── css/                          # Stylesheets (main.css, brand-colors.css, theming, etc.)
│   ├── fonts/                        # FontAwesome web fonts
│   ├── js/                           # Site-wide JavaScript modules
│   │   ├── main.js                   # Auth UI + partials loader (jQuery)
│   │   ├── jquery.min.js             # jQuery (vendored)
│   │   ├── analytics.js              # GA4 config + the shared tracking API (window.shevatoAnalytics)
│   │   ├── analytics-404.js          # Reports the failed path on 404.html
│   │   ├── language-switcher.js      # Tri-lingual switcher for the separately-branded landing
│   │   ├── passive-events-fix.js     # Passive listeners polyfill
│   │   ├── breakpoints.min.js, browser.min.js, util.js  # Responsive helpers
│   │   └── pagination.js, global-icons.js
│   ├── js/tests/                     # Unit tests for the analytics helper (npm run test:analytics)
│   └── seo/                          # Reference JSON-LD fragments + metadata checklist
│
├── apps/                             # Browser apps (each is self-contained)
│   ├── arena/                        # Real-time multiplayer hub (Firestore Realtime DB)
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
├── images/                           # Logos, backgrounds, OG cards, and app artwork
├── netlify/, .netlify/               # Netlify functions and build artifacts
├── scripts/                          # Site-level build helpers (sitemap index lastmod stamping)
├── sync-system/                      # localStorage ↔ Firestore sync used by the apps
│
├── index.html                        # Apex shell — redirects to /home (noindex)
├── home.html                         # Main landing page
├── work.html                         # Selected work + services overview
├── apps.html                         # Apps hub
├── about.html                        # About the firm
├── contact.html                      # Contact details
├── moadon-alef.html                  # Separately-branded multilingual landing (Hebrew/Russian/English)
├── 404.html                          # Friendly not-found page (noindex, follow)
├── sitemap.xml, sitemap-pages.xml    # Indexable URL lists
├── robots.txt                        # Crawler policy
├── site.webmanifest                  # PWA manifest for the marketing site
├── netlify.toml                      # Netlify build, headers, and CSP-Report-Only config
├── firebase-config.js                # Firebase v10 modular SDK bootstrap
├── firestore.rules, database.rules.json
├── CLAUDE.md                         # Repo-wide rules for Claude Code sessions (read first)
└── package.json                      # Test + build scripts (build:site runs on every deploy)
```

## Per-app documentation

This root README stays a general overview. Detailed knowledge lives WITH each
app: `apps/<app>/README.md` is that app's current description (architecture,
data flow, how to run and test it) and `apps/<app>/FINDINGS.md` is its
accumulated engineering knowledge (discoveries, root causes, regression risks,
open questions), maintained as a living document. `CLAUDE.md` requires every
session working on an app to read both first and keep both current as part of
finishing the work. The FPL Planner carries both today; other apps gain them
as meaningful work happens. FPL modelling and planner experiments are recorded
in `apps/fpl-planner/experiments/registry.md` with explicit verdicts.

## Apps

| App | Path | Category | Notes |
|-----|------|----------|-------|
| Arena | `apps/arena/` | Real-time multiplayer | Private rooms for friends — Globe Drop, Trivia, more. Requires Firestore + Realtime Database |
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
2. `apps.html` - visible card with `data-category` (add a filter-bar button if
   the category is new), CollectionPage JSON-LD `hasPart` entry AND its
   `description`, `<title>`, meta description, meta keywords,
   `og:image:alt`, `twitter:image:alt`, and the "Eight free web apps" count
   wording. The two `image:alt` tags and the JSON-LD description are the
   classic misses.
3. `home.html` - side-projects prose list + count, "Free web apps"
   preview-card list, `og:description` count, AND the `.home-app-links`
   "Open an app" grid, which sits directly under the hero (one `<li>` per
   app, with its one-line description). That grid is the only place the
   homepage links directly to an individual app, so an app missing from it
   gets no direct internal link from the site's highest-authority page.
   Keep each one-liner consistent with that app's description in
   `apps.html`; the names must match the apps hub exactly.
4. `work.html` - personal-projects work-item.
5. `partials/header.html` - desktop dropdown AND mobile nav list.
6. `apps/rising-shows/scripts/render-footer.js` AND
   `apps/gym-tracker/scripts/render-footer.cjs` (kept in sync by convention).
7. `sitemap-pages.xml` `<url>` entry (plus `sitemap.xml` index only if the app
   ships its own sub-sitemap).
8. `netlify.toml` - redirects only if a path moved.
9. `assets/og/cards.json` entry + `node assets/og/build-og-cards.mjs <slug>`
   (commit the generated `images/og/<slug>.png`).
10. `images/app-previews/<slug>.webp` (720x450) - rendered from SAMPLE data
    only, never a real user's content.
11. Root `README.md` - repo tree line + Apps table row above.
12. `package.json` - aggregate `test` script list + `test:<slug>`.
13. `sync-system/app-sync-init.js` - namespace + URL routing (only if the app
    syncs).
14. `privacy.html` - it makes narrow, checkable per-app promises, so it needs an
    entry in the sync list, whatever the app keeps locally, any new third party
    it contacts, any new analytics event, and a bumped `Last reviewed:` date.
15. Local (gitignored) surfaces: `.claude/agents/<slug>-pm.md`, the app
    enumerations inside the developer/PM agent briefs, and the app list at the
    top of `.features/PROMPTS.md`.

Enforcement: grep an established slug (e.g. `maptap-rivals`) across the repo;
every file it appears in must also mention the new app, or be a consciously
skipped context. Then run `/doc-coverage` from clean master after shipping.

## Key Features

- Responsive design with breakpoint-driven layout.
- Consistent themed background (`bg.jpg`) across the marketing pages.
- Dynamic header/footer injection via the partials system.
- Optional Firebase email/password auth for cross-device sync (apps work fine signed-out via localStorage).
- Account deletion built into the shared auth UI: reauthenticate, then delete every synced app namespace (sourced from `APP_SYNC_CONFIG`, so new apps are covered automatically), the account profile document, the MapTap network identity, local data, and finally the credential. Partial failures are reported honestly; shared Arena rows the rules do not let an owner delete are named in `privacy.html`.
- Multi-language support (English, Russian, Hebrew) on the separately-branded landing via per-element `lang` attributes and a small switcher.
- Reference SEO assets under `assets/seo/` (canonical Organization/WebSite JSON-LD plus a per-page metadata checklist).
- Rising Shows integrations: Plex + Kometa YAML builder under `apps/rising-shows/kometa/`, plus a `watch-next` CLI for personalized recommendations. See `apps/rising-shows/INTEGRATIONS.md`.

## Local Development

This is a static site. Any local HTTP server works:

```bash
python3 -m http.server 8080
# or
npx http-server -p 8080 .
# or
npx serve -l 8080 .
```

Then open `http://127.0.0.1:8080/`.

For CSS edits, edit the stylesheets in `assets/css/` directly. There is no
build step: the files served to browsers are the files in the repo.

`assets/css/main.css` used to be compiled from a SASS source tree, which was
removed on 2026-08-08. It had stopped being the source of truth long before
that: main.css was hand-edited for months while the SASS lagged behind, so
recompiling would have deleted 342 selectors of live styling, including the
`#footer h2` accessibility rules and the `.content--two-col` footer layout.
Keeping a build input that silently destroys shipped CSS is worse than having
no build step at all, so the sources were deleted rather than reconciled.

## Tests

Node's built-in test runner is used for the apps and the shared sync system:

```bash
npm test                            # runs every suite below
npm run test:gym
npm run test:football
npm run test:rising-shows           # render + integrations-lib
npm run test:mario-kart
npm run test:arena
npm run test:sync                   # cross-cutting sync-system invariants
npm run test:analytics              # shared GA4 helper (privacy + dedupe rules)
```

The repo has cross-cutting invariant tests under `sync-system/tests/`, so run `npm test` after any non-trivial change before committing.

## Analytics

Every page loads GA4 through one file, `assets/js/analytics.js`, which configures
the property and installs `window.shevatoAnalytics`. **Call that API — never
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
| `app_open` | an app's own entry page loads | — |
| `app_view` | in-app section/tab change | `view_name` |
| `search` | a search runs | `search_scope`, `query_length`, `results_count`, `has_results` |
| `search_result_select` | a result is picked | `content_type`, `content_id`, `result_position` |
| `filter_change` | a filter/sort control changes | `filter_name`, `filter_value` |
| `content_view` | a detail record opens | `content_type`, `content_id` |
| `load_more` | pagination advances | `page_number`, `items_shown` |
| `app_action` | a meaningful action completes | `action_name` + per-action counts |
| `outbound_click` | a link to another origin | `link_domain` |
| `site_nav_click` | an internal link or mailto/tel | `nav_location`, `link_destination` |
| `app_error` | uncaught error or rejection | `error_scope`, `error_message` (capped at 5/page) |
| `page_not_found` | 404.html renders | `not_found_path`, `referrer_domain` |

Two rules when adding tracking:

1. **Never send anything the user typed.** Report a query's length and result
   count, not its text; report a catalogue id (a show slug), not a title someone
   entered. `scrub()` drops parameters whose names look like free text or
   identity and values that look like emails or generated ids, but it is a
   backstop — do not rely on it.
2. **One event per gesture.** `trackView`/`trackFilter` drop repeats; call
   `primeFilter` at boot to register default filter state so the first control a
   user touches reports once instead of the whole panel reporting its defaults.

In-app navigation deliberately reports `app_view`, never a synthetic
`page_view`, so client routing can never invent URLs in Pages and Screens.

## Deployment

The site is deployed to Netlify. `netlify.toml` defines security headers (HSTS, X-Frame-Options, Permissions-Policy, CSP-Report-Only) and long-cache directives for the gym-tracker assets. Any other static host works identically — just keep the directory layout intact.

## Browser Support

Latest two versions of Chrome, Edge, Firefox, and Safari (desktop and mobile).

## Technologies

- HTML5 and CSS3, hand-written with no build step.
- Vanilla JavaScript with jQuery for the partials/auth UI.
- FontAwesome (4.x and 6.x).
- Chart.js (Mario Kart tracker, MapTap Rivals).
- Firebase Auth + Firestore + Realtime Database (optional sync; Arena requires Realtime DB).
- Netlify Functions: `tp-assist` and `tp-places` (Trip Planner AI assistant and venue ratings) and `fpl` (the cached, allowlisted read proxy in front of the public Fantasy Premier League API, which sends no CORS headers and is otherwise unreachable from a browser).

## Contact

- Email: nikita@shevato.com
- Phone: +1 (504) 638-3370
- LinkedIn: [nikita-soifer](https://www.linkedin.com/in/nikita-soifer/)

## License

Proprietary. All rights reserved.
