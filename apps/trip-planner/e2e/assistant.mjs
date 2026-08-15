// Trip Planner E2E: the assistant's suggestion cards.
//
// What this suite exists to pin, and why it lives in the BROWSER layer rather
// than in trip-logic's node tests: every one of these facts is the product of
// the DOM, the caches and the paint pass agreeing with each other. The pure
// origin/wording math is already pinned in trip-logic.test.js and is not
// repeated here.
//
// The reported bug it starts from: rooftop-bar suggestions for the evening of
// the hotel check-in day rendered with a rating and no distance at all, while
// the SAME venue showed "~1.3 km / 0.8 mi" the moment it was added to the
// itinerary. Three separate links had to hold for that number to appear before
// the add, and the assistant path was missing all three: it measured from the
// day's opening ANCHOR (the airport, on an arrival day) instead of from where
// the traveller is at that hour, it never asked for the origin's own venue
// coordinates, and it never loaded the airports table an arrival anchor needs.
//
// Driving: the Tier 1 copy/paste flow parses a pasted reply through exactly the
// same extract -> validate -> renderProposals -> refreshDistances path a live
// model reply takes, so the whole thing is deterministic with no network and no
// API key. External providers stay blocked (helpers' default), and the venue +
// geocode caches are seeded through TripLogic's own key functions so a cache
// entry can never drift from what the app would have written itself.
import {
  recorder, freshIds, dbOf, trip, item, iso,
  openApp, tpErrors, closePage, evaluate, clickSel, setValue, waitForExpr,
  menuAct, overlayOpenId, sleep,
} from './helpers.mjs';
import { EXTERNAL_HOSTS } from '../../../tests/browser/cdp.mjs';
import TripLogic from '../js/trip-logic.js';

// One evening's worth of suggestions on the arrival day: a bar at 20:00 and the
// ride home at 21:30, which is the pair the report was about.
const REPLY = (date) => `Two rooftop options for your first evening.

\`\`\`json
{"tripActions":[
 {"op":"add","item":{"type":"activity","title":"Drinks: Above Eleven","location":"Bangkok","startDate":"${date}","startTime":"20:00","cost":30,"costCurrency":"USD","mapsQuery":"Above Eleven Bangkok","details":"Rooftop bar in Sukhumvit."}},
 {"op":"add","item":{"type":"local","title":"Return to hotel","location":"Bangkok","startDate":"${date}","startTime":"21:30","cost":10,"costCurrency":"USD","mapsQuery":"Sotetsu Grand Fresa Bangkok"}}
]}
\`\`\``;

// Five candidates for one slot: the free-form "give me 5 options, not 3" case.
// Nothing between the model and the card may quietly cut it back to three.
const FIVE_REPLY = (date) => `Five rooftop options, as asked.

\`\`\`json
{"tripActions":[
 {"op":"add","group":"drinks-${date}","item":{"type":"activity","title":"Drinks: One","location":"Bangkok","startDate":"${date}","startTime":"20:00","mapsQuery":"Gaggan Bangkok"}},
 {"op":"add","group":"drinks-${date}","item":{"type":"activity","title":"Drinks: Two","location":"Bangkok","startDate":"${date}","startTime":"20:00","mapsQuery":"Bo.lan Bangkok"}},
 {"op":"add","group":"drinks-${date}","item":{"type":"activity","title":"Drinks: Three","location":"Bangkok","startDate":"${date}","startTime":"20:00","mapsQuery":"Nahm Bangkok"}},
 {"op":"add","group":"drinks-${date}","item":{"type":"activity","title":"Drinks: Four","location":"Bangkok","startDate":"${date}","startTime":"20:00","mapsQuery":"Above Eleven Bangkok"}},
 {"op":"add","group":"drinks-${date}","item":{"type":"activity","title":"Drinks: Five","location":"Bangkok","startDate":"${date}","startTime":"20:00","mapsQuery":"${HOTEL}"}}
]}
\`\`\``;

