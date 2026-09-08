// Regenerates apps-hub preview thumbnails from the live app, using each app's
// own sanctioned sample state. Never a real user's content: the previews on
// the hub are marketing thumbnails, and the repo rule is that they render from
// SAMPLE data only (root README, "Adding a new app", step 11).
//
//   node --experimental-websocket assets/app-previews/build-previews.mjs [slug...]
//
// Where the sample state comes from, per app:
//   fpl-planner    ?demo=1 loads the bundled sample squad
//   trip-planner   the Timeline empty state offers "Load an example trip"
//   the rest       seeded localStorage (assets/app-previews/seeds.mjs), whose
//                  shapes are lifted from each app's own unit-test fixtures
//
// Arena is the one app not built here. It is a real-time multiplayer hub, so
// its interesting state needs a room with people in it rather than a dataset,
// and its committed capture (a Globe Drop round mid-question) is already the
// strongest thumbnail on the page. It stays hand-captured.
//
// Two rules the whole file exists to enforce:
//
//   Anchored, not eyeballed. Every clip is derived from a measured element,
//   so if an app's markup moves the capture fails loudly instead of silently
//   shipping a crop of the wrong thing.
//
//   Never upscale. Output is 720x405 (16:9) and the capture scale is derived
//   from the clip width, so a capture is always a pure downscale. A clip
//   narrower than 720 CSS px would be an upscale, and is rejected.

import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  waitForBrowser, newPage, goto, evaluate, evalAsync, setViewport, closePage, clickText, seedAndReload,
} from '../../tests/browser/cdp.mjs';
import { SEEDS } from './seeds.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT_DIR = path.join(REPO, 'images', 'app-previews');
const PORT = Number(process.env.PREVIEW_PORT || 8446);
const CDP_PORT = Number(process.env.PREVIEW_CDP_PORT || (9000 + Math.floor(Math.random() * 800)));
const BASE = `http://127.0.0.1:${PORT}`;
const OUT_W = 720;
const OUT_H = 405;
const AR = 16 / 9;

// Resolves the region of interest in the page and returns its rect. Kept as an
// expression per app so the choice of subject is visible here rather than
// buried in a selector constant.
const rectOf = (sel) => `(() => {
  const e = document.querySelector(${JSON.stringify(sel)});
  if (!e) return 'MISSING';
  const r = e.getBoundingClientRect();
  return JSON.stringify({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) });
})()`;

// A 16:9 window whose TOP is the subject's top: the subject leads the frame
// and whatever follows it fills the rest. Used where the subject is taller
// than 16:9 and its first rows are the interesting part.
const fromTop = (r) => ({ x: r.x, y: r.y, width: r.w, height: Math.round(r.w / AR) });

// A 16:9 window centred on the subject, padding with the app's own background
// where the subject is wider than 16:9. Used where the subject is complete and
// must not be cut.
const centred = (r) => {
  const height = Math.round(r.w / AR);
  return { x: r.x, y: Math.round(r.y + r.h / 2 - height / 2), width: r.w, height };
};

