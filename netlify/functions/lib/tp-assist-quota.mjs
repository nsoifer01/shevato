// Pure rate-limit math for the Trip Planner site assistant. No I/O here so the
// node:test suite can exercise every window rollover deterministically; the
// handler reads/writes the usage blob around this.
//
// Usage shape (all buckets derived from `now`, stale ones pruned on every call
// so the blob can never grow without bound):
//   { hourBucket, dayBucket, clientHour:{id:count}, clientDay:{id:count}, globalDay }
// clientHour resets every hour, clientDay + globalDay reset every day.

export const DEFAULT_LIMITS = { perClientHour: 10, perClientDay: 30, globalDay: 400 };

const HOUR_MS = 3600000;
const DAY_MS = 86400000;

function hourBucket(now) { return Math.floor(now / HOUR_MS); }
function dayBucket(now) { return Math.floor(now / DAY_MS); }

// Carry forward only the counters whose bucket still matches now; everything
// from an elapsed hour/day is dropped, keeping the stored maps bounded.
function pruneUsage(usage, hb, db) {
  const u = (usage && typeof usage === 'object') ? usage : {};
  return {
    hourBucket: hb,
    dayBucket: db,
    clientHour: (u.hourBucket === hb && u.clientHour && typeof u.clientHour === 'object') ? { ...u.clientHour } : {},
    clientDay: (u.dayBucket === db && u.clientDay && typeof u.clientDay === 'object') ? { ...u.clientDay } : {},
    globalDay: (u.dayBucket === db && typeof u.globalDay === 'number') ? u.globalDay : 0,
  };
}

// Returns { allowed, scope?, usage }. On an allowed call the returned usage has
// the client's slot reserved (incremented) so the caller can persist it before
// making the upstream request. On a rejection the counters are unchanged (but
// still pruned), and scope names which limit was hit.
export function checkQuota(usage, clientId, now, limits = DEFAULT_LIMITS) {
  const hb = hourBucket(now);
  const db = dayBucket(now);
  const u = pruneUsage(usage, hb, db);
  const id = String(clientId);

  const clientHour = u.clientHour[id] || 0;
  const clientDay = u.clientDay[id] || 0;
  const global = u.globalDay || 0;

  if (clientHour >= limits.perClientHour) return { allowed: false, scope: 'client_hour', usage: u };
  if (clientDay >= limits.perClientDay) return { allowed: false, scope: 'client_day', usage: u };
  if (global >= limits.globalDay) return { allowed: false, scope: 'global_day', usage: u };

  u.clientHour[id] = clientHour + 1;
  u.clientDay[id] = clientDay + 1;
  u.globalDay = global + 1;
  return { allowed: true, usage: u };
}
