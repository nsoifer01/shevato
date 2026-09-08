// The bot pull request autopilot, tested against a stubbed GitHub API.
//
// This script is the only thing standing between "the daily Rising Shows
// refresh merges itself" and "somebody clicks Approve workflows to run every
// morning", and every one of its decisions is a decision about whether
// unreviewed data reaches the live site. The two that matter most cannot be
// exercised by running it for real without either breaking master or waiting
// for a red build to happen naturally:
//
//   - a failing required check must leave the pull request OPEN, and
//   - a second refresh must never open while the first is still unmerged,
//     because both rewrite changelog.json and the exports.
//
// So the whole API surface is stubbed here: fetch, the clock and sleep are all
// injected, and the assertions are about the requests the script makes, not
// about its log output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createApi, isParked, isOurCheck, failedChecks, releaseParkedRuns, armAutoMerge,
  drivePullRequest, reconcileOpenBotPullRequests, listOpenBotPullRequests, main, deleteHeadBranch,
  MERGE_METHOD, BOT_BRANCH_PREFIX,
} from '../../scripts/bot-pr-autopilot.mjs';

const REPO = 'nsoifer01/shevato';

// A fetch stub that records every call and answers from a handler table.
// `handler` receives { method, path, body } and returns a value (200), or
// { status, body } for anything else.
function stubApi(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const method = init.method || 'GET';
    const path = String(url).replace('https://api.github.com', '');
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    const answer = await handler({ method, path, body });
    const { status = 200, body: payload = {} } = (answer && answer.status) ? answer : { body: answer ?? {} };
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (payload === undefined ? '' : JSON.stringify(payload)),
    };
  };
  return { api: createApi({ token: 't', repo: REPO, fetchImpl }), calls };
}

const run = (over = {}) => ({ id: 1, name: 'tests', status: 'completed', conclusion: 'action_required', ...over });
const check = (over = {}) => ({ name: 'test', status: 'completed', conclusion: 'success', app: { slug: 'github-actions' }, ...over });
const pull = (over = {}) => ({
  number: 515,
  node_id: 'PR_node',
  state: 'open',
  merged: false,
  mergeable_state: 'blocked',
  head: { sha: 'sha1', ref: `${BOT_BRANCH_PREFIX}20260908-103736` },
  base: { ref: 'master' },
  ...over,
});

test('a held run is recognised in every shape GitHub has used for the hold', () => {
  assert.equal(isParked({ status: 'completed', conclusion: 'action_required' }), true);
  assert.equal(isParked({ status: 'action_required', conclusion: null }), true);
  assert.equal(isParked({ status: 'waiting', conclusion: null }), true);
  assert.equal(isParked({ status: 'completed', conclusion: 'success' }), false);
  assert.equal(isParked({ status: 'in_progress', conclusion: null }), false);
});

test('only our own check runs are allowed to decide the outcome', () => {
  // Netlify reports "Pages changed" as NEUTRAL on every pull request and
  // GitGuardian is not a required context. Reading either as a verdict would
  // either fail every refresh or merge one that should not have merged.
  assert.equal(isOurCheck(check()), true);
  assert.equal(isOurCheck(check({ app: { slug: 'netlify' } })), false);
  assert.deepEqual(failedChecks([
    check({ name: 'Pages changed - shevato', app: { slug: 'netlify' }, conclusion: 'neutral' }),
    check({ name: 'GitGuardian Security Checks', app: { slug: 'gitguardian' }, conclusion: 'failure' }),
    check({ name: 'coverage', conclusion: 'skipped' }),
    check({ name: 'test', conclusion: 'success' }),
  ]), []);
  assert.deepEqual(
    failedChecks([check({ name: 'browser', conclusion: 'failure' })]).map((c) => c.name),
    ['browser'],
  );
});

