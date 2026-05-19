/*
 * Trivia Arena — main app module.
 *
 * Wiring:
 *   - Auth: window.firebaseAuth (set up by ../../firebase-config.js, loaded
 *     as a module earlier in the page; we wait on its ready promise).
 *   - Firestore: import the SDK directly from the gstatic CDN. The db
 *     instance is already initialized inside firebase-config.js — we import
 *     `db` from there so we don't initialize a second app.
 *   - Pure helpers: window.TriviaArena.{Config,Scoring,RoomState} from the
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
 *     { displayName, xp, gamesPlayed, wins, premium, lastPlayedAt }
 *
 *   triviaLeaderboard/{uid}  (denormalized for cheap reads)
 *     { uid, displayName, xp, gamesPlayed, wins, lastPlayedAt }
 */

// All Firestore SDK access flows through firebase-config.js (the single
// init point) so we don't import the SDK URL directly here — the
// `no app file imports Firestore directly` invariant test forbids it.
// Path: this file is /apps/trivia-arena/js/app.js, so we go up three
// directories (js → trivia-arena → apps → repo root).
import { db, firestore } from '../../../firebase-config.js';
const {
    doc, collection, getDoc, getDocs, setDoc, updateDoc, deleteDoc,
    onSnapshot, query, orderBy, limit, serverTimestamp, runTransaction,
    increment, deleteField
} = firestore;

const Config = window.TriviaArena.Config;
const Scoring = window.TriviaArena.Scoring;
const RoomState = window.TriviaArena.RoomState;
const LiveQuestions = window.TriviaArena.LiveQuestions;
const MapTapScoring = window.TriviaArena.MapTapScoring;
const MapTapLocations = window.TriviaArena.MapTapLocations;

/* =====================================================================
 * State
 * ===================================================================== */

const state = {
    user: null,                  // Firebase user (or null)
    profile: null,               // users/{uid}.triviaProfile (or null)
    activeView: 'play',          // 'play' | 'leaderboard' | 'profile'
    questionPack: null,          // default question pack JSON
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
    selectedGameType: 'trivia',

    // MapTap-specific runtime state (only populated while a MapTap room
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
    leaderboardUnsub: null
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
    if (view === 'leaderboard') startLeaderboardListener();
    else stopLeaderboardListener();
    if (view === 'profile') renderProfileView();
}

