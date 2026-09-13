// The desktop sync banner must sit BELOW Gym's dialogs.
//
// The failure and conflict banner became visible on desktop in the 2026-09-13
// round (audit S-1). Its base layer is 10000 (just under the site header), and
// Gym's dialogs (.modal) are 2000. Gym's centred dialogs start right under the
// header on desktop, so the banner covered the onboarding dialog's close
// button: elementsFromPoint at that button returned #sync-banner. Verified in a
// browser at 1280 before the fix; on a phone the dialogs start below the
// banner, so the mobile layer is unchanged.
//
// This pins the order statically so a later z-index edit cannot silently put
// the banner back over the dialogs, or under the side nav.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CSS = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'css', 'gym-tracker.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

/** Top-level blocks: [{ prelude, body }], brace-matched. */
function blocks(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1) break;
    let depth = 1;
    let j = open + 1;
    while (j < src.length && depth) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}') depth--;
      j++;
    }
    out.push({ prelude: src.slice(i, open).trim(), body: src.slice(open + 1, j - 1) });
    i = j;
  }
  return out;
}

function zIndexOf(ruleSet, selector) {
  const rule = ruleSet.filter((b) => b.prelude.split(',').map((s) => s.trim()).includes(selector)).pop();
  if (!rule) return null;
  const m = /z-index:\s*(-?\d+)/.exec(rule.body);
  return m ? Number(m[1]) : null;
}

const top = blocks(CSS);
const desktop = top.filter((b) => /^@media\s*\(min-width:\s*768px\)$/.test(b.prelude)).flatMap((b) => blocks(b.body));

test('dialogs have a z-index to compare against', () => {
  assert.equal(typeof zIndexOf(top, '.modal'), 'number', '.modal lost its z-index; this test compares the banner against it');
});

test('on desktop the sync banner sits below dialogs', () => {
  const modal = zIndexOf(top, '.modal');
  const banner = zIndexOf(desktop, '.sync-banner') ?? zIndexOf(top, '.sync-banner');
  assert.ok(banner < modal, `desktop .sync-banner z-index ${banner} is not below .modal ${modal}: the banner covers dialog close buttons again`);
});

test('on desktop the sync banner still sits above the side nav', () => {
  const banner = zIndexOf(desktop, '.sync-banner') ?? zIndexOf(top, '.sync-banner');
  const sideNav = zIndexOf(desktop, '.side-nav');
  assert.equal(typeof sideNav, 'number', '.side-nav lost its desktop z-index');
  assert.ok(banner > sideNav, `desktop .sync-banner z-index ${banner} is not above .side-nav ${sideNav}`);
});