test('every held run for the named commit is released, and nothing else is', async () => {
  const { api, calls } = stubApi(({ method, path }) => {
    if (method === 'GET' && path.startsWith(`/repos/${REPO}/actions/runs`)) {
      assert.match(path, /head_sha=sha1/, 'the release is scoped to one commit, never to the whole repo');
      return {
        workflow_runs: [
          run({ id: 11, name: 'tests' }),
          run({ id: 12, name: 'lint' }),
          run({ id: 13, name: 'browser tests', status: 'completed', conclusion: 'success' }),
          run({ id: 14, name: 'arena emulator', status: 'waiting', conclusion: null }),
        ],
      };
    }
    return {};
  });

  const result = await releaseParkedRuns(api, 'sha1');
  assert.deepEqual(result.released.map((r) => r.id), [11, 12, 14]);
  const approvals = calls.filter((c) => c.method === 'POST' && c.path.endsWith('/approve')).map((c) => c.path);
  assert.deepEqual(approvals, [
    `/repos/${REPO}/actions/runs/11/approve`,
    `/repos/${REPO}/actions/runs/12/approve`,
    `/repos/${REPO}/actions/runs/14/approve`,
  ]);
});

test('a refused approval is reported, not thrown, so one run cannot strand the rest', async () => {
  const { api } = stubApi(({ method, path }) => {
    if (method === 'GET' && path.includes('/actions/runs')) {
      return { workflow_runs: [run({ id: 11 }), run({ id: 12 })] };
    }
    if (path.endsWith('/11/approve')) return { status: 403, body: { message: 'Resource not accessible by integration' } };
    return {};
  });

  const result = await releaseParkedRuns(api, 'sha1');
  assert.deepEqual(result.released.map((r) => r.id), [12]);
  assert.equal(result.refused.length, 1);
  assert.match(result.refused[0].error.message, /403/);
});

test('auto-merge is armed through GitHub, with a merge commit', async () => {
  const { api, calls } = stubApi(({ path }) => (path === '/graphql' ? { data: {} } : {}));
  assert.equal(await armAutoMerge(api, pull()), 'armed');
  const mutation = calls.find((c) => c.path === '/graphql');
  assert.match(mutation.body.query, /enablePullRequestAutoMerge/);
  assert.equal(mutation.body.variables.pullRequestId, 'PR_node');
  // A squash would drop the second parent that tests.yml and browser-tests.yml
  // use to skip a redundant push run over an already-tested tree.
  assert.equal(mutation.body.variables.mergeMethod, 'MERGE');
  assert.equal(MERGE_METHOD, 'MERGE');
});

test('an already-mergeable pull request is merged instead of armed', async () => {
  // GitHub refuses to arm auto-merge when there is nothing left to wait for.
  // Every requirement has been met at that point, so merging is the same
  // outcome arriving early, not a bypass.
  const { api, calls } = stubApi(({ path }) => {
    if (path === '/graphql') return { data: null, errors: [{ message: 'Pull request is in clean status' }] };
    return {};
  });
  assert.equal(await armAutoMerge(api, pull()), 'merged');
  const merge = calls.find((c) => c.path === `/repos/${REPO}/pulls/515/merge`);
  assert.equal(merge.method, 'PUT');
  assert.equal(merge.body.merge_method, 'merge');
});

test('a repository without auto-merge enabled produces the setting to change', async () => {
  const { api } = stubApi(({ path }) => {
    if (path === '/graphql') return { data: null, errors: [{ message: 'Auto merge is not allowed for this repository' }] };
    return {};
  });
  await assert.rejects(() => armAutoMerge(api, pull()), /Allow auto-merge/);
});

