// Pure rate-limit math for the Trip Planner site assistant. No I/O here so the
// node:test suite can exercise every window rollover deterministically; the
// handler reads/writes the usage blob around this.
//
// Usage shape (all buckets derived from `now`, stale ones pruned on every call
// so the blob can never grow without bound):
//   { hourBucket, dayBucket, monthBucket,
//     clientHour:{id:count}, clientDay:{id:count},
//     networkHour:{net:count}, networkDay:{net:count},
//     globalDay, globalMonth }
// clientHour + networkHour reset every hour, clientDay + networkDay +
// globalDay reset every day, globalMonth resets every billing month. The
// network ids are day-scoped digests of the caller's address
// (lib/tp-client-identity.mjs), never the address itself.

// perClient*  what one cooperative browser may draw.
// perNetwork* what one SOURCE ADDRESS may draw, whatever it calls itself.
//
// The network caps exist because clientId is minted by the caller: rotating
// it walked through the entire 400/day global allowance in a synthetic
// reproduction, after which an honest new visitor was told `global_day`. The
// numbers are three times the per-client caps on purpose - a household or an
// office where three people plan trips on one connection is a real thing and
// must keep working - while still leaving 310 of the 400 daily requests for
// everybody else when one source is being greedy.
export const DEFAULT_LIMITS = {
  perClientHour: 10,
  perClientDay: 30,
  perNetworkHour: 30,
  perNetworkDay: 90,
  globalDay: 400,
};

// THE ONE NUMBER THAT BOUNDS A MONTH.
//
// An hour cap and a day cap cannot do it: globalDay 400 is 12,000 turns in a
// 30-day month, and if the Cloud project holding the Gemini key has billing
// enabled, every one of those is charged. tp-places grew the same dimension for
// the same reason (MONTHLY_BUDGET there) after its hour and day caps were found
// to say nothing at all about a month.
//
// WHY 3,000. The model is pinned to gemini-3.1-flash-lite, measured on
// 2026-07-19 at $0.0005-$0.0029 a turn against the real system contract, so
// 3,000 turns is $1.50-$8.70 at the worst end - a number the owner would not be
// surprised by, which is exactly what this ceiling is for. It leaves the daily
// cap meaningful (a busy day can still spend 400 of it, and the month is 7.5
// such days rather than 30) while cutting the worst reachable month by 75%.
//
// It is a SURPRISE ceiling, not a free-allowance ceiling. tp-places can point
// at a documented 1,000 complimentary calls a month; nothing in this repo says
// what allowance, if any, applies to this key, or even whether billing is on
// for its project. If that is ever established, this number should be re-derived
// from it rather than kept out of habit.
export const MONTHLY_BUDGET = 3000;

const HOUR_MS = 3600000;
const DAY_MS = 86400000;

// WHEN THE MONTH ROLLS, shifted 8 hours later than UTC so the bucket turns at
// 08:00Z on the 1st. Same shift, and the same reasoning, as tp-places-quota:
// the only property that matters is that our month must never reset EARLIER
// than the provider's, because resetting early hands out a fresh budget while
// the provider is still counting the old month against the same allowance.
//
//   provider counts in UTC      -> ours is 8 hours LATE     (stricter)
//   provider counts in Pacific  -> ours is aligned (PST) or
//                                  1 hour late (PDT)        (stricter)
//
// Late in both conventions, which is why the shift is used without needing to
// establish which one applies to this key. A fixed offset also needs no DST
// table and no Intl dependency.
const BILLING_SHIFT_MS = 8 * HOUR_MS;

function hourBucket(now) { return Math.floor(now / HOUR_MS); }
function dayBucket(now) { return Math.floor(now / DAY_MS); }

/** The billing-month bucket ('YYYY-MM'). Exported so tests pin the boundary. */
export function monthBucketOf(now) {
  return new Date(now - BILLING_SHIFT_MS).toISOString().slice(0, 7);
}

/**
 * When the bucket that produced a rejection next refills, as epoch ms.
 *
 * The 429 carries this as `resetAt` and as `Retry-After`, so a client never has
 * to guess. A flat guess is wrong in both directions: an hour of silence after
 * a `client_hour` rejection wastes most of the next hour bucket, and re-asking
 * a monthly cap on that schedule is 700 pointless requests.
 */
