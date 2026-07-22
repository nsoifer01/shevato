// Etag-conditional (compare-and-swap) updates for the tp-places usage blob.
//
// WHY THIS EXISTS: the quota counters are shared read-modify-write state, and
// Netlify runs one function instance per request. A plain get + setJSON lets
// two parallel batches read the same counters, and whichever write lands last
// erases the other's reservation. Serial requests never see it; an abuser who
// simply fires requests CONCURRENTLY walks through every cap, including the
// monthly one that bounds real money. Netlify Blobs supports conditional
// writes (@netlify/blobs >= 8.1: onlyIfMatch / onlyIfNew), which turns the
// reservation into an atomic claim: the write lands only if the blob is
// unchanged since it was read, and a lost race retries against fresh counters.
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
    // Conditional setJSON resolves { modified: false } when the precondition
    // failed. Anything else (true, or an implementation that returns nothing)
    // means the write landed.
    if (!res || res.modified !== false) return { ok: true, result };
  }
  return { ok: false };
}
