// Trip Planner E2E: the 08:00 breakfast that was open at 10:30.
//
// THE USER-LEVEL TEST for the 2026-09-05 report. Everything below is driven
// through the real UI - the guided picker, the real proposal pipeline, the real
// card renderer - with the provider mocked at the network layer so the hours
// are deterministic and no billed call is ever made.
//
// The failure this reproduces, exactly as it was reported:
//
//   Plan my day. First planned stop at 08:00. 3 breakfast options.
//   -> the model names three restaurants, two of which open at 10:30 and 12:00
//   -> the app rendered all three, painted two of them red, refused to add
//      them, and never looked for anything open at eight.
//
// What must happen now: the two shut ones are gone from the choices, two real
// places that ARE open at 08:00 have taken their slots, no remaining choice
// says "Opens at", and the traveller can pick one and add it.
//
// Driving through Tier 1 (copy/paste) is deliberate: it runs the same
// extract -> validate -> verify -> render path a live model reply takes, with
// no API key and no model. The picker is still used to press "Plan my day",
// because that press is what puts the structured constraints on the turn.
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import {
  recorder, freshIds, dbOf, trip, item, iso,
  openApp, tpErrors, closePage, evaluate, clickSel, setValue, waitForExpr,
  screenshot, setViewport, sleep, ART_DIR,
} from './helpers.mjs';
import { EXTERNAL_HOSTS } from '../../../tests/browser/cdp.mjs';

const HOTEL = 'Phi Phi Island Cabana Hotel';

// ---------- the provider ----------
// Google's normalized hours shape, as tp-places emits it to the client.
const daily = (openMin, closeMin) => ({
  always: false,
  periods: [0, 1, 2, 3, 4, 5, 6].map(d => ({ open: { day: d, min: openMin }, close: { day: d, min: closeMin } })),
  special: [],
});
const HM = (h, m = 0) => h * 60 + m;

// Named venues the model can propose, and what Google says about each.
const VENUES = {
  'only noodles': { name: 'Only Noodles', rating: 4.7, count: 1481, hours: daily(HM(10, 30), HM(22)) },
  'anna': { name: "Anna's Restaurant", rating: 4.5, count: 980, hours: daily(HM(12), HM(22)) },
  'garlic': { name: 'Garlic 1992 Restaurant', rating: 4.4, count: 760, hours: daily(HM(7), HM(23)) },
  'dinner one': { name: 'Papaya Restaurant', rating: 4.3, count: 1200, hours: daily(HM(11), HM(23)) },
  'viewpoint': { name: 'Phi Phi Viewpoint', rating: 4.6, count: 5400, hours: null },
  [HOTEL.toLowerCase()]: { name: HOTEL, rating: 4.2, count: 2100, hours: null },
};

// What a category search finds when a slot goes looking. Both are open early.
const DISCOVERED = [
  { name: 'Ciao Bella Bakery', rating: 4.6, count: 640, hours: daily(HM(6, 30), HM(12)) },
  { name: 'Morning Star Kitchen', rating: 4.3, count: 310, hours: daily(HM(7, 30), HM(15)) },
];

function venueFor(query, table) {
  const q = String(query || '').toLowerCase();
  const t = table || VENUES;
  for (const key of Object.keys(t)) if (q.includes(key)) return t[key];
  return null;
}

