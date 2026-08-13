// The answer-first dashboard.
//
// Reading order is the whole design: gameweek and deadline, then the action in
// one sentence, then captain and chip, then the transfer detail, then the
// pitch, then the reasoning, then everything that is context rather than an
// answer. A user who reads only the first screen has the recommendation.
//
// Every figure on this screen is a field of the PlanBundle or a formatted sum
// of PlanBundle fields. No sentence here explains WHY anything was chosen: that
// text comes from plan.explanation, which the engine wrote from the numbers it
// optimized on.

import { el, card, disclosure } from './dom.js';
import { combobox } from './combobox.js';
import { formatMoney, xp, signedXp, points, countdown, dateTime, relativeTime, chipLabel, plural } from './format.js';
import { actionText, pairUp, chipDecision, getProjection, describePlayer, fixtureLabel, availability } from './plan-model.js';
import { btn, affirm, banner, kv, sampleTag, confidenceStrip } from './parts.js';
import { renderPitch } from './pitch.js';
import { STRENGTH_PARAMS } from '../engine/strength.js';
import { formatFreeTransfers } from '../engine/transfer-state.js';
import { assessConfidence } from '../engine/confidence.js';
import { describeModelStatus } from '../data/model.js';

const nameOf = (gameState) => (id) => describePlayer(gameState, id).name;

// The band travels with the plan it describes, so every surface that shows one
// scores the plan in front of it rather than reusing the gameweek's.
function bandFor(plan, { bundle, gameState, sources, now }) {
  return assessConfidence({
    plan,
    projections: bundle.projections,
    gameState,
    dataStatus: bundle.dataStatus,
    sources,
    now,
  });
}

function xpOverHorizon(projections, playerId, gwFrom, horizon) {
  let sum = 0;
  for (let k = 0; k < horizon; k++) {
    const row = getProjection(projections, playerId, gwFrom + k);
    if (row && Number.isFinite(row.xPoints)) sum += row.xPoints;
  }
  return sum;
}

/* ------------------------------------------------------------------- hero */

export function heroCard({ bundle, gameState, event, now, isDraft = false, sources = null }) {
  const plan = bundle.current;
  const action = actionText(plan, nameOf(gameState), { isDraft });
  const cd = event ? countdown(event.deadline, now) : { text: 'unknown', urgent: false, passed: false };
  const chip = chipDecision(plan);
  const captain = describePlayer(gameState, plan.captain);
  const vice = describePlayer(gameState, plan.viceCaptain);
  const captainRow = getProjection(bundle.projections, plan.captain, plan.gw);
  // Directly under the action, never above it: the band qualifies the answer,
  // it does not replace it, and a low band must not read as "no recommendation".
  const band = bandFor(plan, { bundle, gameState, sources, now });

  return el('section', { class: 'fpl-hero' }, [
    el('div', { class: 'fpl-hero-top' }, [
      el('div', { class: 'fpl-gw-label' }, [
        `Gameweek ${plan.gw}`,
        bundle.dataStatus && bundle.dataStatus.sample ? ' ' : null,
        bundle.dataStatus && bundle.dataStatus.sample ? sampleTag() : null,
      ]),
      el('div', { class: `fpl-deadline ${cd.urgent ? 'is-urgent' : ''}`.trim() }, [
        cd.passed ? 'Deadline passed ' : 'Deadline in ',
        el('strong', { text: cd.text }),
        event ? ` (${dateTime(event.deadline)})` : '',
      ]),
    ]),

    el('h2', { class: 'fpl-hero-headline', text: action.headline }),
    el('p', { class: 'fpl-hero-sub' }, action.sub),

    confidenceStrip(band),

    el('div', { class: 'fpl-hero-facts' }, [
      el('div', { class: 'fpl-fact' }, [
        el('div', { class: 'fpl-fact-k', text: 'Captain' }),
        el('div', { class: 'fpl-fact-v', text: captain.name }),
        el('div', { class: 'fpl-fact-note', text: `${captainRow ? `${xp(captainRow.xPoints * 2)} xP doubled. ` : ''}Vice ${vice.name}` }),
      ]),
      el('div', { class: `fpl-fact ${chip.playing ? 'is-chip' : ''}`.trim() }, [
        el('div', { class: 'fpl-fact-k', text: 'Chip' }),
        el('div', { class: 'fpl-fact-v', text: chip.playing ? `Play ${chip.label}` : 'Hold your chips' }),
        el('div', { class: 'fpl-fact-note', text: chipNote(bundle, chip, gameState) }),
      ]),
      el('div', { class: 'fpl-fact is-good' }, [
        el('div', { class: 'fpl-fact-k', text: 'Projected points' }),
        el('div', { class: 'fpl-fact-v', text: `${xp(plan.xPointsNet)} xP` }),
        el('div', { class: 'fpl-fact-note', text: `This gameweek. ${xp(plan.xPointsHorizon)} over ${plan.horizon} gameweeks` }),
      ]),
    ]),
  ]);
}

