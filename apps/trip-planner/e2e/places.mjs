// Trip Planner E2E: the Google Places ratings subsystem.
//
//   P0. ratings on the itinerary are ON DEMAND: opening Timeline or Days
//       bills nothing; one place per "Check rating"; a confirmed bulk load
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
  clickSel, gotoHard, menuAct, setValue, loadAllRatings,
} from './helpers.mjs';
import { EXTERNAL_HOSTS } from '../../../tests/browser/cdp.mjs';

const PLACES = '/.netlify/functions/tp-places';

// A recording mock of tp-places. `mode` decides what the server says; `log`
// accumulates one entry per POST so a block can assert on the exact fanout.
function placesMock(log, mode = 'ok', budget = { left: 500 }) {
  let granted = 0;
  return (url, request) => {
    if (!url.includes('tp-places')) return EXTERNAL_HOSTS.test(url) ? 'fail' : null;
    let body = {};
    try { body = JSON.parse(request.postData || '{}'); } catch { /* recorded as empty */ }
    // The bulk warning's "how many lookups are left?" question. It spends
    // nothing, so it is answered from `budget` (mutable per block) and never
    // lands in `log`: every count below is about lookups.
    if (body.budget === true) {
      budget.asked = (budget.asked || 0) + 1;
      return { status: 200, body: { left: budget.left, scope: 'free_month', resetAt: Date.UTC(2026, 9, 1, 8) } };
    }
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
// Walk the board past the viewport in steps, the way a reader does.
//
// This used to be a single `window.scrollTo(0, document.body.scrollHeight)`,
// and that is not "scrolling the board": it teleports to the bottom of the
// DOCUMENT in one frame. The rating slots hydrate from an IntersectionObserver,
// which only fires for elements that actually intersect the viewport, so a
// one-frame jump past forty venues hydrates none of them. It passed only
// because the page happened to be short enough that the last venues were still
// on screen once you hit the bottom. Adding ANY content below the board (a
// sentence to the .app-about block was enough) pushed them out of view and the
// suite reported "scrolling fetches nothing", which looked like an app bug and
// was a test-mechanism bug.
//
// Stepping by viewport instead is both faithful to a real reader and immune to
// whatever sits below the board. The pause per step gives the observer a frame
// to fire in.
const scrollBoardToEnd = async (s) => {
  const viewport = Math.max(200, Number(await evaluate(s, 'window.innerHeight')) || 800);
  const end = Math.max(0, Number(await evaluate(s, `(() => {
    const b = document.getElementById('board');
    if (!b) return document.body.scrollHeight;
    return Math.ceil(window.scrollY + b.getBoundingClientRect().bottom);
  })()`)) || 0);
  // 80% of a viewport per step leaves a band of overlap, so nothing can sit
  // between two steps without ever intersecting. The iteration cap is a
  // seatbelt: a bad measurement must slow one check down, never hang a suite.
  const stride = Math.max(100, Math.floor(viewport * 0.8));
  const steps = Math.min(60, Math.ceil(end / stride) + 1);
  for (let i = 1; i <= steps; i += 1) {
    await evaluate(s, `window.scrollTo(0, ${i * stride})`);
    await sleep(90);
  }
  return evaluate(s, 'window.scrollY');
};

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

  /* ------- P0. Google ratings on the itinerary are ON DEMAND (2026-09-28) --
     Owner request: nothing is looked up until the traveller asks, and the
     normal way to ask is ONE place at a time (each row's "Check rating").
     The toolbar's "Load all Google ratings" is the bulk option and confirms
     how many lookups it will make before it sends any. Every count here is
     scoped to this block's own venues (the leaked-tab trap in FINDINGS: the
     first navigation boots the PREVIOUS suite's trip, whose typed stays are
     legitimately anchored on load). */
  freshIds();
  {
    const log = [];
    const P0 = 'ZuluVenue';
    const big = venueTrip(30, 'On-demand trip', P0);
    // The same venue three more times: one place on the page, one lookup.
    for (let i = 0; i < 3; i++) {
      big.items.push(item({ type: 'activity', title: `${P0} 01`, location: 'Tokyo', startDate: iso(10), startTime: `${String(18 + i)}:30` }));
    }
    const q0 = () => totals(log, P0);
    // Every row's control, keyed by the venue it names.
    const controls = (s, root = '#board') => evaluate(s, `[...document.querySelectorAll('${root} .tpm-check[data-place-key]')].map(b => ({
      key: b.dataset.placeKey, state: b.dataset.state, text: b.textContent.trim(), hidden: b.hidden, disabled: b.disabled,
      rating: ((b.previousElementSibling && b.previousElementSibling.querySelector('.tpm-score')) || {}).textContent || '' }))`);
    const clickCheck = (s, venue, root = '#board') => evaluate(s, `(() => {
      const b = [...document.querySelectorAll('${root} .tpm-check[data-place-key]')].find(x => x.dataset.placeKey.startsWith(${JSON.stringify(venue.toLowerCase())}));
      if (!b) return false; b.click(); return true; })()`);
    const bulk = (s) => evaluate(s, `(() => { const b = document.getElementById('ratingsLoadAll');
      return { hidden: b.hidden, disabled: b.disabled, text: b.innerText.replace(/\\s+/g, ' ').trim() }; })()`);
    const confirmOpen = (s) => evaluate(s, `document.getElementById('confirmOverlay').classList.contains('open')`);

    const budget0 = { left: 500 };
    await withPage('tp-places P0', { db: dbOf([big]), net: placesMock(log, 'ok', budget0) }, async (s) => {
      await waitForExpr(s, `document.querySelectorAll('#board .tpm-check[data-place-key]').length >= 33`, { timeout: 12000 });
      await sleep(1500);
      let c = await controls(s);
      await t('tp-places P0 (1): opening Timeline makes ZERO Places requests',
        q0().queries === 0, JSON.stringify(q0()), s);
      await t('tp-places P0: every row offers "Check rating" beside its plain Google Maps link',
        c.length === 33 && c.every(x => x.state === 'idle' && x.text === '☆ Check rating' && !x.hidden && !x.rating),
        JSON.stringify(c.slice(0, 2)), s);
      await scrollBoardToEnd(s);
      await sleep(1000);
      await evaluate(s, 'window.scrollTo(0, 0)');
      await t('tp-places P0: scrolling the whole Timeline asks for nothing',
        q0().queries === 0, JSON.stringify(q0()), s);
      await switchView(s, 'days');
      await sleep(1200);
      await t('tp-places P0 (2): opening Days makes ZERO Places requests',
        q0().queries === 0 && (await controls(s, '#daysList')).every(x => x.state === 'idle'), JSON.stringify(q0()), s);
      await switchView(s, 'map');
      await t('tp-places P0: the Map has no rows, so no bulk button',
        (await bulk(s)).hidden === true, '', s);
      await switchView(s, 'timeline');
      await sleep(600);

      /* one place, then another */
      await clickCheck(s, `${P0} 05`);
      await waitForExpr(s, `!!document.querySelector('#board .tp-maps-link .tpm-rating')`, { timeout: 8000 });
      await sleep(400);
      let asked = log.flatMap(e => e.queries).filter(q => q.includes(P0));
      await t('tp-places P0 (3): Check rating on one place looks up exactly that place',
        asked.length === 1 && /ZuluVenue 05/.test(asked[0]), JSON.stringify(asked), s);
      c = await controls(s);
      const five = c.filter(x => x.key.startsWith('zuluvenue 05'));
      await t('tp-places P0: that row now reads Google Maps · ⭐ rating, and its control is gone',
        five.length === 1 && five[0].hidden && /^\d\.\d$/.test(five[0].rating), JSON.stringify(five), s);
      await t('tp-places P0 (4): every other place stays unloaded',
        c.filter(x => !x.key.startsWith('zuluvenue 05')).every(x => x.state === 'idle' && !x.rating), '', s);
      await clickCheck(s, `${P0} 09`);
      await sleep(1200);
      asked = log.flatMap(e => e.queries).filter(q => q.includes(P0));
      await t('tp-places P0 (5): Check rating on another place looks up only that one',
        asked.length === 2 && /ZuluVenue 09/.test(asked[1]), JSON.stringify(asked), s);

      /* duplicates: the repeated venue, clicked on ONE of its four rows */
      await clickCheck(s, `${P0} 01`);
      await sleep(1200);
      c = await controls(s);
      const ones = c.filter(x => x.key.startsWith('zuluvenue 01'));
      await t('tp-places P0 (7): a place shown on four rows is looked up once and rated on all four',
        q0().queries === 3 && ones.length === 4 && ones.every(x => x.hidden && x.rating), JSON.stringify({ q: q0(), ones }), s);

      /* fast repeated clicks */
      await evaluate(s, `(() => { const b = [...document.querySelectorAll('#board .tpm-check')].find(x => x.dataset.placeKey.startsWith('zuluvenue 12'));
        for (let i = 0; i < 6; i++) b.click(); return 1; })()`);
      await sleep(1200);
      await t('tp-places P0 (8): six fast clicks on one place make one lookup',
        q0().queries === 4 && q0().duplicates === 0, JSON.stringify(q0()), s);

      /* views and re-renders reuse what is loaded */
      await switchView(s, 'days');
      await sleep(900);
      const d = await controls(s, '#daysList');
      await t('tp-places P0 (6): Days shows the loaded ratings at once, and asks for nothing',
        q0().queries === 4 && d.filter(x => x.hidden && x.rating).length === 7
          && d.filter(x => !x.hidden).every(x => x.state === 'idle'),
        JSON.stringify({ q: q0(), rated: d.filter(x => x.rating).length }), s);
      await switchView(s, 'timeline');
      await setValue(s, '#filterStatus', 'booked');
      await sleep(300);
      await setValue(s, '#filterStatus', '');
      await sleep(900);
      await t('tp-places P0: re-renders ask for nothing and keep every loaded rating',
        q0().queries === 4 && (await paintedCount(s)) === 7, `${q0().queries} queries, ${await paintedCount(s)} painted`, s);

      /* bulk: warn first, cancel sends nothing, confirm sends the rest */
      await clickSel(s, '#ratingsLoadAll', { settle: 400 });
      const warn = await evaluate(s, `({ title: document.getElementById('confirmTitle').textContent,
        text: document.getElementById('confirmText').textContent, yes: document.getElementById('confirmYes').textContent })`);
      await t('tp-places P0 (9): Load all shows a quota warning before any request',
        (await confirmOpen(s)) && /Load Google ratings for all places in this view\?/.test(warn.title)
          && /monthly quota/.test(warn.text) && /individually/.test(warn.text) && q0().queries === 4,
        JSON.stringify(warn), s);
      await t('tp-places P0 (12): and it offers only the places not already loaded (26 of 30)',
        warn.yes === 'Load all ratings (26)', warn.yes, s);
      const noteOk = await waitForExpr(s, `/Google lookups left right now: 500\\. This would use 26 of them\\./.test(document.getElementById('confirmNote').textContent)`, { timeout: 6000 });
      await t('tp-places P0: the warning shows how many Google lookups are left against what it would use',
        noteOk && budget0.asked === 1 && q0().queries === 4,
        await evaluate(s, `document.getElementById('confirmNote').textContent`), s);
      await clickSel(s, '#confirmOverlay [data-close]', { settle: 800 });
      await t('tp-places P0 (10): Cancel makes zero requests',
        !(await confirmOpen(s)) && q0().queries === 4, JSON.stringify(q0()), s);
      const loaded = await loadAllRatings(s);
      await waitForExpr(s, `document.querySelectorAll('#board .tp-maps-link .tpm-rating').length >= 33`, { timeout: 12000 });
      await t('tp-places P0 (11): confirming loads every remaining place in the view, each once',
        loaded === 26 && q0().unique === 30 && q0().duplicates === 0 && (await paintedCount(s)) === 33,
        JSON.stringify({ loaded, q: q0(), painted: await paintedCount(s) }), s);
      await t('tp-places P0: and every batch respects the server cap of 12',
        log.every(e => e.queries.length <= 12), JSON.stringify(log.map(e => e.queries.length)), s);
      await sleep(400);
      const done = await bulk(s);
      await t('tp-places P0: with every place loaded the button reads "All ratings loaded", done and inert',
        /✓ All ratings loaded/.test(done.text) && done.disabled
          && (await evaluate(s, `document.getElementById('ratingsLoadAll').classList.contains('is-done')`)),
        JSON.stringify(done), s);
      await clickSel(s, '#ratingsLoadAll', { settle: 500 });
      await t('tp-places P0: and pressing it anyway asks nothing',
        !(await confirmOpen(s)) && q0().queries === 30, '', s);
      await switchView(s, 'days');
      await sleep(600);
      await t('tp-places P0: Days, holding the same places, reads done too',
        /All ratings loaded/.test((await bulk(s)).text), JSON.stringify(await bulk(s)), s);
    });

    // Loading is a small state on the row (and on the bulk button), and the
    // page stays usable. Only this block's own venue is held.
    const held = [];
    await withPage('tp-places P0 loading', {
      db: dbOf([venueTrip(4, 'Held trip', 'YankeeVenue')]),
      net: (url, request) => {
        if (!url.includes('tp-places')) return EXTERNAL_HOSTS.test(url) ? 'fail' : null;
        if (/YankeeVenue/.test(request.postData || '')) { held.push(url); return 'hold'; }
        return { status: 200, body: { results: [] } };
      },
    }, async (s) => {
      await waitForExpr(s, `document.querySelectorAll('#board .tpm-check[data-place-key]').length >= 4`, { timeout: 12000 });
      await sleep(600);
      await t('tp-places P0 loading: nothing is requested before a click', held.length === 0, String(held.length), s);
      await clickCheck(s, 'YankeeVenue 02');
      await sleep(600);
      const row = (await controls(s)).find(x => x.key.startsWith('yankeevenue 02'));
      await t('tp-places P0 loading: the clicked row says Loading and cannot be clicked again',
        held.length === 1 && row.state === 'loading' && row.text === '⭐ Loading…' && row.disabled,
        JSON.stringify({ held: held.length, row }), s);
      await loadAllRatings(s);
      await sleep(600);
      await t('tp-places P0 loading: a bulk load in flight shows on the toolbar button',
        /Loading ratings/.test((await bulk(s)).text) && (await bulk(s)).disabled, JSON.stringify(await bulk(s)), s);
      await switchView(s, 'days');
      await t('tp-places P0 loading: and the rest of the app does not wait for it',
        (await evaluate(s, `document.querySelectorAll('#daysList .dc-event').length`)) === 4, '', s);
    });

    // A quota 429 on a click: the row says so, nothing is retried on its own,
    // and a second click while the quota is out sends nothing at all.
    const qlog = [];
    await withPage('tp-places P0 quota', { db: dbOf([venueTrip(4, 'Quota click trip', 'XrayVenue')]), net: placesMock(qlog, '429') }, async (s) => {
      await waitForExpr(s, `document.querySelectorAll('#board .tpm-check[data-place-key]').length >= 4`, { timeout: 12000 });
      await sleep(500);
      await clickCheck(s, 'XrayVenue 01');
      await sleep(2500);
      const row = (await controls(s)).find(x => x.key.startsWith('xrayvenue 01'));
      await t('tp-places P0 quota: a refused place reads "Rating unavailable (quota limit)"',
        row.state === 'quota' && row.text === 'Rating unavailable (quota limit)', JSON.stringify(row), s);
      const after = totals(qlog, 'XrayVenue').posts;
      await clickCheck(s, 'XrayVenue 02');
      await sleep(3000);
      await t('tp-places P0 (13): a 429 is not retried, and a click while the quota is out sends nothing',
        after === 1 && totals(qlog, 'XrayVenue').posts === 1
          && (await controls(s)).find(x => x.key.startsWith('xrayvenue 02')).state === 'quota',
        `${after} -> ${totals(qlog, 'XrayVenue').posts}`, s);
      await t('tp-places P0 quota: the bulk button says the ratings are paused',
        /paused \(quota limit\)/.test((await bulk(s)).text) && (await bulk(s)).disabled, JSON.stringify(await bulk(s)), s);
    });
  }

  /* ------- P0c. the warning's "lookups left" when it is short, or none ---- */
  freshIds();
  {
    const log = [];
    const budget = { left: 3 };
    const shortTrip = venueTrip(5, 'Short budget trip', 'WhiskeyVenue');
    // A flight: a delete that confirms (a leg, so it has no rating control).
    shortTrip.items.push(item({ type: 'flight', title: 'Tokyo (HND) to Osaka (ITM)', startDate: iso(9), startTime: '08:00' }));
    await withPage('tp-places P0c', { db: dbOf([shortTrip]), net: placesMock(log, 'ok', budget) }, async (s) => {
      await waitForExpr(s, `document.querySelectorAll('#board .tpm-check[data-place-key]').length >= 5`, { timeout: 12000 });
      await clickSel(s, '#ratingsLoadAll', { settle: 300 });
      const shortOk = await waitForExpr(s, `/left right now: 3\\. Only about 3 of these 5 would load/.test(document.getElementById('confirmNote').textContent)`, { timeout: 6000 });
      await t('tp-places P0c: fewer left than the view needs says how many will load, in amber',
        shortOk && (await evaluate(s, `document.getElementById('confirmNote').classList.contains('is-short')`))
          && !(await evaluate(s, `document.getElementById('confirmYes').disabled`)),
        await evaluate(s, `document.getElementById('confirmNote').textContent`), s);
      await clickSel(s, '#confirmOverlay [data-close]', { settle: 400 });
      budget.left = 0;
      await clickSel(s, '#ratingsLoadAll', { settle: 300 });
      const noneOk = await waitForExpr(s, `/left right now: 0\\./.test(document.getElementById('confirmNote').textContent)`, { timeout: 6000 });
      await t('tp-places P0c: none left disables "Load all ratings" and says when it refills',
        noneOk && (await evaluate(s, `document.getElementById('confirmYes').disabled`))
          && /refills/.test(await evaluate(s, `document.getElementById('confirmNote').textContent`)),
        await evaluate(s, `document.getElementById('confirmNote').textContent`), s);
      await clickSel(s, '#confirmOverlay [data-close]', { settle: 400 });
      await t('tp-places P0c: and none of this made a single lookup', totals(log, 'WhiskeyVenue').queries === 0, '', s);
      // A later delete must not inherit the ratings dialog's look or its note.
      await evaluate(s, `(() => { const r = [...document.querySelectorAll('#board .tp-row')].find(x => /HND/.test(x.textContent));
        const b = r && r.querySelector('[data-act="delete"]'); b && b.click(); return !!b; })()`);
      await sleep(400);
      await t('tp-places P0c: the next confirm (a delete) is its red self again, with no note',
        (await evaluate(s, `(() => { const y = document.getElementById('confirmYes');
          return y.classList.contains('danger') && !y.classList.contains('primary') && !y.disabled
            && document.getElementById('confirmNote').hidden; })()`)) === true, '', s);
      await clickSel(s, '#confirmOverlay [data-close]', { settle: 300 });
    });
  }

  /* ------- P0b. the one exception: a stay with no saved point (2026-09-28) --
     A typed hotel anchors every distance on its days, so it is resolved on
     load whatever the switch says - and only it: activities wait for the
     switch, the hotel row shows no rating, a stay that already carries a
     fresh point costs nothing, a cancelled stay costs nothing, and a reload
     after the stay was persisted costs nothing. */
  freshIds();
  {
    const log = [];
    const PB = 'KiloVenue';
    const tb = trip({ name: 'Anchor trip', items: [
      item({ type: 'stay', title: `${PB} Typed Hotel`, location: 'Tokyo', startDate: iso(10), endDate: iso(13) }),
      item({ type: 'stay', title: `${PB} Saved Hotel`, location: 'Tokyo', startDate: iso(13), endDate: iso(15),
        place: { id: 'PID_SAVED', at: Date.now() - 86400000, lat: 35.68, lon: 139.76 } }),
      item({ type: 'stay', title: `${PB} Cancelled Hotel`, location: 'Tokyo', startDate: iso(10), endDate: iso(11), status: 'cancelled' }),
      item({ type: 'activity', title: `${PB} Museum`, location: 'Tokyo', startDate: iso(11), startTime: '10:00' }),
      item({ type: 'activity', title: `${PB} Ramen`, location: 'Tokyo', startDate: iso(11), startTime: '13:00' }),
    ] });
    const asked = () => log.flatMap(e => e.queries).filter(q => q.includes(PB));
    await withPage('tp-places P0b', { db: dbOf([tb]), net: placesMock(log, 'ok') }, async (s) => {
      await waitForExpr(s, `document.querySelectorAll('#board .tp-maps-link[data-place-key]').length >= 3`, { timeout: 12000 });
      await sleep(2000);
      const q = asked();
      await t('tp-places P0b: with the switch Off, the typed stay is looked up on load',
        q.some(x => /Typed Hotel/.test(x)), JSON.stringify(q), s);
      await t('tp-places P0b: and nothing else is: no activity, no saved stay, no cancelled stay',
        q.length === 1, JSON.stringify(q), s);
      // The stay's lookup is already paid for, so its rating shows for free;
      // the activities were never asked for and still offer "Check rating".
      const rowsNow = await evaluate(s, `[...document.querySelectorAll('#board .tpm-check[data-place-key]')].map(b => ({
        key: b.dataset.placeKey, state: b.dataset.state, rated: !!(b.previousElementSibling && b.previousElementSibling.querySelector('.tpm-rating')) }))`);
      await t('tp-places P0b: the anchored stay shows its (already paid) rating; the activities stay unloaded',
        rowsNow.filter(r => /typed hotel/.test(r.key)).every(r => r.rated && r.state === 'loaded')
          && rowsNow.filter(r => /museum|ramen/.test(r.key)).every(r => !r.rated && r.state === 'idle'),
        JSON.stringify(rowsNow), s);
      const saved = await evaluate(s, `(() => { const db = JSON.parse(localStorage.getItem('trip-planner:v1'));
        const it = db.trips[0].items.find(i => /Typed Hotel/.test(i.title)); return it && it.place || null; })()`);
      await t('tp-places P0b: the resolved stay is persisted with its point',
        !!saved && !!saved.id && Number.isFinite(saved.lat) && Number.isFinite(saved.lon), JSON.stringify(saved), s);
      await switchView(s, 'days');
      await sleep(1200);
      await t('tp-places P0b: opening Days asks for nothing more',
        asked().length === 1, JSON.stringify(asked()), s);

      const before = log.length;
      await gotoHard(s, base + APP, { settle: 1600 });
      await sleep(1500);
      await t('tp-places P0b: after a reload the persisted stay costs nothing at all',
        log.length === before, `${before} posts before the reload, ${log.length} after`, s);
    });
  }

  /* ------- P1. a 50-venue bulk load is batched, bounded and deduplicated -- */
  freshIds();
  {
    const log = [];
    const P1 = 'AlphaVenue';
    const big = venueTrip(50, 'Fanout trip', P1);
    await withPage('tp-places P1', { db: dbOf([big]), net: placesMock(log, 'ok') }, async (s) => {
      await waitForExpr(s, `document.querySelectorAll('#board .tp-maps-link[data-place-key]').length >= 50`, { timeout: 12000 });
      await sleep(1500);
      await t('tp-places P1: the load itself bills nothing',
        totals(log, P1).queries === 0, JSON.stringify(totals(log, P1)), s);
      const offered = await loadAllRatings(s);
      await waitForExpr(s, `document.querySelectorAll('#board .tp-maps-link .tpm-rating').length >= 50`, { timeout: 15000 });
      const all = totals(log, P1);
      await t('tp-places P1: the warning offered all 50 places, off-screen ones included',
        offered === 50, String(offered), s);
      await t('tp-places P1: all 50 are looked up once each',
        all.unique === 50 && all.duplicates === 0, JSON.stringify(all), s);
      await t('tp-places P1: in batches of at most 12, not a POST per place',
        all.posts === Math.ceil(50 / 12) && log.every(e => e.queries.length <= 12),
        JSON.stringify(log.map(e => e.queries.length)), s);
      await t('tp-places P1: and every row is painted',
        (await paintedCount(s)) === 50, String(await paintedCount(s)), s);
      await scrollBoardToEnd(s);
      await sleep(1200);
      await t('tp-places P1: scrolling afterwards asks for nothing more',
        totals(log, P1).queries === all.queries, `${all.queries} -> ${totals(log, P1).queries}`, s);
    });
  }

  /* --------- P2/P3. re-renders and view switches re-bill nothing ---------- */
  freshIds();
  {
    const log = [];
    const P3 = 'BravoVenue';
    const mid = venueTrip(8, 'Switch trip', P3);
    await withPage('tp-places P3', { db: dbOf([mid]), net: placesMock(log, 'ok') }, async (s) => {
      await loadAllRatings(s);
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
      await loadAllRatings(s);
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
      await loadAllRatings(s);
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
      await loadAllRatings(s);
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
      await loadAllRatings(s);
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
      await loadAllRatings(s);
      await sleep(1200);
      await evaluate(s, `(() => { const sel = document.getElementById('tripSelect'); sel.value = ${JSON.stringify(b.id)}; sel.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()`);
      await sleep(1500);
      await t('tp-places P8: switching to trip B asks for none of its venues by itself',
        !log.flatMap(e => e.queries).some(q => /GolfVenue/.test(q)), '', s);
      await loadAllRatings(s);
      await sleep(1500);
      const asked = log.flatMap(e => e.queries);
      await t('tp-places P8: trip B\'s venues are looked up when the traveller loads them',
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
      await loadAllRatings(s);
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
      await loadAllRatings(s);
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
      // The itinerary's own Tsukiji row is not looked up on Google while the
      // Timeline's ratings switch is Off (opt-in since 2026-09-28), so the
      // card's distance origin comes from the free Photon rung, as it does
      // for any unrated row. Answered here with the same point Places gives.
      if (/photon\.komoot\.io/i.test(url)) {
        const features = /Tsukiji/i.test(decodeURIComponent(url)) ? [{ type: 'Feature',
          geometry: { type: 'Point', coordinates: [139.7707, 35.6654] },
          properties: { name: 'Tsukiji Outer Market', city: 'Tokyo', country: 'Japan', osm_key: 'amenity', osm_value: 'marketplace' } }] : [];
        return { status: 200, body: { type: 'FeatureCollection', features } };
      }
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
      await waitForExpr(s, `[...document.querySelectorAll('#assistMessages .assist-proposal')]
        .some(c => /Tokyo Station/.test(c.textContent) && ((c.querySelector('.ap-dist') || {}).textContent || '').trim())`, { timeout: 8000 });
      tokyoCard.dist = (await cards()).find(c => /Tokyo Station/.test(c.title)).dist;
      await t('tp-places P11: a verified same-city candidate measures a sane intra-city distance',
        /km|mi/.test(tokyoCard.dist) && !/\b[1-9]\d{2,}\s*(km|mi)/.test(tokyoCard.dist),
        JSON.stringify(tokyoCard.dist), s);

      /* --- ADD TO TRIP: the row is the SAME place, with no second lookup --- */
      const chocPosts = () => p11log.filter(b => b.some(e => /P11 Chain/.test(e.q))).length;
      const postsBefore = chocPosts();
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

      // The assistant's cards rated themselves while the trip's own Tsukiji
      // row was never asked for: chat is automatic, the itinerary on demand.
      // The Days rows are then bulk-loaded, and the accepted places bill
      // nothing (the cards already resolved them).
      await t('tp-places P0 (14): chat rates its own cards with no itinerary lookup asked for',
        (await evaluate(s, `(() => { const b = [...document.querySelectorAll('#board .tpm-check[data-place-key]')]
          .find(x => /tsukiji/.test(x.dataset.placeKey)); return b ? b.dataset.state : 'missing'; })()`)) === 'idle'
          && !p11log.flat().some(e => /Tsukiji/.test(e.q)),
        JSON.stringify(p11log.flat().map(e => e.q)), s);
      await switchView(s, 'days');
      await loadAllRatings(s);
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
      // Counted per chocolate query: switching the itinerary's ratings on
      // legitimately looks up the trip's own Tsukiji row for the first time.
      await t('tp-places P11: Add to trip triggers NO second, independent resolution',
        chocPosts() === postsBefore,
        `${postsBefore} posts before, ${chocPosts()} after`, s);
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
      //
      // REVISED 2026-09-06. This used to assert `!place`, because a record
      // could only ever arrive through the assistant's accept path, so absence
      // was the only available way to say "PID_KEEPME did not follow the new
      // name". A hand-added row now keeps its own resolution too
      // (persistResolvedPlaces), so a renamed row legitimately acquires a
      // record FOR THE NEW NAME once the lookup lands. The invariant is
      // unchanged and is now asserted directly: whatever is there, it is not
      // the old identity.
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
        renamed.title === 'P13 Somewhere Else'
          && (!renamed.place || renamed.place.id !== 'PID_KEEPME'), JSON.stringify(renamed), s);
      // and if a record IS there, it belongs to the name that was typed
      await t('tp-places P13: any record on the renamed row was resolved for the NEW name',
        !renamed.place || /somewhere else/i.test(renamed.place.id),
        JSON.stringify(renamed.place), s);
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
      // "No rating match" said four different things at once and was replaced
      // on 2026-09-05 with one sentence per state (placeStateLabel). This
      // candidate is refused on GEOGRAPHY - a real business, in another city -
      // so the honest label names that, and the link still says "Verify"
      // because the app could not confirm the place for the traveller.
      await t('tp-places P16: and it is clearly marked unverified',
        out.unresolved.length === 1 && /Different city/.test(out.unresolved[0]) && /Verify/.test(out.link),
        JSON.stringify(out), s);
    });
  }

  /* ===== P17. A SUB-LOCALITY DESTINATION STILL GETS AN ANSWER =============
     The 2026-09-05 report: whole days in Krabi/Phuket came back "I could not
     verify any places for this on Google Maps, so I have not added any."
     The venues were real; the itinerary just called the place "Railay Beach"
     while Google addresses it "Ao Nang, Mueang Krabi District, Krabi", so the
     area gate refused every one of them with a PERFECT name score.
     Here the server answers the way it now does for that shape - resolved,
     name-confident, but unverified because nothing could confirm the branch -
     and the answer must contain the places rather than an apology. */
  freshIds();
  {
    const day = iso(24);
    const P17_REPLY = `Here are three good spots for your day.

- P17 Anna Kitchen is a local favourite.
- P17 Sunset Terrace has the view.
- P17 Harbour Grill does great seafood.

\`\`\`json
{"tripActions":[
 {"op":"add","discovery":{"query":"restaurants","count":3},"item":{"type":"activity","title":"P17 Anna Kitchen","location":"Railay Beach","startDate":"${day}","startTime":"12:00","mapsQuery":"P17 Anna Kitchen Railay Beach"}},
 {"op":"add","item":{"type":"activity","title":"P17 Sunset Terrace","location":"Railay Beach","startDate":"${day}","startTime":"18:00","mapsQuery":"P17 Sunset Terrace Railay Beach"}},
 {"op":"add","item":{"type":"activity","title":"P17 Harbour Grill","location":"Railay Beach","startDate":"${day}","startTime":"20:00","mapsQuery":"P17 Harbour Grill Railay Beach"}}
]}
\`\`\``;

    // Every venue RESOLVES (a real Google entity, name confirmed) but none is
    // VERIFIED: the trip has no coordinate for "Railay Beach" and Google's
    // address for each says Ao Nang / Krabi. This is exactly the payload the
    // fixed server returns for `city_unconfirmed`.
    const p17Net = (url, request) => {
      if (!url.includes('tp-places')) return EXTERNAL_HOSTS.test(url) ? 'fail' : null;
      let body = {};
      try { body = JSON.parse(request.postData || '{}'); } catch { /* empty */ }
      if (body.discover) return { status: 200, body: { discovered: true, results: [] } };
      const entries = (body.queries || []).map(toEntry);
      const results = entries.map((e, i) => ({
        id: e.id, query: e.q, status: 'ok', name: e.q,
        rating: 4.3 + i * 0.1, userRatingCount: 400 + i,
        mapsUri: 'https://maps.google.com/?cid=' + i,
        placeId: 'PID_' + i, verified: false, areaBasis: 'address', confidence: 0.5,
      }));
      return { status: 200, body: { results, attribution: { text: 'Google Maps', url: 'https://www.google.com/maps' } } };
    };

    const p17Trip = trip({ name: 'P17 sub-locality', items: [
      item({ type: 'stay', title: 'P17 Beach Resort', location: 'Railay Beach', startDate: iso(23), endDate: iso(26), status: 'booked' }),
    ] });

    await withPage('tp-places P17', { db: dbOf([p17Trip]), net: p17Net }, async (s) => {
      await clickSel(s, '#assistBtn');
      await waitForExpr(s, `!!document.querySelector('#assistTierGroup')`, { timeout: 6000 });
      await evaluate(s, `(()=>{const r=document.querySelector('#assistTierGroup input[value="copy"]');
        if (r && !r.checked) r.click(); return 1})()`);
      await waitForExpr(s, `!!document.querySelector('#assistPasteBox')`, { timeout: 6000 });
      await setValue(s, '#assistPasteBox', P17_REPLY);
      await clickSel(s, '#assistPasteParse', { settle: 400 });
      await waitForExpr(s, `document.querySelectorAll('#assistMessages .assist-proposal').length >= 1`, { timeout: 20000 });
      await sleep(900);

      const out = await evaluate(s, `({
        titles: [...document.querySelectorAll('#assistMessages .ap-title')].map(e=>e.textContent.trim()),
        note: ((document.querySelector('#assistMessages .assist-verified-note')||{}).textContent||''),
        prose: [...document.querySelectorAll('#assistMessages .assist-msg.assistant')].map(e=>e.textContent).join(' | '),
        chips: [...document.querySelectorAll('#assistMessages .ap-dist')].map(e=>e.textContent.trim()),
      })`);

      await t('tp-places P17: THE REGRESSION - a sub-locality day still returns its places',
        out.titles.length === 3, JSON.stringify(out.titles), s);
      await t('tp-places P17: and never claims it could not verify any of them',
        !/could not verify any places/i.test(out.note + ' ' + out.prose),
        JSON.stringify({ note: out.note, prose: out.prose.slice(0, 200) }), s);
      await t('tp-places P17: an unverified place draws NO distance chip rather than a wrong one',
        out.chips.every(c => c === ''), JSON.stringify(out.chips), s);
    });
  }

  /* ===== P18. RETURN TO HOTEL IS THE HOTEL ================================
     From the Day Route map in the 2026-09-05 report: stop 1 (the hotel) and
     stop 2 (dinner) sat together, and stop 3 - "Return to hotel", the SAME
     hotel - was plotted ~14 km north, on the centroid of the province. The
     leg was denied the hotel-picker rung purely because isStay(leg) is false.
     The invariant: the last stop must coincide with the first. */
  freshIds();
  {
    const day = iso(24);
    const p18Trip = trip({ name: 'P18 return', items: [
      item({ id: 'p18-hotel', type: 'stay', title: 'P18 Beach Resort', location: 'Phuket',
        startDate: iso(23), endDate: iso(26), status: 'booked' }),
      item({ id: 'p18-dinner', type: 'activity', title: 'P18 Grill House', location: 'Phuket',
        mapsQuery: 'P18 Grill House', startDate: day, startTime: '19:00', status: 'booked' }),
      item({ id: 'p18-ret', type: 'local', title: 'Return to hotel', location: 'Phuket',
        mapsQuery: 'P18 Beach Resort', startDate: day, startTime: '21:30', status: 'booked' }),
    ] });

    await withPage('tp-places P18', { db: dbOf([p18Trip]), net: (url) => (url.includes('tp-places')
      ? { status: 200, body: { results: [] } } : (EXTERNAL_HOSTS.test(url) ? 'fail' : null)) }, async (s) => {
      // The caches in the state that produced the report: "Phuket" geocoded to
      // the PROVINCE centroid (what Nominatim actually answers), the hotel's
      // own doorstep seeded under its NAME by the hotel picker, and the dinner
      // resolved through Places. Nothing locates the LEG.
      await evaluate(s, `(() => {
        const now = Date.now();
        const venue = {};
        venue[TripLogic.placeCacheKey('P18 Grill House', { city: 'Phuket' })] = { lat: 7.8180, lon: 98.2980, at: now };
        localStorage.setItem('trip-planner:venuegeo:v2', JSON.stringify(venue));
        localStorage.setItem('trip-planner:geo:v3', JSON.stringify({
          phuket: { lat: 7.9366, lon: 98.3529, country: 'Thailand', conf: 'confident' },
          'p18 beach resort': { lat: 7.8203, lon: 98.2988, country: 'Thailand', conf: 'confident' },
        }));
        return 1; })()`);
      await gotoHard(s, base + APP + '#days');
      await waitForExpr(s, `document.querySelectorAll('#daysList .dc-event').length >= 2`, { timeout: 12000 });
      await sleep(900);

      const chips = await evaluate(s, `[...document.querySelectorAll('.dc-event')].map(r => ({
        title: ((r.querySelector('.dc-title')||{}).textContent||'').replace(/\\s+/g,' ').trim(),
        dist: ((r.querySelector('.dc-dist')||{}).textContent||'').trim(),
      }))`);
      const ret = chips.find(c => /Return to hotel/.test(c.title)) || {};
      const km = str => { const m = /~([\d.]+)\s*(km|mi)\b/.exec(str || ''); return m ? (m[2] === 'mi' ? Number(m[1]) / 0.621371 : Number(m[1])) : null; };
      await t('tp-places P18: THE REGRESSION - the walk home is a walk, not a 14 km taxi ride',
        km(ret.dist) !== null && km(ret.dist) < 1.5, JSON.stringify(ret), s);

      // and the map agrees: the last pin sits on the first
      await clickSel(s, '[data-act="day-route"]', { settle: 900 });
      await waitForExpr(s, `document.querySelectorAll('#dayRouteCanvas .stop-pin').length >= 3`, { timeout: 10000 });
      const spread = await evaluate(s, `(() => {
        const pins = [...document.querySelectorAll('#dayRouteCanvas .stop-pin')];
        const box = p => { const r = p.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; };
        const a = box(pins[0]), c = box(pins[pins.length - 1]);
        return { n: pins.length, dx: Math.abs(a.x - c.x), dy: Math.abs(a.y - c.y) }; })()`);
      await t('tp-places P18: the Day route map plots the return ON the hotel, not north of it',
        spread.dx < 40 && spread.dy < 40, JSON.stringify(spread), s);
    });
  }

  /* ===== P19. THE ACCEPT PATH: the card and the row it becomes agree ======
     The sharpest half of the 2026-09-05 route report. The pre-add proposal
     card measured the return leg correctly (it had the hotel rung); the
     itinerary row it became did not, so pressing "Add to trip" moved the
     destination from the hotel's doorstep to the centre of its city and the
     chip jumped from a walk to a 14 km taxi ride.
     This drives the whole chain in the browser - suggestion, card, accept,
     itinerary, day chain - and asserts the number does not move. */
  freshIds();
  {
    const day = iso(24);
    const P19_REPLY = `Here is the end of your evening.

\`\`\`json
{"tripActions":[
 {"op":"add","item":{"type":"local","title":"Return to hotel","location":"Phuket","startDate":"${day}","startTime":"21:30","mapsQuery":"P19 Beach Resort"}}
]}
\`\`\``;

    const p19Trip = trip({ name: 'P19 accept', items: [
      item({ id: 'p19-hotel', type: 'stay', title: 'P19 Beach Resort', location: 'Phuket',
        startDate: iso(23), endDate: iso(26), status: 'booked' }),
      item({ id: 'p19-dinner', type: 'activity', title: 'P19 Grill House', location: 'Phuket',
        mapsQuery: 'P19 Grill House', startDate: day, startTime: '19:00', status: 'booked' }),
    ] });

    await withPage('tp-places P19', { db: dbOf([p19Trip]), net: (url) => (url.includes('tp-places')
      ? { status: 200, body: { results: [] } } : (EXTERNAL_HOSTS.test(url) ? 'fail' : null)) }, async (s) => {
      // Same cache state as P18: "Phuket" is the province centroid, the hotel
      // has its own picked doorstep, the dinner is resolved, the LEG is not.
      await evaluate(s, `(() => {
        const now = Date.now();
        const venue = {};
        venue[TripLogic.placeCacheKey('P19 Grill House', { city: 'Phuket' })] = { lat: 7.8180, lon: 98.2980, at: now };
        localStorage.setItem('trip-planner:venuegeo:v2', JSON.stringify(venue));
        localStorage.setItem('trip-planner:geo:v3', JSON.stringify({
          phuket: { lat: 7.9366, lon: 98.3529, country: 'Thailand', conf: 'confident' },
          'p19 beach resort': { lat: 7.8203, lon: 98.2988, country: 'Thailand', conf: 'confident' },
        }));
        return 1; })()`);
      await gotoHard(s, base + APP);
      await clickSel(s, '#assistBtn');
      await waitForExpr(s, `!!document.querySelector('#assistTierGroup')`, { timeout: 6000 });
      await evaluate(s, `(()=>{const r=document.querySelector('#assistTierGroup input[value="copy"]');
        if (r && !r.checked) r.click(); return 1})()`);
      await waitForExpr(s, `!!document.querySelector('#assistPasteBox')`, { timeout: 6000 });
      await setValue(s, '#assistPasteBox', P19_REPLY);
      await clickSel(s, '#assistPasteParse', { settle: 500 });
      await waitForExpr(s, `document.querySelectorAll('#assistMessages .assist-proposal').length >= 1`, { timeout: 12000 });
      await sleep(900);

      const km = str => { const m = /~([\d.]+)\s*(km|mi)\b/.exec(str || ''); return m ? (m[2] === 'mi' ? Number(m[1]) / 0.621371 : Number(m[1])) : null; };
      const cardChip = await evaluate(s,
        `((document.querySelector('#assistMessages .ap-dist')||{}).textContent||'').trim()`);
      await t('tp-places P19: the proposal card measures the return as a short hop',
        km(cardChip) !== null && km(cardChip) < 1.5, JSON.stringify(cardChip), s);

      // ACCEPT, then read the itinerary row the same chip became
      await clickSel(s, '.assist-proposal[data-op="add"] [data-act="accept-proposal"]', { settle: 1000 });
      await gotoHard(s, base + APP + '#days');
      await waitForExpr(s, `[...document.querySelectorAll('#daysList .dc-title')].some(e => /Return to hotel/.test(e.textContent))`, { timeout: 12000 });
      await sleep(900);

      const row = await evaluate(s, `(() => {
        const r = [...document.querySelectorAll('.dc-event')].find(e => /Return to hotel/.test(e.textContent));
        return r ? { dist: ((r.querySelector('.dc-dist')||{}).textContent||'').trim() } : null; })()`);
      await t('tp-places P19: THE REGRESSION - accepting the card does not move the hotel',
        !!row && km(row.dist) !== null && km(row.dist) < 1.5,
        JSON.stringify({ card: cardChip, row: row && row.dist }), s);
      await t('tp-places P19: and the two agree, so no surface can contradict another',
        !!row && Math.abs(km(row.dist) - km(cardChip)) < 0.2,
        JSON.stringify({ card: cardChip, row: row && row.dist }), s);

      // the day footer must not report a phantom taxi ride either
      const footer = await evaluate(s,
        `((document.querySelector('#daysList .day-card .dc-route-tot')||{}).textContent||'').trim()`);
      await t('tp-places P19: the day footer totals the real legs, not a 14 km phantom',
        !/1[0-9](\.\d)?\s*(km|mi)/.test(footer), JSON.stringify(footer), s);
    });
  }

  /* ===== P20. AN UNLOCATABLE HOTEL IS UNKNOWN, NOT THE CITY CENTRE =======
     The rule the owner asked for out loud: a city centroid may stand in for a
     row nobody looked up, but it must never fabricate a HOTEL's position. Here
     nothing locates the stay at all, so the return leg has no point - and the
     surfaces must show nothing rather than a confident wrong number. */
  freshIds();
  {
    const day = iso(24);
    const p20Trip = trip({ name: 'P20 unknown hotel', items: [
      item({ id: 'p20-hotel', type: 'stay', title: 'P20 Unlisted Guesthouse', location: 'Phuket',
        startDate: iso(23), endDate: iso(26), status: 'booked' }),
      item({ id: 'p20-dinner', type: 'activity', title: 'P20 Grill House', location: 'Phuket',
        mapsQuery: 'P20 Grill House', startDate: day, startTime: '19:00', status: 'booked' }),
      item({ id: 'p20-ret', type: 'local', title: 'Return to hotel', location: 'Phuket',
        mapsQuery: 'P20 Unlisted Guesthouse', startDate: day, startTime: '21:30', status: 'booked' }),
    ] });

    await withPage('tp-places P20', { db: dbOf([p20Trip]), net: (url) => (url.includes('tp-places')
      ? { status: 200, body: { results: [] } } : (EXTERNAL_HOSTS.test(url) ? 'fail' : null)) }, async (s) => {
      await evaluate(s, `(() => {
        const now = Date.now();
        const venue = {};
        venue[TripLogic.placeCacheKey('P20 Grill House', { city: 'Phuket' })] = { lat: 7.8180, lon: 98.2980, at: now };
        localStorage.setItem('trip-planner:venuegeo:v2', JSON.stringify(venue));
        // the CITY is geocoded (the province centroid); the guesthouse is not
        localStorage.setItem('trip-planner:geo:v3', JSON.stringify({
          phuket: { lat: 7.9366, lon: 98.3529, country: 'Thailand', conf: 'confident' },
        }));
        return 1; })()`);
      await gotoHard(s, base + APP + '#days');
      await waitForExpr(s, `document.querySelectorAll('#daysList .dc-event').length >= 2`, { timeout: 12000 });
      await sleep(900);
      const row = await evaluate(s, `(() => {
        const r = [...document.querySelectorAll('.dc-event')].find(e => /Return to hotel/.test(e.textContent));
        return r ? ((r.querySelector('.dc-dist')||{}).textContent||'').trim() : '(no row)'; })()`);
      await t('tp-places P20: an unlocatable hotel draws NO distance rather than the city centre',
        row === '', JSON.stringify(row), s);
    });
  }

  /* ===== P21. A WHOLE DAY IN A SUB-LOCALITY DESTINATION ===================
     The owner's actual request shape, end to end: two activities with two
     options each, breakfast/lunch/dinner with three options each, in Ao Nang -
     where Google's address for every venue says "Ao Nang, Mueang Krabi
     District, Krabi" while the itinerary is based at a Railay Beach hotel.
     One of the thirteen venues is invented.
     Before the fix this whole answer collapsed to "I could not verify any
     places for this on Google Maps". */
  freshIds();
  {
    const day = iso(24);
    const slots = [
      ['Breakfast', '08:00', ['P21 Sunrise Cafe', 'P21 Beach Bakery', 'P21 Morning Pier']],
      ['Lunch', '12:30', ['P21 Noodle House', 'P21 Harbour Deck', 'P21 Green Papaya']],
      ['Dinner', '19:00', ['P21 Lantern Grill', 'P21 Cliff Table', 'P21 Phantom Pavilion']],
    ];
    const activities = [
      ['Morning', '10:00', ['P21 Viewpoint Trail', 'P21 Kayak Lagoon']],
      ['Afternoon', '15:00', ['P21 Island Hop', 'P21 Cave Temple']],
    ];
    // A DISCOVERY turn, which is what the owner's failing request was: the
    // "I could not verify any places" line only exists on that path. In an
    // ORDINARY turn an unverifiable venue is deliberately kept and shown
    // unresolved, because the traveller named it - a different contract, and
    // one P16 already pins.
    const adds = [];
    let hint = '"discovery":{"query":"places for a day in Ao Nang","count":13},';
    for (const [label, time, opts] of slots) {
      for (const name of opts) {
        adds.push(`{"op":"add",${hint}"group":"${label.toLowerCase()}","item":{"type":"activity","meal":"${label.toLowerCase()}",`
          + `"title":${JSON.stringify(name)},"location":"Ao Nang","startDate":"${day}","startTime":"${time}",`
          + `"mapsQuery":${JSON.stringify(name + ' Ao Nang')}}}`);
        hint = '';
      }
    }
    for (const [label, time, opts] of activities) {
      for (const name of opts) {
        adds.push(`{"op":"add","group":"${label.toLowerCase()}","item":{"type":"activity",`
          + `"title":${JSON.stringify(name)},"location":"Ao Nang","startDate":"${day}","startTime":"${time}",`
          + `"mapsQuery":${JSON.stringify(name + ' Ao Nang')}}}`);
      }
    }
    const P21_REPLY = `Here is a full day around Ao Nang, with options for each slot.

\`\`\`json
{"tripActions":[${adds.join(',')}]}
\`\`\``;

    // Every venue resolves EXCEPT the invented "Phantom Pavilion", and none is
    // verified: Google's address says Krabi, the itinerary says Railay Beach.
    const p21Net = (url, request) => {
      if (!url.includes('tp-places')) return EXTERNAL_HOSTS.test(url) ? 'fail' : null;
      let body = {};
      try { body = JSON.parse(request.postData || '{}'); } catch { /* empty */ }
      if (body.discover) return { status: 200, body: { discovered: true, results: [] } };
      const entries = (body.queries || []).map(toEntry);
      const results = entries.map((e, i) => (/Phantom/.test(e.q)
        ? { id: e.id, query: e.q, status: 'no_match', reason: 'not_found' }
        : {
          id: e.id, query: e.q, status: 'ok', name: e.q.replace(/ Ao Nang$/, ''),
          rating: 4.1 + (i % 8) / 10, userRatingCount: 200 + i,
          mapsUri: 'https://maps.google.com/?cid=' + i,
          placeId: 'PID21_' + i, verified: false, areaBasis: 'address', confidence: 0.5,
        }));
      return { status: 200, body: { results, attribution: { text: 'Google Maps', url: 'https://www.google.com/maps' } } };
    };

    const p21Trip = trip({ name: 'P21 full day', items: [
      item({ type: 'stay', title: 'P21 Railay Resort', location: 'Railay Beach',
        startDate: iso(23), endDate: iso(26), status: 'booked' }),
    ] });

    await withPage('tp-places P21', { db: dbOf([p21Trip]), net: p21Net }, async (s) => {
      await clickSel(s, '#assistBtn');
      await waitForExpr(s, `!!document.querySelector('#assistTierGroup')`, { timeout: 6000 });
      await evaluate(s, `(()=>{const r=document.querySelector('#assistTierGroup input[value="copy"]');
        if (r && !r.checked) r.click(); return 1})()`);
      await waitForExpr(s, `!!document.querySelector('#assistPasteBox')`, { timeout: 6000 });
      await setValue(s, '#assistPasteBox', P21_REPLY);
      await clickSel(s, '#assistPasteParse', { settle: 500 });
      await waitForExpr(s, `document.querySelectorAll('#assistMessages .assist-proposal').length >= 3`, { timeout: 20000 });
      await sleep(1200);

      const out = await evaluate(s, `({
        cards: document.querySelectorAll('#assistMessages .assist-proposal').length,
        sets: document.querySelectorAll('#assistMessages .assist-set').length,
        titles: [...document.querySelectorAll('#assistMessages .ap-title, #assistMessages .as-title')]
          .map(e => e.textContent.trim()),
        note: ((document.querySelector('#assistMessages .assist-verified-note')||{}).textContent||''),
        prose: [...document.querySelectorAll('#assistMessages .assist-msg.assistant')].map(e=>e.textContent).join(' | '),
      })`);
      const named = n => out.titles.some(t => t.includes(n));

      await t('tp-places P21: a whole day in a sub-locality destination still answers',
        out.cards >= 3, JSON.stringify({ cards: out.cards, sets: out.sets }), s);
      await t('tp-places P21: and never says it could not verify any places',
        !/could not verify any places/i.test(out.note + ' ' + out.prose),
        JSON.stringify({ note: out.note, prose: out.prose.slice(0, 200) }), s);
      await t('tp-places P21: every meal slot survives verification',
        named('P21 Sunrise Cafe') && named('P21 Noodle House') && named('P21 Lantern Grill'),
        JSON.stringify(out.titles.slice(0, 16)), s);
      await t('tp-places P21: both activity slots survive too',
        named('P21 Viewpoint Trail') && named('P21 Island Hop'),
        JSON.stringify(out.titles.slice(0, 16)), s);
      await t('tp-places P21: ONE invented venue does not take the others with it',
        !named('P21 Phantom Pavilion') && out.titles.length >= 8,
        JSON.stringify({ count: out.titles.length, phantom: named('P21 Phantom Pavilion') }), s);
    });
  }

  return R;
}
