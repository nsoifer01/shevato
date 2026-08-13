// Trip Planner E2E: rendering surfaces.
//   K. filters and search (text / type / status / traveler / clear) and the
//      whole-trip computations they must NOT change
//   L. warnings panel -> row navigation ("show", gap "show", "Add stay",
//      "Mark booked")
//   O. Days view rendering (check-in/out, timed rows, covered-empty day,
//      no-bed day, cancelled rows, Maps link, manual tie ordering)
//   R. large-trip smoke: ~340 items render and stay interactive
import {
  LS_KEY, recorder, freshIds, iso, item, trip, dbOf,
  openApp, readDb, rowCount, tpErrors,
  switchView, closePage, evaluate, waitForExpr,
  clickSel, setValue, sleep,
} from './helpers.mjs';

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

  /* ---------------------- K. filters and search -------------------------- */
  freshIds();
  const kTrip = trip({
    name: 'Filter trip',
    travelers: ['Alex', 'Sam'],
    items: [
      item({ type: 'flight', title: 'Flight out', startDate: iso(30), startTime: '08:00', status: 'booked', cost: 500, costCurrency: 'USD' }),
      item({ type: 'stay', title: 'Shared hotel', location: 'Porto', startDate: iso(30), endDate: iso(33), status: 'booked', cost: 300, costCurrency: 'USD' }),
      item({ title: 'Alex spa', startDate: iso(31), startTime: '10:00', status: 'to-book', cost: 50, costCurrency: 'USD', travelers: ['Alex'] }),
      item({ title: 'Sam museum', startDate: iso(31), startTime: '15:00', status: 'booked', cost: 20, costCurrency: 'USD', travelers: ['Sam'] }),
      item({ type: 'note', title: 'Group note', startDate: iso(32) }),
    ],
  });
  await withPage('tp-views K', { db: dbOf([kTrip]) }, async (s) => {
    const rowTitles = () => evaluate(s, `[...document.querySelectorAll('#board .tp-row .c-title')].map(e=>e.textContent.trim())`);
    const summaryText = () => evaluate(s, `document.getElementById('summary').innerText`);
    const stripCells = () => evaluate(s, `document.getElementById('strip').children.length`);

    const summaryBefore = await summaryText();
    const stripBefore = await stripCells();

    // text search (filtering force-expands the stay groups)
    await setValue(s, '#searchBox', 'spa');
    await sleep(700);
    // A stay drawn only because something inside it matches keeps its wrapper
    // row (documented app behaviour), so assertions check which ITEMS are
    // visible rather than a bare row count.
    let titles = (await rowTitles()).join('|');
    await t('tp-views K: text search narrows the timeline', titles.includes('Alex spa')
      && !titles.includes('Sam museum') && !titles.includes('Flight out') && !titles.includes('Group note'), titles, s);
    await t('tp-views K: filtering never changes the totals', (await summaryText()) === summaryBefore, '', s);
    await t('tp-views K: filtering never changes night coverage', (await stripCells()) === stripBefore, '', s);

    // search + days view stay consistent
    await switchView(s, 'days');
    await t('tp-views K: Days view honours the same filter', await evaluate(s, `(()=>{const c=[...document.querySelectorAll('.day-card')]; return c.length===1 && c[0].innerText.includes('Alex spa')})()`), '', s);
    await switchView(s, 'timeline');

    // type + status filters
    await setValue(s, '#searchBox', '');
    await setValue(s, '#filterType', 'activity');
    await sleep(500);
    titles = (await rowTitles()).join('|');
    await t('tp-views K: type filter shows only activities', titles.includes('Alex spa') && titles.includes('Sam museum')
      && !titles.includes('Flight out') && !titles.includes('Group note'), titles, s);
    await setValue(s, '#filterStatus', 'to-book');
    await sleep(500);
    titles = (await rowTitles()).join('|');
    await t('tp-views K: filters AND together', titles.includes('Alex spa') && !titles.includes('Sam museum'), titles, s);

    // traveler filter (only exists with a 2+ roster)
    await setValue(s, '#filterStatus', '');
    await setValue(s, '#filterType', '');
    await setValue(s, '#filterTraveler', 'Alex');
    await sleep(500);
    titles = (await rowTitles()).join('|');
    await t('tp-views K: traveler filter keeps their items plus Everyone items',
      titles.includes('Alex spa') && !titles.includes('Sam museum') && titles.includes('Flight out'), titles, s);

    // clear filters resets every control at once
    await t('tp-views K: Clear filters appears while filtering', await evaluate(s, `!document.getElementById('clearFiltersBtn').hidden`), '', s);
    await clickSel(s, '#clearFiltersBtn', { settle: 500 });
    const state = await evaluate(s, `({q:document.getElementById('searchBox').value, ty:document.getElementById('filterType').value, st:document.getElementById('filterStatus').value, tr:(document.getElementById('filterTraveler')||{}).value, hid:document.getElementById('clearFiltersBtn').hidden})`);
    await t('tp-views K: Clear filters resets everything', state.q === '' && state.ty === '' && state.st === '' && state.tr === '' && state.hid === true, JSON.stringify(state), s);
    await t('tp-views K: all rows return after clearing', (await rowCount(s)) >= 3, `rows=${await rowCount(s)}`, s);
  });

  /* ----------------- L. warnings -> row navigation ------------------------ */
  freshIds();
  const lTrip = trip({
    name: 'Warning trip',
    items: [
      item({ type: 'stay', title: 'Hotel One', startDate: iso(40), endDate: iso(42), status: 'booked' }),
      item({ type: 'stay', title: 'Hotel Two', startDate: iso(41), endDate: iso(43), status: 'booked' }),
      item({ type: 'stay', title: 'Hotel Three', startDate: iso(45), endDate: iso(47), status: 'booked' }),
      item({ type: 'flight', title: 'Morning hop', startDate: iso(40), startTime: '09:00', endDate: iso(40), endTime: '12:00', status: 'booked' }),
      item({ type: 'transport', title: 'Doomed leg', startDate: iso(40), startTime: '11:00', endDate: iso(40), endTime: '12:05', status: 'booked' }),
      item({ type: 'local', title: 'Tight shuttle', startDate: iso(40), startTime: '12:30', status: 'booked' }),
      item({ title: 'Old ticket', startDate: iso(-5), status: 'to-book' }),
      item({ title: 'Book museum', startDate: iso(50), status: 'to-book', bookBy: iso(3) }),
    ],
  });
  await withPage('tp-views L', { db: dbOf([lTrip]) }, async (s) => {
    const issues = () => evaluate(s, `document.getElementById('issuesList').innerText`);
    await evaluate(s, `document.getElementById('issuesDetails').open = true`);
    const text = await issues();
    await t('tp-views L: collision warning present', /Date collision: "Hotel One" and "Hotel Two"/.test(text), text.slice(0, 200), s);
    await t('tp-views L: uncovered-nights warning present', /No stay covers/.test(text), '', s);
    await t('tp-views L: impossible connection flagged', /Doomed leg/.test(text) && /leav|before|arriv/i.test(text), '', s);
    await t('tp-views L: tight connection flagged with minutes', /Tight connection: only 25 minutes/.test(text), '', s);
    await t('tp-views L: past to-book warning present', /"Old ticket" is in the past/.test(text), '', s);
    await t('tp-views L: booking deadline countdown present', /Book museum: book by .*3 days left/.test(text), '', s);

    // "show" jumps to and flashes the named row
    await clickSel(s, `.issue-jump[data-jump]`, { settle: 600 });
    await t('tp-views L: warning "show" flashes the row', await evaluate(s, `!!document.querySelector('#board .tp-row.flash')`), '', s);

    // gap "show" rings exactly the uncovered night cells in the strip
    await evaluate(s, `document.getElementById('issuesDetails').open = true`);
    await clickSel(s, `.issue-jump[data-gap-show]`, { settle: 500 });
    const flashed = await evaluate(s, `[...document.getElementById('strip').children].filter(c=>c.classList.contains('is-flash')).map(c=>c.dataset.date)`);
    await t('tp-views L: gap "show" rings the uncovered nights', JSON.stringify(flashed) === JSON.stringify([iso(43), iso(44)]), JSON.stringify(flashed), s);

    // "Add stay" opens the form pre-set to exactly the uncovered range
    await evaluate(s, `document.getElementById('issuesDetails').open = true`);
    await clickSel(s, `.issue-jump[data-add-stay]`, { settle: 600 });
    const form = await evaluate(s, `({open: document.getElementById('itemOverlay').classList.contains('open'), start: document.getElementById('inStart').value, end: document.getElementById('inEnd').value, endVisible: !!document.getElementById('fEnd').offsetParent})`);
    await t('tp-views L: "Add stay" pre-fills the gap', form.open && form.start === iso(43) && form.end === iso(45) && form.endVisible, JSON.stringify(form), s);
    await clickSel(s, '#itemOverlay [data-close]', { settle: 400 });

    // "Mark booked" answers a deadline warning in place, one undo step
    const museum = lTrip.items.find(x => x.title === 'Book museum');
    await evaluate(s, `document.getElementById('issuesDetails').open = true`);
    await clickSel(s, `.issue-mark-booked[data-book-id="${museum.id}"]`, { settle: 600 });
    const db = await readDb(s);
    await t('tp-views L: "Mark booked" books the item', db.trips[0].items.find(x => x.id === museum.id).status === 'booked', '', s);
    await t('tp-views L: ...and the warning line is gone', !/Book museum: book by/.test(await issues()), '', s);
  });

  /* --------------------------- O. Days view ------------------------------ */
  freshIds();
  const tieA = item({ title: 'Tied stroll', location: 'Reykjavik', startDate: iso(31), startTime: '16:00', status: 'booked' });
  const tieB = item({ title: 'Tied coffee', location: 'Reykjavik', startDate: iso(31), startTime: '16:00', status: 'booked' });
  const oTrip = trip({
    name: 'Days trip',
    items: [
      item({ type: 'flight', title: 'Boston (BOS) to Keflavik (KEF)', startDate: iso(30), startTime: '08:00', endDate: iso(30), endTime: '11:00', status: 'booked' }),
      item({ type: 'stay', title: 'Harbor Hotel', location: 'Reykjavik', startDate: iso(30), endDate: iso(33), status: 'booked' }),
      item({ title: 'Blue Lagoon', location: 'Reykjavik', startDate: iso(31), startTime: '11:00', status: 'booked', cost: 40, costCurrency: 'USD' }),
      item({ title: 'Whale watching', location: 'Reykjavik', startDate: iso(31), startTime: '13:00', status: 'cancelled' }),
      tieA, tieB,
      item({ type: 'flight', title: 'Keflavik (KEF) to Boston (BOS)', startDate: iso(35), startTime: '10:00', status: 'to-book' }),
    ],
  });
  await withPage('tp-views O', { db: dbOf([oTrip]) }, async (s) => {
    const bytesBefore = await evaluate(s, `localStorage.getItem(${JSON.stringify(LS_KEY)})`);
    await switchView(s, 'days');
    const card = (d) => `[...document.querySelectorAll('.day-card')].find(c=>c.dataset.date===${JSON.stringify(iso(d))})`;
    await t('tp-views O: one card per trip day', await evaluate(s, `document.querySelectorAll('.day-card').length`) === 6, '', s);
    await t('tp-views O: arrival day shows travel and check-in', await evaluate(s, `(()=>{const c=${card(30)}; return !!c && /check in/i.test(c.innerText) && c.innerText.includes('Keflavik')})()`), '', s);
    await t('tp-views O: timed activity renders with its time', await evaluate(s, `(()=>{const c=${card(31)}; return !!c && c.innerText.includes('Blue Lagoon') && /11:00/.test(c.innerText)})()`), '', s);
    await t('tp-views O: cancelled row wears its badge', await evaluate(s, `(()=>{const c=${card(31)}; const r=[...c.querySelectorAll('.dc-event')].find(e=>e.innerText.includes('Whale watching')); return !!r && r.className.includes('is-cancelled') && /cancelled/i.test(r.innerText)})()`), '', s);
    await t('tp-views O: activity carries a Google Maps link', await evaluate(s, `(()=>{const c=${card(31)}; return !!c && [...c.querySelectorAll('a')].some(a=>a.textContent.includes('Google Maps') && a.href.includes('google'))})()`), '', s);
    await t('tp-views O: covered-empty day says who hosts it', await evaluate(s, `(()=>{const c=${card(32)}; return !!c && /Staying at|Nothing planned/i.test(c.innerText) && c.innerText.includes('Harbor Hotel')})()`), '', s);
    await t('tp-views O: check-out renders on the leaving day', await evaluate(s, `(()=>{const c=${card(33)}; return !!c && /check out/i.test(c.innerText)})()`), '', s);
    await t('tp-views O: a no-bed day is honestly empty', await evaluate(s, `(()=>{const c=${card(34)}; return !!c && /No plans yet/i.test(c.innerText)})()`), '', s);

    // manual ordering exists exactly on the tied rows
    const grips = await evaluate(s, `[...document.querySelectorAll('#daysList .dc-grip')].map(g=>g.dataset.grip)`);
    await t('tp-views O: only tied rows offer a reorder grip', grips.length === 2 && grips.includes(tieA.id) && grips.includes(tieB.id), JSON.stringify(grips), s);
    await evaluate(s, `(()=>{const g=[...document.querySelectorAll('#daysList .dc-grip')].find(x=>x.dataset.grip===${JSON.stringify(tieA.id)}); if(g) g.focus(); return 1})()`);
    await evaluate(s, `(()=>{const g=document.activeElement; if(!g||!g.classList.contains('dc-grip')) return 0; g.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true})); return 1})()`);
    await sleep(500);
    const db = await readDb(s);
    const orderStored = db.trips[0].items.filter(x => Number.isInteger(x.order)).length;
    await t('tp-views O: keyboard reorder stores a manual order', orderStored >= 2, `ordered=${orderStored}`, s);
    const tiedNow = await evaluate(s, `[...document.querySelectorAll('#daysList .dc-event[data-tie]')].map(e=>e.dataset.id)`);
    await t('tp-views O: the tied pair actually swapped', JSON.stringify(tiedNow) === JSON.stringify([tieB.id, tieA.id]), JSON.stringify(tiedNow), s);

    // view switching is navigation, not mutation (ordering above was the only write)
    const bytesAfterOrder = await evaluate(s, `localStorage.getItem(${JSON.stringify(LS_KEY)})`);
    await switchView(s, 'timeline');
    await switchView(s, 'days');
    await t('tp-views O: switching views never writes data', (await evaluate(s, `localStorage.getItem(${JSON.stringify(LS_KEY)})`)) === bytesAfterOrder && bytesAfterOrder !== bytesBefore, '', s);
  });

  /* ------------------------ R. large-trip smoke --------------------------- */
  freshIds();
  const bigItems = [];
  for (let d = 0; d < 60; d++) {
    const day = 10 + d;
    if (d % 3 === 0) bigItems.push(item({ type: 'stay', title: `Hotel block ${d / 3}`, location: 'Rome', startDate: iso(day), endDate: iso(day + 3), status: 'booked', cost: 200, costCurrency: 'USD' }));
    bigItems.push(item({ title: `Morning walk ${d}`, location: 'Rome', startDate: iso(day), startTime: '09:00', status: 'booked' }));
    bigItems.push(item({ title: `Lunch spot ${d}`, location: 'Rome', startDate: iso(day), startTime: '13:00', status: 'to-book', cost: 25, costCurrency: 'USD' }));
    bigItems.push(item({ title: `Dinner ${d}`, location: 'Rome', startDate: iso(day), startTime: '20:00', status: 'to-book' }));
    bigItems.push(item({ type: 'note', title: `Reminder ${d}`, startDate: iso(day) }));
  }
  const rTrip = trip({ name: 'Grand tour', items: bigItems });
  {
    let s = null;
    try {
      const t0 = Date.now();
      s = await openApp(cdpPort, base, { db: dbOf([rTrip]), settle: 1500 });
      const bootMs = Date.now() - t0;
      await t('tp-views R: 320-item trip boots', true, `~${bootMs}ms including navigation`, s);
      const db = await readDb(s);
      await t('tp-views R: every item survives the load', db.trips[0].items.length === bigItems.length, `items=${db.trips[0].items.length}`, s);
      await t('tp-views R: timeline renders rows', (await rowCount(s)) > 0, `rows=${await rowCount(s)}`, s);

      // still interactive: search narrows to one row, days view renders all days
      await setValue(s, '#searchBox', 'Dinner 41');
      // the match sits inside a stay whose wrapper row stays visible, so the
      // narrowed board is the match plus its host
      const narrowed = await waitForExpr(s, `(()=>{const r=[...document.querySelectorAll('#board .tp-row')]; return r.length <= 2 && r.some(x=>x.innerText.includes('Dinner 41'))})()`, { timeout: 8000 });
      await t('tp-views R: search stays responsive', narrowed, `rows=${await rowCount(s)}`, s);
      await setValue(s, '#searchBox', '');
      await sleep(800);
      const tDays = Date.now();
      await switchView(s, 'days', 2000);
      const cards = await evaluate(s, `document.querySelectorAll('.day-card').length`);
      await t('tp-views R: Days view renders the whole span', cards >= 60, `cards=${cards} in ~${Date.now() - tDays}ms`, s);
      await t('tp-views R: no page errors at scale', tpErrors(s).length === 0, tpErrors(s).slice(0, 2).join(' | '), s);
    } catch (e) {
      await t('tp-views R: block ran', false, String(e && e.message).slice(0, 140), s);
    } finally {
      if (s) try { await closePage(cdpPort, s); } catch { /* gone */ }
    }
  }

  return R;
}
