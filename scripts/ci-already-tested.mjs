#!/usr/bin/env node
// Has this exact tree already passed CI on its pull request?
//
//   node scripts/ci-already-tested.mjs        (in .github/workflows/ci.yml)
//
// WHY THIS EXISTS
// ---------------
// Every merge to master used to run the whole pull-request estate a second
// time: unit tests, lint, four browser shards and the Arena emulator suites,
// about 64 runner-minutes, on a tree that had gone green minutes earlier. The
// old guard compared `HEAD^{tree}` with `HEAD^2^{tree}`, which only works for
// a MERGE commit. This repository squash-merges, and a squash commit has one
// parent, so the guard answered "not a merge commit" and re-ran everything on
// every human pull request. Worse, a flake in that duplicate run marked master
// red for a change that had already passed.
//
// WHAT MAKES SKIPPING SAFE
// ------------------------
// Branch protection on master is STRICT: a pull request can only merge when it
// is up to date with master. An up-to-date head already contains master, so
// the pull-request run's merge ref has the same tree as the head, and so does
// the squash (or merge) commit the merge produces. If the pushed tree equals
// the head's tree AND the latest pull-request run of this workflow on that
// head succeeded, the push would test bit-for-bit what already passed.
//
// Anything else runs: a push that is not a pull request's merge commit, a
// tree that differs (an admin merge of a stale branch), a head whose latest
// run did not pass, and every API failure. The worst case of a wrong "run" is
// a duplicate run; the worst case of a wrong "skip" is an untested master, so
// uncertainty always resolves to "run".
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createApi } from './bot-pr-autopilot.mjs';

export const CI_WORKFLOW_PATH = '.github/workflows/ci.yml';

const runIt = (reason) => ({ run: true, reason });

export async function decide({ api, event, sha, workflowPath = CI_WORKFLOW_PATH }) {
  if (event !== 'push') {
    return runIt(`event is ${event || 'unknown'}; only a push to master can repeat a pull request's run`);
  }
  if (!/^[0-9a-f]{40}$/.test(String(sha || ''))) return runIt(`no usable commit sha (${sha})`);

  let pulls;
  try {
    pulls = await api.request('GET', `/repos/${api.repo}/commits/${sha}/pulls`);
  } catch (err) {
    return runIt(`could not list the pull requests for ${sha}: ${err.message}`);
  }
  const pr = (Array.isArray(pulls) ? pulls : []).find((p) => p && p.merged_at && p.merge_commit_sha === sha);
  if (!pr) return runIt(`${sha} is not the merge commit of a pull request`);
  const headSha = pr.head && pr.head.sha;
  if (!headSha) return runIt(`#${pr.number} carries no head sha`);

  let pushedTree;
  let headTree;
  try {
    const [pushed, head] = await Promise.all([sha, headSha].map((c) => api.request('GET', `/repos/${api.repo}/git/commits/${c}`)));
    pushedTree = pushed && pushed.tree && pushed.tree.sha;
    headTree = head && head.tree && head.tree.sha;
  } catch (err) {
    return runIt(`could not read the trees of ${sha} and ${headSha}: ${err.message}`);
  }
  if (!pushedTree || pushedTree !== headTree) {
    return runIt(`#${pr.number} merged as tree ${pushedTree}, but its head ${headSha} is tree ${headTree}: `
      + 'the merge produced a combination no pull-request run tested');
  }

  let runs;
  try {
    const page = await api.request('GET',
      `/repos/${api.repo}/actions/runs?head_sha=${headSha}&event=pull_request&per_page=100`);
    runs = (page && page.workflow_runs) || [];
  } catch (err) {
    return runIt(`could not list the runs on ${headSha}: ${err.message}`);
  }
  const ours = runs
    .filter((r) => r && (r.path === workflowPath || String(r.path || '').startsWith(`${workflowPath}@`)))
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id);
  const latest = ours[0];
  if (!latest) return runIt(`no pull-request run of ${workflowPath} exists on #${pr.number}'s head ${headSha}`);
  if (latest.status !== 'completed' || latest.conclusion !== 'success') {
    return runIt(`the latest pull-request run on #${pr.number}'s head (run ${latest.id}) is `
      + `${latest.status}/${latest.conclusion}, not a pass`);
  }
  return {
    run: false,
    reason: `#${pr.number} merged tree ${pushedTree}, identical to its head ${headSha}, and pull-request `
      + `run ${latest.id} passed on it${latest.html_url ? ` (${latest.html_url})` : ''}`,
  };
}

export async function main({ env = process.env, fetchImpl, log = console.log } = {}) {
  let result;
  try {
    const api = createApi({ token: env.GITHUB_TOKEN, repo: env.GITHUB_REPOSITORY, fetchImpl });
    result = await decide({ api, event: env.GITHUB_EVENT_NAME, sha: env.GITHUB_SHA });
  } catch (err) {
    result = runIt(`the check itself failed: ${err.message}`);
  }
  log(`${result.run ? 'RUN' : 'SKIP'}: ${result.reason}`);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `run=${result.run}\n`);
  if (env.GITHUB_STEP_SUMMARY) {
    appendFileSync(env.GITHUB_STEP_SUMMARY,
      `### Already tested?\n\n**${result.run ? 'Running the suites' : 'Skipping the suites'}**: ${result.reason}\n`);
  }
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  await main();
}
