// Hourly capture of FPL's public payloads around each deadline, on Netlify's
// scheduler, into the `fpl-archive` staging store
// (netlify/functions/lib/fpl-archive-stage.mjs explains why this is not left
// to GitHub's scheduler). Almost every run decides there is nothing due and
// returns in about a second; the gate is scripts/lib/archive.mjs
// decideCaptures, unchanged.
//
// "The game is being updated" is a normal state for tens of minutes around a
// deadline: it is logged and the next hour retries. Any other failure is
// logged and thrown, so Netlify records the run as failed.

import { ARCHIVE_STORE, stageCaptures } from './lib/fpl-archive-stage.mjs';

export default async () => {
  const { getStore } = await import('@netlify/blobs');
  try {
    const summary = await stageCaptures({ store: getStore(ARCHIVE_STORE) });
    console.log('fpl-archive-capture', JSON.stringify(summary));
    return new Response(JSON.stringify(summary), { status: 200, headers: { 'content-type': 'application/json' } });
  } catch (err) {
    if (err && err.gameUpdating) {
      console.log('fpl-archive-capture', 'FPL is updating; the next run retries');
      return new Response('updating', { status: 200 });
    }
    console.error('fpl-archive-capture failed', String(err && err.message));
    throw err;
  }
};

// :07 past every hour, off the top of the hour.
export const config = { schedule: '7 * * * *' };
