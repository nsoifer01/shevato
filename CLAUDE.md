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

**Future apps:** every app has both files today. New apps gain them when
meaningful work on them begins; do not retro-document every app speculatively. Site-level work (marketing pages,
`sync-system/`, shared assets) counts as "the site": record durable site-level
findings in the most relevant app's FINDINGS if they surfaced there, or start
the convention where the work happens.

For the FPL Planner specifically, also read the Methodology section of
`apps/fpl-planner/experiments/registry.md` before ANY modelling or planner
experiment, and record every experiment there with an explicit ACCEPT or
REJECT, whichever way it goes.

## Repo conventions (the ones that bite)

- **This checkout is shared with other sessions, so check `git status` immediately
  before EVERY branch switch, not once at the start.** Parallel worktree sessions
  are a normal way of working here, and a tree that was clean when you began is
  not evidence of anything an hour later. Clean and on `master` -> branch and work
  there. Dirty with changes that are not yours -> **take a worktree**
  (`git worktree add`), and do not switch, stash or commit; one checkout has one
  HEAD, and `git checkout` drags uncommitted changes onto the branch you move to.
  This bites hardest on the boring end-of-round `git checkout master && git pull`
  after a merge: on 2026-09-06 that silently moved a concurrent session's 85 lines
  onto `master`, where its next commit would have landed on `master`. Query other
  refs in place instead (`git log origin/master`, `git show <ref>:<path>`). Full
  rule, including the recovery procedure, in `~/.claude/CLAUDE.md` (rule #2).
- **Always run `npm test` from the repo root after any change**, including
  chore/docs/seo edits, before reporting done. Cross-cutting invariant tests
  under `sync-system/tests/` catch tiny edits (sitemap forms, A-Z ordering,
  shared-UI scoping).
- **`npm run test:browser:parallel` must be green BEFORE `gh pr create`, not
  after.** About eleven minutes (11.1, measured 2026-09-14), four shards at
  once; budget it into the round. It never touches the internet: third-party
  requests are answered from `tests/browser/vendor/third-party/`, and when
  `npm test` says the mirror is missing an asset, run
  `node tests/browser/refresh-third-party.mjs`.
  `npm test` structurally cannot see browser-only breakage: 71 of 187 source
  files are never imported by the unit estate, and every one of them loads
  cleanly on its own under `node --test` even when it is dead in a browser. On
  PR #530, 6,331 unit tests and a clean lint gate were all green while the
  Rising Shows app rendered nothing, because `match.js` had gained a top-level
  `const API` that collided with `finder-lib.js`'s in the shared classic-script
  scope. If sub-agents are running, tell them NOT to start browser suites (they
  contend over CDP 9222), then run it yourself once they have all finished;
  that handoff is where it gets skipped.
- **Apps are listed A-Z on every surface**, no exceptions; enforced by tests.
  Adding an app touches ~20 surfaces: follow "Adding a new app" in the root
  README.
- **`privacy.html` is binding.** It makes narrow checkable promises per app
  (what is sent, stored, synced, deletable). Check it BEFORE adding tracking,
  identifiers, storage or third-party calls; update it in the same change, and
  **set `Last reviewed:` to the UTC calendar date the change reaches master**
  (`date -u '+%-d %B %Y'`), not the day you wrote the words and not anyone's
  local date: a review date is a claim about the published page, and GitHub's
  merge and Netlify's publish are both stamped in UTC. PR #530 dated its
  paragraphs 11 September and merged on the 12th, publishing a date older than
  its content, so re-read that line at merge time. Two policy changes on the
  same UTC day share that day's date. `tests/static/privacy-review-date.test.mjs`
  fails when the policy prose changes and the date is not the UTC day it ships
  (today for anything not on master yet, the commit's own day once it is);
  when it goes red, set the date it names and record the digest it prints. It
  checks against git, so overwriting `CURRENT.digest` in place does not turn it
  green. No part of this rule is ever a reason to wait for a date to change.
- **Dates and clocks: name the zone, and never wait on one without a real
  dependency.** Published date-only stamps (privacy.html `Last reviewed`) are
  UTC calendar days, the zone CI, GitHub merges and Netlify deploys run and
  stamp in. App data is the viewer's LOCAL calendar day on purpose (Gym
  Tracker, MapTap Rivals), so tests that depend on it pin `TZ` or anchor on the
  real current week, never a fixed date fed to a real-clock function. The
  owner's local time names session reports and nothing else. If work is valid
  now, do it now: wait on a clock only for a genuine external condition (an
  FPL deadline, a scheduled data refresh), and name that condition before
  waiting. On 2026-09-13 a session proposed holding a green privacy PR for
  three hours until the owner's local midnight, when it was already the 14th
  in UTC and the guard passed; a "blocked until <date>" note carried across a
  context summary had been treated as a fact instead of a condition to re-check.
- **Screenshot-verify every visual change** on desktop 1280 AND mobile 390
  before believing it. Computed styles for any colour claim, never eyeballing:
  `assets/css/main.css` sets `button { color:#555 !important }`, a red hover
  and a red input focus ring that silently defeat unpinned app styles.
- **Shared-UI scoping contract**: app styles hang off a root wrapper div, page
  tokens on a body class, never restyle shared chrome. Enforced by
  `sync-system/tests/shared-ui-consistency.test.mjs`.
- **Port 8080 is reserved on the owner's machine.** Serve on 8081+ and shut servers
  down when the work ends (`ss -ltn` to verify). `netlify dev` serves the site
  AND functions on 8888 (pinned); its internal static port does not route
  functions.
- **No third-party request on a page's boot path.** A stalled (not refused) CDN
  holds whatever the page waits on: deferred Firebase modules, `<head>`
  stylesheets and synchronous CDN scripts each kept every page from reaching
  DOMContentLoaded on 2026-09-13. Third-party scripts and the Firebase module
  tags are `async`, third-party stylesheets use `media="print"
  onload="this.media='all'"` with a `<noscript>` copy, no CSS `@import`s a
  third-party URL, and anything needed in order is served from this origin.
  Enforced by `tests/static/third-party-boot-path.test.mjs` and the site
  suite's stall check; the account is in the root `FINDINGS.md`.
- **Netlify build minutes are a budget.** The production project is on legacy
  Free: 300 build minutes a calendar month (Pacific), one production build of
  about a minute per push to `master`. Deploy Previews are OFF on it on purpose
  (2026-09-14; they were 69% of September's minutes). Do not re-enable them, add
  a build hook or add a Netlify build trigger without reading "Netlify build
  minutes" in the root `FINDINGS.md`. `scripts/netlify-ignore.mjs` skips builds
  that cannot change the site, so a cancelled deploy with `[netlify-ignore] SKIP`
  in its log is intentional, and "Clear cache and deploy project" forces one.
  Widening what it skips needs the proofs in
  `tests/static/netlify-ignore.test.mjs` extended first.
- Dark theme only, never add a light theme or toggle. LF line endings, never
  CRLF. No asset build step at the root (`npm run build:site` only generates
  data-driven pages and stamps sitemaps at deploy), and effectively no npm dependencies: code
  must run unchanged in a browser and under `node --test`. The four standing
  exceptions are `@netlify/blobs` (declared at the root so the Netlify
  functions bundle; never used by browser code), the dev-only Playwright
  (used solely by `tests/cross-browser/`), and the dev-only ESLint and its
  `globals` package (both used solely by `npm run lint`, through
  `eslint.config.mjs`). None is ever imported by app or test code. Only the
  `lint` job of `ci.yml` and the `cross-browser` job of `scheduled.yml` run npm
  install; the unit, browser and Arena jobs stay dependency-free.
- **`npm run lint` is a correctness gate, not a style one.** It exists because
  a dead store to an undeclared binding (`wasOpen`) shipped to production and
  threw on every mobile menu toggle for 12 days while the whole test estate
  stayed green. `CORRECTNESS_RULES` in `eslint.config.mjs` holds 28 rules, each
  one flagging code that is wrong rather than unfashionable. Do NOT add
  Prettier, a style preset, or `eslint:recommended` wholesale. `no-unused-vars`,
  `no-redeclare`, `no-empty` and `no-useless-escape` were measured and left OFF
  deliberately: they report pre-existing style debt, and the reasons are
  written in the config header. Adding any rule means measuring it FIRST, by
  injecting it into the config blocks that already carry `rules` (measuring
  with `eslint --rule` gives wildly inflated numbers, because it lints files
  the config gives no globals to). When a genuinely cross-file global is added
  to mario-kart or football-h2h (classic multi-script apps), declare it in
  `eslint.config.mjs`; that is bookkeeping, not suppression.
  **Check COVERAGE with `eslint --print-config <file>` and count `rules`, never
  by whether `npx eslint .` passes.** A file matching no config block is not an
  error, it is silently skipped with zero rules. That is how
  `sync-system/*.mjs` (a `**/*.js` glob), both service workers (a block with
  globals and no `rules` key) and `apps/gym-tracker/data/*.js` sat outside the
  gate until 2026-09-11. A covered file reports 28.
- `npm run test:all` is the local merge gate and now runs lint first, so the
  cheapest check fails fastest.
- **Debug a slow/flaky e2e with the narrowest run and a unit test, never by
  re-running the suite.** The Arena emulator suite takes 5-11 minutes; one
  scenario takes about 70 seconds (`ARENA_E2E_ONLY=S6:`, which works standalone
  since 2026-09-12 because `guard()` opens the client pages). Read the code and
  form the hypothesis first, add every probe you might want in ONE pass
  (re-arming costs a whole run), reproduce ONCE, then pin the logic with a
  `node:test` unit test in milliseconds and run the full suite ONCE at the end.
  Never run other work on the box while a timing-sensitive run is going, and
  check the emulator ports are free first: a leftover emulator makes the run
  SKIP, and a skipped batch looks like a finished one. Chasing one timing bug
  by re-running the whole suite eleven times cost 70 wasted minutes on
  2026-09-12; the reasoning is in `apps/arena/FINDINGS.md`, "One scenario should
  cost one scenario".
- `.features/` holds each app's living test-plan pair (gitignored,
  owner-reviewed); plans are archived, never deleted.

## Every PR: a `## DEV vs PROD` section

Owner rule, 2026-09-17. Every PR body carries a short `## DEV vs PROD` section
under the `## TL;DR`. Its only job is that the owner glances at it, opens DEV
and PROD themselves, and knows what to look for before merging.

One numbered item per meaningful user-visible change, a PROD line for what they
see today and a DEV line for what they see with this PR:

```markdown
## DEV vs PROD

1. FPL captain explanation
- PROD: Shows the captain recommendation without explaining why that player was chosen.
- DEV: Shows a short explanation underneath the captain recommendation.

2. Trip Planner hotel cards
- PROD: Distance appears only after opening the hotel.
- DEV: Distance is visible directly on each hotel card.
```

When nothing user-visible changed, the whole section is one line: `No
user-visible DEV vs PROD differences. This PR only changes internal/docs/test
code.`

Keep it short and human. It never carries DEV or PROD URLs, commit shas,
release ids, deploy ids, Netlify, branch or build detail, click-by-click steps,
implementation notes, a file list or test results, and it gets no "cannot be
verified" note unless there is something the owner genuinely needs to know.
Only differences they can see or try for themselves. The per-file enumeration
still follows below it, unchanged, and the section is rewritten whenever a
later push changes what the PR does.

DEV itself is the PR head published as a Netlify CLI draft deploy, whose URL
goes in the chat report, never in the PR body. A CLI upload runs no build on
Netlify, so it costs no build minutes; Deploy Previews stay off. Build it from
a detached throwaway worktree of the head (up to date with `origin/master`) on
Node 22 (`.nvmrc`): `npm ci --omit=dev && npm run build:site`, then, with
`netlify status` showing the account that owns the `shevato` project,
`netlify deploy --no-build --dir dist --functions netlify/functions --site
fe5f021f-f41b-4b5a-b553-a03729fe4f6d`. Never `--prod`, and never `--alias`:
measured 2026-09-17, an aliased upload is a `branch-deploy` served with NO
`x-robots-tag` on pages that say `index, follow`, so it is a crawlable copy of
the site, while the plain draft permalink is served `x-robots-tag: noindex`.
Two things DEV cannot show, worth knowing when a change depends on them: the
FPL Planner's data and Trip Planner's place search and trip assist (their
functions accept only `https://shevato.com` and localhost, so they answer 403
there), and sign-in (Firebase Auth accepts only its exact listed hosts).

## Superseded files

`.claude_rules` (a generic YAML checklist from an earlier setup, never
auto-loaded, referencing docs that do not exist) was removed on 2026-08-12 in
favour of this file. Its one live rule, always run `npm test`, is preserved
above.