// Three candidates for one slot, so the alternative-set card is covered too.
const SET_REPLY = (date) => `Pick a dinner.

\`\`\`json
{"tripActions":[
 {"op":"add","group":"dinner-${date}","item":{"type":"activity","title":"Dinner: Gaggan","location":"Bangkok","startDate":"${date}","startTime":"19:00","mapsQuery":"Gaggan Bangkok"}},
 {"op":"add","group":"dinner-${date}","item":{"type":"activity","title":"Dinner: Bo.lan","location":"Bangkok","startDate":"${date}","startTime":"19:00","mapsQuery":"Bo.lan Bangkok"}},
 {"op":"add","group":"dinner-${date}","item":{"type":"activity","title":"Dinner: Nahm","location":"Bangkok","startDate":"${date}","startTime":"19:00","mapsQuery":"Nahm Bangkok"}}
]}
\`\`\``;

const HOTEL = 'Sotetsu Grand Fresa Bangkok';

// A realistic airline confirmation (same shape the booking-extract node tests
// pin) for the import-dialog scoping block: it must read as ONE flight card.
const BOOKING_TEXT = `British Airways - Electronic Ticket Receipt
Booking reference: XJ7K2Q
Passenger: MR A TRAVELLER

Flight BA 179
London Heathrow (LHR) to New York JFK (JFK)
Departs: Sat, 12 Aug 2027 at 21:30
Arrives: Sun, 13 Aug 2027 at 06:45
Cabin: World Traveller Plus
Total fare: GBP 812.40`;

// Coordinates are seeded, never fetched: Photon and tp-places are both refused
// by the default network rule, which is also the honest offline scenario.
//
// They go in through openApp's `stores`, BEFORE the app's first boot, and the
// cache keys are computed here in Node with the app's own placeCacheKey. Both
// details are load-bearing. These caches are read into closure state exactly
// once at load, so warming them afterwards needs a full reload - and that
// flakes, because `waitReady` cannot tell a reloaded page from the one already
// open: a reload that did not take left the app holding EMPTY caches while
// localStorage looked perfectly warm, which no read-back of localStorage can
// detect. And `at` (not `t`) is the freshness field normalizeVenueCache reads;
// the wrong field name silently empties the whole store.
const VENUES = {
  [HOTEL]: [13.7390, 100.5600],
  'Above Eleven Bangkok': [13.7430, 100.5560],
  'Gaggan Bangkok': [13.7420, 100.5480],
  'Bo.lan Bangkok': [13.7180, 100.5820],
  'Nahm Bangkok': [13.7250, 100.5410],
};
const CITIES = { bangkok: [13.7563, 100.5018] };

function distanceStores({ venues = VENUES, cities = CITIES } = {}) {
  const geo = {};
  for (const [k, v] of Object.entries(cities)) geo[k] = { lat: v[0], lon: v[1], country: 'Thailand', conf: 'confident' };
  const venue = {};
  // Stamped with the run's own clock, never a fixture constant: a venue entry
  // expires after 30 days, and a frozen timestamp would rot the suite silently.
  const now = Date.now();
  for (const [q, v] of Object.entries(venues)) venue[TripLogic.placeCacheKey(q)] = { lat: v[0], lon: v[1], at: now };
  return { 'trip-planner:geo:v3': geo, 'trip-planner:venuegeo:v1': venue };
}

// A Bangkok trip whose first day is BOTH the arrival and the check-in: the
// exact shape the report came from.
function bangkokTrip(base = 30) {
  return trip({
    name: 'Bangkok E2E',
    items: [
      item({ type: 'flight', title: 'Tokyo (HND) to Bangkok (BKK)', startDate: iso(base), startTime: '09:00', endTime: '13:30', status: 'booked' }),
      item({ type: 'stay', title: HOTEL, location: 'Bangkok', startDate: iso(base), endDate: iso(base + 4), status: 'booked' }),
    ],
  });
}

async function pasteReply(s, text, cards) {
  await setValue(s, '#assistPasteBox', text);
  await clickSel(s, '#assistPasteParse', { settle: 400 });
  // The cards are the precondition for everything below, so wait for THEM
  // rather than for a fixed settle: a chip assertion that fires before the
  // reply was parsed at all reads as a distance bug and is not one.
  return waitForExpr(s, `document.querySelectorAll('#assistMessages .assist-proposal').length === ${cards}`, { timeout: 8000 });
}

