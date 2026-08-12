// App regression: exercises each app's real features through driven interaction
// rather than page-load smoke tests.
//
// Several apps need a setup step before their controls are reachable at all.
// Getting these wrong produces convincing false failures, so they are documented
// where they are applied:
//   football-h2h / mario-kart - Add Game, Add Race, undo/redo and export all
//     live inside a sidebar that is COLLAPSED by default on desktop.
//   gym-tracker - a first-run #onboarding-modal (z-index 2000) covers the nav
//     until dismissed. Dismiss it the way a user does, do not delete the node.
//   trip-planner - the Days and Map views are correctly `disabled` until the
//     trip has items, and undo/redo are correctly disabled until something has
//     happened. Clearing storage needs an explicit per-key removal: the app
//     re-saves debounced state, so a bare localStorage.clear() can be undone by
//     an autosave that fires after it.
//
// Counting rules that matter:
//   rising-shows paginates at 24 rows, so a search that still matches more than
//     one page leaves the visible row count unchanged. Assert on the app's own
//     "N shows" total instead.
//   gym-tracker's exercise list renders through a picker container, so assert on
//     its own "Showing N of M" label rather than counting DOM nodes.
import {
  newPage, closePage, goto, evaluate, clickText, clickSel, setViewport,
  setValue, sleep, textPresent, cleanErrors,
} from '../cdp.mjs';

