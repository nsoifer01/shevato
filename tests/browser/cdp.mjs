// Minimal CDP driver. Node 20 needs --experimental-websocket for global WebSocket.
import http from 'node:http';

// ---------------------------------------------------------------------------
// Wait accounting.
//
// Every suite's wall clock is mostly waiting, and the three kinds of waiting
// are not equally defensible: a FIXED sleep burns its full duration whether or
// not the page was ready, a CONDITION poll stops the moment the page says yes,
// and NAVIGATION is the page actually loading. Reading source and adding up
// `sleep(...)` literals only ever gives a lower bound (it cannot see how many
// times a loop ran), so the counters below record what actually elapsed.
//
// run.mjs snapshots them around each suite and prints the breakdown. They are
// two additions on paths that are already awaiting a timer, so leaving them on
// costs nothing measurable.
export const waitStats = { fixedMs: 0, pollMs: 0, navMs: 0, gotos: 0, polls: 0 };
export function snapshotWaits() { return { ...waitStats }; }
export function waitsSince(before) {
  const now = waitStats;
  return {
    fixedMs: now.fixedMs - before.fixedMs, pollMs: now.pollMs - before.pollMs,
    navMs: now.navMs - before.navMs, gotos: now.gotos - before.gotos,
    polls: now.polls - before.polls,
  };
}

// The un-counted primitive. Only the polling loops use it, because their
// waiting is bounded by a condition rather than spent unconditionally.
const rawSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The counted one. Everything a suite does deliberately - goto settle, click
// settle, an explicit sleep in a suite - goes through here.
const sleep = (ms) => { waitStats.fixedMs += ms; return rawSleep(ms); };

function httpJson(port, path, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        try { resolve(JSON.parse(b)); } catch (e) { reject(new Error(`${method} ${path}: ${b.slice(0, 120)}`)); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

export async function waitForBrowser(port, timeoutMs = 30000) {
  const start = Date.now();
  for (;;) {
    try { return await httpJson(port, '/json/version'); }
    catch { if (Date.now() - start > timeoutMs) throw new Error('browser never came up'); await rawSleep(250); }
  }
}

export class Session {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
      } else if (msg.method) {
        for (const h of this.handlers) h(msg.method, msg.params);
      }
    });
  }
  on(fn) { this.handlers.push(fn); }
  // Removes a handler registered with on(). goto() relies on this: before it
  // existed every navigation leaked one more load handler, so a long suite
  // dispatched every event through an ever-growing handler list.
  off(fn) {
    const i = this.handlers.indexOf(fn);
    if (i !== -1) this.handlers.splice(i, 1);
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout: ' + method)); }
      }, 45000);
    });
  }
}

// Opens a fresh tab so each page under test gets a clean target.
export async function newPage(port) {
  const target = await httpJson(port, '/json/new?about:blank', 'PUT');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  const s = new Session(ws);
  s.targetId = target.id;
  await s.send('Page.enable');
  await s.send('Runtime.enable');
  await s.send('Log.enable');
  await s.send('Network.enable');
  await s.send('DOM.enable');

  s.errors = [];
  s.netFails = [];
  // requestId -> url, so Network.loadingFailed (which carries no URL of its
  // own) can be attributed. Without the URL a first-party failure was
  // indistinguishable from a blocked analytics beacon.
  s.netReqs = new Map();
  s.on((method, p) => {
    if (method === 'Runtime.exceptionThrown') {
      const d = p.exceptionDetails;
      s.errors.push(String((d.exception && (d.exception.description || d.exception.value)) || d.text));
    } else if (method === 'Log.entryAdded' && p.entry.level === 'error') {
      s.errors.push(String(p.entry.text));
    } else if (method === 'Network.requestWillBeSent') {
      s.netReqs.set(p.requestId, (p.request && p.request.url) || '');
    } else if (method === 'Network.loadingFailed') {
      // Old `${errorText} ${type}` shape kept as the prefix; the URL is
      // appended so firstPartyFailures() can filter by origin.
      const url = s.netReqs.get(p.requestId) || '';
      s.netFails.push(`${p.errorText} ${p.type}${url ? ' ' + url : ''}`);
    } else if (method === 'Network.responseReceived' && p.response.status >= 400) {
      s.netFails.push(`HTTP ${p.response.status} ${p.response.url}`);
    }
  });
  return s;
}

export async function closePage(port, s) {
  try { await httpJson(port, `/json/close/${s.targetId}`); } catch {}
  try { s.ws.close(); } catch {}
}

