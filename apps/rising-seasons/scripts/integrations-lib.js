// Pure functions that turn the data.json `matches` array into the Kometa
// artifacts (collection YAMLs, season-poster overlays, MDBList-style ID
// lists). Loaded by the Node export pipeline AND directly by kometa.html in
// the browser — see the UMD-style export at the bottom. Keep this file free
// of Node-specific APIs (no fs/path/process) so the browser side keeps working.
'use strict';

// Shapes we expose to Kometa. Excludes 'consistent' (low signal — most ~8.0
// seasons get tagged), 'rollercoaster' (descriptive but not actionable for
// collections), and 'shape-drift' (a meta-tag about cross-season trajectory,
// not a single-season shape). These can be re-added by editing this list.
const COLLECTION_SHAPES = [
  'rising',
  'slow-burn',
  'big-finale',
  'rebound',
  'mid-peak',
  'u-shaped',
  'saved-best-for-last',
  'front-loaded',
  'declining',
  'bad-finale',
];

// Human-readable labels used in collection titles, summaries, and overlay text.
const SHAPE_META = {
  'rising':              { title: 'Rising Seasons',              badge: 'RISE',   blurb: 'Seasons whose episode ratings never dip — every episode meets or exceeds the previous one.' },
  'slow-burn':           { title: 'Slow Burn Seasons',           badge: 'BURN',   blurb: 'Seasons where the second half meaningfully outscores the first.' },
  'big-finale':          { title: 'Big Finale Seasons',          badge: 'FINALE', blurb: 'Seasons whose finale beats every other episode by an IMDb step or more.' },
  'rebound':             { title: 'Rebound Seasons',             badge: 'BOUND',  blurb: 'Seasons with a real dip in the middle that recover past where they started.' },
  'mid-peak':            { title: 'Mid-Peak Seasons',            badge: 'PEAK',   blurb: 'Seasons whose strongest episode sits in the middle, with both ends well below it.' },
  'u-shaped':            { title: 'U-Shaped Seasons',            badge: 'U',      blurb: 'Seasons that open and close on highs with a dip in between.' },
  'saved-best-for-last': { title: 'Saved Best For Last',         badge: 'BEST',   blurb: "Final seasons that are also the show's highest-rated season." },
  'front-loaded':        { title: 'Front-Loaded Seasons',        badge: 'FRONT',  blurb: 'Seasons whose first half meaningfully outscores the second.' },
  'declining':           { title: 'Declining Seasons',           badge: 'FALL',   blurb: 'Seasons whose episode ratings never recover after a drop.' },
  'bad-finale':          { title: 'Bad Finale Seasons',          badge: 'BUST',   blurb: 'Seasons whose finale is the trough — meaningfully below the season average.' },
};

const DEFAULT_CONFIDENCE_FLOOR = 0.35;

// Categorical shapes assigned by post-passes in match.js (tagSavedBestForLast,
// tagShapeDrift). They appear in m.shapes[] but are not graded — the detector
// is a deterministic yes/no rather than a margin. Treat them as confidence 1.0
// so the floor filter does not silently drop them.
const CATEGORICAL_SHAPES = new Set(['saved-best-for-last', 'shape-drift']);

function shapeConfidence(match, shape) {
  if (!match.shapes || !match.shapes.includes(shape)) return 0;
  if (CATEGORICAL_SHAPES.has(shape)) return 1.0;
  if (!match.confidence) return 0;
  const c = match.confidence[shape];
  return typeof c === 'number' ? c : 0;
}

function bestConfidenceForShape(matches, shape) {
  // For series-level collections (idea 1), if any season of a series fits a
  // shape strongly, the whole series qualifies — but we use the strongest
  // season's confidence to break ties and apply the floor.
  const bySeries = new Map();
  for (const m of matches) {
    if (!m.shapes || !m.shapes.includes(shape)) continue;
    const conf = shapeConfidence(m, shape);
    const prior = bySeries.get(m.seriesId);
    if (!prior || conf > prior.conf) {
      bySeries.set(m.seriesId, {
        seriesId: m.seriesId,
        title: m.title,
        tmdbId: m.tmdbId || null,
        tvdbId: m.tvdbId || null,
        season: m.season,
        conf,
      });
    }
  }
  return [...bySeries.values()];
}

