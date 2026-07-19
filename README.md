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
│   │   ├── analytics.js              # Google Analytics bootstrap
│   │   ├── language-switcher.js      # Tri-lingual switcher for the separately-branded landing
│   │   ├── year-updater.js           # Footer copyright year
│   │   ├── passive-events-fix.js     # Passive listeners polyfill
│   │   ├── breakpoints.min.js, browser.min.js, util.js  # Responsive helpers
│   │   └── pagination.js, global-icons.js
│   ├── sass/                         # SASS sources for main.css
│   └── seo/                          # Reference JSON-LD fragments + metadata checklist
│
├── apps/                             # Browser apps (each is self-contained)
│   ├── mario-kart/                   # Mario Kart race tracker (8 Deluxe + World)
│   ├── gym-tracker/                  # Gym workout tracker (PWA, manifest + service worker)
│   ├── football-h2h/                 # Head-to-head football league manager
│   ├── rising-shows/                 # TV shows ranked by rating-trend shape + Plex/Kometa integration
│   ├── maptap-rivals/                # Daily MapTap.gg head-to-head tracker
│   ├── arena/                        # Real-time multiplayer hub (Firestore Realtime DB)
│   └── trip-planner/                 # Day-by-day trip itinerary builder with route map
│
├── partials/                         # Header/footer fragments loaded by main.js
│   ├── header.html
│   ├── footer.html
│   └── footer-moadon-alef.html       # Tri-lingual footer for the separately-branded landing
│
├── images/                           # Logos, backgrounds, OG cards, and app artwork
├── netlify/, .netlify/               # Netlify functions and build artifacts
├── sync-system/                      # localStorage ↔ Firestore sync used by the apps
│
├── index.html                        # Apex shell — redirects to /home.html (noindex)
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
└── package.json                      # Test runner only (no build step)
```

## Apps

| App | Path | Category | Notes |
|-----|------|----------|-------|
| Mario Kart Tracker | `apps/mario-kart/` | Game stats | Race log, charts, achievements. Supports MK8 Deluxe + Mario Kart World |
| Gym Tracker | `apps/gym-tracker/` | Health | Installable PWA, offline support, programs + measurements |
| Football H2H League | `apps/football-h2h/` | Sports stats | Match log, penalty shootouts, player comparison table |
| Rising Shows | `apps/rising-shows/` | TV / multimedia | Whole TV shows ranked by the shape of their rating trend across thousands of shows; Plex + Kometa integration under `apps/rising-shows/kometa/` |
| MapTap Rivals | `apps/maptap-rivals/` | Game tracker | Daily MapTap.gg H2H against named friends; rivalry seasons + calendar heatmap |
| Arena | `apps/arena/` | Real-time multiplayer | Private rooms for friends — Globe Drop, Trivia, more. Requires Firestore + Realtime Database |
| Trip Planner | `apps/trip-planner/` | Travel | Day-by-day itineraries: flights, stays, costs, night coverage, collision and gap warnings, route map, A-to-B travel options. Optional Firestore sync via site sign-in |

### Adding a new app (required surfaces checklist)

Every place an existing app is referenced must reference the new one in the
SAME round. Wire the app into ALL of these:

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
   `og:image:alt`, `twitter:image:alt`, and the "Seven free web apps" count
   wording. The two `image:alt` tags and the JSON-LD description are the
   classic misses.
3. `home.html` - side-projects prose list + count, "Free web apps"
   preview-card list, `og:description` count.
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
14. Local (gitignored) surfaces: `.claude/agents/<slug>-pm.md`, the app
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

For SASS edits:

```bash
npm install -g sass
sass --watch assets/sass/main.scss:assets/css/main.css
```

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
```

The repo has cross-cutting invariant tests under `sync-system/tests/`, so run `npm test` after any non-trivial change before committing.

## Deployment

The site is deployed to Netlify. `netlify.toml` defines security headers (HSTS, X-Frame-Options, Permissions-Policy, CSP-Report-Only) and long-cache directives for the gym-tracker assets. Any other static host works identically — just keep the directory layout intact.

## Browser Support

Latest two versions of Chrome, Edge, Firefox, and Safari (desktop and mobile).

## Technologies

- HTML5, CSS3 (with optional SASS preprocessing).
- Vanilla JavaScript with jQuery for the partials/auth UI.
- FontAwesome (4.x and 6.x).
- Chart.js (Mario Kart tracker, MapTap Rivals).
- Firebase Auth + Firestore + Realtime Database (optional sync; Arena requires Realtime DB).
- Netlify Functions (`firebase-config` endpoint).

## Contact

- Email: nikita@shevato.com
- Phone: +1 (504) 638-3370
- LinkedIn: [nikita-soifer](https://www.linkedin.com/in/nikita-soifer/)

## License

Proprietary. All rights reserved.
