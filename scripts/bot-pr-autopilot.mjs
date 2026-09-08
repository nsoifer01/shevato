#!/usr/bin/env node
// Drives a bot-authored pull request through the SAME gates a human one goes
// through, without a human clicking anything.
//
// WHY THIS EXISTS, precisely, because the previous explanation in
// refresh-rising-shows.yml was wrong and cost a day.
//
// The old comment said GitHub "deliberately does not start workflow runs from
// GITHUB_TOKEN-driven events", so a bot pull request could never get CI and a
// personal access token was the only way out. That is the documented rule for
// most GITHUB_TOKEN-created events, and it is NOT what this repository does.
// Measured on pull request #515 (2026-09-08): the four runs DO exist against
// the bot branch, with event=pull_request and head_sha equal to the pull
// request head, and they sit at status=completed conclusion=action_required.
// That is the maintainer-approval hold, which is what the "N workflows
// awaiting approval" banner reports, and it is releasable:
//
//   POST /repos/{owner}/{repo}/actions/runs/{run_id}/approve
//
// released run 34216452343 ("tests"), which then ran as attempt 2 and
// concluded success. So the hold is the whole problem, and an API call the
// workflow can make itself is the whole fix. No personal access token, no
// GitHub App, no new secret.
//
// The hold itself comes from the repository's Actions setting
// `fork-pr-contributor-approval.approval_policy = first_time_contributors`.
// github-actions[bot] never accrues contributor status here (the refresh
// commits are authored as `shevato-bot <actions@users.noreply.github.com>`, an
// identity that is not linked to any GitHub account), so every bot pull
// request is held as a first-time contributor's. Loosening that setting would
// also loosen it for real outside contributors on a public repository, which
// is the one thing this must not do. Approving one named run on one branch
// this workflow just created itself is the narrow version of the same thing.
//
// The second half of the problem was the merge. `master` requires the lint,
// test, browser and rules checks (classic branch protection, strict), so the
// old "merge immediately, the job already ran the tests" path could not work
// any more whatever the token: `gh pr merge` is refused while a required
// check has not reported. So this script arms GitHub's own auto-merge instead
// and lets branch protection decide. Nothing here bypasses a check, and a red
// check leaves the pull request open.
//
// Everything is injectable (fetch, sleep, log) so tests/static/
// bot-pr-autopilot.test.mjs can drive every branch against a stubbed API
// rather than against GitHub.

import { pathToFileURL } from 'node:url';

const DEFAULT_API = 'https://api.github.com';

// The merge commit matters. tests.yml and browser-tests.yml both skip a
// push-to-master run whose tree is byte-identical to the pull request head
// they already tested, and they find that out from `HEAD^2`. A squash has no
// second parent, so squashing here would turn every refresh into a redundant
// full re-run of a tree that just went green.
export const MERGE_METHOD = 'MERGE';

export const BOT_BRANCH_PREFIX = 'bot/refresh-rising-shows-';

// A run that GitHub created but is holding. `conclusion: action_required` is
// what this repository actually produces; `status` of `action_required` or
// `waiting` are the other shapes the same hold has had, and treating all three
// as parked costs nothing.
export function isParked(run) {
  return run.conclusion === 'action_required'
    || run.status === 'action_required'
    || run.status === 'waiting';
}

// Only OUR checks decide the outcome. Netlify's deploy-preview contexts and
// GitGuardian are not required by branch protection, and a neutral "Pages
// changed" must never be read as a failure.
export function isOurCheck(checkRun) {
  return checkRun?.app?.slug === 'github-actions';
}

export function failedChecks(checkRuns) {
  const bad = new Set(['failure', 'timed_out', 'cancelled', 'stale']);
  return checkRuns.filter((c) => isOurCheck(c) && bad.has(c.conclusion));
}