// Render a YAML scalar safely. Kometa configs are plain YAML — strings that
// contain characters with YAML meaning (`:` `'` `#` `&` etc.) need quoting.
function yamlString(s) {
  if (typeof s !== 'string') return JSON.stringify(s);
  // Always double-quote and escape backslash + double-quote. That covers
  // every special character we care about (titles, summaries, etc.) without
  // having to maintain a special-character allowlist.
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

// Per-shape Kometa collection YAML.
// Returns { filename, contents } records — one per shape that has enough
// qualifying series. Uses `tmdb_show` when available, otherwise `tvdb_show`.
// Matches the user's config patterns: sync_mode: sync, collection_order,
// sort_title, file_poster (commented out — user supplies).
function buildKometaCollections(matches, opts = {}) {
  const floor = opts.confidenceFloor ?? DEFAULT_CONFIDENCE_FLOOR;
  const minSeries = opts.minSeries ?? 3;
  const sortPrefix = opts.sortPrefix ?? 'rs';
  const out = [];

  for (let i = 0; i < COLLECTION_SHAPES.length; i++) {
    const shape = COLLECTION_SHAPES[i];
    const meta = SHAPE_META[shape];
    const candidates = bestConfidenceForShape(matches, shape)
      .filter((c) => c.conf >= floor)
      .sort((a, b) => b.conf - a.conf || a.title.localeCompare(b.title));

    if (candidates.length < minSeries) continue;

    const tmdbIds = [];
    const tvdbIds = [];
    for (const c of candidates) {
      if (c.tmdbId) tmdbIds.push(c.tmdbId);
      else if (c.tvdbId) tvdbIds.push(c.tvdbId);
    }
    if (tmdbIds.length + tvdbIds.length === 0) continue;

    const sortTitle = `!${String(i + 1).padStart(2, '0')}_${sortPrefix}_${shape}`;
    const lines = [];
    lines.push(`# Generated by Rising Seasons (apps/rising-seasons) — do not edit by hand.`);
    lines.push(`# Source: https://shevato.com/rising-seasons/  •  Shape: ${shape}`);
    lines.push(`# Floor: confidence >= ${floor}.  Series count: ${candidates.length}.`);
    lines.push(`collections:`);
    lines.push(`  ${meta.title}:`);
    lines.push(`    summary: ${yamlString(meta.blurb)}`);
    lines.push(`    sort_title: ${yamlString(sortTitle)}`);
    lines.push(`    collection_order: alpha`);
    lines.push(`    sync_mode: sync`);
    if (tmdbIds.length) {
      lines.push(`    tmdb_show:`);
      for (const id of tmdbIds) lines.push(`      - ${id}`);
    }
    if (tvdbIds.length) {
      lines.push(`    tvdb_show:`);
      for (const id of tvdbIds) lines.push(`      - ${id}`);
    }

    out.push({
      shape,
      filename: `${shape}.yml`,
      seriesCount: candidates.length,
      contents: lines.join('\n') + '\n',
    });
  }

  return out;
}

// Kometa season-poster overlay YAML.
// Uses `tvdb_season` (Kometa's season-level builder). One overlay block per
// (shape, list-of-seasonTvdbIds). Designed so badges don't visually collide:
// each shape gets its own corner via `vertical_align` / `horizontal_align`.
const OVERLAY_POSITIONS = {
  'big-finale':          { h: 'right',  v: 'bottom', vo: 175 },
  'saved-best-for-last': { h: 'right',  v: 'bottom', vo: 175 },
  'rising':              { h: 'left',   v: 'bottom', vo: 175 },
  'slow-burn':           { h: 'left',   v: 'bottom', vo: 175 },
  'rebound':             { h: 'center', v: 'top',    vo: 50 },
  'mid-peak':            { h: 'center', v: 'top',    vo: 50 },
  'u-shaped':            { h: 'center', v: 'top',    vo: 50 },
  'front-loaded':        { h: 'left',   v: 'top',    vo: 50 },
  'declining':           { h: 'right',  v: 'top',    vo: 50 },
  'bad-finale':          { h: 'right',  v: 'top',    vo: 50 },
};

function buildSeasonOverlays(matches, opts = {}) {
  const floor = opts.confidenceFloor ?? DEFAULT_CONFIDENCE_FLOOR;

  // Bucket seasons by shape.
  const buckets = new Map();
  for (const shape of COLLECTION_SHAPES) buckets.set(shape, []);
  for (const m of matches) {
    if (!m.seasonTvdbId || !m.shapes) continue;
    for (const shape of m.shapes) {
      if (!buckets.has(shape)) continue;
      if (shapeConfidence(m, shape) < floor) continue;
      buckets.get(shape).push({
        seasonTvdbId: m.seasonTvdbId,
        title: m.title,
        season: m.season,
      });
    }
  }

  const lines = [];
  lines.push(`# Generated by Rising Seasons — season-level shape badges.`);
  lines.push(`# Requires Kometa builder_level: season support on the TV library.`);
  lines.push(`# Drop this file alongside your other overlay_files in config.yml:`);
  lines.push(`#   overlay_files:`);
  lines.push(`#     - file: config/rising_seasons_overlays.yml`);
  lines.push(``);
  lines.push(`overlays:`);

  let emitted = 0;
  for (const shape of COLLECTION_SHAPES) {
    const items = buckets.get(shape);
    if (!items || items.length === 0) continue;
    const meta = SHAPE_META[shape];
    const pos = OVERLAY_POSITIONS[shape] || { h: 'center', v: 'top', vo: 50 };
    // Dedupe — a season can be tagged with the same shape only once.
    const seen = new Set();
    const ids = [];
    for (const it of items) {
      if (seen.has(it.seasonTvdbId)) continue;
      seen.add(it.seasonTvdbId);
      ids.push(it.seasonTvdbId);
    }
    ids.sort((a, b) => a - b);

    lines.push(`  RS ${meta.title}:`);
    lines.push(`    overlay:`);
    lines.push(`      name: text(${meta.badge})`);
    lines.push(`      horizontal_align: ${pos.h}`);
    lines.push(`      vertical_align: ${pos.v}`);
    lines.push(`      vertical_offset: ${pos.vo}`);
    lines.push(`      horizontal_offset: 15`);
    lines.push(`      font_size: 50`);
    lines.push(`      font_color: "#FFFFFF"`);
    lines.push(`      back_color: "#000000B3"`);
    lines.push(`      back_radius: 30`);
    lines.push(`      back_width: 280`);
    lines.push(`      back_height: 80`);
    lines.push(`    builder_level: season`);
    lines.push(`    tvdb_season:`);
    for (const id of ids) lines.push(`      - ${id}`);
    emitted++;
  }

  return { contents: lines.join('\n') + '\n', shapesEmitted: emitted };
}

// Flat IMDb-ID text files per shape (MDBList paste-friendly).
function buildIdLists(matches, opts = {}) {
  const floor = opts.confidenceFloor ?? DEFAULT_CONFIDENCE_FLOOR;
  const out = [];
  for (const shape of COLLECTION_SHAPES) {
    const seen = new Set();
    const ids = [];
    for (const m of matches) {
      if (!m.shapes || !m.shapes.includes(shape)) continue;
      if (shapeConfidence(m, shape) < floor) continue;
      if (seen.has(m.seriesId)) continue;
      seen.add(m.seriesId);
      ids.push(m.seriesId);
    }
    if (ids.length === 0) continue;
    out.push({
      shape,
      filename: `${shape}.txt`,
      count: ids.length,
      contents: ids.join('\n') + '\n',
    });
  }
  return out;
}

const API = {
  COLLECTION_SHAPES,
  SHAPE_META,
  DEFAULT_CONFIDENCE_FLOOR,
  buildKometaCollections,
  buildSeasonOverlays,
  buildIdLists,
  // Exposed for tests:
  yamlString,
  bestConfidenceForShape,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = API;
} else if (typeof window !== 'undefined') {
  window.RisingSeasonsIntegrations = API;
}