export async function run({ base, cdpPort }) {
  const R = [];
  const t = (name, pass, detail = '') => R.push({ name, pass: !!pass, detail });
  // Skipped checks are not failures. Used when a precondition the repo cannot
  // provide is missing, so a clean clone does not report phantom bugs.
  const skip = (name, reason) => R.push({ name, pass: true, skipped: true, detail: reason });

  // Fresh page with storage genuinely emptied. The double navigation matters:
  // storage can only be cleared from a page on the target origin.
  async function fresh(path, settle = 4000) {
    const s = await newPage(cdpPort);
    await setViewport(s, 1280, 900);
    await goto(s, base + path, { settle: 1200 });
    await evaluate(s, `(()=>{ try{ for(const k of Object.keys(localStorage)) localStorage.removeItem(k);
      localStorage.clear(); sessionStorage.clear(); }catch(e){} return 1 })()`);
    await goto(s, base + path, { settle });
    return s;
  }

  const trackDownloads = (s) => evaluate(s, `(()=>{ window.__dl=null;
    const oc=HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click=function(){
      if(this.download || /^blob:|^data:/.test(this.href)) window.__dl='anchor';
      return oc.apply(this,arguments); };
    const ou=URL.createObjectURL;
    URL.createObjectURL=function(b){ window.__dl='blob'; return ou.apply(this,arguments); };
    return 1 })()`);

  /* ------------------------------- ARENA -------------------------------- */
  try {
    const A = 'arena';
    const s = await fresh('/apps/arena/');
    t(`${A}: loads`, await textPresent(s, 'arena'));
    t(`${A}: room-create controls present`, (await evaluate(s, "!!document.getElementById('create-globe-drop-round-type')")));
    t(`${A}: join-code input present`, (await evaluate(s, "!!document.getElementById('join-code')")));
    t(`${A}: difficulty select changes`, await evaluate(s, `(()=>{const e=document.getElementById('create-globe-drop-difficulty');
      if(!e||!e.options||e.options.length<2) return false; e.selectedIndex=1;
      e.dispatchEvent(new Event('change',{bubbles:true})); return e.selectedIndex===1})()`));
    t(`${A}: private-room toggle flips`, await evaluate(s, `(()=>{const e=document.getElementById('create-private-toggle');
      if(!e) return false; const b=e.checked; e.click(); return e.checked!==b})()`));

    await setValue(s, '#join-code', 'ZZZZZZ');
    await clickText(s, 'Join room', { settle: 1400 });
    t(`${A}: bad join code does not crash`, await evaluate(s, "location.pathname.includes('arena')"));

    await clickText(s, 'Play solo', { settle: 2600 });
    t(`${A}: solo play responds`, await evaluate(s,
      "/round|score|guess|map|location|loading/i.test(document.body.innerText)"));
    t(`${A}: no JS errors`, cleanErrors(s).length === 0, cleanErrors(s).slice(0, 2).join(' | '));
    await closePage(cdpPort, s);
  } catch (e) { t('arena: suite ran', false, String(e.message).slice(0, 140)); }

  /* ------------------- FOOTBALL H2H and MARIO KART ---------------------- */
  // Same sidebar-driven architecture, so the same flow verifies both.
  for (const [A, path, addLabel, exportLabel] of [
    ['football-h2h', '/apps/football-h2h/', 'Add Game', 'Export data'],
    ['mario-kart', '/apps/mario-kart/', 'Add Race', 'Export Data'],
  ]) {
    try {
      const s = await fresh(path);
      t(`${A}: loads`, (await evaluate(s, 'document.body.innerText.length')) > 100);

      await clickText(s, 'Toggle sidebar', { settle: 1100 });
      t(`${A}: sidebar opens`, await evaluate(s,
        "(()=>{const sb=document.querySelector('.sidebar');return !!sb&&/open/.test(sb.className)})()"));

      await clickText(s, addLabel, { settle: 1400 });
      const form = await evaluate(s, `(()=>{
        const vis=e=>e.getBoundingClientRect().height>0;
        const f=document.querySelector('#sidebar-game-form,.sidebar-game-form,#sidebar-race-form,.sidebar-race-form');
        if(!f) return {none:true};
        const inputs=[...f.querySelectorAll('input,select')].filter(vis);
        return {open:/open/.test(f.className), n:inputs.length,
                numbers:inputs.filter(e=>e.type==='number').length};})()`);
      t(`${A}: "${addLabel}" opens an entry form`, !form.none && form.open && form.n >= 2,
        `open=${form.open} inputs=${form.n}`);

      if (!form.none && form.open) {
        const filled = await evaluate(s, `(()=>{
          const f=document.querySelector('#sidebar-game-form,.sidebar-game-form,#sidebar-race-form,.sidebar-race-form');
          const ns=[...f.querySelectorAll('input[type=number]')].filter(e=>e.getBoundingClientRect().height>0);
          ns.forEach((e,i)=>{e.focus(); e.value=String(i+1);
            e.dispatchEvent(new Event('input',{bubbles:true}));
            e.dispatchEvent(new Event('change',{bubbles:true}));});
          return ns.length})()`);
        await clickText(s, 'Save', { settle: 1600 });
        t(`${A}: an entry can be filled and saved`, filled >= 1, `${filled} numeric fields`);
      }

      t(`${A}: undo responds`, await clickText(s, 'Undo', { settle: 700 }));
      t(`${A}: redo responds`, await clickText(s, 'Redo', { settle: 700 }));

      await trackDownloads(s);
      await clickText(s, exportLabel, { settle: 1600 });
      t(`${A}: export produces a file`, (await evaluate(s, "window.__dl||''")) !== '');

      let ranges = 0;
      for (const label of ['Today', 'Last 7 Days', 'Last 30 Days', 'All Time']) {
        if (await clickText(s, label, { exact: true, settle: 400 })) ranges++;
      }
      t(`${A}: date-range filters clickable`, ranges >= 3, `${ranges}/4`);

      t(`${A}: no JS errors`, cleanErrors(s).length === 0, cleanErrors(s).slice(0, 2).join(' | '));
      await closePage(cdpPort, s);
    } catch (e) { t(`${A}: suite ran`, false, String(e.message).slice(0, 140)); }
  }

  /* ---------------------------- GYM TRACKER ----------------------------- */
  try {
    const A = 'gym-tracker';
    const s = await fresh('/apps/gym-tracker/');

    const dismissed = (await clickText(s, 'Skip tour', { settle: 900 }))
      || (await clickText(s, 'Close welcome', { settle: 900 }));
    t(`${A}: onboarding modal dismisses`, dismissed && await evaluate(s,
      `(()=>{const m=document.getElementById('onboarding-modal');
        return !m || !/active/.test(m.className) || m.getBoundingClientRect().height===0})()`));

    const views = ['Programs', 'History', 'Exercises', 'Calendar', 'Insights', 'Measurements', 'Achievements', 'Settings'];
    let switched = 0;
    for (const v of views) {
      const before = await evaluate(s, 'document.body.innerText.slice(0,3000)');
      await clickText(s, v, { sel: '.nav-links .nav-link', exact: true, settle: 800 });
      const after = await evaluate(s, 'document.body.innerText.slice(0,3000)');
      const active = await evaluate(s, `(()=>{const b=[...document.querySelectorAll('.nav-links .nav-link')]
        .find(x=>x.textContent.trim()===${JSON.stringify(v)}); return b?/active/.test(b.className):false})()`);
      if (before !== after && active) switched++;
    }
    t(`${A}: all nav views switch`, switched === views.length, `${switched}/${views.length}`);

    // Exercise search and category filter, asserted via the app's own count label.
    await clickText(s, 'Exercises', { sel: '.nav-links .nav-link', exact: true, settle: 1800 });
    const readCount = () => evaluate(s, `(()=>{const vis=e=>e.getBoundingClientRect().height>0;
      return [...document.querySelectorAll('*')].filter(e=>vis(e)&&e.children.length===0
        && /available|Showing/i.test(e.textContent||'')).map(e=>e.textContent.trim())[0]||null})()`);
    const baseCount = await readCount();
    await evaluate(s, `(()=>{const e=document.getElementById('exercise-db-search');
      if(!e) return false; e.focus(); e.value='bench';
      e.dispatchEvent(new Event('input',{bubbles:true})); return true})()`);
    await sleep(1500);
    const searchedCount = await readCount();
    t(`${A}: exercise search filters`, !!baseCount && !!searchedCount && baseCount !== searchedCount,
      `${baseCount} -> ${searchedCount}`);

    await evaluate(s, `(()=>{const e=document.getElementById('exercise-db-search');
      if(e){e.value=''; e.dispatchEvent(new Event('input',{bubbles:true}));}
      const c=document.getElementById('exercise-db-category');
      if(c&&c.options.length>1){c.selectedIndex=1; c.dispatchEvent(new Event('change',{bubbles:true}));}
      return 1})()`);
    await sleep(1400);
    const catCount = await readCount();
    t(`${A}: exercise category filter applies`, !!catCount && catCount !== baseCount, `${baseCount} -> ${catCount}`);

    t(`${A}: no JS errors`, cleanErrors(s).length === 0, cleanErrors(s).slice(0, 2).join(' | '));
    await closePage(cdpPort, s);
  } catch (e) { t('gym-tracker: suite ran', false, String(e.message).slice(0, 140)); }

  /* --------------------------- MAPTAP RIVALS ---------------------------- */
  try {
    const A = 'maptap-rivals';
    const s = await fresh('/apps/maptap-rivals/');
    t(`${A}: loads`, await textPresent(s, 'maptap'));
    t(`${A}: username field accepts input`,
      (await setValue(s, '#my-name', 'Tester')) || (await setValue(s, '#profile-username-input', 'Tester')));

    await clickText(s, 'Add rival', { settle: 1000 });
    const modalOpen = await evaluate(s, `(()=>{const m=document.getElementById('rival-modal');
      return !!m && m.getBoundingClientRect().height>0})()`);
    t(`${A}: Add rival opens the modal`, modalOpen);
    if (modalOpen) {
      await evaluate(s, `(()=>{const i=[...document.querySelectorAll('#rival-modal input[type=text],#rival-modal input:not([type])')]
        .filter(e=>e.getBoundingClientRect().height>0)[0];
        if(i){i.focus(); i.value='Rival One'; i.dispatchEvent(new Event('input',{bubbles:true}));}
        return !!i})()`);
      await clickText(s, 'Save', { settle: 1300 });
      t(`${A}: rival persists to storage`, await evaluate(s,
        `(()=>{for(const k of Object.keys(localStorage)){
          if(/maptap|rival/i.test(k) && /Rival One/.test(String(localStorage.getItem(k)||''))) return true}
          return false})()`));
    }

    t(`${A}: score paste box accepts input`, await setValue(s, '#paste-mine-input', '1. Paris 2. Tokyo 3. Lima'));

    await trackDownloads(s);
    await clickText(s, 'Export', { exact: true, settle: 1400 });
    t(`${A}: export produces a file`, (await evaluate(s, "window.__dl||''")) !== '');

    t(`${A}: no JS errors`, cleanErrors(s).length === 0, cleanErrors(s).slice(0, 2).join(' | '));
    await closePage(cdpPort, s);
  } catch (e) { t('maptap-rivals: suite ran', false, String(e.message).slice(0, 140)); }

  /* ---------------------------- RISING SHOWS ---------------------------- */
  try {
    const A = 'rising-shows';
    const s = await fresh('/apps/rising-shows/', 9000); // large dataset, slower boot
    const rows = () => evaluate(s, `[...document.querySelectorAll('.show-row,.show-card,tbody tr,[data-series-id]')]
      .filter(e=>e.getBoundingClientRect().height>0).length`);
    const total = () => evaluate(s, `(()=>{const m=document.body.innerText.match(/([\\d,]+)\\s+shows?/i);
      return m?m[1]:null})()`);

    const baseRows = await rows();
    const baseTotal = await total();

    // The show dataset is gitignored and pulled from a GitHub release, so a
    // clean clone has no data and every finder assertion below would fail for a
    // reason that is not a bug. Skip them with an actionable message instead.
    if (baseRows === 0) {
      const reason = 'no show data - run `npm run fetch:rising-shows-data`';
      for (const check of ['results render', 'search narrows results', 'shape tab filters',
        'min-seasons filter applies', 'sort changes result order', 'clicking a show opens its detail']) {
        skip(`${A}: ${check}`, reason);
      }
      t(`${A}: app shell loads without data`, await textPresent(s, 'rising shows'));
      t(`${A}: no JS errors`, cleanErrors(s).length === 0, cleanErrors(s).slice(0, 2).join(' | '));
      await closePage(cdpPort, s);
      throw { handled: true };
    }

    t(`${A}: results render`, baseRows > 0, `${baseRows} rows of ${baseTotal}`);

    // Assert on the total, not the page of 24.
    await setValue(s, '#finderSearch', 'breaking bad');
    await sleep(2600);
    const searchTotal = await total();
    t(`${A}: search narrows results`, !!searchTotal && searchTotal !== baseTotal,
      `${baseTotal} -> ${searchTotal}`);
    await setValue(s, '#finderSearch', '');
    await sleep(1800);

    await clickText(s, 'Rising', { settle: 2200 });
    t(`${A}: shape tab filters`, (await rows()) > 0);

    await setValue(s, '#finderMinSeasons', '5');
    await sleep(2000);
    t(`${A}: min-seasons filter applies`, (await total()) !== baseTotal, `total now ${await total()}`);
    await setValue(s, '#finderMinSeasons', '');
    await sleep(1500);

    const firstBefore = await evaluate(s, `(()=>{const r=document.querySelector('.show-row,.show-card,tbody tr,[data-series-id]');
      return r?r.innerText.slice(0,50):null})()`);
    await evaluate(s, `(()=>{const e=document.getElementById('finderSort');
      if(e&&e.options.length>1){e.selectedIndex=(e.selectedIndex+1)%e.options.length;
        e.dispatchEvent(new Event('change',{bubbles:true}));} return 1})()`);
    await sleep(2200);
    const firstAfter = await evaluate(s, `(()=>{const r=document.querySelector('.show-row,.show-card,tbody tr,[data-series-id]');
      return r?r.innerText.slice(0,50):null})()`);
    t(`${A}: sort changes result order`, firstBefore !== firstAfter);

    const clicked = await clickSel(s, '.show-row,.show-card,tbody tr,[data-series-id]', { settle: 3000 });
    const modal = await evaluate(s, `(()=>{const vis=e=>e.getBoundingClientRect().height>0;
      const m=[...document.querySelectorAll('#showModal,#detailModal,.modal')].filter(vis)[0];
      return m?{id:m.id,len:m.innerText.length}:null})()`);
    t(`${A}: clicking a show opens its detail`, clicked && !!modal && modal.len > 40,
      modal ? `${modal.id} len=${modal.len}` : 'no modal');

    t(`${A}: no JS errors`, cleanErrors(s).length === 0, cleanErrors(s).slice(0, 2).join(' | '));
    await closePage(cdpPort, s);
  } catch (e) {
    // `handled` means the block already recorded its own results and bailed
    // out early (missing dataset), so there is nothing to report as a failure.
    if (!(e && e.handled)) t('rising-shows: suite ran', false, String(e && e.message).slice(0, 140));
  }

  /* ---------------------------- TRIP PLANNER ---------------------------- */
  try {
    const A = 'trip-planner';
    const s = await fresh('/apps/trip-planner/');

    const disabled = () => evaluate(s, `(()=>({days:document.getElementById('viewDays').disabled,
      map:document.getElementById('viewMap').disabled}))()`);
    const items = () => evaluate(s, `(()=>{try{const j=JSON.parse(localStorage.getItem('trip-planner:v1')||'{}');
      const tr=j.trips||j; const first=Array.isArray(tr)?tr[0]:Object.values(tr||{})[0];
      return ((first&&(first.items||first.entries))||[]).length}catch(e){return -1}})()`);

    const empty = await disabled();
    t(`${A}: Days/Map disabled while empty`, empty.days && empty.map, JSON.stringify(empty));

    await clickText(s, 'Load an example trip', { settle: 3500 });
    const loadedItems = await items();
    const loadedState = await disabled();
    t(`${A}: sample trip loads items`, loadedItems > 0, `${loadedItems} items`);
    t(`${A}: Days/Map enable once populated`, !loadedState.days && !loadedState.map, JSON.stringify(loadedState));

    let views = 0;
    for (const id of ['viewDays', 'viewMap', 'viewTimeline']) {
      await clickSel(s, `#${id}`, { settle: 2200 });
      if (await evaluate(s, `/on|active/.test(document.getElementById(${JSON.stringify(id)}).className)`)) views++;
    }
    t(`${A}: all three views switch`, views === 3, `${views}/3`);

    const beforeSearch = await evaluate(s, 'document.body.innerText.length');
    await setValue(s, '#searchBox', 'zzzzzznomatch');
    await sleep(1600);
    t(`${A}: search filters the itinerary`,
      (await evaluate(s, 'document.body.innerText.length')) !== beforeSearch);
    await setValue(s, '#searchBox', '');
    await sleep(1200);

    await clickText(s, 'Add item', { settle: 1600 });
    const addOpen = await evaluate(s, `(()=>{const m=document.getElementById('itemForm');
      return !!m && m.getBoundingClientRect().height>0})()`);
    t(`${A}: Add item opens the form`, addOpen);
    if (addOpen) {
      await evaluate(s, `(()=>{const b=[...document.querySelectorAll('#itemForm button')]
        .find(x=>/cancel|close/i.test(x.textContent)); if(b) b.click(); return 1})()`);
      await sleep(800);
    }

    // Undo is correctly disabled until something has happened, so assert the
    // round trip rather than just that the button is clickable.
    const beforeUndo = await items();
    await clickText(s, 'Undo', { settle: 2000 });
    const afterUndo = await items();
    t(`${A}: undo reverses a change`, afterUndo < beforeUndo, `${beforeUndo} -> ${afterUndo}`);
    await clickText(s, 'Redo', { settle: 2000 });
    t(`${A}: redo restores it`, (await items()) > afterUndo);

    t(`${A}: currency selector changes`, await evaluate(s, `(()=>{const e=document.getElementById('currencySel');
      if(!e||e.options.length<2) return false; e.selectedIndex=1;
      e.dispatchEvent(new Event('change',{bubbles:true})); return true})()`));

    t(`${A}: no JS errors`, cleanErrors(s).length === 0, cleanErrors(s).slice(0, 2).join(' | '));
    await closePage(cdpPort, s);
  } catch (e) { t('trip-planner: suite ran', false, String(e.message).slice(0, 140)); }

  /* --------------------------- MOBILE SWEEP ----------------------------- */
  for (const [name, path] of [
    ['arena', '/apps/arena/'], ['football-h2h', '/apps/football-h2h/'],
    ['fpl-planner', '/apps/fpl-planner/'],
    ['gym-tracker', '/apps/gym-tracker/'], ['maptap-rivals', '/apps/maptap-rivals/'],
    ['mario-kart', '/apps/mario-kart/'], ['rising-shows', '/apps/rising-shows/'],
    ['trip-planner', '/apps/trip-planner/'],
  ]) {
    try {
      const s = await newPage(cdpPort);
      await setViewport(s, 390, 844, true);
      await goto(s, base + path, { settle: name === 'rising-shows' ? 8000 : 4500 });
      const m = await evaluate(s, `(()=>({
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        painted: document.body.innerText.trim().length }))()`);
      t(`${name}: mobile no horizontal overflow`, m.overflow <= 1, `${m.overflow}px`);
      t(`${name}: mobile renders content`, m.painted > 100, `${m.painted} chars`);
      t(`${name}: mobile no JS errors`, cleanErrors(s).length === 0, cleanErrors(s).slice(0, 2).join(' | '));
      await closePage(cdpPort, s);
    } catch (e) { t(`${name}: mobile suite ran`, false, String(e.message).slice(0, 140)); }
  }

  return R;
}
