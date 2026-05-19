/*
 * Brain Arena — main app module.
 *
 * Wiring:
 *   - Auth: window.firebaseAuth (set up by ../../firebase-config.js, loaded
 *     as a module earlier in the page; we wait on its ready promise).
 *   - Firestore: import the SDK directly from the gstatic CDN. The db
 *     instance is already initialized inside firebase-config.js — we import
 *     `db` from there so we don't initialize a second app.
 *   - Pure helpers: window.BrainArena.{Config,Scoring,RoomState} from the
 *     three classic scripts loaded above this module.
 *
 * Firestore data model:
 *   triviaRooms/{code}
 *     { code, hostUid, status: 'lobby'|'playing'|'finished',
 *       isPrivate, password (only when private), currentQuestionIndex,
 *       questionStartedAt: serverTimestamp, totalQuestions, packId,
 *       questions: [...{id,category,question,choices,correctIndex}],
 *       createdAt, finishedAt }
 *   triviaRooms/{code}/players/{uid}
 *     { uid, displayName, isHost, score, streak, joinedAt,
 *       currentAnswerIndex, currentAnswerAt, lastSeen,
 *       answers: [{questionId, correct, timeLeftMs, totalMs, category, points}] }
 *
 *   users/{uid}.triviaProfile
 *     { displayName, xp, gamesPlayed, wins, premium, signedUpAt,
 *       premiumPaidAt, stripeCheckoutSessionId, lastPlayedAt }
 *
 *   Premium gating rule:
 *     isPremium = (premium === true)  OR  (now < signedUpAt + 30 days)
 *   The webhook at /.netlify/functions/stripe-webhook flips `premium=true`
 *   after a successful Stripe Checkout for the one-time $5 fee.
 *
 *   triviaLeaderboard/{uid}  (denormalized for cheap reads)
 *     { uid, displayName, xp, gamesPlayed, wins, lastPlayedAt }
 */

// All Firestore SDK access flows through firebase-config.js (the single
// init point) so we don't import the SDK URL directly here — the
// `no app file imports Firestore directly` invariant test forbids it.
// Path: this file is /apps/brain-arena/js/app.js, so we go up three
// directories (js → brain-arena → apps → repo root).
import { db, firestore } from '../../../firebase-config.js';
const {
    doc, collection, getDoc, getDocs, setDoc, updateDoc, deleteDoc, addDoc,
    onSnapshot, query, orderBy, limit, serverTimestamp, runTransaction,
    increment, deleteField
} = firestore;

const Config = window.BrainArena.Config;
const Scoring = window.BrainArena.Scoring;
const Premium = window.BrainArena.Premium;
const Feedback = window.BrainArena.Feedback;
const Chat = window.BrainArena.Chat;
const RoomState = window.BrainArena.RoomState;
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
    customPack: null,            // user's saved custom pack (premium)

    // Room state
    roomCode: null,              // current room code, if any
    roomData: null,              // latest room doc snapshot
    roomPlayers: [],             // latest player list
    roomUnsubs: [],              // listener unsubs to clean up on leave

    // Answer tracking
    submittedQuestionId: null,   // id of question we last answered
    currentAnswers: [],          // local detailed-stats record for this game

    // Host-side guard so the early-reveal write fires exactly once per
    // question (not once per rAF frame between write and snapshot ack).
    earlyRevealForQuestion: null,

    // Lobby — which game type the create-card is currently configured for.
    // Defaults to globe-drop because it's the headline mode now.
    selectedGameType: 'globe-drop',

    // GlobeDrop-specific runtime state (only populated while a GlobeDrop room
    // is active). globe = globe.gl/Three.js scene wrapper; we don't keep
    // per-marker handles because globe.gl is declarative — call
    // pointsData()/arcsData() with the full set on every update.
    globe: null,
    pendingGuess: null,                  // { lat, lng } selected but not yet submitted
    lastRenderedMapQuestion: null,       // location id currently shown on the globe
    lastRevealedMapQuestion: null,       // '{locId}:local' or '{locId}:global' — what we've drawn
    triviaFetchedFor: null,              // location id we've already kicked off a Wikipedia fetch for

    // Timer rAF handle
    timerRaf: null,

    // Leaderboard
    leaderboardEntries: [],
    leaderboardUnsub: null,

    // Daily Globe Drop leaderboard — same panel, separate subscription
    // because it lives in its own collection and resets at UTC midnight.
    dailyLeaderboardEntries: [],
    dailyLeaderboardUnsub: null,

    // Live listener on users/{uid} so the Stripe webhook's flip of
    // triviaProfile.premium (server-side via Admin SDK) propagates to
    // the UI without a reload.
    profileUnsub: null,

    // Room code parsed from `?room=ABCDE` at boot, queued behind sign-in.
    // applyAuthState picks it up the first time it sees a signed-in user.
    pendingRoomCode: null,

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

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = String(text == null ? '' : text);
    return div.innerHTML;
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
    if (r) r(!!result);
}
function wireConfirmModal() {
    const modal = document.getElementById('confirm-modal');
    if (!modal) return;
    modal.addEventListener('click', (e) => {
        // .closest() — clicks on the SVG/path INSIDE the X button bubble
        // as e.target=<path|svg>, which would never match [data-confirm-close]
        // on the button directly via .matches().
        if (e.target.closest('[data-confirm-close]')) closeConfirmModal(false);
    });
    document.getElementById('confirm-modal-cancel').addEventListener('click', () => closeConfirmModal(false));
    document.getElementById('confirm-modal-confirm').addEventListener('click', () => closeConfirmModal(true));
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !modal.hasAttribute('hidden')) closeConfirmModal(false);
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
 * is treated as a join attempt — gates apply normally (sign-in, password).
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
        return {
            view: VALID_VIEWS.has(view) ? view : null,
            room: (typeof room === 'string' && /^[A-Z0-9]{3,8}$/.test(room.toUpperCase())) ? room.toUpperCase() : null
        };
    } catch (e) {
        return { view: null, room: null };
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
        if (state.roomCode) {
            url.searchParams.set('room', state.roomCode);
        } else {
            url.searchParams.delete('room');
        }
        const next = url.pathname + (url.search ? url.search : '') + url.hash;
        // No-op when URL is already in sync — avoids redundant history
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
    const { view, room } = parseUrlState();
    if (view && view !== state.activeView) setView(view);
    if (!room) return;
    // Stash the desired room on state; applyAuthState picks it up the
    // first time we see a signed-in user. That way a refresh of
    // /?room=ABCDE on a signed-out tab queues the rejoin behind the
    // sign-in flow instead of failing immediately.
    state.pendingRoomCode = room;
}

