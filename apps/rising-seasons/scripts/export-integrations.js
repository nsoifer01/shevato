#!/usr/bin/env node
'use strict';

// Read apps/rising-seasons/data.json and write the static Kometa/MDBList
// artifacts the NAS-side integrations consume:
//
//   exports/kometa/<shape>.yml           (Kometa show collections)
//   exports/kometa/finder-<slug>.yml     (Kometa collections from Show Finder
//                                         presets — see finder-presets.json)
//   exports/kometa/season-overlays.yml   (Kometa season-poster badges)
//   exports/ids/<shape>.txt              (flat IMDb-ID lists for MDBList)
//   exports/README.md                    (regenerated index of what's here)
//
// The exports/ tree is committed to the repo so users can point Kometa at a
// raw GitHub URL and get fresh data on the next refresh without running this
// script themselves. The same logic also powers the in-browser builder at
// /apps/rising-seasons/kometa/ (which re-runs integrations-lib.js client-side).
//
// Tunables (env vars):
//   RS_CONFIDENCE_FLOOR   default 0.35
//   RS_MIN_SERIES         minimum series per Kometa collection (default 3)

const fs = require('fs');
const path = require('path');

const {
  COLLECTION_SHAPES,
  SHAPE_META,
  DEFAULT_CONFIDENCE_FLOOR,
  buildKometaCollections,
  buildFinderCollection,
  buildSeasonOverlays,
  buildIdLists,
} = require('./integrations-lib.js');
const { detectShapes } = require('./match.js');
const { buildShowAgg, parseFinderQuery, filterAndSortRows } = require('./finder-lib.js');

const DATA_FILE = path.join(__dirname, '..', 'data.json');
const PRESETS_FILE = path.join(__dirname, '..', 'finder-presets.json');
const EXPORT_ROOT = path.join(__dirname, '..', 'exports');

// Top-N cap per Finder preset when the preset doesn't set its own `limit` —
// an unbounded filter could turn a collection into thousands of shows.
const DEFAULT_FINDER_LIMIT = 50;

const floor = parseFloat(process.env.RS_CONFIDENCE_FLOOR || String(DEFAULT_CONFIDENCE_FLOOR));
const minSeries = parseInt(process.env.RS_MIN_SERIES || '3', 10);

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeFileIfChanged(filePath, contents) {
  if (fs.existsSync(filePath)) {
    const prior = fs.readFileSync(filePath, 'utf8');
    if (prior === contents) return false;
  }
  fs.writeFileSync(filePath, contents);
  return true;
}

