// Regenerates apps-hub preview thumbnails from the live app, using each app's
// own sanctioned sample-data path. Never a real user's content: the previews
// on the hub are marketing thumbnails, and the repo rule is that they render
// from SAMPLE data only (root README, "Adding a new app", step 11).
//
//   node --experimental-websocket assets/app-previews/build-previews.mjs [slug...]
//
// Why only two apps live here. The hub shows eight thumbnails. Six of them
// (arena, football-h2h, gym-tracker, maptap-rivals, mario-kart, rising-shows)
// were captured by hand from app states that need hand-seeded storage, and
// their framing is good, so they stay as committed art and the hub crops them
// with object-position. The two below are the ones a script can reproduce,
// because each app ships a one-click sample dataset:
//   fpl-planner   ?demo=1 loads the bundled sample squad
//   trip-planner  the Timeline empty state offers "Load an example trip"
// Both previously shipped a whole-page capture that included the site nav and
// rendered the app at an unreadable scale; this script replaces them with a
// deliberate crop of the one component that identifies the app.
//
// Output contract: every preview is 720x405 (16:9), webp, matching the hub's
// .app-preview frame. CLIP is expressed in CSS pixels at VIEWPORT width, and
// the capture scale is derived so the written file is always 720 wide.

import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  waitForBrowser, newPage, goto, evaluate, setViewport, closePage, clickText,
} from '../../tests/browser/cdp.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT_DIR = path.join(REPO, 'images', 'app-previews');
const PORT = Number(process.env.PREVIEW_PORT || 8437);
const CDP_PORT = Number(process.env.PREVIEW_CDP_PORT || 9757);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT_W = 720;
const OUT_H = 405;

// Each clip is anchored to a measured element boundary rather than eyeballed,
// so a layout change that moves the component makes the capture obviously
// wrong instead of subtly off. `anchor` is measured at capture time and the
// clip is expressed relative to it.
const APPS = [
  {
    slug: 'fpl-planner',
    url: '/apps/fpl-planner/?demo=1',
    viewport: [1000, 1400],
    settle: 6000,
    prep: async (s) => {
      // The demo banner is a scaffold that only exists because ?demo=1 is on:
      // it explains how to leave sample mode. Leaving it in frame spends the
      // top of the thumbnail on a disclaimer about the screenshot rather than
      // on the product. The DATA stays the sample dataset either way, which is
      // what the sample-data-only rule is about.
      await evaluate(s, `(() => {
        document.querySelectorAll('.fpl-sample-banner').forEach((e) => { e.style.display = 'none'; });
        return '';
      })()`);
    },
    // The decision card: "Gameweek N / Make 2 transfers" plus the captain,
    // chip and projected-points tiles. It is the whole product in one card.
    anchor: '.fpl-hero',
    // 16:9 window centred on the hero, so the card sits complete in frame with
    // the app's own background bleeding above and below.
    clip: (r) => {
      const w = r.w;
      const h = Math.round(w / (16 / 9));
      return { x: r.x, y: Math.round(r.y + r.h / 2 - h / 2), width: w, height: h };
    },
  },
  {
    slug: 'trip-planner',
    url: '/apps/trip-planner/',
    viewport: [1000, 1400],
    settle: 4000,
    prep: async (s) => {
      await clickText(s, 'Load an example trip', { settle: 3000 });
      // The "example loaded" toast is transient UI, not part of the product.
      await evaluate(s, `(() => {
        document.querySelectorAll('[class*="toast"],[id*="toast"]').forEach((e) => { e.style.display = 'none'; });
        return '';
      })()`);
    },
    // The itinerary itself. The clip snaps to whole rows: it starts at the top
    // of the first row and ends at a row boundary, so no itinerary card is
    // ever sliced in half. The boundary chosen is the first one at or past the
    // 16:9 height, never one short of it - stopping short would force the
    // width below the board's own width, which would crop the rows
    // horizontally and cut the icons off one edge and the prices off the
    // other. Going long instead pads with page background, which is uniform.
    anchor: '#board',
    clip: (r, rows, viewport) => {
      const target = Math.round(r.w / (16 / 9));
      const top = rows[0].y;
      const bottom = (rows.find((row) => row.bottom - top >= target) || rows[rows.length - 1]).bottom;
      const height = bottom - top;
      const width = Math.min(Math.round(height * (16 / 9)), viewport[0]);
      const x = Math.max(0, Math.min(Math.round(r.x + r.w / 2 - width / 2), viewport[0] - width));
      return { x, y: top, width, height: Math.round(width / (16 / 9)) };
    },
  },
];

const rectOf = (sel) => `(() => {
  const e = document.querySelector(${JSON.stringify(sel)});
  if (!e) return 'MISSING';
  const r = e.getBoundingClientRect();
  return JSON.stringify({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) });
})()`;

const rowsOf = (sel) => `(() => {
  const e = document.querySelector(${JSON.stringify(sel)});
  if (!e) return '[]';
  return JSON.stringify([...e.children].map((c) => {
    const r = c.getBoundingClientRect();
    return { y: Math.round(r.y), bottom: Math.round(r.bottom) };
  }));
})()`;

async function main() {
  const only = process.argv.slice(2);
  const wanted = only.length ? APPS.filter((a) => only.includes(a.slug)) : APPS;
  if (!wanted.length) {
    console.error(`No matching app. Known: ${APPS.map((a) => a.slug).join(', ')}`);
    process.exit(1);
  }

  const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'],
    { cwd: REPO, stdio: 'ignore' });
  const profileDir = await mkdtemp(path.join(tmpdir(), 'app-previews-'));
  const chrome = spawn(process.env.CHROME_BIN || 'chromium', [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profileDir}`,
    '--host-resolver-rules=MAP www.googletagmanager.com 127.0.0.1:1, MAP *.google-analytics.com 127.0.0.1:1',
    'about:blank',
  ], { stdio: 'ignore' });

  try {
    await waitForBrowser(CDP_PORT);
    const s = await newPage(CDP_PORT);
    for (const app of wanted) {
      await setViewport(s, app.viewport[0], app.viewport[1], false);
      await goto(s, `${BASE}${app.url}`, { settle: app.settle });
      if (app.prep) await app.prep(s);

      const raw = await evaluate(s, rectOf(app.anchor));
      if (raw === 'MISSING') throw new Error(`${app.slug}: anchor ${app.anchor} not found - the app's markup moved`);
      const rect = JSON.parse(raw);
      const rows = JSON.parse(await evaluate(s, rowsOf(app.anchor)));
      const clip = app.clip(rect, rows, app.viewport);

      // One scale for both axes, derived from the output width, so nothing is
      // ever stretched: the capture is a pure downscale of a 16:9 region.
      const scale = OUT_W / clip.width;
      const shot = await s.send('Page.captureScreenshot', {
        format: 'webp',
        quality: 92,
        clip: { ...clip, scale },
        captureBeyondViewport: true,
      });
      const file = path.join(OUT_DIR, `${app.slug}.webp`);
      await writeFile(file, Buffer.from(shot.data, 'base64'));
      const ratio = (clip.width / clip.height).toFixed(3);
      console.log(`${app.slug}: clip ${clip.width}x${clip.height} (${ratio}) @${scale.toFixed(3)} -> ${OUT_W}x${OUT_H}`);
    }
    await closePage(CDP_PORT, s);
  } finally {
    chrome.kill();
    server.kill();
  }
}

await main();
