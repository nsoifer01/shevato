#!/usr/bin/env node
/**
 * Build per-page Open Graph / Twitter card images.
 *
 * Reads assets/og/cards.json and renders assets/og/card.html (filled via query
 * string) to a 1200x630 PNG per entry under images/og/<slug>.png, using headless
 * Chromium. Static, committed output - social crawlers fetch the PNGs directly,
 * this script only regenerates them.
 *
 * Usage:
 *   node assets/og/build-og-cards.mjs            # build every card
 *   node assets/og/build-og-cards.mjs maptap-rivals arena   # build a subset
 *   CHROMIUM=/path/to/chrome node assets/og/build-og-cards.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const templatePath = resolve(here, 'card.html');
const manifestPath = resolve(here, 'cards.json');
const outDir = resolve(repoRoot, 'images', 'og');

const WIDTH = 1200;
const HEIGHT = 630;

/** Resolve a usable Chromium/Chrome binary. */
function resolveChromium() {
  if (process.env.CHROMIUM) return process.env.CHROMIUM;
  const candidates = [
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/snap/bin/chromium',
    '/usr/bin/google-chrome',
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error('No Chromium binary found. Set CHROMIUM=/path/to/chrome.');
}

/** Build the file:// URL for one card, with its fields query-encoded. */
function cardUrl(card) {
  const url = pathToFileURL(templatePath);
  for (const key of ['eyebrow', 'title', 'subtitle', 'accent']) {
    if (card[key] != null) url.searchParams.set(key, card[key]);
  }
  return url.href;
}

function main() {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const only = new Set(process.argv.slice(2));
  const cards = manifest.cards.filter((c) => only.size === 0 || only.has(c.slug));

  if (cards.length === 0) {
    console.error('No matching cards in manifest.');
    process.exit(1);
  }

  mkdirSync(outDir, { recursive: true });
  const chromium = resolveChromium();

  for (const card of cards) {
    const out = resolve(outDir, `${card.slug}.png`);
    execFileSync(chromium, [
      '--headless',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-sandbox',
      '--force-device-scale-factor=1',
      `--window-size=${WIDTH},${HEIGHT}`,
      `--screenshot=${out}`,
      cardUrl(card),
    ], { stdio: ['ignore', 'ignore', 'inherit'] });

    if (!existsSync(out)) {
      throw new Error(`Chromium did not write ${out}`);
    }
    console.log(`  ok  images/og/${card.slug}.png`);
  }

  console.log(`\nBuilt ${cards.length} OG card(s) into images/og/.`);
}

main();
