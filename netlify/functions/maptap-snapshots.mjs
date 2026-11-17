// MapTap Rivals: an enabled account registers its roster and reads its
// scheduled pre-game snapshots here (lib/maptap-snapshots.mjs handleSnapshots).

import { SNAPSHOT_STORE, handleSnapshots } from './lib/maptap-snapshots.mjs';

export default async (request) => {
  const { getStore } = await import('@netlify/blobs');
  return handleSnapshots(request, {
    store: getStore({ name: SNAPSHOT_STORE, consistency: 'strong' }),
    allowlist: process.env.MAPTAP_SNAPSHOT_UIDS,
  });
};