const APPS = [
  {
    slug: 'football-h2h',
    url: '/apps/football-h2h/',
    viewport: [1200, 1600],
    settle: 4000,
    seed: 'football-h2h',
    // The H2H stats block: total wins for both players, the current streak,
    // 90-minute wins and penalty wins. It is the whole product in one panel,
    // and it measures 812x462 - within a hair of 16:9 already, so the frame
    // barely has to crop it at all.
    measure: rectOf('#h2h-stats'),
    clip: fromTop,
  },
  {
    slug: 'fpl-planner',
    url: '/apps/fpl-planner/?demo=1',
    viewport: [1000, 1400],
    settle: 6000,
    prep: async (s) => {
      // Demo-mode scaffolding that explains how to leave sample mode. Leaving
      // it in frame spends the top of the thumbnail on a disclaimer about the
      // screenshot rather than on the product. The DATA is still the sample
      // dataset, which is what the sample-data-only rule is about.
      await evaluate(s, `(() => {
        document.querySelectorAll('.fpl-sample-banner').forEach((e) => { e.style.display = 'none'; });
        return '';
      })()`);
    },
    // The decision card: "Gameweek N / Make 2 transfers" plus the captain,
    // chip and projected-points tiles.
    measure: rectOf('.fpl-hero'),
    clip: centred,
  },
  {
    slug: 'gym-tracker',
    url: '/apps/gym-tracker/',
    viewport: [1200, 1600],
    settle: 4500,
    seed: 'gym-tracker',
    prep: async (s) => { await clickText(s, 'Insights', { sel: 'a,button,li', settle: 1800 }); },
    // Insights, not the Dashboard. The dashboard's "This Week" tiles are the
    // better-looking panel but they are computed against the real clock, so on
    // a Monday they can only ever report the one day the week is old, and the
    // Recent Workouts list underneath is three sparse dark rows. Insights
    // instead shows volume by muscle group as a bar chart over a full year of
    // training - big labels, real numbers, and a shape that reads at 290px.
    measure: `(() => {
      const h = [...document.querySelectorAll('h1,h2,h3')].find((e) => (e.textContent || '').trim().startsWith('Volume by muscle group'));
      if (!h) return 'MISSING';
      const sec = h.closest('section') || h.parentElement;
      const r = sec.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) });
    })()`,
    clip: fromTop,
  },
  {
    slug: 'maptap-rivals',
    url: '/apps/maptap-rivals/',
    viewport: [1100, 1700],
    settle: 4000,
    seed: 'maptap-rivals',
    prep: async (s) => { await clickText(s, 'Matrix', { settle: 1800 }); },
    // The confusion matrix: every player against every other, each cell a
    // record and a win rate, colour-coded. Chosen over the dashboard's rivalry
    // cards, which are the obvious pick but cannot be framed cleanly - the
    // card grid is 3.8:1 at desktop width, and at the narrower width where it
    // wraps to 2 + 1 the only way to reach 16:9 is to drag in the collapsed
    // "paste daily scores" bar above it, or to slice the third card. The
    // matrix is one self-contained titled panel that already fills the frame.
    measure: rectOf('.view-matrix'),
    clip: fromTop,
  },
  {
    slug: 'mario-kart',
    url: '/apps/mario-kart/',
    viewport: [1200, 1800],
    settle: 4500,
    seed: 'mario-kart',
    prep: async (s) => { await clickText(s, 'Stats', { sel: 'button,a,.toggle-btn', settle: 1800 }); },
    // The Stats tab: four titled panels, each with one big number per player -
    // average finish, first places, podium rate, best streak. Two other
    // screens were tried and rejected. Trends is the app's showiest, but it
    // plots 14 races x 3 players as overlapping lines that collapse into
    // spaghetti at 290px. Race History is honest but renders as a field of
    // small colour dots at thumbnail size. These panels are the only screen
    // whose largest elements are still legible once the card shrinks.
    // .stats-container is the grid of all four panels. Note the panel titles
    // are div.stat-title, not headings, so a heading-based lookup finds
    // nothing here - the tab has to be addressed by its container.
    measure: rectOf('.stats-container'),
    clip: fromTop,
  },
  {
    slug: 'rising-shows',
    url: '/apps/rising-shows/',
    viewport: [1200, 1600],
    settle: 7000,
    // The first row of result cards: poster, title, shape tag and the rating
    // trend sparkline that is the entire point of the app. The clip is the
    // full card HEIGHT and whatever width that implies at 16:9, so the cards
    // are never cut - the padding lands on the page background instead.
    measure: `(() => {
      const cards = [...document.querySelectorAll('.finder-card')];
      if (!cards.length) return 'MISSING';
      const top = cards[0].getBoundingClientRect().top;
      const rowOne = cards.filter((c) => Math.abs(c.getBoundingClientRect().top - top) < 8);
      const rects = rowOne.map((c) => c.getBoundingClientRect());
      const left = Math.min(...rects.map((r) => r.left));
      const right = Math.max(...rects.map((r) => r.right));
      const bottom = Math.max(...rects.map((r) => r.bottom));
      return JSON.stringify({ x: Math.round(left), y: Math.round(top), w: Math.round(right - left), h: Math.round(bottom - top) });
    })()`,
    clip: (r, viewport) => {
      const height = r.h;
      const width = Math.min(Math.round(height * AR), viewport[0]);
      const x = Math.max(0, Math.min(Math.round(r.x + r.w / 2 - width / 2), viewport[0] - width));
      return { x, y: r.y, width, height: Math.round(width / AR) };
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
    // The itinerary. The clip snaps to whole rows: it starts at the top of the
    // first row and ends at a row boundary, so no itinerary card is ever cut
    // in half. The boundary chosen is the first one AT OR PAST the 16:9
    // height, never one short of it - stopping short would force the width
    // below the board's own width, cropping the rows horizontally and cutting
    // the type icons off one edge and the prices off the other. Going long
    // pads with page background, which is uniform.
    measure: `(() => {
      const b = document.querySelector('#board');
      if (!b) return 'MISSING';
      const rows = [...b.children].map((c) => { const r = c.getBoundingClientRect(); return { y: r.y, bottom: r.bottom }; });
      if (!rows.length) return 'MISSING';
      const r = b.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
        rows: rows.map((q) => ({ y: Math.round(q.y), bottom: Math.round(q.bottom) })) });
    })()`,
    clip: (r, viewport) => {
      const target = Math.round(r.w / AR);
      const top = r.rows[0].y;
      const bottom = (r.rows.find((row) => row.bottom - top >= target) || r.rows[r.rows.length - 1]).bottom;
      const height = bottom - top;
      const width = Math.min(Math.round(height * AR), viewport[0]);
      const x = Math.max(0, Math.min(Math.round(r.x + r.w / 2 - width / 2), viewport[0] - width));
      return { x, y: top, width, height: Math.round(width / AR) };
    },
  },
];

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

  let failed = 0;
  try {
    await waitForBrowser(CDP_PORT);
    const s = await newPage(CDP_PORT);
    for (const app of wanted) {
      await setViewport(s, app.viewport[0], app.viewport[1], false);
      const url = `${BASE}${app.url}`;
      if (app.seed) await seedAndReload(s, url, SEEDS[app.seed], { settle: app.settle });
      else await goto(s, url, { settle: app.settle });
      if (app.prep) await app.prep(s);

      const raw = await evalAsync(s, app.measure);
      if (raw === 'MISSING') {
        console.error(`${app.slug}: FAILED - the measured element is not on the page (its markup moved, or the sample state did not load)`);
        failed++;
        continue;
      }
      const rect = JSON.parse(raw);
      const clip = app.clip(rect, app.viewport);

      if (clip.width < OUT_W) {
        console.error(`${app.slug}: FAILED - clip is ${clip.width}px wide, narrower than the ${OUT_W}px output, which would upscale it`);
        failed++;
        continue;
      }

      const scale = OUT_W / clip.width;
      const shot = await s.send('Page.captureScreenshot', {
        format: 'webp',
        quality: 92,
        clip: { ...clip, scale },
        captureBeyondViewport: true,
      });
      await writeFile(path.join(OUT_DIR, `${app.slug}.webp`), Buffer.from(shot.data, 'base64'));
      console.log(`${app.slug}: clip ${clip.width}x${clip.height} (${(clip.width / clip.height).toFixed(3)}) @${scale.toFixed(3)} -> ${OUT_W}x${OUT_H}`);
    }
    await closePage(CDP_PORT, s);
  } finally {
    chrome.kill();
    server.kill();
  }
  if (failed) process.exit(1);
}

await main();