async function tryRejoinPendingRoom() {
    const code = state.pendingRoomCode;
    if (!code || !state.user) return;
    if (state.roomCode === code) { state.pendingRoomCode = null; return; }
    state.pendingRoomCode = null;
    // Indicate to the UI that we're resolving a room from the URL. We hold
    // off any "finished / missing room" verdict until after both the room
    // doc AND the player-membership doc have actually returned from
    // Firestore — that was the race that caused "That room has already
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
            // Member rejoin — works for any status. Finished rooms render
            // the end stage, lobby/picking/playing render the matching
            // stage. Either way, no error.
            clearJoinError();
            try { await updateDoc(playerRef, { lastSeen: serverTimestamp() }); } catch (_) {}
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

async function loadProfile(uid) {
    const ref = doc(db, 'users', uid);
    try {
        const snap = await getDoc(ref);
        const data = snap.exists() ? snap.data() : {};
        const tp = data.triviaProfile || null;
        if (tp) {
            // Backfill signedUpAt for accounts created before the trial
            // tier existed. Without it Premium.isInTrial returns false
            // even for brand-new users who just happen to predate this
            // field, which would feel like a regression. We stamp it
            // server-side once and let the snapshot listener pick it up.
            if (!tp.signedUpAt) {
                await updateDoc(ref, { 'triviaProfile.signedUpAt': serverTimestamp() });
                // Local placeholder until the server stamp lands — the
                // listener will overwrite this with the real Timestamp.
                tp.signedUpAt = Date.now();
            }
            return tp;
        }
        // Seed a minimal profile on first run.
        const seeded = {
            displayName: deriveInitialDisplayName(),
            xp: 0,
            gamesPlayed: 0,
            wins: 0,
            premium: false,
            signedUpAt: serverTimestamp(),
            lastPlayedAt: null
        };
        await setDoc(ref, { triviaProfile: seeded }, { merge: true });
        // serverTimestamp() resolves on the server — surface a usable
        // local value for the first render. The snapshot listener will
        // replace it with the canonical Timestamp object.
        return { ...seeded, signedUpAt: Date.now() };
    } catch (err) {
        console.warn('Could not load trivia profile:', err);
        return null;
    }
}

function deriveInitialDisplayName() {
    const email = state.user?.email || '';
    if (email) return email.split('@')[0].slice(0, Config.MAX_DISPLAY_NAME);
    return 'Player';
}

async function saveProfileField(patch) {
    if (!state.user) return;
    const ref = doc(db, 'users', state.user.uid);
    const updates = {};
    for (const [k, v] of Object.entries(patch)) updates[`triviaProfile.${k}`] = v;
    await updateDoc(ref, updates);
    Object.assign(state.profile, patch);
}

function applyAuthState(user) {
    state.user = user || null;
    const signedIn = !!user;
    setClass($('#auth-gate'), 'is-hidden', signedIn);
    if (state.user) $('#auth-gate').hidden = true;
    else $('#auth-gate').hidden = false;

    // Invite-link landing: if a signed-out user arrived via an
    // /?room=ABCDE link, open the sign-in modal automatically so they
    // can join without hunting for it. pendingRoomCode is kept; once
    // they finish auth, applyAuthState fires again with signedIn=true
    // and tryRejoinPendingRoom takes them straight to the room.
    if (!signedIn && state.pendingRoomCode && !state.inviteSignInPrompted) {
        state.inviteSignInPrompted = true;
        openSignInPrompt();
    }

    // Profile view toggles
    setClass($('#profile-signed-out'), 'is-hidden', signedIn);
    $('#profile-signed-out').hidden = signedIn;
    $('#profile-card-trivia').hidden = !signedIn;

    // Stop watching the previous user's doc (if any) before swapping.
    if (state.profileUnsub) {
        try { state.profileUnsub(); } catch (_) { /* ignore */ }
        state.profileUnsub = null;
    }

    if (signedIn) {
        // If we landed on /?room=ABCDE before sign-in, the rejoin was
        // queued behind auth — kick it off now. Runs in parallel with
        // loadProfile since the two don't depend on each other.
        if (state.pendingRoomCode) tryRejoinPendingRoom();
        // Admin probe — presence of a doc at /leaderboardAdmins/{uid}
        // turns on the trash-icon affordance on leaderboard rows.
        checkLeaderboardAdmin(user.uid);
        loadProfile(user.uid).then((p) => {
            state.profile = p;
            renderProfileView();
            renderPremiumGates();
            state.customPack = (p && p.customPack) ? p.customPack : null;
            // Live-subscribe so the Stripe webhook's flip of triviaProfile.premium
            // (server-side via Admin SDK) and trial-time updates surface without
            // a page reload.
            state.profileUnsub = onSnapshot(doc(db, 'users', user.uid), (snap) => {
                const data = snap.exists() ? snap.data() : {};
                const tp = data.triviaProfile;
                if (!tp) return;
                state.profile = tp;
                state.customPack = tp.customPack || null;
                renderProfileView();
                renderPremiumGates();
            }, (err) => {
                console.warn('Profile snapshot listener error:', err);
            });
        });
    } else {
        state.profile = null;
        state.customPack = null;
        renderPremiumGates();
        if (state.roomCode) leaveRoom({ silent: true });
    }
}

/* =====================================================================
 * Profile view
 * ===================================================================== */

function renderProfileView() {
    if (!state.user) return;
    setText($('#profile-email'), state.user.email || '');
    const p = state.profile || {};
    const name = p.displayName || deriveInitialDisplayName();
    const input = $('#profile-display-name');
    if (input && document.activeElement !== input) input.value = name;
    setText($('#profile-avatar'), avatarLetter(name));
    setText($('#stat-xp'), String(p.xp || 0));
    setText($('#stat-games'), String(p.gamesPlayed || 0));
    setText($('#stat-wins'), String(p.wins || 0));
    const pct = p.gamesPlayed ? Math.round(100 * (p.wins || 0) / p.gamesPlayed) : 0;
    setText($('#stat-winpct'), pct + '%');

    if (Config.PREMIUM_UI_ENABLED) {
        const now = Date.now();
        const paid = Premium.isPaidPremium(p);
        const inTrial = Premium.isInTrial(p, now);

        const premiumCard = $('#profile-premium-card');
        setClass(premiumCard, 'is-premium', paid);
        setClass(premiumCard, 'is-trial', !paid && inTrial);
        setText($('#profile-premium-status'), Premium.premiumStatusText(p, now));

        const upgradeBtn = $('#upgrade-premium-btn');
        if (upgradeBtn) upgradeBtn.hidden = paid;

        renderAdminControls(p);
    }

    renderCustomPackTextarea();
}

function renderAdminControls(profile) {
    const wrap = $('#profile-admin-controls');
    if (!wrap) return;
    const show = state.user && Premium.isAdmin(state.user.uid);
    wrap.hidden = !show;
    if (!show) return;
    const togglePaidBtn = $('#admin-toggle-paid-btn');
    if (togglePaidBtn) {
        togglePaidBtn.textContent = profile && profile.premium ? 'Remove paid premium' : 'Grant paid premium';
    }
}

function wireProfileView() {
    $('#profile-display-name').addEventListener('change', async (e) => {
        const v = String(e.target.value || '').trim().slice(0, Config.MAX_DISPLAY_NAME);
        if (!v) return;
        await saveProfileField({ displayName: v });
        await propagateDisplayName(v);
        renderProfileView();
        renderLeaderboardEntries();
    });
    if (Config.PREMIUM_UI_ENABLED) {
        $('#upgrade-premium-btn').addEventListener('click', openPremiumModal);
    }
}

/**
 * Push a new display name to every place we've denormalized it:
 *   - the active room's player doc (so the mini-board updates)
 *   - the global leaderboard doc (so other tabs see the new name)
 * Errors are swallowed — best-effort UX, the source of truth is the
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
 * Premium
 * ===================================================================== */

function isPremium() {
    // Master switch: when the premium UI is hidden site-wide, every gated
    // feature is unlocked for every signed-in user. See Config.PREMIUM_UI_ENABLED
    // and apps/brain-arena/PREMIUM_SETUP.md.
    if (!Config.PREMIUM_UI_ENABLED) return true;
    return Premium.isPremium(state.profile, Date.now());
}

function renderPremiumGates() {
    // When the premium UI is hidden, CSS pulls every `.premium-tag`,
    // `.premium-chip`, and `[data-action="open-premium"]` out of layout —
    // no per-element JS toggling required. Bail early so we don't fight
    // it with inline styles.
    if (!Config.PREMIUM_UI_ENABLED) return;
    const premium = isPremium();
    $$('.premium-tag').forEach((tag) => {
        tag.style.display = premium ? 'none' : 'inline-flex';
    });
}

function openPremiumModal() {
    // Hard-stop when the premium UI is disabled. With isPremium() always
    // true in that mode, the call sites (custom-pack save, lobby gates)
    // never trigger this — but if any future path does, fail silently
    // instead of flashing a half-styled hidden modal at the user.
    if (!Config.PREMIUM_UI_ENABLED) return;
    const modal = $('#premium-modal');
    show(modal);
    modal.removeAttribute('hidden');
}

function closePremiumModal() {
    hide($('#premium-modal'));
}

function wirePremiumModal() {
    const modal = $('#premium-modal');
    modal.addEventListener('click', (e) => {
        // Use closest() — clicks on the SVG/path inside the X button
        // surface as e.target=<path>, which would miss .modal-close.
        if (e.target.closest('[data-close="modal"], .modal-backdrop, .modal-close')) {
            closePremiumModal();
        }
    });
    $('#premium-checkout-btn').addEventListener('click', () => {
        if (!state.user) {
            // Shouldn't happen — the upgrade buttons are gated behind sign-in
            // by the auth-gate — but be defensive so we don't strand a buyer.
            return;
        }
        const url = buildCheckoutUrl(state.user.uid);
        window.open(url, '_blank', 'noopener,noreferrer');
    });
    // Any [data-action="open-premium"] anywhere opens it.
    document.addEventListener('click', (e) => {
        const trigger = e.target.closest('[data-action="open-premium"]');
        if (trigger) openPremiumModal();
    });
}

/**
 * Stripe Checkout / Payment Link URL with client_reference_id and a
 * success redirect appended. The webhook reads client_reference_id off
 * the session to identify the user; the success_url surfaces a "thanks,
 * premium unlocked" page back on shevato.com.
 *
 * Works for both Payment Links (https://buy.stripe.com/...) and full
 * Checkout sessions — both honor `client_reference_id` + `success_url`
 * as query params when appended this way.
 */
function buildCheckoutUrl(uid) {
    const base = Config.STRIPE_CHECKOUT_URL;
    const sep = base.includes('?') ? '&' : '?';
    const successUrl = new URL('success.html', window.location.href).toString();
    const params = new URLSearchParams({
        client_reference_id: uid,
        // Stripe URL-encodes nested params for us; the success page also
        // reads `?paid=1` so it can show a confirmation immediately even
        // before the webhook lands.
        prefilled_email: state.user?.email || ''
    });
    return `${base}${sep}${params.toString()}&success_url=${encodeURIComponent(successUrl + '?paid=1')}`;
}

function wireAdminControls() {
    const toggleBtn = $('#admin-toggle-paid-btn');
    const resetBtn = $('#admin-reset-trial-btn');
    if (toggleBtn) {
        toggleBtn.addEventListener('click', async () => {
            if (!state.user || !Premium.isAdmin(state.user.uid)) return;
            const next = !(state.profile && state.profile.premium);
            await saveProfileField({ premium: next });
            renderProfileView();
            renderPremiumGates();
        });
    }
    if (resetBtn) {
        resetBtn.addEventListener('click', async () => {
            if (!state.user || !Premium.isAdmin(state.user.uid)) return;
            const ref = doc(db, 'users', state.user.uid);
            await updateDoc(ref, { 'triviaProfile.signedUpAt': serverTimestamp() });
            // Snapshot listener will re-render once the server stamp lands.
        });
    }
}

/* =====================================================================
 * Question pack loading
 * ===================================================================== */

/**
 * Silence the unhandled Firestore-channel write errors that bubble when a
 * client-side privacy extension (uBlock, Brave Shields, etc.) blocks the
 * https://firestore.googleapis.com/.../Write/channel POST. Firestore retries
 * internally and keeps the app working, but the unhandled rejection lands
 * in the console as a scary "ERR_BLOCKED_BY_CLIENT" stack — and on leaveRoom
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
 * Sort a location list easiest → hardest using populationWeight as the
 * obscurity signal. Higher weight = lower population = more obscure /
 * harder. We rank ascending so each subsequent round is ≥ the previous
 * in difficulty.
 *
 * Stable sort preserves the input order for ties — important for modes
 * without population (capitals, countries, landmarks → all weight = 1)
 * so the upstream shuffle is honoured.
 */
function sortLocationsByAscendingDifficulty(locations) {
    if (!Array.isArray(locations) || locations.length < 2) {
        return Array.isArray(locations) ? locations.slice() : [];
    }
    const decorated = locations.map((loc, i) => ({
        loc,
        weight: GlobeDropScoring.populationWeight(loc && loc.population),
        idx: i
    }));
    decorated.sort((a, b) => {
        if (a.weight !== b.weight) return a.weight - b.weight;
        return a.idx - b.idx;
    });
    return decorated.map((d) => d.loc);
}

/**
 * Build the question POOL for a round. We over-provision so the per-question
 * category picker has variety: the round plays `count` questions out of a
 * pool of up to 5x that (capped at the live API's 50/request limit).
 *
 * Live source is the only built-in (no offline fallback). Premium custom
 * packs take precedence when explicitly selected. Any fetch failure bubbles
 * up — callers should catch and surface a clear error to the host.
 *
 * @param {string} packId — 'live' | 'custom'
 * @param {number} count — number of questions to be played this round
 * @returns {Promise<{questions:Array, packId:string, packName:string}>}
 */
async function buildQuestionsForRound(packId, count) {
    if (packId === 'custom' && state.customPack && isPremium()) {
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
 * Custom pack (premium)
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
        if (!state.user) { setText(msg, 'Sign in first.'); msg.classList.add('is-err'); return; }
        if (!isPremium()) {
            setText(msg, 'Custom packs are a premium feature.');
            msg.classList.add('is-err');
            openPremiumModal();
            return;
        }
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

    // Live API is the only built-in question source. Premium users with
    // a saved custom pack get a second option.
    const live = document.createElement('option');
    live.value = 'live';
    live.textContent = 'Live questions (The Trivia API)';
    sel.appendChild(live);

    if (state.customPack && isPremium()) {
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
                    el.hidden = el.dataset.gameType !== type;
                }
            });
        });
    });
}