function wireViewTabs() {
    $$('.view-tab').forEach((b) => {
        b.addEventListener('click', () => setView(b.dataset.view));
    });
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
        if (tp) return tp;
        // Seed a minimal profile on first run.
        const seeded = {
            displayName: deriveInitialDisplayName(),
            xp: 0,
            gamesPlayed: 0,
            wins: 0,
            premium: false,
            lastPlayedAt: null
        };
        await setDoc(ref, { triviaProfile: seeded }, { merge: true });
        return seeded;
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

    // Profile view toggles
    setClass($('#profile-signed-out'), 'is-hidden', signedIn);
    $('#profile-signed-out').hidden = signedIn;
    $('#profile-card-trivia').hidden = !signedIn;

    if (signedIn) {
        loadProfile(user.uid).then((p) => {
            state.profile = p;
            renderProfileView();
            renderPremiumGates();
            // Pull custom pack if any
            state.customPack = (p && p.customPack) ? p.customPack : null;
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

    const premiumCard = $('#profile-premium-card');
    setClass(premiumCard, 'is-premium', !!p.premium);
    setText(
        $('#profile-premium-status'),
        p.premium
            ? 'Premium active — private rooms, custom packs, and detailed stats are unlocked. Thanks for supporting Shevato!'
            : 'Upgrade to unlock private rooms, custom question packs, and detailed post-game stats.'
    );

    renderCustomPackTextarea();
}

function wireProfileView() {
    $('#profile-display-name').addEventListener('change', async (e) => {
        const v = String(e.target.value || '').trim().slice(0, Config.MAX_DISPLAY_NAME);
        if (!v) return;
        await saveProfileField({ displayName: v });
        renderProfileView();
        renderLeaderboardEntries();
    });
    $('#upgrade-premium-btn').addEventListener('click', openPremiumModal);
}

/* =====================================================================
 * Premium
 * ===================================================================== */

function isPremium() {
    return !!(state.profile && state.profile.premium);
}

function renderPremiumGates() {
    // Toggle "Premium" tags' visibility — keep them visible always, but show
    // a contextual hint when a non-premium user tries to engage the feature.
    const premium = isPremium();
    $$('.premium-tag').forEach((tag) => {
        tag.style.display = premium ? 'none' : 'inline-flex';
    });
}

function openPremiumModal() {
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
        if (e.target.matches('[data-close="modal"], .modal-backdrop, .modal-close')) {
            closePremiumModal();
        }
    });
    $('#premium-checkout-btn').addEventListener('click', () => {
        window.open(Config.STRIPE_CHECKOUT_URL, '_blank', 'noopener,noreferrer');
    });
    // Any [data-action="open-premium"] anywhere opens it.
    document.addEventListener('click', (e) => {
        const trigger = e.target.closest('[data-action="open-premium"]');
        if (trigger) openPremiumModal();
    });
}

/* =====================================================================
 * Question pack loading
 * ===================================================================== */

async function loadDefaultPack() {
    if (state.questionPack) return state.questionPack;
    const res = await fetch('data/questions.json', { cache: 'no-cache' });
    state.questionPack = await res.json();
    return state.questionPack;
}

function shuffle(arr, rand = Math.random) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

function pickRoundQuestions(pack, count) {
    const all = (pack && Array.isArray(pack.questions)) ? pack.questions : [];
    const shuffled = shuffle(all);
    return shuffled.slice(0, Math.min(count, shuffled.length));
}

/**
 * Build the question POOL for a round. We over-provision so the per-question
 * category picker has variety: the round plays `count` questions out of a
 * pool of up to 5x that (capped at the live API's 50/request limit).
 *
 * Live source is best-effort — any fetch / parse failure transparently
 * falls back to the bundled pack so the game still starts. The chosen
 * packId we return is what should be persisted on the room so Play Again
 * uses the same source.
 *
 * @param {string} packId — 'live' | 'custom' | 'default'
 * @param {number} count — number of questions to be played this round
 * @returns {Promise<{questions:Array, packId:string, packName:string}>}
 */
async function buildQuestionsForRound(packId, count) {
    const poolTarget = Math.max(count, Math.min(50, count * 5));
    if (packId === 'live') {
        try {
            const questions = await LiveQuestions.fetchLiveQuestions(poolTarget, shuffle);
            return { questions, packId: 'live', packName: 'The Trivia API' };
        } catch (err) {
            console.warn('Live questions fetch failed, falling back to bundled pack:', err);
            const pack = await loadDefaultPack();
            return {
                questions: shuffle(pack.questions || []),
                packId: 'default',
                packName: (pack && pack.name) || 'Mixed General Knowledge'
            };
        }
    }
    if (packId === 'custom' && state.customPack && isPremium()) {
        return {
            questions: shuffle(state.customPack.questions || []),
            packId: 'custom',
            packName: state.customPack.name || 'Custom pack'
        };
    }
    const pack = await loadDefaultPack();
    return {
        questions: shuffle(pack.questions || []),
        packId: 'default',
        packName: (pack && pack.name) || 'Mixed General Knowledge'
    };
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

    // Live API is the default — much larger and more varied than the
    // bundled pack. The bundled pack stays as an explicit fallback option
    // (and is always used if the live fetch fails).
    const live = document.createElement('option');
    live.value = 'live';
    live.textContent = 'Live questions (The Trivia API)';
    sel.appendChild(live);

    const bundled = document.createElement('option');
    bundled.value = 'default';
    bundled.textContent = 'Mixed General Knowledge (offline pack)';
    sel.appendChild(bundled);

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
            if (type !== 'trivia' && type !== 'maptap') return;
            state.selectedGameType = type;
            $$('.game-type-btn').forEach((b) => {
                const isOn = b.dataset.gameType === type;
                b.classList.toggle('is-active', isOn);
                b.setAttribute('aria-selected', isOn ? 'true' : 'false');
            });
            // Show/hide trivia-only vs maptap-only form fields.
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
        if (wantsPrivate && !isPremium()) {
            e.target.checked = false;
            openPremiumModal();
            return;
        }
        $('#create-password-field').hidden = !wantsPrivate;
    });

    $('#create-room-btn').addEventListener('click', createRoom);
    $('#join-room-btn').addEventListener('click', joinRoom);
    $('#join-code').addEventListener('input', (e) => {
        const raw = String(e.target.value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
        e.target.value = raw.slice(0, Config.ROOM_CODE_LENGTH);
        clearJoinError();
    });
    $('#join-code').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') joinRoom();
    });

    $('#leave-room-btn').addEventListener('click', () => leaveRoom());
    $('#start-game-btn').addEventListener('click', startGame);
    $('#end-back-btn').addEventListener('click', () => leaveRoom());
    $('#end-again-btn').addEventListener('click', () => playAgain());

    // MapTap controls (wired once; they no-op when no MapTap room is active)
    const submitBtn = $('#maptap-submit-btn');
    if (submitBtn) submitBtn.addEventListener('click', () => submitGuess());
    const clearBtn = $('#maptap-clear-btn');
    if (clearBtn) clearBtn.addEventListener('click', () => clearMyPin());

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

