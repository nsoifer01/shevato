// FPL Planner: UI orchestration.
//
// The shape of this file is the shape of the product: get a Team ID, load the
// public data, normalize it, hand it to the optimizer, and render one answer.
// Everything that computes lives in js/engine (pure, tested, no DOM) and
// everything that draws lives in js/ui. This file owns the sequence, the
// failure states and the persistence.
//
// TWO RULES IT ENFORCES
//
// 1. Sample data is never a silent fallback. It loads only when the URL asks
//    for it with ?demo=1, and while it is in use every surface says so.
// 2. A plan is withheld rather than faked. If player availability could not be
//    refreshed, the screen says what is missing instead of showing a confident
//    recommendation built on stale injury news.

import { fplApi, NotFoundError, ProxyUnavailableError } from './data/api.js';
import { isDemoRequested, loadSampleData } from './data/sample.js';
import { loadModel } from './data/model.js';
import { buildGameState } from './engine/normalize.js';
import { buildSquadState, picksCarryLineup } from './engine/squad.js';
import { formatFreeTransfers } from './engine/transfer-state.js';
import { el, mount, clear, stat } from './ui/dom.js';
import { relativeTime, dateTime, formatMoney, rank, points } from './ui/format.js';
import { assessData, inputFingerprint, outdatedReason } from './ui/plan-model.js';
import { planInputs, diffPlanVersions, actionKey } from './ui/plan-diff.js';
import * as store from './ui/store.js';
import { banner, btn, progressView, sampleBanner, sampleTag, freshness, planChangeCard } from './ui/parts.js';
import {
  heroCard, transfersCard, draftCard, chipCard, pitchCard, whyCard, whyNotCard,
  futureCard, alternativesCard, statusCard, withheldView,
} from './ui/dashboard.js';
import { historyView, planVersionsView } from './ui/history.js';
import { settingsView } from './ui/settings.js';
import { preSeasonIntro, manualSquadView, manualSquadState } from './ui/preseason.js';
import {
  createScenario, applyTransfer, swapPlayers, setCaptain, setViceCaptain, moveBench,
  undo as undoScenario, reset as resetScenario, scenarioSquadState,
} from './ui/scenario.js';
import { createSandboxView } from './ui/sandbox.js';
import { createPlanRunner } from './ui/plan-runner.js';
import { createPlayerDrawer } from './ui/player-drawer.js';

/* --------------------------------------------------------------- analytics */

// Resolved at call time because /assets/js/analytics.js is deferred and this
// module can run first. The privacy policy commits this app to exactly one
// event, carrying the optimizer duration and the model version: never the team
// ID, the squad, a player name or a transfer.
function track(method, ...args) {
  try {
    const a = typeof window !== 'undefined' ? window.shevatoAnalytics : null;
    if (a && typeof a[method] === 'function') a[method](...args);
  } catch {
    /* analytics must never break the app */
  }
}

/* -------------------------------------------------------------------- state */

const state = {
  sample: false,
  sampleMeta: null,
  // The trained model artifact, and whether it loaded. A plan is built either
  // way, so the status travels to the model and data status panel rather than
  // being thrown away.
  modelStatus: null,
  teamId: null,
  gameState: null,
  entry: null,
  history: null,
  transfers: null,
  picks: null,
  squadState: null,
  pendingSquad: null,
  planGw: null,
  picksGw: null,
  bundle: null,
  isDraft: false,
  preSeason: false,
  preSeasonStage: 'intro',
  manualIds: [],
  view: 'plan',
  pitchMode: 'recommended',
  pitchDisplay: 'pitch',
  // THE SANDBOX, and the rule it exists to keep.
  //
  // `squadState` above is the manager's real FPL squad and nothing in here may
  // touch it. `scenario` is a separate editable copy; `scenarioBundle` is what
  // the planner says when asked to start from that copy, held apart from
  // `bundle` so a hypothetical recommendation can never be mistaken for the
  // real one or written to storage.
  scenario: null,
  scenarioBundle: null,
  scenarioBusy: false,
  // Set once the deadline for the planned gameweek has been reacted to, so the
  // reaction is a one-off at the boundary rather than a repeating poll.
  deadlineHandled: false,
  // True when the fifteen on screen came back from storage rather than being
  // built this visit, so the UI can say so and offer to start over.
  restoredSquad: false,
  // The last failure to load data, kept so the Plan tab can offer recovery
  // again after the user has looked at another tab. Cleared by any successful
  // plan.
  loadError: null,
  sandbox: { selection: null, showXp: false, picker: null, error: null },
  settings: store.getSettings(),
  fingerprint: null,
  notice: null,
  outdated: null,
  // The last plan version calculated in this session, and how the current one
  // differs from it. `lastVersion` is only the in-memory copy: after a reload
  // the comparison is made against the version in the synced plan history, so
  // "previously we said roll" survives closing the tab.
  lastVersion: null,
  planChange: null,
  disclosures: { why: false, whyNot: false, alts: false, status: false },
  captains: new Map(),
  historyLoaded: false,
  lastChecked: null,
  busy: false,
  // Slots the freshness ticker redraws in place, so a re-render never closes a
  // disclosure the user just opened or clears a "why not" answer.
  slots: { hero: null, fresh: null },
};

const runner = createPlanRunner();
let appEl = null;
let landingEl = null;
let ticker = null;
let modelPromise = null;
let drawer = null;

/* --------------------------------------------------------------- utilities */

const qs = (id) => document.getElementById(id);

function showLanding(message = null, keepValue = null) {
  if (ticker) { clearInterval(ticker); ticker = null; }
  appEl.hidden = true;
  clear(appEl);
  landingEl.hidden = false;
  const error = qs('fpl-onboard-error');
  const input = qs('fpl-team-id');
  if (message) {
    error.textContent = message;
    error.hidden = false;
  } else {
    error.hidden = true;
  }
  if (keepValue !== null) input.value = keepValue;
  if (message) input.focus();
}

function showApp() {
  landingEl.hidden = true;
  appEl.hidden = false;
}

// Everything that renders a transient, still-computing state goes through here,
// so the live region is marked busy while the staged progress ticks over and a
// screen reader announces the finished plan once rather than every stage.
function setBusy(node) {
  showApp();
  appEl.setAttribute('aria-busy', 'true');
  mount(appEl, node);
}

/* ------------------------------------------------------------------ loading */

