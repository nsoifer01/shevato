'use strict';
(() => {

  /**
   * Analytics shim. Resolves window.shevatoAnalytics at call time because
   * /assets/js/analytics.js is deferred and this IIFE can run first, and
   * swallows everything so a tracking failure can never break a trip.
   * Nothing here may ever send trip contents: destinations, item names and
   * anything typed into Details are the user's travel plans.
   */
  function track(method, ...args) {
    try {
      const a = typeof window !== 'undefined' ? window.shevatoAnalytics : null;
      if (a && typeof a[method] === 'function') a[method](...args);
    } catch (e) {
      /* analytics must never break the app */
    }
  }

  // ---------- constants ----------
  // Shown at the bottom of the trip menu so a bug report can name the exact
  // build it came from. THE RULE: TP_BUILD must always equal the `?v=` on
  // js/app.js, in index.html and in sw.js's PRECACHE list alike. Bumping the
  // cache-buster without bumping this number is what made "build 31" outlive
  // v=32..38 and stop identifying anything.
  const TP_BUILD = 58;
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
  // the six-dot grip every list in every app uses for "drag me": drawn rather
  // than typed, because the ⠿ braille character renders as a box on Android
  const GRIP_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="9" cy="6" r="1.7"/><circle cx="15" cy="6" r="1.7"/><circle cx="9" cy="12" r="1.7"/><circle cx="15" cy="12" r="1.7"/><circle cx="9" cy="18" r="1.7"/><circle cx="15" cy="18" r="1.7"/></svg>';

  // Pure logic (dates, validation, coverage, stats, route math) lives in
  // js/trip-logic.js so the node:test suite can exercise it directly.
  const {
    isIsoDate, toUtc, diffDays, addDays, localDateIso,
    shiftFits, applyDayShift, firstItemDate, startDateShift,
    isStay, nights, sortKey, sortedItems, tripLegs,
    tieKey, reorderableIds, applyManualOrder, normalizeOrders, moveInTie, ORDER_MAX, stayPrefillForGap,
    nextUpEvent, defaultPackingItems,
    packingWho, packingRowsFor, packingProgress, packingRosterDrops, applyPackingRoster,
    tripAsTemplate,
    validateItem, coverageGaps, tripStats, overlappingTrips, MAX_TRIP_DAYS, DATE_MIN, DATE_MAX, isDateInRange,
    ISLANDISH, distKm, flagEmoji, compass, fmtDur, modeOptions,
    routeBadges, routeFlags, routeTips, routeLinks, modeLink, ROUTE_HONESTY,
    classifyGeoMatch, geoMatchNote, GEO_MATCH_RANK, GEO_MATCH_TEXT,
    foldPlace, rankPlaceResults,
    HOTEL_TAGS, rankHotelResults,
    airportIndex, airportLabel, airportDetail, searchAirports,
    flightTitleFromAirports, parseFlightAirports,
    extractBookings, parseIcsToProposals,
    classifyVisa, parseVisaMatrix, visaCountryUsable, visaUnconfirmedNames, visaVintageNote, passportExpiryStatus, slimTripForShare, hasFastRail, viewFromHash, hashForView,
    buildIcs, buildGpx, buildCsv, convertAmount, sumInCurrency, normalizeTravelers, travelerTotals,
    evenSplitAmounts, splitAmountsMatch, customSplitShares,
    settlements, costsByType, typeBarShares, cashNeeded,
    bytesToBase64url, base64urlToBytes,
    transportGaps, connectionWarnings, sameTimeCollisions, TIGHT_CONNECTION_MIN, tripPhase, isPastRow,
    bookingDeadlines, paceAdvisory,
    dayShareText, shareHostStay, weekStart, spendByWeek,
    dayCards, dayMorningCity, emptyDayNote, departureOrigin, suggestedPassport, passportAssumptionParts, defaultPlanDay, planDayGroups, overnightTransit,
    timelineGroups, mealKind, isFoodOrDrink, isLongDetails, mealTitlePrefixes, itemMapsQuery, displayTitle,
    weatherKey, summarizeClimate, weatherLine, weatherRange, pickMonthSamples, docGuard,
    FORECAST_DAYS, forecastEligible, forecastKey, forecastFresh, freshForecasts, summarizeForecast, forecastLine, forecastChipParts,
    extractTripActions, validateTripAction, buildAssistPackage, buildAssistSystemPrompt,
    buildPlanRequest, groupProposals, linkifySegments, parseMarkdown,
    placeCacheKey, planPlacesLookup, placesCacheUpdates, mapsSearchUrl, assistMapsLink, costDisplayParts,
    normalizeVenueCache, rememberVenue, placesLocationUpdates, pickVenueFeature,
    dayAnchor, dayDistanceChain, shortestRoute, routeStops, distanceChipLabel, distanceChipTitle, routeFooterText,
    hasEstimate, displayCostOf, parseMoney, roundMoney, budgetVerdict, refundParts,
    readBudgetRange, normalizeBudgetFrom, budgetFigure,
    matchSampleTrip, sampleTripOptions, buildSampleTrip,
  } = window.TripLogic;

  // ---------- state ----------
  let db = loadDb();
  const ui = { search: '', filterType: '', filterStatus: '', filterTraveler: '', packingFilter: '', editingId: null, shiftTarget: null, tripModalMode: 'new', confirmAction: null, flashId: null, view: 'timeline' };

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
  // Nothing else ever collected these: one sub-object per trip id accumulated
  // here forever, on the same localStorage budget save() runs out of.
  function dropCollapse(tripId) {
    if (!(tripId in collapseState)) return;
    delete collapseState[tripId];
    try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(collapseState)); } catch { /* best effort */ }
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
  // `outsideHistory` persists the change and moves the baseline with it, but
  // never files it as an Undo step. See ensureTrip: the app restoring its own
  // floor is not an edit the traveller made.
  function save(okMsg, undoFn, outsideHistory) {
    if (sharedMode) return false; // shared view never writes to storage
    let ok = true;
    try {
      const next = JSON.stringify(db);
      const key = historyKey();
      // The write lands FIRST. Booking the history before it did meant a
      // quota-exceeded setItem left the history believing this state was
      // stored when it never reached disk, so the next Undo reversed a change
      // that only ever existed in memory.
      localStorage.setItem(LS_KEY, next);
      if (!outsideHistory && lastSavedKey !== null && key !== lastSavedKey) {
        undoPast.push(lastSaved);
        if (undoPast.length > HISTORY_MAX) undoPast.shift();
        undoFuture.length = 0;
      }
      lastSaved = next;
      lastSavedKey = key;
    }
    catch (err) { ok = false; }
    setSaveFailed(!ok);
    if (ok && okMsg) toast(okMsg, undoFn ? undoThisSave(undoFn) : null);
    return ok;
  }

  // An Undo toast lives 6 seconds and its offer is to reverse THIS save, so it
  // has to go inert the moment anything else is saved: a stale toast was
  // reversing whatever edit the traveller made in between instead.
  // clearDay/bulkDelete/duplicateDay spell the same guard out inline because
  // they toast for themselves rather than through save().
  function undoThisSave(fn) {
    const snapshot = lastSaved;
    return () => { if (lastSaved === snapshot) fn(); };
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

  // Both stacks hold whole-db snapshots, so both are capped at HISTORY_MAX and
  // not just the one save() feeds. Each shift() drops the entry FURTHEST from
  // the current state (the oldest undo, the newest redo), which is the same
  // trade save() already makes: the steps nearest to hand always survive.
  function undo() {
    if (!undoPast.length) return;
    undoFuture.push(lastSaved);
    if (undoFuture.length > HISTORY_MAX) undoFuture.shift();
    const snapshot = undoPast.pop();
    restoreSnapshot(snapshot);
    syncDeletedChats();
    const restore = assistUndo.get(snapshot);
    if (restore) { assistUndo.delete(snapshot); restore(); }
    toast('Undone');
  }
  function redo() {
    if (!undoFuture.length) return;
    undoPast.push(lastSaved);
    if (undoPast.length > HISTORY_MAX) undoPast.shift();
    restoreSnapshot(undoFuture.pop());
    syncDeletedChats();
    toast('Redone');
  }
  function syncUndoButtons() {
    const u = $('#undoBtn'), r = $('#redoBtn');
    if (u) u.disabled = !undoPast.length;
    if (r) r.disabled = !undoFuture.length;
  }

  // Repair anything structurally broken (hand-edited storage, partial imports)
  // so one bad item can never take the whole app down.
  // A repair that changed something is WRITTEN BACK. It used to live in memory
  // only, so the fixed shape reached disk on whatever unrelated edit happened
  // next (or never), and the markSaved() right after boot made the UNrepaired
  // state the undo baseline: one Undo could hand the broken data back. Written
  // outsideHistory because the app straightening its own storage is
  // housekeeping, not an edit the traveller made and should have to undo.
  function repairDb(skipSave) {
    const before = historyKey();
    repairTrips();
    if (!skipSave && historyKey() !== before) save(null, null, true);
  }
  function repairTrips() {
    if (!Array.isArray(db.trips)) db.trips = [];
    db.trips = db.trips.filter(t => t && typeof t === 'object');
    for (const t of db.trips) {
      if (!t.id) t.id = uid();
      if (typeof t.name !== 'string' || !t.name) t.name = 'Untitled trip';
      if (!/^[A-Z]{3}$/.test(t.currency || '')) t.currency = 'USD';
      t.budget = parseMoney(t.budget).value;
      // the ceiling is the number everything reads, so only the optional lower
      // end is ever dropped here: junk, negative, above the ceiling, or a floor
      // left behind by a budget somebody since cleared
      const budgetFrom = normalizeBudgetFrom(t.budgetFrom, t.budget).value;
      if (budgetFrom != null) t.budgetFrom = budgetFrom;
      else delete t.budgetFrom;
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
        // the manual same-day position: a small whole number or nothing at all.
        // A "3" or a 1e9 out of hand-edited storage would sort as a string and
        // drag a row somewhere nobody put it.
        if (it.order != null && !(Number.isInteger(it.order) && it.order >= 0 && it.order < ORDER_MAX)) delete it.order;
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

  // Both repairs save outsideHistory. Auto-creating the fallback trip is the
  // app restoring its own floor, not something the traveller did, and as a
  // history step it competed with theirs: deleting the last trip saved the
  // empty db, then this render's ensureTrip saved a fresh "My trip" on top, so
  // Undo popped the empty state, ensureTrip immediately re-created a trip and
  // filed ANOTHER step. Every press produced one more blank trip and never the
  // trip that was deleted. Kept out of the history, the top of the stack stays
  // the deleted trip and one Undo brings it back.
  function ensureTrip() {
    if (!db.trips.length) {
      const t = { id: uid(), name: 'My trip', currency: 'USD', items: [] };
      db.trips.push(t);
      db.activeTripId = t.id;
      save(null, null, true);
    }
    if (!activeTrip()) { db.activeTripId = db.trips[0].id; save(null, null, true); }
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
  // The traveller's LOCAL date, not a UTC slice of the clock. See localDateIso:
  // the dates on the items are zone-less wall dates, so the countdown, the
  // past-row dimming, the booking deadlines and the Up-next chip all have to
  // agree with the calendar on the traveller's own wall.
  function todayIso() { return localDateIso(new Date()); }

  // ---------- money ----------
  // Every code Frankfurter (the ECB reference set ensureRates fetches) actually
  // publishes, so anything the traveller can pick is something the app can
  // convert. Alphabetical, because 31 codes is a list you scan rather than read.
  const CURRENCIES = [
    'AUD', 'BGN', 'BRL', 'CAD', 'CHF', 'CNY', 'CZK', 'DKK', 'EUR', 'GBP',
    'HKD', 'HUF', 'IDR', 'ILS', 'INR', 'ISK', 'JPY', 'KRW', 'MXN', 'MYR',
    'NOK', 'NZD', 'PHP', 'PLN', 'RON', 'SEK', 'SGD', 'THB', 'TRY', 'USD', 'ZAR',
  ];
  // The eight the planner shipped with, floated to the top of every picker: a
  // long alphabetical list buries USD under four codes nobody spends.
  const COMMON_CURRENCIES = ['USD', 'EUR', 'GBP', 'ILS', 'JPY', 'THB', 'CAD', 'AUD'];
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

  // CHF and BGN have no symbol convention, so narrowSymbol hands back the bare
  // code and "CHF (CHF)" reads like a bug. Those print the code on its own.
  function currencyLabel(code) {
    const sym = currencySymbol(code);
    return sym === code ? code : `${code} (${sym})`;
  }

  // ONE builder behind every currency picker (trip currency, item cost
  // currency, bulk reassign) so they can never drift apart. `extra` carries
  // codes this trip already stores that CURRENCIES does not (a hand-edited
  // import, a currency the ECB dropped): keeping them as options is what stops
  // opening a picker from silently rewriting the saved currency.
  function currencyOptionsFor(selected, extra) {
    const opt = c => `<option value="${c}"${c === selected ? ' selected' : ''}>${esc(currencyLabel(c))}</option>`;
    const common = new Set(COMMON_CURRENCIES);
    const known = new Set(CURRENCIES);
    const legacy = [...new Set(extra || [])].filter(c => c && !known.has(c));
    let html = `<optgroup label="Common">${COMMON_CURRENCIES.map(opt).join('')}</optgroup>`
      + `<optgroup label="All currencies">${CURRENCIES.filter(c => !common.has(c)).map(opt).join('')}</optgroup>`;
    if (legacy.length) html += `<optgroup label="Saved with this trip">${legacy.map(opt).join('')}</optgroup>`;
    return html;
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
    // Bound the request the same way the places lookup is (app.js fetchRatingBatch):
    // without this, a hung connection leaves ratesFetching true forever and the
    // "Fetching exchange rates..." note never clears. On abort the catch below
    // flips ratesFailed, so the note falls back to "Could not fetch..." instead.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    fetch('https://api.frankfurter.dev/v1/latest?from=' + encodeURIComponent(base), { signal: ctrl.signal })
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
      .finally(() => { clearTimeout(timer); ratesFetching = false; });
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
        // `bookId` marks a warning that ONE still-to-book item can answer, so the
        // panel can offer the status change beside it. Only this line and the
        // deadline below qualify: every other warning is about a clash between
        // two items or about nights, which booking something cannot fix.
        issues.push({ level: 'warn', text: `"${it.title}" is in the past but still marked "To book".`, ids: [it.id], bookId: it.id });
      }
    }

    // booking deadlines coming up (or already missed) on things still to book.
    // One line per item rather than a count: the whole point is knowing WHICH
    // booking needs an email today.
    for (const d of bookingDeadlines(items, todayIso())) {
      // a deadline landing on today is "today", not "0 days left": the countdown
      // wording only starts making sense from one day out
      const left = d.daysLeft === 0
        ? 'today'
        : `${d.daysLeft} ${d.daysLeft === 1 ? 'day' : 'days'} left`;
      const text = d.kind === 'passed'
        ? `${d.title}: booking deadline passed (${fmtDate(d.date)})`
        : `${d.title}: book by ${fmtDate(d.date)}, ${left}`;
      issues.push({ level: 'warn', text, ids: [d.id], bookId: d.id });
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

    // back-to-back legs that cannot hold: the second one leaves before the
    // first one lands, or so soon after that a small delay breaks the trip
    for (const c of connectionWarnings(items)) {
      const text = c.kind === 'impossible'
        ? `Impossible connection: "${c.toTitle}" leaves ${fmtDate(c.departDate)} at ${fmtTime(c.departTime)}, before "${c.fromTitle}" arrives (${fmtDate(c.arriveDate)} at ${fmtTime(c.arriveTime)}). Check both times.`
        : `Tight connection: only ${c.minutes} ${c.minutes === 1 ? 'minute' : 'minutes'} between "${c.fromTitle}" arriving (${fmtTime(c.arriveTime)}) and "${c.toTitle}" leaving (${fmtTime(c.departTime)}) on ${fmtDate(c.departDate)}. Under ${TIGHT_CONNECTION_MIN} minutes is easy to miss.`;
      issues.push({ level: 'warn', text, ids: [c.fromId, c.toId] });
    }

    // two things pencilled in for the exact same clock time. A pair can be
    // deliberate, so this only asks for a second look.
    for (const c of sameTimeCollisions(items)) {
      issues.push({
        level: 'warn',
        text: `Same time: "${c.aTitle}" and "${c.bTitle}" are both set for ${fmtDate(c.date)} at ${fmtTime(c.time)}. Worth a quick check in case one of them should move.`,
        ids: [c.aId, c.bId],
      });
    }

    // The one conflict that lives OUTSIDE this trip: another saved trip booked
    // over the same days. Computed against db.trips on every render from the
    // trip being shown, so opening either side of a clash names the other.
    // The other trip's name is the link: the same switch #tripSelect performs,
    // which deliberately leaves the current filters alone.
    for (const o of overlappingTrips(db.trips, trip.id)) {
      const name = o.name || '(untitled)';
      issues.push({
        level: 'warn',
        text: `Overlaps with another trip: "${name}" (${o.start === o.end ? fmtDate(o.start) : fmtRange(o.start, o.end)})`,
        ids: [],
        html: `Overlaps with another trip: "<button type="button" class="issue-jump" data-trip="${esc(o.id)}">${esc(name)}</button>"`
          + ` (${esc(o.start === o.end ? fmtDate(o.start) : fmtRange(o.start, o.end))})`,
      });
    }

    // Last, and the only line here that is not a problem: how fast the trip
    // moves. `kind: 'info'` keeps it out of the error/warning counts and gives
    // it its own tag, because nothing about it needs fixing - it is the
    // arithmetic on the stays, and what to do about it is the traveller's call.
    const pace = paceAdvisory(items);
    if (pace) {
      issues.push({
        level: 'info',
        kind: 'info',
        text: `Fast pace: ${pace.stays} stays averaging ${pace.avg.toFixed(1)} nights each.`,
        ids: [],
      });
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

  // The issue list render() last built. computeIssues is O(n^2) over stays (the
  // overlap check) and over timed items (sameTimeCollisions), and the day view
  // wants exactly the list that has just been computed, so it reads this rather
  // than paying for the whole pass a second time on every repaint. It cannot go
  // stale: every write to a trip goes through save() + render(), and setView -
  // the one applyView call outside render() - changes no data at all.
  let currentIssues = [];

  function render() {
    try {
      ensureTrip();
      renderTripSelect();
      const trip = activeTrip();
      ensureRates(trip);
      const issues = computeIssues(trip);
      currentIssues = issues;
      renderSummary(trip, issues);
      renderStrip(trip);
      renderIssues(issues);
      renderBoard(trip, issues);
      applyView();
      syncClearFilters();
      syncUndoButtons();
      refreshDocIndicators();
      syncAssistPanel();
      syncPackingModal();
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
    // An empty plan has nothing to draw on the day grid or the map: its whole
    // UI (the example loader) lives in the Timeline's empty state. So the two
    // tabs switch OFF rather than opening blank panels, and a view carried in
    // from before (deleting a trip while on #map, then loading an example)
    // is walked back to Timeline - the same landing submitTripForm already
    // picks for a brand-new trip. syncViewHash below rewrites the fragment.
    const t = activeTrip();
    const empty = !t || !t.items.length;
    if (empty && ui.view !== 'timeline') ui.view = 'timeline';
    for (const id of ['#viewDays', '#viewMap']) {
      const b = $(id);
      b.disabled = empty;
      b.title = empty ? 'Nothing to show yet: add an item first' : '';
    }
    const v = ui.view;
    $('#board').style.display = v === 'timeline' ? '' : 'none';
    $('#mapBox').classList.toggle('on', v === 'map');
    $('#daysBox').classList.toggle('on', v === 'days');
    // .on paints the tab; aria-selected is the same fact said out loud. They
    // are set together so the tablist can never claim a tab the eye disagrees
    // with (it used to claim nothing at all: three plain buttons under a
    // role="tablist" that had no tabs in it).
    for (const [id, on] of [['#viewTimeline', v === 'timeline'], ['#viewDays', v === 'days'], ['#viewMap', v === 'map']]) {
      const b = $(id);
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    }
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
      // A jumpable night is a real button: reachable by Tab, named by the same
      // sentence the hover tooltip shows, and operated by Enter/Space. A night
      // with nothing to jump to stays exactly as inert as it looks, so tabbing
      // through the strip stops only where a stop actually does something.
      const jump = id ? ` data-goto="${id}" tabindex="0" role="button" aria-label="${esc(tip)}"` : '';
      // the night each cell stands for, so the gap warning's "show" can light up
      // exactly the nights it is talking about
      cells.push(`<div class="cell ${cls}" data-date="${d}" title="${esc(tip)}"${jump}></div>`);
    }
    $('#strip').innerHTML = cells.join('');
    const nightWord = n => `${n} ${n === 1 ? 'night' : 'nights'}`;
    const strapline = s.spanCapped ? `first ${nightWord(cells.length)}` : nightWord(s.totalTripNights);
    $('#stripDates').innerHTML = `<span>${fmtDate(s.start)}</span><span>${strapline}</span><span>${fmtDate(s.spanCapped ? s.renderEnd : s.end)}</span>`;
  }

  // Chrome sizes a select's native popup to its longest option text with an
  // inset on the LEFT only, so a long name ("Netherlands (Amsterdam and
  // Rotterdam)") ends flush against the popup's right edge - and no CSS
  // reliably reaches that popup. Two no-break spaces ON the option text are
  // measured into the popup's width and become the missing right padding;
  // the closed box never shows them (short names end before them, long names
  // ellipsize inside the box's own padding first).
  const OPTION_PAD = '  ';

  function renderTripSelect() {
    const sel = $('#tripSelect');
    sel.innerHTML = db.trips.map(t => `<option value="${t.id}" ${t.id === db.activeTripId ? 'selected' : ''}>${esc(t.name)}${OPTION_PAD}</option>`).join('');
    // Truncation contract: anything this app clips must be recoverable on hover
    // or long-press, the same way the day-card city chips already are. The
    // select clips at 260px, so it carries the full name as its own title.
    const active = db.trips.find(t => t.id === db.activeTripId);
    sel.title = active ? active.name : '';
    // A11: shared mode used to block this with pointer-events only, which stops
    // the mouse and nothing else - it stayed in the tab order and changed with
    // the arrow keys. That it broke nothing was luck (a shared db holds exactly
    // one trip), so it is disabled here like every other blocked control.
    sel.disabled = sharedMode;
  }

  function renderSummary(trip, issues) {
    const s = tripStats(trip);
    const money = tripMoney(trip);
    const chips = [];
    // FIRST chip when it exists at all: what is happening now, or the next
    // thing with a real clock time on it. It is the one number on this bar that
    // changes while you are looking at it, so nextUpTick repaints it.
    const up = nextUpEvent(trip.items, nowStamp());
    nextUpKey = upKey(up);
    if (up) {
      const dur = up.mode === 'next' ? ` <small>in ${esc(up.dur)}</small>` : '';
      chips.push(`<button type="button" class="chip nextup-chip" data-nextup="${esc(up.id)}" title="${esc(up.title)}">`
        + `<span class="k">${up.mode === 'now' ? 'Now' : 'Up next'}</span>`
        + `<span class="v"><span class="nu-title">${esc(up.title)}</span>${dur}</span></button>`);
    }
    if (s.start && s.end) {
      chips.push(chip('Dates', s.start === s.end ? fmtDate(s.start) : fmtRange(s.start, s.end)));
      const days = diffDays(s.start, s.end) + 1;
      chips.push(chip('Length', `${days} ${days === 1 ? 'day' : 'days'} <small>/ ${s.totalTripNights} ${s.totalTripNights === 1 ? 'night' : 'nights'}</small>`));
      const phase = tripPhase(s.start, s.end, todayIso());
      if (phase.phase === 'before') {
        const until = diffDays(todayIso(), s.start);
        if (until > 0) chips.push(chip('Countdown', `${until} day${until === 1 ? '' : 's'} to go`));
      } else if (phase.phase === 'during') {
        chips.push(chip('Progress', `Day ${phase.dayNumber} <small>of ${phase.totalDays}</small>`, 'ok-chip', phase.dayNumber / phase.totalDays));
      } else {
        chips.push(chip('Status', 'Trip completed'));
      }
    }
    if (s.totalTripNights > 0) {
      const cls = s.bookedNights >= s.totalTripNights ? 'ok-chip' : '';
      chips.push(chip('Nights booked', `${s.bookedNights} <small>of ${s.totalTripNights}</small>`, cls, s.bookedNights / s.totalTripNights));
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
      // A budget can be a range, and its TOP is trip.budget, so the verdict and
      // the bar are unchanged: only the figure the chip prints gains a lower
      // end, and only on a trip that set one.
      const figure = budgetFigure(trip.budgetFrom, trip.budget, n => fmtMoney(trip, n));
      // 'refund' means refunds outweigh spend so far. It is not a warning, and
      // "of $3,000" is meaningless against it, so the chip says what happened.
      const body = verdict === 'refund'
        ? `${moneyHtml(trip, money.confirmed.total, undefined, 'total')} <small>budget ${esc(figure)}</small>`
        : `${esc(fmtMoney(trip, money.confirmed.total))} <small>of ${esc(figure)}</small>`;
      chips.push(chip('Budget', body + short(missing), (verdict === 'ok' || verdict === 'refund') ? 'ok-chip' : 'warn-chip', spentShare(money.confirmed.total, trip.budget)));
    }
    // Problems only: an info line (the pace note) is an observation, so counting
    // it here would put a trip with nothing wrong on an amber "Issues 1" chip
    // and send the traveller into the panel looking for the problem.
    const warnCount = issues.filter(i => i.kind !== 'info').length;
    chips.push(chip('Issues', warnCount ? String(warnCount) : 'None', warnCount ? 'warn-chip' : 'ok-chip'));
    $('#summary').innerHTML = chips.join('');
  }
  // How much of the budget is gone, as a fraction the bar can draw. Clamped at
  // both ends: over budget the bar is full (the amber chip already says by how
  // much, and a bar past its own track says nothing), and on a refund the net
  // is negative, which is 0% spent rather than a bar running backwards.
  function spentShare(total, budget) {
    const b = Number(budget);
    if (!(b > 0)) return 0;
    return Math.max(0, Math.min(1, Number(total) / b));
  }
  // The optional fourth argument is a ratio the chip's own text ALREADY states,
  // drawn with the same bar the Cost-by-type rows use. It is never a new number:
  // a chip with nothing to be a part of gets no bar and stays byte-identical.
  const chip = (k, v, cls = '', ratio = null) => `<div class="chip ${cls}${ratio == null ? '' : ' has-bar'}">`
    + `<div class="k">${k}</div><div class="v">${v}</div>`
    + (ratio == null ? '' : `<span class="tt-bar" aria-hidden="true"><i style="width:${(Math.max(0, Math.min(1, ratio)) * 100).toFixed(2)}%"></i></span>`)
    + `</div>`;

  function renderIssues(issues) {
    const box = $('#issuesBox');
    // Cleared, not just hidden: a stale "Add stay"/"show" button left behind
    // here would still answer a click (wrong gap index, or an index that no
    // longer exists) if the box were ever unhidden again with no fresh
    // computeIssues() call in between, e.g. a script or extension reading
    // #issuesList directly while the box sits hidden between issue-free
    // renders.
    if (!issues.length) { box.hidden = true; $('#issuesList').innerHTML = ''; return; }
    box.hidden = false;
    // The counts are a to-do list, so an info line is never in them: it names
    // nothing to fix, and folding it into "3 warnings" would send the traveller
    // hunting for a third problem that does not exist. It is counted and named
    // separately instead, and a panel holding nothing else drops the warning
    // triangle with it.
    const errs = issues.filter(i => i.level === 'error').length;
    const notes = issues.filter(i => i.kind === 'info').length;
    const warns = issues.length - errs - notes;
    const parts = [];
    if (errs) parts.push(`<span class="count-err">${errs} error${errs === 1 ? '' : 's'}</span>`);
    if (warns) parts.push(`<span class="count-warn">${warns} warning${warns === 1 ? '' : 's'}</span>`);
    if (notes) parts.push(`<span class="count-note">${notes} note${notes === 1 ? '' : 's'}</span>`);
    $('#issuesSummary').innerHTML =
      `<span>${errs || warns ? '⚠️' : 'ℹ️'}</span><span>` + parts.join(' · ') +
      `</span><span style="color:var(--text-dim);font-weight:400;font-size:13px">(click to review)</span>`;
    // Both jump controls - "show" here and the other trip's name inside
    // iss.html - are <button>, not <a>. They navigate inside the app rather
    // than to a URL, so as href-less anchors they were unfocusable: neither
    // could be reached with Tab or fired with Enter.
    $('#issuesList').innerHTML = issues.map((iss, idx) => {
      // A gap warning names NIGHTS, not an item, so it never had an id to jump
      // to: its "show" lights up the very cells the night strip is already
      // drawing for those nights. "Add stay" then opens the Add-item form on
      // exactly that range (see stayPrefillForGap), which is the retyping this
      // panel used to leave to the traveller. Both are owner-only: a read-only
      // shared view can add nothing, so it is offered nothing.
      const acts = [];
      if (iss.ids.length) acts.push(`<button type="button" class="issue-jump" data-jump="${esc(iss.ids[0])}">show</button>`);
      else if (iss.gap) acts.push(`<button type="button" class="issue-jump" data-gap-show="${idx}">show</button>`);
      if (iss.gap && !sharedMode && stayPrefillForGap(iss.gap)) {
        acts.push(`<button type="button" class="issue-jump issue-add-stay" data-add-stay="${idx}">Add stay</button>`);
      }
      // A warning about ONE item still marked "To book" can be answered without
      // leaving the panel: same status write the Timeline row's <select> makes,
      // so it is one undo step, and the warning is gone from the next render
      // because the item no longer qualifies for it. Owner-only, like "Add
      // stay": a read-only visitor changes nothing. It carries .issue-jump so
      // main.css's button rules stay pinned exactly as they are for "show".
      if (iss.bookId && !sharedMode) {
        acts.push(`<button type="button" class="issue-jump issue-mark-booked" data-book-id="${esc(iss.bookId)}">Mark booked</button>`);
      }
      const tag = iss.kind === 'info' ? ['info', 'INFO'] : iss.level === 'error' ? ['err', 'ERROR'] : ['warn', 'WARN'];
      return `
      <li>
        <span class="tag ${tag[0]}">${tag[1]}</span>
        <span>${iss.html || esc(iss.text)}${acts.length ? ' ' + acts.join(' · ') : ''}</span>
      </li>`;
    }).join('');
  }

  // "show" on a gap warning: the nights it names, lit in the strip that already
  // draws them. There is no row to flash (that is the whole point of the
  // warning), so the highlight is temporary and clears itself rather than
  // leaving a second, permanent-looking state on the strip.
  let gapFlashTimer = null;
  function flashGapNights(gap) {
    const box = $('#stripBox');
    if (!gap || !box || box.hidden) return;
    const cells = [...$('#strip').children];
    for (const cell of cells) {
      const d = cell.dataset.date;
      cell.classList.toggle('is-flash', !!d && d >= gap.start && d < gap.end);
    }
    box.scrollIntoView({ block: 'center', behavior: 'smooth' });
    clearTimeout(gapFlashTimer);
    gapFlashTimer = setTimeout(() => {
      for (const cell of [...$('#strip').children]) cell.classList.remove('is-flash');
    }, 2600);
  }

  const filtersActive = () => !!(ui.search || ui.filterType || ui.filterStatus || ui.filterTraveler);

  function matchesFilters(it) {
    if (ui.filterType && it.type !== ui.filterType) return false;
    if (ui.filterStatus && it.status !== ui.filterStatus) return false;
    // "Show me only Sam's day". An item assigned to nobody is Everyone's, so it
    // stays visible under every name: the same reading of an empty `travelers`
    // that travelerTotals uses to split a cost across the whole trip. This only
    // decides which ROWS are drawn; the strip, the warnings and every total are
    // computed from the whole trip and are untouched by it.
    if (ui.filterTraveler) {
      const who = Array.isArray(it.travelers) ? it.travelers : [];
      const want = ui.filterTraveler.toLowerCase();
      if (who.length && !who.some(n => String(n == null ? '' : n).trim().toLowerCase() === want)) return false;
    }
    if (ui.search) {
      const q = ui.search.toLowerCase();
      // the confirmation code is searchable too: pasting the code out of an
      // email is the fastest way to find the booking it belongs to
      const hay = `${it.title} ${it.location || ''} ${it.details || ''} ${it.confirmation || ''}`.toLowerCase();
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
    // the traveller select only exists on a trip that names two or more, so it
    // is cleared through the state and repainted by syncTravelerFilter
    const tv = $('#filterTraveler');
    if (tv) tv.value = '';
    ui.search = ''; ui.filterType = ''; ui.filterStatus = ''; ui.filterTraveler = '';
    // clearing only ever REVEALS rows, so there is nothing to prune and no
    // reason to drop the mode - the same contract as the filter listeners
    render();
  }

  // The toolbar's own way out, next to the controls that caused the filtering.
  // The board's clear buttons only appear once something has been hidden
  // ENTIRELY (Timeline) or partly (Days), so a filter still showing rows, and
  // any filter at all while the Map is up, left no reset on screen. This one is
  // tied to the filters themselves, not to what they happened to hide, and it
  // calls the same clearFilters() the board's buttons do.
  function syncClearFilters() {
    $('#clearFiltersBtn').hidden = !filtersActive();
  }

  // The "Filter by traveller" select is BUILT, not hidden: a trip that names
  // fewer than two people has no such control in the DOM at all, exactly as its
  // item modal has no "Who's this for" fieldset. Rebuilt only when the roster
  // itself changes, so choosing a name (which re-renders) does not yank the
  // focus out of the select the traveller is still using.
  //
  // It also guards the stranding case: switching to a trip that does not name
  // the person currently filtered would otherwise leave a filter nothing on
  // screen can see, silently hiding rows. The stale name is dropped here,
  // before anything is drawn from it.
  function syncTravelerFilter(trip) {
    const wrap = $('#travelerFilterWrap');
    const names = normalizeTravelers(trip.travelers);
    if (names.length < 2) {
      ui.filterTraveler = '';
      if (wrap.dataset.names !== '') { wrap.innerHTML = ''; wrap.dataset.names = ''; }
      return;
    }
    if (ui.filterTraveler && !names.includes(ui.filterTraveler)) ui.filterTraveler = '';
    const sig = JSON.stringify(names);
    if (wrap.dataset.names !== sig) {
      wrap.innerHTML = `<select id="filterTraveler" class="tb-traveler-sel" aria-label="Filter by traveler">`
        + `<option value="">Everyone</option>`
        + names.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('')
        + `</select>`;
      wrap.dataset.names = sig;
    }
    $('#filterTraveler').value = ui.filterTraveler;
  }

  // item id -> highest issue severity ('error' beats 'warn'). Both the timeline
  // and the day view colour their rows from this same map, so a flagged item
  // reads the same in either view.
  function buildIssueById(issues) {
    const map = {};
    for (const iss of issues) for (const id of iss.ids) {
      map[id] = map[id] === 'error' ? 'error' : iss.level;
    }
    return map;
  }

  // ---------- bulk selection ----------
  // Which rows are ticked is VIEW state, like the collapse map: it never
  // reaches save(), so it can never land in undo. renderBoard prunes it down to
  // the rows it actually drew, which is what keeps a bulk action honest - a
  // filter change, a trip switch or a remote update can never leave the bar
  // pointed at rows nobody on screen can see.
  let selMode = false;
  const selIds = new Set();
  // every id the last render drew, in board order, nested rows included: what
  // "Select all" means and what the "{n} selected" count is measured against
  let selVisible = [];

  function exitSelectMode() {
    selMode = false;
    selIds.clear();
  }

  // The toolbar toggle and the bulk bar, brought in line with the rows the
  // board just drew. Called from both of renderBoard's exits, so an empty trip
  // and a filtered-to-nothing trip are handled by the same code.
  function syncSelectUi(visibleIds) {
    selVisible = visibleIds;
    // Moving the filters moves which rows exist, so the selection is PRUNED to
    // what the board just drew rather than torn down: a filter is transient,
    // and dropping the mode as you type means re-entering it by hand once the
    // search is right. An id the filters hid is forgotten outright - never
    // silently re-pointed at a row the traveller cannot see - so a bulk action
    // can only ever reach what is on screen.
    if (selMode && selIds.size) {
      const drawn = new Set(visibleIds);
      for (const id of selIds) if (!drawn.has(id)) selIds.delete(id);
    }
    const btn = $('#selectBtn');
    btn.textContent = selMode ? 'Cancel select' : 'Select items';
    btn.classList.toggle('on', selMode);
    btn.setAttribute('aria-pressed', String(selMode));
    // an empty trip keeps the button, disabled: a control that disappears is a
    // feature the traveller has to rediscover
    btn.disabled = sharedMode || !activeTrip().items.length;
    let bar = $('#bulkBar');
    if (!selMode) { if (bar) bar.remove(); return; }
    if (!bar) bar = buildBulkBar();
    const n = selIds.size;
    // Filters can hide every row while the mode stays on - only an empty TRIP
    // exits it - so the bar sat over "No items match" reading "0 selected" with
    // a Select all that ticked nothing. The mode is KEPT (a filter is a
    // transient thing to undo, and turning the mode off as you type a search
    // that momentarily matches nothing means re-entering it by hand once you
    // fix the search) and the bar says why it has nothing to work with instead.
    const nothingToSelect = !visibleIds.length;
    bar.classList.toggle('is-empty', nothingToSelect);
    $('#bulkCount').textContent = nothingToSelect
      ? 'Nothing to select: the filters are hiding every item'
      : `${n} selected`;
    const all = $('#bulkAll');
    all.checked = !nothingToSelect && n === visibleIds.length;
    all.indeterminate = n > 0 && n < visibleIds.length;
    all.disabled = nothingToSelect;
    // nothing ticked means nothing to act on, so the actions are dead
    // rather than silently doing nothing
    $('#bulkStatus').disabled = !n;
    $('#bulkStatus').value = '';
    $('#bulkCurrency').disabled = !n;
    $('#bulkCurrency').value = '';
    $('#bulkDelete').disabled = !n;
  }

  function buildBulkBar() {
    const bar = document.createElement('div');
    bar.className = 'bulk-bar';
    bar.id = 'bulkBar';
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', 'Bulk actions');
    bar.innerHTML = `
      <label class="bulk-all"><input type="checkbox" id="bulkAll"><span>Select all</span></label>
      <span class="bulk-count" id="bulkCount">0 selected</span>
      <select class="bulk-status" id="bulkStatus" aria-label="Set the status of the selected items">
        <option value="">Set status</option>
        ${Object.entries(STATUS_META).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('')}
      </select>
      <!-- .bulk-status carries the colour and sizing pins that hold main.css off
           this select; the inline margin only undoes that class's margin-left:auto,
           which would otherwise split the row between the two pickers -->
      <select class="bulk-status bulk-cur" id="bulkCurrency" aria-label="Set the cost currency of the selected items" style="margin-left:0">
        <option value="">Set currency</option>
        ${currencyOptionsFor(null, [activeTrip().currency])}
      </select>
      <button type="button" class="btn danger bulk-del" id="bulkDelete">Delete selected</button>`;
    const board = $('#board');
    board.parentNode.insertBefore(bar, board);
    $('#bulkAll').addEventListener('change', e => {
      selIds.clear();
      // only what the filters are showing: ticking "all" must never reach a row
      // the traveller cannot see
      if (e.target.checked) for (const id of selVisible) selIds.add(id);
      render();
    });
    $('#bulkStatus').addEventListener('change', e => bulkStatus(e.target.value));
    $('#bulkCurrency').addEventListener('change', e => bulkSetCurrency(e.target.value));
    $('#bulkDelete').addEventListener('click', bulkDelete);
    return bar;
  }

  // ONE save() for the whole batch, so the whole batch is ONE undo step. A row
  // that already has the target status is written anyway: refusing part of a
  // batch is how a bulk action becomes untrustworthy.
  function bulkStatus(status) {
    if (!status || !selIds.size) return;
    const trip = activeTrip();
    const n = selIds.size;
    for (const it of trip.items) if (selIds.has(it.id)) it.status = status;
    save(`${n} item${n === 1 ? '' : 's'} set to ${STATUS_META[status].label}`);
    render();
  }

  // Same ONE save() per batch as bulkStatus, so the whole selection is ONE undo
  // step. This RELABELS the money, it never converts it: the traveller is
  // saying "these were always baht", so 1200 stays 1200 and the totals convert
  // it from the new currency. A row with no cost is skipped rather than
  // stamped, because a costCurrency without a cost is a currency for money that
  // does not exist.
  function bulkSetCurrency(code) {
    if (!code || !selIds.size) return;
    const trip = activeTrip();
    let n = 0;
    for (const it of trip.items) {
      if (!selIds.has(it.id) || it.cost == null || it.cost === '') continue;
      it.costCurrency = code;
      n++;
    }
    if (!n) { toast('None of the selected items have a cost'); render(); return; }
    save(`${n} item${n === 1 ? '' : 's'} set to ${code}`);
    render();
  }

  function bulkDelete() {
    const trip = activeTrip();
    const doomed = trip.items.filter(it => selIds.has(it.id));
    if (!doomed.length) return;
    // one ticked row is a single delete: it goes through deleteItem, so the
    // confirm reads "Delete this stay?" like every other single delete in the
    // app rather than "Delete 1 items?"
    if (doomed.length === 1) { deleteItem(doomed[0].id); return; }
    const n = doomed.length;
    const label = `${n} items`;
    const stays = doomed.filter(isStay);
    const notes = ['The selected items will be permanently deleted.'];
    if (stays.length) {
      notes.push(`This includes ${stays.length === 1 ? 'a stay' : `${stays.length} stays`} (${stays.map(s => s.title).join(', ')}), so those nights lose their booking.`);
    }
    if (doomed.some(it => (docCounts.get(it.id) || 0) > 0)) notes.push('Attached documents cannot be recovered.');
    confirmDialog(`Delete ${n} items?`, notes.join(' '), `Delete ${label}`, () => {
      const ids = new Set(doomed.map(it => it.id));
      for (const id of ids) { if ((docCounts.get(id) || 0) > 0) deleteDocsForItem(id); }
      trip.items = trip.items.filter(it => !ids.has(it.id));
      const ok = save();
      const snapshot = lastSaved;
      render();
      if (ok) toast(`Deleted ${label}`, () => {
        // only safe while ours is still the newest snapshot; anything saved
        // since would be what undo() actually reverses
        if (lastSaved === snapshot) undo();
      });
    });
  }

  // The trip currency is offered in two places (the totals bar, and the empty
  // state that exists precisely when there is no totals bar), and both must
  // list the same thing: a trip already saved in a currency CURRENCIES does not
  // carry has to keep it as an option or picking anything would lose it.
  function currencyOptionsHtml(trip) {
    const cur = trip.currency || 'USD';
    return currencyOptionsFor(cur, [cur]);
  }

  function renderBoard(trip, issues) {
    const board = $('#board');
    // ahead of the first matchesFilters call of this render, and ahead of the
    // day view (applyView runs after this), so neither can read a traveller
    // filter this trip's roster no longer supports
    syncTravelerFilter(trip);
    const items = sortedItems(trip);
    // nothing to select: the mode cannot survive the last item leaving
    if (!items.length) exitSelectMode();

    if (!items.length) {
      // The dropdown starts on whatever the trip's own name points at, so
      // naming a trip "Tokyo 2027" and hitting the button just works.
      const picked = matchSampleTrip(trip.name) || sampleTripOptions()[0].id;
      const opts = sampleTripOptions()
        .map(o => `<option value="${esc(o.id)}"${o.id === picked ? ' selected' : ''}>${esc(o.label)}${OPTION_PAD}</option>`).join('');
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
          <p class="empty-currency">
            <label for="currencySel">Costs in</label>
            <span class="sel-wrap">
              <select id="currencySel" class="empty-currency-sel" ${sharedMode ? 'disabled' : ''}>${currencyOptionsHtml(trip)}</select>
            </span>
          </p>
          <p class="sample-note">Examples are illustrative sample data: rough round costs, not quotes or live availability.</p>
        </div>`;
      $('#emptyAdd').addEventListener('click', () => openItemModal(null));
      $('#emptySample').addEventListener('click', () => loadSample($('#emptySampleDest').value));
      syncSelectUi([]);
      return;
    }

    const issueById = buildIssueById(issues);
    // Gap banners describe the WHOLE trip, not the filtered subset, so a live
    // filter takes them off the board entirely. They were emitted for the nodes
    // the filter skipped and every unrendered one was dumped after the loop, so
    // a search matching nothing drew "3 nights without a stay" directly above
    // "No items match the current search and filters". The gaps are unaffected
    // by filters and still read in full from the Issues panel.
    const gaps = filtersActive() ? [] : issues.filter(i => i.gap).map(i => i.gap);
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
    // Every row the board DRAWS is selectable, nested activities included: a
    // booking spree is exactly the kind of thing folded inside a stay, so
    // leaving those out made "Select all" quietly incomplete. The rule is the
    // same at both levels - a row is selectable exactly when it matches the
    // filters itself, so "has a checkbox", "counts in Select all" and "can be
    // acted on" stay the same set. A stay that is drawn only because something
    // inside it matches still gets NO checkbox of its own.
    const selectableIds = [];

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
      // in board order, so "Select all" reads top to bottom: the stay, then the
      // rows folded under it. Parent and child are independent picks - ticking
      // a stay never reaches inside it, and ticking every child never ticks it.
      if (selfMatch) selectableIds.push(it.id);
      if (node.kind === 'stay') for (const k of kidMatches) selectableIds.push(k.id);

      // gap banner rendered right before the first node at/after the gap start
      for (const g of gaps) {
        if (!g.rendered && it.startDate >= g.start) { html += gapHtml(g); g.rendered = true; }
      }
      const leg = legsByToId[it.id];
      if (leg) {
        html += `<div class="leg-row"><button class="leg-btn" data-leg-from="${esc(leg.from)}" data-leg-to="${esc(leg.to)}" data-leg-date="${esc(leg.date)}">🧭 ${esc(leg.from)} → ${esc(leg.to)} · how to get there?</button></div>`;
      }
      const pickable = selMode && selfMatch;
      html += node.kind === 'stay'
        ? stayNodeHtml(node, kidMatches, ctx, pickable)
        : `<div class="tl-node">${rowHtml(trip, it, issueById[it.id], ctx.during && isPastRow(it, today), pickable)}</div>`;
    }
    // prune to what was actually drawn, so a selection can never outlive the
    // rows it was made from
    for (const id of [...selIds]) if (!selectableIds.includes(id)) selIds.delete(id);
    for (const g of gaps) {
      if (!g.rendered) html += gapHtml(g);
    }

    if (!shownCount) html += filterEmptyHtml('items');

    const money = tripMoney(trip);
    const curDisabled = sharedMode ? 'disabled' : '';
    html += `
      <div class="totals">
        <div class="t currency-pick"><div class="k">Currency</div><select id="currencySel" class="currency-sel" aria-label="Trip currency" ${curDisabled}>${currencyOptionsHtml(trip)}</select></div>
        ${money.planned.total !== money.confirmed.total ? `<div class="t"><div class="k">Full plan</div><div class="v">${moneyHtml(trip, money.planned.total, undefined, 'total')}</div></div>` : ''}
        <div class="t confirmed${money.confirmed.unconverted.length ? ' incomplete' : ''}"><div class="k">Confirmed bookings</div><div class="v">${moneyHtml(trip, money.confirmed.total, undefined, 'total')}</div></div>
      </div>`;
    html += breakdownGroupHtml(trip);
    const notes = moneyNotes(trip, money);
    if (notes) html += notes;

    board.innerHTML = html;
    syncSelectUi(selectableIds);
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
      // A jump into a row the filters hide used to do nothing at all: every
      // entry point (Issues panel, night strip, Up next chip, trip search,
      // duplicate) burned ui.flashId on a row that was never drawn. The item is
      // still in the trip, so say so - and offer the one action that reveals
      // it, rather than clearing filters the traveller set without asking.
      else if (filtering && trip.items.some(x => x.id === ui.flashId)) {
        const wanted = ui.flashId;
        toast('That item is hidden by the current search and filters.',
          () => { ui.flashId = wanted; clearFilters(); }, { action: 'Clear filters' });
      }
      ui.flashId = null;
    }
  }

  // The breakdown cards under the totals bar. They answer four versions of the
  // same "where is the money" question, so two or more of them must read as one
  // group rather than as a stack of unrelated cards: the wrapper pulls them
  // tight together and pushes the whole group away from the totals bar above.
  // A LONE card is not a group and gets no wrapper, so its spacing stays exactly
  // what it was before this existed (no manufactured air around one card).
  function breakdownGroupHtml(trip) {
    const cards = [travelerTotalsHtml(trip), settleUpHtml(trip), typeTotalsHtml(trip), spendOverTimeHtml(trip), cashNeededHtml(trip)]
      .filter(Boolean);
    if (cards.length < 2) return cards.join('');
    return `<div class="breakdown-group">${cards.join('')}</div>`;
  }

  // The heading of a breakdown card: its own icon, so the four cards are told
  // apart at a glance instead of by reading the rows under them.
  function ttHead(icon, label, extra = '') {
    return `<div class="tt-head"><span class="tt-head-ico" aria-hidden="true">${icon}</span>${label}${extra}</div>`;
  }

  // "Cost per traveller" block: one row per named traveller, rendered ONLY when
  // the trip names two or more (a solo trip gets nothing here, the totals bar is
  // byte for byte what it was before this feature). A traveller who owes an
  // amount we could not convert is flagged amber with a count, the same honesty
  // the Confirmed total already carries, so a share is never silently short.
  function travelerTotalsHtml(trip) {
    const names = normalizeTravelers(trip.travelers);
    if (names.length < 2) return '';
    const totals = travelerTotals(trip, activeRates(trip));
    const unconv = totals.unconverted;
    const short = n => n ? ` <small>+ ${n} not converted</small>` : '';
    const rows = names.map(n => {
      const missing = (unconv[n] || []).length;
      return `<div class="tt-row${missing ? ' incomplete' : ''}">`
        + `<span class="tt-name">${esc(n)}</span>`
        + `<span class="tt-val">${moneyHtml(trip, totals[n] || 0, undefined, 'total')}${short(missing)}</span>`
        + `</div>`;
    }).join('');
    return `<div class="traveler-totals">${ttHead('👥', 'Cost per traveler')}<div class="tt-list">${rows}</div></div>`;
  }

  // "Settle up": the payments that clear the trip, under the per-traveller split
  // that explains them. Same 2+ traveller gate as the block above, so a solo
  // trip has no trace of it in the DOM.
  //
  // The two empty states are NOT the same thing and must not read the same. No
  // item names a payer -> we were never told anything, so ask for it rather than
  // printing a row of $0.00 that looks like a settled trip. Payers recorded and
  // everything nets to zero -> genuinely square, say so.
  //
  // That difference was in the words alone, and the words are the last thing
  // read: both states were the same gray sentence, so a glance could not tell
  // "you are done" from "you never told me". The settled state now takes the
  // green the app already spends on a good outcome plus a tick, and the ask
  // keeps its plain gray, so the three shapes this card can take (rows owed,
  // nothing recorded, all square) are told apart before a word is read.
  function settleUpHtml(trip) {
    const names = normalizeTravelers(trip.travelers);
    if (names.length < 2) return '';
    const pays = settlements(trip, activeRates(trip));
    const missing = pays.unconverted.length;
    const short = missing ? ` <small>+ ${missing} not converted</small>` : '';
    let body;
    if (!pays.tracked && !missing) {
      body = `<div class="su-empty">Add "Paid by" to a cost to see who owes whom</div>`;
    } else if (!pays.length) {
      body = `<div class="su-settled"><span class="su-ico" aria-hidden="true">✅</span>All settled up</div>`;
    } else {
      body = pays.map(p => `<div class="su-row">`
        + `<span class="tt-name">${esc(p.from)} owes ${esc(p.to)}</span>`
        + `<span class="tt-val">${moneyHtml(trip, p.amount, undefined, 'total')}</span>`
        + `</div>`).join('');
    }
    return `<div class="traveler-totals settle-up${missing ? ' incomplete' : ''}">`
      + ttHead('🤝', 'Settle up', short)
      + `<div class="tt-list">${body}</div></div>`;
  }

  // "Cost by type": where the confirmed money went. Gated on cost data alone, so
  // it renders on a solo trip exactly as it does on a shared one, and only types
  // with a booked cost get a row (never a $0.00 line for a type this trip does
  // not use). A type carrying an amount we could not convert is amber with the
  // count, the same honesty rule the Confirmed total follows.
  //
  // Each row carries a bar as long as its share of the BIGGEST row, so the
  // ranking the rows already have is readable without comparing four amounts
  // digit by digit. The bar is decoration for the number beside it, never a
  // second claim: it stays the neutral accent even on an amber incomplete row,
  // because the honesty cue belongs on the text that names what is missing.
  function typeTotalsHtml(trip) {
    const rows = costsByType(trip, activeRates(trip));
    if (!rows.length) return '';
    const shares = typeBarShares(rows);
    const short = n => n ? ` <small>+ ${n} not converted</small>` : '';
    const html = rows.map((r, i) => {
      const meta = TYPE_META[r.type] || TYPE_META.note;
      const missing = r.unconverted.length;
      return `<div class="tt-row${missing ? ' incomplete' : ''}" data-type="${esc(r.type)}">`
        + `<span class="tt-name"><span class="ty-ico" aria-hidden="true">${meta.icon}</span>${esc(meta.label)}</span>`
        + `<span class="tt-val">${moneyHtml(trip, r.total, undefined, 'total')}${short(missing)}</span>`
        + `<span class="tt-bar" aria-hidden="true"><i style="width:${(shares[i] * 100).toFixed(2)}%"></i></span>`
        + `</div>`;
    }).join('');
    return `<div class="traveler-totals type-totals">${ttHead('🧾', 'Cost by type')}<div class="tt-list">${html}</div></div>`;
  }

  // "Spend over time": the same confirmed money as the card above, arranged by
  // WHEN it lands instead of by what it bought, one bar per ISO week. It answers
  // the question the ranked list cannot - whether the trip is front-loaded on
  // flights and a hotel or bleeding evenly - so the rows are in date order and
  // never sorted by size.
  //
  // Gated on the trip spanning two or more calendar weeks: on a long weekend
  // every booking falls in one week, and a single full-width bar labelled with
  // that week is a chart that says nothing. Below the gate there is no block in
  // the DOM at all, exactly as the other breakdown cards behave.
  //
  // Markup, classes and bar rules are Cost by type's verbatim (see
  // typeTotalsHtml): these are two readings of one number and must not look like
  // two different features. An amount we could not convert is amber with the
  // count in the week it belongs to, never quietly dropped from the bar.
  function spendOverTimeHtml(trip) {
    const st = tripStats(trip);
    if (!isIsoDate(st.start) || !isIsoDate(st.end)) return '';
    if (weekStart(st.start) === weekStart(st.end)) return '';
    const weeks = spendByWeek(trip, activeRates(trip));
    if (!weeks.length) return '';
    const shares = typeBarShares(weeks);
    const short = n => n ? ` <small>+ ${n} not converted</small>` : '';
    const html = weeks.map((w, i) => {
      const missing = w.unconverted.length;
      return `<div class="tt-row${missing ? ' incomplete' : ''}" data-week="${esc(w.start)}">`
        + `<span class="tt-name" title="${esc(fmtRange(w.start, addDays(w.start, 6)))}">Week of ${esc(fmtDate(w.start, false))}</span>`
        + `<span class="tt-val">${moneyHtml(trip, w.total, undefined, 'total')}${short(missing)}</span>`
        + `<span class="tt-bar" aria-hidden="true"><i style="width:${(shares[i] * 100).toFixed(2)}%"></i></span>`
        + `</div>`;
    }).join('');
    return `<div class="traveler-totals spend-time">${ttHead('📈', 'Spend over time')}<div class="tt-list">${html}</div></div>`;
  }

  // "Cash needed": how much actual cash to carry, per currency, for everything
  // tagged as a cash payment. The ONE money block on the page that never
  // converts, because "carry 40000 yen" is the answer and "carry $260" is not.
  // Gated purely on cash-tagged costs existing, so it renders the same on a solo
  // trip as on a shared one, and a currency nobody tagged gets no row at all.
  function cashNeededHtml(trip) {
    const rows = cashNeeded(trip);
    if (!rows.length) return '';
    const html = rows.map(r => `<div class="tt-row">`
      + `<span class="tt-name">${esc(r.currency)}</span>`
      + `<span class="tt-val">${moneyInHtml(r.currency, r.total, undefined, 'total')}</span>`
      + `</div>`).join('');
    return `<div class="traveler-totals cash-needed">${ttHead('💵', 'Cash needed')}<div class="tt-list">${html}</div></div>`;
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

  function stayNodeHtml(node, kids, ctx, pickable) {
    const { trip, issueById, today, filtering } = ctx;
    const it = node.item;
    const stayRow = rowHtml(trip, it, issueById[it.id], ctx.during && isPastRow(it, today), pickable);
    if (!kids.length) return `<div class="tl-node tl-stay">${stayRow}</div>`;

    const kidIds = new Set(kids.map(k => k.id));
    const days = node.days
      .map(d => ({ date: d.date, items: d.items.filter(x => kidIds.has(x.id)) }))
      .filter(d => d.items.length);
    const holdsFlash = ctx.flashId && kidIds.has(ctx.flashId);
    // a selection must never be invisible: "Select all" on a trip whose groups
    // are collapsed would otherwise report rows nobody can see. Derived like
    // the filter and flash overrides, so nothing is written to the saved
    // collapse map and the group falls back the moment the pick is dropped.
    const holdsSel = kids.some(k => selIds.has(k.id));
    // default: collapsed, except the stay you are inside today while the trip
    // is running. A live filter or a jump target always wins over both.
    const coversToday = ctx.during && isIsoDate(it.startDate) && isIsoDate(it.endDate)
      && it.startDate <= today && today < it.endDate;
    const open = filtering || holdsFlash || holdsSel || isOpen(trip.id, 'stay:' + it.id, coversToday);
    const level = nestedIssueLevel(kids, issueById);
    const badge = level ? `<span class="tl-warn ${level === 'error' ? 'is-err' : ''}" title="${level === 'error' ? 'Something inside has invalid data' : 'A warning applies inside this stay'}">⚠️</span>` : '';
    const total = node.count;
    // "1 of 3 items matches" read as a mistake: the verb agreed with the matched
    // count while the noun was hard-coded plural. Fronting the subject settles
    // it for every count - "Filters match 1 of 3 items", "... 0 of 1 item" - and
    // the noun now agrees with the total the way the day toggle's does.
    const label = filtering && kids.length !== total
      ? `Filters match ${kids.length} of ${total} item${total === 1 ? '' : 's'}`
      : `${total} item${total === 1 ? '' : 's'} during this stay`;
    const bodyId = `tlkids-${it.id}`;

    const dayHtml = days.map(d => {
      const dayOpen = filtering || (holdsFlash && d.items.some(x => x.id === ctx.flashId))
        || d.items.some(x => selIds.has(x.id))
        || isOpen(trip.id, `day:${it.id}:${d.date}`, ctx.during && d.date === today);
      const dLevel = nestedIssueLevel(d.items, issueById);
      const dBadge = dLevel ? `<span class="tl-warn ${dLevel === 'error' ? 'is-err' : ''}" aria-hidden="true">⚠️</span>` : '';
      const dId = `tlday-${it.id}-${d.date}`;
      // `kids` is already the matching set (renderBoard filtered it), so every
      // row drawn here is selectable while the mode is on - no second filter test
      const rows = d.items.map(x => rowHtml(trip, x, issueById[x.id], ctx.during && isPastRow(x, today), selMode)).join('');
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

  function rowHtml(trip, it, issueLevel, isPast, pickable) {
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
    // Both levels are pickable (see renderBoard): a row folded inside a stay's
    // day group carries the same checkbox, and picks independently of the stay.
    const picked = pickable && selIds.has(it.id);
    const selBox = pickable
      ? `<label class="c-sel"><input type="checkbox" data-sel-id="${it.id}" ${picked ? 'checked' : ''} aria-label="Select ${esc(displayTitle(it))}"></label>`
      : '';
    return `
      <div class="tp-row ${look.cls}${travelCls} ${issueCls} ${it.status === 'cancelled' ? 'is-cancelled' : ''} ${isPast ? 'is-past' : ''}${pickable ? ' is-selectable' : ''}${picked ? ' is-sel' : ''}" data-id="${it.id}">
        ${selBox}
        <span class="c-dot" role="img" aria-label="${esc(look.label)}" title="${esc(look.label)}">${look.icon}</span>
        <div class="c-when">
          <span class="c-date">${dates}</span>${time}${n ? `<span class="c-nights">${n} night${n === 1 ? '' : 's'}</span>` : ''}
        </div>
        <div class="c-main">
          <div class="c-title">${esc(displayTitle(it))}<span class="tp-clip" data-clip-for="${it.id}" title="Has attached documents" hidden>📎</span>${it.location ? `<span class="c-loc">${esc(it.location)}</span>` : ''}</div>
          ${refTagHtml(it)}
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

  // A confirmation code is the one thing a traveller needs on their feet, at a
  // counter or a gate, so it gets its own tag instead of being read back out of
  // a details paragraph. Empty (or absent, on every item saved before the field
  // existed) renders nothing at all, not an empty tag holding space open.
  function refTagHtml(it) {
    const ref = (it.confirmation || '').trim();
    return ref ? `<span class="tp-ref" title="Confirmation / reference number">Ref: ${esc(ref)}</span>` : '';
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

  function dayEventHtml(ev, trip, issueById, tieIds) {
    const it = ev.item;
    const look = rowLook(it);
    const issueLevel = issueById && issueById[it.id];
    const issueCls = issueLevel === 'error' ? ' has-err' : (issueLevel === 'warn' ? ' has-warn' : '');
    const isStayRow = ev.kind === 'checkin' || ev.kind === 'checkout';
    const tag = ev.kind === 'checkin' ? 'Check in' : (ev.kind === 'checkout' ? 'Check out' : '');
    // A check-out row names the place you are leaving; the location line would
    // just repeat the city you are still standing in. A span, not a div: the
    // city rides INLINE after the title now, so a short row is one line.
    const loc = (it.location && ev.kind !== 'checkout') ? `<span class="dc-loc">${esc(it.location)}</span>` : '';
    // the code rides on the check-in row only, for the same reason cost and the
    // Maps link do: a checkout row is the same booking a second time
    const ref = ev.kind === 'checkout' ? '' : refTagHtml(it);
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
    // The grip only exists where reordering MEANS something: a row that ties
    // with at least one other (same date, same clock time, "no time" included).
    // Everywhere else the row is drawn exactly as it was before this existed -
    // no handle, no data-tie, nothing for a drag to catch on - so a date or a
    // time can never be contradicted by a drag that had no business starting.
    const tie = (!sharedMode && tieIds && tieIds.has(it.id)) ? tieKey(it) : '';
    const grip = tie
      ? `<button type="button" class="row-btn dc-grip" data-grip="${it.id}" title="Drag to reorder, or press the up and down arrow keys"`
        + ` aria-label="Reorder ${esc(displayTitle(it))}: drag, or press the up and down arrow keys">${GRIP_SVG}</button>`
      : '';
    const travelCls = TRAVEL_TYPES[it.type] ? ' is-travel' : '';
    // Status is the rail dot's colour AND the colour the time reads in, so the
    // four statuses stay legible at a glance without a pill on every row. The
    // dot carries the label in text for anyone who cannot use the colour.
    const sm = STATUS_META[it.status] || STATUS_META['to-book'];
    // Two tags can be true at once (a cancelled booking still checks in on this
    // day), so they share one line rather than one slot.
    const tags = (tag ? `<span class="dc-tag">${tag}</span>` : '')
      + (cancelled ? '<span class="dc-tag is-cancelled">Cancelled</span>' : '');
    // What the distance pass needs to place this row, on the row itself. A
    // check-out row carries none of it, so it can neither get a leg chip nor
    // become the origin of the next one: it is the same booking a second time,
    // exactly as it is for the cost and Maps cells above.
    const dist = ev.kind === 'checkout' ? '' : itemDistAttrs(it);
    return `<div class="dc-event ${look.cls}${travelCls}${isStayRow ? ' is-stay' : ''}${issueCls} ${sm.cls} ${cancelled ? 'is-cancelled' : ''}"${tie ? ` data-id="${it.id}" data-tie="${esc(tie)}"` : ''}${dist}>
      <div class="dc-rail">
        <span class="dc-dot" role="img" aria-label="${esc(sm.label)}" title="${esc(sm.label)}"></span>
        ${when ? `<span class="dc-when">${when}</span>` : ''}
      </div>
      <div class="dc-item">
        <div class="dc-main">
          <span class="dc-ico" role="img" aria-label="${esc(look.label)}" title="${esc(look.label)}">${look.icon}</span>
          <div class="dc-label">
            ${tags}
            <div class="dc-title">${esc(displayTitle(it))}${clip}${loc}</div>
            ${ref}
          </div>
          <div class="dc-facts">${cost}${maps}</div>
          <div class="dc-btns">${grip}${edit}${del}</div>
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
      <span class="dc-chip-city">${esc(city)}</span><span class="dc-chip-sep" hidden></span><span class="dc-chip-icon" hidden></span><span class="dc-chip-temp"></span><span class="dc-chip-rain" hidden></span><span class="dc-chip-rh" hidden></span><span class="dc-chip-tag" hidden></span>
    </span>`;
  }

  // Everything with a startDate on this day can be bulk-deleted; a check-OUT row
  // belongs to a stay that began earlier, so it is not "an event on this day".
  const dayClearCount = card => card.events.filter(ev => ev.kind !== 'checkout').length + card.untimed.length;

  function dayCardHtml(card, isToday, trip, issueById, tieIds) {
    const parts = [];
    if (card.events.length) parts.push(card.events.map(ev => dayEventHtml(ev, trip, issueById, tieIds)).join(''));
    if (card.untimed.length) {
      parts.push(`<div class="dc-untimed"><span class="dc-untimed-label">No time set</span>${card.untimed.map(ev => dayEventHtml(ev, trip, issueById, tieIds)).join('')}</div>`);
    }
    // A day with nothing on it still has a bed if a stay spans it, and saying
    // "No plans yet" there would be false (see emptyDayNote).
    if (!parts.length) parts.push(`<div class="dc-empty">${esc(emptyDayNote(trip.items, card.date))}</div>`);
    // the bulk-delete count is the FULL day, never the filtered view: the button
    // deletes everything on the date, so its label has to say so
    const canClear = !sharedMode && (card.clearCount != null ? card.clearCount : dayClearCount(card)) > 0;
    // The copy button has a wider gate than clear/duplicate: an interior
    // night of a stay has nothing to clear, but "Staying at <hotel>" is
    // still a day worth pasting to someone, and the card itself says it.
    const canCopy = canClear || (!sharedMode && !!shareHostStay(trip.items, card.date));
    const editBtns = sharedMode ? '' : `
            <button class="row-btn" data-act="add-day" data-date="${card.date}" title="Add an item on this day" aria-label="Add an item on ${esc(fmtDate(card.date))}">+</button>
            <button class="row-btn" data-act="share-day" data-date="${card.date}"${canCopy ? '' : ' disabled'} title="${canCopy ? 'Copy day' : 'Nothing on this day to copy'}" aria-label="Copy ${esc(fmtDate(card.date))} as text">📋</button>
            <button class="row-btn" data-act="duplicate-day" data-date="${card.date}"${canClear ? '' : ' disabled'} title="${canClear ? 'Copy every item on this day to another date' : 'Nothing on this day to copy'}" aria-label="Copy everything on ${esc(fmtDate(card.date))} to another date">📄</button>
            ${canClear ? `<button class="row-btn danger" data-act="clear-day" data-date="${card.date}" title="Delete every item on this day" aria-label="Delete every item on ${esc(fmtDate(card.date))}">${TRASH_SVG}</button>` : ''}`;
    // Where the day's chain of distances starts: the stay covering it (its own
    // coordinates when it came from the hotel picker, else its city), or the
    // morning city the chip already names. Stamped like the rows, so the pass
    // reads the DOM and the caches and nothing else.
    // An 'arrival' anchor is a travel leg, not a place: its query and name
    // rungs would be nonsense ("Boston (BOS) to Keflavik (KEF)" is nothing a
    // venue cache or geocoder should be asked), so it stamps only its city
    // fallback plus the IATA code the airports table resolves exactly.
    const a = dayAnchor(trip.items, card.date, geoResolved);
    const place = a && a.item && a.source !== 'arrival';
    const anchor = a
      ? ` data-anchor-q="${esc(place ? itemMapsQuery(a.item) : '')}" data-anchor-name="${esc(place ? a.label : '')}"`
        + ` data-anchor-city="${esc(a.city)}" data-anchor-label="${esc(a.label)}"`
        + (a.iata ? ` data-anchor-iata="${esc(a.iata)}"` : '')
      : '';
    return `
      <section class="day-card ${isToday ? 'is-today' : ''}" data-date="${card.date}" aria-label="${esc(fmtDate(card.date))}"${anchor}>
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

  // The ONE per-item status write: the Timeline row's status <select> and the
  // issues panel's "Mark booked" both land here, so whichever control the
  // traveller used, the change is one save and one undo step.
  function setItemStatus(id, status) {
    const it = activeTrip().items.find(x => x.id === id);
    if (!it) return;
    it.status = status;
    save();
    render();
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
        const ok = save();
        const snapshot = lastSaved;
        render();
        // only safe while ours is still the newest snapshot; anything saved
        // since would be what undo() actually reverses - same inline guard
        // clearDay/bulkDelete/duplicateDay use, so a stale delete toast can
        // never resurrect an item over a save that happened after it.
        if (ok) toast(`Deleted "${it.title}"`, () => { if (lastSaved === snapshot) undoDelete(); });
      });
      return;
    }
    const idx = trip.items.findIndex(x => x.id === id);
    lastDeleted = { item: it, idx, tripId: trip.id };
    trip.items.splice(idx, 1);
    const ok = save();
    const snapshot = lastSaved;
    render();
    if (ok) toast(`Deleted "${it.title}"`, () => { if (lastSaved === snapshot) undoDelete(); });
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

  // Copying a day is the same selection as clearing one (see clearDay): the
  // items that START here. A day in one base city usually repeats its shape -
  // breakfast, something to do, dinner - and only the venues change, so the
  // copy is the cheap way to build the next one.
  let dupDaySource = null;
  function openDupDayModal(date) {
    const trip = activeTrip();
    const n = trip.items.filter(it => it.startDate === date).length;
    if (!n) return;
    dupDaySource = date;
    $('#fDupDayDate').classList.remove('invalid');
    $('#dupDayDate').value = addDays(date, 1);
    $('#dupDayHint').textContent = `${n} item${n === 1 ? '' : 's'} from ${fmtDate(date)} are copied to the date you pick. The originals stay where they are, and a stay keeps the same number of nights.`;
    openOverlay('#dupDayOverlay');
    $('#dupDayDate').focus();
  }

  function submitDupDayForm(e) {
    e.preventDefault();
    const target = $('#dupDayDate').value;
    // #dupDayForm is novalidate like #itemForm, so the input's own min/max never
    // fire on a typed value; these are the same bounds they are stamped from.
    if (!isIsoDate(target) || !isDateInRange(target)) {
      $('#fDupDayDate').classList.add('invalid');
      $('#dupDayErr').textContent = isIsoDate(target) ? `Use a date between ${DATE_MIN} and ${DATE_MAX}.` : 'A valid date is required.';
      return;
    }
    // A day copied onto itself is not a copy, it is every item on it duplicated
    // in place with "(copy)" on the end, which is never what "copy to" meant.
    if (target === dupDaySource) {
      $('#fDupDayDate').classList.add('invalid');
      $('#dupDayErr').textContent = 'Pick a different day: this is the day you are copying from.';
      return;
    }
    const source = dupDaySource;
    closeAllOverlays();
    duplicateDay(source, target);
  }

  // A copy, never a move: the source day is untouched and whatever the target
  // day already holds is kept. Every clone is shifted by the same day delta, so
  // a 3-night stay copied forward is still 3 nights. One save() means one undo
  // takes the whole copied day back out again.
  function duplicateDay(date, targetDate) {
    const trip = activeTrip();
    const sources = trip.items.filter(it => it.startDate === date);
    if (!sources.length) return;
    const delta = diffDays(date, targetDate);
    const copies = sources.map(it => {
      const copy = { ...it, id: uid(), createdAt: new Date().toISOString(), title: it.title + ' (copy)', startDate: targetDate };
      // A blank or broken end date stays exactly as it is. Shifting a date that
      // was never a date only invents a different wrong one, which is the same
      // guard submitShiftForm uses.
      if (isIsoDate(it.endDate)) copy.endDate = addDays(it.endDate, delta);
      return copy;
    });
    trip.items.push(...copies);
    const n = copies.length;
    const label = `${n} item${n === 1 ? '' : 's'}`;
    const ok = save();
    const snapshot = lastSaved;
    render();
    if (ok) toast(`Copied ${label} to ${fmtDate(targetDate, false)}`, () => {
      // only safe while ours is still the newest snapshot; anything saved
      // since would be what undo() actually reverses
      if (lastSaved === snapshot) undo();
    });
  }

  // One day as text, out of the app: the share sheet where the device has one,
  // the clipboard where it does not. Built from the UNFILTERED day, the same
  // whole-day reading the copy and clear buttons beside it take, so what lands
  // in the message is the day rather than whatever a search box left on screen.
  //
  // The fallback chain is shareTrip's: clipboard, then window.prompt, so a
  // browser that refuses clipboard access still hands the text over. A share
  // sheet the traveller dismisses is a rejected promise and NOT a failure, so it
  // never falls through to copying something they just declined to send.
  async function shareDay(date) {
    const trip = activeTrip();
    const card = dayCards(trip).find(c => c.date === date);
    if (!card) return;
    const text = dayShareText(card, trip.items, fmtDate, fmtTime);
    // Clipboard only, by owner decision: the native share sheet made the
    // button do different things on different devices, and the point of this
    // control is a predictable "it is on my clipboard now". The prompt is
    // the last resort for clipboard-API failures (permissions, http).
    try {
      await navigator.clipboard.writeText(text);
      toast('Day copied');
      // The toast lands at the screen edge while the eye is on the button
      // that was just pressed, so the button itself confirms too: a brief
      // checkmark right under the cursor. Re-queried by date because a
      // render between click and now would detach the original node.
      const btn = document.querySelector(`button[data-act="share-day"][data-date="${date}"]`);
      if (btn) {
        btn.textContent = '✅';
        btn.title = 'Copied';
        setTimeout(() => {
          const b = document.querySelector(`button[data-act="share-day"][data-date="${date}"]`);
          if (b && b.textContent === '✅') { b.textContent = '📋'; b.title = 'Copy day'; }
        }, 1600);
      }
    } catch {
      window.prompt('Copy this day:', text);
    }
  }

  function renderDays() {
    const trip = activeTrip();
    const box = $('#daysList');
    const all = dayCards(trip);
    if (!all.length) {
      box.innerHTML = `
        <div class="empty">
          <div class="big">📅</div>
          <h2>No day-by-day plan yet</h2>
          <p>Add items with dates and a day-by-day plan appears here.</p>
        </div>`;
      return;
    }
    const issueById = buildIssueById(currentIssues);
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
    // It ships HIDDEN and is revealed by the first temperature actually written
    // (see revealWeatherNote): a trip whose days resolve no city, or whose
    // cities have no climate record, showed a caveat and a licence credit for
    // data that was nowhere on the screen.
    // The forecast sentence is a hidden span inside the SAME note, revealed
    // only once a "Forecast" chip has actually been painted (see
    // revealWeatherNote): a trip with no day inside the forecast horizon reads
    // exactly the line it always did, and the one Open-Meteo credit covers both
    // sources rather than a second uncredited one being introduced.
    const wx = '<div class="days-note days-wx" id="daysWx" hidden>Temperatures are typical for that month across the last '
      + WEATHER_YEARS + ' years of records, not a forecast.'
      + '<span id="daysWxFc" hidden> Chips marked Forecast are the exception: inside ' + FORECAST_DAYS
      + ' days of today the card shows the actual forecast for that day instead.</span>'
      + ' Weather data by '
      + '<a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo</a> (CC BY 4.0).</div>';
    // Which rows may be dragged, computed once for the whole trip. NOT offered
    // while a filter is on: a group half of whose rows are hidden cannot be put
    // in an order the traveller can see, and dropping a row "at the top" of the
    // three rows left on screen would silently renumber the two that are not.
    const tieIds = filtering ? null : reorderableIds(trip.items);
    box.innerHTML = note + cards.map(c => dayCardHtml(c, phase.phase === 'during' && c.date === today, trip, issueById, tieIds)).join('') + wx;
    // Same one batched lookup as the timeline: paints from the shared session
    // cache instantly, so switching into the days view never refetches a key the
    // board already resolved.
    hydrateRatings(box);
    loadWeatherForDays();
    refreshDocIndicators();
    // Cache-first and idempotent: every chip it can draw comes out of the venue
    // and geocode caches, and only what is genuinely missing (and on screen) is
    // queued for a lookup.
    refreshDistances();
  }

  // ---------- reordering a day's tied rows ----------
  // Pointer events, not HTML5 drag-and-drop: the day card is the surface people
  // use on a phone, and dragstart/drop never fire for a finger. The grip carries
  // touch-action:none so the same gesture drags the row instead of scrolling the
  // page under it.
  //
  // Nothing outside the dragged row's own tie group is a drop target, so a drag
  // that wanders onto another day (or onto a row with a different clock time)
  // moves nothing and the row stays where it started - the "snaps back" the
  // group boundary promises, done by never letting it leave in the first place.
  let dragCtx = null;

  // The rendered rows of one group, in the order they are on screen right now.
  function tieRowsOf(row) {
    const card = row.closest('.day-card');
    if (!card) return [row];
    return [...card.querySelectorAll('.dc-event[data-tie]')].filter(r => r.dataset.tie === row.dataset.tie);
  }

  function beginRowDrag(e) {
    if (sharedMode || dragCtx || e.button > 0) return;
    const grip = e.target.closest('.dc-grip');
    const row = grip && grip.closest('.dc-event[data-tie]');
    if (!row) return;
    // or the pointer press selects the row's text while the drag runs
    e.preventDefault();
    dragCtx = { row, ids: tieRowsOf(row).map(r => r.dataset.id) };
    row.classList.add('is-dragging');
    document.body.classList.add('tp-reordering');
    window.addEventListener('pointermove', onRowDragMove);
    window.addEventListener('pointerup', endRowDrag);
    window.addEventListener('pointercancel', cancelRowDrag);
  }

  function onRowDragMove(e) {
    if (!dragCtx) return;
    // the row under the POINTER, not a delta on the row being dragged: the rows
    // are different heights (a note with three lines of details next to a bare
    // title), so only a real hit test knows which one is being crossed
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const over = el && el.closest('.dc-event[data-tie]');
    if (!over || over === dragCtx.row || over.dataset.tie !== dragCtx.row.dataset.tie) return;
    const box = over.getBoundingClientRect();
    const above = e.clientY < box.top + box.height / 2;
    over.parentNode.insertBefore(dragCtx.row, above ? over : over.nextSibling);
  }

  function stopRowDrag() {
    window.removeEventListener('pointermove', onRowDragMove);
    window.removeEventListener('pointerup', endRowDrag);
    window.removeEventListener('pointercancel', cancelRowDrag);
    document.body.classList.remove('tp-reordering');
    const ctx = dragCtx;
    dragCtx = null;
    if (ctx) ctx.row.classList.remove('is-dragging');
    return ctx;
  }

  // A cancelled drag (Escape, a pointer the browser took away) re-renders from
  // the data, which is what puts the half-moved row back where it belongs.
  function cancelRowDrag() {
    if (stopRowDrag()) renderDays();
  }

  function endRowDrag() {
    const ctx = stopRowDrag();
    if (!ctx) return;
    const ids = tieRowsOf(ctx.row).map(r => r.dataset.id);
    // dropped where it was picked up: not an edit, so not a save and not an
    // undo step the traveller would have to press twice to get past
    if (ids.join('\0') === ctx.ids.join('\0')) return;
    commitOrder(ids);
  }

  // One save for the whole group, so Undo takes the day back to the order it
  // was in rather than walking the rows back one at a time.
  function commitOrder(ids) {
    if (!applyManualOrder(activeTrip().items, ids)) return;
    save('Order updated');
    render();
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
    // A near-term day already showing a real forecast keeps it: the archive
    // request for the same chip was fired anyway (it is the fallback if the
    // forecast never lands) and can settle second, so without this the
    // 5-year average would quietly overwrite the better answer.
    if (chip.dataset.forecastShown === '1') return;
    const range = weatherRange(rec);
    if (!range) return;
    chip.querySelector('.dc-chip-temp').textContent = range;
    chip.querySelector('.dc-chip-sep').hidden = !chip.querySelector('.dc-chip-city').textContent;
    chip.title = `${weatherLine(place, rec)}. Typical for this month across the last ${WEATHER_YEARS} years of records, not a forecast.`;
    chip.hidden = false;
    revealWeatherNote();
  }
  // The one place a temperature is ever written is the one place that can say
  // the caveat and the credit are now about something on screen. Both the
  // cached paint (during renderDays) and the async archive response land here,
  // so the note appears the moment the data does rather than waiting for an
  // unrelated re-render. The note is absent while the day view is empty or
  // filtered to nothing, which is why this checks before it writes.
  function revealWeatherNote(withForecast) {
    const el = $('#daysWx');
    if (el) el.hidden = false;
    if (!withForecast) return;
    const fc = $('#daysWxFc');
    if (fc) fc.hidden = false;
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
    const forecastJobs = new Map();
    const today = todayIso();
    const now = Date.now();
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
      // A day inside Open-Meteo's forecast horizon gets the real thing on top
      // of the climate figure. Everything further out is left exactly as it has
      // always been: the archive lookup above is untouched, so it is also the
      // fallback when the forecast request fails or times out.
      // Offline the card shows the climate chip and nothing else, cached
      // forecast or not: a stored forecast cannot be checked or refreshed with
      // no connection, and "what it is typically like" is the honest answer
      // then. navigator.onLine is the same signal ensureWeather gates on.
      if (!navigator.onLine || !forecastEligible(date, today)) return;
      const id = place.toLowerCase();
      const fKey = forecastKey(id, date);
      chip.dataset.forecastKey = fKey;
      const fCached = forecastCache[fKey];
      if (forecastFresh(fCached, now)) { writeForecastSlot(chip, place, fCached); return; }
      if (!forecastJobs.has(id)) forecastJobs.set(id, { id, place, dates: [] });
      forecastJobs.get(id).dates.push(date);
    });
    for (const pair of pairs.values()) {
      if (!weatherCache[pair.key]) ensureWeather(pair);
    }
    for (const job of forecastJobs.values()) {
      job.dates = [...new Set(job.dates)].sort();
      ensureForecast(job);
    }
  }

  // Bounded like every other network call here (8s rates, 9s geocode, 12s
  // places, 15s visa). Unbounded, a hung connection never settled the promise,
  // so its key sat in weatherInflight for the rest of the session and that
  // city+month could never be looked up again. 12s covers a five-year daily
  // range, which is the heaviest response the app asks for.
  const WEATHER_TIMEOUT = 12000;

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
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), WEATHER_TIMEOUT);
      let data;
      try {
        const res = await fetch(url, { signal: ctrl.signal });
        if (!res.ok) throw new Error('http ' + res.status);
        data = await res.json();
      } finally { clearTimeout(timer); }
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
      .catch(() => { /* offline / geocode miss / bad response / timed out: leave the slot empty */ })
      // every path lands here, aborted included, so the pair is free to be
      // tried again later in the session
      .finally(() => weatherInflight.delete(key));
    weatherInflight.set(key, p);
  }

  // ---------- near-term forecast (Open-Meteo forecast, cached per place+date) ----------
  // Its own store, deliberately NOT trip-planner:weather:v2. That cache holds
  // 5-year climate normals keyed by place+MONTH and never goes off; a forecast
  // is about one specific day and is stale within hours, so the two could not
  // share a key or an expiry without one of them lying. Expired entries are
  // dropped at load rather than served.
  // v2: the record grew a condition code and a humidity figure, and the chip
  // renders all of them. A v1 entry carries neither, so under the v1 key it
  // would paint a chip missing its icon and its humidity for up to three hours;
  // a new key retires them outright and the next render refetches.
  const FORECAST_CACHE_KEY = 'trip-planner:forecast:v2';
  let forecastCache = {};
  try {
    forecastCache = freshForecasts(JSON.parse(localStorage.getItem(FORECAST_CACHE_KEY) || '{}'), Date.now());
  } catch { forecastCache = {}; }
  // Keyed by place (one request covers that place's whole near-term run), so a
  // second render mid-flight joins the in-flight call instead of repeating it.
  const forecastInflight = new Map();

  // The forecast twin of writeWeatherSlot. Same range formatting, but the chip
  // carries a condition icon, the rain and humidity figures, a visible
  // "Forecast" tag and its own tooltip wording, so a real forecast is never
  // mistaken for the typical-for-this-month figure.
  //
  // The two percentages answer different questions and must not be read as one
  // number twice, so they take different markers: an umbrella for the chance of
  // rain, a droplet for the humidity in the air. Each also carries its own
  // tooltip, and the chip's tooltip spells both out in words.
  function writeForecastSlot(chip, place, rec) {
    const parts = forecastChipParts(rec);
    if (!parts) return;
    chip.querySelector('.dc-chip-temp').textContent = parts.temp;
    chip.querySelector('.dc-chip-sep').hidden = !chip.querySelector('.dc-chip-city').textContent;
    const icon = chip.querySelector('.dc-chip-icon');
    icon.textContent = parts.icon;
    icon.title = parts.condition;
    icon.hidden = !parts.icon;
    const rain = chip.querySelector('.dc-chip-rain');
    rain.textContent = parts.rain;
    rain.title = parts.rain ? `${parts.rain} chance of rain` : '';
    rain.hidden = !parts.rain;
    const rh = chip.querySelector('.dc-chip-rh');
    rh.textContent = parts.humidity;
    rh.title = parts.humidity ? `${parts.humidity} average humidity` : '';
    rh.hidden = !parts.humidity;
    const tag = chip.querySelector('.dc-chip-tag');
    tag.textContent = 'Forecast';
    tag.hidden = false;
    chip.title = `${forecastLine(place, rec)}. The forecast for this day, not a typical-for-the-month average.`;
    chip.dataset.forecastShown = '1';
    chip.hidden = false;
    // the header cannot fit badge + date + a labelled chip + four actions on a
    // phone, so the card says it carries a pill and the stylesheet gives the
    // header a second line at that width (see .day-card.has-forecast)
    const card = chip.closest('.day-card');
    if (card) card.classList.add('has-forecast');
    revealWeatherNote(true);
  }

  function applyForecast(key, place, rec) {
    document.querySelectorAll('#daysList .dc-chip').forEach(chip => {
      if (chip.dataset.forecastKey === key) writeForecastSlot(chip, chip.dataset.weatherPlace || place, rec);
    });
  }

  // One request per PLACE spanning its whole near-term run, not one per day: a
  // week in Tokyo is a single call whose response fills seven cache entries.
  // Bounded by the same 12s budget as the archive call above, and failing
  // silently on purpose: the historical chip is already on screen, so there is
  // no blank slot and no spinner to clear.
  function ensureForecast(job) {
    const { id, place, dates } = job;
    if (!dates.length || forecastInflight.has(id) || !navigator.onLine) return;
    const p = (async () => {
      const hit = await geocode(place);
      if (!hit.ok) return null;
      const url = 'https://api.open-meteo.com/v1/forecast'
        + `?latitude=${hit.lat}&longitude=${hit.lon}`
        + `&start_date=${dates[0]}&end_date=${dates[dates.length - 1]}`
        // weather_code and relative_humidity_2m_mean are both DAILY variables
        // on this endpoint, so the icon and the humidity ride along in the one
        // request that was already being made: no hourly block to average.
        + '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code,relative_humidity_2m_mean&timezone=auto';
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), WEATHER_TIMEOUT);
      let data;
      try {
        const res = await fetch(url, { signal: ctrl.signal });
        if (!res.ok) throw new Error('http ' + res.status);
        data = await res.json();
      } finally { clearTimeout(timer); }
      const byDate = summarizeForecast(data && data.daily);
      const at = Date.now();
      const painted = [];
      for (const date of dates) {
        const rec = byDate[date];
        if (!rec) continue;
        const key = forecastKey(id, date);
        forecastCache[key] = { at, lo: rec.lo, hi: rec.hi, pop: rec.pop, code: rec.code, rh: rec.rh };
        painted.push({ key, rec: forecastCache[key] });
      }
      if (!painted.length) return null;
      try { localStorage.setItem(FORECAST_CACHE_KEY, JSON.stringify(forecastCache)); } catch { /* best effort */ }
      return painted;
    })()
      .then(painted => {
        if (painted && ui.view === 'days') painted.forEach(hit => applyForecast(hit.key, place, hit.rec));
        return painted;
      })
      // offline / geocode miss / bad response / timed out: the historical chip
      // stands as the answer for that day, so there is nothing to undo here
      .catch(() => { /* fall back to the climate chip already painted */ })
      .finally(() => forecastInflight.delete(id));
    forecastInflight.set(id, p);
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
      // A memoized rejection is permanent. One failure to open (private
      // browsing blocks the store outright, and the open can fail transiently)
      // poisoned every attach, list and delete for the rest of the session,
      // with no way back short of a reload. Forgetting the failed promise
      // means the next attempt simply opens the database again.
      docsDbPromise.catch(() => { docsDbPromise = null; });
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
  // ONE mechanism for both views. The timeline used to build its paperclip
  // imperatively after paint, so the clip was missing from board.innerHTML and
  // from anything reading that markup until the async IndexedDB sweep landed,
  // while the day view shipped a hidden span in the HTML string and just
  // unhid it. The day view's way is the one that survives: the element is part
  // of the row from the first paint, and the sweep only decides whether it
  // shows. Both carry data-clip-for, so one query patches every clip on screen.
  function applyDocIndicators() {
    document.querySelectorAll('[data-clip-for]').forEach(el => {
      el.hidden = !(docCounts.get(el.dataset.clipFor) > 0);
    });
  }

  // Object URLs for the current thumbnail list; revoked on rebuild/close.
  let docObjectUrls = [];
  function revokeDocUrls() { docObjectUrls.forEach(u => URL.revokeObjectURL(u)); docObjectUrls = []; }

  // IndexedDB can simply refuse: private browsing blocks the store outright and
  // a write can hit the origin's quota. Every one of those used to fail
  // silently, leaving the list showing whatever it showed last, which reads as
  // "it worked". #docsErr is the in-context explanation; the toast is what
  // guarantees it is seen, because that line sits at the bottom of a scrolling
  // section and can be below the fold.
  const DOCS_UNREADABLE = 'Attached documents could not be read on this device.';
  function showDocsError(msg) {
    const errBox = $('#docsErr');
    errBox.textContent = msg;
    errBox.hidden = false;
    toastError(msg);
  }

  // Never rejects. syncDocsSection fires it without awaiting, so a rejection
  // here would be an unhandled one. A store that cannot be read says so IN
  // PLACE of the list: an empty list is the claim "this item has no
  // documents", and that is not what happened.
  async function renderDocsList(itemId) {
    const list = $('#docsList');
    revokeDocUrls();
    try {
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
    } catch {
      // a non-empty #docsList is also what suppresses the "No documents yet"
      // empty state next to it, so the wrong claim cannot show through
      list.innerHTML = `<div class="docs-unavailable">${esc(DOCS_UNREADABLE)}</div>`;
      toastError(DOCS_UNREADABLE);
    }
  }

  async function attachDocs(files) {
    const itemId = ui.editingId;
    if (!itemId || !files.length) return;
    const errBox = $('#docsErr');
    let count;
    try { count = (await listDocs(itemId)).length; }
    catch { showDocsError(`${DOCS_UNREADABLE} Nothing was attached.`); return; }
    const problems = [];
    let added = 0;
    let storeRefused = false;
    for (const f of files) {
      const g = docGuard(count, f.size);
      if (!g.ok) {
        if (g.reason === 'count') { problems.push('You can attach at most 10 files to an item.'); break; }
        problems.push(`"${f.name}" is over the 2MB limit and was not added.`);
        continue;
      }
      try { await addDoc(itemId, f); }
      catch {
        // the store refused this write, so it will refuse the rest the same way
        storeRefused = true;
        problems.push(`"${f.name}" could not be stored on this device. Storage may be full.`);
        break;
      }
      count++; added++;
    }
    // a size or count refusal is the traveller's own file being too big, and
    // the error line alone has always been the right weight for it. Only a
    // store that refused outright escalates to a toast.
    if (problems.length && storeRefused) showDocsError(problems.join(' '));
    else if (problems.length) { errBox.textContent = problems.join(' '); errBox.hidden = false; }
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
    // the split amounts are in the item's own currency, so they carry the same
    // symbol and have to follow it
    renderSplitControl(typedSplitAmounts());
  }

  // How a cost gets paid. '' is "Not tracked" and stores nothing at all: only
  // 'cash' drives anything (the Cash needed block), the other two are notes to
  // self. The list is the one gate the form and an import both check against.
  const PAYMENT_METHODS = ['cash', 'card', 'prepaid'];

  // `preset` is either the date a day card's + button was pressed on, or a
  // whole opening shape (type and both dates) for a form somebody else filled
  // in - today that is the gap warning's "Add stay". It applies to a NEW item
  // only: an edit opens on what the item actually says.
  function openItemModal(itemId, preset) {
    ui.editingId = itemId;
    const pre = typeof preset === 'string' ? { startDate: preset } : (preset || {});
    const it = itemId ? activeTrip().items.find(x => x.id === itemId) : null;
    const preStay = !it && pre.type === 'stay';
    $('#itemModalTitle').textContent = it ? 'Edit item' : 'Add item';
    $('#itemSaveBtn').textContent = it ? 'Save changes' : 'Add item';
    setModalType(it ? it.type : (TYPE_META[pre.type] ? pre.type : 'flight'));
    $('#inTitle').value = it ? it.title : '';
    // A rating belongs to the row a traveller picked in THIS form, never to a
    // saved item, so opening any item starts without one.
    clearStayRating();
    syncFlightPickers(it);
    $('#inLocation').value = it ? (it.location || '') : '';
    $('#inStart').value = it ? (it.startDate || '') : (pre.startDate || '');
    $('#inEnd').value = it && it.type === 'stay' ? (it.endDate || '') : (preStay ? (pre.endDate || '') : '');
    $('#inArrDate').value = it && it.type !== 'stay' ? (it.endDate || '') : '';
    $('#inArrTime').value = it ? (it.endTime || '') : '';
    $('#inTime').value = it ? (it.startTime || '') : '';
    $('#inStatus').value = it ? it.status : 'to-book';
    const base = activeTrip().currency || 'USD';
    // an estimate-only item has no costCurrency yet, so the picker opens on the
    // currency the guess is in: that is the currency adopting it would use
    const itemCur = (it && (it.costCurrency || it.estCostCurrency)) || base;
    $('#inCostCurrency').innerHTML = currencyOptionsFor(itemCur, [base, itemCur]);
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
    // items saved before this field existed carry no `confirmation` key at all,
    // which reads as empty here and needs no migration
    $('#inConfirmation').value = it ? (it.confirmation || '') : '';
    $('#inBookBy').value = it ? (it.bookBy || '') : '';
    // an unknown method (hand-edited JSON, a future value) falls back to the
    // blank "Not tracked" option rather than leaving the select on whatever
    // happened to be first
    $('#inPayment').value = it && PAYMENT_METHODS.includes(it.payment) ? it.payment : '';
    renderWhoFor(it);
    $('#inDetails').value = it ? (it.details || '') : '';
    renderDetailLinks(it);
    syncDocsSection(it);
    clearFieldErrors();
    openOverlay('#itemOverlay');
    // preventScroll keeps the modal parked at its heading; without it the
    // overlay scrolls the title field up and hides the heading on phones
    $('#inTitle').focus({ preventScroll: true });
  }

  // How the item currently open divides its cost among the people ticked below.
  // Module scope rather than a DOM read because the toggle has to survive the
  // rebuild that ticking a box or editing the cost forces on the control.
  let splitMode = 'even';

  // "Who's this for": a checkbox per traveller, shown ONLY when the trip names
  // two or more. Below that the whole control (legend and boxes) is not built at
  // all, so a solo trip's item modal has no trace of it in the DOM, never a
  // hidden node. None checked, or all checked, both mean Everyone and persist as
  // no `travelers` key; a proper subset persists as that subset.
  //
  // The one exception is a hand-entered split: those amounts are keyed by name,
  // so the item has to name them even when that list happens to be everybody,
  // or a third traveller joining the trip later would silently inherit a share
  // of a split that was agreed between two people.
  function renderWhoFor(it) {
    const box = $('#fItemTravelers');
    const names = normalizeTravelers(activeTrip().travelers);
    if (names.length < 2) { box.innerHTML = ''; box.hidden = true; splitMode = 'even'; return; }
    box.hidden = false;
    const picked = new Set((Array.isArray(it && it.travelers) ? it.travelers : []).map(n => String(n).toLowerCase()));
    // a payer the trip no longer names (renamed, removed) opens as "Not tracked"
    // rather than as a phantom option, and saving the item clears it for good
    const paidBy = names.find(n => n.toLowerCase() === String((it && it.paidBy) || '').trim().toLowerCase()) || '';
    // the item reopens on the split it was SAVED with, but only while that split
    // still adds up (customSplitShares is the same gate the totals apply), so a
    // stale set of numbers is never presented as the live answer
    splitMode = customSplitShares(it, names) ? 'amount' : 'even';
    box.innerHTML = `
      <fieldset class="who-for" id="whoFor">
        <legend>Who's this for <small>(optional)</small></legend>
        <div class="who-list">
          ${names.map(n => `<label class="who-chk"><input type="checkbox" value="${esc(n)}"${picked.has(n.toLowerCase()) ? ' checked' : ''}>${esc(n)}</label>`).join('')}
        </div>
        <div class="hint">Leave all unchecked to split this cost evenly across everyone. Pick some to split it only among them.</div>
        <div class="split-mode" id="splitMode" hidden></div>
      </fieldset>
      <div class="field paid-by">
        <label for="inPaidBy">Paid by <small>(optional, drives "Settle up")</small></label>
        <span class="sel-wrap">
          <select id="inPaidBy" class="paid-by-sel">
            <option value="">Not tracked</option>
            ${names.map(n => `<option value="${esc(n)}"${paidBy === n ? ' selected' : ''}>${esc(n)}</option>`).join('')}
          </select>
        </span>
      </div>`;
    // bound to the FRESH fieldset this render just built, so reopening the modal
    // cannot stack a second copy of these handlers
    const fs = $('#whoFor');
    fs.addEventListener('change', e => {
      if (e.target.closest('.who-chk')) renderSplitControl(typedSplitAmounts());
    });
    fs.addEventListener('click', e => {
      const b = e.target.closest('.split-opt');
      if (!b || b.dataset.split === splitMode) return;
      splitMode = b.dataset.split;
      // switching TO "by amount" opens on the even divide, which is both the
      // answer most splits want and the only prefill that can be saved as is
      renderSplitControl(null);
    });
    fs.addEventListener('input', e => {
      if (e.target.classList.contains('split-amt')) $('#splitErr').hidden = true;
    });
    renderSplitControl(it && it.splitAmounts);
  }

  // Which travellers are ticked right now, in roster order. Empty means
  // "Everyone", exactly as it does on a saved item.
  function pickedTravelers() {
    const fs = $('#whoFor');
    if (!fs) return [];
    const names = normalizeTravelers(activeTrip().travelers);
    return [...fs.querySelectorAll('.who-chk input:checked')].map(c => c.value).filter(n => names.includes(n));
  }

  function typedSplitAmounts() {
    const out = {};
    document.querySelectorAll('#splitMode .split-amt').forEach(i => { out[i.dataset.name] = i.value; });
    return out;
  }

  // The "Split evenly / Split by amount" control. It is built ONLY where an
  // uneven split is a real question: two or more people ticked (one person owes
  // the whole thing, nobody ticked is Everyone) and an actual cost to divide.
  // Outside that it is not hidden with amounts waiting inside it, it is emptied,
  // so dropping back to one person or to Everyone discards the numbers rather
  // than saving them behind the traveller's back.
  //
  // `seed` is the amounts to open the inputs on: the saved split when the modal
  // opens, whatever is typed when the tick boxes or the cost move underneath it,
  // and null to re-prefill from the even divide.
  function renderSplitControl(seed) {
    const wrap = $('#splitMode');
    if (!wrap) return;
    const picked = pickedTravelers();
    const raw = $('#inCost').value;
    const cost = raw === '' ? null : roundMoney(raw);
    if (picked.length < 2 || cost == null || isNaN(cost)) {
      splitMode = 'even';
      wrap.hidden = true;
      wrap.innerHTML = '';
      return;
    }
    wrap.hidden = false;
    const even = evenSplitAmounts(cost, picked);
    const val = n => {
      const v = seed ? seed[n] : undefined;
      return (v == null || v === '' || isNaN(v)) ? even[n] : Number(v);
    };
    const sym = currencySymbol($('#inCostCurrency').value);
    const opt = (mode, label) => `<button type="button" class="split-opt${splitMode === mode ? ' on' : ''}"`
      + ` data-split="${mode}" aria-pressed="${splitMode === mode}">${label}</button>`;
    const rows = picked.map(n => `<label class="split-row">`
      + `<span class="split-who">${esc(n)}</span>`
      + `<span class="split-amt-wrap"><span class="split-cur" aria-hidden="true">${esc(sym)}</span>`
      + `<input type="number" class="split-amt" step="0.01" inputmode="decimal" data-name="${esc(n)}" value="${val(n).toFixed(2)}"></span>`
      + `</label>`).join('');
    wrap.innerHTML = `<div class="seg split-seg" role="group" aria-label="How to split this cost">`
      + opt('even', 'Split evenly') + opt('amount', 'Split by amount') + `</div>`
      + (splitMode === 'amount'
        ? `<div class="split-rows">${rows}</div><div class="split-err" id="splitErr" hidden></div>`
        : '');
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
    // deliberately not awaited: opening the modal must not wait on a store
    // read. renderDocsList reports its own failures and never rejects, which is
    // what makes that safe.
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
    // Airports are a flight-only affordance: a train or a taxi has no IATA
    // code, and the row would only be noise on the other four types.
    $('#fFlightRoute').style.display = t === 'flight' ? '' : 'none';
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
    // The rating belongs to a hotel that was picked from the dropdown, so
    // switching the type away from Stay retires it with the picker.
    if (!stay) clearStayRating();
    const meal = $('#mealHint');
    meal.hidden = t !== 'activity';
    if (t === 'activity') {
      meal.textContent = 'Start the title with ' + mealTitlePrefixes().map(p => p.trim()).join(' ')
        + ' to mark it as a meal (its own icon and colour).';
    }
  }

  function clearFieldErrors() {
    document.querySelectorAll('#itemForm .field.invalid').forEach(f => f.classList.remove('invalid'));
    // the split error lives on its own node inside the fieldset, not on a .field
    const se = $('#splitErr');
    if (se) { se.hidden = true; se.textContent = ''; }
    const fe = $('#itemFormErr');
    fe.hidden = true;
    fe.textContent = '';
  }

  // A blocked save that says nothing is the worst thing this form can do, and
  // half its fields are hidden per type: an activity or a note has no end-date
  // field at all (setModalType hides both the check-out field and the arrival
  // row), yet it can carry an end date from an import, a share link or the
  // assistant. Painting that message into a display:none field refused the save
  // in silence. This line lives in the footer, outside the scrolling body, so
  // it is always on screen next to the button that just refused.
  function formError(msg) {
    const fe = $('#itemFormErr');
    fe.textContent = msg;
    fe.hidden = false;
  }

  function submitItemForm(e) {
    e.preventDefault();
    // A second submit event firing back-to-back with no intervening render
    // (a double-click, or two rapid Enter presses) lands after the first one
    // has already saved and closed the overlay; the form's fields are still
    // populated with what was just saved, so without this guard it reads as
    // a second, independently valid Add and creates a duplicate item.
    if (!$('#itemOverlay').classList.contains('open')) return;
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
      confirmation: $('#inConfirmation').value.trim(),
      bookBy: $('#inBookBy').value,
      details: $('#inDetails').value.trim(),
    };
    // "Not tracked" is the absence of a claim, so it stores nothing rather than
    // an empty string every item would then carry
    const payment = $('#inPayment').value;
    if (PAYMENT_METHODS.includes(payment)) it.payment = payment;
    if (it.costCurrency === undefined) delete it.costCurrency;
    // the Maps field is not user-editable, so carry it across an edit instead
    // of silently dropping it
    if (prev.mapsQuery) it.mapsQuery = prev.mapsQuery;
    // A hand-set position belongs to the day and the time it was set on, so it
    // rides an edit that kept both and is dropped by one that moved the item:
    // a row dragged to the top of Tuesday morning has no place in Wednesday's
    // list, and carrying the number there would jump it above rows nobody
    // ordered against it.
    if (Number.isInteger(prev.order) && prev.startDate === it.startDate
      && (prev.startTime || '') === (it.startTime || '')) it.order = prev.order;
    // Who's this for. The control only exists with 2+ travellers, so when it is
    // absent (solo trip, or the read-only shared view) the previous assignment
    // is carried rather than blanked. All-checked and none-checked both collapse
    // to Everyone and store nothing, so a proper subset is the only thing kept.
    let splitErr = '';
    const whoFor = $('#whoFor');
    if (whoFor) {
      const names = normalizeTravelers(activeTrip().travelers);
      const picked = pickedTravelers();
      if (picked.length && picked.length < names.length) it.travelers = picked;
      // A hand-entered split is only stored when it still accounts for the whole
      // cost, and a split that does not is a BLOCKED save rather than a silent
      // fallback: the traveller typed those numbers, so the app has to say the
      // sum is wrong instead of quietly dividing evenly behind them.
      if (splitMode === 'amount' && picked.length >= 2 && it.cost != null) {
        const typed = typedSplitAmounts();
        const custom = {};
        for (const n of picked) custom[n] = typed[n] === '' || typed[n] == null ? '' : roundMoney(typed[n]);
        if (splitAmountsMatch(it.cost, custom, picked)) {
          // named explicitly even when that is everybody: the amounts are keyed
          // by name and mean nothing without the roster they were agreed for
          it.travelers = picked;
          it.splitAmounts = custom;
        } else {
          splitErr = `Split amounts must add up to ${fmtMoneyIn($('#inCostCurrency').value, it.cost)}`;
        }
      }
      // "Not tracked" is the absence of a claim, so it stores nothing at all and
      // the item is worth $0 to the settle-up maths
      const payer = $('#inPaidBy').value;
      if (payer && names.includes(payer)) it.paidBy = payer;
    } else if (Array.isArray(prev.travelers) && prev.travelers.length) {
      it.travelers = prev.travelers;
      // the split rides with the assignment it is keyed by, or the item would
      // come back from a solo-trip edit split evenly among names it still lists
      if (prev.splitAmounts) it.splitAmounts = prev.splitAmounts;
    }
    // the payer field shares the "Who's this for" gate, so on a solo trip or in
    // the read-only shared view it is carried rather than blanked, exactly as
    // the assignment above is
    if (!$('#inPaidBy') && prev.paidBy) it.paidBy = prev.paidBy;
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
      const msg = typeof errs.end === 'string' ? errs.end : '';
      if (modalType === 'stay') {
        $('#fEnd').classList.add('invalid');
        $('#endErr').textContent = msg || 'Check-out must be after check-in.';
      } else if (travel) {
        $('#fArrDate').classList.add('invalid');
        $('#arrErr').textContent = msg || 'Arrival cannot be before departure.';
      } else {
        // No end-date field is on screen for this type, so the message goes to
        // the footer line instead of a hidden one. The date is NAMED rather
        // than quietly dropped: it came from somewhere (an import, a share
        // link), and clearing it to let the save through would destroy it
        // without ever telling the traveller it existed.
        const label = TYPE_META[modalType] ? TYPE_META[modalType].label.toLowerCase() : 'item';
        const why = endOutOfRange ? `it is outside ${DATE_MIN} to ${DATE_MAX}`
          : (isIsoDate(it.endDate) ? "it is before the item's own date" : 'it is not a valid date');
        formError(`This ${label} carries an end date (${it.endDate}) that only a stay or a travel type has a field for, and ${why}. Switch the type to fix it.`);
      }
    }
    if (errs.cost) $('#fCost').classList.add('invalid');
    if (errs.bookBy) {
      $('#fBookBy').classList.add('invalid');
      $('#bookByErr').textContent = typeof errs.bookBy === 'string' ? errs.bookBy : 'Book by must be on or before the item date.';
    }
    // the split error is the same kind of "caught at entry" check the date range
    // above is, so it is raised here rather than in validateItem: an item that
    // arrives with a split that no longer adds up is not an error, it just falls
    // back to the even divide (see customSplitShares)
    if (splitErr) {
      errs.split = true;
      const el = $('#splitErr');
      if (el) { el.textContent = splitErr; el.hidden = false; }
    }
    if (Object.keys(errs).length) {
      // The red field and its message are the whole answer only if you can see
      // them: without this, a blocked save left focus wherever it was (normally
      // #inTitle, from opening the modal), so a keyboard or screen-reader
      // traveller was refused and never told where. Focus lands on the first
      // field that needs fixing, in document order, and only AFTER the messages
      // above are rendered, so the field is already carrying its error when
      // focus arrives on it. The split is looked up on its own because its
      // message hangs off a node inside the fieldset rather than off a .field
      // (see clearFieldErrors), and its rows sit after every other field anyway.
      const firstInvalid = document.querySelector('#itemForm .field.invalid input, #itemForm .field.invalid select, #itemForm .field.invalid textarea')
        || (errs.split ? $('#splitMode .split-amt') : null);
      if (firstInvalid) firstInvalid.focus();
      return;
    }

    const trip = activeTrip();
    if (ui.editingId) {
      const idx = trip.items.findIndex(x => x.id === ui.editingId);
      // A remote merge replaces `db` under an open dialog on purpose (it does
      // not close overlays), so the row being edited can be gone by the time
      // Save is pressed. Pushing it back would resurrect what another device
      // deleted, so the edit is dropped and said out loud instead of throwing
      // into the console with the modal still sitting there.
      if (idx < 0) {
        toastError('That item is no longer in this trip, so nothing was saved');
        closeAllOverlays();
        return;
      }
      it.createdAt = trip.items[idx].createdAt;
      trip.items[idx] = it;
    } else {
      it.createdAt = new Date().toISOString();
      trip.items.push(it);
    }
    // the same save tidies the manual order: the group this item joined or left
    // is renumbered, and a row now tying with nobody drops the field entirely
    normalizeOrders(trip.items);
    save(ui.editingId ? 'Item updated' : 'Item added');
    closeAllOverlays();
    ui.flashId = it.id;
    render();
  }

  // ---------- shifting ----------
  // The widest shift that could still land an in-range date back in range.
  const MAX_SHIFT_DAYS = diffDays(DATE_MIN, DATE_MAX);

  function openShiftModal(target) {
    // target: item id, or null for whole trip
    ui.shiftTarget = target;
    $('#shiftTitle').textContent = target ? 'Shift item dates' : 'Shift entire trip';
    $('#shiftScopeField').style.display = target ? '' : 'none';
    $('#fShiftDays').classList.remove('invalid');
    $('#shiftDays').value = 1;
    openOverlay('#shiftOverlay');
    $('#shiftDays').focus();
  }

  // Every rejection below says so on screen. A shift that quietly closes the
  // dialog is indistinguishable from Cancel, and a shift of 0 is a request the
  // traveller made, not one to swallow.
  function shiftError(msg) {
    $('#fShiftDays').classList.add('invalid');
    $('#shiftErr').textContent = msg;
  }

  function submitShiftForm(e) {
    e.preventDefault();
    const raw = $('#shiftDays').value.trim();
    const days = Number(raw);
    // #shiftForm carries novalidate like #itemForm, so step="1" never fires on a
    // typed value and a fraction has to be refused here, in the app's own voice.
    if (!raw || !Number.isFinite(days)) { shiftError('Enter the number of days to shift by.'); return; }
    if (!Number.isInteger(days)) { shiftError('Shift by a whole number of days.'); return; }
    if (days === 0) { shiftError('A shift of 0 days leaves every date where it is. Use a positive or negative number.'); return; }
    // Same bounds the item form catches a mistyped year with, checked BEFORE
    // anything moves: a shift big enough to push the trip past DATE_MAX only
    // surfaces afterwards as a spanCapped error, on a trip whose dates are
    // already wrecked.
    const rangeMsg = `Shifting by ${days} days would move dates outside the calendar. Use a date between ${DATE_MIN} and ${DATE_MAX}.`;
    // wider than the whole supported calendar, so no date could survive it and
    // addDays would be asked for one the Date object cannot even serialise
    if (Math.abs(days) > MAX_SHIFT_DAYS) { shiftError(rangeMsg); return; }
    const trip = activeTrip();
    let targets;
    if (!ui.shiftTarget) {
      targets = trip.items;
    } else {
      const scope = document.querySelector('input[name="shiftScope"]:checked').value;
      const anchor = trip.items.find(x => x.id === ui.shiftTarget);
      if (!anchor) { closeAllOverlays(); return; }
      if (scope === 'one') targets = [anchor];
      else if (scope === 'all') targets = trip.items;
      else {
        const key = sortKey(anchor);
        targets = trip.items.filter(x => sortKey(x) >= key);
      }
    }
    // A date that is out of range ALREADY is left alone: it arrived that way by
    // import or share link, computeIssues names it, and refusing to shift it
    // would freeze the whole trip. Both halves live in trip-logic, so a
    // template's new start date moves dates the same way this does.
    if (!shiftFits(targets, days)) { shiftError(rangeMsg); return; }
    const moved = applyDayShift(targets, days);
    save(`Shifted ${moved} item${moved === 1 ? '' : 's'} by ${days > 0 ? '+' : ''}${days} day${Math.abs(days) === 1 ? '' : 's'}`);
    closeAllOverlays();
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

  // Editing the roster is not just editing a list of names: submitTripForm
  // deletes paidBy from every item that named someone who is no longer on it.
  // That is money data the dialog cannot give back, and it used to happen
  // without a word. The edit is never blocked - the roster belongs to the
  // traveller - but the cost is spelled out, with the count, while the dialog is
  // still open. The names are matched exactly the way submitTripForm matches
  // them (same normalizeTravelers output, same case-insensitive compare), so
  // this cannot warn about a respelling that will in fact be carried over.
  function syncTravelerWarning() {
    const el = $('#tripTravelersWarn');
    const t = ui.tripModalMode === 'new' ? null : activeTrip();
    if (!t) { el.hidden = true; el.textContent = ''; return; }
    const next = normalizeTravelers($('#inTripTravelers').value.split(','));
    const keep = new Set(next.map(n => n.toLowerCase()));
    // lower-cased name -> { name as the items spell it, how many items name it }
    const dropped = new Map();
    for (const it of t.items) {
      if (!it.paidBy) continue;
      const who = String(it.paidBy).trim();
      const key = who.toLowerCase();
      if (keep.has(key)) continue;
      const rec = dropped.get(key) || { name: who, count: 0 };
      rec.count++;
      dropped.set(key, rec);
    }
    // The packing list pays the same price under the same rule, so it is counted
    // here rather than in a second warning the traveller has to notice
    // separately - and a row that was ONLY for somebody leaving is deleted, not
    // handed to everyone else, so the two costs are counted apart. t.packing
    // rather than packingRows(t), because that is the array submitTripForm
    // hands to the same function: same input, same numbers.
    const pk = packingRosterDrops(t.packing, next);
    for (const rec of pk.names) if (!dropped.has(rec.name.toLowerCase())) dropped.set(rec.name.toLowerCase(), { name: rec.name, count: 0 });
    if (!dropped.size) { el.hidden = true; el.textContent = ''; return; }
    const recs = [...dropped.values()];
    const n = recs.reduce((a, r) => a + r.count, 0);
    // one name leaving can be named; two or more cannot, because a deleted row
    // may have been tagged to any mix of them
    const leaving = recs.length === 1 ? recs[0].name : 'them';
    const what = [];
    if (n) what.push(`clears "paid by" on ${n} item${n === 1 ? '' : 's'}`);
    if (pk.removed) what.push(`deletes ${pk.removed} packing row${pk.removed === 1 ? '' : 's'} that ${pk.removed === 1 ? 'was' : 'were'} only for ${leaving}`);
    if (pk.untagged) what.push(pk.removed ? `untags ${pk.untagged} more` : `untags ${pk.untagged} packing row${pk.untagged === 1 ? '' : 's'}`);
    const which = what.length > 1 ? `${what.slice(0, -1).join(', ')} and ${what[what.length - 1]}` : what[0];
    el.textContent = `Saving removes ${recs.map(r => r.name).join(', ')} from this trip,`
      + (what.length ? ` which ${which}.` : '.')
      + (n ? ' The costs stay; only who paid for them is forgotten.' : '')
      + (pk.untagged ? ' The untagged rows stay on the list, for whoever is left.' : '');
    el.hidden = false;
  }

  // mode: 'new' (empty form), 'rename' (Trip settings), or 'template' (Trip
  // settings on a trip that was just copied from a template, which is the one
  // mode that offers to move every date at once and opens on that field).
  function openTripModal(mode) {
    ui.tripModalMode = mode;
    const t = activeTrip();
    const existing = mode !== 'new' && t;
    $('#tripModalTitle').textContent = mode === 'new' ? 'New trip' : 'Trip settings';
    $('#tripSaveBtn').textContent = mode === 'new' ? 'Create trip' : 'Save';
    $('#tripNameList').innerHTML = sampleTripOptions().map(o => `<option value="${esc(o.place)}">`).join('');
    $('#inTripName').value = existing ? t.name : '';
    syncTripNameHint();
    // Rebuilt from the shared constant on every open: the static 8-option
    // markup predates the full Frankfurter list, and this select is the one
    // place a trip's display currency is actually chosen, so it must offer
    // the same set (and the same legacy-currency fallback group) as every
    // other picker this round widened.
    const tripCur = existing ? (t.currency || 'USD') : 'USD';
    $('#inTripCurrency').innerHTML = currencyOptionsFor(tripCur, [tripCur]);
    $('#inTripCurrency').value = tripCur;
    $('#inTripBudgetTo').value = existing && t.budget != null ? t.budget : '';
    $('#inTripBudgetFrom').value = existing && t.budgetFrom != null ? t.budgetFrom : '';
    $('#inTripTravelers').value = existing && Array.isArray(t.travelers) ? t.travelers.join(', ') : '';
    syncTravelerWarning();
    syncTripStartField();
    $('#fTripName').classList.remove('invalid');
    $('#fTripBudget').classList.remove('invalid');
    $('#fTripStart').classList.remove('invalid');
    openOverlay('#tripOverlay');
    // a template's whole reason for existing is the new dates, so that is the
    // field the dialog opens on; every other mode still opens on the name
    if (mode === 'template' && !$('#fTripStart').hidden) $('#inTripStart').focus();
    else $('#inTripName').focus();
  }

  // The "Starts on" field exists only in template mode. Trip settings on any
  // other trip is the dialog it has always been, with no trace of it in the DOM.
  function syncTripStartField() {
    const f = $('#fTripStart');
    const t = activeTrip();
    const from = ui.tripModalMode === 'template' && t ? firstItemDate(t.items) : null;
    f.hidden = !from;
    $('#inTripStart').value = '';
    $('#inTripStart').disabled = !from;
    if (from) $('#tripStartHint').textContent = `Copied from ${fmtDate(from)}. Pick the new first day and every date moves with it, keeping the same gaps. Leave it blank to keep these dates.`;
  }

  function submitTripForm(e) {
    e.preventDefault();
    const name = $('#inTripName').value.trim();
    // Both errors are cleared before either is raised: the budget check below is
    // now reachable (see novalidate), so a resubmit can leave the form open with
    // the OTHER field's message still on screen next to a value that is fine.
    $('#fTripName').classList.remove('invalid');
    $('#fTripBudget').classList.remove('invalid');
    if (!name) { $('#fTripName').classList.add('invalid'); return; }
    const currency = $('#inTripCurrency').value;
    // #tripForm carries novalidate like #itemForm, so the inputs' native min="0"
    // never fires on a typed value and this is the whole budget gate: a
    // negative end, a floor above the ceiling, or a floor with no ceiling.
    const range = readBudgetRange($('#inTripBudgetFrom').value.trim(), $('#inTripBudgetTo').value.trim());
    if (!range.ok) { $('#tripBudgetErr').textContent = range.error; $('#fTripBudget').classList.add('invalid'); return; }
    const budget = range.to;
    const budgetFrom = range.from;
    $('#fTripStart').classList.remove('invalid');
    // A template's new start date is checked BEFORE anything is written, for the
    // same reason "Shift entire trip" checks its own: a half-applied move leaves
    // a trip whose dates are wrong in a way nothing on screen explains.
    let plan = null;
    if (ui.tripModalMode === 'template' && !$('#fTripStart').hidden && $('#inTripStart').value) {
      const to = $('#inTripStart').value;
      plan = startDateShift(activeTrip().items, to);
      if (!plan || !isDateInRange(to)) { tripStartError(`Use a date between ${DATE_MIN} and ${DATE_MAX}.`); return; }
      if (!shiftFits(activeTrip().items, plan.days)) {
        tripStartError(`Starting on ${fmtDate(to)} would move dates outside the calendar. Use a date between ${DATE_MIN} and ${DATE_MAX}.`);
        return;
      }
    }
    // trimmed, deduped, capped at 6 by the one gate in trip-logic; an empty list
    // leaves the trip with no `travelers` key at all, so a solo trip is byte for
    // byte the trip it was before this field existed
    const travelers = normalizeTravelers($('#inTripTravelers').value.split(','));
    if (ui.tripModalMode === 'new') {
      const t = { id: uid(), name, currency, budget, items: [] };
      // only a trip that set a lower end carries the key at all, so a plain
      // ceiling (and no budget) stores byte for byte what it always did
      if (budgetFrom != null) t.budgetFrom = budgetFrom;
      if (travelers.length) t.travelers = travelers;
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
      if (budgetFrom != null) t.budgetFrom = budgetFrom;
      else delete t.budgetFrom;
      if (travelers.length) t.travelers = travelers;
      else delete t.travelers;
      // Editing the roster must not leave items pointing at a payer who is no
      // longer on it. A respelling (case, or a rename that keeps the person)
      // follows the roster; anyone dropped from it takes their payer flag with
      // them, so no item can owe money to a name the trip does not carry.
      for (const it of t.items) {
        if (!it.paidBy) continue;
        const payer = travelers.find(n => n.toLowerCase() === String(it.paidBy).trim().toLowerCase());
        if (payer) it.paidBy = payer;
        else delete it.paidBy;
      }
      // and neither can a packing row stay tagged for somebody the trip no
      // longer names: it keeps whoever is left, and a row that named ONLY people
      // who are gone goes with them. t.packing itself, because deleting a row
      // means splicing the trip's own array - and because it is what
      // syncTravelerWarning just counted, so the warning cannot promise one
      // thing and this do another
      applyPackingRoster(t.packing, travelers);
      if (ui.packingFilter && !travelers.includes(ui.packingFilter)) ui.packingFilter = '';
      // the dates move last, so a refused shift above cannot have already
      // renamed the trip
      if (plan && plan.days) applyDayShift(t.items, plan.days);
    }
    save(ui.tripModalMode === 'new' ? `Trip "${name}" created` : 'Trip updated');
    closeAllOverlays();
    render();
  }

  function tripStartError(msg) {
    $('#fTripStart').classList.add('invalid');
    $('#tripStartErr').textContent = msg;
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

  // The other half of Duplicate: the same trip with every booking fact stripped
  // off it (tripAsTemplate), landed on the trip dialog so the one thing a
  // template is missing - when it happens - can be answered immediately. The
  // source trip is not read again after the copy is taken, so it cannot change.
  // Fresh item ids are what leave the source's attached documents behind: those
  // are stored in IndexedDB against the item id, never on the item.
  function duplicateAsTemplate() {
    const t = activeTrip();
    const copy = tripAsTemplate(t);
    copy.id = uid();
    copy.name = `${t.name} (template)`;
    copy.items.forEach(it => { it.id = uid(); });
    db.trips.push(copy);
    db.activeTripId = copy.id;
    save('Template created');
    render();
    openTripModal('template');
  }

  // ---------- trip essentials ----------
  // The "if something goes wrong" block: who to call, who insures you, what a
  // stranger would need to know. It lives on the trip itself (trip.essentials),
  // exactly like the packing list, so it rides every mechanism the trip already
  // has (save() as the undo choke point, one localStorage key, sync-system
  // carrying that key) and is deleted with the trip.
  // Being TRIP-level is also what keeps it private: the CSV and the .ics are
  // built from items alone, and slimTripForShare copies an explicit whitelist of
  // trip keys, so none of the three can carry a medical note by accident.
  const ESSENTIAL_FIELDS = [
    { key: 'contactName', input: '#inEssContactName', max: 60 },
    { key: 'contactPhone', input: '#inEssContactPhone', max: 30 },
    { key: 'insurer', input: '#inEssInsurer', max: 60 },
    { key: 'insurerPhone', input: '#inEssInsurerPhone', max: 60 },
    { key: 'medical', input: '#inEssMedical', max: 300 },
  ];

  // storage and imported files are untrusted JSON, so every read is clamped here
  function readEssentials(src) {
    const raw = src && src.essentials && typeof src.essentials === 'object' ? src.essentials : {};
    const out = {};
    for (const f of ESSENTIAL_FIELDS) out[f.key] = String(raw[f.key] == null ? '' : raw[f.key]).trim().slice(0, f.max);
    return out;
  }
  // a blank field is ABSENT rather than an empty string, so a trip that never
  // used this is byte for byte the trip it was before the field existed
  function packEssentials(vals) {
    const out = {};
    for (const f of ESSENTIAL_FIELDS) if (vals[f.key]) out[f.key] = vals[f.key];
    return out;
  }
  const formEssentials = () => {
    const out = {};
    for (const f of ESSENTIAL_FIELDS) out[f.key] = $(f.input).value.trim().slice(0, f.max);
    return out;
  };

  function openEssentialsModal() {
    const trip = activeTrip();
    if (!trip) return;
    const vals = readEssentials(trip);
    for (const f of ESSENTIAL_FIELDS) $(f.input).value = vals[f.key];
    syncEssentialsEmpty();
    openOverlay('#essentialsOverlay');
    $(ESSENTIAL_FIELDS[0].input).focus();
  }

  // the empty line answers the dialog's own question, so it tracks what is
  // typed rather than only what was last saved
  function syncEssentialsEmpty() {
    const typed = formEssentials();
    $('#essentialsEmpty').hidden = ESSENTIAL_FIELDS.some(f => typed[f.key]);
  }

  function submitEssentialsForm(e) {
    e.preventDefault();
    const trip = activeTrip();
    if (!trip) return;
    const before = JSON.stringify(trip.essentials || null);
    const next = packEssentials(formEssentials());
    if (Object.keys(next).length) trip.essentials = next;
    else delete trip.essentials;
    // a save that changed nothing must not offer an Undo: it would step back
    // over whatever edit came before this dialog was opened
    const changed = JSON.stringify(trip.essentials || null) !== before;
    save('Trip essentials saved', changed ? undo : null);
    closeAllOverlays();
    syncUndoButtons();
  }

  // ---------- search across every trip ----------
  // The toolbar search filters the trip you are looking at. This one answers the
  // other question ("which trip did I put that rail pass confirmation in") by
  // reading db.trips directly, so a trip you have not opened all year matches.
  const TRIP_SEARCH_MAX = 20;

  function tripSearchMatches(q) {
    const needle = q.toLowerCase();
    const rows = [];
    for (const t of db.trips) {
      for (const it of (Array.isArray(t.items) ? t.items : [])) {
        // the same four haystack fields matchesFilters searches, including the
        // confirmation code: pasting a code out of an email is the whole point
        const hay = `${it.title || ''} ${it.location || ''} ${it.details || ''} ${it.confirmation || ''}`.toLowerCase();
        if (hay.includes(needle)) rows.push({ tripId: t.id, tripName: t.name || '', id: it.id, title: it.title || '', date: it.startDate || '' });
      }
    }
    // trip name, then date. An undated item sorts to the END of its trip rather
    // than the top, where an empty string would otherwise put it.
    // The date leg compares by CODE POINT, not localeCompare: ICU collation
    // treats "~" as punctuation and sorts it BEFORE digits
    // ("~".localeCompare("2026-08-18") === -1), which put every undated item at
    // the TOP of its trip - the exact opposite of what the "~" sentinel is for.
    // ISO dates are ASCII, so a plain codepoint compare orders them correctly
    // and leaves "~" (0x7E) above every digit, as intended.
    const byDate = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
    rows.sort((a, b) => a.tripName.localeCompare(b.tripName)
      || byDate(a.date || '~', b.date || '~')
      || a.title.localeCompare(b.title));
    return rows;
  }

  function renderTripSearch() {
    const q = $('#tripSearchInput').value.trim();
    const box = $('#tripSearchResults');
    // one character matches most of everything, so the panel keeps saying what
    // it is for until the query is worth running
    if (q.length < 2) {
      const n = db.trips.length;
      box.innerHTML = `<p class="ts-note">Type to search across your ${n} ${n === 1 ? 'trip' : 'trips'}</p>`;
      return;
    }
    const rows = tripSearchMatches(q);
    if (!rows.length) {
      box.innerHTML = `<p class="ts-note">No items match "${esc(q)}" in any trip</p>`;
      return;
    }
    const shown = rows.slice(0, TRIP_SEARCH_MAX);
    const more = rows.length - shown.length;
    box.innerHTML = shown.map(r => `
      <button type="button" class="ts-row" data-ts-trip="${esc(r.tripId)}" data-ts-item="${esc(r.id)}">
        <span class="ts-title">${esc(r.title || '(untitled)')}</span>
        <span class="ts-meta">
          <span class="ts-date">${esc(isIsoDate(r.date) ? fmtDate(r.date) : 'No date')}</span>
          <span class="ts-trip">${esc(r.tripName)}</span>
        </span>
      </button>`).join('')
      + (more ? `<p class="ts-note ts-more">+${more} more - narrow your search</p>` : '');
  }

  // The two header popovers borrow the modal focus contract (openOverlay /
  // closeOverlay): whoever opened one gets the focus back when it closes, so
  // dismissing search does not strand a keyboard user on a now-hidden input.
  // Only ONE of them can be open at a time (each opener closes the other), so
  // one slot is enough. Paths that deliberately hand focus somewhere else clear
  // the slot BEFORE closing: picking a search result (focus follows the jump),
  // choosing a menu action that opens a dialog (the dialog owns focus), and
  // either opener replacing the other popover (the new opener holds focus).
  let popoverReturnFocus = null;
  function returnPopoverFocus() {
    const el = popoverReturnFocus;
    popoverReturnFocus = null;
    if (!el || !document.contains(el) || typeof el.focus !== 'function') return;
    // Reclaim only the focus the popover itself was holding, or focus the
    // dismissal dropped on nothing. An outside click that landed on another
    // control has already given focus to something the traveller chose, and
    // stealing it back would lose their place rather than keep it.
    const a = document.activeElement;
    if (a && a !== document.body && !$('#tripSearch').contains(a) && !$('#tripMenu').contains(a)) return;
    el.focus();
  }

  // What a shared view is allowed to do from the trip menu. Everything else
  // writes to a trip the visitor does not own, and save() is a no-op there, so
  // those rows are DISABLED rather than left looking live and doing nothing
  // when pressed, which is what every blocked row used to do. The menu holds 15
  // rows and this list allows 5, so 10 are blocked; the count is deliberately
  // not spelled out again below, because the last one written here went stale
  // the moment a row was added.
  //
  // "Backup all trips" is deliberately not on this list even though it only
  // reads: shared mode parks the visitor's own trips aside and leaves `db`
  // holding nothing but the borrowed trip, so the file it writes would be
  // named like a full backup while containing a stranger's itinerary and none
  // of their own.
  //
  // The 12/24-hour toggle IS on it. It is a device display preference written
  // to its own TIMEFMT_KEY, never to a trip; blocking it would make the one
  // harmless row in the menu look broken for no gain.
  const SHARED_MENU_ACTS = ['export-trip', 'export-csv', 'export-ics', 'export-gpx', 'share-trip', 'timefmt'];
  function syncTripMenuShared() {
    for (const b of $('#tripMenu').querySelectorAll('.tp-menu-panel button[data-act]')) {
      b.disabled = sharedMode && !SHARED_MENU_ACTS.includes(b.dataset.act);
    }
  }

  // A GPX file is nothing but coordinates, and coordinates only exist for
  // places the Map view has already looked up. So the row says why it cannot
  // run instead of downloading an empty (or one-waypoint) file: two is the
  // floor because a route needs somewhere to go. Readiness is expressed as
  // aria-disabled, NOT the native attribute: a disabled button receives no
  // hover events, so the title explaining why it cannot run never appeared -
  // the row just sat there greyed and mute. The click dispatcher enforces it
  // instead. Native `disabled` stays the shared-mode mechanism alone
  // (syncTripMenuShared), so the two never fight over the same attribute.
  function syncGpxMenuRow() {
    const btn = $('#tripMenu').querySelector('button[data-act="export-gpx"]');
    const ready = gpxStops(activeTrip()).length >= 2;
    if (ready) btn.removeAttribute('aria-disabled');
    else btn.setAttribute('aria-disabled', 'true');
    btn.title = ready ? '' : 'Needs at least two located places (open the Map view once)';
  }

  function openTripMenu() {
    popoverReturnFocus = null; // the search panel is being replaced, not dismissed
    closeTripSearch();
    syncTripMenuShared();
    syncGpxMenuRow();
    $('#tripMenu').classList.add('open');
    popoverReturnFocus = $('#tripMenuBtn');
  }
  function closeTripMenu() {
    $('#tripMenu').classList.remove('open');
    returnPopoverFocus();
  }

  function openTripSearch() {
    popoverReturnFocus = null; // the menu is being replaced, not dismissed
    closeTripMenu();
    $('#tripSearch').classList.add('open');
    $('#tripSearchBtn').setAttribute('aria-expanded', 'true');
    renderTripSearch();
    // the query survives a close so you can pick a second result, but it is
    // pre-selected: one keystroke replaces it
    $('#tripSearchInput').focus();
    $('#tripSearchInput').select();
    popoverReturnFocus = $('#tripSearchBtn');
  }
  function closeTripSearch() {
    $('#tripSearch').classList.remove('open');
    $('#tripSearchBtn').setAttribute('aria-expanded', 'false');
    returnPopoverFocus();
  }

  function jumpToSearchResult(tripId, itemId) {
    const trip = db.trips.find(t => t.id === tripId);
    if (!trip) return;
    if (db.activeTripId !== tripId) { db.activeTripId = tripId; save(); }
    popoverReturnFocus = null; // the jump, not the search button, is where you now are
    closeTripSearch();
    // the same jump the Issues list, the night strip and the Up next chip use
    ui.view = 'timeline';
    ui.flashId = itemId;
    render();
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
  // The GPX export spends the geocode cache the Map view already filled and
  // never asks for a coordinate of its own: Nominatim is one request a second
  // under a policy that forbids bulk, so a menu click must not queue a dozen.
  // A stop the cache does not hold is simply not in the file.
  function gpxStops(trip) {
    const out = [];
    for (const stop of mapStops(trip)) {
      const hit = geoCache[stop.key];
      // the traveller's own place name, not the geocoder's: "Tokyo" is what
      // they typed and what they will look for in their GPS app
      if (hit && Number.isFinite(hit.lat) && Number.isFinite(hit.lon)) {
        out.push({ name: stop.name, lat: hit.lat, lon: hit.lon });
      }
    }
    return out;
  }
  function exportGpx() {
    const t = activeTrip();
    download(`${slug(t.name)}-route.gpx`, buildGpx(gpxStops(t)), 'application/gpx+xml');
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
        toastError(`Import failed: ${err.message}`);
      }
    };
    // A read that never completes (the file moved, a permissions error, an
    // unreadable device) fired nothing at all, so the picker closed and the
    // traveller was told nothing. Same voice as the parse failures above.
    reader.onerror = () => toastError('Import failed: the file could not be read');
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
    // the optional lower end of a budget range, refused on its own terms: the
    // ceiling above is what every total is judged against, so a bad floor never
    // takes it down with it
    const budgetFrom = normalizeBudgetFrom(t.budgetFrom, budget.value);
    if (budgetFrom.reason) notes.push(`The lower end of the trip budget ${budgetFrom.reason}, so it was left unset.`);
    // clamp to 6 trimmed unique names FIRST: the item sanitizer needs the final
    // list to reject an item assigned to someone the trip does not name
    const travelers = normalizeTravelers(t.travelers);
    const nt = {
      id: uid(),
      name: String(t.name || 'Imported trip').slice(0, 60),
      currency: /^[A-Z]{3}$/.test(t.currency || '') ? t.currency : 'USD',
      budget: budget.value,
      visaExtras: (Array.isArray(t.visaExtras) ? t.visaExtras : []).filter(c => typeof c === 'string' && /^[A-Z]{2}$/.test(c)),
      items: t.items.map(raw => sanitizeItem(raw, notes, travelers)).filter(Boolean),
    };
    // an incoming file's numbering is trusted as an ORDER and never as the exact
    // numbers: each ordered group is renumbered 0..n-1 here, and a number left
    // on an item that ties with nobody is dropped
    normalizeOrders(nt.items);
    if (budgetFrom.value != null) nt.budgetFrom = budgetFrom.value;
    if (travelers.length) nt.travelers = travelers;
    // the emergency/insurance/medical block is trip-level, so a JSON export and
    // a full backup both carry it and re-importing one has to hand it back. A
    // share link never carries it in the first place (see slimTripForShare), so
    // this reads as absent there and the imported trip simply has none.
    const essentials = packEssentials(readEssentials(t));
    if (Object.keys(essentials).length) nt.essentials = essentials;
    // the packing list is trip-level state like the essentials block, so a JSON
    // export and a full backup both carry it and re-importing one has to hand it
    // back. The ARRAY'S EXISTENCE is the "already seeded" flag (see
    // ensurePacking), so an EMPTY list has to survive as an empty list: a
    // traveller who deliberately cleared every row must not be handed the
    // defaults back by the import. Rows are rebuilt field by field with the
    // form's own 80-character limit, and 200 of them is far past any real list.
    if (Array.isArray(t.packing)) {
      const rows = [];
      let unreadable = 0, overflow = 0;
      for (const r of t.packing) {
        const text = r && typeof r.text === 'string' ? r.text.trim().slice(0, 80) : '';
        if (!text) { unreadable++; continue; }
        if (rows.length === 200) { overflow++; continue; }
        const row = { id: uid(), text, done: r.done === true };
        // who the row is for rides along, clamped to the roster this import just
        // settled on: a name the file made up cannot smuggle a seventh traveller
        // onto the trip, and a row tagged for everybody is stored as untagged
        // exactly as the dialog would have stored it
        const who = packingWho(r, travelers);
        if (travelers.length >= 2 && who.length && who.length < travelers.length) row.who = who;
        rows.push(row);
      }
      nt.packing = rows;
      if (unreadable) notes.push(`Packing list: ${unreadable} row${unreadable === 1 ? '' : 's'} had no text, so ${unreadable === 1 ? 'it was' : 'they were'} left out.`);
      if (overflow) notes.push(`Packing list: only the first 200 rows were imported, so ${overflow} more were left out.`);
    }
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

  function sanitizeItem(raw, drops, knownTravelers) {
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
      // same 40 as the form: an import or a share link must not be able to
      // smuggle in a code longer than the field that has to render it
      confirmation: String(raw.confirmation || '').slice(0, 40),
      // a booking deadline that is not a real date is dropped rather than
      // imported as a warning nobody can act on
      bookBy: isIsoDate(raw.bookBy) ? raw.bookBy : '',
      details: String(raw.details || '').slice(0, 500),
      createdAt: new Date().toISOString(),
    };
    if (PAYMENT_METHODS.includes(raw.payment)) out.payment = raw.payment;
    // A hand-set same-day order round-trips: an export or a share link that
    // reshuffled the day it describes would be a worse copy than none. Anything
    // that is not a small whole number is dropped, and the group it lands in is
    // renumbered by the caller's normalizeOrders pass.
    if (Number.isInteger(raw.order) && raw.order >= 0 && raw.order < ORDER_MAX) out.order = raw.order;
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
    // who a cost is split between is only meaningful against names the trip
    // actually carries: an import can list anyone, so each is matched (case
    // -insensitively) to a known traveller and mapped to that canonical spelling.
    // An empty or all-hands result is Everyone and stays unset, unless a
    // hand-entered split needs that roster named (see the split block below).
    const known = normalizeTravelers(knownTravelers);
    const canon = new Map(known.map(n => [n.toLowerCase(), n]));
    const canonName = n => canon.get(String(n == null ? '' : n).trim().toLowerCase());
    const picked = [];
    if (known.length >= 2 && Array.isArray(raw.travelers)) {
      for (const n of raw.travelers) {
        const c = canonName(n);
        if (c && !picked.includes(c)) picked.push(c);
      }
      if (picked.length && picked.length < known.length) out.travelers = picked;
    }
    // who paid gets the same clamp: a payer the incoming trip does not name is
    // dropped rather than imported as a debt owed to a stranger
    if (known.length >= 2 && raw.paidBy != null) {
      const payer = canonName(raw.paidBy);
      if (payer) out.paidBy = payer;
    }
    // and so does a hand-entered split. Dropping it left the receiving end
    // showing an EVEN divide of the same cost, i.e. a confidently wrong answer
    // to "who owes whom" (a 70/30 import settled as 50/50), which is exactly
    // what slimTripForShare carries it to avoid. The amounts are keyed by
    // traveller, so every key goes through the same canonical roster match as
    // `travelers` above and every value through the same parseMoney the cost
    // uses: a hand-edited "abc" or 1e999 cannot get in. One bad key or amount
    // drops the WHOLE object rather than storing a half-valid split.
    // A split that no longer ADDS UP to the cost is kept as given: it is
    // customSplitShares that re-checks the total at read time and falls back to
    // the even divide, which is the forgiving answer untrusted numbers deserve.
    const rawSplit = raw.splitAmounts;
    if (known.length >= 2 && rawSplit && typeof rawSplit === 'object' && !Array.isArray(rawSplit) && Object.keys(rawSplit).length) {
      // a Map, not an object literal, so a traveller literally named
      // "__proto__" cannot turn an import into a prototype write
      const split = new Map();
      let bad = '';
      for (const [name, val] of Object.entries(rawSplit)) {
        const who = canonName(name);
        if (!who || split.has(who)) { bad = 'names someone the trip does not'; break; }
        const amount = parseMoney(val);
        if (!amount.ok || amount.value == null) { bad = `has an amount that ${amount.reason || 'is missing'}`; break; }
        split.set(who, amount.value);
      }
      // The amounts only mean anything against the roster they were agreed for,
      // so they are honoured only when the item is assigned to exactly the
      // people they name; no `travelers` key means Everyone, i.e. all of them.
      // On the way in that assignment is then made EXPLICIT even when it is
      // everybody, exactly as saving the form does (see submitItemForm): the
      // all-hands case otherwise collapsed back to Everyone above, leaving
      // customSplitShares with no roster and the same wrong even divide.
      const assigned = picked.length ? picked : known;
      if (!bad && !(split.size >= 2 && assigned.length === split.size && assigned.every(n => split.has(n)))) {
        bad = 'does not cover exactly the people that cost is for';
      }
      if (bad) notes.push(`"${label}": the custom cost split ${bad}, so it was dropped and that cost divides evenly.`);
      else {
        out.travelers = known.filter(n => split.has(n));
        out.splitAmounts = Object.fromEntries(out.travelers.map(n => [n, split.get(n)]));
      }
    }
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

  // ---------- import from a booking confirmation ----------
  // Reads a flight or hotel confirmation and offers the items it found as
  // ordinary proposal cards, so accepting one goes through exactly the same
  // validation, undo and save path as an assistant suggestion.
  //
  // THE FILE NEVER LEAVES THE DEVICE AND IS NEVER STORED. It is read into
  // memory, turned into text, and dropped. Nothing is written to the documents
  // pocket, nothing is uploaded, and no model is called: the reader in
  // trip-logic is entirely deterministic.

  /** Unescapes a PDF literal string: \( \) \\ \n \t and \ddd octal. */
  function pdfLiteral(s) {
    return s.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_, c) => {
      const simple = { n: '\n', r: '', t: ' ', b: '', f: '', '(': '(', ')': ')', '\\': '\\' };
      return simple[c] !== undefined ? simple[c] : String.fromCharCode(parseInt(c, 8));
    });
  }

  // Text-showing operators out of one decoded content stream. Tm counts as a
  // line break as well as Td/TD/T*: plenty of generators position every line
  // with a text matrix and never emit Td, which collapses a whole document
  // onto one line if you only watch for Td.
  function pdfStreamText(content) {
    const re = /\((?:\\.|[^\\()])*\)|\bTJ\b|\bTj\b|\bT\*\b|\bTD\b|\bTd\b|\bTm\b|\bET\b/g;
    const out = [];
    let line = [];
    let m;
    while ((m = re.exec(content))) {
      if (m[0].startsWith('(')) line.push(pdfLiteral(m[0].slice(1, -1)));
      else if (line.length) { out.push(line.join('')); line = []; }
    }
    if (line.length) out.push(line.join(''));
    return out.join('\n');
  }

  // pdf.js, vendored under vendor/pdfjs/ the way Leaflet already is and loaded
  // ONLY when a PDF is actually chosen. It is 1.7 MB, which is why it is not
  // in the service worker's precache: the runtime cache picks it up after the
  // first successful use, so it costs nothing until someone imports a PDF and
  // nothing again after that.
  //
  // WHY IT IS HERE AT ALL. The forty-line reader below handles PDFs that write
  // their text as plain `(literal) Tj` operators. Real confirmations mostly do
  // not: anything printed from a browser or generated by an airline embeds a
  // SUBSET font and writes glyph indices instead, so the naive reader pulls out
  // fragments like "fi" and nothing else. Measured against a Chrome-printed
  // confirmation it recovered 2 characters of 300. pdf.js maps glyphs back
  // through the font's ToUnicode table, which is the whole job.
  let pdfjsPromise = null;
  function ensurePdfJs() {
    if (!pdfjsPromise) {
      // Resolved against the DOCUMENT, explicitly. A bare specifier in a
      // dynamic import from a classic script resolves against the script's
      // base URL, which is a different directory here and quietly produced a
      // module that never loaded. new URL() removes the ambiguity, and it is
      // the same anchor ensureLeaflet and workerSrc already use.
      const base = document.baseURI;
      pdfjsPromise = import(new URL('vendor/pdfjs/pdf.min.mjs', base).href)
        .then(mod => {
          mod.GlobalWorkerOptions.workerSrc = new URL('vendor/pdfjs/pdf.worker.min.mjs', base).href;
          return mod;
        })
        .catch(() => { pdfjsPromise = null; return null; });
    }
    return pdfjsPromise;
  }

  // pdf.js normally parses in a module worker. THIS CODE DELIBERATELY DOES NOT.
  //
  // A booking confirmation is one or two pages and parses in about ten
  // milliseconds in-process, which is imperceptible and happens only when
  // someone explicitly imports a file - so a worker buys nothing here. What it
  // costs is a whole class of environment-dependent failure: where module
  // workers are restricted the worker simply never answers, and pdf.js holds
  // on to the one it already made, so retrying afterwards does not recover
  // either. Measured in that state the dialog sat for eight seconds and then
  // gave up on a PDF it could have read instantly.
  //
  // So the worker is skipped from the start: pdf.js falls back to parsing
  // in-process when it cannot construct a Worker, and construction is made to
  // fail for exactly the length of the call. Nothing else in this app
  // constructs a Worker and the window is a few milliseconds. The timeout
  // below is a safety net, not the normal path.
  const PDF_PARSE_TIMEOUT_MS = 8000;

  /** Text of every page, in reading order, one line per text run. */
  async function pdfToTextViaPdfJs(bytes) {
    const pdfjs = await ensurePdfJs();
    if (!pdfjs) return null;
    // A copy: pdf.js transfers the buffer to its worker, which would detach
    // the caller's view and break the fallback below.
    const realWorker = window.Worker;
    window.Worker = function () { throw new Error('pdf.js: parsing on the main thread'); };
    let task;
    let timer;
    let doc;
    try {
      task = pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false });
      doc = await Promise.race([
        task.promise,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('pdf worker timeout')), PDF_PARSE_TIMEOUT_MS); }),
      ]);
    } finally {
      clearTimeout(timer);
      window.Worker = realWorker;
      if (!doc && task) { try { task.destroy(); } catch { /* already gone */ } }
    }
    const out = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const content = await (await doc.getPage(n)).getTextContent();
      let line = [];
      for (const it of content.items) {
        if (typeof it.str === 'string') line.push(it.str);
        // pdf.js marks a hard line break on the item that ends one
        if (it.hasEOL) { out.push(line.join('').trim()); line = []; }
      }
      if (line.length) out.push(line.join('').trim());
    }
    try { await doc.destroy(); } catch { /* nothing to clean up */ }
    return out.join('\n');
  }

  // A failure is a null return rather than a rejection the caller has to
  // remember to catch.
  async function pdfTextOrNull(bytes) {
    try { return await pdfToTextViaPdfJs(bytes); }
    catch { return null; }
  }

  // Fallback for when pdf.js cannot load at all, which in practice means
  // offline before it has ever been cached. Handles only the plain-literal
  // case; the caller checks whether what came back is actually words.
  async function pdfToText(bytes) {
    const raw = new TextDecoder('latin1').decode(bytes);
    const chunks = [];
    const re = /stream\r?\n?([\s\S]*?)endstream/g;
    let m;
    while ((m = re.exec(raw))) {
      const body = m[1];
      let decoded = null;
      if (typeof DecompressionStream !== 'undefined') {
        const enc = new Uint8Array(body.length);
        for (let i = 0; i < body.length; i++) enc[i] = body.charCodeAt(i) & 0xff;
        for (const fmt of ['deflate', 'deflate-raw']) {
          try {
            const s = new DecompressionStream(fmt);
            const wr = s.writable.getWriter();
            // These reject when the bytes are not this codec, and an unhandled
            // rejection per failed probe means dozens of console errors for one
            // PDF. The read below is what actually decides success.
            wr.write(enc).catch(() => {});
            wr.close().catch(() => {});
            decoded = new TextDecoder('latin1').decode(await new Response(s.readable).arrayBuffer());
            break;
          } catch { /* not this codec */ }
        }
      }
      if (!decoded && /\bT[Jj]\b/.test(body)) decoded = body;   // uncompressed
      if (decoded && /\bT[Jj]\b/.test(decoded)) chunks.push(pdfStreamText(decoded));
    }
    return chunks.join('\n');
  }

  // A PDF whose fonts are subset with a custom encoding yields glyph indices
  // rather than words, which looks like text but reads as mojibake. Rather
  // than hand that to the extractor and produce confident nonsense, the ratio
  // of ordinary letters decides whether we got words at all.
  function looksLikeProse(text) {
    const t = String(text || '');
    if (t.replace(/\s/g, '').length < 20) return false;
    const letters = (t.match(/[A-Za-z]/g) || []).length;
    return letters / t.replace(/\s/g, '').length > 0.35;
  }

  let importText = '';

  function openImportBookingModal() {
    importText = '';
    $('#importBookingFile').value = '';
    $('#importBookingPaste').value = '';
    setImportState('<div class="m-empty"><span class="me-ico" aria-hidden="true">📄</span>'
      + '<span class="me-title">Read a booking confirmation</span>'
      + '<span>Pick the PDF your airline or hotel sent, or a calendar file (.ics), or paste the '
      + 'text of it. Nothing is uploaded and the file is not saved: it is read on this device '
      + 'and discarded.</span></div>');
    openOverlay('#importBookingOverlay');
  }

  function setImportState(html) { $('#importBookingResult').innerHTML = html; }

  async function readBookingFile(file) {
    if (!file) return;
    setImportState('<div class="route-loading"><span class="spinner"></span>Reading the file...</div>');
    let text = '';
    // Set when pdf.js opened the document fine and found (almost) no text in
    // it. That is a different diagnosis from "could not decode": the pages
    // are pictures or vector outlines of letters, so no PDF tool can copy
    // text out of this file, and the advice has to say so.
    let noTextLayer = false;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const isPdf = String.fromCharCode(...bytes.slice(0, 5)) === '%PDF-';
      if (!isPdf) {
        text = new TextDecoder().decode(bytes);
      } else {
        // pdf.js first because it is the one that reads real confirmations;
        // the built-in reader only covers for it being unreachable.
        text = await pdfTextOrNull(bytes);
        if (text !== null && text.replace(/\s/g, '').length < 20) noTextLayer = true;
        if (!looksLikeProse(text)) text = await pdfToText(bytes);
        if (!looksLikeProse(text)) text = ''; else noTextLayer = false;
      }
    } catch { text = ''; }
    if (!text.trim()) {
      if (noTextLayer) {
        // The honest version: selecting and copying inside this PDF cannot
        // work either, so do not send anyone off to try it.
        setImportState('<div class="m-empty err"><span class="me-ico" aria-hidden="true">🖼️</span>'
          + '<span class="me-title">This PDF is a picture of text</span>'
          + '<span>The file opened fine, but its pages contain no actual text: every letter is '
          + 'stored as an image or as drawn shapes. Scans do this, and so do some "print to PDF" '
          + 'tools (Microsoft Print to PDF is a common culprit). No app can copy text out of a '
          + 'file like this, so selecting and copying inside the PDF will not work either.</span>'
          + '<span><strong>What works instead:</strong> go back to where the PDF came from - the '
          + 'confirmation email or the airline\'s booking page - select the text there, copy it, '
          + 'and paste it into the box above. If you need a readable PDF, save the page again '
          + 'using the browser\'s own "Save as PDF" destination rather than a printer driver.</span></div>');
        return;
      }
      setImportState('<div class="m-empty err"><span class="me-ico" aria-hidden="true">🚫</span>'
        + '<span class="me-title">This file could not be read</span>'
        + '<span>It stores its text in a way this reader does not handle. Open the PDF, select '
        + 'all, copy, and paste it into the box above. If nothing can be selected in the PDF '
        + 'either, copy the text from the confirmation email or booking page it came from '
        + 'instead: that always works.</span></div>');
      return;
    }
    runBookingExtraction(text);
  }

  // A calendar file is not prose to be guessed at: it carries labelled fields,
  // so it gets the exact reader for them. Both ways in (the file picker and the
  // paste box) funnel through runBookingExtraction, so this one test covers
  // both, and it tests the CONTENT rather than the file name: an .ics saved as
  // .txt is still a calendar, and a confirmation that merely mentions the word
  // "calendar" is still prose.
  function looksLikeCalendar(text) {
    return /BEGIN:VCALENDAR/i.test(text);
  }

  function runIcsImport(text) {
    const res = parseIcsToProposals(text);
    const { events, read, skipped, recurring } = res.stats;
    if (!res.proposals.length) {
      setImportState('<div class="m-empty err"><span class="me-ico" aria-hidden="true">🗓️</span>'
        + `<span class="me-title">${events ? 'None of those events could be read' : 'No events in that calendar'}</span>`
        + '<span>' + (events
          ? `The file holds ${events} event${events === 1 ? '' : 's'}, but none of them has a start date this reader can use.`
          : 'The file is a calendar but contains no events. Export it again from your calendar app with the dates you want included.')
        + '</span></div>');
      return;
    }
    const box = document.createElement('div');
    box.className = 'import-found';
    const parts = [`Read ${read} of ${events} event${events === 1 ? '' : 's'}`];
    if (skipped) parts.push(`; ${skipped} could not be read`);
    parts.push('.');
    // Said out loud because the file does not say it: DTSTART is only the FIRST
    // date of a repeating event, and nothing here expands the rest.
    if (recurring) {
      parts.push(recurring === 1 ? ' One of them repeats' : ` ${recurring} of them repeat`);
      parts.push(', and only the first date was read.');
    }
    box.innerHTML = `<p class="import-order">${esc(parts.join(''))}</p>`;
    setImportState('');
    $('#importBookingResult').appendChild(box);

    // The same proposal machinery the PDF reader hands off to: same validation,
    // same accept path, same undo. Nothing is stored on the way through - the
    // text was never written anywhere but this function's argument.
    const container = document.createElement('div');
    container.className = 'assist-proposals';
    $('#importBookingResult').appendChild(container);
    renderProposals(res.proposals.map(p => ({ op: 'add', item: p.item, source: 'document' })), container);
  }

  async function runBookingExtraction(text) {
    importText = text;
    if (looksLikeCalendar(text)) { runIcsImport(text); return; }
    // The airport table is what turns "LHR" into a route at all, so it has to
    // be here before we read anything. It is normally loaded by the flight
    // form; on this path nothing has opened one yet.
    const airports = await loadAirports();
    const res = extractBookings(text, { airports });
    if (!res.proposals.length) {
      setImportState('<div class="m-empty err"><span class="me-ico" aria-hidden="true">🤷</span>'
        + '<span class="me-title">Nothing could be read with confidence</span>'
        + '<span>No flight or hotel details could be picked out of that text. Adding the item by '
        + 'hand will be quicker than fighting it.</span></div>');
      return;
    }
    const box = document.createElement('div');
    box.className = 'import-found';
    // The day-first / month-first question only exists for all-numeric dates
    // ("08/12/2027"). On a document whose dates are all spelled out ("Tue,
    // Dec 29") the default-order note is unanswerable noise, so it is only
    // shown when a numeric date is actually on the page.
    const hasNumericDate = res.lines.some(l => /\b\d{1,2}[\/.]\d{1,2}[\/.]\d{4}\b/.test(l));
    const orderLine = {
      document: () => `Dates read ${res.order.dayFirst ? 'day-first' : 'month-first'}, settled by the document itself.`,
      plausibility: () => `Dates read ${res.order.dayFirst ? 'day-first' : 'month-first'}. Nothing on the page settles the order, so this was inferred from what makes a possible trip. Worth a look.`,
      conflict: () => 'This document writes dates in BOTH orders, so none of them can be trusted. Check every date below.',
      default: () => (hasNumericDate
        ? `No date on the page settles day-first from month-first, so they are read ${res.order.dayFirst ? 'day-first' : 'month-first'}. Check them.`
        : ''),
    }[res.order.source];
    const orderText = orderLine ? orderLine() : '';
    box.innerHTML = orderText ? `<p class="import-order">${esc(orderText)}</p>` : '';
    for (const p of res.proposals) {
      const card = document.createElement('div');
      card.className = 'import-read';
      card.innerHTML = `<div class="ir-head"><span class="ir-kind">${esc(p.kind)}</span>`
        + `<span class="ir-conf ir-${esc(p.confidence)}">${esc(p.confidence)} confidence</span></div>`
        + `<dl class="ir-fields">${p.evidence.map(e => `<dt>${esc(e.field)}</dt>`
          + `<dd><span class="ir-line">line ${e.line + 1}</span>${esc(e.raw.slice(0, 90))}</dd>`).join('')}</dl>`
        + (p.warnings.length
          ? `<ul class="ir-warn">${p.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : '');
      box.appendChild(card);
    }
    setImportState('');
    $('#importBookingResult').appendChild(box);

    // Hand off to the ordinary proposal machinery: same validation, same
    // accept path, same undo. `source: 'document'` is what lets a transcribed
    // confirmation code and a booked status through (see sanitizeActionFields).
    const container = document.createElement('div');
    container.className = 'assist-proposals';
    $('#importBookingResult').appendChild(container);
    renderProposals(res.proposals.map(p => ({ op: 'add', item: p.item, source: 'document' })), container);
  }

  async function shareTrip() {
    if (typeof CompressionStream === 'undefined') { toastError('Sharing is not supported in this browser'); return; }
    const t = activeTrip();
    const json = JSON.stringify({ version: 1, trip: slimTripForShare(t) });
    const compressed = await streamThrough(CompressionStream, new TextEncoder().encode(json));
    const url = shareBaseUrl() + SHARE_PREFIX + bytesToBase64url(compressed);
    // The fragment never travels to a server, so browsers handle very long
    // links fine; the real-world limit is chat apps truncating them. Hard
    // stop only at absurd sizes, advisory warning in between.
    if (url.length > 30000) { toastError('This trip is too large to share by link. Use Export trip (JSON) instead.'); return; }
    // Item count only, never the link: the share URL's fragment encodes the
    // entire trip, including confirmation numbers typed into Details.
    track('trackAction', 'trip_shared', {
      item_count: Array.isArray(t.items) ? t.items.length : 0,
    });
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
    if (typeof DecompressionStream === 'undefined') { toastError('Sharing is not supported in this browser'); return null; }
    try {
      const bytes = base64urlToBytes(hash.slice(SHARE_PREFIX.length));
      const out = await streamThrough(DecompressionStream, bytes);
      const parsed = JSON.parse(new TextDecoder().decode(out));
      const trip = parsed && parsed.trip;
      if (!trip || !Array.isArray(trip.items)) throw new Error('bad payload');
      return trip;
    } catch { toastError('This share link could not be opened'); return null; }
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

  // ---------- venue coordinates (the ladder behind every distance chip) ----------
  // City centroids come from the geocode cache above. A venue - a restaurant, a
  // museum, the hotel itself - needs a finer point than "Tokyo", and it must
  // never come from Nominatim: that queue is one request a second and its usage
  // policy forbids bulk. So venue points come from two sources that are already
  // paid for or already open:
  //   1. the tp-places ratings call, which now returns the resolved place's
  //      coordinates from the Place Details response it already pays for;
  //   2. Photon (the hotel picker's service), lazily, only for venues on rows
  //      that are actually on screen and that (1) did not cover.
  // Both land in one persistent, capped store, never synced (the sync key list
  // is an allowlist and this key is not on it) and expiring on the 30-day
  // schedule Google's caching terms allow for coordinates.
  const VENUE_GEO_KEY = 'trip-planner:venuegeo:v1';
  let venueCache = {};
  try { venueCache = normalizeVenueCache(JSON.parse(localStorage.getItem(VENUE_GEO_KEY) || '{}'), Date.now()); }
  catch { venueCache = {}; }
  function saveVenueCache() {
    try { localStorage.setItem(VENUE_GEO_KEY, JSON.stringify(venueCache)); } catch { /* cache is best-effort */ }
  }
  function rememberVenuePoint(key, coord) {
    rememberVenue(venueCache, key, coord, Date.now());
  }

  // Photon is a free, shared, unpaid service: the hotel picker debounces at
  // 320ms and never fires under three characters for exactly that reason.
  // Distances ask it for whole rows at a time, so the traffic is bounded three
  // ways - two at once, six started per repaint, and a session ceiling - and a
  // resolved venue is then cached for 30 days, so a returning traveller's trip
  // costs nothing at all.
  const VENUE_CONCURRENCY = 2;
  const VENUE_PASS_MAX = 6;
  const VENUE_SESSION_MAX = 40;
  // A repaint runs before the ratings batch it races has landed, and the Places
  // answer is the better one (it is the place the card links to). Waiting a
  // beat means the common case never asks Photon at all.
  const VENUE_LOOKUP_DELAY = 1500;
  const venueQueue = [];
  const venueQueued = new Set();
  const venueMisses = new Set();
  let venueBusy = 0;
  let venueLookups = 0;
  let venueTimer = 0;

  function queueVenueLookups(queries) {
    if (!navigator.onLine) return;
    let added = 0;
    for (const q of queries) {
      if (added >= VENUE_PASS_MAX || venueLookups + venueQueue.length >= VENUE_SESSION_MAX) break;
      const key = placeCacheKey(q);
      if (!key || venueCache[key] || venueQueued.has(key) || venueMisses.has(key)) continue;
      // the ratings call is in flight for this exact venue and answers with a
      // better point; asking Photon too would be the same lookup twice
      if (placesInFlight.has(key)) continue;
      venueQueued.add(key);
      venueQueue.push({ key, query: q });
      added++;
    }
    if (!venueQueue.length || venueTimer) return;
    venueTimer = setTimeout(() => { venueTimer = 0; pumpVenue(); }, VENUE_LOOKUP_DELAY);
  }

  function pumpVenue() {
    while (venueBusy < VENUE_CONCURRENCY && venueQueue.length) {
      const job = venueQueue.shift();
      if (venueCache[job.key]) { venueQueued.delete(job.key); continue; }
      venueBusy++;
      venueLookups++;
      fetchVenuePoint(job).finally(() => {
        venueBusy--;
        venueQueued.delete(job.key);
        pumpVenue();
      });
    }
  }

  // Not the hotel picker's request: no tourism tag filter (a ramen counter is
  // not lodging) and no shared abort controller (these run in parallel with
  // each other and with whatever the traveller is typing). A miss is remembered
  // for the session so a row that Photon cannot place is asked once.
  function fetchVenuePoint(job) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 7000);
    return fetch(`${HOTEL_API}?q=${encodeURIComponent(job.query)}&limit=5&lang=en`, { signal: ctrl.signal })
      .then(r => { if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
      .then(json => {
        const hit = pickVenueFeature(job.query, json);
        if (!hit) { venueMisses.add(job.key); return; }
        rememberVenuePoint(job.key, hit);
        saveVenueCache();
        scheduleDistanceRepaint();
      })
      // offline, rate-limited or simply unfindable: the row keeps whatever the
      // city centroid gave it, which is usually no chip at all
      .catch(() => { /* leave the row without a chip */ })
      .finally(() => clearTimeout(timer));
  }

  // The ladder itself, cache-only in every rung: venue coordinates, then the
  // hotel's own coordinates when the traveller picked the stay from the hotel
  // picker (rememberPickedHotel seeds the geocode cache under the hotel NAME),
  // then the city centroid. null when nothing locates it, which renders as no
  // chip rather than a guess.
  function venuePoint(query) {
    const key = placeCacheKey(query);
    const rec = key && venueCache[key];
    return rec ? { key: 'v:' + key, lat: rec.lat, lon: rec.lon } : null;
  }
  function cityPoint(name) {
    const key = String(name || '').trim().toLowerCase();
    const hit = key && geoCache[key];
    return hit && Number.isFinite(hit.lat) ? { key: 'c:' + key, lat: hit.lat, lon: hit.lon } : null;
  }
  // `name` is the hotel-picker rung and is only ever passed for a stay: an
  // activity called "Kyoto" must not borrow the city's centroid through it.
  function placePoint({ query, name, city }) {
    return venuePoint(query) || (name ? cityPoint(name) : null) || cityPoint(city);
  }

  // ---------- distance chips (Days rows + assistant cards) ----------
  // Every chip is painted from the caches only, so the pass is idempotent and a
  // re-render with a warm cache issues no request at all. What a row or a card
  // needs to locate itself is STAMPED on the element when it renders (see
  // itemDistAttrs), which is what lets this be a pure read of the DOM plus the
  // caches: it can run again after any lookup lands without the caller having
  // to hold on to the data the view was built from.
  function distAttrs(query, name, city, label) {
    return ` data-dist-q="${esc(query || '')}" data-dist-name="${esc(name || '')}"`
      + ` data-dist-city="${esc(city || '')}" data-dist-label="${esc(label || '')}"`;
  }
  // The hotel-picker rung is only offered to a stay: it looks the TITLE up in
  // the geocode cache, which is a hotel's own doorstep for a stay and a
  // coincidence for anything else.
  function itemDistAttrs(it) {
    return distAttrs(itemMapsQuery(it), isStay(it) ? displayTitle(it) : '', (it.location || '').trim(), displayTitle(it));
  }
  // The airports table is the precise rung for an "(KEF)"-style arrival
  // anchor: exact coordinates, no geocoder, and the file already ships with
  // the app (it is in the service worker's precache, so this works offline
  // too). Until the rows are loaded the city rung answers instead, and
  // paintDayDistances kicks the load off and repaints when it lands.
  function airportPointByIata(code) {
    if (!code || !airportRows) return null;
    const row = airportRows.find(r => r.iata === code);
    return row && Number.isFinite(row.lat) && Number.isFinite(row.lon)
      ? { key: 'a:' + code, lat: row.lat, lon: row.lon } : null;
  }

  function readPoint(el, kind) {
    if (!el) return null;
    const d = el.dataset;
    const anchor = kind === 'anchor';
    const label = anchor ? d.anchorLabel : d.distLabel;
    if (label === undefined) return null;
    if (anchor && d.anchorIata) {
      const ap = airportPointByIata(d.anchorIata);
      if (ap) return { ...ap, label };
    }
    const p = placePoint({
      query: anchor ? d.anchorQ : d.distQ,
      name: anchor ? d.anchorName : d.distName,
      city: anchor ? d.anchorCity : d.distCity,
    });
    return p ? { ...p, label } : null;
  }
  // A venue worth asking Photon about: it has a query of its own and no cached
  // point yet. Collected while painting, so only rows that are on screen right
  // now can ever cause a lookup.
  function wantVenue(list, query) {
    if (query && !venueCache[placeCacheKey(query)]) list.push(query);
  }

  function writeDistChip(row, leg) {
    const facts = row.querySelector('.dc-facts');
    if (!facts) return;
    let chip = facts.querySelector('.dc-dist');
    if (!leg) { if (chip) chip.remove(); return; }
    if (!chip) {
      chip = document.createElement('span');
      chip.className = 'dc-dist';
      // between the price and the Maps button: it is a fact about the row, not
      // an action, so it sits with the price rather than after the button
      facts.insertBefore(chip, facts.querySelector('.tp-maps-link'));
    }
    chip.textContent = distanceChipLabel(leg.km);
    chip.title = distanceChipTitle(leg.km, leg.from);
  }

  let airportKickoff = false;
  function paintDayDistances(wanted) {
    document.querySelectorAll('#daysList .day-card').forEach(cardEl => {
      // an arrival-day anchor needs the airports table; load it once on the
      // first card that asks and repaint when it lands. On a failed load the
      // kickoff flag stays set - retrying on every paint would loop - and the
      // city rung keeps answering for the rest of the session.
      if (cardEl.dataset.anchorIata && !airportRows && !airportKickoff) {
        airportKickoff = true;
        loadAirports().then(() => { if (airportRows) refreshDistances(); });
      }
      wantVenue(wanted, cardEl.dataset.anchorQ);
      const anchor = readPoint(cardEl, 'anchor');
      const rows = [...cardEl.querySelectorAll('.dc-event[data-dist-label]')];
      const stops = rows.map((row, i) => {
        wantVenue(wanted, row.dataset.distQ);
        const p = readPoint(row, 'dist');
        return p ? { ...p, id: i } : { id: i };
      });
      const legs = new Map(dayDistanceChain(anchor, stops).map(l => [l.id, l]));
      rows.forEach((row, i) => writeDistChip(row, legs.get(i)));
    });
  }

  // The point the assistant's chips measure from: the focus day's own anchor
  // (its covering stay, else its morning city) until the traveller accepts
  // something, and after that the place they just accepted, so the next chips
  // answer "how far from where I have now decided to be".
  let assistAcceptedPoint = null;
  function assistAnchorPoint() {
    if (assistAcceptedPoint) return assistAcceptedPoint;
    const trip = activeTrip();
    if (!trip || !isIsoDate(assistFocusDate)) return null;
    const spec = dayAnchor(trip.items, assistFocusDate, geoResolved);
    if (!spec) return null;
    // an 'arrival' spec is a travel leg, not a place: the airport rung (or
    // its city fallback) locates it, never the venue/name rungs
    const p = (spec.iata && airportPointByIata(spec.iata))
      || (spec.item && spec.source !== 'arrival'
        ? placePoint({ query: itemMapsQuery(spec.item), name: displayTitle(spec.item), city: spec.city })
        : cityPoint(spec.city));
    return p ? { ...p, label: spec.label } : null;
  }

  // Scoped to the assistant's own log on purpose: the booking-import dialog
  // renders the SAME proposal cards, and a flight read off a confirmation
  // measured from the assistant's focus-day hotel would be a number about
  // nothing. Its cards carry the (empty, hidden) slot and no chip.
  function paintAssistDistances(wanted) {
    const anchor = assistAnchorPoint();
    document.querySelectorAll('#assistMessages .ap-dist').forEach(el => {
      wantVenue(wanted, el.dataset.distQ);
      const p = readPoint(el, 'dist');
      // one leg through the same builder the day chain uses, so a recommendation
      // at the hotel's own address is suppressed by the same rule
      const leg = p ? dayDistanceChain(anchor, [{ ...p, id: 0 }])[0] : null;
      if (!leg) { el.textContent = ''; el.removeAttribute('title'); return; }
      el.textContent = distanceChipLabel(leg.km);
      el.title = distanceChipTitle(leg.km, leg.from);
    });
    paintAssistRoutes(anchor);
  }

  // The order pill and the footer are painted together and removed together:
  // they are one statement, and half of it (a numbered card with no route line,
  // or a route naming a card that has since been accepted) would be worse than
  // neither. An alternative set is ONE stop, taken at the option currently
  // selected in it: picking one of three dinners is a choice about the same
  // slot, not three stops on a walk.
  function addOrderPill(card, n, anchorLabel) {
    const op = card.querySelector('.ap-op');
    if (!op) return;
    const pill = document.createElement('span');
    pill.className = 'ap-order';
    pill.textContent = String(n);
    pill.title = `Stop ${n} on the shortest route from ${anchorLabel}`;
    op.insertBefore(pill, op.firstChild);
  }

  function paintAssistRoutes(anchor) {
    document.querySelectorAll('#assistMessages .assist-proposals').forEach(box => {
      box.querySelectorAll('.ap-order').forEach(el => el.remove());
      box.querySelectorAll('.assist-route').forEach(el => el.remove());
      if (!anchor) return;
      const byDate = new Map();
      box.querySelectorAll('.assist-proposal[data-op="add"]').forEach(card => {
        // an accepted or stale card has had its body replaced, so its slots are
        // gone and it drops out of the route by construction
        const slots = card.classList.contains('assist-set')
          ? [...card.querySelectorAll('.as-opt')]
          : [card];
        if (!slots.length) return;
        const date = card.dataset.date || '';
        if (!byDate.has(date)) byDate.set(date, []);
        const group = byDate.get(date);
        group.push({
          card,
          options: slots.map(el => readPoint(el.querySelector('.ap-dist'), 'dist')),
          // nothing picked yet: the set stands at its first option, which is
          // what its cards are already ordered by
          selected: Math.max(0, slots.findIndex(el => el.querySelector('input[type="radio"]:checked'))),
        });
      });
      for (const group of byDate.values()) {
        const stops = routeStops(group.map((e, i) => ({ id: i, options: e.options, selected: e.selected })));
        if (stops.length < 2) continue;
        const route = shortestRoute(anchor, stops);
        if (!route) continue;
        route.stops.forEach((s, i) => addOrderPill(group[s.id].card, i + 1, anchor.label));
        const footer = document.createElement('div');
        footer.className = 'assist-route';
        footer.textContent = routeFooterText(anchor.label, route.stops.map(s => s.label), route.km);
        group[stops[stops.length - 1].id].card.after(footer);
      }
    });
  }

  // The one entry point: paint everything from the caches, then ask for the
  // venues the painting found missing. Called after every render of the days
  // grid or a batch of proposals, and again whenever a lookup lands.
  function refreshDistances() {
    const wanted = [];
    paintDayDistances(wanted);
    paintAssistDistances(wanted);
    queueVenueLookups(wanted);
  }
  let distTimer = 0;
  function scheduleDistanceRepaint() {
    if (distTimer) return;
    distTimer = setTimeout(() => { distTimer = 0; refreshDistances(); }, 60);
  }

  // ---------- combobox primitive (shared by the city and airport pickers) ----------
  // One control, two sources: cities come from Open-Meteo over the network,
  // airports from a table bundled with the app. Both render the same two-line
  // row and follow the ARIA 1.2 combobox pattern (aria-expanded on the input,
  // a role=listbox popup, aria-activedescendant tracking the highlight).
  //
  // WHY NOT <datalist>, which this app used for the route fields: it cannot
  // show the second line, and the second line IS the feature. "Paris" and
  // "Paris" are the same string in a datalist; "Paris, Île-de-France, France"
  // and "Paris, Texas, United States" are the whole reason to have a picker.
  //
  // WHY THE POPUP LIVES ON <body>: .m-body is an overflow-y:auto scroller, so
  // a dropdown positioned inside a field gets clipped at the modal's bottom
  // edge, which is exactly where the lower fields need to open one. Fixed
  // positioning off getBoundingClientRect avoids that; the cost is having to
  // reposition on scroll and resize, which is what `place()` below is for.
  const CB_LIMIT = 8;
  let cbSeq = 0;
  const cbOpen = new Set();

  function createCombobox(input, opts) {
    const id = `cb-list-${++cbSeq}`;
    const pop = document.createElement('div');
    pop.className = 'cb-pop';
    pop.id = id;
    pop.setAttribute('role', 'listbox');
    pop.hidden = true;
    document.body.appendChild(pop);

    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-controls', id);
    input.setAttribute('autocomplete', 'off');

    let rows = [];
    let active = -1;
    let token = 0;
    let timer = 0;
    let selfInput = false;   // see pick(): our own synthetic `input` echo

    // Anchored to the input in viewport coordinates, flipping above the field
    // when there is more room up than down (the last field in a tall modal).
    function place() {
      const r = input.getBoundingClientRect();
      const below = window.innerHeight - r.bottom;
      pop.style.left = `${Math.max(8, r.left)}px`;
      pop.style.width = `${r.width}px`;
      if (below < 180 && r.top > below) {
        pop.style.top = 'auto';
        pop.style.bottom = `${window.innerHeight - r.top + 4}px`;
        pop.style.maxHeight = `${Math.max(80, Math.min(300, r.top - 12))}px`;
      } else {
        pop.style.bottom = 'auto';
        pop.style.top = `${r.bottom + 4}px`;
        pop.style.maxHeight = `${Math.max(80, Math.min(300, below - 12))}px`;
      }
    }

    function close() {
      if (pop.hidden) return;
      pop.hidden = true;
      cbOpen.delete(api);
      active = -1;
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
    }

    function setActive(i) {
      active = i;
      [...pop.children].forEach((el, n) => {
        const on = n === i;
        el.classList.toggle('on', on);
        el.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      if (i >= 0 && pop.children[i]) {
        input.setAttribute('aria-activedescendant', pop.children[i].id);
        pop.children[i].scrollIntoView({ block: 'nearest' });
      } else {
        input.removeAttribute('aria-activedescendant');
      }
    }

    function render(list) {
      rows = list;
      if (!rows.length) return close();
      pop.innerHTML = rows.map((row, i) => {
        const r = opts.render(row);
        // TAG BEFORE SUB, and the order matters: .cb-opt is a two-column grid
        // whose .cb-sub spans both columns, so a row carrying BOTH (the hotel
        // picker: "Kyoto, Japan" + a HOTEL pill) auto-placed the tag onto a
        // third row where the 1fr column stretched it into a full-width bar.
        // No picker set both until now, which is why the markup could hold
        // this order and look correct everywhere.
        return `<div class="cb-opt" role="option" id="${id}-o${i}" aria-selected="false">`
          + `<span class="cb-main">${esc(r.primary)}</span>`
          + (r.tag ? `<span class="cb-tag">${esc(r.tag)}</span>` : '')
          + (r.secondary ? `<span class="cb-sub">${esc(r.secondary)}</span>` : '')
          + '</div>';
      }).join('');
      pop.hidden = false;
      cbOpen.add(api);
      input.setAttribute('aria-expanded', 'true');
      place();
      setActive(-1);
    }

    function pick(i) {
      const row = rows[i];
      if (!row) return;
      input.value = opts.value(row);
      close();
      if (opts.onPick) opts.onPick(row, input);
      // Downstream listeners (the route modal's Check button, the item form's
      // dirty tracking) listen for `input`, and setting .value fires nothing.
      // The flag keeps our OWN listener out of it: without it the echo
      // re-searches the text we just wrote and the dropdown springs straight
      // back open under the traveller, offering the row they already chose.
      // dispatchEvent is synchronous, so clearing it on the next line is safe.
      selfInput = true;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      selfInput = false;
    }

    function search() {
      const q = input.value.trim();
      const mine = ++token;
      // One input can be a combobox for one type of item and a plain text
      // field for the other five (#inTitle: a hotel picker on a stay, a free
      // title everywhere else). Asked every search rather than at attach time,
      // because the type switches under a form that is already open.
      if (opts.enabled && !opts.enabled()) return close();
      if (q.length < (opts.minChars || 2)) return close();
      Promise.resolve(opts.rows(q))
        .then(list => { if (mine === token) render((list || []).slice(0, CB_LIMIT)); })
        .catch(() => { if (mine === token) close(); });
    }

    input.addEventListener('input', () => {
      if (selfInput) return;
      clearTimeout(timer);
      timer = setTimeout(search, opts.debounce == null ? 220 : opts.debounce);
    });
    input.addEventListener('focus', () => { if (input.value.trim()) search(); });
    input.addEventListener('blur', () => { clearTimeout(timer); close(); });

    input.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown' && pop.hidden) { search(); return; }
      if (pop.hidden) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive((active + 1) % rows.length); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((active - 1 + rows.length) % rows.length); }
      else if (e.key === 'Enter') {
        // Only swallow Enter when a row is actually highlighted. Otherwise the
        // key still submits the item form, which is what a traveller who typed
        // a place we do not list expects it to do.
        if (active >= 0) { e.preventDefault(); pick(active); }
        else close();
      } else if (e.key === 'Escape') {
        // The overlay closes on Escape too; swallow it so the first press only
        // dismisses the dropdown and the traveller does not lose the form.
        e.preventDefault(); e.stopPropagation(); close();
      } else if (e.key === 'Tab') { close(); }
    });

    // pointerdown, not click: click lands after blur has already closed the
    // popup, so the row would be gone before the event reached it.
    pop.addEventListener('pointerdown', e => {
      const opt = e.target.closest('.cb-opt');
      if (!opt) return;
      e.preventDefault();  // keep focus on the input
      pick([...pop.children].indexOf(opt));
    });

    const api = { close, place, input };
    return api;
  }

  // Fixed-position popups do not move with their anchor, so anything that
  // scrolls or resizes has to push them back. Capture phase catches the
  // modal body's own scroll, which does not bubble.
  const repositionCombos = () => cbOpen.forEach(cb => cb.place());
  window.addEventListener('scroll', repositionCombos, true);
  window.addEventListener('resize', repositionCombos);

  // ---------- city picker source (Open-Meteo geocoding) ----------
  // Keyless, CORS-open and explicitly built for typeahead. Nominatim, which
  // geocode() above uses for one-shot lookups, forbids autocomplete against
  // its public instance, so it deliberately is NOT the source here.
  const PLACE_API = 'https://geocoding-api.open-meteo.com/v1/search';
  const placeSuggestCache = new Map();
  let placeAbort = null;

  function fetchPlaceSuggestions(q) {
    const key = q.toLowerCase();
    if (placeSuggestCache.has(key)) return Promise.resolve(placeSuggestCache.get(key));
    if (placeAbort) placeAbort.abort();
    placeAbort = new AbortController();
    const ctrl = placeAbort;
    const timeout = setTimeout(() => ctrl.abort(), 7000);
    return fetch(`${PLACE_API}?name=${encodeURIComponent(q)}&count=10&language=en&format=json`, { signal: ctrl.signal })
      .then(r => { if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
      .then(json => {
        const rows = rankPlaceResults(q, json, CB_LIMIT);
        // Bounded so a long session of typing cannot grow this without limit.
        if (placeSuggestCache.size > 120) placeSuggestCache.clear();
        placeSuggestCache.set(key, rows);
        return rows;
      })
      // Offline or rate-limited is not an error state worth shouting about:
      // the field is still a plain text input and typing a place still works.
      .catch(() => [])
      .finally(() => clearTimeout(timeout));
  }

  // Places already in this trip, offered first. This is what the old
  // `placeList` datalist did, kept because re-typing "Kyoto" for the fifth
  // activity is the single most common thing anyone does in this form.
  function tripPlaceRows(q) {
    const f = foldPlace(q);
    const seen = new Set();
    const out = [];
    for (const it of activeTrip().items) {
      const loc = (it.location || '').trim();
      if (!loc || seen.has(loc.toLowerCase())) continue;
      if (!foldPlace(loc).includes(f)) continue;
      seen.add(loc.toLowerCase());
      out.push({ value: loc, label: loc, detail: '', inTrip: true });
      if (out.length >= 3) break;
    }
    return out;
  }

  function placeRows(q) {
    const local = tripPlaceRows(q);
    return fetchPlaceSuggestions(q).then(remote => {
      const have = new Set(local.map(r => r.value.toLowerCase()));
      return [...local, ...remote.filter(r => !have.has(r.value.toLowerCase()))];
    });
  }

  // A picked row is a FACT the traveller asserted, so it seeds the geocode
  // cache directly and the app never spends a Nominatim call on that name
  // again. `conf` is 'confident' on purpose: classifyGeoMatch exists to judge
  // a guess made FOR the traveller from an ambiguous string, and the visa
  // dialog gates on it because picking the wrong "Nara" states a false entry
  // requirement. None of that applies once a human has chosen the row that
  // says "Nara, Japan" out of a list that also offered Nara, Mali.
  //
  // A shared or imported trip carries only the location STRING, so the
  // recipient's browser re-geocodes it through Nominatim and lands back on
  // the old, gated behaviour. That is a safe degradation, not a regression.
  function rememberPickedPlace(row) {
    if (!row || row.inTrip || !Number.isFinite(row.lat)) return;
    const key = String(row.value || '').trim().toLowerCase();
    if (!key) return;
    geoCache[key] = {
      lat: row.lat, lon: row.lon, name: row.value,
      cc: row.cc, country: row.country, conf: 'confident',
    };
    geoMisses.delete(key);
    try { localStorage.setItem(GEO_KEY, JSON.stringify(geoCache)); } catch { /* cache is best-effort */ }
  }

  const renderPlaceRow = row => ({
    primary: row.value,
    secondary: row.inTrip ? '' : (row.detail || ''),
    tag: row.inTrip ? 'in this trip' : '',
  });

  function attachPlacePicker(input) {
    return createCombobox(input, {
      rows: placeRows,
      render: renderPlaceRow,
      value: row => row.value,
      onPick: rememberPickedPlace,
    });
  }

  // ---------- hotel picker source (Photon, OpenStreetMap) ----------
  // See the block comment over rankHotelResults in trip-logic.js for why this
  // is a live lookup rather than a bundled table like the airports, and why
  // Photon rather than the two geocoders already wired up.
  const HOTEL_API = 'https://photon.komoot.io/api/';
  const HOTEL_TAG_Q = [...HOTEL_TAGS.keys()].map(t => 'osm_tag=' + encodeURIComponent('tourism:' + t)).join('&');
  const hotelSuggestCache = new Map();
  let hotelAbort = null;

  // The city already typed into the Place field, and its coordinates if the
  // geocode cache happens to know them. Both are optional: the picker works
  // with neither, it just ranks worse.
  function hotelBias() {
    const city = ($('#inLocation').value || '').trim();
    const hit = city ? geoCache[city.toLowerCase()] : null;
    return {
      city,
      lat: hit && Number.isFinite(hit.lat) ? hit.lat : null,
      lon: hit && Number.isFinite(hit.lon) ? hit.lon : null,
    };
  }

  function fetchHotelSuggestions(q, bias) {
    // Keyed on the city too: the same three letters mean different hotels once
    // the traveller fills the Place field in, and a cache that ignored it
    // would serve the pre-city answer for the rest of the session.
    const key = `${q.toLowerCase()}|${(bias.city || '').toLowerCase()}`;
    if (hotelSuggestCache.has(key)) return Promise.resolve(hotelSuggestCache.get(key));
    if (hotelAbort) hotelAbort.abort();
    hotelAbort = new AbortController();
    const ctrl = hotelAbort;
    const timeout = setTimeout(() => ctrl.abort(), 7000);
    // lat/lon ONLY. The spike tried Photon's location_bias_scale and zoom and
    // both made the bias WORSE (they reverted the order to the unbiased one),
    // and a bbox is worse still: it hard-filters, so "ace hotel" in a city
    // whose Ace is not in OSM returned an EMPTY list instead of the nearest
    // real answers. A weak bias that never empties the list beats a strong one
    // that sometimes does.
    const at = (Number.isFinite(bias.lat) && Number.isFinite(bias.lon)) ? `&lat=${bias.lat}&lon=${bias.lon}` : '';
    return fetch(`${HOTEL_API}?q=${encodeURIComponent(q)}&limit=12&lang=en&${HOTEL_TAG_Q}${at}`, { signal: ctrl.signal })
      .then(r => { if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
      .then(json => {
        const rows = rankHotelResults(q, json, bias.city, CB_LIMIT);
        if (hotelSuggestCache.size > 120) hotelSuggestCache.clear();
        hotelSuggestCache.set(key, rows);
        return rows;
      })
      // Same posture as the city picker: offline or rate-limited is not an
      // error worth shouting about. The field is still a plain text input and
      // typing a hotel name still works.
      .catch(() => [])
      .finally(() => clearTimeout(timeout));
  }

  // A picked hotel is a FACT, exactly as a picked city is (see
  // rememberPickedPlace): it seeds the geocode cache under the hotel's own
  // name with the hotel's own coordinates. That is the real prize here. A
  // stay's map pin, its leg distances and its route legs were all derived by
  // geocoding the CITY string, so every hotel in Kyoto sat on the same pin;
  // now the one the traveller picked sits on its own doorstep.
  function rememberPickedHotel(row) {
    if (!row || !Number.isFinite(row.lat)) return;
    const key = String(row.value || '').trim().toLowerCase();
    if (!key) return;
    geoCache[key] = {
      lat: row.lat, lon: row.lon, name: row.value,
      cc: row.cc, country: row.country, conf: 'confident',
    };
    geoMisses.delete(key);
    try { localStorage.setItem(GEO_KEY, JSON.stringify(geoCache)); } catch { /* cache is best-effort */ }
    // Filling an EMPTY Place field is a convenience; overwriting a filled one
    // would fight a traveller who deliberately wrote "Gion, Kyoto".
    const loc = $('#inLocation');
    if (!loc.value.trim() && row.locality) loc.value = row.locality;
    $('#fTitle').classList.remove('invalid');
    showStayRating(row);
  }

  // The ONE paid call in this feature, and it fires on a pick rather than on a
  // keystroke: typing is free (Photon), and Google is asked only once a human
  // has committed to a hotel. Everything it needs already exists - the batched
  // proxy, the session cache, the quota stop and the attribution chip - so
  // this is a slot plus a hydrate call, not a second integration.
  function showStayRating(row) {
    const slot = $('#stayRating');
    if (!slot) return;
    const q = [row.value, row.locality, row.country].filter(Boolean).join(', ');
    slot.innerHTML = ratingSlotHtml(q);
    slot.hidden = false;
    hydrateRatings(slot);
  }

  function clearStayRating() {
    const slot = $('#stayRating');
    if (!slot) return;
    slot.innerHTML = '';
    slot.hidden = true;
  }

  function attachHotelPicker(input) {
    return createCombobox(input, {
      minChars: 3,          // "ho" matches half the lodging in the world
      debounce: 320,        // a shared, unpaid, fair-use endpoint: do not type at it
      enabled: () => modalType === 'stay',
      rows: q => fetchHotelSuggestions(q, hotelBias()),
      render: row => ({ primary: row.value, secondary: row.detail || '', tag: row.kindLabel }),
      value: row => row.value,
      onPick: rememberPickedHotel,
    });
  }

  // ---------- airport picker source (bundled OurAirports table) ----------
  // Fetched once, on the first flight form opened, then held for the session.
  // It is in the service worker's precache too, so this resolves offline.
  let airportRows = null;
  let airportLoading = null;
  function loadAirports() {
    if (airportRows) return Promise.resolve(airportRows);
    if (!airportLoading) {
      airportLoading = fetch('data/airports.json')
        .then(r => { if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
        .then(json => { airportRows = airportIndex(json); return airportRows; })
        // A failed load leaves the two fields as plain text inputs. Retry on
        // the next open rather than caching the failure for the session.
        .catch(() => { airportLoading = null; return []; });
    }
    return airportLoading;
  }

  // The two airports currently chosen in the item form. NOTHING NEW IS STORED
  // ON THE ITEM: the title stays the single source of truth, in the same
  // "City (CODE) to City (CODE)" shape the samples already use and that
  // dayMorningCity already parses (parseTravelOrigin + stripPlaceCode). So the
  // picker is a way to WRITE that title, and `wrote` remembers what it wrote.
  let flightPick = { from: null, to: null, wrote: '' };

  // Composes the title, but never over a title the traveller made their own.
  // Someone editing "Red-eye BA179, exit row" should be able to correct an
  // airport without the picker flattening their note; the rewrite therefore
  // only happens while the field is empty or still holds exactly what a
  // previous pick put there.
  function syncFlightTitle() {
    if (!flightPick.from || !flightPick.to) return;
    const title = flightTitleFromAirports(flightPick.from, flightPick.to);
    if (!title) return;
    const cur = $('#inTitle').value.trim();
    if (cur && cur !== flightPick.wrote) return;
    $('#inTitle').value = title;
    flightPick.wrote = title;
    $('#fTitle').classList.remove('invalid');
  }

  // Re-fills both pickers when an existing flight is opened, so editing one
  // leg does not start from blank fields. A title that does not carry two
  // known IATA codes ("Ferry to Naxos") simply leaves them empty.
  function syncFlightPickers(item) {
    flightPick = { from: null, to: null, wrote: '' };
    $('#inFlightFrom').value = '';
    $('#inFlightTo').value = '';
    const title = (item && item.title) || '';
    if (!title) return;
    loadAirports().then(list => {
      // The modal may have been closed, or moved to another item, while the
      // airport table was still loading.
      if (ui.editingId !== (item && item.id) || modalType !== 'flight') return;
      const { from, to } = parseFlightAirports(title, list);
      if (!from || !to) return;
      flightPick = { from, to, wrote: title.trim() };
      $('#inFlightFrom').value = airportLabel(from);
      $('#inFlightTo').value = airportLabel(to);
    });
  }

  function attachAirportPicker(input, onPick) {
    return createCombobox(input, {
      minChars: 2,
      debounce: 0,          // local data: no network, so no reason to wait
      rows: q => loadAirports().then(list => searchAirports(q, list, CB_LIMIT)),
      render: a => ({ primary: airportLabel(a), secondary: airportDetail(a) }),
      value: a => airportLabel(a),
      onPick,
    });
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
    // Places already used in this trip are no longer pushed into a datalist
    // here: the combobox on both fields offers them itself (tripPlaceRows),
    // ranked above the geocoder's suggestions.
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

  // A12: everything the map draws comes from the stop list, so this string is
  // the whole map as data - trip, stop order, stop names, and every item that
  // feeds a popup (icon, title, dates) or its "+N more" tail. Two renders with
  // the same signature would paint the same map, which is exactly when the one
  // already on screen must be left alone, pan and zoom included.
  function mapSignature(trip, stops) {
    return trip.id + '|' + stops.map(s =>
      s.name + '~' + s.items.map(it => `${it.id}:${it.type}:${it.title}:${it.startDate}:${it.endDate || ''}`).join(',')
    ).join('|');
  }

  let mapRunToken = 0;
  // The stops the map currently on screen was drawn from, or the ones the run
  // in flight is drawing. Cleared by mapFailed, so a dead end always rebuilds.
  let mapSig = null;
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
  // Same polished empty block the timeline and days views use, so a map with
  // nothing to draw reads as a considered state rather than a broken card. The
  // icon distinguishes the reason at a glance (no places / offline / not found).
  function mapFailed(icon, heading, msg) {
    $('#mapStatus').innerHTML = `<div class="empty"><div class="big">${icon}</div><h2>${esc(heading)}</h2><p>${esc(msg)}</p></div>`;
    setMapState('blank');
    mapSig = null;
  }

  async function renderMap() {
    const status = $('#mapStatus');
    const trip = activeTrip();
    const stops = mapStops(trip);
    // render() runs whole, so the Map view was torn down and rebuilt by a rate
    // fetch resolving, a remote sync, an undo or any modal save - each one
    // throwing away the pan and zoom the traveller had set and re-walking the
    // geocode queue. Nothing about the route changed in any of those, so the
    // map already on screen (or the one being drawn right now) stands.
    const sig = mapSignature(trip, stops);
    if (mapInstance && sig === mapSig) {
      // .map-box is display:none off-view, and Leaflet only re-measures its
      // container when told: a window resize while the Timeline was up would
      // otherwise leave the kept map sized to the old window. It keeps the
      // centre, and does nothing at all when the size has not moved.
      mapInstance.invalidateSize({ animate: false });
      return;
    }
    // Claimed before the first await: a later render that genuinely differs
    // must see a different signature and take the token off this run.
    mapSig = sig;
    const token = ++mapRunToken;
    if (!stops.length) {
      if (mapInstance) { mapInstance.remove(); mapInstance = null; }
      mapFailed('🗺️', 'No places to map yet', 'Add items with a "Place" (Tokyo, Kyoto, ...) and they will show up here as a route.');
      return;
    }
    if (!navigator.onLine) { mapFailed('📡', 'The map is offline', 'The map needs an internet connection (tiles + place lookup).'); return; }
    setMapState('loading', 0);
    status.textContent = 'Loading map...';
    const ok = await ensureLeaflet();
    if (!ok) { mapFailed('📡', 'The map could not load', 'Could not load the map library (offline?). The timeline is unaffected.'); return; }
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
    if (!located.length) { mapFailed('📍', 'Could not find those places', `Could not locate: ${failed.join(', ')}. Try more specific place names (add the country).`); return; }
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
      const rule = '<hr style="border:none;border-top:1px solid var(--border-soft);margin:6px 0">';
      const lines = stop.items.slice(0, 5).map(it => {
        const range = isStay(it) && isIsoDate(it.endDate) ? fmtRange(it.startDate, it.endDate) : fmtDate(it.startDate);
        return `${TYPE_META[it.type].icon} ${esc(it.title)}<br><small style="color:var(--text-dim)">${range}</small>`;
      }).join(rule);
      // C8: the popup shows five items and a busy stop can hold far more, so it
      // said "these are your five things in Kyoto" when it meant "here are five
      // of your twelve". The tail counts what is not on screen; the timeline is
      // where the rest of them live.
      const hidden = stop.items.length - 5;
      const more = hidden > 0
        ? `${rule}<small style="color:var(--text-dim)">+${hidden} more ${hidden === 1 ? 'item' : 'items'} here</small>`
        : '';
      L.marker(ll, { icon }).addTo(mapInstance).bindPopup(`<b>${i + 1}. ${esc(stop.name)}</b><br>${lines}${more}`);
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
  // Device-level, exactly like PASSPORT_KEY: which passport you hold and when it
  // runs out are facts about the traveller, so they follow the person across
  // every trip on this device and never enter a trip's data (no export, no
  // share link).
  const PASSPORT_EXPIRY_KEY = 'trip-planner:passport-expiry';
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
    // Before any awaiting: the expiry check needs no dataset and no network, so
    // it must still be filled in and answered on the offline and failed-fetch
    // paths below, which return early.
    const exp = $('#passportExpiry');
    exp.min = DATE_MIN;
    exp.max = DATE_MAX;
    exp.value = localStorage.getItem(PASSPORT_EXPIRY_KEY) || '';
    renderPassportExpiry();
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

  // The "six months of remaining validity" check, against the trip that is
  // open. passportExpiryStatus owns the three branches and both sentences; this
  // only decides where it is painted. Nothing to say means nothing on screen -
  // a plenty-of-validity passport gets no green tick, the same way a trip with
  // no problems gets no issues panel.
  function renderPassportExpiry() {
    const el = $('#passportExpiryNote');
    const trip = activeTrip();
    const status = passportExpiryStatus($('#passportExpiry').value, trip ? tripStats(trip).end : '', fmtDate);
    el.className = 'passport-expiry-note' + (status ? ` pe-${status.level}` : '');
    el.textContent = status ? status.text : '';
    el.hidden = !status;
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

  // Whichever control opened the panel, so closing it puts the keyboard back
  // there instead of on <body>. Two openers reach here - #assistBtn and a day
  // card's [data-act="ask-day"] - so it is read off the focus rather than
  // passed in. A call from INSIDE the open panel is a re-focus, not an open,
  // and must not overwrite the control that is still waiting for its focus.
  let assistReturnFocus = null;

  function openAssist(focusDate) {
    // The assistant is the app's only paid dependency, so knowing how often it
    // is opened at all is worth one event. The prompt and the reply are never
    // touched here - they contain the trip.
    track('trackAction', 'assistant_opened');
    const panel = $('#assistPanel');
    const opener = document.activeElement;
    if (opener && opener !== document.body && !panel.contains(opener)) assistReturnFocus = opener;
    const trip = activeTrip();
    const id = trip ? trip.id : '';
    if (panel.dataset.tripId !== id) {
      panel.dataset.tripId = id;
      $('#assistMessages').innerHTML = '';
      assistActions.clear();
      assistFocusDate = null;
      assistAcceptedPoint = null;
      setupCollapsed = false;
    }
    if (focusDate && isIsoDate(focusDate)) assistFocusDate = focusDate;
    if (assistFocusDate) panel.dataset.focusDate = assistFocusDate; else delete panel.dataset.focusDate;
    setAssistMinimized(false);
    panel.hidden = false;
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
    returnAssistFocus();
  }

  // The same contract returnPopoverFocus applies to the header popovers:
  // reclaim only the focus the panel itself was holding, or the focus its
  // dismissal dropped on nothing. Focus the traveller has since handed to
  // another control is theirs, and taking it back would lose their place.
  function returnAssistFocus() {
    const el = assistReturnFocus;
    assistReturnFocus = null;
    if (!el || !document.contains(el) || typeof el.focus !== 'function') return;
    const a = document.activeElement;
    if (a && a !== document.body && !$('#assistPanel').contains(a)) return;
    el.focus();
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
      assistAcceptedPoint = null;
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

  // Clearing the thread is the ONE destructive action in this app that cannot
  // be taken back: the conversation lives under its own chat key, never in the
  // db, so save() never sees it and Undo has nothing to restore. Every other
  // destructive path either confirms first or hands back an Undo - even
  // DELETING THE TRIP is gentler, because that one deliberately keeps the
  // thread in hand so an undo can return it (see syncDeletedChats). So this
  // asks, using the same dialog the other destructive paths use.
  //
  // An EMPTY thread is not a loss, so it is cleared without a question: a
  // confirm with nothing at stake is how travellers learn to click through
  // confirms that do.
  function clearChat() {
    const trip = activeTrip();
    if (!trip) return;
    const messages = loadChat(trip.id).length;
    if (!messages) { wipeChat(trip.id); return; }
    confirmDialog(
      'Clear this conversation?',
      `The ${messages} message${messages === 1 ? '' : 's'} in this conversation, and any suggestions still waiting on screen, will be permanently deleted. This cannot be undone. Your trip itself is not touched.`,
      'Clear chat',
      () => wipeChat(trip.id),
    );
  }

  function wipeChat(tripId) {
    try { localStorage.removeItem(chatKey(tripId)); } catch { /* best effort */ }
    $('#assistMessages').innerHTML = '';
    assistActions.clear();
  }

  // Deleting a trip has to take its thread with it (until Clear chat, this key
  // was never collected and outlived the trip forever), but a conversation the
  // traveller typed is not something an Undo may silently drop. So the thread
  // is held for the session and syncDeletedChats keeps storage agreeing with
  // the db through any depth of undo and redo: a trip that is back has its
  // thread back, a trip that is gone does not keep one. Session-scoped because
  // once the tab closes no Undo can resurrect the trip anyway.
  const deletedChats = new Map();
  function syncDeletedChats() {
    for (const [id, raw] of deletedChats) {
      const alive = db.trips.some(t => t.id === id);
      const stored = localStorage.getItem(chatKey(id)) !== null;
      if (alive && !stored) putChat(id, raw);
      else if (!alive && stored) deletedChats.set(id, takeChat(id));
    }
  }
  function takeChat(tripId) {
    let raw = null;
    try {
      raw = localStorage.getItem(chatKey(tripId));
      localStorage.removeItem(chatKey(tripId));
    } catch { /* best effort */ }
    return raw;
  }
  function putChat(tripId, raw) {
    if (raw == null) return;
    try { localStorage.setItem(chatKey(tripId), raw); } catch { /* best effort */ }
    const trip = activeTrip();
    const panel = $('#assistPanel');
    // the undo's own render already repainted the (then empty) log. Same guard
    // syncAssistPanel uses: the copy tier has no thread on screen to repaint.
    if (trip && trip.id === tripId && panel && !panel.hidden && assistTier !== 'copy') restoreChat();
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
      wakeTime: '08:00', returnTime: '22:00', repeatOk: false, budget: [2], note: '',
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

  // Budget is optional and can be a RANGE: each tier toggles independently
  // (tap $$ and $$$ for "$$-$$$", tap a lone tier off for "no preference"),
  // so this is a pick-many like the style tags, but it keeps the segmented
  // track look so the row still reads as one control among the pick-one rows.
  // An empty pick sends a request that says nothing about money.
  const planBudgetSel = b => (Array.isArray(b) ? b : [b]).filter(n => BUDGET_LABELS[n]);
  function planBudgetRow(picked) {
    const sel = planBudgetSel(picked);
    const segs = [1, 2, 3, 4].map(v =>
      `<button type="button" class="pl-seg-b${sel.includes(v) ? ' on' : ''}" aria-pressed="${sel.includes(v)}"
        data-plan-budget="${v}">${BUDGET_LABELS[v]}</button>`).join('');
    return `<div class="pl-row">
      <div class="pl-label" id="pl-budget-lbl">Budget <small>optional</small></div>
      <div class="pl-seg" role="group" aria-labelledby="pl-budget-lbl">${segs}</div>
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
          ${planBudgetRow(p.budget)}
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
    // one tier reads as itself, an unbroken run as a range ("$$-$$$"), a
    // gapped pick spelled out ("$ or $$$"); no pick at all says nothing
    const bSel = planBudgetSel(p.budget);
    if (bSel.length) {
      const run = bSel[bSel.length - 1] - bSel[0] === bSel.length - 1;
      bits.push(bSel.length === 1 ? BUDGET_LABELS[bSel[0]]
        : run ? `${BUDGET_LABELS[bSel[0]]}-${BUDGET_LABELS[bSel[bSel.length - 1]]}`
          : bSel.map(n => BUDGET_LABELS[n]).join(' or '));
    }
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
    else if (d.planBudget) {
      const v = Number(d.planBudget);
      const cur = planBudgetSel(planPrefs.budget);
      planPrefs.budget = cur.includes(v) ? cur.filter(x => x !== v) : [...cur, v].sort((a, b) => a - b);
    }
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
    // A different day starts from that day's own bed again: the place accepted
    // on the previous day is not where this one begins.
    assistAcceptedPoint = null;
    const panel = $('#assistPanel');
    if (assistFocusDate) panel.dataset.focusDate = assistFocusDate; else delete panel.dataset.focusDate;
    renderFocusChip();
    renderPlanner();
    refreshDistances();
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
      // 501 joins 405 because it means the same thing from a server that has
      // no functions at all (python -m http.server answers POST with 501):
      // retrying every 60s only re-logs the browser's network error.
      if (res.status === 503 || res.status === 403 || res.status === 400 || res.status === 405 || res.status === 501) placesOff = true;
      else placesPausedUntil = Date.now() + (res.status === 429 ? 3600000 : 60000);
      return false;
    }
    let data;
    try { data = await res.json(); } catch { return false; }
    for (const u of placesCacheUpdates(data && data.results)) placesCache.set(u.key, u.entry);
    // The same response carries the place's coordinates (see the field-mask
    // note in tp-places.mjs). They cost nothing extra and they are the top rung
    // of the distance ladder, so a venue this call resolves is never looked up
    // a second time anywhere else.
    const located = placesLocationUpdates(data && data.results);
    if (located.length) {
      for (const u of located) rememberVenuePoint(u.key, u);
      saveVenueCache();
      scheduleDistanceRepaint();
    }
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
    refreshDistances();
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

  // A proposal is not an item yet, so its distance attributes are read off the
  // fields it WOULD create. A remove proposal carries no fields and therefore
  // no chip: it is a place leaving the plan, not one to walk to. No hotel-name
  // rung either, since nothing the model suggests has been through the picker.
  function proposalDistAttrs(p) {
    const f = p.fields;
    if (!f) return '';
    const query = itemMapsQuery({ type: f.type, title: f.title, location: f.location, mapsQuery: p.display.mapsQuery });
    const city = String(f.location || '').trim();
    if (!query && !city) return '';
    return distAttrs(query, '', city, f.title || '');
  }
  const proposalDistHtml = p => `<span class="ap-dist"${proposalDistAttrs(p)}></span>`;

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
        ${proposalDistHtml(p)}
        ${ratingSlotHtml(d.mapsQuery)}
        ${assistMapsLinkHtml(d.mapsQuery)}
      </div>`;
  }

  // The heading is the SLOT, not an explanation: "Lunch · 1:00 PM" (the group
  // id's leading word plus the slot's time), because the "Pick one" tag and
  // the two buttons below already say everything the old "3 options for the
  // same slot: lunch-2026-10-01. Choose one, or skip the slot." sentence
  // spelled out - and a raw group id is plumbing no traveller should read.
  function alternativeSetLead(entry) {
    const slotWord = (String(entry.group || '').match(/^[a-z]+/i) || [])[0];
    if (!slotWord) return `Pick one of ${entry.candidates.length}`;
    const slotTime = entry.candidates[0].display.startTime;
    return `${slotWord[0].toUpperCase() + slotWord.slice(1)}${slotTime ? ' · ' + fmtTime(slotTime) : ''}`;
  }

  function alternativeSetCard(entry, trip) {
    const card = document.createElement('div');
    card.className = 'assist-proposal assist-set';
    card.dataset.setGroup = entry.group;
    // A set is one stop on the day's route (at whichever option is selected), so
    // it carries the same op and day attributes the single cards do. Every
    // candidate in a set is an add for the same slot, so the first one's date is
    // the set's date.
    card.dataset.op = 'add';
    const setDate = entry.candidates[0].display.startDate;
    if (isIsoDate(setDate)) card.dataset.date = setDate;
    const name = 'apset-' + (++assistPropSeq);
    card.innerHTML = `
      <div class="ap-op">Pick one</div>
      <div class="as-lead as-title">${esc(alternativeSetLead(entry))}</div>
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
    // the day this card would land on: the shortest-route footer is per day,
    // and one reply can cover several
    if (isIsoDate(d.startDate)) card.dataset.date = d.startDate;
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
      ${proposalDistHtml(p)}
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
    // A MODEL's price is a guess, so it lands in the estimate bag and stays
    // out of the budget until the traveller adopts it. A price TRANSCRIBED off
    // a confirmation is not a guess - it is what the trip cost - so it goes
    // straight into `cost` and counts, which is the whole point of reading the
    // document. Same for the booking reference.
    const est = (!p.transcribed && f.cost != null) ? f.cost : null;
    const item = {
      id: uid(), type: f.type, title: f.title, location: f.location || '',
      startDate: f.startDate, endDate: f.endDate || '',
      startTime: f.startTime || '', endTime: f.endTime || '',
      status: p.status, costNote: f.costNote || '',
      cost: (p.transcribed && f.cost != null) ? f.cost : null,
      details: String(f.details || '').slice(0, 500),
      createdAt: new Date().toISOString(),
    };
    if (f.mapsQuery) item.mapsQuery = f.mapsQuery;
    if (p.transcribed && f.confirmation) item.confirmation = f.confirmation;
    if (p.transcribed && f.cost != null) item.costCurrency = f.costCurrency || (trip.currency || 'USD');
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
      const added = proposalToItem(p, trip);
      trip.items.push(added);
      // The traveller has now decided to be here, so this is where the rest of
      // the day's recommendations are measured from. Only a place that actually
      // resolved moves the anchor; an unlocatable add leaves it where it was.
      const point = placePoint({ query: itemMapsQuery(added), name: '', city: (added.location || '').trim() });
      if (point) assistAcceptedPoint = { ...point, label: added.title || '' };
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
    // the accepted card leaves the route and every remaining chip re-measures
    // from the new anchor, without a reload
    refreshDistances();
  }

  // ---------- "Up next" chip ----------
  // The DEVICE clock as a wall-clock stamp: the times on the items are
  // wall-clock times the traveller typed, so "is it 10:00 yet" has to be asked
  // in the clock they are reading. Its date half is todayIso's, both through
  // localDateIso, so the chip can never sit on a different day than the
  // countdown and the past-row dimming.
  function nowStamp() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${localDateIso(d)}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  const upKey = up => up ? `${up.mode}|${up.id}|${up.dur}` : '';
  let nextUpKey = '';
  // This is the one thing on the summary bar that goes stale while you look at
  // it: the app sits open on a phone for hours. The tick recomputes cheaply
  // every 30 seconds and repaints the summary ONLY when the chip's own text
  // would change, so no other part of the page moves under the traveller.
  setInterval(() => {
    const trip = activeTrip();
    if (!trip) return;
    if (upKey(nextUpEvent(trip.items, nowStamp())) === nextUpKey) return;
    renderSummary(trip, computeIssues(trip));
  }, 30000);

  $('#summary').addEventListener('click', e => {
    const btn = e.target.closest('button[data-nextup]');
    if (!btn) return;
    // same jump the Issues panel and the coverage strip use
    ui.view = 'timeline';
    ui.flashId = btn.dataset.nextup;
    render();
  });

  // ---------- packing checklist ----------
  // Rows live on the trip itself (trip.packing), so they ride along with every
  // mechanism the trip already has: save() is the undo choke point, the whole db
  // is one localStorage key, and sync-system carries that key. No new storage.
  // The ARRAY'S EXISTENCE is the "already seeded" flag, which is why an emptied
  // list is still written as [] rather than deleted: a traveller who cleared
  // every row must not have the defaults handed back to them on the next open.
  // Seeded outsideHistory, for the same reason ensureTrip is: the app laying
  // down its own defaults is not an edit the traveller made. Filed as a normal
  // save it became an undo step just for OPENING the dialog - the Undo button
  // lit up untouched, one press emptied the list the traveller was looking at,
  // and the next open re-seeded it and filed another step. Their real last edit
  // was then two presses away instead of one.
  function ensurePacking(trip) {
    if (Array.isArray(trip.packing)) return;
    trip.packing = defaultPackingItems(trip).map(text => ({ id: uid(), text, done: false }));
    save(null, null, true);
  }
  const packingRows = trip => (Array.isArray(trip.packing) ? trip.packing : []).filter(r => r && typeof r.text === 'string');

  function openPackingModal() {
    const trip = activeTrip();
    if (!trip) return;
    ensurePacking(trip);
    // a filter left pointing at somebody who is no longer on the trip would open
    // the dialog on a list with rows missing and nothing saying why
    if (ui.packingFilter && !packingNames().includes(ui.packingFilter)) ui.packingFilter = '';
    openOverlay('#packingOverlay');
    renderPacking();
    syncUndoButtons();
  }

  // The whole per-traveller half of this dialog turns on ONE reading: a trip
  // that names two or more people. Below that, packingNames() is empty, every
  // row reads as Everyone, and neither the filter nor the picker is built at
  // all, so the list is the list it always was.
  const packingNames = () => {
    const names = normalizeTravelers(activeTrip().travelers);
    return names.length >= 2 ? names : [];
  };

  function packingCountText(rows) {
    return `${rows.filter(r => r.done).length} of ${rows.length} packed`;
  }

  function renderPacking() {
    const trip = activeTrip();
    if (!trip) return;
    const names = packingNames();
    const all = packingRows(trip);
    const shown = packingRowsFor(all, ui.packingFilter, names);
    $('#packingCount').textContent = packingCountText(shown);
    renderPackingFilter(names, all);
    renderPackingWho(names);
    $('#packingList').innerHTML = shown.length ? shown.map(r => {
      const who = packingWho(r, names);
      return `
      <div class="pk-row${r.done ? ' is-done' : ''}">
        <label class="pk-check">
          <input type="checkbox" data-pk="${esc(r.id)}"${r.done ? ' checked' : ''}>
          <span class="pk-text">${esc(r.text)}</span>
        </label>
        ${who.length ? `<span class="pk-who-tag" title="Only for ${esc(who.join(', '))}">${esc(who.join(', '))}</span>` : ''}
        <button type="button" class="pk-del" data-pk-del="${esc(r.id)}" title="Remove this row" aria-label="Remove ${esc(r.text)}">✕</button>
      </div>`;
    }).join('') : packingEmptyHtml(all.length);
  }

  // Two different emptinesses, and saying "nothing on the list" for the second
  // would be a lie about a list that has rows on it.
  function packingEmptyHtml(total) {
    if (total && ui.packingFilter) return `
      <div class="m-empty">
        <span class="me-ico" aria-hidden="true">🎒</span>
        <span class="me-title">Nothing for ${esc(ui.packingFilter)} yet</span>
        <span>Rows for everyone show up here too - there are none of those either.</span>
      </div>`;
    return `
      <div class="m-empty">
        <span class="me-ico" aria-hidden="true">🎒</span>
        <span class="me-title">Nothing on the list</span>
        <span>Add whatever you do not want to forget. It stays with this trip.</span>
      </div>`;
  }

  // Rebuilt rather than repopulated, like the toolbar's traveller filter: the
  // roster can change under an open dialog (undo, or a sync from another
  // device). The select is only replaced when its options actually differ, so a
  // repaint cannot take focus out of the control being used.
  function renderPackingFilter(names, rows) {
    const wrap = $('#packingFilterWrap');
    // the signature is cleared with the markup, or a roster that leaves and
    // comes back the same would keep the emptied wrapper
    if (!names.length) { wrap.innerHTML = ''; delete wrap.dataset.sig; ui.packingFilter = ''; return; }
    if (ui.packingFilter && !names.includes(ui.packingFilter)) ui.packingFilter = '';
    const counts = new Map(names.map(n => [n, packingProgress(rows, n, names)]));
    const sig = names.join('\n') + '|' + names.map(n => `${counts.get(n).done}/${counts.get(n).total}`).join(',');
    if (wrap.dataset.sig !== sig) {
      wrap.dataset.sig = sig;
      const whole = packingProgress(rows, '', names);
      wrap.innerHTML = `<label class="pk-filter-lbl" for="packingFilter">Show</label>`
        + `<span class="sel-wrap"><select id="packingFilter" class="pk-filter-sel">`
        + `<option value="">Everyone's list (${whole.done}/${whole.total})</option>`
        + names.map(n => `<option value="${esc(n)}">${esc(n)} (${counts.get(n).done}/${counts.get(n).total})</option>`).join('')
        + `</select></span>`;
    }
    $('#packingFilter').value = ui.packingFilter;
  }

  // "Who's this for" on the ADD form, the same checkbox-per-traveller control
  // the item modal uses. Nothing ticked is Everyone, which is what a row that
  // was never tagged already means.
  function renderPackingWho(names) {
    const wrap = $('#packingWhoWrap');
    if (!names.length) { wrap.innerHTML = ''; delete wrap.dataset.names; return; }
    // rebuilt only when the roster itself changes, so a repaint cannot untick
    // the boxes under somebody halfway through adding a row
    if (wrap.dataset.names === names.join('\n')) return;
    wrap.dataset.names = names.join('\n');
    wrap.innerHTML = `
      <fieldset class="who-for pk-who-for">
        <legend>Who's this for <small>(optional)</small></legend>
        <div class="who-list">
          ${names.map(n => `<label class="who-chk"><input type="checkbox" data-pk-who value="${esc(n)}">${esc(n)}</label>`).join('')}
        </div>
        <div class="hint">Leave all unchecked and the row is for everyone.</div>
      </fieldset>`;
  }

  // Which names the add form has ticked, in roster order. Everybody ticked is
  // Everyone, exactly as it is on an item, so it persists as no tag at all.
  function pickedPackingWho() {
    const names = packingNames();
    if (!names.length) return [];
    const picked = [...document.querySelectorAll('#packingWhoWrap input[data-pk-who]:checked')]
      .map(c => c.value).filter(n => names.includes(n));
    return picked.length < names.length ? picked : [];
  }
  // An undo or a remote change repaints through render(), and the dialog can be
  // open while that happens.
  function syncPackingModal() {
    if ($('#packingOverlay').classList.contains('open')) renderPacking();
  }

  $('#packingList').addEventListener('change', e => {
    const box = e.target.closest('input[data-pk]');
    if (!box) return;
    const row = packingRows(activeTrip()).find(r => r.id === box.dataset.pk);
    if (!row) return;
    row.done = box.checked;
    // updated in place rather than re-rendered: rebuilding the list would throw
    // away the checkbox the keyboard is standing on
    box.closest('.pk-row').classList.toggle('is-done', row.done);
    // both counters read the same rows the list is showing, and the select's
    // per-person tallies are rebuilt with them: focus is on this checkbox, not
    // in the select, so replacing it takes nobody's place
    const names = packingNames();
    const all = packingRows(activeTrip());
    $('#packingCount').textContent = packingCountText(packingRowsFor(all, ui.packingFilter, names));
    renderPackingFilter(names, all);
    save();
    syncUndoButtons();
  });

  $('#packingFilterWrap').addEventListener('change', e => {
    if (!e.target.closest('#packingFilter')) return;
    ui.packingFilter = e.target.value;
    renderPacking();
    $('#packingFilter').focus();
  });

  $('#packingList').addEventListener('click', e => {
    const btn = e.target.closest('button[data-pk-del]');
    if (!btn) return;
    const trip = activeTrip();
    const idx = trip.packing.findIndex(r => r && r.id === btn.dataset.pkDel);
    if (idx < 0) return;
    const gone = trip.packing[idx];
    trip.packing.splice(idx, 1);
    save(`Removed "${gone.text}"`, undo);
    renderPacking();
    syncUndoButtons();
  });

  $('#packingAddForm').addEventListener('submit', e => {
    e.preventDefault();
    const input = $('#packingAddInput');
    const text = input.value.trim();
    if (!text) { input.focus(); return; }
    const row = { id: uid(), text, done: false };
    const who = pickedPackingWho();
    // absent rather than empty, so a row for everyone is byte for byte the row
    // this list has always stored
    if (who.length) row.who = who;
    activeTrip().packing.push(row);
    input.value = '';
    // the picker is NOT cleared: adding three things for the same person is the
    // normal way this gets used, and re-ticking a name each time is the cost
    save(`Added "${text}"`, undo);
    renderPacking();
    syncUndoButtons();
    input.focus();
  });

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
  // Closes ONE layer. Dismissing by hand (Escape, the backdrop, a Cancel
  // button) used to strip .open off every open overlay at once, so a confirm
  // stacked over the item modal took the modal down with it and one Escape
  // dismissed two layers.
  function closeOverlay(o) {
    if (!o || !o.classList.contains('open')) return;
    // The picker popups are children of <body>, not of the modal, so closing
    // the overlay does not take them with it: they would hang over the board.
    [...cbOpen].forEach(cb => cb.close());
    // ui.editingId is the item dialog's own state and outlived it, so between a
    // Cancel and the next Add, "which item is being edited" answered with the
    // last one edited. Cleared here with the object URLs, the same way
    // ui.confirmAction is cleared below. Both are scoped to the dialog that
    // owns them now that layers close one at a time: dismissing a confirm must
    // not wipe the editing state of the item modal still open underneath it.
    if (o.id === 'itemOverlay') { revokeDocUrls(); ui.editingId = null; }
    if (o.id === 'confirmOverlay') ui.confirmAction = null;
    o.classList.remove('open');
    const uncovered = topOverlay();
    if (uncovered) {
      // Only the outermost open records overlayReturnFocus (see openOverlay), so
      // a layer closing off the top of a stack has no opener of its own to hand
      // focus back to. Focus goes to the modal it just uncovered, the same place
      // opening that modal put it. Left behind on a button of the layer that is
      // now hidden, focus drops to <body> and the Tab trap goes with it.
      uncovered.querySelector('.modal').focus({ preventScroll: true });
      return;
    }
    document.body.classList.remove('tp-modal-open');
    if (overlayReturnFocus && document.contains(overlayReturnFocus) && typeof overlayReturnFocus.focus === 'function') {
      overlayReturnFocus.focus();
    }
    overlayReturnFocus = null;
  }
  function closeTopOverlay() { closeOverlay(topOverlay()); }
  // Everything, for the programmatic paths that change what is on screen
  // underneath (a save, a trip switch): topmost first, so each layer runs its
  // own teardown and only the last one out hands focus back to the opener.
  function closeAllOverlays() {
    let o;
    while ((o = topOverlay())) closeOverlay(o);
  }

  let lastDeleted = null;
  function toast(msg, undoFn, opts) {
    const box = $('#toasts');
    const el = document.createElement('div');
    el.className = 'toast' + (opts && opts.error ? ' toast-error' : '');
    // the action defaults to Undo because almost every toast that carries one is
    // an undo; opts.action names it when it is something else ("Clear filters")
    const actLabel = (opts && opts.action) || 'Undo';
    // opts.sticky waits for the reader instead of a clock (the new-version
    // prompt: a notice you can miss in six seconds is not a notice). It carries
    // its own Dismiss because without the timeout the action would otherwise be
    // the only way off the screen.
    const sticky = !!(opts && opts.sticky);
    el.innerHTML = `<span>${esc(msg)}</span>${undoFn ? `<button type="button">${esc(actLabel)}</button>` : ''}${sticky ? '<button type="button" data-toast-dismiss>Dismiss</button>' : ''}`;
    if (undoFn) el.querySelector('button').addEventListener('click', () => { undoFn(); el.remove(); });
    if (sticky) el.querySelector('[data-toast-dismiss]').addEventListener('click', () => el.remove());
    box.appendChild(el);
    if (sticky) return;
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .4s'; setTimeout(() => el.remove(), 450); }, undoFn ? 6000 : 2600);
  }
  // Genuine failures (a bad import, a share link that will not open) route here
  // so they read as errors, not the neutral confirmations Undo toasts use.
  function toastError(msg) { toast(msg, null, { error: true }); }

  // ---------- events ----------
  $('#addBtn').addEventListener('click', () => openItemModal(null));
  $('#shiftTripBtn').addEventListener('click', () => openShiftModal(null));
  $('#routeBtn').addEventListener('click', () => openRouteModal('', ''));
  $('#visaBtn').addEventListener('click', openVisaModal);
  $('#assistBtn').addEventListener('click', () => openAssist(null));
  // openOverlay/closeOverlay own the focus contract, so the shortcut list gets
  // Escape, backdrop click, the Close button and focus-back-to-opener for free.
  $('#shortcutsBtn').addEventListener('click', () => openOverlay('#shortcutsOverlay'));
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
  // Proposal cards are rendered in two places now - the assistant panel and
  // the booking-import dialog - so the accept/reject delegation is a named
  // handler bound to both rather than an inline one bound to the panel.
  function onProposalClick(e) {
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
      refreshDistances();
      return;
    }
    const pid = card.dataset.proposalId;
    // a dismissed card is one stop fewer, so the route line recomputes (and
    // disappears once fewer than two located recommendations are left)
    if (act === 'reject-proposal') { assistActions.delete(pid); card.remove(); refreshDistances(); }
    else if (act === 'accept-proposal') acceptProposal(pid, card);
  }
  $('#assistMessages').addEventListener('click', onProposalClick);
  $('#importBookingResult').addEventListener('click', onProposalClick);
  $('#assistMessages').addEventListener('change', e => {
    const radio = e.target.closest('.assist-set input[type="radio"]');
    if (!radio) return;
    const card = radio.closest('.assist-proposal');
    card.querySelector('[data-act="accept-set"]').disabled = false;
    card.querySelectorAll('.as-opt').forEach(o => o.classList.toggle('picked', o.contains(radio)));
    // the set now stands at a different venue, so the day's route order, its
    // numbered pills and its total are all recomputed from the new pick
    refreshDistances();
  });
  $('#daysList').addEventListener('pointerdown', beginRowDrag);
  // The keyboard half of the grip, and the reason this is not a mouse-only
  // feature: the same one-step move a drag makes, on the arrow keys the handle's
  // own label promises. render() rebuilds the day list, so focus is handed to
  // the grip's replacement afterwards (preventScroll, or the page jumps back to
  // the row we just moved away from), exactly as the night strip does.
  $('#daysList').addEventListener('keydown', e => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    const grip = e.target.closest('.dc-grip');
    if (!grip || sharedMode) return;
    e.preventDefault();
    const id = grip.dataset.grip;
    if (!moveInTie(activeTrip().items, id, e.key === 'ArrowDown' ? 1 : -1)) return;
    save('Order updated');
    render();
    const next = [...document.querySelectorAll('#daysList .dc-grip')].find(g => g.dataset.grip === id);
    if (next) next.focus({ preventScroll: true });
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
    else if (act === 'share-day') shareDay(date);
    else if (act === 'duplicate-day') openDupDayModal(date);
    else if (act === 'clear-day') clearDay(date);
    else if (act === 'edit') openItemModal(btn.dataset.id);
    else if (act === 'delete') deleteItem(btn.dataset.id);
  });
  $('#passportSel').addEventListener('change', () => {
    const v = $('#passportSel').value;
    // cleared means cleared, the same as the expiry below: picking the blank
    // option has to take the old passport off this device, not leave it saved
    // and have it come back on the next load
    if (v) localStorage.setItem(PASSPORT_KEY, v);
    else localStorage.removeItem(PASSPORT_KEY);
    // the traveller has now said it themselves: it is no longer an assumption
    passportGuess = null;
    renderPassportGuess();
    renderVisaRows();
  });
  $('#passportExpiry').addEventListener('change', () => {
    const v = $('#passportExpiry').value;
    // cleared means cleared: a renewed passport must be able to take the old
    // date off this device, so this removes rather than only sets
    if (v) localStorage.setItem(PASSPORT_EXPIRY_KEY, v);
    else localStorage.removeItem(PASSPORT_EXPIRY_KEY);
    renderPassportExpiry();
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
  // Picking rows is a Timeline motion. Leaving the Timeline leaves the mode
  // (checkboxes and bar go with it), and entering the mode from Days or Map
  // brings you back to the view that has the checkboxes.
  function setView(v) {
    ui.view = v;
    // trackView drops repeats, so the several code paths that re-assert the
    // current view (share exit, select-mode exit, hashchange) report once.
    track('trackView', v);
    if (selMode && v !== 'timeline') { exitSelectMode(); render(); return; }
    applyView();
  }
  $('#viewTimeline').addEventListener('click', () => setView('timeline'));
  $('#viewDays').addEventListener('click', () => setView('days'));
  $('#viewMap').addEventListener('click', () => setView('map'));
  $('#selectBtn').addEventListener('click', () => {
    if (selMode) exitSelectMode();
    else { selMode = true; selIds.clear(); ui.view = 'timeline'; }
    render();
  });
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
    setView(parsed.view);
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
  const gotoStripCell = cell => { ui.view = 'timeline'; ui.flashId = cell.dataset.goto; render(); };
  $('#stripBox').addEventListener('click', e => {
    const cell = e.target.closest('[data-goto]');
    if (cell) gotoStripCell(cell);
  });
  // the keyboard half of the same control: role="button" promises Enter and
  // Space, and Space would otherwise scroll the page out from under the jump
  $('#stripBox').addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const cell = e.target.closest('[data-goto]');
    if (!cell) return;
    e.preventDefault();
    // render() rebuilds the strip, so the activated cell is gone by the time
    // the jump lands: hand focus to its replacement (preventScroll, or focusing
    // it would drag the page back off the row we just jumped to) instead of
    // dropping a keyboard traveller on <body> with nowhere to carry on from.
    const idx = [...$('#strip').children].indexOf(cell);
    gotoStripCell(cell);
    const next = $('#strip').children[idx];
    if (next && next.hasAttribute('data-goto')) next.focus({ preventScroll: true });
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
    try { await deleteDoc(Number(btn.dataset.docRemove)); }
    catch {
      // the thumbnail is still there because the document still is. Saying so
      // beats leaving the row looking like a button that does nothing.
      toastError('That document could not be removed on this device.');
      return;
    }
    await renderDocsList(ui.editingId);
    refreshDocIndicators();
    toast('Document removed');
  });
  $('#shiftForm').addEventListener('submit', submitShiftForm);
  $('#dupDayForm').addEventListener('submit', submitDupDayForm);
  $('#tripForm').addEventListener('submit', submitTripForm);
  $('#inTripName').addEventListener('input', syncTripNameHint);
  $('#inTripTravelers').addEventListener('input', syncTravelerWarning);
  $('#essentialsForm').addEventListener('submit', submitEssentialsForm);
  $('#essentialsForm').addEventListener('input', syncEssentialsEmpty);
  $('#typePicker').addEventListener('click', e => {
    const b = e.target.closest('button[data-type]');
    if (b) setModalType(b.dataset.type);
  });
  $('#importBookingBtn').addEventListener('click', () => $('#importBookingFile').click());
  $('#importBookingFile').addEventListener('change', e => {
    const f = e.target.files[0];
    e.target.value = '';
    readBookingFile(f);
  });
  // Debounced so a long paste is read once, not once per keystroke.
  let importPasteTimer = 0;
  $('#importBookingPaste').addEventListener('input', e => {
    clearTimeout(importPasteTimer);
    const text = e.target.value;
    importPasteTimer = setTimeout(() => {
      if (text.trim().length > 20) runBookingExtraction(text);
    }, 400);
  });
  attachPlacePicker($('#inLocation'));
  attachPlacePicker($('#routeFrom'));
  attachPlacePicker($('#routeTo'));
  attachAirportPicker($('#inFlightFrom'), a => { flightPick.from = a; syncFlightTitle(); });
  attachAirportPicker($('#inFlightTo'), a => { flightPick.to = a; syncFlightTitle(); });
  // Gated on the stay type inside the combobox (see `enabled`), so the other
  // five types keep #inTitle as the plain free-text field it has always been.
  attachHotelPicker($('#inTitle'));
  $('#inCostCurrency').addEventListener('change', syncCostPrefix);
  // clearing the cost takes the split control with it, and a cost appearing
  // brings it back: there is nothing to divide unevenly without an amount
  $('#inCost').addEventListener('input', () => renderSplitControl(typedSplitAmounts()));
  $('#costEstHint').addEventListener('click', e => {
    if (e.target.closest('#adoptEstBtn')) adoptEstimate();
  });
  $('#shiftMinus').addEventListener('click', () => { $('#shiftDays').value = (parseInt($('#shiftDays').value, 10) || 0) - 1; });
  $('#shiftPlus').addEventListener('click', () => { $('#shiftDays').value = (parseInt($('#shiftDays').value, 10) || 0) + 1; });

  // a selection belongs to the rows it was made from, so a trip switch drops it
  // exactly as a filter change does: the bulk bar could otherwise sit over
  // another trip's board reading "0 selected"
  $('#tripSelect').addEventListener('change', e => {
    db.activeTripId = e.target.value;
    exitSelectMode();
    save();
    render();
  });

  $('#tripMenuBtn').addEventListener('click', e => {
    e.stopPropagation();
    if ($('#tripMenu').classList.contains('open')) closeTripMenu();
    else openTripMenu();
  });
  // both header popovers close on any click that is not inside them; each
  // opener stops propagation, which is why each also closes the other
  document.addEventListener('click', () => { closeTripMenu(); closeTripSearch(); });

  $('#tripSearchBtn').addEventListener('click', e => {
    e.stopPropagation();
    if ($('#tripSearch').classList.contains('open')) closeTripSearch();
    else openTripSearch();
  });
  // typing and scrolling inside the panel must not reach the document closer;
  // picking a result closes it explicitly
  $('#tripSearchPanel').addEventListener('click', e => e.stopPropagation());
  $('#tripSearchInput').addEventListener('input', renderTripSearch);
  $('#tripSearchResults').addEventListener('click', e => {
    const btn = e.target.closest('button[data-ts-trip]');
    if (btn) jumpToSearchResult(btn.dataset.tsTrip, btn.dataset.tsItem);
  });
  $('#tripMenu').querySelector('.tp-menu-panel').addEventListener('click', e => {
    const b = e.target.closest('button[data-act]');
    // clicks on captions/dividers/padding are inert: keep the panel open
    if (!b) { e.stopPropagation(); return; }
    // aria-disabled means "not ready yet" (see syncGpxMenuRow). It does not
    // block the click the way the native attribute would, so the no-op is
    // enforced here - and the menu is deliberately left OPEN, because the whole
    // point of the aria form is that the row can be hovered and its title read.
    // Keyboard Enter arrives through this same handler, so it is covered too.
    if (b.getAttribute('aria-disabled') === 'true') { e.stopPropagation(); return; }
    closeTripMenu();
    const act = b.dataset.act;
    // The same allow-list syncTripMenuShared disables the rows by; a disabled
    // button cannot be clicked, so this is the backstop for a menu opened
    // before sharedMode was set rather than the primary block.
    if (sharedMode && !SHARED_MENU_ACTS.includes(act)) return;
    if (act === 'new-trip') openTripModal('new');
    else if (act === 'rename-trip') openTripModal('rename');
    else if (act === 'duplicate-trip') duplicateTrip();
    else if (act === 'duplicate-template') duplicateAsTemplate();
    else if (act === 'essentials') openEssentialsModal();
    else if (act === 'packing') openPackingModal();
    else if (act === 'import-booking') openImportBookingModal();
    else if (act === 'export-trip') exportTrip();
    else if (act === 'export-csv') exportCsv();
    else if (act === 'export-ics') exportIcs();
    else if (act === 'export-gpx') exportGpx();
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
        // The two per-trip stores the db does not own. Both were left behind by
        // a delete and nothing else ever pruned them, so they grew forever on
        // the same storage budget that pushes save() into the quota banner.
        // Deleting a trip is undoable, so the thread is kept in hand rather
        // than destroyed: an Undo hands the conversation back (see
        // syncDeletedChats). The collapse record deliberately does NOT come
        // back. Which stays were expanded is a view preference that costs one
        // click to redo and re-seeds itself, while a conversation the traveller
        // typed cannot be got back at all.
        const chat = takeChat(t.id);
        if (chat != null) {
          deletedChats.set(t.id, chat);
          if (deletedChats.size > HISTORY_MAX) deletedChats.delete(deletedChats.keys().next().value);
        }
        dropCollapse(t.id);
        db.trips = db.trips.filter(x => x.id !== t.id);
        db.activeTripId = db.trips.length ? db.trips[0].id : null;
        save(`Trip "${t.name}" deleted`);
        render();
      });
    }
  });

  $('#importFile').addEventListener('change', e => {
    if (e.target.files[0]) importJson(e.target.files[0]);
    e.target.value = '';
  });

  $('#confirmYes').addEventListener('click', () => {
    const fn = ui.confirmAction;
    closeAllOverlays();
    if (fn) fn();
  });

  ['searchBox', 'filterType', 'filterStatus'].forEach(id => {
    $('#' + id).addEventListener('input', () => {
      ui.search = $('#searchBox').value.trim();
      ui.filterType = $('#filterType').value;
      ui.filterStatus = $('#filterStatus').value;
      // select mode survives a filter change; syncSelectUi prunes the selection
      // to the rows the next render actually draws
      render();
    });
  });
  $('#clearFiltersBtn').addEventListener('click', clearFilters);
  // delegated: the traveller select is rebuilt whenever the roster changes, so
  // the listener lives on the wrapper that never is
  $('#travelerFilterWrap').addEventListener('input', e => {
    if (e.target.id !== 'filterTraveler') return;
    ui.filterTraveler = e.target.value;
    // pruned, not exited - the same contract as the toolbar filters above
    render();
  });

  $('#issuesBox').addEventListener('click', e => {
    const a = e.target.closest('button[data-jump]');
    // the same jump the night strip, the Up next chip and trip search use: the
    // panel is on screen in all three views, and the flashed row only exists on
    // the timeline, so the view has to come along or "show" flashes a row inside
    // a hidden board and burns ui.flashId doing it
    if (a) { ui.view = 'timeline'; ui.flashId = a.dataset.jump; render(); return; }
    // the gap pair: light up the uncovered nights, or open the Add-item form
    // already filled in for them. Both read the gap off the issue list this
    // panel was drawn from, so neither can name a range the warning does not.
    const gapShow = e.target.closest('button[data-gap-show]');
    if (gapShow) { flashGapNights((currentIssues[Number(gapShow.dataset.gapShow)] || {}).gap); return; }
    const addStay = e.target.closest('button[data-add-stay]');
    if (addStay && !sharedMode) {
      const pre = stayPrefillForGap((currentIssues[Number(addStay.dataset.addStay)] || {}).gap);
      if (pre) openItemModal(null, pre);
      return;
    }
    // "Mark booked" on a still-to-book warning: the status write itself, not a
    // trip to the row that carries it. render() rebuilds this panel, so the
    // warning it answered is gone by the time the click finishes.
    const book = e.target.closest('button[data-book-id]');
    if (book && !sharedMode) { setItemStatus(book.dataset.bookId, 'booked'); return; }
    // the overlapping-trip warning names the other trip; the name switches to
    // it, exactly as picking it from #tripSelect does - filters untouched
    const t = e.target.closest('button[data-trip]');
    if (t && db.trips.some(x => x.id === t.dataset.trip)) {
      db.activeTripId = t.dataset.trip;
      save();
      render();
    }
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
    const box = e.target.closest('input[data-sel-id]');
    if (box) {
      // no render(): ticking a box must not repaint the board under the cursor,
      // so the row class and the bar are updated in place
      const id = box.dataset.selId;
      if (box.checked) selIds.add(id); else selIds.delete(id);
      const row = box.closest('.tp-row');
      if (row) row.classList.toggle('is-sel', box.checked);
      syncSelectUi(selVisible);
      return;
    }
    const sel = e.target.closest('select[data-status-for]');
    if (!sel) return;
    setItemStatus(sel.dataset.statusFor, sel.value);
  });

  document.querySelectorAll('.overlay').forEach(o => {
    // the backdrop that was hit belongs to the topmost layer by construction,
    // but it closes THAT layer rather than every open one
    o.addEventListener('mousedown', e => { if (e.target === o) closeOverlay(o); });
  });
  document.querySelectorAll('[data-close]').forEach(b => {
    b.addEventListener('click', () => closeOverlay(b.closest('.overlay')));
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      // one keypress dismisses one layer, topmost first: a row being dragged
      // (nothing is stored until it is dropped, so this abandons it), then
      // modals (z 90), then the assistant panel (80), then the header popovers
      // (search 41, menu 40)
      if (dragCtx) { cancelRowDrag(); return; }
      if (topOverlay()) { closeTopOverlay(); return; }
      if (!$('#assistPanel').hidden) { closeAssist(); return; }
      if ($('#tripSearch').classList.contains('open')) { closeTripSearch(); return; }
      if ($('#tripMenu').classList.contains('open')) { closeTripMenu(); return; }
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
    // "n" for a new item, gated on sharedMode for the same reason #addBtn is
    // hidden there: save() is a no-op in a shared view, so the item the modal
    // added would appear on screen and exist nowhere.
    if ((e.key === 'n' || e.key === 'N') && !e.ctrlKey && !e.metaKey && !sharedMode && !e.target.closest('input, textarea, select')) {
      openItemModal(null);
      return;
    }
    // "?" opens the shortcut list itself. Same field guard as "n" above (a
    // question mark typed into a search box must reach the box), but NOT gated
    // on sharedMode: it reads nothing and writes nothing, so a visitor gets the
    // same list. preventDefault stops Firefox's quick-find on "?".
    if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.target.closest('input, textarea, select')) {
      e.preventDefault();
      openOverlay('#shortcutsOverlay');
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

  // A tab left open for days keeps the JS it booted with: sw.js is
  // network-first, so a LOAD always brings the newest code, but nothing ever
  // reloads a tab that just sits there. The worker posts tp-update-available
  // once it activates over a previous install (see sw.js), and the offer is
  // made rather than taken: reloading under a half-typed item would lose it.
  if ('serviceWorker' in navigator) {
    let updateOffered = false;
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (!e.data || e.data.type !== 'tp-update-available') return;
      // One offer per update. The worker posts to every window client, and a
      // second toast for the same version would just be noise.
      if (updateOffered) return;
      // A page that loaded moments ago fetched the new assets itself on the way
      // in (network-first), so the worker activating right behind it has
      // nothing to offer; only a tab that has been sitting open does.
      if (performance.now() < 10000) return;
      updateOffered = true;
      toast('A new version of Trip Planner is ready.', () => location.reload(), { action: 'Refresh', sticky: true });
    });
  }

  // ---------- boot ----------
  // #itemForm is novalidate, so these attributes only shape the native picker;
  // the submit handler is what actually enforces DATE_MIN/DATE_MAX. Stamping
  // them from the same constants keeps the widget and the check in step, and
  // keeps the bounds out of the markup entirely.
  for (const id of ['#inStart', '#inEnd', '#inArrDate', '#inBookBy', '#dupDayDate']) {
    $(id).min = DATE_MIN;
    $(id).max = DATE_MAX;
  }
  syncTimefmtLabel();
  // Same reader the view-hash writer consults, so the two can never disagree.
  // A hand-retyped "#SHARE=..." used to boot as a normal load, while that
  // writer (correctly case-insensitive) then refused to touch the fragment, so
  // the payload just sat in the URL doing nothing.
  const bootIsShare = viewFromHash(location.hash, ui.view).isShare;
  // repairTrips() still runs so `db`/`realDb` is never handed downstream code
  // (e.g. ensureTrip() on a failed share decode) in an unnormalized shape, but
  // the write-back is skipped on a share boot: opening someone else's link
  // must never touch this device's own real trip data, not even to fix up a
  // stale schema field.
  repairDb(bootIsShare);
  if (bootIsShare) {
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
