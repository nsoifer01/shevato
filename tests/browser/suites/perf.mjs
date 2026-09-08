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
// rising-shows: boot data transfer is INTENTIONAL and bounded. The app
// fetches exactly one dataset file at boot, and since the 2026-09-05 audit's
// F08 split that file is SHOW-level (shows-index.json, 15.9 MB raw over this
// no-gzip server, 3.4 MB brotli in production) rather than the season-level
// data-index.json it used to be (32.8 MB raw, 5.9 MB brotli). The ~67 MB
// show-modal-extras.json monolith is never fetched, and neither is the season
// file: season records ride in the per-show data/detail/ files, loaded on
// modal open. Dataset bytes are therefore COUNTED in that page's budget: the
// budget is code + the deliberate boot data, and a regression that
// reintroduces an eager extras fetch (~+67 MB) or reverts to the season index
// (~+17 MB) trips it immediately.
//
// That budget only means something when the dataset is on disk. It is
// gitignored and lives on a GitHub release, so on a clean clone and in CI the
// page measures ~1.6 MB and the budget passes without testing anything.
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
const RS_INDEX = path.join(REPO, 'apps', 'rising-shows', 'shows-index.json');

// Same production-protection list as suites/apps.mjs and suites/a11y.mjs.
// Budgets count SAME-ORIGIN resources only, so failing these off-origin
// hosts cannot change a measured number.
const FIREBASE_HOSTS = /firestore\.googleapis\.com|firebaseio\.com|identitytoolkit\.googleapis\.com|securetoken\.googleapis\.com/i;

