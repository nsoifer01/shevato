// Declared <img width/height> attributes match the file's real aspect ratio.
//
// The site sets width and height on its images so the browser reserves the
// right box before the bytes arrive (no layout shift, the CLS half of Core
// Web Vitals). That only works if the declared pair has the SAME aspect
// ratio as the file: the browser uses the ratio, not the pixel values, and
// a wrong ratio reserves the wrong box, then shifts the layout anyway when
// the image decodes, or renders it squashed. The 2026-08-22 audit found the
// header logo declared at a ratio that did not match its PNG.
//
// So for every <img> in the shared partials and the root pages that carries
// both attributes and a same-origin raster src, the intrinsic size is read
// straight from the file header (PNG IHDR, JPEG SOF, WebP VP8/VP8L/VP8X;
// zero dependencies) and the two ratios must agree within 5 percent. SVGs
// scale to any box and are skipped. The header logo (128x84 declared
// 40x26: 1.524 vs 1.538, 0.9 percent apart) is the anchor case and must
// keep passing; the tolerance exists for exactly that kind of integer
// rounding, not for a wrong pair.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => readFileSync(join(REPO_ROOT, rel), 'utf8');

const PAGES = [
  'partials/header.html', 'partials/footer.html', 'partials/footer-moadon-alef.html',
  'index.html', 'home.html', 'work.html', 'apps.html', 'about.html', 'contact.html',
  'privacy.html', 'moadon-alef.html', '404.html',
];
const TOLERANCE = 0.05;

// -- Header parsers ---------------------------------------------------------------

function pngSize(buf) {
  if (buf.toString('latin1', 1, 4) !== 'PNG' || buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function jpegSize(buf) {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i += 1; continue; }
    const marker = buf[i + 1];
    if (marker === 0xff) { i += 1; continue; }
    // SOF0..SOF15 carry the frame size; C4 (DHT), C8 (JPG) and CC (DAC) do not.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { i += 2; continue; }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

function webpSize(buf) {
  if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WEBP') return null;
  const chunk = buf.toString('latin1', 12, 16);
  if (chunk === 'VP8 ') {
    // Key frame: 3-byte frame tag, 3-byte start code, then 14-bit width/height.
    if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return null;
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    if (buf[20] !== 0x2f) return null;
    const bits = buf.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') {
    const w = buf[24] | (buf[25] << 8) | (buf[26] << 16);
    const h = buf[27] | (buf[28] << 8) | (buf[29] << 16);
    return { width: w + 1, height: h + 1 };
  }
  return null;
}

function intrinsicSize(file) {
  const buf = readFileSync(file);
  switch (extname(file).toLowerCase()) {
    case '.png': return pngSize(buf);
    case '.jpg': case '.jpeg': return jpegSize(buf);
    case '.webp': return webpSize(buf);
    default: return null;
  }
}

// -- Extraction ------------------------------------------------------------------

function sizedImages(pageRel) {
  const html = read(pageRel).replace(/<!--[\s\S]*?-->/g, '');
  const out = [];
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const get = (name) => (tag.match(new RegExp(`\\b${name}=["']([^"']+)["']`, 'i')) || [])[1];
    const src = get('src');
    const width = Number(get('width'));
    const height = Number(get('height'));
    if (!src || !(width > 0) || !(height > 0)) continue;
    if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('//')) continue; // external or data:
    if (!/\.(png|jpe?g|webp)(\?|$)/i.test(src)) continue; // svg scales to any box
    const path = src.split(/[?#]/)[0];
    const file = path.startsWith('/')
      ? join(REPO_ROOT, path.slice(1))
      : resolve(REPO_ROOT, dirname(pageRel), path);
    out.push({ tag: tag.slice(0, 80), src, width, height, file });
  }
  return out;
}

const ALL = PAGES.flatMap((page) => sizedImages(page).map((img) => ({ page, ...img })));

test('the scan finds the sized raster images it exists for', () => {
  const logo = ALL.find((i) => i.page === 'partials/header.html' && /logo-top\.png$/.test(i.src));
  assert.ok(logo, 'partials/header.html must still declare width/height on the logo PNG');
  assert.ok(ALL.length >= 5, `only ${ALL.length} sized raster images found across the pages`);
});

for (const img of ALL) {
  test(`${img.page}: ${img.src} declared ${img.width}x${img.height} matches the file ratio`, () => {
    assert.ok(existsSync(img.file), `${img.src} does not exist on disk`);
    const real = intrinsicSize(img.file);
    assert.ok(real && real.width > 0 && real.height > 0, `could not read the dimensions of ${img.src}`);
    const declared = img.width / img.height;
    const intrinsic = real.width / real.height;
    const drift = Math.abs(declared - intrinsic) / intrinsic;
    assert.ok(drift <= TOLERANCE,
      `declared ${img.width}x${img.height} (${declared.toFixed(3)}) vs file ${real.width}x${real.height} `
      + `(${intrinsic.toFixed(3)}): ${(drift * 100).toFixed(1)}% apart, more than ${TOLERANCE * 100}%`);
  });
}
