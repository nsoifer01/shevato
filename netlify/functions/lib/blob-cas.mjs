// Etag-conditional (compare-and-swap) updates for a shared JSON blob.
// Used by BOTH functions' quota counters (tp-places and tp-assist).
//
// WHY THIS EXISTS: the quota counters are shared read-modify-write state, and
// Netlify runs one function instance per request. A plain get + setJSON lets
// two parallel batches read the same counters, and whichever write lands last
// erases the other's reservation. Serial requests never see it; an abuser who
// simply fires requests CONCURRENTLY walks through every cap, including the
// monthly one that bounds real money. Netlify Blobs supports conditional
// writes (onlyIfMatch / onlyIfNew), which turns the reservation into an
// atomic claim: the write lands only if the blob is unchanged since it was
// read, and a lost race retries against fresh counters.
//
// THE VERSION IS LOAD-BEARING. `setJSON` only forwards the condition from
// @netlify/blobs 10.7.x; 8.x has no conditional write at all and 10.0-10.1
// accept the option on `setJSON` and drop it on the wire (only `set()`
// honours it there). On any of those this file is a plain read-modify-write
// with extra steps, and it says nothing while every reservation races: 50
// concurrent writers were all told "reserved" against one slot. The package
// was pinned at ^8.1.0 for the 25 days after the CAS landed, so the guard
// this file exists to provide never existed in production. The declared
// range and the locked version are asserted by
// `netlify/functions/tests/blobs-version.test.mjs`; `assertConditional`
// below is the runtime half, because a lockfile cannot speak at runtime.
//
// The store is injected so node:test can drive genuine write collisions with
// an in-memory etag store and no Blobs context.

// Retries bound the work one request can be forced to do: burning through five
// CAS rounds means many writers are fighting over one small blob, which only
// happens under exactly the load the quota exists to stop, so the caller
// fails closed (429) rather than reserving optimistically, which would be the
// original race with extra steps.
export const MAX_CAS_ATTEMPTS = 5;

// updateUsage(store, key, compute) -> { ok, result }
//
// compute(usage) receives the freshest counters and returns { write, result }:
//   write   the new usage object to store, or null/undefined to store nothing
//           (a rejected reservation reads the counters but must not move them)
//   result  passed through to the caller untouched
//
// Returns { ok: true, result } once the write lands (or none was needed), or
// { ok: false } when every attempt lost its race. compute may run several
// times, so it must be pure math over its argument; the quota helpers are.
export async function updateUsage(store, key, compute) {
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
    const cur = await store.getWithMetadata(key, { type: 'json' });
    const usage = (cur && cur.data && typeof cur.data === 'object') ? cur.data : {};
    const { write, result } = compute(usage);
    if (!write) return { ok: true, result };
    // A blob that does not exist yet has no etag to match; the equivalent
    // claim is "still missing", so the first-ever write races on onlyIfNew.
    const condition = (cur && cur.etag) ? { onlyIfMatch: cur.etag } : { onlyIfNew: true };
    const res = await store.setJSON(key, write, condition);
    assertConditional(res);
    // Conditional setJSON resolves { modified: false } when the precondition
    // failed and { modified: true } when it landed.
    if (res.modified !== false) return { ok: true, result };
  }
  return { ok: false };
}

// A client that ignores the condition returns undefined rather than
// { modified }. Treating that as "landed" is what let the broken pin pass
// every test and every production request in silence, so say it once, loudly,
// per instance. It does NOT fail the request closed: a quota that has stopped
// being atomic is degraded, and turning that into a 429 for every visitor
// would be a worse outcome than the race it guards. CI is the layer that
// catches it before deploy (blobs-version.test.mjs).
let warnedUnconditional = false;
function assertConditional(res) {
  if (res && typeof res.modified === 'boolean') return;
  if (!warnedUnconditional) {
    warnedUnconditional = true;
    console.error(
      'blob-cas: setJSON ignored the write condition (got '
      + JSON.stringify(res)
      + '), so quota reservations are NOT atomic. Check the @netlify/blobs version: '
      + 'conditional setJSON needs >= 10.7.'
    );
  }
}