async function loadWorld({ force = false } = {}) {
  const [bootstrap, fixtures] = await Promise.all([
    fplApi.getBootstrap({ force }),
    fplApi.getFixtures({ force }),
  ]);
  state.gameState = buildGameState(bootstrap.data, fixtures.data, { fetchedAt: bootstrap.fetchedAt });
  state.picksGw = state.gameState.currentEvent;
  state.planGw = state.gameState.nextEvent ?? state.gameState.currentEvent ?? 1;
}

async function loadTeam({ force = false } = {}) {
  const [entry, history, transfers] = await Promise.all([
    fplApi.getEntry(state.teamId, { force }),
    fplApi.getEntryHistory(state.teamId, { force }),
    fplApi.getEntryTransfers(state.teamId, { force }),
  ]);
  state.entry = entry.data;
  state.history = history.data;
  state.transfers = transfers.data;

  // The squad comes from the last gameweek that was played. Before GW1 there is
  // no such gameweek and this call 404s for every manager, which is the signal
  // that routes the app into pre-season mode.
  state.picks = null;
  if (state.gameState.seasonStarted && state.picksGw) {
    try {
      const picks = await fplApi.getEntryPicks(state.teamId, state.picksGw, { force });
      state.picks = picks.data;
    } catch (err) {
      if (!(err instanceof NotFoundError)) throw err;
    }
  }
  state.preSeason = !state.picks;
}

/* ------------------------------------------------------------------- model */

// Fetched once per page load, started at boot so the file is usually in hand by
// the time a plan is asked for, and awaited before every run so a plan is never
// computed on the analytic priors while the trained model is still in flight.
// loadModel never rejects: a failure comes back as ok:false with a reason, and
// the plan is built without it.
function ensureModel() {
  if (!modelPromise) {
    modelPromise = loadModel().then((status) => {
      state.modelStatus = status;
      return status;
    });
  }
  return modelPromise;
}

/* ------------------------------------------------------------------ running */

function planOptions() {
  return {
    horizon: state.settings.horizon,
    risk: state.settings.risk,
    seed: 7,
    sample: state.sample,
    dataVersion: state.gameState.fetchedAt,
    // Plain JSON, so it survives the structured clone into the worker, where
    // the plan is actually computed. Null means the analytic priors, and
    // dataStatus.modelVersion then reports them by name.
    model: state.modelStatus && state.modelStatus.ok ? state.modelStatus.model : null,
  };
}

async function computePlan(squadState, { reason }) {
  const done = [];
  setBusy(progressView({
    activeKey: 'load-team',
    done,
    title: state.sample ? 'Building a plan from the sample dataset' : 'Building your gameweek plan',
    sub: `Gameweek ${squadState.gw}`,
  }));

  const onProgress = (stage) => {
    setBusy(progressView({
      activeKey: stage.key,
      done,
      title: state.sample ? 'Building a plan from the sample dataset' : 'Building your gameweek plan',
      sub: stage.label,
    }));
    done.push(stage.key);
  };

  await ensureModel();

  const bundle = await runner.run({
    gameState: state.gameState,
    squadState,
    options: planOptions(),
    onProgress,
  });

  state.bundle = bundle;
  state.loadError = null;
  state.squadState = squadState;
  // "Draft" to the UI means "a pre-season opening squad", whichever way it
  // was encoded: built by the optimizer (source 'draft') or typed/restored
  // (source 'manual', which only exists before GW1). Keying this off 'draft'
  // alone gave the restored squad the in-season hero, chip card and money
  // copy while the header said transfers were unlimited.
  state.isDraft = squadState.source === 'draft' || squadState.source === 'manual';
  state.fingerprint = inputFingerprint(squadState, state.gameState, bundle.current);
  // A fresh plan is a fresh deadline to watch.
  state.deadlineHandled = false;

  // Diff BEFORE persisting, or the new version is the one it compares against.
  // Sample mode never reads the stored history: those versions belong to a real
  // team and diffing a synthetic plan against them would invent a change.
  const record = versionRecord(bundle, reason);
  const previous = state.lastVersion
    || (state.sample ? null : store.latestVersion(store.getPlanHistory(), bundle.current.gw));
  state.planChange = diffPlanVersions(previous, record, { gameState: state.gameState });
  state.lastVersion = record;

  persistPlan(bundle, record);

  // The one analytics event this app sends. Duration and model version only.
  track('trackAction', 'gameweek_plan_calculated', {
    optimizer_ms: Math.round(bundle.dataStatus.durationMs || 0),
    model_version: bundle.dataStatus.modelVersion,
  });

  renderApp();
  startTicker();
}

// One stored version: the recommendation, plus the prices, statuses and
// projections it was built from. The second half is what lets the NEXT plan say
// which field moved instead of narrating a guess.
function versionRecord(bundle, reason) {
  return {
    computedAt: bundle.current.computedAt,
    reason,
    fingerprint: state.fingerprint,
    plan: store.compactPlan(bundle.current),
    inputs: planInputs({
      plan: bundle.current,
      projections: bundle.projections,
      squadState: bundle.squadState,
      gameState: state.gameState,
      dataStatus: bundle.dataStatus,
    }),
  };
}

// Nothing from the sample dataset is ever written to storage: a synthetic squad
// restored on a later visit would be indistinguishable from a real one.
function persistPlan(bundle, record) {
  if (state.sample) return;
  store.setTeamId(state.teamId);
  // Ids and just enough context to know they still apply. `bundle.current.squad`
  // rather than the squad state's picks, because a pre-season draft has no
  // picks: the fifteen it recommends IS the squad worth remembering.
  store.setSquadSnapshot({
    teamId: state.teamId,
    season: state.gameState.rules.season,
    gw: bundle.current.gw,
    source: bundle.squadState.source,
    ids: (bundle.current.squad || []).slice(),
    savedAt: new Date().toISOString(),
  });
  const history = store.getPlanHistory();
  const latest = store.latestVersion(history, bundle.current.gw);
  // A rerun on identical inputs that lands on the identical answer is not a new
  // version. The fingerprint describes the squad and the game, not the planner
  // settings, so a horizon change keeps it while genuinely changing the answer:
  // that is a version, and the action has to be compared as well.
  if (latest && latest.fingerprint === record.fingerprint && actionKey(latest.plan) === actionKey(record.plan)) return;
  store.setPlanHistory(store.recordPlanVersion(history, bundle.current.gw, {
    plan: bundle.current,
    reason: record.reason,
    computedAt: record.computedAt,
    fingerprint: record.fingerprint,
    inputs: record.inputs,
  }));
}