export function resetAtFor(scope, now) {
  const t = Number(now) || 0;
  switch (scope) {
    case 'client_hour':
    case 'network_hour': return (hourBucket(t) + 1) * HOUR_MS;
    case 'client_day':
    case 'network_day':
    case 'global_day': return (dayBucket(t) + 1) * DAY_MS;
    case 'global_month': {
      // The next SHIFTED boundary, so what is promised is the one the counter
      // actually honours (08:00Z on the 1st, see BILLING_SHIFT_MS).
      const d = new Date(t - BILLING_SHIFT_MS);
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) + BILLING_SHIFT_MS;
    }
    // Contention is transient by construction (writers fighting over one
    // counter blob), so it clears in seconds rather than at a bucket edge.
    case 'contention': return t + 2000;
    // Covers `upstream`, where Google throttled us rather than we ourselves:
    // we have no idea when that clears, and a quarter of an hour is a better
    // answer than a made-up bucket edge.
    default: return t + 15 * 60000;
  }
}

// The per-client maps are NULL-PROTOTYPE objects, never literals. clientId is
// attacker-chosen, and on a plain object a client calling itself "__proto__"
// reads Object.prototype (so `|| 0` keeps a truthy non-number, every >= cap
// compare is false) and its increment is a silent no-op: that one name would
// never hit a per-client cap at all. With no prototype, "__proto__" is just a
// key like any other. JSON round-trips fine either way.
const bareMap = src => Object.assign(Object.create(null), src);

// Carry forward only the counters whose bucket still matches now; everything
// from an elapsed hour/day is dropped, keeping the stored maps bounded.
function pruneUsage(usage, hb, db, mb) {
  const u = (usage && typeof usage === 'object') ? usage : {};
  return {
    hourBucket: hb,
    dayBucket: db,
    monthBucket: mb,
    clientHour: (u.hourBucket === hb && u.clientHour && typeof u.clientHour === 'object') ? bareMap(u.clientHour) : Object.create(null),
    clientDay: (u.dayBucket === db && u.clientDay && typeof u.clientDay === 'object') ? bareMap(u.clientDay) : Object.create(null),
    networkHour: (u.hourBucket === hb && u.networkHour && typeof u.networkHour === 'object') ? bareMap(u.networkHour) : Object.create(null),
    networkDay: (u.dayBucket === db && u.networkDay && typeof u.networkDay === 'object') ? bareMap(u.networkDay) : Object.create(null),
    globalDay: (u.dayBucket === db && typeof u.globalDay === 'number') ? u.globalDay : 0,
    globalMonth: (u.monthBucket === mb && typeof u.globalMonth === 'number') ? u.globalMonth : 0,
  };
}

// Returns { allowed, scope?, usage }. On an allowed call the returned usage has
// the client's slot reserved (incremented) so the caller can persist it before
// making the upstream request. On a rejection the counters are unchanged (but
// still pruned), and scope names which limit was hit.
export function checkQuota(usage, clientId, now, limits = DEFAULT_LIMITS, networkId = '') {
  const hb = hourBucket(now);
  const db = dayBucket(now);
  const mb = monthBucketOf(now);
  const u = pruneUsage(usage, hb, db, mb);
  const id = String(clientId);
  // '' means the platform gave us no address to derive a bucket from (local
  // dev, an unusual proxy). Fail OPEN: a fairness control that becomes an
  // outage when a header is missing is worse than the unfairness it guards.
  const net = String(networkId || '');

  const clientHour = u.clientHour[id] || 0;
  const clientDay = u.clientDay[id] || 0;
  const networkHour = net ? (u.networkHour[net] || 0) : 0;
  const networkDay = net ? (u.networkDay[net] || 0) : 0;
  const global = u.globalDay || 0;

  if (clientHour >= limits.perClientHour) return { allowed: false, scope: 'client_hour', usage: u };
  if (clientDay >= limits.perClientDay) return { allowed: false, scope: 'client_day', usage: u };
  // Named apart from the client scopes so the UI can say "this connection has
  // used its share of today" rather than blaming the browser in front of it.
  if (net && networkHour >= limits.perNetworkHour) return { allowed: false, scope: 'network_hour', usage: u };
  if (net && networkDay >= limits.perNetworkDay) return { allowed: false, scope: 'network_day', usage: u };
  if (global >= limits.globalDay) return { allowed: false, scope: 'global_day', usage: u };
  // Checked last, so that when the day and the month are both exhausted the
  // response names the month: that is the one worth knowing about, because it
  // is the one that does not refill tomorrow.
  if ((u.globalMonth || 0) >= MONTHLY_BUDGET) return { allowed: false, scope: 'global_month', usage: u };

  u.clientHour[id] = clientHour + 1;
  u.clientDay[id] = clientDay + 1;
  if (net) {
    u.networkHour[net] = networkHour + 1;
    u.networkDay[net] = networkDay + 1;
  }
  u.globalDay = global + 1;
  u.globalMonth = (u.globalMonth || 0) + 1;
  return { allowed: true, usage: u };
}
