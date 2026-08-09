// The CAS helper started life here, scoped to tp-places, and moved to
// blob-cas.mjs when tp-assist picked up the same reservation pattern (its
// plain get + setJSON had the exact race documented there). This re-export
// keeps existing imports and the test file's name meaningful.
export { updateUsage, MAX_CAS_ATTEMPTS } from './blob-cas.mjs';
