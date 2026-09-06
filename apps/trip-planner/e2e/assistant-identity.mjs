// Trip Planner E2E: THE ASSISTANT AS A TRAVELLER MEETS IT.
//
// Every other suite here mocks the provider and then asserts on a mechanism.
// This one asserts on the ANSWER: open a day, ask for a plan, and check that
// what appears is a set of real places whose ratings, links, distances and
// saved rows all describe the same venues - through Add to trip, through a
// reload, and on a phone.
//
// The blocks are the failures the owner actually reported on 2026-09-05:
//
//   A. KO PHI PHI. The app geocoded the day's city through Nominatim, got an
//      islet in Trat Province 570 km away, sent that as the expected area, and
//      the resolver correctly refused every real venue on the island. One
//      activity, zero breakfasts, zero lunches, zero dinners - out of a dozen
//      correct recommendations. The tp-places double below implements the REAL
//      server's geographic rule (AREA_MAX_KM = 150), so this block passes only
//      if the client stops sending the wrong coordinate.
//
//   B. KATA BEACH. "Sugar Marina -> Kata On Fire -> Return to hotel" printed
//      ~14 km / ~27 min taxi for a 450 m walk, because the return leg fell
//      through to the centroid of Phuket province.
//
//   C. MAYA BAY. "Maya Bay" resolved to "Maya Bay Tours", a booking desk near
//      the hotel, and wore its rating and its pin.
//
//   D. A NORMAL CITY, so the island work cannot quietly degrade Tokyo.
//
//   E. PARTIAL FAILURE: one invented venue among eight real ones.
//
// The real endpoint is never touched: a green run here costs $0.00.
import {
  APP, recorder, freshIds, item, trip, dbOf,
  openApp, tpErrors, closePage, evaluate, waitForExpr, sleep,
  clickSel, gotoHard, setValue, switchView,
} from './helpers.mjs';
import { EXTERNAL_HOSTS } from '../../../tests/browser/cdp.mjs';

// ---------------------------------------------------------------------------
// Geography. Real coordinates throughout, because the whole bug was about a
// coordinate being wrong by an amount that only real numbers make visible.
const PHI_PHI = { lat: 7.7390, lon: 98.7714 };           // Ko Phi Phi Don
const PHI_PHI_HOTEL = { lat: 7.7412, lon: 98.7736 };     // the stay's doorstep
// What Nominatim really answers for the string "Ko Phi Phi": Ko Phi, an islet
// in Ko Kut District, Trat Province - 570 km away, near Cambodia. Verified
// against the live service on 2026-09-05; classifyGeoMatch scores it `low`
// (addresstype `islet`, importance 0.127).
const TRAT_ISLET = { lat: 11.8237522, lon: 102.4463456 };
const KATA = { lat: 7.8203, lon: 98.2988 };              // Sugar Marina, Kata Beach
const KATA_ON_FIRE = { lat: 7.8189, lon: 98.2971 };      // ~200 m away
const PHUKET_PROVINCE = { lat: 7.9366015, lon: 98.3529292 }; // Nominatim's "Phuket"
const TOKYO = { lat: 35.6812, lon: 139.7671 };

const EARTH_KM = 6371;
const rad = d => (d * Math.PI) / 180;
function km(a, b) {
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}

// The server's own radius (AREA_MAX_KM in tp-places-match.mjs). Duplicated
// here on purpose: this double has to behave like the deployed endpoint, and
// a shared constant would let both drift together and hide the regression.
const AREA_MAX_KM = 150;