test('a failing required check leaves the pull request open and reports it', async () => {
  // The whole safety property. `browser` is red, so nothing may merge, and the
  // script must not fall back to any direct-merge path.
  const { api, calls } = stubApi(({ method, path }) => {
    if (path === `/repos/${REPO}/pulls/515`) return pull();
    if (path.includes('/actions/runs')) return { workflow_runs: [] };
    if (path.includes('/check-runs')) {
      return { check_runs: [check({ name: 'test' }), check({ name: 'browser', conclusion: 'failure' })] };
    }
    if (method === 'POST' && path === '/graphql') return { data: {} };
    return {};
  });

  const result = await drivePullRequest(api, 515, { log: () => {} });
  assert.equal(result.outcome, 'failed');
  assert.deepEqual(result.failures.map((f) => f.name), ['browser']);
  assert.equal(calls.some((c) => c.path.endsWith('/merge')), false, 'nothing may be merged past a red check');
  assert.equal(calls.some((c) => c.path === '/graphql'), false, 'and auto-merge is not even armed');
});

test('the hold is released again after auto-merge updates a behind branch', async () => {
  // A strict base branch means auto-merge can push a new head commit, and the
  // approval hold is re-applied to that commit. Releasing only once would
  // leave the pull request parked forever with auto-merge armed.
  const approved = [];
  let tick = 0;
  const { api } = stubApi(({ method, path }) => {
    if (path === `/repos/${REPO}/pulls/515`) {
      if (tick === 0) return pull({ mergeable_state: 'behind', head: { sha: 'sha1', ref: 'bot/x' } });
      if (tick === 1) return pull({ mergeable_state: 'blocked', head: { sha: 'sha2', ref: 'bot/x' } });
      return pull({ merged: true, merge_commit_sha: 'merged', head: { sha: 'sha2', ref: 'bot/x' } });
    }
    if (method === 'POST' && path.endsWith('/approve')) {
      approved.push(Number(/runs\/(\d+)\/approve/.exec(path)[1]));
      return {};
    }
    if (path.includes('/actions/runs')) {
      const sha = /head_sha=([a-z0-9]+)/.exec(path)[1];
      return { workflow_runs: [run({ id: sha === 'sha1' ? 11 : 22 })] };
    }
    if (path.includes('/check-runs')) return { check_runs: [] };
    if (path === '/graphql') return { data: {} };
    return {};
  });

  const result = await drivePullRequest(api, 515, {
    log: () => {},
    sleep: async () => { tick += 1; },
    pollMs: 0,
  });
  assert.equal(result.outcome, 'merged');
  assert.deepEqual(approved, [11, 22], 'the new head commit gets its own release');
});

test('the merged branch is deleted, because GitHub does not delete this one', async () => {
  // "Automatically delete head branches" is ON and it fired for #517, whose
  // auto-merge a human armed. It did not fire for #518, armed by
  // github-actions[bot]: the branch was still on the remote minutes after the
  // merge. Left alone, the refresh strands one timestamped branch a day.
  const { api, calls } = stubApi(({ path }) => {
    if (path === `/repos/${REPO}/pulls/515`) {
      return pull({ merged: true, merge_commit_sha: 'm1', head: { sha: 'sha1', ref: 'bot/refresh-rising-shows-x' } });
    }
    return {};
  });
  const result = await drivePullRequest(api, 515, { log: () => {} });
  assert.equal(result.outcome, 'merged');
  const del = calls.find((c) => c.method === 'DELETE');
  assert.equal(del.path, `/repos/${REPO}/git/refs/heads/bot/refresh-rising-shows-x`);
});

test('a branch that is already gone is not an error', async () => {
  const { api } = stubApi(({ method }) => (method === 'DELETE'
    ? { status: 422, body: { message: 'Reference does not exist' } }
    : {}));
  assert.equal(await deleteHeadBranch(api, pull({ head: { sha: 's', ref: 'bot/x' } })), 'absent');
});

