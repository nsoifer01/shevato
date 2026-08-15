// Pre-season mode.
//
// Fantasy Premier League publishes a manager's picks only after a gameweek has
// been played, so between seasons `entry/{id}/event/{gw}/picks/` returns 404 for
// every gameweek and there is genuinely nothing to import. That is not a
// failure and it is not the user's fault, so the app says what is happening and
// offers the two things it CAN do: build the opening 15 with the same optimizer
// the wildcard uses, or take a squad the user types in.
//
// The legality helpers here are pure and mirror validate.js's rules, because
// manual entry has to tell the user what is wrong WHILE they build, not after.

import { initialTransferState, freeTransfersFor } from '../engine/transfer-state.js';
import { chipsRemaining } from '../engine/squad.js';
import { el, card } from './dom.js';
import { formatMoney, dateTime, plural } from './format.js';
import { btn, banner } from './parts.js';
import { describePlayer } from './plan-model.js';

// Counts, spend and every broken rule for a work-in-progress squad. Same
// constraints validate.js enforces on a finished plan: squad size, per-position
// counts, budget at buying prices, and the club limit.
export function squadLegality(ids, gameState, { budgetTenths } = {}) {
  const rules = gameState.rules;
  const budget = budgetTenths === undefined ? rules.budgetTenths : budgetTenths;
  const counts = {};
  const clubs = new Map();
  let spend = 0;

  for (const id of ids) {
    const player = gameState.players.get(id);
    if (!player) continue;
    counts[player.position] = (counts[player.position] || 0) + 1;
    clubs.set(player.teamId, (clubs.get(player.teamId) || 0) + 1);
    spend += player.nowCost;
  }

  const issues = [];
  for (const pos of Object.values(rules.positions)) {
    const have = counts[pos.id] || 0;
    if (have > pos.squadSelect) issues.push(`${have} ${pos.short} selected, the maximum is ${pos.squadSelect}.`);
  }
  if (ids.length > rules.squadSize) issues.push(`${ids.length} players selected, a squad is ${rules.squadSize}.`);
  if (spend > budget) issues.push(`Over budget by ${formatMoney(spend - budget)}.`);
  for (const [teamId, n] of clubs) {
    if (n > rules.clubLimit) {
      const team = gameState.teams.get(teamId);
      issues.push(`${n} players from ${team ? team.name : 'one club'}, the limit is ${rules.clubLimit}.`);
    }
  }

  const complete = ids.length === rules.squadSize
    && Object.values(rules.positions).every(p => (counts[p.id] || 0) === p.squadSelect);

  return {
    counts,
    clubs,
    spend,
    remaining: budget - spend,
    issues,
    complete,
    ok: complete && issues.length === 0,
  };
}

// Why a specific player cannot be added right now, or null when he can.
export function blockedReason(playerId, ids, gameState, { budgetTenths } = {}) {
  const rules = gameState.rules;
  const player = gameState.players.get(playerId);
  if (!player) return 'Unknown player.';
  if (ids.includes(playerId)) return 'Already selected.';
  const state = squadLegality(ids, gameState, { budgetTenths });
  const pos = rules.positions[player.position];
  if ((state.counts[player.position] || 0) >= pos.squadSelect) return `You already have ${pos.squadSelect} ${pos.short}.`;
  if (ids.length >= rules.squadSize) return 'Your squad is full.';
  if ((state.clubs.get(player.teamId) || 0) >= rules.clubLimit) return `Already ${rules.clubLimit} from that club.`;
  if (player.nowCost > state.remaining) return `Costs ${formatMoney(player.nowCost)}, you have ${formatMoney(state.remaining)}.`;
  return null;
}

// A SquadState from a squad the user typed. buildSquadState() reads raw FPL
// payloads and there are none here, so the same shape is assembled directly.
// Purchase and selling price are both the current price: nothing was bought at
// an older price, so there is no profit for FPL to take a cut of.
//
// A manually entered squad is still a PRE-SEASON squad, so its transfer state
// is the unlimited one, exactly as the drafted path uses. This used to be a
// hardcoded 2, justified by the transfer search only enumerating one and two
// move plans. That reasoning conflated a limitation of OUR SEARCH with a RULE
// OF THE GAME, which is the same mistake that produced "Free transfers: 5"
// before the first deadline. How far the search can see is a property of the
// optimizer and belongs in the copy on screen, never in the squad state, where
// everything downstream reads it as fact.
export const MANUAL_TRANSFER_STATE = initialTransferState({ gw: 1 });

