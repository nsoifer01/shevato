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
import { buildSquadState } from './engine/squad.js';
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
  state.squadState = squadState;
  state.isDraft = squadState.source === 'draft';
  state.fingerprint = inputFingerprint(squadState, state.gameState);

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
  store.setSquadSnapshot(bundle.squadState);
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

  const sources = fplApi.getDataStatus().sources;
  const failed = sources.filter(s => !s.ok);
  showApp();
  mount(appEl, [
    topBar(),
    banner({
      tone: 'error',
      mark: '!',
      title: 'We could not load the data this plan needs',
      text: 'No plan is shown, because a plan built on missing data would look exactly as confident as a good one.',
      list: failed.length
        ? failed.map(s => `${s.name}: ${s.error || 'could not be loaded'}`)
        : [String(err.message || err)],
      actions: [
        btn('Try again', () => connectAndPlan({ reason: 'manual' }), { variant: 'fpl-btn-primary' }),
        btn('Use a different Team ID', () => showLanding(null, state.teamId), { variant: 'fpl-btn-quiet' }),
      ],
    }),
  ]);
}

/* ----------------------------------------------------------------- refresh */

// Re-reads the inputs without recomputing. If anything material moved, the plan
// on screen is marked outdated and a recalculate action appears: continuing to
// present it as current would be the dishonest option.
async function refreshInputs() {
  if (state.busy) return;
  state.busy = true;
  try {
    await loadWorld({ force: true });
    await loadTeam({ force: true });
    if (state.preSeason || !state.picks) { renderApp(); return; }
    const squadState = buildSquadState({
      entry: state.entry, history: state.history, transfers: state.transfers,
      picks: state.picks, gameState: state.gameState, gw: state.planGw,
    });
    const next = inputFingerprint(squadState, state.gameState);
    state.outdated = outdatedReason(state.fingerprint, next);
    state.pendingSquad = state.outdated ? squadState : null;
    state.lastChecked = Date.now();
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

async function planManualSquad(ids) {
  if (state.busy) return;
  state.busy = true;
  state.manualIds = ids;
  try {
    const squadState = manualSquadState({ ids, gameState: state.gameState, gw: state.planGw, entry: state.entry });
    await computePlan(squadState, { reason: 'manual' });
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
  if (!bundle) return el('p', { class: 'fpl-empty', text: 'No plan yet.' });

  const assessment = assessData({ sources: fplApi.getDataStatus().sources });
  if (assessment.withholdPlan) {
    return [topNotices(), withheldView({ assessment, onRetry: () => connectAndPlan({ reason: 'manual' }) })];
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
      ? draftCard({ bundle, gameState: state.gameState })
      : transfersCard({ bundle, gameState: state.gameState }),
  ];

  if (!state.isDraft) nodes.push(chipCard({ bundle, gameState: state.gameState }));

  nodes.push(pitchCard({
    bundle,
    gameState: state.gameState,
    initialMode: (bundle.squadState.picks || []).length ? state.pitchMode : 'recommended',
    onModeChange: (mode) => { state.pitchMode = mode; },
    initialDisplay: state.pitchDisplay,
    onDisplayChange: (display) => { state.pitchDisplay = display; },
    onPlayerClick: (id, opts) => { if (drawer) drawer.open(id, opts); },
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
    const codes = state.bundle.dataStatus.staleReasonCodes || [];
    nodes.push(banner({
      tone: 'warn',
      mark: '!',
      title: 'Working from older data',
      text: 'The plan is built from the most recent copy we have, which is not fresh.',
      list: codes,
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
    onBuild: () => buildOpeningSquad(),
    onManual: () => { state.preSeasonStage = 'manual'; renderApp(); },
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
    if (state.slots.hero && state.slots.hero.isConnected) {
      mount(state.slots.hero, heroSlotContent());
    }
    if (state.slots.fresh && state.slots.fresh.isConnected) {
      mount(state.slots.fresh, freshnessRow());
    }
  }, 30000);
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
  ensureModel();

  // The drawer overlay lives on the app ROOT WRAPPER, outside the re-rendered
  // #fpl-app region, so a plan re-render never tears it down mid-read.
  drawer = createPlayerDrawer({
    root: appEl.closest('.fpl-planner-app') || appEl.parentElement || appEl,
    context: () => (state.bundle && state.gameState ? {
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
