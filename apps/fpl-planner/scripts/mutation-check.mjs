#!/usr/bin/env node
// A small, curated, dependency-free mutation check for the FPL Planner: it
// tests the TESTS.
//
// WHY THIS EXISTS (2026-10-16). Several defects escaped past a green suite
// because the test that was meant to catch them could not fail:
//   - a brute-force optimality test filtered candidates on `rules.maxPerClub`,
//     a field that does not exist, so the club limit never applied and the
//     "reference" optimum was an illegal squad (real-deadline-gw7.test.mjs);
//   - a test that skipped on every run, so it reported nothing for weeks;
//   - e2e fixtures in states FPL cannot produce, so the assertions about them
//     held for a world that never happens;
//   - evidence that could not have disproved the claim it was quoted for.
// A passing test proves something only if it would FAIL when the rule it names
// is broken. This script breaks each rule on purpose (one "mutant" at a time),
// runs the tests that claim to guard it, and expects them to go red. A mutant
// the tests do not notice ("SURVIVED") is a rule nobody is actually checking.
//
// WHY CURATED, NOT GENERATED. Stryker and friends need npm dependencies, which
// this repo does not take (root CLAUDE.md: code runs unchanged under plain
// `node --test`), and a generated mutant set on a 5,000-line engine is hours of
// noise. Each entry below is a rule that was either broken in production or
// claimed by a test that turned out to be inert, so every survivor is worth a
// human's attention.
//
// WHY EXACT STRINGS. Every mutant is an exact `find` -> `replace` text edit,
// and the `find` must occur EXACTLY ONCE in its file. If a refactor moves or
// rewrites the code, the checker fails loudly ("find occurs 0 times") instead
// of silently mutating nothing and reporting a kill that never happened.
// tests/mutation-check.test.mjs checks the same thing on every `npm test`, so
// a refactor breaks CI on its own pull request, not on the weekly run.
//
// WHY A BASELINE. A mutant counts as KILLED when its tests fail. If those tests
// already fail on the unmutated code (an environment problem, a missing file in
// the working copy, someone's in-flight work), every mutant would read KILLED
// and the report would be worthless. So the mapped test files are also run on
// the pristine copy, and the check fails unless that baseline is green. Each
// mutated file is also parsed (`node --check`) so a replacement that is simply
// a syntax error is reported as INVALID rather than counted as a kill.
//
// NEVER THE REAL TREE. Everything happens in a working copy under
// os.tmpdir(): one pristine copy is made from the repo, then one clone per
// worker, and each worker applies a mutant, runs its tests, and restores the
// file before taking the next. The repo is only ever read.
//
// Usage:
//   node apps/fpl-planner/scripts/mutation-check.mjs            run every mutant
//   node apps/fpl-planner/scripts/mutation-check.mjs --list     print the table
//   node apps/fpl-planner/scripts/mutation-check.mjs --only a,b run these ids
// Exit 1 when any mutant survives, is invalid, or cannot be applied, or when
// the baseline is red.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const APP = 'apps/fpl-planner';
const ENGINE = `${APP}/js/engine`;
const T = (name) => `${APP}/tests/${name}.test.mjs`;
const NT = (name) => `netlify/functions/tests/${name}.test.mjs`;

// What the working copy needs. The app without its local data cache (.data/ is
// tens of megabytes of fetched FPL payloads no unit test reads) and the
// Netlify functions the proxy tests import, plus the root package.json so a
// stray `.js` outside a typed package resolves the same way as in the repo.
// netlify/functions/node_modules is LINKED, not copied: it is 30+ MB and the
// mutants never touch it.
export const COPY_PATHS = [
  { path: 'package.json' },
  { path: APP, skip: ['.data', 'node_modules'] },
  { path: 'netlify/functions', skip: ['node_modules'], link: ['node_modules'] },
];

