#!/usr/bin/env node
'use strict';

// "What to watch next" — given a shape (e.g. `slow-burn`), list seasons in
// YOUR Plex TV library that match it. Pragmatic version of idea 5: a NAS-side
// CLI rather than a browser OAuth flow. Designed to be wired into a shell
// alias, a Homarr widget, or a cron job that posts to Discord/Notifiarr.
//
// Plex's TV library stores items with a `guid` field that contains one or
// more external IDs (imdb://, tmdb://, tvdb://). We pull the section, walk
// the shows, parse guids, and join against data.json.
//
// Configuration via env vars:
//   PLEX_URL          required, e.g. http://10.27.184.92:32400
//   PLEX_TOKEN        required (Plex auth token)
//   PLEX_TV_SECTION   optional. Section title or numeric id (default: first
//                     library of type 'show').
//   RS_DATA_JSON      default ../data.json
//   RS_SHAPE          required unless --shape passed. The shape to surface.
//   RS_LIMIT          default 25. Max seasons to print.
//   RS_CONFIDENCE     default 0.35.
//
// CLI flags:
//   --shape <shape>     same as RS_SHAPE
//   --limit  <n>        same as RS_LIMIT
//   --confidence <0..1> same as RS_CONFIDENCE
//   --json              emit JSON instead of human-readable lines
//   --list-shapes       print the available shapes and exit

const fs = require('fs');
const path = require('path');

const VALID_SHAPES = [
  'rising', 'slow-burn', 'big-finale', 'rebound', 'mid-peak', 'u-shaped',
  'saved-best-for-last', 'front-loaded', 'declining', 'bad-finale',
  'rollercoaster', 'consistent', 'shape-drift',
];

function parseArgs(argv) {
  const args = { json: false, listShapes: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--shape') args.shape = argv[++i];
    else if (a === '--limit') args.limit = parseInt(argv[++i], 10);
    else if (a === '--confidence') args.confidence = parseFloat(argv[++i]);
    else if (a === '--json') args.json = true;
    else if (a === '--list-shapes') args.listShapes = true;
    else if (a === '-h' || a === '--help') args.help = true;
  }
  return args;
}

function usage() {
  process.stdout.write(`Usage: watch-next.js --shape <shape> [--limit N] [--confidence 0.X] [--json]

Environment:
  PLEX_URL          e.g. http://10.27.184.92:32400
  PLEX_TOKEN        Plex auth token
  PLEX_TV_SECTION   library title or id (defaults to first 'show' library)
  RS_DATA_JSON      path to data.json
  RS_SHAPE          shape to surface (or use --shape)
  RS_LIMIT          max rows (default 25)
  RS_CONFIDENCE     min confidence (default 0.35)

Shapes: ${VALID_SHAPES.join(', ')}
`);
}

const args = parseArgs(process.argv);
if (args.help) { usage(); process.exit(0); }
if (args.listShapes) {
  for (const s of VALID_SHAPES) process.stdout.write(s + '\n');
  process.exit(0);
}

const shape = args.shape || process.env.RS_SHAPE;
if (!shape) { usage(); process.exit(1); }
if (!VALID_SHAPES.includes(shape)) {
  process.stderr.write(`Unknown shape: ${shape}\nValid shapes: ${VALID_SHAPES.join(', ')}\n`);
  process.exit(1);
}

const plexUrl = process.env.PLEX_URL;
const plexToken = process.env.PLEX_TOKEN;
if (!plexUrl || !plexToken) {
  process.stderr.write('PLEX_URL and PLEX_TOKEN are required.\n');
  process.exit(1);
}

const dataPath = process.env.RS_DATA_JSON || path.join(__dirname, '..', 'data.json');
if (!fs.existsSync(dataPath)) {
  process.stderr.write(`data.json not found at ${dataPath}\n`);
  process.exit(1);
}

const limit = args.limit ?? parseInt(process.env.RS_LIMIT || '25', 10);
const confidenceFloor = args.confidence ?? parseFloat(process.env.RS_CONFIDENCE || '0.35');