export async function goto(s, url, { settle = 2500 } = {}) {
  s.errors.length = 0;
  s.netFails.length = 0;
  if (s.netReqs) s.netReqs.clear(); // absent on bare connectTarget() sessions
  s.lastNavTimedOut = false;
  let h;
  const loaded = new Promise((res) => {
    h = (m) => { if (m === 'Page.loadEventFired') res('loaded'); };
    s.on(h);
  });
  const navStart = Date.now();
  try {
    const nav = await s.send('Page.navigate', { url });
    // A SAME-DOCUMENT navigation - navigating from /app/ to /app/#history, say
    // - never fires Page.loadEventFired, because no document is loaded. Racing
    // it against the guard therefore burned the FULL 20 seconds, every time,
    // and then set lastNavTimedOut on a navigation that had actually succeeded
    // instantly. Measured 2026-09-05: 21.4s for a fragment-only goto against
    // 0.45s for a real load, and 420 of the 518 seconds in
    // apps/maptap-rivals/e2e/audit-2026-08.mjs were exactly this.
    //
    // Chromium tells us which kind it was: Page.navigate returns a loaderId
    // for a cross-document navigation and omits it for a same-document one
    // (verified against Page.navigatedWithinDocument / Page.loadEventFired on
    // both paths). So ask, rather than wait for an event that cannot arrive.
    // The caller's `settle` below still runs, which is what gives a hashchange
    // handler its chance to re-render - so this is the same wait as before,
    // minus twenty dead seconds.
    if (nav && nav.loaderId) {
      // The race keeps a dead page from hanging the whole suite, but a timeout
      // must not be silent: callers can check s.lastNavTimedOut after goto.
      // rawSleep for the guard: it is a bound on the load, not waiting we chose
      // to do, and counting 20s of it would swamp the fixed-wait figure.
      const outcome = await Promise.race([loaded, rawSleep(20000).then(() => 'timeout')]);
      s.lastNavTimedOut = outcome === 'timeout';
    }
  } finally {
    // One-shot: without this every navigation leaked a handler (O(n^2) event
    // dispatch over a long suite).
    s.off(h);
  }
  waitStats.navMs += Date.now() - navStart;
  waitStats.gotos += 1;
  await sleep(settle);
}

// Entries from s.netFails whose URL is same-origin with base (the local
// static server). These are the failures that are never environmental noise:
// a first-party 404 or load failure means the site itself references
// something broken. Entries recorded without a URL cannot be attributed and
// are excluded; the recorder in newPage() attaches URLs to everything it can.
export function firstPartyFailures(s, base) {
  let origin;
  try { origin = new URL(base).origin; } catch { origin = String(base); }
  return s.netFails.filter((entry) => {
    const m = String(entry).match(/https?:\/\/\S+/);
    if (!m) return false;
    try { return new URL(m[0]).origin === origin; } catch { return false; }
  });
}

export async function evaluate(s, expression) {
  const r = await s.send('Runtime.evaluate', {
    expression: `(()=>{ try { return JSON.stringify((${expression})); } catch(e) { return JSON.stringify({__evalError: String(e && e.message || e)}); } })()`,
    returnByValue: true, awaitPromise: false,
  });
  const v = r.result && r.result.value;
  if (v == null) return null;
  try { return JSON.parse(v); } catch { return v; }
}

// Awaits a promise-returning expression in the page. evaluate() deliberately
// never awaits (a hung promise would stall the whole suite), so anything that
// must (CompressionStream, caches.keys(), navigator.serviceWorker.ready) comes
// through here, where the driver's own 45s send timeout still bounds it.
export async function evalAsync(s, expression) {
  const r = await s.send('Runtime.evaluate', {
    expression: `(async()=>{ try { return JSON.stringify(await (${expression})); } catch(e) { return JSON.stringify({__evalError: String(e && e.message || e)}); } })()`,
    returnByValue: true, awaitPromise: true,
  });
  const v = r.result && r.result.value;
  if (v == null) return null;
  try { return JSON.parse(v); } catch { return v; }
}

