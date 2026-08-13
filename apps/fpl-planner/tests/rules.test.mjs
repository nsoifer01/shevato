import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRules, chipAvailableAt, sellingPrice, formatMoney, parseSeasonLabel } from '../js/engine/rules.js';

const here = dirname(fileURLToPath(import.meta.url));
const bootstrap = JSON.parse(readFileSync(join(here, 'fixtures', 'bootstrap.json'), 'utf8'));
const rules = buildRules(bootstrap);

// ---------------------------------------------------------------- squad -----

test('squad, budget and transfer rules all come from the payload', () => {
  // Every one of these has changed at least once in FPL's history (the free
  // transfer cap moved from 2 to 5 in 2025/26). Reading them means a rule
  // change is a data change.
  assert.equal(rules.squadSize, 15);
  assert.equal(rules.starters, 11);
  assert.equal(rules.budgetTenths, 1000);
  assert.equal(rules.clubLimit, 3);
  assert.equal(rules.sellFeeRate, 0.5);
  assert.equal(rules.maxFreeTransfers, 5);          // 1 + max_extra_free_transfers
  assert.equal(rules.hitCost, 4);
  assert.equal(rules.totalEvents, 38);
});

test('a payload with different settings produces different rules', () => {
  // Proves the values are read, not typed: the same code on a payload with a
  // 2-free-transfer cap and a 1050 budget must follow it.
  const altered = structuredClone(bootstrap);
  altered.game_settings.max_extra_free_transfers = 1;
  altered.game_settings.squad_total_spend = 1050;
  altered.game_settings.transfers_sell_on_fee = 0;
  const alt = buildRules(altered);
  assert.equal(alt.maxFreeTransfers, 2);
  assert.equal(alt.budgetTenths, 1050);
  assert.equal(alt.sellFeeRate, 0);
});

test('positions come from element_types, never from literals', () => {
  assert.deepEqual(rules.positions[1], { id: 1, short: 'GKP', name: 'Goalkeeper', squadSelect: 2, minPlay: 1, maxPlay: 1 });
  assert.deepEqual(rules.positions[2], { id: 2, short: 'DEF', name: 'Defender', squadSelect: 5, minPlay: 3, maxPlay: 5 });
  assert.deepEqual(rules.positions[3], { id: 3, short: 'MID', name: 'Midfielder', squadSelect: 5, minPlay: 2, maxPlay: 5 });
  assert.deepEqual(rules.positions[4], { id: 4, short: 'FWD', name: 'Forward', squadSelect: 3, minPlay: 1, maxPlay: 3 });
  const squadTotal = Object.values(rules.positions).reduce((s, p) => s + p.squadSelect, 0);
  assert.equal(squadTotal, rules.squadSize);
});

// ---------------------------------------------------------------- scoring ---

test('the scoring table is read from game_config.scoring', () => {
  assert.equal(rules.scoring.goals_scored.GKP, 10);
  assert.equal(rules.scoring.goals_scored.DEF, 6);
  assert.equal(rules.scoring.goals_scored.MID, 5);
  assert.equal(rules.scoring.goals_scored.FWD, 4);
  assert.equal(rules.scoring.assists, 3);
  assert.equal(rules.scoring.saves, 1);
  assert.equal(rules.scoring.long_play, 2);
  assert.equal(rules.scoring.short_play, 1);
  assert.equal(rules.scoring.penalties_saved, 5);
  assert.equal(rules.scoring.red_cards, -3);
});

test('per-position scoring is keyed by position id as well as short name', () => {
  // Every id crossing a module boundary in this app is a numeric element_type,
  // while FPL keys these maps by short name. Both work, so no caller has to
  // translate and get it wrong.
  for (const key of ['goals_scored', 'clean_sheets', 'goals_conceded', 'defensive_contribution']) {
    for (const p of Object.values(rules.positions)) {
      assert.equal(rules.scoring[key][p.id], rules.scoring[key][p.short], `${key}/${p.short}`);
    }
  }
  assert.equal(rules.scoring.clean_sheets[1], 4);
  assert.equal(rules.scoring.clean_sheets[3], 1);
  assert.equal(rules.scoring.clean_sheets[4], 0);
});

test('defensive contribution pays everyone but keepers, and the thresholds are the one manual rule', () => {
  assert.equal(rules.scoring.defensive_contribution.GKP, 0);
  assert.equal(rules.scoring.defensive_contribution.DEF, 2);
  assert.equal(rules.scoring.defensive_contribution.MID, 2);
  assert.equal(rules.scoring.defensive_contribution.FWD, 2);
  // The ACTION COUNT that earns those points is published only in the game
  // rules, never in the API. See the comment block at the top of rules.js.
  assert.deepEqual(rules.defConThresholds, { 2: 10, 3: 12, 4: 12 });
  assert.equal(rules.defConThresholds[1], undefined, 'keepers have no threshold because they cannot score it');
});

test('mutating one Rules object cannot corrupt the next one', () => {
  const a = buildRules(bootstrap);
  a.defConThresholds[2] = 99;
  assert.equal(buildRules(bootstrap).defConThresholds[2], 10);
});

// ---------------------------------------------------------------- season ----

test('the season label is parsed out of the static content URL', () => {
  assert.equal(rules.season, '2026/27');
  assert.equal(parseSeasonLabel('https://x/plfpl-production/2027_28/'), '2027/28');
  assert.equal(parseSeasonLabel('https://x/plfpl-production/2019_20'), '2019/20');
  assert.equal(parseSeasonLabel(''), null);
  assert.equal(parseSeasonLabel(undefined), null);
});

