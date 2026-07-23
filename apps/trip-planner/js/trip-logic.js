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
    // A NEGATIVE cost is legal: it is a refund or a credit (a cancelled hotel
    // that was refunded, a partial credit, a share of a bill somebody paid
    // back). Only a value that is not a finite number is an error, because that
    // is the one thing no total can be built from.
    if (it.cost != null && it.cost !== '' && !Number.isFinite(Number(it.cost))) errs.cost = true;
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
    descParts.push('Status: ' + (ICS_STATUS[it.status] || it.status || ''));
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

  // ---------- CSV export ----------
  // Pure so the round trip is testable: the `cost` column is the STORED number,
  // sign and all, which is what makes a spreadsheet SUM over it equal the app's
  // own total even with refunds in the mix. Display wording ("Refund $120.00")
  // never reaches this file. estCost keeps its own column for the same reason:
  // a guess must not land in a column people total.
  function csvColumns(base) {
    return ['startDate', 'startTime', 'endDate', 'endTime', 'nights', 'type', 'title', 'location',
      'details', 'status', 'cost', 'costCurrency', `costIn${base}`, 'estimatedCost',
      'estimatedCostCurrency', 'costNote'];
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
        it.costNote || '',
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

  function eventSortKey(ev) {
    const t = ev.sortTime || '99:99';
    const typeOrd = TYPE_ORDER[ev.item.type] !== undefined ? TYPE_ORDER[ev.item.type] : 9;
    return `${t}|${typeOrd}|${EVENT_KIND_ORDER[ev.kind]}|${ev.item.createdAt || ''}`;
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

  // Items that start on this date, in the order they happen.
  function dayItemsInOrder(items, date) {
    return (items || [])
      .filter(it => it.startDate === date && it.status !== 'cancelled' && !isStay(it))
      .sort((a, b) => sortKey(a) < sortKey(b) ? -1 : 1);
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
      .sort((a, b) => sortKey(a) < sortKey(b) ? -1 : 1)[0];
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
  // case-insensitive (looser than the boot-time check, which matches the exact
  // generated prefix) so anything that even looks like a payload is left alone.
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
    if (Array.isArray(trip.visaExtras) && trip.visaExtras.length) slim.visaExtras = trip.visaExtras;
    slim.items = trip.items.map((it, i) => {
      const out = { id: 'i' + (i + 1) };
      // mapsQuery rides along because this is also the trip JSON the assistant
      // sees: without it the model cannot tell an item already has a verified
      // place attached and re-suggests the same venue.
      // estCost rides along so a shared itinerary still shows what to expect;
      // it stays out of every total on the far side exactly as it does here.
      for (const k of ['type', 'title', 'location', 'startDate', 'endDate', 'startTime', 'endTime', 'status', 'cost', 'costCurrency', 'estCost', 'estCostCurrency', 'costNote', 'details', 'mapsQuery']) {
        if (keep(it[k])) out[k] = it[k];
      }
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
    const budget = PLAN_BUDGETS[p.budget] || PLAN_BUDGETS[2];
    const wake = fmt12h(p.wakeTime || '08:00') || fmt12h('08:00');
    const back = fmt12h(p.returnTime || '22:00') || fmt12h('22:00');
    const activities = planRange(p.activities === undefined ? 3 : p.activities);
    const drinks = planRange(p.drinks || 0);

    const lines = [];
    lines.push(`Plan my day for ${isIsoDate(p.date) ? p.date : 'this day'}.`);
    lines.push(`I am ready to head out at ${wake} and want to be back at my hotel by ${back}.`);

    if (activities) {
      const s = stylePhrase(styles.activities);
      lines.push(`I would like ${activities} activities${s ? `, leaning ${s}` : ''}.`);
    }
    if (mealNames.length) {
      const s = stylePhrase(styles.meals);
      lines.push(`Plan ${joinWords(mealNames, 'and')}${s ? `, leaning ${s}` : ''}, and give me 2-3 options for each one.`);
    }
    if (drinks) {
      const s = stylePhrase(styles.drinks);
      lines.push(`Include ${drinks} ${s ? `${s} drinks` : 'drinks'} stops, and give me 2-3 options for each one.`);
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

    lines.push(`Keep the whole day ${budget}.`);

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
  // Meal and drinks proposals arrive as 2-3 candidates sharing one `group` id so
  // the UI can offer a single choice instead of stacking three dinners. Anything
  // ungrouped (or alone in its group) stays a plain single card.
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
      if (!uri) continue;
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
  function sanitizeActionFields(raw) {
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
    return f;
  }

  // Booked/cancelled never pass from an AI suggestion: a proposal is always
  // something the traveller still has to act on, so it lands as "to book"
  // unless the model explicitly said "decide" (decide later).
  const forceProposalStatus = raw => (raw === 'decide' ? 'decide' : 'to-book');

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
      const status = forceProposalStatus(item.status);
      const fields = sanitizeActionFields(item);
      const proposal = { op: 'add', status, fields, display: displayFor(fields, status, fields.mapsQuery) };
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

  const ASSIST_GROUPS = 'For each meal slot and each drinks slot the traveller asked for (and only '
    + 'those), propose 2-3 candidates and give '
    + 'every candidate of that slot the same "group" value on its action, for example '
    + '{"op":"add","group":"dinner-2026-12-31","item":{...}}, so the traveller picks one of them. '
    + 'Use a distinct group per slot ("breakfast-2026-12-31", "lunch-2026-12-31", '
    + '"drinks-2026-12-31"). Do NOT group activities or transport: those are single proposals.';

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

  function buildAssistPackage({ trip, focusDate, request }) {
    const parts = [];
    parts.push('You are a travel-planning assistant helping edit a trip itinerary.');
    parts.push(ASSIST_HONESTY);
    parts.push('Here is the current trip as JSON:');
    parts.push(JSON.stringify(slimTripForShare(trip)));
    parts.push(ASSIST_SCHEMA);
    parts.push(ASSIST_CONTRACT);
    parts.push(ASSIST_KINDS);
    parts.push(ASSIST_AGENDA);
    parts.push(ASSIST_GROUPS);
    parts.push(ASSIST_MAPSQUERY);
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

  function buildAssistSystemPrompt({ trip, focusDate, today, truncated }) {
    const parts = [];
    parts.push('You are a travel-planning assistant helping edit a trip itinerary.');
    parts.push(ASSIST_HONESTY);
    parts.push(ASSIST_SCHEMA);
    parts.push(ASSIST_CONTRACT);
    parts.push(ASSIST_KINDS);
    parts.push(ASSIST_AGENDA);
    parts.push(ASSIST_GROUPS);
    parts.push(ASSIST_MAPSQUERY);
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
  // Each template runs 7 to 14 days and shares the same backbone: an inbound
  // international flight from ANOTHER country, a first-city stay, one intercity
  // leg by whatever mode actually fits the country (rail, road, ferry or a
  // domestic flight), a second-city stay, and the flight home. What varies on
  // purpose is the SHAPE: a seven day Iceland road trip carries a handful of
  // stops and long drives between them, Croatia leaves whole days deliberately
  // blank, Peru and Japan run four or five things a day, and Thailand is packed
  // in the city half and near empty on the beach. Budgets vary too, from a
  // backpacker Vietnam to a splurge Iceland, because the money formatting and
  // the currency conversion path deserve a spread as much as the itinerary
  // does. The data is also the app's regression fixture, so every template
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
  })).sort((a, b) => a.label.localeCompare(b.label));

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
  // `today` so a sample never rots into the past, and the ids are deterministic
  // so a regression run can name a row. Returns null for an unknown id.
  function buildSampleTrip(id, opts) {
    const tpl = sampleTrip(id);
    if (!tpl) return null;
    const o = opts || {};
    const today = isIsoDate(o.today) ? o.today : new Date().toISOString().slice(0, 10);
    const currency = /^[A-Z]{3}$/.test(o.currency || '') ? o.currency : 'USD';
    const createdAt = o.createdAt || `${today}T00:00:00.000Z`;
    const base = addDays(today, SAMPLE_START_OFFSET);
    const specs = [SAMPLE_NOTE, ...tpl.items];
    return {
      id: tpl.id,
      label: tpl.label,
      name: `Example: ${tpl.label}`,
      currency,
      items: specs.map((spec, i) => expandSampleItem(spec, tpl.id, base, i, createdAt, currency)),
    };
  }

  return {
    isIsoDate, toUtc, diffDays, addDays,
    isStay, nights, sortKey, sortedItems, tripLegs,
    isTransitType, isTransitSpan, overnightTransit,
    validateItem, coverageGaps, tripStats, MAX_TRIP_DAYS, DATE_MIN, DATE_MAX, isDateInRange,
    ISLANDISH, distKm, flagEmoji, compass, fmtDur, modeOptions,
    modeCost, modeCo2, routeBadges, corridorFacts, routeFlags, routeTips,
    routeLinks, modeLink, ROUTE_HONESTY,
    classifyGeoMatch, geoInputIsQualified, geoMatchNote,
    GEO_RIVAL_GAP, GEO_WEAK_IMPORTANCE, GEO_SETTLEMENT_KINDS, GEO_MATCH_RANK, GEO_MATCH_TEXT,
    classifyVisa, parseVisaMatrix, visaCountryUsable, visaVintageNote,
    slimTripForShare, hasFastRail, viewFromHash, hashForView,
    buildIcs, buildCsv, csvColumns, convertAmount, sumInCurrency,
    bytesToBase64url, base64urlToBytes,
    transportGaps, tripPhase, isPastRow,
    dayCards, dayHostStay, emptyDayNote, stripPlaceCode, parseTravelOrigin, dayMorningCity,
    departureOrigin, suggestedPassport, passportAssumptionParts,
    coveringStay, timelineGroups,
    defaultPlanDay, planDayGroups, weatherKey, summarizeClimate, weatherLine, weatherRange, pickMonthSamples, docGuard,
    extractTripActions, validateTripAction, buildAssistPackage, buildAssistSystemPrompt,
    fitAssistContext, ASSIST_DETAILS_BUDGET, ASSIST_TRUNCATED_NOTE,
    buildPlanRequest, groupProposals, linkifySegments,
    parseMarkdown, parseMarkdownInline,
    normalizePlaceQuery, placeCacheKey, planPlacesLookup, placesCacheUpdates,
    mapsSearchUrl, assistMapsLink, itemMapsQuery, displayTitle, showsCostBadge, isFoodOrDrink, isEstimatedCost, costDisplayParts, mealTitlePrefixes,
    hasEstimate, displayCostOf, parseMoney, roundMoney, budgetVerdict, refundParts,
    mealKind, isLongDetails,
    matchSampleTrip, normalizeTripName, sampleTrip, sampleTripOptions, buildSampleTrip, SAMPLE_START_OFFSET,
  };
})();

if (typeof window !== 'undefined') window.TripLogic = TripLogic;
if (typeof module !== 'undefined' && module.exports) module.exports = TripLogic;
