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
  clickSel, gotoHard,
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
    const queries = Array.isArray(body.queries) ? body.queries : [];
    log.push({ queries, clientId: body.clientId || '', ownerToken: body.ownerToken || null });

    if (mode === '429') {
      return {
        status: 429,
        body: { error: 'quota_exceeded', scope: 'client_hour', resetAt: Date.now() + 3600000 },
        headers: { 'Retry-After': '3600' },
      };
    }
    const ok = q => ({
      query: q, status: 'ok', name: q, rating: 4.7, userRatingCount: 1481,
      mapsUri: 'https://maps.google.com/?cid=1', confidence: 1, lat: 35.66, lon: 139.7,
    });
    if (mode === 'partial') {
      return {
        status: 200,
        body: {
          results: queries.map((q, i) => (i % 2 === 0 ? ok(q) : { query: q, status: 'unavailable', reason: 'quota' })),
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
      granted += Math.min(room, queries.length);
      return {
        status: 200,
        body: {
          results: queries.map((q, i) => (i < room ? ok(q) : { query: q, status: 'unavailable', reason: 'quota' })),
          attribution: { text: 'Google Maps', url: 'https://www.google.com/maps' },
        },
      };
    }
    return {
      status: 200,
      body: { results: queries.map(ok), attribution: { text: 'Google Maps', url: 'https://www.google.com/maps' } },
    };
  };
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

  return R;
}
