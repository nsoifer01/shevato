// Surface consistency over a MATRIX of real plans, asserted as invariants.
//
// WHY THIS FILE EXISTS. The largest class of defects that escaped to managers
// was "a number or claim on screen is not the number the planner computed, or
// two surfaces disagree": a Triple Captain that "looks better" later on a tie,
// a Bench Boost alternative printed +0.52 while it ranked 0.43 below under
// "none of them scored higher", a hero confidence line contradicting the
// alternatives card, Wildcard alternatives claiming a chip value that was not
// counted, a chip in its last week reading "Hold", and "1 chips", "2 player",
// "over 1 gameweeks", "1 transfers". Every one of them had a test, each on ONE
// hand-built object per surface, so the combination that broke was never the
// one tested. Here every surface is rendered from REAL plans (the five GW7
// managers in tests/fixtures/gw7-2026) across risk profiles, horizons and chip
// holdings, and the assertions are relations between surfaces rather than
// snapshots, so they hold for any data and catch the next wording or engine
// change that lets two surfaces part.
//
// Each invariant collects every violation across the matrix and fails once
// with the full list, so a red run names every plan it broke on. The plans are
// built and rendered in worker threads (tests/helpers/surface-matrix.mjs says
// why); everything asserted here is plain data posted back from them.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { availableParallelism } from 'node:os';

import { ENTRIES, PLAN_GW } from './helpers/gw7-fixture.mjs';
import { squadOf } from './helpers/surface-matrix.mjs';

const ALL_CHIPS = ['wildcard', 'freehit', 'bboost', '3xc'];
const LABELS = Object.keys(ENTRIES);
const RISKS = ['balanced', 'aggressive', 'conservative'];
const HORIZONS = [3, 5];
// The last gameweek of every first-half chip window in the 2026/27 rules
// (bootstrap chips: stopEvent 19). The fixture supports planning the owner's
// real GW7 squad AT gameweek 19 (its fixtures and projections run to gameweek
// 38), which is how gw7-audit-followup-ui.test.mjs reaches the expiry branch.
const LAST_WEEK = 19;
const CHIP_LABEL = { wildcard: 'Wildcard', freehit: 'Free Hit', bboost: 'Bench Boost', '3xc': 'Triple Captain' };

/* ------------------------------------------------------------- the matrix */

const CASES = [];
// 5 managers x 3 risk profiles x 2 horizons, each with his real chips.
for (const label of LABELS) for (const risk of RISKS) for (const horizon of HORIZONS) {
  CASES.push({ label, risk, horizon, keep: null, gw: PLAN_GW });
}
// Each manager given each chip on its own, and all four: the chip branches no
// real GW7 manager reaches (only two of the five hold a chip they could play
// besides the Triple Captain). A holding identical to his real one is skipped.
for (const label of LABELS) for (const keep of [...ALL_CHIPS.map(c => [c]), ALL_CHIPS]) {
  const real = squadOf({ label, keep: null, gw: PLAN_GW }).chipsAvailable || [];
  if ([...real].sort().join() === [...keep].sort().join()) continue;
  CASES.push({ label, risk: 'balanced', horizon: 5, keep, gw: PLAN_GW });
}
// The owner in the last week of his chip windows: his real chips, each chip on
// its own, and all four (three of which then expire unplayed).
for (const keep of [null, ...ALL_CHIPS.map(c => [c]), ALL_CHIPS]) {
  CASES.push({ label: 'owner', risk: 'balanced', horizon: 5, keep, gw: LAST_WEEK });
}

const tagOf = (c) => `${c.label} ${c.risk} h${c.horizon} gw${c.gw} chips=${c.keep ? c.keep.join('+') : 'real'}`;

// Wildcard plans cost several times the rest, so they are dispatched first and
// the cheap ones fill in behind them.
async function renderAll(cases) {
  const order = cases.map((c, id) => ({ id, c }))
    .sort((a, b) => Number((b.c.keep || []).includes('wildcard')) - Number((a.c.keep || []).includes('wildcard')));
  const results = new Array(cases.length);
  const size = Math.max(1, Math.min(8, availableParallelism() - 1, cases.length));
  const workers = Array.from({ length: size }, () => new Worker(new URL('./helpers/surface-matrix.mjs', import.meta.url)));
  try {
    await Promise.all(workers.map(w => new Promise((resolve, reject) => {
      const next = () => {
        const job = order.shift();
        if (!job) return resolve();
        w.once('message', (msg) => {
          if (msg.error) return reject(new Error(`${tagOf(cases[msg.id])}: ${msg.error}`));
          results[msg.id] = msg.result;
          next();
        });
        w.postMessage(job);
      };
      w.once('error', reject);
      next();
    })));
  } finally {
    await Promise.all(workers.map(w => w.terminate()));
  }
  return results.map(r => ({ ...r, tag: tagOf(r.case) }));
}