test('the branch is deleted on the already-mergeable path too', async () => {
  // armAutoMerge merges directly when GitHub says the pull request is clean,
  // and that path returns before the watch loop ever sees merged=true.
  let merged = false;
  const { api, calls } = stubApi(({ method, path }) => {
    if (path === `/repos/${REPO}/pulls/515`) {
      return pull({ merged, head: { sha: 'sha1', ref: 'bot/refresh-rising-shows-y' } });
    }
    if (path.includes('/actions/runs')) return { workflow_runs: [] };
    if (path.includes('/check-runs')) return { check_runs: [] };
    if (path === '/graphql') return { data: null, errors: [{ message: 'Pull request is in clean status' }] };
    if (method === 'PUT' && path.endsWith('/merge')) { merged = true; return {}; }
    return {};
  });
  const result = await drivePullRequest(api, 515, { log: () => {} });
  assert.equal(result.outcome, 'merged');
  assert.deepEqual(
    calls.filter((c) => c.method === 'DELETE').map((c) => c.path),
    [`/repos/${REPO}/git/refs/heads/bot/refresh-rising-shows-y`],
  );
});

test('a base branch that keeps moving cannot spin the watcher forever', async () => {
  let updates = 0;
  const { api } = stubApi(({ method, path }) => {
    if (path === `/repos/${REPO}/pulls/515`) return pull({ mergeable_state: 'behind' });
    if (path.includes('/actions/runs')) return { workflow_runs: [] };
    if (path.includes('/check-runs')) return { check_runs: [] };
    if (path === '/graphql') return { data: {} };
    if (method === 'PUT' && path.endsWith('/update-branch')) { updates += 1; return {}; }
    return {};
  });

  const result = await drivePullRequest(api, 515, { log: () => {}, sleep: async () => {}, pollMs: 0 });
  assert.equal(result.outcome, 'behind');
  assert.equal(updates, 3, 'bounded by maxBranchUpdates');
});

test('the watch gives up rather than hanging when nothing ever settles', async () => {
  let clock = 0;
  const { api } = stubApi(({ path }) => {
    if (path === `/repos/${REPO}/pulls/515`) return pull();
    if (path.includes('/actions/runs')) return { workflow_runs: [] };
    if (path.includes('/check-runs')) return { check_runs: [] };
    if (path === '/graphql') return { data: {} };
    return {};
  });
  const result = await drivePullRequest(api, 515, {
    log: () => {},
    now: () => clock,
    sleep: async () => { clock += 30_000; },
    timeoutMs: 60_000,
    pollMs: 0,
  });
  assert.equal(result.outcome, 'timeout');
});

test('only bot refresh branches are picked up by the reconciler', async () => {
  const { api } = stubApi(({ path }) => {
    if (path.startsWith(`/repos/${REPO}/pulls?state=open`)) {
      return [
        { number: 505, head: { ref: 'worktree-fpl-planner-logo-match' } },
        { number: 512, head: { ref: 'fix/arena-globe-ready-flake' } },
        { number: 515, head: { ref: `${BOT_BRANCH_PREFIX}20260908-103736` } },
      ];
    }
    return {};
  });
  const found = await listOpenBotPullRequests(api);
  assert.deepEqual(found.map((p) => p.number), [515], 'a human pull request is never touched');
});

test('a stuck previous refresh blocks the next one instead of duplicating it', async () => {
  // Two open refresh pull requests both rewrite changelog.json and the
  // exports, so the second can only ever conflict. Stopping is the outcome
  // that leaves one thing to fix rather than a growing queue of branches.
  const { api } = stubApi(({ path }) => {
    if (path.startsWith(`/repos/${REPO}/pulls?state=open`)) {
      return [{ number: 515, head: { ref: `${BOT_BRANCH_PREFIX}20260908-103736` } }];
    }
    if (path === `/repos/${REPO}/pulls/515`) return pull();
    if (path.includes('/actions/runs')) return { workflow_runs: [] };
    if (path.includes('/check-runs')) return { check_runs: [check({ name: 'lint', conclusion: 'failure' })] };
    return {};
  });

  const result = await reconcileOpenBotPullRequests(api, { log: () => {} });
  assert.deepEqual(result.reconciled, []);
  assert.deepEqual(result.blocked.map((b) => [b.number, b.outcome]), [[515, 'failed']]);
});

