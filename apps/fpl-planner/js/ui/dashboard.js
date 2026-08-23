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
import { btn, affirm, banner, kv, sampleTag, confidenceStrip, emphasize } from './parts.js';
import { renderPitch, pitchViewModel } from './pitch.js';
import { renderSquadTable } from './squad-table.js';
import { columnChart } from './charts.js';
import { STRENGTH_PARAMS } from '../engine/strength.js';
import { formatFreeTransfers } from '../engine/transfer-state.js';
import { openingSquadMoney, picksCarryLineup } from '../engine/squad.js';
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
      // `countdown` already words the passed case, so the prefix belongs only to
      // the counting one. Writing both rendered "Deadline passed Deadline
      // passed" from the moment the deadline went by.
      el('div', { class: `fpl-deadline ${cd.urgent ? 'is-urgent' : ''} ${cd.passed ? 'is-passed' : ''}`.trim() }, [
        el('span', { class: 'fpl-deadline-when' }, [
          cd.passed ? '' : 'Deadline in ',
          el('strong', { text: cd.text }),
        ]),
        event ? el('span', { class: 'fpl-deadline-date', text: `(${dateTime(event.deadline)})` }) : null,
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

  // Which half of the season a window belongs to, so a chip that appears twice
  // is described as two chips rather than as a contradiction.
  const halfOf = (w) => {
    const same = (rules.chips || []).filter(x => x.name === w.name)
      .sort((a, b) => a.startEvent - b.startEvent);
    if (same.length < 2) return 'this season';
    return same[0] === w || same[0].startEvent === w.startEvent ? 'first half' : 'second half';
  };

  return {
    usableNow,
    ownedCount: owned.length,
    later: later.map(w => ({ label: chipLabel(w.name), fromGw: w.startEvent, half: halfOf(w) })),
  };
}

function chipNote(bundle, chip, gameState) {
  if (chip.playing) return 'This gameweek is the best window for it';
  // When the data cannot carry a chip decision the card must say that, rather
  // than reporting an inventory as though a decision had been considered and
  // declined. "Hold your chips" with a cheerful list of what is available reads
  // as advice; on 2026-08-21 no chip had been evaluated at all.
  const readiness = bundle.dataStatus && bundle.dataStatus.readiness;
  if (readiness && !readiness.allow.chips) {
    return readiness.allow.transfers
      ? 'Chip advice is paused while this data settles'
      : 'Paused: ' + (readiness.headline || 'the data behind this plan is incomplete');
  }
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
export function draftCard({ bundle, gameState, onEdit = null, onRebuild = null, restored = false }) {
  const plan = bundle.current;
  const byPosition = new Map();
  for (const id of plan.squad) {
    const info = describePlayer(gameState, id);
    if (!byPosition.has(info.positionShort)) byPosition.set(info.positionShort, []);
    byPosition.get(info.positionShort).push(info);
  }

  // NEVER read bankBeforeTenths/moneyOutTenths as the budget here: those are
  // encoding-dependent (a restored manual squad has both at zero, which is how
  // this card once read "It costs £0.0m of the £0.0m budget"). The one
  // derivation in openingSquadMoney is right for every pre-season squad.
  const money = openingSquadMoney({ plan, rules: gameState.rules });

  return card('Your opening squad', [
    affirm({
      mark: '✓',
      title: (plan.explanation && plan.explanation.headline) || 'Build this opening 15',
      body: `It costs ${formatMoney(money.spendTenths)} of the ${formatMoney(money.budgetTenths)} budget and projects ${xp(plan.xPointsGw)} points in Gameweek ${plan.gw}.`,
    }),
    el('div', { class: 'fpl-kv', style: 'margin-top:16px' }, [
      ...[...byPosition.entries()].map(([short, list]) => kv(short, list.map(p => p.name).join(', '))),
    ]),
    el('div', { class: 'fpl-money-row' }, [
      el('span', {}, ['Budget ', el('b', { text: formatMoney(money.budgetTenths) })]),
      el('span', {}, ['Squad cost ', el('b', { text: formatMoney(money.spendTenths) })]),
      el('span', {}, ['Left in the bank ', el('b', { text: formatMoney(money.remainingTenths) })]),
    ]),
    // Before the first deadline this squad is a draft, so it has to be
    // changeable. `restored` says plainly where it came from, because a squad
    // that reappears without explanation reads as the app having invented one.
    restored
      ? el('p', { class: 'fpl-note', style: 'margin-top:12px', text: 'This is the squad you saved on an earlier visit.' })
      : null,
    onEdit || onRebuild
      ? el('div', { class: 'fpl-draft-actions' }, [
        onEdit ? btn('Edit this squad', onEdit, { size: 'fpl-btn-sm' }) : null,
        onRebuild ? btn('Start over', onRebuild, { variant: 'fpl-btn-quiet', size: 'fpl-btn-sm' }) : null,
      ])
      : null,
  ]);
}

/* -------------------------------------------------------------------- chip */

export function chipCard({ bundle, gameState }) {
  const plan = bundle.current;
  const decision = chipDecision(plan);
  const reason = decision.reason;
  const reasons = (reason && reason.reasons) || [];
  const perChip = (reason && reason.perChip) || null;

  // NOTHING HERE MAY CLAIM A VERDICT THE ENGINE DID NOT REACH.
  //
  // Before the first deadline there is no squad to play a chip with, so the
  // planner does not evaluate chips at all (planner.js takes the draft branch).
  // The card used to answer anyway: "Keep your chips for now. No chip clears its
  // bar this gameweek", which is a measurement that was never made, next to a
  // list of chips it said were usable.
  const evaluated = !!perChip && Object.keys(perChip).length > 0;

  const body = evaluated
    ? affirm({
      mark: decision.playing ? '★' : '✓',
      tone: decision.playing ? 'is-chip' : '',
      title: decision.playing ? `Play your ${decision.label} this gameweek` : 'Keep your chips for now',
      body: reasons.length ? reasons.map(r => r.text).join(' ') : 'No chip clears its bar this gameweek.',
    })
    : affirm({
      mark: 'i',
      title: 'Chips are judged once you have a squad',
      body: 'A chip is worth playing or not because of the fifteen it is played on, so this is decided against your real squad after the first deadline rather than against a draft.',
    });

  const inv = chipInventory(bundle, gameState);
  const inventory = el('div', { class: 'fpl-kv', style: 'margin-top:14px' }, [
    kv('Usable this gameweek', inv.usableNow.length ? inv.usableNow.join(', ') : 'None'),
    kv('Owned for the rest of the season', String(inv.ownedCount)),
    // Each chip exists TWICE, once per half-season, so "Free Hit" appearing as
    // both usable now and not open until GW20 is two different chips with one
    // name. Saying which half removes the contradiction.
    inv.later.length
      ? kv('Not open yet', inv.later.map(c => `${c.label} (${c.half}) from GW${c.fromGw}`).join(', '))
      : null,
  ]);

  const detail = evaluated
    ? el('div', { class: 'fpl-kv', style: 'margin-top:14px' }, Object.values(perChip).map(entry => kv(
      chipLabel(entry.chip),
      chipRowStatus(entry, plan),
    )))
    : null;

  return card('Chips', [body, inventory, detail]);
}

// What one chip's row says. It has to agree with the headline: a card that says
// "Play your Wildcard this gameweek" above a row reading "Wildcard: Hold" is
// telling the manager two different things about the same chip, and the row was
// deciding purely on whether a better future gameweek had been identified.
function chipRowStatus(entry, plan) {
  if (entry.available === false) return 'Used or out of window';
  if (plan.chip === entry.chip) return 'Playing it this gameweek';
  if (entry.recommended) return 'Clears its bar this gameweek';
  if (entry.bestGw && entry.bestGw !== plan.gw) return `Best around GW${entry.bestGw}`;
  return 'Hold';
}

/* ------------------------------------------------------------------- pitch */

export function pitchCard({
  bundle, gameState, initialMode = 'recommended', onModeChange = null,
  initialDisplay = 'pitch', onDisplayChange = null, onPlayerClick = null,
  // The sandbox is a third view of the same squad. It arrives as a rendered
  // node rather than as data, because the card's job is to switch between
  // views, not to know how an editable one is built.
  sandbox = null,
  // Live scoring for the gameweek being PLAYED, from engine/live.js. Shown only
  // on the Current team view: the recommended eleven is advice about a future
  // gameweek, so an actual score has no meaning there.
  liveSquad = null,
}) {
  const plan = bundle.current;
  const liveRows = liveSquad && Array.isArray(liveSquad.rows)
    ? new Map(liveSquad.rows.map(r => [r.id, r]))
    : null;
  const body = el('div', {});
  let mode = initialMode;
  let display = initialDisplay === 'list' ? 'list' : 'pitch';

  const draw = () => {
    // The sandbox draws its own pitch, so the pitch/table switch does not apply
    // to it and is hidden rather than left there doing nothing.
    if (displaySeg) displaySeg.hidden = mode === 'scenario' && !!sandbox;
    if (mode === 'scenario' && sandbox) {
      body.replaceChildren(sandbox());
      return;
    }
    const vm = pitchViewModel({ mode, plan, squadState: bundle.squadState, gameState });
    body.replaceChildren(display === 'list'
      ? renderSquadTable({
        vm,
        gameState,
        projections: bundle.projections,
        gw: plan.gw,
        horizon: plan.horizon,
        onPlayerClick,
      })
      : renderPitch({
        mode,
        plan,
        squadState: bundle.squadState,
        gameState,
        projections: bundle.projections,
        gw: plan.gw,
        liveRows: mode === 'current' ? liveRows : null,
        onPlayerClick,
      }));
  };

  // Three squads exist here and the app must never blur them: the team the
  // manager actually owns, the one he is experimenting with, and the one the
  // planner recommends. They get three labelled tabs for exactly that reason.
  const MODE_LABELS = { current: 'Current team', scenario: 'My scenario', recommended: 'Recommended' };
  // Pre-season there is no imported squad, so there is no "current team" to
  // show; the editable view is seeded from the opening 15 instead. Dropping the
  // whole switch in that state (which is what happens when it is gated on
  // holding picks) would leave the built 15 uneditable, which is exactly the
  // week when editing it matters most.
  // A lineup view needs a lineup: manual picks are a roster in position
  // order, and rendering their slots as "Current team" fielded two
  // goalkeepers. Pre-season the plan's arrangement is the only real one.
  const holdsPicks = picksCarryLineup(bundle.squadState);
  const modes = [
    ...(holdsPicks ? ['current'] : []),
    ...(sandbox ? ['scenario'] : []),
    'recommended',
  ];
  // A remembered view that this squad state cannot offer (asking for "current
  // team" before one has been imported) falls back rather than rendering blank.
  if (!modes.includes(mode)) mode = 'recommended';
  const seg = el('div', { class: 'fpl-seg' }, modes.map(value => el('button', {
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
  }, MODE_LABELS[value])));

  // Pitch or table: the same squad either way, so this is display, not data.
  const displaySeg = el('div', { class: 'fpl-seg fpl-seg-icons' }, [
    ['pitch', 'fa-chess-board', 'Show as pitch'],
    ['list', 'fa-table-list', 'Show as table'],
  ].map(([value, icon, label]) => el('button', {
    type: 'button',
    class: value === display ? 'is-on' : '',
    dataset: { display: value },
    title: label,
    'aria-label': label,
    'aria-pressed': value === display ? 'true' : 'false',
    onclick: (event) => {
      display = value;
      for (const b of displaySeg.children) {
        b.classList.toggle('is-on', b.dataset.display === display);
        b.setAttribute('aria-pressed', b.dataset.display === display ? 'true' : 'false');
      }
      draw();
      if (onDisplayChange) onDisplayChange(display);
      event.currentTarget.blur();
    },
  }, el('i', { class: `fa-solid ${icon}`, 'aria-hidden': 'true' }))));

  draw();
  // One view left means nothing to switch between, so the control does not
  // appear at all rather than appearing with a single option.
  const aside = el('div', { class: 'fpl-card-tools' }, [modes.length > 1 ? seg : null, displaySeg]);
  return card('Your team', body, { aside });
}

/* --------------------------------------------------------------------- why */

// Engine sentences with their numeric facts emphasized for scanning. The
// wording is untouched; only the numbers gain weight.
function reasonList(reasons) {
  return el('ul', { class: 'fpl-reasons' }, reasons.map(r => el('li', {}, [
    el('span', { class: 'fpl-reason-text' }, emphasize(r.text)),
  ])));
}

// A section header inside a panel: an accent tick, the uppercase label, and
// an optional aside (the confidence pill). One shape for every subsection so
// "THE PLAN", "CAPTAIN: ..." and "HOLDING YOUR CHIPS" all read as headers.
function subhead(text, aside = null) {
  return el('div', { class: 'fpl-subhead' }, [
    el('span', { class: 'fpl-subhead-t', text }),
    aside,
  ]);
}

// One subsection: header plus its content, spaced as a unit so the panel
// reads as groups rather than as one continuous column of lines.
function whyGroup(header, content) {
  return el('section', { class: 'fpl-why-group' }, [header, content]);
}

export function whyCard({ bundle, gameState, open = false, onToggle = null, sources = null, now = Date.now() }) {
  const plan = bundle.current;
  const ex = plan.explanation || {};
  const body = [];

  body.push(whyGroup(subhead('The plan'), reasonList(ex.bullets || [])));

  // The full working behind the band in the hero. Everything that scored
  // against the plan AND everything that scored for it, so a user can see that
  // a high band was earned rather than assumed. The band itself renders as a
  // pill on the header; each row carries its verdict as a leading dot plus a
  // trailing tag in the header's own words.
  const band = bandFor(plan, { bundle, gameState, sources, now });
  body.push(whyGroup(
    subhead('How sure is this?', el('span', { class: `fpl-conf-pill is-${band.band}`, text: band.label })),
    el('ul', { class: 'fpl-reasons is-verdicts' }, band.factors.filter(f => f.text).map(f => {
      // "For" and "Against" once stood here and read as truncated words; the
      // heading asks "How sure is this?", so each row answers in those words.
      const dir = f.weight > 0 ? 'against' : 'for';
      return el('li', { class: `fpl-conf-row is-${dir}` }, [
        el('span', { class: 'fpl-conf-dot', 'aria-hidden': 'true' }),
        el('span', { class: 'fpl-reason-text' }, emphasize(`${f.text.charAt(0).toUpperCase()}${f.text.slice(1)}.`)),
        el('span', {
          class: `fpl-conf-mark is-${dir}`,
          text: f.weight > 0 ? 'Less sure' : 'More sure',
        }),
      ]);
    })),
  ));

  for (const t of ex.transferReasons || []) {
    body.push(whyGroup(subhead(`${t.outName} out, ${t.inName} in`), reasonList(t.reasons || [])));
  }

  if (ex.captainReason) {
    body.push(whyGroup(
      subhead(`Captain: ${describePlayer(gameState, ex.captainReason.playerId).name}`),
      reasonList(ex.captainReason.reasons || []),
    ));
  }

  if (ex.chipReason && (ex.chipReason.reasons || []).length) {
    body.push(whyGroup(
      subhead(ex.chipReason.decision === 'play' ? 'Playing a chip' : 'Holding your chips'),
      reasonList(ex.chipReason.reasons),
    ));
  }

  if (ex.rollReason) {
    body.push(whyGroup(subhead('Keeping the transfer'), reasonList(ex.rollReason.reasons || [])));
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
      el('dd', {}, emphasize(r.text)),
    ])));
  }

  // The working: supporting evidence under the comparison, visually
  // subordinate to it rather than one more block of the same weight.
  const items = [...(result.blockers || []), ...(result.reasons || [])];
  if (items.length) {
    nodes.push(el('div', { class: 'fpl-whynot-evidence' },
      el('ul', { class: 'fpl-blockers' }, items.map(r => el('li', {}, emphasize(r.text))))));
  }

  if (result.result) {
    nodes.push(el('div', { class: 'fpl-whynot-result' }, [
      el('span', { class: 'fpl-whynot-result-mark', 'aria-hidden': 'true' }, el('i', { class: 'fa-solid fa-arrow-right-long' })),
      el('span', {}, emphasize(result.result.text)),
    ]));
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

  // The whole horizon at a glance: this gameweek's projection beside the
  // future ones it is being traded off against. Same numbers as the columns
  // below, drawn once so the shape of the horizon is visible.
  const chart = columnChart({
    points: [
      { label: `GW ${bundle.current.gw}`, value: bundle.current.xPointsGw, active: true, note: 'This gameweek' },
      ...future.map(plan => ({
        label: `GW ${plan.gw}`,
        value: plan.xPointsGw,
        note: actionText(plan, nameOf(gameState)).headline,
      })),
    ],
    formatValue: (v) => `${xp(v)} xP`,
    ariaLabel: 'Projected points per gameweek over the planning horizon',
    labelCaps: 'all',
  });

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
    el('div', { class: 'fpl-chart-block is-first' }, chart),
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

// How the payload's season totals were read, in one line.
export function evidenceLabel(evidence) {
  if (!evidence) return 'unknown';
  if (evidence.kind === 'previous-season') {
    return `last season's, measured over ${evidence.teamMatches} gameweeks`;
  }
  if (evidence.kind === 'current-season') {
    return `this season's, over ${evidence.finishedMatches} played`;
  }
  return 'not published yet, so no plan is shown';
}

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
      // Which season the player totals describe, and how the start rates were
      // measured against them. This is a diagnostic on purpose: the rollover is
      // the one input the app cannot observe in advance, and a human checking
      // the app around the first deadline needs to be able to read what it
      // decided rather than infer it from the projections.
      ds.evidence ? kv('Player totals', evidenceLabel(ds.evidence)) : null,
      kv('Horizon', `${ds.horizon} gameweeks`),
      kv('Uncertainty discount', `${ds.discount} per gameweek`),
      kv('Risk profile', ds.risk || 'balanced'),
      kv('Home advantage', `x${STRENGTH_PARAMS.homeAdvantagePrior}`),
      kv('Optimizer time', `${Math.round(ds.durationMs || 0)} ms`),
      kv('Computed', ds.planComputedAt ? relativeTime(ds.planComputedAt, now) : 'unknown'),
      kv('Data fetched', ds.fetchedAt ? age(ds.fetchedAt) : 'unknown'),
      kv('Ran in', runnerMode === 'worker' ? 'a background worker' : 'the page (no worker)'),
      // A pass/fail is a status, so it renders as one.
      el('div', {}, [
        el('div', { class: 'fpl-kv-k', text: 'Legality check' }),
        el('div', { class: 'fpl-kv-v' }, el('span', {
          class: `fpl-status-pill ${bundle.validation && bundle.validation.ok ? 'is-good' : 'is-bad'}`,
          text: bundle.validation && bundle.validation.ok ? 'Passed' : 'Failed',
        })),
      ]),
      // The version above names whatever actually produced the plan. This row
      // says whether the trained artifact was behind it, and when it was not,
      // why not: a plan built on the analytic priors looks exactly as confident
      // as one built on a calibrator measured against held-out seasons. Three
      // answers are possible, and today's is the middle one: the artifact loads,
      // and is deliberately not used because replaying past seasons with it lost
      // points. Do not shorten this to "loaded" or "not loaded". It is one long
      // sentence in a grid of short facts, so it spans the full row as
      // secondary prose instead of stretching one column.
      kv('Trained model', describeModelStatus(modelStatus), { wide: true, muted: true }),
    ]),
    el('div', { class: 'fpl-subhead', text: 'Sources' }),
    el('div', { class: 'fpl-src-list' }, sourceRows),
    (bundle.squadState.warnings || []).length
      ? el('div', {}, [
        el('div', { class: 'fpl-subhead', text: 'Data quality' }),
        el('ul', { class: 'fpl-missing' }, bundle.squadState.warnings.map(w => el('li', { text: w.message }))),
      ])
      : null,
    el('p', { class: 'fpl-note fpl-footnote' }, 'Every plan is checked for squad size, position counts, the three-per-club limit, affordability at selling prices, formation legality, bench composition, captain and vice, chip windows and hit arithmetic before it is shown. A plan that fails is never rendered.'),
  ], { open });
  if (onToggle) node.addEventListener('toggle', () => onToggle(node.open));
  return node;
}