// ---------------------------------------------------------------------------
// The venue table. Every entry is a real Ko Phi Phi / Kata business with the
// shape Google actually returns for it. Ratings are CAPTURED values, never
// asserted against the live service: the assertions are about what the app
// does with whatever the provider said.
const VENUES = {
  'The Mango Garden': { ...PHI_PHI, rating: 4.8, count: 3770, pid: 'ChIJvb7PGeDeUTARJoM-VdbMTRg', kind: 'restaurant' },
  "Anna's Restaurant": { lat: 7.738994, lon: 98.771744, rating: 4.7, count: 2591, pid: 'ChIJ72eJPeDeUTARfhTuElmKMGA', kind: 'restaurant' },
  'Garlic 1992': { lat: 7.7401, lon: 98.7722, rating: 4.5, count: 1840, pid: 'PID_GARLIC', kind: 'restaurant' },
  'Acqua Restaurant': { lat: 7.7385, lon: 98.7708, rating: 4.6, count: 990, pid: 'PID_ACQUA', kind: 'restaurant' },
  'P.P. Wang Ta Fu': { lat: 7.7396, lon: 98.7719, rating: 4.4, count: 610, pid: 'PID_WANG', kind: 'restaurant' },
  'DMC Restaurant': { lat: 7.7392, lon: 98.7702, rating: 4.3, count: 1220, pid: 'PID_DMC', kind: 'restaurant' },
  'Efe Mediterranean Cuisine': { lat: 7.7399, lon: 98.7716, rating: 4.7, count: 1510, pid: 'PID_EFE', kind: 'restaurant' },
  'Papaya Restaurant': { lat: 7.7388, lon: 98.7726, rating: 4.4, count: 2100, pid: 'PID_PAPAYA', kind: 'restaurant' },
  'Chao Koh Restaurant': { lat: 7.7383, lon: 98.7731, rating: 4.2, count: 780, pid: 'PID_CHAOKOH', kind: 'restaurant' },
  'Phi Phi Viewpoint': { lat: 7.7452, lon: 98.7745, rating: 4.6, count: 8900, pid: 'PID_VIEWPOINT', kind: 'tourist_attraction' },
  'Loh Dalum Beach': { lat: 7.740278, lon: 98.7703457, rating: 4.1, count: 1077, pid: 'ChIJ4RXOeeDeUTARjyay8ON3bRY', kind: 'beach' },
  'Monkey Beach': { lat: 7.7288, lon: 98.7626, rating: 4.2, count: 3400, pid: 'PID_MONKEY', kind: 'beach' },
  'Long Beach': { lat: 7.7268, lon: 98.7791, rating: 4.5, count: 2600, pid: 'PID_LONG', kind: 'beach' },
  // Maya Bay is on Phi Phi LEH, 7 km offshore and boat-access only. Its
  // namesake tour desk is 100 m from the hotel, which is exactly why proximity
  // must not be allowed to decide which of them "Maya Bay" means.
  'Maya Bay': { lat: 7.6790, lon: 98.7650, rating: 4.4, count: 12000, pid: 'PID_MAYA', kind: 'beach' },
  'Maya Bay Tours': { lat: 7.7415, lon: 98.7739, rating: 4.6, count: 210, pid: 'PID_MAYATOURS', kind: 'travel_agency' },
  'Kata On Fire': { ...KATA_ON_FIRE, rating: 4.7, count: 1300, pid: 'PID_KOF', kind: 'restaurant' },
  'Sugar Marina Hotel - FASHION - Kata Beach': { ...KATA, rating: 4.3, count: 2400, pid: 'PID_SUGAR', kind: 'hotel' },
  'Phi Phi Bayview Resort': { ...PHI_PHI_HOTEL, rating: 4.2, count: 1900, pid: 'PID_BAYVIEW', kind: 'hotel' },
  'Narisawa': { lat: 35.6664, lon: 139.7220, rating: 4.5, count: 1600, pid: 'PID_NARISAWA', kind: 'restaurant' },
  'teamLab Planets TOKYO': { lat: 35.6489, lon: 139.7900, rating: 4.4, count: 30000, pid: 'PID_TEAMLAB', kind: 'tourist_attraction' },
};

// Words that make a place a BROKER rather than the thing itself, mirroring
// BROKER_WORDS on the server.
const BROKER = /\b(tours?|tickets?|booking|agency|travel|rentals?|charter|transfers?|shuttle)\b/i;

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Which venue a mapsQuery names. Longest match wins, so "Maya Bay Tours"
// beats "Maya Bay" when the query really does ask for the desk.
function venueFor(q) {
  const n = norm(q);
  let best = null;
  for (const name of Object.keys(VENUES)) {
    const nn = norm(name);
    if (n.includes(nn) && (!best || nn.length > norm(best).length)) best = name;
  }
  return best;
}

/**
 * A tp-places double that behaves like the DEPLOYED endpoint, gate for gate.
 * This is the point of the whole file: the client is what is under test, so
 * the server double must not be lenient about anything the real one refuses.
 *
 *   name gate  - a query that names no venue in the table is `not_found`
 *   type gate  - a query with no trade word that resolves to a broker is
 *                `type_mismatch` (Maya Bay -> Maya Bay Tours)
 *   area gate  - a supplied point more than AREA_MAX_KM from the venue is
 *                `wrong_area`; no point at all is `city_unconfirmed`, i.e.
 *                resolved but unverified
 */
function placesDouble(log) {
  return (url, request) => {
    if (!url.includes('tp-places')) return EXTERNAL_HOSTS.test(url) ? 'fail' : null;
    let body = {};
    try { body = JSON.parse(request.postData || '{}'); } catch { /* recorded empty */ }
    const entries = Array.isArray(body.queries) ? body.queries : [];
    log.push({ entries, discover: body.discover || null });

    if (body.discover) {
      return { status: 200, body: { results: [], discovered: true, reason: 'no_candidates', attribution: ATTR } };
    }

    const results = entries.map(e => {
      const q = String(e.q || '');
      let name = venueFor(q);
      if (!name) return { id: e.id, query: q, status: 'no_match', reason: 'not_found' };

      // THE TYPE GATE. A query that did not ask for a tour desk never gets one.
      const v = VENUES[name];
      if (v.kind === 'travel_agency' && !BROKER.test(q)) {
        return { id: e.id, query: q, status: 'no_match', reason: 'type_mismatch' };
      }

      // THE AREA GATE, with the real radius and the real semantics.
      const hasPoint = Number.isFinite(e.lat) && Number.isFinite(e.lon);
      if (hasPoint && km({ lat: e.lat, lon: e.lon }, v) > AREA_MAX_KM) {
        return { id: e.id, query: q, status: 'no_match', reason: 'wrong_area' };
      }
      return {
        id: e.id, query: q, status: 'ok', name,
        rating: v.rating, userRatingCount: v.count,
        mapsUri: 'https://maps.google.com/?cid=' + v.pid,
        placeId: v.pid,
        verified: hasPoint,
        areaBasis: hasPoint ? 'point' : 'address',
        confidence: hasPoint ? 0.95 : 0.5,
        lat: v.lat, lon: v.lon,
      };
    });
    return { status: 200, body: { results, attribution: ATTR } };
  };
}
const ATTR = { text: 'Google Maps', url: 'https://www.google.com/maps' };