test('reconcile is a no-op, and cheap, on the ordinary day with nothing open', async () => {
  const { api, calls } = stubApi(({ path }) => (path.startsWith(`/repos/${REPO}/pulls?state=open`) ? [] : {}));
  const result = await reconcileOpenBotPullRequests(api, { log: () => {} });
  assert.deepEqual(result, { reconciled: [], blocked: [] });
  assert.equal(calls.length, 1);
});

test('the refresh consequence is only claimed for a refresh pull request', async () => {
  // `run --pr N` drives ANY pull request - bot-pr-autopilot.yml exists so a
  // human can point it at one - so the "nothing deploys, the site serves the
  // previous build" sentence must not be printed for somebody else's branch.
  const env = { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: REPO };
  const original = globalThis.fetch;
  const runFor = async (ref) => {
    const lines = [];
    globalThis.fetch = async (url) => {
      const path = String(url).replace('https://api.github.com', '');
      const answer = (() => {
        if (path === `/repos/${REPO}/pulls/505`) return pull({ number: 505, head: { sha: 's', ref } });
        if (path.includes('/actions/runs')) return { workflow_runs: [] };
        if (path.includes('/check-runs')) return { check_runs: [check({ name: 'rules', conclusion: 'failure' })] };
        return {};
      })();
      return { ok: true, status: 200, text: async () => JSON.stringify(answer) };
    };
    const code = await main(['run', '--pr', '505'], env, (l) => lines.push(l));
    return { code, log: lines.join('\n') };
  };
  try {
    const human = await runFor('worktree-fpl-planner-logo-match');
    assert.equal(human.code, 1);
    assert.match(human.log, /did not merge \(failed\)/);
    assert.equal(/rising-shows-data release/.test(human.log), false,
      'a human pull request must not be told a Rising Shows deploy is blocked');

    const bot = await runFor(`${BOT_BRANCH_PREFIX}20260908-103736`);
    assert.equal(bot.code, 1);
    assert.match(bot.log, /rising-shows-data release/);
  } finally {
    globalThis.fetch = original;
  }
});

test('the CLI exit code is what the workflow step actually gates on', async () => {
  const env = { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: REPO };
  const openPrs = [{ number: 515, head: { ref: `${BOT_BRANCH_PREFIX}20260908-103736` } }];

  // A blocked previous refresh must fail the step.
  let phase = 'blocked';
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace('https://api.github.com', '');
    const answer = (() => {
      if (path.startsWith(`/repos/${REPO}/pulls?state=open`)) return phase === 'blocked' ? openPrs : [];
      if (path === `/repos/${REPO}/pulls/515`) return pull();
      if (path.includes('/actions/runs')) return { workflow_runs: [] };
      if (path.includes('/check-runs')) return { check_runs: [check({ name: 'test', conclusion: 'failure' })] };
      return {};
    })();
    void init;
    return { ok: true, status: 200, text: async () => JSON.stringify(answer) };
  };
  try {
    assert.equal(await main(['reconcile'], env, () => {}), 1);
    phase = 'clear';
    assert.equal(await main(['reconcile'], env, () => {}), 0);
    await assert.rejects(() => main(['run'], env, () => {}), /--pr <number> is required/);
    await assert.rejects(() => main(['nonsense'], env, () => {}), /unknown command/);
  } finally {
    globalThis.fetch = original;
  }
});

// ---------------------------------------------------------------------------
// The workflow contract.
//
// The script above can be perfect and the automation still broken, because
// what the refresh job actually DOES with it lives in YAML. These four
// assertions are the shape of the fix: without any one of them the daily
// refresh goes back to needing a human every morning, or worse, back to
// merging data nothing checked.
// ---------------------------------------------------------------------------
const REFRESH_WORKFLOW = readFileSync(
  new URL('../../.github/workflows/refresh-rising-shows.yml', import.meta.url), 'utf8');

