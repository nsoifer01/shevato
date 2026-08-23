// Performance-budget suite: deterministic per-page budgets for first-party
// transfer weight, request count and DOM size, plus one loose timing guard.
//
// Method: everything except the timing check is measured from
// performance.getEntriesByType('resource') / ('navigation') inside the page,
// filtered to same-origin entries. encodedBodySize over the local python
// static server (no gzip) is exactly the file size, so byte totals, request
// counts and DOM sizes are bit-for-bit stable run to run (verified: three
// consecutive full measurements produced identical numbers on every page).
// The browser HTTP cache is disabled on the session and any service worker +
// Cache API contents are cleared before the measured load, so the numbers do
// not depend on which suites ran earlier in the same browser.
//
// Budgets carry roughly 45-50% headroom over the numbers measured on
// 2026-08-15 (table below), so routine content edits never trip them while a
// silently added megabyte, a new request fan-out or a DOM explosion does.
// Raising a budget must be a conscious decision in the same change that
// grows the page.
//
// rising-shows: boot data transfer is INTENTIONAL and bounded since the
// 2026-08-15 lazy-extras redesign. The app fetches exactly one dataset file
// at boot (data-index.json, 32.75 MB raw over this no-gzip server, ~4.3 MB
// brotli in production); the ~67 MB show-modal-extras.json monolith is never
// fetched (its content rides inside the per-show data/detail/ files, loaded
// on modal open). Dataset bytes are therefore COUNTED in that page's budget:
// the budget is code + the deliberate boot data, and a regression that
// reintroduces an eager extras fetch (~+67 MB) trips it immediately.
//
// That budget only means something when the dataset is on disk. It is
// gitignored and lives on a GitHub release, so on a clean clone and in CI the
// page measures ~1.6 MB and the 52 MB budget passes without testing anything.
// Those three rising-shows budget rows are therefore reported as SKIPPED when
// data-index.json is absent, rather than counted as passes: a vacuous green is
// worse than an explicit "not measured".
//
// The contract the budget was standing in for is asserted separately and
// unconditionally by measureRisingShowsContract() below, which needs no
// dataset at all. See the note above that function for why it is built the way
// it is.
import { newPage, closePage, goto, evaluate, evalAsync, setViewport, sleep, interceptNetwork, clickSel } from '../cdp.mjs';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, copyFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const RS_INDEX = path.join(REPO, 'apps', 'rising-shows', 'data-index.json');

// Same production-protection list as suites/apps.mjs and suites/a11y.mjs.
// Budgets count SAME-ORIGIN resources only, so failing these off-origin
// hosts cannot change a measured number.
const FIREBASE_HOSTS = /firestore\.googleapis\.com|firebaseio\.com|identitytoolkit\.googleapis\.com|securetoken\.googleapis\.com/i;

// Measured 2026-08-15 (local python server, cache disabled, SW cleared;
// identical across 3 runs). bytes = same-origin encodedBodySize incl. the
// document; reqs = same-origin requests incl. the document; dom = total
// element count. rising-shows measured with the dataset present, after the
// lazy-extras redesign: ~35.98 MB (data-index.json 34,341,226 bytes + ~1.63
// MB of code; zero bytes of show-modal-extras.json or data/detail/ at boot);
// its DOM (1,175) and request count (35) are dataset-present ceilings, and a
// clean clone only measures lower (~1.63 MB).
//
//                page          measured bytes   reqs   dom
//                home               1,041,969     24    313
//                apps               1,260,481     33    309
//                arena              2,696,547     41    791
//                football-h2h       1,428,924     46    654
//                fpl-planner        1,821,045     69    257
//                gym-tracker        2,277,390     75  1,516
//                maptap-rivals      1,527,770     31    580
//                mario-kart         1,766,099     76    994
//                rising-shows      35,978,695     35  1,175   (incl. dataset)
//                trip-planner       2,139,101     32    865
const BUDGETS = {
  'home':          { path: '/home.html',            bytes: 1_550_000, reqs: 36,  dom: 470 },
  'apps':          { path: '/apps.html',            bytes: 1_900_000, reqs: 50,  dom: 465 },
  'arena':         { path: '/apps/arena/',          bytes: 4_000_000, reqs: 62,  dom: 1_200 },
  'football-h2h':  { path: '/apps/football-h2h/',   bytes: 2_150_000, reqs: 69,  dom: 1_000 },
  'fpl-planner':   { path: '/apps/fpl-planner/',    bytes: 2_700_000, reqs: 104, dom: 390 },
  'gym-tracker':   { path: '/apps/gym-tracker/',    bytes: 3_400_000, reqs: 113, dom: 2_300 },
  'maptap-rivals': { path: '/apps/maptap-rivals/',  bytes: 2_300_000, reqs: 47,  dom: 870 },
  'mario-kart':    { path: '/apps/mario-kart/',     bytes: 2_650_000, reqs: 114, dom: 1_500 },
  // rising-shows budget = code + the deliberate boot dataset (see header
  // note): ~45% headroom over the measured 35,978,695. Growth comes from the
  // daily-refreshed data-index.json; an eager-extras regression adds ~67 MB
  // and always trips this.
  'rising-shows':  { path: '/apps/rising-shows/',   bytes: 52_000_000, reqs: 54,  dom: 1_800 },
  'trip-planner':  { path: '/apps/trip-planner/',   bytes: 3_200_000, reqs: 48,  dom: 1_300 },
};

