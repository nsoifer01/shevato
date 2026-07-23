'use strict';
(() => {

  // ---------- constants ----------
  const TP_BUILD = 30; // bump with every asset-version bump; shown in the footer
  const LS_KEY = 'trip-planner:v1';
  const TIMEFMT_KEY = 'trip-planner:timefmt';
  const TYPE_META = {
    flight:    { label: 'Flight',    icon: '✈️', order: 0, cls: 'type-flight' },
    // transport = between cities, local = getting around inside one city
    transport: { label: 'Transport', icon: '🚆', order: 1, cls: 'type-transport' },
    local:     { label: 'Local travel', icon: '🚕', order: 2, cls: 'type-local' },
    activity:  { label: 'Activity',  icon: '🎟️', order: 3, cls: 'type-activity' },
    stay:      { label: 'Stay',      icon: '🏨', order: 4, cls: 'type-stay' },
    note:      { label: 'Note',      icon: '📝', order: 5, cls: 'type-note' },
  };
  const STATUS_META = {
    'booked':    { label: 'Booked',       cls: 'st-booked' },
    'to-book':   { label: 'To book',      cls: 'st-to-book' },
    'decide':    { label: 'Decide later', cls: 'st-decide' },
    'cancelled': { label: 'Cancelled',    cls: 'st-cancelled' },
  };

  // A meal is an `activity` whose title carries one of the prefixes the
  // assistant contract mandates, so its icon comes from the same read of that
  // list that decides the estimate tilde. Anything the list gains later still
  // gets the neutral fallback rather than an activity ticket.
  const MEAL_ICONS = { breakfast: '🥐', lunch: '🥗', dinner: '🍽️', drinks: '🍸' };

  // The one place a row's visual identity is decided: which icon sits on the
  // rail, what a screen reader calls it, and which accent class paints it.
  function rowLook(it) {
    if (it.type === 'activity' && isFoodOrDrink(it.title)) {
      const kind = mealKind(it.title);
      return { cls: 'tp-t-meal', icon: MEAL_ICONS[kind] || '🍽️', label: kind ? kind[0].toUpperCase() + kind.slice(1) : 'Meal' };
    }
    const tm = TYPE_META[it.type] || TYPE_META.note;
    return { cls: 'tp-t-' + (TYPE_META[it.type] ? it.type : 'note'), icon: tm.icon, label: tm.label };
  }
  const TRAVEL_TYPES = { flight: 1, transport: 1, local: 1 };
  const PENCIL_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
  const TRASH_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';

  // Pure logic (dates, validation, coverage, stats, route math) lives in
  // js/trip-logic.js so the node:test suite can exercise it directly.
  const {
    isIsoDate, toUtc, diffDays, addDays,
    isStay, nights, sortKey, sortedItems, tripLegs,
    validateItem, coverageGaps, tripStats, MAX_TRIP_DAYS, DATE_MIN, DATE_MAX, isDateInRange,
    ISLANDISH, distKm, flagEmoji, compass, fmtDur, modeOptions,
    routeBadges, routeFlags, routeTips, routeLinks, modeLink, ROUTE_HONESTY,
    classifyGeoMatch, geoMatchNote, GEO_MATCH_RANK, GEO_MATCH_TEXT,
    classifyVisa, parseVisaMatrix, visaCountryUsable, visaUnconfirmedNames, visaVintageNote, slimTripForShare, hasFastRail, viewFromHash, hashForView,
    buildIcs, buildCsv, convertAmount, sumInCurrency,
    bytesToBase64url, base64urlToBytes,
    transportGaps, tripPhase, isPastRow,
    dayCards, dayMorningCity, emptyDayNote, departureOrigin, suggestedPassport, passportAssumptionParts, defaultPlanDay, planDayGroups, overnightTransit,
    timelineGroups, mealKind, isFoodOrDrink, isLongDetails, mealTitlePrefixes, itemMapsQuery, displayTitle,
    weatherKey, summarizeClimate, weatherLine, weatherRange, pickMonthSamples, docGuard,
    extractTripActions, validateTripAction, buildAssistPackage, buildAssistSystemPrompt,
    buildPlanRequest, groupProposals, linkifySegments, parseMarkdown,
    placeCacheKey, planPlacesLookup, placesCacheUpdates, mapsSearchUrl, assistMapsLink, costDisplayParts,
    hasEstimate, displayCostOf, parseMoney, roundMoney, budgetVerdict, refundParts,
    matchSampleTrip, sampleTripOptions, buildSampleTrip,
  } = window.TripLogic;

  // ---------- state ----------
  let db = loadDb();
  const ui = { search: '', filterType: '', filterStatus: '', editingId: null, shiftTarget: null, tripModalMode: 'new', confirmAction: null, flashId: null, view: 'timeline' };

  // ---------- timeline collapse state ----------
  // Which stays and which days inside them the traveller has opened. Kept OUT
  // of the trip db on purpose: save() is the undo choke point, and expanding a
  // hotel is not an edit anybody should be able to undo, nor something worth
  // syncing to another device. Only explicit choices are stored, so the
  // defaults below (collapsed, except today's stay while the trip is running)
  // keep applying until the traveller overrides them.
  const COLLAPSE_KEY = 'trip-planner:collapse:v1';
  let collapseState = {};
  try { collapseState = JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '{}') || {}; } catch { collapseState = {}; }

  function collapseFor(tripId) {
    if (!collapseState[tripId] || typeof collapseState[tripId] !== 'object') collapseState[tripId] = {};
    return collapseState[tripId];
  }
  function setOpen(tripId, key, open) {
    collapseFor(tripId)[key] = !!open;
    try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(collapseState)); } catch { /* best effort */ }
  }
  function isOpen(tripId, key, fallback) {
    const rec = collapseFor(tripId);
    return typeof rec[key] === 'boolean' ? rec[key] : fallback;
  }

  // read-only share view: the real db is parked in realDb; save() is a no-op
  // so nothing the visitor touches ever reaches trip-planner:v1.
  let sharedMode = false;
  let realDb = null;
  let sharedTrip = null;
  let didAutoScroll = false;

  function uid() {
    return (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(36).slice(2, 9));
  }

  function loadDb() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.trips)) return parsed;
      }
    } catch { /* corrupted storage falls through to a fresh db */ }
    return { version: 1, activeTripId: null, trips: [] };
  }
  // ---------- undo / redo ----------
  // State-snapshot history fed from save(), the single choke point every
  // data mutation already flows through. Settings (the time format)
  // bypass save() so they stay out of the history.
  const HISTORY_MAX = 50;
  const undoPast = [];
  const undoFuture = [];
  let lastSaved = null;
  // Which trip you are looking at is navigation, not data. Keying the history
  // on the trips alone is what stops a trip switch from becoming an undo step:
  // "delete on A, switch to B, Undo" used to land back on A with the item still
  // deleted, and only a SECOND Undo restored it.
  let lastSavedKey = null;
  const historyKey = () => JSON.stringify(db.trips);
  function markSaved() { lastSaved = JSON.stringify(db); lastSavedKey = historyKey(); }

  // `okMsg` is the confirmation for this change. It is passed in rather than
  // toasted by the caller because a confirmation is a claim that the change was
  // STORED: "Item added" followed by "Could not save" was a lie, and both
  // messages then auto-dismissed while the item existed only in memory.
  function save(okMsg, undoFn) {
    if (sharedMode) return false; // shared view never writes to storage
    let ok = true;
    try {
      const next = JSON.stringify(db);
      const key = historyKey();
      if (lastSavedKey !== null && key !== lastSavedKey) {
        undoPast.push(lastSaved);
        if (undoPast.length > HISTORY_MAX) undoPast.shift();
        undoFuture.length = 0;
      }
      lastSaved = next;
      lastSavedKey = key;
      localStorage.setItem(LS_KEY, next);
    }
    catch (err) { ok = false; }
    setSaveFailed(!ok);
    if (ok && okMsg) toast(okMsg, undoFn);
    return ok;
  }

  // A toast that disappears after 2.6 seconds is the wrong shape for "your data
  // is not stored": the banner stays until a save succeeds, and offers the same
  // backup escape hatch the render error boundary does.
  let saveFailed = false;
  function setSaveFailed(failed) {
    if (failed === saveFailed) return;
    saveFailed = failed;
    renderSaveBanner();
  }
  function renderSaveBanner() {
    let b = $('#saveBanner');
    if (!saveFailed) { if (b) b.remove(); return; }
    if (b) return;
    b = document.createElement('div');
    b.id = 'saveBanner';
    b.className = 'save-banner';
    b.innerHTML = `
      <span class="sb-text">⚠️ Changes are NOT being saved (storage may be full). They will be lost when you close this tab.</span>
      <span class="sb-actions"><button type="button" class="btn primary" id="saveBannerBackup">Download a backup of all data</button></span>`;
    const wrap = document.querySelector('.tp-wrap');
    wrap.insertBefore(b, wrap.firstChild);
    $('#saveBannerBackup').addEventListener('click', () => download('trip-planner-backup.json', JSON.stringify(db, null, 2)));
  }

  function restoreSnapshot(snapshot) {
    lastSaved = snapshot;
    const viewing = db.activeTripId;
    db = JSON.parse(snapshot);
    // Undo restores DATA. It must never move you to a different trip than the
    // one on screen, which is the other half of keeping trip switches out of
    // the history.
    if (db.trips.some(t => t.id === viewing)) db.activeTripId = viewing;
    lastSavedKey = historyKey();
    try { localStorage.setItem(LS_KEY, JSON.stringify(db)); setSaveFailed(false); }
    catch { setSaveFailed(true); }
    render();
  }
  // Accepting a proposal consumes its card. Undo puts the trip back, so it has
  // to put the card back too: without it the card sat there reading "Updated"
  // and the only way to try again was another AI call that may answer
  // differently. Keyed by the snapshot the accept pushed onto the history, so
  // the restore fires exactly when that accept is what is being undone.
  const assistUndo = new Map();

  function undo() {
    if (!undoPast.length) return;
    undoFuture.push(lastSaved);
    const snapshot = undoPast.pop();
    restoreSnapshot(snapshot);
    const restore = assistUndo.get(snapshot);
    if (restore) { assistUndo.delete(snapshot); restore(); }
    toast('Undone');
  }
  function redo() {
    if (!undoFuture.length) return;
    undoPast.push(lastSaved);
    restoreSnapshot(undoFuture.pop());
    toast('Redone');
  }
  function syncUndoButtons() {
    const u = $('#undoBtn'), r = $('#redoBtn');
    if (u) u.disabled = !undoPast.length;
    if (r) r.disabled = !undoFuture.length;
  }

  // Repair anything structurally broken (hand-edited storage, partial imports)
  // so one bad item can never take the whole app down.
  function repairDb() {
    if (!Array.isArray(db.trips)) db.trips = [];
    db.trips = db.trips.filter(t => t && typeof t === 'object');
    for (const t of db.trips) {
      if (!t.id) t.id = uid();
      if (typeof t.name !== 'string' || !t.name) t.name = 'Untitled trip';
      if (!/^[A-Z]{3}$/.test(t.currency || '')) t.currency = 'USD';
      t.budget = parseMoney(t.budget).value;
      if (!Array.isArray(t.items)) t.items = [];
      if (!Array.isArray(t.visaExtras)) t.visaExtras = [];
      t.visaExtras = t.visaExtras.filter(c => typeof c === 'string' && /^[A-Z]{2}$/.test(c));
      t.items = t.items.filter(it => it && typeof it === 'object');
      for (const it of t.items) {
        if (!it.id) it.id = uid();
        if (!TYPE_META[it.type]) it.type = 'note';
        if (!STATUS_META[it.status]) it.status = 'to-book';
        if (typeof it.title !== 'string') it.title = '';
        if (typeof it.startDate !== 'string') it.startDate = '';
        if (typeof it.endDate !== 'string') it.endDate = '';
        if (typeof it.endTime !== 'string') it.endTime = '';
        if (it.mapsQuery != null && typeof it.mapsQuery !== 'string') delete it.mapsQuery;
        // same money reader as the import path: storage is untrusted JSON too,
        // and a `true` or an Infinity already sitting there must not survive
        if (it.cost != null) it.cost = parseMoney(it.cost).value;
        if (it.costCurrency != null && !/^[A-Z]{3}$/.test(it.costCurrency)) delete it.costCurrency;
        if (it.cost != null && it.cost !== '' && !it.costCurrency) it.costCurrency = t.currency || 'USD';
        if (it.estCost != null) {
          const est = parseMoney(it.estCost);
          if (est.value == null) delete it.estCost; else it.estCost = est.value;
        }
        if (it.estCostCurrency != null && !/^[A-Z]{3}$/.test(it.estCostCurrency)) delete it.estCostCurrency;
        if (it.estCost != null && !it.estCostCurrency) it.estCostCurrency = t.currency || 'USD';
      }
    }
  }

  function activeTrip() { return db.trips.find(t => t.id === db.activeTripId) || null; }

  function ensureTrip() {
    if (!db.trips.length) {
      const t = { id: uid(), name: 'My trip', currency: 'USD', items: [] };
      db.trips.push(t);
      db.activeTripId = t.id;
      save();
    }
    if (!activeTrip()) { db.activeTripId = db.trips[0].id; save(); }
  }

  // ---------- date display ----------
  const FMT_FULL = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  const FMT_MD = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const FMT_DOW = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' });
  function fmtDate(s, withYear = true) { return (withYear ? FMT_FULL : FMT_MD).format(toUtc(s)); }
  function fmtDow(s) { return FMT_DOW.format(toUtc(s)); }
  function fmtRange(a, b) {
    const sameYear = a.slice(0, 4) === b.slice(0, 4);
    return sameYear ? `${fmtDate(a, false)} - ${fmtDate(b, true)}` : `${fmtDate(a, true)} - ${fmtDate(b, true)}`;
  }
  let use24h = localStorage.getItem(TIMEFMT_KEY) === '24';
  function fmtTime(t) {
    if (!t) return '';
    if (use24h) return t;
    const [h, m] = t.split(':').map(Number);
    const am = h < 12;
    const h12 = h % 12 || 12;
    return `${h12}:${String(m).padStart(2, '0')} ${am ? 'AM' : 'PM'}`;
  }
  function syncTimefmtLabel() {
    const b = $('#timefmtBtn');
    if (b) b.textContent = use24h ? '🕐 Use 12-hour times' : '🕐 Use 24-hour times';
    // the day-card time rail is sized for the format actually being printed:
    // "12:30 PM" needs ~64px of text, "12:30" needs ~36px (see --dc-rail-w)
    document.body.classList.toggle('tp-24h', use24h);
  }
  function todayIso() { return new Date().toISOString().slice(0, 10); }

  // ---------- money ----------
  // CHF is deliberately absent: the Swiss franc has no real symbol (it
  // renders as the bare code even with narrowSymbol), which broke the
  // symbol-everywhere contract. Legacy trips that stored it keep working
  // via the picker's fallback option below.
  const CURRENCIES = ['USD', 'EUR', 'GBP', 'ILS', 'JPY', 'THB', 'CAD', 'AUD'];
  function currencySymbol(code) {
    // narrowSymbol yields the tightest real symbol (THB -> baht sign,
    // CAD/AUD -> $); fall back for engines without narrowSymbol support
    try {
      return new Intl.NumberFormat('en-US', { style: 'currency', currency: code || 'USD', currencyDisplay: 'narrowSymbol' })
        .formatToParts(0).find(p => p.type === 'currency').value;
    } catch {
      try {
        return new Intl.NumberFormat('en-US', { style: 'currency', currency: code || 'USD' })
          .formatToParts(0).find(p => p.type === 'currency').value;
      } catch { return '$'; }
    }
  }

  // Older items carry no costCurrency (it used to mean "same as the trip
  // currency"). Before the trip's display currency changes, pin those
  // amounts to the currency they were entered in, so $200 stays $200 and
  // converts, rather than silently becoming 200 of the new currency.
  function stampCostCurrencies(trip, currentCurrency) {
    for (const it of trip.items) {
      if (it.cost != null && it.cost !== '' && !it.costCurrency) it.costCurrency = currentCurrency;
      if (it.estCost != null && it.estCost !== '' && !it.estCostCurrency) it.estCostCurrency = currentCurrency;
    }
  }

  // `digits` is how many decimals to show. It is 2 everywhere except on an
  // estimate, where costDisplayParts asks for 0 so a guessed dinner reads as
  // ~$45 instead of ~$45.00. Intl rounds half-up, so $44.60 becomes $45.
  function fracOpts(digits) {
    return digits === 0 ? { minimumFractionDigits: 0, maximumFractionDigits: 0 } : {};
  }
  function moneyFmt(trip, digits) {
    const base = { style: 'currency', currency: trip.currency || 'USD', ...fracOpts(digits) };
    try { return new Intl.NumberFormat('en-US', { ...base, currencyDisplay: 'narrowSymbol' }); }
    catch {
      try { return new Intl.NumberFormat('en-US', base); }
      catch { return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', ...fracOpts(digits) }); }
    }
  }
  function fmtMoney(trip, n, digits) { return moneyFmt(trip, digits).format(n); }

  // The ONE place a signed amount becomes human-readable. See refundParts: a
  // refund never prints a sign, it prints the word. `kind` is 'item' for a row
  // badge and 'total' for a summary figure, which is the only difference in
  // wording. Returns HTML, so callers must not escape it again.
  function moneyHtml(trip, n, digits, kind) {
    const { isRefund, magnitude } = refundParts(n);
    const text = fmtMoney(trip, magnitude, digits);
    if (!isRefund) return esc(text);
    const word = kind === 'total' ? 'Net refund' : 'Refund';
    return `<span class="money-refund">${word} ${esc(text)}</span>`;
  }
  // Same rule for an amount printed in a currency other than the trip's.
  function moneyInHtml(code, n, digits, kind) {
    const { isRefund, magnitude } = refundParts(n);
    const text = fmtMoneyIn(code, magnitude, digits);
    if (!isRefund) return esc(text);
    const word = kind === 'total' ? 'Net refund' : 'Refund';
    return `<span class="money-refund">${word} ${esc(text)}</span>`;
  }

  function fmtMoneyIn(code, n, digits) {
    const base = { style: 'currency', currency: code || 'USD', ...fracOpts(digits) };
    try { return new Intl.NumberFormat('en-US', { ...base, currencyDisplay: 'narrowSymbol' }).format(n); }
    catch {
      try { return new Intl.NumberFormat('en-US', base).format(n); }
      catch { return `${code} ${Number(n).toFixed(digits === 0 ? 0 : 2)}`; }
    }
  }

  // ---------- exchange rates (frankfurter.app, cached 24h) ----------
  const RATES_KEY = 'trip-planner:rates:v1';
  const RATES_TTL = 24 * 3600 * 1000;
  let rates = null; // { base, at, rates }
  try { rates = JSON.parse(localStorage.getItem(RATES_KEY) || 'null'); } catch { rates = null; }
  let ratesFetching = false;
  let ratesFailed = false;
  let lastRateAttempt = { base: null, at: 0 };

  function tripHasForeignCost(trip) {
    const base = trip.currency || 'USD';
    // estimates are displayed and converted for display, so they need rates too;
    // they still never reach a total
    return trip.items.some(it => (it.costCurrency && it.costCurrency !== base && it.cost != null)
      || (it.estCostCurrency && it.estCostCurrency !== base && it.estCost != null));
  }
  // rates usable for this trip: same base, even if stale (staleness only
  // changes the note, never fabricates a conversion)
  function activeRates(trip) {
    const base = trip.currency || 'USD';
    return (rates && rates.base === base && rates.rates) ? rates : null;
  }
  function ensureRates(trip) {
    const base = trip.currency || 'USD';
    if (!tripHasForeignCost(trip)) return;
    const have = rates && rates.base === base && rates.rates;
    const stale = have && Date.now() - rates.at > RATES_TTL;
    if (have && !stale) return;
    if (ratesFetching) return;
    // one network attempt per base per minute so keystroke re-renders (or an
    // offline device) never hammer the endpoint
    if (lastRateAttempt.base === base && Date.now() - lastRateAttempt.at < 60000) return;
    lastRateAttempt = { base, at: Date.now() };
    ratesFetching = true;
    fetch('https://api.frankfurter.dev/v1/latest?from=' + encodeURIComponent(base))
      .then(r => { if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
      .then(data => {
        if (data && data.base && data.rates) {
          rates = { base: data.base, at: Date.now(), rates: data.rates };
          try { localStorage.setItem(RATES_KEY, JSON.stringify(rates)); } catch { /* best effort */ }
          ratesFailed = false;
          render();
        }
      })
      .catch(() => { ratesFailed = true; render(); })
      .finally(() => { ratesFetching = false; });
  }

  // Converted money totals in the trip currency. Returns confirmed/planned as
  // { total, unconverted:[items] } plus a stale flag for the note.
  function tripMoney(trip) {
    const base = trip.currency || 'USD';
    const ratesObj = activeRates(trip);
    const items = trip.items.filter(it => it.status !== 'cancelled');
    const confirmed = sumInCurrency(items.filter(it => it.status === 'booked'), base, ratesObj);
    const planned = sumInCurrency(items, base, ratesObj);
    const stale = !!(ratesObj && Date.now() - ratesObj.at > RATES_TTL);
    return { confirmed, planned, base, ratesObj, stale };
  }

  // ---------- validation / warnings ----------

  function computeIssues(trip) {
    const issues = [];
    const items = sortedItems(trip);
    const stats = tripStats(trip);

    // A single mistyped year stretches the trip over millions of days. The day
    // and strip views cap themselves at MAX_TRIP_DAYS so the app stays usable,
    // and this is what makes that cap visible: it names the item and the date
    // holding it, so the traveller can open that row and fix it.
    if (stats.spanCapped) {
      for (const it of items) {
        const far = [it.startDate, it.endDate].find(d => isIsoDate(d) && d > stats.renderEnd);
        if (!far) continue;
        issues.push({
          level: 'error',
          text: `"${it.title || '(untitled)'}" is dated ${fmtDate(far)}, far outside the rest of the trip. Days and the night strip only show the first ${MAX_TRIP_DAYS} days until this is fixed.`,
          ids: [it.id],
        });
      }
    }

    for (const it of items) {
      const errs = validateItem(it);
      if (Object.keys(errs).length) {
        issues.push({ level: 'error', text: `"${it.title || '(untitled)'}" has invalid data (${Object.keys(errs).join(', ')}).`, ids: [it.id] });
      }
    }

    const stays = items.filter(it => isStay(it) && it.status !== 'cancelled' && isIsoDate(it.startDate) && isIsoDate(it.endDate) && diffDays(it.startDate, it.endDate) > 0);

    // overlapping stays (two places booked for the same night)
    for (let i = 0; i < stays.length; i++) {
      for (let j = i + 1; j < stays.length; j++) {
        const a = stays[i], b = stays[j];
        const oStart = a.startDate > b.startDate ? a.startDate : b.startDate;
        const oEnd = a.endDate < b.endDate ? a.endDate : b.endDate;
        const overlap = diffDays(oStart, oEnd);
        if (overlap > 0) {
          issues.push({
            level: 'warn',
            text: `Date collision: "${a.title}" and "${b.title}" both cover ${overlap === 1 ? 'the night of ' + fmtDate(oStart) : fmtRange(oStart, addDays(oEnd, 0)) + ` (${overlap} nights)`}.`,
            ids: [a.id, b.id],
          });
        }
      }
    }

    // nights with no stay between the first check-in and the end of the trip
    // (a trailing flight home still needs lodging on the nights before it)
    const overnightTravel = overnightTransit(items);
    const gaps = coverageGaps(stays, stats.end, overnightTravel);
    for (const g of gaps) {
      issues.push({
        level: 'warn',
        text: `No stay covers ${g.nights === 1 ? 'the night of ' + fmtDate(g.start) : fmtRange(g.start, g.end) + ` (${g.nights} nights)`}.`,
        ids: [],
        gap: g,
      });
    }

    // items dated before today but still "to book"
    for (const it of items) {
      if (it.status === 'to-book' && isIsoDate(it.startDate) && it.startDate < todayIso()) {
        issues.push({ level: 'warn', text: `"${it.title}" is in the past but still marked "To book".`, ids: [it.id] });
      }
    }

    // city changes with no flight/transport logged between them (only when
    // both places are already geocoded, so we never touch the network here)
    for (const g of transportGaps(trip)) {
      if (geoResolved(g.fromLocation) && geoResolved(g.toLocation)) {
        issues.push({
          level: 'warn',
          text: `No flight or transport is logged between "${g.fromLocation}" and "${g.toLocation}" (${fmtDate(g.gapStart)} to ${fmtDate(g.gapEnd)}).`,
          ids: [g.fromId, g.toId],
        });
      }
    }
    return issues;
  }

  // reads the geocode cache directly, never the network
  function geoResolved(place) {
    return !!geoCache[String(place || '').trim().toLowerCase()];
  }

  // same cache, the country half of it: '' when the place was never looked up
  function geoCountry(place) {
    const hit = geoCache[String(place || '').trim().toLowerCase()];
    return hit ? hit.cc || '' : '';
  }

  // ---------- rendering ----------
  const $ = sel => document.querySelector(sel);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Any http(s) URL sitting in free text becomes a real anchor. linkifySegments
  // returns PURE DATA, so every segment is escaped here: item text is
  // traveller/AI supplied and must never reach innerHTML unescaped.
  function linkify(text) {
    return linkifySegments(text)
      .map(seg => seg.href
        ? `<a href="${esc(seg.href)}" target="_blank" rel="noopener">${esc(seg.href)}</a>`
        : esc(seg.text))
      .join('');
  }
  function mapsLinkHtml(q, label = '📍 Open in Google Maps') {
    return q ? `<a class="assist-maps-link" href="${esc(mapsSearchUrl(q))}" target="_blank" rel="noopener">${esc(label)}</a>` : '';
  }

  // The assistant's own cards get a smarter link: it starts as a search and is
  // upgraded in place to the resolved place URI by the ratings pass (see
  // paintMapsLink), using the batched lookup that already runs for the reply.
  function assistMapsLinkHtml(mapsQuery) {
    const key = placeCacheKey(mapsQuery);
    const link = assistMapsLink(mapsQuery, placesCache.get(key));
    if (!link) return '';
    return `<a class="assist-maps-link" data-place-key="${esc(key)}" data-place-query="${esc(mapsQuery)}"`
      + ` href="${esc(link.href)}" target="_blank" rel="noopener">${esc(link.label)}</a>`;
  }

  // Itinerary cards (Timeline + Days) carry ONE combined element: the item's
  // Google Maps link with its rating inline. It starts as a search anchor and is
  // upgraded in place by paintTripMapsLink once the batched lookup resolves the
  // place (href -> mapsUri, rating segment appended, accessible name set). The
  // "Google Maps" wordmark is verbatim and never wraps (CSS nowraps the label).
  // Unrated and rated read as the same control at the same height: the rating is
  // a suffix on the pill, never a differently-shaped chip, so the eye finds it
  // in the same spot on every card whether or not Google had a number for it.
  function tripMapsRatingHtml(mapsQuery) {
    const key = placeCacheKey(mapsQuery);
    if (!key) return '';
    return `<a class="tp-maps-link" data-place-key="${esc(key)}" data-place-query="${esc(mapsQuery)}"`
      + ` href="${esc(mapsSearchUrl(mapsQuery))}" target="_blank" rel="noopener">`
      + `<span class="tpm-label">Google Maps</span></a>`;
  }

  // The one place both views ask "does this item open on Maps at all?", so a
  // hotel, a restaurant and a museum can never diverge on whether they get the
  // section (see itemMapsQuery for which types derive a query).
  const mapsHtmlFor = it => tripMapsRatingHtml(itemMapsQuery(it));

  function render() {
    try {
      ensureTrip();
      renderTripSelect();
      const trip = activeTrip();
      ensureRates(trip);
      const issues = computeIssues(trip);
      renderSummary(trip, issues);
      renderStrip(trip);
      renderIssues(issues);
      renderBoard(trip, issues);
      applyView();
      syncUndoButtons();
      refreshDocIndicators();
      syncAssistPanel();
    } catch (err) {
      $('#board').innerHTML = `
        <div class="error-card">
          <h2>Something went wrong rendering this trip</h2>
          <p>${esc(err.message)}</p>
          <button class="btn primary" id="errBackup">Download a backup of all data</button>
        </div>`;
      const b = $('#errBackup');
      if (b) b.addEventListener('click', () => download('trip-planner-backup.json', JSON.stringify(db, null, 2)));
    }
  }

  function applyView() {
    const v = ui.view;
    $('#board').style.display = v === 'timeline' ? '' : 'none';
    $('#mapBox').classList.toggle('on', v === 'map');
    $('#daysBox').classList.toggle('on', v === 'days');
    $('#viewTimeline').classList.toggle('on', v === 'timeline');
    $('#viewDays').classList.toggle('on', v === 'days');
    $('#viewMap').classList.toggle('on', v === 'map');
    document.body.classList.toggle('view-days', v === 'days');
    if (v === 'map') renderMap();
    if (v === 'days') renderDays();
    syncViewHash();
  }

  // The fragment is also the share-link carrier (SHARE_PREFIX), so the view is
  // written only when the fragment is not a share payload and we are not in
  // shared mode: overwriting "#share=..." would destroy the shared itinerary
  // for whoever opened the link the moment they refreshed.
  function syncViewHash() {
    if (sharedMode) return;
    if (viewFromHash(location.hash, ui.view).isShare) return;
    const want = hashForView(ui.view);
    if (location.hash === want) return;
    // replaceState, not `location.hash = ...`: assignment pushes a history
    // entry (so Back would walk Timeline -> Days -> Map instead of leaving the
    // page) and makes the browser hunt for an element with that id and scroll
    // to it. replaceState avoids both.
    history.replaceState(null, '', location.pathname + location.search + want);
  }

  // ---------- night coverage strip ----------
  function renderStrip(trip) {
    const box = $('#stripBox');
    const s = tripStats(trip);
    const stays = trip.items.filter(it => isStay(it) && it.status !== 'cancelled' && isIsoDate(it.startDate) && isIsoDate(it.endDate) && diffDays(it.startDate, it.endDate) > 0);
    const travelNights = overnightTransit(trip.items);
    if (!s.start || !s.end || s.totalTripNights < 2 || !stays.length) { box.hidden = true; return; }
    box.hidden = false;
    const cells = [];
    // renderEnd, not end: one item dated 9999 would otherwise ask for three
    // million cells and hang every load. computeIssues names the offender.
    for (let d = s.start; d < s.renderEnd; d = addDays(d, 1)) {
      const covering = stays.filter(st => st.startDate <= d && d < st.endDate);
      // booked coverage wins the color; otherwise best planned status
      let cls = 'cv-gap', tip = `${fmtDate(d)}: no stay`, id = '';
      const booked = covering.find(st => st.status === 'booked');
      const other = covering[0];
      const transit = !covering.length ? travelNights.find(tr => tr.startDate <= d && d < tr.endDate) : null;
      if (booked) { cls = 'cv-booked'; tip = `${fmtDate(d)}: ${booked.title}`; id = booked.id; }
      else if (other) {
        cls = other.status === 'decide' ? 'cv-decide' : 'cv-to-book';
        tip = `${fmtDate(d)}: ${other.title} (${STATUS_META[other.status].label})`;
        id = other.id;
      } else if (transit) {
        cls = 'cv-transit';
        tip = `${fmtDate(d)}: in transit (${transit.title})`;
        id = transit.id;
      }
      cells.push(`<div class="cell ${cls}" title="${esc(tip)}" ${id ? `data-goto="${id}"` : ''}></div>`);
    }
    $('#strip').innerHTML = cells.join('');
    const nightWord = n => `${n} ${n === 1 ? 'night' : 'nights'}`;
    const strapline = s.spanCapped ? `first ${nightWord(cells.length)}` : nightWord(s.totalTripNights);
    $('#stripDates').innerHTML = `<span>${fmtDate(s.start)}</span><span>${strapline}</span><span>${fmtDate(s.spanCapped ? s.renderEnd : s.end)}</span>`;
  }

  function renderTripSelect() {
    const sel = $('#tripSelect');
    sel.innerHTML = db.trips.map(t => `<option value="${t.id}" ${t.id === db.activeTripId ? 'selected' : ''}>${esc(t.name)}</option>`).join('');
    // Truncation contract: anything this app clips must be recoverable on hover
    // or long-press, the same way the day-card city chips already are. The
    // select clips at 260px, so it carries the full name as its own title.
    const active = db.trips.find(t => t.id === db.activeTripId);
    sel.title = active ? active.name : '';
  }

  function renderSummary(trip, issues) {
    const s = tripStats(trip);
    const money = tripMoney(trip);
    const chips = [];
    if (s.start && s.end) {
      chips.push(chip('Dates', s.start === s.end ? fmtDate(s.start) : fmtRange(s.start, s.end)));
      const days = diffDays(s.start, s.end) + 1;
      chips.push(chip('Length', `${days} ${days === 1 ? 'day' : 'days'} <small>/ ${s.totalTripNights} ${s.totalTripNights === 1 ? 'night' : 'nights'}</small>`));
      const phase = tripPhase(s.start, s.end, todayIso());
      if (phase.phase === 'before') {
        const until = diffDays(todayIso(), s.start);
        if (until > 0) chips.push(chip('Countdown', `${until} day${until === 1 ? '' : 's'} to go`));
      } else if (phase.phase === 'during') {
        chips.push(chip('Progress', `Day ${phase.dayNumber} <small>of ${phase.totalDays}</small>`, 'ok-chip'));
      } else {
        chips.push(chip('Status', 'Trip completed'));
      }
    }
    if (s.totalTripNights > 0) {
      const cls = s.bookedNights >= s.totalTripNights ? 'ok-chip' : '';
      chips.push(chip('Nights booked', `${s.bookedNights} <small>of ${s.totalTripNights}</small>`, cls));
    }
    // The caveat has to travel WITH the number. moneyNotes explains an
    // unconvertible amount, but it only renders under the Timeline board, so on
    // Days and Map a total silently missing a 900,000 JPY ryokan looked
    // complete, and a green "within budget" was a claim about money that was
    // never counted. An incomplete total says so and never paints green.
    const missing = money.confirmed.unconverted.length;
    const short = n => n ? ` <small>+ ${n} not converted</small>` : '';
    chips.push(chip('Confirmed', moneyHtml(trip, money.confirmed.total, undefined, 'total') + short(missing), missing ? 'warn-chip' : 'ok-chip'));
    // `!==`, not `>`: with refunds in the trip the full plan can be LESS than
    // the confirmed total, and hiding it there hides the very number that
    // explains the difference.
    if (money.planned.total !== money.confirmed.total) {
      chips.push(chip('Full plan', moneyHtml(trip, money.planned.total, undefined, 'total') + short(money.planned.unconverted.length)));
    }
    if (trip.budget != null) {
      const verdict = budgetVerdict(money.confirmed.total, trip.budget, missing);
      // 'refund' means refunds outweigh spend so far. It is not a warning, and
      // "of $3,000" is meaningless against it, so the chip says what happened.
      const body = verdict === 'refund'
        ? `${moneyHtml(trip, money.confirmed.total, undefined, 'total')} <small>budget ${esc(fmtMoney(trip, trip.budget))}</small>`
        : `${esc(fmtMoney(trip, money.confirmed.total))} <small>of ${esc(fmtMoney(trip, trip.budget))}</small>`;
      chips.push(chip('Budget', body + short(missing), (verdict === 'ok' || verdict === 'refund') ? 'ok-chip' : 'warn-chip'));
    }
    const warnCount = issues.length;
    chips.push(chip('Issues', warnCount ? String(warnCount) : 'None', warnCount ? 'warn-chip' : 'ok-chip'));
    $('#summary').innerHTML = chips.join('');
  }
  const chip = (k, v, cls = '') => `<div class="chip ${cls}"><div class="k">${k}</div><div class="v">${v}</div></div>`;

  function renderIssues(issues) {
    const box = $('#issuesBox');
    if (!issues.length) { box.hidden = true; return; }
    box.hidden = false;
    const errs = issues.filter(i => i.level === 'error').length;
    const warns = issues.length - errs;
    $('#issuesSummary').innerHTML =
      `<span>⚠️</span><span>` +
      (errs ? `<span class="count-err">${errs} error${errs === 1 ? '' : 's'}</span>` : '') +
      (errs && warns ? ' · ' : '') +
      (warns ? `<span class="count-warn">${warns} warning${warns === 1 ? '' : 's'}</span>` : '') +
      `</span><span style="color:var(--text-dim);font-weight:400;font-size:13px">(click to review)</span>`;
    $('#issuesList').innerHTML = issues.map((iss, idx) => `
      <li>
        <span class="tag ${iss.level === 'error' ? 'err' : 'warn'}">${iss.level === 'error' ? 'ERROR' : 'WARN'}</span>
        <span>${esc(iss.text)} ${iss.ids.length ? `<a data-jump="${iss.ids[0]}">show</a>` : ''}</span>
      </li>`).join('');
  }

  const filtersActive = () => !!(ui.search || ui.filterType || ui.filterStatus);

  function matchesFilters(it) {
    if (ui.filterType && it.type !== ui.filterType) return false;
    if (ui.filterStatus && it.status !== ui.filterStatus) return false;
    if (ui.search) {
      const q = ui.search.toLowerCase();
      const hay = `${it.title} ${it.location || ''} ${it.details || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }

  // ONE answer to "your filters hid everything", used by the timeline and the
  // day view alike. Both used to render their own: Days a labelled note plus a
  // working Clear filters button, Timeline a bare inline-styled sentence with
  // no way back out.
  function filterEmptyHtml(what) {
    return `<div class="days-note filter-empty">`
      + `<span class="fe-text">No ${esc(what)} match the current search and filters.</span>`
      + `<button type="button" class="btn days-clear" data-act="clear-filters">Clear filters</button></div>`;
  }

  function clearFilters() {
    $('#searchBox').value = '';
    $('#filterType').value = '';
    $('#filterStatus').value = '';
    ui.search = ''; ui.filterType = ''; ui.filterStatus = '';
    render();
  }

  function renderBoard(trip, issues) {
    const board = $('#board');
    const items = sortedItems(trip);

    if (!items.length) {
      // The dropdown starts on whatever the trip's own name points at, so
      // naming a trip "Tokyo 2027" and hitting the button just works.
      const picked = matchSampleTrip(trip.name) || sampleTripOptions()[0].id;
      const opts = sampleTripOptions()
        .map(o => `<option value="${esc(o.id)}"${o.id === picked ? ' selected' : ''}>${esc(o.label)}</option>`).join('');
      board.innerHTML = `
        <div class="empty">
          <div class="big">🗺️</div>
          <h2>Nothing planned yet</h2>
          <p>Add flights, stays and activities. Dates, costs and warnings update live as you type.</p>
          <div class="actions">
            <button class="btn primary" id="emptyAdd">+ Add your first item</button>
            <span class="sample-pick">
              <button class="btn" id="emptySample">Load an example trip</button>
              <span class="sel-wrap">
                <select id="emptySampleDest" class="sample-select" aria-label="Example destination">${opts}</select>
              </span>
            </span>
          </div>
          <p class="sample-note">Examples are illustrative sample data: rough round costs, not quotes or live availability.</p>
        </div>`;
      $('#emptyAdd').addEventListener('click', () => openItemModal(null));
      $('#emptySample').addEventListener('click', () => loadSample($('#emptySampleDest').value));
      return;
    }

    const issueById = {};
    for (const iss of issues) for (const id of iss.ids) {
      issueById[id] = issueById[id] === 'error' ? 'error' : iss.level;
    }
    const gaps = issues.filter(i => i.gap).map(i => i.gap);
    const st = tripStats(trip);
    const phase = (st.start && st.end) ? tripPhase(st.start, st.end, todayIso()) : { phase: 'before' };
    const today = todayIso();
    const filtering = filtersActive();

    const ctx = {
      trip, issueById, today, filtering,
      during: phase.phase === 'during',
      // the item the traveller asked to jump to must be visible when it lands,
      // so its stay and its day open regardless of the saved collapse state
      flashId: ui.flashId,
    };

    const nodes = timelineGroups(items);
    let shownCount = 0;
    let html = '';

    const legsByToId = {};
    for (const leg of tripLegs(trip)) legsByToId[leg.toId] = leg;

    const gapHtml = (g) => `<div class="gap-row">⚠️ ${g.nights} night${g.nights === 1 ? '' : 's'} without a stay: ${g.nights === 1 ? fmtDate(g.start) : fmtRange(g.start, g.end)}</div>`;

    for (const node of nodes) {
      const it = node.item;
      const kids = node.days.reduce((a, d) => a.concat(d.items), []);
      const selfMatch = matchesFilters(it);
      const kidMatches = filtering ? kids.filter(matchesFilters) : kids;
      if (filtering && !selfMatch && !kidMatches.length) continue;
      shownCount += (selfMatch ? 1 : 0) + kidMatches.length;

      // gap banner rendered right before the first node at/after the gap start
      for (const g of gaps) {
        if (!g.rendered && it.startDate >= g.start) { html += gapHtml(g); g.rendered = true; }
      }
      const leg = legsByToId[it.id];
      if (leg) {
        html += `<div class="leg-row"><button class="leg-btn" data-leg-from="${esc(leg.from)}" data-leg-to="${esc(leg.to)}" data-leg-date="${esc(leg.date)}">🧭 ${esc(leg.from)} → ${esc(leg.to)} · how to get there?</button></div>`;
      }
      html += node.kind === 'stay' ? stayNodeHtml(node, kidMatches, ctx) : `<div class="tl-node">${rowHtml(trip, it, issueById[it.id], ctx.during && isPastRow(it, today))}</div>`;
    }
    for (const g of gaps) {
      if (!g.rendered) html += gapHtml(g);
    }

    if (!shownCount) html += filterEmptyHtml('items');

    const money = tripMoney(trip);
    const curList = CURRENCIES.includes(trip.currency || 'USD') ? CURRENCIES : [...CURRENCIES, trip.currency];
    const curOptions = curList.map(c => `<option value="${c}" ${c === (trip.currency || 'USD') ? 'selected' : ''}>${c} (${esc(currencySymbol(c))})</option>`).join('');
    const curDisabled = sharedMode ? 'disabled' : '';
    html += `
      <div class="totals">
        <div class="t currency-pick"><div class="k">Currency</div><select id="currencySel" class="currency-sel" aria-label="Trip currency" ${curDisabled}>${curOptions}</select></div>
        ${money.planned.total !== money.confirmed.total ? `<div class="t"><div class="k">Full plan</div><div class="v">${moneyHtml(trip, money.planned.total, undefined, 'total')}</div></div>` : ''}
        <div class="t confirmed${money.confirmed.unconverted.length ? ' incomplete' : ''}"><div class="k">Confirmed bookings</div><div class="v">${moneyHtml(trip, money.confirmed.total, undefined, 'total')}</div></div>
      </div>`;
    const notes = moneyNotes(trip, money);
    if (notes) html += notes;

    board.innerHTML = html;
    // Paint any ratings the session already knows and batch-fetch only the
    // genuinely-missing queries. Routing through hydrateRatings means a re-render
    // or a repeat venue costs nothing (placesKnown dedups), and a trip with no
    // mapsQuery items fires no request at all.
    hydrateRatings(board);

    if (phase.phase === 'during' && !didAutoScroll) {
      const target = items.find(it => isIsoDate(it.startDate) && it.startDate >= today);
      const el = target && board.querySelector(`[data-id="${target.id}"]`);
      if (el) { el.scrollIntoView({ block: 'center' }); didAutoScroll = true; }
    }

    if (ui.flashId) {
      const el = board.querySelector(`[data-id="${ui.flashId}"]`);
      if (el) { el.classList.add('flash'); el.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
      ui.flashId = null;
    }
  }

  // Note under the totals: which items could not be converted, and how old the
  // rates are when we fell back to a stale cache.
  function moneyNotes(trip, money) {
    const parts = [];
    const unconv = new Set([...money.confirmed.unconverted, ...money.planned.unconverted].map(i => i.id));
    if (unconv.size) {
      if (ratesFetching) {
        parts.push('Fetching exchange rates...');
      } else if (ratesFailed) {
        parts.push('Could not fetch exchange rates, so some amounts are shown unconverted in their own currency.');
      } else {
        parts.push(unconv.size === 1
          ? '1 item is in a currency we could not convert, so it is shown in its own currency and is not counted in the totals.'
          : `${unconv.size} items are in a currency we could not convert, so they are shown in their own currency and are not counted in the totals.`);
      }
    }
    if (money.stale && money.ratesObj) {
      parts.push(`Rates from ${fmtDate(new Date(money.ratesObj.at).toISOString().slice(0, 10))}.`);
    }
    if (!parts.length) return '';
    const retry = (ratesFailed && unconv.size && !ratesFetching)
      ? ' <button type="button" class="btn rates-retry" id="ratesRetryBtn">Retry</button>' : '';
    return `<div class="totals-note">${parts.map(esc).join(' ')}${retry}</div>`;
  }

  // ---------- timeline: the collapsible stay node ----------
  // A collapsed stay has to ADVERTISE what it is hiding, or a warning buried
  // three levels down is invisible: the toggle carries the count and, when
  // anything inside it has an issue, the same marker the row itself would show.
  function nestedIssueLevel(items, issueById) {
    let level = '';
    for (const it of items) {
      const l = issueById[it.id];
      if (l === 'error') return 'error';
      if (l) level = 'warn';
    }
    return level;
  }

  function stayNodeHtml(node, kids, ctx) {
    const { trip, issueById, today, filtering } = ctx;
    const it = node.item;
    const stayRow = rowHtml(trip, it, issueById[it.id], ctx.during && isPastRow(it, today));
    if (!kids.length) return `<div class="tl-node tl-stay">${stayRow}</div>`;

    const kidIds = new Set(kids.map(k => k.id));
    const days = node.days
      .map(d => ({ date: d.date, items: d.items.filter(x => kidIds.has(x.id)) }))
      .filter(d => d.items.length);
    const holdsFlash = ctx.flashId && kidIds.has(ctx.flashId);
    // default: collapsed, except the stay you are inside today while the trip
    // is running. A live filter or a jump target always wins over both.
    const coversToday = ctx.during && isIsoDate(it.startDate) && isIsoDate(it.endDate)
      && it.startDate <= today && today < it.endDate;
    const open = filtering || holdsFlash || isOpen(trip.id, 'stay:' + it.id, coversToday);
    const level = nestedIssueLevel(kids, issueById);
    const badge = level ? `<span class="tl-warn ${level === 'error' ? 'is-err' : ''}" title="${level === 'error' ? 'Something inside has invalid data' : 'A warning applies inside this stay'}">⚠️</span>` : '';
    const total = node.count;
    const label = filtering && kids.length !== total
      ? `${kids.length} of ${total} items match${kids.length === 1 ? 'es' : ''}`
      : `${total} item${total === 1 ? '' : 's'} during this stay`;
    const bodyId = `tlkids-${it.id}`;

    const dayHtml = days.map(d => {
      const dayOpen = filtering || (holdsFlash && d.items.some(x => x.id === ctx.flashId))
        || isOpen(trip.id, `day:${it.id}:${d.date}`, ctx.during && d.date === today);
      const dLevel = nestedIssueLevel(d.items, issueById);
      const dBadge = dLevel ? `<span class="tl-warn ${dLevel === 'error' ? 'is-err' : ''}" aria-hidden="true">⚠️</span>` : '';
      const dId = `tlday-${it.id}-${d.date}`;
      const rows = d.items.map(x => rowHtml(trip, x, issueById[x.id], ctx.during && isPastRow(x, today))).join('');
      return `
        <div class="tl-day ${dayOpen ? 'is-open' : ''}">
          <button type="button" class="tl-toggle tl-day-toggle" data-toggle="day:${esc(it.id)}:${esc(d.date)}" aria-expanded="${dayOpen}" aria-controls="${dId}">
            <span class="tl-caret" aria-hidden="true"></span>
            <span class="tl-toggle-date">${fmtDate(d.date, false)}</span>
            <span class="tl-toggle-count">${d.items.length} item${d.items.length === 1 ? '' : 's'}</span>${dBadge}
          </button>
          <div class="tl-day-items" id="${dId}" ${dayOpen ? '' : 'hidden'}>${rows}</div>
        </div>`;
    }).join('');

    return `
      <div class="tl-node tl-stay ${open ? 'is-open' : ''}">
        ${stayRow}
        <div class="tl-sub">
          <button type="button" class="tl-toggle tl-stay-toggle" data-toggle="stay:${esc(it.id)}" aria-expanded="${open}" aria-controls="${bodyId}">
            <span class="tl-caret" aria-hidden="true"></span>
            <span class="tl-toggle-count">${esc(label)}</span>${badge}
          </button>
          <div class="tl-kids" id="${bodyId}" ${open ? '' : 'hidden'}>${dayHtml}</div>
        </div>
      </div>`;
  }

  // Expanding a stay or a day is pure view state: it is toggled in place rather
  // than through render(), so the page does not jump and nothing lands in undo.
  function toggleNode(btn) {
    const open = btn.getAttribute('aria-expanded') !== 'true';
    const body = document.getElementById(btn.getAttribute('aria-controls'));
    btn.setAttribute('aria-expanded', String(open));
    if (body) body.hidden = !open;
    const holder = btn.closest('.tl-stay, .tl-day');
    if (holder) holder.classList.toggle('is-open', open);
    setOpen(activeTrip().id, btn.dataset.toggle, open);
  }

  function toggleDetails(btn) {
    const body = btn.closest('.det-body');
    const open = btn.getAttribute('aria-expanded') !== 'true';
    body.classList.toggle('is-clamped', !open);
    btn.setAttribute('aria-expanded', String(open));
    btn.textContent = open ? 'Show less' : 'Show more';
  }

  function rowHtml(trip, it, issueLevel, isPast) {
    const look = rowLook(it);
    const sm = STATUS_META[it.status] || STATUS_META['to-book'];
    const n = nights(it);
    const validStart = isIsoDate(it.startDate);
    const dates = isStay(it) && validStart && isIsoDate(it.endDate)
      ? fmtRange(it.startDate, it.endDate)
      : (validStart ? fmtDate(it.startDate) : 'No date');
    // travel legs: show departure -> arrival, with a +Nd badge for overnight legs
    let timeText = it.startTime ? fmtTime(it.startTime) : '';
    if (!isStay(it) && validStart && isIsoDate(it.endDate)) {
      const plus = diffDays(it.startDate, it.endDate);
      const arr = it.endTime ? fmtTime(it.endTime) : (plus > 0 ? fmtDate(it.endDate, false) : '');
      if (arr) timeText = `${timeText || 'dep.'} → ${arr}${plus > 0 ? ` <b style="color:var(--amber)">+${plus}d</b>` : ''}`;
      else if (plus > 0) timeText = `${timeText ? timeText + ' · ' : ''}lands ${fmtDate(it.endDate, false)} <b style="color:var(--amber)">+${plus}d</b>`;
    } else if (!isStay(it) && it.endTime && validStart) {
      timeText = `${timeText || 'dep.'} → ${fmtTime(it.endTime)}`;
    }
    const time = timeText ? `<span class="c-time">${timeText}</span>` : '';
    const cost = costCell(trip, it, n);
    const issueCls = issueLevel === 'error' ? 'has-err' : (issueLevel === 'warn' ? 'has-warn' : '');
    const statusSel = `
      <select class="status-sel ${sm.cls}" data-status-for="${it.id}" aria-label="Status" ${sharedMode ? 'disabled' : ''}>
        ${Object.entries(STATUS_META).map(([k, v]) => `<option value="${k}" ${k === it.status ? 'selected' : ''}>${v.label}</option>`).join('')}
      </select>`;
    // Travel is the trip's connective tissue, not a destination: a dashed rail
    // and a flatter card keep a taxi hop from competing with the museum it
    // takes you to. Each of the three travel types keeps its own accent.
    const travelCls = TRAVEL_TYPES[it.type] ? ' is-travel' : '';
    return `
      <div class="tp-row ${look.cls}${travelCls} ${issueCls} ${it.status === 'cancelled' ? 'is-cancelled' : ''} ${isPast ? 'is-past' : ''}" data-id="${it.id}">
        <span class="c-dot" role="img" aria-label="${esc(look.label)}" title="${esc(look.label)}">${look.icon}</span>
        <div class="c-when">
          <span class="c-date">${dates}</span>${time}${n ? `<span class="c-nights">${n} night${n === 1 ? '' : 's'}</span>` : ''}
        </div>
        <div class="c-main">
          <div class="c-title">${esc(displayTitle(it))}</div>
          ${it.location ? `<div class="c-loc">${esc(it.location)}</div>` : ''}
          ${detailsHtml(it)}
        </div>
        <div class="c-side">
          <div class="c-status">${statusSel}</div>
          <div class="c-cost">${cost}</div>
        </div>
        <div class="c-actions">
          <button class="row-btn" data-act="ask-day" data-date="${esc(it.startDate)}" title="Ask the assistant about this day" aria-label="Ask the assistant about this day">🤖</button>
          <button class="row-btn" data-act="shift-item" title="Shift dates" aria-label="Shift dates">⇄</button>
          <button class="row-btn" data-act="edit" title="Edit" aria-label="Edit">✏️</button>
          <button class="row-btn" data-act="duplicate" title="Duplicate" aria-label="Duplicate">📄</button>
          <button class="row-btn danger" data-act="delete" title="Delete" aria-label="Delete">${TRASH_SVG}</button>
        </div>
      </div>`;
  }

  // details text with live links, plus the item's own Maps link. mapsQuery is a
  // real field now: older items that carry the link inside details still get a
  // clickable anchor from linkify, with no migration.
  // A long paragraph is clamped to a few lines behind a toggle: the text is all
  // there for a screen reader and for Ctrl+F, it just stops making one item as
  // tall as the four around it.
  function detailsHtml(it, cls = 'c-details', withMaps = true) {
    const parts = [];
    if (it.details) {
      const long = isLongDetails(it.details);
      parts.push(`<div class="det-body${long ? ' is-clamped' : ''}">`
        + `<span class="det-text">${linkify(it.details)}</span>`
        + (long ? `<button type="button" class="det-more" data-act="more" aria-expanded="false">Show more</button>` : '')
        + `</div>`);
    }
    // One combined element: the item's Google Maps link with its rating inline
    // (see tripMapsRatingHtml). The days view passes withMaps=false and puts the
    // same element in its action cluster instead.
    if (withMaps) {
      const maps = mapsHtmlFor(it);
      if (maps) parts.push(`<div class="det-chips">${maps}</div>`);
    }
    return parts.length ? `<div class="${cls}">${parts.join('')}</div>` : '';
  }

  function costCell(trip, it, n) {
    const shown = displayCostOf(it);
    if (shown) {
      const base = trip.currency || 'USD';
      const from = shown.currency || base;
      const amount = shown.amount;
      // "~" marks an estimate, never part of the stored number, and an estimate
      // shows no cents (see costDisplayParts)
      const { tilde: est, digits } = costDisplayParts(it);
      // moneyHtml owns the refund wording, so a negative can never reach a
      // human as a bare "-$120.00" here or anywhere else.
      if (from !== base) {
        const conv = convertAmount(amount, from, base, activeRates(trip));
        const entered = est + moneyInHtml(from, amount, digits, 'item');
        if (conv === null) {
          // no rate yet: show the entered amount in its own currency only
          return `<span class="conv-off" title="Not converted (no exchange rate)">${entered}</span>`;
        }
        const per = n ? `<span class="per-night">${moneyHtml(trip, conv / n, digits, 'item')}/night</span>` : '';
        return `${entered} <span class="conv">(~${moneyHtml(trip, conv, digits, 'item')})</span>${per}`;
      }
      const total = est + moneyHtml(trip, amount, digits, 'item');
      const per = n ? `<span class="per-night">${moneyHtml(trip, amount / n, digits, 'item')}/night</span>` : '';
      return `${total}${per}`;
    }
    if (it.costNote) return `<span class="note">${esc(it.costNote)}</span>`;
    // No cost is no cost. The day card already renders '' here; the timeline's
    // stray hyphen read as unfinished data next to a "To book" pill.
    return '';
  }

  // ---------- days view ----------
  // Compact money badge for a day row: same conversion rules as the timeline
  // cost cell, without the per-night breakdown.
  function dayCostBadge(trip, it) {
    const shown = displayCostOf(it);
    if (!shown) {
      return it.costNote ? `<span class="dc-cost is-note">${esc(it.costNote)}</span>` : '';
    }
    const base = trip.currency || 'USD';
    const from = shown.currency || base;
    const amount = shown.amount;
    const { tilde: est, digits } = costDisplayParts(it);
    const refund = refundParts(amount).isRefund ? ' is-refund' : '';
    if (from !== base) {
      const conv = convertAmount(amount, from, base, activeRates(trip));
      const entered = est + moneyInHtml(from, amount, digits, 'item');
      return conv === null
        ? `<span class="dc-cost${refund}">${entered}</span>`
        : `<span class="dc-cost${refund}">${entered} <small>~${moneyHtml(trip, conv, digits, 'item')}</small></span>`;
    }
    return `<span class="dc-cost${refund}">${est}${moneyHtml(trip, amount, digits, 'item')}</span>`;
  }

  function dayEventHtml(ev, trip) {
    const it = ev.item;
    const look = rowLook(it);
    const isStayRow = ev.kind === 'checkin' || ev.kind === 'checkout';
    const tag = ev.kind === 'checkin' ? 'Check in' : (ev.kind === 'checkout' ? 'Check out' : '');
    // A check-out row names the place you are leaving; the location line would
    // just repeat the city you are still standing in.
    const loc = (it.location && ev.kind !== 'checkout') ? `<div class="dc-loc">${esc(it.location)}</div>` : '';
    // A strikethrough alone carried the whole message and lost it the moment
    // the title wrapped or the row was skimmed, so the status says itself.
    const cancelled = it.status === 'cancelled';
    // paperclip only where docs attach once per item (skip checkout dupes)
    const clip = ev.kind === 'checkout' ? '' : `<span class="dc-clip" data-clip-for="${it.id}" hidden>📎</span>`;
    // details and cost ride on the check-in row only: a checkout row is the
    // same item again, and repeating them would double-count the trip on screen
    // Maps leaves the description block and joins the row's action cluster: it
    // is an action like edit and delete, not part of the note text. The combined
    // element carries the Google rating inline once the lookup resolves it.
    const details = ev.kind === 'checkout' ? '' : detailsHtml(it, 'dc-details', false);
    const maps = ev.kind === 'checkout' ? '' : mapsHtmlFor(it);
    const cost = ev.kind === 'checkout' ? '' : dayCostBadge(trip, it);
    // stay rows carry no real time (the assumed ones are for ordering only), so
    // the when column stays EMPTY for them rather than printing a guess
    const when = ev.time ? esc(fmtTime(ev.time)) : '';
    // Delete is offered where the item BEGINS. A check-out row is the far end
    // of a booking that started on an earlier day, so deleting from there would
    // silently drop nights the traveller is not even looking at - the same rule
    // the day's bulk-delete already follows.
    const del = (sharedMode || ev.kind === 'checkout') ? '' :
      `<button class="row-btn danger dc-del" data-act="delete" data-id="${it.id}" title="Delete ${esc(it.title)}" aria-label="Delete ${esc(it.title)}">${TRASH_SVG}</button>`;
    // Edit, unlike delete, is offered from BOTH ends of a stay: it opens the
    // same booking in the same modal and changes nothing until the traveller
    // saves, so a check-out row cannot quietly drop nights the way a delete
    // from there would.
    const edit = sharedMode ? '' :
      `<button class="row-btn dc-edit" data-act="edit" data-id="${it.id}" title="Edit ${esc(it.title)}" aria-label="Edit ${esc(it.title)}">${PENCIL_SVG}</button>`;
    const travelCls = TRAVEL_TYPES[it.type] ? ' is-travel' : '';
    // Status is the rail dot's colour AND the colour the time reads in, so the
    // four statuses stay legible at a glance without a pill on every row. The
    // dot carries the label in text for anyone who cannot use the colour.
    const sm = STATUS_META[it.status] || STATUS_META['to-book'];
    // Two tags can be true at once (a cancelled booking still checks in on this
    // day), so they share one line rather than one slot.
    const tags = (tag ? `<span class="dc-tag">${tag}</span>` : '')
      + (cancelled ? '<span class="dc-tag is-cancelled">Cancelled</span>' : '');
    return `<div class="dc-event ${look.cls}${travelCls}${isStayRow ? ' is-stay' : ''} ${sm.cls} ${cancelled ? 'is-cancelled' : ''}">
      <div class="dc-rail">
        <span class="dc-dot" role="img" aria-label="${esc(sm.label)}" title="${esc(sm.label)}"></span>
        ${when ? `<span class="dc-when">${when}</span>` : ''}
      </div>
      <div class="dc-item">
        <div class="dc-main">
          <span class="dc-ico" role="img" aria-label="${esc(look.label)}" title="${esc(look.label)}">${look.icon}</span>
          <div class="dc-label">
            ${tags}
            <div class="dc-title">${esc(displayTitle(it))}${clip}</div>
            ${loc}
          </div>
          <div class="dc-facts">${cost}${maps}</div>
          <div class="dc-btns">${edit}${del}</div>
        </div>
        ${details}
      </div>
    </div>`;
  }

  // City and typical temperature ride in ONE chip. The temperature lands later
  // (async climate fetch), so the slots exist from the first paint and the chip
  // stays hidden until it has something to say.
  // The city is whatever dayMorningCity resolved (see renderDays) and rides on
  // data-city so the weather pass keys off the exact same string: the name and
  // the temperature in one chip must never describe two different places.
  function dayChipHtml(card) {
    const city = card.city || '';
    const title = card.citySource === 'stay' ? `Staying in ${city}` : city;
    return `<span class="dc-chip" data-city="${esc(city)}"${city ? ` title="${esc(title)}"` : ' hidden'}>
      <span class="dc-chip-city">${esc(city)}</span><span class="dc-chip-sep" hidden></span><span class="dc-chip-temp"></span>
    </span>`;
  }

  // Everything with a startDate on this day can be bulk-deleted; a check-OUT row
  // belongs to a stay that began earlier, so it is not "an event on this day".
  const dayClearCount = card => card.events.filter(ev => ev.kind !== 'checkout').length + card.untimed.length;

  function dayCardHtml(card, isToday, trip) {
    const parts = [];
    if (card.events.length) parts.push(card.events.map(ev => dayEventHtml(ev, trip)).join(''));
    if (card.untimed.length) {
      parts.push(`<div class="dc-untimed"><span class="dc-untimed-label">No time set</span>${card.untimed.map(ev => dayEventHtml(ev, trip)).join('')}</div>`);
    }
    // A day with nothing on it still has a bed if a stay spans it, and saying
    // "No plans yet" there would be false (see emptyDayNote).
    if (!parts.length) parts.push(`<div class="dc-empty">${esc(emptyDayNote(trip.items, card.date))}</div>`);
    // the bulk-delete count is the FULL day, never the filtered view: the button
    // deletes everything on the date, so its label has to say so
    const canClear = !sharedMode && (card.clearCount != null ? card.clearCount : dayClearCount(card)) > 0;
    const editBtns = sharedMode ? '' : `
            <button class="row-btn" data-act="add-day" data-date="${card.date}" title="Add an item on this day" aria-label="Add an item on ${esc(fmtDate(card.date))}">+</button>
            ${canClear ? `<button class="row-btn danger" data-act="clear-day" data-date="${card.date}" title="Delete every item on this day" aria-label="Delete every item on ${esc(fmtDate(card.date))}">${TRASH_SVG}</button>` : ''}`;
    return `
      <section class="day-card ${isToday ? 'is-today' : ''}" data-date="${card.date}" aria-label="${esc(fmtDate(card.date))}">
        <header class="dc-head">
          <span class="dc-daynum" aria-label="Day ${card.dayNumber} of ${card.totalDays}" title="Day ${card.dayNumber} of ${card.totalDays}">
            <b>${card.dayNumber}</b><small>/${card.totalDays}</small>
          </span>
          <span class="dc-headings">
            <span class="dc-dow">${fmtDow(card.date)}${isToday ? ' <span class="dc-today">Today</span>' : ''}</span>
            <span class="dc-date">${fmtDate(card.date)}</span>
          </span>
          ${card.city ? '<span class="dc-vr" aria-hidden="true"></span>' : ''}
          ${dayChipHtml(card)}
          <span class="dc-acts">
            <button class="row-btn" data-act="ask-day" data-date="${card.date}" title="Ask the assistant about this day" aria-label="Ask the assistant about ${esc(fmtDate(card.date))}">🤖</button>${editBtns}
          </span>
        </header>
        <div class="dc-body">${parts.join('')}</div>
      </section>`;
  }

  // Stays, flights and between-cities transport are the trip's skeleton: they
  // anchor the nights and every move from one city to the next, so deleting one
  // silently breaks night coverage or opens a travel gap the traveller only
  // discovers much later. Activities, notes and local hops are cheap and the
  // toast's undo is enough.
  const STRUCTURAL_TYPES = { stay: 'stay', flight: 'flight', transport: 'transport' };

  // Why this delete needs a confirm, in the words the dialog will use. Both
  // reasons (structural item, attached documents) collapse into ONE dialog:
  // stacking two confirms for a single delete is how a traveller learns to
  // click through them without reading.
  function deleteWarnings(it) {
    const notes = [];
    if (it.type === 'stay') {
      const n = nights(it);
      notes.push(n
        ? `${n} night${n === 1 ? '' : 's'} lose their booking.`
        : 'Those nights lose their booking.');
    } else if (it.type === 'flight' || it.type === 'transport') {
      notes.push('This is how you get from one place to the next, so the trip may be left with a travel gap.');
    }
    if ((docCounts.get(it.id) || 0) > 0) notes.push('Attached documents cannot be recovered.');
    return notes;
  }

  // The ONE per-item delete path: the timeline row button and the day-card row
  // button both land here, so they share the confirm text and the undo.
  function deleteItem(id) {
    const trip = activeTrip();
    const it = trip.items.find(x => x.id === id);
    if (!it) return;
    // A confirm is required when the item is structural, or when it carries
    // documents (those live in IndexedDB and the quick undo restores only the
    // item, so they are gone for good).
    const hasDocs = (docCounts.get(id) || 0) > 0;
    if (STRUCTURAL_TYPES[it.type] || hasDocs) {
      const label = TYPE_META[it.type] ? TYPE_META[it.type].label.toLowerCase() : 'item';
      const notes = [`"${it.title}" will be permanently deleted.`, ...deleteWarnings(it)];
      confirmDialog(`Delete this ${label}?`, notes.join(' '), `Delete ${label}`, () => {
        const idx = trip.items.findIndex(x => x.id === id);
        if (idx < 0) return;
        trip.items.splice(idx, 1);
        // Documents are unrecoverable, so that delete is final; a structural
        // item with no documents keeps the undo the confirm just double-checked.
        if (hasDocs) {
          deleteDocsForItem(id);
          const ok = save(); render();
          if (ok) toast(`Deleted "${it.title}"`);
          return;
        }
        lastDeleted = { item: it, idx, tripId: trip.id };
        const ok = save(); render();
        if (ok) toast(`Deleted "${it.title}"`, undoDelete);
      });
      return;
    }
    const idx = trip.items.findIndex(x => x.id === id);
    lastDeleted = { item: it, idx, tripId: trip.id };
    trip.items.splice(idx, 1);
    const ok = save(); render();
    if (ok) toast(`Deleted "${it.title}"`, undoDelete);
  }

  function undoDelete() {
    const t2 = db.trips.find(x => x.id === lastDeleted.tripId);
    if (!t2) return;
    t2.items.splice(Math.min(lastDeleted.idx, t2.items.length), 0, lastDeleted.item);
    // The toast outlives a trip switch, so this restore can land in a trip that
    // is not on screen. Going there is the only way the traveller sees it
    // happen; restoring invisibly reads as the button doing nothing.
    const elsewhere = t2.id !== db.activeTripId;
    if (elsewhere) db.activeTripId = t2.id;
    save(elsewhere ? `Restored "${lastDeleted.item.title}" in "${t2.name}"` : '');
    render();
  }

  // Bulk delete: every item whose start date IS this day. A stay checking in
  // today counts (it starts here); a stay merely spanning or checking out today
  // does not, so a day's cleanup can never wipe nights that belong to earlier
  // days. One save() means one undo puts the whole day back.
  function clearDay(date) {
    const trip = activeTrip();
    const doomed = trip.items.filter(it => it.startDate === date);
    if (!doomed.length) return;
    const n = doomed.length;
    const label = `${n} item${n === 1 ? '' : 's'}`;
    const stays = doomed.filter(isStay);
    const notes = [`Everything scheduled on ${fmtDate(date)} will be deleted.`];
    if (stays.length) {
      notes.push(`This includes ${stays.length === 1 ? 'a stay' : `${stays.length} stays`} checking in on this day (${stays.map(s => s.title).join(', ')}), so those nights lose their booking.`);
    }
    const spanning = trip.items.some(it => isStay(it) && it.startDate !== date && isIsoDate(it.endDate) && it.startDate < date && date <= it.endDate);
    if (spanning) notes.push('A stay that started earlier is kept.');
    if (doomed.some(it => (docCounts.get(it.id) || 0) > 0)) notes.push('Attached documents cannot be recovered.');
    confirmDialog(`Delete ${label} from ${fmtDate(date, false)}?`, notes.join(' '), `Delete ${label}`, () => {
      const ids = new Set(doomed.map(it => it.id));
      for (const id of ids) { if ((docCounts.get(id) || 0) > 0) deleteDocsForItem(id); }
      trip.items = trip.items.filter(it => !ids.has(it.id));
      const ok = save();
      const snapshot = lastSaved;
      render();
      if (ok) toast(`Deleted ${label} from ${fmtDate(date, false)}`, () => {
        // only safe while ours is still the newest snapshot; anything saved
        // since would be what undo() actually reverses
        if (lastSaved === snapshot) undo();
      });
    });
  }

  function renderDays() {
    const trip = activeTrip();
    const box = $('#daysList');
    const all = dayCards(trip);
    if (!all.length) {
      box.innerHTML = `<div class="empty" style="padding:40px 24px"><p>Add items with dates and a day-by-day plan appears here.</p></div>`;
      return;
    }
    const st = tripStats(trip);
    const phase = (st.start && st.end) ? tripPhase(st.start, st.end, todayIso()) : { phase: 'before' };
    const today = todayIso();
    const filtering = filtersActive();

    // The search box and both filters apply HERE too. A day with nothing left
    // after filtering is dropped rather than left as an empty tile, and the
    // count line above the grid is what makes the hiding visible instead of
    // mysterious. Bulk delete still counts the whole day (see dayCardHtml).
    const cards = [];
    for (const c of all) {
      const card = filtering
        ? { ...c, events: c.events.filter(ev => matchesFilters(ev.item)), untimed: c.untimed.filter(ev => matchesFilters(ev.item)) }
        : c;
      card.clearCount = dayClearCount(c);
      if (filtering && !card.events.length && !card.untimed.length) continue;
      cards.push(card);
    }
    for (const c of cards) {
      const m = dayMorningCity(trip.items, c.date, geoResolved);
      c.city = m.city;
      c.citySource = m.source;
    }
    let note = (filtering && cards.length)
      ? `<div class="days-note">Showing ${cards.length} of ${all.length} day${all.length === 1 ? '' : 's'}<button type="button" class="btn days-clear" data-act="clear-filters">Clear filters</button></div>`
      : '';
    // Capping the day view is only honest if it says so; the issues list above
    // names the item whose date stretched the trip this far.
    if (st.spanCapped) note += `<div class="days-note">Showing the first ${MAX_TRIP_DAYS} days. One item is dated far outside the trip, see the issues above.</div>`;
    if (!cards.length) {
      box.innerHTML = note + filterEmptyHtml('days');
      return;
    }
    // The weather caveat was a `title` tooltip only, i.e. invisible on every
    // touch device, which is most of the traffic for a trip planner. It is a
    // visible line under the grid instead, and it carries the Open-Meteo credit
    // its CC-BY licence requires, in the one view the data appears in.
    const wx = '<div class="days-note days-wx">Temperatures are typical for that month across the last '
      + WEATHER_YEARS + ' years of records, not a forecast. Weather data by '
      + '<a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo</a> (CC BY 4.0).</div>';
    box.innerHTML = note + cards.map(c => dayCardHtml(c, phase.phase === 'during' && c.date === today, trip)).join('') + wx;
    // Same one batched lookup as the timeline: paints from the shared session
    // cache instantly, so switching into the days view never refetches a key the
    // board already resolved.
    hydrateRatings(box);
    loadWeatherForDays();
    refreshDocIndicators();
  }

  // ---------- typical weather (Open-Meteo archive, cached) ----------
  // How many years of the same month are averaged into "typical".
  const WEATHER_YEARS = 5;
  // v2: the value changed meaning (a 5-year normal, not one year's readings), so
  // a cached v1 number would be a different claim under the same label.
  const WEATHER_KEY = 'trip-planner:weather:v2';
  let weatherCache = {};
  try { weatherCache = JSON.parse(localStorage.getItem(WEATHER_KEY) || '{}') || {}; } catch { weatherCache = {}; }
  const weatherInflight = new Map();

  // The chip shows only the range; the honest wording (typical for the season,
  // not a forecast) lives in the tooltip, which is the whole point of splitting
  // weatherRange out of weatherLine.
  function writeWeatherSlot(chip, place, rec) {
    const range = weatherRange(rec);
    if (!range) return;
    chip.querySelector('.dc-chip-temp').textContent = range;
    chip.querySelector('.dc-chip-sep').hidden = !chip.querySelector('.dc-chip-city').textContent;
    chip.title = `${weatherLine(place, rec)}. Typical for this month across the last ${WEATHER_YEARS} years of records, not a forecast.`;
    chip.hidden = false;
  }
  function applyWeather(key, place, rec) {
    document.querySelectorAll('#daysList .dc-chip').forEach(chip => {
      if (chip.dataset.weatherKey === key) writeWeatherSlot(chip, chip.dataset.weatherPlace || place, rec);
    });
  }

  // For each distinct (city, month) pair on screen, show the cached climate
  // line now and lazily fetch any we're missing (one call per pair). The city
  // is read back off the chip, so it is byte-for-byte the one being displayed.
  function loadWeatherForDays() {
    const pairs = new Map();
    document.querySelectorAll('#daysList .day-card').forEach(card => {
      const date = card.dataset.date;
      const place = (card.querySelector('.dc-chip').dataset.city || '').trim();
      if (!place) return;
      const month = Number(date.slice(5, 7));
      const key = weatherKey(place.toLowerCase(), month);
      const chip = card.querySelector('.dc-chip');
      chip.dataset.weatherKey = key;
      chip.dataset.weatherPlace = place;
      if (!pairs.has(key)) pairs.set(key, { place, month, key, date });
      const cached = weatherCache[key];
      if (cached) writeWeatherSlot(chip, place, cached);
    });
    for (const pair of pairs.values()) {
      if (!weatherCache[pair.key]) ensureWeather(pair);
    }
  }

  function ensureWeather(pair) {
    const { key, place, month, date } = pair;
    if (weatherCache[key] || weatherInflight.has(key) || !navigator.onLine) return;
    const p = (async () => {
      const hit = await geocode(place);
      if (!hit.ok) return null;
      // A MULTI-YEAR normal, not a single year. This used to fetch the same
      // month from ONE year (the trip year minus one) and present it as
      // "typically", so a single freak August was the whole claim. It now spans
      // WEATHER_YEARS of that month and averages across them.
      //
      // The window still ENDS on the same safely-archived date it always did
      // (the target month of trip-year-minus-one; the archive lags a few days),
      // and one contiguous range is one request: the month is selected from the
      // response below rather than by fetching a range per year.
      const year = Number(date.slice(0, 4)) - 1;
      const mm = String(month).padStart(2, '0');
      const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
      const from = year - (WEATHER_YEARS - 1);
      const url = 'https://archive-api.open-meteo.com/v1/archive'
        + `?latitude=${hit.lat}&longitude=${hit.lon}`
        + `&start_date=${from}-${mm}-01&end_date=${year}-${mm}-${String(lastDay).padStart(2, '0')}`
        + '&daily=temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=auto';
      const res = await fetch(url);
      if (!res.ok) throw new Error('http ' + res.status);
      const data = await res.json();
      const daily = data && data.daily;
      if (!daily || !Array.isArray(daily.time)) return null;
      const keep = pickMonthSamples(daily.time, mm, [daily.temperature_2m_min, daily.temperature_2m_max, daily.precipitation_sum]);
      const s = summarizeClimate(keep[0], keep[1], keep[2]);
      if (s.lo == null || s.hi == null) return null;
      const rec = { at: Date.now(), lo: s.lo, hi: s.hi, wet: s.wet };
      weatherCache[key] = rec;
      try { localStorage.setItem(WEATHER_KEY, JSON.stringify(weatherCache)); } catch { /* best effort */ }
      return rec;
    })()
      .then(rec => { if (rec && ui.view === 'days') applyWeather(key, place, rec); return rec; })
      .catch(() => { /* offline / geocode miss / bad response: leave the slot empty */ })
      .finally(() => weatherInflight.delete(key));
    weatherInflight.set(key, p);
  }

  // ---------- documents pocket (IndexedDB, device-local) ----------
  let docsDbPromise = null;
  function docsDb() {
    if (!docsDbPromise) {
      docsDbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open('trip-planner-docs', 1);
        req.onupgradeneeded = () => {
          const store = req.result.createObjectStore('docs', { keyPath: 'id', autoIncrement: true });
          store.createIndex('byItem', 'itemId');
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return docsDbPromise;
  }
  // Every helper issues its request in the SAME tick the transaction is
  // created: an IndexedDB transaction auto-commits once it goes idle, so an
  // await between `db.transaction()` and the request would kill it.
  async function addDoc(itemId, file) {
    const db = await docsDb();
    return new Promise((res, rej) => {
      const rq = db.transaction('docs', 'readwrite').objectStore('docs')
        .add({ itemId, name: file.name, type: file.type, size: file.size, blob: file });
      rq.onsuccess = () => res({ id: rq.result });
      rq.onerror = () => rej(rq.error);
    });
  }
  async function listDocs(itemId) {
    const db = await docsDb();
    return new Promise((res, rej) => {
      const rq = db.transaction('docs', 'readonly').objectStore('docs').index('byItem').getAll(itemId);
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    });
  }
  async function deleteDoc(id) {
    const db = await docsDb();
    return new Promise((res, rej) => {
      const rq = db.transaction('docs', 'readwrite').objectStore('docs').delete(id);
      rq.onsuccess = () => res();
      rq.onerror = () => rej(rq.error);
    });
  }
  async function deleteDocsForItem(itemId) {
    const db = await docsDb();
    return new Promise((res, rej) => {
      const tx = db.transaction('docs', 'readwrite');
      const store = tx.objectStore('docs');
      const rq = store.index('byItem').getAllKeys(itemId);
      rq.onsuccess = () => { for (const k of rq.result) store.delete(k); };
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  }

  // In-memory itemId -> doc count, refreshed by one full sweep per render, then
  // patched onto timeline rows and day cards (both may be in the DOM at once).
  let docCounts = new Map();
  async function refreshDocIndicators() {
    try {
      const db = await docsDb();
      const all = await new Promise((res, rej) => {
        const rq = db.transaction('docs', 'readonly').objectStore('docs').getAll();
        rq.onsuccess = () => res(rq.result);
        rq.onerror = () => rej(rq.error);
      });
      docCounts = new Map();
      for (const d of all) docCounts.set(d.itemId, (docCounts.get(d.itemId) || 0) + 1);
    } catch { docCounts = new Map(); }
    applyDocIndicators();
  }
  function applyDocIndicators() {
    document.querySelectorAll('.dc-clip[data-clip-for]').forEach(el => {
      el.hidden = !(docCounts.get(el.dataset.clipFor) > 0);
    });
    document.querySelectorAll('#board .tp-row[data-id]').forEach(row => {
      const title = row.querySelector('.c-title');
      if (!title) return;
      let clip = title.querySelector('.tp-clip');
      const has = docCounts.get(row.dataset.id) > 0;
      if (has && !clip) {
        clip = document.createElement('span');
        clip.className = 'tp-clip';
        clip.textContent = ' 📎';
        clip.title = 'Has attached documents';
        title.appendChild(clip);
      } else if (!has && clip) {
        clip.remove();
      }
    });
  }

  // Object URLs for the current thumbnail list; revoked on rebuild/close.
  let docObjectUrls = [];
  function revokeDocUrls() { docObjectUrls.forEach(u => URL.revokeObjectURL(u)); docObjectUrls = []; }

  async function renderDocsList(itemId) {
    const list = $('#docsList');
    revokeDocUrls();
    const docs = await listDocs(itemId);
    list.innerHTML = docs.map(d => {
      let preview;
      if ((d.type || '').startsWith('image/')) {
        const url = URL.createObjectURL(d.blob);
        docObjectUrls.push(url);
        preview = `<img src="${url}" alt="">`;
      } else {
        preview = `<span class="doc-file">📄</span>`;
      }
      return `<div class="doc-thumb" data-doc-id="${d.id}">
        <div class="doc-preview">${preview}</div>
        <span class="doc-name" title="${esc(d.name)}">${esc(d.name)}</span>
        <button type="button" class="doc-remove" data-doc-remove="${d.id}" aria-label="Remove ${esc(d.name)}">✕</button>
      </div>`;
    }).join('');
  }

  async function attachDocs(files) {
    const itemId = ui.editingId;
    if (!itemId || !files.length) return;
    const errBox = $('#docsErr');
    let count = (await listDocs(itemId)).length;
    const problems = [];
    let added = 0;
    for (const f of files) {
      const g = docGuard(count, f.size);
      if (!g.ok) {
        if (g.reason === 'count') { problems.push('You can attach at most 10 files to an item.'); break; }
        problems.push(`"${f.name}" is over the 2MB limit and was not added.`);
        continue;
      }
      await addDoc(itemId, f);
      count++; added++;
    }
    if (problems.length) { errBox.textContent = problems.join(' '); errBox.hidden = false; }
    else errBox.hidden = true;
    await renderDocsList(itemId);
    refreshDocIndicators();
    if (added) toast(`${added} document${added === 1 ? '' : 's'} attached`);
  }

  // ---------- item modal ----------
  let modalType = 'flight';
  // true once the traveller taps "Use ... as the price" in this modal session:
  // the save then keeps the number in `cost` and drops the estimate, so the
  // item ends up with exactly one number and it is one they chose.
  let estAdopted = false;

  function renderCostEstimateHint(it) {
    const box = $('#costEstHint');
    if (!box) return;
    if (sharedMode || !hasEstimate(it) || (it && it.cost != null)) {
      box.hidden = true; box.innerHTML = ''; return;
    }
    const trip = activeTrip();
    const cur = it.estCostCurrency || trip.currency || 'USD';
    const shown = '~' + fmtMoneyIn(cur, Number(it.estCost), 0);
    box.hidden = false;
    box.innerHTML = `<span>Suggested price ${esc(shown)}. It is not counted in your totals.</span>`
      + `<button type="button" class="btn-mini" id="adoptEstBtn">Use ${esc(shown)} as the price</button>`;
  }

  function adoptEstimate() {
    const it = ui.editingId ? activeTrip().items.find(x => x.id === ui.editingId) : null;
    if (!hasEstimate(it)) return;
    $('#inCostCurrency').value = it.estCostCurrency || activeTrip().currency || 'USD';
    $('#inCost').value = String(Number(it.estCost));
    syncCostPrefix();
    estAdopted = true;
    $('#costEstHint').hidden = true;
    $('#costEstHint').innerHTML = '';
    $('#inCost').focus({ preventScroll: true });
  }

  function syncCostPrefix() {
    const sym = currencySymbol($('#inCostCurrency').value);
    $('#costPrefix').textContent = sym;
    $('#inCost').style.paddingLeft = (sym.length > 1 ? 18 + sym.length * 9 : 34) + 'px';
  }

  function openItemModal(itemId, presetDate) {
    ui.editingId = itemId;
    const it = itemId ? activeTrip().items.find(x => x.id === itemId) : null;
    $('#itemModalTitle').textContent = it ? 'Edit item' : 'Add item';
    $('#itemSaveBtn').textContent = it ? 'Save changes' : 'Add item';
    setModalType(it ? it.type : 'flight');
    $('#inTitle').value = it ? it.title : '';
    $('#inLocation').value = it ? (it.location || '') : '';
    $('#inStart').value = it ? (it.startDate || '') : (presetDate || '');
    $('#inEnd').value = it && it.type === 'stay' ? (it.endDate || '') : '';
    $('#inArrDate').value = it && it.type !== 'stay' ? (it.endDate || '') : '';
    $('#inArrTime').value = it ? (it.endTime || '') : '';
    $('#inTime').value = it ? (it.startTime || '') : '';
    $('#inStatus').value = it ? it.status : 'to-book';
    const base = activeTrip().currency || 'USD';
    // an estimate-only item has no costCurrency yet, so the picker opens on the
    // currency the guess is in: that is the currency adopting it would use
    const itemCur = (it && (it.costCurrency || it.estCostCurrency)) || base;
    const curList = [...new Set([...CURRENCIES, base, itemCur])];
    $('#inCostCurrency').innerHTML = curList.map(c => `<option value="${c}">${c} (${esc(currencySymbol(c))})</option>`).join('');
    $('#inCostCurrency').value = itemCur;
    const sym = currencySymbol(itemCur);
    $('#costPrefix').textContent = sym;
    $('#inCost').style.paddingLeft = (sym.length > 1 ? 18 + sym.length * 9 : 34) + 'px';
    // an estimate is never prefilled here: saving must not promote a guess into
    // the budget by accident. It shows as a hint with a one-tap adopt instead.
    $('#inCost').value = it && it.cost != null ? it.cost : '';
    estAdopted = false;
    renderCostEstimateHint(it);
    $('#inCostNote').value = it ? (it.costNote || '') : '';
    $('#inDetails').value = it ? (it.details || '') : '';
    renderDetailLinks(it);
    syncDocsSection(it);
    clearFieldErrors();
    openOverlay('#itemOverlay');
    // preventScroll keeps the modal parked at its heading; without it the
    // overlay scrolls the title field up and hides the heading on phones
    $('#inTitle').focus({ preventScroll: true });
  }

  // A textarea can't hold live links, so the edit view lists every link the item
  // carries (URLs typed into details, plus its Maps field) right below the box.
  function renderDetailLinks(it) {
    const box = $('#inDetailLinks');
    const links = it ? linkifySegments(it.details || '').filter(s => s.href) : [];
    const maps = it && it.mapsQuery ? mapsLinkHtml(it.mapsQuery) : '';
    if (!links.length && !maps) { box.hidden = true; box.innerHTML = ''; return; }
    box.hidden = false;
    box.innerHTML = links
      .map(s => `<a href="${esc(s.href)}" target="_blank" rel="noopener">${esc(s.href)}</a>`)
      .concat(maps ? [maps] : [])
      .join('');
  }

  // Documents attach to a saved item, so the section only appears when editing
  // (never on a brand-new item, never in the read-only shared view).
  function syncDocsSection(it) {
    const section = $('#docsSection');
    if (sharedMode) { section.hidden = true; return; }
    section.hidden = false;
    const editing = !!(it && it.id);
    $('#docsNew').hidden = editing;
    $('#docsExisting').hidden = !editing;
    $('#docsErr').hidden = true;
    revokeDocUrls();
    if (editing) renderDocsList(it.id);
    else $('#docsList').innerHTML = '';
  }

  function setModalType(t) {
    modalType = t;
    document.querySelectorAll('#typePicker button').forEach(b => {
      const on = b.dataset.type === t;
      b.classList.toggle('on', on);
      // the segment's selected state is a tint, so it needs a spoken equivalent
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    const stay = t === 'stay';
    // TRAVEL_TYPES, not a private list: `local` is a travel type everywhere
    // else (the row accent, the timed-ICS rule), so it gets the arrival row
    // too. Without it a local leg's arrival date sat in a hidden field and was
    // blanked on the next save.
    const travel = !!TRAVEL_TYPES[t];
    $('#fEnd').style.display = stay ? '' : 'none';
    $('#fTime').style.display = stay ? 'none' : '';
    $('#fArrivalRow').style.display = travel ? '' : 'none';
    $('#startLabel').textContent = stay ? 'Check-in' : (travel ? 'Departs' : 'Date');
    $('#timeLabel').innerHTML = (travel ? 'Departure time' : 'Time') + ' <small>(optional)</small>';
    $('#arrDateLabel').innerHTML = (t === 'flight' ? 'Lands on' : 'Arrives on') + ' <small>(optional, for overnight legs)</small>';
    $('#arrTimeLabel').innerHTML = (t === 'flight' ? 'Landing time' : 'Arrival time') + ' <small>(optional)</small>';
    $('#titleLabel').textContent = stay ? 'Hotel / stay name' : 'Title';
    $('#inTitle').placeholder = stay ? 'e.g. Hotel Mystays Premier Akasaka' : (t === 'flight' ? 'e.g. Shreveport to Tokyo (HND)' : 'e.g. Grand Palace tour');
    // Meals are activities with a naming convention, not a seventh type: the
    // prefix list is the assistant's contract and the same read drives the
    // icon, the amber accent and the estimate tilde. It was invisible, though,
    // so a traveller could see the colour and never be able to choose it. The
    // rule is now printed where it is used instead of the type list growing an
    // entry that would fork the data model and the assistant contract.
    const meal = $('#mealHint');
    meal.hidden = t !== 'activity';
    if (t === 'activity') {
      meal.textContent = 'Start the title with ' + mealTitlePrefixes().map(p => p.trim()).join(' ')
        + ' to mark it as a meal (its own icon and colour).';
    }
  }

  function clearFieldErrors() { document.querySelectorAll('#itemForm .field.invalid').forEach(f => f.classList.remove('invalid')); }

  function submitItemForm(e) {
    e.preventDefault();
    clearFieldErrors();
    const travel = !!TRAVEL_TYPES[modalType];
    // the form rebuilds the item from scratch, so anything it does not expose
    // has to be read off the item being edited or it is lost on save
    const prev = ui.editingId
      ? (activeTrip().items.find(x => x.id === ui.editingId) || {}) : {};
    // An activity or a note can legitimately carry an end date (import, a share
    // link, the assistant), but the arrival row is hidden for those types, so
    // there is no field to round-trip it through and a no-op edit wrote it
    // away. Carry it instead. Switching AWAY from a type whose arrival row was
    // on screen still clears it: there the traveller saw the values go.
    const prevHadArrivalRow = !!TRAVEL_TYPES[prev.type] || prev.type === 'stay';
    const carryEnd = !travel && modalType !== 'stay' && !!ui.editingId && !prevHadArrivalRow;
    const it = {
      id: ui.editingId || uid(),
      type: modalType,
      title: $('#inTitle').value.trim(),
      location: $('#inLocation').value.trim(),
      startDate: $('#inStart').value,
      endDate: modalType === 'stay' ? $('#inEnd').value : (travel ? $('#inArrDate').value : (carryEnd ? (prev.endDate || '') : '')),
      endTime: travel ? $('#inArrTime').value : (carryEnd ? (prev.endTime || '') : ''),
      startTime: modalType === 'stay' ? '' : $('#inTime').value,
      status: $('#inStatus').value,
      // rounded on entry: type=number happily accepts 12.12345678, which then
      // renders as $12.12 and sums at full precision, so the total stops
      // matching the rows the traveller can see
      cost: $('#inCost').value === '' ? null : roundMoney($('#inCost').value),
      // always stamp the entered currency so a later change of the trip's
      // display currency converts this amount instead of relabeling it
      costCurrency: $('#inCost').value === '' ? undefined : $('#inCostCurrency').value,
      costNote: $('#inCostNote').value.trim(),
      details: $('#inDetails').value.trim(),
    };
    if (it.costCurrency === undefined) delete it.costCurrency;
    // the Maps field is not user-editable, so carry it across an edit instead
    // of silently dropping it
    if (prev.mapsQuery) it.mapsQuery = prev.mapsQuery;
    // The estimate survives an ordinary edit and dies on adoption, because
    // adopting has already copied the number into the cost field above. But
    // "adopted, then changed my mind and cleared the box" is not an adoption:
    // the number was not kept, so destroying the suggestion there made the
    // gentlest possible action the destructive one.
    const adoptionKept = estAdopted && it.cost != null;
    if (!adoptionKept && prev.estCost != null) {
      it.estCost = prev.estCost;
      if (prev.estCostCurrency) it.estCostCurrency = prev.estCostCurrency;
    }
    const errs = validateItem(it);
    // The range check lives HERE rather than in validateItem on purpose: an
    // out-of-range date that arrives by import or share link must keep going to
    // the computeIssues error that names the offending item, which is the path
    // the render cap depends on. This is only about catching the typo at entry.
    // #itemForm carries novalidate, so the inputs' own min/max never fire on a
    // typed value; DATE_MIN/DATE_MAX are the same bounds those attributes are
    // stamped from (see syncDateBounds).
    const rangeMsg = `Use a date between ${DATE_MIN} and ${DATE_MAX}.`;
    const startOutOfRange = !errs.start && it.startDate && !isDateInRange(it.startDate);
    const endOutOfRange = !errs.end && it.endDate && !isDateInRange(it.endDate);
    if (startOutOfRange) errs.start = true;
    if (endOutOfRange) errs.end = rangeMsg;

    if (errs.title) $('#fTitle').classList.add('invalid');
    if (errs.start) {
      $('#fStart').classList.add('invalid');
      $('#startErr').textContent = startOutOfRange ? rangeMsg : 'A valid date is required.';
    }
    if (errs.end) {
      const endField = modalType === 'stay' ? '#fEnd' : '#fArrDate';
      $(endField).classList.add('invalid');
      const msg = typeof errs.end === 'string' ? errs.end : '';
      if (modalType === 'stay') $('#endErr').textContent = msg || 'Check-out must be after check-in.';
      else $('#arrErr').textContent = msg || 'Arrival cannot be before departure.';
    }
    if (errs.cost) $('#fCost').classList.add('invalid');
    if (Object.keys(errs).length) return;

    const trip = activeTrip();
    if (ui.editingId) {
      const idx = trip.items.findIndex(x => x.id === ui.editingId);
      it.createdAt = trip.items[idx].createdAt;
      trip.items[idx] = it;
    } else {
      it.createdAt = new Date().toISOString();
      trip.items.push(it);
    }
    save(ui.editingId ? 'Item updated' : 'Item added');
    closeOverlays();
    ui.flashId = it.id;
    render();
  }

  // ---------- shifting ----------
  function openShiftModal(target) {
    // target: item id, or null for whole trip
    ui.shiftTarget = target;
    $('#shiftTitle').textContent = target ? 'Shift item dates' : 'Shift entire trip';
    $('#shiftScopeField').style.display = target ? '' : 'none';
    $('#shiftDays').value = 1;
    openOverlay('#shiftOverlay');
    $('#shiftDays').focus();
  }

  function submitShiftForm(e) {
    e.preventDefault();
    const days = parseInt($('#shiftDays').value, 10);
    if (!days || isNaN(days)) { closeOverlays(); return; }
    const trip = activeTrip();
    let targets;
    if (!ui.shiftTarget) {
      targets = trip.items;
    } else {
      const scope = document.querySelector('input[name="shiftScope"]:checked').value;
      const anchor = trip.items.find(x => x.id === ui.shiftTarget);
      if (!anchor) { closeOverlays(); return; }
      if (scope === 'one') targets = [anchor];
      else if (scope === 'all') targets = trip.items;
      else {
        const key = sortKey(anchor);
        targets = trip.items.filter(x => sortKey(x) >= key);
      }
    }
    let moved = 0;
    for (const it of targets) {
      if (isIsoDate(it.startDate)) { it.startDate = addDays(it.startDate, days); moved++; }
      if (isIsoDate(it.endDate)) it.endDate = addDays(it.endDate, days);
    }
    save(`Shifted ${moved} item${moved === 1 ? '' : 's'} by ${days > 0 ? '+' : ''}${days} day${Math.abs(days) === 1 ? '' : 's'}`);
    closeOverlays();
    if (ui.shiftTarget) ui.flashId = ui.shiftTarget;
    render();
  }

  // ---------- trips ----------
  // Quiet completion on the trip name: the destinations that have an example
  // itinerary, offered as a datalist, with one line confirming the match. It
  // never blocks or corrects what the traveller typed.
  function syncTripNameHint() {
    const el = $('#tripNameHint');
    const opt = sampleTripOptions().find(o => o.id === matchSampleTrip($('#inTripName').value));
    el.hidden = !opt;
    if (opt) el.textContent = `We have an example ${opt.label} itinerary you can load into this trip.`;
  }

  function openTripModal(mode) {
    ui.tripModalMode = mode;
    const t = activeTrip();
    $('#tripModalTitle').textContent = mode === 'new' ? 'New trip' : 'Trip settings';
    $('#tripSaveBtn').textContent = mode === 'new' ? 'Create trip' : 'Save';
    $('#tripNameList').innerHTML = sampleTripOptions().map(o => `<option value="${esc(o.place)}">`).join('');
    $('#inTripName').value = mode === 'rename' && t ? t.name : '';
    syncTripNameHint();
    $('#inTripCurrency').value = mode === 'rename' && t ? (t.currency || 'USD') : 'USD';
    $('#inTripBudget').value = mode === 'rename' && t && t.budget != null ? t.budget : '';
    $('#fTripName').classList.remove('invalid');
    openOverlay('#tripOverlay');
    $('#inTripName').focus();
  }

  function submitTripForm(e) {
    e.preventDefault();
    const name = $('#inTripName').value.trim();
    if (!name) { $('#fTripName').classList.add('invalid'); return; }
    const currency = $('#inTripCurrency').value;
    const rawBudget = $('#inTripBudget').value.trim();
    const budget = parseMoney(rawBudget).value;
    // parseMoney stopped rejecting negatives when refunds became legal, and
    // #tripForm's native min="0" is the only thing that was refusing a negative
    // budget. A budget is a ceiling, not a transaction, so it is checked here.
    if (budget != null && budget < 0) { $('#fTripBudget').classList.add('invalid'); return; }
    if (ui.tripModalMode === 'new') {
      const t = { id: uid(), name, currency, budget, items: [] };
      db.trips.push(t);
      db.activeTripId = t.id;
      // A brand-new trip has nothing to show on the map or the day grid, so
      // land on Timeline (and its empty state) instead of an empty map. The
      // render below repaints the view and syncViewHash clears the fragment.
      ui.view = 'timeline';
    } else {
      const t = activeTrip();
      if ((t.currency || 'USD') !== currency) stampCostCurrencies(t, t.currency || 'USD');
      t.name = name; t.currency = currency; t.budget = budget;
    }
    save(ui.tripModalMode === 'new' ? `Trip "${name}" created` : 'Trip updated');
    closeOverlays();
    render();
  }

  function duplicateTrip() {
    const t = activeTrip();
    const copy = JSON.parse(JSON.stringify(t));
    copy.id = uid();
    copy.name = `${t.name} (copy)`;
    copy.items.forEach(it => { it.id = uid(); });
    db.trips.push(copy);
    db.activeTripId = copy.id;
    save('Trip duplicated'); render();
  }

  function confirmDialog(title, text, yesLabel, action) {
    $('#confirmTitle').textContent = title;
    $('#confirmText').textContent = text;
    $('#confirmYes').textContent = yesLabel;
    ui.confirmAction = action;
    openOverlay('#confirmOverlay');
  }

  // ---------- import / export ----------
  function download(filename, text, mime) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: mime || 'application/json' }));
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }
  const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'trip';

  function exportTrip() {
    const t = activeTrip();
    download(`${slug(t.name)}.json`, JSON.stringify({ version: 1, trip: t }, null, 2));
  }
  function exportIcs() {
    const t = activeTrip();
    download(`${slug(t.name)}.ics`, buildIcs(t), 'text/calendar');
  }
  function exportAll() {
    download('trip-planner-backup.json', JSON.stringify(db, null, 2));
  }
  function exportCsv() {
    const t = activeTrip();
    // the row builder is pure and lives in trip-logic so the "a spreadsheet SUM
    // over the cost column equals the app's total" property has a test
    download(`${slug(t.name)}.csv`, buildCsv(t, t.currency || 'USD', activeRates(t)), 'text/csv');
  }

  function importJson(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        const incoming = [];
        if (data && Array.isArray(data.trips)) incoming.push(...data.trips);
        else if (data && data.trip && Array.isArray(data.trip.items)) incoming.push(data.trip);
        else if (data && Array.isArray(data.items)) incoming.push(data);
        else throw new Error('Unrecognized format');
        let added = 0;
        const drops = [];
        for (const t of incoming) {
          if (!t || !Array.isArray(t.items)) continue;
          const nt = buildImportedTrip(t, drops);
          db.trips.push(nt);
          db.activeTripId = nt.id;
          added++;
        }
        if (!added) throw new Error('No trips found in the file');
        const stored = save(); render();
        if (stored) reportImportDrops(`Imported ${added} trip${added === 1 ? '' : 's'}`, drops);
      } catch (err) {
        toast(`Import failed: ${err.message}`);
      }
    };
    reader.readAsText(file);
  }

  // shared sanitizer for both file import and share-link import: a fresh id,
  // clamped strings, and the visaExtras/budget/currency shape the app expects.
  // `drops` collects everything the file asked for that this refused, so the
  // traveller is told rather than handed a quietly different trip.
  function buildImportedTrip(t, drops) {
    const notes = drops || [];
    const budget = parseMoney(t.budget);
    if (!budget.ok) notes.push(`Trip budget ${budget.reason}, so it was left unset.`);
    const nt = {
      id: uid(),
      name: String(t.name || 'Imported trip').slice(0, 60),
      currency: /^[A-Z]{3}$/.test(t.currency || '') ? t.currency : 'USD',
      budget: budget.value,
      visaExtras: (Array.isArray(t.visaExtras) ? t.visaExtras : []).filter(c => typeof c === 'string' && /^[A-Z]{2}$/.test(c)),
      items: t.items.map(raw => sanitizeItem(raw, notes)).filter(Boolean),
    };
    stampCostCurrencies(nt, nt.currency);
    return nt;
  }

  // An import that quietly rewrites money and dates hands back a different trip
  // than the file described. One toast per drop would bury the screen, so the
  // first few are spelled out and the rest counted.
  function reportImportDrops(headline, drops) {
    if (!drops.length) { toast(headline); return; }
    const shown = drops.slice(0, 2).join(' ');
    const rest = drops.length > 2 ? ` (+${drops.length - 2} more)` : '';
    toast(`${headline}. ${shown}${rest}`);
  }

  function sanitizeItem(raw, drops) {
    if (!raw || typeof raw !== 'object') return null;
    const notes = drops || [];
    const label = String((raw && raw.title) || '(untitled)').slice(0, 60);
    const cost = parseMoney(raw.cost);
    if (!cost.ok) notes.push(`"${label}": the cost ${cost.reason}, so no price was imported.`);
    const est = parseMoney(raw.estCost);
    if (!est.ok) notes.push(`"${label}": the estimated cost ${est.reason}, so it was dropped.`);
    for (const [field, val] of [['start date', raw.startDate], ['end date', raw.endDate]]) {
      if (val != null && val !== '' && !isIsoDate(val)) notes.push(`"${label}": the ${field} "${String(val).slice(0, 20)}" is not a real date, so it was cleared.`);
    }
    const out = {
      id: uid(),
      type: TYPE_META[raw.type] ? raw.type : 'note',
      title: String(raw.title || '').slice(0, 120),
      location: String(raw.location || '').slice(0, 80),
      startDate: isIsoDate(raw.startDate) ? raw.startDate : '',
      endDate: isIsoDate(raw.endDate) ? raw.endDate : '',
      startTime: /^\d{2}:\d{2}$/.test(raw.startTime || '') ? raw.startTime : '',
      endTime: /^\d{2}:\d{2}$/.test(raw.endTime || '') ? raw.endTime : '',
      status: STATUS_META[raw.status] ? raw.status : 'to-book',
      cost: cost.value,
      costNote: String(raw.costNote || '').slice(0, 80),
      details: String(raw.details || '').slice(0, 500),
      createdAt: new Date().toISOString(),
    };
    if (/^[A-Z]{3}$/.test(raw.costCurrency || '')) out.costCurrency = raw.costCurrency;
    else if (out.cost != null) out.costCurrency = undefined; // stamped by the caller with the trip currency
    // an imported or shared itinerary keeps its suggested prices, still uncounted
    if (est.value != null) {
      out.estCost = est.value;
      if (/^[A-Z]{3}$/.test(raw.estCostCurrency || '')) out.estCostCurrency = raw.estCostCurrency;
    }
    // a shared/imported venue must keep its verified place, or the receiving
    // end silently loses its Maps link and star rating
    if (raw.mapsQuery != null && String(raw.mapsQuery).trim()) out.mapsQuery = String(raw.mapsQuery).slice(0, 200).trim();
    return out;
  }

  // ---------- share link ----------
  const SHARE_PREFIX = '#share=';

  function shareBaseUrl() {
    const host = location.hostname;
    const local = host === 'localhost' || host === '127.0.0.1' || host === '' || host.endsWith('.local');
    return local ? location.href.split('#')[0] : 'https://shevato.com/apps/trip-planner/';
  }

  async function streamThrough(Ctor, bytes) {
    const s = new Ctor('deflate');
    const writer = s.writable.getWriter();
    writer.write(bytes);
    writer.close();
    const ab = await new Response(s.readable).arrayBuffer();
    return new Uint8Array(ab);
  }

  async function shareTrip() {
    if (typeof CompressionStream === 'undefined') { toast('Sharing is not supported in this browser'); return; }
    const t = activeTrip();
    const json = JSON.stringify({ version: 1, trip: slimTripForShare(t) });
    const compressed = await streamThrough(CompressionStream, new TextEncoder().encode(json));
    const url = shareBaseUrl() + SHARE_PREFIX + bytesToBase64url(compressed);
    // The fragment never travels to a server, so browsers handle very long
    // links fine; the real-world limit is chat apps truncating them. Hard
    // stop only at absurd sizes, advisory warning in between.
    if (url.length > 30000) { toast('This trip is too large to share by link. Use Export trip (JSON) instead.'); return; }
    try {
      await navigator.clipboard.writeText(url);
      toast(url.length > 8000
        ? 'Share link copied. It carries your item details, including anything you wrote in Details such as confirmation numbers. It is also a LONG link: if a chat app truncates it, send the Export trip (JSON) file instead.'
        : 'Share link copied. It carries your item details, including anything you wrote in Details such as confirmation numbers. Anyone with the link can read them.');
    } catch {
      window.prompt('Copy this share link:', url);
    }
  }

  async function decodeShare(hash) {
    if (typeof DecompressionStream === 'undefined') { toast('Sharing is not supported in this browser'); return null; }
    try {
      const bytes = base64urlToBytes(hash.slice(SHARE_PREFIX.length));
      const out = await streamThrough(DecompressionStream, bytes);
      const parsed = JSON.parse(new TextDecoder().decode(out));
      const trip = parsed && parsed.trip;
      if (!trip || !Array.isArray(trip.items)) throw new Error('bad payload');
      return trip;
    } catch { toast('This share link could not be opened'); return null; }
  }

  async function enterSharedMode() {
    const trip = await decodeShare(location.hash);
    if (!trip) {
      history.replaceState(null, '', location.pathname + location.search);
      ensureTrip();
      if (lastSaved === null) markSaved();
      render();
      return;
    }
    realDb = db;
    sharedMode = true;
    const drops = [];
    const st = buildImportedTrip(trip, drops);
    sharedTrip = st;
    db = { version: 1, activeTripId: st.id, trips: [st] };
    document.body.classList.add('tp-shared');
    render();
    showSharedBanner(st);
    // a share link is untrusted JSON too, so it reports its drops the same way
    if (drops.length) reportImportDrops('This shared trip lost some values', drops);
  }

  function showSharedBanner(trip) {
    let b = $('#sharedBanner');
    if (!b) {
      b = document.createElement('div');
      b.id = 'sharedBanner';
      b.className = 'shared-banner';
      const wrap = document.querySelector('.tp-wrap');
      wrap.insertBefore(b, wrap.firstChild);
    }
    b.innerHTML = `
      <span class="sb-text">👀 You're viewing a shared copy of "${esc(trip.name)}"</span>
      <span class="sb-actions">
        <button type="button" class="btn primary" id="sharedImport">Import as my trip</button>
        <button type="button" class="btn" id="sharedDismiss">Dismiss</button>
      </span>`;
    $('#sharedImport').addEventListener('click', importSharedTrip);
    $('#sharedDismiss').addEventListener('click', dismissShared);
  }

  function importSharedTrip() {
    const nt = buildImportedTrip(sharedTrip);
    db = realDb;
    realDb = null;
    sharedMode = false;
    if (lastSaved === null) markSaved();
    db.trips.push(nt);
    db.activeTripId = nt.id;
    save(`Imported "${nt.name}"`);
    history.replaceState(null, '', location.pathname + location.search);
    document.body.classList.remove('tp-shared');
    const b = $('#sharedBanner');
    if (b) b.remove();
    render();
  }

  function dismissShared() {
    history.replaceState(null, '', location.pathname + location.search);
    location.reload();
  }

  // ---------- sample ----------
  // The trip keeps its own name: the traveller chose it, and it is usually the
  // reason this destination was picked in the first place.
  function loadSample(id) {
    const t = activeTrip();
    const sample = buildSampleTrip(id || matchSampleTrip(t.name), {
      today: todayIso(), currency: t.currency || 'USD', createdAt: new Date().toISOString(),
    });
    if (!sample) return;
    t.items = sample.items;
    save(`${sample.label} example loaded, replace it with your own plan`); render();
  }

  // ---------- geocoding (OpenStreetMap Nominatim, cached, 1 req/sec) ----------
  // Resolves { ok:true, lat, lon, name, cc, country, conf } on a hit,
  // { ok:false, reason:'notfound'|'network'|'empty' } otherwise. Hits are
  // cached in localStorage; not-found only for this session (typos get a
  // second chance next visit); network errors are never cached.
  // v3: entries gained `conf` (the match confidence classifyGeoMatch recorded).
  // The visa dialog refuses to name a country without it, so a v2 entry written
  // before that field existed would silently empty a returning traveller's visa
  // list. Bumping the key re-fetches once instead; this is a pure network cache
  // and holds no user data.
  const GEO_KEY = 'trip-planner:geo:v3';
  let geoCache = {};
  try { geoCache = JSON.parse(localStorage.getItem(GEO_KEY) || '{}') || {}; } catch { geoCache = {}; }
  for (const old of ['trip-planner:geo:v1', 'trip-planner:geo:v2']) {
    try { localStorage.removeItem(old); } catch { /* old cache format */ }
  }
  const geoMisses = new Set();
  const geoQueue = [];
  let geoBusy = false;

  function geocode(place) {
    return new Promise(resolve => {
      const key = String(place || '').trim().toLowerCase();
      if (!key) return resolve({ ok: false, reason: 'empty' });
      if (geoCache[key]) return resolve({ ok: true, ...geoCache[key] });
      if (geoMisses.has(key)) return resolve({ ok: false, reason: 'notfound' });
      geoQueue.push({ place: place.trim(), key, resolve });
      pumpGeo();
    });
  }
  function pumpGeo() {
    if (geoBusy || !geoQueue.length) return;
    geoBusy = true;
    const job = geoQueue.shift();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 9000);
    // limit=5 costs no extra request, only a slightly bigger response, and it
    // is the only way to tell "one obvious answer" from "one of thirty".
    fetch('https://nominatim.openstreetmap.org/search?format=json&limit=5&addressdetails=1&accept-language=en&q=' + encodeURIComponent(job.place), { signal: ctrl.signal })
      .then(r => { if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
      .then(res => {
        const rows = Array.isArray(res) ? res : [];
        const row = rows[0];
        if (row) {
          const cands = rows.map(r => ({
            name: String(r.display_name || '').split(',')[0],
            cc: (r.address && r.address.country_code) ? r.address.country_code.toUpperCase() : '',
            country: (r.address && r.address.country) || '',
            state: (r.address && (r.address.state || r.address.province || r.address.region)) || '',
            importance: Number(r.importance),
            kind: r.addresstype || r.type || r.class || '',
          }));
          const hit = {
            lat: Number(row.lat), lon: Number(row.lon),
            name: String(row.display_name || job.place).split(',')[0],
            cc: (row.address && row.address.country_code) ? row.address.country_code.toUpperCase() : '',
            country: (row.address && row.address.country) || '',
            conf: classifyGeoMatch(job.place, cands),
          };
          geoCache[job.key] = hit;
          try { localStorage.setItem(GEO_KEY, JSON.stringify(geoCache)); } catch { /* cache is best-effort */ }
          job.resolve({ ok: true, ...hit });
        } else {
          geoMisses.add(job.key);
          job.resolve({ ok: false, reason: 'notfound' });
        }
      })
      .catch(() => job.resolve({ ok: false, reason: 'network' }))
      .finally(() => { clearTimeout(timer); setTimeout(() => { geoBusy = false; pumpGeo(); }, 1100); });
  }

  // ---------- route helper modal ----------
  let routeToken = 0;
  let routeDate = '';
  // The pair the current result belongs to. While the inputs still match
  // it there is nothing new to check, so the Check button grays out;
  // editing either place (or swapping) re-arms it.
  let lastRouteKey = '';
  const routeKeyNow = () => ($('#routeFrom').value.trim() + '|' + $('#routeTo').value.trim()).toLowerCase();
  function syncRouteCheckBtn() {
    const from = $('#routeFrom').value.trim(), to = $('#routeTo').value.trim();
    const btn = $('#routeCheckBtn');
    const alreadyShown = !!lastRouteKey && routeKeyNow() === lastRouteKey;
    btn.disabled = !from || !to || alreadyShown;
    btn.title = alreadyShown ? 'This route is already shown. Change a place to check a different one.'
      : (!from || !to ? 'Enter both places first.' : '');
  }

  const ROUTE_BLANK = '<div class="m-empty"><span class="me-ico" aria-hidden="true">🧭</span>'
    + '<span class="me-title">Compare the ways to get there</span>'
    + '<span>Enter two places and hit "Check route" for times, rough costs and CO2 side by side.</span></div>';

  function openRouteModal(from, to, date) {
    routeDate = date || '';
    lastRouteKey = '';
    // suggest places already used in this trip
    const locs = [...new Set(activeTrip().items.map(it => (it.location || '').trim()).filter(Boolean))];
    $('#placeList').innerHTML = locs.map(l => `<option value="${esc(l)}">`).join('');
    $('#routeFrom').value = from || '';
    $('#routeTo').value = to || '';
    setRouteResult(ROUTE_BLANK);
    updateRouteLinks();
    openOverlay('#routeOverlay');
    if (from && to) checkRoute();
    else $('#routeFrom').focus();
  }

  function setRouteResult(html, isErr) {
    const box = $('#routeResult');
    box.innerHTML = html;
    box.classList.toggle('err', !!isErr);
  }

  // The link set the modal is currently showing. It starts generic (both
  // places typed, no country known yet) and gets the national rail operator
  // and the ferry site once a check has geocoded the pair.
  let routeCtx = {};
  function updateRouteLinks(extra) {
    const from = $('#routeFrom').value.trim(), to = $('#routeTo').value.trim();
    routeCtx = Object.assign({ from, to, date: routeDate }, extra || {});
    const links = routeLinks(routeCtx);
    const box = $('#routeLinks');
    box.innerHTML = links.map(l =>
      `<a class="btn rl-btn${l.official ? ' is-official' : ''}${l.discovery ? ' is-discovery' : ''}" href="${esc(l.url)}" target="_blank" rel="noopener"><span aria-hidden="true">${l.i}</span>${esc(l.label)}</a>`
    ).join('');
    // nothing to link to until both places are typed: an empty row would read
    // as broken, so say what is missing instead
    const hint = $('#routeLinksHint');
    hint.hidden = !links.length;
    hint.textContent = (links.some(l => l.official) ? 'Official operators first. ' : '')
      + 'Rome2Rio is a discovery tool: good for spotting which operators run a route, not a source for fares.';
    if (!links.length) box.innerHTML = '<div class="m-empty"><span class="me-ico" aria-hidden="true">🔗</span><span class="me-title">Booking sites appear here</span><span>Enter both places and the links open pre-filled with them.</span></div>';
    syncRouteCheckBtn();
  }

  function badgeHtml(list) {
    return (list || []).map(b => `<span class="mc-badge is-${b.id}" title="${esc(b.title)}">${esc(b.label)}</span>`).join('');
  }

  function costHtml(cost) {
    if (!cost) return '';
    const range = cost.lo === cost.hi ? `$${cost.lo}` : `$${cost.lo}-${cost.hi}`;
    return `<span class="mc-fig mc-cost" title="Rough estimate from the distance, not a fare">${range}<small>est. per ${cost.per}</small></span>`;
  }

  function modeCardHtml(m, badges, links) {
    const act = modeLink(m.key, links);
    const co2 = m.co2 ? `<span class="mc-fig mc-co2" title="Estimated from the distance using published per-km emission factors">${m.co2.kg} kg CO2<small>per ${m.co2.per}</small></span>` : '';
    return `<article class="mode-card">
      <span class="mc-ico" aria-hidden="true">${m.i}</span>
      <div class="mc-main">
        <div class="mc-top"><h4>${esc(m.name)}</h4>${badgeHtml(badges)}</div>
        <div class="mc-figs">
          <span class="mc-fig mc-dur">${esc(m.dur)}</span>
          ${costHtml(m.cost)}${co2}
        </div>
        <p class="mc-note">${esc(m.note)}</p>
      </div>
      ${act ? `<a class="btn mc-act" href="${esc(act.url)}" target="_blank" rel="noopener" aria-label="${esc(`${act.label} for ${m.name} on ${act.site}`)}">${esc(act.label)}</a>` : ''}
    </article>`;
  }

  async function checkRoute() {
    const from = $('#routeFrom').value.trim(), to = $('#routeTo').value.trim();
    updateRouteLinks();
    if (!from || !to) { setRouteResult('Enter both places first.'); return; }
    if (from.toLowerCase() === to.toLowerCase()) {
      setRouteResult('Those are the same place. Pick two different spots.', true);
      lastRouteKey = routeKeyNow();
      syncRouteCheckBtn();
      return;
    }
    // offline: leave the button armed so a retry after reconnecting works
    if (!navigator.onLine) { setRouteResult('You look offline: place lookup needs internet. The link buttons will still work once you reconnect.', true); return; }

    const token = ++routeToken;
    setRouteResult('<div class="route-loading"><span class="spinner"></span>Locating places (free lookup, about a second each)...</div>');
    const [a, b] = await Promise.all([geocode(from), geocode(to)]);
    if (token !== routeToken) return; // a newer check superseded this one

    if (!a.ok || !b.ok) {
      if (a.reason === 'network' || b.reason === 'network') {
        // transient: keep the button armed for a retry
        setRouteResult('The place lookup service did not answer (network hiccup or rate limit). Try again in a few seconds, or just use the link buttons below: they work without the lookup.', true);
        return;
      }
      const missing = [!a.ok && from, !b.ok && to].filter(Boolean).map(esc).join('" and "');
      setRouteResult(`"<b>${missing}</b>": ${esc(GEO_MATCH_TEXT.failed)} The link buttons below still work with whatever you typed.`, true);
      lastRouteKey = routeKeyNow();
      syncRouteCheckBtn();
      return;
    }

    const km = distKm(a, b);
    const mi = km * 0.621371;
    const island = ISLANDISH.test(from) || ISLANDISH.test(to);
    const intl = !!(a.cc && b.cc && a.cc !== b.cc);
    updateRouteLinks({ fromCc: a.cc, toCc: b.cc, island, km });
    const pills = [
      `<span class="rp">📏 ${Math.round(km).toLocaleString()} km / ${Math.round(mi).toLocaleString()} mi</span>`,
      `<span class="rp">🧭 heading ${compass(a, b)}</span>`,
      intl ? `<span class="rp intl">🛂 international: ${esc(a.country)} → ${esc(b.country)}</span>` : '',
      routeDate ? `<span class="rp">📅 travel day: ${fmtDate(routeDate)}</span>` : '',
    ].filter(Boolean).join('');
    const fastRail = hasFastRail(a.cc) && hasFastRail(b.cc);
    const opts = modeOptions(km, island, fastRail);
    const badges = routeBadges(opts, { island });
    const links = routeLinks(routeCtx);
    const cards = opts.map(m => modeCardHtml(m, badges[m.key], links)).join('');
    // Structural facts and tips only exist for routes we actually know
    // something about. An unknown route simply has no such block: an absent
    // fact is fine, an invented one is not.
    const factCtx = { fromText: `${from} ${a.name}`, toText: `${to} ${b.name}`, island, international: intl, km };
    const flags = routeFlags(factCtx);
    const tips = routeTips(factCtx);
    const matchNote = geoMatchNote([a.conf, b.conf]);
    const matchLevel = matchNote
      ? [a.conf, b.conf].reduce((x, y) => (GEO_MATCH_RANK[y] > GEO_MATCH_RANK[x] ? y : x)) : '';
    const known = flags.length || tips.length
      ? `<div class="route-know">
          ${flags.length ? `<ul class="route-flags">${flags.map(f => `<li><span aria-hidden="true">${f.i}</span>${esc(f.text)}</li>`).join('')}</ul>` : ''}
          ${tips.map(t => `<p class="route-tip"><span aria-hidden="true">💡</span>${esc(t.text)}</p>`).join('')}
        </div>`
      : '';
    setRouteResult(`
      <div class="route-head">
        <span>${flagEmoji(a.cc)} ${esc(a.name)}</span><span class="arrow">→</span>
        <span>${flagEmoji(b.cc)} ${esc(b.name)}</span>
        ${matchNote ? `<small class="rh-note is-${matchLevel}">${esc(matchNote)}</small>` : ''}
      </div>
      <div class="route-pills">${pills}</div>
      <div class="mode-cards">${cards}</div>
      ${known}
      <div class="route-note">${esc(ROUTE_HONESTY)}</div>`);
    lastRouteKey = routeKeyNow();
    syncRouteCheckBtn();
  }

  // ---------- map ----------
  let leafletPromise = null;
  let mapInstance = null;

  // SELF-HOSTED (2026-07-20), previously unpkg with no integrity attribute.
  // SRI alone would have fixed tampering but not the other two problems: unpkg
  // publishes no terms and no SLA, so a third party could take the Map view
  // down, and every map open leaked the visitor's IP and referer to them. A
  // vendored copy also lets the service worker precache it, so the map keeps
  // working on a flaky connection. Leaflet is BSD-2-Clause; vendor/leaflet/
  // carries the licence and the dist files verbatim (1.9.4), matching how the
  // repo already vendors jQuery under assets/js/.
  function ensureLeaflet() {
    if (window.L) return Promise.resolve(true);
    if (!leafletPromise) {
      leafletPromise = new Promise(resolve => {
        const css = document.createElement('link');
        css.rel = 'stylesheet';
        css.href = 'vendor/leaflet/leaflet.css';
        document.head.appendChild(css);
        const s = document.createElement('script');
        s.src = 'vendor/leaflet/leaflet.js';
        s.onload = () => resolve(true);
        s.onerror = () => { leafletPromise = null; resolve(false); };
        document.head.appendChild(s);
      });
    }
    return leafletPromise;
  }

  function mapStops(trip) {
    const stops = [];
    for (const it of sortedItems(trip)) {
      if (it.status === 'cancelled') continue;
      const loc = (it.location || '').trim();
      if (!loc || !isIsoDate(it.startDate)) continue;
      const last = stops[stops.length - 1];
      if (last && last.key === loc.toLowerCase()) { last.items.push(it); continue; }
      stops.push({ key: loc.toLowerCase(), name: loc, items: [it] });
    }
    return stops;
  }

  let mapRunToken = 0;
  // The map canvas is a fixed 540px box, and the free geocoder is rate-limited
  // to about one stop a second: a 12-stop trip therefore spent ~13 seconds
  // showing a large empty slab under a progress line, and every dead end (no
  // stops, offline, Leaflet blocked) left that slab sitting under the message.
  // These two helpers own the box's state: a skeleton with a progress bar while
  // it works, and no box at all when there is nothing to draw.
  function setMapState(state, pct) {
    const box = $('#mapBox');
    box.classList.toggle('is-loading', state === 'loading');
    box.classList.toggle('is-blank', state === 'blank');
    box.style.setProperty('--map-progress', typeof pct === 'number' ? Math.round(pct) + '%' : '0%');
  }
  function mapFailed(msg) {
    $('#mapStatus').textContent = msg;
    setMapState('blank');
  }

  async function renderMap() {
    const status = $('#mapStatus');
    const token = ++mapRunToken;
    const trip = activeTrip();
    const stops = mapStops(trip);
    if (!stops.length) {
      if (mapInstance) { mapInstance.remove(); mapInstance = null; }
      mapFailed('Add items with a "Place" (Tokyo, Kyoto, ...) and they will show up here as a route.');
      return;
    }
    if (!navigator.onLine) { mapFailed('The map needs an internet connection (tiles + place lookup).'); return; }
    setMapState('loading', 0);
    status.textContent = 'Loading map...';
    const ok = await ensureLeaflet();
    if (!ok) { mapFailed('Could not load the map library (offline?). The timeline is unaffected.'); return; }
    if (token !== mapRunToken) return;

    const located = [], failed = [];
    for (let i = 0; i < stops.length; i++) {
      setMapState('loading', (i / stops.length) * 100);
      status.textContent = `Locating places: ${i + 1} of ${stops.length} ("${stops[i].name}")...`;
      const hit = await geocode(stops[i].name);
      if (token !== mapRunToken) return;
      if (hit.ok) located.push({ ...stops[i], ...hit });
      else failed.push(stops[i].name);
    }
    if (!located.length) { mapFailed(`Could not locate: ${failed.join(', ')}. Try more specific place names (add the country).`); return; }
    setMapState('ready');

    if (mapInstance) { mapInstance.remove(); mapInstance = null; }
    mapInstance = L.map('mapCanvas', { scrollWheelZoom: true });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(mapInstance);

    const latlngs = [];
    located.forEach((stop, i) => {
      const ll = [stop.lat, stop.lon];
      latlngs.push(ll);
      const icon = L.divIcon({ className: '', html: `<div class="stop-pin">${i + 1}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] });
      const lines = stop.items.slice(0, 5).map(it => {
        const range = isStay(it) && isIsoDate(it.endDate) ? fmtRange(it.startDate, it.endDate) : fmtDate(it.startDate);
        return `${TYPE_META[it.type].icon} ${esc(it.title)}<br><small style="color:var(--text-dim)">${range}</small>`;
      }).join('<hr style="border:none;border-top:1px solid var(--border-soft);margin:6px 0">');
      L.marker(ll, { icon }).addTo(mapInstance).bindPopup(`<b>${i + 1}. ${esc(stop.name)}</b><br>${lines}`);
    });
    if (latlngs.length > 1) {
      L.polyline(latlngs, { color: '#4f8cff', weight: 3, opacity: 0.8, dashArray: '6 8' }).addTo(mapInstance);
    }
    mapInstance.fitBounds(L.latLngBounds(latlngs), { padding: [46, 46] });
    status.textContent = `${located.length} stop${located.length === 1 ? '' : 's'} on the route` +
      (failed.length ? ` · could not locate: ${failed.join(', ')} (use a more specific place name)` : '') + '.';
  }

  // ---------- visa requirements ----------
  const VISA_KEY = 'trip-planner:visa:v1';
  const PASSPORT_KEY = 'trip-planner:passport';
  // Repointed 2026-07-20. The previous source (ilyankou/passport-index-dataset)
  // declares itself archived and last updated 12 January 2025, and points here
  // for February 2026 onward. VERIFIED before switching: identical 199x200
  // shape, identical header row, and an identical value vocabulary ('visa
  // free', 'visa on arrival', 'e-visa', 'eta', 'visa required', 'no admission',
  // '-1'), so classifyVisa and parseVisaMatrix are unaffected. 2,935 of 39,601
  // cells differ between the two, i.e. we were serving stale entry rules for
  // about one passport/destination pair in thirteen.
  const VISA_URL = 'https://raw.githubusercontent.com/imorte/passport-index-data/main/passport-index-matrix-iso2.csv';
  // The date the DATASET says it was last updated (its README), not the date we
  // downloaded it. Update this whenever VISA_URL is re-pinned.
  const VISA_DATA_VINTAGE = '2026-02-17';
  const VISA_TTL = 30 * 86400000; // refresh the cached dataset monthly
  let visaMatrix = null;
  let visaDests = [];      // [{cc, name, places:[...]}] in visit order, CONFIDENT matches only
  let visaUnlocated = [];  // the geocoder found nothing at all
  let visaUnconfirmed = []; // found something, but not confidently enough to name a country
  let visaToken = 0;
  let passportGuess = null;  // { cc, origin } while the dropdown shows a guess

  function regionName(cc) {
    try { return new Intl.DisplayNames(['en'], { type: 'region' }).of(cc) || cc; }
    catch { return cc; }
  }

  async function ensureVisaMatrix() {
    if (visaMatrix) return visaMatrix;
    try {
      const cached = JSON.parse(localStorage.getItem(VISA_KEY) || 'null');
      if (cached && cached.csv && Date.now() - cached.at < VISA_TTL) {
        visaMatrix = parseVisaMatrix(cached.csv);
        if (visaMatrix) return visaMatrix;
      }
    } catch { /* fall through to a fresh fetch */ }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetch(VISA_URL, { signal: ctrl.signal });
      if (!res.ok) throw new Error('http ' + res.status);
      const csv = await res.text();
      visaMatrix = parseVisaMatrix(csv);
      if (!visaMatrix) throw new Error('unparseable dataset');
      try { localStorage.setItem(VISA_KEY, JSON.stringify({ at: Date.now(), csv })); } catch { /* cache is best-effort */ }
      return visaMatrix;
    } finally { clearTimeout(timer); }
  }

  async function openVisaModal() {
    const token = ++visaToken;
    openOverlay('#visaOverlay');
    const box = $('#visaResults');
    box.innerHTML = '<div class="route-loading"><span class="spinner"></span>Loading visa dataset...</div>';
    if (!navigator.onLine && !localStorage.getItem(VISA_KEY)) {
      box.innerHTML = 'The visa dataset needs internet for its first download. Reconnect and reopen this dialog.';
      return;
    }
    let matrix;
    try { matrix = await ensureVisaMatrix(); }
    catch {
      box.innerHTML = 'Could not load the visa dataset (network hiccup?). Close and reopen to retry, or search "visa requirements for <your country> citizens" on Wikipedia.';
      return;
    }
    if (token !== visaToken) return;

    // passport dropdown, once
    const sel = $('#passportSel');
    if (sel.options.length <= 1) {
      const opts = matrix.codes
        .map(cc => ({ cc, name: regionName(cc) }))
        .sort((a, b) => a.name.localeCompare(b.name))
        // name FIRST: the browser's native type-ahead ("uni" -> United...)
        // matches the start of the option text, so a leading flag emoji
        // would break typing in the dropdown
        .map(o => `<option value="${o.cc}">${esc(o.name)} \u00A0${flagEmoji(o.cc)}</option>`)
        .join('');
      sel.insertAdjacentHTML('beforeend', opts);
    }
    // An explicit choice always wins and is never overwritten by the guess.
    const saved = localStorage.getItem(PASSPORT_KEY) || '';
    const savedOk = !!(saved && matrix.matrix[saved]);
    if (savedOk) sel.value = saved;
    const addSel = $('#visaAddSel');
    if (addSel.options.length <= 1) {
      const opts = matrix.codes
        .map(cc => ({ cc, name: regionName(cc) }))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(o => `<option value="${o.cc}">${esc(o.name)} \u00A0${flagEmoji(o.cc)}</option>`)
        .join('');
      addSel.insertAdjacentHTML('beforeend', opts);
    }

    // Nothing chosen yet: assume the passport of the country they fly OUT of,
    // as a labelled assumption they can overrule. Resolved through the same
    // cached geocoder the destination list below uses, never a second one.
    // Recomputed on every open, and the dropdown is cleared first: anything
    // left in it from a previous open is a guess, and a guess without its
    // caveat beside it would read as a fact.
    // The dataset's own vintage, printed where the requirement is read.
    const vintageEl = $('#visaVintage');
    if (vintageEl) vintageEl.textContent = visaVintageNote(VISA_DATA_VINTAGE, todayIso());
    passportGuess = null;
    if (!savedOk) {
      sel.value = '';
      const origin = departureOrigin(activeTrip().items);
      if (origin) {
        box.innerHTML = '<div class="route-loading"><span class="spinner"></span>Locating your departure city...</div>';
        await geocode(origin);
        if (token !== visaToken) return;
      }
      const guess = suggestedPassport(activeTrip().items, geoCountry);
      if (guess && matrix.matrix[guess.cc]) { sel.value = guess.cc; passportGuess = guess; }
    }
    renderPassportGuess();

    // destination countries from the itinerary, in visit order
    const stops = mapStops(activeTrip());
    visaDests = [];
    visaUnlocated = [];
    visaUnconfirmed = [];
    if (stops.length) {
      box.innerHTML = '<div class="route-loading"><span class="spinner"></span>Locating your destinations...</div>';
      const byCc = new Map();
      const deferred = [];
      for (const stop of stops) {
        const hit = await geocode(stop.name);
        if (token !== visaToken) return;
        if (!hit.ok || !hit.cc) { visaUnlocated.push(stop.name); continue; }
        // The confidence the geocoder already recorded is the gate (see
        // visaCountryUsable). A contested or weak match must not name a country
        // here, and it must not attach its place name to somebody else's row
        // either: an unreliable country code is unreliable in both directions.
        // Held aside rather than warned about on the spot: whether this one is
        // worth mentioning depends on the countries the OTHER stops confirm,
        // and some of those have not been read yet (see visaUnconfirmedNames).
        if (!visaCountryUsable(hit.conf)) { deferred.push({ name: stop.name, cc: hit.cc }); continue; }
        if (!byCc.has(hit.cc)) byCc.set(hit.cc, { cc: hit.cc, name: regionName(hit.cc), places: [] });
        // mapStops collapses only ADJACENT repeats, because a city you come
        // back to is a real second stop on a ROUTE. This list is not a route:
        // "Tokyo, Nikko, Tokyo, Kyoto, Nara, Kyoto, Osaka, Kyoto" is one visa
        // rule read eight times. First mention wins, visit order kept.
        const places = byCc.get(hit.cc).places;
        if (!places.some(p => p.toLowerCase() === stop.name.toLowerCase())) places.push(stop.name);
      }
      visaDests = [...byCc.values()];
      visaUnconfirmed = visaUnconfirmedNames(deferred, byCc.keys());
    }
    renderVisaRows();
  }

  // Says out loud that the selected passport is an assumption and where it came
  // from. A guess presented as a fact is the one thing this dialog must not do,
  // so the line names the flight it was read off and offers the way out. Built
  // as label + value (see passportAssumptionParts) so no article is needed.
  function renderPassportGuess() {
    const el = $('#passportGuess');
    if (!passportGuess) { el.hidden = true; el.innerHTML = ''; return; }
    const parts = passportAssumptionParts(regionName(passportGuess.cc), passportGuess.origin);
    el.innerHTML = `${esc(parts.label)}: <b class="passport-guess-country">${esc(parts.value)}</b> `
      + `<span class="passport-guess-src">(${esc(parts.source)})</span> `
      + '<button type="button" class="passport-change">Change</button>';
    el.hidden = false;
  }

  // itinerary countries + manually added ones (layovers, land borders)
  function combinedVisaDests() {
    const auto = new Set(visaDests.map(d => d.cc));
    const extras = (activeTrip().visaExtras || [])
      .filter(cc => !auto.has(cc))
      .map(cc => ({ cc, name: regionName(cc), places: [], manual: true }));
    return [...visaDests, ...extras];
  }

  function renderVisaRows() {
    const box = $('#visaResults');
    const passport = $('#passportSel').value;
    const dests = combinedVisaDests();
    if (!dests.length && !visaUnlocated.length && !visaUnconfirmed.length) {
      box.innerHTML = 'Add items with a "Place" (Tokyo, Bangkok, ...) and the countries you visit will be listed here. You can also add a country manually below (layovers, road trips).';
      return;
    }
    if (!passport) {
      const found = dests.length
        ? `Found <b class="visa-count">${dests.length}</b> destination countr${dests.length === 1 ? 'y' : 'ies'} on this trip: ${dests.map(d => flagEmoji(d.cc) + ' ' + esc(d.name)).join(', ')}.`
        : 'No destination country could be confirmed from this trip yet.';
      // The caveat travels with the summary too, or the count reads as "these
      // are all the countries you visit" while a place sits unplaced.
      const gap = visaUnconfirmed.length
        ? `<br><br>${esc(visaUnconfirmed.join(', '))} ${visaUnconfirmed.length === 1 ? 'is' : 'are'} not included: we could not confirm which country ${visaUnconfirmed.length === 1 ? 'it is' : 'they are'} in.`
        : '';
      box.innerHTML = found + gap + '<br><br>Pick your passport above to see the requirement for each.';
      return;
    }
    const row = visaMatrix.matrix[passport] || {};
    const rows = dests.map(d => {
      const info = classifyVisa(row[d.cc]);
      const wiki = 'https://en.wikipedia.org/wiki/Special:Search?search=' + encodeURIComponent('Visa policy of ' + d.name);
      const sub = d.manual ? 'added manually · transit / overland' : d.places.join(', ');
      const remove = d.manual ? `<button type="button" class="visa-remove" data-remove-cc="${d.cc}" title="Remove ${esc(d.name)}" aria-label="Remove ${esc(d.name)}">✕</button>` : '';
      const remind = (info.cls === 'evisa' || info.cls === 'required')
        ? `<button type="button" class="row-btn visa-remind" data-remind-cc="${d.cc}" data-remind-name="${esc(d.name)}">➕ Add reminder</button>`
        : '';
      return `
        <div class="visa-row">
          <span class="visa-flag">${flagEmoji(d.cc)}</span>
          <span class="visa-name">${esc(d.name)}<small title="${esc(sub)}">${esc(sub)}</small></span>
          <span class="visa-pill vp-${info.cls}">${esc(info.label)}</span>
          <a class="visa-verify" href="${wiki}" target="_blank" rel="noopener">verify ↗</a>
          ${remind}
          ${remove}
        </div>`;
    }).join('');
    // TWO different failures, and they need different words. "Could not locate"
    // means the geocoder returned nothing. "Could not confirm the country"
    // means it returned something we do not trust enough to print a legal
    // requirement from, which is the case that used to silently become a
    // confident wrong row (Nara -> United States on a trip to Japan).
    const missing = visaUnlocated.length
      ? `<div class="visa-row"><span class="visa-flag">❓</span><span class="visa-name">Could not locate<small title="${esc(visaUnlocated.join(', '))}">${esc(visaUnlocated.join(', '))}</small></span><span class="visa-pill vp-unknown">Add the country to the place name</span></div>`
      : '';
    const unsure = visaUnconfirmed.length
      ? `<div class="visa-row"><span class="visa-flag">❓</span><span class="visa-name">Country not confirmed<small title="${esc(visaUnconfirmed.join(', '))}">${esc(visaUnconfirmed.join(', '))}</small></span><span class="visa-pill vp-unknown">More than one place has this name. Add the country.</span></div>`
      : '';
    box.innerHTML = rows + missing + unsure;
  }

  // ---------- AI assistant ----------
  const ASSIST_TIER_KEY = 'trip-planner:assist:tier';
  let assistTier = localStorage.getItem(ASSIST_TIER_KEY) || 'copy';
  if (!['copy', 'byok', 'site'].includes(assistTier)) assistTier = 'copy';
  let assistFocusDate = null;
  let assistPropSeq = 0;
  const assistActions = new Map(); // proposal id -> raw action, for re-validation on accept

  // `short` is the segment label; `note` is the one line that says where the
  // trip actually goes on this tier. That sentence is the whole point of the
  // chooser, so it stays visible for the selected tier - the sales copy that
  // used to sit beside it did not.
  // The note says where the trip GOES; the second sentence says what the
  // receiver may do with it, which is not the same question and differs per
  // tier. Deliberately NOT overclaimed on the owner's behalf: the site tier
  // runs on the owner's billed Gemini project, and paid-tier terms do not carry
  // the free tier's training and human-review clauses, so that one can be
  // stated. The other two land wherever the traveller's own key or chosen AI
  // takes them, which is very often a free tier that does train on input, and
  // this app cannot know, so it says so rather than reassuring.
  const TIER_META = {
    copy: { short: 'Copy & paste', note: 'Nothing leaves this device until you paste it into an AI yourself. Free, no account. Whatever you paste it into is then covered by that service\u2019s terms, which for a free chatbot usually allow it to be used for training and human review.' },
    byok: { short: 'My API key', note: 'Your trip goes straight from this browser to the provider you pick, on your key and your bill. What they may do with it depends on your own plan: free API tiers commonly allow training and human review, paid ones usually do not.' },
    site: { short: 'Free assistant', note: "Your trip goes to this site's server and on to Google Gemini on a shared key, with daily limits. That key is on a paid project, whose terms do not allow the input to be used for training or human review." },
  };

  function openAssist(focusDate) {
    const panel = $('#assistPanel');
    const trip = activeTrip();
    const id = trip ? trip.id : '';
    if (panel.dataset.tripId !== id) {
      panel.dataset.tripId = id;
      $('#assistMessages').innerHTML = '';
      assistActions.clear();
      assistFocusDate = null;
      setupCollapsed = false;
    }
    if (focusDate && isIsoDate(focusDate)) assistFocusDate = focusDate;
    if (assistFocusDate) panel.dataset.focusDate = assistFocusDate; else delete panel.dataset.focusDate;
    setAssistMinimized(false);
    panel.hidden = false;
    document.body.classList.add('assist-open');
    renderTierGroup();
    renderTierBody(assistTier);
    renderFocusChip();
    renderPlanner();
    setSetupCollapsed(setupCollapsed);
    $('#assistCloseBtn').focus();
  }

  function closeAssist() {
    setAssistMinimized(false);
    $('#assistPanel').hidden = true;
    document.body.classList.remove('assist-open');
  }

  // Minimize collapses the panel to a pill without unmounting anything, so the
  // chat log, the picker's control values and any pending proposal cards are
  // still exactly where they were when it comes back. Focus lands back on the
  // toggle itself (see its click handler), so nothing is trapped or lost.
  function setAssistMinimized(on) {
    const panel = $('#assistPanel');
    panel.classList.toggle('is-min', on);
    const btn = $('#assistMinBtn');
    btn.title = on ? 'Restore' : 'Minimize';
    btn.setAttribute('aria-label', on ? 'Restore assistant' : 'Minimize assistant');
    btn.setAttribute('aria-expanded', on ? 'false' : 'true');
  }

  // Once a request is on its way the conversation is the point, so the whole
  // setup block folds into one line the traveller can reopen with one tap. It
  // is only collapsed, never unmounted: every picker value and both tier
  // fields are exactly where they were.
  let setupCollapsed = false;
  function setSetupCollapsed(on) {
    setupCollapsed = !!on && assistTier !== 'copy';
    $('#assistSetup').hidden = setupCollapsed;
    renderSetupBar();
  }

  function renderSetupBar() {
    const bar = $('#assistSetupBar');
    if (!setupCollapsed) { bar.hidden = true; bar.innerHTML = ''; return; }
    const trip = activeTrip();
    const summary = planPrefs && planHasSlot(planPrefs) ? planSummaryText(trip, planPrefs) : 'Plan a day';
    bar.hidden = false;
    bar.innerHTML = `<span class="asb-txt">${esc(summary)}</span>
      <button type="button" class="asb-change" id="assistSetupChange">Change</button>`;
  }

  // Switching the active trip with the panel open must not show one trip's
  // proposals against another; clear the rendered log + focus (stored history
  // per trip is a Batch B concern, this only resets what's on screen).
  function syncAssistPanel() {
    const panel = $('#assistPanel');
    if (!panel || panel.hidden) return;
    const trip = activeTrip();
    const id = trip ? trip.id : '';
    if (panel.dataset.tripId !== id) {
      panel.dataset.tripId = id;
      $('#assistMessages').innerHTML = '';
      assistActions.clear();
      assistFocusDate = null;
      delete panel.dataset.focusDate;
      planMemory.clear(); // another trip's day prefs must not leak into this one
      renderFocusChip();
      renderPlanner();
      setSetupCollapsed(false);
      if (assistTier !== 'copy') restoreChat(); // load the new trip's chat
    }
  }

  // One segmented control plus one line: the line is the honest "where does my
  // trip go" answer for the selected tier and nothing else.
  function renderTierGroup() {
    const segs = ['copy', 'byok', 'site'].map(t => {
      const on = t === assistTier;
      return `<label class="tier-opt${on ? ' on' : ''}">
        <input type="radio" name="assistTier" value="${t}" ${on ? 'checked' : ''}>
        <span>${esc(TIER_META[t].short)}</span>
      </label>`;
    }).join('');
    $('#assistTierGroup').innerHTML = `<div class="tier-seg" role="radiogroup" aria-label="How to use the assistant">${segs}</div>
      <p class="tier-note">${esc(TIER_META[assistTier].note)}</p>`;
  }

  function setAssistTier(t) {
    const group = $('#assistTierGroup');
    const keepFocus = group.contains(document.activeElement);
    assistTier = t;
    localStorage.setItem(ASSIST_TIER_KEY, t);
    renderTierGroup();
    renderTierBody(t);
    renderPlanner(); // the primary action's label is per tier (send vs copy)
    // the group is repainted, so the radio that was just chosen has to be
    // handed the focus back rather than dropping it on <body>
    if (keepFocus) {
      const back = group.querySelector('input[name="assistTier"]:checked');
      if (back) back.focus({ preventScroll: true });
    }
  }

  // Per-tier body. Inactive tiers' fields never enter the DOM (rendered on
  // selection, not hidden). The copy tier (Tier 1) hides the chat composer and
  // uses its own paste flow; byok/site (Tiers 2/3) share the live chat.
  function renderTierBody(tier) {
    const body = $('#assistTierBody');
    const composer = $('#assistComposer');
    // on tier 1 the copy button has to come BEFORE the "paste it into an AI"
    // and "bring the reply back" moves it feeds, so the body is ordered after
    // the review block instead of before it
    $('#assistPanel').classList.toggle('tier-copy', tier === 'copy');
    if (tier === 'copy') {
      body.innerHTML = copyTierHtml();
      composer.hidden = true;
      // the paste box lives in this body, so tier 1 can never be collapsed away
      setSetupCollapsed(false);
      return;
    }
    body.innerHTML = tier === 'byok' ? byokTierHtml() : '';
    composer.hidden = false;
    syncSendState();
    autoGrowInput();
    restoreChat();
  }

  // ---------- Tier 2: bring your own key ----------
  // Model ids and CORS verified 2026-07-19: both providers echo the request
  // Origin on an OPTIONS preflight, so browser-to-provider calls work with no
  // proxy. Gemini rejects a bad key with HTTP 400 (API_KEY_INVALID), not 401,
  // so callByokProvider maps 400/401/403 to the invalid-key message.
  const PROVIDER_META = {
    openai: {
      label: 'OpenAI',
      keyLink: 'https://platform.openai.com/api-keys',
      models: [
        { id: 'gpt-4o-mini', label: 'GPT-4o mini' },
        { id: 'gpt-4o', label: 'GPT-4o' },
      ],
    },
    gemini: {
      label: 'Gemini',
      keyLink: 'https://aistudio.google.com/apikey',
      models: [
        // Keep in step with GEMINI_MODEL in netlify/functions/tp-assist.mjs:
        // Google refuses retired models for newly created keys, so an old pin
        // breaks Tier 2 for exactly the travellers who just made a key.
        // assistModel() falls back to models[0] when a saved id is gone, so
        // changing this id migrates a stale localStorage preference by itself.
        { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash' },
      ],
    },
  };
  const AI_KEY_PREFIX = 'trip-planner:aikey:';
  const AI_PROVIDER_KEY = 'trip-planner:assist:provider';
  const aiModelKey = p => 'trip-planner:assist:model:' + p;
  const CLIENT_ID_KEY = 'trip-planner:assist:clientId';
  const chatKey = tripId => 'trip-planner:chat:' + tripId;
  const CHAT_CAP = 40;

  let assistSending = false;

  function assistProvider() {
    const p = localStorage.getItem(AI_PROVIDER_KEY);
    return PROVIDER_META[p] ? p : 'openai';
  }
  function assistModel() {
    const p = assistProvider();
    const saved = localStorage.getItem(aiModelKey(p));
    return PROVIDER_META[p].models.some(m => m.id === saved) ? saved : PROVIDER_META[p].models[0].id;
  }
  function loadKey(provider) { return localStorage.getItem(AI_KEY_PREFIX + provider) || ''; }

  function byokTierHtml() {
    const provider = assistProvider();
    const meta = PROVIDER_META[provider];
    const model = assistModel();
    const hasKey = !!loadKey(provider);
    const providerOpts = Object.entries(PROVIDER_META)
      .map(([k, v]) => `<option value="${k}" ${k === provider ? 'selected' : ''}>${esc(v.label)}</option>`).join('');
    const modelOpts = meta.models
      .map(m => `<option value="${m.id}" ${m.id === model ? 'selected' : ''}>${esc(m.label)}</option>`).join('');
    return `
      <div class="assist-byok">
        <div class="assist-two-col">
          <div class="field assist-field">
            <label for="assistProviderSelect">Provider</label>
            <div class="sel-wrap"><select id="assistProviderSelect">${providerOpts}</select></div>
          </div>
          <div class="field assist-field">
            <label for="assistModelSelect">Model</label>
            <div class="sel-wrap"><select id="assistModelSelect">${modelOpts}</select></div>
          </div>
        </div>
        <div class="field assist-field">
          <label for="assistKeyInput">${esc(meta.label)} API key</label>
          <input type="password" id="assistKeyInput" autocomplete="off" spellcheck="false"
            placeholder="${hasKey ? 'Key saved (hidden)' : 'Paste your ' + esc(meta.label) + ' API key'}">
        </div>
        <div class="assist-key-actions">
          <button type="button" class="btn primary" id="assistKeySave">Save key</button>
          <button type="button" class="btn danger" id="assistKeyRemove" ${hasKey ? '' : 'disabled'}>Remove key</button>
          <a href="${meta.keyLink}" target="_blank" rel="noopener" class="assist-key-link">Get a key</a>
        </div>
        <div class="assist-key-note">Your key stays only in this browser.</div>
      </div>`;
  }

  function setAssistProvider(p) {
    if (!PROVIDER_META[p]) return;
    localStorage.setItem(AI_PROVIDER_KEY, p);
    localStorage.removeItem(aiModelKey(p)); // fall back to the provider default
    $('#assistTierBody').innerHTML = byokTierHtml();
  }
  function setAssistModel(id) {
    const p = assistProvider();
    if (PROVIDER_META[p].models.some(m => m.id === id)) localStorage.setItem(aiModelKey(p), id);
  }
  function handleKeySave() {
    const input = $('#assistKeyInput');
    const val = (input.value || '').trim();
    if (!val) return;
    localStorage.setItem(AI_KEY_PREFIX + assistProvider(), val);
    input.value = '';
    $('#assistTierBody').innerHTML = byokTierHtml();
    toast('API key saved in this browser.');
  }
  function handleKeyRemove() {
    localStorage.removeItem(AI_KEY_PREFIX + assistProvider());
    $('#assistTierBody').innerHTML = byokTierHtml();
    toast('API key removed.');
  }

  // ---------- chat history (per trip, capped) ----------
  function loadChat(tripId) {
    try {
      const arr = JSON.parse(localStorage.getItem(chatKey(tripId)) || '[]');
      return Array.isArray(arr) ? arr.filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string') : [];
    } catch { return []; }
  }
  function saveChat(tripId, history) {
    const capped = history.slice(-CHAT_CAP);
    try { localStorage.setItem(chatKey(tripId), JSON.stringify(capped)); } catch { /* best effort */ }
    return capped;
  }
  function assistClientId() {
    let id = localStorage.getItem(CLIENT_ID_KEY);
    if (!id) { id = uid(); localStorage.setItem(CLIENT_ID_KEY, id); }
    return id;
  }

  function restoreChat() {
    const trip = activeTrip();
    if (!trip) return;
    const msgs = $('#assistMessages');
    msgs.innerHTML = '';
    assistActions.clear();
    const history = loadChat(trip.id);
    for (const m of history) {
      if (m.role === 'user') appendBubble('user', m.content);
      else appendBubble('assistant', m.content);
    }
    // coming back to a conversation already in progress opens on the
    // conversation, not on the picker that started it
    if (history.length) setSetupCollapsed(true);
    scrollMessages();
  }

  function clearChat() {
    const trip = activeTrip();
    if (!trip) return;
    try { localStorage.removeItem(chatKey(trip.id)); } catch { /* best effort */ }
    $('#assistMessages').innerHTML = '';
    assistActions.clear();
  }

  // ---------- chat UI helpers ----------
  // the thread is not its own scroller (the panel body is), so a new bubble has
  // to move THAT box or the reply lands below the fold
  function scrollMessages() { const s = $('.tp-assist-scroll'); s.scrollTop = s.scrollHeight; }

  // Markdown rendering for assistant replies. parseMarkdown returns PURE DATA,
  // and every leaf below lands through createTextNode/textContent, so the reply
  // string never reaches innerHTML and cannot become markup. hrefs were already
  // restricted to absolute http(s) by the parser.
  function mdInlineInto(parent, nodes) {
    for (const n of nodes) {
      if (n.type === 'text') { parent.appendChild(document.createTextNode(n.text)); continue; }
      if (n.type === 'br') { parent.appendChild(document.createElement('br')); continue; }
      if (n.type === 'code') {
        const c = document.createElement('code');
        c.textContent = n.text;
        parent.appendChild(c);
        continue;
      }
      if (n.type === 'link') {
        const a = document.createElement('a');
        a.href = n.href;
        a.target = '_blank';
        a.rel = 'noopener';
        mdInlineInto(a, n.children);
        parent.appendChild(a);
        continue;
      }
      const el = document.createElement(n.type === 'strong' ? 'strong' : 'em');
      mdInlineInto(el, n.children);
      parent.appendChild(el);
    }
  }
  function renderMarkdownInto(host, text) {
    host.classList.add('assist-md');
    for (const b of parseMarkdown(text)) {
      if (b.type === 'code') {
        const pre = document.createElement('pre');
        const code = document.createElement('code');
        code.textContent = b.text;
        pre.appendChild(code);
        host.appendChild(pre);
        continue;
      }
      if (b.type === 'list') {
        const listEl = document.createElement(b.ordered ? 'ol' : 'ul');
        if (b.ordered && b.start > 1) listEl.start = b.start;
        for (const item of b.items) {
          const li = document.createElement('li');
          mdInlineInto(li, item.inline);
          listEl.appendChild(li);
        }
        host.appendChild(listEl);
        continue;
      }
      const tag = b.type === 'heading' ? 'h' + b.level : (b.type === 'quote' ? 'blockquote' : 'p');
      const el = document.createElement(tag);
      mdInlineInto(el, b.inline);
      host.appendChild(el);
    }
  }

  function appendBubble(role, text) {
    const b = document.createElement('div');
    b.className = 'assist-msg ' + role;
    // The assistant writes Markdown; the traveller does not, and rendering it
    // for them would reformat text they typed literally.
    if (role === 'assistant') renderMarkdownInto(b, text);
    else b.textContent = text; // textContent escapes any markup in the message
    $('#assistMessages').appendChild(b);
    scrollMessages();
    return b;
  }
  function appendError(text) {
    const e = document.createElement('div');
    e.className = 'assist-error';
    e.textContent = text;
    $('#assistMessages').appendChild(e);
    scrollMessages();
  }
  function showTyping() {
    const t = document.createElement('div');
    t.className = 'assist-msg assistant assist-typing';
    t.innerHTML = '<span></span><span></span><span></span>';
    $('#assistMessages').appendChild(t);
    scrollMessages();
    return t;
  }
  function syncSendState() {
    const send = $('#assistSend');
    const input = $('#assistInput');
    if (send) { send.disabled = assistSending; send.textContent = assistSending ? 'Sending...' : 'Send'; }
    if (input) input.disabled = assistSending;
  }

  // Turn the assistant's raw reply into a prose bubble plus proposal cards, then
  // persist the prose to history (proposal cards are transient by design).
  function handleAssistantReply(reply, tripId) {
    const { actions, cleanedText } = extractTripActions(reply);
    if (cleanedText) appendBubble('assistant', cleanedText);
    if (actions.length) {
      const container = document.createElement('div');
      container.className = 'assist-proposals';
      $('#assistMessages').appendChild(container);
      renderProposals(actions, container);
    }
    if (!cleanedText && !actions.length) appendBubble('assistant', 'No reply came back. Try rephrasing your request.');
    const history = loadChat(tripId);
    history.push({ role: 'assistant', content: cleanedText || reply });
    saveChat(tripId, history);
    scrollMessages();
  }

  // Auto-growing composer: it starts at three lines and follows the typing up
  // to a cap, so a long message is visible without the thread losing its room.
  const COMPOSER_MAX_H = 208;
  function autoGrowInput() {
    const el = $('#assistInput');
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, COMPOSER_MAX_H) + 'px';
  }

  function sendChat() {
    const input = $('#assistInput');
    const text = (input.value || '').trim();
    if (!text || assistSending) return;
    input.value = '';
    autoGrowInput();
    sendMessage(text);
  }

  async function sendMessage(text) {
    if (assistSending) return;
    const trip = activeTrip();
    if (!trip) return;
    const tripId = trip.id;
    // the thread is what matters from here on, so the setup block gets out of
    // its way (one tap on the summary bar brings it back)
    setSetupCollapsed(true);
    appendBubble('user', text);
    let history = loadChat(tripId);
    history.push({ role: 'user', content: text });
    history = saveChat(tripId, history);

    assistSending = true;
    syncSendState();
    const typing = showTyping();
    try {
      const reply = assistTier === 'site'
        ? await callSiteAssistant(history, trip)
        : await callByokProvider(history, trip);
      typing.remove();
      handleAssistantReply(reply, tripId);
    } catch (err) {
      typing.remove();
      appendError(err && err.userMessage ? err.userMessage : 'Something went wrong. Try again.');
    } finally {
      assistSending = false;
      syncSendState();
    }
  }

  function assistError(msg) { const e = new Error(msg); e.userMessage = msg; return e; }

  // ---------- provider requests ----------
  async function callByokProvider(history, trip) {
    const provider = assistProvider();
    const model = assistModel();
    const key = loadKey(provider);
    if (!key) throw assistError('Add your ' + PROVIDER_META[provider].label + ' API key first.');
    const sys = buildAssistSystemPrompt({ trip, focusDate: assistFocusDate, today: todayIso() });

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60000);
    let res;
    try {
      if (provider === 'openai') {
        res = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
          body: JSON.stringify({ model, messages: [{ role: 'system', content: sys }, ...history.map(m => ({ role: m.role, content: m.content }))] }),
          signal: ctrl.signal,
        });
      } else {
        // key travels in the x-goog-api-key header, never the URL: the newer
        // AQ.-prefixed Google keys 404 on the legacy ?key= query param, and
        // header auth also keeps the key out of URLs/logs/screenshots
        const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent';
        res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: sys }] },
            contents: history.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
          }),
          signal: ctrl.signal,
        });
      }
    } catch {
      throw assistError('Network error, check your connection and try again.');
    } finally {
      clearTimeout(timer);
    }
    const rawBody = await res.text();
    if (!res.ok) {
      // diagnostics for the console: full provider response, masked key only
      console.error('[assistant] provider error',
        { provider, url: res.url, status: res.status, key: maskKey(key), body: rawBody.slice(0, 2000) });
      if (res.status === 400 || res.status === 401 || res.status === 403) throw assistError('That API key looks invalid (' + res.status + '). Double-check it and try again.');
      if (res.status === 429) throw assistError("You've hit your provider's rate limit or quota (429). Wait a bit or check your plan.");
      if (res.status === 404) throw assistError('The provider says this model does not exist (404). Pick another model and try again.');
      throw assistError('The provider returned an error (' + res.status + '). Try again in a moment.');
    }
    let data;
    try { data = JSON.parse(rawBody); } catch { throw assistError('Network error, check your connection and try again.'); }
    return provider === 'openai' ? openaiText(data) : geminiText(data);
  }

  // never print a full key anywhere: first 6 chars is enough to identify it
  function maskKey(key) {
    return key ? String(key).slice(0, 6) + '\u2026 (masked)' : '(none)';
  }

  function openaiText(data) {
    return (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
  }
  function geminiText(data) {
    const parts = (data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
    return parts.map(p => (p && p.text) || '').join('');
  }

  // ---------- Tier 3: site assistant ----------
  async function callSiteAssistant(history, trip) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60000);
    let res;
    try {
      res = await fetch('/.netlify/functions/tp-assist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tripContext: { trip: slimTripForShare(trip), focusDate: assistFocusDate || null, today: todayIso() },
          messages: history.slice(-CHAT_CAP),
          clientId: assistClientId(),
        }),
        signal: ctrl.signal,
      });
    } catch {
      throw assistError('Network error, check your connection and try again.');
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      let body = {};
      try { body = await res.json(); } catch { /* non-JSON error body */ }
      if (res.status === 503 || body.error === 'not_configured') throw assistError("The site's free assistant isn't set up yet. Try Tier 1 or bring your own key.");
      if (res.status === 429 || body.error === 'quota_exceeded') throw assistError('The shared assistant is at capacity today. Use Tier 1 or add your own API key.');
      // The server trims long descriptions to make a heavy trip fit; this is
      // the case where even the dates and titles alone are too big to send. It
      // has to say what happened, because "could not answer right now" would
      // send the traveller into retrying something that can never succeed.
      if (res.status === 413 || body.error === 'trip_too_large') throw assistError('This trip is too big to send to the shared assistant. Shorten some item descriptions, or split it into two trips. Tier 1 (copy and paste) has no size limit.');
      throw assistError('The shared assistant could not answer right now. Try again, or use Tier 1.');
    }
    let data;
    try { data = await res.json(); } catch { throw assistError('Network error, check your connection and try again.'); }
    return data.reply || '';
  }

  // The copy/paste tier used to open with its own "what do you want help with"
  // textarea, which the picker already answers. Copying is now the one primary
  // action below, so this body is just the round trip: open an AI, bring the
  // reply back.
  function copyTierHtml() {
    return `
      <ol class="assist-flow">
        <li class="af-move">
          <div class="af-head"><span class="af-n" aria-hidden="true">a</span><span class="af-label">Open an AI and paste</span></div>
          <div class="assist-quick-links">
            <a href="https://chatgpt.com" target="_blank" rel="noopener">ChatGPT<span aria-hidden="true"> ↗</span></a>
            <a href="https://gemini.google.com" target="_blank" rel="noopener">Gemini<span aria-hidden="true"> ↗</span></a>
            <a href="https://claude.ai" target="_blank" rel="noopener">Claude<span aria-hidden="true"> ↗</span></a>
          </div>
        </li>
        <li class="af-move">
          <div class="af-head"><span class="af-n" aria-hidden="true">b</span><label for="assistPasteBox">Bring the reply back</label></div>
          <textarea id="assistPasteBox" class="af-input" rows="3" placeholder="Paste the whole reply, including any JSON"></textarea>
          <button type="button" class="btn af-go" id="assistPasteParse">Add the AI's reply</button>
        </li>
      </ol>`;
  }

  // The day dropdown is the focused-day indicator whenever the trip has dated
  // days, so the chip would only repeat it. It survives for the one case the
  // dropdown cannot cover: a focus date on a trip with no day cards at all.
  function renderFocusChip() {
    const chip = $('#assistFocusChip');
    const hasDays = dayCards(activeTrip()).length > 0;
    if (hasDays || !assistFocusDate || !isIsoDate(assistFocusDate)) { chip.hidden = true; chip.innerHTML = ''; return; }
    const st = tripStats(activeTrip());
    const dayNum = isIsoDate(st.start) ? diffDays(st.start, assistFocusDate) + 1 : null;
    const label = (dayNum && dayNum > 0)
      ? `Focused: Day ${dayNum} (${fmtDate(assistFocusDate)})`
      : `Focused: ${fmtDate(assistFocusDate)}`;
    chip.hidden = false;
    chip.innerHTML = `<span>${esc(label)}</span><button type="button" class="chip-x" id="assistFocusClear" title="Clear focus" aria-label="Clear focus">✕</button>`;
  }

  // ---------- "Plan my day" picker ----------
  // Composes the request text for the traveller instead of making them write
  // prose. Everything here is local: buildPlanRequest is a pure formatter, so
  // opening and exercising the picker never touches the network.
  const PLAN_STYLES = {
    activities: ['Culture & History', 'Nature & Outdoors', 'Shopping', 'Nightlife', 'Off the beaten path', 'Iconic / must-see'],
    drinks: ['Dive', 'Classy', 'Rooftop', 'Luxury', 'Casual'],
    meals: ['Local & street food', 'Fine dining', 'Casual sit-down', 'Quick / grab-and-go'],
  };
  const PLAN_MEALS = ['breakfast', 'lunch', 'dinner'];
  const WAKE_PICKS = ['06:30', '08:00', '09:30', '11:00'];
  const RETURN_PICKS = ['20:00', '22:00', '00:00', '02:00'];
  const BUDGET_LABELS = { 1: '$', 2: '$$', 3: '$$$', 4: '$$$$' };
  const planMemory = new Map(); // focus date -> the prefs last used for it this session
  let planPrefs = null;
  let planPreviewOpen = false; // survives the picker's full repaints

  function defaultPlanPrefs(date) {
    return {
      date, activities: 3, drinks: 0,
      meals: { breakfast: true, lunch: true, dinner: true },
      styles: { activities: [], drinks: [], meals: [] },
      wakeTime: '08:00', returnTime: '22:00', repeatOk: false, budget: 2, note: '',
    };
  }

  const planMealsOn = p => PLAN_MEALS.some(m => p.meals[m]);
  const planHasSlot = p => !!p.activities || !!p.drinks || planMealsOn(p);
  const toMin = t => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  // A return time in the small hours means "after midnight", not "before I woke
  // up", so anything at or before 04:00 counts as the next day. Without this,
  // the 00:00 and 02:00 quick picks would read as an error.
  function planTimesOk(p) {
    const wake = toMin(p.wakeTime);
    let back = toMin(p.returnTime);
    if (back < wake && back <= 240) back += 24 * 60;
    return back > wake;
  }
  const planUsable = p => planHasSlot(p) && planTimesOk(p);

  // Every choice repaints the whole picker, which throws away the control the
  // traveller just operated. A keyboard user would land on <body> after each
  // Enter, so the active control is found again by the same data attributes it
  // was rendered with and re-focused.
  const PLAN_KEY_ATTRS = ['data-plan-num', 'data-plan-style', 'data-plan-meal', 'data-plan-time', 'data-plan-repeat', 'data-plan-budget', 'data-plan-custom'];
  const attrQuote = v => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  function plannerFocusSel(el) {
    if (!el || el === document.body) return '';
    if (el.id) return '#' + el.id;
    const parts = PLAN_KEY_ATTRS.filter(a => el.hasAttribute(a)).map(a => `[${a}="${attrQuote(el.getAttribute(a))}"]`);
    if (!parts.length) return '';
    if (el.hasAttribute('data-plan-val')) parts.push(`[data-plan-val="${attrQuote(el.getAttribute('data-plan-val'))}"]`);
    return parts.join('');
  }

  function renderPlanner() {
    const box = $('#assistPlanner');
    const review = $('#assistReview');
    if (!box) return;
    const active = document.activeElement;
    const refocus = box.contains(active) ? plannerFocusSel(active) : '';
    const trip = activeTrip();
    const cards = dayCards(trip);
    // The dropdown always carries a selection, so it picks a sensible day the
    // moment the panel opens instead of making the traveller choose one before
    // anything else appears.
    if (cards.length && !isIsoDate(assistFocusDate)) {
      assistFocusDate = defaultPlanDay(cards.map(c => c.date), todayIso());
      const panel = $('#assistPanel');
      if (panel && assistFocusDate) panel.dataset.focusDate = assistFocusDate;
    }
    if (!assistFocusDate || !isIsoDate(assistFocusDate)) {
      planPrefs = null;
      box.innerHTML = `<p class="pl-empty">Add items with dates first, then a day to plan appears here.</p>`;
      review.innerHTML = '';
      return;
    }
    if (!planPrefs || planPrefs.date !== assistFocusDate) {
      planPrefs = planMemory.get(assistFocusDate) || defaultPlanPrefs(assistFocusDate);
      planMemory.set(assistFocusDate, planPrefs);
    }
    box.innerHTML = plannerControlsHtml(trip, cards, planPrefs);
    review.innerHTML = plannerReviewHtml(trip, planPrefs);
    if (refocus) {
      const back = box.querySelector(refocus);
      if (back) back.focus({ preventScroll: true });
    }
  }

  // One native <select>, not a custom listbox: iOS and Android render the open
  // list themselves and ignore option styling, so a bespoke one would look
  // right on a desktop and wrong on the phone this is used on. The closed
  // control is styleable, which is where the today/past state is shown.
  function planDaySelectHtml(trip, cards, current) {
    const today = todayIso();
    const byDate = new Map(cards.map(c => [c.date, c]));
    const optionHtml = d => {
      const c = byDate.get(d);
      // same source as the day tiles used, so the two views never disagree
      const city = dayMorningCity(trip.items, d, geoResolved).city;
      const label = `Day ${c.dayNumber} · ${fmtDate(d, false)}${city ? ' · ' + city : ''}`;
      return `<option value="${d}"${d === current ? ' selected' : ''}>${esc(label)}</option>`;
    };
    const body = planDayGroups(cards.map(c => c.date), today).map(g => {
      const opts = g.days.map(optionHtml).join('');
      return g.label ? `<optgroup label="${esc(g.label)}">${opts}</optgroup>` : opts;
    }).join('');
    const state = current === today ? ' is-today' : (current < today ? ' is-past' : '');
    return `<div class="pl-day-field${state}">
      <select id="planDaySelect" class="pl-day-select" aria-label="Day to plan">${body}</select>
    </div>`;
  }

  // Pick-one control: one track, one filled segment. Replaces the row of
  // separate outlined pills, which read as several buttons rather than one
  // choice.
  const planSeg = (attrs, on, label) =>
    `<button type="button" class="pl-seg-b${on ? ' on' : ''}" role="radio" aria-checked="${on}" ${attrs}>${esc(label)}</button>`;

  // `wide` puts the label on its own line: a two-option row whose labels are
  // sentences cannot share a 390px line with an 82px label column without
  // truncating one of them.
  function planSegRow(label, key, options, current, attrFor, wide) {
    const id = `pl-${key}-lbl`;
    const segs = options.map(([val, text]) => planSeg(attrFor(val), val === current, text)).join('');
    return `<div class="pl-row${wide ? ' pl-row-wide' : ''}">
      <div class="pl-label" id="${id}">${esc(label)}</div>
      <div class="pl-seg" role="radiogroup" aria-labelledby="${id}">${segs}</div>
    </div>`;
  }

  const planRangeRow = (label, key, options, current) =>
    planSegRow(label, key, options, current, v => `data-plan-num="${key}" data-plan-val="${v}"`);

  // Pick-many control: quieter tags, so a row of six optional styles cannot
  // outweigh the pick-one rows above it.
  function planStyleRow(label, key, picked) {
    const tags = PLAN_STYLES[key].map(s =>
      `<button type="button" class="pl-tag${picked.includes(s) ? ' on' : ''}" aria-pressed="${picked.includes(s)}"
        data-plan-style="${key}" data-plan-val="${esc(s)}">${esc(s)}</button>`).join('');
    return `<div class="pl-row pl-row-wide pl-style-row" data-style-row="${key}">
      <div class="pl-label">${esc(label)} <small>optional</small></div>
      <div class="pl-tags">${tags}</div>
    </div>`;
  }

  // The custom time sits on the label line and the quick picks fill the track
  // below it: at 390px the four picks plus a time field cannot share one row.
  function planTimeRow(label, key, picks, current) {
    const id = `pl-${key}-lbl`;
    const segs = picks.map(t =>
      planSeg(`data-plan-time="${key}" data-plan-val="${t}"`, t === current, fmtTime(t))).join('');
    return `<div class="pl-row pl-row-wide">
      <div class="pl-row-top">
        <div class="pl-label" id="${id}">${esc(label)}</div>
        <input type="time" class="pl-time" data-plan-custom="${key}" value="${current}" aria-label="${esc(label)} (custom time)">
      </div>
      <div class="pl-seg" role="radiogroup" aria-labelledby="${id}">${segs}</div>
    </div>`;
  }

  function plannerControlsHtml(trip, cards, p) {
    const timesOk = planTimesOk(p);
    return `
      <div class="pl-body">
        ${planDaySelectHtml(trip, cards, p.date)}
        <div class="pl-rows">
          ${planRangeRow('Activities', 'activities', [[0, 'Skip'], [2, '1-2'], [3, '2-3'], [4, '3-4']], p.activities)}
          ${p.activities ? planStyleRow('Activity style', 'activities', p.styles.activities) : ''}
          ${planRangeRow('Drinks', 'drinks', [[0, 'Skip'], [2, '1-2'], [3, '2-3']], p.drinks)}
          ${p.drinks ? planStyleRow('Drinks style', 'drinks', p.styles.drinks) : ''}
          <div class="pl-row">
            <div class="pl-label">Meals</div>
            <div class="pl-tags">${PLAN_MEALS.map(m => `<button type="button" class="pl-tag${p.meals[m] ? ' on' : ''}"
              aria-pressed="${!!p.meals[m]}" data-plan-meal="${m}">${m[0].toUpperCase() + m.slice(1)}</button>`).join('')}</div>
          </div>
          ${planMealsOn(p) ? planStyleRow('Meal style', 'meals', p.styles.meals) : ''}
          ${planTimeRow('Wake up', 'wake', WAKE_PICKS, p.wakeTime)}
          ${planTimeRow('Back by', 'return', RETURN_PICKS, p.returnTime)}
          ${timesOk ? '' : '<div class="pl-err" role="alert">Return time must be after wake time</div>'}
          ${planSegRow('Places', 'repeat', [['0', 'New places only'], ['1', 'Repeating is fine']], p.repeatOk ? '1' : '0', v => `data-plan-repeat="${v}"`, true)}
          ${planSegRow('Budget', 'budget', [[1, '$'], [2, '$$'], [3, '$$$'], [4, '$$$$']], p.budget, v => `data-plan-budget="${v}"`)}
          <div class="pl-row pl-row-wide">
            <div class="pl-row-top">
              <label class="pl-label" for="planNote">Anything else? <small>optional</small></label>
              <span class="pl-count" id="planNoteCount">${p.note.length}/300</span>
            </div>
            <textarea id="planNote" class="pl-note-box" maxlength="300" rows="2"
              placeholder="e.g. no long walks, back before the football">${esc(p.note)}</textarea>
          </div>
        </div>
      </div>`;
  }

  // A one-line read of the picker: what day, how much of it, at what budget.
  // Used both as the collapsed review summary and as the compact bar the whole
  // setup block folds into once the conversation has started.
  const PLAN_RANGE_LABEL = { 2: '1-2', 3: '2-3', 4: '3-4' };
  function planSummaryText(trip, p) {
    const card = dayCards(trip).find(c => c.date === p.date);
    const bits = [card ? `Day ${card.dayNumber} · ${fmtDate(p.date, false)}` : fmtDate(p.date, false)];
    if (p.activities) bits.push(`${PLAN_RANGE_LABEL[p.activities] || p.activities} activities`);
    const meals = PLAN_MEALS.filter(m => p.meals[m]);
    if (meals.length) bits.push(meals.length === 3 ? 'all meals' : meals.join(' + '));
    if (p.drinks) bits.push(`${PLAN_RANGE_LABEL[p.drinks] || p.drinks} drinks`);
    bits.push(BUDGET_LABELS[p.budget] || BUDGET_LABELS[2]);
    return bits.join(' · ');
  }

  // The exact text that will be sent stays one tap away, never gone: this is a
  // summary line with an Expand, not a hidden prompt. The primary button does
  // the whole job (send, or copy on tier 1) - there is no staging step.
  function plannerReviewHtml(trip, p) {
    const hasSlot = planHasSlot(p);
    if (!hasSlot) {
      return `<div class="pl-review">
        <div class="pl-err" role="alert">Pick at least one thing to plan.</div>
      </div>`;
    }
    const copyTier = assistTier === 'copy';
    return `
      <div class="pl-review">
        <div class="pl-sum">
          <span class="pl-sum-txt">${esc(planSummaryText(trip, p))}</span>
          <button type="button" class="pl-expand" data-plan-expand aria-expanded="${planPreviewOpen}" aria-controls="planPreview">${planPreviewOpen ? 'Hide' : 'Expand'}</button>
        </div>
        <div class="pl-preview" id="planPreview"${planPreviewOpen ? '' : ' hidden'}>${esc(buildPlanRequest(p, trip))}</div>
        <button type="button" class="btn primary pl-go" data-plan-send ${planUsable(p) ? '' : 'disabled'}>${copyTier ? 'Copy for any AI' : 'Send to the assistant'}</button>
      </div>`;
  }

  function togglePlanStyle(key, value) {
    const list = planPrefs.styles[key];
    const i = list.indexOf(value);
    if (i < 0) list.push(value); else list.splice(i, 1);
  }

  function onPlannerClick(e) {
    if (e.target.closest('[data-plan-send]')) { runPlanRequest(); return; }
    if (e.target.closest('[data-plan-expand]')) { togglePlanPreview(); return; }
    const btn = e.target.closest('button[data-plan-num], button[data-plan-style], button[data-plan-meal], button[data-plan-time], button[data-plan-repeat], button[data-plan-budget]');
    if (!btn || !planPrefs) return;
    const d = btn.dataset;
    if (d.planNum) planPrefs[d.planNum] = Number(d.planVal);
    else if (d.planStyle) togglePlanStyle(d.planStyle, d.planVal);
    else if (d.planMeal) planPrefs.meals[d.planMeal] = !planPrefs.meals[d.planMeal];
    else if (d.planTime) planPrefs[d.planTime === 'wake' ? 'wakeTime' : 'returnTime'] = d.planVal;
    else if (d.planRepeat) planPrefs.repeatOk = d.planRepeat === '1';
    else if (d.planBudget) planPrefs.budget = Number(d.planBudget);
    renderPlanner();
  }

  // The note re-renders nothing: a full repaint mid-sentence would steal the
  // caret. Preview and counter are patched in place instead.
  function onPlannerInput(e) {
    if (e.target.id !== 'planNote' || !planPrefs) return;
    planPrefs.note = e.target.value;
    $('#planNoteCount').textContent = planPrefs.note.length + '/300';
    if (planHasSlot(planPrefs)) $('#planPreview').textContent = buildPlanRequest(planPrefs, activeTrip());
  }

  function onPlannerChange(e) {
    // Switching days keeps the day it is leaving in planMemory, so coming back
    // restores exactly the controls that day was left with.
    if (e.target.id === 'planDaySelect') { setAssistFocus(e.target.value); return; }
    const custom = e.target.closest('[data-plan-custom]');
    if (!custom || !planPrefs || !/^\d{2}:\d{2}$/.test(custom.value)) return;
    planPrefs[custom.dataset.planCustom === 'wake' ? 'wakeTime' : 'returnTime'] = custom.value;
    renderPlanner();
  }

  function setAssistFocus(date) {
    assistFocusDate = (date && isIsoDate(date)) ? date : null;
    const panel = $('#assistPanel');
    if (assistFocusDate) panel.dataset.focusDate = assistFocusDate; else delete panel.dataset.focusDate;
    renderFocusChip();
    renderPlanner();
  }

  function togglePlanPreview() {
    planPreviewOpen = !planPreviewOpen;
    const box = $('#planPreview');
    const btn = $('#assistReview').querySelector('[data-plan-expand]');
    if (!box || !btn) return;
    box.hidden = !planPreviewOpen;
    btn.setAttribute('aria-expanded', String(planPreviewOpen));
    btn.textContent = planPreviewOpen ? 'Hide' : 'Expand';
  }

  // The one action. On tiers 2 and 3 the composed request goes to the AI on
  // this press; on tier 1 it goes to the clipboard, which is that tier's whole
  // purpose. Nothing is staged into a box for a second press.
  function runPlanRequest() {
    if (!planPrefs || !planUsable(planPrefs) || assistSending) return;
    const text = buildPlanRequest(planPrefs, activeTrip());
    if (assistTier === 'copy') { copyAssistPackage(text); return; }
    sendMessage(text);
  }

  async function copyAssistPackage(request) {
    const trip = activeTrip();
    const pkg = buildAssistPackage({ trip, focusDate: assistFocusDate, request });
    try { await navigator.clipboard.writeText(pkg); toast('Request copied. Paste it into any AI.'); }
    catch { window.prompt('Copy the assistant package:', pkg); }
  }

  function handleAssistPaste() {
    const boxEl = $('#assistPasteBox');
    const raw = boxEl ? boxEl.value : '';
    if (!raw.trim()) return;
    const { actions, cleanedText } = extractTripActions(raw);
    const msgs = $('#assistMessages');
    if (cleanedText) {
      const bubble = document.createElement('div');
      bubble.className = 'assist-msg assistant';
      renderMarkdownInto(bubble, cleanedText);
      msgs.appendChild(bubble);
    }
    if (actions.length) {
      const container = document.createElement('div');
      container.className = 'assist-proposals';
      msgs.appendChild(container);
      renderProposals(actions, container);
    } else if (!cleanedText) {
      toast('No changes found in that reply.');
    }
    if (boxEl) boxEl.value = '';
    msgs.scrollTop = msgs.scrollHeight;
  }

  // ---------- Google ratings on proposal cards ----------
  // A lookup costs the site owner real money on a cache miss, so the rules are:
  // one batched request per rendered reply (never one per candidate), an
  // in-memory cache for the whole session keyed by the normalized query, and a
  // hard stop the moment the endpoint says it is unconfigured or out of quota.
  // Nothing here can block or break a card: ratings are painted into empty
  // placeholders after the fact, and if they never arrive the card is unchanged.
  const placesCache = new Map();   // key -> { status:'ok', ... } | { status:'no_match' }
  const placesInFlight = new Set();
  let placesOff = false;           // 503/403/400: no key configured, stay silent all session
  let placesPausedUntil = 0;       // 429 or network trouble: transient, retry later
  const placesKnown = { has: k => placesCache.has(k) || placesInFlight.has(k) };

  // Owner tier: the site owner pastes a secret into localStorage once (see
  // the OWNER TIER note in netlify/functions/tp-places.mjs) and this browser
  // gets the higher owner quota server-side. Everyone else has no token and
  // sends no field; there is no UI for this on purpose.
  const PLACES_OWNER_TOKEN_KEY = 'trip-planner:places:ownerToken';
  function placesRequestBody(batch) {
    const body = { clientId: assistClientId(), queries: batch.map(m => m.query) };
    let token = '';
    try { token = localStorage.getItem(PLACES_OWNER_TOKEN_KEY) || ''; } catch { /* private mode */ }
    if (token) body.ownerToken = token;
    return body;
  }

  function placesUsable() { return !placesOff && Date.now() >= placesPausedUntil; }

  // Rendered by every card that has a mapsQuery. Empty until (and unless) a
  // rating arrives, which is what makes the unconfigured case invisible.
  function ratingSlotHtml(mapsQuery) {
    const key = placeCacheKey(mapsQuery);
    return key ? `<div class="ap-rating" data-place-key="${esc(key)}" data-place-query="${esc(mapsQuery)}"></div>` : '';
  }

  // Google Maps Platform attribution: the rating, the review count and the
  // "Google Maps" wordmark travel together inside one bordered, tinted chip,
  // so the Google content is visually separated from the card's own content;
  // the whole chip is the link to this result's mapsUri, and the wordmark text
  // is verbatim, never truncated (CSS keeps it nowrap and outside any ellipsis).
  function paintRatingSlot(el) {
    if (el.dataset.painted === '1') return;
    const entry = placesCache.get(el.dataset.placeKey || '');
    if (!entry || entry.status !== 'ok') return;
    el.dataset.painted = '1';
    const count = entry.userRatingCount ? entry.userRatingCount.toLocaleString() : '';
    const label = `${entry.rating} out of 5 on Google Maps${count ? ', ' + count + ' reviews' : ''}. Opens Google Maps.`;
    el.innerHTML = `
      <a class="apr-chip" href="${esc(entry.mapsUri)}" target="_blank" rel="noopener" aria-label="${esc(label)}">
        <span class="apr-star" aria-hidden="true">★</span>
        <span class="apr-score">${esc(entry.rating.toFixed(1))}</span>
        ${count ? `<span class="apr-count">(${esc(count)})</span>` : ''}
        <span class="apr-brand">Google Maps</span>
      </a>`;
  }

  // The definitive fix for "Verify opened the wrong place": once the lookup has
  // resolved this query to a real place, the anchor points at THAT place instead
  // of a search that Google is free to reinterpret. No extra request: this reads
  // the same cache the ratings do.
  function paintMapsLink(el) {
    const link = assistMapsLink(el.dataset.placeQuery || '', placesCache.get(el.dataset.placeKey || ''));
    if (!link) return;
    if (el.getAttribute('href') !== link.href) el.setAttribute('href', link.href);
    if (el.textContent !== link.label) el.textContent = link.label;
  }

  // Itinerary combined link: once the lookup resolves this place, upgrade the
  // href to the real mapsUri, append the rating segment ` • ⭐ 4.7 (1,800)` and
  // move the rating into the accessible name. Idempotent: the painted flag makes
  // a repeat paintPlaces call (a later batch, a re-render sharing the cache) a
  // no-op, and the count parenthetical is dropped when Google has no reviews.
  function paintTripMapsLink(el) {
    if (el.dataset.painted === '1') return;
    const entry = placesCache.get(el.dataset.placeKey || '');
    if (!entry || entry.status !== 'ok') return;
    el.dataset.painted = '1';
    const count = entry.userRatingCount ? entry.userRatingCount.toLocaleString() : '';
    const aria = `${entry.rating} out of 5 on Google Maps${count ? ', ' + count + ' reviews' : ''}. Opens Google Maps.`;
    el.setAttribute('aria-label', aria);
    if (entry.mapsUri) el.setAttribute('href', entry.mapsUri);
    const seg = document.createElement('span');
    seg.className = 'tpm-rating';
    seg.innerHTML = ` <span class="tpm-sep" aria-hidden="true">·</span> `
      + `<span class="tpm-star" aria-hidden="true">⭐</span> `
      + `<span class="tpm-score">${esc(entry.rating.toFixed(1))}</span>`
      + (count ? ` <span class="tpm-count">(${esc(count)})</span>` : '');
    el.appendChild(seg);
  }

  function paintPlaces(root) {
    const scope = root && root.querySelectorAll ? root : document;
    scope.querySelectorAll('.ap-rating[data-place-key]').forEach(paintRatingSlot);
    scope.querySelectorAll('.assist-maps-link[data-place-key]').forEach(paintMapsLink);
    scope.querySelectorAll('.tp-maps-link[data-place-key]').forEach(paintTripMapsLink);
  }

  // Called once per rendered batch of proposal cards. Paints whatever the
  // session cache already knows (a re-render or a repeat venue costs nothing),
  // then asks only for what is genuinely missing.
  function hydrateRatings(container) {
    paintPlaces(container);
    const queries = [...container.querySelectorAll('.ap-rating[data-place-key], .tp-maps-link[data-place-key]')]
      .map(el => el.dataset.placeQuery || '')
      .filter(Boolean);
    if (queries.length) fetchRatings(queries);
  }

  async function fetchRatings(queries) {
    if (!placesUsable()) return;
    const { batches } = planPlacesLookup(queries, placesKnown);
    for (const batch of batches) {
      if (!placesUsable()) return;
      batch.forEach(m => placesInFlight.add(m.key));
      try {
        const done = await fetchRatingBatch(batch);
        if (!done) return; // endpoint is off or paused; leave the rest unasked
      } finally {
        batch.forEach(m => placesInFlight.delete(m.key));
      }
      paintPlaces(document);
    }
  }

  // Returns false when the caller should stop asking. Every failure path is
  // silent by design: no toast, no console noise, no empty star row.
  async function fetchRatingBatch(batch) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    let res;
    try {
      res = await fetch('/.netlify/functions/tp-places', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(placesRequestBody(batch)),
        signal: ctrl.signal,
      });
    } catch {
      placesPausedUntil = Date.now() + 60000; // offline or timed out: transient
      return false;
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      // 503 not_configured is the default state: the owner has no Places key,
      // so the feature switches itself off for the session and costs nothing.
      if (res.status === 503 || res.status === 403 || res.status === 400 || res.status === 405) placesOff = true;
      else placesPausedUntil = Date.now() + (res.status === 429 ? 3600000 : 60000);
      return false;
    }
    let data;
    try { data = await res.json(); } catch { return false; }
    for (const u of placesCacheUpdates(data && data.results)) placesCache.set(u.key, u.entry);
    return true;
  }

  // ---------- proposal machinery ----------
  // No save() happens on receive/render; only Accept writes to storage.
  function renderProposals(actions, container) {
    const trip = activeTrip();
    const valid = [];
    for (const action of actions) {
      const res = validateTripAction(action, trip);
      const pid = 'ap' + (++assistPropSeq);
      if (!res.ok) {
        const card = document.createElement('div');
        card.className = 'assist-proposal invalid';
        card.dataset.proposalId = pid;
        // Same anatomy as every other card: an op label, the sentence, then the
        // actions. Without the label it read as an untitled debug slab beside
        // the polished ADD / REMOVE / PICK ONE cards.
        card.innerHTML = `<div class="ap-op">Cannot apply</div>
          <div class="ap-reason">${esc(res.reason)}</div>
          <div class="ap-actions"><button type="button" class="btn assist-reject" data-act="reject-proposal">Dismiss</button></div>`;
        container.appendChild(card);
        continue;
      }
      assistActions.set(pid, action);
      // the proposal carries its own id so grouping can hand it back to us
      res.proposal.pid = pid;
      valid.push(res.proposal);
    }
    for (const entry of groupProposals(valid)) {
      container.appendChild(entry.type === 'set'
        ? alternativeSetCard(entry, trip)
        : proposalCard(entry.proposal.pid, entry.proposal, trip));
    }
    // One request for the whole reply, not one per card and never one per
    // candidate: a full day of proposals is 1-2 batched calls.
    hydrateRatings(container);
  }

  // A proposal card follows the same estimate rule as the timeline: a tilde and
  // no cents for a guess, every cent for a real price. displayCostOf decides
  // which this is, so an `update` to an item the traveller already paid for
  // shows their own $800, not "~$800". Empty string when there is nothing worth
  // showing (a typed 0 is a decision, not a price).
  function proposalCostStr(d, trip) {
    const shown = displayCostOf(d);
    if (!shown) return '';
    const { tilde, digits } = costDisplayParts(d);
    return tilde + (shown.currency ? fmtMoneyIn(shown.currency, shown.amount, digits) : fmtMoney(trip, shown.amount, digits));
  }

  // ---------- alternative sets ----------
  // Two or more adds sharing a `group` are one decision, not several: the
  // traveller picks at most one and the rest are discarded. Nothing is
  // preselected on purpose, a highlighted default reads as the model choosing.
  function setOptionHtml(p, name, trip) {
    const d = p.display;
    const meta = [
      isIsoDate(d.startDate) ? fmtDate(d.startDate) : '',
      d.startTime ? fmtTime(d.startTime) : '',
      proposalCostStr(d, trip),
    ].filter(Boolean).join(' · ');
    const raw = (p.fields && p.fields.details) || '';
    const detail = raw.split('\n')[0].slice(0, 140);
    const optId = 'aso-' + p.pid;
    return `
      <div class="as-opt">
        <label class="as-pick" for="${optId}">
          <input type="radio" id="${optId}" name="${name}" value="${esc(p.pid)}">
          <span class="as-body">
            <span class="as-title">${esc(d.title || '(no title)')}</span>
            ${meta ? `<span class="as-meta">${esc(meta)}</span>` : ''}
            ${detail ? `<span class="as-detail">${esc(detail)}</span>` : ''}
          </span>
        </label>
        ${ratingSlotHtml(d.mapsQuery)}
        ${assistMapsLinkHtml(d.mapsQuery)}
      </div>`;
  }

  function alternativeSetCard(entry, trip) {
    const card = document.createElement('div');
    card.className = 'assist-proposal assist-set';
    card.dataset.setGroup = entry.group;
    const name = 'apset-' + (++assistPropSeq);
    card.innerHTML = `
      <div class="ap-op">Pick one</div>
      <div class="as-lead">${entry.candidates.length} options for the same slot${entry.group ? ': ' + esc(entry.group) : ''}. Choose one, or skip the slot.</div>
      <div class="as-options" role="radiogroup" aria-label="Choose one option">
        ${entry.candidates.map(p => setOptionHtml(p, name, trip)).join('')}
      </div>
      <div class="ap-actions">
        <button type="button" class="btn primary assist-accept" data-act="accept-set" disabled>Add the one I picked</button>
        <button type="button" class="btn" data-act="skip-set">Skip this slot</button>
      </div>`;
    return card;
  }

  function setPids(card) {
    return [...card.querySelectorAll('input[type="radio"]')].map(r => r.value);
  }

  function proposalCard(pid, p, trip) {
    const d = p.display;
    const card = document.createElement('div');
    card.className = 'assist-proposal';
    card.dataset.op = p.op;
    card.dataset.proposalId = pid;
    const meta = [isIsoDate(d.startDate) ? fmtDate(d.startDate) : '', d.startTime ? fmtTime(d.startTime) : ''].filter(Boolean).join(' · ');
    const costStr = proposalCostStr(d, trip);
    const maps = assistMapsLinkHtml(d.mapsQuery);
    const acceptLabel = p.op === 'add' ? 'Add to trip' : (p.op === 'update' ? 'Apply change' : 'Remove from trip');
    const opWord = p.op === 'add' ? 'Add' : (p.op === 'update' ? 'Update' : 'Remove');
    // a destructive proposal takes the destructive button, not a green one
    const acceptCls = p.op === 'remove' ? 'btn danger' : 'btn primary';
    card.innerHTML = `
      <div class="ap-op">${opWord}</div>
      <div class="ap-title">${esc(d.title || '(no title)')}</div>
      ${meta ? `<div class="ap-meta">${esc(meta)}</div>` : ''}
      ${costStr ? `<div class="ap-cost">${esc(costStr)}</div>` : ''}
      ${ratingSlotHtml(d.mapsQuery)}
      ${maps}
      <div class="ap-actions">
        <button type="button" class="${acceptCls} assist-accept" data-act="accept-proposal">${acceptLabel}</button>
        <button type="button" class="btn assist-reject" data-act="reject-proposal">Dismiss</button>
      </div>`;
    return card;
  }

  // mapsQuery is a first-class item field. It used to be flattened into the
  // details text as a plain-text "Maps: https://..." line, which is exactly why
  // accepted suggestions lost their clickable link; keeping the field lets every
  // view render a real anchor.
  // A price the model supplied is a guess, so it lands in estCost and `cost`
  // stays empty: an accepted suggestion is visible everywhere but changes no
  // total until the traveller adopts the number in the edit modal.
  function proposalToItem(p, trip) {
    const f = p.fields;
    const est = f.cost != null ? f.cost : null;
    const item = {
      id: uid(), type: f.type, title: f.title, location: f.location || '',
      startDate: f.startDate, endDate: f.endDate || '',
      startTime: f.startTime || '', endTime: f.endTime || '',
      status: p.status, cost: null, costNote: f.costNote || '',
      details: String(f.details || '').slice(0, 500),
      createdAt: new Date().toISOString(),
    };
    if (f.mapsQuery) item.mapsQuery = f.mapsQuery;
    if (est != null) {
      item.estCost = est;
      item.estCostCurrency = f.costCurrency || (trip.currency || 'USD');
    }
    return item;
  }

  function applyProposalUpdate(it, p, trip) {
    const f = p.fields;
    for (const k of ['type', 'title', 'location', 'startDate', 'endDate', 'startTime', 'endTime', 'costNote']) {
      if (f[k] !== undefined) it[k] = f[k];
    }
    // the model's number never overwrites a price the traveller typed
    if (f.cost !== undefined) {
      it.estCost = f.cost;
      it.estCostCurrency = f.costCurrency || it.estCostCurrency || (trip.currency || 'USD');
    } else if (f.costCurrency !== undefined && it.estCost != null) {
      it.estCostCurrency = f.costCurrency;
    }
    if (f.details !== undefined) it.details = String(f.details).slice(0, 500);
    if (f.mapsQuery) it.mapsQuery = f.mapsQuery;
    it.status = p.status;
  }

  function markProposalStale(card) {
    card.classList.add('stale');
    card.innerHTML = '<div class="ap-reason">This item already changed, nothing applied.</div>';
  }
  function markProposalDone(card, op) {
    card.classList.remove('invalid');
    card.classList.add('done');
    const word = op === 'add' ? 'Added to your trip' : (op === 'update' ? 'Updated' : 'Removed');
    card.innerHTML = `<div class="ap-done">✓ ${word}</div>`;
  }

  // Enough to put a consumed card back if the accept is undone: the raw
  // actions (a pick-one card owns several) and the markup as it stood before
  // the card turned into a "done" stub.
  function assistCardSnapshot(card) {
    const pids = [card.dataset.proposalId, ...setPids(card)].filter(Boolean);
    const entries = pids.filter(p => assistActions.has(p)).map(p => [p, assistActions.get(p)]);
    const html = card.innerHTML;
    const cls = card.className;
    return () => {
      for (const [p, a] of entries) assistActions.set(p, a);
      card.className = cls;
      card.innerHTML = html;
      // The snapshot was taken with the traveller's pick already highlighted
      // and the accept button enabled, but re-parsing the HTML resets the
      // radios. Undo hands back a genuinely untouched card, so the highlight
      // and the enabled button go with them.
      card.querySelectorAll('.as-opt.picked').forEach(o => o.classList.remove('picked'));
      const acceptSet = card.querySelector('[data-act="accept-set"]');
      if (acceptSet) acceptSet.disabled = true;
    };
  }

  function acceptProposal(pid, card, restore) {
    const action = assistActions.get(pid);
    if (!action) return;
    const putCardBack = restore || assistCardSnapshot(card);
    const trip = activeTrip();
    const res = validateTripAction(action, trip); // re-validate against CURRENT state
    if (!res.ok) { assistActions.delete(pid); markProposalStale(card); return; }
    const p = res.proposal;
    if (p.op === 'add') {
      trip.items.push(proposalToItem(p, trip));
    } else if (p.op === 'update') {
      const it = trip.items.find(x => x.id === p.targetId);
      if (!it) { assistActions.delete(pid); markProposalStale(card); return; }
      applyProposalUpdate(it, p, trip);
    } else {
      const idx = trip.items.findIndex(x => x.id === p.targetId);
      if (idx < 0) { assistActions.delete(pid); markProposalStale(card); return; }
      trip.items.splice(idx, 1);
    }
    // the undo history covers the DATA via the save() choke point; the card is
    // not data, so its restore rides along on the same history entry
    const entry = lastSaved;
    save();
    if (undoPast[undoPast.length - 1] === entry) {
      assistUndo.set(entry, putCardBack);
      if (assistUndo.size > HISTORY_MAX) assistUndo.delete(assistUndo.keys().next().value);
    }
    render();
    assistActions.delete(pid);
    markProposalDone(card, p.op);
  }

  // ---------- overlays / toast ----------
  const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  let overlayReturnFocus = null;

  function topOverlay() {
    const open = document.querySelectorAll('.overlay.open');
    return open.length ? open[open.length - 1] : null;
  }
  function modalFocusables(overlay) {
    return [...overlay.querySelectorAll(FOCUSABLE)].filter(el => el.offsetParent !== null);
  }
  function openOverlay(sel) {
    if (!document.querySelector('.overlay.open')) overlayReturnFocus = document.activeElement;
    const o = $(sel);
    o.classList.add('open');
    document.body.classList.add('tp-modal-open');
    // a modal taller than the viewport gets scrolled into view on focus,
    // which buries its heading under the fixed site header
    o.querySelector('.modal').focus({ preventScroll: true });
  }
  function closeOverlays() {
    const wasOpen = document.querySelector('.overlay.open');
    if (wasOpen && wasOpen.id === 'itemOverlay') revokeDocUrls();
    document.querySelectorAll('.overlay.open').forEach(o => o.classList.remove('open'));
    document.body.classList.remove('tp-modal-open');
    ui.confirmAction = null;
    if (wasOpen && overlayReturnFocus && document.contains(overlayReturnFocus) && typeof overlayReturnFocus.focus === 'function') {
      overlayReturnFocus.focus();
    }
    overlayReturnFocus = null;
  }

  let lastDeleted = null;
  function toast(msg, undoFn) {
    const box = $('#toasts');
    const el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = `<span>${esc(msg)}</span>${undoFn ? '<button type="button">Undo</button>' : ''}`;
    if (undoFn) el.querySelector('button').addEventListener('click', () => { undoFn(); el.remove(); });
    box.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .4s'; setTimeout(() => el.remove(), 450); }, undoFn ? 6000 : 2600);
  }

  // ---------- events ----------
  $('#addBtn').addEventListener('click', () => openItemModal(null));
  $('#shiftTripBtn').addEventListener('click', () => openShiftModal(null));
  $('#routeBtn').addEventListener('click', () => openRouteModal('', ''));
  $('#visaBtn').addEventListener('click', openVisaModal);
  $('#assistBtn').addEventListener('click', () => openAssist(null));
  $('#assistCloseBtn').addEventListener('click', closeAssist);
  $('#assistMinBtn').addEventListener('click', () => {
    setAssistMinimized(!$('#assistPanel').classList.contains('is-min'));
    // Focus belongs on the control that was just used. Without this it can sit
    // wherever opening the panel left it (the Close button), so restoring and
    // pressing Enter out of habit closes the panel instead of doing nothing.
    $('#assistMinBtn').focus();
  });
  $('#assistTierGroup').addEventListener('change', e => {
    const r = e.target.closest('input[name="assistTier"]');
    if (r) setAssistTier(r.value);
  });
  $('#assistTierBody').addEventListener('click', e => {
    if (e.target.closest('#assistPasteParse')) handleAssistPaste();
    else if (e.target.closest('#assistKeySave')) handleKeySave();
    else if (e.target.closest('#assistKeyRemove')) handleKeyRemove();
  });
  $('#assistTierBody').addEventListener('change', e => {
    if (e.target.id === 'assistProviderSelect') setAssistProvider(e.target.value);
    else if (e.target.id === 'assistModelSelect') setAssistModel(e.target.value);
  });
  $('#assistSend').addEventListener('click', sendChat);
  $('#assistClearChat').addEventListener('click', clearChat);
  $('#assistInput').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
  });
  $('#assistInput').addEventListener('input', autoGrowInput);
  $('#assistSetupBar').addEventListener('click', e => {
    if (e.target.closest('#assistSetupChange')) setSetupCollapsed(false);
  });
  $('#assistFocusChip').addEventListener('click', e => {
    if (!e.target.closest('#assistFocusClear')) return;
    setAssistFocus(null);
  });
  $('#assistPlanner').addEventListener('click', onPlannerClick);
  $('#assistPlanner').addEventListener('input', onPlannerInput);
  $('#assistPlanner').addEventListener('change', onPlannerChange);
  // the review summary is a separate node from the picker, so it needs the same
  // click handler (Expand and the one primary action live there)
  $('#assistReview').addEventListener('click', onPlannerClick);
  $('#assistMessages').addEventListener('click', e => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const card = btn.closest('.assist-proposal');
    if (!card) return;
    const act = btn.dataset.act;
    if (act === 'accept-set') {
      const chosen = card.querySelector('input[type="radio"]:checked');
      if (!chosen) return;
      // the candidates that lost are dropped, so the whole picker is snapshotted
      // BEFORE that: undoing the accept has to bring the choice back, not one
      // orphaned option
      const putCardBack = assistCardSnapshot(card);
      for (const pid of setPids(card)) { if (pid !== chosen.value) assistActions.delete(pid); }
      acceptProposal(chosen.value, card, putCardBack);
      return;
    }
    if (act === 'skip-set') {
      for (const pid of setPids(card)) assistActions.delete(pid);
      card.remove();
      return;
    }
    const pid = card.dataset.proposalId;
    if (act === 'reject-proposal') { assistActions.delete(pid); card.remove(); }
    else if (act === 'accept-proposal') acceptProposal(pid, card);
  });
  $('#assistMessages').addEventListener('change', e => {
    const radio = e.target.closest('.assist-set input[type="radio"]');
    if (!radio) return;
    const card = radio.closest('.assist-proposal');
    card.querySelector('[data-act="accept-set"]').disabled = false;
    card.querySelectorAll('.as-opt').forEach(o => o.classList.toggle('picked', o.contains(radio)));
  });
  $('#daysList').addEventListener('click', e => {
    if (e.target.closest('[data-act="clear-filters"]')) { clearFilters(); return; }
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    if (btn.dataset.act === 'more') { toggleDetails(btn); return; }
    const act = btn.dataset.act, date = btn.dataset.date;
    if (act === 'ask-day') openAssist(date);
    else if (sharedMode) return;
    else if (act === 'add-day') openItemModal(null, date);
    else if (act === 'clear-day') clearDay(date);
    else if (act === 'edit') openItemModal(btn.dataset.id);
    else if (act === 'delete') deleteItem(btn.dataset.id);
  });
  $('#passportSel').addEventListener('change', () => {
    const v = $('#passportSel').value;
    if (v) localStorage.setItem(PASSPORT_KEY, v);
    // the traveller has now said it themselves: it is no longer an assumption
    passportGuess = null;
    renderPassportGuess();
    renderVisaRows();
  });
  $('#passportGuess').addEventListener('click', e => {
    if (!e.target.closest('.passport-change')) return;
    const sel = $('#passportSel');
    sel.focus();
    // Chrome/Edge can drop the list open from here; elsewhere focus is the tap
    if (typeof sel.showPicker === 'function') { try { sel.showPicker(); } catch { /* not permitted in every browser */ } }
  });
  $('#visaAddSel').addEventListener('change', () => {
    const cc = $('#visaAddSel').value;
    $('#visaAddSel').value = '';
    if (!cc) return;
    const trip = activeTrip();
    if (!Array.isArray(trip.visaExtras)) trip.visaExtras = [];
    if (!trip.visaExtras.includes(cc)) {
      trip.visaExtras.push(cc);
      save(`${regionName(cc)} added to the visa check`);
    }
    renderVisaRows();
  });
  $('#visaResults').addEventListener('click', e => {
    const rem = e.target.closest('button[data-remind-cc]');
    if (rem) { addVisaReminder(rem.dataset.remindName); return; }
    const btn = e.target.closest('button[data-remove-cc]');
    if (!btn) return;
    const trip = activeTrip();
    trip.visaExtras = (trip.visaExtras || []).filter(c => c !== btn.dataset.removeCc);
    save();
    renderVisaRows();
  });

  function addVisaReminder(country) {
    const trip = activeTrip();
    const title = `Apply for ${country} visa`;
    if (trip.items.some(it => it.title === title)) { toast('Reminder already added'); return; }
    const start = tripStats(trip).start;
    trip.items.push({
      id: uid(), type: 'note', title, status: 'to-book', location: country,
      startDate: isIsoDate(start) ? addDays(start, -30) : '',
      endDate: '', startTime: '', endTime: '', cost: null, costNote: '', details: '',
      createdAt: new Date().toISOString(),
    });
    save(`Reminder added: ${title}`);
    render();
    renderVisaRows();
  }
  $('#undoBtn').addEventListener('click', undo);
  $('#redoBtn').addEventListener('click', redo);
  $('#viewTimeline').addEventListener('click', () => { ui.view = 'timeline'; applyView(); });
  $('#viewDays').addEventListener('click', () => { ui.view = 'days'; applyView(); });
  $('#viewMap').addEventListener('click', () => { ui.view = 'map'; applyView(); });
  // Editing the fragment by hand, or a Back/Forward that lands on a different
  // one, syncs the view. Share payloads are handled at boot only.
  window.addEventListener('hashchange', () => {
    if (sharedMode) return;
    const parsed = viewFromHash(location.hash, ui.view);
    if (parsed.isShare) return;
    // A fragment that names no view (#nonsense) parses back to the view already
    // on screen, so returning here left the URL saying one thing and the app
    // showing another, and a reload then landed somewhere else entirely.
    // syncViewHash rewrites it either way.
    if (parsed.view === ui.view) { syncViewHash(); return; }
    ui.view = parsed.view;
    applyView();
  });
  $('#routeForm').addEventListener('submit', e => { e.preventDefault(); checkRoute(); });
  $('#routeSwap').addEventListener('click', () => {
    const a = $('#routeFrom').value;
    $('#routeFrom').value = $('#routeTo').value;
    $('#routeTo').value = a;
    updateRouteLinks();
    if ($('#routeFrom').value.trim() && $('#routeTo').value.trim()) checkRoute();
  });
  $('#routeFrom').addEventListener('input', () => updateRouteLinks());
  $('#routeTo').addEventListener('input', () => updateRouteLinks());
  $('#stripBox').addEventListener('click', e => {
    const cell = e.target.closest('[data-goto]');
    if (cell) { ui.view = 'timeline'; ui.flashId = cell.dataset.goto; render(); }
  });
  $('#itemForm').addEventListener('submit', submitItemForm);
  $('#docsAttachBtn').addEventListener('click', () => $('#inDocs').click());
  $('#inDocs').addEventListener('change', e => {
    const files = [...e.target.files];
    e.target.value = '';
    attachDocs(files);
  });
  $('#docsList').addEventListener('click', async e => {
    const btn = e.target.closest('button[data-doc-remove]');
    if (!btn || !ui.editingId) return;
    await deleteDoc(Number(btn.dataset.docRemove));
    await renderDocsList(ui.editingId);
    refreshDocIndicators();
    toast('Document removed');
  });
  $('#shiftForm').addEventListener('submit', submitShiftForm);
  $('#tripForm').addEventListener('submit', submitTripForm);
  $('#inTripName').addEventListener('input', syncTripNameHint);
  $('#typePicker').addEventListener('click', e => {
    const b = e.target.closest('button[data-type]');
    if (b) setModalType(b.dataset.type);
  });
  $('#inCostCurrency').addEventListener('change', syncCostPrefix);
  $('#costEstHint').addEventListener('click', e => {
    if (e.target.closest('#adoptEstBtn')) adoptEstimate();
  });
  $('#shiftMinus').addEventListener('click', () => { $('#shiftDays').value = (parseInt($('#shiftDays').value, 10) || 0) - 1; });
  $('#shiftPlus').addEventListener('click', () => { $('#shiftDays').value = (parseInt($('#shiftDays').value, 10) || 0) + 1; });

  $('#tripSelect').addEventListener('change', e => { db.activeTripId = e.target.value; save(); render(); });

  $('#tripMenuBtn').addEventListener('click', e => { e.stopPropagation(); $('#tripMenu').classList.toggle('open'); });
  document.addEventListener('click', () => $('#tripMenu').classList.remove('open'));
  $('#tripMenu').querySelector('.tp-menu-panel').addEventListener('click', e => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    $('#tripMenu').classList.remove('open');
    const act = b.dataset.act;
    // shared view is read-only: only the export/share actions are allowed
    if (sharedMode && !['export-trip', 'export-csv', 'export-ics', 'export-all', 'share-trip'].includes(act)) return;
    if (act === 'new-trip') openTripModal('new');
    else if (act === 'rename-trip') openTripModal('rename');
    else if (act === 'duplicate-trip') duplicateTrip();
    else if (act === 'export-trip') exportTrip();
    else if (act === 'export-csv') exportCsv();
    else if (act === 'export-ics') exportIcs();
    else if (act === 'export-all') exportAll();
    else if (act === 'share-trip') shareTrip();
    else if (act === 'import') $('#importFile').click();
    else if (act === 'timefmt') {
      use24h = !use24h;
      localStorage.setItem(TIMEFMT_KEY, use24h ? '24' : '12');
      syncTimefmtLabel();
      render();
      toast(use24h ? 'Times now shown as 24-hour' : 'Times now shown as 12-hour');
    }
    else if (act === 'delete-trip') {
      const t = activeTrip();
      confirmDialog('Delete this trip?', `"${t.name}" and its ${t.items.length} item(s) will be permanently deleted.`, 'Delete trip', () => {
        for (const it of t.items) deleteDocsForItem(it.id);
        db.trips = db.trips.filter(x => x.id !== t.id);
        db.activeTripId = db.trips.length ? db.trips[0].id : null;
        save(`Trip "${t.name}" deleted`); render();
      });
    }
  });

  $('#importFile').addEventListener('change', e => {
    if (e.target.files[0]) importJson(e.target.files[0]);
    e.target.value = '';
  });

  $('#confirmYes').addEventListener('click', () => {
    const fn = ui.confirmAction;
    closeOverlays();
    if (fn) fn();
  });

  ['searchBox', 'filterType', 'filterStatus'].forEach(id => {
    $('#' + id).addEventListener('input', () => {
      ui.search = $('#searchBox').value.trim();
      ui.filterType = $('#filterType').value;
      ui.filterStatus = $('#filterStatus').value;
      render();
    });
  });

  $('#issuesBox').addEventListener('click', e => {
    const a = e.target.closest('a[data-jump]');
    if (a) { ui.flashId = a.dataset.jump; render(); }
  });

  $('#board').addEventListener('click', e => {
    if (e.target.id === 'ratesRetryBtn') {
      lastRateAttempt = { base: '', at: 0 };
      ratesFailed = false;
      render();
      return;
    }
    if (e.target.closest('[data-act="clear-filters"]')) { clearFilters(); return; }
    const legBtn = e.target.closest('button[data-leg-from]');
    if (legBtn) { openRouteModal(legBtn.dataset.legFrom, legBtn.dataset.legTo, legBtn.dataset.legDate); return; }
    const toggle = e.target.closest('button[data-toggle]');
    if (toggle) { toggleNode(toggle); return; }
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    if (btn.dataset.act === 'more') { toggleDetails(btn); return; }
    const row = btn.closest('.tp-row');
    const id = row && row.dataset.id;
    if (!id) return;
    const trip = activeTrip();
    const it = trip.items.find(x => x.id === id);
    if (!it) return;
    const act = btn.dataset.act;
    if (act === 'ask-day') openAssist(btn.dataset.date || it.startDate);
    else if (act === 'edit') openItemModal(id);
    else if (act === 'shift-item') openShiftModal(id);
    else if (act === 'duplicate') {
      const copy = { ...it, id: uid(), createdAt: new Date().toISOString(), title: it.title + ' (copy)' };
      trip.items.push(copy);
      save('Item duplicated'); ui.flashId = copy.id; render();
    } else if (act === 'delete') deleteItem(id);
  });

  $('#board').addEventListener('change', e => {
    if (e.target.id === 'currencySel') {
      const trip = activeTrip();
      stampCostCurrencies(trip, trip.currency || 'USD');
      trip.currency = e.target.value;
      save(`Costs now shown in ${trip.currency} (${currencySymbol(trip.currency)}); amounts keep their entered currency and convert`);
      render();
      return;
    }
    const sel = e.target.closest('select[data-status-for]');
    if (!sel) return;
    const it = activeTrip().items.find(x => x.id === sel.dataset.statusFor);
    if (it) { it.status = sel.value; save(); render(); }
  });

  document.querySelectorAll('.overlay').forEach(o => {
    o.addEventListener('mousedown', e => { if (e.target === o) closeOverlays(); });
  });
  document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeOverlays));
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (document.querySelector('.overlay.open')) { closeOverlays(); return; }
      if (!$('#assistPanel').hidden) { closeAssist(); return; }
      return;
    }
    const top = topOverlay();
    if (top) {
      // trap Tab inside the open modal so focus never reaches the page behind it
      if (e.key === 'Tab') {
        const f = modalFocusables(top);
        if (!f.length) { e.preventDefault(); return; }
        const first = f[0], last = f[f.length - 1];
        const inside = f.includes(document.activeElement);
        if (e.shiftKey && (!inside || document.activeElement === first)) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && (!inside || document.activeElement === last)) { e.preventDefault(); first.focus(); }
      }
      return;
    }
    // undo/redo shortcuts; the overlay-trap above already returned when a
    // dialog is open, and form fields keep their native text undo
    if ((e.ctrlKey || e.metaKey) && !e.target.closest('input, textarea, select')) {
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
      if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); redo(); return; }
    }
    if ((e.key === 'n' || e.key === 'N') && !e.ctrlKey && !e.metaKey && !e.target.closest('input, textarea, select')) {
      openItemModal(null);
    }
  });

  // if focus still escapes the open modal (e.g. programmatically), pull it back in
  document.addEventListener('focusin', e => {
    const top = topOverlay();
    if (top && !top.contains(e.target)) {
      const f = modalFocusables(top);
      (f[0] || top.querySelector('.modal')).focus();
    }
  });

  // Live remote-update channel: the storage-sync layer fires
  // `localStorageSync` when another device's change lands in
  // localStorage. Reload state from disk and re-render; gate on
  // source === 'remote' so our own writes don't echo.
  window.addEventListener('localStorageSync', (e) => {
    if (sharedMode) return; // never let a remote change overwrite the shared view
    const key = e.detail && e.detail.key;
    if (typeof key !== 'string' || !key.startsWith('trip-planner:')) return;
    if (!e.detail || e.detail.source !== 'remote') return;
    if (key === LS_KEY) {
      db = loadDb();
      repairDb();
      ensureTrip();
      // a remote merge invalidates local history: undoing another
      // device's change from here would push a stale state back up
      undoPast.length = 0;
      undoFuture.length = 0;
      markSaved();
      render();
    } else if (key === TIMEFMT_KEY) {
      use24h = localStorage.getItem(TIMEFMT_KEY) === '24';
      syncTimefmtLabel();
      render();
    }
  });

  const buildTag = $('#buildTag');
  if (buildTag) buildTag.textContent = 'build ' + TP_BUILD;
  window.__TP_BUILD = TP_BUILD;

  // ---------- boot ----------
  // #itemForm is novalidate, so these attributes only shape the native picker;
  // the submit handler is what actually enforces DATE_MIN/DATE_MAX. Stamping
  // them from the same constants keeps the widget and the check in step, and
  // keeps the bounds out of the markup entirely.
  for (const id of ['#inStart', '#inEnd', '#inArrDate']) {
    $(id).min = DATE_MIN;
    $(id).max = DATE_MAX;
  }
  syncTimefmtLabel();
  repairDb();
  if (location.hash.startsWith(SHARE_PREFIX)) {
    enterSharedMode();
  } else {
    // Set before the first render so there is no flash of Timeline on a
    // "#map" deep link.
    ui.view = viewFromHash(location.hash, ui.view).view;
    ensureTrip();
    if (lastSaved === null) markSaved();
    render();
  }
})();
