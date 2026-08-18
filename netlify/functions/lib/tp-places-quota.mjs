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
//     ownerDay, ownerMonth, billedMonth }
// The owner tier (requests carrying the ownerToken secret from the config
// blob) spends against ownerDay / ownerMonth instead of the global buckets, so
// the two tiers stay visible apart and neither starves the other. `billedMonth`
// is the sum both tiers move: it is the authoritative monthly total and the
// only counter that maps to what Google will bill.

// Per-tier limits. NONE of these is the cost ceiling any more: MONTHLY_BUDGET
// below is, and it is checked for every tier. What survives here is SHAPE -
// how fast one browser or one tier may draw on the shared budget, so that a
// single heavy day cannot swallow the month and the owner cannot leave
// visitors with nothing.
//
//   perClientHour  60  one full read of a large itinerary in an hour
//   perClientDay  120  a heavy planning session across the day
//   globalDay     150  no single day takes more than ~18% of the month
//   globalMonth   850  no sub-ceiling: the public tier may use the whole
//                      shared budget if the owner does not
//
// The per-client numbers moved on 2026-08-17: production 429s were all
// per-CLIENT (`client_hour`, `client_day`) while the pools sat at 7% used, so
// travellers were being cut off by a limiter sized when ratings appeared on
// assistant cards alone. Raising a per-client cap cannot raise spend -
// clientId is client-minted, so those caps were only ever advisory smoothing.
export const DEFAULT_LIMITS = {
  perClientHour: 60,
  perClientDay: 120,
  globalDay: 150,
  globalMonth: 850,
};

// Owner tier, reachable only with the ownerToken secret from the config blob.
// Higher SHAPE limits than the public tier, drawing on the SAME MONTHLY_BUDGET:
// the owner cannot bypass the ceiling, only reach it faster.
//
//   globalMonth 600  the one real sub-ceiling here, and it exists to protect
//                    VISITORS rather than the card: the owner's own browsing
//                    was 1,202 of 1,521 lookups in August 2026, so without
//                    this a heavy planning day would leave the site's actual
//                    visitors with no ratings for the rest of the month.
//                    600 of 850 still leaves at least 250 for the public.
//   globalDay   300  ~10 full reads of a 55-place trip in a day
//
// perClientDay sits above globalDay deliberately so it can never be the limit
// that speaks: the owner is ONE browser with ONE clientId, and on 2026-08-17
// a per-client day cap below the pool cut the owner off with 40% of the tier's
// own allowance unspent. A per-client cap is no defence for a bearer token
// anyway - a thief rotates clientId - so the pool does the ceiling work.
export const OWNER_LIMITS = {
  perClientHour: 300,
  perClientDay: 400,
  globalDay: 300,
  globalMonth: 600,
};

// THE ONE NUMBER THAT KEEPS THE BILL AT ZERO.
//
// Google gives 1,000 complimentary Place Details Enterprise calls per calendar
// month, per SKU, per PROJECT. Past that it is $0.02 a call against a real
// card. This budget is checked for EVERY billable lookup, whatever the tier,
// so owner traffic and public traffic draw on one pot and cannot add up to
// more than the free allowance between them.
//
// WHY 850 AND NOT 1,000. Our counter is not provably equal to Google's. In
// August 2026 Google billed 2,915 Place Details calls while this counter held
// 1,521; a local `netlify dev` store accounted for 129 more, and the rest could
// not be reconciled from the data that exists (the usage blob keeps only the
// current hour/day/month, with no history, and a local store is wiped with the
// directory). A ceiling that assumed our count was exact would therefore be a
// ceiling built on an unproven equality. 150 calls, 15%, is the price of not
// making that assumption, and it also absorbs the month-boundary skew below,
// any manual curl or dev call, and the deliberate over-count of a failed
// Place Details request. Raise it only with evidence that the counter and
// Google's billing agree.
export const MONTHLY_BUDGET = 850;

const HOUR_MS = 3600000;
const DAY_MS = 86400000;

// Google's free allowance resets on the billing account's calendar month, not
// on ours. Resetting EARLIER than Google would hand out a fresh 850 while
// Google is still counting the old month, which is the one direction that can
// produce a bill, so the bucket is shifted 8 hours later than UTC: we roll over
// at 08:00Z on the 1st, which is 00:00 Pacific Standard Time (exact) or 01:00
// Pacific Daylight Time (an hour late, i.e. conservative). If the account's
// zone were UTC we would simply be 8 hours late, which is also safe. The rule
// this encodes: never reset before Google does.
const BILLING_SHIFT_MS = 8 * HOUR_MS;