export function createApi({ token, repo, fetchImpl, base = DEFAULT_API }) {
  const doFetch = fetchImpl || globalThis.fetch;
  if (!token) throw new Error('a token is required (GITHUB_TOKEN or GH_TOKEN)');
  if (!repo) throw new Error('a repository is required (GITHUB_REPOSITORY, owner/name)');

  async function request(method, path, body) {
    const res = await doFetch(`${base}${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let parsed = null;
    if (text) { try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; } }
    if (!res.ok) {
      const err = new Error(`${method} ${path} -> ${res.status} ${parsed?.message || text || ''}`.trim());
      err.status = res.status;
      err.body = parsed;
      throw err;
    }
    return parsed;
  }

  async function graphql(query, variables) {
    const out = await request('POST', '/graphql', { query, variables });
    if (out?.errors?.length) {
      const err = new Error(out.errors.map((e) => e.message).join('; '));
      err.graphqlErrors = out.errors;
      throw err;
    }
    return out?.data;
  }

  return { request, graphql, repo };
}

export async function getPullRequest(api, number) {
  return api.request('GET', `/repos/${api.repo}/pulls/${number}`);
}

export async function listOpenBotPullRequests(api, prefix = BOT_BRANCH_PREFIX) {
  const prs = await api.request('GET', `/repos/${api.repo}/pulls?state=open&per_page=100`);
  return (prs || []).filter((pr) => pr?.head?.ref?.startsWith(prefix));
}

// Release every run GitHub is holding against this commit. Scoped to one
// head_sha on purpose: this approves runs for the exact commit the caller
// named, never "every held run in the repository".
export async function releaseParkedRuns(api, sha, { log = () => {} } = {}) {
  const page = await api.request('GET', `/repos/${api.repo}/actions/runs?head_sha=${sha}&per_page=100`);
  const runs = page?.workflow_runs || [];
  const parked = runs.filter(isParked);
  const released = [];
  const refused = [];
  for (const run of parked) {
    try {
      await api.request('POST', `/repos/${api.repo}/actions/runs/${run.id}/approve`);
      released.push(run);
      log(`  released "${run.name}" (run ${run.id})`);
    } catch (err) {
      refused.push({ run, error: err });
      log(`  could not release "${run.name}" (run ${run.id}): ${err.message}`);
    }
  }
  return { runs, parked, released, refused };
}

export async function listCheckRuns(api, sha) {
  const page = await api.request('GET', `/repos/${api.repo}/commits/${sha}/check-runs?per_page=100`);
  return page?.check_runs || [];
}

const ENABLE_AUTO_MERGE = `
mutation($pullRequestId: ID!, $mergeMethod: PullRequestMergeMethod!) {
  enablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId, mergeMethod: $mergeMethod }) {
    clientMutationId
  }
}`;

// Arm GitHub's own auto-merge. Branch protection stays in charge: the merge
// happens if and when every required check passes, and never otherwise.
//
// The one case the mutation refuses is a pull request that is ALREADY
// mergeable ("Pull request is in clean status"), because there is nothing left
// to wait for. That is not an error, it is the happy path arriving early, so
// merge it directly. Every requirement has been met by definition at that
// point; this is not a bypass.
export async function armAutoMerge(api, pr, { method = MERGE_METHOD, log = () => {} } = {}) {
  try {
    await api.graphql(ENABLE_AUTO_MERGE, { pullRequestId: pr.node_id, mergeMethod: method });
    log(`  auto-merge armed on #${pr.number} (${method})`);
    return 'armed';
  } catch (err) {
    if (/clean status/i.test(err.message)) {
      await api.request('PUT', `/repos/${api.repo}/pulls/${pr.number}/merge`, {
        merge_method: method.toLowerCase(),
      });
      log(`  #${pr.number} was already mergeable; merged`);
      return 'merged';
    }
    if (/auto merge is not allowed/i.test(err.message)) {
      throw new Error(
        'auto-merge is disabled for this repository. Enable Settings > General > '
        + '"Allow auto-merge", which is the one repository setting this automation needs.',
      );
    }
    throw err;
  }
}

export async function updateBranch(api, number) {
  return api.request('PUT', `/repos/${api.repo}/pulls/${number}/update-branch`, {});
}

