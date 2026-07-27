/**
 * PROTOTYPE - not wired into the app, not loaded by index.html.
 *
 * Deterministic extraction of trip items from the TEXT of a booking
 * confirmation. No model, no network. The point of the prototype is to find
 * out how much of a real confirmation can be read with certainty, so that the
 * assistant is only asked about the messy remainder.
 *
 * Output shape deliberately matches the app's item fields (the same names
 * sanitizeActionFields accepts), plus provenance:
 *
 *   { item, kind, confidence, evidence: [{field, raw, line}], warnings: [] }
 *
 * Provenance is the whole point. A wrong read must be VISIBLE next to the line
 * it came from, not merely plausible in a form field.
 */

/* eslint-disable no-useless-escape */

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
export function parseDate(s, opts = {}) {
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
export function inferDateOrder(lines, opts = {}) {
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

/** "21:30", "9:30 PM", "09.30" -> "21:30". Returns null when there is no time. */
export function parseTime(s) {
  const text = String(s || '');
  let m = /\b(\d{1,2})[:.](\d{2})\s*([AaPp])\.?[Mm]\.?\b/.exec(text);
  if (m) {
    let h = +m[1] % 12;
    if (m[3].toLowerCase() === 'p') h += 12;
    return +m[2] < 60 ? `${pad(h)}:${m[2]}` : null;
  }
  m = /\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/.exec(text);
  return m ? `${pad(+m[1])}:${m[2]}` : null;
}

// A booking reference is only accepted next to a label. An unlabelled
// six-character token is far more often a fare class, an aircraft type or a
// terminal than a PNR, and a wrong code printed confidently is worse at a
// check-in desk than a blank field.
const PNR_LABEL = /(booking\s*(reference|ref|code|id)|confirmation\s*(number|code|no\.?|#)?|reservation\s*(number|code|no\.?)?|record\s*locator|\bPNR\b|airline\s*reference)/i;
const PNR_TOKEN = /\b(?=[A-Z0-9]{5,8}\b)(?=.*[A-Z])[A-Z0-9]{5,8}\b/;

export function findConfirmation(lines) {
  for (let i = 0; i < lines.length; i++) {
    if (!PNR_LABEL.test(lines[i])) continue;
    // the code usually sits on the label's line, occasionally on the next one
    for (const j of [i, i + 1]) {
      if (j >= lines.length) continue;
      const after = j === i ? lines[j].replace(PNR_LABEL, ' ') : lines[j];
      const m = PNR_TOKEN.exec(after);
      if (m && !/^(FLIGHT|TICKET|BOOKING|NUMBER|AIRLINE|HOTEL)$/.test(m[0])) {
        return { code: m[0], line: j, raw: lines[j].trim() };
      }
    }
  }
  return null;
}

const CUR_SYMBOL = { '£': 'GBP', '$': 'USD', '€': 'EUR', '¥': 'JPY' };

/** "£1,234.56", "EUR 220.00", "220.00 USD" -> { value, currency }. */
export function parseMoney(s) {
  const text = String(s || '');
  let m = /([£$€¥])\s?([\d,]+(?:\.\d{2})?)/.exec(text);
  if (m) return { value: +m[2].replace(/,/g, ''), currency: CUR_SYMBOL[m[1]] };
  m = /\b([A-Z]{3})\s?([\d,]+(?:\.\d{2})?)\b/.exec(text);
  if (m) return { value: +m[2].replace(/,/g, ''), currency: m[1] };
  m = /\b([\d,]+(?:\.\d{2})?)\s?([A-Z]{3})\b/.exec(text);
  if (m) return { value: +m[1].replace(/,/g, ''), currency: m[2] };
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
]);

/**
 * A separator sitting between two airport codes: "to", an arrow, a slash or a
 * dash. Anchored on non-letters so a hyphen inside a word is not a separator.
 */
const ROUTE_SEP = /(?:^|[^A-Za-z])(?:-->|->|→|>|—|–|-|\/|to)(?:[^A-Za-z]|$)/i;

// How much text may sit between the two codes and still read as one route.
// "(LHR) to New York JFK" is 14 characters of gap; a whole paragraph is not a
// route, it is two codes that happen to share a line.
const ROUTE_GAP_MAX = 40;

function codeIsAirport(code, byIata) {
  return !CODE_STOPWORDS.has(code) && byIata.has(code);
}

/**
 * Finds the origin/destination pair. An EXPLICIT route pattern is trusted;
 * otherwise bare codes are collected in reading order and only used when
 * exactly two survive, because "two codes somewhere on the page" is a much
 * weaker claim than "A to B written as a route".
 */
export function findRoute(lines, byIata) {
  // Pass 1: an explicit route on a single line. Matching is done on the
  // POSITIONS of valid codes rather than on one regex, because the real
  // layouts put text between them: "London Heathrow (LHR) to New York JFK
  // (JFK)" and "London LHR to New York JFK" both defeated an adjacency
  // pattern, and between them they cover most airline confirmations.
  for (let i = 0; i < lines.length; i++) {
    const codes = [...lines[i].matchAll(/\b([A-Z]{3})\b/g)]
      .filter(m => codeIsAirport(m[1], byIata));
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
      if (codeIsAirport(m[1], byIata) && !hits.some(h => h.code === m[1])) {
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

const label = (a, code) => (a ? `${a.city || a.name} (${code})` : code);

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

  // Dates, in document order. The first is the departure date; a second
  // distinct date is only used as the arrival when the times say it lands
  // after midnight.
  const dates = [];
  lines.forEach((ln, i) => {
    const d = parseDate(ln, ctx);
    if (d && !dates.some(x => x.iso === d.iso)) dates.push({ ...d, line: i });
  });
  const dep = dates[0] || null;
  if (dep) {
    // full line, not just the matched substring: provenance is only useful
    // if the traveller can see the context the value came out of
    evidence.push({ field: 'startDate', raw: lines[dep.line].trim(), line: dep.line });
    warnings.push(...dateOrderNotes(dep, ctx));
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

  // Overnight: an explicit "+1" marker, or an arrival clock earlier than the
  // departure clock.
  const plusOne = lines.some(ln => /\+\s?1\b|\bnext day\b/i.test(ln));
  const wrapped = !!(depTime && arrTime && arrTime.t < depTime.t);
  let endDate = '';
  if (dep && (plusOne || wrapped)) {
    const d = new Date(Date.UTC(+dep.iso.slice(0, 4), +dep.iso.slice(5, 7) - 1, +dep.iso.slice(8, 10) + 1));
    endDate = iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
    warnings.push(`Read as an overnight leg landing ${endDate} (${plusOne ? 'a "+1" marker was printed' : 'the arrival time is earlier than the departure time'}).`);
  }

  const flightNo = (() => {
    for (let i = 0; i < lines.length; i++) {
      const m = FLIGHT_NO.exec(lines[i]);
      if (m && !codeIsAirport(m[1] + m[2].slice(0, 1), byIata)) return { code: `${m[1]}${m[2]}`, line: i, raw: lines[i].trim() };
    }
    return null;
  })();
  if (flightNo) evidence.push({ field: 'details', raw: flightNo.raw, line: flightNo.line });

  const pnr = findConfirmation(lines);
  if (pnr) evidence.push({ field: 'confirmation', raw: pnr.raw, line: pnr.line });

  const moneyLine = lines.findIndex(ln => /total|fare|price|amount|paid/i.test(ln) && parseMoney(ln));
  const money = moneyLine >= 0 ? parseMoney(lines[moneyLine]) : null;
  if (money) evidence.push({ field: 'cost', raw: lines[moneyLine].trim(), line: moneyLine });

  const item = {
    type: 'flight',
    title: `${label(from, route.from)} to ${label(to, route.to)}`,
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
  else if (!depTime || (dep && dep.ambiguous)) confidence = 'medium';

  return { kind: 'flight', item, confidence, evidence, warnings };
}

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

  const moneyLine = lines.findIndex(l => /total|amount|price|rate/i.test(l) && parseMoney(l));
  const money = moneyLine >= 0 ? parseMoney(lines[moneyLine]) : null;
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
  };
}

/** Splits to trimmed non-empty lines, preserving original indexing. */
export function toLines(text) {
  return String(text || '').replace(/\r/g, '').split('\n').map(l => l.replace(/\s+/g, ' ').trim());
}

/**
 * Main entry. `airports` is the rows array from airportIndex(); pass [] to run
 * without airport validation (routes will then not be found).
 */
export function extractBookings(text, opts = {}) {
  const lines = toLines(text);
  const byIata = new Map((opts.airports || []).map(a => [a.iata, a]));
  // Ask the document which order it writes dates in before reading any of
  // them; the caller's default is only the fallback when it stays silent.
  const order = inferDateOrder(lines, { dayFirst: opts.dayFirst === true });
  const ctx = { dayFirst: order.dayFirst, orderKnown: order.source === 'document', order };

  const proposals = [];
  const flight = readFlight(lines, byIata, ctx);
  if (flight) proposals.push(flight);
  const stay = readStay(lines, ctx);
  if (stay) proposals.push(stay);

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
