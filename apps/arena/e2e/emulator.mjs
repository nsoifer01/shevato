// Arena multiplayer e2e against the Firebase emulators (TESTING-AUDIT.md
// "Arena's multiplayer core is still not behaviorally testable" limitation).
//
// Two REAL app instances drive the full room lifecycle through the live
// Firestore + Auth emulators: create -> join by code -> start -> question
// propagation -> simultaneous answers -> score propagation -> game end ->
// rematch -> host handoff -> password gate -> invalid-code rejection.
//
// How the two players stay isolated inside one browser profile: page A is
// served from http://127.0.0.1:<port> and page B from
// http://localhost:<port> - same static server, different origins, so
// each page gets its own localStorage/IndexedDB and therefore its own
// Firebase (guest) user. Both hostnames satisfy the emulator seam in
// firebase-config.js (loopback + explicit localStorage opt-in, set here
// from a lightweight /robots.txt navigation before the app ever boots).
//
// Safety belts, both always on:
//   - production Firebase hostnames are intercepted and FAILED on every
//     page, so if the seam ever regressed the suite would break loudly
//     instead of writing production docs;
//   - The Trivia API is intercepted and fulfilled with a canned
//     deterministic pack, so no third-party call and no question
//     randomness (each question's correct answer is 'Correct-N').
//
// Preconditions (the standalone runner provides them; if this suite is
// ever wired into tests/browser/run.mjs the coordinator must do the
// same, or the suite skips cleanly): Firestore emulator on 8085 with the
// repo firestore.rules loaded for project 'shevato-site', Auth emulator
// on 9099, RTDB emulator on 9000.
//
// Deliberately NOT asserted (dropped as flaky-by-design, documented in
// apps/arena/FINDINGS.md): zero-console-error checks (the Firestore SDK
// logs transport noise against emulators) and exact score VALUES (they
// depend on answer latency via the speed bonus; the suite asserts scores
// are positive and IDENTICAL across both clients instead).
import {
  newPage, closePage, goto, evaluate, clickSel, clickText, setViewport,
  setValue, sleep, waitForExpr, interceptNetwork,
} from '../../../tests/browser/cdp.mjs';
import {
  loadRulesFile, clearData, ownerGetDocRaw,
} from '../tests-rules/emulator-harness.mjs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
// The page connects with the projectId baked into firebase-config.js; the
// emulator namespaces data AND rules per project id, so everything the
// suite loads/inspects must target this id, not the harness default.
const PAGE_PROJECT = 'shevato-site';

// Block by HOSTNAME, not substring: the auth emulator's URLs embed
// 'identitytoolkit.googleapis.com' in the PATH
// (http://127.0.0.1:9099/identitytoolkit.googleapis.com/...), and a
// substring match would fail emulator traffic too.
const PROD_FIREBASE = /^(?:https?|wss?):\/\/(?:[^/]*\.)?(?:firestore\.googleapis\.com|identitytoolkit\.googleapis\.com|securetoken\.googleapis\.com|firebaseio\.com)(?::\d+)?\//i;

// Canned Trivia API response: 10 questions, ids/texts carry their index
// so a page can always derive the correct answer from the question text.
const CANNED_QUESTIONS = Array.from({ length: 10 }, (_, i) => ({
  id: `e2e-q${i + 1}`,
  category: i % 2 === 0 ? 'Geography' : 'Science',
  question: { text: `Question ${i + 1}: pick Correct-${i + 1}` },
  correctAnswer: `Correct-${i + 1}`,
  incorrectAnswers: [`Wrong-${i + 1}-a`, `Wrong-${i + 1}-b`, `Wrong-${i + 1}-c`],
  type: 'text_choice',
  difficulty: 'easy',
}));

const FLAG_SETUP = `(()=>{ try {
  localStorage.clear(); sessionStorage.clear();
  localStorage.setItem('shevato:firebase-emulators','1');
  // The shared sync-modal integration opens a full-screen loading modal
  // (and later reloads the page) whenever a user signs in AFTER initial
  // page load - which is exactly what the guest-auth bootstrap on the
  // create/join buttons does. Its own 30s dedupe key suppresses that,
  // the same way a recent real sign-in would; without this, coordinate
  // clicks land on .sync-modal-content instead of the app.
  sessionStorage.setItem('lastSyncModalTime', String(Date.now()));
} catch(e){} return 1 })()`;