/* ----------------------------------------------------------------- notices */

// Sources the proxy is serving from its last copy (`x-fpl-stale: true`) while
// FPL is down. Under six hours the plan still shows, and this is the only
// thing that says it is built on a copy. Null when nothing is stale.
export function staleSourcesBanner(assessment) {
  if (!assessment || !assessment.stale || !assessment.stale.length) return null;
  return banner({
    tone: 'warn',
    mark: '!',
    title: 'Fantasy Premier League is not answering',
    text: 'These sources are served from the last copy we have rather than live. Prices, team news and your squad may have moved since.',
    list: assessment.stale.map(name => `${name}: only an older copy is available`),
  });
}

// Squad warnings, titled by what they are. A price mismatch and a missing
// history are different problems, and a banner headed "One number does not
// match" over "your season history could not be read" explained neither.
const SQUAD_WARNING_TITLES = {
  history_missing: 'Your season history could not be read',
  empty_picks: 'Your squad could not be read',
  missing_entry_history: 'Your bank and squad value could not be read',
};
export function squadWarningsBanner(warnings) {
  const special = warnings.find(w => SQUAD_WARNING_TITLES[w.code]);
  if (special) {
    return banner({
      tone: 'warn',
      mark: '!',
      title: SQUAD_WARNING_TITLES[special.code],
      text: special.message,
      list: warnings.filter(w => w !== special).map(w => w.message),
    });
  }
  return banner({
    tone: 'warn',
    mark: '!',
    title: 'One number does not match Fantasy Premier League',
    text: 'The squad and prices are read from two Fantasy Premier League endpoints that are not always in step, most often because a price changed overnight. Transfers and affordability are calculated from your reconstructed selling prices.',
    list: warnings.map(w => w.message),
  });
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