test('no engine or data module hardcodes a season', () => {
  // SPEC 2.6: nothing about a specific season may live outside rules.js, and
  // rules.js itself derives it. A year literal in code (not a comment) means
  // the app needs editing next August.
  const roots = [join(here, '..', 'js', 'engine'), join(here, '..', 'js', 'data')];
  const offenders = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!name.endsWith('.js')) continue;
      const code = readFileSync(p, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
        .replace(/\/\/.*$/gm, '');
      const hit = code.match(/\b20[2-9]\d\b/);
      if (hit) offenders.push(`${name}: ${hit[0]}`);
    }
  };
  for (const r of roots) walk(r);
  assert.deepEqual(offenders, []);
});

// ---------------------------------------------------------------- chips -----

test('the chip catalogue keeps both half-season windows per chip', () => {
  assert.equal(rules.chips.length, 8);
  const wildcards = rules.chips.filter(c => c.name === 'wildcard');
  assert.equal(wildcards.length, 2);
  assert.deepEqual(wildcards.map(c => [c.startEvent, c.stopEvent]), [[2, 19], [20, 38]]);
  assert.deepEqual(
    rules.chips.filter(c => c.name === 'freehit').map(c => [c.startEvent, c.stopEvent]),
    [[2, 19], [20, 38]],
  );
  // Bench boost and triple captain are playable in GW1; wildcard and free hit
  // are not, because before GW1 transfers are unlimited anyway.
  assert.equal(rules.chips.find(c => c.name === 'bboost').startEvent, 1);
  assert.equal(rules.chips.find(c => c.name === '3xc').startEvent, 1);
  assert.deepEqual([...new Set(rules.chips.map(c => c.type))].sort(), ['team', 'transfer']);
});

test('chipAvailableAt honours the event window', () => {
  assert.equal(chipAvailableAt(rules, 'wildcard', 1, []), false, 'no wildcard in GW1');
  assert.equal(chipAvailableAt(rules, 'wildcard', 2, []), true);
  assert.equal(chipAvailableAt(rules, 'freehit', 1, []), false);
  assert.equal(chipAvailableAt(rules, 'bboost', 1, []), true);
  assert.equal(chipAvailableAt(rules, '3xc', 38, []), true);
  assert.equal(chipAvailableAt(rules, 'manager', 5, []), false, 'a chip not in the catalogue is never available');
});

test('a chip spent in one half is still available in the other', () => {
  const used = [{ name: 'wildcard', event: 8 }];
  assert.equal(chipAvailableAt(rules, 'wildcard', 12, used), false, 'first-half wildcard is gone');
  assert.equal(chipAvailableAt(rules, 'wildcard', 25, used), true, 'the second-half one is not');
  assert.equal(chipAvailableAt(rules, 'wildcard', 25, [...used, { name: 'wildcard', event: 22 }]), false);
  // A chip used in the second half must not retroactively block the first.
  assert.equal(chipAvailableAt(rules, 'bboost', 5, [{ name: 'bboost', event: 30 }]), true);
});

test('a chip recorded without an event is treated as spent everywhere', () => {
  // Defensive on the one ambiguous input shape: a bare name carries no window,
  // and over-reporting availability would suggest an illegal plan.
  assert.equal(chipAvailableAt(rules, '3xc', 5, ['3xc']), false);
  assert.equal(chipAvailableAt(rules, '3xc', 30, ['3xc']), false);
});

// ---------------------------------------------------------------- money -----

test('sellingPrice halves the profit and rounds down, in whole tenths', () => {
  // The rule that decides whether a recommended transfer is affordable at all.
  assert.equal(sellingPrice(50, 53, rules), 51);   // +0.3 profit -> +0.1 kept
  assert.equal(sellingPrice(50, 54, rules), 52);   // +0.4 profit -> +0.2 kept
  assert.equal(sellingPrice(50, 51, rules), 50);   // +0.1 profit -> nothing kept
  assert.equal(sellingPrice(50, 52, rules), 51);
  assert.equal(sellingPrice(50, 70, rules), 60);   // a 2.0m rise sells for 1.0m of it
  assert.equal(sellingPrice(50, 50, rules), 50);
  assert.equal(sellingPrice(50, 49, rules), 49);   // falls are passed on in full
  assert.equal(sellingPrice(120, 111, rules), 111);
});

test('sellingPrice never returns a fractional tenth', () => {
  for (let purchase = 38; purchase <= 150; purchase += 3) {
    for (let now = 38; now <= 160; now += 1) {
      const sell = sellingPrice(purchase, now, rules);
      assert.equal(Number.isInteger(sell), true, `${purchase}->${now} gave ${sell}`);
      assert.ok(sell <= now, 'you can never sell above the current price');
      assert.ok(sell >= Math.min(purchase, now), 'you can never sell below what you paid unless the price fell');
    }
  }
});

test('formatMoney renders tenths as FPL money', () => {
  assert.equal(formatMoney(155), '£15.5m');
  assert.equal(formatMoney(40), '£4.0m');
  assert.equal(formatMoney(1000), '£100.0m');
  assert.equal(formatMoney(0), '£0.0m');
  assert.equal(formatMoney(-5), '-£0.5m');
});
