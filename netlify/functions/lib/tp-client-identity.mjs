// Who is asking, for the purpose of FAIRNESS - not authentication.
//
// THE PROBLEM (2026-09-05 audit F12): every per-caller cap in this repo is
// keyed on a `clientId` the CALLER mints and sends in the body. That is a
// fairness control for cooperative clients and nothing else: a synthetic
// reproduction rotated the identifier and walked through 400 assistant
// requests, after which an honest new visitor was told `global_day`. The
// global budget bounded the SPEND, exactly as designed; it did not bound one
// caller's share of the AVAILABILITY, and availability is what the honest
// visitor lost.
//
// WHAT THIS ADDS: a second dimension the caller does not choose - a bucket
// derived from the network the request actually arrived from - so that
// rotating client ids no longer multiplies anyone's allowance. It is a
// dimension ALONGSIDE the per-client caps, never instead of them, because
// keying solely on the network is what punishes a school or an office where
// many unrelated people share one address.
//
// WHAT IT DELIBERATELY IS NOT:
//   - It is not authentication. `Origin` is a header a non-browser client
//     sets freely, and so is `X-Forwarded-For` on a request that did not come
//     through the platform's own edge; the values here are used only to
//     decide how much of a shared allowance one source may draw, never to
//     grant access to anything.
//   - It is not a durable identifier. The bucket is a hash of the address
//     SALTED WITH THE DAY, so the same visitor is a different bucket
//     tomorrow, and nothing that outlives a day's counters can be correlated
//     with it. No raw address is ever stored: the quota blobs hold only these
//     day-scoped digests.
//   - It is not a ban list. Exhausting a network bucket costs the rest of
//     that day's share and nothing more.

import { createHash } from 'node:crypto';

const DAY_MS = 86400000;

/**
 * The caller's address as the platform reports it, or '' when it cannot be
 * determined (a local `netlify dev` session, an unusual proxy).
 *
 * `x-nf-client-connection-ip` is Netlify's own header and is set by the edge,
 * not by the client. `x-forwarded-for` is the fallback and its FIRST entry is
 * the original client; later entries are proxies. A client can append to that
 * header but cannot remove what the edge prepends, which is why the first
 * entry is the one taken.
 */
export function clientAddress(req) {
  const h = (name) => {
    try { return (req && req.headers && req.headers.get(name)) || ''; }
    catch { return ''; }
  };
  const direct = h('x-nf-client-connection-ip').trim();
  if (direct) return direct;
  const forwarded = h('x-forwarded-for');
  if (!forwarded) return '';
  return forwarded.split(',')[0].trim();
}

/**
 * A day-scoped, non-reversible bucket id for a network address.
 *
 * Returns '' when there is no address to derive one from, and every caller
 * treats that as "no network dimension" - fail open, because a fairness
 * control that turns into an outage when a header is missing is worse than
 * the unfairness it was guarding against.
 *
 * @param {string} address
 * @param {number} now epoch ms; the day is the salt
 * @returns {string} 16 hex characters, or ''
 */
export function networkBucket(address, now) {
  const addr = String(address || '').trim();
  if (!addr) return '';
  const day = Math.floor((Number(now) || 0) / DAY_MS);
  return createHash('sha256').update(`${day}:${addr}`).digest('hex').slice(0, 16);
}

/** Convenience: straight from a Request to a bucket id. */
export function networkIdFor(req, now) {
  return networkBucket(clientAddress(req), now);
}
