# CLAUDE.md - project rules for shevato

This is a multi-app repository. The root `README.md` is the GENERAL repository
overview; detailed knowledge lives with each app.

## Per-app documentation convention (applies to every session, unprompted)

Each app under `apps/` may carry two documents beside its code:

- `apps/<app>/README.md` - the current, detailed description of that app: what
  it is, how it works, architecture, data flow, how to run and test it. Stable
  knowledge.
- `apps/<app>/FINDINGS.md` - accumulated engineering knowledge: discoveries,
  gotchas, root causes, edge cases, decisions and their reasons, regression
  risks, things tried that failed, open questions. A LIVING document: rewrite,
  merge and delete sections so it always states the best current
  understanding. Never an append-only diary.

**When starting work on an app:** read that app's `README.md` and `FINDINGS.md`
FIRST, before meaningful implementation work, without being asked. Treat the
README as the current description and FINDINGS as context from previous
sessions; still verify important assumptions against the code.

**During work:** whenever a session writes substantial code, changes behaviour
or architecture, fixes or discovers a bug or edge case, changes an integration,
learns something about an external service or the data, changes configuration
or tests, or makes a decision a future session should know about: consider
whether that app's `README.md`, `FINDINGS.md`, or both need updating, and do it
in the same round.

**Definition of done:** before considering a work session on an app complete,
review that app's `README.md` and `FINDINGS.md` against everything learned or
changed, and update them where appropriate. Use judgment: no noise after
trivial edits, no drift after real work.

**Future apps:** seven of the eight apps have both files today (mario-kart
has a README only). New apps gain them when meaningful work on them begins;
do not retro-document every app speculatively. Site-level work (marketing pages,
`sync-system/`, shared assets) counts as "the site": record durable site-level
findings in the most relevant app's FINDINGS if they surfaced there, or start
the convention where the work happens.

For the FPL Planner specifically, also read the Methodology section of
`apps/fpl-planner/experiments/registry.md` before ANY modelling or planner
experiment, and record every experiment there with an explicit ACCEPT or
REJECT, whichever way it goes.

## Repo conventions (the ones that bite)

- **Always run `npm test` from the repo root after any change**, including
  chore/docs/seo edits, before reporting done. Cross-cutting invariant tests
  under `sync-system/tests/` catch tiny edits (sitemap forms, A-Z ordering,
  shared-UI scoping).
- **Apps are listed A-Z on every surface**, no exceptions; enforced by tests.
  Adding an app touches ~20 surfaces: follow "Adding a new app" in the root
  README.
- **`privacy.html` is binding.** It makes narrow checkable promises per app
  (what is sent, stored, synced, deletable). Check it BEFORE adding tracking,
  identifiers, storage or third-party calls; update it in the same change.
- **Screenshot-verify every visual change** on desktop 1280 AND mobile 390
  before believing it. Computed styles for any colour claim, never eyeballing:
  `assets/css/main.css` sets `button { color:#555 !important }`, a red hover
  and a red input focus ring that silently defeat unpinned app styles.
- **Shared-UI scoping contract**: app styles hang off a root wrapper div, page
  tokens on a body class, never restyle shared chrome. Enforced by
  `sync-system/tests/shared-ui-consistency.test.mjs`.
- **Ports 8080 and 8081 are reserved on the owner's machine.** Serve on 8082+ and shut servers
  down when the work ends (`ss -ltn` to verify). `netlify dev` serves the site
  AND functions on 8888 (pinned); its internal static port does not route
  functions.
- Dark theme only, never add a light theme or toggle. LF line endings, never
  CRLF. No asset build step at the root (`npm run build:site` only generates
  data-driven pages and stamps sitemaps at deploy), and effectively no npm dependencies: code
  must run unchanged in a browser and under `node --test`. The two standing
  exceptions are `@netlify/blobs` (declared at the root so the Netlify
  functions bundle; never used by browser code) and the dev-only Playwright
  (used solely by `tests/cross-browser/`; main CI never runs npm install).
- `.features/` holds each app's living test-plan pair (gitignored,
  owner-reviewed); plans are archived, never deleted.

## Superseded files

`.claude_rules` (a generic YAML checklist from an earlier setup, never
auto-loaded, referencing docs that do not exist) was removed on 2026-08-12 in
favour of this file. Its one live rule, always run `npm test`, is preserved
above.
