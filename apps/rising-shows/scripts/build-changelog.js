#!/usr/bin/env node
'use strict';

// Diffs the previous data.json against the freshly-built one and appends
// a summary entry to changelog.json. Used by the daily refresh workflow
// to power the "What's new" popover in the footer.
//
// CLI:
//   node build-changelog.js                       — diff staged data.json against HEAD's data.json
//   node build-changelog.js --prev <path>         — diff against an explicit file
//   node build-changelog.js --prev <p> --new <p>  — both sides explicit
//   node build-changelog.js --out <path>          — override changelog path
//   node build-changelog.js --max <n>             — keep at most N entries (default 30)
//
// The script is intentionally pure-node, no deps, so it runs identically
// inside the GitHub workflow and locally.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DEFAULT_MAX_ENTRIES = 30;
const RATING_SWING_THRESHOLD = 0.2;
const MAX_RATING_SWINGS = 10;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--prev') out.prev = argv[++i];
    else if (a === '--new') out.next = argv[++i];
    else if (a === '--out') out.outPath = argv[++i];
    else if (a === '--max') out.max = parseInt(argv[++i], 10);
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function loadJsonFromFile(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// Reads a file's content at a given git ref. Used to grab the previous
// data.json out of HEAD so we can diff against it. Returns null when the
// path doesn't exist in that ref (first-ever build, fresh checkout, etc).
function loadJsonFromGit(ref, relPath, repoRoot) {
  try {
    // 256 MiB headroom for the post-lower-vote-floor era — data.json
     // grew from ~30 MB to ~85 MB after MIN_VOTES dropped to 5. The
     // previous 64 MiB cap was silently truncating, making the "prev"
     // load return null and treating every season as freshly added.
    const buf = execFileSync('git', ['show', `${ref}:${relPath}`], {
      cwd: repoRoot,
      maxBuffer: 256 * 1024 * 1024,
    });
    return JSON.parse(buf.toString('utf8'));
  } catch {
    return null;
  }
}

function seasonKey(m) {
  return `${m.seriesId}|${m.season}`;
}

function summarizeMatch(m) {
  return {
    seriesId: m.seriesId,
    title: m.title,
    season: m.season,
    seasonYear: m.seasonYear ?? m.year ?? null,
  };
}

/**
 * Compute the diff between two datasets and return a single changelog entry.
 * Exported for testing.
 */
function diffDatasets(prev, next) {
  const prevMatches = (prev && Array.isArray(prev.matches)) ? prev.matches : [];
  const nextMatches = Array.isArray(next?.matches) ? next.matches : [];

  const prevMap = new Map(prevMatches.map((m) => [seasonKey(m), m]));
  const nextMap = new Map(nextMatches.map((m) => [seasonKey(m), m]));

  const added = [];
  const removed = [];
  for (const [k, m] of nextMap) {
    if (!prevMap.has(k)) added.push(summarizeMatch(m));
  }
  for (const [k, m] of prevMap) {
    if (!nextMap.has(k)) removed.push(summarizeMatch(m));
  }

  const modifiedCounts = {};
  const ratingSwings = [];
  for (const [k, n] of nextMap) {
    const o = prevMap.get(k);
    if (!o) continue;
    if (o.seriesVotes !== n.seriesVotes) modifiedCounts.seriesVotes = (modifiedCounts.seriesVotes || 0) + 1;
    if (o.avgRating !== n.avgRating) modifiedCounts.avgRating = (modifiedCounts.avgRating || 0) + 1;
    if (o.seriesRating !== n.seriesRating) modifiedCounts.seriesRating = (modifiedCounts.seriesRating || 0) + 1;
    if (JSON.stringify(o.shapes) !== JSON.stringify(n.shapes)) modifiedCounts.shapes = (modifiedCounts.shapes || 0) + 1;
    if ((o.episodes?.length ?? 0) !== (n.episodes?.length ?? 0)) {
      modifiedCounts.episodeCount = (modifiedCounts.episodeCount || 0) + 1;
    }
    if (o.poster !== n.poster) modifiedCounts.poster = (modifiedCounts.poster || 0) + 1;
    if ((o.providers?.length ?? 0) !== (n.providers?.length ?? 0)) {
      modifiedCounts.providers = (modifiedCounts.providers || 0) + 1;
    }
    if (o.overview !== n.overview) modifiedCounts.overview = (modifiedCounts.overview || 0) + 1;

    if (typeof o.avgRating === 'number' && typeof n.avgRating === 'number') {
      const d = n.avgRating - o.avgRating;
      if (Math.abs(d) >= RATING_SWING_THRESHOLD) {
        ratingSwings.push({
          seriesId: n.seriesId,
          title: n.title,
          season: n.season,
          from: Number(o.avgRating.toFixed(2)),
          to: Number(n.avgRating.toFixed(2)),
          delta: Number(d.toFixed(2)),
        });
      }
    }
  }
  ratingSwings.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  const prevTotal = typeof prev?.count === 'number' ? prev.count : prevMatches.length;
  const nextTotal = typeof next?.count === 'number' ? next.count : nextMatches.length;

  const prevShapes = prev?.shapeCounts || {};
  const nextShapes = next?.shapeCounts || {};
  const shapeDeltas = {};
  const shapeKeys = new Set([...Object.keys(prevShapes), ...Object.keys(nextShapes)]);
  for (const s of shapeKeys) {
    const d = (nextShapes[s] || 0) - (prevShapes[s] || 0);
    if (d !== 0) shapeDeltas[s] = d;
  }

  return {
    builtAt: next?.builtAt || new Date().toISOString(),
    totals: { seasons: nextTotal, delta: nextTotal - prevTotal },
    shapeCounts: nextShapes,
    shapeDeltas,
    added,
    removed,
    ratingSwings: ratingSwings.slice(0, MAX_RATING_SWINGS),
    modifiedCounts,
  };
}

/**
 * Insert `entry` into `changelog.updates` newest-first, de-duplicating
 * by builtAt and capping to `maxEntries`.
 */
function appendEntry(changelog, entry, maxEntries) {
  const updates = Array.isArray(changelog?.updates) ? [...changelog.updates] : [];
  const filtered = updates.filter((u) => u.builtAt !== entry.builtAt);
  filtered.unshift(entry);
  filtered.sort((a, b) => new Date(b.builtAt) - new Date(a.builtAt));
  return { updates: filtered.slice(0, maxEntries) };
}

function findRepoRoot(start) {
  let dir = start;
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    dir = path.dirname(dir);
  }
  return start;
}

