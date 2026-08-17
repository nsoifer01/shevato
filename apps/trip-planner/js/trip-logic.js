'use strict';

// Pure, DOM-free trip logic: dates, validation, coverage, stats, and the
// route-helper math. Loaded as a classic script (window.TripLogic) by the
// app and require()d directly by the node:test suite.
const TripLogic = (() => {
  const DAY = 86400000;

  // type order controls same-day sorting: travel first, stays last
  const TYPE_ORDER = { flight: 0, transport: 1, local: 2, activity: 3, stay: 4, note: 5 };

  // One mistyped year (an item dated 9999-12-31) spans nearly three million
  // days. Every per-day loop below would happily build that many cells, which
  // hangs the app on EVERY load and leaves no way to reach the bad item and fix
  // it. So the span-walking loops stop here. 400 days is well past any real
  // trip, and tripStats reports the cap so the views can say so out loud.
  const MAX_TRIP_DAYS = 400;

  // ---------- the one date range the app accepts ----------
  // A mistyped year ("9999") is the single most damaging typo the form takes:
  // it stretches the trip over millions of days. The 400-day render cap and the
  // computeIssues error both survive it, but the traveller should not have to
  // go read an issue to learn they hit an extra 9. These bounds are the ONE
  // source of truth: the date inputs' min/max attributes are stamped from them
  // at startup and the submit handler checks against them, because #itemForm
  // carries `novalidate`, which means the attributes alone only ever constrain
  // the native picker's spinner and never a typed value.
  // ISO dates compare correctly as strings, which is why no parsing happens.
  const DATE_MIN = '2000-01-01';
  const DATE_MAX = '2100-12-31';
  const isDateInRange = d => isIsoDate(d) && d >= DATE_MIN && d <= DATE_MAX;

  // ---------- dates (all UTC to dodge timezone drift) ----------
  // Date.parse rolls an impossible day FORWARD (2027-02-30 parses as Mar 2), so
  // the shape check alone accepts a date the traveller never meant and then
  // shows them a different one. Round-tripping the parse rejects it instead, so
  // the date is either kept exactly or refused out loud.
  const isIsoDate = s => {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const d = new Date(s + 'T00:00:00Z');
    return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  };
  const toUtc = s => new Date(s + 'T00:00:00Z');
  const diffDays = (a, b) => Math.round((toUtc(b) - toUtc(a)) / DAY);
  function addDays(s, n) {
    const d = new Date(toUtc(s).getTime() + n * DAY);
    return d.toISOString().slice(0, 10);
  }

  // The one deliberately LOCAL reader, and the app's only source of "today".
  // Every date the traveller types is a wall-clock date carrying no zone, so
  // which day it is has to be asked in the clock they are reading. A UTC slice
  // of the device clock is a different day for part of every day at any real
  // offset: it already said tomorrow from 17:00 in California and still said
  // yesterday until 03:00 in Israel, which moved the countdown, the past-row
  // dimming and the booking deadlines a day off for those hours. Everything
  // else above stays UTC because it is arithmetic on those zone-less strings.
  function localDateIso(d) {
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  // Moving a whole trip in time. Two callers now ask for it ("Shift entire
  // trip", and a template being given a new start date), so the arithmetic and
  // the refusal live here rather than in whichever dialog was written first.
  //
  // shiftFits is asked BEFORE anything moves: a shift big enough to push a date
  // past DATE_MAX would otherwise only surface afterwards, on a trip whose dates
  // are already wrecked. A date that is out of range ALREADY is left alone - it
  // arrived that way by import or share link, computeIssues names it, and
  // refusing to shift it would freeze the whole trip.
  function shiftFits(items, days) {
    const leaves = d => isDateInRange(d) && !isDateInRange(addDays(d, days));
    return !(Array.isArray(items) ? items : []).some(it => leaves(it.startDate) || leaves(it.endDate));
  }

  // Mutates in place (the caller owns the trip) and answers with how many items
  // actually moved, which is what the undo label counts. A blank or broken end
  // date stays exactly as it is.
  function applyDayShift(items, days) {
    let moved = 0;
    for (const it of (Array.isArray(items) ? items : [])) {
      if (isIsoDate(it.startDate)) { it.startDate = addDays(it.startDate, days); moved++; }
      if (isIsoDate(it.endDate)) it.endDate = addDays(it.endDate, days);
    }
    return moved;
  }

  // The day the plan begins: the earliest start date on it, ignoring status
  // (tripStats drops cancelled items, which is right for a budget and wrong for
  // "which date do I move from"). Null when nothing on the trip is dated.
  function firstItemDate(items) {
    let first = null;
    for (const it of (Array.isArray(items) ? items : [])) {
      if (it && isIsoDate(it.startDate) && (!first || it.startDate < first)) first = it.startDate;
    }
    return first;
  }

  // The same move expressed as a destination instead of a number of days: how
  // far the whole trip travels when its FIRST dated item is asked to land on
  // `toDate`. Every other date keeps its spacing, which is the entire point of
  // a template. Null when there is no date to measure from or to.
  function startDateShift(items, toDate) {
    const from = firstItemDate(items);
    if (!from || !isIsoDate(toDate)) return null;
    return { from, days: diffDays(from, toDate) };
  }

  // ---------- items ----------
  const isStay = it => it.type === 'stay';

  function nights(it) {
    if (!isStay(it) || !isIsoDate(it.startDate) || !isIsoDate(it.endDate)) return null;
    const n = diffDays(it.startDate, it.endDate);
    return n > 0 ? n : null;
  }

  // A night with no hotel is only forgivable when the traveller is MOVING
  // through it: a red-eye flight or a sleeper train is that night's bed. Type
  // `local` is getting around inside one city (a taxi to dinner, a metro hop,
  // the ride back to the hotel), so it can never be a bed and must never quiet
  // a "no stay covers this night" warning. Everything else with a multi-day
  // span keeps counting exactly as it did before `local` existed.
  const isTransitType = it => !!it && !isStay(it) && it.type !== 'local';

  function isTransitSpan(it) {
    return !!it && isTransitType(it) && it.status !== 'cancelled'
      && isIsoDate(it.startDate) && isIsoDate(it.endDate) && diffDays(it.startDate, it.endDate) > 0;
  }
  const overnightTransit = items => (items || []).filter(isTransitSpan);

  // The traveller's own answer to "which of these two comes first", used only
  // where the clock has none: it sits AFTER the date and the time in the key, so
  // no manual order can ever contradict a real time, and BEFORE the type, which
  // is the arbitrary tiebreak it exists to replace. An item with no `order`
  // reads as ORDER_MAX, so a trip nobody has reordered sorts byte-for-byte the
  // way it always did.
  const ORDER_MAX = 999;
  const orderPart = it => (Number.isInteger(it.order) && it.order >= 0 && it.order < ORDER_MAX
    ? String(it.order).padStart(3, '0')
    : String(ORDER_MAX));

  function sortKey(it) {
    const t = TYPE_ORDER[it.type] !== undefined ? TYPE_ORDER[it.type] : 9;
    return `${it.startDate || '9999-99-99'}|${it.startTime || '99:99'}|${orderPart(it)}|${t}|${it.createdAt || ''}`;
  }
  // 0 on an identical key, not 1. Every sort here used `sortKey(a) < sortKey(b)
  // ? -1 : 1`, which reports "b comes first" for two items that are equal. That
  // is a comparator the sort spec does not have to honour in any particular
  // way, so the resulting order was V8's stability by luck rather than by
  // contract. Identical keys are routine, not exotic: duplicateDay stamps every
  // copy of a day with the same createdAt millisecond, and the rest of the key
  // (date, time, type) is copied verbatim.
  function bySortKey(a, b) {
    const ka = sortKey(a), kb = sortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  }
  function sortedItems(trip) { return [...trip.items].sort(bySortKey); }

  // ---------- manual order inside a tie ----------
  // Two items TIE when nothing chronological separates them: the same date and
  // the same clock time, "no time at all" included. Those, and only those, may
  // be dragged past one another, which is what keeps a manual order from ever
  // claiming a 09:00 museum happens after a 14:00 train.
  //
  // Stays are out of every group. Their rows are drawn at ASSUMED check-in and
  // check-out positions rather than at a time anybody typed (see
  // ASSUMED_CHECKIN_TIME), and the same booking appears twice in a day, so
  // "above this row" would not name one place in the data to store.
  const tieKey = it => `${it.startDate}|${it.startTime || ''}`;
  const tieEligible = it => !!it && !isStay(it) && isIsoDate(it.startDate);

  // Every tie of two or more, keyed by date|time, each in the order it renders.
  function tieGroups(items) {
    const map = new Map();
    for (const it of (items || [])) {
      if (!tieEligible(it)) continue;
      const k = tieKey(it);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(it);
    }
    for (const [k, list] of map) {
      if (list.length < 2) map.delete(k);
      else list.sort(bySortKey);
    }
    return map;
  }

  // Which rows may carry a drag handle: a lone item has nothing to be ordered
  // against, so it gets none and the view renders exactly as it did before.
  function reorderableIds(items) {
    const out = new Set();
    for (const list of tieGroups(items).values()) for (const it of list) out.add(it.id);
    return out;
  }

  // The group one item belongs to, in render order; [] when it ties with nobody.
  function tieGroupOf(items, id) {
    for (const list of tieGroups(items).values()) {
      if (list.some(it => it.id === id)) return list;
    }
    return [];
  }

  // Writes 0..n-1 onto `ids` in the order given (what a drop or an arrow key
  // just decided) and then tidies every group, so the caller stores one edit
  // rather than one per row. Mutates in place, like applyDayShift; answers
  // whether anything actually changed, so a drop back where it started is not
  // filed as an undo step.
  function applyManualOrder(items, ids) {
    const byId = new Map((items || []).map(it => [it.id, it]));
    let changed = false;
    (Array.isArray(ids) ? ids : []).forEach((id, i) => {
      const it = byId.get(id);
      if (!it || !tieEligible(it) || it.order === i) return;
      it.order = i;
      changed = true;
    });
    return normalizeOrders(items) || changed;
  }

  // Housekeeping after an add, a delete or a date change: a group that has been
  // ordered is renumbered 0..n-1 so the numbers stay small and gap-free, a group
  // nobody has touched keeps no `order` key at all, and an item left with nobody
  // to tie with loses the field entirely rather than carrying a dead number into
  // an export or a share link.
  function normalizeOrders(items) {
    const list = items || [];
    let changed = false;
    const grouped = new Set();
    for (const g of tieGroups(list).values()) {
      const ordered = g.some(it => Number.isInteger(it.order));
      g.forEach((it, i) => {
        grouped.add(it.id);
        if (!ordered || it.order === i) return;
        it.order = i;
        changed = true;
      });
    }
    for (const it of list) {
      if (!grouped.has(it.id) && it.order !== undefined) { delete it.order; changed = true; }
    }
    return changed;
  }

  // The keyboard half of the drag: one step up or down inside the item's own
  // tie. False when there is nowhere to go (top of the group, bottom of it, or
  // an item that ties with nobody), which is also the answer that stops a
  // pointless save.
  function moveInTie(items, id, delta) {
    const group = tieGroupOf(items, id);
    const from = group.findIndex(it => it.id === id);
    if (from < 0) return false;
    const to = from + delta;
    if (to < 0 || to >= group.length) return false;
    const ids = group.map(it => it.id);
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    return applyManualOrder(items, ids);
  }

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
    // A NEGATIVE cost is legal: it is a refund or a credit (a cancelled hotel
    // that was refunded, a partial credit, a share of a bill somebody paid
    // back). Only a value that is not a finite number is an error, because that
    // is the one thing no total can be built from.
    if (it.cost != null && it.cost !== '' && !Number.isFinite(Number(it.cost))) errs.cost = true;
    // A booking deadline only means anything BEFORE the thing it books happens,
    // so a Book-by date after the item's own date is a typo, caught here the
    // same way check-out-before-check-in is. With no item date there is nothing
    // to bound it against, so nothing is claimed.
    if (isIsoDate(it.bookBy) && isIsoDate(it.startDate) && diffDays(it.bookBy, it.startDate) < 0) {
      errs.bookBy = 'Book by must be on or before the item date.';
    }
    return errs;
  }

  // ---------- night coverage ----------
  function coverageGaps(stays, tripEnd, travel = []) {
    if (!stays.length) return [];
    const first = stays.reduce((m, s) => s.startDate < m ? s.startDate : m, stays[0].startDate);
    let last = stays.reduce((m, s) => s.endDate > m ? s.endDate : m, stays[0].endDate);
    const horizon = addDays(first, MAX_TRIP_DAYS);
    // A trip end past the render horizon is a mistyped date, not a real end:
    // the far-future-date error already names that item. Stretching coverage to
    // it (even clamped to the horizon) would claim hundreds of uncovered nights
    // for a trip that is a few days long, so those nights are not reported at
    // all and only the gaps between real stays are.
    if (tripEnd && isIsoDate(tripEnd) && tripEnd > last && tripEnd <= horizon) last = tripEnd;
    if (last <= first) return [];
    if (last > horizon) last = horizon;
    const covered = new Set();
    for (const s of [...stays, ...travel]) {
      for (let d = s.startDate, n = 0; d < s.endDate && n < MAX_TRIP_DAYS; d = addDays(d, 1), n++) covered.add(d);
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

  // What the Add-item form opens on when a "no stay covers these nights"
  // warning offers to fill the hole itself: a stay spanning EXACTLY the range
  // coverageGaps reported, check-in on the first uncovered night and check-out
  // the morning after the last one. The dialog and the warning that opened it
  // therefore read the same range by construction rather than by agreement.
  function stayPrefillForGap(gap) {
    if (!gap || !isIsoDate(gap.start) || !isIsoDate(gap.end)) return null;
    const nightsCount = diffDays(gap.start, gap.end);
    if (nightsCount <= 0) return null;
    return { type: 'stay', startDate: gap.start, endDate: gap.end, nights: nightsCount };
  }

  // The first contiguous uncovered range, i.e. the one the topmost gap warning
  // is about. coverageGaps walks the calendar forwards, so [0] is the earliest.
  function firstStayPrefill(gaps) {
    return stayPrefillForGap((Array.isArray(gaps) ? gaps : [])[0]);
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
    // `local` is excluded for the same reason it is not transit: a taxi is
    // never somewhere you slept.
    const bookedNightSet = new Set();
    const bookedSpans = items.filter(it => it.status === 'booked' && (isStay(it) || isTransitType(it)) && isIsoDate(it.startDate) && isIsoDate(it.endDate) && diffDays(it.startDate, it.endDate) > 0);
    for (const it of bookedSpans) {
      for (let d = it.startDate, n = 0; d < it.endDate && n < MAX_TRIP_DAYS; d = addDays(d, 1), n++) bookedNightSet.add(d);
    }
    const bookedNights = bookedNightSet.size;
    const totalTripNights = start && end ? diffDays(start, end) : 0;
    // start/end stay honest so the issues list can name the far-out date; every
    // per-day view walks to renderEnd instead and says it was capped.
    let renderEnd = end, spanCapped = false;
    if (start && end && diffDays(start, end) + 1 > MAX_TRIP_DAYS) {
      renderEnd = addDays(start, MAX_TRIP_DAYS - 1);
      spanCapped = true;
    }
    return { start, end, renderEnd, spanCapped, confirmed, planned, bookedNights, totalTripNights, count: items.length };
  }

  // Every other collision check in this app looks INSIDE one trip, so the one
  // way to be in two places at once - two saved trips booked over the same
  // days - was the one the app could not see. This compares the active trip's
  // overall span against every other saved trip's, one entry per trip that
  // shares at least one calendar DAY.
  //
  // A shared day, not a shared night: trips are compared on their span, so a
  // trip ending the 10th and one starting the 11th are adjacent and fine,
  // while ending and starting on the same day is a real conflict (you cannot
  // fly home and check in somewhere else on the same date without noticing).
  // A trip with no dated item has no computable span, so it neither triggers
  // this nor gets named by it, in either direction.
  function overlappingTrips(trips, activeId) {
    const all = (Array.isArray(trips) ? trips : []).filter(t => t && Array.isArray(t.items));
    const active = all.find(t => t.id === activeId);
    if (!active) return [];
    const mine = tripStats(active);
    if (!mine.start || !mine.end) return [];
    const out = [];
    for (const t of all) {
      if (t.id === activeId) continue;
      const s = tripStats(t);
      if (!s.start || !s.end) continue;
      if (s.start > mine.end || s.end < mine.start) continue;
      out.push({ id: t.id, name: t.name || '', start: s.start, end: s.end });
    }
    return out;
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

  // ---------- route money and emissions: COMPUTED, never looked up ----------
  // Every figure the route modal shows is derived here from the distance and
  // the mode. Nothing is a remembered fare and nothing is a timetable, so no
  // number in this file can go stale and end up quoted as a price. They are
  // ranges on purpose: they exist to sanity-check a plan, not to book one.
  //
  // Bands are round numbers chosen to bracket ordinary economy travel in 2026
  // USD: fuel around 1.10-1.80 per litre at 7 L/100km, rail and coach per-km
  // bands in the shape of published operator fare tables, air as a fixed cost
  // plus a per-km band. Wide rather than precise.
  const round5 = n => Math.max(5, Math.round(n / 5) * 5);

  // `per` says WHAT the money buys: driving costs are per car (fuel plus
  // tolls, split however many people are in it), everything else per person.
  // Rendering must carry that distinction or a full car looks expensive.
  function modeCost(key, km, fastRail) {
    if (!(km > 0)) return null;
    const ground = km * 1.25;
    if (key === 'rail') {
      const f = fastRail ? 1.5 : 1;
      return { lo: round5((5 + ground * 0.09) * f), hi: round5((5 + ground * 0.15) * f), per: 'person' };
    }
    if (key === 'bus') return { lo: round5(3 + ground * 0.035), hi: round5(3 + ground * 0.075), per: 'person' };
    if (key === 'drive') {
      // tolls only start mattering once a leg leaves the metro area
      const tollLo = ground > 150 ? 0.02 : 0, tollHi = ground > 150 ? 0.06 : 0.01;
      return { lo: round5(ground * (0.077 + tollLo)), hi: round5(ground * (0.126 + tollHi)), per: 'car' };
    }
    if (key === 'air') return { lo: round5(35 + km * 0.045), hi: round5(60 + km * 0.13), per: 'person' };
    // A ferry on a long route is only the LAST leg, so the route distance says
    // nothing about its fare: priced only when the boat plausibly IS the trip.
    if (key === 'ferry') return km <= 120 ? { lo: round5(8 + km * 0.15), hi: round5(8 + km * 0.35), per: 'person' } : null;
    return null;
  }

  // Emission factors: UK DEFRA/BEIS greenhouse gas conversion factors for
  // company reporting, 2023 set (the usual public reference). Average petrol
  // car 0.170 per VEHICLE-km; national rail 0.035, coach 0.027 and
  // foot-passenger ferry 0.019 per passenger-km; short-haul flight 0.151 per
  // passenger-km. The flight adds a fixed 60 kg take-off and landing
  // allowance, which is what makes a few-hundred-km hop land near DEFRA's much
  // higher domestic-flight factor (0.246) while staying monotonic in distance.
  const CO2_PER_KM = { rail: 0.035, bus: 0.027, drive: 0.170, ferry: 0.019, air: 0.151 };
  function modeCo2(key, km) {
    if (!(km > 0)) return null;
    const ground = km * 1.25;
    let kg;
    if (key === 'air') kg = CO2_PER_KM.air * km + 60;
    else if (key === 'ferry') kg = km <= 120 ? CO2_PER_KM.ferry * km : null;
    else if (CO2_PER_KM[key]) kg = CO2_PER_KM[key] * ground;
    else return null;
    if (kg == null) return null;
    return { kg: kg >= 50 ? round5(kg) : Math.max(1, Math.round(kg)), per: key === 'drive' ? 'car' : 'person' };
  }

  // Rough door-to-door options by straight-line distance. Real routes are
  // longer than the crow flies, so pad ground modes by ~25%.
  // `cmpMin` is the number badges compare, not the number shown: a flight's
  // headline is air time, but choosing between a plane and a train is only
  // honest once the two to three hours of airport are back in.
  function modeOptions(km, island, fastRail) {
    const ground = km * 1.25;
    const rows = [];
    const add = (key, i, name, durMin, note, extra) => rows.push(Object.assign({
      key, i, name, durMin,
      dur: durMin == null ? 'varies' : `~${fmtDur(durMin)}`,
      cmpMin: durMin, note,
      cost: modeCost(key, km, fastRail), co2: modeCo2(key, km),
    }, extra));
    if (km < 8) add('walk', '🚶', 'Walk', ground * 12, 'or minutes in a taxi', { dur: fmtDur(ground * 12) });
    if (km >= 2 && km < 60) add('local', '🚕', 'Taxi / local transit', ground / 40 * 60, 'metro, city bus or rideshare');
    if (km >= 40 && km < 1200 && !island) {
      add('rail', '🚆', 'Train', ground / (fastRail ? 190 : 105) * 60,
        fastRail ? 'high-speed line (Shinkansen / TGV / ICE class), city centre to city centre' : 'where rail exists');
    }
    if (km >= 40 && km < 900) add('drive', '🚗', 'Drive', ground / 80 * 60, 'your own pace, and stops wherever you like');
    if (km >= 40 && km < 900) add('bus', '🚌', 'Bus', ground / 70 * 60, km >= 400 ? 'usually the cheapest option, and often overnight on a leg this long' : 'usually the cheapest option');
    if (km >= 250) {
      add('air', '✈️', 'Flight', km / 750 * 60 + 35, 'add 2 to 3 hours for airports and check-in',
        { dur: `~${fmtDur(km / 750 * 60 + 35)} in the air`, cmpMin: km / 750 * 60 + 35 + 150 });
    }
    if (island) {
      const hop = km <= 120 ? km / 35 * 60 : null;
      add('ferry', '⛴️', 'Ferry', hop, 'island legs end on a boat; combined bus and boat tickets are common');
    }
    return rows.slice(0, 5);
  }

  // ---------- badges: DERIVED from the numbers above, never hardcoded ----------
  // Only options with a computed cost compete: a walk or a metro ride has no
  // comparable fare, so it gets no badge rather than a made-up one. Ties go to
  // the first option in list order (ground before air), so each badge is
  // awarded exactly once and the result is stable.
  // Recommended = the best balance of time and money rather than either
  // extreme: time and cost midpoint are each normalised across the comparable
  // options and scored 60/40 in favour of time. The one exception is an island
  // route, where the ferry is recommended outright because the boat leg cannot
  // be skipped whatever else you do.
  // A card shows at most 2 badges, in this priority order.
  const BADGE_ORDER = ['recommended', 'fastest', 'cheapest', 'greenest'];
  const BADGE_LABELS = {
    recommended: { label: 'Recommended', title: 'Quickest option that does not cost much more than the cheapest' },
    fastest: { label: 'Fastest', title: 'Shortest estimated door-to-door time' },
    cheapest: { label: 'Cheapest', title: 'Lowest estimated cost range' },
    greenest: { label: 'Lowest emissions', title: 'Lowest estimated CO2 for this distance' },
  };
  const MAX_BADGES = 2;

  function routeBadges(options, ctx) {
    const out = {};
    const rank = [];
    const cand = (options || []).filter(o => o.cost);
    if (!cand.length) return out;
    const mid = o => (o.cost.lo + o.cost.hi) / 2;
    const best = (list, val) => list.reduce((b, o) => (b == null || val(o) < val(b) ? o : b), null);
    const timed = cand.filter(o => o.cmpMin != null);
    const green = cand.filter(o => o.co2);
    rank.push(['fastest', best(timed, o => o.cmpMin)]);
    rank.push(['cheapest', best(cand, mid)]);
    rank.push(['greenest', best(green, o => o.co2.kg)]);
    const norm = (v, lo, hi) => (hi > lo ? (v - lo) / (hi - lo) : 0);
    const span = vals => [Math.min(...vals), Math.max(...vals)];
    let recommended = null;
    if (timed.length) {
      const [tLo, tHi] = span(timed.map(o => o.cmpMin));
      const [cLo, cHi] = span(timed.map(mid));
      recommended = best(timed, o => 0.6 * norm(o.cmpMin, tLo, tHi) + 0.4 * norm(mid(o), cLo, cHi));
    }
    if (ctx && ctx.island) recommended = cand.find(o => o.key === 'ferry') || recommended;
    rank.push(['recommended', recommended]);
    for (const [id, opt] of rank) {
      if (!opt) continue;
      (out[opt.key] = out[opt.key] || []).push(id);
    }
    for (const key of Object.keys(out)) {
      out[key] = BADGE_ORDER.filter(id => out[key].includes(id)).slice(0, MAX_BADGES)
        .map(id => Object.assign({ id }, BADGE_LABELS[id]));
    }
    return out;
  }

  // ---------- curated corridor facts: STRUCTURAL only ----------
  // What service exists on a famous corridor, checked against the operators'
  // own sites on 2026-07-19 (JR Central, State Railway of Thailand, Eurostar,
  // SNCF, Deutsche Bahn, Renfe, Trenitalia, Amtrak, Korail).
  // HARD RULE: no fare, no currency and no clock time may ever enter this
  // table. All money is computed from distance, so a stale entry here can only
  // ever be structurally wrong; it can never quote a wrong price.
  const CORRIDORS = [
    {
      a: ['tokyo'], b: ['kyoto', 'osaka', 'nagoya'],
      tip: 'The Tokaido Shinkansen runs this corridor directly, so you can turn up and take the next train.',
      frequency: 'Departures every 10 to 15 minutes through the day',
      flags: ['high-speed', 'direct', 'unreserved'],
    },
    {
      a: ['seoul'], b: ['busan', 'daegu'],
      tip: 'KTX runs the length of this corridor on a dedicated high-speed line.',
      frequency: 'Departures every 10 to 30 minutes',
      flags: ['high-speed', 'direct'],
    },
    {
      a: ['bangkok'], b: ['phuket', 'krabi'],
      tip: 'There is no through train down here. Flying is usually both the fastest and the best value, and the bus is a long overnight haul.',
      flags: ['no-rail', 'overnight-bus'],
    },
    {
      a: ['bangkok'], b: ['chiang mai'],
      tip: 'Sleeper trains run this line overnight, which saves a hotel night.',
      frequency: 'A handful of departures a day',
      flags: ['direct', 'overnight-rail', 'reservation'],
    },
    {
      a: ['london'], b: ['paris', 'brussels', 'amsterdam', 'rotterdam', 'lille'],
      tip: 'Eurostar runs city centre to city centre under the Channel, but you clear border control before boarding, so allow extra time at the station.',
      frequency: 'Roughly hourly',
      flags: ['high-speed', 'direct', 'reservation-required', 'border'],
    },
    {
      a: ['paris'], b: ['lyon', 'marseille', 'bordeaux', 'avignon'],
      tip: 'TGV services run on dedicated high-speed line for most of the way.',
      frequency: 'Departures every 30 to 60 minutes at peak',
      flags: ['high-speed', 'direct', 'reservation-required'],
    },
    {
      a: ['berlin'], b: ['munich', 'münchen', 'hamburg', 'frankfurt', 'cologne', 'köln'],
      tip: 'ICE services link these cities directly on Deutsche Bahn.',
      frequency: 'Roughly hourly',
      flags: ['high-speed', 'direct', 'reservation'],
    },
    {
      a: ['madrid'], b: ['barcelona', 'seville', 'sevilla', 'valencia', 'malaga', 'málaga'],
      tip: 'AVE high-speed services run this corridor with every seat reserved.',
      frequency: 'Departures every 30 to 60 minutes at peak',
      flags: ['high-speed', 'direct', 'reservation-required'],
    },
    {
      a: ['rome', 'roma'], b: ['florence', 'firenze', 'milan', 'milano', 'naples', 'napoli'],
      tip: 'Two operators (Trenitalia and Italo) run high-speed trains on this line, which is worth comparing.',
      frequency: 'Departures every 15 to 30 minutes',
      flags: ['high-speed', 'direct', 'reservation-required'],
    },
    {
      a: ['new york'], b: ['washington', 'boston', 'philadelphia'],
      tip: 'Amtrak runs the Northeast Corridor city centre to city centre, which usually beats flying once airports are counted.',
      frequency: 'Roughly hourly',
      flags: ['direct', 'reservation-required'],
    },
  ];

  const FLAG_LABELS = {
    'high-speed': { i: '🚄', text: 'High-speed rail on this corridor' },
    'direct': { i: '➡️', text: 'Direct service, no transfer needed' },
    'unreserved': { i: '🎫', text: 'Unreserved cars run too, so a reservation is optional' },
    'reservation': { i: '🎟️', text: 'Booking ahead is recommended' },
    'reservation-required': { i: '🎟️', text: 'Every seat is reserved, so book ahead' },
    'overnight-rail': { i: '🌙', text: 'Overnight sleeper service available' },
    'overnight-bus': { i: '🌙', text: 'Overnight bus service available' },
    'no-rail': { i: '🚫', text: 'No through rail link' },
    'border': { i: '🛂', text: 'Border control on this journey' },
    'ferry': { i: '⛴️', text: 'A boat covers the last leg' },
    'airport': { i: '🛫', text: 'Flying means two airport transfers on top of the air time' },
  };

  const hasWord = (text, word) => new RegExp(`(^|[^\\p{L}])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\p{L}]|$)`, 'iu').test(text);
  const matchesAny = (text, list) => list.some(w => hasWord(text, w));

  // The corridor entry for a pair, either direction, or null. Unknown routes
  // are the normal case and produce nothing: no invented frequency, no guessed
  // transfer count.
  function corridorFacts(fromText, toText) {
    const f = String(fromText || ''), t = String(toText || '');
    if (!f || !t) return null;
    for (const c of CORRIDORS) {
      if ((matchesAny(f, c.a) && matchesAny(t, c.b)) || (matchesAny(t, c.a) && matchesAny(f, c.b))) return c;
    }
    return null;
  }

  // Structural flags shown under the cards: the curated ones for this corridor
  // plus the few a heuristic really can know (a boat is needed, a border is
  // crossed, a flight means airports). Anything else is absent.
  function routeFlags(ctx) {
    const { fromText, toText, island, international, km } = ctx;
    const ids = [];
    const c = corridorFacts(fromText, toText);
    if (c) ids.push(...c.flags);
    if (island) ids.push('ferry');
    if (international) ids.push('border');
    if (km >= 250) ids.push('airport');
    const seen = new Set();
    const out = [];
    for (const id of ids) {
      if (seen.has(id) || !FLAG_LABELS[id]) continue;
      seen.add(id);
      out.push(Object.assign({ id }, FLAG_LABELS[id]));
    }
    if (c && c.frequency) out.unshift({ id: 'frequency', i: '⏱️', text: c.frequency });
    return out;
  }

  // Route tips: the curated corridor line first, then the generic ones that
  // follow from geometry alone. A route we know nothing structural about
  // returns an empty list.
  function routeTips(ctx) {
    const { fromText, toText, island, km } = ctx;
    const tips = [];
    const c = corridorFacts(fromText, toText);
    if (c) tips.push({ id: 'corridor', text: c.tip });
    if (island) tips.push({ id: 'island', text: 'Boats stop running earlier than you expect, so check the last sailing before committing to a late arrival.' });
    if (km >= 400 && km < 900) tips.push({ id: 'long-drive', text: 'Driving this far buys flexibility and stops on the way, but budget for tolls as well as fuel.' });
    return tips;
  }

  // ---------- external links: DETERMINISTIC, no estimation ----------
  // A country code and a mode pick a fixed official site. Rome2Rio is always
  // last and is labelled as a discovery tool: it is good at showing WHICH
  // operators run a route, so it sits under the official sites, never instead
  // of them.
  const RAIL_SITES = {
    JP: { label: 'JR Central Smart EX', url: 'https://smart-ex.jp/en/' },
    FR: { label: 'SNCF Connect', url: 'https://www.sncf-connect.com/en-en/' },
    DE: { label: 'Deutsche Bahn', url: 'https://int.bahn.de/en' },
    GB: { label: 'National Rail', url: 'https://www.nationalrail.co.uk/' },
  };
  // Trainline sells tickets across these markets, so it is the fallback rail
  // link for a European route with no national operator entry above.
  const TRAINLINE_CC = new Set([
    'AT', 'BE', 'CH', 'CZ', 'DK', 'ES', 'FI', 'GB', 'IE', 'IT', 'LU', 'NL',
    'NO', 'PL', 'PT', 'SE', 'SK', 'FR', 'DE',
  ]);

  function routeLinks(ctx) {
    const { from, to, date, fromCc, toCc, island, km } = ctx || {};
    const f = String(from || '').trim(), t = String(to || '').trim();
    if (!f || !t) return [];
    const enc = encodeURIComponent;
    const links = [];
    const cc = String(fromCc || '').toUpperCase(), cc2 = String(toCc || '').toUpperCase();
    // rail links only where a train could actually run: a flight-only route
    // must not be handed a rail operator just because it lands in France
    const railable = !island && (km == null || (km >= 40 && km < 1200));
    const rail = railable ? (RAIL_SITES[cc] || RAIL_SITES[cc2]) : null;
    if (rail) links.push({ id: 'rail', mode: 'rail', i: '🚆', label: rail.label, url: rail.url, official: true });
    if (railable && !rail && (TRAINLINE_CC.has(cc) || TRAINLINE_CC.has(cc2))) {
      links.push({ id: 'trainline', mode: 'rail', i: '🚆', label: 'Trainline', url: 'https://www.thetrainline.com/' });
    }
    if (island) links.push({ id: 'ferry', mode: 'ferry', i: '⛴️', label: 'Direct Ferries', url: 'https://www.directferries.com/' });
    if (km == null || (km >= 40 && km < 900)) {
      links.push({ id: 'bus', mode: 'bus', i: '🚌', label: 'Busbud', url: 'https://www.busbud.com/en' });
    }
    if (km == null || km >= 250) {
      links.push({
        id: 'fly', mode: 'air', i: '✈️', label: 'Google Flights',
        url: `https://www.google.com/travel/flights?q=${enc(`Flights from ${f} to ${t}` + (date ? ` on ${date}` : ''))}`,
      });
    }
    links.push({ id: 'transit', mode: 'local', i: '🚇', label: 'Google transit', url: `https://www.google.com/maps/dir/?api=1&origin=${enc(f)}&destination=${enc(t)}&travelmode=transit` });
    links.push({ id: 'drive', mode: 'drive', i: '🚗', label: 'Google driving', url: `https://www.google.com/maps/dir/?api=1&origin=${enc(f)}&destination=${enc(t)}&travelmode=driving` });
    links.push({ id: 'r2r', mode: 'any', i: '🌐', label: 'Rome2Rio', url: `https://www.rome2rio.com/map/${enc(f)}/${enc(t)}`, discovery: true });
    return links;
  }

  // What a card's action button opens: the best link for that mode, falling
  // back to Rome2Rio, which covers every mode.
  const MODE_ACTION = {
    rail: 'View schedules', air: 'Find flights', drive: 'Open in Maps',
    bus: 'Find buses', ferry: 'Find ferries', local: 'Open in Maps', walk: 'Open in Maps',
  };
  function modeLink(key, links) {
    const byMode = (links || []).filter(l => l.mode === key);
    const pick = byMode.find(l => l.official) || byMode[0]
      || (key === 'walk' || key === 'local' ? (links || []).find(l => l.id === 'transit') : null)
      || (links || []).find(l => l.id === 'r2r');
    return pick ? { label: MODE_ACTION[key] || 'Open', url: pick.url, site: pick.label } : null;
  }

  // The one honest line under the cards. Every claim in the modal is either
  // computed from distance or a structural fact; this says so in plain words.
  const ROUTE_HONESTY = 'Times, prices and CO2 here are estimates worked out from the distance between your two places, '
    + 'not schedules or quotes. Use them to sanity-check a plan, then open a booking site for real times and fares. '
    + 'Driving figures are per car, the rest are per person.';

  // ---------- location match confidence ----------
  // Pure, no DOM and no network: decides how far to trust a geocoder answer
  // from the evidence the geocoder itself returned, so the UI only offers
  // correction guidance when the match is genuinely uncertain.
  // `candidates` are normalized rows in rank order:
  //   { name, cc, country, state, importance, kind }
  // Returns 'confident' | 'ambiguous' | 'low' | 'failed'.
  const GEO_SETTLEMENT_KINDS = new Set([
    'city', 'town', 'village', 'hamlet', 'municipality', 'borough', 'suburb',
    'city_district', 'district', 'quarter', 'neighbourhood', 'locality',
    'county', 'state', 'province', 'region', 'administrative', 'island',
    'archipelago', 'country', 'place', 'boundary',
  ]);
  // Two candidates within this much importance of each other are real rivals:
  // importance is a 0..1 popularity score, and a famous namesake outranks its
  // small twin by tenths (Paris FR 0.86 vs Paris TX 0.45), while genuine
  // look-alikes (the Springfields) sit within a few hundredths.
  const GEO_RIVAL_GAP = 0.05;
  // Below this the top hit is usually a hamlet or a stray POI rather than the
  // settlement someone would plan a trip around.
  const GEO_WEAK_IMPORTANCE = 0.25;

  const geoKind = r => String((r && r.kind) || '').toLowerCase();

  // Did the traveller disambiguate the place themselves? A comma ("Paris,
  // Texas") or a trailing country/region token ("London Ontario") means the
  // answer was already narrowed by hand, so we do not second-guess it.
  function geoInputIsQualified(input, top) {
    const raw = String(input || '').trim();
    if (!raw) return false;
    if (/,\s*\S/.test(raw)) return true;
    const words = raw.toLowerCase().split(/\s+/);
    const tails = [words.slice(-1).join(' '), words.slice(-2).join(' ')];
    const own = String((top && top.name) || '').trim().toLowerCase();
    // A region whose name IS the place name ("San Jose" province, "New York"
    // state) is not a hint the traveller added: it is the city repeating.
    const hints = [top && top.country, top && top.state, top && top.cc]
      .map(v => String(v || '').trim().toLowerCase())
      .filter(v => v && v !== own);
    return tails.some(t => t && hints.includes(t));
  }

  function classifyGeoMatch(input, candidates) {
    const rows = (Array.isArray(candidates) ? candidates : []).filter(Boolean);
    if (!rows.length) return 'failed';
    const top = rows[0];
    if (!GEO_SETTLEMENT_KINDS.has(geoKind(top))) return 'low';
    if (geoInputIsQualified(input, top)) return 'confident';
    const topImp = Number(top.importance);
    const rivals = rows.slice(1).filter(r => {
      if (!GEO_SETTLEMENT_KINDS.has(geoKind(r))) return false;
      const imp = Number(r.importance);
      const close = !Number.isFinite(topImp) || !Number.isFinite(imp)
        || (topImp - imp) < GEO_RIVAL_GAP;
      const elsewhere = String(r.cc || '') !== String(top.cc || '')
        || String(r.state || '').toLowerCase() !== String(top.state || '').toLowerCase();
      return close && elsewhere;
    });
    if (rivals.length) return 'ambiguous';
    if (Number.isFinite(topImp) && topImp < GEO_WEAK_IMPORTANCE) return 'low';
    return 'confident';
  }

  // Worst level across the places on screen wins. An unknown level (a place
  // resolved before confidence was recorded) means we have no evidence at all,
  // so the whole line stays silent rather than warning without cause.
  const GEO_MATCH_RANK = { confident: 0, ambiguous: 1, low: 2, failed: 3 };
  const GEO_MATCH_TEXT = {
    confident: 'Matched to your locations',
    ambiguous: 'Not the places you meant? Add a country or region.',
    low: 'Please check these locations. Add a country or region for a more precise match.',
    failed: 'We could not find this location. Try adding a country or region.',
  };
  function geoMatchNote(levels) {
    const list = (Array.isArray(levels) ? levels : [levels]);
    if (!list.length || list.some(l => !(l in GEO_MATCH_RANK))) return '';
    const worst = list.reduce((a, b) => (GEO_MATCH_RANK[b] > GEO_MATCH_RANK[a] ? b : a));
    return GEO_MATCH_TEXT[worst] || '';
  }

  // ---------- place picker: city suggestions (Open-Meteo geocoding) ----------
  // Pure shaping and ranking for the city combobox. The fetch itself lives in
  // app.js; everything that decides WHICH rows a traveller sees, and in what
  // order, is here so the node suite can pin it.
  //
  // WHY NOT NOMINATIM, which the app already talks to: its usage policy
  // forbids autocomplete against the public instance outright. Open-Meteo's
  // geocoding endpoint is keyless, CORS-open, built for typeahead, and is
  // already the provider behind the climate strip, so it adds no new
  // dependency and no new attribution.

  // GeoNames feature codes. PPL* is "populated place", ADM* an administrative
  // division (a region someone can legitimately base a trip in). Everything
  // else the endpoint returns - heliports (AIRH), parks (PRK), stations - is
  // not a place you sleep, and a search for "Kyoto" surfaces three of them.
  const PLACE_FEATURE_RE = /^(PPL|ADM)/;

  // Diacritic-blind compare so "Koln" finds "Köln" and "Malaga" finds "Málaga".
  function foldPlace(s) {
    return String(s == null ? '' : s)
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase().trim();
  }

  // Number(null) and Number('') are both 0, which is a REAL coordinate in the
  // Gulf of Guinea: a row with a missing latitude would otherwise pass every
  // finite check, seed the geocode cache from it and drop a map pin in the
  // ocean. Anything absent has to become NaN before it is tested.
  const numOrNaN = v => (v == null || v === '' ? NaN : Number(v));

  // Open-Meteo row -> the shape the picker renders and stores.
  // `label` is the disambiguated one-liner ("Paris, Texas, United States");
  // `value` is what lands in the field, and is deliberately the BARE name:
  // it is also the day-card chip and the weather-lookup key, and "Staying in
  // Paris, Texas, United States" reads badly on a card. The country the
  // traveller actually picked is preserved by seeding the geocode cache (see
  // rememberPickedPlace in app.js), not by bloating the stored string.
  function normalizePlaceRow(r) {
    if (!r || !r.name) return null;
    const region = String(r.admin1 || '').trim();
    const country = String(r.country || '').trim();
    const parts = [String(r.name).trim(), region, country].filter(Boolean);
    // "Tokyo, Tokyo, Japan" is noise: drop a region that just repeats the name.
    const deduped = parts.filter((p, i) => i === 0 || foldPlace(p) !== foldPlace(parts[0]));
    return {
      value: String(r.name).trim(),
      label: deduped.join(', '),
      detail: deduped.slice(1).join(', '),
      cc: String(r.country_code || '').toUpperCase(),
      country,
      region,
      lat: numOrNaN(r.latitude),
      lon: numOrNaN(r.longitude),
      population: Number(r.population) || 0,
      feature: String(r.feature_code || ''),
      id: r.id,
    };
  }

  // In a TYPEAHEAD an exact match is weak evidence: the query is a half-typed
  // word, so "tok" matches the village of Tok, Alaska (pop 1,258) exactly and
  // Tokyo (pop 9.7M) only as a prefix. An earlier draft scored exactness far
  // above size and duly buried Tokyo below four hamlets. So POPULATION is the
  // dominant term here, and exactness is a strong tiebreak rather than a veto.
  // The log keeps it proportionate: a 20M city leads a 200k one by ~90 points,
  // not by 20 million.
  // The prefix bonus is deliberately modest for the same reason. The endpoint
  // resolves alternate and native names, and it hands back only the ENGLISH
  // one: "koln" comes back as "Cologne", which does not start with "koln" at
  // all. A prefix bonus big enough to be decisive therefore ranked Kolno,
  // Poland (pop 10k) above Cologne (pop 963k) on the traveller's behalf. Two
  // cities in a hundred hinge on these constants; they are tuned so that the
  // bigger place wins unless the smaller one is a materially better match.
  const PLACE_POP_WEIGHT = 50;
  const PLACE_PREFIX_BONUS = 80;
  const PLACE_EXACT_BONUS = 60;
  function placeScore(query, row) {
    const q = foldPlace(query);
    const name = foldPlace(row.value);
    let score = Math.log10(Math.max(0, row.population) + 1) * PLACE_POP_WEIGHT;
    if (name.startsWith(q)) score += PLACE_PREFIX_BONUS;
    if (name === q) score += PLACE_EXACT_BONUS;
    if (row.feature === 'PPLC') score += 50;           // national capital
    if (row.feature.startsWith('PPL')) score += 30;    // a settlement, not a region
    return score;
  }

  /**
   * Ranked, de-duplicated city suggestions from a raw Open-Meteo payload.
   * Returns [] for anything unusable (the endpoint omits `results` entirely
   * when nothing matches, and for one-character queries).
   */
  function rankPlaceResults(query, payload, limit) {
    const raw = (payload && Array.isArray(payload.results)) ? payload.results : [];
    const seen = new Set();
    const rows = [];
    for (const r of raw) {
      const row = normalizePlaceRow(r);
      if (!row || !PLACE_FEATURE_RE.test(row.feature)) continue;
      if (!Number.isFinite(row.lat) || !Number.isFinite(row.lon)) continue;
      // The same place often arrives twice, once as a settlement and once as
      // the admin division of the same name. Keep whichever scored higher.
      const key = `${foldPlace(row.value)}|${row.cc}|${foldPlace(row.region)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(row);
    }
    return rows
      .map(row => ({ row, score: placeScore(query, row) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit || 8)
      .map(x => x.row);
  }

  // ---------- stay picker: hotel suggestions (Photon, OpenStreetMap) ----------
  // WHY THIS IS NOT A BUNDLED TABLE like the airports below: airports are a
  // closed set of ~3.3k rows that fits in 260 KB and changes a few times a
  // year. OSM carries over a million lodging POIs and they change daily, so
  // hotels have to be a live lookup however much we would prefer the offline
  // story the airport table gets. The UI is shared (createCombobox); only the
  // data strategy differs.
  //
  // WHY PHOTON and not either geocoder already wired up: Nominatim forbids
  // autocomplete against its public instance (see geocode() in app.js, which
  // uses it only for one-shot lookups), and Open-Meteo's geocoder resolves
  // settlements and admin areas, never POIs. Photon is the same OSM data,
  // keyless, CORS-open and explicitly built for type-ahead.

  // The tags asked for on the wire AND the word shown on the row, in ONE list
  // so the query and the label can never drift apart. app.js builds the
  // osm_tag parameters from these keys.
  const HOTEL_TAGS = new Map([
    ['hotel', 'Hotel'],
    ['hostel', 'Hostel'],
    ['guest_house', 'Guest house'],
    ['motel', 'Motel'],
    ['apartment', 'Apartment'],
  ]);

  // Photon hands back its own relevance order, and it is good: the list is
  // already sorted before we see it. So position is the BASE score and every
  // term below is a nudge measured in positions, not a replacement ranking.
  // With 8 rows the position spread is 175 points, which is what calibrates
  // the rest: the city bonus can lift a row ~5 places, a prefix hit ~2, being
  // a hotel rather than an apartment ~1.
  const HOTEL_POSITION_WEIGHT = 25;
  // The city already in the Place field is the strongest signal there is.
  // "Novotel" typed with "Bangkok" in the form means the Bangkok one, and
  // Photon's own lat/lon bias does not always get there (it answers
  // Christchurch for that exact pair). This is what fixes it.
  const HOTEL_CITY_BONUS = 120;
  const HOTEL_PREFIX_BONUS = 60;
  const HOTEL_EXACT_BONUS = 40;
  // A traveller adding a "stay" means a hotel far more often than any of the
  // other four, and OSM tags a 6-bed guest house and a 400-room chain hotel
  // with equal confidence.
  const HOTEL_KIND_BONUS = new Map([
    ['hotel', 40], ['motel', 25], ['guest_house', 20], ['hostel', 15], ['apartment', 10],
  ]);

  /**
   * One Photon GeoJSON feature -> the shape the picker renders and stores.
   * `value` is the BARE hotel name for the same reason normalizePlaceRow uses
   * the bare city name: it becomes the item title on every card, and "Hotel
   * Granvia Kyoto, Kyoto, Japan" reads badly there. The city and country
   * survive on the row, which is what seeds the geocode cache on pick.
   */
  function normalizeHotelRow(f) {
    const p = (f && f.properties) || null;
    const coords = (f && f.geometry && Array.isArray(f.geometry.coordinates)) ? f.geometry.coordinates : [];
    if (!p || !p.name) return null;
    // Defensive: the osm_tag filter is a request, not a guarantee, and a row
    // that is not lodging must never reach a field labelled "Hotel / stay name".
    if (p.osm_key !== 'tourism' || !HOTEL_TAGS.has(p.osm_value)) return null;
    // Same trap as normalizePlaceRow: Number('') is 0, a real coordinate in
    // the Gulf of Guinea, so a missing coordinate has to become NaN.
    const lon = numOrNaN(coords[0]);
    const lat = numOrNaN(coords[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const name = String(p.name).trim();
    const locality = String(p.city || p.district || p.state || '').trim();
    const country = String(p.country || '').trim();
    const parts = [name, locality, country].filter(Boolean);
    // "Kyoto Hotel, Kyoto, Japan" is fine; "Kyoto, Kyoto, Japan" is noise.
    const deduped = parts.filter((x, i) => i === 0 || foldPlace(x) !== foldPlace(parts[0]));
    return {
      value: name,
      label: deduped.join(', '),
      detail: deduped.slice(1).join(', '),
      kind: p.osm_value,
      kindLabel: HOTEL_TAGS.get(p.osm_value) || '',
      locality,
      country,
      cc: String(p.countrycode || '').toUpperCase(),
      lat,
      lon,
    };
  }

  function hotelScore(query, row, cityHint, position) {
    const q = foldPlace(query);
    const name = foldPlace(row.value);
    let score = Math.max(0, HOTEL_POSITION_WEIGHT * (8 - (position || 0)));
    if (name.startsWith(q)) score += HOTEL_PREFIX_BONUS;
    if (name === q) score += HOTEL_EXACT_BONUS;
    score += HOTEL_KIND_BONUS.get(row.kind) || 0;
    const city = foldPlace(cityHint);
    // `includes` both ways on purpose: the Place field may hold "Kyoto" while
    // OSM files the hotel under "Shimogyo Ward", and it may hold "New York"
    // while OSM says "New York City".
    if (city && row.locality) {
      const loc = foldPlace(row.locality);
      if (loc === city || loc.includes(city) || city.includes(loc)) score += HOTEL_CITY_BONUS;
    }
    return score;
  }

  /**
   * Ranked, de-duplicated lodging suggestions from a raw Photon payload.
   * `cityHint` is whatever is in the Place field, and may be empty.
   * Returns [] for anything unusable: Photon answers with an empty feature
   * list rather than an error when nothing matches.
   */
  function rankHotelResults(query, payload, cityHint, limit) {
    const raw = (payload && Array.isArray(payload.features)) ? payload.features : [];
    const seen = new Set();
    const rows = [];
    raw.forEach((f, i) => {
      const row = normalizeHotelRow(f);
      if (!row) return;
      // OSM routinely holds the same hotel twice, once as the building way and
      // once as an entrance node, and Photon returns both: "Novotel, Paris,
      // France" listed twice is the single ugliest thing in the raw response.
      const key = `${foldPlace(row.value)}|${foldPlace(row.locality)}|${row.cc}`;
      if (seen.has(key)) return;
      seen.add(key);
      rows.push({ row, score: hotelScore(query, row, cityHint, i) });
    });
    // Array#sort is stable, so rows that tie keep Photon's order.
    return rows
      .sort((a, b) => b.score - a.score)
      .slice(0, limit || 8)
      .map(x => x.row);
  }

  // ---------- place picker: airport suggestions (bundled OurAirports) ----------
  // The data ships with the app (see scripts/build-airports.mjs for why), so
  // this is a local scan over ~3.3k rows: no debounce, no network, works
  // offline. A linear pass costs well under a millisecond, which is why there
  // is no prefix index to keep in sync.

  // ---------- primary hubs ----------
  // Thirty metros in the bundled data have two or more LARGE airports filed
  // under the same city name. Nothing in OurAirports separates them: there is
  // no passenger count, no hub flag, and both rows score identically, so the
  // order fell to the alphabet and "london" answered Gatwick before Heathrow.
  //
  // Each entry maps the code to THE METRO IT SERVES, and that second half is
  // load-bearing, not documentation. The main airport of a metro is very often
  // not filed under the metro at all: Otopeni, Dulles, Ferno and Zaventem are
  // municipalities. So "bucharest" only matched Otopeni's NAME, two tiers
  // below little Baneasa, which sits inside the city limits and matched on
  // CITY. Naming the metro here lets airportScore treat "is this the metro
  // they typed" as a city-level match (see the promotion there).
  //
  // An earlier draft promoted ANY name-prefix match instead, which needed no
  // metro names but was far too blunt: airport names begin with people, so
  // "queen" put Amman (Queen Alia) above Queenstown and "ch" put Paris
  // (Charles de Gaulle) above Chicago. Spelling the metro out is the whole
  // difference between those two behaviours.
  //
  // Scope is exactly the metros that actually tie, not a general "important
  // airport" list, so it stays small enough to re-derive and check by hand.
  // It was built by running every city name and every leading name-word in
  // the data through searchAirports and collecting the cases where the top
  // two scored identically and both were large. That catches Milan, whose two
  // airports are filed under Segrate and Ferno and tie on the NAME rather
  // than the city, which a city-only sweep misses.
  //
  // Entries are listed even where the alphabet already lands on the right one
  // (CDG, JFK, BRU): the point is to state the answer rather than depend on a
  // lucky sort. Two kinds of tie are deliberately NOT here:
  //   - no settled primary:  Chengdu CTU/TFU, where Tianfu is still taking
  //     over the international traffic
  //   - namesakes in different countries: Portland OR/ME, Barcelona ES/VE,
  //     Santiago CL/CU, Victoria SC/CA. Those ask "which CITY did you mean",
  //     which is a question the row's own country line answers on screen, and
  //     picking a winner here would just be guessing at the traveller.
  //   - Washington DCA/IAD: OWNER DECISION, do not "fix" this by adding IAD.
  //     Dulles is the intercontinental gateway, but Reagan National is inside
  //     the city, carries comparable domestic traffic, and is what its city
  //     field says it is. So "washington" answers DCA on the plain city match
  //     and Dulles lists second, which is where an unpromoted NAME_PREFIX hit
  //     puts it.
  const PRIMARY_HUBS = new Map([
    ['AMM', 'Amman'],          // Queen Alia, over Marka (ADJ)
    ['BKK', 'Bangkok'],        // Suvarnabhumi, over Don Mueang (DMK)
    ['PEK', 'Beijing'],        // Capital, over Daxing (PKX)
    ['BRU', 'Brussels'],       // Zaventem, over Charleroi (CRL) 50 km south
    ['OTP', 'Bucharest'],      // Otopeni, over Baneasa (BBU), now business aviation
    ['EZE', 'Buenos Aires'],   // Ezeiza, over the domestic Aeroparque (AEP)
    ['ORD', 'Chicago'],        // O'Hare, over Midway (MDW)
    ['CMB', 'Colombo'],        // Bandaranaike, over Ratmalana (RML)
    ['DSS', 'Dakar'],          // Blaise Diagne, over the retired Senghor (DKR)
    ['DFW', 'Dallas'],         // over the close-in Love Field (DAL)
    ['DOH', 'Doha'],           // Hamad, over the old Doha International (DIA)
    ['DXB', 'Dubai'],          // over Al Maktoum (DWC)
    ['DUS', 'Dusseldorf'],     // over Weeze (NRN), which is 70 km away
    ['FRA', 'Frankfurt'],      // over Hahn (HHN), which is 120 km away
    ['IAH', 'Houston'],        // Bush, over Hobby (HOU)
    ['IST', 'Istanbul'],       // over Sabiha Gokcen (SAW)
    ['CGK', 'Jakarta'],        // Soekarno-Hatta, over Halim (HLP)
    ['JNB', 'Johannesburg'],   // OR Tambo, over Lanseria (HLA)
    ['LHR', 'London'],         // Heathrow, over Gatwick (LGW)
    ['LAD', 'Luanda'],         // Quatro de Fevereiro, over the new Agostinho Neto (NBJ)
    ['MAN', 'Manchester'],     // Manchester UK, over Manchester, New Hampshire (MHT),
                               //   a regional field whose city string is the exact
                               //   word and was winning the match on it
    ['MEX', 'Mexico City'],    // Benito Juarez, over Felipe Angeles (NLU)
    ['MXP', 'Milan'],          // Malpensa, over the short-haul Linate (LIN)
    ['SVO', 'Moscow'],         // Sheremetyevo, over DME / VKO / ZIA
    ['JFK', 'New York'],       // over LaGuardia (LGA)
    ['MCO', 'Orlando'],        // over Sanford (SFB)
    ['KIX', 'Osaka'],          // Kansai, over the domestic Itami (ITM)
    ['CDG', 'Paris'],          // over Orly (ORY) and Le Bourget (LBG)
    ['GIG', 'Rio de Janeiro'], // Galeao, over the domestic Santos Dumont (SDU)
    ['FCO', 'Rome'],           // Fiumicino, over Ciampino (CIA)
    ['GRU', 'Sao Paulo'],      // Guarulhos, over Congonhas (CGH)
    ['ICN', 'Seoul'],          // Incheon, over Gimpo (GMP)
    ['PVG', 'Shanghai'],       // Pudong, over Hongqiao (SHA)
    ['IKA', 'Tehran'],         // Imam Khomeini, over the domestic Mehrabad (THR)
    ['TFS', 'Tenerife'],       // South, which is where the flights land, over North (TFN)
  ]);

  // Below this a query is not naming a place, it is two letters on the way to
  // one, and "lo" should not declare London on the traveller's behalf.
  const AP_METRO_MIN = 3;

  /** Expands the compact {fields, rows, countries} payload into row objects. */
  function airportIndex(payload) {
    const rows = (payload && Array.isArray(payload.rows)) ? payload.rows : [];
    const countries = (payload && payload.countries) || {};
    return rows.map(r => ({
      iata: String(r[0] || ''),
      name: String(r[1] || ''),
      city: String(r[2] || ''),
      cc: String(r[3] || ''),
      lat: Number(r[4]),
      lon: Number(r[5]),
      big: r[6] === 1,
      alt: String(r[7] || ''),
      country: countries[r[3]] || String(r[3] || ''),
    }));
  }

  /**
   * How a row reads in the dropdown and, once picked, in a flight title.
   * `city` is the municipality and is empty on a handful of rows, so the
   * airport name is the fallback.
   */
  function airportLabel(a) {
    if (!a) return '';
    return `${a.city || a.name} (${a.iata})`;
  }
  function airportDetail(a) {
    if (!a) return '';
    // The bundled names have a trailing "Airport" stripped to save bytes
    // across 3.3k rows; it goes back on for reading.
    const name = /airport$/i.test(a.name) ? a.name : `${a.name} Airport`;
    return [name, a.country].filter(Boolean).join(' · ');
  }

  // Match quality, best first. Named because the hub rule below has to talk
  // about which tier a row landed in.
  const AP_TIER = {
    IATA: 2000,        // the typed query IS the code
    CITY_EXACT: 900,
    CITY_PREFIX: 600,
    NAME_PREFIX: 450,
    ALIAS_WORD: 400,   // a word of the alias text starts with the query
    CITY_PART: 250,
    NAME_PART: 150,
    ALIAS_PART: 100,
  };
  const AP_BIG_BONUS = 50;

  function airportScore(q, a) {
    const iata = a.iata.toLowerCase();
    const city = foldPlace(a.city);
    const name = foldPlace(a.name);
    const alt = foldPlace(a.alt);
    let tier;
    // A typed three-letter code is almost never a coincidence, so an exact
    // IATA hit outranks every name match: "LAX" must not surface Laxou first.
    if (iata === q) tier = AP_TIER.IATA;
    else if (city === q) tier = AP_TIER.CITY_EXACT;
    else if (city.startsWith(q)) tier = AP_TIER.CITY_PREFIX;
    else if (name.startsWith(q)) tier = AP_TIER.NAME_PREFIX;
    // Word-anchored on the aliases, so "new york" reaches EWR through its
    // "New York City" keyword without "york" also dragging in every row whose
    // alias merely contains those letters.
    else if (new RegExp(`\\b${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(alt)) tier = AP_TIER.ALIAS_WORD;
    else if (city.includes(q)) tier = AP_TIER.CITY_PART;
    else if (name.includes(q)) tier = AP_TIER.NAME_PART;
    else if (alt.includes(q)) tier = AP_TIER.ALIAS_PART;
    else return -1;

    // THE METRO PROMOTION. A hub whose data files it under a suburb (Otopeni,
    // Dulles, Ferno) only ever matched the metro name through its airport
    // NAME, two tiers below the small second airport that sits inside the city
    // limits and matches on CITY. That gap is what put Baneasa above Otopeni,
    // Love Field above DFW, and Manchester, New Hampshire above Manchester,
    // England. So when the query names the metro this airport is the gateway
    // for, that counts as a city match.
    //
    // It raises the tier and never lowers it, and it stops AT the city tier
    // rather than above it, so the hub ends up level with the metro's other
    // airport and hubRank settles the order. A hub can still never overtake a
    // row that matched better - an exact IATA hit stays on top.
    const metro = PRIMARY_HUBS.get(a.iata);
    if (metro && q.length >= AP_METRO_MIN && tier < AP_TIER.CITY_EXACT && foldPlace(metro).startsWith(q)) {
      tier = AP_TIER.CITY_EXACT;
    }
    return tier + (a.big ? AP_BIG_BONUS : 0);
  }

  const hubRank = a => (PRIMARY_HUBS.has(a.iata) ? 1 : 0);

  /**
   * Ranked airport matches for a typed query. `rows` comes from airportIndex.
   * Order is: how well it matched, then the curated hub tiebreak, then the
   * alphabet so the result is stable and never depends on file order.
   */
  function searchAirports(query, rows, limit) {
    const q = foldPlace(query);
    if (q.length < 2) return [];
    const out = [];
    for (const a of (rows || [])) {
      const score = airportScore(q, a);
      if (score >= 0) out.push({ a, score });
    }
    return out
      .sort((x, y) => y.score - x.score
        || hubRank(y.a) - hubRank(x.a)
        || x.a.iata.localeCompare(y.a.iata))
      .slice(0, limit || 8)
      .map(x => x.a);
  }

  /**
   * Composes the flight title in the SAME shape the rest of the app already
   * reads: dayMorningCity runs parseTravelOrigin over "A to B" and strips the
   * parenthetical with stripPlaceCode, so "Tokyo (HND) to Seoul (ICN)" yields
   * the departure city "Tokyo" for the day chip and the weather lookup.
   * Writing the title any other way would silently cost that.
   */
  function flightTitleFromAirports(from, to) {
    const a = airportLabel(from);
    const b = airportLabel(to);
    if (!a || !b) return '';
    return `${a} to ${b}`;
  }

  /**
   * Reads the two IATA codes back out of an existing flight title so editing
   * an item re-fills the pickers instead of showing them blank. Returns
   * { from, to } airport rows, either of which may be null. Only codes that
   * are actually in the bundled table count, so "Dinner (7pm) to follow"
   * parses to nothing.
   */
  function parseFlightAirports(title, rows) {
    const codes = String(title || '').match(/\(([A-Za-z]{3})\)/g) || [];
    const byIata = new Map((rows || []).map(a => [a.iata, a]));
    const hits = codes.map(c => byIata.get(c.slice(1, 4).toUpperCase())).filter(Boolean);
    return { from: hits[0] || null, to: hits[1] || null };
  }

  // A geocode is only allowed to NAME A COUNTRY in the visa dialog when it is
  // 'confident'. This is deliberately stricter than the route modal, which
  // shows the same levels as an advisory note and still draws the route: a
  // wrong route costs a detour, a wrong visa row states a false LEGAL ENTRY
  // REQUIREMENT for a country the traveller never mentioned, in a confident
  // dedicated dialog. They then either buy an authorization they do not need
  // or, in the mirror-image failure, are told they need nothing when they do.
  //
  // Measured against all 62 places in the twelve sample trips, Nominatim's top
  // hit is in the WRONG COUNTRY for four of them:
  //   Nara    -> United States  (classified 'low',       rival Nara JP)
  //   Maras   -> Turkmenistan   (classified 'ambiguous', rival Maras PE)
  //   Ha Long -> Lesotho        (classified 'ambiguous', rival Ha Long VN)
  //   Lang Co -> China          (classified 'confident': ONE candidate came
  //                              back and nothing about it looks suspicious)
  // This gate catches the first three. The fourth cannot be caught by any
  // amount of confidence scoring, which is why each row also prints the places
  // it was derived from: a "China / Lang Co" row is at least traceable to the
  // stop that produced it. The Vietnam SAMPLE was additionally corrected to
  // "Lang Co, Vietnam" rather than left demonstrating the bug: a comma is the
  // remedy this dialog tells travellers to use, so our own data should use it.
  // (That qualified form comes back as Vietnam but at 0.00 importance, so it
  // lands in the "country not confirmed" row rather than naming Vietnam. That
  // is the right outcome: Vietnam is already listed from Hanoi / Da Nang / Hoi
  // An, and what mattered was that CHINA stopped being listed at all.)
  //
  // Suppressing a level rarely costs a row, because a country normally has more
  // than one stop and at least one of them is a major city: on the same twelve
  // trips every legitimate country stays listed via a confident sibling
  // (Japan via Tokyo/Kyoto/Osaka, Peru via Lima/Cusco, Vietnam via Hanoi/Da
  // Nang, Israel via Tel Aviv/Jerusalem). Silence is the correct trade here.
  const visaCountryUsable = conf => conf === 'confident';

  // Which suppressed stops are still WORTH SAYING OUT LOUD. Every stop rejected
  // by visaCountryUsable used to print a "Country not confirmed" row asking the
  // traveller to go add a country. On the Israel sample that row said "Masada",
  // whose best guess is IL, on a screen already listing Israel from Tel Aviv,
  // Ramat Gan, Jerusalem and Beer Sheva. Doing as it asked would have changed
  // NOTHING on screen: the visa rows are identical either way, so the warning
  // was work with no outcome, printed in a dialog about legal entry rules where
  // an unexplained question mark reads as a problem with the trip.
  //
  // This is NOT a loosening of visaCountryUsable, and deliberately so. The
  // guessed country still may not CREATE a row, and the place name is still not
  // attached to anybody's `places` list, so a wrong guess remains incapable of
  // stating a false requirement or of mislabelling a true one. The only thing
  // it may now do is stay quiet, and only when the country it guessed is
  // already listed on the strength of a CONFIDENT stop somewhere else. Nara ->
  // United States on a Japan trip still warns, because the US is not otherwise
  // on the trip; so do Maras -> Turkmenistan and Ha Long -> Lesotho. That is
  // the whole point: suppression tracks "this row would tell you nothing new",
  // never "this guess is probably fine".
  //
  // Takes the countries derived from the confident stops, so the caller must
  // finish that pass BEFORE resolving these. Stop order is not evidence: Masada
  // is day 9, but a national park could as easily be day 1, ahead of the city
  // that vindicates it.
  function visaUnconfirmedNames(deferred, confirmedCcs) {
    const listed = new Set([...(confirmedCcs || [])].map(cc => String(cc || '').toUpperCase()));
    return (Array.isArray(deferred) ? deferred : [])
      .filter(d => d && !listed.has(String(d.cc || '').toUpperCase()))
      .map(d => d.name);
  }

  // The VINTAGE of the visa data, said out loud. The old wording claimed the
  // dataset was "refreshed monthly", which actually described our browser cache
  // TTL, not the data: the source we pinned had not moved since January 2025,
  // so travellers were reading 18-month-old entry rules as current. A legal
  // requirement has to carry the date it was true, and how stale that is, so
  // the reader can judge it rather than trust it.
  function visaVintageNote(vintage, today) {
    if (!isIsoDate(vintage)) return '';
    const when = new Date(vintage + 'T00:00:00Z').toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
    if (!isIsoDate(today)) return `Rules as published on ${when}.`;
    // CALENDAR months, not days/30.4375: that divisor floors a full year to
    // "11 months ago", which understates staleness on the one screen where
    // overstating freshness is the whole risk.
    const [y1, m1, d1] = vintage.split('-').map(Number);
    const [y2, m2, d2] = today.split('-').map(Number);
    let months = (y2 - y1) * 12 + (m2 - m1);
    if (d2 < d1) months -= 1;
    if (months < 1) return `Rules as published on ${when}.`;
    return `Rules as published on ${when}, about ${months} month${months === 1 ? '' : 's'} ago.`;
  }

  // The "six months of remaining validity" rule denies boarding more often than
  // any visa question this dialog answers, and the app already knows both dates
  // it needs: the passport expiry the traveller typed and the last dated day of
  // the open trip.
  //
  // Three branches, and only two of them speak. Expiring on or before the last
  // day of the trip is a flat error. Expiring inside the six-month window after
  // it is a warning, worded as a warning about OTHER countries' rules rather
  // than a rule this app is asserting: 180 days is the common shape of it, not
  // a universal law, and plenty of destinations ask for less. Anything further
  // out says nothing at all, matching the rest of this app - silence means
  // nothing is wrong, and a green tick would be a promise about foreign border
  // policy we have no business making.
  //
  // `fmt` is the app's own date formatter, passed in the way suggestedPassport
  // takes its country lookup, so no ISO string ever reaches the copy.
  const PASSPORT_VALIDITY_DAYS = 180;
  function passportExpiryStatus(expiry, tripEnd, fmt) {
    if (!isIsoDate(expiry) || !isIsoDate(tripEnd)) return null;
    const after = diffDays(tripEnd, expiry);
    if (after <= 0) {
      return { level: 'error', text: `Your passport expires ${fmt(expiry)} - before this trip ends on ${fmt(tripEnd)}.` };
    }
    if (after < PASSPORT_VALIDITY_DAYS) {
      return {
        level: 'warn',
        text: `Your passport is valid for this trip but expires ${fmt(expiry)} - within 6 months of your return.`
          + ` Many countries require 6+ months of remaining validity to let you in;`
          + ` always check each destination's exact rule.`,
      };
    }
    return null;
  }

  // ---------- visa helpers ----------
  // Values in the Passport Index dataset: a number of visa-free days,
  // 'visa free', 'visa on arrival', 'e-visa', 'eta', 'visa required',
  // 'no admission', or '-1' for the passport's own country.
  function classifyVisa(raw) {
    const v = String(raw == null ? '' : raw).trim().toLowerCase();
    if (v === '-1') return { cls: 'home', label: 'Your passport country' };
    if (/^\d+$/.test(v)) return { cls: 'free', label: `Visa-free · up to ${v} days` };
    if (v === 'visa free' || v === 'visa-free' || v === 'freedom of movement') return { cls: 'free', label: 'Visa-free' };
    if (v.includes('on arrival')) return { cls: 'arrival', label: 'Visa on arrival' };
    if (v === 'e-visa' || v === 'evisa') return { cls: 'evisa', label: 'e-Visa required' };
    if (v === 'eta') return { cls: 'evisa', label: 'eTA required (electronic travel authorization)' };
    if (v.includes('no admission')) return { cls: 'required', label: 'Entry restricted' };
    if (v.includes('required')) return { cls: 'required', label: 'Visa required' };
    return { cls: 'unknown', label: 'Check requirements' };
  }

  // ---------- ICS calendar export ----------
  const ICS_STATUS = { booked: 'Booked', 'to-book': 'To book', decide: 'Decide later', cancelled: 'Cancelled' };
  // The wording from the payment picker in the item modal. Both exports that
  // carry the tag print this, never the stored token: a CSV cell and a calendar
  // entry are read by a person, and "prepaid" is not what the app calls it.
  const PAYMENT_LABEL = { cash: 'Cash', card: 'Card', prepaid: 'Prepaid / already paid' };
  // A deadline dropped into a sentence has to read as a date. Cached because it
  // is built once per export run, not once per item.
  const ICS_DATE_FMT = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
  const icsDate = s => ICS_DATE_FMT.format(new Date(s + 'T00:00:00Z'));

  // RFC 5545 text escaping: backslash, semicolon, comma and newlines.
  function icsEscapeText(s) {
    return String(s == null ? '' : s)
      .replace(/\\/g, '\\\\')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,')
      .replace(/\r?\n/g, '\\n');
  }

  function icsEvent(it) {
    if (!isIsoDate(it.startDate)) return null;
    const compact = d => d.replace(/-/g, '');
    const lines = ['BEGIN:VEVENT', `UID:${it.id}@trip-planner.shevato.com`];
    const timed = (it.type === 'flight' || it.type === 'transport' || it.type === 'local') && /^\d{2}:\d{2}$/.test(it.startTime || '');
    if (isStay(it)) {
      // all-day, exclusive end (matches the app's night semantics)
      const end = isIsoDate(it.endDate) && diffDays(it.startDate, it.endDate) > 0 ? it.endDate : addDays(it.startDate, 1);
      lines.push(`DTSTART;VALUE=DATE:${compact(it.startDate)}`);
      lines.push(`DTEND;VALUE=DATE:${compact(end)}`);
    } else if (timed) {
      // timed floating event (no Z, no TZID): the traveller's local wall clock
      const st = `${compact(it.startDate)}T${it.startTime.replace(':', '')}00`;
      lines.push(`DTSTART:${st}`);
      if (isIsoDate(it.endDate) && /^\d{2}:\d{2}$/.test(it.endTime || '')) {
        lines.push(`DTEND:${compact(it.endDate)}T${it.endTime.replace(':', '')}00`);
      } else {
        lines.push(`DTEND:${st}`);
      }
    } else {
      // untimed: single all-day event
      lines.push(`DTSTART;VALUE=DATE:${compact(it.startDate)}`);
      lines.push(`DTEND;VALUE=DATE:${compact(addDays(it.startDate, 1))}`);
    }
    lines.push(`SUMMARY:${icsEscapeText(it.title)}`);
    if (it.location) lines.push(`LOCATION:${icsEscapeText(it.location)}`);
    const descParts = [];
    if (it.details) descParts.push(it.details);
    // The confirmation code IS carried into the calendar, labelled, on its own
    // line: the phone calendar entry is what a traveller opens at the gate, and
    // that is precisely the moment the code is needed. It rides in DESCRIPTION
    // rather than a column of its own because ICS has no field for it.
    if (it.confirmation) descParts.push('Ref: ' + it.confirmation);
    descParts.push('Status: ' + (ICS_STATUS[it.status] || it.status || ''));
    // The booking deadline and the payment tag ride along for the same reason
    // the code does: they are what you check on the phone, away from the app.
    // Each line exists only when its field does, so an item carrying neither
    // has exactly the description it always had.
    if (isIsoDate(it.bookBy)) descParts.push('Book by: ' + icsDate(it.bookBy));
    if (PAYMENT_LABEL[it.payment]) descParts.push('Payment: ' + PAYMENT_LABEL[it.payment]);
    if (it.costNote) descParts.push(it.costNote);
    lines.push(`DESCRIPTION:${icsEscapeText(descParts.join('\n'))}`);
    lines.push('END:VEVENT');
    return lines;
  }

  // Builds a VCALENDAR string with CRLF line endings (RFC 5545 requires them
  // inside the file content; this is the generated STRING, not a source file).
  function buildIcs(trip) {
    const out = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Shevato//Trip Planner//EN',
      `X-WR-CALNAME:${icsEscapeText(trip.name || 'Trip')}`,
    ];
    for (const it of sortedItems(trip)) {
      if (!it || it.status === 'cancelled') continue;
      const ev = icsEvent(it);
      if (ev) out.push(...ev);
    }
    out.push('END:VCALENDAR');
    return out.join('\r\n') + '\r\n';
  }

  // ---------- GPX export ----------
  // The route the Map view draws, as a file a GPS app or My Maps can open. It
  // takes ALREADY-LOCATED stops ({ name, lat, lon }) rather than a trip: the
  // coordinates come from the geocode cache the map already filled, and this
  // file must never be the thing that starts a geocoding run (Nominatim is one
  // request a second under a policy that forbids bulk).
  const xmlEscape = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

  function buildGpx(stops) {
    const out = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<gpx version="1.1" creator="Shevato Trip Planner" xmlns="http://www.topografix.com/GPX/1/1">',
    ];
    // The last waypoint WRITTEN, not the last stop seen: a stop with no
    // coordinate is dropped rather than sent to 0,0 (a waypoint in the Gulf of
    // Guinea is worse than a missing one), and dropping it must not leave the
    // same place written twice in a row.
    let lastKey = '';
    for (const stop of (Array.isArray(stops) ? stops : [])) {
      if (!stop || !validCoord(stop.lat, stop.lon)) continue;
      const name = String(stop.name == null ? '' : stop.name).trim();
      // mapStops' rule: coming back to a city later in the trip is a second
      // waypoint, two items in the same city back to back are one.
      const key = name.toLowerCase();
      if (key && key === lastKey) continue;
      lastKey = key;
      // Fixed decimals, never the default number formatting: a coordinate near
      // zero prints as "1e-7" there, which is not a valid xsd:decimal.
      out.push(`  <wpt lat="${Number(stop.lat).toFixed(6)}" lon="${Number(stop.lon).toFixed(6)}">`);
      out.push(`    <name>${xmlEscape(name)}</name>`);
      out.push('  </wpt>');
    }
    out.push('</gpx>');
    return out.join('\n') + '\n';
  }

  // ---------- CSV export ----------
  // Pure so the round trip is testable: the `cost` column is the STORED number,
  // sign and all, which is what makes a spreadsheet SUM over it equal the app's
  // own total even with refunds in the mix. Display wording ("Refund $120.00")
  // never reaches this file. estCost keeps its own column for the same reason:
  // a guess must not land in a column people total.
  // `confirmation` IS exported, and it is appended rather than slotted next to
  // the other booking columns: a spreadsheet people already built against this
  // header keeps every existing column at the index it had. Leaving the code out
  // would make the CSV the one export that silently drops it.
  // `travelers` is appended last for the same reason `confirmation` is: a
  // spreadsheet already built against this header keeps every prior column at
  // the index it had. It carries who a cost is split between (the whole point of
  // a CSV export of a shared trip is a split-the-bill sheet), empty meaning the
  // cost is shared across everyone.
  // `bookBy` and `paymentMethod` are appended after those two, for that same
  // reason again: never in the middle. paymentMethod prints the picker's own
  // wording ("Prepaid / already paid") rather than the stored token, because a
  // CSV is read by a person; bookBy stays ISO like every other date column.
  function csvColumns(base) {
    return ['startDate', 'startTime', 'endDate', 'endTime', 'nights', 'type', 'title', 'location',
      'details', 'status', 'cost', 'costCurrency', `costIn${base}`, 'estimatedCost',
      'estimatedCostCurrency', 'costNote', 'confirmation', 'travelers', 'bookBy', 'paymentMethod'];
  }
  const csvCell = v => `"${String(v).replace(/"/g, '""')}"`;
  function buildCsv(trip, base, ratesObj) {
    const cur = base || trip.currency || 'USD';
    const lines = [csvColumns(cur).join(',')];
    for (const it of sortedItems(trip)) {
      const from = it.costCurrency || cur;
      const conv = it.cost != null && it.cost !== '' ? convertAmount(Number(it.cost), from, cur, ratesObj) : null;
      lines.push([
        it.startDate, it.startTime || '', it.endDate || '', it.endTime || '', nights(it) ?? '',
        it.type, it.title, it.location || '', it.details || '',
        ICS_STATUS[it.status] || it.status || '',
        it.cost ?? '', from, conv == null ? '' : conv.toFixed(2),
        it.estCost ?? '', it.estCost != null ? (it.estCostCurrency || cur) : '',
        it.costNote || '', it.confirmation || '',
        Array.isArray(it.travelers) ? it.travelers.join('; ') : '',
        it.bookBy || '', PAYMENT_LABEL[it.payment] || '',
      ].map(csvCell).join(','));
    }
    return lines.join('\n');
  }

  // ---------- currency conversion ----------
  // ratesObj = { base, rates } where rates[X] = units of X per 1 base unit
  // (the shape frankfurter.app returns for ?from=<base>). Returns null when a
  // needed rate is missing so callers can flag the amount as unconverted.
  function convertAmount(amount, from, to, ratesObj) {
    if (from === to) return amount;
    if (!ratesObj || !ratesObj.rates) return null;
    const base = ratesObj.base, table = ratesObj.rates;
    const inBase = from === base ? amount : (table[from] != null ? amount / table[from] : null);
    if (inBase === null) return null;
    if (to === base) return inBase;
    if (table[to] == null) return null;
    return inBase * table[to];
  }

  // Sums item costs into toCurrency. Items whose currency cannot be converted
  // are collected in `unconverted` and left out of the total (never a 1:1 fake).
  function sumInCurrency(items, toCurrency, ratesObj) {
    let total = 0;
    const unconverted = [];
    for (const it of items) {
      if (it.cost == null || it.cost === '' || isNaN(it.cost)) continue;
      const from = it.costCurrency || toCurrency;
      const c = convertAmount(Number(it.cost), from, toCurrency, ratesObj);
      if (c === null) unconverted.push(it);
      else total += c;
    }
    return { total, unconverted };
  }

  // ---------- per-traveller cost split ----------
  // Trimmed, de-duplicated (case-insensitive) traveller names, capped at 6.
  // This cap and trim are the ONE gate every path funnels through: the trip
  // form, a JSON/backup import and an item's own assignment all normalize here,
  // so a malformed name cannot enter from any direction.
  function normalizeTravelers(list) {
    if (!Array.isArray(list)) return [];
    const out = [], seen = new Set();
    for (const raw of list) {
      const name = String(raw == null ? '' : raw).trim().slice(0, 40);
      if (!name) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(name);
      if (out.length === 6) break;
    }
    return out;
  }

  // Which named travellers an item is assigned to, canonicalised against the
  // roster. An EMPTY result means "Everyone" (see travelerTotals): a `travelers`
  // entry naming somebody the trip no longer lists is dropped here, so a stale
  // name can never conjure a share for a person who is not on the trip.
  function assignedTravelers(item, names) {
    const canon = new Map(names.map(n => [n.toLowerCase(), n]));
    const out = [];
    if (Array.isArray(item && item.travelers)) {
      for (const raw of item.travelers) {
        const c = canon.get(String(raw == null ? '' : raw).trim().toLowerCase());
        if (c && !out.includes(c)) out.push(c);
      }
    }
    return out;
  }

  // ---------- uneven cost splits ----------
  // A shared cost is rarely even: one person's solo upgrade, one person covering
  // the table. An item may therefore carry `splitAmounts`, a hand-entered amount
  // per assigned traveller IN THE ITEM'S OWN CURRENCY, which the per-traveller
  // split and the settle-up ledger both spend instead of dividing.
  //
  // The even divide stays the default and stays untouched: nothing below runs
  // for an item without `splitAmounts`, so a trip that never used this feature
  // produces byte-for-byte the numbers it did before.

  // What the "Split by amount" inputs open with: the even divide, already
  // rounded to cents and guaranteed to add back UP to the cost. A $100 three-way
  // split is 33.34 / 33.33 / 33.33, never three 33.33s leaving a cent
  // unaccounted for, because the amounts must sum to the cost to be saved and a
  // default nobody can save is a trap. The odd cents go to the first travellers
  // in roster order, so the same item always opens on the same numbers.
  function evenSplitAmounts(cost, names) {
    const out = {};
    const list = Array.isArray(names) ? names : [];
    // the same "is there a cost here at all" test every money block runs: a
    // blank cost is nothing to divide, not a row of zeroes
    if (cost == null || cost === '' || isNaN(cost)) return out;
    const total = Math.round(Number(cost) * 100);
    if (!list.length || !Number.isFinite(total)) return out;
    const base = Math.trunc(total / list.length);
    // sign follows the total, so a refund splits the same way a charge does
    const step = total < 0 ? -1 : 1;
    let rest = total - base * list.length;
    for (const name of list) {
      let cents = base;
      if (rest !== 0) { cents += step; rest -= step; }
      out[name] = cents / 100;
    }
    return out;
  }

  // Sum of a hand-entered split, or null when any entry is not a number.
  // Added in whole CENTS: 70.1 + 29.9 is 100.00000000000001 in binary floating
  // point, and a traveller who typed a correct split must never be told it is
  // wrong by a rounding artefact.
  function splitAmountsSum(amounts, names) {
    let cents = 0;
    for (const n of (Array.isArray(names) ? names : [])) {
      const raw = amounts ? amounts[n] : undefined;
      if (raw === '' || raw == null) return null;
      const v = Number(raw);
      if (!Number.isFinite(v)) return null;
      cents += Math.round(v * 100);
    }
    return cents / 100;
  }

  // Does a hand-entered split still account for the whole cost, to the cent?
  // This is the one gate: the form blocks a save that fails it, and every
  // consumer below refuses to spend a split that fails it.
  function splitAmountsMatch(cost, amounts, names) {
    const sum = splitAmountsSum(amounts, names);
    if (sum === null) return false;
    const target = Math.round(Number(cost) * 100);
    if (!Number.isFinite(target)) return false;
    return Math.round(sum * 100) === target;
  }

  // The per-person amounts an item's cost actually splits into, in the ITEM's
  // own currency, or null when there is no hand-entered split to honour and the
  // caller's even divide stands.
  //
  // A custom split is only honoured while it still DESCRIBES the item in front
  // of us: a finite cost, 2+ named travellers (never "Everyone", which has no
  // fixed roster to key amounts by), one finite amount for each of exactly those
  // people, and a total that still adds up to the cost. Anything else (a
  // traveller dropped from the trip, a cost edited elsewhere, a hand-edited
  // import or share link) falls back to the even divide rather than paying out a
  // stale set of numbers that no longer adds up to what was spent.
  function customSplitShares(item, names) {
    if (!item || !item.splitAmounts || typeof item.splitAmounts !== 'object') return null;
    if (item.cost == null || item.cost === '' || isNaN(item.cost)) return null;
    const assigned = assignedTravelers(item, Array.isArray(names) ? names : []);
    if (assigned.length < 2) return null;
    if (Object.keys(item.splitAmounts).length !== assigned.length) return null;
    const out = {};
    for (const n of assigned) {
      const raw = item.splitAmounts[n];
      if (raw === '' || raw == null) return null;
      const v = Number(raw);
      if (!Number.isFinite(v)) return null;
      out[n] = v;
    }
    if (!splitAmountsMatch(item.cost, out, assigned)) return null;
    return out;
  }

  // Per-traveller cost split, in the trip's own currency.
  //
  // RETURN SHAPE: a plain object mapping each named traveller to their numeric
  // share total, converted amounts only, e.g. { Alex: 130, Sam: 80 }. That map
  // is the whole ENUMERABLE return, so it compares equal to the bare totals a
  // caller expects and iterates cleanly. The per-traveller list of amounts that
  // could NOT be converted rides along as a NON-ENUMERABLE `unconverted`
  // property ({ [name]: [item, ...] }): the render reads it to flag a traveller
  // amber (their number is honestly short, never silently under-counted),
  // exactly as the trip-wide Confirmed total flags itself, while an equality
  // check or a for..in over the totals never trips on it.
  //
  // Which items count: every NON-CANCELLED item carrying a finite cost, matching
  // tripStats/tripMoney's base filter (cancelled is the one status dropped). An
  // item assigned to nobody (item.travelers empty or absent) is "Everyone" and
  // splits evenly across ALL named travellers; an item assigned to a subset
  // splits evenly across that subset. Division is at full precision and only
  // formatted at display, so a $60 item split two ways is exactly $30 each.
  // `ratesObj` is the same { base, rates } sumInCurrency takes; an amount whose
  // currency cannot be converted adds nothing to the number and is recorded
  // under every traveller who owed a share of it.
  //
  // An item carrying a valid hand-entered split (see customSplitShares) spends
  // those amounts instead of dividing: a $100 dinner split 70/30 is 70 and 30
  // here, never 50 and 50. Each share converts on its own, which is the same
  // arithmetic as converting the total and splitting it, conversion being a
  // multiplication.
  function travelerTotals(trip, ratesObj) {
    const names = normalizeTravelers(trip && trip.travelers);
    const totals = {}, unconverted = {};
    Object.defineProperty(totals, 'unconverted', { value: unconverted, enumerable: false });
    if (names.length < 2) return totals;
    for (const n of names) { totals[n] = 0; unconverted[n] = []; }
    const base = (trip && trip.currency) || 'USD';
    for (const it of (trip.items || [])) {
      if (it.status === 'cancelled') continue;
      if (it.cost == null || it.cost === '' || isNaN(it.cost)) continue;
      const assigned = assignedTravelers(it, names);
      const payers = assigned.length ? assigned : names; // Everyone, never "nobody"
      const from = it.costCurrency || base;
      const conv = convertAmount(Number(it.cost), from, base, ratesObj);
      const custom = customSplitShares(it, names);
      for (const n of payers) {
        if (conv === null) unconverted[n].push(it);
        else if (custom) totals[n] += convertAmount(custom[n], from, base, ratesObj);
        else totals[n] += conv / payers.length;
      }
    }
    return totals;
  }

  // ---------- settle up (who owes whom) ----------
  // travelerTotals answers "what did this trip cost each of us"; this answers
  // the question that actually gets asked at the end of it, "so who pays who".
  //
  // WHICH ITEMS COUNT, and why this filter is narrower than travelerTotals':
  // only a BOOKED item, with a convertible cost, that names who actually paid.
  // A "to book" cost is money nobody has handed over yet, so settling it would
  // invent a debt; an item with no `paidBy` is money we were never told about.
  // Both are deliberately worth $0 here even though they still count towards a
  // traveller's share above, so the two blocks answer two different questions
  // and neither one lies.
  //
  // RETURN SHAPE: an array of { from, to, amount } payments, from = the debtor,
  // to = the creditor, amount in the trip's currency, netted down to the fewest
  // payments that clear every balance. `tracked` (how many item costs carried a
  // usable payer) and `unconverted` (booked, paid-for items whose currency we
  // could not convert) ride along as NON-ENUMERABLE properties so a deepEqual
  // against a plain array of payments still holds: the render needs `tracked` to
  // tell "nobody recorded a payer" (say so, do not print a wall of $0.00) apart
  // from "everyone is already square".
  //
  // A `paidBy` naming somebody the trip no longer lists (renamed, removed) is
  // matched case-insensitively to the roster and otherwise ignored entirely,
  // the same treatment an item's `travelers` assignment gets: a stale name can
  // never conjure a debt for a person who is not on the trip.
  function settlements(trip, ratesObj) {
    const names = normalizeTravelers(trip && trip.travelers);
    const out = [];
    const unconverted = [];
    let tracked = 0;
    const finish = () => {
      Object.defineProperty(out, 'unconverted', { value: unconverted, enumerable: false });
      Object.defineProperty(out, 'tracked', { value: tracked, enumerable: false });
      return out;
    };
    if (names.length < 2) return finish();
    const base = (trip && trip.currency) || 'USD';
    const canon = new Map(names.map(n => [n.toLowerCase(), n]));
    const net = {};
    for (const n of names) net[n] = 0;
    for (const it of (trip.items || [])) {
      if (it.status !== 'booked') continue;
      if (it.cost == null || it.cost === '' || isNaN(it.cost)) continue;
      const payer = canon.get(String(it.paidBy == null ? '' : it.paidBy).trim().toLowerCase());
      if (!payer) continue;
      const from = it.costCurrency || base;
      const conv = convertAmount(Number(it.cost), from, base, ratesObj);
      if (conv === null) { unconverted.push(it); continue; }
      tracked++;
      const assigned = assignedTravelers(it, names);
      const owers = assigned.length ? assigned : names; // Everyone, never "nobody"
      // a hand-entered split is what each of them actually owes, so the ledger
      // clears the debt that was agreed rather than the one an even divide
      // would have invented
      const custom = customSplitShares(it, names);
      net[payer] += conv;
      for (const n of owers) {
        net[n] -= custom ? convertAmount(custom[n], from, base, ratesObj) : conv / owers.length;
      }
    }
    // Round to cents BEFORE pairing. Netting at full precision leaves balances
    // like -33.33333 that pair into a 0.0000001 payment, i.e. a "Sam owes Alex
    // $0.00" line, which is worse than no line at all.
    const cents = n => Math.round(n * 100) / 100;
    const rank = new Map(names.map((n, i) => [n, i]));
    const creditors = [], debtors = [];
    for (const n of names) {
      const v = cents(net[n]);
      if (v >= 0.005) creditors.push({ name: n, amt: v });
      else if (v <= -0.005) debtors.push({ name: n, amt: -v });
    }
    // Largest against largest is the classic greedy minimum-payments pairing.
    // Ties break on roster order so the same trip always renders the same rows.
    const bySize = (a, b) => b.amt - a.amt || rank.get(a.name) - rank.get(b.name);
    creditors.sort(bySize);
    debtors.sort(bySize);
    let ci = 0, di = 0;
    while (ci < creditors.length && di < debtors.length) {
      const c = creditors[ci], d = debtors[di];
      const pay = cents(Math.min(c.amt, d.amt));
      if (pay >= 0.005) out.push({ from: d.name, to: c.name, amount: pay });
      c.amt = cents(c.amt - pay);
      d.amt = cents(d.amt - pay);
      if (c.amt < 0.005) ci++;
      if (d.amt < 0.005) di++;
    }
    return finish();
  }

  // ---------- cost by type ----------
  // "Where did the money go", one row per item type that has at least one
  // BOOKED costed item, biggest first. Booked-only is the same filter the
  // Confirmed total uses, so these rows add up to that number rather than to
  // some third figure nothing else on the page shows.
  //
  // A type with nothing booked and costed gets NO row: a $0.00 placeholder for
  // a type the trip never used reads as "we spent nothing on transport" when
  // the truth is "there is no transport here". A type whose amount could not be
  // converted still gets its row, carrying the offending items in `unconverted`
  // so the render can flag it amber, because dropping the row would hide money.
  const TYPE_SORT = ['flight', 'transport', 'local', 'activity', 'stay', 'note'];
  function costsByType(trip, ratesObj) {
    const base = (trip && trip.currency) || 'USD';
    const rows = new Map();
    for (const it of ((trip && trip.items) || [])) {
      if (it.status !== 'booked') continue;
      if (it.cost == null || it.cost === '' || isNaN(it.cost)) continue;
      let row = rows.get(it.type);
      if (!row) { row = { type: it.type, total: 0, unconverted: [] }; rows.set(it.type, row); }
      const conv = convertAmount(Number(it.cost), it.costCurrency || base, base, ratesObj);
      if (conv === null) row.unconverted.push(it);
      else row.total += conv;
    }
    const ord = t => { const i = TYPE_SORT.indexOf(t); return i < 0 ? TYPE_SORT.length : i; };
    return [...rows.values()].sort((a, b) => b.total - a.total || ord(a.type) - ord(b.type));
  }

  // Bar length per "Cost by type" row, as a 0..1 share of the LARGEST row, so
  // the ranking those rows already carry is readable without comparing four
  // amounts digit by digit. The biggest row is always exactly 1.
  //
  // A row can total zero or less (a refund cancelling a booking out), and those
  // get no bar rather than a backwards one; if no row is positive at all there
  // is no meaningful largest, so nothing gets a bar. Which rows exist is
  // costsByType's decision, never this one: a zero bar is still a row.
  function typeBarShares(rows) {
    const list = Array.isArray(rows) ? rows : [];
    const amount = r => { const v = Number(r && r.total); return Number.isFinite(v) ? v : 0; };
    const max = list.reduce((m, r) => Math.max(m, amount(r)), 0);
    return list.map(r => (max > 0 ? Math.max(0, amount(r)) / max : 0));
  }

  // ---------- cash needed, per currency ----------
  // "How much yen do I actually have to carry" is a question no converted grand
  // total can answer, so this is the ONE money block that never converts: each
  // row is the sum of the cash-tagged costs entered in that currency, in that
  // currency. An item with no `payment` tag is not counted, because "not
  // tracked" is the absence of a claim, not a claim that a card will do.
  //
  // Cancelled items drop out (that money is not going anywhere), a blank cost
  // contributes nothing, and a negative amount (a refund of cash) nets into its
  // currency rather than being hidden: a row may legitimately read zero or
  // negative. A currency nobody tagged as cash simply has no row, never a $0.00
  // placeholder, the same rule costsByType follows.
  //
  // Returns [{ currency, total }] sorted by currency code so the block is
  // stable across renders, and totals are rounded to cents before display for
  // the same reason settlements rounds before pairing.
  function cashNeeded(trip) {
    const base = (trip && trip.currency) || 'USD';
    const sums = new Map();
    for (const it of ((trip && trip.items) || [])) {
      if (!it || it.payment !== 'cash' || it.status === 'cancelled') continue;
      if (it.cost == null || it.cost === '' || isNaN(it.cost)) continue;
      const cur = it.costCurrency || base;
      sums.set(cur, (sums.get(cur) || 0) + Number(it.cost));
    }
    return [...sums.entries()]
      .map(([currency, total]) => ({ currency, total: Math.round(total * 100) / 100 }))
      .sort((a, b) => a.currency < b.currency ? -1 : 1);
  }

  // ---------- base64url (share links) ----------
  const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  function bytesToBase64url(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
      const b0 = bytes[i], b1 = bytes[i + 1], b2 = bytes[i + 2];
      const has1 = i + 1 < bytes.length, has2 = i + 2 < bytes.length;
      out += B64URL[b0 >> 2];
      out += B64URL[((b0 & 3) << 4) | (has1 ? b1 >> 4 : 0)];
      if (has1) out += B64URL[((b1 & 15) << 2) | (has2 ? b2 >> 6 : 0)];
      if (has2) out += B64URL[b2 & 63];
    }
    return out;
  }
  function base64urlToBytes(str) {
    const lookup = {};
    for (let i = 0; i < B64URL.length; i++) lookup[B64URL[i]] = i;
    const bytes = [];
    for (let i = 0; i < str.length; i += 4) {
      const c0 = lookup[str[i]], c1 = lookup[str[i + 1]];
      const c2 = str[i + 2] !== undefined ? lookup[str[i + 2]] : undefined;
      const c3 = str[i + 3] !== undefined ? lookup[str[i + 3]] : undefined;
      bytes.push((c0 << 2) | (c1 >> 4));
      if (c2 !== undefined) bytes.push(((c1 & 15) << 4) | (c2 >> 2));
      if (c3 !== undefined) bytes.push(((c2 & 3) << 6) | c3);
    }
    return new Uint8Array(bytes);
  }

  // ---------- continuity gaps ----------
  // Consecutive non-cancelled stays in different cities (the tripLegs pairing)
  // with no non-cancelled flight/transport dated inside [from.endDate, to.startDate].
  // Deliberately flight/transport only: `local` moves you around ONE city, so a
  // taxi dated between two cities is not how you got from one to the other and
  // must not silence the warning.
  function transportGaps(trip) {
    const stays = sortedItems(trip).filter(it => isStay(it) && it.status !== 'cancelled' && (it.location || '').trim());
    const transports = trip.items.filter(it => (it.type === 'flight' || it.type === 'transport') && it.status !== 'cancelled');
    const gaps = [];
    for (let i = 1; i < stays.length; i++) {
      const from = stays[i - 1], to = stays[i];
      if (from.location.trim().toLowerCase() === to.location.trim().toLowerCase()) continue;
      const gapStart = from.endDate, gapEnd = to.startDate;
      if (!isIsoDate(gapStart) || !isIsoDate(gapEnd)) continue;
      const covered = transports.some(tr => {
        const inRange = d => isIsoDate(d) && d >= gapStart && d <= gapEnd;
        return inRange(tr.startDate) || inRange(tr.endDate);
      });
      if (!covered) {
        gaps.push({
          fromId: from.id, toId: to.id,
          fromLocation: from.location.trim(), toLocation: to.location.trim(),
          gapStart, gapEnd,
        });
      }
    }
    return gaps;
  }

  // ---------- connections between travel legs ----------
  const TRAVEL_TYPE = { flight: 1, transport: 1, local: 1 };
  const TIME_RE = /^\d{2}:\d{2}$/;
  // Under this many minutes between landing and the next departure is worth a
  // second look. 45 is the low end of what airports themselves publish as a
  // minimum connecting time, and it is also about the shortest station-to-train
  // change that survives a small delay.
  const TIGHT_CONNECTION_MIN = 45;
  // Two legs are only a CONNECTION when they belong to the same journey. Sort
  // adjacency alone cannot tell an outbound from a return: on a two-flight trip
  // the flight home is adjacent to the flight out, and one mistyped arrival date
  // would then be reported as an "impossible connection" across three weeks,
  // which is noise on top of the far-outside-date error that already names the
  // typo. A day is the honest cutoff: it still covers a red-eye that lands at
  // 06:00 and a same-evening change, and nothing anybody would call a connection
  // sits further apart than that.
  const CONNECTION_WINDOW_MIN = 24 * 60;

  function stampMin(date, time) {
    const [h, m] = time.split(':').map(Number);
    return Math.round(toUtc(date).getTime() / 60000) + h * 60 + m;
  }

  // When a leg lands: its arrival date/time, falling back to the departure
  // date/time for a leg saved with only one clock value (a short hop where the
  // traveller filled in departure alone). Returns null when no time at all was
  // entered, because guessing one would invent the very number being judged.
  function legArrival(it) {
    const date = isIsoDate(it.endDate) ? it.endDate : it.startDate;
    const time = TIME_RE.test(it.endTime || '') ? it.endTime : (TIME_RE.test(it.startTime || '') ? it.startTime : '');
    if (!isIsoDate(date) || !time) return null;
    return { date, time, min: stampMin(date, time) };
  }
  function legDeparture(it) {
    if (!isIsoDate(it.startDate) || !TIME_RE.test(it.startTime || '')) return null;
    return { date: it.startDate, time: it.startTime, min: stampMin(it.startDate, it.startTime) };
  }

  // Adjacent travel legs (nothing else scheduled between them) where the second
  // one leaves before the first one lands, or so soon after that the change is
  // unlikely to hold.
  function connectionWarnings(items) {
    const live = [...(items || [])].filter(it => it && it.status !== 'cancelled').sort(bySortKey);
    const stays = live.filter(it => isStay(it) && isIsoDate(it.startDate));
    const out = [];
    for (let i = 1; i < live.length; i++) {
      const from = live[i - 1], to = live[i];
      if (!TRAVEL_TYPE[from.type] || !TRAVEL_TYPE[to.type]) continue;
      const arr = legArrival(from), dep = legDeparture(to);
      if (!arr || !dep) continue;
      const gap = dep.min - arr.min;
      if (gap >= TIGHT_CONNECTION_MIN) continue;
      if (Math.abs(gap) > CONNECTION_WINDOW_MIN) continue;
      // A bed booked for a night the two legs straddle means this is a stopover,
      // not a connection. Only checked when they actually straddle a night: on a
      // single travel day the hotel you check into that evening says nothing
      // about the twenty minutes between landing and the next departure.
      if (dep.date > arr.date && stays.some(s => s.startDate >= arr.date && s.startDate <= dep.date)) continue;
      out.push({
        kind: gap <= 0 ? 'impossible' : 'tight',
        minutes: gap,
        fromId: from.id, toId: to.id,
        fromTitle: from.title || '', toTitle: to.title || '',
        arriveDate: arr.date, arriveTime: arr.time,
        departDate: dep.date, departTime: dep.time,
      });
    }
    return out;
  }

  // ---------- same-clock-time double bookings ----------
  // Two things saved for the identical date AND identical time. Exact match
  // only: the app never asks how long anything lasts, so any "close enough"
  // window would be a guess about durations it does not have. Stays are out by
  // construction (the item form hides the time field for them).
  function sameTimeCollisions(items) {
    const live = [...(items || [])]
      .filter(it => it && it.status !== 'cancelled' && !isStay(it) && isIsoDate(it.startDate) && TIME_RE.test(it.startTime || ''))
      .sort(bySortKey);
    const out = [];
    for (let i = 0; i < live.length; i++) {
      for (let j = i + 1; j < live.length; j++) {
        const a = live[i], b = live[j];
        if (a.startDate !== b.startDate || a.startTime !== b.startTime) continue;
        out.push({
          aId: a.id, bId: b.id,
          aTitle: a.title || '', bTitle: b.title || '',
          date: a.startDate, time: a.startTime,
        });
      }
    }
    return out;
  }

  // ---------- booking deadlines ----------
  // The app already says "this is in the past and still To book", which arrives
  // too late for anything that sells out or reprices. An item may carry an
  // optional `bookBy` date; this reports the ones worth acting on NOW.
  //
  // Only a "to book" item qualifies: Booked is done, Decide later is a
  // deliberate maybe and Cancelled is off the trip, so a stored deadline on any
  // of them is history, not a task. An item with no real date of its own is out
  // too, matching validateItem, which has nothing to bound the deadline against.
  //
  // Returns one entry per item, never a merged count, so the panel can name each
  // deadline and link to its row: { id, title, date, daysLeft, kind }, kind
  // 'passed' (deadline behind us, daysLeft negative) or 'due' (inside the
  // window, daysLeft 0..BOOKING_LEAD_DAYS). Sorted by deadline, soonest first.
  const BOOKING_LEAD_DAYS = 7;
  function bookingDeadlines(items, todayStr) {
    if (!isIsoDate(todayStr)) return [];
    const out = [];
    for (const it of (items || [])) {
      if (!it || it.status !== 'to-book') continue;
      if (!isIsoDate(it.bookBy) || !isIsoDate(it.startDate)) continue;
      const daysLeft = diffDays(todayStr, it.bookBy);
      if (daysLeft > BOOKING_LEAD_DAYS) continue;
      out.push({
        id: it.id,
        title: it.title || '',
        date: it.bookBy,
        daysLeft,
        kind: daysLeft < 0 ? 'passed' : 'due',
      });
    }
    return out.sort((a, b) => a.date < b.date ? -1 : (a.date > b.date ? 1 : 0));
  }

  // ---------- pace ----------
  // The one thing the panel says about the SHAPE of a trip rather than a mistake
  // in it: a run of one-night stops reads fine on paper and is exhausting to
  // live, because every day loses its two ends to checking out and checking in.
  // It is an observation, never a task, so the caller files it as info.
  //
  // Under 2 nights per stay is the line because 2 is the first number that buys
  // a whole day in a place: one night is arrive-and-leave, two leaves one full
  // day between the travel halves. Four stays is the smallest run an average can
  // describe - one or two short stops are just how a long trip starts or ends.
  //
  // Nights come from nights(), the same helper the night strip and the timeline
  // count with, so this can never print a figure the strip disagrees with.
  const PACE_MIN_STAYS = 4;
  const PACE_FAST_AVG_NIGHTS = 2;
  function paceAdvisory(items) {
    let stays = 0;
    let total = 0;
    for (const it of (items || [])) {
      if (!it || it.status === 'cancelled') continue;
      const n = nights(it);
      if (n == null) continue;
      stays++;
      total += n;
    }
    if (stays < PACE_MIN_STAYS) return null;
    // rounded BEFORE the comparison, because the rounded figure is what the line
    // prints: an average of 1.96 would otherwise read "averaging 2.0 nights
    // each" under the word "Fast", contradicting itself
    const avg = Math.round((total / stays) * 10) / 10;
    if (avg >= PACE_FAST_AVG_NIGHTS) return null;
    return { stays, nights: total, avg };
  }

  // ---------- trip-in-progress ----------
  function tripPhase(startDate, endDate, todayStr) {
    if (!isIsoDate(startDate) || !isIsoDate(endDate) || !isIsoDate(todayStr)) {
      return { phase: 'before', dayNumber: 0, totalDays: 0 };
    }
    const totalDays = diffDays(startDate, endDate) + 1;
    if (todayStr < startDate) return { phase: 'before', dayNumber: 0, totalDays };
    if (todayStr > endDate) return { phase: 'after', dayNumber: totalDays, totalDays };
    return { phase: 'during', dayNumber: diffDays(startDate, todayStr) + 1, totalDays };
  }

  // A row is "past" when its whole span is behind today: stays by check-out,
  // everything else by its end (or start when it has no end).
  function isPastRow(it, todayStr) {
    if (!isIsoDate(todayStr)) return false;
    if (isStay(it)) return isIsoDate(it.endDate) && it.endDate < todayStr;
    const end = isIsoDate(it.endDate) ? it.endDate : it.startDate;
    return isIsoDate(end) && end < todayStr;
  }

  // ---------- day-by-day cards ----------
  // One card per calendar date from the trip's first dated item to its last,
  // inclusive. Stays split into a 'checkin' event on their start date and a
  // separate 'checkout' event on their end date; a date sitting fully inside a
  // stay with nothing else scheduled reports where you're staying; a date with
  // neither is empty. Cancelled items are kept (with their status) so the day
  // view mirrors the timeline.
  const EVENT_KIND_ORDER = { checkout: 0, item: 1, checkin: 2 };

  // Assumed clock positions for the two stay rows, which carry no time of their
  // own. A hotel takes the room back late morning and hands the next one over
  // mid-afternoon, so an 08:00 activity belongs ABOVE a check-out and a 19:00
  // dinner below a check-in. These drive ORDERING ONLY: they are never put on
  // ev.time and must never be rendered, because we do not know the real times.
  const ASSUMED_CHECKOUT_TIME = '11:00';
  const ASSUMED_CHECKIN_TIME = '15:00';

  // Same shape as sortKey, and the manual order sits in the same place: after
  // the clock, before the type. A stay carries no order (it is in no tie group),
  // so its assumed check-in / check-out position is untouched.
  function eventSortKey(ev) {
    const t = ev.sortTime || '99:99';
    const typeOrd = TYPE_ORDER[ev.item.type] !== undefined ? TYPE_ORDER[ev.item.type] : 9;
    return `${t}|${orderPart(ev.item)}|${typeOrd}|${EVENT_KIND_ORDER[ev.kind]}|${ev.item.createdAt || ''}`;
  }

  // The stay that tells you which city a given date belongs to: the bed you
  // sleep in that night wins, and on the final morning the stay you are
  // checking out of still answers "where am I today". Computed for EVERY day,
  // not only quiet ones, so a busy day never loses its hotel.
  function dayHostStay(items, date) {
    const stays = (items || []).filter(it => isStay(it) && it.status !== 'cancelled'
      && (it.location || '').trim() && isIsoDate(it.startDate) && isIsoDate(it.endDate));
    return stays.find(s => s.startDate <= date && date < s.endDate)
      || stays.find(s => s.endDate === date)
      || null;
  }

  // What a day tile with nothing on it says. "No plans yet" is only TRUE when
  // nobody is hosting that night: inside a stay the traveller does have a bed
  // and a place, and the tile has to say so now the old cramped "Staying in X"
  // bottom line is gone. The hotel is named rather than the city, because the
  // header chip already carries the city.
  function emptyDayNote(items, date) {
    const host = dayHostStay(items, date);
    if (!host) return 'No plans yet';
    return `Nothing planned, staying at ${(host.title || host.location).trim()}`;
  }

  // "Shreveport (SHV)" -> "Shreveport". Airport and station codes ride in
  // parentheses and are never a place a geocoder or a traveller recognises.
  function stripPlaceCode(name) {
    return String(name || '').replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  }

  // Origin half of a travel title written as "A to B". Splits on the FIRST
  // " to " so "Tokyo to Kyoto to Osaka" still departs from Tokyo.
  function parseTravelOrigin(title) {
    const m = /^(.*?)\s+to\s+.+$/i.exec(String(title || '').trim());
    return m ? stripPlaceCode(m[1]) : '';
  }

  // Arrival half of the same shape, split on the LAST " to " so "Tokyo to
  // Kyoto to Osaka" arrives in Osaka. Keeps the raw text for a chip label
  // ("Keflavik (KEF)"), the stripped city for a geocode fallback, and the
  // IATA-style code when one rides in the parentheses, which is what lets the
  // bundled airports table place the point exactly.
  function parseTravelArrival(title) {
    const m = /^.+\s+to\s+(.+)$/i.exec(String(title || '').trim());
    if (!m) return null;
    const raw = m[1].trim();
    const city = stripPlaceCode(raw);
    const code = /\(([A-Za-z]{3})\)/.exec(raw);
    if (!city && !code) return null;
    return { label: raw, city, iata: code ? code[1].toUpperCase() : '' };
  }

  // The arrival that OPENS a day: the last flight/transport leg to land on
  // `date` (an overnight leg via its endDate, a same-day leg via its only
  // date) with a parseable "A to B" title and a real arrival clock time -
  // a timeless leg cannot be ordered against the day and claims nothing.
  // The rule stands ONLY when nothing located happens before that arrival:
  // a morning of activities followed by an evening flight out still measures
  // from the morning's own anchor, never from an airport nobody has reached
  // yet. Stay check-ins never block, because the leg into town precedes the
  // bed by construction; that check-in is exactly the stop whose chip should
  // read "airport to hotel".
  function dayArrival(items, date) {
    const list = (Array.isArray(items) ? items : []).filter(it => it && it.status !== 'cancelled');
    const legs = list
      .filter(it => it.type === 'flight' || it.type === 'transport')
      .map(it => ({
        it,
        arrival: parseTravelArrival(it.title),
        time: it.endDate ? (it.endDate === date ? (it.endTime || '') : null)
          : (it.startDate === date ? (it.endTime || it.startTime || '') : null),
      }))
      .filter(l => l.arrival && l.time);
    if (!legs.length) return null;
    const last = legs.sort((a, b) => (a.time < b.time ? -1 : 1))[legs.length - 1];
    const blocked = list.some(it => !isStay(it) && it.type !== 'flight' && it.type !== 'transport'
      && it.startDate === date && it.startTime && it.startTime < last.time
      && !!(String(it.location || '').trim() || String(it.mapsQuery || '').trim()));
    // `time` rides along so a caller asking about a specific HOUR can tell
    // "before you land" from "after you land" (proposalOrigin needs exactly
    // that to stop measuring an evening drink from the airport).
    return blocked ? null : { item: last.it, time: last.time, ...last.arrival };
  }

  // Items that start on this date, in the order they happen.
  function dayItemsInOrder(items, date) {
    return (items || [])
      .filter(it => it.startDate === date && it.status !== 'cancelled' && !isStay(it))
      .sort(bySortKey);
  }

  // "Where am I on the MORNING of this day", in precedence order:
  //   stay -> the bed you woke up in
  //   travel-origin -> the departure city of the day's first travel leg
  //   location -> the first located item of the day
  // isResolved is injected (app.js passes a cache-only geocode probe) so a
  // title like "Return to hotel" or "Travel to Shibuya" cannot pass "Return" or
  // "Travel" off as a city: the chip's name also keys the weather lookup, so an
  // unresolvable string would print a temperature for the wrong place.
  function dayMorningCity(items, date, isResolved) {
    const host = dayHostStay(items, date);
    if (host) return { city: host.location.trim(), source: 'stay' };
    const ordered = dayItemsInOrder(items, date);
    const travel = ordered.find(it => it.type === 'flight' || it.type === 'transport');
    if (travel) {
      const origin = parseTravelOrigin(travel.title);
      if (origin && (!isResolved || isResolved(origin))) return { city: origin, source: 'travel-origin' };
    }
    const located = ordered.find(it => (it.location || '').trim());
    if (located) return { city: located.location.trim(), source: 'location' };
    return { city: '', source: '' };
  }

  // The flight the traveller leaves home on: the first non-cancelled flight of
  // the trip, and the origin half of its "A to B" title. '' when there is no
  // flight or the title is not written that way.
  function departureOrigin(items) {
    const flight = (items || [])
      .filter(it => it.type === 'flight' && it.status !== 'cancelled' && isIsoDate(it.startDate))
      .sort(bySortKey)[0];
    return flight ? parseTravelOrigin(flight.title) : '';
  }

  // A GUESS at the passport, from the one thing the itinerary already knows:
  // people fly out of the country they live in. Domestic first legs count too
  // ("Denver to Miami" still says United States), because the guess is about
  // the origin, not about the trip being international.
  //
  // resolveCountry is injected the same way dayMorningCity takes isResolved:
  // app.js passes a cache-only probe over the SAME geocoder the visa list uses,
  // so this stays pure and never reaches the network. Returns null whenever the
  // guess would be built on nothing (no flight, an unparseable title, an origin
  // the geocoder does not know), and the caller then simply asks, as before.
  // Never a fact and never persisted: visa rules are the highest-stakes thing
  // this app prints, so the UI has to label it as an assumption.
  function suggestedPassport(items, resolveCountry) {
    const origin = departureOrigin(items);
    if (!origin) return null;
    const cc = String((resolveCountry && resolveCountry(origin)) || '').toUpperCase();
    return /^[A-Z]{2}$/.test(cc) ? { cc, origin } : null;
  }

  // The pieces of the assumption line, as LABEL + VALUE rather than a sentence.
  // English articles follow pronunciation, not spelling ("a United States
  // passport", "a Uruguay passport"), and no rule over the country name gets
  // every entry in the dataset right, so the wording avoids needing one: the
  // country sits after a colon, where no article and no leading "the" belongs.
  // The label still says "Assumed" and the source still names the flight it was
  // read off, because a guess about visas must never read as a fact.
  function passportAssumptionParts(country, origin) {
    const value = String(country == null ? '' : country).trim();
    const from = String(origin == null ? '' : origin).trim();
    const label = 'Assumed passport';
    const source = from ? `from your flight out of ${from}` : 'from your itinerary';
    // Parenthesised source: it stays readable both inline on a wide dialog and
    // wrapped onto its own line on a phone.
    return { label, value, source, text: `${label}:${value ? ' ' + value : ''} (${source})` };
  }

  function dayCards(trip) {
    const stats = tripStats(trip);
    if (!isIsoDate(stats.start) || !isIsoDate(stats.end)) return [];
    // renderEnd, not end: a mistyped year must not ask for three million tiles.
    // totalDays follows it so a tile never reads "Day 1 of 2913220".
    const last = stats.renderEnd;
    const totalDays = diffDays(stats.start, last) + 1;
    const items = trip.items || [];
    const cards = [];
    for (let d = stats.start, i = 0; d <= last; d = addDays(d, 1), i++) {
      const events = [];
      const untimed = [];
      for (const it of items) {
        if (isStay(it)) {
          if (it.startDate === d) events.push({ kind: 'checkin', item: it, time: '', sortTime: ASSUMED_CHECKIN_TIME });
          if (isIsoDate(it.endDate) && it.endDate === d) events.push({ kind: 'checkout', item: it, time: '', sortTime: ASSUMED_CHECKOUT_TIME });
        } else if (it.startDate === d) {
          const t = it.startTime || '';
          (t ? events : untimed).push({ kind: 'item', item: it, time: t, sortTime: t });
        }
      }
      events.sort((a, b) => eventSortKey(a) < eventSortKey(b) ? -1 : 1);
      untimed.sort((a, b) => eventSortKey(a) < eventSortKey(b) ? -1 : 1);
      const host = dayHostStay(items, d);
      let stayingAt = null;
      if (!events.length && !untimed.length) {
        const interior = items.find(it => isStay(it) && it.status !== 'cancelled' && (it.location || '').trim()
          && isIsoDate(it.startDate) && isIsoDate(it.endDate) && it.startDate < d && d < it.endDate);
        if (interior) stayingAt = interior.location.trim();
      }
      cards.push({
        date: d, dayNumber: i + 1, totalDays, events, untimed, stayingAt,
        city: host ? host.location.trim() : '',
        hostStayId: host ? host.id : null,
        empty: !events.length && !untimed.length && !stayingAt,
      });
    }
    return cards;
  }

  // ---------- timeline hierarchy (stay -> day -> activity) ----------
  // The SPINE is how you move between places: flights, stays and
  // between-cities transport. Everything that happens WHILE you are somewhere
  // (activities, notes, and local hops inside one city) nests under the stay
  // that covers it, so a two-week trip reads as a handful of legs instead of a
  // hundred rows.
  const NESTABLE_TYPES = { activity: 1, note: 1, local: 1 };

  // Which stay an item happens "inside". Interior days are unambiguous; a
  // changeover day (one stay checks out, the next checks in) is split at the
  // SAME assumed check-out time the day tiles already sort by, so an 08:00
  // breakfast stays with the hotel you woke up in and everything the tile draws
  // below the check-out row moves to the new one. Untimed items sort below
  // every timed one, so they land with the incoming stay, which is also the bed
  // dayHostStay picks for that date.
  function coveringStay(stays, it) {
    const d = it.startDate;
    if (!isIsoDate(d)) return null;
    const candidates = stays.filter(s => s.startDate <= d && d <= s.endDate);
    if (!candidates.length) return null;
    const interior = candidates.find(s => s.startDate < d && d < s.endDate);
    if (interior) return interior;
    const leaving = candidates.find(s => s.endDate === d);
    const arriving = candidates.find(s => s.startDate === d && s.endDate !== d);
    if (leaving && arriving) {
      return (it.startTime && it.startTime < ASSUMED_CHECKOUT_TIME) ? leaving : arriving;
    }
    return leaving || arriving || candidates[0];
  }

  // `items` is expected in sortedItems order; the spine keeps that order and
  // each stay keeps its own place in it. Nested items are grouped by date so
  // the view can offer stay -> day -> activity. Items with no covering stay
  // (a coverage gap, a flight-only first day) stay on the spine rather than
  // vanishing into a collapsed node.
  function timelineGroups(items) {
    const list = items || [];
    const stays = list.filter(it => isStay(it) && it.status !== 'cancelled'
      && isIsoDate(it.startDate) && isIsoDate(it.endDate) && diffDays(it.startDate, it.endDate) > 0);
    const nodes = [];
    const byStay = new Map();
    for (const it of list) {
      if (NESTABLE_TYPES[it.type]) {
        const host = coveringStay(stays, it);
        if (host) {
          if (!byStay.has(host.id)) byStay.set(host.id, []);
          byStay.get(host.id).push(it);
          continue;
        }
      }
      nodes.push({ kind: isStay(it) ? 'stay' : 'item', item: it, days: [], count: 0 });
    }
    for (const node of nodes) {
      if (node.kind !== 'stay') continue;
      const kids = byStay.get(node.item.id) || [];
      const days = [];
      for (const kid of kids) {
        let day = days.find(d => d.date === kid.startDate);
        if (!day) { day = { date: kid.startDate, items: [] }; days.push(day); }
        day.items.push(kid);
      }
      days.sort((a, b) => a.date < b.date ? -1 : 1);
      node.days = days;
      node.count = kids.length;
    }
    return nodes;
  }

  // ---------- the day picker's dropdown ----------
  // Which day the picker lands on when the panel opens: today while the trip is
  // running, otherwise the next day that has not happened yet, and a finished
  // trip falls back to its last day. `dates` is expected in ascending order,
  // which is how dayCards builds them.
  function defaultPlanDay(dates, today) {
    const list = (dates || []).filter(isIsoDate);
    if (!list.length) return '';
    if (!isIsoDate(today)) return list[0];
    if (list.includes(today)) return today;
    return list.find(d => d > today) || list[list.length - 1];
  }

  // Past / Today / Upcoming buckets for the <optgroup>s. Empty buckets are
  // dropped, and a single surviving bucket loses its label: a trip that is
  // entirely in the future would otherwise show one pointless "Upcoming"
  // heading over every option.
  function planDayGroups(dates, today) {
    const list = (dates || []).filter(isIsoDate);
    const t = isIsoDate(today) ? today : '';
    const buckets = [
      { label: 'Past', days: t ? list.filter(d => d < t) : [] },
      { label: 'Today', days: t ? list.filter(d => d === t) : [] },
      { label: 'Upcoming', days: t ? list.filter(d => d > t) : list.slice() },
    ].filter(g => g.days.length);
    if (buckets.length === 1) buckets[0].label = '';
    return buckets;
  }

  // ---------- typical weather (climate) ----------
  // Cache key for one (place, month) climate lookup. Month is a 1-12 number.
  // Selects the entries of a daily archive response that fall in one month,
  // across however many years the range covered, and applies the same selection
  // to every parallel series. Pure so the "typically" claim has a test: it used
  // to be one year's readings presented as a normal.
  function pickMonthSamples(times, mm, series) {
    const idx = [];
    const want = String(mm).padStart(2, '0');
    for (let i = 0; i < times.length; i++) {
      if (String(times[i] || '').slice(5, 7) === want) idx.push(i);
    }
    return series.map(arr => (Array.isArray(arr) ? idx.map(i => arr[i]) : []));
  }

  function weatherKey(placeKey, month) {
    const p = String(placeKey == null ? '' : placeKey).trim().toLowerCase();
    const m = String(month).padStart(2, '0');
    return `${p}|${m}`;
  }

  // Averages daily min/max into rounded lo/hi and decides "wet" from the share
  // of rainy days (>=1mm). Non-numeric samples (API nulls) are dropped.
  function summarizeClimate(mins, maxs, precip) {
    // Number(null) is 0, not NaN, so drop nulls/blanks BEFORE coercing or the
    // API's missing-day nulls would drag the average toward zero.
    const clean = arr => (arr || []).filter(v => v != null && v !== '').map(Number).filter(v => !Number.isNaN(v));
    const avg = arr => {
      const nums = clean(arr);
      return nums.length ? nums.reduce((s, v) => s + v, 0) / nums.length : null;
    };
    const loA = avg(mins), hiA = avg(maxs);
    let wet = false;
    if (precip) {
      const nums = clean(precip);
      if (nums.length) wet = nums.filter(v => v >= 1).length / nums.length >= 0.3;
    }
    return { lo: loA === null ? null : Math.round(loA), hi: hiA === null ? null : Math.round(hiA), wet };
  }

  // A hyphen between two sub-zero numbers reads as "-12--7", so a below-zero
  // span spells the join out instead.
  const tempSpan = (lo, hi) => (lo < 0 || hi < 0) ? `${lo} to ${hi}°C` : `${lo}-${hi}°C`;

  // Human line for a day card. Deliberately says "Typically ... this time of
  // year" (climate, not a forecast) and never promises what the weather will be.
  function weatherLine(place, summary) {
    if (!summary || summary.lo == null || summary.hi == null) return '';
    return `Typically ${tempSpan(summary.lo, summary.hi)} in ${place} this time of year` +
      (summary.wet ? ', often rainy' : '');
  }

  // The bare range for the day-card chip. The chip has no room for the honest
  // wording, so whatever renders this MUST carry weatherLine (typical, not a
  // forecast) in the title/tooltip.
  function weatherRange(summary) {
    if (!summary || summary.lo == null || summary.hi == null) return '';
    return tempSpan(summary.lo, summary.hi);
  }

  // ---------- near-term forecast ----------
  // Open-Meteo's free, keyless forecast reaches 16 days out, counting today.
  // A trip day past that horizon has no forecast to show and keeps the climate
  // figure above, which is the honest answer for a date that far out anyway.
  const FORECAST_DAYS = 16;
  // A forecast is worthless within hours, so a cached one expires; the climate
  // cache has no such limit because a 5-year average of a past month is fixed.
  const FORECAST_TTL_MS = 3 * 60 * 60 * 1000;

  function forecastEligible(date, today) {
    if (!isIsoDate(date) || !isIsoDate(today)) return false;
    const d = diffDays(today, date);
    return d >= 0 && d < FORECAST_DAYS;
  }

  // Per place+DATE, unlike weatherKey's place+month: a forecast describes one
  // day, so sharing the climate key would let Tuesday's forecast answer for
  // every day of the month.
  function forecastKey(placeKey, date) {
    const p = String(placeKey == null ? '' : placeKey).trim().toLowerCase();
    return `${p}|${String(date == null ? '' : date)}`;
  }

  function forecastFresh(rec, now) {
    if (!rec || typeof rec.at !== 'number') return false;
    const age = now - rec.at;
    return age >= 0 && age < FORECAST_TTL_MS;
  }

  // Drops every expired entry from a persisted forecast store. Applied on load
  // so yesterday's numbers can never paint a chip labelled "Forecast".
  function freshForecasts(cache, now) {
    const out = {};
    if (!cache || typeof cache !== 'object') return out;
    for (const key of Object.keys(cache)) {
      if (forecastFresh(cache[key], now)) out[key] = cache[key];
    }
    return out;
  }

  // One Open-Meteo forecast `daily` block -> { [date]: { lo, hi, pop, code, rh } }.
  // One response covers a whole run of days for one place, so a single request
  // fills as many per-date cache entries as the trip has near-term days.
  // A day missing either temperature is dropped rather than half-reported;
  // the condition code and the humidity are optional and land as null.
  //
  // `relative_humidity_2m_mean` is a DAILY variable the forecast endpoint
  // serves directly (verified against api.open-meteo.com), so the humidity
  // costs nothing beyond one more name in the same `daily=` list: no hourly
  // block to download and average on the client.
  function summarizeForecast(daily) {
    const out = {};
    const times = (daily && Array.isArray(daily.time)) ? daily.time : [];
    const mins = (daily && daily.temperature_2m_min) || [];
    const maxs = (daily && daily.temperature_2m_max) || [];
    const pops = (daily && daily.precipitation_probability_max) || [];
    const codes = (daily && daily.weather_code) || [];
    const hums = (daily && daily.relative_humidity_2m_mean) || [];
    const num = v => {
      if (v == null || v === '') return null;
      const n = Number(v);
      return Number.isNaN(n) ? null : n;
    };
    for (let i = 0; i < times.length; i++) {
      const date = times[i];
      if (!isIsoDate(date)) continue;
      const lo = num(mins[i]), hi = num(maxs[i]);
      if (lo == null || hi == null) continue;
      const pop = num(pops[i]);
      const code = num(codes[i]);
      const rh = num(hums[i]);
      out[date] = {
        lo: Math.round(lo), hi: Math.round(hi),
        pop: pop == null ? null : Math.round(pop),
        code: code == null ? null : Math.round(code),
        rh: rh == null ? null : Math.round(rh),
      };
    }
    return out;
  }

  // ---------- forecast conditions (WMO weather codes) ----------
  // Open-Meteo answers with WMO code 4677, whose 100 values collapse into the
  // seven a traveller actually acts on. The word is what the tooltip says out
  // loud; the glyph alone would be a picture with no text equivalent.
  const FORECAST_CONDITIONS = {
    clear: { icon: '☀️', word: 'clear' },
    partly: { icon: '🌤️', word: 'partly cloudy' },
    cloudy: { icon: '☁️', word: 'overcast' },
    fog: { icon: '🌫️', word: 'fog' },
    rain: { icon: '🌧️', word: 'rain' },
    snow: { icon: '🌨️', word: 'snow' },
    thunder: { icon: '⛈️', word: 'thunderstorms' },
  };

  function forecastConditionKey(code) {
    if (code == null || Number.isNaN(Number(code))) return '';
    const c = Math.round(Number(code));
    if (c === 0) return 'clear';
    if (c === 1 || c === 2) return 'partly';
    if (c === 3) return 'cloudy';
    if (c === 45 || c === 48) return 'fog';
    if (c >= 51 && c <= 67) return 'rain';       // drizzle and rain, freezing included
    if (c >= 71 && c <= 77) return 'snow';       // snowfall and snow grains
    if (c >= 80 && c <= 82) return 'rain';       // rain showers
    if (c === 85 || c === 86) return 'snow';     // snow showers
    if (c >= 95 && c <= 99) return 'thunder';
    return '';
  }

  // The icon for a cached forecast record. The code is the answer whenever the
  // API sent one; without it (an old entry, a response missing the field) the
  // condition is derived from what the record DOES carry, and a record carrying
  // nothing to derive from gets no icon at all rather than a made-up sun.
  function forecastCondition(rec) {
    if (!rec) return null;
    const key = forecastConditionKey(rec.code);
    if (key) return { key, ...FORECAST_CONDITIONS[key] };
    if (rec.pop == null) return null;
    if (rec.pop >= 50) {
      const cold = rec.hi != null && rec.hi <= 1;
      return { key: cold ? 'snow' : 'rain', ...FORECAST_CONDITIONS[cold ? 'snow' : 'rain'] };
    }
    if (rec.pop > 0) return { key: 'partly', ...FORECAST_CONDITIONS.partly };
    return { key: 'clear', ...FORECAST_CONDITIONS.clear };
  }

  // What the chip itself prints, as separate pieces so the markup can mark each
  // one up (and tooltip each one) on its own. Rain is only worth a figure when
  // there is a chance of it: "0%" is noise on a chip this small, and the
  // tooltip still states it. Humidity is absent, not blank, when unknown.
  function forecastChipParts(rec) {
    if (!rec || rec.lo == null || rec.hi == null) return null;
    const cond = forecastCondition(rec);
    return {
      icon: cond ? cond.icon : '',
      condition: cond ? cond.word : '',
      temp: tempSpan(rec.lo, rec.hi),
      rain: (rec.pop != null && rec.pop > 0) ? `${rec.pop}%` : '',
      humidity: rec.rh == null ? '' : `${rec.rh}%`,
    };
  }

  // The forecast twin of weatherLine. Says "Forecast", never "Typically", so a
  // chip carrying a real forecast can never be read as the climate caveat, and
  // spells the chip's glyph and its two percentages out in words: on the chip
  // they are an icon and two figures, and only this sentence says which is
  // which.
  function forecastLine(place, rec) {
    if (!rec || rec.lo == null || rec.hi == null) return '';
    const cond = forecastCondition(rec);
    return `Forecast ${tempSpan(rec.lo, rec.hi)} in ${place}` +
      (cond ? `, ${cond.word}` : '') +
      (rec.pop == null ? '' : `, ${rec.pop}% chance of rain`) +
      (rec.rh == null ? '' : `, ${rec.rh}% average humidity`);
  }

  // ---------- documents pocket guards ----------
  const MAX_DOC_BYTES = 2 * 1024 * 1024;
  const MAX_DOCS_PER_ITEM = 10;
  function docGuard(existingCount, fileSize) {
    if (existingCount >= MAX_DOCS_PER_ITEM) return { ok: false, reason: 'count' };
    if (fileSize > MAX_DOC_BYTES) return { ok: false, reason: 'size' };
    return { ok: true };
  }

  // Parses the passport-index iso2 matrix CSV (header: Passport,AL,DZ,...)
  // into { codes, matrix } where matrix[passport][destination] = raw value.
  function parseVisaMatrix(csv) {
    const lines = String(csv || '').trim().split(/\r?\n/);
    if (lines.length < 2) return null;
    const header = lines[0].split(',').map(s => s.trim());
    const dests = header.slice(1);
    const matrix = {};
    for (let i = 1; i < lines.length; i++) {
      const cells = lines[i].split(',');
      const p = (cells[0] || '').trim().toUpperCase();
      if (!/^[A-Z]{2}$/.test(p)) continue;
      const row = {};
      for (let j = 0; j < dests.length; j++) row[dests[j]] = (cells[j + 1] || '').trim();
      matrix[p] = row;
    }
    const codes = Object.keys(matrix);
    return codes.length ? { codes, matrix } : null;
  }

  // ---------- view <-> URL fragment ----------
  // The fragment is shared real estate: share links park an entire compressed
  // trip in it as "#share=...". Parsing lives here so the guard that keeps the
  // view code away from a share payload is unit-testable without a DOM.
  const VIEWS = ['timeline', 'days', 'map'];

  // Returns { view, isShare }. isShare means "the caller owns nothing here":
  // never write the fragment while it is set. The share sniff is deliberately
  // case-insensitive so anything that even looks like a payload is left alone,
  // and boot decides on THIS same reader: when boot matched the exact generated
  // prefix instead, a retyped "#SHARE=..." loaded normally and then had its
  // payload pinned in the URL by the writer's looser guard, doing nothing.
  // View names are matched case-insensitively after trimming, and must match
  // the whole fragment: "#daysofourlives" is not the days view.
  function viewFromHash(hash, fallback) {
    const fb = VIEWS.indexOf(fallback) >= 0 ? fallback : 'timeline';
    const raw = String(hash == null ? '' : hash).replace(/^#/, '');
    if (/^share=/i.test(raw)) return { view: fb, isShare: true };
    const name = raw.trim().toLowerCase();
    return { view: VIEWS.indexOf(name) >= 0 ? name : fb, isShare: false };
  }

  // Inverse. Timeline is the default view, so it gets a clean fragment-less
  // URL rather than "#timeline" (which still parses back to timeline).
  function hashForView(view) {
    return view === 'days' || view === 'map' ? '#' + view : '';
  }

  // Share links carry the whole trip inside the URL, so every byte counts.
  // Strip empty fields, timestamps and long ids before compressing; the
  // import sanitizer tolerates all of these being absent.
  function slimTripForShare(trip) {
    const keep = v => !(v == null || v === '');
    const slim = { name: trip.name, currency: trip.currency, items: [] };
    if (trip.budget != null) slim.budget = trip.budget;
    // the floor rides along only when there is a ceiling for it to sit under,
    // which is the same rule the import sanitizer applies on the far side. A
    // trip with a plain ceiling produces byte for byte the payload it always did
    if (trip.budget != null && trip.budgetFrom != null) slim.budgetFrom = trip.budgetFrom;
    if (Array.isArray(trip.visaExtras) && trip.visaExtras.length) slim.visaExtras = trip.visaExtras;
    // travellers ride along: the person you share a trip with IS the other
    // traveller on it, so a copy that quietly lost the cost split would be worse
    // than no copy. normalizeTravelers runs again on the far side (import), so a
    // hand-edited link can never inject more than six or a junk name.
    if (Array.isArray(trip.travelers) && trip.travelers.length) slim.travelers = normalizeTravelers(trip.travelers);
    slim.items = trip.items.map((it, i) => {
      const out = { id: 'i' + (i + 1) };
      // mapsQuery rides along because this is also the trip JSON the assistant
      // sees: without it the model cannot tell an item already has a verified
      // place attached and re-suggests the same venue.
      // estCost rides along so a shared itinerary still shows what to expect;
      // it stays out of every total on the far side exactly as it does here.
      // confirmation rides along for the same reason `details` always has: the
      // person you share a trip with is the person travelling on it, and a copy
      // that quietly lost every booking code would be worse than no copy. It is
      // no more exposed than a code typed into the details box already was.
      // bookBy and payment ride the same list, and so pay the same way: both are
      // empty on almost every item, `keep` drops them there, and a trip that
      // never used either produces byte-for-byte the payload it did before.
      // `order` rides along for the same reason the rest do: a hand-set
      // same-day order is a decision the traveller made, and a copy that
      // silently reshuffled the day would be worse than no copy. It is only
      // present on a day somebody actually reordered, so a link from a trip
      // nobody has dragged is byte-for-byte what it was.
      for (const k of ['type', 'title', 'location', 'startDate', 'endDate', 'startTime', 'endTime', 'status', 'cost', 'costCurrency', 'estCost', 'estCostCurrency', 'costNote', 'confirmation', 'bookBy', 'payment', 'details', 'mapsQuery', 'order']) {
        if (keep(it[k])) out[k] = it[k];
      }
      // who owes this cost travels with the item; the far side clamps it to the
      // shared traveller list, so an empty or all-hands assignment stays absent
      if (Array.isArray(it.travelers) && it.travelers.length) out.travelers = it.travelers;
      // and so does a hand-entered split: dropping it would leave the far side
      // showing an EVEN divide of the same cost, i.e. a confidently wrong answer
      // to "who owes whom", which is worse than not sharing the split at all.
      // customSplitShares re-checks it there, so a stale copy still falls back.
      if (it.splitAmounts && typeof it.splitAmounts === 'object' && Object.keys(it.splitAmounts).length) {
        out.splitAmounts = it.splitAmounts;
      }
      // and so does who actually paid it: a shared trip that kept the split but
      // lost the payer answers "what did it cost us" and not "who owes whom",
      // which is the half of the settle-up block worth sharing
      if (keep(it.paidBy)) out.paidBy = it.paidBy;
      return out;
    });
    return slim;
  }

  // ---------- assistant: parse the AI reply ----------
  // The model is asked to emit machine-readable edits as a JSON object
  // {"tripActions":[...]} either inside a ```json fence or bare amid prose.
  // extractTripActions pulls every such block out (in order) and returns the
  // remaining human-readable prose as cleanedText. Malformed or truncated
  // blocks are left untouched in the prose and never throw.
  const ASSIST_ACTION_TYPES = new Set(['flight', 'transport', 'local', 'activity', 'stay', 'note']);

  function tryParseActions(chunk) {
    try {
      const obj = JSON.parse(String(chunk).trim());
      if (obj && typeof obj === 'object' && Array.isArray(obj.tripActions)) return obj.tripActions;
    } catch { /* malformed / truncated: skip, leave in prose */ }
    return null;
  }

  // Index of the matching '}' for the '{' at openIdx, respecting strings and
  // escapes. Returns -1 when the object is truncated (never throws).
  function matchBrace(str, openIdx) {
    let depth = 0, inStr = false, esc = false;
    for (let i = openIdx; i < str.length; i++) {
      const c = str[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) return i; }
    }
    return -1;
  }

  function extractTripActions(text) {
    const src = String(text == null ? '' : text);
    const spans = []; // {start, end, actions}

    // 1) fenced code blocks: ```json ... ``` (the language tag is optional)
    const fence = /```(?:json)?[ \t]*\r?\n?([\s\S]*?)```/g;
    let m;
    while ((m = fence.exec(src)) !== null) {
      const actions = tryParseActions(m[1]);
      if (actions) spans.push({ start: m.index, end: m.index + m[0].length, actions });
    }

    // 2) bare {"tripActions":[...]} objects sitting in prose, skipping any that
    // fall inside a fenced span already captured above
    const bare = /\{\s*"tripActions"\s*:/g;
    while ((m = bare.exec(src)) !== null) {
      if (spans.some(s => m.index >= s.start && m.index < s.end)) continue;
      const end = matchBrace(src, m.index);
      if (end < 0) continue; // truncated object: leave it in the prose
      const actions = tryParseActions(src.slice(m.index, end + 1));
      if (actions) spans.push({ start: m.index, end: end + 1, actions });
    }

    if (!spans.length) return { actions: [], cleanedText: src };

    spans.sort((a, b) => a.start - b.start);
    const actions = [];
    let cleaned = '', cursor = 0;
    for (const s of spans) {
      if (s.start < cursor) continue; // overlap guard
      cleaned += src.slice(cursor, s.start);
      for (const a of s.actions) actions.push(a);
      cursor = s.end;
    }
    cleaned += src.slice(cursor);
    return { actions, cleanedText: cleaned.replace(/\n{3,}/g, '\n\n').trim() };
  }

  // ---------- assistant: "plan my day" request builder ----------
  // Turns the day-picker's preferences into the traveller-facing prose that is
  // sent as the chat message. Kept pure (and out of app.js) so the exact wording
  // the model receives is unit-testable.
  const PLAN_BUDGETS = { 1: 'budget-friendly', 2: 'mid-range', 3: 'upscale', 4: 'splurge-worthy' };
  const PLAN_MAX_CHARS = 900;
  // Enough context for the model, short enough that the repeat list can never
  // crowd out the actual request.
  const PLAN_MAX_REPEAT_TITLES = 8;

  // "top of a range" -> the range itself: 3 => "2-3". 0 means the slot is off.
  const planRange = n => (Number(n) > 1 ? `${Number(n) - 1}-${Number(n)}` : '');

  function fmt12h(t) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(t == null ? '' : t).trim());
    if (!m) return '';
    const h24 = Number(m[1]);
    const suffix = h24 < 12 ? 'AM' : 'PM';
    return `${h24 % 12 || 12}:${m[2]} ${suffix}`;
  }

  const joinWords = (list, last) => (list.length > 1
    ? `${list.slice(0, -1).join(', ')} ${last} ${list[list.length - 1]}`
    : (list[0] || ''));

  const stylePhrase = list => (Array.isArray(list) ? list.filter(s => s && String(s).trim()).map(s => String(s).trim()) : []).join(' or ');

  // Titles the model should not suggest again. Meals and drinks live on the
  // trip as `activity` items too, so anything already planned counts.
  function plannedActivityTitles(trip) {
    const items = (trip && Array.isArray(trip.items)) ? trip.items : [];
    const seen = new Set();
    const out = [];
    for (const it of items) {
      if (!it || it.type !== 'activity' || it.status === 'cancelled') continue;
      const title = String(it.title == null ? '' : it.title).trim();
      if (!title || seen.has(title.toLowerCase())) continue;
      seen.add(title.toLowerCase());
      out.push(title);
    }
    return out;
  }

  function buildPlanRequest(prefs, trip) {
    const p = prefs || {};
    const meals = p.meals || {};
    const styles = p.styles || {};
    const mealNames = ['breakfast', 'lunch', 'dinner'].filter(k => meals[k] !== false);
    // The picker sends an ARRAY of tiers now: several tiers are a range the
    // model may span ("mid-range or upscale"), and an EMPTY array is the
    // traveller declining to talk about money at all, so the request then says
    // nothing about it. A bare number (or anything else legacy) keeps the old
    // behaviour exactly: that one tier, or mid-range when unrecognisable.
    const budgetSel = Array.isArray(p.budget)
      ? [...new Set(p.budget.map(Number).filter(n => PLAN_BUDGETS[n]))].sort((a, b) => a - b)
      : [PLAN_BUDGETS[p.budget] ? Number(p.budget) : 2];
    const wake = fmt12h(p.wakeTime || '08:00') || fmt12h('08:00');
    const back = fmt12h(p.returnTime || '22:00') || fmt12h('22:00');
    const activities = planRange(p.activities === undefined ? 3 : p.activities);
    const drinks = planRange(p.drinks || 0);

    const lines = [];
    lines.push(`Plan my day for ${isIsoDate(p.date) ? p.date : 'this day'}.`);
    // The time is an ARRIVAL contract, not a wake-up alarm: the traveller
    // wants the first planned place to start at this time, with the travel to
    // it happening before. "Ready to head out at 8:00" read as permission to
    // schedule breakfast AT 8:00, which nobody leaving a hotel at 8:00 can
    // make.
    lines.push(`I want to be at my first planned stop at ${wake}, with any travel to it before that time, and want to be back at my hotel by ${back}.`);

    if (activities) {
      const s = stylePhrase(styles.activities);
      lines.push(`I would like ${activities} activities${s ? `, leaning ${s}` : ''}, and give me 2 options for each one.`);
    }
    if (mealNames.length) {
      const s = stylePhrase(styles.meals);
      lines.push(`Plan ${joinWords(mealNames, 'and')}${s ? `, leaning ${s}` : ''}, and give me 3 options for each one.`);
    }
    if (drinks) {
      const s = stylePhrase(styles.drinks);
      lines.push(`Include ${drinks} ${s ? `${s} drinks` : 'drinks'} stops, and give me 3 options for each one.`);
    }
    // Silence reads as permission: with no exclusion the model fills a "plan my
    // day" request with the slots the traveller switched off. Skipped types are
    // named one by one, because a vague "nothing else" gets read as "nothing
    // else of this kind".
    const on = [];
    const off = [];
    (activities ? on : off).push('activities');
    for (const m of ['breakfast', 'lunch', 'dinner']) (meals[m] === false ? off : on).push(m);
    (drinks ? on : off).push('drinks');
    if (off.length) {
      const only = on.length ? `Only plan ${joinWords(on, 'and')}. ` : '';
      lines.push(`${only}Do not suggest ${joinWords(off, 'or')}.`);
    }

    if (budgetSel.length) {
      lines.push(`Keep the whole day ${joinWords(budgetSel.map(n => PLAN_BUDGETS[n]), 'or')}.`);
    }

    // Only worth saying when there is something to name: a bare "do not repeat"
    // with an empty list reads like a bug and wastes prompt space.
    const repeats = p.repeatOk ? [] : plannedActivityTitles(trip).slice(0, PLAN_MAX_REPEAT_TITLES);
    if (repeats.length) lines.push(`Do not repeat anything already on my plan: ${repeats.join(', ')}.`);

    const note = String(p.note == null ? '' : p.note).trim();
    if (note) lines.push(`Also: ${note}`);

    let out = lines.join('\n');
    // Drop repeat titles one by one before resorting to a hard cut, so the note
    // and the actual request survive a long existing itinerary.
    while (out.length > PLAN_MAX_CHARS && repeats.length) {
      repeats.pop();
      const idx = lines.findIndex(l => l.startsWith('Do not repeat'));
      if (repeats.length) lines[idx] = `Do not repeat anything already on my plan: ${repeats.join(', ')}.`;
      else lines.splice(idx, 1);
      out = lines.join('\n');
    }
    return out.length > PLAN_MAX_CHARS ? out.slice(0, PLAN_MAX_CHARS) : out;
  }

  // ---------- assistant: alternative sets ----------
  // Meal and drinks proposals arrive as 3 candidates sharing one `group` id, and
  // every other activity as 2, so the UI can offer a single choice instead of
  // stacking three dinners or two museums. Anything ungrouped (or alone in its
  // group) stays a plain single card, which is what transport, local hops,
  // stays and notes always are.
  function groupProposals(proposals) {
    const list = Array.isArray(proposals) ? proposals : [];
    const counts = new Map();
    for (const p of list) {
      const g = p && typeof p.group === 'string' ? p.group.trim() : '';
      if (g) counts.set(g, (counts.get(g) || 0) + 1);
    }
    const entries = [];
    const setIndex = new Map();
    for (const p of list) {
      const g = p && typeof p.group === 'string' ? p.group.trim() : '';
      if (!g || counts.get(g) < 2) { entries.push({ type: 'single', proposal: p }); continue; }
      if (!setIndex.has(g)) {
        const entry = { type: 'set', group: g, candidates: [] };
        setIndex.set(g, entry);
        entries.push(entry);
      }
      setIndex.get(g).candidates.push(p);
    }
    return entries;
  }

  // ---------- assistant: Google Places rating lookups ----------
  // Every miss is a billed lookup (cents per venue), so the client must never
  // ask twice for the same venue in a session. These helpers own the dedup
  // rules; the app layer only owns the cache Map and the fetch.
  //
  // The key is the normalized query lowercased: the assistant writes the same
  // venue with drifting case/spacing across cards, and Places text search is
  // case-insensitive anyway. The QUERY that goes on the wire is the normalized
  // (case-preserved) form, and the server echoes it back verbatim, so the
  // response maps home by re-keying `result.query`.
  const PLACES_BATCH_MAX = 12;
  function normalizePlaceQuery(q) {
    return String(q == null ? '' : q).replace(/\s+/g, ' ').trim().slice(0, 200).trim();
  }
  const placeCacheKey = q => normalizePlaceQuery(q).toLowerCase();

  // `known` is anything with .has(key): the live cache plus the in-flight set.
  // Returns the wire batches, each already under the server's cap of 12 (the
  // server silently DROPS queries past the cap, so overflow must batch here).
  function planPlacesLookup(queries, known) {
    const seen = known && typeof known.has === 'function' ? known : { has: () => false };
    const local = new Set();
    const misses = [];
    for (const raw of Array.isArray(queries) ? queries : []) {
      const query = normalizePlaceQuery(raw);
      if (!query) continue;
      const key = placeCacheKey(query);
      if (local.has(key) || seen.has(key)) continue;
      local.add(key);
      misses.push({ key, query });
    }
    const batches = [];
    for (let i = 0; i < misses.length; i += PLACES_BATCH_MAX) batches.push(misses.slice(i, i + PLACES_BATCH_MAX));
    return { misses, batches };
  }

  // "no_match" is permanent for a query and gets cached as a tombstone so the
  // venue is never looked up again. "unavailable" is transient (quota, upstream
  // hiccup) and is deliberately NOT cached, so a later card may retry.
  function placesCacheUpdates(results) {
    const out = [];
    for (const r of Array.isArray(results) ? results : []) {
      if (!r || typeof r.query !== 'string') continue;
      const key = placeCacheKey(r.query);
      if (!key) continue;
      // The reason rides along because "generic_query" is the server telling us,
      // for free and before any billing, that this query names no venue at all.
      if (r.status === 'no_match') {
        out.push({ key, entry: { status: 'no_match', reason: typeof r.reason === 'string' ? r.reason : '' } });
        continue;
      }
      if (r.status !== 'ok' || typeof r.rating !== 'number' || !isFinite(r.rating)) continue;
      // mapsUri arrives over the network and lands in an href: only http(s).
      const uri = typeof r.mapsUri === 'string' && /^https?:\/\//i.test(r.mapsUri) ? r.mapsUri : '';
      if (!uri) {
        // The attribution link is mandatory, so a rating we cannot attribute
        // is never shown - but simply dropping the entry made the venue a
        // cache miss on EVERY later batch, re-billing the same lookup for a
        // rating that would be refused again. A tombstone remembers the
        // refusal for the session; the card keeps its plain search link.
        out.push({ key, entry: { status: 'no_match', reason: 'unattributable' } });
        continue;
      }
      const count = Number(r.userRatingCount);
      out.push({
        key,
        entry: {
          status: 'ok',
          name: typeof r.name === 'string' ? r.name : '',
          rating: Math.round(r.rating * 10) / 10,
          userRatingCount: isFinite(count) && count > 0 ? Math.floor(count) : 0,
          mapsUri: uri,
        },
      });
    }
    return out;
  }

  // ---------- the Places lookup queue ----------
  // ONE owner of every billed rating request in the app. It exists because the
  // old shape - "each render hands its whole list to an async fetch loop" - had
  // three measured failure modes, and all three cost the owner real money:
  //
  //   1. A render that landed while a multi-batch lookup was still running
  //      re-planned the batches that had not been SENT yet (only the batch on
  //      the wire was marked in flight). Measured on a 41-venue trip: 7 POSTs,
  //      70 lookups, 29 of them duplicates of a venue already queued.
  //   2. Every rating-eligible item in the WHOLE trip was requested on load,
  //      including the fortieth day of a trip whose first screen the traveller
  //      had not finished reading. A rating nobody looked at costs exactly what
  //      a rating they read costs.
  //   3. A single 429 abandoned every batch behind it and switched the feature
  //      off for an hour, so a partial set of ratings looked permanent.
  //
  // So: a key is reserved the moment it is PLANNED (not when its batch is
  // sent), demand is driven by what is on screen, and a 429 puts its batch back
  // rather than dropping it. Pure and DOM-free - `send`, `now`, `schedule` and
  // `random` are injected - so node:test drives every branch with no browser.
  const PLACES_CONCURRENCY = 2;
  // A key the server could not serve (quota, upstream hiccup) is not cached -
  // it holds no Google content - but it must not be re-asked by the very next
  // re-render either, or a failing venue is a request per repaint. Ten minutes
  // is long enough to outlive a burst of renders and short enough that a
  // traveller who leaves a tab open gets the rating when capacity returns.
  const PLACES_DEFER_MS = 10 * 60000;
  const PLACES_MAX_ATTEMPTS = 3;

  const HOUR = 3600000;   // DAY is already defined at the top of the module

  // How long to stay quiet after a 429, by the scope the server names. The
  // point is to match the bucket that actually refills: the server's hour
  // bucket is floor(now / 3600000), so "wait an hour" from a request made at
  // 10:59 wastes 59 minutes of the 11:00 bucket. Retrying a monthly cap at all
  // is pointless, so that one parks for the session.
  function placesRetryDelay(scope, now, attempt = 1, random = Math.random) {
    const t = Number(now) || 0;
    switch (scope) {
      case 'client_hour': return HOUR - (t % HOUR);
      case 'client_day':
      case 'global_day': return DAY - (t % DAY);
      case 'global_month': {
        const d = new Date(t);
        return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) - t;
      }
      // Contention is the one genuinely transient rejection (many writers on
      // one counter blob), so it backs off in seconds with jitter rather than
      // parking until a bucket rolls over.
      case 'contention': {
        const base = Math.min(8000, 1000 * Math.pow(2, Math.max(0, attempt - 1)));
        return Math.round(base * (0.5 + random() * 0.5));
      }
      default: return 15 * 60000;
    }
  }

  function createPlacesQueue(opts) {
    const o = opts || {};
    const send = o.send;
    const now = o.now || Date.now;
    const schedule = o.schedule || ((fn, ms) => setTimeout(fn, ms));
    const random = o.random || Math.random;
    const onUpdate = o.onUpdate || (() => {});
    const batchMax = o.batchMax || PLACES_BATCH_MAX;
    const concurrency = o.concurrency || PLACES_CONCURRENCY;
    const deferMs = o.deferMs == null ? PLACES_DEFER_MS : o.deferMs;
    const maxAttempts = o.maxAttempts || PLACES_MAX_ATTEMPTS;

    const cache = new Map();      // key -> { status:'ok', ... } | { status:'no_match' }
    const entries = new Map();    // key -> { key, query, priority, gen, attempts }
    const inFlight = new Set();
    const deferred = new Map();   // key -> earliest retry timestamp
    let hi = [], lo = [];         // keys, urgent lane first
    let busy = 0;
    let gen = 0;
    let off = false;              // 503/403/400/405/501: no key configured at all
    let pausedUntil = 0;
    let pauseScope = '';
    let waking = false;
    let stats = { posts: 0, lookups: 0, batches429: 0 };

    const deferredNow = key => {
      const at = deferred.get(key);
      if (at == null) return false;
      if (at > now()) return true;
      deferred.delete(key);
      return false;
    };
    // What planPlacesLookup must treat as "already handled": resolved, on the
    // wire, waiting in the queue, or deliberately parked after a failure. This
    // is the reservation that closes the duplicate-batch hole.
    const known = { has: key => cache.has(key) || entries.has(key) || inFlight.has(key) || deferredNow(key) };

    function wake(ms) {
      if (waking) return;
      waking = true;
      schedule(() => { waking = false; pump(); }, Math.max(0, ms));
    }

    function paused() {
      if (off) return true;
      if (!pausedUntil) return false;
      if (now() < pausedUntil) return true;
      pausedUntil = 0;
      pauseScope = '';
      return false;
    }

    // Visible work first, and within a priority the order it was asked for.
    function take() {
      const batch = [];
      for (const list of [hi, lo]) {
        while (list.length && batch.length < batchMax) {
          const key = list.shift();
          const e = entries.get(key);
          // dropped by a generation change, or resolved by an overlapping batch
          if (!e || cache.has(key)) { entries.delete(key); continue; }
          entries.delete(key);
          inFlight.add(key);
          batch.push(e);
        }
        if (batch.length >= batchMax) break;
      }
      return batch;
    }

    // Put a batch that was never served back where it came from, so a 429 or a
    // dropped connection costs the queue nothing but time. Bounded: a key that
    // has already failed maxAttempts times parks in `deferred` instead, which
    // is what stops a hard failure becoming a retry loop.
    function requeue(batch) {
      for (const e of batch) {
        inFlight.delete(e.key);
        if (cache.has(e.key)) continue;
        e.attempts += 1;
        if (e.attempts >= maxAttempts) { deferred.set(e.key, now() + deferMs); continue; }
        if (e.gen !== gen) continue;
        entries.set(e.key, e);
        (e.priority === 'urgent' ? hi : lo).push(e.key);
      }
    }

    function pump() {
      if (paused()) {
        if (!off && pausedUntil) wake(pausedUntil - now());
        return;
      }
      while (busy < concurrency && (hi.length || lo.length)) {
        const batch = take();
        if (!batch.length) break;
        busy += 1;
        stats.posts += 1;
        Promise.resolve()
          .then(() => send(batch.map(e => e.query)))
          .then(res => settle(batch, res || {}))
          .catch(() => settle(batch, { ok: false, transient: true }))
          .then(() => { busy -= 1; pump(); });
      }
    }

    function settle(batch, res) {
      if (res.ok) {
        for (const e of batch) inFlight.delete(e.key);
        const results = Array.isArray(res.results) ? res.results : [];
        for (const u of placesCacheUpdates(results)) cache.set(u.key, u.entry);
        // `unavailable` holds no Google content and is never cached; it is
        // parked so the next repaint does not re-ask, and becomes eligible
        // again once the defer window passes.
        for (const r of results) {
          if (!r || r.status !== 'unavailable') continue;
          const key = placeCacheKey(r.query);
          if (key && !cache.has(key)) deferred.set(key, now() + deferMs);
        }
        stats.lookups += results.filter(r => r && r.status === 'ok').length;
        onUpdate(results);
        return;
      }
      if (res.off) { off = true; hi = []; lo = []; entries.clear(); for (const e of batch) inFlight.delete(e.key); onUpdate([]); return; }
      if (res.status === 429) stats.batches429 += 1;
      const attempt = Math.max(1, ...batch.map(e => e.attempts + 1));
      const ms = res.retryAfterMs != null
        ? Math.max(0, res.retryAfterMs)
        : placesRetryDelay(res.scope || (res.transient ? 'contention' : ''), now(), attempt, random);
      pausedUntil = Math.max(pausedUntil, now() + ms);
      pauseScope = res.scope || (res.transient ? 'network' : '');
      requeue(batch);
      onUpdate([]);
      wake(ms);
    }

    return {
      // `queries` is raw strings; planPlacesLookup normalizes, drops blanks and
      // collapses same-venue spellings, and `known` reserves every key it
      // returns so nothing here can be planned twice.
      request(queries, options) {
        const opt = options || {};
        // 'urgent' is a comparison the traveller is actively waiting on (an
        // assistant candidate set, a hotel they just picked); 'normal' is an
        // itinerary row that has scrolled into view. Both are on screen - the
        // difference is that a half-resolved candidate set makes its winner
        // badges wrong, while a row without a rating is just a plain link.
        const priority = opt.priority === 'urgent' ? 'urgent' : 'normal';
        const { misses } = planPlacesLookup(queries, known);
        if (!misses.length) return 0;
        for (const m of misses) {
          entries.set(m.key, { key: m.key, query: m.query, priority, gen, attempts: 0 });
          (priority === 'urgent' ? hi : lo).push(m.key);
        }
        pump();
        return misses.length;
      },
      // A venue already queued at normal priority is promoted, not re-added,
      // when something urgent needs it too: same reservation, better place in
      // the line.
      promote(queries) {
        let moved = 0;
        for (const raw of Array.isArray(queries) ? queries : []) {
          const key = placeCacheKey(raw);
          const e = key && entries.get(key);
          if (!e || e.priority === 'urgent') continue;
          e.priority = 'urgent';
          const i = lo.indexOf(key);
          if (i >= 0) lo.splice(i, 1);
          hi.push(key);
          moved += 1;
        }
        if (moved) pump();
        return moved;
      },
      get: key => cache.get(key),
      has: key => cache.has(key),
      // Consumed by the Photon top-up, which must not chase a venue whose
      // billed lookup is already going to answer with a better point.
      isPending: key => entries.has(key) || inFlight.has(key),
      // A trip switch invalidates work that has not been SENT. In-flight
      // batches are already paid for, so they are left to land in the shared
      // cache; only the queue is cleared.
      setGeneration(g) {
        gen = g;
        for (const key of [...entries.keys()]) {
          if (entries.get(key).gen !== gen) entries.delete(key);
        }
        hi = hi.filter(k => entries.has(k));
        lo = lo.filter(k => entries.has(k));
      },
      generation: () => gen,
      pump,
      status: () => ({
        off,
        pausedUntil,
        scope: pauseScope,
        paused: off || (pausedUntil > now()),
        queued: entries.size,
        inFlight: inFlight.size,
        cached: cache.size,
        deferred: deferred.size,
        busy,
        ...stats,
      }),
    };
  }

  // ---------- distances: venue coordinates, day chains, shortest route ----------
  // Every figure here is straight-line haversine math (distKm) over coordinates
  // the app ALREADY holds: the venue cache the Places lookup seeds, the Photon
  // fallback the hotel picker's service answers, and the city-level geocode
  // cache. Nothing in this section reaches the network, and nothing in the app
  // is allowed to look a place up merely to print a distance.

  // Google Maps Platform's Maps Service Specific Terms 14.3 expressly permit
  // caching latitude/longitude, and only for 30 days (the same rule the server
  // side notes in lib/tp-places-lookup.mjs), so a stored venue coordinate
  // expires on that schedule. The cap bounds a long trip's worth of venues; the
  // oldest write goes first, which is also the entry closest to expiring.
  const VENUE_TTL_MS = 30 * 86400000;
  const VENUE_CACHE_MAX = 300;

  // A coordinate pair only counts when BOTH halves are real numbers in range.
  // Number('') is 0, a genuine point in the Gulf of Guinea, so a missing value
  // has to become NaN before it is tested (the same trap normalizePlaceRow hit).
  function validCoord(lat, lon) {
    const a = numOrNaN(lat), b = numOrNaN(lon);
    return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a) <= 90 && Math.abs(b) <= 180;
  }

  function venueFresh(rec, now) {
    if (!rec || typeof rec.at !== 'number' || !validCoord(rec.lat, rec.lon)) return false;
    const age = now - rec.at;
    return age >= 0 && age < VENUE_TTL_MS;
  }

  // Applied when the persisted store is read: malformed and expired entries are
  // dropped rather than served, and only the newest VENUE_CACHE_MAX survive.
  function normalizeVenueCache(cache, now) {
    const out = {};
    if (!cache || typeof cache !== 'object') return out;
    const keys = Object.keys(cache).filter(k => k && venueFresh(cache[k], now));
    keys.sort((a, b) => (cache[b].at - cache[a].at) || (a < b ? -1 : 1));
    for (const k of keys.slice(0, VENUE_CACHE_MAX)) {
      out[k] = { lat: Number(cache[k].lat), lon: Number(cache[k].lon), at: cache[k].at };
    }
    return out;
  }

  // `at` is the last time this venue was written, so the eviction below is
  // least-recently-refreshed first. Mutates and returns the same object: the
  // caller persists it as one blob.
  function rememberVenue(cache, key, coord, now) {
    const k = String(key == null ? '' : key).trim();
    if (!k || !coord || !validCoord(coord.lat, coord.lon)) return cache;
    cache[k] = { lat: Number(coord.lat), lon: Number(coord.lon), at: now };
    const keys = Object.keys(cache);
    if (keys.length > VENUE_CACHE_MAX) {
      keys.sort((a, b) => (cache[a].at - cache[b].at) || (a < b ? -1 : 1));
      for (const old of keys.slice(0, keys.length - VENUE_CACHE_MAX)) delete cache[old];
    }
    return cache;
  }

  // tp-places returns the resolved place's coordinates alongside its rating
  // (`location` is a lower billing tier than `rating`, so the response costs
  // exactly what it did before). Only the coordinates are read here: they are
  // the one part of a Places response the terms allow us to store.
  function placesLocationUpdates(results) {
    const out = [];
    for (const r of Array.isArray(results) ? results : []) {
      if (!r || typeof r.query !== 'string') continue;
      const key = placeCacheKey(r.query);
      if (!key || !validCoord(r.lat, r.lon)) continue;
      out.push({ key, lat: Number(r.lat), lon: Number(r.lon) });
    }
    return out;
  }

  // One Photon feature collection -> the venue's coordinates, or null. Photon
  // answers every query with SOMETHING, so an unchecked top hit would happily
  // pin "Ichiran Shibuya" on a random Shibuya street corner and print a
  // confident distance to it. The name has to account for the query (or the
  // query for the name) before the point is trusted.
  function pickVenueFeature(query, json) {
    const q = foldPlace(query);
    if (!q) return null;
    const head = foldPlace(q.split(',')[0]);
    const feats = (json && Array.isArray(json.features)) ? json.features : [];
    for (const f of feats) {
      const p = (f && f.properties) || null;
      const coords = (f && f.geometry && Array.isArray(f.geometry.coordinates)) ? f.geometry.coordinates : [];
      if (!p || !p.name || !validCoord(coords[1], coords[0])) continue;
      const name = foldPlace(p.name);
      if (!name) continue;
      if (!q.includes(name) && !name.includes(head)) continue;
      return { name: String(p.name).trim(), lat: Number(coords[1]), lon: Number(coords[0]) };
    }
    return null;
  }

  // A point is only usable when it carries real coordinates; everything else
  // (an unlocated row, a proposal whose venue nothing resolved) is skipped
  // rather than guessed at.
  // `query` is the searchable form of the same place (the venue name, or its
  // city). Coordinates cannot build a directions link a human would recognise,
  // so a leg that wants to offer one needs this to ride along with the maths.
  function distancePoint(p) {
    if (!p || !validCoord(p.lat, p.lon)) return null;
    return {
      id: p.id, key: p.key || '', label: p.label || '', query: p.query || '',
      lat: Number(p.lat), lon: Number(p.lon),
    };
  }

  // Two points close enough that a leg between them would be a lie: they came
  // from the same cache entry, or they are the same spot to within 50 m, which
  // is also where the rounding below starts printing "0.0 km".
  const SAME_SPOT_KM = 0.05;
  function sameSpot(a, b) {
    if (!a || !b) return false;
    if (a.key && b.key && a.key === b.key) return true;
    return distKm(a, b) < SAME_SPOT_KM;
  }

  // Where a day starts, as a SPEC rather than a point: the stay covering the
  // day (whose own coordinates the hotel picker may have recorded, else its
  // city), and failing that the city dayMorningCity already names on the chip.
  // The caller resolves it against its caches, which is why this stays pure.
  function dayAnchor(items, date, isResolved) {
    // A day that opens with an arrival measures from where you LAND: the
    // first chip then answers "how far from the airport (or station) to the
    // first stop", which is the leg an arrival day actually starts with. An
    // "(KEF)"-style code is placed exactly by the bundled airports table (the
    // caller resolves `iata`); a code-less arrival falls back to its city.
    const arr = dayArrival(items, date);
    if (arr) return { source: 'arrival', item: arr.item, label: arr.label, city: arr.city, iata: arr.iata };
    const host = dayHostStay(items, date);
    if (host) {
      return { source: 'stay', item: host, label: displayTitle(host), city: String(host.location || '').trim() };
    }
    const m = dayMorningCity(items, date, isResolved);
    return m.city ? { source: 'city', item: null, label: m.city, city: m.city } : null;
  }

  // The day's chain of leg distances: the first located stop measures from the
  // anchor, every later one from the stop before it. Rules, in order:
  //   - a `skip` stop (a check-OUT row, which repeats a booking that started
  //     earlier, exactly as the cost and Maps cells are suppressed there) is
  //     not a leg and does not become the next origin;
  //   - a stop with no coordinates is passed over, so the chain measures from
  //     the last stop that DID resolve rather than breaking;
  //   - a leg between two identical points (both ends fell back to the same
  //     city centroid, or to the same cached venue) is dropped, because
  //     "0.0 km" is a fake fact, not a distance.
  function dayDistanceChain(anchor, stops) {
    const legs = [];
    let prev = distancePoint(anchor);
    for (const stop of Array.isArray(stops) ? stops : []) {
      if (!stop || stop.skip) continue;
      const here = distancePoint(stop);
      if (!here) continue;
      if (prev && !sameSpot(prev, here)) {
        legs.push({
          id: here.id, km: distKm(prev, here),
          from: prev.label || '', to: here.label || '',
          // where the leg STARTS, as a place a map can search for: the label is
          // an item title ("Return to hotel") and routes nowhere
          fromQuery: prev.query || '', toQuery: here.query || '',
        });
      }
      prev = here;
    }
    return legs;
  }

  // Above this many stops an exact answer stops being worth the wait: 8 stops
  // is 40,320 orders (a millisecond), 12 would be 479 million.
  const ROUTE_EXACT_MAX = 8;

  // Where a SUGGESTION starts from, which is a different question from the one
  // dayAnchor answers. dayAnchor says where a DAY opens; a suggestion lands at
  // a clock time, and what matters is where the traveller actually is by then.
  // In order:
  //   1. the last located thing already scheduled EARLIER the same day - the
  //      previous activity, or where a mid-day leg put them down (a leg is not
  //      a place: you end up where it LANDS, which is the same spec an arrival
  //      anchor produces, so the airports table can pin it exactly);
  //   2. failing that, the day's own anchor (the arrival that opens the day,
  //      else the stay covering the night, else the morning city).
  // Stays are skipped in (1) because (2) already answers with the hotel, and a
  // check-out row would otherwise claim the morning. null when nothing names an
  // origin at all, which renders as no chip rather than a guess. The shape
  // matches dayAnchor's, so ONE resolver in app.js serves both.
  function proposalOrigin(items, date, time, isResolved) {
    const list = Array.isArray(items) ? items : [];
    const at = isClockTime(time) ? String(time) : '';
    const stayHere = () => {
      const host = dayHostStay(list, date);
      return host ? { source: 'stay', item: host, label: displayTitle(host), city: String(host.location || '').trim() } : null;
    };
    // "Landed, then checked in." Once the day has a bed, a leg that arrived
    // EARLIER stops being where the traveller is standing: an 8pm drink on an
    // arrival day is a hop from the hotel, not from the gate. The airport is
    // the honest origin only for the day's FIRST stop, which is the question
    // dayAnchor answers for the Days-view chain, not this one.
    const afterLeg = (leg, arr) => stayHere()
      || { source: 'arrival', item: leg, label: arr.label, city: arr.city, iata: arr.iata };

    // When each already-planned thing actually puts the traveller somewhere. For
    // a LEG that is when it lands, never when it leaves: at 10:00 on a day whose
    // flight departs at 09:00 and lands at 13:30 the traveller is in the air,
    // and measuring an activity from the destination would be a fiction. An
    // overnight leg lands on a day it did not start on, which is why this reads
    // endDate rather than filtering on startDate up front.
    const placedAt = (it) => {
      if (it.type === 'flight' || it.type === 'transport') {
        if (it.endDate) return it.endDate === date ? String(it.endTime || '') : '';
        return it.startDate === date ? String(it.endTime || it.startTime || '') : '';
      }
      return it.startDate === date ? String(it.startTime || '') : '';
    };
    if (isIsoDate(date) && at) {
      const earlier = list
        .filter(it => it && it.status !== 'cancelled' && !isStay(it))
        .map(it => ({ it, at: placedAt(it) }))
        .filter(x => isClockTime(x.at) && x.at < at)
        .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : bySortKey(a.it, b.it)));
      for (let i = earlier.length - 1; i >= 0; i--) {
        const prev = earlier[i].it;
        if (prev.type === 'flight' || prev.type === 'transport') {
          const arr = parseTravelArrival(prev.title);
          if (arr) return afterLeg(prev, arr);
          continue;
        }
        const city = String(prev.location || '').trim();
        if (itemMapsQuery(prev) || city) return { source: 'item', item: prev, label: displayTitle(prev), city };
      }
    }
    const anchor = dayAnchor(list, date, isResolved);
    // Same rule for a leg the scan above could not order (it carries an arrival
    // time but no departure time, so dayAnchor sees it and the loop does not).
    if (at && anchor && anchor.source === 'arrival') {
      const arr = dayArrival(list, date);
      if (arr && arr.time && at > arr.time) return afterLeg(arr.item, arr);
    }
    return anchor;
  }

  const isClockTime = t => /^\d{2}:\d{2}$/.test(String(t == null ? '' : t));

  // Where the traveller is BASED on a day, which is the version of the question
  // the model needs and the chips do not. A chip answers about one hour and can
  // say "from Bangkok (BKK)" for the taxi in from the airport; a prompt has to
  // name one place to reason about a whole day's convenience from, and on any
  // day with a bed that place is the bed - including the arrival day, where the
  // airport is true only until check-in. With no bed it is the same answer
  // proposalOrigin gives with no hour: where the day opens.
  function dayBaseOrigin(items, date, isResolved) {
    const list = Array.isArray(items) ? items : [];
    const host = isIsoDate(date) ? dayHostStay(list, date) : null;
    if (host) return { source: 'stay', item: host, label: displayTitle(host), city: String(host.location || '').trim() };
    return proposalOrigin(list, date, '', isResolved);
  }

  // The origin for each card in a BATCH of pending suggestions, before any of
  // them is on the trip. A suggestion is measured from the last place the
  // traveller would already be at that hour, and an earlier suggestion in the
  // same batch counts: a "Return to hotel" at 21:30 is the leg home from the
  // 20:00 bar, not a zero-length hop from the hotel it ends at. That is also
  // what makes the pre-add chip agree with the post-add itinerary chip, since
  // the Days-view chain walks the same day in the same time order.
  //   cards:    [{ id, date, time, point }] - point is resolved coords or null
  //   fallback: (date, time) -> resolved origin point or null, for a card with
  //             nothing before it in the batch (the itinerary's own answer)
  // Candidates SHARING a time (the three dinners of one alternative set) never
  // become each other's origin: they are one decision about one slot.
  function suggestionOrigins(cards, fallback) {
    const list = (Array.isArray(cards) ? cards : []).filter(Boolean);
    const byDate = new Map();
    for (const c of list) {
      if (!byDate.has(c.date)) byDate.set(c.date, []);
      byDate.get(c.date).push(c);
    }
    const out = new Map();
    for (const group of byDate.values()) {
      const timed = group.filter(c => isClockTime(c.time)).sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
      for (const c of group) {
        let origin = null;
        if (isClockTime(c.time)) {
          for (const other of timed) {
            if (other.id === c.id || !(other.time < c.time)) continue;
            if (other.point) origin = other.point;
          }
        }
        out.set(c.id, origin || (typeof fallback === 'function' ? fallback(c.date, c.time) : null));
      }
    }
    return out;
  }

  // The order to walk a day's recommendations in, always starting from the
  // anchor (the hotel, or the place just accepted) and visiting every located
  // stop once. Exact by exhaustive search up to ROUTE_EXACT_MAX, greedy
  // nearest-neighbour above it. Ties break toward the input order in both
  // branches, so the same set of cards always numbers the same way.
  function shortestRoute(anchor, stops) {
    const start = distancePoint(anchor);
    const pts = (Array.isArray(stops) ? stops : []).map(distancePoint).filter(Boolean);
    if (!start || !pts.length) return null;
    const nodes = [start, ...pts];
    const d = nodes.map(a => nodes.map(b => distKm(a, b)));
    const n = pts.length;
    let seq, km;
    if (n <= ROUTE_EXACT_MAX) {
      const best = { order: null, km: Infinity };
      const used = new Array(n).fill(false);
      const order = [];
      const walk = (at, sofar) => {
        // >=, not >: an order that only TIES the best one found so far is
        // abandoned, so the winner is the first one in input order.
        if (sofar >= best.km) return;
        if (order.length === n) { best.km = sofar; best.order = order.slice(); return; }
        for (let i = 0; i < n; i++) {
          if (used[i]) continue;
          used[i] = true; order.push(i);
          walk(i + 1, sofar + d[at][i + 1]);
          order.pop(); used[i] = false;
        }
      };
      walk(0, 0);
      seq = best.order || pts.map((_, i) => i);
      km = best.km === Infinity ? 0 : best.km;
    } else {
      const left = pts.map((_, i) => i);
      seq = []; km = 0;
      let at = 0;
      while (left.length) {
        let pick = 0;
        for (let i = 1; i < left.length; i++) {
          if (d[at][left[i] + 1] < d[at][left[pick] + 1]) pick = i;
        }
        km += d[at][left[pick] + 1];
        at = left[pick] + 1;
        seq.push(left[pick]);
        left.splice(pick, 1);
      }
    }
    return { stops: seq.map(i => pts[i]), km };
  }

  // One card, one stop. A plain proposal contributes its own place; an
  // alternative set is ONE decision about ONE slot (three dinners are not three
  // dinners to walk to), so it contributes the option currently selected in it,
  // which is the first option until the traveller picks another. Flipping that
  // selection re-runs this and can reorder the whole route, which is the point.
  //
  // A card whose SELECTED option has no coordinates drops out rather than
  // falling back to a sibling that does: the route would then name a venue the
  // traveller did not choose. `id` rides through so the caller can put the order
  // pill back on the card the stop came from.
  function routeStops(cards) {
    const out = [];
    for (const card of Array.isArray(cards) ? cards : []) {
      if (!card) continue;
      const opts = Array.isArray(card.options) ? card.options : [];
      if (!opts.length) continue;
      const i = Number.isInteger(card.selected) && card.selected >= 0 && card.selected < opts.length
        ? card.selected : 0;
      const p = distancePoint(opts[i]);
      if (p) out.push({ ...p, id: card.id });
    }
    return out;
  }

  // ---------- distance wording ----------
  // ONE unit at a time, chosen by the traveller (the "Miles / Kilometers"
  // preference), with one decimal below 10 so a walk across a neighbourhood
  // does not round to a useless whole number. This is the single formatter
  // every user-visible distance goes through: the old fmtKmMi printed
  // "0.9 km / 0.6 mi" on every chip, which doubled the noise on every card
  // for no decision anyone was making.
  //
  // The unit lives HERE (module state, set by the host via setDistanceUnit)
  // rather than being threaded through every call site, because the chips,
  // tooltips, route footers and totals all format in one pass and the unit is
  // a display preference, not data. Default 'mi', consistent with the app's
  // other display defaults (12-hour clock, en-US number formatting).
  const KM_TO_MI = 0.621371;
  let distanceUnit = 'mi';
  function setDistanceUnit(u) { distanceUnit = u === 'km' ? 'km' : 'mi'; }
  function getDistanceUnit() { return distanceUnit; }
  const oneDist = n => (n < 10 ? (Math.round(n * 10) / 10).toFixed(1) : Math.round(n).toLocaleString('en-US'));
  function fmtDist(km) {
    return distanceUnit === 'km' ? `${oneDist(km)} km` : `${oneDist(km * KM_TO_MI)} mi`;
  }
  // The chip itself is a tilde and the two units; the honesty (straight line,
  // and from WHERE) has no room there and rides in the tooltip, the same split
  // weatherRange and weatherLine already use.
  const distanceChipLabel = km => `~${fmtDist(km)}`;
  function distanceChipTitle(km, from) {
    const origin = String(from == null ? '' : from).trim();
    return `${fmtDist(km)} straight-line${origin ? ` from ${origin}` : ''}, not a walking route.`;
  }
  // "20m" is what fmtDur gives, and it is exactly the wrong word next to a
  // distance: "~20m · ~1.3 km" reads as twenty METRES. Minutes are spelled on
  // any chip that also carries a distance.
  function fmtMins(min) {
    const n = Math.round(min);
    if (n < 60) return `${n} min`;
    const h = Math.floor(n / 60), m = n % 60;
    return m ? `${h} hr ${m} min` : `${h} hr`;
  }

  // How the traveller would actually cover this hop, and how long it takes,
  // straight out of modeOptions so there is ONE set of speed assumptions in the
  // app (it pads a straight line by 25% for a real ground route, the same
  // padding the route dialog's figures use). Deliberately NOT a traffic or a
  // timetable claim: nothing here is looked up, and the wording keeps the "~".
  //
  // Which mode gets named is the whole judgement. Under WALKABLE_KM the walk is
  // the useful answer for an evening out; above it the walk is technically
  // computable and useless ("1 hr 3 min on foot" is not how anyone crosses a
  // city), so the ride is named instead and the walk moves to the tooltip.
  // Past every in-city mode there is nothing honest to say, so nothing is said.
  const WALKABLE_KM = 2;
  function hopTravel(km) {
    if (!(km > 0)) return null;
    const rows = modeOptions(km, false, false);
    const walk = rows.find(r => r.key === 'walk');
    const ride = rows.find(r => r.key === 'local');
    if (km <= WALKABLE_KM && walk && walk.durMin != null) {
      return { key: 'walk', icon: '🚶', min: walk.durMin, text: `~${fmtMins(walk.durMin)} walk` };
    }
    if (ride && ride.durMin != null) {
      return { key: 'ride', icon: '🚕', min: ride.durMin, text: `~${fmtMins(ride.durMin)} by taxi` };
    }
    if (walk && walk.durMin != null) {
      return { key: 'walk', icon: '🚶', min: walk.durMin, text: `~${fmtMins(walk.durMin)} walk` };
    }
    return null;
  }

  // A suggestion card has room the Days-view row does not, and two thirds of
  // what makes the figure actionable is not the figure: "~1.3 km" alone says
  // neither how long it takes nor that it is measured from the hotel you are
  // booked into. So the chip leads with the time (which is what a traveller
  // actually decides on), then the distance, then the origin:
  //   "🚶 ~20 min walk · ~0.8 mi from Hotel Borg"
  // Every part degrades on its own: no origin drops the "from", and a hop too
  // long for any in-city mode drops the time and reads as it used to.
  function assistDistanceChipLabel(km, from) {
    const origin = String(from == null ? '' : from).trim();
    const hop = hopTravel(km);
    const dist = `~${fmtDist(km)}${origin ? ` from ${origin}` : ''}`;
    return hop ? `${hop.icon} ${hop.text} · ${dist}` : dist;
  }

  // Whatever the chip could not fit: the straight-line caveat, and the mode the
  // chip did NOT name, so both figures are available without either crowding
  // the card.
  function shortHopHint(km) {
    if (!(km > 0)) return '';
    const rows = modeOptions(km, false, false);
    const parts = [];
    const walk = rows.find(r => r.key === 'walk');
    const ride = rows.find(r => r.key === 'local');
    if (walk && walk.durMin != null) parts.push(`${fmtMins(walk.durMin)} on foot`);
    if (ride && ride.durMin != null) parts.push(`${fmtMins(ride.durMin)} by taxi or local transit`);
    return parts.join(', or ');
  }

  function assistDistanceChipTitle(km, from) {
    const hint = shortHopHint(km);
    return distanceChipTitle(km, from) + (hint ? ` Roughly ${hint} - an estimate from the distance, not live traffic.` : '');
  }

  // "Shortest route: Hotel Gracery > teamLab > Ichiran · ~3.4 mi total"
  function routeFooterText(anchorLabel, labels, km) {
    const names = [String(anchorLabel == null ? '' : anchorLabel).trim() || 'Start',
      ...(Array.isArray(labels) ? labels : []).map(l => String(l == null ? '' : l).trim() || '(no title)')];
    return `Shortest route: ${names.join(' > ')} · ~${fmtDist(km)} total`;
  }

  // ---------- the day's route, summed and exported ----------
  // Everything below reads the SAME legs dayDistanceChain built for the chips
  // and the Directions links: one chain feeds every surface, so the per-card
  // figure, the day total and the external route can never disagree.

  // Per-mode totals for one day's chain. Each leg is classified by the same
  // hopTravel judgement its chip prints (walk under WALKABLE_KM, a ride
  // otherwise), so a day cannot say "9 min walk" on a card and file that leg
  // under transit in the total. A leg too long for any in-city mode (an
  // intercity hop that happens to sit inside one day) still counts, under
  // 'ride': it is travel the day contains, and dropping it would understate
  // the day.
  function dayTravelTotals(legs) {
    const byMode = { walk: 0, ride: 0 };
    let km = 0;
    for (const leg of Array.isArray(legs) ? legs : []) {
      if (!leg || !(leg.km > 0)) continue;
      const hop = hopTravel(leg.km);
      byMode[hop && hop.key === 'walk' ? 'walk' : 'ride'] += leg.km;
      km += leg.km;
    }
    return { byMode, km, legCount: (Array.isArray(legs) ? legs : []).filter(l => l && l.km > 0).length };
  }

  // Which travelmode ONE Google Maps URL for the whole day should open in.
  // Maps directions URLs accept a single travelmode for the entire waypoint
  // route, and transit does not support waypoints at all, so a mixed day
  // cannot be represented faithfully: walking is honest only when every leg
  // is a walk, and driving is the one mode Maps can always route for the
  // rest. The internal Day route stays the source of truth for the actual
  // per-leg modes; this is documented on the link itself (its title).
  function dayRouteMode(legs) {
    const real = (Array.isArray(legs) ? legs : []).filter(l => l && l.km > 0);
    if (!real.length) return 'walking';
    return real.every(l => l.km <= WALKABLE_KM) ? 'walking' : 'driving';
  }

  // A directions URL through ordered waypoints, same shape and guards as
  // directionsUrl. Google's URL API caps waypoints at 9; the caller chunks
  // (routeUrlChunks) rather than silently dropping stops.
  function directionsRouteUrl(origin, waypoints, destination, travelmode) {
    const dest = normalizePlaceQuery(destination);
    const from = normalizePlaceQuery(origin);
    if (!dest || !from) return '';
    const via = (Array.isArray(waypoints) ? waypoints : [])
      .map(normalizePlaceQuery).filter(Boolean);
    const mode = travelmode === 'walking' || travelmode === 'driving' ? travelmode : 'driving';
    return 'https://www.google.com/maps/dir/?api=1'
      + `&origin=${encodeURIComponent(from)}`
      + (via.length ? `&waypoints=${encodeURIComponent(via.join('|'))}` : '')
      + `&destination=${encodeURIComponent(dest)}&travelmode=${mode}`;
  }

  // Google's directions URL takes at most 9 waypoints between the origin and
  // the destination. A day with more stops is split into consecutive parts
  // (each part starting where the previous one ended) so every stop appears
  // in exactly one link and none is silently dropped.
  const ROUTE_URL_MAX_WAYPOINTS = 9;
  function routeUrlChunks(queries, maxWaypoints = ROUTE_URL_MAX_WAYPOINTS) {
    const q = (Array.isArray(queries) ? queries : []).map(normalizePlaceQuery).filter(Boolean);
    if (q.length < 2) return [];
    const perChunk = Math.max(2, maxWaypoints + 2); // origin + waypoints + destination
    const chunks = [];
    let start = 0;
    while (start < q.length - 1) {
      const end = Math.min(q.length - 1, start + perChunk - 1);
      chunks.push(q.slice(start, end + 1));
      start = end;
    }
    return chunks;
  }

  // ---------- pick-one candidate badges ----------
  // Objective winners inside ONE alternative set, so the traveller can scan
  // the choices without cross-reading three cards. Same discipline as the
  // route dialog's routeBadges: every badge is DERIVED from a number the app
  // already shows, ties break to the first candidate in rendered order so a
  // repaint can never migrate a badge, and a badge whose data has not
  // resolved is omitted rather than guessed.
  //   kms:     per-candidate leg distance from the set's shared origin (the
  //            same figure the chip prints and shortestRoute optimises), or
  //            null while unresolved. "Shortest route" is that distance: all
  //            candidates in a set share one origin, so this compares the
  //            straight-line leg length, the app's own route metric - it is
  //            deliberately NOT labelled "fastest", which would claim a
  //            duration nothing here computes.
  //   ratings: per-candidate { rating, count } from the resolved Places
  //            lookup, or null.
  const CANDIDATE_BADGES = {
    fastest: { icon: '⚡', label: 'Shortest route', title: 'Shortest travel leg from where you will be before this slot' },
    rated: { icon: '⭐', label: 'Highest rated', title: 'Highest Google Maps rating of these options' },
    popular: { icon: '🔥', label: 'Most popular', title: 'Most Google Maps reviews of these options' },
  };
  function candidateBadges({ kms, ratings }) {
    const n = Math.max(Array.isArray(kms) ? kms.length : 0, Array.isArray(ratings) ? ratings.length : 0);
    const out = Array.from({ length: n }, () => []);
    if (n < 2) return out; // one option is not a comparison
    const winner = (val) => {
      let best = -1, bestV = null, entrants = 0;
      for (let i = 0; i < n; i++) {
        const v = val(i);
        if (v == null) continue;
        entrants++;
        // strict comparison: a tie keeps the earlier candidate
        if (best < 0 || v < bestV) { best = i; bestV = v; }
      }
      // a "winner" among fewer than two resolved entrants is not a comparison,
      // it is missing data wearing a badge
      return entrants >= 2 ? best : -1;
    };
    const km = i => (Array.isArray(kms) && typeof kms[i] === 'number' && kms[i] >= 0 ? kms[i] : null);
    const rating = i => {
      const r = Array.isArray(ratings) ? ratings[i] : null;
      return r && typeof r.rating === 'number' ? -r.rating : null; // negated: winner() minimises
    };
    const count = i => {
      const r = Array.isArray(ratings) ? ratings[i] : null;
      return r && typeof r.count === 'number' && r.count > 0 ? -r.count : null;
    };
    const f = winner(km);
    if (f >= 0) out[f].push(Object.assign({ id: 'fastest' }, CANDIDATE_BADGES.fastest));
    const r = winner(rating);
    if (r >= 0) out[r].push(Object.assign({ id: 'rated' }, CANDIDATE_BADGES.rated));
    const p = winner(count);
    if (p >= 0) out[p].push(Object.assign({ id: 'popular' }, CANDIDATE_BADGES.popular));
    return out;
  }

  // ---------- money: reading a price out of untrusted JSON ----------
  // Import, share links and the model all hand over arbitrary JSON, and a bare
  // `!isNaN(x) && x >= 0` check lets far too much through: `true` becomes $1.00
  // of invented money, `[]` becomes $0, and `1e999` becomes Infinity, which
  // renders as "Infinity" and then JSON.stringify writes it back as null, so
  // the number vanishes on the next load and the totals silently change. Only a
  // finite number (or a numeric string, which is what a CSV-ish export gives)
  // is a price. Negative is refused too, because the form's min=0 and
  // validateItem both say a cost is never negative, so keeping one would import
  // an item flagged as invalid that the modal then refuses to save.
  // Returns { ok, value, reason }; `reason` is what the import tells the user.
  function parseMoney(raw) {
    if (raw == null || raw === '') return { ok: true, value: null, reason: '' };
    if (typeof raw !== 'number' && typeof raw !== 'string') return { ok: false, value: null, reason: 'is not a number' };
    if (typeof raw === 'string' && raw.trim() === '') return { ok: true, value: null, reason: '' };
    const n = Number(raw);
    if (Number.isNaN(n)) return { ok: false, value: null, reason: 'is not a number' };
    if (!Number.isFinite(n)) return { ok: false, value: null, reason: 'is not a finite amount' };
    // A negative amount is a REFUND or a credit and is kept exactly as given.
    // The typeof guard above is what still refuses `true`, `[]` and `{}`:
    // Number(true) is 1 and Number([]) is 0, so allowing a sign must not be
    // allowed to reopen the "money invented from a boolean" hole.
    return { ok: true, value: roundMoney(n), reason: '' };
  }

  // A price is stored to the cent, because the row shows cents and the totals
  // are built from the same number: 12.12345678 rendered as $12.12 but summed
  // at full precision, so a handful of rows made the total disagree with the
  // rows a traveller can see. Rounding at every entry point keeps them equal.
  // Math.round is half-UP, which is half-away-from-zero for a charge but
  // half-TOWARDS-zero for a refund: 120.505 became 120.51 while -120.505 became
  // -120.50. Two rows that are each other's exact reverse then failed to cancel,
  // and a CSV SUM stopped matching the app. Rounding the magnitude and
  // reapplying the sign makes the two symmetric.
  const roundMoney = n => {
    const v = Number(n);
    return v < 0 ? -(Math.round(-v * 100) / 100) : Math.round(v * 100) / 100;
  };

  // The budget verdict is a claim about ALL the money, so it can only read
  // "within budget" when the total actually contains all of it. When some
  // amounts could not be converted (offline, or a currency with no rate) the
  // missing money is exactly what might push the trip over, so an incomplete
  // total gets 'partial' and never the green chip. Returns '' with no budget.
  function budgetVerdict(total, budget, unconvertedCount) {
    if (budget == null || budget === '') return '';
    const t = Number(total);
    if (t > Number(budget)) return 'over';
    // Refunds outweigh spend, so the money counted so far is money COMING BACK.
    // "Within budget" is technically true and completely uninformative there,
    // and a green tick over a negative number reads as a bug; the chip has to
    // name what actually happened instead.
    if (t < 0) return 'refund';
    return unconvertedCount > 0 ? 'partial' : 'ok';
  }

  // ---------- money: the budget range ----------
  // A budget is optional, and when there is one it is a CEILING. `trip.budget`
  // stays exactly that ceiling, so the verdict above, the fill bar and every
  // saved trip, share link and export from before ranges existed keep working
  // untouched and nothing migrates. A range only adds an optional floor
  // underneath it, `trip.budgetFrom`, present only when somebody set one. The
  // floor is display only: no total is ever judged for coming in UNDER it.
  //
  // The legal states, and nothing else:
  //   both blank -> no budget at all (no chip, no bar, no budget wording)
  //   only "to"  -> the plain ceiling this app has always had
  //   both       -> a range, floor <= ceiling
  // A floor with no ceiling is refused rather than quietly promoted to one: a
  // number typed as "at least" must never come back as "at most".
  function readBudgetRange(rawFrom, rawTo) {
    const from = parseMoney(rawFrom);
    const to = parseMoney(rawTo);
    if (!from.ok || !to.ok) return { ok: false, error: 'A budget must be a number.' };
    // parseMoney stopped rejecting negatives when refunds became legal. A
    // budget is a ceiling, not a transaction, so both ends are checked here.
    if ((from.value != null && from.value < 0) || (to.value != null && to.value < 0)) {
      return { ok: false, error: 'A budget cannot be negative.' };
    }
    if (to.value == null) {
      if (from.value != null) return { ok: false, error: 'A budget needs an upper figure. Fill "to", or leave both blank for no budget.' };
      return { ok: true, error: '', from: null, to: null };
    }
    if (from.value != null && from.value > to.value) {
      return { ok: false, error: 'The lower figure cannot be above the upper one.' };
    }
    return { ok: true, error: '', from: from.value, to: to.value };
  }

  // The same rule for data this app did not just watch somebody type: a trip
  // read back from storage, an imported file, a share link. Only the FLOOR is
  // ever dropped, never the ceiling everything else reads, and the caller is
  // handed a reason so an import can say what it refused.
  function normalizeBudgetFrom(rawFrom, budget) {
    if (rawFrom == null || rawFrom === '') return { value: null, reason: '' };
    const from = parseMoney(rawFrom);
    if (!from.ok) return { value: null, reason: from.reason };
    if (from.value < 0) return { value: null, reason: 'cannot be negative' };
    if (budget == null || budget === '') return { value: null, reason: 'has no upper figure to sit under' };
    if (from.value > Number(budget)) return { value: null, reason: 'is above the upper figure' };
    return { value: from.value, reason: '' };
  }

  // What the budget chip states after "of": nothing at all without a budget,
  // the ceiling alone for a plain ceiling (byte for byte what the chip said
  // before ranges existed), and "FROM-TO" for a range. The glued hyphen is the
  // app's own range separator (see tempSpan); both ends are non-negative by
  // then, so it cannot be read as a sign. `fmt` is the caller's currency
  // formatter, so this owns the wording and never a currency table.
  function budgetFigure(from, to, fmt) {
    if (to == null || to === '') return '';
    const top = fmt(to);
    return from == null || from === '' ? top : `${fmt(from)}-${top}`;
  }

  // ---------- money: refunds ----------
  // A negative amount is money coming BACK. It must never be mistakable for a
  // charge, and "-$120.00" is exactly that mistake waiting to happen: a hyphen
  // beside a currency symbol disappears at 11px and reads as a dash between
  // fields. So nothing in this app prints a signed amount to a human. The word
  // carries the direction and the number is always the magnitude:
  //   item row  ->  "Refund $120.00"
  //   a total   ->  "Net refund $120.00"
  // The STORED number, the CSV column, exports and every sum keep the sign;
  // this is display only.
  function refundParts(amount) {
    const n = Number(amount);
    const isRefund = Number.isFinite(n) && n < 0;
    return { isRefund, magnitude: isRefund ? -n : n };
  }

  // ---------- money: when a cost is worth showing ----------
  // A cost of 0 is a real, recorded value (a free museum, a comped room) and
  // must keep round-tripping as 0 through save, edit, export and every total.
  // But rendering it as a "$0.00" badge is noise: it looks like a price and
  // says nothing. DISPLAY ONLY: no sum, conversion or budget figure consults
  // this. A negative amount (a refund or credit) is information, so it shows.
  function showsCostBadge(cost) {
    if (cost == null || cost === '') return false;
    const n = Number(cost);
    return isFinite(n) && n !== 0;
  }

  // A meal or a drink is an `activity` carrying one of the literal title
  // prefixes the assistant contract mandates. The prefixes are NOT restated
  // here: they are read back out of ASSIST_KINDS, the exact string the prompt
  // sends, so the renderer cannot drift from the instruction. (ASSIST_KINDS is
  // declared further down, hence the lazy read; it is a const in the same IIFE.)
  let MEAL_PREFIXES = null;
  function mealTitlePrefixes() {
    if (!MEAL_PREFIXES) MEAL_PREFIXES = (ASSIST_KINDS.match(/"[A-Z][a-z]+: "/g) || []).map(s => s.slice(1, -1));
    return MEAL_PREFIXES;
  }
  // Matching rule: leading whitespace is ignored, case is ignored, and the
  // space after the colon is optional ("Dinner:Narisawa" counts). The colon is
  // required, so "Dinnerware shopping" is not a meal.
  function isFoodOrDrink(title) {
    const t = String(title == null ? '' : title).trimStart().toLowerCase();
    return mealTitlePrefixes().some(p => t.startsWith(p.trim().toLowerCase()));
  }

  // Which meal a title announces, read off the SAME prefix list isFoodOrDrink
  // matches on, so the icon, the accent colour and the estimate tilde can never
  // disagree about what counts as a meal. Returns '' for anything else.
  function mealKind(title) {
    const t = String(title == null ? '' : title).trimStart().toLowerCase();
    const hit = mealTitlePrefixes().find(p => t.startsWith(p.trim().toLowerCase()));
    return hit ? hit.replace(/[:\s]+$/, '').toLowerCase() : '';
  }

  // Free text long enough to be worth clamping to a few lines behind a
  // "Show more" toggle. The threshold lives here so the renderer and the tests
  // agree on which rows get a toggle at all.
  const LONG_DETAILS_CHARS = 180;
  function isLongDetails(text) { return String(text == null ? '' : text).length > LONG_DETAILS_CHARS; }

  // ---------- money: a guess and a price are different fields ----------
  // `cost` is a number the traveller typed. `estCost` is a number the assistant
  // guessed. The rule is source-based, not type-based: a hotel you typed counts
  // and a museum ticket you typed counts, while an assistant-suggested dinner
  // price never counts, whatever the item type. So estCost is shown (with a
  // tilde) but never summed, and nothing ever writes a guess into `cost` except
  // the traveller adopting it from the edit modal.
  function hasRealCost(item) {
    return !!item && item.cost != null && item.cost !== '' && !isNaN(item.cost);
  }
  function hasEstimate(item) {
    return !!item && item.estCost != null && item.estCost !== '' && !isNaN(item.estCost);
  }

  // A tilde means "estimate", and since the estimate now lives in its own field
  // that is a fact about the data rather than a guess from the title. A typed
  // cost always wins: an estimate only ever surfaces where the traveller has
  // not put a number of their own. DISPLAY ONLY.
  function isEstimatedCost(item) {
    return hasEstimate(item) && !hasRealCost(item);
  }

  // The one number a row shows, plus which field it came from. A typed 0 is a
  // real decision (a free museum), so it hides the badge instead of falling
  // through to a guess. Returns null when there is nothing worth showing.
  function displayCostOf(item) {
    if (hasRealCost(item)) {
      return showsCostBadge(item.cost)
        ? { amount: Number(item.cost), currency: item.costCurrency || '', est: false } : null;
    }
    if (hasEstimate(item) && showsCostBadge(item.estCost)) {
      return { amount: Number(item.estCost), currency: item.estCostCurrency || '', est: true };
    }
    return null;
  }

  // The tilde and the dropped cents are the same rule. An estimate is a guess,
  // so it reads as `~$45`, not `~$45.00`; a price the traveller actually paid
  // keeps every cent because the trip totals are built from it. `digits` is fed
  // straight to Intl, which rounds half-up rather than truncating, so $44.60
  // shows as ~$45. DISPLAY ONLY: the stored number, the totals, the CSV cost
  // column, the ICS export and the share link are untouched.
  function costDisplayParts(item) {
    const est = isEstimatedCost(item);
    return { est, tilde: est ? '~' : '', digits: est ? 0 : 2 };
  }

  // ---------- assistant: the Maps link on a proposal card ----------
  // A search URL is a guess: Google resolves "Roppongi sushi restaurants" to
  // whatever it likes, which is how "Verify on Google Maps" ended up opening the
  // wrong place. When the ratings lookup already resolved this query to a real
  // place we link straight at that place instead, and when the server told us
  // the query names no venue at all we stop calling the link "Verify".
  const mapsSearchUrl = q => 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(normalizePlaceQuery(q));

  // `entry` is the places cache entry for this query, or undefined while the
  // lookup is pending / unavailable / switched off. Returns null when there is
  // no query to link at all.
  function assistMapsLink(mapsQuery, entry) {
    const q = normalizePlaceQuery(mapsQuery);
    if (!q) return null;
    const search = mapsSearchUrl(q);
    // The URI came off the network; anything that is not http(s) must not reach
    // an href, and a search we can still render beats a link that does nothing.
    const uri = entry && entry.status === 'ok' && typeof entry.mapsUri === 'string'
      && /^https?:\/\//i.test(entry.mapsUri) ? entry.mapsUri : '';
    if (uri) return { href: uri, label: '📍 Verify on Google Maps', resolved: true };
    if (entry && entry.status === 'no_match' && entry.reason === 'generic_query') {
      return { href: search, label: '📍 Search Google Maps', resolved: false };
    }
    return { href: search, label: '📍 Verify on Google Maps', resolved: false };
  }

  // ---------- itinerary: which query an item opens on Google Maps ----------
  // Every place a traveller can actually walk into deserves the same Maps
  // section: a hotel, a ryokan, a hostel or an apartment is a place the same way
  // a museum or a restaurant is, and a rating that only ever showed up on the
  // ones the assistant happened to tag read as a bug.
  //
  // `mapsQuery` is still the truth when it exists (the assistant writes it, an
  // edit carries it across). This fills the gap for everything else - anything
  // typed by hand, and any assistant item that omitted it - by asking for the
  // item's OWN words: its title plus its location, which is exactly what a
  // traveller would type into Maps themselves.
  //
  // Only `stay` and `activity` derive one. A flight, a between-cities leg, a
  // taxi hop and a note are not places you visit, and "Return to hotel Lisbon"
  // is the documented way to send someone to the wrong pin (see
  // ASSIST_MAPSQUERY). The server's own generic-query filter is the second net:
  // a derived query that names no venue is rejected there before it costs
  // anything, and the row keeps its plain "Google Maps" search button.
  const PLACE_TYPES = { stay: 1, activity: 1 };

  // A place is somewhere you go and might choose between; a LEG is how you get
  // there. The distinction is not cosmetic, and getting it wrong is what put a
  // "Return to hotel" card on screen carrying the hotel's own 4.8 (958) star
  // rating: a rating answers "is this worth going to", which is a question
  // about a venue you are picking, and nobody picks the ride home to a hotel
  // they have already booked. Same reason a leg wants DIRECTIONS rather than a
  // place listing - the useful action there is "how do I do this", not "what is
  // this place like". Note this asks about the item's TYPE, never about whether
  // it happens to carry a mapsQuery: a return leg carries the real hotel name
  // on purpose (see ASSIST_MAPSQUERY), which is exactly why the type has to be
  // what decides.
  const isPlaceType = item => !!(item && PLACE_TYPES[item.type]);
  const TRAVEL_TYPES = { flight: 1, transport: 1, local: 1 };
  const isTravelLeg = item => !!(item && TRAVEL_TYPES[item.type]);

  // Google Maps directions, the same URL shape travelLinks already builds for
  // the route dialog's transit and driving buttons. `origin` is optional:
  // Maps accepts a destination-only link and asks for the starting point,
  // which beats guessing one.
  const DIRECTION_MODES = { walking: 1, transit: 1, driving: 1 };
  function directionsUrl(origin, destination, travelmode) {
    const dest = normalizePlaceQuery(destination);
    if (!dest) return '';
    const from = normalizePlaceQuery(origin);
    const mode = DIRECTION_MODES[travelmode] ? travelmode : 'transit';
    return 'https://www.google.com/maps/dir/?api=1'
      + (from ? `&origin=${encodeURIComponent(from)}` : '')
      + `&destination=${encodeURIComponent(dest)}&travelmode=${mode}`;
  }

  // Which travelmode a leg's directions link should open in. A local hop is
  // walked when it is short enough to walk and ridden otherwise (the same
  // WALKABLE_KM judgement the chip makes, so the card cannot suggest a walk and
  // link a taxi); anything between cities opens in driving, which is the mode
  // Maps can actually route for an arbitrary intercity pair. `km` may be null
  // when nothing located the leg yet, and transit is then the safe default for
  // a city hop.
  function legTravelMode(type, km) {
    if (type !== 'local') return 'driving';
    if (km == null) return 'transit';
    return km <= WALKABLE_KM ? 'walking' : 'transit';
  }

  // A meal prefix is a slot label, not part of the venue's name: "Dinner:
  // Fiskfelagid" is searched as "Fiskfelagid". "Cancelled:" goes the same way,
  // since the status is now a badge of its own.
  const TITLE_PREFIX_RE = /^\s*cancelled\s*:\s*/i;
  function stripTitlePrefixes(title) {
    let t = String(title == null ? '' : title).replace(TITLE_PREFIX_RE, '');
    for (const p of mealTitlePrefixes()) {
      const re = new RegExp('^\\s*' + p.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*', 'i');
      if (re.test(t)) { t = t.replace(re, ''); break; }
    }
    return t.trim();
  }

  // The title as a human should read it on a card: the status prefix goes,
  // because a "Cancelled" badge now says it, and a title that is nothing BUT
  // the prefix keeps its original text rather than becoming blank.
  function displayTitle(item) {
    const raw = String(item && item.title != null ? item.title : '');
    if (!item || item.status !== 'cancelled') return raw;
    const stripped = raw.replace(TITLE_PREFIX_RE, '').trim();
    return stripped || raw;
  }

  // The query this item opens on Google Maps: its own mapsQuery when it has
  // one, otherwise the derived "<venue> <location>" for place-like types, and
  // '' for everything that is not a place.
  function itemMapsQuery(item) {
    if (!item) return '';
    const own = normalizePlaceQuery(item.mapsQuery);
    if (own) return own;
    if (!PLACE_TYPES[item.type]) return '';
    const name = stripTitlePrefixes(item.title);
    if (name.length < 2) return '';
    const where = String(item.location == null ? '' : item.location).trim();
    // A location already spelled inside the title ("Godafoss and Lake Myvatn"
    // in Akureyri) is not repeated: a doubled place name is a worse search.
    const dup = where && name.toLowerCase().includes(where.toLowerCase());
    return normalizePlaceQuery(where && !dup ? `${name} ${where}` : name);
  }

  // ---------- assistant: link segments ----------
  // Splits assistant prose into plain-text and URL segments. Returns DATA ONLY:
  // the caller renders and escapes, so nothing here produces or trusts HTML.
  const PLAN_URL_RE = /https?:\/\/[^\s<>"'`]+/g;
  // Sentence punctuation glued to the end of a URL belongs to the prose. This
  // also clips a genuine trailing ')' in wiki-style links; the far more common
  // case is "see https://x.example/a." and that one matters more.
  function trimUrlTail(url) {
    const trail = /[.,;:!?)\]]+$/.exec(url);
    return trail ? url.slice(0, url.length - trail[0].length) : url;
  }
  // Shared by linkifySegments and the Markdown inline scanner, so bare-URL
  // detection can never drift into two different answers.
  function matchUrlAt(src, index) {
    PLAN_URL_RE.lastIndex = index;
    const m = PLAN_URL_RE.exec(src);
    if (!m || m.index !== index) return '';
    return trimUrlTail(m[0]);
  }
  function linkifySegments(text) {
    const src = String(text == null ? '' : text);
    const segs = [];
    let cursor = 0, m;
    PLAN_URL_RE.lastIndex = 0;
    while ((m = PLAN_URL_RE.exec(src)) !== null) {
      const url = trimUrlTail(m[0]);
      if (!url) continue;
      if (m.index > cursor) segs.push({ text: src.slice(cursor, m.index) });
      segs.push({ href: url });
      cursor = m.index + url.length;
      PLAN_URL_RE.lastIndex = cursor;
    }
    if (cursor < src.length) segs.push({ text: src.slice(cursor) });
    if (!segs.length) segs.push({ text: src });
    return segs;
  }

  // ---------- assistant: markdown ----------
  // The assistant's reply is UNTRUSTED text, so this parser returns a DATA TREE
  // and never an HTML string: the caller builds elements with createElement and
  // puts every leaf in via textContent, which is the single, unavoidable escape
  // point. Raw HTML in the reply is therefore never markup, only characters.
  // Anything the subset does not cover degrades to literal text.
  //
  // Blocks: {type:'paragraph'|'heading'|'quote', inline:[...]}, heading adds
  //   level 1-6; {type:'list', ordered, start, items:[{inline:[...]}]};
  //   {type:'code', lang, text}.
  // Inline: {type:'text', text} | {type:'br'} | {type:'code', text}
  //   | {type:'strong'|'em', children:[...]} | {type:'link', href, children}.

  // Only absolute http(s) reaches an href. javascript:, data:, vbscript: and
  // protocol-relative //host all fail this and stay inert text.
  const mdSafeHref = url => (/^https?:\/\//i.test(String(url == null ? '' : url).trim())
    ? String(url).trim() : '');

  // [text](url) with an optional "title", which models emit often enough that
  // dropping the whole link back to literal text would be a visible failure.
  const MD_LINK_RE = /^\[([^\]\n]*)\]\(\s*([^()\s]*)(?:[ \t]+"[^"\n)]*")?\s*\)/;

  function mdPushText(nodes, str) {
    if (!str) return;
    const last = nodes[nodes.length - 1];
    if (last && last.type === 'text') last.text += str;
    else nodes.push({ type: 'text', text: str });
  }

  // Finds the closing run for an emphasis marker. A single '_' must not close
  // inside a word, so snake_case names survive as themselves.
  function mdFindClose(src, from, marker) {
    const ch = marker[0];
    for (let j = from; j < src.length; j++) {
      if (src[j] !== ch) continue;
      if (marker.length === 2) {
        if (src[j + 1] === ch) return j;
        continue;
      }
      if (src[j + 1] === ch || src[j - 1] === ch) continue;
      if (ch === '_' && /\w/.test(src[j + 1] || '')) continue;
      return j;
    }
    return -1;
  }

  function parseMarkdownInline(text) {
    const src = String(text == null ? '' : text);
    const out = [];
    let i = 0;
    while (i < src.length) {
      const ch = src[i];
      if (ch === '\n') { out.push({ type: 'br' }); i++; continue; }
      if (ch === '`') {
        const m = /^(`+)([\s\S]*?)\1/.exec(src.slice(i));
        if (m && m[2]) { out.push({ type: 'code', text: m[2] }); i += m[0].length; continue; }
        mdPushText(out, ch); i++; continue;
      }
      if (ch === 'h' || ch === 'H') {
        const url = matchUrlAt(src, i);
        if (url) {
          out.push({ type: 'link', href: url, children: [{ type: 'text', text: url }] });
          i += url.length; continue;
        }
      }
      if (ch === '[') {
        const m = MD_LINK_RE.exec(src.slice(i));
        if (m) {
          const href = mdSafeHref(m[2]);
          // An unsafe or relative target is not a link: the whole [text](url)
          // stays on screen exactly as written, so nothing is silently dropped.
          if (href) out.push({ type: 'link', href, children: parseMarkdownInline(m[1]) });
          else mdPushText(out, m[0]);
          i += m[0].length; continue;
        }
        mdPushText(out, ch); i++; continue;
      }
      if (ch === '*' || ch === '_') {
        if (ch === '_' && /\w/.test(src[i - 1] || '')) { mdPushText(out, ch); i++; continue; }
        const marker = src[i + 1] === ch ? ch + ch : ch;
        const start = i + marker.length;
        const close = mdFindClose(src, start, marker);
        const inner = close > start ? src.slice(start, close) : '';
        // Whitespace-hugging markers are arithmetic or decoration, not emphasis.
        if (inner && !/^\s/.test(inner) && !/\s$/.test(inner)) {
          out.push({ type: marker.length === 2 ? 'strong' : 'em', children: parseMarkdownInline(inner) });
          i = close + marker.length; continue;
        }
        mdPushText(out, ch); i++; continue;
      }
      mdPushText(out, ch); i++;
    }
    return out;
  }

  const MD_FENCE_RE = /^ {0,3}(```|~~~)[ \t]*([A-Za-z0-9+#._-]*)[ \t]*$/;
  const MD_HEADING_RE = /^ {0,3}(#{1,6})[ \t]+(.*)$/;
  const MD_QUOTE_RE = /^ {0,3}>[ \t]?(.*)$/;
  const MD_UL_RE = /^\s*[-*+][ \t]+(.*)$/;
  const MD_OL_RE = /^\s*(\d{1,9})[.)][ \t]+(.*)$/;

  function parseMarkdown(text) {
    const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
    const blocks = [];
    let para = [];
    let list = null;
    const flushPara = () => {
      if (!para.length) return;
      blocks.push({ type: 'paragraph', inline: parseMarkdownInline(para.join('\n')) });
      para = [];
    };
    const flushList = () => {
      if (!list) return;
      blocks.push({
        type: 'list', ordered: list.ordered, start: list.start,
        items: list.items.map(t => ({ inline: parseMarkdownInline(t) })),
      });
      list = null;
    };
    const flushAll = () => { flushPara(); flushList(); };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let m = MD_FENCE_RE.exec(line);
      if (m) {
        flushAll();
        const marker = m[1];
        const body = [];
        i++;
        while (i < lines.length) {
          const t = lines[i].trim();
          if (t.startsWith(marker) && /^[`~]+$/.test(t)) break;
          body.push(lines[i]); i++;
        }
        blocks.push({ type: 'code', lang: m[2] || '', text: body.join('\n') });
        continue;
      }
      if (!line.trim()) { flushAll(); continue; }
      m = MD_HEADING_RE.exec(line);
      if (m) {
        flushAll();
        blocks.push({ type: 'heading', level: m[1].length, inline: parseMarkdownInline(m[2].trim()) });
        continue;
      }
      m = MD_QUOTE_RE.exec(line);
      if (m) {
        flushAll();
        const q = [m[1]];
        let next;
        while (i + 1 < lines.length && (next = MD_QUOTE_RE.exec(lines[i + 1]))) { q.push(next[1]); i++; }
        blocks.push({ type: 'quote', inline: parseMarkdownInline(q.join('\n')) });
        continue;
      }
      const ul = MD_UL_RE.exec(line);
      const ol = ul ? null : MD_OL_RE.exec(line);
      if (ul || ol) {
        flushPara();
        const ordered = !!ol;
        if (!list || list.ordered !== ordered) {
          flushList();
          list = { ordered, start: ordered ? Number(ol[1]) : 1, items: [] };
        }
        list.items.push(ordered ? ol[2] : ul[1]);
        continue;
      }
      // A loose line under a list is that item wrapping, not a new paragraph.
      if (list) { list.items[list.items.length - 1] += ' ' + line.trim(); continue; }
      para.push(line);
    }
    flushAll();
    return blocks;
  }

  // ---------- assistant: validate one proposed action ----------
  const clampStr = (v, n) => String(v == null ? '' : v).slice(0, n);

  // Sanitizes the model's proposed fields the same way the import path does:
  // only keys the model actually supplied are returned, so an `update` never
  // silently blanks fields it didn't mention. Bad costs/currencies/dates drop.
  //
  // `opts.transcribed` marks fields that were READ OFF A DOCUMENT THE
  // TRAVELLER SUPPLIED (see extractBookings) rather than produced by a model.
  // That is a different kind of claim and it unlocks exactly two fields:
  // `confirmation` and a `booked` status. Both are refused from a model on
  // purpose - see the notes on each below - and neither refusal was about the
  // FIELD being dangerous, it was about a model being able to invent one.
  // Nothing else changes: a transcribed cost is still clamped, a transcribed
  // type must still be a real type, and every value still goes through the
  // same validation. A caller must opt in explicitly; the default is
  // unchanged, so every existing assistant path behaves exactly as before.
  function sanitizeActionFields(raw, opts = {}) {
    const transcribed = opts.transcribed === true;
    const f = {};
    if (typeof raw.type === 'string' && ASSIST_ACTION_TYPES.has(raw.type)) f.type = raw.type;
    if (raw.title != null) f.title = clampStr(raw.title, 120).trim();
    if (raw.location != null) f.location = clampStr(raw.location, 80).trim();
    if (raw.startDate != null) f.startDate = isIsoDate(raw.startDate) ? raw.startDate : '';
    if (raw.endDate != null) f.endDate = isIsoDate(raw.endDate) ? raw.endDate : '';
    if (raw.startTime != null) f.startTime = /^\d{2}:\d{2}$/.test(raw.startTime) ? raw.startTime : '';
    if (raw.endTime != null) f.endTime = /^\d{2}:\d{2}$/.test(raw.endTime) ? raw.endTime : '';
    // A refund is a fact about a transaction the TRAVELLER made, so only the
    // traveller may enter one. A model-supplied negative is dropped rather than
    // stored: an assistant that can post credits can make any trip look as
    // cheap as it likes, and the number lands in the "Full plan" total with no
    // deliberate act by the person paying. Positive prices are unaffected, and
    // a traveller's own refund on an existing item is never touched (an update
    // reads that back off the item, not off the model).
    if (raw.cost != null && raw.cost !== '') {
      const parsed = parseMoney(raw.cost).value;
      if (parsed != null && parsed >= 0) f.cost = parsed;
      else if (parsed == null) f.cost = null;
    }
    if (raw.costCurrency != null && /^[A-Z]{3}$/.test(raw.costCurrency)) f.costCurrency = raw.costCurrency;
    if (raw.costNote != null) f.costNote = clampStr(raw.costNote, 80).trim();
    if (raw.details != null) f.details = clampStr(raw.details, 500).trim();
    if (raw.mapsQuery != null) f.mapsQuery = clampStr(raw.mapsQuery, 200).trim();
    // `confirmation` is deliberately NOT read from a MODEL. A booking reference
    // is a fact only the traveller holds; a model can only guess one, and a
    // guessed code that looks real is worse at a check-in counter than an
    // empty field. An update never touches the traveller's own code either,
    // because the merge below only copies the keys this function returns.
    //
    // Transcribing one off the traveller's own confirmation is the opposite
    // situation: the code is not being invented, it is being copied, and the
    // reader shows the line it was copied from. So it is accepted when, and
    // only when, the caller says the fields were transcribed.
    if (transcribed && raw.confirmation != null) {
      f.confirmation = clampStr(raw.confirmation, 40).trim();
    }
    return f;
  }

  // Booked/cancelled never pass from an AI suggestion: a proposal is always
  // something the traveller still has to act on, so it lands as "to book"
  // unless the model explicitly said "decide" (decide later).
  //
  // A TRANSCRIBED item is not a suggestion. A booking confirmation is evidence
  // that the thing is already booked, so `booked` survives from that source
  // only. `cancelled` still never does: nothing in a confirmation says an item
  // is cancelled, so a reader claiming it would be reading something else.
  function forceProposalStatus(raw, transcribed) {
    if (transcribed && raw === 'booked') return 'booked';
    return raw === 'decide' ? 'decide' : 'to-book';
  }

  // A price the MODEL supplied is a guess, so the display bag carries it as an
  // estimate (estCost) and the card renders it with a tilde, exactly as the
  // accepted item will. But an `update` or a `remove` describes an item that
  // already exists, and its price is the traveller's OWN typed number: passing
  // that through estCost labelled a confirmed $800 as "~$800". So when the bag
  // is an existing item (modelPriced false) the real cost stays in `cost` and
  // only a pre-existing estimate stays an estimate.
  function displayFor(bag, status, mapsQuery, modelPriced = true) {
    const d = {
      title: bag.title || '', startDate: bag.startDate || '', startTime: bag.startTime || '',
      endDate: bag.endDate || '', estCost: null, estCostCurrency: '',
      mapsQuery: mapsQuery || '', status,
    };
    if (modelPriced) {
      d.estCost = bag.cost != null ? bag.cost : null;
      d.estCostCurrency = bag.costCurrency || '';
      return d;
    }
    if (bag.cost != null && bag.cost !== '') {
      d.cost = bag.cost;
      d.costCurrency = bag.costCurrency || '';
    }
    if (bag.estCost != null && bag.estCost !== '') {
      d.estCost = bag.estCost;
      d.estCostCurrency = bag.estCostCurrency || '';
    }
    return d;
  }

  function validateTripAction(action, trip) {
    if (!action || typeof action !== 'object') return { ok: false, reason: 'This is not a valid action.' };
    const op = action.op;
    const items = (trip && Array.isArray(trip.items)) ? trip.items : [];

    if (op === 'add') {
      const item = action.item;
      if (!item || typeof item !== 'object') return { ok: false, reason: 'This add has no item details.' };
      const title = typeof item.title === 'string' ? item.title.trim() : '';
      if (!title) return { ok: false, reason: 'This add is missing a title.' };
      if (!ASSIST_ACTION_TYPES.has(item.type)) return { ok: false, reason: 'This add has an unknown type. Use flight, transport, local, activity, stay or note.' };
      if (!isIsoDate(item.startDate)) return { ok: false, reason: 'This add needs a valid start date (YYYY-MM-DD).' };
      if (item.type === 'stay') {
        if (!isIsoDate(item.endDate) || diffDays(item.startDate, item.endDate) <= 0) {
          return { ok: false, reason: 'A stay needs a check-out date after the check-in date.' };
        }
      } else if (item.endDate != null && item.endDate !== '') {
        if (!isIsoDate(item.endDate)) return { ok: false, reason: 'The end date is not a valid date.' };
        if (diffDays(item.startDate, item.endDate) < 0) return { ok: false, reason: 'The end date is before the start date.' };
      }
      // Only an action that says so carries transcription provenance, and
      // only the document reader sets it (see importBookingText in app.js).
      const transcribed = action.source === 'document';
      const status = forceProposalStatus(item.status, transcribed);
      const fields = sanitizeActionFields(item, { transcribed });
      const proposal = { op: 'add', status, fields, display: displayFor(fields, status, fields.mapsQuery) };
      // Carried so the item builder can tell a transcribed fact from a model's
      // guess: a price printed on a confirmation the traveller paid belongs in
      // `cost`, not in the estimate bag.
      if (transcribed) proposal.transcribed = true;
      // Alternative sets: the model has put the group on the action in some
      // replies and on the item in others, so accept either. Absent group means
      // a plain single proposal, exactly as before.
      const group = clampStr(action.group != null ? action.group : item.group, 60).trim();
      if (group) proposal.group = group;
      return { ok: true, proposal };
    }

    if (op === 'update' || op === 'remove') {
      const match = action.match || {};
      const id = match.id != null && String(match.id).trim() !== '' ? String(match.id) : '';
      const title = match.title != null && String(match.title).trim() !== '' ? String(match.title).trim() : '';
      if (!id && !title) return { ok: false, reason: 'An update or remove needs an id or a title to match.' };
      let found = id ? items.filter(it => it.id === id) : [];
      if (!found.length && title) {
        const t = title.toLowerCase();
        found = items.filter(it => (it.title || '').trim().toLowerCase() === t);
      }
      if (!found.length) return { ok: false, reason: 'No matching item found.' };
      if (found.length > 1) return { ok: false, reason: 'Multiple items match, name it more specifically.' };
      const target = found[0];

      if (op === 'remove') {
        return { ok: true, proposal: { op: 'remove', targetId: target.id, status: target.status, display: displayFor(target, target.status, '', false) } };
      }
      const raw = action.set || action.item || {};
      // forceProposalStatus exists so the model can never CLAIM something is
      // booked, so an explicitly proposed status still goes through it. An
      // update that says nothing about status must leave it exactly as it is:
      // forcing it there un-booked the traveller's own confirmed reservation
      // (and its money) over a change of address.
      const status = raw.status != null ? forceProposalStatus(raw.status) : target.status;
      const fields = sanitizeActionFields(raw);
      const merged = { ...target, ...fields };
      const display = displayFor(merged, status, fields.mapsQuery, 'cost' in fields);
      return { ok: true, proposal: { op: 'update', targetId: target.id, status, fields, display } };
    }

    return { ok: false, reason: 'Unknown operation. Use add, update or remove.' };
  }

  // ---------- assistant: prompt builders ----------
  const ASSIST_SCHEMA = 'Each item has: type (one of flight, transport, local, activity, stay, note), '
    + 'title, location, startDate (YYYY-MM-DD), startTime (HH:MM, 24h), endDate (YYYY-MM-DD, '
    + 'the check-out date for a stay or the arrival date for an overnight leg), endTime (HH:MM), '
    + 'cost (a number), costCurrency (a 3-letter code like USD), details, and mapsQuery '
    + '(the name of one specific venue plus its city, opened on Google Maps so the traveller '
    + 'can verify hours, prices and reviews).';

  const ASSIST_CONTRACT = 'When you want to add, change or remove items, include a JSON object '
    + 'in a ```json fenced block shaped exactly like '
    + '{"tripActions":[{"op":"add","item":{...}},{"op":"update","match":{"title":"..."},"set":{...}},'
    + '{"op":"remove","match":{"title":"..."}}]}. '
    + 'Use op "add" with a full item, optionally with a "group" string next to "op" when the add is '
    + 'one of several alternatives for the same slot, "update" with a match (by id or exact title) and the fields to set, '
    + 'or "remove" with a match. Never set status to booked or cancelled. '
    + 'Never introduce a slot type the traveller did not request. '
    + 'Write your normal explanation as plain prose around the JSON block.';

  // Fed to ALL THREE tiers from this one place, including the copy/paste package
  // handed to an external AI, so one edit covers every path a model reads.
  //
  // The entry-requirements clause is not decoration. Without it the model
  // answers "do I need a visa for Japan on a Korean passport?" fluently,
  // unhedged and ungrounded, and a traveller who believes it either buys an
  // authorization they do not need or, worse, is told they need nothing when
  // they do. It is the same class of harm the visa dialog's own confidence gate
  // exists to prevent, so the wording is deliberately absolute: refuse, then
  // point at the government source.
  const ASSIST_HONESTY = 'You cannot check live reviews, prices or availability. For anything you '
    + 'suggest, include a mapsQuery so the traveller can open Google Maps and verify hours, prices '
    + 'and reviews themselves. '
    + 'NEVER state entry requirements as fact. That includes visas, visa-free days, eTA or ESTA style '
    + 'authorizations, passport validity rules, onward-ticket rules, vaccination or health entry rules, '
    + 'international driving permits, and customs or currency limits. These change without notice, differ '
    + 'by nationality, and can differ again for a transit or a layover, and you have no way to check them. '
    + 'If the traveller asks about any of them, say plainly that you cannot confirm it and that they must '
    + "check the destination government's official immigration site or its embassy for their own "
    + 'nationality before booking. Never guess, never quote a number of visa-free days, and never reassure '
    + 'them that nothing is required.';

  // The agenda rules exist because of real failures in production replies: one
  // fat "New Year's Eve in Tokyo" item with the whole timetable stuffed into
  // details, meals dropped to two of three, no way home at night, and restaurant
  // names in the prose that no action ever created.
  const ASSIST_AGENDA = 'When you plan a day, emit ONE add action per agenda entry, each with its '
    + 'own startTime (and endTime where it helps). Never pack a timetable into a single item. '
    + 'WRONG: one activity titled "New Year\'s Eve in Tokyo" whose details read '
    + '"09:30 Breakfast. 10:15-12:00 Hie Shrine. 12:30-14:00 Lunch...". That is a broken answer: '
    + 'the traveller cannot move, cost or book any of those separately. '
    + 'RIGHT: a separate add action for breakfast, for Hie Shrine, for lunch, and so on. '
    + 'Plan exactly the slots the traveller asked for: never drop one they asked for, and never '
    + 'add one they did not. If they ask for breakfast and nothing else, the day has breakfast '
    + 'and no lunch, no dinner, no drinks and no activities. '
    + 'If the traveller gave a time to be back, add one local action per planned day titled '
    + '"Return to hotel" with a startTime no later than that time (type "local", never "transport": '
    + 'the ride home is inside the city and does not move the trip anywhere). '
    + 'Every venue you name in your prose must have a matching add action carrying a mapsQuery. '
    + 'Never name a restaurant, bar or sight in prose without the action that puts it on the trip.';

  // Every example below is a real mapsQuery from a production reply that sent
  // the traveller to the wrong place: a category cannot resolve to a venue, so
  // Google Maps lands wherever it likes and the "Verify" link lies.
  const ASSIST_MAPSQUERY = 'A mapsQuery must be the SPECIFIC, searchable name of ONE real venue '
    + 'plus its city or neighbourhood. Never a category, a cuisine, a meal, an area or a '
    + 'description: those cannot resolve to a place, so the traveller is sent somewhere you did '
    + 'not mean. '
    + 'WRONG: "Roppongi sushi restaurants". RIGHT: "Sukiyabashi Jiro Roppongi Tokyo". '
    + 'WRONG: "Breakfast near Akasaka Tokyo". RIGHT: "Bricolage Bread & Co Roppongi Tokyo". '
    + 'WRONG: mapsQuery "Shibuya Crossing Tokyo" on an item titled "New Year\'s Eve in Tokyo"; '
    + 'the item must be split per venue and each part carries the venue it is actually about. '
    + 'A "Return to hotel" action carries the actual hotel name taken from the trip JSON, for '
    + 'example "Hotel Okura Tokyo", never "hotel", "our hotel" or "back to the hotel". '
    + 'If an item has no single place (a travel leg, a note, a reminder), omit mapsQuery '
    + 'entirely. No link is better than a link to the wrong place.';

  // HOW an alternative set is expressed is a permanent contract (the pick-one
  // card is built on the shared group id). HOW MANY candidates there are is
  // not: it belongs to whoever is asking. Conflating the two is exactly the bug
  // this split fixes - the guided picker's "exactly 3" lived in the SYSTEM
  // prompt, so it applied to every free-form turn of every conversation, and
  // the assistant answered "give me 5 options" with "my instructions require
  // exactly 3". The mechanic below ships in both modes; the counts do not.
  const ASSIST_GROUPS_MECHANIC = 'When you offer several alternatives for the SAME slot, give every '
    + 'candidate of that slot the same "group" value on its action, for example '
    + '{"op":"add","group":"dinner-2026-12-31","item":{...}}, so the traveller picks one of them. '
    + 'Use a distinct group per slot ("breakfast-2026-12-31", "lunch-2026-12-31", '
    + '"drinks-2026-12-31") and never reuse one group id across two different slots. '
    + 'Transport, local hops, stays and notes are NEVER grouped: each of those is a single proposal.';

  // GUIDED "Plan my day" only. The picker's own request text already asks for
  // these counts in words ("give me 3 options for each one"); this is the same
  // contract stated to the model as a rule so a busy day cannot quietly drop to
  // two dinners. It must never be sent on a free-form turn.
  const PLAN_MEAL_OPTIONS = 3;
  const PLAN_ACTIVITY_OPTIONS = 2;
  const ASSIST_OPTIONS_PLAN = 'For each meal slot and each drinks slot the traveller asked for (and only '
    + `those), propose EXACTLY ${PLAN_MEAL_OPTIONS} candidates grouped as above, so the traveller picks one of them. `
    + `For every OTHER activity you suggest (a sight, a museum, a walk, a tour), propose EXACTLY ${PLAN_ACTIVITY_OPTIONS} `
    + 'candidates for that one slot, grouped the same way under a group id of their own, for '
    + 'example "activity-2026-12-31-morning": one slot, two options, the traveller picks one.';

  // FREE-FORM chat only, and deliberately WITHOUT a number in it. An earlier
  // version of this capped chat at 8 per slot, which just replaced one
  // arbitrary product rule ("exactly 3") with a slightly larger one: a
  // traveller who asks for ten restaurants is not doing anything the app cannot
  // render, and being told "8 is the most I can show" is the same unexplained
  // refusal in a different costume.
  //
  // There IS a real ceiling, but it is a reply-size one, not a count: a Gemini
  // turn is capped at GENERATION_CONFIG.maxOutputTokens (netlify/functions/
  // tp-assist.mjs) and the ```json block sits at the END of the answer, so
  // overrunning it truncates exactly the part that becomes the cards. That is
  // handled where it actually lives - the server appends TRUNCATION_NOTE when
  // Gemini reports MAX_TOKENS - and stated here as the graceful degradation the
  // model should choose FIRST: cover what fits, say how much, offer the rest.
  // Splitting an answer is a much better failure than silently losing its tail.
  const ASSIST_OPTIONS_CHAT = 'How MANY options to offer is the traveller\'s call, never a fixed rule of yours. '
    + 'If they ask for a number ("give me 5 options", "show me 8 restaurants", "give me 10"), give exactly that many. '
    + 'If they ask for "more options", "other options" or "everything from my list that fits", give more than you gave '
    + 'last time and do not repeat what you already offered. '
    + `If they name no number at all, ${PLAN_MEAL_OPTIONS} candidates for a meal or drinks slot and ${PLAN_ACTIVITY_OPTIONS} for any other activity is a sensible default. `
    + 'You have no maximum and no minimum, so NEVER tell the traveller that your instructions fix, cap or require a '
    + 'particular number of options. '
    + 'The one real limit is that a single reply has to be complete: the fenced JSON block must be finished, because a '
    + 'cut-off answer loses the suggestions rather than shortening them. If what they asked for is genuinely too much '
    + 'for one answer, give as many as you can fully write out, say plainly how many that is, and offer to continue in '
    + 'the next message. Never silently drop the rest, and never refuse the request outright.';

  // The item types are the app's storage schema and cannot grow beyond these
  // six, so meals and drinks ride on `activity` with the kind spelled out in
  // the title prefix. The transport/local split is what keeps the night-coverage
  // and continuity warnings honest: only a between-cities leg can stand in for a
  // hotel or explain a change of city.
  const ASSIST_KINDS = 'The type field is limited to flight, transport, local, activity, stay and note, '
    + 'and never anything else. Use "transport" for travel BETWEEN cities (a train, bus, ferry or car '
    + 'leg from one city to the next) and "local" for getting around WITHIN one city (a metro hop, '
    + 'a taxi across town, the ride back to the hotel). '
    + 'Meals and drinks are type "activity". Carry the kind in the title '
    + 'as one of these literal prefixes: "Breakfast: ", "Lunch: ", "Dinner: ", "Drinks: " '
    + 'followed by the venue name, for example "Dinner: Narisawa".';

  // The app is not the model. It holds cached coordinates for the trip's places
  // and draws a straight-line distance chip on every suggestion card it renders,
  // which is why "I do not have access to live GPS or real-time traffic data, so
  // I cannot calculate or display the specific travel distance" was both true of
  // the model and wrong about the product it was answering inside: the number
  // was already on screen, and the sentence talked the traveller out of reading
  // it. The other half of the rule matters just as much - knowing the card
  // carries a figure is not permission to invent one in prose.
  const ASSIST_DISTANCE = 'This app measures distance itself. Every venue you suggest is rendered on a '
    + 'card that already shows how far it is from where the traveller is starting, in km and miles, '
    + "computed from the app's own stored coordinates for those places. So NEVER say that you cannot "
    + 'give distances, and never explain that you lack GPS, live traffic, maps or location access: '
    + 'the traveller can see the figure. '
    + 'What you must not do is invent one. Do not state a distance, a walking time, a driving time, a '
    + 'fare or a journey time as a fact in your prose unless it is given to you above. Describe '
    + 'proximity only in words you can support from what you know of the city ("in Sukhumvit, close '
    + 'to your hotel", "the other side of the river"), and let the card carry the number.';

  // The origin is the fact a "which of these is most convenient" question turns
  // on, and the model had no way to know it: the trip JSON says where the
  // traveller sleeps but not where they are standing at 8pm on the day being
  // planned. This is the same origin the cards are measured from, so the prose
  // and the chips can never disagree about where the day starts.
  const ORIGIN_WHY = {
    stay: 'the place they are booked into that night',
    arrival: 'where they arrive that day',
    item: 'the last thing already on their plan before then',
    city: 'the city they are in that day',
  };
  function assistOriginNote(origin) {
    const o = origin && typeof origin === 'object' ? origin : null;
    const label = o ? String(o.label == null ? '' : o.label).trim() : '';
    if (!label) return '';
    const why = ORIGIN_WHY[o.source] || 'where they are that day';
    const city = String(o.city == null ? '' : o.city).trim();
    const when = isIsoDate(o.date) ? ` on ${o.date}` : '';
    return `The traveller is based${when} at ${label}${city && city !== label ? ` in ${city}` : ''} - ${why}. `
      + 'Measure convenience from there: prefer places that are genuinely near it, or near whatever you '
      + 'have already suggested earlier the same day, and say which one you are treating as the starting point. '
      + 'Each card is then measured from wherever the traveller will actually be at that hour, which is this '
      + 'place unless something you suggested earlier that day has moved them.';
  }

  // Guided "Plan my day" and free-form chat differ in exactly one paragraph, and
  // the default is `chat`: an unknown or missing mode must never inherit the
  // picker's fixed counts, which is the failure this whole split exists to stop.
  function assistOptionRules(mode) {
    return mode === 'plan' ? ASSIST_OPTIONS_PLAN : ASSIST_OPTIONS_CHAT;
  }

  function buildAssistPackage({ trip, focusDate, request, mode, origin }) {
    const parts = [];
    parts.push('You are a travel-planning assistant helping edit a trip itinerary.');
    parts.push(ASSIST_HONESTY);
    parts.push('Here is the current trip as JSON:');
    parts.push(JSON.stringify(slimTripForShare(trip)));
    parts.push(ASSIST_SCHEMA);
    parts.push(ASSIST_CONTRACT);
    parts.push(ASSIST_KINDS);
    parts.push(ASSIST_AGENDA);
    parts.push(ASSIST_GROUPS_MECHANIC);
    parts.push(assistOptionRules(mode));
    parts.push(ASSIST_MAPSQUERY);
    parts.push(ASSIST_DISTANCE);
    const originNote = assistOriginNote(origin);
    if (originNote) parts.push(originNote);
    if (focusDate && isIsoDate(focusDate)) parts.push(`The traveller is focused on this day: ${focusDate}.`);
    parts.push('The traveller asks:');
    parts.push(String(request == null ? '' : request).trim());
    return parts.join('\n\n');
  }

  // ---------- assistant: fitting a heavy trip into the request cap ----------
  // The Tier 3 request body is size-capped server-side. A trip of roughly forty
  // items carrying long descriptions exceeded it and the WHOLE request was
  // rejected with a bare 400, so the traveller saw the assistant fail with no
  // explanation and no way to act on it.
  //
  // Trimming beats rejecting, but only in this order. The model reasons over
  // the structural facts (dates, titles, types, locations, status, costs); free
  // text `details` is the only field that is both large (500 chars an item) and
  // not load-bearing, so it goes first and it goes alone. Structural facts are
  // never dropped: a trip missing items is a trip the assistant would give
  // wrong answers about, which is worse than no answer.
  //
  // Measurement is JSON.stringify of the WHOLE context, which is the same
  // quantity the server enforces, so there is one definition of "too big".
  const ASSIST_DETAILS_BUDGET = 120;

  function withAssistDetails(ctx, fn) {
    const items = ctx.trip.items.map(it => {
      const next = { ...it };
      const kept = fn(String(it.details == null ? '' : it.details));
      if (kept) next.details = kept; else delete next.details;
      return next;
    });
    return { ...ctx, trip: { ...ctx.trip, items } };
  }

  // Returns { ok, ctx, truncated, reason }. The two failures are NOT the same
  // thing and must not get the same answer:
  //   'untrimmable'  - oversize with no trip in it at all. That is a malformed
  //                    body, and the caller should answer as it always has.
  //   'still_too_big'- a real trip whose dates and titles alone exceed the cap.
  //                    Retrying can never succeed, so the caller has to say so
  //                    in its own words.
  function fitAssistContext(ctx, limit) {
    const size = o => JSON.stringify(o).length;
    if (!ctx || typeof ctx !== 'object') return { ok: false, ctx, truncated: false, reason: 'untrimmable' };
    if (size(ctx) <= limit) return { ok: true, ctx, truncated: false, reason: '' };
    if (!ctx.trip || !Array.isArray(ctx.trip.items) || !ctx.trip.items.length) {
      return { ok: false, ctx, truncated: false, reason: 'untrimmable' };
    }
    const clamped = withAssistDetails(ctx, d => d.slice(0, ASSIST_DETAILS_BUDGET));
    if (size(clamped) <= limit) return { ok: true, ctx: clamped, truncated: true, reason: '' };
    const stripped = withAssistDetails(ctx, () => '');
    if (size(stripped) <= limit) return { ok: true, ctx: stripped, truncated: true, reason: '' };
    return { ok: false, ctx: stripped, truncated: true, reason: 'still_too_big' };
  }

  // Whatever was dropped, the model MUST be told, or it reasons about a
  // shortened trip as if it were the whole trip: "you have no dinner plans"
  // when six were trimmed away is worse than the honest failure this replaced.
  const ASSIST_TRUNCATED_NOTE = 'IMPORTANT: the trip JSON below was SHORTENED to fit a size limit. '
    + 'Every item is present, and every date, title, type, location, status and cost is complete and accurate. '
    + 'What is missing is the free-text description on some or all items: those were cut short or removed. '
    + 'Never say or imply that an item has no notes, and never describe the trip as if the descriptions you can see are all that exist. '
    + 'If a description would change your answer, ask the traveller about that item instead of guessing.';

  function buildAssistSystemPrompt({ trip, focusDate, today, truncated, mode, origin }) {
    const parts = [];
    parts.push('You are a travel-planning assistant helping edit a trip itinerary.');
    parts.push(ASSIST_HONESTY);
    parts.push(ASSIST_SCHEMA);
    parts.push(ASSIST_CONTRACT);
    parts.push(ASSIST_KINDS);
    parts.push(ASSIST_AGENDA);
    parts.push(ASSIST_GROUPS_MECHANIC);
    parts.push(assistOptionRules(mode));
    parts.push(ASSIST_MAPSQUERY);
    parts.push(ASSIST_DISTANCE);
    const originNote = assistOriginNote(origin);
    if (originNote) parts.push(originNote);
    if (today && isIsoDate(today)) parts.push(`Today is ${today}.`);
    if (focusDate && isIsoDate(focusDate)) parts.push(`The traveller is focused on this day: ${focusDate}.`);
    // The server (netlify/functions/tp-assist.mjs) builds this from a network
    // payload, so a trip may legitimately be missing here; the client always
    // has one.
    if (trip && Array.isArray(trip.items)) {
      // adjacent to the JSON on purpose: a caveat several paragraphs above the
      // data it qualifies is a caveat the model drops
      if (truncated) parts.push(ASSIST_TRUNCATED_NOTE);
      parts.push('Here is the current trip as JSON:');
      parts.push(JSON.stringify(slimTripForShare(trip)));
    }
    return parts.join('\n\n');
  }

  // ---------- example trips ----------
  // A small curated library of illustrative itineraries, one per destination.
  // These are SAMPLE DATA: every price is a rough round placeholder, never a
  // quote, a fare or live availability, and every named venue carries a
  // mapsQuery so the traveller can check it themselves. Nothing here claims
  // opening hours, ratings or "from" prices, because none of that can be kept
  // true in a static file.
  //
  // Each template runs 7 to 30 days and shares the same backbone: an inbound
  // international flight from ANOTHER country, a stay, an intercity leg by
  // whatever mode actually fits the country (rail, road, ferry or a domestic
  // flight) for every hop between stays, and the flight home. What varies on
  // purpose is the SHAPE: a seven day Iceland road trip carries a handful of
  // stops and long drives between them, Croatia leaves whole days deliberately
  // blank, Peru and Japan run four or five things a day, Thailand is packed in
  // the city half and near empty on the beach, and the USA runs a month coast
  // to coast through eighteen overnight stops rather than the two every other
  // template settles into. Budgets vary too, from a backpacker Vietnam to a
  // splurge Iceland, because the money formatting and the currency conversion
  // path deserve a spread as much as the itinerary does. The data is also the
  // app's regression fixture, so every template
  // deliberately contains an estimate, a foreign-currency cost, a long
  // description, an untimed item, a cancelled item and a `local` leg, while
  // deliberately containing NO uncovered nights, date collisions or continuity
  // gaps: those render as warnings and would read as bugs to someone opening
  // the app for the first time. Empty days are not warnings, because the nights
  // are still covered by a stay.
  //
  // Item spec keys (expanded by buildSampleTrip):
  //   d/end   day offsets from the trip's first day
  //   time/endTime  HH:MM
  //   cost + cur    a typed cost; `cur` omitted means the trip's own currency
  //   est           an assistant-style estimate (never counted in any total)
  //   note          costNote
  //   maps          mapsQuery
  //
  // Every template also carries its OWN `startOffset`: how many days after
  // today its first day falls. They are deliberately spread rather than shared,
  // so the library shows a trip that starts TODAY (mid-trip chips, "Day 1 of 7",
  // the near-term forecast chip), one a week out, one a fortnight out, one a
  // month out, and the rest fanned across the next half year. Everything stays
  // relative to the current date, so no sample ever rots into the past.
  // SAMPLE_START_OFFSET is only the fallback for a template that names none.
  const SAMPLE_START_OFFSET = 45;

  // Added to every template so the sample always says what it is. Untimed on
  // purpose: it is also the "No time set" fixture.
  const SAMPLE_NOTE = {
    d: 0, type: 'note', title: 'About this example trip',
    details: 'Illustrative sample data, not a recommendation and not live availability. '
      + 'Costs are rough round placeholders rather than quotes, and every venue carries a Maps link '
      + 'so you can check it yourself. Edit or delete anything here, or clear it all and start fresh.',
  };

  const SAMPLE_TRIPS = [
    {
      // 7 days, road trip, few stops and long drives. The splurge end of the
      // budget spread.
      id: 'iceland',
      startOffset: 0,
      label: 'Iceland (Reykjavik and Akureyri)',
      summary: 'Red-eye from Boston, three nights in Reykjavik, the long drive north to Akureyri',
      keywords: ['iceland', 'reykjavik', 'akureyri', 'keflavik'],
      localCurrency: 'ISK',
      items: [
        { d: 0, end: 1, type: 'flight', title: 'Boston (BOS) to Keflavik (KEF)', time: '21:30', endTime: '06:45', status: 'booked', cost: 780, details: 'Red-eye, lands at breakfast time.' },
        { d: 1, type: 'local', title: 'Flybus to Reykjavik', time: '08:00', status: 'booked', cost: 40 },
        { d: 1, end: 4, type: 'stay', title: 'Hotel Borg', location: 'Reykjavik', status: 'booked', cost: 1350, maps: 'Hotel Borg Reykjavik', details: 'Three nights on Austurvollur square.' },
        { d: 1, type: 'activity', title: 'Hallgrimskirkja tower', location: 'Reykjavik', cost: 12, maps: 'Hallgrimskirkja Reykjavik', details: 'No time set: the lift runs all day and this is a fill-in whenever the light looks right.' },
        { d: 1, type: 'activity', title: 'Dinner: Grillmarkadurinn', location: 'Reykjavik', time: '19:30', est: 95, maps: 'Grillmarkadurinn Reykjavik' },
        { d: 2, type: 'activity', title: 'Golden Circle self drive', location: 'Reykjavik', time: '08:30', cost: 240, maps: 'Thingvellir National Park Iceland', details: 'One long loop out of the city and back: the rift valley at Thingvellir, the geyser field at Haukadalur and the two-tier drop at Gullfoss, with roughly three hours of driving spread across the day. The rental car and its fuel are the whole cost here, since none of the three stops charges to walk in.' },
        { d: 2, type: 'activity', title: 'Dinner: Fiskfelagid', location: 'Reykjavik', time: '20:00', est: 110, maps: 'Fiskfelagid Reykjavik' },
        { d: 3, type: 'activity', title: 'Blue Lagoon', location: 'Grindavik', time: '10:00', status: 'booked', cost: 14000, cur: 'ISK', maps: 'Blue Lagoon Iceland', details: 'Entry is by timed slot and the site sits between the airport and the city, so it works as either a first day or a last day stop. Bring your own towel if you would rather not rent one, and the silica mask queue is shortest right at opening.' },
        { d: 3, type: 'activity', title: 'Lunch: Baejarins Beztu Pylsur', location: 'Reykjavik', time: '14:30', est: 12, maps: 'Baejarins Beztu Pylsur Reykjavik' },
        { d: 3, type: 'activity', title: 'Cancelled: Northern lights boat tour', location: 'Reykjavik', time: '21:00', status: 'cancelled', maps: 'Old Harbour Reykjavik', details: 'Called off for weather. Operators normally rebook, and this row stays as the reminder to claim that.' },
        { d: 4, type: 'transport', title: 'Reykjavik to Akureyri', time: '09:00', endTime: '16:30', status: 'booked', cost: 260, details: 'The drive north on Route 1, about four and a half hours of road plus stops at Hvitserkur and the Kolugljufur canyon. Iceland has no passenger railway, so the ring road or a domestic hop are the only two ways to do this leg.' },
        { d: 4, end: 6, type: 'stay', title: 'Hotel Kea', location: 'Akureyri', status: 'booked', cost: 720, maps: 'Hotel Kea Akureyri', details: 'Two nights by the church steps.' },
        { d: 4, type: 'activity', title: 'Dinner: Strikid', location: 'Akureyri', time: '19:30', est: 85, maps: 'Strikid Akureyri' },
        { d: 5, type: 'activity', title: 'Godafoss and Lake Myvatn', location: 'Akureyri', time: '09:00', cost: 40, maps: 'Godafoss Waterfall Iceland' },
        { d: 5, type: 'activity', title: 'Myvatn Nature Baths', location: 'Myvatn', time: '15:00', cost: 75, maps: 'Myvatn Nature Baths' },
        { d: 6, type: 'flight', title: 'Akureyri (AEY) to Boston (BOS)', time: '08:20', cost: 690, details: 'Domestic leg to Keflavik first, then the transatlantic flight.' },
      ],
    },
    {
      // 8 days, city and coast, an even moderate pace throughout.
      id: 'portugal',
      startOffset: 7,
      label: 'Portugal (Lisbon and Porto)',
      summary: 'Fly in from Dublin, four nights in Lisbon, train up to Porto',
      keywords: ['portugal', 'lisbon', 'lisboa', 'porto', 'oporto', 'sintra', 'algarve'],
      localCurrency: 'EUR',
      items: [
        { d: 0, type: 'flight', title: 'Dublin (DUB) to Lisbon (LIS)', time: '09:50', endTime: '13:00', status: 'booked', cost: 150 },
        { d: 0, type: 'local', title: 'Airport metro to Baixa', time: '14:00', status: 'booked', cost: 4 },
        { d: 0, end: 4, type: 'stay', title: 'Lisboa Pessoa Hotel', location: 'Lisbon', status: 'booked', cost: 560, maps: 'Lisboa Pessoa Hotel', details: 'Four nights between Baixa and Bairro Alto.' },
        { d: 0, type: 'activity', title: 'Dinner: Cervejaria Ramiro', location: 'Lisbon', time: '20:00', est: 45, maps: 'Cervejaria Ramiro Lisbon' },
        { d: 1, type: 'activity', title: 'Jeronimos Monastery and Belem Tower', location: 'Lisbon', time: '09:30', status: 'booked', cost: 18, cur: 'EUR', maps: 'Jeronimos Monastery Lisbon', details: 'Both sit in Belem, a tram ride west of the centre, and the cloister is the part worth the wait rather than the church itself. The pastel shop everyone queues at is two minutes away, so plan the order that suits your patience.' },
        { d: 1, type: 'activity', title: 'Lunch: Time Out Market Lisboa', location: 'Lisbon', time: '13:30', est: 20, maps: 'Time Out Market Lisboa' },
        { d: 1, type: 'activity', title: 'Drinks: Park rooftop bar', location: 'Lisbon', time: '18:30', est: 15, maps: 'Park Bar Lisbon' },
        { d: 2, type: 'activity', title: 'Day trip to Sintra: Pena Palace', location: 'Sintra', time: '08:30', cost: 35, maps: 'Pena Palace Sintra' },
        { d: 2, type: 'activity', title: 'Quinta da Regaleira and the initiation well', location: 'Sintra', time: '13:30', cost: 15, maps: 'Quinta da Regaleira Sintra' },
        { d: 2, type: 'local', title: 'Return to hotel', location: 'Lisbon', time: '19:30', maps: 'Lisboa Pessoa Hotel' },
        { d: 2, type: 'activity', title: 'Cancelled: Fado night in Alfama', location: 'Lisbon', time: '21:00', status: 'cancelled', maps: 'Clube de Fado Lisbon', details: 'Moved to the Porto half of the trip instead. Left here rather than deleted so the idea is not lost.' },
        { d: 3, type: 'activity', title: 'Tram 28 and the Alfama lanes', location: 'Lisbon', cost: 4, maps: 'Praca Martim Moniz Lisbon', details: 'No time set on purpose: the queue at Martim Moniz decides this one, not the plan.' },
        { d: 3, type: 'activity', title: 'Lunch: Taberna da Rua das Flores', location: 'Lisbon', time: '13:00', est: 30, maps: 'Taberna da Rua das Flores Lisbon' },
        { d: 4, type: 'transport', title: 'Lisbon to Porto', time: '10:00', endTime: '13:00', status: 'booked', cost: 40, details: 'Alfa Pendular from Santa Apolonia. Every seat is reserved, so book ahead.' },
        { d: 4, end: 7, type: 'stay', title: 'Torel Avantgarde', location: 'Porto', status: 'booked', cost: 480, maps: 'Torel Avantgarde Porto', details: 'Three nights above the river.' },
        { d: 4, type: 'activity', title: 'Dinner: Cantina 32', location: 'Porto', time: '19:30', est: 30, maps: 'Cantina 32 Porto' },
        { d: 5, type: 'activity', title: 'Livraria Lello', location: 'Porto', time: '09:30', cost: 8, maps: 'Livraria Lello Porto' },
        { d: 5, type: 'activity', title: 'Port cellar visit in Vila Nova de Gaia', location: 'Porto', time: '15:00', cost: 25, maps: 'Taylors Port Cellar Vila Nova de Gaia' },
        { d: 5, type: 'activity', title: 'Dinner: Casa Guedes', location: 'Porto', time: '19:00', est: 12, maps: 'Casa Guedes Porto' },
        { d: 6, type: 'activity', title: 'Douro river cruise, six bridges', location: 'Porto', time: '11:00', cost: 20, maps: 'Cais da Ribeira Porto' },
        { d: 6, type: 'activity', title: 'Serralves museum and park', location: 'Porto', time: '15:00', cost: 22, maps: 'Serralves Porto' },
        { d: 6, type: 'activity', title: 'Drinks: Capela Incomum', location: 'Porto', time: '19:00', est: 15, maps: 'Capela Incomum Porto' },
        { d: 7, type: 'flight', title: 'Porto (OPO) to Dublin (DUB)', time: '13:25', cost: 140 },
      ],
    },
    {
      // 8 days, medina and desert. The desert is a day out rather than an
      // overnight camp: the fixture keeps exactly two stays so the intercity
      // leg and the night coverage stay unambiguous.
      id: 'morocco',
      startOffset: 14,
      label: 'Morocco (Marrakesh and Fez)',
      summary: 'Fly in from Paris, four nights in Marrakesh, train across to Fez',
      keywords: ['morocco', 'marrakesh', 'marrakech', 'fez', 'fes', 'casablanca', 'tangier'],
      localCurrency: 'MAD',
      items: [
        { d: 0, type: 'flight', title: 'Paris (ORY) to Marrakesh (RAK)', time: '10:25', endTime: '12:45', status: 'booked', cost: 190 },
        { d: 0, type: 'local', title: 'Airport taxi to the medina gate', time: '13:30', status: 'booked', cost: 15, details: 'Cars cannot reach most riads, so the last stretch is on foot.' },
        { d: 0, end: 4, type: 'stay', title: 'Riad Yasmine', location: 'Marrakesh', status: 'booked', cost: 460, maps: 'Riad Yasmine Marrakech', details: 'Four nights inside the medina walls.' },
        { d: 0, type: 'activity', title: 'Dinner: Nomad', location: 'Marrakesh', time: '19:30', est: 35, maps: 'Nomad Marrakech' },
        { d: 1, type: 'activity', title: 'Bahia Palace', location: 'Marrakesh', time: '09:00', status: 'booked', cost: 100, cur: 'MAD', maps: 'Bahia Palace Marrakech', details: 'A nineteenth century palace built around courtyards rather than corridors, which is the whole point of it: the rooms are arranged so that no two open onto each other. Early is cooler and the light in the painted ceilings is better before midday.' },
        { d: 1, type: 'activity', title: 'Lunch: Cafe des Epices', location: 'Marrakesh', time: '13:00', est: 15, maps: 'Cafe des Epices Marrakech' },
        { d: 1, type: 'activity', title: 'Jemaa el-Fnaa at dusk', location: 'Marrakesh', maps: 'Jemaa el-Fnaa Marrakech', details: 'Left untimed: the square fills when it fills, somewhere between the late afternoon call to prayer and full dark.' },
        { d: 2, type: 'activity', title: 'Agafay desert day: camel ride and dinner under canvas', location: 'Agafay', time: '15:00', cost: 120, maps: 'Agafay Desert Morocco', details: 'The stony desert an hour outside the city rather than the dunes, which are a long way south and not a day trip from here. Camps run an afternoon ride, dinner and a drive back, so this is a late evening rather than an overnight.' },
        { d: 2, type: 'local', title: 'Return to the riad', location: 'Marrakesh', time: '23:00', maps: 'Riad Yasmine Marrakech' },
        { d: 2, type: 'activity', title: 'Cancelled: Hammam and spa afternoon', location: 'Marrakesh', time: '15:00', status: 'cancelled', maps: 'Les Bains de Marrakech', details: 'Bumped to make room for the desert day. Kept on the plan so it can be slotted back in.' },
        { d: 3, type: 'activity', title: 'Jardin Majorelle and the Yves Saint Laurent museum', location: 'Marrakesh', time: '09:30', cost: 30, maps: 'Jardin Majorelle Marrakech' },
        { d: 3, type: 'activity', title: 'Souks of the Mellah and the spice market', location: 'Marrakesh', time: '15:00', maps: 'Mellah Marrakech' },
        { d: 3, type: 'activity', title: 'Dinner: Le Jardin', location: 'Marrakesh', time: '20:00', est: 30, maps: 'Le Jardin Marrakech' },
        { d: 4, type: 'activity', title: 'Breakfast: Bacha Coffee Marrakech', location: 'Marrakesh', time: '08:00', est: 20, maps: 'Bacha Coffee Marrakech' },
        { d: 4, type: 'transport', title: 'Marrakesh to Fez', time: '10:00', endTime: '17:30', status: 'booked', cost: 45, details: 'ONCF train, a long daytime run across the country. Book the seat rather than turning up.' },
        { d: 4, end: 7, type: 'stay', title: 'Riad Fes', location: 'Fez', status: 'booked', cost: 520, maps: 'Riad Fes Morocco', details: 'Three nights above the old city.' },
        { d: 4, type: 'activity', title: 'Dinner: The Ruined Garden', location: 'Fez', time: '20:00', est: 25, maps: 'The Ruined Garden Fez' },
        { d: 5, type: 'activity', title: 'Fes el-Bali medina walk with a guide', location: 'Fez', time: '09:00', cost: 45, maps: 'Bab Boujloud Fez' },
        { d: 5, type: 'activity', title: 'Chouara tannery viewpoint', location: 'Fez', time: '11:30', maps: 'Chouara Tannery Fez' },
        { d: 5, type: 'activity', title: 'Drinks: mint tea at Cafe Clock', location: 'Fez', time: '17:00', est: 10, maps: 'Cafe Clock Fez' },
        { d: 6, type: 'activity', title: 'Al-Attarine Madrasa', location: 'Fez', time: '09:00', cost: 8, maps: 'Al-Attarine Madrasa Fez' },
        { d: 6, type: 'activity', title: 'Volubilis Roman ruins and Meknes', location: 'Volubilis', time: '12:00', cost: 70, maps: 'Volubilis Morocco' },
        { d: 6, type: 'activity', title: 'Dinner: Nur', location: 'Fez', time: '20:30', est: 55, maps: 'Nur Restaurant Fez' },
        { d: 7, type: 'flight', title: 'Fez (FEZ) to Paris (ORY)', time: '14:20', cost: 175 },
      ],
    },
    {
      // 9 days, mainland then island, moderate throughout.
      id: 'greece',
      startOffset: 21,
      label: 'Greece (Athens and Santorini)',
      summary: 'Fly in from London, four nights in Athens, ferry out to Santorini',
      keywords: ['greece', 'athens', 'santorini', 'oia', 'mykonos', 'crete'],
      localCurrency: 'EUR',
      items: [
        { d: 0, type: 'flight', title: 'London (LHR) to Athens (ATH)', time: '07:35', endTime: '13:20', status: 'booked', cost: 220 },
        { d: 0, type: 'local', title: 'Metro line 3 to Syntagma', time: '14:15', status: 'booked', cost: 9 },
        { d: 0, end: 4, type: 'stay', title: 'Electra Metropolis Athens', location: 'Athens', status: 'booked', cost: 620, maps: 'Electra Metropolis Athens', details: 'Four nights off Syntagma square.' },
        { d: 0, type: 'activity', title: 'Dinner: Kuzina', location: 'Athens', time: '20:00', est: 45, maps: 'Kuzina Athens' },
        { d: 1, type: 'activity', title: 'Acropolis and the Parthenon', location: 'Athens', time: '08:00', status: 'booked', cost: 30, cur: 'EUR', maps: 'Acropolis of Athens', details: 'The rock opens early and the marble underfoot is polished slippery by two thousand years of feet, so shoes with some grip matter more than you would expect. Go up first and come down into the museum, not the other way around.' },
        { d: 1, type: 'activity', title: 'Acropolis Museum', location: 'Athens', time: '11:30', cost: 15, maps: 'Acropolis Museum Athens' },
        { d: 1, type: 'activity', title: 'Lunch: Karamanlidika tou Fani', location: 'Athens', time: '14:00', est: 25, maps: 'Karamanlidika tou Fani Athens' },
        { d: 1, type: 'activity', title: 'Drinks: A for Athens rooftop', location: 'Athens', time: '19:30', est: 20, maps: 'A for Athens Cocktail Bar' },
        { d: 2, type: 'activity', title: 'Ancient Agora and the Stoa of Attalos', location: 'Athens', time: '09:30', cost: 10, maps: 'Ancient Agora of Athens' },
        { d: 2, type: 'activity', title: 'Dinner: Ta Karamanlidika', location: 'Athens', time: '20:30', est: 30, maps: 'Ta Karamanlidika tou Fani Athens' },
        { d: 2, type: 'activity', title: 'Cancelled: Cape Sounion sunset tour', location: 'Athens', time: '16:00', status: 'cancelled', maps: 'Temple of Poseidon Cape Sounion', details: 'Dropped in favour of a slower evening in Plaka. Left here so the alternative is easy to bring back.' },
        { d: 3, type: 'activity', title: 'Day trip to Delphi', location: 'Delphi', time: '07:30', cost: 110, maps: 'Archaeological Site of Delphi' },
        { d: 3, type: 'local', title: 'Return to hotel', location: 'Athens', time: '21:00', maps: 'Electra Metropolis Athens' },
        { d: 4, type: 'transport', title: 'Athens to Santorini', time: '07:25', endTime: '12:35', status: 'booked', cost: 85, details: 'High-speed ferry from Piraeus. Boats stop running earlier than you expect, so check the last sailing before planning a late arrival.' },
        { d: 4, end: 8, type: 'stay', title: 'Aressana Spa Hotel', location: 'Santorini', status: 'booked', cost: 900, maps: 'Aressana Spa Hotel and Suites Fira Santorini', details: 'Four nights in Fira.' },
        { d: 4, type: 'activity', title: 'Dinner: Naoussa Restaurant Fira', location: 'Santorini', time: '20:00', est: 35, maps: 'Naoussa Restaurant Fira Santorini' },
        { d: 5, type: 'activity', title: 'Akrotiri excavation site', location: 'Santorini', time: '09:30', cost: 12, maps: 'Akrotiri Archaeological Site Santorini' },
        { d: 5, type: 'activity', title: "Lunch: Lucky's Souvlakis", location: 'Santorini', time: '13:00', est: 8, maps: "Lucky's Souvlakis Fira Santorini" },
        { d: 5, type: 'activity', title: 'Caldera boat to Nea Kameni and the hot springs', location: 'Santorini', time: '15:30', cost: 45, maps: 'Nea Kameni Volcano Santorini' },
        { d: 6, type: 'activity', title: 'Fira to Oia clifftop walk', location: 'Santorini', maps: 'Oia Santorini', details: 'Untimed on purpose: three hours of exposed ridge, so the hour depends on the wind and the heat on the day.' },
        { d: 6, type: 'activity', title: 'Dinner: Ammoudi Fish Tavern', location: 'Santorini', time: '20:30', est: 40, maps: 'Ammoudi Fish Tavern Oia Santorini' },
        { d: 7, type: 'activity', title: 'Santo Wines tasting above the caldera', location: 'Santorini', time: '12:00', cost: 30, maps: 'Santo Wines Santorini' },
        { d: 7, type: 'activity', title: 'Lunch: Metaxi Mas', location: 'Santorini', time: '15:00', est: 30, maps: 'Metaxi Mas Restaurant Santorini' },
        { d: 7, type: 'activity', title: 'Perissa black sand beach', location: 'Santorini', time: '17:30', maps: 'Perissa Beach Santorini' },
        { d: 8, type: 'flight', title: 'Santorini (JTR) to London (LHR)', time: '15:45', cost: 240, details: 'Seasonal direct service. Off season this routes through Athens.' },
      ],
    },
    {
      // 9 days, two bases and two rail day trips. Utrecht and Leiden are day
      // trips rather than stays: both are about half an hour out, and nobody
      // moves hotels for that.
      id: 'netherlands',
      startOffset: 30,
      label: 'Netherlands (Amsterdam and Rotterdam)',
      summary: 'Overnight from Toronto, four nights in Amsterdam, rail day trips to Utrecht and Leiden',
      keywords: ['netherlands', 'amsterdam', 'rotterdam', 'utrecht', 'leiden', 'the hague'],
      localCurrency: 'EUR',
      items: [
        { d: 0, end: 1, type: 'flight', title: 'Toronto (YYZ) to Amsterdam (AMS)', time: '21:10', endTime: '10:35', status: 'booked', cost: 590, details: 'Overnight, lands mid-morning.' },
        { d: 1, type: 'local', title: 'Schiphol train to Amsterdam Centraal', time: '11:30', status: 'booked', cost: 6 },
        { d: 1, end: 5, type: 'stay', title: 'Hotel Estherea', location: 'Amsterdam', status: 'booked', cost: 760, maps: 'Hotel Estherea Amsterdam', details: 'Four nights on the Singel canal.' },
        { d: 1, type: 'activity', title: 'Dinner: Moeders', location: 'Amsterdam', time: '19:30', est: 35, maps: 'Restaurant Moeders Amsterdam' },
        { d: 2, type: 'activity', title: 'Rijksmuseum', location: 'Amsterdam', time: '09:00', status: 'booked', cost: 25, cur: 'EUR', maps: 'Rijksmuseum Amsterdam', details: 'Tickets are timed and the building is big enough that picking two or three wings beats trying to walk all of it. The Gallery of Honour on the second floor holds the paintings most people come for, and it is quietest in the first hour after opening.' },
        { d: 2, type: 'activity', title: 'Lunch: Foodhallen', location: 'Amsterdam', time: '13:00', est: 20, maps: 'Foodhallen Amsterdam' },
        { d: 2, type: 'activity', title: 'Vondelpark and the Museumplein', location: 'Amsterdam', maps: 'Vondelpark Amsterdam', details: 'No time set: this is the filler between the museum and dinner, whenever that lands.' },
        { d: 2, type: 'activity', title: 'Drinks: Cafe Papeneiland', location: 'Amsterdam', time: '19:00', est: 15, maps: 'Cafe Papeneiland Amsterdam' },
        { d: 3, type: 'transport', title: 'Amsterdam to Utrecht', time: '09:10', endTime: '09:37', status: 'booked', cost: 18, details: 'Intercity from Centraal, about half an hour each way, which is why Utrecht is a day out and not a second hotel.' },
        { d: 3, type: 'activity', title: 'Domtoren climb and the Oudegracht wharf cellars', location: 'Utrecht', time: '10:30', cost: 15, maps: 'Domtoren Utrecht' },
        { d: 3, type: 'activity', title: 'Lunch: Broei Utrecht', location: 'Utrecht', time: '13:30', est: 18, maps: 'Broei Utrecht' },
        { d: 3, type: 'transport', title: 'Utrecht to Amsterdam', time: '18:20', endTime: '18:47', status: 'booked', cost: 18 },
        { d: 4, type: 'activity', title: 'Anne Frank House', location: 'Amsterdam', time: '09:15', status: 'booked', cost: 16, maps: 'Anne Frank House Amsterdam', details: 'Entry is online only and slots open on a fixed schedule ahead of the date.' },
        { d: 4, type: 'activity', title: 'Canal boat tour from the Jordaan', location: 'Amsterdam', time: '14:00', cost: 18, maps: 'Jordaan Amsterdam' },
        { d: 4, type: 'activity', title: 'Dinner: De Kas', location: 'Amsterdam', time: '19:30', est: 60, maps: 'Restaurant De Kas Amsterdam' },
        { d: 4, type: 'activity', title: 'Cancelled: Keukenhof gardens', location: 'Lisse', time: '11:00', status: 'cancelled', maps: 'Keukenhof Lisse Netherlands', details: 'The gardens are shut outside the spring season these dates fall in. Left on the plan for a version of this trip in April.' },
        { d: 5, type: 'activity', title: 'Breakfast: Winkel 43', location: 'Amsterdam', time: '08:30', est: 12, maps: 'Winkel 43 Amsterdam' },
        { d: 5, type: 'transport', title: 'Amsterdam to Rotterdam', time: '10:45', endTime: '11:30', status: 'booked', cost: 20, details: 'Intercity from Centraal. The direct service carries a small supplement over the ordinary one.' },
        { d: 5, end: 8, type: 'stay', title: 'Hotel New York', location: 'Rotterdam', status: 'booked', cost: 430, maps: 'Hotel New York Rotterdam', details: 'Three nights in the old shipping line terminal on the Kop van Zuid.' },
        { d: 5, type: 'activity', title: 'Dinner: Fenix Food Factory', location: 'Rotterdam', time: '19:00', est: 25, maps: 'Fenix Food Factory Rotterdam' },
        { d: 6, type: 'transport', title: 'Rotterdam to Leiden', time: '09:05', endTime: '09:32', status: 'booked', cost: 16, details: 'Intercity up the old line. Leiden sits between Rotterdam and Schiphol, so this is the same half hour Utrecht was.' },
        { d: 6, type: 'activity', title: 'Hortus Botanicus and the Rapenburg canal', location: 'Leiden', time: '10:15', cost: 12, maps: 'Hortus Botanicus Leiden' },
        { d: 6, type: 'activity', title: 'Lunch: Meelfabriek Leiden', location: 'Leiden', time: '13:30', est: 20, maps: 'De Meelfabriek Leiden' },
        { d: 6, type: 'transport', title: 'Leiden to Rotterdam', time: '17:40', endTime: '18:07', status: 'booked', cost: 16 },
        { d: 7, type: 'activity', title: 'Markthal and the cube houses', location: 'Rotterdam', time: '10:00', maps: 'Markthal Rotterdam' },
        { d: 7, type: 'activity', title: 'Depot Boijmans Van Beuningen', location: 'Rotterdam', time: '14:00', cost: 20, maps: 'Depot Boijmans Van Beuningen Rotterdam' },
        { d: 7, type: 'activity', title: 'Drinks: Bar Bebek', location: 'Rotterdam', time: '18:00', est: 18, maps: 'Bar Bebek Rotterdam' },
        { d: 8, type: 'transport', title: 'Rotterdam to Amsterdam', time: '07:20', endTime: '08:05', status: 'booked', cost: 20, details: 'Back up the line for the flight: Schiphol sits on the same route.' },
        { d: 8, type: 'flight', title: 'Amsterdam (AMS) to Toronto (YYZ)', time: '11:40', cost: 610 },
      ],
    },
    {
      // 10 days, art and food, moderate with one heavy museum day.
      id: 'italy',
      startOffset: 45,
      label: 'Italy (Rome and Florence)',
      summary: 'Overnight from New York, four nights in Rome, fast train to Florence',
      keywords: ['italy', 'rome', 'roma', 'florence', 'firenze', 'tuscany', 'venice'],
      localCurrency: 'EUR',
      items: [
        { d: 0, end: 1, type: 'flight', title: 'New York (JFK) to Rome (FCO)', time: '20:15', endTime: '10:40', status: 'booked', cost: 640, details: 'Overnight, lands the next morning.' },
        { d: 1, type: 'local', title: 'Leonardo Express to Roma Termini', time: '11:30', status: 'booked', cost: 16 },
        { d: 1, end: 5, type: 'stay', title: 'Hotel Artemide', location: 'Rome', status: 'booked', cost: 720, maps: 'Hotel Artemide Rome', details: 'Four nights on Via Nazionale, breakfast included.' },
        { d: 1, type: 'activity', title: 'Dinner: Roscioli Salumeria con Cucina', location: 'Rome', time: '20:00', est: 55, maps: 'Roscioli Salumeria con Cucina Rome' },
        { d: 2, type: 'activity', title: 'Colosseum, Forum and Palatine', location: 'Rome', time: '09:00', status: 'booked', cost: 24, cur: 'EUR', maps: 'Colosseum Rome', details: 'One combined ticket covers all three, and it is worth walking them in that order: the Forum makes far more sense once you have seen the arena it was built beside. The Palatine has the shade and the best view back over the Forum.' },
        { d: 2, type: 'activity', title: 'Lunch: Armando al Pantheon', location: 'Rome', time: '13:30', est: 40, maps: 'Armando al Pantheon Rome' },
        { d: 2, type: 'activity', title: 'Pantheon and Piazza Navona', location: 'Rome', maps: 'Pantheon Rome', details: 'Untimed: both are a walk-past on the way to dinner rather than a booking.' },
        { d: 2, type: 'activity', title: 'Drinks: Salotto 42', location: 'Rome', time: '19:00', est: 25, maps: 'Salotto 42 Rome' },
        { d: 3, type: 'activity', title: 'Vatican Museums and Sistine Chapel', location: 'Rome', time: '08:30', status: 'booked', cost: 40, maps: 'Vatican Museums Rome' },
        { d: 3, type: 'activity', title: 'Lunch: Bonci Pizzarium', location: 'Rome', time: '13:30', est: 18, maps: 'Bonci Pizzarium Rome' },
        { d: 3, type: 'activity', title: 'Dinner: Trattoria Da Enzo al 29', location: 'Rome', time: '19:30', est: 45, maps: 'Trattoria Da Enzo al 29 Rome' },
        { d: 3, type: 'activity', title: 'Cancelled: Borghese Gallery', location: 'Rome', time: '15:00', status: 'cancelled', maps: 'Galleria Borghese Rome', details: 'Timed entry was gone for these dates. Kept as a reminder to book this one first next time.' },
        { d: 4, type: 'activity', title: 'Mercato di Testaccio', location: 'Rome', time: '10:00', maps: 'Mercato di Testaccio Rome' },
        { d: 4, type: 'activity', title: 'Pasta making class in Trastevere', location: 'Rome', time: '17:00', cost: 85, maps: 'Trastevere Rome' },
        { d: 4, type: 'local', title: 'Return to hotel', location: 'Rome', time: '22:00', maps: 'Hotel Artemide Rome' },
        { d: 5, type: 'transport', title: 'Rome to Florence', time: '10:20', endTime: '11:52', status: 'booked', cost: 45, details: 'Frecciarossa from Roma Termini. Two operators run this line, so it is worth comparing both.' },
        { d: 5, end: 9, type: 'stay', title: 'Hotel Davanzati', location: 'Florence', status: 'booked', cost: 700, maps: 'Hotel Davanzati Florence', details: 'Four nights, a couple of streets from the Duomo.' },
        { d: 5, type: 'activity', title: 'Dinner: Trattoria Sostanza', location: 'Florence', time: '19:30', est: 45, maps: 'Trattoria Sostanza Florence' },
        { d: 6, type: 'activity', title: 'Uffizi Gallery', location: 'Florence', time: '09:00', status: 'booked', cost: 30, maps: 'Uffizi Gallery Florence' },
        { d: 6, type: 'activity', title: "Lunch: All'Antico Vinaio", location: 'Florence', time: '13:00', est: 12, maps: "All'Antico Vinaio Florence" },
        { d: 6, type: 'activity', title: 'Ponte Vecchio and the Oltrarno workshops', location: 'Florence', time: '16:00', maps: 'Ponte Vecchio Florence' },
        { d: 7, type: 'activity', title: 'Accademia and the David', location: 'Florence', time: '08:30', cost: 20, maps: 'Galleria dell Accademia Florence' },
        { d: 7, type: 'activity', title: "Climb Brunelleschi's dome", location: 'Florence', time: '11:30', cost: 30, maps: 'Cattedrale di Santa Maria del Fiore Florence' },
        { d: 7, type: 'activity', title: 'Dinner: Il Santo Bevitore', location: 'Florence', time: '20:00', est: 50, maps: 'Il Santo Bevitore Florence' },
        { d: 8, type: 'activity', title: 'Siena and a Chianti wine stop', location: 'Siena', time: '08:00', cost: 130, maps: 'Piazza del Campo Siena' },
        { d: 8, type: 'local', title: 'Return to hotel', location: 'Florence', time: '20:30', maps: 'Hotel Davanzati Florence' },
        { d: 9, type: 'flight', title: 'Florence (FLR) to New York (JFK)', time: '11:05', note: 'Award ticket, taxes only', details: 'One stop, usually through Paris or Amsterdam.' },
      ],
    },
    {
      // 10 days, deliberately RELAXED: two whole days with nothing scheduled at
      // all, still covered by the Hvar stay, so the coverage bar stays full and
      // the app shows no warning for an empty day.
      id: 'croatia',
      startOffset: 60,
      label: 'Croatia (Split and Hvar)',
      summary: 'Fly in from Vienna, four nights in Split, catamaran to Hvar for five slow nights',
      keywords: ['croatia', 'split', 'hvar', 'dubrovnik', 'dalmatia', 'zagreb'],
      localCurrency: 'EUR',
      items: [
        { d: 0, type: 'flight', title: 'Vienna (VIE) to Split (SPU)', time: '11:15', endTime: '12:35', status: 'booked', cost: 160 },
        { d: 0, type: 'local', title: 'Airport bus to the Riva', time: '13:30', status: 'booked', cost: 8 },
        { d: 0, end: 4, type: 'stay', title: 'Hotel Park Split', location: 'Split', status: 'booked', cost: 540, maps: 'Hotel Park Split', details: 'Four nights above Bacvice beach.' },
        { d: 0, type: 'activity', title: 'Dinner: Bokeria Kitchen and Wine', location: 'Split', time: '20:00', est: 40, maps: 'Bokeria Kitchen and Wine Split' },
        { d: 1, type: 'activity', title: "Diocletian's Palace and the cellars", location: 'Split', time: '09:30', status: 'booked', cost: 15, cur: 'EUR', maps: "Diocletian's Palace Split", details: 'Less a ruin than a neighbourhood: the palace walls are still the old town, with flats and bars built into the Roman structure. The substructures underneath give you the floor plan of the halls that stood above them.' },
        { d: 1, type: 'activity', title: 'Lunch: Konoba Fetivi', location: 'Split', time: '13:30', est: 25, maps: 'Konoba Fetivi Split' },
        { d: 1, type: 'activity', title: 'Cancelled: Blue Cave speedboat tour', location: 'Split', time: '08:30', status: 'cancelled', maps: 'Blue Cave Bisevo Croatia', details: 'The sea was forecast to be rough, so this came off the plan. Left here as the first thing to rebook if it settles.' },
        { d: 2, type: 'activity', title: 'Krka National Park', location: 'Sibenik', time: '08:00', cost: 45, maps: 'Krka National Park Croatia' },
        { d: 2, type: 'local', title: 'Return to hotel', location: 'Split', time: '19:30', maps: 'Hotel Park Split' },
        { d: 4, type: 'transport', title: 'Split to Hvar', time: '11:30', endTime: '12:35', status: 'booked', cost: 20, details: 'Jadrolinija catamaran to Hvar town. The island has no airport, so the boat is the way in.' },
        { d: 4, end: 9, type: 'stay', title: 'Hotel Adriana Hvar', location: 'Hvar', status: 'booked', cost: 900, maps: 'Hotel Adriana Hvar Spa Beach', details: 'Five nights on the harbour front, and two of them are days with nothing planned at all.' },
        { d: 4, type: 'activity', title: 'Dinner: Gariful', location: 'Hvar', time: '20:00', est: 60, maps: 'Gariful Restaurant Hvar' },
        { d: 5, type: 'activity', title: 'Fortica fortress above the town', location: 'Hvar', time: '09:00', cost: 12, maps: 'Fortica Spanjola Hvar' },
        { d: 5, type: 'activity', title: 'Lunch: Konoba Menego', location: 'Hvar', time: '13:00', est: 25, maps: 'Konoba Menego Hvar' },
        { d: 7, type: 'local', title: 'Water taxi to the Pakleni islands', location: 'Hvar', time: '10:30', cost: 15, maps: 'Palmizana Pakleni Islands' },
        { d: 7, type: 'activity', title: 'Lunch: Laganini Palmizana', location: 'Palmizana', time: '13:30', est: 35, maps: 'Laganini Lounge Bar Palmizana' },
        { d: 8, type: 'activity', title: 'Stari Grad plain and the old town', location: 'Stari Grad', cost: 15, maps: 'Stari Grad Plain Hvar', details: 'No time on this one. The bus across the island runs a handful of times a day, so the timetable at the stop decides the morning.' },
        { d: 9, type: 'transport', title: 'Hvar to Split', time: '06:20', endTime: '07:25', status: 'booked', cost: 20, details: 'First catamaran back, timed for the flight.' },
        { d: 9, type: 'flight', title: 'Split (SPU) to Vienna (VIE)', time: '11:40', cost: 160 },
      ],
    },
    {
      // 11 days, deliberately PACKED: several days carry four or five things.
      id: 'peru',
      startOffset: 75,
      label: 'Peru (Lima and Cusco)',
      summary: 'Fly in from Miami, three busy nights in Lima, then a week of ruins out of Cusco',
      keywords: ['peru', 'lima', 'cusco', 'cuzco', 'machu picchu', 'andes'],
      localCurrency: 'PEN',
      items: [
        { d: 0, type: 'flight', title: 'Miami (MIA) to Lima (LIM)', time: '16:40', endTime: '22:10', status: 'booked', cost: 480 },
        { d: 0, type: 'local', title: 'Airport transfer to Barranco', time: '23:00', status: 'booked', cost: 25 },
        { d: 0, end: 3, type: 'stay', title: 'Hotel B Lima', location: 'Lima', status: 'booked', cost: 690, maps: 'Hotel B Lima Barranco', details: 'Three nights in Barranco.' },
        { d: 1, type: 'activity', title: 'Larco Museum', location: 'Lima', time: '09:00', status: 'booked', cost: 45, cur: 'PEN', maps: 'Museo Larco Lima', details: 'A private collection of pre-Columbian pottery laid out chronologically, which is what makes it worth doing before anything in Cusco: the objects arrive with the cultures that made them in an order that actually explains the Inca rather than starting there.' },
        { d: 1, type: 'activity', title: 'Huaca Pucllana adobe pyramid', location: 'Lima', time: '11:30', cost: 15, maps: 'Huaca Pucllana Lima' },
        { d: 1, type: 'activity', title: 'Lunch: La Mar Cebicheria', location: 'Lima', time: '13:30', est: 45, maps: 'La Mar Cebicheria Lima' },
        { d: 1, type: 'activity', title: 'Malecon clifftop walk in Miraflores', location: 'Lima', time: '17:00', maps: 'Malecon de Miraflores Lima' },
        { d: 1, type: 'activity', title: 'Drinks: Ayahuasca Bar', location: 'Lima', time: '20:30', est: 25, maps: 'Ayahuasca Bar Barranco Lima' },
        { d: 2, type: 'activity', title: 'Historic centre and the Basilica of San Francisco', location: 'Lima', time: '09:30', cost: 12, maps: 'Basilica of San Francisco Lima' },
        { d: 2, type: 'activity', title: 'Lunch: Isolina Taberna Peruana', location: 'Lima', time: '13:00', est: 50, maps: 'Isolina Taberna Peruana Lima' },
        { d: 2, type: 'activity', title: 'Barranco bridge and the street art lanes', location: 'Lima', time: '16:00', maps: 'Puente de los Suspiros Barranco Lima' },
        { d: 2, type: 'activity', title: 'Circuito Magico del Agua', location: 'Lima', time: '19:30', cost: 8, maps: 'Circuito Magico del Agua Lima' },
        { d: 2, type: 'local', title: 'Return to hotel', location: 'Lima', time: '22:30', maps: 'Hotel B Lima Barranco' },
        { d: 2, type: 'activity', title: 'Cancelled: Paracas and Ballestas day trip', location: 'Paracas', time: '06:00', status: 'cancelled', maps: 'Ballestas Islands Paracas Peru', details: 'Too much of the day on a bus for a three night stay. Kept here in case the Lima half gets longer.' },
        { d: 3, type: 'flight', title: 'Lima to Cusco', time: '09:15', endTime: '10:40', status: 'booked', cost: 120, details: 'Short hop over the Andes. There is no rail link between the two cities.' },
        { d: 3, end: 10, type: 'stay', title: 'Casa Andina Standard Cusco Koricancha', location: 'Cusco', status: 'booked', cost: 700, maps: 'Casa Andina Standard Cusco Koricancha', details: 'Seven nights a few blocks from the Plaza de Armas.' },
        { d: 3, type: 'activity', title: 'Coricancha temple and the Santo Domingo cloister', location: 'Cusco', time: '15:00', cost: 12, maps: 'Coricancha Cusco' },
        { d: 3, type: 'activity', title: 'Slow first evening at 3,400 metres', location: 'Cusco', maps: 'Plaza de Armas Cusco', details: 'Deliberately untimed and deliberately nothing: the altitude here is roughly twice Denver, and the first evening is not the time to book anything you would be sorry to miss.' },
        { d: 3, type: 'activity', title: 'Dinner: Cicciolina', location: 'Cusco', time: '20:00', est: 40, maps: 'Cicciolina Cusco' },
        { d: 4, type: 'activity', title: 'Sacsayhuaman, Qenqo and Tambomachay', location: 'Cusco', time: '09:00', cost: 25, maps: 'Sacsayhuaman Cusco' },
        { d: 4, type: 'activity', title: 'Lunch: Pachapapa', location: 'Cusco', time: '13:30', est: 25, maps: 'Pachapapa Restaurant San Blas Cusco' },
        { d: 4, type: 'activity', title: 'San Blas lanes and the Cusco cathedral', location: 'Cusco', time: '16:00', cost: 15, maps: 'Cusco Cathedral' },
        { d: 4, type: 'activity', title: 'Dinner: Chicha por Gaston Acurio', location: 'Cusco', time: '20:30', est: 45, maps: 'Chicha por Gaston Acurio Cusco' },
        { d: 5, type: 'activity', title: 'Sacred Valley: Pisac market and ruins', location: 'Pisac', time: '08:00', cost: 70, maps: 'Pisac Archaeological Park Peru' },
        { d: 5, type: 'activity', title: 'Moray terraces and the Maras salt pans', location: 'Maras', time: '13:00', cost: 25, maps: 'Maras Salt Mines Peru' },
        { d: 5, type: 'activity', title: 'Ollantaytambo terraces', location: 'Ollantaytambo', time: '16:30', maps: 'Ollantaytambo Archaeological Site' },
        { d: 5, type: 'activity', title: 'Dinner: Chuncho Ollantaytambo', location: 'Ollantaytambo', time: '19:00', est: 30, maps: 'Chuncho Restaurant Ollantaytambo' },
        { d: 6, type: 'activity', title: 'Machu Picchu by train from Ollantaytambo', location: 'Machu Picchu', time: '05:30', status: 'booked', cost: 340, maps: 'Machu Picchu Sanctuary Peru', details: 'Entry is by timed circuit and the train seat is booked separately from the site ticket.' },
        { d: 6, type: 'activity', title: 'Lunch: Indio Feliz Aguas Calientes', location: 'Aguas Calientes', time: '14:00', est: 30, maps: 'Indio Feliz Aguas Calientes' },
        { d: 6, type: 'activity', title: 'Dinner: Limbus Restobar', location: 'Cusco', time: '21:30', est: 35, maps: 'Limbus Restobar Cusco' },
        { d: 7, type: 'activity', title: 'Rainbow Mountain at Vinicunca', location: 'Vinicunca', time: '04:30', cost: 60, maps: 'Vinicunca Rainbow Mountain Peru' },
        { d: 7, type: 'activity', title: 'Dinner: Morena Peruvian Kitchen', location: 'Cusco', time: '20:00', est: 35, maps: 'Morena Peruvian Kitchen Cusco' },
        { d: 8, type: 'activity', title: 'San Pedro market', location: 'Cusco', time: '09:00', maps: 'Mercado San Pedro Cusco' },
        { d: 8, type: 'activity', title: 'Museo Inka', location: 'Cusco', time: '11:00', cost: 10, maps: 'Museo Inka Cusco' },
        { d: 8, type: 'activity', title: 'Lunch: Green Point', location: 'Cusco', time: '13:30', est: 20, maps: 'Green Point Cusco' },
        { d: 8, type: 'activity', title: 'Chocolate workshop at the ChocoMuseo', location: 'Cusco', time: '16:00', cost: 30, maps: 'ChocoMuseo Cusco' },
        { d: 8, type: 'activity', title: 'Drinks: Museo del Pisco', location: 'Cusco', time: '20:00', est: 25, maps: 'Museo del Pisco Cusco' },
        { d: 9, type: 'activity', title: 'Humantay Lake day hike', location: 'Soraypampa', time: '05:00', cost: 55, maps: 'Humantay Lake Peru' },
        { d: 9, type: 'activity', title: 'Dinner: Kion Cusco', location: 'Cusco', time: '20:00', est: 25, maps: 'Kion Cusco' },
        { d: 10, type: 'flight', title: 'Cusco (CUZ) to Miami (MIA)', time: '11:50', cost: 520, details: 'Connects in Lima. Morning departures from Cusco are the reliable ones.' },
      ],
    },
    {
      // 12 days, PACKED, and the rail is the spine of it.
      id: 'japan',
      startOffset: 90,
      label: 'Japan (Tokyo and Kyoto)',
      summary: 'Fly in from Seoul, five nights in Tokyo, Shinkansen to Kyoto for six more',
      keywords: ['japan', 'tokyo', 'kyoto', 'osaka', 'nippon'],
      localCurrency: 'JPY',
      items: [
        { d: 0, type: 'flight', title: 'Seoul (ICN) to Tokyo (HND)', time: '09:20', endTime: '11:45', status: 'booked', cost: 310, details: 'Carry-on only, seats picked at check-in.' },
        { d: 0, type: 'local', title: 'Haneda Airport to Nihonbashi', time: '12:30', status: 'booked', cost: 12, details: 'Monorail to Hamamatsucho, then one metro change.' },
        { d: 0, end: 5, type: 'stay', title: 'Hotel Ryumeikan Tokyo', location: 'Tokyo', status: 'booked', cost: 980, maps: 'Hotel Ryumeikan Tokyo', details: 'Five nights, a few minutes from Tokyo Station.' },
        { d: 0, type: 'activity', title: 'Dinner: Tonkatsu Maisen Aoyama', location: 'Tokyo', time: '19:00', est: 30, maps: 'Tonkatsu Maisen Aoyama Honten Tokyo' },
        { d: 1, type: 'activity', title: 'Senso-ji and Nakamise street', location: 'Tokyo', time: '09:00', maps: 'Senso-ji Temple Tokyo', details: 'The oldest temple in the city, and the approach street is a market in its own right. Mornings are quieter than afternoons, and the side lanes east of the pagoda are where the older shops sit. Two hours is a comfortable wander.' },
        { d: 1, type: 'activity', title: 'Lunch: Asakusa Imahan', location: 'Tokyo', time: '12:30', est: 45, maps: 'Asakusa Imahan Kokusaidori Tokyo' },
        { d: 1, type: 'activity', title: 'teamLab Planets TOKYO', location: 'Tokyo', time: '15:00', status: 'booked', cost: 3800, cur: 'JPY', maps: 'teamLab Planets TOKYO', details: 'Timed entry, so the slot is picked when you book.' },
        { d: 1, type: 'activity', title: 'Drinks: New York Bar, Park Hyatt Tokyo', location: 'Tokyo', time: '20:30', est: 40, maps: 'New York Bar Park Hyatt Tokyo' },
        { d: 2, type: 'activity', title: 'Tsukiji Outer Market walk', location: 'Tokyo', time: '08:30', maps: 'Tsukiji Outer Market Tokyo' },
        { d: 2, type: 'activity', title: 'Hamarikyu Gardens and the tea house', location: 'Tokyo', time: '10:30', cost: 3, maps: 'Hamarikyu Gardens Tokyo' },
        { d: 2, type: 'activity', title: 'Lunch: Sushizanmai Tsukiji', location: 'Tokyo', time: '12:30', est: 35, maps: 'Sushizanmai Honten Tsukiji Tokyo' },
        { d: 2, type: 'activity', title: 'Dinner: Ichiran Shibuya', location: 'Tokyo', time: '19:30', est: 20, maps: 'Ichiran Shibuya Tokyo' },
        { d: 2, type: 'activity', title: 'Cancelled: Sumo morning practice visit', location: 'Tokyo', time: '07:00', status: 'cancelled', maps: 'Ryogoku Kokugikan Tokyo', details: 'Dropped when the tournament dates moved. Left on the plan as a record of what was considered.' },
        { d: 3, type: 'activity', title: 'Day trip to Nikko: Toshogu shrine', location: 'Nikko', time: '07:40', cost: 95, maps: 'Nikko Toshogu Shrine', details: 'Limited express from Asakusa, then a short bus up to the shrines.' },
        { d: 3, type: 'activity', title: 'Kegon Falls and Lake Chuzenji', location: 'Nikko', time: '13:30', cost: 6, maps: 'Kegon Falls Nikko' },
        { d: 3, type: 'local', title: 'Return to hotel', location: 'Tokyo', time: '21:30', maps: 'Hotel Ryumeikan Tokyo' },
        { d: 3, type: 'activity', title: 'Dinner: Tonki Meguro', location: 'Tokyo', time: '22:00', est: 22, maps: 'Tonki Meguro Tokyo' },
        { d: 4, type: 'activity', title: 'Meiji Jingu and the Harajuku lanes', location: 'Tokyo', time: '09:00', maps: 'Meiji Jingu Tokyo' },
        { d: 4, type: 'activity', title: 'Lunch: Afuri Harajuku', location: 'Tokyo', time: '12:30', est: 16, maps: 'Afuri Harajuku Tokyo' },
        { d: 4, type: 'activity', title: 'Shibuya crossing and Shibuya Sky', location: 'Tokyo', time: '16:00', cost: 18, maps: 'Shibuya Sky Tokyo' },
        { d: 4, type: 'activity', title: 'Omoide Yokocho after dark', location: 'Tokyo', maps: 'Omoide Yokocho Shinjuku Tokyo', details: 'No time set: this is wherever the evening ends up, and the lanes stay busy late.' },
        { d: 5, type: 'activity', title: 'Breakfast: Kimuraya Ginza', location: 'Tokyo', time: '08:00', est: 15, maps: 'Kimuraya Sohonten Ginza Tokyo' },
        { d: 5, type: 'transport', title: 'Tokyo to Kyoto', time: '10:30', endTime: '12:50', status: 'booked', cost: 110, details: 'Tokaido Shinkansen, reserved seat. The right-hand side is the Mount Fuji side.' },
        { d: 5, end: 11, type: 'stay', title: 'Hotel Kanra Kyoto', location: 'Kyoto', status: 'booked', cost: 1180, maps: 'Hotel Kanra Kyoto', details: 'Six nights, walkable from Kyoto Station.' },
        { d: 5, type: 'activity', title: 'Dinner: Katsukura Sanjo Honten', location: 'Kyoto', time: '19:00', est: 28, maps: 'Katsukura Sanjo Honten Kyoto' },
        { d: 6, type: 'activity', title: 'Fushimi Inari Taisha before the crowds', location: 'Kyoto', time: '06:30', maps: 'Fushimi Inari Taisha Kyoto' },
        { d: 6, type: 'activity', title: 'Lunch: Nishiki Market', location: 'Kyoto', time: '12:30', est: 22, maps: 'Nishiki Market Kyoto' },
        { d: 6, type: 'activity', title: 'Kiyomizu-dera and the Higashiyama slopes', location: 'Kyoto', time: '15:00', cost: 4, maps: 'Kiyomizu-dera Kyoto' },
        { d: 6, type: 'activity', title: 'Gion evening walk', location: 'Kyoto', time: '18:30', maps: 'Gion Kyoto' },
        { d: 7, type: 'activity', title: 'Kinkaku-ji golden pavilion', location: 'Kyoto', time: '08:30', cost: 5, maps: 'Kinkaku-ji Kyoto' },
        { d: 7, type: 'activity', title: 'Ryoan-ji rock garden', location: 'Kyoto', time: '10:30', cost: 4, maps: 'Ryoan-ji Kyoto' },
        { d: 7, type: 'activity', title: 'Lunch: Ippudo Nishikikoji', location: 'Kyoto', time: '13:00', est: 24, maps: 'Ippudo Nishikikoji Kyoto' },
        { d: 7, type: 'activity', title: 'Nijo Castle and the nightingale floors', location: 'Kyoto', time: '15:30', cost: 8, maps: 'Nijo Castle Kyoto' },
        { d: 8, type: 'activity', title: 'Arashiyama bamboo grove and Tenryu-ji', location: 'Kyoto', time: '08:30', cost: 6, maps: 'Tenryu-ji Temple Kyoto' },
        { d: 8, type: 'activity', title: 'Iwatayama monkey park', location: 'Kyoto', time: '11:00', cost: 5, maps: 'Iwatayama Monkey Park Kyoto' },
        { d: 8, type: 'activity', title: 'Lunch: Yoshida-ya Arashiyama', location: 'Kyoto', time: '13:30', est: 18, maps: 'Arashiyama Yoshimura Kyoto' },
        { d: 9, type: 'activity', title: 'Day trip to Nara: Todai-ji and the deer park', location: 'Nara', time: '08:30', cost: 40, maps: 'Todai-ji Nara' },
        { d: 9, type: 'activity', title: 'Lunch: Nakatanidou mochi in Nara', location: 'Nara', time: '13:00', est: 10, maps: 'Nakatanidou Nara' },
        { d: 9, type: 'activity', title: 'Dinner: Menbaka Fire Ramen', location: 'Kyoto', time: '19:30', est: 20, maps: 'Menbaka Fire Ramen Kyoto' },
        { d: 10, type: 'activity', title: 'Day trip to Osaka: Osaka Castle and Dotonbori', location: 'Osaka', time: '09:00', cost: 35, maps: 'Osaka Castle' },
        { d: 10, type: 'activity', title: 'Lunch: Kuromon Ichiba Market', location: 'Osaka', time: '12:30', est: 25, maps: 'Kuromon Ichiba Market Osaka' },
        { d: 10, type: 'activity', title: 'Drinks: a Pontocho alley bar', location: 'Kyoto', time: '20:30', est: 30, maps: 'Pontocho Kyoto' },
        { d: 11, type: 'flight', title: 'Osaka (KIX) to Seoul (ICN)', time: '13:40', cost: 290, details: 'Kyoto has no airport of its own. The Haruka express runs from Kyoto Station to KIX.' },
      ],
    },
    {
      // 12 days, coast then city then desert. Ramat Gan is a `local` hop
      // because it is the next municipality over, while Beer Sheva is a real
      // intercity `transport` leg: the two travel types side by side, each for
      // the reason the type exists.
      id: 'israel',
      startOffset: 120,
      label: 'Israel (Tel Aviv and Jerusalem)',
      summary: 'Fly in from Athens, five nights in Tel Aviv, fast train up to Jerusalem',
      keywords: ['israel', 'tel aviv', 'jerusalem', 'haifa', 'ramat gan', 'beer sheva'],
      localCurrency: 'ILS',
      items: [
        { d: 0, type: 'flight', title: 'Athens (ATH) to Tel Aviv (TLV)', time: '08:50', endTime: '11:35', status: 'booked', cost: 230 },
        { d: 0, type: 'local', title: 'Ben Gurion train to Tel Aviv Savidor', time: '12:30', status: 'booked', cost: 5 },
        { d: 0, end: 5, type: 'stay', title: 'The Norman Tel Aviv', location: 'Tel Aviv', status: 'booked', cost: 1100, maps: 'The Norman Tel Aviv', details: 'Five nights a block off Rothschild Boulevard.' },
        { d: 0, type: 'activity', title: 'Dinner: Miznon Ibn Gabirol', location: 'Tel Aviv', time: '19:00', est: 20, maps: 'Miznon Ibn Gabirol Tel Aviv' },
        { d: 1, type: 'activity', title: 'Old Jaffa and the flea market', location: 'Tel Aviv', time: '09:00', maps: 'Old Jaffa Tel Aviv' },
        { d: 1, type: 'activity', title: 'Lunch: Abu Hassan', location: 'Tel Aviv', time: '12:30', est: 12, maps: 'Abu Hassan Ali Karavan Jaffa' },
        { d: 1, type: 'activity', title: 'Carmel Market and the Nahalat Binyamin lanes', location: 'Tel Aviv', time: '16:00', maps: 'Carmel Market Tel Aviv' },
        { d: 1, type: 'activity', title: 'Drinks: Port Said', location: 'Tel Aviv', time: '20:30', est: 18, maps: 'Port Said Tel Aviv' },
        { d: 2, type: 'activity', title: 'Tel Aviv Museum of Art', location: 'Tel Aviv', time: '10:00', status: 'booked', cost: 50, cur: 'ILS', maps: 'Tel Aviv Museum of Art', details: 'Two connected buildings, and the newer wing is the reason to come: the galleries spiral down around a daylit well rather than sitting in a row. Allow a couple of hours, and check the closing day before you plan around it.' },
        { d: 2, type: 'activity', title: 'Dinner: Shila', location: 'Tel Aviv', time: '20:00', est: 55, maps: 'Shila Restaurant Tel Aviv' },
        { d: 2, type: 'activity', title: 'Cancelled: Timna Park and two nights in Eilat', location: 'Eilat', time: '07:00', status: 'cancelled', maps: 'Timna Park Israel', details: 'Four hours each way for a trip already going to the Dead Sea. Kept here for a version of this trip that flies south.' },
        { d: 3, type: 'local', title: 'Tel Aviv to Ramat Gan', time: '09:30', cost: 2, details: 'Local, not intercity: Ramat Gan is the next municipality over and the city bus crosses in about twenty minutes on the same fare as any ride inside Tel Aviv. No ticket to book and nothing to plan around.' },
        { d: 3, type: 'activity', title: 'Ramat Gan Safari open park', location: 'Ramat Gan', time: '10:15', cost: 20, maps: 'Ramat Gan Safari Zoological Center' },
        { d: 3, type: 'activity', title: 'Lunch: Shipudei Hatikva in Ramat Gan', location: 'Ramat Gan', time: '13:30', est: 18, maps: 'Ramat Gan Israel' },
        { d: 4, type: 'activity', title: 'Bauhaus walking tour of the White City', location: 'Tel Aviv', time: '10:00', cost: 25, maps: 'Bauhaus Center Tel Aviv' },
        { d: 4, type: 'activity', title: 'Beach afternoon on the Tayelet promenade', location: 'Tel Aviv', maps: 'Tel Aviv Promenade', details: 'Untimed: whatever is left of the afternoon after the walking tour runs over.' },
        { d: 4, type: 'activity', title: 'Dinner: Tzfon Abraxas', location: 'Tel Aviv', time: '20:00', est: 45, maps: 'Tzfon Abraxas Tel Aviv' },
        { d: 5, type: 'activity', title: 'Breakfast: Benedict Rothschild', location: 'Tel Aviv', time: '08:00', est: 18, maps: 'Benedict Rothschild Tel Aviv' },
        { d: 5, type: 'transport', title: 'Tel Aviv to Jerusalem', time: '10:24', endTime: '10:56', status: 'booked', cost: 6, details: 'Fast train from Savidor to Yitzhak Navon, then the light rail into the centre. The line runs on a reduced timetable over the weekend.' },
        { d: 5, end: 11, type: 'stay', title: 'YMCA Three Arches Hotel', location: 'Jerusalem', status: 'booked', cost: 840, maps: 'YMCA Three Arches Hotel Jerusalem', details: 'Six nights on King David Street.' },
        { d: 5, type: 'activity', title: 'Dinner: Machneyuda', location: 'Jerusalem', time: '19:30', est: 60, maps: 'Machneyuda Jerusalem' },
        { d: 6, type: 'activity', title: 'Old City walk through the four quarters', location: 'Jerusalem', time: '08:30', cost: 40, maps: 'Jaffa Gate Jerusalem', details: 'A walled square kilometre that takes a morning at a slow pace, and a guide is worth it simply for the layout. Dress is conservative at the religious sites, several of which close early in the afternoon, so the order you walk them in matters.' },
        { d: 6, type: 'activity', title: 'Lunch: Mahane Yehuda Market', location: 'Jerusalem', time: '13:00', est: 15, maps: 'Mahane Yehuda Market Jerusalem' },
        { d: 6, type: 'activity', title: 'Tower of David museum', location: 'Jerusalem', time: '16:00', cost: 20, maps: 'Tower of David Museum Jerusalem' },
        { d: 7, type: 'activity', title: 'Yad Vashem', location: 'Jerusalem', time: '09:30', maps: 'Yad Vashem Jerusalem', details: 'Free entry, and the light rail stops at the foot of the hill.' },
        { d: 7, type: 'activity', title: 'Mount of Olives viewpoint', location: 'Jerusalem', time: '15:00', maps: 'Mount of Olives Jerusalem' },
        { d: 7, type: 'activity', title: 'Dinner: Anna Italian Cafe', location: 'Jerusalem', time: '19:30', est: 30, maps: 'Anna Italian Cafe Jerusalem' },
        { d: 8, type: 'transport', title: 'Jerusalem to Beer Sheva', time: '08:05', endTime: '09:20', status: 'booked', cost: 8, details: 'Intercity train south, a bit over an hour each way, so this one is a real ticket rather than a city fare.' },
        { d: 8, type: 'activity', title: "Abraham's Well visitor centre", location: 'Beer Sheva', time: '10:00', cost: 12, maps: "Abraham's Well Beer Sheva" },
        { d: 8, type: 'activity', title: 'Lunch: the Bedouin market stalls', location: 'Beer Sheva', time: '13:00', est: 14, maps: 'Beer Sheva Bedouin Market' },
        { d: 8, type: 'transport', title: 'Beer Sheva to Jerusalem', time: '17:10', endTime: '18:25', status: 'booked', cost: 8 },
        { d: 9, type: 'activity', title: 'Masada sunrise and the Dead Sea', location: 'Masada', time: '03:30', cost: 95, maps: 'Masada National Park Israel', details: 'The cable car does not run that early, so the sunrise version is the Snake Path on foot. The Dead Sea shore stops are on the way back, and the salt finds every scratch you have.' },
        { d: 9, type: 'activity', title: 'Dinner: Hamotzi Jerusalem', location: 'Jerusalem', time: '19:30', est: 35, maps: 'Hamotzi Restaurant Jerusalem' },
        { d: 10, type: 'activity', title: 'Israel Museum and the Shrine of the Book', location: 'Jerusalem', time: '10:00', cost: 25, maps: 'Israel Museum Jerusalem' },
        { d: 10, type: 'activity', title: 'Lunch: Azura in Mahane Yehuda', location: 'Jerusalem', time: '13:30', est: 20, maps: 'Azura Restaurant Jerusalem' },
        { d: 10, type: 'activity', title: 'Ramparts walk on the Old City walls', location: 'Jerusalem', time: '16:00', cost: 6, maps: 'Jerusalem Ramparts Walk' },
        { d: 11, type: 'transport', title: 'Jerusalem to Tel Aviv', time: '09:30', endTime: '10:05', status: 'booked', cost: 6, details: 'Same fast line back, timed for the flight.' },
        { d: 11, type: 'flight', title: 'Tel Aviv (TLV) to Athens (ATH)', time: '14:20', cost: 245, details: 'Departure screening takes longer than most airports, so allow three hours.' },
      ],
    },
    {
      // 13 days, street food and coast, and the cheap end of the budget spread:
      // guesthouses, single-figure meals and a domestic hop that costs less
      // than one Iceland dinner.
      id: 'vietnam',
      startOffset: 150,
      label: 'Vietnam (Hanoi and Da Nang)',
      summary: 'Fly in from Hong Kong, five nights in Hanoi, down the coast to Da Nang on a backpacker budget',
      keywords: ['vietnam', 'hanoi', 'da nang', 'danang', 'hoi an', 'saigon', 'ho chi minh'],
      localCurrency: 'VND',
      items: [
        { d: 0, type: 'flight', title: 'Hong Kong (HKG) to Hanoi (HAN)', time: '10:40', endTime: '12:20', status: 'booked', cost: 95 },
        { d: 0, type: 'local', title: 'Airport bus 86 to the Old Quarter', time: '13:15', status: 'booked', cost: 2 },
        { d: 0, end: 5, type: 'stay', title: 'Hanoi La Siesta Premium Hang Be', location: 'Hanoi', status: 'booked', cost: 175, maps: 'Hanoi La Siesta Premium Hang Be', details: 'Five nights in the Old Quarter, about thirty five a night.' },
        { d: 0, type: 'activity', title: 'Dinner: Cha Ca Thang Long', location: 'Hanoi', time: '19:00', est: 8, maps: 'Cha Ca Thang Long Hanoi' },
        { d: 1, type: 'activity', title: 'Temple of Literature', location: 'Hanoi', time: '08:30', status: 'booked', cost: 70000, cur: 'VND', maps: 'Temple of Literature Hanoi', details: 'The oldest university in the country, laid out as five courtyards that get quieter the further in you walk. The stone stelae on their tortoises in the third courtyard are the part people miss because they are looking for the pavilion on the banknote.' },
        { d: 1, type: 'activity', title: 'Lunch: Bun Cha Huong Lien', location: 'Hanoi', time: '12:00', est: 4, maps: 'Bun Cha Huong Lien Hanoi' },
        { d: 1, type: 'activity', title: 'Hoan Kiem lake and Ngoc Son temple', location: 'Hanoi', time: '16:00', cost: 2, maps: 'Ngoc Son Temple Hanoi' },
        { d: 1, type: 'activity', title: 'Drinks: bia hoi on Ta Hien', location: 'Hanoi', time: '20:30', est: 3, maps: 'Ta Hien Street Hanoi' },
        { d: 2, type: 'activity', title: 'Ha Long Bay day cruise', location: 'Ha Long', time: '07:30', cost: 55, maps: 'Ha Long Bay Vietnam' },
        { d: 2, type: 'local', title: 'Return to the guesthouse', location: 'Hanoi', time: '20:30', maps: 'Hanoi La Siesta Premium Hang Be' },
        { d: 3, type: 'activity', title: 'Train Street coffee and the Long Bien bridge', location: 'Hanoi', maps: 'Long Bien Bridge Hanoi', details: 'No time set: the trains come through twice in the evening and the cafes only let you sit when one is due.' },
        { d: 3, type: 'activity', title: 'Hoa Lo Prison museum', location: 'Hanoi', time: '10:00', cost: 2, maps: 'Hoa Lo Prison Hanoi' },
        { d: 3, type: 'activity', title: 'Dinner: Quan An Ngon', location: 'Hanoi', time: '19:30', est: 6, maps: 'Quan An Ngon Hanoi' },
        { d: 3, type: 'activity', title: 'Cancelled: Water puppet theatre', location: 'Hanoi', time: '18:00', status: 'cancelled', maps: 'Thang Long Water Puppet Theatre Hanoi', details: 'Sold out for the evening we wanted. Left on the plan in case a later slot opens up.' },
        { d: 4, type: 'activity', title: 'Ninh Binh: Trang An boat ride and Mua Cave', location: 'Ninh Binh', time: '07:00', cost: 45, maps: 'Trang An Ninh Binh Vietnam' },
        { d: 5, type: 'flight', title: 'Hanoi to Da Nang', time: '11:05', endTime: '12:25', status: 'booked', cost: 38, details: 'The Reunification Express covers this overland, but it is a long ride against a short flight.' },
        { d: 5, end: 12, type: 'stay', title: 'Fusion Suites Da Nang Beach', location: 'Da Nang', status: 'booked', cost: 315, maps: 'Fusion Suites Da Nang Beach', details: 'Seven nights on My Khe beach, about forty five a night.' },
        { d: 5, type: 'activity', title: 'Dinner: Madame Lan', location: 'Da Nang', time: '19:00', est: 7, maps: 'Madame Lan Restaurant Da Nang' },
        { d: 6, type: 'activity', title: 'Hoi An ancient town', location: 'Hoi An', time: '10:00', cost: 5, maps: 'Hoi An Ancient Town' },
        { d: 6, type: 'activity', title: 'Lunch: Banh Mi Phuong', location: 'Hoi An', time: '13:00', est: 2, maps: 'Banh Mi Phuong Hoi An' },
        { d: 6, type: 'activity', title: 'Lantern boats on the Thu Bon at dusk', location: 'Hoi An', time: '18:30', cost: 3, maps: 'Thu Bon River Hoi An' },
        { d: 7, type: 'activity', title: 'Marble Mountains', location: 'Da Nang', time: '08:30', cost: 4, maps: 'Marble Mountains Da Nang' },
        { d: 7, type: 'activity', title: 'My Khe beach afternoon', location: 'Da Nang', time: '14:00', maps: 'My Khe Beach Da Nang' },
        { d: 7, type: 'activity', title: 'Dinner: Bo Ne Ba Hoa', location: 'Da Nang', time: '19:30', est: 5, maps: 'Bo Ne Ba Hoa Da Nang' },
        { d: 8, type: 'activity', title: 'Hai Van Pass with a rider', location: 'Da Nang', time: '08:00', cost: 25, maps: 'Hai Van Pass Vietnam' },
        { d: 8, type: 'activity', title: 'Lunch: An Cu seafood in Lang Co', location: 'Lang Co, Vietnam', time: '13:00', est: 4, maps: 'Lang Co Vietnam' },
        { d: 9, type: 'activity', title: 'Hue: the Citadel and the royal tombs', location: 'Hue', time: '07:30', cost: 20, maps: 'Imperial City Hue' },
        { d: 9, type: 'activity', title: 'Dinner: Bun Cha Ca 109', location: 'Da Nang', time: '20:00', est: 4, maps: 'Bun Cha Ca 109 Da Nang' },
        { d: 10, type: 'activity', title: 'Ba Na Hills and the Golden Bridge', location: 'Da Nang', time: '08:30', cost: 40, maps: 'Golden Bridge Ba Na Hills Vietnam' },
        { d: 10, type: 'activity', title: 'Drinks: Sky36 rooftop', location: 'Da Nang', time: '21:00', est: 8, maps: 'Sky36 Da Nang' },
        { d: 11, type: 'activity', title: 'Museum of Cham Sculpture', location: 'Da Nang', time: '09:00', cost: 3, maps: 'Museum of Cham Sculpture Da Nang' },
        { d: 11, type: 'activity', title: 'Cooking class in Hoi An', location: 'Hoi An', time: '13:00', cost: 30, maps: 'Hoi An Cooking Class Vietnam' },
        { d: 11, type: 'activity', title: 'Lunch: Morning Glory Hoi An', location: 'Hoi An', time: '11:30', est: 6, maps: 'Morning Glory Restaurant Hoi An' },
        { d: 12, type: 'flight', title: 'Da Nang (DAD) to Hong Kong (HKG)', time: '13:50', cost: 110 },
      ],
    },
    {
      // 14 days, and the clearest split in the library: seven packed city days
      // followed by seven that are mostly beach, two of them with nothing
      // scheduled at all.
      id: 'thailand',
      startOffset: 180,
      label: 'Thailand (Bangkok and Krabi)',
      summary: 'Fly in from Singapore, a packed week in Bangkok, then a slow week on the Krabi coast',
      keywords: ['thailand', 'bangkok', 'chiang mai', 'phuket', 'krabi', 'railay', 'siam'],
      localCurrency: 'THB',
      items: [
        { d: 0, type: 'flight', title: 'Singapore (SIN) to Bangkok (BKK)', time: '08:45', endTime: '10:15', status: 'booked', cost: 180 },
        { d: 0, type: 'local', title: 'Airport Rail Link to Phaya Thai', time: '11:15', status: 'booked', cost: 5 },
        { d: 0, end: 7, type: 'stay', title: 'Riva Surya Bangkok', location: 'Bangkok', status: 'booked', cost: 700, maps: 'Riva Surya Bangkok', details: 'Seven nights on the river side of the old town.' },
        { d: 0, type: 'activity', title: 'Dinner: Thipsamai', location: 'Bangkok', time: '19:00', est: 12, maps: 'Thipsamai Pad Thai Bangkok' },
        { d: 1, type: 'activity', title: 'Grand Palace and Wat Phra Kaew', location: 'Bangkok', time: '08:30', status: 'booked', cost: 500, cur: 'THB', maps: 'Grand Palace Bangkok', details: 'The dress code is enforced at the gate: shoulders and knees covered for everyone, no sheer fabric. Going early is worth it for the heat as much as the crowds, and Wat Pho is a ten minute walk south when you are done.' },
        { d: 1, type: 'activity', title: 'Wat Pho reclining Buddha', location: 'Bangkok', time: '11:30', cost: 10, maps: 'Wat Pho Bangkok' },
        { d: 1, type: 'activity', title: 'Lunch: Err Urban Rustic Thai', location: 'Bangkok', time: '13:30', est: 18, maps: 'Err Urban Rustic Thai Bangkok' },
        { d: 1, type: 'activity', title: 'Drinks: Sky Bar at Lebua', location: 'Bangkok', time: '18:30', est: 30, maps: 'Sky Bar Lebua Bangkok' },
        { d: 2, type: 'activity', title: 'Chatuchak Weekend Market', location: 'Bangkok', time: '10:00', maps: 'Chatuchak Weekend Market Bangkok' },
        { d: 2, type: 'activity', title: 'Lunch: Or Tor Kor Market', location: 'Bangkok', time: '13:00', est: 10, maps: 'Or Tor Kor Market Bangkok' },
        { d: 2, type: 'activity', title: 'Jim Thompson House', location: 'Bangkok', time: '15:30', cost: 6, maps: 'Jim Thompson House Bangkok' },
        { d: 2, type: 'activity', title: 'Dinner: Jay Fai', location: 'Bangkok', time: '19:30', est: 60, maps: 'Jay Fai Bangkok' },
        { d: 3, type: 'activity', title: 'Chao Phraya river boat to Wat Arun', location: 'Bangkok', time: '09:30', cost: 4, maps: 'Wat Arun Bangkok' },
        { d: 3, type: 'activity', title: 'Wat Saket and the Golden Mount', location: 'Bangkok', time: '14:00', cost: 3, maps: 'Wat Saket Bangkok' },
        { d: 3, type: 'activity', title: 'Yaowarat street food crawl', location: 'Bangkok', maps: 'Yaowarat Road Bangkok', details: 'Untimed: Chinatown gets going somewhere after dark and there is nothing to book, so this floats to whenever the day runs out.' },
        { d: 3, type: 'local', title: 'Return to hotel', location: 'Bangkok', time: '23:30', maps: 'Riva Surya Bangkok' },
        { d: 4, type: 'activity', title: 'Ayutthaya day trip', location: 'Ayutthaya', time: '07:00', cost: 45, maps: 'Ayutthaya Historical Park' },
        { d: 4, type: 'activity', title: 'Dinner: Supanniga Eating Room', location: 'Bangkok', time: '20:00', est: 25, maps: 'Supanniga Eating Room Bangkok' },
        { d: 5, type: 'activity', title: 'Thai cooking class, half day', location: 'Bangkok', time: '09:00', cost: 40, maps: 'Silom Thai Cooking School Bangkok' },
        { d: 5, type: 'activity', title: 'Lumphini Park in the late afternoon', location: 'Bangkok', time: '16:30', maps: 'Lumphini Park Bangkok' },
        { d: 5, type: 'activity', title: 'Drinks: Octave rooftop', location: 'Bangkok', time: '20:00', est: 22, maps: 'Octave Rooftop Bar Bangkok' },
        { d: 5, type: 'activity', title: 'Cancelled: Erawan Museum and Ancient City', location: 'Samut Prakan', time: '10:00', status: 'cancelled', maps: 'Ancient City Muang Boran Samut Prakan', details: 'A whole day out of an already full week. Left on the plan for a trip that skips the cooking class.' },
        { d: 6, type: 'activity', title: 'Maeklong railway market and Damnoen Saduak', location: 'Samut Songkhram', time: '06:30', cost: 35, maps: 'Maeklong Railway Market Thailand' },
        { d: 6, type: 'activity', title: 'Muay Thai at Rajadamnern Stadium', location: 'Bangkok', time: '18:30', cost: 55, maps: 'Rajadamnern Stadium Bangkok' },
        { d: 6, type: 'activity', title: 'Dinner: Nai Ek Roll Noodle', location: 'Bangkok', time: '22:00', est: 8, maps: 'Nai Ek Roll Noodle Bangkok' },
        { d: 7, type: 'flight', title: 'Bangkok to Krabi', time: '11:20', endTime: '12:40', status: 'booked', cost: 60, details: 'Domestic hop from Don Mueang. The overnight bus and the sleeper train are the slow, cheaper alternatives.' },
        { d: 7, end: 13, type: 'stay', title: 'Rayavadee Krabi', location: 'Krabi', status: 'booked', cost: 1150, maps: 'Rayavadee Krabi', details: 'Six nights on Phranang beach. Two of these days have nothing planned on purpose.' },
        { d: 7, type: 'activity', title: 'Dinner: The Raya Dining', location: 'Krabi', time: '19:30', est: 45, maps: 'Rayavadee Krabi' },
        { d: 8, type: 'activity', title: 'Railay and Phranang beach by longtail', location: 'Railay', time: '10:00', cost: 10, maps: 'Railay Beach Krabi' },
        { d: 8, type: 'activity', title: 'Lunch: Railay beach shack', location: 'Railay', time: '13:00', est: 9, maps: 'Railay Beach Krabi' },
        { d: 10, type: 'activity', title: 'Four Islands longtail tour', location: 'Krabi', time: '09:00', cost: 25, maps: 'Four Islands Tour Krabi Thailand' },
        { d: 12, type: 'activity', title: 'Ao Nang beach afternoon', location: 'Ao Nang', maps: 'Ao Nang Beach Krabi', details: 'Nothing booked and no time set. This is the last full day and it is meant to stay that way.' },
        { d: 12, type: 'activity', title: 'Dinner: Krua Thara Ao Nang', location: 'Ao Nang', time: '19:30', est: 20, maps: 'Krua Thara Restaurant Ao Nang' },
        { d: 13, type: 'flight', title: 'Krabi (KBV) to Singapore (SIN)', time: '14:10', cost: 200 },
      ],
    },
    {
      // 30 days, and the one that is not a two-city trip: a coast-to-coast
      // drive with eighteen overnight stops, so the day this template exists
      // to exercise is the DRIVING day. Long legs carry a light load and a
      // couple of roadside stops; city days carry a full one. It is also the
      // only template with a foreign-currency FLIGHT rather than a foreign
      // -currency attraction, because the ticket is the only thing on a
      // domestic road trip that gets bought abroad.
      id: 'usa',
      startOffset: 210,
      label: 'USA (New York to San Francisco road trip)',
      summary: 'Fly in from London, drive coast to coast in thirty days, eighteen overnight stops and a lot of roadside America',
      keywords: ['usa', 'united states', 'america', 'route 66', 'new york', 'nyc', 'washington dc',
        'nashville', 'memphis', 'new orleans', 'austin', 'san antonio', 'santa fe',
        'las vegas', 'vegas', 'los angeles', 'san francisco', 'grand canyon'],
      localCurrency: 'USD',
      items: [
        // ---- New York, three nights ----
        { d: 0, type: 'flight', title: 'London (LHR) to New York (JFK)', time: '09:15', endTime: '12:20', status: 'booked', cost: 505, cur: 'GBP', details: 'Open jaw: in to New York, home out of San Francisco, booked as one ticket. Seven hours out and five time zones back, so it is still lunchtime when you land.' },
        { d: 0, type: 'local', title: 'AirTrain and the subway into Manhattan', time: '13:30', status: 'booked', cost: 12 },
        { d: 0, end: 3, type: 'stay', title: 'Pod 51 Hotel', location: 'New York', status: 'booked', cost: 780, maps: 'Pod 51 Hotel New York', details: 'Three nights in Midtown East. Small rooms on purpose: the car is not collected until day four and nothing here needs parking.' },
        { d: 0, type: 'activity', title: "Dinner: Katz's Delicatessen", location: 'New York', time: '18:30', est: 32, maps: "Katz's Delicatessen New York" },
        { d: 0, type: 'activity', title: 'The whispering gallery under Grand Central', location: 'New York', maps: 'Grand Central Terminal New York', details: 'No time set: it is four minutes from the hotel, it is free, and the tiled arches outside the Oyster Bar carry a whisper diagonally across the corner at any hour the station is open.' },

        { d: 1, type: 'activity', title: 'Staten Island Ferry past the Statue of Liberty', location: 'New York', time: '08:30', maps: 'Staten Island Ferry Whitehall Terminal New York', details: 'The best view of the harbour in the city is on a commuter boat that costs nothing, runs every half hour and does not sell tickets because there is nothing to sell. Stay on the west rail going out, walk straight back on at St George, and the whole round trip takes about fifty minutes.' },
        { d: 1, type: 'activity', title: 'The High Line and Chelsea Market', location: 'New York', time: '11:00', maps: 'The High Line New York' },
        { d: 1, type: 'activity', title: "Lunch: Joe's Pizza on Carmine Street", location: 'New York', time: '13:00', est: 7, maps: "Joe's Pizza Carmine Street New York" },
        { d: 1, type: 'activity', title: 'The City Reliquary, Williamsburg', location: 'New York', time: '15:30', cost: 8, maps: 'City Reliquary Museum Brooklyn', details: 'A shopfront museum of New York rubbish held as though it were treasure: seltzer bottles, subway tokens, a chunk of the old Penn Station, a shrine to Jackie Robinson. It opens a few afternoons a week, so check before crossing the river.' },
        { d: 1, type: 'activity', title: "Drinks: Please Don't Tell", location: 'New York', time: '21:00', est: 45, maps: "Please Don't Tell PDT New York", details: 'Entered through the phone box inside a hot dog shop on St Marks Place. You pick up the receiver, somebody answers, and the back wall opens.' },

        { d: 2, type: 'activity', title: 'Coney Island: the Cyclone and the boardwalk', location: 'New York', time: '11:00', cost: 15, maps: 'Luna Park Coney Island Brooklyn' },
        { d: 2, type: 'activity', title: "Lunch: Nathan's Famous on Surf Avenue", location: 'New York', time: '13:00', est: 14, maps: "Nathan's Famous Coney Island" },
        { d: 2, type: 'activity', title: 'Coney Island Circus Sideshow', location: 'New York', time: '15:00', cost: 15, maps: 'Coney Island USA Sideshow Brooklyn', details: 'Sword swallowing, fire eating and a snake charmer, in what is billed as the last permanently housed ten-in-one sideshow in the country. The building upstairs is a museum about itself.' },
        { d: 2, type: 'local', title: 'Q train back to the hotel', location: 'New York', time: '17:30', cost: 3, maps: 'Pod 51 Hotel New York' },
        { d: 2, type: 'activity', title: 'Dinner: Grand Central Oyster Bar', location: 'New York', time: '19:30', est: 60, maps: 'Grand Central Oyster Bar New York' },
        { d: 2, type: 'activity', title: 'Cancelled: Broadway evening show', location: 'New York', time: '20:00', status: 'cancelled', maps: 'Richard Rodgers Theatre New York', details: 'Nothing left under three hundred dollars a seat on these dates. Left on the plan in case a day-of lottery comes through.' },

        // ---- collect the car, Philadelphia on the way, two nights in Washington ----
        { d: 3, type: 'activity', title: 'Collect the rental car, Midtown West', location: 'New York', time: '08:00', status: 'booked', cost: 1980, maps: 'Hertz West 43rd Street New York', details: 'Twenty-six days one way, New York to San Francisco. The one-way drop charge is most of what makes this number look like that, and it is worth pricing an airport pickup against a Manhattan one before booking: the garage rate here is high and the traffic getting out is worse.' },
        { d: 3, type: 'transport', title: 'New York to Washington DC', time: '09:00', endTime: '17:00', status: 'booked', cost: 62, details: 'About four and a half hours of actual driving on the New Jersey Turnpike and I-95, split by three hours in Philadelphia. Tolls are the whole cost of this leg; the fuel is barely a third of it.' },
        { d: 3, type: 'activity', title: 'Run the Rocky steps at the Art Museum', location: 'Philadelphia', time: '11:30', maps: 'Rocky Steps Philadelphia Museum of Art' },
        { d: 3, type: 'activity', title: "Lunch: Jim's South St cheesesteak", location: 'Philadelphia', time: '12:45', est: 15, maps: "Jim's South Street Philadelphia", details: 'Order it the local way or hold the queue up: the cheese first, then whether you want onions. Whiz wit, provolone witout, and so on.' },
        { d: 3, type: 'activity', title: "Philadelphia's Magic Gardens", location: 'Philadelphia', time: '14:00', cost: 15, maps: "Philadelphia's Magic Gardens", details: 'Half a city block of tunnels and terraces mosaicked out of broken bottles, bicycle wheels and dinner plates by one man over three decades. He tiled most of the neighbourhood too, so look at the walls on the walk back to the car.' },
        { d: 3, end: 5, type: 'stay', title: 'Kimpton Hotel Monaco Washington DC', location: 'Washington DC', status: 'booked', cost: 520, maps: 'Kimpton Hotel Monaco Washington DC', details: 'Two nights in Penn Quarter, ten minutes walk from the Mall.' },
        { d: 3, type: 'activity', title: "Dinner: Ben's Chili Bowl", location: 'Washington DC', time: '19:30', est: 18, maps: "Ben's Chili Bowl Washington DC" },

        { d: 4, type: 'activity', title: 'The Mall monuments by bike', location: 'Washington DC', time: '09:00', cost: 25, maps: 'Lincoln Memorial Washington DC', details: 'The Mall is two miles end to end and everybody underestimates it on foot. A docked bike costs less than a coffee for the morning.' },
        { d: 4, type: 'activity', title: 'National Air and Space Museum', location: 'Washington DC', time: '11:30', maps: 'National Air and Space Museum Washington DC', details: 'Free, like every Smithsonian, but entry runs on a timed pass you have to claim online first.' },
        { d: 4, type: 'activity', title: 'Lunch: Union Market', location: 'Washington DC', time: '14:00', est: 20, maps: 'Union Market Washington DC' },
        { d: 4, type: 'activity', title: 'The Exorcist steps, Georgetown', location: 'Washington DC', time: '16:30', maps: 'The Exorcist Steps Georgetown Washington DC', details: 'Seventy-five near-vertical steps between M Street and Prospect Street, padded with rubber for the film and now an official city landmark. Locals run them for exercise, which is its own kind of horror.' },
        { d: 4, type: 'activity', title: 'Dinner: Old Ebbitt Grill', location: 'Washington DC', time: '19:30', est: 55, maps: 'Old Ebbitt Grill Washington DC' },

        // ---- the longest drive of the trip: down the Shenandoah Valley ----
        { d: 5, type: 'transport', title: 'Washington DC to Asheville', time: '07:30', endTime: '18:30', status: 'booked', cost: 78, details: 'Eight hours of road, the longest single leg of the trip: I-81 the whole length of the Shenandoah Valley, then I-26 over the Blue Ridge into North Carolina. Nothing else is booked into this day on purpose, and the one stop in the middle of it is deliberately ridiculous.' },
        { d: 5, type: 'activity', title: 'Dinosaur Kingdom II, Natural Bridge', location: 'Natural Bridge, Virginia', time: '11:30', cost: 16, maps: 'Dinosaur Kingdom II Natural Bridge Virginia', details: 'A hillside of hand-built dinosaurs fighting Union soldiers, on the premise that the army tried to weaponise them in 1863. Built by the sculptor who also made the full-size polystyrene Stonehenge that used to sit down the road, and every bit as committed to the bit as that sounds.' },
        { d: 5, type: 'activity', title: 'Lunch: Pink Cadillac Diner, Natural Bridge', location: 'Natural Bridge, Virginia', time: '13:15', est: 16, maps: 'Pink Cadillac Diner Natural Bridge Virginia' },
        { d: 5, end: 6, type: 'stay', title: 'The Foundry Hotel Asheville', location: 'Asheville', status: 'booked', cost: 215, maps: 'The Foundry Hotel Asheville', details: 'One night downtown, in the old steel works that supplied the Biltmore.' },
        { d: 5, type: 'activity', title: 'Dinner: Buxton Hall Barbecue', location: 'Asheville', time: '19:45', est: 32, maps: 'Buxton Hall Barbecue Asheville' },

        // ---- over the Smokies to Nashville ----
        { d: 6, type: 'transport', title: 'Asheville to Nashville', time: '08:00', endTime: '17:45', status: 'booked', cost: 58, details: 'Six and a half hours if you drove it straight, which nobody does: the road crosses Great Smoky Mountains National Park on Newfound Gap Road and comes out the other side in Gatlinburg.' },
        { d: 6, type: 'activity', title: 'Newfound Gap Road over the Smokies', location: 'Great Smoky Mountains National Park', time: '09:30', maps: 'Newfound Gap Great Smoky Mountains National Park', details: 'The most visited national park in the country and it charges nothing to drive through it. The gap sits at 5,046 feet on the state line, and the pull-off at Morton Overlook is the one worth stopping at.' },
        { d: 6, type: 'activity', title: 'The Salt and Pepper Shaker Museum, Gatlinburg', location: 'Gatlinburg', time: '12:00', cost: 3, maps: 'Salt and Pepper Shaker Museum Gatlinburg Tennessee', details: 'Twenty thousand sets of salt and pepper shakers in a building off the parkway, assembled by an archaeologist who started collecting pepper mills and could not stop. The three dollars comes off anything you buy.' },
        { d: 6, type: 'activity', title: 'Lunch: Pancake Pantry, Gatlinburg', location: 'Gatlinburg', time: '13:15', est: 16, maps: 'Pancake Pantry Gatlinburg Tennessee' },
        { d: 6, end: 8, type: 'stay', title: 'Noelle Nashville', location: 'Nashville', status: 'booked', cost: 470, maps: 'Noelle Nashville', details: 'Two nights on Fourth Avenue, one block off Lower Broadway.' },
        { d: 6, type: 'activity', title: 'The honky-tonks on Lower Broadway', location: 'Nashville', maps: "Robert's Western World Nashville", details: 'Untimed on purpose. Bands start in the early afternoon and change every couple of hours, nobody charges at the door, and the whole point is walking in and out of four of them until one holds you. Robert\'s is the one that still books proper honky-tonk.' },

        { d: 7, type: 'activity', title: 'The full-size Parthenon in Centennial Park', location: 'Nashville', time: '09:30', cost: 10, maps: 'Parthenon Centennial Park Nashville', details: 'An exact concrete replica of the Parthenon, built for a fair in 1897 and never taken down, with a gilded forty-two foot Athena standing inside it. Nashville has called itself the Athens of the South ever since, and this is the receipt.' },
        { d: 7, type: 'activity', title: "Lunch: Hattie B's Hot Chicken", location: 'Nashville', time: '12:30', est: 17, maps: "Hattie B's Hot Chicken Nashville", details: 'Order one step below whatever heat you think you can handle. Shut the Cluck Up is not a name they chose lightly.' },
        { d: 7, type: 'activity', title: 'RCA Studio B on Music Row', location: 'Nashville', time: '15:00', cost: 56, maps: 'RCA Studio B Nashville', details: 'The room where Elvis cut over two hundred sides and Dolly Parton cut Jolene. Tours leave from the Country Music Hall of Fame and the ticket covers both.' },
        { d: 7, type: 'activity', title: 'Grand Ole Opry', location: 'Nashville', time: '19:00', status: 'booked', cost: 92, maps: 'Grand Ole Opry Nashville' },
        { d: 7, type: 'local', title: 'Ride back to the hotel from Opryland', location: 'Nashville', time: '22:15', cost: 32, maps: 'Noelle Nashville' },

        // ---- Memphis ----
        { d: 8, type: 'transport', title: 'Nashville to Memphis', time: '08:30', endTime: '11:45', status: 'booked', cost: 34, details: 'Three hours west on I-40. Casey Jones Village at Jackson is signposted off it if the day needs padding, and it is exactly as odd as it sounds.' },
        { d: 8, end: 10, type: 'stay', title: 'Central Station Memphis', location: 'Memphis', status: 'booked', cost: 385, maps: 'Central Station Memphis Hotel', details: 'Two nights in the old Illinois Central railway station in South Main, with the Amtrak platform still working underneath.' },
        { d: 8, type: 'activity', title: 'Graceland', location: 'Memphis', time: '13:30', cost: 85, maps: 'Graceland Memphis', details: 'Kept exactly as it was in 1977, which turns out to be the reason to go: the Jungle Room with green shag carpet on the ceiling, a mirrored stairwell, three televisions set into one wall. The house is smaller than the myth and the taste is louder.' },
        { d: 8, type: 'activity', title: 'Drinks: live blues at the Rum Boogie Cafe', location: 'Memphis', time: '18:30', est: 26, maps: 'Rum Boogie Cafe Beale Street Memphis' },
        { d: 8, type: 'activity', title: 'Dinner: Charlie Vergos Rendezvous', location: 'Memphis', time: '20:30', est: 38, maps: 'Charlie Vergos Rendezvous Memphis' },

        { d: 9, type: 'activity', title: 'Sun Studio', location: 'Memphis', time: '09:30', cost: 19, maps: 'Sun Studio Memphis' },
        { d: 9, type: 'activity', title: 'The Peabody duck march', location: 'Memphis', time: '11:00', maps: 'The Peabody Memphis', details: 'Five mallards take the lift down from a rooftop palace at eleven every morning, walk a red carpet to the lobby fountain to a Sousa march, and ride back up at five. The ducks have been doing it since 1933 and the hotel has employed a Duckmaster to walk them since 1940. Free, and the lobby is three deep by 10:45.' },
        { d: 9, type: 'activity', title: "Lunch: Gus's World Famous Fried Chicken", location: 'Memphis', time: '13:00', est: 16, maps: "Gus's World Famous Fried Chicken Memphis" },
        { d: 9, type: 'activity', title: 'National Civil Rights Museum at the Lorraine Motel', location: 'Memphis', time: '15:00', cost: 20, maps: 'National Civil Rights Museum Memphis' },
        { d: 9, type: 'activity', title: "Dinner: Payne's Bar-B-Q", location: 'Memphis', time: '19:00', est: 15, maps: "Payne's Bar-B-Que Memphis" },

        // ---- one night in the Delta ----
        { d: 10, type: 'transport', title: 'Memphis to Clarksdale, Mississippi', time: '11:00', endTime: '12:30', status: 'booked', cost: 18, details: 'Ninety minutes south on Highway 61, flat and straight and nearly empty. Deliberately the shortest leg of the trip: the Delta is the point of the day, not the driving.' },
        { d: 10, end: 11, type: 'stay', title: 'Shack Up Inn', location: 'Clarksdale, Mississippi', status: 'booked', cost: 115, maps: 'Shack Up Inn Clarksdale Mississippi', details: 'One night in a restored sharecropper shack on the old Hopson plantation: tin roof, screen door, a porch swing and a cotton gin next door that is now the bar.' },
        { d: 10, type: 'activity', title: 'The Crossroads at Highways 61 and 49', location: 'Clarksdale, Mississippi', time: '14:00', maps: 'Crossroads Clarksdale Mississippi', details: 'Three blue guitars on a pole above a petrol station junction, marking where Robert Johnson is supposed to have sold his soul. It is a traffic light with a legend bolted to it, and it is worth the five minutes.' },
        { d: 10, type: 'activity', title: 'Delta Blues Museum', location: 'Clarksdale, Mississippi', time: '15:00', cost: 10, maps: 'Delta Blues Museum Clarksdale Mississippi' },
        { d: 10, type: 'activity', title: "Dinner: Abe's Bar-B-Q at the crossroads", location: 'Clarksdale, Mississippi', time: '18:30', est: 15, maps: "Abe's Bar-B-Q Clarksdale Mississippi" },
        { d: 10, type: 'activity', title: "Drinks: live blues at Red's Lounge", location: 'Clarksdale, Mississippi', time: '21:00', est: 12, maps: "Red's Lounge Clarksdale Mississippi", details: 'A juke joint in the proper sense: red bulbs, mismatched chairs, a space heater, and whoever is playing sets up on the floor rather than a stage. Cash, and it opens when it opens.' },

        // ---- New Orleans, three nights ----
        { d: 11, type: 'transport', title: 'Clarksdale, Mississippi to New Orleans', time: '08:30', endTime: '15:00', status: 'booked', cost: 56, details: 'Five and a half hours down US-49 and I-55 through Jackson, out of the Delta and into Louisiana. The last half hour crosses the Bonnet Carre spillway on five miles of bridge over open swamp.' },
        { d: 11, type: 'activity', title: "Lunch: Bully's Restaurant, Jackson", location: 'Jackson, Mississippi', time: '11:45', est: 15, maps: "Bully's Restaurant Jackson Mississippi" },
        { d: 11, end: 14, type: 'stay', title: 'Hotel Peter and Paul', location: 'New Orleans', status: 'booked', cost: 690, maps: 'Hotel Peter and Paul New Orleans', details: 'Three nights in the Marigny, in a converted church, school, rectory and convent that are still recognisably all four.' },
        { d: 11, type: 'activity', title: 'Beignets at Cafe du Monde', location: 'New Orleans', time: '17:30', est: 9, maps: 'Cafe du Monde New Orleans' },
        { d: 11, type: 'activity', title: 'Dinner: Cochon', location: 'New Orleans', time: '20:00', est: 62, maps: 'Cochon Restaurant New Orleans' },

        { d: 12, type: 'activity', title: 'St Louis Cemetery No. 1 and the French Quarter', location: 'New Orleans', time: '09:30', cost: 25, maps: 'St Louis Cemetery No 1 New Orleans', details: 'The cemetery can only be entered with a licensed guide, which is a rule worth knowing before you turn up at the gate. Everything is above ground because the water table is; the tombs are ovens that get reused across generations.' },
        { d: 12, type: 'activity', title: 'Lunch: Parkway Bakery po-boy', location: 'New Orleans', time: '12:45', est: 17, maps: 'Parkway Bakery and Tavern New Orleans' },
        { d: 12, type: 'activity', title: 'The Museum of Death, French Quarter', location: 'New Orleans', time: '15:00', cost: 20, maps: 'Museum of Death New Orleans', details: 'Exactly what the sign says, and not remotely a joke: mortician instruments, crime scene photographs, letters from people you would rather not think about. Nobody minds if you leave early, and a fair number do.' },
        { d: 12, type: 'activity', title: "Dinner: Commander's Palace", location: 'New Orleans', time: '19:00', est: 95, maps: "Commander's Palace New Orleans", details: 'Book weeks out and wear a collar. Lunch here is a third of the price and has twenty-five cent martinis, if the schedule can be bent.' },
        { d: 12, type: 'activity', title: 'Jazz at Preservation Hall', location: 'New Orleans', time: '21:30', status: 'booked', cost: 50, maps: 'Preservation Hall New Orleans' },

        { d: 13, type: 'activity', title: 'Swamp tour on the Manchac wetlands', location: 'New Orleans', time: '09:00', cost: 58, maps: 'Manchac Swamp Louisiana' },
        { d: 13, type: 'activity', title: "Lunch: Willie Mae's Scotch House", location: 'New Orleans', time: '14:00', est: 22, maps: "Willie Mae's Scotch House New Orleans" },
        { d: 13, type: 'activity', title: 'The St Charles streetcar to the Garden District', location: 'New Orleans', time: '16:00', cost: 3, maps: 'St Charles Avenue Streetcar New Orleans', details: 'The oldest continuously running street railway in the world, in olive green cars from 1923 with wooden seats and no air conditioning. A single fare buys the whole length of it.' },
        { d: 13, type: 'activity', title: 'Dinner: Turkey and the Wolf', location: 'New Orleans', time: '18:30', est: 28, maps: 'Turkey and the Wolf New Orleans' },
        { d: 13, type: 'activity', title: 'Drinks: Frenchmen Street', location: 'New Orleans', time: '21:00', est: 32, maps: 'Frenchmen Street New Orleans', details: 'Three blocks of live music with no cover at most doors: the Spotted Cat, d.b.a., the Apple Barrel. This is where the city goes when Bourbon Street fills up with everybody else.' },

        // ---- Cajun country, a deliberately short day ----
        { d: 14, type: 'transport', title: 'New Orleans to Lafayette, Louisiana', time: '09:00', endTime: '15:30', status: 'booked', cost: 32, details: 'Two and a half hours of actual driving stretched across a whole day, and the shortest hop west of the Mississippi. Part of it runs on the Atchafalaya Basin Bridge, eighteen miles of elevated interstate over cypress swamp.' },
        { d: 14, type: 'activity', title: 'Tabasco factory and Jungle Gardens, Avery Island', location: 'Avery Island, Louisiana', time: '11:30', cost: 16, maps: 'Tabasco Factory Avery Island Louisiana', details: 'The whole world supply comes off a salt dome in a swamp, aged three years in oak. The same family also keeps a bird sanctuary next door with a centuries-old Buddha in it, which nobody involved has ever fully explained.' },
        { d: 14, type: 'activity', title: 'Lunch: boudin and cracklins at the Best Stop, Scott', location: 'Scott, Louisiana', time: '13:30', est: 11, maps: 'Best Stop Supermarket Scott Louisiana' },
        { d: 14, end: 15, type: 'stay', title: 'Juliet Hotel Lafayette', location: 'Lafayette, Louisiana', status: 'booked', cost: 135, maps: 'Juliet Hotel Lafayette Louisiana', details: 'One night on Jefferson Street, in the middle of downtown.' },
        { d: 14, type: 'activity', title: "Dinner: Prejean's", location: 'Lafayette, Louisiana', time: '18:00', est: 34, maps: "Prejean's Restaurant Lafayette Louisiana", details: 'Cajun cooking with a band on most nights and a fourteen-foot alligator in the lobby, which is not a decorating choice anywhere else.' },
        { d: 14, type: 'activity', title: 'Drinks: Cajun jam at the Blue Moon Saloon', location: 'Lafayette, Louisiana', time: '20:00', est: 14, maps: 'Blue Moon Saloon Lafayette Louisiana', details: 'A back porch behind a guesthouse where the band plays in French and people two-step on the boards. Somebody will show you the step if you look like you want to be shown.' },

        // ---- across Texas: Houston on the way, two nights in Austin ----
        { d: 15, type: 'transport', title: 'Lafayette, Louisiana to Austin', time: '07:30', endTime: '18:30', status: 'booked', cost: 74, details: 'Six and a half hours of I-10 west across the coastal plain, broken in Houston. The stretch either side of Beaumont is refinery country and looks like nothing else on the trip, especially after dark.' },
        { d: 15, type: 'activity', title: 'The Beer Can House, Houston', location: 'Houston', time: '11:00', cost: 5, maps: 'Beer Can House Houston', details: 'A bungalow sided, roofed and fenced in flattened beer cans, about fifty thousand of them, by one retired upholsterer who said he just got tired of mowing the lawn. The garlands of pull tabs across the porch move in the wind and the whole house rustles.' },
        { d: 15, type: 'activity', title: 'Lunch: Truth BBQ, Houston', location: 'Houston', time: '12:30', est: 28, maps: 'Truth Barbeque Houston' },
        { d: 15, type: 'activity', title: "Buc-ee's, Luling", location: 'Luling, Texas', time: '15:45', est: 12, maps: "Buc-ee's Luling Texas", details: 'A petrol station with over a hundred pumps, a brisket counter, a wall of jerky, a beaver mascot and a national reputation for its lavatories. It is not an ironic stop; it is a genuine Texan institution and the scale of it has to be seen.' },
        { d: 15, end: 17, type: 'stay', title: 'Hotel San Jose', location: 'Austin', status: 'booked', cost: 480, maps: 'Hotel San Jose Austin', details: 'Two nights on South Congress, a converted 1930s motor court with the rooms opening onto the courtyard.' },
        { d: 15, type: 'activity', title: 'Dinner: Veracruz All Natural', location: 'Austin', time: '20:30', est: 15, maps: 'Veracruz All Natural Austin' },

        { d: 16, type: 'activity', title: 'Barton Springs Pool', location: 'Austin', time: '09:30', cost: 10, maps: 'Barton Springs Pool Austin', details: 'A three-acre spring-fed pool in the middle of the city that sits at about 20C every day of the year, which is bracing in August and merciful in February.' },
        { d: 16, type: 'activity', title: 'Cathedral of Junk', location: 'Austin', cost: 10, maps: 'Cathedral of Junk Austin', details: 'Sixty tons of salvage welded into towers, arches and a throne room in a suburban back garden in south Austin. No time set because there are no opening hours: you ring the number, Vince tells you when to come, and that is the booking system.' },
        { d: 16, type: 'activity', title: 'Lunch: Franklin Barbecue', location: 'Austin', time: '12:30', est: 32, maps: 'Franklin Barbecue Austin', details: 'The queue is the experience and it forms before opening. They sell out most days, so this is a stand-in-line-with-a-folding-chair plan rather than a lunch plan.' },
        { d: 16, type: 'activity', title: 'The bats under Congress Avenue Bridge', location: 'Austin', time: '20:00', maps: 'Congress Avenue Bridge Austin', details: 'Around a million and a half Mexican free-tailed bats live in the expansion joints under the bridge and pour out at dusk in a column you can see for a mile. Free, from the bridge itself or the lawn on the east bank.' },
        { d: 16, type: 'activity', title: 'Drinks: the Rainey Street bungalow bars', location: 'Austin', time: '21:30', est: 35, maps: 'Rainey Street Austin' },

        // ---- San Antonio, one night ----
        { d: 17, type: 'transport', title: 'Austin to San Antonio', time: '10:00', endTime: '11:30', status: 'booked', cost: 18, details: 'Ninety minutes down I-35, the shortest hop of the trip and the last easy one before west Texas.' },
        { d: 17, end: 18, type: 'stay', title: 'Hotel Havana', location: 'San Antonio', status: 'booked', cost: 195, maps: 'Hotel Havana San Antonio', details: 'One night on the quiet north end of the River Walk, in a 1914 building above the water.' },
        { d: 17, type: 'activity', title: 'Lunch: Mi Tierra Cafe y Panaderia', location: 'San Antonio', time: '12:30', est: 24, maps: 'Mi Tierra Cafe y Panaderia San Antonio', details: 'Open twenty-four hours since 1941 and decorated for Christmas every day of the year: tinsel, a thousand paper flowers, a mural of every famous Mexican-American the family could think of, and a bakery counter at the front.' },
        { d: 17, type: 'activity', title: 'The Alamo', location: 'San Antonio', time: '15:00', maps: 'The Alamo San Antonio', details: 'Free, and much smaller than the story: what survives is the chapel and part of the long barrack, in the middle of a downtown that grew up around it.' },
        { d: 17, type: 'activity', title: 'River Walk barge to the Pearl', location: 'San Antonio', time: '17:30', cost: 16, maps: 'San Antonio River Walk' },
        { d: 17, type: 'activity', title: 'Drinks: Esquire Tavern', location: 'San Antonio', time: '21:00', est: 22, maps: 'Esquire Tavern San Antonio', details: 'Opened the day Prohibition ended and it has the longest wooden bar in Texas, about a hundred feet of it along the river wall.' },

        // ---- west Texas ----
        { d: 18, type: 'transport', title: 'San Antonio to Marfa', time: '08:00', endTime: '15:00', status: 'booked', cost: 68, details: 'Six hours on I-10 and then US-90, and the emptiest driving of the whole trip. Past Fort Stockton the towns are an hour apart, the phone signal is not reliable, and it is worth filling the tank before you think you need to. Balmorhea State Park and its spring-fed pool sit just off the interstate at Toyahvale if the day wants a swim in it.' },
        { d: 18, type: 'activity', title: "Lunch: Cooper's Old Time Pit Bar-B-Que, Junction", location: 'Junction, Texas', time: '11:00', est: 26, maps: "Cooper's Old Time Pit Bar-B-Que Junction Texas", details: 'An early lunch on purpose: this is the last proper barbecue pit before the Davis Mountains, and you order off the pit outside rather than a menu.' },
        { d: 18, type: 'activity', title: 'Prada Marfa, out towards Valentine', location: 'Valentine, Texas', time: '16:15', maps: 'Prada Marfa Valentine Texas', details: 'A permanently sealed replica of a Prada shop standing alone beside US-90 with real bags in the window, forty minutes west of Marfa and about as far from anything else. It was built to be left to the desert and it has been fighting the desert since 2005.' },
        { d: 18, end: 19, type: 'stay', title: 'El Cosmico', location: 'Marfa', status: 'booked', cost: 185, maps: 'El Cosmico Marfa Texas', details: 'One night in a restored 1950s trailer on the scrub at the edge of town, with a wood-fired tub and no television anywhere on site.' },
        { d: 18, type: 'activity', title: 'Dinner: Cochineal', location: 'Marfa', time: '19:00', est: 58, maps: 'Cochineal Marfa Texas' },
        { d: 18, type: 'activity', title: 'The Marfa Lights viewing area', location: 'Marfa', time: '21:30', maps: 'Marfa Lights Viewing Area Texas', details: 'A purpose-built roadside platform nine miles east of town, pointed at the Chinati foothills, where people have reported unexplained lights since the 1880s. The state built toilets and a car park for it, which is the most Texan part of the story.' },

        // ---- into New Mexico ----
        { d: 19, type: 'activity', title: 'Breakfast: Marfa Burrito', location: 'Marfa', time: '08:00', est: 9, maps: 'Marfa Burrito Marfa Texas' },
        { d: 19, type: 'transport', title: 'Marfa to Alamogordo', time: '09:00', endTime: '15:00', status: 'booked', cost: 52, details: 'Four and a half hours through Van Horn and El Paso and up the Tularosa Basin. There is a Border Patrol checkpoint on US-54 north of El Paso; have passports where you can reach them.' },
        { d: 19, type: 'activity', title: 'White Sands National Park', location: 'White Sands National Park', time: '16:30', cost: 25, maps: 'White Sands National Park New Mexico', details: 'Two hundred and seventy-five square miles of gypsum dune, white as snow and cool underfoot even in high summer. The visitor centre sells plastic sleds for the dunes and buys them back off you on the way out, which is a resale market the National Park Service did not plan for.' },
        { d: 19, end: 20, type: 'stay', title: 'Hampton Inn Alamogordo', location: 'Alamogordo', status: 'booked', cost: 128, maps: 'Hampton Inn Alamogordo New Mexico', details: 'One night, picked for being fifteen minutes from the dunes rather than for itself.' },
        { d: 19, type: 'activity', title: "Dinner: Rockin' BZ Burgers", location: 'Alamogordo', time: '19:30', est: 16, maps: "Rockin' BZ Burgers Alamogordo New Mexico", details: 'Green chile cheeseburger, which from here to Arizona is less a dish than a civic obligation.' },

        { d: 20, type: 'transport', title: 'Alamogordo to Santa Fe', time: '08:30', endTime: '12:45', status: 'booked', cost: 44, details: 'Four hours north up the Tularosa Basin, past the Valley of Fires lava flow, climbing about four thousand feet by the end of it. Santa Fe is the highest state capital in the country and the air tells you so.' },
        { d: 20, end: 21, type: 'stay', title: 'Hotel Chimayo de Santa Fe', location: 'Santa Fe', status: 'booked', cost: 225, maps: 'Hotel Chimayo de Santa Fe', details: 'One night half a block off the Plaza.' },
        { d: 20, type: 'activity', title: "Lunch: Tia Sophia's", location: 'Santa Fe', time: '13:15', est: 20, maps: "Tia Sophia's Santa Fe" },
        { d: 20, type: 'activity', title: 'Meow Wolf: House of Eternal Return', location: 'Santa Fe', time: '14:30', status: 'booked', cost: 45, maps: 'Meow Wolf Santa Fe', details: 'A Victorian house you are supposed to climb through: the fridge is a door, so is the fireplace, and behind them are a neon forest, a mastodon rib cage you can play like a harp and a laundromat that opens onto somewhere else. An arts collective built it inside a bowling alley that George R. R. Martin bought for them.' },
        { d: 20, type: 'activity', title: 'Canyon Road galleries at dusk', location: 'Santa Fe', time: '18:00', maps: 'Canyon Road Santa Fe' },
        { d: 20, type: 'activity', title: 'Dinner: The Shed', location: 'Santa Fe', time: '20:00', est: 38, maps: 'The Shed Restaurant Santa Fe', details: 'Red or green is the only question anybody will ask you. Christmas means both.' },

        // ---- Route 66 across Arizona ----
        { d: 21, type: 'transport', title: 'Santa Fe to Flagstaff', time: '07:00', endTime: '17:30', status: 'booked', cost: 82, details: 'Six hours of I-40 if you drive it straight, and it is the old Route 66 alignment for most of that. Two long stops make it the whole day. Arizona keeps its own time and does not move its clocks, so depending on the month you either gain an hour at the state line or you do not.' },
        { d: 21, type: 'activity', title: 'Petrified Forest and the Painted Desert', location: 'Petrified Forest National Park', time: '11:30', cost: 30, maps: 'Petrified Forest National Park Arizona', details: 'The park road runs twenty-eight miles between two interstate exits, so it is a drive-through rather than a detour. It is also the only national park with a section of Route 66 inside it, marked by a rusted 1932 Studebaker in the scrub.' },
        { d: 21, type: 'activity', title: "Standin' on the Corner Park, Winslow", location: 'Winslow, Arizona', time: '14:30', maps: "Standin' on the Corner Park Winslow Arizona", details: 'A corner, a trompe-l\'oeil mural, a bronze man with a guitar and a flatbed Ford permanently parked at the kerb, all of it built because of one line in one Eagles song. The town was dying when it put this up and it is not dying now.' },
        { d: 21, type: 'activity', title: 'Lunch: the Turquoise Room at La Posada, Winslow', location: 'Winslow, Arizona', time: '15:15', est: 38, maps: 'La Posada Hotel Winslow Arizona' },
        { d: 21, end: 22, type: 'stay', title: 'Hotel Monte Vista', location: 'Flagstaff', status: 'booked', cost: 125, maps: 'Hotel Monte Vista Flagstaff Arizona', details: 'One night in a 1927 Route 66 hotel that names its rooms after the film stars who slept in them and insists several of them never left.' },
        { d: 21, type: 'activity', title: 'Drinks: the Museum Club, Route 66', location: 'Flagstaff', time: '20:30', est: 18, maps: 'Museum Club Flagstaff Arizona', details: 'A 1931 log cabin roadhouse built around five ponderosa pines, hung with the taxidermy collection it was originally built to display, with a dance floor underneath it all.' },

        { d: 22, type: 'transport', title: 'Flagstaff to Las Vegas', time: '07:30', endTime: '19:30', status: 'booked', cost: 72, details: 'Five and a half hours of driving stretched over twelve by the Grand Canyon in the middle of it. The last stretch drops off the Colorado Plateau and crosses the Hoover Dam bypass bridge, which is worth pulling over for.' },
        { d: 22, type: 'activity', title: 'Grand Canyon South Rim: Mather Point and the Rim Trail', location: 'Grand Canyon National Park', time: '09:15', status: 'booked', cost: 35, maps: 'Mather Point Grand Canyon National Park', details: 'The entrance fee is per car and covers seven days, so nobody counts heads. Mather Point is the first view past the gate and therefore the busiest; walking twenty minutes west along the Rim Trail loses most of the crowd and none of the canyon.' },
        { d: 22, type: 'activity', title: "Lunch: Delgadillo's Snow Cap Drive-In, Seligman", location: 'Seligman, Arizona', time: '13:45', est: 15, maps: "Delgadillo's Snow Cap Drive-In Seligman Arizona", details: 'A 1953 drive-in built out of scrap lumber, with a menu offering dead chicken and a staff who have been pulling the same practical jokes on customers for seventy years. Seligman is where the campaign to save Route 66 started, and it is the reason the Cars films look the way they do.' },
        { d: 22, end: 24, type: 'stay', title: 'The LINQ Hotel and Casino', location: 'Las Vegas', status: 'booked', cost: 265, maps: 'The LINQ Hotel and Casino Las Vegas', details: 'Two nights mid-Strip. The nightly resort fee is not in the room rate and is not optional, which is the local custom.' },
        { d: 22, type: 'activity', title: 'The Strip after dark, on foot', location: 'Las Vegas', time: '21:30', maps: 'Las Vegas Strip' },

        { d: 23, type: 'activity', title: 'The Neon Museum boneyard', location: 'Las Vegas', time: '10:00', cost: 30, maps: 'Neon Museum Las Vegas', details: 'Two acres of dead casino signs laid out in the dirt: the Stardust script, the Moulin Rouge, a silver slipper the size of a car. Book the evening slot if you can, when about a dozen of them are lit.' },
        { d: 23, type: 'activity', title: 'Lunch: Lotus of Siam', location: 'Las Vegas', time: '12:30', est: 34, maps: 'Lotus of Siam Las Vegas' },
        { d: 23, type: 'activity', title: 'The Pinball Hall of Fame', location: 'Las Vegas', time: '15:00', est: 20, maps: 'Pinball Hall of Fame Las Vegas', details: 'Ten thousand square feet of working machines from the 1950s onward, at their original coin price, in a warehouse off the Strip. No bar, no queue, and the profits go to charity.' },
        { d: 23, type: 'activity', title: 'Dinner: Peppermill Fireside Lounge', location: 'Las Vegas', time: '18:30', est: 42, maps: 'Peppermill Restaurant and Fireside Lounge Las Vegas', details: 'Unchanged since 1972: neon cherry blossom, mirrored ceilings, a fire pit in a pool of water and cocktails served in vessels you need both hands for.' },
        { d: 23, type: 'activity', title: 'Fremont Street and the old downtown casinos', location: 'Las Vegas', time: '21:00', est: 28, maps: 'Fremont Street Experience Las Vegas' },

        // ---- across the Mojave: the roadside-attraction day ----
        { d: 24, type: 'transport', title: 'Las Vegas to Los Angeles', time: '08:30', endTime: '18:00', status: 'booked', cost: 58, details: 'Four and a half hours of I-15 across the Mojave, and the best-stocked stretch of roadside America on the whole route. The last hour is not desert, it is traffic, and it is worth timing to miss the worst of it.' },
        { d: 24, type: 'activity', title: 'Seven Magic Mountains', location: 'Jean, Nevada', time: '09:15', maps: 'Seven Magic Mountains Nevada', details: 'Seven stacks of fluorescent boulders thirty feet high, dropped in the desert twenty minutes south of the Strip. Free, and there is nothing else there at all, which is most of the effect.' },
        { d: 24, type: 'activity', title: 'Calico Ghost Town', location: 'Yermo, California', time: '11:30', cost: 10, maps: 'Calico Ghost Town Yermo California', details: 'A silver mining town that emptied out in the 1890s, bought and part-rebuilt by the man who went on to found Knott\'s Berry Farm. A third of it is original, the rest is a theme park, and it does not pretend otherwise.' },
        { d: 24, type: 'activity', title: "Lunch: Peggy Sue's 50s Diner, Yermo", location: 'Yermo, California', time: '13:00', est: 19, maps: "Peggy Sue's 50's Diner Yermo California" },
        { d: 24, type: 'activity', title: "Elmer's Bottle Tree Ranch, Oro Grande", location: 'Oro Grande, California', time: '14:45', maps: "Elmer's Bottle Tree Ranch Oro Grande California", details: 'Two hundred welded steel trees hung with old glass bottles on a surviving stretch of Route 66, planted one at a time by a retired man out of his father\'s bottle collection. Free, no gate, and the whole thing rings when the wind gets up.' },
        { d: 24, end: 26, type: 'stay', title: 'Hotel Normandie', location: 'Los Angeles', status: 'booked', cost: 390, maps: 'Hotel Normandie Los Angeles', details: 'Two nights in Koreatown, on the Metro, which is the one part of Los Angeles where the car can stay parked.' },
        { d: 24, type: 'activity', title: 'Dinner: Guisados, Echo Park', location: 'Los Angeles', time: '20:00', est: 16, maps: 'Guisados Echo Park Los Angeles' },

        { d: 25, type: 'activity', title: 'Venice Beach boardwalk and Muscle Beach', location: 'Los Angeles', time: '09:00', maps: 'Venice Beach Boardwalk Los Angeles' },
        { d: 25, type: 'activity', title: 'The Museum of Jurassic Technology, Culver City', location: 'Los Angeles', time: '11:30', cost: 12, maps: 'Museum of Jurassic Technology Culver City', details: 'A museum that will not tell you which of its exhibits are true. Somewhere between the horn that grew out of a woman\'s head and the bat that flies through walls you stop trying to work it out, and that is the exhibit.' },
        { d: 25, type: 'activity', title: 'Lunch: Grand Central Market, downtown', location: 'Los Angeles', time: '13:30', est: 19, maps: 'Grand Central Market Los Angeles' },
        { d: 25, type: 'activity', title: 'Griffith Observatory at sunset', location: 'Los Angeles', time: '16:30', maps: 'Griffith Observatory Los Angeles', details: 'Free to enter, and the terrace holds both the best view of the Hollywood sign and the best view of the whole basin lighting up. Parking is the hard part; the shuttle from the Greek Theatre is the answer.' },
        { d: 25, type: 'activity', title: 'Drinks: the Frolic Room, Hollywood Boulevard', location: 'Los Angeles', time: '20:30', est: 22, maps: 'Frolic Room Los Angeles' },

        // ---- up the coast ----
        { d: 26, type: 'transport', title: 'Los Angeles to Cambria, California', time: '08:00', endTime: '17:00', status: 'booked', cost: 46, details: 'Four and a half hours up US-101 with the ocean on the left from Ventura onward. Hearst Castle is ten minutes past the hotel if you would rather spend the afternoon on a tour than on a beach; it books out days ahead either way.' },
        { d: 26, type: 'activity', title: 'Santa Barbara: the Funk Zone and the harbour', location: 'Santa Barbara', time: '10:30', maps: 'Funk Zone Santa Barbara' },
        { d: 26, type: 'activity', title: 'Lunch: La Super-Rica Taqueria, Santa Barbara', location: 'Santa Barbara', time: '12:15', est: 17, maps: 'La Super-Rica Taqueria Santa Barbara' },
        { d: 26, type: 'activity', title: 'The elephant seal rookery at Piedras Blancas', location: 'San Simeon, California', time: '15:30', maps: 'Piedras Blancas Elephant Seal Rookery California', details: 'A free boardwalk straight off Highway 1 where several thousand elephant seals lie in the sand throwing it over themselves, bellowing and occasionally fighting. No fence, no ticket, no warden, and they are enormous.' },
        { d: 26, end: 27, type: 'stay', title: 'Cambria Pines Lodge', location: 'Cambria, California', status: 'booked', cost: 195, maps: 'Cambria Pines Lodge California', details: 'One night in the pines above the village, a short walk down to Moonstone Beach.' },
        { d: 26, type: 'activity', title: "Dinner: Linn's Restaurant, Cambria", location: 'Cambria, California', time: '19:00', est: 32, maps: "Linn's Restaurant Cambria California" },

        { d: 27, type: 'transport', title: 'Cambria, California to San Francisco', time: '08:00', endTime: '18:00', status: 'booked', cost: 48, details: 'The Big Sur run: ninety miles of Highway 1 between Ragged Point and Carmel that take three hours because you keep stopping, then two more up through Monterey and over the hills into the city. Check the road is open before you set off, because landslides close it for months at a time and the inland detour is long.' },
        { d: 27, type: 'activity', title: 'McWay Falls and Bixby Creek Bridge', location: 'Big Sur, California', time: '09:45', maps: 'McWay Falls Big Sur California' },
        { d: 27, type: 'activity', title: 'Lunch: Nepenthe, Big Sur', location: 'Big Sur, California', time: '12:30', est: 40, maps: 'Nepenthe Big Sur California' },
        { d: 27, type: 'activity', title: 'Cannery Row and the 17-Mile Drive', location: 'Monterey', time: '15:00', cost: 12, maps: '17-Mile Drive Pebble Beach California' },
        { d: 27, end: 29, type: 'stay', title: 'Hotel Zeppelin San Francisco', location: 'San Francisco', status: 'booked', cost: 495, maps: 'Hotel Zeppelin San Francisco', details: 'Two nights off Union Square. Overnight parking is charged separately and is not cheap, which is normal here.' },
        { d: 27, type: 'activity', title: "Dinner: Tommy's Joynt", location: 'San Francisco', time: '20:30', est: 24, maps: "Tommy's Joynt San Francisco" },

        { d: 28, type: 'activity', title: 'Powell-Hyde cable car over Nob Hill', location: 'San Francisco', time: '09:00', cost: 8, maps: 'Powell Hyde Cable Car Turnaround San Francisco' },
        { d: 28, type: 'activity', title: 'The Musee Mecanique at Fisherman\'s Wharf', location: 'San Francisco', time: '10:30', est: 10, maps: 'Musee Mecanique San Francisco', details: 'Three hundred working penny-arcade machines from the 1880s onward, still taking coins: fortune tellers, mechanical carnivals, a laughing woman in a glass box who has frightened four generations of children. Free to walk in, and everything costs a quarter.' },
        { d: 28, type: 'activity', title: 'Lunch: La Taqueria, Mission District', location: 'San Francisco', time: '12:45', est: 15, maps: 'La Taqueria San Francisco' },
        { d: 28, type: 'activity', title: 'The Wave Organ and the Palace of Fine Arts', location: 'San Francisco', time: '15:00', maps: 'Wave Organ San Francisco', details: 'A wave-activated acoustic sculpture on a jetty in the Marina, built out of marble salvaged from a demolished cemetery. You put your ear to the pipes and the bay plays them, quietly and badly, and it is better at high tide.' },
        { d: 28, type: 'activity', title: 'Walk the Golden Gate Bridge', location: 'San Francisco', time: '17:00', maps: 'Golden Gate Bridge San Francisco' },
        { d: 28, type: 'activity', title: 'Dinner: Tadich Grill', location: 'San Francisco', time: '20:00', est: 58, maps: 'Tadich Grill San Francisco', details: 'Running since 1849, which makes it older than the state, and it still does not take bookings.' },

        { d: 29, type: 'activity', title: 'Breakfast: the Ferry Building marketplace', location: 'San Francisco', time: '08:30', est: 19, maps: 'Ferry Building Marketplace San Francisco' },
        { d: 29, type: 'local', title: 'Drive out to SFO and drop the car', location: 'San Francisco', time: '11:30', status: 'booked', cost: 40, maps: 'San Francisco International Airport', details: 'Fill it before the airport: the return-it-empty rate is roughly double the pump. Four thousand two hundred miles, coast to coast, ends here.' },
        { d: 29, type: 'flight', title: 'San Francisco (SFO) to London (LHR)', time: '15:20', note: 'Return half of the open-jaw ticket', details: 'Ten and a half hours over the pole, landing the following morning.' },
      ],
    },
  ];

  // Name -> template. Deliberately forgiving: case, punctuation, accents, years
  // and extra words all wash out, and any keyword can appear anywhere in the
  // name. Matching is WHOLE WORD only, so "Japanese garden tour" is not Japan
  // and "Thai food festival" is not Thailand. When a name names two
  // destinations ("Japan and Thailand 2027") the earliest one in the name wins,
  // and a longer keyword beats a shorter one starting at the same place.
  function normalizeTripName(name) {
    const flat = String(name == null ? '' : name)
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    return ` ${flat} `;
  }

  function matchSampleTrip(name) {
    const hay = normalizeTripName(name);
    if (hay.trim() === '') return '';
    let best = null;
    for (const tpl of SAMPLE_TRIPS) {
      for (const kw of tpl.keywords) {
        const idx = hay.indexOf(` ${kw} `);
        if (idx < 0) continue;
        if (!best || idx < best.idx || (idx === best.idx && kw.length > best.len)) {
          best = { id: tpl.id, idx, len: kw.length };
        }
      }
    }
    return best ? best.id : '';
  }

  const sampleTrip = id => SAMPLE_TRIPS.find(t => t.id === id) || null;

  // `place` is the label without its "(city and city)" tail: the short form the
  // trip-name datalist offers, which is also a name the matcher resolves.
  // Sorted by label for the dropdown/datalist; SAMPLE_TRIPS itself stays in
  // its deliberate short-to-long order (see SAMPLE_SHAPES in the tests).
  const sampleTripOptions = () => SAMPLE_TRIPS.map(t => ({
    id: t.id, label: t.label, place: t.label.replace(/\s*\(.*$/, ''), summary: t.summary,
    startOffset: sampleStartOffset(t),
  })).sort((a, b) => a.label.localeCompare(b.label));

  // A template's own offset, or the shared fallback for one that names none.
  const sampleStartOffset = tpl => (tpl && Number.isInteger(tpl.startOffset) && tpl.startOffset >= 0)
    ? tpl.startOffset : SAMPLE_START_OFFSET;

  function expandSampleItem(spec, tplId, base, index, createdAt, currency) {
    const it = {
      id: `sample-${tplId}-${String(index + 1).padStart(2, '0')}`,
      type: spec.type,
      title: spec.title,
      location: spec.location || '',
      startDate: addDays(base, spec.d),
      endDate: spec.end != null ? addDays(base, spec.end) : '',
      startTime: spec.time || '',
      endTime: spec.endTime || '',
      status: spec.status || 'to-book',
      cost: spec.cost != null ? spec.cost : null,
      costNote: spec.note || '',
      details: spec.details || '',
      createdAt,
    };
    if (spec.cost != null) it.costCurrency = spec.cur || currency;
    if (spec.est != null) { it.estCost = spec.est; it.estCostCurrency = spec.estCur || currency; }
    if (spec.maps) it.mapsQuery = spec.maps;
    return it;
  }

  // Builds one template into a real item list. Every date is relative to
  // `today` (shifted by the template's own startOffset) so a sample never rots
  // into the past, and the ids are deterministic so a regression run can name a
  // row. Returns null for an unknown id.
  function buildSampleTrip(id, opts) {
    const tpl = sampleTrip(id);
    if (!tpl) return null;
    const o = opts || {};
    const today = isIsoDate(o.today) ? o.today : new Date().toISOString().slice(0, 10);
    const currency = /^[A-Z]{3}$/.test(o.currency || '') ? o.currency : 'USD';
    const createdAt = o.createdAt || `${today}T00:00:00.000Z`;
    const base = addDays(today, sampleStartOffset(tpl));
    const specs = [SAMPLE_NOTE, ...tpl.items];
    return {
      id: tpl.id,
      label: tpl.label,
      name: `Example: ${tpl.label}`,
      currency,
      items: specs.map((spec, i) => expandSampleItem(spec, tpl.id, base, i, createdAt, currency)),
    };
  }

  // ---------- what is on right now, and what is next ----------
  // The one input behind the "Up next" summary chip. It compares a wall-clock
  // stamp ("YYYY-MM-DDTHH:MM", read off the DEVICE clock) to every item that
  // carries BOTH a date and a typed clock time.
  //
  // Stays and untimed rows never take part. The day view assumes a check-in and
  // a check-out time (see ASSUMED_CHECKIN_TIME) purely to ORDER rows, and those
  // assumptions are never rendered as times; announcing one on the summary bar
  // as "up next in 40m" would turn a sorting convenience into a claim about the
  // traveller's afternoon.
  //
  // Past this window the chip has nothing useful left to say: "in 3 days" is
  // what the Countdown chip already reads, so repeating it here would only be a
  // second copy of the same number in a different unit.
  const NEXT_UP_WINDOW_MIN = 36 * 60;

  const clockStamp = (date, time) => (isIsoDate(date) && TIME_RE.test(time || '')) ? stampMin(date, time) : null;

  function nextUpEvent(items, nowIso) {
    const raw = String(nowIso || '');
    const now = clockStamp(raw.slice(0, 10), raw.slice(11, 16));
    if (now == null) return null;
    let onNow = null, soonest = null;
    for (const it of (items || [])) {
      if (!it || it.status === 'cancelled' || isStay(it)) continue;
      const dep = clockStamp(it.startDate, it.startTime);
      if (dep == null) continue;
      // Only a leg with an arrival time the traveller actually typed has a span
      // to be INSIDE of. legArrival's fallback to the departure time is right
      // for a connection check and wrong here: it would give every timed row a
      // zero-length span, and "Now" could never fire.
      const arr = TRAVEL_TYPE[it.type]
        ? clockStamp(isIsoDate(it.endDate) ? it.endDate : it.startDate, it.endTime)
        : null;
      if (arr != null && dep <= now && now < arr) {
        // two overlapping legs are already reported as a collision; between
        // them, the one that started most recently is the one you are on
        if (!onNow || dep > onNow.at) onNow = { it, at: dep };
      } else if (dep >= now && (!soonest || dep < soonest.at)) {
        soonest = { it, at: dep };
      }
    }
    if (onNow) return { mode: 'now', id: onNow.it.id, title: onNow.it.title || '', minutes: null, dur: '' };
    if (!soonest) return null;
    const minutes = soonest.at - now;
    if (minutes > NEXT_UP_WINDOW_MIN) return null;
    return { mode: 'next', id: soonest.it.id, title: soonest.it.title || '', minutes, dur: fmtDur(minutes) };
  }

  // ---------- packing checklist ----------
  // What a trip's list is seeded with, ONCE, the first time it is opened. Two
  // of these rows are facts about THIS itinerary rather than generic advice: the
  // boarding-pass row only appears when the trip actually contains a flight, and
  // the warm layer only when a leg sleeps in transit. Nothing here guesses at a
  // destination or a season (adapters, swimwear, thermals), because the app
  // knows the plan, not the weather or the sockets.
  const PACKING_BASICS = [
    'Passport or photo ID',
    'Phone, charger and cable',
    'Medication and toiletries',
    'Cards, cash and a backup card',
    'Travel insurance and booking details',
  ];

  function defaultPackingItems(trip) {
    const items = (trip && Array.isArray(trip.items)) ? trip.items.filter(Boolean) : [];
    const out = [...PACKING_BASICS];
    if (items.some(it => it.type === 'flight' && it.status !== 'cancelled')) {
      out.push('Boarding passes downloaded or mobile wallet ready');
    }
    // isTransitSpan is the same "the plane is that night's bed" test night
    // coverage uses: a flight or transport leg, not cancelled, arriving on a
    // later date than it left.
    if (items.some(isTransitSpan)) out.push('Something warm to sleep in transit');
    return out;
  }

  // ---------- per-traveller packing rows ----------
  // A packing row may say who it is for, exactly the way an item says who a cost
  // is for (see assignedTravelers): the tag is a list of roster names on `who`,
  // and an EMPTY tag means Everyone. The control is only ever offered on a trip
  // that names two or more travellers, so on a solo trip every row reads as
  // Everyone and the list is byte for byte the list it was before this existed.
  //
  // Canonicalised against the roster on every read, so a name the trip no longer
  // carries cannot keep a row hidden from the person actually packing it.
  function packingWho(row, names) {
    const canon = new Map((Array.isArray(names) ? names : []).map(n => [n.toLowerCase(), n]));
    const out = [];
    if (Array.isArray(row && row.who)) {
      for (const raw of row.who) {
        const c = canon.get(String(raw == null ? '' : raw).trim().toLowerCase());
        if (c && !out.includes(c)) out.push(c);
      }
    }
    return out;
  }

  // Which rows a filter shows. No filter is the whole trip's list; a name shows
  // that person's rows AND every Everyone row, because the shared toothpaste is
  // on their list too. A filter naming somebody off the roster falls back to the
  // whole list rather than to an empty one.
  function packingRowsFor(rows, who, names) {
    const list = (Array.isArray(rows) ? rows : []).filter(Boolean);
    const key = String(who == null ? '' : who).trim().toLowerCase();
    if (!key || !(Array.isArray(names) ? names : []).some(n => n.toLowerCase() === key)) return list;
    return list.filter(r => {
      const tag = packingWho(r, names);
      return !tag.length || tag.some(n => n.toLowerCase() === key);
    });
  }

  // "{done} of {total} packed" counts the rows the filter is showing, so asking
  // for one person answers "am I packed", not "is the trip packed".
  function packingProgress(rows, who, names) {
    const list = packingRowsFor(rows, who, names);
    return { done: list.filter(r => r.done === true).length, total: list.length };
  }

  // Taking a name off the roster costs the same on the packing list as it does
  // on "paid by", so the dialog has to say so before it is saved: which names
  // the rows still spell, how many rows the save would DELETE, and how many it
  // would only retag.
  //
  // Both counts are measured by RUNNING the edit on a copy, so neither can
  // drift from what saving does. `untagged` therefore also counts a row that
  // merely loses a tag which has stopped meaning anything (a roster falling to
  // one person leaves nobody to tag a row for). `names` is what the sentence
  // names, and an empty `names` is the dialog saying nothing at all: a
  // respelling carries every row over and is not worth a warning.
  function packingRosterDrops(rows, names) {
    const keep = new Set((Array.isArray(names) ? names : []).map(n => n.toLowerCase()));
    const tagged = (Array.isArray(rows) ? rows : []).filter(r => r && Array.isArray(r.who));
    const dropped = new Map();
    for (const r of tagged) {
      for (const raw of r.who) {
        const who = String(raw == null ? '' : raw).trim();
        if (!who || keep.has(who.toLowerCase())) continue;
        const rec = dropped.get(who.toLowerCase()) || { name: who, count: 0 };
        rec.count++;
        dropped.set(who.toLowerCase(), rec);
      }
    }
    const copy = tagged.map(r => ({ who: r.who.slice() }));
    return { ...applyPackingRoster(copy, names), names: [...dropped.values()] };
  }

  // And then applies it, in place - to the array as well as to the rows, so the
  // caller must hand over the trip's own packing array and not a filtered copy
  // of it. A respelling (case, or a rename that keeps the person) follows the
  // roster; anyone dropped from it takes their tag with them.
  //
  // A row that named ONLY people who are gone GOES with them: it was their row,
  // not the trip's, and keeping it as an Everyone row quietly hands one
  // person's retainer to whoever is left. A row that still names somebody keeps
  // those names, and one left naming everybody (or naming nobody to begin with)
  // falls back to Everyone rather than disappearing off every filter.
  function applyPackingRoster(rows, names) {
    const roster = Array.isArray(names) ? names : [];
    const canon = new Map(roster.map(n => [n.toLowerCase(), n]));
    const list = Array.isArray(rows) ? rows : [];
    let removed = 0;
    let untagged = 0;
    for (let i = list.length - 1; i >= 0; i--) {
      const r = list[i];
      if (!r || !Array.isArray(r.who)) continue;
      const before = r.who.join('\n');
      const named = r.who.some(raw => String(raw == null ? '' : raw).trim());
      const next = [];
      for (const raw of r.who) {
        const c = canon.get(String(raw == null ? '' : raw).trim().toLowerCase());
        if (c && !next.includes(c)) next.push(c);
      }
      // it was somebody's row, and that somebody is off the trip
      if (named && !next.length) { list.splice(i, 1); removed++; continue; }
      if (next.length && next.length < roster.length) r.who = next;
      else delete r.who;
      if ((r.who || []).join('\n') !== before) untagged++;
    }
    return { removed, untagged };
  }

  // ---------- reusable trip templates ----------
  // "Duplicate as template" keeps the SHAPE of a trip - what happens, in what
  // order, how many days apart - and drops every fact that was true of the
  // BOOKING rather than of the plan. Anything left behind is a lie the next time
  // round: last year's price, last year's confirmation code, a deadline that has
  // already passed, and a bill split with whoever came that time.
  //
  // Dates are deliberately NOT cleared here. A template with no dates has no
  // shape left, so the copy keeps the source's dates and the trip dialog offers
  // to move all of them at once (see startDateShift).
  const TEMPLATE_CLEARED = [
    'cost', 'costCurrency', 'costNote', 'estCost', 'estCostCurrency',
    'confirmation', 'bookBy', 'payment', 'paidBy', 'travelers', 'splitAmounts',
  ];

  function templateItem(item) {
    const out = {};
    for (const k of Object.keys(item || {})) {
      if (TEMPLATE_CLEARED.includes(k)) continue;
      out[k] = item[k];
    }
    // every row is a thing to arrange again, so the whole template opens as work
    // to do rather than as a trip that is somehow already booked
    out.status = 'to-book';
    return out;
  }

  // Ids are left exactly as they are: the app hands out fresh ones (which is
  // also what leaves the copy's attached documents behind, since those are
  // stored against the item id), and a pure function that minted them could not
  // be tested twice.
  function tripAsTemplate(trip) {
    const copy = JSON.parse(JSON.stringify(trip));
    copy.items = (Array.isArray(copy.items) ? copy.items : []).filter(Boolean).map(templateItem);
    // The packing LIST is part of the shape and is kept, tags and all. Which
    // boxes were TICKED is a fact about the trip that was taken, not about the
    // plan, so it goes the same way the prices and the codes do: a template
    // opening with the passport already packed is exactly the kind of lie the
    // rule above exists to prevent, and it is the one that could send somebody
    // to the airport without it.
    if (Array.isArray(copy.packing)) {
      for (const row of copy.packing) if (row && typeof row === 'object') row.done = false;
    }
    return copy;
  }

  // ---------- booking-confirmation extraction ----------
  // Reads trip items out of the TEXT of a flight or hotel confirmation. No
  // model and no network: this is the deterministic half of PDF import, and
  // the assistant is only asked about what this cannot settle.
  //
  // Everything here is pure. The browser side (turning a PDF into text, and
  // turning these proposals into reviewable cards) lives in app.js.
  //
  // Output matches the app's own item fields plus provenance:
  //   { item, kind, confidence, evidence: [{field, raw, line}], warnings, signals }
  // Provenance is the point: a wrong read has to be VISIBLE next to the line
  // it came from rather than merely plausible in a form field.

  const MONTHS = {
    jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
    may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
    september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
  };

  const pad = n => String(n).padStart(2, '0');
  const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

  /** Real calendar check, so "31 Feb" is rejected rather than normalised. */
  function validYmd(y, m, d) {
    if (!(y >= 2000 && y <= 2100) || m < 1 || m > 12 || d < 1 || d > 31) return false;
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  }

  /**
   * Parses the date formats airlines and hotels actually print.
   * Returns { iso, raw, ambiguous } or null.
   *
   * `ambiguous` matters more than it looks: "08/12/2027" is August 12th to a US
   * carrier and 12th August to a European one, and there is NO way to tell from
   * the string alone. Guessing silently is the single easiest way for this
   * feature to put a traveller at an airport on the wrong day, so an ambiguous
   * date is flagged and the proposal it feeds is downgraded rather than trusted.
   *
   * THE DEFAULT IS MONTH-FIRST (owner decision): "08/12/2027" reads as
   * 12 August 2027. Pass `{ dayFirst: true }` to read the same string as
   * 8 December. The default only ever decides the AMBIGUOUS cases - a date where
   * one number is above 12 is resolved from the number itself and ignores this
   * setting entirely.
   *
   * `{ orderKnown: true }` says the CALLER has established this document's date
   * order (see inferDateOrder). An otherwise-ambiguous date is then reported as
   * resolved rather than ambiguous, and carries `resolvedByDocument` so the
   * caller can still say out loud how it was settled.
   */
  function parseDate(s, opts = {}) {
    const text = String(s || '').trim();

    let m = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(text);
    if (m) {
      const [y, mo, d] = [+m[1], +m[2], +m[3]];
      return validYmd(y, mo, d) ? { iso: iso(y, mo, d), raw: m[0], ambiguous: false } : null;
    }

    // 12 Aug 2027 / 12 August 2027 / 12-Aug-2027
    m = /\b(\d{1,2})[\s\-]+([A-Za-z]{3,9})\.?[\s\-,]+(\d{4})\b/.exec(text);
    if (m && MONTHS[m[2].toLowerCase()]) {
      const [d, mo, y] = [+m[1], MONTHS[m[2].toLowerCase()], +m[3]];
      return validYmd(y, mo, d) ? { iso: iso(y, mo, d), raw: m[0], ambiguous: false } : null;
    }

    // Aug 12, 2027 / August 12 2027
    m = /\b([A-Za-z]{3,9})\.?[\s\-]+(\d{1,2})(?:st|nd|rd|th)?[\s,]+(\d{4})\b/.exec(text);
    if (m && MONTHS[m[1].toLowerCase()]) {
      const [mo, d, y] = [MONTHS[m[1].toLowerCase()], +m[2], +m[3]];
      return validYmd(y, mo, d) ? { iso: iso(y, mo, d), raw: m[0], ambiguous: false } : null;
    }

    // All-numeric. Month-first by default (see the note above); unambiguous only
    // when one of the two numbers cannot be a month, in which case the numbers
    // decide and the default is not consulted.
    m = /\b(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})\b/.exec(text);
    if (m) {
      const a = +m[1], b = +m[2], y = +m[3];
      const dayFirst = opts.dayFirst === true;
      let d = dayFirst ? a : b;
      let mo = dayFirst ? b : a;
      let ambiguous = a <= 12 && b <= 12 && a !== b;
      if (a > 12 && b <= 12) { d = a; mo = b; ambiguous = false; }
      else if (b > 12 && a <= 12) { d = b; mo = a; ambiguous = false; }
      if (!validYmd(y, mo, d)) return null;
      const out = { iso: iso(y, mo, d), raw: m[0], ambiguous };
      // When the string alone is ambiguous both numbers are 1-12, so the other
      // reading is always a real date too. Carrying it lets the caller name both
      // instead of vaguely saying "or the other way round".
      if (ambiguous) {
        out.altIso = iso(y, d, mo);
        // The document has already settled which order it uses, so this one is
        // no longer a guess. It still says so, because "resolved from elsewhere
        // in the document" is a different claim from "unambiguous on its face".
        if (opts.orderKnown === true) {
          out.ambiguous = false;
          out.resolvedByDocument = true;
        }
      }
      return out;
    }
    return null;
  }

  const NUMERIC_DATE = /\b(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})\b/g;

  /**
   * Works out which order THIS DOCUMENT writes its all-numeric dates in, so the
   * ambiguous ones can be read the same way as the decisive ones.
   *
   * A confirmation is written by one system in one locale, so its dates are all
   * the same shape. If any of them carries a number above 12 it can only be read
   * one way, and that settles the rest: a page holding both "25/12/2027" and
   * "08/12/2027" is day-first throughout, so the second is 8 December and not a
   * coin toss. This is what makes a global default mostly unnecessary - it is
   * only consulted when the document itself offers no evidence at all.
   *
   * Returns { dayFirst, source: 'document'|'default'|'conflict', evidence, conflict }.
   *
   * Conflicting evidence (one date that can only be day-first AND another that
   * can only be month-first) is NOT averaged or won by majority. Such a document
   * is not trustworthy on dates at all, so it falls back to the default and says
   * so, and every date it produced stays flagged.
   */
  function inferDateOrder(lines, opts = {}) {
    const fallback = opts.dayFirst === true;
    const votes = [];
    (lines || []).forEach((ln, i) => {
      for (const m of String(ln).matchAll(NUMERIC_DATE)) {
        const a = +m[1], b = +m[2], y = +m[3];
        // A vote only counts if the reading it forces is a real calendar date;
        // "31/02/2027" forces day-first on its face but is not a date at all.
        if (a > 12 && b <= 12 && validYmd(y, b, a)) votes.push({ dayFirst: true, raw: m[0], line: i });
        else if (b > 12 && a <= 12 && validYmd(y, a, b)) votes.push({ dayFirst: false, raw: m[0], line: i });
      }
    });

    if (!votes.length) return { dayFirst: fallback, source: 'default', evidence: [], conflict: false };
    const dmy = votes.filter(v => v.dayFirst);
    const mdy = votes.filter(v => !v.dayFirst);
    if (dmy.length && mdy.length) {
      return { dayFirst: fallback, source: 'conflict', evidence: [dmy[0], mdy[0]], conflict: true };
    }
    return { dayFirst: dmy.length > 0, source: 'document', evidence: votes.slice(0, 2), conflict: false };
  }

  // A dotted DATE is never a time. "Departs 12.08.2027 at 21:30" read 12.08 as
  // 12:08, and because 12:08 is earlier than the 21:30 that followed it, the
  // wrapped-clock rule in readFlight then landed a same-day flight the next
  // morning. Struck out before anything else looks at the line.
  const DOTTED_DATE = /\b\d{1,2}\.\d{1,2}\.\d{2,4}\b/g;
  // "21.30" is a real European clock and "GBP 12.40" is a real price, and the
  // two are the same string. The dot form is therefore only read next to
  // something that says it is a clock ("at 21.30", "kl. 21.30", "21.30 Uhr");
  // a bare dotted number is dropped. A lost optional time costs one blank
  // field, whereas a price read as an arrival clock invented a whole night.
  const DOT_TIME_BEFORE = /\b(?:at|kl|um|ab)\.?\s*([01]?\d|2[0-3])\.([0-5]\d)\b/i;
  const DOT_TIME_AFTER = /\b([01]?\d|2[0-3])\.([0-5]\d)\s*(?:h|hrs|hours|uhr)\b/i;

  /** "21:30", "9:30 PM", "at 09.30" -> "21:30". Returns null when there is no time. */
  function parseTime(s) {
    const text = String(s || '').replace(DOTTED_DATE, ' ');
    let m = /\b(\d{1,2})[:.](\d{2})\s*([AaPp])\.?[Mm]\.?\b/.exec(text);
    if (m) {
      let h = +m[1] % 12;
      if (m[3].toLowerCase() === 'p') h += 12;
      return +m[2] < 60 ? `${pad(h)}:${m[2]}` : null;
    }
    m = /\b([01]?\d|2[0-3]):([0-5]\d)\b/.exec(text);
    if (m) return `${pad(+m[1])}:${m[2]}`;
    // Money is not a clock. Only the dot form is refused here: a genuine
    // "21:30" printed on a line that also carries a total is still a time.
    if (parseDocMoney(text) && /\b(total|fare|price|amount|paid|cost|charge)\b/i.test(text)) return null;
    m = DOT_TIME_BEFORE.exec(text) || DOT_TIME_AFTER.exec(text);
    return m ? `${pad(+m[1])}:${m[2]}` : null;
  }

  // A booking reference is only accepted next to a label. An unlabelled
  // six-character token is far more often a fare class, an aircraft type or a
  // terminal than a PNR, and a wrong code printed confidently is worse at a
  // check-in desk than a blank field.
  // "Confirmation" and "Reservation" on their own are a HEADING as often as a
  // field, so they need a qualifier or a colon after them: a hotel voucher
  // printing "Reservation" above "GRAND HOTEL ASTORIA" handed back "GRAND" as
  // the booking code. The unambiguous labels below need no such help.
  const PNR_LABEL = /(booking\s*(reference|ref|code|id|number)|(confirmation|reservation)\s*(number|code|no\.?|#|reference|:)|record\s*locator|\bPNR\b|airline\s*reference)/i;
  // At least one LETTER, and the requirement has to fall on the token itself:
  // a trailing `(?=.*[A-Z])` ranged over the rest of the line, so "Booking
  // reference: 12345678 KEEP THIS SAFE" passed on the strength of "KEEP" and
  // a date stamp like 20270812 read as a PNR.
  const PNR_TOKEN = /\b(?=[A-Z0-9]{5,8}\b)(?=[A-Z0-9]{0,7}[A-Z])[A-Z0-9]{5,8}\b/g;
  const PNR_NOT_A_CODE = /^(FLIGHT|TICKET|BOOKING|NUMBER|AIRLINE|HOTEL)$/;

  function findConfirmation(lines) {
    for (let i = 0; i < lines.length; i++) {
      if (!PNR_LABEL.test(lines[i])) continue;
      // the code usually sits on the label's line, occasionally on the next one
      for (const j of [i, i + 1]) {
        if (j >= lines.length) continue;
        const after = j === i ? lines[j].replace(PNR_LABEL, ' ') : lines[j];
        // EVERY token on the line, not just the first: "Confirmation number:
        // AIRLINE XYZ123" rejected the whole line on "AIRLINE" and returned
        // nothing at all. All-digit tokens cannot reach here (see PNR_TOKEN).
        for (const m of after.matchAll(PNR_TOKEN)) {
          if (PNR_NOT_A_CODE.test(m[0])) continue;
          return { code: m[0], line: j, raw: lines[j].trim() };
        }
      }
    }
    return null;
  }

  const CUR_SYMBOL = { '£': 'GBP', '$': 'USD', '€': 'EUR', '¥': 'JPY' };

  // Any run of digits with grouping marks inside it; the ends must be digits so
  // a trailing full stop or comma is not swallowed.
  const MONEY_NUM = '(\\d[\\d.,]*\\d|\\d)';
  const MONEY_SYMBOL_FIRST = new RegExp('([£$€¥])\\s?' + MONEY_NUM);
  const MONEY_CODE_FIRST = new RegExp('\\b([A-Z]{3})\\s?' + MONEY_NUM);
  const MONEY_CODE_LAST = new RegExp('\\b' + MONEY_NUM + '\\s?([A-Z]{3})\\b');

  /**
   * "1.234,56" is what most of Europe prints and it is the SAME amount as
   * "1,234.56". Reading the comma as a thousands mark turned "Total EUR 148,00"
   * into 14800 and "1.234,56 EUR" into 23456, which is the kind of wrong that
   * survives a glance at a budget screen.
   *
   * A comma followed by exactly two digits at the end of the number is a
   * decimal point, and dots in front of it are then thousands marks. Anything
   * else keeps the dot-decimal reading, so a bare "1,234" stays 1234: it could
   * be either, and that is the reading this app has always used.
   */
  function moneyValue(raw) {
    const s = String(raw);
    if (/^\d{1,3}(\.\d{3})+,\d{1,2}$/.test(s) || /^\d+,\d{2}$/.test(s)) {
      return +s.replace(/\./g, '').replace(',', '.');
    }
    return +s.replace(/,/g, '');
  }

  /** "£1,234.56", "EUR 220.00", "220.00 USD", "EUR 148,00" -> { value, currency }. */
  function parseDocMoney(s) {
    const text = String(s || '');
    let m = MONEY_SYMBOL_FIRST.exec(text);
    if (m) return { value: moneyValue(m[2]), currency: CUR_SYMBOL[m[1]] };
    m = MONEY_CODE_FIRST.exec(text);
    if (m) return { value: moneyValue(m[2]), currency: m[1] };
    m = MONEY_CODE_LAST.exec(text);
    if (m) return { value: moneyValue(m[1]), currency: m[2] };
    return null;
  }

  // Flight designator: 2-character airline code (which may contain a digit, as
  // in U2 or 3K) followed by 1-4 digits.
  const FLIGHT_NO = /\b([A-Z]{2}|[A-Z]\d|\d[A-Z])\s?(\d{1,4})\b(?!\d)/;

  /**
   * Three-letter tokens that are also ordinary words or currencies. Every one of
   * these IS a real IATA code, so the airport table alone cannot reject them:
   * ALL is Albenga, ARE is Arecibo, CAR is Caruaru, ONE is Onepusu, VAT is
   * Vatomandry. Accepting them turns any sentence into a route.
   */
  const CODE_STOPWORDS = new Set([
    'ALL', 'AND', 'ANY', 'ARE', 'BUS', 'CAR', 'FOR', 'GBP', 'EUR', 'USD', 'JPY',
    'NEW', 'NOT', 'ONE', 'OUT', 'PDF', 'PER', 'PNR', 'TAX', 'THE', 'TWO', 'VAT',
    'YOU', 'MAY', 'DAY', 'AGE', 'FEE', 'NET', 'SUM', 'TOP', 'END', 'ETA', 'ETD',
    // Day and month abbreviations, which an all-caps ticket prints exactly the
    // way it prints an airport code. "OPEN SAT - SUN 10:00" read as San Antonio
    // to Hailey, and "DEPARTS SAT ... / ARRIVES SUN ... JFK" beat the real
    // airports to the route. Checked against data/airports.json: THU, SAT, SUN,
    // JAN, MAR, JUL, AUG, NOV and DEC ARE codes (Pituffik, San Antonio, Hailey,
    // Jackson, Maracaibo, Juliaca, Augusta, Huambo, Decatur); the rest are not
    // in the table today and are listed so the set reads as one idea.
    'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN',
    'JAN', 'FEB', 'MAR', 'APR', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC',
  ]);

  /**
   * A code written in PARENTHESES is written as a code. "Houston (IAH) to San
   * Antonio (SAT)" cannot be a weekday, so the stopword list is not applied to
   * it and a traveller genuinely flying to San Antonio still gets the route.
   *
   * The BARE form is refused in both passes, and that is the deliberate trade:
   * "IAH to SAT" now finds no route rather than a possibly-wrong one, because
   * relaxing the bare form for an explicit separator brings back the failures
   * above (a shouty ticket writes "DEPARTS SAT 21:30 ... to JFK" just as
   * readily as a real one writes "IAH to SAT"). No proposal beats a
   * confidently wrong one, which is the trade the rest of this module makes.
   */
  const inParens = (line, at) => line[at - 1] === '(' && line[at + 3] === ')';

  /**
   * A separator sitting between two airport codes: "to", an arrow, a slash or a
   * dash. Anchored on non-letters so a hyphen inside a word is not a separator.
   */
  const ROUTE_SEP = /(?:^|[^A-Za-z])(?:-->|->|→|>|—|–|-|\/|to)(?:[^A-Za-z]|$)/i;

  // How much text may sit between the two codes and still read as one route.
  // "(LHR) to New York JFK" is 14 characters of gap; a whole paragraph is not a
  // route, it is two codes that happen to share a line.
  const ROUTE_GAP_MAX = 40;

  function codeIsAirport(code, byIata, parenthesised) {
    return byIata.has(code) && (parenthesised === true || !CODE_STOPWORDS.has(code));
  }

  /**
   * Finds the origin/destination pair. An EXPLICIT route pattern is trusted;
   * otherwise bare codes are collected in reading order and only used when
   * exactly two survive, because "two codes somewhere on the page" is a much
   * weaker claim than "A to B written as a route".
   */
  function findRoute(lines, byIata) {
    // Pass 1: an explicit route on a single line. Matching is done on the
    // POSITIONS of valid codes rather than on one regex, because the real
    // layouts put text between them: "London Heathrow (LHR) to New York JFK
    // (JFK)" and "London LHR to New York JFK" both defeated an adjacency
    // pattern, and between them they cover most airline confirmations.
    for (let i = 0; i < lines.length; i++) {
      const codes = [...lines[i].matchAll(/\b([A-Z]{3})\b/g)]
        .filter(m => codeIsAirport(m[1], byIata, inParens(lines[i], m.index)));
      for (let k = 0; k + 1 < codes.length; k++) {
        const a = codes[k], b = codes[k + 1];
        if (a[1] === b[1]) continue;
        const gap = lines[i].slice(a.index + a[0].length, b.index);
        if (gap.length <= ROUTE_GAP_MAX && ROUTE_SEP.test(gap)) {
          return { from: a[1], to: b[1], line: i, raw: lines[i].trim(), explicit: true };
        }
      }
    }
    const hits = [];
    for (let i = 0; i < lines.length; i++) {
      for (const m of lines[i].matchAll(/\b([A-Z]{3})\b/g)) {
        if (codeIsAirport(m[1], byIata, inParens(lines[i], m.index)) && !hits.some(h => h.code === m[1])) {
          hits.push({ code: m[1], line: i });
        }
      }
    }
    if (hits.length === 2) {
      return { from: hits[0].code, to: hits[1].code, line: hits[0].line, raw: lines[hits[0].line].trim(), explicit: false };
    }
    return null;
  }

  /**
   * What to say about how a date's order was decided. Three cases, and each one
   * is a different claim, so each gets its own wording:
   *   - the document settled it  -> say which line settled it, informational
   *   - the document contradicts itself -> warn, and it is still a guess
   *   - no evidence either way   -> warn, name both readings
   */
  function dateOrderNotes(d, ctx) {
    if (!d) return [];
    const order = ctx.order || {};
    if (d.resolvedByDocument) {
      if (order.source === 'plausibility') {
        const other = order.rejected && order.rejected.dayFirst ? 'day-first' : 'month-first';
        return [`"${d.raw}" could be read either way on its own; taken as ${d.iso} because reading this document ${other} produces an itinerary that could not happen. That is a judgement about what is likely, not something the page states - check it.`];
      }
      const src = (order.evidence || [])[0];
      const how = src
        ? `"${src.raw}" on line ${src.line + 1} can only be read that way`
        : 'another date in this document can only be read that way';
      return [`"${d.raw}" could be read either way on its own; taken as ${d.iso} because ${how}.`];
    }
    if (!d.ambiguous) return [];
    const conflict = order.conflict
      ? ' This document also contains dates in BOTH orders, so it cannot be trusted on dates at all.'
      : '';
    return [`"${d.raw}" is an all-numeric date with no way to tell the order from the string. Read as ${d.iso}; it could equally be ${d.altIso}.${conflict} Confirm before saving.`];
  }


  /**
   * Reads a flight confirmation. Returns a proposal or null.
   *
   * Times: the FIRST time on or after the route line is treated as departure and
   * the second as arrival, which is the layout every confirmation uses. An
   * arrival earlier than the departure means the leg lands the next day, and
   * that is set explicitly rather than left for the app to guess, because an
   * overnight flight with no end date silently loses a night of coverage.
   */
  function readFlight(lines, byIata, ctx) {
    const route = findRoute(lines, byIata);
    if (!route) return null;

    const warnings = [];
    const evidence = [];
    const from = byIata.get(route.from);
    const to = byIata.get(route.to);
    evidence.push({ field: 'route', raw: route.raw, line: route.line });
    if (!route.explicit) {
      warnings.push(`Route was inferred from two airport codes on the page ("${route.from}", "${route.to}"), not from an explicit "A to B" line. Check the direction.`);
    }

    // WHICH date is the departure. Taking the first date on the page is wrong
    // on any confirmation that prints an issue or "booked on" date above the
    // itinerary, and plenty do. So the line a date sits on decides, in order:
    //   1. a line labelled as a departure ("Departs", "Outbound", "Travel date")
    //   2. the route line itself, which often carries the date too
    //   3. the nearest remaining date to the route line, preferring one below it
    //   4. anything left, which is reported as a guess
    // Lines labelled as an issue, invoice or payment date are struck out first
    // and can never win, whatever their position.
    const dated = [];
    lines.forEach((ln, i) => {
      const d = parseDate(ln, ctx);
      if (d) dated.push({ ...d, line: i, ln });
    });
    const travel = dated.filter(d => !NOT_TRAVEL.test(d.ln));
    const skipped = dated.filter(d => NOT_TRAVEL.test(d.ln));

    let dep = travel.find(d => DEP_LABEL.test(d.ln))
      || travel.find(d => d.line === route.line)
      || travel.slice().sort((a, b) => {
        // nearest to the route line; a date BELOW the route beats one the same
        // distance above it, because itineraries read downwards
        const da = (a.line >= route.line ? 0 : 0.5) + Math.abs(a.line - route.line);
        const db = (b.line >= route.line ? 0 : 0.5) + Math.abs(b.line - route.line);
        return da - db;
      })[0]
      || null;
    let depGuessed = false;
    if (!dep && dated.length) { dep = dated[0]; depGuessed = true; }

    if (dep) {
      // full line, not just the matched substring: provenance is only useful
      // if the traveller can see the context the value came out of
      evidence.push({ field: 'startDate', raw: lines[dep.line].trim(), line: dep.line });
      warnings.push(...dateOrderNotes(dep, ctx));
      if (depGuessed || !DEP_LABEL.test(dep.ln)) {
        warnings.push(`No line is labelled as the departure, so "${lines[dep.line].trim().slice(0, 60)}" was used for the date. Check it is not an issue or booking date.`);
      }
      if (skipped.length) {
        warnings.push(`Ignored ${skipped.length} date${skipped.length > 1 ? 's' : ''} on issue/booking/invoice lines (e.g. "${skipped[0].ln.trim().slice(0, 48)}").`);
      }
    } else {
      warnings.push('No departure date could be read.');
    }

    const times = [];
    lines.forEach((ln, i) => {
      if (i < route.line) return;
      const t = parseTime(ln);
      if (t) times.push({ t, line: i, raw: ln.trim() });
    });
    const depTime = times[0] || null;
    const arrTime = times[1] || null;
    if (depTime) evidence.push({ field: 'startTime', raw: depTime.raw, line: depTime.line });
    if (arrTime) evidence.push({ field: 'endTime', raw: arrTime.raw, line: arrTime.line });

    // Landing date. A date printed on an ARRIVAL line is authoritative and beats
    // inferring one; the "+1" inference is only for confirmations that print no
    // arrival date at all.
    let endDate = '';
    let contradicted = false;
    const arr = dep ? travel.find(d => d !== dep && ARR_LABEL.test(d.ln)) : null;
    if (arr && arr.iso > dep.iso) {
      endDate = arr.iso;
      evidence.push({ field: 'endDate', raw: lines[arr.line].trim(), line: arr.line });
      const days = Math.round((Date.parse(arr.iso) - Date.parse(dep.iso)) / 86400000);
      warnings.push(`Overnight leg: lands ${endDate}, read from "${lines[arr.line].trim().slice(0, 50)}".`);
      if (days > 2) {
        warnings.push(`That is ${days} days after departure, which is not a plausible flight. If these dates are all-numeric, the day/month order is probably being read the wrong way round.`);
      }
    } else {
      if (arr && arr.iso < dep.iso) {
        // Independent evidence disagrees with itself. The clock is still worth
        // believing (it is a separate reading from the date), so the +1 below
        // still runs, but the document is no longer trustworthy and the
        // proposal says so by dropping a confidence step.
        contradicted = true;
        warnings.push(`An arrival line reads ${arr.iso}, which is BEFORE the departure date ${dep.iso}. It was ignored, but one of the two dates is being read wrongly - most likely the day/month order.`);
      }
      // Overnight: an explicit "+1" marker, or an arrival clock earlier than the
      // departure clock. A "+1" only counts when nothing numeric follows it: a
      // customer-service footer reading "+1 800 221 1212" marked every American
      // ticket as landing the next day, while the airline's own "(+1)" notation
      // has nothing after it. The scan starts at the route line for the same
      // reason - the marker belongs to the itinerary, not to the letterhead.
      const plusOne = lines.some((ln, i) => i >= route.line && /\+\s?1(?![-.\s()]*\d)|\bnext day\b/i.test(ln));
      const wrapped = !!(depTime && arrTime && arrTime.t < depTime.t);
      if (dep && (plusOne || wrapped)) {
        const d = new Date(Date.UTC(+dep.iso.slice(0, 4), +dep.iso.slice(5, 7) - 1, +dep.iso.slice(8, 10) + 1));
        endDate = iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
        warnings.push(`Read as an overnight leg landing ${endDate} (${plusOne ? 'a "+1" marker was printed' : 'the arrival time is earlier than the departure time'}); no arrival date was printed.`);
      }
    }

    const flightNo = (() => {
      for (let i = 0; i < lines.length; i++) {
        // "Departure Gate B12" is shaped exactly like a designator, so the LINE
        // has to rule it out; the pattern never can.
        if (/\b(gate|terminal|seat|door)\b/i.test(lines[i])) continue;
        const m = FLIGHT_NO.exec(lines[i]);
        if (m && !codeIsAirport(m[1] + m[2].slice(0, 1), byIata)) return { code: `${m[1]}${m[2]}`, line: i, raw: lines[i].trim() };
      }
      return null;
    })();
    if (flightNo) evidence.push({ field: 'details', raw: flightNo.raw, line: flightNo.line });

    const pnr = findConfirmation(lines);
    if (pnr) evidence.push({ field: 'confirmation', raw: pnr.raw, line: pnr.line });

    const moneyLine = lines.findIndex(ln => /total|fare|price|amount|paid/i.test(ln) && parseDocMoney(ln));
    const money = moneyLine >= 0 ? parseDocMoney(lines[moneyLine]) : null;
    if (money) evidence.push({ field: 'cost', raw: lines[moneyLine].trim(), line: moneyLine });

    const item = {
      type: 'flight',
      title: `${(from ? airportLabel(from) : route.from)} to ${(to ? airportLabel(to) : route.to)}`,
      location: '',
      startDate: dep ? dep.iso : '',
      endDate,
      startTime: depTime ? depTime.t : '',
      endTime: arrTime ? arrTime.t : '',
      status: 'booked',
    };
    if (money) { item.cost = money.value; item.costCurrency = money.currency; }
    if (pnr) item.confirmation = pnr.code;
    if (flightNo) item.details = `Flight ${flightNo.code}`;

    let confidence = 'high';
    if (!dep || !route.explicit) confidence = 'low';
    else if (!depTime || dep.ambiguous || depGuessed || contradicted) confidence = 'medium';
    // A date order settled by plausibility rather than by a decisive number is
    // strong evidence but still an inference, so it caps the claim.
    else if (dep.resolvedByDocument && (ctx.order || {}).source === 'plausibility') confidence = 'medium';

    // How many days the document CLAIMS this leg takes, before any refusal.
    // Scored by the plausibility tiebreak: a flight is a day, not a month, so a
    // reading that produces a 31-day leg is evidence about the date order.
    const spanDays = (dep && arr) ? Math.round((Date.parse(arr.iso) - Date.parse(dep.iso)) / 86400000)
      : (dep && endDate ? Math.round((Date.parse(endDate) - Date.parse(dep.iso)) / 86400000) : null);

    return { kind: 'flight', item, confidence, evidence, warnings, signals: { spanDays } };
  }

  // Which line a date sits on decides what it means.
  const DEP_LABEL = /\b(depart\w*|outbound|leaves?|leaving|flight date|travel date|date of travel)\b/i;
  const ARR_LABEL = /\b(arriv\w*|inbound|lands?|landing)\b/i;
  // These can never be the travel date, wherever they appear on the page.
  const NOT_TRAVEL = /\b(issued?|issue date|booked on|booking date|invoice|printed|purchased?|payment date|valid (until|through)|expir\w*)\b/i;

  const CHECKIN = /check[\s\-]?in/i;
  const CHECKOUT = /check[\s\-]?out|departure date/i;

  /**
   * Reads a hotel confirmation. Weaker than the flight reader by nature: a
   * property name is free text with no code to anchor it, so the name is a
   * heuristic and always lands as medium confidence at best.
   */
  function readStay(lines, ctx) {
    const inLine = lines.findIndex(l => CHECKIN.test(l) && parseDate(l, ctx));
    const outLine = lines.findIndex(l => CHECKOUT.test(l) && parseDate(l, ctx));
    if (inLine < 0 || outLine < 0) return null;

    const warnings = [];
    const evidence = [];
    const start = parseDate(lines[inLine], ctx);
    const end = parseDate(lines[outLine], ctx);
    evidence.push({ field: 'startDate', raw: lines[inLine].trim(), line: inLine });
    evidence.push({ field: 'endDate', raw: lines[outLine].trim(), line: outLine });
    for (const d of [start, end]) warnings.push(...dateOrderNotes(d, ctx));
    if (end.iso <= start.iso) warnings.push('Check-out is not after check-in; the dates may have been read in the wrong order.');

    // Property name: the first line that looks like a name rather than a label.
    // Deliberately crude, and reported as such.
    const nameLine = lines.findIndex((l, i) => i < inLine && l.trim().length > 3
      && !/reservation|confirmation|booking|guest|address|total|nights?|room|invoice|tax|www\.|@/i.test(l)
      && !parseDate(l, ctx) && !/^\d/.test(l.trim()));
    const name = nameLine >= 0 ? lines[nameLine].trim().slice(0, 80) : '';
    if (name) evidence.push({ field: 'title', raw: lines[nameLine].trim(), line: nameLine });
    else warnings.push('No property name could be identified; fill the title in by hand.');

    const cityLine = lines.findIndex(l => /^(city|location|address)\b/i.test(l));
    const city = cityLine >= 0 ? lines[cityLine].replace(/^[a-z]+\s*:?\s*/i, '').trim().slice(0, 80) : '';
    if (city) evidence.push({ field: 'location', raw: lines[cityLine].trim(), line: cityLine });

    const pnr = findConfirmation(lines);
    if (pnr) evidence.push({ field: 'confirmation', raw: pnr.raw, line: pnr.line });

    const moneyLine = lines.findIndex(l => /total|amount|price|rate/i.test(l) && parseDocMoney(l));
    const money = moneyLine >= 0 ? parseDocMoney(lines[moneyLine]) : null;
    if (money) evidence.push({ field: 'cost', raw: lines[moneyLine].trim(), line: moneyLine });

    const item = {
      type: 'stay',
      title: name || 'Hotel booking',
      location: city,
      startDate: start.iso,
      endDate: end.iso,
      startTime: '',
      endTime: '',
      status: 'booked',
    };
    if (money) { item.cost = money.value; item.costCurrency = money.currency; }
    if (pnr) item.confirmation = pnr.code;

    return {
      kind: 'stay',
      item,
      confidence: name && !start.ambiguous && !end.ambiguous ? 'medium' : 'low',
      evidence,
      warnings,
      signals: { nights: Math.round((Date.parse(end.iso) - Date.parse(start.iso)) / 86400000) },
    };
  }

  // ---------- multi-leg itineraries (Depart / Arrive blocks) ----------
  // Airline sites and e-tickets print connections as repeated blocks:
  //
  //   Depart              Arrive
  //   Tue, Dec 29         Tue, Dec 29
  //   6:00 AM             8:50 AM
  //   Shreveport (SHV)    Atlanta, GA (ATL)
  //
  // readFlight above reads ONE route per document, which on a six-leg
  // itinerary silently dropped five flights (and worse: the one it kept came
  // from an upgrade-offer banner, not from the itinerary). These blocks are
  // stronger evidence than anything readFlight infers, so when they exist
  // they take over entirely.

  const MONTH_NAME_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';

  // "Tue, Dec 29" / "WED, DEC 30" / "29 Dec": a date printed WITHOUT a year,
  // which is how itinerary pages label each leg. The lookahead keeps these
  // from double-reading full dates like "December 29, 2026".
  const YEARLESS_MD = new RegExp('\\b' + MONTH_NAME_RE + '\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?!\\s*,?\\s*\\d{4})', 'i');
  const YEARLESS_DM = new RegExp('\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+' + MONTH_NAME_RE + '\\b(?!\\s*,?\\s*\\d{4})', 'i');

  function parseDayMonthNoYear(s) {
    const text = String(s || '');
    let m = YEARLESS_MD.exec(text);
    if (m && MONTHS[m[1].toLowerCase()]) return { m: MONTHS[m[1].toLowerCase()], d: +m[2], raw: m[0] };
    m = YEARLESS_DM.exec(text);
    if (m && MONTHS[m[2].toLowerCase()]) return { m: MONTHS[m[2].toLowerCase()], d: +m[1], raw: m[0] };
    return null;
  }

  /**
   * Every fully-dated line in the document (month spelled out, year printed),
   * for anchoring the year of the year-less leg dates. Issue/expiry lines are
   * excluded: "Ticket Expiration: July 16, 2027" is not part of the journey
   * and would stretch the plausible-range test below for no reason.
   */
  function collectDateAnchors(lines) {
    const anchors = [];
    const mdY = new RegExp('\\b' + MONTH_NAME_RE + '\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b', 'gi');
    const dMy = new RegExp('\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+' + MONTH_NAME_RE + '\\.?,?\\s+(\\d{4})\\b', 'gi');
    (lines || []).forEach((ln, i) => {
      if (NOT_TRAVEL.test(ln)) return;
      for (const m of String(ln).matchAll(mdY)) {
        const mo = MONTHS[m[1].toLowerCase()], d = +m[2], y = +m[3];
        if (mo && validYmd(y, mo, d)) anchors.push({ y, m: mo, d, iso: iso(y, mo, d), raw: m[0], line: i });
      }
      for (const m of String(ln).matchAll(dMy)) {
        const d = +m[1], mo = MONTHS[m[2].toLowerCase()], y = +m[3];
        if (mo && validYmd(y, mo, d)) anchors.push({ y, m: mo, d, iso: iso(y, mo, d), raw: m[0], line: i });
      }
    });
    return anchors;
  }

  /**
   * Decides which year a year-less "Dec 29" belongs to.
   *
   * Two rules, in order of strength. EXACT: a full date elsewhere in the
   * document names the same month and day ("Tue, December 29, 2026" in the
   * header settles every "Tue, Dec 29" leg label). RANGE: only one candidate
   * year places the date inside the document's own dated span, padded a few
   * days for legs that land just past the printed end. A date that neither
   * rule can settle stays unresolved rather than guessed: a flight silently
   * filed under the wrong year is exactly the failure this feature must not
   * produce.
   */
  const YEAR_RANGE_PAD_DAYS = 3;
  function resolveYear(mo, d, anchors) {
    if (!anchors.length) return null;
    const exactYears = [...new Set(anchors.filter(a => a.m === mo && a.d === d).map(a => a.y))];
    if (exactYears.length === 1 && validYmd(exactYears[0], mo, d)) {
      return { iso: iso(exactYears[0], mo, d), how: 'exact' };
    }
    const isos = anchors.map(a => a.iso).sort();
    const pad = YEAR_RANGE_PAD_DAYS * 86400000;
    const min = Date.parse(isos[0]) - pad;
    const max = Date.parse(isos[isos.length - 1]) + pad;
    const years = [...new Set(anchors.map(a => a.y))];
    const fits = years.filter(y => {
      if (!validYmd(y, mo, d)) return false;
      const t = Date.parse(iso(y, mo, d));
      return t >= min && t <= max;
    });
    if (fits.length === 1) return { iso: iso(fits[0], mo, d), how: 'range' };
    return null;
  }

  const LEG_DEP = /\bdepart\w*\b/i;
  const LEG_ARR = /\barriv\w*\b/i;
  // Aircraft-name lines defeat the flight-number regex ("Airbus A330-300"
  // reads as flight A3 330), so they are skipped wholesale.
  const AIRCRAFT_LINE = /\b(airbus|boeing|embraer|bombardier|canadair|dreamliner|winglets|md-\d)\b/i;
  // Like FLIGHT_NO but tolerant of text glued straight onto the digits, which
  // is how copied web pages print "DL7937Operated byKorean Air".
  const LEG_FLIGHT_NO = /\b([A-Z]{2}|[A-Z]\d|\d[A-Z])\s?(\d{2,4})(?!\d)/;
  // A seat only counts on a line of its own: "13B" inside prose is a postcode
  // fragment or a paragraph label as often as it is a seat.
  const SEAT_LINE = /^\s*(\d{1,3}[A-HJ-NP-Z])\s*$/;

  /**
   * Reads one endpoint (the departure or arrival half of a leg) from the
   * lines between `start` and `end`: the first airport code, the first date
   * (full or year-less) and the first clock time found there.
   */
  function readLegEndpoint(lines, start, end, byIata, anchors, ctx) {
    const out = { code: null, codeLine: -1, date: null, time: null, timeLine: -1, pending: null };
    for (let i = start; i < end && i < lines.length; i++) {
      const ln = lines[i];
      if (!out.code) {
        const paren = /\(([A-Z]{3})\)/.exec(ln);
        if (paren && codeIsAirport(paren[1], byIata, true)) { out.code = paren[1]; out.codeLine = i; }
        else {
          const bare = /^\s*([A-Z]{3})\s*$/.exec(ln);
          if (bare && codeIsAirport(bare[1], byIata)) { out.code = bare[1]; out.codeLine = i; }
        }
      }
      if (!out.date && !out.pending && !NOT_TRAVEL.test(ln)) {
        const full = parseDate(ln, ctx);
        if (full) out.date = { iso: full.iso, how: 'full', raw: full.raw, line: i };
        else {
          const md = parseDayMonthNoYear(ln);
          if (md) {
            const y = resolveYear(md.m, md.d, anchors);
            if (y) out.date = { iso: y.iso, how: y.how, raw: md.raw, line: i };
            else out.pending = { raw: md.raw, line: i };   // seen but unresolvable
          }
        }
      }
      if (!out.time) {
        const t = parseTime(ln);
        if (t) { out.time = t; out.timeLine = i; }
      }
    }
    return out;
  }

  /**
   * Reads EVERY leg printed as a Depart/Arrive block pair. Returns [] when
   * the document has none, and the caller falls back to the one-route reader.
   * A block only becomes a leg when BOTH endpoints carry a recognised airport
   * code, so prose that merely mentions departing never manufactures one.
   */
  function readFlightLegs(lines, byIata, ctx) {
    const anchors = collectDateAnchors(lines);
    const pnr = findConfirmation(lines);
    const depIdx = [];
    for (let i = 0; i < lines.length; i++) {
      if (LEG_DEP.test(lines[i]) && lines[i].length <= 80) depIdx.push(i);
    }

    const legs = [];
    let consumedTo = -1;
    let prevArrLine = -1;
    for (let k = 0; k < depIdx.length; k++) {
      const i = depIdx[k];
      if (i <= consumedTo) continue;
      let j = -1;
      for (let n = i + 1; n <= i + 14 && n < lines.length; n++) {
        if (LEG_ARR.test(lines[n]) && lines[n].length <= 80) { j = n; break; }
      }
      if (j < 0) continue;
      const nextDep = depIdx.find(x => x > j);
      const blockEnd = Math.min(nextDep == null ? lines.length : nextDep, j + 14);

      const dep = readLegEndpoint(lines, i, j, byIata, anchors, ctx);
      const arr = readLegEndpoint(lines, j, blockEnd, byIata, anchors, ctx);
      if (!dep.code || !arr.code || dep.code === arr.code) continue;
      consumedTo = j;

      const warnings = [];
      const evidence = [];
      const from = byIata.get(dep.code);
      const to = byIata.get(arr.code);
      evidence.push({ field: 'route', raw: lines[dep.codeLine].trim(), line: dep.codeLine });
      evidence.push({ field: 'route', raw: lines[arr.codeLine].trim(), line: arr.codeLine });

      if (dep.date) {
        evidence.push({ field: 'startDate', raw: lines[dep.date.line].trim(), line: dep.date.line });
        if (dep.date.how === 'range') {
          warnings.push(`No year is printed next to "${dep.date.raw}"; taken as ${dep.date.iso} because only that year fits between the document's dated span. Check it.`);
        }
      } else if (dep.pending) {
        warnings.push(`"${dep.pending.raw}" is printed without a year and nothing else on the page settles which year it is. Set the date by hand.`);
      } else {
        warnings.push('No departure date could be read for this leg.');
      }
      if (dep.time) evidence.push({ field: 'startTime', raw: lines[dep.timeLine].trim(), line: dep.timeLine });
      if (arr.time) evidence.push({ field: 'endTime', raw: lines[arr.timeLine].trim(), line: arr.timeLine });

      // Landing date: an explicit arrival date wins; an arrival date equal to
      // the departure date is a normal same-day leg (including eastbound
      // date-line crossings where the clock lands EARLIER than it took off,
      // so the wrapped-clock inference must not fire); only a missing arrival
      // date leaves the overnight question to the clocks.
      let endDate = '';
      if (dep.date && arr.date) {
        if (arr.date.iso > dep.date.iso) {
          endDate = arr.date.iso;
          evidence.push({ field: 'endDate', raw: lines[arr.date.line].trim(), line: arr.date.line });
          warnings.push(`Overnight leg: lands ${endDate}, read from "${lines[arr.date.line].trim().slice(0, 50)}".`);
          if (arr.date.how === 'range') {
            warnings.push(`No year is printed next to "${arr.date.raw}"; taken as ${arr.date.iso} because only that year fits between the document's dated span. Check it.`);
          }
        } else if (arr.date.iso < dep.date.iso) {
          warnings.push(`An arrival line reads ${arr.date.iso}, which is BEFORE the departure date ${dep.date.iso}. It was ignored; check both dates.`);
        }
      } else if (dep.date && dep.time && arr.time && arr.time < dep.time) {
        const d = new Date(Date.UTC(+dep.date.iso.slice(0, 4), +dep.date.iso.slice(5, 7) - 1, +dep.date.iso.slice(8, 10) + 1));
        endDate = iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
        warnings.push(`Read as an overnight leg landing ${endDate} (the arrival time is earlier than the departure time); no arrival date was printed.`);
      }

      // Flight number: the nearest preceding designator, skipping aircraft
      // names, bounded so it cannot poach the previous leg's number.
      let flightNo = null;
      const backStop = Math.max(i - 18, prevArrLine);
      for (let n = i - 1; n > backStop; n--) {
        if (AIRCRAFT_LINE.test(lines[n])) continue;
        const m = LEG_FLIGHT_NO.exec(lines[n]);
        if (m && !codeIsAirport(m[1] + m[2].slice(0, 1), byIata)) {
          flightNo = { code: `${m[1]}${m[2]}`, line: n };
          break;
        }
      }
      if (flightNo) evidence.push({ field: 'details', raw: lines[flightNo.line].trim(), line: flightNo.line });

      // Seat: a bare "13B" line shortly after the arrival block, which is
      // where itinerary pages print the passenger's seat for the leg.
      let seat = null;
      for (let n = j; n < blockEnd; n++) {
        const m = SEAT_LINE.exec(lines[n]);
        if (m) { seat = m[1]; break; }
      }

      const item = {
        type: 'flight',
        title: `${from ? airportLabel(from) : dep.code} to ${to ? airportLabel(to) : arr.code}`,
        location: '',
        startDate: dep.date ? dep.date.iso : '',
        endDate,
        startTime: dep.time || '',
        endTime: arr.time || '',
        status: 'booked',
      };
      if (pnr) item.confirmation = pnr.code;
      const details = [];
      if (flightNo) details.push(`Flight ${flightNo.code}`);
      if (seat) details.push(`Seat ${seat}`);
      if (details.length) item.details = details.join(', ');
      if (pnr && !evidence.some(e => e.field === 'confirmation')) {
        evidence.push({ field: 'confirmation', raw: pnr.raw, line: pnr.line });
      }

      let confidence = 'high';
      if (!dep.date) confidence = 'low';
      else if (dep.date.how === 'range' || !dep.time || !arr.time) confidence = 'medium';

      const spanDays = (dep.date && endDate)
        ? Math.round((Date.parse(endDate) - Date.parse(dep.date.iso)) / 86400000)
        : (dep.date ? 0 : null);

      legs.push({ kind: 'flight', item, confidence, evidence, warnings, signals: { spanDays } });
      prevArrLine = j;
    }
    return legs;
  }

  /** Splits to trimmed non-empty lines, preserving original indexing. */
  function toLines(text) {
    return String(text || '').replace(/\r/g, '').split('\n').map(l => l.replace(/\s+/g, ' ').trim());
  }

  /**
   * Main entry. `airports` is the rows array from airportIndex(); pass [] to run
   * without airport validation (routes will then not be found).
   */
  // A flight is a day, not a month. A stay is a fortnight, not a season. These
  // are the bounds the plausibility tiebreak scores against; anything inside
  // them costs nothing.
  const MAX_PLAUSIBLE_FLIGHT_DAYS = 2;
  const MAX_PLAUSIBLE_STAY_NIGHTS = 30;
  // A backwards itinerary is not merely unlikely, it is impossible, so it
  // outweighs any amount of ordinary length.
  const IMPOSSIBLE_PENALTY = 60;
  // How much better the alternative has to be before it overturns the caller's
  // default. One or two days of difference is noise; a month is not.
  const PLAUSIBILITY_MARGIN = 3;

  /**
   * Scores how unlikely a set of proposals is as a real itinerary. Zero means
   * nothing looks wrong. Only used to compare the SAME document read two ways.
   */
  function implausibility(proposals) {
    let score = 0;
    for (const p of (proposals || [])) {
      const s = p.signals || {};
      if (p.kind === 'flight' && s.spanDays != null) {
        if (s.spanDays < 0) score += IMPOSSIBLE_PENALTY + Math.abs(s.spanDays);
        else score += Math.max(0, s.spanDays - MAX_PLAUSIBLE_FLIGHT_DAYS);
      }
      if (p.kind === 'stay' && s.nights != null) {
        if (s.nights <= 0) score += IMPOSSIBLE_PENALTY + Math.abs(s.nights);
        else score += Math.max(0, s.nights - MAX_PLAUSIBLE_STAY_NIGHTS);
      }
    }
    return score;
  }

  /**
   * Main entry. `airports` is the rows array from airportIndex(); pass [] to run
   * without airport validation (routes will then not be found).
   */
  function extractBookings(text, opts = {}) {
    const lines = toLines(text);
    const byIata = new Map((opts.airports || []).map(a => [a.iata, a]));

    // Ask the document which order it writes dates in before reading any of
    // them; the caller's default is only the fallback when it stays silent.
    const fallbackDayFirst = opts.dayFirst === true;
    const base = inferDateOrder(lines, { dayFirst: fallbackDayFirst });

    const readAll = (order) => {
      const ctx = { dayFirst: order.dayFirst, orderKnown: order.source === 'document' || order.source === 'plausibility', order };
      const out = [];
      // Depart/Arrive blocks first: they carry a code, date and time PER LEG,
      // which beats anything the one-route reader can infer, and they are the
      // only reading that keeps a connection from collapsing to one flight.
      const legs = readFlightLegs(lines, byIata, ctx);
      if (legs.length) {
        out.push(...legs);
      } else {
        const flight = readFlight(lines, byIata, ctx);
        if (flight) out.push(flight);
      }
      const stay = readStay(lines, ctx);
      if (stay) out.push(stay);
      return out;
    };

    let order = base;
    let proposals = readAll(order);

    // PLAUSIBILITY TIEBREAK. Only when the page offered no decisive date: read
    // it the other way too and see which produces an itinerary that could
    // actually happen. A confirmation whose dates say the flight takes 31 days
    // is not describing a 31-day flight, it is being read in the wrong order.
    //
    // This is weaker evidence than a number above 12 - it is a claim about the
    // world rather than a fact on the page - so it needs a clear margin before
    // it overturns the default, and it never restores full confidence.
    if (base.source === 'default' && lines.some(ln => (parseDate(ln, { dayFirst: fallbackDayFirst }) || {}).ambiguous)) {
      const altOrder = { dayFirst: !base.dayFirst, source: 'default', evidence: [], conflict: false };
      const altProposals = readAll(altOrder);
      const here = implausibility(proposals);
      const there = implausibility(altProposals);
      // A clear margin is the test, NOT a spotless winner. Requiring the
      // alternative to score zero meant a reading that made the flight 122 days
      // long beat one that made it 4, because 4 is still a day over the bound.
      // The less-bad reading wins, and anything still odd about it is warned
      // about downstream as usual.
      if (here - there >= PLAUSIBILITY_MARGIN) {
        order = {
          dayFirst: altOrder.dayFirst,
          source: 'plausibility',
          conflict: false,
          evidence: [],
          rejected: { dayFirst: base.dayFirst, score: here },
        };
        proposals = readAll(order);
      }
    }

    return {
      proposals,
      lines,
      order,
      stats: {
        lines: lines.filter(Boolean).length,
        found: proposals.length,
        unreadable: !proposals.length,
      },
    };
  }

  // ---------- calendar-file import (.ics) ----------
  // The other half of buildIcs: a calendar file the traveller already holds (a
  // conference programme, a shared trip calendar, the .ics an airline attaches)
  // read back into the same reviewable proposals the PDF reader produces. No
  // network and no model - an .ics has labelled fields, so nothing here guesses.
  //
  // Times are the WALL CLOCK AS WRITTEN, whatever the file says about zones.
  // The app stores no time zone at all, so converting a Z-stamped or TZID'd
  // stamp would move the event by an amount nothing in the app can name back,
  // and 09:00 in the file is what the traveller reads off their own calendar.

  const ICS_UNESCAPE = { n: '\n', N: '\n', '\\': '\\', ';': ';', ',': ',' };
  const icsUnescape = s => String(s).replace(/\\([nN\\;,])/g, (_, c) => ICS_UNESCAPE[c]);

  // RFC 5545 folding: a CRLF followed by one space or tab continues the line
  // before it. Bare LF is accepted too, because plenty of real files use it.
  function icsUnfold(text) {
    return String(text == null ? '' : text)
      .replace(/\r\n|\r/g, '\n')
      .replace(/\n[ \t]/g, '')
      .split('\n');
  }

  // "DTSTART;TZID=Europe/Paris:20270112T090000" -> name, params, value. The
  // value starts at the first colon OUTSIDE quotes, because a quoted parameter
  // is allowed to contain one ("TZID=\"GMT+05:00\"").
  function icsProp(line) {
    let quoted = false;
    let colon = -1;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') quoted = !quoted;
      else if (c === ':' && !quoted) { colon = i; break; }
    }
    if (colon < 0) return null;
    const head = line.slice(0, colon).split(';');
    return { name: head[0].trim().toUpperCase(), value: line.slice(colon + 1) };
  }

  // 20270112 (all-day) or 20270112T090000 with an optional trailing Z. Anything
  // else returns null, which is what makes an event countable as unread rather
  // than half-imported onto a made-up day.
  function icsDateTime(value) {
    const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?Z?)?$/.exec(String(value).trim());
    if (!m) return null;
    const date = `${m[1]}-${m[2]}-${m[3]}`;
    if (!isIsoDate(date)) return null;
    if (!m[4]) return { date, time: '' };
    if (Number(m[4]) > 23 || Number(m[5]) > 59) return null;
    return { date, time: `${m[4]}:${m[5]}` };
  }

  /**
   * The same, but tolerant of an UNQUOTED parameter that smuggled a colon into
   * the value: Outlook writes "DTSTART;TZID=GMT+05:00:20270112T090000", which
   * splits into a value of "00:20270112T090000" and skipped the event as
   * unreadable. Retrying after the LAST colon recovers the stamp, and a value
   * that is simply junk ("not-a-date") still returns null.
   */
  function icsDateTimeLoose(value) {
    const direct = icsDateTime(value);
    if (direct) return direct;
    const s = String(value);
    const cut = s.lastIndexOf(':');
    return cut >= 0 ? icsDateTime(s.slice(cut + 1)) : null;
  }

  /**
   * "PT2H", "PT1H30M", "P1D": the other legal way an .ics says when an event
   * ends. Without it the end was dropped in silence, so a two-hour tour
   * imported with no end time at all. Returns whole minutes, or null.
   */
  function icsDuration(value) {
    const m = /^P(?!$)(?:(\d+)W)?(?:(\d+)D)?(?:T(?!$)(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/
      .exec(String(value).trim().toUpperCase());
    if (!m) return null;
    const mins = (+m[1] || 0) * 10080 + (+m[2] || 0) * 1440
      + (+m[3] || 0) * 60 + (+m[4] || 0) + Math.floor((+m[5] || 0) / 60);
    return mins > 0 ? mins : null;
  }

  function icsEndFromDuration(start, value) {
    const mins = icsDuration(value);
    if (!mins) return null;
    // An all-day event's duration is whole days, and the DTEND it stands in for
    // is EXCLUSIVE, which is the convention the caller already unwinds.
    if (!start.time) return { date: addDays(start.date, Math.max(1, Math.round(mins / 1440))), time: '' };
    const d = new Date(Date.parse(`${start.date}T${start.time}:00Z`) + mins * 60000);
    return {
      date: iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()),
      time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`,
    };
  }

  function icsProposal(evLines) {
    const props = new Map();
    for (const line of evLines) {
      const p = icsProp(line);
      // First wins: a VEVENT is not supposed to repeat these properties, and a
      // calendar app shows the first when one does.
      if (p && !props.has(p.name)) props.set(p.name, p.value);
    }
    const start = props.has('DTSTART') ? icsDateTimeLoose(props.get('DTSTART')) : null;
    if (!start) return null;
    const end = (props.has('DTEND') ? icsDateTimeLoose(props.get('DTEND')) : null)
      || (props.has('DURATION') ? icsEndFromDuration(start, props.get('DURATION')) : null);
    const text = name => (props.has(name) ? icsUnescape(props.get(name)).trim() : '');

    const item = {
      // Everything lands as an activity. An .ics says what an event is CALLED,
      // never what kind of thing it is, and the type is one click to change on
      // a card the traveller is reviewing anyway; inferring "flight" from a
      // summary line would be the one guess this reader gets to make.
      type: 'activity',
      // A VEVENT with no SUMMARY is legal. Without a placeholder the proposal
      // would fail validation and render as an unexplained "Cannot apply".
      title: text('SUMMARY') || 'Calendar event',
      location: text('LOCATION'),
      startDate: start.date,
      startTime: start.time,
      endDate: '',
      endTime: '',
    };
    const details = text('DESCRIPTION');
    if (details) item.details = details;
    if (end) {
      if (!start.time && !end.time) {
        // An all-day DTEND is EXCLUSIVE (the convention buildIcs writes), so
        // the app's inclusive last day is the day before it. A one-day event
        // therefore keeps an empty endDate rather than repeating its start.
        const last = addDays(end.date, -1);
        if (diffDays(item.startDate, last) > 0) item.endDate = last;
      } else if (diffDays(item.startDate, end.date) > 0) {
        item.endDate = end.date;
      }
      if (end.time) item.endTime = end.time;
    }
    // RRULE is read as a flag, not expanded: DTSTART is the first occurrence,
    // and importing 52 weekly copies of a standing meeting into a trip is never
    // what anyone wanted. The caller says so out loud in its summary line.
    return { item, recurring: props.has('RRULE') };
  }

  function parseIcsToProposals(text) {
    // Pasted (not file-picked) calendars often arrive uniformly indented:
    // email clients, chat apps and docs add a leading margin to every line
    // of a quoted block. RFC 5545 says a line starting with whitespace is a
    // CONTINUATION of the previous line, so the unfolder glues an indented
    // paste into one long line and the strict parse finds zero events, and
    // the traveller is told their perfectly good calendar is empty. When
    // that happens AND every non-blank line shares a common indent, strip
    // the indent once and re-parse. Genuine folding is untouched: a real
    // fold's continuation lines are indented while its property lines are
    // not, so such text has no COMMON indent and never takes this path.
    const first = parseIcsStrict(text);
    if (first.stats.events > 0) return first;
    const lines = String(text || '').split(/\r\n|\r|\n/);
    const nonBlank = lines.filter(l => l.trim());
    if (!nonBlank.length || !nonBlank.every(l => /^[ \t]/.test(l))) return first;
    return parseIcsStrict(lines.map(l => l.replace(/^[ \t]+/, '')).join('\n'));
  }

  function parseIcsStrict(text) {
    const events = [];
    let current = null;
    // How deep inside a component NESTED in the event we are. A VALARM's own
    // DESCRIPTION and SUMMARY sat in the same first-wins map as the event's,
    // so "Reminder: 30 minutes before" became the trip item's details and the
    // alarm's title could replace the event's.
    let nested = 0;
    for (const line of icsUnfold(text)) {
      const flat = line.trim();
      if (/^BEGIN:VEVENT$/i.test(flat)) { current = []; nested = 0; continue; }
      if (/^END:VEVENT$/i.test(flat)) { if (current) events.push(current); current = null; nested = 0; continue; }
      if (current && /^BEGIN:/i.test(flat)) { nested++; continue; }
      if (current && /^END:/i.test(flat)) { nested = Math.max(0, nested - 1); continue; }
      if (current && !nested && flat) current.push(line);
    }
    // A file that stops mid-event is not an empty calendar, and saying "no
    // events" sent the traveller looking for the fault in their own file.
    const unclosed = current ? 1 : 0;
    const proposals = [];
    let recurring = 0;
    for (const ev of events) {
      const p = icsProposal(ev);
      if (!p) continue;
      if (p.recurring) recurring++;
      proposals.push(p);
    }
    return {
      proposals,
      stats: {
        events: events.length + unclosed,
        read: proposals.length,
        skipped: events.length + unclosed - proposals.length,
        recurring,
      },
    };
  }

  // ---------- one day as plain text ----------
  // What a traveller pastes into a message: the day, then the day card's own
  // rows in the order the card draws them. The two formatters are injected
  // rather than rebuilt here (the same shape budgetFigure takes), so the text
  // prints the very date and clock format the screen beside it is printing.
  //
  // The stay is ONE "Staying at" line rather than the card's check-in and
  // check-out rows: a day pasted into a chat should say where you are sleeping,
  // not name the same hotel twice.
  //
  // Trip essentials can never reach this text, and that is structural rather
  // than a filter: this is handed the day's ITEMS, and the emergency contact,
  // the insurer and the medical note live on the trip (see readEssentials).
  // dayHostStay minus its location requirement; see the call site below for
  // why the two must differ. Night wins, checkout morning still answers.
  function shareHostStay(items, date) {
    const stays = (items || []).filter(it => isStay(it) && it.status !== 'cancelled'
      && ((it.title || '').trim() || (it.location || '').trim())
      && isIsoDate(it.startDate) && isIsoDate(it.endDate));
    return stays.find(s => s.startDate <= date && date < s.endDate)
      || stays.find(s => s.endDate === date)
      || null;
  }

  // The same icons the on-screen cards use (app.js TYPE_META); duplicated
  // here rather than injected because this module is the pure layer and the
  // set is as stable as the type list itself.
  const TYPE_ICONS = {
    flight: '✈️', transport: '🚆', local: '🚕',
    activity: '🎟️', stay: '🏨', note: '📝',
  };

  function dayShareText(card, items, fmtDate, fmtTime) {
    // Built as SECTIONS joined by blank lines, not a flat list: the text is
    // pasted into messages, where an unbroken run of lines made the note
    // items read like headings and the stay line like just another event.
    // Owner-directed format: date header, timed rows with the card's own
    // type icon, untimed rows as a bulleted block, the stay set apart last.
    const row = ev => {
      const it = ev.item;
      const time = ev.time ? fmtTime(ev.time) + ' ' : '';
      const icon = TYPE_ICONS[it.type] || '';
      const where = String(it.location == null ? '' : it.location).trim();
      // The "Cancelled" badge the card puts beside the title, in words:
      // displayTitle strips the "Cancelled:" prefix, so without this the row
      // reads in a message as a plan that is still on.
      const off = it.status === 'cancelled' ? ' (Cancelled)' : '';
      const line = `${time}${icon ? icon + ' ' : ''}${displayTitle(it)}${where ? ', ' + where : ''}${off}`;
      // Same rule the .ics export follows: the confirmation code travels with
      // the item, because a pasted day is read at a counter or a gate.
      const ref = String(it.confirmation == null ? '' : it.confirmation).trim();
      return ref ? [line, 'Ref: ' + ref] : [line];
    };

    const sections = [['📅 ' + fmtDate(card.date)]];
    const timed = [];
    for (const ev of card.events) if (ev.kind === 'item') timed.push(...row(ev));
    if (timed.length) sections.push(timed);
    if (card.untimed.length) {
      const untimed = ['No time set:'];
      for (const ev of card.untimed) untimed.push(...row(ev).map(l => l.startsWith('Ref: ') ? l : '• ' + l));
      sections.push(untimed);
    }
    // NOT dayHostStay: that helper answers "which CITY does this date belong
    // to" and therefore requires a location, which weather chips and day
    // headers depend on. For the copy the hotel NAME is the value and Place
    // is optional (people skip it when the title already names the hotel),
    // so this lookup keeps the same date windows and drops the location gate.
    const host = shareHostStay(items, card.date);
    if (host) {
      const stay = [`🏨 Staying at: ${(host.title || host.location).trim()}`];
      // The hotel's code, on the day you check in and no other - which is both
      // where the card prints it (the check-in row) and where the .ics puts it
      // (one event, starting here). Repeating it under every night of the stay
      // would bury the day's own rows.
      const stayRef = host.startDate === card.date ? String(host.confirmation == null ? '' : host.confirmation).trim() : '';
      if (stayRef) stay.push('Ref: ' + stayRef);
      sections.push(stay);
    }
    return sections.map(s => s.join('\n')).join('\n\n');
  }

  // ---------- spend over time ----------
  // Monday on or before this date. ISO weeks run Monday..Sunday and
  // getUTCDay() calls Sunday 0, so Sunday walks back six days, not none.
  function weekStart(date) {
    return addDays(date, -((toUtc(date).getUTCDay() + 6) % 7));
  }

  // "When did the money land", one bucket per ISO week of a BOOKED costed
  // item's start date. Booked-only and unconverted-aside are exactly the
  // filters costsByType and the Confirmed total use, so these buckets add up to
  // the number the totals bar already prints rather than to a third figure.
  //
  // A spend-free week BETWEEN two that hold money still gets a zero bucket:
  // this is a time series, and closing the gap would draw a quiet week as if it
  // never happened. Weeks before the first and after the last spend are not
  // buckets at all, because there is nothing between them to distort.
  const MAX_SPEND_WEEKS = Math.ceil(MAX_TRIP_DAYS / 7) + 1;
  function spendByWeek(trip, ratesObj) {
    const base = (trip && trip.currency) || 'USD';
    const weeks = new Map();
    for (const it of ((trip && trip.items) || [])) {
      if (it.status !== 'booked') continue;
      if (it.cost == null || it.cost === '' || isNaN(it.cost)) continue;
      if (!isIsoDate(it.startDate)) continue;
      const start = weekStart(it.startDate);
      let row = weeks.get(start);
      if (!row) { row = { start, total: 0, unconverted: [] }; weeks.set(start, row); }
      const conv = convertAmount(Number(it.cost), it.costCurrency || base, base, ratesObj);
      if (conv === null) row.unconverted.push(it);
      else row.total += conv;
    }
    if (!weeks.size) return [];
    const keys = [...weeks.keys()].sort();
    const first = keys[0], last = keys[keys.length - 1];
    // One mistyped year dates an item millions of days out (the hazard dayCards
    // caps with renderEnd), and filling every empty week to it would build
    // hundreds of thousands of rows. Past the cap the buckets stay sparse: every
    // week holding money is still there and they still add up to the same total.
    if (diffDays(first, last) / 7 + 1 > MAX_SPEND_WEEKS) return keys.map(k => weeks.get(k));
    const out = [];
    for (let d = first; d <= last; d = addDays(d, 7)) {
      out.push(weeks.get(d) || { start: d, total: 0, unconverted: [] });
    }
    return out;
  }

  return {
    isIsoDate, toUtc, diffDays, addDays, localDateIso,
    shiftFits, applyDayShift, firstItemDate, startDateShift,
    isStay, nights, sortKey, bySortKey, sortedItems, tripLegs,
    tieKey, tieGroups, tieGroupOf, reorderableIds, applyManualOrder, normalizeOrders, moveInTie, ORDER_MAX,
    stayPrefillForGap, firstStayPrefill,
    nextUpEvent, NEXT_UP_WINDOW_MIN, defaultPackingItems,
    packingWho, packingRowsFor, packingProgress, packingRosterDrops, applyPackingRoster,
    templateItem, tripAsTemplate, TEMPLATE_CLEARED,
    isTransitType, isTransitSpan, overnightTransit,
    validateItem, coverageGaps, tripStats, overlappingTrips, MAX_TRIP_DAYS, DATE_MIN, DATE_MAX, isDateInRange,
    ISLANDISH, distKm, flagEmoji, compass, fmtDur, modeOptions,
    modeCost, modeCo2, routeBadges, corridorFacts, routeFlags, routeTips,
    routeLinks, modeLink, ROUTE_HONESTY,
    classifyGeoMatch, geoInputIsQualified, geoMatchNote,
    GEO_RIVAL_GAP, GEO_WEAK_IMPORTANCE, GEO_SETTLEMENT_KINDS, GEO_MATCH_RANK, GEO_MATCH_TEXT,
    foldPlace, normalizePlaceRow, placeScore, rankPlaceResults, PLACE_FEATURE_RE, PLACE_POP_WEIGHT, PLACE_PREFIX_BONUS, PLACE_EXACT_BONUS,
    HOTEL_TAGS, normalizeHotelRow, hotelScore, rankHotelResults,
    HOTEL_POSITION_WEIGHT, HOTEL_CITY_BONUS, HOTEL_PREFIX_BONUS, HOTEL_EXACT_BONUS, HOTEL_KIND_BONUS,
    airportIndex, airportLabel, airportDetail, airportScore, searchAirports, PRIMARY_HUBS,
    parseBookingDate: parseDate, parseBookingTime: parseTime, parseDocMoney,
    findConfirmation, findRoute, inferDateOrder, implausibility,
    readFlightLegs, parseDayMonthNoYear, collectDateAnchors, resolveYear,
    extractBookings, bookingTextToLines: toLines,
    parseIcsToProposals,
    flightTitleFromAirports, parseFlightAirports,
    classifyVisa, parseVisaMatrix, visaCountryUsable, visaUnconfirmedNames, visaVintageNote,
    passportExpiryStatus, PASSPORT_VALIDITY_DAYS,
    slimTripForShare, hasFastRail, viewFromHash, hashForView,
    buildIcs, buildGpx, buildCsv, csvColumns, convertAmount, sumInCurrency,
    normalizeTravelers, travelerTotals,
    assignedTravelers, evenSplitAmounts, splitAmountsSum, splitAmountsMatch, customSplitShares,
    settlements, costsByType, typeBarShares, cashNeeded,
    dayShareText, shareHostStay, weekStart, spendByWeek, MAX_SPEND_WEEKS,
    bytesToBase64url, base64urlToBytes,
    transportGaps, connectionWarnings, sameTimeCollisions, TIGHT_CONNECTION_MIN, tripPhase, isPastRow,
    bookingDeadlines, BOOKING_LEAD_DAYS,
    paceAdvisory, PACE_MIN_STAYS, PACE_FAST_AVG_NIGHTS,
    dayCards, dayHostStay, dayItemsInOrder, emptyDayNote, stripPlaceCode, parseTravelOrigin, dayMorningCity,
    departureOrigin, suggestedPassport, passportAssumptionParts,
    coveringStay, timelineGroups,
    defaultPlanDay, planDayGroups, weatherKey, summarizeClimate, weatherLine, weatherRange, pickMonthSamples, docGuard,
    FORECAST_DAYS, FORECAST_TTL_MS, forecastEligible, forecastKey, forecastFresh, freshForecasts, summarizeForecast, forecastLine,
    FORECAST_CONDITIONS, forecastConditionKey, forecastCondition, forecastChipParts,
    extractTripActions, validateTripAction, buildAssistPackage, buildAssistSystemPrompt,
    fitAssistContext, ASSIST_DETAILS_BUDGET, ASSIST_TRUNCATED_NOTE,
    assistOptionRules, assistOriginNote, PLAN_MEAL_OPTIONS, PLAN_ACTIVITY_OPTIONS,
    buildPlanRequest, groupProposals, linkifySegments,
    parseMarkdown, parseMarkdownInline,
    normalizePlaceQuery, placeCacheKey, planPlacesLookup, placesCacheUpdates,
    createPlacesQueue, placesRetryDelay,
    PLACES_BATCH_MAX, PLACES_CONCURRENCY, PLACES_DEFER_MS, PLACES_MAX_ATTEMPTS,
    VENUE_TTL_MS, VENUE_CACHE_MAX, venueFresh, normalizeVenueCache, rememberVenue,
    placesLocationUpdates, pickVenueFeature, validCoord,
    SAME_SPOT_KM, sameSpot, distancePoint, dayAnchor, dayDistanceChain,
    parseTravelArrival, dayArrival, proposalOrigin, dayBaseOrigin, suggestionOrigins,
    ROUTE_EXACT_MAX, shortestRoute, routeStops, setDistanceUnit, getDistanceUnit, fmtDist, distanceChipLabel, distanceChipTitle, routeFooterText,
    assistDistanceChipLabel, assistDistanceChipTitle, shortHopHint, hopTravel, fmtMins, WALKABLE_KM,
    isPlaceType, isTravelLeg, directionsUrl, legTravelMode,
    dayTravelTotals, dayRouteMode, directionsRouteUrl, routeUrlChunks, candidateBadges,
    mapsSearchUrl, assistMapsLink, itemMapsQuery, displayTitle, showsCostBadge, isFoodOrDrink, isEstimatedCost, costDisplayParts, mealTitlePrefixes,
    hasEstimate, displayCostOf, parseMoney, roundMoney, budgetVerdict, refundParts,
    readBudgetRange, normalizeBudgetFrom, budgetFigure,
    mealKind, isLongDetails,
    matchSampleTrip, normalizeTripName, sampleTrip, sampleTripOptions, buildSampleTrip,
    SAMPLE_START_OFFSET, sampleStartOffset,
  };
})();

if (typeof window !== 'undefined') window.TripLogic = TripLogic;
if (typeof module !== 'undefined' && module.exports) module.exports = TripLogic;
