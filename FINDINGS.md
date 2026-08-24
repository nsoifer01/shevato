# Shevato site - engineering findings

Site-level knowledge that belongs to no single app: the marketing pages
(`*.html` at the root and `moadon-alef/`), the injected `partials/`, shared
`assets/` (CSS, JS, the auth modal, the sync banner), `sync-system/`,
`firestore.rules`, `privacy.html`, `netlify.toml` and the repo tooling
(`.gitignore`, `package.json`, the workflows). Per-app knowledge
lives in `apps/<app>/FINDINGS.md`; this file follows the same living-document
rule (rewrite, merge, delete; never an append-only diary).

## Netlify rewrites hrefs inside served HTML, including XHR-fetched partials

Netlify's Pretty URLs post-processes every HTML response: `href="/home.html"`
in `partials/header.html` is delivered as `href='/home'` (note the quote
change) on shevato.com. That is why the `.html` hrefs in partials and page
bodies do not produce 301 hops in production, and why the filename-based
active-page highlight in `main.js` works there although it compares against
`.html` names.

Do NOT rely on this for JSON or JS string URLs, or for XML: they are not
rewritten. Both known cases are fixed and pinned:
`site.webmanifest` `start_url` is `/home` (was `/home.html`, a redirect hop on
every installed-app launch) and `sitemap-pages.xml`'s moadon-alef hreflang
alternates are the extensionless URL matching its `<loc>` (they were four
`.html` alternates all pointing at the same URL).
Regressions: `tests/static/webmanifest.test.mjs` ("site.webmanifest launches
on the canonical /home and paints a dark splash") and
`tests/static/sitemap-alternates.test.mjs` (no alternate ends in `.html`,
every alternate href is itself a `<loc>`).

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

## privacy.html is binding, and now has a two-way invariant test

The document over-disclosed for months: it described sending Arena chat text to
PurgoMalum for profanity checking while `apps/arena/js/chat.js` was a local
word-boundary word list making zero external requests. Both the Arena bullet
and the PurgoMalum service entry are gone, and the FPL wording now says the
Delete/Disconnect actions also remove the cached copy of your team data while
the bulk public fixture and projection cache remains.
`sync-system/tests/privacy-third-parties.test.mjs` pins both directions:
every service named under "Other services that receive data" must map to a host
that appears as a URL literal in first-party code (host inventory derived from
`apps/`, `assets/`, `sync-system/`, `netlify/`, `partials/` and the root pages,
the way `tests/static/csp-connect-src.test.mjs` does it), every mapped service
must still be named in the document, and PurgoMalum must never reappear.
When a service is added or removed, update `SERVICE_HOSTS` in that test in the
same change.

## tel: hrefs are E.164 and country-checked

`internal-links.test.mjs` skips `tel:` and `mailto:`, which is how the
moadon-alef footer shipped `tel:+1700701103` (a North American number for an
Israeli 1-700 line, while the page body dialled `+9721700701103`) and the site
footer shipped `tel:+1504-638-3370` (hyphens inside the URI, which some dialers
mis-parse) next to contact.html's clean `tel:+15046383370`. Both fixed;
`tests/static/tel-hrefs.test.mjs` requires every `tel:` href on a root page or
partial to be `tel:+<digits>` with `+972` on moadon-alef surfaces and `+1`
elsewhere.

## The @import chain in main.css is preloaded, not removed

`assets/css/main.css` starts with `@import` for the Google Font CSS and
`firebase-auth.css` (57 KB), which serialises round trips before first paint.
The imports stay because all eight app pages load `main.css` too and their
`<head>`s are app-owned; instead every root page carries
`<link rel="preload" ... as="style">` for both, so the fetches start with the
HTML parse. Removing the `@import`s means editing every app page's head in the
same change.

## Site chrome facts worth keeping

- The apps hub OG/Twitter descriptions are pinned to the manifest by
  `sync-system/tests/app-naming-consistency.test.mjs` ("apps.html
  og:description and twitter:description name every manifest app"); they had
  drifted to five apps while the page listed eight.
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
