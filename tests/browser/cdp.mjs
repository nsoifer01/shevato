// Minimal CDP driver. Node 20 needs --experimental-websocket for global WebSocket.
import http from 'node:http';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    catch { if (Date.now() - start > timeoutMs) throw new Error('browser never came up'); await sleep(250); }
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
  try {
    await s.send('Page.navigate', { url });
    // The race keeps a dead page from hanging the whole suite, but a timeout
    // must not be silent: callers can check s.lastNavTimedOut after goto.
    const outcome = await Promise.race([loaded, sleep(20000).then(() => 'timeout')]);
    s.lastNavTimedOut = outcome === 'timeout';
  } finally {
    // One-shot: without this every navigation leaked a handler (O(n^2) event
    // dispatch over a long suite).
    s.off(h);
  }
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
export async function waitForExpr(s, expression, { timeout = 8000, poll = 150 } = {}) {
  const start = Date.now();
  for (;;) {
    const v = await evaluate(s, expression);
    if (v && !v.__evalError) return true;
    if (Date.now() - start > timeout) return false;
    await sleep(poll);
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
export async function pressKey(s, key, code, keyCode, modifiers = 0) {
  const p = { key, code: code || key, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers };
  await s.send('Input.dispatchKeyEvent', { type: 'keyDown', ...p });
  await s.send('Input.dispatchKeyEvent', { type: 'keyUp', ...p });
  await sleep(150);
}

// Seed storage then reload, because app state is closure-scoped and only read at boot.
export async function seedAndReload(s, url, kv) {
  await goto(s, url, { settle: 900 });
  await evaluate(s, `(()=>{ ${Object.entries(kv).map(([k, v]) =>
    `localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(typeof v === 'string' ? v : JSON.stringify(v))});`).join('')} return 1 })()`);
  await goto(s, url, { settle: 2500 });
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
