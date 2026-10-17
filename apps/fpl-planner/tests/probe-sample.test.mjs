// The pre-gameweek readiness gate: `evidence-probe.mjs --direct --sample N`
// reads N REAL managers and runs every real-entry check on each (2026-10-16).
// One monitored manager exercised one path through the engine, and many of
// the live season's defects lived on paths his state never took, so the gate
// is only worth having if it (a) reads different managers each slot but the
// same ones within a slot, (b) says whether a failure is the planner's
// (APPLICATION, exit 1) or FPL's (UPSTREAM, exit 2), and (c) never says OK
// about a check it was asked for and could not run.
//
// The CLI runs as itself, in a child process, with the global fetch replaced
// by a preload that answers from the GW7 fixture (tests/fixtures/gw7-2026):
// its managers are the sample, any entry id the run draws at random is served
// as one of them, and the overall league's standings list them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BOOTSTRAP, FIXTURES, ENTRIES, FETCHED_AT } from './helpers/gw7-fixture.mjs';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROBE = join(APP, 'scripts', 'evidence-probe.mjs');
const CURRENT = BOOTSTRAP.events.find((e) => e.is_current).id;
const LAST_PAGE = Math.floor(BOOTSTRAP.total_players / 50);

// A manager's payloads by the path suffix the CLI asks for.
const served = (label) => {
  const e = ENTRIES[label];
  const out = {
    '': { body: e.entry }, '/history': { body: e.history }, '/transfers': { body: e.transfers },
    [`/event/${CURRENT}/picks`]: { body: e.picks },
  };
  if (e.revertPicks) out[`/event/${CURRENT - 1}/picks`] = { body: e.revertPicks };
  return out;
};
const standingsOf = (labels) => ({
  body: { standings: { has_next: true, results: labels.map((l, i) => ({ entry: ENTRIES[l].entry.id, rank: 100 * (i + 1), entry_name: l })) } },
});

const PRELOAD = `data:text/javascript,${encodeURIComponent(`
  import { readFileSync, appendFileSync } from 'node:fs';
  const cfg = JSON.parse(readFileSync(process.env.FAKE_FPL, 'utf8'));
  globalThis.fetch = async (url) => {
    appendFileSync(process.env.FAKE_FPL + '.calls', Date.now() + ' ' + url + '\\n');
    if (cfg.network) throw new TypeError('fetch failed');
    const path = String(url).replace('https://fantasy.premierleague.com/api/', '').replace(/\\/$/, '');
    let r = cfg.routes[path];
    if (!r && path.startsWith('leagues-classic/')) r = cfg.standings;
    const m = /^entry\\/(\\d+)(\\/.*)?$/.exec(path);
    if (!r && m) {
      const own = cfg.entries[m[1]];
      const suffix = m[2] || '';
      r = own ? own[suffix] : cfg.fallback ? ((cfg.fallbackFail || {})[suffix] || cfg.fallback[suffix]) : null;
    }
    if (!r) return new Response('{"detail":"Not found."}', { status: 404 });
    if (r.timeout) throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status || 200 });
  };
`)}`;

const base = () => ({ routes: { 'bootstrap-static': { body: BOOTSTRAP }, fixtures: { body: FIXTURES } }, entries: {}, standings: null, fallback: null });