function wireLobby() {
    wireGameTypeToggle();

    $('#create-private-toggle').addEventListener('change', (e) => {
        const wantsPrivate = e.target.checked;
        $('#create-password-field').hidden = !wantsPrivate;
    });

    // Globe Drop: difficulty drives the timer + hint level + scoring multiplier.
    // The manual "time per location" override is hidden by default; checking
    // the override toggle reveals it for hosts who want something off-tier.
    $('#create-globe-drop-difficulty').addEventListener('change', (e) => {
        const diff = GlobeDropScoring.difficultySettings(e.target.value);
        const timeSel = $('#create-globe-drop-time');
        if (timeSel) timeSel.value = String(diff.timerSec);
    });
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
    // Legacy bottom-of-recap end-stage buttons were removed — guard
    // the listeners so a future re-add Just Works.
    const endBack = $('#end-back-btn');
    if (endBack) endBack.addEventListener('click', () => leaveRoom());
    const settingsEditBtn = $('#room-settings-edit-btn');
    if (settingsEditBtn) settingsEditBtn.addEventListener('click', () => openRoomSettingsEditor());
    const settingsCancel = $('#room-settings-cancel');
    if (settingsCancel) settingsCancel.addEventListener('click', () => closeRoomSettingsEditor());
    const settingsSave = $('#room-settings-save');
    if (settingsSave) settingsSave.addEventListener('click', () => saveRoomSettings());
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
    if (!state.user) { openSignInPrompt(); return; }
    // mode = 'multi' (default) | 'solo' | 'daily'.
    // - solo: private, single-player, auto-starts as soon as the room exists
    // - daily: like solo, plus deterministic location seeding by UTC date
    //          and an end-of-game write to globeDropDailyLeaderboard
    const mode = (opts && opts.mode) || 'multi';
    const isSoloLike = mode === 'solo' || mode === 'daily';

    const gameType = isSoloLike
        ? 'globe-drop'
        : (state.selectedGameType === 'globe-drop' ? 'globe-drop' : 'trivia');

    // Solo / daily rooms are always private to keep them out of any future
    // public-room discovery. They have no password — only this user is in
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
        const displayName = (state.profile && state.profile.displayName) || deriveInitialDisplayName();
        const shared = {
            code,
            hostUid: state.user.uid,
            status: 'lobby',
            isPrivate,
            password: isPrivate ? password : '',
            gameType,
            currentQuestionIndex: 0,
            questionStartedAt: null,
            round: 1,
            createdAt: serverTimestamp(),
            finishedAt: null
        };

        if (gameType === 'globe-drop') {
            btn.innerHTML = mode === 'daily' ? "Loading today's challenge…" : 'Fetching locations…';
            const count = parseInt($('#create-locations-count').value, 10) || Config.GLOBE_DROP_LOCATIONS_DEFAULT;
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

            // Round-progression sort: order rounds easiest → hardest using
            // the existing populationWeight (higher weight = more obscure).
            // Stable sort, so for modes without population data (capitals,
            // countries, landmarks → all weight=1) the prior shuffle order
            // is preserved. Daily mode is sorted too: every player still
            // sees the same locations in the same order because the input
            // pool was seeded by date.
            locations = sortLocationsByAscendingDifficulty(locations);

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
            // The pack-select dropdown was retired — live API is the only
            // built-in source. Premium custom packs still go through
            // buildQuestionsForRound('custom', …) elsewhere; the lobby
            // doesn't expose pack choice anymore.
            const sel = 'live';
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

        await joinPlayer(code, displayName, /* isHost */ true);
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
        // built-in question/location sources — there's no offline pack to
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
    // Try a handful of times — collisions on a 31^5 space are vanishingly rare.
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
 *     field — the user will see the real error when they click Join.
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
    if (!state.user) { openSignInPrompt(); return; }
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

    if (data.isPrivate) {
        const passwordField = $('#join-password-field');
        passwordField.hidden = false;
        const password = String($('#join-password').value || '').trim();
        if (!password) {
            showJoinError('This room is private. Enter the password.');
            return;
        }
        if (password !== data.password) {
            showJoinError('Incorrect password.');
            return;
        }
    }

    // Capacity guard
    const playersSnap = await getDocs(collection(db, 'triviaRooms', code, 'players'));
    if (playersSnap.size >= Config.MAX_PLAYERS_PER_ROOM) {
        showJoinError('That room is full.');
        return;
    }

    const displayName = (state.profile && state.profile.displayName) || deriveInitialDisplayName();
    await joinPlayer(code, displayName, /* isHost */ false);
    enterRoom(code);
}

async function joinPlayer(code, displayName, isHost) {
    const pref = doc(db, 'triviaRooms', code, 'players', state.user.uid);
    // Pull the room's current round so we don't carry stale "joinedAt round 1"
    // markers into round 2+. We can't write across players, so each player
    // is responsible for keeping their own `round` field current.
    let currentRound = 1;
    try {
        const roomSnap = await getDoc(doc(db, 'triviaRooms', code));
        if (roomSnap.exists()) currentRound = roomSnap.data().round || 1;
    } catch (e) { /* fall back to 1 */ }
    await setDoc(pref, {
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
        answers: []
    }, { merge: true });
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

    // Pre-warm the 8K Earth texture as soon as we enter the room. The
    // texture is ~4.5 MB and decoding it is the single biggest chunk
    // inside Globe()(el). Browsers cache decoded bitmap data, so once
    // this <img> resolves, the later globe init reuses it instead of
    // re-fetching + re-decoding — moving most of the >200ms cost off
    // the game-start critical path.
    if (!state.earthTextureWarmed) {
        state.earthTextureWarmed = true;
        try {
            const img = new Image();
            img.decoding = 'async';
            img.src = 'data/earth-8k.jpg';
            // No need to await; the load+decode happens in the background
            // and the browser's image cache fields the second request.
        } catch (_) { /* best-effort */ }
    }

    // window.beforeunload cleanup so the player removes themselves on tab close
    window.addEventListener('beforeunload', beforeUnloadCleanup);

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
 * "answered" for the current question. No toast, no pulse banner —
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
    // Re-trigger CSS animation by cloning the node — the keyframes only
    // run on first mount, so swapping the element resets them.
    const replacement = el.cloneNode(true);
    el.parentNode.replaceChild(replacement, el);
    // Hide after the animation finishes; the keyframes already fade it
    // out, but we want the element fully out of layout so the next pulse
    // renders cleanly.
    setTimeout(() => { try { replacement.setAttribute('hidden', ''); } catch (_) {} }, 3000);
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

async function beforeUnloadCleanup() {
    if (!state.roomCode || !state.user) return;
    try {
        await deleteDoc(doc(db, 'triviaRooms', state.roomCode, 'players', state.user.uid));
    } catch (e) { /* best-effort */ }
}

async function leaveRoom({ silent = false, reason = null } = {}) {
    const code = state.roomCode;
    state.roomUnsubs.splice(0).forEach((u) => { try { u(); } catch (e) {} });
    if (state.timerRaf) { cancelAnimationFrame(state.timerRaf); state.timerRaf = null; }
    window.removeEventListener('beforeunload', beforeUnloadCleanup);

    state.roomCode = null;
    state.roomData = null;
    state.roomPlayers = [];
    state.submittedQuestionId = null;
    state.currentAnswers = [];
    state.actionCounts = {};
    state.lastRematchPromptShown = null;
    lastStatusPlayedFeedback = null;
    stopChatListener();
    closeChatPanel();

    if (code && state.user) {
        try {
            await deleteDoc(doc(db, 'triviaRooms', code, 'players', state.user.uid));
        } catch (e) { /* ignore */ }
        // If we were host, transfer host to next or delete empty room.
        try {
            const remaining = await getDocs(collection(db, 'triviaRooms', code, 'players'));
            const survivors = remaining.docs.map((d) => d.data());
            if (!survivors.length) {
                await deleteDoc(doc(db, 'triviaRooms', code));
            } else {
                const roomSnap = await getDoc(doc(db, 'triviaRooms', code));
                if (roomSnap.exists() && roomSnap.data().hostUid === state.user.uid) {
                    const nextHost = RoomState.pickNextHost(survivors.map((s) => ({
                        uid: s.uid,
                        joinedAt: s.joinedAt && s.joinedAt.toMillis ? s.joinedAt.toMillis() : 0
                    })));
                    if (nextHost) {
                        await updateDoc(doc(db, 'triviaRooms', code), { hostUid: nextHost });
                        await updateDoc(doc(db, 'triviaRooms', code, 'players', nextHost), { isHost: true });
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
    if (!silent && reason) alert(reason);
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
 * Resets when leaveRoom() runs. Limits are intentionally generous —
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
            pausedAt: null
        });
    } catch (err) {
        console.warn('hostEndGameEarly failed:', err);
    }
}

/* =====================================================================
 * Chat — per-room subcollection at triviaRooms/{code}/chat
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
    // Focus the input on open — feels conversational.
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
    // External moderation API check. Disable the send button while
    // we're waiting so the user can't double-fire. Fail-open: if the
    // API is unreachable, allow the message through with a console
    // warning rather than blocking on third-party uptime.
    if (sendBtn) sendBtn.disabled = true;
    let modResult;
    try {
        modResult = await Chat.checkProfanity(text);
    } catch (e) {
        modResult = { ok: false, error: 'unexpected' };
    }
    if (sendBtn) sendBtn.disabled = false;
    if (modResult.ok && modResult.blocked) {
        if (err) { err.textContent = 'That message was flagged by the moderation service.'; err.hidden = false; }
        return;
    }
    if (!modResult.ok) {
        // Telemetry only; do not block the user on API issues.
        console.warn('chat moderation API unavailable:', modResult.error);
    }
    const displayName = (state.profile && state.profile.displayName) || deriveInitialDisplayName();
    try {
        await addDoc(collection(db, 'triviaRooms', state.roomCode, 'chat'), {
            uid: state.user.uid,
            displayName,
            text,
            sentAt: serverTimestamp()
        });
        chatState.lastSentAt = Date.now();
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
    // Quick-emoji bar. One click sends the emoji as a chat message
    // bypassing the moderation API (an emoji can't be flagged).
    document.querySelectorAll('.room-chat-quick-btn').forEach((btn) => {
        btn.addEventListener('click', () => sendChatEmoji(btn.dataset.emoji));
    });
}

async function sendChatEmoji(emoji) {
    if (!state.user || !state.roomCode || !emoji) return;
    if (Chat.shouldRateLimit(chatState.lastSentAt, Date.now())) return;
    const displayName = (state.profile && state.profile.displayName) || deriveInitialDisplayName();
    try {
        await addDoc(collection(db, 'triviaRooms', state.roomCode, 'chat'), {
            uid: state.user.uid,
            displayName,
            text: emoji,
            sentAt: serverTimestamp()
        });
        chatState.lastSentAt = Date.now();
    } catch (e) {
        console.warn('sendChatEmoji failed:', e);
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
    // once the room is playing — the previous host-only gate created
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
            : `Propose restarting the game — all players must accept (${left} left)`;
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
    // finished — the game's over, "Leave room" reframes nicely as
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
    // right-aligned column (post-match) — see styles.css.
    const headerEndActions = $('#room-end-actions');
    const headerRematch = $('#room-end-again-btn');
    if (headerEndActions) headerEndActions.hidden = !finished;
    const headRight = document.querySelector('.room-head-right');
    if (headRight) headRight.classList.toggle('is-finished', finished);
    if (headerRematch) {
        // Mirror the visibility logic from renderRematchUI — only show
        // when a rematch is even an option (>=2 players in multi, or
        // solo player can restart).
        const pCount = rematchPlayerCount();
        const canRematchMulti = playMode === 'multi' && pCount >= 2;
        const canRestartSolo = playMode === 'solo';
        const proposed = !!room.rematchProposedBy;
        // Hide if a proposal is already in flight (the strip below
        // is handling response UI). Show otherwise.
        headerRematch.hidden = !(finished && (canRematchMulti || canRestartSolo) && !proposed);
        headerRematch.innerHTML = canRestartSolo
            ? '<span aria-hidden="true">🔁</span> Restart'
            : '<span aria-hidden="true">🔁</span> Rematch';
    }

    // Rematch / restart proposal — surface an accept/decline prompt
    // exactly once per proposal so the player has a chance to weigh in
    // without missing the round. Fires both mid-game (status='playing')
    // and post-game (status='finished'). A live "Xs remaining" ticker
    // is injected into the modal body so respondents see the same
    // 10-second deadline the proposer's pending modal counts down.
    if ((playing || finished) && room.rematchProposedBy
        && state.user && room.rematchProposedBy !== state.user.uid
        && !meHasAcceptedRematch() && !meHasDeclinedRematch()
        && state.lastRematchPromptShown !== room.rematchProposedBy) {
        state.lastRematchPromptShown = room.rematchProposedBy;
        const proposedAtMs = (room.rematchProposedAt && room.rematchProposedAt.toMillis)
            ? room.rematchProposedAt.toMillis() : Date.now();
        const deadline = proposedAtMs + PROPOSAL_TIMEOUT_MS;
        const baseBody = playing
            ? 'Another player proposed restarting. Accept to draw fresh locations; decline to keep playing.'
            : 'Another player wants a rematch. Accept to start a new game; decline to head back to the lobby.';
        // The body element is the same one openConfirmModal writes —
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
            respondToRematch(!!accept);
        });
    }

    // If this client IS the proposer, keep their waiting modal in sync
    // with the latest snapshot — and close it once the proposal
    // resolves either way (unanimous accept → game restarts, decline →
    // close, no proposal field → host already cleared it).
    if (room.rematchProposedBy && state.user && room.rematchProposedBy === state.user.uid) {
        if (state.proposalPendingDeadline) {
            renderProposalPendingModal();
            if (rematchDeclineCount() > 0) cancelOwnProposal('declined');
            else if (rematchAcceptCount() >= rematchPlayerCount()) closeProposalPendingModal();
        }
    } else if (!room.rematchProposedBy && state.proposalPendingDeadline) {
        // Proposal cleared by someone else — make sure our modal is closed.
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
    if (room.gameType !== 'globe-drop') {
        panel.hidden = true;
        return;
    }
    panel.hidden = false;

    const roundType = room.roundType || 'capitals';
    const meta = GlobeDropLocations.ROUND_TYPES[roundType] || GlobeDropLocations.ROUND_TYPES.capitals;
    setText($('#room-settings-round-type'), meta.label || roundType);

    const diffKey = room.difficulty || 'medium';
    const diff = GlobeDropScoring.difficultySettings(diffKey);
    setText($('#room-settings-difficulty'), diff.label || diffKey);

    setText($('#room-settings-locations'), String(room.totalQuestions || 0));

    const seconds = Math.round((room.questionTimeMs || diff.timerSec * 1000) / 1000);
    setText($('#room-settings-timer'), `${seconds}s`);

    const editBtn = $('#room-settings-edit-btn');
    const hint = $('#room-settings-hint');
    const editForm = $('#room-settings-edit');
    const view = $('#room-settings-view');

    // Edit affordances visible only to host AND only while the room is
    // still in lobby state (settings are locked once playing starts).
    const canEdit = isHost && room.status === 'lobby';
    if (editBtn) editBtn.hidden = !canEdit;
    if (hint) hint.hidden = !(isHost && !canEdit);
    // Whenever the form isn't open, keep it hidden (show summary).
    if (editForm && !state.roomSettingsEditing) {
        editForm.hidden = true;
        if (view) view.hidden = false;
    }
}

/**
 * Open the inline settings editor — preload the selects with the
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
    const seconds = Math.round((room.questionTimeMs || 120000) / 1000);
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
    const newCount = Math.max(1, Math.min(10, parseInt($('#room-settings-edit-count').value, 10) || 5));
    const newSeconds = parseInt($('#room-settings-edit-time').value, 10) || 120;
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
            update.questions = sortLocationsByAscendingDifficulty(locations);
            update.totalQuestions = update.questions.length;
            update.currentQuestionIndex = 0;
            update.currentQuestionId = null;
            update.questionStartedAt = null;
            update.revealStartedAt = null;
            update.playedQuestionIds = [];
        }
        // If difficulty changed but timer was the tier default, snap timer
        // to the new tier default; otherwise keep the user's override.
        const oldDiff = GlobeDropScoring.difficultySettings(state.roomData.difficulty || 'medium');
        const oldUsesTierDefault = state.roomData.questionTimeMs === oldDiff.timerSec * 1000;
        if (oldUsesTierDefault && newDifficulty !== state.roomData.difficulty) {
            update.questionTimeMs = diff.timerSec * 1000;
        }
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
 * Fetch the lifetime H2H record between the current user and `opponentUid`
 * and stamp a "W-L-T" badge into the lobby tile. Cached on state so
 * re-renders within the same session don't refetch. Best-effort —
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
    const ties = pair.ties || 0;
    el.textContent = `H2H ${myWins}-${theirWins}${ties ? `-${ties}` : ''}`;
    el.hidden = false;
}

function renderLobbyStage(isHost) {
    show($('#stage-lobby'));
    hide($('#stage-game'));
    hide($('#stage-globe-drop'));
    hide($('#stage-picking'));
    hide($('#stage-end'));

    // Room settings panel — show current room settings to everyone in
    // the lobby. Host can edit (click event handled separately).
    renderRoomSettings(isHost);

    const list = $('#lobby-player-grid');
    list.innerHTML = '';
    const players = state.roomPlayers.slice().sort((a, b) => {
        const ja = a.joinedAt && a.joinedAt.toMillis ? a.joinedAt.toMillis() : 0;
        const jb = b.joinedAt && b.joinedAt.toMillis ? b.joinedAt.toMillis() : 0;
        return ja - jb;
    });
    for (const p of players) {
        const li = document.createElement('li');
        li.className = 'player-tile';
        if (p.uid === state.roomData.hostUid) li.classList.add('is-host');
        if (state.user && p.uid === state.user.uid) li.classList.add('is-me');
        const isMe = state.user && p.uid === state.user.uid;
        const h2hSpanId = (state.user && !isMe) ? `lobby-h2h-${p.uid}` : '';
        li.innerHTML =
            `<span class="player-avatar">${escapeHtml(avatarLetter(p.displayName))}</span>` +
            `<span class="player-name">${escapeHtml(p.displayName)}</span>` +
            (p.uid === state.roomData.hostUid ? '<span class="player-mini-tag">Host</span>' : '') +
            (h2hSpanId ? `<span class="player-h2h-badge" id="${h2hSpanId}" hidden></span>` : '');
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
    startBtn.disabled = players.length < minPlayers;
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
    const deciderPresent = !!decider;
    const iAmDecider = !!(state.user && state.user.uid === deciderUid);
    const iAmHost = !!(state.user && state.roomData.hostUid === state.user.uid);
    const canPick = iAmDecider || (!deciderPresent && iAmHost);

    setText($('#pick-decider-name'), deciderName + (iAmDecider ? ' (you)' : ''));
    setText($('#pick-decider-avatar'), avatarLetter(deciderName));

    const grid = $('#pick-category-grid');
    grid.innerHTML = '';
    const waiting = $('#pick-waiting-msg');
    const prompt = $('#pick-prompt');
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
            : `${deciderName} disconnected — host can pick to keep the game moving.`;
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
    // Reset the early-reveal write guard whenever the current question
    // changes so the host can fire it once for the new question.
    if (state.earlyRevealForQuestion !== q.id) {
        state.earlyRevealForQuestion = null;
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
            setText(status, `⏱ Time up — correct answer: ${correctText}`);
        } else {
            setText(status, `✗ Wrong — correct answer: ${correctText}`);
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
        // Mark "answered" only when the marker matches the current question id —
        // otherwise we'd light the green check on stale data from question N-1.
        answeredThisQuestion: currentQuestionId != null
            && p.currentAnsweredFor === currentQuestionId
            && p.currentAnswerIndex != null
    })));
    ranked.forEach((p, i) => {
        const li = document.createElement('li');
        li.className = 'mini-board-row';
        if (state.user && p.uid === state.user.uid) li.classList.add('is-me');
        if (i === 0 && (p.score || 0) > 0) li.classList.add('is-leader');
        if (p.answeredThisQuestion) li.classList.add('is-answered');
        // Surface streak ≥2 so the multiplier feels visible and people can
        // see who's on a heater — single correct (streak=1) doesn't yet
        // earn a multiplier, so no indicator there.
        const streak = Number(p.streak) || 0;
        const streakChip = streak >= 2
            ? `<span class="mini-board-streak" title="${streak} correct in a row">🔥${streak}</span>`
            : '';
        li.innerHTML =
            `<span class="mini-board-rank">${i+1}</span>` +
            `<span class="mini-board-name">${escapeHtml(p.displayName)}</span>` +
            streakChip +
            `<span class="mini-board-score">${p.score || 0}</span>`;
        list.appendChild(li);
    });
}

/* =====================================================================
 * GlobeDrop stage — map UI, guess submission, reveal, Wikipedia trivia
 * ===================================================================== */

/**
 * Lazy-init the globe.gl instance on first entry into a GlobeDrop room.
 * The script is loaded with `defer` so it may not be ready at the moment
 * the room enters — callers retry on the next snapshot in that case.
 *
 * Texture: NASA Blue Marble (satellite imagery from three-globe's example
 * assets, no API key). No labels, no political boundaries — pure Earth
 * from space, so a geography game stays a real challenge.
 */
function ensureGlobe() {
    if (state.globe) return state.globe;
    if (typeof Globe === 'undefined') {
        console.warn('globe.gl not loaded yet — init deferred');
        return null;
    }
    const el = document.getElementById('globe-drop-map');
    if (!el) return null;
    state.globe = Globe()(el)
        // Bundled 8K (8192×4096) Earth daymap from Solar System Scope
        // (CC BY 4.0, attributed in the GlobeDrop stage footer). Local so we
        // don't depend on a third-party CDN and skip any CORS surprises.
        // ~4.5 MB; the browser caches it after the first room creation.
        .globeImageUrl('data/earth-8k.jpg')
        .bumpImageUrl('https://unpkg.com/three-globe@2.31.1/example/img/earth-topology.png')
        .showAtmosphere(true)
        .atmosphereColor('#6366f1')
        .atmosphereAltitude(0.18)
        .backgroundColor('rgba(0, 0, 0, 0)')
        .onGlobeClick(({ lat, lng }) => onGlobeClick(lat, lng))
        .pointLat('lat')
        .pointLng('lng')
        .pointColor('color')
        .pointAltitude(0.012)
        .pointRadius('size')
        .pointLabel('label')
        .arcStartLat('startLat').arcStartLng('startLng')
        .arcEndLat('endLat').arcEndLng('endLng')
        .arcColor('color')
        .arcAltitude(0.18)
        .arcStroke(0.45)
        .arcDashLength(0.4)
        .arcDashGap(0.2)
        .arcDashAnimateTime(1800);
    // Match the canvas size to its container; globe.gl reads this once
    // up front so we have to call it after the stage is visible.
    state.globe.width(el.clientWidth);
    state.globe.height(el.clientHeight);
    // Initial camera pose: roughly overhead, comfortable altitude.
    state.globe.pointOfView({ lat: 20, lng: 0, altitude: 1.0 }, 0);

    // Three.js OrbitControls defaults feel sluggish — crank zoom speed and
    // ease damping so wheel + pinch react snappily. We ALSO install a
    // custom wheel listener below so each scroll click moves altitude by
    // a large fixed factor instead of the small linear delta OrbitControls
    // produces — that's where the real "feels fast" upgrade comes from.
    const controls = state.globe.controls();
    if (controls) {
        // Camera feel:
        //   - rotateSpeed 0.45: drag tracks the cursor without over-shoot
        //   - zoomSpeed 4: pinch / pinpoint zooms feel intentional
        //   - dampingFactor 0.3: drag inertia bleeds off in ~5 frames so
        //     the globe stops where you let go instead of "spinning for
        //     no reason" after release
        //   - autoRotate explicitly OFF so a stray default doesn't kick
        //     the globe into continuous spin between rounds
        controls.zoomSpeed = 4;
        controls.rotateSpeed = 0.45;
        controls.enableDamping = true;
        controls.dampingFactor = 0.3;
        controls.autoRotate = false;
    }

    // Custom wheel zoom: multiplicative altitude change per scroll click,
    // gentler factor (15% per click instead of 25%) for less erratic feel
    // and a slightly longer tween (240ms) so the zoom interpolates rather
    // than snapping. Passive:false because we preventDefault.
    el.addEventListener('wheel', (e) => {
        e.preventDefault();
        if (!state.globe) return;
        const pov = state.globe.pointOfView();
        const factor = e.deltaY > 0 ? 1.15 : 0.87;
        const minAlt = 0.15;
        const maxAlt = 4.0;
        const nextAlt = Math.max(minAlt, Math.min(maxAlt, pov.altitude * factor));
        state.globe.pointOfView({ lat: pov.lat, lng: pov.lng, altitude: nextAlt }, 240);
    }, { passive: false });

    // Ask the device for the actual pixel ratio so the globe canvas is
    // rendered at native (retina) resolution — without this, three.js uses
    // 1.0 which looks blurry on hi-DPI displays.
    const renderer = state.globe.renderer && state.globe.renderer();
    if (renderer && typeof renderer.setPixelRatio === 'function') {
        renderer.setPixelRatio(window.devicePixelRatio || 1);
    }

    return state.globe;
}

function teardownMap() {
    // globe.gl doesn't expose a public destructor; drop our ref and clear
    // the container so the WebGL renderer + canvas get GC'd.
    const el = document.getElementById('globe-drop-map');
    if (el) el.innerHTML = '';
    state.globe = null;
    state.pendingGuess = null;
    state.lastRenderedMapQuestion = null;
    state.lastRevealedMapQuestion = null;
}

function clearMapOverlays() {
    if (!state.globe) return;
    state.globe.pointsData([]);
    state.globe.arcsData([]);
}

function onGlobeClick(lat, lng) {
    // Only respond when we're in a live GlobeDrop game and haven't locked
    // in this question yet. We do NOT block on phase === 'asking' here —
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

    state.pendingGuess = { lat, lng };
    drawMyPinOnly(lat, lng);
    $('#globe-drop-submit-btn').disabled = false;
    $('#globe-drop-clear-btn').hidden = false;
    setText($('#globe-drop-status'), 'Pin placed. Submit when you\'re sure.');
    $('#globe-drop-status').classList.remove('is-correct', 'is-wrong');
    Feedback.pinPlaced();
}

function drawMyPinOnly(lat, lng) {
    if (!state.globe) return;
    state.globe.pointsData([{
        lat, lng,
        color: '#6366f1',
        size: 0.55,
        label: 'Your guess'
    }]);
    state.globe.arcsData([]);
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
 * Phase function for GlobeDrop — same shape as RoomState.questionPhase but
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
    //   easy   — country + continent + subregion (full geographic context)
    //   medium — country + continent
    //   hard   — city name only, no country
    // We look up the tier from the room doc; legacy rooms (no difficulty
    // field) read as medium and show the prior country-only behaviour.
    const diff = GlobeDropScoring.difficultySettings(state.roomData.difficulty);
    const hintLevel = diff.hintLevel;
    const showCountry = hintLevel !== 'none';
    setText($('#globe-drop-target-country'), showCountry ? (loc.country || '') : '');

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
    if (extra.length) {
        setText(hintsEl, extra.join(' · '));
        hintsEl.removeAttribute('hidden');
    } else {
        // Always clear the text in addition to hiding — guarantees stale
        // hint content from a previous round (or a mid-game difficulty
        // change) can never bleed through if [hidden] is overridden by
        // some other style.
        setText(hintsEl, '');
        hintsEl.setAttribute('hidden', '');
    }

    // Difficulty chip is only meaningful on the medium-or-harder tiers
    // (easy is the friendly default and doesn't need celebrating).
    const chip = $('#globe-drop-difficulty-chip');
    if (state.roomData.difficulty && diff.scoreMultiplier !== 1) {
        const sign = diff.scoreMultiplier > 1 ? '+' : '';
        setText(chip, `${diff.label} · ${sign}${Math.round((diff.scoreMultiplier - 1) * 100)}% score`);
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
        // Bail if the room is gone — there's nothing to render.
        if (!state.roomData || !state.roomCode) return;
        // Smooth-scroll the question prompt to the top of the viewport
        // on each new question. Anchoring to the "Where is …" header
        // (not the globe) means the player sees the city name first,
        // then the globe sits naturally below — no hunting for the
        // prompt after a long live-standings panel. Once per question
        // so the viewport doesn't yank mid-round.
        const promptRow = document.querySelector('.globe-drop-prompt-row');
        if (promptRow && state.lastScrolledToGlobeForQId !== currentGlobeDropLocationId()) {
            state.lastScrolledToGlobeForQId = currentGlobeDropLocationId();
            try {
                promptRow.scrollIntoView({ behavior: 'smooth', block: 'start' });
            } catch (_) { /* older browsers */ }
        }
        const g = ensureGlobe();
        if (!g) return;
        const el = document.getElementById('globe-drop-map');
        if (el) { g.width(el.clientWidth); g.height(el.clientHeight); }

        // New question? Wipe overlays and re-arm the controls.
        if (state.lastRenderedMapQuestion !== loc.id) {
            clearMapOverlays();
            state.lastRenderedMapQuestion = loc.id;
            state.lastRevealedMapQuestion = null;
            state.pendingGuess = null;
            $('#globe-drop-submit-btn').disabled = true;
            $('#globe-drop-clear-btn').hidden = true;
            $('#globe-drop-reveal').hidden = true;
            const triviaEl = $('#globe-drop-reveal-trivia');
            // Clear the text in addition to hiding so a stale entry can
            // never flash when the reveal panel comes back for the next
            // question. Trivia only renders after a successful fetch
            // completes on the new question.
            triviaEl.textContent = '';
            triviaEl.hidden = true;
            $('#globe-drop-countdown').hidden = true;
            $('#globe-drop-hint').hidden = false;
            setText($('#globe-drop-status'), '');
            $('#globe-drop-status').classList.remove('is-correct', 'is-wrong');
            // Reset camera to the overview pose for each new question.
            // Instant teleport (0ms) so the globe doesn't appear to spin
            // along a great-arc between rounds — the previous question's
            // reveal had the camera centered on the answer's lat/lng, and
            // tweening from there to (20,0) was reading as "the globe
            // spins between rounds for no reason."
            g.pointOfView({ lat: 20, lng: 0, altitude: 1.0 }, 0);
        }

        // Lock the controls if we've already submitted this question.
        const me = state.roomPlayers.find((p) => state.user && p.uid === state.user.uid);
        const meSubmitted = !!(me && me.currentAnsweredFor === loc.id && me.currentGuess);
        if (meSubmitted) {
            $('#globe-drop-submit-btn').disabled = true;
            $('#globe-drop-clear-btn').hidden = true;
        }

        // Three reveal states:
        //   - global (showOthers=true)  : reveal phase has begun for the room
        //   - local  (showOthers=false) : I've submitted but others are still
        //                                 guessing — show me my result, hide theirs
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
    startGlobeDropTimerLoop();
}

/**
 * Write the local player's "ready to advance" marker for the current
 * question. The host's rAF gate watches every player's readyAfterQId;
 * once everyone matches the current question id, the next round (or
 * the end stage, for the final question) fires early instead of
 * waiting out the full 5-second reveal window.
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
 * Render the Ready bar inside the reveal panel: shows the button
 * (disabled once I've voted) plus a tiny pip per player indicating
 * who has and hasn't voted yet.
 */
function renderReadyBar(phase) {
    const bar = $('#globe-drop-ready-bar');
    if (!bar) return;
    const loc = currentGlobeDropLocation();
    const visible = (phase === 'reveal' || phase === 'ended') && !!loc;
    bar.hidden = !visible;
    if (!visible) return;
    const me = state.user
        ? state.roomPlayers.find((p) => p.uid === state.user.uid)
        : null;
    const meReady = !!(me && me.readyAfterQId === loc.id);
    // Last round: relabel to "Finish" — the click ends the game, not
    // "ready for next."
    const room = state.roomData || {};
    const idx = room.currentQuestionIndex || 0;
    const totalQ = room.totalQuestions || 0;
    const isLast = totalQ > 0 && idx >= totalQ - 1;
    const btn = $('#globe-drop-ready-btn');
    if (btn) {
        btn.disabled = meReady;
        if (meReady) {
            btn.innerHTML = isLast
                ? '<span aria-hidden="true">✓</span> Finishing'
                : '<span aria-hidden="true">✓</span> You\'re ready';
        } else {
            btn.innerHTML = isLast
                ? '<span aria-hidden="true">🏁</span> Finish'
                : '<span aria-hidden="true">⏭</span> Ready';
        }
    }
    const statusEl = $('#globe-drop-ready-status');
    if (statusEl) {
        const players = state.roomPlayers || [];
        const readyCount = players.filter((p) => p.readyAfterQId === loc.id).length;
        const pips = players.map((p) => {
            const isReady = p.readyAfterQId === loc.id;
            return `<span class="ready-pip${isReady ? ' is-ready' : ''}">${escapeHtml(p.displayName || 'Player')}</span>`;
        }).join('');
        statusEl.innerHTML = `${pips} <small>${readyCount}/${players.length} ${isLast ? 'finishing' : 'ready'}</small>`;
    }
}

function drawGlobeDropReveal(loc, me, { showOthers = true } = {}) {
    if (!state.globe) return;

    // Always shown: actual location (gold) + my pin (indigo) if I've submitted.
    // Opponents' pins (red) are hidden during the local "I just submitted but
    // others are still guessing" reveal — surfacing them would let me yell
    // their pick across the room before they've locked in.
    const pins = [{
        lat: loc.lat, lng: loc.lng,
        color: '#fcd34d',
        size: 0.8,
        label: `📍 ${loc.name}, ${loc.country}`
    }];
    const meSubmitted = me && me.currentGuess && me.currentAnsweredFor === loc.id;
    if (meSubmitted) {
        pins.push({
            lat: me.currentGuess.lat, lng: me.currentGuess.lng,
            color: '#6366f1',
            size: 0.55,
            label: 'You'
        });
    }
    if (showOthers) {
        state.roomPlayers.forEach((p) => {
            if (!p || !p.currentGuess) return;
            if (p.currentAnsweredFor !== loc.id) return;
            if (state.user && p.uid === state.user.uid) return; // already added
            pins.push({
                lat: p.currentGuess.lat, lng: p.currentGuess.lng,
                color: '#f87171',
                size: 0.55,
                label: p.displayName
            });
        });
    }
    state.globe.pointsData(pins);

    // Great-circle arcs from each guess to the actual location. The
    // outbound colour (per-player) fades into gold at the truth so it
    // reads as "your pin → the right spot". During the local reveal we
    // only draw the player's own arc; during the global reveal we add
    // every opponent so the result feels collective.
    const arcs = [];
    if (meSubmitted) {
        arcs.push({
            startLat: me.currentGuess.lat,
            startLng: me.currentGuess.lng,
            endLat: loc.lat,
            endLng: loc.lng,
            color: ['#6366f1', '#fcd34d']
        });
    }
    if (showOthers) {
        state.roomPlayers.forEach((p) => {
            if (!p || !p.currentGuess) return;
            if (p.currentAnsweredFor !== loc.id) return;
            if (state.user && p.uid === state.user.uid) return; // already added above
            arcs.push({
                startLat: p.currentGuess.lat,
                startLng: p.currentGuess.lng,
                endLat: loc.lat,
                endLng: loc.lng,
                color: ['#f87171', '#fcd34d']
            });
        });
    }
    state.globe.arcsData(arcs);

    // Pan camera so the actual location is centered + zoom in a touch.
    // Reveal fly-in: longer tween so the camera glides into the truth
    // instead of snapping. 1400ms paired with globe.gl's default easing
    // gives a noticeably calmer feel than the prior 1000ms.
    state.globe.pointOfView({ lat: loc.lat, lng: loc.lng, altitude: 1.8 }, 1400);

    // Reveal panel: distance + points or "no guess"
    const revealEl = $('#globe-drop-reveal');
    const distEl = $('#globe-drop-reveal-distance');
    if (meSubmitted) {
        const d = GlobeDropScoring.haversineDistanceKm(
            me.currentGuess.lat, me.currentGuess.lng, loc.lat, loc.lng
        );
        const { points } = GlobeDropScoring.scoreGuess({
            distanceKm: d,
            region: loc.region,
            difficulty: state.roomData.difficulty,
            population: loc.population
        });
        distEl.innerHTML = `${Math.round(d).toLocaleString()} km off — <strong>+${points}</strong> points`;
        let sentiment;
        if (d < 100) sentiment = '🎯 Bullseye!';
        else if (d < 500) sentiment = 'Close, nicely done.';
        else if (d < 2000) sentiment = 'Not bad.';
        else sentiment = 'Way off, but you tried.';
        setText($('#globe-drop-status'), showOthers ? sentiment : `${sentiment} Waiting for the rest…`);
        // Reveal sound + haptic, tiered by points earned (so a tiny-city
        // bullseye gets the celebratory sound, an antipodal guess gets a
        // soft minor descent). Only fires on the LOCAL reveal — the
        // global reveal doesn't re-trigger so opponents' arcs landing
        // don't make a second buzz.
        if (!showOthers) {
            try { Feedback.revealForScore(points); } catch (_) { /* ignore */ }
        }
    } else {
        distEl.textContent = 'No guess submitted (minimum score awarded).';
        setText($('#globe-drop-status'), showOthers ? '⏱ Time up.' : 'Waiting for the rest…');
    }
    revealEl.hidden = false;
    // One-shot pulse on the score callout so the points feel earned. The
    // class is removed once the animation finishes (animationend) so it
    // re-fires the next time the panel opens for a fresh question.
    if (meSubmitted) {
        distEl.classList.remove('is-pulse');
        // Force a reflow so removing + re-adding the class restarts the
        // CSS animation. void 0 is a no-op that triggers layout.
        // eslint-disable-next-line no-void
        void distEl.offsetWidth;
        distEl.classList.add('is-pulse');
    }
    // The asking-phase hint becomes irrelevant once the reveal panel is up.
    const hint = $('#globe-drop-hint');
    if (hint) hint.hidden = true;

    // Wikipedia trivia (best-effort; silently skipped on failure). Fetch
    // once per question — the local reveal kicks off the request so it's
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

function renderMiniBoardGlobeDrop(currentQuestionId) {
    const list = $('#mini-board-list-globe-drop');
    list.innerHTML = '';
    // Anti-peek: if I haven't submitted the current round, redact each
    // opponent's contribution from THIS round so I can't infer their
    // distance/score before I've committed mine. The reveal phase
    // already discloses scores once everyone is in. My own score
    // always reflects my real running total.
    const me = state.user
        ? state.roomPlayers.find((p) => p.uid === state.user.uid)
        : null;
    const meSubmittedCurrent = !!(me && currentQuestionId && me.currentAnsweredFor === currentQuestionId);
    const adjustedScore = (p) => {
        if (!currentQuestionId) return p.score || 0;
        const isMe = state.user && p.uid === state.user.uid;
        if (isMe || meSubmittedCurrent) return p.score || 0;
        // Strip the current round's points from their displayed total.
        const answers = Array.isArray(p.answers) ? p.answers : [];
        const rec = answers.find((a) => a && a.locationId === currentQuestionId);
        const pts = rec && typeof rec.points === 'number' ? rec.points : 0;
        return (p.score || 0) - pts;
    };
    const ranked = Scoring.rankPlayers(state.roomPlayers.map((p) => ({
        displayName: p.displayName,
        score: adjustedScore(p),
        streak: 0, // GlobeDrop doesn't use streaks (yet)
        uid: p.uid,
        answeredThisQuestion: currentQuestionId != null
            && p.currentAnsweredFor === currentQuestionId
            && p.currentGuess != null
    })));
    ranked.forEach((p, i) => {
        const li = document.createElement('li');
        li.className = 'mini-board-row';
        if (state.user && p.uid === state.user.uid) li.classList.add('is-me');
        if (i === 0 && (p.score || 0) > 0) li.classList.add('is-leader');
        if (p.answeredThisQuestion) li.classList.add('is-answered');
        // Answered state: a small green ✓ sits inline next to the
        // player's name. No "submitted" word, no badge chrome — the
        // pseudo-element on .is-answered .mini-board-check renders the
        // ✓ glyph and animates in.
        li.innerHTML =
            `<span class="mini-board-rank">${i+1}</span>` +
            `<span class="mini-board-name">${escapeHtml(p.displayName)}</span>` +
            `<span class="mini-board-check" aria-label="submitted"></span>` +
            `<span class="mini-board-score">${p.score || 0}</span>`;
        list.appendChild(li);
    });
    renderRoundsHistoryBoard();
}

/**
 * Render every completed round in this game as a row: round number +
 * location name + a chip per player showing their score for that round.
 * Pairs visually with the cumulative live standings above it — the
 * standings answer "who is winning right now", this answers "how did
 * they get there round-by-round".
 *
 * Reads each player's `answers[]` (per-location record list every
 * guess appends to) — same source as the end-of-game recap, so the
 * numbers are guaranteed to match.
 */
function renderRoundsHistoryBoard() {
    const board = $('#rounds-history-board');
    const list = $('#rounds-history-list');
    if (!board || !list) return;

    const room = state.roomData;
    if (!room || !Array.isArray(room.questions)) { board.hidden = true; return; }
    const idx = room.currentQuestionIndex || 0;
    if (idx < 1) { board.hidden = true; return; }

    // To prevent score-peeking, opponents' scores for the CURRENT round
    // (the one in progress) stay hidden until the local user has
    // submitted their guess for that round. We only mask the current
    // round here — prior rounds' scores are always visible because the
    // reveal phase already disclosed them.
    const curLoc = currentGlobeDropLocation();
    const me = state.user
        ? state.roomPlayers.find((p) => p.uid === state.user.uid)
        : null;
    const meSubmittedCurrent = !!(me && curLoc && me.currentAnsweredFor === curLoc.id);

    list.innerHTML = '';
    for (let r = 0; r < idx; r++) {
        const loc = room.questions[r];
        if (!loc || !loc.id) continue;
        const isCurrentRound = curLoc && loc.id === curLoc.id;
        const maskOthers = isCurrentRound && !meSubmittedCurrent;
        // For each player, find the answer record matching this round's location.
        const perPlayer = state.roomPlayers.map((p) => {
            const answers = Array.isArray(p.answers) ? p.answers : [];
            const rec = answers.find((a) => a && a.locationId === loc.id);
            return {
                uid: p.uid,
                displayName: p.displayName,
                roundPoints: rec ? (typeof rec.points === 'number' ? rec.points : 0) : null,
                gaveUp: !!(rec && rec.gaveUp)
            };
        });
        perPlayer.sort((a, b) => {
            const av = a.roundPoints == null ? -1 : a.roundPoints;
            const bv = b.roundPoints == null ? -1 : b.roundPoints;
            return bv - av;
        });
        const li = document.createElement('li');
        li.className = 'rounds-history-row';
        // Local-player breakdown — recompute the multipliers we applied
        // so the chip can spell out "× 1.5 × 1.2" alongside the total.
        // Only shown for the LOCAL user's chip, and only for rounds
        // they've actually submitted (no peeking ahead on the current
        // round before submitting).
        const meRec = me && Array.isArray(me.answers)
            ? me.answers.find((a) => a && a.locationId === loc.id)
            : null;
        let myBreakdown = '';
        if (meRec && typeof meRec.points === 'number' && !meRec.gaveUp) {
            const diffMult = GlobeDropScoring.difficultySettings(room.difficulty).scoreMultiplier;
            const contMult = GlobeDropScoring.continentMultiplier(loc.region);
            const popMult = GlobeDropScoring.populationWeight(loc.population);
            const parts = [];
            if (diffMult !== 1) parts.push('×' + diffMult.toFixed(2).replace(/0+$/, '').replace(/\.$/, ''));
            if (contMult !== 1) parts.push('×' + contMult.toFixed(2).replace(/0+$/, '').replace(/\.$/, ''));
            if (popMult !== 1) parts.push('×' + popMult.toFixed(2).replace(/0+$/, '').replace(/\.$/, ''));
            if (parts.length) myBreakdown = ' <em>' + escapeHtml(parts.join(' ')) + '</em>';
        }
        const chips = perPlayer.map((pp) => {
            const isMe = state.user && pp.uid === state.user.uid;
            const cls = 'rounds-history-chip'
                + (isMe ? ' is-me' : '')
                + ((pp.roundPoints || 0) === 0 ? ' is-zero' : '');
            let val;
            if (maskOthers && !isMe) val = '🔒';
            else if (pp.roundPoints == null) val = '—';
            else if (pp.gaveUp) val = 'X';
            else val = String(pp.roundPoints);
            const trailing = isMe ? myBreakdown : '';
            return `<span class="${cls}"><span>${escapeHtml(pp.displayName)}</span><strong>${escapeHtml(val)}</strong>${trailing}</span>`;
        }).join('');
        li.innerHTML =
            `<span class="rounds-history-label">R${r + 1}</span>` +
            `<span class="rounds-history-loc">${escapeHtml(loc.name || '')}</span>` +
            `<span class="rounds-history-scores">${chips}</span>`;
        list.appendChild(li);
    }
    board.hidden = idx === 0;
}

async function submitGuess() {
    if (!state.user || !state.roomCode || !state.roomData) return;
    if (state.roomData.gameType !== 'globe-drop') return;
    const loc = currentGlobeDropLocation();
    if (!loc) return;
    if (!state.pendingGuess) return;
    if (state.submittedQuestionId === loc.id) return;

    const startMs = state.roomData.questionStartedAt && state.roomData.questionStartedAt.toMillis
        ? state.roomData.questionStartedAt.toMillis() : null;
    const revealMs = state.roomData.revealStartedAt && state.roomData.revealStartedAt.toMillis
        ? state.roomData.revealStartedAt.toMillis() : null;
    if (globeDropPhase(startMs, Date.now(), revealMs, currentAskingDurationMs()) !== 'asking') return;

    const distance = GlobeDropScoring.haversineDistanceKm(
        state.pendingGuess.lat, state.pendingGuess.lng, loc.lat, loc.lng
    );
    const { points } = GlobeDropScoring.scoreGuess({
        distanceKm: distance,
        region: loc.region,
        difficulty: state.roomData.difficulty,
        population: loc.population
    });

    state.submittedQuestionId = loc.id;
    const guess = state.pendingGuess;

    // Lock the UI + render the LOCAL reveal optimistically so the player
    // sees their result instantly instead of waiting ~150ms for the
    // snapshot round-trip. We mirror the guess into our local roomPlayers
    // copy so drawGlobeDropReveal can find it.
    $('#globe-drop-submit-btn').disabled = true;
    $('#globe-drop-clear-btn').hidden = true;
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
                points
            };
            tx.update(pref, {
                currentGuess: guess,
                currentAnswerAt: serverTimestamp(),
                currentAnsweredFor: loc.id,
                score: (cur.score || 0) + points,
                answers: [...(Array.isArray(cur.answers) ? cur.answers : []), guessRecord],
                lastSeen: serverTimestamp()
            });
        });
    } catch (err) {
        console.warn('Guess write failed:', err);
        state.submittedQuestionId = null;
        $('#globe-drop-submit-btn').disabled = false;
    }
}

function clearMyPin() {
    state.pendingGuess = null;
    if (state.globe) {
        state.globe.pointsData([]);
        state.globe.arcsData([]);
    }
    $('#globe-drop-submit-btn').disabled = true;
    $('#globe-drop-clear-btn').hidden = true;
    setText($('#globe-drop-status'), '');
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
        renderRevealCountdown(phase, revealMs, now);

        const currentQId = state.roomData.currentQuestionId;
        // Low-timer pings at 5 / 4 / 3 / 2 / 1 seconds. Each fires
        // exactly once per question. Skipped entirely if the local
        // player has ALREADY submitted their guess for this round —
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

        const isHost = state.user && state.roomData.hostUid === state.user.uid;

        // Host early-reveal when everyone has submitted a guess.
        if (isHost && phase === 'asking' && !revealMs && currentQId
            && state.earlyRevealForQuestion !== currentQId
            && state.roomPlayers.length > 0
            && state.roomPlayers.every((p) => p.currentAnsweredFor === currentQId)) {
            state.earlyRevealForQuestion = currentQId;
            updateDoc(doc(db, 'triviaRooms', state.roomCode), {
                revealStartedAt: serverTimestamp()
            }).catch((err) => {
                console.warn('early reveal write failed:', err);
                state.earlyRevealForQuestion = null;
            });
        }

        // Render the Ready bar (button + per-player pips) every tick
        // while we're in or past reveal. Cheap — just a few DOM
        // writes on a small element.
        if (phase === 'reveal' || phase === 'ended') renderReadyBar(phase);

        // Early advance: if every player has voted Ready for the
        // current question during reveal, jump straight to the next
        // round (or the end stage for the final question) instead of
        // waiting out the rest of the 5-second window. The
        // earlyAdvanceForQuestion guard ensures we fire exactly once
        // per question.
        if (isHost && phase === 'reveal' && currentQId
            && state.earlyAdvanceForQuestion !== currentQId
            && state.roomPlayers.length > 0
            && state.roomPlayers.every((p) => p.readyAfterQId === currentQId)) {
            state.earlyAdvanceForQuestion = currentQId;
            advanceQuestionOrFinish().catch((err) => {
                console.warn('early advance write failed:', err);
                state.earlyAdvanceForQuestion = null;
            });
        }

        if (isHost && phase === 'ended') {
            advanceQuestionOrFinish().catch((err) => console.warn('advance failed:', err));
            return;
        }

        state.timerRaf = requestAnimationFrame(tick);
    };
    state.timerRaf = requestAnimationFrame(tick);
}

/**
 * Drive the "5 to next" chip above the globe. Visible only during the
 * GLOBAL reveal (revealStartedAt is set on the room doc) — the local
 * reveal that fires when you submit before opponents shouldn't show a
 * countdown, because the host hasn't started one yet.
 */
function renderRevealCountdown(phase, revealStartedAtMs, nowMs) {
    // The "5 to next" countdown is now drawn into the timer overlay
    // itself by renderGlobeDropTimer. We keep the chip element hidden
    // permanently — there's only ever one timer on screen, top-left.
    const chip = $('#globe-drop-countdown');
    if (chip) chip.hidden = true;
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
        const revealMs = room.revealStartedAt && room.revealStartedAt.toMillis
            ? room.revealStartedAt.toMillis() : null;
        // Same 5→1 countdown for EVERY round including the last one —
        // previously the last round short-circuited to "—" because we
        // assumed nothing follows, but the host still waits 5 s before
        // writing status='finished', so the player should see that
        // wait counted down.
        if (revealMs) {
            const elapsed = Date.now() - revealMs;
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

    // Asking phase — render the question countdown into the overlay.
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

        const isHost = state.user && state.roomData.hostUid === state.user.uid;

        // Host triggers early reveal as soon as every player has answered
        // the current question (avoids waiting out the full asking window
        // when everyone's locked in). The earlyRevealForQuestion guard
        // ensures we fire exactly once per question — rAF is 60fps, the
        // snapshot round-trip is ~150ms, without the guard we'd queue
        // 5-10 redundant writes before state.roomData.revealStartedAt
        // catches up.
        if (isHost && phase === 'asking' && !revealMs && currentQId
            && state.earlyRevealForQuestion !== currentQId
            && state.roomPlayers.length > 0
            && state.roomPlayers.every((p) => p.currentAnsweredFor === currentQId)) {
            state.earlyRevealForQuestion = currentQId;
            updateDoc(doc(db, 'triviaRooms', state.roomCode), {
                revealStartedAt: serverTimestamp()
            }).catch((err) => {
                console.warn('early reveal write failed:', err);
                state.earlyRevealForQuestion = null;
            });
        }

        // Host advances the question when reveal window elapses. Swallow
        // any rejection here — without an explicit catch, a failed rules
        // write would float up as "Uncaught (in promise)".
        if (isHost && phase === 'ended') {
            advanceQuestionOrFinish().catch((err) => console.warn('advance failed:', err));
            return;
        }

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

    if (state.roomData.gameType === 'globe-drop') {
        // GlobeDrop plays locations sequentially — no picking stage, no decider.
        const pool = Array.isArray(state.roomData.questions) ? state.roomData.questions : [];
        const firstLoc = pool[0];
        if (!firstLoc) return;
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

    // Trivia mode — picking stage with decider rotation.
    // Fetch the player list FRESH from Firestore — state.roomPlayers can
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
        playedQuestionIds: [],
        playerOrder,
        deciderUid
    });
}

async function submitAnswer(choiceIndex, question) {
    if (!state.user || !state.roomCode) return;
    if (state.submittedQuestionId === question.id) return; // double-click guard

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
    }
}

