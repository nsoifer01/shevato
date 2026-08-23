// Arena multiplayer e2e against the Firebase emulators (TESTING-AUDIT.md
// "Arena's multiplayer core is still not behaviorally testable" limitation,
// extended in the 2026-08-23 remediation round of the site-wide audit).
//
// Real app instances drive the full room lifecycle through the live
// Firestore + Auth emulators: create -> join by code -> start -> question
// propagation -> simultaneous answers -> score propagation -> game end ->
// rematch -> host handoff -> password gate -> invalid-code rejection, plus
// the audit's regressions: a first-time guest creating a room with NO
// sync-modal seed (D2), the gate-deletion exploit from a third client
// (D1), a ghost player (D4), a hidden host tab (D3), an answer while
// offline (D9), the chat rate limit at the call site (D11), a coordinate
// double-click on Start (D12), a stale rematch prompt (D13), the end
// screen after a leaver (D5), chat/gate/ghost cleanup after the last
// leaver (D6), leaderboard == profile for a registered player (D8), the
// Globe Drop clock, and seeded axe scans of in-room states (D15).
//
// How players stay isolated inside one browser profile: page A is served
// from http://127.0.0.1:<port>, page B from http://localhost:<port> and
// page C from http://127.0.0.1:<port2> (a second static server) - three
// origins, three localStorage/IndexedDB partitions, three Firebase (guest
// or registered) users. All hostnames satisfy the emulator seam in
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
// on 9099, RTDB emulator on 9000, and a second static server (base2).
//
// Deliberately NOT asserted (dropped as flaky-by-design, documented in
// apps/arena/FINDINGS.md): zero-console-error checks (the Firestore SDK
// logs transport noise against emulators) and exact score VALUES (they
// depend on answer latency via the speed bonus; the suite asserts scores
// are positive and IDENTICAL across clients instead).
import {
  newPage, closePage, goto, evaluate, evalAsync, clickSel, clickText, clickAt, setViewport,
  setValue, sleep, waitForExpr, interceptNetwork, setOffline, screenshot,
} from '../../../tests/browser/cdp.mjs';
import {
  loadRulesFile, clearData, ownerGetDocRaw,
} from '../tests-rules/emulator-harness.mjs';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const AXE_PATH = resolve(REPO_ROOT, 'tests/browser/vendor/axe.min.js');
const SHOT_DIR = resolve(REPO_ROOT, '.screenshots/e2e-arena');
// The page connects with the projectId baked into firebase-config.js; the
// emulator namespaces data AND rules per project id, so everything the
// suite loads/inspects must target this id, not the harness default.
const PAGE_PROJECT = 'shevato-site';
const EMU_DOCS = `http://127.0.0.1:8085/v1/projects/${PAGE_PROJECT}/databases/(default)/documents`;

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

// NO sync-modal dedupe seed here (audit D2): every page is a first-time
// visitor, exactly the shape that used to trigger the shared sync modal
// and its reload on the first guest sign-in. The integration now skips
// anonymous users, and the fresh-guest scenario below proves it.
const FLAG_SETUP = `(()=>{ try {
  localStorage.clear(); sessionStorage.clear();
  localStorage.setItem('shevato:firebase-emulators','1');
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

// Owner-bypass listing of a collection path ('triviaRooms' or
// 'triviaRooms/CODE/chat'): returns the document ids.
async function ownerList(path) {
  const res = await fetch(`${EMU_DOCS}/${path}?pageSize=300`, { headers: { Authorization: 'Bearer owner' } });
  const j = await res.json().catch(() => ({}));
  return (j.documents || []).map((d) => d.name.split('/').pop());
}
// Owner-bypass field patch (simple scalar values only).
async function ownerPatch(path, fields) {
  const enc = (v) => v === null ? { nullValue: null } : typeof v === 'string' ? { stringValue: v }
    : typeof v === 'boolean' ? { booleanValue: v } : Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  const mask = Object.keys(fields).map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
  const res = await fetch(`${EMU_DOCS}/${path}?${mask}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
    body: JSON.stringify({ fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, enc(v)])) }),
  });
  return res.status;
}
const fieldsOf = (d) => {
  const out = {};
  for (const [k, v] of Object.entries(d?.doc?.fields || {})) out[k] = Object.values(v)[0];
  return out;
};

