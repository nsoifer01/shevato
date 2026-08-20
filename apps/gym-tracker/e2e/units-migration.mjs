// Gym Tracker E2E: unit migration through the REAL startup path.
//
// The original canonical-units migration shipped with a passing unit suite
// and still corrupted real data, because every test called
// `migrateStoredData()` directly. That proves the pure function; it proves
// nothing about `app.init()`, about the order migration runs in relative to
// Settings and the sync layer, or about what the screen ends up showing.
//
// So these blocks seed localStorage exactly as the PRE-remediation app wrote
// it, boot the real application, and read the rendered DOM.
//
//   A. legacy lb profile boots and still reads 65 lb
//   B. the damaged install (version marker says migrated, records are legacy)
//      is repaired - this is the 65 lb -> 143.3 lb regression
//   C. a legacy kg profile is untouched (65 kg really is 65 kg)
//   D. reload and repeated boots never drift
//   E. flipping the display unit converts, and flipping back returns the
//      original numbers exactly
import { newPage, closePage, goto } from '../../../tests/browser/cdp.mjs';

/** Independently computed: 65 x 0.45359237. Not derived from app code. */
const KG_FOR_65_LB = 29.48350405;
/** Independently computed: 140 x 0.45359237 and 10 x 0.45359237. */
const KG_FOR_140_LB = 63.5029318;
const KG_FOR_10_LB = 4.5359237;

const legacySession = (weight, unitTag = null) => ({
  id: 1717000000003, programId: 'prog-1', workoutDayId: null,
  workoutDayName: 'Push A', date: '2026-08-12',
  startTime: '2026-08-12T18:30:00.000Z', endTime: '2026-08-12T19:35:00.000Z',
  exercises: [{
    exerciseId: 'dumbbell-bench-press', exerciseName: 'Dumbbell Bench Press',
    sets: [
      { weight, reps: 10, duration: 0, completed: true, restTime: 90, notes: '', slot: 0 },
      { weight, reps: 9, duration: 0, completed: true, restTime: 90, notes: '', slot: 1 },
    ],
    targetSets: 2, targetReps: 10, restSeconds: 90, notes: '', order: 0,
    completed: true, stickyValues: {}, groupId: null, feel: null,
  }],
  notes: '', completed: true, avgHeartRate: null, maxHeartRate: null,
  caloriesBurned: null, sessionUnit: unitTag, paused: false, pausedAt: null,
  elapsedBeforePause: 0, timestamp: '2026-08-12T18:30:00.000Z',
});

const legacyProfile = (unit, weight, extra = {}) => ({
  gymTrackerSettings: {
    weightUnit: unit, theme: 'dark', dateFormat: 'MM/DD/YYYY', firstDayOfWeek: 1,
    barWeight: unit === 'lb' ? 45 : 20, timeFormat: '24',
  },
  gymTrackerPrograms: [{
    id: 'prog-1', name: 'Push Pull Legs', description: '',
    exercises: [{
      exerciseId: 'dumbbell-bench-press', exerciseName: 'Dumbbell Bench Press',
      sets: [{ repsMin: 8, repsMax: 12 }, { repsMin: 8, repsMax: 12 }],
      restSeconds: 90, restAfterSeconds: 120, notes: '', order: 0, groupId: null,
    }],
    restMode: 'custom', uniformRestSeconds: 90, scheduleDays: [1, 4],
    createdAt: '2026-05-01T18:30:00.000Z', updatedAt: '2026-05-01T18:30:00.000Z',
  }],
  gymTrackerActiveProgram: 'prog-1',
  gymTrackerSessions: [legacySession(weight)],
  gymTrackerOnboardingSeen: true,
  ...extra,
});