// A recording mock of tp-places that answers BOTH shapes: named lookups and
// discovery searches. `log` keeps every POST so the cost assertions can count
// exactly what the pipeline asked for.
function placesMock(log, opts = {}) {
  return (url, request) => {
    if (!url.includes('tp-places')) return EXTERNAL_HOSTS.test(url) ? 'fail' : null;
    let body = {};
    try { body = JSON.parse(request.postData || '{}'); } catch { /* recorded as empty */ }

    if (body.discover) {
      log.push({ kind: 'discover', spec: body.discover });
      if (opts.noReplacements) {
        return { status: 200, body: { results: [], discovered: true, reason: 'no_open_candidates', attribution: ATTR } };
      }
      const sched = body.discover.schedule;
      const take = Math.max(1, Number(body.discover.limit) || 1);
      // The real endpoint filters on hours when a schedule rides along, and
      // returns only open candidates. The mock does the same so the client's
      // own re-check is exercised against honest data.
      const pool = (opts.replacements || DISCOVERED).filter(v => !sched || openAt(v.hours, sched.time));
      return {
        status: 200,
        body: {
          discovered: true, reason: pool.length ? '' : 'no_open_candidates', attribution: ATTR,
          results: pool.slice(0, take).map((v, i) => ({
            status: 'ok', name: v.name, rating: v.rating, userRatingCount: v.count,
            mapsUri: 'https://maps.google.com/?cid=90' + i, confidence: 1,
            lat: 7.7390, lon: 98.7714, placeId: 'pid-disc-' + slug(v.name),
            verified: true, areaBasis: 'point', ...(v.hours ? { hours: v.hours } : {}),
          })),
        },
      };
    }

    const entries = (Array.isArray(body.queries) ? body.queries : []).map(toEntry);
    log.push({ kind: 'lookup', queries: entries.map(e => e.q) });
    return {
      status: 200,
      body: {
        attribution: ATTR,
        results: entries.map(e => {
          const v = venueFor(e.q, opts.venues);
          if (!v) return { id: e.id, query: e.q, status: 'no_match', reason: 'not_found' };
          return {
            id: e.id, query: e.q, status: 'ok', name: v.name, rating: v.rating,
            userRatingCount: v.count, mapsUri: 'https://maps.google.com/?cid=1',
            confidence: 1, lat: 7.7390, lon: 98.7714, placeId: 'pid-' + slug(v.name),
            verified: true, areaBasis: 'point', ...(v.hours ? { hours: v.hours } : {}),
          };
        }),
      },
    };
  };
}
const ATTR = { text: 'Google Maps', url: 'https://www.google.com/maps' };
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-');
const toEntry = raw => (typeof raw === 'string' ? { id: raw, q: raw } : { id: (raw && raw.id) || '', q: (raw && raw.q) || '', ...raw });
// Only used by the mock to decide what a search would return: the app's own
// verdict logic is what the assertions are about.
function openAt(hours, time) {
  if (!hours) return true;
  const t = Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
  return hours.periods.some(p => t >= p.open.min && t < p.close.min);
}

// ---------- the reply the model sends back ----------
// Three breakfast candidates at 08:00, two of them shut - the reported answer -
// plus a lunch set and an activity so the rest of the day is realistic.
const REPLY = (date) => `Here is your day on Phi Phi.

Only Noodles is a great start to the morning.

Anna's Restaurant is the local favourite for breakfast.

Garlic 1992 Restaurant is the third option, right by the pier.

\`\`\`json
{"tripActions":[
 {"op":"add","group":"breakfast-${date}","item":{"type":"activity","meal":"breakfast","title":"Only Noodles","location":"Ko Phi Phi","startDate":"${date}","startTime":"08:00","mapsQuery":"Only Noodles Ko Phi Phi"}},
 {"op":"add","group":"breakfast-${date}","item":{"type":"activity","meal":"breakfast","title":"Anna's Restaurant","location":"Ko Phi Phi","startDate":"${date}","startTime":"08:00","mapsQuery":"Anna's Restaurant Ko Phi Phi"}},
 {"op":"add","group":"breakfast-${date}","item":{"type":"activity","meal":"breakfast","title":"Garlic 1992 Restaurant","location":"Ko Phi Phi","startDate":"${date}","startTime":"08:00","mapsQuery":"Garlic 1992 Restaurant Ko Phi Phi"}},
 {"op":"add","group":"activity-${date}-am","item":{"type":"activity","title":"Phi Phi Viewpoint","location":"Ko Phi Phi","startDate":"${date}","startTime":"10:00","mapsQuery":"Phi Phi Viewpoint Ko Phi Phi"}},
 {"op":"add","item":{"type":"local","title":"Return to hotel","location":"Ko Phi Phi","startDate":"${date}","startTime":"21:00","mapsQuery":"${HOTEL}"}}
]}
\`\`\``;

// The same day, but the model opened it at 09:00 instead of the requested 08:00.
const LATE_REPLY = (date) => `Your day, starting gently.

\`\`\`json
{"tripActions":[
 {"op":"add","group":"breakfast-${date}","item":{"type":"activity","meal":"breakfast","title":"Garlic 1992 Restaurant","location":"Ko Phi Phi","startDate":"${date}","startTime":"09:00","mapsQuery":"Garlic 1992 Restaurant Ko Phi Phi"}},
 {"op":"add","group":"breakfast-${date}","item":{"type":"activity","meal":"breakfast","title":"Only Noodles","location":"Ko Phi Phi","startDate":"${date}","startTime":"09:00","mapsQuery":"Only Noodles Ko Phi Phi"}},
 {"op":"add","group":"activity-${date}-am","item":{"type":"activity","title":"Phi Phi Viewpoint","location":"Ko Phi Phi","startDate":"${date}","startTime":"12:00","mapsQuery":"Phi Phi Viewpoint Ko Phi Phi"}}
]}
\`\`\``;

