// Trip Planner E2E: THE 344 KM DAY (owner report, 2026-09-06).
//
// Jan 27 2027, Ko Phi Phi. ChaoKoh Hotel Phi Phi Island -> The Mango Garden is
// a 258 m walk. The app printed "~344 km" on the row, "🚕 344 km" in the day
// footer, and plotted the two pins on opposite sides of the Gulf of Thailand -
// beside a Google Maps link that opened the correct restaurant.
//
// The nearest existing block (assistant-identity A) is the same island and
// still passes, because it seeds the hotel into the geocode cache as a
// confident doorstep. That is the ONE thing the owner's session did not have:
// they typed the hotel rather than picking it from the picker, so nothing on
// the day had a trustworthy coordinate and every rung of the ladder fell
// through to a guess. This suite removes that seed, which is the whole repro.
//
// The two impostor coordinates below are LIVE captures from 2026-09-06:
//   Nominatim's first answer for "Ko Phi Phi" is เกาะผี, an islet in Trat
//   Province, 606 km from the island; Photon's first answer for "The Mango
//   Garden Ko Phi Phi" is a cafe named exactly "The Mango Garden" on Ko Tao,
//   286 km away. Neither service is at fault. Believing them without evidence
//   was.
import {
  APP, recorder, freshIds, item, trip, dbOf,
  openApp, tpErrors, closePage, evaluate, waitForExpr, sleep,
  clickSel, gotoHard, switchView, setValue,
} from './helpers.mjs';
import { EXTERNAL_HOSTS } from '../../../tests/browser/cdp.mjs';

// ---------------------------------------------------------------------------
// Geography. Real coordinates, because the bug was a number.
const CHAOKOH = { lat: 7.7386, lon: 98.7770 };            // the hotel, Tonsai Bay
const MANGO = { lat: 7.7402, lon: 98.7787 };              // 258 m from its door
const LOH_DALUM = { lat: 7.740278, lon: 98.7703457 };
const TRAT_ISLET = { lat: 11.823752, lon: 102.446346 };   // Nominatim's "Ko Phi Phi"
const KO_TAO_MANGO = { lat: 10.0941684, lon: 99.8293127 };// Photon's "The Mango Garden"
const MANGO_ID = 'ChIJvb7PGeDeUTARJoM-VdbMTRg';
const HOTEL_ID = 'PID_CHAOKOH_HOTEL';
const DALUM_ID = 'ChIJ4RXOeeDeUTARjyay8ON3bRY';

const EARTH_KM = 6371;
const rad = d => (d * Math.PI) / 180;
function km(a, b) {
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}
const AREA_MAX_KM = 150;

const VENUES = {
  'ChaoKoh Hotel Phi Phi Island': { ...CHAOKOH, rating: 4.1, count: 2100, pid: HOTEL_ID, kind: 'hotel' },
  // the hotel's REAL name on Maps, which is what block E corrects the stay to
  'Chao Koh Phi Phi Hotel & Resort': { ...CHAOKOH, rating: 4.1, count: 2100, pid: HOTEL_ID, kind: 'hotel' },
  'The Mango Garden': { ...MANGO, rating: 4.8, count: 3769, pid: MANGO_ID, kind: 'restaurant' },
  'Loh Dalum Beach': { ...LOH_DALUM, rating: 4.1, count: 1077, pid: DALUM_ID, kind: 'beach' },
};
const ATTR = { text: 'Google Maps', url: 'https://www.google.com/maps' };
// A name the resolver cannot identify. The owner's real hotel was titled
// "ChaoKoh Hotel Phi Phi Island", which matches no business on Google Maps
// (Photon's top hits for it are hotels in Bali and the Philippines); the real
// one is "Chao Koh Phi Phi Hotel & Resort". The double refuses the first and
// resolves the second, which is exactly what production did.
const UNIDENTIFIABLE = /chaokoh hotel phi phi island/i;
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function venueFor(q) {
  const n = norm(q);
  let best = null;
  for (const name of Object.keys(VENUES)) {
    const nn = norm(name);
    if (n.includes(nn) && (!best || nn.length > norm(best).length)) best = name;
  }
  return best;
}