const RENDERED = await renderAll(CASES);

// Fail once with every violation, so a red run names all the plans it broke on.
function check(name, fn) {
  const problems = [];
  for (const r of RENDERED) fn(r, (msg) => problems.push(`${r.tag}: ${msg}`));
  assert.deepEqual(problems, [], `${name}: ${problems.length} violation(s)\n  ${problems.join('\n  ')}`);
}

// A figure as printed (one decimal, "0.0" for anything that rounds to zero).
const printed1 = (v) => Number(Math.abs(v) < 0.05 ? 0 : v.toFixed(1));

test('the matrix is what it says it is', () => {
  // WHY: a silently shrunken matrix (a manager dropped from the fixture, a
  // horizon clamped, the gameweek-19 plans quietly planned at 7) would turn
  // every invariant below into a weaker one without a failure.
  assert.equal(LABELS.length, 5);
  assert.equal(RENDERED.length, CASES.length);
  assert.ok(RENDERED.length >= 55, `${RENDERED.length} plans`);
  for (const r of RENDERED) assert.equal(r.plan.gw, r.case.gw, r.tag);
  // Something in the matrix reaches each branch the invariants guard.
  const reach = (pred) => RENDERED.some(pred);
  assert.ok(reach(r => r.plan.alternatives.some(a => a.deltaWithChipValue !== null)), 'a chip-valued alternative');
  assert.ok(reach(r => r.plan.alternatives.some(a => a.shown >= 0.05)), 'an alternative shown ahead');
  assert.ok(reach(r => /none of them scored higher/.test(r.lines.alternatives.join('\n'))), 'the "none scored higher" note');
  assert.ok(reach(r => Object.values(r.chips.rows).some(v => /^Best around GW\d+$/.test(v))), 'a "Best around" chip row');
  assert.ok(reach(r => Object.values(r.chips.rows).includes('Hold')), 'a "Hold" chip row');
  assert.ok(reach(r => r.perChip.some(e => e.later === null && e.bestValue !== null && e.available)), 'a chip whose best week is no better than now');
  assert.ok(reach(r => Object.values(r.chips.rows).some(v => /expires after GW19/.test(v))), 'an expiring chip row');
  assert.ok(reach(r => r.lines.why.some(l => /next best plan (projects|ranks)/.test(l))), 'a runner-up shown ahead on the confidence line');
  assert.ok(reach(r => r.plan.transferCount > 0), 'a plan with transfers');
});

/* ------------------------------------------------ 1. the alternatives' figures */

test('1a. every alternative prints the gap the planner ranked it on, and "none scored higher" only when none is shown ahead', () => {
  check('alternative figures', (r, fail) => {
    const rows = r.altRows;
    const alts = r.plan.alternatives;
    if (rows.length !== alts.length) return fail(`card shows ${rows.length} rows for ${alts.length} alternatives`);
    alts.forEach((alt, i) => {
      // WHY shownDelta and not deltaHorizon: a plan playing a different chip is
      // ranked counting what the chip is worth later; printing its raw horizon
      // gap showed +0.52 for a plan that ranked 0.43 below.
      const want = printed1(alt.shown);
      if (rows[i].figure !== want) fail(`"${alt.headline}" prints ${rows[i].figure}, shownDelta is ${want}`);
      const chipValued = alt.deltaWithChipValue !== null;
      if (chipValued !== /counting what the chip is worth later|as the planner ranks the two plans/.test(rows[i].sentence)) {
        fail(`"${alt.headline}" chip-valued=${chipValued} but its row reads "${rows[i].sentence}"`);
      }
      // A chip value is only ever counted for a Bench Boost or Triple Captain
      // (planner.js TIMING_CHIPS); claiming it for a Wildcard against a
      // Wildcard was false.
      if (/counting what the chip is worth later/.test(rows[i].sentence)
        && !['bboost', '3xc'].includes(alt.chip) && !['bboost', '3xc'].includes(r.plan.chip)) {
        fail(`"${alt.headline}" claims a chip value neither side carries (${r.plan.chip} vs ${alt.chip})`);
      }
      // A row shown AHEAD lost on something; it must say what, or the reader
      // sees a higher number that was not chosen with no reason.
      if (rows[i].figure >= 0.05 && !chipValued
        && !/short of the .*bar a hit must clear|but spends|risk setting/.test(rows[i].sentence)) {
        fail(`"${alt.headline}" is shown ahead (+${rows[i].figure}) with no reason: "${rows[i].sentence}"`);
      }
    });
    const anyAhead = rows.some(x => x.figure >= 0.05);
    const none = /none of them scored higher/.test(r.lines.alternatives.join('\n'));
    if (none && anyAhead) fail(`"none of them scored higher" above a row shown at +${Math.max(...rows.map(x => x.figure))}`);
    if (rows.length && !none && !anyAhead) fail('no row is shown ahead, yet the note does not say none scored higher');
  });
});

