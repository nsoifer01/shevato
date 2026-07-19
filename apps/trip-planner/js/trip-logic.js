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
    const timed = (it.type === 'flight' || it.type === 'transport') && /^\d{2}:\d{2}$/.test(it.startTime || '');
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
  function eventSortKey(ev) {
    const t = ev.time || '99:99';
    const typeOrd = TYPE_ORDER[ev.item.type] !== undefined ? TYPE_ORDER[ev.item.type] : 9;
    return `${t}|${typeOrd}|${EVENT_KIND_ORDER[ev.kind]}|${ev.item.createdAt || ''}`;
  }
  function dayCards(trip) {
    const stats = tripStats(trip);
    if (!isIsoDate(stats.start) || !isIsoDate(stats.end)) return [];
    const totalDays = diffDays(stats.start, stats.end) + 1;
    const items = trip.items || [];
    const cards = [];
    for (let d = stats.start, i = 0; d <= stats.end; d = addDays(d, 1), i++) {
      const events = [];
      for (const it of items) {
        if (isStay(it)) {
          if (it.startDate === d) events.push({ kind: 'checkin', item: it, time: '' });
          if (isIsoDate(it.endDate) && it.endDate === d) events.push({ kind: 'checkout', item: it, time: '' });
        } else if (it.startDate === d) {
          events.push({ kind: 'item', item: it, time: it.startTime || '' });
        }
      }
      events.sort((a, b) => eventSortKey(a) < eventSortKey(b) ? -1 : 1);
      let stayingAt = null;
      if (!events.length) {
        const host = items.find(it => isStay(it) && it.status !== 'cancelled' && (it.location || '').trim()
          && isIsoDate(it.startDate) && isIsoDate(it.endDate) && it.startDate < d && d < it.endDate);
        if (host) stayingAt = host.location.trim();
      }
      cards.push({ date: d, dayNumber: i + 1, totalDays, events, stayingAt, empty: !events.length && !stayingAt });
    }
    return cards;
  }

  // ---------- typical weather (climate) ----------
  // Cache key for one (place, month) climate lookup. Month is a 1-12 number.
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

  // Human line for a day card. Deliberately says "Typically ... this time of
  // year" (climate, not a forecast) and never promises what the weather will be.
  function weatherLine(place, summary) {
    if (!summary || summary.lo == null || summary.hi == null) return '';
    return `Typically ${summary.lo}-${summary.hi}°C in ${place} this time of year` +
      (summary.wet ? ', often rainy' : '');
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
      for (const k of ['type', 'title', 'location', 'startDate', 'endDate', 'startTime', 'endTime', 'status', 'cost', 'costCurrency', 'costNote', 'details']) {
        if (keep(it[k])) out[k] = it[k];
      }
      return out;
    });
    return slim;
  }

  return {
    isIsoDate, toUtc, diffDays, addDays,
    isStay, nights, sortKey, sortedItems, tripLegs,
    validateItem, coverageGaps, tripStats,
    ISLANDISH, distKm, flagEmoji, compass, fmtDur, modeOptions,
    classifyVisa, parseVisaMatrix,
    slimTripForShare, hasFastRail,
    buildIcs, convertAmount, sumInCurrency,
    bytesToBase64url, base64urlToBytes,
    transportGaps, tripPhase, isPastRow,
    dayCards, weatherKey, summarizeClimate, weatherLine, docGuard,
  };
})();

if (typeof window !== 'undefined') window.TripLogic = TripLogic;
if (typeof module !== 'undefined' && module.exports) module.exports = TripLogic;