// The chip ledger, split into the two things "in hand" used to mean at once.
//
// The season carries TWO sets of chips, each with its own half-season window, so
// "2 in hand: Free Hit, Triple Captain" was ambiguous between "these are the two
// I can play right now" and "two is all I own". It meant the first. Both numbers
// are now stated separately and neither is left to inference.
export function chipInventory(bundle, gameState) {
  const rules = gameState.rules;
  const gw = bundle.current.gw;
  const used = (bundle.squadState.chipsUsed || [])
    .map(c => (typeof c === 'string' ? { name: c, event: null } : c));

  const spent = (w) => used.some(u => u.name === w.name
    && (u.event === null || (u.event >= w.startEvent && u.event <= w.stopEvent)));

  // Owned means unspent and not already past: a window that closed is gone
  // whether or not it was played.
  const owned = (rules.chips || []).filter(w => !spent(w) && w.stopEvent >= gw);
  const usableNow = (bundle.squadState.chipsAvailable || []).map(chipLabel);
  const later = owned.filter(w => w.startEvent > gw);

  return {
    usableNow,
    ownedCount: owned.length,
    later: later.map(w => ({ label: chipLabel(w.name), fromGw: w.startEvent })),
  };
}

function chipNote(bundle, chip, gameState) {
  if (chip.playing) return 'This gameweek is the best window for it';
  const inv = chipInventory(bundle, gameState);
  if (!inv.ownedCount) return 'No chips left this season';
  if (!inv.usableNow.length) {
    return `None usable this gameweek. ${inv.ownedCount} left this season`;
  }
  return `Usable this gameweek: ${inv.usableNow.join(', ')}. ${inv.ownedCount} left this season`;
}

/* --------------------------------------------------------------- transfers */

function transferSide({ dir, playerId, gameState, projections, gw, horizon }) {
  const info = describePlayer(gameState, playerId);
  const row = getProjection(projections, playerId, gw);
  const avail = availability(gameState.players.get(playerId));
  return el('div', { class: `fpl-tr-side is-${dir}` }, [
    el('div', { class: 'fpl-tr-dir' }, [
      dir === 'out' ? 'Out' : 'In',
      avail ? el('span', { class: `fpl-chip ${avail.kind === 'out' ? 'is-inj' : 'is-doubt'}`, text: avail.label, title: avail.news, style: 'margin-left:8px' }) : null,
    ]),
    el('div', { class: 'fpl-tr-name', text: info.name }),
    el('div', { class: 'fpl-tr-meta', text: `${info.club} · ${info.positionShort} · ${fixtureLabel(row, gameState)}` }),
    el('div', { class: 'fpl-tr-nums' }, [
      el('div', {}, [
        el('div', { class: 'fpl-tr-num-k', text: 'Price' }),
        el('div', { class: 'fpl-tr-num-v', text: formatMoney(info.priceTenths) }),
      ]),
      el('div', {}, [
        el('div', { class: 'fpl-tr-num-k', text: 'xP this GW' }),
        el('div', { class: 'fpl-tr-num-v', text: row ? xp(row.xPoints) : '-' }),
      ]),
      el('div', {}, [
        el('div', { class: 'fpl-tr-num-k', text: `xP next ${horizon} GWs` }),
        el('div', { class: 'fpl-tr-num-v', text: xp(xpOverHorizon(projections, playerId, gw, horizon)) }),
      ]),
    ]),
  ]);
}

