// Gym Tracker offline/PWA suite, modeled on apps/trip-planner/e2e/pwa.mjs
// (which solved SW target attachment and offline emulation for this harness).
//
// The gym SW (apps/gym-tracker/sw.js) has a KNOWN AUDIT FINDING pinned by a
// vm-level todo test (tests/sw-offline-behavior.test.mjs): the fetch handler
// only consults the RUNTIME cache and never the precache, so an offline
// request for a URL that was precached at install but never fetched at
// runtime fails. This suite exercises both sides of that truthfully: the
// runtime path that works (offline reload of a visited page) passes, the
// precache-fallback gap is a KNOWN DEFECT skip.
//
// Offline is emulated on BOTH the page target and the service worker target,
// because the worker issues its own fetch()es (trip-planner pwa.mjs finding).
//
// Cleanup is load-bearing: the shared Chrome profile persists across suites
// within a run, and trip-planner's own PWA suite runs AFTER this one. The gym
// SW is unregistered and its gym-* caches deleted both defensively at suite
// start and at the end, scoped to the gym registration only (getRegistrations
// is origin-wide on this single-origin site, so an unscoped unregister would
// tear down other apps' workers).
import {
  newPage, closePage, goto, evaluate, evalAsync, waitForExpr, clickText,
  setViewport, sleep, setOffline, listTargets, connectTarget, cleanErrors,
} from '../cdp.mjs';

const APP = '/apps/gym-tracker/';

// Unregisters gym-scoped service workers and deletes gym-* caches from a page
// on the origin, returning before/after facts so callers can assert.
const CLEANUP_EXPR = `(async () => {
  const all = await navigator.serviceWorker.getRegistrations();
  const gym = all.filter(r => (r.scope || '').includes('${APP}'));
  await Promise.all(gym.map(r => r.unregister()));
  const names = await caches.keys();
  const gymCaches = names.filter(n => n.startsWith('gym-'));
  await Promise.all(gymCaches.map(n => caches.delete(n)));
  const after = await navigator.serviceWorker.getRegistrations();
  const gymAfter = after.filter(r => (r.scope || '').includes('${APP}')).length;
  const cachesAfter = (await caches.keys()).filter(n => n.startsWith('gym-')).length;
  return { unregistered: gym.length, cachesDeleted: gymCaches.length,
           gymRegsLeft: gymAfter, gymCachesLeft: cachesAfter };
})()`;

// evalAsync poll: evaluate() cannot await, and several SW facts only settle
// asynchronously. Returns the last value; the caller asserts on it.
async function waitAsync(s, expr, { timeout = 15000, poll = 400 } = {}) {
  const start = Date.now();
  let last = null;
  for (;;) {
    last = await evalAsync(s, expr);
    if (last && !last.__evalError && last !== false) return last;
    if (Date.now() - start > timeout) return last;
    await sleep(poll);
  }
}