// The curated table. Each mutant: a stable id, the file, the exact text to
// find (once), its replacement, the SMALLEST set of existing test files that
// should kill it (they run in a fresh `node --test` per mutant, so a slow file
// costs its full runtime every time it is mapped), and the rule it guards.
export const MUTANTS = [
  // ---- transfer-state.js: the free-transfer bank (FPL's five rules). ----
  {
    id: 'ts-chip-week-plus-one',
    file: `${ENGINE}/transfer-state.js`,
    find: 'return seasonState(preserves ? state.banked : 1, rules, nextGw);',
    replace: 'return seasonState(preserves ? state.banked + 1 : 1, rules, nextGw);',
    tests: [T('transfer-state'), T('transfer-state-real')],
    guards: 'A Wildcard or Free Hit week freezes the bank and grants no +1 (rule 5, 2024-25 rules; 2026-10-16 rollover audit).',
  },
  {
    id: 'ts-bank-cap-4',
    file: `${ENGINE}/transfer-state.js`,
    find: 'const cap = rules.maxFreeTransfers;',
    replace: 'const cap = rules.maxFreeTransfers - 1;',
    tests: [T('transfer-state'), T('transfer-state-real')],
    guards: 'The bank caps at 5 free transfers (1 + max_extra_free_transfers), not 4 (mutant added 2026-10-16).',
  },
  {
    id: 'ts-hit-cost-zero',
    file: `${ENGINE}/transfer-state.js`,
    find: 'return hitsFor(state, transfersMade, chipPlayed) * rules.hitCost;',
    replace: 'return hitsFor(state, transfersMade, chipPlayed) * 0;',
    tests: [T('transfer-state'), T('transfer-state-real')],
    guards: 'Each transfer beyond the bank costs 4 points (hitCost) (mutant added 2026-10-16).',
  },
  {
    id: 'rules-bank-cap-4',
    file: `${ENGINE}/rules.js`,
    find: 'maxFreeTransfers: 1 + settings.max_extra_free_transfers,',
    replace: 'maxFreeTransfers: settings.max_extra_free_transfers,',
    tests: [T('rules'), T('transfer-state-real')],
    guards: 'Rules derive the bank cap as 1 + max_extra_free_transfers (5 since 2024-25) (mutant added 2026-10-16).',
  },
  {
    id: 'rules-hit-cost-zero',
    file: `${ENGINE}/rules.js`,
    find: 'const HIT_COST_POINTS = 4;',
    replace: 'const HIT_COST_POINTS = 0;',
    tests: [T('rules'), T('transfer-state-real')],
    guards: 'The 4-point hit is not in bootstrap-static, so rules.js is its one source (mutant added 2026-10-16).',
  },

  // ---- squad.js: a manager-state payload that lags (2026-10-16 follow-up audit). ----
  {
    id: 'squad-caught-up-identity',
    file: `${ENGINE}/squad.js`,
    find: 'export function historyCaughtUp(history, picks) {\n',
    replace: 'export function historyCaughtUp(history, picks) {\n  return history;\n',
    tests: [T('manager-state-lag'), T('squad')],
    guards: 'A history one week behind the picks is filled from the picks row (2 banked + 2 made read 2 free where FPL said 1, 2026-10-16).',
  },
  {
    id: 'squad-gaps-empty',
    file: `${ENGINE}/squad.js`,
    find: 'export function historyGaps(history) {\n',
    replace: 'export function historyGaps(history) {\n  return [];\n',
    tests: [T('manager-state-lag')],
    guards: 'A history two or more weeks behind is treated as missing (1 free read as 2, a played Bench Boost offered back, 2026-10-16).',
  },
  {
    id: 'squad-transfers-behind-empty',
    file: `${ENGINE}/squad.js`,
    find: 'export function transfersBehind(history, transfers) {\n',
    replace: 'export function transfersBehind(history, transfers) {\n  return [];\n',
    tests: [T('manager-state-lag')],
    guards: 'A transfer list behind the history is detected (100.4 read as 100.1 selling value, 2026-10-16).',
  },
  {
    id: 'squad-unexplained-empty',
    file: `${ENGINE}/squad.js`,
    find: 'export function unexplainedPlayers({ picks, startPicks, transfers, history }) {\n',
    replace: 'export function unexplainedPlayers({ picks, startPicks, transfers, history }) {\n  return [];\n',
    tests: [T('manager-state-properties')],
    guards: 'A transfer list ending before a Wildcard week is detected (Wildcard buys sold at 5.9 for 5.5, 2026-10-17).',
  },
  {
    id: 'rules-selling-price-ceil',
    file: `${ENGINE}/rules.js`,
    find: 'return purchaseTenths + Math.floor((nowTenths - purchaseTenths) * rules.sellFeeRate);',
    replace: 'return purchaseTenths + Math.ceil((nowTenths - purchaseTenths) * rules.sellFeeRate);',
    tests: [T('rules'), T('squad')],
    guards: 'FPL sell-on rule: purchase + floor(gain / 2), never rounded up (mutant added 2026-10-16).',
  },

  // ---- rules.js / chips.js: chip windows and chip copy. ----
  {
    id: 'rules-chip-window-stop-plus-one',
    file: `${ENGINE}/rules.js`,
    find: 'if (gw < w.startEvent || gw > w.stopEvent) continue;',
    replace: 'if (gw < w.startEvent || gw > w.stopEvent + 1) continue;',
    // rules.test.mjs never asks about the GW after a stop event; the chip
    // windows in chips.test.mjs do, through chipAvailableAt.
    tests: [T('chips')],
    guards: 'A chip is playable only inside its start/stop window (first-half chips expire at the GW19 stop event) (mutant added 2026-10-16).',
  },
  {
    id: 'chips-window-stop-plus-one',
    file: `${ENGINE}/chips.js`,
    find: 'if (gw < w.startEvent || gw > w.stopEvent) continue;',
    replace: 'if (gw < w.startEvent || gw > w.stopEvent + 1) continue;',
    tests: [T('chips')],
    guards: 'chipWindowAt names the unspent window gw falls in, and none past its stop event (mutant added 2026-10-16).',
  },
  {
    id: 'chips-better-later-on-tie',
    file: `${ENGINE}/chips.js`,
    find: 'return entry.bestValue > entry.valueNow ? entry.bestGw : null;',
    replace: 'return entry.bestValue >= entry.valueNow ? entry.bestGw : null;',
    tests: [T('chips')],
    guards: 'A chip held on a tie never claims a later week is better (8 of 61 managers told GW16 was better, 2026-10-16).',
  },

  // ---- transfers.js: the transfer search. ----
  {
    id: 'transfers-hit-depth-off',
    file: `${ENGINE}/transfers.js`,
    find: '  hitDepth: true,\n',
    replace: '  hitDepth: false,\n',
    // transfers.test.mjs does not notice this mutant (measured 2026-10-16: its
    // worlds never need a third move); search-corrections.test.mjs pins the
    // depth that hits reach.
    tests: [T('search-corrections')],
    guards: 'The search depth counts allowed hits, so 2 free transfers can reach a third move (registry 48, 2026-10-16).',
  },
  {
    id: 'transfers-club-limit-off',
    file: `${ENGINE}/transfers.js`,
    find: '    if (clubLimitBreaches(squad, players, R.clubLimit, ownedIds).length) return;\n',
    replace: '    if (false) return;\n',
    tests: [T('transfers'), T('inherited-club-limit')],
    guards: 'No candidate holds more than 3 players from one club, and none keeps a club a player moved to over it (2026-10-16; whole squad since 2026-10-24).',
  },

  // ---- planner.js: ranking and what the alternatives show. ----
  {
    id: 'planner-polish-off',
    file: `${ENGINE}/planner.js`,
    find: 'polish: options.polish === undefined ? true : !!options.polish,',
    replace: 'polish: options.polish === undefined ? false : !!options.polish,',
    tests: [T('search-corrections')],
    guards: 'The leading transfer plans are polished on the ranking objective by default (registry 48, 2026-10-16).',
  },
  {
    id: 'planner-chip-delta-same-chip',
    file: `${ENGINE}/planner.js`,
    find: 'deltaWithChipValue: scored.chip !== primaryScored.chip || TIMING_CHIPS.has(scored.chip)',
    replace: 'deltaWithChipValue: scored.chip !== primaryScored.chip',
    tests: [T('real-deadline-gw7')],
    guards: 'A same-chip Bench Boost / Triple Captain alternative is compared on the ranking gap ("+0.52 pts" while ranked 0.43 below, 2026-10-16).',
  },

  // ---- confidence.js: the number the UI prints for an alternative. ----
  {
    id: 'confidence-shown-delta-horizon',
    file: `${ENGINE}/confidence.js`,
    find: 'return Number.isFinite(alt.deltaWithChipValue) ? alt.deltaWithChipValue : alt.deltaHorizon;',
    replace: 'return alt.deltaHorizon;',
    tests: [T('gw7-audit-followup-ui')],
    guards: 'The confidence copy uses the chip-valued gap the planner ranked on, not the raw horizon gap (GW7 Bench Boost manager, 2026-10-16).',
  },

  // ---- validate.js: the plan validator every output passes through. ----
  {
    id: 'validate-formation-off',
    file: `${ENGINE}/validate.js`,
    find: 'if (actual < pos.minPlay || actual > pos.maxPlay) {',
    replace: 'if (false) {',
    tests: [T('validate')],
    guards: 'An XI outside 1 GK, 3-5 DEF, 2-5 MID, 1-3 FWD is rejected as illegal (mutant added 2026-10-16).',
  },

  // ---- the production probe and the FPL proxy. ----
  {
    id: 'probe-fresh-limit-flat',
    file: `${APP}/scripts/lib/probe.mjs`,
    find: '? FINISHED_PICKS_FRESH_SECONDS : FRESH_PROXY_SECONDS;',
    replace: '? 3600 : 3600;',
    tests: [T('probe-freshness')],
    guards: "A finished gameweek's picks may be a day old before the probe calls the proxy stale (false alarms every Monday, 2026-10-16).",
  },
  {
    id: 'cache-scrub-identity',
    file: 'netlify/functions/lib/fpl-cache.mjs',
    find: 'export function scrubUpstreamText(text) {\n',
    replace: 'export function scrubUpstreamText(text) {\n  return String(text == null ? \'\' : text);\n',
    tests: [NT('fpl')],
    guards: 'No team id leaves in a recorded upstream body (privacy.html: the store holds public FPL responses only, 2026-10-16).',
  },
  {
    id: 'cache-retry-after-ignores-dates',
    file: 'netlify/functions/lib/fpl-cache.mjs',
    find: 'else if (/[a-z]/i.test(raw) && Number.isFinite(Date.parse(raw)))',
    replace: 'else if (false && /[a-z]/i.test(raw) && Number.isFinite(Date.parse(raw)))',
    tests: [NT('fpl')],
    guards: 'An HTTP-date Retry-After from FPL sets the refusal backoff, not just a seconds value (2026-10-16).',
  },
  {
    id: 'cache-single-403-backs-off',
    file: 'netlify/functions/lib/fpl-cache.mjs',
    find: 'record.until = told || corroborated ?',
    replace: 'record.until = true ?',
    tests: [NT('fpl')],
    guards: 'One 403 is one refused request: it never backs off every caller on every path (#616, 2026-10-17).',
  },
  {
    id: 'cache-corroboration-ignored',
    file: 'netlify/functions/lib/fpl-cache.mjs',
    find: 'record.until = told || corroborated ?',
    replace: 'record.until = told ?',
    tests: [NT('fpl')],
    guards: 'A second refusal inside the window is a block and backs off (the 2026-10-16 two-hour block, #616 fix).',
  },
  {
    id: 'health-reread-our-own-degradation',
    file: 'netlify/functions/lib/fpl-health-run.mjs',
    find: 'if (!degraded || !UPSTREAM_CAUSES.includes(cause)) return first;',
    replace: 'if (!degraded) return first;',
    tests: [NT('fpl-health')],
    guards: 'The health run re-reads only an answer FPL degraded, never one our quota or our own bug degraded (#616, 2026-10-17).',
  },
  {
    id: 'health-reread-never',
    file: 'netlify/functions/lib/fpl-health-run.mjs',
    find: 'if (!degraded || !UPSTREAM_CAUSES.includes(cause)) return first;',
    replace: 'return first;',
    tests: [NT('fpl-health')],
    guards: 'A single FPL blip is read again as the app retries it, and does not fail the run (#616, 2026-10-17).',
  },
  {
    id: 'health-no-hourly-recheck',
    file: 'netlify/functions/lib/fpl-health-run.mjs',
    find: 'if (before && before.ok === false) return { slot: slotOf(at, RECHECK_HOURS), recheck: true };',
    replace: 'if (false) return { slot: slotOf(at, RECHECK_HOURS), recheck: true };',
    tests: [NT('fpl-health')],
    guards: 'While red, the health run re-checks every hour, so a recovery closes the incident within an hour (#616, 2026-10-17).',
  },
  {
    id: 'health-redispatch-unchanged',
    file: 'netlify/functions/lib/fpl-health-run.mjs',
    find: 'if ((!latest.ok || priorUnsettled) && !unchanged) {',
    replace: 'if (!latest.ok || priorUnsettled) {',
    tests: [NT('fpl-health')],
    guards: 'An hourly recheck that fails exactly as before starts no workflow run, so an open incident is not an email an hour (2026-10-17).',
  },
  // ---- the club limit binds on a change, not on what is held (2026-10-24). ----
  {
    id: 'club-limit-held-not-exempt',
    file: `${ENGINE}/validate.js`,
    find: 'if (same.size === held.size && squad.length === held.size && squad.every(id => held.has(id))) return [];',
    replace: 'if (false) return [];',
    tests: [T('inherited-club-limit')],
    guards: 'A squad held over the limit because a player moved club is legal to keep; the planner refused to plan it (four Arsenal, 2026-10-24).',
  },
  {
    id: 'club-limit-never-binds-in-validate',
    file: `${ENGINE}/validate.js`,
    find: 'clubLimitBreaches(known, players, R.clubLimit, heldIds.length ? heldIds : null)',
    replace: 'clubLimitBreaches(known, players, R.clubLimit, known)',
    tests: [T('inherited-club-limit'), T('validate')],
    guards: 'validatePlan still refuses a transferred squad over the limit, including one that keeps four from a club a player moved to (2026-10-24).',
  },
  {
    id: 'club-limit-polish-unchecked',
    file: `${ENGINE}/planner.js`,
    find: 'const legalSquad = (squad) => !clubLimitBreaches(squad, players, rules.clubLimit, held).length;',
    replace: 'const legalSquad = () => true;',
    tests: [T('inherited-club-limit'), T('search-corrections')],
    guards: "The planner's polish never swaps into a squad over the club limit (2026-10-24).",
  },
  {
    id: 'club-limit-whynot-incoming-only',
    file: `${ENGINE}/explain.js`,
    find: '    if (clubLimitBreaches(squad, gameState.players, rules.clubLimit, held).length) continue;\n',
    replace: '',
    tests: [T('inherited-club-limit')],
    guards: '"Why not" offers no single swap that keeps four from a club a player moved to (2026-10-24).',
  },
  {
    id: 'club-limit-counterfactual-held-judged',
    file: `${ENGINE}/counterfactual.js`,
    find: 'clubLimitBreaches(ids, ctx.gameState.players, ctx.rules.clubLimit, heldIdsOf(ctx))',
    replace: 'clubLimitBreaches(ids, ctx.gameState.players, ctx.rules.clubLimit)',
    tests: [T('inherited-club-limit')],
    guards: 'Every "why not" answer has the held squad, rolled, as a legal scored baseline even when it is over the limit (2026-10-24).',
  },
  // ---- request pacing on the monotonic clock (2026-10-25). ----
  {
    id: 'probe-pacing-on-wall-clock',
    file: `${APP}/scripts/evidence-probe.mjs`,
    find: '    const wait = lastRequestAt + gapMs - performance.now();\n    if (wait > 0) await sleep(wait);\n    try { return await fetchThroughUpdate(name); } finally { lastRequestAt = performance.now(); }',
    replace: '    const wait = lastRequestAt + gapMs - Date.now();\n    if (wait > 0) await sleep(wait);\n    try { return await fetchThroughUpdate(name); } finally { lastRequestAt = Date.now(); }',
    tests: [T('probe-sample')],
    guards: 'The sample\'s requests to FPL stay a second apart even when the wall clock steps forward (21 ms apart on Date.now(), 2026-10-25).',
  },
  // ---- plan history per team and season (2026-10-25). ----
  {
    id: 'history-memory-any-team',
    file: `${APP}/js/ui/store.js`,
    find: '  const record = memory && memory.key === memoryKey ? memory.record : null;',
    replace: '  const record = memory ? memory.record : null;',
    tests: [T('plan-history-scope')],
    guards: 'A team opened after another in the same session is never compared with the other team\'s plan (found verifying #628, 2026-10-25).',
  },
  {
    id: 'history-memory-any-gameweek',
    file: `${APP}/js/ui/store.js`,
    find: '  if (record && record.plan && record.plan.gw === gw) return record;',
    replace: '  if (record) return record;',
    tests: [T('plan-history-scope')],
    guards: 'A plan for the next gameweek, computed in the same session after a deadline, is never compared with the previous gameweek\'s plan (reviewing #630, 2026-10-25).',
  },
  {
    id: 'history-mislabelled-bucket-trusted',
    file: `${APP}/js/ui/store.js`,
    find: '      if (!scope || scope.key !== key) continue;',
    replace: '      if (!scope) continue;',
    tests: [T('plan-history-scope')],
    guards: 'A stored bucket whose contents claim another team than its key is nobody\'s history (2026-10-25).',
  },
  {
    id: 'history-scopes-uncapped',
    file: `${APP}/js/ui/store.js`,
    find: '    .slice(0, MAX_HISTORY_SCOPES);',
    replace: '    .slice(0);',
    tests: [T('plan-history-scope')],
    guards: 'Synced plan history keeps the most recently used teams only, so it cannot grow with every team opened (2026-10-25).',
  },
  // ---- the inherited club-limit notice (2026-10-25). ----
  {
    id: 'club-notice-for-every-squad',
    file: `${APP}/js/ui/plan-model.js`,
    find: '  if (!breaches.length) return null;',
    replace: '',
    tests: [T('ui-club-limit-notice')],
    guards: 'An ordinary squad, three from a club at most, shows no club-limit notice (2026-10-25).',
  },
  {
    id: 'club-notice-not-shown',
    file: `${APP}/js/ui/plan-model.js`,
    find: "    if (clubLimit) kinds.push('club-limit');",
    replace: '',
    tests: [T('ui-club-limit-notice')],
    guards: 'A squad over the club limit by a club change is told so beside the plan (2026-10-25).',
  },
  {
    id: 'club-sale-note-missing',
    file: `${APP}/js/ui/plan-model.js`,
    find: '  if (!club) return null;',
    replace: '  return null;',
    tests: [T('ui-club-limit-notice')],
    guards: 'A sale the club limit makes necessary carries a note saying so, and no other sale does (2026-10-25).',
  },
  {
    id: 'club-notice-as-warning',
    file: `${APP}/js/ui/dashboard.js`,
    find: "    tone: 'info',\n    mark: 'i',\n    title,\n",
    replace: "    tone: 'warn',\n    mark: '!',\n    title,\n",
    tests: [T('ui-club-limit-notice')],
    guards: 'The notice is information, not a warning: FPL lets the squad stand (2026-10-25).',
  },
  // ---- FPL's update after a deadline (2026-10-24). ----
  {
    id: 'update-window-never',
    file: `${APP}/scripts/lib/probe.mjs`,
    find: 'if (last === null || nowMs - last >= UPDATE_WINDOW_MS) return null;',
    replace: 'return null;',
    tests: [T('probe-freshness'), T('probe-sample'), NT('fpl-health')],
    guards: "A probe that lands in FPL's update after a deadline waits it out (CLI) or defers (Netlify) instead of failing on FPL's maintenance (GW8, 2026-10-23).",
  },
  {
    id: 'update-window-open-ended',
    file: `${APP}/scripts/lib/probe.mjs`,
    find: 'if (last === null || nowMs - last >= UPDATE_WINDOW_MS) return null;',
    replace: 'if (last === null) return null;',
    tests: [T('probe-freshness'), T('probe-sample'), NT('fpl-health')],
    guards: 'The update window closes an hour after the deadline: FPL failing past it is an UPSTREAM failure, and a run then probes normally (2026-10-24).',
  },
  {
    id: 'probe-update-notice-only',
    file: `${APP}/scripts/evidence-probe.mjs`,
    find: "!(err.kind === 'server' || err.kind === 'updating')",
    replace: "!(err.kind === 'updating')",
    tests: [T('probe-sample')],
    guards: "Inside the window a plain 503 is FPL's update too, not only one carrying its notice (2026-10-24).",
  },
  {
    id: 'health-defer-never',
    file: 'netlify/functions/lib/fpl-health-run.mjs',
    find: 'if (updateWindow) return { claimed: false, deferred: true, previous, slot };',
    replace: 'if (false) return { claimed: false, deferred: true, previous, slot };',
    tests: [NT('fpl-health')],
    guards: "The Netlify run inside FPL's update leaves its slot to the next hour rather than failing on it (GW10's 18:30 deadline vs the 18:41 run, 2026-10-24).",
  },
  {
    id: 'health-deferral-not-alive',
    file: 'netlify/functions/lib/fpl-health-run.mjs',
    find: 'return Number.isFinite(d) && !(d <= at) ? d : at;',
    replace: 'return at;',
    tests: [NT('fpl-health')],
    guards: 'A deferral counts as the scheduler running, so the hour it adds never reads as a stopped scheduler on the status endpoint (2026-10-24).',
  },
  {
    id: 'monitor-deferral-not-alive',
    file: `${APP}/scripts/health-monitor.mjs`,
    find: 'const runAt = Number.isFinite(deferredMs) && deferredMs > Date.parse(latest.at) ? deferredMs : Date.parse(latest.at);',
    replace: 'const runAt = Date.parse(latest.at);',
    tests: [NT('fpl-health')],
    guards: 'The monitor judges staleness on the same clock as the status endpoint, deferral included (2026-10-24).',
  },
];

