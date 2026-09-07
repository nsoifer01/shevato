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

**Future apps:** all eight apps have both files today. New apps gain them when
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
  must run unchanged in a browser and under `node --test`. The three standing
  exceptions are `@netlify/blobs` (declared at the root so the Netlify
  functions bundle; never used by browser code), the dev-only Playwright
  (used solely by `tests/cross-browser/`) and the dev-only ESLint (used solely
  by `npm run lint`). None is ever imported by app or test code. Only the
  `lint` and `cross-browser` workflows run npm install; the push/PR TEST
  workflows stay dependency-free.
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
- `npm run test:all` is the local merge gate and now runs lint first, so the
  cheapest check fails fastest.
- `.features/` holds each app's living test-plan pair (gitignored,
  owner-reviewed); plans are archived, never deleted.

## Superseded files

`.claude_rules` (a generic YAML checklist from an earlier setup, never
auto-loaded, referencing docs that do not exist) was removed on 2026-08-12 in
favour of this file. Its one live rule, always run `npm test`, is preserved
above.