test('1b. the confidence line never claims a runner-up the card shows behind, and names the cause that applies', () => {
  check('confidence vs alternatives', (r, fail) => {
    const rows = r.altRows;
    const top = rows.length ? Math.max(...rows.map(x => x.figure)) : null;
    const topAlts = r.plan.alternatives.filter((a, i) => rows[i] && rows[i].figure === top);
    // The hero shows up to two factor clauses; the why card lists every factor.
    // Both are read, so a claim on either surface is checked.
    const text = [...r.lines.hero, ...r.lines.why].join('\n');
    const lead = text.match(/the next best plan (projects ([\d.]+) more points|ranks ([\d.]+) points ahead) over the horizon([^\n.]*)/i);
    const behind = text.match(/(?:this plan beats the next best by|the next best plan is only) ([\d.]+) points/i);
    const tied = /a second plan projects the same points/i.test(text);
    if (lead) {
      const v = Number(lead[2] || lead[3]);
      if (!(top >= 0.05)) return fail(`says "${lead[0]}" while the card's best row is ${top}`);
      if (v !== top) fail(`says ${v} ahead, the card prints +${top}`);
      // "ranks ahead" is the chip-valued wording; "projects more" the plain one.
      const chipValued = topAlts.some(a => a.deltaWithChipValue !== null);
      if (Boolean(lead[3]) !== chipValued) fail(`wording "${lead[1]}" but the top row chip-valued=${chipValued}`);
      // The stated cause is the flag on that row, in leadCause's order, or none.
      const cause = lead[4] || '';
      const flagOf = (a) => (a.belowHitMargin ? 'hit' : a.belowRollValue ? 'roll' : a.belowRiskPreference ? 'risk' : null);
      const want = new Set(topAlts.map(flagOf));
      const said = /takes a hit/.test(cause) ? 'hit' : /spends/.test(cause) ? 'roll' : /risk setting/.test(cause) ? 'risk' : null;
      if (!want.has(said)) fail(`cause "${cause.trim() || '(none)'}" but the top row's flag is ${[...want].join('/')}`);
      if (/transfer it spends/.test(cause)) fail(`the retired guessed cause: "${cause}"`);
      for (const word of ['aggressive', 'conservative']) {
        if (cause.includes(word) && r.risk !== word) fail(`cause names a ${word} risk setting on a ${r.risk} plan`);
      }
    } else if (top !== null && top >= 0.05) {
      fail(`the card shows a row at +${top}, the confidence line says ${behind ? `"${behind[0]}"` : tied ? '"same points"' : 'nothing about it'}`);
    }
    if (behind && top !== null && Number(behind[1]) !== printed1(-top)) fail(`"${behind[0]}" but the card's best row is ${top}`);
    if (tied && top !== null && Math.abs(top) >= 0.05) fail(`"same points" but the card's best row is ${top}`);
  });
});

/* ----------------------------------------------- 2. distinct alternatives */

test('2. no two alternatives share a title, and none is the plan itself', () => {
  check('distinct alternatives', (r, fail) => {
    const key = (p) => `${p.chip || '-'}|${[...p.transfersOut].sort().join()}|${[...p.transfersIn].sort().join()}`;
    const seen = new Set();
    for (const alt of r.plan.alternatives) {
      if (seen.has(alt.headline)) fail(`two alternatives titled "${alt.headline}"`);
      seen.add(alt.headline);
      if (key(alt) === key(r.plan)) fail(`alternative "${alt.headline}" is the plan itself`);
    }
    const titles = r.altRows.map(x => x.title);
    if (new Set(titles).size !== titles.length) fail(`the card repeats a title: ${titles.join(' | ')}`);
  });
});

