// Evidence for issue #676: on rare full parallel runs a Gym Tracker boot
// loads its HTML under the service worker but js/app.js never runs
// (window.gymApp stays unset, no console error). This records what that boot
// actually received, so one failure is enough to find the cause.
//
// It never changes the boot: the CDP listeners only observe events the page
// session already has enabled, and the report runs only after the boot's own
// settle, only when window.gymApp is missing, and only reads (no fetch, no
// cache writes, no storage writes). It never asserts and swallows its own
// errors, so the suite's checks fail or pass exactly as they would without it.
//
// A report is printed on one `GYM-BOOT-DIAG` line and written to
// .screenshots/gym-boot-diag/, which CI's "Keep failure screenshots" step
// uploads as the browser-shard-<n>-screenshots artifact.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..');
const OUT_DIR = path.join(REPO, '.screenshots', 'gym-boot-diag');
const MAX_ENTRIES = 200;

/** Start recording this page's Gym requests, console output and navigations. */
export function armBootDiagnostic(s) {
  if (s.gymBootDiag) return;
  const d = s.gymBootDiag = { reqs: new Map(), logs: [], navs: [], documentId: null };
  const push = (list, v) => { if (list.length < MAX_ENTRIES) list.push(v); };
  s.on((m, p) => {
    if (m === 'Page.frameNavigated' && !p.frame.parentId) {
      push(d.navs, `${new Date().toISOString()} ${p.frame.url}`);
    } else if (m === 'Log.entryAdded') {
      push(d.logs, `${p.entry.level} ${p.entry.source}: ${p.entry.text}${p.entry.url ? ` (${p.entry.url})` : ''}`);
    } else if (m === 'Runtime.consoleAPICalled') {
      push(d.logs, `console.${p.type}: ${(p.args || []).map((a) => a.value ?? a.description).join(' ')}`);
    } else if (m === 'Runtime.exceptionThrown') {
      const e = p.exceptionDetails;
      push(d.logs, `exception: ${(e.exception && e.exception.description) || e.text}`);
    } else if (m === 'Network.requestWillBeSent' && p.request.url.includes('/gym-tracker/')) {
      if (p.type === 'Document') d.documentId = p.requestId;
      if (d.reqs.size < MAX_ENTRIES) d.reqs.set(p.requestId, { url: p.request.url, type: p.type, events: [] });
    } else if (m === 'Network.responseReceived' && d.reqs.has(p.requestId)) {
      const r = p.response;
      d.reqs.get(p.requestId).events.push(`response ${r.status} fromServiceWorker=${!!r.fromServiceWorker}`
        + ` source=${r.serviceWorkerResponseSource || '-'} cacheStorage=${r.cacheStorageCacheName || '-'}`);
    } else if (m === 'Network.loadingFinished' && d.reqs.has(p.requestId)) {
      d.reqs.get(p.requestId).events.push(`finished encodedDataLength=${p.encodedDataLength}`);
    } else if (m === 'Network.loadingFailed' && d.reqs.has(p.requestId)) {
      d.reqs.get(p.requestId).events.push(`FAILED ${p.errorText} canceled=${!!p.canceled} blocked=${p.blockedReason || '-'}`);
    }
  });
}

/** Forget what earlier navigations recorded, so a report covers one boot. */
export function resetBootDiagnostic(s) {
  const d = s.gymBootDiag;
  if (!d) return;
  d.reqs.clear(); d.logs.length = 0; d.navs.length = 0; d.documentId = null;
}