export function manualSquadState({ ids, gameState, gw, entry = null }) {
  const rules = gameState.rules;
  const picks = ids.map((playerId, i) => {
    const player = gameState.players.get(playerId);
    const price = player ? player.nowCost : 0;
    return {
      playerId,
      slot: i + 1,
      isCaptain: false,
      isViceCaptain: false,
      multiplier: 1,
      purchaseTenths: price,
      sellingTenths: price,
    };
  });
  const spend = picks.reduce((s, p) => s + p.sellingTenths, 0);

  return {
    entryId: entry ? entry.id : null,
    entryName: entry ? entry.name : 'Your squad',
    managerName: entry ? `${entry.player_first_name || ''} ${entry.player_last_name || ''}`.trim() : '',
    gw,
    picks,
    bankTenths: rules.budgetTenths - spend,
    squadValueTenths: rules.budgetTenths,
    transferState: MANUAL_TRANSFER_STATE,
    freeTransfers: freeTransfersFor(MANUAL_TRANSFER_STATE),
    chipsUsed: [],
    // Nothing has been played yet, so availability is whatever the rules allow
    // in this gameweek. Hardcoding an empty list said "you own no chips", which
    // is wrong: bench boost and triple captain are both playable in GW1.
    chipsAvailable: chipsRemaining({ history: null, rules, gw }),
    overallRank: null,
    totalPoints: 0,
    source: 'manual',
    asOf: gameState.fetchedAt,
    warnings: [],
  };
}

export function searchPlayers(gameState, { query = '', position = 0, limit = 40 } = {}) {
  const q = query.trim().toLowerCase();
  const out = [];
  for (const player of gameState.players.values()) {
    if (position && player.position !== position) continue;
    if (q) {
      const hay = `${player.webName} ${player.firstName} ${player.secondName}`.toLowerCase();
      if (!hay.includes(q)) continue;
    }
    out.push(player);
  }
  out.sort((a, b) => b.nowCost - a.nowCost || b.totalPoints - a.totalPoints);
  return out.slice(0, limit);
}

/* ------------------------------------------------------------------ views */

// Why there is no squad to import, which is FOUR different situations and used
// to be described as one.
//
// "The season has not started" is only true before the first deadline. Said to
// a manager mid-season whose picks are briefly unavailable, or to someone who
// has just joined, it is the app inventing a fact about the world; and the
// £100.0m budget it then offers is a different claim again, true for a new
// entry and false for a manager whose squad exists and simply could not be
// read. `entry.started_event` is what separates the last two.
export function noSquadReason({ gameState, entry, nextEvent }) {
  if (!gameState.seasonStarted) return 'preseason';
  const startedEvent = entry && Number.isFinite(entry.started_event) ? entry.started_event : null;
  const current = gameState.currentEvent;
  if (startedEvent !== null && current !== null && startedEvent > current) return 'new-entry';
  return 'picks-unavailable';
}

export function preSeasonIntro({ gameState, nextEvent, onBuild, onManual, teamName, entry = null, onRetry = null }) {
  const event = gameState.events.find(e => e.id === nextEvent) || gameState.events[0];
  const reason = noSquadReason({ gameState, entry, nextEvent });

  const intro = reason === 'preseason'
    ? banner({
      tone: 'info',
      mark: 'i',
      title: 'The season has not started yet, so there is no squad to import',
      text: el('span', {}, [
        'Fantasy Premier League publishes a team\'s picks only once a gameweek has been played. Until Gameweek ',
        el('b', { text: String(event ? event.id : 1) }),
        ' is live, ',
        el('code', { text: 'entry/.../picks' }),
        ' returns nothing for every manager, including yours. ',
        event ? `The deadline is ${dateTime(event.deadline)}.` : '',
        ' When it goes live this app switches to the normal import on its own.',
      ]),
    })
    : reason === 'new-entry'
      ? banner({
        tone: 'info',
        mark: 'i',
        title: 'This team has not played a gameweek yet',
        text: el('span', {}, [
          'The season is under way, and this team enters at Gameweek ',
          el('b', { text: String(entry && entry.started_event ? entry.started_event : (event ? event.id : 1)) }),
          '. Until then there are no picks to import, so the full budget is yours to build with.',
        ]),
      })
      : banner({
        tone: 'warn',
        mark: '!',
        title: 'Your squad could not be read just now',
        text: el('span', {}, [
          'The season is under way and this team has played, so a squad exists. Fantasy Premier League did not return it, which it does briefly while a gameweek is being processed. ',
          el('b', { text: 'Nothing below is your team' }),
          ': it is a fresh build from the full budget, so use it as a sketch rather than as advice about the squad you own, and try again in a few minutes.',
        ]),
        actions: onRetry ? [btn('Try again', onRetry, { variant: 'fpl-btn-primary' })] : null,
      });

  return el('div', {}, [
    intro,
    card('What we can do now', [
      teamName ? el('p', { class: 'fpl-note', style: 'margin-bottom:14px' }, `Connected to ${teamName}. Prices, fixtures and last season's underlying numbers are all loaded.`) : null,
      el('div', { class: 'fpl-choices' }, [
        el('div', { class: 'fpl-choice' }, [
          el('h4', { text: 'Build my opening 15' }),
          el('p', { text: 'The same optimizer the wildcard uses, run against the full player list: a legal, affordable fifteen inside the budget and the three-per-club limit, picked on projected points across the opening gameweeks.' }),
          btn('Build the optimal 15', onBuild, { variant: 'fpl-btn-primary' }),
        ]),
        el('div', { class: 'fpl-choice' }, [
          el('h4', { text: 'Enter my own squad' }),
          el('p', { text: 'Type the fifteen you have in mind. Positions, budget and the club limit are counted as you go, and the planner will pick the eleven, the captain and the bench order from it.' }),
          btn('Enter a squad manually', onManual, { variant: 'fpl-btn-quiet' }),
        ]),
      ]),
    ]),
  ]);
}