const chips = (s) => evaluate(s, `[...document.querySelectorAll('#assistMessages .ap-dist')]
  .map(e => ({ text: e.textContent, title: e.title || '', label: e.dataset.distLabel || '', time: e.dataset.distTime || '' }))`);

// Everything a proposal card actually SHOWS, which is the level the audit has
// to happen at: a rating chip and a Maps action are the two things a leg was
// wrongly borrowing from a venue recommendation.
const cardFaces = (s) => evaluate(s, `[...document.querySelectorAll('#assistMessages .assist-proposal')].map(c => ({
  type: c.dataset.type || '',
  title: (c.querySelector('.ap-title, .as-lead') || {}).textContent || '',
  cost: (c.querySelector('.ap-cost') || {}).textContent || '',
  dist: (c.querySelector('.ap-dist') || {}).textContent || '',
  ratingSlots: c.querySelectorAll('.ap-rating').length,
  ratingShown: [...c.querySelectorAll('.apr-chip')].length,
  action: (c.querySelector('.assist-maps-link') || {}).textContent || '',
  href: (c.querySelector('.assist-maps-link') || {}).href || '',
}))`);

// An empty chip has three possible causes and they need different fixes, so a
// failure says which: no origin at all, an origin nothing could locate, or a
// stop nothing could locate. Recomputed in-page from TripLogic and the two
// caches, which is exactly what the paint pass reads. Computed only when a
// check has already failed, so a green run pays nothing for it.
const originDiag = (s, time) => evaluate(s, `(() => {
  const db = JSON.parse(localStorage.getItem('trip-planner:v1') || 'null');
  const trip = db && db.trips.find(x => x.id === db.activeTripId);
  const items = trip ? trip.items : [];
  const date = (document.querySelector('#assistMessages .assist-proposal') || { dataset: {} }).dataset.date || '';
  const venue = JSON.parse(localStorage.getItem('trip-planner:venuegeo:v1') || '{}');
  const geo = JSON.parse(localStorage.getItem('trip-planner:geo:v3') || '{}');
  const o = TripLogic.proposalOrigin(items, date, ${JSON.stringify(time)});
  const q = o && o.item ? TripLogic.itemMapsQuery(o.item) : '';
  return 'DIAG=' + JSON.stringify({
    build: window.__TP_BUILD, date, items: items.length,
    origin: o ? o.source + ':' + o.label : null,
    originVenue: q ? !!venue[TripLogic.placeCacheKey(q)] : null,
    originCity: o ? !!(geo[String(o.city || '').toLowerCase()] || {}).lat : null,
    venueKeys: Object.keys(venue).length, geoKeys: Object.keys(geo).length,
  });
})()`);

// A chip can legitimately arrive a beat late: the origin's own venue lookup and
// the airports table an arrival anchor needs both repaint when they land. What
// must never happen is that it never arrives, so the positive assertions wait
// for paint and the negative ones (no coordinates at all) read straight away.
const waitForChips = (s, n) => waitForExpr(s,
  `[...document.querySelectorAll('#assistMessages .ap-dist')].filter(e => e.textContent.trim()).length === ${n}`,
  { timeout: 8000 });

