// App regression: exercises each app's real features through driven interaction
// rather than page-load smoke tests.
//
// Several apps need a setup step before their controls are reachable at all.
// Getting these wrong produces convincing false failures, so they are documented
// where they are applied:
//   arena - every Firebase backend is intercepted and failed for this suite.
//     Without that, "Play solo" signs in anonymously and WRITES REAL DOCS to
//     the production project. Tests must never touch production, so the block
//     asserts the app's blocked-network behavior instead (toast + sign-in
//     modal), which is also what a real outage shows users.
//   football-h2h / mario-kart - Add Game, Add Race, undo/redo and export all
//     live inside a sidebar that is COLLAPSED by default on desktop.
//   gym-tracker - a first-run #onboarding-modal (z-index 2000) covers the nav
//     until dismissed. Dismiss it the way a user does, do not delete the node.
//   maptap-rivals - the paste panel's inputs are static markup, so wait for
//     init-RENDERED content (.paste-rival-row) before dispatching into them,
//     otherwise events land in a page with no listeners (see the app's
//     FINDINGS.md).
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
  setValue, sleep, textPresent, cleanErrors, waitForExpr, interceptNetwork,
  pressKey,
} from '../cdp.mjs';

// Hosts that reach the production Firebase project. Failed via interception
// wherever an app could otherwise sign in / write for real. The SDK itself
// loads from gstatic.com, which stays reachable so the app boots normally.
const FIREBASE_HOSTS = /firestore\.googleapis\.com|firebaseio\.com|identitytoolkit\.googleapis\.com|securetoken\.googleapis\.com/i;