// ---------------------------------------------------------------------------
// A pasted reply, in the shape the model really emits: one add per agenda
// entry, meal candidates grouped three to a slot, activities two to a slot,
// and a discovery hint so the verify-before-render path is the one exercised.
function phiPhiReply(day) {
  const add = (title, meal, time, q, group) =>
    `{"op":"add"${group ? `,"group":"${group}"` : ''},"item":{"type":"activity","title":"${title}",`
    + `"location":"Ko Phi Phi","startDate":"${day}","startTime":"${time}",`
    + `"mapsQuery":"${q} Ko Phi Phi"${meal ? `,"meal":"${meal}"` : ''}}}`;
  return `A full day on Phi Phi Don.

Breakfast at The Mango Garden, then the viewpoint. Lunch at P.P. Wang Ta Fu and an afternoon on Loh Dalum Beach, with dinner at Efe Mediterranean Cuisine.

\`\`\`json
{"tripActions":[
 {"op":"add","discovery":{"query":"restaurants and beaches","count":11},"item":{"type":"activity","title":"Breakfast: The Mango Garden","location":"Ko Phi Phi","startDate":"${day}","startTime":"08:00","mapsQuery":"The Mango Garden Ko Phi Phi","meal":"breakfast"},"group":"breakfast-${day}"},
 ${add('Breakfast: Acqua Restaurant', 'breakfast', '08:00', 'Acqua Restaurant', `breakfast-${day}`)},
 ${add('Breakfast: Garlic 1992', 'breakfast', '08:00', 'Garlic 1992', `breakfast-${day}`)},
 ${add('Phi Phi Viewpoint', '', '10:00', 'Phi Phi Viewpoint', `activity-${day}-am`)},
 ${add('Monkey Beach', '', '10:00', 'Monkey Beach', `activity-${day}-am`)},
 ${add('Lunch: P.P. Wang Ta Fu', 'lunch', '13:00', 'P.P. Wang Ta Fu', `lunch-${day}`)},
 ${add('Lunch: DMC Restaurant', 'lunch', '13:00', 'DMC Restaurant', `lunch-${day}`)},
 ${add('Lunch: Papaya Restaurant', 'lunch', '13:00', 'Papaya Restaurant', `lunch-${day}`)},
 ${add('Loh Dalum Beach', '', '15:30', 'Loh Dalum Beach', `activity-${day}-pm`)},
 ${add('Long Beach', '', '15:30', 'Long Beach', `activity-${day}-pm`)},
 ${add('Dinner: Efe Mediterranean Cuisine', 'dinner', '19:00', 'Efe Mediterranean Cuisine', `dinner-${day}`)},
 ${add("Dinner: Anna's Restaurant", 'dinner', '19:00', "Anna's Restaurant", `dinner-${day}`)},
 ${add('Dinner: Chao Koh Restaurant', 'dinner', '19:00', 'Chao Koh Restaurant', `dinner-${day}`)}
]}
\`\`\``;
}

// Drive the copy/paste tier, which is the one path that needs no upstream AI
// and still runs the whole reply -> verify -> render pipeline.
async function paste(s, reply, phone = false) {
  if (phone) {
    // Since 2026-08-22 the phone toolbar folds the secondary tools behind
    // "More"; #assistBtn is still the real control and the menu row proxies
    // to it, but it is not clickable at this width.
    await clickSel(s, '#tbMoreBtn', { settle: 300 });
    await clickSel(s, '#tbMoreMenu [data-proxy="#assistBtn"]', { settle: 700 });
  } else {
    await clickSel(s, '#assistBtn');
  }
  await waitForExpr(s, `!!document.querySelector('#assistTierGroup')`, { timeout: 8000 });
  await evaluate(s, `(()=>{const r=document.querySelector('#assistTierGroup input[value="copy"]');
    if (r && !r.checked) r.click(); return 1})()`);
  await waitForExpr(s, `!!document.querySelector('#assistPasteBox')`, { timeout: 8000 });
  await setValue(s, '#assistPasteBox', reply);
  await clickSel(s, '#assistPasteParse', { settle: 600 });
}