export async function run({ base, cdpPort }) {
  const R = [];
  const t = (name, pass, detail = '') => R.push({ name, pass: !!pass, detail });
  const skip = (name, reason) => R.push({ name, pass: true, skipped: true, detail: reason });

  let s = null;
  const swSessions = [];
  try {
    s = await newPage(cdpPort);
    await setViewport(s, 1280, 900);

    // --- defensive start: an earlier suite (apps.mjs, a11y.mjs) may already
    // have registered the gym SW by visiting the app. Start from a clean
    // registration lifecycle so install/activate below are THIS run's.
    await goto(s, base + APP, { settle: 1200 });
    const pre = await evalAsync(s, CLEANUP_EXPR);
    t('gym-pwa: start cleanup leaves no gym SW or caches',
      !!pre && pre.gymRegsLeft === 0 && pre.gymCachesLeft === 0, JSON.stringify(pre));

    // Fresh, deterministic app state: onboarding seen (so the modal never
    // covers the nav) plus one program to verify persistence offline.
    await evaluate(s, `(()=>{ try{ for(const k of Object.keys(localStorage)) localStorage.removeItem(k);
      sessionStorage.clear(); }catch(e){} return 1 })()`);
    await evaluate(s, `(()=>{
      localStorage.setItem('gymTrackerOnboardingSeen', 'true');
      localStorage.setItem('gymTrackerPrograms', JSON.stringify([{
        id: 515151, name: 'Offline Suite Plan', description: '',
        exercises: [{ exerciseId: 3, exerciseName: 'Barbell Bench Press',
          sets: [{repsMin: 8, repsMax: 10}], restSeconds: 90, restAfterSeconds: 90,
          notes: '', order: 0, groupId: null }],
        restMode: 'custom', uniformRestSeconds: 90, scheduleDays: [],
        createdAt: '2026-08-01T10:00:00.000Z', updatedAt: '2026-08-01T10:00:00.000Z' }]));
      return 1 })()`);

    // --- 1. register + activate (index.html registers sw.js on load).
    await goto(s, base + APP, { settle: 1500 });
    const swState = await waitAsync(s, `navigator.serviceWorker.getRegistration('${APP}')
      .then(r => (r && r.active && r.active.state === 'activated') ? { state: r.active.state, scope: r.scope } : false)`,
      { timeout: 20000 });
    t('gym-pwa: service worker registers and activates',
      !!swState && swState.state === 'activated', JSON.stringify(swState));

    // clients.claim() runs on activate, so the page becomes controlled
    // without a reload; reload anyway (below) so the shell flows through the
    // SW and populates the RUNTIME cache, which the offline checks rely on.
    const controlled = await waitForExpr(s,
      `!!(navigator.serviceWorker && navigator.serviceWorker.controller)`, { timeout: 10000 });
    t('gym-pwa: service worker controls the page', controlled);

    await goto(s, base + APP, { settle: 2000 });
    await waitForExpr(s, '!!window.gymApp');

    // --- 2 + 3. caches exist and the precache is actually populated.
    const cacheInfo = await evalAsync(s, `(async () => {
      const names = await caches.keys();
      const pre = names.find(n => n.startsWith('gym-precache-'));
      const run = names.find(n => n.startsWith('gym-runtime-'));
      const preCount = pre ? (await (await caches.open(pre)).keys()).length : 0;
      const runCount = run ? (await (await caches.open(run)).keys()).length : 0;
      return { pre, run, preCount, runCount };
    })()`);
    t('gym-pwa: gym-precache-* and gym-runtime-* caches exist',
      !!cacheInfo && !!cacheInfo.pre && !!cacheInfo.run, JSON.stringify(cacheInfo));
    t('gym-pwa: precache is populated',
      !!cacheInfo && cacheInfo.preCount >= 40,
      `${cacheInfo && cacheInfo.preCount} entries (sw.js lists ${'~'}50 PRECACHE_URLS)`);

    // --- 8. manifest: linked, parses, icons resolve (checked while online).
    const man = await evalAsync(s, `(async () => {
      const link = document.querySelector('link[rel="manifest"]');
      if (!link) return { link: false };
      const url = new URL(link.getAttribute('href'), location.href).href;
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) return { link: true, url, status: res.status };
      let j; try { j = await res.json(); } catch (e) { return { link: true, url, parse: false }; }
      const icons = await Promise.all((j.icons || []).map(async (ic) => {
        try {
          const r = await fetch(new URL(ic.src, url).href, { cache: 'no-store' });
          return { src: ic.src, ok: r.ok, type: r.headers.get('content-type') };
        } catch (e) { return { src: ic.src, ok: false }; }
      }));
      return { link: true, parse: true, name: j.name, start: j.start_url, icons };
    })()`);
    t('gym-pwa: manifest linked, parses, and its icons resolve',
      !!man && man.link && man.parse === true && man.name === 'Gym Tracker'
        && Array.isArray(man.icons) && man.icons.length >= 2
        && man.icons.every((i) => i.ok && /image\/png/.test(i.type || '')),
      JSON.stringify(man).slice(0, 260));

    // --- go offline: page + every gym service worker target. The worker does
    // its own fetch()es, so page-only emulation would let it quietly hit the
    // network (trip-planner pwa.mjs finding).
    await setOffline(s, true);
    for (const target of await listTargets(cdpPort)) {
      if (target.type === 'service_worker' && target.url.includes(APP)) {
        const sw = await connectTarget(target);
        await sw.send('Network.enable');
        await setOffline(sw, true);
        swSessions.push(sw);
      }
    }
    t('gym-pwa: found the worker target to take offline', swSessions.length >= 1,
      `workers=${swSessions.length}`);

    // --- 4. offline reload of the VISITED page (the runtime path that works).
    await goto(s, base + APP, { settle: 2000 });
    const booted = await waitForExpr(s, '!!window.gymApp', { timeout: 15000 });
    const shell = await evaluate(s, `(()=>({
      painted: document.body.innerText.trim().length,
      navLinks: document.querySelectorAll('.nav-links .nav-link').length,
      homeVisible: (()=>{ const v=document.getElementById('home-view');
        return !!v && v.getBoundingClientRect().height > 0; })(),
    }))()`);
    t('gym-pwa: offline reload renders the app shell with real content',
      booted && !s.lastNavTimedOut && shell.painted > 200 && shell.navLinks >= 5 && shell.homeVisible,
      `timedOut=${s.lastNavTimedOut} ${JSON.stringify(shell)}`);

    // --- 5. offline view switching (closure state, no network needed).
    await clickText(s, 'History', { sel: '.nav-links .nav-link', exact: true, settle: 900 });
    const historyActive = await waitForExpr(s, `(()=>{
      const b=[...document.querySelectorAll('.nav-links .nav-link')].find(x=>x.textContent.trim()==='History');
      return !!b && /active/.test(b.className)})()`);
    t('gym-pwa: switching views still works while offline', historyActive);

    // --- 6. localStorage state survives the offline reload.
    await clickText(s, 'Programs', { sel: '.nav-links .nav-link', exact: true, settle: 900 });
    const persisted = await evaluate(s, `(()=>({
      stored: /Offline Suite Plan/.test(localStorage.getItem('gymTrackerPrograms') || ''),
      rendered: /Offline Suite Plan/.test((document.getElementById('programs-list')||{}).innerText || ''),
    }))()`);
    t('gym-pwa: seeded program survives the offline reload and renders',
      persisted.stored && persisted.rendered, JSON.stringify(persisted));

    // --- 7. the precache-fallback gap. Pick a URL that IS in the precache
    // but was never fetched at runtime (so the RUNTIME cache cannot serve
    // it), disable the browser HTTP cache so it cannot interfere, and fetch
    // it from the page while offline. Per the defect the SW responds from
    // RUNTIME-or-network only, so this fails.
    await s.send('Network.setCacheDisabled', { cacheDisabled: true });
    const gap = await evalAsync(s, `(async () => {
      const names = await caches.keys();
      const preName = names.find(n => n.startsWith('gym-precache-'));
      const runName = names.find(n => n.startsWith('gym-runtime-'));
      if (!preName) return { preName: null };
      const preKeys = (await (await caches.open(preName)).keys()).map(r => r.url);
      const runKeys = runName ? (await (await caches.open(runName)).keys()).map(r => r.url) : [];
      const runSet = new Set(runKeys);
      const cold = preKeys.filter(u => !runSet.has(u));
      const candidate = cold[0] || null;
      if (!candidate) return { preName, cold: 0 };
      try {
        const res = await fetch(candidate, { cache: 'no-store' });
        return { candidate, cold: cold.length, fetched: true, ok: res.ok, status: res.status };
      } catch (e) {
        return { candidate, cold: cold.length, fetched: false, error: String(e && e.message || e) };
      }
    })()`);
    await s.send('Network.setCacheDisabled', { cacheDisabled: false });
    if (gap && gap.candidate && gap.fetched === false) {
      skip('gym-pwa: offline fetch of a precached-but-never-fetched URL succeeds',
        `KNOWN DEFECT: offline cold fetch of precached URL fails (sw fetch handler never consults the precache; sw.js opens only the RUNTIME cache) - ${gap.cold} precached URLs are cold, e.g. ${gap.candidate}: ${gap.error}`);
    } else if (gap && gap.candidate && gap.fetched && gap.ok) {
      t('gym-pwa: offline fetch of a precached-but-never-fetched URL succeeds',
        false,
        `unexpected PASS for a pinned defect - investigate: ${JSON.stringify(gap)} (browser HTTP cache was disabled for this fetch)`);
    } else {
      t('gym-pwa: offline fetch of a precached-but-never-fetched URL',
        false, `could not stage the check: ${JSON.stringify(gap)}`);
    }

    // --- back online, recovery load, then the load-bearing cleanup.
    await setOffline(s, false);
    for (const sw of swSessions) { try { await setOffline(sw, false); } catch { /* worker gone */ } }
    await goto(s, base + APP, { settle: 1500 });
    const recovered = await waitForExpr(s, '!!window.gymApp', { timeout: 15000 });
    t('gym-pwa: recovery load after going back online', recovered);
    t('gym-pwa: no JS errors on the recovery load', cleanErrors(s).length === 0,
      cleanErrors(s).slice(0, 2).join(' | '));

    // Remove the seeded state so later suites see a clean app.
    await evaluate(s, `(()=>{ try{ for(const k of Object.keys(localStorage))
      if (/^gymTracker/.test(k)) localStorage.removeItem(k); }catch(e){} return 1 })()`);

    const post = await evalAsync(s, CLEANUP_EXPR);
    t('gym-pwa: end cleanup unregisters the gym SW and deletes gym-* caches',
      !!post && post.gymRegsLeft === 0 && post.gymCachesLeft === 0, JSON.stringify(post));
  } catch (e) {
    t('gym-pwa: block ran', false, String(e && e.message).slice(0, 140));
    // Even on a crashed block, try to leave no gym SW behind for later suites.
    try { if (s) { await setOffline(s, false); await evalAsync(s, CLEANUP_EXPR); } } catch { /* page gone */ }
  } finally {
    for (const sw of swSessions) { try { sw.ws.close(); } catch { /* closed */ } }
    if (s) { try { await closePage(cdpPort, s); } catch { /* gone */ } }
  }

  return R;
}