// The deployed endpoint's gates, and Photon's REAL answer for the same query.
// `verified` is false for everything here, because with no trustworthy anchor
// the client sends no point and the server has nothing to check the locality
// against. That is the state the whole failure lived in.
// `refuse` is opt-in and block-scoped. Making it global would quietly turn the
// hotel unresolvable for every other block in this file, which is exactly what
// it did on the first run: A, B and C all lost their anchor.
function net(log, refuse) {
  return (url, request) => {
    if (url.includes('photon.komoot.io')) {
      log.photon.push(url);
      // Verbatim from the live service, 2026-09-06.
      return { status: 200, body: { type: 'FeatureCollection', features: [{
        type: 'Feature',
        properties: { osm_type: 'N', osm_id: 12592475001, osm_key: 'amenity', osm_value: 'cafe',
          name: 'The Mango Garden', street: 'The Place Hill', locality: 'Ban Hat Sai Ri',
          district: 'Ko Tao Subdistrict', city: 'Ko Pha-ngan', state: 'Surat Thani Province',
          country: 'Thailand', postcode: '84360', countrycode: 'TH' },
        geometry: { type: 'Point', coordinates: [KO_TAO_MANGO.lon, KO_TAO_MANGO.lat] },
      }] } };
    }
    if (!url.includes('tp-places')) return EXTERNAL_HOSTS.test(url) ? 'fail' : null;
    let body = {};
    try { body = JSON.parse(request.postData || '{}'); } catch { /* recorded empty */ }
    const entries = Array.isArray(body.queries) ? body.queries : [];
    log.places.push(entries);
    if (body.discover) return { status: 200, body: { results: [], discovered: true, reason: 'no_candidates', attribution: ATTR } };
    const results = entries.map(e => {
      const q = String(e.q || '');
      if (refuse && refuse.test(q)) return { id: e.id, query: q, status: 'no_match', reason: 'low_confidence' };
      const name = venueFor(q);
      if (!name) return { id: e.id, query: q, status: 'no_match', reason: 'not_found' };
      const v = VENUES[name];
      const hasPoint = Number.isFinite(e.lat) && Number.isFinite(e.lon);
      if (hasPoint && km({ lat: e.lat, lon: e.lon }, v) > AREA_MAX_KM) {
        return { id: e.id, query: q, status: 'no_match', reason: 'wrong_area' };
      }
      return {
        id: e.id, query: q, status: 'ok', name, rating: v.rating, userRatingCount: v.count,
        mapsUri: 'https://maps.google.com/?cid=' + v.pid, placeId: v.pid,
        verified: hasPoint, areaBasis: hasPoint ? 'point' : 'address',
        confidence: hasPoint ? 0.95 : 0.5, lat: v.lat, lon: v.lon,
      };
    });
    return { status: 200, body: { results, attribution: ATTR } };
  };
}

const DAY = '2027-01-27';

const reply = `Breakfast at The Mango Garden, a short walk from your hotel.

\`\`\`json
{"tripActions":[
 {"op":"add","item":{"type":"activity","title":"Breakfast: The Mango Garden","location":"Ko Phi Phi","startDate":"${DAY}","startTime":"08:00","mapsQuery":"The Mango Garden Ko Phi Phi","meal":"breakfast"}}
]}
\`\`\``;

async function paste(s, text) {
  await clickSel(s, '#assistBtn');
  await waitForExpr(s, `!!document.querySelector('#assistTierGroup')`, { timeout: 8000 });
  await evaluate(s, `(()=>{const r=document.querySelector('#assistTierGroup input[value="copy"]');
    if (r && !r.checked) r.click(); return 1})()`);
  await waitForExpr(s, `!!document.querySelector('#assistPasteBox')`, { timeout: 8000 });
  await evaluate(s, `(()=>{const b=document.querySelector('#assistPasteBox');
    b.value=${JSON.stringify(text)}; b.dispatchEvent(new Event('input',{bubbles:true})); return 1})()`);
  await clickSel(s, '#assistPasteParse', { settle: 600 });
}

