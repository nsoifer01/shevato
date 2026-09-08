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
// Arena is the one app not built here, and not for want of trying. It has a
// "Play solo" button, so a Globe Drop round CAN be started headlessly - but
// the round renders a WebGL globe, and once it is up Page.captureScreenshot
// never returns (it exceeds the harness's 45s ceiling). Trivia, the app's
// other game, has no solo mode and pulls its questions from an external API.
// So Arena's only capturable state is its lobby, which is a settings form,
// and its committed capture of a real round stays the better thumbnail. It
// remains hand-captured, and is the only preview the hub still has to crop.
//
// Two rules the whole file exists to enforce:
//
//   Anchored, not eyeballed. Every clip is derived from a measured element,
//   so if an app's markup moves the capture fails loudly instead of silently
//   shipping a crop of the wrong thing.
//
//   Never upscale, but do crop TIGHT. Every app is rendered at 2x device
//   pixels, which is what makes a tight crop possible: at 1x a clip had to be
//   at least 720 CSS px wide to fill a 720px file, which forced every
//   thumbnail to be a whole wide panel holding a dozen small elements - the
//   "too zoomed out" look. At 2x the floor halves to 360 CSS px, so a clip
//   can hold three or four big elements and still resolve a downsample. The
//   output stays 720x405 regardless, because a preview is painted at most
//   337px wide on the hub and the extra detail is better spent on sharpness
//   than on bytes.

import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  waitForBrowser, newPage, goto, evaluate, evalAsync, closePage, clickText, clickAt, seedAndReload,
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
// Every app is rendered at 2x device pixels. This is what makes a TIGHT crop
// possible: at 1x a clip had to be at least 720 CSS px wide or the output
// would be an upscale, which forced every thumbnail to be a whole wide panel
// with a dozen small elements in it - the "too zoomed out" look. At 2x the
// floor halves to 360 CSS px, so a clip can hold three or four big elements
// and still resolve a downscale.
const DSF = 2;
const MIN_CLIP_W = OUT_W / DSF;

// setViewport in the shared harness pins deviceScaleFactor to 1, which is
// right for tests and wrong here.
async function setViewportAt2x(s, width, height) {
  await s.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: DSF, mobile: false,
    screenWidth: width, screenHeight: height,
  });
}

// Resolves the region of interest in the page and returns its rect. Kept as an
// expression per app so the choice of subject is visible here rather than
// buried in a selector constant.
const rectOf = (sel) => `(() => {
  const e = document.querySelector(${JSON.stringify(sel)});
  if (!e) return 'MISSING';
  const r = e.getBoundingClientRect();
  return JSON.stringify({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) });
})()`;