(function main() {
  if (!fs.existsSync(DATA_FILE)) {
    process.stderr.write(`data.json not found at ${DATA_FILE}. Run \`npm run build:rising-seasons\` first.\n`);
    process.exit(1);
  }
  const t0 = Date.now();
  const dataset = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  console.log(`Loaded ${dataset.matches.length.toLocaleString()} season records (built ${dataset.builtAt}).`);
  console.log(`Confidence floor: ${floor}.  Min series per collection: ${minSeries}.`);
  console.log('');

  const kometaDir = path.join(EXPORT_ROOT, 'kometa');
  const idsDir = path.join(EXPORT_ROOT, 'ids');
  mkdirp(kometaDir);
  mkdirp(idsDir);

  let writes = 0;

  // Kometa collection YAMLs.
  const collections = buildKometaCollections(dataset.matches, {
    confidenceFloor: floor,
    minSeries,
  });
  for (const c of collections) {
    const p = path.join(kometaDir, c.filename);
    if (writeFileIfChanged(p, c.contents)) writes++;
    console.log(`  kometa/${c.filename.padEnd(30)} ${c.seriesCount.toLocaleString().padStart(6)} series`);
  }

  // Show Finder preset collections. Each preset in finder-presets.json is a
  // saved Finder URL hash; replaying it through finder-lib.js (the exact code
  // the browser runs) yields the same rows the user saw, capped at `limit`.
  const finderCollections = [];
  let presets = [];
  if (fs.existsSync(PRESETS_FILE)) {
    presets = JSON.parse(fs.readFileSync(PRESETS_FILE, 'utf8')).presets || [];
  }
  if (presets.length) {
    const showRows = buildShowAgg(dataset.matches, detectShapes);
    console.log('');
    for (const preset of presets) {
      const filter = parseFinderQuery(preset.query || '');
      const rows = filterAndSortRows(showRows, filter);
      const limit = preset.limit ?? DEFAULT_FINDER_LIMIT;
      const col = buildFinderCollection(preset, rows.slice(0, limit), {
        matched: rows.length,
        limit,
      });
      if (!col) {
        console.warn(`  kometa/finder-${preset.slug}.yml SKIPPED — query matched no shows with usable IDs`);
        continue;
      }
      finderCollections.push({ ...col, preset, matched: rows.length });
      const p = path.join(kometaDir, col.filename);
      if (writeFileIfChanged(p, col.contents)) writes++;
      console.log(`  kometa/${col.filename.padEnd(30)} ${String(col.seriesCount).padStart(6)} of ${rows.length.toLocaleString()} matched`);
    }
  }

  // Kometa season-poster overlays.
  const overlays = buildSeasonOverlays(dataset.matches, { confidenceFloor: floor });
  const overlayPath = path.join(kometaDir, 'season-overlays.yml');
  if (writeFileIfChanged(overlayPath, overlays.contents)) writes++;
  console.log(`  kometa/season-overlays.yml         ${overlays.shapesEmitted} shape buckets`);

  // Flat ID lists (MDBList paste-friendly).
  console.log('');
  const idLists = buildIdLists(dataset.matches, { confidenceFloor: floor });
  for (const l of idLists) {
    const p = path.join(idsDir, l.filename);
    if (writeFileIfChanged(p, l.contents)) writes++;
    console.log(`  ids/${l.filename.padEnd(33)} ${l.count.toLocaleString().padStart(6)} IDs`);
  }

  // Regenerate the README index so the exports/ directory is self-describing.
  const readmeLines = [];
  readmeLines.push('# Rising Seasons — NAS integration exports');
  readmeLines.push('');
  readmeLines.push('Generated artifacts consumed by Kometa, MDBList, and Plex.');
  readmeLines.push('Do not edit by hand — regenerated by `npm run export:rising-seasons`.');
  readmeLines.push('');
  readmeLines.push(`Built from data.json at \`${dataset.builtAt}\`.  Confidence floor: \`${floor}\`.`);
  readmeLines.push('');
  readmeLines.push('## kometa/');
  readmeLines.push('');
  readmeLines.push('Per-shape Kometa collection YAMLs. Drop into your `config/` and reference from `config.yml`:');
  readmeLines.push('');
  readmeLines.push('```yaml');
  readmeLines.push('libraries:');
  readmeLines.push('  TV Shows:');
  readmeLines.push('    collection_files:');
  for (const c of collections) {
    readmeLines.push(`      - file: config/rising-seasons/${c.filename}`);
  }
  readmeLines.push('    overlay_files:');
  readmeLines.push('      - file: config/rising-seasons/season-overlays.yml');
  readmeLines.push('```');
  readmeLines.push('');
  readmeLines.push('| Shape | File | Series |');
  readmeLines.push('|---|---|---:|');
  for (const c of collections) {
    readmeLines.push(`| ${SHAPE_META[c.shape].title} | \`kometa/${c.filename}\` | ${c.seriesCount.toLocaleString()} |`);
  }
  readmeLines.push('');
  if (finderCollections.length) {
    readmeLines.push('## kometa/ — Show Finder presets');
    readmeLines.push('');
    readmeLines.push('Plex collections built from saved Show Finder filters (`finder-presets.json`).');
    readmeLines.push('Each replays its Finder URL hash against the latest data, so the list');
    readmeLines.push('refreshes itself on every data update. A preset can reference a template');
    readmeLines.push('defined on the consuming Kometa instance to layer on locally-managed');
    readmeLines.push('collection attributes.');
    readmeLines.push('');
    readmeLines.push('| Preset | File | Shows (of matched) |');
    readmeLines.push('|---|---|---:|');
    for (const c of finderCollections) {
      readmeLines.push(`| ${c.preset.name} | \`kometa/${c.filename}\` | ${c.seriesCount} of ${c.matched.toLocaleString()} |`);
    }
    readmeLines.push('');
  }
  readmeLines.push('## ids/');
  readmeLines.push('');
  readmeLines.push('Plain-text IMDb (`tt`) IDs per shape, one per line. Paste into MDBList to create a list,');
  readmeLines.push('then point Kometa at the MDBList URL with `mdblist_list:`.');
  readmeLines.push('');
  readmeLines.push('| Shape | File | IDs |');
  readmeLines.push('|---|---|---:|');
  for (const l of idLists) {
    readmeLines.push(`| ${SHAPE_META[l.shape].title} | \`ids/${l.filename}\` | ${l.count.toLocaleString()} |`);
  }
  readmeLines.push('');
  readmeLines.push('## Browser UI');
  readmeLines.push('');
  readmeLines.push('A point-and-click builder lives at `/apps/rising-seasons/kometa/` —');
  readmeLines.push('pick shapes, set a confidence floor, preview and download YAML.');
  readmeLines.push('');

  const readmePath = path.join(EXPORT_ROOT, 'README.md');
  if (writeFileIfChanged(readmePath, readmeLines.join('\n') + '\n')) writes++;

  const seconds = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('');
  console.log(`Wrote ${writes} file(s) in ${seconds}s under ${path.relative(process.cwd(), EXPORT_ROOT)}/`);
})();