function run(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log('Usage: build-changelog.js [--prev <file>] [--new <file>] [--out <file>] [--max <n>]');
    return 0;
  }

  const appDir = path.join(__dirname, '..');
  const repoRoot = findRepoRoot(appDir);
  const relData = path.relative(repoRoot, path.join(appDir, 'data.json'));
  const newPath = args.next || path.join(appDir, 'data.json');
  const outPath = args.outPath || path.join(appDir, 'changelog.json');
  const maxEntries = Number.isFinite(args.max) ? args.max : DEFAULT_MAX_ENTRIES;

  if (!fs.existsSync(newPath)) {
    console.error(`build-changelog: new data file not found at ${newPath}`);
    return 1;
  }
  const next = loadJsonFromFile(newPath);

  let prev = null;
  if (args.prev) {
    if (fs.existsSync(args.prev)) {
      prev = loadJsonFromFile(args.prev);
    } else {
      console.warn(`build-changelog: --prev path ${args.prev} not found, treating as empty.`);
    }
  } else {
    prev = loadJsonFromGit('HEAD', relData, repoRoot);
    if (!prev) {
      console.log('build-changelog: no prior data.json in HEAD — recording initial entry.');
    }
  }

  const entry = diffDatasets(prev, next);

  let existing = null;
  if (fs.existsSync(outPath)) {
    try {
      existing = loadJsonFromFile(outPath);
    } catch (err) {
      console.warn(`build-changelog: could not parse ${outPath}: ${err.message}. Starting fresh.`);
    }
  }
  const updated = appendEntry(existing, entry, maxEntries);

  fs.writeFileSync(outPath, JSON.stringify(updated, null, 2) + '\n');
  const a = entry.added.length;
  const r = entry.removed.length;
  const d = entry.totals.delta;
  const sign = d >= 0 ? '+' : '';
  console.log(`build-changelog: wrote ${path.relative(repoRoot, outPath)} (${updated.updates.length} entries) — added ${a}, removed ${r}, totals ${sign}${d}.`);
  return 0;
}

module.exports = { diffDatasets, appendEntry };

if (require.main === module) {
  process.exit(run(process.argv.slice(2)));
}