export async function run({ base, cdpPort }) {
  const R = [];
  const APP = `${base}/apps/gym-tracker/index.html`;
  const t = (name, pass, detail = '') => { R.push({ name, pass, detail }); };

  const evaluate = async (s, expr) => {
    const r = await s.send('Runtime.evaluate', {
      expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };

  /** Seed a whole localStorage profile, then boot the real app on it. */
  const boot = async (s, profile) => {
    await goto(s, `${base}/apps/gym-tracker/manifest.webmanifest`, { settle: 200 });
    await evaluate(s, `(() => { localStorage.clear();
      const p = ${JSON.stringify(profile)};
      for (const [k, v] of Object.entries(p)) localStorage.setItem(k, JSON.stringify(v));
      return true; })()`);
    await goto(s, APP, { settle: 3500 });
  };

  /** The stored (canonical) weight of the first logged set. */
  const storedWeight = (s) => evaluate(s,
    `JSON.parse(localStorage.getItem('gymTrackerSessions'))[0].exercises[0].sets[0].weight`);

  /**
   * What History actually renders for a given exercise. Any open modal is
   * dismissed first: the exercise-detail dialog sits over the nav, so leaving
   * it open makes History look empty rather than wrong.
   */
  const renderedHistory = (s, needle = 'Dumbbell Bench') => evaluate(s, `(async () => {
    const w = ms => new Promise(r => setTimeout(r, ms));
    document.querySelectorAll('.modal.active').forEach(m => m.classList.remove('active'));
    await w(300);
    document.querySelector('.nav-item[data-view="history"]').click();
    await w(1200);
    const v = document.getElementById('history-view');
    const card = v.querySelector('.workout-card');
    if (card) { card.click(); await w(900); }
    const m = document.getElementById('workout-detail-modal');
    const txt = (m && m.classList.contains('active')) ? m.innerText : v.innerText;
    const i = txt.indexOf(${JSON.stringify('%NEEDLE%')});
    return i >= 0 ? txt.slice(i, i + 160) : '(not found)';
  })()`.replace('%NEEDLE%', needle));

  const withPage = async (label, fn) => {
    let s = null;
    try { s = await newPage(cdpPort); await fn(s); }
    catch (e) { t(`${label}: block ran`, false, String(e && e.message).slice(0, 160)); }
    finally { if (s) try { await closePage(cdpPort, s); } catch { /* gone */ } }
  };

  /* --- A. legacy lb profile, never migrated ------------------------------ */
  await withPage('gym-units A', async (s) => {
    await boot(s, legacyProfile('lb', 65));
    const w = await storedWeight(s);
    t('gym-units A: 65 lb stored as canonical kg',
      Math.abs(w - KG_FOR_65_LB) < 1e-9, `stored ${w}`);
    const txt = await renderedHistory(s);
    t('gym-units A: History still shows 65lb', /65\s*lb/i.test(txt), txt.slice(0, 90));
    t('gym-units A: History does NOT show 143.3lb', !/143\.3/.test(txt), txt.slice(0, 90));
  });

  /* --- B. THE regression: damaged install -------------------------------- */
  // Version marker claims migrated, records are still legacy lb. This is the
  // state the sync race leaves behind, and what made a real 65 lb bench press
  // render as 143.3 lb.
  await withPage('gym-units B', async (s) => {
    await boot(s, legacyProfile('lb', 65, { gymTrackerDataVersion: 2 }));
    const w = await storedWeight(s);
    t('gym-units B: damaged install is repaired on boot',
      Math.abs(w - KG_FOR_65_LB) < 1e-9, `stored ${w}`);
    const txt = await renderedHistory(s);
    t('gym-units B: shows 65lb, not 143.3lb',
      /65\s*lb/i.test(txt) && !/143\.3/.test(txt), txt.slice(0, 90));
  });

  /* --- C. legacy kg profile is untouched --------------------------------- */
  await withPage('gym-units C', async (s) => {
    await boot(s, legacyProfile('kg', 65));
    const w = await storedWeight(s);
    t('gym-units C: 65 kg stays 65 kg', w === 65, `stored ${w}`);
    const txt = await renderedHistory(s);
    t('gym-units C: History shows 65kg', /65\s*kg/i.test(txt), txt.slice(0, 90));
  });

  /* --- D. reload and repeated boots never drift -------------------------- */
  await withPage('gym-units D', async (s) => {
    await boot(s, legacyProfile('lb', 65));
    const first = await storedWeight(s);
    for (let i = 0; i < 3; i++) await goto(s, APP, { settle: 2500 });
    const after = await storedWeight(s);
    t('gym-units D: three reloads do not reconvert', first === after,
      `${first} -> ${after}`);
    const txt = await renderedHistory(s);
    t('gym-units D: still 65lb after reloads', /65\s*lb/i.test(txt), txt.slice(0, 90));
  });

  /* --- E. display-unit round trip ---------------------------------------- */
  await withPage('gym-units E', async (s) => {
    await boot(s, legacyProfile('lb', 65));
    const stored = await storedWeight(s);

    // Flip the account to kilograms through the stored setting + reload,
    // which is what the Settings screen does.
    await evaluate(s, `(() => { const st = JSON.parse(localStorage.getItem('gymTrackerSettings'));
      st.weightUnit = 'kg'; localStorage.setItem('gymTrackerSettings', JSON.stringify(st)); return true; })()`);
    await goto(s, APP, { settle: 3000 });
    const afterFlip = await storedWeight(s);
    t('gym-units E: switching to kg does not rewrite storage',
      afterFlip === stored, `${stored} -> ${afterFlip}`);
    const kgTxt = await renderedHistory(s);
    t('gym-units E: reads ~29.5kg in metric', /29\.5\s*kg/i.test(kgTxt), kgTxt.slice(0, 90));

    // ...and back to pounds returns exactly 65.
    await evaluate(s, `(() => { const st = JSON.parse(localStorage.getItem('gymTrackerSettings'));
      st.weightUnit = 'lb'; localStorage.setItem('gymTrackerSettings', JSON.stringify(st)); return true; })()`);
    await goto(s, APP, { settle: 3000 });
    const backTxt = await renderedHistory(s);
    t('gym-units E: back in lb it is 65lb again',
      /65\s*lb/i.test(backTxt) && !/143\.3/.test(backTxt), backTxt.slice(0, 90));
    t('gym-units E: storage unchanged by the round trip',
      (await storedWeight(s)) === stored, '');
  });

  /* --- F. measurements are ASKED about, never guessed --------------------- */
  // Measurements carry no per-record evidence of their original units, so a
  // damaged lb profile must put the question to the user rather than infer it
  // from whether a waist "looks like" inches or centimetres.
  await withPage('gym-units F', async (s) => {
    await boot(s, legacyProfile('lb', 65, {
      gymTrackerDataVersion: 2,
      gymTrackerMeasurements: [{
        id: 1, date: '2026-08-12', weight: 180, bodyFat: 17, chest: 42,
        waist: 34, hips: null, armLeft: 15, armRight: 15,
        thighLeft: 23, thighRight: 23, notes: '',
      }],
      gymTrackerMeasurementGoals: { weight: { target: 175, direction: 'down' } },
    }));

    const modal = await evaluate(s, `(() => {
      const m = document.getElementById('measurement-units-modal');
      return { active: !!m && m.classList.contains('active'), text: m ? m.innerText : '' };
    })()`);
    t('gym-units F: the units question is asked', modal.active, '');
    t('gym-units F: it shows the real stored numbers',
      /180 lb or 180 kg/.test(modal.text), modal.text.slice(0, 100));

    const before = await evaluate(s,
      `JSON.parse(localStorage.getItem('gymTrackerMeasurements'))[0].waist`);
    t('gym-units F: nothing is rewritten while the question is open', before === 34, `waist ${before}`);

    await evaluate(s, `(async () => {
      document.getElementById('measurement-units-imperial').click();
      await new Promise(r => setTimeout(r, 900)); return true; })()`);

    const after = await evaluate(s,
      `JSON.parse(localStorage.getItem('gymTrackerMeasurements'))[0]`);
    t('gym-units F: 34 in stored as 86.36 cm', Math.abs(after.waist - 86.36) < 1e-9, `waist ${after.waist}`);
    t('gym-units F: 180 lb stored as 81.6466266 kg',
      Math.abs(after.weight - 81.6466266) < 1e-9, `weight ${after.weight}`);
    t('gym-units F: the record is stamped canonical', after.unitsCanonical === true, '');
    t('gym-units F: a rollback copy was written',
      await evaluate(s, `!!localStorage.getItem('gymTrackerMeasurementsBackup')`), '');
    t('gym-units F: the decision is recorded so it is never asked twice',
      (await evaluate(s, `JSON.parse(localStorage.getItem('gymTrackerMeasurementUnits')).status`)) === 'resolved', '');

    // Re-boot: the question must not come back, and nothing may convert again.
    await goto(s, APP, { settle: 3000 });
    const reasked = await evaluate(s,
      `document.getElementById('measurement-units-modal').classList.contains('active')`);
    t('gym-units F: not asked again after a reload', !reasked, '');
    const stable = await evaluate(s,
      `JSON.parse(localStorage.getItem('gymTrackerMeasurements'))[0].waist`);
    t('gym-units F: no double conversion on reboot', Math.abs(stable - 86.36) < 1e-9, `waist ${stable}`);
  });

  /* --- G. Settings > Re-check stored units is a safe no-op --------------- */
  await withPage('gym-units G', async (s) => {
    await boot(s, legacyProfile('lb', 65));
    const baseline = await storedWeight(s);

    const runRecheck = () => evaluate(s, `(async () => {
      const nav = document.querySelector('[data-view="settings"]');
      if (nav) nav.click();
      await new Promise(r => setTimeout(r, 900));
      document.getElementById('recheck-units-btn').click();
      await new Promise(r => setTimeout(r, 700));
      return document.getElementById('recheck-units-result').textContent;
    })()`);

    const first = await runRecheck();
    t('gym-units G: reports a clean scan', /No repairs needed/i.test(first), first);
    t('gym-units G: changed nothing', (await storedWeight(s)) === baseline, '');

    const second = await runRecheck();
    t('gym-units G: still clean when run twice', /No repairs needed/i.test(second), second);
    t('gym-units G: still changed nothing', (await storedWeight(s)) === baseline, '');

    // Switching display unit must not make the scan want to convert anything.
    await evaluate(s, `(() => { const st = JSON.parse(localStorage.getItem('gymTrackerSettings'));
      st.weightUnit = 'kg'; localStorage.setItem('gymTrackerSettings', JSON.stringify(st)); return true; })()`);
    await goto(s, APP, { settle: 3000 });
    const third = await runRecheck();
    t('gym-units G: clean after a display-unit switch', /No repairs needed/i.test(third), third);
    t('gym-units G: unit switch did not move stored data',
      (await storedWeight(s)) === baseline, '');
  });

  /* --- H. a stale record arriving from another device is repaired -------- */
  await withPage('gym-units H', async (s) => {
    await boot(s, legacyProfile('lb', 65));
    const canonical = await storedWeight(s);

    // An older device pushes an un-migrated session in, exactly as
    // applyRemoteChange() does: raw setItem, then the remote event.
    await evaluate(s, `(() => {
      const list = JSON.parse(localStorage.getItem('gymTrackerSessions'));
      const stale = ${JSON.stringify(legacySession(135))};
      stale.id = 999; list.push(stale);
      localStorage.setItem('gymTrackerSessions', JSON.stringify(list));
      window.dispatchEvent(new CustomEvent('localStorageSync',
        { detail: { key: 'gymTrackerSessions', value: list, source: 'remote' } }));
      return true; })()`);
    await new Promise(r => setTimeout(r, 2200));

    const out = await evaluate(s, `JSON.parse(localStorage.getItem('gymTrackerSessions'))
      .map(x => x.exercises[0].sets[0].weight)`);
    t('gym-units H: the canonical record was left alone',
      Math.abs(out[0] - canonical) < 1e-9, `${out[0]}`);
    t('gym-units H: the stale record was repaired (135 lb -> 61.235 kg)',
      Math.abs(out[1] - 61.23496995) < 1e-9, `${out[1]}`);
  });

  /* --- I. #history and #exercises must agree on the SAME record ---------- */
  // The exercise detail read canonical kilograms and appended the account's
  // unit label, so a real 140 lb pulldown rendered "63.503 lb" while History
  // - two taps away, same record - correctly said 140lb.
  await withPage('gym-units I', async (s) => {
    await boot(s, {
      gymTrackerSettings: { weightUnit: 'lb', firstDayOfWeek: 1, timeFormat: '24' },
      gymTrackerOnboardingSeen: true,
      gymTrackerSessions: [{
        id: 1717000009, programId: 'p1', workoutDayName: 'Pull A', date: '2026-08-12',
        startTime: '2026-08-12T18:00:00.000Z', endTime: '2026-08-12T19:00:00.000Z',
        exercises: [{
          // 101 = Neutral-Grip Lat Pulldown, 452 = Decline Crunch.
          exerciseId: 101, exerciseName: 'Neutral-Grip Lat Pulldown',
          sets: [
            { weight: 140, reps: 10, duration: 0, completed: true, slot: 0 },
            { weight: 140, reps: 9, duration: 0, completed: true, slot: 1 },
          ],
          targetSets: 2, targetReps: 10, restSeconds: 90, notes: '', order: 0,
          completed: true, stickyValues: {}, groupId: null, feel: null,
        }, {
          exerciseId: 452, exerciseName: 'Decline Crunch',
          sets: [{ weight: 10, reps: 15, duration: 0, completed: true, slot: 0 }],
          targetSets: 1, targetReps: 15, restSeconds: 60, notes: '', order: 1,
          completed: true, stickyValues: {}, groupId: null, feel: null,
        }],
        notes: '', completed: true, sessionUnit: null, paused: false,
        elapsedBeforePause: 0, timestamp: '2026-08-12T18:00:00.000Z',
      }],
    });

    const stored = await evaluate(s,
      `JSON.parse(localStorage.getItem('gymTrackerSessions'))[0].exercises[0].sets[0].weight`);
    t('gym-units I: 140 lb stored as canonical kg',
      Math.abs(stored - KG_FOR_140_LB) < 1e-9, `stored ${stored}`);

    const detail = await evaluate(s, `(async () => {
      const w = ms => new Promise(r => setTimeout(r, ms));
      document.querySelector('.nav-item[data-view="more"]').click(); await w(700);
      document.querySelector('[data-view="exercises"]').click(); await w(1300);
      const q = document.getElementById('exercise-db-search');
      q.value = 'Neutral-Grip Lat'; q.dispatchEvent(new Event('input', { bubbles: true }));
      await w(800);
      const row = document.querySelector('#exercise-db-list [data-action="show-exercise-history"]');
      if (!row) return '(no row)';
      row.click(); await w(1300);
      const d = document.getElementById('exercise-detail-modal');
      return d && d.classList.contains('active') ? d.innerText : '(closed)';
    })()`);
    t('gym-units I: #exercises shows 140 lb', /140 lb/.test(detail), detail.slice(0, 120));
    t('gym-units I: #exercises does NOT show 63.5', !/63\.5/.test(detail));
    t('gym-units I: e1RM is converted too, not raw kg',
      !/latest: (8[0-9]|9[0-9]) lb/.test(detail), (detail.match(/latest: [^\n]*/) || [''])[0]);

    const hist = await renderedHistory(s, 'Neutral-Grip Lat');
    t('gym-units I: #history agrees with #exercises', /140lb/.test(hist), hist.slice(0, 90));
  });

  /* --- J. no automatic next-weight recommendation ------------------------ */
  // Two clean sessions used to trigger a bump. The increment was defined in
  // the DISPLAY unit and added to a CANONICAL-kg weight, so 60 lb came back
  // as 71 lb behind a "+11lb suggested" badge. The feature is gone; the
  // prefill is the lifter's own last session.
  await withPage('gym-units J', async (s) => {
    const session = (id, date, weight) => ({
      id, programId: 'p1', workoutDayName: 'Push', date,
      startTime: `${date}T18:00:00.000Z`, endTime: `${date}T19:00:00.000Z`,
      exercises: [{
        exerciseId: 21, exerciseName: 'Dumbbell Bench Press',
        sets: [0, 1, 2].map(slot => ({ weight, reps: 12, duration: 0, completed: true, slot })),
        targetSets: 3, targetReps: 12, restSeconds: 90, notes: '', order: 0,
        completed: true, stickyValues: {}, groupId: null, feel: null,
      }],
      notes: '', completed: true, sessionUnit: null, paused: false,
      elapsedBeforePause: 0, timestamp: `${date}T18:00:00.000Z`,
    });
    await boot(s, {
      gymTrackerSettings: { weightUnit: 'lb', firstDayOfWeek: 1, timeFormat: '24' },
      gymTrackerOnboardingSeen: true,
      gymTrackerActiveProgram: 'p1',
      gymTrackerPrograms: [{
        id: 'p1', name: 'Push', description: '',
        exercises: [{
          exerciseId: 21, exerciseName: 'Dumbbell Bench Press',
          sets: [{ repsMin: 8, repsMax: 12 }, { repsMin: 8, repsMax: 12 }, { repsMin: 8, repsMax: 12 }],
          restSeconds: 90, restAfterSeconds: 120, notes: '', order: 0, groupId: null,
        }],
        restMode: 'custom', uniformRestSeconds: 90, scheduleDays: [],
        createdAt: '2026-05-01T10:00:00.000Z', updatedAt: '2026-05-01T10:00:00.000Z',
      }],
      // Both sessions at the top of the rep range: the old bump condition.
      gymTrackerSessions: [session(1717000010, '2026-07-29', 60), session(1717000011, '2026-08-12', 60)],
    });

    const row = await evaluate(s, `(async () => {
      const w = ms => new Promise(r => setTimeout(r, ms));
      document.querySelector('.nav-item[data-view="workout"]').click(); await w(1100);
      const b = [...document.querySelectorAll('#workout-view button')]
        .find(x => /start workout/i.test(x.textContent) && x.offsetParent);
      if (b) { b.click(); await w(1800); }
      const rows = [...document.querySelectorAll('li.set-row')]
        .map(r => [...r.querySelectorAll('input')][0]?.value);
      return { rows, body: document.getElementById('workout-view').innerText };
    })()`);
    t('gym-units J: prefill is the real previous weight, not 71',
      row.rows.every(v => v === '60'), JSON.stringify(row.rows));
    t('gym-units J: no "suggested" badge anywhere', !/suggested/i.test(row.body));
    t('gym-units J: no "deload" badge anywhere', !/deload/i.test(row.body));
    t('gym-units J: no "Use last weight" control', !/use last weight/i.test(row.body));
    t('gym-units J: no "Repeat weight" instruction', !/repeat weight/i.test(row.body));
  });

  /* --- K. the smiley lasts exactly one following workout ----------------- */
  // It used to be the most recent 'good' ANYWHERE in history, so marking once
  // showed the icon for ever. It now means "I marked this good last time".
  await withPage('gym-units K', async (s) => {
    const sess = (id, date, feel) => ({
      id, programId: 'p1', workoutDayName: 'Push', date,
      startTime: `${date}T18:00:00.000Z`, endTime: `${date}T19:00:00.000Z`,
      exercises: [{
        exerciseId: 21, exerciseName: 'Dumbbell Bench Press', feel,
        sets: [{ weight: 60, reps: 12, duration: 0, completed: true, slot: 0 }],
        targetSets: 1, targetReps: 12, restSeconds: 90, notes: '', order: 0,
        completed: true, stickyValues: {}, groupId: null,
      }],
      notes: '', completed: true, sessionUnit: null, paused: false,
      elapsedBeforePause: 0, timestamp: `${date}T18:00:00.000Z`,
    });
    const program = {
      id: 'p1', name: 'Push', description: '',
      exercises: [{
        exerciseId: 21, exerciseName: 'Dumbbell Bench Press',
        sets: [{ repsMin: 8, repsMax: 12 }],
        restSeconds: 90, restAfterSeconds: 120, notes: '', order: 0, groupId: null,
      }],
      restMode: 'custom', uniformRestSeconds: 90, scheduleDays: [],
      createdAt: '2026-05-01T10:00:00.000Z', updatedAt: '2026-05-01T10:00:00.000Z',
    };
    const base = {
      gymTrackerSettings: { weightUnit: 'lb', firstDayOfWeek: 1, timeFormat: '24' },
      gymTrackerOnboardingSeen: true, gymTrackerActiveProgram: 'p1',
      gymTrackerPrograms: [program],
    };
    const smileyShowing = () => evaluate(s, `(async () => {
      const wt = ms => new Promise(r => setTimeout(r, ms));
      document.querySelector('.nav-item[data-view="workout"]').click(); await wt(1100);
      const b = [...document.querySelectorAll('#workout-view button')]
        .find(x => /start workout/i.test(x.textContent) && x.offsetParent);
      if (b) { b.click(); await wt(1700); }
      return !!document.querySelector('#exercise-0 .feel-history-good');
    })()`);

    // Marked good LAST session -> shown.
    await boot(s, { ...base, gymTrackerSessions: [sess(1, '2026-08-01', 'good')] });
    t('gym-units K: shown after an explicit good last time', await smileyShowing());

    // Marked good, then a session WITHOUT a marking -> gone.
    await boot(s, { ...base, gymTrackerSessions: [sess(1, '2026-08-01', 'good'), sess(2, '2026-08-08', null)] });
    t('gym-units K: expires when the next session is unmarked', !(await smileyShowing()));

    // Marked good twice -> renewed.
    await boot(s, { ...base, gymTrackerSessions: [sess(1, '2026-08-01', 'good'), sess(2, '2026-08-08', 'good')] });
    t('gym-units K: renewed by marking good again', await smileyShowing());

    // A better session without a marking still expires it.
    const better = sess(3, '2026-08-08', null);
    better.exercises[0].sets = [{ weight: 100, reps: 12, duration: 0, completed: true, slot: 0 }];
    await boot(s, { ...base, gymTrackerSessions: [sess(1, '2026-08-01', 'good'), better] });
    t('gym-units K: performance alone never keeps it', !(await smileyShowing()));
  });

  /* --- L. a manual edit to an unfinished row is session state ------------- */
  await withPage('gym-units L', async (s) => {
    await boot(s, {
      gymTrackerSettings: { weightUnit: 'lb', firstDayOfWeek: 1, timeFormat: '24' },
      gymTrackerOnboardingSeen: true, gymTrackerActiveProgram: 'p1',
      gymTrackerPrograms: [{
        id: 'p1', name: 'Push', description: '',
        exercises: [{
          exerciseId: 21, exerciseName: 'Dumbbell Bench Press',
          sets: [{ repsMin: 8, repsMax: 12 }, { repsMin: 8, repsMax: 12 }, { repsMin: 8, repsMax: 12 }],
          restSeconds: 90, restAfterSeconds: 120, notes: '', order: 0, groupId: null,
        }],
        restMode: 'custom', uniformRestSeconds: 90, scheduleDays: [],
        createdAt: '2026-05-01T10:00:00.000Z', updatedAt: '2026-05-01T10:00:00.000Z',
      }],
      gymTrackerSessions: [{
        id: 9, programId: 'p1', workoutDayName: 'Push', date: '2026-08-12',
        startTime: '2026-08-12T18:00:00.000Z', endTime: '2026-08-12T19:00:00.000Z',
        exercises: [{
          exerciseId: 21, exerciseName: 'Dumbbell Bench Press', feel: null,
          sets: [0, 1, 2].map(slot => ({ weight: 60, reps: 10, duration: 0, completed: true, slot })),
          targetSets: 3, targetReps: 10, restSeconds: 90, notes: '', order: 0,
          completed: true, stickyValues: {}, groupId: null,
        }],
        notes: '', completed: true, sessionUnit: null, paused: false,
        elapsedBeforePause: 0, timestamp: '2026-08-12T18:00:00.000Z',
      }],
    });

    const out = await evaluate(s, `(async () => {
      const wt = ms => new Promise(r => setTimeout(r, ms));
      document.querySelector('.nav-item[data-view="workout"]').click(); await wt(1100);
      [...document.querySelectorAll('#workout-view button')]
        .find(x => /start workout/i.test(x.textContent) && x.offsetParent).click(); await wt(1800);
      const rowAt = (slot) => [...document.querySelectorAll('#exercise-0 li.set-row')]
        .find(r => r.dataset.slot === String(slot));
      const valsAt = (slot) => { const r = rowAt(slot); if (!r) return null;
        const i = [...r.querySelectorAll('input')]; return { w: i[0]?.value, reps: i[1]?.value }; };
      const type = (el, v) => { el.focus(); el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true })); };

      const r2 = rowAt(1); const i2 = [...r2.querySelectorAll('input')];
      type(i2[0], '65'); type(i2[1], '8'); await wt(400);
      const edited = valsAt(1);
      rowAt(0).querySelector('.set-toggle:not(.set-toggle--ghost)').click(); await wt(1200);
      return { edited, afterComplete: valsAt(1),
               sticky: JSON.parse(localStorage.getItem('gymTrackerActiveWorkout'))
                 ?.exercises?.[0]?.stickyValues ?? null };
    })()`);

    t('gym-units L: prefill starts at the previous session', out.edited.w === '65', JSON.stringify(out.edited));
    t('gym-units L: the edit survives completing another set',
      out.afterComplete.w === '65' && out.afterComplete.reps === '8', JSON.stringify(out.afterComplete));
    t('gym-units L: it is stored canonically in the active workout',
      !!out.sticky && Math.abs(out.sticky['1'].weight - KG_FOR_65_LB) < 1e-9, JSON.stringify(out.sticky));
  });

  return R;
}