/* ------------------------------------------------------------------- boot */

async function connectAndPlan({ reason = 'first-calculation' } = {}) {
  if (state.busy) return;
  state.busy = true;
  try {
    setBusy(progressView({ activeKey: null, title: 'Loading Fantasy Premier League data', sub: 'Players, prices, news and fixtures' }));
    await loadWorld();
    await loadTeam();

    // The link is saved as soon as the API confirms the team exists, not when a
    // plan is finished: pre-season there is no plan to finish, and the ID still
    // has to survive a reload and reach the user's other devices.
    if (!state.sample) store.setTeamId(state.teamId);

    if (state.preSeason) {
      // A squad built or typed on an earlier visit comes back, rather than the
      // user being shown the empty intro again and asked to retype fifteen
      // players. Only when it is about THIS team, season and gameweek.
      const snapshot = state.sample ? null : store.getSquadSnapshot();
      if (store.snapshotApplies(snapshot, {
        teamId: state.teamId,
        season: state.gameState.rules.season,
        gw: state.planGw,
      }) && snapshot.ids.every(id => state.gameState.players.has(id))) {
        state.manualIds = snapshot.ids.slice();
        state.restoredSquad = true;
        // computePlan directly rather than planManualSquad: this branch already
        // holds the busy flag, and planManualSquad refuses to run while it is
        // held, so routing through it restored nothing at all and left the user
        // on a blank screen.
        await computePlan(
          manualSquadState({ ids: snapshot.ids, gameState: state.gameState, gw: state.planGw, entry: state.entry }),
          { reason: 'restored-squad' },
        );
        return;
      }
      state.preSeasonStage = 'intro';
      renderApp();
      return;
    }

    const squadState = buildSquadState({
      entry: state.entry,
      history: state.history,
      transfers: state.transfers,
      picks: state.picks,
      gameState: state.gameState,
      gw: state.planGw,
    });

    // A squad that no longer matches the last plan is not a mistake, it is the
    // new input. The notice says so in neutral words and nothing more.
    const previous = store.latestVersion(store.getPlanHistory(), state.planGw);
    const nextFingerprint = inputFingerprint(squadState, state.gameState);
    const change = previous ? outdatedReason(previous.fingerprint, nextFingerprint) : null;
    state.notice = change;

    await computePlan(squadState, { reason: change ? change.code : reason });
  } catch (err) {
    handleLoadError(err);
  } finally {
    state.busy = false;
  }
}

function handleLoadError(err) {
  if (err instanceof NotFoundError && /^entry\//.test(err.path || '')) {
    showLanding('We could not find an FPL team with that ID. Check the number in the address bar on the Fantasy Premier League site, after /entry/.', state.teamId);
    return;
  }

  // The environment is wrong rather than the data. Say which, and how to fix
  // it, instead of listing a fetch failure per source: those all say the same
  // uninformative thing and bury the one sentence that would help.
  if (err instanceof ProxyUnavailableError) {
    showApp();
    mount(appEl, [
      topBar(),
      banner({
        tone: 'error',
        mark: '!',
        title: 'Live Fantasy Premier League data is not reachable from here',
        text: String(err.message),
        actions: [
          btn('Try again', () => connectAndPlan({ reason: 'manual' }), { variant: 'fpl-btn-primary' }),
          btn('Use the sample data instead', () => { location.search = '?demo=1'; }, { variant: 'fpl-btn-quiet' }),
        ],
      }),
    ]);
    return;
  }

  // Remembered so the Plan tab can offer these actions again after the user
  // has looked at History or Settings. Without it, navigating away from a
  // failure and back rendered a bare "No plan yet." with no way to recover.
  state.loadError = err;
  showApp();
  mount(appEl, [topBar(), loadFailureView(err)]);
}

// What a person is told when the data could not be loaded.
//
// The technical text stays reachable (a `title` on the row, and the console
// already has it), but a raw exception is not an explanation: "Cannot read
// properties of undefined (reading 'rules')" and "proxy 503 for
// bootstrap-static" were the primary message a stuck user read.
function loadFailureView(err) {
  const failed = fplApi.getDataStatus().sources.filter(s => !s.ok);
  return banner({
    tone: 'error',
    mark: '!',
    title: 'We could not load the data this plan needs',
    text: 'No plan is shown, because a plan built on missing data would look exactly as confident as a good one.',
    list: failed.length
      ? failed.map(s => ({ text: `${s.name}: ${friendlyFailure(s.error)}`, title: s.error || null }))
      : [{ text: friendlyFailure(String(err && err.message || err)), title: String(err && err.message || err) }],
    actions: [
      btn('Try again', () => connectAndPlan({ reason: 'manual' }), { variant: 'fpl-btn-primary' }),
      btn('Use a different Team ID', () => showLanding(null, state.teamId), { variant: 'fpl-btn-quiet' }),
    ],
  });
}

// One sentence per failure class, from the shape of the error rather than its
// text where possible.
function friendlyFailure(message) {
  const m = String(message || '');
  if (/\b(429|rate)/i.test(m)) return 'Fantasy Premier League is rate limiting requests right now.';
  if (/\b5\d\d\b|upstream_unavailable/i.test(m)) return 'Fantasy Premier League did not respond. This is usually brief, and often happens while a gameweek is being processed.';
  if (/\b403\b|forbidden/i.test(m)) return 'This copy of the app is not allowed to read Fantasy Premier League data.';
  if (/\b404\b|not_found/i.test(m)) return 'Fantasy Premier League has no data at that address yet.';
  if (/network|failed to fetch|abort/i.test(m)) return 'The request did not complete. Check your connection and try again.';
  return 'It could not be loaded.';
}

/* ----------------------------------------------------------------- refresh */