export function manualSquadView({ gameState, initialIds = [], onPlan, onCancel }) {
  const rules = gameState.rules;
  let ids = initialIds.slice();

  const counters = el('div', { class: 'fpl-counters' });
  const legality = el('div', { class: 'fpl-legality' });
  const picked = el('div', { class: 'fpl-picked' });
  const results = el('div', { class: 'fpl-search-results' });

  const query = el('input', { type: 'text', placeholder: 'Search by name', 'aria-label': 'Search players', autocomplete: 'off' });
  const posFilter = el('select', { 'aria-label': 'Filter by position' }, [
    el('option', { value: '0', text: 'All positions' }),
    ...Object.values(rules.positions).map(p => el('option', { value: String(p.id), text: p.name })),
  ]);
  const planBtn = btn('Plan with this squad', () => onPlan(ids.slice()), { variant: 'fpl-btn-primary', disabled: true });

  const draw = () => {
    const state = squadLegality(ids, gameState);

    counters.replaceChildren(...[
      ...Object.values(rules.positions).map(p => {
        const have = state.counts[p.id] || 0;
        const cls = have === p.squadSelect ? 'is-full' : have > p.squadSelect ? 'is-over' : '';
        return el('div', { class: `fpl-counter ${cls}`.trim() }, [
          el('div', { class: 'fpl-counter-k', text: p.short }),
          el('div', { class: 'fpl-counter-v', text: `${have}/${p.squadSelect}` }),
        ]);
      }),
      el('div', { class: `fpl-counter ${state.remaining < 0 ? 'is-over' : ''}`.trim() }, [
        el('div', { class: 'fpl-counter-k', text: 'Remaining' }),
        el('div', { class: 'fpl-counter-v', text: formatMoney(state.remaining) }),
      ]),
      el('div', { class: 'fpl-counter' }, [
        el('div', { class: 'fpl-counter-k', text: 'Spent' }),
        el('div', { class: 'fpl-counter-v', text: formatMoney(state.spend) }),
      ]),
    ]);

    legality.replaceChildren(state.issues.length
      ? el('ul', { class: 'fpl-legality-bad' }, state.issues.map(i => el('li', { text: i })))
      : el('div', {
        class: 'fpl-legality-ok',
        text: state.ok
          ? 'Legal squad. Ready to plan.'
          : `Legal so far. ${rules.squadSize - ids.length} more ${plural(rules.squadSize - ids.length, 'player')} to pick.`,
      }));

    picked.replaceChildren(...ids.map(id => {
      const info = describePlayer(gameState, id);
      return el('span', { class: 'fpl-picked-item' }, [
        `${info.name} ${formatMoney(info.priceTenths)}`,
        el('button', {
          type: 'button',
          class: 'fpl-btn fpl-btn-quiet fpl-btn-sm',
          'aria-label': `Remove ${info.name}`,
          onclick: () => { ids = ids.filter(x => x !== id); draw(); },
        }, '×'),
      ]);
    }));

    planBtn.disabled = !state.ok;
    drawResults();
  };

  const drawResults = () => {
    const list = searchPlayers(gameState, { query: query.value, position: Number(posFilter.value) });
    results.replaceChildren(...list.map(player => {
      const info = describePlayer(gameState, player.id);
      const blocked = blockedReason(player.id, ids, gameState);
      return el('div', { class: 'fpl-sr' }, [
        el('div', { class: 'fpl-sr-main' }, [
          el('div', { class: 'fpl-sr-name', text: info.name }),
          el('div', { class: 'fpl-sr-meta', text: `${info.club} · ${info.positionShort} · ${formatMoney(info.priceTenths)} · ${player.totalPoints} pts last season` }),
        ]),
        btn(!blocked ? 'Add' : ids.includes(player.id) ? 'Added' : 'Blocked', () => {
          ids = ids.concat(player.id);
          draw();
        }, { variant: 'fpl-btn-quiet', size: 'fpl-btn-sm', disabled: !!blocked, title: blocked || 'Add to squad' }),
      ]);
    }));
  };

  query.addEventListener('input', drawResults);
  posFilter.addEventListener('change', drawResults);
  draw();

  return card('Enter your squad', [
    el('p', { class: 'fpl-note', style: 'margin-bottom:14px' }, `Pick ${rules.squadSize} players: ${Object.values(rules.positions).map(p => `${p.squadSelect} ${p.short}`).join(', ')}, inside ${formatMoney(rules.budgetTenths)} and no more than ${rules.clubLimit} from one club. Everything is counted as you go.`),
    counters,
    legality,
    el('div', { class: 'fpl-whynot-row' }, [
      el('div', { style: 'flex:1 1 240px;min-width:0' }, query),
      posFilter,
    ]),
    results,
    picked,
    el('div', { class: 'fpl-setting-actions' }, [planBtn, btn('Back', onCancel, { variant: 'fpl-btn-quiet' })]),
  ]);
}
