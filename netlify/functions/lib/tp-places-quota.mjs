// Rate-limit math for tp-places. Same shape as tp-assist-quota.mjs, kept
// separate rather than shared for two reasons that only apply to Places:
//
//  1. COST IS PER LOOKUP, NOT PER REQUEST. One HTTP request carries a batch of
//     queries, and each cache-missing query is a billed Place Details call
//     ($0.02 at the Enterprise SKU). So the counters move by `cost`, not by 1.
//  2. THE FREE ALLOWANCE IS MONTHLY. Google gives 1,000 complimentary Place
//     Details Enterprise calls per CALENDAR month; past that it is real money
//     on the owner's card. An hour/day cap alone cannot bound a month, so
//     there is a month bucket here that tp-assist has no use for.
//
// Usage shape (stale buckets pruned on every call, so the blob stays bounded):
//   { hourBucket, dayBucket, monthBucket,
//     clientHour:{id:n}, clientDay:{id:n}, globalDay, globalMonth,
//     ownerDay, ownerMonth }
// The owner tier (requests carrying the ownerToken secret from the config
// blob) spends against ownerDay / ownerMonth instead of the global buckets,
// so a heavy owner session can never exhaust the public allowance and lock
// ordinary visitors out; the per-client maps are shared across tiers.

// Defaults justified against $0.02 per billed lookup (Place Details
// Enterprise, $20 / 1000, first 1,000 calls each month free):
//   perClientHour 30   ~2 full day-plans of candidates; $0.60 worst case
//   perClientDay  60   a heavy planning session; $1.20 worst case
//   globalDay    200   $4.00/day ceiling if the site is discovered or abused
//   globalMonth 1500   THE ONE THAT PROTECTS THE CARD: 1,000 free + 500 paid
//                      = $10.00/month absolute worst case, and only if every
//                      single lookup misses the cache.
// Cache hits are free and must never be counted (see tp-places.mjs), so real
// spend sits far below these numbers.
export const DEFAULT_LIMITS = {
  perClientHour: 30,
  perClientDay: 60,
  globalDay: 200,
  globalMonth: 1500,
};

// Owner tier, reachable only with the ownerToken secret from the config blob
// (see tp-places.mjs). Ten times the public limits: high enough that the
// owner never notices a cap in real use, but still a HARD ceiling on purpose.
// The token is a bearer secret, and if it ever leaks, globalMonth here is
// what stands between the leak and the card: 3,000 = 1,000 free + 2,000 paid
// = $40/month absolute worst case. The keys keep the same names as
// DEFAULT_LIMITS so checkQuota treats both tiers identically; only the
// counters they gate differ (owner* vs global*).
export const OWNER_LIMITS = {
  perClientHour: 300,
  perClientDay: 600,
  globalDay: 1000,
  globalMonth: 3000,
};

const HOUR_MS = 3600000;
const DAY_MS = 86400000;

function hourBucket(now) { return Math.floor(now / HOUR_MS); }
function dayBucket(now) { return Math.floor(now / DAY_MS); }
// Calendar month in UTC, because Google's complimentary allowance resets on a
// calendar boundary and a rolling 30-day window would drift out of step with it.
function monthBucket(now) { return new Date(now).toISOString().slice(0, 7); }

function pruneUsage(usage, hb, db, mb) {
  const u = (usage && typeof usage === 'object') ? usage : {};
  return {
    hourBucket: hb,
    dayBucket: db,
    monthBucket: mb,
    clientHour: (u.hourBucket === hb && u.clientHour && typeof u.clientHour === 'object') ? { ...u.clientHour } : {},
    clientDay: (u.dayBucket === db && u.clientDay && typeof u.clientDay === 'object') ? { ...u.clientDay } : {},
    globalDay: (u.dayBucket === db && typeof u.globalDay === 'number') ? u.globalDay : 0,
    globalMonth: (u.monthBucket === mb && typeof u.globalMonth === 'number') ? u.globalMonth : 0,
    ownerDay: (u.dayBucket === db && typeof u.ownerDay === 'number') ? u.ownerDay : 0,
    ownerMonth: (u.monthBucket === mb && typeof u.ownerMonth === 'number') ? u.ownerMonth : 0,
  };
}

// Which pooled counters a tier spends against. Split so the owner's own use
// is still metered (and visible in the blob) without ever consuming the
// public allowance.
function poolKeys(tier) {
  return tier === 'owner'
    ? { day: 'ownerDay', month: 'ownerMonth' }
    : { day: 'globalDay', month: 'globalMonth' };
}

// Returns { allowed, scope?, granted, usage }.
//
// `granted` is a PARTIAL grant: asking for 8 lookups with 3 left under a cap
// returns granted 3, not a rejection. A batch of eight cards where five show a
// rating and three stay quiet is a much better outcome than eight blank cards,
// and the caller reserves exactly `granted` before spending. allowed is false
// only when granted would be 0, so the caller can answer 429.
export function checkQuota(usage, clientId, now, cost = 1, limits = DEFAULT_LIMITS, tier = 'public') {
  const hb = hourBucket(now);
  const db = dayBucket(now);
  const mb = monthBucket(now);
  const u = pruneUsage(usage, hb, db, mb);
  const id = String(clientId);
  const want = Math.max(0, Math.floor(cost));
  const pool = poolKeys(tier);

  const room = [
    ['client_hour', limits.perClientHour - (u.clientHour[id] || 0)],
    ['client_day', limits.perClientDay - (u.clientDay[id] || 0)],
    ['global_day', limits.globalDay - u[pool.day]],
    ['global_month', limits.globalMonth - u[pool.month]],
  ];
  let granted = want;
  let scope = null;
  for (const [name, left] of room) {
    if (left < granted) { granted = Math.max(0, left); scope = name; }
  }

  if (granted <= 0) return { allowed: false, scope: scope || 'client_hour', granted: 0, usage: u };

  u.clientHour[id] = (u.clientHour[id] || 0) + granted;
  u.clientDay[id] = (u.clientDay[id] || 0) + granted;
  u[pool.day] += granted;
  u[pool.month] += granted;
  return { allowed: true, scope: granted < want ? scope : null, granted, usage: u };
}

// Hand back slots reserved but never spent (a batch that turned out to be all
// cache hits, or an upstream failure). Reservation happens BEFORE the upstream
// call so parallel batches cannot overrun a cap; without a release, a traveller
// scrolling a cached itinerary would burn a quota that costs nothing to serve.
// Never drops below zero, so a double release cannot mint free calls.
export function releaseQuota(usage, clientId, now, amount, tier = 'public') {
  const u = pruneUsage(usage, hourBucket(now), dayBucket(now), monthBucket(now));
  const id = String(clientId);
  const n = Math.max(0, Math.floor(amount));
  if (!n) return u;
  const pool = poolKeys(tier);
  u.clientHour[id] = Math.max(0, (u.clientHour[id] || 0) - n);
  u.clientDay[id] = Math.max(0, (u.clientDay[id] || 0) - n);
  u[pool.day] = Math.max(0, u[pool.day] - n);
  u[pool.month] = Math.max(0, u[pool.month] - n);
  return u;
}
