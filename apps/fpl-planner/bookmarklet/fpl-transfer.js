// The FPL Planner transfer bookmarklet.
//
// Runs in the user's own browser, on fantasy.premierleague.com, while they are
// already signed in. It reads a plan payload written by the planner (see
// js/ui/handoff.js), resolves it against FPL's OWN authenticated data, shows
// exactly what it is about to do, and submits it only after the user clicks
// Confirm.
//
// WHY THIS SHAPE:
//
//   - It is standalone. Nothing is imported and nothing is fetched from
//     shevato.com, so it works if this site is down, cannot be repointed at
//     another origin later, and is not affected by FPL's page CSP (which does
//     not govern a bookmarklet's own code, but does govern injected scripts).
//   - It never sees a password. FPL's session cookie does the authenticating,
//     the same one the open tab is already using, and it never leaves the
//     origin it belongs to.
//   - Every number it submits comes from FPL, not from the payload. Selling
//     prices come from my-team, buying prices from bootstrap-static. The
//     payload carries ids and a gameweek and nothing else, so a stale plan can
//     be wrong about WHO but never about how much.
//   - It refuses more readily than it submits. Wrong gameweek, player not in
//     the squad, player already owned, not enough money, a club over the limit,
//     a squad whose shape would change: all refusals, before anything is sent.
//
// UNOFFICIAL: /api/transfers/ is not a documented, supported API. FPL can
// change or remove it without notice. When that happens this stops working and
// says so; it does not fall back to guessing.
(function () {
  'use strict';

  var HOST = 'fantasy.premierleague.com';
  var PAYLOAD_VERSION = 1;
  var SUBMITTABLE_CHIPS = ['wildcard', 'freehit'];

  // Not published in bootstrap-static, the same lone exception the planner
  // documents in js/engine/rules.js. Shown as an estimate; FPL applies its own.
  var HIT_COST_POINTS = 4;

  /* ------------------------------------------------------------ decoding */
  // A mirror of decodeHandoff() in js/ui/handoff.js. It is a copy because this
  // file cannot import anything, and tests/bookmarklet.test.mjs pins the copy
  // by feeding it what the planner's encoder produces.

  function isPositiveInt(n) { return typeof n === 'number' && isFinite(n) && Math.floor(n) === n && n > 0; }

  function decodeHandoff(text) {
    var raw = String(text === null || text === undefined ? '' : text).trim();
    if (!raw) return { ok: false, reason: 'Nothing was pasted.' };

    var parsed;
    try { parsed = JSON.parse(raw); } catch (err) {
      return { ok: false, reason: 'That is not a plan from the FPL Planner. Copy it again with the Copy plan button.' };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, reason: 'That is not a plan from the FPL Planner.' };
    }
    if (parsed.v !== PAYLOAD_VERSION) {
      return { ok: false, reason: 'This plan is version ' + parsed.v + ', and this bookmarklet reads version ' + PAYLOAD_VERSION + '. Install the current bookmarklet from the planner.' };
    }
    if (!isPositiveInt(parsed.entry)) return { ok: false, reason: 'That plan carries no Fantasy Premier League team ID.' };
    if (!isPositiveInt(parsed.event)) return { ok: false, reason: 'That plan carries no gameweek.' };
    if (parsed.chip !== null && parsed.chip !== undefined && SUBMITTABLE_CHIPS.indexOf(parsed.chip) < 0) {
      return { ok: false, reason: 'A ' + parsed.chip + ' is not played by making transfers, so it cannot travel with them.' };
    }
    if (!Array.isArray(parsed.transfers) || !parsed.transfers.length) {
      return { ok: false, reason: 'That plan lists no transfers.' };
    }

    var transfers = [];
    var seenOut = {};
    var seenIn = {};
    for (var i = 0; i < parsed.transfers.length; i++) {
      var row = parsed.transfers[i];
      if (!row || typeof row !== 'object') return { ok: false, reason: 'That plan has a transfer that is not a pair of players.' };
      if (!isPositiveInt(row.out) || !isPositiveInt(row['in'])) {
        return { ok: false, reason: 'That plan has a transfer with a missing player.' };
      }
      if (row.out === row['in']) return { ok: false, reason: 'That plan transfers a player for himself.' };
      if (seenOut[row.out] || seenIn[row['in']]) return { ok: false, reason: 'That plan names the same player twice.' };
      seenOut[row.out] = true;
      seenIn[row['in']] = true;
      transfers.push({ out: row.out, in: row['in'] });
    }
    for (var id in seenOut) {
      if (seenIn[id]) return { ok: false, reason: 'That plan sells and buys the same player.' };
    }

    return {
      ok: true,
      payload: {
        v: PAYLOAD_VERSION,
        entry: parsed.entry,
        event: parsed.event,
        chip: parsed.chip || null,
        transfers: transfers,
      },
    };
  }

  /* --------------------------------------------------------- resolution */

  function money(tenths) {
    var sign = tenths < 0 ? '-' : '';
    var abs = Math.abs(tenths);
    return sign + '£' + (abs / 10).toFixed(1) + 'm';
  }

  function indexBy(list, key) {
    var map = {};
    for (var i = 0; i < (list || []).length; i++) map[list[i][key]] = list[i];
    return map;
  }

  // The whole of the checking, as one pure function over FPL's own two
  // payloads, so a test can drive every refusal without a browser.
  function buildSubmission(input) {
    var payload = input.payload;
    var myTeam = input.myTeam;
    var bootstrap = input.bootstrap;

    var events = (bootstrap && bootstrap.events) || [];
    var next = null;
    for (var e = 0; e < events.length; e++) if (events[e].is_next) next = events[e];
    if (!next) {
      return { ok: false, reason: 'Fantasy Premier League has no gameweek open for transfers right now.' };
    }
    if (next.id !== payload.event) {
      return { ok: false, reason: 'This plan is for Gameweek ' + payload.event + ', but the next Fantasy Premier League deadline is Gameweek ' + next.id + '. Rebuild the plan in the planner and copy it again.' };
    }

    var picks = (myTeam && myTeam.picks) || [];
    if (!picks.length) return { ok: false, reason: 'Fantasy Premier League returned no squad for this team.' };
    var owned = indexBy(picks, 'element');
    var elements = indexBy((bootstrap && bootstrap.elements) || [], 'id');

    var rows = [];
    var moneyIn = 0;
    var moneyOut = 0;
    for (var i = 0; i < payload.transfers.length; i++) {
      var t = payload.transfers[i];
      var pick = owned[t.out];
      if (!pick) {
        return { ok: false, reason: 'The plan sells a player who is not in your squad on Fantasy Premier League (element ' + t.out + '). Your team has probably changed since the plan was built.' };
      }
      if (owned[t['in']]) {
        return { ok: false, reason: 'The plan buys a player you already own (element ' + t['in'] + '). Your team has probably changed since the plan was built.' };
      }
      var outEl = elements[t.out];
      var inEl = elements[t['in']];
      if (!outEl || !inEl) {
        return { ok: false, reason: 'Fantasy Premier League does not recognise one of the players in this plan. Rebuild the plan and copy it again.' };
      }
      if (outEl.element_type !== inEl.element_type) {
        return { ok: false, reason: 'The plan swaps a player for one in a different position, which would change the shape of your squad.' };
      }
      // Selling price from FPL (it applies the sell-on fee), buying price from
      // the live price list. Neither is taken from the payload.
      var sell = pick.selling_price;
      var buy = inEl.now_cost;
      moneyIn += sell;
      moneyOut += buy;
      rows.push({
        outId: t.out,
        outName: outEl.web_name,
        outTeam: outEl.team,
        outPriceTenths: sell,
        inId: t['in'],
        inName: inEl.web_name,
        inTeam: inEl.team,
        inPriceTenths: buy,
      });
    }

    var transfersInfo = (myTeam && myTeam.transfers) || {};
    var bankBefore = typeof transfersInfo.bank === 'number' ? transfersInfo.bank : 0;
    var bankAfter = bankBefore + moneyIn - moneyOut;
    if (bankAfter < 0) {
      return { ok: false, reason: 'These transfers cost ' + money(-bankAfter) + ' more than you have. Fantasy Premier League prices moved since the plan was built.' };
    }

    // The squad after the moves must keep its shape and stay inside the club
    // limit. FPL enforces both and reports them opaquely, so they are checked
    // here where the message can name the club.
    var teamsAfter = {};
    var teamNames = indexBy((bootstrap && bootstrap.teams) || [], 'id');
    var outgoing = {};
    for (var r = 0; r < rows.length; r++) outgoing[rows[r].outId] = true;
    for (var p = 0; p < picks.length; p++) {
      if (outgoing[picks[p].element]) continue;
      var el = elements[picks[p].element];
      if (el) teamsAfter[el.team] = (teamsAfter[el.team] || 0) + 1;
    }
    for (var q = 0; q < rows.length; q++) teamsAfter[rows[q].inTeam] = (teamsAfter[rows[q].inTeam] || 0) + 1;
    var settings = (bootstrap && bootstrap.game_settings) || {};
    var clubLimit = settings.squad_team_limit;
    if (isPositiveInt(clubLimit)) {
      for (var teamId in teamsAfter) {
        if (teamsAfter[teamId] > clubLimit) {
          var club = teamNames[teamId];
          return { ok: false, reason: 'That would leave you with ' + teamsAfter[teamId] + ' players from ' + (club ? club.name : 'one club') + ', and the limit is ' + clubLimit + '.' };
        }
      }
    }

    // Free transfers and the hit, read from FPL's own counters. `limit` is null
    // on an unlimited week, which is also what a wildcard produces.
    var limit = typeof transfersInfo.limit === 'number' ? transfersInfo.limit : null;
    var made = typeof transfersInfo.made === 'number' ? transfersInfo.made : 0;
    var free = payload.chip !== null || limit === null;
    var hit = free ? 0 : Math.max(0, made + rows.length - limit) * HIT_COST_POINTS;

    return {
      ok: true,
      body: {
        chip: payload.chip,
        entry: payload.entry,
        event: payload.event,
        transfers: rows.map(function (row) {
          return {
            element_in: row.inId,
            element_out: row.outId,
            purchase_price: row.inPriceTenths,
            selling_price: row.outPriceTenths,
          };
        }),
      },
      summary: {
        event: payload.event,
        chip: payload.chip,
        rows: rows,
        teamNames: teamNames,
        bankBeforeTenths: bankBefore,
        bankAfterTenths: bankAfter,
        freeTransfers: limit,
        transfersAlreadyMade: made,
        estimatedHit: hit,
        hitIsEstimate: !free,
      },
    };
  }

  function csrfFrom(cookie) {
    var parts = String(cookie || '').split(';');
    for (var i = 0; i < parts.length; i++) {
      var pair = parts[i].trim();
      if (pair.indexOf('csrftoken=') === 0) return decodeURIComponent(pair.slice('csrftoken='.length));
    }
    return null;
  }

  /* ---------------------------------------------------------------- UI */

  var ACCENT = '#37d67a';
  var CARD_BG = '#141a24';
  var TEXT = '#e7edf7';
  var DIM = '#93a1b5';

  function node(tag, css, text) {
    var n = document.createElement(tag);
    if (css) n.style.cssText = css;
    if (text !== null && text !== undefined) n.textContent = text;
    return n;
  }

  function close() {
    var existing = document.getElementById('fpl-planner-handoff');
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
    document.removeEventListener('keydown', onKey, true);
  }

  function onKey(ev) { if (ev.key === 'Escape') close(); }

  function shell() {
    close();
    var overlay = node('div', 'position:fixed;inset:0;z-index:2147483647;background:rgba(3,6,12,.74);display:flex;align-items:flex-start;justify-content:center;padding:24px 16px;overflow:auto;font-family:"Inter","Segoe UI",system-ui,-apple-system,Arial,sans-serif;line-height:1.45;');
    overlay.id = 'fpl-planner-handoff';
    var card = node('div', 'width:100%;max-width:640px;background:' + CARD_BG + ';color:' + TEXT + ';border:1px solid #33415a;border-radius:14px;padding:22px;box-shadow:0 24px 64px rgba(0,0,0,.55);font-size:15px;');
    overlay.appendChild(card);
    overlay.addEventListener('click', function (ev) { if (ev.target === overlay) close(); });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(overlay);
    return card;
  }

  function heading(card, title) {
    card.appendChild(node('div', 'font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:' + DIM + ';margin-bottom:6px;', 'FPL Planner · shevato.com'));
    card.appendChild(node('h2', 'margin:0 0 14px;font-size:20px;font-weight:650;color:' + TEXT + ';', title));
  }

  function button(label, css, onClick) {
    var b = node('button', 'appearance:none;border-radius:9px;padding:11px 18px;font-size:15px;font-weight:600;cursor:pointer;font-family:inherit;' + css, label);
    b.addEventListener('click', onClick);
    return b;
  }

  function quietButton(label, onClick) {
    return button(label, 'background:transparent;color:' + DIM + ';border:1px solid #33415a;', onClick);
  }

  function message(title, text, tone) {
    var card = shell();
    heading(card, title);
    card.appendChild(node('p', 'margin:0 0 18px;color:' + (tone === 'bad' ? '#ffb4b4' : DIM) + ';white-space:pre-wrap;', text));
    var row = node('div', 'display:flex;gap:10px;justify-content:flex-end;');
    row.appendChild(quietButton('Close', close));
    card.appendChild(row);
  }

  function working(text) {
    var card = shell();
    heading(card, 'Working');
    card.appendChild(node('p', 'margin:0;color:' + DIM + ';', text));
  }

  function moneyRow(label, value) {
    var row = node('div', 'display:flex;justify-content:space-between;gap:12px;padding:5px 0;border-bottom:1px solid #1b2331;');
    row.appendChild(node('span', 'color:' + DIM + ';', label));
    row.appendChild(node('span', 'font-variant-numeric:tabular-nums;font-weight:600;', value));
    return row;
  }

  function confirmScreen(summary, onConfirm) {
    var card = shell();
    heading(card, 'Confirm these transfers');
    card.appendChild(node('p', 'margin:0 0 16px;color:' + DIM + ';', 'Gameweek ' + summary.event + '. Prices below are read from Fantasy Premier League, not from the plan.'));

    for (var i = 0; i < summary.rows.length; i++) {
      var row = summary.rows[i];
      var line = node('div', 'display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:11px 12px;margin-bottom:8px;background:#0d1118;border:1px solid #242e3d;border-radius:10px;');
      var outTeam = summary.teamNames[row.outTeam];
      var inTeam = summary.teamNames[row.inTeam];
      line.appendChild(node('span', 'color:#ffb4b4;font-weight:600;', '↓ ' + row.outName));
      line.appendChild(node('span', 'color:' + DIM + ';font-size:13px;', (outTeam ? outTeam.short_name + ' · ' : '') + money(row.outPriceTenths)));
      line.appendChild(node('span', 'color:' + DIM + ';', '→'));
      line.appendChild(node('span', 'color:' + ACCENT + ';font-weight:600;', '↑ ' + row.inName));
      line.appendChild(node('span', 'color:' + DIM + ';font-size:13px;', (inTeam ? inTeam.short_name + ' · ' : '') + money(row.inPriceTenths)));
      card.appendChild(line);
    }

    var facts = node('div', 'margin:16px 0 4px;font-size:14px;');
    facts.appendChild(moneyRow('Bank before', money(summary.bankBeforeTenths)));
    facts.appendChild(moneyRow('Bank after', money(summary.bankAfterTenths)));
    facts.appendChild(moneyRow(
      'Free transfers',
      summary.freeTransfers === null ? 'unlimited this week' : String(summary.freeTransfers) + (summary.transfersAlreadyMade ? ' (' + summary.transfersAlreadyMade + ' already made)' : '')
    ));
    facts.appendChild(moneyRow(
      'Points cost',
      summary.estimatedHit ? '-' + summary.estimatedHit + ' (estimated)' : 'none'
    ));
    card.appendChild(facts);

    if (summary.chip) {
      var chipName = summary.chip === 'freehit' ? 'Free Hit' : 'Wildcard';
      card.appendChild(node('p', 'margin:16px 0 0;padding:11px 12px;background:#2a1c10;border:1px solid #7a4a1a;border-radius:9px;color:#ffd7a8;', 'Confirming also PLAYS YOUR ' + chipName.toUpperCase() + '. That cannot be undone once the deadline passes.'));
    }

    card.appendChild(node('p', 'margin:16px 0 18px;color:' + DIM + ';font-size:13px;', 'This submits straight to Fantasy Premier League. There is no second confirmation after this one.'));

    var actions = node('div', 'display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap;');
    actions.appendChild(quietButton('Cancel', close));
    actions.appendChild(button('Make these transfers', 'background:' + ACCENT + ';color:#07130c;border:1px solid ' + ACCENT + ';', onConfirm));
    card.appendChild(actions);
  }

  function doneScreen(summary) {
    var card = shell();
    heading(card, 'Transfers made');
    var names = [];
    for (var i = 0; i < summary.rows.length; i++) names.push(summary.rows[i].outName + ' → ' + summary.rows[i].inName);
    card.appendChild(node('p', 'margin:0 0 8px;color:' + TEXT + ';', names.join(', ')));
    card.appendChild(node('p', 'margin:0 0 18px;color:' + DIM + ';', 'Fantasy Premier League accepted this. Reload the page to see your new squad.'));
    var actions = node('div', 'display:flex;gap:10px;justify-content:flex-end;');
    actions.appendChild(quietButton('Close', close));
    actions.appendChild(button('Reload', 'background:' + ACCENT + ';color:#07130c;border:1px solid ' + ACCENT + ';', function () { location.reload(); }));
    card.appendChild(actions);
  }

  /* --------------------------------------------------------------- run */

  function getJson(path) {
    return fetch(path, { credentials: 'same-origin', headers: { Accept: 'application/json' } }).then(function (res) {
      if (res.status === 403 || res.status === 401) {
        return { httpError: 'auth', status: res.status };
      }
      if (!res.ok) return { httpError: 'http', status: res.status };
      return res.json().then(function (body) { return { body: body }; }, function () { return { httpError: 'parse', status: res.status }; });
    }, function () {
      return { httpError: 'network', status: 0 };
    });
  }

  // The pasted plan. The clipboard is tried first because the planner just put
  // it there; prompt() is the fallback for a browser that refuses clipboard
  // read (Firefox does, and a denied permission is not an error worth showing).
  function readPlanText() {
    var viaPrompt = function () {
      return Promise.resolve(window.prompt('Paste the plan you copied from the FPL Planner:', ''));
    };
    if (!navigator.clipboard || typeof navigator.clipboard.readText !== 'function') return viaPrompt();
    return navigator.clipboard.readText().then(function (text) {
      var check = decodeHandoff(text);
      return check.ok ? text : viaPrompt();
    }, viaPrompt);
  }

  function submit(built) {
    var token = csrfFrom(document.cookie);
    if (!token) {
      message('Not signed in', 'Fantasy Premier League has not given this tab a session. Open fantasy.premierleague.com, sign in, then click the bookmarklet again.', 'bad');
      return;
    }
    working('Sending your transfers to Fantasy Premier League.');
    fetch('/api/transfers/', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRFToken': token,
      },
      body: JSON.stringify(built.body),
    }).then(function (res) {
      return res.text().then(function (text) { return { status: res.status, ok: res.ok, text: text }; });
    }).then(function (res) {
      if (res.ok) { doneScreen(built.summary); return; }
      // FPL's own words, verbatim. Nothing here decides a failure was really a
      // success, and nothing retries: a half-applied transfer is worse than a
      // refused one.
      var detail = res.text;
      try {
        var parsed = JSON.parse(res.text);
        var lines = [];
        for (var key in parsed) {
          var value = parsed[key];
          lines.push(Array.isArray(value) ? value.join(' ') : String(value));
        }
        if (lines.length) detail = lines.join('\n');
      } catch (err) { /* not JSON: show what came back */ }
      message('Fantasy Premier League refused this', 'It answered ' + res.status + ':\n\n' + detail + '\n\nNothing was changed.', 'bad');
    }, function () {
      message('Could not reach Fantasy Premier League', 'The request did not complete, so it is not clear whether anything was applied. Check your transfers page before trying again.', 'bad');
    });
  }

  function run() {
    if (location.hostname !== HOST) {
      message('Wrong site', 'This only works on fantasy.premierleague.com. Open your Transfers page there, then click the bookmarklet.', 'bad');
      return;
    }

    readPlanText().then(function (text) {
      // prompt() returns null when the user cancels, which is them backing out
      // rather than pasting something wrong. Backing out closes; it does not
      // get an error explaining that nothing was pasted.
      if (text === null) { close(); return; }
      var decoded = decodeHandoff(text);
      if (!decoded.ok) { message('That plan could not be read', decoded.reason, 'bad'); return; }
      var payload = decoded.payload;

      working('Reading your squad from Fantasy Premier League.');
      return Promise.all([
        getJson('/api/my-team/' + payload.entry + '/'),
        getJson('/api/bootstrap-static/'),
      ]).then(function (results) {
        var mine = results[0];
        var boot = results[1];
        if (mine.httpError === 'auth') {
          message('Not your team, or not signed in', 'Fantasy Premier League would not show team ' + payload.entry + ' to this browser. Sign in as that manager and click the bookmarklet again.', 'bad');
          return;
        }
        if (mine.httpError || boot.httpError) {
          message('Could not read Fantasy Premier League', 'The site did not return your squad (' + (mine.httpError || boot.httpError) + ' ' + (mine.status || boot.status) + '). Try again in a moment.', 'bad');
          return;
        }
        var built = buildSubmission({ payload: payload, myTeam: mine.body, bootstrap: boot.body });
        if (!built.ok) { message('This plan cannot be applied', built.reason, 'bad'); return; }
        confirmScreen(built.summary, function () { submit(built); });
      });
    }).then(null, function (err) {
      message('Something went wrong', String((err && err.message) || err), 'bad');
    });
  }

  // The test seam. tests/bookmarklet.test.mjs defines this hook in a vm context
  // and gets the internals; no page defines it, so in a browser the bookmarklet
  // simply runs. A `module.exports` check was rejected for this: bundled sites
  // do sometimes leave a global `module` around, and the failure mode there is
  // a bookmarklet that silently does nothing.
  if (typeof __FPL_BOOKMARKLET_EXPORT__ === 'function') {
    __FPL_BOOKMARKLET_EXPORT__({
      decodeHandoff: decodeHandoff,
      buildSubmission: buildSubmission,
      csrfFrom: csrfFrom,
      money: money,
      run: run,
      PAYLOAD_VERSION: PAYLOAD_VERSION,
      HIT_COST_POINTS: HIT_COST_POINTS,
    });
    return;
  }

  run();
})();
