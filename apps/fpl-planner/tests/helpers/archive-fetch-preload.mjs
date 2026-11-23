// Test only: preloaded with `node --import` by tests/archive-release.test.mjs
// so scripts/archive-snapshot.mjs runs as a real process, exit code included,
// with FPL refusing every read (as on 2026-11-23) and the staged export served
// from ARCHIVE_TEST_STAGED_DIR. ARCHIVE_TEST_SEASONS_STATUS fails the export's
// season list with that status. Any other host is an error.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.env.ARCHIVE_TEST_STAGED_DIR;
const seasonsStatus = Number(process.env.ARCHIVE_TEST_SEASONS_STATUS || 200);

globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  if (url.hostname === 'fantasy.premierleague.com') {
    return new Response('', { status: 403, headers: { 'x-served-by': 'cache-test' } });
  }
  if (url.hostname !== 'staged.test') throw new TypeError(`fetch failed: unexpected host ${url.hostname}`);
  const season = url.searchParams.get('season');
  if (!season) return seasonsStatus === 200 ? Response.json({ seasons: ['2026-27'] }) : new Response('', { status: seasonsStatus });
  const path = join(dir, url.searchParams.get('file') || 'manifest.json');
  return existsSync(path) ? new Response(readFileSync(path)) : Response.json({ error: 'not_found' }, { status: 404 });
};