// Re-reads the inputs without recomputing. If anything material moved, the plan
// on screen is marked outdated and a recalculate action appears: continuing to
// present it as current would be the dishonest option.
async function refreshInputs() {
  if (state.busy) return;
  state.busy = true;
  try {
    const wasSeasonStarted = state.gameState ? state.gameState.seasonStarted : false;
    await loadWorld({ force: true });
    await loadTeam({ force: true });
    // Recorded here rather than after the in-season branch: a pre-season user
    // pressing "Check for changes" was otherwise given no evidence the button
    // had done anything at all.
    state.lastChecked = Date.now();

    if (state.preSeason || !state.picks) {
      // The check itself can be what discovers the season has started.
      if (!wasSeasonStarted && state.gameState.seasonStarted && state.picks) {
        state.bundle = null;
        state.scenario = null;
        state.scenarioBundle = null;
        state.preSeason = false;
        state.busy = false;
        await connectAndPlan({ reason: 'season-started' });
        return;
      }
      renderApp();
      return;
    }
    const squadState = buildSquadState({
      entry: state.entry, history: state.history, transfers: state.transfers,
      picks: state.picks, gameState: state.gameState, gw: state.planGw,
    });
    const next = inputFingerprint(squadState, state.gameState);
    state.outdated = outdatedReason(state.fingerprint, next);
    state.pendingSquad = state.outdated ? squadState : null;
    renderApp();
  } catch (err) {
    handleLoadError(err);
  } finally {
    state.busy = false;
  }
}

async function recalculate(reason) {
  if (state.busy) return;
  state.busy = true;
  try {
    const squadState = state.pendingSquad || state.squadState;
    state.outdated = null;
    state.pendingSquad = null;
    state.notice = null;
    await computePlan(squadState, { reason });
  } catch (err) {
    handleLoadError(err);
  } finally {
    state.busy = false;
  }
}

/* -------------------------------------------------------------- pre-season */

async function buildOpeningSquad() {
  if (state.busy) return;
  state.busy = true;
  try {
    const squadState = buildSquadState({
      entry: state.entry, history: state.history, transfers: state.transfers,
      picks: null, gameState: state.gameState, gw: state.planGw,
    });
    await computePlan(squadState, { reason: 'first-calculation' });
  } catch (err) {
    handleLoadError(err);
  } finally {
    state.busy = false;
  }
}

async function planManualSquad(ids, { reason = 'manual' } = {}) {
  if (state.busy) return;
  state.busy = true;
  state.manualIds = ids;
  try {
    const squadState = manualSquadState({ ids, gameState: state.gameState, gw: state.planGw, entry: state.entry });
    await computePlan(squadState, { reason });
  } catch (err) {
    handleLoadError(err);
  } finally {
    state.busy = false;
  }
}

/* ------------------------------------------------------------------ render */

function topBar() {
  const entry = state.entry || {};
  const squad = state.bundle ? state.bundle.squadState : state.squadState;
  const teamName = squad ? squad.entryName : entry.name;
  const manager = squad ? squad.managerName : `${entry.player_first_name || ''} ${entry.player_last_name || ''}`.trim();

  // Not ARIA tabs on purpose: these switch whole views (no tabpanel pairing),
  // so they stay plain buttons with aria-current marking the active one.
  const tabs = el('div', { class: 'fpl-tabs fpl-seg', 'aria-label': 'App sections' }, [
    ['plan', 'Plan', 'fa-clipboard-list'],
    ['history', 'History', 'fa-clock-rotate-left'],
    ['settings', 'Settings', 'fa-gear'],
  ].map(([id, label, icon]) => el('button', {
    type: 'button',
    class: state.view === id ? 'is-on' : '',
    'aria-current': state.view === id ? 'page' : null,
    onclick: () => selectView(id),
  }, [
    el('i', { class: `fa-solid ${icon} fpl-tab-icon`, 'aria-hidden': 'true' }),
    label,
  ])));

  const stats = [];
  // PRE-SEASON HAS NO ACCOUNT STATE. There is no rank, no points total and no
  // team value before a ball is kicked: FPL has not opened the season, so those
  // fields are either last season's or a placeholder. Showing BANK £100.0m and
  // SQUAD VALUE £100.0m read as a contradiction against a recommended fifteen
  // costing £99.5m one card below, because neither figure was what it looked
  // like: both were just the starting budget printed twice. What is real before
  // the deadline is the budget, what the recommendation spends of it, and what
  // is left, so that is what this says.
  const preSeason = !!state.preSeason;
  if (!preSeason && (squad || entry.summary_overall_rank)) {
    stats.push(stat('Overall rank', rank((squad && squad.overallRank) ?? entry.summary_overall_rank)));
    stats.push(stat('Total points', points((squad && squad.totalPoints) ?? entry.summary_overall_points)));
  }
  if (preSeason && squad) {
    const budget = state.gameState.rules.budgetTenths;
    const plan = state.bundle ? state.bundle.current : null;
    // A draft squad holds no picks, so its cost is what the recommendation
    // spent. A squad the user typed in holds fifteen, and its cost is the
    // budget less what the entry left in the bank.
    const spent = squad.source === 'draft'
      ? (plan ? plan.moneyOutTenths : null)
      : squad.squadValueTenths - squad.bankTenths;
    stats.push(stat('Starting budget', formatMoney(budget)));
    if (Number.isFinite(spent)) {
      stats.push(stat(squad.source === 'draft' ? 'Recommended squad' : 'Squad cost', formatMoney(spent)));
      stats.push(stat('Bank after', formatMoney(budget - spent)));
    }
  } else if (squad && Number.isFinite(squad.bankTenths)) {
    stats.push(stat('Bank', formatMoney(squad.bankTenths)));
    stats.push(stat('Squad value', formatMoney(squad.squadValueTenths)));
  }
  if (squad) {
    // Before the first deadline this is a word, not a number: FPL allows
    // unlimited changes until it passes, and printing the five-transfer CAP
    // there was both meaningless and four too many.
    stats.push(stat('Free transfers', formatFreeTransfers(squad.freeTransfers, { untilGw: squad.gw })));
  }

  return el('div', { class: 'fpl-topbar' }, [
    el('div', { class: 'fpl-identity' }, [
      el('div', { class: 'fpl-team-name' }, [
        teamName || 'FPL Planner',
        state.sample ? sampleTag() : null,
      ]),
      el('div', { class: 'fpl-manager', text: manager ? `${manager} · Team ID ${state.teamId}` : `Team ID ${state.teamId}` }),
    ]),
    stats.length ? el('div', { class: 'fpl-idstats' }, stats) : null,
    tabs,
  ]);
}

function selectView(view) {
  state.view = view;
  if (!state.sample) store.setSettings({ lastView: view });
  state.settings.lastView = view;
  renderApp();
  if (view === 'history') loadCaptains();
  window.scrollTo({ top: 0 });
}

