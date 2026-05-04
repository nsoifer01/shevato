# Shevato - Interactive Web Platform

## Overview

Shevato is a static, multi-page web platform built with vanilla HTML5, CSS3, and JavaScript. The marketing site (home, product, apps) coexists with a small set of free browser apps and a separately-branded medical services page (Moadon Alef). The repo has no build step at the root; CSS is plain, JS is loaded with `<script defer>`, and partials are stitched together client-side via jQuery.

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
│   │   ├── language-switcher.js      # Moadon Alef tri-lingual switcher
│   │   ├── year-updater.js           # Footer copyright year
│   │   ├── passive-events-fix.js     # Passive listeners polyfill
│   │   ├── breakpoints.min.js, browser.min.js, util.js  # Responsive helpers
│   │   └── pagination.js, global-icons.js
│   ├── sass/                         # SASS sources for main.css
│   └── seo/                          # Reference JSON-LD fragments + metadata checklist
│
├── apps/                             # Browser apps (each is self-contained)
│   ├── mario-kart/                   # Mario Kart 8 Deluxe race tracker
│   ├── gym-tracker/                  # Gym workout tracker (PWA, manifest + service worker)
│   └── football-h2h/                 # Head-to-head football league manager
│
├── partials/                         # Header/footer fragments loaded by main.js
│   ├── header.html
│   ├── footer.html
│   ├── footer-moadon-alef.html       # Tri-lingual footer for Moadon Alef
│   └── firebase-auth-scripts.html
│
├── images/                           # Logos, backgrounds, and app artwork
├── netlify/, .netlify/               # Netlify functions and build artifacts
├── sync-system/                      # localStorage ↔ Firestore sync used by the apps
│
├── index.html                        # Apex shell — redirects to /home.html (noindex)
├── home.html                         # Main landing page
├── product.html                      # Services / product overview
├── apps.html                         # Apps hub
├── moadon-alef.html                  # Medical services landing (Hebrew/Russian/English)
├── 404.html                          # Friendly not-found page (noindex, follow)
├── sitemap.xml                       # Indexable URL list
├── robots.txt                        # Crawler policy
├── netlify.toml                      # Netlify build, headers, and CSP-Report-Only config
├── firebase-config.js                # Firebase v10 modular SDK bootstrap
├── firestore.rules, database.rules.json
└── package.json                      # Test runner only (no build step)
```

## Apps

| App | Path | Category | Notes |
|-----|------|----------|-------|
| Mario Kart Tracker | `apps/mario-kart/tracker.html` | Game stats | Race log, charts, achievements |
| Gym Tracker | `apps/gym-tracker/index.html` | Health | Installable PWA, offline support |
| Football H2H League | `apps/football-h2h/index.html` | Sports stats | Match log, penalties, player stats |

## Key Features

- Responsive design with breakpoint-driven layout.
- Consistent themed background (`bg.jpg`) across the marketing pages.
- Dynamic header/footer injection via the partials system.
- Optional Firebase email/password auth for cross-device sync (apps work fine signed-out via localStorage).
- Multi-language support on Moadon Alef (English, Russian, Hebrew) via per-element `lang` attributes and a small switcher.
- Reference SEO assets under `assets/seo/` (canonical Organization/WebSite JSON-LD plus a per-page metadata checklist).

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

Node's built-in test runner is used for the gym tracker and football-h2h modules:

```bash
npm test            # runs both suites
npm run test:gym
npm run test:football
```

## Deployment

The site is deployed to Netlify. `netlify.toml` defines security headers (HSTS, X-Frame-Options, Permissions-Policy, CSP-Report-Only) and long-cache directives for the gym-tracker assets. Any other static host works identically — just keep the directory layout intact.

## Browser Support

Latest two versions of Chrome, Edge, Firefox, and Safari (desktop and mobile).

## Technologies

- HTML5, CSS3 (with optional SASS preprocessing).
- Vanilla JavaScript with jQuery for the partials/auth UI.
- FontAwesome (4.x and 6.x).
- Chart.js (Mario Kart tracker only).
- Firebase Auth + Firestore + Realtime Database (optional sync).
- Netlify Functions (`firebase-config` endpoint).

## Contact

- Email: nikita@shevato.com
- Phone: +1 (504) 638-3370
- LinkedIn: [nikita-soifer](https://www.linkedin.com/in/nikita-soifer/)

## License

Proprietary. All rights reserved.