// Everything the traveller can read about distance on the rendered day.
const readDay = s => evaluate(s, `(() => {
  const card = document.querySelector('#daysList .day-card[data-date="${DAY}"]');
  if (!card) return null;
  const rows = [...card.querySelectorAll('.dc-event[data-dist-label]')].map(r => ({
    label: r.dataset.distLabel || '',
    placeId: r.dataset.distPlace || '',
    plat: r.dataset.distPlat || '', plon: r.dataset.distPlon || '',
    chip: ((r.querySelector('.dc-dist') || {}).textContent || '').trim(),
    dirHref: (r.querySelector('.tp-dir-link') || {}).getAttribute
      ? r.querySelector('.tp-dir-link').getAttribute('href') : '',
    mapsHref: (r.querySelector('.tp-maps-link') || {}).getAttribute
      ? r.querySelector('.tp-maps-link').getAttribute('href') : '',
  }));
  return {
    anchorPlace: card.dataset.anchorPlace || '',
    anchorPlat: card.dataset.anchorPlat || '', anchorPlon: card.dataset.anchorPlon || '',
    footer: ((card.querySelector('.dc-route-tot') || {}).textContent || '').trim(),
    rows,
  };
})()`);

// The pins the Day route map actually plots, in order.
const readRoute = s => evaluate(s, `(() => {
  const pins = [...document.querySelectorAll('#dayRouteStops li')].map(li => ({
    label: ((li.querySelector('.drs-label') || {}).textContent || '').trim(),
    leg: ((li.querySelector('.drs-leg') || {}).textContent || '').trim(),
  }));
  return { pins, count: pins.length };
})()`);

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

  /* =====================================================================
     A. THE REPORTED DAY, end to end.
     ===================================================================== */
  freshIds();
  {
    const log = { photon: [], places: [] };
    const stay = item({
      type: 'stay', title: 'ChaoKoh Hotel Phi Phi Island', location: 'Ko Phi Phi',
      startDate: '2027-01-26', endDate: '2027-01-29',
      mapsQuery: 'ChaoKoh Hotel Phi Phi Island Ko Phi Phi',
    });
    const tp = trip({ name: 'Thailand', items: [stay] });
    const stores = {
      // The only thing in the geocode cache is the wrong island. The hotel is
      // NOT here: the traveller typed it, so no doorstep was ever seeded.
      'trip-planner:geo:v3': {
        'ko phi phi': { ...TRAT_ISLET, country: 'Thailand', cc: 'TH', conf: 'low', kind: 'islet' },
      },
      // And the v1 venue store still holds the poisoned point from before the
      // fix. The rename to v2 is what makes a traveller already carrying it
      // stop seeing 344 km; if v1 were still read, this suite would fail.
      'trip-planner:venuegeo:v1': {
        'the mango garden ko phi phi@ko phi phi': { ...KO_TAO_MANGO, lat: KO_TAO_MANGO.lat, lon: KO_TAO_MANGO.lon, at: Date.now() },
      },
    };

    await withPage('canonical-coords A', { db: dbOf([tp]), stores, net: net(log) }, async (s) => {
      await paste(s, reply);
      await waitForExpr(s, `!!document.querySelector('#assistMessages [data-act="accept-proposal"]')`, { timeout: 20000 });
      await clickSel(s, '#assistMessages [data-act="accept-proposal"]', { settle: 1400 });

      /* --- 1. what Add to trip wrote --- */
      const saved = await evaluate(s, `(() => {
        const db = JSON.parse(localStorage.getItem('trip-planner:v1') || '{}');
        const tr = (db.trips || [])[0] || {};
        const it = (tr.items || []).find(i => /Mango Garden/.test(i.title || ''));
        return it && it.place ? it.place : null;
      })()`);
      await t('A1: Add to trip persists the canonical place ID',
        !!saved && saved.id === MANGO_ID, JSON.stringify(saved), s);
      await t('A2: AND the canonical coordinate, on an island nothing can corroborate',
        !!saved && Math.abs(saved.lat - MANGO.lat) < 0.001 && Math.abs(saved.lon - MANGO.lon) < 0.001,
        JSON.stringify(saved), s);

      /* --- 2. the row, the chip and the footer --- */
      await gotoHard(s, base + APP, { settle: 1600 });
      await switchView(s, 'days');
      await waitForExpr(s, `!!document.querySelector('#daysList .day-card[data-date="${DAY}"] .dc-route-tot')`, { timeout: 15000 });
      const day = await readDay(s);
      const mango = (day && day.rows.find(r => /Mango Garden/.test(r.label))) || null;
      await t('A3: the row carries the canonical identity', !!mango && mango.placeId === MANGO_ID,
        JSON.stringify(mango), s);
      await t('A4: and the canonical point is stamped beside it',
        !!mango && Math.abs(Number(mango.plat) - MANGO.lat) < 0.001,
        mango ? `${mango.plat},${mango.plon}` : 'no row', s);

      // The chip renders in the traveller's own unit, so read whichever it used
      // and convert. 344 km is 214 mi; a walk is under one of either.
      const chipVal = (text, re, factor) => {
        const m = String(text || '').match(re);
        return m ? Number(m[1]) * factor : NaN;
      };
      const chipKm = mango ? [
        chipVal(mango.chip, /([\d.]+)\s*km/, 1),
        chipVal(mango.chip, /([\d.]+)\s*mi\b/, 1.60934),
        chipVal(mango.chip, /([\d.]+)\s*m\b/, 0.001),
        chipVal(mango.chip, /([\d.]+)\s*ft\b/, 0.0003048),
      ].find(Number.isFinite) : NaN;
      await t('A5: THE HEADLINE - the distance chip is a walk, not 344 km',
        Number.isFinite(chipKm) && chipKm < 1,
        `chip read "${mango && mango.chip}" -> ${chipKm} km`, s);
      await t('A6: the day footer does not total a 344 km taxi ride',
        !!day && !/\d{3}\s*(km|mi)\b/.test(day.footer) && !/🚕/.test(day.footer),
        `footer read "${day && day.footer}"`, s);

      /* --- 3. the anchor, which was the other wrong endpoint --- */
      await t('A7: the day anchors on the hotel it resolved, not on a province centroid',
        !!day && Math.abs(Number(day.anchorPlat) - CHAOKOH.lat) < 0.001,
        `${day && day.anchorPlat},${day && day.anchorPlon} (wrong was ${TRAT_ISLET.lat})`, s);
      await t('A8: and the anchor carries the hotel identity',
        !!day && day.anchorPlace === HOTEL_ID, day && day.anchorPlace, s);

      /* --- 4. the Day route map --- */
      await clickSel(s, `#daysList .day-card[data-date="${DAY}"] [data-act="day-route"]`, { settle: 1200 });
      const route = await readRoute(s);
      await t('A9: the Day route plots both stops', route.count === 2,
        JSON.stringify(route.pins), s);
      const legText = route.pins.map(p => p.leg).join(' ');
      await t('A10: and they are adjacent, not hundreds of kilometres apart',
        !/\d{3}\s*(km|mi)\b/.test(legText), `legs read "${legText}"`, s);

      /* --- 5. the poisoned point is gone and cannot come back --- */
      const cache = await evaluate(s, `(() => ({
        v1: localStorage.getItem('trip-planner:venuegeo:v1'),
        v2: localStorage.getItem('trip-planner:venuegeo:v2'),
      }))()`);
      const v2 = JSON.parse(cache.v2 || '{}');
      const poisoned = Object.values(v2).some(r => r && Math.abs(r.lat - KO_TAO_MANGO.lat) < 0.01);
      await t('A11: no Ko Tao point survives anywhere in the live venue store',
        !poisoned, cache.v2 || '(empty)', s);

      /* --- 6. links and geometry agree on one place --- */
      await t('A12: the Maps link opens the canonical entity',
        !!mango && mango.mapsHref.includes(MANGO_ID), mango && mango.mapsHref, s);
      await t('A13: and Directions routes to it by ID, not by a re-interpretable string',
        !!mango && /destination_place_id=/.test(mango.dirHref) && mango.dirHref.includes(MANGO_ID),
        mango && mango.dirHref, s);
    });
  }

  /* =====================================================================
     B. RETURN TO HOTEL still ends where the day began.
     ===================================================================== */
  freshIds();
  {
    const log = { photon: [], places: [] };
    const stay = item({
      type: 'stay', title: 'ChaoKoh Hotel Phi Phi Island', location: 'Ko Phi Phi',
      startDate: '2027-01-26', endDate: '2027-01-29',
      mapsQuery: 'ChaoKoh Hotel Phi Phi Island Ko Phi Phi',
    });
    const breakfast = item({
      type: 'activity', title: 'Breakfast: The Mango Garden', meal: 'breakfast',
      location: 'Ko Phi Phi', startDate: DAY, startTime: '08:00',
      mapsQuery: 'The Mango Garden Ko Phi Phi',
    });
    const beach = item({
      type: 'activity', title: 'Loh Dalum Beach', location: 'Ko Phi Phi',
      startDate: DAY, startTime: '11:00', mapsQuery: 'Loh Dalum Beach Ko Phi Phi',
    });
    const home = item({
      type: 'local', title: 'Return to hotel', location: 'Ko Phi Phi',
      startDate: DAY, startTime: '21:30',
      mapsQuery: 'ChaoKoh Hotel Phi Phi Island Ko Phi Phi',
    });
    const tp = trip({ name: 'Thailand', items: [stay, breakfast, beach, home] });
    const stores = {
      'trip-planner:geo:v3': {
        'ko phi phi': { ...TRAT_ISLET, country: 'Thailand', cc: 'TH', conf: 'low', kind: 'islet' },
      },
    };

    await withPage('canonical-coords B', { db: dbOf([tp]), stores, net: net(log) }, async (s) => {
      await switchView(s, 'days');
      await waitForExpr(s, `!!document.querySelector('#daysList .day-card[data-date="${DAY}"] .dc-route-tot')`, { timeout: 20000 });
      await sleep(1500);
      const day = await readDay(s);
      const back = (day && day.rows.find(r => /Return to hotel/.test(r.label))) || null;
      await t('B1: the return leg is located by the stay, to the same coordinate',
        !!back && Math.abs(Number(back.plat) - CHAOKOH.lat) < 0.001,
        back ? `${back.plat},${back.plon} vs anchor ${day.anchorPlat},${day.anchorPlon}` : 'no row', s);
      await t('B2: first hotel coordinate === return hotel coordinate',
        !!back && back.plat === day.anchorPlat && back.plon === day.anchorPlon,
        `${back && back.plat} vs ${day && day.anchorPlat}`, s);
      await t('B3: every leg on the day is a walk',
        !!day && !/\d{3}\s*(km|mi)\b/.test(day.footer) && !/🚕/.test(day.footer),
        `footer read "${day && day.footer}"`, s);
      const far = (day ? day.rows : []).filter(r => /\d{3}\s*(km|mi)\b/.test(r.chip));
      await t('B4: no row anywhere on the day claims hundreds of kilometres',
        far.length === 0, far.map(r => `${r.label}: ${r.chip}`).join(' | '), s);
    });
  }

  /* =====================================================================
     C. A TYPED STAY KEEPS ITS RESOLUTION (owner report on their own trip:
        every activity carried a canonical record, the stay they had typed
        carried `place: NONE`).
     ===================================================================== */
  freshIds();
  {
    const log = { photon: [], places: [] };
    const stay = item({
      type: 'stay', title: 'ChaoKoh Hotel Phi Phi Island', location: 'Ko Phi Phi',
      startDate: '2027-01-26', endDate: '2027-01-29',
      mapsQuery: 'ChaoKoh Hotel Phi Phi Island Ko Phi Phi',
    });
    const beach = item({
      type: 'activity', title: 'Loh Dalum Beach', location: 'Ko Phi Phi',
      startDate: DAY, startTime: '11:00', mapsQuery: 'Loh Dalum Beach Ko Phi Phi',
    });
    const tp = trip({ name: 'Thailand', items: [stay, beach] });
    const stores = {
      'trip-planner:geo:v3': {
        'ko phi phi': { ...TRAT_ISLET, country: 'Thailand', cc: 'TH', conf: 'low', kind: 'islet' },
      },
    };

    await withPage('canonical-coords C', { db: dbOf([tp]), stores, net: net(log) }, async (s) => {
      await switchView(s, 'days');
      await waitForExpr(s, `!!document.querySelector('#daysList .day-card[data-date="${DAY}"] .dc-route-tot')`, { timeout: 20000 });
      await sleep(2500);

      const saved = () => evaluate(s, `(() => {
        const db = JSON.parse(localStorage.getItem('trip-planner:v1') || '{}');
        const tr = (db.trips || [])[0] || {};
        const out = {};
        for (const i of (tr.items || [])) out[i.title] = i.place || null;
        return out;
      })()`);

      const rec = await saved();
      const hotel = rec['ChaoKoh Hotel Phi Phi Island'];
      await t('C1: a stay the traveller TYPED now keeps its canonical identity',
        !!hotel && hotel.id === HOTEL_ID, JSON.stringify(hotel), s);
      await t('C2: and its coordinate, so the day anchor survives a reload',
        !!hotel && Math.abs(hotel.lat - CHAOKOH.lat) < 0.001 && Math.abs(hotel.lon - CHAOKOH.lon) < 0.001,
        JSON.stringify(hotel), s);
      await t('C3: the hand-added activity keeps its record too',
        !!rec['Loh Dalum Beach'] && rec['Loh Dalum Beach'].id === DALUM_ID,
        JSON.stringify(rec['Loh Dalum Beach']), s);

      /* --- the write is idempotent: a repaint must not rewrite the trip --- */
      const before = await evaluate(s, `localStorage.getItem('trip-planner:v1')`);
      await evaluate(s, `window.dispatchEvent(new Event('resize'))`);
      await sleep(2000);
      const after = await evaluate(s, `localStorage.getItem('trip-planner:v1')`);
      await t('C4: a repaint with a warm cache rewrites nothing',
        before === after, before === after ? '' : 'storage changed on a no-op repaint', s);

      /* --- and it is not an undo step --- */
      const undoDisabled = await evaluate(s, `(() => {
        const b = document.querySelector('#undoBtn, [data-act="undo"]');
        return b ? (b.disabled || b.getAttribute('aria-disabled') === 'true') : 'no undo button';
      })()`);
      await t('C5: persisting a background resolution is not an Undo step',
        undoDisabled === true || undoDisabled === 'no undo button', String(undoDisabled), s);

      /* --- and it FILLS A HOLE, it never overwrites what is already there --- */
      // The first draft of persistResolvedPlaces compared the whole record and
      // wrote on any difference, so a lookup landing on boot quietly replaced a
      // stored place ID with whatever the batch answered. That is the "the app
      // changed the place under me" failure of this very round, reintroduced
      // from the other end. tp-places P13 caught it; it is pinned here too,
      // beside the feature that caused it.
      await evaluate(s, `(() => {
        const db = JSON.parse(localStorage.getItem('trip-planner:v1'));
        const it = db.trips[0].items.find(i => /Loh Dalum/.test(i.title));
        it.place = { id: 'PID_THE_TRAVELLER_ACCEPTED', at: Date.now(), lat: 7.7403, lon: 98.7704, city: 'Ko Phi Phi' };
        localStorage.setItem('trip-planner:v1', JSON.stringify(db));
        return 1; })()`);
      await gotoHard(s, base + APP, { settle: 1600 });
      await switchView(s, 'days');
      await sleep(3000);
      const kept = await saved();
      await t('C7: a record the traveller already had is never re-pointed by a lookup',
        !!kept['Loh Dalum Beach'] && kept['Loh Dalum Beach'].id === 'PID_THE_TRAVELLER_ACCEPTED',
        JSON.stringify(kept['Loh Dalum Beach']), s);

      /* --- survives the reload, which is the whole point --- */
      await gotoHard(s, base + APP, { settle: 1600 });
      const afterReload = await saved();
      await t('C6: the identity and the point are both there after a reload',
        !!afterReload['ChaoKoh Hotel Phi Phi Island']
          && afterReload['ChaoKoh Hotel Phi Phi Island'].id === HOTEL_ID
          && Math.abs(afterReload['ChaoKoh Hotel Phi Phi Island'].lat - CHAOKOH.lat) < 0.001,
        JSON.stringify(afterReload['ChaoKoh Hotel Phi Phi Island']), s);
    });
  }

  /* =====================================================================
     E. AN UNLOCATED STAY SAYS SO, WHERE THE STAY IS.

        Owner report: their hotel was unidentifiable for a whole session and
        the only sign was "1 not located" in small grey text in the day footer,
        beside four rows that HAD resolved.
     ===================================================================== */
  freshIds();
  {
    const log = { photon: [], places: [] };
    const MIDDLE = '2027-01-27';
    const BAD = 'ChaoKoh Hotel Phi Phi Island';        // matches no business
    const GOOD = 'Chao Koh Phi Phi Hotel & Resort';    // the real one
    const stay = item({
      type: 'stay', title: BAD, location: 'Ko Phi Phi',
      startDate: '2027-01-26', endDate: '2027-01-29',
    });
    const beach = item({
      type: 'activity', title: 'Loh Dalum Beach', location: 'Ko Phi Phi',
      startDate: MIDDLE, startTime: '11:00', mapsQuery: 'Loh Dalum Beach Ko Phi Phi',
    });
    const mango = item({
      type: 'activity', title: 'The Mango Garden', meal: 'lunch', location: 'Ko Phi Phi',
      startDate: MIDDLE, startTime: '13:00', mapsQuery: 'The Mango Garden Ko Phi Phi',
    });
    const tp = trip({ name: 'Thailand', items: [stay, beach, mango] });
    const stores = {
      'trip-planner:geo:v3': {
        'ko phi phi': { ...TRAT_ISLET, country: 'Thailand', cc: 'TH', conf: 'low', kind: 'islet' },
      },
    };

    await withPage('canonical-coords E', { db: dbOf([tp]), stores, net: net(log, UNIDENTIFIABLE) }, async (s) => {
      await switchView(s, 'days');
      await waitForExpr(s, `!!document.querySelector('#daysList .day-card[data-date="${MIDDLE}"]')`, { timeout: 20000 });
      await sleep(4000);

      const warn = () => evaluate(s, `(() => {
        const out = { header: [], rows: [], footer: '' };
        for (const c of document.querySelectorAll('#daysList .day-card')) {
          const h = c.querySelector('.dc-anchor-warn');
          if (h && !h.hidden) out.header.push({ date: c.dataset.date, text: h.textContent.replace(/\\s+/g,' ').trim(), id: h.dataset.id || '' });
          const f = c.querySelector('.dc-route-unplaced');
          if (f && c.dataset.date === '${MIDDLE}') out.footer = f.textContent.replace(/\\s+/g,' ').trim();
        }
        for (const b of document.querySelectorAll('.dc-event .tp-place-warn')) {
          if (!b.hidden) out.rows.push({ text: b.textContent.replace(/\\s+/g,' ').trim(),
            row: (b.closest('.dc-event') || {}).dataset ? b.closest('.dc-event').dataset.distLabel : '' });
        }
        return out; })()`);

      /* --- 1. flagged directly where the hotel is shown --- */
      const w = await warn();
      await t('E1: the unlocated stay is flagged on the day itself, not only in a footer',
        w.header.length > 0, JSON.stringify(w.header).slice(0, 200), s);

      /* --- 2. you can tell WHICH hotel --- */
      await t('E2: the warning names the specific stay',
        w.header.every(h => h.text.includes(BAD)), JSON.stringify(w.header).slice(0, 200), s);
      await t('E2b: and the footer names it instead of counting it',
        /not located/.test(w.footer) && w.footer.includes(BAD) && !/^\W*·?\s*1 not located/.test(w.footer),
        `footer="${w.footer}"`, s);

      /* --- it is flagged on EVERY night the stay anchors, not just check-in --- */
      await t('E2c: every night of the stay is flagged, including middle nights',
        w.header.some(h => h.date === MIDDLE), JSON.stringify(w.header.map(h => h.date)), s);

      /* --- and the check-in ROW carries it too --- */
      await t('E2d: the stay row itself carries the warning',
        w.rows.some(r => /Location not verified/.test(r.text)), JSON.stringify(w.rows), s);

      /* --- 5. nothing was guessed --- */
      const guessed = await evaluate(s, `(() => {
        const db = JSON.parse(localStorage.getItem('trip-planner:v1') || '{}');
        const it = ((db.trips || [])[0] || {}).items.find(i => /ChaoKoh/.test(i.title || ''));
        return it && it.place ? it.place : null; })()`);
      await t('E5: no place is invented to make the warning go away',
        guessed === null, JSON.stringify(guessed), s);

      const anchorPt = await evaluate(s, `(() => {
        const c = document.querySelector('#daysList .day-card[data-date="${MIDDLE}"]');
        return { plat: c.dataset.anchorPlat || '', plon: c.dataset.anchorPlon || '' }; })()`);
      await t('E5b: and no centroid is substituted for the hotel either',
        !anchorPt.plat, JSON.stringify(anchorPt), s);

      /* --- 4. correct the name and the warning goes --- */
      await clickSel(s, `#daysList .day-card[data-date="2027-01-26"] .dc-event.is-stay [data-act="edit"]`, { settle: 800 });
      await waitForExpr(s, `document.querySelector('#itemOverlay').classList.contains('open')`, { timeout: 8000 });
      await setValue(s, '#inTitle', GOOD);
      await clickSel(s, '#itemSaveBtn', { settle: 1200 });
      await switchView(s, 'days');
      await sleep(4500);

      const after = await warn();
      await t('E4: correcting the name clears the warning everywhere',
        after.header.length === 0 && after.rows.length === 0,
        `header=${JSON.stringify(after.header)} rows=${JSON.stringify(after.rows)}`, s);
      await t('E4b: and the footer stops reporting anything unlocated',
        !after.footer, `footer="${after.footer}"`, s);

      /* --- 3 + 6. a resolved stay behaves normally --- */
      const day = await readDay(s);
      await t('E6: routing now uses the canonical resolved coordinates',
        !!day && Math.abs(Number(day.anchorPlat) - CHAOKOH.lat) < 0.001,
        `anchorPlat=${day && day.anchorPlat}`, s);
      const first = (day && day.rows.find(r => /Loh Dalum/.test(r.label))) || null;
      await t('E6b: and the day draws real distances from it',
        !!first && /\d/.test(first.chip), `chip="${first && first.chip}"`, s);

      /* --- 7. persistence --- */
      const saved = await evaluate(s, `(() => {
        const db = JSON.parse(localStorage.getItem('trip-planner:v1') || '{}');
        const it = ((db.trips || [])[0] || {}).items.find(i => /Chao Koh/.test(i.title || ''));
        return it && it.place ? it.place : null; })()`);
      await t('E7: the corrected stay persists its canonical place',
        !!saved && saved.id === HOTEL_ID && Math.abs(saved.lat - CHAOKOH.lat) < 0.001,
        JSON.stringify(saved), s);

      await gotoHard(s, base + APP, { settle: 1600 });
      await switchView(s, 'days');
      await sleep(3500);
      const reloaded = await warn();
      await t('E7b: and after a reload the warning stays gone',
        reloaded.header.length === 0 && reloaded.rows.length === 0,
        JSON.stringify(reloaded).slice(0, 200), s);
    });
  }

  return R;
}
