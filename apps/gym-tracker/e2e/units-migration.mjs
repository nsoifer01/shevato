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

  /** What History actually renders for that set. */
  const renderedHistory = (s) => evaluate(s, `(async () => {
    document.querySelector('.nav-item[data-view="history"]').click();
    await new Promise(r => setTimeout(r, 1200));
    const card = document.querySelector('#history-view .history-card, #history-view [class*="card"]');
    if (card) { card.click(); await new Promise(r => setTimeout(r, 800)); }
    const txt = document.getElementById('history-view').innerText;
    const i = txt.indexOf('Dumbbell Bench');
    return i >= 0 ? txt.slice(i, i + 120) : '(not found)';
  })()`);

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

  return R;
}