export function transfersCard({ bundle, gameState }) {
  const plan = bundle.current;
  const { projections } = bundle;
  const horizon = plan.horizon;

  const money = el('div', { class: 'fpl-money-row' }, [
    el('span', {}, ['Bank before ', el('b', { text: formatMoney(plan.bankBeforeTenths) })]),
    el('span', {}, ['Money in ', el('b', { text: formatMoney(plan.moneyInTenths) })]),
    el('span', {}, ['Money out ', el('b', { text: formatMoney(plan.moneyOutTenths) })]),
    el('span', {}, ['Bank after ', el('b', { text: formatMoney(plan.bankAfterTenths) })]),
    el('span', {}, ['Free transfers after ', el('b', { text: formatFreeTransfers(plan.freeTransfersAfter) })]),
    el('span', {}, ['Free transfers next GW ', el('b', { text: String(plan.freeTransfersNextGw) })]),
    plan.hits
      ? el('span', {}, ['Points cost ', el('b', { text: `-${plan.hitCostPoints}` })])
      : el('span', {}, ['Points cost ', el('b', { text: 'none' })]),
  ]);

  if (plan.transferCount === 0) {
    const roll = (plan.explanation && plan.explanation.rollReason) || null;
    const body = roll && roll.reasons && roll.reasons.length
      ? roll.reasons.map(r => r.text).join(' ')
      : `You keep your free transfer and go into Gameweek ${plan.gw + 1} with more room to move.`;
    return card('This gameweek', [
      affirm({
        mark: '✓',
        title: (plan.explanation && plan.explanation.headline) || 'Roll your transfer',
        body,
      }),
      money,
    ]);
  }

  const pairs = pairUp(plan);
  const rows = pairs.map(pair => el('div', { class: 'fpl-transfer' }, [
    transferSide({ dir: 'out', playerId: pair.out, gameState, projections, gw: plan.gw, horizon }),
    el('div', { class: 'fpl-tr-arrow', text: '→' }),
    transferSide({ dir: 'in', playerId: pair.in, gameState, projections, gw: plan.gw, horizon }),
    el('div', { class: 'fpl-tr-gain' }, [
      el('div', {}, [
        el('div', { class: 'fpl-gain-k', text: 'Gain this gameweek' }),
        el('div', { class: `fpl-gain-v ${pair.gwGain < 0 ? 'is-neg' : ''}`.trim(), text: Number.isFinite(pair.gwGain) ? `${signedXp(pair.gwGain)} pts` : '-' }),
      ]),
      el('div', {}, [
        el('div', { class: 'fpl-gain-k', text: `Gain over ${horizon} gameweeks` }),
        el('div', { class: `fpl-gain-v ${pair.horizonGain < 0 ? 'is-neg' : ''}`.trim(), text: Number.isFinite(pair.horizonGain) ? `${signedXp(pair.horizonGain)} pts` : '-' }),
      ]),
      el('div', { class: 'fpl-card-sub', style: 'flex:1 1 260px;min-width:0' }, 'Later gameweeks are discounted for uncertainty, so the horizon gain is not a simple sum of the weekly ones.'),
    ]),
  ]));

  return card(`This gameweek: ${plan.transferCount} ${plural(plan.transferCount, 'transfer')}`, [...rows, money]);
}

// Pre-season: there is no OUT -> IN pair to show, so the money story is what
// the fifteen costs and what is left in the bank.
export function draftCard({ bundle, gameState }) {
  const plan = bundle.current;
  const byPosition = new Map();
  for (const id of plan.squad) {
    const info = describePlayer(gameState, id);
    if (!byPosition.has(info.positionShort)) byPosition.set(info.positionShort, []);
    byPosition.get(info.positionShort).push(info);
  }

  return card('Your opening squad', [
    affirm({
      mark: '✓',
      title: (plan.explanation && plan.explanation.headline) || 'Build this opening 15',
      body: `It costs ${formatMoney(plan.moneyOutTenths)} of the ${formatMoney(plan.bankBeforeTenths)} budget and projects ${xp(plan.xPointsGw)} points in Gameweek ${plan.gw}.`,
    }),
    el('div', { class: 'fpl-kv', style: 'margin-top:16px' }, [
      ...[...byPosition.entries()].map(([short, list]) => kv(short, list.map(p => p.name).join(', '))),
    ]),
    el('div', { class: 'fpl-money-row' }, [
      el('span', {}, ['Budget ', el('b', { text: formatMoney(plan.bankBeforeTenths) })]),
      el('span', {}, ['Squad cost ', el('b', { text: formatMoney(plan.moneyOutTenths) })]),
      el('span', {}, ['Left in the bank ', el('b', { text: formatMoney(plan.bankAfterTenths) })]),
    ]),
  ]);
}