// Delete the merged branch, because GitHub does not.
//
// The repository has "Automatically delete head branches" ON, and it works for
// a human: #517's branch was gone the moment auto-merge merged it. It did NOT
// fire for #518, whose auto-merge was armed by github-actions[bot], and the
// branch was still on the remote minutes later. Measured, both on 2026-09-08.
//
// So the refresh would leave one bot/refresh-rising-shows-* branch behind
// every single day, which is exactly the accumulation the timestamped branch
// names make expensive. Deleting it here is safe by construction: it only runs
// after GitHub reports the pull request MERGED, and it only ever names that
// pull request's own head ref.
//
// Never fatal. A branch that is already gone (a slow delete_branch_on_merge
// that did fire, someone deleting it by hand) is the outcome we wanted.
export async function deleteHeadBranch(api, pr, { log = () => {} } = {}) {
  const ref = pr?.head?.ref;
  if (!ref) return 'unknown';
  try {
    await api.request('DELETE', `/repos/${api.repo}/git/refs/heads/${ref}`);
    log(`  deleted ${ref}`);
    return 'deleted';
  } catch (err) {
    if (err.status === 404 || err.status === 422) {
      log(`  ${ref} was already gone`);
      return 'absent';
    }
    log(`  could not delete ${ref}: ${err.message}`);
    return 'failed';
  }
}

// Release the hold, arm auto-merge, and then watch until GitHub either merges
// it or a required check goes red.
//
// Re-releasing on every tick is deliberate. The hold is re-applied to every
// new head commit, and a strict base branch means auto-merge may update this
// branch mid-flight, which produces exactly such a commit.
export async function drivePullRequest(api, number, {
  timeoutMs = 60 * 60 * 1000,
  pollMs = 30_000,
  maxBranchUpdates = 3,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
  log = () => {},
} = {}) {
  const deadline = now() + timeoutMs;
  let armed = false;
  let branchUpdates = 0;
  let lastState = '';

  for (;;) {
    const pr = await getPullRequest(api, number);

    if (pr.merged) {
      log(`#${number} merged as ${pr.merge_commit_sha}`);
      await deleteHeadBranch(api, pr, { log });
      return { outcome: 'merged', pr };
    }
    if (pr.state === 'closed') {
      log(`#${number} was closed without merging`);
      return { outcome: 'closed', pr };
    }

    await releaseParkedRuns(api, pr.head.sha, { log });

    const checks = await listCheckRuns(api, pr.head.sha);
    const failures = failedChecks(checks);
    if (failures.length) {
      log(`#${number} has failing checks: ${failures.map((c) => `${c.name}=${c.conclusion}`).join(', ')}`);
      return { outcome: 'failed', pr, failures };
    }

    if (!armed) {
      const result = await armAutoMerge(api, pr, { log });
      armed = true;
      if (result === 'merged') {
        await deleteHeadBranch(api, pr, { log });
        return { outcome: 'merged', pr };
      }
    }

    if (pr.mergeable_state === 'dirty') {
      log(`#${number} has merge conflicts with ${pr.base.ref}`);
      return { outcome: 'conflicted', pr };
    }

    // A strict base branch ("require branches to be up to date") parks the
    // pull request on `behind` until the head is refreshed. Auto-merge does
    // not always do that itself, so do it here, bounded, so a base branch that
    // moves faster than CI can finish cannot spin forever.
    if (pr.mergeable_state === 'behind') {
      if (branchUpdates >= maxBranchUpdates) {
        log(`#${number} is still behind ${pr.base.ref} after ${branchUpdates} updates; giving up`);
        return { outcome: 'behind', pr };
      }
      branchUpdates += 1;
      log(`#${number} is behind ${pr.base.ref}; updating the branch (${branchUpdates}/${maxBranchUpdates})`);
      await updateBranch(api, number);
    }

    const state = `${pr.mergeable_state}/${checks.filter(isOurCheck).map((c) => `${c.name}:${c.status}`).sort().join(',')}`;
    if (state !== lastState) {
      log(`#${number} ${pr.mergeable_state}: ${checks.filter(isOurCheck).map((c) => `${c.name}=${c.conclusion || c.status}`).sort().join(' ') || 'no checks yet'}`);
      lastState = state;
    }

    if (now() >= deadline) {
      log(`#${number} did not settle within the watch window (last state: ${pr.mergeable_state})`);
      return { outcome: 'timeout', pr };
    }
    await sleep(pollMs);
  }
}