async function emulatorReachable() {
  try {
    await fetch('http://127.0.0.1:8085/', { signal: AbortSignal.timeout(1500) });
    await fetch('http://127.0.0.1:9099/', { signal: AbortSignal.timeout(1500) });
    return true;
  } catch {
    return false;
  }
}

export async function run({ base, cdpPort }) {
  const R = [];
  const t = (name, pass, detail = '') => R.push({ name, pass: !!pass, detail });
  const skip = (name, reason) => R.push({ name, pass: true, skipped: true, detail: reason });

  if (!(await emulatorReachable())) {
    skip('arena-emulator: suite', 'Firestore/Auth emulators not running on 8085/9099 (use apps/arena/e2e/run-emulator.mjs)');
    return R;
  }

  // Fresh data + the real ruleset for the page's project id, every run.
  await clearData(PAGE_PROJECT);
  await loadRulesFile(resolve(REPO_ROOT, 'firestore.rules'), PAGE_PROJECT);

  // Two isolated origins over the same static server (see header).
  const baseA = base;
  const baseB = base.replace('127.0.0.1', 'localhost');

  async function arenaPage(pageBase) {
    const s = await newPage(cdpPort);
    await setViewport(s, 1280, 900);
    await interceptNetwork(s, (url) => {
      if (PROD_FIREBASE.test(url)) return 'fail';
      if (/the-trivia-api\.com\/v2\/questions/i.test(url)) {
        return { status: 200, body: CANNED_QUESTIONS };
      }
      return null;
    });
    // Set the emulator opt-in flag from a page that loads no Firebase,
    // so the app's very first boot already routes to the emulators.
    await goto(s, pageBase + '/robots.txt', { settle: 200 });
    await evaluate(s, FLAG_SETUP);
    await goto(s, pageBase + '/apps/arena/', { settle: 800 });
    await waitForExpr(s, "!!window.firebaseAuth && document.readyState === 'complete'");
    return s;
  }

  // Headless Chrome pauses requestAnimationFrame in BACKGROUND tabs, and
  // Arena's host runs its whole game clock (early reveal, question
  // advance, finish) inside a rAF loop. The HOST page must therefore stay
  // the foreground tab; the joiner needs no rAF - its UI is driven by
  // Firestore snapshot callbacks, which fire fine in background tabs, and
  // CDP input reaches background targets regardless of focus.
  const front = (s) => s.send('Page.bringToFront');

  const lobbyVisible = "(()=>{const l=document.getElementById('lobby-panel');return !!l && l.getBoundingClientRect().height>0})()";
  const leaveRoom = async (s) => {
    // Leaving always routes through the shared confirm modal.
    await clickSel(s, '#leave-room-btn', { settle: 300 });
    await clickSel(s, '#confirm-modal-confirm', { settle: 500 });
    await waitForExpr(s, lobbyVisible, { timeout: 10000 });
  };
  // Scenario isolation: if a prior scenario left the page stuck inside a
  // room, force it back to the lobby so failures don't cascade.
  const ensureLobby = async (s) => {
    if (!(await evaluate(s, lobbyVisible))) await leaveRoom(s);
  };

  const visible = (id) => `(()=>{const e=document.getElementById('${id}');return !!e && !e.hidden && e.getBoundingClientRect().height>0})()`;

  // Clicks the category picker on whichever of the two pages currently
  // holds the decider role, then waits until both pages show a question
  // DIFFERENT from `prevText` (stage-game stays visible through the
  // previous question's reveal, so text change is the real signal).
  async function advanceThroughPick(pages, prevText = '', timeout = 25000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      for (const s of pages) {
        const canPick = await evaluate(s, `(()=>{
          const g=document.getElementById('pick-category-grid');
          if(!g) return false;
          const st=document.getElementById('stage-picking');
          if(!st || st.hidden) return false;
          return g.querySelectorAll('button').length > 0; })()`);
        if (canPick) await clickSel(s, '#pick-category-grid button', { settle: 400 });
      }
      const asking = await Promise.all(pages.map((s) => evaluate(s, `(()=>{
        const st=document.getElementById('stage-game');
        const q=document.getElementById('question-text');
        return (!!st && !st.hidden && !!q && q.textContent.trim().length>0)
          ? q.textContent.trim() : null; })()`)));
      if (asking.every((q) => q && q !== prevText) && asking[0] === asking[1]) return asking[0];
      await sleep(300);
    }
    return null;
  }

  // Reads 'Question N: ...' off the page and clicks 'Correct-N'.
  async function answerCorrectly(s) {
    const text = await evaluate(s, "document.getElementById('question-text').textContent");
    const m = /Question (\d+):/.exec(String(text || ''));
    if (!m) return false;
    return clickText(s, `Correct-${m[1]}`, { sel: '#answer-grid .answer-btn', settle: 300 });
  }

  let A = null, B = null;
  try {
    /* ---------- S1: full two-player game, end to end ---------- */
    A = await arenaPage(baseA);
    B = await arenaPage(baseB);
    // A is the host in every scenario; its rAF game clock must run (see
    // `front` above). Nothing below ever re-activates B's tab.
    await front(A);

    // Host: switch to trivia, shortest game, fastest timer, create.
    await clickSel(A, '.game-type-btn[data-game-type="trivia"]', { settle: 300 });
    await setValue(A, '#create-questions-count', '5');
    await setValue(A, '#create-trivia-time', '10');
    await clickSel(A, '#create-room-btn', { settle: 500 });
    const roomUp = await waitForExpr(A, visible('room-panel'), { timeout: 15000 });
    t('emulator: guest room create succeeds with production Firebase blocked (seam live)', roomUp,
      'room-panel never appeared; guest auth or Firestore write failed');
    const code = String(await evaluate(A, "document.getElementById('room-code-display').textContent") || '').trim();
    t('emulator: room code has the generator shape', /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/.test(code), `code=${JSON.stringify(code)}`);

    // The room doc the app REALLY wrote carries no password field.
    const roomDoc = await ownerGetDocRaw(`triviaRooms/${code}`, PAGE_PROJECT);
    t('emulator: public room doc exists and has no password field',
      roomDoc.status === 200 && roomDoc.doc && !('password' in (roomDoc.doc.fields || {})),
      `status=${roomDoc.status} fields=${Object.keys(roomDoc.doc?.fields || {}).join(',')}`);

    // Joiner: by code.
    await setValue(B, '#join-code', code);
    await clickSel(B, '#join-room-btn', { settle: 600 });
    t('emulator: second player joins by code', await waitForExpr(B, visible('room-panel'), { timeout: 15000 }));
    const bothInLobby = 'document.querySelectorAll(\'#lobby-player-grid li\').length === 2';
    t('emulator: both clients see 2 players in the lobby',
      (await waitForExpr(A, bothInLobby, { timeout: 10000 })) && (await waitForExpr(B, bothInLobby, { timeout: 10000 })));

    // Start.
    const startEnabled = await waitForExpr(A, "(()=>{const b=document.getElementById('start-game-btn');return !!b && !b.disabled})()", { timeout: 10000 });
    t('emulator: start button unlocks for the host once 2 players are in', startEnabled);
    await clickSel(A, '#start-game-btn', { settle: 800 });

    // Question 1: propagation check - advanceThroughPick only returns a
    // text when BOTH clients render the same non-empty question.
    let qText = await advanceThroughPick([A, B]);
    t('emulator: category pick advances both clients into the question stage', !!qText);
    t('emulator: the active question propagates identically to both clients',
      !!qText, `question=${JSON.stringify(qText)}`);

    // Play all 5 questions: both answer correctly every round. When all
    // players have answered, the host writes the early-reveal flag and
    // the round advances without waiting out the timer.
    let played = 0;
    while (qText && played < 5) {
      const okA = await answerCorrectly(A);
      const okB = await answerCorrectly(B);
      if (!okA || !okB) break;
      played++;
      if (played === 5) break; // last round resolves into the end stage below
      qText = await advanceThroughPick([A, B], qText);
    }
    t('emulator: all 5 rounds were playable (pick -> ask -> both answer -> advance)', played === 5, `played=${played}`);

    // End stage on both, scores present, positive and consistent.
    const endUp = 'document.getElementById(\'stage-end\') && !document.getElementById(\'stage-end\').hidden';
    t('emulator: game end reaches both clients',
      (await waitForExpr(A, endUp, { timeout: 25000 })) && (await waitForExpr(B, endUp, { timeout: 25000 })));
    const boardOf = (s) => evaluate(s, `(()=>{
      return [...document.querySelectorAll('#end-board-body tr')].map(r=>r.textContent.replace(/\\s+/g,' ').trim()); })()`);
    const boardA = await boardOf(A);
    const boardB = await boardOf(B);
    t('emulator: final scoreboard has both players on both clients',
      Array.isArray(boardA) && boardA.length === 2 && boardB.length === 2,
      `A=${boardA?.length} rows, B=${boardB?.length} rows`);
    t('emulator: final scores propagate identically to both clients',
      JSON.stringify(boardA) === JSON.stringify(boardB),
      `A=${JSON.stringify(boardA)} B=${JSON.stringify(boardB)}`);
    const scoresPositive = await evaluate(A, `(()=>{
      const nums=[...document.querySelectorAll('#end-board-body tr')].map(r=>{
        const m=r.textContent.replace(/[,\\s]/g,'').match(/(\\d{2,})/); return m?Number(m[1]):0; });
      return nums.length===2 && nums.every(n=>n>0); })()`);
    t('emulator: both players earned positive scores (5/5 correct answers)', !!scoresPositive);

    // Rematch: B proposes via the header Rematch button
    // (#room-end-again-btn - the only propose control that exists in the
    // markup; renderRematchUI's #end-again-btn is a dead reference), A
    // gets an Accept/Decline confirm modal and must respond inside the
    // proposal's 10s auto-cancel window.
    const proposeReady = await waitForExpr(B, visible('room-end-again-btn'), { timeout: 8000 });
    const proposeClicked = proposeReady && await clickSel(B, '#room-end-again-btn', { settle: 400 });
    const acceptShown = await waitForExpr(A, `(()=>{
      const b=document.getElementById('confirm-modal-body');
      return !!b && b.getBoundingClientRect().height>0 && /rematch|play again|new game/i.test(b.textContent); })()`, { timeout: 8000 });
    t('emulator: rematch proposal reaches the other client as an accept prompt', acceptShown,
      `btnReady=${proposeReady} clicked=${proposeClicked}`);
    const acceptClicked = await clickSel(A, '#confirm-modal-confirm', { settle: 500 });
    const round2 = `(()=>{
      const pick=document.getElementById('stage-picking');
      const game=document.getElementById('stage-game');
      return (!!pick && !pick.hidden) || (!!game && !game.hidden); })()`;
    const r2A = await waitForExpr(A, round2, { timeout: 20000 });
    const r2B = r2A && await waitForExpr(B, round2, { timeout: 20000 });
    let r2Detail = '';
    if (!r2A || !r2B) {
      const dump = await ownerGetDocRaw(`triviaRooms/${code}`, PAGE_PROJECT);
      r2Detail = `acceptClicked=${acceptClicked} status=${dump.doc?.fields?.status?.stringValue}`
        + ` accepted=${JSON.stringify(dump.doc?.fields?.rematchAcceptedBy)}`
        + ` round=${JSON.stringify(dump.doc?.fields?.round)}`;
    }
    t('emulator: unanimous rematch starts round 2 on both clients', r2A && r2B, r2Detail);

    // Leave: B first, then A (last leaver deletes the room + subcollections).
    await leaveRoom(B);
    await leaveRoom(A);
    const gone = await ownerGetDocRaw(`triviaRooms/${code}`, PAGE_PROJECT);
    t('emulator: last player leaving deletes the room doc', gone.status === 404, `status=${gone.status}`);

    /* ---------- S2: host handoff in the lobby ---------- */
    await ensureLobby(A);
    await ensureLobby(B);
    await clickSel(A, '.game-type-btn[data-game-type="trivia"]', { settle: 300 });
    await clickSel(A, '#create-room-btn', { settle: 500 });
    await waitForExpr(A, visible('room-panel'), { timeout: 15000 });
    const code2 = String(await evaluate(A, "document.getElementById('room-code-display').textContent") || '').trim();
    await setValue(B, '#join-code', code2);
    await clickSel(B, '#join-room-btn', { settle: 600 });
    await waitForExpr(B, visible('room-panel'), { timeout: 15000 });
    await waitForExpr(B, bothInLobby, { timeout: 10000 });
    const bUid = await evaluate(B, 'window.firebaseAuth.getCurrentUser().uid');
    await leaveRoom(A);
    const handedOff = await waitForExpr(B, "(()=>{const c=document.getElementById('lobby-host-controls');return !!c && !c.hidden})()", { timeout: 12000 });
    t('emulator: host leaving hands the room to the earliest joiner (host controls appear)', handedOff);
    const room2 = await ownerGetDocRaw(`triviaRooms/${code2}`, PAGE_PROJECT);
    t('emulator: room doc hostUid now names the surviving player',
      room2.status === 200 && room2.doc?.fields?.hostUid?.stringValue === bUid,
      `hostUid=${room2.doc?.fields?.hostUid?.stringValue} expected=${bUid}`);
    await leaveRoom(B);

    /* ---------- S3: password room (hashed gate, defect 22) ---------- */
    await ensureLobby(A);
    await ensureLobby(B);
    await clickSel(A, '.game-type-btn[data-game-type="trivia"]', { settle: 300 });
    await clickSel(A, '#create-private-toggle', { settle: 200 });
    await setValue(A, '#create-password', 'fixture-gate-phrase');
    await clickSel(A, '#create-room-btn', { settle: 500 });
    await waitForExpr(A, visible('room-panel'), { timeout: 15000 });
    const code3 = String(await evaluate(A, "document.getElementById('room-code-display').textContent") || '').trim();

    const privRoom = await ownerGetDocRaw(`triviaRooms/${code3}`, PAGE_PROJECT);
    t('emulator: private room doc persists NO cleartext password',
      privRoom.status === 200 && privRoom.doc?.fields?.isPrivate?.booleanValue === true
        && !('password' in (privRoom.doc.fields || {})),
      `fields=${Object.keys(privRoom.doc?.fields || {}).join(',')}`);
    const gate = await ownerGetDocRaw(`triviaRooms/${code3}/private/gate`, PAGE_PROJECT);
    t('emulator: private room persists a 64-hex gate hash instead',
      gate.status === 200 && /^[0-9a-f]{64}$/.test(gate.doc?.fields?.hash?.stringValue || ''),
      `hash=${gate.doc?.fields?.hash?.stringValue}`);

    await setValue(B, '#join-code', code3);
    const pwFieldShown = await waitForExpr(B, "(()=>{const f=document.getElementById('join-password-field');return !!f && !f.hidden})()", { timeout: 8000 });
    t('emulator: password field auto-reveals for a private room code', pwFieldShown);
    await setValue(B, '#join-password', 'wrong-password');
    await clickSel(B, '#join-room-btn', { settle: 800 });
    const wrongRejected = await waitForExpr(B, `(()=>{
      const e=document.getElementById('join-error');
      return !!e && !e.hidden && /incorrect password/i.test(e.textContent); })()`, { timeout: 10000 });
    t('emulator: wrong password is rejected with the Incorrect password message (rules permission-denied path)', wrongRejected);
    const stillLobby = await evaluate(B, "(()=>{const l=document.getElementById('lobby-panel');return !!l && l.getBoundingClientRect().height>0})()");
    t('emulator: wrong password leaves the joiner in the lobby', !!stillLobby);

    await setValue(B, '#join-password', 'fixture-gate-phrase');
    await clickSel(B, '#join-room-btn', { settle: 800 });
    t('emulator: correct password admits the joiner',
      await waitForExpr(B, visible('room-panel'), { timeout: 15000 }));
    await leaveRoom(B);
    await leaveRoom(A);
    const gateGone = await ownerGetDocRaw(`triviaRooms/${code3}/private/gate`, PAGE_PROJECT);
    t('emulator: room cleanup sweeps the gate doc too', gateGone.status === 404, `status=${gateGone.status}`);

    /* ---------- S4: invalid / nonexistent codes ---------- */
    await ensureLobby(B);
    await setValue(B, '#join-code', 'QQQQQ');
    await clickSel(B, '#join-room-btn', { settle: 600 });
    t('emulator: nonexistent (but well-formed) code surfaces Room not found',
      await waitForExpr(B, `(()=>{
        const e=document.getElementById('join-error');
        return !!e && !e.hidden && /room not found/i.test(e.textContent); })()`, { timeout: 10000 }));
    await setValue(B, '#join-code', 'IL0O1');
    await clickSel(B, '#join-room-btn', { settle: 600 });
    t('emulator: impossible-alphabet code is rejected before any lookup (defect 24 fix, live)',
      await waitForExpr(B, `(()=>{
        const e=document.getElementById('join-error');
        return !!e && !e.hidden && /5-character room code/i.test(e.textContent); })()`, { timeout: 10000 }));
  } catch (e) {
    t('arena-emulator: suite ran to completion', false, String(e && e.message || e).slice(0, 200));
  } finally {
    for (const s of [A, B]) { if (s) { try { await closePage(cdpPort, s); } catch { /* closed */ } } }
  }
  return R;
}
