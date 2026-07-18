'use strict';
(() => {

  // ---------- constants ----------
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
    ISLANDISH, distKm, flagEmoji, compass, fmtDur, modeOptions, hasFastRail,
  } = window.TripLogic;

  // ---------- state ----------
  let db = loadDb();
  const ui = { search: '', filterType: '', filterStatus: '', editingId: null, shiftTarget: null, tripModalMode: 'new', confirmAction: null, flashId: null, view: 'timeline' };

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
  function save() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(db)); }
    catch (err) { toast('Could not save (storage full?). Export a backup now to be safe.'); }
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
      if (!Array.isArray(t.items)) t.items = [];
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
  function moneyFmt(trip) {
    try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: trip.currency || 'USD' }); }
    catch { return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }); }
  }
  function fmtMoney(trip, n) { return moneyFmt(trip).format(n); }

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
    return issues;
  }

  // ---------- rendering ----------
  const $ = sel => document.querySelector(sel);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function render() {
    try {
      ensureTrip();
      renderTripSelect();
      const trip = activeTrip();
      const issues = computeIssues(trip);
      renderSummary(trip, issues);
      renderStrip(trip);
      renderIssues(issues);
      renderBoard(trip, issues);
      applyView();
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
    const mapMode = ui.view === 'map';
    $('#board').style.display = mapMode ? 'none' : '';
    $('#mapBox').classList.toggle('on', mapMode);
    $('#viewTimeline').classList.toggle('on', !mapMode);
    $('#viewMap').classList.toggle('on', mapMode);
    if (mapMode) renderMap();
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
    const chips = [];
    if (s.start && s.end) {
      chips.push(chip('Dates', s.start === s.end ? fmtDate(s.start) : fmtRange(s.start, s.end)));
      chips.push(chip('Length', `${diffDays(s.start, s.end) + 1} days <small>/ ${s.totalTripNights} nights</small>`));
      const until = diffDays(todayIso(), s.start);
      if (until > 0) chips.push(chip('Countdown', `${until} day${until === 1 ? '' : 's'} to go`));
    }
    if (s.totalTripNights > 0) {
      const cls = s.bookedNights >= s.totalTripNights ? 'ok-chip' : '';
      chips.push(chip('Nights booked', `${s.bookedNights} <small>of ${s.totalTripNights}</small>`, cls));
    }
    chips.push(chip('Confirmed', fmtMoney(trip, s.confirmed), 'ok-chip'));
    if (s.planned > s.confirmed) chips.push(chip('Full plan', fmtMoney(trip, s.planned)));
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

    let html = `
      <div class="thead">
        <div>Dates</div><div style="text-align:center">Nights</div><div>Type</div>
        <div>Destination / details</div><div>Status</div><div style="text-align:right">Cost</div><div></div>
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
      html += rowHtml(trip, it, issueById[it.id]);
    }
    for (const g of gaps) {
      if (!g.rendered) html += `<div class="gap-row">⚠️ ${g.nights} night${g.nights === 1 ? '' : 's'} without a stay: ${g.nights === 1 ? fmtDate(g.start) : fmtRange(g.start, g.end)}</div>`;
    }

    if (!shown.length) {
      html += `<div class="empty" style="padding:36px"><p>No items match the current filters.</p></div>`;
    }

    const s = tripStats(trip);
    html += `
      <div class="totals">
        ${s.planned > s.confirmed ? `<div class="t"><div class="k">Full plan</div><div class="v">${fmtMoney(trip, s.planned)}</div></div>` : ''}
        <div class="t confirmed"><div class="k">Confirmed bookings</div><div class="v">${fmtMoney(trip, s.confirmed)}</div></div>
      </div>`;

    board.innerHTML = html;

    if (ui.flashId) {
      const el = board.querySelector(`[data-id="${ui.flashId}"]`);
      if (el) { el.classList.add('flash'); el.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
      ui.flashId = null;
    }
  }

  function rowHtml(trip, it, issueLevel) {
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
      <select class="status-sel ${sm.cls}" data-status-for="${it.id}" aria-label="Status">
        ${Object.entries(STATUS_META).map(([k, v]) => `<option value="${k}" ${k === it.status ? 'selected' : ''}>${v.label}</option>`).join('')}
      </select>`;
    return `
      <div class="tp-row ${issueCls} ${it.status === 'cancelled' ? 'is-cancelled' : ''}" data-id="${it.id}">
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
      const total = fmtMoney(trip, Number(it.cost));
      const per = n ? `<span class="per-night">${fmtMoney(trip, Number(it.cost) / n)}/night</span>` : '';
      return `${total}${per}`;
    }
    if (it.costNote) return `<span class="note">${esc(it.costNote)}</span>`;
    return '<span style="color:var(--text-faint)">-</span>';
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
    $('#inCost').value = it && it.cost != null ? it.cost : '';
    $('#inCostNote').value = it ? (it.costNote || '') : '';
    $('#inDetails').value = it ? (it.details || '') : '';
    clearFieldErrors();
    openOverlay('#itemOverlay');
    $('#inTitle').focus();
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
      costNote: $('#inCostNote').value.trim(),
      details: $('#inDetails').value.trim(),
    };
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
    $('#fTripName').classList.remove('invalid');
    openOverlay('#tripOverlay');
    $('#inTripName').focus();
  }

  function submitTripForm(e) {
    e.preventDefault();
    const name = $('#inTripName').value.trim();
    if (!name) { $('#fTripName').classList.add('invalid'); return; }
    const currency = $('#inTripCurrency').value;
    if (ui.tripModalMode === 'new') {
      const t = { id: uid(), name, currency, items: [] };
      db.trips.push(t);
      db.activeTripId = t.id;
      toast(`Trip "${name}" created`);
    } else {
      const t = activeTrip();
      t.name = name; t.currency = currency;
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
  function exportAll() {
    download('trip-planner-backup.json', JSON.stringify(db, null, 2));
  }
  function exportCsv() {
    const t = activeTrip();
    const cols = ['startDate', 'startTime', 'endDate', 'endTime', 'nights', 'type', 'title', 'location', 'details', 'status', 'cost', 'costNote'];
    const lines = [cols.join(',')];
    for (const it of sortedItems(t)) {
      const vals = [it.startDate, it.startTime || '', it.endDate || '', it.endTime || '', nights(it) ?? '', it.type, it.title, it.location || '', it.details || '', STATUS_META[it.status]?.label || it.status, it.cost ?? '', it.costNote || ''];
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
          const nt = {
            id: uid(),
            name: String(t.name || 'Imported trip').slice(0, 60),
            currency: /^[A-Z]{3}$/.test(t.currency || '') ? t.currency : 'USD',
            items: t.items.map(sanitizeItem).filter(Boolean),
          };
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

  function sanitizeItem(raw) {
    if (!raw || typeof raw !== 'object') return null;
    return {
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

  function openRouteModal(from, to, date) {
    routeDate = date || '';
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
  }

  async function checkRoute() {
    const from = $('#routeFrom').value.trim(), to = $('#routeTo').value.trim();
    updateRouteLinks();
    if (!from || !to) { setRouteResult('Enter both places first.'); return; }
    if (from.toLowerCase() === to.toLowerCase()) { setRouteResult('Those are the same place. Pick two different spots.', true); return; }
    if (!navigator.onLine) { setRouteResult('You look offline: place lookup needs internet. The link buttons will still work once you reconnect.', true); return; }

    const token = ++routeToken;
    setRouteResult('<div class="route-loading"><span class="spinner"></span>Locating places (free lookup, about a second each)...</div>');
    const [a, b] = await Promise.all([geocode(from), geocode(to)]);
    if (token !== routeToken) return; // a newer check superseded this one

    if (!a.ok || !b.ok) {
      if (a.reason === 'network' || b.reason === 'network') {
        setRouteResult('The place lookup service did not answer (network hiccup or rate limit). Try again in a few seconds, or just use the link buttons below: they work without the lookup.', true);
        return;
      }
      const missing = [!a.ok && from, !b.ok && to].filter(Boolean).map(esc).join('" and "');
      setRouteResult(`Could not find "<b>${missing}</b>" on the map. Try adding the country ("Railay Beach, Thailand") or the nearest town. The link buttons below still work with whatever you typed.`, true);
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
  $('#viewTimeline').addEventListener('click', () => { ui.view = 'timeline'; applyView(); });
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
  $('#shiftForm').addEventListener('submit', submitShiftForm);
  $('#tripForm').addEventListener('submit', submitTripForm);
  $('#typePicker').addEventListener('click', e => {
    const b = e.target.closest('button[data-type]');
    if (b) setModalType(b.dataset.type);
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
    if (act === 'new-trip') openTripModal('new');
    else if (act === 'rename-trip') openTripModal('rename');
    else if (act === 'duplicate-trip') duplicateTrip();
    else if (act === 'export-trip') exportTrip();
    else if (act === 'export-csv') exportCsv();
    else if (act === 'export-all') exportAll();
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
    const sel = e.target.closest('select[data-status-for]');
    if (!sel) return;
    const it = activeTrip().items.find(x => x.id === sel.dataset.statusFor);
    if (it) { it.status = sel.value; save(); render(); }
  });

  $('#board').addEventListener('dblclick', e => {
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
    const key = e.detail && e.detail.key;
    if (typeof key !== 'string' || !key.startsWith('trip-planner:')) return;
    if (!e.detail || e.detail.source !== 'remote') return;
    if (key === LS_KEY) {
      db = loadDb();
      repairDb();
      ensureTrip();
      render();
    } else if (key === THEME_KEY) {
      applyThemeClass(localStorage.getItem(THEME_KEY) || 'dark');
    } else if (key === TIMEFMT_KEY) {
      use24h = localStorage.getItem(TIMEFMT_KEY) === '24';
      syncTimefmtLabel();
      render();
    }
  });

  // ---------- boot ----------
  syncTimefmtLabel();
  repairDb();
  ensureTrip();
  render();
})();