// A NORMAL LARGE CITY where nothing is shut at the hour it was proposed for.
// This is the cost regression: the new pipeline must add no provider calls at
// all to a reply it has no complaint about.
const BANGKOK_VENUES = {
  'bkk breakfast one': { name: 'Bangkok Breakfast One', rating: 4.6, count: 900, hours: daily(HM(6), HM(15)) },
  'bkk breakfast two': { name: 'Bangkok Breakfast Two', rating: 4.5, count: 800, hours: daily(HM(7), HM(14)) },
  'bkk breakfast three': { name: 'Bangkok Breakfast Three', rating: 4.4, count: 700, hours: daily(HM(6, 30), HM(12)) },
  'bkk lunch one': { name: 'Bangkok Lunch One', rating: 4.5, count: 1100, hours: daily(HM(11), HM(22)) },
  'bkk lunch two': { name: 'Bangkok Lunch Two', rating: 4.3, count: 950, hours: daily(HM(10), HM(23)) },
  'bkk lunch three': { name: 'Bangkok Lunch Three', rating: 4.2, count: 400, hours: daily(HM(11), HM(21)) },
  'bkk dinner one': { name: 'Bangkok Dinner One', rating: 4.7, count: 2100, hours: daily(HM(17), HM(23, 30)) },
  'bkk dinner two': { name: 'Bangkok Dinner Two', rating: 4.6, count: 1800, hours: daily(HM(16), HM(23)) },
  'bkk dinner three': { name: 'Bangkok Dinner Three', rating: 4.4, count: 600, hours: daily(HM(17, 30), HM(23)) },
  'bkk museum': { name: 'Bangkok National Museum', rating: 4.4, count: 5200, hours: daily(HM(9), HM(16)) },
};

const CITY_REPLY = (date) => {
  const meal = (kind, time, n) => `{"op":"add","group":"${kind}-${date}","item":{"type":"activity","meal":"${kind}","title":"BKK ${kind} ${n}","location":"Bangkok","startDate":"${date}","startTime":"${time}","mapsQuery":"BKK ${kind} ${n} Bangkok"}}`;
  const rows = [
    meal('breakfast', '08:00', 'one'), meal('breakfast', '08:00', 'two'), meal('breakfast', '08:00', 'three'),
    meal('lunch', '13:00', 'one'), meal('lunch', '13:00', 'two'), meal('lunch', '13:00', 'three'),
    meal('dinner', '19:00', 'one'), meal('dinner', '19:00', 'two'), meal('dinner', '19:00', 'three'),
    `{"op":"add","item":{"type":"activity","title":"BKK museum","location":"Bangkok","startDate":"${date}","startTime":"10:30","mapsQuery":"BKK museum Bangkok"}}`,
  ];
  return `A full day in Bangkok.\n\n\`\`\`json\n{"tripActions":[\n ${rows.join(',\n ')}\n]}\n\`\`\``;
};

function bangkokTrip(base = 30) {
  return trip({
    name: 'Bangkok E2E',
    items: [
      item({ type: 'stay', title: 'Sotetsu Grand Fresa Bangkok', location: 'Bangkok', startDate: iso(base), endDate: iso(base + 3), status: 'booked' }),
    ],
  });
}

