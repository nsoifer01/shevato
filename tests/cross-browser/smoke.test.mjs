// Cross-browser smoke suite: Firefox + WebKit.
//
//   npm run test:cross-browser
//
// Chromium already gets deep coverage from the CDP harness (npm run
// test:browser). This suite exists to catch engine-specific breakage in the
// other two engines the README promises support for, so it stays a wide,
// shallow smoke: every page and app boots, shared chrome injects, core JS
// wiring responds, and nothing throws.
//
// It is the ONE suite in the repo that needs npm dev dependencies:
//   npm install                      (installs playwright, dev-only)
//   npx playwright install firefox webkit
// WebKit additionally needs system libraries that only CI can install
// (npx playwright install --with-deps webkit). On machines without them the
// WebKit half reports as skipped with the reason, never as a silent pass.
//
// All external hosts (Firebase, analytics, tiles, geocoders) are aborted at
// the route layer so the run is deterministic and never touches production
// services. Uncaught page errors fail the page's check unless they are the
// direct result of an aborted external request.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
// 8080/8081 are reserved on the maintainer's machine; 8099 belongs to the
// CDP harness. This suite gets its own port so the two can run side by side.
const PORT = Number(process.env.CROSS_BROWSER_PORT || 8215);
const BASE = `http://127.0.0.1:${PORT}`;

const SITE_PAGES = ['home', 'work', 'apps', 'about', 'contact', 'privacy', '404', 'moadon-alef'];
const APPS = ['arena', 'football-h2h', 'fpl-planner', 'gym-tracker',
  'maptap-rivals', 'mario-kart', 'rising-shows', 'trip-planner'];
// moadon-alef deliberately carries no site header.
const NO_HEADER = new Set(['moadon-alef']);

const EXTERNAL = /googletagmanager|google-analytics|gstatic|googleapis|firebase|firebaseio|photon\.komoot|open-meteo|frankfurter|nominatim|openstreetmap|fonts\.|cdn\.jsdelivr|api\.openai\.com|raw\.githubusercontent/i;
// Errors that are the direct shadow of an aborted external request.
const ABORT_NOISE = /NetworkError|Load failed|Failed to fetch|NS_ERROR|The operation was aborted|firebase|firestore/i;

let server;
const httpOk = (url) => new Promise((resolve) => {
  const req = http.get(url, (res) => { res.resume(); resolve((res.statusCode || 0) < 500); });
  req.on('error', () => resolve(false));
  req.setTimeout(1500, () => { req.destroy(); resolve(false); });
});

before(async () => {
  server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'],
    { cwd: REPO, stdio: 'ignore' });
  const start = Date.now();
  while (!(await httpOk(`${BASE}/home.html`))) {
    if (Date.now() - start > 20000) throw new Error('static server never came up');
    await new Promise((r) => setTimeout(r, 250));
  }
});
after(() => { try { server && server.kill(); } catch { /* already gone */ } });

async function loadPlaywright() {
  try { return await import('playwright'); }
  catch {
    throw new Error('playwright is not installed. Run: npm install && npx playwright install firefox webkit');
  }
}

// One browser per engine for the whole file; contexts per page keep state clean.
async function withBrowser(t, engineName, fn) {
  const pw = await loadPlaywright();
  let browser;
  try {
    browser = await pw[engineName].launch({ headless: true });
  } catch (e) {
    t.skip(`${engineName} cannot launch here: ${String(e.message).split('\n')[0]} `
      + '(on CI: npx playwright install --with-deps)');
    return;
  }
  try { await fn(browser); } finally { await browser.close(); }
}

async function newPage(browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.route('**/*', (route) => {
    if (EXTERNAL.test(route.request().url())) return route.abort();
    return route.continue();
  });
  const page = await context.newPage();
  const errors = [];
  const firstPartyFailures = [];
  page.on('pageerror', (e) => { if (!ABORT_NOISE.test(String(e))) errors.push(String(e)); });
  page.on('response', (res) => {
    if (res.url().startsWith(BASE) && res.status() >= 400) {
      firstPartyFailures.push(`HTTP ${res.status()} ${res.url()}`);
    }
  });
  return { context, page, errors, firstPartyFailures };
}

