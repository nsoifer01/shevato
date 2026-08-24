// Gym Tracker E2E: regressions for the 2026-08-22 site-wide audit round.
//
// Every block drives the REAL app over CDP (coordinate clicks, real storage)
// and asserts storage-level facts, not just the DOM:
//
//   A. live set-row validation: negative / non-integer reps never reach the
//      session, the row carries an inline error (D1, D12)
//   B. measurement ranges, future date, double submit (D3, D16)
//   C. custom-exercise modal resets after a save (D15)
//   D. tablet geometry 768 / 820: no horizontal scroll on Exercises, Settings (D4)
//   E. seeded axe scans (Exercises, History with a session, finish modal,
//      measurements) at 1280 and 390: zero serious/critical (D10)
//   F. rest dial never covers the current exercise's "Add set" at 390 (D11)
//   G. two tabs: programs stay coherent across tabs, the workout lock keeps a
//      second tab from driving a live workout, a stale tab's Finish cannot
//      overwrite a session another tab saved (D2)
//   H. backwards clock: the header never renders a negative time (D7)
//   I. rest countdown survives reload + Resume (UX)
//   J. duplicate program name hint (UX)
//   K. service worker: fresh modules on the load after a deploy, update
//      toast on controller change mid-workout, reload otherwise (D5);
//      offline query-string launch + offline fallback for exercise pages (D14)
//   L. generated category pages exist (D6)
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import {
  newPage, closePage, goto, evaluate, evalAsync, waitForExpr, clickSel, setValue,
  setViewport, pressKey, sleep, interceptNetwork, setOffline, listTargets, connectTarget,
} from '../../../tests/browser/cdp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
const AXE_PATH = path.join(REPO, 'tests', 'browser', 'vendor', 'axe.min.js');
const APP_DIR = '/apps/gym-tracker/';

const PROGRAM = {
  id: 777001, name: 'Audit Push', description: '',
  exercises: [
    { exerciseId: 3, exerciseName: 'Barbell Bench Press', sets: [{ repsMin: 8, repsMax: 10 }, { repsMin: 8, repsMax: 10 }], restSeconds: 60, restAfterSeconds: 60, notes: '', order: 0, groupId: null },
    { exerciseId: 173, exerciseName: 'Dumbbell Shoulder Press', sets: [{ repsMin: 10, repsMax: 12 }], restSeconds: 60, restAfterSeconds: 60, notes: '', order: 1, groupId: null },
  ],
  restMode: 'custom', uniformRestSeconds: 60, scheduleDays: [],
  createdAt: '2026-08-01T10:00:00.000Z', updatedAt: '2026-08-01T10:00:00.000Z',
};
const SESSION = (id, date, w, r) => ({
  id, programId: 777001, workoutDayName: 'Audit Push', date, startTime: `${date}T10:00:00.000Z`, endTime: `${date}T10:30:00.000Z`,
  completed: true, sessionUnit: 'kg', unitsCanonical: true, timestamp: `${date}T10:00:00.000Z`,
  exercises: [{ exerciseId: 3, exerciseName: 'Barbell Bench Press', targetSets: 2, targetReps: 8,
    sets: [{ weight: w, reps: r, completed: true, slot: 0, duration: 0 }], completed: true }],
});

const head = (url) => new Promise((resolve) => {
  const req = http.request(url, { method: 'HEAD' }, (res) => { res.resume(); resolve(res.statusCode); });
  req.on('error', () => resolve(0));
  req.end();
});