async function plexGet(pathSuffix) {
  const u = new URL(plexUrl.replace(/\/$/, '') + pathSuffix);
  u.searchParams.set('X-Plex-Token', plexToken);
  const resp = await fetch(u.toString(), { headers: { 'Accept': 'application/json' } });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Plex ${pathSuffix} -> ${resp.status} ${resp.statusText}\n${text}`);
  }
  return resp.json();
}

function parseGuids(item) {
  const out = { imdb: null, tmdb: null, tvdb: null };
  // Modern Plex returns a Guid array of {id: 'imdb://tt...'}.
  if (Array.isArray(item.Guid)) {
    for (const g of item.Guid) {
      const id = String(g.id || '');
      if (id.startsWith('imdb://')) out.imdb = id.slice('imdb://'.length);
      else if (id.startsWith('tmdb://')) out.tmdb = parseInt(id.slice('tmdb://'.length), 10);
      else if (id.startsWith('tvdb://')) out.tvdb = parseInt(id.slice('tvdb://'.length), 10);
    }
  }
  // Older Plex puts a single ID in `guid` as a Plex agent URL.
  if (!out.imdb && typeof item.guid === 'string') {
    const m = item.guid.match(/imdb:\/\/(tt\d+)/) || item.guid.match(/themoviedb:\/\/(\d+)/) || item.guid.match(/thetvdb:\/\/(\d+)/);
    if (m) {
      if (item.guid.includes('imdb')) out.imdb = m[1];
      else if (item.guid.includes('themoviedb')) out.tmdb = parseInt(m[1], 10);
      else if (item.guid.includes('thetvdb')) out.tvdb = parseInt(m[1], 10);
    }
  }
  return out;
}

(async () => {
  const dataset = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

  // Build lookup maps: seasons of the requested shape, keyed by each ID type.
  const byImdb = new Map();   // seriesId -> [season records]
  const byTmdb = new Map();
  const byTvdb = new Map();
  for (const m of dataset.matches) {
    if (!m.shapes || !m.shapes.includes(shape)) continue;
    const c = (m.confidence && m.confidence[shape]) || 0;
    if (c < confidenceFloor) continue;
    if (m.seriesId) {
      (byImdb.get(m.seriesId) || byImdb.set(m.seriesId, []).get(m.seriesId)).push(m);
    }
    if (m.tmdbId) {
      (byTmdb.get(m.tmdbId) || byTmdb.set(m.tmdbId, []).get(m.tmdbId)).push(m);
    }
    if (m.tvdbId) {
      (byTvdb.get(m.tvdbId) || byTvdb.set(m.tvdbId, []).get(m.tvdbId)).push(m);
    }
  }

  // Discover the TV section.
  const sections = await plexGet('/library/sections');
  const all = (sections.MediaContainer && sections.MediaContainer.Directory) || [];
  const requested = process.env.PLEX_TV_SECTION;
  let section = null;
  if (requested) {
    section = all.find((d) => d.title === requested || String(d.key) === String(requested));
  }
  if (!section) section = all.find((d) => d.type === 'show');
  if (!section) {
    process.stderr.write('No TV library found on this Plex server.\n');
    process.exit(1);
  }

  // Pull all shows from the section.
  const all2 = await plexGet(`/library/sections/${section.key}/all?type=2&includeGuids=1`);
  const shows = (all2.MediaContainer && all2.MediaContainer.Metadata) || [];

  const hits = [];
  for (const show of shows) {
    const guids = parseGuids(show);
    let candidates = null;
    if (guids.imdb && byImdb.has(guids.imdb)) candidates = byImdb.get(guids.imdb);
    else if (guids.tmdb && byTmdb.has(guids.tmdb)) candidates = byTmdb.get(guids.tmdb);
    else if (guids.tvdb && byTvdb.has(guids.tvdb)) candidates = byTvdb.get(guids.tvdb);
    if (!candidates) continue;

    for (const m of candidates) {
      hits.push({
        title: show.title || m.title,
        season: m.season,
        avgRating: m.avgRating,
        confidence: m.confidence[shape],
        seriesYear: show.year || m.year,
        plexKey: show.key,
        ids: guids,
      });
    }
  }

  hits.sort((a, b) => b.confidence - a.confidence || b.avgRating - a.avgRating);
  const top = hits.slice(0, limit);

  if (args.json) {
    process.stdout.write(JSON.stringify({ shape, confidenceFloor, total: hits.length, results: top }, null, 2) + '\n');
    return;
  }

  if (top.length === 0) {
    process.stdout.write(`No "${shape}" seasons found in your Plex library "${section.title}" (above confidence ${confidenceFloor}).\n`);
    return;
  }
  process.stdout.write(`Top ${top.length} of ${hits.length} "${shape}" seasons in "${section.title}":\n\n`);
  for (const h of top) {
    process.stdout.write(`  ${h.title.padEnd(40)}  S${String(h.season).padStart(2, '0')}  avg ${h.avgRating.toFixed(2)}  conf ${h.confidence.toFixed(2)}\n`);
  }
})().catch((err) => {
  process.stderr.write(`watch-next: ${err.stack || err.message}\n`);
  process.exit(2);
});
