// Trip Planner E2E: the Google Places ratings subsystem.
//
//   P1. fanout on a 50-venue trip: the first screen is served, the other forty
//       venues are NOT billed for before anyone has scrolled to them
//   P2. no duplicate lookups, ever - across renders, view switches and scrolls
//   P3. a view switch is free: Timeline -> Days -> Timeline re-bills nothing
//   P4. travel legs never make a billed call
//   P5. a 429 does not become a request storm, and does not kill the session
//   P6. small trips still get every rating they can
//   P7. a partial response paints what it got
//   P8. switching trips retires the old trip's unsent lookups
//
// Every block mocks /.netlify/functions/tp-places at the network layer and
// counts what the app ACTUALLY put on the wire. The real endpoint is never
// touched: a green run here costs $0.00.
import {
  APP, recorder, freshIds, iso, item, trip, dbOf,
  openApp, tpErrors, switchView, closePage, evaluate, waitForExpr, sleep,
  clickSel, gotoHard, menuAct, setValue,
} from './helpers.mjs';
import { EXTERNAL_HOSTS } from '../../../tests/browser/cdp.mjs';

const PLACES = '/.netlify/functions/tp-places';

// A recording mock of tp-places. `mode` decides what the server says; `log`
// accumulates one entry per POST so a block can assert on the exact fanout.
function placesMock(log, mode = 'ok') {
  let granted = 0;
  return (url, request) => {
    if (!url.includes('tp-places')) return EXTERNAL_HOSTS.test(url) ? 'fail' : null;
    let body = {};
    try { body = JSON.parse(request.postData || '{}'); } catch { /* recorded as empty */ }
    // The queue now posts WIRE REQUESTS - { id, q, city?, country?, lat?, lon? }
    // - because a lookup's area is part of its identity (see placeLookupFor).
    // The log keeps the query TEXT so the assertions below still read in venue
    // names, and `entries` keeps the full shape for the geography checks.
    const entries = (Array.isArray(body.queries) ? body.queries : []).map(toEntry);
    const queries = entries.map(e => e.q);
    log.push({ queries, entries, clientId: body.clientId || '', ownerToken: body.ownerToken || null });

    if (mode === '429') {
      return {
        status: 429,
        body: { error: 'quota_exceeded', scope: 'client_hour', resetAt: Date.now() + 3600000 },
        headers: { 'Retry-After': '3600' },
      };
    }
    const ok = e => ({
      id: e.id, query: e.q, status: 'ok', name: e.q, rating: 4.7, userRatingCount: 1481,
      mapsUri: 'https://maps.google.com/?cid=1', confidence: 1, lat: 35.66, lon: 139.7,
      placeId: 'pid-' + e.id, verified: true, areaBasis: 'point',
    });
    if (mode === 'partial') {
      return {
        status: 200,
        body: {
          results: entries.map((e, i) => (i % 2 === 0 ? ok(e) : { id: e.id, query: e.q, status: 'unavailable', reason: 'quota' })),
          attribution: { text: 'Google Maps', url: 'https://www.google.com/maps' },
        },
      };
    }
    if (mode === 'quota12') {
      // Serves 12 lookups in total, then rejects: the production shape.
      if (granted >= 12) {
        return { status: 429, body: { error: 'quota_exceeded', scope: 'client_hour', resetAt: Date.now() + 3600000 }, headers: { 'Retry-After': '3600' } };
      }
      const room = 12 - granted;
      granted += Math.min(room, entries.length);
      return {
        status: 200,
        body: {
          results: entries.map((e, i) => (i < room ? ok(e) : { id: e.id, query: e.q, status: 'unavailable', reason: 'quota' })),
          attribution: { text: 'Google Maps', url: 'https://www.google.com/maps' },
        },
      };
    }
    return {
      status: 200,
      body: { results: entries.map(ok), attribution: { text: 'Google Maps', url: 'https://www.google.com/maps' } },
    };
  };
}

// A wire entry, in the one shape the mocks reason about. The endpoint still
// accepts bare strings (an old client), so the mocks do too.
function toEntry(raw) {
  if (typeof raw === 'string') return { id: raw, q: raw };
  return { id: (raw && raw.id) || (raw && raw.q) || '', q: (raw && raw.q) || '', ...raw };
}

// Counts are ALWAYS scoped to the block's own venue prefix. The E2E profile is
// shared across blocks, so openApp's first navigation boots the app on whatever
// trip the PREVIOUS block left in localStorage and legitimately looks its
// venues up before the clear-and-seed happens (see the leaked-tab trap in
// FINDINGS). Counting those as this block's requests produced phantom
// "duplicates" that the app never made.
const totals = (log, prefix) => {
  const qs = log.flatMap(e => e.queries).filter(q => q.includes(prefix));
  const uniq = new Set(qs.map(q => q.toLowerCase()));
  const posts = log.filter(e => e.queries.some(q => q.includes(prefix))).length;
  return { posts, queries: qs.length, unique: uniq.size, duplicates: qs.length - uniq.size };
};

// A flat trip of N rating-eligible activities: no stay covers them, so the
// Timeline renders every row ungrouped and nothing is hidden behind a
// collapsed stay. That keeps the fanout numbers about VISIBILITY rather than
// about the grouping rules, which views.mjs already owns.
function venueTrip(n, name, prefix) {
  const items = [];
  for (let i = 0; i < n; i++) {
    items.push(item({
      type: 'activity',
      title: `${prefix} ${String(i + 1).padStart(2, '0')}`,
      location: 'Tokyo',
      startDate: iso(10 + Math.floor(i / 2)),
      startTime: `${String(9 + (i % 8)).padStart(2, '0')}:00`,
    }));
  }
  return trip({ name, items });
}

const paintedCount = (s) => evaluate(s, `document.querySelectorAll('#board .tp-maps-link .tpm-rating').length`);
const slotCount = (s) => evaluate(s, `document.querySelectorAll('#board .tp-maps-link[data-place-key]').length`);
const scrollBoardToEnd = (s) => evaluate(s, `(() => { window.scrollTo(0, document.body.scrollHeight); return window.scrollY; })()`);

