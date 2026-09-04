/*
 * Brain Arena - main app module.
 *
 * Wiring:
 *   - Auth: window.firebaseAuth (set up by ../../firebase-config.js, loaded
 *     as a module earlier in the page; we wait on its ready promise).
 *   - Firestore: import the SDK directly from the gstatic CDN. The db
 *     instance is already initialized inside firebase-config.js - we import
 *     `db` from there so we don't initialize a second app.
 *   - Pure helpers: window.BrainArena.{Config,Scoring,RoomState} from the
 *     three classic scripts loaded above this module.
 *
 * Firestore data model:
 *   triviaRooms/{code}
 *     { code, hostUid, status: 'lobby'|'playing'|'finished',
 *       isPrivate, currentQuestionIndex,
 *       questionStartedAt: serverTimestamp, totalQuestions, packId,
 *       questions: [...{id,category,question,choices,correctIndex}],
 *       createdAt, finishedAt }
 *     (legacy rooms created before 2026-08-15 may still carry a
 *      cleartext `password` field; new rooms never do - see
 *      triviaRooms/{code}/private/gate below)
 *   triviaRooms/{code}/private/gate
 *     { hash } - SHA-256(password + ':' + code), readable by NO client;
 *     firestore.rules compares a joiner's member-doc gateHash to it via
 *     get(). Solo/daily rooms store a random hash nobody can derive.
 *   triviaRooms/{code}/players/{uid}
 *     { uid, displayName, isHost, score, streak, joinedAt,
 *       currentAnswerIndex, currentAnswerAt, lastSeen,
 *       answers: [{questionId, correct, timeLeftMs, totalMs, category, points}] }
 *
 *   users/{uid}.triviaProfile
 *     { displayName, xp, gamesPlayed, wins, customPack, lastPlayedAt }
 *
 *   triviaLeaderboard/{uid}  (denormalized for cheap reads)
 *     { uid, displayName, xp, gamesPlayed, wins, lastPlayedAt }
 */

// All Firestore SDK access flows through firebase-config.js (the single
// init point) so we don't import the SDK URL directly here - the
// `no app file imports Firestore directly` invariant test forbids it.
// Path: this file is /apps/arena/js/app.js, so we go up three
// directories (js → arena → apps → repo root).
import { db, firestore } from '../../../firebase-config.js';
const {
    doc, collection, getDoc, getDocs, setDoc, updateDoc, deleteDoc, addDoc,
    onSnapshot, query, orderBy, limit, serverTimestamp, runTransaction,
    increment, deleteField
} = firestore;

/**
 * Analytics shim. Resolved at call time (the shared helper is installed by a
 * deferred classic script, this is a module) and never throws. Arena is
 * multiplayer, so the rule is stricter than elsewhere: no room codes, no
 * display names, no uids - a room code is a shared secret that lets anyone
 * join, and it must not leave the app.
 */
function track(method, ...args) {
    try {
        const a = typeof window !== 'undefined' ? window.shevatoAnalytics : null;
        if (a && typeof a[method] === 'function') a[method](...args);
    } catch (e) {
        /* analytics must never break the app */
    }
}

const Config = window.BrainArena.Config;
const Scoring = window.BrainArena.Scoring;
const Feedback = window.BrainArena.Feedback;
const Chat = window.BrainArena.Chat;
const RoomState = window.BrainArena.RoomState;
const RoomGate = window.BrainArena.RoomGate;
const LiveQuestions = window.BrainArena.LiveQuestions;
const GlobeDropScoring = window.BrainArena.GlobeDropScoring;
const GlobeDropLocations = window.BrainArena.GlobeDropLocations;
const GlobeDropDaily = window.BrainArena.GlobeDropDaily;

/* =====================================================================
 * State
 * ===================================================================== */

const state = {
    user: null,                  // Firebase user (or null)
    profile: null,               // users/{uid}.triviaProfile (or null)
    activeView: 'play',          // 'play' | 'leaderboard' | 'profile'
    customPack: null,            // user's saved custom pack

    // Room state
    roomCode: null,              // current room code, if any
    roomData: null,              // latest room doc snapshot
    roomPlayers: [],             // latest player list
    roomUnsubs: [],              // listener unsubs to clean up on leave
    // Set when viewing a finished room in read-only mode (e.g. arriving via
    // ?postMatch=ABCDE). URL syncer keys on this to write postMatch=… instead
    // of room=…, which avoids re-join attempts when the link is shared.
    postMatchCode: null,

    // Answer tracking
    submittedQuestionId: null,   // id of question we last answered
    currentAnswers: [],          // local detailed-stats record for this game

    // Clock guards, keyed by `${round}:${index}:${questionId}` (see
    // clockKey) so a rematch that re-deals the same question ids can never
    // be blocked by a guard from the previous round. earlyRevealForQuestion
    // fires the early-reveal write exactly once per question;
    // earlyAdvanceForQuestion the advance/finish write (host, or any member
    // once the window has elapsed plus the fallback slack).
    earlyRevealForQuestion: null,
    earlyAdvanceForQuestion: null,
    autoPickForQuestion: null,
    // Presence heartbeat + host-independent clock (audit D3/D4).
    heartbeatTimer: null,
    clockTimer: null,
    onVisibility: null,
    sweptUids: {},
    // Sorted uid list of the currently-live players; a change re-renders.
    liveSignature: null,
    // End-screen snapshot: the players present when the game finished, kept
    // even after a leaver's doc is deleted (audit D5), keyed by round.
    finalPlayers: [],
    finalPlayersRound: null,

    // Lobby - which game type the create-card is currently configured for.
    // Defaults to globe-drop because it's the headline mode now.
    selectedGameType: 'globe-drop',

    // GlobeDrop-specific runtime state (only populated while a GlobeDrop room
    // is active). globe = globe.gl/Three.js scene wrapper; the layers are
    // declarative (hand them the full set on every update), but the datum
    // objects themselves are reused - see globeMarkers.
    globe: null,
    globeResizeAttached: false,          // guard so the ResizeObserver attaches once
    globeResizeObserver: null,           // RO handle (cleaned up in teardownMap)
    lastGlobeWidth: 0,                   // last applied canvas width (RO short-circuit)
    lastGlobeHeight: 0,                  // last applied canvas height (RO short-circuit)
    globeTexturePreloaded: false,        // guard so the lobby prefetch fires once
    globeTapHintShown: false,            // first-use tap hint shown this session
    standingsCollapsed: true,            // mobile: live-standings board collapsed
    standingsToggleQId: null,            // question id the collapse state was reset for
    pendingGuess: null,                  // { lat, lng } selected but not yet submitted
    lastRenderedMapQuestion: null,       // location id currently shown on the globe
    lastRevealedMapQuestion: null,       // '{locId}:local' or '{locId}:global' - what we've drawn
    lastCameraTarget: null,              // '{locId}:{lat},{lng}' - short-circuits redundant pointOfView calls
    revealChoreoForQuestion: null,       // location id whose reveal sequence has already played
    globeGestureAt: 0,                   // perf timestamp of the last pointer gesture we resolved ourselves
    triviaFetchedFor: null,              // location id we've already kicked off a Wikipedia fetch for

    // Timer rAF handle
    timerRaf: null,

    // Leaderboard
    leaderboardEntries: [],
    // Active sort for the global leaderboard table - `{ key, dir }`.
    // Click on a header toggles dir for the same key, or sets the new
    // key with its data-sort-default (defaults to 'desc' if absent).
    leaderboardSort: { key: 'avgScore', dir: 'desc' },
    leaderboardUnsub: null,

    // Daily Globe Drop leaderboard - same panel, separate subscription
    // because it lives in its own collection and resets at UTC midnight.
    dailyLeaderboardEntries: [],
    dailyLeaderboardUnsub: null,

    // Live listener on users/{uid} so profile changes (stats, saved
    // custom pack) propagate to the UI without a reload.
    profileUnsub: null,

    // Room code parsed from `?room=ABCDE` at boot, queued behind sign-in.
    // applyAuthState picks it up the first time it sees a signed-in user.
    pendingRoomCode: null,
    // Same idea for `?postMatch=ABCDE` - a read-only deep link to a
    // finished room's recap. Auth-gated since Firestore reads need it.
    pendingPostMatchCode: null,

    // True if the signed-in user has a doc at /leaderboardAdmins/{uid}.
    // Drives the trash-icon affordance on leaderboard rows. Re-checked
    // on every auth state change.
    isLeaderboardAdmin: false
};

/* =====================================================================
 * DOM helpers
 * ===================================================================== */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function show(el) { if (el) el.hidden = false; }
function hide(el) { if (el) el.hidden = true; }
function setText(el, text) { if (el) el.textContent = text; }
function setClass(el, cls, on) { if (el) el.classList.toggle(cls, !!on); }

// Escape for HTML, INCLUDING both quote characters.
//
// The `div.textContent -> div.innerHTML` trick escapes &, < and > and leaves
// " and ' alone, because a text node does not need them escaped. That is only
// safe while every interpolation lands in element CONTENT. It does not here:
// another player's display name is interpolated into `title="..."` on the
// podium and into `data-name="..."` in the recap, and display names are only
// trimmed and length-capped, never quote-stripped, so a value carrying a double quote closes
// the attribute and the rest of the string becomes markup of the author's
// choosing. Escape all five, like the shared assets/js/escape-html.js.
function escapeHtml(text) {
    return String(text == null ? '' : text).replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
}

/**
 * Push a transient toast onto the right-bottom stack. Auto-dismisses
 * after the CSS animation runs out (~4 s total). Used for "X submitted"
 * presence pings and chat-message previews. Pass `icon` for a leading
 * emoji; pass `key` to deduplicate rapid-fire identical toasts.
 */
const recentToastKeys = new Map();
function showToast(message, { icon = '', key = null, ttlMs = 4000 } = {}) {
    if (!message) return;
    if (key) {
        // Throttle: same key within the last second is dropped silently
        // so a flood of identical events (e.g. a snapshot replay) doesn't
        // bury the screen in copies of the same notification.
        const last = recentToastKeys.get(key) || 0;
        const now = Date.now();
        if (now - last < 1000) return;
        recentToastKeys.set(key, now);
    }
    const stack = document.getElementById('ba-toast-stack');
    if (!stack) return;
    const li = document.createElement('li');
    li.className = 'ba-toast';
    li.innerHTML = (icon ? `<span class="ba-toast-icon" aria-hidden="true">${escapeHtml(icon)}</span>` : '')
        + escapeHtml(message);
    stack.appendChild(li);
    // Animation-driven removal is tied to the keyframes finish event.
    li.addEventListener('animationend', (e) => {
        if (e.animationName === 'ba-toast-out') li.remove();
    });
    // Hard fallback in case the animation gets cancelled.
    setTimeout(() => { try { li.remove(); } catch (_) {} }, ttlMs + 600);
}

/**
 * Themed confirm modal. Returns a Promise<boolean> that resolves true
 * when the user clicks the confirm action, false on cancel / close /
 * backdrop / escape. Single global modal element; only one prompt at
 * a time is supported, which is fine for the call sites we have.
 */
let confirmModalResolve = null;
let confirmModalReturnFocus = null;
function restoreFocus(el) {
    // Focus used to drop to <body> after Escape (audit D15); put it back on
    // the control that opened the dialog when it is still in the document.
    if (el && typeof el.focus === 'function' && document.contains(el) && !el.hidden) {
        try { el.focus(); } catch (_) { /* ignore */ }
    }
}
function openConfirmModal({ title = 'Confirm', body = '', confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false } = {}) {
    const modal = document.getElementById('confirm-modal');
    if (!modal) return Promise.resolve(window.confirm(body));
    setText(document.getElementById('confirm-modal-title'), title);
    setText(document.getElementById('confirm-modal-body'), body);
    const confirmBtn = document.getElementById('confirm-modal-confirm');
    const cancelBtn = document.getElementById('confirm-modal-cancel');
    confirmBtn.textContent = confirmLabel;
    cancelBtn.textContent = cancelLabel;
    confirmBtn.classList.toggle('btn-danger', !!danger);
    if (modal.hasAttribute('hidden')) confirmModalReturnFocus = document.activeElement;
    modal.removeAttribute('hidden');
    return new Promise((resolve) => {
        // Resolve a stale outstanding prompt as false so we never leak
        // a dangling promise if openConfirmModal is called twice quickly.
        if (confirmModalResolve) {
            try { confirmModalResolve(false); } catch (_) {}
        }
        confirmModalResolve = resolve;
        confirmBtn.focus();
    });
}
function closeConfirmModal(result) {
    const modal = document.getElementById('confirm-modal');
    if (modal) modal.setAttribute('hidden', '');
    const r = confirmModalResolve;
    confirmModalResolve = null;
    const back = confirmModalReturnFocus;
    confirmModalReturnFocus = null;
    restoreFocus(back);
    if (r) r(!!result);
}
function wireConfirmModal() {
    const modal = document.getElementById('confirm-modal');
    if (!modal) return;
    modal.addEventListener('click', (e) => {
        // .closest() - clicks on the SVG/path INSIDE the X button bubble
        // as e.target=<path|svg>, which would never match [data-confirm-close]
        // on the button directly via .matches().
        if (e.target.closest('[data-confirm-close]')) closeConfirmModal(false);
    });
    document.getElementById('confirm-modal-cancel').addEventListener('click', () => closeConfirmModal(false));
    document.getElementById('confirm-modal-confirm').addEventListener('click', () => closeConfirmModal(true));
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !modal.hasAttribute('hidden')) { closeConfirmModal(false); return; }
        // Focus trap: cycle Tab/Shift+Tab within the modal's focusable elements.
        if (e.key === 'Tab' && !modal.hasAttribute('hidden')) {
            const focusables = Array.from(modal.querySelectorAll(
                'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
            )).filter((el) => !el.disabled && !el.hasAttribute('hidden'));
            if (!focusables.length) return;
            const first = focusables[0];
            const last = focusables[focusables.length - 1];
            if (e.shiftKey) {
                if (document.activeElement === first) { e.preventDefault(); last.focus(); }
            } else {
                if (document.activeElement === last) { e.preventDefault(); first.focus(); }
            }
        }
    });
}

/**
 * One-time "this is the name everyone will see" prompt. Resolves with the
 * trimmed name, or null if the player closed it without confirming.
 */
let namePromptResolve = null;
let namePromptReturnFocus = null;
function openNamePrompt(suggested) {
    const modal = document.getElementById('name-prompt-modal');
    if (!modal) return Promise.resolve(suggested);
    const input = document.getElementById('name-prompt-input');
    input.value = suggested;
    if (modal.hasAttribute('hidden')) namePromptReturnFocus = document.activeElement;
    modal.removeAttribute('hidden');
    return new Promise((resolve) => {
        if (namePromptResolve) {
            try { namePromptResolve(null); } catch (_) {}
        }
        namePromptResolve = resolve;
        input.focus();
        input.select();
    });
}
function closeNamePrompt(accepted) {
    const modal = document.getElementById('name-prompt-modal');
    const input = document.getElementById('name-prompt-input');
    const value = String(input.value || '').trim().slice(0, Config.MAX_DISPLAY_NAME);
    if (accepted && !value) { input.focus(); return; }
    if (modal) modal.setAttribute('hidden', '');
    const r = namePromptResolve;
    namePromptResolve = null;
    const back = namePromptReturnFocus;
    namePromptReturnFocus = null;
    restoreFocus(back);
    if (r) r(accepted ? value : null);
}
function wireNamePrompt() {
    const modal = document.getElementById('name-prompt-modal');
    if (!modal) return;
    modal.addEventListener('click', (e) => {
        if (e.target.closest('[data-name-prompt-close]')) closeNamePrompt(false);
    });
    document.getElementById('name-prompt-confirm').addEventListener('click', () => closeNamePrompt(true));
    document.getElementById('name-prompt-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); closeNamePrompt(true); }
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !modal.hasAttribute('hidden')) closeNamePrompt(false);
    });
}

function avatarLetter(displayName) {
    const s = String(displayName || '').trim();
    if (!s) return '?';
    return s.charAt(0).toUpperCase();
}

/* =====================================================================
 * View tabs
 * ===================================================================== */

function setView(view) {
    state.activeView = view;
    $$('.view-tab').forEach((b) => {
        const isActive = b.dataset.view === view;
        setClass(b, 'is-active', isActive);
        b.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
    $$('[data-view-panel]').forEach((panel) => {
        setClass(panel, 'is-active', panel.dataset.viewPanel === view);
        panel.hidden = panel.dataset.viewPanel !== view;
    });
    if (view === 'leaderboard' || view === 'h2h') startLeaderboardListener();
    else stopLeaderboardListener();
    if (view === 'profile') renderProfileView();
    if (view === 'h2h') renderH2HPickers();
    syncUrlToState();
}

function wireViewTabs() {
    $$('.view-tab').forEach((b) => {
        b.addEventListener('click', () => setView(b.dataset.view));
    });
}

/* =====================================================================
 * URL state (?view=…&room=…)
 *
 * The URL is the single source of truth for: which tab is active, and
 * which room (if any) the user is currently in. A refresh re-attaches to
 * the same tab + the same room without re-prompting. A pasted room URL
 * is treated as a join attempt - gates apply normally (sign-in, password).
 *
 * We use history.replaceState (not pushState) so the back button doesn't
 * accumulate every tab click; the URL just mirrors current state.
 * ===================================================================== */

const VALID_VIEWS = new Set(['play', 'leaderboard', 'h2h', 'profile']);

function parseUrlState() {
    try {
        const url = new URL(window.location.href);
        const view = url.searchParams.get('view');
        const room = url.searchParams.get('room');
        const postMatch = url.searchParams.get('postMatch');
        // Single validity notion for room codes: normalizeRoomCode enforces
        // both the length and the generator alphabet (defect 24). A code the
        // generator can never emit is rejected here exactly like it is in
        // the join form, instead of being carried into a doomed lookup.
        const norm = (v) => (typeof v === 'string' ? RoomState.normalizeRoomCode(v) : '');
        return {
            view: VALID_VIEWS.has(view) ? view : null,
            room: norm(room) || null,
            postMatch: norm(postMatch) || null
        };
    } catch (e) {
        return { view: null, room: null, postMatch: null };
    }
}

/**
 * Build a shareable invite URL for the given room code. Keeps the
 * current location's protocol + host + pathname so the link works
 * across staging / prod / preview deploys, and strips every search
 * param except `?room=`.
 */
function buildInviteLink(code) {
    try {
        const u = new URL(window.location.href);
        const out = `${u.protocol}//${u.host}${u.pathname}?room=${encodeURIComponent(code)}`;
        return out;
    } catch (_) {
        return `${window.location.origin}${window.location.pathname}?room=${encodeURIComponent(code)}`;
    }
}

function syncUrlToState() {
    try {
        const url = new URL(window.location.href);
        // Only encode the bits we want to round-trip; leave anything else
        // (gtag, utm params) alone so external links keep their context.
        if (state.activeView && state.activeView !== 'play') {
            url.searchParams.set('view', state.activeView);
        } else {
            url.searchParams.delete('view');
        }
        // ?postMatch=<code> wins over ?room=<code> - the recap view is
        // read-only, so we don't want pasting the URL to also re-join.
        if (state.postMatchCode) {
            url.searchParams.set('postMatch', state.postMatchCode);
            url.searchParams.delete('room');
        } else if (state.roomCode) {
            url.searchParams.set('room', state.roomCode);
            url.searchParams.delete('postMatch');
        } else {
            url.searchParams.delete('room');
            url.searchParams.delete('postMatch');
        }
        const next = url.pathname + (url.search ? url.search : '') + url.hash;
        // No-op when URL is already in sync - avoids redundant history
        // entries when render fans out three setView calls during boot.
        if (next !== window.location.pathname + window.location.search + window.location.hash) {
            window.history.replaceState(null, '', next);
        }
    } catch (e) {
        // history.replaceState can throw inside very restrictive iframes;
        // not worth crashing the app over a URL cosmetics failure.
    }
}

/**
 * On boot, try to restore tab + active room from the URL. Tab is cheap
 * and synchronous; room rejoin needs the user to be signed in, so we
 * defer the room half until applyAuthState fires with a signed-in user.
 */
async function restoreFromUrl() {
    const { view, room, postMatch } = parseUrlState();
    if (view && view !== state.activeView) setView(view);
    // postMatch wins over room - it's a deep link to a finished room's
    // recap view. Same auth gating (Firestore reads need a signed-in
    // user, even anonymous), so we queue behind applyAuthState too.
    if (postMatch) { state.pendingPostMatchCode = postMatch; return; }
    if (!room) return;
    // Stash the desired room on state; applyAuthState picks it up the
    // first time we see a signed-in user. That way a refresh of
    // /?room=ABCDE on a signed-out tab queues the rejoin behind the
    // sign-in flow instead of failing immediately.
    state.pendingRoomCode = room;
}

async function tryLoadPendingPostMatch() {
    const code = state.pendingPostMatchCode;
    if (!code || !state.user) return;
    state.pendingPostMatchCode = null;
    if (state.roomCode === code) return; // already in this room
    setView('play');
    showJoinError('Loading recap…');
    try {
        const snap = await getDoc(doc(db, 'triviaRooms', code));
        if (!snap.exists()) {
            showJoinError('Recap not found - that room may have been cleaned up.');
            state.postMatchCode = null;
            syncUrlToState();
            return;
        }
        const data = snap.data() || {};
        if (data.status !== 'finished') {
            // Not finished - fall through to a normal join attempt so the
            // user lands in the active room instead of a broken recap.
            state.pendingRoomCode = code;
            state.postMatchCode = null;
            syncUrlToState();
            return tryRejoinPendingRoom();
        }
        // View-only recap: hydrate the room + player snapshots, mark
        // postMatchCode so the URL stays as ?postMatch=…, then jump to
        // the end stage without touching this user's membership.
        clearJoinError();
        const playersSnap = await getDocs(collection(db, 'triviaRooms', code, 'players'));
        const players = playersSnap.docs.map((d) => d.data());
        state.roomCode = code;
        state.roomData = data;
        state.roomPlayers = players;
        state.postMatchCode = code;
        // B1: renderEndStage only swaps STAGES; the panel swap lives in
        // enterRoom, which a view-only recap never calls. Without this the
        // recap renders inside a hidden #room-panel and the visitor sees the
        // lobby, so a shared recap link looked broken.
        show($('#room-panel'));
        hide($('#lobby-panel'));
        setText($('#room-code-display'), code);
        syncUrlToState();
        renderEndStage(false);
    } catch (err) {
        console.warn('post-match deep link failed:', err);
        showJoinError('Could not load that recap. Please try again.');
    }
}

async function tryRejoinPendingRoom() {
    const code = state.pendingRoomCode;
    if (!code || !state.user) return;
    if (state.roomCode === code) { state.pendingRoomCode = null; return; }
    state.pendingRoomCode = null;
    // Indicate to the UI that we're resolving a room from the URL. We hold
    // off any "finished / missing room" verdict until after both the room
    // doc AND the player-membership doc have actually returned from
    // Firestore - that was the race that caused "That room has already
    // finished" to flash on first paint of an active room.
    setView('play');
    showJoinError('Loading room…');
    try {
        const snap = await getDoc(doc(db, 'triviaRooms', code));
        if (!snap.exists()) {
            showJoinError('Room not found.');
            return;
        }
        const data = snap.data() || {};
        // Membership lookup. We *must* do this BEFORE evaluating
        // status==='finished', because a previous player coming back to a
        // finished room should still land on the end-of-game screen (to
        // see the podium / rematch), not the "room finished" error wall.
        const playerRef = doc(db, 'triviaRooms', code, 'players', state.user.uid);
        const playerSnap = await getDoc(playerRef);
        const wasAlreadyMember = playerSnap.exists();
        if (wasAlreadyMember) {
            // Member rejoin - works for any status. Finished rooms render
            // the end stage, lobby/picking/playing render the matching
            // stage. Either way, no error.
            clearJoinError();
            // CLEAR THE DISCONNECT STAMP. `beforeUnloadCleanup` writes
            // `disconnectedAt` on the way out, and a refresh comes straight
            // back through this path, which used to write `lastSeen` alone.
            // The stamp therefore survived the rejoin: 30 seconds later
            // `RoomState.isPlayerLive` and the rules' `isStalePlayerData` both
            // called a player who was heart-beating normally stale, the host
            // swept the doc, and the player was silently dropped mid-game -
            // absent from the reveal, the Ready vote and the final ranking,
            // with their score gone. Only `joinPlayer`'s reconnect branch
            // cleared it, and a URL rejoin never reaches that branch.
            try {
                await updateDoc(playerRef, { lastSeen: serverTimestamp(), disconnectedAt: deleteField() });
            } catch (_) {}
            enterRoom(code);
            return;
        }
        // Non-member: now it's safe to evaluate status. A non-member
        // trying to join a finished room sees the expected error.
        if (data.status === 'finished') {
            showJoinError('That room has already finished.');
            return;
        }
        const codeInput = $('#join-code');
        if (codeInput) codeInput.value = code;
        if (data.isPrivate) {
            setJoinPwFieldVisible(true);
            showJoinError('This room is private. Enter the password to join.');
        } else {
            clearJoinError();
            await joinRoom();
        }
    } catch (err) {
        console.warn('rejoin from URL failed:', err);
        showJoinError('Could not load that room. Please try again.');
    }
}

/* =====================================================================
 * Auth + profile
 * ===================================================================== */

function waitForFirebaseAuth() {
    return new Promise((resolve) => {
        if (window.firebaseAuth) return resolve();
        window.addEventListener('firebaseAuthReady', () => resolve(), { once: true });
    });
}

/**
 * True when the current user is an anonymous (guest) Firebase user.
 * Guests can play, but persistent writes (leaderboard, H2H, daily,
 * users/{uid}.triviaProfile) skip them - their room is ephemeral.
 */
function isGuest() {
    return !!(state.user && state.user.isAnonymous);
}

/**
 * Sign in anonymously if no user yet. Returns the user, or null on
 * failure. Failure is surfaced as a toast so visitors don't get a
 * silent bounce back to the sign-in modal when Anonymous auth isn't
 * enabled in the Firebase project (the most common cause). Waits for
 * applyAuthState to populate state.user before returning so callers
 * can rely on state.user immediately after awaiting.
 */
async function ensureGuestAuth() {
    if (state.user) return state.user;
    try {
        const user = await window.firebaseAuth.signInAsGuest();
        // onAuthStateChanged fires asynchronously after signInAnonymously
        // resolves; spin briefly until applyAuthState has populated
        // state.user so downstream code (createRoom, joinRoom) sees it.
        for (let i = 0; i < 50 && !state.user; i++) {
            await new Promise((r) => setTimeout(r, 10));
        }
        return state.user || user;
    } catch (err) {
        console.warn('Guest sign-in failed:', err);
        // Most common cause: Anonymous provider disabled in Firebase
        // Console (auth/operation-not-allowed / admin-restricted-
        // operation). Surface a toast so the user understands why
        // they're being routed to the sign-in modal instead of into
        // the room.
        showToast('Guest mode is unavailable right now - please sign in or sign up to play.', { icon: '⚠️', key: 'guest-auth-failed' });
        return null;
    }
}

async function loadProfile(uid) {
    // Guests never get a persistent users/{uid} doc - their uid resets
    // when storage is cleared, so any profile we wrote would be garbage.
    // Returning null lets renderProfileView short-circuit into the
    // "sign up to save your stats" CTA branch.
    if (isGuest()) return null;
    const ref = doc(db, 'users', uid);
    try {
        const snap = await getDoc(ref);
        const data = snap.exists() ? snap.data() : {};
        const tp = data.triviaProfile || null;
        if (tp) return tp;
        // Seed a minimal profile on first run.
        const seeded = {
            displayName: deriveInitialDisplayName(),
            // Not a choice, just a placeholder - ensureDisplayNameChosen
            // asks the player to confirm before anything is published.
            displayNameChosen: false,
            xp: 0,
            gamesPlayed: 0,
            wins: 0,
            lastPlayedAt: null
        };
        await setDoc(ref, { triviaProfile: seeded }, { merge: true });
        return seeded;
    } catch (err) {
        console.warn('Could not load trivia profile:', err);
        return null;
    }
}

/**
 * Fallback name for a player who hasn't picked one. Deliberately carries
 * no identity: this value is denormalized into triviaLeaderboard, which
 * any signed-in user can read.
 */
function deriveInitialDisplayName() {
    return RoomState.defaultDisplayName(state.user?.uid);
}

/**
 * Make sure the player has explicitly approved the name they're about to
 * publish to shared surfaces (room player list, chat, leaderboard) before
 * their first multiplayer game. Returns the name to use, or null if the
 * player dismissed the prompt (caller aborts the create/join).
 *
 * Guests are exempt - they have no persistent profile and never reach the
 * leaderboard, so there's nothing to remember and nothing to publish.
 */
async function ensureDisplayNameChosen() {
    if (!state.user || isGuest()) return deriveInitialDisplayName();
    // The invite-link path races loadProfile, so a null profile here can
    // just mean "not back yet" - resolve it before deciding to prompt,
    // otherwise we'd re-ask a player who already picked a name.
    if (!state.profile) state.profile = await loadProfile(state.user.uid);
    const { needed, suggested } = RoomState.displayNamePrompt(
        state.profile, state.user.email, state.user.uid
    );
    if (!needed) return state.profile.displayName || suggested;
    const picked = await openNamePrompt(suggested);
    if (!picked) return null;
    if (!state.profile) state.profile = {};
    try {
        await saveProfileField({ displayName: picked, displayNameChosen: true });
    } catch (err) {
        // Profile doc unreachable - play on with the name they picked
        // rather than blocking the game; we'll ask again next time.
        console.warn('Could not save display name:', err);
    }
    renderProfileView();
    await propagateDisplayName(picked);
    return picked;
}

async function saveProfileField(patch) {
    if (!state.user || isGuest()) return;
    const ref = doc(db, 'users', state.user.uid);
    const updates = {};
    for (const [k, v] of Object.entries(patch)) updates[`triviaProfile.${k}`] = v;
    await updateDoc(ref, updates);
    Object.assign(state.profile, patch);
}

function applyAuthState(user) {
    state.user = user || null;
    const signedIn = !!user;
    // Treat guests (anonymous users) as "not signed up" for UI gating -
    // the auth-gate / profile-signed-out CTAs still show their sign-up
    // prompt, but the lobby itself stays unlocked because createRoom /
    // joinRoom auto-bootstrap anon auth when needed.
    const isRegistered = signedIn && !user.isAnonymous;
    setClass($('#auth-gate'), 'is-hidden', isRegistered);
    if (isRegistered) $('#auth-gate').hidden = true;
    else $('#auth-gate').hidden = false;

    // Invite-link landing: if a signed-out user arrived via an
    // /?room=ABCDE or /?postMatch=ABCDE link, silently sign them in as a
    // guest and join / load the recap. applyAuthState fires again once the
    // anon user exists, which re-runs the signedIn branch below and
    // tryRejoinPendingRoom / tryLoadPendingPostMatch takes them straight
    // there. We only kick this off once per boot to avoid an auth-loop if
    // the sign-in itself fails.
    if (!signedIn && (state.pendingRoomCode || state.pendingPostMatchCode) && !state.inviteSignInPrompted) {
        state.inviteSignInPrompted = true;
        ensureGuestAuth();
    }

    // Profile view toggles - guests see the sign-up CTA (same panel
    // as fully signed-out users, slightly different copy handled by
    // renderProfileGuestCTA).
    setClass($('#profile-signed-out'), 'is-hidden', isRegistered);
    $('#profile-signed-out').hidden = isRegistered;
    $('#profile-card-trivia').hidden = !isRegistered;
    renderProfileGuestCTA();

    // Stop watching the previous user's doc (if any) before swapping.
    if (state.profileUnsub) {
        try { state.profileUnsub(); } catch (_) { /* ignore */ }
        state.profileUnsub = null;
    }

    if (signedIn) {
        // If we landed on /?room=ABCDE or /?postMatch=ABCDE before
        // sign-in, the rejoin / recap fetch was queued behind auth -
        // kick it off now. Runs in parallel with loadProfile since
        // the two don't depend on each other.
        if (state.pendingPostMatchCode) tryLoadPendingPostMatch();
        else if (state.pendingRoomCode)  tryRejoinPendingRoom();
        // Skip the registered-only side effects (admin probe + profile
        // subscription) for guests - both would be wasted Firestore
        // reads that hit rule denials.
        if (isRegistered) checkLeaderboardAdmin(user.uid);
        if (isGuest()) {
            state.profile = null;
            state.customPack = null;
            renderProfileView();
            return;
        }
        loadProfile(user.uid).then((p) => {
            state.profile = p;
            renderProfileView();
            state.customPack = (p && p.customPack) ? p.customPack : null;
            // Live-subscribe so profile changes (stats, saved custom pack)
            // surface without a page reload.
            state.profileUnsub = onSnapshot(doc(db, 'users', user.uid), (snap) => {
                const data = snap.exists() ? snap.data() : {};
                const tp = data.triviaProfile;
                if (!tp) return;
                state.profile = tp;
                state.customPack = tp.customPack || null;
                renderProfileView();
            }, (err) => {
                console.warn('Profile snapshot listener error:', err);
            });
        });
    } else {
        state.profile = null;
        state.customPack = null;
        if (state.roomCode) leaveRoom({ silent: true });
    }
}

/* =====================================================================
 * Profile view
 * ===================================================================== */

/**
 * Update the copy of the #profile-signed-out CTA based on whether the
 * visitor is fully signed out or playing as a guest. Same panel, two
 * voices: "Sign in to save…" for signed-out, "You're playing as a guest
 * - sign up to keep your stats" for anonymous users.
 */
function renderProfileGuestCTA() {
    const panel = $('#profile-signed-out');
    if (!panel) return;
    if (isGuest()) {
        panel.innerHTML = '<strong>Playing as a guest.</strong> '
            + 'Sign up from the top-right to save your score, wins, and games played across devices.';
    } else {
        panel.textContent = 'Sign in from the top-right to save your score, wins, and games played.';
    }
}

function renderProfileView() {
    if (!state.user || isGuest()) return;
    setText($('#profile-email'), state.user.email || '');
    const p = state.profile || {};
    const name = p.displayName || deriveInitialDisplayName();
    const input = $('#profile-display-name');
    if (input && document.activeElement !== input) input.value = name;
    setText($('#profile-avatar'), avatarLetter(name));
    // Avg score (= total score / games) is the headline stat - total
    // score is what's persisted, but mean per game is the meaningful
    // skill signal regardless of how many games someone has logged.
    const games = p.gamesPlayed || 0;
    const avg = games > 0 ? Math.round((p.xp || 0) / games) : 0;
    setText($('#stat-avg-score'), avg.toLocaleString());
    setText($('#stat-games'), String(games));
    const pct = games > 0 ? Math.round(100 * (p.wins || 0) / games) : 0;
    setText($('#stat-winpct'), pct + '%');
    setText($('#stat-bullseyes'), String(p.lifetimeBullseyes || 0));
    setText($('#stat-best-round'), String(p.bestRoundScore || 0));

    renderCustomPackTextarea();
}

function wireProfileView() {
    $('#profile-display-name').addEventListener('change', async (e) => {
        const v = String(e.target.value || '').trim().slice(0, Config.MAX_DISPLAY_NAME);
        if (!v) return;
        await saveProfileField({ displayName: v, displayNameChosen: true });
        await propagateDisplayName(v);
        renderProfileView();
        renderLeaderboardEntries();
    });
}

/**
 * Push a new display name to every place we've denormalized it:
 *   - the active room's player doc (so the mini-board updates)
 *   - the global leaderboard doc (so other tabs see the new name)
 * Errors are swallowed - best-effort UX, the source of truth is the
 * user profile doc which has already been updated by saveProfileField.
 */
async function propagateDisplayName(displayName) {
    if (!state.user) return;
    if (state.roomCode) {
        try {
            await updateDoc(doc(db, 'triviaRooms', state.roomCode, 'players', state.user.uid), {
                displayName
            });
        } catch (_) { /* room may not exist or rules may deny */ }
    }
    try {
        await setDoc(doc(db, 'triviaLeaderboard', state.user.uid), {
            uid: state.user.uid,
            displayName
        }, { merge: true });
    } catch (_) { /* leaderboard doc may not exist yet */ }
}

/* =====================================================================
 * Question pack loading
 * ===================================================================== */

/**
 * Silence the unhandled Firestore-channel write errors that bubble when a
 * client-side privacy extension (uBlock, Brave Shields, etc.) blocks the
 * https://firestore.googleapis.com/.../Write/channel POST. Firestore retries
 * internally and keeps the app working, but the unhandled rejection lands
 * in the console as a scary "ERR_BLOCKED_BY_CLIENT" stack - and on leaveRoom
 * the terminating XHR can throw on the way out.
 *
 * We swallow only this specific class of message; real bugs still surface.
 */
function installFirestoreNoiseGuard() {
    if (typeof window === 'undefined' || window.__baFirestoreGuardInstalled) return;
    window.__baFirestoreGuardInstalled = true;
    const isFirestoreNetNoise = (err) => {
        if (!err) return false;
        const msg = String((err && (err.message || err.code || err.name)) || err).toLowerCase();
        return msg.includes('err_blocked_by_client')
            || msg.includes('firestore.googleapis.com')
            || (msg.includes('webchannel') && msg.includes('transport'));
    };
    window.addEventListener('unhandledrejection', (e) => {
        if (isFirestoreNetNoise(e.reason)) {
            // Demote to a single-line warn so devs can still spot trends.
            try { console.warn('[firestore] suppressed network noise:', e.reason && (e.reason.code || e.reason.message)); } catch (_) {}
            e.preventDefault();
        }
    });
    window.addEventListener('error', (e) => {
        if (isFirestoreNetNoise(e.error || e.message)) {
            try { console.warn('[firestore] suppressed network noise:', e.message); } catch (_) {}
            e.preventDefault();
        }
    });
}

function shuffle(arr, rand = Math.random) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

/**
 * Stamp each location with a multiplier from the [1.0, 1.5, 2.0,
 * 2.5, 3.0] ladder based on its own difficulty (continent rarity ×
 * population obscurity). Famous capitals → 1.0×; obscure island
 * states → 2.5–3.0×. Stored on the location at room creation so
 * every player sees the same per-location multiplier regardless of
 * play order.
 *
 * After stamping, reorder the playlist so each round is at least as
 * hard as the last - easiest first, hardest last. Per-location
 * difficulty alone doesn't guarantee progression; without this sort
 * the playlist would jump around (×1 → ×2.5 → ×1 → ×1.5 → ×1).
 * Ties keep their original (shuffled) order via Array.sort's
 * stability so two ×1 capitals don't always appear in the same
 * order across games.
 */
function applyRoundMultipliers(locations, roundType) {
    const stamped = GlobeDropScoring.assignDifficultyMultipliers(locations, roundType);
    return stamped.slice().sort((a, b) => (a.multiplier || 1) - (b.multiplier || 1));
}

/**
 * Build the question POOL for a round. We over-provision so the per-question
 * category picker has variety: the round plays `count` questions out of a
 * pool of up to 5x that (capped at the live API's 50/request limit).
 *
 * Live source is the only built-in (no offline fallback). A saved custom
 * pack takes precedence when explicitly selected. Any fetch failure bubbles
 * up - callers should catch and surface a clear error to the host.
 *
 * @param {string} packId - 'live' | 'custom'
 * @param {number} count - number of questions to be played this round
 * @returns {Promise<{questions:Array, packId:string, packName:string}>}
 */
async function buildQuestionsForRound(packId, count) {
    if (packId === 'custom' && state.customPack) {
        return {
            questions: shuffle(state.customPack.questions || []),
            packId: 'custom',
            packName: state.customPack.name || 'Custom pack'
        };
    }
    const poolTarget = Math.max(count, Math.min(50, count * 5));
    const questions = await LiveQuestions.fetchLiveQuestions(poolTarget, shuffle);
    return { questions, packId: 'live', packName: 'The Trivia API' };
}

/* =====================================================================
 * Custom pack
 * ===================================================================== */

function renderCustomPackTextarea() {
    const ta = $('#custom-pack-input');
    if (!ta) return;
    if (state.customPack) {
        ta.value = JSON.stringify(state.customPack, null, 2);
    } else if (!ta.value) {
        ta.value = '';
    }
}

function wireCustomPack() {
    const saveBtn = $('#custom-pack-save-btn');
    const clearBtn = $('#custom-pack-clear-btn');
    const msg = $('#custom-pack-msg');

    saveBtn.addEventListener('click', async () => {
        msg.classList.remove('is-ok', 'is-err');
        if (!state.user || isGuest()) { setText(msg, 'Sign in first.'); msg.classList.add('is-err'); return; }
        let parsed;
        try {
            parsed = JSON.parse($('#custom-pack-input').value || '');
        } catch (err) {
            setText(msg, 'JSON parse failed: ' + err.message);
            msg.classList.add('is-err');
            return;
        }
        const errMsg = validateCustomPack(parsed);
        if (errMsg) { setText(msg, errMsg); msg.classList.add('is-err'); return; }
        const cleaned = sanitizeCustomPack(parsed);
        await saveProfileField({ customPack: cleaned });
        state.customPack = cleaned;
        setText(msg, `Saved "${cleaned.name}" (${cleaned.questions.length} questions).`);
        msg.classList.add('is-ok');
        renderPackOptions();
    });

    clearBtn.addEventListener('click', async () => {
        if (!state.user) return;
        msg.classList.remove('is-ok', 'is-err');
        if (!state.customPack) {
            setText(msg, 'No saved custom pack to clear.');
            return;
        }
        await updateDoc(doc(db, 'users', state.user.uid), { 'triviaProfile.customPack': deleteField() });
        state.customPack = null;
        if (state.profile) delete state.profile.customPack;
        $('#custom-pack-input').value = '';
        setText(msg, 'Cleared.');
        msg.classList.add('is-ok');
        renderPackOptions();
    });
}

function validateCustomPack(pack) {
    if (!pack || typeof pack !== 'object') return 'Pack must be a JSON object.';
    if (!Array.isArray(pack.questions) || !pack.questions.length) return 'questions[] must be a non-empty array.';
    if (pack.questions.length > 200) return 'Pack capped at 200 questions.';
    for (let i = 0; i < pack.questions.length; i++) {
        const q = pack.questions[i];
        if (!q || typeof q !== 'object') return `Question #${i+1} not an object.`;
        if (typeof q.question !== 'string' || !q.question.trim()) return `Question #${i+1} missing "question" string.`;
        if (!Array.isArray(q.choices) || q.choices.length < 2 || q.choices.length > 6) return `Question #${i+1} needs 2-6 "choices".`;
        if (!Number.isInteger(q.correctIndex) || q.correctIndex < 0 || q.correctIndex >= q.choices.length) {
            return `Question #${i+1} has invalid correctIndex.`;
        }
    }
    return null;
}

function sanitizeCustomPack(pack) {
    return {
        id: 'custom',
        name: String(pack.name || 'Custom pack').slice(0, 60),
        description: String(pack.description || '').slice(0, 200),
        questions: pack.questions.map((q, i) => ({
            id: String(q.id || `c${i+1}`),
            category: String(q.category || 'general').slice(0, 32),
            question: String(q.question).slice(0, 280),
            choices: q.choices.map((c) => String(c).slice(0, 120)),
            correctIndex: q.correctIndex | 0
        }))
    };
}

function renderPackOptions() {
    const sel = $('#create-pack-select');
    if (!sel) return;
    const previouslySelected = sel.value;
    sel.innerHTML = '';

    // Live API is the only built-in question source. A saved custom pack
    // gets a second option.
    const live = document.createElement('option');
    live.value = 'live';
    live.textContent = 'Live questions (The Trivia API)';
    sel.appendChild(live);

    if (state.customPack) {
        const c = document.createElement('option');
        c.value = 'custom';
        c.textContent = `${state.customPack.name} (custom)`;
        sel.appendChild(c);
    }
    if (previouslySelected) sel.value = previouslySelected;
}

/* =====================================================================
 * Lobby: create/join
 * ===================================================================== */

function wireGameTypeToggle() {
    $$('.game-type-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            const type = btn.dataset.gameType;
            if (type !== 'trivia' && type !== 'globe-drop') return;
            state.selectedGameType = type;
            $$('.game-type-btn').forEach((b) => {
                const isOn = b.dataset.gameType === type;
                b.classList.toggle('is-active', isOn);
                b.setAttribute('aria-selected', isOn ? 'true' : 'false');
            });
            // Show/hide trivia-only vs globe-drop-only form fields.
            $$('[data-game-type]').forEach((el) => {
                if (!el.matches('.game-type-btn') && el.dataset.gameType) {
                    const shouldHide = el.dataset.gameType !== type;
                    // .lobby-solo-actions uses a CSS transition instead of hidden.
                    if (el.classList.contains('lobby-solo-actions')) {
                        el.classList.toggle('is-hidden', shouldHide);
                    } else if (el.id === 'create-globe-drop-time-field') {
                        // This field's visibility is independently owned by
                        // the timer-override checkbox, so only ever hide it
                        // here, never force it open just because Globe Drop
                        // became the active tab again.
                        el.hidden = shouldHide || !$('#create-globe-drop-timer-override').checked;
                    } else {
                        el.hidden = shouldHide;
                    }
                }
            });
            saveLobbySettings();
        });
    });
}

const LOBBY_SETTINGS_KEY = 'arena.lobby.lastSettings';

function saveLobbySettings() {
    try {
        const overrideTimer = !!$('#create-globe-drop-timer-override').checked;
        const settings = {
            gameType: state.selectedGameType,
            roundType: $('#create-globe-drop-round-type').value,
            difficulty: $('#create-globe-drop-difficulty').value,
            locationsCount: $('#create-locations-count').value,
            timerOverride: overrideTimer,
            timerSec: overrideTimer ? $('#create-globe-drop-time').value : null,
            questionsCount: $('#create-questions-count').value,
            triviaTimeSec: $('#create-trivia-time').value
        };
        localStorage.setItem(LOBBY_SETTINGS_KEY, JSON.stringify(settings));
    } catch (e) { /* localStorage may be unavailable */ }
}

function restoreLobbySettings() {
    try {
        const raw = localStorage.getItem(LOBBY_SETTINGS_KEY);
        if (!raw) return;
        const s = JSON.parse(raw);

        // Restore game type toggle first so the correct fields show.
        if (s.gameType === 'trivia' || s.gameType === 'globe-drop') {
            const btn = $(`.game-type-btn[data-game-type="${s.gameType}"]`);
            if (btn) btn.click();
        }

        if (s.roundType) {
            const el = $('#create-globe-drop-round-type');
            if (el) el.value = s.roundType;
        }
        if (s.difficulty) {
            const el = $('#create-globe-drop-difficulty');
            if (el) el.value = s.difficulty;
        }
        if (s.locationsCount) {
            const el = $('#create-locations-count');
            if (el) el.value = s.locationsCount;
        }
        if (s.timerOverride) {
            const tog = $('#create-globe-drop-timer-override');
            if (tog) {
                tog.checked = true;
                $('#create-globe-drop-time-field').hidden = false;
            }
            if (s.timerSec) {
                const el = $('#create-globe-drop-time');
                if (el) el.value = s.timerSec;
            }
        }
        if (s.questionsCount) {
            const el = $('#create-questions-count');
            if (el) el.value = s.questionsCount;
        }
        if (s.triviaTimeSec) {
            const el = $('#create-trivia-time');
            if (el) el.value = s.triviaTimeSec;
        }
    } catch (e) { /* ignore corrupt localStorage */ }
}

function wireLobby() {
    wireGameTypeToggle();

    // Restore previously used settings on mount.
    restoreLobbySettings();

    // Save settings on any field change so the last selection survives reload.
    $$('#lobby-panel select, #lobby-panel input[type="checkbox"]').forEach((el) => {
        el.addEventListener('change', saveLobbySettings);
    });

    $('#create-private-toggle').addEventListener('change', (e) => {
        const wantsPrivate = e.target.checked;
        $('#create-password-field').hidden = !wantsPrivate;
    });
    // Password inputs are type=password (audit D15) with a show/hide toggle.
    // The toggle is a <button> inside the <label>, so stop the click from
    // re-focusing the input through the label.
    $$('.pw-toggle').forEach((btn) => btn.addEventListener('click', (e) => {
        e.preventDefault();
        const input = document.getElementById(btn.dataset.pwToggle);
        if (!input) return;
        const show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        btn.setAttribute('aria-pressed', show ? 'true' : 'false');
        btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
        btn.textContent = show ? 'Hide' : 'Show';
    }));

    // Globe Drop: difficulty drives the hint level only - timer is a
    // separate dial (default 60 s, host can override via the toggle).
    $('#create-globe-drop-timer-override').addEventListener('change', (e) => {
        $('#create-globe-drop-time-field').hidden = !e.target.checked;
    });

    $('#create-room-btn').addEventListener('click', () => createRoom());
    $('#play-solo-btn').addEventListener('click', () => createRoom({ mode: 'solo' }));
    $('#play-daily-btn').addEventListener('click', () => createRoom({ mode: 'daily' }));
    $('#join-room-btn').addEventListener('click', joinRoom);
    $('#join-code').addEventListener('input', (e) => {
        const raw = String(e.target.value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
        e.target.value = raw.slice(0, Config.ROOM_CODE_LENGTH);
        clearJoinError();
        // When the code is fully typed, peek at the room so the password
        // field appears proactively. Otherwise the user has to click Join,
        // see an error, type the password, and click Join again.
        maybeRevealJoinPasswordField(e.target.value);
    });
    $('#join-code').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') joinRoom();
    });

    $('#leave-room-btn').addEventListener('click', async () => {
        const isSolo = state.roomData && state.roomData.playMode === 'solo';
        const ok = await openConfirmModal({
            title: isSolo ? 'Back to lobby?' : 'Leave room?',
            body: isSolo
                ? 'Your current run will end and you\'ll return to the lobby.'
                : 'Are you sure you want to leave this room?',
            confirmLabel: isSolo ? 'Back to lobby' : 'Leave',
            cancelLabel: 'Cancel',
            danger: true
        });
        if (ok) leaveRoom();
    });
    $('#start-game-btn').addEventListener('click', startGame);
    // Legacy bottom-of-recap end-stage buttons were removed - guard
    // the listeners so a future re-add Just Works.
    const endBack = $('#end-back-btn');
    if (endBack) endBack.addEventListener('click', () => leaveRoom());
    // Guest sign-up CTA on the end stage routes through the existing
    // sign-in modal. linkWithCredential would carry the guest's stats
    // over if we wanted to preserve them, but for now we treat sign-up
    // as a fresh start since guest stats were never persisted anyway.
    const endGuestCtaBtn = $('#end-guest-cta-btn');
    if (endGuestCtaBtn) endGuestCtaBtn.addEventListener('click', () => openSignInPrompt());
    const endShareBtn = $('#end-share-btn');
    if (endShareBtn) endShareBtn.addEventListener('click', () => shareResultCard());
    const settingsEditBtn = $('#room-settings-edit-btn');
    if (settingsEditBtn) settingsEditBtn.addEventListener('click', () => openRoomSettingsEditor());
    const settingsCancel = $('#room-settings-cancel');
    if (settingsCancel) settingsCancel.addEventListener('click', () => closeRoomSettingsEditor());
    const settingsSave = $('#room-settings-save');
    if (settingsSave) settingsSave.addEventListener('click', () => saveRoomSettings());
    const switchGameTypeBtn = $('#room-switch-game-type-btn');
    if (switchGameTypeBtn) switchGameTypeBtn.addEventListener('click', () => switchRoomGameType());
    const endAgainHandler = () => {
        // Solo: skip the accept gate, restart immediately.
        const playMode = (state.roomData && state.roomData.playMode) || 'multi';
        if (playMode === 'solo') playAgain();
        else proposeRematch();
    };
    const endAgainBtn = $('#end-again-btn');
    if (endAgainBtn) endAgainBtn.addEventListener('click', endAgainHandler);
    const headerRematchBtn = $('#room-end-again-btn');
    if (headerRematchBtn) headerRematchBtn.addEventListener('click', endAgainHandler);
    $('#rematch-accept-btn').addEventListener('click', () => respondToRematch(true));
    $('#rematch-decline-btn').addEventListener('click', () => respondToRematch(false));
    const proposalCancelBtn = $('#proposal-cancel-btn');
    if (proposalCancelBtn) proposalCancelBtn.addEventListener('click', () => cancelOwnProposal('cancel'));

    // GlobeDrop controls (wired once; they no-op when no GlobeDrop room is active)
    const submitBtn = $('#globe-drop-submit-btn');
    if (submitBtn) submitBtn.addEventListener('click', () => { Feedback.guessSubmitted(); submitGuess(); });
    const readyBtn = $('#globe-drop-ready-btn');
    if (readyBtn) readyBtn.addEventListener('click', () => markReadyForNext());
    const clearBtn = $('#globe-drop-clear-btn');
    if (clearBtn) clearBtn.addEventListener('click', () => { Feedback.pinCleared(); clearMyPin(); });
    const standingsToggle = $('#globe-drop-standings-toggle');
    if (standingsToggle) standingsToggle.addEventListener('click', () => {
        state.standingsCollapsed = !state.standingsCollapsed;
        applyStandingsCollapsed();
        // Expanding satisfies the "something new to see" cue - stop pulsing.
        if (!state.standingsCollapsed) standingsToggle.classList.remove('is-pulsing');
    });

    $('#room-code-copy').addEventListener('click', async () => {
        if (!state.roomCode) return;
        try {
            await navigator.clipboard.writeText(state.roomCode);
            const btn = $('#room-code-copy');
            const original = btn.innerHTML;
            btn.innerHTML = '✓';
            setTimeout(() => { btn.innerHTML = original; }, 1200);
        } catch (e) { /* ignore */ }
    });

    // Copy a full invite link to the clipboard. Opening the URL in any
    // browser pre-fills the room code; signed-in friends auto-join and
    // signed-out friends get the sign-in modal pop on landing.
    const shareBtn = $('#room-code-share');
    if (shareBtn) shareBtn.addEventListener('click', async () => {
        if (!state.roomCode) return;
        const link = buildInviteLink(state.roomCode);
        try {
            await navigator.clipboard.writeText(link);
            const original = shareBtn.innerHTML;
            shareBtn.innerHTML = '✓';
            setTimeout(() => { shareBtn.innerHTML = original; }, 1200);
            showToast('Invite link copied', { icon: '🔗', key: 'invite-link' });
        } catch (e) {
            showToast('Could not copy link', { icon: '⚠️', key: 'invite-link-fail' });
        }
    });

    // Mid-game controls (all players).
    const pauseBtn = $('#room-pause-btn');
    const endBtn = $('#room-end-btn');
    const restartBtn = $('#room-restart-btn');
    if (pauseBtn) pauseBtn.addEventListener('click', () => togglePauseRoom());
    if (endBtn) endBtn.addEventListener('click', () => hostEndGameEarly());
    if (restartBtn) restartBtn.addEventListener('click', () => proposeMidGameRestart());
}

/**
 * Mid-match Restart. Solo just calls playAgain directly. Multi proposes
 * a unanimous-accept restart via the same rematch coordination fields
 * used on the end stage.
 */
async function proposeMidGameRestart() {
    if (!state.user || !state.roomCode || !state.roomData) return;
    if (actionRemaining('restart') <= 0) return;
    const playMode = state.roomData.playMode || 'multi';
    if (playMode === 'solo') {
        const ok = await openConfirmModal({
            title: 'Restart your run?',
            body: 'A fresh set of locations will be drawn. The current run will end.',
            confirmLabel: 'Restart',
            danger: true
        });
        if (ok && consumeActionAllowance('restart')) {
            // playAgain expects the room to be 'finished' to advance the
            // round counter cleanly, but it works from any state. For
            // solo we can call it directly.
            playAgain();
        }
        return;
    }
    if (rematchPlayerCount() < 2) return;
    const ok = await openConfirmModal({
        title: 'Restart the game?',
        body: 'All players must accept before the game restarts.',
        confirmLabel: 'Propose restart',
        danger: false
    });
    if (!ok) return;
    if (!consumeActionAllowance('restart')) return;
    await proposeRematch();
}

function clearJoinError() {
    const e = $('#join-error');
    setText(e, '');
    e.hidden = true;
}

function showJoinError(msg) {
    const e = $('#join-error');
    setText(e, msg);
    e.hidden = false;
}

async function createRoom(opts) {
    if (!state.user) {
        // Visitor hasn't signed up - drop them into anonymous (guest)
        // mode so they can try the game with zero friction. Their room
        // and player docs are ephemeral; leaveRoom + the TTL sweep wipe
        // them. Persistent writes (leaderboard, H2H, profile) skip
        // guests entirely (see writeEndOfGameStats / maybeWriteH2HPairs).
        await ensureGuestAuth();
        if (!state.user) { openSignInPrompt(); return; }
    }
    // mode = 'multi' (default) | 'solo' | 'daily'.
    // - solo: private, single-player, auto-starts as soon as the room exists
    // - daily: like solo, plus deterministic location seeding by UTC date
    //          and an end-of-game write to globeDropDailyLeaderboard
    const mode = (opts && opts.mode) || 'multi';
    const isSoloLike = mode === 'solo' || mode === 'daily';

    const gameType = isSoloLike
        ? 'globe-drop'
        : (state.selectedGameType === 'globe-drop' ? 'globe-drop' : 'trivia');

    // Which game and which mode people pick is the whole product question for
    // Arena. Both values are fixed enumerations defined right here, not user
    // input, and neither identifies the room or the players.
    track('trackAction', 'room_created', { game_type: gameType, room_mode: mode });

    // Solo / daily rooms are always private to keep them out of any future
    // public-room discovery. They have no password - only this user is in
    // them, and the room code itself acts as the (single-use) secret.
    const isPrivate = isSoloLike ? true : !!$('#create-private-toggle').checked;
    const password = (isPrivate && !isSoloLike) ? String($('#create-password').value || '').trim() : '';
    const passwordWarning = $('#create-password-warning');
    if (passwordWarning) passwordWarning.hidden = true;
    if (isPrivate && !isSoloLike && !password) {
        if (passwordWarning) {
            passwordWarning.hidden = false;
            const pwInput = $('#create-password');
            if (pwInput) {
                pwInput.focus();
                pwInput.addEventListener('input', () => { passwordWarning.hidden = true; }, { once: true });
            }
        }
        return;
    }

    // Anything but pure solo publishes the name to a surface other
    // players read (room player list + chat for multi, the daily board
    // for daily), so confirm it first.
    let chosenName = (state.profile && state.profile.displayName) || deriveInitialDisplayName();
    if (mode !== 'solo') {
        chosenName = await ensureDisplayNameChosen();
        if (!chosenName) return;
    }

    const btn = isSoloLike
        ? (mode === 'daily' ? $('#play-daily-btn') : $('#play-solo-btn'))
        : $('#create-room-btn');
    // innerHTML preserves the inline SVG icon. textContent would
    // strip it on restore and leave the button text-only.
    const originalLabel = btn.innerHTML;
    btn.disabled = true;

    try {
        const code = await reserveUniqueRoomCode();
        const ref = doc(db, 'triviaRooms', code);
        const displayName = chosenName;
        // The password is deliberately NOT part of the room doc: the room
        // doc is readable by any signed-in user with the code, so a
        // cleartext password there was world-readable (defect 22). Private
        // rooms instead persist a hash in /private/gate below.
        const shared = {
            code,
            hostUid: state.user.uid,
            status: 'lobby',
            isPrivate,
            gameType,
            currentQuestionIndex: 0,
            questionStartedAt: null,
            round: 1,
            createdAt: serverTimestamp(),
            finishedAt: null
        };

        if (gameType === 'globe-drop') {
            btn.innerHTML = mode === 'daily' ? "Loading today's challenge…" : 'Fetching locations…';
            const count = Math.max(
                Config.GLOBE_DROP_LOCATIONS_MIN,
                parseInt($('#create-locations-count').value, 10) || Config.GLOBE_DROP_LOCATIONS_DEFAULT
            );
            // Daily is the only mode that forces its settings (so every
            // player who plays a given day faces the same parameters).
            // Solo passes through the form selections the user picked.
            const isDaily = mode === 'daily';
            const difficultyKey = isDaily
                ? 'medium'
                : ($('#create-globe-drop-difficulty').value || Config.GLOBE_DROP_DIFFICULTY_DEFAULT);
            const diff = GlobeDropScoring.difficultySettings(difficultyKey);
            // Manual timer override applies when the host (or solo player)
            // opts in via the toggle. Daily skips it so the day's seed
            // produces identical games for everyone.
            const overrideTimer = !isDaily && !!$('#create-globe-drop-timer-override').checked;
            const seconds = overrideTimer
                ? (parseInt($('#create-globe-drop-time').value, 10) || diff.timerSec)
                : diff.timerSec;
            const roundType = isDaily
                ? 'capitals'
                : ($('#create-globe-drop-round-type').value || 'capitals');
            const meta = GlobeDropLocations.ROUND_TYPES[roundType] || GlobeDropLocations.ROUND_TYPES.capitals;

            let locations;
            let dailyDateKey = null;
            if (mode === 'daily') {
                // Daily challenge: pull an over-provisioned pool so the
                // seeded shuffle has room to vary the picks across days,
                // then seed the order by UTC date. Every player who plays
                // today gets exactly the same N locations.
                dailyDateKey = GlobeDropDaily.dailyDateKey(Date.now());
                const pool = await GlobeDropLocations.fetchLocations(roundType, Math.max(30, count * 4), (a) => a);
                locations = GlobeDropDaily.pickDailyLocations(pool, count, dailyDateKey);
            } else {
                locations = await GlobeDropLocations.fetchLocations(roundType, count, shuffle);
            }

            // Difficulty-driven scaling: each location is stamped with
            // a multiplier from the [1.0, 1.5, 2.0, 2.5, 3.0] ladder
            // based on its own continent rarity × population obscurity
            // - NOT its position in the playlist. Famous capitals are
            // worth less; obscure island states are worth more. (Major-cities
            // is the exception: its multiplier is continent-based - see
            // applyRoundMultipliers / assignDifficultyMultipliers.)
            locations = applyRoundMultipliers(locations, roundType);

            await setDoc(ref, Object.assign({}, shared, {
                packId: meta.packId,
                packName: mode === 'daily' ? `${meta.packName} · daily ${dailyDateKey}` : meta.packName,
                totalQuestions: locations.length,
                questions: locations,
                roundType,
                difficulty: difficultyKey,
                playMode: mode, // 'multi' | 'solo' | 'daily'
                dailyDateKey,
                // Per-question timer chosen by tier (or override). Stored in
                // ms so the pure phase helpers don't have to know about the
                // unit choice.
                questionTimeMs: seconds * 1000
            }));
        } else {
            // B2: read the question source the host picked. Falls back to the
            // live API when the picker is absent or holds a stale 'custom'
            // whose pack has since been cleared, so a missing pack can never
            // create an unplayable room.
            const packSel = $('#create-pack-select');
            const wanted = packSel ? packSel.value : 'live';
            const sel = (wanted === 'custom' && state.customPack) ? 'custom' : 'live';
            const count = parseInt($('#create-questions-count').value, 10) || 10;
            const seconds = parseInt($('#create-trivia-time').value, 10) || 15;
            btn.innerHTML = 'Fetching questions…';
            const { questions, packId, packName } = await buildQuestionsForRound(sel, count);
            await setDoc(ref, Object.assign({}, shared, {
                packId,
                packName,
                // questions[] is the over-provisioned pool for picker variety;
                // totalQuestions is what the user actually plays.
                totalQuestions: count,
                questions,
                questionTimeMs: seconds * 1000
            }));
        }

        // Password gate (defect 22). Private multiplayer rooms store
        // SHA-256(password + ':' + code) in a subdocument no client can
        // read; firestore.rules verifies a joiner's member-doc gateHash
        // against it via get(). Solo/daily rooms have no password but
        // must stay unjoinable by strangers who guess the code, so they
        // get a random hash no password can ever derive. The gate doc is
        // written before the host's own player doc because the member-
        // create rule starts enforcing the gate the moment it exists -
        // the host passes it with the same hash.
        let gateHash = null;
        if (isPrivate) {
            gateHash = isSoloLike
                ? RoomGate.randomGateHash()
                : await RoomGate.computeRoomGateHash(password, code);
            await setDoc(doc(db, 'triviaRooms', code, 'private', 'gate'), { hash: gateHash });
        }

        try {
            await joinPlayer(code, displayName, /* isHost */ true, -1, gateHash);
        } catch (err) {
            // The room doc is already written; without the host's player doc
            // it would be an orphan nobody can ever sweep (audit D2). Roll it
            // back (host may delete the room; the gate is sweepable once the
            // room is gone).
            try { await deleteDoc(ref); } catch (_) { /* best-effort */ }
            if (isPrivate) { try { await deleteDoc(doc(db, 'triviaRooms', code, 'private', 'gate')); } catch (_) { /* best-effort */ } }
            throw err;
        }
        enterRoom(code);

        // Solo / daily rooms auto-start so the user lands straight in the
        // game stage. We wait one tick for the snapshot listener to populate
        // state.roomData (startGame reads it as a guard) before flipping
        // status to 'playing'. The startGame guard then sees the same room
        // we just created and triggers the normal play flow.
        if (isSoloLike) {
            const tryStart = async () => {
                if (state.roomData && state.roomData.status === 'lobby') {
                    await startGame();
                } else {
                    setTimeout(tryStart, 80);
                }
            };
            tryStart();
        }
    } catch (err) {
        console.warn('Room creation failed:', err);
        // The live APIs (The Trivia API + REST Countries) are the only
        // built-in question/location sources - there's no offline pack to
        // fall back to. Surface the failure so the host knows to retry.
        alert(
            (gameType === 'globe-drop' ? 'Could not fetch locations: ' : 'Could not fetch questions: ')
            + (err && err.message ? err.message : 'unknown error')
            + '. Try again in a moment.'
        );
    } finally {
        btn.disabled = false;
        btn.innerHTML = originalLabel;
    }
}

async function reserveUniqueRoomCode() {
    // Try a handful of times - collisions on a 31^5 space are vanishingly rare.
    for (let i = 0; i < 6; i++) {
        const code = RoomState.generateRoomCode();
        const snap = await getDoc(doc(db, 'triviaRooms', code));
        if (!snap.exists()) return code;
    }
    throw new Error('Could not reserve a room code; try again.');
}

/**
 * When the join-code input reaches full length, peek at the room doc so
 * the password field can appear proactively (instead of forcing a
 * click → fail → type → click-again loop). Lookups are cheap and gated
 * by Firestore rules; signed-out users get a no-op.
 *
 * Race notes:
 *   - We tag each request with the typed code; only the most-recent
 *     request updates the DOM. Otherwise a slow lookup for an earlier
 *     prefix could overwrite a newer one.
 *   - Any error (not signed in, doc missing, transient) just clears the
 *     field - the user will see the real error when they click Join.
 */
let joinPeekToken = 0;
function setJoinPwFieldVisible(visible) {
    const el = $('#join-password-field');
    if (visible) el.removeAttribute('hidden');
    else el.setAttribute('hidden', '');
}
async function maybeRevealJoinPasswordField(rawValue) {
    const code = RoomState.normalizeRoomCode(rawValue);
    if (!code) { setJoinPwFieldVisible(false); return; }
    if (!state.user) return; // can't peek; rules require auth
    const token = ++joinPeekToken;
    try {
        const snap = await getDoc(doc(db, 'triviaRooms', code));
        if (token !== joinPeekToken) return;
        const isPrivate = snap.exists() && !!snap.data().isPrivate;
        if (isPrivate) {
            setJoinPwFieldVisible(true);
        } else {
            setJoinPwFieldVisible(false);
            $('#join-password').value = '';
        }
    } catch (_) {
        if (token === joinPeekToken) setJoinPwFieldVisible(false);
    }
}

async function joinRoom() {
    if (!state.user) {
        // Same guest-mode fallback as createRoom - sign in anonymously
        // so the visitor can join a friend's room without making an
        // account first.
        await ensureGuestAuth();
        if (!state.user) { openSignInPrompt(); return; }
    }
    clearJoinError();
    const raw = $('#join-code').value;
    const code = RoomState.normalizeRoomCode(raw);
    if (!code) {
        showJoinError(`Enter a ${Config.ROOM_CODE_LENGTH}-character room code.`);
        return;
    }
    const ref = doc(db, 'triviaRooms', code);
    const snap = await getDoc(ref);
    if (!snap.exists()) {
        showJoinError('Room not found.');
        return;
    }
    const data = snap.data();
    if (data.status === 'finished') {
        showJoinError('That room has already finished.');
        return;
    }

    let gateHash = null;
    if (data.isPrivate) {
        const passwordField = $('#join-password-field');
        passwordField.hidden = false;
        const password = String($('#join-password').value || '').trim();
        if (!password) {
            showJoinError('This room is private. Enter the password.');
            return;
        }
        if (typeof data.password === 'string' && data.password) {
            // Legacy room created before the hashed gate (defect 22): the
            // cleartext password still sits on the room doc, so compare it
            // client-side exactly as before. New rooms never write
            // data.password, so this branch dies out as old rooms expire.
            if (password !== data.password) {
                showJoinError('Incorrect password.');
                return;
            }
        } else {
            // Hashed gate: the proof rides the member-doc create and
            // firestore.rules verifies it against the unreadable
            // /private/gate doc. A wrong password surfaces below as
            // permission-denied on joinPlayer.
            gateHash = await RoomGate.computeRoomGateHash(password, code);
        }
    }

    // Capacity guard
    const playersSnap = await getDocs(collection(db, 'triviaRooms', code, 'players'));
    if (playersSnap.size >= Config.MAX_PLAYERS_PER_ROOM) {
        showJoinError('That room is full.');
        return;
    }

    const displayName = await ensureDisplayNameChosen();
    if (!displayName) return;
    // Mark the player as a spectator if they're joining mid-game so the UI
    // can show a "Spectating - joining next round" banner and gate submitting.
    const isSpectator = data.status === 'playing';
    try {
        await joinPlayer(code, displayName, /* isHost */ false,
            isSpectator ? (data.currentQuestionIndex || 0) : -1, gateHash);
    } catch (err) {
        // The rules gate rejects a bad hash as permission-denied; map it
        // to the same message the legacy compare shows.
        if (gateHash && err && err.code === 'permission-denied') {
            showJoinError('Incorrect password.');
        } else {
            console.warn('Join failed:', err);
            showJoinError('Could not join the room. Please try again.');
        }
        return;
    }
    // Reported only after every guard has passed and the player doc is
    // written, so a wrong password, a full room or an abandoned name prompt is
    // never counted as a join. The room code is a shared secret that grants
    // entry, and the display name is user-entered - neither is sent.
    track('trackAction', 'room_joined', {
        game_type: data.gameType || 'unknown',
        joined_as: isSpectator ? 'spectator' : 'player',
    });
    enterRoom(code);
}

async function joinPlayer(code, displayName, isHost, joinedAtQuestionIndex, gateHash) {
    const pref = doc(db, 'triviaRooms', code, 'players', state.user.uid);
    // Pull the room's current round so we don't carry stale "joinedAt round 1"
    // markers into round 2+. We can't write across players, so each player
    // is responsible for keeping their own `round` field current.
    let currentRound = 1;
    try {
        const roomSnap = await getDoc(doc(db, 'triviaRooms', code));
        if (roomSnap.exists()) currentRound = roomSnap.data().round || 1;
    } catch (e) { /* fall back to 1 */ }

    // Check for an existing player doc written by beforeUnloadCleanup - if
    // disconnectedAt is within the grace window, restore the player's
    // score/streak/answers instead of resetting them to 0.
    let existingSnap = null;
    try { existingSnap = await getDoc(pref); } catch (e) { /* ignore */ }
    const existing = existingSnap && existingSnap.exists() ? existingSnap.data() : null;
    const now = Date.now();
    const withinGrace = existing
        && typeof existing.disconnectedAt === 'number'
        && (now - existing.disconnectedAt) < DISCONNECT_GRACE_MS;

    if (withinGrace) {
        // Reconnect path: clear the disconnectedAt flag and refresh lastSeen.
        // Score, streak, answers, and currentAnsweredFor are preserved.
        await updateDoc(pref, {
            displayName: String(displayName).slice(0, Config.MAX_DISPLAY_NAME),
            disconnectedAt: deleteField(),
            lastSeen: serverTimestamp()
        });
        return;
    }

    // joinedAtQuestionIndex >= 0 means the player joined mid-game and should
    // spectate the current question (gate: their joinedAtQuestionIndex === the
    // room's currentQuestionIndex at join time). -1 = joined at lobby, full participant.
    const doc_data = {
        uid: state.user.uid,
        displayName: String(displayName).slice(0, Config.MAX_DISPLAY_NAME),
        isHost: !!isHost,
        score: 0,
        streak: 0,
        round: currentRound,
        joinedAt: serverTimestamp(),
        lastSeen: serverTimestamp(),
        currentAnswerIndex: null,
        currentAnswerAt: null,
        currentAnsweredFor: null,
        answers: [],
        // Lets a registered opponent skip the lifetime H2H pair write for
        // this player: anon uids would only ever orphan pair rows.
        isGuest: isGuest()
    };
    if (typeof joinedAtQuestionIndex === 'number' && joinedAtQuestionIndex >= 0) {
        doc_data.joinedAtQuestionIndex = joinedAtQuestionIndex;
    }
    // Proof-of-password for gated rooms: firestore.rules compares this
    // against the unreadable /private/gate hash on member CREATE. It is
    // visible to signed-in users who can read player docs - the password
    // itself never is (see js/room-gate.js for the boundary discussion).
    if (gateHash) {
        doc_data.gateHash = gateHash;
    }
    await setDoc(pref, doc_data, { merge: true });
}

function openSignInPrompt() {
    // Reuse main.js modal if present
    if (window.authUI && typeof window.authUI.openModal === 'function') {
        window.authUI.openModal();
    } else {
        const m = document.querySelector('#auth-modal');
        if (m) m.classList.add('auth-modal--visible');
    }
}

/* =====================================================================
 * Room lifecycle
 * ===================================================================== */

function enterRoom(code) {
    state.roomCode = code;
    state.currentAnswers = [];
    state.submittedQuestionId = null;
    show($('#room-panel'));
    hide($('#lobby-panel'));
    setText($('#room-code-display'), code);
    syncUrlToState();
    startChatListener(code);

    // Pre-warm the Earth texture as soon as we enter the room. Decoding it
    // is the single biggest chunk inside Globe()(el). Browsers cache decoded
    // bitmap data, so once this <img> resolves, the later globe init reuses
    // it instead of re-fetching + re-decoding - moving most of the >200ms
    // cost off the game-start critical path.
    // Item 10b: warm the asset ensureGlobe will actually ask for. This used
    // to fetch earth-8k.jpg unconditionally, so a phone paid ~4.5 MB for a
    // texture it never uses (it renders the 2k one).
    if (!state.earthTextureWarmed) {
        state.earthTextureWarmed = true;
        try {
            const img = new Image();
            img.decoding = 'async';
            img.src = isMobileGlobeViewport() ? 'data/earth-2k.jpg' : 'data/earth-8k.jpg';
            // No need to await; the load+decode happens in the background
            // and the browser's image cache fields the second request.
        } catch (_) { /* best-effort */ }
    }

    // window.beforeunload cleanup so the player removes themselves on tab close
    window.addEventListener('beforeunload', beforeUnloadCleanup);
    startPresenceAndClock(code);

    // Subscribe to room doc + players
    const roomRef = doc(db, 'triviaRooms', code);
    const playersRef = collection(db, 'triviaRooms', code, 'players');

    state.roomUnsubs.push(onSnapshot(roomRef, (snap) => {
        if (!snap.exists()) {
            // Room got deleted while we were in it.
            leaveRoom({ silent: true, reason: 'Room closed.' });
            return;
        }
        state.roomData = snap.data();
        maybeResetForNewRound();
        renderRoom();
    }));

    state.roomUnsubs.push(onSnapshot(playersRef, (snap) => {
        const prev = state.roomPlayers;
        const next = snap.docs.map((d) => d.data());
        notifyOpponentSubmissions(prev, next);
        state.roomPlayers = next;
        renderRoom();
    }));
}

/**
 * Audio ping when an opponent transitions from "not answered" to
 * "answered" for the current question. No toast, no pulse banner -
 * the green name tint + ✓ on the mini-board carries the visual
 * signal. Skipped for the local player (their own submission gets
 * a louder cue from guessSubmitted) and for any submission that
 * lands during the reveal phase.
 */
function notifyOpponentSubmissions(prev, next) {
    if (!state.user || !state.roomCode || !state.roomData) return;
    if (state.roomData.status !== 'playing') return;
    if (state.roomData.revealStartedAt) return;
    const currentQId = state.roomData.currentQuestionId;
    if (!currentQId) return;
    const prevMap = new Map((prev || []).map((p) => [p.uid, p]));
    for (const np of next) {
        if (!np || !np.uid) continue;
        if (np.uid === state.user.uid) continue;                     // me
        if (np.currentAnsweredFor !== currentQId) continue;          // not on this question
        const before = prevMap.get(np.uid);
        if (before && before.currentAnsweredFor === currentQId) continue; // not new
        try { Feedback.opponentSubmitted(); } catch (_) { /* ignore */ }
    }
}

function flashStagePulse(message) {
    const el = document.getElementById('globe-drop-pulse');
    if (!el) return;
    el.textContent = message;
    el.removeAttribute('hidden');
    // Re-trigger CSS animation by cloning the node - the keyframes only
    // run on first mount, so swapping the element resets them.
    const replacement = el.cloneNode(true);
    el.parentNode.replaceChild(replacement, el);
    // Hide once the gd-pulse-out animation ends so the element leaves layout cleanly.
    replacement.addEventListener('animationend', (e) => {
        if (e.animationName === 'gd-pulse-out') {
            try { replacement.hidden = true; } catch (_) {}
        }
    });
}

// When the host bumps the room's `round` (Play Again), every client notices
// here and resets its OWN player doc to zero. We can't reset other players'
// docs (rules forbid it), so the self-reset pattern is how the round
// transitions cleanly without breaking permissions.
async function maybeResetForNewRound() {
    if (!state.user || !state.roomCode || !state.roomData) return;
    const roomRound = state.roomData.round || 1;
    const me = state.roomPlayers.find((p) => p.uid === state.user.uid);
    if (!me) return;
    const myRound = me.round || 1;
    if (myRound >= roomRound) return;
    try {
        await updateDoc(doc(db, 'triviaRooms', state.roomCode, 'players', state.user.uid), {
            score: 0,
            streak: 0,
            globeDropStreak: 0,
            round: roomRound,
            currentAnswerIndex: null,
            currentGuess: null,
            currentAnswerAt: null,
            currentAnsweredFor: null,
            answers: []
        });
    } catch (e) {
        console.warn('Round reset failed:', e);
    }
}

const DISCONNECT_GRACE_MS = Config.DISCONNECT_GRACE_MS; // rejoin-with-score window

/** Players in the room whose docs are live right now (see RoomState.isPlayerLive). */
function livePlayers() {
    return RoomState.livePlayers(state.roomPlayers, Date.now());
}

/**
 * Presence heartbeat + host-independent room clock (audit D3/D4).
 *
 * - Every PRESENCE_HEARTBEAT_MS the client stamps lastSeen on its own
 *   player doc, so a tab that dies without beforeunload still goes stale
 *   after PRESENCE_STALE_MS and the host can sweep it.
 * - progressRoomClock runs on a setInterval (browsers keep timers alive in
 *   hidden tabs, throttled to about once a second) and on visibilitychange,
 *   in addition to the rAF render loops, so a hidden host no longer freezes
 *   the room. Any member also advances the room itself once the question's
 *   window has elapsed plus a slack (the rules verify the deadline on the
 *   server clock), so a host that is gone entirely cannot stall the others.
 */
function startPresenceAndClock(code) {
    stopPresenceAndClock();
    const beat = async () => {
        if (state.roomCode !== code || !state.user) return;
        try {
            // `disconnectedAt` is cleared on every beat, not only on rejoin.
            // A player whose heart is beating is by definition not
            // disconnected, and this makes a dropped or racing rejoin write
            // self-healing rather than fatal 30 seconds later.
            await updateDoc(doc(db, 'triviaRooms', code, 'players', state.user.uid), {
                lastSeen: serverTimestamp(),
                disconnectedAt: deleteField(),
            });
        } catch (_) { /* swept or offline; the next beat retries */ }
    };
    state.heartbeatTimer = setInterval(beat, Config.PRESENCE_HEARTBEAT_MS);
    state.clockTimer = setInterval(() => {
        try { progressRoomClock(); } catch (e) { console.warn('room clock tick failed:', e); }
        // A player going stale is a passage of TIME, not a Firestore write, so
        // no snapshot fires and nothing re-renders: the lobby kept showing a
        // ghost as a live player indefinitely (audit D4). Re-render whenever
        // the live set changes.
        try {
            const sig = livePlayers().map((p) => p.uid).sort().join(',');
            if (sig !== state.liveSignature) {
                state.liveSignature = sig;
                if (state.roomData) renderRoom();
            }
        } catch (e) { /* a render failure must not kill the clock */ }
    }, 500);
    state.onVisibility = () => {
        if (document.visibilityState !== 'visible') return;
        beat();
        try { progressRoomClock(); } catch (_) { /* next tick */ }
    };
    document.addEventListener('visibilitychange', state.onVisibility);
}

function stopPresenceAndClock() {
    if (state.heartbeatTimer) { clearInterval(state.heartbeatTimer); state.heartbeatTimer = null; }
    if (state.clockTimer) { clearInterval(state.clockTimer); state.clockTimer = null; }
    if (state.onVisibility) { document.removeEventListener('visibilitychange', state.onVisibility); state.onVisibility = null; }
    state.sweptUids = {};
    state.liveSignature = null;
}

async function beforeUnloadCleanup() {
    if (!state.roomCode || !state.user) return;
    // Keep the player doc when the room is already in the post-match
    // stage - refreshing the page should land the player back on the
    // end screen, not bounce them to the lobby. tryRejoinPendingRoom
    // identifies them as a member via this doc on reload, then
    // renderRoom routes status=finished → renderEndStage.
    if (state.roomData && state.roomData.status === 'finished') return;
    try {
        // Write disconnectedAt timestamp instead of deleting the doc.
        // If the player reloads within DISCONNECT_GRACE_MS, joinPlayer
        // detects the grace window and restores their score/streak rather
        // than treating them as a fresh joiner. After the grace period
        // elapses without reconnect the doc is stale: every client excludes
        // it (RoomState.isPlayerLive) and the host sweeps it
        // (sweepStalePlayers; firestore.rules allows the host to delete a
        // stale doc).
        await updateDoc(doc(db, 'triviaRooms', state.roomCode, 'players', state.user.uid), {
            disconnectedAt: Date.now(),
            lastSeen: serverTimestamp()
        });
    } catch (e) { /* best-effort; deletion still happens via joinPlayer on fresh join */ }
}

/**
 * Sweep everything a deleted room leaves behind: chat messages, the
 * password gate, and any ghost player docs (Firestore never cascades
 * subcollection deletes). Must run AFTER the room doc is gone: that is the
 * lifecycle point at which firestore.rules lets any signed-in user delete
 * those docs (while the room lives, chat is append-only and the gate is
 * host-only). Best-effort: any single failure is swallowed.
 */
async function sweepRoomLeftovers(code, leftoverPlayerUids) {
    if (!code) return;
    const tasks = [];
    try {
        const snap = await getDocs(collection(db, 'triviaRooms', code, 'chat'));
        snap.docs.forEach((d) => tasks.push(deleteDoc(doc(db, 'triviaRooms', code, 'chat', d.id)).catch(() => {})));
    } catch (e) { /* ignore */ }
    tasks.push(deleteDoc(doc(db, 'triviaRooms', code, 'private', 'gate')).catch(() => {}));
    (leftoverPlayerUids || []).forEach((uid) => {
        tasks.push(deleteDoc(doc(db, 'triviaRooms', code, 'players', uid)).catch(() => {}));
    });
    await Promise.all(tasks);
}

/**
 * Host-only: delete player docs that are past the disconnect grace or the
 * presence window (firestore.rules allows the host to delete a STALE doc
 * only). Ghosts otherwise block early reveal, unanimous rematch and the
 * last-leaver room deletion (audit D4). Each uid is tried once per room.
 */
function sweepStalePlayers() {
    if (!state.roomCode || !state.user || !state.roomData) return;
    if (state.roomData.hostUid !== state.user.uid) return;
    const now = Date.now();
    for (const p of state.roomPlayers) {
        if (!p || !p.uid || p.uid === state.user.uid) continue;
        if (RoomState.isPlayerLive(p, now)) continue;
        if (state.sweptUids[p.uid]) continue;
        state.sweptUids[p.uid] = true;
        deleteDoc(doc(db, 'triviaRooms', state.roomCode, 'players', p.uid))
            .catch(() => { delete state.sweptUids[p.uid]; });
    }
}

async function leaveRoom({ silent = false, reason = null } = {}) {
    const code = state.roomCode;
    state.roomUnsubs.splice(0).forEach((u) => { try { u(); } catch (e) {} });
    if (state.timerRaf) { cancelAnimationFrame(state.timerRaf); state.timerRaf = null; }
    window.removeEventListener('beforeunload', beforeUnloadCleanup);
    stopPresenceAndClock();

    state.roomCode = null;
    state.roomData = null;
    state.roomPlayers = [];
    state.postMatchCode = null;
    state.submittedQuestionId = null;
    state.currentAnswers = [];
    state.actionCounts = {};
    state.lastRematchPromptShown = null;
    state.finalPlayers = [];
    state.finalPlayersRound = null;
    lastStatusPlayedFeedback = null;
    stopChatListener();
    closeChatPanel();

    if (code && state.user) {
        const myUid = state.user.uid;
        try {
            const roomSnap = await getDoc(doc(db, 'triviaRooms', code));
            const room = roomSnap.exists() ? roomSnap.data() : null;
            const remaining = await getDocs(collection(db, 'triviaRooms', code, 'players'));
            const now = Date.now();
            const all = remaining.docs.map((d) => d.data());
            const others = all.filter((p) => p && p.uid !== myUid);
            const liveOthers = RoomState.livePlayers(others, now);
            let iAmHost = !!(room && room.hostUid === myUid);
            // Ghost host (tab died without leaving): the rules let a member
            // take over hostUid once the host's player doc is gone or stale.
            // Must happen BEFORE my own player doc is deleted, because the
            // takeover requires membership.
            if (room && !iAmHost) {
                const hostDoc = all.find((p) => p && p.uid === room.hostUid);
                if (!hostDoc || !RoomState.isPlayerLive(hostDoc, now)) {
                    try {
                        await updateDoc(doc(db, 'triviaRooms', code), { hostUid: myUid });
                        iAmHost = true;
                    } catch (e) { /* the host came back in the meantime */ }
                }
            }
            try {
                await deleteDoc(doc(db, 'triviaRooms', code, 'players', myUid));
            } catch (e) { /* ignore */ }
            if (room && iAmHost) {
                if (!liveOthers.length) {
                    // Last live player: delete the room doc FIRST (host-only
                    // under the rules), then sweep chat, the gate and any
                    // ghost player docs, which the rules allow for anyone
                    // once the room doc is gone.
                    await deleteDoc(doc(db, 'triviaRooms', code));
                    await sweepRoomLeftovers(code, others.map((p) => p.uid));
                } else {
                    const nextHost = RoomState.pickNextHost(liveOthers.map((p) => ({
                        uid: p.uid,
                        joinedAt: p.joinedAt && p.joinedAt.toMillis ? p.joinedAt.toMillis() : 0
                    })));
                    if (nextHost) {
                        await updateDoc(doc(db, 'triviaRooms', code), { hostUid: nextHost });
                    }
                }
            }
        } catch (e) { /* ignore */ }
    }

    show($('#lobby-panel'));
    hide($('#room-panel'));
    hide($('#stage-end'));
    hide($('#stage-game'));
    hide($('#stage-globe-drop'));
    hide($('#stage-picking'));
    show($('#stage-lobby'));
    // Clear the join-code input so the previous room's code doesn't
    // pre-populate the next attempt. Same for the password field below.
    const codeInput = $('#join-code');
    if (codeInput) codeInput.value = '';
    const joinPw = $('#join-password');
    if (joinPw) joinPw.value = '';
    setJoinPwFieldVisible(false);
    clearJoinError();
    // B8: `silent` means "no blocking alert", not "say nothing". A room that
    // vanishes under a player (host closed it, cleanup) used to bounce them to
    // the lobby with no explanation at all; the reason now rides a toast.
    if (reason) {
        if (silent) showToast(reason, { icon: '👋', key: 'room-left-reason' });
        else alert(reason);
    }
    teardownMap();
    syncUrlToState();
}

/* =====================================================================
 * Render room (lobby, asking, reveal, end)
 * ===================================================================== */

/* =====================================================================
 * Host mid-game controls (pause / skip / end)
 * ===================================================================== */

function isHostOfActiveRoom() {
    return !!(state.roomCode && state.roomData
        && state.user && state.roomData.hostUid === state.user.uid);
}

/**
 * Per-player rate limits on mid-game control actions, keyed by room.
 * Resets when leaveRoom() runs. Limits are intentionally generous -
 * they exist to prevent griefing (one player spamming pause / restart
 * proposals), not to punish honest use.
 */
const ACTION_LIMITS = { pause: 2, restart: 3, end: 3 };
function actionCount(kind) {
    state.actionCounts = state.actionCounts || {};
    return state.actionCounts[kind] || 0;
}
function actionRemaining(kind) {
    return Math.max(0, (ACTION_LIMITS[kind] || 0) - actionCount(kind));
}
function consumeActionAllowance(kind) {
    state.actionCounts = state.actionCounts || {};
    const used = state.actionCounts[kind] || 0;
    if (used >= (ACTION_LIMITS[kind] || 0)) return false;
    state.actionCounts[kind] = used + 1;
    return true;
}

async function togglePauseRoom() {
    if (!state.user || !state.roomCode) return;
    const room = state.roomData;
    if (!room || room.status !== 'playing') return;
    const ref = doc(db, 'triviaRooms', state.roomCode);
    try {
        if (room.paused) {
            // Resume: bump questionStartedAt forward by the time the
            // game spent paused, so the remaining-time math picks up
            // exactly where the player left off. pausedAt is whatever
            // serverTimestamp resolved to when we paused.
            const pausedAtMs = room.pausedAt && room.pausedAt.toMillis ? room.pausedAt.toMillis() : Date.now();
            const elapsedPause = Math.max(0, Date.now() - pausedAtMs);
            const startMs = room.questionStartedAt && room.questionStartedAt.toMillis
                ? room.questionStartedAt.toMillis() : Date.now();
            // Re-anchor questionStartedAt to (originalStart + elapsedPause).
            // We can't easily write a server-side adjusted timestamp, so we
            // write a plain Date millisecond-converted value via new Date().
            await updateDoc(ref, {
                paused: false,
                pausedAt: null,
                pausedByUid: null,
                pausedByName: null,
                questionStartedAt: new Date(startMs + elapsedPause)
            });
        } else {
            // Per-player pause limit: 2 per room. Bail BEFORE writing.
            if (!consumeActionAllowance('pause')) return;
            const myName = (state.profile && state.profile.displayName)
                || deriveInitialDisplayName();
            await updateDoc(ref, {
                paused: true,
                pausedAt: serverTimestamp(),
                pausedByUid: state.user.uid,
                pausedByName: myName
            });
        }
    } catch (err) {
        console.warn('togglePauseRoom failed:', err);
    }
}

async function hostEndGameEarly() {
    if (!state.user || !state.roomCode) return;
    const room = state.roomData;
    if (!room) return;
    const isSolo = room.playMode === 'solo';
    if (actionRemaining('end') <= 0) return;
    const ok = await openConfirmModal({
        title: isSolo ? 'End your run?' : 'End the game for everyone?',
        body: isSolo
            ? 'Your run will end now and the final score screen will show.'
            : 'Final scores will be tallied with everyone\'s current points and the room will go to the end screen.',
        confirmLabel: 'End game',
        danger: true
    });
    if (!ok) return;
    if (!consumeActionAllowance('end')) return;
    try {
        await updateDoc(doc(db, 'triviaRooms', state.roomCode), {
            status: 'finished',
            finishedAt: serverTimestamp(),
            paused: false,
            pausedAt: null,
            finalRanking: currentFinalRanking()
        });
    } catch (err) {
        console.warn('hostEndGameEarly failed:', err);
    }
}

/* =====================================================================
 * Chat - per-room subcollection at triviaRooms/{code}/chat
 * ===================================================================== */

const chatState = {
    open: false,
    messages: [],
    unsub: null,
    lastSentAt: null,
    unreadSince: 0
};

function openChatPanel() {
    chatState.open = true;
    const panel = $('#room-chat-panel');
    if (panel) panel.hidden = false;
    chatState.unreadSince = chatState.messages.length;
    updateChatBadge();
    // Show "Game in progress" banner when a game is actively running.
    const liveBanner = document.getElementById('room-chat-game-live');
    if (liveBanner) liveBanner.hidden = !(state.roomData && state.roomData.status === 'playing');
    // Focus the input on open - feels conversational.
    const input = $('#room-chat-input');
    if (input) setTimeout(() => input.focus(), 50);
    scrollChatToBottom();
}

function closeChatPanel() {
    chatState.open = false;
    const panel = $('#room-chat-panel');
    if (panel) panel.hidden = true;
}

function updateChatBadge() {
    const badge = $('#room-chat-badge');
    if (!badge) return;
    const unread = Math.max(0, chatState.messages.length - chatState.unreadSince);
    if (chatState.open || unread === 0) {
        badge.hidden = true;
        return;
    }
    badge.textContent = unread > 9 ? '9+' : String(unread);
    badge.hidden = false;
}

function scrollChatToBottom() {
    const list = $('#room-chat-list');
    if (!list) return;
    list.scrollTop = list.scrollHeight;
}

function startChatListener(code) {
    stopChatListener();
    chatState.messages = [];
    chatState.unreadSince = 0;
    const chatRef = collection(db, 'triviaRooms', code, 'chat');
    const q = query(chatRef, orderBy('sentAt', 'asc'), limit(80));
    chatState.initialFillDone = false;
    chatState.lastNotifiedMessageId = null;
    chatState.unsub = onSnapshot(q, (snap) => {
        const prevLen = chatState.messages.length;
        chatState.messages = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        renderChatMessages();
        const wasInitialFill = !chatState.initialFillDone;
        // First fill is treated as "all read" so the badge doesn't show
        // 50 unread on first render. After that, growth = unread.
        if (wasInitialFill) {
            chatState.unreadSince = chatState.messages.length;
            chatState.initialFillDone = true;
            const newest0 = chatState.messages[chatState.messages.length - 1];
            chatState.lastNotifiedMessageId = newest0 ? newest0.id : null;
        }
        // Toast preview + sound for any genuinely-new message from another
        // player when the panel is closed. Works for both text and emoji
        // (emoji messages bypass moderation but otherwise look identical).
        const newest = chatState.messages[chatState.messages.length - 1];
        if (!wasInitialFill
            && !chatState.open
            && newest
            && state.user
            && newest.uid !== state.user.uid
            && newest.id !== chatState.lastNotifiedMessageId
            && prevLen < chatState.messages.length) {
            chatState.lastNotifiedMessageId = newest.id;
            showToast(`${newest.displayName || 'Player'}: ${newest.text}`, { icon: '💬', key: 'chat:' + newest.id });
            try { Feedback.chatMessage(); } catch (_) {}
        }
        updateChatBadge();
    }, (err) => {
        console.warn('Chat listener error:', err);
    });
}

function stopChatListener() {
    if (chatState.unsub) {
        try { chatState.unsub(); } catch (_) {}
        chatState.unsub = null;
    }
    chatState.messages = [];
    chatState.unreadSince = 0;
    chatState.initialFillDone = false;
    chatState.lastNotifiedMessageId = null;
    updateChatBadge();
}

function renderChatMessages() {
    const list = $('#room-chat-list');
    const empty = $('#room-chat-empty');
    if (!list) return;
    list.innerHTML = '';
    if (!chatState.messages.length) {
        if (empty) empty.hidden = false;
        return;
    }
    if (empty) empty.hidden = true;
    for (const m of chatState.messages) {
        const li = document.createElement('li');
        li.className = 'room-chat-msg';
        if (state.user && m.uid === state.user.uid) li.classList.add('is-mine');
        const sentMs = m.sentAt && m.sentAt.toMillis ? m.sentAt.toMillis() : null;
        const time = sentMs ? Chat.formatTimestamp(sentMs) : '';
        li.innerHTML =
            `<span class="room-chat-name">${escapeHtml(m.displayName || 'Player')}</span>` +
            (time ? `<span class="room-chat-time">${escapeHtml(time)}</span>` : '') +
            `<span class="room-chat-body">${escapeHtml(m.text || '')}</span>`;
        list.appendChild(li);
    }
    scrollChatToBottom();
}

async function sendChatMessage() {
    if (!state.user || !state.roomCode) return;
    const input = $('#room-chat-input');
    const err = $('#room-chat-error');
    const sendBtn = $('#room-chat-form') && $('#room-chat-form').querySelector('button[type="submit"]');
    if (err) { err.hidden = true; err.textContent = ''; }
    if (!input) return;
    const text = Chat.sanitizeText(input.value);
    if (!text) return;
    if (Chat.shouldRateLimit(chatState.lastSentAt, Date.now())) {
        if (err) { err.textContent = 'Slow down. Wait a moment before sending again.'; err.hidden = false; }
        return;
    }
    // Stamp the rate limit BEFORE the async work: stamping after `await
    // addDoc` let a second send 200 ms later pass the check (audit D11).
    chatState.lastSentAt = Date.now();
    // Local profanity check (chat.js wordlist; nothing leaves the browser).
    // Disable the send button while it runs so the user can't double-fire.
    // Fail-open: if the filter throws, allow the message through.
    if (sendBtn) sendBtn.disabled = true;
    let modResult;
    try {
        modResult = await Chat.checkProfanity(text);
    } catch (e) {
        modResult = { ok: false, error: 'unexpected' };
    }
    if (sendBtn) sendBtn.disabled = false;
    if (modResult.ok && modResult.blocked) {
        if (err) { err.textContent = 'That message was blocked by the profanity filter.'; err.hidden = false; }
        return;
    }
    if (!modResult.ok) {
        console.warn('chat profanity filter errored (fail-open):', modResult.error);
    }
    const displayName = (state.profile && state.profile.displayName) || deriveInitialDisplayName();
    try {
        await addDoc(collection(db, 'triviaRooms', state.roomCode, 'chat'), {
            uid: state.user.uid,
            displayName,
            text,
            sentAt: serverTimestamp()
        });
        input.value = '';
    } catch (e) {
        console.warn('sendChatMessage failed:', e);
        if (err) {
            const isPermDenied = e && (e.code === 'permission-denied'
                || /Missing or insufficient permissions/i.test(String(e.message || e)));
            err.textContent = isPermDenied
                ? 'Chat is locked until the Firestore rules for /triviaRooms/{code}/chat are published. Ask the site admin to redeploy rules.'
                : 'Could not send. Try again.';
            err.hidden = false;
        }
    }
}

function wireChat() {
    const toggle = $('#room-chat-toggle');
    const closeBtn = $('#room-chat-close');
    const form = $('#room-chat-form');
    if (toggle) toggle.addEventListener('click', () => {
        if (chatState.open) closeChatPanel();
        else openChatPanel();
    });
    if (closeBtn) closeBtn.addEventListener('click', closeChatPanel);
    if (form) form.addEventListener('submit', (e) => { e.preventDefault(); sendChatMessage(); });
    // The input silently truncated at maxlength (audit D16); say so.
    const chatInput = $('#room-chat-input');
    if (chatInput) chatInput.addEventListener('input', () => {
        const err = $('#room-chat-error');
        if (!err) return;
        const atCap = chatInput.value.length >= Chat.MAX_LEN;
        if (atCap) { err.textContent = `${Chat.MAX_LEN} character limit reached.`; err.hidden = false; }
        else if (/character limit/.test(err.textContent)) { err.textContent = ''; err.hidden = true; }
    });
    // Quick-emoji bar. One click sends the emoji as a chat message
    // bypassing the profanity filter (an emoji can't be flagged).
    document.querySelectorAll('.room-chat-quick-btn').forEach((btn) => {
        btn.addEventListener('click', () => sendChatEmoji(btn.dataset.emoji));
    });
}

async function sendChatEmoji(emoji) {
    if (!state.user || !state.roomCode || !emoji) return;
    // B17: same error surfacing as sendChatMessage. A silently dropped tap
    // (rate limit or write failure) read as "the button is broken".
    const err = $('#room-chat-error');
    if (err) { err.hidden = true; err.textContent = ''; }
    if (Chat.shouldRateLimit(chatState.lastSentAt, Date.now())) {
        if (err) { err.textContent = 'Slow down. Wait a moment before sending again.'; err.hidden = false; }
        return;
    }
    chatState.lastSentAt = Date.now();
    const displayName = (state.profile && state.profile.displayName) || deriveInitialDisplayName();
    try {
        await addDoc(collection(db, 'triviaRooms', state.roomCode, 'chat'), {
            uid: state.user.uid,
            displayName,
            text: emoji,
            sentAt: serverTimestamp()
        });
    } catch (e) {
        console.warn('sendChatEmoji failed:', e);
        if (err) { err.textContent = 'Could not send. Try again.'; err.hidden = false; }
    }
}

// Edge-trigger feedback on game-status transitions. We track the last
// status we played a sound for so a snapshot replay (same status fires
// twice) doesn't re-buzz the user. Reset on leaveRoom().
let lastStatusPlayedFeedback = null;
function renderRoom() {
    if (!state.roomData) return;
    const isHost = state.user && state.roomData.hostUid === state.user.uid;
    $('#room-host-tag').hidden = !isHost;
    $('#room-private-tag').hidden = !state.roomData.isPrivate;
    // Pause banner + host-controls visibility. Skip / End / Pause only
    // make sense while a question is live (status='playing'), so we hide
    // the whole strip outside that window.
    const room = state.roomData;
    const playing = room.status === 'playing';
    // Pause + End Game are available to every player (host included)
    // once the room is playing - the previous host-only gate created
    // dead-end states where the host had left.
    const hostActions = $('#room-host-actions');
    if (hostActions) hostActions.hidden = !playing;

    // Per-player rate limits: gray out each control once its allowance
    // is exhausted (pause: 2/room, restart: 3/room, end: 3/room). Reset
    // happens in leaveRoom().
    const pauseBtn2 = $('#room-pause-btn');
    if (pauseBtn2) {
        const left = actionRemaining('pause');
        pauseBtn2.disabled = (left <= 0 && !room.paused);
        pauseBtn2.title = pauseBtn2.disabled
            ? 'You\'ve used your pause allowance for this room.'
            : `Pause / resume the timer (${left} left)`;
    }
    const restartBtn2 = $('#room-restart-btn');
    if (restartBtn2) {
        const left = actionRemaining('restart');
        restartBtn2.disabled = left <= 0;
        restartBtn2.title = restartBtn2.disabled
            ? 'You\'ve used your restart proposals for this room.'
            : `Propose restarting the game - all players must accept (${left} left)`;
    }
    const endBtn2 = $('#room-end-btn');
    if (endBtn2) {
        const left = actionRemaining('end');
        endBtn2.disabled = left <= 0;
        endBtn2.title = endBtn2.disabled
            ? 'You\'ve used your end-game allowance for this room.'
            : `End the game and show the final scores (${left} left)`;
    }

    // Chat toggle: visible only when there's someone else to talk to.
    // Solo / daily rooms are inherently single-player so chat is also
    // hidden in those modes regardless of the player count.
    const chatToggle = $('#room-chat-toggle');
    const playMode = room.playMode || 'multi';
    const hasOthers = playMode === 'multi' && state.roomPlayers.length >= 2;
    if (chatToggle) chatToggle.hidden = !hasOthers;
    if (!hasOthers) {
        const panel = $('#room-chat-panel');
        if (panel) panel.hidden = true;
    }

    // In solo, the host's "End game" button (room-end-btn) is the
    // canonical end action. The leave-room button reads as "Back to
    // lobby" so the two controls don't both say "End game" and
    // confuse the player. Same treatment once a multi game is
    // finished - the game's over, "Leave room" reframes nicely as
    // "Back to lobby".
    const finished = room.status === 'finished';
    const leaveBtn = $('#leave-room-btn');
    if (leaveBtn) {
        leaveBtn.textContent = (playMode === 'solo' || finished) ? 'Back to lobby' : 'Leave room';
    }

    // Header end-stage actions (Rematch). Only visible on the finished
    // stage. The end-of-stage section keeps its own copy for users
    // who scroll past the recap. Toggle a class on .room-head-right
    // so the layout flips from inline-row (mid-game) to a clean
    // right-aligned column (post-match) - see styles.css.
    const headerEndActions = $('#room-end-actions');
    const headerRematch = $('#room-end-again-btn');
    if (headerEndActions) headerEndActions.hidden = !finished;
    const headRight = document.querySelector('.room-head-right');
    if (headRight) headRight.classList.toggle('is-finished', finished);
    if (headerRematch) {
        // Mirror the visibility logic from renderRematchUI - only show
        // when a rematch is even an option (>=2 players in multi, or
        // solo player can restart).
        const pCount = rematchPlayerCount();
        const canRematchMulti = playMode === 'multi' && pCount >= 2;
        void finished;
        const canRestartSolo = playMode === 'solo';
        const proposed = !!room.rematchProposedBy;
        // Hide if a proposal is already in flight (the strip below
        // is handling response UI). Show otherwise.
        headerRematch.hidden = !(finished && (canRematchMulti || canRestartSolo) && !proposed);
        headerRematch.innerHTML = canRestartSolo
            ? '<span aria-hidden="true">🔁</span> Restart'
            : '<span aria-hidden="true">🔁</span> Rematch';
    }

    // Rematch / restart proposal - surface an accept/decline prompt
    // exactly once per proposal so the player has a chance to weigh in
    // without missing the round. Fires both mid-game (status='playing')
    // and post-game (status='finished'). A live "Xs remaining" ticker
    // is injected into the modal body so respondents see the same
    // 10-second deadline the proposer's pending modal counts down.
    // A prompt still open after the proposal died (someone declined, the
    // proposer cancelled or timed out) is stale (audit D13): close it
    // without recording a response.
    if (state.rematchPromptOpen
        && (!room.rematchProposedBy || rematchDeclineCount() > 0)) {
        state.rematchPromptOpen = null;
        state.rematchPromptAutoClosed = true;
        closeConfirmModal(false);
    }
    if ((playing || finished) && room.rematchProposedBy
        && state.user && room.rematchProposedBy !== state.user.uid
        && !meHasAcceptedRematch() && !meHasDeclinedRematch()
        && state.lastRematchPromptShown !== room.rematchProposedBy) {
        state.lastRematchPromptShown = room.rematchProposedBy;
        state.rematchPromptOpen = room.rematchProposedBy;
        const proposedAtMs = (room.rematchProposedAt && room.rematchProposedAt.toMillis)
            ? room.rematchProposedAt.toMillis() : Date.now();
        const deadline = proposedAtMs + PROPOSAL_TIMEOUT_MS;
        const baseBody = playing
            ? 'Another player proposed restarting. Accept to draw fresh locations; decline to keep playing.'
            : 'Another player wants a rematch. Accept to start a new game; decline to head back to the lobby.';
        // The body element is the same one openConfirmModal writes -
        // we keep updating it until the modal closes. clearInterval
        // happens both when the promise resolves and when the timer
        // hits zero (which also auto-declines).
        let respTicker = setInterval(() => {
            const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
            const bodyEl = document.getElementById('confirm-modal-body');
            if (bodyEl) bodyEl.textContent = baseBody + '  ·  ' + left + 's remaining';
            if (left <= 0) {
                clearInterval(respTicker);
                respTicker = null;
                if (typeof closeConfirmModal === 'function') closeConfirmModal(false);
            }
        }, 250);
        openConfirmModal({
            title: playing ? 'Restart the game?' : 'Play again?',
            body: baseBody + '  ·  10s remaining',
            confirmLabel: 'Accept',
            cancelLabel: 'Decline',
            danger: false
        }).then((accept) => {
            if (respTicker) { clearInterval(respTicker); respTicker = null; }
            state.rematchPromptOpen = null;
            if (state.rematchPromptAutoClosed) { state.rematchPromptAutoClosed = false; return; }
            respondToRematch(!!accept);
        });
    }

    // If this client IS the proposer, keep their waiting modal in sync
    // with the latest snapshot - and close it once the proposal
    // resolves either way (unanimous accept → game restarts, decline →
    // close, no proposal field → host already cleared it).
    if (room.rematchProposedBy && state.user && room.rematchProposedBy === state.user.uid) {
        if (state.proposalPendingDeadline) {
            renderProposalPendingModal();
            if (rematchDeclineCount() > 0) cancelOwnProposal('declined');
            else if (rematchAcceptCount() >= rematchPlayerCount()) closeProposalPendingModal();
        }
    } else if (!room.rematchProposedBy && state.proposalPendingDeadline) {
        // Proposal cleared by someone else - make sure our modal is closed.
        closeProposalPendingModal();
    }
    // Reset the prompt-shown sentinel once a proposal clears so a NEW
    // proposal will surface its own modal next time.
    if (!room.rematchProposedBy) state.lastRematchPromptShown = null;

    // Mid-game restart trigger. The end-stage renderRematchUI handles
    // the equivalent post-game path; this is the missing piece that
    // actually pulled the trigger when a mid-match unanimous accept
    // came together. The same gate (host only, accepted >= playerCount)
    // ensures exactly one client does the writes.
    if (playing && room.rematchProposedBy && state.user
        && room.hostUid === state.user.uid
        && rematchAcceptCount() >= rematchPlayerCount()
        && rematchDeclineCount() === 0
        && !state.rematchInFlight) {
        playAgain();
    }
    // Spectator banner - shown when the local player joined mid-game and the
    // current question is the one they joined on (joinedAtQuestionIndex === currentQuestionIndex).
    // As soon as the host advances to the next question the index increments
    // and the banner disappears - the player is now a full participant.
    const spectatorBanner = $('#room-spectator-banner');
    if (spectatorBanner) {
        const mePlayer = state.user ? state.roomPlayers.find((p) => p.uid === state.user.uid) : null;
        const joinedAtQIdx = mePlayer && typeof mePlayer.joinedAtQuestionIndex === 'number'
            ? mePlayer.joinedAtQuestionIndex : -1;
        const curQIdx = typeof room.currentQuestionIndex === 'number' ? room.currentQuestionIndex : -1;
        const isSpectating = playing && joinedAtQIdx >= 0 && curQIdx <= joinedAtQIdx;
        spectatorBanner.hidden = !isSpectating;
    }

    const banner = $('#room-paused-banner');
    if (banner) {
        banner.hidden = !room.paused;
        if (playMode === 'solo') {
            banner.innerHTML = '<span aria-hidden="true">⏸</span> Game paused';
        } else {
            // Prefer the explicit pausedByName on the room doc; fall back
            // to looking up the uid in the live players list; finally
            // fall back to "host" if neither is available (legacy rooms
            // paused before this field existed).
            let pauserName = room.pausedByName;
            if (!pauserName && room.pausedByUid) {
                const p = state.roomPlayers.find((pp) => pp.uid === room.pausedByUid);
                pauserName = p && p.displayName;
            }
            if (!pauserName) pauserName = 'host';
            banner.innerHTML = '<span aria-hidden="true">⏸</span> Game paused by '
                + escapeHtml(pauserName) + '.';
        }
    }
    const pauseBtn = $('#room-pause-btn');
    if (pauseBtn) {
        pauseBtn.innerHTML = room.paused
            ? '<span aria-hidden="true">▶</span> Resume'
            : '<span aria-hidden="true">⏸</span> Pause';
    }

    const status = state.roomData.status;
    if (status !== lastStatusPlayedFeedback) {
        if (status === 'playing' && lastStatusPlayedFeedback === 'lobby') {
            try { Feedback.gameStart(); } catch (_) {}
        } else if (status === 'finished') {
            try { Feedback.gameEnd(); } catch (_) {}
        }
        lastStatusPlayedFeedback = status;
    }

    // End-screen snapshot (audit D5): remember everyone present when the
    // game finished and keep them even after their player doc is deleted
    // by leaveRoom, so podium, board and recap never rewrite themselves.
    if (status === 'finished') {
        const roundKey = String(room.round || 1);
        if (state.finalPlayersRound !== roundKey) {
            state.finalPlayersRound = roundKey;
            state.finalPlayers = [];
        }
        const merged = state.finalPlayers.slice();
        for (const p of state.roomPlayers) {
            const i = merged.findIndex((m) => m.uid === p.uid);
            if (i >= 0) merged[i] = p; else merged.push(p);
        }
        state.finalPlayers = merged;
    } else if (state.finalPlayersRound) {
        state.finalPlayersRound = null;
        state.finalPlayers = [];
    }

    const isGlobeDrop = state.roomData.gameType === 'globe-drop';
    switch (status) {
        case 'lobby': return renderLobbyStage(isHost);
        case 'picking': return renderPickingStage(isHost);
        case 'playing': return isGlobeDrop ? renderGlobeDropStage(isHost) : renderGameStage(isHost);
        case 'finished': return renderEndStage(isHost);
    }
}

/**
 * Render the room-settings panel inside the room lobby. Shows the
 * round type, difficulty, locations count, and per-question timer.
 * Host sees an Edit button + inline edit form; others see read-only.
 */
function renderRoomSettings(isHost) {
    const panel = $('#room-settings');
    if (!panel) return;
    const room = state.roomData || {};
    const canEdit = isHost && room.status === 'lobby';

    // Show the panel for both game types - trivia rooms need the game-type
    // display and the switch button even though they have no GlobeDrop fields.
    panel.hidden = false;

    // Game type display row - always populated regardless of game type.
    const gameTypeEl = $('#room-settings-game-type');
    if (gameTypeEl) {
        setText(gameTypeEl, room.gameType === 'globe-drop' ? 'Globe Drop' : 'Trivia');
    }

    // Globe Drop-specific settings rows - hide for trivia rooms.
    const isGlobeDrop = room.gameType === 'globe-drop';
    // B7: every Globe Drop row hides on a trivia room, not just round type.
    // The other three used to stay on screen showing the last globe-drop
    // room's values, which read as facts about the trivia room.
    for (const id of ['#room-settings-item-round-type', '#room-settings-item-difficulty',
        '#room-settings-item-locations', '#room-settings-item-timer']) {
        const item = $(id);
        if (item) item.hidden = !isGlobeDrop;
    }

    if (isGlobeDrop) {
        const roundType = room.roundType || 'capitals';
        const meta = GlobeDropLocations.ROUND_TYPES[roundType] || GlobeDropLocations.ROUND_TYPES.capitals;
        setText($('#room-settings-round-type'), meta.label || roundType);

        const diffKey = room.difficulty || 'medium';
        const diff = GlobeDropScoring.difficultySettings(diffKey);
        setText($('#room-settings-difficulty'), diff.label || diffKey);

        setText($('#room-settings-locations'), String(room.totalQuestions || 0));

        const seconds = Math.round((room.questionTimeMs || diff.timerSec * 1000) / 1000);
        setText($('#room-settings-timer'), `${seconds}s`);
    }

    // Switch game type button - host only, lobby only.
    const switchBtn = $('#room-switch-game-type-btn');
    if (switchBtn) {
        switchBtn.hidden = !canEdit;
        if (canEdit) {
            switchBtn.textContent = isGlobeDrop ? 'Switch to Trivia' : 'Switch to Globe Drop';
        }
    }

    const editBtn = $('#room-settings-edit-btn');
    const hint = $('#room-settings-hint');
    const editForm = $('#room-settings-edit');
    const view = $('#room-settings-view');

    // Edit affordances visible only for globe-drop host in lobby.
    if (editBtn) editBtn.hidden = !(canEdit && isGlobeDrop);
    if (hint) hint.hidden = !(isHost && !canEdit);
    // Whenever the form isn't open, keep it hidden (show summary).
    if (editForm && !state.roomSettingsEditing) {
        editForm.hidden = true;
        if (view) view.hidden = false;
    }
}

/**
 * Open the inline settings editor - preload the selects with the
 * current room values, hide the read-only summary, show the form.
 */
function openRoomSettingsEditor() {
    const room = state.roomData || {};
    if (room.gameType !== 'globe-drop') return;
    state.roomSettingsEditing = true;
    $('#room-settings-view').hidden = true;
    $('#room-settings-edit').hidden = false;
    $('#room-settings-edit-btn').hidden = true;
    $('#room-settings-edit-round-type').value = room.roundType || 'capitals';
    $('#room-settings-edit-difficulty').value = room.difficulty || 'medium';
    $('#room-settings-edit-count').value = String(room.totalQuestions || 5);
    // B14: fall back to the same 60s every difficulty tier actually creates
    // with, not a 120s figure nothing else uses.
    const seconds = Math.round((room.questionTimeMs || Config.GLOBE_DROP_DEFAULT_TIMER_SEC * 1000) / 1000);
    $('#room-settings-edit-time').value = String(seconds);
    const msg = $('#room-settings-msg');
    if (msg) { msg.hidden = true; msg.textContent = ''; msg.classList.remove('is-busy', 'is-err'); }
}

function closeRoomSettingsEditor() {
    state.roomSettingsEditing = false;
    $('#room-settings-edit').hidden = true;
    $('#room-settings-view').hidden = false;
    const isHost = !!(state.user && state.roomData && state.roomData.hostUid === state.user.uid);
    const canEdit = isHost && state.roomData && state.roomData.status === 'lobby';
    $('#room-settings-edit-btn').hidden = !canEdit;
}

async function saveRoomSettings() {
    if (!state.user || !state.roomCode || !state.roomData) return;
    if (state.roomData.hostUid !== state.user.uid) return;
    if (state.roomData.status !== 'lobby') return;

    const newRoundType = $('#room-settings-edit-round-type').value || 'capitals';
    const newDifficulty = $('#room-settings-edit-difficulty').value || 'medium';
    const newCount = Math.max(Config.GLOBE_DROP_LOCATIONS_MIN, Math.min(10, parseInt($('#room-settings-edit-count').value, 10) || 5));
    const newSeconds = parseInt($('#room-settings-edit-time').value, 10) || Config.GLOBE_DROP_DEFAULT_TIMER_SEC;
    const diff = GlobeDropScoring.difficultySettings(newDifficulty);

    const oldRoundType = state.roomData.roundType || 'capitals';
    const oldCount = state.roomData.totalQuestions || 0;
    const needsRefetch = (newRoundType !== oldRoundType) || (newCount !== oldCount);

    const msg = $('#room-settings-msg');
    const saveBtn = $('#room-settings-save');
    const cancelBtn = $('#room-settings-cancel');
    if (saveBtn) saveBtn.disabled = true;
    if (cancelBtn) cancelBtn.disabled = true;
    if (msg) {
        msg.hidden = false;
        msg.classList.remove('is-err');
        msg.classList.add('is-busy');
        msg.textContent = needsRefetch ? 'Refetching locations…' : 'Saving…';
    }

    try {
        const meta = GlobeDropLocations.ROUND_TYPES[newRoundType] || GlobeDropLocations.ROUND_TYPES.capitals;
        const update = {
            roundType: newRoundType,
            packId: meta.packId,
            packName: meta.packName,
            difficulty: newDifficulty,
            totalQuestions: newCount,
            questionTimeMs: newSeconds * 1000
        };
        if (needsRefetch) {
            const locations = await GlobeDropLocations.fetchLocations(newRoundType, newCount, shuffle);
            update.questions = applyRoundMultipliers(locations, newRoundType);
            update.totalQuestions = update.questions.length;
            update.currentQuestionIndex = 0;
            update.currentQuestionId = null;
            update.questionStartedAt = null;
            update.revealStartedAt = null;
            update.playedQuestionIds = [];
        }
        // If difficulty changed but timer was the tier default, snap timer
        // Difficulty no longer rewrites the timer - hosts set the timer
        // independently via the override toggle.
        await updateDoc(doc(db, 'triviaRooms', state.roomCode), update);
        if (msg) {
            msg.classList.remove('is-busy');
            msg.textContent = 'Saved.';
        }
        setTimeout(() => closeRoomSettingsEditor(), 600);
    } catch (err) {
        console.warn('saveRoomSettings failed:', err);
        if (msg) {
            msg.classList.remove('is-busy');
            msg.classList.add('is-err');
            msg.textContent = 'Save failed: ' + (err && err.message ? err.message : 'unknown');
        }
    } finally {
        if (saveBtn) saveBtn.disabled = false;
        if (cancelBtn) cancelBtn.disabled = false;
    }
}

/**
 * Toggle the room's game type between 'globe-drop' and 'trivia' while the
 * room is still in the lobby. Writes atomically to the room doc - only the
 * gameType field changes, the player list is untouched.
 */
async function switchRoomGameType() {
    if (!state.user || !state.roomCode || !state.roomData) return;
    if (state.roomData.hostUid !== state.user.uid) return;
    if (state.roomData.status !== 'lobby') return;

    const current = state.roomData.gameType || 'globe-drop';
    const next = current === 'globe-drop' ? 'trivia' : 'globe-drop';

    const switchBtn = $('#room-switch-game-type-btn');
    if (switchBtn) switchBtn.disabled = true;
    try {
        // B14 root cause: a switched room used to keep the OLD game's timer
        // (or none), which is how the odd 120s fallback ever became visible.
        // Stamp the target game's own default so the room is coherent.
        await updateDoc(doc(db, 'triviaRooms', state.roomCode), {
            gameType: next,
            questionTimeMs: next === 'globe-drop'
                ? Config.GLOBE_DROP_DEFAULT_TIMER_SEC * 1000
                : Config.QUESTION_TIME_MS,
        });
        // Also update state.selectedGameType so the local create-form toggle
        // stays in sync on subsequent room-settings renders.
        state.selectedGameType = next;
    } catch (err) {
        console.warn('switchRoomGameType failed:', err);
    } finally {
        if (switchBtn) switchBtn.disabled = false;
    }
}

/**
 * Fetch the lifetime H2H record between the current user and `opponentUid`
 * and stamp a "W-L-T" badge into the lobby tile. Cached on state so
 * re-renders within the same session don't refetch. Best-effort -
 * missing docs / network errors leave the badge hidden.
 */
async function hydrateLobbyH2HBadge(opponentUid, spanId) {
    if (!state.user) return;
    state.h2hPairCache = state.h2hPairCache || {};
    const key = h2hPairKey(state.user.uid, opponentUid);
    if (!key) return;
    let pair = state.h2hPairCache[key];
    if (pair === undefined) {
        try {
            const snap = await getDoc(doc(db, 'triviaH2H', key));
            pair = snap.exists() ? snap.data() : null;
        } catch (_) {
            pair = null;
        }
        state.h2hPairCache[key] = pair;
    }
    const el = document.getElementById(spanId);
    if (!el || !pair) return;
    const myIsA = pair.uidA === state.user.uid;
    const myWins = myIsA ? (pair.winsA || 0) : (pair.winsB || 0);
    const theirWins = myIsA ? (pair.winsB || 0) : (pair.winsA || 0);
    const draws = pair.ties || 0;
    // Format: W-D-L (Wins-Draws-Losses), always all three numbers
    // so the structure stays parseable at a glance even with zeros.
    el.textContent = `H2H ${myWins}-${draws}-${theirWins}`;
    el.hidden = false;
}

function renderLobbyStage(isHost) {
    show($('#stage-lobby'));
    hide($('#stage-game'));
    hide($('#stage-globe-drop'));
    hide($('#stage-picking'));
    hide($('#stage-end'));

    // Room settings panel - show current room settings to everyone in
    // the lobby. Host can edit (click event handled separately).
    renderRoomSettings(isHost);

    // Item 8: warm the Earth texture while players wait in the lobby so the
    // globe paints instantly on game start. Fires once per session for the
    // exact asset ensureGlobe() will pick (2K on phones, 8K on desktop).
    const lobbyGameType = (state.roomData && state.roomData.gameType) || state.selectedGameType;
    if (lobbyGameType === 'globe-drop' && !state.globeTexturePreloaded) {
        state.globeTexturePreloaded = true;
        const img = new Image();
        img.src = isMobileGlobeViewport() ? 'data/earth-2k.jpg' : 'data/earth-8k.jpg';
    }

    const list = $('#lobby-player-grid');
    list.innerHTML = '';
    const players = state.roomPlayers.slice().sort((a, b) => {
        const ja = a.joinedAt && a.joinedAt.toMillis ? a.joinedAt.toMillis() : 0;
        const jb = b.joinedAt && b.joinedAt.toMillis ? b.joinedAt.toMillis() : 0;
        return ja - jb;
    });
    const nowMs = Date.now();
    for (const p of players) {
        const li = document.createElement('li');
        li.className = 'player-tile';
        if (p.uid === state.roomData.hostUid) li.classList.add('is-host');
        if (state.user && p.uid === state.user.uid) li.classList.add('is-me');
        const isLive = RoomState.isPlayerLive(p, nowMs);
        if (!isLive) li.classList.add('is-disconnected');
        const isMe = state.user && p.uid === state.user.uid;
        const h2hSpanId = (state.user && !isMe) ? `lobby-h2h-${p.uid}` : '';
        const isHost = p.uid === state.roomData.hostUid;
        // Two-row layout: name gets the full content width on top
        // (wraps to 2 lines if needed, ellipses only as a last resort);
        // small badges (HOST tag + H2H pill) live on the row beneath.
        const badgesHTML = (isHost || h2hSpanId || !isLive)
            ? '<span class="player-tile-badges">'
                + (isHost ? '<span class="player-mini-tag">Host</span>' : '')
                + (!isLive ? '<span class="player-mini-tag player-mini-tag-away">Disconnected</span>' : '')
                + (h2hSpanId ? `<span class="player-h2h-badge" id="${h2hSpanId}" hidden></span>` : '')
              + '</span>'
            : '';
        li.innerHTML =
            `<span class="player-avatar">${escapeHtml(avatarLetter(p.displayName))}</span>` +
            '<span class="player-tile-body">' +
                `<span class="player-name">${escapeHtml(p.displayName)}</span>` +
                badgesHTML +
            '</span>';
        list.appendChild(li);
        if (h2hSpanId) hydrateLobbyH2HBadge(p.uid, h2hSpanId);
    }

    $('#lobby-host-controls').hidden = !isHost;
    $('#lobby-guest-hint').hidden = isHost;
    // Multi-player rooms require at least 2 players to start. Solo / daily
    // rooms are intentionally single-player so they can start with 1.
    const playMode = state.roomData.playMode || 'multi';
    const minPlayers = (playMode === 'solo' || playMode === 'daily') ? 1 : 2;
    const startBtn = $('#start-game-btn');
    startBtn.disabled = RoomState.livePlayers(players, nowMs).length < minPlayers;
    startBtn.title = startBtn.disabled && playMode === 'multi'
        ? 'Waiting for another player to join. Share the room code or use "Play solo" from the lobby instead.'
        : '';
    // Pair a visible hint when the button is disabled in a multi room so
    // the host knows why nothing happens on click.
    const waitingHint = $('#lobby-waiting-hint');
    if (waitingHint) waitingHint.hidden = !(isHost && startBtn.disabled && playMode === 'multi');
}

function renderPickingStage(isHost) {
    hide($('#stage-lobby'));
    hide($('#stage-game'));
    hide($('#stage-globe-drop'));
    hide($('#stage-end'));
    show($('#stage-picking'));

    const idx = state.roomData.currentQuestionIndex || 0;
    const total = state.roomData.totalQuestions || 0;
    setText($('#pick-progress-now'), String(idx + 1));
    setText($('#pick-progress-total'), String(total));

    const deciderUid = state.roomData.deciderUid;
    const decider = state.roomPlayers.find((p) => p.uid === deciderUid);
    const deciderName = decider ? decider.displayName : 'Player';
    // Fallback so a dropped decider doesn't freeze the game: the host can
    // step in and pick on their behalf.
    const deciderPresent = !!decider && RoomState.isPlayerLive(decider, Date.now());
    const iAmDecider = !!(state.user && state.user.uid === deciderUid);
    const iAmHost = !!(state.user && state.roomData.hostUid === state.user.uid);
    const canPick = iAmDecider || (!deciderPresent && iAmHost);

    setText($('#pick-decider-name'), deciderName + (iAmDecider ? ' (you)' : ''));
    setText($('#pick-decider-avatar'), avatarLetter(deciderName));

    const grid = $('#pick-category-grid');
    grid.innerHTML = '';
    const waiting = $('#pick-waiting-msg');
    const prompt = $('#pick-prompt');
    const pickKey = `${state.roomData.round || 1}:${idx}`;
    if (state.pickingShownKey !== pickKey) {
        state.pickingShownKey = pickKey;
        state.pickingShownAt = Date.now();
    }
    if (canPick) {
        waiting.hidden = true;
        prompt.hidden = false;
        const pool = Array.isArray(state.roomData.questions) ? state.roomData.questions : [];
        const playedIds = Array.isArray(state.roomData.playedQuestionIds)
            ? state.roomData.playedQuestionIds
            : [];
        const cats = RoomState.availableCategoriesFromPool(pool, playedIds);

        // "Random" button first, then one button per available category.
        const randomBtn = makeCategoryButton('__any__', 'Random', cats.reduce((a, c) => a + c.remaining, 0));
        randomBtn.classList.add('pick-cat-random');
        grid.appendChild(randomBtn);
        cats.forEach((c) => {
            grid.appendChild(makeCategoryButton(c.category, prettyCategory(c.category), c.remaining));
        });
        if (!cats.length) {
            const empty = document.createElement('p');
            empty.className = 'empty-state';
            empty.textContent = 'Pool exhausted. Host will finish the game.';
            grid.appendChild(empty);
        }
    } else {
        prompt.hidden = true;
        const msg = deciderPresent
            ? `Waiting for ${deciderName} to pick a category…`
            : `${deciderName} disconnected - host can pick, or the game picks for you shortly.`;
        setText(waiting, msg);
        waiting.hidden = false;
    }

    void isHost; // (host fallback already factored into canPick above)
}

function makeCategoryButton(categoryId, label, remaining) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pick-cat-btn';
    btn.dataset.category = categoryId;
    btn.innerHTML =
        `<span class="pick-cat-label">${escapeHtml(label)}</span>` +
        `<span class="pick-cat-count">${remaining} left</span>`;
    btn.addEventListener('click', () => {
        btn.disabled = true;
        Array.from(btn.parentNode.querySelectorAll('button')).forEach((b) => { b.disabled = true; });
        pickCategoryAndStart(categoryId).catch((err) => {
            console.warn('Pick failed:', err);
            btn.disabled = false;
            Array.from(btn.parentNode.querySelectorAll('button')).forEach((b) => { b.disabled = false; });
        });
    });
    return btn;
}

function prettyCategory(cat) {
    return String(cat || 'general')
        .replace(/[-_]+/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase());
}

function renderGameStage() {
    hide($('#stage-lobby'));
    hide($('#stage-end'));
    hide($('#stage-picking'));
    hide($('#stage-globe-drop'));
    show($('#stage-game'));

    const idx = state.roomData.currentQuestionIndex || 0;
    const totalQ = state.roomData.totalQuestions || 0;
    setText($('#game-progress-now'), String(idx + 1));
    setText($('#game-progress-total'), String(totalQ));

    const pool = Array.isArray(state.roomData.questions) ? state.roomData.questions : [];
    const q = pool.find((cand) => cand && cand.id === state.roomData.currentQuestionId);
    if (!q) return;

    // Reset answer status when the question changes. `currentAnsweredFor`
    // is the per-question marker each player writes on submit; stale
    // `currentAnswerIndex` from a previous question is intentionally ignored
    // (we can't reset it cross-player without violating the security rules).
    const me = state.roomPlayers.find((p) => state.user && p.uid === state.user.uid);
    const myAnsweredIndex = (me && me.currentAnsweredFor === q.id && me.currentAnswerIndex != null)
        ? me.currentAnswerIndex : null;

    if (state.submittedQuestionId !== q.id) {
        state.submittedQuestionId = null; // wait for me to answer this question
    }
    renderQuestion(q, myAnsweredIndex);
    renderMiniBoard(q.id);
    startTimerLoop();
}

function renderQuestion(q, myAnsweredIndex) {
    setText($('#question-category'), prettyCategory(q.category));
    setText($('#question-text'), q.question);

    const grid = $('#answer-grid');
    grid.innerHTML = '';
    const letters = ['A', 'B', 'C', 'D', 'E', 'F'];

    const startMs = state.roomData.questionStartedAt && state.roomData.questionStartedAt.toMillis
        ? state.roomData.questionStartedAt.toMillis() : null;
    const revealMs = state.roomData.revealStartedAt && state.roomData.revealStartedAt.toMillis
        ? state.roomData.revealStartedAt.toMillis() : null;
    const phase = RoomState.questionPhase(startMs, Date.now(), revealMs, currentAskingDurationMs());
    const revealOn = phase === 'reveal' || phase === 'ended';

    for (let i = 0; i < q.choices.length; i++) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'answer-btn';
        btn.dataset.answerIndex = String(i);
        btn.innerHTML =
            `<span class="answer-letter">${letters[i] || (i+1)}</span>` +
            `<span class="answer-text">${escapeHtml(q.choices[i])}</span>`;
        if (myAnsweredIndex === i) btn.classList.add('is-picked');
        if (revealOn) {
            btn.disabled = true;
            if (i === q.correctIndex) btn.classList.add('is-correct');
            else if (myAnsweredIndex === i) btn.classList.add('is-wrong');
            else btn.classList.add('is-dim');
        } else if (myAnsweredIndex != null) {
            btn.disabled = true;
            if (myAnsweredIndex !== i) btn.classList.add('is-dim');
        } else {
            btn.addEventListener('click', () => submitAnswer(i, q));
        }
        grid.appendChild(btn);
    }

    const status = $('#answer-status');
    status.classList.remove('is-correct', 'is-wrong');
    if (revealOn) {
        const correctText = q.choices[q.correctIndex];
        if (myAnsweredIndex === q.correctIndex) {
            setText(status, '✓ Correct!');
            status.classList.add('is-correct');
        } else if (myAnsweredIndex == null) {
            setText(status, `⏱ Time up - correct answer: ${correctText}`);
        } else {
            setText(status, `✗ Wrong - correct answer: ${correctText}`);
            status.classList.add('is-wrong');
        }
    } else if (myAnsweredIndex != null) {
        setText(status, 'Locked in. Waiting for the rest.');
    } else {
        setText(status, 'Pick an answer.');
    }
}

function renderMiniBoard(currentQuestionId) {
    const list = $('#mini-board-list');
    list.innerHTML = '';
    const ranked = Scoring.rankPlayers(state.roomPlayers.map((p) => ({
        displayName: p.displayName,
        score: p.score,
        streak: p.streak,
        uid: p.uid,
        // Mark "answered" only when the marker matches the current question id -
        // otherwise we'd light the green check on stale data from question N-1.
        answeredThisQuestion: currentQuestionId != null
            && p.currentAnsweredFor === currentQuestionId
            && p.currentAnswerIndex != null
    })));
    const nowMs = Date.now();
    ranked.forEach((p, i) => {
        const li = document.createElement('li');
        li.className = 'mini-board-row';
        if (state.user && p.uid === state.user.uid) li.classList.add('is-me');
        if (i === 0 && (p.score || 0) > 0) li.classList.add('is-leader');
        if (p.answeredThisQuestion) li.classList.add('is-answered');
        const full = state.roomPlayers.find((rp) => rp.uid === p.uid);
        if (full && !RoomState.isPlayerLive(full, nowMs)) {
            li.classList.add('is-disconnected');
            li.title = 'Disconnected';
        }
        // Surface streak ≥2 so the multiplier feels visible and people can
        // see who's on a heater - single correct (streak=1) doesn't yet
        // earn a multiplier, so no indicator there.
        const streak = Number(p.streak) || 0;
        const streakChip = streak >= 2
            ? `<span class="mini-board-streak" title="${streak} correct in a row">🔥${streak}</span>`
            : '';
        li.innerHTML =
            `<span class="mini-board-rank">${i+1}</span>` +
            `<span class="mini-board-name">${escapeHtml(p.displayName)}</span>` +
            streakChip +
            // Same "tint + ✓" answered cue Globe Drop's board emits. Without
            // this span the tint is the only half that lands, and a
            // full-width tinted name reads as a disabled input.
            `<span class="mini-board-check" aria-hidden="true"></span>` +
            `<span class="mini-board-score">${p.score || 0}</span>`;
        list.appendChild(li);
    });
}

/* =====================================================================
 * GlobeDrop stage - map UI, guess submission, reveal, Wikipedia trivia
 * ===================================================================== */

/**
 * Lazy-init the globe.gl instance on first entry into a GlobeDrop room.
 * The script is loaded with `defer` so it may not be ready at the moment
 * the room enters - callers retry on the next snapshot in that case.
 *
 * Texture: NASA Blue Marble (satellite imagery from three-globe's example
 * assets, no API key). No labels, no political boundaries - pure Earth
 * from space, so a geography game stays a real challenge.
 */
// Single source of truth for the "treat this as a phone" breakpoint used by
// the texture pick, control tuning, and texture preload. Matches the 768px
// CSS breakpoint the mobile layout rules key off.
function isMobileGlobeViewport() {
    return (typeof window !== 'undefined' ? window.innerWidth : 1024) < 768;
}

// Rotate speed scales with zoom: full speed when zoomed out (altitude 1.0)
// so a drag sweeps the globe, easing to a 0.10 floor when zoomed in so the
// same drag distance doesn't whip past the spot you're aiming for.
function globeRotateSpeedForAltitude(altitude) {
    const alt = typeof altitude === 'number' && altitude > 0 ? altitude : 1.0;
    return Math.max(0.10, Math.min(0.45, 0.45 * alt));
}

function prefersReducedMotion() {
    return typeof window !== 'undefined'
        && typeof window.matchMedia === 'function'
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/* =====================================================================
 * Globe camera
 *
 * Every programmatic camera move goes through flyGlobeCameraTo. globe.gl's
 * own pointOfView(pose, duration) starts a TWEEN it never cancels, so two
 * overlapping calls (a burst of wheel clicks, or a reveal flight landing on
 * top of a round-start pull-back) both keep writing the camera every frame
 * and fight each other. One rAF tween that a new call supersedes keeps zoom
 * continuous and makes every flight cancellable by the new-question reset.
 * ===================================================================== */

const GLOBE_MIN_ALTITUDE = 0.15;
const GLOBE_MAX_ALTITUDE = 4.0;
const GLOBE_EXPLORE_ALTITUDE = 1.2;
const globeCamera = { raf: null, target: null };

function cancelGlobeCameraTween() {
    if (globeCamera.raf) cancelAnimationFrame(globeCamera.raf);
    globeCamera.raf = null;
    globeCamera.target = null;
}

function flyGlobeCameraTo(pose, durationMs) {
    if (!state.globe) return;
    cancelGlobeCameraTween();
    const from = state.globe.pointOfView();
    const to = {
        lat: typeof pose.lat === 'number' ? pose.lat : from.lat,
        lng: typeof pose.lng === 'number' ? pose.lng : from.lng,
        altitude: typeof pose.altitude === 'number' ? pose.altitude : from.altitude
    };
    const duration = prefersReducedMotion() ? 0 : durationMs;
    if (!duration) {
        state.globe.pointOfView(to, 0);
        return;
    }
    // Take the short way round the meridian: a 170 -> -170 pan crosses the
    // dateline instead of sweeping backwards across the whole globe.
    let fromLng = from.lng;
    while (to.lng - fromLng > 180) fromLng += 360;
    while (to.lng - fromLng < -180) fromLng -= 360;
    // Rise over the middle of a long pan. Without this, a player zoomed right
    // in when the reveal fires gets dragged across the surface at that same
    // altitude, which reads as a blurry skim instead of a flight.
    const dLat = (to.lat - from.lat) * Math.PI / 180;
    const dLng = (to.lng - fromLng) * Math.PI / 180;
    const travel = Math.min(Math.PI, Math.hypot(dLat, dLng * Math.cos(to.lat * Math.PI / 180)));
    const lift = (travel / Math.PI) * 0.9;
    globeCamera.target = to;
    const started = performance.now();
    const step = (now) => {
        if (!state.globe) { cancelGlobeCameraTween(); return; }
        const p = Math.min(1, (now - started) / duration);
        const k = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
        state.globe.pointOfView({
            lat: from.lat + (to.lat - from.lat) * k,
            lng: fromLng + (to.lng - fromLng) * k,
            altitude: from.altitude + (to.altitude - from.altitude) * k + Math.sin(Math.PI * p) * lift
        }, 0);
        if (p < 1) { globeCamera.raf = requestAnimationFrame(step); return; }
        globeCamera.raf = null;
        globeCamera.target = null;
    };
    globeCamera.raf = requestAnimationFrame(step);
}

function zoomGlobeByWheel(deltaY) {
    if (!state.globe) return;
    const pov = state.globe.pointOfView();
    // Chain off the in-flight zoom target rather than the live altitude, so a
    // fast burst of wheel clicks accumulates into one continuous move instead
    // of each click re-measuring a camera that is still travelling.
    const base = globeCamera.target ? globeCamera.target.altitude : pov.altitude;
    const factor = deltaY > 0 ? 1.15 : 0.87;
    const next = Math.max(GLOBE_MIN_ALTITUDE, Math.min(GLOBE_MAX_ALTITUDE, base * factor));
    flyGlobeCameraTo({ lat: pov.lat, lng: pov.lng, altitude: next }, 240);
    const controls = state.globe.controls();
    if (controls) controls.rotateSpeed = globeRotateSpeedForAltitude(next);
}

/**
 * Camera pose that frames two points at once: aim at their great-circle
 * midpoint and back off until both sit inside the camera frustum. Fitting to
 * the visible horizon is not enough - globe.gl's camera has a 50 degree
 * VERTICAL fov, so on a wide canvas the top and bottom of the globe are
 * cropped long before the horizon. Antipodal points can never both be on
 * screen (sphere geometry, not a bug), so the altitude clamps rather than
 * running away to orbit.
 */
function globeFrameForPair(aLat, aLng, bLat, bLng) {
    const rad = Math.PI / 180;
    const toVec = (lat, lng) => {
        const phi = lat * rad;
        const lam = lng * rad;
        return [Math.cos(phi) * Math.cos(lam), Math.cos(phi) * Math.sin(lam), Math.sin(phi)];
    };
    const a = toVec(aLat, aLng);
    const b = toVec(bLat, bLng);
    const m = [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
    const len = Math.hypot(m[0], m[1], m[2]);
    // Antipodal: the midpoint is undefined, so stay over the answer.
    const mid = len < 1e-6
        ? { lat: bLat, lng: bLng }
        : { lat: Math.asin(m[2] / len) / rad, lng: Math.atan2(m[1], m[0]) / rad };
    const dot = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
    const halfSep = Math.acos(dot) / 2;
    // Camera distance that puts a point halfSep off-axis exactly on the frame
    // edge: D = R(cos(halfSep) + sin(halfSep) / tan(halfFov)). Altitude is
    // D/R - 1. The tighter of the two half-fovs wins (a portrait canvas is
    // narrower horizontally), and 0.85 of it leaves the pins off the edge.
    const camera = state.globe && state.globe.camera && state.globe.camera();
    const halfFovV = ((camera && camera.fov ? camera.fov : 50) / 2) * rad;
    const el = document.getElementById('globe-drop-map');
    const aspect = el && el.clientHeight ? el.clientWidth / el.clientHeight : 1.6;
    const halfFov = Math.min(halfFovV, Math.atan(Math.tan(halfFovV) * aspect)) * 0.85;
    const fitted = Math.cos(halfSep) + Math.sin(halfSep) / Math.tan(halfFov) - 1;
    const altitude = Math.max(0.35, Math.min(2.2, fitted));
    return { lat: mid.lat, lng: mid.lng, altitude };
}

/* =====================================================================
 * Globe markers
 *
 * globe.gl's layers join data by object IDENTITY (they take no id accessor),
 * so handing them fresh object literals on every redraw makes each redraw a
 * full exit + enter: moving a pin meant "vanish, then grow back". Every
 * marker below is a persistent datum keyed by role that we mutate in place,
 * which turns the same redraw into a position tween.
 * ===================================================================== */

const globeMarkers = { points: new Map(), pins: new Map(), arcs: new Map() };

function globePointMarker(key, props) {
    let d = globeMarkers.points.get(key);
    if (!d) { d = {}; globeMarkers.points.set(key, d); }
    return Object.assign(d, props);
}

function globeArcMarker(key, props) {
    let d = globeMarkers.arcs.get(key);
    if (!d) { d = {}; globeMarkers.arcs.set(key, d); }
    return Object.assign(d, props);
}

/**
 * The guess pin and the answer pin are DOM (CSS2D) markers rather than WebGL
 * points so the drop + ground pulse can be real CSS animation - a cylinder
 * mesh can only tween its own scale. Opponents stay as points: their pins are
 * context, not the player's tactile moment.
 */
function globePinMarker(key, variant, lat, lng) {
    let d = globeMarkers.pins.get(key);
    if (!d) {
        d = { el: createGlobePinElement(variant), lat: null, lng: null };
        globeMarkers.pins.set(key, d);
    }
    const moved = d.lat !== lat || d.lng !== lng;
    d.lat = lat;
    d.lng = lng;
    // Replay the drop only where the pin actually lands somewhere new, so the
    // reveal never re-animates the guess pin the player placed 30s ago.
    if (moved) {
        d.el.classList.remove('is-dropping');
        // Reflow so removing + re-adding restarts the CSS animation.
        // eslint-disable-next-line no-void
        void d.el.offsetWidth;
        d.el.classList.add('is-dropping');
    }
    return d;
}

function createGlobePinElement(variant) {
    const el = document.createElement('div');
    el.className = `gd-pin gd-pin-${variant}`;
    const pulse = document.createElement('span');
    pulse.className = 'gd-pin-pulse';
    const body = document.createElement('span');
    body.className = 'gd-pin-body';
    el.appendChild(pulse);
    el.appendChild(body);
    return el;
}

function clearGlobeMarkers() {
    globeMarkers.points.clear();
    globeMarkers.pins.clear();
    globeMarkers.arcs.clear();
}

/**
 * Arc height scaled to the miss. The old fixed arcAltitude(0.18) gave a 40 km
 * near-miss the same balloon as a transatlantic one; the floor keeps a short
 * arc lifted enough to read against the texture.
 */
function globeArcAltitudeForDistance(km) {
    const frac = Math.max(0, Math.min(1, km / 20015));
    return 0.03 + 0.32 * frac;
}

function ensureGlobe() {
    if (state.globe) return state.globe;
    if (typeof Globe === 'undefined') {
        console.warn('globe.gl not loaded yet - init deferred');
        return null;
    }
    const el = document.getElementById('globe-drop-map');
    if (!el) return null;
    // Mobile (viewport < 768px): use a downscaled 2K texture (~210 KB vs
    // ~4.5 MB) and drop the bump map entirely. The bump map's relief is
    // invisible at phone screen sizes but still costs an extra ~380 KB
    // decode + a normal-map pass on a weaker GPU. Desktop keeps the full
    // 8K daymap + topology bump exactly as before.
    const useMobileTexture = isMobileGlobeViewport();
    // Item 9: pulse the atmosphere ring while the scene + texture upload.
    // Removed on onGlobeReady (with a 2s fallback) so it never lingers.
    el.classList.add('is-loading');
    let loadingCleared = false;
    const clearLoading = () => {
        if (loadingCleared) return;
        loadingCleared = true;
        el.classList.remove('is-loading');
        // Item 5: ease down from the high orbit parked below. Anchored here
        // (not at construction) so it runs with globe.gl's own scale/spin-in,
        // which also waits for the texture; the 2s clearLoading fallback
        // guarantees the camera still arrives if onGlobeReady never fires.
        // Deferred a tick so it can never outrun the construction chain that
        // assigns state.globe and parks the camera.
        setTimeout(() => flyGlobeCameraTo({ lat: 20, lng: 0, altitude: 1.0 }, 1200), 0);
    };
    setTimeout(clearLoading, 2000);
    state.globe = Globe()(el)
        // Bundled 8K (8192×4096) Earth daymap from Solar System Scope
        // (CC BY 4.0, attributed in the GlobeDrop stage footer). Local so we
        // don't depend on a third-party CDN and skip any CORS surprises.
        // ~4.5 MB; the browser caches it after the first room creation.
        .globeImageUrl(useMobileTexture ? 'data/earth-2k.jpg' : 'data/earth-8k.jpg')
        // Self-hosted topology bump map (from three-globe@2.31.1's
        // example assets). Keeping it local matches earth-8k.jpg and
        // means the globe build doesn't touch unpkg at all. Skipped on
        // mobile where the relief never reads at that pixel density.
        .bumpImageUrl(useMobileTexture ? '' : 'data/earth-topology.png')
        .showAtmosphere(true)
        .atmosphereColor('#6366f1')
        .atmosphereAltitude(0.18)
        .backgroundColor('rgba(0, 0, 0, 0)')
        // Fallback click path only. The app-level gesture tracking installed
        // by attachGlobeInputHandling is the primary one (globe.gl cancels a
        // click on ANY pointer movement, which eats guesses to hand tremor);
        // it stamps globeGestureAt so this callback can't place a second pin
        // for a gesture it already resolved.
        .onGlobeClick(({ lat, lng }) => {
            if (performance.now() - state.globeGestureAt < 400) return;
            onGlobeClick(lat, lng);
        })
        .onGlobeReady(clearLoading)
        .pointLat('lat')
        .pointLng('lng')
        .pointColor('color')
        .pointAltitude(0.012)
        .pointRadius('size')
        .pointLabel('label')
        // Default 12 segments reads as a faceted polygon up close; 24 is
        // round at any altitude the camera clamp allows.
        .pointResolution(24)
        // Default 1000ms makes a pin move feel like a slow regrow. Marker
        // identity is stable (see globePointMarker), so this is the tween a
        // moved pin actually rides. NOTE: globe.gl also uses this value for
        // html element moves - htmlTransitionDuration is only a gate there.
        .pointsTransitionDuration(300)
        .htmlLat('lat')
        .htmlLng('lng')
        .htmlElement('el')
        .htmlTransitionDuration(300)
        .arcStartLat('startLat').arcStartLng('startLng')
        .arcEndLat('endLat').arcEndLng('endLng')
        .arcColor('color')
        .arcAltitude('altitude')
        .arcStroke(0.45)
        // Settled (solid) dash state. The reveal arms a one-shot draw-on over
        // these in startRevealArcDraw and resets them here-equivalent values
        // in clearMapOverlays.
        .arcDashLength(1)
        .arcDashGap(0)
        .arcDashInitialGap(0)
        .arcDashAnimateTime(0)
        // The dash sweep is the arc's entrance; a geometry grow-in underneath
        // it just muddies the draw.
        .arcsTransitionDuration(0)
        // Polygon styling used by the reveal-phase country-border
        // overlay. Cap fill is a faint cyan wash so the texture
        // beneath stays readable; side + stroke are saturated so
        // the outline reads against the satellite image. polygonsData
        // is empty until drawGlobeDropReveal hands in the correct
        // country's feature.
        .polygonAltitude(0.008)
        .polygonCapColor(() => 'rgba(34, 211, 238, 0.18)')
        .polygonSideColor(() => 'rgba(34, 211, 238, 0.30)')
        .polygonStrokeColor(() => '#22d3ee')
        .polygonsTransitionDuration(700);
    // Match the canvas size to its container; globe.gl reads this once
    // up front so we have to call it after the stage is visible.
    state.globe.width(el.clientWidth);
    state.globe.height(el.clientHeight);
    // Item 5: park the camera in a high orbit; clearLoading eases it down to
    // the start view. Snapping straight to 1.0 (duration 0) on top of
    // globe.gl's own 2.5-altitude init was a visible first-frame jump.
    state.globe.pointOfView({ lat: 20, lng: 0, altitude: 2.6 }, 0);

    // Three.js OrbitControls defaults feel sluggish - ease damping so drag
    // and pinch react snappily. Wheel zoom is NOT OrbitControls' any more
    // (see attachGlobeInputHandling): it is one tweened altitude move per
    // scroll click, which is where the "feels fast" upgrade comes from.
    const controls = state.globe.controls();
    if (controls) {
        // Camera feel:
        //   - rotateSpeed scales with altitude (full 0.45 zoomed out, 0.10
        //     floor zoomed in) so a drag never over-shoots up close
        //   - damping 0.3 on desktop; gentler 0.15 on mobile so a flick
        //     doesn't fling the camera on a touchscreen
        //   - autoRotate explicitly OFF so a stray default doesn't kick
        //     the globe into continuous spin between rounds
        //   - zoomSpeed is deliberately not set here: globe.gl installs its
        //     own controls 'change' listener that rewrites it to 0.1*(alt+1)
        //     after the first interaction, so any value we set was dead. It
        //     now only affects pinch, where that adaptive value is right.
        const mobile = isMobileGlobeViewport();
        controls.rotateSpeed = globeRotateSpeedForAltitude(state.globe.pointOfView().altitude);
        controls.enableDamping = true;
        controls.dampingFactor = mobile ? 0.15 : 0.3;
        controls.autoRotate = false;
        // Keep rotateSpeed in step with the live altitude as the user zooms.
        controls.addEventListener('change', () => {
            if (!state.globe) return;
            controls.rotateSpeed = globeRotateSpeedForAltitude(state.globe.pointOfView().altitude);
        });
    }

    attachGlobeInputHandling(el);

    // Item 11. Deliberately not inline in the construction chain above: the
    // lights don't exist yet at that point (see tuneGlobeLighting).
    tuneGlobeLighting();

    // Ask the device for the actual pixel ratio so the globe canvas is
    // rendered at native (retina) resolution - without this, three.js uses
    // 1.0 which looks blurry on hi-DPI displays.
    const renderer = state.globe.renderer && state.globe.renderer();
    if (renderer && typeof renderer.setPixelRatio === 'function') {
        // Cap at 2: above that the extra pixels are invisible but the
        // fragment-shader cost (≈ ratio²) tanks frame rate on 3x phones.
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    }

    // Item 3: keep the canvas matched to its container across viewport /
    // orientation changes. Attach once; the globe instance lives for the
    // app's lifetime so we guard against double-attach via state.
    attachGlobeResizeHandling(el);

    return state.globe;
}

/**
 * Item 11: make the sphere read as a sphere.
 *
 * globe.gl's defaults are AmbientLight(0xbbbbbb) + DirectionalLight(0xffffff,
 * 0.6) fixed above the north pole: the ambient is strong enough to flatten
 * the surface and the key comes from a direction the camera never sits at,
 * so the globe looked like a printed disc. This version parents the key light
 * to the CAMERA, which gives a stable centre-bright / limb-dark falloff from
 * every angle - a real 3D read with no dark side to hide a target city in,
 * and no per-frame work (three.js already updates the camera's world matrix).
 * The camera has to be in the scene graph for a light hanging off it to be
 * collected by the renderer, so it gets added.
 *
 * There is no lights() accessor in globe.gl 2.27.4, hence the traverse. No
 * postprocessing, no night side, and the colours stay near-white so the map
 * texture is not tinted. Total light at the centre of the disc lands within
 * a few percent of the stock setup, so exposure is unchanged - what changes
 * is that the edge now falls off.
 *
 * Retried because globe.gl populates the scene AFTER the constructor
 * returns: at that moment the scene holds only the sky mesh and the camera,
 * so tuning there silently did nothing.
 */
function tuneGlobeLighting(attempt = 0) {
    if (!state.globe || typeof state.globe.scene !== 'function') return;
    try {
        const scene = state.globe.scene();
        const camera = state.globe.camera();
        if (!scene || !camera) return;
        let ambient = null;
        let key = null;
        scene.traverse((obj) => {
            if (!ambient && obj.type === 'AmbientLight') ambient = obj;
            if (!key && obj.type === 'DirectionalLight') key = obj;
        });
        if (!ambient || !key) {
            if (attempt < 20) setTimeout(() => tuneGlobeLighting(attempt + 1), 100);
            return;
        }
        // Ambient drops to a floor that keeps the unlit limb readable
        // (nothing on this globe may ever become invisible) but no longer
        // washes the shading out.
        ambient.color.set(0xffffff);
        ambient.intensity = 0.52;
        // Slightly warm key, offset up and to the left of the camera. The
        // offset is in world units against a globe radius of 100, so it
        // works out to roughly 25 degrees off the view axis at the default
        // altitude - enough to shade, not enough to push the terminator
        // inside the visible disc at any altitude the zoom clamp allows.
        key.color.set(0xfff4e8);
        key.intensity = 0.52;
        key.position.set(-55, 70, 0);
        camera.add(key);
        if (!scene.children.includes(camera)) scene.add(camera);
    } catch (_) { /* lighting is a nicety; never let it break the globe */ }
}

/**
 * Wheel zoom + click-to-place, both owned at the container level.
 *
 * Attach-once for the lifetime of the page: teardownMap wipes the container's
 * children but not listeners bound to the container itself, so re-binding on
 * a rejoin would double every zoom step.
 */
let globeInputAttached = false;
// Below these a pointer gesture counts as a click, not a drag. globe.gl's own
// threshold is zero movement for a mouse, which silently ate guesses.
const GLOBE_CLICK_SLOP_PX = 6;
const GLOBE_CLICK_MAX_MS = 600;

function attachGlobeInputHandling(el) {
    if (globeInputAttached) return;
    globeInputAttached = true;

    // Item 1: exactly one wheel-zoom path. OrbitControls listens for wheel on
    // the canvas and dollies the camera itself, so with our handler running
    // too every scroll click double-stepped and stuttered. Intercepting in the
    // CAPTURE phase and stopping propagation means the canvas listener never
    // sees the event, while pinch (a touch gesture OrbitControls handles
    // internally) is untouched. passive:false is explicit because
    // /assets/js/passive-events-fix.js forces passive:true on any wheel
    // listener that omits it, which would break preventDefault.
    el.addEventListener('wheel', (e) => {
        e.preventDefault();
        e.stopPropagation();
        zoomGlobeByWheel(e.deltaY);
    }, { passive: false, capture: true });

    // Item 2: forgiving click-to-place. Capture phase so we resolve the
    // gesture before globe.gl's own pointerup listener (which defers its
    // click through rAF, so our stamp always lands first). No
    // stopPropagation: OrbitControls needs these events to finish its drag.
    let gesture = null;
    el.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || !e.isPrimary) return;
        // Any deliberate input takes the camera over immediately.
        cancelGlobeCameraTween();
        gesture = { id: e.pointerId, x: e.clientX, y: e.clientY, at: performance.now(), travel: 0 };
    }, { passive: true, capture: true });
    el.addEventListener('pointermove', (e) => {
        if (!gesture || e.pointerId !== gesture.id) return;
        // Track the furthest excursion, not just down-to-up displacement, so a
        // rotate-drag that happens to end where it began is still a drag.
        gesture.travel = Math.max(gesture.travel, Math.hypot(e.clientX - gesture.x, e.clientY - gesture.y));
    }, { passive: true, capture: true });
    el.addEventListener('pointercancel', () => { gesture = null; }, { passive: true, capture: true });
    el.addEventListener('pointerup', (e) => {
        if (!gesture || e.pointerId !== gesture.id) return;
        const g = gesture;
        gesture = null;
        // Claim the gesture whatever the verdict: globe.gl's fallback click
        // must not place a pin for a drag we just rejected.
        state.globeGestureAt = performance.now();
        if (!state.globe) return;
        const travel = Math.max(g.travel, Math.hypot(e.clientX - g.x, e.clientY - g.y));
        if (travel > GLOBE_CLICK_SLOP_PX) return;
        if (performance.now() - g.at > GLOBE_CLICK_MAX_MS) return;
        const rect = el.getBoundingClientRect();
        const coords = state.globe.toGlobeCoords(e.clientX - rect.left, e.clientY - rect.top);
        // null when the ray missed the sphere - a click on empty space.
        if (!coords) return;
        onGlobeClick(coords.lat, coords.lng);
    }, { passive: true, capture: true });
}

// Re-apply container dimensions to the globe whenever #globe-drop-map
// changes size (rotation, browser chrome show/hide, split-screen). Prefers
// ResizeObserver; falls back to debounced resize + orientationchange.
// Short-circuits when dimensions are unchanged to avoid RO feedback loops.
function attachGlobeResizeHandling(el) {
    if (state.globeResizeAttached) return;
    state.globeResizeAttached = true;
    const apply = () => {
        if (!state.globe || !el) return;
        const w = el.clientWidth;
        const h = el.clientHeight;
        if (w === state.lastGlobeWidth && h === state.lastGlobeHeight) return;
        state.lastGlobeWidth = w;
        state.lastGlobeHeight = h;
        state.globe.width(w);
        state.globe.height(h);
    };
    if (typeof ResizeObserver === 'function') {
        // Item 9: coalesce to one resize per frame. A drag on a split-screen
        // divider (or the mobile URL bar sliding away) delivers a burst of
        // observations, and each one used to run a synchronous
        // renderer.setSize + camera update inside the observer callback.
        let resizeRaf = null;
        const ro = new ResizeObserver(() => {
            if (resizeRaf) return;
            resizeRaf = requestAnimationFrame(() => {
                resizeRaf = null;
                apply();
            });
        });
        ro.observe(el);
        state.globeResizeObserver = ro;
    } else {
        let t = null;
        const debounced = () => {
            if (t) clearTimeout(t);
            t = setTimeout(apply, 100);
        };
        window.addEventListener('resize', debounced);
        window.addEventListener('orientationchange', debounced);
    }
}

/**
 * Item 10a: give the GPU its memory back.
 *
 * Dropping the container's innerHTML only removes the canvas - the WebGL
 * context, its geometries, materials and the multi-megabyte Earth texture
 * all stayed alive, and globe.gl's own render loop kept running against the
 * detached scene, so every leave/rejoin cycle stacked a new context on top
 * of the old one (browsers cap live contexts at ~16 and start killing the
 * oldest). globe.gl's _destructor stops that loop and empties the layers;
 * the rest is three.js internals, so all of it is best-effort.
 */
function disposeGlobeResources() {
    if (!state.globe) return;
    try {
        if (typeof state.globe._destructor === 'function') state.globe._destructor();
    } catch (_) { /* best-effort */ }
    try {
        const scene = state.globe.scene && state.globe.scene();
        if (scene && typeof scene.traverse === 'function') {
            scene.traverse((obj) => {
                if (obj.geometry && typeof obj.geometry.dispose === 'function') {
                    obj.geometry.dispose();
                }
                const materials = Array.isArray(obj.material)
                    ? obj.material
                    : (obj.material ? [obj.material] : []);
                materials.forEach((mat) => {
                    Object.keys(mat).forEach((key) => {
                        const val = mat[key];
                        if (val && val.isTexture && typeof val.dispose === 'function') val.dispose();
                    });
                    if (typeof mat.dispose === 'function') mat.dispose();
                });
            });
        }
    } catch (_) { /* best-effort */ }
    try {
        const renderer = state.globe.renderer && state.globe.renderer();
        if (renderer) {
            if (typeof renderer.dispose === 'function') renderer.dispose();
            // forceContextLoss exists on newer three builds; on the ones
            // where it doesn't, the extension is the same thing by hand.
            if (typeof renderer.forceContextLoss === 'function') {
                renderer.forceContextLoss();
            } else if (typeof renderer.getContext === 'function') {
                const ctx = renderer.getContext();
                const ext = ctx && ctx.getExtension && ctx.getExtension('WEBGL_lose_context');
                if (ext) ext.loseContext();
            }
        }
    } catch (_) { /* best-effort */ }
}

function teardownMap() {
    // Stop every local timer, release the GPU-side resources, then drop our
    // ref and clear the container.
    cancelGlobeCameraTween();
    cancelRevealChoreography();
    clearGlobeMarkers();
    disposeGlobeResources();
    const el = document.getElementById('globe-drop-map');
    if (el) el.innerHTML = '';
    if (state.globeResizeObserver) {
        state.globeResizeObserver.disconnect();
        state.globeResizeObserver = null;
    }
    state.globeResizeAttached = false;
    state.lastGlobeWidth = 0;
    state.lastGlobeHeight = 0;
    state.globe = null;
    state.pendingGuess = null;
    state.lastRenderedMapQuestion = null;
    state.lastRevealedMapQuestion = null;
    state.lastCameraTarget = null;
    state.revealChoreoForQuestion = null;
}

function clearMapOverlays() {
    clearGlobeMarkers();
    if (!state.globe) return;
    state.globe.pointsData([]);
    state.globe.htmlElementsData([]);
    state.globe.arcsData([]);
    state.globe.polygonsData([]);
    // Return the dash props to their settled (solid) state in case an early
    // advance cut the reveal's draw-on short mid-sweep.
    state.globe.arcDashGap(0).arcDashInitialGap(0).arcDashAnimateTime(0);
}

/**
 * Lazy-load world country features once and cache them keyed by ISO
 * 3166-1 numeric code. Source: world-atlas 110m TopoJSON, expanded
 * client-side via topojson-client.feature(). ~108 KB on the wire,
 * keys map 1-to-1 with REST Countries' ccn3 (now persisted on every
 * location as `countryCode`). Resolves to {} when the network fetch
 * fails so callers can safely ?. into the result.
 */
let countryFeaturesIndexPromise = null;
function loadCountryFeaturesIndex() {
    if (countryFeaturesIndexPromise) return countryFeaturesIndexPromise;
    countryFeaturesIndexPromise = (async () => {
        try {
            if (typeof window.topojson === 'undefined') return {};
            const res = await fetch('data/world-110m.json', { cache: 'force-cache' });
            if (!res.ok) return {};
            const topo = await res.json();
            const fc = window.topojson.feature(topo, topo.objects.countries);
            const idx = {};
            for (const f of fc.features) {
                idx[String(f.id).padStart(3, '0')] = f;
            }
            return idx;
        } catch (_) {
            return {};
        }
    })();
    return countryFeaturesIndexPromise;
}

/* =====================================================================
 * Animated show/hide for gameplay panels
 *
 * [hidden] is `display: none !important` in this app, so anything hidden
 * that way disappears on the frame it is set - the reveal panel and the FAB
 * stack both popped out of existence mid-loop. hideWithExit plays the
 * element's .is-leaving animation first and hides it only once that
 * finishes. The animationend listener is backed by a timeout on purpose:
 * an ancestor can be display:none'd out from under the element (leaving the
 * room mid-reveal) and the event then never fires, so the fallback is what
 * guarantees the element still ends up hidden. Under prefers-reduced-motion
 * the global 0.01ms duration rule makes animationend land almost
 * immediately, and the fallback simply never gets there first.
 * ===================================================================== */

const exitTransitions = new WeakMap();

function cancelExitTransition(el) {
    const pending = exitTransitions.get(el);
    if (pending) {
        clearTimeout(pending.timer);
        el.removeEventListener('animationend', pending.onEnd);
        exitTransitions.delete(el);
    }
    el.classList.remove('is-leaving');
}

function showWithEnter(el) {
    if (!el) return;
    cancelExitTransition(el);
    el.hidden = false;
}

function hideWithExit(el, durationMs, onHidden) {
    if (!el) return;
    if (el.hidden) { cancelExitTransition(el); return; }
    cancelExitTransition(el);
    const finish = () => {
        cancelExitTransition(el);
        el.hidden = true;
        if (onHidden) onHidden();
    };
    // Children animate too (the verdict line has its own entrance) and their
    // animationend bubbles, so only this element's own animation counts.
    const onEnd = (e) => { if (e.target === el) finish(); };
    el.addEventListener('animationend', onEnd);
    const timer = setTimeout(finish, durationMs + 80);
    exitTransitions.set(el, { timer, onEnd });
    el.classList.add('is-leaving');
}

const FAB_EXIT_MS = 200;
const REVEAL_EXIT_MS = 180;

function setClearBtnVisible(visible) {
    const btn = document.getElementById('globe-drop-clear-btn');
    const stack = document.getElementById('globe-drop-fab-stack');
    if (!btn || !stack) return;
    // The Clear button is the "a pin is placed" signal for the whole stack:
    // with no pin there is nothing to submit either. Visibility used to be a
    // CSS :has() collapse, which cannot animate - the stack (and on mobile
    // the fixed bottom action bar) blinked out. JS owns it now so the exit
    // has somewhere to run.
    btn.hidden = !visible;
    if (visible) showWithEnter(stack);
    else hideWithExit(stack, FAB_EXIT_MS);
}

function onGlobeClick(lat, lng) {
    // Only respond when we're in a live GlobeDrop game and haven't locked
    // in this question yet. We do NOT block on phase === 'asking' here -
    // the very first click immediately after the host starts the game can
    // race the questionStartedAt server timestamp landing in the local
    // cache (pendingWrite leaves it null for a tick), and that race was
    // making the first tap silently eat the guess. The submit handler
    // still enforces phase before writing.
    if (!state.roomData || state.roomData.status !== 'playing') return;
    if (state.roomData.gameType !== 'globe-drop') return;
    const loc = currentGlobeDropLocation();
    if (!loc) return;
    // Reject clicks once the reveal has already started for this question.
    const startMs = state.roomData.questionStartedAt && state.roomData.questionStartedAt.toMillis
        ? state.roomData.questionStartedAt.toMillis() : null;
    const revealMs = state.roomData.revealStartedAt && state.roomData.revealStartedAt.toMillis
        ? state.roomData.revealStartedAt.toMillis() : null;
    const phase = globeDropPhase(startMs, Date.now(), revealMs, currentAskingDurationMs());
    if (phase === 'reveal' || phase === 'ended') return;
    const me = state.roomPlayers.find((p) => state.user && p.uid === state.user.uid);
    if (me && me.currentAnsweredFor === loc.id) return;

    dismissGlobeTapHint();
    state.pendingGuess = { lat, lng };
    drawMyPinOnly(lat, lng);
    $('#globe-drop-submit-btn').disabled = false;
    setClearBtnVisible(true);
    Feedback.pinPlaced();
}

// Item 12: one-time "tap the globe" coach mark. Lives in .globe-drop-map-wrap
// (NOT #globe-drop-map - globe.gl wipes that element's children on init).
// pointer-events:none so it never eats the very tap it's teaching. Shown on
// the first question of a session only, auto-hides after 5s or on first click.
function showGlobeTapHintOnce() {
    if (state.globeTapHintShown) return;
    if (state.pendingGuess) return;
    const wrap = document.querySelector('.globe-drop-map-wrap');
    if (!wrap) return;
    state.globeTapHintShown = true;
    const hint = document.createElement('div');
    hint.className = 'globe-drop-tap-hint';
    hint.textContent = 'Tap anywhere on the globe to drop your pin';
    wrap.appendChild(hint);
    setTimeout(dismissGlobeTapHint, 5000);
}

function dismissGlobeTapHint() {
    const hint = document.querySelector('.globe-drop-tap-hint');
    if (hint) hint.hidden = true;
}

function drawMyPinOnly(lat, lng) {
    if (!state.globe) return;
    state.globe.htmlElementsData([globePinMarker('mine', 'mine', lat, lng)]);
    state.globe.pointsData([]);
    state.globe.arcsData([]);
    state.globe.polygonsData([]);
}

function placeMyPin(lat, lng) { drawMyPinOnly(lat, lng); }

function currentGlobeDropLocation() {
    if (!state.roomData) return null;
    const pool = Array.isArray(state.roomData.questions) ? state.roomData.questions : [];
    return pool.find((q) => q && q.id === state.roomData.currentQuestionId) || null;
}
function currentGlobeDropLocationId() {
    const loc = currentGlobeDropLocation();
    return loc ? loc.id : null;
}

/**
 * Resolve the per-question asking duration for the current room. The host
 * picks this in the lobby; if the room predates the field (or it's 0/null),
 * fall back to the mode-appropriate Config default so old rooms still work.
 */
function currentAskingDurationMs() {
    const ms = state.roomData && state.roomData.questionTimeMs;
    if (typeof ms === 'number' && ms > 0) return ms;
    return (state.roomData && state.roomData.gameType === 'globe-drop')
        ? Config.GLOBE_DROP_LOCATION_TIME_MS
        : Config.QUESTION_TIME_MS;
}

/**
 * Phase function for GlobeDrop - same shape as RoomState.questionPhase but
 * keyed off the per-room duration (host-configurable) for asking and
 * GLOBE_DROP_REVEAL_TIME_MS for reveal.
 */
function globeDropPhase(startedAtMs, nowMs, revealStartedAtMs, askingDurationMs) {
    if (!startedAtMs) return 'idle';
    const asking = (typeof askingDurationMs === 'number' && askingDurationMs > 0)
        ? askingDurationMs
        : Config.GLOBE_DROP_LOCATION_TIME_MS;
    if (revealStartedAtMs) {
        const revealElapsed = nowMs - revealStartedAtMs;
        if (revealElapsed < 0) return 'asking';
        if (revealElapsed < Config.GLOBE_DROP_REVEAL_TIME_MS) return 'reveal';
        return 'ended';
    }
    const elapsed = nowMs - startedAtMs;
    if (elapsed < 0) return 'idle';
    if (elapsed < asking) return 'asking';
    if (elapsed < asking + Config.GLOBE_DROP_REVEAL_TIME_MS) return 'reveal';
    return 'ended';
}

function globeDropTimeLeftMs(startedAtMs, nowMs, revealStartedAtMs, askingDurationMs) {
    const asking = (typeof askingDurationMs === 'number' && askingDurationMs > 0)
        ? askingDurationMs
        : Config.GLOBE_DROP_LOCATION_TIME_MS;
    if (!startedAtMs) return asking;
    if (revealStartedAtMs) return 0;
    const elapsed = nowMs - startedAtMs;
    return Math.max(0, Math.min(asking, asking - elapsed));
}

function renderGlobeDropStage() {
    hide($('#stage-lobby'));
    hide($('#stage-game'));
    hide($('#stage-end'));
    hide($('#stage-picking'));
    show($('#stage-globe-drop'));

    const idx = state.roomData.currentQuestionIndex || 0;
    const total = state.roomData.totalQuestions || 0;
    setText($('#globe-drop-progress-now'), String(idx + 1));
    setText($('#globe-drop-progress-total'), String(total));

    const loc = currentGlobeDropLocation();
    if (!loc) return;

    setText($('#globe-drop-target-name'), loc.name || '…');

    // Difficulty drives which hints render:
    //   easy   - country + continent + subregion (full geographic context)
    //   medium - country + continent
    //   hard   - country only (no continent/subregion hint)
    // We look up the tier from the room doc; legacy rooms (no difficulty
    // field) read as medium and show the prior country-only behaviour.
    const diff = GlobeDropScoring.difficultySettings(state.roomData.difficulty);
    const hintLevel = diff.hintLevel;
    setText($('#globe-drop-target-country'), loc.country || '');

    const hintsEl = $('#globe-drop-prompt-hints');
    const extra = [];
    // Defensive: hard mode (hintLevel='none') must never produce any extras,
    // even if a future hintLevel key accidentally matches one of the branches
    // below. The outer guard makes this airtight regardless of config drift.
    if (hintLevel !== 'none') {
        if (hintLevel === 'country+continent' || hintLevel === 'country+continent+subregion') {
            if (loc.region) extra.push(loc.region);
        }
        if (hintLevel === 'country+continent+subregion') {
            if (loc.subregion && loc.subregion !== loc.region) extra.push(loc.subregion);
        }
    }
    // Item 9: the hints line stays in flow even when this location has no
    // region data. It is a full-width flex row inside the prompt card, so
    // toggling [hidden] on it moved the whole globe up and down between
    // rounds; CSS reserves its line box instead. Clearing the text is what
    // hides it, which also guarantees a previous round's hint can never
    // bleed through.
    setText(hintsEl, extra.length ? extra.join(' · ') : '');

    // Difficulty chip - shows the tier label only (no "+50% score"
    // claim, since difficulty now controls timer + hint level only,
    // not scoring; per-round multiplier comes from the round ladder).
    const chip = $('#globe-drop-difficulty-chip');
    if (state.roomData.difficulty && state.roomData.difficulty !== 'medium') {
        setText(chip, diff.label);
        chip.removeAttribute('hidden');
        chip.dataset.tier = state.roomData.difficulty;
    } else {
        chip.setAttribute('hidden', '');
    }

    // Init the globe after the stage is visible so its container has a
    // measurable size. globe.gl reads dimensions during construction.
    // Three.js scene construction + texture upload is the >200ms blocking
    // chunk at game start; running it inside requestIdleCallback (with a
    // setTimeout fallback for browsers without idle callbacks) lets the
    // browser paint the question prompt and timer first, so the rAF loop
    // never has to share its frame with that work.
    const deferGlobeInit = (cb) => {
        if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
            window.requestIdleCallback(cb, { timeout: 200 });
        } else {
            setTimeout(cb, 0);
        }
    };
    deferGlobeInit(() => {
        // The deferred fire-time can land AFTER leaveRoom() has nulled
        // state.roomData, which then crashes the phase/reveal code below
        // with `Cannot read properties of null (reading 'questionStartedAt')`.
        // Bail if the room is gone - there's nothing to render.
        if (!state.roomData || !state.roomCode) return;
        // Smooth-scroll the question prompt to the top of the viewport
        // on each new question. Anchoring to the "Where is …" header
        // (not the globe) means the player sees the city name first,
        // then the globe sits naturally below - no hunting for the
        // prompt after a long live-standings panel. Once per question
        // so the viewport doesn't yank mid-round.
        // On mobile the prompt row is position:sticky (item 11), so a
        // scrollIntoView on every new question just yanks the viewport for
        // no benefit - skip it there. Desktop keeps the smooth scroll.
        // Item 9: deferred a frame so it measures AFTER this render's layout
        // changes (the rounds-history board appearing after round 1 is the
        // big one). Measuring first meant scrolling to a rect that the same
        // render was about to move.
        const promptRow = document.querySelector('.globe-drop-prompt-row');
        if (promptRow && window.innerWidth > 768
            && state.lastScrolledToGlobeForQId !== currentGlobeDropLocationId()) {
            state.lastScrolledToGlobeForQId = currentGlobeDropLocationId();
            requestAnimationFrame(() => {
                if (!state.roomData || !state.roomCode) return;
                // Trigger on the whole play surface, not just the prompt row:
                // at 1280x800 from page top the row is fully visible while the
                // globe below it is cut off by the fold, so a row-only test
                // never fires and the player starts the round unable to see
                // the bottom of the globe. Scroll when the globe overflows the
                // viewport, or when the row itself has scrolled above it.
                const rect = promptRow.getBoundingClientRect();
                const mapEl = document.getElementById('globe-drop-map');
                const mapRect = mapEl ? mapEl.getBoundingClientRect() : null;
                const globeCutOff = !!mapRect && mapRect.bottom > window.innerHeight;
                if (rect.top < 0 || globeCutOff) {
                    try {
                        // block:'start' (not 'nearest', which is a no-op once
                        // the row is fully visible) parks the row at the top,
                        // and its scroll-margin-top keeps it under the fixed
                        // site header, leaving the globe fully in frame.
                        promptRow.scrollIntoView({
                            behavior: prefersReducedMotion() ? 'auto' : 'smooth',
                            block: 'start',
                        });
                    } catch (_) { /* older browsers */ }
                }
            });
        }
        const globeExisted = !!state.globe;
        const g = ensureGlobe();
        if (!g) return;
        const el = document.getElementById('globe-drop-map');
        if (el) { g.width(el.clientWidth); g.height(el.clientHeight); }
        showGlobeTapHintOnce();

        // New question? Wipe overlays, cancel anything the last reveal still
        // had in flight (the host can advance mid-choreography at any moment)
        // and re-arm the controls.
        if (state.lastRenderedMapQuestion !== loc.id) {
            cancelRevealChoreography();
            clearMapOverlays();
            // Item 5: pull back to a neutral explore altitude so every round
            // opens on the same deliberate beat instead of wherever the last
            // reveal parked the camera. Current lat/lng are kept - a spin back
            // to (20, 0) between rounds was disorienting. Skipped on the render
            // that just built the globe, where the first-load ease owns the
            // camera.
            if (globeExisted) {
                const pov = state.globe.pointOfView();
                flyGlobeCameraTo({ lat: pov.lat, lng: pov.lng, altitude: GLOBE_EXPLORE_ALTITUDE }, 800);
            }
            state.lastRenderedMapQuestion = loc.id;
            state.lastRevealedMapQuestion = null;
            state.lastCameraTarget = null;        // re-arm the reveal-pan guard
            state.revealChoreoForQuestion = null; // re-arm the reveal sequence
            state.pendingGuess = null;
            $('#globe-drop-submit-btn').disabled = true;
            setClearBtnVisible(false);
            // Item 7: the panel fades out before it goes [hidden], and its
            // contents are wiped only once it has - clearing them up front
            // would show an empty panel for the length of the fade. Stale
            // trivia in particular must never flash back on the next
            // question; it only renders after a fresh fetch resolves.
            hideWithExit($('#globe-drop-reveal'), REVEAL_EXIT_MS, () => {
                const sentimentEl = $('#globe-drop-reveal-sentiment');
                setText(sentimentEl, '');
                sentimentEl.hidden = true;
                const triviaEl = $('#globe-drop-reveal-trivia');
                triviaEl.textContent = '';
                triviaEl.hidden = true;
            });
        }

        // Lock the controls if we've already submitted this question.
        const me = state.roomPlayers.find((p) => state.user && p.uid === state.user.uid);
        const meSubmitted = !!(me && me.currentAnsweredFor === loc.id && me.currentGuess);
        if (meSubmitted) {
            $('#globe-drop-submit-btn').disabled = true;
            setClearBtnVisible(false);
        }

        // Three reveal states:
        //   - global (showOthers=true)  : reveal phase has begun for the room
        //   - local  (showOthers=false) : I've submitted but others are still
        //                                 guessing - show me my result, hide theirs
        //   - none                       : still asking, I haven't submitted yet
        // We tag lastRevealedMapQuestion with `:local` vs `:global` so the
        // transition from local → global redraws to include opponents' pins.
        const startMs = state.roomData.questionStartedAt && state.roomData.questionStartedAt.toMillis
            ? state.roomData.questionStartedAt.toMillis() : null;
        const revealMs = state.roomData.revealStartedAt && state.roomData.revealStartedAt.toMillis
            ? state.roomData.revealStartedAt.toMillis() : null;
        const phase = globeDropPhase(startMs, Date.now(), revealMs, currentAskingDurationMs());
        const globalReveal = phase === 'reveal' || phase === 'ended';
        const globalTag = loc.id + ':global';
        const localTag = loc.id + ':local';
        if (globalReveal && state.lastRevealedMapQuestion !== globalTag) {
            drawGlobeDropReveal(loc, me, { showOthers: true });
            state.lastRevealedMapQuestion = globalTag;
        } else if (!globalReveal && meSubmitted && state.lastRevealedMapQuestion !== localTag) {
            drawGlobeDropReveal(loc, me, { showOthers: false });
            state.lastRevealedMapQuestion = localTag;
        }
    }, 50);

    renderMiniBoardGlobeDrop(loc.id);
    syncStandingsCollapse(loc);
    startGlobeDropTimerLoop();
}

/**
 * Write the local player's "ready to advance" marker for the current
 * question. The host's rAF gate watches every player's readyAfterQId;
 * once everyone matches the current question id, the next round (or
 * the end stage, for the final question) fires early instead of
 * waiting out the full 10-second reveal window
 * (Config.GLOBE_DROP_REVEAL_TIME_MS).
 */
async function markReadyForNext() {
    if (!state.user || !state.roomCode || !state.roomData) return;
    const loc = currentGlobeDropLocation();
    if (!loc || !loc.id) return;
    const me = state.roomPlayers.find((p) => p.uid === state.user.uid);
    if (me && me.readyAfterQId === loc.id) return; // already marked
    try {
        await updateDoc(doc(db, 'triviaRooms', state.roomCode, 'players', state.user.uid), {
            readyAfterQId: loc.id
        });
    } catch (err) {
        console.warn('markReadyForNext failed:', err);
    }
}

/**
 * Render the Ready bar inside the reveal panel.
 *
 * Visible from the moment I submit (so it's not a surprise once
 * global reveal hits) - but disabled until every player has either
 * submitted or timed out for this round. That gives a clear
 * affordance for "we're waiting on someone" instead of the button
 * silently appearing later.
 */
// Item 8: the rAF loop calls renderReadyBar EVERY frame for the whole reveal
// window (~600 calls), and it used to rewrite both innerHTMLs each time -
// pure layout thrash, and it restarted any animation on those nodes before it
// could play. The bar's content is a pure function of a handful of values, so
// it is rebuilt only when that signature actually changes.
let lastReadyBarSignature = null;

function renderReadyBar(phase) {
    const bar = $('#globe-drop-ready-bar');
    if (!bar) return;
    const loc = currentGlobeDropLocation();
    const me = state.user
        ? state.roomPlayers.find((p) => p.uid === state.user.uid)
        : null;
    const meSubmitted = !!(me && me.currentAnsweredFor === (loc && loc.id));
    const inReveal = phase === 'reveal' || phase === 'ended';
    // Show during global reveal OR once I've submitted (local reveal).
    const visible = !!loc && (inReveal || meSubmitted);
    bar.hidden = !visible;
    if (!visible) { lastReadyBarSignature = null; return; }

    const players = state.roomPlayers || [];
    const allSubmitted = players.length > 0
        && players.every((p) => p && p.currentAnsweredFor === loc.id);
    const meReady = !!(me && me.readyAfterQId === loc.id);

    // Last round: relabel to "Finish" - the click ends the game, not
    // "ready for next."
    const room = state.roomData || {};
    const idx = room.currentQuestionIndex || 0;
    const totalQ = room.totalQuestions || 0;
    const isLast = totalQ > 0 && idx >= totalQ - 1;
    const waitingForOthers = !allSubmitted && !inReveal;
    const readyCount = players.filter((p) => p.readyAfterQId === loc.id).length;
    const label = isLast ? 'finishing' : 'ready';

    let btnHtml;
    if (waitingForOthers) {
        btnHtml = '<span aria-hidden="true">⏳</span> Waiting for opponents';
    } else if (meReady) {
        btnHtml = isLast
            ? '<span aria-hidden="true">✓</span> Finishing'
            : '<span aria-hidden="true">✓</span> You\'re ready';
    } else {
        btnHtml = isLast
            ? '<span aria-hidden="true">🏁</span> Finish'
            : '<span aria-hidden="true">⏭</span> Ready';
    }

    let statusHtml;
    if (players.length > 4) {
        statusHtml = `<small>${readyCount}/${players.length} ${label}</small>`;
    } else {
        const pips = players.map((p) => {
            const isReady = p.readyAfterQId === loc.id;
            return `<span class="ready-pip${isReady ? ' is-ready' : ''}">${escapeHtml(p.displayName || 'Player')}</span>`;
        }).join('');
        statusHtml = `${pips} <small>${readyCount}/${players.length} ${label}</small>`;
    }

    // Everything above is string building - no DOM was touched. Bail before
    // the writes when nothing the bar shows has changed since the last frame.
    const signature = `${loc.id}|${meReady || waitingForOthers}|${btnHtml}|${statusHtml}`;
    if (signature === lastReadyBarSignature) return;
    lastReadyBarSignature = signature;

    const btn = $('#globe-drop-ready-btn');
    if (btn) {
        btn.disabled = meReady || waitingForOthers;
        btn.innerHTML = btnHtml;
    }
    const statusEl = $('#globe-drop-ready-status');
    if (statusEl) statusEl.innerHTML = statusHtml;
}

/* =====================================================================
 * Reveal choreography
 *
 * The reveal window is 10s but the host can advance out of it at ANY moment,
 * so every step the sequence schedules is registered here and the whole thing
 * comes down in one cancelRevealChoreography() call from the new-question
 * reset. Total runtime is ~1.6s, well inside the window.
 * ===================================================================== */

const REVEAL_CAMERA_MS = 1300;
const REVEAL_PANEL_MS = 180;
const REVEAL_COUNT_MS = 700;
const REVEAL_SENTIMENT_MS = 1000;
const REVEAL_ARC_DRAW_MS = 900;
const revealChoreo = { timeouts: [], raf: null };

function scheduleRevealStep(fn, delayMs) {
    // Reduced motion: land on the end state immediately rather than staging it.
    if (!delayMs || prefersReducedMotion()) { fn(); return; }
    revealChoreo.timeouts.push(setTimeout(fn, delayMs));
}

function cancelRevealChoreography() {
    revealChoreo.timeouts.forEach((id) => clearTimeout(id));
    revealChoreo.timeouts.length = 0;
    if (revealChoreo.raf) cancelAnimationFrame(revealChoreo.raf);
    revealChoreo.raf = null;
}

function countUpKm(el, targetKm) {
    const format = (v) => Math.round(v).toLocaleString();
    if (prefersReducedMotion()) { el.textContent = format(targetKm); return; }
    const started = performance.now();
    const step = (now) => {
        const p = Math.min(1, (now - started) / REVEAL_COUNT_MS);
        el.textContent = format(targetKm * (1 - Math.pow(1 - p, 3)));
        if (p < 1) { revealChoreo.raf = requestAnimationFrame(step); return; }
        revealChoreo.raf = null;
        el.textContent = format(targetKm);
    };
    revealChoreo.raf = requestAnimationFrame(step);
}

/**
 * One-shot draw-on for the reveal arcs. dashLength 1 / dashGap 1 /
 * initialGap 1 clips the arc away entirely, and globe.gl's dash animation
 * then sweeps the visible window start -> end over exactly
 * arcDashAnimateTime. That animation loops (it would start erasing on the
 * second pass), so we settle the layer to a solid line as the first pass lands.
 */
function startRevealArcDraw() {
    if (!state.globe) return;
    if (prefersReducedMotion()) return;
    state.globe.arcDashLength(1).arcDashGap(1).arcDashInitialGap(1).arcDashAnimateTime(REVEAL_ARC_DRAW_MS);
    scheduleRevealStep(() => {
        if (!state.globe) return;
        state.globe.arcDashGap(0).arcDashInitialGap(0).arcDashAnimateTime(0);
    }, REVEAL_ARC_DRAW_MS + 40);
}

function drawGlobeDropReveal(loc, me, { showOthers = true } = {}) {
    if (!state.globe) return;

    const meSubmitted = me && me.currentGuess && me.currentAnsweredFor === loc.id;
    // The local reveal ("I submitted, others are still guessing") and the
    // global one are two calls for the same question. Choreograph only the
    // first: the second exists to add the opponents' markers, and re-running
    // the sequence would restart the count-up and re-fly a settled camera.
    const isFirstReveal = state.revealChoreoForQuestion !== loc.id;
    if (isFirstReveal) {
        cancelRevealChoreography();
        state.revealChoreoForQuestion = loc.id;
        // A fresh reveal owns the panel. The new-question fade-out clears
        // the previous trivia when it completes, but a reveal that lands
        // during that fade cancels it (a client rendering a question that
        // is already in its reveal window), so drop it here too.
        const staleTrivia = $('#globe-drop-reveal-trivia');
        staleTrivia.textContent = '';
        staleTrivia.hidden = true;
    }

    // Always shown: the answer pin (gold) + my pin (indigo) if I've submitted.
    // Both are DOM markers so the drop-in can be real CSS animation; the guess
    // pin keeps the identity it was placed with, so the reveal never re-grows
    // a pin that has been sitting there since the player dropped it.
    const pins = [globePinMarker('actual', 'actual', loc.lat, loc.lng)];
    if (meSubmitted) {
        pins.push(globePinMarker('mine', 'mine', me.currentGuess.lat, me.currentGuess.lng));
    }
    state.globe.htmlElementsData(pins);

    // Opponents' pins (red) stay hidden during the local reveal - surfacing
    // them would let me yell their pick across the room before they lock in.
    const points = [];
    if (showOthers) {
        state.roomPlayers.forEach((p) => {
            if (!p || !p.currentGuess) return;
            if (p.currentAnsweredFor !== loc.id) return;
            if (state.user && p.uid === state.user.uid) return; // drawn as my pin
            points.push(globePointMarker(`guess:${p.uid}`, {
                lat: p.currentGuess.lat, lng: p.currentGuess.lng,
                color: '#f87171',
                size: 0.55,
                label: p.displayName
            }));
        });
    }
    state.globe.pointsData(points);

    // Great-circle arcs from each guess to the actual location. The
    // outbound colour (per-player) fades into gold at the truth so it
    // reads as "your pin → the right spot". The guess has to be the arc's
    // START point: the draw-on sweep runs start -> end. During the local
    // reveal we only draw the player's own arc; during the global reveal we
    // add every opponent so the result feels collective.
    const arcs = [];
    if (meSubmitted) {
        arcs.push(globeArcMarker('arc:me', {
            startLat: me.currentGuess.lat,
            startLng: me.currentGuess.lng,
            endLat: loc.lat,
            endLng: loc.lng,
            altitude: globeArcAltitudeForDistance(GlobeDropScoring.haversineDistanceKm(
                me.currentGuess.lat, me.currentGuess.lng, loc.lat, loc.lng
            )),
            color: ['#6366f1', '#fcd34d']
        }));
    }
    if (showOthers) {
        state.roomPlayers.forEach((p) => {
            if (!p || !p.currentGuess) return;
            if (p.currentAnsweredFor !== loc.id) return;
            if (state.user && p.uid === state.user.uid) return; // already added above
            arcs.push(globeArcMarker(`arc:${p.uid}`, {
                startLat: p.currentGuess.lat,
                startLng: p.currentGuess.lng,
                endLat: loc.lat,
                endLng: loc.lng,
                altitude: globeArcAltitudeForDistance(GlobeDropScoring.haversineDistanceKm(
                    p.currentGuess.lat, p.currentGuess.lng, loc.lat, loc.lng
                )),
                color: ['#f87171', '#fcd34d']
            }));
        });
    }
    state.globe.arcsData(arcs);
    if (isFirstReveal && arcs.length) startRevealArcDraw();

    // Reveal-phase country border. Lazy-load the world-countries
    // index on first call, then hand globe.gl exactly one polygon
    // (the correct country) so the focus stays on the answer.
    // Fire-and-forget; if the network or topojson lib isn't ready
    // we silently skip the overlay rather than blocking the reveal.
    loadCountryFeaturesIndex().then((idx) => {
        if (!state.globe) return;
        // Race guard: only paint if this is still the question on
        // screen - a fast next-question would otherwise leak the
        // previous country's border into the new round.
        const stillCurrent = state.lastRenderedMapQuestion === loc.id
            || state.lastRevealedMapQuestion === loc.id + ':local'
            || state.lastRevealedMapQuestion === loc.id + ':global';
        if (!stillCurrent) return;
        const code = loc.countryCode && String(loc.countryCode).padStart(3, '0');
        const feat = code ? idx[code] : null;
        state.globe.polygonsData(feat ? [feat] : []);
    });

    // Cinematic camera flight that frames BOTH pins: aim at their great-circle
    // midpoint at an altitude scaled to the miss, in one eased tween that also
    // rises over the middle of a long pan (see flyGlobeCameraTo), so a player
    // zoomed right in isn't dragged across the surface. Guarded by
    // lastCameraTarget so local → global doesn't re-fire.
    const camTarget = `${loc.id}:${loc.lat.toFixed(3)},${loc.lng.toFixed(3)}`;
    if (state.lastCameraTarget !== camTarget) {
        state.lastCameraTarget = camTarget;
        flyGlobeCameraTo(meSubmitted
            ? globeFrameForPair(me.currentGuess.lat, me.currentGuess.lng, loc.lat, loc.lng)
            : { lat: loc.lat, lng: loc.lng, altitude: 0.6 },
        REVEAL_CAMERA_MS);
    }

    // Reveal panel: distance + points or "no guess"
    const revealEl = $('#globe-drop-reveal');
    const distEl = $('#globe-drop-reveal-distance');
    const sentimentEl = $('#globe-drop-reveal-sentiment');
    let sentiment;
    if (meSubmitted) {
        const d = GlobeDropScoring.haversineDistanceKm(
            me.currentGuess.lat, me.currentGuess.lng, loc.lat, loc.lng
        );
        const { points, basePoints } = GlobeDropScoring.scoreGuess({
            distanceKm: d,
            multiplier: loc.multiplier
        });
        // Always basePoints × multiplier = points. The base is floored so it
        // is never 0, and there is no streak/bonus addition, so this equation
        // is exact and matches the recap table. For a x1 round the base IS the
        // total, so we skip the redundant "× 1 =" tail.
        const multNum = typeof loc.multiplier === 'number' ? loc.multiplier : 1;
        const multStr = multNum.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
        const multTxt = multNum !== 1
            ? ` × ${multStr} = <strong>${points}</strong>`
            : '';
        // The distance counts up from zero (item 4e), so it starts as its own
        // span with a placeholder; the points land with gd-score-pulse as the
        // count finishes. Only written on the first reveal - the global reveal
        // produces identical markup and would clobber a running count-up.
        if (isFirstReveal) {
            distEl.classList.remove('is-pulse');
            distEl.innerHTML = `<span class="gd-reveal-km">0</span> km off: <strong>${basePoints}</strong>/100${multTxt}`;
            const kmEl = distEl.querySelector('.gd-reveal-km');
            scheduleRevealStep(() => countUpKm(kmEl, d), REVEAL_PANEL_MS);
            scheduleRevealStep(() => distEl.classList.add('is-pulse'), REVEAL_PANEL_MS + REVEAL_COUNT_MS);
        }
        if (d < 100) sentiment = '🎯 Bullseye!';
        else if (d < 500) sentiment = 'Close, nicely done.';
        else if (d < 2000) sentiment = 'Not bad.';
        else sentiment = 'Way off, but you tried.';
        if (!showOthers) sentiment += ' Waiting for the rest…';
        // Reveal sound + haptic, tiered by points earned (so a tiny-city
        // bullseye gets the celebratory sound, an antipodal guess gets a
        // soft minor descent). Only fires on the LOCAL reveal - the
        // global reveal doesn't re-trigger so opponents' arcs landing
        // don't make a second buzz.
        if (!showOthers) {
            try { Feedback.revealForScore(points); } catch (_) { /* ignore */ }
        }
    } else {
        if (isFirstReveal) distEl.textContent = 'No guess submitted (minimum score awarded).';
        sentiment = showOthers ? '⏱ Time up.' : 'Waiting for the rest…';
    }
    // Item 4f: the sentiment line used to be written into #globe-drop-status,
    // which is display:none - it never rendered once in the shipped game.
    setText(sentimentEl, sentiment);
    if (isFirstReveal) {
        // Panel enters just after the camera starts moving, not on top of it.
        // showWithEnter, not `hidden = false`: the previous question's
        // fade-out can still be in flight, and its pending hide would
        // otherwise close this panel a beat after it opened.
        sentimentEl.hidden = true;
        scheduleRevealStep(() => showWithEnter(revealEl), REVEAL_PANEL_MS);
        scheduleRevealStep(() => { sentimentEl.hidden = false; }, REVEAL_SENTIMENT_MS);
    } else {
        showWithEnter(revealEl);
        sentimentEl.hidden = false;
    }

    // Wikipedia escape hatch. Always rendered when the reveal opens -
    // the inline trivia summary loads async and can fail; the link is
    // useful either way. Title prefers the location's own name (capital
    // city / landmark / country), which is what Wikipedia indexes.
    const wikiEl = $('#globe-drop-reveal-wiki');
    if (wikiEl) {
        const title = String(loc.name || loc.country || '').trim();
        if (title) {
            wikiEl.href = 'https://en.wikipedia.org/wiki/' + encodeURIComponent(title.replace(/\s+/g, '_'));
            wikiEl.hidden = false;
        } else {
            wikiEl.hidden = true;
        }
    }

    // The hint is an empty contentless paragraph; the reveal panel is now
    // a globe overlay, so toggling the hint's visibility here would only
    // shift the globe up mid-reveal. Leave it as-is across the
    // submit -> reveal window (item 5) so the globe never moves.

    // Wikipedia trivia (best-effort; silently skipped on failure). Fetch
    // once per question - the local reveal kicks off the request so it's
    // already in the panel by the time the global reveal hits. The
    // resolve callback re-checks that we're still on the same question
    // so a slow response from the previous round can't bleed in.
    if (state.triviaFetchedFor !== loc.id) {
        state.triviaFetchedFor = loc.id;
        const startedForId = loc.id;
        GlobeDropLocations.fetchCityTrivia(loc.name).then((text) => {
            if (!text) return;
            // Drop the response if the question has advanced (race).
            if (state.triviaFetchedFor !== startedForId) return;
            const curLoc = currentGlobeDropLocation();
            if (!curLoc || curLoc.id !== startedForId) return;
            const triviaEl = $('#globe-drop-reveal-trivia');
            triviaEl.textContent = text;
            triviaEl.hidden = false;
        }).catch(() => { /* ignore */ });
    }
}

// Item 13: mobile collapse of the live-standings + rounds-history boards.
// State lives as a class on #stage-globe-drop (CSS does the actual hiding,
// and only on <=768px). Desktop ignores the class entirely.
function applyStandingsCollapsed() {
    const stage = document.getElementById('stage-globe-drop');
    if (stage) stage.classList.toggle('standings-collapsed', state.standingsCollapsed);
    const toggle = document.getElementById('globe-drop-standings-toggle');
    if (toggle) toggle.setAttribute('aria-expanded', String(!state.standingsCollapsed));
}

// Reset the collapse to its default (collapsed) once per question. The
// collapse state only ever changes by user toggle or this per-question
// reset - submitting no longer auto-expands the board (that pushed the
// globe down mid-reveal). Instead, while the local player has submitted
// (reveal live) and the board is still collapsed, a subtle pulse cue
// nudges the toggle. Desktop is unaffected (CSS no-ops the class there).
function syncStandingsCollapse(loc) {
    if (!loc) return;
    if (state.standingsToggleQId !== loc.id) {
        state.standingsToggleQId = loc.id;
        state.standingsCollapsed = true;
    }
    const me = state.user
        ? state.roomPlayers.find((p) => p.uid === state.user.uid)
        : null;
    const meSubmitted = !!(me && me.currentAnsweredFor === loc.id);
    applyStandingsCollapsed();
    // Pulse the toggle when there's something new to see (I've submitted)
    // but the board is still collapsed. Clears the moment it's expanded or
    // the next question resets the collapse.
    const toggle = document.getElementById('globe-drop-standings-toggle');
    if (toggle) {
        const shouldPulse = meSubmitted && state.standingsCollapsed;
        toggle.classList.toggle('is-pulsing', shouldPulse);
    }
}

/**
 * Play a one-shot CSS animation class and take it off again so it can fire
 * next time. The timeout is the safety net: if the element is not being
 * rendered (a collapsed board, a hidden stage) animationend never arrives
 * and the class would stick, permanently disarming the cue.
 */
function pulseOnce(el, className, durationMs) {
    if (!el) return;
    el.classList.remove(className);
    // Reflow so removing + re-adding restarts the animation.
    // eslint-disable-next-line no-void
    void el.offsetWidth;
    el.classList.add(className);
    let timer = null;
    const clear = () => {
        clearTimeout(timer);
        el.removeEventListener('animationend', onEnd);
        el.classList.remove(className);
    };
    const onEnd = (e) => { if (e.target === el) clear(); };
    el.addEventListener('animationend', onEnd);
    timer = setTimeout(clear, durationMs + 80);
}

const MINI_BOARD_ROW_HTML =
    '<span class="mini-board-rank"></span>'
    + '<span class="mini-board-name"></span>'
    + '<span class="mini-board-streak" hidden></span>'
    + '<span class="mini-board-check" aria-hidden="true"></span>'
    + '<span class="mini-board-score"></span>';

function renderMiniBoardGlobeDrop(currentQuestionId) {
    const list = $('#mini-board-list-globe-drop');
    list.classList.toggle('is-crowded', state.roomPlayers && state.roomPlayers.length > 4);
    // Anti-peek: if I haven't submitted the current round, redact each
    // opponent's contribution from THIS round so I can't infer their
    // distance/score before I've committed mine. The reveal phase
    // already discloses scores once everyone is in. My own score
    // always reflects my real running total.
    const me = state.user
        ? state.roomPlayers.find((p) => p.uid === state.user.uid)
        : null;
    const meSubmittedCurrent = !!(me && currentQuestionId && me.currentAnsweredFor === currentQuestionId);
    // Totals are recomputed from distance (see globeDropDisplayScore) so the
    // live standings use one formula for everyone and stay consistent with the
    // "Rounds so far" board + the recap, instead of trusting each client's
    // stored p.score.
    const adjustedScore = (p) => {
        const fullTotal = globeDropPlayerTotal(p);
        if (!currentQuestionId) return fullTotal;
        const isMe = state.user && p.uid === state.user.uid;
        if (isMe || meSubmittedCurrent) return fullTotal;
        // Strip the current round's (recomputed) points so we don't reveal an
        // opponent's result before the local player has submitted.
        const answers = Array.isArray(p.answers) ? p.answers : [];
        const rec = answers.find((a) => a && a.locationId === currentQuestionId);
        if (!rec) return fullTotal;
        const pool = (state.roomData && Array.isArray(state.roomData.questions)) ? state.roomData.questions : [];
        const loc = pool.find((q) => q && q.id === currentQuestionId);
        return fullTotal - globeDropDisplayScore(rec, loc).points;
    };
    // Carry each player's globeDropStreak from the Firestore doc so the
    // streak chip renders correctly in the mini-board.
    const playerStreak = (p) => {
        const full = state.roomPlayers.find((rp) => rp.uid === p.uid);
        return full ? (full.globeDropStreak || 0) : 0;
    };
    const ranked = Scoring.rankPlayers(state.roomPlayers.map((p) => ({
        displayName: p.displayName,
        score: adjustedScore(p),
        streak: p.globeDropStreak || 0,
        uid: p.uid,
        answeredThisQuestion: currentQuestionId != null
            && p.currentAnsweredFor === currentQuestionId
            && p.currentGuess != null
    })));
    // Determine the current phase so we can show the pending pulse only during
    // the asking window (not during reveal when everyone's result is locked).
    const startMs = state.roomData && state.roomData.questionStartedAt && state.roomData.questionStartedAt.toMillis
        ? state.roomData.questionStartedAt.toMillis() : null;
    const revealMs = state.roomData && state.roomData.revealStartedAt && state.roomData.revealStartedAt.toMillis
        ? state.roomData.revealStartedAt.toMillis() : null;
    const currentPhase = globeDropPhase(startMs, Date.now(), revealMs, currentAskingDurationMs());
    const isAskingPhase = currentPhase === 'asking';

    // Item 8: rows are keyed by uid and updated in place. The old
    // innerHTML='' rebuild handed every snapshot a brand new node, which
    // starts at its final computed style - so the 180ms .mini-board-check
    // slide-in could never play, and a row could not react to a change
    // because it had no previous state to change from.
    const existing = new Map();
    Array.from(list.children).forEach((node) => {
        if (node.dataset.uid) existing.set(node.dataset.uid, node);
        else node.remove();
    });
    ranked.forEach((p, i) => {
        let li = existing.get(p.uid);
        const isNew = !li;
        if (isNew) {
            li = document.createElement('li');
            li.className = 'mini-board-row';
            li.dataset.uid = p.uid;
            li.innerHTML = MINI_BOARD_ROW_HTML;
        } else {
            existing.delete(p.uid);
        }
        // Only touch the DOM where the rank order actually changed - moving
        // a node restarts its CSS animations.
        if (list.children[i] !== li) list.insertBefore(li, list.children[i] || null);

        const wasAnswered = li.classList.contains('is-answered');
        li.classList.toggle('is-me', !!(state.user && p.uid === state.user.uid));
        li.classList.toggle('is-leader', i === 0 && (p.score || 0) > 0);
        li.classList.toggle('is-answered', !!p.answeredThisQuestion);
        // Idle during the asking window: subtle pulse so the host can
        // see who still needs to submit without it being distracting.
        li.classList.toggle('is-pending',
            !p.answeredThisQuestion && isAskingPhase && !!currentQuestionId);
        const fullDoc = state.roomPlayers.find((rp) => rp.uid === p.uid);
        const live = !fullDoc || RoomState.isPlayerLive(fullDoc, Date.now());
        li.classList.toggle('is-disconnected', !live);
        li.title = live ? '' : 'Disconnected';

        const rankEl = li.querySelector('.mini-board-rank');
        if (rankEl.textContent !== String(i + 1)) rankEl.textContent = String(i + 1);
        const nameEl = li.querySelector('.mini-board-name');
        const name = p.displayName == null ? '' : String(p.displayName);
        if (nameEl.textContent !== name) nameEl.textContent = name;
        // Surface bullseye streak >= 2 - same treatment as trivia streaks.
        const streak = Number(p.streak) || 0;
        const streakEl = li.querySelector('.mini-board-streak');
        streakEl.hidden = streak < 2;
        if (streak >= 2) {
            const chip = `🎯${streak}`;
            if (streakEl.textContent !== chip) {
                streakEl.textContent = chip;
                streakEl.title = `${streak} bullseyes in a row`;
            }
        }
        const scoreEl = li.querySelector('.mini-board-score');
        const scoreTxt = String(p.score || 0);
        if (scoreEl.textContent !== scoreTxt) scoreEl.textContent = scoreTxt;

        // One-shot cue the moment an opponent (or I) lock in, on top of the
        // check that slides in beside the name.
        if (!isNew && p.answeredThisQuestion && !wasAnswered) {
            pulseOnce(li, 'is-just-answered', 620);
        }
    });
    existing.forEach((node) => node.remove());
    renderRoundsHistoryBoard();
}

/**
 * Render every completed round in this game as a row: round number +
 * location name + a chip per player showing their score for that round.
 * Pairs visually with the cumulative live standings above it - the
 * standings answer "who is winning right now", this answers "how did
 * they get there round-by-round".
 *
 * Reads each player's `answers[]` (per-location record list every
 * guess appends to) - same source as the end-of-game recap, so the
 * numbers are guaranteed to match.
 */
// --- Canonical Globe Drop scoring for DISPLAY ----------------------------
// Round scores are computed client-side at submit time and stored per player,
// so a stale/old client and a current client can store DIFFERENT points for
// the SAME distance (an older build used a steeper decay and no base floor).
// That made a closer guess look worse than a farther one across players. To
// guarantee one formula for everyone, the standings + recap RECOMPUTE each
// player's score from the stored great-circle distance and the location's
// room-canonical multiplier, using the single current scoreGuess. Records with
// no usable distance (legacy data, or a timed-out no-guess) keep their stored
// values.
function globeDropDisplayScore(ans, loc) {
    const mult = (loc && typeof loc.multiplier === 'number' && loc.multiplier > 0) ? loc.multiplier : 1;
    const d = ans ? Number(ans.distanceKm) : NaN;
    if (ans && Number.isFinite(d)) {
        const r = GlobeDropScoring.scoreGuess({ distanceKm: d, multiplier: mult });
        return { basePoints: r.basePoints, points: r.points };
    }
    const base = ans && typeof ans.basePoints === 'number' ? Math.max(0, Math.round(ans.basePoints)) : 0;
    const points = ans && typeof ans.points === 'number' ? Math.max(0, Math.round(ans.points)) : 0;
    return { basePoints: base, points };
}

// Sum a player's Globe Drop total the SAME recomputed way, so the podium /
// standings agree with the per-round recap regardless of client version skew.
function globeDropPlayerTotal(player) {
    const answers = player && Array.isArray(player.answers) ? player.answers : [];
    const pool = (state.roomData && Array.isArray(state.roomData.questions)) ? state.roomData.questions : [];
    let total = 0;
    for (const ans of answers) {
        if (!ans) continue;
        const loc = pool.find((q) => q && q.id === ans.locationId);
        total += globeDropDisplayScore(ans, loc).points;
    }
    return total;
}

function renderRoundsHistoryBoard() {
    const board = $('#rounds-history-board');
    const scoreboard = $('#rounds-history-scoreboard');
    if (!board || !scoreboard) return;

    const room = state.roomData;
    if (!room || !Array.isArray(room.questions)) { board.hidden = true; return; }
    const idx = room.currentQuestionIndex || 0;
    if (idx < 1) { board.hidden = true; return; }

    // To prevent score-peeking, opponents' scores for the CURRENT round
    // (the one in progress) stay hidden until the local user has
    // submitted their guess for that round. We only mask the current
    // round here - prior rounds' scores are always visible because the
    // reveal phase already disclosed them.
    const curLoc = currentGlobeDropLocation();
    const me = state.user
        ? state.roomPlayers.find((p) => p.uid === state.user.uid)
        : null;
    const meSubmittedCurrent = !!(me && curLoc && me.currentAnsweredFor === curLoc.id);

    const fmt = (n) => n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');

    // One compact row per player. Each pill carries the full round breakdown:
    //   R#: base × multiplier   (and "(final)" when the multiplier > 1)
    // so no separate per-location rows are needed. base × multiplier = final
    // exactly (no hidden bonus), and the pills' finals sum to the Total.
    // Opponents' current-round cell stays masked (and is excluded from their
    // shown Total) until the local player has submitted, so the running total
    // never leaks a result.
    // Item 8: same keyed treatment as the mini-board - rows are matched by
    // uid and rewritten only when their own content changed, so an unrelated
    // snapshot (someone's lastSeen heartbeat) no longer rebuilds the board.
    const existingRows = new Map();
    Array.from(scoreboard.children).forEach((node) => {
        if (node.dataset.uid) existingRows.set(node.dataset.uid, node);
        else node.remove();
    });
    let rowIndex = 0;
    const players = state.roomPlayers.slice().sort((a, b) => (b.score || 0) - (a.score || 0));
    for (const p of players) {
        const isMe = !!(state.user && p.uid === state.user.uid);
        const answers = Array.isArray(p.answers) ? p.answers : [];
        let total = 0;
        const pills = [];
        for (let r = 0; r < idx; r++) {
            const loc = room.questions[r];
            if (!loc || !loc.id) continue;
            const isCurrentRound = curLoc && loc.id === curLoc.id;
            const maskOthers = isCurrentRound && !meSubmittedCurrent && !isMe;
            const rec = answers.find((a) => a && a.locationId === loc.id);
            const mult = (typeof loc.multiplier === 'number' && loc.multiplier > 0) ? loc.multiplier : 1;
            let valHtml;
            let zero = false;
            let masked = false;
            if (maskOthers) {
                valHtml = '🔒';
                masked = true;
            } else if (!rec) {
                valHtml = '—';
            } else if (rec.gaveUp) {
                valHtml = 'X';
                zero = true;
            } else {
                // Recompute from distance so every player's score uses the
                // same formula (see globeDropDisplayScore) instead of whatever
                // their client happened to store.
                const recomputed = globeDropDisplayScore(rec, loc);
                const base = recomputed.basePoints;
                const fin = recomputed.points;
                total += fin;
                zero = fin === 0;
                // "base×mult" always; append " (final)" only when mult > 1.
                valHtml = `${base}×${escapeHtml(fmt(mult))}`
                    + (mult !== 1 ? ` <strong>(${fin})</strong>` : '');
            }
            const cls = 'rh-score-pill'
                + (zero ? ' is-zero' : '')
                + (masked ? ' is-masked' : '');
            pills.push(
                `<span class="${cls}"><span class="rh-score-pill-r">R${r + 1}:</span> ${valHtml}</span>`
            );
        }
        const html =
            `<span class="rh-score-name">${escapeHtml(p.displayName || 'Player')}</span>`
            + `<span class="rh-score-pills">${pills.join('')}</span>`
            + `<span class="rh-score-total">Total: <strong>${total}</strong></span>`;
        let row = existingRows.get(p.uid);
        if (!row) {
            row = document.createElement('div');
            row.dataset.uid = p.uid;
        } else {
            existingRows.delete(p.uid);
        }
        const cls = 'rh-score-row' + (isMe ? ' is-me' : '');
        if (row.className !== cls) row.className = cls;
        // Signature kept as an expando, not a data- attribute: it is long,
        // and writing it to the DOM would be exactly the churn this avoids.
        if (row._rhSignature !== html) {
            row._rhSignature = html;
            row.innerHTML = html;
        }
        if (scoreboard.children[rowIndex] !== row) {
            scoreboard.insertBefore(row, scoreboard.children[rowIndex] || null);
        }
        rowIndex++;
    }
    existingRows.forEach((node) => node.remove());

    board.hidden = idx === 0;
}

async function submitGuess() {
    if (!state.user || !state.roomCode || !state.roomData) return;
    if (state.roomData.gameType !== 'globe-drop') return;
    const loc = currentGlobeDropLocation();
    if (!loc) return;
    if (!state.pendingGuess) return;
    if (state.submittedQuestionId === loc.id) return;
    // Block submission while spectating (joined mid-game on this question).
    const mePlayer = state.roomPlayers.find((p) => p.uid === state.user.uid);
    const joinedAtQIdx = mePlayer && typeof mePlayer.joinedAtQuestionIndex === 'number'
        ? mePlayer.joinedAtQuestionIndex : -1;
    const curQIdx = typeof state.roomData.currentQuestionIndex === 'number'
        ? state.roomData.currentQuestionIndex : -1;
    if (joinedAtQIdx >= 0 && curQIdx <= joinedAtQIdx) return;

    const startMs = state.roomData.questionStartedAt && state.roomData.questionStartedAt.toMillis
        ? state.roomData.questionStartedAt.toMillis() : null;
    const revealMs = state.roomData.revealStartedAt && state.roomData.revealStartedAt.toMillis
        ? state.roomData.revealStartedAt.toMillis() : null;
    if (globeDropPhase(startMs, Date.now(), revealMs, currentAskingDurationMs()) !== 'asking') return;

    const distance = GlobeDropScoring.haversineDistanceKm(
        state.pendingGuess.lat, state.pendingGuess.lng, loc.lat, loc.lng
    );
    const { points, basePoints } = GlobeDropScoring.scoreGuess({
        distanceKm: distance,
        multiplier: loc.multiplier
    });

    state.submittedQuestionId = loc.id;
    const guess = state.pendingGuess;

    // Lock the UI + render the LOCAL reveal optimistically so the player
    // sees their result instantly instead of waiting ~150ms for the
    // snapshot round-trip. We mirror the guess into our local roomPlayers
    // copy so drawGlobeDropReveal can find it.
    $('#globe-drop-submit-btn').disabled = true;
    setClearBtnVisible(false);
    const myEntry = state.roomPlayers.find((p) => p.uid === state.user.uid);
    if (myEntry) {
        myEntry.currentGuess = guess;
        myEntry.currentAnsweredFor = loc.id;
    }
    drawGlobeDropReveal(loc, myEntry || { uid: state.user.uid, currentGuess: guess, currentAnsweredFor: loc.id }, { showOthers: false });
    state.lastRevealedMapQuestion = loc.id + ':local';

    const pref = doc(db, 'triviaRooms', state.roomCode, 'players', state.user.uid);
    try {
        await runTransaction(db, async (tx) => {
            const snap = await tx.get(pref);
            if (!snap.exists()) return;
            const cur = snap.data();
            if (cur.currentAnsweredFor === loc.id) return; // already submitted

            // Bullseye streak COUNTER only (drives the 🎯 heater chip). It no
            // longer adds any points: the round score is exactly basePoints ×
            // multiplier (computed in scoreGuess), with no hidden bonus, so the
            // mid-game "Rounds so far" total and the final recap always agree.
            const prevStreak = cur.globeDropStreak || 0;
            const isBullseye = basePoints >= 98;
            const newStreak = isBullseye ? prevStreak + 1 : 0;

            // Append a per-location record so the recap can show actual
            // vs guess + distance + points for every play.
            const guessRecord = {
                locationId: loc.id,
                locationName: loc.name,
                country: loc.country,
                region: loc.region,
                actualLat: loc.lat,
                actualLng: loc.lng,
                guessLat: guess.lat,
                guessLng: guess.lng,
                distanceKm: distance,
                basePoints,
                multiplier: typeof loc.multiplier === 'number' ? loc.multiplier : 1,
                points
            };
            tx.update(pref, {
                currentGuess: guess,
                currentAnswerAt: serverTimestamp(),
                currentAnsweredFor: loc.id,
                score: (cur.score || 0) + points,
                globeDropStreak: newStreak,
                answers: [...(Array.isArray(cur.answers) ? cur.answers : []), guessRecord],
                lastSeen: serverTimestamp()
            });
        });
    } catch (err) {
        console.warn('Guess write failed:', err);
        // Item 10c: the optimistic reveal was drawn on the assumption the
        // write lands. It didn't, so put the board back exactly as it was
        // the moment before Submit: pin placed, nothing revealed, controls
        // live. Without this the player was left staring at a result for a
        // guess the room never received, with no way to retry.
        state.submittedQuestionId = null;
        cancelRevealChoreography();
        if (myEntry) {
            myEntry.currentGuess = null;
            myEntry.currentAnsweredFor = null;
        }
        state.lastRevealedMapQuestion = null;
        state.revealChoreoForQuestion = null;
        state.lastCameraTarget = null;
        // Re-arm the trivia fetch too: the retry's reveal wipes the panel as
        // a fresh one, and the in-flight fetch would have nowhere to land.
        state.triviaFetchedFor = null;
        hideWithExit($('#globe-drop-reveal'), REVEAL_EXIT_MS, () => {
            const sentimentEl = $('#globe-drop-reveal-sentiment');
            setText(sentimentEl, '');
            sentimentEl.hidden = true;
        });
        state.pendingGuess = guess;
        // clearMapOverlays first so the reveal's arc, answer pin and country
        // polygon go with it; drawMyPinOnly then re-drops just the guess.
        clearMapOverlays();
        drawMyPinOnly(guess.lat, guess.lng);
        $('#globe-drop-submit-btn').disabled = false;
        setClearBtnVisible(true);
        showToast('Guess did not save - tap Submit to try again.', {
            icon: '⚠️', key: 'globe-drop-submit-failed'
        });
    }
}

function clearMyPin() {
    state.pendingGuess = null;
    clearMapOverlays();
    $('#globe-drop-submit-btn').disabled = true;
    setClearBtnVisible(false);
}

function startGlobeDropTimerLoop() {
    if (state.timerRaf) cancelAnimationFrame(state.timerRaf);
    // Seed lastPhase/lastQId to the CURRENT phase + question so the first
    // tick doesn't trigger a redundant renderGlobeDropStage on top of the
    // one renderRoom just ran. The redundant re-render was the main culprit
    // behind the >200ms rAF handler at game start (it re-triggered globe
    // init alongside the actual stage render).
    const _initStart = state.roomData && state.roomData.questionStartedAt && state.roomData.questionStartedAt.toMillis
        ? state.roomData.questionStartedAt.toMillis() : null;
    const _initReveal = state.roomData && state.roomData.revealStartedAt && state.roomData.revealStartedAt.toMillis
        ? state.roomData.revealStartedAt.toMillis() : null;
    let lastPhase = globeDropPhase(_initStart, Date.now(), _initReveal, currentAskingDurationMs());
    let lastQId = state.roomData ? state.roomData.currentQuestionId : null;
    const tick = () => {
        if (!state.roomData || state.roomData.status !== 'playing') return;
        if (state.roomData.gameType !== 'globe-drop') return;
        // When the host has paused the room we still keep the rAF loop
        // running (so unpausing rejoins cleanly) but lock the displayed
        // time + phase to the moment-of-pause so the UI freezes.
        if (state.roomData.paused) {
            state.timerRaf = requestAnimationFrame(tick);
            return;
        }
        const startMs = state.roomData.questionStartedAt && state.roomData.questionStartedAt.toMillis
            ? state.roomData.questionStartedAt.toMillis() : null;
        const revealMs = state.roomData.revealStartedAt && state.roomData.revealStartedAt.toMillis
            ? state.roomData.revealStartedAt.toMillis() : null;
        const now = Date.now();
        const duration = currentAskingDurationMs();
        const left = globeDropTimeLeftMs(startMs, now, revealMs, duration);
        const phase = globeDropPhase(startMs, now, revealMs, duration);
        renderGlobeDropTimer(left, phase, duration);

        const currentQId = state.roomData.currentQuestionId;
        // Low-timer pings at 5 / 4 / 3 / 2 / 1 seconds. Each fires
        // exactly once per question. Skipped entirely if the local
        // player has ALREADY submitted their guess for this round -
        // they don't need the urgent countdown cue, only the players
        // still picking do.
        const meForBuzz = state.user && state.roomPlayers.find((p) => p.uid === state.user.uid);
        const meAlreadyIn = !!(meForBuzz && meForBuzz.currentAnsweredFor === currentQId);
        if (phase === 'asking' && currentQId && !meAlreadyIn) {
            const seconds = Math.ceil(left / 1000);
            const fired = (state.lastTimerPingQId === currentQId)
                ? (state.lastTimerPingThresholds || {})
                : {};
            const buzz = () => {
                try { Feedback.timerLow(); } catch (_) {}
                try {
                    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
                        navigator.vibrate(40);
                    }
                } catch (_) {}
            };
            if (seconds <= 5 && !fired.five)  { buzz(); fired.five  = true; }
            if (seconds <= 4 && !fired.four)  { buzz(); fired.four  = true; }
            if (seconds <= 3 && !fired.three) { buzz(); fired.three = true; }
            if (seconds <= 2 && !fired.two)   { buzz(); fired.two   = true; }
            if (seconds <= 1 && !fired.one)   { buzz(); fired.one   = true; }
            state.lastTimerPingThresholds = fired;
            state.lastTimerPingQId = currentQId;
        }
        // Re-render the stage when phase changes so the reveal markers
        // and "X km off" line draw without waiting for a snapshot.
        if (phase !== lastPhase || currentQId !== lastQId) {
            const transitionedToRevealForCurQ =
                (lastPhase === 'asking' && (phase === 'reveal' || phase === 'ended')
                 && currentQId === lastQId);
            lastPhase = phase;
            lastQId = currentQId;
            // Time-up audio cue: if the local player didn't submit a
            // guess for the current question before the asking window
            // closed, play the sad "time ran out" sound + vibrate.
            // Submitters get the existing guessSubmitted cue and don't
            // need this.
            if (transitionedToRevealForCurQ) {
                const me = state.user && state.roomPlayers.find((p) => p.uid === state.user.uid);
                const meSubmitted = !!(me && me.currentAnsweredFor === currentQId);
                if (!meSubmitted) {
                    try { Feedback.timerExpired(); } catch (_) {}
                }
            }
            // Heavy-handed but safe: just re-run the stage renderer.
            renderGlobeDropStage();
        }

        // Render the Ready bar (button + per-player pips) every tick
        // while we're in or past reveal. Cheap - just a few DOM
        // writes on a small element.
        if (phase === 'reveal' || phase === 'ended') renderReadyBar(phase);

        // Early reveal / ready-skip / timed advance live in
        // progressRoomClock (host-independent clock); run it here too so a
        // foreground tab reacts within a frame rather than a clock tick.
        progressRoomClock();

        state.timerRaf = requestAnimationFrame(tick);
    };
    state.timerRaf = requestAnimationFrame(tick);
}

function renderGlobeDropTimer(leftMs, phase, totalMs) {
    const total = totalMs || Config.GLOBE_DROP_LOCATION_TIME_MS;
    const ring = $('#globe-drop-timer-ring-fill');
    const timer = $('#globe-drop-timer');
    const numEl = $('#globe-drop-timer-num');

    // During reveal the same overlay flips to showing the to-next
    // countdown. Compute the reveal seconds-left from the room state
    // so we share the single visual.
    if (phase === 'reveal' || phase === 'ended') {
        const room = state.roomData || {};
        // Prefer the explicit revealStartedAt the host writes during
        // early-reveal (all players submitted). When the asking timer
        // simply runs out without an early trigger, revealStartedAt is
        // null - derive the anchor from questionStartedAt + asking
        // duration so the countdown still renders. Without this, the
        // display fell through to "—" + a flat ring after time-up.
        let revealAnchorMs = (room.revealStartedAt && room.revealStartedAt.toMillis)
            ? room.revealStartedAt.toMillis() : null;
        if (!revealAnchorMs) {
            const startMs = (room.questionStartedAt && room.questionStartedAt.toMillis)
                ? room.questionStartedAt.toMillis() : null;
            const askingMs = currentAskingDurationMs();
            if (startMs && askingMs) revealAnchorMs = startMs + askingMs;
        }
        if (revealAnchorMs) {
            const elapsed = Date.now() - revealAnchorMs;
            const leftRev = Math.max(0, Config.GLOBE_DROP_REVEAL_TIME_MS - elapsed);
            const seconds = Math.max(1, Math.ceil(leftRev / 1000));
            const fraction = Math.max(0, Math.min(1, leftRev / Config.GLOBE_DROP_REVEAL_TIME_MS));
            const offset = 176 * (1 - fraction);
            if (ring) ring.style.strokeDashoffset = String(offset);
            setText(numEl, String(seconds));
        } else {
            setText(numEl, '—');
            if (ring) ring.style.strokeDashoffset = '0';
        }
        if (timer) timer.dataset.state = 'reveal';
        return;
    }

    // Asking phase - render the question countdown into the overlay.
    const fraction = Math.max(0, Math.min(1, leftMs / total));
    const circumference = 176;
    const offset = circumference * (1 - fraction);
    if (ring) ring.style.strokeDashoffset = String(offset);
    const seconds = Math.ceil(leftMs / 1000);
    setText(numEl, String(seconds));
    // Warn/danger thresholds scale with total time so a 30s game doesn't
    // sit in danger-red the whole time, and a 5min game still flashes
    // appropriately near the end. Reveal phase short-circuits above.
    const dangerCutoff = Math.max(3000, total * 0.1);
    const warnCutoff = Math.max(10000, total * 0.25);
    if (leftMs <= dangerCutoff) {
        if (timer) timer.dataset.state = 'danger';
    } else if (leftMs <= warnCutoff) {
        if (timer) timer.dataset.state = 'warn';
    } else {
        if (timer) timer.dataset.state = 'asking';
    }
}

/* =====================================================================
 * Timer loop + host-driven question advance
 * ===================================================================== */

function startTimerLoop() {
    if (state.timerRaf) cancelAnimationFrame(state.timerRaf);
    // Track last-rendered phase + question so we can re-render the question
    // card exactly when the phase transitions (asking → reveal → ended).
    // Without this, a timer-driven transition (no Firestore write) leaves
    // the buttons stuck in their "asking, locked-in" state and the correct
    // answer never highlights.
    let lastRenderedPhase = null;
    let lastRenderedQuestionId = null;
    const tick = () => {
        if (!state.roomData || state.roomData.status !== 'playing') return;
        if (state.roomData.paused) {
            state.timerRaf = requestAnimationFrame(tick);
            return;
        }
        const startMs = state.roomData.questionStartedAt && state.roomData.questionStartedAt.toMillis
            ? state.roomData.questionStartedAt.toMillis() : null;
        const revealMs = state.roomData.revealStartedAt && state.roomData.revealStartedAt.toMillis
            ? state.roomData.revealStartedAt.toMillis() : null;
        const now = Date.now();
        const duration = currentAskingDurationMs();
        const left = RoomState.timeLeftMs(startMs, now, revealMs, duration);
        const phase = RoomState.questionPhase(startMs, now, revealMs, duration);
        renderTimer(left, phase, duration);

        const currentQId = state.roomData.currentQuestionId;
        if (phase !== lastRenderedPhase || currentQId !== lastRenderedQuestionId) {
            lastRenderedPhase = phase;
            lastRenderedQuestionId = currentQId;
            const pool = Array.isArray(state.roomData.questions) ? state.roomData.questions : [];
            const q = pool.find((cand) => cand && cand.id === currentQId);
            if (q) {
                const me = state.roomPlayers.find((p) => state.user && p.uid === state.user.uid);
                const myAnsweredIndex = (me && me.currentAnsweredFor === q.id && me.currentAnswerIndex != null)
                    ? me.currentAnswerIndex
                    : null;
                renderQuestion(q, myAnsweredIndex);
            }
        }

        // Early reveal and advance live in progressRoomClock (host-
        // independent clock, also driven by a setInterval and
        // visibilitychange so a hidden host tab no longer freezes the room).
        progressRoomClock();

        state.timerRaf = requestAnimationFrame(tick);
    };
    state.timerRaf = requestAnimationFrame(tick);
}

function renderTimer(leftMs, phase, totalMs) {
    const total = totalMs || Config.QUESTION_TIME_MS;
    const fraction = Math.max(0, Math.min(1, leftMs / total));
    const circumference = 176; // 2 * PI * 28
    const offset = circumference * (1 - fraction);
    const ring = $('#timer-ring-fill');
    if (ring) ring.style.strokeDashoffset = String(offset);

    const timer = $('#game-timer');
    const seconds = Math.ceil(leftMs / 1000);
    setText($('#game-timer-num'), phase === 'reveal' || phase === 'ended' ? '!' : String(seconds));
    // Warn/danger thresholds scale with total time so the ring colors stay
    // sensible across the configurable timer range.
    const dangerCutoff = Math.max(2000, total * 0.2);
    const warnCutoff = Math.max(5000, total * 0.45);
    if (phase === 'reveal' || phase === 'ended') {
        timer.dataset.state = 'reveal';
    } else if (leftMs <= dangerCutoff) {
        timer.dataset.state = 'danger';
    } else if (leftMs <= warnCutoff) {
        timer.dataset.state = 'warn';
    } else {
        timer.dataset.state = 'asking';
    }
}

/* =====================================================================
 * Start game / submit answer / advance / finish
 * ===================================================================== */

/**
 * Sort an array of player records into the canonical rotation order
 * (joinedAt ascending, uid lex as a tiebreaker for stability).
 * Pure helper used by start / advance / play-again.
 */
function sortPlayersForRotation(players) {
    return players.slice().sort((a, b) => {
        const ja = (a.joinedAt && a.joinedAt.toMillis) ? a.joinedAt.toMillis() : 0;
        const jb = (b.joinedAt && b.joinedAt.toMillis) ? b.joinedAt.toMillis() : 0;
        if (ja !== jb) return ja - jb;
        return String(a.uid).localeCompare(String(b.uid));
    });
}

async function startGame() {
    if (!state.roomCode || !state.roomData) return;
    if (state.roomData.status !== 'lobby') return;
    // A second click 40 ms later used to land on the decider's category grid
    // rendered under the same point (audit D12); lock the button now and let
    // renderPickingStage's settle window absorb the stray click. Anything
    // that fails below hands the button back, otherwise a failed fetch would
    // leave the host with a permanently dead Start button.
    const startBtn = $('#start-game-btn');
    if (startBtn) startBtn.disabled = true;
    try {
        if (state.roomData.gameType === 'globe-drop') {
            // GlobeDrop plays locations sequentially - no picking stage, no decider.
            const pool = Array.isArray(state.roomData.questions) ? state.roomData.questions : [];
            const firstLoc = pool[0];
            if (!firstLoc) throw new Error('no locations in the room pool');
            await updateDoc(doc(db, 'triviaRooms', state.roomCode), {
                status: 'playing',
                currentQuestionIndex: 0,
                currentQuestionId: firstLoc.id,
                questionStartedAt: serverTimestamp(),
                revealStartedAt: null,
                playedQuestionIds: []
            });
            return;
        }

        // Trivia mode - picking stage with decider rotation.
        // Fetch the player list FRESH from Firestore - state.roomPlayers can
        // be stale if the host clicks Start before late-joiner snapshots have
        // propagated, which would silently shrink playerOrder to just the host
        // and make every question rotate back to them.
        const playersSnap = await getDocs(collection(db, 'triviaRooms', state.roomCode, 'players'));
        const playerOrder = sortPlayersForRotation(playersSnap.docs.map((d) => d.data()))
            .map((p) => p.uid)
            .filter((uid) => typeof uid === 'string' && uid.length > 0);
        const deciderUid = RoomState.pickDecider(playerOrder, 0);

        await updateDoc(doc(db, 'triviaRooms', state.roomCode), {
            status: 'picking',
            currentQuestionIndex: 0,
            currentQuestionId: null,
            selectedCategory: null,
            questionStartedAt: null,
            revealStartedAt: null,
            pickingStartedAt: serverTimestamp(),
            playedQuestionIds: [],
            playerOrder,
            deciderUid
        });
    } catch (err) {
        console.warn('startGame failed:', err);
        if (startBtn) startBtn.disabled = false;
        showToast('Could not start the game - try again.', { icon: '⚠️', key: 'start-failed' });
    }
}

async function submitAnswer(choiceIndex, question) {
    if (!state.user || !state.roomCode) return;
    if (state.submittedQuestionId === question.id) return; // double-click guard

    // B6: same spectator gate submitGuess already had. A player who joins
    // mid-question spectates it; without this they could answer (and score on)
    // the very question the spectator banner says they are sitting out.
    const mePlayer = state.roomPlayers.find((p) => p.uid === state.user.uid);
    const joinedAtQIdx = mePlayer && typeof mePlayer.joinedAtQuestionIndex === 'number'
        ? mePlayer.joinedAtQuestionIndex : -1;
    const curQIdx = typeof state.roomData.currentQuestionIndex === 'number'
        ? state.roomData.currentQuestionIndex : -1;
    if (joinedAtQIdx >= 0 && curQIdx <= joinedAtQIdx) return;

    const startMs = state.roomData.questionStartedAt && state.roomData.questionStartedAt.toMillis
        ? state.roomData.questionStartedAt.toMillis() : Date.now();
    const revealMs = state.roomData.revealStartedAt && state.roomData.revealStartedAt.toMillis
        ? state.roomData.revealStartedAt.toMillis() : null;
    const now = Date.now();
    const duration = currentAskingDurationMs();
    const phase = RoomState.questionPhase(startMs, now, revealMs, duration);
    if (phase !== 'asking') return; // window closed

    const left = RoomState.timeLeftMs(startMs, now, revealMs, duration);
    const me = state.roomPlayers.find((p) => p.uid === state.user.uid) || {};
    const correct = choiceIndex === question.correctIndex;
    const { pointsEarned, streakAfter } = Scoring.scoreAnswer({
        correct,
        timeLeftMs: left,
        // Scale the speed-bonus normalization to the actual room duration
        // so a 30s game and a 60s game both reward "answered fast" equally.
        totalMs: duration,
        streakBefore: me.streak || 0
    });

    state.submittedQuestionId = question.id;

    // Update locally so the UI shows the pick immediately
    const optimistic = state.roomPlayers.find((p) => p.uid === state.user.uid);
    if (optimistic) optimistic.currentAnswerIndex = choiceIndex;
    renderQuestion(question, choiceIndex);

    state.currentAnswers.push({
        questionId: question.id,
        category: question.category || 'general',
        correct,
        timeLeftMs: left,
        totalMs: duration,
        points: pointsEarned
    });

    const pref = doc(db, 'triviaRooms', state.roomCode, 'players', state.user.uid);
    try {
        await runTransaction(db, async (tx) => {
            const snap = await tx.get(pref);
            if (!snap.exists()) return;
            const cur = snap.data();
            // Idempotent: if we already wrote this question's answer, skip.
            if (cur.currentAnswerIndex != null && cur.currentAnsweredFor === question.id) return;
            // Append a per-question record to player.answers so the
            // end-of-game recap can show what everyone picked, who got it
            // right, and how fast.
            const answerRecord = {
                questionId: question.id,
                question: String(question.question || '').slice(0, 200),
                category: question.category || 'general',
                answerIndex: choiceIndex,
                answerText: String(question.choices[choiceIndex] || '').slice(0, 80),
                correctIndex: question.correctIndex,
                correctText: String(question.choices[question.correctIndex] || '').slice(0, 80),
                correct,
                points: pointsEarned,
                timeLeftMs: left,
                totalMs: duration
            };
            tx.update(pref, {
                currentAnswerIndex: choiceIndex,
                currentAnswerAt: serverTimestamp(),
                currentAnsweredFor: question.id,
                score: (cur.score || 0) + pointsEarned,
                streak: streakAfter,
                answers: [...(Array.isArray(cur.answers) ? cur.answers : []), answerRecord],
                lastSeen: serverTimestamp()
            });
        });
    } catch (err) {
        console.warn('Answer write failed:', err);
        state.submittedQuestionId = null;
        if (optimistic) optimistic.currentAnswerIndex = null;
        state.currentAnswers = state.currentAnswers.filter((a) => a.questionId !== question.id);
        // The optimistic "Locked in" render lied (audit D9): tell the player
        // and, while the window is still open, hand the buttons back.
        const stillOpen = state.roomData
            && state.roomData.currentQuestionId === question.id
            && RoomState.questionPhase(startMs, Date.now(), revealMs, duration) === 'asking';
        if (stillOpen) {
            renderQuestion(question, null);
            showToast('Your answer did not save - pick again.', { icon: '⚠️', key: 'answer-failed' });
        } else {
            const status = $('#answer-status');
            if (status) setText(status, 'Your answer was not saved (connection lost).');
            showToast('Connection lost - that answer did not count.', { icon: '⚠️', key: 'answer-failed' });
        }
    }
}

/** Guard key for the clock writes: round + index + question id. */
function clockKey(room) {
    return `${room.round || 1}:${room.currentQuestionIndex || 0}:${room.currentQuestionId || ''}`;
}

/** Ordered { uid, displayName, score, streak } snapshot of the current standings. */
function currentFinalRanking() {
    const isGlobe = !!(state.roomData && state.roomData.gameType === 'globe-drop');
    return RoomState.finalRankingSnapshot(state.roomPlayers, isGlobe ? globeDropPlayerTotal : null);
}

/**
 * Host-independent game clock (audit D3). Runs from the rAF render loops,
 * from a 500 ms setInterval and from visibilitychange (startPresenceAndClock).
 * Decides, from the room doc + server-anchored timestamps, whether this
 * client should write the early reveal, the Ready-skip advance or the timed
 * advance/finish. The host does all three; any other member performs the
 * timed advance once the window has elapsed plus ADVANCE_FALLBACK_SLACK_MS
 * (firestore.rules re-checks the deadline on the server clock). Every write
 * is keyed by clockKey so it fires once per question per client, and the
 * advance itself is a transaction with an idempotent precondition, so two
 * clients racing can never double-advance.
 */
function progressRoomClock() {
    const room = state.roomData;
    if (!room || !state.user || !state.roomCode) return;
    // The picking stage has its own deadline: without one, a decider who
    // locked their phone or closed the tab stalled the room for everyone
    // with no way out (the same failure mode the playing stage had).
    if (room.status === 'picking') { maybeAutoPickCategory(room); return; }
    if (room.status !== 'playing' || room.paused) return;
    const currentQId = room.currentQuestionId;
    if (!currentQId) return;
    const isGlobe = room.gameType === 'globe-drop';
    const startMs = room.questionStartedAt && room.questionStartedAt.toMillis
        ? room.questionStartedAt.toMillis() : null;
    const revealMs = room.revealStartedAt && room.revealStartedAt.toMillis
        ? room.revealStartedAt.toMillis() : null;
    const now = Date.now();
    const duration = currentAskingDurationMs();
    const phase = isGlobe
        ? globeDropPhase(startMs, now, revealMs, duration)
        : RoomState.questionPhase(startMs, now, revealMs, duration);
    const key = clockKey(room);
    const isHost = room.hostUid === state.user.uid;
    const live = livePlayers();

    if (isHost) sweepStalePlayers();

    // Early reveal once every LIVE player has answered (ghosts past the
    // grace no longer hold the round open, audit D4).
    if (isHost && phase === 'asking' && !revealMs
        && state.earlyRevealForQuestion !== key
        && live.length > 0
        && live.every((p) => p.currentAnsweredFor === currentQId)) {
        state.earlyRevealForQuestion = key;
        updateDoc(doc(db, 'triviaRooms', state.roomCode), {
            revealStartedAt: serverTimestamp()
        }).catch((err) => {
            console.warn('early reveal write failed:', err);
            state.earlyRevealForQuestion = null;
        });
    }

    const fireAdvance = () => {
        state.earlyAdvanceForQuestion = key;
        advanceQuestionOrFinish().catch((err) => {
            console.warn('advance failed:', err);
            // Retry about once a second instead of every frame.
            setTimeout(() => {
                if (state.earlyAdvanceForQuestion === key) state.earlyAdvanceForQuestion = null;
            }, 1000);
        });
    };

    // Globe Drop Ready-to-skip: every live player voted Ready during reveal.
    if (isGlobe && isHost && phase === 'reveal'
        && state.earlyAdvanceForQuestion !== key
        && live.length > 0
        && live.every((p) => p.readyAfterQId === currentQId)) {
        fireAdvance();
        return;
    }

    // Window over: the host moves on at once; any other member after the
    // slack, so a hidden or gone host cannot stall the room.
    if (phase === 'ended' && state.earlyAdvanceForQuestion !== key) {
        const revealWindow = isGlobe ? Config.GLOBE_DROP_REVEAL_TIME_MS : Config.REVEAL_TIME_MS;
        const overAt = revealMs ? revealMs + revealWindow : (startMs || 0) + duration + revealWindow;
        if (isHost || now >= overAt + Config.ADVANCE_FALLBACK_SLACK_MS) fireAdvance();
    }
}

/**
 * Picking-stage deadline. Once `pickingStartedAt + PICK_DEADLINE_MS` has
 * passed, ANY member picks for the room so a silent decider cannot stall it.
 * The choice is deterministic (RoomState.autoPickQuestion seeds a PRNG from
 * the room code, round and index), so every client would pick the SAME
 * question and the race is harmless; the transaction's precondition means
 * only the first write lands, and a decider who picks before the deadline
 * always wins because the room leaves 'picking' the moment they do.
 */
async function maybeAutoPickCategory(room) {
    if (!state.roomCode || !state.user) return;
    if (room.currentQuestionId) return; // already picked
    const startedAt = room.pickingStartedAt && room.pickingStartedAt.toMillis
        ? room.pickingStartedAt.toMillis() : null;
    // Legacy rooms (created before the deadline existed) carry no stamp;
    // they keep the old behaviour rather than being auto-advanced blind.
    if (!startedAt) return;
    if (Date.now() < startedAt + Config.PICK_DEADLINE_MS) return;
    const idx = room.currentQuestionIndex || 0;
    const key = `pick:${room.round || 1}:${idx}`;
    if (state.autoPickForQuestion === key) return;
    state.autoPickForQuestion = key;

    const pool = Array.isArray(room.questions) ? room.questions : [];
    const played = Array.isArray(room.playedQuestionIds) ? room.playedQuestionIds : [];
    const picked = RoomState.autoPickQuestion(pool, played, {
        code: state.roomCode, round: room.round || 1, index: idx
    });
    const roomRef = doc(db, 'triviaRooms', state.roomCode);
    try {
        await runTransaction(db, async (tx) => {
            const snap = await tx.get(roomRef);
            if (!snap.exists()) return;
            const cur = snap.data() || {};
            if (cur.status !== 'picking') return;              // someone picked already
            if ((cur.currentQuestionIndex || 0) !== idx) return;
            if (cur.currentQuestionId) return;
            if (!picked) {
                tx.update(roomRef, {
                    status: 'finished',
                    finishedAt: serverTimestamp(),
                    finalRanking: currentFinalRanking()
                });
                return;
            }
            tx.update(roomRef, {
                status: 'playing',
                currentQuestionId: picked.id,
                selectedCategory: picked.category || 'general',
                questionStartedAt: serverTimestamp(),
                revealStartedAt: null
            });
        });
    } catch (err) {
        console.warn('auto-pick failed:', err);
        setTimeout(() => {
            if (state.autoPickForQuestion === key) state.autoPickForQuestion = null;
        }, 1000);
    }
}

/**
 * Move the room past the current question: next location (Globe Drop),
 * the next picking stage (Trivia) or the finished state. A transaction
 * with an idempotent precondition (still playing, same question id and
 * index) so the host and a member's fallback can race without a
 * double-advance; a no-op when someone else already moved the room.
 */
async function advanceQuestionOrFinish() {
    if (!state.roomCode || !state.roomData) return;
    const expectedQId = state.roomData.currentQuestionId;
    const expectedIdx = state.roomData.currentQuestionIndex || 0;
    const roomRef = doc(db, 'triviaRooms', state.roomCode);
    // Ranking and rotation come from the player docs we hold now; they are
    // not part of the transaction (different documents), which is fine: the
    // asking window is closed, so scores are final.
    const finalRanking = currentFinalRanking();
    const currentPlayers = sortPlayersForRotation(livePlayers())
        .map((p) => p.uid)
        .filter((uid) => typeof uid === 'string' && uid.length > 0);

    await runTransaction(db, async (tx) => {
        const snap = await tx.get(roomRef);
        if (!snap.exists()) return;
        const room = snap.data() || {};
        if (room.status !== 'playing') return;
        if (room.currentQuestionId !== expectedQId) return;
        if ((room.currentQuestionIndex || 0) !== expectedIdx) return;

        const idx = room.currentQuestionIndex || 0;
        const total = room.totalQuestions;
        const nextIdx = idx + 1;
        const playedIds = Array.isArray(room.playedQuestionIds) ? room.playedQuestionIds.slice() : [];
        if (expectedQId && !playedIds.includes(expectedQId)) playedIds.push(expectedQId);

        // No per-player reset write here. The rules (correctly) forbid the
        // host from writing other players' docs, so resetting their
        // per-question fields would 403. `currentAnsweredFor` (written by
        // the player themselves on submit) is the per-question marker.

        if (nextIdx >= total) {
            tx.update(roomRef, {
                status: 'finished',
                finishedAt: serverTimestamp(),
                playedQuestionIds: playedIds,
                finalRanking
            });
            return;
        }

        if (room.gameType === 'globe-drop') {
            const pool = Array.isArray(room.questions) ? room.questions : [];
            const nextLoc = pool[nextIdx];
            if (!nextLoc) return;
            tx.update(roomRef, {
                status: 'playing',
                currentQuestionIndex: nextIdx,
                currentQuestionId: nextLoc.id,
                questionStartedAt: serverTimestamp(),
                revealStartedAt: null,
                playedQuestionIds: playedIds
            });
            return;
        }

        // Trivia: rotate the decider over the CURRENT live players (late
        // joiners enter the rotation, ghosts are skipped) and re-enter the
        // picking stage.
        const nextDecider = RoomState.pickDecider(currentPlayers, nextIdx);
        tx.update(roomRef, {
            status: 'picking',
            currentQuestionIndex: nextIdx,
            currentQuestionId: null,
            selectedCategory: null,
            questionStartedAt: null,
            revealStartedAt: null,
            pickingStartedAt: serverTimestamp(),
            playerOrder: currentPlayers,
            deciderUid: nextDecider,
            playedQuestionIds: playedIds
        });
    });
}

/**
 * Decider's category choice → write the picked question + start the timer.
 * Anyone signed in can update the room doc (per the rules), but we
 * gate this client-side: only the current decider (or, as a fallback,
 * the host if the decider has dropped) gets the UI to call this.
 * @param {string} category - category id or '__any__'
 */
async function pickCategoryAndStart(category) {
    if (!state.roomCode || !state.roomData) return;
    if (state.roomData.status !== 'picking') return;
    // The grid renders where the Start button was; a double-click's second
    // press arrives ~40 ms later (audit D12). Ignore picks inside a short
    // settle window after the grid appeared.
    if (Date.now() - (state.pickingShownAt || 0) < 400) return;
    const pool = Array.isArray(state.roomData.questions) ? state.roomData.questions : [];
    const playedIds = Array.isArray(state.roomData.playedQuestionIds)
        ? state.roomData.playedQuestionIds
        : [];
    const picked = RoomState.pickQuestionFromPool(pool, playedIds, category);
    if (!picked) {
        console.warn('Question pool exhausted; advancing to end.');
        await updateDoc(doc(db, 'triviaRooms', state.roomCode), {
            status: 'finished',
            finishedAt: serverTimestamp(),
            finalRanking: currentFinalRanking()
        });
        return;
    }
    await updateDoc(doc(db, 'triviaRooms', state.roomCode), {
        status: 'playing',
        currentQuestionId: picked.id,
        selectedCategory: category === '__any__' ? null : (picked.category || 'general'),
        questionStartedAt: serverTimestamp(),
        revealStartedAt: null
    });
}

/* =====================================================================
 * End-of-game render + XP/wins write-back
 * ===================================================================== */

let endStageWrittenForRoom = null;

/**
 * Players to render the end screen from: the snapshot taken when the game
 * finished (kept across leavers, see renderRoom) or, before the first
 * finished snapshot, the live list.
 */
function endStagePlayers() {
    return (state.finalPlayers && state.finalPlayers.length) ? state.finalPlayers : state.roomPlayers;
}

async function renderEndStage(isHost) {
    hide($('#stage-lobby'));
    hide($('#stage-game'));
    hide($('#stage-globe-drop'));
    hide($('#stage-picking'));
    show($('#stage-end'));

    // Guest-only sign-up nudge. Only shown to anonymous users - for
    // registered users this panel stays hidden so the recap layout
    // doesn't pick up dead space.
    const guestCta = $('#end-guest-cta');
    if (guestCta) guestCta.hidden = !isGuest();

    // Deep-link: rewrite the URL to ?postMatch=<code> so refresh + share
    // both land back on this recap. Cleared by setView('play') when the
    // user navigates away from the end stage.
    if (state.roomCode) {
        state.postMatchCode = state.roomCode;
        syncUrlToState();
    }

    if (state.timerRaf) { cancelAnimationFrame(state.timerRaf); state.timerRaf = null; }

    // Globe Drop: rank by the recomputed-from-distance total so the podium /
    // board / winner match the per-round recap and never inherit a stale
    // client's score (see globeDropDisplayScore). Trivia keeps p.score.
    const isGlobeDropEnd = state.roomData && state.roomData.gameType === 'globe-drop';
    // Prefer the ranking the finishing client stamped on the room doc
    // (audit D5: a leaver's doc deletion used to rewrite the winner); fall
    // back to the local finished-snapshot, then the live list.
    const docRanking = state.roomData && Array.isArray(state.roomData.finalRanking)
        ? state.roomData.finalRanking.filter((p) => p && typeof p.uid === 'string') : [];
    const endPlayers = endStagePlayers();
    const ranked = docRanking.length
        ? Scoring.rankPlayers(docRanking.map((p) => ({
            uid: p.uid, displayName: p.displayName, score: p.score || 0, streak: p.streak || 0
        })))
        : Scoring.rankPlayers(endPlayers.map((p) => ({
            uid: p.uid,
            displayName: p.displayName,
            score: isGlobeDropEnd ? globeDropPlayerTotal(p) : (p.score || 0),
            streak: p.streak || 0
        })));

    // Podium - skipped for single-player runs (solo and daily: no opponents
    // to rank against, so the "Final score" hero is the honest framing).
    const podium = $('#podium');
    const endPlayMode = (state.roomData && state.roomData.playMode) || 'multi';
    const isSoloMode = endPlayMode === 'solo' || endPlayMode === 'daily';
    podium.hidden = isSoloMode;
    podium.innerHTML = '';
    const soloHero = $('#solo-hero');
    if (isSoloMode) {
        // Hide the end-board too - for solo there's only one row and the
        // final score is already in the hero block.
        const boardWrap = document.querySelector('.end-board-wrap');
        if (boardWrap) boardWrap.hidden = true;
        // Populate the solo hero with run stats sourced from the player's
        // answers[] array.
        const meEntry = state.user
            ? endPlayers.find((p) => p.uid === state.user.uid)
            : null;
        const answers = (meEntry && Array.isArray(meEntry.answers)) ? meEntry.answers : [];
        // Recompute final + best-round from distance for Globe Drop so the
        // solo hero matches the recap; Trivia keeps the stored values.
        const pool = (state.roomData && Array.isArray(state.roomData.questions)) ? state.roomData.questions : [];
        const finalScore = isGlobeDropEnd
            ? globeDropPlayerTotal(meEntry)
            : (meEntry ? (meEntry.score || 0) : 0);
        const bestRound = answers.reduce((m, a) => {
            if (!a) return m;
            const pts = isGlobeDropEnd
                ? globeDropDisplayScore(a, pool.find((q) => q && q.id === a.locationId)).points
                : (typeof a.points === 'number' ? a.points : 0);
            return Math.max(m, pts);
        }, 0);
        const distances = answers.map((a) => a && typeof a.distanceKm === 'number' ? a.distanceKm : null).filter((d) => d != null);
        const avgDist = distances.length
            ? Math.round(distances.reduce((s, d) => s + d, 0) / distances.length)
            : null;
        if (soloHero) {
            soloHero.hidden = false;
            setText($('#solo-hero-score'), String(finalScore));
            setText($('#solo-hero-best'), String(bestRound));
            setText($('#solo-hero-avg-dist'), avgDist != null ? `${avgDist} km` : '—');
            setText($('#solo-hero-locations'), String(answers.length));
        }
    } else {
        const boardWrap = document.querySelector('.end-board-wrap');
        if (boardWrap) boardWrap.hidden = false;
        if (soloHero) soloHero.hidden = true;
    }
    const medals = ['🥇', '🥈', '🥉'];
    const slotOrder = [1, 0, 2]; // visual: 2nd, 1st, 3rd
    if (!isSoloMode) {
        podium.setAttribute('aria-label', `Top ${Math.min(ranked.length, 3)}`);
        for (const orderIdx of slotOrder) {
            if (!ranked[orderIdx]) continue;
            const p = ranked[orderIdx];
            const slot = document.createElement('div');
            slot.className = `podium-slot podium-slot-${orderIdx+1}`;
            slot.innerHTML =
                `<span class="podium-medal">${medals[orderIdx]}</span>` +
                `<span class="podium-name" title="${escapeHtml(p.displayName)}">${escapeHtml(p.displayName)}</span>` +
                `<span class="podium-score">${p.score}</span>` +
                `<div class="podium-block">${orderIdx+1}</div>`;
            podium.appendChild(slot);
        }
    }

    // Full board
    const streakHeader = $('#end-board-streak-header');
    if (streakHeader) {
        const isGlobeDrop = state.roomData && state.roomData.gameType === 'globe-drop';
        streakHeader.textContent = isGlobeDrop ? 'Bullseye streak' : 'Streak';
    }
    const body = $('#end-board-body');
    body.innerHTML = '';
    ranked.forEach((p, i) => {
        const tr = document.createElement('tr');
        if (state.user && p.uid === state.user.uid) tr.classList.add('is-me');
        tr.innerHTML =
            `<td>${i+1}</td>` +
            `<td>${escapeHtml(p.displayName)}</td>` +
            `<td class="col-score">${p.score}</td>` +
            `<td class="col-streak">${p.streak || 0}</td>`;
        body.appendChild(tr);
    });

    // Summary line. Solo runs have no opponent so we don't frame it as
    // a win/loss; we just celebrate the final score.
    const winner = ranked[0];
    const me = ranked.find((p) => state.user && p.uid === state.user.uid);
    const playMode = endPlayMode;
    if (isSoloMode && me) {
        setText($('#end-summary'), `Final score: ${me.score}`);
    } else if (winner && me && winner.uid === me.uid) {
        setText($('#end-summary'), '🎉 You won! Nice work.');
    } else if (winner) {
        setText($('#end-summary'), `${winner.displayName} took it home with ${winner.score} points.`);
    } else {
        setText($('#end-summary'), 'No scores recorded.');
    }

    // Round type label (Globe Drop only) - shows which pack this game used
    // (World capitals, Countries, Major cities, ...). Hidden for Trivia,
    // which has no round type.
    const roundTypeEl = $('#end-round-type');
    if (roundTypeEl) {
        const isGlobeDrop = state.roomData && state.roomData.gameType === 'globe-drop';
        if (isGlobeDrop) {
            const rt = (state.roomData && state.roomData.roundType) || 'capitals';
            const meta = GlobeDropLocations.ROUND_TYPES[rt] || GlobeDropLocations.ROUND_TYPES.capitals;
            roundTypeEl.innerHTML = `<span aria-hidden="true">🌍</span> ${escapeHtml(meta.label || rt)}`;
            roundTypeEl.hidden = false;
        } else {
            roundTypeEl.hidden = true;
        }
    }

    // Share result button - visible on the end stage for all game types.
    const shareBtn = $('#end-share-btn');
    if (shareBtn) shareBtn.hidden = false;

    // Full per-question/per-location recap (free for everyone)
    renderEndRecap();

    // Detailed per-question / per-location stats (free for everyone)
    renderDetailedStats();
    show($('#detailed-stats'));

    // In-room session H2H (one panel showing cumulative wins per player
    // since this room was created). Visible after >=1 match in a multi
    // room with 2+ players.
    renderRoomSessionH2H();

    // Rematch controls. Only the host can PROPOSE a rematch, and only
    // when at least two players are still in the room. Anyone else sees
    // the accept/decline strip once a proposal is active.
    renderRematchUI(isHost);

    // Write score / wins / games to profile (once per game). The
    // Firestore field is still named `xp` for backward-compat with
    // existing user docs - UI labels are "score" everywhere now.
    // IDEMPOTENCY. `endKey` names this game: the room plus the round, so a
    // rematch is a new game and a reload is not.
    //
    // `endStageWrittenForRoom` is only a cheap re-entrancy guard for THIS
    // page: it stops a second snapshot callback racing the first while the
    // write is in flight. It cannot survive a reload, and the end stage is
    // exactly where reloads happen (a pull-to-refresh on a phone, or reopening
    // the `?postMatch=` link the app writes into the URL itself). Every reload
    // therefore counted the same game again: profile, public leaderboard row,
    // the room's session H2H and the lifetime pair all incremented, so one
    // game read as two, then three. The durable guard is `lastCountedGame`,
    // persisted next to each counter and checked inside the same transaction
    // that increments it.
    const endKey = `${state.roomCode}:${(state.roomData && state.roomData.round) || 1}`;
    if (state.user && me && endStageWrittenForRoom !== endKey) {
        endStageWrittenForRoom = endKey;
        await writeEndOfGameStats(me, winner && winner.uid === me.uid, ranked.length, endKey);
    }
}

async function writeEndOfGameStats(me, didWin, playerCount, endKey) {
    if (!state.user) return;
    // Guests have no persistent profile or leaderboard slot - the end-
    // of-game writes would all fail at the rules layer, and we don't
    // want anon uids polluting the global boards anyway.
    if (isGuest()) return;
    const playMode = (state.roomData && state.roomData.playMode) || 'multi';
    const isSolo = playMode === 'solo';
    try {
        const myEntry = endStagePlayers().find((p) => p.uid === state.user.uid);
        // One pure computation feeds BOTH the profile and the leaderboard
        // row (audit D8: the leaderboard used to be written from a locally
        // mutated profile copy that the live profile listener had already
        // advanced, so it over-counted; and a one-player daily run counted
        // as a win).
        const delta = RoomState.endOfGameStatsDelta({
            playMode,
            didWin,
            playerCount: typeof playerCount === 'number' ? playerCount : endStagePlayers().length,
            score: me.score || 0,
            answers: myEntry && Array.isArray(myEntry.answers) ? myEntry.answers : []
        });
        const userRef = doc(db, 'users', state.user.uid);
        const lbRef = doc(db, 'triviaLeaderboard', state.user.uid);
        // Firestore key stays `xp` for backward-compat with existing docs;
        // UI labels say "score" everywhere.
        // Returns false when this game was already counted, so the writes that
        // follow are skipped too rather than each needing its own reload test.
        const applied = await runTransaction(db, async (tx) => {
            const snap = await tx.get(userRef);
            const tp = (snap.exists() && snap.data().triviaProfile) || {};
            // The durable guard. Read INSIDE the transaction so two tabs, two
            // devices, or a reload racing the original write cannot both pass
            // it: Firestore re-runs the transaction on contention and the
            // loser sees the winner's marker.
            if (endKey && tp.lastCountedGame === endKey) return false;
            const next = {
                xp: (tp.xp || 0) + delta.scoreDelta,
                gamesPlayed: (tp.gamesPlayed || 0) + delta.gamesDelta,
                wins: (tp.wins || 0) + delta.winsDelta,
                lifetimeBullseyes: (tp.lifetimeBullseyes || 0) + delta.bullseyes,
                bestRoundScore: Math.max(tp.bestRoundScore || 0, delta.bestRound)
            };
            tx.set(userRef, {
                triviaProfile: Object.assign({}, next, {
                    lastPlayedAt: serverTimestamp(),
                    // Stamped in the SAME write as the counters it guards, so
                    // the marker cannot land without them or they without it.
                    lastCountedGame: endKey || null,
                }),
            }, { merge: true });
            if (!isSolo) {
                // Denormalized leaderboard write - multiplayer + daily only,
                // from the SAME numbers the profile just received.
                tx.set(lbRef, {
                    uid: state.user.uid,
                    displayName: me.displayName,
                    xp: next.xp,
                    gamesPlayed: next.gamesPlayed,
                    wins: next.wins,
                    lifetimeBullseyes: next.lifetimeBullseyes,
                    bestRoundScore: next.bestRoundScore,
                    lastPlayedAt: serverTimestamp()
                }, { merge: true });
            }
            return true;
        });

        // Already counted: a reload of the recap, or the `?postMatch=` link
        // opened again. Nothing below may run either.
        if (!applied) return;

        // Daily-challenge leaderboard write. Only the player's BEST score
        // for the day stays - we read the existing doc and only overwrite
        // when the new score is higher. No-op for solo / multi.
        await maybeWriteDailyLeaderboard(me);

        // Pairwise head-to-head - multiplayer only, lower-uid side writes.
        await maybeWriteH2HPairs(endKey);
    } catch (err) {
        console.warn('End-of-game profile write failed:', err);
    }
}

/**
 * Build a plain-text share blurb for a finished Arena game.
 * Pure function - no DOM access, safe to call from tests.
 *
 * @param {string} gameTypeLabel - Human-readable game type, e.g. 'Globe Drop'.
 * @param {Array<{displayName:string,score:number}>} rankedPlayers - Already ranked, highest first.
 * @param {string} dateStr - Formatted date string, e.g. 'Jun 5, 2026'.
 * @returns {string}
 */
function buildResultShareText(gameTypeLabel, rankedPlayers, dateStr) {
    const medals = ['🥇', '🥈', '🥉'];
    const header = `🏆 Arena: ${gameTypeLabel}\n${dateStr}`;
    const rows = rankedPlayers.map((p, i) => {
        const prefix = medals[i] || `${i + 1}.`;
        const name = p.displayName || 'Player';
        return `${prefix} ${name}: ${p.score}`;
    }).join('\n');
    return `${header}\n\n${rows}\n\nshevato.com/apps/arena`;
}

/**
 * Copy a plain-text game-result summary to the clipboard.
 * On success, briefly swaps the button label to confirm the copy.
 */
async function shareResultCard() {
    if (!state.roomData || !state.roomPlayers) return;

    const isGlobeDropShare = state.roomData.gameType === 'globe-drop';
    const gameTypeLabel = isGlobeDropShare ? 'Globe Drop' : 'Trivia';
    const dateStr = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const ranked = Scoring.rankPlayers(endStagePlayers().map((p) => ({
        displayName: p.displayName,
        score: isGlobeDropShare ? globeDropPlayerTotal(p) : (p.score || 0),
        streak: p.streak || 0,
        uid: p.uid
    })));
    const text = buildResultShareText(gameTypeLabel, ranked, dateStr);

    const btn = $('#end-share-btn');
    const originalLabel = btn ? btn.innerHTML : null;

    const confirmCopy = () => {
        if (!btn) return;
        btn.innerHTML = '✓ Copied';
        setTimeout(() => { btn.innerHTML = originalLabel; }, 1200);
    };

    // Prefer the async Clipboard API; fall back to execCommand for non-secure contexts.
    if (navigator.clipboard && navigator.clipboard.writeText) {
        try {
            await navigator.clipboard.writeText(text);
            confirmCopy();
            return;
        } catch (_) { /* fall through to execCommand */ }
    }

    try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        if (ok) {
            confirmCopy();
        } else {
            console.warn('shareResultCard: execCommand copy returned false');
        }
    } catch (err) {
        console.warn('shareResultCard failed:', err);
    }
}

/**
 * H2H pair-key built from two uids, alphabetically sorted so both
 * directions resolve to the same doc.
 */
function h2hPairKey(uidA, uidB) {
    if (!uidA || !uidB || uidA === uidB) return null;
    return [uidA, uidB].sort().join('__');
}

/**
 * For each pair of players in the current room, increment the pair's
 * H2H record based on this game's final scores. Runs only on the
 * host's client (others would race for the same doc) and only for
 * multiplayer games (solo/daily can't have head-to-head records).
 *
 * Each pair doc carries the displayed names so the H2H view can
 * render without re-fetching the leaderboard.
 */
async function maybeWriteH2HPairs(endKey) {
    if (!state.user || !state.roomData || !state.roomCode) return;
    // Guest hosts: still update sessionMatchCount on the room doc (it's
    // ephemeral and helps the in-room session H2H render), but skip
    // the lifetime triviaH2H pair writes - rules forbid anon writes
    // there, and anon uids would create orphaned pair rows anyway.
    const playMode = state.roomData.playMode || 'multi';
    if (playMode !== 'multi') return;
    const players = endStagePlayers().slice();
    if (players.length < 2) return;

    // In-room session H2H - host writes the room-level counter so
    // rematches accumulate. Other players don't try (rules permit it
    // since /triviaRooms is open-write to anyone signed in, but only
    // one writer avoids the increment race).
    if (state.roomData.hostUid === state.user.uid) {
        const sortedByScore = players.slice().sort((a, b) => (b.score || 0) - (a.score || 0));
        const topScore = sortedByScore[0] ? (sortedByScore[0].score || 0) : 0;
        const winners = sortedByScore.filter((p) => (p.score || 0) === topScore);
        try {
            // In a TRANSACTION, and guarded by the same game key. This was a
            // read-modify-write off `state.roomData`, so a host who reloaded
            // the recap incremented the room's match count again, and the
            // in-room session H2H panel showed a rematch that never happened.
            // The counters are read from the doc rather than from local state
            // for the same reason.
            const roomRef = doc(db, 'triviaRooms', state.roomCode);
            await runTransaction(db, async (tx) => {
                const snap = await tx.get(roomRef);
                if (!snap.exists()) return;
                const cur = snap.data() || {};
                if (endKey && cur.sessionCountedGame === endKey) return;
                const update = {
                    sessionMatchCount: (cur.sessionMatchCount || 0) + 1,
                    sessionCountedGame: endKey || null,
                };
                if (winners.length === 1 && topScore > 0) {
                    const prevWins = (cur.sessionWinsByUid && cur.sessionWinsByUid[winners[0].uid]) || 0;
                    update[`sessionWinsByUid.${winners[0].uid}`] = prevWins + 1;
                }
                tx.update(roomRef, update);
            });
        } catch (err) {
            console.warn('Session H2H write failed:', err);
        }
    }

    // Per-pair lifetime H2H - written by whichever side of the pair has
    // the lexicographically lower uid. That single-writer convention
    // (a) satisfies the rules (the writer is uidA, so rules pass)
    // (b) avoids two clients racing to increment the same pair doc.
    // For pairs that don't include me, OR pairs where I'm uidB, I
    // skip - my counterpart handles the write. Guests skip entirely
    // (rules block anon writes to triviaH2H), and a registered player
    // skips GUEST opponents too (their uid is per-device; the pair row
    // would only ever orphan, audit D16).
    if (isGuest()) return;
    const myUid = state.user.uid;
    for (const opp of players) {
        if (!opp || !opp.uid || opp.uid === myUid || opp.isGuest) continue;
        if (myUid >= opp.uid) continue; // only the lower-uid side writes
        const me = players.find((p) => p.uid === myUid);
        if (!me) continue;
        const uidA = myUid;
        const uidB = opp.uid;
        const key = uidA + '__' + uidB;
        const aScore = me.score || 0;
        const bScore = opp.score || 0;
        try {
            const gameType = state.roomData.gameType || 'trivia';
            await runTransaction(db, async (tx) => {
                const ref = doc(db, 'triviaH2H', key);
                const snap = await tx.get(ref);
                const cur = snap.exists() ? snap.data() : {};
                // Same durable guard: a reload must not add a second game to
                // a lifetime record two people read.
                if (endKey && cur.lastCountedGame === endKey) return;
                const winsA = (cur.winsA || 0) + (aScore > bScore ? 1 : 0);
                const winsB = (cur.winsB || 0) + (bScore > aScore ? 1 : 0);
                const ties = (cur.ties || 0) + (aScore === bScore ? 1 : 0);
                // Track game-type breakdown so the H2H view can show
                // per-mode records when the pair has played multiple modes.
                const prevGameTypes = (cur.gameTypes && typeof cur.gameTypes === 'object') ? cur.gameTypes : {};
                const prevTypeCount = prevGameTypes[gameType] || 0;
                tx.set(ref, {
                    uidA, uidB,
                    displayNameA: me.displayName || 'Player',
                    displayNameB: opp.displayName || 'Player',
                    winsA, winsB, ties,
                    gamesPlayed: (cur.gamesPlayed || 0) + 1,
                    lastPlayedAt: serverTimestamp(),
                    lastCountedGame: endKey || null,
                    gameTypes: { ...prevGameTypes, [gameType]: prevTypeCount + 1 }
                }, { merge: true });
            });
        } catch (err) {
            // The most common cause here is "Missing or insufficient
            // permissions" - i.e. the Firestore rules for /triviaH2H
            // haven't been deployed yet. Run:
            //     firebase deploy --only firestore:rules
            // The block won't fail the rest of end-of-game.
            console.warn('H2H write failed for pair', key, '- check that firestore.rules has been deployed:', err);
        }
    }
}

async function maybeWriteDailyLeaderboard(me) {
    if (!state.user || !state.roomData) return;
    // Guests don't qualify for the daily leaderboard - anon uids can
    // change at any time, so their score isn't a "personal best" anyone
    // could ever beat. Rules block the write anyway.
    if (isGuest()) return;
    if (state.roomData.playMode !== 'daily') return;
    const dateKey = state.roomData.dailyDateKey;
    if (!dateKey) return;
    const ref = doc(db, 'globeDropDailyLeaderboard', dateKey, 'scores', state.user.uid);
    try {
        const existing = await getDoc(ref);
        const prevScore = existing.exists() ? Number(existing.data().score || 0) : -1;
        if (me.score <= prevScore) return; // not a personal best for today
        await setDoc(ref, {
            uid: state.user.uid,
            displayName: me.displayName,
            score: me.score,
            roundType: state.roomData.roundType || 'capitals',
            difficulty: state.roomData.difficulty || Config.GLOBE_DROP_DIFFICULTY_DEFAULT,
            locations: state.roomData.totalQuestions || 0,
            completedAt: serverTimestamp()
        }, { merge: true });
    } catch (err) {
        console.warn('Daily leaderboard write failed:', err);
    }
}

/* =====================================================================
 * Game recap - per-question/per-location table + aggregate stats
 * ===================================================================== */

/**
 * Lifetime head-to-head banner at the top of the end-stage recap.
 * Only renders in 2-player rooms (the pair concept is clear there).
 * Pulls the triviaH2H/<pair> doc, falls back to a placeholder when
 * the pair has no recorded games yet (e.g. first match between two
 * accounts).
 */
async function renderEndRecapH2H(players) {
    const banner = document.getElementById('end-recap-h2h');
    if (!banner) return;
    banner.hidden = true;
    if (!state.user || !Array.isArray(players)) return;
    // Show when exactly 2 players have recorded answers (works even when a 3rd player left).
    const withAnswers = players.filter((p) => p && Array.isArray(p.answers) && p.answers.length > 0);
    const twoPlayers = withAnswers.length === 2 ? withAnswers : (players.length === 2 ? players : null);
    if (!twoPlayers) return;
    const me = twoPlayers.find((p) => p.uid === state.user.uid);
    const opp = twoPlayers.find((p) => p.uid !== state.user.uid);
    if (!me || !opp) return;
    const key = h2hPairKey(me.uid, opp.uid);
    if (!key) return;
    let pair = null;
    state.h2hPairCache = state.h2hPairCache || {};
    if (state.h2hPairCache[key]) {
        pair = state.h2hPairCache[key];
    } else {
        try {
            const snap = await getDoc(doc(db, 'triviaH2H', key));
            pair = snap.exists() ? snap.data() : null;
            state.h2hPairCache[key] = pair;
        } catch (_) { pair = null; }
    }
    const myIsA = pair && pair.uidA === me.uid;
    const wins   = pair ? (myIsA ? (pair.winsA || 0) : (pair.winsB || 0)) : 0;
    const losses = pair ? (myIsA ? (pair.winsB || 0) : (pair.winsA || 0)) : 0;
    const draws  = pair ? (pair.ties || 0) : 0;
    const total  = wins + draws + losses;
    banner.innerHTML =
        '<div class="end-recap-h2h-head">'
        + '<span class="end-recap-h2h-label">Head to head</span>'
        + `<span class="end-recap-h2h-names">${escapeHtml(me.displayName || 'You')}<span> vs </span>${escapeHtml(opp.displayName || 'Opponent')}</span>`
        + '</div>'
        + '<div class="end-recap-h2h-record">'
        + `<span class="end-recap-h2h-pill is-win">${wins}<small>W</small></span>`
        + `<span class="end-recap-h2h-pill is-draw">${draws}<small>D</small></span>`
        + `<span class="end-recap-h2h-pill is-loss">${losses}<small>L</small></span>`
        + `<span class="end-recap-h2h-total">${total === 0 ? 'First match' : (total + ' total')}</span>`
        + '</div>';
    banner.hidden = false;
}

function renderEndRecap() {
    const section = $('#end-recap');
    if (!section) return;
    const players = endStagePlayers() || [];
    if (!players.length) { section.hidden = true; return; }

    const isGlobeDrop = state.roomData && state.roomData.gameType === 'globe-drop';

    // Lifetime H2H banner - only in 2-player rooms (the pair record
    // is unambiguous). Fetches the triviaH2H pair doc and shows
    // W-D-L between the local user and the opponent at the top of
    // the recap.
    renderEndRecapH2H(players);

    // Pick columns: me first, then highest-scoring opponents, cap at 4 so
    // the table stays readable on phones.
    const rankedAll = Scoring.rankPlayers(players.map((p) => ({
        uid: p.uid,
        displayName: p.displayName,
        score: isGlobeDrop ? globeDropPlayerTotal(p) : (p.score || 0),
        streak: p.streak || 0
    })));
    const columns = [];
    if (state.user) {
        const me = rankedAll.find((p) => p.uid === state.user.uid);
        if (me) columns.push(me);
    }
    for (const p of rankedAll) {
        if (columns.length >= 4) break;
        if (!columns.find((c) => c.uid === p.uid)) columns.push(p);
    }

    // Per-uid answers map (anything without answers[] just shows dashes)
    const answersByUid = {};
    players.forEach((p) => {
        answersByUid[p.uid] = Array.isArray(p.answers) ? p.answers : [];
    });

    // Question list in order of play.
    const pool = Array.isArray(state.roomData.questions) ? state.roomData.questions : [];
    const playedIds = Array.isArray(state.roomData.playedQuestionIds)
        ? state.roomData.playedQuestionIds
        : [];
    const questions = playedIds.map((id) => pool.find((q) => q && q.id === id)).filter(Boolean);

    // Aggregate stat tiles
    const statsHost = $('#end-recap-stats');
    statsHost.innerHTML = '';
    const aggregates = isGlobeDrop
        ? computeGlobeDropAggregates(columns, answersByUid)
        : computeTriviaAggregates(columns, answersByUid);
    aggregates.forEach((card) => {
        const div = document.createElement('div');
        div.className = 'end-recap-stat'
            + (card.isMine ? ' is-mine' : '')
            + (card.isClosest ? ' is-closest' : '');
        div.innerHTML =
            `<span class="end-recap-stat-label">${escapeHtml(card.label)}</span>` +
            `<span class="end-recap-stat-value">${escapeHtml(card.value)}</span>` +
            (card.sub ? `<span class="end-recap-stat-sub">${escapeHtml(card.sub)}</span>` : '');
        statsHost.appendChild(div);
    });

    // Compact table - rank | ×mult | location | per-player score | winner.
    // Replaces the previous card-list which spread each round across
    // two strips; the table is one row per round, easier to scan
    // vertically for 8-10 round matches.
    const thead = $('#end-recap-thead');
    const tbody = $('#end-recap-tbody');
    const emptyEl = $('#end-recap-empty');
    thead.innerHTML = '';
    tbody.innerHTML = '';
    if (emptyEl) emptyEl.hidden = true;

    const anyAnswers = columns.some((c) => (answersByUid[c.uid] || []).length > 0);
    if (!questions.length || !anyAnswers) {
        if (emptyEl) emptyEl.hidden = false;
        setText($('#end-recap-sub'), '');
        section.hidden = false;
        return;
    }

    // Header row. Solo runs skip the Winner column entirely - there's
    // only one player, "winner" would just be that player on every row.
    const isSoloRecap = (state.roomData && state.roomData.playMode) === 'solo';
    const trHead = document.createElement('tr');
    let headHTML = '<th class="recap-rank">#</th>'
        + (isGlobeDrop ? '<th class="recap-mult-cell">Mult</th>' : '')
        + `<th class="recap-loc-cell">${isGlobeDrop ? 'Location' : 'Question'}</th>`;
    columns.forEach((col) => {
        const isMe = state.user && col.uid === state.user.uid;
        headHTML += `<th class="recap-score-cell${isMe ? ' is-mine' : ''}">${escapeHtml(isMe ? 'You' : col.displayName)}</th>`;
    });
    if (!isSoloRecap) headHTML += '<th class="recap-winner-cell">Winner</th>';
    trHead.innerHTML = headHTML;
    thead.appendChild(trHead);

    // Body rows
    const fmt = (n) => n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
    questions.forEach((q, i) => {
        const tr = document.createElement('tr');
        const roundMult = (isGlobeDrop && typeof q.multiplier === 'number') ? q.multiplier : null;
        const multCell = isGlobeDrop
            ? `<td class="recap-mult-cell">${roundMult != null ? `×${escapeHtml(fmt(roundMult))}` : ''}</td>`
            : '';

        let locCell;
        if (isGlobeDrop) {
            locCell = '<td class="recap-loc-cell">'
                + `<span class="recap-loc-name">${escapeHtml(q.name || '…')}</span>`
                + (q.country ? `<span class="recap-loc-country">${escapeHtml(q.country)}</span>` : '')
                + '</td>';
        } else {
            const correctText = q.choices ? q.choices[q.correctIndex] : '';
            locCell = '<td class="recap-loc-cell is-trivia">'
                + `<span class="recap-loc-name">${escapeHtml(q.question || '…')}</span>`
                + `<span class="recap-loc-country">${escapeHtml(prettyCategory(q.category || ''))} · answer: ${escapeHtml(correctText)}</span>`
                + '</td>';
        }

        // Per-column results + winner detection. Both-zero is a TIE,
        // not "no winner" - so the winner column always shows something.
        const colResults = columns.map((col) => {
            const ans = (answersByUid[col.uid] || [])
                .find((a) => (a.locationId || a.questionId) === q.id);
            // Globe Drop: recompute from distance + the location's canonical
            // multiplier so both players use the same formula. Trivia keeps
            // its stored points (not distance-based).
            if (isGlobeDrop) {
                const s = ans ? globeDropDisplayScore(ans, q) : { basePoints: 0, points: 0 };
                return { col, ans, points: s.points, basePoints: s.basePoints };
            }
            const points = ans ? (Number(ans.points) || 0) : 0;
            return { col, ans, points };
        });
        const bestPoints = colResults.reduce((max, r) => Math.max(max, r.points), 0);
        const winnersOfRow = colResults.filter((r) => r.points === bestPoints);
        const isTie = winnersOfRow.length > 1;

        let scoreCells = '';
        colResults.forEach(({ col, ans, points, basePoints }) => {
            const isMe = state.user && col.uid === state.user.uid;
            const isWinner = !isTie && points === bestPoints && points > 0;
            let cls = 'recap-score-cell';
            if (isGlobeDrop) cls += ' recap-gd';
            if (points === 0) cls += ' is-zero';
            if (isMe) cls += ' is-mine';
            if (isWinner) cls += ' is-winner';

            if (!ans && points === 0) {
                scoreCells += `<td class="${cls}">0</td>`;
                return;
            }
            if (isGlobeDrop) {
                // Show base score (0-100) prominently, then the
                // "× multiplier = total" meta + distance. base + points are
                // recomputed from distance (see colResults) so they are
                // consistent across players and base × multiplier = total.
                const base = typeof basePoints === 'number' ? basePoints : 0;
                const mult = (typeof q.multiplier === 'number' && q.multiplier > 0) ? q.multiplier : 1;
                const multStr = mult.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
                const finalTxt = mult !== 1 ? `× ${multStr} = ${points}` : '';
                const distTxt = (ans && ans.distanceKm != null)
                    ? `${Math.round(Number(ans.distanceKm) || 0).toLocaleString()} km`
                    : '';
                const metaParts = [finalTxt, distTxt].filter(Boolean).join(' · ');
                const metaHtml = metaParts ? `<span class="recap-score-meta">${escapeHtml(metaParts)}</span>` : '';
                // Green FILL intensity scales with the BASE score (0-100), so the
                // color tracks performance CONSISTENTLY across rows: 99 ≈ max,
                // 80 clearly weaker, a 1-point gap ~invisible. The round winner
                // is shown separately by a subtle left-accent marker
                // (.recap-gd.is-winner in CSS), NOT a brighter fill - so a
                // 1-point win never looks like a blowout. Only the answered
                // cells get tinted; a no-guess stays neutral via is-zero.
                const clampedBase = Math.max(0, Math.min(100, base));
                const alpha = base > 0 ? (0.05 + 0.30 * clampedBase / 100) : 0;
                const styleAttr = alpha > 0
                    ? ` style="background-color: rgba(16, 185, 129, ${alpha.toFixed(3)})"`
                    : '';
                scoreCells += `<td class="${cls}"${styleAttr}><span class="recap-base">${base}</span>${metaHtml}</td>`;
            } else {
                const pickClass = ans && ans.correct ? 'is-correct' : 'is-wrong';
                const pickHtml = ans
                    ? ` <span class="recap-pick ${pickClass}">${escapeHtml(ans.answerText || '…')}</span>`
                    : '';
                scoreCells += `<td class="${cls}">${points > 0 ? '+' + points : '0'}${pickHtml}</td>`;
            }
        });

        // Gold trophy for a single winner; grey "Tie" pill when
        // multiple cells tie (including the everyone-scored-0 case).
        // Solo runs skip the Winner column outright.
        let winnerCell = '';
        if (!isSoloRecap) {
            if (!isTie) {
                const w = winnersOfRow[0].col;
                const isMe = state.user && w.uid === state.user.uid;
                winnerCell = `<td class="recap-winner-cell"><span class="recap-winner-badge">🏆 ${escapeHtml(isMe ? 'You' : w.displayName)}</span></td>`;
            } else {
                winnerCell = '<td class="recap-winner-cell"><span class="recap-tie-badge">Tie</span></td>';
            }
        }

        tr.innerHTML = `<td class="recap-rank">${i + 1}</td>${multCell}${locCell}${scoreCells}${winnerCell}`;
        tbody.appendChild(tr);
    });

    const qNoun = questions.length === 1 ? 'question' : (isGlobeDrop ? 'locations' : 'questions');
    setText($('#end-recap-sub'),
        `${questions.length} ${qNoun} · comparing ${columns.length} player${columns.length === 1 ? '' : 's'}`);
    section.hidden = false;
    // Apply the scroll-fade mask only when the table actually overflows.
    const tableWrap = document.querySelector('.end-recap-table-wrap');
    if (tableWrap) {
        tableWrap.classList.toggle('has-overflow', tableWrap.scrollWidth > tableWrap.clientWidth);
    }
}

function computeGlobeDropAggregates(columns, answersByUid) {
    const cards = [];
    const pool = (state.roomData && Array.isArray(state.roomData.questions)) ? state.roomData.questions : [];
    columns.forEach((col) => {
        const ans = answersByUid[col.uid] || [];
        if (!ans.length) return;
        // Recompute from distance so the score tile matches the recap and is
        // consistent across players (see globeDropDisplayScore).
        const totalPts = ans.reduce((s, a) => {
            const loc = pool.find((q) => q && q.id === (a && a.locationId));
            return s + globeDropDisplayScore(a, loc).points;
        }, 0);
        const totalDist = ans.reduce((s, a) => s + (Number(a.distanceKm) || 0), 0);
        const avgDist = Math.round(totalDist / ans.length);
        const isMine = state.user && col.uid === state.user.uid;
        cards.push({
            isMine,
            label: (isMine ? 'You' : col.displayName) + ' · score',
            value: totalPts + ' pts',
            sub: 'Avg ' + avgDist.toLocaleString() + ' km off'
        });
    });
    // "Closest guess" across all visible players
    let closest = null;
    let closestPlayer = null;
    columns.forEach((col) => {
        (answersByUid[col.uid] || []).forEach((a) => {
            if (!closest || a.distanceKm < closest.distanceKm) {
                closest = a;
                closestPlayer = col;
            }
        });
    });
    if (closest && closestPlayer) {
        const isMine = state.user && closestPlayer.uid === state.user.uid;
        cards.push({
            isMine: false,
            isClosest: true,
            label: 'Closest guess',
            value: Math.round(closest.distanceKm).toLocaleString() + ' km',
            sub: (isMine ? 'You' : closestPlayer.displayName) + ' · ' + closest.locationName
        });
    }
    return cards;
}

function computeTriviaAggregates(columns, answersByUid) {
    const cards = [];
    columns.forEach((col) => {
        const ans = answersByUid[col.uid] || [];
        if (!ans.length) return;
        const correctCount = ans.filter((a) => a.correct).length;
        const accuracy = Math.round(100 * correctCount / ans.length);
        // Average response time (only among answered questions)
        const respMs = ans.reduce((s, a) => {
            const total = Number(a.totalMs) || 0;
            const left = Number(a.timeLeftMs) || 0;
            return s + Math.max(0, total - left);
        }, 0);
        const avgResp = ans.length ? Math.round(respMs / ans.length) : 0;
        const avgRespLabel = avgResp < 1000 ? avgResp + 'ms' : (avgResp / 1000).toFixed(1) + 's';
        const isMine = state.user && col.uid === state.user.uid;
        cards.push({
            isMine,
            label: (isMine ? 'You' : col.displayName) + ' · accuracy',
            value: accuracy + '%',
            sub: correctCount + ' / ' + ans.length + ' correct · avg ' + avgRespLabel
        });
    });
    return cards;
}

function renderDetailedStats() {
    const grid = $('#detailed-stats-grid');
    grid.innerHTML = '';
    grid.classList.remove('is-table');
    const isGlobeDrop = state.roomData && state.roomData.gameType === 'globe-drop';

    if (isGlobeDrop) {
        // Comparison table needs the host to drop its tile-grid layout
        // so the <table> can lay out naturally end-to-end.
        grid.classList.add('is-table');
        renderGlobeDropComparisonTable(grid);
    } else {
        renderTriviaDetailedStats(grid);
    }
}

/**
 * Side-by-side stats table for Globe Drop end-of-game. Each row is a
 * metric; each column is a player. The cell with the best value in a
 * row gets a leader highlight so the eye picks up "who won where" at
 * a glance. Falls back to the single-player tile grid when there's
 * only one row to compare against (solo or no peers in the doc).
 */
function renderGlobeDropComparisonTable(host) {
    // Total rounds in the game (not per-player guess count) drives the
    // denominator for avgs and the "X / Y" rounds-guessed cell. Fixes
    // the off-by-one users hit when they timed out on the last round.
    const totalRounds = Array.isArray(state.roomData && state.roomData.playedQuestionIds)
        ? state.roomData.playedQuestionIds.length
        : 0;

    // Order: me first, then opponents by total points desc (so the
    // strongest opponent reads next to me). Cap at 4 columns total
    // for table width sanity on phones. Globe Drop ranks by the
    // recomputed-from-distance total for cross-player consistency.
    const ranked = Scoring.rankPlayers(endStagePlayers().map((p) => ({
        uid: p.uid,
        displayName: p.displayName,
        score: globeDropPlayerTotal(p),
        streak: p.streak || 0
    })));
    const cols = [];
    if (state.user) {
        const me = ranked.find((p) => p.uid === state.user.uid);
        if (me) cols.push(me);
    }
    for (const p of ranked) {
        if (cols.length >= 4) break;
        if (!cols.find((c) => c.uid === p.uid)) cols.push(p);
    }
    if (!cols.length) return;

    // Compute stats per column from the matching player doc.
    const statsByUid = {};
    cols.forEach((col) => {
        const player = endStagePlayers().find((p) => p.uid === col.uid);
        const answers = (player && Array.isArray(player.answers)) ? player.answers : [];
        statsByUid[col.uid] = RoomState.aggregateGlobeDropStats(answers, totalRounds);
    });

    // Row definitions: label, value extractor (returns { text, sub?, sortKey, missing? })
    // - sortKey + higherIsBetter determines which cell gets the leader badge.
    const fmt = (n) => (n == null ? '—' : n.toLocaleString());
    const rows = [
        { label: 'Final score',     higherIsBetter: true,  get: (s, col) => ({ text: String(col.score || 0), sortKey: col.score || 0 }) },
        { label: 'Avg base score',  higherIsBetter: true,  get: (s) => s ? { text: s.avgBaseScore + ' / 100', sortKey: s.avgBaseScore } : null },
        { label: 'Closest guess',   higherIsBetter: false, get: (s) => s && s.closestKm != null ? { text: fmt(s.closestKm) + ' km', sub: s.closestLocation, sortKey: s.closestKm } : null },
        { label: 'Farthest miss',   higherIsBetter: false, get: (s) => s && s.farthestKm != null ? { text: fmt(s.farthestKm) + ' km', sub: s.farthestLocation, sortKey: s.farthestKm } : null },
        { label: 'Bullseyes',       higherIsBetter: true,  get: (s) => s ? { text: String(s.bullseyeCount), sub: '98+ base', sortKey: s.bullseyeCount } : null }
    ];

    // Per-region rows, deduped across all players' regions.
    const regionsSeen = new Set();
    cols.forEach((col) => {
        const s = statsByUid[col.uid];
        if (s && s.byRegion) Object.keys(s.byRegion).forEach((r) => regionsSeen.add(r));
    });
    for (const region of regionsSeen) {
        rows.push({
            label: region,
            higherIsBetter: true,
            isRegion: true,
            get: (s) => {
                if (!s || !s.byRegion || !s.byRegion[region]) return null;
                const rec = s.byRegion[region];
                return {
                    text: rec.avgBase + ' / 100',
                    sub: rec.rounds + (rec.rounds === 1 ? ' round' : ' rounds'),
                    sortKey: rec.avgBase
                };
            }
        });
    }

    // Build the table.
    const table = document.createElement('table');
    table.className = 'detailed-stats-table';
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    headRow.innerHTML = '<th class="detailed-stats-row-label">Stat</th>'
        + cols.map((col) => {
            const isMe = state.user && col.uid === state.user.uid;
            return `<th class="detailed-stats-col${isMe ? ' is-mine' : ''}">${escapeHtml(isMe ? 'You' : col.displayName)}</th>`;
        }).join('');
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    let regionHeaderInserted = false;
    rows.forEach((row) => {
        // Insert a divider header before the first region row so the
        // continent group reads as its own block.
        if (row.isRegion && !regionHeaderInserted) {
            const tr = document.createElement('tr');
            tr.className = 'detailed-stats-section';
            tr.innerHTML = `<th colspan="${cols.length + 1}">By continent · avg score</th>`;
            tbody.appendChild(tr);
            regionHeaderInserted = true;
        }
        const tr = document.createElement('tr');
        const cells = cols.map((col) => row.get(statsByUid[col.uid], col));
        // Find the leader cell - best sortKey under higherIsBetter sense.
        const valid = cells.filter((c) => c && Number.isFinite(c.sortKey));
        let bestKey = null;
        if (valid.length) {
            bestKey = valid.reduce((acc, c) => {
                if (acc == null) return c.sortKey;
                return row.higherIsBetter ? Math.max(acc, c.sortKey) : Math.min(acc, c.sortKey);
            }, null);
        }
        let html = `<th scope="row" class="detailed-stats-row-label">${escapeHtml(row.label)}</th>`;
        cells.forEach((cell, i) => {
            const col = cols[i];
            const isMe = state.user && col.uid === state.user.uid;
            const isLeader = cell && bestKey != null && cell.sortKey === bestKey && valid.length > 1;
            let cls = 'detailed-stats-cell';
            if (isMe) cls += ' is-mine';
            if (isLeader) cls += ' is-leader';
            if (!cell) {
                html += `<td class="${cls} is-missing">—</td>`;
                return;
            }
            html += `<td class="${cls}"><span class="detailed-stats-value">${escapeHtml(cell.text)}</span>`
                + (cell.sub ? `<span class="detailed-stats-sub">${escapeHtml(cell.sub)}</span>` : '')
                + `</td>`;
        });
        tr.innerHTML = html;
        tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    host.appendChild(table);
}

function renderTriviaDetailedStats(host) {
    // Trivia: per-question records stored in state.currentAnswers,
    // each carrying `correct` + `category` + `timeLeftMs` + `totalMs`.
    // Kept as the legacy tile grid since trivia doesn't have multi-
    // player per-question detail to compare in a table.
    // Accuracy divides by the room's TOTAL question count, so a skipped
    // question counts as a miss - the same rule as Globe Drop's
    // aggregator (defect 25 decision).
    const totalRounds = Number(state.roomData && state.roomData.totalQuestions)
        || state.currentAnswers.length;
    const stats = RoomState.aggregateAnswerStats(state.currentAnswers, totalRounds);
    const push = (label, value, highlight) => {
        const div = document.createElement('div');
        div.className = 'detailed-stat' + (highlight ? ' is-highlight' : '');
        div.innerHTML =
            `<span class="detailed-stat-label">${escapeHtml(label)}</span>` +
            `<span class="detailed-stat-value">${escapeHtml(value)}</span>`;
        host.appendChild(div);
    };
    push('Accuracy', Math.round(stats.accuracy * 100) + '%', true);
    push('Avg response',
        stats.avgResponseMs < 1000
            ? stats.avgResponseMs + 'ms'
            : (stats.avgResponseMs / 1000).toFixed(1) + 's');
    push('Questions answered', String(state.currentAnswers.length));
    for (const [cat, rec] of Object.entries(stats.byCategory)) {
        const pct = rec.total ? Math.round(100 * rec.correct / rec.total) : 0;
        push(cat.replace(/-/g, ' '), rec.correct + '/' + rec.total + ' · ' + pct + '%');
    }
}

/* =====================================================================
 * Rematch flow
 * =====================================================================
 *
 * The host proposes a rematch; every other player in the room must
 * accept before the new game starts. Anyone declining cancels the
 * proposal for everyone. Room doc carries the coordination state:
 *
 *   rematchProposedBy:    uid of the host who proposed (or null)
 *   rematchAcceptedBy:    array of uids who have accepted
 *   rematchDeclinedBy:    array of uids who have declined
 *
 * Once `rematchAcceptedBy.length === playerCount` and no decliners,
 * `playAgain()` is invoked by the host's client (only one client should
 * actually do the writes - we gate by `state.roomData.hostUid`).
 */

function rematchAcceptCount() {
    const r = state.roomData || {};
    return Array.isArray(r.rematchAcceptedBy) ? r.rematchAcceptedBy.length : 0;
}
function rematchDeclineCount() {
    const r = state.roomData || {};
    return Array.isArray(r.rematchDeclinedBy) ? r.rematchDeclinedBy.length : 0;
}
function rematchPlayerCount() {
    // Live players only: a ghost past the grace window must not make a
    // unanimous rematch impossible (audit D4).
    return livePlayers().length;
}
function meHasAcceptedRematch() {
    if (!state.user) return false;
    const arr = (state.roomData && state.roomData.rematchAcceptedBy) || [];
    return arr.indexOf(state.user.uid) !== -1;
}
function meHasDeclinedRematch() {
    if (!state.user) return false;
    const arr = (state.roomData && state.roomData.rematchDeclinedBy) || [];
    return arr.indexOf(state.user.uid) !== -1;
}

function renderRoomSessionH2H() {
    const panel = $('#room-session-h2h');
    const list = $('#room-session-h2h-list');
    if (!panel || !list) return;
    const room = state.roomData || {};
    const matchCount = room.sessionMatchCount || 0;
    const playMode = room.playMode || 'multi';
    if (playMode !== 'multi' || matchCount < 1 || endStagePlayers().length < 2) {
        panel.hidden = true;
        return;
    }
    const wins = room.sessionWinsByUid || {};
    const rows = endStagePlayers().map((p) => ({
        uid: p.uid,
        displayName: p.displayName,
        sessionWins: wins[p.uid] || 0
    })).sort((a, b) => b.sessionWins - a.sessionWins);
    // Ties aren't tracked per-player; derive from the gap between
    // matchCount and the sum of per-player wins. In 2-player rooms
    // this gives exact W/D/L; in 3+ player rooms "draws" counts
    // matches where no single player took the top score.
    const totalRecordedWins = rows.reduce((s, r) => s + r.sessionWins, 0);
    const draws = Math.max(0, matchCount - totalRecordedWins);
    list.innerHTML = '';
    rows.forEach((r, i) => {
        const losses = Math.max(0, matchCount - r.sessionWins - draws);
        const li = document.createElement('li');
        li.className = 'mini-board-row session-h2h-row';
        if (state.user && r.uid === state.user.uid) li.classList.add('is-me');
        li.innerHTML =
            `<span class="mini-board-rank">${i + 1}</span>` +
            `<span class="mini-board-name">${escapeHtml(r.displayName)}</span>` +
            `<span class="session-h2h-wl">` +
                `<span class="session-h2h-pill is-win">${r.sessionWins}W</span>` +
                `<span class="session-h2h-pill is-draw">${draws}D</span>` +
                `<span class="session-h2h-pill is-loss">${losses}L</span>` +
            `</span>`;
        list.appendChild(li);
    });
    panel.hidden = false;
}

function renderRematchUI(isHost) {
    const playerCount = rematchPlayerCount();
    const proposed = !!(state.roomData && state.roomData.rematchProposedBy);
    const declined = rematchDeclineCount() > 0;
    const playMode = (state.roomData && state.roomData.playMode) || 'multi';
    const strip = $('#rematch-strip');
    const status = $('#rematch-status');
    const actions = $('#rematch-actions');
    const proposeBtn = $('#end-again-btn');

    // Hide everything by default, then enable based on state.
    if (proposeBtn) proposeBtn.hidden = true;
    if (strip) strip.hidden = true;
    if (actions) actions.hidden = true;

    // Solo: there's only one player so there's nothing to accept-gate. Show
    // a single Restart button that fires playAgain immediately.
    if (playMode === 'solo' && playerCount === 1) {
        if (proposeBtn) {
            proposeBtn.hidden = false;
            proposeBtn.innerHTML = '<span aria-hidden="true">🔁</span> Restart';
        }
        return;
    }

    // Multiplayer rematch requires at least 2 players. If <2 remain,
    // no rematch at all.
    if (playerCount < 2) return;

    if (!proposed) {
        // No proposal yet - any player can propose a rematch.
        if (proposeBtn) {
            proposeBtn.hidden = false;
            proposeBtn.innerHTML = '<span aria-hidden="true">🔁</span> Rematch';
        }
        return;
    }

    // Proposal active - show strip with progress.
    if (strip) strip.hidden = false;
    if (declined) {
        // Surface the decline briefly, then auto-reset so anyone can
        // propose again. Without this, a single decline used to lock
        // the rematch flow forever.
        if (status) setText(status, 'Rematch declined - try again any time.');
        if (proposeBtn) {
            proposeBtn.hidden = false;
            proposeBtn.innerHTML = '<span aria-hidden="true">🔁</span> Propose again';
        }
        clearRematchStateSoon();
        return;
    }
    const accepted = rematchAcceptCount();
    if (status) setText(status, `Rematch - ${accepted} / ${playerCount} players ready`);

    // Show accept/decline buttons to anyone who hasn't yet responded.
    if (actions && state.user && !meHasAcceptedRematch() && !meHasDeclinedRematch()) {
        actions.hidden = false;
    }

    // When everyone has accepted, the host fires the actual restart.
    if (isHost && accepted >= playerCount) {
        playAgain();
    }
}

async function proposeRematch() {
    if (!state.roomCode || !state.roomData || !state.user) return;
    if (rematchPlayerCount() < 2) return;
    try {
        await updateDoc(doc(db, 'triviaRooms', state.roomCode), {
            rematchProposedBy: state.user.uid,
            rematchAcceptedBy: [state.user.uid],
            rematchDeclinedBy: [],
            rematchProposedAt: serverTimestamp()
        });
        // Open the waiting modal locally for the proposer. The room
        // snapshot listener will re-render its contents as opponents
        // respond. Auto-cancels after PROPOSAL_TIMEOUT_MS.
        openProposalPendingModal();
    } catch (err) {
        console.warn('proposeRematch failed:', err);
    }
}

/* Proposer's waiting modal - single-instance, driven by the room
 * snapshot. The timer is a setInterval that ticks the countdown
 * label every 250ms and force-closes once it hits 0. Cancelling
 * from the modal calls clearRematchStateSoon() to wipe the room
 * fields immediately so opponents stop seeing the prompt. */
const PROPOSAL_TIMEOUT_MS = 10000;
let proposalPendingTimerId = null;
// B10: Escape cancels the pending proposal, matching the Escape contract every
// other modal in the app honors (it is exactly the Cancel button's action).
// Backdrop clicks stay deliberately inert: the modal auto-resolves in 10s and
// an accidental tap should not burn a restart allowance.
function onProposalPendingKeydown(e) {
    if (e.key !== 'Escape') return;
    const modal = document.getElementById('proposal-pending-modal');
    if (!modal || modal.hasAttribute('hidden')) return;
    e.preventDefault();
    cancelOwnProposal('cancel');
}
function openProposalPendingModal() {
    const modal = document.getElementById('proposal-pending-modal');
    if (!modal) return;
    state.proposalPendingDeadline = Date.now() + PROPOSAL_TIMEOUT_MS;
    modal.removeAttribute('hidden');
    document.addEventListener('keydown', onProposalPendingKeydown);
    // Reset the depletion bar to full width and kick off the 10-second
    // shrink. transition: transform 0.25s linear in CSS smooths the
    // 250ms render cadence into a continuous animation.
    const barInner = modal.querySelector('.proposal-pending-bar span');
    if (barInner) {
        barInner.style.transition = 'none';
        barInner.style.transform = 'scaleX(1)';
        // Force a layout flush, then re-enable the transition and kick
        // the bar to 0 over the full proposal window.
        // eslint-disable-next-line no-void
        void barInner.offsetWidth;
        barInner.style.transition = `transform ${PROPOSAL_TIMEOUT_MS}ms linear`;
        barInner.style.transform = 'scaleX(0)';
    }
    renderProposalPendingModal();
    if (proposalPendingTimerId) clearInterval(proposalPendingTimerId);
    proposalPendingTimerId = setInterval(() => {
        const left = state.proposalPendingDeadline - Date.now();
        if (left <= 0) {
            cancelOwnProposal('timeout');
            return;
        }
        renderProposalPendingModal();
    }, 250);
}
function closeProposalPendingModal() {
    const modal = document.getElementById('proposal-pending-modal');
    if (modal) modal.setAttribute('hidden', '');
    if (proposalPendingTimerId) {
        clearInterval(proposalPendingTimerId);
        proposalPendingTimerId = null;
    }
    state.proposalPendingDeadline = null;
    document.removeEventListener('keydown', onProposalPendingKeydown);
}
function renderProposalPendingModal() {
    const list = document.getElementById('proposal-response-list');
    const timerEl = document.getElementById('proposal-pending-timer');
    if (!list || !timerEl) return;
    const room = state.roomData || {};
    const accepted = Array.isArray(room.rematchAcceptedBy) ? room.rematchAcceptedBy : [];
    const declined = Array.isArray(room.rematchDeclinedBy) ? room.rematchDeclinedBy : [];
    // List rows for every player EXCEPT the proposer (they're the host
    // of the proposal, no need to show their own row).
    const myUid = state.user && state.user.uid;
    const others = state.roomPlayers.filter((p) => p.uid !== myUid);
    list.innerHTML = '';
    others.forEach((p) => {
        const li = document.createElement('li');
        // Single-word status label; the CSS handles the pulsing
        // "Waiting" amber pill vs the glowing "Ready" green pill.
        let status = 'Waiting';
        let cls = 'is-pending';
        if (declined.includes(p.uid)) { status = 'Declined'; cls = 'is-declined'; }
        else if (accepted.includes(p.uid)) { status = 'Ready'; cls = 'is-accepted'; }
        li.className = 'proposal-response-row ' + cls;
        const initial = avatarLetter(p.displayName);
        li.innerHTML =
            `<span class="avatar" aria-hidden="true">${escapeHtml(initial)}</span>` +
            `<span class="name">${escapeHtml(p.displayName || 'Player')}</span>` +
            `<span class="status">${escapeHtml(status)}</span>`;
        list.appendChild(li);
    });
    const left = Math.max(0, Math.ceil((state.proposalPendingDeadline - Date.now()) / 1000));
    timerEl.textContent = left + 's remaining';
}
async function cancelOwnProposal(reason) {
    closeProposalPendingModal();
    // Clear the room fields right away so opponents stop seeing the
    // prompt. Best-effort.
    if (!state.roomCode) return;
    try {
        await updateDoc(doc(db, 'triviaRooms', state.roomCode), {
            rematchProposedBy: null,
            rematchAcceptedBy: [],
            rematchDeclinedBy: []
        });
    } catch (_) { /* best-effort */ }
    if (reason === 'timeout') {
        try { showToast('Restart proposal timed out', { icon: '⌛', key: 'proposal-timeout' }); } catch (_) {}
    }
}

/**
 * Reset the rematch coordination state on the room doc after a decline,
 * so the option to propose another rematch isn't permanently nuked.
 * Debounced so we don't write multiple times if renderRematchUI fires
 * back-to-back (snapshot replay).
 */
let _rematchClearTimer = null;
function clearRematchStateSoon() {
    if (_rematchClearTimer) return;
    _rematchClearTimer = setTimeout(async () => {
        _rematchClearTimer = null;
        if (!state.roomCode || !state.user) return;
        // Only any one client needs to write - pick the proposer since
        // they're the one who created the state. If they've left,
        // anyone may clear it.
        const r = state.roomData || {};
        if (!r.rematchProposedBy) return;
        try {
            await updateDoc(doc(db, 'triviaRooms', state.roomCode), {
                rematchProposedBy: null,
                rematchAcceptedBy: [],
                rematchDeclinedBy: []
            });
        } catch (_) { /* best-effort */ }
    }, 2500);
}

async function respondToRematch(accept) {
    if (!state.roomCode || !state.roomData || !state.user) return;
    if (!state.roomData.rematchProposedBy) return;
    if (meHasAcceptedRematch() || meHasDeclinedRematch()) return;
    const myUid = state.user.uid;
    try {
        await runTransaction(db, async (tx) => {
            const ref = doc(db, 'triviaRooms', state.roomCode);
            const snap = await tx.get(ref);
            if (!snap.exists()) return;
            const data = snap.data() || {};
            const accepted = Array.isArray(data.rematchAcceptedBy) ? data.rematchAcceptedBy.slice() : [];
            const declined = Array.isArray(data.rematchDeclinedBy) ? data.rematchDeclinedBy.slice() : [];
            if (accepted.includes(myUid) || declined.includes(myUid)) return;
            if (accept) accepted.push(myUid);
            else declined.push(myUid);
            tx.update(ref, {
                rematchAcceptedBy: accepted,
                rematchDeclinedBy: declined
            });
        });
    } catch (err) {
        console.warn('respondToRematch failed:', err);
    }
}

async function playAgain() {
    if (!state.roomCode || !state.roomData) return;
    if (!(state.user && state.roomData.hostUid === state.user.uid)) return;
    // Re-entry guard: once playAgain starts writing, the rematch state on
    // the room doc will be cleared. Without this flag, the renderEndStage
    // re-render between the read and the write could fire playAgain twice.
    if (state.rematchInFlight) return;
    state.rematchInFlight = true;
    const nextRound = (state.roomData.round || 1) + 1;
    const isGlobeDrop = state.roomData.gameType === 'globe-drop';

    try {
        if (isGlobeDrop) {
            // Re-fetch fresh locations using the same round type the room
            // was created with - host can't switch round types mid-replay,
            // that's a fresh-room move.
            const fetched = await GlobeDropLocations.fetchLocations(
                state.roomData.roundType || 'capitals',
                state.roomData.totalQuestions,
                shuffle
            );
            // Same difficulty ramp as createRoom / settings-change: stamp
            // multipliers and sort ascending so a rematch also plays easy
            // to hard. Without this, rematches got the variety picker's
            // lap order (the ladder restarts mid-game: 1, 1.5, 2, 3, 1).
            const locations = applyRoundMultipliers(fetched, state.roomData.roundType || 'capitals');
            // One-click rematch: write 'playing' directly with the first
            // location armed, so the host doesn't have to click Start
            // again. The intermediate 'lobby' status used to flash here;
            // now we jump straight to the first question.
            const firstLoc = locations[0];
            await updateDoc(doc(db, 'triviaRooms', state.roomCode), {
                status: firstLoc ? 'playing' : 'lobby',
                currentQuestionIndex: 0,
                currentQuestionId: firstLoc ? firstLoc.id : null,
                questionStartedAt: firstLoc ? serverTimestamp() : null,
                revealStartedAt: null,
                playedQuestionIds: [],
                questions: locations,
                totalQuestions: locations.length,
                round: nextRound,
                finishedAt: null,
                finalRanking: null,
                rematchProposedBy: null,
                rematchAcceptedBy: [],
                rematchDeclinedBy: []
            });
        } else {
            // Trivia: re-deal questions using the same source + reset picker.
            // Old rooms may have `packId: 'default'` from before this commit
            // removed the offline pack - coerce those to 'live'.
            const sourcePackId = state.roomData.packId === 'custom' ? 'custom' : 'live';
            const { questions, packId, packName } = await buildQuestionsForRound(
                sourcePackId,
                state.roomData.totalQuestions
            );
        // Rebuild player order fresh (same defensive fetch as startGame so a
        // stale state.roomPlayers can't compress the rotation to just the host).
        const playersSnap = await getDocs(collection(db, 'triviaRooms', state.roomCode, 'players'));
        const playerOrder = sortPlayersForRotation(playersSnap.docs.map((d) => d.data()))
            .map((p) => p.uid)
            .filter((uid) => typeof uid === 'string' && uid.length > 0);
        const deciderUid = RoomState.pickDecider(playerOrder, 0);

        await updateDoc(doc(db, 'triviaRooms', state.roomCode), {
            status: 'picking',
            currentQuestionIndex: 0,
            currentQuestionId: null,
            selectedCategory: null,
            questionStartedAt: null,
            revealStartedAt: null,
            pickingStartedAt: serverTimestamp(),
            playedQuestionIds: [],
            playerOrder,
            deciderUid,
            questions,
            packId,
            packName,
            round: nextRound,
            finishedAt: null,
            finalRanking: null,
            rematchProposedBy: null,
            rematchAcceptedBy: [],
            rematchDeclinedBy: []
        });
        }

        state.currentAnswers = [];
        endStageWrittenForRoom = null;
    } catch (err) {
        console.warn('Play again failed:', err);
        alert(
            (isGlobeDrop ? 'Could not refresh locations: ' : 'Could not refresh questions: ')
            + (err && err.message ? err.message : 'unknown error')
            + '. Try again in a moment.'
        );
    } finally {
        state.rematchInFlight = false;
    }
}

/* =====================================================================
 * Leaderboard
 * ===================================================================== */

function startLeaderboardListener() {
    stopLeaderboardListener();
    const lbRef = collection(db, 'triviaLeaderboard');
    const q = query(lbRef, orderBy('xp', 'desc'), limit(50));
    state.leaderboardUnsub = onSnapshot(q, (snap) => {
        state.leaderboardEntries = snap.docs.map((d) => d.data());
        renderLeaderboardEntries();
        // If the H2H tab is open the same snapshot needs to repopulate
        // its dropdowns; cheap to call unconditionally since the
        // function returns early when the panel isn't in the DOM.
        if (state.activeView === 'h2h') renderH2HPickers();
    }, (err) => {
        console.warn('Leaderboard listener error:', err);
    });
    // Daily Globe Drop top 10 - fresh subscription per leaderboard open
    // so the date is always today's, and so we drop the listener for an
    // old date when the user comes back tomorrow.
    startDailyLeaderboardListener();
}

function stopLeaderboardListener() {
    if (state.leaderboardUnsub) {
        try { state.leaderboardUnsub(); } catch (e) {}
        state.leaderboardUnsub = null;
    }
    stopDailyLeaderboardListener();
}

function startDailyLeaderboardListener() {
    stopDailyLeaderboardListener();
    const dateKey = GlobeDropDaily.dailyDateKey(Date.now());
    setText($('#leaderboard-daily-date'), dateKey);
    const ref = collection(db, 'globeDropDailyLeaderboard', dateKey, 'scores');
    const q = query(ref, orderBy('score', 'desc'), limit(10));
    state.dailyLeaderboardUnsub = onSnapshot(q, (snap) => {
        state.dailyLeaderboardEntries = snap.docs.map((d) => d.data());
        renderDailyLeaderboardEntries();
    }, (err) => {
        console.warn('Daily leaderboard listener error:', err);
        state.dailyLeaderboardEntries = [];
        renderDailyLeaderboardEntries();
    });
}

function stopDailyLeaderboardListener() {
    if (state.dailyLeaderboardUnsub) {
        try { state.dailyLeaderboardUnsub(); } catch (e) {}
        state.dailyLeaderboardUnsub = null;
    }
}

function renderDailyLeaderboardEntries() {
    const entries = state.dailyLeaderboardEntries || [];
    const body = $('#leaderboard-daily-body');
    const empty = $('#leaderboard-daily-empty');
    body.innerHTML = '';
    if (!entries.length) {
        empty.hidden = false;
        return;
    }
    empty.hidden = true;
    entries.forEach((e, i) => {
        const tr = document.createElement('tr');
        if (state.user && e.uid === state.user.uid) tr.classList.add('is-me');
        const roundLabel = (GlobeDropLocations.ROUND_TYPES[e.roundType] || GlobeDropLocations.ROUND_TYPES.capitals).label;
        const diffLabel = GlobeDropScoring.difficultySettings(e.difficulty).label;
        tr.innerHTML =
            `<td>${i + 1}</td>` +
            `<td>${escapeHtml(e.displayName || 'Player')}</td>` +
            `<td class="col-xp">${e.score || 0}</td>` +
            `<td>${escapeHtml(roundLabel)}</td>` +
            `<td>${escapeHtml(diffLabel)}</td>` +
            `<td>${e.locations || 0}</td>`;
        body.appendChild(tr);
    });
}

function renderLeaderboardEntries() {
    const periodFilter = $('#leaderboard-period').value;
    const entries = state.leaderboardEntries.filter((e) => {
        if (periodFilter === 'all') return true;
        const lastPlayed = e.lastPlayedAt && e.lastPlayedAt.toMillis ? e.lastPlayedAt.toMillis() : 0;
        if (!lastPlayed) return false;
        const cutoff = periodFilter === 'week' ? 7 : 30;
        return (Date.now() - lastPlayed) <= cutoff * 24 * 60 * 60 * 1000;
    });

    // Decorate each entry with the derived columns we display, so the
    // sort layer can pull them from a single source of truth.
    const decorated = entries.map((e) => {
        const games = e.gamesPlayed || 0;
        const wins  = e.wins || 0;
        const avg   = games > 0 ? Math.round((e.xp || 0) / games) : 0;
        const pct   = games > 0 ? Math.round(100 * wins / games) : 0;
        const last  = e.lastPlayedAt && e.lastPlayedAt.toMillis ? e.lastPlayedAt.toMillis() : 0;
        return Object.assign({}, e, {
            avgScore: avg,
            winPct:   pct,
            lastPlayedMs: last
        });
    });

    // Sort state lives on app state so it survives snapshot re-renders.
    const sort = state.leaderboardSort || { key: 'avgScore', dir: 'desc' };
    decorated.sort((a, b) => compareForSort(a, b, sort));

    const body = $('#leaderboard-body');
    body.innerHTML = '';
    if (!decorated.length) {
        $('#leaderboard-empty').hidden = false;
        return;
    }
    $('#leaderboard-empty').hidden = true;

    // Paint the active-sort indicator on the matching <th>.
    decorateLeaderboardHeaders(sort);

    const showAdmin = !!state.isLeaderboardAdmin;
    decorated.forEach((e, i) => {
        const tr = document.createElement('tr');
        if (state.user && e.uid === state.user.uid) tr.classList.add('is-me');
        const lastStr = e.lastPlayedMs ? formatRelativeDate(new Date(e.lastPlayedMs)) : '…';
        const adminCell = showAdmin
            ? `<td class="col-admin"><button type="button" class="btn-icon-danger" data-action="remove-leaderboard" data-uid="${escapeHtml(e.uid)}" data-name="${escapeHtml(e.displayName || 'Player')}" title="Remove from leaderboard">✕</button></td>`
            : '';
        tr.innerHTML =
            `<td>${i + 1}</td>` +
            `<td>${escapeHtml(e.displayName || 'Player')}</td>` +
            `<td class="col-xp">${e.avgScore.toLocaleString()}</td>` +
            `<td class="col-best">${(e.bestRoundScore || 0).toLocaleString()}</td>` +
            `<td class="col-bullseyes">${e.lifetimeBullseyes || 0}</td>` +
            `<td class="col-games">${e.gamesPlayed || 0}</td>` +
            `<td class="col-wins">${e.wins || 0}</td>` +
            `<td class="col-winpct">${e.winPct}%</td>` +
            `<td>${escapeHtml(lastStr)}</td>` +
            adminCell;
        body.appendChild(tr);
    });

    // Show / hide the admin column header so the row counts still align.
    const adminHeader = $('#leaderboard-admin-th');
    if (adminHeader) adminHeader.hidden = !showAdmin;
}

/**
 * Stable comparator for leaderboard rows. Keys that are strings sort
 * alphabetically (case-insensitive); everything else sorts numerically.
 * Missing values sink to the bottom regardless of direction so an empty
 * column doesn't pollute the top of the table.
 */
function compareForSort(a, b, sort) {
    const key = sort.key;
    const dir = sort.dir === 'asc' ? 1 : -1;
    const va = a[key];
    const vb = b[key];
    const aMissing = va == null || va === '';
    const bMissing = vb == null || vb === '';
    if (aMissing && bMissing) return 0;
    if (aMissing) return 1;     // always sink missing
    if (bMissing) return -1;
    if (typeof va === 'string' && typeof vb === 'string') {
        return dir * va.localeCompare(vb, undefined, { sensitivity: 'base' });
    }
    return dir * ((Number(va) || 0) - (Number(vb) || 0));
}

/**
 * Paint the asc/desc arrow on whichever <th> matches the active sort
 * and strip it from every other header so the state reads at a glance.
 */
function decorateLeaderboardHeaders(sort) {
    const ths = document.querySelectorAll('#leaderboard-table thead th[data-sort-key]');
    ths.forEach((th) => {
        const key = th.getAttribute('data-sort-key');
        const isActive = key === sort.key;
        th.classList.toggle('is-sorted', isActive);
        th.classList.toggle('is-asc', isActive && sort.dir === 'asc');
        th.classList.toggle('is-desc', isActive && sort.dir === 'desc');
    });
}

function bindLeaderboardSortHandlers() {
    const head = document.querySelector('#leaderboard-table thead');
    if (!head || head.dataset.sortBound === '1') return;
    head.dataset.sortBound = '1';
    head.addEventListener('click', (ev) => {
        const th = ev.target.closest('th[data-sort-key]');
        if (!th) return;
        const key = th.getAttribute('data-sort-key');
        const defaultDir = th.getAttribute('data-sort-default') || 'desc';
        if (state.leaderboardSort.key === key) {
            // Same column: toggle direction.
            state.leaderboardSort = {
                key,
                dir: state.leaderboardSort.dir === 'asc' ? 'desc' : 'asc'
            };
        } else {
            state.leaderboardSort = { key, dir: defaultDir };
        }
        renderLeaderboardEntries();
    });
}

async function checkLeaderboardAdmin(uid) {
    if (!uid) { state.isLeaderboardAdmin = false; return; }
    try {
        const snap = await getDoc(doc(db, 'leaderboardAdmins', uid));
        state.isLeaderboardAdmin = snap.exists();
        if (state.isLeaderboardAdmin) renderLeaderboardEntries();
    } catch (err) {
        state.isLeaderboardAdmin = false;
    }
}

async function removeLeaderboardEntry(uid, name) {
    if (!state.isLeaderboardAdmin) return;
    if (!uid) return;
    const ok = await openConfirmModal({
        title: `Remove "${name}"?`,
        body: 'This deletes their row from the global leaderboard only. Their score and profile stay intact, and the row reappears the next time they play a game.',
        confirmLabel: 'Remove row',
        danger: true
    });
    if (!ok) return;
    try {
        await deleteDoc(doc(db, 'triviaLeaderboard', uid));
        showToast(`Removed ${name} from leaderboard.`, { icon: '🗑️' });
    } catch (err) {
        console.warn('removeLeaderboardEntry failed:', err);
        showToast('Could not remove. Check that your uid is in /leaderboardAdmins/.', { icon: '⚠️' });
    }
}

function formatRelativeDate(d) {
    const diff = Date.now() - d.getTime();
    const day = 24 * 60 * 60 * 1000;
    if (diff < day) return 'today';
    if (diff < 2 * day) return 'yesterday';
    if (diff < 7 * day) return Math.floor(diff / day) + 'd ago';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/* =====================================================================
 * H2H comparison view
 *
 * Reuses state.leaderboardEntries (already subscribed when the LB or H2H
 * view is active). Both dropdowns list every entry; picking two of the
 * same player just shows their card on both sides - harmless.
 * ===================================================================== */

let h2hPickerVersion = 0;

function renderH2HPickers() {
    const a = $('#h2h-select-a');
    const b = $('#h2h-select-b');
    if (!a || !b) return;
    const entries = (state.leaderboardEntries || []).slice();
    if (!entries.length) {
        a.innerHTML = '<option value="">No players yet</option>';
        b.innerHTML = '<option value="">No players yet</option>';
        renderH2HComparison();
        return;
    }
    const optsHtml = entries.map((e) => {
        const uid = escapeHtml(e.uid || '');
        const name = escapeHtml(e.displayName || 'Player');
        const score = e.xp || 0;
        return `<option value="${uid}">${name} · ${score} pts</option>`;
    }).join('');

    // Preserve current selections across re-renders (LB snapshot can
    // refire while the H2H tab is open).
    const prevA = a.value;
    const prevB = b.value;

    a.innerHTML = optsHtml;
    b.innerHTML = optsHtml;

    // Default: A = current user (if present), B = next entry. Otherwise
    // first / second by total score.
    const meUid = state.user && state.user.uid;
    const meIdx = entries.findIndex((e) => e.uid === meUid);
    const aDefault = (meIdx >= 0 ? meUid : entries[0].uid) || '';
    const bDefault = entries.find((e) => e.uid !== aDefault)?.uid || aDefault;
    a.value = prevA && entries.some((e) => e.uid === prevA) ? prevA : aDefault;
    b.value = prevB && entries.some((e) => e.uid === prevB) ? prevB : bDefault;

    h2hPickerVersion++;
    renderH2HComparison();
}

let h2hPairFetchToken = 0;
async function renderH2HComparison() {
    const a = $('#h2h-select-a');
    const b = $('#h2h-select-b');
    if (!a || !b) return;
    const entries = state.leaderboardEntries || [];
    const ea = entries.find((e) => e.uid === a.value);
    const eb = entries.find((e) => e.uid === b.value);
    const empty = $('#h2h-empty');
    const result = $('#h2h-result');
    if (!ea || !eb || ea.uid === eb.uid) {
        if (empty) empty.hidden = false;
        if (result) result.hidden = true;
        return;
    }
    if (empty) empty.hidden = true;
    if (result) result.hidden = false;
    setText($('#h2h-name-a'), ea.displayName || 'Player');
    setText($('#h2h-name-b'), eb.displayName || 'Player');
    // Optimistic placeholder so the panel doesn't jump between empty
    // and populated states while we fetch the pair doc.
    $('#h2h-stats-a').innerHTML = '<dt>Loading…</dt><dd>—</dd>';
    $('#h2h-stats-b').innerHTML = '<dt>Loading…</dt><dd>—</dd>';

    const key = h2hPairKey(ea.uid, eb.uid);
    const token = ++h2hPairFetchToken;
    let pair = null;
    if (key) {
        try {
            const snap = await getDoc(doc(db, 'triviaH2H', key));
            if (snap.exists()) pair = snap.data();
        } catch (_) { /* network / rules - fall back to no-pair view */ }
    }
    if (token !== h2hPairFetchToken) return; // raced

    $('#h2h-stats-a').innerHTML = renderH2HStatsHtml(ea, eb, pair);
    $('#h2h-stats-b').innerHTML = renderH2HStatsHtml(eb, ea, pair);

    // Lifetime W-D-L pill. Pulls wins from the pair doc and labels
    // whichever side is ahead with the gold leader treatment.
    const pillEl = $('#h2h-record-pill');
    if (pillEl) {
        const a = pairStatsFor(ea, eb, pair);
        const b = pairStatsFor(eb, ea, pair);
        const total = a.wins + b.wins + a.ties;
        const elA = $('#h2h-record-a');
        const elB = $('#h2h-record-b');
        if (elA) { elA.textContent = String(a.wins); elA.className = 'h2h-record-num' + (a.wins > b.wins ? ' is-lead' : (a.wins < b.wins ? ' is-trail' : '')); }
        if (elB) { elB.textContent = String(b.wins); elB.className = 'h2h-record-num' + (b.wins > a.wins ? ' is-lead' : (b.wins < a.wins ? ' is-trail' : '')); }
        const subEl = $('#h2h-record-sub');
        if (subEl) {
            if (total === 0) subEl.textContent = 'No matches yet';
            else if (a.ties > 0) subEl.textContent = `${total} matches · ${a.ties} tied`;
            else subEl.textContent = `${total} ${total === 1 ? 'match' : 'matches'}`;
        }
        pillEl.hidden = false;
    }
}

function pairStatsFor(self, other, pair) {
    if (!pair) return { wins: 0, losses: 0, ties: 0, gamesPlayed: 0 };
    // pair is keyed by sorted (uidA, uidB). Figure out which side `self` is.
    const selfIsA = pair.uidA === self.uid;
    const wins = selfIsA ? (pair.winsA || 0) : (pair.winsB || 0);
    const losses = selfIsA ? (pair.winsB || 0) : (pair.winsA || 0);
    const ties = pair.ties || 0;
    return { wins, losses, ties, gamesPlayed: pair.gamesPlayed || 0 };
}

function renderH2HStatsHtml(self, other, pair) {
    // Pairwise stats first (the headline), with global lifetime score
    // as context below. cmp > 0 highlights self leading vs other for
    // the colour cue.
    const sp = pairStatsFor(self, other, pair);
    const op = pairStatsFor(other, self, pair);
    const fields = [
        { label: 'Matches',     val: sp.gamesPlayed,            cmp: 0 },
        { label: 'Wins',        val: sp.wins,                   cmp: sp.wins - op.wins },
        { label: 'Losses',      val: sp.losses,                 cmp: op.wins - sp.wins },
        { label: 'Ties',        val: sp.ties,                   cmp: 0 },
        { label: 'Total score', val: self.xp || 0,              cmp: (self.xp || 0) - (other.xp || 0) }
    ];
    return fields.map((f) => {
        const cls = f.cmp > 0 ? ' h2h-lead' : (f.cmp < 0 ? ' h2h-trail' : '');
        return `<dt>${escapeHtml(f.label)}</dt><dd class="h2h-val${cls}">${escapeHtml(String(f.val))}</dd>`;
    }).join('');
}

function wireH2H() {
    const a = $('#h2h-select-a');
    const b = $('#h2h-select-b');
    if (a) a.addEventListener('change', renderH2HComparison);
    if (b) b.addEventListener('change', renderH2HComparison);
}

function wireLeaderboard() {
    $('#leaderboard-period').addEventListener('change', renderLeaderboardEntries);
    bindLeaderboardSortHandlers();
    // Admin: delete-row clicks. Delegated to the leaderboard body so we
    // don't have to re-bind on every render.
    const body = $('#leaderboard-body');
    if (body) {
        body.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-action="remove-leaderboard"]');
            if (!btn) return;
            removeLeaderboardEntry(btn.dataset.uid, btn.dataset.name);
        });
    }
}

/* =====================================================================
 * Boot
 * ===================================================================== */

async function boot() {
    installFirestoreNoiseGuard();

    wireViewTabs();
    wireLobby();
    wireProfileView();
    wireCustomPack();
    wireLeaderboard();
    wireH2H();
    wireChat();
    wireConfirmModal();
    wireNamePrompt();
    renderPackOptions();

    // Read tab + queued room from the URL BEFORE auth wires up, so a
    // signed-in tab refresh restores both without flicker.
    await restoreFromUrl();

    await waitForFirebaseAuth();
    window.firebaseAuth.onAuthStateChange(applyAuthState);
    // Initial state - onAuthStateChange fires synchronously if ready.
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
} else {
    boot();
}