// Waits for an in-page condition instead of sleeping a fixed settle. Returns
// true as soon as the expression is truthy, false on timeout - callers assert
// on the result, so a wait that never comes fails the check rather than
// throwing the suite over.
//
// That contract used to have a hole. It held for a condition that never became
// true, but NOT for the transport: when the renderer is busy enough that
// `Runtime.evaluate` itself hits the driver's 45 s send timeout, the rejection
// propagated straight out of here and aborted whatever section was running -
// the exact "throwing the suite over" this helper exists to prevent. A whole
// Globe Drop block died that way on CI, reporting only "ran to completion
// false", while the same code passed locally.
//
// A send timeout is a SLOW POLL, not a verdict, so it is swallowed and polling
// continues until the CALLER's deadline, which then returns false and lets the
// caller's own assertion speak. Only send timeouts are absorbed: a real page
// error (a closed target, a detached session) still throws, because that is not
// something waiting longer can fix.
//
// Safe to retry precisely here and nowhere else: every expression this helper
// takes is a PREDICATE, evaluated for its truthiness. `evaluate()` keeps
// throwing, because its callers pass side-effecting expressions too.
const isSendTimeout = (e) => /^timeout: /.test(String((e && e.message) || ''));

export async function waitForExpr(s, expression, { timeout = 8000, poll = 150 } = {}) {
  const start = Date.now();
  waitStats.polls += 1;
  try {
    for (;;) {
      let v = null;
      try {
        v = await evaluate(s, expression);
      } catch (e) {
        if (!isSendTimeout(e)) throw e;
        // Fall through to the deadline check: the poll cost us its own wait
        // already, so there is nothing left to sleep off.
      }
      if (v && !v.__evalError) return true;
      if (Date.now() - start > timeout) return false;
      await rawSleep(poll);
    }
  } finally {
    waitStats.pollMs += Date.now() - start;
  }
}

export async function setViewport(s, width, height, mobile = false) {
  await s.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile,
    screenWidth: width, screenHeight: height,
  });
  // Touch emulation follows the mobile flag so 390px runs report touch
  // support the way real phones do (hover:none media queries, maxTouchPoints).
  // Mouse-based Input.dispatchMouseEvent clicks keep working either way.
  try {
    await s.send('Emulation.setTouchEmulationEnabled', { enabled: !!mobile, maxTouchPoints: 5 });
  } catch { /* older Chromium without the method; metrics override still applied */ }
}

// Moves the mouse over the centre of the first element matching sel, without
// clicking, so real hover state (CSS :hover, mouseenter handlers) applies.
export async function hoverSel(s, sel, { nth = 0, settle = 300 } = {}) {
  const box = await evaluate(s, `(()=>{
    const els=[...document.querySelectorAll(${JSON.stringify(sel)})];
    const el=els[${nth}]; if(!el) return null;
    el.scrollIntoView({block:'center',inline:'center'});
    const r=el.getBoundingClientRect();
    if(r.width===0&&r.height===0) return {zero:true};
    return {x:r.left+r.width/2, y:r.top+r.height/2};
  })()`);
  if (!box || box.zero) return false;
  await s.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: Math.round(box.x), y: Math.round(box.y), button: 'none', buttons: 0,
  });
  await sleep(settle);
  return true;
}

// Real coordinate-based click. Respects hit-testing, unlike element.click().
export async function clickAt(s, x, y) {
  const base = { x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, buttons: 1 };
  await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...base, buttons: 0 });
  await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
  await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
}

// Clicks the centre of the first element matching sel, after scrolling it into view.
export async function clickSel(s, sel, { nth = 0, settle = 400 } = {}) {
  const box = await evaluate(s, `(()=>{
    const els=[...document.querySelectorAll(${JSON.stringify(sel)})];
    const el=els[${nth}]; if(!el) return null;
    el.scrollIntoView({block:'center',inline:'center'});
    const r=el.getBoundingClientRect();
    if(r.width===0&&r.height===0) return {zero:true};
    return {x:r.left+r.width/2, y:r.top+r.height/2};
  })()`);
  if (!box || box.zero) return false;
  await clickAt(s, box.x, box.y);
  await sleep(settle);
  return true;
}

export async function typeInto(s, sel, text, { nth = 0 } = {}) {
  const ok = await clickSel(s, sel, { nth, settle: 120 });
  if (!ok) return false;
  await evaluate(s, `(()=>{const e=[...document.querySelectorAll(${JSON.stringify(sel)})][${nth}]; if(e){e.focus(); e.value='';} return 1})()`);
  for (const ch of text) {
    await s.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, unmodifiedText: ch });
    await s.send('Input.dispatchKeyEvent', { type: 'keyUp', text: ch, unmodifiedText: ch });
  }
  // Frameworks here are vanilla, but fire both so listeners on either path see it.
  await evaluate(s, `(()=>{const e=[...document.querySelectorAll(${JSON.stringify(sel)})][${nth}];
    if(e){e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));} return 1})()`);
  await sleep(200);
  return true;
}

