// FPL rules, scoring table and chip catalogue, derived from bootstrap-static.
//
// This is the ONLY module that is allowed to know anything season-specific.
// Every other engine module reads what it needs off the Rules object, so a
// rule change upstream (defensive contribution arriving, the free-transfer cap
// moving from 2 to 5, chips splitting into two halves) is a data change here
// and nowhere else.
//
// Money is always INTEGER TENTHS of a million: `now_cost: 155` is GBP 15.5m.
// Nothing in the engine ever stores money as a float.

// ---------------------------------------------------------------------------
// The two rules the API genuinely does not publish.
//
// 1. DEFENSIVE CONTRIBUTION THRESHOLDS. `game_config.scoring
//    .defensive_contribution` gives the POINTS awarded (2 for DEF/MID/FWD, 0
//    for GKP) but not the per-position ACTION COUNT that earns them. Those
//    counts are published only in the official game rules: a defender needs 10
//    combined clearances, blocks, interceptions and tackles, while a midfielder
//    or forward needs 12 combined CBIT, tackles and ball recoveries.
// 2. THE TRANSFER HIT COST. `game_settings` carries `transfers_cap` and
//    `transfers_sell_on_fee` but no points penalty for an extra transfer. The
//    4-point hit is not exposed anywhere in bootstrap-static.
//
// Both live here, in one place, with this comment, and are read by other
// modules only through the Rules object.
const DEF_CON_THRESHOLDS = { 2: 10, 3: 12, 4: 12 };
const HIT_COST_POINTS = 4;

// The season label is not a field either, but it IS derivable: the static
// content bucket path ends with the season directory, e.g.
// ".../plfpl-production/2026_27/". Parsed rather than typed so the app does not
// need editing next August.
export function parseSeasonLabel(staticContentUrl) {
  const m = /(\d{4})_(\d{2})\/?$/.exec(String(staticContentUrl || '').trim());
  if (!m) return null;
  return `${m[1]}/${m[2]}`;
}

export function buildRules(bootstrap) {
  const settings = bootstrap.game_settings || bootstrap.game_config.rules;
  const config = bootstrap.game_config || {};

  const positions = {};
  for (const t of bootstrap.element_types) {
    positions[t.id] = {
      id: t.id,
      short: t.singular_name_short,
      name: t.singular_name,
      squadSelect: t.squad_select,
      minPlay: t.squad_min_play,
      maxPlay: t.squad_max_play,
    };
  }

  return {
    season: parseSeasonLabel(config.settings && config.settings.static_content_url),
    totalEvents: bootstrap.events.length,
    squadSize: settings.squad_squadsize,
    starters: settings.squad_squadplay,
    budgetTenths: settings.squad_total_spend,
    clubLimit: settings.squad_team_limit,
    sellFeeRate: settings.transfers_sell_on_fee,
    // 1 free transfer per gameweek plus however many the game lets you bank.
    maxFreeTransfers: 1 + settings.max_extra_free_transfers,
    transfersCap: settings.transfers_cap,
    hitCost: HIT_COST_POINTS,
    positions,
    scoring: normalizeScoring(config.scoring || {}, positions),
    defConThresholds: { ...DEF_CON_THRESHOLDS },
    chips: normalizeChips(bootstrap.chips || []),
  };
}

// game_config.scoring keys its per-position values by position SHORT NAME
// ("GKP"/"DEF"/"MID"/"FWD") while every id crossing a module boundary in this
// app is a numeric element_type. Rather than force every caller to translate,
// the per-position maps are returned keyed by BOTH, so `scoring.goals_scored.DEF`
// and `scoring.goals_scored[2]` are the same number. Scalar entries pass
// through untouched.
function normalizeScoring(scoring, positions) {
  const shortToId = {};
  for (const p of Object.values(positions)) shortToId[p.short] = p.id;

  const out = {};
  for (const [key, value] of Object.entries(scoring)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const map = { ...value };
      for (const [short, points] of Object.entries(value)) {
        if (shortToId[short] !== undefined) map[shortToId[short]] = points;
      }
      out[key] = map;
    } else {
      out[key] = value;
    }
  }
  return out;
}

// Each chip exists TWICE in the payload: once for the first half of the season
// and once for the second, with distinct start/stop event windows. Keeping both
// entries (rather than collapsing by name) is what makes "you have a second
// wildcard from GW20" expressible.
function normalizeChips(chips) {
  return chips.map(c => ({
    id: c.id,
    name: c.name,
    type: c.chip_type,
    startEvent: c.start_event,
    stopEvent: c.stop_event,
  }));
}

// A chip is available for `gw` when some catalogue window contains gw and that
// window has not already been spent.
//
// chipsUsed entries are `{ name, event }` (the shape of `history.chips`). A
// bare string is accepted too and, having no event to place it in a window,
// conservatively consumes every window of that name.
export function chipAvailableAt(rules, chipName, gw, chipsUsed = []) {
  const windows = rules.chips.filter(c => c.name === chipName);
  if (!windows.length) return false;

  const used = chipsUsed
    .map(c => (typeof c === 'string' ? { name: c, event: null } : c))
    .filter(c => c && c.name === chipName);

  for (const w of windows) {
    if (gw < w.startEvent || gw > w.stopEvent) continue;
    const spent = used.some(u => u.event === null || (u.event >= w.startEvent && u.event <= w.stopEvent));
    if (!spent) return true;
  }
  return false;
}

// The FPL sell-on rule: profit is halved and rounded DOWN to the nearest 0.1m,
// while a price fall is passed on in full. Integer tenths in, integer tenths
// out, so nothing here can drift by a rounding step.
export function sellingPrice(purchaseTenths, nowTenths, rules) {
  if (nowTenths <= purchaseTenths) return nowTenths;
  return purchaseTenths + Math.floor((nowTenths - purchaseTenths) * rules.sellFeeRate);
}

// Display only, called at the UI edge. 155 -> "£15.5m".
export function formatMoney(tenths) {
  const sign = tenths < 0 ? '-' : '';
  return `${sign}£${(Math.abs(tenths) / 10).toFixed(1)}m`;
}
