# CLAUDE.md

Guidance for Claude (and other AI collaborators) working in this repo.

## What this repo is

Shevato is a static, multi-page web platform deployed to Netlify. It serves two audiences from a single codebase:

1. **Consulting site** — the marketing pages at the root (`home.html`, `work.html`, `apps.html`, `about.html`, `contact.html`) that present Shevato LLC as a software engineering firm.
2. **Free web apps** — a growing collection of browser apps under `apps/` that real users use daily (Mario Kart, Gym Tracker, Football H2H, Rising Seasons, MapTap Rivals, Arena).

A separately-branded multilingual medical landing (`moadon-alef.html`) is also hosted here for a client.

There is **no bundler**, no TypeScript, no linter, and no framework. CSS is plain, JS is loaded with `<script defer>`, and shared header/footer partials are stitched in client-side via jQuery (`assets/js/main.js`).

## Layout

```
shevato/
├── *.html                    # Marketing pages + moadon-alef + 404 + index shell
├── assets/
│   ├── css/                  # Plain stylesheets (no preprocessor at runtime)
│   ├── js/                   # Site-wide JS modules
│   ├── sass/                 # SASS sources for assets/css/main.css (optional)
│   └── seo/                  # JSON-LD reference fragments + metadata checklist
├── apps/                     # Self-contained browser apps
├── images/                   # Logos, backgrounds, OG cards
├── partials/                 # header.html + footer.html injected via data-include
├── sync-system/              # localStorage ↔ Firestore bridge used by all apps
├── netlify/                  # Netlify Functions (firebase-config endpoint)
├── netlify.toml              # Build, headers, redirects, CSP-Report-Only
├── sitemap.xml + sitemap-pages.xml + robots.txt
├── site.webmanifest          # PWA manifest for the marketing site
└── package.json              # node --test runner only — no build step
```

## Apps (each PM is a separate agent)

| App | Folder | Brief |
|-----|--------|-------|
| Mario Kart Tracker | `apps/mario-kart/` | Race log + charts. MK8 Deluxe and Mario Kart World |
| Gym Tracker | `apps/gym-tracker/` | PWA workout logger with programs + measurements |
| Football H2H | `apps/football-h2h/` | Two-player football match log + player stats |
| Rising Seasons | `apps/rising-seasons/` | TV shape detection + Plex/Kometa integration |
| MapTap Rivals | `apps/maptap-rivals/` | Daily MapTap.gg H2H + seasons + heatmap |
| Arena | `apps/arena/` | Real-time multiplayer hub (Firestore Realtime DB) |

## Local development

```bash
python3 -m http.server 8080
```

Then open `http://127.0.0.1:8080/`. Marketing pages are served directly; apps live under `/apps/<name>/`. The `moadon-alef.html` landing is served at the apex.

For the Rising Seasons data pipeline, the TMDB API token lives in repo-root `.env` (gitignored) as `TMDB_TOKEN`. Source it before running the `enrich:rising-seasons` script.

## Tests

```bash
npm test                            # runs every suite
npm run test:gym
npm run test:football
npm run test:rising-seasons         # render + integrations-lib
npm run test:mario-kart
npm run test:arena
npm run test:sync                   # cross-cutting sync-system invariants
```

The `sync-system/tests/` suite enforces cross-cutting invariants — run `npm test` after any non-trivial change before committing.

## Deployment

Netlify deploys from `master`. `netlify.toml` defines:
- Security headers (HSTS, X-Frame-Options, Permissions-Policy, CSP-Report-Only).
- A 301 redirect from the retired `product.html` to `work.html`.
- Long-cache directives for the gym-tracker static assets.

The apex (`/`) serves `index.html`, which client-redirects to `home.html` and is `noindex`. The canonical home is `home.html`.

## Conventions worth knowing

- **Partials**: marketing pages use `<div data-include="header"></div>` and `<div data-include="footer"></div>`. `assets/js/main.js` fetches and injects the matching `partials/<name>.html`.
- **Firebase config**: never hard-coded. `firebase-config.js` calls a Netlify Function (`/.netlify/functions/firebase-config`) to fetch the public web-app config. Secrets stay in Netlify env vars.
- **Brand colors**: `assets/css/brand-colors.css` exposes `--brand-blue` (`#0044cc`) and friends. Use the CSS variable, never hard-code the hex.
- **SEO metadata**: per-page checklist in `assets/seo/README.md`. Each indexable page needs title, description, canonical, OG/Twitter cards, and a JSON-LD `WebPage` node linked to the sitewide `WebSite` + `Organization` graph.
- **OG cards**: site-wide social preview is `/images/og-card.png` (1200×630). The moadon-alef landing has its own `/images/og-card-moadon-alef.png`.
- **Per-app SEO**: app `index.html` files declare their own canonical, OG, Twitter, and JSON-LD `WebApplication` blocks. Update them when the app gains visible features.

## How to work in this repo

- Prefer editing existing files. There is no scaffolding step for new pages — copy an existing page, swap the metadata, and add it to the sitemap.
- **Run `npm test` before reporting any change as done**, even chore/docs/CSS work — the cross-cutting `sync-system/tests/` suite catches breakage that the per-app tests miss.
- For visual changes (CSS, HTML layout, UI tweaks), screenshot-verify with the helper at `~/.claude/projects/-home-nikita-projects-shevato/tools/screenshot.sh` before reporting done. Static server on port 8080 is the prerequisite.
- For new HTML pages, follow the checklist in `assets/seo/README.md`. If you skip a section, comment why.
- Do not commit secrets. The repo root `.env` is gitignored; double-check before staging.
- Per-app PMs live as separate agents (`mario-kart-pm`, `gym-tracker-pm`, etc.). Site-level work belongs to `shevato-pm` and the marketing pages; in-app features belong to the app PMs.