function freshnessRow() {
  const ds = state.bundle ? state.bundle.dataStatus : null;
  const now = Date.now();
  return el('div', { style: 'display:flex;align-items:center;gap:14px;flex-wrap:wrap' }, [
    freshness([
      ['Last synced', ds
        ? (state.sample ? `sample snapshot, ${dateTime(ds.fetchedAt)}` : relativeTime(ds.fetchedAt, now))
        : 'not yet'],
      ['Plan calculated', ds ? relativeTime(ds.planComputedAt, now) : 'not yet'],
      state.lastChecked ? ['Checked for changes', relativeTime(state.lastChecked, now)] : null,
    ]),
    btn('Check for changes', () => refreshInputs(), { variant: 'fpl-btn-quiet', size: 'fpl-btn-sm' }),
  ]);
}

function heroSlotContent() {
  const bundle = state.bundle;
  const event = state.gameState.events.find(e => e.id === bundle.current.gw) || null;
  return heroCard({
    bundle,
    gameState: state.gameState,
    event,
    now: Date.now(),
    isDraft: state.isDraft,
    sources: fplApi.getDataStatus().sources,
  });
}

function planView() {
  const bundle = state.bundle;
  // A failure screen that is navigated away from and back to used to come back
  // as a bare "No plan yet.", with the explanation and both recovery buttons
  // gone and only a reload left. The error is state, so the view can rebuild it.
  if (!bundle && state.loadError) return [topNotices(), loadFailureView(state.loadError)];
  if (!bundle) return el('p', { class: 'fpl-empty', text: 'No plan yet.' });

  const assessment = assessData({ sources: fplApi.getDataStatus().sources });
  if (assessment.withholdPlan) {
    return [topNotices(), withheldView({ assessment, onRetry: () => connectAndPlan({ reason: 'manual' }) })];
  }

  // A plan built from a payload with no season evidence in it is not a weak
  // recommendation, it is a confident-looking one assembled out of nothing: at
  // the statistics rollover every rate reads zero, the projections collapse to
  // appearance points and the optimizer captains a goalkeeper. Withheld for the
  // same reason stale injury data is.
  const evidence = bundle.dataStatus.evidence;
  if (evidence && evidence.usable === false) {
    return [topNotices(), withheldView({
      assessment: {
        reason: `${evidence.message} Fantasy Premier League clears last season's player totals when it rolls the new season over, and until the first matches are played there is nothing to project from.`,
        failed: [],
        stale: [],
      },
      onRetry: () => connectAndPlan({ reason: 'manual' }),
    })];
  }

  state.slots.fresh = el('div', {}, freshnessRow());
  state.slots.hero = el('div', {}, heroSlotContent());

  // The answer comes first, on every screen size. Freshness is context, so it
  // sits under the hero rather than pushing it below the fold on a phone.
  const nodes = [
    topNotices(),
    state.slots.hero,
    state.slots.fresh,
    state.isDraft
      ? draftCard({
        bundle,
        gameState: state.gameState,
        // Before the first deadline the squad on screen is a draft, so there
        // has to be a way back to changing it. Without these the only route to
        // a different fifteen was clearing storage.
        onEdit: () => { state.preSeasonStage = 'manual'; state.bundle = null; renderApp(); },
        onRebuild: () => { state.manualIds = []; state.bundle = null; state.preSeasonStage = 'intro'; renderApp(); },
        restored: state.restoredSquad,
      })
      : transfersCard({ bundle, gameState: state.gameState }),
  ];

  if (!state.isDraft) nodes.push(chipCard({ bundle, gameState: state.gameState }));

  nodes.push(pitchCard({
    bundle,
    gameState: state.gameState,
    // The selected view is APP state, not a property of the squad. Deriving it
    // from whether picks exist (which is how this read before) pinned the card
    // to "recommended" on every re-render for anyone without an imported squad,
    // and since every sandbox edit re-renders, a pre-season user was thrown out
    // of the scenario on every single click. pitchCard falls back on its own
    // when the remembered view is not available in the current state.
    initialMode: state.pitchMode,
    onModeChange: (mode) => { state.pitchMode = mode; },
    initialDisplay: state.pitchDisplay,
    onDisplayChange: (display) => { state.pitchDisplay = display; },
    onPlayerClick: (id, opts) => { if (drawer) drawer.open(id, opts); },
    // The editable third view. Passed as a thunk so it is only built when the
    // tab is actually open, and rebuilt from current state each time.
    sandbox: () => sandboxNode(),
  }));

  nodes.push(whyCard({
    bundle,
    gameState: state.gameState,
    sources: fplApi.getDataStatus().sources,
    open: state.disclosures.why,
    onToggle: (open) => { state.disclosures.why = open; },
  }));

  nodes.push(whyNotCard({
    bundle,
    gameState: state.gameState,
    open: state.disclosures.whyNot,
    onToggle: (open) => { state.disclosures.whyNot = open; },
    onAsk: (playerId) => runner.whyNot(playerId),
  }));

  nodes.push(futureCard({ bundle, gameState: state.gameState, sources: fplApi.getDataStatus().sources }));
  nodes.push(alternativesCard({
    bundle,
    open: state.disclosures.alts,
    onToggle: (open) => { state.disclosures.alts = open; },
  }));
  nodes.push(statusCard({
    bundle,
    sources: fplApi.getDataStatus().sources,
    runnerMode: runner.mode,
    modelStatus: state.modelStatus,
    open: state.disclosures.status,
    onToggle: (open) => { state.disclosures.status = open; },
  }));

  return nodes;
}

/* ----------------------------------------------------------------- sandbox */

// The sandbox view is created once and updated in place. Rebuilding the whole
// app on every scenario click is what made the feature flicker and jump: a full
// DOM replacement defeats scroll anchoring and throws focus to <body>. The view
// diffs its props on object identity (every scenario edit returns a new
// object), so app.js just pushes the current state down after each action.
let sandboxView = null;

// The editable copy of the squad, created the first time the user opens the
// scenario tab and kept for the session. It is seeded from the imported squad,
// or from the recommendation when there are no picks to copy (pre-season).
function ensureScenario() {
  if (!state.scenario && state.bundle) {
    state.scenario = createScenario({
      squadState: state.squadState,
      gameState: state.gameState,
      plan: state.bundle.current,
      // "Current" only when the picks encode a real lineup. A manual squad
      // holds fifteen picks but no arrangement, so its sandbox seeds from
      // the plan, the same as a draft's.
      origin: picksCarryLineup(state.squadState) ? 'current' : 'recommended',
    });
  }
  return state.scenario;
}