// Everything a traveller can read off the rendered cards.
const readCards = s => evaluate(s, `(() => {
  const out = [];
  for (const card of document.querySelectorAll('#assistMessages .assist-proposal')) {
    const opts = card.classList.contains('assist-set')
      ? [...card.querySelectorAll('.as-opt')] : [card];
    for (const o of opts) {
      const r = o.querySelector('.ap-rating');
      const link = o.querySelector('.assist-maps-link');
      out.push({
        title: ((o.querySelector('.as-title') || o.querySelector('.ap-title')) || {}).textContent || '',
        meal: ((card.querySelector('.as-lead') || card.querySelector('.ap-meta')) || {}).textContent || '',
        rating: r ? ((r.querySelector('.apr-score') || {}).textContent || '') : '',
        count: r ? ((r.querySelector('.apr-count') || {}).textContent || '') : '',
        none: r ? ((r.querySelector('.apr-none') || {}).textContent || '') : '',
        chipHref: r ? ((r.querySelector('.apr-chip') || {}).getAttribute ? r.querySelector('.apr-chip').getAttribute('href') : '') : '',
        linkHref: link ? link.getAttribute('href') : '',
        linkLabel: link ? link.textContent.trim() : '',
        dist: ((o.querySelector('.ap-dist') || {}).textContent || '').trim(),
      });
    }
  }
  return out;
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

  const DAY = '2027-01-27';

  /* =====================================================================
     A. KO PHI PHI - the day that came back empty.
     ===================================================================== */
  freshIds();
  {
    const log = [];
    const stay = item({
      type: 'stay', title: 'Phi Phi Bayview Resort', location: 'Ko Phi Phi',
      startDate: '2027-01-26', endDate: '2027-01-29',
      mapsQuery: 'Phi Phi Bayview Resort Ko Phi Phi',
    });
    const phiPhi = trip({ name: 'Thailand', items: [stay] });
    // THE POISONED CACHE, exactly as a real session builds it: Nominatim
    // answered "Ko Phi Phi" with the Trat islet and the app filed it with the
    // confidence its own classifier gave it. The hotel was picked from the
    // picker, so it is filed confident with its real doorstep.
    const stores = {
      'trip-planner:geo:v3': {
        'ko phi phi': { ...TRAT_ISLET, country: 'Thailand', cc: 'TH', conf: 'low', kind: 'islet' },
        'phi phi bayview resort': { ...PHI_PHI_HOTEL, country: 'Thailand', cc: 'TH', conf: 'confident' },
      },
    };

    await withPage('assistant-identity A', { db: dbOf([phiPhi]), stores, net: placesDouble(log) }, async (s) => {
      await paste(s, phiPhiReply(DAY));
      await waitForExpr(s, `document.querySelectorAll('#assistMessages .ap-rating[data-painted="1"]').length >= 10`, { timeout: 20000 });
      const cards = await readCards(s);

      /* --- the headline regression --- */
      const rated = cards.filter(c => c.rating);
      await t('A1: a dense island produces a full day, not one activity and no meals',
        rated.length >= 12, `${rated.length} of ${cards.length} cards carry a Google rating`, s);

      for (const slot of ['Breakfast', 'Lunch', 'Dinner']) {
        const inSlot = cards.filter(c => new RegExp(slot, 'i').test(c.meal) || new RegExp(slot, 'i').test(c.title));
        await t(`A2: the ${slot.toLowerCase()} slot is not empty`,
          inSlot.length >= 3 && inSlot.every(c => c.rating),
          `${inSlot.filter(c => c.rating).length}/${inSlot.length} rated`, s);
      }

      await t('A3: no card says it could not be found when the provider found it',
        cards.every(c => !/Not found on Google|Different city/.test(c.none)),
        cards.filter(c => c.none).map(c => c.title + ': ' + c.none).join(' | '), s);

      /* --- the exact venues the owner checked by hand --- */
      const mango = cards.find(c => /Mango Garden/.test(c.title));
      await t('A4: The Mango Garden shows the rating Google returned for it',
        !!mango && mango.rating === '4.8' && /3,770/.test(mango.count),
        JSON.stringify(mango), s);
      await t('A5: and its chip links at that exact place ID, not a text search',
        !!mango && mango.chipHref.includes('place_id:ChIJvb7PGeDeUTARJoM-VdbMTRg'),
        mango && mango.chipHref, s);

      const annas = cards.find(c => /Anna/.test(c.title));
      await t("A6: Anna's Restaurant resolves despite an Ao Nang / Krabi address",
        !!annas && annas.rating === '4.7', JSON.stringify(annas), s);

      const beach = cards.find(c => /Loh Dalum/.test(c.title));
      await t('A7: an ATTRACTION carries a rating exactly as a restaurant does',
        !!beach && beach.rating === '4.1' && /1,077/.test(beach.count), JSON.stringify(beach), s);

      /* --- the coordinate the app actually put on the wire --- */
      // openApp's FIRST navigation boots the app against whatever the previous
      // block (or, in a shard, the previous suite) left in localStorage, so the
      // interceptor legitimately records that trip's lookups before the seed
      // lands. Judge this trip's own queries.
      const sent = log.flatMap(e => e.entries)
        .filter(e => Number.isFinite(e.lat) && /ko phi phi/i.test(e.city || ''));
      await t('A8: the wrong centroid never reaches the resolver',
        sent.length > 0 && sent.every(e => km({ lat: e.lat, lon: e.lon }, TRAT_ISLET) > 100),
        JSON.stringify(sent.slice(0, 2)), s);
      await t('A9: what it sends instead is the hotel the traveller chose',
        sent.length > 0 && sent.every(e => km({ lat: e.lat, lon: e.lon }, PHI_PHI_HOTEL) < 1),
        `${sent.length} located queries for this trip`, s);

      /* --- a verified place is OPENED, never "verify this yourself" --- */
      await t('A10: a verified place is opened on Google Maps, not handed back to the traveller',
        rated.length > 0 && rated.every(c => !/Verify/.test(c.linkLabel) || c.chipHref),
        rated.map(c => c.linkLabel).slice(0, 3).join(' | '), s);

      /* --- Add to trip must not change anything --- */
      const before = cards.find(c => /Mango Garden/.test(c.title));
      await evaluate(s, `(() => {
        for (const card of document.querySelectorAll('#assistMessages .assist-proposal.assist-set')) {
          const lead = (card.querySelector('.as-lead') || {}).textContent || '';
          if (!/Breakfast/i.test(lead)) continue;
          const opts = [...card.querySelectorAll('.as-opt')];
          const mine = opts.find(o => /Mango Garden/.test(o.textContent));
          const radio = mine && mine.querySelector('input[type=radio]');
          if (radio) radio.click();
          const btn = card.querySelector('[data-act="accept-proposal"], .assist-accept');
          if (btn) btn.click();
          return 1;
        }
        return 0;
      })()`);
      await sleep(1200);
      const saved = await evaluate(s, `(() => {
        const db = JSON.parse(localStorage.getItem('trip-planner:v1') || '{}');
        const tr = (db.trips || [])[0] || {};
        const it = (tr.items || []).find(i => /Mango Garden/.test(i.title || ''));
        return it ? { title: it.title, place: it.place || null, mapsQuery: it.mapsQuery } : null;
      })()`);
      await t('A11: Add to trip persists the canonical place ID',
        !!saved && saved.place && saved.place.id === 'ChIJvb7PGeDeUTARJoM-VdbMTRg',
        JSON.stringify(saved), s);
      await t('A12: and the coordinate it was verified at',
        !!saved && saved.place && Math.abs(saved.place.lat - PHI_PHI.lat) < 0.01,
        JSON.stringify(saved && saved.place), s);

      /* --- and a reload must not change it either --- */
      await gotoHard(s, base + APP, { settle: 1200 });
      const afterReload = await evaluate(s, `(() => {
        const db = JSON.parse(localStorage.getItem('trip-planner:v1') || '{}');
        const tr = (db.trips || [])[0] || {};
        const it = (tr.items || []).find(i => /Mango Garden/.test(i.title || ''));
        return it && it.place ? it.place.id : null;
      })()`);
      await t('A13: the identity survives a reload unchanged',
        afterReload === 'ChIJvb7PGeDeUTARJoM-VdbMTRg', String(afterReload), s);
      await t('A14: the pre-add and post-add identities are the same place',
        !!before && before.chipHref.includes(afterReload || 'x'),
        `${before && before.chipHref} vs ${afterReload}`, s);
    });
  }

  /* =====================================================================
     B. KATA BEACH - the 450 m walk that became a 14 km taxi.
     ===================================================================== */
  freshIds();
  {
    const log = [];
    const day = '2027-02-10';
    const hotel = item({
      type: 'stay', title: 'Sugar Marina Hotel - FASHION - Kata Beach', location: 'Phuket',
      startDate: '2027-02-09', endDate: '2027-02-12',
      mapsQuery: 'Sugar Marina Hotel - FASHION - Kata Beach',
    });
    const dinner = item({
      type: 'activity', title: 'Dinner: Kata On Fire', meal: 'dinner', location: 'Phuket',
      startDate: day, startTime: '19:00', mapsQuery: 'Kata On Fire Phuket',
    });
    const home = item({
      type: 'local', title: 'Return to hotel', location: 'Phuket',
      startDate: day, startTime: '21:30',
      mapsQuery: 'Sugar Marina Hotel - FASHION - Kata Beach',
    });
    const kataTrip = trip({ name: 'Phuket', items: [hotel, dinner, home] });
    const stores = {
      'trip-planner:geo:v3': {
        // Nominatim answers "Phuket" with the PROVINCE, 14 km north of Kata.
        phuket: { ...PHUKET_PROVINCE, country: 'Thailand', cc: 'TH', conf: 'confident', kind: 'province' },
        'sugar marina hotel - fashion - kata beach': { ...KATA, country: 'Thailand', cc: 'TH', conf: 'confident' },
      },
    };

    await withPage('assistant-identity B', { db: dbOf([kataTrip]), stores, net: placesDouble(log) }, async (s) => {
      await switchView(s, 'days', 1200);
      // Days renders into #daysList; #board is the Timeline's panel.
      await waitForExpr(s, `document.querySelectorAll('#daysList .dc-title').length >= 3`, { timeout: 15000 });
      // the chips are painted from the caches after the lookups land
      await sleep(2500);
      const legs = await evaluate(s, `(() => {
        const out = [];
        for (const el of document.querySelectorAll('#daysList .dc-title')) {
          const row = el.closest('.dc-event') || el.parentElement;
          out.push({
            title: (el.textContent || '').trim(),
            dist: (((row && row.querySelector('.dc-dist')) || {}).textContent || '').trim(),
            place: (row && row.dataset && row.dataset.distPlace) || '',
            strict: (row && row.dataset && row.dataset.distStrict) || '',
          });
        }
        return out;
      })()`);
      const back = legs.find(l => /Return to hotel/i.test(l.title));

      // The chip prints a distance; anything over a kilometre here is the
      // province centroid talking. Parsed rather than pattern-matched so the
      // failure message can say what the number actually was.
      const kmOf = txt => {
        const m = /([\\d.]+)\\s*km/.exec(String(txt || ''));
        if (m) return parseFloat(m[1]);
        const mm = /([\\d.]+)\\s*m\\b/.exec(String(txt || ''));
        return mm ? parseFloat(mm[1]) / 1000 : null;
      };
      const backKm = back ? kmOf(back.dist) : null;
      await t('B1: the ride home is a local hop, not a phantom cross-province taxi',
        !!back && (backKm === null || backKm < 5),
        `Return to hotel chip: "${back && back.dist}" | all rows: ${JSON.stringify(legs)}`, s);
      await t('B2: and the return leg resolves to the hotel\'s own canonical place',
        !!back && back.place === 'PID_SUGAR',
        `place id on the return row: "${back && back.place}"`, s);

      // The Day Route map must put the return stop on the hotel, not the province.
      const stops = await evaluate(s, `(() => {
        const btn = document.querySelector('#daysList [data-act="day-route"]');
        if (!btn) return 0;
        btn.click();
        return 1;
      })()`);
      await sleep(1200);
      // The Day Route is an overlay with its own stop list (#dayRouteStops),
      // and the stop LABELS are what say which building each pin is on.
      const route = await evaluate(s, `(() => {
        const ov = document.querySelector('#dayRouteOverlay');
        if (!ov || !ov.classList.contains('open')) return null;
        return [...ov.querySelectorAll('#dayRouteStops .drs-label')].map(el => (el.textContent || '').trim());
      })()`);
      await t('B3: the Day Route opens with the hotel at both ends of the day',
        stops === 1 && Array.isArray(route) && route.length >= 2
          && /Sugar Marina/i.test(route[0]) && /Return to hotel/i.test(route[route.length - 1]),
        JSON.stringify(route) || '(no overlay found)', s);
      // The pins must sit on the hotel, not on the province: the whole day is
      // a few hundred metres across, so every leg of the route has to be too.
      const legText = await evaluate(s, `[...document.querySelectorAll('#dayRouteStops .drs-leg')].map(e => e.textContent.trim())`);
      await t('B4: and every leg on that route is a local hop',
        Array.isArray(legText) && legText.length > 0
          && legText.every(x => { const v = kmOf(x); return v === null || v < 5; }),
        JSON.stringify(legText), s);
    });
  }

  /* =====================================================================
     C. MAYA BAY must not become MAYA BAY TOURS.
     ===================================================================== */
  freshIds();
  {
    const log = [];
    const day = '2027-01-28';
    const stay = item({
      type: 'stay', title: 'Phi Phi Bayview Resort', location: 'Ko Phi Phi',
      startDate: '2027-01-26', endDate: '2027-01-29', mapsQuery: 'Phi Phi Bayview Resort Ko Phi Phi',
    });
    const mayaTrip = trip({ name: 'Thailand', items: [stay] });
    const stores = {
      'trip-planner:geo:v3': {
        'ko phi phi': { ...TRAT_ISLET, country: 'Thailand', cc: 'TH', conf: 'low', kind: 'islet' },
        'phi phi bayview resort': { ...PHI_PHI_HOTEL, country: 'Thailand', cc: 'TH', conf: 'confident' },
      },
    };
    const REPLY = `A boat day.

\`\`\`json
{"tripActions":[
 {"op":"add","discovery":{"query":"beaches","count":2},"item":{"type":"activity","title":"Maya Bay","location":"Ko Phi Phi","startDate":"${day}","startTime":"09:00","mapsQuery":"Maya Bay Ko Phi Phi"}},
 {"op":"add","item":{"type":"activity","title":"Monkey Beach","location":"Ko Phi Phi","startDate":"${day}","startTime":"13:00","mapsQuery":"Monkey Beach Ko Phi Phi"}}
]}
\`\`\``;

    await withPage('assistant-identity C', { db: dbOf([mayaTrip]), stores, net: placesDouble(log) }, async (s) => {
      await paste(s, REPLY);
      await sleep(3000);
      const cards = await readCards(s);
      const maya = cards.find(c => /Maya Bay/.test(c.title));
      await t('C1: Maya Bay never wears the tour desk\'s identity',
        !maya || (!maya.chipHref.includes('PID_MAYATOURS') && !maya.linkHref.includes('PID_MAYATOURS')),
        JSON.stringify(maya), s);
      await t('C2: and it never wears the tour desk\'s rating either',
        !maya || maya.rating !== '4.6', JSON.stringify(maya), s);
      await t('C3: the other beach on the same reply is unaffected',
        cards.some(c => /Monkey Beach/.test(c.title) && c.rating === '4.2'),
        JSON.stringify(cards.map(c => c.title + ':' + c.rating)), s);
    });
  }

  /* =====================================================================
     D. A NORMAL CITY - the island work must not degrade Tokyo.
     ===================================================================== */
  freshIds();
  {
    const log = [];
    const day = '2027-03-05';
    const stay = item({
      type: 'stay', title: 'Hotel Okura Tokyo', location: 'Tokyo',
      startDate: '2027-03-04', endDate: '2027-03-08', mapsQuery: 'Hotel Okura Tokyo',
    });
    const tokyoTrip = trip({ name: 'Japan', items: [stay] });
    const stores = {
      'trip-planner:geo:v3': { tokyo: { ...TOKYO, country: 'Japan', cc: 'JP', conf: 'confident', kind: 'city' } },
    };
    const REPLY = `Two ideas for Thursday.

\`\`\`json
{"tripActions":[
 {"op":"add","discovery":{"query":"restaurants","count":2},"item":{"type":"activity","title":"Dinner: Narisawa","location":"Tokyo","startDate":"${day}","startTime":"19:00","mapsQuery":"Narisawa Tokyo","meal":"dinner"}},
 {"op":"add","item":{"type":"activity","title":"teamLab Planets TOKYO","location":"Tokyo","startDate":"${day}","startTime":"14:00","mapsQuery":"teamLab Planets TOKYO"}}
]}
\`\`\``;

    await withPage('assistant-identity D', { db: dbOf([tokyoTrip]), stores, net: placesDouble(log) }, async (s) => {
      await paste(s, REPLY);
      await waitForExpr(s, `document.querySelectorAll('#assistMessages .ap-rating[data-painted="1"]').length >= 2`, { timeout: 20000 });
      const cards = await readCards(s);
      await t('D1: an ordinary city still verifies against its own centroid',
        cards.length >= 2 && cards.every(c => c.rating), JSON.stringify(cards.map(c => c.title + ':' + c.rating)), s);
      // openApp's first navigation boots the app against whatever the previous
      // block left in localStorage, so the log legitimately holds that trip's
      // lookups too. Judge this trip's own queries.
      const sent = log.flatMap(e => e.entries)
        .filter(e => Number.isFinite(e.lat) && /tokyo/i.test(e.city || ''));
      await t('D2: and the centroid it uses is Tokyo\'s',
        sent.length > 0 && sent.every(e => km({ lat: e.lat, lon: e.lon }, TOKYO) < 20),
        JSON.stringify(sent.slice(0, 2)), s);
    });
  }

  /* =====================================================================
     E. PARTIAL FAILURE - one invented venue among the real ones.
     ===================================================================== */
  freshIds();
  {
    const log = [];
    const day = '2027-01-29';
    const stay = item({
      type: 'stay', title: 'Phi Phi Bayview Resort', location: 'Ko Phi Phi',
      startDate: '2027-01-26', endDate: '2027-01-31', mapsQuery: 'Phi Phi Bayview Resort Ko Phi Phi',
    });
    const mixedTrip = trip({ name: 'Thailand', items: [stay] });
    const stores = {
      'trip-planner:geo:v3': {
        'ko phi phi': { ...TRAT_ISLET, country: 'Thailand', cc: 'TH', conf: 'low', kind: 'islet' },
        'phi phi bayview resort': { ...PHI_PHI_HOTEL, country: 'Thailand', cc: 'TH', conf: 'confident' },
      },
    };
    const real = ['The Mango Garden', 'Garlic 1992', 'Acqua Restaurant', 'P.P. Wang Ta Fu',
      'DMC Restaurant', 'Efe Mediterranean Cuisine', 'Papaya Restaurant', "Anna's Restaurant"];
    const adds = real.map((n, i) =>
      `{"op":"add","item":{"type":"activity","title":"${n}","location":"Ko Phi Phi","startDate":"${day}","startTime":"1${i % 9}:00","mapsQuery":"${n} Ko Phi Phi"}}`);
    adds.push(`{"op":"add","item":{"type":"activity","title":"The Invented Grill","location":"Ko Phi Phi","startDate":"${day}","startTime":"20:00","mapsQuery":"The Invented Grill Ko Phi Phi"}}`);
    const REPLY = `Nine places.\n\n\`\`\`json\n{"tripActions":[\n${adds.join(',\n')}\n]}\n\`\`\``;

    await withPage('assistant-identity E', { db: dbOf([mixedTrip]), stores, net: placesDouble(log) }, async (s) => {
      await paste(s, REPLY);
      await waitForExpr(s, `document.querySelectorAll('#assistMessages .ap-rating[data-painted="1"]').length >= 8`, { timeout: 20000 });
      const cards = await readCards(s);
      await t('E1: eight real venues survive one invented one',
        cards.filter(c => c.rating).length >= 8,
        `${cards.filter(c => c.rating).length} rated of ${cards.length}`, s);
      const fake = cards.find(c => /Invented Grill/.test(c.title));
      await t('E2: the invented one is not silently swapped for a different business',
        !fake || (!fake.rating && /Not found on Google/.test(fake.none)),
        JSON.stringify(fake), s);
    });
  }

  /* =====================================================================
     G. THE LOOKUP CANNOT ANSWER - which is not a verdict about the island.
     A site with no Places key configured (the DEFAULT state of this feature)
     answers 503, so no entry can ever land in the cache. The old code polled
     it for twelve seconds anyway, rejected 100% of the candidates and told the
     traveller their destination could not be verified.
     ===================================================================== */
  freshIds();
  {
    const stay = item({
      type: 'stay', title: 'Phi Phi Bayview Resort', location: 'Ko Phi Phi',
      startDate: '2027-01-26', endDate: '2027-01-29', mapsQuery: 'Phi Phi Bayview Resort Ko Phi Phi',
    });
    const offTrip = trip({ name: 'Thailand', items: [stay] });
    const stores = {
      'trip-planner:geo:v3': {
        'ko phi phi': { ...TRAT_ISLET, country: 'Thailand', cc: 'TH', conf: 'low', kind: 'islet' },
        'phi phi bayview resort': { ...PHI_PHI_HOTEL, country: 'Thailand', cc: 'TH', conf: 'confident' },
      },
    };
    // 503 not_configured: exactly what a site with no Places key returns.
    const offNet = (url) => {
      if (!url.includes('tp-places')) return EXTERNAL_HOSTS.test(url) ? 'fail' : null;
      return { status: 503, body: { error: 'not_configured' } };
    };

    await withPage('assistant-identity G', { db: dbOf([offTrip]), stores, net: offNet }, async (s) => {
      const started = Date.now();
      await paste(s, phiPhiReply(DAY));
      await waitForExpr(s, `document.querySelectorAll('#assistMessages .assist-proposal').length >= 4`, { timeout: 20000 });
      const took = Date.now() - started;
      const note = await evaluate(s, `((document.querySelector('#assistMessages .assist-verified-note') || {}).textContent || '').trim()`);
      const cards = await readCards(s);

      await t('G1: a provider that never answered does not empty the day',
        cards.length >= 12, `${cards.length} cards rendered`, s);
      await t('G2: and it never claims the destination could not be verified',
        !/could not verify any places/i.test(note || ''), JSON.stringify(note), s);
      await t('G3: it says the CHECK did not happen, and why',
        /not switched on|could not|unconfirmed/i.test(note || ''), JSON.stringify(note), s);
      await t('G4: and it does not sit on the full verification deadline first',
        took < 12000, `${took} ms to render`, s);
    });
  }

  /* =====================================================================
     F. THE SAME ANSWER ON A PHONE.
     ===================================================================== */
  freshIds();
  {
    const log = [];
    const stay = item({
      type: 'stay', title: 'Phi Phi Bayview Resort', location: 'Ko Phi Phi',
      startDate: '2027-01-26', endDate: '2027-01-29', mapsQuery: 'Phi Phi Bayview Resort Ko Phi Phi',
    });
    const phoneTrip = trip({ name: 'Thailand', items: [stay] });
    const stores = {
      'trip-planner:geo:v3': {
        'ko phi phi': { ...TRAT_ISLET, country: 'Thailand', cc: 'TH', conf: 'low', kind: 'islet' },
        'phi phi bayview resort': { ...PHI_PHI_HOTEL, country: 'Thailand', cc: 'TH', conf: 'confident' },
      },
    };
    await withPage('assistant-identity F', {
      db: dbOf([phoneTrip]), stores, net: placesDouble(log), viewport: [390, 844],
    }, async (s) => {
      await paste(s, phiPhiReply(DAY), true);
      await waitForExpr(s, `document.querySelectorAll('#assistMessages .assist-proposal').length >= 4`, { timeout: 20000 });
      await waitForExpr(s, `document.querySelectorAll('#assistMessages .ap-rating[data-painted="1"]').length >= 8`, { timeout: 20000 });
      const overflow = await evaluate(s, `(() => {
        const bad = [];
        for (const el of document.querySelectorAll('#assistMessages .apr-chip, #assistMessages .as-title, #assistMessages .ap-title')) {
          if (el.scrollWidth > el.clientWidth + 2) bad.push((el.textContent || '').trim().slice(0, 40));
        }
        return { bad, docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
      })()`);
      await t('F1: no card content overflows a 390px viewport',
        overflow.bad.length === 0, JSON.stringify(overflow.bad).slice(0, 200), s);
      await t('F2: and the page itself never scrolls sideways',
        overflow.docOverflow <= 1, String(overflow.docOverflow), s);
      const phoneCards = await readCards(s);
      const rated = phoneCards.filter(c => c.rating);
      await t('F3: the phone gets the same verified places the desktop got',
        rated.length >= 10,
        `${rated.length} rated of ${phoneCards.length}: `
        + JSON.stringify(phoneCards.slice(0, 4).map(c => [c.title, c.rating, c.none])), s);
    });
  }

  return R;
}