export async function run({ base, cdpPort }) {
  const R = [];
  const t = (name, pass, detail = '') => R.push({ name, pass: !!pass, detail });
  // Skipped checks are not failures. Used when a precondition the repo cannot
  // provide is missing, so a clean clone does not report phantom bugs, and for
  // KNOWN DEFECT markers where the truthful assertion would fail on the
  // product itself.
  const skip = (name, reason) => R.push({ name, pass: true, skipped: true, detail: reason });

  const CLEAR_STORAGE = `(()=>{ try{ for(const k of Object.keys(localStorage)) localStorage.removeItem(k);
    localStorage.clear(); sessionStorage.clear(); }catch(e){} return 1 })()`;

  // Fresh page with storage genuinely emptied. The double navigation matters:
  // storage can only be cleared from a page on the target origin. `ready` is
  // the app's own readiness signal, polled instead of a long fixed sleep.
  async function fresh(path, { settle = 1200, ready = null, timeout = 15000 } = {}) {
    const s = await newPage(cdpPort);
    await setViewport(s, 1280, 900);
    await goto(s, base + path, { settle: 1000 });
    await evaluate(s, CLEAR_STORAGE);
    await goto(s, base + path, { settle });
    if (ready) await waitForExpr(s, ready, { timeout });
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
  // With auth blocked, EVERY join/solo attempt funnels through the guest-auth
  // gate first (joinRoom() and createRoom() call ensureGuestAuth() before any
  // validation), so the deterministic user-visible outcome is the "Guest mode
  // is unavailable" toast plus the sign-in modal - not #join-error. The
  // length-rejection message is additionally unreachable from typed input
  // because the input listener truncates to 5 characters as you type.
  const ARENA_FEEDBACK = `(()=>{
    const toast=[...document.querySelectorAll('#ba-toast-stack .ba-toast')]
      .some(x=>/guest mode is unavailable|sign in/i.test(x.textContent));
    const m=document.getElementById('auth-modal');
    const modal=!!m && m.classList.contains('auth-modal--visible');
    const err=document.getElementById('join-error');
    const joinErr=!!err && !err.hidden && err.textContent.trim().length>0;
    return toast || modal || joinErr; })()`;
  try {
    const A = 'arena';
    const s = await newPage(cdpPort);
    await setViewport(s, 1280, 900);
    // Enabled BEFORE first navigation so even boot-time auth traffic is failed.
    await interceptNetwork(s, (url) => (FIREBASE_HOSTS.test(url) ? 'fail' : null));
    await goto(s, base + '/apps/arena/', { settle: 1000 });
    await evaluate(s, CLEAR_STORAGE);
    await goto(s, base + '/apps/arena/', { settle: 800 });
    await waitForExpr(s, "!!window.firebaseAuth && document.readyState === 'complete'");

    t(`${A}: loads`, await textPresent(s, 'arena'));
    t(`${A}: room-create controls present`, (await evaluate(s, "!!document.getElementById('create-globe-drop-round-type')")));
    t(`${A}: join-code input present`, (await evaluate(s, "!!document.getElementById('join-code')")));
    t(`${A}: difficulty select changes`, await evaluate(s, `(()=>{const e=document.getElementById('create-globe-drop-difficulty');
      if(!e||!e.options||e.options.length<2) return false; e.selectedIndex=1;
      e.dispatchEvent(new Event('change',{bubbles:true})); return e.selectedIndex===1})()`));
    t(`${A}: private-room toggle flips`, await evaluate(s, `(()=>{const e=document.getElementById('create-private-toggle');
      if(!e) return false; const b=e.checked; e.click(); return e.checked!==b})()`));

    const clearFeedback = () => evaluate(s, `(()=>{
      const st=document.getElementById('ba-toast-stack'); if(st) st.innerHTML='';
      const m=document.getElementById('auth-modal'); if(m) m.classList.remove('auth-modal--visible');
      return 1 })()`);
    const lobbyUsable = `(()=>{const l=document.getElementById('lobby-panel');
      const j=document.getElementById('join-code');
      return !!l && l.getBoundingClientRect().height>0 && !!j && !j.disabled})()`;

    // Over-length code (the input truncates it to 'ZZZZZ' while typing).
    await setValue(s, '#join-code', 'ZZZZZZ');
    await clickText(s, 'Join room', { settle: 1000 });
    t(`${A}: bad join code surfaces visible feedback`,
      await waitForExpr(s, ARENA_FEEDBACK, { timeout: 6000 }),
      'expected guest-auth toast / sign-in modal / #join-error, saw none');
    t(`${A}: bad join code stays in the lobby`, await evaluate(s, lobbyUsable));

    // Valid-length code for a room that cannot exist; Firestore is blocked, so
    // the check is that the app still tells the user SOMETHING.
    await clearFeedback();
    await setValue(s, '#join-code', 'QQQQQ');
    await clickText(s, 'Join room', { settle: 1000 });
    t(`${A}: join with unreachable backend surfaces visible feedback`,
      await waitForExpr(s, ARENA_FEEDBACK, { timeout: 6000 }),
      'expected guest-auth toast / sign-in modal, saw none');

    // Solo play cannot start without auth; the truthful outcome with Firebase
    // failed is feedback + a still-usable lobby, never a silent hang and never
    // a production write (interception guarantees the latter).
    await clearFeedback();
    await clickText(s, 'Play solo', { settle: 1000 });
    t(`${A}: solo play with unreachable backend surfaces visible feedback`,
      await waitForExpr(s, ARENA_FEEDBACK, { timeout: 6000 }),
      'expected guest-auth toast / sign-in modal, saw none');
    t(`${A}: lobby remains usable after the blocked solo attempt`, await evaluate(s, lobbyUsable));

    t(`${A}: no JS errors`, cleanErrors(s).length === 0, cleanErrors(s).slice(0, 2).join(' | '));
    await closePage(cdpPort, s);
  } catch (e) { t('arena: suite ran', false, String(e.message).slice(0, 140)); }

  /* ------------------- FOOTBALL H2H and MARIO KART ---------------------- */
  // Same sidebar-driven architecture, so the same flow verifies both. Storage
  // keys and table selectors come from each app's source: football-h2h keeps
  // games under 'footballH2HGames' (js/football-h2h.js STORAGE_KEY) rendered
  // into #gamesTableBody; mario-kart keeps races under 'marioKartRaces'
  // (js/gameVersionManager.js prefix + 'Races', mk8d default) rendered into
  // #history-body.
  for (const [A, path, addLabel, exportLabel, storageKey, rowSel, ready] of [
    ['football-h2h', '/apps/football-h2h/', 'Add Game', 'Export data',
      'footballH2HGames', '#gamesTableBody tr', 'Array.isArray(window.games)'],
    // mario row selector counts per-row edit buttons, because the Stats view's
    // empty state renders a placeholder <tr> that a bare tr count would see.
    ['mario-kart', '/apps/mario-kart/', 'Add Race', 'Export Data',
      'marioKartRaces', '#history-body .edit-btn', "typeof window.getStorageKey === 'function'"],
  ]) {
    try {
      const s = await fresh(path, { ready });
      const storedLen = `(()=>{try{const a=JSON.parse(localStorage.getItem(${JSON.stringify(storageKey)})||'[]');
        return Array.isArray(a)?a.length:-1}catch(e){return -1}})()`;
      const rowCount = () => evaluate(s, `document.querySelectorAll(${JSON.stringify(rowSel)}).length`);
      t(`${A}: loads`, (await evaluate(s, 'document.body.innerText.length')) > 100);

      // mario-kart boots into the Help view when storage is empty, and the
      // race-history section is hidden by design on Help/Guide views. Switch
      // to Stats now, BEFORE the sidebar opens over the view toggles.
      if (A === 'mario-kart') await clickText(s, 'Stats', { sel: '.toggle-btn', settle: 900 });

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
        const rowsBefore = await rowCount();
        await evaluate(s, `(()=>{
          const f=document.querySelector('#sidebar-game-form,.sidebar-game-form,#sidebar-race-form,.sidebar-race-form');
          const ns=[...f.querySelectorAll('input[type=number]')].filter(e=>e.getBoundingClientRect().height>0);
          ns.forEach((e,i)=>{e.focus(); e.value=String(i+1);
            e.dispatchEvent(new Event('input',{bubbles:true}));
            e.dispatchEvent(new Event('change',{bubbles:true}));});
          return ns.length})()`);
        await clickText(s, 'Save', { settle: 800 });
        // Correctness, not reachability: the record must land in storage AND
        // render as a table row.
        t(`${A}: saved entry lands in localStorage`,
          await waitForExpr(s, `(${storedLen}) === 1`), `${await evaluate(s, storedLen)} records under ${storageKey}`);
        const rowsAfter = await rowCount();
        t(`${A}: saved entry renders in the table`, rowsAfter === rowsBefore + 1,
          `${rowsBefore} -> ${rowsAfter} rows`);

        await clickText(s, 'Undo', { settle: 500 });
        t(`${A}: undo actually removes the record`,
          await waitForExpr(s, `(${storedLen}) === 0`), `${await evaluate(s, storedLen)} left in storage`);
        await clickText(s, 'Redo', { settle: 500 });
        t(`${A}: redo restores the record`,
          await waitForExpr(s, `(${storedLen}) === 1`), `${await evaluate(s, storedLen)} in storage`);
      }

      await trackDownloads(s);
      await clickText(s, exportLabel, { settle: 1600 });
      t(`${A}: export produces a file`, (await evaluate(s, "window.__dl||''")) !== '');

      // The one record is dated today, so every range must keep showing
      // exactly it - a chip that hid it (or duplicated it) is a filter bug.
      let ranges = 0, consistent = 0;
      for (const label of ['Today', 'Last 7 Days', 'Last 30 Days', 'All Time']) {
        if (await clickText(s, label, { exact: true, settle: 500 })) {
          ranges++;
          if ((await rowCount()) === 1) consistent++;
        }
      }
      t(`${A}: date-range filters keep the today-dated entry`, ranges >= 3 && consistent === ranges,
        `${consistent}/${ranges} ranges showed exactly 1 row`);

      t(`${A}: no JS errors`, cleanErrors(s).length === 0, cleanErrors(s).slice(0, 2).join(' | '));
      await closePage(cdpPort, s);
    } catch (e) { t(`${A}: suite ran`, false, String(e.message).slice(0, 140)); }
  }

  /* ---------------------------- GYM TRACKER ----------------------------- */
  try {
    const A = 'gym-tracker';
    const s = await fresh('/apps/gym-tracker/', { ready: '!!window.gymApp' });

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

    // --- Program editor <-> exercise picker modal flow (regression for the
    // stacked-modal bug: the picker used to paint UNDER the editor and a
    // commit after cancelling the editor silently discarded the exercise).
    // Seed one program, then drive Edit -> Add Exercise -> commit -> Save.
    await evaluate(s, `(()=>{ localStorage.setItem('gymTrackerPrograms', JSON.stringify([{
      id: 424242, name: 'Suite Plan', description: '',
      exercises: [{ exerciseId: 3, exerciseName: 'Barbell Bench Press',
        sets: [{repsMin: 8, repsMax: 10}], restSeconds: 90, restAfterSeconds: 90,
        notes: '', order: 0, groupId: null }],
      restMode: 'custom', uniformRestSeconds: 90, scheduleDays: [],
      createdAt: '2026-08-01T10:00:00.000Z', updatedAt: '2026-08-01T10:00:00.000Z' }]));
      localStorage.setItem('gymTrackerOnboardingSeen', 'true'); return 1 })()`);
    await goto(s, base + '/apps/gym-tracker/', { settle: 900 });
    await waitForExpr(s, '!!window.gymApp');
    await clickText(s, 'Programs', { sel: '.nav-links .nav-link', exact: true, settle: 900 });
    await clickSel(s, '#programs-list [data-action="edit-program"]', { settle: 800 });
    await clickSel(s, '#add-exercise-to-program-btn', { settle: 800 });
    const stackState = await evaluate(s, `(()=>{
      const editor = document.getElementById('program-modal').classList.contains('active');
      const picker = document.getElementById('exercise-picker-modal').classList.contains('active');
      const card = document.querySelector('#exercise-picker-list .exercise-picker-card');
      if (!card) return { editor, picker, onTop: false };
      const r = card.getBoundingClientRect();
      const top = document.elementsFromPoint(r.left + r.width/2, r.top + Math.min(r.height/2, 40))[0];
      return { editor, picker, onTop: !!(top && top.closest('#exercise-picker-modal')) };
    })()`);
    t(`${A}: picker opens over the editor (both active, picker hit-testable)`,
      stackState.editor && stackState.picker && stackState.onTop, JSON.stringify(stackState));

    await evaluate(s, `(()=>{const e=document.getElementById('exercise-search');
      e.value='Hip Thrust Machine'; e.dispatchEvent(new Event('input',{bubbles:true})); return 1})()`);
    await sleep(500);
    await clickSel(s, '#exercise-picker-list .exercise-picker-card', { settle: 500 });
    await clickSel(s, '#exercise-picker-commit', { settle: 900 });
    const afterCommit = await evaluate(s, `(()=>({
      picker: document.getElementById('exercise-picker-modal').classList.contains('active'),
      editor: document.getElementById('program-modal').classList.contains('active'),
      rows: [...document.querySelectorAll('#program-exercises-list .pex-name-main')].map(e=>e.textContent.trim()),
    }))()`);
    t(`${A}: committed exercise lands in the open editor`,
      !afterCommit.picker && afterCommit.editor && afterCommit.rows.includes('Hip Thrust Machine'),
      JSON.stringify(afterCommit));

    await clickSel(s, '#program-modal-normal-actions .btn-save-program', { settle: 900 });
    const savedPlan = await evaluate(s, `(JSON.parse(localStorage.getItem('gymTrackerPrograms'))[0].exercises || []).map(e=>e.exerciseName)`);
    t(`${A}: saved plan persists the picked exercise`,
      Array.isArray(savedPlan) && savedPlan.includes('Hip Thrust Machine'), JSON.stringify(savedPlan));

    // Cancel path: unsaved edits survive opening + cancelling the picker.
    await clickSel(s, '#programs-list [data-action="edit-program"]', { settle: 800 });
    await evaluate(s, `(()=>{const e=document.getElementById('program-name');
      e.value='Suite Plan EDITED'; e.dispatchEvent(new Event('input',{bubbles:true})); return 1})()`);
    await clickSel(s, '#add-exercise-to-program-btn', { settle: 700 });
    await clickSel(s, '#exercise-picker-modal .modal-close', { settle: 700 });
    const afterCancel = await evaluate(s, `(()=>({
      editor: document.getElementById('program-modal').classList.contains('active'),
      picker: document.getElementById('exercise-picker-modal').classList.contains('active'),
      name: document.getElementById('program-name').value,
    }))()`);
    t(`${A}: cancelling the picker returns to the editor with edits intact`,
      afterCancel.editor && !afterCancel.picker && afterCancel.name === 'Suite Plan EDITED',
      JSON.stringify(afterCancel));
    await clickSel(s, '#program-modal-normal-actions .program-modal-cancel', { settle: 700 });

    // Catalog round: renamed + new exercises resolve by their stable ids.
    const catalogState = await evaluate(s, `(()=>{
      const db = window.gymApp.exerciseDatabase;
      return {
        renamed: db.find(e=>e.id===173)?.name,
        oldGone: !db.some(e=>e.name==='Seated Dumbbell Press'),
        ghr: db.find(e=>e.id===350)?.name,
        htm: db.find(e=>e.id===514)?.name,
        dc: db.find(e=>e.id===452)?.name,
      };
    })()`);
    t(`${A}: catalog rename + additions resolve by stable id`,
      catalogState.renamed === 'Dumbbell Shoulder Press' && catalogState.oldGone
        && catalogState.ghr === 'Glute-Ham Raise' && catalogState.htm === 'Hip Thrust Machine'
        && catalogState.dc === 'Decline Crunch', JSON.stringify(catalogState));

    t(`${A}: no JS errors`, cleanErrors(s).length === 0, cleanErrors(s).slice(0, 2).join(' | '));
    await closePage(cdpPort, s);
  } catch (e) { t('gym-tracker: suite ran', false, String(e.message).slice(0, 140)); }

  /* --------------------------- MAPTAP RIVALS ---------------------------- */
  try {
    const A = 'maptap-rivals';
    const s = await fresh('/apps/maptap-rivals/', {
      ready: "!!document.querySelector('#dash-summary .dash-summary-card, .dash-summary-card, #paste-actions')",
    });
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

    // One real day save through the paste flow (js/app.js saveDay). The panel
    // lives inside a <details class="paste-collapse"> that is CLOSED by
    // default; open it first or every element inside reports a rect but is
    // unreachable by real clicks (closed-details content is not hit-testable).
    // Then wait for an init-RENDERED row: the textareas are static markup and
    // polling them says nothing about listeners being attached (FINDINGS.md).
    await clickSel(s, '.paste-collapse-summary', { settle: 500 });
    await waitForExpr(s, "(()=>{const d=document.querySelector('details.paste-collapse'); return !!d && d.open})()");
    await waitForExpr(s, "!!document.querySelector('.paste-rival-row')");
    await setValue(s, '#paste-mine-input', '80 90 70 60 50');
    await setValue(s, '.paste-rival-textarea', '70 80 60 50 40');
    await setValue(s, '#paste-date', '2026-08-01');
    await waitForExpr(s, "(()=>{const b=document.getElementById('paste-save-all'); return !!b && !b.disabled})()");
    await clickSel(s, '#paste-save-all', { settle: 900 });
    const g1 = await evaluate(s, `(()=>{try{const g=JSON.parse(localStorage.getItem('maptapRivalsGames')||'[]');
      return {n:g.length, date:g[0]&&g[0].date, mine:g[0]&&g[0].myScores, theirs:g[0]&&g[0].theirScores};}catch(e){return {n:-1}}})()`);
    t(`${A}: pasted day saves a game with the right date and scores`,
      g1.n === 1 && g1.date === '2026-08-01'
        && JSON.stringify(g1.mine) === '[80,90,70,60,50]'
        && JSON.stringify(g1.theirs) === '[70,80,60,50,40]',
      JSON.stringify(g1));
    t(`${A}: save summary confirms 1W`, await evaluate(s,
      `(()=>{const el=document.getElementById('paste-summary');
        return !!el && /Saved 1 game/.test(el.textContent) && /1W/.test(el.textContent)})()`),
      String(await evaluate(s, "(document.getElementById('paste-summary')||{}).textContent")));
    t(`${A}: dashboard reflects the win`, await waitForExpr(s,
      `(()=>{const grid=document.getElementById('rival-grid')||document.body;
        return /100% win|1W/.test(grid.textContent)})()`));

    // Same day pasted again with corrected scores: saveDay() funnels every
    // pasted day through upsertPastedGame (per-rival/per-date guard, fixed
    // 2026-08-15), so the repeat paste must UPDATE the stored record in
    // place - one record for the date, carrying the new scores.
    await setValue(s, '#paste-mine-input', '75 85 65 55 45');
    await setValue(s, '.paste-rival-textarea', '70 80 60 50 40');
    await setValue(s, '#paste-date', '2026-08-01');
    await waitForExpr(s, "(()=>{const b=document.getElementById('paste-save-all'); return !!b && !b.disabled})()");
    await clickSel(s, '#paste-save-all', { settle: 900 });
    const dup = await evaluate(s, `(()=>{try{const g=JSON.parse(localStorage.getItem('maptapRivalsGames')||'[]')
      .filter(x=>x.date==='2026-08-01');
      return {n:g.length, mine:g[0]&&g[0].myScores};}catch(e){return {n:-1}}})()`);
    t(`${A}: repeat paste for the same day is guarded`,
      dup.n === 1 && JSON.stringify(dup.mine) === '[75,85,65,55,45]',
      JSON.stringify(dup));

    await trackDownloads(s);
    await clickText(s, 'Export', { exact: true, settle: 1400 });
    t(`${A}: export produces a file`, (await evaluate(s, "window.__dl||''")) !== '');

    t(`${A}: no JS errors`, cleanErrors(s).length === 0, cleanErrors(s).slice(0, 2).join(' | '));
    await closePage(cdpPort, s);
  } catch (e) { t('maptap-rivals: suite ran', false, String(e.message).slice(0, 140)); }

  /* ---------------------------- RISING SHOWS ---------------------------- */
  try {
    const A = 'rising-shows';
    const ROWS_SEL = '.show-row,.show-card,tbody tr,[data-series-id]';
    // Large dataset, slow boot: wait on the app's own render instead of a
    // fixed 9s sleep. If the dataset is absent the wait times out and the
    // skip path below takes over.
    const s = await fresh('/apps/rising-shows/', {
      ready: `!!document.querySelector(${JSON.stringify(ROWS_SEL)})`, timeout: 20000,
    });
    const rows = () => evaluate(s, `[...document.querySelectorAll(${JSON.stringify(ROWS_SEL)})]
      .filter(e=>e.getBoundingClientRect().height>0).length`);
    const total = () => evaluate(s, `(()=>{const m=document.body.innerText.match(/([\\d,]+)\\s+shows?/i);
      return m?m[1]:null})()`);
    const totalIsExpr = (want) => `(()=>{const m=document.body.innerText.match(/([\\d,]+)\\s+shows?/i);
      return !!m && ${want}})()`;

    t(`${A}: app shell loads`, await textPresent(s, 'rising shows'));

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
      t(`${A}: no JS errors`, cleanErrors(s).length === 0, cleanErrors(s).slice(0, 2).join(' | '));
      await closePage(cdpPort, s);
      throw { handled: true };
    }

    t(`${A}: results render`, baseRows > 0, `${baseRows} rows of ${baseTotal}`);

    // Assert on the total, not the page of 24.
    await setValue(s, '#finderSearch', 'breaking bad');
    t(`${A}: search narrows results`,
      await waitForExpr(s, totalIsExpr(`m[1] !== ${JSON.stringify(baseTotal)}`)),
      `${baseTotal} -> ${await total()}`);
    await setValue(s, '#finderSearch', '');
    await waitForExpr(s, totalIsExpr(`m[1] === ${JSON.stringify(baseTotal)}`));

    await clickText(s, 'Rising', { settle: 800 });
    t(`${A}: shape tab filters`, await waitForExpr(s, `[...document.querySelectorAll(${JSON.stringify(ROWS_SEL)})]
      .filter(e=>e.getBoundingClientRect().height>0).length > 0`));

    await setValue(s, '#finderMinSeasons', '5');
    t(`${A}: min-seasons filter applies`,
      await waitForExpr(s, totalIsExpr(`m[1] !== ${JSON.stringify(baseTotal)}`)), `total now ${await total()}`);
    await setValue(s, '#finderMinSeasons', '');
    await waitForExpr(s, totalIsExpr(`m[1] === ${JSON.stringify(baseTotal)}`));

    const firstBefore = await evaluate(s, `(()=>{const r=document.querySelector(${JSON.stringify(ROWS_SEL)});
      return r?r.innerText.slice(0,50):null})()`);
    await evaluate(s, `(()=>{const e=document.getElementById('finderSort');
      if(e&&e.options.length>1){e.selectedIndex=(e.selectedIndex+1)%e.options.length;
        e.dispatchEvent(new Event('change',{bubbles:true}));} return 1})()`);
    t(`${A}: sort changes result order`, await waitForExpr(s,
      `(()=>{const r=document.querySelector(${JSON.stringify(ROWS_SEL)});
        return !!r && r.innerText.slice(0,50) !== ${JSON.stringify(firstBefore)}})()`));

    const clicked = await clickSel(s, ROWS_SEL, { settle: 800 });
    const modalShown = await waitForExpr(s, `(()=>{const vis=e=>e.getBoundingClientRect().height>0;
      const m=[...document.querySelectorAll('#showModal,#detailModal,.modal')].filter(vis)[0];
      return !!m && m.innerText.length > 40})()`);
    t(`${A}: clicking a show opens its detail`, clicked && modalShown);

    // Narrow phone: the 13-shape strip becomes a horizontal scroll-snap rail,
    // and a keyboard user has to be able to READ the chip they tab onto. The
    // widest chip used to end up cropped by 30 px, because a snap container
    // rejects any scroll position between two snap points. Tab from the first
    // chip through the rest and assert each lands fully inside the rail.
    await evaluate(s, `document.querySelectorAll('.modal-close').forEach(b=>b.click())`);
    await sleep(400);
    await setViewport(s, 390, 844, true);
    await waitForExpr(s, `document.querySelectorAll('#finderShapes .shape-chip').length > 1`);
    await evaluate(s, `document.querySelector('#finderShapes .shape-chip').focus()`);
    const chipCount = await evaluate(s, `document.querySelectorAll('#finderShapes .shape-chip').length`);
    let cropped = 0;
    let landedOnChips = 0;
    for (let i = 0; i < chipCount; i++) {
      await pressKey(s, 'Tab', 'Tab', 9);
      await sleep(200);
      const state = await evaluate(s, `(()=>{const a=document.activeElement;
        if(!a||!a.classList||!a.classList.contains('shape-chip'))return null;
        const st=document.getElementById('finderShapes');
        const ar=a.getBoundingClientRect(),sr=st.getBoundingClientRect();
        return JSON.stringify({w:Math.round(ar.width),
          vis:Math.round(Math.min(ar.right,sr.right)-Math.max(ar.left,sr.left))})})()`);
      if (!state) continue;
      landedOnChips++;
      const { w, vis } = JSON.parse(state);
      if (vis < w - 1) cropped++;
    }
    t(`${A}: every shape chip is fully visible when tabbed to at 390px`,
      landedOnChips > 1 && cropped === 0, `${cropped} of ${landedOnChips} chips cropped`);
    t(`${A}: the shape rail never makes the page scroll sideways`,
      await evaluate(s, `document.documentElement.scrollWidth <= window.innerWidth`));

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
    const ITEMS = `(()=>{try{const j=JSON.parse(localStorage.getItem('trip-planner:v1')||'{}');
      const tr=j.trips||j; const first=Array.isArray(tr)?tr[0]:Object.values(tr||{})[0];
      return ((first&&(first.items||first.entries))||[]).length}catch(e){return -1}})()`;
    const s = await fresh('/apps/trip-planner/', {
      ready: `[...document.querySelectorAll('button,a')].some(x=>/load an example trip/i.test(x.textContent))`,
    });
    const items = () => evaluate(s, ITEMS);
    const disabled = () => evaluate(s, `(()=>({days:document.getElementById('viewDays').disabled,
      map:document.getElementById('viewMap').disabled}))()`);

    const empty = await disabled();
    t(`${A}: Days/Map disabled while empty`, empty.days && empty.map, JSON.stringify(empty));

    await clickText(s, 'Load an example trip', { settle: 800 });
    t(`${A}: sample trip loads items`, await waitForExpr(s, `(${ITEMS}) > 0`), `${await items()} items`);
    const loadedState = await disabled();
    t(`${A}: Days/Map enable once populated`, !loadedState.days && !loadedState.map, JSON.stringify(loadedState));

    let views = 0;
    for (const id of ['viewDays', 'viewMap', 'viewTimeline']) {
      await clickSel(s, `#${id}`, { settle: 600 });
      if (await waitForExpr(s, `/on|active/.test(document.getElementById(${JSON.stringify(id)}).className)`, { timeout: 5000 })) views++;
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
    // round trip rather than just that the button is clickable. Storage is
    // written debounced: wait on it, do not sleep at it.
    const beforeUndo = await items();
    await clickText(s, 'Undo', { settle: 500 });
    t(`${A}: undo reverses a change`, await waitForExpr(s, `(${ITEMS}) < ${beforeUndo}`),
      `${beforeUndo} -> ${await items()}`);
    const afterUndo = await items();
    await clickText(s, 'Redo', { settle: 500 });
    t(`${A}: redo restores it`, await waitForExpr(s, `(${ITEMS}) > ${afterUndo}`),
      `${afterUndo} -> ${await items()}`);

    t(`${A}: currency selector changes`, await evaluate(s, `(()=>{const e=document.getElementById('currencySel');
      if(!e||e.options.length<2) return false; e.selectedIndex=1;
      e.dispatchEvent(new Event('change',{bubbles:true})); return true})()`));

    t(`${A}: no JS errors`, cleanErrors(s).length === 0, cleanErrors(s).slice(0, 2).join(' | '));
    await closePage(cdpPort, s);
  } catch (e) { t('trip-planner: suite ran', false, String(e.message).slice(0, 140)); }

  /* --------------------------- MOBILE SWEEP ----------------------------- */
  // 390x844 with touch emulation on (setViewport handles it). Each app gets
  // one REAL interaction with an asserted outcome on top of the overflow /
  // content / error sweep. Arena's Firebase hosts are blocked here too: a
  // mobile tap on Join must not reach production either.
  const MOBILE = [
    ['arena', '/apps/arena/', async (s) => {
      await setValue(s, '#join-code', 'QQQQQ');
      await clickText(s, 'Join room', { settle: 1000 });
      return ['join attempt surfaces feedback', await waitForExpr(s, ARENA_FEEDBACK, { timeout: 6000 })];
    }],
    ['football-h2h', '/apps/football-h2h/', async (s) => {
      await clickText(s, 'Toggle sidebar', { settle: 800 });
      return ['sidebar opens', await waitForExpr(s,
        "(()=>{const sb=document.querySelector('.sidebar');return !!sb&&/open/.test(sb.className)})()")];
    }],
    ['fpl-planner', '/apps/fpl-planner/', async (s) => {
      const typed = await setValue(s, '#fpl-team-id', '123456');
      return ['team-id input accepts input', typed
        && (await evaluate(s, "(document.getElementById('fpl-team-id')||{}).value")) === '123456'];
    }],
    ['gym-tracker', '/apps/gym-tracker/', async (s) => {
      // Storage may carry onboarding-seen from the desktop block; dismiss the
      // modal only if it is up, then drive the mobile bottom nav.
      await clickText(s, 'Skip tour', { settle: 700 });
      await clickSel(s, '.bottom-nav .nav-item[data-view="history"]', { settle: 800 });
      return ['bottom-nav switches to History', await waitForExpr(s,
        `(()=>{const b=document.querySelector('.bottom-nav .nav-item[data-view="history"]');
          return !!b && /active/.test(b.className)})()`)];
    }],
    ['maptap-rivals', '/apps/maptap-rivals/', async (s) => {
      await clickText(s, 'Add rival', { settle: 800 });
      return ['Add rival opens the modal', await waitForExpr(s,
        "(()=>{const m=document.getElementById('rival-modal');return !!m && m.getBoundingClientRect().height>0})()")];
    }],
    ['mario-kart', '/apps/mario-kart/', async (s) => {
      await clickText(s, 'Toggle sidebar', { settle: 800 });
      return ['sidebar opens', await waitForExpr(s,
        "(()=>{const sb=document.querySelector('.sidebar');return !!sb&&/open/.test(sb.className)})()")];
    }],
    ['rising-shows', '/apps/rising-shows/', async (s) => {
      const clicked = await clickSel(s, '#finderSearch', { settle: 300 });
      return ['search field takes focus', clicked && await evaluate(s,
        "document.activeElement && document.activeElement.id === 'finderSearch'")];
    }],
    ['trip-planner', '/apps/trip-planner/', async (s) => {
      await clickText(s, 'Add item', { settle: 800 });
      return ['Add item opens the form', await waitForExpr(s,
        "(()=>{const m=document.getElementById('itemForm');return !!m && m.getBoundingClientRect().height>0})()")];
    }],
  ];
  for (const [name, path, interact] of MOBILE) {
    try {
      const s = await newPage(cdpPort);
      await setViewport(s, 390, 844, true);
      if (name === 'arena') await interceptNetwork(s, (url) => (FIREBASE_HOSTS.test(url) ? 'fail' : null));
      await goto(s, base + path, { settle: 800 });
      await waitForExpr(s, 'document.body.innerText.trim().length > 100',
        { timeout: name === 'rising-shows' ? 20000 : 12000 });
      const m = await evaluate(s, `(()=>({
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        painted: document.body.innerText.trim().length }))()`);
      t(`${name}: mobile no horizontal overflow`, m.overflow <= 1, `${m.overflow}px`);
      t(`${name}: mobile renders content`, m.painted > 100, `${m.painted} chars`);
      const [what, ok] = await interact(s);
      t(`${name}: mobile interaction - ${what}`, ok);
      t(`${name}: mobile no JS errors`, cleanErrors(s).length === 0, cleanErrors(s).slice(0, 2).join(' | '));
      await closePage(cdpPort, s);
    } catch (e) { t(`${name}: mobile suite ran`, false, String(e.message).slice(0, 140)); }
  }

  return R;
}