function sandboxContext() {
  return { gameState: state.gameState, squadState: state.squadState };
}

// One place where an edit is applied, so every action gets the same treatment:
// a refusal is shown rather than swallowed, and any successful edit invalidates
// the stored "planner from this team" answer, which was computed for a squad
// that no longer exists.
function applyScenarioEdit(result) {
  state.sandbox.error = result.error || null;
  if (!result.error) {
    state.scenario = result.scenario;
    state.scenarioBundle = null;
  }
}

function handleSandboxAction(type, payload = {}) {
  const sc = ensureScenario();
  const ctx = sandboxContext();
  const sel = state.sandbox.selection;
  state.sandbox.error = null;

  switch (type) {
    case 'select': {
      // In swap mode the second press names the partner. Otherwise a press
      // selects, and pressing the selected player again clears it.
      if (sel && sel.mode === 'swap' && sel.playerId !== payload.playerId) {
        applyScenarioEdit(swapPlayers(sc, ctx, sel.playerId, payload.playerId));
        state.sandbox.selection = state.sandbox.error ? sel : null;
      } else if (sel && sel.playerId === payload.playerId && sel.mode !== 'swap') {
        state.sandbox.selection = null;
      } else {
        state.sandbox.selection = { playerId: payload.playerId, mode: 'menu' };
      }
      break;
    }
    case 'swap-start':
      state.sandbox.selection = { playerId: payload.playerId, mode: 'swap' };
      break;
    case 'cancel':
      state.sandbox.selection = null;
      state.sandbox.picker = null;
      break;
    case 'captain':
      // The selection is kept: the armband appearing on the selected card IS
      // the feedback, and the player's remaining actions stay one press away.
      applyScenarioEdit(setCaptain(sc, ctx, payload.playerId));
      break;
    case 'vice':
      applyScenarioEdit(setViceCaptain(sc, ctx, payload.playerId));
      break;
    case 'bench-up':
      applyScenarioEdit(moveBench(sc, ctx, payload.playerId, 'up'));
      break;
    case 'bench-down':
      applyScenarioEdit(moveBench(sc, ctx, payload.playerId, 'down'));
      break;
    case 'transfer-open':
      state.sandbox.picker = { outId: payload.playerId };
      state.sandbox.selection = null;
      break;
    case 'transfer-pick':
      applyScenarioEdit(applyTransfer(sc, ctx, state.sandbox.picker.outId, payload.playerId));
      if (!state.sandbox.error) state.sandbox.picker = null;
      break;
    case 'undo':
      state.scenario = undoScenario(sc);
      state.scenarioBundle = null;
      state.sandbox.selection = null;
      // An open picker was priced against the squad that just un-happened.
      state.sandbox.picker = null;
      break;
    case 'reset':
      state.scenario = resetScenario(sc, {
        squadState: state.squadState,
        gameState: state.gameState,
        plan: state.bundle ? state.bundle.current : null,
      });
      state.scenarioBundle = null;
      state.sandbox.selection = null;
      state.sandbox.picker = null;
      break;
    case 'toggle-xp':
      state.sandbox.showXp = !state.sandbox.showXp;
      break;
    case 'copy-recommended': {
      // Start the experiment from the planner's answer instead of from the
      // current squad. A different question, so it gets its own entry point.
      state.scenario = createScenario({
        squadState: state.squadState,
        gameState: state.gameState,
        plan: state.bundle.current,
        origin: 'recommended',
      });
      state.scenarioBundle = null;
      state.sandbox.selection = null;
      state.sandbox.picker = null;
      break;
    }
    case 'recommend':
      recommendFromScenario();
      return;
    default:
      break;
  }
  syncSandbox();
}

// "What do you recommend from THIS team?"
//
// The same optimizer, on a SquadState the scenario produced. Deliberately not
// routed through computePlan: that one owns the real plan, writes plan history
// and fires the analytics event, and a hypothetical must do none of those.
async function recommendFromScenario() {
  if (state.scenarioBusy || !state.scenario) return;
  // The squad the question was asked about. If the user edits the scenario
  // while the worker is thinking, the answer that comes back describes a squad
  // that no longer exists and is DISCARDED rather than rendered over the newer
  // state. Identity comparison is exact because every edit returns a new
  // scenario object.
  const asked = state.scenario;
  state.scenarioBusy = true;
  state.sandbox.error = null;
  syncSandbox();
  try {
    const squadState = scenarioSquadState(asked, sandboxContext());
    const bundle = await runner.run({
      gameState: state.gameState,
      squadState,
      options: planOptions(),
    });
    if (state.scenario === asked) state.scenarioBundle = bundle;
  } catch (err) {
    if (state.scenario === asked) {
      state.sandbox.error = `The planner could not run on this team: ${err.message}`;
      state.scenarioBundle = null;
    }
  } finally {
    state.scenarioBusy = false;
    syncSandbox();
  }
}

// The props the sandbox view renders from: a straight read of app state. The
// view diffs these on identity, so this function allocates nothing but the
// container object.
function sandboxProps() {
  return {
    scenario: state.scenario,
    ctx: sandboxContext(),
    projections: state.bundle.projections,
    gw: state.bundle.current.gw,
    horizon: state.settings.horizon,
    discount: state.bundle.dataStatus.discount,
    showXp: state.sandbox.showXp,
    selection: state.sandbox.selection,
    picker: state.sandbox.picker,
    error: state.sandbox.error,
    busy: state.scenarioBusy,
    scenarioBundle: state.scenarioBundle,
  };
}

// Push the current state into the sandbox view IN PLACE. This is the whole
// render path for a scenario interaction: no renderApp(), no full rebuild, so
// scroll position, focus and the rest of the page are untouched.
function syncSandbox() {
  if (sandboxView && state.scenario && state.bundle) sandboxView.update(sandboxProps());
}

function sandboxNode() {
  const sc = ensureScenario();
  if (!sc) return el('p', { class: 'fpl-empty', text: 'No squad to edit yet.' });
  if (!sandboxView) {
    sandboxView = createSandboxView({
      onAction: handleSandboxAction,
      onPlayerDetails: (id) => { if (drawer) drawer.open(id); },
    });
  }
  sandboxView.update(sandboxProps());
  return sandboxView.node;
}