/* -------------------------------------------------------------------- chip */

export function chipCard({ bundle, gameState }) {
  const plan = bundle.current;
  const decision = chipDecision(plan);
  const reason = decision.reason;
  const reasons = (reason && reason.reasons) || [];

  const body = affirm({
    mark: decision.playing ? '★' : '✓',
    tone: decision.playing ? 'is-chip' : '',
    title: decision.playing ? `Play your ${decision.label} this gameweek` : 'Keep your chips for now',
    body: reasons.length
      ? reasons.map(r => r.text).join(' ')
      : 'No chip clears its bar this gameweek.',
  });

  const inv = chipInventory(bundle, gameState);
  const inventory = el('div', { class: 'fpl-kv', style: 'margin-top:14px' }, [
    kv('Usable this gameweek', inv.usableNow.length ? inv.usableNow.join(', ') : 'None'),
    kv('Owned for the rest of the season', String(inv.ownedCount)),
    inv.later.length
      ? kv('Not open yet', inv.later.map(c => `${c.label} from GW${c.fromGw}`).join(', '))
      : null,
  ]);

  const perChip = (reason && reason.perChip) || null;
  const detail = perChip
    ? el('div', { class: 'fpl-kv', style: 'margin-top:14px' }, Object.values(perChip).map(entry => kv(
      chipLabel(entry.chip),
      entry.available === false
        ? 'Used or out of window'
        : entry.bestGw
          ? `Best around GW${entry.bestGw}`
          : 'Hold',
    )))
    : null;

  return card('Chips', [body, inventory, detail]);
}

/* ------------------------------------------------------------------- pitch */

export function pitchCard({ bundle, gameState, initialMode = 'recommended', onModeChange = null }) {
  const plan = bundle.current;
  const body = el('div', {});
  let mode = initialMode;

  const draw = () => {
    body.replaceChildren(renderPitch({
      mode,
      plan,
      squadState: bundle.squadState,
      gameState,
      projections: bundle.projections,
      gw: plan.gw,
    }));
  };

  const seg = el('div', { class: 'fpl-seg' }, ['current', 'recommended'].map(value => el('button', {
    type: 'button',
    class: value === mode ? 'is-on' : '',
    dataset: { mode: value },
    onclick: (event) => {
      mode = value;
      for (const b of seg.children) b.classList.toggle('is-on', b.dataset.mode === mode);
      draw();
      if (onModeChange) onModeChange(mode);
      event.currentTarget.blur();
    },
  }, value === 'current' ? 'Current team' : 'Recommended')));

  draw();
  const hasSquad = (bundle.squadState.picks || []).length > 0;
  return card('Your team', body, { aside: hasSquad ? seg : null });
}

/* --------------------------------------------------------------------- why */

function reasonList(reasons) {
  return el('ul', { class: 'fpl-reasons' }, reasons.map(r => el('li', {}, [
    el('span', { text: r.text }),
  ])));
}

export function whyCard({ bundle, gameState, open = false, onToggle = null, sources = null, now = Date.now() }) {
  const plan = bundle.current;
  const ex = plan.explanation || {};
  const body = [];

  body.push(el('div', { class: 'fpl-subhead', text: 'The plan' }));
  body.push(reasonList(ex.bullets || []));

  // The full working behind the band in the hero. Everything that scored
  // against the plan AND everything that scored for it, so a user can see that
  // a high band was earned rather than assumed.
  const band = bandFor(plan, { bundle, gameState, sources, now });
  body.push(el('div', { class: 'fpl-subhead', text: `How sure is this? ${band.label}` }));
  body.push(el('ul', { class: 'fpl-reasons' }, band.factors.filter(f => f.text).map(f => el('li', {}, [
    el('span', { text: `${f.text.charAt(0).toUpperCase()}${f.text.slice(1)}.` }),
    // The heading above asks "How sure is this?", so each row answers it in the
    // same words. This used to read "For" and "Against", which left the reader
    // asking for or against WHAT: it looked like a truncated word rather than a
    // verdict on the sentence beside it.
    el('span', {
      class: `fpl-conf-mark is-${f.weight > 0 ? 'against' : 'for'}`,
      text: f.weight > 0 ? 'Less sure' : 'More sure',
    }),
  ]))));

  for (const t of ex.transferReasons || []) {
    body.push(el('div', { class: 'fpl-subhead', text: `${t.outName} out, ${t.inName} in` }));
    body.push(reasonList(t.reasons || []));
  }

  if (ex.captainReason) {
    body.push(el('div', { class: 'fpl-subhead', text: `Captain: ${describePlayer(gameState, ex.captainReason.playerId).name}` }));
    body.push(reasonList(ex.captainReason.reasons || []));
  }

  if (ex.chipReason && (ex.chipReason.reasons || []).length) {
    body.push(el('div', { class: 'fpl-subhead', text: ex.chipReason.decision === 'play' ? 'Playing a chip' : 'Holding your chips' }));
    body.push(reasonList(ex.chipReason.reasons));
  }

  if (ex.rollReason) {
    body.push(el('div', { class: 'fpl-subhead', text: 'Keeping the transfer' }));
    body.push(reasonList(ex.rollReason.reasons || []));
  }

  const node = disclosure('Why this plan?', body, { open });
  if (onToggle) node.addEventListener('toggle', () => onToggle(node.open));
  return node;
}