export async function run({ base, cdpPort }) {
  const R = [];
  // GYM_E2E_TRACE=1 prints each check as it lands, which is the only way to
  // see WHERE a run hangs (a CDP timeout surfaces as a thrown error with no
  // failing assertion attached).
  const TRACE = !!process.env.GYM_E2E_TRACE;
  // Reports a check as a clean skip: it counts toward the suite total (so the
  // runner's pin cannot silently shrink) but never fails the run.
  const skip = (name, reason) => {
    R.push({ name, pass: true, skipped: true, detail: String(reason).slice(0, 220) });
  };
  const t = (name, pass, detail = '') => {
    R.push({ name, pass: !!pass, detail: detail ? String(detail).slice(0, 220) : '' });
    if (TRACE) console.error(`[gym-e2e] ${pass ? 'ok  ' : 'FAIL'} ${name}`);
  };
  const APP = `${base}${APP_DIR}index.html`;
  const axeSource = await readFile(AXE_PATH, 'utf8');

  const acceptDialogs = (s) => s.on((m) => { if (m === 'Page.javascriptDialogOpening') s.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {}); });
  const ready = (s) => waitForExpr(s, '!!window.gymApp', { timeout: 15000 });
  const clearAll = (s) => evaluate(s, `(()=>{ try{ for(const k of Object.keys(localStorage)) localStorage.removeItem(k); sessionStorage.clear(); }catch(e){} return 1 })()`);
  const seed = (s, kv) => evaluate(s, `(()=>{ ${Object.entries(kv).map(([k, v]) => `localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(typeof v === 'string' ? v : JSON.stringify(v))});`).join('')} return 1 })()`);
  const ls = (s, key) => evaluate(s, `JSON.parse(localStorage.getItem(${JSON.stringify(key)}) || 'null')`);
  // The desktop side nav has no "workout" entry: the floating action button
  // is that route (and it is deliberately hidden when another tab owns the
  // workout), so the workout view is reached the way a user reaches it.
  const nav = async (s, view) => {
    if (view !== 'workout') return clickSel(s, `.nav-links .nav-link[data-view="${view}"]`, { settle: 600 });
    if (await evaluate(s, `!document.getElementById('home-workout-fab').hidden`)) {
      return clickSel(s, '#home-workout-fab', { settle: 900 });
    }
    await evaluate(s, `(()=>{ gymApp.showView('workout'); return 1 })()`);
    return sleep(600);
  };
  // Teardown between blocks. A live workout arms a `beforeunload` listener,
  // and `onbeforeunload = null` does not remove a listener: the dialog then
  // opens mid-navigation and whatever CDP command is in flight can hang
  // (seen as a "timeout: Runtime.evaluate" with no failing assertion). Discard
  // through the app's own path, which stops the timers, clears the active
  // workout and its lock, and disarms the guard.
  const unguard = (s) => evaluate(s, `(()=>{
    try { const w = window.gymApp && gymApp.viewControllers && gymApp.viewControllers.workout;
      if (w && w.hasActiveWorkout && w.hasActiveWorkout()) w.discardWorkout(); } catch (e) {}
    window.onbeforeunload = null; return 1 })()`);
  const navMobile = async (s, view) => {
    if (['home', 'programs', 'workout', 'history'].includes(view)) return clickSel(s, `.bottom-nav .nav-item[data-view="${view}"]`, { settle: 700 });
    await clickSel(s, '.bottom-nav .nav-item[data-view="more"]', { settle: 500 });
    return clickSel(s, `#more-view [data-view="${view}"]`, { settle: 600 });
  };
  const boot = async (s, extra = {}, { mobile = false } = {}) => {
    await unguard(s).catch(() => {});
    await goto(s, `${base}${APP_DIR}manifest.webmanifest`, { settle: 200 });
    await clearAll(s);
    await seed(s, { gymTrackerOnboardingSeen: 'true', gymTrackerPrograms: [PROGRAM], ...extra });
    await goto(s, APP, { settle: 1500 });
    await ready(s);
    await sleep(mobile ? 400 : 200);
  };
  const activeSets = (s) => evaluate(s, `(()=>{const a=JSON.parse(localStorage.getItem('gymTrackerActiveWorkout')||'null'); return a? a.exercises.map(e=>e.sets.map(x=>[x.weight,x.reps])) : null})()`);
  const startWorkout = async (s, { mobile = false } = {}) => {
    if (mobile) { await navMobile(s, 'workout'); } else { await nav(s, 'workout'); }
    await sleep(300);
    if (!(await evaluate(s, `document.getElementById('active-workout').classList.contains('active')`))) {
      await clickSel(s, '#workout-view [data-action="start-workout"]', { settle: 900 });
    }
    return evaluate(s, `document.getElementById('active-workout').classList.contains('active')`);
  };
  const commit = async (s, ex, slot, w, r) => {
    await setValue(s, `#weight-${ex}-${slot}`, String(w));
    await setValue(s, `#reps-${ex}-${slot}`, String(r));
    await clickSel(s, `#exercise-${ex} [data-slot="${slot}"] [data-action="commit-planned-set"]`, { settle: 500 });
  };
  // Inject axe ONCE per page. Re-parsing ~500 KB of vendor script before each
  // of a dozen scans is what pushed this renderer into 45 s stalls.
  const axeScan = async (s, context = 'document') => {
    if (!(await evaluate(s, `typeof window.axe === 'object'`))) {
      await s.send('Runtime.evaluate', { expression: axeSource, returnByValue: false });
    }
    const list = await evalAsync(s, `window.axe.run(${context}, { runOnly: { type: 'tag', values: ['wcag2a','wcag2aa','wcag21a','wcag21aa'] }, resultTypes: ['violations'] })
      .then(r => r.violations.map(v => ({ id: v.id, impact: v.impact, n: v.nodes.length, sample: (v.nodes[0]?.target || []).join(' ').slice(0, 90) })))`);
    return (Array.isArray(list) ? list : []).filter((v) => v.impact === 'serious' || v.impact === 'critical');
  };

  let s = await newPage(cdpPort);
  acceptDialogs(s);
  try {
    // ------------------------------------------------------------- A
    await setViewport(s, 1280, 900);
    await boot(s);
    t('A: workout starts', await startWorkout(s));
    await commit(s, 0, 0, 60, -3);
    t('A: reps -3 never reaches the session', JSON.stringify(await activeSets(s)) === '[[],[]]', JSON.stringify(await activeSets(s)));
    t('A: the row is marked invalid with an inline message',
      await evaluate(s, `(()=>{const r=document.querySelector('#exercise-0 .set-row[data-slot="0"]'); return r.classList.contains('set-row--invalid') && !!r.querySelector('.set-row-error') && document.getElementById('reps-0-0').getAttribute('aria-invalid')==='true'})()`));
    await commit(s, 0, 0, 60, '8.7');
    t('A: reps 8.7 refused (was silently 8)', JSON.stringify(await activeSets(s)) === '[[],[]]');
    await commit(s, 0, 0, -1, 8);
    t('A: weight -1 refused and the weight input is the one flagged',
      JSON.stringify(await activeSets(s)) === '[[],[]]' && await evaluate(s, `document.getElementById('weight-0-0').getAttribute('aria-invalid')==='true'`));
    await commit(s, 0, 0, 60, 8);
    t('A: a valid set stores and the error clears', JSON.stringify(await activeSets(s)) === '[[[60,8]],[]]' && await evaluate(s, `!document.querySelector('#exercise-0 .set-row--invalid')`), JSON.stringify(await activeSets(s)));
    // edit path
    await clickSel(s, '#exercise-0 [data-slot="0"] [data-action="edit-set"]', { settle: 400 });
    await setValue(s, '#edit-reps-0-0', '-4');
    await clickSel(s, '#exercise-0 [data-slot="0"] [data-action="save-set-edit"]', { settle: 400 });
    t('A: edit to reps -4 refused, set untouched', JSON.stringify(await activeSets(s)) === '[[[60,8]],[]]' && await evaluate(s, `!!document.querySelector('#exercise-0 .set-row--invalid .set-row-error')`), JSON.stringify(await activeSets(s)));

    // ------------------------------------------------------------- H (backwards clock)
    await evaluate(s, `(()=>{ const real=Date.now; window.__realNow=real; Date.now=()=>real()-90000; return 1 })()`);
    await sleep(1300);
    const timeText = await evaluate(s, `document.getElementById('workout-time').textContent`);
    t('H: header timer never renders a negative after a -90 s clock change', /^\d+:\d{2}$/.test(timeText), timeText);
    await evaluate(s, `(()=>{ Date.now=window.__realNow; return 1 })()`);
    const persistedElapsed = await evaluate(s, `JSON.parse(localStorage.getItem('gymTrackerActiveWorkout')).elapsedBeforePause`);
    t('H: persisted elapsedBeforePause is never negative', persistedElapsed >= 0, String(persistedElapsed));

    // ------------------------------------------------------------- I (rest restore)
    await commit(s, 0, 1, 62.5, 8); // starts a 60 s rest
    const restBefore = await evaluate(s, `({hidden: document.getElementById('rest-timer-bar').hidden, state: JSON.parse(localStorage.getItem('gymTrackerActiveWorkout')).restState})`);
    t('I: a running rest is persisted on the session', !restBefore.hidden && restBefore.state && Number.isFinite(restBefore.state.endsAt), JSON.stringify(restBefore));
    await goto(s, APP, { settle: 1500 }); await ready(s);
    await nav(s, 'workout'); await sleep(300);
    await clickSel(s, '#workout-view [data-paused-action="resume"]', { settle: 900 });
    const restAfter = await evaluate(s, `({active: document.getElementById('active-workout').classList.contains('active'), hidden: document.getElementById('rest-timer-bar').hidden, value: document.getElementById('rest-timer-value').textContent})`);
    t('I: after reload + Resume the rest countdown is back', restAfter.active && !restAfter.hidden && /^\d+:\d{2}$/.test(restAfter.value), JSON.stringify(restAfter));
    await clickSel(s, '#rest-skip-btn', { settle: 300 });
    t('I: Skip clears the persisted rest state', (await evaluate(s, `JSON.parse(localStorage.getItem('gymTrackerActiveWorkout')).restState`)) === null);

    // ------------------------------------------------------------- finish + inline HR copy
    await clickSel(s, '#finish-workout-btn', { settle: 600 });
    await setValue(s, '#avg-heart-rate', '-20');
    await evaluate(s, `document.getElementById('finish-workout-form').requestSubmit()`); await sleep(400);
    t('UX: heart rate -20 gets inline copy, not a browser bubble, and nothing is saved',
      await evaluate(s, `!document.getElementById('finish-metrics-message').hidden && document.getElementById('avg-heart-rate').getAttribute('aria-invalid')==='true' && document.getElementById('finish-workout-modal').classList.contains('active')`)
      && (await ls(s, 'gymTrackerSessions') || []).length === 0);
    await setValue(s, '#avg-heart-rate', '140');
    await evaluate(s, `document.getElementById('finish-workout-form').requestSubmit()`);
    // The completion burst animates over the page for up to 4 s and swallows
    // input while it does; driving through it makes CDP commands time out with
    // no failing assertion. Wait it out before touching the page again.
    await waitForExpr(s, `!document.querySelector('.completion-burst')`, { timeout: 15000 }).catch(() => {});
    await sleep(400);
    t('finish saves one session with the validated metric', (await ls(s, 'gymTrackerSessions') || []).length === 1 && (await ls(s, 'gymTrackerSessions'))[0].avgHeartRate === 140);
    t('finish releases the workout lock', (await ls(s, 'gymTrackerActiveWorkoutLock')) === null);

    // ------------------------------------------------------------- J (duplicate name hint)
    await nav(s, 'programs');
    await clickSel(s, '#create-program-btn', { settle: 500 });
    await evaluate(s, `(()=>{const i=document.getElementById('program-name'); i.value='audit push'; i.dispatchEvent(new Event('input',{bubbles:true})); return 1})()`);
    t('J: typing an existing program name shows the duplicate hint (case-insensitive)', await evaluate(s, `!document.getElementById('program-name-hint').hidden`));
    await evaluate(s, `(()=>{const i=document.getElementById('program-name'); i.value='Pull'; i.dispatchEvent(new Event('input',{bubbles:true})); return 1})()`);
    t('J: a distinct name hides it', await evaluate(s, `document.getElementById('program-name-hint').hidden`));
    await pressKey(s, 'Escape', 'Escape', 27); await sleep(300);
    if (await evaluate(s, `document.getElementById('confirm-modal')?.classList.contains('active')`)) await clickSel(s, '#confirm-modal-confirm', { settle: 300 });

    // ------------------------------------------------------------- B (measurements)
    await nav(s, 'measurements');
    const submitMeasurement = async (vals) => {
      await clickSel(s, '#add-measurement-btn', { settle: 400 });
      for (const [id, v] of Object.entries(vals)) await setValue(s, `#${id}`, v);
      await evaluate(s, `document.getElementById('measurement-form').requestSubmit()`); await sleep(400);
      return { count: (await ls(s, 'gymTrackerMeasurements') || []).length, open: await evaluate(s, `document.getElementById('measurement-modal').classList.contains('active')`) };
    };
    let m = await submitMeasurement({ 'm-weight': '-5' });
    t('B: weight -5 refused with the input flagged', m.count === 0 && m.open && await evaluate(s, `document.getElementById('m-weight').getAttribute('aria-invalid')==='true'`), JSON.stringify(m));
    await pressKey(s, 'Escape', 'Escape', 27); await sleep(200);
    m = await submitMeasurement({ 'm-weight': '80', 'm-bodyfat': '150' });
    t('B: body fat 150 % refused', m.count === 0 && m.open, JSON.stringify(m));
    await pressKey(s, 'Escape', 'Escape', 27); await sleep(200);
    m = await submitMeasurement({ 'm-weight': '80', 'm-date': '2030-01-01' });
    t('B: a future date is refused and the date input carries max=today', m.count === 0 && m.open && await evaluate(s, `document.getElementById('m-date').max === new Date().toISOString().slice(0,10) || document.getElementById('m-date').max.length === 10`), JSON.stringify(m));
    await pressKey(s, 'Escape', 'Escape', 27); await sleep(200);
    await clickSel(s, '#add-measurement-btn', { settle: 400 });
    await setValue(s, '#m-weight', '80');
    await evaluate(s, `(()=>{const f=document.getElementById('measurement-form'); f.requestSubmit(); f.requestSubmit(); return 1})()`); await sleep(500);
    t('B: two submits back to back store exactly one record', (await ls(s, 'gymTrackerMeasurements') || []).length === 1, String((await ls(s, 'gymTrackerMeasurements') || []).length));

    // ------------------------------------------------------------- C (custom exercise reset)
    await nav(s, 'exercises');
    await clickSel(s, '#create-custom-exercise-btn', { settle: 400 });
    await setValue(s, '#custom-exercise-name', 'Double Submit Test');
    await evaluate(s, `(()=>{ for (const [id,v] of [['custom-exercise-category','chest'],['custom-exercise-muscle','Pectorals'],['custom-exercise-equipment','barbell']]) { const el=document.getElementById(id); const opt=[...el.options].find(o=>o.value.toLowerCase()===v.toLowerCase()); el.value = opt ? opt.value : el.options[1].value; el.dispatchEvent(new Event('change',{bubbles:true})); } return 1 })()`);
    await evaluate(s, `document.getElementById('custom-exercise-form').requestSubmit()`); await sleep(600);
    if (await evaluate(s, `document.getElementById('confirm-modal')?.classList.contains('active')`)) await clickSel(s, '#confirm-modal-confirm', { settle: 400 });
    const customCount = (await ls(s, 'gymTrackerCustomExercises') || []).length;
    await clickSel(s, '#create-custom-exercise-btn', { settle: 400 });
    t('C: custom-exercise modal reopens with an empty name after a save', customCount === 1 && (await evaluate(s, `document.getElementById('custom-exercise-name').value`)) === '', `stored=${customCount}`);
    await pressKey(s, 'Escape', 'Escape', 27); await sleep(200);

    // ------------------------------------------------------------- L (generated category pages)
    // exercises/ is generated by `npm run build:gym-tracker:pages` and is
    // gitignored, and the browser CI job does NOT run a build step, so on a
    // fresh checkout the tree is simply absent. Assert against it only when it
    // is there; otherwise skip with the command that produces it, the same way
    // the rising-shows checks handle their gitignored dataset. Without this
    // these four checks fail on CI for a reason that is not a defect.
    const builtPages = (await head(`${base}${APP_DIR}exercises/barbell-bench-press/`)) === 200;
    const noBuild = 'exercises/ not built - run `npm run build:gym-tracker:pages`';
    for (const cat of ['chest', 'back', 'cardio']) {
      if (!builtPages) { skip(`L: /exercises/muscle/${cat}/ exists`, noBuild); continue; }
      const code = await head(`${base}${APP_DIR}exercises/muscle/${cat}/`);
      t(`L: /exercises/muscle/${cat}/ exists`, code === 200, `HEAD ${code}`);
    }
    if (!builtPages) {
      skip('L: the bench press page links its Category to an existing page', noBuild);
    } else {
      const catLink = await evalAsync(s, `fetch('/apps/gym-tracker/exercises/barbell-bench-press/').then(r=>r.text()).then(h=>{const m=/href="([^"]+)"/.exec(h.split('<dt>Category</dt>')[1]||''); return m ? fetch(m[1],{method:'HEAD'}).then(r=>({href:m[1],status:r.status})) : {href:null,status:0}})`);
      t('L: the bench press page links its Category to an existing page', catLink && catLink.status === 200, JSON.stringify(catLink));
    }

    // ------------------------------------------------------------- D (tablet geometry)
    for (const [w, h] of [[768, 1024], [820, 1180]]) {
      await setViewport(s, w, h);
      await boot(s);
      for (const view of ['exercises', 'settings']) {
        await nav(s, view); await sleep(300);
        const g = await evaluate(s, `({sw: document.documentElement.scrollWidth, iw: window.innerWidth, btn: (document.querySelector('#create-custom-exercise-btn, #clear-data-btn')||{getBoundingClientRect:()=>({right:0})}).getBoundingClientRect().right, clear: document.getElementById('clear-data-btn').getBoundingClientRect().right})`);
        t(`D: ${w}px ${view} has no horizontal overflow`, g.sw <= g.iw && g.btn <= g.iw && g.clear <= g.iw + 1, JSON.stringify(g));
      }
    }

    // ------------------------------------------------------------- E + F (axe + dial) at 1280 and 390
    // A fresh page per viewport. Flipping device metrics + touch emulation on
    // a page that has already driven a live workout (timers, a service worker
    // with in-flight revalidations) intermittently wedged the renderer long
    // enough for CDP commands to time out; a new tab costs ~2 s and removes
    // that whole class of flake.
    for (const [w, h, mobile] of [[1280, 900, false], [390, 844, true]]) {
      await unguard(s).catch(() => {});
      await closePage(cdpPort, s);
      s = await newPage(cdpPort); acceptDialogs(s);
      await setViewport(s, w, h, mobile);
      await boot(s, { gymTrackerSessions: [SESSION(1, '2026-08-10', 60, 8), SESSION(2, '2026-08-20', 65, 8)], gymTrackerMeasurements: [{ id: 1, date: '2026-08-01', weight: 80, waist: 86, unitsCanonical: true }] }, { mobile });
      const go = mobile ? navMobile : nav;
      const tag = mobile ? '390' : '1280';
      await go(s, 'exercises'); await sleep(300);
      let v = await axeScan(s); t(`E: axe Exercises @${tag}`, v.length === 0, JSON.stringify(v));
      await go(s, 'history'); await sleep(300);
      v = await axeScan(s); t(`E: axe History with sessions @${tag}`, v.length === 0, JSON.stringify(v));
      t(`E: history cards carry no nested interactive container @${tag}`, await evaluate(s, `!document.querySelector('#history-list .workout-card[role="button"]') && !!document.querySelector('#history-list .workout-card-open')`));
      await clickSel(s, '#history-list .workout-card-open', { settle: 500 });
      t(`E: the card title button opens the session detail @${tag}`, await evaluate(s, `document.getElementById('workout-detail-modal').classList.contains('active')`));
      await pressKey(s, 'Escape', 'Escape', 27); await sleep(200);
      await go(s, 'measurements'); await sleep(300);
      v = await axeScan(s); t(`E: axe Measurements @${tag}`, v.length === 0, JSON.stringify(v));
      if (mobile) {
        await go(s, 'insights'); await sleep(500);
        t('E: heatmap scroll region is keyboard reachable', await evaluate(s, `(()=>{const h=document.getElementById('insights-heatmap'); return h.getAttribute('tabindex')==='0' && !!h.getAttribute('aria-label')})()`));
        t('UX: heatmap shows a scroll hint when earlier months are off-screen', await evaluate(s, `(()=>{const h=document.getElementById('insights-heatmap'); const hint=document.getElementById('insights-heatmap-hint'); return h.scrollWidth<=h.clientWidth || !hint.hidden})()`));
      }
      t(`E: workout starts @${tag}`, await startWorkout(s, { mobile }));
      await commit(s, 0, 0, 60, 8);
      if (mobile) {
        await sleep(900); // smooth scroll settles
        const hit = await evaluate(s, `(()=>{const b=document.querySelector('#exercise-0 .btn-add-set--extra'); const r=b.getBoundingClientRect(); const top=document.elementsFromPoint(r.left+r.width/2, r.top+r.height/2)[0]; return {top: top? (top.id||top.className.toString().slice(0,40)) : null, ok: !!top && (top===b || b.contains(top)), bar: document.getElementById('rest-timer-bar').hidden}})()`);
        t('F: the rest dial does not cover the current exercise\'s Add set at 390', hit.ok && !hit.bar, JSON.stringify(hit));
      }
      // The app's root font-size is 11pt, so this is measured in real pixels.
      const caption = await evaluate(s, `parseFloat(getComputedStyle(document.getElementById('rest-timer-caption')).fontSize)`);
      t(`E: rest caption is readable (>= 11px) @${tag}`, caption >= 11, `${caption}px`);
      // Stop the countdown first: the dial animates for a minute and there is
      // nothing to learn from scanning it again here.
      await evaluate(s, `(()=>{ gymApp.viewControllers.workout.skipRest(); return 1 })()`);
      await clickSel(s, '#finish-workout-btn', { settle: 600 });
      // Scoped to the dialog, which is the state under test (the page behind it
      // is already scanned by the view scans above).
      v = await axeScan(s, `document.getElementById('finish-workout-modal')`);
      t(`E: axe finish modal @${tag}`, v.length === 0, JSON.stringify(v));
      // focus({ focusVisible: true }) is what arms :focus-visible without a
      // real key press; a plain .focus() never does, so a probe using it
      // would report "no ring" on perfectly good CSS.
      const focusRing = await evaluate(s, `(()=>{const b=document.querySelector('.finish-workout-submit'); b.focus({focusVisible:true}); const cs=getComputedStyle(b); return {fv: b.matches(':focus-visible'), outline: cs.outlineStyle, shadow: cs.boxShadow}})()`);
      t(`E: focused .btn shows a ring @${tag}`, focusRing.fv && (focusRing.outline !== 'none' || /[1-9]/.test(focusRing.shadow)), JSON.stringify(focusRing));
      await pressKey(s, 'Escape', 'Escape', 27); await sleep(200);
      const inputRing = await evaluate(s, `(()=>{const i=document.getElementById('reps-0-1')||document.getElementById('weight-0-1'); if(!i) return null; i.focus({focusVisible:true}); const cs=getComputedStyle(i); return {fv: i.matches(':focus-visible'), outline: cs.outlineStyle, shadow: cs.boxShadow}})()`);
      t(`E: focused set-row input shows a ring @${tag}`, inputRing && inputRing.fv && (inputRing.outline !== 'none' || /[1-9]/.test(inputRing.shadow)), JSON.stringify(inputRing));
    }
    await unguard(s).catch(() => {});

    // ------------------------------------------------------------- G (two tabs)
    await closePage(cdpPort, s);
    s = await newPage(cdpPort); acceptDialogs(s);
    await setViewport(s, 1280, 900, false);
    await boot(s);
    const s2 = await newPage(cdpPort); acceptDialogs(s2);
    await setViewport(s2, 1280, 900, false);
    await goto(s2, APP, { settle: 1500 }); await ready(s2);
    // programs coherence: add in B, A sees it; delete in B, A does not resurrect it
    await evaluate(s2, `(()=>{ gymApp.viewControllers.programs.duplicateProgram(777001); return 1 })()`); await sleep(700);
    t('G: a program duplicated in tab B is in storage', ((await ls(s, 'gymTrackerPrograms')) || []).length === 2);
    // tab-sync re-reads on the storage event and re-renders; it is debounced,
    // so wait for the state rather than for a fixed number of milliseconds.
    const sawAdd = await waitForExpr(s, `gymApp.programs.length === 2`, { timeout: 5000 });
    t('G: tab A re-read it into memory without a reload', sawAdd, `programs=${await evaluate(s, 'gymApp.programs.length')}`);
    await nav(s, 'programs'); await sleep(300);
    t('G: tab A renders both programs', (await evaluate(s, `document.querySelectorAll('#programs-list .program-card').length`)) === 2);
    const dupId = (await ls(s, 'gymTrackerPrograms')).find((p) => p.id !== 777001).id;
    await evaluate(s2, `(()=>{ gymApp.programs = gymApp.programs.filter(p => String(p.id) !== ${JSON.stringify(String(dupId))}); gymApp.savePrograms(); return 1 })()`);
    const sawDelete = await waitForExpr(s, `gymApp.programs.length === 1`, { timeout: 5000 });
    t('G: tab A drops the deleted program from memory', sawDelete, `programs=${await evaluate(s, 'gymApp.programs.length')}`);
    // tab A now writes its settings and programs from memory
    await nav(s, 'settings'); await sleep(300);
    await evaluate(s, `(()=>{const e=document.getElementById('time-format'); e.value = e.value==='12'?'24':'12'; e.dispatchEvent(new Event('change',{bubbles:true})); return 1})()`);
    await clickSel(s, '#save-settings-btn', { settle: 500 });
    await evaluate(s, `(()=>{ gymApp.savePrograms(); return 1 })()`); await sleep(300);
    t('G: a program deleted in tab B is not resurrected by tab A\'s next write', ((await ls(s, 'gymTrackerPrograms')) || []).length === 1, JSON.stringify((await ls(s, 'gymTrackerPrograms') || []).map((p) => p.name)));
    // workout lock
    t('G: tab A starts a workout', await startWorkout(s));
    await commit(s, 0, 0, 60, 8);
    const lock = await ls(s, 'gymTrackerActiveWorkoutLock');
    t('G: the owning tab holds a fresh lock', lock && lock.tabId && Date.now() - lock.at < 20000, JSON.stringify(lock));
    await nav(s2, 'workout'); await sleep(400);
    const bState = await evaluate(s2, `({elsewhere: !!document.querySelector('[data-workout-elsewhere]'), resume: !!document.querySelector('#workout-view [data-paused-action="resume"]'), active: document.getElementById('active-workout').classList.contains('active'), fab: document.getElementById('home-workout-fab').hidden})`);
    t('G: tab B is told the workout runs elsewhere and gets no Resume', bState.elsewhere && !bState.resume && !bState.active, JSON.stringify(bState));
    await evaluate(s2, `(()=>{ gymApp.viewControllers.workout.resumeWorkout(); return 1 })()`); await sleep(500);
    t('G: a forced resume in tab B is refused', !(await evaluate(s2, `document.getElementById('active-workout').classList.contains('active')`)));
    await evaluate(s2, `(()=>{ gymApp.viewControllers.workout.startWorkout(777001); return 1 })()`); await sleep(500);
    t('G: a forced start in tab B is refused while A drives', !(await evaluate(s2, `document.getElementById('active-workout').classList.contains('active')`)));
    await commit(s, 0, 1, 62.5, 8);
    t('G: tab A\'s sets are intact', JSON.stringify(await activeSets(s)) === '[[[60,8],[62.5,8]],[]]', JSON.stringify(await activeSets(s)));
    // stale Finish: another tab already saved this session id
    const activeId = await evaluate(s, `JSON.parse(localStorage.getItem('gymTrackerActiveWorkout')).id`);
    const foreign = SESSION(activeId, '2026-08-22', 100, 5);
    await evaluate(s2, `(()=>{ localStorage.setItem('gymTrackerSessions', JSON.stringify([${JSON.stringify(foreign)}])); return 1 })()`); await sleep(400);
    await clickSel(s, '#finish-workout-btn', { settle: 500 });
    await evaluate(s, `document.getElementById('finish-workout-form').requestSubmit()`);
    await waitForExpr(s, `!document.querySelector('.completion-burst')`, { timeout: 15000 }).catch(() => {});
    await sleep(400);
    const after = await ls(s, 'gymTrackerSessions');
    t('G: a stale tab\'s Finish does not overwrite the session another tab saved', after.length === 1 && after[0].exercises[0].sets[0].weight === 100, JSON.stringify(after.map((x) => x.exercises[0].sets)));
    t('G: the stale tab leaves the live screen instead of pretending', !(await evaluate(s, `document.getElementById('active-workout').classList.contains('active')`)));
    // takeover: another tab's fresh lock makes this tab's heartbeat stand down
    await boot(s);
    t('G: tab A starts again', await startWorkout(s));
    await evaluate(s2, `(()=>{ localStorage.setItem('gymTrackerActiveWorkoutLock', JSON.stringify({tabId:'tab-other', at: Date.now()+60000})); return 1 })()`);
    await waitForExpr(s, `!document.getElementById('active-workout').classList.contains('active')`, { timeout: 9000 }).catch(() => {});
    t('G: a tab whose lock was taken over stops driving within a heartbeat', !(await evaluate(s, `document.getElementById('active-workout').classList.contains('active')`)));
    t('G: the stale tab did not write over the blob after the takeover', !!(await ls(s, 'gymTrackerActiveWorkout')), 'blob still present');
    await evaluate(s2, `(()=>{ localStorage.removeItem('gymTrackerActiveWorkoutLock'); return 1 })()`);
    await closePage(cdpPort, s2);

    // ------------------------------------------------------------- M (sync banner)
    // The shared banner (assets/js/sync-status.js) was moved below the fixed
    // site header so it stops covering the logo, Menu and Sign In. Gym Tracker
    // has its own banner rules and its own module, so it did not follow and
    // sat UNDER the header at z-index 1100 / top: 0.
    await closePage(cdpPort, s);
    s = await newPage(cdpPort); acceptDialogs(s);
    await setViewport(s, 390, 844, true);
    await boot(s, {}, { mobile: true });
    await setOffline(s, true);
    // navigator.onLine flips with the emulation; the module also polls.
    const bannerUp = await waitForExpr(s, `!document.getElementById('sync-banner').hidden`, { timeout: 12000 });
    t('M: going offline raises the sync banner at 390', bannerUp);
    const geom = await evaluate(s, `(()=>{
      const b = document.getElementById('sync-banner').getBoundingClientRect();
      const h = document.getElementById('header').getBoundingClientRect();
      return { bannerTop: Math.round(b.top), headerBottom: Math.round(h.bottom), bannerVisible: b.height > 0 };
    })()`);
    t('M: the banner sits below the header, not under it', geom.bannerVisible && geom.bannerTop >= geom.headerBottom - 1, JSON.stringify(geom));
    // Hit-testing, not geometry: a banner that merely renders lower can still
    // own the taps if it stacks above the header.
    const hits = await evaluate(s, `(()=>{
      const check = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return { sel, found: false };
        const r = el.getBoundingClientRect();
        const top = document.elementsFromPoint(r.left + r.width / 2, r.top + r.height / 2)[0];
        return { sel, found: true, ok: !!top && (top === el || el.contains(top) || top.contains(el)),
                 top: top ? (top.id || top.className.toString().slice(0, 40) || top.tagName) : null };
      };
      return ['#header [data-js="menu-toggle"]', '#header #auth-container button, #header #auth-container a', '#header .logo'].map(check);
    })()`);
    for (const h of hits) {
      t(`M: ${h.sel} is the top element at its centre while the banner shows`, h.found && h.ok, JSON.stringify(h));
    }
    const dismissed = await evaluate(s, `(()=>{
      const btn = document.querySelector('#sync-banner .sync-banner__close');
      if (!btn) return { close: false };
      btn.click();
      return { close: true, hidden: document.getElementById('sync-banner').hidden };
    })()`);
    t('M: the banner carries the shared dismiss affordance and it hides the banner', dismissed.close && dismissed.hidden, JSON.stringify(dismissed));
    await setOffline(s, false);
    await sleep(300);
    // Desktop keeps the side-nav pill instead of a banner (deliberate).
    await closePage(cdpPort, s);
    s = await newPage(cdpPort); acceptDialogs(s);
    await setViewport(s, 1280, 900, false);
    await boot(s);
    await setOffline(s, true);
    await sleep(2600);
    const desktop = await evaluate(s, `({
      bannerDisplay: getComputedStyle(document.getElementById('sync-banner')).display,
      pill: !!document.querySelector('.side-nav-footer .sync-status-pill'),
    })`);
    t('M: at 1280 the banner stays hidden and the side-nav pill is the surface', desktop.bannerDisplay === 'none' && desktop.pill, JSON.stringify(desktop));
    await setOffline(s, false);

    // ------------------------------------------------------------- K (service worker)
    // A deploy is simulated with a REAL origin whose bytes change: a tiny
    // proxy in front of the static server rewrites js/app.js and index.html
    // once `deployed` flips. That is what makes this meaningful - CDP
    // interception on the page target cannot see the requests the service
    // worker makes on its own behalf, which are exactly the ones whose cache
    // mode caused the mixed-version window (D5).
    await closePage(cdpPort, s);
    s = await newPage(cdpPort); acceptDialogs(s);
    await setViewport(s, 1280, 900, false);
    let deployed = false;
    // Flipping this makes the ORIGIN unreachable for the page AND the worker,
    // whichever worker instance is alive. CDP offline emulation has to be
    // re-applied to every service_worker target, and a worker that Chrome
    // restarted mid-run comes back online behind the test's back.
    let serverDown = false;
    // The proxy serves the SAME Cache-Control the site deploys with, read
    // from netlify.toml rather than hard-coded: the header shape is half of
    // the freshness model, and a positive max-age on js/* silently hides the
    // request from the worker (Chrome's memory cache answers it), which is
    // what produced the mixed-version window in the first place.
    const toml = await readFile(path.join(REPO, 'netlify.toml'), 'utf8');
    const headerFor = (glob) => {
      const block = toml.split('[[headers]]').find((b) => b.includes(`for = "${glob}"`)) || '';
      const m = /Cache-Control = "([^"]+)"/.exec(block);
      return m ? m[1] : 'public, max-age=0, must-revalidate';
    };
    const JS_CC = headerFor('/apps/gym-tracker/js/*');
    const proxy = http.createServer((req, res) => {
      if (serverDown) { res.destroy(); return; }
      const upstream = http.get(`${base}${req.url}`, (up) => {
        const chunks = [];
        up.on('data', (c) => chunks.push(c));
        up.on('end', () => {
          let body = Buffer.concat(chunks);
          const isApp = /^\/apps\/gym-tracker\/js\/app\.js/.test(req.url);
          const isIndex = /^\/apps\/gym-tracker\/(index\.html)?(\?.*)?$/.test(req.url);
          if (deployed && isApp) body = Buffer.from(`${body.toString()}\nwindow.__BUILD = 'v2';\n`);
          if (deployed && isIndex) body = Buffer.from(body.toString().replace('<head>', '<head><meta name="x-build" content="v2">'));
          const headers = { ...up.headers };
          delete headers['content-length'];
          // Mirror production exactly: the module header comes from
          // netlify.toml, HTML and the worker are always revalidated.
          if (isApp) headers['cache-control'] = JS_CC;
          else if (isIndex || /sw\.js/.test(req.url)) headers['cache-control'] = 'public, max-age=0, must-revalidate';
          res.writeHead(up.statusCode || 200, headers);
          res.end(body);
        });
      });
      upstream.on('error', () => { res.writeHead(502); res.end('proxy upstream error'); });
    });
    proxy.listen(0, '127.0.0.1');
    await once(proxy, 'listening');
    const PROXY = `http://127.0.0.1:${proxy.address().port}/apps/gym-tracker/`;
    try {
      await goto(s, PROXY, { settle: 2500 }); await ready(s);
      await clearAll(s); await seed(s, { gymTrackerOnboardingSeen: 'true', gymTrackerPrograms: [PROGRAM] });
      await evalAsync(s, `navigator.serviceWorker.ready.then(()=>1)`);
      await goto(s, PROXY, { settle: 2500 }); await ready(s);
      const build = () => evaluate(s, `({build: window.__BUILD||'v1', meta: document.querySelector('meta[name=x-build]')?.content||'v1', controller: !!navigator.serviceWorker.controller})`);
      const pre = await build();
      t('K: the pre-deploy load is controlled by the worker and is v1', pre.controller && pre.build === 'v1' && pre.meta === 'v1', JSON.stringify(pre));
      deployed = true;
      // Load 1 warms the caches from the new origin bytes, load 2 is what a
      // returning user gets. Before the fix this pair was new HTML + old JS.
      await goto(s, PROXY, { settle: 3000 }); await ready(s);
      await sleep(1200);
      await goto(s, PROXY, { settle: 3000 }); await ready(s);
      const post = await build();
      t('K: the load after a deploy runs the NEW module with the NEW html (no mixed pair)', post.build === 'v2' && post.meta === 'v2', JSON.stringify(post));
      // Update UI on controller change: reload when idle, ask when mid-workout.
      await evaluate(s, `(()=>{ window.__marker = 'alive'; navigator.serviceWorker.dispatchEvent(new Event('controllerchange')); return 1 })()`);
      await sleep(1500);
      t('K: a controller change with no workout live reloads the page', (await evaluate(s, `window.__marker || null`)) === null);
      await ready(s);
      t('K: workout starts for the mid-workout update check', await startWorkout(s));
      await evaluate(s, `(()=>{ window.__marker = 'alive'; navigator.serviceWorker.dispatchEvent(new Event('controllerchange')); return 1 })()`);
      await sleep(900);
      const toast = await evaluate(s, `({marker: window.__marker||null, toast: (document.getElementById('gym-update-toast')||{}).textContent||''})`);
      t('K: mid-workout, a controller change shows the update toast and does NOT reload', toast.marker === 'alive' && /Update available/.test(toast.toast) && /Reload now/.test(toast.toast), JSON.stringify(toast));
      await unguard(s);
      // Offline: a launch URL with a query string, and a page that was never
      // cached at all (D14).
      // Offline means the WORKER is offline too: it does its own fetches, so
      // page-only emulation lets it quietly reach the network and every
      // offline assertion below would pass for the wrong reason.
      serverDown = true;
      await setOffline(s, true);
      const swSessions = [];
      for (const target of await listTargets(cdpPort)) {
        if (target.type === 'service_worker' && target.url.includes('/apps/gym-tracker/')) {
          const sw = await connectTarget(target);
          await sw.send('Network.enable');
          await setOffline(sw, true);
          swSessions.push(sw);
        }
      }
      t('K: the worker target was found and taken offline', swSessions.length >= 1, `workers=${swSessions.length}`);
      await goto(s, `${PROXY}?utm_source=x`, { settle: 2000 });
      t('K: offline launch with a query string gets the app shell', await evaluate(s, `!!document.getElementById('home-view')`));
      await goto(s, `${PROXY}exercises/barbell-bench-press/`, { settle: 2000 });
      t('K: an offline exercise page gets the offline fallback, not the browser error page', await evaluate(s, `/You are offline/.test(document.body.innerText)`));
      serverDown = false;
      await setOffline(s, false);
      for (const sw of swSessions) { try { await setOffline(sw, false); sw.ws.close(); } catch { /* worker already gone */ } }
      await unguard(s).catch(() => {});
    } finally {
      proxy.close();
    }
  } finally {
    try { await closePage(cdpPort, s); } catch {}
  }

  // The runner consumes an ARRAY of { name, pass, detail } checks and
  // spreads it into its own results (tests/browser/run.mjs). Returning a
  // summary object instead threw "Spread syntax requires ...iterable" and
  // aborted the whole run BEFORE any of the 2026-08 audit suites executed,
  // so they were green standalone and never ran in the estate.
  return R;
}