function runCli(dir, name, cfg, args, { gapMs = '0' } = {}) {
  const file = join(dir, `${name}.json`);
  writeFileSync(file, JSON.stringify(cfg));
  const env = { ...process.env, FAKE_FPL: file };
  if (gapMs === null) delete env.FPL_PROBE_REQUEST_GAP_MS; else env.FPL_PROBE_REQUEST_GAP_MS = gapMs;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', PRELOAD, PROBE, '--direct', ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => {
      let calls = [];
      try {
        calls = readFileSync(`${file}.calls`, 'utf8').trim().split('\n').filter(Boolean)
          .map((l) => { const [at, url] = l.split(' '); return { at: Number(at), url }; });
      } catch { /* nothing fetched */ }
      resolve({ code, out, calls });
    });
  });
}
const isOk = (out) => /^OK/m.test(out);
const failed = (out) => out.split('\n').filter((l) => /^ {2}- \[/.test(l));
const sampleReads = (calls) => calls.map((c) => c.url).filter((u) => /leagues-classic|\/entry\//.test(u));

test('the sample rotates with the six-hour slot, is fixed within it, and spans top and deep ranks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fpl-sample-rot-'));
  try {
    // Every entry is missing, so nothing is planned: the reads are the point.
    const cfg = { ...base(), standings: standingsOf(['owner', 'bench-boost', 'deep-search', 'free-hit', 'triple-captain-tie']) };
    const later = new Date(Date.parse(FETCHED_AT) + 90 * 60e3).toISOString();
    const nextSlot = new Date(Date.parse(FETCHED_AT) + 6 * 3600e3).toISOString();
    const [a, again, b] = await Promise.all([
      runCli(dir, 'a', cfg, ['--now', FETCHED_AT, '--sample', '12']),
      runCli(dir, 'again', cfg, ['--now', later, '--sample', '12']),
      runCli(dir, 'b', cfg, ['--now', nextSlot, '--sample', '12']),
    ]);
    assert.deepEqual(sampleReads(again.calls), sampleReads(a.calls), 'the same slot reads the same managers');
    assert.notDeepEqual(sampleReads(b.calls), sampleReads(a.calls), 'the next slot reads others');

    const pagesOf = (r) => r.calls.map((c) => /page_standings=(\d+)/.exec(c.url)).filter(Boolean).map((m) => Number(m[1]));
    for (const r of [a, b]) {
      const pages = pagesOf(r);
      assert.equal(pages.length, 3, r.out);
      assert.ok(pages[0] <= 20, `a top-thousand page: ${pages}`);
      assert.ok(pages[2] >= Math.floor(LAST_PAGE / 10) && pages[2] <= LAST_PAGE, `a deep page: ${pages}`);
      // 12 asked: 3 random ids (one from the newest), 2 spares, 9 from the pages.
      const ids = sampleReads(r.calls).filter((u) => /\/entry\/\d+\/$/.test(u)).map((u) => Number(/entry\/(\d+)/.exec(u)[1]));
      assert.ok(ids.some((id) => id >= Math.floor(BOOTSTRAP.total_players * 0.97)), 'one id from the newest 3%: a late joiner');
      assert.ok(r.calls.length <= 2 + 3 + (12 + 2) * 5, 'the requests stay within their printed bound');
      assert.match(r.out, /requests {8}\d+ to FPL for the sample, \d+ in all \(bounded at 73 for the sample\)/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('each upstream kind is UPSTREAM (exit 2), an invariant broken on a real manager is APPLICATION (exit 1), a clean sample exits 0', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fpl-sample-cls-'));
  try {
    // The five GW7 managers: four from the standings, one as the random id.
    const clean = { ...base(), standings: standingsOf(['bench-boost', 'deep-search', 'free-hit', 'triple-captain-tie']), fallback: served('owner') };
    for (const l of ['bench-boost', 'deep-search', 'free-hit', 'triple-captain-tie']) clean.entries[ENTRIES[l].entry.id] = served(l);

    // `--sample 1` reads the pages but picks only the random id, served as
    // the owner fixture; each upstream case breaks one of his reads.
    const one = (fail) => ({ ...base(), standings: standingsOf(['owner']), fallback: served('owner'), fallbackFail: fail });

    // The application case: a week FPL charged more than the replay allows.
    // Alongside it the standings answer 503, so the run has both classes and
    // must still say APPLICATION.
    const tampered = structuredClone(served('owner'));
    const week = tampered['/history'].body.current.find((w) => w.event_transfers > 0) || tampered['/history'].body.current[1];
    week.event_transfers_cost = (week.event_transfers_cost || 0) + 12;
    const app = { ...base(), standings: { status: 503, body: 'down' }, fallback: tampered };

    const save = join(dir, 'saved');
    const summaryFile = join(dir, 'summary.md');
    const cases = {
      clean: [clean, ['--sample', '5']],
      server: [one({ '/history': { status: 503, body: '<html>' } }), ['--sample', '1']],
      timeout: [one({ '/transfers': { timeout: true } }), ['--sample', '1']],
      malformed: [one({ '': { body: '<html>not json</html>' } }), ['--sample', '1']],
      refused: [one({ '/history': { status: 403, body: 'Access Denied' } }), ['--sample', '1']],
      network: [{ ...base(), network: true }, ['--sample', '1']],
      shape: [{ ...base(), routes: { 'bootstrap-static': { body: { detail: 'maintenance' } }, fixtures: { body: FIXTURES } } }, ['--sample', '1']],
      application: [app, ['--sample', '1', '--summary', summaryFile, '--save-failures', save]],
    };
    const runs = Object.fromEntries(await Promise.all(Object.entries(cases)
      .map(async ([name, [cfg, args]]) => [name, await runCli(dir, name, cfg, ['--now', FETCHED_AT, ...args])])));

    assert.equal(runs.clean.code, 0, runs.clean.out);
    assert.match(runs.clean.out, /OK: all 5 sampled managers hold every check\./);
    assert.match(runs.clean.out, /failures {8}application 0 {3}upstream 0/);
    // Paths are visible: the Free Hit manager reads as a revert after playing it.
    assert.match(runs.clean.out, /ok {4}#\d+ +page \d+ .*just played freehit, Free Hit revert/);
    assert.match(runs.clean.out, /coverage {8}free transfers held .* \| just played a chip freehit:1 \| Free Hit revert 1 \|/);

    for (const name of ['server', 'timeout', 'malformed', 'refused', 'network', 'shape']) {
      const r = runs[name];
      assert.equal(r.code, 2, `${name}: ${r.out}`);
      assert.ok(!isOk(r.out), `${name} never says OK`);
      assert.match(r.out, /PROBLEM \(UPSTREAM/, name);
      assert.doesNotMatch(r.out, /\[APPLICATION\]/, name);
    }
    assert.match(runs.server.out, /\[UPSTREAM\] sampled manager \(newest ids, rank \?\) is served: saw entry\/\d+\/history: HTTP 503/);
    assert.match(runs.timeout.out, /\[UPSTREAM\] .*transfers: no answer in 20s/);
    assert.match(runs.malformed.out, /\[UPSTREAM\] .*the body is not JSON/);
    // A refusal ends the sample: nothing is asked after the 403.
    assert.match(runs.refused.out, /\[UPSTREAM\] the sample reads 1 real managers: saw 0 read \(FPL refused entry\/\d+\/history with HTTP 403\)/);
    const at403 = runs.refused.calls.findIndex((c) => /\/history\/$/.test(c.url));
    assert.ok(at403 >= 0 && runs.refused.calls.length <= at403 + 3, 'only reads already in flight with it may follow');
    assert.match(runs.network.out, /fetch failed/);
    assert.match(runs.shape.out, /PROBLEM \(UPSTREAM\): the payloads have the shape the app reads/);
    assert.match(runs.shape.out, /the sample of 1 managers did not run/);

    assert.equal(runs.application.code, 1, runs.application.out);
    assert.match(runs.application.out, /failures {8}application 1 {3}upstream \d+/);
    assert.ok(failed(runs.application.out).some((l) => /\[APPLICATION\] sampled manager #1 .*free-transfer replay reproduces every hit FPL charged/.test(l)));
    assert.ok(failed(runs.application.out).some((l) => /\[UPSTREAM\] the overall league's standings page \d+ is served/.test(l)));
    // What the failure email and the lead get: the class table, and the
    // payloads to replay offline.
    const md = readFileSync(summaryFile, 'utf8');
    assert.match(md, /^### FPL health probe: PROBLEM \(APPLICATION\)/m);
    assert.match(md, /\| APPLICATION \| sampled manager #1 .*free-transfer replay/);
    assert.match(md, /\| 1 \| newest ids \| .* \| FAIL \(team \d+\) \|/);
    const id = /FAIL \(team (\d+)\)/.exec(md)[1];
    assert.ok(existsSync(join(save, 'bootstrap.json')) && existsSync(join(save, id, 'history.json')), 'the failing payloads are saved');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('asked for and not run is never OK: no entries, a missing squad, a refusal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fpl-sample-unrun-'));
  try {
    const noPicks = { ...base() };
    noPicks.entries['111'] = Object.fromEntries(Object.entries(served('owner')).filter(([k]) => !k.includes('/picks')));
    const [empty, missingSquad, polite] = await Promise.all([
      // Every page answers, every manager is gone.
      runCli(dir, 'empty', { ...base(), standings: standingsOf(['owner']) }, ['--now', FETCHED_AT, '--sample', '3']),
      // The monitored entry, in a live season, with no current picks.
      runCli(dir, 'missingSquad', noPicks, ['--now', FETCHED_AT, '--entry', '111']),
      // FPL refuses the first standings page; the real gap is kept here.
      runCli(dir, 'polite', { ...base(), standings: { status: 429, body: 'slow down' } }, ['--now', FETCHED_AT, '--sample', '3'], { gapMs: null }),
    ]);
    assert.equal(empty.code, 2, empty.out);
    assert.ok(!isOk(empty.out));
    assert.match(empty.out, /\[UPSTREAM\] the sample reads 3 real managers: saw 0 read/);
    assert.match(empty.out, /skip {2}.*: no such entry/);

    assert.equal(missingSquad.code, 2, missingSquad.out);
    assert.ok(!isOk(missingSquad.out));
    assert.match(missingSquad.out, new RegExp(`\\[UPSTREAM\\] entry 111 has a squad for GW${CURRENT}`));

    assert.equal(polite.code, 2, polite.out);
    assert.ok(!isOk(polite.out));
    assert.match(polite.out, /FPL refused leagues-classic\/314\/standings\/\?page_standings=\d+ with HTTP 429/);
    const urls = polite.calls.map((c) => c.url);
    assert.equal(urls.filter((u) => u.includes('leagues-classic')).length, 1, 'nothing more is asked after a 429');
    assert.ok(!urls.some((u) => u.includes('/entry/')));
    for (let i = 1; i < polite.calls.length; i++) {
      assert.ok(polite.calls[i].at - polite.calls[i - 1].at >= 950, `requests at least a second apart: ${polite.calls.map((c) => c.at)}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