function topNotices() {
  const nodes = [];
  if (state.sample) nodes.push(sampleBanner());
  if (state.outdated) {
    nodes.push(banner({
      tone: 'warn',
      mark: '!',
      title: 'Plan outdated',
      text: state.outdated.text,
      actions: [btn('Recalculate', () => recalculate(state.outdated.code), { variant: 'fpl-btn-primary' })],
    }));
  } else if (state.planChange) {
    // The diff supersedes the generic "plan rebuilt" notice: it says the same
    // thing with the previous recommendation and the fields that moved.
    nodes.push(planChangeCard(state.planChange));
  } else if (state.notice) {
    nodes.push(banner({ tone: 'info', mark: 'i', title: 'Plan rebuilt', text: state.notice.text }));
  }
  if (state.bundle && state.bundle.dataStatus.stale) {
    nodes.push(banner({
      tone: 'warn',
      mark: '!',
      title: 'Working from older data',
      // No list: the only code that reaches here is `data_age`, and printing
      // that identifier as a bullet was an internal name for the reason the
      // sentence above already gives. Squad warnings are a different thing and
      // get their own banner below.
      text: 'The plan is built from the most recent copy we have, which is not fresh.',
    }));
  }

  // Squad warnings are their own thing and say so, rather than being reported
  // as the data being old.
  const squadWarnings = (state.bundle && state.bundle.dataStatus.squadWarnings) || [];
  if (squadWarnings.length) {
    nodes.push(banner({
      tone: 'warn',
      mark: '!',
      title: 'One number does not match Fantasy Premier League',
      text: 'The squad and prices are read from two Fantasy Premier League endpoints that are not always in step, most often because a price changed overnight. Transfers and affordability are calculated from your reconstructed selling prices.',
      list: squadWarnings.map(w => w.message),
    }));
  }
  return nodes;
}

function preSeasonView() {
  if (state.preSeasonStage === 'manual') {
    return manualSquadView({
      gameState: state.gameState,
      initialIds: state.manualIds,
      onPlan: (ids) => planManualSquad(ids),
      onCancel: () => { state.preSeasonStage = 'intro'; renderApp(); },
    });
  }
  return preSeasonIntro({
    gameState: state.gameState,
    nextEvent: state.planGw,
    teamName: state.entry ? state.entry.name : null,
    // The entry says whether this manager has played yet, which is what tells a
    // genuine new entry apart from a squad the API would not hand over.
    entry: state.entry,
    onBuild: () => buildOpeningSquad(),
    onManual: () => { state.preSeasonStage = 'manual'; renderApp(); },
    onRetry: () => connectAndPlan({ reason: 'manual' }),
  });
}

function historyTab() {
  // Fire and forget: the table renders now and the captain column fills in when
  // the per-gameweek picks land.
  loadCaptains();
  return [
    state.sample ? sampleBanner() : null,
    historyView({
      history: state.history,
      planHistory: store.getPlanHistory(),
      gameState: state.gameState,
      captainsByGw: state.captains,
    }),
    planVersionsView({ planHistory: store.getPlanHistory(), gameState: state.gameState }),
  ];
}

function settingsTab() {
  return [
    state.sample ? sampleBanner() : null,
    settingsView({
      settings: state.settings,
      teamId: state.teamId,
      squadState: state.bundle ? state.bundle.squadState : state.squadState,
      dataStatus: state.bundle ? state.bundle.dataStatus : null,
      sample: state.sample,
      onApply: (patch) => {
        state.settings = state.sample
          ? { ...state.settings, ...patch }
          : store.setSettings(patch);
        state.view = 'plan';
        recalculate('settings-changed');
      },
      onChangeTeam: () => showLanding(null, state.teamId),
      // The outcome sentence comes from the deletion itself, because only it
      // knows whether a cloud copy existed and whether it really went.
      onDataRemoved: (what, message) => {
        state.teamId = null;
        state.bundle = null;
        state.squadState = null;
        state.view = 'plan';
        if (what === 'delete-all') {
          state.settings = { ...store.DEFAULT_SETTINGS };
          showLanding(`${message} Enter a Team ID to start again.`, '');
          return;
        }
        showLanding(`${message} Your saved plans and settings are kept. Enter a Team ID to plan again.`, '');
      },
    }),
  ];
}

function renderApp() {
  showApp();
  // A rebuilt screen must not leave a drawer floating over content it no
  // longer belongs to.
  if (drawer) drawer.close();
  const body = state.view === 'history'
    ? historyTab()
    : state.view === 'settings'
      ? settingsTab()
      : (state.preSeason && !state.bundle)
        ? preSeasonView()
        : planView();
  // Settled: the plan (or the tab the user asked for) is fully rendered, so the
  // live region is free to announce it. Pairs with setBusy() above.
  appEl.setAttribute('aria-busy', 'false');
  mount(appEl, [topBar(), el('div', { class: 'fpl-view is-active' }, body)]);
}

// "Last synced", "Plan calculated" and the deadline countdown are only true for
// a moment, so they are redrawn on a timer. Only those two blocks are replaced:
// a full re-render would close a disclosure the user just opened.
function startTicker() {
  if (ticker) clearInterval(ticker);
  ticker = setInterval(() => {
    if (state.view !== 'plan' || !state.bundle || document.hidden) return;
    // The deadline is checked before anything is redrawn, because past it the
    // numbers on screen describe a gameweek that can no longer be changed.
    if (deadlineHasPassed()) { reactToDeadline(); return; }
    if (state.slots.hero && state.slots.hero.isConnected) {
      mount(state.slots.hero, heroSlotContent());
    }
    if (state.slots.fresh && state.slots.fresh.isConnected) {
      mount(state.slots.fresh, freshnessRow());
    }
  }, 30000);
}

/* --------------------------------------------------------------- deadlines */

// Has the deadline for the gameweek THIS PLAN was built for gone by?
function deadlineHasPassed(now = Date.now()) {
  if (!state.bundle || !state.gameState) return false;
  const event = state.gameState.events.find(e => e.id === state.bundle.current.gw);
  if (!event || !event.deadline) return false;
  return Date.parse(event.deadline) <= now;
}