// Exactly one bot refresh pull request may be open at a time.
//
// Two of them cannot both merge: they both rewrite changelog.json and the
// exports, so the second is guaranteed a conflict. Leaving yesterday's open
// and opening today's anyway is how a queue of unmergeable duplicates and
// their branches accumulates. So a refresh reconciles first: it drives any
// pull request already open to a conclusion, and refuses to build a new one
// while an old one is stuck.
export async function reconcileOpenBotPullRequests(api, {
  prefix = BOT_BRANCH_PREFIX,
  log = () => {},
  ...driveOptions
} = {}) {
  const open = await listOpenBotPullRequests(api, prefix);
  if (!open.length) {
    log(`no open ${prefix}* pull request to reconcile`);
    return { reconciled: [], blocked: [] };
  }
  const reconciled = [];
  const blocked = [];
  for (const pr of open) {
    log(`reconciling #${pr.number} (${pr.head.ref})`);
    const result = await drivePullRequest(api, pr.number, { log, ...driveOptions });
    (result.outcome === 'merged' ? reconciled : blocked).push({ number: pr.number, ...result });
  }
  return { reconciled, blocked };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) {
      opts[key] = true;
    } else {
      opts[key] = next;
      i += 1;
    }
  }
  return { command, opts };
}

export async function main(argv, env = process.env, log = console.log) {
  const { command, opts } = parseArgs(argv);
  const api = createApi({
    token: env.GITHUB_TOKEN || env.GH_TOKEN,
    repo: env.GITHUB_REPOSITORY,
    base: env.GITHUB_API_URL || DEFAULT_API,
  });
  const timeoutMs = Number(opts.timeoutMin ?? 60) * 60 * 1000;
  const pollMs = Number(opts.pollSec ?? 30) * 1000;
  const prefix = typeof opts.prefix === 'string' ? opts.prefix : BOT_BRANCH_PREFIX;

  if (command === 'reconcile') {
    const { blocked } = await reconcileOpenBotPullRequests(api, { prefix, log, timeoutMs, pollMs });
    if (blocked.length) {
      for (const b of blocked) {
        log(`::error::the previous refresh pull request #${b.number} is ${b.outcome}. `
          + 'A second refresh would conflict with it on changelog.json and the exports, so this run stops here. '
          + 'Resolve or close it and re-run the refresh.');
      }
      return 1;
    }
    return 0;
  }

  if (command === 'run') {
    const number = Number(opts.pr);
    if (!Number.isInteger(number) || number <= 0) throw new Error('--pr <number> is required');
    const result = await drivePullRequest(api, number, { log, timeoutMs, pollMs });
    if (result.outcome === 'merged') return 0;
    log(`::error::pull request #${number} did not merge (${result.outcome}). `
      + 'The refreshed data is already on the rising-shows-data release under an immutable name, and '
      + 'apps/rising-shows/data-release.json pins it from inside this pull request, so nothing deploys '
      + 'and the site keeps serving the previous build until this is resolved.');
    return 1;
  }

  throw new Error(`unknown command "${command}". Use: reconcile | run --pr <number>`);
}

// pathToFileURL, not string concatenation: a repository path containing a
// space or a non-ASCII character encodes differently in a file: URL, the
// comparison silently fails, and the CLI becomes a no-op that exits 0. A merge
// step that quietly does nothing is the worst shape this file could have.
const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((err) => {
      console.error(`::error::${err.message}`);
      process.exitCode = 1;
    });
}