// Measured 2026-08-15 (local python server, cache disabled, SW cleared;
// identical across 3 runs). bytes = same-origin encodedBodySize incl. the
// document; reqs = same-origin requests incl. the document; dom = total
// element count. rising-shows measured with the dataset present, after the
// F08 show-level split: ~18.3 MB (shows-index.json 16,617,013 bytes + ~1.63
// MB of code; zero bytes of data-index.json, show-modal-extras.json or
// data/detail/ at boot); its DOM (1,175) and request count (35) are
// dataset-present ceilings, and a clean clone only measures lower (~1.63 MB).
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
//                rising-shows      18,254,000     35  1,175   (incl. dataset)
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
  // note): ~42% headroom over the measured ~18,254,000. Growth comes from the
  // daily-refreshed shows-index.json; an eager-extras regression adds ~67 MB
  // and a revert to the season-level index adds ~17 MB, so either trips this.
  // It was 52,000,000 while the season file was the boot payload; leaving it
  // there would have let the whole F08 saving be given back unnoticed.
  'quotescout': { path: '/apps/quotescout/', bytes: 1_000_000, reqs: 40, dom: 650 },
  'rising-shows':  { path: '/apps/rising-shows/',   bytes: 26_000_000, reqs: 54,  dom: 1_800 },
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
//   1. at boot the app fetches shows-index.json, and NEVER data-index.json,
//      NEVER data.json, and NEVER data/show-modal-extras.json;
//   2. opening one show fetches exactly one data/detail/<id>.json;
//   3. reopening the same show fetches nothing (ensureDetail memoises);
//   4. the legacy fallback (an index with no `extrasInDetail` flag) still
//      fires on modal open, and does NOT fire when the flag is present;
//   5. a show whose partition 404s, or whose cached partition predates the
//      split, still opens with its true season rows plus a retry - the season
//      table is in the partition now, so a silent empty one is the failure
//      this has to catch;
//   6. a query typed while the index is still downloading survives into the
//      grid, and a season permalink fetches exactly that one partition.
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
const RS_DATA_URL = /\/apps\/rising-shows\/(shows-index\.json|data-index\.json|data\.json|data\/kometa-index\.json|data\/detail\/[^/?]+\.json|data\/show-modal-extras\.json)(?:\?|$)/;

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
    // split-data.js requires the three dual-exposed libs (it folds the show
    // index with the same buildShowAgg / detectShapes / normalizeProviders the
    // browser uses), so the temp scripts/ dir needs them beside it. Copying the
    // REAL files is the point: a fixture built by a stubbed splitter would not
    // be the artifact the deploy produces.
    for (const f of ['split-data.js', 'finder-lib.js', 'match.js', 'providers-lib.js']) {
      copyFileSync(path.join(REPO, 'apps', 'rising-shows', 'scripts', f), path.join(dir, 'scripts', f));
    }
    execFileSync(process.execPath, [path.join(dir, 'scripts', 'split-data.js')], { stdio: 'pipe' });

    const index = readFileSync(path.join(dir, 'data-index.json'), 'utf8');
    const shows = readFileSync(path.join(dir, 'shows-index.json'), 'utf8');
    const kometa = readFileSync(path.join(dir, 'data', 'kometa-index.json'), 'utf8');
    const detail = {};
    for (const f of readdirSync(path.join(dir, 'data', 'detail'))) {
      detail[f.replace(/\.json$/, '')] = readFileSync(path.join(dir, 'data', 'detail', f), 'utf8');
    }
    return { index, shows, kometa, detail, extras: JSON.stringify(extras) };
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
    degraded: null, retried: null, corrupt: null, presplit: null, earlyTyping: null,
    seasonLink: null, seasonModal: null,
    error: null,
  };
  let s;
  try {
    const fx = buildRisingShowsFixture();
    out.flagInFixture = JSON.parse(fx.shows).extrasInDetail === true;
    const legacyIndex = (() => { const o = JSON.parse(fx.shows); delete o.extrasInDetail; return JSON.stringify(o); })();

    let log = [];
    let legacy = false;
    // Per-show detail responses can be swapped for the failure cases below:
    // 'ok' serves the fixture, 'missing' 404s, 'truncated' serves a body that
    // is not JSON, and 'presplit' serves a detail file written before the F08
    // split (episodes but no season records), which is what a stale CDN or
    // service-worker entry would hand a new page.
    let detailMode = 'ok';
    s = await newPage(cdpPort);
    await setViewport(s, 1280, 900);
    await s.send('Network.setCacheDisabled', { cacheDisabled: true });
    await interceptNetwork(s, (url) => {
      if (FIREBASE_HOSTS.test(url)) return 'fail';
      const m = url.match(RS_DATA_URL);
      if (!m) return null;
      log.push(m[1]);
      if (m[1] === 'shows-index.json') return { status: 200, body: legacy ? legacyIndex : fx.shows };
      if (m[1] === 'data/show-modal-extras.json') return { status: 200, body: fx.extras };
      if (m[1] === 'data/kometa-index.json') return { status: 200, body: fx.kometa };
      // Neither the season index nor the raw dataset may be requested by the
      // Finder; serving a 404 keeps a regression visible in the log instead of
      // accidentally working.
      if (m[1] === 'data.json' || m[1] === 'data-index.json') return { status: 404, body: '{}' };
      const id = m[1].slice('data/detail/'.length, -'.json'.length);
      if (detailMode === 'missing') return { status: 404, body: '{}' };
      if (detailMode === 'truncated') return { status: 200, body: '{"seasons":{"1":{"epi' };
      if (detailMode === 'presplit') {
        const d = JSON.parse(fx.detail[id] || '{"seasons":{}}');
        delete d.records;
        return { status: 200, body: JSON.stringify(d) };
      }
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
    legacy = false;

    // --- a show whose season partition cannot be fetched -------------------
    // The season records live in the detail file now, so a 404 there is the
    // case that used to be impossible (the boot index carried them). The modal
    // must still open, still state the true season and episode counts from the
    // boot index, and say that the detail is missing with a way to retry -
    // never silently show an empty season list or "0 eps".
    detailMode = 'missing';
    await goto(s, base + '/apps/rising-shows/', { settle: 2500 });
    await clickSel(s, CARD, { settle: 1500 });
    out.degraded = await evaluate(s, `(() => {
      const modal = document.getElementById('showModal');
      const rows = modal.querySelectorAll('.show-season-row, #showModalSeasons li');
      const err = modal.querySelector('.modal-detail-error');
      return JSON.stringify({
        open: !modal.hidden,
        title: (document.getElementById('showModalTitle')||{}).textContent || '',
        rows: rows.length,
        notice: !!err,
        retry: !!modal.querySelector('.modal-detail-retry'),
        zeroEps: /\b0 eps\b/.test(modal.textContent || ''),
      });
    })()`);

    // Retrying once the network recovers must repair the same modal in place.
    detailMode = 'ok';
    await clickSel(s, '#showModal .modal-detail-retry', { settle: 1500 });
    out.retried = await evaluate(s, `(() => {
      const modal = document.getElementById('showModal');
      return JSON.stringify({
        notice: !!modal.querySelector('.modal-detail-error'),
        rows: modal.querySelectorAll('.show-season-row, #showModalSeasons li').length,
      });
    })()`);

    // --- a partition that arrives corrupt (truncated body, dropped
    // connection mid-response). Different branch from the 404: res.ok is true
    // and res.json() rejects, so it lands in ensureDetail's catch rather than
    // its !detail check, and both have to evict and degrade the same way.
    detailMode = 'truncated';
    await goto(s, base + '/apps/rising-shows/', { settle: 2500 });
    await clickSel(s, CARD, { settle: 1500 });
    out.corrupt = await evaluate(s, `(() => {
      const modal = document.getElementById('showModal');
      return JSON.stringify({
        open: !modal.hidden,
        rows: modal.querySelectorAll('.show-season-row, #showModalSeasons li').length,
        notice: !!modal.querySelector('.modal-detail-error'),
        zeroEps: /\\b0 eps\\b/.test(modal.textContent || ''),
      });
    })()`);

    // --- a detail file written before the split (stale cache / rollback) ---
    detailMode = 'presplit';
    await goto(s, base + '/apps/rising-shows/', { settle: 2500 });
    await clickSel(s, CARD, { settle: 1500 });
    out.presplit = await evaluate(s, `(() => {
      const modal = document.getElementById('showModal');
      return JSON.stringify({
        open: !modal.hidden,
        rows: modal.querySelectorAll('.show-season-row, #showModalSeasons li').length,
        zeroEps: /\b0 eps\b/.test(modal.textContent || ''),
      });
    })()`);
    detailMode = 'ok';

    // --- typing before the grid exists -------------------------------------
    // The search box is in the document from the first byte; a query typed
    // while the index is still downloading has to survive into the rendered
    // grid rather than being wiped when the cards arrive.
    await goto(s, base + '/apps/rising-shows/', { settle: 2500 });
    out.earlyTyping = await evalAsync(s, `(async () => {
      const box = document.getElementById('finderSearch');
      box.value = 'Beta';
      box.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 900));
      const cards = [...document.querySelectorAll('${CARD}')];
      const titles = cards.map((el) => (el.querySelector('.card-title') || {}).textContent || '')
        .map((t) => t.trim());
      return JSON.stringify({ value: box.value, count: cards.length, titles: titles.slice(0, 5) });
    })()`);

    // --- a season permalink, which needs that one show's partition ---------
    log = [];
    await goto(s, base + '/apps/rising-shows/#season=tt9000002:2', { settle: 2500 });
    out.seasonLink = log.slice();
    out.seasonModal = await evaluate(s, `(() => {
      const m = document.getElementById('detailModal');
      if (!m) return JSON.stringify({ open: false, text: 'detailModal missing' });
      return JSON.stringify({ open: !m.hidden, text: (m.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120) });
    })()`);
  } catch (e) {
    out.error = String(e && e.message || e).slice(0, 140);
  } finally {
    if (s) { try { await closePage(cdpPort, s); } catch {} }
  }
  return out;
}



// ---------------------------------------------------------------------------
// STARTUP LAYOUT STABILITY (2026-09-05 audit F07).
//
// The budgets above measure weight, request count and DOM size, and every one
// of them passed while three apps moved their controls hundreds of pixels
// under a reader's thumb during startup - the audit measured 0.636 (Mario
// Kart), 0.297 (MapTap Rivals) and 0.253 (Trip Planner) session-window CLS at
// 390x844, against Google's 0.1 "good" threshold. A settled-geometry check
// cannot see that: the FINAL layout was correct in all three.
//
// Two things make this measurable rather than accidental:
//
//  1. THROTTLING. Served from local disk, every asset arrives before first
//     paint, so the script that mutates the DOM has already run by the time
//     anything is painted and the number is a flat zero for a page that is
//     visibly terrible on a phone. Fast-3G-ish transport plus a 4x CPU
//     slowdown is the mid-range-phone stand-in, and it reproduces the audit's
//     production numbers within a few hundredths.
//  2. THE OBSERVER IS INSTALLED BEFORE THE PAGE'S OWN SCRIPTS, via
//     Page.addScriptToEvaluateOnNewDocument. A PerformanceObserver added
//     after boot misses exactly the shifts that matter.
//
// The budget is 0.1 - Google's threshold, not a number picked to fit what the
// apps happen to do. Raising it is not a fix.
export const CLS_BUDGET = 0.1;

const CLS_OBSERVER = `(() => {
  window.__cls = { worst: 0, sources: [] };
  let cur = 0, first = 0, last = 0;
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      if (e.hadRecentInput) continue;
      const t = e.startTime;
      // Session window: a new one starts after a 1s gap or a 5s span, which
      // is how Chrome and CrUX define the metric.
      if (cur && (t - first > 5000 || t - last > 1000)) { cur = 0; first = t; }
      if (!cur) first = t;
      last = t;
      cur += e.value;
      window.__cls.worst = Math.max(window.__cls.worst, cur);
      for (const s of (e.sources || [])) {
        const n = s.node;
        if (!n || !n.tagName) continue;
        const id = n.id ? '#' + n.id : '';
        const cl = typeof n.className === 'string' && n.className.trim()
          ? '.' + n.className.trim().split(/\\s+/).slice(0, 2).join('.') : '';
        window.__cls.sources.push({ tag: n.tagName.toLowerCase() + id + cl, value: +e.value.toFixed(4) });
      }
    }
  }).observe({ type: 'layout-shift', buffered: true });
  return 1;
})()`;

/** Session-window CLS for one app root at 390x844 under throttling. */
async function measureStartupShift(cdpPort, base, app) {
  const s = await newPage(cdpPort);
  try {
    await interceptNetwork(s, (url) => (FIREBASE_HOSTS.test(url) ? 'fail' : null));
    await s.send('Emulation.setDeviceMetricsOverride', {
      width: 390, height: 844, deviceScaleFactor: 3, mobile: true,
    });
    await s.send('Network.setCacheDisabled', { cacheDisabled: true });
    await s.send('Network.emulateNetworkConditions', {
      offline: false, latency: 150,
      downloadThroughput: 1.6 * 1024 * 1024 / 8, uploadThroughput: 750 * 1024 / 8,
    });
    await s.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    // Same reason as the budgets above: a startup measured against another
    // suite's leftover data is not this app's startup. Cleared on a first
    // visit, then the observer runs on the reload.
    await goto(s, `${base}/apps/${app}/index.html`, { settle: 500 });
    await evalAsync(s, `(async()=>{ try{
      const regs = await navigator.serviceWorker.getRegistrations();
      for (const r of regs) await r.unregister();
      for (const k of await caches.keys()) await caches.delete(k);
      localStorage.clear();
      sessionStorage.clear();
      return 1; } catch(e){ return 0; } })()`);
    await s.send('Page.addScriptToEvaluateOnNewDocument', { source: CLS_OBSERVER });
    await goto(s, `${base}/apps/${app}/index.html`, { settle: 0 });
    await sleep(9000);
    const cls = JSON.parse(await evaluate(s, 'JSON.stringify(window.__cls || {worst:0,sources:[]})'));
    const top = {};
    for (const src of (cls.sources || [])) top[src.tag] = (top[src.tag] || 0) + src.value;
    const named = Object.entries(top).sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([k, v]) => `${k} ${v.toFixed(3)}`).join(', ');
    return { cls: cls.worst || 0, named };
  } finally {
    // The overrides live on this target; the page is closed either way.
    await closePage(cdpPort, s);
  }
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
        // Clear everything an EARLIER SUITE could have left on this origin,
        // then measure the reload. Service workers and the Cache API were
        // already cleared here; STORED APP DATA was not, and that is the
        // difference between measuring a page and measuring the residue of
        // whatever ran before it. The header above claims these numbers are
        // "bit-for-bit stable run to run", and they were - until the shard
        // packing changed and perf landed after a suite that seeds trips,
        // which rendered a populated timeline and pushed the Trip Planner's
        // DOM count from ~940 to 1,729 against a 1,300 budget. A budget that
        // depends on execution order is not a budget.
        await evalAsync(s, `(async()=>{ try{
          const regs = await navigator.serviceWorker.getRegistrations();
          for (const r of regs) await r.unregister();
          for (const k of await caches.keys()) await caches.delete(k);
          localStorage.clear();
          sessionStorage.clear();
          if (indexedDB.databases) {
            for (const db of await indexedDB.databases()) {
              if (db.name) indexedDB.deleteDatabase(db.name);
            }
          }
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
  t('perf rising-shows contract: boot fetches shows-index.json exactly once',
    has(c.boot, 'shows-index.json') === 1, details(c.boot));
  t('perf rising-shows contract: boot never fetches the season-level data-index.json',
    Array.isArray(c.boot) && has(c.boot, 'data-index.json') === 0, details(c.boot));
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
      && has(c.legacyBoot, 'shows-index.json') === 1, details(c.legacyBoot));

  // ------------------------------------------------- partition failures ---
  // Since the F08 split a show's SEASON records arrive with its detail file,
  // so a failed detail fetch is no longer only "no episode curves" - it is the
  // season table itself. The modal has to stay truthful: real counts from the
  // boot index, an explicit notice, and a retry that repairs it.
  const j = (v) => { try { return JSON.parse(v); } catch { return null; } };
  const deg = j(c.degraded);
  t('perf rising-shows: a show whose partition 404s still opens, with its real season rows',
    !!deg && deg.open && deg.rows >= 1 && deg.title === 'Fixture Alpha',
    deg ? `open=${deg.open} rows=${deg.rows} title="${deg.title}"` : `not measured: ${c.error || 'unknown'}`);
  t('perf rising-shows: a failed partition says so and offers a retry, and never prints "0 eps"',
    !!deg && deg.notice && deg.retry && !deg.zeroEps,
    deg ? `notice=${deg.notice} retry=${deg.retry} zeroEps=${deg.zeroEps}` : `not measured: ${c.error || 'unknown'}`);
  const ret = j(c.retried);
  t('perf rising-shows: retrying a recovered partition clears the notice in place',
    !!ret && ret.notice === false && ret.rows >= 1,
    ret ? `notice=${ret.notice} rows=${ret.rows}` : `not measured: ${c.error || 'unknown'}`);
  const cor = j(c.corrupt);
  t('perf rising-shows: a corrupt partition body degrades like a missing one',
    !!cor && cor.open && cor.rows >= 1 && cor.notice && !cor.zeroEps,
    cor ? `open=${cor.open} rows=${cor.rows} notice=${cor.notice} zeroEps=${cor.zeroEps}` : `not measured: ${c.error || 'unknown'}`);
  const pre = j(c.presplit);
  t('perf rising-shows: a pre-split detail file (stale cache, rollback) degrades truthfully',
    !!pre && pre.open && pre.rows >= 1 && !pre.zeroEps,
    pre ? `open=${pre.open} rows=${pre.rows} zeroEps=${pre.zeroEps}` : `not measured: ${c.error || 'unknown'}`);

  // ------------------------------------------------ loading behaviour -----
  const typed = j(c.earlyTyping);
  t('perf rising-shows: a query typed during load survives into the rendered grid',
    !!typed && typed.value === 'Beta' && typed.count === 1 && /Beta/.test(typed.titles.join(' ')),
    typed ? `value="${typed.value}" count=${typed.count} titles=${typed.titles.join('|')}` : `not measured: ${c.error || 'unknown'}`);
  t('perf rising-shows: a season permalink fetches exactly that one show\'s partition',
    Array.isArray(c.seasonLink)
      && c.seasonLink.filter((u) => u.startsWith('data/detail/')).length === 1
      && c.seasonLink.includes('data/detail/tt9000002.json'),
    details(c.seasonLink));
  const sm = j(c.seasonModal);
  t('perf rising-shows: and opens that season, not the grid',
    !!sm && sm.open,
    sm ? `open=${sm.open} text="${sm.text.slice(0, 60)}"` : `not measured: ${c.error || 'unknown'}`);

  // --------------------------------------------------- startup stability ---
  // Every app root, not only the three the audit measured: a budget that
  // covers the apps that were bad and not the ones that were fine tests the
  // fix rather than the property.
  for (const app of ['arena', 'football-h2h', 'fpl-planner', 'gym-tracker',
    'maptap-rivals', 'mario-kart', 'quotescout', 'rising-shows', 'trip-planner']) {
    try {
      const m = await measureStartupShift(cdpPort, base, app);
      t(`perf ${app}: startup layout shift within budget (390x844, throttled)`,
        m.cls <= CLS_BUDGET,
        `session-window CLS ${m.cls.toFixed(3)} (budget ${CLS_BUDGET})`
        + (m.named ? ` - moved: ${m.named}` : ''));
    } catch (e) {
      t(`perf ${app}: startup layout shift within budget (390x844, throttled)`,
        false, `measurement failed: ${String(e && e.message).slice(0, 160)}`);
    }
  }

  return R;
}