// Grows a measured rect outward by `n` CSS px. Section labels frequently
// overhang their own container by a few pixels, and a clip taken at exactly
// the container's bounds shears the first letter off them ("TOTAL WINS" came
// out as "OTAL WINS").
const bleed = (r, n) => ({ x: r.x - n, y: r.y - n, w: r.w + n * 2, h: r.h + n * 2, rows: r.rows });

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
    viewport: [760, 1800],
    settle: 4000,
    seed: 'football-h2h',
    // The H2H stats block: total wins for both players, the current streak,
    // 90-minute wins and penalty wins. It is the whole product in one panel,
    // and it measures 812x462 - within a hair of 16:9 already, so the frame
    // barely has to crop it at all.
    // Deliberately NOT the whole stats panel. The crop runs from the top of
    // the section to the top of the PENALTY WINS label, which is total wins,
    // the streak banner and the 90-minute split and nothing else - three
    // things large enough to read at card size, rather than every statistic
    // the app keeps shrunk to the point of being decoration.
    measure: `(() => {
      const sec = document.querySelector('#h2h-stats');
      if (!sec) return 'MISSING';
      const stop = [...sec.querySelectorAll('*')].find((e) => (e.textContent || '').trim().startsWith('PENALTY WINS') && e.children.length === 0);
      const r = sec.getBoundingClientRect();
      const bottom = stop ? stop.getBoundingClientRect().top : r.bottom;
      return JSON.stringify({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(bottom - r.top) });
    })()`,
    // The kept region is already about 1.8:1, so its own width is the frame.
    // Deriving the width from the height instead made the clip wider than the
    // viewport, and captureBeyondViewport happily filled the overhang with
    // the page above - the app header and tab bar ended up in the thumbnail.
    clip: (r) => fromTop(bleed(r, 14)),
  },
  {
    slug: 'fpl-planner',
    url: '/apps/fpl-planner/?demo=1',
    // Narrower than the others on purpose: the hero card reflows to the
    // column width, so at 700 the same recommendation fills roughly 17% more
    // of the frame than it did at 820. Same screen, tighter crop.
    viewport: [700, 1800],
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
    // Wide enough that a 16:9 window over the summary card reaches past the
    // Recent Workouts heading into the workout cards. At 900 the card is only
    // 576px, so the frame stopped at the heading and its lower half was an
    // empty dark band.
    viewport: [1100, 1700],
    settle: 4500,
    seed: 'gym-tracker',
    // The dashboard: the "This Week" tiles over the start of Recent Workouts.
    // This is the screen that says "workout tracker" at a glance, where the
    // Insights charts said "analytics report". The clip runs from the top of
    // the This Week card to the bottom of the first workout card, so the
    // summary takes the upper half and one recognisable workout the lower.
    // .week-summary-card is the "This Week" panel itself. Locating it by
    // heading text and climbing does not work: the first element whose text
    // starts with "This Week" is the h2 inside the card header, its nearest
    // wrapper is narrower than the card, and climbing until something is wide
    // enough overshoots to the page container - which anchored the crop on
    // "Dashboard / Your Programs" instead.
    measure: rectOf('.week-summary-card'),
    // The card's width is the frame, so the summary tiles lead and 16:9
    // carries the crop down through the Recent Workouts heading into the
    // first workout cards. The bleed is because the Recent Workouts header
    // below the card is aligned to a wider container, so a clip at exactly
    // the card's bounds leaves its text flush against both edges.
    clip: (r) => fromTop(bleed(r, 14)),
  },
  {
    slug: 'maptap-rivals',
    url: '/apps/maptap-rivals/',
    // 640 is chosen by geometry, not taste. The rival cards are ~1.5:1 each,
    // so a row of two is ~3:1 - wider than the frame at any width. The
    // narrower the viewport, the taller each card and the less vertical
    // padding the 16:9 window needs: at 860 a two-card row needs ~197px of
    // filler above it and drags in the collapsed paste bar, at 640 it needs
    // ~58px, which the "Rivalries" heading fills exactly.
    viewport: [640, 2200],
    settle: 4500,
    seed: 'maptap-rivals',
    // The rivalry cards: names, win-loss-tie split, form strip and streak
    // badge. This is what "tracking rivalries with friends" looks like. The
    // confusion matrix was tried here and is the wrong subject for a
    // thumbnail - dense, technical and unreadable at 290px.
    measure: `(() => {
      const g = document.querySelector('#rival-grid');
      if (!g) return 'MISSING';
      const cards = [...g.querySelectorAll('.rival-card')];
      if (!cards.length) return 'MISSING';
      const top = cards[0].getBoundingClientRect().top;
      const rowOne = cards.filter((c) => Math.abs(c.getBoundingClientRect().top - top) < 8);
      const bottom = Math.max(...rowOne.map((c) => c.getBoundingClientRect().bottom));
      const r = g.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.x), y: Math.round(top), w: Math.round(r.width), h: Math.round(bottom - top) });
    })()`,
    // Bottom-aligned to the card row so no card is ever sliced; the extra
    // height is taken from above, where the section heading sits.
    clip: (r) => {
      const height = Math.round(r.w / AR);
      return { x: r.x, y: r.y + r.h - height, width: r.w, height };
    },
  },
  {
    slug: 'mario-kart',
    url: '/apps/mario-kart/',
    // Wide enough that a 16:9 window over #trends still reaches the bottom of
    // the chart rather than clipping its x-axis.
    viewport: [1200, 2000],
    settle: 4500,
    seed: 'mario-kart',
    prep: async (s) => { await clickText(s, 'Trends', { sel: 'button,a,.toggle-btn', settle: 2500 }); },
    // The Performance Trends chart: each player's finishing position plotted
    // across the seeded races. Chosen over the Stats panels so the page is not
    // three stat-tile thumbnails in a row - this one reads as a line chart at
    // a glance, which is variety the gallery needs. #trends holds the heading
    // and the axis labels as well as the canvas.
    measure: rectOf('#trends'),
    clip: fromTop,
  },
  {
    slug: 'rising-shows',
    url: '/apps/rising-shows/',
    viewport: [820, 1800],
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
    // Wider than the others so the row-snapping below can reach the third and
    // fourth itinerary rows: at 820 the tallest boundary that fits 16:9 was
    // only two rows, which read as sparse and hid the transport-vs-stay mix.
    viewport: [1000, 1800],
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
      // Pick the row boundary that gives the TALLEST clip whose 16:9 width
      // still fits the viewport. Clamping the width to the viewport after
      // snapping was the earlier bug: it recomputed the height from the
      // clamped width and landed back in the middle of a row. Choosing the
      // boundary by what fits keeps the clip aligned to whole rows, and the
      // 2x raster means a shorter clip is still a downscale.
      const top = r.rows[0].y;
      let best = null;
      for (const row of r.rows) {
        const height = row.bottom - top;
        const width = Math.round(height * AR);
        if (width > viewport[0]) break;
        if (width >= MIN_CLIP_W) best = { height, width };
      }
      if (!best) {
        const width = Math.min(Math.round(r.w), viewport[0]);
        best = { width, height: Math.round(width / AR) };
      }
      const x = Math.max(0, Math.min(Math.round(r.x + r.w / 2 - best.width / 2), viewport[0] - best.width));
      return { x, y: top, width: best.width, height: Math.round(best.width / AR) };
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
      await setViewportAt2x(s, app.viewport[0], app.viewport[1]);
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

      if (clip.width < MIN_CLIP_W) {
        console.error(`${app.slug}: FAILED - clip is ${clip.width} CSS px wide; below ${MIN_CLIP_W} the ${DSF}x raster cannot fill ${OUT_W}px without upscaling`);
        failed++;
        continue;
      }

      // Output is OUT_W wide regardless of DSF. Page.captureScreenshot maps
      // clip.width CSS px to clip.width * DSF raster px and THEN applies
      // scale, so dividing by DSF here is what makes the 2x raster a
      // downsample into a 720px file rather than a 1440px one. The extra
      // detail is spent on sharpness, not on bytes: a preview is painted at
      // most 337px wide, so 720 is already better than 2x.
      const scale = OUT_W / (clip.width * DSF);
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
