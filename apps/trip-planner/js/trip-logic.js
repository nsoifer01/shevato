'use strict';

// Pure, DOM-free trip logic: dates, validation, coverage, stats, and the
// route-helper math. Loaded as a classic script (window.TripLogic) by the
// app and require()d directly by the node:test suite.
const TripLogic = (() => {
  const DAY = 86400000;

  // type order controls same-day sorting: travel first, stays last
  const TYPE_ORDER = { flight: 0, transport: 1, activity: 2, stay: 3, note: 4 };

  // ---------- dates (all UTC to dodge timezone drift) ----------
  const isIsoDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z'));
  const toUtc = s => new Date(s + 'T00:00:00Z');
  const diffDays = (a, b) => Math.round((toUtc(b) - toUtc(a)) / DAY);
  function addDays(s, n) {
    const d = new Date(toUtc(s).getTime() + n * DAY);
    return d.toISOString().slice(0, 10);
  }

  // ---------- items ----------
  const isStay = it => it.type === 'stay';

  function nights(it) {
    if (!isStay(it) || !isIsoDate(it.startDate) || !isIsoDate(it.endDate)) return null;
    const n = diffDays(it.startDate, it.endDate);
    return n > 0 ? n : null;
  }

  function sortKey(it) {
    const t = TYPE_ORDER[it.type] !== undefined ? TYPE_ORDER[it.type] : 9;
    return `${it.startDate || '9999-99-99'}|${it.startTime || '99:99'}|${t}|${it.createdAt || ''}`;
  }
  function sortedItems(trip) { return [...trip.items].sort((a, b) => sortKey(a) < sortKey(b) ? -1 : 1); }

  // consecutive stays in different places = a travel leg for the route helper
  function tripLegs(trip) {
    const stays = sortedItems(trip).filter(it => isStay(it) && it.status !== 'cancelled' && (it.location || '').trim());
    const legs = [];
    for (let i = 1; i < stays.length; i++) {
      const from = stays[i - 1], to = stays[i];
      if (from.location.trim().toLowerCase() !== to.location.trim().toLowerCase()) {
        legs.push({ from: from.location.trim(), to: to.location.trim(), toId: to.id, date: to.startDate || '' });
      }
    }
    return legs;
  }

  // ---------- validation ----------
  function validateItem(it) {
    const errs = {};
    if (!it.title || !it.title.trim()) errs.title = true;
    if (!isIsoDate(it.startDate)) errs.start = true;
    if (isStay(it)) {
      if (!isIsoDate(it.endDate)) errs.end = 'Check-out date is required for a stay.';
      else if (!errs.start && diffDays(it.startDate, it.endDate) <= 0) errs.end = 'Check-out must be after check-in.';
    } else if (it.endDate) {
      // Arrival may be the SAME day even with an "earlier" local time
      // (timezones), but never a day before departure.
      if (!isIsoDate(it.endDate)) errs.end = 'Arrival date is invalid.';
      else if (!errs.start && diffDays(it.startDate, it.endDate) < 0) errs.end = 'Arrival cannot be before departure.';
    }
    if (it.cost != null && it.cost !== '' && (isNaN(it.cost) || Number(it.cost) < 0)) errs.cost = true;
    return errs;
  }

  // ---------- night coverage ----------
  function coverageGaps(stays, tripEnd, travel = []) {
    if (!stays.length) return [];
    const first = stays.reduce((m, s) => s.startDate < m ? s.startDate : m, stays[0].startDate);
    let last = stays.reduce((m, s) => s.endDate > m ? s.endDate : m, stays[0].endDate);
    if (tripEnd && isIsoDate(tripEnd) && tripEnd > last) last = tripEnd;
    if (last <= first) return [];
    const covered = new Set();
    for (const s of [...stays, ...travel]) {
      for (let d = s.startDate; d < s.endDate; d = addDays(d, 1)) covered.add(d);
    }
    const gaps = [];
    let run = null;
    for (let d = first; d < last; d = addDays(d, 1)) {
      if (!covered.has(d)) {
        if (!run) run = { start: d, end: d };
        run.end = d;
      } else if (run) {
        gaps.push(finishGap(run)); run = null;
      }
    }
    if (run) gaps.push(finishGap(run));
    return gaps;
  }
  function finishGap(run) {
    const nightsCount = diffDays(run.start, run.end) + 1;
    return { start: run.start, end: addDays(run.end, 1), nights: nightsCount };
  }

  // ---------- derived totals ----------
  function tripStats(trip) {
    const items = trip.items.filter(it => it.status !== 'cancelled');
    const dated = items.filter(it => isIsoDate(it.startDate));
    let start = null, end = null;
    for (const it of dated) {
      if (!start || it.startDate < start) start = it.startDate;
      const itemEnd = isIsoDate(it.endDate) && it.endDate > it.startDate ? it.endDate : it.startDate;
      if (!end || itemEnd > end) end = itemEnd;
    }
    const confirmed = items.filter(it => it.status === 'booked' && it.cost != null && it.cost !== '')
      .reduce((s, it) => s + Number(it.cost), 0);
    const planned = items.filter(it => it.cost != null && it.cost !== '')
      .reduce((s, it) => s + Number(it.cost), 0);
    // A night counts as booked when ANY booked item spans it: a hotel stay
    // or an overnight flight/train (the plane is that night's bed). A Set
    // dedupes nights covered by both (e.g. a red-eye landing mid-stay).
    const bookedNightSet = new Set();
    const bookedSpans = items.filter(it => it.status === 'booked' && isIsoDate(it.startDate) && isIsoDate(it.endDate) && diffDays(it.startDate, it.endDate) > 0);
    for (const it of bookedSpans) {
      for (let d = it.startDate; d < it.endDate; d = addDays(d, 1)) bookedNightSet.add(d);
    }
    const bookedNights = bookedNightSet.size;
    const totalTripNights = start && end ? diffDays(start, end) : 0;
    return { start, end, confirmed, planned, bookedNights, totalTripNights, count: items.length };
  }

  // ---------- route helper math ----------
  const ISLANDISH = /\b(koh?|ko|phi phi|railay|samui|lanta|tao|phangan|chang|lipe|similan|island|isla|beach)\b/i;

  // Countries with an operating high-speed rail network (>=250 km/h lines).
  // Gates the "fast rail roughly halves this" note on the train option.
  const HSR_COUNTRIES = new Set([
    'JP', 'CN', 'KR', 'TW', 'ID', 'UZ', 'SA', 'TR', 'MA', 'RU',
    'FR', 'DE', 'ES', 'IT', 'GB', 'BE', 'NL', 'AT', 'CH', 'US',
  ]);
  const hasFastRail = cc => HSR_COUNTRIES.has(String(cc || '').toUpperCase());

  function distKm(a, b) {
    const rad = x => x * Math.PI / 180;
    const R = 6371;
    const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.asin(Math.sqrt(h));
  }

  function flagEmoji(cc) {
    if (!cc || !/^[A-Z]{2}$/.test(cc)) return '📍';
    return String.fromCodePoint(...[...cc].map(c => 127397 + c.charCodeAt(0)));
  }

  function compass(a, b) {
    const rad = x => x * Math.PI / 180;
    const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
    const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
    const deg = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
    return ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'][Math.round(deg / 45) % 8];
  }

  function fmtDur(min) {
    min = Math.round(min);
    if (min < 60) return `${min}m`;
    const h = Math.floor(min / 60), m = min % 60;
    return m ? `${h}h ${m}m` : `${h}h`;
  }

  // Rough door-to-door options by straight-line distance. Real routes are
  // longer than the crow flies, so pad ground modes by ~25%.
  function modeOptions(km, island, fastRail) {
    const ground = km * 1.25;
    const rows = [];
    if (km < 8) rows.push({ i: '🚶', name: 'Walk', dur: fmtDur(ground * 12), note: 'or minutes in a taxi' });
    if (km >= 2 && km < 60) rows.push({ i: '🚕', name: 'Taxi / local transit', dur: `~${fmtDur(ground / 40 * 60)}`, note: 'metro, city bus or rideshare' });
    if (km >= 40 && km < 1200 && !island) rows.push({ i: '🚆', name: 'Train', dur: `~${fmtDur(ground / 105 * 60)}`, note: fastRail ? 'fast rail (Shinkansen/HSR/TGV-class) roughly halves this' : 'where rail exists' });
    if (km >= 40 && km < 900) rows.push({ i: '🚌', name: 'Bus / car', dur: `~${fmtDur(ground / 70 * 60)}`, note: 'buses in Asia often run overnight on long legs' });
    if (km >= 250) rows.push({ i: '✈️', name: 'Fly', dur: `~${fmtDur(km / 750 * 60 + 35)} in the air`, note: 'add 2-3h for airports; check budget carriers on the flight link below' });
    if (island) rows.push({ i: '⛴️', name: 'Ferry / speedboat', dur: 'varies', note: 'island legs usually end on a boat; combo tickets (bus + boat) are common in Thailand' });
    return rows.slice(0, 4);
  }

  return {
    isIsoDate, toUtc, diffDays, addDays,
    isStay, nights, sortKey, sortedItems, tripLegs,
    validateItem, coverageGaps, tripStats,
    ISLANDISH, distKm, flagEmoji, compass, fmtDur, modeOptions, hasFastRail,
  };
})();

if (typeof window !== 'undefined') window.TripLogic = TripLogic;
if (typeof module !== 'undefined' && module.exports) module.exports = TripLogic;