/* -------------------------------------------- 3. chips agree on every surface */

test('3. the chip row, the chips card sentence and the hero agree on play vs hold, the better week and expiry', () => {
  check('chip surfaces', (r, fail) => {
    const { plan, chips: s } = r;
    const gw = plan.gw;

    // Play vs hold, on all three surfaces.
    const playing = plan.chip ? CHIP_LABEL[plan.chip] : null;
    if (playing) {
      if (s.heroValue !== `Play ${playing}`) fail(`plays ${playing}, hero chip fact says "${s.heroValue}"`);
      if (s.title !== `Play your ${playing} this gameweek`) fail(`plays ${playing}, chips card says "${s.title}"`);
    } else {
      if (/^Play /.test(s.heroValue)) fail(`plays no chip, hero says "${s.heroValue}"`);
      if (/^Play your/.test(s.title)) fail(`plays no chip, chips card says "${s.title}"`);
    }

    // A chip in hand, not played, whose window closes this gameweek.
    const expiring = r.chipsAvailable.filter(c => c !== plan.chip && r.windows[c] && r.windows[c].to === gw);
    if (expiring.length) {
      if (s.heroValue === 'Hold your chips') fail(`hero says "Hold your chips" while ${expiring.join('+')} expire(s) this week`);
      if (s.title === 'Keep your chips for now') fail(`chips card says "Keep your chips for now" while ${expiring.join('+')} expire(s)`);
      if (!new RegExp(`expires? after GW${gw}`).test(s.heroNote)) fail(`hero chip note does not say what expires: "${s.heroNote}"`);
    }

    for (const entry of r.perChip) {
      const row = s.rows[entry.label];
      if (row === undefined) { fail(`no ${entry.label} row on the chips card`); continue; }
      if (entry.available === false) continue;
      const isPlayed = plan.chip === entry.chip;
      if (isPlayed !== (row === 'Playing it this gameweek')) fail(`${entry.label}: played=${isPlayed}, row "${row}"`);
      if (isPlayed) continue;

      if (expiring.includes(entry.chip)) {
        // Holding a chip in its window's last week is losing it.
        if (row === 'Hold' || /^Best around/.test(row) || !/last week|expires after GW/.test(row)) {
          fail(`${entry.label} expires after GW${gw} unplayed but its row says "${row}"`);
        }
        continue;
      }

      // The better week: the row, the sentence and betterLaterGw name the same
      // week, it is genuinely better (a tie is not "better"), and it is inside
      // the chip's window.
      const rowGw = (row.match(/^Best around GW(\d+)$/) || [])[1];
      const sentence = s.body.match(new RegExp(`${entry.label} looks better around gameweek (\\d+)`));
      if (!entry.recommended) {
        if ((rowGw ? Number(rowGw) : null) !== entry.later) fail(`${entry.label}: row "${row}", betterLaterGw ${entry.later}`);
        if (entry.later === null && row !== 'Hold') fail(`${entry.label}: no better week, row "${row}"`);
      }
      if (sentence && Number(sentence[1]) !== entry.later) fail(`${entry.label}: sentence names GW${sentence[1]}, betterLaterGw ${entry.later}`);
      if (!playing && entry.later !== null && !sentence) fail(`${entry.label}: held for GW${entry.later}, the chips card never says so`);
      const named = rowGw ? Number(rowGw) : sentence ? Number(sentence[1]) : null;
      if (named !== null) {
        if (entry.bestValue !== null && !(entry.bestValue > entry.valueNow)) {
          fail(`${entry.label}: GW${named} named better on ${entry.bestValue.toFixed(2)} vs ${entry.valueNow.toFixed(2)} now`);
        }
        const w = r.windows[entry.chip];
        if (w && named > w.to) fail(`${entry.label}: GW${named} is after its window closes (GW${w.to})`);
      }
    }
  });
});

/* -------------------------------------------------------- 4. the copy lint */

// Count nouns, singular -> plural.
const NOUNS = { player: 'players', chip: 'chips', gameweek: 'gameweeks', transfer: 'transfers', point: 'points', week: 'weeks', hit: 'hits', match: 'matches' };
const PLURALS = Object.fromEntries(Object.entries(NOUNS).map(([one, many]) => [many, one]));
// Legitimate "<n> <singular>" phrases: a compound adjective ("a 4 point hit").
const ALLOW = [/\b\d+ point hit\b/g];