async function checkPage(browser, url, { header = true } = {}) {
  const { context, page, errors, firstPartyFailures } = await newPage(browser);
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 30000 });
    await page.waitForTimeout(1500); // partials inject after load
    const title = await page.title();
    assert.ok(title.length > 5, `title too short: "${title}" at ${url}`);
    assert.ok(await page.locator('h1, h2').first().isVisible().catch(() => false),
      `no visible h1/h2 at ${url}`);
    if (header) {
      assert.ok(await page.locator('#header').count() > 0, `header partial missing at ${url}`);
      assert.ok(await page.locator('#footer').count() > 0, `footer partial missing at ${url}`);
    }
    assert.deepEqual(errors, [], `uncaught page errors at ${url}: ${errors.join(' | ')}`);
    assert.deepEqual(firstPartyFailures, [], `first-party failures at ${url}`);
  } finally {
    await context.close();
  }
}

for (const engine of ['firefox', 'webkit']) {
  test(`${engine}: all site pages load clean`, { concurrency: false }, async (t) => {
    await withBrowser(t, engine, async (browser) => {
      for (const p of SITE_PAGES) {
        await checkPage(browser, `${BASE}/${p}.html`, { header: !NO_HEADER.has(p) });
      }
    });
  });

  test(`${engine}: all app pages boot clean`, async (t) => {
    await withBrowser(t, engine, async (browser) => {
      for (const app of APPS) {
        // Rising Shows boots from a gitignored dataset (fetched on CI by
        // cross-browser.yml, absent in a fresh clone). Without it the app
        // requests data-index.json and gets a 404, which is a missing
        // precondition, not a boot failure: skip with a reason, the way the
        // CDP harness does, instead of turning the whole smoke red.
        if (app === 'rising-shows' && !existsSync(path.join(REPO, 'apps', 'rising-shows', 'data-index.json'))) {
          t.diagnostic('skip rising-shows: no show data (run `npm run fetch:rising-shows-data && npm run build:rising-shows:split`)');
          continue;
        }
        await checkPage(browser, `${BASE}/apps/${app}/`, { header: true });
      }
    });
  });

  test(`${engine}: apps hub search narrows the grid`, async (t) => {
    await withBrowser(t, engine, async (browser) => {
      const { context, page } = await newPage(browser);
      try {
        await page.goto(`${BASE}/apps.html`, { waitUntil: 'load' });
        await page.waitForTimeout(1200);
        const search = page.locator('#app-search');
        assert.ok(await search.count() > 0, '#app-search missing');
        const visibleCards = async () => {
          const cards = await page.locator('section[data-category]').all();
          let n = 0;
          for (const c of cards) if (await c.isVisible()) n++;
          return n;
        };
        const all = await visibleCards();
        assert.ok(all >= 8, `expected >= 8 app cards, saw ${all}`);
        await search.fill('gym');
        await page.waitForTimeout(600);
        const narrowed = await visibleCards();
        assert.ok(narrowed >= 1 && narrowed < all,
          `search did not narrow: ${all} -> ${narrowed}`);
      } finally {
        await context.close();
      }
    });
  });

  test(`${engine}: gym-tracker interaction responds`, async (t) => {
    await withBrowser(t, engine, async (browser) => {
      const { context, page, errors } = await newPage(browser);
      try {
        await page.goto(`${BASE}/apps/gym-tracker/`, { waitUntil: 'load' });
        await page.waitForTimeout(2500);
        // Dismiss first-run onboarding if it is up, via its own control
        // (#onboarding-dismiss), the same way the CDP suite does.
        const dismiss = page.locator('#onboarding-dismiss');
        if (await dismiss.isVisible().catch(() => false)) {
          await dismiss.click({ timeout: 5000 });
          await page.waitForTimeout(600);
        }
        // Switch a nav view and confirm the app re-rendered. Scope to the
        // first VISIBLE nav control: hidden duplicates exist in other views.
        const nav = page.locator('.nav-item:visible, nav button:visible');
        assert.ok(await nav.count() > 1, 'no visible nav controls found');
        await nav.nth(1).click({ timeout: 8000 });
        await page.waitForTimeout(800);
        assert.deepEqual(errors, [], `errors after interaction: ${errors.join(' | ')}`);
      } finally {
        await context.close();
      }
    });
  });
}