// Loose render-blocking proxy: DOMContentLoaded end relative to navigation
// start. Measured 94-212 ms locally, but this runs on shared CI hardware
// where absolute timings swing wildly, so the budget is deliberately a
// disaster threshold (a synchronous multi-MB script, a redirect loop, a
// blocking request to a dead host), not a performance target. The byte /
// request / DOM budgets above are the deterministic core of this suite.
const DCL_BUDGET_MS = 8000;

// Repo-level guard: total same-origin JS bytes loaded by home.html.
// Measured 208,246 bytes on 2026-08-15 (jquery.min.js is 86,659 of it -
// trimming jquery is a product decision, not this suite's call; the budget
// only stops the site shell's JS from growing silently).
const HOME_JS_BUDGET = 310_000;


// ---------------------------------------------------------------------------
// Rising Shows boot-network contract
//
// WHY THIS EXISTS
// The 52 MB byte budget above was sized against a real 35.98 MB measurement,
// but CI never has the dataset, so it measured ~1.6 MB and passed vacuously:
// the exact regression it was written to catch (the pre-2026-08-15 behaviour
// of fetching the 67 MB show-modal-extras.json monolith at boot) would have
// shipped green. A byte budget also cannot express "never fetches X" - a
// smaller dataset makes an eager extras fetch cheap enough to hide under any
// threshold. So the contract is asserted structurally, by watching which
// dataset URLs the app actually requests:
//
//   1. at boot the app fetches data-index.json, and NEVER data.json, and
//      NEVER data/show-modal-extras.json;
//   2. opening one show fetches exactly one data/detail/<id>.json;
//   3. reopening the same show fetches nothing (ensureDetail memoises);
//   4. the legacy fallback (an index with no `extrasInDetail` flag) still
//      fires on modal open, and does NOT fire when the flag is present.
//
// HOW THE DATASET PROBLEM IS SOLVED
// A tiny fixture (3 series, 2 seasons each, ~3 KB index + ~3 KB of detail) is
// generated at test time by running the REAL scripts/split-data.js over a
// synthetic data.json in a temp directory, then served to the page through CDP
// request interception. Running the production splitter is the point: the
// artifact shape under test is the one the deploy actually produces, including
// the extrasInDetail flag and the per-season ov/eps merge, so the fixture
// cannot quietly drift into a shape the app no longer meets in production.
//
// Alternatives considered and rejected:
//   - Fetching the real dataset in browser-tests.yml. 111 MB and minutes on
//     every pull request, for a contract a 6 KB fixture proves just as well;
//     browser-tests.yml already rejected that trade for the six data-gated
//     apps.mjs checks and the same reasoning holds here.
//   - Making perf.mjs fail when data-index.json is absent. That turns a
//     missing gitignored build artifact into a red build on every PR, which
//     trains everyone to ignore the suite, and it still asserts nothing about
//     which URLs are fetched.
//   - Writing the fixture into the served tree. It would collide with a real
//     data-index.json on a maintainer's machine and leave artifacts behind on
//     a crash; interception needs no files and behaves identically whether or
//     not the real dataset is present.
//
// The block is intentionally independent of the byte budgets: it runs with or
// without the dataset, in CI and locally, and it is what actually guards the
// payload split.

// Dataset URLs the app may request, as one capture group so the recorder can
// classify a request by name.
const RS_DATA_URL = /\/apps\/rising-shows\/(data-index\.json|data\.json|data\/detail\/[^/?]+\.json|data\/show-modal-extras\.json)(?:\?|$)/;