const LINT = [
  [/NaN/, 'NaN'], [/\bundefined\b/, 'undefined'], [/\bnull\b/, 'null'], [/\[object/, '[object'],
  [/Infinity/, 'Infinity'], [/-0\.0(?!\d)/, '-0.0'], [/\+0\.0 pts/, '+0.0 pts'],
  [/ {2}/, 'doubled space'], [/ [.,](?!\d)/, 'space before punctuation'],
];

function lintLine(line) {
  const found = [];
  for (const [re, what] of LINT) if (re.test(line)) found.push(what);
  let scrubbed = line;
  for (const re of ALLOW) scrubbed = scrubbed.replace(re, '');
  for (const m of scrubbed.matchAll(/(?<![\d.,])(\d+(?:\.\d+)?) ([a-z]+)\b/gi)) {
    const word = m[2].toLowerCase();
    const one = m[1] === '1';
    if (one && PLURALS[word]) found.push(`"${m[0]}" (1 takes the singular)`);
    if (!one && NOUNS[word]) found.push(`"${m[0]}" (${m[1]} takes the plural)`);
  }
  return found;
}

test('4a. the lint itself: catches what escaped, passes what is right', () => {
  // WHY: a lint that matches nothing is indistinguishable from clean copy.
  for (const bad of ['You have 1 chips playable', 'Your bench has 2 player unlikely', '+0.5 pts over 1 gameweeks',
    'over 3 gameweek', '1 transfers', 'NaN xP', 'is undefined', '-0.0 pts', '+0.0 pts', 'a  b', 'word .', 'x , y',
    '1 hits', '2 match', '[object Object]', 'Infinity xP', 'only 0.5 point behind']) {
    assert.ok(lintLine(bad).length, `lint misses "${bad}"`);
  }
  for (const good of ['You have 1 chip playable', 'Your bench has 2 players unlikely', 'over 1 gameweek', '5.0 points',
    'costs a 4 point hit', '0.1 points', '£100.0m', '-2.5 pts over 5 gameweeks', 'GW 7', 'over 2.5 points', '1.0 points']) {
    assert.deepEqual(lintLine(good), [], `lint flags "${good}"`);
  }
});

test('4b. copy lint over every rendered line of every view in the matrix', () => {
  check('copy lint', (r, fail) => {
    for (const [view, lines] of Object.entries(r.lines)) {
      for (const line of lines) for (const what of lintLine(line)) fail(`${view}: ${what} in "${line}"`);
    }
  });
});

/* --------------------------------------------------------------- 5. money */

const MONEY = /^(-?)£(\d+)\.(\d)m$/;
const tenths = (s) => {
  const m = String(s).match(MONEY);
  return m ? (m[1] ? -1 : 1) * (Number(m[2]) * 10 + Number(m[3])) : NaN;
};

test('5. every £ figure parses, and bank after = bank before + money in - money out', () => {
  check('money', (r, fail) => {
    for (const [view, lines] of Object.entries(r.lines)) {
      for (const line of lines) {
        // A sentence may end on a figure ("sells for £5.6m."), so trailing
        // punctuation is the sentence's, not the figure's.
        for (const m of line.matchAll(/-?£\S*?(?=[.,;:)]*(?:\s|$))/g)) {
          if (!MONEY.test(m[0])) fail(`${view}: unparseable money "${m[0]}" in "${line}"`);
        }
      }
    }
    const before = tenths(r.money['Bank before']);
    const moneyIn = tenths(r.money['Money in']);
    const out = tenths(r.money['Money out']);
    const after = tenths(r.money['Bank after']);
    if (![before, moneyIn, out, after].every(Number.isFinite)) return fail(`money row: ${JSON.stringify(r.money)}`);
    if (after !== before + moneyIn - out) fail(`bank ${before} + in ${moneyIn} - out ${out} != after ${after} (tenths)`);
    if (after < 0) fail(`bank after is negative: ${after}`);
    const p = r.plan;
    if (before !== p.bankBeforeTenths || moneyIn !== p.moneyInTenths || out !== p.moneyOutTenths || after !== p.bankAfterTenths) {
      fail(`money row ${[before, moneyIn, out, after]} is not the plan's ${[p.bankBeforeTenths, p.moneyInTenths, p.moneyOutTenths, p.bankAfterTenths]}`);
    }
  });
});