// Read-only page state. Built as a string so it runs in the page.
const PAGE_STATE = `(async () => {
  const html = document.documentElement.outerHTML;
  const nav = performance.getEntriesByType('navigation')[0];
  const out = {
    href: location.href, readyState: document.readyState, now: Math.round(performance.now()),
    controlled: !!(navigator.serviceWorker && navigator.serviceWorker.controller),
    navigation: nav && { type: nav.type, status: nav.responseStatus, transferSize: nav.transferSize,
      encodedBodySize: nav.encodedBodySize, decodedBodySize: nav.decodedBodySize,
      domContentLoaded: Math.round(nav.domContentLoadedEventEnd), load: Math.round(nav.loadEventEnd) },
    domLength: html.length, domTail: html.slice(-400),
    appScriptTag: !!document.querySelector('script[type="module"][src$="js/app.js"]'),
    moduleScripts: [...document.scripts].filter((x) => x.type === 'module').map((x) => x.getAttribute('src')),
    gymResources: performance.getEntriesByType('resource').filter((r) => r.name.includes('/gym-tracker/'))
      .map((r) => [r.name.split('/gym-tracker/').pop(), Math.round(r.startTime), Math.round(r.duration), r.responseStatus, r.transferSize, r.decodedBodySize]),
    caches: [], registration: null,
  };
  try {
    const url = new URL('js/app.js', location.href).href;
    for (const name of await caches.keys()) {
      const hit = await (await caches.open(name)).match(url);
      out.caches.push([name, hit ? hit.status + ' ' + (await hit.text()).length + ' bytes' : 'no js/app.js']);
    }
  } catch (e) { out.caches.push(['error', String(e)]); }
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    out.registration = reg && { active: reg.active && reg.active.state, waiting: !!reg.waiting, installing: !!reg.installing };
  } catch (e) { out.registration = String(e); }
  return out;
})()`;

/**
 * After a boot's settle: if the app did not start, write and print what the
 * page received. Returns the report (or null when the app booted).
 */
export async function reportFailedBoot(s, label) {
  try {
    const booted = await s.send('Runtime.evaluate', { expression: '!!window.gymApp', returnByValue: true });
    if (booted.result && booted.result.value === true) return null;
    const d = s.gymBootDiag || { reqs: new Map(), logs: [], navs: [], documentId: null };
    const report = { scenario: label, at: new Date().toISOString(), page: null, document: null };
    try {
      const r = await s.send('Runtime.evaluate', { expression: PAGE_STATE, awaitPromise: true, returnByValue: true });
      report.page = r.exceptionDetails ? `error: ${r.exceptionDetails.text}` : r.result.value;
    } catch (e) { report.page = `error: ${e.message}`; }
    // The HTML exactly as the browser received it (CDP keeps the body).
    if (d.documentId) {
      try {
        const b = await s.send('Network.getResponseBody', { requestId: d.documentId });
        const body = b.base64Encoded ? Buffer.from(b.body, 'base64').toString('utf8') : b.body;
        report.document = { bytes: Buffer.byteLength(body), tail: body.slice(-400),
          hasAppScript: body.includes('src="js/app.js"'), endsWithHtml: /<\/html>\s*$/i.test(body) };
      } catch (e) { report.document = `error: ${e.message}`; }
    }
    report.requests = [...d.reqs.values()];
    report.unfinished = report.requests.filter((r) => !r.events.some((e) => e.startsWith('finished'))).map((r) => r.url);
    report.console = d.logs;
    report.navigations = d.navs;
    report.netFails = s.netFails ? [...s.netFails] : [];
    let file = null;
    try {
      mkdirSync(OUT_DIR, { recursive: true });
      file = path.join(OUT_DIR, `${label.replace(/[^\w.-]+/g, '-')}-${Date.now()}.json`);
      writeFileSync(file, JSON.stringify(report, null, 2));
    } catch { file = null; }
    // The CI log gets the deciding facts; the artifact has everything.
    const pg = report.page && typeof report.page === 'object' ? report.page : {};
    console.log(`GYM-BOOT-DIAG ${JSON.stringify({
      scenario: label, file: file && path.relative(REPO, file), href: pg.href, controlled: pg.controlled,
      navigation: pg.navigation, appScriptTag: pg.appScriptTag, moduleScripts: pg.moduleScripts && pg.moduleScripts.length,
      domTail: pg.domTail && pg.domTail.slice(-120), document: report.document && typeof report.document === 'object'
        ? { bytes: report.document.bytes, hasAppScript: report.document.hasAppScript, endsWithHtml: report.document.endsWithHtml }
        : report.document,
      documentResponse: (report.requests.find((r) => r.type === 'Document') || {}).events,
      appJs: report.requests.filter((r) => r.url.endsWith('/js/app.js')).map((r) => r.events),
      requests: report.requests.length, unfinished: report.unfinished.slice(0, 10),
      failed: report.requests.filter((r) => r.events.some((e) => e.startsWith('FAILED'))).map((r) => r.url).slice(0, 10),
      caches: pg.caches, registration: pg.registration,
      console: report.console.filter((l) => !l.startsWith('console.log')).slice(0, 15),
    })}`);
    return report;
  } catch {
    return null;
  }
}