function buildRisingShowsFixture() {
  const series = (id, title, tmdbId, tvdbId, seasons) => seasons.map((eps, i) => {
    const season = i + 1;
    return {
      seriesId: id, title, year: 2015 + i, seasonYear: 2015 + i, type: 'tvSeries',
      genres: ['Drama', 'Crime'], season,
      episodes: eps.map((rating, k) => ({ episode: k + 1, rating, votes: 1200 + k * 7 })),
      firstRating: eps[0], lastRating: eps[eps.length - 1],
      avgRating: Math.round((eps.reduce((a, b) => a + b, 0) / eps.length) * 100) / 100,
      minVotes: 1200,
      shapes: i === 0 ? ['rising'] : ['big-finale'],
      confidence: i === 0 ? { rising: 0.8 } : { 'big-finale': 0.6 },
      avgRuntime: 45, seriesRating: 8.4, seriesVotes: 50_000 + i,
      poster: null, overview: `${title} season ${season} plot summary.`,
      tmdbId, tvdbId, seasonTvdbId: tvdbId * 10 + season,
      language: 'en', providers: ['Netflix'],
    };
  });

  const matches = [
    ...series('tt9000001', 'Fixture Alpha', 900001, 800001, [[7.1, 7.4, 7.8, 8.2], [8.0, 8.1, 9.4]]),
    ...series('tt9000002', 'Fixture Beta', 900002, 800002, [[6.5, 6.9, 7.2, 7.6], [7.7, 7.9, 8.9]]),
    ...series('tt9000003', 'Fixture Gamma', 900003, 800003, [[8.1, 8.3, 8.6, 8.9], [8.8, 8.9, 9.6]]),
  ];
  const data = {
    builtAt: '2026-01-01T00:00:00.000Z', minEpisodes: 3, minVotes: 5, count: matches.length,
    shapeCounts: { rising: 3, 'big-finale': 3 },
    genres: [{ name: 'Drama', count: 3 }, { name: 'Crime', count: 3 }],
    languages: [{ code: 'en', count: 3 }],
    providers: [{ name: 'Netflix', count: 3 }],
    matches,
  };
  // The monolith the legacy path falls back to, in its real per-series shape.
  const extras = {};
  for (const m of matches) {
    const e = extras[m.seriesId] || (extras[m.seriesId] = { cast: ['Fixture Actor A', 'Fixture Actor B'], seasons: {} });
    e.seasons[String(m.season)] = {
      ov: `Extras overview for ${m.title} season ${m.season}.`,
      eps: Object.fromEntries(m.episodes.map((ep) => [String(ep.episode),
        { tt: `tt99${m.season}${ep.episode}`, runtime: 44, name: `Episode ${ep.episode}` }])),
    };
  }

  // split-data.js resolves its input and output from path.join(__dirname,
  // '..'), so dropping a copy in <tmp>/scripts/ makes <tmp> the app dir. No
  // other file in the repo is read or written.
  const dir = mkdtempSync(path.join(tmpdir(), 'rs-perf-fixture-'));
  try {
    mkdirSync(path.join(dir, 'data'), { recursive: true });
    mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    writeFileSync(path.join(dir, 'data.json'), JSON.stringify(data));
    writeFileSync(path.join(dir, 'data', 'show-modal-extras.json'), JSON.stringify(extras));
    copyFileSync(path.join(REPO, 'apps', 'rising-shows', 'scripts', 'split-data.js'),
      path.join(dir, 'scripts', 'split-data.js'));
    execFileSync(process.execPath, [path.join(dir, 'scripts', 'split-data.js')], { stdio: 'pipe' });

    const index = readFileSync(path.join(dir, 'data-index.json'), 'utf8');
    const detail = {};
    for (const f of readdirSync(path.join(dir, 'data', 'detail'))) {
      detail[f.replace(/\.json$/, '')] = readFileSync(path.join(dir, 'data', 'detail', f), 'utf8');
    }
    return { index, detail, extras: JSON.stringify(extras) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Runs the whole contract in one page session and returns a plain record of
// what was observed. Every field defaults to a value that fails its check, so
// an exception anywhere still emits the full, fixed set of checks (the runner
// pins per-suite check counts; a block that silently emits fewer would be a
// second silent-shrinkage bug).
async function measureRisingShowsContract(base, cdpPort) {
  const out = {
    flagInFixture: false, cards: 0,
    boot: null, open: null, reopen: null, legacyBoot: null, legacyOpen: null,
    error: null,
  };
  let s;
  try {
    const fx = buildRisingShowsFixture();
    out.flagInFixture = JSON.parse(fx.index).extrasInDetail === true;
    const legacyIndex = (() => { const o = JSON.parse(fx.index); delete o.extrasInDetail; return JSON.stringify(o); })();

    let log = [];
    let legacy = false;
    s = await newPage(cdpPort);
    await setViewport(s, 1280, 900);
    await s.send('Network.setCacheDisabled', { cacheDisabled: true });
    await interceptNetwork(s, (url) => {
      if (FIREBASE_HOSTS.test(url)) return 'fail';
      const m = url.match(RS_DATA_URL);
      if (!m) return null;
      log.push(m[1]);
      if (m[1] === 'data-index.json') return { status: 200, body: legacy ? legacyIndex : fx.index };
      if (m[1] === 'data/show-modal-extras.json') return { status: 200, body: fx.extras };
      // data.json must never be requested by the app; serving a 404 keeps a
      // regression visible in the log instead of accidentally working.
      if (m[1] === 'data.json') return { status: 404, body: '{}' };
      const id = m[1].slice('data/detail/'.length, -'.json'.length);
      return fx.detail[id] ? { status: 200, body: fx.detail[id] } : { status: 404, body: '{}' };
    });

    const CARD = '#finderResults .finder-card[data-series-id]';
    await goto(s, base + '/apps/rising-shows/', { settle: 2500 });
    out.boot = log.slice();
    out.cards = await evaluate(s, `document.querySelectorAll('${CARD}').length`);

    log = [];
    await clickSel(s, CARD, { settle: 1200 });
    out.open = log.slice();
    out.modalTitle = await evaluate(s, "document.getElementById('showModalTitle').textContent");

    log = [];
    await clickSel(s, '#showModal .modal-close', { settle: 600 });
    await clickSel(s, CARD, { settle: 1200 });
    out.reopen = log.slice();

    // Legacy artifact set: an index split before the extras merge existed.
    legacy = true;
    log = [];
    await goto(s, base + '/apps/rising-shows/', { settle: 2500 });
    out.legacyBoot = log.slice();
    log = [];
    await clickSel(s, CARD, { settle: 1500 });
    out.legacyOpen = log.slice();
  } catch (e) {
    out.error = String(e && e.message || e).slice(0, 140);
  } finally {
    if (s) { try { await closePage(cdpPort, s); } catch {} }
  }
  return out;
}


export async function run({ base, cdpPort }) {
  const R = [];
  const t = (name, pass, detail = '') => R.push({ name, pass: !!pass, detail });
  // A budget row that cannot be measured is recorded as skipped, not passed.
  // run.mjs counts skipped entries towards the pinned per-suite total but
  // reports them separately, so the count stays stable and nobody reads a
  // vacuous green as coverage.
  const tSkip = (name, detail) => R.push({ name, pass: true, skipped: true, detail });

  // The rising-shows byte / request / DOM budgets are only meaningful with the
  // gitignored dataset on disk (see the header note).
  const rsDataset = existsSync(RS_INDEX);

  const s = await newPage(cdpPort);
  // Session-wide production protection: arena is one of the measured roots
  // and no page here may ever reach real Firebase.
  await interceptNetwork(s, (url) => (FIREBASE_HOSTS.test(url) ? 'fail' : null));
  try {
    await setViewport(s, 1280, 900);
    // No browser cache: byte totals must reflect the network, not whatever an
    // earlier suite left in the shared profile's disk cache.
    await s.send('Network.setCacheDisabled', { cacheDisabled: true });

    for (const [name, b] of Object.entries(BUDGETS)) {
      try {
        // First visit only exists to reach the origin so its service worker
        // registrations and Cache API stores can be cleared; the measured
        // load is the clean reload after that.
        await goto(s, base + b.path, { settle: 1500 });
        await evalAsync(s, `(async()=>{ try{
          const regs = await navigator.serviceWorker.getRegistrations();
          for (const r of regs) await r.unregister();
          for (const k of await caches.keys()) await caches.delete(k);
          return 1; } catch(e){ return 0; } })()`);
        await goto(s, base + b.path, { settle: 2500 });
        // Late fetches (data files, lazy modules) land after onload; wait for
        // the resource-entry count to hold still instead of guessing a sleep.
        let last = -1, stableSince = Date.now(), deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
          const n = await evaluate(s, "performance.getEntriesByType('resource').length");
          if (n !== last) { last = n; stableSince = Date.now(); }
          if (Date.now() - stableSince > 2000) break;
          await sleep(400);
        }

        const m = await evaluate(s, `(()=>{
          const origin=location.origin;
          const res=performance.getEntriesByType('resource').filter(r=>r.name.startsWith(origin));
          const nav=performance.getEntriesByType('navigation')[0];
          const sum=(a,f)=>a.reduce((t2,x)=>t2+(x[f]||0),0);
          const js=res.filter(r=>/\\.m?js(\\?|$)/.test(r.name));
          return {
            bytes: sum(res,'encodedBodySize') + (nav?nav.encodedBodySize:0),
            reqs: res.length + 1,
            jsBytes: sum(js,'encodedBodySize'),
            dom: document.querySelectorAll('*').length,
            dcl: nav?Math.round(nav.domContentLoadedEventEnd-nav.startTime):null };})()`);

        const vacuous = name === 'rising-shows' && !rsDataset;
        const tb = vacuous
          ? (n) => tSkip(n, 'data-index.json absent; budget would pass on ~1.6 MB of code alone')
          : t;
        tb(`perf ${name}: first-party bytes within budget`,
          m && m.bytes > 0 && m.bytes <= b.bytes, `${m && m.bytes} of ${b.bytes}`);
        tb(`perf ${name}: same-origin request count within budget`,
          m && m.reqs > 1 && m.reqs <= b.reqs, `${m && m.reqs} of ${b.reqs}`);
        tb(`perf ${name}: DOM size within budget`,
          m && m.dom > 50 && m.dom <= b.dom, `${m && m.dom} of ${b.dom}`);
        t(`perf ${name}: DOMContentLoaded under the disaster threshold`,
          m && m.dcl !== null && m.dcl >= 0 && m.dcl <= DCL_BUDGET_MS, `${m && m.dcl}ms of ${DCL_BUDGET_MS}ms`);
        if (name === 'home') {
          t('perf home: total first-party JS bytes within budget',
            m && m.jsBytes > 0 && m.jsBytes <= HOME_JS_BUDGET, `${m && m.jsBytes} of ${HOME_JS_BUDGET}`);
        }
      } catch (e) {
        t(`perf ${name}: page measured`, false, String(e && e.message).slice(0, 140));
      }
    }
  } finally {
    await closePage(cdpPort, s);
  }

  // --- Rising Shows boot-network contract (dataset-independent) ---
  const c = await measureRisingShowsContract(base, cdpPort);
  const has = (list, name) => Array.isArray(list) && list.filter((x) => x === name).length;
  const details = (list) => (Array.isArray(list) ? list.join(', ') || '(none)' : `not measured: ${c.error || 'unknown'}`);

  t('perf rising-shows contract: split-data.js marks the fixture index extrasInDetail',
    c.flagInFixture, c.error || String(c.flagInFixture));
  // Guard: without rendered cards every request assertion below would pass on
  // an empty page.
  t('perf rising-shows contract: the app renders the fixture index',
    c.cards === 3 && c.modalTitle === 'Fixture Alpha', `${c.cards} cards, modal "${c.modalTitle}"`);
  t('perf rising-shows contract: boot fetches data-index.json exactly once',
    has(c.boot, 'data-index.json') === 1, details(c.boot));
  t('perf rising-shows contract: boot never fetches data.json',
    Array.isArray(c.boot) && has(c.boot, 'data.json') === 0, details(c.boot));
  t('perf rising-shows contract: boot never fetches the show-modal-extras monolith',
    Array.isArray(c.boot) && has(c.boot, 'data/show-modal-extras.json') === 0, details(c.boot));
  t('perf rising-shows contract: opening a show fetches exactly one detail file',
    Array.isArray(c.open) && c.open.length === 1 && c.open[0] === 'data/detail/tt9000001.json', details(c.open));
  t('perf rising-shows contract: opening a show never fetches the extras monolith',
    Array.isArray(c.open) && has(c.open, 'data/show-modal-extras.json') === 0, details(c.open));
  t('perf rising-shows contract: reopening the same show fetches nothing',
    Array.isArray(c.reopen) && c.reopen.length === 0, details(c.reopen));
  t('perf rising-shows contract: a legacy index still falls back to the extras monolith',
    has(c.legacyOpen, 'data/show-modal-extras.json') === 1, details(c.legacyOpen));
  t('perf rising-shows contract: the legacy fallback fires on modal open, never at boot',
    Array.isArray(c.legacyBoot) && has(c.legacyBoot, 'data/show-modal-extras.json') === 0
      && has(c.legacyBoot, 'data-index.json') === 1, details(c.legacyBoot));

  return R;
}