export async function run({ base, cdpPort }) {
  const R = [];
  const t = recorder(R);
  // Every page is closed in a finally. closePage takes (cdpPort, session);
  // calling it with one argument used to be a silent no-op that leaked all of
  // this suite's tabs into every later suite (same profile = same
  // localStorage, so a leaked tab's storage listener reacts to later seeds
  // and its ensureTrip can write over them).
  const done = async (s) => { if (s) { try { await closePage(cdpPort, s); } catch { /* gone */ } } };
  const noErrors = (label, s) => t(`${label}: no page errors`, tpErrors(s).length === 0, tpErrors(s).slice(0, 2).join(' | '), s);

  let s = null;
  const day = iso(30); // the trip's arrival + check-in day, shared by most blocks
  try {
    // ---------------------------------------------------------------------
    // 1. A suggestion carries its distance BEFORE anything is added, measured
    //    from the hotel rather than from the airport the day opened at.
    freshIds();
    s = await openApp(cdpPort, base, { db: dbOf([bangkokTrip()]), stores: distanceStores() });

    await clickSel(s, '#assistBtn', { settle: 700 });
    const focus = await evaluate(s, `document.getElementById('assistPanel').dataset.focusDate || ''`);
    await t('tp-assist: the panel opens focused on the trip first day', focus === day, `focus=${focus} want=${day}`, s);

    const parsed = await pasteReply(s, REPLY(day), 2);
    await t('tp-assist: a pasted reply renders one card per suggestion', parsed, '', s);
    const allPainted = await waitForChips(s, 2);
    let painted = await chips(s);
    await t('tp-assist: every located suggestion in the reply ends up with a chip',
      allPainted, JSON.stringify(painted) + (allPainted ? '' : ' ' + await originDiag(s, '20:00')), s);
    const bar = painted.find(c => c.label === 'Drinks: Above Eleven');
    await t('tp-assist: a suggestion shows its distance before it is added',
      !!bar && bar.text.includes('km /') && bar.text.includes('mi'),
      JSON.stringify(painted), s);
    // hotel -> recommended bar: the traveller reads a TIME first, then how far,
    // then from where. All three are on the card itself, not in a tooltip.
    await t('tp-assist: the chip leads with an estimated travel time, spelled in minutes',
      !!bar && /^(\u{1F6B6}|\u{1F695}) ~\d+ (min|hr)/u.test(bar.text) && /(walk|by taxi)/.test(bar.text)
        && !/~\d+m\b/.test(bar.text),
      JSON.stringify(bar && bar.text), s);
    // The whole point of the report: the origin is NAMED on the card, and it is
    // the hotel, not the airport the arrival-day anchor would have given.
    await t('tp-assist: the chip names the hotel it is measured from',
      !!bar && bar.text.includes(`from ${HOTEL}`), JSON.stringify(bar), s);
    await t('tp-assist: the tooltip keeps the straight-line caveat and adds a travel estimate',
      !!bar && /straight-line from /.test(bar.title) && /not a walking route/.test(bar.title)
        && /on foot|by taxi/.test(bar.title) && /not live traffic/.test(bar.title),
      JSON.stringify(bar && bar.title), s);

    // The ride home is the leg FROM the bar, not a zero-length hop from the
    // hotel it ends at, so it is measured against the 20:00 suggestion above it.
    const home = painted.find(c => c.label === 'Return to hotel');
    await t('tp-assist: return-to-hotel measures from the venue chosen earlier that evening',
      !!home && home.text.includes('from Drinks: Above Eleven'), JSON.stringify(home), s);

    // selected bar -> hotel. A leg is not a venue anyone is choosing between,
    // so it must not wear a venue's clothes: no star rating (the reported card
    // carried the hotel's own 4.8 (958), which reads as a recommendation for
    // the ride home), and its Maps action is DIRECTIONS rather than a listing.
    const faces = await cardFaces(s);
    const legCard = faces.find(f => f.type === 'local');
    const placeCard = faces.find(f => f.type === 'activity');
    await t('tp-assist: a travel leg carries no rating slot at all',
      !!legCard && legCard.ratingSlots === 0 && legCard.ratingShown === 0, JSON.stringify(legCard), s);
    await t('tp-assist: a travel leg offers directions, not a place listing',
      !!legCard && /Directions/.test(legCard.action) && legCard.href.includes('/maps/dir/')
        && legCard.href.includes('destination=Sotetsu'),
      JSON.stringify(legCard && { a: legCard.action, h: legCard.href }), s);
    // ...and it routes FROM where the leg actually starts, in the mode the chip
    // just named, so the card cannot promise a walk and hand over driving
    await t('tp-assist: the directions start where the leg starts and match the named mode',
      !!legCard && legCard.href.includes('origin=Above%20Eleven%20Bangkok')
        && legCard.href.includes('travelmode=walking'),
      JSON.stringify(legCard && legCard.href), s);
    // a real venue recommendation is untouched: it still gets both
    await t('tp-assist: a venue recommendation keeps its rating slot and place link',
      !!placeCard && placeCard.ratingSlots === 1 && /Google Maps/.test(placeCard.action)
        && !placeCard.href.includes('/maps/dir/'),
      JSON.stringify(placeCard && { r: placeCard.ratingSlots, a: placeCard.action }), s);
    // the leg's own estimated fare is legitimate and stays: unlike a rating, a
    // taxi fare is a fact ABOUT THE LEG rather than a verdict on a venue
    await t('tp-assist: a travel leg still shows its own estimated cost',
      !!legCard && /10/.test(legCard.cost), JSON.stringify(legCard && legCard.cost), s);

    // ---------------------------------------------------------------------
    // 2. The figure shown BEFORE the add is the figure the itinerary shows
    //    after it. Both sides walk the same day in the same time order through
    //    the same builder, so this is the property that makes the pre-add
    //    number trustworthy rather than a second, drifting estimate.
    const beforeKm = (bar && bar.text.match(/~([\d.]+) km/) || [])[1];
    await clickSel(s, '.assist-proposal[data-op="add"] [data-act="accept-proposal"]', { settle: 900 });
    const accepted = await evaluate(s, `(() => {
      const db = JSON.parse(localStorage.getItem('trip-planner:v1') || 'null');
      const trip = db && db.trips.find(x => x.id === db.activeTripId);
      const it = trip && trip.items.find(i => (i.title || '').includes('Above Eleven'));
      return it ? { date: it.startDate, time: it.startTime, maps: it.mapsQuery || '' } : null;
    })()`);
    await t('tp-assist: accepting the card puts it on the trip with its place intact',
      !!accepted && accepted.time === '20:00' && accepted.maps === 'Above Eleven Bangkok',
      JSON.stringify(accepted), s);

    await clickSel(s, '#viewDays', { settle: 900 });
    const dayChip = await evaluate(s, `(() => {
      const row = [...document.querySelectorAll('#daysList .dc-event[data-dist-label]')]
        .find(r => (r.dataset.distLabel || '').includes('Above Eleven'));
      const chip = row && row.querySelector('.dc-dist');
      return chip ? { text: chip.textContent, title: chip.title || '' } : null;
    })()`);
    const afterKm = (dayChip && dayChip.text.match(/~([\d.]+) km/) || [])[1];
    await t('tp-assist: the itinerary distance agrees with the one shown before the add',
      !!beforeKm && beforeKm === afterKm, `before=${beforeKm} after=${afterKm} ${JSON.stringify(dayChip)}`, s);
    await t('tp-assist: the itinerary chip names the same origin in its tooltip',
      !!dayChip && dayChip.title.includes(HOTEL), JSON.stringify(dayChip && dayChip.title), s);
    await noErrors('tp-assist 1-2', s);
  } catch (err) {
    await t('tp-assist: blocks 1-2 ran', false, String(err && err.message || err), s);
  } finally {
    await done(s); s = null;
  }

  try {
    // ---------------------------------------------------------------------
    // 2b. previous activity -> next recommendation. The third origin the report
    //     asked about: something already ON the itinerary earlier that day, not
    //     the hotel and not another suggestion.
    freshIds();
    const withLunch = bangkokTrip();
    withLunch.items.push(item({
      type: 'activity', title: 'Lunch: Jay Fai', location: 'Bangkok', mapsQuery: 'Gaggan Bangkok',
      startDate: iso(31), startTime: '14:00', status: 'to-book',
    }));
    s = await openApp(cdpPort, base, { db: dbOf([withLunch]), stores: distanceStores() });
    await clickSel(s, '#assistBtn', { settle: 700 });
    // a day INSIDE the stay, so the hotel is the fallback and the lunch is the
    // thing that has to beat it
    await evaluate(s, `(() => {
      const sel = document.getElementById('planDaySelect');
      sel.value = ${JSON.stringify(iso(31))};
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return 1;
    })()`);
    await pasteReply(s, REPLY(iso(31)), 2);
    await waitForChips(s, 2);
    const afterLunch = await chips(s);
    const evening = afterLunch.find(c => c.label === 'Drinks: Above Eleven');
    await t('tp-assist: a suggestion after an existing plan measures from that plan',
      !!evening && evening.text.includes('from Lunch: Jay Fai'), JSON.stringify(afterLunch), s);
    // and the morning is still measured from the bed, not forward to lunch
    await evaluate(s, `document.getElementById('assistMessages').innerHTML = ''`);
    await pasteReply(s, REPLY(iso(31)).replace(/20:00/, '09:00').replace(/21:30/, '10:30'), 2);
    await waitForChips(s, 2);
    const morning = await chips(s);
    await t('tp-assist: a suggestion BEFORE that plan falls back to the bed, not forward',
      morning.some(c => c.text.includes(`from ${HOTEL}`)), JSON.stringify(morning), s);
    await noErrors('tp-assist 2b', s);
  } catch (err) {
    await t('tp-assist: block 2b ran', false, String(err && err.message || err), s);
  } finally {
    await done(s); s = null;
  }

  try {
    // ---------------------------------------------------------------------
    // 3. No coordinates for anything: no chip, no invented number, no crash.
    freshIds();
    s = await openApp(cdpPort, base, { db: dbOf([bangkokTrip()]), stores: distanceStores({ venues: {}, cities: {} }) });
    await clickSel(s, '#assistBtn', { settle: 700 });
    await pasteReply(s, REPLY(day), 2);
    const painted = await chips(s);
    await t('tp-assist: with no located places at all every chip stays empty',
      painted.length === 2 && painted.every(c => c.text === ''), JSON.stringify(painted), s);
    await t('tp-assist: the cards themselves still render without coordinates',
      (await evaluate(s, `document.querySelectorAll('#assistMessages .assist-proposal').length`)) === 2, '', s);
    await noErrors('tp-assist 3', s);
  } catch (err) {
    await t('tp-assist: block 3 ran', false, String(err && err.message || err), s);
  } finally {
    await done(s); s = null;
  }

  try {
    // Both ends falling back to the SAME city centroid is not a distance: the
    // old behaviour printed nothing here too, and it must keep printing nothing
    // rather than "0.0 km".
    freshIds();
    s = await openApp(cdpPort, base, { db: dbOf([bangkokTrip()]), stores: distanceStores({ venues: {} }) });
    await clickSel(s, '#assistBtn', { settle: 700 });
    await pasteReply(s, REPLY(day), 2);
    const painted = await chips(s);
    await t('tp-assist: two ends on the same city centroid print no fake 0.0 km',
      painted.length === 2 && painted.every(c => !c.text.includes('0.0 km')), JSON.stringify(painted), s);
    await noErrors('tp-assist 3b', s);
  } catch (err) {
    await t('tp-assist: block 3b ran', false, String(err && err.message || err), s);
  } finally {
    await done(s); s = null;
  }

  try {
    // ---------------------------------------------------------------------
    // 4. An alternative set: every candidate carries its own chip, all three
    //    measured from the same slot origin, and the set is ONE stop on the
    //    route rather than three.
    freshIds();
    s = await openApp(cdpPort, base, { db: dbOf([bangkokTrip()]), stores: distanceStores() });
    await clickSel(s, '#assistBtn', { settle: 700 });
    // one card, three candidate rows inside it
    await pasteReply(s, SET_REPLY(day), 1);
    const setPainted = await waitForChips(s, 3);
    const painted = await chips(s);
    const setOk = setPainted && painted.length === 3 && painted.every(c => c.text.includes('km /'));
    await t('tp-assist: all three candidates of a slot carry a distance', setOk,
      JSON.stringify(painted) + (setOk ? '' : ' ' + await originDiag(s, '19:00')), s);
    await t('tp-assist: candidates of one slot all measure from the same origin',
      painted.every(c => c.text.includes(`from ${HOTEL}`)), JSON.stringify(painted.map(c => c.text)), s);
    const km = painted.map(c => (c.text.match(/~([\d.]+) km/) || [])[1]);
    await t('tp-assist: the candidates are measured individually, not given one shared figure',
      new Set(km).size === 3, JSON.stringify(km), s);

    // A reply carrying FIVE candidates for one slot renders five, both as
    // pickable options and as measured cards. Nothing between the model and the
    // card is allowed to trim a free-form "give me 5 options" back to three.
    await evaluate(s, `document.getElementById('assistMessages').innerHTML = ''`);
    await pasteReply(s, FIVE_REPLY(day), 1);
    const five = await evaluate(s, `(() => {
      const card = document.querySelector('#assistMessages .assist-set');
      return card ? {
        options: card.querySelectorAll('.as-opt').length,
        radios: card.querySelectorAll('input[type="radio"]').length,
        titles: [...card.querySelectorAll('.as-title')].map(e => e.textContent).length,
      } : null;
    })()`);
    await t('tp-assist: five candidates for one slot render as five pickable options',
      !!five && five.options === 5 && five.radios === 5, JSON.stringify(five), s);
    // ...and each is measured in its own right. The fifth is the hotel itself,
    // which correctly gets no chip: a zero-length hop is not a distance.
    await waitForChips(s, 4);
    const fiveChips = await evaluate(s, `[...document.querySelectorAll('#assistMessages .ap-dist')].map(e => e.textContent)`);
    await t('tp-assist: every located candidate of a five-option slot is measured',
      fiveChips.length === 5 && fiveChips.filter(x => x.includes('km /')).length === 4,
      JSON.stringify(fiveChips), s);
    await noErrors('tp-assist 4', s);
  } catch (err) {
    await t('tp-assist: block 4 ran', false, String(err && err.message || err), s);
  } finally {
    await done(s); s = null;
  }

  try {
    // ---------------------------------------------------------------------
    // 5. The chip names its origin, and a hotel name is long: on a 390px panel
    //    it has to wrap inside the card rather than run off the edge.
    freshIds();
    s = await openApp(cdpPort, base, { db: dbOf([bangkokTrip()]), viewport: [390, 844], stores: distanceStores() });
    await clickSel(s, '#assistBtn', { settle: 700 });
    await pasteReply(s, REPLY(day), 2);
    await waitForChips(s, 2);
    const fit = await evaluate(s, `(() => {
      const els = [...document.querySelectorAll('#assistMessages .ap-dist')];
      const panel = document.getElementById('assistPanel').getBoundingClientRect();
      return {
        overflowing: els.filter(e => e.scrollWidth - e.clientWidth > 1).length,
        outside: els.filter(e => e.getBoundingClientRect().right > panel.right + 1).length,
        wrapped: els.filter(e => e.getBoundingClientRect().height > 20).length,
        n: els.length,
      };
    })()`);
    await t('tp-assist: on a 390px panel the chip wraps instead of overflowing its card',
      fit.n === 2 && fit.overflowing === 0 && fit.outside === 0, JSON.stringify(fit), s);
    await noErrors('tp-assist 5', s);
  } catch (err) {
    await t('tp-assist: block 5 ran', false, String(err && err.message || err), s);
  } finally {
    await done(s); s = null;
  }

  try {
    // ---------------------------------------------------------------------
    // 6. Guided vs free-form, end to end and over the wire. The picker's option
    //    counts are a property of the PICKER, and the composer must not inherit
    //    them: "Give me 5 options, not 3" was answered with "my instructions
    //    require exactly 3 options for each meal or drinks slot" because both
    //    paths built one shared system prompt. The mode now rides on the
    //    request, per turn, and this reads it off the actual POST body.
    freshIds();
    const posts = [];
    const tierNet = (url, req) => {
      if (!url.includes('/.netlify/functions/tp-assist')) return EXTERNAL_HOSTS.test(url) ? 'fail' : null;
      if (req.method === 'POST' && req.postData) {
        try { posts.push(JSON.parse(req.postData)); } catch { posts.push({ unparsed: true }); }
      }
      return { status: 200, body: { reply: 'Here you go.' } };
    };
    s = await openApp(cdpPort, base, { db: dbOf([bangkokTrip()]), net: tierNet, stores: distanceStores() });
    await clickSel(s, '#assistBtn', { settle: 700 });
    await clickSel(s, '#assistTierGroup input[value="site"]', { settle: 600 });

    // `posts` fills in NODE (the net rule runs here), so the wait is two-part:
    // the captured request count is polled in Node, and the page is only read
    // once its typing indicator is gone. The old wait interpolated
    // `${posts.length} >= 0` into the page expression, a dead always-true
    // conjunct evaluated at build time.
    const waitPosts = async (n, timeout = 12000) => {
      const t0 = Date.now();
      while (posts.length < n && Date.now() - t0 < timeout) await sleep(200);
      return posts.length >= n;
    };
    await clickSel(s, '[data-plan-send]', { settle: 400 });
    const gotPlanPost = await waitPosts(1);
    await waitForExpr(s, `!document.querySelector('.assist-typing')`, { timeout: 12000 });
    await t('tp-assist: the Plan my day picker POSTs to the site tier', gotPlanPost, `posts=${posts.length}`, s);
    const planned = posts[posts.length - 1] || {};
    const planCtx = planned.tripContext || {};
    await t('tp-assist: the Plan my day picker sends the guided contract',
      planCtx.mode === 'plan', JSON.stringify(planCtx.mode), s);
    // ...and the origin the cards are measured from rides along, so the model's
    // prose and the chips cannot disagree about where the day starts
    await t('tp-assist: the request carries the origin the cards measure from',
      !!planCtx.origin && planCtx.origin.label === HOTEL && planCtx.origin.source === 'stay',
      JSON.stringify(planCtx.origin), s);

    await setValue(s, '#assistInput', 'Give me 5 options, not 3.');
    await clickSel(s, '#assistSend', { settle: 400 });
    const gotChatPost = await waitPosts(2);
    await waitForExpr(s, `!document.querySelector('.assist-typing')`, { timeout: 12000 });
    const typed = posts[posts.length - 1] || {};
    await t('tp-assist: a typed message is free-form, whatever the picker sent before it',
      gotChatPost && (typed.tripContext || {}).mode === 'chat', JSON.stringify((typed.tripContext || {}).mode), s);
    await t('tp-assist: both turns went through the same endpoint', posts.length >= 2, `posts=${posts.length}`, s);
    await noErrors('tp-assist 6', s);
  } catch (err) {
    await t('tp-assist: block 6 ran', false, String(err && err.message || err), s);
  } finally {
    await done(s); s = null;
  }

  try {
    // ---------------------------------------------------------------------
    // 7. Scoping: the booking-import dialog renders the SAME proposal cards
    //    for a flight read off a confirmation, and a distance from an
    //    itinerary hotel would be a number about nothing there. The paint pass
    //    targets '#assistMessages .assist-proposals' only (app.js
    //    refreshAssistDistances), and this drives the dialog for real to pin
    //    it: warm caches, an itinerary to measure from, cards on screen -
    //    and still no chip anywhere in the dialog or the document.
    freshIds();
    s = await openApp(cdpPort, base, { db: dbOf([bangkokTrip()]), stores: distanceStores() });
    await menuAct(s, 'import-booking');
    await t('tp-assist: the booking-import dialog opens', (await overlayOpenId(s)) === 'importBookingOverlay', '', s);
    await setValue(s, '#importBookingPaste', BOOKING_TEXT);
    // the paste box debounces 400ms, then extraction loads the airports table
    const gotCard = await waitForExpr(s,
      `document.querySelectorAll('#importBookingResult .assist-proposal').length >= 1`, { timeout: 10000 });
    const face = await evaluate(s, `(() => {
      const c = document.querySelector('#importBookingResult .assist-proposal');
      return c ? { type: c.dataset.type || '', title: (c.querySelector('.ap-title') || {}).textContent || '' } : null;
    })()`);
    await t('tp-assist: a pasted confirmation renders a proposal card in the dialog',
      gotCard && !!face && face.type === 'flight' && /LHR.*JFK/.test(face.title), JSON.stringify(face), s);
    // Every proposal card carries an EMPTY .ap-dist scaffold span
    // (proposalDistHtml); the paint pass fills only the ones under
    // #assistMessages. So the honest claim is about painted TEXT, not about
    // the element existing.
    const chipCounts = await evaluate(s, `({
      dialogPainted: [...document.querySelectorAll('#importBookingResult .ap-dist')].filter(e => e.textContent.trim()).length,
      anywherePainted: [...document.querySelectorAll('.ap-dist')].filter(e => e.textContent.trim()).length,
    })`);
    await t('tp-assist: nothing paints chips outside the assistant log',
      !!chipCounts && chipCounts.dialogPainted === 0 && chipCounts.anywherePainted === 0, JSON.stringify(chipCounts), s);

    // cleanErrors is synchronous (it filters the session's error buffer);
    // aligned with the other suites, no await.
    const errs = tpErrors(s);
    await t('tp-assist: no page errors across the suite', errs.length === 0, errs.join(' | '), s);
  } catch (err) {
    await t('tp-assist: block 7 ran', false, String(err && err.message || err), s);
  } finally {
    await done(s); s = null;
  }
  return R;
}