// The deadline crossed while the app was open.
//
// A redraw is not enough here and never was: the plan on screen is advice about
// a gameweek that has locked, the squad FPL will now serve is a different one,
// and pre-season becomes in-season at this exact moment. So this re-reads the
// world rather than re-rendering it, and decides from the new data whether the
// existing plan can stand.
//
// It runs ONCE per crossing (`deadlineHandled`), so this is a reaction to a
// lifecycle boundary rather than polling.
async function reactToDeadline() {
  if (state.busy || state.deadlineHandled) return;
  state.deadlineHandled = true;
  state.busy = true;
  try {
    const wasSeasonStarted = state.gameState.seasonStarted;
    const wasPlanGw = state.planGw;

    await loadWorld({ force: true });
    await loadTeam({ force: true });
    state.lastChecked = Date.now();

    const seasonJustStarted = !wasSeasonStarted && state.gameState.seasonStarted;
    const gameweekMoved = state.planGw !== wasPlanGw;

    // The season starting invalidates the whole bundle: a pre-season draft plan
    // is advice about a squad that no longer describes anything, and the app
    // has to route to the import path instead of redrawing it.
    if (seasonJustStarted || state.preSeason !== !state.picks) {
      state.bundle = null;
      state.scenario = null;
      state.scenarioBundle = null;
      state.preSeason = !state.picks;
      state.deadlineHandled = false;
      state.busy = false;
      await connectAndPlan({ reason: 'deadline-passed' });
      return;
    }

    if (gameweekMoved || !state.picks) {
      state.outdated = {
        code: 'deadline-passed',
        text: `The Gameweek ${wasPlanGw} deadline has passed, so this plan can no longer be acted on. Recalculate for Gameweek ${state.planGw}.`,
      };
      state.pendingSquad = null;
    } else {
      // Same gameweek still being planned (the deadline that passed was an
      // earlier one). Treat it as an ordinary freshness check.
      const squadState = buildSquadState({
        entry: state.entry, history: state.history, transfers: state.transfers,
        picks: state.picks, gameState: state.gameState, gw: state.planGw,
      });
      const next = inputFingerprint(squadState, state.gameState);
      state.outdated = outdatedReason(state.fingerprint, next) || {
        code: 'deadline-passed',
        text: 'The deadline has passed, so this plan can no longer be acted on.',
      };
      state.pendingSquad = squadState;
    }
    renderApp();
  } catch (err) {
    handleLoadError(err);
  } finally {
    state.busy = false;
  }
}

// A tab that slept through the deadline wakes up on the wrong side of it, and
// its 30 second timer did not fire while it was hidden. Checking on the way back
// is what stops a user reloading by hand to find out the world moved.
function wireVisibility() {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || state.view !== 'plan' || !state.bundle) return;
    if (deadlineHasPassed()) reactToDeadline();
  });
}

/* ---------------------------------------------------------------- captains */

// The captain each gameweek is only in that gameweek's picks, so the History
// tab asks for them once, in the background, and fills the column in when they
// land. A gameweek whose picks are unavailable simply stays blank.
async function loadCaptains() {
  if (state.historyLoaded || !state.history || !Array.isArray(state.history.current)) return;
  state.historyLoaded = true;
  const gws = state.history.current.map(r => r.event).slice(-8);
  const results = await Promise.allSettled(gws.map(gw => fplApi.getEntryPicks(state.teamId, gw)));
  let changed = false;
  results.forEach((res, i) => {
    if (res.status !== 'fulfilled') return;
    const pick = (res.value.data.picks || []).find(p => p.is_captain);
    if (pick) { state.captains.set(gws[i], pick.element); changed = true; }
  });
  if (changed && state.view === 'history') renderApp();
}

/* ------------------------------------------------------------------- start */

function wireOnboarding() {
  const form = qs('fpl-onboard');
  const input = qs('fpl-team-id');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const check = store.validateTeamId(input.value);
    if (!check.ok) {
      const error = qs('fpl-onboard-error');
      error.textContent = check.message;
      error.hidden = false;
      input.focus();
      return;
    }
    // Once the demo dataset is loaded, every read is served from it. A real
    // Team ID therefore has to leave demo mode entirely rather than be looked
    // up in a synthetic dataset that does not contain it.
    if (state.sample) {
      window.location.search = `?team=${check.teamId}`;
      return;
    }

    state.teamId = check.teamId;
    state.bundle = null;
    state.captains = new Map();
    state.historyLoaded = false;
    await connectAndPlan({ reason: 'first-calculation' });
  });
}

async function boot() {
  appEl = qs('fpl-app');
  landingEl = qs('fpl-landing');
  if (!appEl || !landingEl) return;
  wireOnboarding();
  wireVisibility();
  ensureModel();

  // The drawer overlay lives on the app ROOT WRAPPER, outside the re-rendered
  // #fpl-app region, so a plan re-render never tears it down mid-read.
  drawer = createPlayerDrawer({
    root: appEl.closest('.fpl-planner-app') || appEl.parentElement || appEl,
    context: () => (state.bundle && state.gameState ? {
      // Which season the player's totals describe, so the drawer can label them
      // rather than assuming they are this season's.
      evidence: state.bundle.dataStatus ? state.bundle.dataStatus.evidence : null,
      gameState: state.gameState,
      projections: state.bundle.projections,
      gw: state.bundle.current.gw,
      horizon: state.bundle.current.horizon,
    } : null),
  });

  const params = new URLSearchParams(window.location.search);
  const view = params.get('view');
  if (['plan', 'history', 'settings'].includes(view)) state.view = view;
  else if (['plan', 'history', 'settings'].includes(state.settings.lastView)) state.view = state.settings.lastView;

  // ?demo=1 is the ONLY path that loads the sample dataset. It is never reached
  // from an error handler.
  if (isDemoRequested(window.location.search)) {
    try {
      const bundle = await loadSampleData();
      fplApi.useSampleData(bundle);
      state.sample = true;
      state.sampleMeta = bundle.meta;
      state.teamId = String(bundle.entryId);
      await connectAndPlan({ reason: 'first-calculation' });
      return;
    } catch (err) {
      showLanding(`The sample dataset could not be loaded (${err.message}). Enter a Team ID to plan a real team.`);
      return;
    }
  }

  const fromUrl = params.get('team');
  const urlCheck = fromUrl ? store.validateTeamId(fromUrl) : { ok: false };
  state.teamId = urlCheck.ok ? urlCheck.teamId : store.getTeamId();

  if (!state.teamId) {
    showLanding();
    return;
  }
  await connectAndPlan({ reason: 'first-calculation' });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
