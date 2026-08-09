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
  s.on((method, p) => {
    if (method === 'Runtime.exceptionThrown') {
      const d = p.exceptionDetails;
      s.errors.push(String((d.exception && (d.exception.description || d.exception.value)) || d.text));
    } else if (method === 'Log.entryAdded' && p.entry.level === 'error') {
      s.errors.push(String(p.entry.text));
    } else if (method === 'Network.loadingFailed') {
      s.netFails.push(`${p.errorText} ${p.type}`);
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
  const loaded = new Promise((res) => {
    const h = (m) => { if (m === 'Page.loadEventFired') res(); };
    s.on(h);
  });
  await s.send('Page.navigate', { url });
  await Promise.race([loaded, sleep(20000)]);
  await sleep(settle);
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

export async function setViewport(s, width, height, mobile = false) {
  await s.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile,
    screenWidth: width, screenHeight: height,
  });
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

export async function pressKey(s, key, code, keyCode) {
  const p = { key, code: code || key, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
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

export const NOISE = /googletagmanager|google-analytics|ERR_CONNECTION_REFUSED|gstatic|firebase|googleapis|favicon|fonts\.|firebaseio|Failed to load resource/i;
export const cleanErrors = (s) => s.errors.filter((e) => !NOISE.test(e));