async function createRoom() {
    if (!state.user) { openSignInPrompt(); return; }
    const gameType = state.selectedGameType === 'maptap' ? 'maptap' : 'trivia';
    const isPrivate = !!$('#create-private-toggle').checked && isPremium();
    const password = isPrivate ? String($('#create-password').value || '').trim() : '';
    if (isPrivate && !password) {
        alert('Set a password for the private room.');
        return;
    }

    const btn = $('#create-room-btn');
    const originalLabel = btn.textContent;
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

        if (gameType === 'maptap') {
            btn.textContent = 'Fetching locations…';
            const count = parseInt($('#create-locations-count').value, 10) || Config.MAPTAP_LOCATIONS_DEFAULT;
            const seconds = parseInt($('#create-maptap-time').value, 10) || 120;
            // For MapTap, questions[] holds the exact playlist of locations
            // (no over-provisioning — there's no per-question category picker
            // to feed variety into).
            const locations = await MapTapLocations.fetchLocations(count, shuffle);
            await setDoc(ref, Object.assign({}, shared, {
                packId: 'world-capitals',
                packName: 'World capitals',
                totalQuestions: locations.length,
                questions: locations,
                // Per-question timer chosen in the lobby. Stored in ms so the
                // pure phase helpers don't have to know about the unit choice.
                questionTimeMs: seconds * 1000
            }));
        } else {
            const sel = $('#create-pack-select').value;
            const count = parseInt($('#create-questions-count').value, 10) || 10;
            const seconds = parseInt($('#create-trivia-time').value, 10) || 15;
            btn.textContent = sel === 'live' ? 'Fetching questions…' : 'Creating room…';
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
    } finally {
        btn.disabled = false;
        btn.textContent = originalLabel;
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
        state.roomPlayers = snap.docs.map((d) => d.data());
        renderRoom();
    }));
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
    hide($('#stage-maptap'));
    hide($('#stage-picking'));
    show($('#stage-lobby'));
    if (!silent && reason) alert(reason);
    teardownMap();
}

/* =====================================================================
 * Render room (lobby, asking, reveal, end)
 * ===================================================================== */

function renderRoom() {
    if (!state.roomData) return;
    const isHost = state.user && state.roomData.hostUid === state.user.uid;
    $('#room-host-tag').hidden = !isHost;
    $('#room-private-tag').hidden = !state.roomData.isPrivate;

    const isMapTap = state.roomData.gameType === 'maptap';
    switch (state.roomData.status) {
        case 'lobby': return renderLobbyStage(isHost);
        case 'picking': return renderPickingStage(isHost);
        case 'playing': return isMapTap ? renderMapTapStage(isHost) : renderGameStage(isHost);
        case 'finished': return renderEndStage(isHost);
    }
}

function renderLobbyStage(isHost) {
    show($('#stage-lobby'));
    hide($('#stage-game'));
    hide($('#stage-maptap'));
    hide($('#stage-picking'));
    hide($('#stage-end'));

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
        li.innerHTML =
            `<span class="player-avatar">${escapeHtml(avatarLetter(p.displayName))}</span>` +
            `<span class="player-name">${escapeHtml(p.displayName)}</span>` +
            (p.uid === state.roomData.hostUid ? '<span class="player-mini-tag">Host</span>' : '');
        list.appendChild(li);
    }

    $('#lobby-host-controls').hidden = !isHost;
    $('#lobby-guest-hint').hidden = isHost;
    $('#start-game-btn').disabled = players.length < 1;
}

