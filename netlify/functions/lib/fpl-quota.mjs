// Rate-limit math for the FPL proxy. Pure, store-injected by the caller, so
// node:test drives every rollover deterministically.
//
// WHAT IT BOUNDS, AND WHAT IT DELIBERATELY DOES NOT.
//
// fpl.mjs had an origin check, a GET check and an anchored path allowlist, and
// then nothing. A proof of concept ran 500 distinct `entry/<n>/history` paths
// and got 500 upstream fetches and 500 permanent blob keys for them. The path
// cardinality is attacker-chosen across roughly 11 million real FPL team ids,
// and varying the id defeats the EDGE cache too, so neither the CDN in front
// nor the blob cache behind bounds any of it. The origin check cannot: it is a
// forgeable header, and this repo's own evidence-probe.mjs spoofs it.
//
// So what is metered is exactly the thing that costs: an upstream fetch on a
// cache MISS. A cache hit is free, unconditionally, however many arrive. That
// placement is the whole design - the claim is made around the upstream fetch
// in fpl.mjs, not at the top of the handler - and it has a second benefit:
// writes to the counter blob happen only as often as misses do, which is what
// keeps CAS contention on it rare.
//
// NETWORK-SCOPED, AND ONLY NETWORK-SCOPED. The Trip Planner functions meter a
// caller-minted `clientId` as well, but the FPL Planner mints no per-browser
// identifier and must not start: that would be a new identifier with privacy
// consequences (privacy.html promises these requests carry none), bought in
// exchange for a dimension the caller chooses for itself and can rotate. The
// network bucket is a day-salted digest of the address the platform reports
// (lib/tp-client-identity.mjs), so nothing durable is stored and no raw address
// is written anywhere.
//
// THERE IS DELIBERATELY NO GLOBAL CAP. tp-places has one because a global cap
// is what stands between the owner and a bill. Nothing here is billable: the
// FPL API is public and free, and what is at stake is availability (our egress
// being throttled by FPL, and blob keys accumulating). A global cap would
// convert one abusive source into a site-wide outage for every honest manager,
// which is a strictly worse failure than the one it would prevent. If FPL ever
// starts charging or hard-blocking, that reasoning changes and a global
// dimension belongs here.
//
// Usage shape (stale buckets pruned on every call, so the blob stays bounded):
//   { hourBucket, dayBucket, networkHour: { net: n }, networkDay: { net: n } }

// The key the counters live under, inside the SAME `fpl-planner` blob store as
// the cache. Distinct from every key fpl-cache.mjs writes: cache entries are
// `v1:<flattened path>`, leases are `lease:<cache key>`, and the deadline is
// `meta:next-deadline`.
export const QUOTA_KEY = 'quota:v1';

// HOW BIG ONE REAL SESSION IS (measured against apps/fpl-planner/js/data/api.js
// and js/app.js, 2026-09-11), because the cap has to sit well clear of it.
//
// Distinct paths one manager's browser asks for, in full:
//   bootstrap-static, fixtures                                            2
//   entry/<id>, entry/<id>/history, entry/<id>/transfers                  3
//   entry/<id>/event/<gw>/picks (the planned gameweek)                    1
//   entry/<id>/event/<gw-1>/picks (only after a Free Hit)                 1
//   event/<gw>/live                                                       1
//   entry/<id>/event/<gw>/picks x8 (History tab captains, once a session) 8
//                                                                       ---
//                                                                        16
// (element-summary is on the allowlist but no call site uses it today.)
//
// Those are DISTINCT PATHS, not misses. What actually turns into misses over an
// hour is bounded by each path's server TTL, and the shared paths do not scale
// with the number of visitors at all - a thousand managers asking for
// bootstrap-static still cost one fetch per TTL window:
//   event/<gw>/live   60s TTL, and app.js polls it every 30s behind a 60s
//                     client TTL -> at most 60 misses an hour, per NETWORK,
//                     no matter how many managers are behind it
//   entry/* paths     300s TTL -> 12 an hour each for a manager who hammers
//                     "Check for changes" for the whole hour
//   bootstrap-static  600s TTL -> 6 an hour
//   fixtures         1800s TTL -> 2 an hour
//
// A pathological but legitimate single manager, during a live gameweek, with
// the History tab open and refreshing hard: 60 live + ~8 entry paths at 12 =
// ~96 + 6 + 2, call it 165 an hour. A realistic heavy one is nearer 80.
//
//   perNetworkHour 300   roughly twice that pathological hour, so a household
//                        or a small office of managers behind one address is
//                        comfortable, and a carrier-grade NAT is fine too: the
//                        per-manager part is only the ~5-16 entry paths of
//                        their own team, since every shared path is a cache hit
//                        for everyone after the first.
//   perNetworkDay 1500   five heavy hours, not twenty-four. A whole deadline
//                        day of live polling plus boot churn is ~500 for one
//                        manager, so this is ~3x the heaviest real day while
//                        still cutting a paced attacker (300/hour x 24 = 7200)
//                        down by nearly 80%.
//
// Both are generous on purpose. The failure being prevented costs traffic and
// blob keys; the failure being risked by a tight cap is a manager locked out of
// their own team, and that is the worse one.
export const DEFAULT_LIMITS = {
  perNetworkHour: 300,
  perNetworkDay: 1500,
};