export async function setValue(s, sel, value, { nth = 0 } = {}) {
  return evaluate(s, `(()=>{const e=[...document.querySelectorAll(${JSON.stringify(sel)})][${nth}];
    if(!e) return false; e.focus(); e.value=${JSON.stringify(value)};
    e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return true})()`);
}

// modifiers is the CDP bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8.
// text: optional. Without it Chromium treats the keyDown as a rawKeyDown and
// skips default actions, so keys that ACTIVATE things (Enter '\r', Space ' ')
// must pass their text to trigger e.g. a focused button's key-activated click.
export async function pressKey(s, key, code, keyCode, modifiers = 0, text) {
  const p = { key, code: code || key, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers };
  const down = { type: 'keyDown', ...p };
  if (text !== undefined) { down.text = text; down.unmodifiedText = text; }
  await s.send('Input.dispatchKeyEvent', down);
  await s.send('Input.dispatchKeyEvent', { type: 'keyUp', ...p });
  await sleep(150);
}

// Seed storage then boot, because app state is closure-scoped and only read at
// boot.
//
// ONE navigation, not two. localStorage can only be written from a page already
// on the target origin, which is why every seeding helper in this repo grew the
// same "navigate, write, navigate again" shape. CDP removes the constraint:
// Page.addScriptToEvaluateOnNewDocument runs BEFORE any page script on the next
// document, so the seed is already in storage the first and only time the app
// boots.
//
// That is not just faster (one page load and ~900 ms less per call). It closes
// a race the two-navigation shape creates and cannot fully defend against: the
// first navigation boots a REAL instance of the app against unseeded storage,
// and that instance can still write - trip-planner's ensureTrip() sees no trip,
// creates an empty default and saves it, landing after the fixture and
// replacing it. apps/trip-planner/e2e/helpers.mjs carries a verify-and-reseed
// loop for exactly that. With the seed installed before the first document,
// no unseeded instance ever runs, so there is nothing to clobber.
//
// clearPrefix wipes the app's own keys in the same pass, so a caller does not
// need a prior navigation just to clear storage either.
export async function seedAndReload(s, url, kv, { settle = 2500, clearPrefix = null } = {}) {
  const sets = Object.entries(kv).map(([k, v]) =>
    `localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(typeof v === 'string' ? v : JSON.stringify(v))});`).join('');
  const clear = clearPrefix
    ? `for (const k of Object.keys(localStorage)) if (k.indexOf(${JSON.stringify(clearPrefix)}) === 0) localStorage.removeItem(k);`
    : '';
  const source = `(()=>{ try { ${clear}${sets} } catch (e) {} })()`;
  const { identifier } = await s.send('Page.addScriptToEvaluateOnNewDocument', { source });
  try {
    await goto(s, url, { settle });
  } finally {
    // Removed straight away: while installed it would re-seed EVERY subsequent
    // navigation in the suite, which would silently undo anything a test wrote
    // and then reloaded to check.
    try { await s.send('Page.removeScriptToEvaluateOnNewDocument', { identifier }); } catch {}
  }
}

export async function screenshot(s, path) {
  const r = await s.send('Page.captureScreenshot', { format: 'png' });
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path, Buffer.from(r.data, 'base64'));
}

export { sleep };

// Finds a visible clickable by exact-ish text and clicks its centre with FRESH
// coordinates. Text matching survives re-renders that invalidate index-based
// lookups, which is the usual way these suites go wrong.
export async function clickText(s, text, { sel = 'button,a,[role=tab],label', exact = false, settle = 700 } = {}) {
  const box = await evaluate(s, `(()=>{
    const want=${JSON.stringify(text)}.toLowerCase();
    const els=[...document.querySelectorAll(${JSON.stringify(sel)})].filter(e=>{
      const r=e.getBoundingClientRect();
      return r.width>2&&r.height>2&&getComputedStyle(e).visibility!=='hidden'&&!e.disabled;
    });
    const norm=e=>(e.getAttribute('aria-label')||e.textContent||'').replace(/\\s+/g,' ').trim().toLowerCase();
    const el = ${exact ? 'els.find(e=>norm(e)===want)' : 'els.find(e=>norm(e).includes(want))'};
    if(!el) return null;
    el.scrollIntoView({block:'center',inline:'center'});
    const r=el.getBoundingClientRect();
    return {x:r.left+r.width/2, y:r.top+r.height/2};
  })()`);
  if (!box) return false;
  await clickAt(s, box.x, box.y);
  await sleep(settle);
  return true;
}

export async function textPresent(s, needle) {
  return evaluate(s, `document.body.innerText.toLowerCase().includes(${JSON.stringify(String(needle).toLowerCase())})`);
}

