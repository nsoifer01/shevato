// Read-only access to the FPL deadline archive's staging store, so the GitHub
// workflow can copy what Netlify captured on time to the season's release.
//
//   GET ?                          { seasons: ["2026-27", ...] }
//   GET ?season=2026-27            that season's manifest
//   GET ?season=2026-27&file=NAME  one snapshot (gzip), NAME an archive
//                                  snapshot file name and nothing else
//
// Everything in the store is a copy of a PUBLIC Fantasy Premier League
// response (no team ids, no entry data: the archive takes bootstrap-static,
// fixtures, event-status and event/<gw>/live only), so it is served without an
// origin check. Nothing can be written through it.

import {
  ARCHIVE_STORE, validSeason, validFile, stagedSeasons, stagedManifest, stagedFile,
} from './lib/fpl-archive-stage.mjs';

const json = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});

export async function handleExport(request, store) {
  if (request.method !== 'GET') return json(405, { error: 'method_not_allowed' });
  const url = new URL(request.url);
  const season = url.searchParams.get('season');
  const file = url.searchParams.get('file');
  if (!season) return json(200, { seasons: await stagedSeasons(store) });
  if (!validSeason(season)) return json(400, { error: 'bad_season' });
  if (!file) {
    const manifest = await stagedManifest(store, season);
    return manifest ? json(200, manifest) : json(404, { error: 'not_found' });
  }
  if (!validFile(file)) return json(400, { error: 'bad_file' });
  const buf = await stagedFile(store, season, file);
  if (!buf) return json(404, { error: 'not_found' });
  return new Response(buf, { status: 200, headers: { 'content-type': 'application/gzip', 'cache-control': 'public, max-age=86400, immutable' } });
}

export default async (request) => {
  const { getStore } = await import('@netlify/blobs');
  return handleExport(request, getStore(ARCHIVE_STORE));
};