async function advanceQuestionOrFinish() {
    if (!state.roomCode || !state.roomData) return;
    const idx = state.roomData.currentQuestionIndex || 0;
    const total = state.roomData.totalQuestions;
    const nextIdx = idx + 1;
    const playedIds = Array.isArray(state.roomData.playedQuestionIds)
        ? state.roomData.playedQuestionIds.slice()
        : [];
    const currentId = state.roomData.currentQuestionId;
    if (currentId && !playedIds.includes(currentId)) playedIds.push(currentId);

    // No per-player reset write here. The rules (correctly) forbid the host
    // from writing other players' docs, so resetting their per-question
    // fields would 403. Instead we use `currentAnsweredFor` (written by the
    // player themselves on submit) as the per-question marker — any stale
    // currentAnswerIndex on a player doc is ignored downstream because it
    // belongs to a previous question.

    if (nextIdx >= total) {
        await updateDoc(doc(db, 'triviaRooms', state.roomCode), {
            status: 'finished',
            finishedAt: serverTimestamp(),
            playedQuestionIds: playedIds
        });
        return;
    }

    if (state.roomData.gameType === 'globe-drop') {
        // GlobeDrop is sequential — no picking stage, just advance.
        const pool = Array.isArray(state.roomData.questions) ? state.roomData.questions : [];
        const nextLoc = pool[nextIdx];
        if (!nextLoc) return;
        await updateDoc(doc(db, 'triviaRooms', state.roomCode), {
            status: 'playing',
            currentQuestionIndex: nextIdx,
            currentQuestionId: nextLoc.id,
            questionStartedAt: serverTimestamp(),
            revealStartedAt: null,
            playedQuestionIds: playedIds
        });
        return;
    }

    // Trivia: rotate decider, re-enter picking stage. Recompute the
    // rotation from the CURRENT player list rather than trusting the
    // stored playerOrder. This means:
    //   - if startGame raced and only saw the host, the rotation
    //     repairs itself on the next question
    //   - players who joined after game start get into the rotation
    //   - players who dropped get skipped
    const currentPlayers = sortPlayersForRotation(state.roomPlayers)
        .map((p) => p.uid)
        .filter((uid) => typeof uid === 'string' && uid.length > 0);
    const nextDecider = RoomState.pickDecider(currentPlayers, nextIdx);
    await updateDoc(doc(db, 'triviaRooms', state.roomCode), {
        status: 'picking',
        currentQuestionIndex: nextIdx,
        currentQuestionId: null,
        selectedCategory: null,
        questionStartedAt: null,
        revealStartedAt: null,
        playerOrder: currentPlayers,
        deciderUid: nextDecider,
        playedQuestionIds: playedIds
    });
}