export async function count(s, sel) {
  return evaluate(s, `document.querySelectorAll(${JSON.stringify(sel)}).length`);
}

// Resource-load noise from blocked/absent external hosts. Deliberately does
// NOT match "Failed to fetch" style uncaught exceptions: an app fetch dying
// uncaught is a missing catch in the app, which is exactly the kind of thing
// the no-errors assertions exist to surface.
//
// NOISE also swallows "Failed to load resource", which hides LOCAL 404s from
// the console-error checks. That is intentional and stays: external hosts are
// legitimately blocked in the test environment, and console text alone cannot
// tell a blocked beacon from a broken local reference. The hole is closed on
// the network side instead: suites assert firstPartyFailures() (above) is
// empty, which sees every same-origin 404 / load failure with its URL and is
// immune to console-noise ambiguity.
export const NOISE = /googletagmanager|google-analytics|ERR_CONNECTION_REFUSED|ERR_FAILED|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|gstatic|firebase|googleapis|favicon|fonts\.|firebaseio|photon\.komoot|open-meteo|frankfurter|nominatim|openstreetmap|Failed to load resource/i;
export const cleanErrors = (s) => s.errors.filter((e) => !NOISE.test(e));

// ---------------------------------------------------------------------------
// Network interception (CDP Fetch domain).
//
// rules(url, request) is called for every request the PAGE issues and returns:
//   null/undefined      -> let it through
//   'fail'              -> abort it (looks like the network refusing)
//   { status, body, contentType } -> fulfill with a canned response
//
// Interception sees page-issued requests only: a request the service worker
// makes on the page's behalf belongs to the worker target, not this one. The
// trip-planner SW never handles cross-origin requests, so external API calls
// always originate here and are always interceptable.
export async function interceptNetwork(s, rules) {
  s.netRules = rules;
  if (s.netIntercepting) return;
  s.netIntercepting = true;
  s.on(async (method, p) => {
    if (method !== 'Fetch.requestPaused') return;
    let verdict = null;
    try { verdict = s.netRules ? s.netRules(p.request.url, p.request) : null; } catch { verdict = null; }
    try {
      if (verdict === 'fail') {
        await s.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'ConnectionRefused' });
      } else if (verdict && typeof verdict === 'object') {
        const body = typeof verdict.body === 'string' ? verdict.body : JSON.stringify(verdict.body ?? {});
        // `headers` lets a suite stand in for a real upstream that says
        // something in its headers rather than its body: the FPL proxy reports
        // freshness through x-fpl-stale / x-fpl-age-seconds, and a test that
        // could not set those could not exercise the stale paths at all.
        const extraHeaders = Object.entries(verdict.headers || {})
          .map(([name, value]) => ({ name, value: String(value) }));
        await s.send('Fetch.fulfillRequest', {
          requestId: p.requestId,
          responseCode: verdict.status || 200,
          responseHeaders: [
            { name: 'Content-Type', value: verdict.contentType || 'application/json' },
            { name: 'Access-Control-Allow-Origin', value: '*' },
            ...extraHeaders,
          ],
          body: Buffer.from(body).toString('base64'),
        });
      } else {
        await s.send('Fetch.continueRequest', { requestId: p.requestId });
      }
    } catch { /* target navigated away mid-flight; nothing to do */ }
  });
  await s.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
}

// Every host the trip planner can call out to. Kept here so a suite can block
// "everything external" without enumerating providers it does not care about.
export const EXTERNAL_HOSTS = /photon\.komoot\.io|nominatim\.openstreetmap\.org|geocoding-api\.open-meteo\.com|archive-api\.open-meteo\.com|api\.open-meteo\.com|api\.frankfurter\.(app|dev)|api\.openai\.com|raw\.githubusercontent\.com|tile\.openstreetmap\.org|googletagmanager|google-analytics|gstatic\.com|googleapis\.com|firebaseio\.com|\/\.netlify\/functions\//i;

export async function setOffline(s, offline) {
  await s.send('Network.emulateNetworkConditions', {
    offline: !!offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
  });
}

// All debuggable targets (pages, service workers, ...) with their own
// websocket URLs, straight from the browser's HTTP endpoint.
export async function listTargets(port) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/json/list' }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.end();
  });
}

// Attaches to a non-page target (e.g. a service worker) so domains like
// Network can be driven on it. Caller closes with s.ws.close().
export async function connectTarget(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  const s = new Session(ws);
  s.targetId = target.id;
  return s;
}