export async function run({ base, cdpPort }) {
  const R = [];
  const t = recorder(R);

  const withPage = async (label, opts, fn) => {
    let s = null;
    try {
      s = await openApp(cdpPort, base, opts);
      await fn(s);
      await t(`${label}: no page errors`, tpErrors(s).length === 0, tpErrors(s).slice(0, 2).join(' | '), s);
    } catch (e) {
      await t(`${label}: block ran`, false, String(e && e.message).slice(0, 140), s);
    } finally {
      if (s) try { await closePage(cdpPort, s); } catch { /* gone */ }
    }
  };

  /* ------- P1. a 50-venue trip does not bill for what nobody has seen ------ */
  freshIds();
  {
    const log = [];
    const P1 = 'AlphaVenue';
    const big = venueTrip(50, 'Fanout trip', P1);
    await withPage('tp-places P1', { db: dbOf([big]), net: placesMock(log, 'ok') }, async (s) => {
      await waitForExpr(s, `document.querySelectorAll('#board .tp-maps-link[data-place-key]').length >= 50`, { timeout: 12000 });
      await sleep(2500);
      const first = totals(log, P1);

      await t('tp-places P1: all 50 venues render a rating slot',
        (await slotCount(s)) === 50, String(await slotCount(s)), s);
      await t('tp-places P1: the first screen does NOT bill all 50 venues',
        first.queries > 0 && first.queries < 50, JSON.stringify(first), s);
      await t('tp-places P1: and it does not burst a POST per batch of the whole trip',
        first.posts <= 2, JSON.stringify(first), s);
      await t('tp-places P1: the venues it did ask for came back painted',
        (await paintedCount(s)) === first.unique, `painted ${await paintedCount(s)} of ${first.unique}`, s);

      // Scrolling is what buys the rest, and it must still be duplicate-free.
      await scrollBoardToEnd(s);
      await sleep(2500);
      const after = totals(log, P1);
      await t('tp-places P1: scrolling fetches the venues that came into view',
        after.queries > first.queries, `${first.queries} -> ${after.queries}`, s);
      await t('tp-places P1: and never asks for a venue twice',
        after.duplicates === 0, JSON.stringify(after), s);
      await t('tp-places P1: every batch respects the server cap of 12',
        log.every(e => e.queries.length <= 12), JSON.stringify(log.map(e => e.queries.length)), s);
    });
  }

  /* --------- P2/P3. re-renders and view switches re-bill nothing ---------- */
  freshIds();
  {
    const log = [];
    const P3 = 'BravoVenue';
    const mid = venueTrip(8, 'Switch trip', P3);
    await withPage('tp-places P3', { db: dbOf([mid]), net: placesMock(log, 'ok') }, async (s) => {
      await waitForExpr(s, `document.querySelectorAll('#board .tp-maps-link .tpm-rating').length >= 8`, { timeout: 12000 });
      const settled = totals(log, P3);
      await t('tp-places P3: a small trip gets every rating it can',
        (await paintedCount(s)) === 8, String(await paintedCount(s)), s);

      await switchView(s, 'days');
      await sleep(1500);
      await switchView(s, 'timeline');
      await sleep(1500);
      await switchView(s, 'days');
      await sleep(1500);
      const after = totals(log, P3);
      await t('tp-places P3: Timeline -> Days -> Timeline -> Days bills nothing new',
        after.queries === settled.queries,
        `${settled.queries} before, ${after.queries} after`, s);
      await t('tp-places P3: and the Days view paints from the same session cache',
        (await evaluate(s, `document.querySelectorAll('#daysList .tp-maps-link .tpm-rating').length`)) > 0, '', s);
      await t('tp-places P2: no duplicate query survived the whole sequence',
        after.duplicates === 0, JSON.stringify(after), s);
    });
  }

  /* --------------- P4. a travel leg never buys a Places call -------------- */
  freshIds();
  {
    const log = [];
    const legs = trip({
      name: 'Legs trip',
      items: [
        item({ type: 'flight', title: 'Tokyo to Osaka flight', location: 'Osaka', mapsQuery: 'LEGQUERY Haneda Airport', startDate: iso(10), startTime: '08:00' }),
        item({ type: 'transport', title: 'Shinkansen to Kyoto', location: 'Kyoto', mapsQuery: 'LEGQUERY Kyoto Station', startDate: iso(11), startTime: '09:00' }),
        item({ type: 'local', title: 'Return to hotel', location: 'Kyoto', mapsQuery: 'LEGQUERY Kyoto Grand Hotel', startDate: iso(11), startTime: '22:00' }),
        item({ type: 'activity', title: 'Fushimi Inari Shrine', location: 'Kyoto', startDate: iso(11), startTime: '10:00' }),
      ],
    });
    await withPage('tp-places P4', { db: dbOf([legs]), net: placesMock(log, 'ok') }, async (s) => {
      await sleep(2500);
      const asked = log.flatMap(e => e.queries).filter(q => /LEGQUERY|Fushimi/.test(q)).join(' | ');
      await t('tp-places P4: no travel leg was ever sent to Places',
        !/LEGQUERY/.test(asked), asked.slice(0, 200), s);
      await t('tp-places P4: the ordinary place on the same day still was',
        /Fushimi Inari/i.test(asked), asked.slice(0, 200), s);
      await t('tp-places P4: a leg renders Directions, never a rating slot',
        (await evaluate(s, `document.querySelectorAll('#board .tp-dir-link[data-place-key]').length`)) === 0, '', s);
    });
  }

  /* ------------- P5. a 429 does not storm and does not stick ------------- */
  freshIds();
  {
    const log = [];
    const P5 = 'DeltaVenue';
    const big = venueTrip(40, 'Quota trip', P5);
    await withPage('tp-places P5', { db: dbOf([big]), net: placesMock(log, '429') }, async (s) => {
      await sleep(2000);
      const early = totals(log, P5).posts;
      // Re-render hard: view switches, scrolling, more renders. None of it may
      // turn a parked quota into a request per repaint.
      await switchView(s, 'days');
      await sleep(800);
      await switchView(s, 'timeline');
      await sleep(800);
      await scrollBoardToEnd(s);
      await sleep(800);
      await evaluate(s, `window.scrollTo(0, 0)`);
      await sleep(3000);
      await t('tp-places P5: a 429 parks the queue instead of retrying per render',
        totals(log, P5).posts <= Math.max(2, early), `${early} early, ${totals(log, P5).posts} after a repaint storm`, s);
      await t('tp-places P5: the app still renders normally with no ratings',
        (await slotCount(s)) === 40 && (await paintedCount(s)) === 0, '', s);
      await t('tp-places P5: no error badge is painted onto any row',
        (await evaluate(s, `document.querySelectorAll('#board .tpm-rating').length`)) === 0, '', s);
    });
  }

  /* ---- P5b. the month's free allowance is gone: still a usable app ------- */
  freshIds();
  {
    const log = [];
    const P5b = 'MonthVenue';
    const t5b = venueTrip(12, 'Exhausted trip', P5b);
    // scope free_month is the shared monthly budget, the one that protects the
    // card. Nothing frees up until the billing month turns, so the app must
    // degrade for the whole session without looking broken.
    const net = (url, request) => {
      if (!url.includes('tp-places')) return EXTERNAL_HOSTS.test(url) ? 'fail' : null;
      let body = {}; try { body = JSON.parse(request.postData || '{}'); } catch { /* empty */ }
      log.push({ queries: (body.queries || []).map(q => toEntry(q).q), clientId: body.clientId || '', ownerToken: body.ownerToken || null });
      return {
        status: 429,
        body: { error: 'quota_exceeded', scope: 'free_month', resetAt: Date.now() + 14 * 86400000 },
        headers: { 'Retry-After': String(14 * 86400) },
      };
    };
    await withPage('tp-places P5b', { db: dbOf([t5b]), net }, async (s) => {
      await sleep(2500);
      const asked = totals(log, P5b).posts;
      await t('tp-places P5b: every row still renders its Maps link',
        (await slotCount(s)) === 12, String(await slotCount(s)), s);
      await t('tp-places P5b: no rating is painted and no error badge appears',
        (await paintedCount(s)) === 0 && (await evaluate(s, `document.querySelectorAll('#board .tpm-rating').length`)) === 0, '', s);
      await t('tp-places P5b: the Maps links still open a real search',
        (await evaluate(s, `[...document.querySelectorAll('#board .tp-maps-link[data-place-key]')].every(a => /^https:\\/\\/www\\.google\\.com\\/maps\\/search/.test(a.getAttribute('href')))`)) === true, '', s);

      // The app itself must stay fully usable.
      await switchView(s, 'days');
      await sleep(1000);
      await t('tp-places P5b: Days view still renders',
        (await evaluate(s, `document.querySelectorAll('#daysList .dc-event').length`)) > 0, '', s);
      await switchView(s, 'timeline');
      await sleep(1000);
      await scrollBoardToEnd(s);
      await sleep(2000);
      await t('tp-places P5b: scrolling does not re-ask a month that cannot refill',
        totals(log, P5b).posts <= Math.max(2, asked),
        `${asked} before, ${totals(log, P5b).posts} after scrolling the whole trip`, s);
      await t('tp-places P5b: the traveller is told once, not per row',
        (await evaluate(s, `[...document.querySelectorAll('#toasts .toast')].filter(x => /allowance/i.test(x.textContent)).length`)) <= 1, '', s);
    });
  }

  /* ------------- P6/P7. partial results paint what they got --------------- */
  freshIds();
  {
    const log = [];
    const P7 = 'EchoVenue';
    const mid = venueTrip(6, 'Partial trip', P7);
    await withPage('tp-places P7', { db: dbOf([mid]), net: placesMock(log, 'partial') }, async (s) => {
      await sleep(3000);
      const painted = await paintedCount(s);
      await t('tp-places P7: the venues that resolved are shown',
        painted > 0 && painted < 6, `${painted} of 6`, s);
      await t('tp-places P7: the ones that did not are plain links, not errors',
        (await evaluate(s, `document.querySelectorAll('#board .tp-maps-link[data-place-key]').length`)) === 6, '', s);
      // An unavailable venue must not be re-asked by the next repaint.
      const before = totals(log, P7).queries;
      await switchView(s, 'days');
      await sleep(800);
      await switchView(s, 'timeline');
      await sleep(1500);
      await t('tp-places P7: an unavailable venue is not re-billed on the next render',
        totals(log, P7).queries === before, `${before} -> ${totals(log, P7).queries}`, s);
    });
  }

  /* ---------- P8. switching trips retires the old trip's queue ------------ */
  freshIds();
  {
    const log = [];
    const P8 = 'FoxtrotVenue';
    const a = venueTrip(30, 'Trip A', P8);
    const b = venueTrip(4, 'Trip B', 'GolfVenue');
    b.items.forEach((it) => { it.location = 'Barcelona'; });
    await withPage('tp-places P8', { db: dbOf([a, b], a.id), net: placesMock(log, 'ok') }, async (s) => {
      await sleep(1200);
      await evaluate(s, `(() => { const sel = document.getElementById('tripSelect'); sel.value = ${JSON.stringify(b.id)}; sel.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()`);
      await sleep(3000);
      const asked = log.flatMap(e => e.queries);
      await t('tp-places P8: trip B\'s venues are looked up after the switch',
        asked.some(q => /GolfVenue/.test(q)), '', s);
      await t('tp-places P8: no duplicate survived the switch',
        totals(log, P8).duplicates === 0 && totals(log, 'GolfVenue').duplicates === 0,
        JSON.stringify({ a: totals(log, P8), b: totals(log, 'GolfVenue') }), s);
      await t('tp-places P8: a result can only ever paint the venue it names',
        (await evaluate(s, `[...document.querySelectorAll('#board .tp-maps-link[data-place-key]')].every(el => el.dataset.placeKey.includes('golfvenue'))`)) === true,
        '', s);
    });
  }

  /* ------------- P10. opening hours on the Days view ----------------------
     The hours ride the same mocked response the ratings do, so this block
     spends nothing extra by construction. Pins: the closed state at the
     scheduled time (the screenshot's shape, on the itinerary side), an
     ordinary split-hours line, unknown hours staying SILENT, no hours UI on
     a travel leg, and the line flipping with the 12/24-hour preference. */
  freshIds();
  {
    const day7 = (o, c) => [0, 1, 2, 3, 4, 5, 6].map(d => ({ open: { day: d, min: o }, close: { day: d, min: c } }));
    const P10_HOURS = {
      'P10 Grid Bar Tokyo': { always: false, periods: day7(16 * 60, 23 * 60), special: [] },
      'P10 Cafe Tokyo': { always: false, periods: [...day7(11 * 60, 14 * 60), ...day7(17 * 60, 23 * 60)], special: [] },
      // 'P10 Mystery Deck Tokyo' deliberately absent: rated, hours unknown
    };
    const hoursMock = (url, request) => {
      if (!url.includes('tp-places')) return EXTERNAL_HOSTS.test(url) ? 'fail' : null;
      let body = {};
      try { body = JSON.parse(request.postData || '{}'); } catch { /* fine */ }
      const entries = (Array.isArray(body.queries) ? body.queries : []).map(toEntry);
      return { status: 200, body: { results: entries.map((e, i) => ({
        id: e.id, query: e.q, status: 'ok', name: e.q, rating: 4.3, userRatingCount: 40 + i,
        mapsUri: 'https://maps.google.com/?cid=' + i,
        placeId: 'pid-' + e.id, verified: true, areaBasis: 'point',
        ...(P10_HOURS[e.q] ? { hours: P10_HOURS[e.q] } : {}),
      })), attribution: { text: 'Google Maps', url: 'https://www.google.com/maps' } } };
    };
    const hoursTrip = trip({ name: 'Hours trip', items: [
      item({ type: 'activity', title: 'Drinks: P10 Grid Bar', location: 'Tokyo', startDate: iso(12), startTime: '23:00' }),
      item({ type: 'activity', title: 'Lunch: P10 Cafe', location: 'Tokyo', startDate: iso(12), startTime: '12:00' }),
      item({ type: 'activity', title: 'P10 Mystery Deck', location: 'Tokyo', startDate: iso(12), startTime: '18:00' }),
      item({ type: 'flight', title: 'Tokyo (HND) to Osaka (ITM)', startDate: iso(12), startTime: '08:00' }),
    ] });
    await withPage('tp-places P10', { db: dbOf([hoursTrip]), net: hoursMock }, async (s) => {
      await switchView(s, 'days');
      const painted = await waitForExpr(s, `!!document.querySelector('#daysList .dc-hours.is-closed')`, { timeout: 8000 });
      const rows = () => evaluate(s, `[...document.querySelectorAll('#daysList .dc-event')].map(r => ({
        title: (r.querySelector('.dc-title') || {}).textContent || '',
        travel: r.classList.contains('is-travel'),
        slots: r.querySelectorAll('.dc-hours').length,
        hours: ((r.querySelector('.dc-hours') || {}).textContent || '').trim(),
        closed: !!r.querySelector('.dc-hours.is-closed'),
      }))`);
      let got = await rows();
      const row = (n) => got.find(r => r.title.includes(n)) || {};
      await t('tp-places P10: a 23:00 row at a 23:00-closing bar reads closed, with the verified hours',
        painted && row('Grid Bar').closed === true && row('Grid Bar').hours === 'Closed at 11:00 PM · Hours: 4:00 PM–11:00 PM',
        JSON.stringify(row('Grid Bar')), s);
      await t('tp-places P10: an open row carries a compact split-hours line for its own day',
        row('Cafe').closed === false && row('Cafe').hours === 'Hours · 11:00 AM–2:00 PM, 5:00 PM–11:00 PM',
        JSON.stringify(row('Cafe')), s);
      await t('tp-places P10: unknown hours stay silent - a rated venue with no hours paints nothing',
        row('Mystery').slots === 1 && row('Mystery').hours === '', JSON.stringify(row('Mystery')), s);
      await t('tp-places P10: a travel leg gets no hours UI',
        got.filter(r => r.travel).every(r => r.slots === 0) && got.some(r => r.travel), JSON.stringify(got.filter(r => r.travel)), s);
      // The 12/24-hour preference is the ONE formatter these lines go through:
      // flipping it re-renders every chip in 24-hour form.
      await menuAct(s, 'timefmt');
      const flipped = await waitForExpr(s,
        `((document.querySelector('#daysList .dc-hours.is-closed') || {}).textContent || '').includes('16:00–23:00')`,
        { timeout: 8000 });
      got = await rows();
      await t('tp-places P10: the hours line follows the 24-hour preference',
        flipped && row('Grid Bar').hours === 'Closed at 23:00 · Hours: 16:00–23:00'
          && row('Cafe').hours === 'Hours · 11:00–14:00, 17:00–23:00',
        JSON.stringify({ grid: row('Grid Bar'), cafe: row('Cafe') }), s);
    });
  }

  /* ------------- P9. the request body still carries what it must ---------- */
  freshIds();
  {
    const log = [];
    const P9 = 'HotelVenue';
    const small = venueTrip(3, 'Body trip', P9);
    await withPage('tp-places P9', { db: dbOf([small]), net: placesMock(log, 'ok') }, async (s) => {
      await sleep(2500);
      const mine = log.filter(e => e.queries.some(q => q.includes(P9)));
      await t('tp-places P9: every request carries a stable clientId',
        mine.length > 0 && mine.every(e => e.clientId && e.clientId === mine[0].clientId),
        JSON.stringify(mine.map(e => e.clientId)), s);
      await t('tp-places P9: an ordinary visitor sends no owner token',
        mine.every(e => e.ownerToken === null), '', s);
    });
  }

  /* ------------- P11. THE 2026-08-27 ROUND: one verified place identity -----
     The report: "Shopping: Royce' Chocolate (Tokyo Station)" resolved to the
     chain's Hokkaido flagship, so the card wore its rating, its Maps link and
     a 809 km distance chip; a second card said "No rating match" while the
     agenda row for the SAME recommendation showed a rating; and every title
     carried an invented "Shopping: " category.

     This block drives the whole path - reply -> card -> Add to trip -> row -
     against a server double that behaves the way the fixed endpoint does:
     it rejects a candidate whose area does not match, and it echoes back the
     client's own key so nothing can be re-keyed onto another card. */
  freshIds();
  {
    const day = iso(20);
    const day2 = iso(21);   // the Kyoto shop is a DIFFERENT day: one day holding
                           // both cities is a legitimately 350 km chain
    // Two shops with the SAME chain name in two different cities: exactly the
    // case a name-only identity cannot tell apart.
    const P11_REPLY = `Three chocolate stops.

\`\`\`json
{"tripActions":[
 {"op":"add","item":{"type":"activity","title":"Shopping: P11 Chain Chocolate (Tokyo Station)","location":"Tokyo","startDate":"${day}","startTime":"14:00","mapsQuery":"P11 Chain Chocolate Tokyo Station"}},
 {"op":"add","item":{"type":"activity","title":"Shopping: P11 Chain Chocolate (Kyoto)","location":"Kyoto","startDate":"${day2}","startTime":"16:00","mapsQuery":"P11 Chain Chocolate Kyoto"}},
 {"op":"add","item":{"type":"activity","title":"Snack: P11 Unfindable Sweets","location":"Tokyo","startDate":"${day}","startTime":"17:00","mapsQuery":"P11 Unfindable Sweets Tokyo"}}
]}
\`\`\``;

    // The server double. `P11 Unfindable Sweets Tokyo` is the recommendation
    // whose only candidate sits in the wrong region: the fixed endpoint answers
    // no_match/wrong_area rather than handing over a rating and a coordinate.
    const p11log = [];
    const p11Net = (url, request) => {
      if (!url.includes('tp-places')) return EXTERNAL_HOSTS.test(url) ? 'fail' : null;
      let body = {};
      try { body = JSON.parse(request.postData || '{}'); } catch { /* recorded empty */ }
      const entries = (body.queries || []).map(toEntry);
      p11log.push(entries);
      const results = entries.map((e) => {
        if (/Unfindable/.test(e.q)) return { id: e.id, query: e.q, status: 'no_match', reason: 'wrong_area' };
        const kyoto = /Kyoto/i.test(e.city || e.q);
        return {
          id: e.id, query: e.q, status: 'ok', name: e.q,
          rating: kyoto ? 4.2 : 4.6, userRatingCount: kyoto ? 512 : 1290,
          mapsUri: 'https://maps.google.com/?cid=' + (kyoto ? '2' : '1'),
          placeId: kyoto ? 'PID_KYOTO' : 'PID_TOKYO',
          verified: true, areaBasis: 'point', confidence: 0.95,
          // Distinct points on purpose: Tsukiji and the Tokyo shop landing on
          // the SAME coordinate would be a zero-length hop, which sameSpot
          // suppresses - and a missing chip would read as a distance bug.
          lat: kyoto ? 35.0 : (/Tsukiji/.test(e.q) ? 35.6654 : 35.6812),
          lon: kyoto ? 135.768 : (/Tsukiji/.test(e.q) ? 139.7707 : 139.7671),
        };
      });
      return { status: 200, body: { results, attribution: { text: 'Google Maps', url: 'https://www.google.com/maps' } } };
    };

    const p11Trip = trip({
      name: 'P11 chocolate',
      items: [
        item({ type: 'activity', title: 'Tsukiji Outer Market', location: 'Tokyo', startDate: day, startTime: '09:00', mapsQuery: 'Tsukiji Outer Market Tokyo' }),
      ],
    });
    const p11Stores = {
      'trip-planner:geo:v3': {
        tokyo: { lat: 35.6812, lon: 139.7671, country: 'Japan', conf: 'confident' },
        kyoto: { lat: 35.0116, lon: 135.7681, country: 'Japan', conf: 'confident' },
      },
    };

    await withPage('tp-places P11', { db: dbOf([p11Trip]), stores: p11Stores, net: p11Net }, async (s) => {
      await clickSel(s, '#assistBtn');
      await waitForExpr(s, `!!document.querySelector('#assistTierGroup')`, { timeout: 6000 });
      await evaluate(s, `(()=>{const r=document.querySelector('#assistTierGroup input[value="copy"]');
        if (r && !r.checked) r.click(); return 1})()`);
      await waitForExpr(s, `!!document.querySelector('#assistPasteBox')`, { timeout: 6000 });
      await setValue(s, '#assistPasteBox', P11_REPLY);
      await clickSel(s, '#assistPasteParse', { settle: 500 });
      await waitForExpr(s, `document.querySelectorAll('#assistMessages .assist-proposal').length === 3`, { timeout: 8000 });
      await waitForExpr(s, `document.querySelectorAll('#assistMessages .ap-rating[data-painted="1"]').length >= 3`, { timeout: 8000 });

      const cards = () => evaluate(s, `[...document.querySelectorAll('#assistMessages .assist-proposal')].map(c => {
        const r = c.querySelector('.ap-rating');
        const link = c.querySelector('.assist-maps-link');
        return {
          title: (c.querySelector('.ap-title') || {}).textContent || '',
          key: (r && r.dataset.placeKey) || '',
          area: (r && r.dataset.placeArea) || '',
          rating: r ? (r.querySelector('.apr-score') || {}).textContent || '' : '',
          none: !!(r && r.querySelector('.apr-none')),
          href: link ? link.getAttribute('href') : '',
          label: link ? link.textContent.trim() : '',
          dist: ((c.querySelector('.ap-dist') || {}).textContent || '').trim(),
        };
      })`);
      const got = await cards();
      const tokyoCard = got.find(c => /Tokyo Station/.test(c.title));
      const kyotoCard = got.find(c => /Kyoto/.test(c.title));
      const badCard = got.find(c => /Unfindable/.test(c.title));

      /* --- the invented category prefix --- */
      await t('tp-places P11: an invented "Shopping:" prefix never reaches a card title',
        got.every(c => !/^Shopping:/i.test(c.title))
          && tokyoCard.title === 'P11 Chain Chocolate (Tokyo Station)',
        JSON.stringify(got.map(c => c.title)), s);

      /* --- two cities, two identities --- */
      await t('tp-places P11: the same chain name in two cities gets two distinct place keys',
        !!tokyoCard.key && !!kyotoCard.key && tokyoCard.key !== kyotoCard.key,
        JSON.stringify([tokyoCard.key, kyotoCard.key]), s);
      await t('tp-places P11: each lookup puts its own city on the wire',
        p11log.flat().some(e => e.city === 'Tokyo') && p11log.flat().some(e => e.city === 'Kyoto'),
        JSON.stringify(p11log.flat().map(e => ({ q: e.q, city: e.city }))), s);
      await t('tp-places P11: each card shows its OWN city\'s rating, not the other\'s',
        tokyoCard.rating === '4.6' && kyotoCard.rating === '4.2',
        JSON.stringify([tokyoCard.rating, kyotoCard.rating]), s);

      /* --- a wrong-area candidate is refused everything --- */
      await t('tp-places P11: a wrong-area candidate gets no rating',
        badCard.none === true && badCard.rating === '', JSON.stringify(badCard), s);
      await t('tp-places P11: a wrong-area candidate gets no distance chip',
        badCard.dist === '', JSON.stringify(badCard), s);
      await t('tp-places P11: a wrong-area candidate keeps a SEARCH link, never a place link',
        /\/maps\/search\/\?api=1/.test(badCard.href) && /Verify/.test(badCard.label),
        JSON.stringify(badCard), s);

      /* --- a verified place is opened, not "verified" --- */
      await t('tp-places P11: a verified card links at the place ID and stops saying "Verify"',
        [tokyoCard, kyotoCard].every(c => /place_id:PID_/.test(c.href) && /Open on/.test(c.label)),
        JSON.stringify([tokyoCard, kyotoCard].map(c => [c.href, c.label])), s);

      /* --- the distance is an intra-city figure, not a cross-country one --- */
      await t('tp-places P11: a verified same-city candidate measures a sane intra-city distance',
        /km|mi/.test(tokyoCard.dist) && !/\b[1-9]\d{2,}\s*(km|mi)/.test(tokyoCard.dist),
        JSON.stringify(tokyoCard.dist), s);

      /* --- ADD TO TRIP: the row is the SAME place, with no second lookup --- */
      const postsBefore = p11log.length;
      for (let i = 0; i < 2; i++) {
        await evaluate(s, `(()=>{
          const card = [...document.querySelectorAll('#assistMessages .assist-proposal')]
            .find(c => !c.classList.contains('done') && /P11 Chain/.test(c.textContent));
          const b = card && card.querySelector('.assist-accept');
          if (b) b.click();
          return !!b;
        })()`);
        await sleep(900);
      }

      const saved = await evaluate(s, `(()=>{
        const db = JSON.parse(localStorage.getItem('trip-planner:v1')||'null');
        return db.trips[0].items.filter(i => /P11 Chain/.test(i.title)).map(i => ({
          title: i.title, meal: i.meal || '', location: i.location, place: i.place || null,
        }));
      })()`);
      await t('tp-places P11: the accepted item stores the clean name, no invented category in the title',
        saved.length === 2 && saved.every(i => !/^Shopping:/i.test(i.title)),
        JSON.stringify(saved.map(i => i.title)), s);
      await t('tp-places P11: Add to trip PERSISTS the canonical place identity the card resolved',
        saved.length === 2 && saved.every(i => i.place && /^PID_/.test(i.place.id)),
        JSON.stringify(saved.map(i => i.place)), s);
      await t('tp-places P11: each saved item keeps its OWN city\'s place, never the other\'s',
        (saved.find(i => /Tokyo/.test(i.location)) || {}).place?.id === 'PID_TOKYO'
          && (saved.find(i => /Kyoto/.test(i.location)) || {}).place?.id === 'PID_KYOTO',
        JSON.stringify(saved.map(i => [i.location, i.place && i.place.id])), s);

      await switchView(s, 'days');
      await waitForExpr(s, `document.querySelectorAll('#daysList .tp-maps-link .tpm-rating').length >= 2`, { timeout: 8000 });
      const rows = await evaluate(s, `[...document.querySelectorAll('#daysList .dc-event')]
        .filter(r => /P11 Chain/.test(r.textContent))
        .map(r => {
          const a = r.querySelector('.tp-maps-link');
          const chip = r.querySelector('.dc-dist');
          return {
            title: (r.querySelector('.dc-title') || {}).textContent || '',
            key: a ? a.dataset.placeKey || '' : '',
            href: a ? a.getAttribute('href') : '',
            rating: ((r.querySelector('.tpm-score') || {}).textContent || ''),
            dist: chip ? chip.textContent.trim() : '',
          };
        })`);
      await t('tp-places P11: the agenda row and the card share ONE place key',
        rows.length === 2 && rows.some(r => r.key === tokyoCard.key) && rows.some(r => r.key === kyotoCard.key),
        JSON.stringify({ rows: rows.map(r => r.key), cards: [tokyoCard.key, kyotoCard.key] }), s);
      await t('tp-places P11: the agenda shows the SAME rating the card did',
        rows.length === 2 && rows.some(r => r.rating === '4.6') && rows.some(r => r.rating === '4.2'),
        JSON.stringify(rows.map(r => r.rating)), s);
      await t('tp-places P11: the agenda links at the same resolved entity',
        rows.every(r => /place_id:PID_/.test(r.href)), JSON.stringify(rows.map(r => r.href)), s);
      await t('tp-places P11: Add to trip triggers NO second, independent resolution',
        p11log.length === postsBefore,
        `${postsBefore} posts before, ${p11log.length} after`, s);
      await t('tp-places P11: the agenda distance is intra-city, not a cross-country figure',
        rows.every(r => !/\b[1-9]\d{2,}\s*(km|mi)/.test(r.dist)), JSON.stringify(rows.map(r => r.dist)), s);
    });
  }

  /* ------------- P12. the edit modal opens without hunting for a venue -----
     Reported alongside the round above: opening "Edit item" on a saved venue
     focused the venue field, which is a place combobox, so the autocomplete
     opened over the form under a name nobody was editing. */
  freshIds();
  {
    const p12Trip = trip({
      name: 'P12 edit',
      items: [item({ type: 'activity', title: 'Gyukatsu Motomura Shibuya', location: 'Tokyo', startDate: iso(12), startTime: '19:00' })],
    });
    // Photon answers, so a search that DID fire would visibly open a dropdown.
    const p12Net = (url) => {
      if (/photon\.komoot\.io/i.test(url)) {
        return { status: 200, body: { features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [139.7, 35.66] },
          properties: { name: 'Gyukatsu Motomura Shibuya', city: 'Tokyo', country: 'Japan', osm_key: 'amenity', osm_value: 'restaurant' } }] } };
      }
      if (/tp-places/.test(url)) return { status: 200, body: { results: [] } };
      return EXTERNAL_HOSTS.test(url) ? 'fail' : null;
    };
    await withPage('tp-places P12', { db: dbOf([p12Trip]), net: p12Net }, async (s) => {
      await clickSel(s, '#board .row-btn[data-act="edit"], #board [data-act="edit"]', { settle: 700 });
      await waitForExpr(s, `document.querySelector('#itemOverlay').classList.contains('open')`, { timeout: 6000 });
      // Long enough for the combobox debounce (320ms) plus its fetch to land,
      // so "nothing opened" means nothing opened rather than "not yet".
      await sleep(900);
      const opened = await evaluate(s, `(()=>{
        const t = document.querySelector('#inTitle');
        return {
          value: t.value,
          focused: document.activeElement === t,
          activeInModal: !!(document.activeElement && document.activeElement.closest('#itemOverlay')),
          activeIsModal: !!(document.activeElement && document.activeElement.classList.contains('modal')),
          popOpen: [...document.querySelectorAll('.cb-pop')].some(p => !p.hidden),
          expanded: t.getAttribute('aria-expanded'),
        };
      })()`);
      await t('tp-places P12: editing an existing item does NOT focus the venue field',
        opened.value === 'Gyukatsu Motomura Shibuya' && opened.focused === false, JSON.stringify(opened), s);
      await t('tp-places P12: and the place autocomplete does not open by itself',
        opened.popOpen === false && opened.expanded === 'false', JSON.stringify(opened), s);
      await t('tp-places P12: focus stays inside the dialog, so the Tab trap still works',
        opened.activeInModal === true && opened.activeIsModal === true, JSON.stringify(opened), s);

      // ...and a DELIBERATE focus still behaves exactly as it always did.
      await clickSel(s, '#inTitle', { settle: 900 });
      const afterClick = await evaluate(s, `(()=>{
        const t = document.querySelector('#inTitle');
        return { focused: document.activeElement === t, popOpen: [...document.querySelectorAll('.cb-pop')].some(p => !p.hidden) };
      })()`);
      await t('tp-places P12: clicking into the venue field still opens the autocomplete',
        afterClick.focused === true && afterClick.popOpen === true, JSON.stringify(afterClick), s);
    });
  }

  /* ------------- P13. an unrelated edit keeps the resolved place ----------- */
  freshIds();
  {
    const p13Day = iso(14);
    const p13Trip = trip({
      name: 'P13 keep place',
      items: [item({
        type: 'activity', title: 'P13 Resolved Venue', location: 'Tokyo',
        startDate: p13Day, startTime: '19:00',
        place: { id: 'PID_KEEPME', at: Date.now(), lat: 35.681, lon: 139.767, city: 'Tokyo' },
      })],
    });
    const p13Stores = { 'trip-planner:geo:v3': { tokyo: { lat: 35.6812, lon: 139.7671, country: 'Japan', conf: 'confident' } } };
    await withPage('tp-places P13', { db: dbOf([p13Trip]), stores: p13Stores, net: placesMock([], 'ok') }, async (s) => {
      const before = await evaluate(s, `(JSON.parse(localStorage.getItem('trip-planner:v1')).trips[0].items[0].place || {}).id || ''`);
      await t('tp-places P13: a saved place record survives the repair pass on boot', before === 'PID_KEEPME', before, s);
      await clickSel(s, '#board .row-btn[data-act="edit"], #board [data-act="edit"]', { settle: 700 });
      await waitForExpr(s, `document.querySelector('#itemOverlay').classList.contains('open')`, { timeout: 6000 });
      await setValue(s, '#inTime', '20:30');
      await clickSel(s, '#itemSaveBtn', { settle: 800 });
      const after = await evaluate(s, `(()=>{
        const it = JSON.parse(localStorage.getItem('trip-planner:v1')).trips[0].items[0];
        return { time: it.startTime, place: it.place || null };
      })()`);
      await t('tp-places P13: changing the time keeps the resolved place exactly as it was',
        after.time === '20:30' && after.place && after.place.id === 'PID_KEEPME' && after.place.lat === 35.681,
        JSON.stringify(after), s);

      // Renaming the venue is a different place, so the old identity must go
      // rather than follow a name it was never resolved for.
      await clickSel(s, '#board .row-btn[data-act="edit"], #board [data-act="edit"]', { settle: 700 });
      await waitForExpr(s, `document.querySelector('#itemOverlay').classList.contains('open')`, { timeout: 6000 });
      await setValue(s, '#inTitle', 'P13 Somewhere Else');
      await setValue(s, '#inLocation', 'Tokyo');
      await clickSel(s, '#itemSaveBtn', { settle: 800 });
      const renamed = await evaluate(s, `(()=>{
        const it = JSON.parse(localStorage.getItem('trip-planner:v1')).trips[0].items[0];
        return { title: it.title, place: it.place || null };
      })()`);
      await t('tp-places P13: renaming the venue drops the old place rather than moving it',
        renamed.title === 'P13 Somewhere Else' && !renamed.place, JSON.stringify(renamed), s);
    });
  }

  /* ------------- P14. DISCOVERY: only verified places reach the answer ------
     "Find me 3 good places..." must not spend one of the three on a venue the
     model invented. The failed candidate is rejected, replaced from the
     provider, and the PROSE is rebuilt so it cannot recommend a place whose
     card is missing. */
  freshIds();
  {
    const day = iso(24);
    const P14_REPLY = `Here are three excellent options for nama chocolate.

- P14 Invented Atelier at Tokyo Station is a must-visit.
- P14 Real Theobroma in Shibuya is superb.
- P14 Real Marcolini in Ginza has a beautiful selection.

Enjoy!

\`\`\`json
{"tripActions":[
 {"op":"add","discovery":{"query":"nama chocolate","count":3},"item":{"type":"activity","title":"P14 Invented Atelier","location":"Tokyo","startDate":"${day}","startTime":"14:00","mapsQuery":"P14 Invented Atelier Tokyo Station"}},
 {"op":"add","item":{"type":"activity","title":"P14 Real Theobroma","location":"Tokyo","startDate":"${day}","startTime":"15:00","mapsQuery":"P14 Real Theobroma Shibuya"}},
 {"op":"add","item":{"type":"activity","title":"P14 Real Marcolini","location":"Tokyo","startDate":"${day}","startTime":"16:00","mapsQuery":"P14 Real Marcolini Ginza"}}
]}
\`\`\``;

    // The endpoint double: named lookups resolve the two real venues and
    // REFUSE the invented one; a discovery request answers with a replacement.
    const p14log = [];
    const p14Net = (url, request) => {
      if (!url.includes('tp-places')) return EXTERNAL_HOSTS.test(url) ? 'fail' : null;
      let body = {};
      try { body = JSON.parse(request.postData || '{}'); } catch { /* empty */ }
      if (body.discover) {
        p14log.push({ kind: 'discover', q: body.discover.q, exclude: body.discover.exclude || [] });
        return { status: 200, body: { discovered: true, attribution: { text: 'Google Maps', url: 'https://www.google.com/maps' },
          results: [{
            id: 'disc-1', query: body.discover.q, status: 'ok', name: 'P14 Replacement Cacao',
            rating: 4.6, userRatingCount: 900, mapsUri: 'https://maps.google.com/?cid=77',
            placeId: 'PID_REPLACEMENT', verified: true, areaBasis: 'point', confidence: 1,
            lat: 35.669, lon: 139.765,
          }] } };
      }
      const entries = (body.queries || []).map(toEntry);
      p14log.push({ kind: 'resolve', qs: entries.map(e => e.q) });
      const results = entries.map((e, i) => {
        if (/Invented/.test(e.q)) return { id: e.id, query: e.q, status: 'no_match', reason: 'wrong_area' };
        return {
          id: e.id, query: e.q, status: 'ok', name: e.q,
          rating: 4.0 + i * 0.1, userRatingCount: 100 + i,
          mapsUri: 'https://maps.google.com/?cid=' + i,
          placeId: 'PID_' + e.id.replace(/\W+/g, '_').toUpperCase(),
          verified: true, areaBasis: 'point', confidence: 1,
          lat: 35.66 + i * 0.005, lon: 139.70 + i * 0.005,
        };
      });
      return { status: 200, body: { results, attribution: { text: 'Google Maps', url: 'https://www.google.com/maps' } } };
    };

    const p14Trip = trip({ name: 'P14 discovery', items: [
      item({ type: 'stay', title: 'P14 Hotel', location: 'Tokyo', startDate: iso(23), endDate: iso(26), status: 'booked' }),
    ] });
    const p14Stores = { 'trip-planner:geo:v3': {
      tokyo: { lat: 35.6812, lon: 139.7671, country: 'Japan', conf: 'confident' } } };

    await withPage('tp-places P14', { db: dbOf([p14Trip]), stores: p14Stores, net: p14Net }, async (s) => {
      await clickSel(s, '#assistBtn');
      await waitForExpr(s, `!!document.querySelector('#assistTierGroup')`, { timeout: 6000 });
      await evaluate(s, `(()=>{const r=document.querySelector('#assistTierGroup input[value="copy"]');
        if (r && !r.checked) r.click(); return 1})()`);
      await waitForExpr(s, `!!document.querySelector('#assistPasteBox')`, { timeout: 6000 });
      await setValue(s, '#assistPasteBox', P14_REPLY);

      // WATCH every card title that is ever added to the thread, rather than
      // sampling after a fixed delay: with an instant mock the whole verify ->
      // replace -> render cycle can finish inside 400ms, so a snapshot proves
      // nothing either way. What matters is not "was there a pause" but "was
      // the unverified venue EVER on screen as a normal recommendation", and
      // only an observer can answer that after the fact.
      await evaluate(s, `(()=>{
        window.__p14seen = [];
        const root = document.querySelector('#assistMessages');
        window.__p14obs = new MutationObserver(() => {
          for (const el of root.querySelectorAll('.assist-proposal .ap-title')) {
            const txt = el.textContent.trim();
            if (txt && !window.__p14seen.includes(txt)) window.__p14seen.push(txt);
          }
        });
        window.__p14obs.observe(root, { childList: true, subtree: true });
        return 1; })()`);
      await clickSel(s, '#assistPasteParse', { settle: 400 });

      await waitForExpr(s, `document.querySelectorAll('#assistMessages .assist-proposal').length >= 3`, { timeout: 15000 });
      await sleep(800);

      const out = await evaluate(s, `({
        titles: [...document.querySelectorAll('#assistMessages .ap-title')].map(e=>e.textContent.trim()),
        prose: [...document.querySelectorAll('#assistMessages .assist-msg.assistant')].map(e=>e.textContent).join(' | '),
        note: ((document.querySelector('#assistMessages .assist-verified-note')||{}).textContent||''),
        unresolved: [...document.querySelectorAll('#assistMessages .apr-none')].map(e=>e.textContent),
      })`);

      const everSeen = await evaluate(s, `(()=>{ if (window.__p14obs) window.__p14obs.disconnect();
        return window.__p14seen || []; })()`);
      await t('tp-places P14: the invented venue is never rendered as a recommendation, at any moment',
        !everSeen.some(x => /Invented/.test(x)), JSON.stringify(everSeen), s);
      await t('tp-places P14: the invented venue is NOT among the recommendations',
        out.titles.length === 3 && !out.titles.some(x => /Invented/.test(x)), JSON.stringify(out.titles), s);
      await t('tp-places P14: a verified replacement took its place',
        out.titles.some(x => /Replacement Cacao/.test(x)), JSON.stringify(out.titles), s);
      await t('tp-places P14: the provider was asked for the replacement, not the model',
        p14log.some(c => c.kind === 'discover'), JSON.stringify(p14log.map(c=>c.kind)), s);
      await t('tp-places P14: the discovery request excluded what was already offered',
        (p14log.find(c => c.kind === 'discover') || {}).exclude.length >= 2,
        JSON.stringify((p14log.find(c => c.kind === 'discover') || {}).exclude), s);
      await t('tp-places P14: the invented venue is gone from the PROSE too',
        !/Invented Atelier/.test(out.prose), out.prose.slice(0, 240), s);
      await t('tp-places P14: no unresolved card is shown in a discovery answer',
        out.unresolved.length === 0, JSON.stringify(out.unresolved), s);
      await t('tp-places P14: a complete answer needs no apology line',
        out.note === '', out.note, s);
    });
  }

  /* ------------- P15. replacement exhaustion is said out loud -------------- */
  freshIds();
  {
    const day = iso(24);
    const P15_REPLY = `Here are three great picks.

- P15 Ghost One is wonderful.
- P15 Ghost Two is also excellent.
- P15 Real Shop is reliable.

\`\`\`json
{"tripActions":[
 {"op":"add","discovery":{"query":"nama chocolate","count":3},"item":{"type":"activity","title":"P15 Ghost One","location":"Tokyo","startDate":"${day}","startTime":"14:00","mapsQuery":"P15 Ghost One Tokyo"}},
 {"op":"add","item":{"type":"activity","title":"P15 Ghost Two","location":"Tokyo","startDate":"${day}","startTime":"15:00","mapsQuery":"P15 Ghost Two Tokyo"}},
 {"op":"add","item":{"type":"activity","title":"P15 Real Shop","location":"Tokyo","startDate":"${day}","startTime":"16:00","mapsQuery":"P15 Real Shop Tokyo"}}
]}
\`\`\``;
    // The provider can find nothing to replace with, so two is the honest answer.
    const p15Net = (url, request) => {
      if (!url.includes('tp-places')) return EXTERNAL_HOSTS.test(url) ? 'fail' : null;
      let body = {};
      try { body = JSON.parse(request.postData || '{}'); } catch { /* empty */ }
      if (body.discover) return { status: 200, body: { discovered: true, results: [] } };
      const entries = (body.queries || []).map(toEntry);
      return { status: 200, body: { results: entries.map((e, i) => (/Ghost/.test(e.q)
        ? { id: e.id, query: e.q, status: 'no_match', reason: 'wrong_area' }
        : { id: e.id, query: e.q, status: 'ok', name: e.q, rating: 4.4, userRatingCount: 500,
            mapsUri: 'https://maps.google.com/?cid=1', placeId: 'PID_REAL', verified: true,
            areaBasis: 'point', confidence: 1, lat: 35.67, lon: 139.76 })),
        attribution: { text: 'Google Maps', url: 'https://www.google.com/maps' } } };
    };
    const p15Trip = trip({ name: 'P15 exhaustion', items: [
      item({ type: 'stay', title: 'P15 Hotel', location: 'Tokyo', startDate: iso(23), endDate: iso(26), status: 'booked' }),
    ] });
    const p15Stores = { 'trip-planner:geo:v3': {
      tokyo: { lat: 35.6812, lon: 139.7671, country: 'Japan', conf: 'confident' } } };

    await withPage('tp-places P15', { db: dbOf([p15Trip]), stores: p15Stores, net: p15Net }, async (s) => {
      await clickSel(s, '#assistBtn');
      await waitForExpr(s, `!!document.querySelector('#assistTierGroup')`, { timeout: 6000 });
      await evaluate(s, `(()=>{const r=document.querySelector('#assistTierGroup input[value="copy"]');
        if (r && !r.checked) r.click(); return 1})()`);
      await waitForExpr(s, `!!document.querySelector('#assistPasteBox')`, { timeout: 6000 });
      await setValue(s, '#assistPasteBox', P15_REPLY);
      await clickSel(s, '#assistPasteParse', { settle: 400 });
      await waitForExpr(s, `document.querySelectorAll('#assistMessages .assist-proposal').length >= 1`, { timeout: 15000 });
      await sleep(800);

      const out = await evaluate(s, `({
        titles: [...document.querySelectorAll('#assistMessages .ap-title')].map(e=>e.textContent.trim()),
        prose: [...document.querySelectorAll('#assistMessages .assist-msg.assistant')].map(e=>e.textContent).join(' | '),
        note: ((document.querySelector('#assistMessages .assist-verified-note')||{}).textContent||''),
        unresolved: [...document.querySelectorAll('#assistMessages .apr-none')].length,
      })`);
      await t('tp-places P15: only the verifiable place is shown',
        out.titles.length === 1 && /Real Shop/.test(out.titles[0]), JSON.stringify(out.titles), s);
      await t('tp-places P15: neither ghost survives in the prose',
        !/Ghost/.test(out.prose), out.prose.slice(0, 240), s);
      await t('tp-places P15: the shortfall is stated plainly',
        /could verify one good match/i.test(out.note), out.note, s);
      await t('tp-places P15: and no unresolved card is left behind',
        out.unresolved === 0, String(out.unresolved), s);
    });
  }

  /* ------------- P16. an EXPLICIT named place keeps the traveller's words --- */
  freshIds();
  {
    const day = iso(24);
    // No discovery hint, and the request that produced it named a venue - so
    // the unresolved state is preserved rather than replaced. Swapping in a
    // different business here would answer a question nobody asked.
    const P16_REPLY = `Added it.

\`\`\`json
{"tripActions":[
 {"op":"add","item":{"type":"activity","title":"P16 Named By Traveller","location":"Tokyo","startDate":"${day}","startTime":"14:00","mapsQuery":"P16 Named By Traveller Tokyo"}}
]}
\`\`\``;
    const p16Net = (url, request) => {
      if (!url.includes('tp-places')) return EXTERNAL_HOSTS.test(url) ? 'fail' : null;
      let body = {};
      try { body = JSON.parse(request.postData || '{}'); } catch { /* empty */ }
      if (body.discover) return { status: 200, body: { discovered: true, results: [] } };
      const entries = (body.queries || []).map(toEntry);
      return { status: 200, body: { results: entries.map(e => ({
        id: e.id, query: e.q, status: 'no_match', reason: 'wrong_area' })),
        attribution: { text: 'Google Maps', url: 'https://www.google.com/maps' } } };
    };
    const p16Trip = trip({ name: 'P16 explicit', items: [
      item({ type: 'stay', title: 'P16 Hotel', location: 'Tokyo', startDate: iso(23), endDate: iso(26), status: 'booked' }),
    ] });
    await withPage('tp-places P16', { db: dbOf([p16Trip]), net: p16Net }, async (s) => {
      await clickSel(s, '#assistBtn');
      await waitForExpr(s, `!!document.querySelector('#assistTierGroup')`, { timeout: 6000 });
      await evaluate(s, `(()=>{const r=document.querySelector('#assistTierGroup input[value="copy"]');
        if (r && !r.checked) r.click(); return 1})()`);
      await waitForExpr(s, `!!document.querySelector('#assistPasteBox')`, { timeout: 6000 });
      await setValue(s, '#assistPasteBox', P16_REPLY);
      await clickSel(s, '#assistPasteParse', { settle: 400 });
      await waitForExpr(s, `document.querySelectorAll('#assistMessages .assist-proposal').length >= 1`, { timeout: 12000 });
      await waitForExpr(s, `document.querySelectorAll('#assistMessages .ap-rating[data-painted="1"]').length >= 1`, { timeout: 12000 });
      const out = await evaluate(s, `({
        titles: [...document.querySelectorAll('#assistMessages .ap-title')].map(e=>e.textContent.trim()),
        unresolved: [...document.querySelectorAll('#assistMessages .apr-none')].map(e=>e.textContent),
        link: ((document.querySelector('#assistMessages .assist-maps-link')||{}).textContent||'').trim(),
      })`);
      await t('tp-places P16: a place the TRAVELLER named is kept, not replaced',
        out.titles.length === 1 && /Named By Traveller/.test(out.titles[0]), JSON.stringify(out.titles), s);
      await t('tp-places P16: and it is clearly marked unverified',
        out.unresolved.length === 1 && /No rating match/.test(out.unresolved[0]) && /Verify/.test(out.link),
        JSON.stringify(out), s);
    });
  }

  return R;
}