// Count non-overlapping occurrences: the `find` must be unique, or the mutant
// is ambiguous and a refactor could make it mutate the wrong place.
export function occurrences(text, needle) {
  if (!needle) return 0;
  let n = 0;
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + needle.length)) n++;
  return n;
}

function parseArgs(argv) {
  const out = { list: false, only: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') out.list = true;
    else if (a === '--only') out.only = String(argv[++i] || '').split(',').filter(Boolean);
    else if (a.startsWith('--only=')) out.only = a.slice(7).split(',').filter(Boolean);
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

function copyInto(dest) {
  for (const entry of COPY_PATHS) {
    const src = path.join(REPO_ROOT, entry.path);
    const dst = path.join(dest, entry.path);
    const skip = new Set(entry.skip || []);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.cpSync(src, dst, {
      recursive: true,
      // Skip only the named directories directly under the copied root; a
      // nested folder that happens to share a name is real content.
      filter: (from) => !skip.has(path.relative(src, from)),
    });
    for (const name of entry.link || []) {
      const target = path.join(src, name);
      if (fs.existsSync(target)) fs.symlinkSync(target, path.join(dst, name), 'dir');
    }
  }
}

// Clone one copy into another, re-creating the node_modules links rather than
// copying through them.
function cloneCopy(from, to) {
  fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true });
}

