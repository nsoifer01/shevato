'use strict';
(() => {

  // ---------- constants ----------
  const TP_BUILD = 17; // bump with every asset-version bump; shown in the footer
  const LS_KEY = 'trip-planner:v1';
  const THEME_KEY = 'trip-planner:theme';
  const TIMEFMT_KEY = 'trip-planner:timefmt';
  const TYPE_META = {
    flight:    { label: 'Flight',    icon: '✈️', order: 0, cls: 'type-flight' },
    transport: { label: 'Transport', icon: '🚆', order: 1, cls: 'type-transport' },
    activity:  { label: 'Activity',  icon: '🎟️', order: 2, cls: 'type-activity' },
    stay:      { label: 'Stay',      icon: '🏨', order: 3, cls: 'type-stay' },
    note:      { label: 'Note',      icon: '📝', order: 4, cls: 'type-note' },
  };
  const STATUS_META = {
    'booked':    { label: 'Booked',       cls: 'st-booked' },
    'to-book':   { label: 'To book',      cls: 'st-to-book' },
    'decide':    { label: 'Decide later', cls: 'st-decide' },
    'cancelled': { label: 'Cancelled',    cls: 'st-cancelled' },
  };

  // Pure logic (dates, validation, coverage, stats, route math) lives in
  // js/trip-logic.js so the node:test suite can exercise it directly.
  const {
    isIsoDate, toUtc, diffDays, addDays,
    isStay, nights, sortKey, sortedItems, tripLegs,
    validateItem, coverageGaps, tripStats,
    ISLANDISH, distKm, flagEmoji, compass, fmtDur, modeOptions,
    classifyVisa, parseVisaMatrix, slimTripForShare, hasFastRail,
    buildIcs, convertAmount, sumInCurrency,
    bytesToBase64url, base64urlToBytes,
    transportGaps, tripPhase, isPastRow,
    dayCards, weatherKey, summarizeClimate, weatherLine, docGuard,
  } = window.TripLogic;

  // ---------- state ----------
  let db = loadDb();
  const ui = { search: '', filterType: '', filterStatus: '', editingId: null, shiftTarget: null, tripModalMode: 'new', confirmAction: null, flashId: null, view: 'timeline' };

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
  // data mutation already flows through. Settings (theme, time format)
  // bypass save() so they stay out of the history.
  const HISTORY_MAX = 50;
  const undoPast = [];
  const undoFuture = [];
  let lastSaved = null;

  function save() {
    if (sharedMode) return; // shared view never writes to storage
    try {
      const next = JSON.stringify(db);
      if (lastSaved !== null && next !== lastSaved) {
        undoPast.push(lastSaved);
        if (undoPast.length > HISTORY_MAX) undoPast.shift();
        undoFuture.length = 0;
      }
      lastSaved = next;
      localStorage.setItem(LS_KEY, next);
    }
    catch (err) { toast('Could not save (storage full?). Export a backup now to be safe.'); }
  }

  function restoreSnapshot(snapshot) {
    lastSaved = snapshot;
    db = JSON.parse(snapshot);
    try { localStorage.setItem(LS_KEY, snapshot); }
    catch { /* storage write is best-effort here; state is in memory */ }
    render();
  }
  function undo() {
    if (!undoPast.length) return;
    undoFuture.push(lastSaved);
    restoreSnapshot(undoPast.pop());
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
      t.budget = (t.budget != null && t.budget !== '' && !isNaN(t.budget) && Number(t.budget) >= 0) ? Number(t.budget) : null;
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
        if (it.cost != null && (it.cost === '' || isNaN(it.cost))) it.cost = null;
        if (it.costCurrency != null && !/^[A-Z]{3}$/.test(it.costCurrency)) delete it.costCurrency;
        if (it.cost != null && it.cost !== '' && !it.costCurrency) it.costCurrency = t.currency || 'USD';
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
  function fmtDate(s, withYear = true) { return (withYear ? FMT_FULL : FMT_MD).format(toUtc(s)); }
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
    }
  }

  function moneyFmt(trip) {
    try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: trip.currency || 'USD', currencyDisplay: 'narrowSymbol' }); }
    catch {
      try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: trip.currency || 'USD' }); }
      catch { return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }); }
    }
  }
  function fmtMoney(trip, n) { return moneyFmt(trip).format(n); }

  function fmtMoneyIn(code, n) {
    try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: code || 'USD', currencyDisplay: 'narrowSymbol' }).format(n); }
    catch {
      try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: code || 'USD' }).format(n); }
      catch { return `${code} ${Number(n).toFixed(2)}`; }
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
    return trip.items.some(it => it.costCurrency && it.costCurrency !== base && it.cost != null);
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
    const overnightTravel = items.filter(it => !isStay(it) && it.status !== 'cancelled' && isIsoDate(it.startDate) && isIsoDate(it.endDate) && diffDays(it.startDate, it.endDate) > 0);
    const gaps = coverageGaps(stays, tripStats(trip).end, overnightTravel);
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

  // ---------- rendering ----------
  const $ = sel => document.querySelector(sel);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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
  }

  // ---------- night coverage strip ----------
  function renderStrip(trip) {
    const box = $('#stripBox');
    const s = tripStats(trip);
    const stays = trip.items.filter(it => isStay(it) && it.status !== 'cancelled' && isIsoDate(it.startDate) && isIsoDate(it.endDate) && diffDays(it.startDate, it.endDate) > 0);
    const travelNights = trip.items.filter(it => !isStay(it) && it.status !== 'cancelled' && isIsoDate(it.startDate) && isIsoDate(it.endDate) && diffDays(it.startDate, it.endDate) > 0);
    if (!s.start || !s.end || s.totalTripNights < 2 || !stays.length) { box.hidden = true; return; }
    box.hidden = false;
    const cells = [];
    for (let d = s.start; d < s.end; d = addDays(d, 1)) {
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
    $('#stripDates').innerHTML = `<span>${fmtDate(s.start)}</span><span>${s.totalTripNights} nights</span><span>${fmtDate(s.end)}</span>`;
  }

  function renderTripSelect() {
    const sel = $('#tripSelect');
    sel.innerHTML = db.trips.map(t => `<option value="${t.id}" ${t.id === db.activeTripId ? 'selected' : ''}>${esc(t.name)}</option>`).join('');
  }

  function renderSummary(trip, issues) {
    const s = tripStats(trip);
    const money = tripMoney(trip);
    const chips = [];
    if (s.start && s.end) {
      chips.push(chip('Dates', s.start === s.end ? fmtDate(s.start) : fmtRange(s.start, s.end)));
      chips.push(chip('Length', `${diffDays(s.start, s.end) + 1} days <small>/ ${s.totalTripNights} nights</small>`));
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
    chips.push(chip('Confirmed', fmtMoney(trip, money.confirmed.total), 'ok-chip'));
    if (money.planned.total > money.confirmed.total) chips.push(chip('Full plan', fmtMoney(trip, money.planned.total)));
    if (trip.budget != null) {
      const within = money.confirmed.total <= trip.budget;
      chips.push(chip('Budget', `${fmtMoney(trip, money.confirmed.total)} <small>of ${fmtMoney(trip, trip.budget)}</small>`, within ? 'ok-chip' : 'warn-chip'));
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
      `</span><span style="color:var(--text-faint);font-weight:400;font-size:13px">(click to review)</span>`;
    $('#issuesList').innerHTML = issues.map((iss, idx) => `
      <li>
        <span class="tag ${iss.level === 'error' ? 'err' : 'warn'}">${iss.level === 'error' ? 'ERROR' : 'WARN'}</span>
        <span>${esc(iss.text)} ${iss.ids.length ? `<a data-jump="${iss.ids[0]}">show</a>` : ''}</span>
      </li>`).join('');
  }

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

  function renderBoard(trip, issues) {
    const board = $('#board');
    const items = sortedItems(trip);

    if (!items.length) {
      board.innerHTML = `
        <div class="empty">
          <div class="big">🗺️</div>
          <h2>Nothing planned yet</h2>
          <p>Add flights, stays and activities. Dates, costs and warnings update live as you type.</p>
          <div class="actions">
            <button class="btn primary" id="emptyAdd">+ Add your first item</button>
            <button class="btn" id="emptySample">Load an example trip</button>
          </div>
        </div>`;
      $('#emptyAdd').addEventListener('click', () => openItemModal(null));
      $('#emptySample').addEventListener('click', loadSample);
      return;
    }

    const shown = items.filter(matchesFilters);
    const issueById = {};
    for (const iss of issues) for (const id of iss.ids) {
      issueById[id] = issueById[id] === 'error' ? 'error' : iss.level;
    }
    const gaps = issues.filter(i => i.gap).map(i => i.gap);
    const st = tripStats(trip);
    const phase = (st.start && st.end) ? tripPhase(st.start, st.end, todayIso()) : { phase: 'before' };
    const today = todayIso();

    const sym = currencySymbol(trip.currency);
    let html = `
      <div class="thead">
        <div>Dates</div><div style="text-align:center">Nights</div><div>Type</div>
        <div>Destination / details</div><div>Status</div><div style="text-align:right">Cost (${esc(sym)})</div><div></div>
      </div>`;

    const legsByToId = {};
    for (const leg of tripLegs(trip)) legsByToId[leg.toId] = leg;

    for (const it of shown) {
      // gap banner rendered right before the first item at/after the gap start
      for (const g of gaps) {
        if (!g.rendered && it.startDate >= g.start) {
          html += `<div class="gap-row">⚠️ ${g.nights} night${g.nights === 1 ? '' : 's'} without a stay: ${g.nights === 1 ? fmtDate(g.start) : fmtRange(g.start, g.end)}</div>`;
          g.rendered = true;
        }
      }
      const leg = legsByToId[it.id];
      if (leg) {
        html += `<div class="leg-row"><button class="leg-btn" data-leg-from="${esc(leg.from)}" data-leg-to="${esc(leg.to)}" data-leg-date="${esc(leg.date)}">🧭 ${esc(leg.from)} → ${esc(leg.to)} · how to get there?</button></div>`;
      }
      const isPast = phase.phase === 'during' && isPastRow(it, today);
      html += rowHtml(trip, it, issueById[it.id], isPast);
    }
    for (const g of gaps) {
      if (!g.rendered) html += `<div class="gap-row">⚠️ ${g.nights} night${g.nights === 1 ? '' : 's'} without a stay: ${g.nights === 1 ? fmtDate(g.start) : fmtRange(g.start, g.end)}</div>`;
    }

    if (!shown.length) {
      html += `<div class="empty" style="padding:36px"><p>No items match the current filters.</p></div>`;
    }

    const money = tripMoney(trip);
    const curList = CURRENCIES.includes(trip.currency || 'USD') ? CURRENCIES : [...CURRENCIES, trip.currency];
    const curOptions = curList.map(c => `<option value="${c}" ${c === (trip.currency || 'USD') ? 'selected' : ''}>${c} (${esc(currencySymbol(c))})</option>`).join('');
    const curDisabled = sharedMode ? 'disabled' : '';
    html += `
      <div class="totals">
        <div class="t currency-pick"><div class="k">Currency</div><select id="currencySel" class="currency-sel" aria-label="Trip currency" ${curDisabled}>${curOptions}</select></div>
        ${money.planned.total > money.confirmed.total ? `<div class="t"><div class="k">Full plan</div><div class="v">${fmtMoney(trip, money.planned.total)}</div></div>` : ''}
        <div class="t confirmed"><div class="k">Confirmed bookings</div><div class="v">${fmtMoney(trip, money.confirmed.total)}</div></div>
      </div>`;
    const notes = moneyNotes(trip, money);
    if (notes) html += notes;

    board.innerHTML = html;

    if (phase.phase === 'during' && !didAutoScroll) {
      const target = shown.find(it => isIsoDate(it.startDate) && it.startDate >= today);
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
        parts.push(`${unconv.size} item${unconv.size === 1 ? '' : 's'} in a currency we could not convert are shown in their own currency and are not converted into the totals.`);
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

  function rowHtml(trip, it, issueLevel, isPast) {
    const tm = TYPE_META[it.type] || TYPE_META.note;
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
    const time = timeText ? `<span class="time">${timeText}</span>` : '';
    const cost = costCell(trip, it, n);
    const issueCls = issueLevel === 'error' ? 'has-err' : (issueLevel === 'warn' ? 'has-warn' : '');
    const statusSel = `
      <select class="status-sel ${sm.cls}" data-status-for="${it.id}" aria-label="Status" ${sharedMode ? 'disabled' : ''}>
        ${Object.entries(STATUS_META).map(([k, v]) => `<option value="${k}" ${k === it.status ? 'selected' : ''}>${v.label}</option>`).join('')}
      </select>`;
    return `
      <div class="tp-row ${issueCls} ${it.status === 'cancelled' ? 'is-cancelled' : ''} ${isPast ? 'is-past' : ''}" data-id="${it.id}">
        <div class="c-dates">${dates}${time}</div>
        <div class="c-nights">${n ?? '-'}</div>
        <div class="c-type"><span class="type-pill ${tm.cls}">${tm.icon} ${tm.label}</span></div>
        <div>
          <div class="c-title">${esc(it.title)}${it.location ? ` <span class="loc">· ${esc(it.location)}</span>` : ''}</div>
          ${it.details ? `<div class="c-details">${esc(it.details)}</div>` : ''}
        </div>
        <div class="c-status">${statusSel}</div>
        <div class="c-cost">${cost}</div>
        <div class="c-meta-mobile"><span class="type-pill ${tm.cls}">${tm.icon} ${tm.label}</span>${n ? `<span style="color:var(--text-dim)">${n} night${n === 1 ? '' : 's'}</span>` : ''}<span class="cost-m">${cost}</span></div>
        <div class="c-actions">
          <button class="row-btn" data-act="shift-item" title="Shift dates">⇄</button>
          <button class="row-btn" data-act="edit" title="Edit">✏️</button>
          <button class="row-btn" data-act="duplicate" title="Duplicate">📄</button>
          <button class="row-btn danger" data-act="delete" title="Delete" aria-label="Delete"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg></button>
        </div>
      </div>`;
  }

  function costCell(trip, it, n) {
    if (it.cost != null && it.cost !== '' && !isNaN(it.cost)) {
      const base = trip.currency || 'USD';
      const from = it.costCurrency || base;
      const amount = Number(it.cost);
      if (from !== base) {
        const conv = convertAmount(amount, from, base, activeRates(trip));
        const entered = esc(fmtMoneyIn(from, amount));
        if (conv === null) {
          // no rate yet: show the entered amount in its own currency only
          return `<span class="conv-off" title="Not converted (no exchange rate)">${entered}</span>`;
        }
        const per = n ? `<span class="per-night">${fmtMoney(trip, conv / n)}/night</span>` : '';
        return `${entered} <span class="conv">(~${fmtMoney(trip, conv)})</span>${per}`;
      }
      const total = fmtMoney(trip, amount);
      const per = n ? `<span class="per-night">${fmtMoney(trip, amount / n)}/night</span>` : '';
      return `${total}${per}`;
    }
    if (it.costNote) return `<span class="note">${esc(it.costNote)}</span>`;
    return '<span style="color:var(--text-faint)">-</span>';
  }

  // ---------- days view ----------
  // The non-cancelled, located stay you sleep under on a given date (its night
  // runs [checkin, checkout)); used to attach the typical-weather line.
  function dayNightStay(trip, date) {
    return trip.items.find(it => isStay(it) && it.status !== 'cancelled' && (it.location || '').trim()
      && isIsoDate(it.startDate) && isIsoDate(it.endDate) && it.startDate <= date && date < it.endDate) || null;
  }

  function dayEventHtml(ev) {
    const it = ev.item;
    const tm = TYPE_META[it.type] || TYPE_META.note;
    const loc = it.location ? ` <span class="loc">· ${esc(it.location)}</span>` : '';
    let label;
    if (ev.kind === 'checkin') label = `<b>Check in:</b> ${esc(it.title)}${loc}`;
    else if (ev.kind === 'checkout') label = `<b>Check out:</b> ${esc(it.title)}`;
    else label = `<b>${esc(it.title)}</b>${loc}`;
    const t = ev.time ? `<span class="dc-time">${esc(fmtTime(ev.time))}</span>` : '';
    // paperclip only where docs attach once per item (skip checkout dupes)
    const clip = ev.kind === 'checkout' ? '' : `<span class="dc-clip" data-clip-for="${it.id}" hidden>📎</span>`;
    return `<div class="dc-event ${it.status === 'cancelled' ? 'is-cancelled' : ''}">
      <span class="dc-ico">${tm.icon}</span>
      <span class="dc-label">${label}${clip}</span>${t}</div>`;
  }

  function dayCardHtml(card, isToday) {
    let body;
    if (card.empty) body = `<div class="dc-empty">No plans yet</div>`;
    else if (!card.events.length && card.stayingAt) body = `<div class="dc-staying">🏨 Staying in ${esc(card.stayingAt)}</div>`;
    else body = card.events.map(dayEventHtml).join('');
    return `
      <div class="day-card ${isToday ? 'is-today' : ''}" data-date="${card.date}">
        <div class="dc-head">
          <span class="dc-day">Day ${card.dayNumber} <small>of ${card.totalDays}</small></span>
          <span class="dc-date">${fmtDate(card.date)}</span>
        </div>
        <div class="dc-weather" hidden></div>
        <div class="dc-body">${body}</div>
      </div>`;
  }

  function renderDays() {
    const trip = activeTrip();
    const box = $('#daysList');
    const cards = dayCards(trip);
    if (!cards.length) {
      box.innerHTML = `<div class="empty" style="padding:40px 24px"><p>Add items with dates and a day-by-day plan appears here.</p></div>`;
      return;
    }
    const st = tripStats(trip);
    const phase = (st.start && st.end) ? tripPhase(st.start, st.end, todayIso()) : { phase: 'before' };
    const today = todayIso();
    box.innerHTML = cards.map(c => dayCardHtml(c, phase.phase === 'during' && c.date === today)).join('');
    loadWeatherForDays(trip);
    refreshDocIndicators();
  }

  // ---------- typical weather (Open-Meteo archive, cached) ----------
  const WEATHER_KEY = 'trip-planner:weather:v1';
  let weatherCache = {};
  try { weatherCache = JSON.parse(localStorage.getItem(WEATHER_KEY) || '{}') || {}; } catch { weatherCache = {}; }
  const weatherInflight = new Map();

  function writeWeatherSlot(slot, place, rec) {
    const line = weatherLine(place, rec);
    if (!line) return;
    slot.textContent = line;
    slot.hidden = false;
  }
  function applyWeather(key, place, rec) {
    document.querySelectorAll('#daysList .dc-weather').forEach(slot => {
      if (slot.dataset.weatherKey === key) writeWeatherSlot(slot, slot.dataset.weatherPlace || place, rec);
    });
  }

  // For each distinct (located stay, month) pair on screen, show the cached
  // climate line now and lazily fetch any we're missing (one call per pair).
  function loadWeatherForDays(trip) {
    const pairs = new Map();
    document.querySelectorAll('#daysList .day-card').forEach(card => {
      const date = card.dataset.date;
      const stay = dayNightStay(trip, date);
      if (!stay) return;
      const place = stay.location.trim();
      const month = Number(date.slice(5, 7));
      const key = weatherKey(place.toLowerCase(), month);
      const slot = card.querySelector('.dc-weather');
      slot.dataset.weatherKey = key;
      slot.dataset.weatherPlace = place;
      if (!pairs.has(key)) pairs.set(key, { place, month, key, date });
      const cached = weatherCache[key];
      if (cached) writeWeatherSlot(slot, place, cached);
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
      // typical = the SAME month one year before this trip date (archive data
      // lags a few days, so last year is always safely available)
      const year = Number(date.slice(0, 4)) - 1;
      const mm = String(month).padStart(2, '0');
      const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
      const url = 'https://archive-api.open-meteo.com/v1/archive'
        + `?latitude=${hit.lat}&longitude=${hit.lon}`
        + `&start_date=${year}-${mm}-01&end_date=${year}-${mm}-${String(lastDay).padStart(2, '0')}`
        + '&daily=temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=auto';
      const res = await fetch(url);
      if (!res.ok) throw new Error('http ' + res.status);
      const data = await res.json();
      const daily = data && data.daily;
      if (!daily) return null;
      const s = summarizeClimate(daily.temperature_2m_min, daily.temperature_2m_max, daily.precipitation_sum);
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
        <span class="doc-name">${esc(d.name)}</span>
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
    const itemCur = it && it.costCurrency ? it.costCurrency : base;
    const curList = [...new Set([...CURRENCIES, base, itemCur])];
    $('#inCostCurrency').innerHTML = curList.map(c => `<option value="${c}">${c} (${esc(currencySymbol(c))})</option>`).join('');
    $('#inCostCurrency').value = itemCur;
    const sym = currencySymbol(itemCur);
    $('#costPrefix').textContent = sym;
    $('#inCost').style.paddingLeft = (sym.length > 1 ? 18 + sym.length * 9 : 34) + 'px';
    $('#inCost').value = it && it.cost != null ? it.cost : '';
    $('#inCostNote').value = it ? (it.costNote || '') : '';
    $('#inDetails').value = it ? (it.details || '') : '';
    syncDocsSection(it);
    clearFieldErrors();
    openOverlay('#itemOverlay');
    $('#inTitle').focus();
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
    document.querySelectorAll('#typePicker button').forEach(b => b.classList.toggle('on', b.dataset.type === t));
    const stay = t === 'stay';
    const travel = t === 'flight' || t === 'transport';
    $('#fEnd').style.display = stay ? '' : 'none';
    $('#fTime').style.display = stay ? 'none' : '';
    $('#fArrivalRow').style.display = travel ? '' : 'none';
    $('#startLabel').textContent = stay ? 'Check-in' : (travel ? 'Departs' : 'Date');
    $('#timeLabel').innerHTML = (travel ? 'Departure time' : 'Time') + ' <small style="font-weight:400">(optional)</small>';
    $('#arrDateLabel').innerHTML = (t === 'flight' ? 'Lands on' : 'Arrives on') + ' <small style="font-weight:400">(optional, for overnight legs)</small>';
    $('#arrTimeLabel').innerHTML = (t === 'flight' ? 'Landing time' : 'Arrival time') + ' <small style="font-weight:400">(optional)</small>';
    $('#titleLabel').textContent = stay ? 'Hotel / stay name' : 'Title';
    $('#inTitle').placeholder = stay ? 'e.g. Hotel Mystays Premier Akasaka' : (t === 'flight' ? 'e.g. Shreveport to Tokyo (HND)' : 'e.g. Grand Palace tour');
  }

  function clearFieldErrors() { document.querySelectorAll('#itemForm .field.invalid').forEach(f => f.classList.remove('invalid')); }

  function submitItemForm(e) {
    e.preventDefault();
    clearFieldErrors();
    const travel = modalType === 'flight' || modalType === 'transport';
    const it = {
      id: ui.editingId || uid(),
      type: modalType,
      title: $('#inTitle').value.trim(),
      location: $('#inLocation').value.trim(),
      startDate: $('#inStart').value,
      endDate: modalType === 'stay' ? $('#inEnd').value : (travel ? $('#inArrDate').value : ''),
      endTime: travel ? $('#inArrTime').value : '',
      startTime: modalType === 'stay' ? '' : $('#inTime').value,
      status: $('#inStatus').value,
      cost: $('#inCost').value === '' ? null : Number($('#inCost').value),
      // always stamp the entered currency so a later change of the trip's
      // display currency converts this amount instead of relabeling it
      costCurrency: $('#inCost').value === '' ? undefined : $('#inCostCurrency').value,
      costNote: $('#inCostNote').value.trim(),
      details: $('#inDetails').value.trim(),
    };
    if (it.costCurrency === undefined) delete it.costCurrency;
    const errs = validateItem(it);
    if (errs.title) $('#fTitle').classList.add('invalid');
    if (errs.start) $('#fStart').classList.add('invalid');
    if (errs.end) {
      $(modalType === 'stay' ? '#fEnd' : '#fArrDate').classList.add('invalid');
      if (modalType === 'stay') $('#endErr').textContent = typeof errs.end === 'string' ? errs.end : 'Check-out must be after check-in.';
    }
    if (errs.cost) $('#fCost').classList.add('invalid');
    if (Object.keys(errs).length) return;

    const trip = activeTrip();
    if (ui.editingId) {
      const idx = trip.items.findIndex(x => x.id === ui.editingId);
      it.createdAt = trip.items[idx].createdAt;
      trip.items[idx] = it;
      toast('Item updated');
    } else {
      it.createdAt = new Date().toISOString();
      trip.items.push(it);
      toast('Item added');
    }
    save();
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
    save();
    closeOverlays();
    toast(`Shifted ${moved} item${moved === 1 ? '' : 's'} by ${days > 0 ? '+' : ''}${days} day${Math.abs(days) === 1 ? '' : 's'}`);
    if (ui.shiftTarget) ui.flashId = ui.shiftTarget;
    render();
  }

  // ---------- trips ----------
  function openTripModal(mode) {
    ui.tripModalMode = mode;
    const t = activeTrip();
    $('#tripModalTitle').textContent = mode === 'new' ? 'New trip' : 'Trip settings';
    $('#tripSaveBtn').textContent = mode === 'new' ? 'Create trip' : 'Save';
    $('#inTripName').value = mode === 'rename' && t ? t.name : '';
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
    const budget = rawBudget !== '' && !isNaN(rawBudget) && Number(rawBudget) >= 0 ? Number(rawBudget) : null;
    if (ui.tripModalMode === 'new') {
      const t = { id: uid(), name, currency, budget, items: [] };
      db.trips.push(t);
      db.activeTripId = t.id;
      toast(`Trip "${name}" created`);
    } else {
      const t = activeTrip();
      if ((t.currency || 'USD') !== currency) stampCostCurrencies(t, t.currency || 'USD');
      t.name = name; t.currency = currency; t.budget = budget;
      toast('Trip updated');
    }
    save();
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
    save(); render();
    toast('Trip duplicated');
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
    const base = t.currency || 'USD';
    const ratesObj = activeRates(t);
    const cols = ['startDate', 'startTime', 'endDate', 'endTime', 'nights', 'type', 'title', 'location', 'details', 'status', 'cost', 'costCurrency', `costIn${base}`, 'costNote'];
    const lines = [cols.join(',')];
    for (const it of sortedItems(t)) {
      const from = it.costCurrency || base;
      const conv = it.cost != null ? convertAmount(Number(it.cost), from, base, ratesObj) : null;
      const vals = [it.startDate, it.startTime || '', it.endDate || '', it.endTime || '', nights(it) ?? '', it.type, it.title, it.location || '', it.details || '', STATUS_META[it.status]?.label || it.status, it.cost ?? '', from, conv == null ? '' : conv.toFixed(2), it.costNote || ''];
      lines.push(vals.map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));
    }
    download(`${slug(t.name)}.csv`, lines.join('\n'), 'text/csv');
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
        for (const t of incoming) {
          if (!t || !Array.isArray(t.items)) continue;
          const nt = buildImportedTrip(t);
          db.trips.push(nt);
          db.activeTripId = nt.id;
          added++;
        }
        if (!added) throw new Error('No trips found in the file');
        save(); render();
        toast(`Imported ${added} trip${added === 1 ? '' : 's'}`);
      } catch (err) {
        toast(`Import failed: ${err.message}`);
      }
    };
    reader.readAsText(file);
  }

  // shared sanitizer for both file import and share-link import: a fresh id,
  // clamped strings, and the visaExtras/budget/currency shape the app expects
  function buildImportedTrip(t) {
    const nt = {
      id: uid(),
      name: String(t.name || 'Imported trip').slice(0, 60),
      currency: /^[A-Z]{3}$/.test(t.currency || '') ? t.currency : 'USD',
      budget: (t.budget != null && t.budget !== '' && !isNaN(t.budget) && Number(t.budget) >= 0) ? Number(t.budget) : null,
      visaExtras: (Array.isArray(t.visaExtras) ? t.visaExtras : []).filter(c => typeof c === 'string' && /^[A-Z]{2}$/.test(c)),
      items: t.items.map(sanitizeItem).filter(Boolean),
    };
    stampCostCurrencies(nt, nt.currency);
    return nt;
  }

  function sanitizeItem(raw) {
    if (!raw || typeof raw !== 'object') return null;
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
      cost: raw.cost != null && raw.cost !== '' && !isNaN(raw.cost) && Number(raw.cost) >= 0 ? Number(raw.cost) : null,
      costNote: String(raw.costNote || '').slice(0, 80),
      details: String(raw.details || '').slice(0, 500),
      createdAt: new Date().toISOString(),
    };
    if (/^[A-Z]{3}$/.test(raw.costCurrency || '')) out.costCurrency = raw.costCurrency;
    else if (out.cost != null) out.costCurrency = undefined; // stamped by the caller with the trip currency
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
        ? 'Share link copied. It is a LONG link: if a chat app truncates it, send the Export trip (JSON) file instead.'
        : 'Share link copied to clipboard');
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
      if (lastSaved === null) lastSaved = JSON.stringify(db);
      render();
      return;
    }
    realDb = db;
    sharedMode = true;
    const st = buildImportedTrip(trip);
    sharedTrip = st;
    db = { version: 1, activeTripId: st.id, trips: [st] };
    document.body.classList.add('tp-shared');
    render();
    showSharedBanner(st);
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
    if (lastSaved === null) lastSaved = JSON.stringify(db);
    db.trips.push(nt);
    db.activeTripId = nt.id;
    save();
    history.replaceState(null, '', location.pathname + location.search);
    document.body.classList.remove('tp-shared');
    const b = $('#sharedBanner');
    if (b) b.remove();
    render();
    toast(`Imported "${nt.name}"`);
  }

  function dismissShared() {
    history.replaceState(null, '', location.pathname + location.search);
    location.reload();
  }

  // ---------- sample ----------
  function loadSample() {
    const base = addDays(todayIso(), 45);
    const d = n => addDays(base, n);
    const mk = (type, title, location, startDate, endDate, status, cost, details, costNote) => ({
      id: uid(), type, title, location, startDate, endDate: endDate || '', startTime: '',
      status, cost: cost ?? null, costNote: costNote || '', details: details || '', createdAt: new Date().toISOString(),
    });
    const t = activeTrip();
    t.name = 'Example: Italy';
    t.items = [
      mk('flight', 'New York (JFK) to Rome (FCO)', '', d(0), '', 'booked', 640, 'Overnight, lands next morning'),
      mk('stay', 'Hotel Artemide', 'Rome', d(1), d(5), 'booked', 720, 'Via Nazionale 22, breakfast included'),
      mk('activity', 'Colosseum underground tour', 'Rome', d(2), '', 'to-book', 55),
      mk('transport', 'Train Rome to Florence', '', d(5), '', 'to-book', 45, 'Frecciarossa, ~1.5h'),
      mk('stay', 'Hotel Davanzati', 'Florence', d(5), d(8), 'booked', 540),
      mk('stay', 'Ca’ Bonfadini', 'Venice', d(9), d(12), 'decide', 810, 'Note the uncovered night before this one'),
      mk('flight', 'Venice (VCE) to New York (JFK)', '', d(12), '', 'to-book', null, '', 'Award ticket, taxes only'),
    ];
    save(); render();
    toast('Example trip loaded, replace it with your own plan');
  }

  // ---------- geocoding (OpenStreetMap Nominatim, cached, 1 req/sec) ----------
  // Resolves { ok:true, lat, lon, name, cc, country } on a hit,
  // { ok:false, reason:'notfound'|'network'|'empty' } otherwise. Hits are
  // cached in localStorage; not-found only for this session (typos get a
  // second chance next visit); network errors are never cached.
  const GEO_KEY = 'trip-planner:geo:v2';
  let geoCache = {};
  try { geoCache = JSON.parse(localStorage.getItem(GEO_KEY) || '{}') || {}; } catch { geoCache = {}; }
  try { localStorage.removeItem('trip-planner:geo:v1'); } catch { /* old cache format */ }
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
    fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&addressdetails=1&accept-language=en&q=' + encodeURIComponent(job.place), { signal: ctrl.signal })
      .then(r => { if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
      .then(res => {
        const row = Array.isArray(res) && res[0];
        if (row) {
          const hit = {
            lat: Number(row.lat), lon: Number(row.lon),
            name: String(row.display_name || job.place).split(',')[0],
            cc: (row.address && row.address.country_code) ? row.address.country_code.toUpperCase() : '',
            country: (row.address && row.address.country) || '',
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

  function openRouteModal(from, to, date) {
    routeDate = date || '';
    lastRouteKey = '';
    // suggest places already used in this trip
    const locs = [...new Set(activeTrip().items.map(it => (it.location || '').trim()).filter(Boolean))];
    $('#placeList').innerHTML = locs.map(l => `<option value="${esc(l)}">`).join('');
    $('#routeFrom').value = from || '';
    $('#routeTo').value = to || '';
    setRouteResult('Enter two places and hit "Check route".');
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

  function updateRouteLinks() {
    const from = $('#routeFrom').value.trim(), to = $('#routeTo').value.trim();
    const enc = encodeURIComponent;
    const ok = from && to;
    $('#rlTransit').href = ok ? `https://www.google.com/maps/dir/?api=1&origin=${enc(from)}&destination=${enc(to)}&travelmode=transit` : '#';
    $('#rlDrive').href = ok ? `https://www.google.com/maps/dir/?api=1&origin=${enc(from)}&destination=${enc(to)}&travelmode=driving` : '#';
    $('#rlFly').href = ok ? `https://www.google.com/travel/flights?q=${enc(`Flights from ${from} to ${to}` + (routeDate ? ` on ${routeDate}` : ''))}` : '#';
    $('#rlR2R').href = ok ? `https://www.rome2rio.com/map/${enc(from)}/${enc(to)}` : '#';
    ['rlTransit', 'rlDrive', 'rlFly', 'rlR2R'].forEach(id => { $('#' + id).style.opacity = ok ? '' : '0.45'; $('#' + id).style.pointerEvents = ok ? '' : 'none'; });
    syncRouteCheckBtn();
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
      setRouteResult(`Could not find "<b>${missing}</b>" on the map. Try adding the country ("Railay Beach, Thailand") or the nearest town. The link buttons below still work with whatever you typed.`, true);
      lastRouteKey = routeKeyNow();
      syncRouteCheckBtn();
      return;
    }

    const km = distKm(a, b);
    const mi = km * 0.621371;
    const island = ISLANDISH.test(from) || ISLANDISH.test(to);
    const intl = a.cc && b.cc && a.cc !== b.cc;
    const pills = [
      `<span class="rp">📏 ${Math.round(km).toLocaleString()} km / ${Math.round(mi).toLocaleString()} mi</span>`,
      `<span class="rp">🧭 heading ${compass(a, b)}</span>`,
      intl ? `<span class="rp intl">🛂 international: ${esc(a.country)} → ${esc(b.country)}</span>` : '',
      routeDate ? `<span class="rp">📅 travel day: ${fmtDate(routeDate)}</span>` : '',
    ].filter(Boolean).join('');
    const fastRail = hasFastRail(a.cc) && hasFastRail(b.cc);
    const modes = modeOptions(km, island, fastRail).map(m =>
      `<div class="mode-row"><span class="mi">${m.i}</span><div><b>${m.name}</b> · <span class="dur">${m.dur}</span><small>${m.note}</small></div></div>`
    ).join('');
    setRouteResult(`
      <div class="route-head">
        <span>${flagEmoji(a.cc)} ${esc(a.name)}</span><span class="arrow">→</span>
        <span>${flagEmoji(b.cc)} ${esc(b.name)}</span>
        <small>(matched from your input; not right? add the country)</small>
      </div>
      <div class="route-pills">${pills}</div>
      ${modes}
      <div class="route-note">Durations are straight-line estimates padded for real roads, not schedules. The buttons below open live schedules and prices with your places pre-filled.</div>`);
    lastRouteKey = routeKeyNow();
    syncRouteCheckBtn();
  }

  // ---------- map ----------
  let leafletPromise = null;
  let mapInstance = null;

  function ensureLeaflet() {
    if (window.L) return Promise.resolve(true);
    if (!leafletPromise) {
      leafletPromise = new Promise(resolve => {
        const css = document.createElement('link');
        css.rel = 'stylesheet';
        css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
        document.head.appendChild(css);
        const s = document.createElement('script');
        s.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
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
  async function renderMap() {
    const status = $('#mapStatus');
    const token = ++mapRunToken;
    const trip = activeTrip();
    const stops = mapStops(trip);
    if (!stops.length) { status.textContent = 'Add items with a "Place" (Tokyo, Kyoto, ...) and they will show up here as a route.'; if (mapInstance) { mapInstance.remove(); mapInstance = null; } return; }
    if (!navigator.onLine) { status.textContent = 'The map needs an internet connection (tiles + place lookup).'; return; }
    status.textContent = 'Loading map...';
    const ok = await ensureLeaflet();
    if (!ok) { status.textContent = 'Could not load the map library (offline?). The timeline is unaffected.'; return; }
    if (token !== mapRunToken) return;

    const located = [], failed = [];
    for (let i = 0; i < stops.length; i++) {
      status.textContent = `Locating places: ${i + 1} of ${stops.length} ("${stops[i].name}")...`;
      const hit = await geocode(stops[i].name);
      if (token !== mapRunToken) return;
      if (hit.ok) located.push({ ...stops[i], ...hit });
      else failed.push(stops[i].name);
    }
    if (!located.length) { status.textContent = `Could not locate: ${failed.join(', ')}. Try more specific place names (add the country).`; return; }

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
        return `${TYPE_META[it.type].icon} ${esc(it.title)}<br><small style="color:#777">${range}</small>`;
      }).join('<hr style="border:none;border-top:1px solid #ddd;margin:6px 0">');
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
  const VISA_URL = 'https://raw.githubusercontent.com/ilyankou/passport-index-dataset/master/passport-index-matrix-iso2.csv';
  const VISA_TTL = 30 * 86400000; // refresh the cached dataset monthly
  let visaMatrix = null;
  let visaDests = [];   // [{cc, name, places:[...]}] in visit order
  let visaUnlocated = [];
  let visaToken = 0;

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
    const saved = localStorage.getItem(PASSPORT_KEY) || '';
    if (saved && matrix.matrix[saved]) sel.value = saved;
    const addSel = $('#visaAddSel');
    if (addSel.options.length <= 1) {
      const opts = matrix.codes
        .map(cc => ({ cc, name: regionName(cc) }))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(o => `<option value="${o.cc}">${esc(o.name)} \u00A0${flagEmoji(o.cc)}</option>`)
        .join('');
      addSel.insertAdjacentHTML('beforeend', opts);
    }

    // destination countries from the itinerary, in visit order
    const stops = mapStops(activeTrip());
    visaDests = [];
    visaUnlocated = [];
    if (stops.length) {
      box.innerHTML = '<div class="route-loading"><span class="spinner"></span>Locating your destinations...</div>';
      const byCc = new Map();
      for (const stop of stops) {
        const hit = await geocode(stop.name);
        if (token !== visaToken) return;
        if (!hit.ok || !hit.cc) { visaUnlocated.push(stop.name); continue; }
        if (!byCc.has(hit.cc)) byCc.set(hit.cc, { cc: hit.cc, name: regionName(hit.cc), places: [] });
        byCc.get(hit.cc).places.push(stop.name);
      }
      visaDests = [...byCc.values()];
    }
    renderVisaRows();
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
    if (!dests.length && !visaUnlocated.length) {
      box.innerHTML = 'Add items with a "Place" (Tokyo, Bangkok, ...) and the countries you visit will be listed here. You can also add a country manually below (layovers, road trips).';
      return;
    }
    if (!passport) {
      box.innerHTML = `Found <b class="visa-count">${dests.length}</b> destination countr${dests.length === 1 ? 'y' : 'ies'} on this trip: ${dests.map(d => flagEmoji(d.cc) + ' ' + esc(d.name)).join(', ')}.<br><br>Pick your passport above to see the requirement for each.`;
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
          <span class="visa-name">${esc(d.name)}<small>${esc(sub)}</small></span>
          <span class="visa-pill vp-${info.cls}">${esc(info.label)}</span>
          <a class="visa-verify" href="${wiki}" target="_blank" rel="noopener">verify ↗</a>
          ${remind}
          ${remove}
        </div>`;
    }).join('');
    const missing = visaUnlocated.length
      ? `<div class="visa-row"><span class="visa-flag">❓</span><span class="visa-name">Could not locate<small>${esc(visaUnlocated.join(', '))}</small></span><span class="visa-pill vp-unknown">Add the country to the place name</span></div>`
      : '';
    box.innerHTML = rows + missing;
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
    o.querySelector('.modal').focus();
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

  // ---------- theme ----------
  function applyThemeClass(t) {
    document.body.classList.toggle('tp-light', t === 'light');
  }
  function applyTheme(t) {
    applyThemeClass(t);
    localStorage.setItem(THEME_KEY, t);
  }
  (function initTheme() {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved) applyTheme(saved);
    else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) applyTheme('light');
  })();

  // ---------- events ----------
  $('#addBtn').addEventListener('click', () => openItemModal(null));
  $('#shiftTripBtn').addEventListener('click', () => openShiftModal(null));
  $('#routeBtn').addEventListener('click', () => openRouteModal('', ''));
  $('#visaBtn').addEventListener('click', openVisaModal);
  $('#passportSel').addEventListener('change', () => {
    const v = $('#passportSel').value;
    if (v) localStorage.setItem(PASSPORT_KEY, v);
    renderVisaRows();
  });
  $('#visaAddSel').addEventListener('change', () => {
    const cc = $('#visaAddSel').value;
    $('#visaAddSel').value = '';
    if (!cc) return;
    const trip = activeTrip();
    if (!Array.isArray(trip.visaExtras)) trip.visaExtras = [];
    if (!trip.visaExtras.includes(cc)) {
      trip.visaExtras.push(cc);
      save();
      toast(`${regionName(cc)} added to the visa check`);
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
    save();
    toast(`Reminder added: ${title}`);
    render();
    renderVisaRows();
  }
  $('#undoBtn').addEventListener('click', undo);
  $('#redoBtn').addEventListener('click', redo);
  $('#viewTimeline').addEventListener('click', () => { ui.view = 'timeline'; applyView(); });
  $('#viewDays').addEventListener('click', () => { ui.view = 'days'; applyView(); });
  $('#viewMap').addEventListener('click', () => { ui.view = 'map'; applyView(); });
  $('#routeForm').addEventListener('submit', e => { e.preventDefault(); checkRoute(); });
  $('#routeSwap').addEventListener('click', () => {
    const a = $('#routeFrom').value;
    $('#routeFrom').value = $('#routeTo').value;
    $('#routeTo').value = a;
    updateRouteLinks();
    if ($('#routeFrom').value.trim() && $('#routeTo').value.trim()) checkRoute();
  });
  $('#routeFrom').addEventListener('input', updateRouteLinks);
  $('#routeTo').addEventListener('input', updateRouteLinks);
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
  $('#typePicker').addEventListener('click', e => {
    const b = e.target.closest('button[data-type]');
    if (b) setModalType(b.dataset.type);
  });
  $('#inCostCurrency').addEventListener('change', () => {
    const sym = currencySymbol($('#inCostCurrency').value);
    $('#costPrefix').textContent = sym;
    $('#inCost').style.paddingLeft = (sym.length > 1 ? 18 + sym.length * 9 : 34) + 'px';
  });
  $('#shiftMinus').addEventListener('click', () => { $('#shiftDays').value = (parseInt($('#shiftDays').value, 10) || 0) - 1; });
  $('#shiftPlus').addEventListener('click', () => { $('#shiftDays').value = (parseInt($('#shiftDays').value, 10) || 0) + 1; });

  $('#themeBtn').addEventListener('click', () => {
    applyTheme(document.body.classList.contains('tp-light') ? 'dark' : 'light');
  });

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
        save(); render();
        toast(`Trip "${t.name}" deleted`);
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
    const legBtn = e.target.closest('button[data-leg-from]');
    if (legBtn) { openRouteModal(legBtn.dataset.legFrom, legBtn.dataset.legTo, legBtn.dataset.legDate); return; }
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const row = btn.closest('.tp-row');
    const id = row && row.dataset.id;
    if (!id) return;
    const trip = activeTrip();
    const it = trip.items.find(x => x.id === id);
    if (!it) return;
    const act = btn.dataset.act;
    if (act === 'edit') openItemModal(id);
    else if (act === 'shift-item') openShiftModal(id);
    else if (act === 'duplicate') {
      const copy = { ...it, id: uid(), createdAt: new Date().toISOString(), title: it.title + ' (copy)' };
      trip.items.push(copy);
      save(); ui.flashId = copy.id; render();
      toast('Item duplicated');
    } else if (act === 'delete') {
      // Items with attached documents can't use the quick undo path: the docs
      // live in IndexedDB and undo restores only the item, so require a
      // confirm and warn that the documents are gone for good.
      if ((docCounts.get(id) || 0) > 0) {
        confirmDialog('Delete this item?', `"${it.title}" will be permanently deleted. Attached documents cannot be recovered.`, 'Delete item', () => {
          const idx = trip.items.findIndex(x => x.id === id);
          if (idx < 0) return;
          trip.items.splice(idx, 1);
          deleteDocsForItem(id);
          save(); render();
          toast(`Deleted "${it.title}"`);
        });
        return;
      }
      const idx = trip.items.findIndex(x => x.id === id);
      lastDeleted = { item: it, idx, tripId: trip.id };
      trip.items.splice(idx, 1);
      save(); render();
      toast(`Deleted "${it.title}"`, () => {
        const t2 = db.trips.find(x => x.id === lastDeleted.tripId);
        if (t2) { t2.items.splice(Math.min(lastDeleted.idx, t2.items.length), 0, lastDeleted.item); save(); render(); }
      });
    }
  });

  $('#board').addEventListener('change', e => {
    if (e.target.id === 'currencySel') {
      const trip = activeTrip();
      stampCostCurrencies(trip, trip.currency || 'USD');
      trip.currency = e.target.value;
      save();
      render();
      toast(`Costs now shown in ${trip.currency} (${currencySymbol(trip.currency)}); amounts keep their entered currency and convert`);
      return;
    }
    const sel = e.target.closest('select[data-status-for]');
    if (!sel) return;
    const it = activeTrip().items.find(x => x.id === sel.dataset.statusFor);
    if (it) { it.status = sel.value; save(); render(); }
  });

  $('#board').addEventListener('dblclick', e => {
    if (sharedMode) return;
    const row = e.target.closest('.tp-row');
    if (row && !e.target.closest('select, button, a')) openItemModal(row.dataset.id);
  });

  document.querySelectorAll('.overlay').forEach(o => {
    o.addEventListener('mousedown', e => { if (e.target === o) closeOverlays(); });
  });
  document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeOverlays));
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeOverlays(); return; }
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
      lastSaved = JSON.stringify(db);
      render();
    } else if (key === THEME_KEY) {
      applyThemeClass(localStorage.getItem(THEME_KEY) || 'dark');
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
  syncTimefmtLabel();
  repairDb();
  if (location.hash.startsWith(SHARE_PREFIX)) {
    enterSharedMode();
  } else {
    ensureTrip();
    if (lastSaved === null) lastSaved = JSON.stringify(db);
    render();
  }
})();