/* ----------------------------------------------------------------- why not */

// EVERYONE IN THE GAME, including the unavailable. The old <select> hid anyone
// the game will not sell, which meant a user searching for a player who has left
// the league got "no player matches that search" and could not tell a missing
// player from a broken search. He is listed, flagged, and the answer says he
// cannot be selected and why.
export function playerPickerItems({ bundle, gameState }) {
  const players = [...(gameState.players instanceof Map ? gameState.players.values() : [])]
    .sort((a, b) => b.nowCost - a.nowCost || a.webName.localeCompare(b.webName));

  return players.map(p => {
    const info = describePlayer(gameState, p.id);
    const row = getProjection(bundle.projections, p.id, bundle.current.gw);
    const avail = availability(p);
    return {
      id: p.id,
      label: info.name,
      meta: `${info.club} · ${info.positionShort} · ${formatMoney(info.priceTenths)}${avail ? ` · ${avail.label}` : ''}`,
      trailing: row ? `${xp(row.xPoints)} xP` : '',
      // Searchable by everything printed on the row plus the full name, so
      // "saka", "ars", "mid" and "bukayo" all find the same player.
      search: `${p.webName} ${p.firstName} ${p.secondName} ${info.club} ${info.clubName} ${info.positionShort} ${avail ? avail.label : ''}`.toLowerCase(),
    };
  });
}

export function whyNotCard({ bundle, gameState, onAsk, open = false, onToggle = null }) {
  const out = el('div', { class: 'fpl-whynot-out', hidden: true });
  const items = playerPickerItems({ bundle, gameState });

  const picker = combobox({
    items,
    label: 'Search for a player by name, club or position',
    // Short enough to survive a 390px field. The full instruction is in the
    // accessible label and in the note above, so nothing is only in a
    // placeholder that a phone truncates.
    placeholder: `Search ${items.length} players`,
    emptyText: 'No player matches that search.',
    onSelect: () => { ask.disabled = false; },
    onInput: () => { ask.disabled = !picker.value; },
  });

  const ask = btn('Answer', async () => {
    const chosen = picker.value;
    if (!chosen) return;
    ask.disabled = true;
    out.hidden = false;
    out.replaceChildren(el('div', { class: 'fpl-whynot-text', text: 'Re-running the optimization with that player forced in.' }));
    try {
      const result = await onAsk(chosen.id);
      out.replaceChildren(...renderWhyNot(result, gameState));
    } catch (err) {
      out.replaceChildren(el('div', { class: 'fpl-whynot-text', text: `That question could not be answered: ${err.message}` }));
    } finally {
      ask.disabled = false;
    }
  }, { variant: 'fpl-btn-quiet', disabled: true });

  const node = disclosure('Why not a different player?', [
    el('p', { class: 'fpl-note', style: 'margin-bottom:12px' },
      'Pick anyone in the game, by name, club or position. The answer comes from running the same optimization again with that player forced in, and reporting what the best squad containing him projects against the one recommended.'),
    el('div', { class: 'fpl-whynot-row' }, [
      el('div', { class: 'fpl-whynot-picker' }, picker.node),
      ask,
    ]),
    out,
  ], { open });
  if (onToggle) node.addEventListener('toggle', () => onToggle(node.open));
  return node;
}

const VERDICT_LABELS = {
  better: 'Better',
  level: 'Level',
  worse: 'Not chosen',
  impossible: 'Cannot fit',
  owned: 'Already picked',
  unknown: 'Unknown',
};

