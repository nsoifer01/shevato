// Trip Planner E2E: service worker and offline shell.
//
// What browser-tests CAN pin reliably here:
//   - the worker registers, activates and controls the page
//   - the precache exists and contains the shell pinned at the LIVE build
//     (catches a TP_BUILD / sw.js `?v=` mismatch, the classic deploy trap)
//   - a fully offline reload still boots the app and renders the trip
//
// What deliberately stays in node:test (tests/sw-activate.test.mjs): the
// activate-event cache eviction and update-toast messaging. Driving a real
// redeploy (byte-changed sw.js) inside this harness would be flaky for little
// extra proof.
//
// Offline is emulated on BOTH the page target and the service worker target:
// the worker does its own fetch()es, so page-only emulation would let it
// quietly serve from the network.
import {
  APP, recorder, freshIds, dbOf, standardTrip,
  openApp, tpErrors, closePage, goto, evaluate, evalAsync, waitForExpr, waitReady,
} from './helpers.mjs';
import { listTargets, connectTarget, setOffline } from '../../../tests/browser/cdp.mjs';

export async function run({ base, cdpPort }) {
  const R = [];
  const t = recorder(R);

  let s = null;
  const swSessions = [];
  try {
    freshIds();
    const seed = standardTrip(30, { name: 'Offline trip' });
    s = await openApp(cdpPort, base, { db: dbOf([seed]) });

    const controlled = await waitForExpr(s, `navigator.serviceWorker && navigator.serviceWorker.controller`, { timeout: 15000 });
    await t('tp-pwa: service worker controls the page', controlled, '', s);

    const cacheInfo = await evalAsync(s, `(async () => {
      const names = await caches.keys();
      const pre = names.find(n => n.startsWith('trip-precache-'));
      if (!pre) return { pre: null, names };
      const c = await caches.open(pre);
      const shell = await c.match('${APP}index.html');
      const app = await c.match('${APP}js/app.js?v=' + window.__TP_BUILD);
      const logic = (await c.keys()).some(r => r.url.includes('trip-logic.js'));
      const airports = await c.match('${APP}data/airports.json');
      return { pre, shell: !!shell, app: !!app, logic, airports: !!airports };
    })()`);
    await t('tp-pwa: precache holds the app shell', !!cacheInfo && !!cacheInfo.pre && cacheInfo.shell && cacheInfo.logic && cacheInfo.airports, JSON.stringify(cacheInfo), s);
    await t('tp-pwa: precached app.js matches the live TP_BUILD pin', !!cacheInfo && cacheInfo.app === true, JSON.stringify(cacheInfo), s);

    // go fully offline: page + every trip-planner service worker target
    await setOffline(s, true);
    for (const target of await listTargets(cdpPort)) {
      if (target.type === 'service_worker' && target.url.includes('/apps/trip-planner/')) {
        const sw = await connectTarget(target);
        await sw.send('Network.enable');
        await setOffline(sw, true);
        swSessions.push(sw);
      }
    }
    await t('tp-pwa: found the worker target to take offline', swSessions.length >= 1, `workers=${swSessions.length}`, s);

    await goto(s, base + APP, { settle: 1500 });
    const booted = await waitReady(s, 15000);
    await t('tp-pwa: offline reload still boots the app', booted, '', s);
    await t('tp-pwa: offline timeline renders the saved trip', await evaluate(s, `document.getElementById('board') && document.getElementById('board').innerText.includes('Tokyo Grand Hotel')`), '', s);
    await t('tp-pwa: offline shell keeps the toolbar usable', await evaluate(s, `(()=>{const b=document.getElementById('addBtn'); return !!b && b.offsetParent !== null})()`), '', s);

    // back online: the same tab recovers on the next load
    await setOffline(s, false);
    for (const sw of swSessions) { try { await setOffline(sw, false); } catch { /* worker gone */ } }
    await goto(s, base + APP, { settle: 1200 });
    await t('tp-pwa: recovery load after going back online', await waitReady(s), '', s);
    await t('tp-pwa: no page errors', tpErrors(s).length === 0, tpErrors(s).slice(0, 2).join(' | '), s);
  } catch (e) {
    await t('tp-pwa: block ran', false, String(e && e.message).slice(0, 140), s);
  } finally {
    for (const sw of swSessions) { try { sw.ws.close(); } catch { /* closed */ } }
    if (s) try { await closePage(cdpPort, s); } catch { /* gone */ }
  }

  return R;
}