/**
 * Decider's category choice → write the picked question + start the timer.
 * Anyone signed in can update the room doc (per the rules), but we
 * gate this client-side: only the current decider (or, as a fallback,
 * the host if the decider has dropped) gets the UI to call this.
 * @param {string} category — category id or '__any__'
 */
async function pickCategoryAndStart(category) {
    if (!state.roomCode || !state.roomData) return;
    if (state.roomData.status !== 'picking') return;
    const pool = Array.isArray(state.roomData.questions) ? state.roomData.questions : [];
    const playedIds = Array.isArray(state.roomData.playedQuestionIds)
        ? state.roomData.playedQuestionIds
        : [];
    const picked = RoomState.pickQuestionFromPool(pool, playedIds, category);
    if (!picked) {
        console.warn('Question pool exhausted; advancing to end.');
        await updateDoc(doc(db, 'triviaRooms', state.roomCode), {
            status: 'finished',
            finishedAt: serverTimestamp()
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

async function renderEndStage(isHost) {
    hide($('#stage-lobby'));
    hide($('#stage-game'));
    hide($('#stage-globe-drop'));
    hide($('#stage-picking'));
    show($('#stage-end'));

    if (state.timerRaf) { cancelAnimationFrame(state.timerRaf); state.timerRaf = null; }

    const ranked = Scoring.rankPlayers(state.roomPlayers.map((p) => ({
        uid: p.uid,
        displayName: p.displayName,
        score: p.score || 0,
        streak: p.streak || 0
    })));

    // Podium — skipped for solo runs (no opponents to rank against).
    const podium = $('#podium');
    const isSoloMode = (state.roomData && state.roomData.playMode) === 'solo';
    podium.hidden = isSoloMode;
    podium.innerHTML = '';
    const soloHero = $('#solo-hero');
    if (isSoloMode) {
        // Hide the end-board too — for solo there's only one row and the
        // final score is already in the hero block.
        const boardWrap = document.querySelector('.end-board-wrap');
        if (boardWrap) boardWrap.hidden = true;
        // Populate the solo hero with run stats sourced from the player's
        // answers[] array.
        const meEntry = state.user
            ? state.roomPlayers.find((p) => p.uid === state.user.uid)
            : null;
        const answers = (meEntry && Array.isArray(meEntry.answers)) ? meEntry.answers : [];
        const scored = answers.filter((a) => a && typeof a.points === 'number');
        const finalScore = meEntry ? (meEntry.score || 0) : 0;
        const bestRound = scored.reduce((m, a) => Math.max(m, a.points || 0), 0);
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
    if (!isSoloMode) for (const orderIdx of slotOrder) {
        if (!ranked[orderIdx]) {
            podium.appendChild(document.createElement('div'));
            continue;
        }
        const p = ranked[orderIdx];
        const slot = document.createElement('div');
        slot.className = `podium-slot podium-slot-${orderIdx+1}`;
        slot.innerHTML =
            `<span class="podium-medal">${medals[orderIdx]}</span>` +
            `<span class="podium-name">${escapeHtml(p.displayName)}</span>` +
            `<span class="podium-score">${p.score}</span>` +
            `<div class="podium-block">${orderIdx+1}</div>`;
        podium.appendChild(slot);
    }

    // Full board
    const body = $('#end-board-body');
    body.innerHTML = '';
    ranked.forEach((p, i) => {
        const tr = document.createElement('tr');
        if (state.user && p.uid === state.user.uid) tr.classList.add('is-me');
        const xp = Scoring.xpFromScore(p.score);
        tr.innerHTML =
            `<td>${i+1}</td>` +
            `<td>${escapeHtml(p.displayName)}</td>` +
            `<td class="col-score">${p.score}</td>` +
            `<td class="col-streak">${p.streak || 0}</td>` +
            `<td class="col-xp">+${xp}</td>`;
        body.appendChild(tr);
    });

    // Summary line. Solo runs have no opponent so we don't frame it as
    // a win/loss; we just celebrate the final score.
    const winner = ranked[0];
    const me = ranked.find((p) => state.user && p.uid === state.user.uid);
    const playMode = (state.roomData && state.roomData.playMode) || 'multi';
    const heading = $('#stage-end .end-head h2');
    if (playMode === 'solo' && me) {
        if (heading) setText(heading, 'Run complete');
        setText($('#end-summary'), `Final score: ${me.score}`);
    } else {
        if (heading) setText(heading, 'Game over');
        if (winner && me && winner.uid === me.uid) {
            setText($('#end-summary'), '🎉 You won! Nice work.');
        } else if (winner) {
            setText($('#end-summary'), `${winner.displayName} took it home with ${winner.score} points.`);
        } else {
            setText($('#end-summary'), 'No scores recorded.');
        }
    }

    // Full per-question/per-location recap (free for everyone)
    renderEndRecap();

    // Premium: detailed stats
    if (isPremium()) {
        renderDetailedStats();
        show($('#detailed-stats'));
        hide($('#detailed-stats-upsell'));
    } else {
        hide($('#detailed-stats'));
        show($('#detailed-stats-upsell'));
    }

    // In-room session H2H (one panel showing cumulative wins per player
    // since this room was created). Visible after >=1 match in a multi
    // room with 2+ players.
    renderRoomSessionH2H();

    // Rematch controls. Only the host can PROPOSE a rematch, and only
    // when at least two players are still in the room. Anyone else sees
    // the accept/decline strip once a proposal is active.
    renderRematchUI(isHost);

    // Write XP / wins / games to profile (once per game)
    if (state.user && me && endStageWrittenForRoom !== state.roomCode) {
        endStageWrittenForRoom = state.roomCode;
        await writeEndOfGameStats(me, winner && winner.uid === me.uid);
    }
}

async function writeEndOfGameStats(me, didWin) {
    if (!state.user) return;
    const playMode = (state.roomData && state.roomData.playMode) || 'multi';
    const isSolo = playMode === 'solo';
    try {
        const xp = Scoring.xpFromScore(me.score);
        const userRef = doc(db, 'users', state.user.uid);
        // Solo: still earns XP and counts as a game played, but it
        // cannot grant a "win" because there was no opponent. The
        // global leaderboard write is also skipped — solo results
        // are personal-best-only, not ranked.
        const winsDelta = (isSolo ? 0 : (didWin ? 1 : 0));
        await updateDoc(userRef, {
            'triviaProfile.xp': increment(xp),
            'triviaProfile.gamesPlayed': increment(1),
            'triviaProfile.wins': increment(winsDelta),
            'triviaProfile.lastPlayedAt': serverTimestamp()
        });
        if (state.profile) {
            state.profile.xp = (state.profile.xp || 0) + xp;
            state.profile.gamesPlayed = (state.profile.gamesPlayed || 0) + 1;
            state.profile.wins = (state.profile.wins || 0) + winsDelta;
        }
        if (!isSolo) {
            // Denormalized leaderboard write — multiplayer + daily only.
            const lbRef = doc(db, 'triviaLeaderboard', state.user.uid);
            await setDoc(lbRef, {
                uid: state.user.uid,
                displayName: me.displayName,
                xp: (state.profile && state.profile.xp) || xp,
                gamesPlayed: (state.profile && state.profile.gamesPlayed) || 1,
                wins: (state.profile && state.profile.wins) || winsDelta,
                lastPlayedAt: serverTimestamp()
            }, { merge: true });
        }

        // Daily-challenge leaderboard write. Only the player's BEST score
        // for the day stays — we read the existing doc and only overwrite
        // when the new score is higher. No-op for solo / multi.
        await maybeWriteDailyLeaderboard(me);

        // Pairwise head-to-head — host only, multiplayer only. Iterates
        // every player pair in the room and updates triviaH2H/<pair_key>
        // so the H2H view can display real records instead of generic
        // aggregates.
        await maybeWriteH2HPairs();
    } catch (err) {
        console.warn('End-of-game profile write failed:', err);
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
async function maybeWriteH2HPairs() {
    if (!state.user || !state.roomData || !state.roomCode) return;
    const playMode = state.roomData.playMode || 'multi';
    if (playMode !== 'multi') return;
    const players = Array.isArray(state.roomPlayers) ? state.roomPlayers.slice() : [];
    if (players.length < 2) return;

    // In-room session H2H — host writes the room-level counter so
    // rematches accumulate. Other players don't try (rules permit it
    // since /triviaRooms is open-write to anyone signed in, but only
    // one writer avoids the increment race).
    if (state.roomData.hostUid === state.user.uid) {
        const sortedByScore = players.slice().sort((a, b) => (b.score || 0) - (a.score || 0));
        const topScore = sortedByScore[0] ? (sortedByScore[0].score || 0) : 0;
        const winners = sortedByScore.filter((p) => (p.score || 0) === topScore);
        const sessionUpdate = { sessionMatchCount: (state.roomData.sessionMatchCount || 0) + 1 };
        if (winners.length === 1 && topScore > 0) {
            const prevWins = (state.roomData.sessionWinsByUid && state.roomData.sessionWinsByUid[winners[0].uid]) || 0;
            sessionUpdate[`sessionWinsByUid.${winners[0].uid}`] = prevWins + 1;
        }
        try {
            await updateDoc(doc(db, 'triviaRooms', state.roomCode), sessionUpdate);
        } catch (err) {
            console.warn('Session H2H write failed:', err);
        }
    }

    // Per-pair lifetime H2H — written by whichever side of the pair has
    // the lexicographically lower uid. That single-writer convention
    // (a) satisfies the rules (the writer is uidA, so rules pass)
    // (b) avoids two clients racing to increment the same pair doc.
    // For pairs that don't include me, OR pairs where I'm uidB, I
    // skip — my counterpart handles the write.
    const myUid = state.user.uid;
    for (const opp of players) {
        if (!opp || !opp.uid || opp.uid === myUid) continue;
        if (myUid >= opp.uid) continue; // only the lower-uid side writes
        const me = players.find((p) => p.uid === myUid);
        if (!me) continue;
        const uidA = myUid;
        const uidB = opp.uid;
        const key = uidA + '__' + uidB;
        const aScore = me.score || 0;
        const bScore = opp.score || 0;
        try {
            await runTransaction(db, async (tx) => {
                const ref = doc(db, 'triviaH2H', key);
                const snap = await tx.get(ref);
                const cur = snap.exists() ? snap.data() : {};
                const winsA = (cur.winsA || 0) + (aScore > bScore ? 1 : 0);
                const winsB = (cur.winsB || 0) + (bScore > aScore ? 1 : 0);
                const ties = (cur.ties || 0) + (aScore === bScore ? 1 : 0);
                tx.set(ref, {
                    uidA, uidB,
                    displayNameA: me.displayName || 'Player',
                    displayNameB: opp.displayName || 'Player',
                    winsA, winsB, ties,
                    gamesPlayed: (cur.gamesPlayed || 0) + 1,
                    lastPlayedAt: serverTimestamp()
                }, { merge: true });
            });
        } catch (err) {
            // The most common cause here is "Missing or insufficient
            // permissions" — i.e. the Firestore rules for /triviaH2H
            // haven't been deployed yet. Run:
            //     firebase deploy --only firestore:rules
            // The block won't fail the rest of end-of-game.
            console.warn('H2H write failed for pair', key, '— check that firestore.rules has been deployed:', err);
        }
    }
}

async function maybeWriteDailyLeaderboard(me) {
    if (!state.user || !state.roomData) return;
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
 * Game recap — per-question/per-location table + aggregate stats
 * ===================================================================== */

function renderEndRecap() {
    const section = $('#end-recap');
    if (!section) return;
    const players = state.roomPlayers || [];
    if (!players.length) { section.hidden = true; return; }

    const isGlobeDrop = state.roomData && state.roomData.gameType === 'globe-drop';

    // Pick columns: me first, then highest-scoring opponents, cap at 4 so
    // the table stays readable on phones.
    const rankedAll = Scoring.rankPlayers(players.map((p) => ({
        uid: p.uid,
        displayName: p.displayName,
        score: p.score || 0,
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

    // Table — empty state if no answers recorded (older rooms predating
    // the per-answer write would land here).
    const thead = $('#end-recap-thead');
    const tbody = $('#end-recap-tbody');
    thead.innerHTML = '';
    tbody.innerHTML = '';

    const anyAnswers = columns.some((c) => (answersByUid[c.uid] || []).length > 0);
    if (!questions.length || !anyAnswers) {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td colspan="${columns.length + 3}" class="end-recap-empty">No per-question detail recorded for this game.</td>`;
        tbody.appendChild(tr);
        setText($('#end-recap-sub'), '');
        section.hidden = false;
        return;
    }

    // Table head
    const trHead = document.createElement('tr');
    let headHTML = `<th>#</th><th>${isGlobeDrop ? 'Location' : 'Question'}</th>`;
    columns.forEach((col) => {
        const isMe = state.user && col.uid === state.user.uid;
        headHTML += `<th class="${isMe ? 'is-mine' : ''}">${escapeHtml(isMe ? 'You' : col.displayName)}</th>`;
    });
    headHTML += '<th>Winner</th>';
    trHead.innerHTML = headHTML;
    thead.appendChild(trHead);

    // Body rows
    questions.forEach((q, i) => {
        const tr = document.createElement('tr');
        let rowHTML = `<td class="col-rank">${i + 1}</td>`;
        if (isGlobeDrop) {
            rowHTML +=
                '<td class="col-question">' +
                `<span class="recap-q-text">${escapeHtml(q.name || '…')}</span>` +
                `<span class="recap-q-meta">${escapeHtml(q.country || '')}</span>` +
                '</td>';
        } else {
            const correctText = q.choices ? q.choices[q.correctIndex] : '';
            rowHTML +=
                '<td class="col-question">' +
                `<span class="recap-q-text">${escapeHtml(q.question || '…')}</span>` +
                `<span class="recap-q-meta">${escapeHtml(prettyCategory(q.category || ''))} · answer: ${escapeHtml(correctText)}</span>` +
                '</td>';
        }

        // Per-column results — also track winner(s) for this question.
        let bestPoints = -1;
        const colResults = columns.map((col) => {
            const ans = (answersByUid[col.uid] || [])
                .find((a) => (a.locationId || a.questionId) === q.id);
            const points = ans ? (Number(ans.points) || 0) : 0;
            if (points > bestPoints) bestPoints = points;
            return { col, ans, points };
        });

        const winnersOfRow = bestPoints > 0
            ? colResults.filter((r) => r.points === bestPoints)
            : [];
        const isTie = winnersOfRow.length > 1;
        colResults.forEach(({ col, ans, points }) => {
            const isMe = state.user && col.uid === state.user.uid;
            // Cell highlight: green tint for the winning score(s) in
            // each row (tie shares the win); muted for the rest.
            // Ties don't get the highlight since "winning" is ambiguous.
            let resultCls = 'col-result';
            if (isMe) resultCls += ' is-mine';
            if (!isTie && bestPoints > 0 && points === bestPoints) resultCls += ' is-winner';
            else if (bestPoints > 0 && points < bestPoints) resultCls += ' is-loser';
            if (!ans) {
                rowHTML += `<td class="${resultCls}"><span class="recap-result-zero">…</span></td>`;
                return;
            }
            if (isGlobeDrop) {
                const pts = Number(ans.points) || 0;
                rowHTML +=
                    `<td class="${resultCls}">` +
                    `<span class="${pts > 0 ? 'recap-result-points' : 'recap-result-zero'}">+${pts}</span>` +
                    `<span class="recap-result-dist">${Math.round(Number(ans.distanceKm) || 0).toLocaleString()} km off</span>` +
                    '</td>';
            } else {
                const pts = Number(ans.points) || 0;
                const pickClass = ans.correct ? 'is-correct' : 'is-wrong';
                rowHTML +=
                    `<td class="${resultCls}">` +
                    `<span class="${pts > 0 ? 'recap-result-points' : 'recap-result-zero'}">${pts > 0 ? '+' + pts : '0'}</span>` +
                    `<span class="recap-result-pick ${pickClass}">${escapeHtml(ans.answerText || '…')}</span>` +
                    '</td>';
            }
        });

        // Winner badge — a glowing trophy pill for a single winner; a
        // neutral pill for a tie; nothing if nobody scored.
        let winnerCell = '<span class="recap-result-zero">…</span>';
        if (bestPoints > 0) {
            if (winnersOfRow.length === 1) {
                const w = winnersOfRow[0].col;
                const isMe = state.user && w.uid === state.user.uid;
                winnerCell = `<span class="recap-winner-badge">🏆 ${escapeHtml(isMe ? 'You' : w.displayName)}</span>`;
            } else {
                winnerCell = '<span class="recap-tie-badge">Tie</span>';
            }
        }
        rowHTML += `<td class="col-winner">${winnerCell}</td>`;
        tr.innerHTML = rowHTML;
        tbody.appendChild(tr);
    });

    const qNoun = questions.length === 1 ? 'question' : (isGlobeDrop ? 'locations' : 'questions');
    setText($('#end-recap-sub'),
        `${questions.length} ${qNoun} · comparing ${columns.length} player${columns.length === 1 ? '' : 's'}`);
    section.hidden = false;
}

function computeGlobeDropAggregates(columns, answersByUid) {
    const cards = [];
    columns.forEach((col) => {
        const ans = answersByUid[col.uid] || [];
        if (!ans.length) return;
        const totalPts = ans.reduce((s, a) => s + (Number(a.points) || 0), 0);
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
    const stats = RoomState.aggregateAnswerStats(state.currentAnswers);
    const grid = $('#detailed-stats-grid');
    grid.innerHTML = '';
    const cards = [
        ['Accuracy', Math.round(stats.accuracy * 100) + '%'],
        ['Avg response', stats.avgResponseMs < 1000 ? stats.avgResponseMs + 'ms' : (stats.avgResponseMs / 1000).toFixed(1) + 's'],
        ['Questions answered', String(state.currentAnswers.length)]
    ];
    for (const [label, value] of cards) {
        const div = document.createElement('div');
        div.className = 'detailed-stat';
        div.innerHTML =
            `<span class="detailed-stat-label">${escapeHtml(label)}</span>` +
            `<span class="detailed-stat-value">${escapeHtml(value)}</span>`;
        grid.appendChild(div);
    }
    for (const [cat, rec] of Object.entries(stats.byCategory)) {
        const div = document.createElement('div');
        div.className = 'detailed-stat';
        const pct = rec.total ? Math.round(100 * rec.correct / rec.total) : 0;
        div.innerHTML =
            `<span class="detailed-stat-label">${escapeHtml(cat.replace(/-/g, ' '))}</span>` +
            `<span class="detailed-stat-value">${rec.correct}/${rec.total} · ${pct}%</span>`;
        grid.appendChild(div);
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
 * actually do the writes — we gate by `state.roomData.hostUid`).
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
    return Array.isArray(state.roomPlayers) ? state.roomPlayers.length : 0;
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
    if (playMode !== 'multi' || matchCount < 1 || state.roomPlayers.length < 2) {
        panel.hidden = true;
        return;
    }
    const wins = room.sessionWinsByUid || {};
    const rows = state.roomPlayers.map((p) => ({
        uid: p.uid,
        displayName: p.displayName,
        sessionWins: wins[p.uid] || 0
    })).sort((a, b) => b.sessionWins - a.sessionWins);
    // Total matches = sum of wins across all players, but capped by
    // sessionMatchCount (ties don't increment anyone's count, so the
    // sum can lag behind). Use sessionMatchCount as the denominator
    // so the "losses" calc reflects reality.
    list.innerHTML = '';
    rows.forEach((r, i) => {
        const losses = Math.max(0, matchCount - r.sessionWins);
        const li = document.createElement('li');
        li.className = 'mini-board-row session-h2h-row';
        if (state.user && r.uid === state.user.uid) li.classList.add('is-me');
        li.innerHTML =
            `<span class="mini-board-rank">${i + 1}</span>` +
            `<span class="mini-board-name">${escapeHtml(r.displayName)}</span>` +
            `<span class="session-h2h-wl">` +
                `<span class="session-h2h-pill is-win">${r.sessionWins}W</span>` +
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
        // No proposal yet — any player can propose a rematch.
        if (proposeBtn) {
            proposeBtn.hidden = false;
            proposeBtn.innerHTML = '<span aria-hidden="true">🔁</span> Rematch';
        }
        return;
    }

    // Proposal active — show strip with progress.
    if (strip) strip.hidden = false;
    if (declined) {
        // Surface the decline briefly, then auto-reset so anyone can
        // propose again. Without this, a single decline used to lock
        // the rematch flow forever.
        if (status) setText(status, 'Rematch declined — try again any time.');
        if (proposeBtn) {
            proposeBtn.hidden = false;
            proposeBtn.innerHTML = '<span aria-hidden="true">🔁</span> Propose again';
        }
        clearRematchStateSoon();
        return;
    }
    const accepted = rematchAcceptCount();
    if (status) setText(status, `Rematch — ${accepted} / ${playerCount} players ready`);

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

/* Proposer's waiting modal — single-instance, driven by the room
 * snapshot. The timer is a setInterval that ticks the countdown
 * label every 250ms and force-closes once it hits 0. Cancelling
 * from the modal calls clearRematchStateSoon() to wipe the room
 * fields immediately so opponents stop seeing the prompt. */
const PROPOSAL_TIMEOUT_MS = 10000;
let proposalPendingTimerId = null;
function openProposalPendingModal() {
    const modal = document.getElementById('proposal-pending-modal');
    if (!modal) return;
    state.proposalPendingDeadline = Date.now() + PROPOSAL_TIMEOUT_MS;
    modal.removeAttribute('hidden');
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
        // Only any one client needs to write — pick the proposer since
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
            // was created with — host can't switch round types mid-replay,
            // that's a fresh-room move.
            const locations = await GlobeDropLocations.fetchLocations(
                state.roomData.roundType || 'capitals',
                state.roomData.totalQuestions,
                shuffle
            );
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
                rematchProposedBy: null,
                rematchAcceptedBy: [],
                rematchDeclinedBy: []
            });
        } else {
            // Trivia: re-deal questions using the same source + reset picker.
            // Old rooms may have `packId: 'default'` from before this commit
            // removed the offline pack — coerce those to 'live'.
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
            playedQuestionIds: [],
            playerOrder,
            deciderUid,
            questions,
            packId,
            packName,
            round: nextRound,
            finishedAt: null,
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
    // Daily Globe Drop top 10 — fresh subscription per leaderboard open
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

    const body = $('#leaderboard-body');
    body.innerHTML = '';
    if (!entries.length) {
        $('#leaderboard-empty').hidden = false;
        return;
    }
    $('#leaderboard-empty').hidden = true;

    const showAdmin = !!state.isLeaderboardAdmin;
    entries.forEach((e, i) => {
        const tr = document.createElement('tr');
        if (state.user && e.uid === state.user.uid) tr.classList.add('is-me');
        const pct = e.gamesPlayed ? Math.round(100 * (e.wins || 0) / e.gamesPlayed) : 0;
        const lastPlayed = e.lastPlayedAt && e.lastPlayedAt.toDate ? e.lastPlayedAt.toDate() : null;
        const lastStr = lastPlayed ? formatRelativeDate(lastPlayed) : '…';
        const adminCell = showAdmin
            ? `<td class="col-admin"><button type="button" class="btn-icon-danger" data-action="remove-leaderboard" data-uid="${escapeHtml(e.uid)}" data-name="${escapeHtml(e.displayName || 'Player')}" title="Remove from leaderboard">✕</button></td>`
            : '';
        tr.innerHTML =
            `<td>${i+1}</td>` +
            `<td>${escapeHtml(e.displayName || 'Player')}</td>` +
            `<td class="col-xp">${e.xp || 0}</td>` +
            `<td class="col-games">${e.gamesPlayed || 0}</td>` +
            `<td class="col-wins">${e.wins || 0}</td>` +
            `<td class="col-winpct">${pct}%</td>` +
            `<td>${escapeHtml(lastStr)}</td>` +
            adminCell;
        body.appendChild(tr);
    });

    // Show / hide the admin column header so the row counts still align.
    const adminHeader = $('#leaderboard-admin-th');
    if (adminHeader) adminHeader.hidden = !showAdmin;
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
        body: 'This deletes their row from the Global XP leaderboard only. Their XP and profile stay intact, and the row reappears the next time they play a game.',
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
    return d.toLocaleDateString();
}

/* =====================================================================
 * H2H comparison view
 *
 * Reuses state.leaderboardEntries (already subscribed when the LB or H2H
 * view is active). Both dropdowns list every entry; picking two of the
 * same player just shows their card on both sides — harmless.
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
        const xp = e.xp || 0;
        return `<option value="${uid}">${name} · ${xp} XP</option>`;
    }).join('');

    // Preserve current selections across re-renders (LB snapshot can
    // refire while the H2H tab is open).
    const prevA = a.value;
    const prevB = b.value;

    a.innerHTML = optsHtml;
    b.innerHTML = optsHtml;

    // Default: A = current user (if present), B = next entry. Otherwise
    // first / second by XP.
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
    if (!ea || !eb) {
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
        } catch (_) { /* network / rules — fall back to no-pair view */ }
    }
    if (token !== h2hPairFetchToken) return; // raced

    $('#h2h-stats-a').innerHTML = renderH2HStatsHtml(ea, eb, pair);
    $('#h2h-stats-b').innerHTML = renderH2HStatsHtml(eb, ea, pair);
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
    // Pairwise stats first (the headline), with global lifetime XP shown
    // as context below. cmp > 0 highlights self leading vs other for
    // the colour cue.
    const sp = pairStatsFor(self, other, pair);
    const op = pairStatsFor(other, self, pair);
    const fields = [
        { label: 'Matches',  val: sp.gamesPlayed,            cmp: 0 },
        { label: 'Wins',     val: sp.wins,                   cmp: sp.wins - op.wins },
        { label: 'Losses',   val: sp.losses,                 cmp: op.wins - sp.wins },
        { label: 'Ties',     val: sp.ties,                   cmp: 0 },
        { label: 'XP',       val: self.xp || 0,              cmp: (self.xp || 0) - (other.xp || 0) }
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
    $('#leaderboard-category').addEventListener('change', renderLeaderboardEntries);
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
    // Premium UI is opt-in. The body class drives CSS that pulls every
    // premium-related element out of layout. Skip the JS wiring too so
    // disabled handlers don't fire on hidden controls.
    if (!Config.PREMIUM_UI_ENABLED) {
        document.body.classList.add('premium-disabled');
    }

    installFirestoreNoiseGuard();

    wireViewTabs();
    wireLobby();
    if (Config.PREMIUM_UI_ENABLED) {
        wirePremiumModal();
        wireAdminControls();
    }
    wireProfileView();
    wireCustomPack();
    wireLeaderboard();
    wireH2H();
    wireChat();
    wireConfirmModal();
    renderPackOptions();

    // Read tab + queued room from the URL BEFORE auth wires up, so a
    // signed-in tab refresh restores both without flicker.
    await restoreFromUrl();

    await waitForFirebaseAuth();
    window.firebaseAuth.onAuthStateChange(applyAuthState);
    // Initial state — onAuthStateChange fires synchronously if ready.
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
} else {
    boot();
}