// The answer is a comparison, so it renders as one: the verdict, the two totals
// and what changes between them, then the working, then the one-line result.
export function renderWhyNot(result, gameState) {
  const nodes = [];

  nodes.push(el('div', { class: 'fpl-whynot-head' }, [
    el('span', { class: `fpl-whynot-verdict is-${result.verdict}`, text: VERDICT_LABELS[result.verdict] || 'Answer' }),
    el('span', { class: 'fpl-whynot-text', text: result.headline }),
  ]));

  if ((result.rows || []).length) {
    nodes.push(el('dl', { class: 'fpl-whynot-rows' }, result.rows.flatMap(r => [
      el('dt', { text: r.label }),
      el('dd', { text: r.text }),
    ])));
  }

  const items = [...(result.blockers || []), ...(result.reasons || [])];
  if (items.length) {
    nodes.push(el('ul', { class: 'fpl-blockers' }, items.map(r => el('li', { text: r.text }))));
  }

  if (result.result) {
    nodes.push(el('div', { class: 'fpl-whynot-result', text: result.result.text }));
  }

  // One primary answer on screen; every other route it looked at is one click
  // away rather than dumped underneath.
  if ((result.alternatives || []).length) {
    nodes.push(disclosure(`Other routes considered (${result.alternatives.length})`, [
      el('div', { class: 'fpl-alts' }, result.alternatives.map(alt => el('div', { class: 'fpl-alt' }, [
        el('div', { class: 'fpl-alt-title', text: alt.label }),
        el('div', { class: 'fpl-alt-delta', text: alt.hitPoints ? `${alt.text} Costs a ${alt.hitPoints} point hit.` : alt.text }),
      ]))),
    ], { className: 'fpl-whynot-alts' }));
  }

  return nodes;
}

/* ------------------------------------------------------------------ future */

export function futureCard({ bundle, gameState, sources = null, now = Date.now() }) {
  const future = bundle.future || [];
  if (!future.length) {
    return card('Next gameweeks', el('p', { class: 'fpl-empty', text: 'The horizon ends with this gameweek, so there is nothing further to project.' }));
  }

  const cols = future.map(plan => {
    const action = actionText(plan, nameOf(gameState));
    // Each column is scored on its own, so a gameweek that also has an injury
    // or a blank says THAT rather than repeating the horizon discount.
    const band = bandFor(plan, { bundle, gameState, sources, now });
    return el('div', { class: 'fpl-gw-col' }, [
      el('div', { class: 'fpl-gw-col-h' }, [
        el('div', { class: 'fpl-gw-col-gw', text: `GW ${plan.gw}` }),
        el('div', { class: 'fpl-gw-col-xp', text: `${xp(plan.xPointsGw)} xP` }),
      ]),
      el('div', { class: 'fpl-gw-col-act', text: action.headline }),
      el('div', { class: 'fpl-gw-col-det', text: action.sub }),
      confidenceStrip(band, { bare: true }),
    ]);
  });

  return card('Projected future plan', [
    el('div', { class: 'fpl-future' }, cols),
    el('div', { class: 'fpl-uncertain' }, [
      el('span', { text: '!' }),
      el('span', { text: 'These are projections, not instructions. They assume the squad above, one new free transfer per gameweek, and no price changes, and each one is recomputed from real data when its own deadline comes round.' }),
    ]),
  ]);
}

/* ------------------------------------------------------------ alternatives */

export function alternativesCard({ bundle, open = false, onToggle = null }) {
  const alts = bundle.current.alternatives || [];
  if (!alts.length) {
    const empty = disclosure('Alternatives considered', el('p', { class: 'fpl-empty', text: 'No other legal plan came within reach of the recommendation.' }), { open });
    return empty;
  }

  const rows = alts.map(alt => el('div', { class: 'fpl-alt' }, [
    el('div', { class: 'fpl-alt-title', text: alt.headline }),
    el('div', { class: 'fpl-alt-delta' }, [
      el('b', { text: `${signedXp(alt.deltaHorizon)} pts` }),
      ` over ${bundle.current.horizon} gameweeks`,
      alt.hits ? `, costs a ${alt.hitCostPoints} point hit` : '',
    ]),
  ]));

  const node = disclosure(`Alternatives considered (${alts.length})`, [
    el('p', { class: 'fpl-note', style: 'margin-bottom:12px' }, 'Ranked against the recommendation over the same horizon. Each one is legal and affordable; none of them scored higher.'),
    el('div', { class: 'fpl-alts' }, rows),
  ], { open });
  if (onToggle) node.addEventListener('toggle', () => onToggle(node.open));
  return node;
}