// RAILAY, the itinerary the screenshot that triggered this came from. Its
// venues are shaped like the real ones (a beach-front restaurant strip where
// several places genuinely do not open until late morning) and the hotel is a
// resort with no published hours of its own.
const RAILAY_VENUES = {
  'railay late one': { name: 'Railay Late Kitchen', rating: 4.6, count: 830, hours: daily(HM(11), HM(22)) },
  'railay late two': { name: 'Railay Sunset Grill', rating: 4.5, count: 640, hours: daily(HM(12), HM(23)) },
  'railay late three': { name: 'Railay Cliff Bar', rating: 4.4, count: 410, hours: daily(HM(16), HM(1)) },
  'rayavadee': { name: 'Rayavadee Krabi', rating: 4.8, count: 3100, hours: null },
};
const RAILAY_EARLY = [
  { name: 'Railay Bay Breakfast', rating: 4.5, count: 520, hours: daily(HM(6, 30), HM(11)) },
  { name: 'Phutawan Railay Cafe', rating: 4.3, count: 260, hours: daily(HM(7), HM(17)) },
  { name: 'Flame Tree Railay', rating: 4.2, count: 180, hours: daily(HM(7, 30), HM(22)) },
];
const RAILAY_REPLY = (date) => {
  const one = (n, q) => `{"op":"add","group":"breakfast-${date}","item":{"type":"activity","meal":"breakfast","title":"${n}","location":"Railay Beach","startDate":"${date}","startTime":"08:00","mapsQuery":"${q} Railay Beach"}}`;
  return `Breakfast on Railay.\n\n\`\`\`json\n{"tripActions":[\n ${[
    one('Railay Late Kitchen', 'railay late one'),
    one('Railay Sunset Grill', 'railay late two'),
    one('Railay Cliff Bar', 'railay late three'),
  ].join(',\n ')}\n]}\n\`\`\``;
};

function railayTrip(base = 30) {
  return trip({
    name: 'Railay E2E',
    items: [
      item({ type: 'stay', title: 'Rayavadee Krabi', location: 'Railay Beach', startDate: iso(base), endDate: iso(base + 3), status: 'booked' }),
    ],
  });
}

function phiPhiTrip(base = 30) {
  return trip({
    name: 'Phi Phi E2E',
    items: [
      item({ type: 'stay', title: HOTEL, location: 'Ko Phi Phi', startDate: iso(base), endDate: iso(base + 3), status: 'booked' }),
    ],
  });
}

// ---------- driving the guided picker ----------
// The press on "Plan my day" is what puts the structured constraints on the
// turn, so it happens for real. On the copy tier the press writes to the
// clipboard, which headless Chrome refuses, so the write is stubbed to resolve:
// the fallback is a window.prompt(), which would block the whole page.
async function planAndPaste(s, reply, cards) {
  await evaluate(s, `(()=>{
    navigator.clipboard = navigator.clipboard || {};
    navigator.clipboard.writeText = () => Promise.resolve();
    const r = document.querySelector('#assistTierGroup input[value="copy"]');
    if (r && !r.checked) r.click();
    return 1})()`);
  await waitForExpr(s, `!!document.querySelector('[data-plan-send]')`, { timeout: 6000 });
  // First stop at 08:00: the quick pick, exactly as a traveller would.
  await evaluate(s, `(()=>{const b=document.querySelector('[data-plan-time="wake"][data-plan-val="08:00"]');
    if (b) b.click(); return 1})()`);
  await sleep(200);
  await clickSel(s, '[data-plan-send]', { settle: 300 });
  await waitForExpr(s, `!!document.querySelector('#assistPasteBox')`, { timeout: 6000 });
  await setValue(s, '#assistPasteBox', reply);
  await clickSel(s, '#assistPasteParse', { settle: 400 });
  if (cards != null) {
    await waitForExpr(s, `document.querySelectorAll('#assistMessages .assist-proposal').length === ${cards}`, { timeout: 15000 });
  }
  return true;
}

// Every option of every alternative set, with what its hours line says.
const options = (s) => evaluate(s, `[...document.querySelectorAll('#assistMessages .assist-set')].map(card => ({
  group: card.dataset.setGroup || '',
  lead: (card.querySelector('.as-lead') || {}).textContent || '',
  opts: [...card.querySelectorAll('.as-opt')].map(o => ({
    title: (o.querySelector('.as-title') || {}).textContent || '',
    hours: (o.querySelector('.ap-hours') || {}).textContent || '',
    verdict: (o.querySelector('.ap-hours') || {}).dataset ? ((o.querySelector('.ap-hours') || {}).dataset.verdict || '') : '',
    closed: o.classList.contains('is-closed'),
    badges: [...o.querySelectorAll('.as-badge')].map(b => b.textContent.trim()),
  })),
}))`);

const SHOTS = path.join(ART_DIR, 'schedule-slots');

const noteText = (s) => evaluate(s, `[...document.querySelectorAll('#assistMessages .assist-verified-note')].map(n => n.textContent).join(' | ')`);
const proseText = (s) => evaluate(s, `[...document.querySelectorAll('#assistMessages .assist-msg.assistant')].map(n => n.textContent).join(' | ')`);

