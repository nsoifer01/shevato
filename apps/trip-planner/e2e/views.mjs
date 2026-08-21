// Trip Planner E2E: rendering surfaces.
//   K. filters and search (text / type / status / traveler / clear) and the
//      whole-trip computations they must NOT change
//   L. warnings panel -> row navigation ("show", gap "show", "Add stay",
//      "Mark booked")
//   O. Days view rendering (check-in/out, timed rows, covered-empty day,
//      no-bed day, cancelled rows, Maps link, manual tie ordering)
//   O2. the day-card header overflow menu (open/close/Escape/outside click)
//   O3. Food & Drink as a real type + category (migration, form, filters,
//       icon-only cards with an accessible category name)
//   R. large-trip smoke: ~340 items render and stay interactive
import {
  LS_KEY, APP, recorder, freshIds, iso, item, trip, dbOf,
  openApp, readDb, rowCount, tpErrors,
  switchView, closePage, evaluate, waitForExpr,
  clickSel, setValue, expandTimeline, menuAct, gotoHard, escape, sleep,
} from './helpers.mjs';
import TripLogic from '../js/trip-logic.js';

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

    // text search (filtering force-expands the stay groups); wait for the
    // filtered render itself, not a fixed settle
    await setValue(s, '#searchBox', 'spa');
    await waitForExpr(s, `(()=>{const t=[...document.querySelectorAll('#board .tp-row .c-title')].map(e=>e.textContent);
      return t.some(x=>x.includes('Alex spa')) && !t.some(x=>x.includes('Sam museum'))})()`, { timeout: 6000 });
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
    await waitForExpr(s, `(()=>{const t=[...document.querySelectorAll('#board .tp-row .c-title')].map(e=>e.textContent);
      return t.some(x=>x.includes('Sam museum')) && !t.some(x=>x.includes('Flight out'))})()`, { timeout: 6000 });
    titles = (await rowTitles()).join('|');
    await t('tp-views K: type filter shows only activities', titles.includes('Alex spa') && titles.includes('Sam museum')
      && !titles.includes('Flight out') && !titles.includes('Group note'), titles, s);
    await setValue(s, '#filterStatus', 'to-book');
    await waitForExpr(s, `(()=>{const t=[...document.querySelectorAll('#board .tp-row .c-title')].map(e=>e.textContent);
      return t.some(x=>x.includes('Alex spa')) && !t.some(x=>x.includes('Sam museum'))})()`, { timeout: 6000 });
    titles = (await rowTitles()).join('|');
    await t('tp-views K: filters AND together', titles.includes('Alex spa') && !titles.includes('Sam museum'), titles, s);

    // traveler filter (only exists with a 2+ roster)
    await setValue(s, '#filterStatus', '');
    await setValue(s, '#filterType', '');
    await setValue(s, '#filterTraveler', 'Alex');
    await waitForExpr(s, `(()=>{const t=[...document.querySelectorAll('#board .tp-row .c-title')].map(e=>e.textContent);
      return t.some(x=>x.includes('Flight out')) && !t.some(x=>x.includes('Sam museum'))})()`, { timeout: 6000 });
    titles = (await rowTitles()).join('|');
    await t('tp-views K: traveler filter keeps their items plus Everyone items',
      titles.includes('Alex spa') && !titles.includes('Sam museum') && titles.includes('Flight out'), titles, s);

    // clear filters resets every control at once
    await t('tp-views K: Clear filters appears while filtering', await evaluate(s, `!document.getElementById('clearFiltersBtn').hidden`), '', s);
    await clickSel(s, '#clearFiltersBtn', { settle: 500 });
    const state = await evaluate(s, `({q:document.getElementById('searchBox').value, ty:document.getElementById('filterType').value, st:document.getElementById('filterStatus').value, tr:(document.getElementById('filterTraveler')||{}).value, hid:document.getElementById('clearFiltersBtn').hidden})`);
    await t('tp-views K: Clear filters resets everything', state.q === '' && state.ty === '' && state.st === '' && state.tr === '' && state.hid === true, JSON.stringify(state), s);
    // EXACT recovery, not ">= 3": after clearing and expanding, the visible
    // item titles are precisely the five the fixture seeded, nothing hidden
    // and nothing duplicated (wrapper rows repeat a title, so a Set is read).
    await expandTimeline(s);
    // .c-title carries decorations after the name (attachment glyph, inline
    // place), so match on the leading name, still exactly five distinct rows
    const allTitles = [...new Set(await rowTitles())];
    const want = ['Alex spa', 'Flight out', 'Group note', 'Sam museum', 'Shared hotel'];
    await t('tp-views K: all rows return after clearing',
      allTitles.length === want.length && want.every(w => allTitles.some(x => x.startsWith(w))),
      JSON.stringify(allTitles), s);
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
    // The countdown is computed by the APP at render time, so asserting the
    // literal "3 days left" flips whenever local midnight passes between the
    // fixture's iso(3) and the render. Recompute the expected label from the
    // stored bookBy date with the same local-calendar math, sampled before and
    // after the read so a midnight crossing mid-check is tolerated too.
    const bookByStr = lTrip.items.find(x => x.title === 'Book museum').bookBy;
    const daysUntil = (d) => {
      const [y, m, dd] = d.split('-').map(Number);
      const now = new Date();
      return Math.round((new Date(y, m - 1, dd) - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 864e5);
    };
    const leftBefore = daysUntil(bookByStr);
    const textNow = await issues();
    // 3 is the seed-time value (bookBy = iso(3)); it stays a candidate because
    // the app may have rendered the label before a midnight this check reads after
    const labels = [...new Set([3, leftBefore, daysUntil(bookByStr)])]
      .map(n => (n === 0 ? 'today' : `${n} ${n === 1 ? 'day' : 'days'} left`));
    const deadlineRe = new RegExp(`Book museum: book by .*(${labels.join('|')})`);
    await t('tp-views L: booking deadline countdown present', deadlineRe.test(textNow), `want ${deadlineRe} in ${textNow.slice(0, 200)}`, s);

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
    await waitForExpr(s, `JSON.parse(localStorage.getItem(${JSON.stringify(LS_KEY)})).trips[0].items.some(x=>Number.isInteger(x.order))`, { timeout: 6000 });
    const db = await readDb(s);
    // EXACTLY the tie pair and nobody else: applyManualOrder writes 0..n-1
    // onto the tied group and normalizeOrders strips `order` from every item
    // outside one, so a third ordered item is a regression, not extra credit.
    const ordered = db.trips[0].items.filter(x => Number.isInteger(x.order)).map(x => x.id).sort();
    const tiePair = [tieA.id, tieB.id].sort();
    await t('tp-views O: keyboard reorder stores a manual order on the tie pair only',
      JSON.stringify(ordered) === JSON.stringify(tiePair), `ordered=${JSON.stringify(ordered)}`, s);
    const tiedNow = await evaluate(s, `[...document.querySelectorAll('#daysList .dc-event[data-tie]')].map(e=>e.dataset.id)`);
    await t('tp-views O: the tied pair actually swapped', JSON.stringify(tiedNow) === JSON.stringify([tieB.id, tieA.id]), JSON.stringify(tiedNow), s);

    // view switching is navigation, not mutation (ordering above was the only write)
    const bytesAfterOrder = await evaluate(s, `localStorage.getItem(${JSON.stringify(LS_KEY)})`);
    await switchView(s, 'timeline');
    await switchView(s, 'days');
    await t('tp-views O: switching views never writes data', (await evaluate(s, `localStorage.getItem(${JSON.stringify(LS_KEY)})`)) === bytesAfterOrder && bytesAfterOrder !== bytesBefore, '', s);
  });

  /* ---------------- O3. Food & Drink: structured, not prefixed ------------ */
  // The round that replaced "type Dinner: into the title" with a real type and
  // a real category field. What this block owns is the WIRING - the form, the
  // storage, the filters and what a card renders; the vocabulary, the legacy
  // split and every pure surface are pinned in tests/food-drink.test.js.
  freshIds();
  const fdTrip = trip({
    name: 'Food trip',
    items: [
      // seeded in the LEGACY shape, exactly as a saved trip holds it today
      item({ type: 'activity', title: 'Dinner: Saba', location: 'New Orleans', startDate: iso(40), startTime: '19:00', status: 'to-book' }),
      item({ type: 'activity', title: 'Drinks: Hot Tin', location: 'New Orleans', startDate: iso(40), startTime: '21:30', status: 'to-book' }),
      item({ type: 'activity', title: 'The National WWII Museum', location: 'New Orleans', startDate: iso(40), startTime: '10:00', status: 'booked' }),
      item({ type: 'activity', title: 'Sunset dinner cruise', location: 'New Orleans', startDate: iso(40), startTime: '17:00', status: 'to-book' }),
    ],
  });
  await withPage('tp-views O3', { db: dbOf([fdTrip]) }, async (s) => {
    const stored = () => evaluate(s, `(() => {
      const db = JSON.parse(localStorage.getItem(${JSON.stringify(LS_KEY)}));
      const t = db.trips.find(x => x.id === db.activeTripId) || db.trips[0];
      return t.items.map(i => ({ id: i.id, type: i.type, meal: i.meal === undefined ? null : i.meal, title: i.title }));
    })()`);
    let items = await stored();
    const byTitle = t => items.find(i => i.title === t);
    await t('tp-views O3: a legacy "Dinner: X" is migrated at boot to meal + bare title',
      !!byTitle('Saba') && byTitle('Saba').meal === 'dinner' && byTitle('Saba').type === 'activity',
      JSON.stringify(items), s);
    await t('tp-views O3: a legacy "Drinks: X" migrates the same way',
      !!byTitle('Hot Tin') && byTitle('Hot Tin').meal === 'drinks', JSON.stringify(items), s);
    await t('tp-views O3: a title that merely MENTIONS a meal is never rewritten',
      !!byTitle('Sunset dinner cruise') && byTitle('Sunset dinner cruise').meal === null, JSON.stringify(items), s);

    await switchView(s, 'days');
    const rows = () => evaluate(s, `[...document.querySelectorAll('#daysList .dc-event')].map(r => ({
      title: ((r.querySelector('.dc-title') || {}).childNodes[0] || {}).textContent || '',
      icon: (r.querySelector('.dc-ico') || {}).textContent || '',
      label: (r.querySelector('.dc-ico') || {}).getAttribute('aria-label'),
      meal: /tp-t-meal/.test(r.className),
    }))`);
    const drawn = await rows();
    const saba = drawn.find(r => r.title.startsWith('Saba'));
    await t('tp-views O3: the card shows the venue name with NO category word',
      !!saba && saba.title.trim() === 'Saba', JSON.stringify(drawn), s);
    await t('tp-views O3: the category rides on the icon + accent instead',
      !!saba && saba.icon === '🍽️' && saba.meal === true, JSON.stringify(saba), s);
    // icon-only categories must still SAY what they mean to a screen reader
    await t('tp-views O3: the icon carries the category as its accessible name',
      !!saba && saba.label === 'Dinner'
        && (drawn.find(r => r.title.startsWith('Hot Tin')) || {}).label === 'Drinks',
      JSON.stringify(drawn.map(r => [r.title, r.label])), s);
    await t('tp-views O3: no row anywhere repeats a category prefix',
      drawn.every(r => !/^\s*(Breakfast|Brunch|Lunch|Dinner|Drinks|Cafe|Snack)\s*:/i.test(r.title)),
      JSON.stringify(drawn.map(r => r.title)), s);

    // Editing a legacy item: the form speaks the new vocabulary and the title
    // field holds only the venue - the traveller never deletes a prefix.
    await clickSel(s, `#daysList [data-act="edit"][data-id="${byTitle('Saba').id}"]`, { settle: 500 });
    const form = () => evaluate(s, `({
      type: (document.querySelector('#typePicker button.on') || {}).dataset.type,
      meal: document.getElementById('inMeal').value,
      mealShown: document.getElementById('fMeal').style.display !== 'none',
      title: document.getElementById('inTitle').value,
      hint: document.getElementById('mealHint').hidden ? '' : document.getElementById('mealHint').textContent,
    })`);
    let f = await form();
    await t('tp-views O3: editing a legacy dinner opens Food & Drink / Dinner / "Saba"',
      f.type === 'food' && f.meal === 'dinner' && f.mealShown && f.title === 'Saba', JSON.stringify(f), s);
    await t('tp-views O3: the helper text no longer teaches a title prefix',
      !/Breakfast:|Lunch:|Dinner:|Drinks:/.test(f.hint), f.hint, s);
    // saving it back keeps the structure rather than re-prefixing the title
    await clickSel(s, '#itemSaveBtn', { settle: 600 });
    items = await stored();
    await t('tp-views O3: saving an edited legacy item keeps meal + bare title',
      !!byTitle('Saba') && byTitle('Saba').meal === 'dinner', JSON.stringify(items), s);

    // An ordinary activity is untouched by any of it.
    await clickSel(s, `#daysList [data-act="edit"][data-id="${byTitle('The National WWII Museum').id}"]`, { settle: 500 });
    f = await form();
    await t('tp-views O3: an attraction still opens as Activity with no subtype control',
      f.type === 'activity' && !f.mealShown, JSON.stringify(f), s);
    await escape(s);

    // Adding through the form: choose the type, choose the category, type the
    // venue name. No syntax anywhere.
    await clickSel(s, '#addBtn', { settle: 450 });
    await clickSel(s, '#typePicker [data-type="food"]', { settle: 300 });
    await setValue(s, '#inMeal', 'brunch');
    await setValue(s, '#inTitle', 'Elizabeths');
    await setValue(s, '#inStart', iso(40));
    await setValue(s, '#inTime', '11:00');
    await clickSel(s, '#itemSaveBtn', { settle: 600 });
    items = await stored();
    await t('tp-views O3: adding Food & Drink stores type activity + the chosen kind',
      !!byTitle('Elizabeths') && byTitle('Elizabeths').meal === 'brunch'
        && byTitle('Elizabeths').type === 'activity',
      JSON.stringify(byTitle('Elizabeths')), s);

    // The two filters over one storage type.
    const filterTo = async (v) => {
      // the toolbar selects listen for `input`, not `change`
      await evaluate(s, `(() => { const el = document.getElementById('filterType');
        el.value = ${JSON.stringify(v)}; el.dispatchEvent(new Event('input', { bubbles: true })); return 1 })()`);
      await sleep(500);
      return evaluate(s, `[...document.querySelectorAll('#daysList .dc-title')].map(e => e.textContent)`);
    };
    const food = await filterTo('food');
    await t('tp-views O3: the Food & drink filter shows meals only',
      food.some(x => x.includes('Saba')) && food.some(x => x.includes('Elizabeths'))
        && !food.some(x => x.includes('WWII')) && !food.some(x => x.includes('Sunset dinner cruise')),
      JSON.stringify(food), s);
    const acts = await filterTo('activity');
    await t('tp-views O3: the Activities filter excludes every meal',
      acts.some(x => x.includes('WWII')) && acts.some(x => x.includes('Sunset dinner cruise'))
        && !acts.some(x => x.includes('Saba') || x.includes('Hot Tin')),
      JSON.stringify(acts), s);
  });

  /* ------------------ O2. day-card header overflow menu ------------------- */
  // The occasional day actions (copy as text / copy to another date / delete
  // the day's items) live behind one "..." toggle since the 2026-08-21 polish
  // round. State is DOM-held: open class on the wrap, hidden on the menu,
  // aria-expanded on the toggle, and has-open-menu on the card (which lifts
  // the card's overflow clip + stacking order while the popover is up).
  freshIds();
  const o2Trip = trip({
    name: 'Menu day',
    items: [item({ title: 'Louvre', location: 'Paris', startDate: iso(40), startTime: '10:00' })],
  });
  await withPage('tp-views O2', { db: dbOf([o2Trip]) }, async (s) => {
    await switchView(s, 'days');
    const state = () => evaluate(s, `(()=>{const w=document.querySelector('.day-card .dc-menu-wrap');
      if(!w) return null;
      const m=w.querySelector('.dc-menu'), b=w.querySelector('[data-act="day-menu"]');
      return { open: w.classList.contains('open'), hidden: m.hidden,
        expanded: b.getAttribute('aria-expanded'),
        lifted: w.closest('.day-card').classList.contains('has-open-menu'),
        acts: [...m.querySelectorAll('[data-act]')].map(x=>x.dataset.act),
        focusOnToggle: document.activeElement === b };
    })()`);
    let st = await state();
    await t('tp-views O2: menu exists and starts closed',
      !!st && st.open === false && st.hidden === true && st.expanded === 'false', JSON.stringify(st), s);
    await clickSel(s, '.day-card [data-act="day-menu"]', { settle: 300 });
    st = await state();
    await t('tp-views O2: toggle opens it and lifts the card',
      !!st && st.open === true && st.hidden === false && st.expanded === 'true' && st.lifted === true, JSON.stringify(st), s);
    await t('tp-views O2: it holds exactly the three day operations',
      !!st && JSON.stringify(st.acts) === JSON.stringify(['share-day', 'duplicate-day', 'clear-day']), JSON.stringify(st && st.acts), s);
    await escape(s);
    st = await state();
    await t('tp-views O2: Escape closes it and hands focus back to the toggle',
      !!st && st.open === false && st.hidden === true && st.focusOnToggle === true, JSON.stringify(st), s);
    await clickSel(s, '.day-card [data-act="day-menu"]', { settle: 300 });
    // any click outside the wrap closes it (the day badge is outside the wrap)
    await clickSel(s, '.day-card .dc-daynum', { settle: 300 });
    st = await state();
    await t('tp-views O2: an outside click closes it',
      !!st && st.open === false && st.hidden === true && st.lifted === false, JSON.stringify(st), s);
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
      // "boots" is a claim about the RENDER, not about openApp returning: the
      // summary chip counting all seeded (non-cancelled) items proves the app
      // computed and painted the whole trip. The old check asserted literal
      // `true` and could never fail.
      const booted = await waitForExpr(s, `(()=>{const c=[...document.querySelectorAll('#summary .chip')]
        .find(x=>{const k=x.querySelector('.k'); return k && k.textContent.trim()==='Items'});
        return !!c && c.querySelector('.v').textContent.trim() === '${bigItems.length} items'})()`, { timeout: 10000 });
      const bootMs = Date.now() - t0;
      await t(`tp-views R: ${bigItems.length}-item trip boots and computes its summary`, booted, `~${bootMs}ms including navigation`, s);
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
      await waitForExpr(s, `document.querySelectorAll('#board .tp-row').length > 2`, { timeout: 8000 });
      const tDays = Date.now();
      await switchView(s, 'days', 2000);
      const cards = await evaluate(s, `document.querySelectorAll('.day-card').length`);
      // EXACTLY one card per day of the seeded span: earliest start iso(10) to
      // the last stay's checkout iso(57 + 10 + 3) = iso(70), inclusive.
      const expectedCards = 61;
      await t('tp-views R: Days view renders the whole span', cards === expectedCards, `cards=${cards} want=${expectedCards} in ~${Date.now() - tDays}ms`, s);
      await t('tp-views R: no page errors at scale', tpErrors(s).length === 0, tpErrors(s).slice(0, 2).join(' | '), s);
    } catch (e) {
      await t('tp-views R: block ran', false, String(e && e.message).slice(0, 140), s);
    } finally {
      if (s) try { await closePage(cdpPort, s); } catch { /* gone */ }
    }
  }

  /* -------------- T. degraded exchange rates (Frankfurter down) ----------- */
  // README promise: "failed rate fetches show a note + Retry instead of fake
  // 1:1 rates". api.frankfurter.dev is refused by the default net rule, which
  // is exactly the outage being pinned.
  freshIds();
  const tTrip = trip({
    name: 'Rates trip',
    currency: 'USD',
    items: [
      item({ title: 'Paid in dollars', startDate: iso(30), startTime: '10:00', status: 'booked', cost: 50, costCurrency: 'USD' }),
      item({ title: 'Paid in euros', startDate: iso(31), startTime: '10:00', status: 'booked', cost: 100, costCurrency: 'EUR' }),
    ],
  });
  await withPage('tp-views T', { db: dbOf([tTrip]) }, async (s) => {
    const failNoteExpr = `(()=>{const n=document.querySelector('.totals-note'); return !!n && n.textContent.includes('Could not fetch exchange rates')})()`;
    // The failed fetch itself re-renders with the failure note: ensureRates()
    // clears ratesFetching BEFORE the .catch's render() (defect 19, fixed
    // 2026-08-15), so no later unrelated render is needed to see it.
    const noteUnprompted = await waitForExpr(s, failNoteExpr, { timeout: 9000 });
    await t('tp-views T: failed rates show the promised note unprompted', noteUnprompted,
      noteUnprompted ? '' : 'still showing the stale fetching note 9s after the failed fetch', s);
    // ...and after ANY later render the honest note + Retry must be there
    // (this is the state a traveller actually reaches on their next action)
    await setValue(s, '#searchBox', 'x');
    await setValue(s, '#searchBox', '');
    const noteShown = await waitForExpr(s, failNoteExpr, { timeout: 8000 });
    await t('tp-views T: failed rates show the promised note', noteShown,
      await evaluate(s, `(document.querySelector('.totals-note')||{}).textContent || '(no note)'`), s);
    await t('tp-views T: the note carries a Retry button',
      await evaluate(s, `!!document.getElementById('ratesRetryBtn')`), '', s);
    const totals = await evaluate(s, `({
      confirmed: (document.querySelector('.t.confirmed .v') || {}).textContent || '',
      incomplete: !!document.querySelector('.t.confirmed.incomplete'),
      body: document.body.innerText.includes('not converted'),
    })`);
    // $50 convertible + EUR 100 unconvertible: the total must be the honest
    // $50 flagged incomplete, never a silently-relabelled $150
    await t('tp-views T: no fake 1:1 conversion in the confirmed total',
      totals.confirmed.includes('50') && !totals.confirmed.includes('150') && totals.incomplete && totals.body,
      JSON.stringify(totals), s);
  });

  /* ------------------- U. map view degraded smoke ------------------------- */
  // Tiles and Nominatim are both refused by the default net rule, so the map
  // cannot locate anything: #mapStatus must say so truthfully (naming the
  // cities) instead of leaving a blank slab or throwing.
  freshIds();
  const uTrip = trip({
    name: 'Map trip',
    items: [
      item({ type: 'stay', title: 'Lisbon hotel', location: 'Lisbon', startDate: iso(30), endDate: iso(32), status: 'booked' }),
      item({ type: 'stay', title: 'Porto hotel', location: 'Porto', startDate: iso(32), endDate: iso(34), status: 'booked' }),
    ],
  });
  await withPage('tp-views U', { db: dbOf([uTrip]) }, async (s) => {
    await switchView(s, 'map');
    // the geocode queue is serialized at ~1.1s per stop, so allow for both
    const failed = await waitForExpr(s,
      `(()=>{const m=document.getElementById('mapStatus'); return !!m && /Could not find those places/i.test(m.innerText)})()`,
      { timeout: 15000 });
    await t('tp-views U: blocked geocoding reads as a truthful map message', failed, '', s);
    await t('tp-views U: the message names the places it could not locate',
      await evaluate(s, `/Lisbon/.test(document.getElementById('mapStatus').innerText) && /Porto/.test(document.getElementById('mapStatus').innerText)`), '', s);
    await t('tp-views U: the blank map slab is hidden, not empty-looking',
      await evaluate(s, `document.getElementById('mapBox').classList.contains('is-blank')`), '', s);
  });

  /* ---------------- S. the day route chain (Days view) -------------------- */
  // One chain feeds every surface: the per-row chips, each place row's own
  // Directions link, the day totals strip and the Day route map all read the
  // legs dayDistanceChain built for the card. A finalized Shibuya day with a
  // hotel, three walkable stops, one across-town dinner and a return leg
  // exercises the whole set: first-stop origin, stop-to-stop origins,
  // walk/ride mode split, mixed-mode totals and the external route.
  freshIds();
  const S_HOTEL = 'Shibuya Stream Hotel';
  const S_VENUES = {
    [S_HOTEL]: [35.6580, 139.7016],
    'Breakfast Cafe Shibuya': [35.6600, 139.7040],   // ~0.3 km from the hotel: walk
    'Meiji Jingu': [35.6764, 139.6993],              // ~1.9 km: walk
    'Lunch Udon Shibuya': [35.6735, 139.7100],       // ~1.0 km: walk
    'Dinner Odaiba': [35.6300, 139.7770],            // ~7.8 km: ride
  };
  const sStores = (venues) => {
    const venue = {};
    const now = Date.now();
    for (const [q, v] of Object.entries(venues)) venue[TripLogic.placeCacheKey(q)] = { lat: v[0], lon: v[1], at: now };
    return {
      'trip-planner:geo:v3': { tokyo: { lat: 35.6762, lon: 139.6503, country: 'Japan', conf: 'confident' } },
      'trip-planner:venuegeo:v1': venue,
    };
  };
  const sDay = iso(40);
  // `over` lets one block vary a single item (S2 makes Meiji unlocatable)
  const sTrip = (over = {}) => trip({
    name: 'Shibuya day',
    items: [
      // the stay starts the night BEFORE, so sDay carries no mid-day check-in
      // row and the chain reads anchor -> breakfast -> ... -> return
      item({ type: 'stay', title: S_HOTEL, location: 'Tokyo', startDate: iso(39), endDate: iso(42), status: 'booked', mapsQuery: S_HOTEL }),
      item({ type: 'activity', title: 'Breakfast Cafe Shibuya', location: 'Tokyo', startDate: sDay, startTime: '09:00', mapsQuery: 'Breakfast Cafe Shibuya' }),
      item({ type: 'activity', title: 'Meiji Jingu', location: 'Tokyo', startDate: sDay, startTime: '10:30', mapsQuery: 'Meiji Jingu', ...(over.meiji || {}) }),
      item({ type: 'activity', title: 'Lunch Udon Shibuya', location: 'Tokyo', startDate: sDay, startTime: '13:00', mapsQuery: 'Lunch Udon Shibuya' }),
      item({ type: 'activity', title: 'Dinner Odaiba', location: 'Tokyo', startDate: sDay, startTime: '19:00', mapsQuery: 'Dinner Odaiba' }),
      item({ type: 'local', title: 'Return to hotel', location: 'Tokyo', startDate: sDay, startTime: '22:00', mapsQuery: S_HOTEL }),
    ],
  });
  await withPage('tp-views S', { db: dbOf([sTrip()]), stores: sStores(S_VENUES) }, async (s) => {
    await switchView(s, 'days');
    // The rates and weather failures re-render the day list a beat after the
    // switch, so any read spread over several evaluates can straddle a
    // rebuild. Two rules keep this deterministic: wait for the COMPLETE end
    // state (the strip painted and the last leg's Directions carrying its
    // origin), then take every fact in ONE atomic evaluate.
    await waitForExpr(s, `(() => {
      const a = [...document.querySelectorAll('#daysList .tp-dir-link')]
        .find(x => (x.closest('.dc-event') || { dataset: {} }).dataset.distLabel === 'Return to hotel');
      return !!a && a.href.includes('origin=') && !!document.querySelector('#daysList .dc-route');
    })()`, { timeout: 10000 });
    const snap = await evaluate(s, `(() => {
      const dirs = [...document.querySelectorAll('#daysList .dc-event[data-dist-label] .tp-dir-link')]
        .map(a => ({ label: a.closest('.dc-event').dataset.distLabel, href: a.getAttribute('href') }));
      const el = document.querySelector('#daysList .dc-route');
      return { dirs, strip: el ? { tot: el.querySelector('.dc-route-tot').textContent,
        gm: (el.querySelector('.dc-route-gm') || {}).href || '',
        btn: !!el.querySelector('[data-act="day-route"]') } : null };
    })()`);
    const dirs = snap.dirs;
    const dirOf = (label) => (dirs.find(d => d.label === label) || {}).href || '';
    await t('tp-views S: every place stop offers Directions, plus the return leg',
      dirs.length === 6, JSON.stringify(dirs.map(d => d.label)), s);
    // the FIRST stop routes from the day's smart origin (here: the host stay)
    await t('tp-views S: the first stop routes from the day origin',
      dirOf('Breakfast Cafe Shibuya').includes('origin=Shibuya%20Stream%20Hotel')
        && dirOf('Breakfast Cafe Shibuya').includes('travelmode=walking'),
      dirOf('Breakfast Cafe Shibuya'), s);
    // every later stop routes from the stop before it, in the chip's own mode
    await t('tp-views S: each stop routes from the previous stop',
      dirOf('Meiji Jingu').includes('origin=Breakfast%20Cafe%20Shibuya')
        && dirOf('Lunch Udon Shibuya').includes('origin=Meiji%20Jingu'),
      JSON.stringify([dirOf('Meiji Jingu'), dirOf('Lunch Udon Shibuya')]), s);
    await t('tp-views S: a leg past walking range opens in transit, not walking',
      dirOf('Dinner Odaiba').includes('origin=Lunch%20Udon%20Shibuya')
        && dirOf('Dinner Odaiba').includes('travelmode=transit'),
      dirOf('Dinner Odaiba'), s);
    await t('tp-views S: the return leg routes from the final real stop to the hotel',
      dirOf('Return to hotel').includes('origin=Dinner%20Odaiba')
        && dirOf('Return to hotel').includes('destination=Shibuya%20Stream%20Hotel'),
      dirOf('Return to hotel'), s);
    // the totals strip: same legs, split walk vs ride, ONE unit (default mi)
    const strip = snap.strip;
    await t('tp-views S: the day strip sums walking and riding separately, in one unit',
      !!strip && /🚶 [\d.]+ mi/.test(strip.tot) && /🚕 [\d.]+ mi/.test(strip.tot) && !strip.tot.includes('km'),
      JSON.stringify(strip && strip.tot), s);
    // the external route: the whole chain in order, one honest mode (driving,
    // because the day mixes walk and ride and Maps takes one mode per URL)
    const gmDecoded = strip ? decodeURIComponent(strip.gm) : '';
    await t('tp-views S: the external route is ordered and single-mode driving',
      gmDecoded.includes('origin=Shibuya Stream Hotel')
        && gmDecoded.indexOf('Breakfast Cafe Shibuya') < gmDecoded.indexOf('Meiji Jingu')
        && gmDecoded.indexOf('Meiji Jingu') < gmDecoded.indexOf('Lunch Udon Shibuya')
        && gmDecoded.indexOf('Lunch Udon Shibuya') < gmDecoded.indexOf('Dinner Odaiba')
        && gmDecoded.includes('destination=Shibuya Stream Hotel')
        && gmDecoded.includes('travelmode=driving'),
      gmDecoded, s);
    // the internal Day route: numbered pins in schedule order, scoped to the day
    await clickSel(s, '[data-act="day-route"]', { settle: 800 });
    await t('tp-views S: the Day route overlay opens',
      await evaluate(s, `document.getElementById('dayRouteOverlay').classList.contains('open')`), '', s);
    const stopsList = await evaluate(s, `[...document.querySelectorAll('#dayRouteStops .drs-label')].map(e => e.textContent)`);
    await t('tp-views S: the route lists the stops in schedule order',
      JSON.stringify(stopsList) === JSON.stringify([S_HOTEL, 'Breakfast Cafe Shibuya', 'Meiji Jingu', 'Lunch Udon Shibuya', 'Dinner Odaiba', 'Return to hotel']),
      JSON.stringify(stopsList), s);
    const pins = await waitForExpr(s, `document.querySelectorAll('#dayRouteCanvas .stop-pin').length === 6`, { timeout: 8000 });
    await t('tp-views S: the day map draws one numbered pin per stop',
      pins, await evaluate(s, `document.querySelectorAll('#dayRouteCanvas .stop-pin').length`), s);
    await escape(s);
  });

  // S2: an unresolved stop keeps the total honest, and the unit preference
  // flips every distance surface at once and persists.
  freshIds();
  // Meiji loses BOTH rungs (no venue entry, no city): the city centroid is a
  // legitimate located fallback, so a truly unplaced stop has neither.
  const s2Venues = { ...S_VENUES };
  delete s2Venues['Meiji Jingu'];
  await withPage('tp-views S2', { db: dbOf([sTrip({ meiji: { location: '' } })]), stores: sStores(s2Venues) }, async (s) => {
    await switchView(s, 'days');
    await waitForExpr(s, `!!document.querySelector('#daysList .dc-route') && /not located/.test(document.querySelector('#daysList .dc-route-tot').textContent)`, { timeout: 10000 });
    const tot = await evaluate(s, `document.querySelector('#daysList .dc-route-tot').textContent`);
    await t('tp-views S2: an unlocatable stop marks the total as partial',
      /1 not located/.test(tot), JSON.stringify(tot), s);
    // flip the preference through its menu row: every chip and the strip
    // switch to kilometers together, and the choice survives a reload
    await menuAct(s, 'distunit', 800);
    const km = await evaluate(s, `({
      strip: document.querySelector('#daysList .dc-route-tot').textContent,
      chip: (document.querySelector('#daysList .dc-dist') || {}).textContent || '',
      stored: localStorage.getItem('trip-planner:distunit'),
    })`);
    await t('tp-views S2: the kilometers preference reaches strip and chips together',
      /km/.test(km.strip) && !/mi\b/.test(km.strip) && /km/.test(km.chip) && km.stored === 'km',
      JSON.stringify(km), s);
    await gotoHard(s, `${base}${APP}`, { settle: 1200 });
    await switchView(s, 'days');
    await waitForExpr(s, `!!document.querySelector('#daysList .dc-dist')`, { timeout: 10000 });
    const after = await evaluate(s, `(document.querySelector('#daysList .dc-dist') || {}).textContent || ''`);
    await t('tp-views S2: the preference persists across a reload',
      /km/.test(after) && !/mi\b/.test(after), JSON.stringify(after), s);
    // the 12/24-hour preference is untouched by the distance one
    const time12 = await evaluate(s, `/9:00 AM/.test(document.querySelector('#daysList').innerText)`);
    await t('tp-views S2: the clock format preference is independent', time12 === true, '', s);
  });

  return R;
}