function renderPickingStage(isHost) {
    hide($('#stage-lobby'));
    hide($('#stage-game'));
    hide($('#stage-maptap'));
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
            empty.textContent = 'Pool exhausted — host will finish the game.';
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
    hide($('#stage-maptap'));
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
        setText(status, 'Locked in — waiting for the rest.');
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
 * MapTap stage — map UI, guess submission, reveal, Wikipedia trivia
 * ===================================================================== */

/**
 * Lazy-init the globe.gl instance on first entry into a MapTap room.
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
    const el = document.getElementById('maptap-map');
    if (!el) return null;
    state.globe = Globe()(el)
        // Bundled 8K (8192×4096) Earth daymap from Solar System Scope
        // (CC BY 4.0, attributed in the MapTap stage footer). Local so we
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
    state.globe.pointOfView({ lat: 20, lng: 0, altitude: 2.5 }, 0);

    // Three.js OrbitControls defaults feel sluggish — crank zoom speed and
    // ease damping so wheel + pinch react snappily. We ALSO install a
    // custom wheel listener below so each scroll click moves altitude by
    // a large fixed factor instead of the small linear delta OrbitControls
    // produces — that's where the real "feels fast" upgrade comes from.
    const controls = state.globe.controls();
    if (controls) {
        controls.zoomSpeed = 8;            // baseline for pinch / non-wheel zoom
        controls.rotateSpeed = 1.1;
        controls.enableDamping = true;
        controls.dampingFactor = 0.22;
    }

    // Custom wheel zoom: multiplicative altitude change per scroll click
    // so zoom feels equally fast at any altitude (default OrbitControls is
    // linear and feels slow when zoomed in). 25% per click ≈ 4 clicks to
    // halve/double the view. Passive:false because we preventDefault.
    el.addEventListener('wheel', (e) => {
        e.preventDefault();
        if (!state.globe) return;
        const pov = state.globe.pointOfView();
        const factor = e.deltaY > 0 ? 1.25 : 0.8;
        const minAlt = 0.15;
        const maxAlt = 4.0;
        const nextAlt = Math.max(minAlt, Math.min(maxAlt, pov.altitude * factor));
        state.globe.pointOfView({ lat: pov.lat, lng: pov.lng, altitude: nextAlt }, 120);
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
    const el = document.getElementById('maptap-map');
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
    // Only respond when we're in the asking phase of a MapTap question
    // and haven't already locked in.
    if (!state.roomData || state.roomData.status !== 'playing') return;
    if (state.roomData.gameType !== 'maptap') return;
    const loc = currentMapTapLocation();
    if (!loc) return;
    const startMs = state.roomData.questionStartedAt && state.roomData.questionStartedAt.toMillis
        ? state.roomData.questionStartedAt.toMillis() : null;
    const revealMs = state.roomData.revealStartedAt && state.roomData.revealStartedAt.toMillis
        ? state.roomData.revealStartedAt.toMillis() : null;
    const phase = mapTapPhase(startMs, Date.now(), revealMs, currentAskingDurationMs());
    if (phase !== 'asking') return;
    const me = state.roomPlayers.find((p) => state.user && p.uid === state.user.uid);
    if (me && me.currentAnsweredFor === loc.id) return;

    state.pendingGuess = { lat, lng };
    drawMyPinOnly(lat, lng);
    $('#maptap-submit-btn').disabled = false;
    $('#maptap-clear-btn').hidden = false;
    setText($('#maptap-status'), 'Pin placed — submit when you\'re sure.');
    $('#maptap-status').classList.remove('is-correct', 'is-wrong');
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

function currentMapTapLocation() {
    if (!state.roomData) return null;
    const pool = Array.isArray(state.roomData.questions) ? state.roomData.questions : [];
    return pool.find((q) => q && q.id === state.roomData.currentQuestionId) || null;
}

/**
 * Resolve the per-question asking duration for the current room. The host
 * picks this in the lobby; if the room predates the field (or it's 0/null),
 * fall back to the mode-appropriate Config default so old rooms still work.
 */
function currentAskingDurationMs() {
    const ms = state.roomData && state.roomData.questionTimeMs;
    if (typeof ms === 'number' && ms > 0) return ms;
    return (state.roomData && state.roomData.gameType === 'maptap')
        ? Config.MAPTAP_LOCATION_TIME_MS
        : Config.QUESTION_TIME_MS;
}

/**
 * Phase function for MapTap — same shape as RoomState.questionPhase but
 * keyed off the per-room duration (host-configurable) for asking and
 * MAPTAP_REVEAL_TIME_MS for reveal.
 */
function mapTapPhase(startedAtMs, nowMs, revealStartedAtMs, askingDurationMs) {
    if (!startedAtMs) return 'idle';
    const asking = (typeof askingDurationMs === 'number' && askingDurationMs > 0)
        ? askingDurationMs
        : Config.MAPTAP_LOCATION_TIME_MS;
    if (revealStartedAtMs) {
        const revealElapsed = nowMs - revealStartedAtMs;
        if (revealElapsed < 0) return 'asking';
        if (revealElapsed < Config.MAPTAP_REVEAL_TIME_MS) return 'reveal';
        return 'ended';
    }
    const elapsed = nowMs - startedAtMs;
    if (elapsed < 0) return 'idle';
    if (elapsed < asking) return 'asking';
    if (elapsed < asking + Config.MAPTAP_REVEAL_TIME_MS) return 'reveal';
    return 'ended';
}

function mapTapTimeLeftMs(startedAtMs, nowMs, revealStartedAtMs, askingDurationMs) {
    const asking = (typeof askingDurationMs === 'number' && askingDurationMs > 0)
        ? askingDurationMs
        : Config.MAPTAP_LOCATION_TIME_MS;
    if (!startedAtMs) return asking;
    if (revealStartedAtMs) return 0;
    const elapsed = nowMs - startedAtMs;
    return Math.max(0, Math.min(asking, asking - elapsed));
}

function renderMapTapStage() {
    hide($('#stage-lobby'));
    hide($('#stage-game'));
    hide($('#stage-end'));
    hide($('#stage-picking'));
    show($('#stage-maptap'));

    const idx = state.roomData.currentQuestionIndex || 0;
    const total = state.roomData.totalQuestions || 0;
    setText($('#maptap-progress-now'), String(idx + 1));
    setText($('#maptap-progress-total'), String(total));

    const loc = currentMapTapLocation();
    if (!loc) return;

    setText($('#maptap-target-name'), loc.name || '—');
    setText($('#maptap-target-country'), loc.country || '');
    // We deliberately do NOT surface the continent/region during the
    // asking phase — knowing "Europe" narrows the guess to ~10% of the
    // globe and makes the multipliers meaningless. Region is still
    // applied to the score behind the scenes.

    // Init the globe after the stage is visible so its container has a
    // measurable size. globe.gl reads dimensions during construction.
    setTimeout(() => {
        const g = ensureGlobe();
        if (!g) return;
        const el = document.getElementById('maptap-map');
        if (el) { g.width(el.clientWidth); g.height(el.clientHeight); }

        // New question? Wipe overlays and re-arm the controls.
        if (state.lastRenderedMapQuestion !== loc.id) {
            clearMapOverlays();
            state.lastRenderedMapQuestion = loc.id;
            state.lastRevealedMapQuestion = null;
            state.pendingGuess = null;
            $('#maptap-submit-btn').disabled = true;
            $('#maptap-clear-btn').hidden = true;
            $('#maptap-reveal').hidden = true;
            $('#maptap-reveal-trivia').hidden = true;
            $('#maptap-countdown').hidden = true;
            $('#maptap-hint').hidden = false;
            setText($('#maptap-status'), 'Click anywhere on the globe to drop your pin.');
            $('#maptap-status').classList.remove('is-correct', 'is-wrong');
            // Reset camera to the overview pose for each new question.
            g.pointOfView({ lat: 20, lng: 0, altitude: 2.5 }, 600);
        }

        // Lock the controls if we've already submitted this question.
        const me = state.roomPlayers.find((p) => state.user && p.uid === state.user.uid);
        const meSubmitted = !!(me && me.currentAnsweredFor === loc.id && me.currentGuess);
        if (meSubmitted) {
            $('#maptap-submit-btn').disabled = true;
            $('#maptap-clear-btn').hidden = true;
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
        const phase = mapTapPhase(startMs, Date.now(), revealMs, currentAskingDurationMs());
        const globalReveal = phase === 'reveal' || phase === 'ended';
        const globalTag = loc.id + ':global';
        const localTag = loc.id + ':local';
        if (globalReveal && state.lastRevealedMapQuestion !== globalTag) {
            drawMapTapReveal(loc, me, { showOthers: true });
            state.lastRevealedMapQuestion = globalTag;
        } else if (!globalReveal && meSubmitted && state.lastRevealedMapQuestion !== localTag) {
            drawMapTapReveal(loc, me, { showOthers: false });
            state.lastRevealedMapQuestion = localTag;
        }
    }, 50);

    renderMiniBoardMapTap(loc.id);
    startMapTapTimerLoop();
}

function drawMapTapReveal(loc, me, { showOthers = true } = {}) {
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

    // Arc from my guess to the actual location (great-circle on the globe).
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
    state.globe.arcsData(arcs);

    // Pan camera so the actual location is centered + zoom in a touch.
    state.globe.pointOfView({ lat: loc.lat, lng: loc.lng, altitude: 1.8 }, 1000);

    // Reveal panel: distance + points or "no guess"
    const revealEl = $('#maptap-reveal');
    const distEl = $('#maptap-reveal-distance');
    if (meSubmitted) {
        const d = MapTapScoring.haversineDistanceKm(
            me.currentGuess.lat, me.currentGuess.lng, loc.lat, loc.lng
        );
        const { points } = MapTapScoring.scoreGuess({ distanceKm: d, region: loc.region });
        distEl.innerHTML = `${Math.round(d).toLocaleString()} km off — <strong>+${points}</strong> points`;
        let sentiment;
        if (d < 100) sentiment = '🎯 Bullseye!';
        else if (d < 500) sentiment = 'Close — nicely done.';
        else if (d < 2000) sentiment = 'Not bad.';
        else sentiment = 'Way off, but you tried.';
        setText($('#maptap-status'), showOthers ? sentiment : `${sentiment} Waiting for the rest…`);
    } else {
        distEl.textContent = 'No guess submitted — 0 points';
        setText($('#maptap-status'), showOthers ? '⏱ Time up.' : 'Waiting for the rest…');
    }
    revealEl.hidden = false;
    // The asking-phase hint becomes irrelevant once the reveal panel is up.
    const hint = $('#maptap-hint');
    if (hint) hint.hidden = true;

    // Wikipedia trivia (best-effort; silently skipped on failure). Fetch
    // once per question — the local reveal kicks off the request so it's
    // already in the panel by the time the global reveal hits.
    if (state.triviaFetchedFor !== loc.id) {
        state.triviaFetchedFor = loc.id;
        MapTapLocations.fetchCityTrivia(loc.name).then((text) => {
            if (!text) return;
            const triviaEl = $('#maptap-reveal-trivia');
            triviaEl.textContent = text;
            triviaEl.hidden = false;
        }).catch(() => { /* ignore */ });
    }
}

function renderMiniBoardMapTap(currentQuestionId) {
    const list = $('#mini-board-list-maptap');
    list.innerHTML = '';
    const ranked = Scoring.rankPlayers(state.roomPlayers.map((p) => ({
        displayName: p.displayName,
        score: p.score,
        streak: 0, // MapTap doesn't use streaks (yet)
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
        li.innerHTML =
            `<span class="mini-board-rank">${i+1}</span>` +
            `<span class="mini-board-name">${escapeHtml(p.displayName)}</span>` +
            `<span class="mini-board-score">${p.score || 0}</span>`;
        list.appendChild(li);
    });
}

async function submitGuess() {
    if (!state.user || !state.roomCode || !state.roomData) return;
    if (state.roomData.gameType !== 'maptap') return;
    const loc = currentMapTapLocation();
    if (!loc) return;
    if (!state.pendingGuess) return;
    if (state.submittedQuestionId === loc.id) return;

    const startMs = state.roomData.questionStartedAt && state.roomData.questionStartedAt.toMillis
        ? state.roomData.questionStartedAt.toMillis() : null;
    const revealMs = state.roomData.revealStartedAt && state.roomData.revealStartedAt.toMillis
        ? state.roomData.revealStartedAt.toMillis() : null;
    if (mapTapPhase(startMs, Date.now(), revealMs, currentAskingDurationMs()) !== 'asking') return;

    const distance = MapTapScoring.haversineDistanceKm(
        state.pendingGuess.lat, state.pendingGuess.lng, loc.lat, loc.lng
    );
    const { points } = MapTapScoring.scoreGuess({ distanceKm: distance, region: loc.region });

    state.submittedQuestionId = loc.id;
    const guess = state.pendingGuess;

    // Lock the UI + render the LOCAL reveal optimistically so the player
    // sees their result instantly instead of waiting ~150ms for the
    // snapshot round-trip. We mirror the guess into our local roomPlayers
    // copy so drawMapTapReveal can find it.
    $('#maptap-submit-btn').disabled = true;
    $('#maptap-clear-btn').hidden = true;
    const myEntry = state.roomPlayers.find((p) => p.uid === state.user.uid);
    if (myEntry) {
        myEntry.currentGuess = guess;
        myEntry.currentAnsweredFor = loc.id;
    }
    drawMapTapReveal(loc, myEntry || { uid: state.user.uid, currentGuess: guess, currentAnsweredFor: loc.id }, { showOthers: false });
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
        $('#maptap-submit-btn').disabled = false;
    }
}

function clearMyPin() {
    state.pendingGuess = null;
    if (state.globe) {
        state.globe.pointsData([]);
        state.globe.arcsData([]);
    }
    $('#maptap-submit-btn').disabled = true;
    $('#maptap-clear-btn').hidden = true;
    setText($('#maptap-status'), 'Click anywhere on the globe to drop your pin.');
}

function startMapTapTimerLoop() {
    if (state.timerRaf) cancelAnimationFrame(state.timerRaf);
    let lastPhase = null;
    let lastQId = null;
    const tick = () => {
        if (!state.roomData || state.roomData.status !== 'playing') return;
        if (state.roomData.gameType !== 'maptap') return;
        const startMs = state.roomData.questionStartedAt && state.roomData.questionStartedAt.toMillis
            ? state.roomData.questionStartedAt.toMillis() : null;
        const revealMs = state.roomData.revealStartedAt && state.roomData.revealStartedAt.toMillis
            ? state.roomData.revealStartedAt.toMillis() : null;
        const now = Date.now();
        const duration = currentAskingDurationMs();
        const left = mapTapTimeLeftMs(startMs, now, revealMs, duration);
        const phase = mapTapPhase(startMs, now, revealMs, duration);
        renderMapTapTimer(left, phase, duration);
        renderRevealCountdown(phase, revealMs, now);

        const currentQId = state.roomData.currentQuestionId;
        // Re-render the stage when phase changes so the reveal markers
        // and "X km off" line draw without waiting for a snapshot.
        if (phase !== lastPhase || currentQId !== lastQId) {
            lastPhase = phase;
            lastQId = currentQId;
            // Heavy-handed but safe: just re-run the stage renderer.
            renderMapTapStage();
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
    const chip = $('#maptap-countdown');
    const num = $('#maptap-countdown-num');
    if (!chip || !num) return;
    if (phase !== 'reveal' || !revealStartedAtMs) {
        chip.hidden = true;
        return;
    }
    const elapsed = nowMs - revealStartedAtMs;
    const left = Math.max(0, Config.MAPTAP_REVEAL_TIME_MS - elapsed);
    const seconds = Math.max(1, Math.ceil(left / 1000));
    setText(num, String(seconds));
    chip.hidden = false;
}

function renderMapTapTimer(leftMs, phase, totalMs) {
    const total = totalMs || Config.MAPTAP_LOCATION_TIME_MS;
    const fraction = Math.max(0, Math.min(1, leftMs / total));
    const circumference = 176;
    const offset = circumference * (1 - fraction);
    const ring = $('#maptap-timer-ring-fill');
    if (ring) ring.style.strokeDashoffset = String(offset);

    const timer = $('#maptap-timer');
    const seconds = Math.ceil(leftMs / 1000);
    setText($('#maptap-timer-num'), (phase === 'reveal' || phase === 'ended') ? '!' : String(seconds));
    // Warn/danger thresholds scale with total time so a 30s game doesn't
    // sit in danger-red the whole time, and a 5min game still flashes
    // appropriately near the end.
    const dangerCutoff = Math.max(3000, total * 0.1);
    const warnCutoff = Math.max(10000, total * 0.25);
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

    if (state.roomData.gameType === 'maptap') {
        // MapTap plays locations sequentially — no picking stage, no decider.
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

    if (state.roomData.gameType === 'maptap') {
        // MapTap is sequential — no picking stage, just advance.
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
    hide($('#stage-maptap'));
    hide($('#stage-picking'));
    show($('#stage-end'));

    if (state.timerRaf) { cancelAnimationFrame(state.timerRaf); state.timerRaf = null; }

    const ranked = Scoring.rankPlayers(state.roomPlayers.map((p) => ({
        uid: p.uid,
        displayName: p.displayName,
        score: p.score || 0,
        streak: p.streak || 0
    })));

    // Podium
    const podium = $('#podium');
    podium.innerHTML = '';
    const medals = ['🥇', '🥈', '🥉'];
    const slotOrder = [1, 0, 2]; // visual: 2nd, 1st, 3rd
    for (const orderIdx of slotOrder) {
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

    // Summary line
    const winner = ranked[0];
    const me = ranked.find((p) => state.user && p.uid === state.user.uid);
    if (winner && me && winner.uid === me.uid) {
        setText($('#end-summary'), '🎉 You won! Nice work.');
    } else if (winner) {
        setText($('#end-summary'), `${winner.displayName} took it home with ${winner.score} points.`);
    } else {
        setText($('#end-summary'), 'No scores recorded.');
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

    // Host can replay
    $('#end-again-btn').hidden = !isHost;

    // Write XP / wins / games to profile (once per game)
    if (state.user && me && endStageWrittenForRoom !== state.roomCode) {
        endStageWrittenForRoom = state.roomCode;
        await writeEndOfGameStats(me, winner && winner.uid === me.uid);
    }
}

async function writeEndOfGameStats(me, didWin) {
    if (!state.user) return;
    try {
        const xp = Scoring.xpFromScore(me.score);
        const userRef = doc(db, 'users', state.user.uid);
        await updateDoc(userRef, {
            'triviaProfile.xp': increment(xp),
            'triviaProfile.gamesPlayed': increment(1),
            'triviaProfile.wins': increment(didWin ? 1 : 0),
            'triviaProfile.lastPlayedAt': serverTimestamp()
        });
        // Refresh local profile cache for the profile view
        if (state.profile) {
            state.profile.xp = (state.profile.xp || 0) + xp;
            state.profile.gamesPlayed = (state.profile.gamesPlayed || 0) + 1;
            state.profile.wins = (state.profile.wins || 0) + (didWin ? 1 : 0);
        }
        // Denormalized leaderboard write
        const lbRef = doc(db, 'triviaLeaderboard', state.user.uid);
        await setDoc(lbRef, {
            uid: state.user.uid,
            displayName: me.displayName,
            xp: (state.profile && state.profile.xp) || xp,
            gamesPlayed: (state.profile && state.profile.gamesPlayed) || 1,
            wins: (state.profile && state.profile.wins) || (didWin ? 1 : 0),
            lastPlayedAt: serverTimestamp()
        }, { merge: true });
    } catch (err) {
        console.warn('End-of-game profile write failed:', err);
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

    const isMapTap = state.roomData && state.roomData.gameType === 'maptap';

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
    const aggregates = isMapTap
        ? computeMapTapAggregates(columns, answersByUid)
        : computeTriviaAggregates(columns, answersByUid);
    aggregates.forEach((card) => {
        const div = document.createElement('div');
        div.className = 'end-recap-stat' + (card.isMine ? ' is-mine' : '');
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
    let headHTML = `<th>#</th><th>${isMapTap ? 'Location' : 'Question'}</th>`;
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
        if (isMapTap) {
            rowHTML +=
                '<td class="col-question">' +
                `<span class="recap-q-text">${escapeHtml(q.name || '—')}</span>` +
                `<span class="recap-q-meta">${escapeHtml(q.country || '')}</span>` +
                '</td>';
        } else {
            const correctText = q.choices ? q.choices[q.correctIndex] : '';
            rowHTML +=
                '<td class="col-question">' +
                `<span class="recap-q-text">${escapeHtml(q.question || '—')}</span>` +
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

        colResults.forEach(({ col, ans }) => {
            const isMe = state.user && col.uid === state.user.uid;
            if (!ans) {
                rowHTML += `<td class="col-result ${isMe ? 'is-mine' : ''}"><span class="recap-result-zero">—</span></td>`;
                return;
            }
            if (isMapTap) {
                const pts = Number(ans.points) || 0;
                rowHTML +=
                    `<td class="col-result ${isMe ? 'is-mine' : ''}">` +
                    `<span class="${pts > 0 ? 'recap-result-points' : 'recap-result-zero'}">+${pts}</span>` +
                    `<span class="recap-result-dist">${Math.round(Number(ans.distanceKm) || 0).toLocaleString()} km off</span>` +
                    '</td>';
            } else {
                const pts = Number(ans.points) || 0;
                const pickClass = ans.correct ? 'is-correct' : 'is-wrong';
                rowHTML +=
                    `<td class="col-result ${isMe ? 'is-mine' : ''}">` +
                    `<span class="${pts > 0 ? 'recap-result-points' : 'recap-result-zero'}">${pts > 0 ? '+' + pts : '0'}</span>` +
                    `<span class="recap-result-pick ${pickClass}">${escapeHtml(ans.answerText || '—')}</span>` +
                    '</td>';
            }
        });

        // Winner badge — tie if more than one player hit bestPoints (>0).
        let winnerCell = '<span class="recap-result-zero">—</span>';
        if (bestPoints > 0) {
            const winners = colResults.filter((r) => r.points === bestPoints);
            if (winners.length === 1) {
                const w = winners[0].col;
                const isMe = state.user && w.uid === state.user.uid;
                winnerCell = `🏆 ${escapeHtml(isMe ? 'You' : w.displayName)}`;
            } else {
                winnerCell = '🤝 Tie';
            }
        }
        rowHTML += `<td class="col-winner">${winnerCell}</td>`;
        tr.innerHTML = rowHTML;
        tbody.appendChild(tr);
    });

    const qNoun = questions.length === 1 ? 'question' : (isMapTap ? 'locations' : 'questions');
    setText($('#end-recap-sub'),
        `${questions.length} ${qNoun} · comparing ${columns.length} player${columns.length === 1 ? '' : 's'}`);
    section.hidden = false;
}

function computeMapTapAggregates(columns, answersByUid) {
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

async function playAgain() {
    if (!state.roomCode || !state.roomData) return;
    if (!(state.user && state.roomData.hostUid === state.user.uid)) return;
    const nextRound = (state.roomData.round || 1) + 1;
    const isMapTap = state.roomData.gameType === 'maptap';

    if (isMapTap) {
        // Re-fetch fresh locations from REST Countries. Same total count.
        const locations = await MapTapLocations.fetchLocations(
            state.roomData.totalQuestions,
            shuffle
        );
        await updateDoc(doc(db, 'triviaRooms', state.roomCode), {
            status: 'lobby',
            currentQuestionIndex: 0,
            currentQuestionId: null,
            questionStartedAt: null,
            revealStartedAt: null,
            playedQuestionIds: [],
            questions: locations,
            totalQuestions: locations.length,
            round: nextRound,
            finishedAt: null
        });
    } else {
        // Trivia: re-deal questions using the same source + reset picker.
        const { questions, packId, packName } = await buildQuestionsForRound(
            state.roomData.packId || 'default',
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
            finishedAt: null
        });
    }

    state.currentAnswers = [];
    endStageWrittenForRoom = null;
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
    }, (err) => {
        console.warn('Leaderboard listener error:', err);
    });
}

function stopLeaderboardListener() {
    if (state.leaderboardUnsub) {
        try { state.leaderboardUnsub(); } catch (e) {}
        state.leaderboardUnsub = null;
    }
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

    entries.forEach((e, i) => {
        const tr = document.createElement('tr');
        if (state.user && e.uid === state.user.uid) tr.classList.add('is-me');
        const pct = e.gamesPlayed ? Math.round(100 * (e.wins || 0) / e.gamesPlayed) : 0;
        const lastPlayed = e.lastPlayedAt && e.lastPlayedAt.toDate ? e.lastPlayedAt.toDate() : null;
        const lastStr = lastPlayed ? formatRelativeDate(lastPlayed) : '—';
        tr.innerHTML =
            `<td>${i+1}</td>` +
            `<td>${escapeHtml(e.displayName || 'Player')}</td>` +
            `<td class="col-xp">${e.xp || 0}</td>` +
            `<td class="col-games">${e.gamesPlayed || 0}</td>` +
            `<td class="col-wins">${e.wins || 0}</td>` +
            `<td class="col-winpct">${pct}%</td>` +
            `<td>${escapeHtml(lastStr)}</td>`;
        body.appendChild(tr);
    });
}

function formatRelativeDate(d) {
    const diff = Date.now() - d.getTime();
    const day = 24 * 60 * 60 * 1000;
    if (diff < day) return 'today';
    if (diff < 2 * day) return 'yesterday';
    if (diff < 7 * day) return Math.floor(diff / day) + 'd ago';
    return d.toLocaleDateString();
}

function wireLeaderboard() {
    $('#leaderboard-period').addEventListener('change', renderLeaderboardEntries);
    $('#leaderboard-category').addEventListener('change', renderLeaderboardEntries);
}

/* =====================================================================
 * Boot
 * ===================================================================== */

async function boot() {
    wireViewTabs();
    wireLobby();
    wirePremiumModal();
    wireProfileView();
    wireCustomPack();
    wireLeaderboard();
    renderPackOptions();

    await waitForFirebaseAuth();
    window.firebaseAuth.onAuthStateChange(applyAuthState);
    // Initial state — onAuthStateChange fires synchronously if ready.

    // Preload the default question pack so creating a room is snappy.
    loadDefaultPack().catch(() => { /* fetch errors surface at create-time */ });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
} else {
    boot();
}