function run(cmd, args, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_OPTIONS: '' } });
    let output = '';
    const keep = (d) => { output = (output + d).slice(-20000); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, timedOut, output }); });
  });
}

// A mutant that loops forever is a kill (the tests did not pass), but it must
// not hold the run hostage. Ten minutes is far above the slowest mapped file.
const RUN_TIMEOUT_MS = 10 * 60 * 1000;

async function runMutant(m, copy) {
  const abs = path.join(copy, m.file);
  const original = fs.readFileSync(abs, 'utf8');
  const count = occurrences(original, m.find);
  if (count !== 1) return { status: 'MISSING', detail: `find occurs ${count} times in ${m.file}` };
  fs.writeFileSync(abs, original.replace(m.find, () => m.replace));
  const started = Date.now();
  try {
    const check = await run(process.execPath, ['--check', abs], copy, 60000);
    if (check.code !== 0) return { status: 'INVALID', detail: check.output.trim().split('\n').slice(0, 4).join(' | ') };
    const res = await run(process.execPath, ['--test', ...m.tests], copy, RUN_TIMEOUT_MS);
    const seconds = (Date.now() - started) / 1000;
    if (res.timedOut) return { status: 'KILLED', detail: 'timeout', seconds };
    return res.code === 0 ? { status: 'SURVIVED', detail: '', seconds } : { status: 'KILLED', detail: '', seconds };
  } finally {
    fs.writeFileSync(abs, original);
  }
}