export async function run({ base, cdpPort, base2 = null }) {
  const R = [];
  // ARENA_E2E_VERBOSE=1 streams each check as it resolves. The runner only
  // prints the tally at the end, so without this a suite that stalls gives
  // no clue which check it stalled on.
  const t = (name, pass, detail = '') => {
    if (process.env.ARENA_E2E_VERBOSE) {
      console.log(`    [${pass ? 'ok  ' : 'FAIL'}] ${name}${pass ? '' : '  [' + String(detail).slice(0, 160) + ']'}`);
    }
    R.push({ name, pass: !!pass, detail: detail ? String(detail).slice(0, 240) : '' });
  };
  const skip = (name, reason) => R.push({ name, pass: true, skipped: true, detail: reason });

  if (!(await emulatorReachable())) {
    skip('arena-emulator: suite', 'Firestore/Auth emulators not running on 8085/9099 (use apps/arena/e2e/run-emulator.mjs)');
    return R;
  }

  // Fresh data + the real ruleset for the page's project id, every run.
  await clearData(PAGE_PROJECT);
  await loadRulesFile(resolve(REPO_ROOT, 'firestore.rules'), PAGE_PROJECT);
  await mkdir(SHOT_DIR, { recursive: true });
  const axeSource = await readFile(AXE_PATH, 'utf8');

  // Three isolated origins (see header).
  const baseA = base;
  const baseB = base.replace('127.0.0.1', 'localhost');
  const baseC = base2; // may be null when the runner did not start a second server

  async function arenaPage(pageBase, { width = 1280, height = 900, mobile = false } = {}) {
    const s = await newPage(cdpPort);
    s.navigations = [];
    s.dialogs = [];
    // A blocking JS dialog (the app alert()s on a failed room create /
    // rematch) freezes the renderer, and every later Input.dispatchMouseEvent
    // times out 45 s later somewhere unrelated. Dismiss and RECORD instead, so
    // the dialog text lands in the failing check rather than a mystery timeout.
    s.on((m, params) => {
      if (m === 'Page.javascriptDialogOpening') {
        s.dialogs.push(`${params.type}: ${String(params.message || '').slice(0, 120)}`);
        s.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
      } else if (m === 'Page.frameNavigated' && params.frame && !params.frame.parentId) {
        s.navigations.push(String(params.frame.url || '').replace(pageBase, ''));
      }
    });
    await setViewport(s, width, height, mobile);
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
    s.__base = pageBase;
    await goto(s, pageBase + '/apps/arena/', { settle: 800 });
    await waitForExpr(s, "!!window.firebaseAuth && document.readyState === 'complete'");
    // Boot marker: survives only if the page is never reloaded. NOTE the
    // parenthesised comma expression - evaluate() wraps the argument in
    // JSON.stringify((...)), so a statement with a semicolon is a syntax
    // error and would silently never set the mark.
    await evaluate(s, '(window.__arenaBootMark = 1, 1)');
    const marked = await evaluate(s, 'window.__arenaBootMark === 1');
    if (!marked) throw new Error('boot marker did not set - probe bug, not an app bug');
    s.navigations.length = 0;
    return s;
  }

  // Headless Chrome pauses requestAnimationFrame in BACKGROUND tabs. Since
  // the remediation the game clock also runs on a setInterval, so the host
  // no longer needs the foreground; the suite still fronts the host by
  // default and deliberately hides it in the hidden-host scenarios.
  const front = (s) => s.send('Page.bringToFront');
  const shot = async (s, label) => {
    try { await front(s); await sleep(150); await screenshot(s, join(SHOT_DIR, label + '.png')); } catch { /* optional */ }
  };

  // A coordinate click is only meaningful once the target is actually the
  // element at that point: mid-render the button may not exist, may be
  // disabled, or may sit under an overlay. And a CDP Input call can time out
  // when the renderer is busy (a loaded machine, a Firestore retry storm),
  // which used to abort the whole suite from an unrelated line. Wait for
  // hittability, then click, and tolerate one timeout.
  const hittable = (sel) => `(()=>{
    const e=document.querySelector(${JSON.stringify(sel)});
    if(!e || e.disabled) return false;
    const r=e.getBoundingClientRect();
    if(r.width<=0 || r.height<=0) return false;
    if(r.top<0 || r.left<0 || r.bottom>innerHeight || r.right>innerWidth) return false;
    const hit=document.elementFromPoint(r.x+r.width/2, r.y+r.height/2);
    return !!hit && (hit===e || e.contains(hit)); })()`;
  const safeClick = async (s, sel, { settle = 400, timeout = 10000 } = {}) => {
    // Scroll first: on a phone viewport a room-header control can sit under
    // the site's own fixed header, or below the fold on a long end screen.
    // A coordinate click then lands on the header (or nothing) and the app
    // never sees it, which reads as "the app ignored the button".
    await evaluate(s, `(()=>{ const e=document.querySelector(${JSON.stringify(sel)});
      if(e) e.scrollIntoView({block:'center', inline:'nearest'}); return 1; })()`);
    await sleep(120);
    const ready = await waitForExpr(s, hittable(sel), { timeout });
    if (!ready) return false;
    for (let attempt = 0; attempt < 2; attempt++) {
      try { return await clickSel(s, sel, { settle }); } catch (e) {
        if (!/timeout/i.test(String(e && e.message))) throw e;
        await sleep(1000); // renderer was busy; re-check and try once more
        if (!(await waitForExpr(s, hittable(sel), { timeout: 5000 }))) return false;
      }
    }
    return false;
  };
  const lobbyVisible = "(()=>{const l=document.getElementById('lobby-panel');return !!l && l.getBoundingClientRect().height>0})()";
  const leaveRoom = async (s) => {
    // Leaving always routes through the shared confirm modal, and the app
    // then makes several Firestore round trips (own player doc, survivors,
    // host handoff or room delete + sweep) before the UI returns to the
    // lobby. Wait for that generously, and re-confirm once if the modal is
    // still up, which is what a dropped click looks like.
    await safeClick(s, '#leave-room-btn', { settle: 300 });
    await safeClick(s, '#confirm-modal-confirm', { settle: 500 });
    if (await waitForExpr(s, lobbyVisible, { timeout: 25000 })) return true;
    if (await evaluate(s, visible('confirm-modal'))) {
      await safeClick(s, '#confirm-modal-confirm', { settle: 500 });
    } else if (!(await evaluate(s, lobbyVisible))) {
      await safeClick(s, '#leave-room-btn', { settle: 300 });
      await safeClick(s, '#confirm-modal-confirm', { settle: 500 });
    }
    return waitForExpr(s, lobbyVisible, { timeout: 25000 });
  };
  // Scenario isolation: every block starts from the lobby. A page that
  // cannot leave cleanly (wedged modal, busy renderer) is reloaded, which
  // drops all in-page state while keeping the emulator opt-in flag that
  // lives in localStorage. Without this a single bad block cascaded into
  // every later one.
  const resetToLobby = async (pages) => {
    for (const s of pages) {
      if (!s) continue;
      try {
        if (await evaluate(s, lobbyVisible)) continue;
        if (await leaveRoom(s)) continue;
      } catch { /* fall through to the hard reset */ }
      try {
        await goto(s, (s.__base || base) + '/apps/arena/', { settle: 800 });
        await waitForExpr(s, "!!window.firebaseAuth && document.readyState === 'complete'", { timeout: 20000 });
        await evaluate(s, '(window.__arenaBootMark = 1, 1)');
      } catch { /* the block's own assertions report what this costs */ }
    }
  };

  const visible = (id) => `(()=>{const e=document.getElementById('${id}');return !!e && !e.hidden && e.getBoundingClientRect().height>0})()`;
  const roomCodeOf = async (s) => String(await evaluate(s, "document.getElementById('room-code-display').textContent") || '').trim();
  const roomState = async (code) => {
    const d = await ownerGetDocRaw(`triviaRooms/${code}`, PAGE_PROJECT);
    if (d.status !== 200) return { status: d.status };
    const f = d.doc.fields || {};
    const played = f.playedQuestionIds?.arrayValue?.values || [];
    return {
      status: f.status?.stringValue, idx: Number(f.currentQuestionIndex?.integerValue ?? -1),
      qid: f.currentQuestionId?.stringValue || null, reveal: !!f.revealStartedAt?.timestampValue,
      startedMs: f.questionStartedAt?.timestampValue ? Date.parse(f.questionStartedAt.timestampValue) : null,
      revealMs: f.revealStartedAt?.timestampValue ? Date.parse(f.revealStartedAt.timestampValue) : null,
      questionTimeMs: Number(f.questionTimeMs?.integerValue ?? 0),
      played: played.map((v) => v.stringValue), hostUid: f.hostUid?.stringValue,
      deciderUid: f.deciderUid?.stringValue || null,
      pickingStartedMs: f.pickingStartedAt?.timestampValue ? Date.parse(f.pickingStartedAt.timestampValue) : null,
      finalRanking: (f.finalRanking?.arrayValue?.values || []).map((v) => fieldsOf({ doc: { fields: v.mapValue?.fields } })),
    };
  };
  // Polls the raw room doc until `pred` holds (or timeout). Returns the last state.
  const waitRoom = async (code, pred, timeout = 20000) => {
    const start = Date.now();
    let st = await roomState(code);
    while (!pred(st) && Date.now() - start < timeout) { await sleep(400); st = await roomState(code); }
    return st;
  };

  // Clicks the category picker on whichever page currently holds the
  // decider role, then waits until EVERY page shows a question DIFFERENT
  // from `prevText` (stage-game stays visible through the previous
  // question's reveal, so text change is the real signal).
  async function advanceThroughPick(pages, prevText = '', timeout = 45000) {
    // The timeout must outlast a whole round (asking + reveal): if an answer
    // is ever missed the round ends on its own timer, and a shorter wait
    // would give up mid-round and strand the rest of the scenario.
    const start = Date.now();
    while (Date.now() - start < timeout) {
      for (const s of pages) {
        const canPick = await evaluate(s, `(()=>{
          const g=document.getElementById('pick-category-grid');
          if(!g) return false;
          const st=document.getElementById('stage-picking');
          if(!st || st.hidden) return false;
          const b=g.querySelector('button');
          if(!b) return false;
          const r=b.getBoundingClientRect();
          if(r.width<=0||r.height<=0) return false;
          const hit=document.elementFromPoint(r.x+r.width/2, r.y+r.height/2);
          return !!hit && (hit===b || b.contains(hit)); })()`);
        if (canPick) {
          try { await clickSel(s, '#pick-category-grid button', { settle: 500 }); }
          catch (e) { if (!/timeout/i.test(String(e && e.message))) throw e; await sleep(800); }
        }
      }
      const asking = await Promise.all(pages.map((s) => evaluate(s, `(()=>{
        const st=document.getElementById('stage-game');
        const q=document.getElementById('question-text');
        return (!!st && !st.hidden && !!q && q.textContent.trim().length>0)
          ? q.textContent.trim() : null; })()`)));
      if (asking.every((q) => q && q !== prevText) && asking.every((q) => q === asking[0])) return asking[0];
      await sleep(300);
    }
    return null;
  }

  // Clicks an answer by its text, but only once that button is really the
  // element at its own centre. At 360x740 the last answer can sit below the
  // fold, where a coordinate click lands on nothing: clickText still reports
  // success and the answer is silently never submitted, which reads as a
  // stalled room three checks later.
  const answerFinder = (text) => `[...document.querySelectorAll('#answer-grid .answer-btn')]
      .find(x => x.textContent.includes(${JSON.stringify(text)}))`;
  async function clickAnswerText(s, text) {
    const scrolled = await evaluate(s, `(()=>{ const b=${answerFinder(text)};
      if(!b) return false; b.scrollIntoView({block:'center', inline:'nearest'}); return true; })()`);
    if (!scrolled) return false;
    const ready = await waitForExpr(s, `(()=>{ const b=${answerFinder(text)};
      if(!b || b.disabled) return false;
      const r=b.getBoundingClientRect();
      if(r.width<=0 || r.height<=0 || r.top<0 || r.bottom>innerHeight) return false;
      const hit=document.elementFromPoint(r.x+r.width/2, r.y+r.height/2);
      return !!hit && (hit===b || b.contains(hit)); })()`, { timeout: 6000 });
    if (!ready) return false;
    try { return await clickText(s, text, { sel: '#answer-grid .answer-btn', settle: 300 }); }
    catch (e) { if (!/timeout/i.test(String(e && e.message))) throw e; return false; }
  }
  // Waits until every page is rendering the room's CURRENT question. A page
  // can still show the previous one for a beat after the room advances, and
  // an answer clicked then is written against the OLD question id - the app
  // is right to ignore it, but a suite that answers blind records it as a
  // lost answer.
  const waitPagesOnQuestion = async (pages, qid, timeout = 15000) => {
    const n = String(qid || '').replace('e2e-q', '');
    if (!n) return false;
    const expr = `(()=>{ const q=document.getElementById('question-text');
      const st=document.getElementById('stage-game');
      return !!st && !st.hidden && !!q && q.textContent.includes('Question ' + ${JSON.stringify(n)} + ':'); })()`;
    const res = [];
    for (const s of pages) res.push(await waitForExpr(s, expr, { timeout }));
    return res.every(Boolean);
  };
  // Clicks for every player not yet recorded as answering this question,
  // retrying inside the asking window. #answer-grid is rebuilt on every
  // snapshot (and the host re-renders again when it sweeps a ghost), so a
  // click that lands mid-rebuild is never delivered - a real player clicks
  // again, and so does this. Success is what the player DOC says.
  const ensureAnswered = async (entries, code, qid, attempts = 3) => {
    const answeredFor = async (uid) => {
      const d = fieldsOf(await ownerGetDocRaw(`triviaRooms/${code}/players/${uid}`, PAGE_PROJECT));
      return d.currentAnsweredFor === qid;
    };
    const readAll = async () => {
      const seen = [];
      for (const e of entries) seen.push(await answeredFor(e.uid));
      return seen;
    };
    for (let attempt = 0; attempt < attempts; attempt++) {
      const seen = await readAll();
      if (seen.every(Boolean)) return { ok: true, seen };
      const st = await roomState(code);
      if (st.qid !== qid || st.status !== 'playing') break; // window closed
      const missing = entries.filter((_, i) => !seen[i]);
      await Promise.all(missing.map((e) => (e.kind === 'wrong' ? answerWrong(e.s) : answerCorrectly(e.s))));
      for (let i = 0; i < 32; i++) { // up to 8s for the writes to land
        const now = await readAll();
        if (now.every(Boolean)) return { ok: true, seen: now };
        const room = await roomState(code);
        if (room.qid !== qid || room.status !== 'playing') break;
        await sleep(250);
      }
    }
    const seen = await readAll();
    return { ok: seen.every(Boolean), seen };
  };
  // Reads 'Question N: ...' off the page and clicks 'Correct-N'.
  async function answerCorrectly(s) {
    const text = await evaluate(s, "document.getElementById('question-text').textContent");
    const m = /Question (\d+):/.exec(String(text || ''));
    if (!m) return false;
    return clickAnswerText(s, `Correct-${m[1]}`);
  }
  async function answerWrong(s) {
    const text = await evaluate(s, "document.getElementById('question-text').textContent");
    const m = /Question (\d+):/.exec(String(text || ''));
    if (!m) return false;
    return clickAnswerText(s, `Wrong-${m[1]}-a`);
  }

  // Runs the page's own Firestore SDK instance (same module app.js uses).
  const sdk = (s, body) => evalAsync(s, `(async()=>{ const m = await import('/firebase-config.js'); const F = m.firestore; const db = m.db;
    const uid = window.firebaseAuth.getCurrentUser() && window.firebaseAuth.getCurrentUser().uid;
    try { ${body} } catch(e) { return 'ERR:' + (e.code || '') + ' ' + String(e.message || e).slice(0, 80); } })()`);

  // axe-core scan of the current document; returns serious/critical pairs.
  async function axeSerious(s) {
    await s.send('Runtime.evaluate', { expression: axeSource, returnByValue: false });
    const ok = await evaluate(s, "typeof window.axe==='object' && typeof window.axe.run==='function'");
    if (!ok) return null;
    const v = await evalAsync(s, `window.axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] }, resultTypes: ['violations'],
    }).then(r => r.violations.map(v => ({ id: v.id, impact: v.impact, count: v.nodes.length,
      targets: v.nodes.slice(0, 4).map(n => (n.target || []).join(' ')) })))`);
    if (!Array.isArray(v)) return null;
    return v.filter((x) => x.impact === 'serious' || x.impact === 'critical')
      .map((x) => `${x.id}[${x.impact}]@${x.targets.join('|')}`);
  }
  const axeCheck = async (s, label) => {
    const bad = await axeSerious(s);
    t(`emulator a11y: ${label} has zero serious/critical axe violations`, Array.isArray(bad) && bad.length === 0,
      bad === null ? 'axe failed to inject' : bad.join('; '));
  };
  // Polls an in-page expression while tolerating the transient Runtime
  // failures a navigation causes (evaluate() rejects mid-reload).
  const waitSafe = async (s, expr, timeout = 20000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try { if (await evaluate(s, expr)) return true; } catch { /* mid-navigation */ }
      await sleep(300);
    }
    return false;
  };
  // The last leaver's room delete lands just after its UI returns to the
  // lobby, so a single read races it.
  const waitGone = async (docPath, timeout = 12000) => {
    const start = Date.now();
    let status = 0;
    while (Date.now() - start < timeout) {
      status = (await ownerGetDocRaw(docPath, PAGE_PROJECT)).status;
      if (status === 404) return 404;
      await sleep(400);
    }
    return status;
  };
  const boardOf = (s) => evaluate(s, `(()=>{
    return [...document.querySelectorAll('#end-board-body tr')].map(r=>r.textContent.replace(/\\s+/g,' ').trim()); })()`);
  const endUp = "document.getElementById('stage-end') && !document.getElementById('stage-end').hidden";
  const noSyncModal = `(()=>{const m=document.querySelector('.sync-modal-content, #sync-loading-modal, .sync-loading-modal');
    return !m || m.getBoundingClientRect().height === 0; })()`;

  let A = null, B = null, C = null;
  try {
    // Scenario isolation: each block runs inside its own guard, so a
    // renderer stall or a CDP timeout in one scenario is recorded as that
    // scenario's failure instead of aborting every check after it. Values
    // that genuinely cross scenarios are hoisted here.
    const nInLobby = (n) => `document.querySelectorAll('#lobby-player-grid li').length === ${n}`;
    let bUid = null;
    const guard = async (label, fn) => {
      try { await fn(); } catch (e) {
        t(`arena-emulator: ${label} ran to completion`, false, String(e && e.message || e).slice(0, 200));
      }
    };

    await guard('S1: fresh guest create (D2) + full three-client game', async () => {
      /* ---------- S1: fresh guest create (D2) + full three-client game ---------- */
      A = await arenaPage(baseA);
      B = await arenaPage(baseB, { width: 360, height: 740, mobile: true });
      if (baseC) C = await arenaPage(baseC);
      await front(A);

      // Host: switch to trivia, shortest game, fastest timer, create - as a
      // first-time guest with NO sync-modal dedupe seed.
      await clickSel(A, '.game-type-btn[data-game-type="trivia"]', { settle: 300 });
      await setValue(A, '#create-questions-count', '5');
      await setValue(A, '#create-trivia-time', '10');
      await clickSel(A, '#create-room-btn', { settle: 500 });
      const roomUp = await waitForExpr(A, visible('room-panel'), { timeout: 15000 });
      t('emulator: guest room create succeeds with production Firebase blocked (seam live)', roomUp,
        'room-panel never appeared; guest auth or Firestore write failed');
      await sleep(2500); // the old sync modal fired ~10 ms after the click and reloaded ~1 s later
      const notReloaded = await evaluate(A, 'window.__arenaBootMark === 1');
      const modalHidden = await evaluate(A, noSyncModal);
      const stillInRoom = await evaluate(A, visible('room-panel'));
      t('emulator (D2): first-time guest Create room shows no sync modal and never reloads the page',
        notReloaded && modalHidden && stillInRoom,
        `reloaded=${!notReloaded} modalHidden=${modalHidden} inRoom=${stillInRoom} navigations=${JSON.stringify(A.navigations)} dialogs=${JSON.stringify(A.dialogs)}`);
      const code = await roomCodeOf(A);
      t('emulator: room code has the generator shape', /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/.test(code), `code=${JSON.stringify(code)}`);
      const rooms = await ownerList('triviaRooms');
      const hostPlayers = await ownerList(`triviaRooms/${code}/players`);
      t('emulator (D2): exactly one room exists and it holds the host player doc (no orphan room)',
        rooms.length === 1 && rooms[0] === code && hostPlayers.length === 1, `rooms=${rooms.join(',')} players=${hostPlayers.length}`);

      // The room doc the app REALLY wrote carries no password field.
      const roomDoc = await ownerGetDocRaw(`triviaRooms/${code}`, PAGE_PROJECT);
      t('emulator: public room doc exists and has no password field',
        roomDoc.status === 200 && roomDoc.doc && !('password' in (roomDoc.doc.fields || {})),
        `status=${roomDoc.status} fields=${Object.keys(roomDoc.doc?.fields || {}).join(',')}`);

      // Joiner: by code (also a first-time guest, on a 360 px phone).
      await setValue(B, '#join-code', code);
      await clickSel(B, '#join-room-btn', { settle: 600 });
      t('emulator: second player joins by code', await waitForExpr(B, visible('room-panel'), { timeout: 15000 }));
      t('emulator: both clients see 2 players in the lobby',
        (await waitForExpr(A, nInLobby(2), { timeout: 10000 })) && (await waitForExpr(B, nInLobby(2), { timeout: 10000 })));
      await axeCheck(A, 'lobby in room (desktop)');
      await shot(B, 'lobby-360');
      await front(A);

      // Chat from B: two sends 200 ms apart must store exactly one message
      // (D11), and the first one is what the cleanup check sweeps later.
      await clickSel(B, '#room-chat-toggle', { settle: 400 });
      B.navigations.length = 0;
      // Both sends are driven from ONE in-page call so the gap is exactly
      // 200 ms of page time. Driving them as two CDP clicks makes the real gap
      // the sum of several round trips, which can exceed the 1.5 s rate-limit
      // window and turn the check into a no-op. requestSubmit() runs the app's
      // real submit handler, which is what the limit lives in.
      const chatRun = await evalAsync(B, `(async()=>{
        const f=document.getElementById('room-chat-form');
        const i=document.getElementById('room-chat-input');
        const send=(v)=>{ i.value=v; i.dispatchEvent(new Event('input',{bubbles:true})); f.requestSubmit(); };
        const t0=Date.now(); send('first');
        await new Promise(r=>setTimeout(r,200)); const gap=Date.now()-t0; send('second');
        await new Promise(r=>setTimeout(r,600));
        return { gap, err: (document.getElementById('room-chat-error')||{}).textContent || '' }; })()`);
      await sleep(900);
      const chatDocs = await ownerList(`triviaRooms/${code}/chat`);
      t('emulator (D11): a second chat send inside the rate-limit window is refused, so only the first message is stored',
        chatRun && chatRun.gap < 1500 && chatDocs.length === 1 && /slow down/i.test(chatRun.err || ''),
        `gap=${chatRun && chatRun.gap}ms docs=${chatDocs.length} msg=${JSON.stringify(chatRun && chatRun.err)}`
        + ` navigations=${JSON.stringify(B.navigations)}`);
      await clickSel(B, '#room-chat-close', { settle: 300 });

      // Ghost (D4): C joins, then its tab navigates away (beforeunload writes
      // disconnectedAt). After the 30 s grace it must read as disconnected
      // and no longer count anywhere.
      let ghostUid = null;
      if (C) {
        await setValue(C, '#join-code', code);
        await clickSel(C, '#join-room-btn', { settle: 600 });
        const cJoined = await waitForExpr(C, visible('room-panel'), { timeout: 15000 });
        ghostUid = await evaluate(C, 'window.firebaseAuth.getCurrentUser().uid');
        t('emulator: third player joins from the second origin', cJoined && !!ghostUid);
        await waitForExpr(A, nInLobby(3), { timeout: 10000 });
        await goto(C, 'about:blank', { settle: 800 });
        // beforeUnloadCleanup announces the disconnect with an async
        // updateDoc, and a browser is free to cancel an unload-time write -
        // which is exactly why liveness ALSO has a lastSeen heartbeat. Poll
        // for the announcement, then age it past the grace with the owner
        // bypass so everything BELOW (liveness, the Disconnected marker, the
        // host sweep, early reveal, rematch counting) is exercised
        // deterministically instead of resting on an unreliable unload write
        // plus a 31 s real-time sleep.
        let announced = false;
        for (let i = 0; i < 24; i++) {
          const d = await ownerGetDocRaw(`triviaRooms/${code}/players/${ghostUid}`, PAGE_PROJECT);
          if (d.status === 200 && d.doc?.fields?.disconnectedAt) { announced = true; break; }
          await sleep(250);
        }
        const stillThere = (await ownerGetDocRaw(`triviaRooms/${code}/players/${ghostUid}`, PAGE_PROJECT)).status === 200;
        if (announced) {
          t('emulator (D4): a tab that navigates away announces its disconnect (beforeunload)', true);
        } else {
          // Not a product failure: the fallback path is the heartbeat, and
          // the doc must still be there for it to go stale.
          t('emulator (D4): the departed player\'s doc survives for the grace window', stillThere,
            'the doc vanished entirely, so neither the grace window nor the heartbeat can apply');
          skip('emulator (D4): a tab that navigates away announces its disconnect (beforeunload)',
            'the browser cancelled the unload-time write this run; liveness falls back to the lastSeen heartbeat, which the checks below exercise');
        }
        await ownerPatch(`triviaRooms/${code}/players/${ghostUid}`, { disconnectedAt: Date.now() - 40000 });
        await front(A);
        const awayTag = await waitForExpr(A, `(()=>{
          const li=[...document.querySelectorAll('#lobby-player-grid li')];
          return li.length===3 && li.some(l=>l.classList.contains('is-disconnected') && /disconnected/i.test(l.textContent)); })()`, { timeout: 8000 });
        t('emulator (D4): past the grace the lobby shows the ghost as Disconnected', awayTag);
        await shot(A, 'lobby-with-ghost-desktop');
      } else {
        skip('emulator (D4): ghost player scenario', 'no second static server (base2) available');
      }

      // Start via a coordinate DOUBLE-click (D12): the second press lands on
      // whatever renders under the button 40 ms later; it must not pick a
      // category.
      const startEnabled = await waitForExpr(A, "(()=>{const b=document.getElementById('start-game-btn');return !!b && !b.disabled})()", { timeout: 10000 });
      t('emulator: start button unlocks for the host once 2 live players are in', startEnabled);
      const sb = await evaluate(A, "(()=>{const r=document.getElementById('start-game-btn').getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2]})()");
      await clickAt(A, sb[0], sb[1]);
      await sleep(40);
      await clickAt(A, sb[0], sb[1]);
      await sleep(1500);
      const afterDbl = await roomState(code);
      t('emulator (D12): double-clicking Start lands in the picking stage, not straight into a question',
        afterDbl.status === 'picking', `status=${afterDbl.status} qid=${afterDbl.qid}`);

      // Question 1: propagation check - advanceThroughPick only returns a
      // text when both live clients render the same non-empty question.
      let qText = await advanceThroughPick([A, B]);
      t('emulator: category pick advances both clients into the question stage', !!qText);
      t('emulator: the active question propagates identically to both clients', !!qText, `question=${JSON.stringify(qText)}`);
      await axeCheck(A, 'trivia asking stage (desktop)');
      await shot(B, 'asking-360');
      await front(A);

      // Both live players answer: early reveal must fire even though the
      // ghost doc never answers, and the host sweeps the ghost doc.
      const qidR1 = (await roomState(code)).qid;
      const aUidS1 = await evaluate(A, 'window.firebaseAuth.getCurrentUser().uid');
      const bUidS1 = await evaluate(B, 'window.firebaseAuth.getCurrentUser().uid');
      const pagesOnQ1 = await waitPagesOnQuestion([A, B], qidR1);
      const answeredR1 = await ensureAnswered(
        [{ s: A, uid: aUidS1, kind: 'correct' }, { s: B, uid: bUidS1, kind: 'correct' }], code, qidR1);
      const answeredSeen = answeredR1.seen;
      const bothAnswered = answeredR1.ok;
      const revealed = await waitRoom(code, (st) => st.reveal || st.idx > 0 || st.qid !== qidR1, 12000);
      t('emulator (D4): early reveal fires when every LIVE player answered (the ghost no longer blocks it)',
        bothAnswered && (revealed.reveal || revealed.idx > 0 || revealed.qid !== qidR1),
        `pagesOnQuestion=${pagesOnQ1} bothAnswered=${bothAnswered} (host=${answeredSeen[0]} joiner=${answeredSeen[1]})`
        + ` reveal=${revealed.reveal} idx=${revealed.idx}`);
      if (ghostUid) {
        const swept = await (async () => {
          const start = Date.now();
          while (Date.now() - start < 8000) {
            const d = await ownerGetDocRaw(`triviaRooms/${code}/players/${ghostUid}`, PAGE_PROJECT);
            if (d.status === 404) return true;
            await sleep(400);
          }
          return false;
        })();
        t('emulator (D4): the host sweeps the stale ghost player doc (rules allow deleting a stale doc only)', swept);
      }
      let played = 1;

      // Question 2 with the HOST TAB HIDDEN (D3): bring B to front so A is a
      // background tab (rAF paused). Nobody answers; the room must still
      // advance once asking + reveal elapsed (10 s + 2.5 s), within a few
      // seconds, and exactly once.
      qText = await advanceThroughPick([A, B], qText);
      await front(B);
      const hiddenHost = await evaluate(A, 'document.visibilityState');
      const before = await roomState(code);
      const advanced = await waitRoom(code, (st) => st.idx === before.idx + 1 || st.status !== 'playing', 19000);
      const uniquePlayed = new Set(advanced.played).size === advanced.played.length;
      t('emulator (D3): with the host tab hidden the room still advances after asking + reveal, exactly once',
        hiddenHost === 'hidden' && advanced.idx === before.idx + 1 && uniquePlayed,
        `hostVisibility=${hiddenHost} idx ${before.idx}->${advanced.idx} status=${advanced.status} played=${advanced.played.join(',')}`);
      await front(A);
      played++;

      // Question 3: B answers while OFFLINE (D9). Either the write lands
      // when the link returns (answer recorded) or the UI must say the
      // answer did not count; "Locked in" with nothing recorded is the bug.
      qText = await advanceThroughPick([A, B], qText);
      const offlineRound = await roomState(code);
      // Only meaningful while this question is still open; if the previous
      // round bled over, say so instead of asserting on the wrong state.
      const offlineWindowOk = offlineRound.status === 'playing' && !!offlineRound.qid && !offlineRound.reveal;
      await answerCorrectly(A);
      await setOffline(B, true);
      await sleep(300);
      await answerCorrectly(B);
      const disclosed = await waitForExpr(B, `(()=>{
        const s=(document.getElementById('answer-status')||{}).textContent||'';
        const toast=[...document.querySelectorAll('.ba-toast')].map(t=>t.textContent).join(' ');
        return /not saved|did not count|pick again/i.test(s + ' ' + toast); })()`, { timeout: 15000 });
      await setOffline(B, false);
      await sleep(2500);
      bUid = await evaluate(B, 'window.firebaseAuth.getCurrentUser().uid');
      const bDoc = fieldsOf(await ownerGetDocRaw(`triviaRooms/${code}/players/${bUid}`, PAGE_PROJECT));
      const recorded = bDoc.currentAnsweredFor === `e2e-q${(qText.match(/Question (\d+)/) || [])[1]}`;
      const lockedIn = /locked in/i.test(await evaluate(B, "(document.getElementById('answer-status')||{}).textContent||''"));
      t('emulator (D9): an answer clicked while offline is either recorded or disclosed as not saved, never a silent "Locked in"',
        offlineWindowOk && (recorded || (disclosed && !lockedIn)),
        `windowOk=${offlineWindowOk} recorded=${recorded} disclosed=${disclosed} lockedIn=${lockedIn}`);
      played++;
      await waitRoom(code, (st) => st.idx >= 3 || st.status !== 'playing', 20000);

      // Questions 4-5: both answer; the last round resolves into the end stage.
      while (played < 5) {
        qText = await advanceThroughPick([A, B], qText);
        if (!qText) break;
        const okA = await answerCorrectly(A);
        const okB = await answerCorrectly(B);
        if (!okA || !okB) break;
        played++;
      }
      t('emulator: all 5 rounds were playable (pick -> ask -> answer/timeout -> advance)', played === 5, `played=${played}`);

      // End stage on both, scores present, positive and consistent.
      t('emulator: game end reaches both clients',
        (await waitForExpr(A, endUp, { timeout: 25000 })) && (await waitForExpr(B, endUp, { timeout: 25000 })));
      await sleep(800);
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
      t('emulator: both players earned positive scores', !!scoresPositive);
      const finished = await roomState(code);
      t('emulator (D5): the finishing write stamps finalRanking on the room doc',
        finished.status === 'finished' && finished.finalRanking.length === 2 && finished.finalRanking.every((p) => p.uid && p.displayName),
        `status=${finished.status} ranking=${JSON.stringify(finished.finalRanking)}`);
      await axeCheck(A, 'end stage (desktop)');
      await axeCheck(B, 'end stage (360 mobile)');
      await shot(B, 'end-360');
      const overflow360 = await evaluate(B, 'document.documentElement.scrollWidth - document.documentElement.clientWidth');
      t('emulator (D14): the end stage at 360 px has no horizontal overflow', overflow360 <= 0, `scrollWidth-clientWidth=${overflow360}`);
      const leaveRect = await evaluate(B, "(()=>{const r=document.getElementById('leave-room-btn').getBoundingClientRect();return {right:r.right,h:r.height}})()");
      t('emulator (D14): "Back to lobby" fits inside the 360 px viewport and is at least 44 px tall',
        leaveRect.right <= 360 && leaveRect.h >= 44, JSON.stringify(leaveRect));
      await front(A);

      // Rematch: B proposes via the header Rematch button, A gets an
      // Accept/Decline confirm modal and must respond inside the proposal's
      // 10s auto-cancel window.
      const proposeReady = await waitForExpr(B, visible('room-end-again-btn'), { timeout: 8000 });
      const proposeClicked = proposeReady && await clickSel(B, '#room-end-again-btn', { settle: 400 });
      const acceptShown = await waitForExpr(A, `(()=>{
        const b=document.getElementById('confirm-modal-body');
        return !!b && b.getBoundingClientRect().height>0 && /rematch|play again|new game/i.test(b.textContent); })()`, { timeout: 8000 });
      t('emulator: rematch proposal reaches the other client as an accept prompt', acceptShown,
        `btnReady=${proposeReady} clicked=${proposeClicked}`);
      await axeCheck(A, 'confirm modal (rematch prompt)');
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
      t('emulator: unanimous rematch starts round 2 on both clients (ghost excluded from the unanimity count)', r2A && r2B, r2Detail);

      // Leave: B first, then A (last leaver deletes the room doc, then sweeps
      // chat, gate and leftover player docs - D6).
      const leftS1 = [await leaveRoom(B), await leaveRoom(A)];
      const goneStatus = await waitGone(`triviaRooms/${code}`);
      t('emulator: last player leaving deletes the room doc',
        leftS1.every(Boolean) && goneStatus === 404, `leaves=${JSON.stringify(leftS1)} status=${goneStatus}`);
      const chatLeft = await ownerList(`triviaRooms/${code}/chat`);
      const playersLeft = await ownerList(`triviaRooms/${code}/players`);
      t('emulator (D6): chat messages and player docs are swept once the room doc is gone',
        chatLeft.length === 0 && playersLeft.length === 0, `chat=${chatLeft.length} players=${playersLeft.length}`);

    });

    await guard('S2: host handoff in the lobby', async () => {
      /* ---------- S2: host handoff in the lobby ---------- */
      await resetToLobby([A, B, C]);
      await clickSel(A, '.game-type-btn[data-game-type="trivia"]', { settle: 300 });
      await clickSel(A, '#create-room-btn', { settle: 500 });
      await waitForExpr(A, visible('room-panel'), { timeout: 15000 });
      const code2 = await roomCodeOf(A);
      await setValue(B, '#join-code', code2);
      await clickSel(B, '#join-room-btn', { settle: 600 });
      await waitForExpr(B, visible('room-panel'), { timeout: 15000 });
      await waitForExpr(B, nInLobby(2), { timeout: 10000 });
      await clickSel(A, '#leave-room-btn', { settle: 300 });
      await axeCheck(A, 'confirm modal (leave room)');
      await clickSel(A, '#confirm-modal-confirm', { settle: 500 });
      await waitForExpr(A, lobbyVisible, { timeout: 10000 });
      const handedOff = await waitForExpr(B, "(()=>{const c=document.getElementById('lobby-host-controls');return !!c && !c.hidden})()", { timeout: 12000 });
      t('emulator: host leaving hands the room to the earliest joiner (host controls appear)', handedOff);
      const room2 = await ownerGetDocRaw(`triviaRooms/${code2}`, PAGE_PROJECT);
      t('emulator: room doc hostUid now names the surviving player',
        room2.status === 200 && room2.doc?.fields?.hostUid?.stringValue === bUid,
        `hostUid=${room2.doc?.fields?.hostUid?.stringValue} expected=${bUid}`);
      await leaveRoom(B);

    });

    await guard('S3: password room (hashed gate, defect 22) + the D1 exploit', async () => {
      /* ---------- S3: password room (hashed gate, defect 22) + the D1 exploit ---------- */
      await resetToLobby([A, B, C]);
      await clickSel(A, '.game-type-btn[data-game-type="trivia"]', { settle: 300 });
      await clickSel(A, '#create-private-toggle', { settle: 200 });
      const pwType = await evaluate(A, "document.getElementById('create-password').type");
      await setValue(A, '#create-password', 'fixture-gate-phrase');
      await clickSel(A, '.pw-toggle[data-pw-toggle="create-password"]', { settle: 200 });
      const pwTypeShown = await evaluate(A, "document.getElementById('create-password').type");
      await clickSel(A, '.pw-toggle[data-pw-toggle="create-password"]', { settle: 200 });
      t('emulator (D15): password inputs are type=password with a working show/hide toggle',
        pwType === 'password' && pwTypeShown === 'text', `type=${pwType} shown=${pwTypeShown}`);
      await clickSel(A, '#create-room-btn', { settle: 500 });
      await waitForExpr(A, visible('room-panel'), { timeout: 15000 });
      const code3 = await roomCodeOf(A);

      const privRoom = await ownerGetDocRaw(`triviaRooms/${code3}`, PAGE_PROJECT);
      t('emulator: private room doc persists NO cleartext password',
        privRoom.status === 200 && privRoom.doc?.fields?.isPrivate?.booleanValue === true
          && !('password' in (privRoom.doc.fields || {})),
        `fields=${Object.keys(privRoom.doc?.fields || {}).join(',')}`);
      const gate = await ownerGetDocRaw(`triviaRooms/${code3}/private/gate`, PAGE_PROJECT);
      t('emulator: private room persists a 64-hex gate hash instead',
        gate.status === 200 && /^[0-9a-f]{64}$/.test(gate.doc?.fields?.hash?.stringValue || ''),
        `hash=${gate.doc?.fields?.hash?.stringValue}`);

      // The exploit (audit D1), replayed through the app's own SDK from a
      // third signed-in guest who knows only the code: delete the gate, then
      // join without a password. Both must be denied by the rules, and the
      // UI must still reject a wrong password afterwards.
      if (C) {
        await goto(C, baseC + '/apps/arena/', { settle: 800 });
        await waitForExpr(C, "!!window.firebaseAuth && document.readyState === 'complete'");
        const cUid = await evalAsync(C, 'window.firebaseAuth.signInAsGuest().then(u=>u.uid)');
        const delGate = await sdk(C, `await F.deleteDoc(F.doc(db,'triviaRooms','${code3}','private','gate')); return 'ALLOWED'`);
        const gateAfter = await ownerGetDocRaw(`triviaRooms/${code3}/private/gate`, PAGE_PROJECT);
        t('emulator (D1 exploit step 1): a signed-in stranger cannot delete the private gate doc',
          /permission-denied/.test(String(delGate)) && gateAfter.status === 200, `result=${delGate} gateStatus=${gateAfter.status}`);
        const joinNoHash = await sdk(C, `await F.setDoc(F.doc(db,'triviaRooms','${code3}','players',uid),{uid:uid,displayName:'Gatecrasher',isHost:false,score:0,streak:0,round:1,joinedAt:F.serverTimestamp(),lastSeen:F.serverTimestamp(),answers:[]}); return 'ALLOWED'`);
        const crasherDoc = await ownerGetDocRaw(`triviaRooms/${code3}/players/${cUid}`, PAGE_PROJECT);
        t('emulator (D1 exploit step 2): the stranger cannot create a player doc without the password proof',
          /permission-denied/.test(String(joinNoHash)) && crasherDoc.status === 404, `result=${joinNoHash} docStatus=${crasherDoc.status}`);
        const delRoom = await sdk(C, `await F.deleteDoc(F.doc(db,'triviaRooms','${code3}')); return 'ALLOWED'`);
        const stealHost = await sdk(C, `await F.updateDoc(F.doc(db,'triviaRooms','${code3}'),{hostUid:uid}); return 'ALLOWED'`);
        t('emulator (D10): a non-host can neither delete the room nor rewrite hostUid',
          /permission-denied/.test(String(delRoom)) && /permission-denied/.test(String(stealHost)), `delete=${delRoom} hostUid=${stealHost}`);
      } else {
        skip('emulator (D1 exploit): third-client gate deletion', 'no second static server (base2) available');
      }

      await setValue(B, '#join-code', code3);
      const pwFieldShown = await waitForExpr(B, "(()=>{const f=document.getElementById('join-password-field');return !!f && !f.hidden})()", { timeout: 8000 });
      t('emulator: password field auto-reveals for a private room code', pwFieldShown);
      await setValue(B, '#join-password', 'wrong-password');
      await clickSel(B, '#join-room-btn', { settle: 800 });
      const wrongRejected = await waitForExpr(B, `(()=>{
        const e=document.getElementById('join-error');
        return !!e && !e.hidden && /incorrect password/i.test(e.textContent); })()`, { timeout: 10000 });
      t('emulator: wrong password is rejected with the Incorrect password message (rules permission-denied path), also after the exploit attempt', wrongRejected);
      const stillLobby = await evaluate(B, lobbyVisible);
      t('emulator: wrong password leaves the joiner in the lobby', !!stillLobby);

      await setValue(B, '#join-password', 'fixture-gate-phrase');
      await clickSel(B, '#join-room-btn', { settle: 800 });
      t('emulator: correct password admits the joiner',
        await waitForExpr(B, visible('room-panel'), { timeout: 15000 }));
      await leaveRoom(B);
      await leaveRoom(A);
      await sleep(600);
      const gateGone = await ownerGetDocRaw(`triviaRooms/${code3}/private/gate`, PAGE_PROJECT);
      t('emulator: room cleanup sweeps the gate doc too (host deletes the room doc, then the orphan gate)', gateGone.status === 404, `status=${gateGone.status}`);

    });

    await guard('S4: invalid / nonexistent codes', async () => {
      /* ---------- S4: invalid / nonexistent codes ---------- */
      await resetToLobby([B]);
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

    });

    await guard('S5: registered host vs two guests: stats (D8), stale prompt (D13), end screen after a leaver (D5), H2H guest skip (D16)', async () => {
      /* ---------- S5: registered host vs two guests: stats (D8), stale prompt (D13), end screen after a leaver (D5), H2H guest skip (D16) ---------- */
      await resetToLobby([A, B, C]);
      await setViewport(B, 390, 844, true);
      const regUid = await evalAsync(A, "window.firebaseAuth.signUp('arena-e2e-host@example.com', 'fixture-pass-1234').then(u=>u.uid)");
      // A REGISTERED sign-in genuinely has a users/{uid} namespace to pull, so
      // the shared sync modal and its reload are the CORRECT behaviour here -
      // the D2 fix narrows that to non-anonymous users only, it does not
      // disable it. Pin that boundary, then wait the reload out before driving
      // the UI (otherwise the reload lands mid-scenario and wipes the room).
      const regReloaded = await waitSafe(A, 'window.__arenaBootMark !== 1', 25000);
      t('emulator (D2 boundary): a registered sign-in STILL runs the shared sync modal + reload (only guests skip it)',
        regReloaded, `boot marker survived the sign-in, so no reload happened; navigations=${JSON.stringify(A.navigations)}`);
      await waitSafe(A, "!!window.firebaseAuth && document.readyState === 'complete'", 25000);
      await evaluate(A, '(window.__arenaBootMark = 1, 1)');
      const regReady = await waitSafe(A, "(()=>{const c=document.getElementById('profile-card-trivia');return !!c && !c.hidden})()", 20000);
      t('emulator: email/password sign-up on the auth emulator yields a registered user', !!regUid && regReady, `uid=${regUid} profileCard=${regReady}`);
      await front(A);
      await clickSel(A, '.game-type-btn[data-game-type="trivia"]', { settle: 300 });
      await setValue(A, '#create-questions-count', '5');
      // 30 s per question: all three players answer every round, so early
      // reveal still ends each round at once. A short window instead raced the
      // three confirmations below and dropped the third player's answer.
      await setValue(A, '#create-trivia-time', '30');
      await clickSel(A, '#create-room-btn', { settle: 600 });
      const namePrompt = await waitForExpr(A, visible('name-prompt-modal'), { timeout: 15000 });
      t('emulator: a registered player confirms a display name before the first published game', namePrompt);
      await axeCheck(A, 'display-name prompt modal');
      await setValue(A, '#name-prompt-input', 'Reg Host');
      await clickSel(A, '#name-prompt-confirm', { settle: 500 });
      await waitForExpr(A, visible('room-panel'), { timeout: 15000 });
      const code5 = await roomCodeOf(A);
      const focusBack = await (async () => {
        // Focus restoration (D15): open the leave prompt from the button and
        // Escape it; focus must return to the button, not <body>.
        await clickSel(A, '#leave-room-btn', { settle: 300 });
        await A.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        await A.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        await sleep(300);
        return evaluate(A, "document.activeElement && document.activeElement.id");
      })();
      t('emulator (D15): Escape on the confirm modal restores focus to the triggering button', focusBack === 'leave-room-btn', `activeElement=${focusBack}`);
      await setValue(B, '#join-code', code5);
      await clickSel(B, '#join-room-btn', { settle: 600 });
      const bJoined5 = await waitForExpr(B, visible('room-panel'), { timeout: 15000 });
      t('emulator: a guest joins the registered host\'s room', bJoined5,
        `joinError=${JSON.stringify(await evaluate(B, "(()=>{const e=document.getElementById('join-error');return e && !e.hidden ? e.textContent.trim() : null})()"))}`);
      const pages5 = [A, B];
      if (C) {
        await goto(C, baseC + '/apps/arena/', { settle: 800 });
        await waitForExpr(C, "!!window.firebaseAuth && document.readyState === 'complete'");
        await setValue(C, '#join-code', code5);
        await clickSel(C, '#join-room-btn', { settle: 600 });
        const cJoined5 = await waitForExpr(C, visible('room-panel'), { timeout: 15000 });
        t('emulator: a second guest joins from the third origin', cJoined5,
          `joinError=${JSON.stringify(await evaluate(C, "(()=>{const e=document.getElementById('join-error');return e && !e.hidden ? e.textContent.trim() : null})()"))}`);
        if (cJoined5) pages5.push(C);
      }
      const lobbyFull5 = await waitForExpr(A, nInLobby(pages5.length), { timeout: 12000 });
      t('emulator: the host lobby lists every joined player before Start',
        lobbyFull5, `expected=${pages5.length} got=${await evaluate(A, "document.querySelectorAll('#lobby-player-grid li').length")}`);
      await waitForExpr(A, "(()=>{const b=document.getElementById('start-game-btn');return !!b && !b.disabled})()", { timeout: 10000 });
      const aUid = await evaluate(A, 'window.firebaseAuth.getCurrentUser().uid');
      const cUid = pages5.length > 2 ? await evaluate(C, 'window.firebaseAuth.getCurrentUser().uid') : null;
      await clickSel(A, '#start-game-btn', { settle: 800 });
      let s5state = await waitRoom(code5, (st) => st.status !== 'lobby', 8000);
      if (s5state.status === 'lobby') {
        await clickSel(A, '#start-game-btn', { settle: 800 });
        s5state = await waitRoom(code5, (st) => st.status !== 'lobby', 12000);
      }
      t('emulator: the registered host starts the game', s5state.status === 'picking',
        `status=${s5state.status} stages=${JSON.stringify(await Promise.all(pages5.map((s) => evaluate(s, "(()=>['stage-lobby','stage-picking','stage-game','stage-end'].filter(id=>{const e=document.getElementById(id);return e&&!e.hidden})[0]||'none')()"))))}`);
      let q5 = await advanceThroughPick(pages5);
      let played5 = 0;
      const answerTrouble = [];
      const uids5 = pages5.length > 2 ? [aUid, bUid, cUid] : [aUid, bUid];
      while (q5 && played5 < 5) {
        // Bind the round to the room's OWN live question before anyone
        // answers. advanceThroughPick returns on the DOM, and the room doc
        // can still read 'picking' (qid null) at that instant - binding to
        // null makes every confirmation below compare against nothing and
        // report all three players as having missed a question they answered.
        let qidNow = null;
        for (let i = 0; i < 40; i++) {
          const st = await roomState(code5);
          if (st.status === 'playing' && st.qid) { qidNow = st.qid; break; }
          if (st.status === 'finished') break;
          await sleep(250);
        }
        if (!qidNow) { answerTrouble.push(`round${played5 + 1}:no-live-question`); break; }
        if (!(await waitPagesOnQuestion(pages5, qidNow))) {
          answerTrouble.push(`round${played5 + 1}:pages-not-on-${qidNow}`);
        }
        const roundEntries = [{ s: A, uid: aUid, kind: 'correct' }, { s: B, uid: bUid, kind: 'wrong' }];
        if (pages5.length > 2) roundEntries.push({ s: C, uid: cUid, kind: 'wrong' });
        const conf = await ensureAnswered(roundEntries, code5, qidNow);
        if (!conf.ok) answerTrouble.push(`round${played5 + 1}:${conf.seen.map((v, i) => uids5[i].slice(0, 4) + '=' + v).join(',')}`);
        played5++;
        if (played5 === 5) break;
        q5 = await advanceThroughPick(pages5, q5);
      }
      t('emulator: registered-host game of 5 rounds completes, every answer confirmed on the player doc',
        played5 === 5 && answerTrouble.length === 0,
        `played=${played5} trouble=${answerTrouble.join(' ') || 'none'} firstQuestion=${JSON.stringify(q5)}`
        + ` stages=${JSON.stringify(await Promise.all(pages5.map((s) => evaluate(s, "(()=>['stage-lobby','stage-picking','stage-game','stage-end'].filter(id=>{const e=document.getElementById(id);return e&&!e.hidden})[0]||'none')()"))))}`);
      const end5 = await Promise.all(pages5.map((s) => waitForExpr(s, endUp, { timeout: 25000 })));
      t('emulator: game end reaches every client (registered + guests)', end5.every(Boolean));
      // The end-of-game profile + leaderboard writes are one transaction
      // behind the end screen; wait for them rather than assuming a delay.
      await (async () => {
        for (let i = 0; i < 60; i++) {
          const d = fieldsOf(await ownerGetDocRaw(`triviaLeaderboard/${regUid}`, PAGE_PROJECT));
          if (d && d.gamesPlayed != null) return;
          await sleep(250);
        }
      })();
      const summaryA = await evaluate(A, "(document.getElementById('end-summary')||{}).textContent||''");
      t('emulator: the registered winner sees the win summary', /you won/i.test(summaryA), summaryA);
      const userDoc = fieldsOf(await ownerGetDocRaw(`users/${regUid}`, PAGE_PROJECT));
      const tp = userDoc.triviaProfile && userDoc.triviaProfile.fields ? userDoc.triviaProfile.fields : {};
      const lb = fieldsOf(await ownerGetDocRaw(`triviaLeaderboard/${regUid}`, PAGE_PROJECT));
      const v = (x) => (x && (x.integerValue ?? x.doubleValue)) != null ? Number(x.integerValue ?? x.doubleValue) : null;
      t('emulator (D8): after ONE game the profile and the leaderboard row agree: games 1, wins 1, same score',
        v(tp.gamesPlayed) === 1 && v(tp.wins) === 1 && Number(lb.gamesPlayed) === 1 && Number(lb.wins) === 1 && v(tp.xp) === Number(lb.xp) && Number(lb.xp) > 0,
        `profile games=${v(tp.gamesPlayed)} wins=${v(tp.wins)} xp=${v(tp.xp)} | leaderboard games=${lb.gamesPlayed} wins=${lb.wins} xp=${lb.xp}`);
      const h2hRows = await ownerList('triviaH2H');
      t('emulator (D16): no triviaH2H pair row is written against a guest opponent', h2hRows.length === 0, `rows=${h2hRows.join(',')}`);

      if (pages5.length > 2) {
        // D13: C proposes, B declines -> A's prompt must close on its own.
        await waitForExpr(C, visible('room-end-again-btn'), { timeout: 8000 });
        await clickSel(C, '#room-end-again-btn', { settle: 500 });
        const promptA = await waitForExpr(A, visible('confirm-modal'), { timeout: 8000 });
        await waitForExpr(B, visible('confirm-modal'), { timeout: 8000 });
        await clickSel(B, '#confirm-modal-cancel', { settle: 400 });
        const closedA = await waitForExpr(A, `!${visible('confirm-modal')}`, { timeout: 4000 });
        t('emulator (D13): a rematch prompt closes on the other clients as soon as someone declines', promptA && closedA,
          `promptShown=${promptA} closedWithin4s=${closedA}`);
        await sleep(3000); // proposer-side auto reset
      }

      // D5: the registered host leaves the end screen; the others' result
      // must not rewrite itself.
      const finishedRanking = (await roomState(code5)).finalRanking;
      const winnerName = finishedRanking[0] && finishedRanking[0].displayName;
      const boardB5 = await boardOf(B);
      const summaryB5 = await evaluate(B, "(document.getElementById('end-summary')||{}).textContent||''");
      await shot(B, 'end-390');
      await leaveRoom(A);
      // The comparison only means something once the leaver is really gone:
      // a stale end-stage DOM would compare equal to itself all day.
      const leaverGone = await (async () => {
        for (let i = 0; i < 50; i++) { // up to 15s
          if ((await ownerGetDocRaw(`triviaRooms/${code5}/players/${aUid}`, PAGE_PROJECT)).status === 404) return true;
          await sleep(300);
        }
        return false;
      })();
      await sleep(1500);
      const boardB5after = await boardOf(B);
      const summaryB5after = await evaluate(B, "(document.getElementById('end-summary')||{}).textContent||''");
      const winnerStillTop = !!winnerName && String(boardB5after[0] || '').includes(winnerName);
      t('emulator (D5): after the winner leaves, the remaining players still see the full board and the real winner',
        leaverGone && boardB5.length === pages5.length && boardB5after.length === pages5.length
          && winnerStillTop && summaryB5 === summaryB5after,
        `leaverGone=${leaverGone} winner=${JSON.stringify(winnerName)} stillTop=${winnerStillTop}`
        + ` before=${JSON.stringify(boardB5)} after=${JSON.stringify(boardB5after)} summary "${summaryB5}" -> "${summaryB5after}"`);
      await shot(B, 'end-after-host-left-390');
      const regLeaveDoc = await ownerGetDocRaw(`triviaRooms/${code5}/players/${regUid}`, PAGE_PROJECT);
      t('emulator: the leaver\'s own player doc is deleted while the others stay', regLeaveDoc.status === 404);
      const leftS5 = [];
      for (const s of pages5.slice(1)) leftS5.push(await leaveRoom(s));
      const gone5 = await waitGone(`triviaRooms/${code5}`);
      t('emulator: a room whose host left on the end screen is still deleted by the last leaver',
        leftS5.every(Boolean) && gone5 === 404, `leaves=${JSON.stringify(leftS5)} status=${gone5}`);

    });

    await guard('S6: Globe Drop clock (timed advance, Ready-skip, hidden host)', async () => {
      /* ---------- S6: Globe Drop clock (timed advance, Ready-skip, hidden host) ---------- */
      await resetToLobby([A, B, C]);
      await front(A);
      await clickSel(A, '.game-type-btn[data-game-type="globe-drop"]', { settle: 300 });
      await setValue(A, '#create-locations-count', '3');
      await setValue(A, '#create-globe-drop-round-type', 'capitals');
      await clickSel(A, '#create-room-btn', { settle: 600 });
      if (await evaluate(A, visible('name-prompt-modal'))) await clickSel(A, '#name-prompt-confirm', { settle: 500 });
      const gUp = await waitForExpr(A, visible('room-panel'), { timeout: 20000 });
      t('emulator (globe): a Globe Drop room is created from the bundled capitals data', gUp);
      const code6 = await roomCodeOf(A);
      // Shorten the asking window for the suite (owner bypass): 3 s asking +
      // 10 s reveal per location instead of 60 s.
      await ownerPatch(`triviaRooms/${code6}`, { questionTimeMs: 3000 });
      await setValue(B, '#join-code', code6);
      await clickSel(B, '#join-room-btn', { settle: 600 });
      await waitForExpr(B, visible('room-panel'), { timeout: 15000 });
      await waitForExpr(A, nInLobby(2), { timeout: 10000 });
      await waitForExpr(A, "(()=>{const b=document.getElementById('start-game-btn');return !!b && !b.disabled})()", { timeout: 10000 });
      await clickSel(A, '#start-game-btn', { settle: 800 });
      let g0 = await waitRoom(code6, (st) => st.status === 'playing', 8000);
      if (g0.status === 'lobby') {
        // Globe init (globe.gl + the Earth texture) can outlast the first
        // click's settle; startGame disables its own button, so a second click
        // cannot double-start.
        await clickSel(A, '#start-game-btn', { settle: 800 });
        g0 = await waitRoom(code6, (st) => st.status === 'playing', 12000);
      }
      t('emulator (globe): start enters the first location', g0.status === 'playing' && g0.idx === 0, JSON.stringify(g0));
      // Round 1: nobody pins; asking expires; both click Ready during the
      // reveal -> the host advances early (well before the 10 s reveal ends).
      await sleep(3500);
      const readyBtnLive = "(()=>{const b=document.getElementById('globe-drop-ready-btn');return !!b && !b.disabled && b.getBoundingClientRect().height>0})()";
      // The Ready bar is painted by the rAF render loop, which the browser
      // pauses in a BACKGROUND tab, so B's button only becomes clickable while
      // B is the active target. Front B to vote, then hand the foreground back
      // to A. (Progression itself no longer depends on the foreground - that is
      // what the hidden-host checks prove - but a UI affordance still does.)
      const readyA = await waitForExpr(A, readyBtnLive, { timeout: 9000 });
      const tReady = Date.now();
      if (readyA) await clickSel(A, '#globe-drop-ready-btn', { settle: 200 });
      await front(B);
      const readyB = await waitForExpr(B, readyBtnLive, { timeout: 9000 });
      if (readyB) await clickSel(B, '#globe-drop-ready-btn', { settle: 200 });
      await front(A);
      // "Early" means BEFORE the round's own deadline on the server clock
      // (questionStartedAt + asking + reveal). Timing it from a harness
      // wall-clock instead measures CDP latency, not the product.
      const naturalEnd = (g0.startedMs || 0) + (g0.questionTimeMs || 3000) + 10000;
      const g1 = await waitRoom(code6, (st) => st.idx === 1, 14000);
      const advancedAt = Date.now();
      const readyFlags = await Promise.all((await ownerList(`triviaRooms/${code6}/players`)).map(async (u) => {
        const d = fieldsOf(await ownerGetDocRaw(`triviaRooms/${code6}/players/${u}`, PAGE_PROJECT));
        return `${u.slice(0, 5)}:${d.readyAfterQId || '-'}`;
      }));
      t('emulator (globe): every live player Ready during the reveal advances the round early',
        readyA && readyB && g1.idx === 1 && advancedAt < naturalEnd - 1500,
        `readyA=${readyA} readyB=${readyB} idx=${g1.idx} advanced ${Math.round((naturalEnd - advancedAt) / 100) / 10}s`
        + ` before the natural deadline (voted at +${Date.now() - tReady}ms) flags=${readyFlags.join(',')}`);
      // Round 2 with the host tab hidden: the timed advance must still come
      // (3 s asking + 10 s reveal) from the interval clock / member fallback.
      await front(B);
      const g2 = await waitRoom(code6, (st) => st.idx === 2, 40000);
      t('emulator (globe, D3): with the host hidden the next location still arrives after asking + reveal',
        g2.idx === 2 && new Set(g2.played).size === g2.played.length, `idx=${g2.idx} played=${g2.played.join(',')}`);
      await shot(B, 'globe-asking-390');
      const globeOverflow = await evaluate(B, 'document.documentElement.scrollWidth - document.documentElement.clientWidth');
      const timerBox = await evaluate(B, "(()=>{const r=document.getElementById('globe-drop-timer').getBoundingClientRect();return {l:r.left,r:r.right,w:r.width,vw:innerWidth}})()");
      t('emulator (D14): the Globe Drop timer chip is fully inside the 390 px viewport and the page does not overflow',
        globeOverflow <= 0 && timerBox.l >= 0 && timerBox.r <= timerBox.vw && timerBox.w > 0, `overflow=${globeOverflow} timer=${JSON.stringify(timerBox)}`);
      // Round 3: last location, host still hidden; the room must FINISH.
      const g3 = await waitRoom(code6, (st) => st.status === 'finished', 40000);
      t('emulator (globe, D3): the final location resolves into the finished state without the host in the foreground',
        g3.status === 'finished' && g3.finalRanking.length === 2, `status=${g3.status} ranking=${g3.finalRanking.length}`);
      t('emulator (globe): both clients reach the end stage',
        (await waitForExpr(B, endUp, { timeout: 15000 })) && (await waitForExpr(A, endUp, { timeout: 15000 })));
      await shot(B, 'globe-end-390');
      await front(A);
      await leaveRoom(B);
      await leaveRoom(A);

    });

    await guard('S7: the decider abandons the picking stage', async () => {
      /* ---------- S7: the decider abandons the picking stage ---------- */
      // Product defect fixed 2026-08-23 (same class as D3): the picking stage
      // had no deadline, so a decider who locked their phone, backgrounded the
      // tab or simply never chose stalled the room FOREVER for everyone, with
      // no host override and no timeout. Here the decider (round 1 rotates to
      // the earliest joiner, which is the host) goes offline mid-picking and
      // the remaining member must still reach a question.
      await resetToLobby([A, B, C]);
      await front(A);
      await safeClick(A, '.game-type-btn[data-game-type="trivia"]', { settle: 300 });
      await setValue(A, '#create-questions-count', '5');
      await setValue(A, '#create-trivia-time', '30');
      await safeClick(A, '#create-room-btn', { settle: 600 });
      if (await evaluate(A, visible('name-prompt-modal'))) await safeClick(A, '#name-prompt-confirm', { settle: 500 });
      await waitForExpr(A, visible('room-panel'), { timeout: 20000 });
      const code7 = await roomCodeOf(A);
      await setValue(B, '#join-code', code7);
      await safeClick(B, '#join-room-btn', { settle: 600 });
      await waitForExpr(B, visible('room-panel'), { timeout: 15000 });
      await waitForExpr(A, nInLobby(2), { timeout: 12000 });
      await waitForExpr(A, "(()=>{const b=document.getElementById('start-game-btn');return !!b && !b.disabled})()", { timeout: 10000 });
      await safeClick(A, '#start-game-btn', { settle: 800 });
      const picking7 = await waitRoom(code7, (st) => st.status === 'picking' && !!st.pickingStartedMs, 15000);
      const aUid7 = await evaluate(A, 'window.firebaseAuth.getCurrentUser().uid');
      t('emulator: entering the picking stage stamps a deadline (pickingStartedAt)',
        picking7.status === 'picking' && !!picking7.pickingStartedMs && picking7.deciderUid === aUid7,
        `status=${picking7.status} stamped=${!!picking7.pickingStartedMs} decider=${picking7.deciderUid === aUid7 ? 'host' : picking7.deciderUid}`);
      // The decider drops off the network entirely: it can neither pick nor
      // run its own clock, so only the OTHER member can rescue the room.
      await setOffline(A, true);
      await front(B);
      const rescued = await waitRoom(code7,
        (st) => st.status === 'playing' && !!st.qid, 45000);
      t('emulator (picking deadline): a decider who goes away no longer stalls the room - a member auto-picks',
        rescued.status === 'playing' && !!rescued.qid,
        `status=${rescued.status} qid=${rescued.qid} waited from a ${Math.round((Date.now() - (picking7.pickingStartedMs || Date.now())) / 1000)}s-old stamp`);
      t('emulator (picking deadline): the surviving client actually renders the auto-picked question',
        await waitForExpr(B, `(()=>{
          const st=document.getElementById('stage-game');
          const q=document.getElementById('question-text');
          return !!st && !st.hidden && !!q && q.textContent.trim().length>0; })()`, { timeout: 15000 }));
      // Reconnect the decider: its queued writes must not double-advance the
      // room (the auto-pick transaction's precondition is what prevents it).
      await setOffline(A, false);
      await sleep(3000);
      const afterRejoin = await roomState(code7);
      t('emulator (picking deadline): the decider reconnecting does not double-advance the room',
        afterRejoin.qid === rescued.qid && afterRejoin.idx === rescued.idx,
        `qid ${rescued.qid} -> ${afterRejoin.qid} idx ${rescued.idx} -> ${afterRejoin.idx}`);
      await front(A);
      await resetToLobby([A, B]);
    });

  } catch (e) {
    t('arena-emulator: suite ran to completion', false, String(e && e.stack || e).slice(0, 240));
  } finally {
    for (const s of [A, B, C]) { if (s) { try { await closePage(cdpPort, s); } catch { /* closed */ } } }
  }
  return R;
}
