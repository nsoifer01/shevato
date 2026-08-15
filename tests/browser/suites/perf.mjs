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
// rising-shows exception: data-index.json and data/show-modal-extras.json
// (~102 MB together) are gitignored, pulled from a GitHub release, and absent
// on a clean clone, so their bytes are excluded from that page's byte total.
// The budget there governs the page's CODE weight, which is what this repo
// owns; dataset growth is owned by the data-release pipeline.
import { newPage, closePage, goto, evaluate, evalAsync, setViewport, sleep } from '../cdp.mjs';

// Measured 2026-08-15 (local python server, cache disabled, SW cleared;
// identical across 3 runs). bytes = same-origin encodedBodySize incl. the
// document; reqs = same-origin requests incl. the document; dom = total
// element count. rising-shows measured with the dataset present: 103,499,537
// raw bytes, 1,629,689 after the dataset exclusion above; its DOM (1,175) and
// request count (36) are dataset-present ceilings, and a clean clone only
// measures lower.
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
//                rising-shows       1,629,689*    36  1,175   (*code only)
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
  'rising-shows':  { path: '/apps/rising-shows/',   bytes: 2_450_000, reqs: 54,  dom: 1_800 },
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

// Gitignored rising-shows dataset payloads, excluded from byte accounting.
const RS_DATASET = /\/apps\/rising-shows\/(data\.json|data-index\.json|data\/)/;

export async function run({ base, cdpPort }) {
  const R = [];
  const t = (name, pass, detail = '') => R.push({ name, pass: !!pass, detail });

  const s = await newPage(cdpPort);
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
          const counted=res.filter(r=>!${RS_DATASET}.test(r.name));
          const sum=(a,f)=>a.reduce((t2,x)=>t2+(x[f]||0),0);
          const js=res.filter(r=>/\\.m?js(\\?|$)/.test(r.name));
          return {
            bytes: sum(counted,'encodedBodySize') + (nav?nav.encodedBodySize:0),
            reqs: res.length + 1,
            jsBytes: sum(js,'encodedBodySize'),
            dom: document.querySelectorAll('*').length,
            dcl: nav?Math.round(nav.domContentLoadedEventEnd-nav.startTime):null };})()`);

        t(`perf ${name}: first-party bytes within budget`,
          m && m.bytes > 0 && m.bytes <= b.bytes, `${m && m.bytes} of ${b.bytes}`);
        t(`perf ${name}: same-origin request count within budget`,
          m && m.reqs > 1 && m.reqs <= b.reqs, `${m && m.reqs} of ${b.reqs}`);
        t(`perf ${name}: DOM size within budget`,
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
  return R;
}