/* ------------------------------------------------------------------ status */

export function statusCard({ bundle, sources = [], runnerMode = 'worker', modelStatus = null, open = false, onToggle = null, now = Date.now() }) {
  const ds = bundle.dataStatus || {};
  // A sample snapshot carries the date it was captured, which is not a point on
  // this user's clock, so it is shown as a date rather than "3 hours ago".
  const age = (iso) => (ds.sample ? dateTime(iso) : relativeTime(iso, now));
  const sourceRows = sources.map(s => el('div', { class: `fpl-src ${!s.ok ? 'is-bad' : s.stale ? 'is-stale' : ''}`.trim() }, [
    el('span', { class: 'fpl-src-dot' }),
    el('span', { text: s.name }),
    el('span', { class: 'fpl-src-age', text: s.error ? s.error : s.fetchedAt ? age(s.fetchedAt) : 'not loaded' }),
  ]));

  const node = disclosure('Model and data status', [
    ds.sample ? el('div', { class: 'fpl-sample-banner' }, [sampleTag(), el('span', { text: 'These figures come from the bundled sample dataset, not from Fantasy Premier League.' })]) : null,
    el('div', { class: 'fpl-kv' }, [
      kv('Model version', ds.modelVersion || 'unknown'),
      // The version above names whatever actually produced the plan. This row
      // says whether the trained artifact was behind it, and when it was not,
      // why not: a plan built on the analytic priors looks exactly as confident
      // as one built on a calibrator measured against held-out seasons. Three
      // answers are possible, and today's is the middle one: the artifact loads,
      // and is deliberately not used because replaying past seasons with it lost
      // points. Do not shorten this to "loaded" or "not loaded".
      kv('Trained model', describeModelStatus(modelStatus)),
      kv('Horizon', `${ds.horizon} gameweeks`),
      kv('Uncertainty discount', `${ds.discount} per gameweek`),
      kv('Risk profile', ds.risk || 'balanced'),
      kv('Home advantage', `x${STRENGTH_PARAMS.homeAdvantagePrior}`),
      kv('Optimizer time', `${Math.round(ds.durationMs || 0)} ms`),
      kv('Computed', ds.planComputedAt ? relativeTime(ds.planComputedAt, now) : 'unknown'),
      kv('Data fetched', ds.fetchedAt ? age(ds.fetchedAt) : 'unknown'),
      kv('Ran in', runnerMode === 'worker' ? 'a background worker' : 'the page (no worker)'),
      kv('Legality check', bundle.validation && bundle.validation.ok ? 'Passed' : 'Failed'),
    ]),
    el('div', { class: 'fpl-subhead', text: 'Sources' }),
    ...sourceRows,
    (bundle.squadState.warnings || []).length
      ? el('div', {}, [
        el('div', { class: 'fpl-subhead', text: 'Data quality' }),
        el('ul', { class: 'fpl-missing' }, bundle.squadState.warnings.map(w => el('li', { text: w.message }))),
      ])
      : null,
    el('p', { class: 'fpl-note', style: 'margin-top:16px' }, 'Every plan is checked for squad size, position counts, the three-per-club limit, affordability at selling prices, formation legality, bench composition, captain and vice, chip windows and hit arithmetic before it is shown. A plan that fails is never rendered.'),
  ], { open });
  if (onToggle) node.addEventListener('toggle', () => onToggle(node.open));
  return node;
}

/* ---------------------------------------------------------------- withheld */

// When availability data could not be refreshed the plan is not shown at all.
// A recommendation that silently assumes last week's injury list is worse than
// no recommendation, because it looks exactly as confident as a good one.
export function withheldView({ assessment, onRetry }) {
  return banner({
    tone: 'error',
    mark: '!',
    title: 'We are not showing a plan right now',
    text: assessment.reason,
    list: [
      ...assessment.failed.map(name => `${name}: could not be loaded`),
      ...assessment.stale.map(name => `${name}: only an older copy is available`),
    ],
    actions: [btn('Try again', onRetry, { variant: 'fpl-btn-primary' })],
  });
}
