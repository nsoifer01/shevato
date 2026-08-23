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
  const TP_BUILD = 70;
  const LS_KEY = 'trip-planner:v1';
  const TIMEFMT_KEY = 'trip-planner:timefmt';
  // Miles or kilometers, everywhere a distance prints. Same architecture as
  // TIMEFMT_KEY in every respect: a display preference on its own key, never
  // trip data, synced across signed-in devices (see app-sync-init.js) and
  // reconciled by the same storage / tp-sync:applied listeners.
  const DISTUNIT_KEY = 'trip-planner:distunit';
  // Celsius or Fahrenheit, everywhere a temperature prints. The third of the
  // same family: distances were switchable and times were switchable, but a
  // day card always said °C, which is a mixed unit system for the audience the
  // mile default is aimed at.
  const TEMPUNIT_KEY = 'trip-planner:tempunit';
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

  // One icon per food & drink kind (itemMealKind: the structured `meal` field
  // first, the legacy title prefix as fallback). The icon plus the meal class
  // is the WHOLE category treatment on a card - the title never repeats the
  // kind in words - so the label here is what a screen reader gets instead.
  const MEAL_ICONS = {
    breakfast: '🥐', brunch: '🥞', lunch: '🥗', dinner: '🍽️',
    drinks: '🍸', cafe: '☕', snack: '🍰', other: '🍽️',
  };

  // The form's type list: the six storage types plus Food & Drink, which is a
  // FORM/DISPLAY type only (storage stays activity + meal; see itemMealKind in
  // trip-logic for why a seventh storage type would be destroyed by stale
  // clients). NEVER hand this to repairTrips or sanitizeItem - those validate
  // STORAGE and must keep using TYPE_META, or 'food' would become storable.
  const MODAL_TYPE_META = {
    flight: TYPE_META.flight, stay: TYPE_META.stay, transport: TYPE_META.transport,
    local: TYPE_META.local, activity: TYPE_META.activity,
    food: { label: 'Food & Drink', icon: '🍽️', cls: 'type-food' },
    note: TYPE_META.note,
  };

  // The one place a row's visual identity is decided: which icon sits on the
  // rail, what a screen reader calls it, and which accent class paints it.
  function rowLook(it) {
    const kind = itemMealKind(it);
    if (kind) {
      return { cls: 'tp-t-meal', icon: MEAL_ICONS[kind] || '🍽️', label: mealLabel(kind) || 'Food & drink' };
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
    transportPrefillForGap, newItemDefaults, newItemDate, stayDatesFrom, stayCheckoutFor, flightOriginCode, routeSuggestion,
    nextUpEvent, defaultPackingItems,
    packingWho, packingRowsFor, packingProgress, packingRosterDrops, applyPackingRoster,
    tripAsTemplate,
    validateItem, coverageGaps, tripStats, overlappingTrips, MAX_TRIP_DAYS, DATE_MIN, DATE_MAX, isDateInRange,
    ISLANDISH, seaCrossing, distKm, flagEmoji, compass, fmtDur, modeOptions,
    routeBadges, routeFlags, routeTips, routeLinks, modeLink, ROUTE_HONESTY,
    classifyGeoMatch, geoMatchNote, GEO_MATCH_RANK, GEO_MATCH_TEXT,
    foldPlace, rankPlaceResults,
    HOTEL_TAGS, rankHotelResults, rankVenueResults, VENUE_EXCLUDE_KEYS,
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
    dayCards, dayMorningCity, emptyDayNote, departureOrigin, suggestedPassport, passportAssumptionParts, defaultPlanDay, planDayGroups, overnightTransit, arrivalConflicts,
    timelineGroups, isLongDetails, itemMapsQuery, displayTitle,
    // Food & Drink is a structured field now (`meal`), so app.js asks
    // itemMealKind rather than re-reading a title prefix; mealKind /
    // isFoodOrDrink / mealTitlePrefixes stay exported from trip-logic for the
    // assistant contract and the tests, and are deliberately not read here.
    isMealKind, mealLabel, splitMealTitle, itemMealKind, normalizeMealItem,
    weatherKey, summarizeClimate, weatherLine, weatherRange, pickMonthSamples, docGuard,
    FORECAST_DAYS, forecastEligible, forecastKey, forecastFresh, freshForecasts, summarizeForecast, forecastLine, forecastChipParts,
    extractTripActions, validateTripAction, buildAssistPackage, buildAssistSystemPrompt,
    buildPlanRequest, groupProposals, linkifySegments, parseMarkdown,
    normalizePlaceQuery, placeCacheKey, createPlacesQueue, mapsSearchUrl, assistMapsLink, costDisplayParts,
    hoursVerdict, hoursIntervalsForDate, hoursLineText, HOURS_CLOSING_SOON_MIN, recommendWindowMin,
    normalizeVenueCache, rememberVenue, placesLocationUpdates, pickVenueFeature,
    dayAnchor, dayDistanceChain, sameSpot, shortestRoute, routeStops, distanceChipLabel, distanceChipTitle, routeFooterText,
    proposalOrigin, dayBaseOrigin, suggestionOrigins, assistDistanceChipLabel, assistDistanceChipTitle,
    isPlaceType, isTravelLeg, directionsUrl, legTravelMode,
    setDistanceUnit, setTempUnit, fmtDist, dayTravelTotals, dayRouteMode, directionsRouteUrl, routeUrlChunks, candidateBadges,
    hasEstimate, displayCostOf, parseMoney, roundMoney, budgetVerdict, refundParts,
    readBudgetRange, normalizeBudgetFrom, budgetFigure,
    matchSampleTrip, sampleTripOptions, buildSampleTrip,
  } = window.TripLogic;

  // ---------- state ----------
  let db = loadDb();
  const ui = { search: '', filterType: '', filterStatus: '', filterTraveler: '', packingFilter: '', packingTripId: null, editingId: null, shiftTarget: null, tripModalMode: 'new', confirmAction: null, flashId: null, view: 'timeline' };

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
    // A shared trip gets a fresh uid() on every link open, so persisting its
    // expand/collapse clicks would leave one orphaned record per visit that
    // dropCollapse can never prune. In-memory is enough for the visit.
    if (sharedMode) return;
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

  // read-only share view: `db` holds the stranger's trip and save() is a no-op,
  // so nothing the visitor touches ever reaches trip-planner:v1. There is
  // deliberately NO parked copy of the visitor's own db here any more. It used
  // to be snapshotted on entry and written back on import, and because both
  // reconcile listeners stand down in shared mode that snapshot never learned
  // about anything saved since - so importing published a minutes-old view of
  // the visitor's whole db over their newer edits. Storage owns that data
  // throughout; this mode owns the screen (see importSharedTrip).
  let sharedMode = false;
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

  // Every field a renderer reads without asking what type it is. Storage is
  // untrusted JSON for the same reasons an import is - a sync peer running
  // older code, a hand edit, a future version writing a shape this one has not
  // met - and repairTrips only ever normalized the handful of fields that had
  // bitten it before. A number where a string belongs threw MID-RENDER and took
  // a whole view with it: `location: 123` emptied the Days view
  // ("(it.location || '').trim is not a function"), `startTime: 5` emptied the
  // Timeline too (fmtTime splits it), and neither was repaired, reported, nor
  // recoverable without editing storage by hand. The caps are sanitizeItem's,
  // so the two entry paths - import / share link, and storage / sync merge -
  // normalize to the same shape rather than drifting apart.
  //
  // Only fields that are PRESENT are touched (the title excepted, which has
  // always been coerced): adding a key to every legacy item would rewrite the
  // whole db on the first boot after a deploy, and a repair write landing
  // during a remote apply is the one thing the sync model asks us not to make
  // more common.
  const ITEM_TEXT_CAPS = [['location', 80], ['costNote', 80], ['confirmation', 40], ['details', 500]];
  const CLOCK_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
  function repairItemFields(it) {
    it.title = typeof it.title === 'string' ? it.title.slice(0, 120) : String(it.title == null ? '' : it.title).slice(0, 120);
    for (const [f, max] of ITEM_TEXT_CAPS) {
      if (it[f] === undefined) continue;
      if (typeof it[f] !== 'string') it[f] = String(it[f] == null ? '' : it[f]);
      if (it[f].length > max) it[f] = it[f].slice(0, max);
    }
    if (typeof it.startDate !== 'string') it.startDate = '';
    if (typeof it.endDate !== 'string') it.endDate = '';
    if (typeof it.endTime !== 'string') it.endTime = '';
    // a clock is HH:MM or nothing at all; anything else is not a time the app
    // can print, sort by, or compare a connection against
    if (it.endTime && !CLOCK_RE.test(it.endTime)) it.endTime = '';
    if (it.startTime !== undefined && (typeof it.startTime !== 'string' || (it.startTime && !CLOCK_RE.test(it.startTime)))) it.startTime = '';
    // a deadline that is not a real date is no deadline: the warnings panel
    // would count down to it and fmtDate would print nonsense
    if (it.bookBy !== undefined && !isIsoDate(it.bookBy)) it.bookBy = '';
    if (it.payment !== undefined && !PAYMENT_METHODS.includes(it.payment)) delete it.payment;
    if (it.paidBy !== undefined && typeof it.paidBy !== 'string') delete it.paidBy;
    if (it.travelers !== undefined && !Array.isArray(it.travelers)) delete it.travelers;
    // a split is keyed BY traveller name, so an array or a primitive is not one
    if (it.splitAmounts !== undefined && (typeof it.splitAmounts !== 'object' || it.splitAmounts === null || Array.isArray(it.splitAmounts))) delete it.splitAmounts;
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
      // The three trip-level stores their dialogs write into directly. A
      // `packing` that is not an array made the add form throw on push (and
      // ensurePacking read it as already seeded), and the roster and the
      // essentials block would do the same to their own readers.
      if (t.travelers !== undefined && !Array.isArray(t.travelers)) delete t.travelers;
      if (t.packing !== undefined && !Array.isArray(t.packing)) delete t.packing;
      if (t.essentials !== undefined && (typeof t.essentials !== 'object' || t.essentials === null || Array.isArray(t.essentials))) delete t.essentials;
      if (!Array.isArray(t.visaExtras)) t.visaExtras = [];
      t.visaExtras = t.visaExtras.filter(c => typeof c === 'string' && /^[A-Z]{2}$/.test(c));
      t.items = t.items.filter(it => it && typeof it === 'object');
      for (const it of t.items) {
        if (!it.id) it.id = uid();
        if (!TYPE_META[it.type]) it.type = 'note';
        if (!STATUS_META[it.status]) it.status = 'to-book';
        repairItemFields(it);
        // structured food & drink: junk `meal` values drop, and a legacy
        // prefixed title ("Dinner: Saba") migrates to meal:'dinner' +
        // title:'Saba' - deterministic (the four contract prefixes, colon
        // required), and the kind is preserved in the field the title used
        // to carry it in. Runs here so EVERY entry path (boot, sync merge,
        // share boot, undo snapshots reloaded from storage) is normalized.
        normalizeMealItem(it);
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
  // The three preference rows are CHECKBOXES, not actions. They used to be
  // plain buttons labelled with the thing they would switch TO ("Use
  // kilometers"), which left no way to tell whether the label described the
  // current state or the pending change - and assistive tech got nothing at
  // all: no role, no aria-checked, no state. Now the label names the setting
  // and the row carries its own on/off, visibly and programmatically.
  function syncPrefRow(sel, on, label) {
    const b = $(sel);
    if (!b) return;
    b.setAttribute('role', 'menuitemcheckbox');
    b.setAttribute('aria-checked', String(!!on));
    b.innerHTML = `<span class="pref-tick" aria-hidden="true">${on ? '✓' : ''}</span>${esc(label)}`;
  }
  function syncTimefmtLabel() {
    syncPrefRow('#timefmtBtn', use24h, '🕐 24-hour times');
    // the day-card time rail is sized for the format actually being printed:
    // "12:30 PM" needs ~64px of text, "12:30" needs ~36px (see --dc-rail-w)
    document.body.classList.toggle('tp-24h', use24h);
  }
  // The distance twin of use24h. TripLogic owns the actual formatting (every
  // chip, tooltip, footer and total goes through its fmtDist), so the app's
  // whole job here is to keep that one module-level unit in step with the
  // stored preference. Default miles, matching the 12-hour default above.
  let useKm = localStorage.getItem(DISTUNIT_KEY) === 'km';
  setDistanceUnit(useKm ? 'km' : 'mi');
  function syncDistunitLabel() {
    syncPrefRow('#distunitBtn', useKm, '📏 Kilometers');
  }
  // The temperature twin of useKm. Same storage shape, same sync listeners.
  let useF = localStorage.getItem(TEMPUNIT_KEY) === 'f';
  setTempUnit(useF ? 'f' : 'c');
  function syncTempunitLabel() {
    syncPrefRow('#tempunitBtn', useF, '🌡️ Fahrenheit');
  }
  // The traveller's LOCAL date, not a UTC slice of the clock. See localDateIso:
  // the dates on the items are zone-less wall dates, so the countdown, the
  // past-row dimming, the booking deadlines and the Up-next chip all have to
  // agree with the calendar on the traveller's own wall.
  function todayIso() { return localDateIso(new Date()); }

  // ---------- money ----------
  // The FALLBACK list: what Frankfurter (the ECB reference set ensureRates
  // fetches) published when this shipped, for the window before any rates have
  // loaded. It is not the authority — supportedCurrencies() is.
  //
  // A hardcoded list DRIFTS. BGN sat here after Bulgaria adopted the euro and
  // the ECB stopped publishing a rate for it, so the picker offered a currency
  // the app could not convert: a 100 BGN cost added exactly nothing to every
  // total, explained only by a terse "+ 1 not converted". Whenever real rates
  // are in hand they now decide what can be picked, so the offer and the
  // ability can no longer disagree.
  const CURRENCIES = [
    'AUD', 'BRL', 'CAD', 'CHF', 'CNY', 'CZK', 'DKK', 'EUR', 'GBP',
    'HKD', 'HUF', 'IDR', 'ILS', 'INR', 'ISK', 'JPY', 'KRW', 'MXN', 'MYR',
    'NOK', 'NZD', 'PHP', 'PLN', 'RON', 'SEK', 'SGD', 'THB', 'TRY', 'USD', 'ZAR',
  ];

  // What the traveller may PICK: every code the provider currently prices,
  // which is its base plus every code it quotes against it. Falls back to the
  // checked-in list until a rate payload has landed (rates are only fetched
  // once a trip actually holds a foreign cost, so most trips never need them).
  function supportedCurrencies() {
    if (rates && rates.base && rates.rates) {
      const live = new Set([rates.base, ...Object.keys(rates.rates)]);
      // A provider hiccup returning a stub payload must not shrink the picker
      // to two codes; the checked-in list is the floor.
      if (live.size >= 10) return [...live].sort();
    }
    return CURRENCIES;
  }
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
    const supported = supportedCurrencies();
    const known = new Set(supported);
    // The eight favourites only float to the top while the provider still
    // prices them: hoisting a code that can no longer be converted would put
    // the one unusable option in the most prominent slot.
    const common = COMMON_CURRENCIES.filter(c => known.has(c));
    const commonSet = new Set(common);
    // Codes already saved on this trip that the provider no longer prices (an
    // import, a hand edit, a currency the ECB dropped). Keeping them as options
    // is what stops merely OPENING a picker from rewriting the saved currency;
    // the group name says they are historical rather than on offer.
    const legacy = [...new Set(extra || [])].filter(c => c && !known.has(c));
    let html = '';
    if (common.length) html += `<optgroup label="Common">${common.map(opt).join('')}</optgroup>`;
    html += `<optgroup label="All currencies">${supported.filter(c => !commonSet.has(c)).map(opt).join('')}</optgroup>`;
    if (legacy.length) html += `<optgroup label="Saved with this trip (no live rate)">${legacy.map(opt).join('')}</optgroup>`;
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
    // Bound the request the same way the places lookup is (sendPlacesBatch):
    // without this, a hung connection leaves ratesFetching true forever and the
    // "Fetching exchange rates..." note never clears. On abort the catch below
    // flips ratesFailed, so the note falls back to "Could not fetch..." instead.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    // The fetching flag MUST clear before the render() below runs: render()
    // paints "Fetching exchange rates..." whenever ratesFetching is true, so
    // clearing it in a .finally() (which runs after the .catch's render)
    // left a failed fetch showing the stale fetching note until some later
    // unrelated render repainted the honest failure note + Retry.
    const settle = () => { clearTimeout(timer); ratesFetching = false; };
    fetch('https://api.frankfurter.dev/v1/latest?from=' + encodeURIComponent(base), { signal: ctrl.signal })
      .then(r => { if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
      .then(data => {
        settle();
        if (data && data.base && data.rates) {
          rates = { base: data.base, at: Date.now(), rates: data.rates };
          try { localStorage.setItem(RATES_KEY, JSON.stringify(rates)); } catch { /* best effort */ }
          ratesFailed = false;
        } else {
          ratesFailed = true;
        }
        render();
      })
      .catch(() => { settle(); ratesFailed = true; render(); });
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
    // `stats.start` is what lets this answer at all on a trip that has no stay
    // yet: coverageGaps measures from the first check-in, and with no stay to
    // measure from it used to return nothing, so the panel read "None" beside a
    // chip counting "0 of 4 nights booked" and the strip stayed hidden. The
    // gaps it returns carry the same shape, so "show" and "Add stay" work on
    // them exactly as they do on a hole between two bookings.
    const gaps = coverageGaps(stays, stats.end, overnightTravel, stats.start);
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
          // `legGap` marks the one warning whose fix the app can fill in
          // completely: both endpoints and the travel day are already in this
          // object, so "Add transport" opens a form with nothing left to type
          // but how you are getting there.
          legGap: g,
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

    // Something booked in a city the traveller has not reached yet. Narrow on
    // purpose (see arrivalConflicts): the only shape that cannot be right is an
    // item sitting in the DESTINATION of a leg that leaves that day and lands
    // later. A day trip out of the city you are staying in is a normal
    // itinerary and must never raise this.
    for (const c of arrivalConflicts(items)) {
      const subject = items.find(i => i.id === c.id);
      issues.push({
        level: 'warn',
        text: `"${c.title}" is in ${c.city} on ${fmtDate(subject.startDate)}, but "${c.legTitle}" does not land there until ${fmtDate(c.arriveDate)}. Move it to ${fmtDate(c.arriveDate)} or later.`,
        ids: [c.id, c.legId],
      });
    }

    // Costs left OUT of every total because no rate exists for their currency.
    // The totals have always said "+ 2 not converted", which names neither the
    // items nor the reason, so a traveller could see their trip total quietly
    // understate real spend with nothing to act on. This is the one surface in
    // the app built for "something needs your attention", so the shortfall gets
    // a line here with the item names on it, reachable by keyboard and readable
    // on a phone (a tooltip is neither).
    const unconvertible = tripMoney(trip).planned.unconverted;
    if (unconvertible.length) {
      const codes = [...new Set(unconvertible.map(it => it.costCurrency || trip.currency || 'USD'))];
      const named = unconvertible.slice(0, 3).map(it => `"${it.title || '(untitled)'}"`).join(', ');
      const rest = unconvertible.length > 3 ? `, +${unconvertible.length - 3} more` : '';
      const subject = unconvertible.length === 1 ? 'this cost is' : `these ${unconvertible.length} costs are`;
      const them = unconvertible.length === 1 ? 'it' : 'them';
      // Two different problems wear the same symptom, and telling them apart is
      // the difference between useful advice and a wild goose chase. A rate
      // table that never arrived (offline, blocked, provider down) is not the
      // currency's fault, and "re-enter it in a currency the rates cover" sent
      // the traveller off to retype money that is perfectly fine. The totals
      // footer already knows the difference and offers Retry; this line now
      // says the same thing.
      issues.push({
        level: 'warn',
        text: ratesFailed
          ? `Exchange rates could not be fetched, so ${subject} shown in ${unconvertible.length === 1 ? 'its' : 'their'} own currency and left out of every total: ${named}${rest}. Use Retry under the totals when you are back online.`
          : `No exchange rate for ${codes.join(', ')}, so ${subject} left out of every total: ${named}${rest}. Re-enter ${them} in a currency the rates cover to include ${them}.`,
        ids: unconvertible.map(it => it.id),
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

  // The empty scaffold an opening-hours line paints into once the SAME Places
  // response that carries the rating resolves this venue (the hours fields ride
  // the existing lookup at the existing SKU; see tp-places.mjs). Empty is the
  // honest default and stays empty when hours are unknown: a venue nobody
  // could verify must read as UNVERIFIED, never as open. The date is the
  // itinerary's scheduled date - what the traveller's plan asks about - and
  // deliberately not the real-world clock, so nothing here can claim "open
  // now" about a day months away. The optional time is what the closed /
  // closes-soon verdict is judged against. `windowMin` (assistant slots only)
  // is the category's minimum recommendation window: with it the verdict can
  // also come back 'closingSoon' - technically open, too little time left to
  // recommend. Days-view slots pass none, so a traveller's own rows keep the
  // purely advisory behaviour.
  function hoursSlotHtml(cls, mapsQuery, date, time, windowMin) {
    const key = placeCacheKey(mapsQuery);
    if (!key || !isIsoDate(date)) return '';
    const t = /^\d{2}:\d{2}$/.test(String(time || '')) ? time : '';
    const win = Number.isInteger(windowMin) && windowMin > 0 ? ` data-hours-window="${windowMin}"` : '';
    return `<span class="${cls} tp-hours" data-place-key="${esc(key)}" data-hours-date="${esc(date)}"${t ? ` data-hours-time="${esc(t)}"` : ''}${win}></span>`;
  }

  // A travel leg that names a real destination (a "Return to hotel" carries the
  // hotel's own name on purpose) opens DIRECTIONS to it rather than a place
  // listing with a star rating on it: the rating answers "is this worth going
  // to", and the ride home to a hotel you already booked is not a venue anyone
  // is choosing. It also costs nothing - no data-place-key means hydrateRatings
  // never asks Places for it - and the destination's coordinates still arrive
  // through the stay's own lookup and the Photon top-up, so the distance chip
  // is unaffected.
  function tripDirectionsHtml(it) {
    const dest = itemMapsQuery(it);
    const href = dest ? directionsUrl('', dest, legTravelMode(it.type, null)) : '';
    if (!href) return '';
    return `<a class="tp-maps-link tp-dir-link" data-dir-dest="${esc(dest)}" data-dir-type="${esc(it.type)}"`
      + ` href="${esc(href)}" target="_blank" rel="noopener">`
      + `<span class="tpm-label">Directions</span></a>`;
  }

  // The one place both views ask "does this item open on Maps at all?", so a
  // hotel, a restaurant and a museum can never diverge on whether they get the
  // section (see itemMapsQuery for which types derive a query), and a leg can
  // never diverge from another leg on getting directions instead of a rating.
  const mapsHtmlFor = it => (isTravelLeg(it) ? tripDirectionsHtml(it) : tripMapsRatingHtml(itemMapsQuery(it)));

  // A Days-view PLACE row's own directions action: how to get HERE from the
  // stop before it. Rendered destination-only (Maps then asks for the start,
  // which is the clean degrade when nothing located the leg); the distance
  // pass upgrades origin + mode from the same chain leg the chip prints.
  // data-dir-type="place" tells writeDistChip to pick walking/transit by the
  // leg's own length (the hop judgement), never the intercity 'driving' a
  // flight's link uses.
  function dcDirectionsHtml(it) {
    const dest = itemMapsQuery(it);
    if (!dest) return '';
    const href = directionsUrl('', dest, 'transit');
    return `<a class="tp-maps-link tp-dir-link dc-dir" data-dir-dest="${esc(dest)}" data-dir-type="place"`
      + ` href="${esc(href)}" target="_blank" rel="noopener" aria-label="Directions to ${esc(displayTitle(it))}">`
      + `<span class="tpm-label">🧭 Directions</span></a>`;
  }

  // The issue list render() last built. computeIssues is O(n^2) over stays (the
  // overlap check) and over timed items (sameTimeCollisions), and the day view
  // wants exactly the list that has just been computed, so it reads this rather
  // than paying for the whole pass a second time on every repaint. It cannot go
  // stale: every write to a trip goes through save() + render(), and setView -
  // the one applyView call outside render() - changes no data at all.
  let currentIssues = [];

  function render() {
    try {
      // A re-render rebuilds #daysList, so a pointer drag in progress would be
      // holding a detached row: onRowDragMove would re-insert that stale node
      // into the fresh list (a visual duplicate) and the drop would commit an
      // order read from that mixed DOM. Remote merges re-render under open UI
      // by design, so the drag is abandoned rather than corrupted.
      if (dragCtx) cancelRowDrag();
      ensureTrip();
      renderTripSelect();
      const trip = activeTrip();
      // A trip switch retires the lookups the PREVIOUS trip queued but never
      // sent: those venues are off screen now and nobody is waiting for them.
      // Batches already on the wire are left alone - they are paid for, and
      // their results land in the shared session cache, which is keyed by venue
      // rather than by trip, so a result can only ever paint the venue it names.
      placesGeneration(trip && trip.id);
      // An empty trip has nothing to search, filter, switch views over or undo,
      // and on a phone that inapplicable chrome filled the whole first screen:
      // "Add your first item" and "Load an example trip" both started ~110px
      // BELOW the fold, so the two things a first-time visitor is there to
      // press were the two things they could not see. The class lets the phone
      // stylesheet stand those controls down until there is something to use
      // them on; the desktop layout is unaffected.
      document.body.classList.toggle('tp-trip-empty', !(trip && trip.items && trip.items.length));
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
    if (!s.start || !s.end || s.totalTripNights < 2) { box.hidden = true; return; }
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
    // Whole-trip and deliberately filter-blind: tripStats already excludes
    // cancelled items, so this is the count of things actually on the plan,
    // not the count of rows a filter happens to be showing.
    //
    // That exclusion has to be VISIBLE, because selection does not share it:
    // a trip with a cancelled item showed "3 items" here and "4 selected" in
    // the bulk bar at the same time, and the delete confirm then offered to
    // remove 4. Both numbers were right about different sets and nothing said
    // so. The tail names the difference wherever it exists.
    const cancelled = trip.items.length - s.count;
    const cancelledTail = cancelled > 0 ? ` <small>+ ${cancelled} cancelled</small>` : '';
    chips.push(chip('Items', `${s.count} ${s.count === 1 ? 'item' : 'items'}${cancelledTail}`));
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
  // The slug class is what lets the phone layout put the chips that matter on
  // the road first (see .chip--issues in the mobile block): the strip is one
  // swipeable row there, and Issues being authored last meant the trip's whole
  // warning state sat off the right edge where nothing hinted at it.
  const chipSlug = k => 'chip--' + String(k).toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const chip = (k, v, cls = '', ratio = null) => `<div class="chip ${chipSlug(k)} ${cls}${ratio == null ? '' : ' has-bar'}">`
    + `<div class="k">${k}</div><div class="v">${v}</div>`
    + (ratio == null ? '' : `<span class="tt-bar" aria-hidden="true"><i style="width:${(Math.max(0, Math.min(1, ratio)) * 100).toFixed(2)}%"></i></span>`)
    + `</div>`;

  // Reveal the full issue list. `<details>` is closed by default so the summary
  // strip stays one line on a phone, so anything pointing AT an issue must open
  // it rather than assume the traveller found the disclosure triangle.
  function openIssuesPanel() {
    const box = $('#issuesBox');
    const det = $('#issuesDetails');
    if (!det || box.hidden) return;
    det.open = true;
    det.scrollIntoView({ block: 'nearest' });
    $('#issuesSummary').focus({ preventScroll: true });
  }

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
      // The city-change warning gets the same treatment for the same reason:
      // it already names both ends and the day, so restating them into a blank
      // form was work the panel could do itself.
      if (iss.legGap && !sharedMode && transportPrefillForGap(iss.legGap)) {
        acts.push(`<button type="button" class="issue-jump issue-add-transport" data-add-transport="${idx}">Add transport</button>`);
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
    // "Food & drink" and "Activities" are two filters over ONE storage type,
    // split by the same itemMealKind the row icon reads: picking Activities
    // must not hand back every dinner on the trip, and vice versa.
    if (ui.filterType) {
      const kind = itemMealKind(it);
      if (ui.filterType === 'food') { if (!kind) return false; }
      else if (ui.filterType === 'activity') { if (it.type !== 'activity' || kind) return false; }
      else if (it.type !== ui.filterType) return false;
    }
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
  // id -> { level, text }. The level drives the row's colour, and the text is
  // what makes that colour READABLE: an amber border on a stay said only "this
  // row is involved in something", with the sentence explaining it sitting in
  // the (collapsed) Issues panel and nothing at all reaching a screen reader.
  // A row can be named by more than one issue, so the sentences accumulate and
  // an error always outranks a warning for the colour.
  function buildIssueById(issues) {
    const map = {};
    for (const iss of issues) for (const id of iss.ids) {
      const prev = map[id];
      const level = prev && prev.level === 'error' ? 'error' : iss.level;
      map[id] = { level, texts: prev ? prev.texts.concat(iss.text) : [iss.text] };
    }
    return map;
  }
  const issueLevelOf = e => (e && e.level) || '';

  // The marker that makes an issue readable ON the row. Colour alone said only
  // "this row is involved in something": the sentence explaining it lived in the
  // Issues panel, which is collapsed by default, and nothing reached a screen
  // reader or a traveller who cannot tell amber from the default border. This
  // carries the same sentence as its accessible name and its tooltip, so the
  // row states the problem in text, in shape and in colour.
  function issueBadgeHtml(entry) {
    const level = issueLevelOf(entry);
    if (!level) return '';
    const text = (entry.texts || []).join(' ');
    const label = `${level === 'error' ? 'Error' : 'Warning'}: ${text}`;
    return `<button type="button" class="row-issue ${level === 'error' ? 'is-err' : 'is-warn'}"`
      + ` data-issue-jump="1" title="${esc(label)}" aria-label="${esc(label)}">`
      + `${level === 'error' ? '⛔' : '⚠️'}</button>`;
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

  // "Which trip am I looking at" is one concept and two pieces of state: the
  // id, and a selection that was made from the rows of the trip you WERE
  // looking at, which can never mean anything on another board. Only the trip
  // picker dropped that selection, so every other way of arriving at a
  // different trip - a cross-trip search result, the overlapping-trip warning's
  // link, a duplicate, a template, an import, a restore landing elsewhere, the
  // trip after a delete - left the bulk bar sitting over the new board reading
  // "0 selected" with checkboxes on rows nobody picked. Filters are
  // deliberately NOT reset: they are a view the traveller set, and surviving a
  // switch is what the overlap warning's link promises.
  function setActiveTrip(id) {
    if (db.activeTripId !== id) exitSelectMode();
    db.activeTripId = id;
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
      <select class="bulk-status bulk-cur" id="bulkCurrency" aria-label="Convert the costs of the selected items to another currency" style="margin-left:0">
        <option value="">Convert to...</option>
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
  // The picker is a CONVERSION, not a relabel. It used to write costCurrency and
  // leave the number alone, so a $480 flight silently became a €480 flight: one
  // dropdown moved a trip total by hundreds with no confirmation, overwrote the
  // source currency of every mixed-currency item, and the only undo died on the
  // next reload. Money now goes through the same convertAmount every total in
  // the app already uses, behind the same confirm every other bulk action has.
  //
  // The whole selection is PLANNED before anything is written: a run that
  // half-converted would be the same silent corruption in a new shape. An item
  // whose rate is missing is never touched and is named in the confirm, so the
  // traveller sees exactly what will and will not move.
  function bulkSetCurrency(code) {
    if (!code || !selIds.size) return resetBulkCurrency();
    const trip = activeTrip();
    const priced = trip.items.filter(it => selIds.has(it.id)
      && it.cost != null && it.cost !== '' && !isNaN(it.cost));
    if (!priced.length) { toast('None of the selected items have a cost'); return resetBulkCurrency(); }

    const ratesObj = activeRates(trip);
    const plan = [], blocked = [];
    let already = 0;
    for (const it of priced) {
      const from = it.costCurrency || trip.currency || 'USD';
      if (from === code) { already++; continue; }
      const converted = convertAmount(Number(it.cost), from, code, ratesObj);
      if (converted == null) blocked.push({ it, from });
      else plan.push({ it, from, amount: roundToCurrency(converted, code) });
    }

    if (!plan.length && !blocked.length) {
      toast(`Every selected cost is already in ${code}`);
      return resetBulkCurrency();
    }
    // Nothing convertible at all is a rates problem, not a user error: say so
    // and change nothing rather than writing a currency we cannot back up.
    if (!plan.length) {
      toast(ratesObj
        ? `No exchange rate for ${[...new Set(blocked.map(b => b.from))].join(', ')} → ${code}. Nothing was changed.`
        : 'Exchange rates have not loaded yet, so nothing was converted. Try again in a moment.');
      return resetBulkCurrency();
    }

    const lines = [`${plan.length} ${plan.length === 1 ? 'cost is' : 'costs are'} converted to ${code} at today's rates, so the amounts change as well as the currency.`];
    if (already) lines.push(`${already} ${already === 1 ? 'is' : 'are'} already in ${code}.`);
    if (blocked.length) {
      const named = blocked.slice(0, 3).map(b => `${b.it.title || '(untitled)'} (${b.from})`).join(', ');
      const rest = blocked.length > 3 ? `, +${blocked.length - 3} more` : '';
      lines.push(`${blocked.length} cannot be converted and ${blocked.length === 1 ? 'keeps its' : 'keep their'} current currency: ${named}${rest}.`);
    }
    lines.push('You can undo this until you reload the page.');

    confirmDialog(`Convert ${plan.length} ${plan.length === 1 ? 'cost' : 'costs'} to ${code}?`,
      lines.join(' '), `Convert to ${code}`, () => {
        for (const p of plan) { p.it.cost = p.amount; p.it.costCurrency = code; }
        save(`${plan.length} ${plan.length === 1 ? 'cost' : 'costs'} converted to ${code}`);
        render();
      });
    resetBulkCurrency();
  }

  // Money the traveller will read back in the Cost field, so it has to look like
  // money in THAT currency: a converted yen amount is 49,285, not 49,284.58.
  // Intl already knows how many minor units a currency has; roundMoney's flat
  // two decimals is right for the majority and wrong for the zero-decimal ones.
  function roundToCurrency(amount, code) {
    let digits = 2;
    try {
      digits = new Intl.NumberFormat('en-US', { style: 'currency', currency: code })
        .resolvedOptions().maximumFractionDigits;
    } catch { /* unknown code: two decimals is the safe default */ }
    const f = Math.pow(10, digits);
    return Math.round(amount * f) / f;
  }

  // The picker is an action, not a setting: leaving it showing "EUR" after the
  // run (or after a cancel) reads as "these items are EUR now" even when the
  // traveller backed out. Deliberately NOT a render(): this runs while the
  // confirm overlay is open, and rebuilding the board underneath it is both
  // unnecessary (the bar is redrawn when the action lands) and a way to fight
  // the dialog for focus.
  function resetBulkCurrency() {
    const sel = $('#bulkCurrency');
    if (sel) sel.value = '';
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
    // "Permanently" was never true: the delete goes through save(), so Undo
    // brings every one of them back. Overstating finality makes a safe action
    // read as dangerous, and buries the caveat that IS real (below).
    const notes = [`${n} items will be removed from this trip.`];
    if (stays.length) {
      notes.push(`This includes ${stays.length === 1 ? 'a stay' : `${stays.length} stays`} (${stays.map(s => s.title).join(', ')}), so those nights lose their booking.`);
    }
    if (doomed.some(it => (docCounts.get(it.id) || 0) > 0)) notes.push('Attached documents cannot be recovered.');
    notes.push('You can undo this until you reload the page.');
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
    // Paint any ratings the session already knows, then register the rest with
    // the queue: rows are looked up as they approach the viewport, so a
    // re-render, a repeat venue or a trip with no mapsQuery items all cost
    // nothing at all.
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
      // costsByType emits the display grouping, so 'food' is a real row key
      // here: MODAL_TYPE_META is the table that has it (see rowLook).
      const meta = MODAL_TYPE_META[r.type] || TYPE_META.note;
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
      const l = issueLevelOf(issueById[it.id]);
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

  function rowHtml(trip, it, issueEntry, isPast, pickable) {
    const issueLevel = issueLevelOf(issueEntry);
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
    const issueBadge = issueBadgeHtml(issueEntry);
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
          <div class="c-title">${esc(displayTitle(it))}<span class="tp-clip" data-clip-for="${it.id}" title="Has attached documents" hidden>📎</span>${it.location ? `<span class="c-loc">${esc(it.location)}</span>` : ''}${issueBadge}</div>
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
    const issueEntry = issueById && issueById[it.id];
    const issueLevel = issueLevelOf(issueEntry);
    const issueCls = issueLevel === 'error' ? ' has-err' : (issueLevel === 'warn' ? ' has-warn' : '');
    const issueBadge = issueBadgeHtml(issueEntry);
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
    // Days view has a chain (Timeline does not), so every PLACE stop can also
    // offer directions FROM the stop before it: the link renders
    // destination-only here and writeDistChip fills the origin and the mode in
    // from the same leg its distance chip prints, so the two can never
    // disagree. A travel leg already gets its Directions through mapsHtmlFor.
    const dir = (ev.kind === 'checkout' || isTravelLeg(it)) ? '' : dcDirectionsHtml(it);
    // Opening hours go to ACTIVITY rows alone: restaurants, bars, museums and
    // sights all ride that type, which is exactly the set of rows where "will
    // it be open when I get there" is a real question. Flights, transport,
    // local legs and notes are not places anyone walks into (same rule as the
    // rating), a stay's check-in/check-out rows describe a booking rather than
    // a visit (and hotels mostly read "Open 24 hours", which is noise), and a
    // cancelled row's hours answer a question nobody is asking. The slot is
    // painted from the SAME session cache the rating pass fills, so rendering
    // it never costs a request the row was not already making.
    const hrs = (ev.kind === 'checkout' || cancelled || it.type !== 'activity') ? ''
      : hoursSlotHtml('dc-hours', itemMapsQuery(it), it.startDate, it.startTime);
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
            <div class="dc-title">${esc(displayTitle(it))}${clip}${loc}${issueBadge}</div>
            ${ref}
          </div>
          <div class="dc-facts">${cost}${maps}${hrs}${dir}</div>
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
    // Two frequent actions stay visible (assistant, add); the three occasional
    // day operations fold behind one "..." toggle so the header reads as a
    // heading with actions rather than a toolbar of five equal icons. Nothing
    // is removed: the menu holds the same three buttons, same data-acts, same
    // disabled reasons, and the shared-mode gate is unchanged (no menu at all).
    const editBtns = sharedMode ? '' : `
            <button class="row-btn" data-act="add-day" data-date="${card.date}" title="Add an item on this day" aria-label="Add an item on ${esc(fmtDate(card.date))}">+</button>
            <span class="dc-menu-wrap">
              <button class="row-btn dc-more" data-act="day-menu" data-date="${card.date}" aria-haspopup="menu" aria-expanded="false" title="More day actions" aria-label="More actions for ${esc(fmtDate(card.date))}">⋯</button>
              <div class="dc-menu" role="menu" aria-label="Actions for ${esc(fmtDate(card.date))}" hidden>
                <button class="dm-item" role="menuitem" data-act="share-day" data-date="${card.date}"${canCopy ? '' : ' disabled'} title="${canCopy ? 'Copy this day as message-ready text' : 'Nothing on this day to copy'}" aria-label="Copy ${esc(fmtDate(card.date))} as text"><span class="dm-ico">📋</span>Copy day as text</button>
                <button class="dm-item" role="menuitem" data-act="duplicate-day" data-date="${card.date}"${canClear ? '' : ' disabled'} title="${canClear ? 'Copy every item on this day to another date' : 'Nothing on this day to copy'}" aria-label="Copy everything on ${esc(fmtDate(card.date))} to another date"><span class="dm-ico">📄</span>Copy to another date</button>
                <button class="dm-item danger" role="menuitem" data-act="clear-day" data-date="${card.date}"${canClear ? '' : ' disabled'} title="${canClear ? 'Delete every item on this day' : 'Nothing on this day to delete'}" aria-label="Delete every item on ${esc(fmtDate(card.date))}"><span class="dm-ico">${TRASH_SVG}</span>Delete day's items</button>
              </div>
            </span>`;
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
    const hadFocus = document.activeElement && document.activeElement.matches
      && document.activeElement.matches(`select[data-status-for="${CSS.escape(id)}"]`);
    it.status = status;
    save();
    render();
    // render() replaced the <select> the keyboard traveller was sitting on, so
    // hand focus to its rebuilt twin (same pattern the strip cells use) rather
    // than dropping them on <body>.
    if (hadFocus) {
      const next = document.querySelector(`select[data-status-for="${CSS.escape(id)}"]`);
      if (next) next.focus({ preventScroll: true });
    }
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
      // deleteWarnings already names documents, the one thing an Undo cannot
      // bring back; the item itself always can.
      const notes = [`"${it.title}" will be removed from this trip.`, ...deleteWarnings(it), 'You can undo this until you reload the page.'];
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
    if (elsewhere) setActiveTrip(t2.id);
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
    notes.push('You can undo this until you reload the page.');
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
    // same re-entry guard submitItemForm documents: a double-click or two
    // rapid Enters lands a second submit after the overlay closed, and the
    // fields still hold what was just applied, so it would copy the day twice
    if (!$('#dupDayOverlay').classList.contains('open')) return;
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
    // the clones carried the source day's manual `order` numbers into the
    // TARGET day's tie groups, where they collide with whatever is already
    // ordered there; one renumber keeps every group gap-free
    normalizeOrders(trip.items);
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
      // The toast lands at the screen edge while the eye is on the menu item
      // that was just pressed, so the item itself confirms too: its icon
      // flashes a checkmark (the menu deliberately stays open for this one
      // action - see the days-list click handler). Re-queried by date because
      // a render between click and now would detach the original node.
      const btn = document.querySelector(`button[data-act="share-day"][data-date="${date}"]`);
      const ico = btn && btn.querySelector('.dm-ico');
      if (ico) {
        ico.textContent = '✅';
        btn.title = 'Copied';
        setTimeout(() => {
          const b = document.querySelector(`button[data-act="share-day"][data-date="${date}"]`);
          const i = b && b.querySelector('.dm-ico');
          if (i && i.textContent === '✅') { i.textContent = '📋'; b.title = 'Copy this day as message-ready text'; }
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

  // ---------- day-card overflow menu ----------
  // One menu open at a time, DOM-held state only: a re-render rebuilds
  // #daysList and the menu simply comes back closed, so there is nothing to
  // reconcile. The card class lifts the day card's overflow clip and stacking
  // order while its menu is up (see .day-card.has-open-menu).
  function closeDayMenus(focusToggle) {
    let closed = false;
    document.querySelectorAll('.dc-menu-wrap.open').forEach(w => {
      w.classList.remove('open');
      const m = w.querySelector('.dc-menu');
      if (m) m.hidden = true;
      const b = w.querySelector('[data-act="day-menu"]');
      if (b) {
        b.setAttribute('aria-expanded', 'false');
        if (focusToggle) b.focus({ preventScroll: true });
      }
      const card = w.closest('.day-card');
      if (card) card.classList.remove('has-open-menu');
      closed = true;
    });
    return closed;
  }

  function toggleDayMenu(btn) {
    const wrap = btn.closest('.dc-menu-wrap');
    if (!wrap) return;
    const wasOpen = wrap.classList.contains('open');
    closeDayMenus();
    if (wasOpen) return;
    wrap.classList.add('open');
    const m = wrap.querySelector('.dc-menu');
    if (m) m.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    const card = wrap.closest('.day-card');
    if (card) card.classList.add('has-open-menu');
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
    // The caveat has to be VISIBLE. A bare "18-28°C" on a day three months out
    // reads as a forecast, and the honest wording lived only in this tooltip -
    // which a phone cannot show at all. A near-term day already wears a
    // "Forecast" pill, so the climate figure wears its twin and the two are
    // told apart without hovering anything.
    const tag = chip.querySelector('.dc-chip-tag');
    tag.textContent = 'Typical';
    tag.hidden = false;
    chip.title = `${weatherLine(place, rec)}. Typical for this month across the last ${WEATHER_YEARS} years of records, not a forecast.`;
    chip.hidden = false;
    // same header-wrapping allowance the forecast pill takes on a phone
    const card = chip.closest('.day-card');
    if (card) card.classList.add('has-forecast');
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
  // A generation token: two overlapping calls (open item A, cancel, open item
  // B before A's IndexedDB read lands) race on the same #docsList node, and
  // the LOSER used to paint the wrong item's documents into the open modal.
  let docsListGen = 0;
  async function renderDocsList(itemId) {
    const gen = ++docsListGen;
    const list = $('#docsList');
    revokeDocUrls();
    try {
      const docs = await listDocs(itemId);
      if (gen !== docsListGen) return;
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
      if (gen !== docsListGen) return;
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

  // "Book by" is a reminder for something still on the to-book list, so the
  // row bows out once the item is Booked or Cancelled. It used to sit there
  // fully active under a hint reading "...while the item is still 'To book'",
  // directly contradicting the status one field to its left.
  function syncBookByRow() {
    const status = $('#inStatus').value;
    const pending = status !== 'booked' && status !== 'cancelled';
    const row = $('#fBookBy');
    const hint = $('#bookByHint');
    if (!row) return;
    row.classList.toggle('is-muted', !pending);
    $('#inBookBy').disabled = !pending;
    if (hint) {
      hint.textContent = pending
        ? 'Warnings nudge you as this date nears, while the item is still "To book".'
        : (status === 'booked' ? 'Already booked, so no reminder is needed.' : 'This item is cancelled, so no reminder is needed.');
    }
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

  // The city an IATA code names, from the bundled table and nothing else. ''
  // until the table has loaded, which is a rung newItemCity simply skips.
  function iataCity(code) {
    if (!airportRows) return '';
    const row = airportRows.find(r => r.iata === code);
    return row ? (row.city || '') : '';
  }

  // `preset` is either the date a day card's + button was pressed on, or a
  // whole opening shape (type, dates, place, title) for a form somebody else
  // filled in - the gap warnings' "Add stay" and "Add transport". It applies to
  // a NEW item only: an edit opens on what the item actually says.
  //
  // Anything the preset does NOT name, a new item derives from the trip
  // (newItemDefaults: the type, the date, the city). The preset always wins,
  // the item being edited always wins over both, and a derived value only ever
  // lands in a field that would otherwise have opened empty.
  function openItemModal(itemId, preset) {
    ui.editingId = itemId;
    const pre = typeof preset === 'string' ? { startDate: preset } : (preset || {});
    const it = itemId ? activeTrip().items.find(x => x.id === itemId) : null;
    const preStay = !it && pre.type === 'stay';
    const auto = it ? null : newItemDefaults(activeTrip(), {
      today: todayIso(),
      focusDate: pre.startDate,
      type: TYPE_META[pre.type] ? pre.type : '',
      resolveIata: iataCity,
    });
    $('#itemModalTitle').textContent = it ? 'Edit item' : 'Add item';
    $('#itemSaveBtn').textContent = it ? 'Save changes' : 'Add item';
    // The FORM type, which is the storage type plus the Food & Drink split:
    // an activity carrying a meal kind opens on Food & Drink with its subtype
    // selected, so editing an old "Dinner: Saba" shows Dinner + "Saba" and the
    // traveller never has to delete a prefix by hand. A preset (the closed-
    // proposal hand-off) may also name `meal` for the same reason.
    const preMeal = !it && isMealKind(pre.meal) ? pre.meal : '';
    const editMeal = it ? itemMealKind(it) : '';
    setModalType(it ? (editMeal ? 'food' : it.type)
      : (preMeal ? 'food' : (MODAL_TYPE_META[pre.type] ? pre.type : auto.type)));
    setModalMeal(editMeal || preMeal || 'dinner');
    // The title is the VENUE NAME alone. An item that has been through repair
    // already carries it clean; the fallback split covers the one path repair
    // cannot reach - a read-only shared trip, whose items are never repaired.
    $('#inTitle').value = it
      ? (editMeal && !isMealKind(it.meal) ? (splitMealTitle(it.title) || {}).title || it.title : it.title)
      : (pre.title || '');
    // A rating belongs to the row a traveller picked in THIS form, never to a
    // saved item, so opening any item starts without one. The picked-venue
    // coordinates go with it for the same reason.
    clearStayRating();
    venuePick = null;
    syncFlightPickers(it);
    autoFilled.clear();
    $('#inLocation').value = it ? (it.location || '') : (pre.location || auto.location);
    $('#inStart').value = it ? (it.startDate || '') : (pre.startDate || auto.startDate);
    // Everything a NEW form opened with came from the app, not from a person.
    if (!it) {
      if ($('#inLocation').value) autoFilled.add('location');
      if ($('#inStart').value) autoFilled.add('start');
    }
    $('#inEnd').value = it && it.type === 'stay' ? (it.endDate || '') : (preStay ? (pre.endDate || '') : '');
    $('#inArrDate').value = it && it.type !== 'stay' ? (it.endDate || '') : '';
    $('#inArrTime').value = it ? (it.endTime || '') : '';
    // A preset may carry the time (the closed-proposal hand-off does: the
    // whole point of that hand-off is putting the time in front of the
    // traveller to change), and a preset value is a PREFILL like any other -
    // on screen, editable, saved only when they save.
    $('#inTime').value = it ? (it.startTime || '') : (pre.startTime || '');
    $('#inStatus').value = it ? it.status : 'to-book';
    syncBookByRow();
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
    $('#inDetails').value = it ? (it.details || '') : (pre.details || '');
    renderDetailLinks(it);
    syncDocsSection(it);
    clearFieldErrors();
    // a blank flight form can already say where it leaves from
    if (!it) prefillFlightOrigin();
    openOverlay('#itemOverlay');
    // preventScroll keeps the modal parked at its heading; without it the
    // overlay scrolls the title field up and hides the heading on phones
    focusFirstField(!!it);
  }

  // Where the cursor lands, per type. A flight's first real field is the
  // airport pair, and the form says so ("Picking both writes the title below")
  // - but focus went to Title regardless, so the form invited the traveller to
  // type a title it was about to write for them. Everything else opens on its
  // own first field, which is still Title.
  //
  // Only for a NEW item: an edit is about changing something specific, and
  // stealing focus to the top of the form fights that.
  function focusFirstField(isEdit) {
    const flightRoute = $('#inFlightFrom');
    // offsetParent, not the `hidden` property: setModalType shows and hides the
    // per-type rows with a class, so `hidden` is false for the airport pair even
    // on an Activity. Focusing an invisible input is a silent no-op, which left
    // the cursor on the dialog itself rather than on any field at all.
    const routeShown = !!(flightRoute && flightRoute.offsetParent);
    const target = (!isEdit && routeShown && !flightRoute.value) ? flightRoute : $('#inTitle');
    target.focus({ preventScroll: true });
  }

  // WHICH FIELDS THE APP FILLED, and may therefore revise.
  //
  // The round's rule is "never overwrite what the traveller typed", and until
  // this existed the code enforced it by only ever writing into an EMPTY field.
  // That is too blunt in both directions: it let a derived date block a better
  // derived date (choosing Stay after the form had already filled a departure
  // date kept the night spent on the plane), and it left a derived city stranded
  // on the wrong day when the traveller moved the date.
  //
  // So ownership is tracked instead. A field the app filled stays revisable; a
  // field a human touches leaves the set for good and nothing writes to it
  // again. Cleared on every open, and an explicit PICK counts as human.
  const autoFilled = new Set();
  const appOwns = (key, el) => autoFilled.has(key) || !el.value.trim();

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

  // The STORAGE type behind the form type: 'food' is a form/display type and
  // is stored as an activity carrying a `meal` kind (see itemMealKind). Every
  // read that feeds storage, validation or the trip-logic derivations goes
  // through this, so 'food' can never reach the db as a type.
  const storageTypeOf = t => (t === 'food' ? 'activity' : t);

  // Which food & drink kind the form is on. Only meaningful while modalType is
  // 'food'; kept across a type switch so flipping to Activity and back does not
  // silently lose the Dinner the traveller had already chosen.
  let modalMeal = 'dinner';
  function setModalMeal(kind) {
    modalMeal = isMealKind(kind) ? kind : 'dinner';
    const sel = $('#inMeal');
    if (sel) sel.value = modalMeal;
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
    const food = t === 'food';
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
    // The Title field asks for ONE thing at every type: the name of the place
    // (or, for a leg, the route). It never asks for a classification - that is
    // what the type picker and the Food & Drink subtype are for - so nothing
    // here mentions a prefix convention any more.
    $('#titleLabel').textContent = stay ? 'Hotel / stay name' : (food ? 'Venue name' : 'Title');
    $('#inTitle').placeholder = stay ? 'e.g. Hotel Mystays Premier Akasaka'
      : (food ? 'e.g. Saba' : (t === 'flight' ? 'e.g. Shreveport to Tokyo (HND)' : 'e.g. Grand Palace tour'));
    // The subtype control exists for exactly one type, and only then: every
    // other type sees no trace of it (the form reveals what is useful for the
    // item in hand and nothing else).
    $('#fMeal').style.display = food ? '' : 'none';
    // The rating belongs to a hotel that was picked from the dropdown, so
    // switching the type away from Stay retires it with the picker.
    if (!stay) clearStayRating();
    const hint = $('#mealHint');
    // Both venue-searching types get the same one fact, and it is the fact a
    // traveller cannot discover by typing: the dropdown only appears from the
    // third character, so nothing on screen announces it.
    hint.hidden = !(food || t === 'activity');
    if (!hint.hidden) {
      hint.textContent = food
        ? 'Type the venue name to look up the real place - just the name, like "Saba".'
        : 'Type the venue or attraction name to look up the real place.';
    }
  }

  // What CHANGING the type on a blank form can answer that opening it could
  // not. Fills empty fields only, and only while adding: an edit's own values
  // are the answer, and a value the traveller typed is never touched.
  //
  // Why it is not inside setModalType: openItemModal calls that BEFORE it
  // writes the date fields, so a default applied there would be overwritten by
  // the very open that asked for it. This runs from the type picker instead,
  // which is the only place a type changes under a form already on screen.
  function applyTypeDefaults() {
    if (sharedMode || ui.editingId) return;
    const trip = activeTrip();
    if (modalType === 'stay') {
      // Choosing Stay used to mean picking two dates out of a calendar the app
      // could already read: the first uncovered night is where a stay belongs.
      //
      // The two branches answer different questions, and using the first one
      // for both was a real bug: `stayDatesFrom` jumps to where the next hole
      // STARTS, which is only right while the form has no date at all. Against
      // a check-in already on screen it wrote a check-out belonging to a
      // different hole - on a trip covered the 5th-8th and 10th-12th, opening
      // on the 6th produced a four-night stay straddling both bookings. A date
      // in hand is the anchor, and only its own run length is still in
      // question.
      const start = $('#inStart'), end = $('#inEnd');
      if (appOwns('start', start)) {
        // The date on screen is the app's own opening guess, so Stay may
        // improve on it: stayDatesFrom knows the first night that actually
        // needs a bed, which on a red-eye is the night you LAND, not the one
        // you left. Without this the commonest sequence in the app - log the
        // flight, then book the hotel - booked the night spent on the plane.
        const from = start.value || newItemDate(trip, { today: todayIso() });
        const dates = from ? stayDatesFrom(trip, from) : null;
        if (dates) {
          start.value = dates.startDate;
          autoFilled.add('start');
          if (appOwns('end', end)) { end.value = dates.endDate; autoFilled.add('end'); }
        }
      } else if (appOwns('end', end)) {
        // A check-in the traveller owns is the anchor and only its own run
        // length is still in question.
        end.value = stayCheckoutFor(trip, start.value);
        autoFilled.add('end');
      }
    }
    syncDerivedCity();
    prefillFlightOrigin();
  }

  // The city the form should be showing for the day and type it is on now.
  // ONE implementation, called from both places a day or a type can change
  // under an open form, so the two can never drift: a flight and a
  // between-cities transport keep their route in the title and take no city,
  // and everything else inherits the day's own.
  function syncDerivedCity() {
    if (sharedMode || ui.editingId) return;
    const loc = $('#inLocation');
    if (!appOwns('location', loc)) return;
    const auto = newItemDefaults(activeTrip(), {
      today: todayIso(), focusDate: $('#inStart').value, type: storageTypeOf(modalType), resolveIata: iataCity,
    });
    // An empty answer CLEARS an app-written city rather than leaving yesterday's
    // on a day that cannot justify it; a city a human put there is never touched.
    if (auto.location !== loc.value) loc.value = auto.location;
    if (auto.location) autoFilled.add('location'); else autoFilled.delete('location');
  }

  // The airport a new flight leaves from is wherever the itinerary has already
  // flown to (see flightOriginCode). Only the FROM field is filled: with one
  // airport known no title is composed, so nothing is written on the
  // traveller's behalf until they pick the destination themselves.
  function prefillFlightOrigin() {
    if (sharedMode || ui.editingId || modalType !== 'flight') return;
    const input = $('#inFlightFrom');
    if (input.value.trim() || flightPick.from) return;
    const code = flightOriginCode(activeTrip().items, $('#inStart').value || '');
    if (!code) return;
    loadAirports().then(list => {
      // the form may have been closed, switched or filled while the table loaded
      if (ui.editingId || modalType !== 'flight' || input.value.trim() || flightPick.from) return;
      const row = (list || []).find(r => r.iata === code);
      if (!row) return;
      flightPick.from = row;
      input.value = airportLabel(row);
    });
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
      type: storageTypeOf(modalType),
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
    // Food & Drink stores the kind in its own field and NOTHING in the title:
    // the title the traveller typed is the venue's name and is saved verbatim.
    // Switching away from Food & Drink drops the field, so an item that stops
    // being a meal stops claiming to be one.
    if (modalType === 'food') it.meal = isMealKind(modalMeal) ? modalMeal : 'other';
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
        const label = MODAL_TYPE_META[modalType] ? MODAL_TYPE_META[modalType].label.toLowerCase() : 'item';
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
    // A venue picked from the title dropdown knows exactly where it is, so the
    // coordinate goes into the same 30-day store the ratings call and the Photon
    // top-up fill, under the key the SAVED item will ask for. Computing that key
    // from `it` through itemMapsQuery - the same function every read path uses -
    // is what makes agreement structural rather than a convention two call
    // sites have to remember. A retyped title no longer matches `wrote`, so the
    // coordinates are dropped rather than stamped onto a different place.
    if (venuePick && it.title === venuePick.wrote) {
      const vq = itemMapsQuery(it);
      if (vq) {
        rememberVenuePoint(placeCacheKey(vq), { lat: venuePick.lat, lon: venuePick.lon });
        saveVenueCache();
      }
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
    // same re-entry guard submitItemForm documents: a doubled submit here
    // would shift the same dates twice, i.e. by 2xN days
    if (!$('#shiftOverlay').classList.contains('open')) return;
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
    // the trip the DIALOG is about (pinned at open), not whatever is active:
    // a remote merge can swap the active trip under an open dialog
    const t = ui.tripModalMode === 'new' ? null : (db.trips.find(x => x.id === ui.tripEditId) || null);
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
    // Who-is-this-for assignments and hand-entered splits pay the same price:
    // the leaving name comes off each item (their share moves to whoever is
    // left), and a split that named them no longer adds up, so it reverts to
    // the even divide. Counted here so the money consequences are ALL stated
    // before the save, not discovered in the totals afterwards.
    let whoCount = 0, splitCount = 0;
    for (const it of t.items) {
      if (!Array.isArray(it.travelers) || !it.travelers.length) continue;
      let leaves = false;
      for (const raw of it.travelers) {
        const who = String(raw == null ? '' : raw).trim();
        if (!who || keep.has(who.toLowerCase())) continue;
        leaves = true;
        if (!dropped.has(who.toLowerCase())) dropped.set(who.toLowerCase(), { name: who, count: 0 });
      }
      if (!leaves) continue;
      whoCount++;
      if (it.splitAmounts) splitCount++;
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
    if (whoCount) what.push(`reassigns ${whoCount} item${whoCount === 1 ? '' : 's'} that named ${leaving} to whoever is left`);
    if (splitCount) what.push(`drops the hand-entered split on ${splitCount === 1 ? 'one' : splitCount} of them (back to an even divide)`);
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
    // The trip this dialog is ABOUT, pinned at open. A remote sync merge can
    // replace db under an open dialog (deliberately, without closing it) and
    // ensureTrip may then re-point activeTripId at a different trip; resolving
    // activeTrip() again at submit time renamed and re-rostered THAT trip.
    // Same guard the item form has (see submitItemForm's editingId check).
    ui.tripEditId = existing ? t.id : null;
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
    // pinned dialog trip, same reason syncTravelerWarning reads it
    const t = db.trips.find(x => x.id === ui.tripEditId) || null;
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
    // The dialog writes to the trip it was OPENED on, never to whatever is
    // active at submit time: a remote merge may have swapped the active trip
    // underneath it (see openTripModal). Gone entirely means another device
    // deleted it, and the edit is dropped out loud rather than landing on a
    // bystander trip.
    const editTrip = ui.tripModalMode === 'new' ? null : db.trips.find(x => x.id === ui.tripEditId);
    if (ui.tripModalMode !== 'new' && !editTrip) {
      toastError('That trip is no longer here, so nothing was saved');
      closeAllOverlays();
      return;
    }
    // A template's new start date is checked BEFORE anything is written, for the
    // same reason "Shift entire trip" checks its own: a half-applied move leaves
    // a trip whose dates are wrong in a way nothing on screen explains.
    let plan = null;
    if (ui.tripModalMode === 'template' && !$('#fTripStart').hidden && $('#inTripStart').value) {
      const to = $('#inTripStart').value;
      plan = startDateShift(editTrip.items, to);
      if (!plan || !isDateInRange(to)) { tripStartError(`Use a date between ${DATE_MIN} and ${DATE_MAX}.`); return; }
      if (!shiftFits(editTrip.items, plan.days)) {
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
      setActiveTrip(t.id);
      // A brand-new trip has nothing to show on the map or the day grid, so
      // land on Timeline (and its empty state) instead of an empty map. The
      // render below repaints the view and syncViewHash clears the fragment.
      ui.view = 'timeline';
    } else {
      const t = editTrip;
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
      // An item's who-is-this-for assignment and its hand-entered split pay
      // the same price under the same rule. The read paths already coped (a
      // stale name is dropped at read time and a short split falls back to the
      // even divide), but the stale names themselves rode into every export
      // and share link, and nothing on screen said the cost had silently
      // become one person's. Cleaning at the edit, like paidBy above, keeps
      // the stored data saying what the totals actually compute.
      for (const it of t.items) {
        if (!Array.isArray(it.travelers) || !it.travelers.length) continue;
        const next = [];
        for (const raw of it.travelers) {
          const c = travelers.find(n => n.toLowerCase() === String(raw == null ? '' : raw).trim().toLowerCase());
          if (c && !next.includes(c)) next.push(c);
        }
        const lost = next.length !== it.travelers.length;
        if (it.splitAmounts) {
          // a split is an agreement among exactly the people it names: anyone
          // leaving means the amounts no longer sum for those left, so it is
          // dropped (back to the even divide) rather than redistributed
          if (lost || next.length < 2) delete it.splitAmounts;
          else {
            const respelled = {};
            for (const [name, v] of Object.entries(it.splitAmounts)) {
              const c = next.find(n => n.toLowerCase() === String(name).trim().toLowerCase());
              if (c) respelled[c] = v;
            }
            if (Object.keys(respelled).length === next.length) it.splitAmounts = respelled;
            else delete it.splitAmounts;
          }
        }
        // nobody left, or everybody: both read as Everyone and store nothing,
        // exactly as the item form does - except a surviving split keeps its
        // roster named explicitly, because its amounts are keyed by name
        if (!next.length || (next.length === travelers.length && !it.splitAmounts)) delete it.travelers;
        else it.travelers = next;
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
    setActiveTrip(copy.id);
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
    setActiveTrip(copy.id);
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
  const SHARED_MENU_ACTS = ['export-trip', 'export-csv', 'export-ics', 'export-gpx', 'share-trip', 'timefmt', 'distunit', 'tempunit'];
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
    // Readiness is now about the TRIP, not about where the traveller has been
    // in the app: two places that can be looked up is the floor, and the export
    // looks them up itself. It used to read the geocode cache, which only the
    // Map view filled, so whether an export worked depended on navigation
    // history and the row had to say "open the Map view once".
    const ready = mapStops(activeTrip()).length >= 2;
    if (ready) btn.removeAttribute('aria-disabled');
    else btn.setAttribute('aria-disabled', 'true');
    btn.title = ready ? '' : 'Needs at least two items with a Place (Tokyo, Kyoto, ...)';
  }

  function openTripMenu() {
    popoverReturnFocus = null; // the search panel is being replaced, not dismissed
    closeTripSearch();
    syncTripMenuShared();
    syncGpxMenuRow();
    $('#tripMenu').classList.add('open');
    // Same defect as the dialogs, same fix, one floor down: on a phone the
    // panel is tall enough to scroll (see the max-width:560px rule) and it is
    // toggled rather than rebuilt, so it used to reopen wherever it was left.
    // It is a popover rather than a modal, which is why it needs its own call
    // instead of inheriting openOverlay's.
    resetScrollWithin($('#tripMenu'));
    // the search button already reports its state; this popover is the same
    // kind of control and a screen reader deserves the same open/closed answer
    $('#tripMenuBtn').setAttribute('aria-expanded', 'true');
    popoverReturnFocus = $('#tripMenuBtn');
  }
  function closeTripMenu() {
    $('#tripMenu').classList.remove('open');
    $('#tripMenuBtn').setAttribute('aria-expanded', 'false');
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
    if (db.activeTripId !== tripId) { setActiveTrip(tripId); save(); }
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
  // Cache-only: what can be written RIGHT NOW without touching the network.
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

  // The export RESOLVES what it needs instead of hoping another view filled the
  // cache first. Nominatim is one request a second under a policy that forbids
  // bulk, which is why nothing does this speculatively - but a menu click is a
  // deliberate request for exactly these coordinates, so asking for them here
  // is the honest place to spend that budget. Everything already cached costs
  // nothing (geocode() answers from geoCache synchronously), so the second
  // export of a trip is instant.
  let gpxBusy = false;
  async function exportGpx() {
    if (gpxBusy) return;
    const t = activeTrip();
    const stops = mapStops(t);
    if (stops.length < 2) { toast('Needs at least two items with a Place'); return; }
    const missing = stops.filter(s => !geoCache[s.key]).length;
    gpxBusy = true;
    if (missing) toast(`Locating ${missing} place${missing === 1 ? '' : 's'} for the route...`);
    try {
      for (const s of stops) {
        if (!geoCache[s.key]) await geocode(s.name);
        // A trip switch mid-run makes the file we were building the wrong file.
        if (activeTrip().id !== t.id) return;
      }
      const ready = gpxStops(t);
      if (ready.length < 2) {
        toast(`Could not locate enough places for a route (${ready.length} of ${stops.length}). Try more specific place names.`);
        return;
      }
      download(`${slug(t.name)}-route.gpx`, buildGpx(ready), 'application/gpx+xml');
    } finally {
      gpxBusy = false;
      syncGpxMenuRow();
    }
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
          setActiveTrip(nt.id);
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
      startTime: CLOCK_RE.test(raw.startTime || '') ? raw.startTime : '',
      endTime: CLOCK_RE.test(raw.endTime || '') ? raw.endTime : '',
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
    // the food & drink kind round-trips (export, share link), validated by the
    // same normalizer repair uses: junk drops, a legacy prefixed title migrates
    if (isMealKind(raw.meal)) out.meal = raw.meal;
    normalizeMealItem(out);
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
    // Both reject on a payload that is not valid deflate - a truncated or
    // hand-edited share link - which is the SAME failure the read below throws
    // and decodeShare already catches and turns into a toast. Unhandled they
    // ALSO surfaced as uncaught promise rejections in the console, which reads
    // as a crash on a path the app handles cleanly. Still not awaited: awaiting
    // a write before anything reads the other end can park on a full queue.
    writer.write(bytes).catch(() => {});
    writer.close().catch(() => {});
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
    // entire trip, including confirmation numbers typed into Details. Fired
    // from the confirm's action below, so backing out is not a share.
    // WHAT IS IN THE LINK, BEFORE IT IS IN THE CLIPBOARD. This used to copy
    // first and explain afterwards, so a traveller who clicked "Share
    // itinerary" to find out what it did already had their confirmation
    // numbers on the clipboard by the time they were told. Nothing leaves the
    // device either way - the trip rides in the URL fragment, which browsers
    // never send to a server - but "anyone with this link can read it" is a
    // decision, and a decision needs to come before the action.
    const notes = [
      'The link carries this trip\'s items, including anything you wrote in Details such as confirmation numbers.',
      'Anyone with the link can read them.',
    ];
    if (url.length > 8000) {
      notes.push('It is also a LONG link: if a chat app truncates it, send the Export trip (JSON) file instead.');
    }
    confirmDialog('Copy a share link?', notes.join(' '), 'Copy link', async () => {
      track('trackAction', 'trip_shared', {
        item_count: Array.isArray(t.items) ? t.items.length : 0,
      });
      try {
        await navigator.clipboard.writeText(url);
        toast('Share link copied');
      } catch {
        window.prompt('Copy this share link:', url);
      }
    });
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
    // WHERE "my data" COMES FROM AT THIS MOMENT is the whole of this. The db
    // this page had in hand when the link opened is not authoritative any more:
    // another tab of this browser, or this device's own sync applying a remote
    // merge, may have written since, and shared mode deliberately ignored both.
    // Adopting that stale copy and saving it published it over everything they
    // did, with nothing to undo from in the tab that did it. So the visitor's
    // db is re-read from storage here, normalized, and the import is one
    // ordinary save on top of whatever is actually there.
    db = loadDb();
    sharedMode = false;
    repairDb(true); // normalize in memory; the save below writes the result
    // Reading the db afresh is the same event as a remote merge landing: the
    // state this page could describe is gone, so the history that described it
    // goes with it rather than being able to push a stale db back.
    undoPast.length = 0;
    undoFuture.length = 0;
    markSaved();
    ensureTrip();
    db.trips.push(nt);
    setActiveTrip(nt.id);
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
  // key -> job for everything queued or in flight, so two concurrent callers
  // for the same place (the Map walking stops while the visa dialog resolves
  // the same names) share ONE fetch instead of burning two 1.1s queue slots
  // on an identical query.
  const geoPending = new Map();
  let geoBusy = false;

  function geocode(place) {
    return new Promise(resolve => {
      const key = String(place || '').trim().toLowerCase();
      if (!key) return resolve({ ok: false, reason: 'empty' });
      if (geoCache[key]) return resolve({ ok: true, ...geoCache[key] });
      if (geoMisses.has(key)) return resolve({ ok: false, reason: 'notfound' });
      const pending = geoPending.get(key);
      if (pending) { pending.resolves.push(resolve); return; }
      const job = { place: place.trim(), key, resolves: [resolve] };
      geoPending.set(key, job);
      geoQueue.push(job);
      pumpGeo();
    });
  }
  function pumpGeo() {
    if (geoBusy || !geoQueue.length) return;
    geoBusy = true;
    const job = geoQueue.shift();
    const settle = answer => {
      geoPending.delete(job.key);
      for (const r of job.resolves) r(answer);
    };
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
          // Bounded like the venue cache (which has a TTL and a 300 cap):
          // this one grew forever, every route-dialog experiment included, on
          // the same localStorage budget save() runs out of. Entries carry no
          // timestamp, so eviction is oldest-INSERTED first (string-keyed
          // object order), which is close enough for a network cache.
          const geoKeys = Object.keys(geoCache);
          for (const old of geoKeys.slice(0, Math.max(0, geoKeys.length - 500))) delete geoCache[old];
          try { localStorage.setItem(GEO_KEY, JSON.stringify(geoCache)); } catch { /* cache is best-effort */ }
          settle({ ok: true, ...hit });
        } else {
          geoMisses.add(job.key);
          settle({ ok: false, reason: 'notfound' });
        }
      })
      .catch(() => settle({ ok: false, reason: 'network' }))
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
      if (placesQueue.isPending(key)) continue;
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
    const query = anchor ? d.anchorQ : d.distQ;
    const city = anchor ? d.anchorCity : d.distCity;
    const p = placePoint({ query, name: anchor ? d.anchorName : d.distName, city });
    // `query` is what a DIRECTIONS link can be built from, which the coordinates
    // cannot be: Maps wants a place, not a lat/lon the traveller never typed.
    return p ? { ...p, label, query: query || city || '' } : null;
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
    // A leg row renders its directions link destination-only, because the
    // Timeline has no chain to ask. In Days view there IS one, so the link can
    // say where the leg starts and open in the mode the distance implies rather
    // than the safe transit default.
    const dir = row.querySelector('.tp-dir-link');
    if (dir && leg) {
      // a PLACE row's hop is judged like any city hop (walk under WALKABLE_KM,
      // transit above); the item-type modes are for travel legs, whose own
      // type says how they move
      const type = dir.dataset.dirType || '';
      const mode = type === 'place' ? legTravelMode('local', leg.km) : legTravelMode(type, leg.km);
      const href = directionsUrl(leg.fromQuery || '', dir.dataset.dirDest || '', mode);
      if (href && dir.getAttribute('href') !== href) dir.setAttribute('href', href);
    }
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

  // THE day's route chain, read off one day card: the anchor (where the day
  // starts, arrival airport included), the rows in schedule order, their
  // resolved points, and the legs dayDistanceChain builds between them. Every
  // Days-view route surface reads THIS - the per-row chips, each row's
  // Directions link, the day totals, the external Google Maps route and the
  // Day route map - so none of them can disagree about what the day contains.
  function dayCardChain(cardEl, wanted) {
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
    return { anchor, rows, stops, legs: dayDistanceChain(anchor, stops) };
  }

  function paintDayDistances(wanted) {
    document.querySelectorAll('#daysList .day-card').forEach(cardEl => {
      const chain = dayCardChain(cardEl, wanted);
      const legs = new Map(chain.legs.map(l => [l.id, l]));
      chain.rows.forEach((row, i) => writeDistChip(row, legs.get(i)));
      paintDayRoute(cardEl, chain);
    });
  }

  // The compact day-route strip at the bottom of a day card: what today's
  // travel adds up to (summed from the SAME legs the chips just printed, by
  // the same walk/ride judgement), the internal Day route map, and the
  // external Google Maps route. Painted only when the chain has at least one
  // real leg; a day whose stops did not resolve keeps a clean card instead of
  // an empty strip.
  function paintDayRoute(cardEl, chain) {
    const old = cardEl.querySelector('.dc-route');
    const legs = chain.legs;
    if (!legs.length) { if (old) old.remove(); return; }
    const totals = dayTravelTotals(legs);
    // a stop that wanted a place but resolved nowhere keeps the total honest:
    // the strip says the figure is partial rather than pretending completeness
    const unplaced = chain.stops.filter(s => s.lat === undefined && chain.rows[s.id]
      && (chain.rows[s.id].dataset.distQ || chain.rows[s.id].dataset.distCity)).length;
    const parts = [];
    if (totals.byMode.walk > 0) parts.push(`🚶 ${fmtDist(totals.byMode.walk)}`);
    if (totals.byMode.ride > 0) parts.push(`🚕 ${fmtDist(totals.byMode.ride)}`);
    const tot = parts.join(' · ') + (unplaced ? ` <span class="dc-route-part">· ${unplaced} not located</span>` : '');
    // the external route walks the chain itself: consecutive by construction,
    // chunked so a very busy day never silently drops a stop
    const queries = [legs[0].fromQuery, ...legs.map(l => l.toQuery)];
    const mode = dayRouteMode(legs);
    const chunks = routeUrlChunks(queries);
    const gmLinks = chunks.map((c, i) => {
      const href = directionsRouteUrl(c[0], c.slice(1, -1), c[c.length - 1], mode);
      if (!href) return '';
      const label = chunks.length > 1 ? `Open in Google Maps (part ${i + 1} of ${chunks.length})` : 'Open day route in Google Maps';
      return `<a class="tp-maps-link dc-route-gm" href="${esc(href)}" target="_blank" rel="noopener"
        title="One Google Maps route in ${mode === 'walking' ? 'walking' : 'driving'} mode. Legs that differ (walk vs taxi or transit) are shown per stop above and in Day route.">
        <span class="tpm-label">${esc(label)}</span></a>`;
    }).join('');
    const html = `<span class="dc-route-tot" title="Straight-line distances, summed over today's ${totals.legCount} leg${totals.legCount === 1 ? '' : 's'}. Today's travel.">${tot}</span>
      <span class="dc-route-acts">
        <button type="button" class="row-btn dc-route-btn" data-act="day-route" data-date="${cardEl.dataset.date}"
          title="Show today's stops in order on a map" aria-label="Show the ${esc(fmtDate(cardEl.dataset.date))} route on a map">🗺 Day route</button>
        ${gmLinks}
      </span>`;
    if (old && old.innerHTML === html) return;
    const box = old || document.createElement('div');
    box.className = 'dc-route';
    box.innerHTML = html;
    if (!old) cardEl.appendChild(box);
  }

  // One spec (from dayAnchor or proposalOrigin) -> a point, against the caches
  // only. An 'arrival' spec is a travel LEG, not a place: the airports table
  // (or its city fallback) locates it, never the venue/name rungs. The
  // hotel-picker rung is offered to a STAY alone, exactly as itemDistAttrs
  // does it: that rung looks the TITLE up in the geocode cache, which is a
  // doorstep for a hotel the traveller picked and a coincidence for an
  // activity that happens to be named after a city.
  function resolveOriginPoint(spec) {
    if (!spec) return null;
    const p = (spec.iata && airportPointByIata(spec.iata))
      || (spec.item && spec.source !== 'arrival'
        ? placePoint({
          query: itemMapsQuery(spec.item),
          name: isStay(spec.item) ? displayTitle(spec.item) : '',
          city: spec.city,
        })
        : cityPoint(spec.city));
    if (!p) return null;
    // an arrival names its airport/station as the place to route FROM; anything
    // else names its own venue, falling back to its city
    const query = spec.source === 'arrival'
      ? (spec.label || spec.city || '')
      : (itemMapsQuery(spec.item || {}) || spec.city || '');
    return { ...p, label: spec.label, query };
  }

  // Everything an origin needs before it can answer: its own venue coordinates
  // (the hotel is a venue like any other, and asking for it is what turns a
  // "both ends fell back to the same city centroid" non-answer into a real
  // number), and the airports table when it is an arrival the bundled file can
  // pin. paintDayDistances does both for the Days grid; the assistant used to
  // do neither, which is why an arrival-day suggestion silently had no chip.
  function primeOrigin(spec, wanted) {
    if (!spec) return;
    if (spec.iata && !airportRows && !airportKickoff) {
      airportKickoff = true;
      loadAirports().then(() => { if (airportRows) refreshDistances(); });
    }
    if (spec.item && spec.source !== 'arrival') wantVenue(wanted, itemMapsQuery(spec.item));
  }

  // Where a given suggestion is measured from. Cached per (date, time) because
  // one reply routinely carries three candidates for the same slot and a whole
  // day's worth of slots.
  function originPointFor(specCache, date, time, wanted) {
    const key = date + '|' + time;
    if (specCache.has(key)) return specCache.get(key);
    const trip = activeTrip();
    const spec = trip ? proposalOrigin(trip.items, date, time, geoResolved) : null;
    primeOrigin(spec, wanted);
    const point = resolveOriginPoint(spec);
    specCache.set(key, point);
    return point;
  }

  // Scoped to the assistant's own log on purpose: the booking-import dialog
  // renders the SAME proposal cards, and a flight read off a confirmation
  // measured from an itinerary hotel would be a number about nothing. Its cards
  // carry the (empty, hidden) slot and no chip.
  //
  // Two passes, because a card's origin can be another card: first resolve
  // every chip's own point, then ask suggestionOrigins which of them (or which
  // itinerary item) each one starts from, then write the chips. That is what
  // makes "Return to hotel" at 21:30 read as the leg home from the 20:00 bar
  // instead of a zero-length hop from the hotel it ends at.
  function paintAssistDistances(wanted) {
    const specCache = new Map();
    const chips = [...document.querySelectorAll('#assistMessages .ap-dist')];
    // A SLOT, not a chip, is the unit the chaining works in: three dinner
    // candidates are one decision about one place to be, so they all measure
    // from the same origin, and whatever comes after them measures from the one
    // the traveller PICKED (its first option until they pick another) rather
    // than from whichever candidate happened to be rendered last. That is the
    // same rule routeStops applies to the route line, so the two never disagree.
    const slots = [];
    const byCard = new Map();
    for (const [i, el] of chips.entries()) {
      wantVenue(wanted, el.dataset.distQ);
      const card = el.closest('.assist-proposal');
      const point = readPoint(el, 'dist');
      if (!byCard.has(card)) {
        byCard.set(card, slots.length);
        slots.push({
          id: slots.length, card, chips: [],
          date: (card && card.dataset.date) || '',
          time: el.dataset.distTime || '',
        });
      }
      slots[byCard.get(card)].chips.push({ el, point: point ? { ...point, id: i } : null });
    }
    for (const slot of slots) {
      const picked = slot.card ? selectedOptionIndex(slot.card) : 0;
      const at = picked < slot.chips.length ? picked : 0;
      slot.point = slot.chips[at].point;
    }
    const origins = suggestionOrigins(slots, (date, time) => originPointFor(specCache, date, time, wanted));
    for (const slot of slots) {
      const origin = origins.get(slot.id);
      let km = null;
      for (const chip of slot.chips) {
        // one leg through the same builder the day chain uses, so a suggestion
        // at its own origin's address is suppressed by the same rule
        const leg = chip.point ? dayDistanceChain(origin, [chip.point])[0] : null;
        if (!leg) {
          chip.el.textContent = ''; chip.el.removeAttribute('title');
          delete chip.el.dataset.km;
          continue;
        }
        chip.el.textContent = assistDistanceChipLabel(leg.km, leg.from);
        chip.el.title = assistDistanceChipTitle(leg.km, leg.from);
        // the raw figure rides on the chip so the badge pass can compare
        // candidates without re-deriving the chain
        chip.el.dataset.km = String(leg.km);
        if (km == null) km = leg.km;
      }
      // Now that the leg's start and its length are known, a directions link
      // can name both. Done here rather than at render time because the origin
      // is not knowable until the whole batch has been chained.
      upgradeDirLink(slot.card, origin, km);
      paintSetBadges(slot.card);
    }
    paintAssistRoutes(specCache, wanted);
  }

  // The pick-one badges: objective winners inside one alternative set, derived
  // from the two figures the card already shows (the chip's leg distance and
  // the resolved Google rating/review count) via TripLogic.candidateBadges.
  // Idempotent and callable from BOTH passes that can change its inputs - the
  // distance paint (chips re-measure when a venue resolves or a pick changes)
  // and paintPlaces (ratings land later, in batches) - so the badges are always
  // as complete as the data on screen, and never more.
  function paintSetBadges(card) {
    if (!card || !card.classList.contains('assist-set')) return;
    const opts = [...card.querySelectorAll('.as-opt')];
    if (opts.length < 2) return;
    const kms = opts.map(o => {
      const el = o.querySelector('.ap-dist');
      const v = el && el.dataset.km;
      return v ? Number(v) : null;
    });
    const ratings = opts.map(o => {
      const slot = o.querySelector('.ap-rating');
      const entry = slot && placesCache.get(slot.dataset.placeKey || '');
      return entry && entry.status === 'ok'
        ? { rating: entry.rating, count: entry.userRatingCount || 0 } : null;
    });
    // A candidate whose verified hours refuse its own start time (closed) or
    // leave too little of the visit (closingSoon) is out of every badge
    // contention (candidateBadges' closed rule): the same card cannot read
    // "Closed at 11:00 PM" - or "only 20 min remaining" - and "Highest rated"
    // at once. The verdict is read off the painted hours slot, which the same
    // paintPlaces pass fills BEFORE the sets are re-judged, and which persists
    // across the distance pass's own repaints. Unknown hours are unverified,
    // not closed, so they still compete.
    const closed = opts.map(o => {
      const h = o.querySelector('.ap-hours');
      const verdict = h ? h.dataset.verdict : '';
      return verdict === 'closed' || verdict === 'closingSoon';
    });
    const badges = candidateBadges({ kms, ratings, closed });
    opts.forEach((o, i) => {
      o.querySelectorAll('.as-badge').forEach(el => el.remove());
      const title = o.querySelector('.as-title');
      if (!title) return;
      for (const b of badges[i] || []) {
        const span = document.createElement('span');
        span.className = 'as-badge as-badge-' + b.id;
        span.textContent = `${b.icon} ${b.label}`;
        span.title = b.title;
        title.appendChild(span);
      }
    });
  }

  // A leg card's directions link is rendered destination-only (see
  // proposalPlaceHtml) because neither the start nor the distance is known
  // until the batch has been chained. Once they are, the link says where the
  // leg starts and opens in the mode the chip just named, so a card cannot
  // suggest a 20-minute walk and then hand over driving directions.
  function upgradeDirLink(card, origin, km) {
    const link = card && card.querySelector('.assist-dir-link');
    if (!link) return;
    const href = directionsUrl(
      (origin && origin.query) || '',
      link.dataset.dirDest || '',
      legTravelMode(link.dataset.dirType || '', km),
    );
    if (href && link.getAttribute('href') !== href) link.setAttribute('href', href);
  }

  // Which option of an alternative set is in play. Nothing picked yet stands at
  // the first, which is the order the candidates are already rendered in; a
  // plain single card is its own only option.
  function selectedOptionIndex(card) {
    if (!card.classList.contains('assist-set')) return 0;
    const opts = [...card.querySelectorAll('.as-opt')];
    return Math.max(0, opts.findIndex(el => el.querySelector('input[type="radio"]:checked')));
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

  // The walk starts where the DAY starts, not where an individual card starts:
  // a route line is the order to visit a day's suggestions in, so its anchor is
  // that day's own origin with no time. One reply can plan several days, and
  // each group is now anchored to its own day rather than all of them to the
  // first day's hotel.
  function paintAssistRoutes(specCache, wanted) {
    document.querySelectorAll('#assistMessages .assist-proposals').forEach(box => {
      box.querySelectorAll('.ap-order').forEach(el => el.remove());
      box.querySelectorAll('.assist-route').forEach(el => el.remove());
      const byDate = new Map();
      box.querySelectorAll('.assist-proposal[data-op="add"]').forEach(card => {
        // A route is the order to visit a day's PLACES in. A travel leg is not
        // one of them: "Return to hotel" at 21:30 is where the evening ends by
        // definition, and letting the optimiser reorder it produced a numbered
        // "1" on the ride home and a route that walked home first. Only an
        // activity (a sight, a meal, a bar) is a stop.
        if ((card.dataset.type || '') !== 'activity') return;
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
          selected: selectedOptionIndex(card),
        });
      });
      for (const [date, group] of byDate) {
        const stops = routeStops(group.map((e, i) => ({ id: i, options: e.options, selected: e.selected })));
        if (stops.length < 2) continue;
        const anchor = originPointFor(specCache, date, '', wanted);
        if (!anchor) continue;
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
  // with neither, it just ranks worse. Shared by the hotel and the venue
  // picker, which are the same lookup against the same provider with different
  // class lists.
  function pickerCityBias() {
    const city = ($('#inLocation').value || '').trim();
    const hit = city ? geoCache[city.toLowerCase()] : null;
    // Not cached yet: answer unbiased for THIS lookup and start the one request
    // that makes the next one better. See warmPickerCity.
    if (city && !hit) warmPickerCity(city);
    return {
      city,
      lat: hit && Number.isFinite(hit.lat) ? hit.lat : null,
      lon: hit && Number.isFinite(hit.lon) ? hit.lon : null,
    };
  }

  // Whether a lookup could be biased, and by what. Part of both suggestion
  // cache keys so a cold unbiased answer is never reused once coordinates land.
  const biasKey = bias => (Number.isFinite(bias.lat) && Number.isFinite(bias.lon))
    ? `${bias.lat.toFixed(2)},${bias.lon.toFixed(2)}` : '';

  // Put the Place field's city into the geocode cache so pickerCityBias has
  // something to bias WITH. The bias code was always there; the coordinates
  // were not, because until the Map view ran nothing had ever looked the city
  // up. So a Rome trip - with "Rome" sitting in Place because the app put it
  // there - searched "Hotel Art" against the whole planet and ranked Sarajevo
  // and Santander above the Rome hotel.
  //
  // Skipped for anything already cached, already missed, or too short to be a
  // place, so the common case costs no request at all. Deliberately fire and
  // forget: the picker is perfectly usable unbiased, this only makes it better,
  // and the next keystroke's lookup picks the coordinates up once they land.
  let warmCityTimer = null;
  function warmPickerCity(city) {
    const key = String(city || '').trim().toLowerCase();
    if (key.length < 3 || geoCache[key] || geoMisses.has(key)) return;
    clearTimeout(warmCityTimer);
    warmCityTimer = setTimeout(() => { geocode(key); }, 300);
  }

  function fetchHotelSuggestions(q, bias) {
    // Keyed on the city too: the same three letters mean different hotels once
    // the traveller fills the Place field in, and a cache that ignored it
    // would serve the pre-city answer for the rest of the session.
    // ...and on whether the request could actually CARRY that city. The city
    // reaches the geocode cache asynchronously (warmPickerCity), so the first
    // keystrokes go out unbiased; without the coordinates in the key, that cold
    // answer was cached under the same key and served for the rest of the
    // session, so the bias never took effect no matter how warm the cache got.
    const key = `${q.toLowerCase()}|${(bias.city || '').toLowerCase()}|${biasKey(bias)}`;
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
    // A pick is a human choice, so the city it fills belongs to the traveller
    // and no later date change may revise it.
    if (appOwns('location', loc) && row.locality) { loc.value = row.locality; autoFilled.delete('location'); }
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

  // ---------- activity picker source (Photon again, general POIs) ----------
  // See the block over rankVenueResults in trip-logic.js for what this can and
  // cannot answer (a venue you can NAME, not a category you want to browse).
  // Exclusions only on the wire: an include filter hard-filters and would
  // answer an empty list for a real place whose class we forgot, so the class
  // list that decides what may be shown lives in rankVenueResults.
  const VENUE_EXCLUDE_Q = VENUE_EXCLUDE_KEYS.map(k => 'osm_tag=' + encodeURIComponent('!' + k)).join('&');
  // Asked for more than the eight rows shown, because the class list drops rows
  // AFTER the response: "Central Park" answers a zoo and a carousel worth
  // showing alongside six dentists and schools worth dropping.
  const VENUE_FETCH_LIMIT = 15;
  const venueSuggestCache = new Map();
  let venueSuggestAbort = null;

  function fetchVenueSuggestions(q, bias) {
    // Keyed on the city for the hotel picker's reason: the same four letters
    // mean a different place once the Place field is filled in.
    // ...and on whether the request could actually CARRY that city. The city
    // reaches the geocode cache asynchronously (warmPickerCity), so the first
    // keystrokes go out unbiased; without the coordinates in the key, that cold
    // answer was cached under the same key and served for the rest of the
    // session, so the bias never took effect no matter how warm the cache got.
    const key = `${q.toLowerCase()}|${(bias.city || '').toLowerCase()}|${biasKey(bias)}`;
    if (venueSuggestCache.has(key)) return Promise.resolve(venueSuggestCache.get(key));
    if (venueSuggestAbort) venueSuggestAbort.abort();
    venueSuggestAbort = new AbortController();
    const ctrl = venueSuggestAbort;
    const timeout = setTimeout(() => ctrl.abort(), 7000);
    // lat/lon only, for the reasons the hotel picker documents: Photon's
    // location_bias_scale and zoom made the bias worse and a bbox empties the
    // list. The city bonus in rankVenueResults is what actually decides.
    const at = (Number.isFinite(bias.lat) && Number.isFinite(bias.lon)) ? `&lat=${bias.lat}&lon=${bias.lon}` : '';
    return fetch(`${HOTEL_API}?q=${encodeURIComponent(q)}&limit=${VENUE_FETCH_LIMIT}&lang=en&${VENUE_EXCLUDE_Q}${at}`, { signal: ctrl.signal })
      .then(r => { if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
      .then(json => {
        const rows = rankVenueResults(q, json, bias.city, CB_LIMIT);
        if (venueSuggestCache.size > 120) venueSuggestCache.clear();
        venueSuggestCache.set(key, rows);
        return rows;
      })
      // Same posture as the other two pickers: offline or throttled is not an
      // error worth shouting about. The field is still a plain text input and
      // typing the name of a place still works.
      .catch(() => [])
      .finally(() => clearTimeout(timeout));
  }

  // A picked venue, held until the item is saved. The COORDINATES are the prize
  // (see submitItemForm): a hand-added activity used to sit on its city's
  // centroid until a Photon or Places lookup found it, and now the row the
  // traveller chose says exactly where it is, for free and immediately.
  // `wrote` is the same guard flightPick uses: retype the title and the
  // coordinates stop applying rather than being stamped onto another place.
  let venuePick = null;

  function rememberPickedVenue(row) {
    if (!row || !Number.isFinite(row.lat)) { venuePick = null; return; }
    venuePick = { name: row.value, lat: row.lat, lon: row.lon, wrote: row.value };
    // Filling an EMPTY Place field is a convenience; overwriting a filled one
    // would fight a traveller who deliberately wrote "Gion, Kyoto".
    const loc = $('#inLocation');
    // Same rule as the venue pick: a chosen hotel's town is the traveller's.
    if (appOwns('location', loc) && row.locality) { loc.value = row.locality; autoFilled.delete('location'); }
    $('#fTitle').classList.remove('invalid');
    // Deliberately NO rating lookup here, unlike the hotel pick: a rating is a
    // billed Google call, activities outnumber stays several to one, and the
    // row will get its rating from the itinerary's own on-screen queue anyway.
    // This feature adds zero billable requests.
  }

  // ONE combobox on #inTitle, because two would bind two sets of listeners to
  // one input and open two popups. Which list it offers is decided per search
  // (the type switches under an open form), and the row carries `src` so a pick
  // landing after a type switch is still handled by the code that fetched it.
  function attachTitlePicker(input) {
    return createCombobox(input, {
      minChars: 3,          // "ho" matches half the lodging in the world
      debounce: 320,        // a shared, unpaid, fair-use endpoint: do not type at it
      // Food & Drink searches venues exactly as Activity does, and now the
      // query IS the venue name: the classification moved to its own control,
      // so nothing has to strip an application prefix off the string before it
      // reaches the provider (typing "Dinner: Saba" used to re-query on every
      // keystroke of the prefix and rank against a string no venue is named).
      enabled: () => modalType === 'stay' || modalType === 'activity' || modalType === 'food',
      rows: q => (modalType === 'stay'
        ? fetchHotelSuggestions(q, pickerCityBias()).then(rows => rows.map(r => ({ ...r, src: 'hotel' })))
        : fetchVenueSuggestions(q, pickerCityBias()).then(rows => rows.map(r => ({ ...r, src: 'venue' })))),
      render: row => ({ primary: row.value, secondary: row.detail || '', tag: row.kindLabel }),
      value: row => row.value,
      onPick: row => (row.src === 'hotel' ? rememberPickedHotel(row) : rememberPickedVenue(row)),
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

  // `autoCheck` is false only for a PREFILLED pair the traveller did not ask
  // about yet (see openRouteFromTrip): clicking a specific leg is a question, so
  // that path still answers it immediately, but a dialog merely opening must
  // never spend a geocode and a route lookup on a guess about what was wanted.
  function openRouteModal(from, to, date, { autoCheck = true } = {}) {
    routeDate = date || '';
    lastRouteKey = '';
    // Places already used in this trip are no longer pushed into a datalist
    // here: the combobox on both fields offers them itself (tripPlaceRows),
    // ranked above the geocoder's suggestions.
    $('#routeFrom').value = from || '';
    $('#routeTo').value = to || '';
    setRouteResult(ROUTE_BLANK);
    updateRouteLinks();
    syncRouteCheckBtn();
    openOverlay('#routeOverlay');
    if (from && to && autoCheck) checkRoute();
    // With both ends already filled the next action is checking them, so focus
    // lands on the button that does it rather than on a field needing no edit.
    else if (from && to) $('#routeCheckBtn').focus();
    else $('#routeFrom').focus();
  }

  // The toolbar's Route button used to open two empty fields on a trip that
  // already knew which two cities had no leg between them. It now opens on that
  // pair (routeSuggestion: the first city change with nothing logged for it,
  // else the first city change at all) with the lookup still un-run.
  function openRouteFromTrip() {
    const s = routeSuggestion(activeTrip());
    if (!s) return openRouteModal('', '');
    return openRouteModal(s.from, s.to, s.date, { autoCheck: false });
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
    // A resort island by NAME, or two countries with no land route between
    // them by COUNTRY CODE. Either way the ground modes come off and the
    // ferry goes on, because there is no road to offer.
    const island = ISLANDISH.test(from) || ISLANDISH.test(to) || seaCrossing(a.cc, b.cc);
    const intl = !!(a.cc && b.cc && a.cc !== b.cc);
    updateRouteLinks({ fromCc: a.cc, toCc: b.cc, island, km });
    const pills = [
      `<span class="rp">📏 ${fmtDist(km)}</span>`,
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

  // One look for a route on ANY map in this app: the trip map and the day
  // route draw the same numbered pin and the same dashed line, so a stop
  // reads the same wherever it appears.
  const ROUTE_LINE_OPTS = { color: '#4f8cff', weight: 3, opacity: 0.8, dashArray: '6 8' };
  const stopPinIcon = n => L.divIcon({ className: '', html: `<div class="stop-pin">${n}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] });

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
  // Which trip the canvas currently belongs to, so a switch can drop it before
  // the new trip's geocoding starts rather than after it finishes.
  let mapTripId = null;
  // City context, not street context: the ceiling any bounds fit may zoom to.
  // A stop here is a CITY (mapStops groups by place name), so there is nothing
  // to see past this even when the bounds would allow it.
  const MAP_FIT_MAX_ZOOM = 12;
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
    // A DIFFERENT TRIP means everything on the canvas is now false. Geocoding a
    // cold set of cities takes about a second per stop, and the teardown used to
    // wait until that finished, so switching trips left the previous trip's
    // tiles, pins and zoom on screen for the whole run: the header said "Peru"
    // while the map showed a street in Paris with Paris's pin on it. The stale
    // map goes NOW, and the loading state below is what the traveller sees
    // until the new one is ready.
    if (mapTripId && mapTripId !== trip.id && mapInstance) {
      mapInstance.remove();
      mapInstance = null;
    }
    mapTripId = trip.id;
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
      const icon = stopPinIcon(i + 1);
      const rule = '<hr style="border:none;border-top:1px solid var(--border-soft);margin:6px 0">';
      const lines = stop.items.slice(0, 5).map(it => {
        const range = isStay(it) && isIsoDate(it.endDate) ? fmtRange(it.startDate, it.endDate) : fmtDate(it.startDate);
        return `${rowLook(it).icon} ${esc(it.title)}<br><small style="color:var(--text-dim)">${range}</small>`;
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
      L.polyline(latlngs, ROUTE_LINE_OPTS).addTo(mapInstance);
    }
    // ONE stop makes degenerate bounds, and Leaflet answers those with its
    // maximum zoom: a trip whose only stop was "Paris" opened on a random
    // residential street with no landmark in sight, which reads as a broken
    // map rather than a one-stop trip. Capping the fit gives that stop its
    // city instead. Multi-stop fitting is untouched (MAP_FIT_MAX_ZOOM is far
    // looser than any bounds spanning two cities would ask for).
    mapInstance.fitBounds(L.latLngBounds(latlngs), { padding: [46, 46], maxZoom: MAP_FIT_MAX_ZOOM });
    status.textContent = `${located.length} stop${located.length === 1 ? '' : 's'} on the route` +
      (failed.length ? ` · could not locate: ${failed.join(', ')} (use a more specific place name)` : '') + '.';
  }

  // ---------- one day's route on a map ----------
  // The zoomed-in sibling of the trip map: same Leaflet, same pins, same
  // dashed line, scoped to ONE day's chain. No geocoding happens here - the
  // points come from the exact caches the day card's chips were painted from,
  // so the map can never show a different route than the card describes.
  let dayRouteMapInstance = null;

  // The ordered pins: the day's anchor first, then every resolved stop in
  // schedule order. A stop at the same spot as the pin before it (the same
  // dedupe rule the leg chain applies) would stack two markers on one point,
  // so it is folded into the previous pin rather than drawn on top of it.
  function dayRoutePoints(chain) {
    const pts = [];
    const anchor = chain.anchor;
    if (anchor && anchor.lat !== undefined) pts.push({ lat: anchor.lat, lon: anchor.lon, key: anchor.key, label: anchor.label, leg: null });
    const legById = new Map(chain.legs.map(l => [l.id, l]));
    for (const s of chain.stops) {
      if (s.lat === undefined) continue;
      const prev = pts[pts.length - 1];
      if (prev && sameSpot(prev, s)) continue;
      pts.push({ lat: s.lat, lon: s.lon, key: s.key, label: s.label, leg: legById.get(s.id) || null });
    }
    return pts;
  }

  async function openDayRoute(date) {
    const cardEl = document.querySelector(`#daysList .day-card[data-date="${date}"]`);
    if (!cardEl) return;
    const chain = dayCardChain(cardEl, []);
    const pts = dayRoutePoints(chain);
    if (pts.length < 2) return; // the button only paints on a card with legs
    $('#dayRouteTitle').textContent = `Day route · ${fmtDate(date)}`;
    $('#dayRouteStops').innerHTML = pts.map((p, i) => `<li>
      <span class="drs-n" aria-hidden="true">${i + 1}</span>
      <span class="drs-body"><span class="drs-label">${esc(p.label || '(unnamed)')}</span>
      ${p.leg ? `<span class="drs-leg">${esc(assistDistanceChipLabel(p.leg.km, ''))}</span>` : ''}</span>
    </li>`).join('');
    const note = $('#dayRouteNote');
    note.hidden = true;
    openOverlay('#dayRouteOverlay');
    if (dayRouteMapInstance) { dayRouteMapInstance.remove(); dayRouteMapInstance = null; }
    const ok = navigator.onLine && await ensureLeaflet();
    // the overlay may have been closed while Leaflet loaded
    if (!$('#dayRouteOverlay').classList.contains('open')) return;
    if (!ok) {
      note.textContent = navigator.onLine
        ? 'The map could not load. The stop order below still stands.'
        : 'The map needs an internet connection. The stop order below still stands.';
      note.hidden = false;
      return;
    }
    dayRouteMapInstance = L.map('dayRouteCanvas', { scrollWheelZoom: true });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(dayRouteMapInstance);
    const latlngs = [];
    pts.forEach((p, i) => {
      const ll = [p.lat, p.lon];
      latlngs.push(ll);
      L.marker(ll, { icon: stopPinIcon(i + 1) }).addTo(dayRouteMapInstance)
        .bindPopup(`<b>${i + 1}. ${esc(p.label || '')}</b>${p.leg ? `<br><small>${esc(assistDistanceChipLabel(p.leg.km, p.leg.from))}</small>` : ''}`);
    });
    if (latlngs.length > 1) L.polyline(latlngs, ROUTE_LINE_OPTS).addTo(dayRouteMapInstance);
    dayRouteMapInstance.fitBounds(L.latLngBounds(latlngs), { padding: [30, 30] });
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
    } catch (err) {
      // An EXPIRED cache still beats no answer when the refresh fails: a
      // traveller offline mid-trip with a 31-day-old dataset used to be told
      // "network hiccup" while month-old rules sat on the device. The dialog
      // already prints the dataset's own publication date and staleness
      // (visaVintageNote), so serving old data stays honest; only a device
      // that has never downloaded the dataset at all still fails here.
      try {
        const stale = JSON.parse(localStorage.getItem(VISA_KEY) || 'null');
        if (stale && stale.csv) {
          visaMatrix = parseVisaMatrix(stale.csv);
          if (visaMatrix) return visaMatrix;
        }
      } catch { /* nothing usable cached */ }
      throw err;
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
      const remove = d.manual ? `<button type="button" class="visa-remove" data-remove-cc="${esc(d.cc)}" title="Remove ${esc(d.name)}" aria-label="Remove ${esc(d.name)}">✕</button>` : '';
      const remind = (info.cls === 'evisa' || info.cls === 'required')
        ? `<button type="button" class="row-btn visa-remind" data-remind-cc="${esc(d.cc)}" data-remind-name="${esc(d.name)}">➕ Add reminder</button>`
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
  // 'site' (the free one-click assistant) is what a first-time traveller lands
  // on. It used to be 'copy', which meant clicking the robot opened a form that
  // asked them to copy a prompt, open ChatGPT in another tab, paste, copy the
  // reply and paste it back - five manual steps, with the working one-click tab
  // sitting unlabelled right beside it. An explicit choice still wins and is
  // still remembered (the localStorage read above), and a shared assistant at
  // capacity still explains itself and points at Copy & paste rather than
  // silently switching mode mid-request (see the 429 branch in sendToSite).
  let assistTier = localStorage.getItem(ASSIST_TIER_KEY) || 'site';
  if (!['copy', 'byok', 'site'].includes(assistTier)) assistTier = 'site';
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
    // Free assistant leads: it is the zero-setup path, so it reads first.
    // Order is presentation only - every handler keys off the radio VALUE, and
    // the default tier is set explicitly where assistTier is initialised, never
    // derived from position here.
    const segs = ['site', 'copy', 'byok'].map(t => {
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

  // Drops chat threads whose trip no longer exists anywhere: not in the db,
  // and not held for undo in deletedChats. Runs after a remote merge lands
  // (see the localStorageSync listener), because that is the one delete path
  // that never goes through this device's own delete flow.
  function pruneOrphanChats() {
    const prefix = 'trip-planner:chat:';
    const live = new Set(db.trips.map(t => t.id));
    const doomed = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(prefix)) continue;
      const id = k.slice(prefix.length);
      if (!live.has(id) && !deletedChats.has(id)) doomed.push(k);
    }
    for (const k of doomed) { try { localStorage.removeItem(k); } catch { /* best effort */ } }
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
    const history = loadChat(tripId);
    history.push({ role: 'assistant', content: cleanedText || reply });
    saveChat(tripId, history);
    // The reply belongs to the trip that asked. Nothing disables the trip
    // picker while a request is in flight (only the composer locks), so the
    // traveller can be looking at ANOTHER trip by the time this lands - and
    // the bubble then appeared in that trip's freshly cleared thread, with
    // proposal cards whose Accept validated against activeTrip() and inserted
    // trip A's items into trip B. The history write above is keyed by tripId,
    // so the reply is waiting in its own trip's thread; the live panel is only
    // touched while it is still showing that trip.
    const current = activeTrip();
    if (!current || current.id !== tripId) return;
    if (cleanedText) appendBubble('assistant', cleanedText);
    if (actions.length) {
      const container = document.createElement('div');
      container.className = 'assist-proposals';
      $('#assistMessages').appendChild(container);
      renderProposals(actions, container);
    }
    if (!cleanedText && !actions.length) appendBubble('assistant', 'No reply came back. Try rephrasing your request.');
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

  // The composer is FREE-FORM by definition: whatever the traveller typed,
  // under the chat contract. It must never inherit the guided picker's fixed
  // option counts, which is exactly what happened while both paths shared one
  // system prompt - a plain "give me 5 options" came back as "my instructions
  // require exactly 3".
  function sendChat() {
    const input = $('#assistInput');
    const text = (input.value || '').trim();
    if (!text || assistSending) return;
    input.value = '';
    autoGrowInput();
    sendMessage(text, 'chat');
  }

  // The origin the MODEL is told about, so its prose and the cards it triggers
  // cannot disagree about where the day starts. The same function the chips
  // use, asked about the focus day with no particular hour, flattened to plain
  // strings because this travels over the wire to Tier 3 and into the
  // copy/paste package.
  function assistOriginContext() {
    const trip = activeTrip();
    if (!trip || !isIsoDate(assistFocusDate)) return null;
    // dayBaseOrigin, not proposalOrigin: the model needs ONE place to reason
    // about the whole day from, and on the arrival day that is the hotel rather
    // than the airport the day technically opens at.
    const spec = dayBaseOrigin(trip.items, assistFocusDate, geoResolved);
    if (!spec || !spec.label) return null;
    return { date: assistFocusDate, label: String(spec.label), city: String(spec.city || ''), source: String(spec.source || '') };
  }

  // `mode` is per TURN, never per conversation: the picker's contract applies
  // to the turn the picker sent and to nothing after it, so a follow-up typed
  // into the composer is answered as free-form even mid-thread.
  async function sendMessage(text, mode) {
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
        ? await callSiteAssistant(history, trip, mode)
        : await callByokProvider(history, trip, mode);
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
  async function callByokProvider(history, trip, mode) {
    const provider = assistProvider();
    const model = assistModel();
    const key = loadKey(provider);
    if (!key) throw assistError('Add your ' + PROVIDER_META[provider].label + ' API key first.');
    const sys = buildAssistSystemPrompt({
      trip, focusDate: assistFocusDate, today: todayIso(), mode, origin: assistOriginContext(),
    });

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
  async function callSiteAssistant(history, trip, mode) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60000);
    let res;
    try {
      res = await fetch('/.netlify/functions/tp-assist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tripContext: {
            trip: slimTripForShare(trip), focusDate: assistFocusDate || null, today: todayIso(),
            mode: mode || 'chat', origin: assistOriginContext(),
          },
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
      // "Tier 1/2/3" is internal shorthand; the traveller only ever sees the
      // segmented labels (Copy & paste / My API key / Free assistant), so the
      // fallback advice has to use those words.
      if (res.status === 503 || body.error === 'not_configured') throw assistError("The site's free assistant isn't set up yet. Use Copy & paste, or add your own API key.");
      if (res.status === 429 || body.error === 'quota_exceeded') throw assistError('The shared assistant is at capacity today. Use Copy & paste, or add your own API key.');
      // The server trims long descriptions to make a heavy trip fit; this is
      // the case where even the dates and titles alone are too big to send. It
      // has to say what happened, because "could not answer right now" would
      // send the traveller into retrying something that can never succeed.
      if (res.status === 413 || body.error === 'trip_too_large') throw assistError('This trip is too big to send to the shared assistant. Shorten some item descriptions, or split it into two trips. Copy & paste has no size limit.');
      throw assistError('The shared assistant could not answer right now. Try again, or use Copy & paste.');
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
  // "First stop at" is an ARRIVAL time: when the first planned place should
  // begin, with the travel to it before (buildPlanRequest words the contract).
  // The quick picks are conveniences; the pl-time input beside them takes any
  // time, so 08:45 is one tap away rather than impossible.
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
          ${planTimeRow('First stop at', 'wake', WAKE_PICKS, p.wakeTime)}
          ${planTimeRow('Back by', 'return', RETURN_PICKS, p.returnTime)}
          ${timesOk ? '' : '<div class="pl-err" role="alert">The return time must be after the first stop</div>'}
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
    // The ONE path that carries the guided contract: the picker composed this
    // request, so its bounded slot counts are what the traveller chose.
    if (assistTier === 'copy') { copyAssistPackage(text); return; }
    sendMessage(text, 'plan');
  }

  async function copyAssistPackage(request) {
    const trip = activeTrip();
    const pkg = buildAssistPackage({
      trip, focusDate: assistFocusDate, request, mode: 'plan', origin: assistOriginContext(),
    });
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
  // Owner tier: the site owner pastes a secret into localStorage once (see
  // the OWNER TIER note in netlify/functions/tp-places.mjs) and this browser
  // gets the higher owner quota server-side. Everyone else has no token and
  // sends no field; there is no UI for this on purpose.
  const PLACES_OWNER_TOKEN_KEY = 'trip-planner:places:ownerToken';
  function placesRequestBody(queries) {
    const body = { clientId: assistClientId(), queries };
    let token = '';
    try { token = localStorage.getItem(PLACES_OWNER_TOKEN_KEY) || ''; } catch { /* private mode */ }
    if (token) body.ownerToken = token;
    return body;
  }

  // The queue's one transport. Returns the SHAPE the queue reasons about
  // (served / switched off / retry later), never a Response: every decision
  // about what a status means is made here, once.
  async function sendPlacesBatch(queries) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    let res;
    try {
      res = await fetch('/.netlify/functions/tp-places', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(placesRequestBody(queries)),
        signal: ctrl.signal,
      });
    } catch {
      return { ok: false, transient: true };   // offline or timed out
    } finally {
      clearTimeout(timer);
    }
    if (res.ok) {
      let data;
      try { data = await res.json(); } catch { return { ok: false, transient: true }; }
      return { ok: true, results: (data && data.results) || [] };
    }
    // 503 not_configured is the default state: the owner has no Places key, so
    // the feature switches itself off for the session and costs nothing. 501
    // joins 405 because it means the same thing from a server with no functions
    // at all (python -m http.server answers POST with 501).
    if (res.status === 503 || res.status === 403 || res.status === 400 || res.status === 405 || res.status === 501) {
      return { ok: false, off: true };
    }
    // A 429 is OUR limiter, never Google's: an upstream rejection comes back
    // 200 with `unavailable` results (see tp-places.mjs), so the scope here
    // always names one of our own buckets and says exactly when it refills.
    let scope = '', retryAfterMs = null;
    try {
      const body = await res.json();
      if (body && typeof body.scope === 'string') scope = body.scope;
      if (body && typeof body.resetAt === 'number') retryAfterMs = body.resetAt - Date.now();
    } catch { /* an error body is a courtesy, not a contract */ }
    const hdr = Number(res.headers.get('Retry-After'));
    if (retryAfterMs == null && Number.isFinite(hdr) && hdr >= 0) retryAfterMs = hdr * 1000;
    return { ok: false, status: res.status, scope, retryAfterMs };
  }

  // One quiet word per session, and only when the wait is long enough that the
  // traveller would otherwise wonder why half the rows never got a rating. A
  // short contention backoff resolves itself in seconds and says nothing; a
  // per-row error badge on forty rows is exactly the noise this avoids.
  let placesNoticeShown = false;
  const PLACES_NOTICE_MIN_MS = 5 * 60000;
  function placesQuotaNotice() {
    if (placesNoticeShown) return;
    const st = placesQueue.status();
    if (st.off || !st.pausedUntil) return;
    if (st.pausedUntil - Date.now() < PLACES_NOTICE_MIN_MS) return;
    placesNoticeShown = true;
    toast('Google ratings are paused for now - the free lookup allowance is used up. Everything else works as usual.');
  }

  const placesQueue = createPlacesQueue({
    send: sendPlacesBatch,
    onUpdate(results) {
      paintPlaces(document);
      // The same response carries the place's coordinates (see the field-mask
      // note in tp-places.mjs). They cost nothing extra and they are the top
      // rung of the distance ladder, so a venue this call resolves is never
      // looked up a second time anywhere else.
      const located = placesLocationUpdates(results);
      if (located.length) {
        for (const u of located) rememberVenuePoint(u.key, u);
        saveVenueCache();
        scheduleDistanceRepaint();
      }
      placesQuotaNotice();
    },
  });

  // Everything that used to read the raw Map still reads exactly one cache;
  // the queue owns it now so nothing can resolve a venue behind its back.
  const placesCache = { get: k => placesQueue.get(k), has: k => placesQueue.has(k) };

  // Generations are trip ids, counted rather than compared, so the queue only
  // ever has to answer "is this still the trip that asked?".
  let placesTripId = null, placesGen = 0;
  function placesGeneration(tripId) {
    const id = tripId || null;
    if (id === placesTripId) return placesGen;
    placesTripId = id;
    placesGen += 1;
    placesQueue.setGeneration(placesGen);
    return placesGen;
  }

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
    if (!entry) return;
    // A place the confidence gate REFUSED to match is a settled answer, and it
    // has to say so. Leaving the slot blank meant a "pick one" set where some
    // options wore ★4.8 and others wore nothing, which reads as a verdict on
    // the place rather than on the lookup - and it lands hardest on exactly the
    // landmarks whose official name differs from the English one people type
    // (Basilica di Santa Maria Maggiore, Palazzo Barberini). The gate stays
    // exactly as strict; only its silence is fixed.
    //
    // 'unavailable' is deliberately NOT handled here: it is transient (quota,
    // upstream hiccup), it is never cached, and a later batch may still answer.
    if (entry.status === 'no_match') {
      el.dataset.painted = '1';
      el.innerHTML = `<span class="apr-none" title="No place matched this name closely enough to attach a rating with confidence. The Google Maps link beside it still searches for it.">No rating match</span>`;
      return;
    }
    if (entry.status !== 'ok') return;
    el.dataset.painted = '1';
    // Marks a slot holding a REAL rating chip, which is the one case where the
    // separate "Verify on Google Maps" link is redundant (the chip is that
    // link). A "no rating match" slot must never hide it.
    el.classList.add('has-rating');
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

  // Opening hours for the scheduled date, painted from the same session cache
  // the ratings live in. Three visual states and one deliberate silence:
  //   (nothing)   - hours unknown. The place resolved without hours, the lookup
  //                 has not landed, the quota is out, or the app is offline.
  //                 Unknown NEVER paints as open; the absence of the line IS
  //                 the unverified state, and nothing else may claim otherwise.
  //   Hours ...   - verified hours for that calendar day (via the dated
  //                 special periods when Google supplied them for that date,
  //                 else the weekly pattern), through fmtTime so the 12/24-hour
  //                 preference applies.
  //   Closes at X - open at the scheduled time but within HOURS_CLOSING_SOON_MIN
  //                 of closing: legal, tight, worth a warning.
  //   Closed ...  - the scheduled time falls at/after close or outside every
  //                 interval (a start AT closing time is closed; see
  //                 hoursVerdict). On an assistant card this also demotes the
  //                 candidate (never a normal recommendation, never a badge
  //                 winner) and acceptProposal refuses to apply it unchanged.
  // "Unknown" here means UNVERIFIED - the lookup could not vouch either way -
  // and the one honest rendering of unverified is nothing at all.
  const hhmmMin = t => (+String(t).slice(0, 2)) * 60 + (+String(t).slice(3, 5));
  const minToHHMM = m => `${String(Math.floor((m % 1440) / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  function paintHoursSlot(el) {
    if (el.dataset.painted === '1') return;
    const entry = placesCache.get(el.dataset.placeKey || '');
    if (!entry) return;
    const date = el.dataset.hoursDate || '';
    const day = hoursIntervalsForDate(entry.hours, date);
    if (!day.known) {
      // A settled lookup with no hours stays settled (and silent) for the
      // session; an 'unavailable' entry never lands in the cache, so a later
      // batch may still fill this slot in.
      el.dataset.painted = '1';
      return;
    }
    el.dataset.painted = '1';
    const line = hoursLineText(day, fmtTime);
    const time = /^\d{2}:\d{2}$/.test(el.dataset.hoursTime || '') ? el.dataset.hoursTime : '';
    // The minimum recommendation window rides only on ASSISTANT slots (see
    // hoursSlotHtml): with it the verdict can come back 'closingSoon'.
    // Days-view slots carry none, so a traveller's own rows can never be
    // demoted by it - their only closes-soon state is the advisory below.
    const win = Number(el.dataset.hoursWindow) || 0;
    const v = time ? hoursVerdict(entry.hours, date, time, win) : null;
    const when = `${fmtDow(date)}, ${fmtDate(date)}`;
    let text = `Hours · ${line === 'Closed' ? 'Closed that day' : line}`;
    let title = `Opening hours on Google Maps for ${when}: ${line}.`;
    if (v && v.status === 'closed') {
      el.classList.add('is-closed');
      text = day.intervals.length ? `Closed at ${fmtTime(time)} · Hours: ${line}` : 'Closed that day';
      title += ` The scheduled time, ${fmtTime(time)}, falls outside them (a start at closing time counts as closed).`;
    } else if (v && v.status === 'closingSoon') {
      // Technically open, too little of the visit left to recommend: visibly
      // distinct from closed (amber), and it says how much remains and why
      // that is short.
      el.classList.add('is-closing');
      const left = v.closesMin - hhmmMin(time);
      text = `Closes at ${fmtTime(minToHHMM(v.closesMin))} · only ${left} min remaining`;
      title += ` Open at the scheduled time, but only ${left} minutes remain before closing - under the ${win} minutes this kind of stop needs to be worth recommending.`;
    } else if (v && v.status === 'open' && v.closesMin != null && v.closesMin - hhmmMin(time) <= HOURS_CLOSING_SOON_MIN) {
      el.classList.add('is-closing');
      text = `Closes at ${fmtTime(minToHHMM(v.closesMin))}`;
      title += ` The venue closes within an hour of the scheduled time.`;
    }
    el.dataset.verdict = v ? v.status : 'none';
    el.title = title;
    el.textContent = text;
    // The demotion: a candidate whose verified hours refuse its own start time
    // (closed) or leave too little of the visit (closingSoon) is not a normal
    // recommendation any more, and the verdict stamped here is also what takes
    // it out of every winner-badge contention (paintSetBadges reads it). The
    // radio stays clickable for transparency - the traveller can still read,
    // compare and pick it - but acceptProposal REFUSES to apply either state
    // unchanged and hands off to the item form instead, raced paints included.
    // The two states demote in different colours, so "shut" and "too tight"
    // never read as the same claim.
    const demote = !v ? '' : (v.status === 'closed' ? 'is-closed' : (v.status === 'closingSoon' ? 'is-closing' : ''));
    if (demote) {
      const opt = el.closest('.as-opt');
      if (opt) opt.classList.add(demote);
      else {
        const card = el.closest('.assist-proposal');
        if (card && !card.classList.contains('assist-set')) {
          card.classList.add(demote === 'is-closed' ? 'is-closed-time' : 'is-closing-time');
        }
      }
    }
  }

  function paintPlaces(root) {
    const scope = root && root.querySelectorAll ? root : document;
    scope.querySelectorAll('.ap-rating[data-place-key]').forEach(paintRatingSlot);
    scope.querySelectorAll('.assist-maps-link[data-place-key]').forEach(paintMapsLink);
    scope.querySelectorAll('.tp-maps-link[data-place-key]').forEach(paintTripMapsLink);
    scope.querySelectorAll('.tp-hours[data-place-key]').forEach(paintHoursSlot);
    // ratings feed the rated/popular badges, so a batch landing re-judges the
    // pick-one sets it just informed
    scope.querySelectorAll('.assist-set').forEach(paintSetBadges);
  }

  // WHAT GETS ASKED FOR, AND WHEN. A rating costs the owner $0.02 whether or
  // not anyone reads it, and Google's terms forbid keeping one, so a rating
  // fetched for the fortieth day of a trip whose first screen is still on
  // screen is money spent on nothing. Demand is therefore split in two:
  //
  //   ASSISTANT CANDIDATES (.ap-rating) are asked for immediately. They are a
  //   comparison the traveller explicitly requested, they arrive together in an
  //   open panel, and the pick-one badges (candidateBadges) are a judgement
  //   ACROSS the set - half a set is a worse answer than none.
  //
  //   ITINERARY ROWS (.tp-maps-link) are asked for when they come near the
  //   viewport. A 50-place trip then opens with the handful of ratings its
  //   first screen can show instead of 50 requests the quota cannot serve, and
  //   the rest arrive as the traveller scrolls to them. rootMargin does the
  //   looking-ahead so a row is normally rated before it is read.
  //
  // Deliberately NOT done: a background sweep of the rest of the trip. That is
  // precisely the pattern that produced the 429s, and it buys nothing the
  // traveller can see.
  const PLACES_LOOKAHEAD = '600px 0px';
  let placesObserver = null;
  if (typeof IntersectionObserver === 'function') {
    placesObserver = new IntersectionObserver((entries, obs) => {
      const queries = [];
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        obs.unobserve(e.target);
        const q = e.target.dataset.placeQuery || '';
        if (q) queries.push(q);
      }
      if (queries.length) placesQueue.request(queries, { priority: 'normal' });
    }, { rootMargin: PLACES_LOOKAHEAD });
  }

  // A slot that the session cache can already answer needs neither an observer
  // nor a request; paintPlaces has just filled it.
  function observeRatingSlot(el) {
    if (placesQueue.has(el.dataset.placeKey || '')) return;
    if (placesObserver) placesObserver.observe(el);
    // No IntersectionObserver (very old browser): fall back to asking for
    // everything the render produced, which is what the app did before.
    else placesQueue.request([el.dataset.placeQuery || ''], { priority: 'normal' });
  }

  // Called once per render. Paints whatever the session already knows (a
  // re-render, a view switch or a repeat venue costs nothing at all), then
  // registers demand for what is genuinely missing.
  function hydrateRatings(container) {
    paintPlaces(container);
    const eager = [...container.querySelectorAll('.ap-rating[data-place-key]')]
      .map(el => el.dataset.placeQuery || '')
      .filter(Boolean);
    // Urgent, and PROMOTED if a row already queued the same venue: a candidate
    // set the traveller is reading must not wait behind a screen of itinerary
    // rows, because its winner badges are a judgement across the whole set.
    if (eager.length) {
      placesQueue.promote(eager);
      placesQueue.request(eager, { priority: 'urgent' });
    }
    container.querySelectorAll('.tp-maps-link[data-place-key]').forEach(observeRatingSlot);
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
  // The start time rides along because the origin is a question about the HOUR
  // ("where am I at 21:30"), not just about the day.
  function proposalDistAttrs(p, trip) {
    const f = p.fields;
    if (!f) return '';
    const query = itemMapsQuery({ type: f.type, title: f.title, location: f.location, mapsQuery: p.display.mapsQuery });
    const city = String(f.location || '').trim();
    if (!query && !city) return '';
    const time = /^\d{2}:\d{2}$/.test(String(f.startTime || '')) ? f.startTime : '';
    // A travel leg's destination can be a place the trip ALREADY knows: the
    // "Return to hotel" action names the booked hotel on purpose (see
    // ASSIST_MAPSQUERY), and that hotel's own coordinates may sit in the
    // geocode cache under its NAME (the hotel-picker rung) without any venue
    // lookup ever resolving the name as a query. Without this rung the return
    // card was the one suggestion with no distance: its origin (the last
    // venue) resolved through the Places response, while its destination
    // waited on a Photon lookup that can be slow, down, or simply unable to
    // find a small hotel. Offering the stay's title as the name rung is the
    // exact offer itemDistAttrs makes for the stay's own row, gated the same
    // way: only when the destination IS that stay.
    const stayName = isTravelLeg({ type: f.type }) ? legDestStayName(query, trip) : '';
    return distAttrs(query, stayName, city, f.title || '') + ` data-dist-time="${esc(time)}"`;
  }
  // The stay this leg ends at, by its searchable name: a match on the stay's
  // own maps query or its display title (case-folded) is the trip saying
  // "that destination is my hotel".
  function legDestStayName(query, trip) {
    if (!query || !trip) return '';
    const q = query.toLowerCase();
    for (const it of trip.items) {
      if (!isStay(it) || it.status === 'cancelled') continue;
      const title = displayTitle(it);
      if (q === title.toLowerCase() || q === itemMapsQuery(it).toLowerCase()) return title;
    }
    return '';
  }
  const proposalDistHtml = (p, trip) => `<span class="ap-dist"${proposalDistAttrs(p, trip)}></span>`;

  // What a proposal's Maps action should BE, which depends on what the proposal
  // is. A place is somewhere you might choose: it gets the star rating and a
  // link to the listing. A leg is how you get somewhere: it gets directions,
  // and no rating, because "Return to hotel · 4.8 (958)" reads as a venue
  // recommendation for a ride the traveller is not choosing between.
  //
  // The href starts destination-only; the distance pass fills the origin and
  // the travel mode in once it knows where the leg starts and how far it is
  // (see upgradeDirLink), the same way the ratings pass upgrades a search link
  // to a resolved place.
  function proposalPlaceHtml(p) {
    const d = p.display;
    const type = (p.fields || {}).type || '';
    if (!isTravelLeg({ type })) return ratingSlotHtml(d.mapsQuery) + assistMapsLinkHtml(d.mapsQuery);
    const dest = normalizePlaceQuery(d.mapsQuery || '');
    if (!dest) return '';
    const href = directionsUrl('', dest, legTravelMode(type, null));
    return `<a class="assist-maps-link assist-dir-link" data-dir-dest="${esc(dest)}" data-dir-type="${esc(type)}"`
      + ` href="${esc(href)}" target="_blank" rel="noopener">🧭 Directions on Google Maps</a>`;
  }

  // The proposal's opening-hours scaffold: place-type proposals only (a leg is
  // not a venue, same split as the rating), judged against the proposal's OWN
  // date and start time - the exact claim the card is making. It paints from
  // the same eager lookup the candidate ratings already trigger, so a reply
  // costs exactly what it cost before hours existed.
  function proposalHoursHtml(p) {
    const f = p.fields;
    if (!f || !isPlaceType({ type: f.type })) return '';
    const query = itemMapsQuery({ type: f.type, title: f.title, location: f.location, mapsQuery: p.display.mapsQuery });
    // The category's minimum recommendation window rides on the slot so the
    // paint pass can judge closingSoon; null (a stay) means closed-only.
    const win = recommendWindowMin({ type: f.type, title: f.title, mapsQuery: query });
    return hoursSlotHtml('ap-hours', query, p.display.startDate, p.display.startTime, win);
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
        ${proposalDistHtml(p, trip)}
        ${proposalPlaceHtml(p)}
        ${proposalHoursHtml(p)}
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
    // Every candidate of a set is an add for the same slot, so the first one's
    // type is the set's type (see the date, just below, for the same reason).
    card.dataset.type = (entry.candidates[0].fields || {}).type || '';
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
    // read by the route pass, which routes places and not travel legs
    card.dataset.type = (p.fields || {}).type || '';
    // the day this card would land on: the shortest-route footer is per day,
    // and one reply can cover several
    if (isIsoDate(d.startDate)) card.dataset.date = d.startDate;
    const meta = [isIsoDate(d.startDate) ? fmtDate(d.startDate) : '', d.startTime ? fmtTime(d.startTime) : ''].filter(Boolean).join(' · ');
    const costStr = proposalCostStr(d, trip);
    const acceptLabel = p.op === 'add' ? 'Add to trip' : (p.op === 'update' ? 'Apply change' : 'Remove from trip');
    const opWord = p.op === 'add' ? 'Add' : (p.op === 'update' ? 'Update' : 'Remove');
    // a destructive proposal takes the destructive button, not a green one
    const acceptCls = p.op === 'remove' ? 'btn danger' : 'btn primary';
    card.innerHTML = `
      <div class="ap-op">${opWord}</div>
      <div class="ap-title">${esc(d.title || '(no title)')}</div>
      ${meta ? `<div class="ap-meta">${esc(meta)}</div>` : ''}
      ${costStr ? `<div class="ap-cost">${esc(costStr)}</div>` : ''}
      ${proposalDistHtml(p, trip)}
      ${proposalPlaceHtml(p)}
      ${proposalHoursHtml(p)}
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
    // The assistant contract still says "Dinner: Narisawa" on the wire (it is
    // a prompt instruction to a model, and a stable one), so an accepted
    // proposal is converted at the boundary into the shape everything else
    // stores: meal:'dinner', title:'Narisawa'. Same normalizer the repair and
    // import paths use, so a card and a hand-added row cannot store differently.
    normalizeMealItem(item);
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
    // an update that rewrote the title or the type re-derives the kind from
    // what it just wrote; a `meal` left on an item that is no longer an
    // activity is dropped by the same call
    if (f.title !== undefined || f.type !== undefined) {
      if (f.title !== undefined) delete it.meal;
      normalizeMealItem(it);
    }
  }

  function markProposalStale(card) {
    card.classList.add('stale');
    card.innerHTML = '<div class="ap-reason">This item already changed, nothing applied.</div>';
  }
  // `chosenTitle` is set only for an accepted pick-one set: the done stub then
  // names what was picked and keeps a way BACK into the choice, because a
  // traveller planning a whole day routinely discovers three slots later that
  // another dinner candidate fits better. A plain single card keeps the old
  // one-line stub.
  function markProposalDone(card, op, chosenTitle) {
    card.classList.remove('invalid');
    card.classList.add('done');
    const word = op === 'add' ? 'Added to your trip' : (op === 'update' ? 'Updated' : 'Removed');
    const chosen = chosenTitle
      ? `<div class="ap-done-choice">${esc(chosenTitle)}</div>
         <div class="ap-actions"><button type="button" class="btn ap-change" data-act="change-choice">Change choice</button></div>`
      : '';
    card.innerHTML = `<div class="ap-done">✓ ${word}</div>${chosen}`;
  }

  // What "Change choice" needs to replace the earlier pick safely: which
  // itinerary item this set added (by id, never by title/date guessing), what
  // that item looked like when the assistant added it (so an item the
  // traveller has since edited is KEPT rather than destroyed), and how to put
  // the picker back on screen. Keyed by the card element in a WeakMap so a
  // cleared chat or a switched trip cannot leak entries.
  const assistChoice = new WeakMap();
  // The fields the accept wrote, in a stable order; id and createdAt are the
  // item's own identity, not the choice, so they stay out of the comparison.
  function assistItemFingerprint(it) {
    return JSON.stringify(['type', 'title', 'location', 'startDate', 'endDate', 'startTime', 'endTime',
      'status', 'details', 'mapsQuery', 'cost', 'costNote', 'estCost'].map(k => it[k] === undefined ? null : it[k]));
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

  // The deterministic write-path gate: would this proposal put a venue on the
  // plan at a time its VERIFIED hours refuse? Returns the facts for the
  // refusal dialog, or null when the answer is open or unknown. Unknown means
  // UNVERIFIED, never "open": it does not block (blocking would switch the
  // assistant off whenever the quota is out or the app is offline), but
  // nothing anywhere claims such a venue was checked. This runs at accept
  // time, not render time, so a verdict that landed AFTER the cards painted
  // still gates the write. The invariant it enforces: a venue with verified
  // hours is never accepted as a timed assistant recommendation when the
  // proposed time falls outside those hours - only manual traveller edits
  // through the item form can schedule against verified hours, and the Days
  // view then says so in red.
  function closedHoursFor(p, trip) {
    if (!p || (p.op !== 'add' && p.op !== 'update')) return null;
    let probe;
    if (p.op === 'add') {
      probe = { type: p.fields.type, title: p.fields.title, location: p.fields.location, mapsQuery: p.fields.mapsQuery };
    } else {
      const target = (trip.items || []).find(x => x.id === p.targetId);
      if (!target) return null;
      probe = { ...target, ...p.fields };
    }
    if (!isPlaceType(probe)) return null;
    const date = p.display.startDate, time = p.display.startTime;
    if (!isIsoDate(date) || !/^\d{2}:\d{2}$/.test(String(time || ''))) return null;
    const query = itemMapsQuery(probe);
    const entry = placesCache.get(placeCacheKey(query));
    const hours = entry && entry.hours;
    if (!hours) return null;
    // The same category window the card's slot was judged by: closingSoon is
    // a refusal-worthy state for a RECOMMENDATION exactly as closed is, and
    // the two are told apart in `kind` so the dialog can say which.
    const win = recommendWindowMin({ ...probe, mapsQuery: query }) || 0;
    const v = hoursVerdict(hours, date, time, win);
    if (v.status !== 'closed' && v.status !== 'closingSoon') return null;
    const day = hoursIntervalsForDate(hours, date);
    return {
      kind: v.status, date, time, closesMin: v.closesMin, windowMin: win,
      allDay: !day.always && !day.intervals.length, line: hoursLineText(day, fmtTime),
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
    // A proposal whose verified hours refuse the proposed time (closed), or
    // leave less of the visit than its category's minimum recommendation
    // window (closingSoon), is REFUSED, not confirmed through: there is no
    // "add anyway" for an assistant recommendation, because accepting it
    // unchanged is exactly the claim the verification exists to stop. The
    // card stays on screen, demoted, and the traveller's ways forward are
    // the honest ones - pick another candidate, ask the assistant for a
    // different time or venue, or take the hand-off below into the ITEM
    // FORM, where the time sits in front of them to change and whatever they
    // save is a manual traveller item (the form deliberately never gates on
    // hours, in either state: a person scheduling against a listing is a
    // deliberate act, and the Days view still flags it instead).
    const refused = closedHoursFor(p, trip);
    if (refused) {
      const title = p.display.title || 'this venue';
      let heading, sentence;
      if (refused.kind === 'closingSoon') {
        const left = refused.closesMin - hhmmMin(refused.time);
        heading = 'Too close to closing';
        sentence = `Google Maps lists "${title}" as closing at ${fmtTime(minToHHMM(refused.closesMin))} `
          + `on ${fmtDate(refused.date)} - only ${left} minutes after the proposed ${fmtTime(refused.time)} start, `
          + `under the ${refused.windowMin} minutes this kind of stop needs. The assistant cannot recommend it at this time.`;
      } else {
        heading = 'Closed at that time';
        const what = refused.allDay
          ? `closed all day on ${fmtDate(refused.date)}`
          : `closed at ${fmtTime(refused.time)} on ${fmtDate(refused.date)} (verified hours that day: ${refused.line})`;
        sentence = `Google Maps lists "${title}" as ${what}, so the assistant cannot add it at this time.`;
      }
      confirmDialog(
        heading,
        `${sentence} Pick another option, ask the assistant for a different time or venue, `
          + 'or edit the time and add it yourself.',
        'Edit time & add myself',
        () => {
          if (p.op === 'update') { openItemModal(p.targetId); return; }
          const f = p.fields;
          // The hand-off opens the form on the SAME thing the card described,
          // in the form's own vocabulary: a prefixed contract title becomes
          // the Food & Drink type with its subtype chosen and the bare venue
          // name in the field, so the traveller changes the time and nothing
          // else. splitMealTitle returns null for anything that is not one of
          // the four contract prefixes, which leaves an ordinary activity
          // exactly as it was.
          const split = f.type === 'activity' ? splitMealTitle(f.title) : null;
          openItemModal(null, {
            type: f.type, title: (split ? split.title : f.title) || '', meal: split ? split.meal : '',
            location: f.location || '',
            startDate: p.display.startDate || '', startTime: p.display.startTime || '',
            details: f.details || '',
          });
        });
      return;
    }
    let addedItem = null;
    if (p.op === 'add') {
      const added = proposalToItem(p, trip);
      // A re-pick after "Change choice" REPLACES the earlier pick from this
      // same set: the prior item is found by the id recorded at accept time
      // (never by title/date guessing) and removed in the SAME save as the new
      // add, so undo restores both together and the itinerary never holds two
      // dinners from one decision. Two safe outs: an item the traveller
      // deleted is simply gone (nothing to remove), and an item they EDITED
      // since (fingerprint mismatch) is kept, because destroying their changes
      // to honour a card would be worse than one extra row.
      const prior = assistChoice.get(card);
      let keptEdited = false;
      if (prior && prior.addedId) {
        const idx = trip.items.findIndex(x => x.id === prior.addedId);
        if (idx >= 0) {
          if (assistItemFingerprint(trip.items[idx]) === prior.fingerprint) trip.items.splice(idx, 1);
          else keptEdited = true;
        }
      }
      trip.items.push(added);
      addedItem = added;
      if (keptEdited) toast('You edited the earlier pick, so it was kept; the new choice was added alongside it.');
      // Nothing else to do for the distance chips: the accepted place is now an
      // ITINERARY item, so proposalOrigin finds it on the next repaint like any
      // other plan for that hour, on that day, at its own time. This used to be
      // a separate "last accepted point" the panel carried alongside the trip,
      // which was one more thing to keep in step with the day, the clock and
      // the focus - and the reason a pre-add figure could disagree with the
      // post-add one.
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
    // an accepted SET remembers its pick so "Change choice" can reopen it;
    // the restore closure is the same snapshot undo uses
    const isSet = card.classList.contains('assist-set');
    if (isSet && addedItem) {
      assistChoice.set(card, {
        addedId: addedItem.id,
        fingerprint: assistItemFingerprint(addedItem),
        title: p.display.title || '',
        restore: putCardBack,
      });
    }
    markProposalDone(card, p.op, isSet && addedItem ? (p.display.title || '') : '');
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

  // The trip this dialog was opened FOR, resolved by id every time rather than
  // read off whatever is active now. The db can be replaced underneath an open
  // dialog - another tab deleting that trip, this device's sync applying a
  // remote merge - and every write here used to go through `activeTrip()`:
  // after a delete that meant editing somebody else's list, and on a trip that
  // had never opened this dialog `packing` did not exist at all, so adding a
  // row threw mid-submit and saved nothing, with no toast and the dialog still
  // sitting there. Same contract the item and trip dialogs already follow
  // (ui.editingId / ui.tripEditId): the dialog stays open, and the WRITE
  // re-checks that its target is still there.
  function packingTrip() {
    return db.trips.find(t => t.id === ui.packingTripId) || null;
  }
  function packingTripForWrite() {
    const t = packingTrip();
    if (!t) {
      toastError('That trip is no longer here, so nothing was saved');
      closeOverlay($('#packingOverlay'));
      return null;
    }
    ensurePacking(t);
    return t;
  }

  function openPackingModal() {
    const trip = activeTrip();
    if (!trip) return;
    // the dialog is opened for THIS trip and keeps editing it, whatever
    // happens to db.activeTripId while it is open
    ui.packingTripId = trip.id;
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
    const t = packingTrip() || activeTrip();
    const names = normalizeTravelers(t && t.travelers);
    return names.length >= 2 ? names : [];
  };

  function packingCountText(rows) {
    return `${rows.filter(r => r.done).length} of ${rows.length} packed`;
  }

  function renderPacking() {
    const trip = packingTrip();
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
    const trip = packingTripForWrite();
    if (!trip) return;
    const row = packingRows(trip).find(r => r.id === box.dataset.pk);
    if (!row) return;
    row.done = box.checked;
    // updated in place rather than re-rendered: rebuilding the list would throw
    // away the checkbox the keyboard is standing on
    box.closest('.pk-row').classList.toggle('is-done', row.done);
    // both counters read the same rows the list is showing, and the select's
    // per-person tallies are rebuilt with them: focus is on this checkbox, not
    // in the select, so replacing it takes nobody's place
    const names = packingNames();
    const all = packingRows(trip);
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
    const trip = packingTripForWrite();
    if (!trip) return;
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
    const trip = packingTripForWrite();
    if (!trip) return;
    const row = { id: uid(), text, done: false };
    const who = pickedPackingWho();
    // absent rather than empty, so a row for everyone is byte for byte the row
    // this list has always stored
    if (who.length) row.who = who;
    trip.packing.push(row);
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
  // A dialog reopens at the TOP, every time.
  //
  // Every overlay in this app is markup that already exists and is toggled with
  // a class (`.overlay` is display:none, `.overlay.open` is display:flex), so
  // nothing is ever recreated - and a scroll container keeps its offset across
  // that toggle. Scroll to the bottom of the Add-item form, close it, open it
  // again and the browser hands back the same scroll position, halfway down a
  // form that is supposed to be fresh.
  //
  // Two containers hold an offset, not one, which is why resetting `.m-body`
  // alone would leave a dialog 30-odd pixels down: `.m-body` is the modal's own
  // scroller, and `.overlay` ITSELF scrolls when the modal is taller than the
  // viewport. Nested ones exist too (`#importBookingResult`), so this resets
  // whatever is actually scrolled rather than a list of selectors that would
  // have to be kept in step with the CSS.
  //
  // Read every offset first and write afterwards: reading `scrollTop` flushes
  // layout, and interleaving reads with writes would flush it once per element.
  function resetScrollWithin(root) {
    if (!root) return;
    const scrolled = [root, ...root.querySelectorAll('*')].filter(el => el.scrollTop || el.scrollLeft);
    for (const el of scrolled) { el.scrollTop = 0; el.scrollLeft = 0; }
  }

  function openOverlay(sel) {
    if (!document.querySelector('.overlay.open')) overlayReturnFocus = document.activeElement;
    const o = $(sel);
    o.classList.add('open');
    // AFTER .open, because a display:none element has no layout to scroll: the
    // write would be dropped and the old offset would come back with the paint.
    // Before the focus call below, and before every opener's own focus(), so a
    // dialog that deliberately focuses a field further down (Trip settings in
    // template mode) still wins - intent beats the reset, the reset beats the
    // leftover. No smooth-scroll anywhere in this app's CSS, so this lands in
    // the same frame and nothing is ever painted at the old position.
    resetScrollWithin(o);
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
    // the day-route map is rebuilt per open; a kept instance would come back
    // sized to a closed box
    if (o.id === 'dayRouteOverlay' && dayRouteMapInstance) { dayRouteMapInstance.remove(); dayRouteMapInstance = null; }
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
  $('#routeBtn').addEventListener('click', openRouteFromTrip);
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
    if (act === 'change-choice') {
      const entry = assistChoice.get(card);
      if (!entry) return;
      // the same snapshot undo uses: picker back, radios reset, actions re-armed
      entry.restore();
      // Backing out of a reopened choice must not delete anything, so the
      // second button stops being "Skip this slot" and becomes Cancel, which
      // returns to the done stub. A fresh set's skip is untouched.
      const skip = card.querySelector('[data-act="skip-set"]');
      if (skip) { skip.textContent = 'Cancel'; skip.dataset.act = 'cancel-change'; }
      refreshDistances();
      return;
    }
    if (act === 'cancel-change') {
      const entry = assistChoice.get(card);
      const pids = setPids(card);
      for (const p of pids) assistActions.delete(p);
      const trip = activeTrip();
      const stillThere = entry && trip && trip.items.some(x => x.id === entry.addedId);
      // the stub may only claim "Added" while the item is actually still on
      // the trip; if it was deleted meanwhile (undo, a row delete), backing
      // out leaves nothing to stand behind and the card goes the way a skip
      // would
      if (stillThere) markProposalDone(card, 'add', entry.title);
      else card.remove();
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
    // The row's own issue marker: open the panel listing every issue in full.
    // The marker already CARRIES the sentence (its aria-label and tooltip), so
    // this is the "and where do I fix it" step, not the explanation itself.
    if (e.target.closest('[data-issue-jump]')) { openIssuesPanel(); return; }
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    if (btn.dataset.act === 'more') { toggleDetails(btn); return; }
    const act = btn.dataset.act, date = btn.dataset.date;
    if (act === 'day-menu') { toggleDayMenu(btn); return; }
    // Any other action retires an open day menu - except Copy day, which
    // keeps its menu up so the item's own checkmark flash is seen (the
    // document-level outside-click closes it the moment attention moves on).
    if (act !== 'share-day') closeDayMenus();
    if (act === 'ask-day') openAssist(date);
    // read-only, like ask-day: a shared trip's visitor can look at the route
    else if (act === 'day-route') openDayRoute(date);
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
    // captured BEFORE the await: closing the modal mid-delete nulls
    // ui.editingId, and listDocs(null) is an unbounded IndexedDB query that
    // painted every item's attachments into the closed modal's list
    const itemId = ui.editingId;
    try { await deleteDoc(Number(btn.dataset.docRemove)); }
    catch {
      // the thumbnail is still there because the document still is. Saying so
      // beats leaving the row looking like a button that does nothing.
      toastError('That document could not be removed on this device.');
      return;
    }
    if (ui.editingId === itemId) await renderDocsList(itemId);
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
    if (!b) return;
    setModalType(b.dataset.type);
    // the type is what decides which dates and which city a blank form can
    // answer for itself; see applyTypeDefaults for why it is not in setModalType
    applyTypeDefaults();
    // Choosing Flight reveals the airport pair, and that pair is the field the
    // form then tells you to fill ("Picking both writes the title below"). The
    // cursor follows what the click just put on screen; anything already typed
    // is left alone, and the cursor stays put for every other type.
    if (b.dataset.type === 'flight' && !$('#inFlightFrom').value && !$('#inTitle').value) {
      $('#inFlightFrom').focus({ preventScroll: true });
    }
  });
  // The subtype is a plain select and stores itself on save; this only keeps
  // the module's copy in step so a re-render of the form cannot lose it.
  $('#inMeal').addEventListener('change', e => setModalMeal(e.target.value));
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
  // Gated on the type inside the combobox (see `enabled`): a stay searches
  // lodging, an activity searches venues, and the other four types keep
  // #inTitle as the plain free-text field it has always been.
  attachTitlePicker($('#inTitle'));
  // Ownership transfer: the moment a human types into one of the derived
  // fields, the app stops writing to it. `input` is the right event because it
  // is what a person typing fires and what setValue-style programmatic writes
  // deliberately do NOT (see the writes in applyTypeDefaults, which must stay
  // revisable).
  for (const [key, sel] of [['start', '#inStart'], ['location', '#inLocation'], ['end', '#inEnd']]) {
    $(sel).addEventListener('input', () => autoFilled.delete(key));
  }
  // Start resolving the Place city as soon as it is typed, so the hotel/venue
  // bias has coordinates by the time a name is typed into the title field.
  // pickerCityBias warms it too, which covers the app-prefilled case; this is
  // the head start for a city the traveller types themselves.
  $('#inLocation').addEventListener('change', e => warmPickerCity(e.target.value));
  // The city follows the DAY. Moving the date used to leave a city derived for
  // a different day sitting in the field, or leave it empty when the new day
  // could answer it - the toolbar's Add opens on the trip's first day, so
  // anyone adding to a later one hit exactly that.
  $('#inStart').addEventListener('change', syncDerivedCity);
  $('#inStatus').addEventListener('change', syncBookByRow);
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
    setActiveTrip(e.target.value);
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
    else if (act === 'tempunit') {
      useF = !useF;
      localStorage.setItem(TEMPUNIT_KEY, useF ? 'f' : 'c');
      setTempUnit(useF ? 'f' : 'c');
      syncTempunitLabel();
      render();
      toast(useF ? 'Temperatures now shown in Fahrenheit' : 'Temperatures now shown in Celsius');
    }
    else if (act === 'distunit') {
      useKm = !useKm;
      localStorage.setItem(DISTUNIT_KEY, useKm ? 'km' : 'mi');
      setDistanceUnit(useKm ? 'km' : 'mi');
      syncDistunitLabel();
      render();
      // the assistant's chips live outside render()'s views, so they repaint
      // through the shared pass like every other distance surface
      refreshDistances();
      toast(useKm ? 'Distances now shown in kilometers' : 'Distances now shown in miles');
    }
    else if (act === 'delete-trip') {
      const t = activeTrip();
      // Undo brings the trip back but not its attachments: those live in
      // IndexedDB against the item ids and are purged below, exactly as the
      // item and bulk deletes purge theirs. Both of those say so before they
      // act; this one promised an undo it could not make whole and said nothing.
      const docs = t.items.reduce((n, it) => n + (docCounts.get(it.id) || 0), 0);
      const attached = docs ? ' Attached documents cannot be recovered.' : '';
      confirmDialog('Delete this trip?', `"${t.name}" and its ${t.items.length} item(s) will be removed.${attached} You can undo this until you reload the page.`, 'Delete trip', () => {
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
        setActiveTrip(db.trips.length ? db.trips[0].id : null);
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
      // items are passed so the prefill carries the CITY those nights are spent
      // in as well as their dates - the same derivation a blank form uses
      const pre = stayPrefillForGap((currentIssues[Number(addStay.dataset.addStay)] || {}).gap, activeTrip().items);
      if (pre) openItemModal(null, pre);
      return;
    }
    // "No flight or transport is logged between A and B" -> the leg itself,
    // titled the way this app titles legs and dated the day the previous stay
    // ends. Saving it clears the warning that offered it.
    const addLeg = e.target.closest('button[data-add-transport]');
    if (addLeg && !sharedMode) {
      const pre = transportPrefillForGap((currentIssues[Number(addLeg.dataset.addTransport)] || {}).legGap);
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
      setActiveTrip(t.dataset.trip);
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
    // The row's own issue marker: open the panel listing every issue in full.
    // The marker already CARRIES the sentence (its aria-label and tooltip), so
    // this is the "and where do I fix it" step, not the explanation itself.
    if (e.target.closest('[data-issue-jump]')) { openIssuesPanel(); return; }
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
      const copy = { ...it, id: uid(), createdAt: new Date().toISOString(), title: (it.title + ' (copy)').slice(0, 120) };
      trip.items.push(copy);
      // the copy carried the source's manual `order` into its tie group as a
      // duplicate number; renumbering keeps every group gap-free, exactly as
      // an add through the form does
      normalizeOrders(trip.items);
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
  // a day-card menu closes when attention moves anywhere outside its own wrap;
  // the toggle's own click never lands here as "outside" (closest matches it)
  document.addEventListener('click', e => {
    if (!e.target.closest('.dc-menu-wrap')) closeDayMenus();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      // one keypress dismisses one layer, topmost first: a row being dragged
      // (nothing is stored until it is dropped, so this abandons it), then a
      // day card's overflow menu (the most transient popover, and mutually
      // exclusive with the layers below - opening any of them closes it),
      // then modals (z 90), then the assistant panel (80), then the header
      // popovers (search 41, menu 40)
      if (dragCtx) { cancelRowDrag(); return; }
      if (closeDayMenus(true)) return;
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
      // the selection was made from rows this page no longer holds
      exitSelectMode();
      // a remote merge invalidates local history: undoing another
      // device's change from here would push a stale state back up
      undoPast.length = 0;
      undoFuture.length = 0;
      markSaved();
      // A trip deleted on ANOTHER device never went through this device's
      // delete flow, so its chat thread was orphaned in localStorage forever.
      // Local deletes are untouched: takeChat already removed their key and
      // parked the thread in deletedChats for undo.
      pruneOrphanChats();
      render();
    } else if (key === TIMEFMT_KEY) {
      use24h = localStorage.getItem(TIMEFMT_KEY) === '24';
      syncTimefmtLabel();
      render();
    } else if (key === TEMPUNIT_KEY) {
      useF = localStorage.getItem(TEMPUNIT_KEY) === 'f';
      setTempUnit(useF ? 'f' : 'c');
      syncTempunitLabel();
      render();
    } else if (key === DISTUNIT_KEY) {
      useKm = localStorage.getItem(DISTUNIT_KEY) === 'km';
      setDistanceUnit(useKm ? 'km' : 'mi');
      syncDistunitLabel();
      render();
      refreshDistances();
    }
  });

  // The native cross-tab signal, for the same-device case the sync layer does
  // not cover: signed OUT there is no sync at all, so two open tabs each held
  // a full in-memory db and whichever saved later silently overwrote the other
  // tab's edits wholesale. The `storage` event fires only in tabs that did NOT
  // write, so there is no echo to guard against; handling mirrors the remote
  // merge above (reload from disk, reset history, re-render), because "another
  // writer changed the store underneath us" is the same situation either way.
  window.addEventListener('storage', e => {
    if (sharedMode) return;
    if (e.key === TIMEFMT_KEY) {
      use24h = localStorage.getItem(TIMEFMT_KEY) === '24';
      syncTimefmtLabel();
      render();
      return;
    }
    if (e.key === TEMPUNIT_KEY) {
      useF = localStorage.getItem(TEMPUNIT_KEY) === 'f';
      setTempUnit(useF ? 'f' : 'c');
      syncTempunitLabel();
      render();
    }
    if (e.key === DISTUNIT_KEY) {
      useKm = localStorage.getItem(DISTUNIT_KEY) === 'km';
      setDistanceUnit(useKm ? 'km' : 'mi');
      syncDistunitLabel();
      render();
      refreshDistances();
      return;
    }
    if (e.key !== LS_KEY) return;
    if (e.newValue === lastSaved) return; // same bytes, nothing to reconcile
    db = loadDb();
    repairDb();
    ensureTrip();
    exitSelectMode();
    undoPast.length = 0;
    undoFuture.length = 0;
    markSaved();
    render();
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
  syncDistunitLabel();
  syncTempunitLabel();
  // Same reader the view-hash writer consults, so the two can never disagree.
  // A hand-retyped "#SHARE=..." used to boot as a normal load, while that
  // writer (correctly case-insensitive) then refused to touch the fragment, so
  // the payload just sat in the URL doing nothing.
  const bootIsShare = viewFromHash(location.hash, ui.view).isShare;
  // repairTrips() still runs so `db` is never handed downstream code
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