const HOUR_MS = 3600000;
const DAY_MS = 86400000;

function hourBucket(now) { return Math.floor(now / HOUR_MS); }
function dayBucket(now) { return Math.floor(now / DAY_MS); }

// Null-prototype maps, for the same reason both sibling quota modules give: a
// counter name that lands on Object.prototype (`__proto__`) reads a truthy
// non-number, so every `>=` compare against a cap is false and the increment
// silently no-ops - one name that can never hit a cap. networkBucket only ever
// returns hex or '', so this is belt and braces here rather than a live hole,
// and it costs nothing to keep the three modules identical on the point.
const bareMap = src => Object.assign(Object.create(null), src);

// Carry forward only the counters whose bucket still matches now. Everything
// from an elapsed hour or day is dropped, which is what keeps the stored blob
// bounded by the traffic of the current day rather than by all traffic ever.
function pruneUsage(usage, hb, db) {
  const u = (usage && typeof usage === 'object') ? usage : {};
  return {
    hourBucket: hb,
    dayBucket: db,
    networkHour: (u.hourBucket === hb && u.networkHour && typeof u.networkHour === 'object') ? bareMap(u.networkHour) : Object.create(null),
    networkDay: (u.dayBucket === db && u.networkDay && typeof u.networkDay === 'object') ? bareMap(u.networkDay) : Object.create(null),
  };
}

/**
 * Claim one upstream fetch for `networkId`.
 *
 * Returns { allowed, scope?, usage }. On an allowed call the returned usage has
 * the slot reserved, so the caller persists it (conditionally, see
 * lib/blob-cas.mjs) before going upstream. On a rejection the counters are
 * unchanged but still pruned, and `scope` names the bucket that refused.
 *
 * An empty `networkId` means the platform reported no address (a local
 * `netlify dev` session, an unusual proxy). That is metered as nothing and
 * allowed: fail open, the same rule the Trip Planner functions use, because a
 * limiter that turns a missing header into an outage is worse than the abuse.
 */
export function checkQuota(usage, networkId, now, limits = DEFAULT_LIMITS) {
  const hb = hourBucket(now);
  const db = dayBucket(now);
  const u = pruneUsage(usage, hb, db);
  const net = String(networkId || '');
  if (!net) return { allowed: true, usage: u };

  const hour = u.networkHour[net] || 0;
  const day = u.networkDay[net] || 0;

  if (hour >= limits.perNetworkHour) return { allowed: false, scope: 'network_hour', usage: u };
  if (day >= limits.perNetworkDay) return { allowed: false, scope: 'network_day', usage: u };

  u.networkHour[net] = hour + 1;
  u.networkDay[net] = day + 1;
  return { allowed: true, usage: u };
}

/**
 * When the bucket that produced a rejection next refills, as epoch ms. The 429
 * carries it both as `Retry-After` and as `resetAt` so a client never has to
 * guess - a flat guess is wrong in both directions, wasting most of the next
 * hour after an hourly rejection and re-asking a daily one every few minutes.
 */
export function resetAtFor(scope, now) {
  const t = Number(now) || 0;
  switch (scope) {
    case 'network_hour': return (hourBucket(t) + 1) * HOUR_MS;
    case 'network_day': return (dayBucket(t) + 1) * DAY_MS;
    default: return t + 15 * 60000;
  }
}