function hourBucket(now) { return Math.floor(now / HOUR_MS); }
function dayBucket(now) { return Math.floor(now / DAY_MS); }
function monthBucket(now) { return new Date(now - BILLING_SHIFT_MS).toISOString().slice(0, 7); }

// Null-prototype per-client maps, same reason as tp-assist-quota.mjs: clientId
// is attacker-chosen, and on a plain object literal an id of "__proto__" reads
// Object.prototype (making every remaining-room subtraction NaN, which never
// shrinks a grant) while its increment silently no-ops, so that one name never
// hits a per-client cap. With no prototype it is a key like any other.
const bareMap = src => Object.assign(Object.create(null), src);

function pruneUsage(usage, hb, db, mb) {
  const u = (usage && typeof usage === 'object') ? usage : {};
  return {
    hourBucket: hb,
    dayBucket: db,
    monthBucket: mb,
    clientHour: (u.hourBucket === hb && u.clientHour && typeof u.clientHour === 'object') ? bareMap(u.clientHour) : Object.create(null),
    clientDay: (u.dayBucket === db && u.clientDay && typeof u.clientDay === 'object') ? bareMap(u.clientDay) : Object.create(null),
    globalDay: (u.dayBucket === db && typeof u.globalDay === 'number') ? u.globalDay : 0,
    globalMonth: (u.monthBucket === mb && typeof u.globalMonth === 'number') ? u.globalMonth : 0,
    ownerDay: (u.dayBucket === db && typeof u.ownerDay === 'number') ? u.ownerDay : 0,
    ownerMonth: (u.monthBucket === mb && typeof u.ownerMonth === 'number') ? u.ownerMonth : 0,
    // The authoritative one. ownerMonth and globalMonth stay for observability
    // (which tier spent what) but neither is a ceiling any more: billedMonth is
    // every billable lookup this project made this month, whoever asked.
    billedMonth: (u.monthBucket === mb && typeof u.billedMonth === 'number') ? u.billedMonth : 0,
  };
}

// When the bucket that produced a rejection next refills, as an epoch
// millisecond. The client used to guess (a flat hour after ANY 429), which is
// wrong in both directions: it wasted up to 59 minutes of the next hour bucket
// after a client_hour rejection, and it re-asked a monthly cap 24 times a day.
// Exported and unit-tested because it is the only thing standing between an
// exhausted bucket and a retry loop.
export function resetAtFor(scope, now) {
  const t = Number(now) || 0;
  switch (scope) {
    case 'client_hour': return (hourBucket(t) + 1) * HOUR_MS;
    case 'client_day':
    case 'global_day': return (dayBucket(t) + 1) * DAY_MS;
    case 'global_month':
    case 'free_month': {
      // The next SHIFTED month boundary, so the reset we promise is the one
      // the counter actually honours (08:00Z on the 1st, see BILLING_SHIFT_MS).
      const d = new Date(t - BILLING_SHIFT_MS);
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) + BILLING_SHIFT_MS;
    }
    // Contention is transient by construction (writers fighting over one
    // counter blob), so it clears in seconds rather than at a bucket edge.
    case 'contention': return t + 2000;
    default: return t + 15 * 60000;
  }
}

// A read-only view of where the month stands, for the owner status endpoint
// and for logs. Runs the same pruning the write path does, so a stale month in
// the blob reports as zero rather than as last month's total. Deliberately
// carries no clientId and no key: the per-client maps are attacker-supplied
// strings and there is nothing to learn from them here.
export function budgetStatus(usage, now) {
  const u = pruneUsage(usage, hourBucket(now), dayBucket(now), monthBucket(now));
  return {
    month: u.monthBucket,
    monthlyBudget: MONTHLY_BUDGET,
    billedMonth: u.billedMonth,
    remaining: Math.max(0, MONTHLY_BUDGET - u.billedMonth),
    exhausted: u.billedMonth >= MONTHLY_BUDGET,
    resetsAt: new Date(resetAtFor('free_month', now)).toISOString(),
    owner: { day: u.ownerDay, month: u.ownerMonth, dayLimit: OWNER_LIMITS.globalDay, monthLimit: OWNER_LIMITS.globalMonth },
    public: { day: u.globalDay, month: u.globalMonth, dayLimit: DEFAULT_LIMITS.globalDay, monthLimit: DEFAULT_LIMITS.globalMonth },
    clientsSeenThisDay: Object.keys(u.clientDay).length,
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
    // Checked for BOTH tiers, and it is the row that actually stands between
    // this app and a Google invoice. Listed last so that when several caps are
    // exhausted at once the response names this one, which is the one worth
    // knowing about.
    ['free_month', MONTHLY_BUDGET - u.billedMonth],
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
  u.billedMonth += granted;
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
  u.billedMonth = Math.max(0, u.billedMonth - n);
  return u;
}
