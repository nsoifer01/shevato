// Pure rate-limit math for the Trip Planner site assistant. No I/O here so the
// node:test suite can exercise every window rollover deterministically; the
// handler reads/writes the usage blob around this.
//
// Usage shape (all buckets derived from `now`, stale ones pruned on every call
// so the blob can never grow without bound):
//   { hourBucket, dayBucket, clientHour:{id:count}, clientDay:{id:count},
//     networkHour:{net:count}, networkDay:{net:count}, globalDay }
// clientHour + networkHour reset every hour, clientDay + networkDay +
// globalDay reset every day. The network ids are day-scoped digests of the
// caller's address (lib/tp-client-identity.mjs), never the address itself.

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

const HOUR_MS = 3600000;
const DAY_MS = 86400000;

function hourBucket(now) { return Math.floor(now / HOUR_MS); }
function dayBucket(now) { return Math.floor(now / DAY_MS); }

// The per-client maps are NULL-PROTOTYPE objects, never literals. clientId is
// attacker-chosen, and on a plain object a client calling itself "__proto__"
// reads Object.prototype (so `|| 0` keeps a truthy non-number, every >= cap
// compare is false) and its increment is a silent no-op: that one name would
// never hit a per-client cap at all. With no prototype, "__proto__" is just a
// key like any other. JSON round-trips fine either way.
const bareMap = src => Object.assign(Object.create(null), src);

// Carry forward only the counters whose bucket still matches now; everything
// from an elapsed hour/day is dropped, keeping the stored maps bounded.
function pruneUsage(usage, hb, db) {
  const u = (usage && typeof usage === 'object') ? usage : {};
  return {
    hourBucket: hb,
    dayBucket: db,
    clientHour: (u.hourBucket === hb && u.clientHour && typeof u.clientHour === 'object') ? bareMap(u.clientHour) : Object.create(null),
    clientDay: (u.dayBucket === db && u.clientDay && typeof u.clientDay === 'object') ? bareMap(u.clientDay) : Object.create(null),
    networkHour: (u.hourBucket === hb && u.networkHour && typeof u.networkHour === 'object') ? bareMap(u.networkHour) : Object.create(null),
    networkDay: (u.dayBucket === db && u.networkDay && typeof u.networkDay === 'object') ? bareMap(u.networkDay) : Object.create(null),
    globalDay: (u.dayBucket === db && typeof u.globalDay === 'number') ? u.globalDay : 0,
  };
}

// Returns { allowed, scope?, usage }. On an allowed call the returned usage has
// the client's slot reserved (incremented) so the caller can persist it before
// making the upstream request. On a rejection the counters are unchanged (but
// still pruned), and scope names which limit was hit.
export function checkQuota(usage, clientId, now, limits = DEFAULT_LIMITS, networkId = '') {
  const hb = hourBucket(now);
  const db = dayBucket(now);
  const u = pruneUsage(usage, hb, db);
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

  u.clientHour[id] = clientHour + 1;
  u.clientDay[id] = clientDay + 1;
  if (net) {
    u.networkHour[net] = networkHour + 1;
    u.networkDay[net] = networkDay + 1;
  }
  u.globalDay = global + 1;
  return { allowed: true, usage: u };
}