function printTable(rows) {
  const head = ['id', 'status', 'secs', 'file', 'tests'];
  const lines = rows.map(r => [r.id, r.status + (r.detail ? ` (${r.detail})` : ''), r.seconds === undefined ? '-' : r.seconds.toFixed(1), r.file.replace(`${APP}/`, ''), r.tests.map(t => path.basename(t)).join(' ')]);
  const widths = head.map((h, i) => Math.max(h.length, ...lines.map(l => String(l[i]).length)));
  const fmt = (l) => l.map((c, i) => String(c).padEnd(widths[i])).join('  ').trimEnd();
  console.log(fmt(head));
  console.log(widths.map(w => '-'.repeat(w)).join('  '));
  for (const l of lines) console.log(fmt(l));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let mutants = MUTANTS;
  if (args.only) {
    const unknown = args.only.filter(id => !MUTANTS.some(m => m.id === id));
    if (unknown.length) throw new Error(`unknown mutant id(s): ${unknown.join(', ')}`);
    mutants = MUTANTS.filter(m => args.only.includes(m.id));
  }
  if (args.list) {
    for (const m of mutants) console.log(`${m.id}\n  file:   ${m.file}\n  tests:  ${m.tests.join(' ')}\n  guards: ${m.guards}`);
    return 0;
  }

  const t0 = Date.now();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'fpl-mutation-'));
  try {
    const base = path.join(work, 'base');
    copyInto(base);
    // Each mapped test file is itself one process; half the cores keeps the
    // slow optimiser files from starving each other on a laptop and still
    // runs every mutant at once on a 4-core CI runner's worth of work.
    const workers = Math.max(1, Math.min(mutants.length, Math.floor(os.availableParallelism() / 2) || 1));
    const copies = [];
    for (let i = 0; i < workers; i++) {
      const c = path.join(work, `w${i}`);
      cloneCopy(base, c);
      copies.push(c);
    }
    console.log(`mutation-check: ${mutants.length} mutant(s), ${workers} worker(s), working copy ${work}`);

    // The baseline runs on the pristine copy alongside the mutants: every
    // mapped test file must pass unmutated, or a "kill" proves nothing.
    const baselineFiles = [...new Set(mutants.flatMap(m => m.tests))];
    const baseline = run(process.execPath, ['--test', ...baselineFiles], base, RUN_TIMEOUT_MS);

    const results = new Map();
    let next = 0;
    await Promise.all(copies.map(async (copy) => {
      while (next < mutants.length) {
        const m = mutants[next++];
        const r = await runMutant(m, copy);
        results.set(m.id, r);
        console.log(`  ${m.id}: ${r.status}${r.detail ? ` (${r.detail})` : ''}`);
      }
    }));
    const base0 = await baseline;

    const rows = mutants.map(m => ({ ...m, ...results.get(m.id) }));
    console.log('');
    printTable(rows);
    const bad = rows.filter(r => r.status !== 'KILLED');
    const killed = rows.length - bad.length;
    console.log(`\n${killed}/${rows.length} killed in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    if (base0.code !== 0) {
      console.log(`\nBASELINE RED: the mapped tests fail on the UNMUTATED copy, so no kill above means anything.\n${base0.output.slice(-4000)}`);
    }
    for (const r of bad) console.log(`\n${r.status}: ${r.id}\n  ${r.guards}\n  ${r.file}\n  tests: ${r.tests.join(' ')}`);
    return bad.length || base0.code !== 0 ? 1 : 0;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then((code) => { process.exitCode = code; }, (err) => { console.error(err); process.exitCode = 1; });
}