test('the refresh job can release the approval hold on its own pull request', () => {
  const permissions = /^permissions:\n(?:[ \t]+.*\n|[ \t]*#.*\n)*/m.exec(REFRESH_WORKFLOW)?.[0] ?? '';
  assert.match(permissions, /^\s*actions: write$/m,
    'without actions: write the four required checks sit at action_required forever');
  assert.match(permissions, /^\s*contents: write$/m);
  assert.match(permissions, /^\s*pull-requests: write$/m);
  // Anything wider is a bigger blast radius for no benefit.
  assert.equal(/^\s*(packages|id-token|deployments|security-events):/m.test(permissions), false);
});

test('the refresh never merges its own pull request past the checks', () => {
  // The old path opened a pull request and merged it in the same breath,
  // which is what has to stay gone. Auto-merge is armed instead, and branch
  // protection decides. Comments are stripped first: this workflow explains
  // itself at length, and the prose naturally names the command it no longer
  // runs.
  const code = REFRESH_WORKFLOW.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  assert.equal(/gh pr merge/.test(code), false,
    'the workflow must not merge its pull request itself; bot-pr-autopilot arms GitHub auto-merge');
  assert.equal(/--admin|merge_method.*bypass/.test(code), false);
  assert.match(code, /scripts\/bot-pr-autopilot\.mjs run --pr/);
});

test('a refresh reconciles the previous one before spending an hour on a new one', () => {
  const steps = [...REFRESH_WORKFLOW.matchAll(/^ {6}- name: (.+)$/gm)].map((m) => m[1]);
  const reconcile = steps.findIndex((s) => /Finish any refresh pull request still open/.test(s));
  const download = steps.findIndex((s) => /Download IMDb datasets/.test(s));
  assert.ok(reconcile >= 0, 'the reconcile step must exist');
  assert.ok(reconcile < download,
    'reconciling after the download spends the whole build before finding out it cannot open a pull request');
  assert.match(REFRESH_WORKFLOW, /bot-pr-autopilot\.mjs reconcile/);
});

test('the release pin is committed, or nothing gates the data at all', () => {
  // The pin is what makes "a failed refresh cannot reach the site" true:
  // fetch-data.js resolves data-release.json from the build's own commit, and
  // falls back to the rolling asset names when the checkout has none. It was
  // generated and then left out of `git add` for a day, which silently
  // reopened the hole the immutable releases were built to close.
  const addBlock = /git add\b([\s\S]*?)\n\s*git commit/.exec(REFRESH_WORKFLOW);
  assert.ok(addBlock, 'the workflow still stages files before committing');
  for (const path of ['changelog.json', 'data-release.json', 'exports/']) {
    assert.match(addBlock[1], new RegExp(`apps/rising-shows/${path.replace('.', '\\.')}`),
      `${path} must be in the refresh commit`);
  }
});

test('the CLI entrypoint fires from a path a file: URL has to encode', async () => {
  // `import.meta.url === "file://" + process.argv[1]` is false the moment the
  // path needs encoding, and the script then exits 0 having done nothing. A
  // merge step that quietly does nothing is worse than one that fails.
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, mkdirSync, copyFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const dir = join(mkdtempSync(join(tmpdir(), 'autopilot-')), 'a dir');
  mkdirSync(dir, { recursive: true });
  const copy = join(dir, 'bot-pr-autopilot.mjs');
  copyFileSync(new URL('../../scripts/bot-pr-autopilot.mjs', import.meta.url), copy);

  let stderr = '';
  let code = 0;
  try {
    execFileSync(process.execPath, [copy, 'nonsense'], {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_TOKEN: 'x', GITHUB_REPOSITORY: 'a/b' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    code = err.status;
    stderr = err.stderr;
  }
  assert.equal(code, 1, 'the entrypoint must run and fail, not silently do nothing');
  assert.match(stderr, /unknown command/);
});