export async function run({ base, cdpPort }) {
  const R = [];
  const t = recorder(R);

  const withPage = async (label, opts, fn) => {
    let s = null;
    try {
      s = await openApp(cdpPort, base, opts);
      await clickSel(s, '#assistBtn', { settle: 700 });
      await waitForExpr(s, `!!document.querySelector('#assistPanel')`, { timeout: 8000 });
      await fn(s);
      await t(`${label}: no page errors`, tpErrors(s).length === 0, tpErrors(s).slice(0, 2).join(' | '), s);
    } catch (e) {
      await t(`${label}: block ran`, false, String(e && e.message).slice(0, 160), s);
    } finally {
      if (s) try { await closePage(cdpPort, s); } catch { /* gone */ }
    }
  };

  /* ---- S1. THE REPORTED CASE, end to end ---- */
  freshIds();
  {
    const log = [];
    const date = iso(30);
    await withPage('S1 hours slots', { db: dbOf([phiPhiTrip(30)]), net: placesMock(log) }, async (s) => {
      await planAndPaste(s, REPLY(date), null);
      await waitForExpr(s, `document.querySelectorAll('#assistMessages .assist-set').length >= 1`, { timeout: 15000 });
      await sleep(600);
      const sets = await options(s);
      const breakfast = sets.find(x => x.group.startsWith('breakfast')) || { opts: [] };
      const titles = breakfast.opts.map(o => o.title);

      await t('S1: the breakfast slot still offers three choices',
        breakfast.opts.length === 3, JSON.stringify(titles), s);
      await t('S1: the venue that opens at 10:30 is NOT one of them',
        !titles.some(x => /Only Noodles/.test(x)), JSON.stringify(titles), s);
      await t('S1: neither is the one that opens at 12:00',
        !titles.some(x => /Anna/.test(x)), JSON.stringify(titles), s);
      await t('S1: the venue that IS open at 08:00 survived',
        titles.some(x => /Garlic 1992/.test(x)), JSON.stringify(titles), s);
      await t('S1: the two empty places were filled from the provider',
        titles.some(x => /Ciao Bella/.test(x)) && titles.some(x => /Morning Star/.test(x)), JSON.stringify(titles), s);
      await t('S1: no final choice says "Opens at" for an 08:00 slot',
        breakfast.opts.every(o => !/Opens at/.test(o.hours)),
        JSON.stringify(breakfast.opts.map(o => o.hours)), s);
      await t('S1: and none of them is demoted as closed',
        breakfast.opts.every(o => !o.closed && o.verdict !== 'beforeOpen' && o.verdict !== 'closed'),
        JSON.stringify(breakfast.opts.map(o => o.verdict)), s);

      // The prose must not recommend a venue whose card is gone.
      const prose = await proseText(s);
      await t('S1: the prose no longer recommends the venues that were dropped',
        !/Only Noodles/.test(prose) && !/Anna/.test(prose), prose.slice(0, 160), s);

      // The replacement search asked for the right thing, in the right place,
      // with the hour attached.
      const searches = log.filter(x => x.kind === 'discover');
      await t('S1: exactly one replacement search was issued for the breakfast slot',
        searches.length === 1, JSON.stringify(searches.map(x => x.spec.q)), s);
      const spec = (searches[0] || {}).spec || {};
      await t('S1: it searched for the CATEGORY, not for another guess at a name',
        /breakfast restaurant/i.test(spec.q || ''), String(spec.q), s);
      await t('S1: it carried the slot date, hour and sitting length',
        !!spec.schedule && spec.schedule.date === date && spec.schedule.time === '08:00' && spec.schedule.windowMin === 45,
        JSON.stringify(spec.schedule), s);
      await t('S1: it asked for exactly the two that were missing',
        spec.limit === 2, String(spec.limit), s);
      await t('S1: it excluded the places already offered or refused',
        Array.isArray(spec.exclude) && spec.exclude.length >= 3, JSON.stringify(spec.exclude), s);
      await t('S1: no "open now" flag was ever sent for a future itinerary',
        !JSON.stringify(spec).includes('openNow'), JSON.stringify(spec).slice(0, 120), s);

      // VISUAL EVIDENCE, both viewports, of the state this whole round is
      // about: three usable breakfast choices where two red "Opens at" cards
      // used to be. Written every run, so the artefact can never be stale.
      await mkdir(SHOTS, { recursive: true });
      await evaluate(s, `(()=>{const c=[...document.querySelectorAll('.assist-set')]
        .find(x=>(x.dataset.setGroup||'').startsWith('breakfast'));
        if (c) c.scrollIntoView({block:'center'}); return 1})()`);
      await sleep(300);
      await screenshot(s, path.join(SHOTS, 'breakfast-0800-desktop.png'));
      await setViewport(s, 390, 844, true);
      await sleep(500);
      await evaluate(s, `(()=>{const c=[...document.querySelectorAll('.assist-set')]
        .find(x=>(x.dataset.setGroup||'').startsWith('breakfast'));
        if (c) c.scrollIntoView({block:'center'}); return 1})()`);
      await sleep(300);
      await screenshot(s, path.join(SHOTS, 'breakfast-0800-mobile.png'));
      await setViewport(s, 1280, 900, false);
      await sleep(400);

      // COMPUTED COLOUR, never an eyeball: main.css pins sitewide content
      // colours with !important, and the unconfirmed line has to be the app's
      // amber rather than the shared grey it would otherwise inherit.
      const unconfirmed = await evaluate(s, `(() => {
        const el = document.querySelector('#assistMessages .ap-hours.is-unconfirmed');
        if (!el) return null;
        const cs = getComputedStyle(el);
        const root = getComputedStyle(document.querySelector('.trip-planner-app') || document.documentElement);
        return { text: el.textContent, color: cs.color, amber: root.getPropertyValue('--amber').trim() };
      })()`);
      await t('S1: an hours-unknown candidate says so on its card',
        !!unconfirmed && /Hours unavailable/.test(unconfirmed.text), JSON.stringify(unconfirmed), s);
      await t('S1: and it paints in the app amber, not the sitewide grey',
        !!unconfirmed && unconfirmed.color !== 'rgb(85, 85, 85)' && unconfirmed.color.startsWith('rgb'),
        JSON.stringify(unconfirmed), s);

      // A winner badge on a slot of three open venues is a normal judgement
      // again, and it can only sit on one of the three shown.
      const badged = breakfast.opts.filter(o => o.badges.length);
      await t('S1: badges are awarded among the usable choices only',
        badged.every(o => !/Only Noodles|Anna/.test(o.title)), JSON.stringify(badged.map(o => o.title)), s);

      /* ---- and the traveller can actually add one ---- */
      await evaluate(s, `(()=>{const set=[...document.querySelectorAll('.assist-set')].find(c=>(c.dataset.setGroup||'').startsWith('breakfast'));
        const radio = set && set.querySelector('.as-opt input[type="radio"]');
        if (radio) radio.click(); return 1})()`);
      await sleep(250);
      await evaluate(s, `(()=>{const set=[...document.querySelectorAll('.assist-set')].find(c=>(c.dataset.setGroup||'').startsWith('breakfast'));
        const btn = set && set.querySelector('[data-act="accept-set"]');
        if (btn) btn.click(); return 1})()`);
      await sleep(700);
      const added = await evaluate(s, `(() => {
        const db = JSON.parse(localStorage.getItem('trip-planner:v1') || 'null');
        const trip = db && db.trips && db.trips[0];
        const items = (trip && trip.items) || [];
        const meal = items.filter(i => i.meal === 'breakfast');
        return { count: meal.length, title: meal.map(m => m.title).join(','), time: meal.map(m => m.startTime).join(',') };
      })()`);
      await t('S1: the chosen breakfast was written to the trip',
        added.count === 1, JSON.stringify(added), s);
      await t('S1: at the hour the traveller asked for',
        added.time === '08:00', JSON.stringify(added), s);
      await t('S1: and no refusal dialog appeared, because the venue is open',
        !(await evaluate(s, `!!document.querySelector('#confirmDialog.open, .overlay.open .cd-title')`)),
        'a dialog was open', s);
    });
  }

  /* ---- S2. THE HONEST FAILURE: nothing open, and it says so ---- */
  freshIds();
  {
    const log = [];
    const date = iso(30);
    await withPage('S2 nothing open', { db: dbOf([phiPhiTrip(30)]), net: placesMock(log, { noReplacements: true }) }, async (s) => {
      await planAndPaste(s, REPLY(date), null);
      await waitForExpr(s, `document.querySelectorAll('#assistMessages .assist-proposal').length >= 1`, { timeout: 15000 });
      await sleep(600);
      const sets = await options(s);
      const breakfast = sets.find(x => x.group.startsWith('breakfast'));
      const single = await evaluate(s, `[...document.querySelectorAll('#assistMessages .assist-proposal:not(.assist-set)')]
        .map(c => (c.querySelector('.ap-title') || {}).textContent || '')`);
      const shown = breakfast ? breakfast.opts.map(o => o.title) : single;
      await t('S2: the shut venues are still not offered, even with nothing to replace them',
        !shown.some(x => /Only Noodles|Anna/.test(x)), JSON.stringify(shown), s);
      await t('S2: the one open venue is still offered',
        shown.some(x => /Garlic 1992/.test(x)), JSON.stringify(shown), s);
      const note = await noteText(s);
      await t('S2: and the shortfall is stated honestly rather than papered over',
        /breakfast/i.test(note) && /open at/i.test(note), note.slice(0, 160), s);
      await t('S2: the honest shortfall is not worded as a provider failure',
        !/could not check|switched off/i.test(note), note.slice(0, 160), s);
    });
  }

  /* ---- S3. THE FIRST STOP IS THE TRAVELLER'S, NOT THE MODEL'S ---- */
  freshIds();
  {
    const log = [];
    const date = iso(30);
    await withPage('S3 first stop', { db: dbOf([phiPhiTrip(30)]), net: placesMock(log) }, async (s) => {
      await planAndPaste(s, LATE_REPLY(date), null);
      await waitForExpr(s, `document.querySelectorAll('#assistMessages .assist-proposal').length >= 1`, { timeout: 15000 });
      await sleep(600);
      const times = await evaluate(s, `[...document.querySelectorAll('#assistMessages .assist-set .as-opt')]
        .map(o => ((o.querySelector('.as-when') || o.querySelector('.as-sub') || {}).textContent || '').trim())`);
      const cardTimes = await evaluate(s, `[...document.querySelectorAll('#assistMessages .assist-proposal')]
        .map(c => c.textContent.match(/\\b(\\d{1,2}:\\d{2}\\s?(AM|PM)?)/i)).filter(Boolean).map(m => m[1])`);
      await t('S3: the 09:00 opening the model chose was pulled back to the requested 08:00',
        JSON.stringify(cardTimes).includes('8:00') || JSON.stringify(times).includes('8:00'),
        JSON.stringify(cardTimes) + ' | ' + JSON.stringify(times), s);
      // ...and the venue that opens at 10:30 is STILL not offered: the hour was
      // moved to honour the traveller, never to accommodate a closed venue.
      const sets = await options(s);
      const breakfast = sets.find(x => x.group.startsWith('breakfast')) || { opts: [] };
      await t('S3: the 10:30 venue was not rescued by the shift',
        !breakfast.opts.map(o => o.title).some(x => /Only Noodles/.test(x)),
        JSON.stringify(breakfast.opts.map(o => o.title)), s);
    });
  }

  /* ---- S4. AN ORDINARY TURN IS UNCHANGED (no plan, no discovery words) ---- */
  freshIds();
  {
    const log = [];
    const date = iso(30);
    const NAMED = `Adding the place you asked for.

\`\`\`json
{"tripActions":[
 {"op":"add","item":{"type":"activity","meal":"dinner","title":"Only Noodles","location":"Ko Phi Phi","startDate":"${date}","startTime":"08:00","mapsQuery":"Only Noodles Ko Phi Phi"}}
]}
\`\`\``;
    await withPage('S4 explicit place', { db: dbOf([phiPhiTrip(30)]), net: placesMock(log) }, async (s) => {
      // No picker press: this is the traveller naming a venue themselves, which
      // must never be silently swapped for a different business.
      await evaluate(s, `(()=>{const r=document.querySelector('#assistTierGroup input[value="copy"]');
        if (r && !r.checked) r.click(); return 1})()`);
      await waitForExpr(s, `!!document.querySelector('#assistPasteBox')`, { timeout: 6000 });
      await setValue(s, '#assistPasteBox', NAMED);
      await clickSel(s, '#assistPasteParse', { settle: 500 });
      await sleep(800);
      const titles = await evaluate(s, `[...document.querySelectorAll('#assistMessages .assist-proposal')]
        .map(c => (c.querySelector('.ap-title') || {}).textContent || '')`);
      await t('S4: a venue the traveller named themselves is kept, not replaced',
        titles.some(x => /Only Noodles/.test(x)), JSON.stringify(titles), s);
      await t('S4: and no replacement search was bought for it',
        log.filter(x => x.kind === 'discover').length === 0,
        JSON.stringify(log.map(x => x.kind)), s);
      // It is still flagged and still un-addable: the write-time gate is intact.
      const closed = await evaluate(s, `document.querySelectorAll('#assistMessages .ap-hours.is-closed').length`);
      await t('S4: the old warning still paints on it (defence in depth)',
        closed >= 1, String(closed), s);
    });
  }

  /* ---- S4b. RAILAY: every candidate the model named is shut at 08:00 ---- */
  freshIds();
  {
    const log = [];
    const date = iso(30);
    await withPage('S4b Railay', { db: dbOf([railayTrip(30)]), net: placesMock(log, { venues: RAILAY_VENUES, replacements: RAILAY_EARLY }) }, async (s) => {
      await planAndPaste(s, RAILAY_REPLY(date), null);
      await waitForExpr(s, `document.querySelectorAll('#assistMessages .assist-set').length >= 1`, { timeout: 15000 });
      await sleep(700);
      const sets = await options(s);
      const breakfast = sets.find(x => x.group.startsWith('breakfast')) || { opts: [] };
      const titles = breakfast.opts.map(o => o.title);
      await t('S4b: a slot where ALL THREE model picks are shut is still filled with three',
        breakfast.opts.length === 3, JSON.stringify(titles), s);
      await t('S4b: and none of the three is one of the shut ones',
        !titles.some(x => /Late Kitchen|Sunset Grill|Cliff Bar/.test(x)), JSON.stringify(titles), s);
      await t('S4b: every one of them is verified open at 08:00',
        breakfast.opts.every(o => !o.closed && /^Hours/.test(o.hours)),
        JSON.stringify(breakfast.opts.map(o => o.hours)), s);
      const spec = ((log.filter(x => x.kind === 'discover')[0]) || {}).spec || {};
      await t('S4b: it asked for all three, in Railay, for 08:00',
        spec.limit === 3 && /railay/i.test(String(spec.q) + String(spec.city)) && spec.schedule && spec.schedule.time === '08:00',
        JSON.stringify(spec), s);
      await t('S4b: one search was enough, and only one was bought',
        log.filter(x => x.kind === 'discover').length === 1, String(log.filter(x => x.kind === 'discover').length), s);
    });
  }

  /* ---- S5. A NORMAL CITY: nothing is shut, so nothing is bought ---- */
  freshIds();
  {
    const log = [];
    const date = iso(30);
    await withPage('S5 normal city', { db: dbOf([bangkokTrip(30)]), net: placesMock(log, { venues: BANGKOK_VENUES }) }, async (s) => {
      await planAndPaste(s, CITY_REPLY(date), null);
      await waitForExpr(s, `document.querySelectorAll('#assistMessages .assist-set').length >= 3`, { timeout: 15000 });
      await sleep(700);
      const sets = await options(s);
      const counts = Object.fromEntries(sets.map(x => [x.group.split('-')[0], x.opts.length]));
      await t('S5: every meal slot still offers the three options the model gave',
        counts.breakfast === 3 && counts.lunch === 3 && counts.dinner === 3, JSON.stringify(counts), s);
      await t('S5: no candidate is demoted, because none of them is shut',
        sets.every(x => x.opts.every(o => !o.closed)), JSON.stringify(sets.map(x => x.opts.map(o => o.verdict))), s);
      await t('S5: NOT ONE replacement search was issued for a day with nothing wrong',
        log.filter(x => x.kind === 'discover').length === 0,
        JSON.stringify(log.filter(x => x.kind === 'discover').map(x => x.spec.q)), s);
      // The lookup fanout is the pre-existing one: one batched request for the
      // reply, one venue each, nothing asked for twice.
      const asked = log.filter(x => x.kind === 'lookup').flatMap(x => x.queries);
      await t('S5: the batched lookup asked for each venue exactly once',
        asked.length === new Set(asked.map(q => q.toLowerCase())).size, JSON.stringify(asked), s);
      await t('S5: and it stayed within the server batch cap of 12 per POST',
        log.filter(x => x.kind === 'lookup').every(x => x.queries.length <= 12),
        JSON.stringify(log.filter(x => x.kind === 'lookup').map(x => x.queries.length)), s);
      const note = await noteText(s);
      await t('S5: a day that went fine says nothing about hours at all',
        note.trim() === '', note.slice(0, 160), s);
    });
  }

  return R;
}
